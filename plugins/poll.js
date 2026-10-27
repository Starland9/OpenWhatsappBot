const { getLang } = require("../lib/utils/language");
const config = require("../config");
const { safeLog } = require("../lib/utils/http");

/**
 * Poll plugin: creates a native WhatsApp poll (WhatsApp counts the votes).
 *   .poll Question? option 1, option 2, option 3     → one answer per member
 *   .poll+ Question? option 1, option 2, option 3    → several answers allowed
 *   .poll Question | option 1 | option 2             → "|" (or one option per line) also works
 * Aliases: vote, pollplus (same as poll+).
 */

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 12;
const MAX_QUESTION_LENGTH = 255;
const MAX_OPTION_LENGTH = 100;
const MULTI_COMMANDS = new Set(["poll+", "pollplus"]);

const tidy = (text) => String(text).replace(/\s+/g, " ").trim();

/**
 * Split "Question? a, b, c" at the FIRST "?". Options are separated by "|",
 * else by line breaks, else by commas. Without a "?", "Question | a | b" works.
 * @returns {{ question: string, options: string[] }|null} options are trimmed,
 *   capped and deduplicated (case-insensitive); the count is not checked
 */
function parsePoll(raw) {
  const text = String(raw || "").trim();
  const q = text.indexOf("?");
  const bar = text.indexOf("|");

  let question;
  let parts;
  if (bar !== -1 && (q === -1 || bar < q)) {
    [question, ...parts] = text.split("|");
  } else if (q !== -1) {
    question = text.slice(0, q + 1);
    const rest = text.slice(q + 1);
    if (rest.includes("|")) parts = rest.split("|");
    else if (rest.trim().includes("\n")) parts = rest.split(/\r?\n/);
    else parts = rest.split(",");
  } else {
    return null;
  }

  question = tidy(question).slice(0, MAX_QUESTION_LENGTH);
  if (!tidy(question.replace(/\?/g, ""))) return null;

  const seen = new Set();
  const options = [];
  for (const part of parts) {
    const option = tidy(part).slice(0, MAX_OPTION_LENGTH).trim();
    const key = option.toLowerCase();
    if (!option || seen.has(key)) continue;
    seen.add(key);
    options.push(option);
  }
  return { question, options };
}

module.exports = {
  command: {
    pattern: "poll|vote|poll+|pollplus",
    desc: getLang("plugins.poll.desc"),
    type: "group",
    onlyGroup: true,
  },

  async execute(message, argsString, ctx) {
    const raw = String(ctx?.rawArgs ?? argsString ?? "");
    if (!raw.trim()) {
      return await message.reply(getLang("plugins.poll.usage", config.PREFIX));
    }

    const poll = parsePoll(raw);
    if (!poll) {
      return await message.reply(getLang("plugins.poll.format_error", config.PREFIX));
    }
    if (poll.options.length < MIN_OPTIONS) {
      return await message.reply(getLang("plugins.poll.min_options"));
    }
    if (poll.options.length > MAX_OPTIONS) {
      return await message.reply(getLang("plugins.poll.max_options"));
    }

    // selectableCount 1 = single answer; as many as there are options = multiple answers
    const multiple = MULTI_COMMANDS.has(ctx?.command);
    try {
      await message.sendPoll(poll.question, poll.options, {
        selectableCount: multiple ? poll.options.length : 1,
      });
    } catch (error) {
      console.error("poll: could not send the poll", safeLog(error));
      return await message.reply(getLang("common.error"));
    }
  },
};
