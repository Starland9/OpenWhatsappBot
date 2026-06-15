const { getLang } = require("../lib/utils/language");
const axios = require("axios");

/**
 * APK Downloader Plugin
 * Download Android APK files from Aptoide
 */

module.exports = {
  command: {
    pattern: "apk",
    desc: "Download APK from Aptoide",
    type: "downloader",
  },

  async execute(message, args) {
    if (!args) {
      return await message.reply(
        "*APK Downloader*\n\n*Usage:* .apk <app name>\n\n*Example:* .apk whatsapp\n\nSearches and downloads Android apps from Aptoide."
      );
    }

    try {
      await message.react("🔍");

      // Search for APK using a public API
      // Note: This is a simplified version. In production, you'd want a reliable API
      const searchQuery = encodeURIComponent(args);

      await message.reply(`*Searching for: ${args}*\n\nPlease wait...`);

      // Using APKPure or Aptoide API alternative
      const searchUrl = `https://ws75.aptoide.com/api/7/apps/search/query=${searchQuery}/limit=10`;

      const response = await axios.get(searchUrl, {
        headers: {
          "User-Agent": "Aptoide/9.20.0.0",
        },
        timeout: 15000,
      });

      if (
        response.data &&
        response.data.datalist &&
        response.data.datalist.list &&
        response.data.datalist.list.length > 0
      ) {
        const apps = response.data.datalist.list.slice(0, 5);

        let resultMsg = `*📱 APK Search Results*\n\n`;

        apps.forEach((app, index) => {
          resultMsg += `*${index + 1}. ${app.name}*\n`;
          resultMsg += `📦 Package: ${app.package || "N/A"}\n`;
          resultMsg += `⭐ Rating: ${app.stats?.rating?.avg || "N/A"}\n`;
          resultMsg += `⬇️ Downloads: ${app.stats?.downloads || "N/A"}\n`;
          resultMsg += `📏 Size: ${
            app.size ? (app.size / 1024 / 1024).toFixed(2) + " MB" : "N/A"
          }\n\n`;
        });

        resultMsg += `\n*Note:* Direct APK download requires API key.\n*Alternative:* Download manually from Aptoide store.`;

        await message.reply(resultMsg);
        await message.react("✅");

        // Send first app details with download link if available
        const firstApp = apps[0];
        if (firstApp.file && firstApp.file.path) {
          try {
            await message.reply(
              `*Downloading: ${firstApp.name}*\n\nPlease wait, this may take a moment...`
            );

            const apkResponse = await axios.get(firstApp.file.path, {
              responseType: "arraybuffer",
              timeout: 120000, // 2 minutes for large files
              maxContentLength: 100 * 1024 * 1024, // 100MB max
            });

            const buffer = Buffer.from(apkResponse.data);

            await message.sendDocument(buffer, {
              fileName: `${firstApp.name}.apk`,
              mimetype: "application/vnd.android.package-archive",
              caption: `*${firstApp.name}*\n\n⚠️ Install at your own risk\n📦 Source: Aptoide`,
            });

            await message.react("✅");
          } catch (downloadError) {
            console.error("APK download error:", downloadError);
            await message.reply(
              `*Download failed!*\n\nThe APK might be too large or unavailable.\n\n*Alternative:* Visit https://en.aptoide.com/search?query=${searchQuery}`
            );
          }
        }
      } else {
        await message.reply(
          `*No results found for: ${args}*\n\nTry:\n• Different app name\n• Simpler search terms\n• Official app name`
        );
        await message.react("❌");
      }
    } catch (error) {
      console.error("APK search error:", error);
      await message.reply(
        `*Search failed!*\n\n*Alternative:* Visit https://www.aptoide.com and search for "${args}"`
      );
      await message.react("❌");
    }
  },
};
