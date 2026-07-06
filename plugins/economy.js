const { getLang } = require("../lib/utils/language");
const { GroupEconomy } = require("../lib/database");
const { sendQuickReplies } = require("./buttons");

/**
 * Show user balance + group top-5 rich list.
 */
module.exports = {
  command: {
    pattern: "balance|bal|coins|wallet",
    desc: getLang("plugins.economy.desc"),
    type: "economy",
  },

  async execute(message) {
    const sock = message.client.getSocket();
    let target = message.sender;
    if (message.mentions && message.mentions.length > 0) target = message.mentions[0];
    else if (message.quoted) target = message.quoted.sender;

    const [econ] = await GroupEconomy.findOrCreate({
      where: { groupJid: message.jid, userJid: target },
      defaults: { balance: 0, streak: 0, lastDailyAt: null },
    });

    const top = await GroupEconomy.findAll({
      where: { groupJid: message.jid },
      order: [["balance", "DESC"]],
      limit: 5,
    });

    const targetName = `@${target.split("@")[0]}`;
    const text =
      `💰 *Balance*\n\n` +
      `${targetName}: _${econ.balance} coins_\n` +
      (econ.streak ? `Streak: _${econ.streak} days_ 🔥\n` : "") +
      `\n*Top 5 in this group:*\n` +
      top
        .map((r, i) => `  ${i + 1}. @${r.userJid.split("@")[0]} — _${r.balance} coins_`)
        .join("\n");

    const buttons = [
      { id: `daily:claim:${message.jid}`, text: "🎁 Daily" },
      { id: `give:menu:${message.jid}`, text: "💸 Give" },
    ];
    try {
      return await sendQuickReplies(sock, message.jid, text, buttons, {
        title: "💰 Economy",
        footer: "OpenWhatsappBot",
        quoted: message.data,
      });
    } catch (e) {
      return await message.reply(text, { mentions: top.map((r) => r.userJid) });
    }
  },

  async handleReply(message) {
    if (!message.body || !message.body.startsWith("daily:claim")) {
      if (message.body && message.body.startsWith("give:menu")) {
        return await message.reply(
          getLang("plugins.give.usage", require("../config").PREFIX)
        );
      }
      return false;
    }
    // Forward to .daily
    message.body = (require("../config").PREFIX) + "daily";
    await require("../lib/plugins/registry").executeCommand(message);
    return true;
  },
};
