"use strict";
/**
 * T072 (base): panel translations, lib/admin/public/i18n/{en,fr}.json (FR-037).
 *
 *  - en and fr: same flat key set, same {placeholders}, no empty text;
 *  - errors.<code> for every envelope code and fields.<code> for every field code of admin-http-api.md 1.9,
 *    banners.<id> for the 11 banner ids of 3.3, settings.theme.<id> for the 10 themes, status.<id> for the
 *    client states, nav.<area> and <area>.title for the 14 areas;
 *  - settings.<KEY>.label and .desc for the 101 entries of the settings catalog (settings-catalog.md 8, item 4);
 *  - every literal t("...") key used under lib/admin/public/js/** exists in both catalogs (the fragments are merged:
 *    nothing counts as "pending" any more);
 *  - the fragments themselves are valid, complete, do not conflict, and are all merged (panel-*.json into the panel
 *    catalogs, bot-*.json into lang/{en,fr}.json);
 *  - the French texts say "panel d'administration" (never "panneau");
 *  - tools/merge-panel-i18n.js and the --pattern option of tools/merge-i18n.js behave.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { scan } = require("./helpers/jsScan");
const { assertNone } = require("./helpers/fakes");

const ROOT = path.resolve(__dirname, "..");
const CATALOG_DIR = path.join(ROOT, "lib", "admin", "public", "i18n");
const FRAGMENT_DIR = path.join(ROOT, "specs", "002-admin-panel", "i18n");
const JS_DIR = path.join(ROOT, "lib", "admin", "public", "js");
const CONTRACT = path.join(ROOT, "specs", "002-admin-panel", "contracts", "admin-http-api.md");
const LANG_DIR = path.join(ROOT, "lang");
const LANGS = ["en", "fr"];

const ENVELOPE_CODES = [
  "bad_request", "unauthenticated", "session_expired", "invalid_credentials", "token_invalid", "origin_mismatch",
  "csrf_invalid", "forbidden", "not_found", "no_qr", "method_not_allowed", "conflict", "busy", "confirmation_required",
  "setup_required", "not_connected", "bot_not_admin", "group_left", "already_paired", "not_configured", "not_pending",
  "not_editable", "limit_reached", "duplicate", "upload_in_progress", "update_unavailable", "downloads_active",
  "restore_token_invalid", "length_required", "payload_too_large", "unsupported_media_type", "validation_failed",
  "not_testable", "not_purgeable", "unsupported_file_type", "target_protected", "negative_balance", "wrong_passphrase",
  "backup_corrupted", "backup_unsupported_format", "backup_too_new", "backup_invalid_row", "login_blocked",
  "rate_limited", "internal_error", "whatsapp_error", "db_unavailable", "maintenance", "quota_exceeded",
];
const FIELD_CODES = [
  "required", "invalid_type", "invalid_format", "too_short", "too_long", "out_of_range", "not_allowed", "readonly",
  "unknown_setting", "unknown_field", "unknown_variable", "placeholder_mismatch", "bound_conflict", "invalid_timezone",
  "invalid_phone", "invalid_jid", "invalid_url", "invalid_emoji", "too_many_items", "duplicate", "in_past",
  "unknown_target", "forced_by_env", "not_applicable", "too_weak", "wrong_password", "same_as_current", "conflict",
  "negative_balance",
];
const BANNER_IDS = [
  "restart_needed", "update_restart", "undeclared_proxy", "no_https", "secret_key_lost", "db_unavailable", "no_owner",
  "maintenance", "restore_interrupted", "logged_out", "invalid_file_values",
];
const THEMES = ["general", "behavior", "api-keys", "responder", "moderation", "limits", "advanced", "boot", "alerts", "inactive"];
const STATUSES = ["idle", "connecting", "qr", "open", "reconnecting", "restarting", "stopped", "logged_out"];
const AREAS = [
  "dashboard", "settings", "commands", "groups", "pairing", "data", "broadcasts",
  "backup", "maintenance", "texts", "alerts", "logs", "stats", "audit",
];
// codes the server sends that the contract table of 1.9 does not list (the boot window of runtime.md section 15)
const EXTRA_SERVER_CODES = ["starting"];
// codes only the browser produces (no server answer carries them)
const CLIENT_ERROR_CODES = ["unknown", "network_error", "invalid_response", "aborted"];
const CLIENT_FIELD_CODES = ["unknown", "mismatch"];

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const placeholdersOf = (text) => (String(text).match(/\{[A-Za-z0-9_]+\}/g) || []).sort().join(",");

function flatten(obj, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(obj || {})) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) flatten(value, full, out);
    else out[full] = value;
  }
  return out;
}

const catalogs = Object.fromEntries(LANGS.map((l) => [l, flatten(readJson(path.join(CATALOG_DIR, `${l}.json`)))]));

function loadFragments() {
  if (!fs.existsSync(FRAGMENT_DIR)) return [];
  return fs
    .readdirSync(FRAGMENT_DIR)
    .filter((f) => /^panel-.+\.json$/.test(f))
    .sort()
    .map((file) => {
      try {
        const data = readJson(path.join(FRAGMENT_DIR, file));
        return { file, data, flat: Object.fromEntries(LANGS.map((l) => [l, flatten(data[l])])) };
      } catch (error) {
        return { file, error: error.message, flat: { en: {}, fr: {} } };
      }
    });
}
const fragments = loadFragments();
const defined = Object.fromEntries(LANGS.map((l) => [l, new Set(Object.keys(catalogs[l]))]));

// ---------------------------------------------------------------------------
// The catalogs
// ---------------------------------------------------------------------------

test("panel catalogs: en and fr have the same keys and placeholders, every text is a non-empty string", () => {
  const problems = [];
  for (const key of Object.keys(catalogs.en)) if (!(key in catalogs.fr)) problems.push(`"${key}" missing in fr.json`);
  for (const key of Object.keys(catalogs.fr)) if (!(key in catalogs.en)) problems.push(`"${key}" missing in en.json`);
  for (const key of Object.keys(catalogs.en)) {
    if (!(key in catalogs.fr)) continue;
    for (const lang of LANGS) {
      const value = catalogs[lang][key];
      if (typeof value !== "string" || value.trim() === "") problems.push(`"${key}" (${lang}) is empty or not a string`);
    }
    if (placeholdersOf(catalogs.en[key]) !== placeholdersOf(catalogs.fr[key])) {
      problems.push(`"${key}" placeholders differ (en ${placeholdersOf(catalogs.en[key]) || "none"} / fr ${placeholdersOf(catalogs.fr[key]) || "none"})`);
    }
  }
  assertNone(problems, "panel catalogs:");
});

test("panel catalogs: flat, sorted, no key is both a text and a prefix of another", () => {
  const problems = [];
  for (const lang of LANGS) {
    const raw = readJson(path.join(CATALOG_DIR, `${lang}.json`));
    const keys = Object.keys(raw);
    const sorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (keys.join("\n") !== sorted.join("\n")) problems.push(`${lang}.json is not sorted (run node tools/merge-panel-i18n.js to normalise it)`);
    if (Object.values(raw).some((v) => typeof v !== "string")) problems.push(`${lang}.json holds a nested value (the catalogs are flat)`);
    const set = new Set(keys);
    for (const key of keys) {
      const parts = key.split(".");
      for (let i = 1; i < parts.length; i++) if (set.has(parts.slice(0, i).join("."))) problems.push(`${lang}.json: "${parts.slice(0, i).join(".")}" is a text and "${key}" nests under it`);
    }
  }
  assertNone(problems, "catalog shape:");
});

test("the code lists of this test still match the contract (admin-http-api.md 1.9, 3.3; settings-catalog.md 4)", { skip: !fs.existsSync(CONTRACT) }, () => {
  const md = fs.readFileSync(CONTRACT, "utf8");
  const envelope = md.slice(md.indexOf("**Envelope codes**"), md.indexOf("**Field codes**"));
  const codes = [...envelope.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual([...codes].sort(), [...ENVELOPE_CODES].sort(), "envelope codes of 1.9");

  const fieldPara = md.slice(md.indexOf("**Field codes**")).split("\n\n")[0];
  const fields = [...fieldPara.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(fields)].sort(), [...FIELD_CODES].sort(), "field codes of 1.9");

  const banners = md.slice(md.indexOf("### 3.3 Banners"), md.indexOf("## 4. Coverage matrix"));
  const ids = [...banners.matchAll(/^\| `([a-z_]+)` \| (?:info|warn|error) \|/gm)].map((m) => m[1]);
  assert.deepEqual([...ids].sort(), [...BANNER_IDS].sort(), "banner ids of 3.3");

  const catalogPath = path.join(ROOT, "specs", "002-admin-panel", "contracts", "settings-catalog.md");
  if (fs.existsSync(catalogPath)) {
    const themes = fs.readFileSync(catalogPath, "utf8").split("## 4. Themes")[1].split("**Rule for")[0];
    const ids2 = [...themes.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]);
    assert.deepEqual([...ids2].sort(), [...THEMES].sort(), "setting themes of settings-catalog.md 4");
  }
});

test("panel catalogs define errors.<code>, fields.<code>, banners.<id>, settings.theme.<id>, status.<id>, nav.<area> and <area>.title", () => {
  const expected = [
    ...[...ENVELOPE_CODES, ...EXTRA_SERVER_CODES, ...CLIENT_ERROR_CODES].map((c) => `errors.${c}`),
    ...[...FIELD_CODES, ...CLIENT_FIELD_CODES].map((c) => `fields.${c}`),
    ...BANNER_IDS.map((id) => `banners.${id}`),
    ...THEMES.map((id) => `settings.theme.${id}`),
    ...STATUSES.map((id) => `status.${id}`),
    ...AREAS.map((a) => `nav.${a}`),
    ...AREAS.map((a) => `${a}.title`),
    "nav.account", "nav.logout", "app.name",
  ];
  const problems = [];
  for (const key of expected) {
    for (const lang of LANGS) if (typeof catalogs[lang][key] !== "string") problems.push(`${key} missing in ${lang}.json`);
  }
  assert.equal(ENVELOPE_CODES.length, 49);
  assert.equal(BANNER_IDS.length, 11);
  assert.equal(THEMES.length, 10);
  assertNone(problems, "expected panel keys:");
});

test("every code the HTTP layer can send has an errors.<code> text (STATUS_BY_CODE of lib/admin/http/response.js)", () => {
  const { STATUS_BY_CODE } = require("../lib/admin/http/response");
  const sent = Object.keys(STATUS_BY_CODE);
  assert.ok(sent.length >= ENVELOPE_CODES.length, "the status map covers the contract");
  const problems = [];
  for (const code of sent) {
    for (const lang of LANGS) if (typeof catalogs[lang][`errors.${code}`] !== "string") problems.push(`errors.${code} missing in ${lang}.json`);
  }
  const unlisted = sent.filter((code) => !ENVELOPE_CODES.includes(code) && !EXTRA_SERVER_CODES.includes(code));
  assert.deepEqual(unlisted, [], "a code was added to STATUS_BY_CODE: list it in ENVELOPE_CODES (contract 1.9) or EXTRA_SERVER_CODES");
  assertNone(problems, "error codes without a text:");
});

test("settings.<KEY>.label and settings.<KEY>.desc exist in both catalogs for all 101 settings catalog entries, and for nothing else", () => {
  const settingsCatalog = require("../lib/utils/settingsCatalog");
  const keys = settingsCatalog.entries.map((entry) => entry.key);
  assert.equal(keys.length, 101, "settings-catalog.md: 101 entries");
  assert.equal(new Set(keys).size, keys.length, "setting keys are unique");
  const problems = [];
  for (const lang of LANGS) {
    for (const key of keys) {
      for (const part of ["label", "desc"]) {
        const text = catalogs[lang][`settings.${key}.${part}`];
        if (typeof text !== "string" || text.trim() === "") problems.push(`settings.${key}.${part} missing or empty in ${lang}.json`);
      }
    }
    // a text for a setting that left the catalog is dead weight (and a sign that a rename was half done)
    const known = new Set(keys);
    for (const name of Object.keys(catalogs[lang])) {
      const match = /^settings\.([A-Z][A-Z0-9_]*)\.(label|desc)$/.exec(name);
      if (match && !known.has(match[1])) problems.push(`${name} (${lang}.json) names a setting that is not in the catalog`);
    }
  }
  assertNone(problems, "setting texts:");
});

test("settings.theme.<id> exists for every theme of the settings catalog, in both catalogs", () => {
  const { themes } = require("../lib/utils/settingsCatalog");
  assert.deepEqual([...themes].sort(), [...THEMES].sort(), "the themes of the catalog are the ones this test knows");
  for (const id of themes) {
    for (const lang of LANGS) assert.equal(typeof catalogs[lang][`settings.theme.${id}`], "string", `settings.theme.${id} in ${lang}.json`);
  }
});

test("the French texts say \"panel d'administration\", never \"panneau\" (panel catalog and bot texts)", () => {
  const files = [path.join(CATALOG_DIR, "fr.json"), path.join(LANG_DIR, "fr.json")];
  const problems = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/panneaux?\b/gi)) problems.push(`${path.relative(ROOT, file)}: "${match[0]}" at offset ${match.index}`);
  }
  assertNone(problems, "use \"panel\":");
  assert.match(catalogs.fr["app.name"], /^Panel d'administration$/);
});

test("panel catalogs: the texts that need parameters keep the names the code passes", () => {
  const needs = {
    "errors.login_blocked": ["retryAfter"],
    "errors.rate_limited": ["retryAfter"],
    "errors.internal_error": ["requestId"],
    "errors.unknown": ["code"],
    "errors.update_unavailable": ["blockers"],
    "errors.payload_too_large": ["maxBytes"],
    "errors.backup_too_new": ["backupVersion", "currentVersion"],
    "errors.backup_invalid_row": ["field", "index", "model"],
    "fields.too_short": ["min"],
    "fields.too_long": ["max"],
    "fields.out_of_range": ["max", "min"],
    "fields.not_allowed": ["allowed"],
    "fields.unknown_variable": ["names"],
    "fields.placeholder_mismatch": ["expected"],
    "fields.bound_conflict": ["other"],
    "fields.too_many_items": ["max"],
    "fields.unknown_target": ["indices"],
    "fields.conflict": ["version"],
    "banners.restart_needed": ["keys"],
    "banners.update_restart": ["from", "to"],
    "banners.undeclared_proxy": ["headers"],
    "banners.secret_key_lost": ["keys"],
    "banners.maintenance": ["phase"],
    "banners.invalid_file_values": ["keys"],
    "auth.blocked": ["retryAfter"],
    "auth.password_rule": ["min"],
    "secret.set_last4": ["last4"],
    "common.page_of": ["page", "pages", "total"],
  };
  const problems = [];
  for (const [key, names] of Object.entries(needs)) {
    for (const lang of LANGS) {
      const have = placeholdersOf(catalogs[lang][key]);
      const want = names.map((n) => `{${n}}`).sort().join(",");
      if (have !== want) problems.push(`${key} (${lang}): placeholders ${have || "none"}, the code passes ${want}`);
    }
  }
  assertNone(problems, "placeholders:");
});

// ---------------------------------------------------------------------------
// Fragments (panel-*.json written by the W1 agents)
// ---------------------------------------------------------------------------

test("panel fragments are valid and complete (en and fr: same keys, same placeholders) and do not conflict", (t) => {
  t.diagnostic(`${fragments.length} panel fragment file(s) in specs/002-admin-panel/i18n/`);
  const problems = [];
  const seen = new Map();
  for (const fragment of fragments) {
    if (fragment.error) {
      problems.push(`${fragment.file}: invalid JSON (${fragment.error})`);
      continue;
    }
    for (const lang of LANGS) {
      if (!isPlainObject(fragment.data[lang])) problems.push(`${fragment.file}: missing "${lang}" object`);
    }
    const { en, fr } = fragment.flat;
    for (const key of Object.keys(en)) if (!(key in fr)) problems.push(`${fragment.file}: "${key}" missing in fr`);
    for (const key of Object.keys(fr)) if (!(key in en)) problems.push(`${fragment.file}: "${key}" missing in en`);
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(fragment.flat[lang])) {
        if (typeof value !== "string" || value.trim() === "") problems.push(`${fragment.file}: "${key}" (${lang}) is empty or not a string`);
        const id = `${lang}:${key}`;
        if (seen.has(id) && seen.get(id).value !== value) problems.push(`${key} (${lang}) differs between ${seen.get(id).file} and ${fragment.file}`);
        seen.set(id, { file: fragment.file, value });
      }
    }
    for (const key of Object.keys(en)) {
      if (key in fr && placeholdersOf(en[key]) !== placeholdersOf(fr[key])) problems.push(`${fragment.file}: "${key}" placeholders differ between en and fr`);
    }
  }
  assertNone(problems, "panel fragments:");
});

test("every panel fragment is merged: its keys and texts are in lib/admin/public/i18n/{en,fr}.json", () => {
  const problems = [];
  for (const fragment of fragments) {
    if (fragment.error) continue; // reported by the test above
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(fragment.flat[lang])) {
        if (!(key in catalogs[lang])) problems.push(`${fragment.file}: "${key}" is not in ${lang}.json (run node tools/merge-panel-i18n.js)`);
        else if (catalogs[lang][key] !== value) problems.push(`${fragment.file}: "${key}" differs from ${lang}.json (the fragment wins on the next merge)`);
      }
    }
  }
  assertNone(problems, "unmerged panel fragments:");
});

test("every bot fragment is merged: its keys and texts are in lang/{en,fr}.json", () => {
  const botFiles = fs.readdirSync(FRAGMENT_DIR).filter((f) => /^bot-.+\.json$/.test(f)).sort();
  assert.ok(botFiles.length >= 8, "the bot fragments of feature 002 are there");
  const lang = Object.fromEntries(LANGS.map((l) => [l, flatten(readJson(path.join(LANG_DIR, `${l}.json`)))]));
  const problems = [];
  for (const file of botFiles) {
    const data = readJson(path.join(FRAGMENT_DIR, file));
    for (const l of LANGS) {
      for (const [key, value] of Object.entries(flatten(data[l]))) {
        if (!(key in lang[l])) problems.push(`${file}: "${key}" is not in lang/${l}.json (run node tools/merge-i18n.js --frag-dir specs/002-admin-panel/i18n --pattern "bot-*.json")`);
        else if (lang[l][key] !== value) problems.push(`${file}: "${key}" differs from lang/${l}.json`);
      }
    }
  }
  assertNone(problems, "unmerged bot fragments:");
});

// ---------------------------------------------------------------------------
// Keys used by the code
// ---------------------------------------------------------------------------

function listMjs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMjs(full));
    else if (entry.name.endsWith(".mjs")) out.push(full);
  }
  return out.sort();
}

test("every literal t(\"...\") key under lib/admin/public/js/** exists in en and fr", (t) => {
  const missing = [];
  const used = new Set();
  let dynamic = 0;
  for (const file of listMjs(JS_DIR)) {
    const src = fs.readFileSync(file, "utf8");
    const { masked, tokens } = scan(src);
    const lineOf = (index) => src.slice(0, index).split("\n").length;
    for (const token of tokens) {
      const before = masked.slice(Math.max(0, token.start - 30), token.start);
      if (!/(?<![\w$.])t\s*\(\s*$/.test(before)) continue;
      const after = masked.slice(token.end, token.end + 30);
      if (!/^\s*[,)]/.test(after) || token.hasInterpolation) {
        dynamic++;
        continue;
      }
      used.add(token.text);
      const absent = LANGS.filter((l) => !defined[l].has(token.text));
      if (absent.length) missing.push(`${path.relative(ROOT, file)}:${lineOf(token.start)}  "${token.text}"  missing in ${absent.join(", ")}`);
    }
  }
  const unused = [...defined.en].filter((k) => !used.has(k)).length;
  t.diagnostic(`${used.size} literal key(s) used, ${dynamic} dynamic call(s) skipped, ${unused} defined key(s) not used literally (dynamic families such as errors.*, fields.*, nav.* included)`);
  assertNone(missing, "t() keys without a translation:");
});

test("every t(`prefix${...}`) call names a family that exists: some key of each catalog starts with the static prefix", (t) => {
  const problems = [];
  const prefixes = new Set();
  for (const file of listMjs(JS_DIR)) {
    const src = fs.readFileSync(file, "utf8");
    const { masked, tokens } = scan(src);
    const lineOf = (index) => src.slice(0, index).split("\n").length;
    for (const token of tokens) {
      if (token.quote !== "`" || !token.hasInterpolation || token.nested) continue;
      const before = masked.slice(Math.max(0, token.start - 30), token.start);
      if (!/(?<![\w$.])t\s*\(\s*$/.test(before)) continue;
      const prefix = src.slice(token.start + 1, token.end - 1).split("${")[0];
      if (!/^[a-z][a-z0-9_]*\.[A-Za-z0-9_.]*$/.test(prefix)) continue; // a key that is built entirely at run time
      prefixes.add(prefix);
      for (const lang of LANGS) {
        if (!Object.keys(catalogs[lang]).some((key) => key.startsWith(prefix))) problems.push(`${path.relative(ROOT, file)}:${lineOf(token.start)}  t(\`${prefix}\${...}\`) matches no key in ${lang}.json`);
      }
    }
  }
  t.diagnostic(`${prefixes.size} dynamic key prefix(es) checked`);
  assert.ok(prefixes.size >= 10, "the scan finds the dynamic calls");
  assertNone(problems, "dynamic t() families:");
});

test("dynamic key families used by the shell are complete", () => {
  // t(`nav.${area}`), t(`status.${s}`), t(`banners.${id}`), t(`jobs.phase.${p}`), t(`jobs.type.${y}`), t(`account.language_${l}`), t(`account.theme_${x}`)
  const families = {
    "jobs.type.": ["restart", "update.check", "update.apply", "ytdlp.update", "restore", "broadcast"],
    "jobs.phase.": ["stop", "settings", "start", "ready", "fetch", "merge", "install", "verify", "maintenance", "pre_backup", "database", "session", "finalize", "restarting"],
    "account.language_": ["fr", "en"],
    "account.theme_": ["auto", "light", "dark"],
  };
  const problems = [];
  for (const [prefix, names] of Object.entries(families)) {
    for (const name of names) for (const lang of LANGS) if (typeof catalogs[lang][`${prefix}${name}`] !== "string") problems.push(`${prefix}${name} missing in ${lang}.json`);
  }
  assertNone(problems, "dynamic key families:");
});

// ---------------------------------------------------------------------------
// tools/merge-panel-i18n.js and tools/merge-i18n.js --pattern
// ---------------------------------------------------------------------------

function sandbox(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-i18n-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return dir;
}

const runTool = (tool, args) => {
  const res = spawnSync(process.execPath, [path.join(ROOT, "tools", tool), ...args], { encoding: "utf8" });
  return { code: res.status, out: res.stdout, err: res.stderr };
};
const readOut = (dir, rel) => fs.readFileSync(path.join(dir, rel), "utf8");

test("tools/merge-panel-i18n.js merges flat fragments, sorted, fragment wins, --dry-run writes nothing", (t) => {
  const dir = sandbox({
    "cat/en.json": { "b.key": "B", "a.key": "A {n}" },
    "cat/fr.json": { "b.key": "B fr", "a.key": "A fr {n}" },
    "frag/panel-x.json": { en: { "c.key": "C", "a.key": "A2 {n}" }, fr: { "c.key": "C fr", "a.key": "A2 fr {n}" } },
    "frag/bot-ignored.json": { en: { "z.key": "Z" }, fr: {} },
    "frag/README.md": "# not a fragment",
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const args = ["--catalog-dir", path.join(dir, "cat"), "--frag-dir", path.join(dir, "frag")];
  const before = readOut(dir, "cat/en.json");

  const dry = runTool("merge-panel-i18n.js", [...args, "--dry-run"]);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /Dry run: nothing written/);
  assert.equal(readOut(dir, "cat/en.json"), before, "dry run leaves the catalog alone");

  const real = runTool("merge-panel-i18n.js", args);
  assert.equal(real.code, 0, real.err);
  const en = JSON.parse(readOut(dir, "cat/en.json"));
  assert.deepEqual(Object.keys(en), ["a.key", "b.key", "c.key"], "flat and sorted");
  assert.equal(en["a.key"], "A2 {n}", "the fragment wins");
  assert.equal(JSON.parse(readOut(dir, "cat/fr.json"))["c.key"], "C fr");
  assert.equal(runTool("merge-panel-i18n.js", [...args, "--dry-run", "--verbose"]).out.includes("+"), false, "a second run changes nothing");
});

test("tools/merge-panel-i18n.js refuses a missing translation, a conflict, a placeholder mismatch: exit 1, nothing written", (t) => {
  const base = { "cat/en.json": { "a.key": "A" }, "cat/fr.json": { "a.key": "A fr" } };
  const cases = {
    "missing translation": { "frag/panel-x.json": { en: { "n.key": "N" }, fr: {} } },
    "conflict": {
      "frag/panel-x.json": { en: { "n.key": "1" }, fr: { "n.key": "1 fr" } },
      "frag/panel-y.json": { en: { "n.key": "2" }, fr: { "n.key": "2 fr" } },
    },
    "placeholder mismatch": { "frag/panel-x.json": { en: { "n.key": "Hi {name}" }, fr: { "n.key": "Salut {nom}" } } },
    "text and nested key": { "frag/panel-x.json": { en: { "a.key.sub": "S" }, fr: { "a.key.sub": "S fr" } } },
    "invalid JSON": { "frag/panel-x.json": "{ not json" },
  };
  for (const [name, files] of Object.entries(cases)) {
    const dir = sandbox({ ...base, ...files });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const before = [readOut(dir, "cat/en.json"), readOut(dir, "cat/fr.json")];
    const res = runTool("merge-panel-i18n.js", ["--catalog-dir", path.join(dir, "cat"), "--frag-dir", path.join(dir, "frag")]);
    assert.equal(res.code, 1, `${name}: exit code`);
    assert.match(res.err, /nothing written/, name);
    assert.deepEqual([readOut(dir, "cat/en.json"), readOut(dir, "cat/fr.json")], before, `${name}: catalogs untouched`);
  }
});

test("tools/merge-i18n.js --pattern selects fragment files; the default keeps the 001 behaviour", (t) => {
  const dir = sandbox({
    "lang/en.json": { a: { b: "x" } },
    "lang/fr.json": { a: { b: "x" } },
    "frag/bot-one.json": { en: { "a.c": "1" }, fr: { "a.c": "2" } },
    "frag/panel-one.json": { en: { "p.q": "1" }, fr: { "p.q": "2" } },
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const args = ["--lang-dir", path.join(dir, "lang"), "--frag-dir", path.join(dir, "frag")];

  const bot = runTool("merge-i18n.js", [...args, "--pattern", "bot-*.json", "--dry-run", "--verbose"]);
  assert.equal(bot.code, 0, bot.err);
  assert.match(bot.out, /Fragments: 1 \(bot-one\.json\)/);
  assert.match(bot.out, /\+ a\.c/);
  assert.doesNotMatch(bot.out, /p\.q/);

  const all = runTool("merge-i18n.js", [...args, "--dry-run"]);
  assert.match(all.out, /Fragments: 2 \(bot-one\.json, panel-one\.json\)/, "no --pattern: every .json file, as before");

  const real = runTool("merge-i18n.js", [...args, "--pattern", "bot-*.json"]);
  assert.equal(real.code, 0, real.err);
  assert.deepEqual(JSON.parse(readOut(dir, "lang/en.json")), { a: { b: "x", c: "1" } });

  const bad = runTool("merge-i18n.js", [...args, "--pattern", "../x"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /file name glob/);
});

test("the real panel catalogs are in the canonical merged form (a merge with no fragment changes nothing)", () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, "tools", "merge-panel-i18n.js"), "--dry-run", "--pattern", "panel-never-matches-*.json"], { encoding: "utf8" });
  assert.match(out, /en\.json: 0 added, 0 updated, 0 unchanged/);
  const dir = sandbox({});
  try {
    for (const lang of LANGS) fs.copyFileSync(path.join(CATALOG_DIR, `${lang}.json`), path.join(dir, `${lang}.json`));
    fs.mkdirSync(path.join(dir, "frag"));
    const before = LANGS.map((l) => fs.readFileSync(path.join(dir, `${l}.json`), "utf8"));
    const res = runTool("merge-panel-i18n.js", ["--catalog-dir", dir, "--frag-dir", path.join(dir, "frag")]);
    assert.equal(res.code, 0, res.err);
    assert.deepEqual(LANGS.map((l) => fs.readFileSync(path.join(dir, `${l}.json`), "utf8")), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
