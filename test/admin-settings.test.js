"use strict";
/**
 * SET-1 / SET-2 of the admin panel (T106, FR-014 to FR-021, FR-030, SC-004; admin-http-api.md 2.5,
 * settings-catalog.md 2.4 and 3), through the real createAdmin, the real settings store and an in-memory database.
 *
 *  - SET-1: the ResolvedSetting list (about 100 entries), origins, versions, secrets as { set, last4, needsReentry },
 *    restartPending, secretStore, ownersConfigured, no database needed;
 *  - SET-2: the whole batch is validated before anything is written, stale versions, op set / default / revert,
 *    read-only and inactive keys, the SUDO confirmation, forced_by_env, live settings, restart settings;
 *  - secrets never appear in an answer, an error, an audit detail, a log or a table other than as ciphertext;
 *  - the four adapters (autoResponder, antiDelete, viewOnce, statusSave) write through the same code as the WhatsApp
 *    commands, in one transaction for the rows, and invalidate their SettingsCache keys.
 *
 * Offline: no network; the secret key goes to a temporary directory; the status-save file is a temporary fake.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createTestAdmin } = require("./helpers/adminHarness");
const catalog = require("../lib/utils/settingsCatalog");
const settingsStore = require("../lib/utils/settingsStore");
const settingsCache = require("../lib/utils/settingsCache");
const secretBox = require("../lib/utils/secretBox");
const config = require("../config");
const antidel = require("../plugins/antidel");
const viewonce = require("../plugins/viewonce");
const autorespond = require("../plugins/autorespond");
const { parseChanges } = require("../lib/admin/services/settings");

const FAKE_KEY = "sk-test-FAKE0000-AAAA1234";
const OTHER_KEY = "sk-test-OTHER111-BBBB5678";
const JID = "237600000000@s.whatsapp.net";

let db;
let tmp;
let t;
let client;
let status;
let runtime;

/** A stand-in for lib/utils/statusListStore.js on a temporary file (the real one writes to data/) */
function makeStatusStore(dir) {
  const FILE_PATH = path.join(dir, "status_save.json");
  const calls = [];
  const persist = (data) => fs.writeFileSync(FILE_PATH, JSON.stringify(data));
  const load = () => {
    if (!fs.existsSync(FILE_PATH)) persist({ enabled: Boolean(settingsStore.get("AUTO_STATUS_SAVE")), list: [] });
    return JSON.parse(fs.readFileSync(FILE_PATH, "utf8"));
  };
  const snapshot = (data) => {
    const forcedByEnv = Boolean(settingsStore.get("AUTO_STATUS_SAVE"));
    return { enabled: data.enabled, list: data.list.slice(), forcedByEnv, active: data.enabled || forcedByEnv };
  };
  return {
    FILE_PATH,
    calls,
    async get() {
      return snapshot(load());
    },
    async add(number) {
      calls.push(["add", number]);
      const data = load();
      if (!data.list.includes(number)) data.list.push(number);
      persist(data);
      return snapshot(data);
    },
    async remove(number) {
      calls.push(["remove", number]);
      const data = load();
      data.list = data.list.filter((n) => n !== number);
      persist(data);
      return snapshot(data);
    },
    async setEnabled(enabled) {
      calls.push(["setEnabled", enabled]);
      const data = load();
      data.enabled = Boolean(enabled);
      persist(data);
      return snapshot(data);
    },
    /** Another process writes the file: the mtime moves */
    touch(patch) {
      const data = load();
      persist({ ...data, ...patch });
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(FILE_PATH, later, later);
    },
    reset() {
      fs.rmSync(FILE_PATH, { force: true });
      calls.length = 0;
    },
  };
}

