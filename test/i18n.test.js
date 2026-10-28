"use strict";
/**
 * T023: translations and user-facing literals (static, no bot code is executed).
 *
 *  - every literal getLang("...") key of plugins/, lib/, index.js, panel.js exists in en AND fr;
 *  - en and fr have the same flat key set (and the same {n} placeholders);
 *  - lint: .reply(...) / sendMessage(..., { text|caption: ... }) must not receive a string literal
 *    (or template literal) containing letters outside ${}. Emoji / punctuation-only literals are fine.
 *    Escape hatch for a deliberate exception: a comment `// i18n-ignore` on the same or the previous line.
 *
 * Keys added by the plugin agents live in fragments until `node tools/merge-i18n.js` is run: this test
 * checks the merged view (lang files + fragments). Two fragment sources count as "pending":
 *   - specs/001-audit-fix-commands/i18n/*.json (every file);
 *   - specs/002-admin-panel/i18n/bot-*.json (bot texts of the admin panel feature; its panel-*.json
 *     fragments feed the panel catalogs, not lang/*.json, and are checked by test/admin-i18n.test.js).
 * The source scan below covers plugins/, lib/ (so lib/admin/**), index.js and panel.js.
 */

const test = require("node:test");
const fs = require("fs");
const path = require("path");
const { scan, lineMap, matchBracket, splitTopLevel, valueEnd } = require("./helpers/jsScan");
const { assertNone } = require("./helpers/fakes");

const ROOT = path.resolve(__dirname, "..");
const FRAGMENT_SOURCES = [
  { dir: path.join(ROOT, "specs", "001-audit-fix-commands", "i18n"), accept: (file) => file.endsWith(".json") },
  { dir: path.join(ROOT, "specs", "002-admin-panel", "i18n"), accept: (file) => /^bot-.+\.json$/.test(file) },
];
const LANGS = ["en", "fr"];

// ---------------------------------------------------------------------------
// Translations
// ---------------------------------------------------------------------------

function flatten(obj, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(obj || {})) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) flatten(value, full, out);
    else out[full] = value;
  }
  return out;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const langFiles = Object.fromEntries(LANGS.map((l) => [l, flatten(readJson(path.join(ROOT, "lang", `${l}.json`)))]));

function loadFragments() {
  const out = [];
  for (const { dir, accept } of FRAGMENT_SOURCES) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter(accept).sort()) {
      const file = path.relative(ROOT, path.join(dir, name));
      try {
        const data = readJson(path.join(dir, name));
        out.push({ file, data, flat: Object.fromEntries(LANGS.map((l) => [l, flatten(data[l])])) });
      } catch (error) {
        out.push({ file, error: error.message, flat: { en: {}, fr: {} } });
      }
    }
  }
  return out;
}
const fragments = loadFragments();

// Merged view: lang file + fragments (a fragment wins over the lang file, like tools/merge-i18n.js)
const merged = Object.fromEntries(
  LANGS.map((l) => [l, Object.assign({}, langFiles[l], ...fragments.map((f) => f.flat[l]))]),
);
const pendingKeys = new Set();
for (const fragment of fragments) {
  for (const l of LANGS) {
    for (const [key, value] of Object.entries(fragment.flat[l])) {
      if (langFiles[l][key] !== value) pendingKeys.add(key);
    }
  }
}

const placeholdersOf = (text) => (String(text).match(/\{\d+\}/g) || []).sort().join(",");

const fmt = (list, max = 60) =>
  list.slice(0, max).join("\n  ") + (list.length > max ? `\n  ... and ${list.length - max} more` : "");

test("i18n sources", (t) => {
  const note =
    `merged view = lang/{en,fr}.json (${Object.keys(langFiles.en).length} keys) + ${fragments.length} fragment file(s) ` +
    `from specs/001-audit-fix-commands/i18n/ and specs/002-admin-panel/i18n/bot-*.json ` +
    `(${pendingKeys.size} key(s) not merged into lang/*.json yet; run node tools/merge-i18n.js to merge them)`;
  t.diagnostic(note);
  console.log(`# NOTE ${note}`);
});

