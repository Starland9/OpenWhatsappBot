const { getLang } = require("../lib/utils/language");
const config = require("../config");

/**
 * Fancy Text Plugin
 * Generate fancy text styles from Unicode alphabets.
 *   .fancy                 → list of styles
 *   .fancy 5 Hello World   → one style
 *   .fancy all Hello       → every style
 */

const MAX_LENGTH = 500;

const isUpper = (ch) => ch >= "A" && ch <= "Z";
const isLower = (ch) => ch >= "a" && ch <= "z";
const isDigit = (ch) => ch >= "0" && ch <= "9";

/**
 * Build a converter for a Unicode alphabet.
 * @param {Object} def
 * @param {number} def.upper - code point of "A"
 * @param {number} [def.lower] - code point of "a" (omitted: uppercase-only alphabet)
 * @param {number} [def.digit] - code point of "0"
 * @param {Object} [def.holes] - letters that live elsewhere (Letterlike Symbols block)
 * @param {Object} [def.digits] - map of digit → code point, when digits are not contiguous
 */
function alphabet({ upper, lower, digit, holes = {}, digits }) {
  return (text) =>
    Array.from(text, (ch) => {
      let source = ch;
      if (!lower && isLower(ch)) source = ch.toUpperCase();

      if (isUpper(source)) {
        return (
          holes[source] ?? String.fromCodePoint(upper + source.charCodeAt(0) - 65)
        );
      }
      if (lower && isLower(source)) {
        return (
          holes[source] ?? String.fromCodePoint(lower + source.charCodeAt(0) - 97)
        );
      }
      if (isDigit(source)) {
        if (digits) return digits[source] ?? source;
        if (digit) return String.fromCodePoint(digit + source.charCodeAt(0) - 48);
      }
      return ch;
    }).join("");
}

const cp = (code) => String.fromCodePoint(code);

// Mathematical Alphanumeric Symbols have "holes": those letters were already
// encoded in the Letterlike Symbols block (U+2100)
const ITALIC_HOLES = { h: cp(0x210e) };
const SCRIPT_HOLES = {
  B: cp(0x212c),
  E: cp(0x2130),
  F: cp(0x2131),
  H: cp(0x210b),
  I: cp(0x2110),
  L: cp(0x2112),
  M: cp(0x2133),
  R: cp(0x211b),
  e: cp(0x212f),
  g: cp(0x210a),
  o: cp(0x2134),
};
const DOUBLE_STRUCK_HOLES = {
  C: cp(0x2102),
  H: cp(0x210d),
  N: cp(0x2115),
  P: cp(0x2119),
  Q: cp(0x211a),
  R: cp(0x211d),
  Z: cp(0x2124),
};
// Circled digits: 1-9 are U+2460..2468, 0 is U+24EA
const CIRCLED_DIGITS = Object.fromEntries(
  Array.from({ length: 10 }, (_, d) => [String(d), cp(d === 0 ? 0x24ea : 0x245f + d)]),
);

const spaced = (text) => Array.from(text).join(" ");

// Upper/lower alternate on letters only, spaces and punctuation do not count
function alternating(text) {
  let letters = 0;
  return Array.from(text, (ch) => {
    if (!/\p{L}/u.test(ch)) return ch;
    return letters++ % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase();
  }).join("");
}

// key = number used in the command; `name` is the key of the localized style name
const STYLES = [
  { id: 1, name: "spaced", convert: spaced },
  { id: 2, name: "bold", convert: alphabet({ upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce }) },
  { id: 3, name: "italic", convert: alphabet({ upper: 0x1d434, lower: 0x1d44e, holes: ITALIC_HOLES }) },
  { id: 4, name: "monospace", convert: alphabet({ upper: 0x1d670, lower: 0x1d68a, digit: 0x1d7f6 }) },
  { id: 5, name: "script", convert: alphabet({ upper: 0x1d49c, lower: 0x1d4b6, holes: SCRIPT_HOLES }) },
  { id: 6, name: "circled", convert: alphabet({ upper: 0x24b6, lower: 0x24d0, digits: CIRCLED_DIGITS }) },
  { id: 7, name: "squared", convert: alphabet({ upper: 0x1f130 }) },
  { id: 8, name: "negative_circled", convert: alphabet({ upper: 0x1f150 }) },
  { id: 9, name: "alternating", convert: alternating },
  {
    id: 10,
    name: "double_struck",
    convert: alphabet({ upper: 0x1d538, lower: 0x1d552, digit: 0x1d7d8, holes: DOUBLE_STRUCK_HOLES }),
  },
  { id: 11, name: "negative_squared", convert: alphabet({ upper: 0x1f170 }) },
];

function stylesList() {
  return STYLES.map(
    (s) => `*${s.id}.* ${getLang(`plugins.fancy.style_${s.name}`)}`,
  ).join("\n");
}

module.exports = {
  command: {
    pattern: "fancy",
    desc: getLang("plugins.fancy.desc"),
    type: "utility",
  },

  async execute(message, args, ctx) {
    const input = (ctx?.rawArgs ?? args ?? "").trim();

    if (!input) {
      return await message.reply(
        getLang("plugins.fancy.usage", config.PREFIX, stylesList()),
      );
    }

    const match = input.match(/^(\S+)\s+([\s\S]+)$/);
    if (!match) {
      return await message.reply(getLang("plugins.fancy.no_text", config.PREFIX));
    }
    const styleArg = match[1].toLowerCase();
    const text = match[2].trim();

    if (Array.from(text).length > MAX_LENGTH) {
      return await message.reply(getLang("plugins.fancy.too_long", MAX_LENGTH));
    }

    if (styleArg === "all") {
      const lines = STYLES.map((s) => `*${s.id}.* ${s.convert(text)}`).join("\n\n");
      return await message.reply(`${getLang("plugins.fancy.all_title")}\n\n${lines}`);
    }

    const style = STYLES.find((s) => String(s.id) === styleArg);
    if (!style) {
      return await message.reply(
        getLang("plugins.fancy.invalid_style", STYLES.length),
      );
    }
    await message.reply(style.convert(text));
  },

  // exported for tests
  STYLES,
};
