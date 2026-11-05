"use strict";

/**
 * Glyphes et dessins ASCII du thème « dark hacker ».
 *
 * Module pur (aucune dépendance, aucun accès disque) : il ne produit que des chaînes.
 * Tout ce qui est aléatoire passe par un générateur amorcé par une graine, pour qu'une
 * même cible donne toujours le même rendu (un scan de `example.com` reste lisible).
 */

// ---------------------------------------------------------------------------
// Générateur déterministe
// ---------------------------------------------------------------------------

/** FNV-1a 32 bits : graine stable à partir d'une chaîne */
function seedOf(text) {
  let hash = 0x811c9dc5;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash || 0x9e3779b9;
}

/**
 * Générateur pseudo-aléatoire (xorshift32) amorcé par `seed`.
 * @param {string|number} seed
 * @returns {{ next: () => number, int: (min: number, max: number) => number, pick: <T>(list: T[]) => T }}
 */
function rng(seed) {
  let state = typeof seed === "number" ? seed >>> 0 : seedOf(seed);
  if (state === 0) state = 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
  };
}

// ---------------------------------------------------------------------------
// Polices Unicode
// ---------------------------------------------------------------------------

const SMALL_CAPS = {
  a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", f: "ꜰ", g: "ɢ", h: "ʜ", i: "ɪ", j: "ᴊ",
  k: "ᴋ", l: "ʟ", m: "ᴍ", n: "ɴ", o: "ᴏ", p: "ᴘ", q: "ǫ", r: "ʀ", s: "ꜱ", t: "ᴛ",
  u: "ᴜ", v: "ᴠ", w: "ᴡ", x: "x", y: "ʏ", z: "ᴢ",
};

const FULLWIDTH_OFFSET = 0xfee0;

/** « MENU » -> « ᴍᴇɴᴜ » */
function smallCaps(text) {
  return Array.from(String(text), (char) => {
    const lower = char.toLowerCase();
    return SMALL_CAPS[lower] || char;
  }).join("");
}

/** « MENU » -> « ＭＥＮＵ » (ASCII imprimable uniquement) */
function fullwidth(text) {
  return Array.from(String(text), (char) => {
    const code = char.codePointAt(0);
    if (code >= 0x21 && code <= 0x7e) return String.fromCodePoint(code + FULLWIDTH_OFFSET);
    return char === " " ? "\u3000" : char;
  }).join("");
}

// ---------------------------------------------------------------------------
// Bannière en blocs
// ---------------------------------------------------------------------------

const BLOCK_FONT = {
  A: [" ██ ", "█  █", "████", "█  █", "█  █"],
  B: ["███ ", "█  █", "███ ", "█  █", "███ "],
  C: [" ███", "█   ", "█   ", "█   ", " ███"],
  D: ["███ ", "█  █", "█  █", "█  █", "███ "],
  E: ["████", "█   ", "███ ", "█   ", "████"],
  F: ["████", "█   ", "███ ", "█   ", "█   "],
  G: [" ███", "█   ", "█ ██", "█  █", " ███"],
  H: ["█  █", "█  █", "████", "█  █", "█  █"],
  I: ["███", " █ ", " █ ", " █ ", "███"],
  J: ["  ██", "   █", "   █", "█  █", " ██ "],
  K: ["█  █", "█ █ ", "██  ", "█ █ ", "█  █"],
  L: ["█   ", "█   ", "█   ", "█   ", "████"],
  M: ["█   █", "██ ██", "█ █ █", "█   █", "█   █"],
  N: ["█  █", "██ █", "█ ██", "█  █", "█  █"],
  O: [" ██ ", "█  █", "█  █", "█  █", " ██ "],
  P: ["███ ", "█  █", "███ ", "█   ", "█   "],
  Q: [" ██ ", "█  █", "█  █", "█ █ ", " █ █"],
  R: ["███ ", "█  █", "███ ", "█ █ ", "█  █"],
  S: [" ███", "█   ", " ██ ", "   █", "███ "],
  T: ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
  U: ["█  █", "█  █", "█  █", "█  █", " ██ "],
  V: ["█   █", "█   █", "█   █", " █ █ ", "  █  "],
  W: ["█   █", "█   █", "█ █ █", "██ ██", "█   █"],
  X: ["█   █", " █ █ ", "  █  ", " █ █ ", "█   █"],
  Y: ["█   █", " █ █ ", "  █  ", "  █  ", "  █  "],
  Z: ["█████", "   █ ", "  █  ", " █   ", "█████"],
  0: [" ██ ", "█  █", "█  █", "█  █", " ██ "],
  1: [" █ ", "██ ", " █ ", " █ ", "███"],
  2: [" ██ ", "█  █", "  █ ", " █  ", "████"],
  3: ["███ ", "  █ ", " ██ ", "  █ ", "███ "],
  4: ["█  █", "█  █", "████", "   █", "   █"],
  5: ["████", "█   ", "███ ", "   █", "███ "],
  6: [" ██ ", "█   ", "███ ", "█  █", " ██ "],
  7: ["████", "   █", "  █ ", " █  ", " █  "],
  8: [" ██ ", "█  █", " ██ ", "█  █", " ██ "],
  9: [" ██ ", "█  █", " ███", "   █", " ██ "],
  " ": ["  ", "  ", "  ", "  ", "  "],
  "-": ["   ", "   ", "███", "   ", "   "],
  ".": ["  ", "  ", "  ", "  ", "█ "],
  "!": ["█", "█", "█", " ", "█"],
  "?": ["███ ", "   █", " ██ ", "    ", " █  "],
};

