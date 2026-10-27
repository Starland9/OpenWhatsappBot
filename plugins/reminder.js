const { getLang } = require("../lib/utils/language");
const config = require("../config");
const scheduler = require("../lib/utils/scheduler");
const { normalizeJid, jidUser, toPnJid } = require("../lib/utils/permissions");

/**
 * Reminder plugin (research R17). Reminders live in the database and are
 * delivered by lib/utils/scheduler.js, which starts from `onReady`.
 *
 *   .remind <when> <text>      30s, 10m, 2h, 1d, 3j, 1h30m, 14:30 or 2026-12-31 18:00
 *   .remind list [all]         your pending reminders in this chat (admins: all)
 *   .remind cancel <id>        the creator, a group admin or an owner
 */

const LIST_WORDS = new Set(["list", "liste"]);
const CANCEL_WORDS = new Set(["cancel", "annuler", "del", "delete", "remove"]);
const MAX_LISTED = 30;
const LIST_TEXT_LENGTH = 60;

/** Stored creator id (phone-number form first) and the other forms of the sender */
async function identityForms(message) {
  const pn = await toPnJid(message, message.sender);
  return [...new Set([pn, normalizeJid(message.sender), normalizeJid(message.senderLid)].filter(Boolean))];
}

const oneLine = (text, max) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function usage() {
  return `${getLang("common.usage_prefix")}\n${getLang("plugins.reminder.usage", config.PREFIX)}`;
}

/** Error code of `scheduler.schedule` -> lang key (or null when unexpected) */
function scheduleErrorKey(error) {
  switch (error?.code) {
    case "LIMIT_REACHED":
      return ["plugins.reminder.limit_reached", scheduler.LIMITS.MAX_PENDING_PER_USER, config.PREFIX];
    case "TEXT_TOO_LONG":
      return ["plugins.reminder.text_too_long", scheduler.LIMITS.MAX_TEXT_LENGTH];
    case "TEXT_EMPTY":
      return ["plugins.reminder.no_text"];
    case "INVALID_TIME":
      return error.reason === "too_far"
        ? ["plugins.reminder.too_far"]
        : ["plugins.reminder.too_soon"];
    default:
      return null;
  }
}

async function createReminder(message, raw) {
  const { date, text } = scheduler.extractWhen(raw);
  if (!date) return message.reply(usage());
  if (!text) return message.reply(getLang("plugins.reminder.no_text"));

  const forms = await identityForms(message);
  try {
    const reminder = await scheduler.schedule({
      chatJid: message.jid,
      creatorJid: forms[0],
      text,
      dueAt: date,
    });
    await message.react("⏰");
    return await message.reply(
      getLang("plugins.reminder.set", reminder.id, scheduler.formatWhen(reminder.dueAt), reminder.text),
    );
  } catch (error) {
    const key = scheduleErrorKey(error);
    if (!key) throw error;
    return message.reply(getLang(...key));
  }
}

async function listReminders(message, rest) {
  // `list all` (group admins and owners): everyone's reminders of this group
  const wantsAll = message.isGroup && /^(all|tous|tout)$/i.test(rest.trim());
  if (wantsAll && !message.isSudo() && !(await message.isSenderAdmin())) {
    return message.reply(getLang("common.sender_not_admin"));
  }

  const showAll = wantsAll;
  const rows = await scheduler.list({
    chatJid: message.jid,
    creatorJids: showAll ? undefined : await identityForms(message),
    limit: MAX_LISTED,
  });
  if (!rows.length) {
    return message.reply(getLang(showAll ? "plugins.reminder.none_all" : "plugins.reminder.none"));
  }

  const mentions = [];
  const lines = rows.map((row) => {
    const owner = showAll ? ` @${jidUser(row.creatorJid)}` : "";
    if (showAll) mentions.push(row.creatorJid);
    return getLang(
      "plugins.reminder.list_item",
      row.id,
      scheduler.formatWhen(row.dueAt),
      oneLine(row.text, LIST_TEXT_LENGTH),
      owner,
    );
  });
  return message.reply(`${getLang("plugins.reminder.list_title", rows.length)}\n\n${lines.join("\n")}`, {
    mentions,
  });
}

async function cancelReminder(message, rest) {
  const match = rest.trim().match(/^#?(\d{1,9})$/);
  if (!match) return message.reply(usage());

  const reminder = await scheduler.get(match[1]);
  if (!reminder || reminder.status !== "pending") {
    return message.reply(getLang("plugins.reminder.not_found", match[1]));
  }

  const forms = await identityForms(message);
  const isCreator = forms.includes(normalizeJid(reminder.creatorJid));
  const isOwner = message.isSudo();
  const sameChat = reminder.chatJid === message.jid;

  // Others' reminders from another chat are reported as "not found"
  if (!isCreator && !isOwner && !sameChat) {
    return message.reply(getLang("plugins.reminder.not_found", match[1]));
  }
  const isChatAdmin = !isCreator && !isOwner && message.isGroup && (await message.isSenderAdmin());
  if (!isCreator && !isOwner && !isChatAdmin) {
    return message.reply(getLang("plugins.reminder.cancel_denied"));
  }

  if (!(await scheduler.cancel(reminder.id))) {
    return message.reply(getLang("plugins.reminder.not_found", match[1]));
  }
  await message.react("✅");
  return message.reply(getLang("plugins.reminder.cancelled", reminder.id));
}

/** Hook: (re)start the polling loop each time the connection opens (idempotent) */
function onReady(client) {
  return scheduler.start(client);
}

module.exports = {
  command: {
    pattern: "remind|reminder|rappel",
    desc: getLang("plugins.reminder.desc"),
    type: "utility",
  },

  async execute(message, argsString, ctx) {
    const raw = String(ctx?.rawArgs ?? argsString ?? "").replace(/^\s+/, "");
    if (!raw.trim()) return message.reply(usage());

    const first = raw.split(/\s+/, 1)[0];
    const word = first.toLowerCase();
    const rest = raw.slice(first.length);

    if (LIST_WORDS.has(word)) return listReminders(message, rest);
    if (CANCEL_WORDS.has(word)) return cancelReminder(message, rest);
    return createReminder(message, raw);
  },

  onReady,
};
