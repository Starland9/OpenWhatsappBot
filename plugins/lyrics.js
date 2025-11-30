const { getLang } = require("../lib/utils/language");
const axios = require("axios");

/**
 * Lyrics Plugin
 * Search and display song lyrics
 */

module.exports = {
  command: {
    pattern: "lyrics",
    desc: "Search for song lyrics",
    type: "search",
  },

  async execute(message, args) {
    const query = args || (message.quoted && message.quoted.message);

    if (!query) {
      return await message.reply(
        "*Please provide a song name!*\n\nExample: `.lyrics shape of you`"
      );
    }

    try {
      await message.react("🔍");

      // Using Genius API alternative - lyrics.ovh
      const response = await axios.get(
        `https://api.lyrics.ovh/v1/${encodeURIComponent(query)}`
      );

      if (response.data && response.data.lyrics) {
        const { lyrics } = response.data;

        // Split lyrics if too long
        if (lyrics.length > 4000) {
          const parts = lyrics.match(/[\s\S]{1,4000}/g) || [];
          for (let i = 0; i < parts.length; i++) {
            await message.reply(
              `*🎵 Lyrics - Part ${i + 1}/${parts.length}*\n\n${parts[i]}`
            );
          }
        } else {
          await message.reply(`*🎵 Lyrics*\n\n${lyrics}`);
        }

        await message.react("✅");
      } else {
        await message.reply(
          "*Lyrics not found!*\n\nTry searching with artist name."
        );
        await message.react("❌");
      }
    } catch (error) {
      console.error("Lyrics search error:", error);

      // Fallback: try alternative method with better formatting
      try {
        const searchQuery = query.split(" ").slice(0, 3).join(" ");
        const altResponse = await axios.get(
          `https://some-random-api.com/lyrics?title=${encodeURIComponent(
            searchQuery
          )}`
        );

        if (altResponse.data && altResponse.data.lyrics) {
          const { title, author, lyrics } = altResponse.data;

          const formattedLyrics = `*🎵 ${title}*\n*🎤 Artist:* ${author}\n\n${lyrics}`;

          if (formattedLyrics.length > 4000) {
            const parts = formattedLyrics.match(/[\s\S]{1,4000}/g) || [];
            for (let i = 0; i < parts.length; i++) {
              await message.reply(
                `*Part ${i + 1}/${parts.length}*\n\n${parts[i]}`
              );
            }
          } else {
            await message.reply(formattedLyrics);
          }

          await message.react("✅");
        } else {
          throw new Error("No lyrics found");
        }
      } catch (altError) {
        await message.reply(
          "*❌ Lyrics not found!*\n\nPlease try:\n• Including artist name\n• Checking spelling\n• Using exact song title"
        );
        await message.react("❌");
      }
    }
  },
};
