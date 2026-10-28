const { getLang } = require("../lib/utils/language");
const { fetchJson, classifyError, replyKeyFor, safeLog } = require("../lib/utils/http");
const config = require("../config");

/**
 * News & Alerts Plugin - latest news, crypto prices, stock prices
 *   .news [country code | search words]   NewsAPI (key: NEWS_API_KEY)
 *   .crypto [id or ticker]                CoinGecko (no key, cached 60 s)
 *   .stock <symbol>                       Alpha Vantage (key: ALPHA_VANTAGE_KEY)
 */

const TIMEOUT_MS = 10000;
const MAX_QUERY_LENGTH = 100;

// Countries accepted by NewsAPI's top-headlines
const NEWS_COUNTRIES = new Set(
  "ae ar at au be bg br ca ch cn co cu cz de eg fr gb gr hk hu id ie il in it jp kr lt lv ma mx my ng nl no nz ph pl pt ro rs ru sa se sg si sk th tr tw ua us ve za".split(" "),
);
// Languages accepted by NewsAPI's /everything
const NEWS_LANGUAGES = new Set("ar de en es fr he it nl no pt ru sv ud zh".split(" "));
// Default country for the bot language (NewsAPI has no country for every language)
const LANG_COUNTRY = { en: "us", fr: "fr", de: "de", it: "it", pt: "pt", ru: "ru", nl: "nl", pl: "pl", tr: "tr", ja: "jp", ko: "kr", zh: "cn" };

const CRYPTO_TTL_MS = 60 * 1000;
const CRYPTO_CACHE_MAX = 100;
// Common tickers → CoinGecko ids (anything else is used as a CoinGecko id)
const CRYPTO_TICKERS = {
  btc: "bitcoin", xbt: "bitcoin", eth: "ethereum", usdt: "tether", usdc: "usd-coin",
  bnb: "binancecoin", sol: "solana", xrp: "ripple", ada: "cardano", doge: "dogecoin",
  trx: "tron", ton: "the-open-network", dot: "polkadot", avax: "avalanche-2",
  link: "chainlink", ltc: "litecoin", bch: "bitcoin-cash", xlm: "stellar",
  atom: "cosmos", xmr: "monero", etc: "ethereum-classic", uni: "uniswap",
  shib: "shiba-inu", near: "near", apt: "aptos", arb: "arbitrum", op: "optimism",
  matic: "matic-network", pol: "polygon-ecosystem-token", dai: "dai", pepe: "pepe",
};

/** @type {Map<string, { at: number, data: object|null }>} */
const cryptoCache = new Map();

function numberFormat(maximumFractionDigits = 2) {
  try {
    return new Intl.NumberFormat(config.LANG || "en", { maximumFractionDigits });
  } catch (_) {
    return new Intl.NumberFormat("en", { maximumFractionDigits });
  }
}

/** Format a number, "—" when the API did not send it */
function fmt(value, maximumFractionDigits = 2) {
  const n = typeof value === "string" ? parseFloat(value) : value;
  return Number.isFinite(n) ? numberFormat(maximumFractionDigits).format(n) : "—";
}

const arrow = (n) => (n >= 0 ? "📈" : "📉");
const dot = (n) => (n >= 0 ? "🟢" : "🔴");

/** Lang key to reply with for a failed NewsAPI call (it names the problem in `code`) */
function newsApiKind(error) {
  const code = error?.response?.data?.code;
  if (/^apiKey(Invalid|Missing|Disabled)$/.test(code)) return "not_configured";
  if (/^(apiKeyExhausted|rateLimited|maximumResultsReached)$/.test(code)) return "rate_limited";
  return null;
}

