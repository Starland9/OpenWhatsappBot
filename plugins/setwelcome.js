const { getLang } = require("../lib/utils/language");
const config = require("../config");
const { Group } = require("../lib/database");
const settingsCache = require("../lib/utils/settingsCache");
const { safeLog } = require("../lib/utils/http");
const {
  normalizeJid,
  jidUser,
  isPnJid,
  getBotJids,
} = require("../lib/utils/permissions");

/**
 * Welcome plugin
 *   .welcome              → current settings and a preview
 *   .welcome on|off       → enable / disable the welcome message
 *   .welcome reset        → back to the default message
 *   .welcome <text>       → set the message (placeholders @user @group @desc)
 *
 * `onGroupParticipants` posts the message when members join (one message per
 * event, mentioning everyone who joined). goodbye.js reuses the helpers below.
 */

const MAX_TEMPLATE_LENGTH = 1000;
// Default value of Group.welcomeMsg in the model: treated as "not customised"
const LEGACY_DEFAULT_TEMPLATE = "Welcome @user to @group";

const groupKey = (jid) => `group:${jid}`;

/**
 * Group row (welcome / goodbye settings) as a plain object, cached.
 * `{}` when the group has no row yet.
 * @param {string} jid
 * @returns {Promise<object>}
 */
async function getGroupSettings(jid) {
  const settings = await settingsCache.getOrLoad(groupKey(jid), async () => {
    const row = await Group.findByPk(jid, { raw: true });
    return row || {};
  });
  return settings || {};
}

/** Drop the cached Group row; call after every write of a Group setting */
function invalidateGroupSettings(jid) {
  settingsCache.invalidate(groupKey(jid));
}

/**
 * Participants of a `group-participants.update` event: entries may be strings
 * or `{ id, phoneNumber, lid }` objects. Returns `{ jid, forms }` with the
 * phone-number JID when known, without duplicates and without the bot itself.
 * @param {Array<string|object>} participants
 * @param {object} sock - Baileys socket (to recognise the bot)
 */
function resolveParticipants(participants, sock) {
  const bot = getBotJids(sock);
  const botForms = new Set([bot.pn, bot.lid].filter(Boolean));
  const seen = new Set();
  const out = [];

  for (const entry of participants || []) {
    const raw =
      typeof entry === "string" ? [entry] : [entry?.phoneNumber, entry?.id, entry?.lid];
    const forms = raw.map(normalizeJid).filter(Boolean);
    if (!forms.length) continue;
    if (forms.some((form) => botForms.has(form))) continue;

    const jid = forms.find(isPnJid) || forms[0];
    if (seen.has(jid)) continue;
    seen.add(jid);
    out.push({ jid, forms });
  }
  return out;
}

/**
 * Replace @user / @group / @desc in a single pass: a value that itself contains
 * a placeholder (e.g. a group named "@user") is never substituted again.
 * Placeholders missing from `vars` are left untouched.
 * @param {string} template
 * @param {{ user?: string, group?: string, desc?: string }} vars
 */
function renderTemplate(template, vars) {
  return String(template).replace(/@(user|group|desc)\b/gi, (match, name) => {
    const key = name.toLowerCase();
    return key in vars ? String(vars[key]) : match;
  });
}

/** "@111, @222" for a list of JIDs */
const mentionText = (jids) => jids.map((jid) => `@${jidUser(jid)}`).join(", ");

/** True when the bot is disabled in this chat (BannedChat). Never throws. */
async function isChatDisabled(jid) {
  try {
    const { getBannedChats } = require("../lib/core/pipeline");
    return (await getBannedChats()).has(jid);
  } catch (_) {
    return false;
  }
}

/** Group subject and description, or empty strings when they can't be fetched */
async function fetchGroupInfo(sock, jid, fallbackName = "") {
  try {
    const metadata = await sock.groupMetadata(jid);
    return { subject: metadata?.subject || fallbackName, desc: metadata?.desc || "" };
  } catch (_) {
    return { subject: fallbackName, desc: "" };
  }
}

const isDefaultTemplate = (text) =>
  !text || !String(text).trim() || text === LEGACY_DEFAULT_TEMPLATE;