const BANNER_ROWS = 5;

/**
 * Texte en grosses lettres de blocs (5 lignes). Les caractères inconnus passent tels quels.
 * @param {string} text
 * @returns {string}
 */
function banner(text) {
  const chars = Array.from(String(text).toUpperCase()).slice(0, 24);
  const rows = Array.from({ length: BANNER_ROWS }, () => []);
  for (const char of chars) {
    const glyph = BLOCK_FONT[char] || [char, " ", " ", " ", " "];
    for (let row = 0; row < BANNER_ROWS; row++) rows[row].push(glyph[row] ?? " ");
  }
  return rows.map((row) => row.join(" ").replace(/\s+$/, "")).join("\n");
}

// ---------------------------------------------------------------------------
// Corruption de texte
// ---------------------------------------------------------------------------

const ZALGO_UP = ["\u0300", "\u0301", "\u0302", "\u0303", "\u0308", "\u030a", "\u0311", "\u033d", "\u0342"];
const ZALGO_DOWN = ["\u0316", "\u0317", "\u0318", "\u0319", "\u031c", "\u0323", "\u0324", "\u0325", "\u0330"];
const ZALGO_MID = ["\u0334", "\u0335", "\u0336", "\u0337", "\u0338"];

/**
 * Texte corrompu (zalgo). `intensity` = marques par caractère (0 à 3).
 * @param {string} text
 * @param {number} [intensity]
 * @param {string|number} [seed]
 */
function zalgo(text, intensity = 1, seed = text) {
  const random = rng(seed);
  const marks = Math.max(0, Math.min(3, intensity));
  return Array.from(String(text), (char) => {
    if (char === " " || char === "\n") return char;
    let out = char;
    for (let i = 0; i < marks; i++) {
      out += random.pick(ZALGO_UP);
      out += random.pick(ZALGO_DOWN);
      if (random.next() > 0.6) out += random.pick(ZALGO_MID);
    }
    return out;
  }).join("");
}

const GLITCH_CHARS = ["#", "%", "&", "@", "$", "§", "¤", "░", "▒", "▓", "█", "×", "÷", "¬"];

/**
 * Texte avec des caractères remplacés par du bruit (effet glitch).
 * @param {string} text
 * @param {number} [ratio] - proportion de caractères corrompus (0 à 1)
 * @param {string|number} [seed]
 */
function glitch(text, ratio = 0.25, seed = text) {
  const random = rng(seed);
  return Array.from(String(text), (char) => {
    if (char === " " || char === "\n") return char;
    return random.next() < ratio ? random.pick(GLITCH_CHARS) : char;
  }).join("");
}

// ---------------------------------------------------------------------------
// Cadres
// ---------------------------------------------------------------------------

const FRAME = {
  light: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  heavy: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
  ascii: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
};

/**
 * Encadre un bloc de lignes.
 * @param {string[]} lines
 * @param {{ style?: keyof FRAME, title?: string, pad?: number }} [options]
 */
