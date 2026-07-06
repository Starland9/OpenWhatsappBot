/**
 * Slots Plugin
 * 🎰 Slot machine game
 */

const { GameScore } = require("../lib/database");

const GAME = "slots";

const REELS = ["🍒", "🍋", "🍊", "🍇", "💎", "7️⃣", "🎰", "⭐"];

const COMBOS = {
  "💎💎💎": { name: "JACKPOT DIAMANT", points: 500, emoji: "💰" },
  "7️⃣7️⃣7️⃣": { name: "TRIPLE 7", points: 300, emoji: "🎉" },
  "🎰🎰🎰": { name: "JACKPOT", points: 200, emoji: "🎊" },
  "⭐⭐⭐": { name: "TRIPLE ÉTOILE", points: 150, emoji: "✨" },
  "🍇🍇🍇": { name: "TRIPLE RAISIN", points: 100, emoji: "🍇" },
  "🍊🍊🍊": { name: "TRIPLE ORANGE", points: 80, emoji: "🍊" },
  "🍋🍋🍋": { name: "TRIPLE CITRON", points: 60, emoji: "🍋" },
  "🍒🍒🍒": { name: "TRIPLE CERISE", points: 50, emoji: "🍒" },
};

function spin() {
  return [
    REELS[Math.floor(Math.random() * REELS.length)],
    REELS[Math.floor(Math.random() * REELS.length)],
    REELS[Math.floor(Math.random() * REELS.length)],
  ];
}

// Cooldown: user → last spin timestamp
const cooldowns = new Map();
const COOLDOWN_MS = 10_000; // 10 seconds

module.exports = {
  command: {
    pattern: "slots|spin",
    desc: "Machine à sous 🎰 — tentez votre chance !",
    type: "games",
    fromMe: false,
    onlyGroup: true,
  },

  async execute(message) {
    const now = Date.now();
    const lastSpin = cooldowns.get(message.sender) || 0;

    if (now - lastSpin < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - (now - lastSpin)) / 1000);
      return await message.reply(
        `⏱️ Attendez encore *${remaining}s* avant de rejouer.`,
      );
    }

    cooldowns.set(message.sender, now);

    const result = spin();
    const key = result.join("");
    const combo = COMBOS[key];

    // Check for two same
    const hasPair =
      result[0] === result[1] ||
      result[1] === result[2] ||
      result[0] === result[2];

    let responseText = `*🎰 Machine à Sous*\n\n`;
    responseText += `╔═══════════════╗\n`;
    responseText += `║  ${result[0]}  ${result[1]}  ${result[2]}  ║\n`;
    responseText += `╚═══════════════╝\n\n`;

    if (combo) {
      responseText += `${combo.emoji} *${combo.name}!* +${combo.points} points\n`;
      try {
        const [score] = await GameScore.findOrCreate({
          where: { jid: message.sender, groupJid: message.jid, game: GAME },
          defaults: { jid: message.sender, groupJid: message.jid, game: GAME },
        });
        await score.increment({ wins: 1, score: combo.points });
      } catch (_) {}
    } else if (hasPair) {
      responseText += `😊 *Paire !* +5 points\n`;
      try {
        const [score] = await GameScore.findOrCreate({
          where: { jid: message.sender, groupJid: message.jid, game: GAME },
          defaults: { jid: message.sender, groupJid: message.jid, game: GAME },
        });
        await score.increment({ score: 5 });
      } catch (_) {}
    } else {
      responseText += `😔 Rien cette fois... Réessayez !\n`;
    }

    responseText += `\n_Cooldown : 10s | .glb pour le classement_`;

    return await message.reply(responseText);
  },
};