/** Message to post: the group's own text, otherwise the localized default */
const welcomeTemplate = (settings) =>
  isDefaultTemplate(settings.welcomeMsg)
    ? getLang("plugins.setwelcome.default_message")
    : settings.welcomeMsg;

/**
 * Hook: members joined → post the welcome message.
 * @param {{ id: string, author?: string, participants: Array<string|object>, action: string }} update
 * @param {object} client
 */
async function onGroupParticipants(update, client) {
  try {
    if (!update || update.action !== "add" || !String(update.id).endsWith("@g.us")) return;

    const settings = await getGroupSettings(update.id);
    if (!settings.welcome) return;
    if (await isChatDisabled(update.id)) return;

    const sock = client.getSocket();
    const people = resolveParticipants(update.participants, sock);
    if (!people.length) return;

    const jids = people.map((p) => p.jid);
    const info = await fetchGroupInfo(sock, update.id, settings.name || "");
    const text = renderTemplate(welcomeTemplate(settings), {
      user: mentionText(jids),
      group: info.subject,
      desc: info.desc,
    });
    await sock.sendMessage(update.id, { text, mentions: jids });
  } catch (error) {
    console.error("welcome: could not post the message", safeLog(error));
  }
}

/** Row of this group (created on first use) */
async function findOrCreateGroup(message) {
  const metadata = await message.getGroupMetadata();
  const [group] = await Group.findOrCreate({
    where: { jid: message.jid },
    defaults: { name: metadata?.subject || "" },
  });
  return group;
}

/** The message as it would look for the sender in this group */
async function previewOf(message, group) {
  const metadata = await message.getGroupMetadata();
  return renderTemplate(welcomeTemplate(group), {
    user: `@${jidUser(message.sender)}`,
    group: metadata?.subject || group.name || "",
    desc: metadata?.desc || "",
  });
}

async function showSettings(message, group) {
  const status = group.welcome
    ? getLang("common.status_enabled")
    : getLang("common.status_disabled");
  const text = [
    getLang("plugins.setwelcome.status", status),
    getLang("plugins.setwelcome.current", welcomeTemplate(group)),
    getLang("plugins.setwelcome.preview", await previewOf(message, group)),
    getLang("plugins.setwelcome.help", config.PREFIX),
  ].join("\n\n");
  return await message.reply(text, { mentions: [message.sender] });
}

module.exports = {
  command: {
    pattern: "welcome",
    desc: getLang("plugins.setwelcome.desc"),
    type: "admin",
    adminOnly: true,
  },

  async execute(message, argsString, ctx) {
    const raw = String(ctx?.rawArgs ?? argsString ?? "").trim();
    const action = raw.toLowerCase();
    const group = await findOrCreateGroup(message);

    if (!raw || action === "get") {
      return await showSettings(message, group);
    }

    if (action === "on" || action === "off") {
      group.welcome = action === "on";
      await group.save();
      invalidateGroupSettings(message.jid);
      return await message.reply(
        group.welcome
          ? getLang("plugins.setwelcome.enabled")
          : getLang("plugins.setwelcome.disabled"),
      );
    }

    if (action === "reset") {
      group.welcomeMsg = null;
      await group.save();
      invalidateGroupSettings(message.jid);
      return await message.reply(getLang("plugins.setwelcome.reset"));
    }

    if (raw.length > MAX_TEMPLATE_LENGTH) {
      return await message.reply(getLang("plugins.setwelcome.too_long", MAX_TEMPLATE_LENGTH));
    }
    group.welcomeMsg = raw;
    group.welcome = true;
    await group.save();
    invalidateGroupSettings(message.jid);
    return await message.reply(
      getLang("plugins.setwelcome.updated", await previewOf(message, group)),
      { mentions: [message.sender] },
    );
  },

  onGroupParticipants,

  // Helpers shared with plugins/goodbye.js
  getGroupSettings,
  invalidateGroupSettings,
  resolveParticipants,
  renderTemplate,
  mentionText,
  isChatDisabled,
  fetchGroupInfo,
  findOrCreateGroup,
  isDefaultTemplate,
  welcomeTemplate,
  MAX_TEMPLATE_LENGTH,
};
