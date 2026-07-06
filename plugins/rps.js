/**
 * Rock Paper Scissors Plugin
 * Play against the bot
 */

const { GameScore } = require("../lib/database");

const GAME = "rps";
const CHOICES = ["rock", "paper", "scissors"];
const EMOJI = { rock: "🪨", paper: "📄", scissors: "✂️" };
const FR = { rock: "pierre", paper: "papier", scissors: "ciseaux" };

// Returns: 'win', 'lose', 'draw'
function getResult(player, bot) {
  if (player === bot) return "draw";
  if (
    (player === "rock" && bot === "scissors") ||
    (player === "paper" && bot === "rock") ||
    (player === "scissors" && bot === "paper")
  )
    return "win";
  return "lose";
}

// Cooldown
const cooldowns = new Map();
const COOLDOWN_MS = 5000;

module.exports = {
  command: {
    pattern: "rps",
    desc: "Pierre-Papier-Ciseaux contre le bot",
    type: "games",
    fromMe: false,
    onlyGroup: true,
  },

  async execute(message, args) {
    const choice = (args || "").toLowerCase().trim();
    const choiceMap = {
      rock: "rock",
      pierre: "rock",
      paper: "paper",
      papier: "paper",
      scissors: "scissors",
      ciseaux: "scissors",
    };

    const playerChoice = choiceMap[choice];

    if (!playerChoice) {
      return await message.reply(
        `*🪨📄✂️ Pierre-Papier-Ciseaux*\n\n*Usage :*\n.rps pierre\n.rps papier\n.rps ciseaux\n\n.rps rock|paper|scissors (anglais ok aussi)`,
      );
    }

    const now = Date.now();
    const lastPlay = cooldowns.get(message.sender) || 0;
    if (now - lastPlay < COOLDOWN_MS) {
      return await message.reply("⏱️ Attendez 5 secondes avant de rejouer.");
    }
    cooldowns.set(message.sender, now);

    const botChoice = CHOICES[Math.floor(Math.random() * CHOICES.length)];
    const result = getResult(playerChoice, botChoice);

    const playerEmoji = EMOJI[playerChoice];
    const botEmoji = EMOJI[botChoice];
    const num = message.sender.split("@")[0];

    let resultText = "";
    let points = 0;

    if (result === "win") {
      resultText = `🎉 *@${num} gagne !*`;
      points = 5;
    } else if (result === "lose") {
      resultText = `😔 *Le bot gagne !*`;
      points = -2;
    } else {
      resultText = `🤝 *Égalité !*`;
      points = 1;
    }

    try {
      const [score] = await GameScore.findOrCreate({
        where: { jid: message.sender, groupJid: message.jid, game: GAME },
        defaults: { jid: message.sender, groupJid: message.jid, game: GAME },
      });
      if (result === "win") await score.increment({ wins: 1, score: points });
      else if (result === "lose") await score.increment({ losses: 1 });
      else await score.increment({ score: 1 });
    } catch (_) {}

    return await message.reply(
      `*🪨📄✂️ Pierre-Papier-Ciseaux*\n\n` +
        `Vous : ${playerEmoji} *${FR[playerChoice]}*\n` +
        `Bot : ${botEmoji} *${FR[botChoice]}*\n\n` +
        `${resultText}\n` +
        `${points > 0 ? `+${points}` : points} points`,
      { mentions: [message.sender] },
    );
  },
};
