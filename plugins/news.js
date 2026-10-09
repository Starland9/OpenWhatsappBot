const { getLang } = require("../lib/utils/language");
const axios = require("axios");
const config = require("../config");

/**
 * News & Alerts Plugin - Get latest news, crypto, stock prices
 */
module.exports = {
  command: {
    pattern: "news|crypto|stock",
    desc: getLang("plugins.news.desc"),
    type: "info",
  },

  async execute(message, query) {
    const command = message.body
      .split(" ")[0]
      .replace(config.PREFIX, "")
      .trim()
      .toLowerCase();

    try {
      await message.react("⏳");

      if (command === "news") {
        await handleNews(message, query);
      } else if (command === "crypto") {
        await handleCrypto(message, query || "bitcoin");
      } else if (command === "stock") {
        await handleStock(message, query);
      }
    } catch (error) {
      await message.react("❌");
      console.error("News/Alerts error:", error);
      await message.reply(
        `❌ ${getLang("plugins.news.error")}: ${error.message}`
      );
    }
  },
};

async function handleNews(message, query) {
  const NEWS_API_KEY = config.NEWS_API_KEY || process.env.NEWS_API_KEY;

  if (!NEWS_API_KEY) {
    return await message.reply(`❌ ${getLang("plugins.news.no_api_key")}`);
  }

  const country = query || "us";

  const response = await axios.get("https://newsapi.org/v2/top-headlines", {
    params: {
      apiKey: NEWS_API_KEY,
      country: country.toLowerCase(),
      pageSize: 5,
    },
    timeout: 10000,
  });

  if (!response.data.articles || response.data.articles.length === 0) {
    await message.react("❌");
    return await message.reply(`❌ ${getLang("plugins.news.no_news")}`);
  }

  let newsText = `📰 *${getLang("plugins.news.title")}*\n\n`;

  response.data.articles.slice(0, 5).forEach((article, index) => {
    newsText += `${index + 1}. *${article.title}*\n`;
    newsText += `   _${article.source.name}_\n`;
    if (article.description) {
      newsText += `   ${article.description.substring(0, 100)}...\n`;
    }
    newsText += `   🔗 ${article.url}\n\n`;
  });

  await message.react("✅");
  await message.reply(newsText);
}

async function handleCrypto(message, query) {
  const cryptoId = query.toLowerCase() || "bitcoin";

  const response = await axios.get(
    `https://api.coingecko.com/api/v3/simple/price`,
    {
      params: {
        ids: cryptoId,
        vs_currencies: "usd,eur",
        include_24hr_change: true,
        include_market_cap: true,
      },
      timeout: 10000,
    }
  );

  if (!response.data[cryptoId]) {
    await message.react("❌");
    return await message.reply(
      `❌ ${getLang("plugins.news.crypto_not_found")}`
    );
  }

  const data = response.data[cryptoId];
  const priceChange = data.usd_24h_change || 0;
  const changeEmoji = priceChange >= 0 ? "📈" : "📉";
  const changeColor = priceChange >= 0 ? "🟢" : "🔴";

  const cryptoInfo =
    `${changeEmoji} *${cryptoId.toUpperCase()} ${getLang(
      "plugins.news.price"
    )}*\n\n` +
    `💵 *USD:* $${data.usd.toLocaleString()}\n` +
    `💶 *EUR:* €${data.eur.toLocaleString()}\n` +
    `${changeColor} *24h ${getLang(
      "plugins.news.change"
    )}:* ${priceChange.toFixed(2)}%\n` +
    `📊 *${getLang("plugins.news.market_cap")}:* $${(
      data.usd_market_cap / 1000000000
    ).toFixed(2)}B\n\n` +
    `_${getLang("plugins.news.powered_by")} CoinGecko_`;

  await message.react("✅");
  await message.reply(cryptoInfo);
}

async function handleStock(message, query) {
  if (!query) {
    return await message.reply(getLang("plugins.news.stock_usage"));
  }

  const symbol = query.toUpperCase();

  // Using Alpha Vantage API (free tier)
  const ALPHA_VANTAGE_KEY =
    config.ALPHA_VANTAGE_KEY || process.env.ALPHA_VANTAGE_KEY;

  if (!ALPHA_VANTAGE_KEY) {
    return await message.reply(
      `❌ ${getLang("plugins.news.no_stock_api_key")}`
    );
  }

  const response = await axios.get(`https://www.alphavantage.co/query`, {
    params: {
      function: "GLOBAL_QUOTE",
      symbol: symbol,
      apikey: ALPHA_VANTAGE_KEY,
    },
    timeout: 10000,
  });

  const quote = response.data["Global Quote"];

  if (!quote || !quote["05. price"]) {
    await message.react("❌");
    return await message.reply(`❌ ${getLang("plugins.news.stock_not_found")}`);
  }

  const price = parseFloat(quote["05. price"]);
  const change = parseFloat(quote["09. change"]);
  const changePercent = parseFloat(
    quote["10. change percent"].replace("%", "")
  );
  const changeEmoji = change >= 0 ? "📈" : "📉";
  const changeColor = change >= 0 ? "🟢" : "🔴";

  const stockInfo =
    `${changeEmoji} *${symbol} ${getLang("plugins.news.stock_price")}*\n\n` +
    `💵 *${getLang("plugins.news.price")}:* $${price.toFixed(2)}\n` +
    `${changeColor} *${getLang("plugins.news.change")}:* ${
      change >= 0 ? "+" : ""
    }${change.toFixed(2)} (${
      changePercent >= 0 ? "+" : ""
    }${changePercent.toFixed(2)}%)\n` +
    `📊 *${getLang("plugins.news.volume")}:* ${parseInt(
      quote["06. volume"]
    ).toLocaleString()}\n` +
    `📅 *${getLang("plugins.news.last_update")}:* ${
      quote["07. latest trading day"]
    }\n\n` +
    `_${getLang("plugins.news.powered_by")} Alpha Vantage_`;

  await message.react("✅");
  await message.reply(stockInfo);
}
