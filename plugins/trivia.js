const { getLang } = require("../lib/utils/language");
const { sendList } = require("./buttons");
const axios = require("axios");
const { htmlToText } = require("html-entities");

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

const games = new Map(); // chatId -> { question, correct, options, messageId, attempts, score:Map }

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function decode(s) {
  try { return htmlToText(s); } catch { return s; }
}

/**
 * Trivia: multiple-choice questions from opentdb.com (free, no key).
 * Per-user streak counter in memory.
 */
module.exports = {
  command: {
    pattern: "trivia|quiz2",
    desc: getLang("plugins.trivia.desc"),
    type: "games",
  },

  async execute(message, argsString) {
    const sock = message.client.getSocket();
    const arg = (argsString || "").trim().toLowerCase();

    if (!arg || !CATEGORIES[arg]) {
      // Show category picker
      const sections = [
        {
          title: "Categories",
          rows: Object.keys(CATEGORIES).map((k) => ({
            id: `trivia:cat:${k}`,
            title: k.charAt(0).toUpperCase() + k.slice(1),
            description: "Tap to start",
          })),
        },
      ];
      return await sendList(sock, message.jid, getLang("plugins.trivia.pick"), sections, {
        title: "🧠 Trivia",
        buttonLabel: "Pick a category",
        footer: "opentdb.com",
        quoted: message.data,
      });
    }

    await message.react("⏳");
    try {
      const url = `https://opentdb.com/api.php?amount=1&type=multiple&category=${CATEGORIES[arg]}`;
      const { data } = await axios.get(url, { timeout: 15000 });
      if (!data || !data.results || data.results.length === 0) {
        await message.react("❌");
        return await message.reply(getLang("plugins.trivia.api_error"));
      }
      const q = data.results[0];
      const correct = decode(q.correct_answer);
      const incorrects = q.incorrect_answers.map(decode);
      const options = shuffle([correct, ...incorrects]);

      const labels = ["A", "B", "C", "D"];
      const rows = options.map((opt, i) => ({
        id: `trivia:ans:${i}`,
        title: `${labels[i]}. ${opt.slice(0, 22)}`,
        description: opt.length > 22 ? opt.slice(22, 72) : "",
      }));

      const text =
        `🧠 *Trivia — ${arg.toUpperCase()}*\n\n` +
        `${decode(q.question)}\n\n` +
        options.map((o, i) => `${labels[i]}. ${o}`).join("\n") +
        `\n\n_Difficulty: ${q.difficulty}_`;

      const sent = await sendList(sock, message.jid, text, sections_via(rows), {
        title: "🧠 Trivia",
        buttonLabel: "Pick an answer",
        footer: "Tap your answer",
        quoted: message.data,
      });

      games.set(message.jid, {
        question: decode(q.question),
        correct,
        options,
        messageId: sent?.key?.id,
        score: games.get(message.jid)?.score || new Map(),
        category: arg,
      });
      await message.react("✅");
    } catch (err) {
      console.error("trivia error:", err.message);
      await message.react("❌");
      await message.reply(getLang("plugins.trivia.api_error"));
    }
  },

  async handleReply(message) {
    if (!message.body || !message.body.startsWith("trivia:")) return false;
    const parts = message.body.split(":");
    if (parts.length < 3) return false;
    if (parts[1] === "cat") {
      const cat = parts[2];
      if (!CATEGORIES[cat]) return false;
      // Re-invoke the command with the category arg
      message.body = (require("../config").PREFIX) + "trivia " + cat;
      await require("../lib/plugins/registry").executeCommand(message);
      return true;
    }
    if (parts[1] !== "ans") return false;
    const game = games.get(message.jid);
    if (!game) return false;
    const idx = parseInt(parts[2], 10);
    if (isNaN(idx) || idx < 0 || idx > 3) return false;
    const pick = game.options[idx];
    if (!pick) return false;

    const prev = game.score.get(message.sender) || { correct: 0, total: 0 };
    prev.total += 1;
    if (pick === game.correct) {
      prev.correct += 1;
      game.score.set(message.sender, prev);
      games.delete(message.jid);
      await message.react("🎉");
      await message.reply(
        getLang(
          "plugins.trivia.correct",
          game.correct,
          prev.correct,
          prev.total,
          Math.round((prev.correct / prev.total) * 100)
        )
      );
    } else {
      game.score.set(message.sender, prev);
      await message.react("❌");
      await message.reply(getLang("plugins.trivia.wrong", game.correct));
    }
    return true;
  },
};

function sections_via(rows) {
  return [{ title: "Answers", rows }];
}
