/**
 * Wordle Plugin
 * 5-letter word guessing game with emoji grid feedback
 */

const { GameScore } = require("../lib/database");

const GAME = "wordle";

// Word list (subset for bot use)
const WORDS = [
  "piano",
  "table",
  "fleur",
  "plage",
  "nuage",
  "route",
  "chien",
  "fille",
  "livre",
  "coeur",
  "solde",
  "vigne",
  "rêver",
  "laser",
  "filet",
  "poule",
  "boire",
  "vague",
  "titre",
  "matin",
  "femme",
  "monde",
  "vitre",
  "pompe",
  "foule",
  "cycle",
  "plume",
  "rouge",
  "ville",
  "image",
  "bague",
  "piste",
  "tarte",
  "arbre",
  "sucre",
  "linge",
  "forêt",
  "boeuf",
  "règle",
  "sable",
];

// Active games: groupJid → { word, attempts: [], players: Map<jid, attempts[]>, maxAttempts: 6 }
const activeGames = new Map();

function getEmojiGrid(guess, word) {
  const result = [];
  const wordArr = word.split("");
  const guessArr = guess.split("");
  const used = new Array(5).fill(false);

  // First pass: correct positions
  guessArr.forEach((c, i) => {
    if (c === wordArr[i]) {
      result[i] = "🟩";
      used[i] = true;
    } else {
      result[i] = null;
    }
  });

  // Second pass: wrong positions
  guessArr.forEach((c, i) => {
    if (result[i] !== null) return;
    const found = wordArr.findIndex((wc, wi) => wc === c && !used[wi]);
    if (found !== -1) {
      result[i] = "🟨";
      used[found] = true;
    } else {
      result[i] = "⬛";
    }
  });

  return result.join("");
}

module.exports = {
  command: {
    pattern: "wordle",
    desc: "Devinez le mot de 5 lettres (comme Wordle) !",
    type: "games",
    fromMe: false,
    onlyGroup: true,
  },

  async execute(message, args) {
    const sub = (args || "").toLowerCase().trim();

    if (sub === "stop") {
      const game = activeGames.get(message.jid);
      if (!game) return await message.reply("❌ Aucune partie en cours.");
      activeGames.delete(message.jid);
      return await message.reply(
        `🛑 Partie arrêtée. Le mot était : *${game.word.toUpperCase()}*`,
      );
    }

    if (activeGames.has(message.jid)) {
      return await message.reply(
        "⚠️ Une partie Wordle est déjà en cours !\nTapez un mot de 5 lettres pour jouer.\n.wordle stop pour arrêter.",
      );
    }

    // Start new game
    const word = WORDS[Math.floor(Math.random() * WORDS.length)];
    activeGames.set(message.jid, { word, attempts: [], maxAttempts: 6 });

    return await message.reply(
      `*🟩 Wordle — Nouvelle Partie !*\n\nDevinez le mot de *5 lettres*.\n\n🟩 = bonne lettre, bonne position\n🟨 = bonne lettre, mauvaise position\n⬛ = lettre absente\n\n*6 essais* disponibles. Bonne chance !\n\n_Tapez votre mot de 5 lettres dans le chat._`,
    );
  },

  async handleMessage(message) {
    const game = activeGames.get(message.jid);
    if (!game) return false;

    const body = message.body.trim().toLowerCase();
    if (body.length !== 5 || !/^[a-zàâäéèêëîïôùûüç]+$/.test(body)) return false;

    const guess = body;
    const grid = getEmojiGrid(guess, game.word);
    game.attempts.push({ jid: message.sender, guess, grid });
    const attemptNum = game.attempts.length;
    const num = message.sender.split("@")[0];

    let display = game.attempts
      .map((a) => `${a.grid} ${a.guess.toUpperCase()}`)
      .join("\n");

    if (guess === game.word) {
      activeGames.delete(message.jid);
      const points = Math.max(10, 60 - attemptNum * 10);
      try {
        const [score] = await GameScore.findOrCreate({
          where: { jid: message.sender, groupJid: message.jid, game: GAME },
          defaults: { jid: message.sender, groupJid: message.jid, game: GAME },
        });
        await score.increment({ wins: 1, score: points });
      } catch (_) {}

      await message.reply(
        `🎉 *@${num} a trouvé !*\n\n${display}\n\n*${game.word.toUpperCase()}* trouvé en ${attemptNum} essai(s) ! +${points} points 🏆`,
        { mentions: [message.sender] },
      );
      return true;
    }

    if (attemptNum >= game.maxAttempts) {
      activeGames.delete(message.jid);
      await message.reply(
        `😞 *Perdu !*\n\n${display}\n\nLe mot était : *${game.word.toUpperCase()}*`,
      );
      return true;
    }

    const remaining = game.maxAttempts - attemptNum;
    await message.reply(
      `${grid}\n${display}\n\n_${remaining} essai(s) restant(s)_`,
    );
    return true;
  },
};
