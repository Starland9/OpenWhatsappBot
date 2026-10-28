"use strict";

/**
 * Settings catalog + store (specs/002-admin-panel T026-T030, T034; contracts/settings-catalog.md,
 * contracts/runtime.md section 1).
 *
 *  - catalog invariants (101 entries, 67 editable, 34 read-only, 22 secrets, 5 "restart", U19 defaults);
 *  - tier precedence: runtime > override > environment > default, '' as a deliberate override;
 *  - the validation table of settings-catalog.md section 6 and all-or-nothing batches;
 *  - versions: stale write, lost insert race, version continuity after a reset;
 *  - restart bookkeeping, read-only keys, secrets at rest, redactor registration, change events;
 *  - maintenance / database failures, backup export and import;
 *  - SC-003: every editable "immediate" entry applies on the next read of config[configProp];
 *  - the per-key mutex.
 *
 * In-memory database, a temporary secret-box directory, no network.
 */

const { test, describe, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const fakes = require("./helpers/fakes");

const config = fakes.setupEnv();
const catalog = require("../lib/utils/settingsCatalog");
const settingsStore = require("../lib/utils/settingsStore");
const mutex = require("../lib/utils/mutex");
const { createSecretBox } = require("../lib/utils/secretBox");

const {
  createSettingsStore,
  SettingsValidationError,
  SettingsConflictError,
  SettingsConfirmationError,
  SettingsStoreError,
} = settingsStore;

let db;
let tmp;
let box;

before(async () => {
  db = await fakes.syncDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-settings-"));
  box = createSecretBox({ dir: path.join(tmp, "data") });
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.SettingOverride.destroy({ where: {} });
  fs.rmSync(path.join(tmp, "data"), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeRedactor() {
  const values = new Map();
  return {
    values,
    register: (name, value) => values.set(name, value),
    unregister: (name) => values.delete(name),
    scrub: (text) => text,
  };
}

function fakeLogger(lines) {
  const make = (level) => (fields, message) => lines.push({ level, fields, message });
  return { error: make("error"), warn: make("warn"), info: make("info"), debug: make("debug") };
}

/** A fresh store over the in-memory database, with its own environment */
function makeStore(options = {}) {
  const redactor = options.redactor || fakeRedactor();
  const logs = [];
  const store = createSettingsStore({
    env: options.env || {},
    models: options.models === undefined ? db : options.models,
    secretBox: options.secretBox || box,
    redactor,
    logger: fakeLogger(logs),
    maintenanceMode: options.maintenanceMode || { isActive: () => false },
    now: options.now,
  });
  return { store, redactor, logs };
}

async function loaded(options) {
  const made = makeStore(options);
  await made.store.load();
  return made;
}

const rowOf = (key) => db.SettingOverride.findByPk(key, { raw: true });
const entry = (key) => catalog.byKey.get(key);
const fieldOf = async (promise, key) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SettingsValidationError, `validation error expected, got ${error && error.name}`);
    return error.fields[key];
  }
  assert.fail("a validation error was expected");
  return undefined;
};

// ---------------------------------------------------------------------------
// Catalog invariants (settings-catalog.md section 8, items 3 and 10)
// ---------------------------------------------------------------------------

describe("catalog invariants", () => {
  const entries = catalog.entries;

  test("101 entries: 67 editable, 34 read-only (13 startup, 21 inactive), 22 secrets, 5 restart", () => {
    assert.equal(entries.length, 101);
    assert.equal(entries.filter((e) => !e.readonly).length, 67);
    assert.equal(entries.filter((e) => e.readonly).length, 34);
    assert.equal(entries.filter((e) => e.theme === "boot").length, 13);
    assert.equal(entries.filter((e) => e.theme === "inactive").length, 21);
    assert.equal(entries.filter((e) => e.secret).length, 22);
    assert.deepEqual(
      entries.filter((e) => e.effect === "restart").map((e) => e.key).sort(),
      ["ALWAYS_ONLINE", "BAILEYS_LOG_LVL", "CACHE_CLEANUP_INTERVAL", "CONVERSATION_UPDATE_INTERVAL", "MEMORY_CLEANUP_INTERVAL"],
    );
  });

  test("themes: 10 ids, and the documented count per theme", () => {
    assert.deepEqual([...catalog.themes], [
      "general", "behavior", "api-keys", "responder", "moderation", "limits", "advanced", "boot", "alerts", "inactive",
    ]);
    const count = (theme) => entries.filter((e) => e.theme === theme).length;
    assert.deepEqual(
      { general: count("general"), behavior: count("behavior"), apiKeys: count("api-keys"), responder: count("responder"), moderation: count("moderation"), limits: count("limits"), advanced: count("advanced"), alerts: count("alerts") },
      { general: 6, behavior: 11, apiKeys: 16, responder: 9, moderation: 5, limits: 5, advanced: 9, alerts: 6 },
    );
  });

  test("keys are unique and well formed; themes are known", () => {
    const keys = entries.map((e) => e.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(catalog.byKey.size, 101);
    for (const e of entries) {
      assert.match(e.key, /^[A-Z][A-Z0-9_]{1,63}$/);
      assert.ok(catalog.themes.includes(e.theme), e.key);
      assert.ok(["bool", "int", "string", "text", "enum", "list", "url"].includes(e.type), e.key);
      assert.ok(["immediate", "restart", "boot-only"].includes(e.effect), e.key);
      assert.ok(["env", "model", "file"].includes(e.source), e.key);
    }
  });

  test("readonly for every boot-only and inactive entry; inactive iff theme is inactive", () => {
    for (const e of entries) {
      if (e.effect === "boot-only" || e.inactive) assert.equal(e.readonly, true, e.key);
      assert.equal(e.inactive, e.theme === "inactive", e.key);
      if (e.inactive) {
        assert.equal(e.effect, "boot-only", e.key);
        assert.deepEqual(e.onChange, [], e.key);
        assert.equal(e.testService, null, e.key);
      }
    }
    assert.equal(entry("YTDLP_PATH").readonly, true);
  });

  test("secrets have a mask; the others do not need one", () => {
    for (const e of entries.filter((x) => x.secret)) assert.ok(["last4", "scheme", "url"].includes(e.mask), e.key);
    assert.equal(entry("DATABASE_URL").mask, "scheme");
    assert.equal(entry("BACKEND_URL").mask, "url");
    assert.equal(entry("PREFIX").mask, "none");
  });

  test("special entries carry their documented properties", () => {
    assert.equal(entry("SUDO").confirm, "owners_empty");
    assert.equal(entry("WARN_MESSAGE").fileTransform, "unescapeNewlines");
    assert.equal(entry("WARN_KICK_MESSAGE").fileTransform, "unescapeNewlines");
    assert.equal(entry("GEMINI_VISION_MODEL").derived, "same_as:GEMINI_MODEL");
    assert.equal(entry("BOT_LANG").configProp, "LANG");
    assert.equal(entry("PANEL_HOST").derived, "auto_host");
    assert.deepEqual(entry("PANEL_HOST").envAliases, ["HOST"]);
    assert.deepEqual(entry("PANEL_PORT").envAliases, ["PORT"]);
    for (const key of ["ALERT_RECONNECT", "ALERT_ERROR_BURST", "ALERT_KEY_REFUSED", "ALERT_LOGIN_BLOCKED", "ALERT_NEW_ORIGIN", "ALERT_UPDATE"]) {
      assert.equal(entry(key).env, null, key);
      assert.equal(entry(key).default, true, key);
      assert.equal(entry(key).type, "bool", key);
    }
    assert.equal(entry("BROADCAST_DELAY_MS").env, null);
    assert.equal(entry("SESSION_DIR").env, null);
    for (const key of ["ANTIDELETE_MODE", "ANTIDELETE_JID"]) assert.deepEqual([entry(key).source, entry(key).adapter, entry(key).env], ["model", "antiDelete", null]);
    for (const key of ["VIEWONCE_MODE", "VIEWONCE_JID"]) assert.deepEqual([entry(key).source, entry(key).adapter, entry(key).env], ["model", "viewOnce", null]);
    for (const key of ["AUTO_STATUS_SAVE", "STATUS_SAVE_LIST"]) assert.deepEqual([entry(key).source, entry(key).adapter], ["file", "statusSave"]);
    for (const key of ["AUTO_RESPONDER_ENABLED", "AUTO_RESPONDER_IGNORE_NUMBERS", "AUTO_RESPONDER_PERSONALITY"]) {
      assert.deepEqual([entry(key).source, entry(key).adapter], ["model", "autoResponder"]);
    }
    assert.deepEqual(entry("OPENAI_API_KEY").testService, "openai");
    assert.deepEqual(entry("SPOTIFY_CLIENT_ID").testService, "spotify");
    assert.equal(entry("ALPHA_VANTAGE_KEY").testService, null);
  });

  test("every default validates against its own rule (derived defaults excepted)", () => {
    for (const e of entries) {
      if (e.derived) continue;
      assert.equal(e.validate(catalog.defaultOf(e)), null, e.key);
    }
  });

  test("U19: for the default-differs keys the catalog holds the code default, not the example's value", () => {
    const example = fs.readFileSync(path.join(__dirname, "..", "config.env.example"), "utf8");
    const exampleValue = (key) => {
      const match = new RegExp(`^${key}=(.*)$`, "m").exec(example);
      return match ? match[1].trim() : undefined;
    };
    const flagged = entries.filter((e) => e.flags.includes("default-differs")).map((e) => e.key).sort();
    assert.deepEqual(flagged, ["AUTO_READ", "AUTO_STATUS_VIEW", "ENABLE_MESSAGE_REACTIONS", "STICKER_AUTHOR", "VPS"]);
    const codeDefaults = { AUTO_READ: false, AUTO_STATUS_VIEW: false, ENABLE_MESSAGE_REACTIONS: false, STICKER_AUTHOR: "Bot", VPS: false };
    for (const key of flagged) {
      assert.equal(entry(key).default, codeDefaults[key], key);
      const fromExample = entry(key).parse(exampleValue(key));
      assert.notEqual(fromExample, entry(key).default, `${key}: the example suggests another value`);
    }
  });

  test("the code defaults of the old config.js are kept", () => {
    const d = (key) => entry(key).default;
    assert.deepEqual(
      [d("PREFIX"), d("BOT_LANG"), d("TIMEZONE"), d("MAX_UPLOAD"), d("GEMINI_MODEL"), d("OPENAI_MODEL"), d("LOG_LEVEL"), d("BAILEYS_LOG_LVL")],
      [".", "fr", "UTC", 230, "gemini-2.5-flash", "gpt-4o-mini", "info", "silent"],
    );
    assert.deepEqual(
      [d("AUTO_RESPONDER_MIN_DELAY"), d("AUTO_RESPONDER_MAX_DELAY"), d("AUTO_RESPONDER_TYPING_SPEED"), d("AUTO_RESPONDER_MAX_TYPING_TIME"), d("AUTO_RESPONDER_RATE_LIMIT"), d("AUTO_RESPONDER_RATE_WINDOW")],
      [1000, 3000, 50, 10000, 5, 60000],
    );
    assert.deepEqual(
      [d("CACHE_CLEANUP_INTERVAL"), d("CACHE_MAX_AGE"), d("CONVERSATION_UPDATE_INTERVAL"), d("CONVERSATION_BATCH_SIZE"), d("MEMORY_CLEANUP_INTERVAL"), d("MEMORY_WARN_THRESHOLD"), d("MESSAGE_CONCURRENCY_LIMIT"), d("TTS_MAX_LENGTH"), d("DOWNLOAD_TIMEOUT")],
      [600000, 3600000, 2000, 5, 900000, 400, 5, 500, 180000],
    );
    assert.equal(d("STATUS_EMOJIS").join(","), "😀,👍,❤️,🔥,💯,✨,🎉,👏,💪,🙌");
    assert.equal(d("WARN_MESSAGE"), "⚠️WARNING⚠️\n*User:* &mention\n*Warn:* &warn\n*Remaining:* &remaining");
    assert.equal(d("WARN_KICK_MESSAGE"), "&mention kicked");
    assert.equal(d("ANTILINK_MSG"), "_Antilink Detected &mention kicked_");
    assert.equal(d("ANTIBOT_MSG"), "&mention removed");
    assert.deepEqual([d("ADMIN_PANEL"), d("UPDATE_CHECK"), d("DATABASE_SSL"), d("PANEL_PORT"), d("KEEP_ALIVE_INTERVAL")], [true, true, true, 3000, 60000]);
  });

  test("ruleSummary ships the rules to the SPA (plain, serializable data)", () => {
    assert.deepEqual(catalog.ruleSummary(entry("PREFIX")), { minChars: 1, maxChars: 3, noWhitespace: true });
    assert.deepEqual(catalog.ruleSummary(entry("MAX_UPLOAD")), { min: 1, max: 2000 });
    assert.deepEqual(catalog.ruleSummary(entry("LOG_LEVEL")).enum, ["trace", "debug", "info", "warn", "error", "fatal", "silent"]);
    assert.ok(catalog.ruleSummary(entry("BOT_LANG")).enum.includes("fr"));
    for (const e of entries) JSON.parse(JSON.stringify(catalog.ruleSummary(e)));
  });
});

// ---------------------------------------------------------------------------
// Validation rules (section 6), straight on the catalog
// ---------------------------------------------------------------------------

describe("validation rules", () => {
  const check = (key, value) => entry(key).validate(value);

  test("PREFIX: 1 to 3 code points, no whitespace or control character", () => {
    for (const ok of [".", "!", "/", "#", "bot"]) assert.equal(check("PREFIX", ok), null, ok);
    assert.deepEqual(check("PREFIX", ""), { code: "required" });
    assert.deepEqual(check("PREFIX", " "), { code: "invalid_format", params: { reason: "whitespace" } });
    assert.deepEqual(check("PREFIX", ". "), { code: "invalid_format", params: { reason: "whitespace" } });
    assert.deepEqual(check("PREFIX", "ab cd"), { code: "too_long", params: { max: 3 } });
    assert.deepEqual(check("PREFIX", "a b"), { code: "invalid_format", params: { reason: "whitespace" } });
    assert.deepEqual(check("PREFIX", "abcd"), { code: "too_long", params: { max: 3 } });
    assert.deepEqual(check("PREFIX", "\u0007"), { code: "invalid_format", params: { reason: "whitespace" } });
    assert.equal(check("PREFIX", "👍👍👍"), null, "code points, not UTF-16 units");
    assert.deepEqual(check("PREFIX", 3), { code: "invalid_type" });
  });

  test("BOT_LANG: a file of lang/, lower-cased", () => {
    assert.equal(check("BOT_LANG", "fr"), null);
    assert.equal(check("BOT_LANG", "EN"), null);
    assert.equal(entry("BOT_LANG").normalize("EN"), "en");
    const refused = check("BOT_LANG", "xx");
    assert.equal(refused.code, "not_allowed");
    assert.ok(refused.params.allowed.includes("en") && refused.params.allowed.includes("fr"));
  });

  test("SUDO: numbers or JIDs, at most 20; normalised and de-duplicated by user part", () => {
    assert.equal(check("SUDO", ["33612345678", "+237695603938", "237695603938@s.whatsapp.net", "123456789012:12@lid"]), null);
    assert.deepEqual(check("SUDO", ["12345", "33612345678", "abc"]), { code: "invalid_phone", params: { indices: [0, 2] } });
    assert.deepEqual(check("SUDO", Array.from({ length: 21 }, (_, i) => `3361234${String(1000 + i)}`)), { code: "too_many_items", params: { max: 20 } });
    assert.equal(check("SUDO", Array.from({ length: 20 }, (_, i) => `3361234${String(1000 + i)}`)), null);
    assert.equal(check("SUDO", []), null, "empty is valid; the confirmation is a separate step");
    assert.deepEqual(entry("SUDO").normalize(["+33612345678", "33612345678@s.whatsapp.net", "33612345678:7@S.WHATSAPP.NET", "44712345678"]), ["33612345678", "44712345678"]);
  });

  test("TIMEZONE: an IANA zone", () => {
    for (const ok of ["UTC", "Africa/Douala", "Europe/Paris"]) assert.equal(check("TIMEZONE", ok), null, ok);
    for (const bad of ["UTC+3", "Paris", "", "x".repeat(65)]) assert.deepEqual(check("TIMEZONE", bad), { code: "invalid_timezone" }, bad);
  });

  test("integers: bounds with params, strict type", () => {
    assert.equal(check("MAX_UPLOAD", 1), null);
    assert.equal(check("MAX_UPLOAD", 2000), null);
    assert.deepEqual(check("MAX_UPLOAD", 0), { code: "out_of_range", params: { min: 1, max: 2000 } });
    assert.deepEqual(check("MAX_UPLOAD", 2001), { code: "out_of_range", params: { min: 1, max: 2000 } });
    for (const bad of ["5", 5.5, NaN, null, true, undefined]) assert.deepEqual(check("MAX_UPLOAD", bad), { code: "invalid_type" }, String(bad));
    assert.equal(check("AUTO_RESPONDER_MIN_DELAY", 0), null, "0 is meaningful where the minimum is 0");
    assert.equal(check("BROADCAST_DELAY_MS", 2000), null);
    assert.equal(check("BROADCAST_DELAY_MS", 1999).code, "out_of_range");
    assert.equal(check("WARN_LIMIT", 51).code, "out_of_range");
  });

  test("the responder delay pair is a cross-field rule on the resulting values", () => {
    const validator = catalog.crossValidators[0];
    const projected = (min, max) => (key) => (key === "AUTO_RESPONDER_MIN_DELAY" ? min : max);
    const both = new Set(["AUTO_RESPONDER_MIN_DELAY", "AUTO_RESPONDER_MAX_DELAY"]);
    assert.equal(validator(projected(1000, 3000), both), null);
    assert.equal(validator(projected(3000, 3000), both), null);
    assert.deepEqual(validator(projected(4000, 3000), both), {
      AUTO_RESPONDER_MIN_DELAY: { code: "bound_conflict", params: { other: "AUTO_RESPONDER_MAX_DELAY" } },
      AUTO_RESPONDER_MAX_DELAY: { code: "bound_conflict", params: { other: "AUTO_RESPONDER_MIN_DELAY" } },
    });
    assert.deepEqual(Object.keys(validator(projected(4000, 3000), new Set(["AUTO_RESPONDER_MIN_DELAY"]))), ["AUTO_RESPONDER_MIN_DELAY"]);
    assert.equal(validator(projected(4000, 3000), new Set(["PREFIX"])), null);
  });

  test("STATUS_EMOJIS: emoji sequences only", () => {
    assert.equal(check("STATUS_EMOJIS", ["❤️", "👨‍👩‍👧‍👦", "🇨🇲", "👍🏽"]), null);
    assert.deepEqual(check("STATUS_EMOJIS", ["🔥", "ok"]), { code: "invalid_emoji", params: { indices: [1] } });
    assert.deepEqual(check("STATUS_EMOJIS", ["🔥,👍", "a b"]), { code: "invalid_emoji", params: { indices: [0, 1] } });
    assert.deepEqual(check("STATUS_EMOJIS", ["🇨"]), { code: "invalid_emoji", params: { indices: [0] } }, "one regional indicator is not a flag");
    assert.deepEqual(check("STATUS_EMOJIS", []), { code: "required" });
    assert.deepEqual(check("STATUS_EMOJIS", Array(31).fill("🔥")), { code: "too_many_items", params: { max: 30 } });
    assert.equal(check("STATUS_EMOJIS", Array(30).fill("🔥")), null);
  });

  test("secrets, ids and the panel token: visible ASCII, empty clears", () => {
    assert.equal(check("OPENAI_API_KEY", ""), null);
    assert.equal(check("OPENAI_API_KEY", "sk-abcdefgh"), null);
    assert.deepEqual(check("OPENAI_API_KEY", "short"), { code: "too_short", params: { min: 8 } });
    assert.deepEqual(check("OPENAI_API_KEY", "x".repeat(257)), { code: "too_long", params: { max: 256 } });
    assert.deepEqual(check("OPENAI_API_KEY", "has space inside"), { code: "invalid_format" });
    assert.deepEqual(check("OPENAI_API_KEY", "line\nbreak-key"), { code: "invalid_format" });
    assert.deepEqual(check("SPOTIFY_CLIENT_ID", "x".repeat(129)), { code: "too_long", params: { max: 128 } });
    assert.deepEqual(check("PANEL_TOKEN", "x".repeat(15)), { code: "too_short", params: { min: 16 } });
    assert.equal(check("PANEL_TOKEN", "x".repeat(16)), null);
    assert.equal(check("PANEL_TOKEN", ""), null);
  });

  test("models, URLs and origins", () => {
    assert.equal(check("GEMINI_MODEL", "gemini-2.5-flash"), null);
    assert.deepEqual(check("GEMINI_MODEL", ""), { code: "required" });
    assert.deepEqual(check("GEMINI_MODEL", "bad model!"), { code: "invalid_format" });
    assert.equal(check("IMAGE_MODEL", ""), null);
    assert.equal(check("GEMINI_VISION_MODEL", ""), null);

    assert.equal(check("BACKEND_URL", ""), null);
    assert.equal(check("BACKEND_URL", "https://api.example.com/v1"), null);
    for (const bad of ["ftp://example.com", "not a url", "https://user:pw@example.com", "https://example.com/#frag", "javascript:alert(1)"]) {
      assert.deepEqual(check("BACKEND_URL", bad), { code: "invalid_url" }, bad);
    }

    const origin = entry("PANEL_PUBLIC_URL");
    assert.equal(origin.validate("https://bot.example.com"), null);
    assert.equal(origin.validate("http://localhost:3000/"), null);
    assert.equal(origin.normalize("http://localhost:3000/"), "http://localhost:3000");
    for (const bad of ["https://bot.example.com/panel", "https://bot.example.com/?x=1", "ftp://x.example.com"]) {
      assert.deepEqual(origin.validate(bad), { code: "invalid_url" }, bad);
    }
  });

  test("message templates: bounds, control characters, known tokens", () => {
    assert.equal(check("WARN_MESSAGE", "line one\n&mention &warn &remaining"), null);
    assert.deepEqual(check("WARN_MESSAGE", ""), { code: "required" });
    assert.deepEqual(check("WARN_MESSAGE", "x".repeat(1001)), { code: "too_long", params: { max: 1000 } });
    assert.deepEqual(check("WARN_MESSAGE", "a\u0007b"), { code: "invalid_format", params: { reason: "control" } });
    assert.deepEqual(check("WARN_MESSAGE", "&mention &foo &bar &foo"), { code: "unknown_variable", params: { names: ["&foo", "&bar"] } });
    assert.deepEqual(check("ANTILINK_MSG", "&warn"), { code: "unknown_variable", params: { names: ["&warn"] } });
    assert.equal(check("ANTILINK_MSG", "&mention"), null);
    assert.deepEqual(check("WARN_KICK_MESSAGE", "x".repeat(501)), { code: "too_long", params: { max: 500 } });
  });

  test("number lists, chat JIDs, startup rules", () => {
    assert.equal(check("AUTO_RESPONDER_IGNORE_NUMBERS", ["+33612345678", "237 695 603 938"]), null);
    assert.deepEqual(check("AUTO_RESPONDER_IGNORE_NUMBERS", ["1234", "33612345678"]), { code: "invalid_phone", params: { indices: [0] } });
    assert.deepEqual(entry("STATUS_SAVE_LIST").normalize(["+33612345678", "33612345678", "237 695 603 938"]), ["33612345678", "237695603938"]);
    assert.deepEqual(entry("AUTO_RESPONDER_IGNORE_NUMBERS").normalize(["+33 612345678", "+33612345678"]), ["+33612345678"]);

    assert.equal(check("ANTIDELETE_JID", ""), null);
    assert.equal(check("ANTIDELETE_JID", "120363000000000001@g.us"), null);
    assert.equal(check("ANTIDELETE_JID", "33612345678"), null);
    assert.deepEqual(check("ANTIDELETE_JID", "nope"), { code: "invalid_jid" });

    assert.equal(check("PANEL_HOST", ""), null);
    for (const ok of ["127.0.0.1", "::1", "bot.example.com", "localhost"]) assert.equal(check("PANEL_HOST", ok), null, ok);
    assert.deepEqual(check("PANEL_HOST", "bad host"), { code: "invalid_format" });
    assert.equal(check("PANEL_TRUST_PROXY", ["loopback", "10.0.0.0/8", "::1", "private", "all", "2001:db8::/32"]), null);
    assert.deepEqual(check("PANEL_TRUST_PROXY", ["loopback", "10.0.0.0/33", "bogus"]), { code: "invalid_format", params: { indices: [1, 2] } });
    assert.equal(check("PANEL_PORT", 65535), null);
    assert.equal(check("PANEL_PORT", 65536).code, "out_of_range");
  });

  test("parse / serialize: booleans follow the default, integers are strict, lists split", () => {
    assert.equal(entry("ALWAYS_ONLINE").parse("true"), true);
    assert.equal(entry("ALWAYS_ONLINE").parse("TRUE"), false, "default-false keys: exact true only");
    assert.equal(entry("ALWAYS_ONLINE").parse("false"), false);
    assert.equal(entry("ADMIN_PANEL").parse("false"), false);
    assert.equal(entry("ADMIN_PANEL").parse("False"), true, "default-true keys: exact false only");
    assert.equal(entry("ADMIN_PANEL").parse("0"), true);
    assert.equal(entry("MAX_UPLOAD").parse("12"), 12);
    assert.equal(entry("MAX_UPLOAD").parse(" 12 "), 12);
    for (const bad of ["12abc", "1.5", "-3", "", "abc"]) assert.equal(entry("MAX_UPLOAD").parse(bad), undefined, bad);
    assert.deepEqual(entry("SUDO").parse("1, 2 ,,3"), ["1", "2", "3"]);
    assert.equal(entry("LOG_LEVEL").parse(" DEBUG "), "debug");
    assert.equal(entry("ALWAYS_ONLINE").serialize(true), "true");
    assert.equal(entry("MAX_UPLOAD").serialize(7), "7");
    assert.equal(entry("SUDO").serialize(["1", "2"]), "1,2");
    assert.equal(entry("SUDO").toConfig(["1", "2"]), "1,2");
    assert.equal(entry("SUDO").toConfig([]), "");
  });

  test("needsConfirm: only emptying a non-empty owner list needs owners_empty", () => {
    assert.equal(catalog.needsConfirm(entry("SUDO"), [], "33612345678"), true);
    assert.equal(catalog.needsConfirm(entry("SUDO"), [], ""), false);
    assert.equal(catalog.needsConfirm(entry("SUDO"), ["33612345678"], "44712345678"), false);
    assert.equal(catalog.needsConfirm(entry("PREFIX"), "", "."), false);
  });
});

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

describe("tier precedence", () => {
  test("default, then environment, then override, then runtime", async () => {
    const { store } = await loaded({ env: { PREFIX: "!" } });
    assert.equal(store.get("MAX_UPLOAD"), 230);
    assert.equal(store.origin("MAX_UPLOAD"), "default");
    assert.equal(store.get("PREFIX"), "!");
    assert.equal(store.origin("PREFIX"), "env");

    await store.set({ PREFIX: "?" });
    assert.equal(store.get("PREFIX"), "?");
    assert.equal(store.origin("PREFIX"), "override");

    store.setRuntime("PREFIX", "#");
    assert.equal(store.get("PREFIX"), "#");
    assert.equal(store.origin("PREFIX"), "override");
    store.clearRuntime();
    assert.equal(store.get("PREFIX"), "?");
    store.setRuntime("PREFIX", "#");
    store.clearRuntime("PREFIX");
    assert.equal(store.get("PREFIX"), "?");
    assert.equal(store.get("NOT_A_KEY"), undefined);
  });

  test("a runtime assignment is not validated and not persisted", async () => {
    const { store } = await loaded();
    store.setRuntime("SUDO", "");
    assert.equal(store.get("SUDO"), "");
    store.setRuntime("TIMEZONE", "Not/AZone");
    assert.equal(store.get("TIMEZONE"), "Not/AZone");
    assert.equal(await db.SettingOverride.count(), 0);
  });

  test("'' is a deliberate override; unset goes back to the file value", async () => {
    const { store } = await loaded({ env: { IMAGE_MODEL: "from-file", SUDO: "33612345678" } });
    assert.equal(store.get("IMAGE_MODEL"), "from-file");
    await store.set({ IMAGE_MODEL: "" });
    assert.equal(store.get("IMAGE_MODEL"), "");
    assert.equal(store.origin("IMAGE_MODEL"), "override");
    assert.equal((await rowOf("IMAGE_MODEL")).value, "");
    const result = await store.unset(["IMAGE_MODEL"]);
    assert.deepEqual(result, { changed: ["IMAGE_MODEL"] });
    assert.equal(store.get("IMAGE_MODEL"), "from-file");
    assert.equal(store.origin("IMAGE_MODEL"), "env");
    assert.equal(await rowOf("IMAGE_MODEL"), null);
  });

  test("unset of a key without a row is a no-op; unknown and read-only keys are refused", async () => {
    const { store } = await loaded();
    assert.deepEqual(await store.unset(["PREFIX"]), { changed: [] });
    await assert.rejects(store.unset(["NOPE"]), (e) => e instanceof SettingsValidationError && e.fields.NOPE.code === "unknown_setting");
    await assert.rejects(store.unset(["PANEL_PORT"]), (e) => e instanceof SettingsValidationError && e.fields.PANEL_PORT.code === "readonly");
    await assert.rejects(store.unset(["ANTIDELETE_MODE"]), (e) => e instanceof SettingsValidationError && e.fields.ANTIDELETE_MODE.code === "not_applicable");
  });

  test("lists: the file value is kept as written, a panel value is comma-joined", async () => {
    const { store } = await loaded({ env: { SUDO: "111, 112" } });
    assert.equal(store.get("SUDO"), "111, 112");
    assert.deepEqual(store.describe("SUDO").value, ["111", "112"]);
    await store.set({ SUDO: ["+33612345678", "44712345678"] });
    assert.equal(store.get("SUDO"), "33612345678,44712345678");
    assert.equal((await rowOf("SUDO")).value, "33612345678,44712345678");
    assert.deepEqual(store.describe("SUDO").value, ["33612345678", "44712345678"]);
  });

  test("GEMINI_VISION_MODEL follows GEMINI_MODEL until it has a value of its own", async () => {
    const { store } = await loaded({ env: { GEMINI_MODEL: "gm-1" } });
    assert.equal(store.get("GEMINI_VISION_MODEL"), "gm-1");
    await store.set({ GEMINI_MODEL: "gm-2" });
    assert.equal(store.get("GEMINI_VISION_MODEL"), "gm-2");
    await store.set({ GEMINI_VISION_MODEL: "vision-x" });
    assert.equal(store.get("GEMINI_VISION_MODEL"), "vision-x");
    await store.set({ GEMINI_VISION_MODEL: "" });
    assert.equal(store.get("GEMINI_VISION_MODEL"), "gm-2", "empty means same as GEMINI_MODEL");
    assert.equal(store.describe("GEMINI_VISION_MODEL").derived, "same_as:GEMINI_MODEL");
    assert.equal(store.describe("GEMINI_VISION_MODEL").default, null);
  });

  test("the environment parser: legacy booleans, strict integers, \\n in the two message keys, aliases", async () => {
    const { store } = await loaded({
      env: {
        ALWAYS_ONLINE: "true",
        AUTO_STATUS_REACT: "yes",
        ADMIN_PANEL: "false",
        UPDATE_CHECK: "maybe",
        MAX_UPLOAD: "50",
        WARN_MESSAGE: "one\\ntwo &mention",
        ANTILINK_MSG: "keep\\nliteral &mention",
        BOT_LANG: "EN",
        PANEL_PORT: "abc",
        PORT: "8080",
        HOST: "0.0.0.0",
        SUDO: "111",
        OPENAI_API_KEY: "  short  ",
      },
    });
    assert.equal(store.get("ALWAYS_ONLINE"), true);
    assert.equal(store.get("AUTO_STATUS_REACT"), false);
    assert.equal(store.get("ADMIN_PANEL"), false);
    assert.equal(store.get("UPDATE_CHECK"), true);
    assert.equal(store.get("MAX_UPLOAD"), 50);
    assert.equal(store.get("WARN_MESSAGE"), "one\ntwo &mention");
    assert.equal(store.get("ANTILINK_MSG"), "keep\\nliteral &mention");
    assert.equal(store.get("BOT_LANG"), "en");
    assert.equal(store.get("PANEL_PORT"), 8080, "an unusable PANEL_PORT falls through to PORT");
    assert.equal(store.get("PANEL_HOST"), "0.0.0.0");
    assert.equal(store.get("SUDO"), "111", "short test numbers are kept (legacy)");
    assert.equal(store.get("OPENAI_API_KEY"), "short", "secrets are trimmed and not length-checked in the file");
    assert.deepEqual(store.problems(), {});
  });

  test("an invalid file value falls back to the default and shows up in problems()", async () => {
    const { store } = await loaded({
      env: { MAX_UPLOAD: "0", LOG_LEVEL: "loud", TIMEZONE: "UTC+3", PREFIX: "abcd", AUTO_RESPONDER_MIN_DELAY: "12abc", PANEL_PUBLIC_URL: "https://x.example.com/path" },
    });
    assert.equal(store.get("MAX_UPLOAD"), 230);
    assert.equal(store.get("LOG_LEVEL"), "info");
    assert.equal(store.get("TIMEZONE"), "UTC");
    assert.equal(store.get("PREFIX"), ".");
    assert.equal(store.get("AUTO_RESPONDER_MIN_DELAY"), 1000);
    assert.equal(store.get("PANEL_PUBLIC_URL"), "");
    assert.equal(store.origin("MAX_UPLOAD"), "default");
    const problems = store.problems();
    assert.deepEqual(problems.MAX_UPLOAD, { code: "invalid_file_value", params: { reason: "out_of_range" } });
    assert.deepEqual(problems.LOG_LEVEL, { code: "invalid_file_value", params: { reason: "not_allowed" } });
    assert.deepEqual(problems.TIMEZONE, { code: "invalid_file_value", params: { reason: "invalid_timezone" } });
    assert.deepEqual(problems.PREFIX, { code: "invalid_file_value", params: { reason: "too_long" } });
    assert.deepEqual(problems.AUTO_RESPONDER_MIN_DELAY, { code: "invalid_file_value", params: { reason: "invalid_format" } });
    assert.equal(problems.PANEL_PUBLIC_URL.code, "invalid_file_value");
    assert.equal(store.describe("MAX_UPLOAD").problem.code, "invalid_file_value");
    assert.equal(store.describe("MAX_UPLOAD").fileValue, null);
    assert.equal(store.describe("PREFIX").problem.params.reason, "too_long");
  });
});

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

describe("set: validation and all-or-nothing batches", () => {
  test("one invalid field refuses the whole batch with per-field codes; nothing is written", async () => {
    const { store } = await loaded();
    const before = store.get("PREFIX");
    await assert.rejects(
      store.set({ PREFIX: "!", MAX_UPLOAD: 0, LOG_LEVEL: "loud", TIMEZONE: "UTC+3", STATUS_EMOJIS: ["ok"] }),
      (error) => {
        assert.ok(error instanceof SettingsValidationError);
        assert.equal(error.code, "validation_failed");
        assert.deepEqual(Object.keys(error.fields).sort(), ["LOG_LEVEL", "MAX_UPLOAD", "STATUS_EMOJIS", "TIMEZONE"]);
        assert.deepEqual(error.fields.MAX_UPLOAD, { code: "out_of_range", params: { min: 1, max: 2000 } });
        assert.equal(error.fields.LOG_LEVEL.code, "not_allowed");
        assert.equal(error.fields.TIMEZONE.code, "invalid_timezone");
        assert.deepEqual(error.fields.STATUS_EMOJIS, { code: "invalid_emoji", params: { indices: [0] } });
        return true;
      },
    );
    assert.equal(store.get("PREFIX"), before);
    assert.equal(await db.SettingOverride.count(), 0);
    assert.equal(store.version("PREFIX"), 0);
  });

  test("the validation table of the catalog through set()", async () => {
    const { store } = await loaded({ env: { SUDO: "33612345678" } });
    const code = async (key, value) => (await fieldOf(store.set({ [key]: value }), key)).code;
    assert.equal(await code("PREFIX", ""), "required");
    assert.equal(await code("PREFIX", " "), "invalid_format");
    assert.equal(await code("PREFIX", "ab cd"), "too_long");
    assert.equal(await code("BOT_LANG", "xx"), "not_allowed");
    assert.equal(await code("SUDO", ["12345"]), "invalid_phone");
    assert.equal(await code("SUDO", Array.from({ length: 21 }, (_, i) => `3361234${1000 + i}`)), "too_many_items");
    assert.equal(await code("TIMEZONE", "UTC+3"), "invalid_timezone");
    assert.equal(await code("MAX_UPLOAD", 2001), "out_of_range");
    assert.equal(await code("MAX_UPLOAD", "12"), "invalid_type");
    assert.equal(await code("STATUS_EMOJIS", ["ok"]), "invalid_emoji");
    assert.equal(await code("OPENAI_API_KEY", "short"), "too_short");
    assert.equal(await code("ALWAYS_ONLINE", "true"), "invalid_type");
    assert.equal(await code("SUDO", "33612345678"), "invalid_type");
    assert.equal(await db.SettingOverride.count(), 0);
  });

  test("valid values are normalised before they are stored", async () => {
    const { store } = await loaded();
    await store.set({ BOT_LANG: "EN", SUDO: ["+33612345678", "33612345678@s.whatsapp.net"], PANEL_TOKEN: "t".repeat(20), STATUS_EMOJIS: ["❤️", "👨‍👩‍👧‍👦", "🇨🇲"] });
    assert.equal(store.get("BOT_LANG"), "en");
    assert.equal((await rowOf("SUDO")).value, "33612345678");
    assert.equal((await rowOf("STATUS_EMOJIS")).value, "❤️,👨‍👩‍👧‍👦,🇨🇲");
    assert.equal(store.get("STATUS_EMOJIS").split(",").length, 3);
  });

  test("the min/max delay pair is checked on the resulting values", async () => {
    const { store } = await loaded();
    await assert.rejects(store.set({ AUTO_RESPONDER_MIN_DELAY: 5000, AUTO_RESPONDER_MAX_DELAY: 1000 }), (error) => {
      assert.deepEqual(error.fields, {
        AUTO_RESPONDER_MIN_DELAY: { code: "bound_conflict", params: { other: "AUTO_RESPONDER_MAX_DELAY" } },
        AUTO_RESPONDER_MAX_DELAY: { code: "bound_conflict", params: { other: "AUTO_RESPONDER_MIN_DELAY" } },
      });
      return true;
    });
    assert.deepEqual(
      (await fieldOf(store.set({ AUTO_RESPONDER_MIN_DELAY: 5000 }), "AUTO_RESPONDER_MIN_DELAY")),
      { code: "bound_conflict", params: { other: "AUTO_RESPONDER_MAX_DELAY" } },
      "against the max already in force (3000)",
    );
    await store.set({ AUTO_RESPONDER_MIN_DELAY: 5000, AUTO_RESPONDER_MAX_DELAY: 9000 });
    assert.equal(store.get("AUTO_RESPONDER_MIN_DELAY"), 5000);
    assert.equal(store.get("AUTO_RESPONDER_MAX_DELAY"), 9000);
    await store.set({ AUTO_RESPONDER_MIN_DELAY: 0, AUTO_RESPONDER_MAX_DELAY: 0 });
    assert.equal(store.get("AUTO_RESPONDER_MAX_DELAY"), 0);
  });

  test("an added validator sees the projected state", async () => {
    const { store } = await loaded();
    store.addValidator((projected, batchKeys) =>
      batchKeys.has("WARN_LIMIT") && projected("WARN_LIMIT") === 13 ? { WARN_LIMIT: { code: "not_allowed", params: { allowed: [] } } } : null,
    );
    await assert.rejects(store.set({ WARN_LIMIT: 13 }), (e) => e.fields.WARN_LIMIT.code === "not_allowed");
    await store.set({ WARN_LIMIT: 12 });
    assert.equal(store.get("WARN_LIMIT"), 12);
  });

  test("a throwing validator is logged and ignored", async () => {
    const { store, logs } = await loaded();
    store.addValidator(() => {
      throw new Error("boom");
    });
    await store.set({ WARN_LIMIT: 4 });
    assert.equal(store.get("WARN_LIMIT"), 4);
    assert.ok(logs.some((line) => line.level === "error"));
  });

  test("SUDO: emptying a non-empty owner list needs the owners_empty confirmation", async () => {
    const { store } = await loaded({ env: { SUDO: "33612345678" } });
    await assert.rejects(store.set({ SUDO: [] }), (error) => {
      assert.ok(error instanceof SettingsConfirmationError);
      assert.equal(error.code, "confirmation_required");
      assert.deepEqual(error.params, { confirm: ["owners_empty"] });
      return true;
    });
    assert.equal(store.get("SUDO"), "33612345678");
    await assert.rejects(store.set({ SUDO: [] }, { confirmed: ["something_else"] }), SettingsConfirmationError);
    await store.set({ SUDO: [] }, { confirmed: ["owners_empty"] });
    assert.equal(store.get("SUDO"), "");
    assert.equal((await rowOf("SUDO")).value, "");
    // already empty: no confirmation needed
    await store.set({ SUDO: [] });
  });

  test("a validation error wins over a missing confirmation", async () => {
    const { store } = await loaded({ env: { SUDO: "33612345678" } });
    await assert.rejects(store.set({ SUDO: [], MAX_UPLOAD: 0 }), SettingsValidationError);
  });

  test("unknown, boot-only, inactive and adapter-backed keys are refused", async () => {
    const { store } = await loaded();
    await assert.rejects(
      store.set({ NOT_A_SETTING: 1, PANEL_PORT: 80, ADMIN_PANEL: false, DATABASE_URL: "postgres://x", YTDLP_PATH: "/bin/sh", AUTO_READ: true, VPS: true, ANTIDELETE_MODE: "p", AUTO_STATUS_SAVE: true, AUTO_RESPONDER_ENABLED: true }),
      (error) => {
        const codes = Object.fromEntries(Object.entries(error.fields).map(([k, v]) => [k, v.code]));
        assert.deepEqual(codes, {
          NOT_A_SETTING: "unknown_setting",
          PANEL_PORT: "readonly",
          ADMIN_PANEL: "readonly",
          DATABASE_URL: "readonly",
          YTDLP_PATH: "readonly",
          AUTO_READ: "readonly",
          VPS: "readonly",
          ANTIDELETE_MODE: "not_applicable",
          AUTO_STATUS_SAVE: "not_applicable",
          AUTO_RESPONDER_ENABLED: "not_applicable",
        });
        return true;
      },
    );
    // keys such as __proto__ are plain unknown keys, never a prototype write
    const evil = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1}');
    await assert.rejects(store.set(evil), (error) => {
      assert.equal(error.fields.__proto__.code, "unknown_setting");
      assert.equal(error.fields.constructor.code, "unknown_setting");
      return true;
    });
    assert.equal({}.polluted, undefined);
    assert.equal(await db.SettingOverride.count(), 0);
  });

  test("an empty batch changes nothing; a non-object body is refused", async () => {
    const { store } = await loaded();
    assert.deepEqual(await store.set({}), { changed: [], versions: {} });
    await assert.rejects(store.set(null), SettingsValidationError);
    await assert.rejects(store.set([1]), SettingsValidationError);
  });
});

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

describe("versions and conflicts", () => {
  test("a row's version counts the writes; the answer carries the new versions", async () => {
    const { store } = await loaded();
    assert.equal(store.version("PREFIX"), 0);
    assert.deepEqual(await store.set({ PREFIX: "!", MAX_UPLOAD: 5 }), { changed: ["PREFIX", "MAX_UPLOAD"], versions: { PREFIX: 1, MAX_UPLOAD: 1 } });
    assert.deepEqual((await store.set({ PREFIX: "?" })).versions, { PREFIX: 2 });
    assert.equal(store.version("PREFIX"), 2);
    assert.equal((await rowOf("PREFIX")).version, 2);
    assert.equal(store.describe("PREFIX").version, 2);
  });

  test("a stale expected version is a conflict; nothing is written (whole batch)", async () => {
    const { store } = await loaded();
    await store.set({ PREFIX: "!" });
    await store.set({ PREFIX: "?" });
    await assert.rejects(store.set({ PREFIX: "#", MAX_UPLOAD: 9 }, { expectedVersions: { PREFIX: 1, MAX_UPLOAD: 0 } }), (error) => {
      assert.ok(error instanceof SettingsConflictError);
      assert.equal(error.code, "conflict");
      assert.deepEqual(error.keys, ["PREFIX"]);
      assert.deepEqual(error.fields.PREFIX, { code: "conflict", params: { version: 2 } });
      return true;
    });
    assert.equal(store.get("PREFIX"), "?");
    assert.equal(store.get("MAX_UPLOAD"), 230);
    await store.set({ PREFIX: "#", MAX_UPLOAD: 9 }, { expectedVersions: { PREFIX: 2, MAX_UPLOAD: 0 } });
    assert.equal(store.get("PREFIX"), "#");
    assert.equal(store.get("MAX_UPLOAD"), 9);
  });

  test("version continuity after a reset: a stale tab cannot overwrite (ABA)", async () => {
    const { store } = await loaded();
    await store.set({ PREFIX: "!" });
    await store.set({ PREFIX: "?" });
    const seenByTabA = store.version("PREFIX"); // 2
    await store.unset(["PREFIX"]);
    assert.equal(store.version("PREFIX"), 2, "the last known version, not 0");
    assert.equal(await rowOf("PREFIX"), null);
    const second = await store.set({ PREFIX: "#" }, { expectedVersions: { PREFIX: 2 } });
    assert.deepEqual(second.versions, { PREFIX: 3 }, "the new row continues from the last known version");
    await assert.rejects(store.set({ PREFIX: "s" }, { expectedVersions: { PREFIX: seenByTabA } }), SettingsConflictError);
    assert.equal(store.get("PREFIX"), "#");
  });

  test("a row created behind the store's back is a conflict on insert", async () => {
    const { store } = await loaded();
    await db.SettingOverride.create({ key: "PREFIX", value: "?", version: 1 });
    await assert.rejects(store.set({ PREFIX: "!" }), (error) => error instanceof SettingsConflictError && error.keys[0] === "PREFIX");
    assert.equal(store.get("PREFIX"), ".");
    assert.equal((await rowOf("PREFIX")).value, "?");
  });

  test("a row changed behind the store's back is a conflict on update", async () => {
    const { store } = await loaded();
    await store.set({ PREFIX: "!" });
    await db.SettingOverride.update({ version: 9 }, { where: { key: "PREFIX" } });
    await assert.rejects(store.set({ PREFIX: "?" }), SettingsConflictError);
    assert.equal(store.get("PREFIX"), "!");
    await store.reload();
    assert.equal(store.version("PREFIX"), 9);
    await store.set({ PREFIX: "?" });
    assert.equal(store.version("PREFIX"), 10);
  });

  test("a conflict in a later key rolls back the earlier ones", async () => {
    const { store } = await loaded();
    await store.set({ MAX_UPLOAD: 7 });
    await db.SettingOverride.update({ version: 5 }, { where: { key: "MAX_UPLOAD" } });
    await assert.rejects(store.set({ PREFIX: "!", MAX_UPLOAD: 8 }), SettingsConflictError);
    assert.equal(await rowOf("PREFIX"), null, "the first insert was rolled back");
    assert.equal(store.get("PREFIX"), ".");
  });

  test("unset honours expectedVersions", async () => {
    const { store } = await loaded();
    await store.set({ PREFIX: "!" });
    await assert.rejects(store.unset(["PREFIX"], { expectedVersions: { PREFIX: 0 } }), SettingsConflictError);
    assert.equal(store.get("PREFIX"), "!");
    await store.unset(["PREFIX"], { expectedVersions: { PREFIX: 1 } });
    assert.equal(store.get("PREFIX"), ".");
  });

  test("writes are serialized: concurrent sets of one key end in distinct versions", async () => {
    const { store } = await loaded();
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => store.set({ WARN_LIMIT: n })));
    assert.deepEqual(results.map((r) => r.versions.WARN_LIMIT), [1, 2, 3, 4, 5]);
    assert.equal(store.get("WARN_LIMIT"), 5);
    assert.equal((await rowOf("WARN_LIMIT")).version, 5);
  });
});