async function handleNews(message, rawQuery) {
  if (!config.NEWS_API_KEY) {
    return await message.reply(getLang("common.not_configured"));
  }

  const query = rawQuery.slice(0, MAX_QUERY_LENGTH);
  const lang = (config.LANG || "").slice(0, 2);
  let endpoint;
  let params;

  if (query && NEWS_COUNTRIES.has(query.toLowerCase())) {
    endpoint = "top-headlines";
    params = { country: query.toLowerCase(), pageSize: 5 };
  } else if (query) {
    // Free text: search instead of passing it as a country
    endpoint = "everything";
    params = { q: query, sortBy: "publishedAt", pageSize: 5 };
    if (NEWS_LANGUAGES.has(lang)) params.language = lang;
  } else {
    endpoint = "top-headlines";
    params = { country: LANG_COUNTRY[lang] || "fr", pageSize: 5 };
  }

  await message.react("⏳");
  const data = await fetchJson(`https://newsapi.org/v2/${endpoint}`, {
    params,
    headers: { "X-Api-Key": config.NEWS_API_KEY },
    timeoutMs: TIMEOUT_MS,
  });

  const articles = (Array.isArray(data?.articles) ? data.articles : [])
    .filter((a) => a && a.title && a.title !== "[Removed]")
    .slice(0, 5);
  if (articles.length === 0) {
    await message.react("❌");
    return await message.reply(getLang("plugins.news.no_news"));
  }

  const lines = articles.map((article, index) => {
    let entry = `${index + 1}. *${article.title}*\n`;
    if (article.source?.name) entry += `   _${article.source.name}_\n`;
    if (article.description) {
      const description = article.description.trim();
      entry += `   ${description.length > 100 ? `${description.slice(0, 100)}...` : description}\n`;
    }
    if (article.url) entry += `   🔗 ${article.url}\n`;
    return entry;
  });

  await message.react("✅");
  await message.reply(`${getLang("plugins.news.title")}\n\n${lines.join("\n")}`);
}

async function fetchCrypto(id) {
  const cached = cryptoCache.get(id);
  if (cached && Date.now() - cached.at < CRYPTO_TTL_MS) return cached.data;

  const data = await fetchJson("https://api.coingecko.com/api/v3/simple/price", {
    params: {
      ids: id,
      vs_currencies: "usd,eur",
      include_24hr_change: "true",
      include_market_cap: "true",
    },
    timeoutMs: TIMEOUT_MS,
  });
  const coin = data && typeof data[id] === "object" ? data[id] : null;

  if (cryptoCache.size >= CRYPTO_CACHE_MAX) {
    cryptoCache.delete(cryptoCache.keys().next().value); // oldest entry
  }
  cryptoCache.set(id, { at: Date.now(), data: coin });
  return coin;
}

async function handleCrypto(message, rawQuery) {
  const input = (rawQuery.split(/\s+/)[0] || "bitcoin").toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{0,49}$/.test(input)) {
    return await message.reply(getLang("plugins.news.crypto_not_found"));
  }
  const id = CRYPTO_TICKERS[input] || input;

  await message.react("⏳");
  const coin = await fetchCrypto(id);
  if (!coin || (coin.usd === undefined && coin.eur === undefined)) {
    await message.react("❌");
    return await message.reply(getLang("plugins.news.crypto_not_found"));
  }

  const change = Number.isFinite(coin.usd_24h_change) ? coin.usd_24h_change : null;
  const digits = (coin.usd ?? coin.eur) < 1 ? 6 : 2;
  const marketCap = Number.isFinite(coin.usd_market_cap)
    ? `$${fmt(coin.usd_market_cap / 1e9)}B`
    : "—";

  const info =
    `${arrow(change ?? 0)} *${id.toUpperCase()} ${getLang("plugins.news.price")}*\n\n` +
    `💵 *USD:* ${Number.isFinite(coin.usd) ? `$${fmt(coin.usd, digits)}` : "—"}\n` +
    `💶 *EUR:* ${Number.isFinite(coin.eur) ? `€${fmt(coin.eur, digits)}` : "—"}\n` +
    `${dot(change ?? 0)} *24h ${getLang("plugins.news.change")}:* ${change === null ? "—" : `${fmt(change)}%`}\n` +
    `📊 *${getLang("plugins.news.market_cap")}:* ${marketCap}\n\n` +
    `_${getLang("plugins.news.powered_by")} CoinGecko_`;

  await message.react("✅");
  await message.reply(info);
}

