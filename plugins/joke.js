const { getLang } = require("../lib/utils/language");
const axios = require("axios");

/**
 * Joke Plugin
 * Get random jokes for entertainment
 */

module.exports = {
  command: {
    pattern: "joke",
    desc: "Get a random joke",
    type: "fun",
  },

  async execute(message, args) {
    try {
      await message.react("😂");

      // Try multiple joke APIs for better coverage
      let joke = null;

      // Method 1: Official Joke API
      try {
        const response = await axios.get(
          "https://official-joke-api.appspot.com/random_joke",
          { timeout: 10000 }
        );

        if (response.data && response.data.setup) {
          joke = `*${response.data.setup}*\n\n_${response.data.punchline}_ 😂`;
        }
      } catch (e) {
        console.log("Official Joke API failed");
      }

      // Method 2: JokeAPI
      if (!joke) {
        try {
          const response = await axios.get(
            "https://v2.jokeapi.dev/joke/Any?safe-mode",
            { timeout: 10000 }
          );

          if (response.data) {
            if (response.data.type === "single") {
              joke = `${response.data.joke} 😂`;
            } else if (response.data.type === "twopart") {
              joke = `*${response.data.setup}*\n\n_${response.data.delivery}_ 😂`;
            }
          }
        } catch (e) {
          console.log("JokeAPI failed");
        }
      }

      if (joke) {
        await message.reply(joke);
        await message.react("✅");
      } else {
        await message.reply(
          "*Couldn't fetch a joke right now!* 😅\n\nPlease try again later."
        );
        await message.react("❌");
      }
    } catch (error) {
      console.error("Joke error:", error);
      await message.reply("*Error fetching joke!*");
      await message.react("❌");
    }
  },
};
