const { getLang } = require("../lib/utils/language");
const axios = require("axios");
const config = require("../config");

/**
 * Multi-Social Media Downloader Plugin
 * Download content from Instagram, YouTube, TikTok, Spotify, Facebook, Pinterest
 * Uses a backend proxy API for reliable downloads
 */

const BACKEND_URL = config.BACKEND_URL || "https://api.socialdl.starland9.dev";

// Platform detection using proper URL parsing
function detectPlatform(url) {
  if (!url) return null;

  let hostname;
  try {
    const parsedUrl = new URL(url);
    hostname = parsedUrl.hostname.toLowerCase();
  } catch {
    return null;
  }

  // Check Instagram
  if (
    hostname === "instagram.com" ||
    hostname === "www.instagram.com" ||
    hostname === "instagr.am" ||
    hostname === "www.instagr.am"
  ) {
    return "instagram";
  }

  // Check YouTube
  if (
    hostname === "youtube.com" ||
    hostname === "www.youtube.com" ||
    hostname === "m.youtube.com" ||
    hostname === "youtu.be"
  ) {
    return "youtube";
  }

  // Check TikTok
  if (
    hostname === "tiktok.com" ||
    hostname === "www.tiktok.com" ||
    hostname === "vm.tiktok.com" ||
    hostname === "m.tiktok.com"
  ) {
    return "tiktok";
  }

  // Check Spotify
  if (
    hostname === "spotify.com" ||
    hostname === "open.spotify.com" ||
    hostname === "www.spotify.com"
  ) {
    return "spotify";
  }

  // Check Facebook
  if (
    hostname === "facebook.com" ||
    hostname === "www.facebook.com" ||
    hostname === "m.facebook.com" ||
    hostname === "fb.watch" ||
    hostname === "fb.com" ||
    hostname === "www.fb.com"
  ) {
    return "facebook";
  }

  // Check Pinterest
  if (
    hostname === "pinterest.com" ||
    hostname === "www.pinterest.com" ||
    hostname === "pin.it"
  ) {
    return "pinterest";
  }

  return null;
}

// Extract URL from text
function extractUrl(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const matches = text.match(urlRegex);
  return matches ? matches[0] : null;
}

// Generic proxy POST function
async function proxyPost(path, body) {
  try {
    const url = `${BACKEND_URL}${path}`;
    const resp = await axios.post(url, body, { timeout: 30000 });
    return resp.data;
  } catch (err) {
    if (err.response) {
      return err.response.data || { status: "failed", reason: "backend error" };
    }
    return { status: "failed", reason: err.message || "internal error" };
  }
}

// Instagram Downloader via proxy
async function downloadInstagram(url) {
  const result = await proxyPost("/insta", { url });
  if (result.status === "failed") {
    return null;
  }
  return result;
}

// YouTube Downloader via proxy
async function downloadYoutube(url, type = "video", quality = "720p") {
  const result = await proxyPost("/yt", { url, type, quality });
  return result;
}

// TikTok Downloader via proxy
async function downloadTiktok(url) {
  const result = await proxyPost("/tiktok", { url });
  if (result.status === "failed") {
    return null;
  }
  return result;
}

// Spotify Downloader via proxy
async function downloadSpotify(url) {
  const result = await proxyPost("/spotify", { url });
  if (result.status === "failed") {
    return null;
  }
  return result;
}

// Facebook Downloader via proxy
async function downloadFacebook(url) {
  const result = await proxyPost("/facebook", { url });
  if (result.status === "failed") {
    return null;
  }
  return result;
}

// Pinterest Downloader via proxy
async function downloadPinterest(url) {
  const result = await proxyPost("/pinterest", { url });
  if (result.status === "failed") {
    return null;
  }
  return result;
}

// Main plugin export
module.exports = {
  command: {
    pattern: "dl|socialdl|sdl",
    desc: getLang("plugins.socialdl.desc"),
    type: "downloader",
  },

  async execute(message, args) {
    const input = args || (message.quoted && message.body);

    if (!input) {
      return await message.reply(getLang("plugins.socialdl.usage"));
    }

    const url = extractUrl(input);

    if (!url) {
      return await message.reply(getLang("plugins.socialdl.invalid_url"));
    }

    const platform = detectPlatform(url);

    if (!platform) {
      return await message.reply(getLang("plugins.socialdl.unsupported"));
    }

    try {
      await message.react("⏳");
      await message.reply(
        getLang("plugins.socialdl.downloading").replace("{0}", platform)
      );

      let result = null;

      switch (platform) {
        case "instagram":
          result = await downloadInstagram(url);
          break;
        case "youtube":
          // Parse options from args (e.g., "url audio" or "url 720p")
          const argsLower = input.toLowerCase();
          const isAudio = argsLower.includes("audio");
          // Find quality - prioritize higher quality (first in the list that matches)
          let quality = "720p";
          const qualities = ["1080p", "720p", "480p", "360p", "240p"];
          for (const q of qualities) {
            if (argsLower.includes(q)) {
              quality = q;
              break;
            }
          }
          result = await downloadYoutube(
            url,
            isAudio ? "audio" : "video",
            quality
          );
          if (result && result.status === "failed") {
            await message.react("❌");
            return await message.reply(`❌ ${result.reason}`);
          }
          if (result && result.status === "success") {
            result = { url: result.url, type: result.type };
          }
          break;
        case "tiktok":
          result = await downloadTiktok(url);
          break;
        case "spotify":
          result = await downloadSpotify(url);
          break;
        case "facebook":
          result = await downloadFacebook(url);
          break;
        case "pinterest":
          result = await downloadPinterest(url);
          break;
      }

      if (!result || !result.url) {
        await message.react("❌");
        return await message.reply(getLang("plugins.socialdl.failed"));
      }

      // Download the media
      const mediaResponse = await axios.get(result.url, {
        responseType: "arraybuffer",
        timeout: 120000,
        maxContentLength: 100 * 1024 * 1024, // 100MB max
      });

      const buffer = Buffer.from(mediaResponse.data);

      // Determine content type
      const contentType = mediaResponse.headers["content-type"] || "";

      const caption = getLang("plugins.socialdl.success").replace(
        "{0}",
        platform.charAt(0).toUpperCase() + platform.slice(1)
      );

      if (result.type === "audio" || contentType.includes("audio")) {
        await message.sendAudio(buffer, {
          mimetype: "audio/mp4",
        });
      } else if (result.type === "video" || contentType.includes("video")) {
        await message.sendVideo(buffer, caption);
      } else if (result.type === "image" || contentType.includes("image")) {
        await message.sendImage(buffer, caption);
      } else {
        // Default to video
        await message.sendVideo(buffer, caption);
      }

      await message.react("✅");
    } catch (error) {
      console.error("Social download error:", error);
      await message.react("❌");
      await message.reply(
        getLang("plugins.socialdl.error").replace("{0}", error.message)
      );
    }
  },
};
