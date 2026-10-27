const crypto = require("crypto");
const config = require("../config");
const { getLang } = require("../lib/utils/language");
const { createStore } = require("../lib/utils/gameStore");
const { sendList } = require("./buttons");
const { fetchJson, classifyError, replyKeyFor, safeLog } = require("../lib/utils/http");
const { decode } = require("html-entities");
const { normalizeJid, jidUser } = require("../lib/utils/permissions");

/**
 * Trivia: multiple-choice questions from opentdb.com (free, no key).
 *   .trivia             pick a category in a list
 *   .trivia <category>  ask a question right away
 *   .trivia score       the scores of the chat
 *   .trivia stop        end the session (scores included)
 *
 * Ids: trivia:cat:<nonce>:<category> and trivia:ans:<nonce>:<1-4>.
 * A chat has one session; it keeps the scores between questions and expires after
 * SESSION_TTL_MS without activity. Each user has one attempt per question, a question
 * ends on the first correct answer or after QUESTION_TIMEOUT_MS.
 */

const OPENTDB_URL = "https://opentdb.com/api.php";
const SESSION_TTL_MS = 10 * 60 * 1000;
const QUESTION_TIMEOUT_MS = 60 * 1000;
const MAX_SCORE_LINES = 10;

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

// Session per chat: { nonce, phase: "idle"|"pick"|"loading"|"question", score: Map, ... }
const store = createStore("trivia", { ttlMs: SESSION_TTL_MS });

