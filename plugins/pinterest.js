const { getLang } = require("../lib/utils/language");
const axios = require("axios");

/**
 * Pinterest Plugin
 * Download and search Pinterest images
 */

module.exports = {
  command: {
    pattern: "pinterest",
    desc: "Search Pinterest images",
    type: "search",
  },

  async execute(message, args) {
    if (!args) {
      return await message.reply(
        "*Please provide a search query!*\n\nExample: `.pinterest cats`"
      );
    }

    try {
      await message.react("🔍");

      // Search Pinterest images
      const response = await axios.get(
        `https://www.pinterest.com/resource/BaseSearchResource/get/`,
        {
          params: {
            source_url: "/search/pins/?q=" + encodeURIComponent(args),
            data: JSON.stringify({
              options: {
                isPrefetch: false,
                query: args,
                scope: "pins",
                no_fetch_context_on_resource: false,
              },
              context: {},
            }),
          },
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
        }
      );

      if (
        response.data &&
        response.data.resource_response &&
        response.data.resource_response.data &&
        response.data.resource_response.data.results
      ) {
        const results = response.data.resource_response.data.results;

        if (results.length === 0) {
          return await message.reply("*No results found!*");
        }

        // Get first 10 results
        const images = results.slice(0, 10);
        let sent = 0;

        await message.reply(
          `*🔍 Found ${images.length} images*\n\nSending first 5 images...`
        );

        for (let i = 0; i < Math.min(5, images.length); i++) {
          const pin = images[i];
          const imageUrl = pin.images?.orig?.url || pin.images?.["736x"]?.url;

          if (imageUrl) {
            try {
              const imgResponse = await axios.get(imageUrl, {
                responseType: "arraybuffer",
                timeout: 15000,
              });

              const buffer = Buffer.from(imgResponse.data);
              await message.sendImage(
                buffer,
                pin.title || pin.description || "*Pinterest Image*"
              );
              sent++;
            } catch (err) {
              console.log(`Failed to send image ${i + 1}`);
            }
          }
        }

        if (sent > 0) {
          await message.react("✅");
        } else {
          await message.reply("*Failed to download images!*");
          await message.react("❌");
        }
      } else {
        await message.reply("*No results found!*");
        await message.react("❌");
      }
    } catch (error) {
      console.error("Pinterest search error:", error);
      await message.reply(
        "*Search failed!*\n\nPlease try again with a different query."
      );
      await message.react("❌");
    }
  },
};