before(async () => {
  db = await fakes.syncDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-admin-settings-"));
  secretBox.configure({ dir: path.join(tmp, "data") }); // never the real data/panel.key
  status = makeStatusStore(tmp);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function resetState() {
  for (const model of [db.SettingOverride, db.AutoResponder, db.AntiDelete, db.ViewOnce]) await model.destroy({ where: {} });
  fs.rmSync(path.join(tmp, "data"), { recursive: true, force: true });
  status.reset();
  settingsCache.clear();
  settingsStore.clearRuntime();
  // the store remembers versions after a reset; every test starts from "never created"
  settingsStore._rows.clear();
  settingsStore._lastVersion.clear();
  await settingsStore.load({ models: db });
  settingsStore.markInForce();
}

async function boot(opts = {}) {
  await resetState();
  runtime = { dbReady: true };
  t = await createTestAdmin({ deps: { statusListStore: status, runtime, ...(opts.deps || {}) }, ...opts.harness });
  await t.admin.start();
  client = await t.loginClient();
  return t;
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  if (t) await t.close();
  t = null;
  settingsStore.clearRuntime();
});

/** SET-2 with the version the SPA would send (read from SET-1) unless given */
const get = async () => (await client.get("/admin/api/settings")).json;
const byKey = (answer, key) => answer.settings.find((entry) => entry.key === key);
const patch = (changes, extra = {}) => client.api("PATCH", "/admin/api/settings", { changes, ...extra });
const set = (key, value, version = 0) => ({ key, op: "set", value, version });
const auditRows = (where = {}) => t.db.AuditLog.findAll({ where, raw: true, order: [["id", "ASC"]] });
const overrideRow = (key) => db.SettingOverride.findOne({ where: { key }, raw: true });

/** Everything a secret could leak into after a test: answers, audit rows, logs */
async function leaks(secret) {
  const audit = JSON.stringify(await auditRows());
  const logs = JSON.stringify(t.logger.lines);
  return [audit.includes(secret) ? "audit" : null, logs.includes(secret) ? "logs" : null].filter(Boolean);
}

// ---------------------------------------------------------------------------
// SET-1
// ---------------------------------------------------------------------------

describe("SET-1: the ResolvedSetting list", () => {
  test("is a session route and answers 401 without one", async () => {
    const anonymous = t.client();
    const answer = await anonymous.get("/admin/api/settings");
    assert.equal(answer.status, 401);
    assert.equal(answer.json.error.code, "unauthenticated");
  });

  test("lists every catalog entry in the shape of settings-catalog.md 2.4", async () => {
    const answer = await get();
    assert.equal(answer.settings.length, catalog.entries.length);
    assert.equal(answer.settings.length, 101);
    assert.deepEqual(
      answer.settings.map((s) => s.key),
      catalog.entries.map((e) => e.key),
    );
    assert.deepEqual(answer.restartPending, []);
    assert.equal(answer.secretStore, "ok");
    assert.equal(answer.ownersConfigured, true);

    const expectedKeys = [
      "key", "theme", "source", "type", "rules", "unit", "default", "derived", "secret", "fileValue", "origin",
      "canRevert", "version", "effect", "readonly", "inactive", "pendingRestart", "problem", "testService", "confirm",
    ];
    for (const entry of answer.settings) {
      for (const property of expectedKeys) assert.ok(property in entry, `${entry.key} lacks ${property}`);
      assert.ok(["default", "env", "override"].includes(entry.origin), `${entry.key} origin ${entry.origin}`);
      assert.equal(typeof entry.canRevert, "boolean");
      assert.ok(Number.isSafeInteger(entry.version) && entry.version >= 0);
      assert.ok(["immediate", "restart", "boot-only"].includes(entry.effect));
    }

    const prefix = byKey(answer, "PREFIX");
    assert.equal(prefix.value, ".");
    assert.deepEqual(prefix.rules, { minChars: 1, maxChars: 3, noWhitespace: true });
    assert.equal(prefix.default, ".");
    assert.equal(prefix.version, 0);
    assert.equal(prefix.canRevert, false);
  });

  test("a secret carries { set, last4, needsReentry } and never a value", async () => {
    await patch([set("OPENAI_API_KEY", FAKE_KEY)]);
    const answer = await get();
    const secrets = answer.settings.filter((s) => catalog.byKey.get(s.key).secret);
    assert.equal(secrets.length, 22);
    for (const entry of secrets) {
      assert.ok(!("value" in entry), `${entry.key} must not carry a value`);
      assert.equal(entry.fileValue, null);
      assert.equal(entry.default, null);
    }
    const key = byKey(answer, "OPENAI_API_KEY");
    assert.deepEqual(key.secret, { set: true, last4: "1234", needsReentry: false });
    assert.equal(key.origin, "override");
    assert.equal(key.canRevert, true);
    assert.equal(key.testService, "openai");
    assert.deepEqual(byKey(answer, "GEMINI_API_KEY").secret, { set: false, last4: null, needsReentry: false });
    assert.deepEqual(byKey(answer, "DATABASE_URL").secret, { set: true, scheme: "sqlite" }, "the scheme only");
    assert.ok(!JSON.stringify(answer).includes(FAKE_KEY));
  });

  test("a stored secret that cannot be decrypted is ignored and flagged needsReentry, secretStore key_missing", async () => {
    await patch([set("OPENAI_API_KEY", FAKE_KEY)]);
    fs.rmSync(path.join(tmp, "data", "panel.key"));
    await settingsStore.reload();
    const answer = await get();
    const key = byKey(answer, "OPENAI_API_KEY");
    assert.deepEqual(key.secret, { set: false, last4: null, needsReentry: true });
    assert.equal(key.problem.code, "reenter");
    assert.equal(answer.secretStore, "key_missing");
  });

  test("origins: default, env (the file or the environment), override; revert is possible on an override only", async () => {
    const before = byKey(await get(), "TIMEZONE");
    assert.ok(["default", "env"].includes(before.origin));
    assert.equal(before.canRevert, false);
    await patch([set("TIMEZONE", "Africa/Douala", before.version)]);
    const after = byKey(await get(), "TIMEZONE");
    assert.equal(after.origin, "override");
    assert.equal(after.value, "Africa/Douala");
    assert.equal(after.canRevert, true);
    assert.equal(after.version, 1);
    // PREFIX comes from the environment of the test (fakes.setupEnv)
    const prefix = byKey(await get(), "PREFIX");
    assert.equal(prefix.origin, "env");
    assert.equal(prefix.fileValue, ".");
  });

  test("answers while the database is down (values from memory; adapter entries flagged, not failed)", async () => {
    await patch([set("PREFIX", "!")]);
    runtime.dbReady = false;
    const down = db.AntiDelete.findOne;
    db.AntiDelete.findOne = async () => {
      const error = new Error("connection refused");
      error.name = "SequelizeConnectionError";
      throw error;
    };
    try {
      const answer = await client.get("/admin/api/settings");
      assert.equal(answer.status, 200, JSON.stringify(answer.json));
      assert.equal(byKey(answer.json, "PREFIX").value, "!");
      assert.equal(byKey(answer.json, "ANTIDELETE_MODE").problem.code, "adapter_unavailable");
      assert.equal(byKey(answer.json, "VIEWONCE_MODE").problem, null);
      // a write needs the database
      const write = await patch([set("PREFIX", "?", 1)]);
      assert.equal(write.status, 503);
    } finally {
      db.AntiDelete.findOne = down;
      runtime.dbReady = true;
    }
  });

  test("boot entries show the effective value of the process (PANEL_HOST: the address it binds)", async () => {
    const host = byKey(await get(), "PANEL_HOST");
    assert.equal(host.readonly, true);
    assert.equal(host.effect, "boot-only");
    assert.equal(host.derived, "auto_host");
    assert.match(host.value, /^(127\.0\.0\.1|0\.0\.0\.0)$/);
  });
});

// ---------------------------------------------------------------------------
// SET-2: validation, versions, ops
// ---------------------------------------------------------------------------

describe("SET-2: the whole batch is validated before anything is written", () => {
  test("one invalid key refuses the batch: 422 with fields[key], nothing written, no audit", async () => {
    const answer = await patch([set("PREFIX", "!"), set("TIMEZONE", "UTC+3")]);
    assert.equal(answer.status, 422);
    assert.equal(answer.json.error.code, "validation_failed");
    assert.deepEqual(Object.keys(answer.json.error.fields), ["TIMEZONE"]);
    assert.equal(answer.json.error.fields.TIMEZONE.code, "invalid_timezone");
    assert.equal(await overrideRow("PREFIX"), null);
    assert.equal(config.PREFIX, ".");
    assert.equal((await auditRows({ action: "setting.update" })).length, 0);
  });

  test("every invalid key is reported at once, the submitted values are never echoed", async () => {
    const answer = await patch([
      set("PREFIX", "a b"),
      set("WARN_LIMIT", 9999),
      set("STATUS_EMOJIS", ["ok"]),
      set("BOT_LANG", "xx"),
      set("AUTO_RESPONDER_MIN_DELAY", "fast"),
    ]);
    assert.equal(answer.status, 422);
    const fields = answer.json.error.fields;
    assert.equal(fields.PREFIX.code, "invalid_format");
    assert.deepEqual(fields.WARN_LIMIT, { code: "out_of_range", params: { min: 1, max: 50 } });
    assert.equal(fields.STATUS_EMOJIS.code, "invalid_emoji");
    assert.deepEqual(fields.STATUS_EMOJIS.params.indices, [0]);
    assert.equal(fields.BOT_LANG.code, "not_allowed");
    assert.ok(fields.BOT_LANG.params.allowed.includes("fr"));
    assert.equal(fields.AUTO_RESPONDER_MIN_DELAY.code, "invalid_type");
    for (const echoed of ["a b", "9999", "\"xx\"", "fast"]) assert.ok(!answer.text.includes(echoed), `${echoed} echoed`);
    assert.equal(await db.SettingOverride.count(), 0);
  });

  test("cross-field rules run on the resulting values (min delay above max delay: bound_conflict)", async () => {
    let answer = await patch([set("AUTO_RESPONDER_MIN_DELAY", 5000), set("AUTO_RESPONDER_MAX_DELAY", 2000)]);
    assert.equal(answer.status, 422);
    assert.deepEqual(answer.json.error.fields.AUTO_RESPONDER_MIN_DELAY, { code: "bound_conflict", params: { other: "AUTO_RESPONDER_MAX_DELAY" } });
    assert.equal(answer.json.error.fields.AUTO_RESPONDER_MAX_DELAY.code, "bound_conflict");

    // a single key against the stored value of the other
    answer = await patch([set("AUTO_RESPONDER_MIN_DELAY", 4000)]);
    assert.equal(answer.status, 422, "default max delay is 3000");
    assert.deepEqual(Object.keys(answer.json.error.fields), ["AUTO_RESPONDER_MIN_DELAY"]);
    assert.equal(await db.SettingOverride.count(), 0);
  });

  test("read-only (boot-only, inactive, executable path) and unknown keys are refused", async () => {
    const answer = await patch([set("PANEL_PORT", 8080), set("GROQ_API_KEY", FAKE_KEY), set("YTDLP_PATH", "/bin/sh"), set("NOT_A_SETTING", 1)]);
    assert.equal(answer.status, 422);
    const fields = answer.json.error.fields;
    assert.equal(fields.PANEL_PORT.code, "readonly");
    assert.equal(fields.GROQ_API_KEY.code, "readonly");
    assert.equal(fields.YTDLP_PATH.code, "readonly");
    assert.equal(fields.NOT_A_SETTING.code, "unknown_setting");
    assert.equal(await db.SettingOverride.count(), 0);
  });

  test("the request is strict: unknown properties, bad shapes, duplicates, 1 to 50 changes, versions required", async () => {
    const send = (body) => client.api("PATCH", "/admin/api/settings", body);
    let answer = await send({ changes: [set("PREFIX", "!")], extra: 1 });
    assert.equal(answer.status, 422);
    assert.equal(answer.json.error.fields.$unknown.code, "unknown_field");

    answer = await send({ changes: [{ ...set("PREFIX", "!"), extra: true }] });
    assert.equal(answer.json.error.fields.$unknown.code, "unknown_field");

    answer = await send({ changes: [] });
    assert.equal(answer.status, 422);
    answer = await send({});
    assert.equal(answer.json.error.fields.changes.code, "required");
    answer = await send({ changes: "PREFIX" });
    assert.equal(answer.json.error.fields.changes.code, "invalid_type");

    answer = await send({ changes: Array.from({ length: 51 }, (_, i) => set(`KEY_${i}A`, 1)) });
    assert.equal(answer.json.error.fields.changes.code, "too_many_items");

    answer = await send({ changes: [set("PREFIX", "!"), set("PREFIX", "?")] });
    assert.equal(answer.json.error.fields.PREFIX.code, "duplicate");

    answer = await send({ changes: [{ key: "PREFIX", op: "set", value: "!" }] });
    assert.equal(answer.json.error.fields.PREFIX.code, "required", "version is required");
    answer = await send({ changes: [{ key: "PREFIX", op: "nope", value: "!", version: 0 }] });
    assert.equal(answer.json.error.fields.PREFIX.code, "not_allowed");
    answer = await send({ changes: [{ key: "PREFIX", op: "set", version: 0 }] });
    assert.equal(answer.json.error.fields.PREFIX.code, "required", "set needs a value");
    answer = await send({ changes: [{ key: "PREFIX", op: "revert", value: "!", version: 0 }] });
    assert.equal(answer.json.error.fields.PREFIX.code, "not_applicable");
    answer = await send({ changes: [{ key: "prefix", op: "set", value: "!", version: 0 }] });
    assert.equal(answer.json.error.fields.changes.code, "invalid_format");
    answer = await send({ changes: [set("PREFIX", "!")], confirm: ["everything"] });
    assert.equal(answer.status, 422);
    assert.equal(await db.SettingOverride.count(), 0);

    assert.throws(() => parseChanges(null), (error) => error.code === "validation_failed");
    assert.deepEqual(parseChanges([set("PREFIX", "!", 3)]), [{ key: "PREFIX", op: "set", hasValue: true, value: "!", version: 3 }]);
  });

  test("a CSRF token and a JSON content type are required (the guard of every unsafe route)", async () => {
    const forged = await client.api("PATCH", "/admin/api/settings", { changes: [set("PREFIX", "!")] }, { headers: { "X-CSRF-Token": "wrong" } });
    assert.equal(forged.status, 403);
    assert.equal(await overrideRow("PREFIX"), null);
  });
});

describe("SET-2: versions (optimistic concurrency)", () => {
  test("a stale version refuses the whole batch: 409 conflict with fields[key] = { conflict, version }", async () => {
    await patch([set("PREFIX", "!", 0)]);
    const answer = await patch([set("PREFIX", "?", 0), set("TIMEZONE", "Africa/Douala", 0)]);
    assert.equal(answer.status, 409);
    assert.equal(answer.json.error.code, "conflict");
    assert.deepEqual(answer.json.error.fields, { PREFIX: { code: "conflict", params: { version: 1 } } });
    assert.equal(config.PREFIX, "!", "unchanged");
    assert.equal(await overrideRow("TIMEZONE"), null, "the other key of the batch was not written");
  });

  test("every write bumps the version; a key never created has version 0", async () => {
    let answer = await patch([set("WARN_LIMIT", 5, 0)]);
    assert.equal(answer.status, 200);
    assert.equal(byKey(answer.json, "WARN_LIMIT").version, 1);
    answer = await patch([set("WARN_LIMIT", 6, 1)]);
    assert.equal(byKey(answer.json, "WARN_LIMIT").version, 2);
    assert.equal(byKey(await get(), "WARN_LIMIT").value, 6);
  });
});

describe("SET-2: set, default, revert", () => {
  test("set stores the value; default stores the catalog default as an override; revert deletes the override", async () => {
    let answer = await patch([set("WARN_LIMIT", 7)]);
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    let entry = byKey(answer.json, "WARN_LIMIT");
    assert.deepEqual([entry.value, entry.origin, entry.canRevert, entry.version], [7, "override", true, 1]);
    assert.equal(config.WARN_LIMIT, 7);

    answer = await patch([{ key: "WARN_LIMIT", op: "default", version: 1 }]);
    entry = byKey(answer.json, "WARN_LIMIT");
    assert.deepEqual([entry.value, entry.origin, entry.version], [3, "override", 2], "the default is now an override that masks a file value");
    assert.equal((await overrideRow("WARN_LIMIT")).value, "3");

    answer = await patch([{ key: "WARN_LIMIT", op: "revert", version: 2 }]);
    entry = byKey(answer.json, "WARN_LIMIT");
    assert.deepEqual([entry.value, entry.origin, entry.canRevert], [3, "default", false]);
    assert.equal(await overrideRow("WARN_LIMIT"), null);
  });

  test("revert falls back to the file/environment value, not to the default", async () => {
    await patch([set("PREFIX", "!")]);
    const answer = await patch([{ key: "PREFIX", op: "revert", version: 1 }]);
    const entry = byKey(answer.json, "PREFIX");
    assert.deepEqual([entry.value, entry.origin], [".", "env"]);
    assert.equal(config.PREFIX, ".");
  });

  test("a deliberate empty string is an override (clear a model name); default of a derived entry is empty", async () => {
    const answer = await patch([set("IMAGE_MODEL", "imagen-test"), set("GEMINI_VISION_MODEL", "gemini-test")]);
    assert.equal(answer.status, 200);
    const reset = await patch([{ key: "GEMINI_VISION_MODEL", op: "default", version: 1 }]);
    assert.equal(byKey(reset.json, "GEMINI_VISION_MODEL").value, config.GEMINI_MODEL, "empty means the same as GEMINI_MODEL");
  });

  test("revert on an adapter-backed key is not_applicable", async () => {
    const answer = await patch([{ key: "ANTIDELETE_MODE", op: "revert", version: 0 }, { key: "AUTO_STATUS_SAVE", op: "revert", version: 0 }]);
    assert.equal(answer.status, 422);
    assert.equal(answer.json.error.fields.ANTIDELETE_MODE.code, "not_applicable");
    assert.equal(answer.json.error.fields.AUTO_STATUS_SAVE.code, "not_applicable");
  });

  test("the audit trail: setting.update for set, setting.reset for default and revert, detail { from, to }", async () => {
    await patch([set("WARN_LIMIT", 5)]);
    await patch([{ key: "WARN_LIMIT", op: "default", version: 1 }]);
    await patch([{ key: "WARN_LIMIT", op: "revert", version: 2 }]);
    const rows = await auditRows({ target: "WARN_LIMIT" });
    assert.deepEqual(rows.map((r) => r.action), ["setting.update", "setting.reset", "setting.reset"]);
    assert.deepEqual(JSON.parse(rows[0].detail), { from: 3, to: 5 });
    assert.deepEqual(JSON.parse(rows[1].detail), { from: 5, to: 3 });
    assert.deepEqual(JSON.parse(rows[2].detail), { from: 3, to: 3 });
    assert.ok(rows.every((r) => r.result === "ok"));
  });

  test("a revert with no override changes and audits nothing", async () => {
    const answer = await patch([{ key: "WARN_LIMIT", op: "revert", version: 0 }]);
    assert.equal(answer.status, 200);
    assert.equal((await auditRows({ action: "setting.reset" })).length, 0);
  });
});

describe("SET-2: SUDO and the owners confirmation", () => {
  test("emptying the owner list needs confirm: [owners_empty]", async () => {
    const answer = await patch([set("SUDO", [])]);
    assert.equal(answer.status, 409);
    assert.equal(answer.json.error.code, "confirmation_required");
    assert.deepEqual(answer.json.error.params.confirm, ["owners_empty"]);
    assert.equal(config.SUDO, "111", "nothing was written");

    const confirmed = await patch([set("SUDO", [])], { confirm: ["owners_empty"] });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
    assert.equal(config.SUDO, "");
    assert.equal(byKey(await get(), "SUDO").value.length, 0);
    assert.equal((await get()).ownersConfigured, false);
  });

  test("a revert or a default that empties the list needs the confirmation too", async () => {
    await patch([set("SUDO", ["222222"])]);
    const answer = await patch([{ key: "SUDO", op: "default", version: 1 }]);
    assert.equal(answer.status, 409);
    const reverted = await patch([{ key: "SUDO", op: "revert", version: 1 }]);
    assert.equal(reverted.status, 200, "the environment still lists an owner");
    assert.equal(config.SUDO, "111");
  });

  test("changing the owners without emptying them needs no confirmation; entries are normalised", async () => {
    const answer = await patch([set("SUDO", ["+237 600", "237600000000", "bad"])]);
    assert.equal(answer.status, 422);
    assert.deepEqual(answer.json.error.fields.SUDO.params.indices, [0, 2]);
    const ok = await patch([set("SUDO", ["+237600000001", "237600000001@s.whatsapp.net", "222222"])]);
    assert.equal(ok.status, 200);
    assert.equal(config.SUDO, "237600000001,222222", "de-duplicated by user part, no +");
  });
});

describe("SET-2: live settings and restart settings", () => {
  test("an immediate setting is live before the answer is sent", async () => {
    const answer = await patch([set("PREFIX", "!"), set("TIMEZONE", "Africa/Douala"), set("STATUS_EMOJIS", ["🔥", "👍"])]);
    assert.equal(answer.status, 200);
    assert.equal(config.PREFIX, "!");
    assert.equal(config.TIMEZONE, "Africa/Douala");
    assert.equal(config.STATUS_EMOJIS, "🔥,👍", "lists stay comma-joined strings for the readers");
    assert.deepEqual(answer.json.restartPending, []);
  });

  test("a restart setting is stored at once and listed in restartPending until the baseline is refreshed", async () => {
    const answer = await patch([set("ALWAYS_ONLINE", true)]);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json.restartPending, ["ALWAYS_ONLINE"]);
    assert.equal(byKey(answer.json, "ALWAYS_ONLINE").pendingRestart, true);
    assert.equal(config.ALWAYS_ONLINE, true);
    assert.deepEqual((await get()).restartPending, ["ALWAYS_ONLINE"]);

    settingsStore.markInForce(); // what BotRuntime.restartBot does
    assert.deepEqual((await get()).restartPending, []);
  });

  test("a change listener of the store runs before the answer (dependent caches are reset)", async () => {
    const seen = [];
    const off = settingsStore.onChange(["GEMINI_API_KEY"], ({ keys, source }) => seen.push([keys, source]));
    try {
      await patch([set("GEMINI_API_KEY", FAKE_KEY)]);
      assert.deepEqual(seen, [[["GEMINI_API_KEY"], "panel"]]);
    } finally {
      off();
    }
  });
});

