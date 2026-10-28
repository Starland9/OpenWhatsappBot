const { getLang } = require("../lib/utils/language");
const config = require("../config");
const settingsStore = require("../lib/utils/settingsStore");
const {
  fetchJson,
  fetchBuffer,
  classifyError,
  replyKeyFor,
  safeLog,
} = require("../lib/utils/http");

/**
 * Music plugin: track search (iTunes), Spotify search (needs keys) and
 * .play, which sends the 30 second preview iTunes provides.
 * Lyrics live in plugins/lyrics.js.
 */

const ITUNES_URL = "https://itunes.apple.com/search";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_SEARCH_URL = "https://api.spotify.com/v1/search";

const SEARCH_LIMIT = 5;
// A preview is about 1 MB; anything much bigger is not a preview
const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

let spotifyToken = null; // { value, expiresAt }

// New credentials from the panel: the cached token belongs to the old ones
settingsStore.onChange(["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"], () => {
  spotifyToken = null;
});

function hasSpotifyKeys() {
  return !!(config.SPOTIFY_CLIENT_ID && config.SPOTIFY_CLIENT_SECRET);
}

async function getSpotifyToken() {
  if (spotifyToken && spotifyToken.expiresAt > Date.now() + 30000) return spotifyToken.value;

  const credentials = Buffer.from(
    `${config.SPOTIFY_CLIENT_ID}:${config.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  const auth = await fetchJson(SPOTIFY_TOKEN_URL, {
    method: "POST",
    data: "grant_type=client_credentials",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    timeoutMs: 15000,
  });

  if (!auth || !auth.access_token) {
    const err = new Error("Spotify returned no access token");
    err.code = "ERR_BAD_RESPONSE_FORMAT";
    throw err;
  }

  spotifyToken = {
    value: auth.access_token,
    expiresAt: Date.now() + (Number(auth.expires_in) || 3600) * 1000,
  };
  return spotifyToken.value;
}

/** One line per known field: a missing artist or album is skipped, never "undefined" */
function trackLines(name, artist, album, prefix = "🎵 ") {
  const lines = [`${prefix}*${name || getLang("plugins.music.unknown_track")}*`];
  if (artist) lines.push(`   🎤 ${artist}`);
  if (album) lines.push(`   💿 ${album}`);
  return lines;
}

async function searchItunes(term, limit) {
  const data = await fetchJson(ITUNES_URL, {
    params: { term, media: "music", entity: "song", limit },
    timeoutMs: 10000,
  });
  return Array.isArray(data?.results) ? data.results : [];
}

async function handleMusicSearch(message, query) {
  const results = await searchItunes(query, SEARCH_LIMIT);

  if (results.length === 0) {
    await message.react("❌");
    return await message.reply(getLang("plugins.music.no_results"));
  }

  let text = `${getLang("plugins.music.search_results")}\n\n🔍 _${query}_\n\n`;
  results.slice(0, SEARCH_LIMIT).forEach((track, index) => {
    const lines = trackLines(track.trackName, track.artistName, track.collectionName, `${index + 1}. `);
    if (track.previewUrl) lines.push(`   🎧 ${track.previewUrl}`);
    text += `${lines.join("\n")}\n\n`;
  });

  await message.reply(text.trimEnd());
  await message.react("✅");
}

async function handleSpotify(message, query) {
  if (!hasSpotifyKeys()) {
    await message.react("❌");
    return await message.reply(getLang("common.not_configured"));
  }

  const token = await getSpotifyToken();
  const data = await fetchJson(SPOTIFY_SEARCH_URL, {
    params: { q: query, type: "track", limit: SEARCH_LIMIT },
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 10000,
  });

  const items = Array.isArray(data?.tracks?.items) ? data.tracks.items : [];
  if (items.length === 0) {
    await message.react("❌");
    return await message.reply(getLang("plugins.music.no_results"));
  }

  let text = `${getLang("plugins.music.spotify_results")}\n\n`;
  items.forEach((track, index) => {
    const artists = (track.artists || []).map((a) => a?.name).filter(Boolean).join(", ");
    const lines = trackLines(track.name, artists, track.album?.name, `${index + 1}. `);
    if (track.external_urls?.spotify) lines.push(`   🔗 ${track.external_urls.spotify}`);
    text += `${lines.join("\n")}\n\n`;
  });

  await message.reply(text.trimEnd());
  await message.react("✅");
}

async function handlePlay(message, query) {
  const results = await searchItunes(query, SEARCH_LIMIT);

  if (results.length === 0) {
    await message.react("❌");
    return await message.reply(getLang("plugins.music.no_results"));
  }

  const track = results.find((t) => t.previewUrl);
  if (!track) {
    await message.react("❌");
    return await message.reply(getLang("plugins.music.no_preview"));
  }

  await message.reply(
    `${getLang("plugins.music.downloading")}\n\n${trackLines(
      track.trackName,
      track.artistName,
      track.collectionName
    ).join("\n")}`
  );

  // In memory: no temp file to clean up
  const { buffer } = await fetchBuffer(track.previewUrl, {
    maxBytes: PREVIEW_MAX_BYTES,
    timeoutMs: 30000,
  });

  await message.sendAudioFile(buffer);
  await message.react("✅");
}

module.exports = {
  command: {
    pattern: "music|song|spotify|play",
    desc: getLang("plugins.music.desc"),
    type: "media",
  },

  async execute(message, query, ctx) {
    const command = ctx?.command || "music";

    if (!query) {
      return await message.reply(getLang("plugins.music.usage", config.PREFIX));
    }

    try {
      await message.react("⏳");

      if (command === "spotify") {
        await handleSpotify(message, query);
      } else if (command === "play") {
        await handlePlay(message, query);
      } else {
        await handleMusicSearch(message, query);
      }
    } catch (err) {
      await message.react("❌");
      // the cached token may have expired early
      if (err?.response?.status === 401) spotifyToken = null;

      const kind = classifyError(err, {
        hasKey: command === "spotify" ? hasSpotifyKeys() : undefined,
      });
      if (kind === "error") throw err;

      console.error("Music error:", safeLog(err));
      await message.reply(getLang(replyKeyFor(kind), config.MAX_UPLOAD));
    }
  },
};
