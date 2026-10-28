"use strict";

/**
 * config.js as accessors over the settings catalog (specs/002-admin-panel T031, T036;
 * contracts/runtime.md section 1 "Accessor construction", settings-catalog.md section 8 item 1).
 *
 *  - the `process.env.X` names read by config.js (and client.js, index.js, panel.js) are catalog names;
 *  - every catalog `env` / `envAliases` name is honoured by the store behind config.js;
 *  - Object.keys(config) still lists the old keys, types are unchanged;
 *  - a runtime assignment wins and clearRuntime() restores;
 *  - an invalid environment value falls back to the default and shows up in problems();
 *  - PANEL_ENABLED is not read, ADMIN_PANEL is true unless exactly "false";
 *  - config.js loads with no database.
 *
 * Child processes get an explicit environment and print only the values this test set.
 */

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const fakes = require("./helpers/fakes");

const ROOT = path.resolve(__dirname, "..");
const config = fakes.setupEnv();
const catalog = require("../lib/utils/settingsCatalog");
const settingsStore = require("../lib/utils/settingsStore");

const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

/** Names of `process.env.NAME` / `process.env["NAME"]` reads in a source file (comments skipped) */
function envReads(file) {
  const source = read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const names = new Set();
  for (const match of source.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1]);
  for (const match of source.matchAll(/process\.env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g)) names.add(match[1]);
  return [...names].sort();
}

const catalogEnvNames = new Set();
for (const item of catalog.entries) {
  if (item.env) catalogEnvNames.add(item.env);
  for (const alias of item.envAliases) catalogEnvNames.add(alias);
}

/** Run a snippet in a fresh process with exactly this environment; returns its JSON output */
function child(code, env) {
  const out = execFileSync(process.execPath, ["-e", code], {
    cwd: ROOT,
    env: { DATABASE_URL: ":memory:", ...env },
    encoding: "utf8",
    timeout: 30000,
  });
  return JSON.parse(out.trim().split("\n").pop());
}

afterEach(() => settingsStore.clearRuntime());

describe("environment reads match the catalog", () => {
  test("config.js reads process.env directly only for what builds the Sequelize instance", () => {
    const direct = envReads("config.js");
    assert.deepEqual(direct, ["DATABASE_SSL", "DATABASE_URL"]);
    for (const name of direct) assert.ok(catalogEnvNames.has(name), `${name} is a catalog name`);
  });

  test("client.js, index.js and panel.js read catalog names only (PANEL_ENABLED may be mentioned for the boot warning)", () => {
    const tolerated = new Set(["PANEL_ENABLED"]);
    for (const file of ["lib/baileys/client.js", "index.js", "panel.js"]) {
      for (const name of envReads(file)) {
        assert.ok(catalogEnvNames.has(name) || tolerated.has(name), `${file} reads ${name}, which is not in the catalog`);
      }
    }
  });

  test("PANEL_ENABLED is not a catalog name and config.js does not mention it", () => {
    assert.equal(catalogEnvNames.has("PANEL_ENABLED"), false);
    assert.equal(catalog.byKey.has("PANEL_ENABLED"), false);
    assert.equal(/PANEL_ENABLED/.test(read("config.js")), false);
    assert.equal("PANEL_ENABLED" in config, false);
  });

  test("every catalog env name and alias is honoured by the store behind config.js", () => {
    const { createSettingsStore } = settingsStore;
    const strict = { PREFIX: "!", TIMEZONE: "Europe/Paris", STATUS_EMOJIS: "🔥", PANEL_PUBLIC_URL: "http://a.example.com", PANEL_TRUST_PROXY: "loopback", STATUS_SAVE_LIST: "33612345678", AUTO_RESPONDER_IGNORE_NUMBERS: "33612345678" };
    const raw = (item) => {
      if (item.key in strict) return strict[item.key];
      if (item.type === "bool") return item.default ? "false" : "true";
      if (item.type === "int") return String((item.rules.min ?? 0) + 1);
      if (item.type === "enum") return item.rules.enum.find((value) => value !== item.default);
      if (item.type === "list") return "a-value";
      return "a-value";
    };
    let checked = 0;
    for (const item of catalog.entries) {
      for (const name of [item.env, ...item.envAliases].filter(Boolean)) {
        const store = createSettingsStore({ env: { [name]: raw(item) } });
        assert.equal(store.origin(item.key), "env", `${name} -> ${item.key}`);
        checked++;
      }
    }
    assert.ok(checked >= 85, `${checked} names checked`);
    // keys without an environment variable never read one
    for (const key of ["ALERT_UPDATE", "BROADCAST_DELAY_MS", "SESSION_DIR", "ANTIDELETE_MODE", "VIEWONCE_MODE"]) {
      assert.equal(catalog.byKey.get(key).env, null, key);
      assert.equal(createSettingsStore({ env: { [key]: "x" } }).origin(key), "default", key);
    }
  });
});