// ---------------------------------------------------------------------------
// Restart bookkeeping
// ---------------------------------------------------------------------------

describe("pendingRestart", () => {
  const RESTART = ["ALWAYS_ONLINE", "BAILEYS_LOG_LVL", "CACHE_CLEANUP_INTERVAL", "CONVERSATION_UPDATE_INTERVAL", "MEMORY_CLEANUP_INTERVAL"];

  test("the 5 restart keys are pending until markInForce(); the new value is readable at once", async () => {
    const { store } = await loaded();
    assert.deepEqual(store.pendingRestart(), []);
    await store.set({ ALWAYS_ONLINE: true, BAILEYS_LOG_LVL: "warn", CACHE_CLEANUP_INTERVAL: 20000, CONVERSATION_UPDATE_INTERVAL: 1000, MEMORY_CLEANUP_INTERVAL: 120000, PREFIX: "!" });
    assert.deepEqual(store.pendingRestart().sort(), RESTART);
    assert.equal(store.get("ALWAYS_ONLINE"), true);
    assert.equal(store.describe("ALWAYS_ONLINE").pendingRestart, true);
    assert.equal(store.describe("PREFIX").pendingRestart, false);
    store.markInForce();
    assert.deepEqual(store.pendingRestart(), []);
    assert.equal(store.describe("ALWAYS_ONLINE").pendingRestart, false);
    await store.set({ ALWAYS_ONLINE: false });
    assert.deepEqual(store.pendingRestart(), ["ALWAYS_ONLINE"]);
    await store.set({ ALWAYS_ONLINE: true });
    assert.deepEqual(store.pendingRestart(), [], "back to the value in force");
  });

  test("an override already stored at boot is in force", async () => {
    await db.SettingOverride.create({ key: "ALWAYS_ONLINE", value: "true", version: 1 });
    const { store } = await loaded();
    assert.equal(store.get("ALWAYS_ONLINE"), true);
    assert.deepEqual(store.pendingRestart(), []);
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe("secrets", () => {
  const KEY = "sk-live-0123456789abcdef";

  test("encrypted at rest, plaintext only in memory, last 4 in the view", async () => {
    const { store } = await loaded();
    await store.set({ OPENAI_API_KEY: KEY });
    const row = await rowOf("OPENAI_API_KEY");
    assert.match(row.value, /^enc:v1:/);
    assert.equal(row.value.includes(KEY), false);
    assert.equal(store.get("OPENAI_API_KEY"), KEY);

    const view = store.describe("OPENAI_API_KEY");
    assert.deepEqual(view.secretState, { set: true, last4: "cdef" });
    assert.equal("value" in view, false);
    assert.equal("default" in view, false);
    assert.equal("fileValue" in view, false);
    assert.equal(view.origin, "override");
    assert.equal(view.canRevert, true);
    assert.equal(JSON.stringify(store.snapshot()).includes(KEY), false);
  });

  test("the key is bound to its setting: a row copied to another key is not accepted", async () => {
    const { store } = await loaded();
    await store.set({ OPENAI_API_KEY: KEY });
    const row = await rowOf("OPENAI_API_KEY");
    await db.SettingOverride.create({ key: "GEMINI_API_KEY", value: row.value, version: 1 });
    const { store: fresh, logs } = await loaded();
    assert.equal(fresh.get("OPENAI_API_KEY"), KEY);
    assert.equal(fresh.get("GEMINI_API_KEY"), "");
    assert.equal(fresh.describe("GEMINI_API_KEY").problem.code, "reenter");
    assert.equal(logs.filter((l) => l.level === "error").length, 1);
  });

  test("an empty secret is stored as '' and clears the value", async () => {
    const { store } = await loaded({ env: { OPENAI_API_KEY: KEY } });
    assert.equal(store.get("OPENAI_API_KEY"), KEY);
    assert.equal(store.origin("OPENAI_API_KEY"), "env");
    await store.set({ OPENAI_API_KEY: "" });
    assert.equal(store.get("OPENAI_API_KEY"), "");
    assert.equal((await rowOf("OPENAI_API_KEY")).value, "");
    assert.deepEqual(store.describe("OPENAI_API_KEY").secretState, { set: false, last4: null });
    await store.unset(["OPENAI_API_KEY"]);
    assert.equal(store.get("OPENAI_API_KEY"), KEY);
  });

  test("a secret set by the environment is shown as set, last 4 only from 8 characters", async () => {
    const { store } = await loaded({ env: { OPENAI_API_KEY: KEY, GEMINI_API_KEY: "short" } });
    assert.deepEqual(store.describe("OPENAI_API_KEY").secretState, { set: true, last4: "cdef" });
    assert.equal(store.describe("OPENAI_API_KEY").origin, "env");
    assert.deepEqual(store.describe("GEMINI_API_KEY").secretState, { set: true, last4: null });
    assert.deepEqual(store.describe("NEWS_API_KEY").secretState, { set: false, last4: null });
  });

  test("DATABASE_URL shows its scheme only", async () => {
    const url = "postgres://bot:hunter2-pass@db.example.com:5432/bot";
    const { store } = await loaded({ env: { DATABASE_URL: url } });
    assert.deepEqual(store.describe("DATABASE_URL").secretState, { set: true, scheme: "postgres" });
    assert.deepEqual((await loaded()).store.describe("DATABASE_URL").secretState, { set: false, scheme: "sqlite" });
    assert.equal(JSON.stringify(store.snapshot()).includes("hunter2"), false);
  });

  test("BACKEND_URL (mask: url) hides credentials, query and fragment", async () => {
    const { store } = await loaded({ env: { BACKEND_URL: "https://user:pw-secret@backend.example.com/api?token=abc#frag" } });
    const view = store.describe("BACKEND_URL");
    assert.equal(view.value, "https://backend.example.com/api");
    assert.equal(view.fileValue, "https://backend.example.com/api");
    assert.equal(store.get("BACKEND_URL"), "https://user:pw-secret@backend.example.com/api?token=abc#frag");
    assert.equal(JSON.stringify(store.snapshot()).includes("pw-secret"), false);
  });

  test("an undecryptable row is ignored (the file value applies) and reported as reenter", async () => {
    const first = await loaded();
    await first.store.set({ OPENAI_API_KEY: KEY, GEMINI_API_KEY: "gem-0123456789abcdef" });
    fs.rmSync(path.join(tmp, "data", "panel.key")); // the key is lost

    const { store, logs } = await loaded({ env: { OPENAI_API_KEY: "from-the-file" } });
    assert.equal(store.get("OPENAI_API_KEY"), "from-the-file");
    assert.equal(store.origin("OPENAI_API_KEY"), "env");
    assert.equal(store.get("GEMINI_API_KEY"), "");
    for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY"]) {
      assert.deepEqual(store.describe(key).problem, { code: "reenter", params: { reason: "key_missing" } });
      assert.equal(store.problems()[key].code, "reenter");
    }
    assert.equal(logs.filter((l) => l.level === "error").length, 2, "one error per key");
    assert.equal(JSON.stringify(logs).includes(KEY), false);
    await store.reload();
    assert.equal(logs.filter((l) => l.level === "error").length, 2, "and not again on reload");

    // entering a new value works as soon as encrypt works, and clears only that problem
    await store.set({ OPENAI_API_KEY: "sk-new-0123456789abcdef" });
    assert.equal(store.get("OPENAI_API_KEY"), "sk-new-0123456789abcdef");
    assert.equal(store.describe("OPENAI_API_KEY").problem, null);
    assert.equal(store.describe("GEMINI_API_KEY").problem.code, "reenter");
    // the row of the other key is untouched until it is re-entered or unset
    assert.match((await rowOf("GEMINI_API_KEY")).value, /^enc:v1:/);
    await store.unset(["GEMINI_API_KEY"]);
    assert.equal(store.describe("GEMINI_API_KEY").problem, null);
  });

  test("a garbled stored secret is reenter, a garbled stored plain value is invalid_override", async () => {
    await db.SettingOverride.bulkCreate([
      { key: "OPENAI_API_KEY", value: "not-encrypted-but-set", version: 1 },
      { key: "MAX_UPLOAD", value: "twelve", version: 1 },
      { key: "PREFIX", value: "!", version: 1 },
    ]);
    const { store } = await loaded();
    assert.equal(store.describe("OPENAI_API_KEY").problem.code, "reenter");
    assert.equal(store.describe("MAX_UPLOAD").problem.code, "invalid_override");
    assert.equal(store.get("MAX_UPLOAD"), 230);
    assert.equal(store.get("PREFIX"), "!");
  });

  test("a secret write when the secret box fails writes nothing", async () => {
    fs.writeFileSync(path.join(tmp, "blocked"), "a file");
    const broken = createSecretBox({ dir: path.join(tmp, "blocked", "data") });
    const { store } = await loaded({ secretBox: broken });
    await assert.rejects(store.set({ PREFIX: "!", OPENAI_API_KEY: KEY }), (error) => {
      assert.ok(error instanceof SettingsStoreError);
      assert.equal(error.code, "secret_storage_unavailable");
      assert.equal(String(error.message).includes(KEY), false);
      return true;
    });
    assert.equal(await db.SettingOverride.count(), 0);
    assert.equal(store.get("PREFIX"), ".");
    // non-secret writes keep working
    await store.set({ PREFIX: "!" });
    fs.rmSync(path.join(tmp, "blocked"));
  });

  test("a rejected secret is never echoed", async () => {
    const { store } = await loaded();
    const bad = "bad secret with spaces 0123";
    try {
      await store.set({ OPENAI_API_KEY: bad });
      assert.fail("expected a validation error");
    } catch (error) {
      assert.equal(JSON.stringify(error.fields).includes("spaces"), false);
      assert.equal(String(error.message).includes("spaces"), false);
      assert.equal(error.fields.OPENAI_API_KEY.code, "invalid_format");
    }
  });
});

describe("redactor registration", () => {
  const KEY = "sk-live-0123456789abcdef";

  test("every secret in effect is registered: file values at load, panel values on write", async () => {
    const { store, redactor } = await loaded({ env: { OPENAI_API_KEY: KEY, DATABASE_URL: "postgres://bot:pw-in-url-123@db/bot", BACKEND_URL: "https://u:backendpw99@b.example.com" } });
    assert.equal(redactor.values.get("setting:OPENAI_API_KEY"), KEY);
    assert.equal(redactor.values.get("setting:DATABASE_URL"), "postgres://bot:pw-in-url-123@db/bot");
    assert.equal(redactor.values.get("setting:DATABASE_URL:password"), "pw-in-url-123");
    assert.equal(redactor.values.get("setting:BACKEND_URL:password"), "backendpw99");

    await store.set({ GEMINI_API_KEY: "gem-0123456789abcdef", OPENAI_API_KEY: "sk-panel-0123456789" });
    assert.equal(redactor.values.get("setting:GEMINI_API_KEY"), "gem-0123456789abcdef");
    assert.equal(redactor.values.get("setting:OPENAI_API_KEY"), "sk-panel-0123456789");

    await store.set({ GEMINI_API_KEY: "" });
    assert.equal(redactor.values.get("setting:GEMINI_API_KEY"), "");

    await store.unset(["OPENAI_API_KEY"]);
    assert.equal(redactor.values.get("setting:OPENAI_API_KEY"), KEY, "back to the file value");
  });

  test("a redactor given to load() receives the values already known", async () => {
    const made = makeStore({ env: { OPENAI_API_KEY: KEY } });
    const late = fakeRedactor();
    await made.store.load({ redactor: late });
    assert.equal(late.values.get("setting:OPENAI_API_KEY"), KEY);
  });

  test("the real redactor scrubs a secret set through the store", async () => {
    const realRedactor = require("../lib/admin/logs/redactor");
    const { store } = await loaded({ redactor: realRedactor });
    await store.set({ NEWS_API_KEY: "news-0123456789-secret" });
    assert.equal(realRedactor.scrub("error calling news-0123456789-secret failed"), "error calling [redacted] failed");
    for (const key of ["NEWS_API_KEY", "OPENAI_API_KEY", "DATABASE_URL", "BACKEND_URL"]) {
      realRedactor.unregister(`setting:${key}`);
      realRedactor.unregister(`setting:${key}:password`);
    }
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe("change events", () => {
  test("source, keys and filters", async () => {
    const { store } = await loaded({ now: () => 1234 });
    const all = [];
    const onlyPrefix = [];
    store.onChange(null, (event) => all.push(event));
    store.onChange(["PREFIX"], (event) => onlyPrefix.push(event));
    store.on("change", () => all.push("raw"));

    await store.set({ PREFIX: "!", MAX_UPLOAD: 5 });
    await store.set({ MAX_UPLOAD: 6 });
    await store.unset(["PREFIX"]);
    assert.deepEqual(all, [
      { keys: ["PREFIX", "MAX_UPLOAD"], source: "panel", at: 1234 },
      "raw",
      { keys: ["MAX_UPLOAD"], source: "panel", at: 1234 },
      "raw",
      { keys: ["PREFIX"], source: "unset", at: 1234 },
      "raw",
    ]);
    assert.deepEqual(onlyPrefix.map((e) => e.source), ["panel", "unset"]);
  });

  test("the event fires after memory is updated, and not for a refused write", async () => {
    const { store } = await loaded();
    const seen = [];
    store.onChange(["PREFIX"], () => seen.push(store.get("PREFIX")));
    await assert.rejects(store.set({ PREFIX: "ab cd" }));
    assert.deepEqual(seen, []);
    await store.set({ PREFIX: "!" });
    assert.deepEqual(seen, ["!"]);
  });

  test("a throwing or rejecting listener neither fails the write nor stops the others", async () => {
    const { store, logs } = await loaded();
    const seen = [];
    store.onChange(null, () => {
      throw new Error("sync boom");
    });
    store.onChange(null, async () => {
      throw new Error("async boom");
    });
    store.onChange(null, (event) => seen.push(event.keys));
    const result = await store.set({ PREFIX: "!" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(result.changed, ["PREFIX"]);
    assert.equal(store.get("PREFIX"), "!");
    assert.deepEqual(seen, [["PREFIX"]]);
    assert.equal(logs.filter((l) => l.level === "error").length, 2);
  });

  test("unsubscribe stops the listener", async () => {
    const { store } = await loaded();
    const seen = [];
    const stop = store.onChange(null, (event) => seen.push(event.keys));
    await store.set({ PREFIX: "!" });
    stop();
    await store.set({ PREFIX: "?" });
    assert.equal(seen.length, 1);
  });

  test("load announces the overrides it found; reload announces what changed", async () => {
    await db.SettingOverride.create({ key: "PREFIX", value: "!", version: 1 });
    const made = makeStore();
    const events = [];
    made.store.onChange(null, (event) => events.push(event));
    await made.store.load();
    assert.deepEqual(events.map((e) => [e.source, e.keys]), [["load", ["PREFIX"]]]);

    await db.SettingOverride.update({ value: "?" }, { where: { key: "PREFIX" } });
    await db.SettingOverride.create({ key: "WARN_LIMIT", value: "9", version: 1 });
    await made.store.reload();
    assert.deepEqual(events.slice(1).map((e) => [e.source, e.keys.sort()]), [["restore", ["PREFIX", "WARN_LIMIT"]]]);
    assert.equal(made.store.get("PREFIX"), "?");
    assert.equal(made.store.get("WARN_LIMIT"), 9);
    await made.store.reload();
    assert.equal(events.length, 2, "nothing changed, nothing announced");
  });
});

// ---------------------------------------------------------------------------
// Failure behaviour
// ---------------------------------------------------------------------------

describe("maintenance and database failures", () => {
  test("set and unset are refused with busy during maintenance; reads keep working", async () => {
    let active = false;
    const { store } = await loaded({ maintenanceMode: { isActive: () => active } });
    await store.set({ PREFIX: "!" });
    active = true;
    await assert.rejects(store.set({ PREFIX: "?" }), (e) => e instanceof SettingsStoreError && e.code === "busy");
    await assert.rejects(store.unset(["PREFIX"]), (e) => e.code === "busy");
    assert.equal(store.get("PREFIX"), "!");
    active = false;
    await store.set({ PREFIX: "?" });
  });

  test("a store without models answers db_unavailable to writes and reloads; reads serve the environment", async () => {
    const { store } = makeStore({ models: null, env: { PREFIX: "!" } });
    assert.equal(store.get("PREFIX"), "!");
    await assert.rejects(store.set({ PREFIX: "?" }), (e) => e.code === "db_unavailable");
    await assert.rejects(store.unset(["PREFIX"]), (e) => e.code === "db_unavailable");
    await assert.rejects(store.reload(), (e) => e.code === "db_unavailable");
    assert.equal(store.get("PREFIX"), "!");
  });

  test("a database that goes down: writes and reloads answer db_unavailable, memory keeps serving", async () => {
    const { store, logs } = await loaded();
    await store.set({ PREFIX: "!" });
    const down = new Error("connection refused");
    down.code = "ECONNREFUSED";
    const dead = {
      SettingOverride: {
        findAll: async () => {
          throw down;
        },
        sequelize: {
          transaction: async () => {
            throw down;
          },
        },
      },
    };
    store._models = dead;
    await assert.rejects(store.set({ MAX_UPLOAD: 7 }), (e) => e instanceof SettingsStoreError && e.code === "db_unavailable" && e.cause === down);
    await assert.rejects(store.unset(["PREFIX"]), (e) => e.code === "db_unavailable");
    await assert.rejects(store.reload(), (e) => e.code === "db_unavailable");
    assert.equal(store.get("PREFIX"), "!");
    assert.equal(store.get("MAX_UPLOAD"), 230);
    assert.equal(store.describe("PREFIX").value, "!");
    assert.ok(logs.some((l) => l.level === "error"));
  });
});

describe("set / unset in the caller's transaction (SET-2 atomicity)", () => {
  const inTransaction = (work) => db.DATABASE.transaction(work);

  test("the rows are written in the caller's transaction, memory and listeners wait for apply()", async () => {
    const { store } = await loaded();
    const seen = [];
    store.onChange(["PREFIX"], (event) => seen.push([event.source, store.get("PREFIX")]));

    let pending;
    await inTransaction(async (transaction) => {
      pending = await store.set({ PREFIX: "!" }, { transaction });
      assert.deepEqual(pending.changed, ["PREFIX"]);
      assert.deepEqual(pending.versions, { PREFIX: 1 });
      assert.equal(typeof pending.apply, "function");
      assert.notEqual(store.describe("PREFIX").origin, "override", "memory is untouched before the commit");
    });
    assert.ok(await rowOf("PREFIX"), "committed with the transaction");
    assert.notEqual(store.describe("PREFIX").origin, "override", "still not applied: the caller decides");
    assert.deepEqual(seen, []);

    pending.apply();
    pending.apply(); // idempotent
    assert.equal(store.get("PREFIX"), "!");
    assert.equal(store.describe("PREFIX").origin, "override");
    assert.equal(store.version("PREFIX"), 1);
    assert.deepEqual(seen, [["panel", "!"]], "one event, after memory is updated");
  });

  test("a rollback leaves the database and the store's memory exactly as they were", async () => {
    const { store } = await loaded();
    await store.set({ PREFIX: "!" });
    const seen = [];
    store.onChange(null, () => seen.push(1));
    await assert.rejects(
      inTransaction(async (transaction) => {
        const pending = await store.set({ PREFIX: "?", MAX_UPLOAD: 7 }, { transaction });
        assert.equal(pending.changed.length, 2);
        throw new Error("a later write in the same transaction failed");
      }),
      /later write/,
    );
    assert.equal((await rowOf("PREFIX")).value, "!");
    assert.equal(await rowOf("MAX_UPLOAD"), null);
    assert.equal(store.get("PREFIX"), "!");
    assert.equal(store.get("MAX_UPLOAD"), 230);
    assert.equal(store.version("PREFIX"), 1);
    assert.deepEqual(seen, [], "no change event for a write that never committed");
  });

  test("unset in the caller's transaction: rows deleted with it, memory back only at apply()", async () => {
    const { store } = await loaded();
    await store.set({ PREFIX: "!", MAX_UPLOAD: 7 });
    let pending;
    await inTransaction(async (transaction) => {
      pending = await store.unset(["PREFIX"], { transaction });
    });
    assert.deepEqual(pending.changed, ["PREFIX"]);
    assert.equal(await rowOf("PREFIX"), null);
    assert.equal(store.get("PREFIX"), "!", "memory waits");
    pending.apply();
    assert.notEqual(store.get("PREFIX"), "!");
    assert.equal(store.get("MAX_UPLOAD"), 7);

    // versions keep counting after a reset
    await store.set({ PREFIX: "?" });
    assert.equal(store.version("PREFIX"), 2);

    // a rolled-back unset leaves the override in force
    await assert.rejects(
      inTransaction(async (transaction) => {
        await store.unset(["MAX_UPLOAD"], { transaction });
        throw new Error("boom");
      }),
    );
    assert.equal(store.get("MAX_UPLOAD"), 7);
    assert.ok(await rowOf("MAX_UPLOAD"));
  });

  test("validation and version conflicts still refuse the batch before anything is written", async () => {
    const { store } = await loaded();
    await store.set({ PREFIX: "!" });
    await assert.rejects(
      inTransaction((transaction) => store.set({ PREFIX: "ab cd" }, { transaction })),
      (error) => error instanceof SettingsValidationError,
    );
    await assert.rejects(
      inTransaction((transaction) => store.set({ PREFIX: "?" }, { transaction, expectedVersions: { PREFIX: 0 } })),
      (error) => error instanceof SettingsConflictError,
    );
    assert.equal((await rowOf("PREFIX")).value, "!");
    assert.equal(store.get("PREFIX"), "!");
  });

  test("without a transaction the behaviour is unchanged: applied before set() returns, no apply()", async () => {
    const { store } = await loaded();
    const result = await store.set({ PREFIX: "!" });
    assert.equal(result.apply, undefined);
    assert.equal(store.get("PREFIX"), "!");
    const reset = await store.unset(["PREFIX"]);
    assert.equal(reset.apply, undefined);
    assert.notEqual(store.get("PREFIX"), "!");
  });
});

// ---------------------------------------------------------------------------
// Backup and restore
// ---------------------------------------------------------------------------

describe("rawOverrides / importOverrides", () => {
  test("rawOverrides: stored form by default, secrets in clear with decrypted: true", async () => {
    const { store } = await loaded();
    await store.set({ PREFIX: "!", OPENAI_API_KEY: "sk-live-0123456789abcdef", GEMINI_API_KEY: "" });
    const stored = Object.fromEntries(store.rawOverrides().map((r) => [r.key, r.value]));
    assert.equal(stored.PREFIX, "!");
    assert.match(stored.OPENAI_API_KEY, /^enc:v1:/);
    assert.equal(stored.GEMINI_API_KEY, "");
    const clear = Object.fromEntries(store.rawOverrides({ decrypted: true }).map((r) => [r.key, r.value]));
    assert.equal(clear.OPENAI_API_KEY, "sk-live-0123456789abcdef");
    assert.equal(clear.PREFIX, "!");
    assert.deepEqual(store.rawOverrides({ decrypted: true }).find((r) => r.key === "PREFIX"), { key: "PREFIX", value: "!", version: 1 });
  });

  test("a round trip into another installation re-encrypts with its key and replaces the old rows", async () => {
    const source = await loaded();
    await source.store.set({ PREFIX: "!", MAX_UPLOAD: 12, OPENAI_API_KEY: "sk-live-0123456789abcdef", SUDO: ["33612345678"] });
    const exported = source.store.rawOverrides({ decrypted: true });

    await db.SettingOverride.destroy({ where: {} });
    const otherBox = createSecretBox({ dir: path.join(tmp, "other", "data") });
    const target = await loaded({ secretBox: otherBox });
    await target.store.set({ WARN_LIMIT: 9, GEMINI_API_KEY: "gem-0123456789abcdef" });
    const events = [];
    target.store.onChange(null, (event) => events.push(event));

    const result = await target.store.importOverrides([
      ...exported,
      { key: "NOT_A_SETTING", value: "x" },
      { key: "PANEL_PORT", value: "80" },
      { key: "ANTIDELETE_MODE", value: "p" },
    ]);
    assert.deepEqual(result, { imported: 4, dropped: 3, droppedKeys: ["NOT_A_SETTING", "PANEL_PORT", "ANTIDELETE_MODE"] });
    assert.equal(target.store.get("PREFIX"), "!");
    assert.equal(target.store.get("MAX_UPLOAD"), 12);
    assert.equal(target.store.get("OPENAI_API_KEY"), "sk-live-0123456789abcdef");
    assert.equal(target.store.get("SUDO"), "33612345678");
    assert.equal(target.store.get("WARN_LIMIT"), 3, "rows absent from the backup are gone");
    assert.equal(target.store.get("GEMINI_API_KEY"), "");
    assert.equal(await rowOf("WARN_LIMIT"), null);

    const row = await rowOf("OPENAI_API_KEY");
    assert.match(row.value, /^enc:v1:/);
    assert.equal(otherBox.decrypt(row.value, "setting:OPENAI_API_KEY").value, "sk-live-0123456789abcdef");
    assert.equal(box.decrypt(row.value, "setting:OPENAI_API_KEY").ok, false, "encrypted with the target's key");

    assert.equal(events.length, 1);
    assert.equal(events[0].source, "restore");
    assert.ok(events[0].keys.includes("WARN_LIMIT") && events[0].keys.includes("PREFIX"));

    // a restart of the target reads the same state
    const again = await loaded({ secretBox: otherBox });
    assert.equal(again.store.get("OPENAI_API_KEY"), "sk-live-0123456789abcdef");
    assert.equal(again.store.get("PREFIX"), "!");
    assert.ok(again.store.version("PREFIX") >= 2, "versions keep growing so a stale tab conflicts");
  });

  test("a value that fails the catalog refuses the whole import", async () => {
    const { store } = await loaded();
    await store.set({ PREFIX: "!" });
    await assert.rejects(
      store.importOverrides([{ key: "MAX_UPLOAD", value: "12" }, { key: "LOG_LEVEL", value: "loud" }, { key: "TIMEZONE", value: "UTC+3" }]),
      (error) => {
        assert.ok(error instanceof SettingsValidationError);
        assert.deepEqual(Object.keys(error.fields).sort(), ["LOG_LEVEL", "TIMEZONE"]);
        return true;
      },
    );
    assert.equal(store.get("PREFIX"), "!");
    assert.equal(store.get("MAX_UPLOAD"), 230);
    assert.equal(await db.SettingOverride.count(), 1);
  });

  test("the import is not refused during maintenance (the restore runs there)", async () => {
    const { store } = await loaded({ maintenanceMode: { isActive: () => true } });
    const result = await store.importOverrides([{ key: "PREFIX", value: "?" }]);
    assert.equal(result.imported, 1);
    assert.equal(store.get("PREFIX"), "?");
  });

  test("importing nothing empties the overrides", async () => {
    const { store } = await loaded();
    await store.set({ PREFIX: "!" });
    assert.deepEqual(await store.importOverrides([]), { imported: 0, dropped: 0, droppedKeys: [] });
    assert.equal(store.get("PREFIX"), ".");
    assert.equal(await db.SettingOverride.count(), 0);
  });
});

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

describe("describe / snapshot", () => {
  test("a ResolvedSetting-ready view for a plain key", async () => {
    const { store } = await loaded({ env: { PREFIX: "?" }, now: () => Date.UTC(2026, 0, 2) });
    let view = store.describe("PREFIX");
    assert.deepEqual(
      { value: view.value, default: view.default, fileValue: view.fileValue, origin: view.origin, canRevert: view.canRevert, version: view.version, updatedAt: view.updatedAt },
      { value: "?", default: ".", fileValue: "?", origin: "env", canRevert: false, version: 0, updatedAt: null },
    );
    await store.set({ PREFIX: "!" });
    view = store.describe("PREFIX");
    assert.deepEqual(
      { value: view.value, fileValue: view.fileValue, origin: view.origin, canRevert: view.canRevert, version: view.version, updatedAt: view.updatedAt },
      { value: "!", fileValue: "?", origin: "override", canRevert: true, version: 1, updatedAt: "2026-01-02T00:00:00.000Z" },
    );
    assert.deepEqual(view.rules, { minChars: 1, maxChars: 3, noWhitespace: true });
    assert.deepEqual(
      { theme: view.theme, source: view.source, type: view.type, effect: view.effect, readonly: view.readonly, inactive: view.inactive, secret: view.secret, problem: view.problem },
      { theme: "general", source: "env", type: "string", effect: "immediate", readonly: false, inactive: false, secret: false, problem: null },
    );
    assert.equal(store.describe("NOPE"), null);
  });

  test("list values are copies; boot-only and inactive entries are readonly and cannot revert", async () => {
    const { store } = await loaded({ env: { STICKER_AUTHOR: "mine", AUTO_READ: "true" } });
    const emojis = store.describe("STATUS_EMOJIS").value;
    emojis.push("x");
    assert.equal(store.describe("STATUS_EMOJIS").value.length, 10);
    assert.equal(store.describe("PANEL_PORT").readonly, true);
    assert.equal(store.describe("PANEL_PORT").canRevert, false);
    assert.equal(store.describe("AUTO_READ").inactive, true);
    assert.equal(store.describe("AUTO_READ").value, true);
    assert.equal(store.describe("ANTIDELETE_MODE").source, "model");
    assert.equal(store.describe("ANTIDELETE_MODE").canRevert, false);
    assert.equal(store.describe("STICKER_AUTHOR").value, "mine");
  });

  test("snapshot lists the 101 entries in catalog order and is JSON-safe", async () => {
    const { store } = await loaded();
    const snapshot = store.snapshot();
    assert.deepEqual(snapshot.map((v) => v.key), catalog.entries.map((e) => e.key));
    JSON.parse(JSON.stringify(snapshot));
  });
});

// ---------------------------------------------------------------------------
// SC-003: every editable "immediate" entry applies on the next read, no restart
// ---------------------------------------------------------------------------

describe("SC-003: the process-wide store behind config.js", () => {
  const SAMPLES = {
    PREFIX: "!",
    SUDO: ["33612345678", "44712345678"],
    TIMEZONE: "Africa/Douala",
    LOG_LEVEL: "fatal", // quiet, and different from the "silent" the tests run with
    BAILEYS_LOG_LVL: "fatal",
    STICKER_PACKNAME: "Pack",
    STICKER_AUTHOR: "Author",
    STATUS_EMOJIS: ["🔥", "🎉"],
    GEMINI_MODEL: "gemini-x",
    GEMINI_VISION_MODEL: "vision-x",
    IMAGE_MODEL: "image-x",
    OPENAI_MODEL: "gpt-x",
    BACKEND_URL: "https://backend.example.com",
    WARN_MESSAGE: "warned &mention &warn &remaining",
    WARN_KICK_MESSAGE: "bye &mention",
    ANTILINK_MSG: "link &mention",
    ANTIBOT_MSG: "bot &mention",
    AUTO_RESPONDER_MIN_DELAY: 500,
    AUTO_RESPONDER_MAX_DELAY: 2500,
  };

  /** A valid value that differs from the default */
  function sampleFor(item) {
    const current = settingsStore.get(item.key);
    if (item.key in SAMPLES) return SAMPLES[item.key];
    if (item.key === "BOT_LANG") return current === "en" ? "fr" : "en"; // whatever BOT_LANG the run uses
    if (item.secret) return `secret-value-${item.key}`;
    if (item.type === "bool") return !current;
    if (item.type === "int") {
      const { min, max } = item.rules;
      return current === min ? Math.min(min + 1, max) : min;
    }
    if (item.type === "enum") return item.rules.enum.find((value) => value !== current);
    if (item.type === "string" && item.rules.maxChars === 128) return `client-id-${item.key}`; // R-id
    throw new Error(`no sample for ${item.key}`);
  }

  before(async () => {
    // the singleton secret box writes its key into the temporary directory, never the real data/
    require("../lib/utils/secretBox").configure({ dir: path.join(tmp, "singleton", "data") });
    await settingsStore.load({ models: db });
  });

  after(() => {
    settingsStore.clearRuntime();
  });

  // the file-wide beforeEach empties the table: the process-wide store re-reads it
  beforeEach(async () => {
    await settingsStore.reload();
  });

  test("config.js is a set of accessors over the store, and the old keys are all still there", () => {
    const keys = Object.keys(config);
    for (const old of ["VERSION", "DATABASE", "BRANCH", "SESSION_ID", "PREFIX", "SUDO", "LANG", "TIMEZONE", "MAX_UPLOAD", "PANEL_PORT", "PANEL_HOST", "PANEL_TOKEN", "KEEP_ALIVE_INTERVAL", "WARN_MESSAGE", "GEMINI_VISION_MODEL", "AUTO_RESPONDER_RATE_WINDOW", "MEMORY_WARN_THRESHOLD"]) {
      assert.ok(keys.includes(old), old);
    }
    assert.equal("PANEL_ENABLED" in config, false);
    assert.equal(Object.getOwnPropertyDescriptor(config, "PREFIX").get !== undefined, true);
  });

  test("every editable immediate entry: set(), then config[configProp] on the next call", async () => {
    const editable = catalog.entries.filter((e) => !e.readonly && e.source === "env" && e.effect === "immediate");
    assert.ok(editable.length >= 50, `${editable.length} entries`);
    for (const item of editable) {
      const value = sampleFor(item);
      assert.equal(item.validate(value), null, `${item.key} sample must be valid`);
      const before = config[item.configProp];
      await settingsStore.set({ [item.key]: value });
      const expected = item.toConfig(item.normalize(value));
      assert.deepEqual(config[item.configProp], expected, item.key);
      assert.notDeepEqual(config[item.configProp], before, `${item.key} changed`);
      assert.equal(settingsStore.origin(item.key), "override", item.key);
    }
    assert.ok(["en", "fr"].includes(config.LANG));
    assert.equal(config.SUDO, "33612345678,44712345678");
  });

  test("the entries with effect restart: readable at once, listed in pendingRestart", async () => {
    const restart = catalog.entries.filter((e) => e.effect === "restart");
    assert.equal(restart.length, 5);
    settingsStore.markInForce();
    for (const item of restart) {
      const value = sampleFor(item);
      await settingsStore.set({ [item.key]: value });
      assert.deepEqual(config[item.configProp], item.toConfig(value), item.key);
    }
    assert.deepEqual(settingsStore.pendingRestart().sort(), restart.map((e) => e.key).sort());
  });

  test("LOG_LEVEL reaches the shared logger at once (onChange setLogLevel)", async () => {
    const logger = require("../lib/utils/logger");
    await settingsStore.set({ LOG_LEVEL: "warn" });
    assert.equal(logger.getLevel(), "warn");
    await settingsStore.set({ LOG_LEVEL: "silent" });
    assert.equal(logger.getLevel(), "silent");
    await settingsStore.unset(["LOG_LEVEL"]);
    assert.equal(logger.getLevel(), "silent", "back to the file value of this run");
    // a detached store does not touch the logger
    const { store } = await loaded();
    await store.set({ LOG_LEVEL: "debug" });
    assert.equal(logger.getLevel(), "silent");
  });

  test("unset puts the file / default value back", async () => {
    await settingsStore.set({ PREFIX: "!", MAX_UPLOAD: 12 });
    assert.equal(config.PREFIX, "!");
    assert.equal(config.MAX_UPLOAD, 12);
    await settingsStore.unset(["PREFIX", "MAX_UPLOAD"]);
    assert.equal(config.PREFIX, ".");
    assert.equal(config.MAX_UPLOAD, 230);
  });

  test("a runtime assignment through config wins, clearRuntime restores", async () => {
    config.PREFIX = "%";
    assert.equal(config.PREFIX, "%");
    settingsStore.clearRuntime("PREFIX");
    assert.equal(config.PREFIX, ".");
  });
});

// ---------------------------------------------------------------------------
// mutex
// ---------------------------------------------------------------------------

describe("mutex.withLock", () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  test("work with one key runs one at a time, in call order", async () => {
    const order = [];
    const slow = (name, ms) => async () => {
      order.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([mutex.withLock("k", slow("a", 15)), mutex.withLock("k", slow("b", 1)), mutex.withLock("k", slow("c", 1))]);
    assert.deepEqual(results, ["a", "b", "c"]);
    assert.deepEqual(order, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  test("different keys do not wait for each other", async () => {
    const order = [];
    await Promise.all([
      mutex.withLock("one", async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("one");
      }),
      mutex.withLock("two", async () => {
        order.push("two");
      }),
    ]);
    assert.deepEqual(order, ["two", "one"]);
  });

  test("an error (or a synchronous throw) goes to its own caller and does not poison the queue", async () => {
    const failing = mutex.withLock("p", async () => {
      throw new Error("first fails");
    });
    const sync = mutex.withLock("p", () => {
      throw new Error("sync throw");
    });
    const after = mutex.withLock("p", async () => "still works");
    await assert.rejects(failing, /first fails/);
    await assert.rejects(sync, /sync throw/);
    assert.equal(await after, "still works");
  });

  test("idle keys are released", async () => {
    const before = mutex.size();
    const run = mutex.withLock("released", async () => 1);
    assert.equal(mutex.isLocked("released"), true);
    assert.equal(mutex.size(), before + 1);
    await run;
    await tick();
    assert.equal(mutex.isLocked("released"), false);
    assert.equal(mutex.size(), before);

    await Promise.allSettled([mutex.withLock("released", async () => 1), mutex.withLock("released", async () => Promise.reject(new Error("x")))]);
    await tick();
    assert.equal(mutex.size(), before);
  });

  test("a synchronous function result is returned", async () => {
    assert.equal(await mutex.withLock("sync-value", () => 42), 42);
  });
});
