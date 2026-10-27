const { getLang } = require("../lib/utils/language");
const config = require("../config");
const downloader = require("../lib/utils/downloader");
const { classifyError, replyKeyFor, safeLog } = require("../lib/utils/http");

/**
 * YouTube plugin (yt-dlp through lib/utils/downloader.js)
 *   .ytdl / .ytv <link>  video (15 minutes max)
 *   .yta <link>          audio (m4a, 60 minutes max)
 *   .yts <query>         search
 */

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

const MAX_VIDEO_SECONDS = 15 * 60;
const MAX_AUDIO_SECONDS = 60 * 60;
const SEARCH_RESULTS = 5;

// yt-dlp failures that mean "this link does not work", not "the service is down"
const BAD_LINK_CODES = new Set(["YTDLP_UNAVAILABLE", "YTDLP_UNSUPPORTED", "INVALID_URL"]);

const VIDEO_ID = "[\\w-]{11}";
const SHORT_PATH_RE = new RegExp(`^/${VIDEO_ID}(?:/|$)`);
const VIDEO_PATH_RE = new RegExp(`^/(?:shorts|live|embed|v)/${VIDEO_ID}(?:/|$)`);

function extractUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s<>"]+/i);
  return match ? match[0].replace(/[).,;!?]+$/, "") : null;
}

/**
 * First YouTube *video* link of a text, as a URL object, or null.
 * Channels and playlists are refused: yt-dlp would download every entry.
 */
function parseYoutubeUrl(text) {
  const raw = extractUrl(text);
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;

  if (host === "youtu.be") return SHORT_PATH_RE.test(url.pathname) ? url : null;

  const isWatch =
    url.pathname === "/watch" && new RegExp(`^${VIDEO_ID}$`).test(url.searchParams.get("v") || "");
  return isWatch || VIDEO_PATH_RE.test(url.pathname) ? url : null;
}

function formatDuration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "?";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/**
 * Reply to a failure. Unexpected errors are rethrown: the registry answers
 * common.error and sends the stack to the owner.
 */
async function fail(message, err) {
  await message.react("❌");

  if (BAD_LINK_CODES.has(err?.code)) {
    return await message.reply(getLang("plugins.youtube.invalid_link"));
  }

  const kind = classifyError(err, { userUrl: true });
  if (kind === "error") throw err;

  console.error("YouTube error:", safeLog(err));
  return await message.reply(getLang(replyKeyFor(kind), config.MAX_UPLOAD));
}

async function searchVideos(message, query) {
  const text = String(query || "").trim();
  if (!text) {
    return await message.reply(getLang("plugins.youtube.usage_search", config.PREFIX));
  }

  try {
    await message.react("🔍");
    const results = await downloader.search(text, SEARCH_RESULTS);

    if (!results.length) {
      await message.react("❌");
      return await message.reply(getLang("plugins.youtube.no_results"));
    }

    const lines = results.map((video, index) =>
      getLang(
        "plugins.youtube.search_item",
        index + 1,
        video.title,
        video.channel || getLang("plugins.youtube.unknown"),
        formatDuration(video.duration),
        video.url
      )
    );

    await message.reply(
      `${getLang("plugins.youtube.search_header")}\n\n${lines.join("\n\n")}\n\n${getLang(
        "plugins.youtube.search_footer",
        config.PREFIX
      )}`
    );
    await message.react("✅");
  } catch (err) {
    await fail(message, err);
  }
}

async function downloadMedia(message, argsString, audio) {
  const input = argsString || message.getQuotedText();
  if (!input) {
    return await message.reply(getLang("plugins.youtube.usage_download", config.PREFIX));
  }

  const url = parseYoutubeUrl(input);
  if (!url) {
    return await message.reply(getLang("plugins.youtube.invalid_link"));
  }

  try {
    await message.react("⏳");

    // Metadata first: refuse a live stream or a too long video before downloading it
    const info = await downloader.getInfo(url.href, { audio });
    if (info.isLive) {
      await message.react("❌");
      return await message.reply(getLang("plugins.youtube.invalid_link"));
    }

    const maxSeconds = audio ? MAX_AUDIO_SECONDS : MAX_VIDEO_SECONDS;
    if (info.duration !== null && info.duration > maxSeconds) {
      await message.react("❌");
      return await message.reply(
        getLang(
          "plugins.youtube.too_long",
          formatDuration(info.duration),
          formatDuration(maxSeconds)
        )
      );
    }

    await message.reply(
      getLang(
        "plugins.youtube.downloading",
        info.title || url.href,
        formatDuration(info.duration),
        getLang(audio ? "plugins.youtube.type_audio" : "plugins.youtube.type_video")
      )
    );

    const media = await downloader.download(url.href, { audio });

    if (audio) {
      await message.sendAudioFile(media.buffer);
    } else if (media.mimetype === "video/mp4") {
      await message.sendVideo(media.buffer, media.title, {
        mimetype: "video/mp4",
        fileName: media.fileName,
      });
    } else {
      // webm/mkv do not play inline in WhatsApp
      await message.sendDocument(media.buffer, {
        fileName: media.fileName,
        mimetype: media.mimetype,
        caption: media.title,
      });
    }

    await message.react("✅");
  } catch (err) {
    await fail(message, err);
  }
}

module.exports = {
  command: {
    pattern: "ytdl|ytv|yta|yts",
    desc: getLang("plugins.youtube.desc"),
    type: "downloader",
  },

  async execute(message, argsString, ctx) {
    const command = ctx?.command || "ytdl";

    if (command === "yts") return await searchVideos(message, argsString);
    return await downloadMedia(message, argsString, command === "yta");
  },

  // exposed for tests
  parseYoutubeUrl,
};
