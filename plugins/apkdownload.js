const { getLang } = require("../lib/utils/language");
const config = require("../config");
const {
  fetchJson,
  fetchBuffer,
  replyKeyForError,
  safeLog,
} = require("../lib/utils/http");
const { createStore } = require("../lib/utils/gameStore");
const cooldown = require("../lib/utils/cooldown");

/**
 * APK Downloader Plugin (Aptoide)
 *
 *   .apk <name>      lists the top results (nothing is downloaded)
 *   .apk dl <n>      downloads result n of your last search in this chat
 *   .apk get <n>     same as dl
 */

const SEARCH_URL = "https://ws75.aptoide.com/api/7/apps/search";
const MAX_RESULTS = 5;
const MAX_QUERY_LENGTH = 100;
const MB = 1024 * 1024;
const MAX_APK_BYTES = 100 * MB;
const DOWNLOAD_COOLDOWN_MS = 20 * 1000;
const SEARCH_COOLDOWN_MS = 3 * 1000;

// Last search of each user in each chat (10 minutes of inactivity)
const lastSearches = createStore("apk", { ttlMs: 10 * 60 * 1000 });
const searchKey = (message) => `${message.jid}|${message.sender}`;

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** Size cap of a download: 100 MB, or MAX_UPLOAD when lower */
function maxApkBytes() {
  const uploadCap = (config.MAX_UPLOAD || 230) * MB;
  return Math.min(MAX_APK_BYTES, uploadCap);
}

/** Only Aptoide's own https hosts are downloaded from */
function isAptoideUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "aptoide.com" || url.hostname.endsWith(".aptoide.com"))
    );
  } catch (_) {
    return false;
  }
}

/** Keep what we need from an Aptoide result */
function toResult(app) {
  const file = app.file || {};
  return {
    name: String(app.name || app.package || "app"),
    pkg: app.package || "",
    version: file.vername || "",
    size: Number(file.filesize || app.size) || 0,
    rating: Number(app.stats?.prating?.avg || app.stats?.rating?.avg) || 0,
    downloads: Number(app.stats?.pdownloads || app.stats?.downloads) || 0,
    trust: file.malware?.rank || "",
    url: file.path || file.path_alt || "",
  };
}

async function search(query) {
  const data = await fetchJson(
    `${SEARCH_URL}/query=${encodeURIComponent(query)}/limit=10`,
    { headers: { "User-Agent": "Aptoide/9.20.0.0" }, timeoutMs: 15000 },
  );
  const list = data?.datalist?.list;
  if (!Array.isArray(list)) return [];
  return list
    .map(toResult)
    .filter((app) => isAptoideUrl(app.url))
    .slice(0, MAX_RESULTS);
}

function formatResults(query, results) {
  const lines = results.map((app, i) => {
    const stats = [
      app.rating ? `⭐ ${app.rating.toFixed(1)}` : "",
      app.downloads ? `⬇️ ${compact.format(app.downloads)}` : "",
      app.size ? `📏 ${(app.size / MB).toFixed(1)} MB` : "",
      app.trust ? `🛡️ ${app.trust}` : "",
    ].filter(Boolean);
    return (
      `*${i + 1}. ${app.name}*${app.version ? ` v${app.version}` : ""}\n` +
      `📦 ${app.pkg || "-"}` +
      (stats.length ? `\n${stats.join("  ")}` : "")
    );
  });
  return (
    `${getLang("plugins.apk.results_title", query)}\n\n` +
    `${lines.join("\n\n")}\n\n` +
    getLang("plugins.apk.results_hint", config.PREFIX)
  );
}

function safeFileName(app) {
  const base = `${app.name}${app.version ? `-${app.version}` : ""}`
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return `${base || "app"}.apk`;
}

/** Reply with the message matching a failed external call */
async function replyFailure(message, err) {
  console.error("apk:", safeLog(err));
  const key = replyKeyForError(err);
  await message.react("❌");
  await message.reply(
    key === "common.media_too_large"
      ? getLang(key, Math.floor(maxApkBytes() / MB))
      : getLang(key),
  );
}

async function runSearch(message, query) {
  if (query.length > MAX_QUERY_LENGTH) {
    return await message.reply(getLang("plugins.apk.query_too_long", MAX_QUERY_LENGTH));
  }
  const wait = cooldown.hit(message.sender, "apk-search", SEARCH_COOLDOWN_MS);
  if (wait) {
    return await message.reply(getLang("common.cooldown", Math.ceil(wait / 1000)));
  }

  await message.react("🔍");
  let results;
  try {
    results = await search(query);
  } catch (err) {
    return await replyFailure(message, err);
  }

  if (results.length === 0) {
    await message.react("❌");
    return await message.reply(getLang("plugins.apk.no_results", query));
  }

  const key = searchKey(message);
  lastSearches.end(key);
  lastSearches.start(key, { query, results });
  await message.reply(formatResults(query, results));
  await message.react("✅");
}

async function runDownload(message, index) {
  const stored = lastSearches.get(searchKey(message));
  if (!stored) {
    return await message.reply(getLang("plugins.apk.no_search", config.PREFIX));
  }
  const app = stored.results[index - 1];
  if (!app) {
    return await message.reply(
      getLang("plugins.apk.bad_number", stored.results.length),
    );
  }

  const maxBytes = maxApkBytes();
  if (app.size > maxBytes) {
    return await message.reply(
      getLang("common.media_too_large", Math.floor(maxBytes / MB)),
    );
  }
  const wait = cooldown.hit(message.sender, "apk-dl", DOWNLOAD_COOLDOWN_MS);
  if (wait) {
    return await message.reply(getLang("common.cooldown", Math.ceil(wait / 1000)));
  }

  lastSearches.touch(searchKey(message));
  await message.react("⏳");
  try {
    const { buffer } = await fetchBuffer(app.url, {
      maxBytes,
      timeoutMs: config.DOWNLOAD_TIMEOUT || 180000,
    });
    await message.sendDocument(buffer, {
      fileName: safeFileName(app),
      mimetype: "application/vnd.android.package-archive",
      caption: getLang("plugins.apk.caption", app.name, app.version || "-", app.pkg || "-"),
    });
    await message.react("✅");
  } catch (err) {
    await replyFailure(message, err);
  }
}

module.exports = {
  command: {
    pattern: "apk",
    desc: getLang("plugins.apk.desc"),
    type: "downloader",
  },

  async execute(message, args) {
    const query = (args || "").trim();
    if (!query) {
      return await message.reply(getLang("plugins.apk.usage", config.PREFIX));
    }

    // ".apk dl <n>" downloads; ".apk dl" alone shows the usage; ".apk get contact" is a search
    const words = query.split(" ");
    if (["dl", "get"].includes(words[0].toLowerCase())) {
      if (words.length === 1) {
        return await message.reply(getLang("plugins.apk.usage", config.PREFIX));
      }
      if (words.length === 2 && /^\d{1,2}$/.test(words[1])) {
        const index = parseInt(words[1], 10);
        if (index < 1) {
          return await message.reply(getLang("plugins.apk.usage", config.PREFIX));
        }
        return await runDownload(message, index);
      }
    }

    return await runSearch(message, query);
  },
};
