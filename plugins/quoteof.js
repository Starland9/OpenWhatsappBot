const { getLang } = require("../lib/utils/language");
const { fetchJson, safeLog } = require("../lib/utils/http");
const config = require("../config");

/**
 * Inspirational quotes.
 *   .quoteof   → a random quote
 * ZenQuotes first, then DummyJSON, then a short local list (also in French).
 */

const TIMEOUT_MS = 10000;

const LOCAL_QUOTES = {
  en: [
    ["I think, therefore I am.", "René Descartes"],
    ["The unexamined life is not worth living.", "Socrates"],
    ["That which does not kill us makes us stronger.", "Friedrich Nietzsche"],
    ["The only thing we have to fear is fear itself.", "Franklin D. Roosevelt"],
    ["A journey of a thousand miles begins with a single step.", "Lao Tzu"],
    ["Well done is better than well said.", "Benjamin Franklin"],
    ["Do what you can, with what you have, where you are.", "Theodore Roosevelt"],
    ["Imagination is more important than knowledge.", "Albert Einstein"],
    ["The best way out is always through.", "Robert Frost"],
    ["Fall seven times, stand up eight.", "Japanese proverb"],
    ["We are what we repeatedly do. Excellence, then, is not an act, but a habit.", "Will Durant"],
    ["No one can make you feel inferior without your consent.", "Eleanor Roosevelt"],
  ],
  fr: [
    ["Je pense, donc je suis.", "René Descartes"],
    ["Il faut cultiver notre jardin.", "Voltaire"],
    ["On ne voit bien qu'avec le cœur. L'essentiel est invisible pour les yeux.", "Antoine de Saint-Exupéry"],
    ["Rien ne sert de courir ; il faut partir à point.", "Jean de La Fontaine"],
    ["Patience et longueur de temps font plus que force ni que rage.", "Jean de La Fontaine"],
    ["Ce qui ne me tue pas me rend plus fort.", "Friedrich Nietzsche"],
    ["Qui veut voyager loin ménage sa monture.", "Jean Racine"],
    ["Le véritable voyage de découverte ne consiste pas à chercher de nouveaux paysages, mais à avoir de nouveaux yeux.", "Marcel Proust"],
    ["Il n'y a pas de vent favorable pour celui qui ne sait pas où il va.", "Sénèque"],
    ["C'est le temps que tu as perdu pour ta rose qui fait ta rose si importante.", "Antoine de Saint-Exupéry"],
    ["L'imagination est plus importante que le savoir.", "Albert Einstein"],
    ["Tomber sept fois, se relever huit.", "Proverbe japonais"],
  ],
};

/**
 * WhatsApp has no escape character for its formatting (*bold*, _italic_, ~strike~,
 * `code`): swap the markers for look-alikes so that a quote never changes style.
 */
function escapeFormatting(text) {
  return String(text)
    .replace(/\*/g, "∗")
    .replace(/_/g, "＿")
    .replace(/~/g, "∼")
    .replace(/`/g, "ˋ");
}

const clean = (value) => (typeof value === "string" ? value.trim() : "");

async function fromZenQuotes() {
  const data = await fetchJson("https://zenquotes.io/api/random", { timeoutMs: TIMEOUT_MS });
  const item = Array.isArray(data) ? data[0] : null;
  const quote = clean(item?.q);
  const author = clean(item?.a);
  // When rate limited, ZenQuotes answers 200 with a notice signed "zenquotes.io"
  if (!quote || author === "zenquotes.io") return null;
  return { quote, author };
}

async function fromDummyJson() {
  const data = await fetchJson("https://dummyjson.com/quotes/random", { timeoutMs: TIMEOUT_MS });
  const quote = clean(data?.quote);
  return quote ? { quote, author: clean(data?.author) } : null;
}

function fromLocalList() {
  const list = config.LANG === "fr" ? LOCAL_QUOTES.fr : LOCAL_QUOTES.en;
  const [quote, author] = list[Math.floor(Math.random() * list.length)];
  return { quote, author };
}

module.exports = {
  command: {
    pattern: "quoteof|inspirational",
    desc: getLang("plugins.quoteof.desc"),
    type: "fun",
  },

  async execute(message) {
    await message.react("✨");

    let result = null;
    for (const source of [fromZenQuotes, fromDummyJson]) {
      try {
        result = await source();
      } catch (error) {
        console.warn("Quote API failed:", safeLog(error));
      }
      if (result) break;
    }
    if (!result) result = fromLocalList();

    await message.reply(
      getLang(
        "plugins.quoteof.format",
        escapeFormatting(result.quote),
        escapeFormatting(result.author || getLang("plugins.quoteof.unknown_author")),
      ),
    );
  },

  // exported for tests
  escapeFormatting,
};