// ---------------------------------------------------------------------------
// Secrets (FR-017, SC-004)
// ---------------------------------------------------------------------------

describe("secrets", () => {
  test("a secret is encrypted at rest and never echoed by an answer, an audit row or a log", async () => {
    const answer = await patch([set("OPENAI_API_KEY", FAKE_KEY), set("GIPHY_API_KEY", OTHER_KEY)]);
    assert.equal(answer.status, 200);
    assert.ok(!answer.text.includes(FAKE_KEY) && !answer.text.includes(OTHER_KEY));
    assert.deepEqual(byKey(answer.json, "OPENAI_API_KEY").secret, { set: true, last4: "1234", needsReentry: false });

    const row = await overrideRow("OPENAI_API_KEY");
    assert.match(row.value, /^enc:v1:/);
    assert.ok(!row.value.includes(FAKE_KEY));
    assert.equal(config.OPENAI_API_KEY, FAKE_KEY, "the bot reads the clear value through config");

    const audit = await auditRows({ target: "OPENAI_API_KEY" });
    assert.deepEqual(JSON.parse(audit[0].detail), { secret: true, op: "set" });
    assert.deepEqual(await leaks(FAKE_KEY), []);
    assert.deepEqual(await leaks(OTHER_KEY), []);
    // no other table holds it either
    const tables = JSON.stringify(Object.entries(await t.dumpTables()).filter(([name]) => name !== "SettingOverride"));
    assert.ok(!tables.includes(FAKE_KEY));
  });

  test("a rejected secret is not echoed; too short is refused before anything is written", async () => {
    const answer = await patch([set("OPENAI_API_KEY", "abc123")]);
    assert.equal(answer.status, 422);
    assert.deepEqual(answer.json.error.fields.OPENAI_API_KEY, { code: "too_short", params: { min: 8 } });
    assert.ok(!answer.text.includes("abc123"));
    const spaced = await patch([set("OPENAI_API_KEY", `${FAKE_KEY} with spaces`)]);
    assert.equal(spaced.status, 422);
    assert.ok(!spaced.text.includes(FAKE_KEY));
  });

  test("default clears a secret; the audit says clear; a secret needs no restart", async () => {
    await patch([set("OPENAI_API_KEY", FAKE_KEY)]);
    const answer = await patch([{ key: "OPENAI_API_KEY", op: "default", version: 1 }]);
    assert.equal(answer.status, 200);
    assert.deepEqual(byKey(answer.json, "OPENAI_API_KEY").secret, { set: false, last4: null, needsReentry: false });
    assert.equal(config.OPENAI_API_KEY, "");
    const rows = await auditRows({ target: "OPENAI_API_KEY" });
    assert.deepEqual(JSON.parse(rows[1].detail), { secret: true, op: "clear" });
    assert.equal(rows[1].action, "setting.reset");
    assert.deepEqual(await leaks(FAKE_KEY), []);
  });

  test("a version conflict on a secret reports the version, not the value", async () => {
    await patch([set("OPENAI_API_KEY", FAKE_KEY)]);
    const answer = await patch([set("OPENAI_API_KEY", OTHER_KEY, 0)]);
    assert.equal(answer.status, 409);
    assert.deepEqual(answer.json.error.fields.OPENAI_API_KEY, { code: "conflict", params: { version: 1 } });
    assert.ok(!answer.text.includes(OTHER_KEY) && !answer.text.includes(FAKE_KEY));
  });

  test("when the key file cannot be written the secret is not stored and nothing leaks", async () => {
    // a file where the data directory should be: encrypt() cannot create the key
    fs.writeFileSync(path.join(tmp, "data"), "not a directory");
    const answer = await patch([set("OPENAI_API_KEY", FAKE_KEY), set("PREFIX", "!")]);
    assert.equal(answer.status, 500);
    assert.ok(!answer.text.includes(FAKE_KEY));
    assert.equal(await db.SettingOverride.count(), 0, "all or nothing: PREFIX was not written either");
    assert.deepEqual(await leaks(FAKE_KEY), []);
  });
});

