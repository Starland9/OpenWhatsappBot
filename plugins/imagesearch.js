const { getLang } = require("../lib/utils/language");
const axios = require("axios");
const config = require("../config");

/**
 * Image & GIF Search Plugin - Search and send images/GIFs
 */
module.exports = {
  command: {
    pattern: "image|img|gif|giphy",
    desc: getLang("plugins.imagesearch.desc"),
    type: "media",
  },

  async execute(message, query) {
    const command = message.body
      .split(" ")[0]
      .replace(config.PREFIX, "")
      .trim()
      .toLowerCase();
    const isGif = command === "gif" || command === "giphy";

    if (!query) {
      return await message.reply(
        isGif
          ? getLang("plugins.imagesearch.gif_usage")
          : getLang("plugins.imagesearch.usage")
      );
    }

    try {
      await message.react("⏳");

      if (isGif) {
        // Search GIF using Giphy
        const GIPHY_API_KEY =
          config.GIPHY_API_KEY || process.env.GIPHY_API_KEY || "dc6zaTOxFJmzC"; // Public beta key

        const response = await axios.get(
          "https://api.giphy.com/v1/gifs/search",
          {
            params: {
              api_key: GIPHY_API_KEY,
              q: query,
              limit: 5,
              rating: "g",
            },
            timeout: 10000,
          }
        );

        if (!response.data.data || response.data.data.length === 0) {
          await message.react("❌");
          return await message.reply(
            `❌ ${getLang("plugins.imagesearch.no_gifs")}`
          );
        }

        // Get random GIF from results
        const randomGif =
          response.data.data[
            Math.floor(Math.random() * response.data.data.length)
          ];
        const gifUrl = randomGif.images.original.url;

        // Download GIF
        const gifResponse = await axios.get(gifUrl, {
          responseType: "arraybuffer",
          timeout: 30000,
        });
        const gifBuffer = Buffer.from(gifResponse.data);

        await message.react("✅");
        await message.sendVideo(gifBuffer, `🎬 *${query}*\n\n_via Giphy_`, {
          gifPlayback: true,
        });
      } else {
        // Search Image using Unsplash
        const UNSPLASH_ACCESS_KEY =
          config.UNSPLASH_API_KEY || process.env.UNSPLASH_API_KEY;

        if (!UNSPLASH_ACCESS_KEY) {
          return await message.reply(
            `❌ ${getLang("plugins.imagesearch.no_api_key")}`
          );
        }

        const response = await axios.get(
          "https://api.unsplash.com/search/photos",
          {
            params: {
              query: query,
              per_page: 10,
              orientation: "landscape",
            },
            headers: {
              Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}`,
            },
            timeout: 10000,
          }
        );

        if (!response.data.results || response.data.results.length === 0) {
          await message.react("❌");
          return await message.reply(
            `❌ ${getLang("plugins.imagesearch.no_images")}`
          );
        }

        // Get random image from results
        const randomImage =
          response.data.results[
            Math.floor(Math.random() * response.data.results.length)
          ];
        const imageUrl = randomImage.urls.regular;

        // Download image
        const imageResponse = await axios.get(imageUrl, {
          responseType: "arraybuffer",
          timeout: 30000,
        });
        const imageBuffer = Buffer.from(imageResponse.data);

        const caption =
          `📸 *${query}*\n\n` +
          `📷 _Photo by ${randomImage.user.name} on Unsplash_\n` +
          `${randomImage.alt_description || ""}`;

        await message.react("✅");
        await message.sendImage(imageBuffer, caption);
      }
    } catch (error) {
      await message.react("❌");
      console.error("Image/GIF search error:", error);

      if (error.response && error.response.status === 401) {
        await message.reply(
          `❌ ${getLang("plugins.imagesearch.invalid_api_key")}`
        );
      } else {
        await message.reply(
          `❌ ${getLang("plugins.imagesearch.error")}: ${error.message}`
        );
      }
    }
  },
};
