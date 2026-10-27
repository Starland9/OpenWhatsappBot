const { getLang } = require("../lib/utils/language");
const config = require("../config");
const downloader = require("../lib/utils/downloader");
const {
  fetchJson,
  fetchBuffer,
  classifyError,
  replyKeyFor,
  safeLog,
} = require("../lib/utils/http");

/**
 * Multi-platform downloader (.dl <link> [audio]).
 *
 * yt-dlp first (lib/utils/downloader.js). The optional backend (BACKEND_URL) is only a
 * fallback, and only when the owner set it explicitly; it is also the only way to get Spotify.
 */

// Hosts we accept, per platform. A host matches when it is the domain itself or one of its
// subdomains (vt.tiktok.com, web.facebook.com, fr.pinterest.com, old.reddit.com...).
const PLATFORMS = [
  { id: "tiktok", label: "TikTok", domains: ["tiktok.com"] },
  { id: "instagram", label: "Instagram", domains: ["instagram.com", "instagr.am"] },
  { id: "facebook", label: "Facebook", domains: ["facebook.com", "fb.com", "fb.watch"] },
  { id: "twitter", label: "X (Twitter)", domains: ["x.com", "twitter.com"] },
  { id: "youtube", label: "YouTube", domains: ["youtube.com", "youtu.be"] },
  { id: "pinterest", label: "Pinterest", domains: ["pinterest.com", "pin.it"] },
  { id: "reddit", label: "Reddit", domains: ["reddit.com", "redd.it"] },
];
const SPOTIFY = { id: "spotify", label: "Spotify", domains: ["spotify.com"], backendOnly: true };

const BACKEND_PATHS = {
  tiktok: "/tiktok",
  instagram: "/insta",
  facebook: "/facebook",
  youtube: "/yt",
  pinterest: "/pinterest",
  spotify: "/spotify",
};

const BACKEND_TIMEOUT_MS = 30000;
const MEDIA_TIMEOUT_MS = 120000;

// yt-dlp failures after which the backend is not worth trying
const NO_FALLBACK_CODES = new Set(["MEDIA_TOO_LARGE", "INVALID_URL"]);

/**
 * Base URL of the optional backend, or "" when BACKEND_URL is not configured.
 */
function backendUrl() {
  if (!config.BACKEND_URL) return "";
  try {
    const url = new URL(String(config.BACKEND_URL));
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.href.replace(/\/+$/, "");
  } catch (e) {
    return "";
  }
}

function extractUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s<>"]+/i);
  return match ? match[0].replace(/[).,;!?]+$/, "") : null;
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Platform of a URL object, or null when its host is not allowed */
function detectPlatform(url, withBackend) {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const candidates = withBackend ? [...PLATFORMS, SPOTIFY] : PLATFORMS;
  return candidates.find((p) => p.domains.some((d) => hostMatches(host, d))) || null;
}

/** First link of the text (or of the quoted message) plus the options typed around it */
function parseInput(argsString, quotedText) {
  const args = String(argsString || "");
  const fromArgs = extractUrl(args);
  const raw = fromArgs || extractUrl(quotedText);
  if (!raw) return { url: null, audio: false };

  let url = null;
  try {
    url = new URL(raw);
  } catch (e) {
    // handled by the caller: unparsable link
  }

  // "audio" only counts as a word of its own, not inside the link
  const words = args.replace(raw, " ").toLowerCase().split(/\s+/);
  return { url, audio: words.includes("audio") };
}

/** "image" | "video" | "audio" | null from a content type, else from the first bytes */
function mediaKind(contentType, buffer) {
  const type = String(contentType || "").toLowerCase().split(";")[0].trim();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";

  if (!buffer || buffer.length < 12) return null;
  const ascii = (start, end) => buffer.toString("latin1", start, end);
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image";
  if (ascii(1, 4) === "PNG" || ascii(0, 4) === "GIF8") return "image";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image";
  if (ascii(4, 8) === "ftyp") return ascii(8, 12) === "M4A " ? "audio" : "video";
  if (ascii(0, 4) === "OggS" || ascii(0, 3) === "ID3" || ascii(0, 4) === "fLaC") return "audio";
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return "video";
  }
  return null;
}