// ---------------------------------------------------------------------------
// Adapters (FR-030)
// ---------------------------------------------------------------------------

describe("adapter autoResponder", () => {
  test("SET-1 shows the environment seed until a row exists, then the row (origin override, version = updatedAt)", async () => {
    let entry = byKey(await get(), "AUTO_RESPONDER_ENABLED");
    assert.deepEqual([entry.value, entry.version, entry.canRevert], [false, 0, false]);
    assert.ok(["default", "env"].includes(entry.origin));

    const answer = await patch([set("AUTO_RESPONDER_ENABLED", true), set("AUTO_RESPONDER_IGNORE_NUMBERS", ["+237 600 000 001", "237600000002"]), set("AUTO_RESPONDER_PERSONALITY", "Be brief.")]);
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    entry = byKey(answer.json, "AUTO_RESPONDER_ENABLED");
    assert.deepEqual([entry.value, entry.origin, entry.canRevert], [true, "override", false]);
    assert.ok(entry.version > 0);
    assert.deepEqual(byKey(answer.json, "AUTO_RESPONDER_IGNORE_NUMBERS").value, ["+237600000001", "237600000002"]);
    assert.equal(byKey(answer.json, "AUTO_RESPONDER_PERSONALITY").value, "Be brief.");

    const row = await db.AutoResponder.findOne({ where: { id: 1 }, raw: true });
    assert.equal(Boolean(row.enabled), true);
    assert.equal(row.ignoreNumbers, "+237600000001,237600000002");
    assert.equal(row.personality, "Be brief.");
    assert.equal(await db.SettingOverride.count(), 0, "adapter keys never get an override row");
  });

  test("the plugin's own reader sees the change at once: the SettingsCache key is invalidated", async () => {
    const handler = require("../lib/utils/autoResponderHandler");
    const before = await handler.getSettings(); // primes the cache
    assert.equal(Boolean(before.enabled), false);
    assert.ok(settingsCache.cache.has("auto_responder"));

    // the handler created the row: the panel works from the version it reads
    const version = byKey(await get(), "AUTO_RESPONDER_ENABLED").version;
    assert.ok(version > 0);
    const answer = await patch([set("AUTO_RESPONDER_ENABLED", true, version)]);
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    const after = await handler.getSettings();
    assert.equal(Boolean(after.enabled), true);
  });

  test("the .ar command and the panel write the same row: a change by the command is visible, and makes the panel's version stale", async () => {
    const row = await autorespond.loadSettings();
    await autorespond.updateSettings(row, { enabled: true, personality: "From the command" });
    const entry = byKey(await get(), "AUTO_RESPONDER_PERSONALITY");
    assert.equal(entry.value, "From the command");
    assert.equal(entry.origin, "override", "stored by the bot: indistinguishable from a panel write");
    const stale = await patch([set("AUTO_RESPONDER_PERSONALITY", "Panel text", 0)]);
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.fields.AUTO_RESPONDER_PERSONALITY.params.version, entry.version);
    const fresh = await patch([set("AUTO_RESPONDER_PERSONALITY", "Panel text", entry.version)]);
    assert.equal(fresh.status, 200);
  });

  test("default writes the catalog default through the adapter", async () => {
    await patch([set("AUTO_RESPONDER_ENABLED", true)]);
    const version = byKey(await get(), "AUTO_RESPONDER_ENABLED").version;
    const answer = await patch([{ key: "AUTO_RESPONDER_ENABLED", op: "default", version }]);
    assert.equal(byKey(answer.json, "AUTO_RESPONDER_ENABLED").value, false);
    assert.equal(Boolean((await db.AutoResponder.findOne({ where: { id: 1 }, raw: true })).enabled), false);
  });
});

