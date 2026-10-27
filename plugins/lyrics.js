const { getLang } = require("../lib/utils/language");
const config = require("../config");
const { fetchJson, classifyError, replyKeyFor, safeLog } = require("../lib/utils/http");

/**
 * Lyrics plugin (LRCLIB, keyless): https://lrclib.net/api/search?q=<query>
 */

const LRCLIB_SEARCH_URL = "https://lrclib.net/api/search";
const USER_AGENT = "OpenWhatsappBot (https://github.com/Starland9/OpenWhatsappBot)";

const MAX_QUERY_LENGTH = 200;
const CHUNK_SIZE = 3500;
const MAX_PARTS = 3;

/**
 * Split lyrics into at most `maxParts` messages of about `size` characters, on line
 * boundaries. `truncated` is true when some lyrics did not fit.
 */
function chunkLyrics(text, size = CHUNK_SIZE, maxParts = MAX_PARTS) {
  const lines = String(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((line) => (line.length > size ? line.match(new RegExp(`.{1,${size}}`, "gs")) : [line]));

  const parts = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > size && current) {
      parts.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current.trim()) parts.push(current);

  return { parts: parts.slice(0, maxParts), truncated: parts.length > maxParts };
}

module.exports = {
  command: {
    pattern: "lyrics",
    desc: getLang("plugins.lyrics.desc"),
    type: "search",
  },

  async execute(message, argsString) {
    const query = (argsString || message.getQuotedText()).trim().slice(0, MAX_QUERY_LENGTH);

    if (!query) {
      return await message.reply(getLang("plugins.lyrics.usage", config.PREFIX));
    }

    try {
      await message.react("🔍");

      const results = await fetchJson(LRCLIB_SEARCH_URL, {
        params: { q: query },
        headers: { "User-Agent": USER_AGENT },
        timeoutMs: 15000,
      });

      const song = Array.isArray(results)
        ? results.find((r) => typeof r?.plainLyrics === "string" && r.plainLyrics.trim())
        : null;

      if (!song) {
        await message.react("❌");
        return await message.reply(getLang("plugins.lyrics.not_found"));
      }

      // some LRCLIB records already put the artist in the track name
      const track = song.trackName || query;
      const title =
        song.artistName && !track.toLowerCase().includes(song.artistName.toLowerCase())
          ? `${track} — ${song.artistName}`
          : track;
      const { parts, truncated } = chunkLyrics(song.plainLyrics.trim());

      for (let i = 0; i < parts.length; i++) {
        let text = parts[i];
        if (i === 0) text = `${getLang("plugins.lyrics.header", title)}\n\n${text}`;
        else text = `${getLang("plugins.lyrics.part", i + 1, parts.length)}\n\n${text}`;
        if (truncated && i === parts.length - 1) text += `\n\n${getLang("plugins.lyrics.truncated")}`;
        await message.reply(text);
      }

      await message.react("✅");
    } catch (err) {
      await message.react("❌");

      const kind = classifyError(err);
      if (kind === "error") throw err;

      console.error("Lyrics error:", safeLog(err));
      await message.reply(getLang(replyKeyFor(kind), config.MAX_UPLOAD));
    }
  },

  // exposed for tests
  chunkLyrics,
};