function newNonce() {
  return crypto.randomBytes(4).toString("hex");
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** A reaction is decoration: never let it break the game */
async function react(message, emoji) {
  try {
    await message.react(emoji);
  } catch (err) {
    console.error("Trivia reaction error:", safeLog(err));
  }
}

function categoryLabel(key) {
  return getLang(`plugins.trivia.cat_${key}`);
}

/** Who answered: the phone-number JID when known, as the score key */
function userKey(message) {
  return normalizeJid(message.sender || message.senderLid);
}

/** The game's creator, a group admin or an owner may stop or replace a running question */
async function canManage(message, game) {
  if (userKey(message) && userKey(message) === game.creator) return true;
  if (message.isSudo()) return true;
  return await message.isSenderAdmin();
}

function scoreLines(game) {
  const entries = [...game.score.entries()].sort(
    (a, b) => b[1].correct - a[1].correct || a[1].total - b[1].total,
  );
  const shown = entries.slice(0, MAX_SCORE_LINES);
  const lines = shown.map(
    ([key, s], i) => `${i + 1}. @${jidUser(key)}: ${s.correct}/${s.total}`,
  );
  return { text: lines.join("\n"), mentions: shown.map(([key]) => key) };
}

async function sendScores(message, game, headerKey) {
  if (game.score.size === 0) return await message.reply(getLang("plugins.trivia.no_scores"));
  const { text, mentions } = scoreLines(game);
  return await message.reply(getLang(headerKey, text), { mentions });
}

/** The session of the chat, ready for a new question (a running one only for managers) */
async function openSession(message) {
  const existing = store.get(message.jid);
  if (!existing) {
    const res = store.start(message.jid, {
      phase: "idle",
      score: new Map(),
      creator: userKey(message),
      attempted: new Set(),
    });
    return res.ok ? res.game : null;
  }

  const busy = existing.phase === "question" || existing.phase === "loading";
  if (busy && !(await canManage(message, existing))) {
    await message.reply(getLang("plugins.trivia.already_running", config.PREFIX));
    return null;
  }
  // New nonce: the buttons of the previous question or list become stale
  existing.nonce = newNonce();
  existing.phase = "idle";
  existing.attempted = new Set();
  existing.creator = userKey(message);
  store.touch(message.jid);
  return existing;
}

async function showCategories(message) {
  const game = await openSession(message);
  if (!game) return;
  game.phase = "pick";

  const sections = [
    {
      title: getLang("plugins.trivia.categories"),
      rows: Object.keys(CATEGORIES).map((key) => ({
        id: `trivia:cat:${game.nonce}:${key}`,
        title: categoryLabel(key),
        description: getLang("plugins.trivia.tap_to_start"),
      })),
    },
  ];
  const sent = await sendList(
    message.client.getSocket(),
    message.jid,
    getLang("plugins.trivia.pick", config.PREFIX),
    sections,
    {
      title: getLang("plugins.trivia.title"),
      buttonLabel: getLang("plugins.trivia.pick_category"),
      footer: "opentdb.com",
    },
  );
  if (sent?.key?.id) game.botMessageId = sent.key.id;
}

/** Fetch a question from opentdb; throws an error carrying a `kind` when the service refuses */
async function fetchQuestion(category) {
  const data = await fetchJson(OPENTDB_URL, {
    params: { amount: 1, type: "multiple", category: CATEGORIES[category] },
    timeoutMs: 15000,
  });
  // response_code: 0 ok, 1 no results, 2 bad parameter, 5 rate limit (1 request / 5 s / IP)
  if (!data || data.response_code !== 0 || !Array.isArray(data.results) || !data.results[0]) {
    const err = new Error(`opentdb response_code ${data && data.response_code}`);
    err.status = data && data.response_code === 5 ? 429 : 503;
    throw err;
  }
  return data.results[0];
}

/** Ask a question of `category` in the session's chat (the session phase is "idle" or "pick") */
async function askQuestion(message, game, category) {
  game.phase = "loading";
  try {
    await sendQuestion(message, game, category);
  } catch (err) {
    // Whatever failed, the session must not stay stuck on "loading" / "question"
    game.phase = "idle";
    throw err;
  }
}

async function sendQuestion(message, game, category) {
  await react(message, "⏳");

  let raw;
  try {
    raw = await fetchQuestion(category);
  } catch (err) {
    game.phase = "idle";
    console.error("Trivia fetch error:", safeLog(err));
    await react(message, "❌");
    return await message.reply(getLang(replyKeyFor(classifyError(err))));
  }

  const correct = decode(raw.correct_answer);
  const options = shuffle([correct, ...raw.incorrect_answers.map(decode)]).slice(0, 4);
  game.correct = correct;
  game.options = options;
  game.category = category;
  game.attempted = new Set();
  store.touch(message.jid);

  const rows = options.map((option, i) => ({
    id: `trivia:ans:${game.nonce}:${i + 1}`,
    title: `${i + 1}. ${option}`.slice(0, 24),
    description: option.length > 20 ? option.slice(0, 72) : "",
  }));
  const text = getLang(
    "plugins.trivia.question",
    categoryLabel(category).toUpperCase(),
    decode(raw.question),
    options.map((o, i) => `${i + 1}. ${o}`).join("\n"),
    raw.difficulty,
    config.PREFIX,
  );

  const sent = await sendList(
    message.client.getSocket(),
    message.jid,
    text,
    [{ title: getLang("plugins.trivia.answers"), rows }],
    {
      title: getLang("plugins.trivia.title"),
      buttonLabel: getLang("plugins.trivia.pick_answer"),
      footer: getLang("plugins.trivia.footer_answer"),
    },
  );
  game.botMessageId = sent?.key?.id || null;
  game.phase = "question"; // from now on the buttons are live
  await react(message, "✅");

  // Nobody found it: reveal the answer. The identity check ignores a question that has
  // already ended or been replaced.
  const nonce = game.nonce;
  const chatJid = message.jid;
  const client = message.client;
  const timer = setTimeout(() => {
    if (store.get(chatJid) !== game || game.nonce !== nonce || game.phase !== "question") return;
    game.phase = "idle";
    client
      .getSocket()
      .sendMessage(chatJid, { text: getLang("plugins.trivia.timeout", game.correct) })
      .catch((err) => console.error("Trivia timeout notice error:", safeLog(err)));
  }, QUESTION_TIMEOUT_MS);
  timer.unref?.();
}

/** Register the answer of `index` (0-3) for the message's author */
async function answer(message, game, index) {
  if (game.phase !== "question") return await message.reply(getLang("plugins.trivia.expired", config.PREFIX));
  const pick = game.options[index];
  if (pick === undefined) return await message.reply(getLang("plugins.trivia.expired", config.PREFIX));

  const key = userKey(message);
  if (game.attempted.has(key)) return await message.reply(getLang("plugins.trivia.already_answered"));
  game.attempted.add(key);

  const stats = game.score.get(key) || { correct: 0, total: 0 };
  stats.total += 1;
  game.score.set(key, stats);
  store.touch(message.jid);

  if (pick !== game.correct) {
    await react(message, "❌");
    return await message.reply(getLang("plugins.trivia.wrong"));
  }

  stats.correct += 1;
  game.phase = "idle";
  await react(message, "🎉");
  return await message.reply(
    getLang(
      "plugins.trivia.correct",
      game.correct,
      stats.correct,
      stats.total,
      Math.round((stats.correct / stats.total) * 100),
      config.PREFIX,
    ),
  );
}

async function stopSession(message) {
  const game = store.get(message.jid);
  if (!game) return await message.reply(getLang("plugins.trivia.no_game"));
  if (!(await canManage(message, game))) {
    return await message.reply(getLang("plugins.trivia.stop_denied"));
  }
  const revealed = game.phase === "question" ? game.correct : null;
  const scores = game.score.size > 0 ? scoreLines(game) : null;
  store.end(message.jid);

  const parts = [getLang("plugins.trivia.stopped")];
  if (revealed !== null) parts.push(getLang("plugins.trivia.reveal", revealed));
  if (scores) parts.push(getLang("plugins.trivia.final_scores", scores.text));
  return await message.reply(parts.join("\n\n"), { mentions: scores ? scores.mentions : [] });
}

/** Free-text answer: a reply to the question with 1-4 or A-D */
function freeTextIndex(message) {
  if (!message.quoted || message.fromMe) return -1;
  const game = store.get(message.jid);
  if (!game || game.phase !== "question") return -1;
  if (!message.quoted.id || message.quoted.id !== game.botMessageId) return -1;
  const body = (message.body || "").trim().toLowerCase();
  if (!body || body.startsWith(config.PREFIX)) return -1;
  if (/^[1-4]$/.test(body)) return Number(body) - 1;
  if (/^[a-d]$/.test(body)) return body.charCodeAt(0) - 97;
  return -1;
}

module.exports = {
  command: {
    pattern: "trivia|quiz2",
    desc: getLang("plugins.trivia.desc"),
    type: "games",
  },

  async execute(message, argsString) {
    const arg = String(argsString || "").trim().toLowerCase().split(/\s+/)[0] || "";

    if (arg === "stop" || arg === "quit") return await stopSession(message);
    if (arg === "score" || arg === "scores") {
      const game = store.get(message.jid);
      if (!game) return await message.reply(getLang("plugins.trivia.no_game"));
      return await sendScores(message, game, "plugins.trivia.scores");
    }
    if (arg === "help") return await message.reply(getLang("plugins.trivia.usage", config.PREFIX));

    if (arg && CATEGORIES[arg]) {
      const game = await openSession(message);
      if (!game) return;
      return await askQuestion(message, game, arg);
    }

    if (arg) return await message.reply(getLang("plugins.trivia.usage", config.PREFIX));
    return await showCategories(message);
  },

  async handleButtonReply(message) {
    if (typeof message.body !== "string" || !message.body.startsWith("trivia:")) {
      const index = freeTextIndex(message);
      if (index < 0) return false;
      try {
        await answer(message, store.get(message.jid), index);
      } catch (err) {
        console.error("Trivia reply error:", safeLog(err));
      }
      return true;
    }

    try {
      const [, action, nonce, arg] = message.body.split(":");
      const game = store.get(message.jid);
      if (!game || game.nonce !== nonce) {
        await message.reply(getLang("plugins.trivia.expired", config.PREFIX));
        return true;
      }

      if (action === "cat") {
        if (game.phase !== "pick" || !CATEGORIES[arg]) {
          await message.reply(getLang("plugins.trivia.expired", config.PREFIX));
          return true;
        }
        await askQuestion(message, game, arg);
      } else if (action === "ans") {
        await answer(message, game, parseInt(arg, 10) - 1);
      } else {
        await message.reply(getLang("plugins.trivia.expired", config.PREFIX));
      }
    } catch (err) {
      console.error("Trivia reply error:", safeLog(err));
    }
    return true;
  },
};
