const crypto = require("crypto");
const { Op } = require("sequelize");
const { getLang } = require("../lib/utils/language");
const config = require("../config");
const { GroupRole } = require("../lib/database");
const settingsCache = require("../lib/utils/settingsCache");
const cooldown = require("../lib/utils/cooldown");
const { safeLog } = require("../lib/utils/http");
const { sendList } = require("./buttons");
const {
  normalizeJid,
  jidUser,
  isOwnerJid,
  getBotJids,
  toPnJid,
  guardTarget,
  assertParticipantResult,
} = require("../lib/utils/permissions");

/**
 * Member roles per group.
 *   .role list                          → members that have a role
 *   .role check [@user]                 → role of a member (default: you)
 *   .role set @user <member|vip|muted|banned>   → admins and owners only
 *   .role @user                         → pick the role from a list (admins and owners)
 *
 * Enforcement (only while the bot is a group admin):
 *  - muted  → their messages are deleted;
 *  - banned → removed on their next message, and when they join again;
 *  - vip    → can't be warned (plugins/warnuser.js calls `isVip`).
 * Roles are cached per group (`roles:<groupJid>`), invalidated on every change.
 */

// Stored value ("regular" is the DB name of a member without a special role)
const ROLE_ALIASES = {
  member: "regular",
  regular: "regular",
  vip: "vip",
  muted: "muted",
  banned: "banned",
};
const ROLE_ORDER = ["regular", "vip", "muted", "banned"];
const ROLE_NAME_KEYS = {
  regular: "plugins.role.name_regular",
  vip: "plugins.role.name_vip",
  muted: "plugins.role.name_muted",
  banned: "plugins.role.name_banned",
};
const ROLE_HINT_KEYS = {
  regular: "plugins.role.hint_regular",
  vip: "plugins.role.hint_vip",
  muted: "plugins.role.hint_muted",
  banned: "plugins.role.hint_banned",
};

const MAX_LISTED_MEMBERS = 50;
const KICK_RETRY_MS = 60 * 1000;
const PICKER_TTL_MS = 10 * 60 * 1000;
const MAX_PICKERS = 200;

const rolesKey = (groupJid) => `roles:${groupJid}`;
const roleName = (role) => getLang(ROLE_NAME_KEYS[role] || ROLE_NAME_KEYS.regular);
const tag = (jid) => `@${jidUser(jid)}`;

// ---------------------------------------------------------------------------
// Roles cache
// ---------------------------------------------------------------------------

/** Roles of a group as a Map: normalized JID -> "vip" | "muted" | "banned" (members are not stored) */
async function getRoles(groupJid) {
  const roles = await settingsCache.getOrLoad(rolesKey(groupJid), async () => {
    const rows = await GroupRole.findAll({
      where: { groupJid },
      attributes: ["userJid", "role"],
      raw: true,
    });
    const map = new Map();
    for (const row of rows) {
      const jid = normalizeJid(row.userJid);
      if (jid && row.role !== "regular") map.set(jid, row.role);
    }
    return map;
  });
  return roles instanceof Map ? roles : new Map();
}

function invalidateRoles(groupJid) {
  settingsCache.invalidate(rolesKey(groupJid));
}

/**
 * Role of a member: "vip" | "muted" | "banned" | "regular".
 * @param {string} groupJid
 * @param {string|string[]} userJid - one identity or several (phone number, LID)
 */
async function getRole(groupJid, userJid) {
  const roles = await getRoles(groupJid);
  for (const jid of Array.isArray(userJid) ? userJid : [userJid]) {
    const role = roles.get(normalizeJid(jid));
    if (role) return role;
  }
  return "regular";
}

/**
 * Is this member a VIP of the group? (VIPs can't be warned.)
 * @param {string} groupJid
 * @param {string} userJid
 * @returns {Promise<boolean>}
 */
async function isVip(groupJid, userJid) {
  return (await getRole(groupJid, userJid)) === "vip";
}

