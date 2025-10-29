const { getLang } = require("../lib/utils/language");
const axios = require("axios");
const config = require("../config");

/**
 * Music Search Plugin - Search music on Spotify/YouTube
 */
module.exports = {
  command: {
    pattern: "music|song|spotify|lyrics",
    desc: getLang("plugins.music.desc"),
    type: "media",
  },

  async execute(message, query) {
    const command = message.body.split(" ")[0].replace(config.PREFIX, "").toLowerCase();

    if (!query) {
      return await message.reply(getLang("plugins.music.usage"));
    }

    try {
      await message.react("⏳");

      if (command === "spotify") {
        await handleSpotify(message, query);
      } else if (command === "lyrics") {
        await handleLyrics(message, query);
      } else {
        // Default to music search
        await handleMusicSearch(message, query);
      }

    } catch (error) {
      await message.react("❌");
      console.error("Music search error:", error);
      await message.reply(`❌ ${getLang("plugins.music.error")}: ${error.message}`);
    }
  },
};

async function handleMusicSearch(message, query) {
  // Search using iTunes API (free, no key required)
  const response = await axios.get("https://itunes.apple.com/search", {
    params: {
      term: query,
      media: "music",
      entity: "song",
      limit: 5,
    },
    timeout: 10000,
  });

  if (!response.data.results || response.data.results.length === 0) {
    await message.react("❌");
    return await message.reply(`❌ ${getLang("plugins.music.no_results")}`);
  }

  let musicText = `🎵 *${getLang("plugins.music.search_results")}*\n\n`;
  musicText += `🔍 _${query}_\n\n`;

  response.data.results.slice(0, 5).forEach((track, index) => {
    musicText += `${index + 1}. *${track.trackName}*\n`;
    musicText += `   🎤 ${track.artistName}\n`;
    musicText += `   💿 ${track.collectionName}\n`;
    if (track.previewUrl) {
      musicText += `   🎧 ${track.previewUrl}\n`;
    }
    musicText += `\n`;
  });

  await message.react("✅");
  await message.reply(musicText);
}

async function handleSpotify(message, query) {
  const SPOTIFY_CLIENT_ID = config.SPOTIFY_CLIENT_ID || process.env.SPOTIFY_CLIENT_ID;
  const SPOTIFY_CLIENT_SECRET = config.SPOTIFY_CLIENT_SECRET || process.env.SPOTIFY_CLIENT_SECRET;

  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    return await message.reply(`❌ ${getLang("plugins.music.no_spotify_api")}`);
  }

  // Get Spotify access token
  const authResponse = await axios.post(
    "https://accounts.spotify.com/api/token",
    "grant_type=client_credentials",
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
      },
    }
  );

  const accessToken = authResponse.data.access_token;

  // Search for tracks
  const searchResponse = await axios.get("https://api.spotify.com/v1/search", {
    params: {
      q: query,
      type: "track",
      limit: 5,
    },
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!searchResponse.data.tracks.items || searchResponse.data.tracks.items.length === 0) {
    await message.react("❌");
    return await message.reply(`❌ ${getLang("plugins.music.no_results")}`);
  }

  let spotifyText = `🎵 *Spotify ${getLang("plugins.music.search_results")}*\n\n`;

  searchResponse.data.tracks.items.forEach((track, index) => {
    spotifyText += `${index + 1}. *${track.name}*\n`;
    spotifyText += `   🎤 ${track.artists.map(a => a.name).join(", ")}\n`;
    spotifyText += `   💿 ${track.album.name}\n`;
    spotifyText += `   🔗 ${track.external_urls.spotify}\n\n`;
  });

  await message.react("✅");
  await message.reply(spotifyText);
}

async function handleLyrics(message, query) {
  // Use lyrics.ovh API (free, no key required)
  const [artist, ...songParts] = query.split("-");
  const song = songParts.join("-").trim();

  if (!artist || !song) {
    return await message.reply(getLang("plugins.music.lyrics_format"));
  }

  const response = await axios.get(
    `https://api.lyrics.ovh/v1/${encodeURIComponent(artist.trim())}/${encodeURIComponent(song)}`,
    { timeout: 15000 }
  );

  if (!response.data.lyrics) {
    await message.react("❌");
    return await message.reply(`❌ ${getLang("plugins.music.no_lyrics")}`);
  }

  let lyrics = response.data.lyrics;

  // Limit to first 2000 characters for WhatsApp
  if (lyrics.length > 2000) {
    lyrics = lyrics.substring(0, 2000) + "\n\n... _" + getLang("plugins.music.lyrics_truncated") + "_";
  }

  const lyricsText = `🎵 *${getLang("plugins.music.lyrics_title")}*\n\n` +
    `🎤 *${getLang("plugins.music.artist")}:* ${artist.trim()}\n` +
    `🎵 *${getLang("plugins.music.song")}:* ${song}\n\n` +
    `${lyrics}`;

  await message.react("✅");
  await message.reply(lyricsText);
}
