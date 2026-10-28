"use strict";

/**
 * config.env.example against the settings catalog (specs/002-admin-panel T213, settings-catalog.md section 8
 * item 2, SC-002; research U2, U1, U18, U19). Offline: it reads the example file and the pure catalog, and
 * runs the example through a private settings store, nothing else.
 *
 *  - every catalog setting that has an environment name is in the example (set, or off by default as a
 *    "#NAME=value" line) and every name in the example is a catalog name or alias;
 *  - the legacy PANEL_ENABLED is gone from the example, the compose file and the guides;
 *  - PANEL_HOST and PANEL_PORT are not set by default (the automatic bind address of U1 and a host-provided PORT
 *    stay in force for whoever copies the file);
 *  - the 21 settings without effect all sit in the closing "No effect in this version" block;
 *  - no secret ships with a value, and the file raises no `invalid_file_values` problem when loaded as is.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const catalog = require("../lib/utils/settingsCatalog");
const { createSettingsStore } = require("../lib/utils/settingsStore");

const ROOT = path.join(__dirname, "..");
const EXAMPLE_PATH = path.join(ROOT, "config.env.example");
const text = fs.readFileSync(EXAMPLE_PATH, "utf8");
const lines = text.split(/\r?\n/);

/** "NAME=value" (set) and "#NAME=value" (off by default); prose comments have a space after the "#" */
const SETTING_LINE = /^(#?)([A-Z][A-Z0-9_]*)=/;
const MARKER = /no effect in this version/i;

const declared = [];
lines.forEach((line, index) => {
  const match = SETTING_LINE.exec(line);
  if (match) declared.push({ name: match[2], active: match[1] === "", index });
});
const names = new Set(declared.map((d) => d.name));
const activeNames = new Set(declared.filter((d) => d.active).map((d) => d.name));
const parsed = dotenv.parse(Buffer.from(text));

const entries = catalog.entries;
const withEnv = entries.filter((e) => e.env);
/** Names a catalog entry answers to: its own `env` and the aliases (PORT and HOST) */
const known = new Set(entries.flatMap((e) => [e.env, ...(e.envAliases || [])]).filter(Boolean));
/** Documented legacy names that may still appear in the example: none, PANEL_ENABLED is gone (U2) */
const LEGACY_NAMES = [];

describe("config.env.example and the settings catalog", () => {
  test("every catalog setting with an environment name is in the example", () => {
    const missing = withEnv.map((e) => e.env).filter((name) => !names.has(name));
    assert.deepEqual(missing, [], "catalog names missing from config.env.example");
  });

  test("every name in the example is a catalog name, an alias or a documented legacy name (SC-002)", () => {
    const allowed = new Set([...known, ...LEGACY_NAMES]);
    const unknown = [...names].filter((name) => !allowed.has(name));
    assert.deepEqual(unknown, [], "names of config.env.example that the catalog does not know");
    // and the other way round: the example documents the whole catalog, nothing more
    assert.equal(names.size, withEnv.length, "one line per catalog setting that has an environment name");
  });

  test("a name is set at most once", () => {
    const seen = new Set();
    const twice = [];
    for (const d of declared.filter((x) => x.active)) {
      if (seen.has(d.name)) twice.push(d.name);
      seen.add(d.name);
    }
    assert.deepEqual(twice, []);
  });

  test("the names added by the admin panel feature are present", () => {
    const added = [
      "AUTO_STATUS_SAVE",
      "STATUS_SAVE_LIST",
      "STATUS_SAVE_FOLDER",
      "TTS_MAX_LENGTH",
      "MESSAGE_CONCURRENCY_LIMIT",
      "CACHE_CLEANUP_INTERVAL",
      "CACHE_MAX_AGE",
      "CONVERSATION_UPDATE_INTERVAL",
      "CONVERSATION_BATCH_SIZE",
      "MEMORY_CLEANUP_INTERVAL",
      "MEMORY_WARN_THRESHOLD",
      "ADMIN_PANEL",
      "PANEL_PUBLIC_URL",
      "PANEL_TRUST_PROXY",
      "LOG_FORMAT",
      "SUPERVISED",
      "UPDATE_CHECK",
    ];
    for (const name of added) assert.ok(activeNames.has(name), `${name} is missing from config.env.example`);
  });
});

describe("panel activation and bind address", () => {
  test("ADMIN_PANEL=true replaces PANEL_ENABLED, which is nowhere in the shipped files (U2)", () => {
    assert.equal(parsed.ADMIN_PANEL, "true");
    for (const rel of ["config.env.example", "docker-compose.yml", "Dockerfile", "README.md", "docs/BOT_HOSTING_GUIDE.md"]) {
      const content = fs.readFileSync(path.join(ROOT, rel), "utf8");
      assert.ok(!/PANEL_ENABLED\s*[=:]/.test(content), `${rel} still tells users to set PANEL_ENABLED`);
    }
    assert.ok(!/PANEL_ENABLED/.test(text), "the example does not even mention the removed variable");
  });

  test("PANEL_HOST and PANEL_PORT are not set by default, only offered (U1)", () => {
    for (const name of ["PANEL_HOST", "PANEL_PORT"]) {
      assert.ok(names.has(name), `${name} is offered as a commented line`);
      assert.ok(!activeNames.has(name), `${name} must not be set in the example`);
      assert.equal(parsed[name], undefined);
    }
    assert.ok(/\bPORT\b/.test(text) && /\bHOST\b/.test(text), "a comment mentions the PORT and HOST aliases");
  });

  test("the aliases PORT and HOST are documented but never set", () => {
    assert.ok(!names.has("PORT"));
    assert.ok(!names.has("HOST"));
    assert.deepEqual(catalog.byKey.get("PANEL_PORT").envAliases, ["PORT"]);
    assert.deepEqual(catalog.byKey.get("PANEL_HOST").envAliases, ["HOST"]);
  });
});

describe("settings without effect", () => {
  const inactive = entries.filter((e) => e.inactive);
  const markerLine = lines.findIndex((line) => line.startsWith("#") && MARKER.test(line));

  test("there are 21 of them and the example has a marker comment", () => {
    assert.equal(inactive.length, 21);
    assert.ok(markerLine > 0, 'a comment says "No effect in this version"');
  });

  test("they all sit after the marker, and nothing else does", () => {
    const after = declared.filter((d) => d.index > markerLine);
    assert.deepEqual(
      after.map((d) => d.name).sort(),
      inactive.map((e) => e.env).sort(),
      "the closing block holds exactly the inactive settings",
    );
    for (const d of declared.filter((x) => x.index < markerLine)) {
      const entry = catalog.byKey.get(d.name);
      assert.ok(!entry || !entry.inactive, `${d.name} has no effect but is above the marker`);
    }
  });
});

describe("values shipped in the example", () => {
  test("no secret ships with a value (placeholders only)", () => {
    const secrets = entries.filter((e) => e.env && e.secret);
    assert.ok(secrets.length >= 20);
    for (const entry of secrets) {
      assert.ok(names.has(entry.env), `${entry.env} is in the example`);
      assert.equal(parsed[entry.env] || "", "", `${entry.env} must be empty in the example`);
    }
  });

  test("the five default-differs keys keep their example value, which differs from the code default (U19)", () => {
    const keys = entries.filter((e) => e.flags.includes("default-differs"));
    assert.deepEqual(
      keys.map((e) => e.key).sort(),
      ["AUTO_READ", "AUTO_STATUS_VIEW", "ENABLE_MESSAGE_REACTIONS", "STICKER_AUTHOR", "VPS"],
    );
    for (const entry of keys) {
      assert.ok(activeNames.has(entry.env), `${entry.env} stays set in the example`);
      const shipped = entry.parse(parsed[entry.env]);
      assert.notEqual(shipped, undefined, `${entry.env} parses`);
      assert.notDeepEqual(shipped, entry.default, `${entry.env}: the example value differs from the code default`);
    }
  });

  test("the example raises no invalid_file_values problem and keeps the code defaults of the new settings", () => {
    const store = createSettingsStore({ env: { ...parsed }, redactor: { register() {}, unregister() {}, scrub: (t) => t } });
    assert.deepEqual(store.problems(), {});
    // an unset value is not an override of the default: the new tuning names equal their code defaults
    for (const entry of withEnv.filter((e) => e.flags.includes("not-in-example") && !e.inactive)) {
      assert.deepEqual(store.describe(entry.key).value, entry.default, `${entry.key} in the example equals its default`);
    }
    // the example sets PANEL_PUBLIC_URL and PANEL_TRUST_PROXY empty: the panel stays on its safe defaults
    assert.equal(store.describe("PANEL_PUBLIC_URL").value, "");
    assert.deepEqual(store.describe("PANEL_TRUST_PROXY").value, []);
    assert.equal(store.describe("ADMIN_PANEL").value, true);
    assert.equal(store.describe("UPDATE_CHECK").value, true);
    assert.equal(store.describe("SUPERVISED").value, "auto");
    assert.equal(store.describe("LOG_FORMAT").value, "pretty");
  });
});