test("lang/en.json and lang/fr.json have the same flat key set", () => {
  const onlyEn = Object.keys(langFiles.en).filter((k) => !(k in langFiles.fr));
  const onlyFr = Object.keys(langFiles.fr).filter((k) => !(k in langFiles.en));
  assertNone([...onlyEn.map((k) => `"${k}" only in en.json`), ...onlyFr.map((k) => `"${k}" only in fr.json`)], "lang files diverge:");
});

test("i18n fragments are valid and complete (en and fr: same keys, same placeholders)", () => {
  const problems = [];
  for (const fragment of fragments) {
    if (fragment.error) {
      problems.push(`${fragment.file}: invalid JSON (${fragment.error})`);
      continue;
    }
    for (const l of LANGS) {
      if (!fragment.data[l] || typeof fragment.data[l] !== "object") problems.push(`${fragment.file}: missing "${l}" object`);
    }
    const en = fragment.flat.en;
    const fr = fragment.flat.fr;
    for (const key of Object.keys(en)) if (!(key in fr)) problems.push(`${fragment.file}: "${key}" missing in fr`);
    for (const key of Object.keys(fr)) if (!(key in en)) problems.push(`${fragment.file}: "${key}" missing in en`);
    for (const key of Object.keys(en)) {
      if (key in fr && placeholdersOf(en[key]) !== placeholdersOf(fr[key])) {
        problems.push(`${fragment.file}: "${key}" placeholders differ (en ${placeholdersOf(en[key]) || "none"} / fr ${placeholdersOf(fr[key]) || "none"})`);
      }
      for (const l of LANGS) {
        if (key in fragment.flat[l] && typeof fragment.flat[l][key] !== "string") problems.push(`${fragment.file}: "${key}" (${l}) is not a string`);
      }
    }
  }
  assertNone(problems, "i18n fragments:");
});

test("merged translations: same key set, same placeholders, no empty value", () => {
  const problems = [];
  for (const key of Object.keys(merged.en)) if (!(key in merged.fr)) problems.push(`"${key}" missing in fr`);
  for (const key of Object.keys(merged.fr)) if (!(key in merged.en)) problems.push(`"${key}" missing in en`);
  for (const key of Object.keys(merged.en)) {
    if (!(key in merged.fr)) continue;
    for (const l of LANGS) {
      const value = merged[l][key];
      if (typeof value !== "string" || value.trim() === "") problems.push(`"${key}" (${l}) is empty or not a string`);
    }
    if (placeholdersOf(merged.en[key]) !== placeholdersOf(merged.fr[key])) {
      problems.push(`"${key}" placeholders differ (en ${placeholdersOf(merged.en[key]) || "none"} / fr ${placeholdersOf(merged.fr[key]) || "none"})`);
    }
  }
  assertNone(problems, "merged translations (lang files + fragments):");
});

// ---------------------------------------------------------------------------
// Source scan
// ---------------------------------------------------------------------------

function listJs(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...listJs(rel));
    } else if (entry.name.endsWith(".js")) out.push(rel);
  }
  return out.sort();
}

let scanned = null;
function sources() {
  if (scanned) return scanned;
  const files = [...listJs("plugins"), ...listJs("lib"), "index.js", "panel.js"].filter((f) => fs.existsSync(path.join(ROOT, f)));
  scanned = files.map((file) => {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    return { file, src, lines: src.split("\n"), lineOf: lineMap(src), ...scan(src) };
  });
  return scanned;
}

test("the source scan covers lib/admin/** (panel server code)", () => {
  const scannedFiles = new Set(sources().map((f) => f.file));
  const missing = listJs(path.join("lib", "admin")).filter((file) => !scannedFiles.has(file));
  assertNone(missing, "lib/admin files not scanned for getLang keys and user-facing literals:");
});

test("every literal getLang(\"...\") key exists in en and fr", (t) => {
  const missing = [];
  let literal = 0;
  let dynamic = 0;
  for (const f of sources()) {
    for (const token of f.tokens) {
      const before = f.masked.slice(Math.max(0, token.start - 40), token.start);
      if (!/\bgetLang\s*\(\s*$/.test(before)) continue;
      const after = f.masked.slice(token.end, token.end + 40);
      if (!/^\s*[,)]/.test(after) || token.hasInterpolation) {
        dynamic++;
        continue;
      }
      literal++;
      const key = token.text;
      const absent = LANGS.filter((l) => typeof merged[l][key] !== "string");
      if (absent.length) missing.push(`${f.file}:${f.lineOf(token.start)}  "${key}"  missing in ${absent.join(", ")}`);
    }
  }
  t.diagnostic(`${literal} literal getLang key(s) checked, ${dynamic} dynamic call(s) skipped`);
  assertNone(missing, "getLang keys without translation (lang files + fragments):");
});

