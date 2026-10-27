const pino = require("pino");
const { getLang } = require("../lib/utils/language");
const { getOwnerJids, jidUser } = require("../lib/utils/permissions");
const { safeLog } = require("../lib/utils/http");
const cooldown = require("../lib/utils/cooldown");
const config = require("../config");

const logger = pino({ level: config.LOG_LEVEL });

const COOLDOWN_MS = 60 * 1000;
const MAX_LENGTH = 1000;

/**
 * Feedback: forwards a message to the bot owners. The sender's number is shared.
 *   .feedback The bot is great
 *   (reply to a message with .feedback) — forwards the quoted message too
 */
module.exports = {
  command: {
    pattern: "feedback|fb",
    desc: getLang("plugins.feedback.desc"),
    type: "general",
  },

  async execute(message, argsString, ctx) {
    // rawArgs keeps the line breaks of a multi-line message
    const text = String(ctx?.rawArgs ?? argsString ?? "").trim();
    if (!text && !message.quoted) {
      return await message.reply(getLang("plugins.feedback.usage", config.PREFIX));
    }

    if (text.length > MAX_LENGTH) {
      return await message.reply(getLang("plugins.feedback.too_long", MAX_LENGTH));
    }

    const owners = getOwnerJids();
    if (owners.length === 0) {
      return await message.reply(getLang("plugins.feedback.no_sudo"));
    }

    // One feedback per minute and per user
    const who = message.sender || message.senderLid || message.jid;
    const wait = cooldown.hit(who, "feedback", COOLDOWN_MS);
    if (wait) {
      return await message.reply(getLang("common.cooldown", Math.ceil(wait / 1000)));
    }

    const sock = message.client.getSocket();
    // The group name is a nicety: never fail the feedback because of it
    const groupName = message.isGroup
      ? await message.getGroupMetadata().then(
          (metadata) => metadata?.subject,
          () => null,
        )
      : null;
    const chatName = message.isGroup
      ? groupName || getLang("plugins.feedback.unknown_group")
      : getLang("plugins.feedback.private_chat");

    const fbText = getLang(
      "plugins.feedback.report",
      jidUser(who),
      chatName,
      text || getLang("plugins.feedback.quote_only"),
    );

    let delivered = 0;
    for (const target of owners) {
      try {
        await sock.sendMessage(target, { text: fbText, mentions: [who] });
        delivered++;
      } catch (error) {
        logger.error(safeLog(error), "feedback send error");
        continue;
      }

      if (message.quoted?.message) {
        try {
          await sock.sendMessage(target, {
            forward: { key: message.quoted.key, message: message.quoted.message },
          });
        } catch (error) {
          logger.error(safeLog(error), "feedback forward error");
        }
      }
    }

    if (delivered === 0) {
      // Nothing was sent: give the cooldown back so the user can retry
      cooldown.reset(who, "feedback");
      return await message.reply(getLang("plugins.feedback.failed"));
    }

    await message.react("📨");
    return await message.reply(getLang("plugins.feedback.sent"));
  },
};
