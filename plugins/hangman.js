/**
 * Hangman Plugin
 * Classic hangman game for groups with ASCII art
 */

const { GameScore } = require("../lib/database");

const GAME = "hangman";

// Word lists by category
const WORD_LISTS = {
  animaux: ["elephant", "girafe", "dauphin", "panthère", "crocodile", "perroquet", "gorille", "renard", "papillon", "baleine"],
  pays: ["france", "allemagne", "japon", "brésil", "australie", "mexique", "canada", "turquie", "espagne", "nigeria"],
  sports: ["football", "natation", "basketball", "volleyball", "cyclisme", "escrime", "karaté", "boxe", "rugby", "tennis"],
  aliments: ["chocolat", "fromage", "ananas", "pastèque", "mangue", "baguette", "crepe", "fondue", "couscous", "ratatouille"],
  technologie: ["ordinateur", "internet", "téléphone", "tablette", "satellite", "robotique", "logiciel", "réseau", "serveur", "intelligence"],
  all: ["aventure", "musique", "soleil", "montagne", "rivière", "numéro", "chapeau", "journée", "question", "lumière"],
};

// ASCII art stages (0 = perfect, 6 = dead)
const HANGMAN_STAGES = [
  `  +---+
  |   |
      |
      |
      |
      |
=========`,
  `  +---+
  |   |
  O   |
      |
      |
      |
=========`,
  `  +---+
  |   |
  O   |
  |   |
      |
      |
=========`,
  `  +---+
  |   |
  O   |
 /|   |
      |
      |
=========`,
  `  +---+
  |   |
  O   |
 /|\\  |
      |
      |
=========`,
  `  +---+
  |   |
  O   |
 /|\\  |
 /    |
      |
=========`,
  `  +---+
  |   |
  O   |
 /|\\  |
 / \\  |
      |
=========`,
];

// Active games: groupJid → game state
const activeGames = new Map();

function pickWord(category = "all") {
  const list = WORD_LISTS[category.toLowerCase()] || WORD_LISTS.all;
  return list[Math.floor(Math.random() * list.length)];
}

function buildDisplay(word, guessed) {
  return word
    .split("")
    .map((c) => (c === " " ? " " : guessed.has(c) ? c : "_"))
    .join(" ");
}

function isWordGuessed(word, guessed) {
  return word.split("").every((c) => c === " " || guessed.has(c));
}

module.exports = {
  command: {
    pattern: "hangman",
    desc: "Jeu du pendu pour le groupe",
    type: "games",
    fromMe: false,
    onlyGroup: true,
  },

  async execute(message, args) {
    const sub = (args || "").toLowerCase().trim().split(/\s+/);
    const action = sub[0];
    const category = sub[1] || "all";

    if (action === "start") {
      if (activeGames.has(message.jid)) {
        return await message.reply("⚠️ Une partie est déjà en cours ! Utilisez *.hangman stop* pour l'arrêter.");
      }

      const word = pickWord(category);
      const game = {
        word,
        guessed: new Set(),
        wrong: new Set(),
        maxWrong: 6,
        category,
        startedBy: message.sender,
      };
      activeGames.set(message.jid, game);

      const display = buildDisplay(word, game.guessed);
      return await message.reply(
        `*🎯 Pendu — Nouvelle Partie !*\n\nCatégorie : *${category}*\n\n\`\`\`${HANGMAN_STAGES[0]}\`\`\`\n\n*Mot :* ${display}\n\n*Lettres incorrectes :* (aucune)\n\n_Envoyez une lettre dans le chat pour jouer !_`
      );
    }

    if (action === "stop") {
      const game = activeGames.get(message.jid);
      if (!game) return await message.reply("❌ Aucune partie en cours.");
      const isAdmin = await message.isSenderAdmin();
      if (game.startedBy !== message.sender && !isAdmin && !message.isSudo()) {
        return await message.reply("❌ Seul celui qui a lancé la partie ou un admin peut l'arrêter.");
      }
      activeGames.delete(message.jid);
      return await message.reply(`🛑 Partie arrêtée. Le mot était : *${game.word}*`);
    }

    // Show categories / help
    return await message.reply(
      `*🎯 Jeu du Pendu*\n\n*Usage :*\n.hangman start → démarrer (mots aléatoires)\n.hangman start animaux → catégorie animaux\n.hangman stop → arrêter\n\n*Catégories :*\n${Object.keys(WORD_LISTS).join(", ")}\n\n*Comment jouer :*\nEnvoyez une lettre dans le chat pour deviner !`
    );
  },

  // Called from gameHandler for non-command messages
  async handleMessage(message) {
    const game = activeGames.get(message.jid);
    if (!game) return false;

    const body = message.body.trim().toLowerCase();
    if (body.length !== 1 || !/^[a-zàâäéèêëîïôùûüç]$/.test(body)) return false;

    const letter = body;
    if (game.guessed.has(letter) || game.wrong.has(letter)) {
      await message.reply(`⚠️ La lettre *${letter.toUpperCase()}* a déjà été jouée !`);
      return true;
    }

    if (game.word.includes(letter)) {
      game.guessed.add(letter);
      const display = buildDisplay(game.word, game.guessed);
      const num = message.sender.split("@")[0];

      if (isWordGuessed(game.word, game.guessed)) {
        activeGames.delete(message.jid);
        // Save win
        try {
          const [score] = await GameScore.findOrCreate({
            where: { jid: message.sender, groupJid: message.jid, game: GAME },
            defaults: { jid: message.sender, groupJid: message.jid, game: GAME },
          });
          await score.increment({ wins: 1, score: 10 });
        } catch (_) {}

        await message.reply(
          `🎉 *@${num} a trouvé le mot !*\n\n*${game.word.toUpperCase()}*\n\n+10 points pour @${num} 🏆`,
          { mentions: [message.sender] }
        );
      } else {
        await message.reply(
          `✅ Bonne lettre *${letter.toUpperCase()}* !\n\n\`\`\`${HANGMAN_STAGES[game.wrong.size]}\`\`\`\n\n*Mot :* ${display}\n*Mauvaises lettres :* ${[...game.wrong].join(", ") || "aucune"}`
        );
      }
    } else {
      game.wrong.add(letter);
      const display = buildDisplay(game.word, game.guessed);

      if (game.wrong.size >= game.maxWrong) {
        activeGames.delete(message.jid);
        await message.reply(
          `💀 *Perdu !*\n\n\`\`\`${HANGMAN_STAGES[6]}\`\`\`\n\nLe mot était : *${game.word.toUpperCase()}*`
        );
      } else {
        const remaining = game.maxWrong - game.wrong.size;
        await message.reply(
          `❌ *${letter.toUpperCase()}* n'est pas dans le mot !\n\n\`\`\`${HANGMAN_STAGES[game.wrong.size]}\`\`\`\n\n*Mot :* ${display}\n*Mauvaises lettres :* ${[...game.wrong].join(", ")}\n*Essais restants :* ${remaining}`
        );
      }
    }

    return true;
  },
};