describe("adapters antiDelete and viewOnce", () => {
  for (const [name, mode, jid, model, fields, plugin, cacheKey] of [
    ["antiDelete", "ANTIDELETE_MODE", "ANTIDELETE_JID", "AntiDelete", { mode: "antiDelMode", jid: "antiDelJid" }, antidel, "anti_delete"],
    ["viewOnce", "VIEWONCE_MODE", "VIEWONCE_JID", "ViewOnce", { mode: "vvMode", jid: "vvJid" }, viewonce, "view_once"],
  ]) {
    describe(name, () => {
      const row = () => db[model].findOne({ where: { id: 1 }, raw: true });

      test("p / g write the mode with enabled true and no JID; off writes the disabled row", async () => {
        let answer = await patch([set(mode, "g")]);
        assert.equal(answer.status, 200, JSON.stringify(answer.json));
        let stored = await row();
        assert.deepEqual([stored[fields.mode], stored[fields.jid], Boolean(stored.enabled)], ["g", null, true]);
        assert.equal(byKey(answer.json, mode).value, "g");
        assert.equal(byKey(answer.json, jid).value, "");

        const version = byKey(answer.json, mode).version;
        answer = await patch([set(mode, "off", version)]);
        stored = await row();
        assert.deepEqual([stored[fields.mode], stored[fields.jid], Boolean(stored.enabled)], ["null", null, false]);
        assert.equal(byKey(answer.json, mode).value, "off");
      });

      test("jid needs a JID: required when missing, not_applicable with another mode; a number is normalised", async () => {
        let answer = await patch([set(mode, "jid")]);
        assert.equal(answer.status, 422);
        assert.equal(answer.json.error.fields[jid].code, "required");
        answer = await patch([set(mode, "p"), set(jid, JID)]);
        assert.equal(answer.status, 422);
        assert.equal(answer.json.error.fields[jid].code, "not_applicable");
        assert.equal(await row(), null, "nothing written");

        answer = await patch([set(mode, "jid"), set(jid, "+237 600 000 000".replace(/\s/g, ""))]);
        assert.equal(answer.status, 200, JSON.stringify(answer.json));
        const stored = await row();
        assert.deepEqual([stored[fields.mode], stored[fields.jid], Boolean(stored.enabled)], ["jid", JID, true]);
        assert.equal(byKey(answer.json, jid).value, JID);
      });

      test("the pair is applied as ONE row update, and the cache key is invalidated", async () => {
        let updates = 0;
        db[model].addHook("afterUpdate", `count-${name}`, () => {
          updates += 1;
        });
        try {
          await settingsCache.get(cacheKey, async () => ({ primed: true }));
          assert.ok(settingsCache.cache.has(cacheKey));
          const answer = await patch([set(mode, "jid"), set(jid, JID)]);
          assert.equal(answer.status, 200);
          assert.equal(updates, 1, "mode and JID in a single update");
          assert.ok(!settingsCache.cache.has(cacheKey), "the next read of the plugin reloads the row");
        } finally {
          db[model].removeHook("afterUpdate", `count-${name}`);
        }
      });

      test("changing only the JID keeps the mode; leaving the jid mode clears the JID", async () => {
        await patch([set(mode, "jid"), set(jid, JID)]);
        let entry = byKey(await get(), jid);
        let answer = await patch([set(jid, "237600000009", entry.version)]);
        assert.equal(answer.status, 200);
        assert.equal((await row())[fields.jid], "237600000009@s.whatsapp.net");
        entry = byKey(answer.json, mode);
        answer = await patch([set(mode, "p", entry.version)]);
        assert.equal(answer.status, 200);
        const stored = await row();
        assert.deepEqual([stored[fields.mode], stored[fields.jid]], ["p", null]);
      });

      test("the WhatsApp command and the panel share the row, the parsing and the cache key", async () => {
        const parsed = plugin.parseMode("g");
        await plugin.saveSettings(parsed.values);
        const entry = byKey(await get(), mode);
        assert.deepEqual([entry.value, entry.origin, entry.canRevert], ["g", "override", false]);
        assert.ok(entry.version > 0);
        assert.equal(plugin.SETTINGS_KEY, cacheKey);
      });
    });
  }

  test("the .antidelete and .setvv commands still work through the shared helpers", async () => {
    const anti = fakes.makeMessage({ body: ".antidelete g" });
    await antidel.execute(anti, "g");
    assert.equal((await db.AntiDelete.findOne({ where: { id: 1 }, raw: true })).antiDelMode, "g");
    const vv = fakes.makeMessage({ body: ".setvv p" });
    await viewonce.execute(vv, "p");
    assert.equal((await db.ViewOnce.findOne({ where: { id: 1 }, raw: true })).vvMode, "p");
    assert.equal(byKey(await get(), "ANTIDELETE_MODE").value, "g");
    assert.equal(byKey(await get(), "VIEWONCE_MODE").value, "p");
  });
});