async function handleStock(message, rawQuery) {
  if (!rawQuery) {
    return await message.reply(getLang("plugins.news.stock_usage", config.PREFIX));
  }
  if (!config.ALPHA_VANTAGE_KEY) {
    return await message.reply(getLang("common.not_configured"));
  }

  const symbol = rawQuery.split(/\s+/)[0].toUpperCase();
  if (!/^[A-Z0-9.^-]{1,15}$/.test(symbol)) {
    return await message.reply(getLang("plugins.news.stock_not_found"));
  }

  await message.react("⏳");
  const data = await fetchJson("https://www.alphavantage.co/query", {
    params: { function: "GLOBAL_QUOTE", symbol, apikey: config.ALPHA_VANTAGE_KEY },
    timeoutMs: TIMEOUT_MS,
  });

  // Alpha Vantage answers 200 with a notice when the daily / per-minute quota is used up
  if (data?.Information || data?.Note) {
    await message.react("❌");
    return await message.reply(getLang("plugins.news.stock_quota"));
  }
  if (/api ?key/i.test(String(data?.["Error Message"] || ""))) {
    await message.react("❌");
    return await message.reply(getLang("common.not_configured"));
  }

  const quote = data?.["Global Quote"];
  const price = parseFloat(quote?.["05. price"]);
  if (!Number.isFinite(price)) {
    await message.react("❌");
    return await message.reply(getLang("plugins.news.stock_not_found"));
  }

  const change = parseFloat(quote["09. change"]);
  const changePercent = parseFloat(String(quote["10. change percent"] ?? "").replace("%", ""));
  const volume = parseInt(quote["06. volume"], 10);
  const sign = (n) => (n >= 0 ? "+" : "");
  const direction = Number.isFinite(change) ? change : 0;

  const info =
    `${arrow(direction)} ${getLang("plugins.news.stock_price", symbol)}\n\n` +
    `💵 *${getLang("plugins.news.price")}:* $${fmt(price)}\n` +
    `${dot(direction)} *${getLang("plugins.news.change")}:* ` +
    `${Number.isFinite(change) ? `${sign(change)}${fmt(change)}` : "—"}` +
    `${Number.isFinite(changePercent) ? ` (${sign(changePercent)}${fmt(changePercent)}%)` : ""}\n` +
    `📊 *${getLang("plugins.news.volume")}:* ${fmt(volume, 0)}\n` +
    `📅 *${getLang("plugins.news.last_update")}:* ${quote["07. latest trading day"] || "—"}\n\n` +
    `_${getLang("plugins.news.powered_by")} Alpha Vantage_`;

  await message.react("✅");
  await message.reply(info);
}

module.exports = {
  command: {
    pattern: "news|crypto|stock",
    desc: getLang("plugins.news.desc"),
    type: "info",
  },

  async execute(message, query, ctx) {
    const command = ctx?.command || "news";
    const input = (query || "").trim();

    try {
      if (command === "crypto") await handleCrypto(message, input);
      else if (command === "stock") await handleStock(message, input);
      else await handleNews(message, input);
    } catch (error) {
      await message.react("❌");
      // safeLog: the axios error carries the request config, hence the API key
      console.error("News/Alerts error:", safeLog(error));

      const hasKey =
        command === "stock"
          ? !!config.ALPHA_VANTAGE_KEY
          : command === "news"
            ? !!config.NEWS_API_KEY
            : undefined;
      const kind =
        (command === "news" && newsApiKind(error)) ||
        classifyError(error, {
          hasKey,
          service: command === "stock" ? "alphavantage" : command === "news" ? "news" : undefined,
        });
      await message.reply(getLang(replyKeyFor(kind)));
    }
  },
};