describe("the config object", () => {
  test("Object.keys(config) still lists the old keys, and every catalog configProp", () => {
    const old = [
      "VERSION", "SESSION_ID", "DATABASE", "PREFIX", "SUDO", "ALWAYS_ONLINE", "AUTO_READ", "AUTO_STATUS_VIEW", "AUTO_STATUS_REACT",
      "AUTO_STATUS_SAVE", "STATUS_SAVE_LIST", "STATUS_SAVE_FOLDER", "ANTI_DELETE", "ENABLE_MESSAGE_REACTIONS", "STICKER_PACKNAME",
      "STICKER_AUTHOR", "OPENAI_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "RMBG_KEY", "GEMINI_MODEL", "GEMINI_VISION_MODEL",
      "IMAGE_MODEL", "OPENAI_MODEL", "WEATHER_API_KEY", "UNSPLASH_API_KEY", "GIPHY_API_KEY", "NEWS_API_KEY", "ALPHA_VANTAGE_KEY",
      "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "CLOUDMERSIVE_API_KEY",
      "APYHUB_API_KEY", "DEEPAI_API_KEY", "WAIFUPICS_API_KEY", "PUTERJS_API_KEY", "IMAGE_API_TIMEOUT", "IMAGE_API_MAX_SIZE_MB",
      "BACKEND_URL", "YTDLP_PATH", "DOWNLOAD_TIMEOUT", "LOG_LEVEL", "BAILEYS_LOG_LVL", "HEROKU_APP_NAME", "HEROKU_API_KEY", "KOYEB",
      "KOYEB_NAME", "KOYEB_API", "RENDER_NAME", "RENDER_API_KEY", "LANG", "TTS_MAX_LENGTH", "ANTILINK_MSG", "ANTIBOT_MSG",
      "WARN_LIMIT", "WARN_MESSAGE", "WARN_KICK_MESSAGE", "TIMEZONE", "MAX_UPLOAD", "VPS", "BRANCH", "STATUS_EMOJIS",
      "AUTO_RESPONDER_ENABLED", "AUTO_RESPONDER_IGNORE_NUMBERS", "AUTO_RESPONDER_PERSONALITY", "AUTO_RESPONDER_MIN_DELAY",
      "AUTO_RESPONDER_MAX_DELAY", "AUTO_RESPONDER_TYPING_SPEED", "AUTO_RESPONDER_MAX_TYPING_TIME", "AUTO_RESPONDER_RATE_LIMIT",
      "AUTO_RESPONDER_RATE_WINDOW", "MESSAGE_CONCURRENCY_LIMIT", "CACHE_CLEANUP_INTERVAL", "CACHE_MAX_AGE",
      "CONVERSATION_UPDATE_INTERVAL", "CONVERSATION_BATCH_SIZE", "MEMORY_CLEANUP_INTERVAL", "MEMORY_WARN_THRESHOLD", "PANEL_PORT",
      "PANEL_HOST", "KEEP_ALIVE_INTERVAL", "PANEL_TOKEN",
    ];
    const keys = Object.keys(config);
    for (const key of old) assert.ok(keys.includes(key), `${key} is still listed`);
    for (const item of catalog.entries) assert.ok(keys.includes(item.configProp), `${item.configProp} is listed`);
    for (const key of ["ADMIN_PANEL", "PANEL_PUBLIC_URL", "PANEL_TRUST_PROXY", "LOG_FORMAT", "SUPERVISED", "UPDATE_CHECK", "BROADCAST_DELAY_MS",
      "ALERT_RECONNECT", "ALERT_ERROR_BURST", "ALERT_KEY_REFUSED", "ALERT_LOGIN_BLOCKED", "ALERT_NEW_ORIGIN", "ALERT_UPDATE"]) {
      assert.ok(keys.includes(key), `${key} was added`);
    }
    assert.equal(keys.includes("PANEL_ENABLED"), false);
    assert.equal(keys.length, 3 + catalog.entries.length, "VERSION, DATABASE, BRANCH, plus one accessor per entry");
    for (const item of catalog.entries) {
      const descriptor = Object.getOwnPropertyDescriptor(config, item.configProp);
      assert.equal(descriptor.enumerable, true, item.configProp);
      assert.equal(typeof descriptor.get, "function", item.configProp);
      assert.equal(typeof descriptor.set, "function", item.configProp);
    }
  });

  test("VERSION, DATABASE and BRANCH stay plain data properties", () => {
    for (const key of ["VERSION", "DATABASE", "BRANCH"]) {
      const descriptor = Object.getOwnPropertyDescriptor(config, key);
      assert.ok("value" in descriptor, key);
    }
    assert.equal(config.VERSION, require("../package.json").version);
    assert.equal(config.BRANCH, "master");
    assert.equal(typeof config.DATABASE.authenticate, "function");
    assert.equal(config.DATABASE.getDialect(), "sqlite");
  });

  test("types are unchanged: numbers, booleans and strings (lists stay comma-joined strings)", () => {
    for (const item of catalog.entries) {
      const value = config[item.configProp];
      const expected = item.type === "bool" ? "boolean" : item.type === "int" ? "number" : "string";
      assert.equal(typeof value, expected, `${item.configProp} is ${typeof value}`);
    }
    for (const key of ["SUDO", "STATUS_SAVE_LIST", "AUTO_RESPONDER_IGNORE_NUMBERS", "STATUS_EMOJIS"]) assert.equal(typeof config[key], "string", key);
    assert.equal(config.STATUS_EMOJIS, "😀,👍,❤️,🔥,💯,✨,🎉,👏,💪,🙌");
  });

  test("the environment set before config.js loaded is what the accessors return", () => {
    assert.equal(config.SUDO, process.env.SUDO);
    assert.equal(config.PREFIX, ".");
    assert.equal(config.LANG, process.env.BOT_LANG);
    assert.equal(config.ENABLE_MESSAGE_REACTIONS, true);
    assert.equal(config.OPENAI_API_KEY, "");
    assert.equal(config.ALWAYS_ONLINE, false);
    assert.equal(config.PANEL_TOKEN, "");
  });

  test("a runtime assignment wins, clearRuntime() restores", () => {
    const before = config.PREFIX;
    config.PREFIX = "!";
    assert.equal(config.PREFIX, "!");
    assert.equal(settingsStore.get("PREFIX"), "!");
    settingsStore.clearRuntime();
    assert.equal(config.PREFIX, before);

    config.MAX_UPLOAD = 1;
    config.SUDO = "";
    assert.equal(config.MAX_UPLOAD, 1);
    assert.equal(config.SUDO, "");
    settingsStore.clearRuntime("SUDO");
    assert.equal(config.SUDO, process.env.SUDO);
    assert.equal(config.MAX_UPLOAD, 1, "clearing one key leaves the others");
  });

  test("assigning to a read-only catalog key is still possible for tests (tier 1), and never persisted", () => {
    config.PANEL_PORT = 1234;
    assert.equal(config.PANEL_PORT, 1234);
    settingsStore.clearRuntime();
    assert.equal(config.PANEL_PORT, 3000);
  });
});