describe("adapter statusSave (data/status_save.json)", () => {
  test("SET-1 does not create the file; the first write does, through the same helpers as the commands", async () => {
    let entry = byKey(await get(), "AUTO_STATUS_SAVE");
    assert.deepEqual([entry.value, entry.version], [false, 0]);
    assert.equal(fs.existsSync(status.FILE_PATH), false);

    const answer = await patch([set("AUTO_STATUS_SAVE", true), set("STATUS_SAVE_LIST", ["+237 600 000 001", "237600000002"])]);
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    assert.deepEqual(status.calls.filter(([name]) => name === "setEnabled"), [["setEnabled", true]]);
    assert.deepEqual(status.calls.filter(([name]) => name === "add").map(([, n]) => n), ["237600000001", "237600000002"]);
    entry = byKey(answer.json, "AUTO_STATUS_SAVE");
    assert.deepEqual([entry.value, entry.origin, entry.canRevert], [true, "override", false]);
    assert.ok(entry.version > 0, "the version is the mtime of the file");
    assert.deepEqual(byKey(answer.json, "STATUS_SAVE_LIST").value, ["237600000001", "237600000002"]);
  });

  test("the list is replaced: numbers that left are removed, new ones added", async () => {
    await patch([set("STATUS_SAVE_LIST", ["237600000001", "237600000002"])]);
    status.calls.length = 0;
    const version = byKey(await get(), "STATUS_SAVE_LIST").version;
    const answer = await patch([set("STATUS_SAVE_LIST", ["237600000002", "237600000003"], version)]);
    assert.equal(answer.status, 200);
    assert.deepEqual(status.calls, [["remove", "237600000001"], ["add", "237600000003"]]);
    assert.deepEqual(byKey(answer.json, "STATUS_SAVE_LIST").value, ["237600000002", "237600000003"]);
  });

  test("a file changed meanwhile makes the version stale", async () => {
    await patch([set("AUTO_STATUS_SAVE", true)]);
    const version = byKey(await get(), "AUTO_STATUS_SAVE").version;
    status.touch({ list: ["237600000009"] });
    const answer = await patch([set("AUTO_STATUS_SAVE", false, version)]);
    assert.equal(answer.status, 409);
    assert.equal(answer.json.error.fields.AUTO_STATUS_SAVE.code, "conflict");
    assert.notEqual(answer.json.error.fields.AUTO_STATUS_SAVE.params.version, version);
  });

  test("AUTO_STATUS_SAVE=true in the environment forces it on: turning it off is forced_by_env", async () => {
    const saved = process.env.AUTO_STATUS_SAVE;
    process.env.AUTO_STATUS_SAVE = "true"; // the environment variable ...
    settingsStore._env = null; // ... read again (the store parses the environment once)
    try {
      await forcedByEnvScenario();
    } finally {
      process.env.AUTO_STATUS_SAVE = saved;
      settingsStore._env = null;
    }
  });

  async function forcedByEnvScenario() {
    let entry = byKey(await get(), "AUTO_STATUS_SAVE");
    assert.deepEqual([entry.value, entry.origin], [true, "env"]);

    let answer = await patch([set("AUTO_STATUS_SAVE", false)]);
    assert.equal(answer.status, 422);
    assert.equal(answer.json.error.fields.AUTO_STATUS_SAVE.code, "forced_by_env");
    assert.equal(fs.existsSync(status.FILE_PATH), false, "nothing written");
    answer = await patch([{ key: "AUTO_STATUS_SAVE", op: "default", version: 0 }]);
    assert.equal(answer.json.error.fields.AUTO_STATUS_SAVE.code, "forced_by_env");

    answer = await patch([set("AUTO_STATUS_SAVE", true)]);
    assert.equal(answer.status, 200);
    entry = byKey(answer.json, "AUTO_STATUS_SAVE");
    assert.equal(entry.value, true);
    assert.equal(entry.origin, "env");
  }

  test("a numbers list rejects what is not a phone number", async () => {
    const answer = await patch([set("STATUS_SAVE_LIST", ["abc", "237600000001", "12"])]);
    assert.equal(answer.status, 422);
    assert.deepEqual(answer.json.error.fields.STATUS_SAVE_LIST.params.indices, [0, 2]);
  });
});

