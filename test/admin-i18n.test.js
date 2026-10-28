"use strict";
/**
 * T072 (base): panel translations, lib/admin/public/i18n/{en,fr}.json (FR-037).
 *
 *  - en and fr: same flat key set, same {placeholders}, no empty text;
 *  - errors.<code> for every envelope code and fields.<code> for every field code of admin-http-api.md 1.9,
 *    banners.<id> for the 11 banner ids of 3.3, settings.theme.<id> for the 10 themes, status.<id> for the
 *    client states, nav.<area> and <area>.title for the 14 areas;
 *  - every literal t("...") key used under lib/admin/public/js/** exists in both catalogs
 *    (fragments specs/002-admin-panel/i18n/panel-*.json count as defined until W2-A merges them);
 *  - the fragments themselves are valid, complete and do not conflict;
 *  - tools/merge-panel-i18n.js and the --pattern option of tools/merge-i18n.js behave.
 *
 * W2-A completes this file (settings.<KEY>.label/.desc for the 101 catalog entries, no pending fragment).
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
const defined = Object.fromEntries(LANGS.map((l) => [l, new Set([...Object.keys(catalogs[l]), ...fragments.flatMap((f) => Object.keys(f.flat[l]))])]));

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
    ...[...ENVELOPE_CODES, ...CLIENT_ERROR_CODES].map((c) => `errors.${c}`),
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
  t.diagnostic(`${fragments.length} panel fragment file(s) pending in specs/002-admin-panel/i18n/`);
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

test("every literal t(\"...\") key under lib/admin/public/js/** exists in en and fr (pending panel fragments count as defined)", (t) => {
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
