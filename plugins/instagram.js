const { getLang } = require("../lib/utils/language");
const config = require("../config");
const downloader = require("../lib/utils/downloader");
const { classifyError, replyKeyFor, safeLog } = require("../lib/utils/http");

/**
 * Instagram downloader: posts, reels, IGTV and stories through yt-dlp
 * (lib/utils/downloader.js). The old third-party providers no longer exist.
 */

const INSTAGRAM_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
  "instagr.am",
  "www.instagr.am",
]);

// /p/<id>, /reel/<id>, /reels/<id>, /tv/<id>, /share/<id>, /stories/<user>/<id>,
// optionally behind a username (/<user>/reel/<id>)
const CONTENT_PATH_RE = /^\/(?:[^/]+\/)?(?:p|reel|reels|tv|share|stories)\/[^/]+/i;

// yt-dlp failures that mean "this link does not work", not "the service is down"
const BAD_LINK_CODES = new Set(["YTDLP_UNAVAILABLE", "YTDLP_UNSUPPORTED", "INVALID_URL"]);

function extractUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s<>"]+/i);
  return match ? match[0].replace(/[).,;!?]+$/, "") : null;
}

/** First Instagram content link of a text, as a URL object, or null */
function parseInstagramUrl(text) {
  const raw = extractUrl(text);
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!INSTAGRAM_HOSTS.has(url.hostname.toLowerCase())) return null;
  return CONTENT_PATH_RE.test(url.pathname) ? url : null;
}

async function sendMedia(message, media, caption) {
  const type = String(media.mimetype || "").split("/")[0];
  if (media.mimetype === "video/mp4" || media.mimetype === "video/quicktime") {
    return await message.sendVideo(media.buffer, caption);
  }
  if (type === "image" && media.mimetype !== "image/gif") {
    return await message.sendImage(media.buffer, caption);
  }
  if (type === "audio") return await message.sendAudioFile(media.buffer);
  return await message.sendDocument(media.buffer, {
    fileName: media.fileName,
    mimetype: media.mimetype,
    caption,
  });
}

module.exports = {
  command: {
    pattern: "insta",
    desc: getLang("plugins.instagram.desc"),
    type: "downloader",
  },

  async execute(message, argsString) {
    const input = argsString || message.getQuotedText();

    if (!input) {
      return await message.reply(getLang("plugins.instagram.usage", config.PREFIX));
    }

    const url = parseInstagramUrl(input);
    if (!url) {
      return await message.reply(getLang("plugins.instagram.invalid_url"));
    }

    try {
      await message.react("⏳");
      const media = await downloader.download(url.href);
      await sendMedia(message, media, getLang("plugins.instagram.caption"));
      await message.react("✅");
    } catch (err) {
      await message.react("❌");

      if (BAD_LINK_CODES.has(err?.code)) {
        return await message.reply(getLang("plugins.instagram.failed"));
      }

      const kind = classifyError(err, { userUrl: true });
      if (kind === "error") throw err;

      console.error("Instagram download error:", safeLog(err));
      await message.reply(getLang(replyKeyFor(kind), config.MAX_UPLOAD));
    }
  },

  // exposed for tests
  parseInstagramUrl,
};