function frame(lines, { style = "light", title = "", pad = 1 } = {}) {
  const chars = FRAME[style] || FRAME.light;
  const body = lines.map((line) => String(line));
  const width = Math.max(
    title ? Array.from(title).length + 2 : 0,
    ...body.map((line) => Array.from(line).length),
    1,
  );
  const inner = width + pad * 2;
  const top = title
    ? `${chars.tl}${chars.h.repeat(1)} ${title} ${chars.h.repeat(Math.max(0, inner - Array.from(title).length - 3))}${chars.tr}`
    : `${chars.tl}${chars.h.repeat(inner)}${chars.tr}`;
  const bottom = `${chars.bl}${chars.h.repeat(inner)}${chars.br}`;
  const rows = body.map(
    (line) => `${chars.v}${" ".repeat(pad)}${line}${" ".repeat(Math.max(0, width - Array.from(line).length + pad))}${chars.v}`,
  );
  return [top, ...rows, bottom].join("\n");
}

/** Barre de progression en blocs pleins/vides */
function bar(ratio, size = 12, full = "█", empty = "░") {
  const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
  const filled = Math.round(clamped * size);
  return full.repeat(filled) + empty.repeat(Math.max(0, size - filled));
}

// ---------------------------------------------------------------------------
// Dessins
// ---------------------------------------------------------------------------

const SKULL = [
  "     ▄▄████▄▄     ",
  "   ▄██████████▄   ",
  "  ███▀▀████▀▀███  ",
  " ███   ████   ███ ",
  " ███▄▄██████▄▄███ ",
  "  ▀████████████▀  ",
  "   ▀███▄▄▄▄███▀   ",
  "     ▀██████▀     ",
  "      ██  ██      ",
  "      ▀▀  ▀▀      ",
];

const GHOST = [
  "    ▄██████▄    ",
  "  ▄██████████▄  ",
  " ████  ██  ████ ",
  " ████  ██  ████ ",
  " ██████████████ ",
  " ██████████████ ",
  " ██████████████ ",
  " ██ ██ ██ ██ ██ ",
  " ▀  ▀  ▀  ▀  ▀  ",
];

const EYE = [
  "      ▄▄██████▄▄      ",
  "   ▄██████████████▄   ",
  " ▄██████▀▀▀▀▀▀██████▄ ",
  "██████▀  ▄████▄  ▀██████",
  "██████▄  ▀████▀  ▄██████",
  " ▀██████▄▄▄▄▄▄██████▀ ",
  "   ▀██████████████▀   ",
  "      ▀▀██████▀▀      ",
];

const WARNING = [
  "        ▄▄▄▄▄        ",
  "      ▄███████▄      ",
  "     ███▀   ▀███     ",
  "    ███   █   ███    ",
  "   ███   ███   ███   ",
  "  ███   █████   ███  ",
  " ███   ███████   ███ ",
  "█████████████████████",
  "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
];

const ART = { skull: SKULL, ghost: GHOST, eye: EYE, warning: WARNING };

/** Dessin prêt à envoyer, ou null */
function art(name) {
  const drawing = ART[String(name).toLowerCase()];
  return drawing ? drawing.join("\n") : null;
}

const SIGIL_GLYPHS = ["⛧", "⛥", "⛦", "⛤", "☠", "☾", "☽", "✠", "✚", "⍟", "⎈", "⌖", "⏣", "⏥", "◈", "◉", "⬡", "⬢", "⯃", "⯄"];

/** Sceau occulte aléatoire (mais stable pour une graine) */
function sigil(seed = Date.now()) {
  const random = rng(seed);
  const ring = Array.from({ length: 9 }, () => random.pick(SIGIL_GLYPHS)).join(" ");
  const core = random.pick(SIGIL_GLYPHS);
  return [
    `  ${ring.slice(0, 17)}  `,
    ` ${ring.slice(0, 17)} `,
    `      ${core}      `,
    ` ${ring.slice(0, 17)} `,
    `  ${ring.slice(0, 17)}  `,
  ].join("\n");
}

const CURSE_WORDS = [
  "que ta batterie meure à 1 %",
  "que ton Wi-Fi tombe en pleine mise à jour",
  "que tes sauvegardes soient vides",
  "que ton disque claque à l'aube",
  "que ta RAM oublie ton travail",
  "que ton DNS mente pour toujours",
  "que ton écran gèle sur le curseur",
  "que tes logs soient effacés",
  "que ton horloge dérive de dix ans",
  "que ta corbeille ne se vide jamais",
];

/** Malédiction aléatoire */
function curse(seed = Date.now()) {
  const random = rng(seed);
  return random.pick(CURSE_WORDS);
}

module.exports = {
  seedOf,
  rng,
  smallCaps,
  fullwidth,
  banner,
  zalgo,
  glitch,
  frame,
  bar,
  art,
  sigil,
  curse,
  ART,
  FRAME,
  CURSE_WORDS,
};
