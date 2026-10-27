const { getLang } = require("../lib/utils/language");
const { fetchJson, safeLog } = require("../lib/utils/http");
const config = require("../config");

/**
 * Joke Plugin
 * Get random jokes for entertainment (JokeAPI in French when the bot speaks French,
 * Official Joke API / JokeAPI in English otherwise)
 */

const JOKE_API = "https://v2.jokeapi.dev/joke/Any";
const OFFICIAL_JOKE_API = "https://official-joke-api.appspot.com/random_joke";
const TIMEOUT_MS = 10000;

function fromJokeApi(data) {
  if (!data || data.error) return null;
  if (data.type === "single" && data.joke) return `${data.joke} 😂`;
  if (data.type === "twopart" && data.setup && data.delivery) {
    return `*${data.setup}*\n\n_${data.delivery}_ 😂`;
  }
  return null;
}

/** JokeAPI, in `lang` ("fr" has a small catalogue; the call fails when nothing matches) */
async function jokeApi(lang) {
  const data = await fetchJson(JOKE_API, {
    params: { lang, "safe-mode": "" },
    timeoutMs: TIMEOUT_MS,
  });
  return fromJokeApi(data);
}

async function officialJokeApi() {
  const data = await fetchJson(OFFICIAL_JOKE_API, { timeoutMs: TIMEOUT_MS });
  if (data?.setup && data?.punchline) {
    return `*${data.setup}*\n\n_${data.punchline}_ 😂`;
  }
  return null;
}

module.exports = {
  command: {
    pattern: "joke",
    desc: getLang("plugins.joke.desc"),
    type: "fun",
  },

  async execute(message) {
    await message.react("😂");

    const sources =
      config.LANG === "fr"
        ? [() => jokeApi("fr"), officialJokeApi, () => jokeApi("en")]
        : [officialJokeApi, () => jokeApi("en")];

    let joke = null;
    for (const source of sources) {
      try {
        joke = await source();
      } catch (error) {
        console.warn("Joke API failed:", safeLog(error));
      }
      if (joke) break;
    }

    if (!joke) {
      await message.react("❌");
      return await message.reply(getLang("common.service_unavailable"));
    }

    await message.reply(joke);
    await message.react("✅");
  },
};
