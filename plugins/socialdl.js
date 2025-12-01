const { getLang } = require("../lib/utils/language");
const axios = require("axios");
const cheerio = require("cheerio");
const config = require("../config");
const fs = require("fs").promises;
const path = require("path");

/**
 * Multi-Social Media Downloader Plugin
 * Download content from Instagram, YouTube, TikTok, Spotify, Facebook, Pinterest
 */

// User agents for requests
const USER_AGENTS = [
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getRandomIP() {
  const gen = () => Math.floor(Math.random() * 190) + 10;
  return `${gen()}.${gen()}.${gen()}.${gen()}`;
}

// Platform detection
function detectPlatform(url) {
  if (!url) return null;
  const lowerUrl = url.toLowerCase();

  if (
    lowerUrl.includes("instagram.com") ||
    lowerUrl.includes("instagr.am")
  ) {
    return "instagram";
  }
  if (
    lowerUrl.includes("youtube.com") ||
    lowerUrl.includes("youtu.be")
  ) {
    return "youtube";
  }
  if (
    lowerUrl.includes("tiktok.com") ||
    lowerUrl.includes("vm.tiktok.com")
  ) {
    return "tiktok";
  }
  if (
    lowerUrl.includes("spotify.com") ||
    lowerUrl.includes("open.spotify.com")
  ) {
    return "spotify";
  }
  if (
    lowerUrl.includes("facebook.com") ||
    lowerUrl.includes("fb.watch") ||
    lowerUrl.includes("fb.com")
  ) {
    return "facebook";
  }
  if (lowerUrl.includes("pinterest.com") || lowerUrl.includes("pin.it")) {
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

// Instagram Downloader
async function downloadInstagram(url) {
  try {
    const session = axios.create({
      headers: {
        "User-Agent": getRandomUserAgent(),
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      },
      timeout: 30000,
    });

    // Get session token
    const tokenResponse = await session.get("https://indown.io/reels");
    if (tokenResponse.status !== 200) {
      throw new Error("Failed to get session token");
    }

    const $ = cheerio.load(tokenResponse.data);
    const token = $('input[name="_token"]').val();

    if (!token) {
      throw new Error("Could not extract session token");
    }

    // Download request
    const downloadResponse = await session.post(
      "https://indown.io/download",
      new URLSearchParams({
        referer: "https://indown.io/reels",
        locale: "en",
        _token: token,
        link: url,
        p: "i",
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://indown.io/reels",
        },
        maxRedirects: 5,
      }
    );

    if (downloadResponse.status !== 200) {
      throw new Error("Download request failed");
    }

    const $dl = cheerio.load(downloadResponse.data);
    const videoSource = $dl("video.img-fluid source").attr("src");

    if (videoSource) {
      return { url: videoSource, type: "video" };
    }

    // Try to find image
    const imageUrl = $dl("a.download-button").attr("href");
    if (imageUrl) {
      return { url: imageUrl, type: "image" };
    }

    throw new Error("Could not extract media URL");
  } catch (error) {
    console.error("Instagram download error:", error.message);
    return null;
  }
}

// YouTube Downloader
async function downloadYoutube(url, type = "video", quality = "720p") {
  try {
    const session = axios.create({
      headers: {
        "User-Agent": getRandomUserAgent(),
        Accept: "*/*",
      },
      timeout: 30000,
    });

    // Get initial page
    const initResponse = await session.get("https://ytdown.to/en2/");
    if (initResponse.status !== 200) {
      return { status: "failed", reason: "Failed to initialize" };
    }

    // Request download
    const response = await session.post("https://ytdown.to/proxy.php", {
      url: url,
    });

    if (response.status !== 200) {
      return { status: "failed", reason: "Request failed" };
    }

    if (
      typeof response.data === "string" &&
      response.data.includes("Media unavailable")
    ) {
      return { status: "failed", reason: "The Link is unavailable" };
    }

    if (
      typeof response.data === "string" &&
      response.data.includes("Too many requests")
    ) {
      return { status: "failed", reason: "Too many requests" };
    }

    if (response.data && response.data.api && response.data.api.mediaItems) {
      const mediaItems = response.data.api.mediaItems;
      const isVideo = type.toLowerCase() === "video";
      const isAudio = type.toLowerCase() === "audio";

      for (const item of mediaItems) {
        if (item.type === "Video" && isVideo) {
          const validQualities = ["1080p", "720p", "480p", "360p", "240p"];
          if (!validQualities.includes(quality.toLowerCase())) {
            return {
              status: "failed",
              reason: "Invalid quality. Use: 1080p, 720p, 480p, 360p, 240p",
            };
          }
          if (
            item.mediaUrl &&
            item.mediaUrl.toLowerCase().includes(quality.toLowerCase())
          ) {
            return {
              status: "success",
              url: item.mediaUrl,
              type: "video",
              quality: quality,
            };
          }
        } else if (item.type === "Audio" && isAudio) {
          if (item.mediaUrl) {
            return {
              status: "success",
              url: item.mediaUrl,
              type: "audio",
            };
          }
        }
      }
    }

    return { status: "failed", reason: "Could not find media" };
  } catch (error) {
    console.error("YouTube download error:", error.message);
    return { status: "failed", reason: error.message };
  }
}

// TikTok Downloader
async function downloadTiktok(url) {
  try {
    const session = axios.create({
      headers: {
        "User-Agent": getRandomUserAgent(),
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      },
      timeout: 30000,
    });

    const randomIP = getRandomIP();

    // Get initial download URL
    const response = await session.post(
      "https://ssstik.io/abc",
      new URLSearchParams({
        id: url,
        locale: "en",
        tt: "cEd5alY4",
        debug: `ab=0&loc=USA&ip=${randomIP}`,
      }),
      {
        params: { url: "dl" },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    if (response.status !== 200) {
      throw new Error("Initial request failed");
    }

    const $ = cheerio.load(response.data);
    const hdDownloadUrl = $("#hd_download").attr("data-directurl");

    if (!hdDownloadUrl) {
      throw new Error("Could not find download URL");
    }

    // Get final URL
    const tt = new URLSearchParams(hdDownloadUrl.split("?")[1]).get("tt");
    const finalResponse = await session.post(
      `https://ssstik.io${hdDownloadUrl}`,
      new URLSearchParams({ tt: tt }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
      }
    );

    if (finalResponse.headers["hx-redirect"]) {
      let redirectUrl = finalResponse.headers["hx-redirect"];

      // Decode base64 if needed
      if (redirectUrl.includes("tikcdn.io/ssstik/")) {
        const base64Part = redirectUrl.replace(
          "https://tikcdn.io/ssstik/",
          ""
        );
        try {
          const decoded = Buffer.from(base64Part, "base64").toString("utf8");
          return { url: decoded, type: "video" };
        } catch {
          return { url: redirectUrl, type: "video" };
        }
      }

      return { url: redirectUrl, type: "video" };
    }

    throw new Error("Could not get final download URL");
  } catch (error) {
    console.error("TikTok download error:", error.message);
    return null;
  }
}

// Spotify Downloader
async function downloadSpotify(url) {
  try {
    const session = axios.create({
      headers: {
        "User-Agent": getRandomUserAgent(),
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      },
      timeout: 30000,
    });

    // Get CSRF token
    const tokenResponse = await session.get("https://spotmate.online/en1");
    if (tokenResponse.status !== 200) {
      throw new Error("Failed to get CSRF token");
    }

    const $ = cheerio.load(tokenResponse.data);
    const csrfToken = $('meta[name="csrf-token"]').attr("content");

    if (!csrfToken) {
      throw new Error("Could not extract CSRF token");
    }

    // Request conversion
    const convertResponse = await session.post(
      "https://spotmate.online/convert",
      { urls: url },
      {
        headers: {
          "X-Csrf-Token": csrfToken,
          "Content-Type": "application/json",
        },
      }
    );

    if (convertResponse.status === 200 && convertResponse.data.url) {
      return {
        url: convertResponse.data.url.replace(/\\/g, ""),
        type: "audio",
      };
    }

    throw new Error("Conversion failed");
  } catch (error) {
    console.error("Spotify download error:", error.message);
    return null;
  }
}

// Facebook Downloader
async function downloadFacebook(url) {
  try {
    const response = await axios.post(
      "https://fdown.net/download.php",
      new URLSearchParams({ URLz: url }),
      {
        headers: {
          "User-Agent": getRandomUserAgent(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 30000,
      }
    );

    if (response.status !== 200) {
      throw new Error("Request failed");
    }

    const $ = cheerio.load(response.data);
    const downloadUrl = $("a.btn.btn-primary.btn-sm").attr("href");

    if (downloadUrl) {
      return { url: downloadUrl, type: "video" };
    }

    throw new Error("Could not find download URL");
  } catch (error) {
    console.error("Facebook download error:", error.message);
    return null;
  }
}

// Pinterest Downloader
async function downloadPinterest(url) {
  try {
    const session = axios.create({
      headers: {
        "User-Agent": getRandomUserAgent(),
      },
      timeout: 30000,
    });

    // Get CSRF token
    const tokenResponse = await session.get(
      `https://klickpin.com/get-csrf-token.php?t=${Date.now()}`
    );

    if (
      tokenResponse.status !== 200 ||
      !tokenResponse.data ||
      !tokenResponse.data.csrf_token
    ) {
      throw new Error("Failed to get CSRF token");
    }

    const csrfToken = tokenResponse.data.csrf_token;

    // Request download
    const downloadResponse = await session.post(
      "https://klickpin.com/download",
      new URLSearchParams({
        url: url,
        csrf_token: csrfToken,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    if (downloadResponse.status !== 200) {
      throw new Error("Download request failed");
    }

    const $ = cheerio.load(downloadResponse.data);

    // Check for image
    const imageUrl = $("a.custom-button-style3").attr("href");
    if (imageUrl) {
      return { url: imageUrl, type: "image" };
    }

    // Check for video
    const videoUrl = $("video#myVideo").attr("src");
    if (videoUrl) {
      return { url: videoUrl, type: "video" };
    }

    throw new Error("Could not find media URL");
  } catch (error) {
    console.error("Pinterest download error:", error.message);
    return null;
  }
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
          let quality = "720p";
          ["1080p", "720p", "480p", "360p", "240p"].forEach((q) => {
            if (argsLower.includes(q)) quality = q;
          });
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
        headers: {
          "User-Agent": getRandomUserAgent(),
        },
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
