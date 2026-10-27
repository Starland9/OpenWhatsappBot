const config = require("../config");
const { getLang } = require("../lib/utils/language");
const { createStore } = require("../lib/utils/gameStore");
const { safeLog } = require("../lib/utils/http");

const MAX_ATTEMPTS = 6;
const GAME_TTL_MS = 15 * 60 * 1000;
const MAX_BOARD_IDS = 10;

// One game per chat; expires after GAME_TTL_MS without a guess
const store = createStore("hangman", { ttlMs: GAME_TTL_MS });

// Word lists; the French one may carry accents, the game itself plays on the plain letters
const WORDS_EN = [
  "banana",
  "computer",
  "elephant",
  "guitar",
  "horizon",
  "island",
  "jungle",
  "kangaroo",
  "lemon",
  "mountain",
  "nebula",
  "ocean",
  "pyramid",
  "quasar",
  "rainbow",
  "satellite",
  "telescope",
  "umbrella",
  "volcano",
  "whisper",
  "xylophone",
  "yogurt",
  "zebra",
  "diamond",
  "emerald",
  "flamingo",
  "gondola",
  "helicopter",
  "iceberg",
  "jaguar",
  "koala",
  "lighthouse",
  "mosaic",
  "narwhal",
  "octopus",
  "pegasus",
  "quicksand",
  "revolver",
  "sapphire",
  "treasure",
  "unicorn",
  "vampire",
  "wizard",
  "yacht",
  "zeppelin",
  "airplane",
  "bicycle",
  "calendar",
  "dragonfly",
  "earthquake",
  "firefly",
  "grenade",
  "honeycomb",
  "iguana",
  "jackal",
  "keyhole",
  "lantern",
  "mandolin",
  "nail",
  "obelisk",
  "pumpkin",
  "quiver",
  "rosebush",
  "scorpion",
  "tornado",
  "violin",
  "watermelon",
  "xenon",
  "android",
  "browser",
  "cathedral",
  "dolphin",
  "engine",
  "forest",
  "garden",
  "helmet",
  "jacket",
  "kite",
  "leopard",
  "marble",
  "noodle",
  "otter",
  "piano",
  "quill",
  "ribbon",
  "ship",
];

const WORDS_FR = [
  "banane",
  "ordinateur",
  "éléphant",
  "guitare",
  "horizon",
  "jungle",
  "kangourou",
  "citron",
  "montagne",
  "nébuleuse",
  "océan",
  "pyramide",
  "satellite",
  "télescope",
  "parapluie",
  "volcan",
  "murmure",
  "xylophone",
  "yaourt",
  "zèbre",
  "diamant",
  "émeraude",
  "flamant",
  "gondole",
  "hélicoptère",
  "iceberg",
  "jaguar",
  "phare",
  "mosaïque",
  "narval",
  "pieuvre",
  "pégase",
  "sable",
  "saphir",
  "trésor",
  "licorne",
  "vampire",
  "sorcier",
  "voilier",
  "dirigeable",
  "avion",
  "bicyclette",
  "calendrier",
  "libellule",
  "séisme",
  "luciole",
  "serrure",
  "lanterne",
  "mandoline",
  "obélisque",
  "citrouille",
  "carquois",
  "scorpion",
  "tornade",
  "violon",
  "pastèque",
  "cathédrale",
  "dauphin",
  "moteur",
  "forêt",
  "jardin",
  "casque",
  "léopard",
  "marbre",
  "nouille",
  "loutre",
  "piano",
  "plume",
  "ruban",
  "bateau",
  "fromage",
  "croissant",
  "baguette",
  "chocolat",
  "chandelle",
  "papillon",
  "tournesol",
  "boussole",
  "château",
  "bibliothèque",
  "arbre",
  "nuage",
  "étoile",
  "orage",
  "fenêtre",
  "valise",
];

function stripAccents(text) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Keep the words that can be played letter by letter: only a-z once the accents are
 * gone (so no "yo-yo" or "arc-en-ciel"), at least 4 letters, no duplicates.
 * @returns {Array<{ key: string, display: string }>} key = plain letters, display = as written
 */
function buildPool(words) {
  const seen = new Set();
  const pool = [];
  for (const word of words) {
    const display = word.toLowerCase();
    const key = stripAccents(display);
    if (!/^[a-z]{4,}$/.test(key) || key.length !== display.length || seen.has(key)) continue;
    seen.add(key);
    pool.push({ key, display });
  }
  return pool;
}

const POOLS = { en: buildPool(WORDS_EN), fr: buildPool(WORDS_FR) };

