const { getLang } = require("../lib/utils/language");
const { sendQuickReplies } = require("./buttons");
const { GroupEconomy } = require("../lib/database");

const DICE_BET_AMOUNT = 10;
const DICE_WIN_AMOUNT = 20;

function rollDie(sides) {
  return 1 + Math.floor(Math.random() * sides);
}

/**
 * Dice rolls and coin flip with optional economy bets.
 */
module.exports = {
  command: {
    pattern: "dice|roll",
    desc: getLang("plugins.dice.desc"),
    type: "games",
  },

  async execute(message, argsString) {
    const sock = message.client.getSocket();
    const args = (argsString || "").trim().toLowerCase().split(/\s+/);
    const mode = args[0] || "d6";
    const bet = parseInt(args[1] || "0", 10) || 0;

    if (mode === "coin" || mode === "flip" || mode === "cf") {
      const flip = Math.random() < 0.5 ? "heads" : "tails";
      return await message.reply(
        getLang(
          "plugins.dice.coin",
          flip === "heads" ? "🪙 Heads" : "🪙 Tails",
        ),
      );
    }

    let sides = 6;
    let count = 1;
    if (mode === "d6" || mode === "6") {
      sides = 6;
      count = 1;
    } else if (mode === "2d6" || mode === "26") {
      sides = 6;
      count = 2;
    } else if (mode === "d20" || mode === "20") {
      sides = 20;
      count = 1;
    } else if (/^(\d+)d(\d+)$/.test(mode)) {
      const m = mode.match(/^(\d+)d(\d+)$/);
      count = Math.min(10, parseInt(m[1], 10));
      sides = Math.min(100, parseInt(m[2], 10));
    } else {
      // Show menu
      const buttons = [
        { id: `dice:d6`, text: "🎲 d6" },
        { id: `dice:2d6`, text: "🎲🎲 2d6" },
        { id: `dice:d20`, text: "🎲 d20" },
        { id: `dice:coin`, text: "🪙 Coin" },
      ];
      return await sendQuickReplies(
        sock,
        message.jid,
        getLang("plugins.dice.pick"),
        buttons,
        {
          title: "🎲 Dice Roll",
          footer: "OpenWhatsappBot",
          quoted: message.data,
        },
      );
    }

    // Economy bet (only in groups)
    if (bet > 0 && message.isGroup) {
      const [econ] = await GroupEconomy.findOrCreate({
        where: { groupJid: message.jid, userJid: message.sender },
        defaults: { balance: 0, streak: 0 },
      });
      if (econ.balance < bet) {
        return await message.reply(
          getLang("plugins.dice.no_funds", bet, econ.balance),
        );
      }
      econ.balance -= bet;
      await econ.save();
    }

    const rolls = [];
    for (let i = 0; i < count; i++) rolls.push(rollDie(sides));
    const sum = rolls.reduce((a, b) => a + b, 0);
    const max = sides * count;

    let result = "";
    if (bet > 0) {
      if (sum === max) {
        // Jackpot — give 5x
        const [econ] = await GroupEconomy.findOrCreate({
          where: { groupJid: message.jid, userJid: message.sender },
          defaults: { balance: 0, streak: 0 },
        });
        const winAmount = bet * 5;
        econ.balance += winAmount;
        await econ.save();
        result = getLang("plugins.dice.jackpot", winAmount, econ.balance);
      } else if (sum >= max / 2) {
        const [econ] = await GroupEconomy.findOrCreate({
          where: { groupJid: message.jid, userJid: message.sender },
          defaults: { balance: 0, streak: 0 },
        });
        const winAmount = bet * 2;
        econ.balance += winAmount;
        await econ.save();
        result = getLang("plugins.dice.won", winAmount, econ.balance);
      } else {
        result = getLang("plugins.dice.lost", bet, econ.balance);
      }
    }

    const rollText = rolls.map((r) => `\`${r}\``).join(" ");
    await message.reply(
      `${getLang("plugins.dice.roll_format", mode, rollText, sum)}\n${result}`,
    );
  },

  async handleReply(message) {
    if (!message.body || !message.body.startsWith("dice:")) return false;
    const mode = message.body.slice("dice:".length);
    if (!["d6", "2d6", "d20", "coin"].includes(mode)) return false;
    if (message.fromMe) return false;
    // Re-invoke the same command by mutating body so registry runs it
    message.body = require("../config").PREFIX + "dice " + mode;
    await require("../lib/plugins/registry").executeCommand(message);
    return true;
  },
};
