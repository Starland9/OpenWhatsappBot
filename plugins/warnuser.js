const { Op } = require("sequelize");
const { getLang } = require("../lib/utils/language");
const { Warn } = require("../lib/database");
const config = require("../config");
const { safeLog } = require("../lib/utils/http");
const {
  normalizeJid,
  jidUser,
  toPnJid,
  guardTarget,
  assertParticipantResult,
} = require("../lib/utils/permissions");

/**
 * Warn System Plugin
 * Warning system for group management: `.warn @user [reason]`, `.warn list`,
 * `.warn reset @user`. The user is kicked when WARN_LIMIT is reached.
 */

const MAX_REASON_LENGTH = 500;
const MAX_LISTED = 40;
const LIST_WORDS = new Set(["list", "liste"]);
const RESET_WORDS = new Set(["reset"]);

const tag = (jid) => `@${jidUser(jid)}`;

/** First mention, otherwise the quoted sender (normalized), or "" */
function resolveTarget(message) {
  const mentioned = (message.mentions || []).map(normalizeJid).find(Boolean);
  return mentioned || normalizeJid(message.quoted?.sender) || "";
}

/** Reason = the text after the command, minus the "@number" mention tokens */
function extractReason(message, raw) {
  let text = raw;
  for (const jid of message.mentions || []) {
    const user = jidUser(jid);
    if (user) text = text.replaceAll(`@${user}`, " ");
  }
  // The visible token may be the phone number while the mention is a LID
  if (message.mentions?.length) text = text.replace(/@\d{6,}/g, " ");
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_LENGTH);
}

/**
 * Every form of the target stored warnings may use: the phone-number form
 * (the one we persist) first, then the JID as received.
 */
async function identityForms(message, jid) {
  const pn = await toPnJid(message, jid);
  return [...new Set([pn, jid].filter(Boolean))];
}

/** VIPs (plugins/role.js) can't be warned. Absent or failing role => false. */
async function isVip(message, forms) {
  try {
    const role = require("./role");
    if (typeof role.isVip !== "function") return false;
    for (const jid of forms) {
      if (await role.isVip(message.jid, jid)) return true;
    }
  } catch (err) {
    console.error("warn: VIP check failed", safeLog(err));
  }
  return false;
}

function usage() {
  return `${getLang("common.usage_prefix")}\n${getLang("plugins.warnuser.usage", config.PREFIX)}`;
}

async function listWarnings(message) {
  const rows = await Warn.findAll({
    where: { groupJid: message.jid, count: { [Op.gt]: 0 } },
    order: [
      ["count", "DESC"],
      ["updatedAt", "DESC"],
    ],
  });
  if (!rows.length) {
    return await message.reply(getLang("plugins.warnuser.list_empty"));
  }

  const shown = rows.slice(0, MAX_LISTED);
  const lines = shown.map((row) =>
    getLang(
      "plugins.warnuser.list_item",
      tag(row.jid),
      row.count,
      config.WARN_LIMIT,
      row.reason || "",
    ),
  );
  if (rows.length > shown.length) {
    lines.push(getLang("plugins.warnuser.list_more", rows.length - shown.length));
  }

  return await message.reply(
    `${getLang("plugins.warnuser.list_header")}\n\n${lines.join("\n")}`,
    { mentions: shown.map((row) => row.jid) },
  );
}

async function resetWarnings(message, target) {
  const forms = await identityForms(message, target);
  const deleted = await Warn.destroy({
    where: { jid: { [Op.in]: forms }, groupJid: message.jid },
  });

  const key = deleted > 0 ? "plugins.warnuser.reset_done" : "plugins.warnuser.reset_none";
  return await message.reply(getLang(key, tag(target)), { mentions: [target] });
}

/**
 * Existing row (any known form of the user) or a new one with count 0.
 * Two concurrent first warnings: the unique index rejects the second insert,
 * which then reads the first one's row.
 */
async function findOrCreateRow(forms, groupJid, reason) {
  const where = { jid: { [Op.in]: forms }, groupJid };
  const existing = await Warn.findOne({ where });
  if (existing) return existing;
  try {
    return await Warn.create({ jid: forms[0], groupJid, reason, count: 0 });
  } catch (err) {
    if (err?.name !== "SequelizeUniqueConstraintError") throw err;
    return await Warn.findOne({ where });
  }
}

/** Replace every occurrence of each placeholder (replacers: no `$` surprises) */
function fillPlaceholders(template, values) {
  let out = String(template);
  for (const [placeholder, value] of Object.entries(values)) {
    out = out.replaceAll(placeholder, () => String(value));
  }
  return out;
}

async function warnUser(message, target, reason) {
  const refusal = await guardTarget(message, target);
  if (refusal) return await message.reply(getLang(refusal));

  // The bot kicks at the limit, so it must be admin before any warning is stored
  if (!(await message.isBotAdmin())) {
    return await message.reply(getLang("common.bot_not_admin"));
  }

  const forms = await identityForms(message, target);
  if (await isVip(message, forms)) {
    return await message.reply(
      getLang("plugins.warnuser.vip_exempt", tag(target)),
      { mentions: [target] },
    );
  }

  // One row per (user, group); the counter is incremented in SQL (no race)
  const row = await findOrCreateRow(forms, message.jid, reason);
  await row.increment("count");
  await row.update({ reason });
  await row.reload();

  const count = row.count;
  const limit = config.WARN_LIMIT;

  await message.reply(
    fillPlaceholders(config.WARN_MESSAGE, {
      "&mention": tag(target),
      "&warn": count,
      "&remaining": Math.max(0, limit - count),
    }),
    { mentions: [target] },
  );

  if (count < limit) return;

  // Limit reached: the warnings are cleared only once the kick really worked
  let kicked = false;
  try {
    kicked = assertParticipantResult(await message.kick(target));
  } catch (err) {
    console.error("warn: kick failed", safeLog(err));
  }

  if (!kicked) {
    return await message.reply(
      getLang("plugins.warnuser.kick_failed", tag(target)),
      { mentions: [target] },
    );
  }

  await Warn.destroy({
    where: { jid: { [Op.in]: forms }, groupJid: message.jid },
  });
  await message.reply(
    fillPlaceholders(config.WARN_KICK_MESSAGE, { "&mention": tag(target) }),
    { mentions: [target] },
  );
}

module.exports = {
  command: {
    pattern: "warn",
    desc: getLang("plugins.warnuser.desc"),
    type: "group",
    adminOnly: true,
  },

  async execute(message, argsString, ctx) {
    const raw = String(ctx?.rawArgs ?? argsString ?? "").trim();
    const words = raw.split(/\s+/).filter(Boolean);
    const word = (words[0] || "").toLowerCase();

    if (words.length === 1 && LIST_WORDS.has(word)) {
      return await listWarnings(message);
    }

    const target = resolveTarget(message);
    if (!target) return await message.reply(usage());

    if (RESET_WORDS.has(word)) {
      return await resetWarnings(message, target);
    }

    const reason =
      extractReason(message, raw) || getLang("plugins.warnuser.no_reason");
    return await warnUser(message, target, reason);
  },
};