function pickWord() {
  const lang = String(config.LANG || "en").slice(0, 2).toLowerCase();
  const pool = POOLS[lang] || POOLS.en;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Normalize a typed letter: lower case, accents removed ("É" -> "e") */
function normalizeLetter(text) {
  return stripAccents(String(text || "").trim().toLowerCase());
}

function maskWord(game) {
  return [...game.display]
    .map((ch, i) => (game.guessed.has(game.answer[i]) ? ch : "_"))
    .join(" ");
}

function isSolved(game) {
  return [...game.answer].every((ch) => game.guessed.has(ch));
}

const STAGES = [
  "+---+\n|   |\n|   \n|   \n|   \n=== ",
  "+---+\n|   |\n|   O\n|   \n|   \n=== ",
  "+---+\n|   |\n|   O\n|   |\n|   \n=== ",
  "+---+\n|   |\n|   O\n|  /|\n|   \n=== ",
  "+---+\n|   |\n|   O\n|  /|\\\n|   \n=== ",
  "+---+\n|   |\n|   O\n|  /|\\\n|  / \n=== ",
  "+---+\n|   |\n|   O\n|  /|\\\n|  / \\\n=== ",
];

function renderGallows(attempts) {
  return "```" + STAGES[Math.min(attempts, STAGES.length - 1)] + "```";
}

function renderBoard(game) {
  const wrong = [...game.guessed].filter((ch) => !game.answer.includes(ch));
  return getLang(
    "plugins.hangman.board",
    renderGallows(game.attempts),
    maskWord(game),
    wrong.length ? wrong.join(" ").toUpperCase() : "-",
    game.attempts,
    MAX_ATTEMPTS,
    config.PREFIX,
  );
}

/** Remember the board message so replies to it (or to a recent one) count as guesses */
function rememberBoard(game, sent) {
  const id = sent?.key?.id;
  if (!id) return;
  game.botMessageId = id;
  game.boardIds.add(id);
  while (game.boardIds.size > MAX_BOARD_IDS) {
    game.boardIds.delete(game.boardIds.values().next().value);
  }
}

/** The game's creator, a group admin or an owner may stop or replace a game */
async function canManage(message, game) {
  if (message.sender && message.sender === game.creator) return true;
  if (message.isSudo()) return true;
  return await message.isSenderAdmin();
}

async function startGame(message) {
  const word = pickWord();
  const game = {
    answer: word.key,
    display: word.display,
    guessed: new Set(),
    attempts: 0,
    creator: message.sender,
    botMessageId: null,
    boardIds: new Set(),
  };

  let res = store.start(message.jid, game);
  if (!res.ok) {
    if (!(await canManage(message, res.existing))) {
      return await message.reply(getLang("plugins.hangman.already_running", config.PREFIX));
    }
    store.end(message.jid);
    res = store.start(message.jid, game);
    if (!res.ok) {
      return await message.reply(getLang("plugins.hangman.already_running", config.PREFIX));
    }
  }

  const sent = await message.reply(renderBoard(game));
  rememberBoard(game, sent);
}

async function stopGame(message) {
  const game = store.get(message.jid);
  if (!game) return await message.reply(getLang("plugins.hangman.no_game", config.PREFIX));
  if (!(await canManage(message, game))) {
    return await message.reply(getLang("plugins.hangman.stop_denied"));
  }
  store.end(message.jid);
  return await message.reply(getLang("plugins.hangman.stopped", game.display.toUpperCase()));
}

/**
 * Apply one guess to the chat's game and answer in the chat.
 * The state is updated before the first await, so two guesses cannot both win.
 */
async function guessLetter(message, game, text) {
  const letter = normalizeLetter(text);
  if (!/^[a-z]$/.test(letter)) {
    return await message.reply(getLang("plugins.hangman.invalid"));
  }
  if (game.guessed.has(letter)) {
    return await message.reply(getLang("plugins.hangman.already", letter));
  }

  game.guessed.add(letter);
  if (!game.answer.includes(letter)) game.attempts += 1;
  store.touch(message.jid);

  if (isSolved(game)) {
    store.end(message.jid);
    return await message.reply(getLang("plugins.hangman.win", game.display.toUpperCase()));
  }
  if (game.attempts >= MAX_ATTEMPTS) {
    store.end(message.jid);
    return await message.reply(getLang("plugins.hangman.lose", game.display.toUpperCase()));
  }

  const sent = await message.reply(renderBoard(game));
  rememberBoard(game, sent);
}

/**
 * Hangman: word-guessing game.
 * Anyone in the chat can guess: `.hangman <letter>` or a reply to the board.
 */
module.exports = {
  command: {
    pattern: "hangman|pendu",
    desc: getLang("plugins.hangman.desc"),
    type: "games",
  },

  async execute(message, argsString) {
    const arg = String(argsString || "").trim().toLowerCase().split(/\s+/)[0] || "";

    if (arg === "stop" || arg === "quit") return await stopGame(message);
    if (arg === "help") {
      return await message.reply(getLang("plugins.hangman.usage", config.PREFIX));
    }

    if (arg === "" || arg === "start" || arg === "new") return await startGame(message);

    // A single letter is a guess
    if (stripAccents(arg).length === 1) {
      const game = store.get(message.jid);
      if (!game) return await message.reply(getLang("plugins.hangman.no_game", config.PREFIX));
      return await guessLetter(message, game, arg);
    }

    return await message.reply(getLang("plugins.hangman.usage", config.PREFIX));
  },

  // A reply to the board with a letter. Never claims anything else.
  async handleButtonReply(message) {
    if (!message.quoted || message.fromMe) return false;
    const game = store.get(message.jid);
    if (!game || !game.boardIds.has(message.quoted.id)) return false;
    const body = (message.body || "").trim();
    if (!body || body.startsWith(config.PREFIX)) return false;

    try {
      await guessLetter(message, game, body);
    } catch (err) {
      console.error("Hangman reply error:", safeLog(err));
    }
    return true;
  },
};
