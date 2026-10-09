const { getLang } = require("../lib/utils/language");
const axios = require("axios");

/**
 * Fact Plugin
 * Get random interesting facts
 */

module.exports = {
  command: {
    pattern: "fact",
    desc: "Get a random interesting fact",
    type: "fun",
  },

  async execute(message, args) {
    try {
      await message.react("💡");

      // Try multiple fact APIs
      let fact = null;

      // Method 1: Useless Facts API
      try {
        const response = await axios.get(
          "https://uselessfacts.jsph.pl/random.json?language=en",
          { timeout: 10000 }
        );

        if (response.data && response.data.text) {
          fact = `💡 *Random Fact:*\n\n${response.data.text}`;
        }
      } catch (e) {
        console.log("Useless Facts API failed");
      }

      // Method 2: API Ninjas Facts
      if (!fact) {
        try {
          const response = await axios.get(
            "https://api.api-ninjas.com/v1/facts?limit=1",
            {
              headers: { "X-Api-Key": "demo" },
              timeout: 10000,
            }
          );

          if (response.data && response.data[0] && response.data[0].fact) {
            fact = `💡 *Random Fact:*\n\n${response.data[0].fact}`;
          }
        } catch (e) {
          console.log("API Ninjas failed");
        }
      }

      // Fallback facts
      const fallbackFacts = [
        "Honey never spoils. Archaeologists have found 3000-year-old honey in Egyptian tombs that's still edible!",
        "A day on Venus is longer than a year on Venus.",
        "Bananas are berries, but strawberries aren't!",
        "There are more stars in the universe than grains of sand on all Earth's beaches.",
        "Your brain uses 20% of your body's energy despite being only 2% of your body weight.",
        "Octopuses have three hearts and blue blood.",
        "Water can boil and freeze at the same time (triple point).",
        "A single bolt of lightning contains enough energy to toast 100,000 slices of bread.",
      ];

      if (!fact) {
        const randomFact =
          fallbackFacts[Math.floor(Math.random() * fallbackFacts.length)];
        fact = `💡 *Random Fact:*\n\n${randomFact}`;
      }

      await message.reply(fact);
      await message.react("✅");
    } catch (error) {
      console.error("Fact error:", error);
      await message.reply("*Error fetching fact!*");
      await message.react("❌");
    }
  },
};
