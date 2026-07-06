const { getLang } = require("../lib/utils/language");
const { GroupEconomy } = require("../lib/database");
const { Op } = require("sequelize");

/**
 * Give coins to another user.
 */
module.exports = {
  command: {
    pattern: "give|pay|transfer",
    desc: getLang("plugins.give.desc"),
    type: "economy",
  },

  async execute(message, argsString) {
    const args = (argsString || "").trim().split(/\s+/);
    const amount = parseInt(args[0], 10);
    const target =
      message.mentions && message.mentions.length > 0
        ? message.mentions[0]
        : message.quoted
        ? message.quoted.sender
        : null;

    if (!amount || amount <= 0) {
      return await message.reply(getLang("plugins.give.usage", require("../config").PREFIX));
    }
    if (!target) {
      return await message.reply(getLang("plugins.give.mention_user"));
    }
    if (target === message.sender) {
      return await message.reply(getLang("plugins.give.self"));
    }

    const [sender] = await GroupEconomy.findOrCreate({
      where: { groupJid: message.jid, userJid: message.sender },
      defaults: { balance: 0, streak: 0, lastDailyAt: null },
    });
    const [receiver] = await GroupEconomy.findOrCreate({
      where: { groupJid: message.jid, userJid: target },
      defaults: { balance: 0, streak: 0, lastDailyAt: null },
    });

    if ((sender.balance || 0) < amount) {
      return await message.reply(getLang("plugins.give.no_funds", amount, sender.balance || 0));
    }

    sender.balance = (sender.balance || 0) - amount;
    receiver.balance = (receiver.balance || 0) + amount;
    await sender.save();
    await receiver.save();

    await message.react("💸");
    return await message.reply(
      getLang(
        "plugins.give.done",
        amount,
        `@${target.split("@")[0]}`,
        sender.balance
      ),
      { mentions: [target] }
    );
  },
};
