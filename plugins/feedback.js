const { getLang } = require("../lib/utils/language");
const config = require("../config");

/**
 * Anonymous feedback: forwards a message to the bot SUDO.
 *   .feedback The bot is great
 *   (reply to a message with .feedback) — forwards the quoted message too
 */
module.exports = {
  command: {
    pattern: "feedback|fb",
    desc: getLang("plugins.feedback.desc"),
    type: "general",
  },

  async execute(message, argsString) {
    const text = (argsString || "").trim();
    if (!text && !message.quoted) {
      return await message.reply(
        getLang("plugins.feedback.usage", config.PREFIX),
      );
    }

    const sudoList = (config.SUDO || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (sudoList.length === 0) {
      return await message.reply(getLang("plugins.feedback.no_sudo"));
    }

    const senderName = `@${message.sender.split("@")[0]}`;
    const groupName = message.isGroup
      ? (await message.getGroupMetadata())?.subject || "Unknown Group"
      : "Private";

    const fbText =
      `📨 *Feedback*\n\n` +
      `From: ${senderName}\n` +
      `Group: ${groupName}\n` +
      (text ? `\n${text}\n` : "");

    for (const jid of sudoList) {
      const target = jid.includes("@") ? jid : `${jid}@s.whatsapp.net`;
      try {
        await message.client.getSocket().sendMessage(target, {
          text: fbText,
          mentions: message.isGroup ? [message.sender] : [],
        });
        if (message.quoted) {
          await message.client.getSocket().sendMessage(target, {
            forward: message.quoted.message,
          });
        }
      } catch (e) {
        console.error("feedback send error:", e.message);
      }
    }

    await message.react("📨");
    return await message.reply(getLang("plugins.feedback.sent"));
  },
};