/** Role of the author of a message */
function getMessageRole(message) {
  return getRole(message.jid, [message.sender, message.senderLid]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** First mention, otherwise the quoted sender (normalized), or "" */
function resolveTarget(message) {
  return (
    normalizeJid((message.mentions || [])[0]) ||
    normalizeJid(message.quoted?.sender) ||
    ""
  );
}

/** Group admins and owners may change roles */
async function canManage(message) {
  return message.isSudo() || (await message.isSenderAdmin());
}

/** Role named in the arguments, or "" */
function parseRole(tokens) {
  for (const token of tokens) {
    const role = ROLE_ALIASES[token.toLowerCase()];
    if (role) return role;
  }
  return "";
}

/** Group-side id of a member (what groupParticipantsUpdate expects), or null */
function findParticipantId(metadata, jids) {
  const wanted = new Set(jids.map(normalizeJid).filter(Boolean));
  if (!wanted.size) return null;
  const found = (metadata?.participants || []).find((p) =>
    [p.id, p.phoneNumber, p.lid].some((x) => x && wanted.has(normalizeJid(x))),
  );
  return found ? found.id : null;
}

const isAdminParticipant = (p) =>
  !!p && (p.admin === "admin" || p.admin === "superadmin" || p.isAdmin === true || p.isSuperAdmin === true);

/** Is the bot an admin according to this group metadata? */
function botIsAdmin(sock, metadata) {
  const bot = getBotJids(sock);
  const ids = [bot.pn, bot.lid].filter(Boolean);
  const me = (metadata?.participants || []).find((p) =>
    [p.id, p.phoneNumber, p.lid].some((x) => x && ids.includes(normalizeJid(x))),
  );
  return isAdminParticipant(me);
}

/** Every form under which the member may be stored */
async function storedForms(message, targetJid) {
  const pn = await toPnJid(message, targetJid);
  return { pn, forms: [...new Set([pn, normalizeJid(targetJid)].filter(Boolean))] };
}

// ---------------------------------------------------------------------------
// Pending role pickers (button ids carry a nonce, never a JID)
// ---------------------------------------------------------------------------

const pickers = new Map(); // nonce -> { groupJid, target, expiresAt }

function createPicker(groupJid, target) {
  const now = Date.now();
  for (const [nonce, entry] of pickers) {
    if (entry.expiresAt <= now) pickers.delete(nonce);
  }
  while (pickers.size >= MAX_PICKERS) pickers.delete(pickers.keys().next().value);
  const nonce = crypto.randomBytes(4).toString("hex");
  pickers.set(nonce, { groupJid, target, expiresAt: now + PICKER_TTL_MS });
  return nonce;
}

function getPicker(nonce) {
  const entry = pickers.get(nonce);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    pickers.delete(nonce);
    return null;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Store the role, then enforce it right away when that is possible. */
async function applyRole(message, targetJid, role) {
  if (role === "muted" || role === "banned") {
    const refusal = await guardTarget(message, targetJid);
    if (refusal) return await message.reply(getLang(refusal));
  }

  const { pn, forms } = await storedForms(message, targetJid);
  if (!pn) return await replyUsage(message);

  if (role === "regular") {
    await GroupRole.destroy({ where: { groupJid: message.jid, userJid: { [Op.in]: forms } } });
  } else {
    const [row] = await GroupRole.findOrCreate({
      where: { groupJid: message.jid, userJid: pn },
      defaults: { role, setBy: message.sender, setAt: new Date() },
    });
    await row.update({ role, setBy: message.sender, setAt: new Date() });
    const others = forms.filter((jid) => jid !== pn);
    if (others.length) {
      await GroupRole.destroy({ where: { groupJid: message.jid, userJid: { [Op.in]: others } } });
    }
  }
  invalidateRoles(message.jid);
  await message.react("✅");

  const lines = [getLang("plugins.role.set", tag(pn), roleName(role))];
  if (role === "muted" || role === "banned") {
    if (!(await message.isBotAdmin())) {
      lines.push(getLang("plugins.role.not_enforced"));
    } else if (role === "banned") {
      const participantId = findParticipantId(await message.getGroupMetadata(), forms);
      if (participantId) {
        const res = await message.kick([participantId]);
        if (assertParticipantResult(res)) lines.push(getLang("plugins.role.banned_removed", tag(pn)));
      }
    }
  }
  return await message.reply(lines.join("\n"), { mentions: [pn] });
}

async function setRole(message, tokens) {
  if (!(await canManage(message))) {
    return await message.reply(getLang("common.sender_not_admin"));
  }
  const target = resolveTarget(message);
  const role = parseRole(tokens.slice(1));
  if (!target || !role) return await replyUsage(message);
  return await applyRole(message, target, role);
}

async function checkRole(message) {
  const target = resolveTarget(message) || normalizeJid(message.sender);
  const { pn, forms } = await storedForms(message, target);
  const role = await getRole(message.jid, forms);
  const who = pn || target;
  const text =
    role === "regular"
      ? getLang("plugins.role.none", tag(who))
      : getLang("plugins.role.current", tag(who), roleName(role));
  return await message.reply(text, { mentions: [who] });
}

async function listRoles(message) {
  const roles = await getRoles(message.jid);
  if (!roles.size) return await message.reply(getLang("plugins.role.empty"));

  const mentions = [];
  const lines = [];
  for (const role of ["vip", "muted", "banned"]) {
    const members = [...roles].filter(([, r]) => r === role).map(([jid]) => jid);
    if (!members.length) continue;
    const shown = members.slice(0, Math.max(0, MAX_LISTED_MEMBERS - mentions.length));
    mentions.push(...shown);
    const more = members.length - shown.length;
    lines.push(
      getLang(
        "plugins.role.list_line",
        roleName(role),
        members.length,
        shown.map(tag).join(" ") + (more > 0 ? ` +${more}` : ""),
      ),
    );
  }
  return await message.reply(`${getLang("plugins.role.list_title")}\n\n${lines.join("\n")}`, {
    mentions,
  });
}

/** `.role @user`: let an admin pick the role from a list */
async function pickRole(message) {
  const target = resolveTarget(message);
  if (!target) return await replyUsage(message);
  if (!(await canManage(message))) {
    return await message.reply(getLang("common.sender_not_admin"));
  }

  const nonce = createPicker(message.jid, target);
  const sections = [
    {
      title: getLang("plugins.role.pick_title"),
      rows: ROLE_ORDER.map((role) => ({
        id: `role:set:${nonce}:${role}`,
        title: roleName(role),
        description: getLang(ROLE_HINT_KEYS[role]),
      })),
    },
  ];
  try {
    return await sendList(
      message.client.getSocket(),
      message.jid,
      getLang("plugins.role.pick", tag(target)),
      sections,
      {
        title: getLang("plugins.role.pick_header"),
        buttonLabel: getLang("plugins.role.pick_button"),
        quoted: message.data,
      },
    );
  } catch (error) {
    console.error("role: could not send the picker", safeLog(error));
    return await replyUsage(message);
  }
}

const replyUsage = (message) =>
  message.reply(`${getLang("common.usage_prefix")}\n${getLang("plugins.role.usage", config.PREFIX)}`);

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Hook: a picker button / list row (`role:set:<nonce>:<role>`).
 * Returns true only for ids of this plugin; never throws.
 */
async function handleButtonReply(message) {
  const body = message?.body;
  if (typeof body !== "string" || !body.startsWith("role:set:")) return false;

  try {
    if (!message.isGroup) return true;
    const parts = body.split(":");
    const nonce = parts[2] || "";
    const role = ROLE_ALIASES[parts.slice(3).join(":")] || "";

    const picker = getPicker(nonce);
    if (!picker || picker.groupJid !== message.jid || !role) {
      await message.reply(getLang("plugins.role.expired"));
      return true;
    }
    if (!(await canManage(message))) {
      await message.reply(getLang("common.sender_not_admin"));
      return true;
    }
    pickers.delete(nonce);
    await applyRole(message, picker.target, role);
  } catch (error) {
    console.error("role: picker failed", safeLog(error));
    try {
      await message.reply(getLang("common.error"));
    } catch (_) {
      // nothing more to do
    }
  }
  return true;
}

/** Send a plain notice to the group (not quoted: the original message may be gone) */
async function notifyGroup(sock, groupJid, text, mentions) {
  try {
    await sock.sendMessage(groupJid, { text, mentions });
  } catch (error) {
    console.error("role: could not post the notice", safeLog(error));
  }
}

/**
 * Hook: enforce `muted` (delete the message) and `banned` (delete + remove the
 * member) while the bot is a group admin. Owners are never restricted.
 * Cache only; returns true when the message was handled.
 */
async function onMessage(message) {
  if (!message.isGroup || message.fromMe) return false;

  const roles = await getRoles(message.jid);
  if (!roles.size) return false;

  const role = await getRole(message.jid, [message.sender, message.senderLid]);
  if (role !== "muted" && role !== "banned") return false;
  if (message.isSudo()) return false;
  if (!(await message.isBotAdmin())) return false;

  try {
    await message.delete();
  } catch (error) {
    console.error("role: could not delete the message", safeLog(error));
  }

  if (role === "banned") {
    const participantId = findParticipantId(await message.getGroupMetadata(), [
      message.sender,
      message.senderLid,
    ]);
    // Retry a failed removal at most once a minute
    if (participantId && !cooldown.hit(message.jid, `rolekick:${jidUser(participantId)}`, KICK_RETRY_MS)) {
      try {
        const res = await message.kick([participantId]);
        if (assertParticipantResult(res)) {
          await notifyGroup(
            message.client.getSocket(),
            message.jid,
            getLang("plugins.role.banned_removed", tag(message.sender)),
            [message.sender],
          );
        }
      } catch (error) {
        console.error("role: could not remove a banned member", safeLog(error));
      }
    }
  }
  return true;
}

/** Hook: a banned member joined again → remove them (while the bot is a group admin) */
async function onGroupParticipants(update, client) {
  try {
    if (!update || update.action !== "add" || !String(update.id).endsWith("@g.us")) return;

    const roles = await getRoles(update.id);
    if (!roles.size) return;

    const banned = [];
    for (const entry of update.participants || []) {
      const raw = typeof entry === "string" ? [entry] : [entry?.phoneNumber, entry?.id, entry?.lid];
      const forms = raw.map(normalizeJid).filter(Boolean);
      if (forms.some(isOwnerJid)) continue;
      if (forms.some((jid) => roles.get(jid) === "banned")) {
        banned.push({ id: typeof entry === "string" ? entry : entry.id || forms[0], jid: forms[0] });
      }
    }
    if (!banned.length) return;

    try {
      const { getBannedChats } = require("../lib/core/pipeline");
      if ((await getBannedChats()).has(update.id)) return; // bot disabled in this chat
    } catch (_) {
      // gate unavailable: carry on
    }

    const sock = client.getSocket();
    const metadata = await sock.groupMetadata(update.id);
    if (!botIsAdmin(sock, metadata)) return;

    const res = await sock.groupParticipantsUpdate(
      update.id,
      banned.map((b) => b.id),
      "remove",
    );
    if (assertParticipantResult(res)) {
      await notifyGroup(
        sock,
        update.id,
        getLang("plugins.role.banned_removed", banned.map((b) => tag(b.jid)).join(" ")),
        banned.map((b) => b.jid),
      );
    }
  } catch (error) {
    console.error("role: could not remove a banned member", safeLog(error));
  }
}

module.exports = {
  // onMessage order (lower first, default 100): moderation first: deletes messages of muted members
  hookPriority: { onMessage: 10 },
  command: {
    pattern: "role",
    desc: getLang("plugins.role.desc"),
    type: "group",
    onlyGroup: true,
  },

  async execute(message, argsString, ctx) {
    const raw = String(ctx?.rawArgs ?? argsString ?? "").trim();
    const tokens = raw.split(/\s+/).filter(Boolean);
    const sub = (tokens[0] || "").toLowerCase();

    if (!sub || sub === "list") return await listRoles(message);
    if (sub === "check") return await checkRole(message);
    if (sub === "set") return await setRole(message, tokens);
    return await pickRole(message);
  },

  handleButtonReply,
  onMessage,
  onGroupParticipants,

  // Used by lib/utils/warnings.js (VIPs can't be warned), plugins/addfilter.js and the admin panel
  isVip,
  getRole,
  getRoles,
  getMessageRole,
  invalidateRoles,
};
