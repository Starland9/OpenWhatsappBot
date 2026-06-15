const { getLang } = require("../lib/utils/language");
const axios = require("axios");

/**
 * Instagram Downloader Plugin
 * Download Instagram posts, reels, and stories
 */

// Helper to extract URLs from text
function extractUrl(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const matches = text.match(urlRegex);
  return matches ? matches[0] : null;
}

// Helper to check if URL is Instagram
function isInstagramUrl(url) {
  return /instagram\.com\/(p|reel|tv|stories)\//.test(url);
}

module.exports = {
  command: {
    pattern: "insta",
    desc: "Download Instagram posts, reels, and stories",
    type: "downloader",
  },

  async execute(message, args) {
    const input = args || (message.quoted && message.body);

    if (!input) {
      return await message.reply(
        "*Please provide an Instagram URL!*\n\nExample: `.insta https://instagram.com/p/xxx`"
      );
    }

    const url = extractUrl(input);

    if (!url || !isInstagramUrl(url)) {
      return await message.reply(
        "*Invalid Instagram URL!*\n\nSupported: Posts, Reels, Stories"
      );
    }

    try {
      await message.react("⏳");

      // Try multiple APIs for better success rate
      let result = null;

      // Method 1: API from various free services
      try {
        const response = await axios.get(
          `https://api.instagramsave.com/v1/get.php?url=${encodeURIComponent(
            url
          )}`,
          { timeout: 15000 }
        );

        if (response.data && response.data.url) {
          result = { url: response.data.url, type: "video" };
        }
      } catch (e) {
        console.log("Method 1 failed, trying method 2");
      }

      // Method 2: Alternative API
      if (!result) {
        try {
          const response = await axios.post(
            "https://v3.igdownloader.app/api/ajaxSearch",
            new URLSearchParams({ q: url, t: "media", lang: "en" }),
            {
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
              },
              timeout: 15000,
            }
          );

          if (response.data && response.data.data) {
            // Parse HTML response to extract download link
            const downloadMatch = response.data.data.match(
              /href="([^"]+)"[^>]*>Download/i
            );
            if (downloadMatch) {
              result = { url: downloadMatch[1], type: "video" };
            }
          }
        } catch (e) {
          console.log("Method 2 failed");
        }
      }

      if (result && result.url) {
        await message.reply("*Downloading...*");

        // Download and send
        const mediaResponse = await axios.get(result.url, {
          responseType: "arraybuffer",
          timeout: 60000,
        });

        const buffer = Buffer.from(mediaResponse.data);

        // Determine if it's a video or image based on content type
        const contentType = mediaResponse.headers["content-type"];

        if (contentType.includes("video")) {
          await message.sendVideo(buffer, "*Instagram Video*");
        } else {
          await message.sendImage(buffer, "*Instagram Image*");
        }

        await message.react("✅");
      } else {
        await message.reply(
          "*Failed to download!*\n\nPossible reasons:\n• Private account\n• Invalid URL\n• Content not available\n\nPlease try again or use a different URL."
        );
        await message.react("❌");
      }
    } catch (error) {
      console.error("Instagram download error:", error);
      await message.reply(
        "*Download failed!*\n\nThe Instagram API might be temporarily unavailable. Please try again later."
      );
      await message.react("❌");
    }
  },
};