describe("config.js in a fresh process", () => {
  const SNIPPET = `
    const config = require("./config");
    const store = require("./lib/utils/settingsStore");
    const out = {};
    for (const key of JSON.parse(process.env.OWB_PROBE)) out[key] = config[key];
    out.__problems = store.problems();
    out.__db = Object.keys(require.cache).filter((file) => /[\\\\/]lib[\\\\/]database[\\\\/]/.test(file)).length;
    out.__keys = Object.keys(config).length;
    console.log(JSON.stringify(out));
  `;
  const probe = (keys, env) => child(SNIPPET, { ...env, OWB_PROBE: JSON.stringify(keys) });

  test("an invalid environment value falls back to the default and appears in problems()", () => {
    const out = probe(["MAX_UPLOAD", "LOG_LEVEL", "PREFIX", "TIMEZONE", "AUTO_RESPONDER_MIN_DELAY", "WARN_LIMIT"], {
      MAX_UPLOAD: "0",
      LOG_LEVEL: "loud",
      PREFIX: "abcd",
      TIMEZONE: "UTC+3",
      AUTO_RESPONDER_MIN_DELAY: "0",
      WARN_LIMIT: "12abc",
    });
    assert.equal(out.MAX_UPLOAD, 230);
    assert.equal(out.LOG_LEVEL, "info");
    assert.equal(out.PREFIX, ".");
    assert.equal(out.TIMEZONE, "UTC");
    assert.equal(out.AUTO_RESPONDER_MIN_DELAY, 0, "0 is meaningful where the minimum is 0");
    assert.equal(out.WARN_LIMIT, 3);
    assert.deepEqual(Object.keys(out.__problems).sort(), ["LOG_LEVEL", "MAX_UPLOAD", "PREFIX", "TIMEZONE", "WARN_LIMIT"]);
    assert.equal(out.__problems.MAX_UPLOAD.code, "invalid_file_value");
  });

  test("valid environment values keep their legacy types", () => {
    const out = probe(["PREFIX", "SUDO", "MAX_UPLOAD", "ALWAYS_ONLINE", "AUTO_STATUS_REACT", "LANG", "WARN_MESSAGE", "PANEL_PORT", "PANEL_HOST", "STATUS_EMOJIS"], {
      PREFIX: "!",
      SUDO: "33612345678, 44712345678",
      MAX_UPLOAD: "50",
      ALWAYS_ONLINE: "true",
      AUTO_STATUS_REACT: "TRUE",
      BOT_LANG: "EN",
      WARN_MESSAGE: "one\\ntwo &mention",
      PORT: "8080",
      HOST: "0.0.0.0",
      STATUS_EMOJIS: "🔥,👍",
    });
    assert.deepEqual(
      { ...out, __problems: undefined, __db: undefined, __keys: undefined },
      {
        PREFIX: "!",
        SUDO: "33612345678, 44712345678",
        MAX_UPLOAD: 50,
        ALWAYS_ONLINE: true,
        AUTO_STATUS_REACT: false,
        LANG: "en",
        WARN_MESSAGE: "one\ntwo &mention",
        PANEL_PORT: 8080,
        PANEL_HOST: "0.0.0.0",
        STATUS_EMOJIS: "🔥,👍",
        __problems: undefined,
        __db: undefined,
        __keys: undefined,
      },
    );
    assert.deepEqual(out.__problems, {});
  });

  test("PANEL_ENABLED is not read; ADMIN_PANEL is true unless exactly \"false\"", () => {
    const keys = ["ADMIN_PANEL"];
    assert.equal(probe(keys, {}).ADMIN_PANEL, true);
    assert.equal(probe(keys, { PANEL_ENABLED: "true" }).ADMIN_PANEL, true);
    assert.equal(probe(keys, { PANEL_ENABLED: "false" }).ADMIN_PANEL, true);
    assert.equal(probe(keys, { ADMIN_PANEL: "false" }).ADMIN_PANEL, false);
    assert.equal(probe(keys, { ADMIN_PANEL: "False" }).ADMIN_PANEL, true);
    assert.equal(probe(keys, { ADMIN_PANEL: "0" }).ADMIN_PANEL, true);
    assert.equal(probe(keys, { ADMIN_PANEL: "true", PANEL_ENABLED: "false" }).ADMIN_PANEL, true);
    const out = probe(["PANEL_ENABLED"], { PANEL_ENABLED: "true" });
    assert.equal(out.PANEL_ENABLED, undefined);
    assert.deepEqual(out.__problems, {}, "an old variable is not a problem, only a boot warning");
  });

  test("PANEL_PORT is PANEL_PORT, then PORT, then 3000; PANEL_HOST is explicit or empty", () => {
    assert.equal(probe(["PANEL_PORT"], {}).PANEL_PORT, 3000);
    assert.equal(probe(["PANEL_PORT"], { PORT: "8080" }).PANEL_PORT, 8080);
    assert.equal(probe(["PANEL_PORT"], { PORT: "8080", PANEL_PORT: "9000" }).PANEL_PORT, 9000);
    assert.equal(probe(["PANEL_PORT"], { PORT: "8080", PANEL_PORT: "0" }).PANEL_PORT, 8080);
    assert.equal(probe(["PANEL_HOST"], {}).PANEL_HOST, "");
    assert.equal(probe(["PANEL_HOST"], { HOST: "10.0.0.5" }).PANEL_HOST, "10.0.0.5");
    assert.equal(probe(["PANEL_HOST"], { HOST: "10.0.0.5", PANEL_HOST: "127.0.0.1" }).PANEL_HOST, "127.0.0.1");
  });

  test("config.js loads with no database and no model", () => {
    const out = probe(["PREFIX"], {});
    assert.equal(out.__db, 0, "nothing under lib/database was loaded");
    assert.equal(out.__keys, 3 + catalog.entries.length);
    const source = read("config.js");
    assert.equal(/lib\/database/.test(source), false);
    assert.equal(/models/.test(source), false);
    const store = read("lib/utils/settingsStore.js");
    assert.equal(/require\(["']\.\.\/database/.test(store), false);
    const catalogSource = read("lib/utils/settingsCatalog.js");
    assert.equal(/require\(["'](\.|\.\.)\//.test(catalogSource), false, "the catalog imports no project module");
  });
});
