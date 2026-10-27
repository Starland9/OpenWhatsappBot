const { getLang } = require("../lib/utils/language");
const { fetchJson, safeLog } = require("../lib/utils/http");
const config = require("../config");

/**
 * Fact Plugin
 * Get random interesting facts.
 *
 * Useless Facts (v2) only answers in English or German, so a French bot uses the
 * local list; the local lists are also the fallback when the API is down.
 */

const FACTS_API = "https://uselessfacts.jsph.pl/api/v2/facts/random";

const LOCAL_FACTS = {
  en: [
    "Honey never spoils: archaeologists have found 3,000-year-old honey in Egyptian tombs that was still edible.",
    "A day on Venus is longer than a year on Venus.",
    "Bananas are berries, but strawberries are not.",
    "Octopuses have three hearts and blue blood.",
    "The human brain is about 2% of body weight but uses about 20% of the body's energy.",
    "The Eiffel Tower can grow about 15 cm taller in summer because the iron expands in the heat.",
    "Wombats produce cube-shaped droppings.",
    "There are more trees on Earth than stars in the Milky Way.",
    "The Great Wall of China is not visible to the naked eye from space.",
    "Giraffes have the same number of neck vertebrae as humans: seven.",
    "A shrimp's heart is located in its head.",
    "A solar day on Mercury lasts about 176 Earth days.",
    "Koalas have fingerprints that are almost identical to human ones.",
    "The smallest bone in the human body, the stapes, is in the ear.",
    "Cats cannot taste sweetness.",
    "Lightning strikes the Earth about 100 times every second.",
    "The Sun holds about 99.86% of the mass of the solar system.",
    "An average cumulus cloud can weigh more than 500 tonnes.",
  ],
  fr: [
    "Le miel ne se périme jamais : des archéologues ont retrouvé dans des tombes égyptiennes du miel vieux de 3 000 ans, encore comestible.",
    "Un jour sur Vénus dure plus longtemps qu'une année sur Vénus.",
    "Les bananes sont des baies, mais pas les fraises.",
    "Les pieuvres ont trois cœurs et du sang bleu.",
    "Le cerveau humain représente environ 2 % du poids du corps, mais consomme environ 20 % de son énergie.",
    "La tour Eiffel peut grandir d'environ 15 cm en été, car le métal se dilate avec la chaleur.",
    "Les wombats produisent des crottes en forme de cubes.",
    "Il y a plus d'arbres sur Terre que d'étoiles dans la Voie lactée.",
    "La Grande Muraille de Chine n'est pas visible à l'œil nu depuis l'espace.",
    "Les girafes ont le même nombre de vertèbres cervicales que les humains : sept.",
    "Le cœur d'une crevette se trouve dans sa tête.",
    "Un jour solaire sur Mercure dure environ 176 jours terrestres.",
    "Les koalas ont des empreintes digitales presque identiques à celles des humains.",
    "Le plus petit os du corps humain, l'étrier, se trouve dans l'oreille.",
    "Les chats ne perçoivent pas le goût sucré.",
    "La foudre frappe la Terre environ 100 fois par seconde.",
    "Le Soleil concentre environ 99,86 % de la masse du système solaire.",
    "Un cumulus moyen peut peser plus de 500 tonnes.",
  ],
};

function localFact() {
  const list = config.LANG === "fr" ? LOCAL_FACTS.fr : LOCAL_FACTS.en;
  return list[Math.floor(Math.random() * list.length)];
}

async function remoteFact() {
  const data = await fetchJson(FACTS_API, {
    params: { language: "en" },
    timeoutMs: 10000,
  });
  const text = typeof data?.text === "string" ? data.text.trim() : "";
  return text || null;
}

module.exports = {
  command: {
    pattern: "fact",
    desc: getLang("plugins.fact.desc"),
    type: "fun",
  },

  async execute(message) {
    await message.react("💡");

    let fact = null;
    if (config.LANG !== "fr") {
      try {
        fact = await remoteFact();
      } catch (error) {
        console.warn("Useless Facts API failed:", safeLog(error));
      }
    }

    await message.reply(getLang("plugins.fact.title", fact || localFact()));
    await message.react("✅");
  },
};
