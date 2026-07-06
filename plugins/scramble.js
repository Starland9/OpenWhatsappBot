/**
 * Scramble Plugin
 * Word scramble — guess the unscrambled word
 */

const { GameScore } = require("../lib/database");

const GAME = "scramble";
const ROUND_DURATION_MS = 30_000;

const WORDS = [
  ["ordinateur", "Technologie"], ["musique", "Art"], ["papillon", "Nature"],
  ["chocolat", "Nourriture"], ["bibliothèque", "Lieu"], ["aventure", "Action"],
  ["télévision", "Technologie"], ["girafe", "Animal"], ["pyramide", "Architecture"],
  ["football", "Sport"], ["princesse", "Conte"], ["baleine", "Animal"],
  ["champignon", "Nature"], ["journaliste", "Métier"], ["microscope", "Science"],
  ["révolution", "Histoire"], ["mathématiques", "École"], ["philosophie", "Savoir"],
  ["harmonie", "Musique"], ["démocratie", "Politique"], ["astronomie", "Science"],
  ["architecture", "Art"], ["laboratoire", "Science"], ["magnifique", "Adjectif"],
  ["intelligence", "Qualité"], ["crocodile", "Animal"], ["fantastique", "Adjectif"],
  ["photographie", "Art"], ["électricité", "Science"], ["thermomètre", "Outil"],
];

// Active rounds: groupJid → { word, hint, timeout, startedBy }
const activeRounds = new Map();

function scramble(word) {
  const arr = word.split("");
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  // Ensure it's actually scrambled
  if (arr.join("") === word && word.length > 1) return scramble(word);
  return arr.join("");
}

module.exports = {
  command: {
    pattern: "scramble",
    desc: "Déchiffrez le mot mélangé ! Premier à trouver gagne.",
    type: "games",
    fromMe: false,
    onlyGroup: true,
  },

  async execute(message, args) {
    if (activeRounds.has(message.jid)) {
      return await message.reply("⚠️ Un mot est déjà en cours ! Trouvez-le d'abord.");
    }

    const [word, category] = WORDS[Math.floor(Math.random() * WORDS.length)];
    const shuffled = scramble(word);
    const hint = category;

    const round = { word, shuffled, hint, startedBy: message.sender, timeout: null };
    activeRounds.set(message.jid, round);

    const jid = message.jid;
    const sock = message.client.getSocket();

    round.timeout = setTimeout(async () => {
      if (activeRounds.get(jid)?.word === word) {
        activeRounds.delete(jid);
        await sock.sendMessage(jid, {
          text: `⏰ *Temps écoulé !*\n\nLe mot était : *${word.toUpperCase()}*\n\nMeilleure chance la prochaine fois !`,
        });
      }
    }, ROUND_DURATION_MS);

    return await message.reply(
      `*🔤 Scramble — Nouveau Mot !*\n\n` +
      `*Mot mélangé :* \`${shuffled.toUpperCase()}\`\n` +
      `*Catégorie :* ${hint}\n` +
      `*Lettres :* ${word.length}\n\n` +
      `_Répondez avec le bon mot en 30 secondes !_`
    );
  },

  async handleMessage(message) {
    const round = activeRounds.get(message.jid);
    if (!round) return false;

    const guess = message.body.trim().toLowerCase();
    // Only handle if it looks like a word attempt (no prefix, reasonable length)
    if (guess.startsWith(".") || guess.length < 3 || guess.length > 20) return false;
    if (guess !== round.word) return false;

    // Correct answer!
    clearTimeout(round.timeout);
    activeRounds.delete(message.jid);

    const num = message.sender.split("@")[0];

    try {
      const [score] = await GameScore.findOrCreate({
        where: { jid: message.sender, groupJid: message.jid, game: GAME },
        defaults: { jid: message.sender, groupJid: message.jid, game: GAME },
      });
      await score.increment({ wins: 1, score: 10 });
    } catch (_) {}

    await message.reply(
      `🎉 *@${num} a trouvé !*\n\nLe mot était : *${round.word.toUpperCase()}*\n\n+10 points ! 🏆`,
      { mentions: [message.sender] }
    );

    return true;
  },
};
