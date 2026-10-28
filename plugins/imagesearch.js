const { getLang } = require("../lib/utils/language");
const config = require("../config");
const {
  fetchJson,
  fetchBuffer,
  classifyError,
  replyKeyFor,
  safeLog,
} = require("../lib/utils/http");

/**
 * Image & GIF search.
 *   .image / .img <query>   photo from Unsplash (UNSPLASH_API_KEY)
 *   .gif / .giphy <query>   GIF from Giphy (GIPHY_API_KEY), sent as a looping mp4
 */

const GIPHY_SEARCH_URL = "https://api.giphy.com/v1/gifs/search";
const UNSPLASH_SEARCH_URL = "https://api.unsplash.com/search/photos";

const GIF_COMMANDS = new Set(["gif", "giphy"]);
const MAX_QUERY_LENGTH = 100;
const MAX_GIF_QUERY_LENGTH = 50; // Giphy refuses longer queries

/** Media of the search results: never larger than 16 MB, whatever MAX_UPLOAD is (read per call, it is editable live) */
function mediaMaxBytes() {
  return Math.min(16, Number(config.MAX_UPLOAD) || 16) * 1024 * 1024;
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** https link on the given domain (or one of its subdomains), or null */
function trustedUrl(value, domain) {
  try {
    const url = new URL(String(value));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return null;
    return host === domain || host.endsWith(`.${domain}`) ? url.href : null;
  } catch (e) {
    return null;
  }
}

async function sendGif(message, query) {
  const data = await fetchJson(GIPHY_SEARCH_URL, {
    params: { api_key: config.GIPHY_API_KEY, q: query, limit: 10, rating: "g" },
    timeoutMs: 10000,
  });

  // Only results with an mp4 rendition: WhatsApp plays an mp4 with gifPlayback, a raw .gif it does not
  const results = (Array.isArray(data?.data) ? data.data : []).filter(
    (gif) => gif?.images?.original?.mp4 || gif?.images?.fixed_height?.mp4
  );

  if (results.length === 0) {
    await message.react("❌");
    return await message.reply(getLang("plugins.imagesearch.no_gifs"));
  }

  const images = pickRandom(results).images;
  // original first; a smaller rendition when the original is over the size cap
  const candidates = [images.original?.mp4, images.fixed_height?.mp4]
    .map((u) => trustedUrl(u, "giphy.com"))
    .filter((u, i, all) => u && all.indexOf(u) === i);

  let buffer = null;
  let lastError = null;
  for (const url of candidates) {
    try {
      ({ buffer } = await fetchBuffer(url, { maxBytes: mediaMaxBytes(), timeoutMs: 30000 }));
      break;
    } catch (err) {
      lastError = err;
      if (err?.code !== "MEDIA_TOO_LARGE") throw err;
    }
  }
  if (!buffer) {
    if (lastError) throw lastError;
    await message.react("❌");
    return await message.reply(getLang("plugins.imagesearch.no_gifs"));
  }

  await message.sendVideo(buffer, getLang("plugins.imagesearch.gif_caption", query), {
    gifPlayback: true,
    mimetype: "video/mp4",
  });
  await message.react("✅");
}

async function sendPhoto(message, query) {
  const data = await fetchJson(UNSPLASH_SEARCH_URL, {
    params: { query, per_page: 10, orientation: "landscape" },
    headers: { Authorization: `Client-ID ${config.UNSPLASH_API_KEY}` },
    timeoutMs: 10000,
  });

  const results = (Array.isArray(data?.results) ? data.results : []).filter((photo) =>
    trustedUrl(photo?.urls?.regular, "unsplash.com")
  );

  if (results.length === 0) {
    await message.react("❌");
    return await message.reply(getLang("plugins.imagesearch.no_images"));
  }

  const photo = pickRandom(results);
  const { buffer } = await fetchBuffer(trustedUrl(photo.urls.regular, "unsplash.com"), {
    maxBytes: mediaMaxBytes(),
    timeoutMs: 30000,
  });

  let caption = getLang("plugins.imagesearch.image_caption", query, photo.user?.name || "?");
  if (photo.alt_description) caption += `\n${photo.alt_description}`;

  await message.sendImage(buffer, caption);
  await message.react("✅");
}

module.exports = {
  mediaMaxBytes,

  command: {
    pattern: "image|img|gif|giphy",
    desc: getLang("plugins.imagesearch.desc"),
    type: "media",
  },

  async execute(message, argsString, ctx) {
    const isGif = GIF_COMMANDS.has(ctx?.command);
    const query = String(argsString || "")
      .trim()
      .slice(0, isGif ? MAX_GIF_QUERY_LENGTH : MAX_QUERY_LENGTH);

    if (!query) {
      return await message.reply(
        getLang(isGif ? "plugins.imagesearch.gif_usage" : "plugins.imagesearch.usage", config.PREFIX)
      );
    }

    const hasKey = !!(isGif ? config.GIPHY_API_KEY : config.UNSPLASH_API_KEY);
    if (!hasKey) {
      return await message.reply(getLang("common.not_configured"));
    }

    try {
      await message.react("⏳");
      if (isGif) await sendGif(message, query);
      else await sendPhoto(message, query);
    } catch (err) {
      await message.react("❌");

      let kind = classifyError(err, { hasKey, service: isGif ? "giphy" : "unsplash" });
      // Unsplash answers 403 "Rate Limit Exceeded" once the hourly quota is used
      if (kind === "service_unavailable" && /rate limit/i.test(String(err?.response?.data))) {
        kind = "rate_limited";
      }
      if (kind === "error") throw err;

      console.error("Image/GIF search error:", safeLog(err));
      await message.reply(getLang(replyKeyFor(kind), config.MAX_UPLOAD));
    }
  },
};
