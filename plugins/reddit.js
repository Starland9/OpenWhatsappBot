const { getLang } = require("../lib/utils/language");
const axios = require("axios");

/**
 * Reddit Plugin
 * Search and get content from Reddit
 */

module.exports = {
  command: {
    pattern: "reddit",
    desc: "Search Reddit posts",
    type: "search",
  },

  async execute(message, args) {
    const query = args || (message.quoted && message.body);

    if (!query) {
      return await message.reply(
        "*Please provide a search query or subreddit!*\n\nExamples:\n• `.reddit funny`\n• `.reddit r/memes`"
      );
    }

    try {
      await message.react("🔍");

      let subreddit = "all";
      let searchQuery = query.trim();

      // Check if it's a subreddit query
      if (query.toLowerCase().startsWith("r/")) {
        subreddit = query.slice(2).split(" ")[0];
        searchQuery = query.slice(2 + subreddit.length).trim() || "";
      }

      // Fetch from Reddit API
      const url = searchQuery
        ? `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(
            searchQuery
          )}&restrict_sr=1&limit=5`
        : `https://www.reddit.com/r/${subreddit}/hot.json?limit=5`;

      const response = await axios.get(url, {
        headers: {
          "User-Agent": "WhatsAppBot/1.0",
        },
        timeout: 15000,
      });

      if (
        response.data &&
        response.data.data &&
        response.data.data.children &&
        response.data.data.children.length > 0
      ) {
        const posts = response.data.data.children;

        let resultMsg = `*🔍 Reddit Results - r/${subreddit}*\n\n`;

        posts.forEach((post, index) => {
          const data = post.data;
          resultMsg += `*${index + 1}. ${data.title}*\n`;
          resultMsg += `👤 Author: u/${data.author}\n`;
          resultMsg += `⬆️ ${data.ups} upvotes | 💬 ${data.num_comments} comments\n`;
          resultMsg += `🔗 https://reddit.com${data.permalink}\n`;

          if (data.url && !data.is_self) {
            resultMsg += `📎 ${data.url}\n`;
          }

          resultMsg += `\n`;
        });

        await message.reply(resultMsg);

        // Send media if available in first post
        const firstPost = posts[0].data;
        if (
          firstPost.url &&
          (firstPost.url.endsWith(".jpg") ||
            firstPost.url.endsWith(".png") ||
            firstPost.url.endsWith(".gif") ||
            firstPost.url.endsWith(".jpeg"))
        ) {
          try {
            const imgResponse = await axios.get(firstPost.url, {
              responseType: "arraybuffer",
              timeout: 15000,
            });

            const buffer = Buffer.from(imgResponse.data);
            await message.sendImage(buffer, firstPost.title);
          } catch (err) {
            console.log("Failed to send image");
          }
        }

        await message.react("✅");
      } else {
        await message.reply(
          "*No results found!*\n\nTry:\n• Different search terms\n• Valid subreddit name"
        );
        await message.react("❌");
      }
    } catch (error) {
      console.error("Reddit search error:", error);

      if (error.response && error.response.status === 404) {
        await message.reply(
          "*Subreddit not found!*\n\nPlease check the name and try again."
        );
      } else {
        await message.reply("*Search failed!*\n\nPlease try again later.");
      }

      await message.react("❌");
    }
  },
};