describe("a batch across stores", () => {
  test("override rows, database adapters and the file adapter in one request; one audit row per key", async () => {
    const answer = await patch([
      set("PREFIX", "!"),
      set("AUTO_RESPONDER_ENABLED", true),
      set("ANTIDELETE_MODE", "sudo"),
      set("AUTO_STATUS_SAVE", true),
    ]);
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    assert.deepEqual(
      answer.json.settings.map((s) => s.key),
      ["PREFIX", "AUTO_RESPONDER_ENABLED", "ANTIDELETE_MODE", "AUTO_STATUS_SAVE", "ANTIDELETE_JID"],
      "the JID follows its mode: both are one row",
    );
    const rows = await auditRows({ action: "setting.update" });
    assert.deepEqual(rows.map((r) => r.target).sort(), ["ANTIDELETE_MODE", "AUTO_RESPONDER_ENABLED", "AUTO_STATUS_SAVE", "PREFIX"]);
  });

  test("the database adapters share ONE transaction: a failure in the second rolls the first back", async () => {
    const failing = { ...viewonce, saveSettings: async () => { throw new Error("disk full"); } };
    await t.close();
    await boot({ deps: { plugins: { viewonce: failing } } });
    const answer = await patch([set("AUTO_RESPONDER_ENABLED", true), set("VIEWONCE_MODE", "g")]);
    assert.equal(answer.status, 500);
    assert.equal(await db.AutoResponder.count(), 0, "the auto responder row was rolled back");
    assert.equal(await db.ViewOnce.count(), 0);
    assert.ok(!answer.text.includes("disk full"), "no internal message reaches the client");
  });

  test("a validation error in the file adapter's keys stops the database adapters too", async () => {
    const answer = await patch([set("AUTO_RESPONDER_ENABLED", true), set("STATUS_SAVE_LIST", ["nope"])]);
    assert.equal(answer.status, 422);
    assert.equal(await db.AutoResponder.count(), 0);
  });
});