// ---------------------------------------------------------------------------
// Lint: user-facing literals
// ---------------------------------------------------------------------------

const stripEscapes = (s) => s.replace(/\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, "");
const hasLetters = (s) => /\p{L}/u.test(stripEscapes(s));

const CALLS = [
  { re: /(?:\.|\?\.)\s*reply\s*\(/g, label: ".reply(", positional: [0] },
  { re: /\bsendMessage\s*\(/g, label: "sendMessage(", positional: [] },
  { re: /(?:\.|\?\.)\s*(?:sendImage|sendVideo)\s*\(/g, label: ".sendImage/Video(", positional: [1] },
  { re: /(?:\.|\?\.)\s*sendDocument\s*\(/g, label: ".sendDocument(", positional: [] },
];

function depthBetween(skeleton, from, to) {
  let depth = 0;
  for (let k = from; k < to; k++) {
    const c = skeleton[k];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
  }
  return depth;
}

function lintFile(f) {
  const problems = [];
  const S = f.skeleton;
  const top = f.tokens.filter((t) => !t.nested);

  const report = (token, label) => {
    const line = f.lineOf(token.start);
    if (/i18n-ignore/.test(f.lines[line - 1] || "") || /i18n-ignore/.test(f.lines[line - 2] || "")) return;
    const shown = f.src.slice(token.start, Math.min(token.end, token.start + 60)).replace(/\s+/g, " ");
    problems.push(`${f.file}:${line}  ${label}  ${shown}`);
  };

  // Literals sitting at the top level of the expression [start, end)
  const checkExpr = (span, label) => {
    for (const token of top) {
      if (token.start < span.start || token.end > span.end) continue;
      if (depthBetween(S, span.start, token.start) !== 0) continue;
      if (!hasLetters(token.text)) continue;
      const before = S.slice(span.start, token.start).trimEnd();
      const after = S.slice(token.end, span.end).trimStart();
      if (/(?:===|!==|==|!=)$/.test(before) || /^(?:===|!==|==|!=)/.test(after)) continue; // a comparison, not a message
      report(token, label);
    }
  };

  for (const call of CALLS) {
    call.re.lastIndex = 0;
    let match;
    while ((match = call.re.exec(S))) {
      const open = match.index + match[0].length - 1;
      const close = matchBracket(S, open);
      if (close < 0) continue;
      const args = splitTopLevel(S, open + 1, close);
      for (const index of call.positional) if (args[index]) checkExpr(args[index], call.label);

      // { text: ..., caption: ... } object properties anywhere in the arguments
      const inner = S.slice(open + 1, close);
      const propRe = /(?<![\w$.])(text|caption)\s*:(?!:)/g;
      let prop;
      while ((prop = propRe.exec(inner))) {
        const keyStart = open + 1 + prop.index;
        let k = keyStart - 1;
        while (k >= open + 1 && /\s/.test(S[k])) k--;
        if (k >= open + 1 && S[k] !== "{" && S[k] !== ",") continue; // e.g. a ternary `a ? text : b`
        let valueStart = keyStart + prop[0].length;
        while (valueStart < close && /\s/.test(S[valueStart])) valueStart++;
        checkExpr({ start: valueStart, end: valueEnd(S, valueStart, close) }, `${call.label} ${prop[1]}:`);
      }
    }
  }
  return problems;
}

test("no user-facing literal text in reply() / sendMessage text|caption (must go through getLang)", (t) => {
  const all = [];
  const perFile = new Map();
  for (const f of sources()) {
    const problems = [...new Set(lintFile(f))];
    if (problems.length) perFile.set(f.file, problems.length);
    all.push(...problems);
  }
  const summary = [...perFile].sort((a, b) => b[1] - a[1]).map(([file, n]) => `${file}: ${n}`).join(", ");
  assertNone(all, `user-facing literal(s) in ${perFile.size} file(s) (use getLang, or "// i18n-ignore" for a deliberate exception); per file: ${summary}\n  file:line  call  literal`);
});
