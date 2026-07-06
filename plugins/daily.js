const { getLang } = require("../lib/utils/language");
const { GroupEconomy } = require("../lib/database");
const { sendQuickReplies } = require("./buttons");

const DAILY_AMOUNT = 50;
const STREAK_BONUS_PER_DAY = 10;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Daily reward: claim 50 coins + streak bonus, 24h cooldown.
 */
module.exports = {
  command: {
    pattern: "daily|claim",
    desc: getLang("plugins.daily.desc"),
    type: "economy",
  },

  async execute(message) {
    const sock = message.client.getSocket();
    const [econ, created] = await GroupEconomy.findOrCreate({
      where: { groupJid: message.jid, userJid: message.sender },
      defaults: { balance: 0, streak: 0, lastDailyAt: null },
    });

    const now = Date.now();
    if (!created && econ.lastDailyAt) {
      const last = new Date(econ.lastDailyAt).getTime();
      const elapsed = now - last;
      if (elapsed < COOLDOWN_MS) {
        const remaining = COOLDOWN_MS - elapsed;
        const hours = Math.floor(remaining / (60 * 60 * 1000));
        const mins = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
        const buttons = [{ id: `daily:status:${message.jid}`, text: "📊 Status" }];
        return await sendQuickReplies(
          sock,
          message.jid,
          getLang("plugins.daily.cooldown", hours, mins),
          buttons,
          { title: "⏰ Daily", footer: "OpenWhatsappBot", quoted: message.data }
        );
      }
      // 24-48h: streak continues; >48h: streak reset
      if (elapsed > 48 * 60 * 60 * 1000) {
        econ.streak = 0;
      } else {
        econ.streak = (econ.streak || 0) + 1;
      }
    } else if (created) {
      econ.streak = 1;
    } else {
      econ.streak = (econ.streak || 0) + 1;
    }

    const reward = DAILY_AMOUNT + (econ.streak || 1) * STREAK_BONUS_PER_DAY;
    econ.balance = (econ.balance || 0) + reward;
    econ.lastDailyAt = new Date();
    await econ.save();

    await message.react("💰");
    return await message.reply(
      getLang("plugins.daily.claimed", reward, econ.balance, econ.streak)
    );
  },

  async handleReply(message) {
    if (!message.body || !message.body.startsWith("daily:")) return false;
    if (message.body.startsWith("daily:status")) {
      const [econ] = await GroupEconomy.findOrCreate({
        where: { groupJid: message.jid, userJid: message.sender },
        defaults: { balance: 0, streak: 0, lastDailyAt: null },
      });
      return await message.reply(
        getLang("plugins.daily.status", econ.balance, econ.streak || 0)
      );
    }
    return false;
  },
};