// ---------------------------------------------------------------------------
// Whole-catalog checks
// ---------------------------------------------------------------------------

describe("SC-003 through the API: every editable immediate entry applies on the next read", () => {
  const samples = {
    bool: (entry) => !entry.default,
    enum: (entry) => entry.rules.enum.find((value) => value !== entry.default),
    int: (entry) => {
      const { min, max } = entry.rules;
      const candidate = entry.default === max ? min : Math.min(max, entry.default + 1);
      return candidate;
    },
  };

  test("bool, enum and int entries of the env source", async () => {
    const answer = await get();
    const targets = answer.settings.filter(
      (s) =>
        s.source === "env" && !s.readonly && !s.inactive && s.effect === "immediate" && !s.secret &&
        !["SUDO", "BOT_LANG", "LOG_LEVEL"].includes(s.key) && ["bool", "enum", "int"].includes(s.type),
    );
    assert.ok(targets.length >= 15, `${targets.length} entries`);
    for (const entry of targets) {
      const item = catalog.byKey.get(entry.key);
      const value = samples[entry.type]({ ...entry, default: entry.value, rules: item.rules });
      if (value === undefined || value === entry.value) continue;
      // the pair of delays is checked by its own test
      if (entry.key.startsWith("AUTO_RESPONDER_M")) continue;
      const fresh = byKey(await get(), entry.key);
      const result = await patch([set(entry.key, value, fresh.version)]);
      assert.equal(result.status, 200, `${entry.key}: ${JSON.stringify(result.json)}`);
      assert.equal(config[item.configProp], value, entry.key);
    }
  });
});