async function sendMedia(message, { buffer, mimetype, fileName }, caption) {
  const kind = mediaKind(mimetype, buffer);
  const isGif = /gif/i.test(mimetype || "") || buffer.toString("latin1", 0, 4) === "GIF8";
  const playsInline = !/webm|matroska/i.test(mimetype || "");

  if (kind === "audio") return await message.sendAudioFile(buffer);
  if (kind === "image" && !isGif) return await message.sendImage(buffer, caption);
  if (kind === "video" && playsInline) return await message.sendVideo(buffer, caption);

  // gif, webm, mkv or unknown: WhatsApp does not play these inline, send the file as is
  return await message.sendDocument(buffer, {
    fileName: fileName || "download",
    mimetype: mimetype || "application/octet-stream",
    caption,
  });
}

/** Ask the backend for a direct media link, download it, and describe it like yt-dlp does */
async function downloadViaBackend(base, platform, href, audio) {
  const body = { url: href };
  if (platform.id === "youtube") {
    body.type = audio ? "audio" : "video";
    body.quality = "720p";
  }

  const result = await fetchJson(`${base}${BACKEND_PATHS[platform.id]}`, {
    method: "POST",
    data: body,
    timeoutMs: BACKEND_TIMEOUT_MS,
  });

  const link =
    result && result.status === "success"
      ? result.ViDeO_LiNk_DeReCT || result.Video_Url || result.Audio_Url || result.AuDiO_LiNk_DeReCT
      : null;

  let mediaUrl = null;
  try {
    mediaUrl = link ? new URL(String(link)) : null;
  } catch (e) {
    // not a link
  }
  if (!mediaUrl || (mediaUrl.protocol !== "https:" && mediaUrl.protocol !== "http:")) {
    const err = new Error("Backend returned no usable link");
    err.code = "ERR_BAD_RESPONSE_FORMAT";
    throw err;
  }

  const { buffer, contentType } = await fetchBuffer(mediaUrl.href, { timeoutMs: MEDIA_TIMEOUT_MS });
  return { buffer, mimetype: contentType ? contentType.split(";")[0].trim() : null, fileName: "download" };
}

/** yt-dlp first; the backend only as a fallback, when configured */
async function fetchMedia(platform, href, audio) {
  const base = backendUrl();

  let primary = null;
  if (!platform.backendOnly) {
    try {
      return await downloader.download(href, { audio });
    } catch (err) {
      primary = err;
    }
  }

  if (!base || (primary && NO_FALLBACK_CODES.has(primary.code))) {
    throw primary || new Error("Unsupported platform");
  }

  try {
    return await downloadViaBackend(base, platform, href, audio);
  } catch (backendErr) {
    console.error("Social download backend error:", safeLog(backendErr));
    // Report the yt-dlp failure, it is the one the user can act on
    throw primary || backendErr;
  }
}

module.exports = {
  command: {
    pattern: "dl|socialdl|sdl",
    desc: getLang("plugins.socialdl.desc"),
    type: "downloader",
  },

  async execute(message, argsString) {
    const input = argsString || message.getQuotedText();

    if (!input) {
      return await message.reply(getLang("plugins.socialdl.usage", config.PREFIX));
    }

    const { url, audio } = parseInput(argsString, message.getQuotedText());
    if (!url) {
      return await message.reply(getLang("plugins.socialdl.invalid_url"));
    }

    const platform = detectPlatform(url, !!backendUrl());
    if (!platform) {
      return await message.reply(getLang("plugins.socialdl.unsupported"));
    }

    try {
      await message.react("⏳");
      await message.reply(getLang("plugins.socialdl.downloading", platform.label));

      const media = await fetchMedia(platform, url.href, audio);
      await sendMedia(message, media, getLang("plugins.socialdl.success", platform.label));
      await message.react("✅");
    } catch (err) {
      await message.react("❌");

      if (err?.code === "YTDLP_UNAVAILABLE" || err?.code === "YTDLP_UNSUPPORTED") {
        return await message.reply(getLang("plugins.socialdl.failed"));
      }

      const kind = classifyError(err, { userUrl: true });
      if (kind === "error") throw err;

      console.error("Social download error:", safeLog(err));
      await message.reply(getLang(replyKeyFor(kind), config.MAX_UPLOAD));
    }
  },

  // exposed for tests
  detectPlatform,
  parseInput,
  mediaKind,
};
