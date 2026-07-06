const { getLang } = require("../lib/utils/language");
const axios = require("axios");

const CATEGORIES = {
  general: 9,
  books: 10,
  film: 11,
  music: 12,
  science: 17,
  computers: 18,
  math: 19,
  sports: 21,
  geography: 22,
  history: 23,
};

const games = new Map(); // chatId -> { answer, masked, guessed:Set, attempts, maxAttempts, messageId, category }

const WORDS = [
  "banana", "computer", "elephant", "guitar", "horizon", "island", "jungle",
  "kangaroo", "lemon", "mountain", "nebula", "ocean", "pyramid", "quasar",
  "rainbow", "satellite", "telescope", "umbrella", "volcano", "whisper",
  "xylophone", "yogurt", "zebra", "diamond", "emerald", "flamingo", "gondola",
  "helicopter", "iceberg", "jaguar", "koala", "lighthouse", "mosaic", "narwhal",
  "octopus", "pegasus", "quicksand", "revolver", "sapphire", "treasure",
  "unicorn", "vampire", "wizard", "yacht", "zeppelin", "airplane", "bicycle",
  "calendar", "dragonfly", "earthquake", "firefly", "grenade", "honeycomb",
  "iguana", "jackal", "keyhole", "lantern", "mandolin", "nail", "obelisk",
  "pumpkin", "quiver", "rosebush", "scorpion", "tornado", "umbrella", "violin",
  "watermelon", "xenon", "yo-yo", "zeppelin", "android", "browser", "cathedral",
  "dolphin", "engine", "forest", "garden", "helmet", "ice", "jacket", "kite",
  "leopard", "marble", "noodle", "otter", "piano", "quill", "ribbon", "ship",
];

function pickWord() {
  return WORDS[Math.floor(Math.random() * WORDS.length)].toLowerCase();
}

function maskWord(word, guessed) {
  return word.split("").map((c) => (guessed.has(c) ? c : "_")).join(" ");
}

function renderHangman(attempts, max) {
  const stages = [
    "+---+\n|   |\n|   \n|   \n|   \n=== ",
    "+---+\n|   |\n|   O\n|   \n|   \n=== ",
    "+---+\n|   |\n|   O\n|   |\n|   \n=== ",
    "+---+\n|   |\n|   O\n|  /|\n|   \n=== ",
    "+---+\n|   |\n|   O\n|  /|\\\n|   \n=== ",
    "+---+\n|   |\n|   O\n|  /|\\\n|  / \n=== ",
    "+---+\n|   |\n|   O\n|  /|\\\n|  / \\\n=== ",
  ];
  const i = Math.min(stages.length - 1, Math.floor((attempts / max) * (stages.length - 1)));
  return "```" + stages[i] + "```";
}

/**
 * Hangman: word-guessing game.
 * 1vBot — single player picks letters; bot maintains state.
 */
module.exports = {
  command: {
    pattern: "hangman",
    desc: getLang("plugins.hangman.desc"),
    type: "games",
  },

  async execute(message) {
    const args = (message.body || "").trim().toLowerCase().split(/\s+/);
    const arg = args[1];
    if (arg && CATEGORIES[arg]) {
      // Fetch from opentdb (but opentdb returns trivia, not hangman words)
      // We ignore category for hangman — we use built-in word list
    }

    const word = pickWord();
    const game = {
      answer: word,
      masked: maskWord(word, new Set()),
      guessed: new Set(),
      attempts: 0,
      maxAttempts: 7,
      messageId: message.id,
    };
    games.set(message.jid, game);

    const text =
      `🎯 *Hangman*\n\n${renderHangman(0, 7)}\n` +
      `Word: \`${game.masked}\`\n` +
      `Attempts: 0/7\n\n` +
      `_Send ${require("../config").PREFIX}guess <letter> or reply to this message with a single letter._`;

    const sent = await message.reply(text);
    if (sent?.key?.id) game.botMessageId = sent.key.id;
  },

  async handleReply(message) {
    if (!message.quoted) return false;
    const game = games.get(message.jid);
    if (!game) return false;
    if (message.quoted.id !== game.botMessageId) return false;

    const guess = (message.body || "").trim().toLowerCase();
    if (guess.length !== 1 || !/[a-z]/.test(guess)) {
      await message.reply(getLang("plugins.hangman.invalid"));
      return true;
    }
    if (game.guessed.has(guess)) {
      await message.reply(getLang("plugins.hangman.already", guess));
      return true;
    }
    game.guessed.add(guess);
    if (game.answer.includes(guess)) {
      // correct
    } else {
      game.attempts += 1;
    }
    game.masked = maskWord(game.answer, game.guessed);

    if (game.masked.replace(/\s/g, "") === game.answer) {
      games.delete(message.jid);
      await message.reply(getLang("plugins.hangman.win", game.answer.toUpperCase()));
      return true;
    }
    if (game.attempts >= game.maxAttempts) {
      games.delete(message.jid);
      await message.reply(getLang("plugins.hangman.lose", game.answer.toUpperCase()));
      return true;
    }

    const text =
      `${renderHangman(game.attempts, game.maxAttempts)}\n` +
      `Word: \`${game.masked}\`\n` +
      `Attempts: ${game.attempts}/${game.maxAttempts}\n\n` +
      `_Reply with a single letter._`;
    const sent = await message.reply(text);
    if (sent?.key?.id) game.botMessageId = sent.key.id;
    return true;
  },
};
