"use strict";
/**
 * SC-011 and the backup engines (T167; contracts/runtime.md section 13, data-model.md 4.3): export, inspect, apply.
 *
 *  - round trip: export, then restore into a FRESH database; each of the 26 exported models is identical, as
 *    canonical JSON, to its source; the 11 excluded models (7 + the four of the messaging API) are never exported and a
 *    Conversation row, an API key, message, answer or switch is not restored;
 *  - secrets travel in clear inside the archive and are re-encrypted with the target key, which is created when
 *    missing; a wrong passphrase is reported before anything is decrypted; one altered byte or a cut file is
 *    `file_altered` and, with the damage in the tag, every table is unchanged (the tag is verified before COMMIT);
 *  - versions: newer refused, older accepted (absent model emptied, missing column defaulted, unknown column
 *    dropped and counted), unknown container format refused, an invalid row refused with model / index / field;
 *  - session, media and status file; inspect changes nothing; the token (15 minutes, bound to the session);
 *  - apply: maintenance mode, pre-restore backup (last 3 kept), lock, restart, reload; boot recovery;
 *  - cross-dialect serialisation (typed rows), and an opt-in Postgres round trip behind TEST_POSTGRES_URL.
 *
 * Temporary directories only, tiny scrypt cost, in-memory SQLite; the real data/, sessions/ and config.env are
 * never read.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ lang: "fr" });

const kit = require("./helpers/backupKit");
const format = require("../lib/admin/backup/format");
const { createExporter } = require("../lib/admin/backup/export");
const { createRestorer } = require("../lib/admin/backup/restore");
const { createSettingsStore } = require("../lib/utils/settingsStore");
const { createSecretBox } = require("../lib/utils/secretBox");
const maintenanceMode = require("../lib/utils/maintenanceMode");
const textOverrides = require("../lib/utils/textOverrides");
const { languageManager } = require("../lib/utils/language");

const PASS = "correct horse battery staple";
const SECRET = "sk-test-source-secret-value";
const VERSION = "9.9.9";
const T0 = Date.UTC(2026, 5, 1, 10, 0, 0);
const TIMES_DONE = new Date("2026-03-04T10:00:00.000Z");

let db; // the global in-memory database: the SOURCE installation
let root;
let seq = 0;

before(async () => {
  db = await fakes.syncDb();
});

after(() => {
  maintenanceMode._reset();
});

const mutableClock = (start = T0) => ({ t: start, now() { return this.t; } });
const exists = (file) => fs.existsSync(file);

async function clearSource() {
  for (const [name, model] of Object.entries(db)) {
    if (name === "DATABASE" || name === "sync" || typeof model.destroy !== "function") continue;
    await model.destroy({ where: {}, truncate: true });
  }
  languageManager.reload();
}

/** One installation: dirs, a settings store, a secret box, a restorer; `models` is the database it lives in */
async function installation(label, models, { clock, runtime, logger, extra = {} } = {}) {
  seq += 1;
  const home = path.join(root, `${label}-${seq}`);
  const dataDir = path.join(home, "data");
  const sessionDir = path.join(home, "sessions", "main");
  fs.mkdirSync(dataDir, { recursive: true });
  const box = createSecretBox({ dir: path.join(home, "keys") });
  const store = createSettingsStore({ models, secretBox: box });
  await store.load();
  const uploads = kit.fakeUploads(path.join(home, "uploads"));
  const calls = { cleared: 0, textsLoaded: 0, restarts: [] };
  const deps = {
    models,
    settingsStore: store,
    secretBox: box,
    textOverrides: {
      exportRows: () => textOverrides.exportRows(),
      load: async () => {
        calls.textsLoaded += 1;
      },
    },
    settingsCache: { clear: () => (calls.cleared += 1) },
    stats: { flush: async () => {} },
    config: { VERSION },
    maintenanceMode,
    runtime:
      runtime ||
      {
        async restartBot(options) {
          calls.restarts.push({ ...options, maintenance: maintenanceMode.isActive(), lock: exists(path.join(dataDir, "backups", "restore.lock")) });
          return { ok: true, status: "running" };
        },
      },
    dataDir,
    sessionDir,
    uploads,
    clock: clock || mutableClock(),
    logger: logger || kit.recordingLogger(),
    kdf: kit.LOW_KDF,
    kdfGate: format.createKdfGate(),
    ...extra,
  };
  return {
    home,
    dataDir,
    sessionDir,
    box,
    store,
    uploads,
    calls,
    deps,
    models,
    exporter: createExporter(deps),
    restorer: createRestorer(deps),
    lockFile: path.join(dataDir, "backups", "restore.lock"),
  };
}

/** Everything the 26 + 11 models hold, to prove a refused restore changed nothing */
async function dumpAll(models) {
  const out = {};
  for (const name of [...format.MODELS, ...format.EXCLUDED_MODELS]) out[name] = await kit.canonical(models, name);
  return out;
}

/** Source installation filled with one of everything, plus the files around the database */
async function filledSource() {
  const src = await installation("source", db);
  await kit.seedAll(db);
  await kit.seedExcluded(db);
  await src.store.set({ PREFIX: "!", STICKER_PACKNAME: "Pack ✨", OPENAI_API_KEY: SECRET, GEMINI_API_KEY: "gem-secret-2" });
  await textOverrides.save("fr", "common.error", "Oups, un souci est survenu.");

  fs.writeFileSync(path.join(src.dataDir, "status_save.json"), JSON.stringify({ enabled: true, list: ["237600000001", "237600000002"] }));
  for (const [id, name] of [["21", "photo.png"], ["22", "menu café.pdf"]]) {
    const dir = path.join(src.dataDir, "broadcast-media", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), Buffer.concat([Buffer.from(`media-${id}-`), Buffer.alloc(2_500_000, id.charCodeAt(0))]));
    await db.Broadcast.update(
      { mediaKind: id === "21" ? "image" : "document", mediaPath: `data/broadcast-media/${id}/${name}`, mediaName: name, mediaMime: "application/octet-stream", mediaSize: 2_500_010 },
      { where: { id: Number(id) } },
    );
  }
  fs.mkdirSync(src.sessionDir, { recursive: true });
  fs.writeFileSync(path.join(src.sessionDir, "creds.json"), '{"marker":"SESSION-SECRET-MARKER-1"}');
  fs.writeFileSync(path.join(src.sessionDir, "pre-key-7.json"), Buffer.from([0, 1, 2, 250, 251, 252]));
  fs.writeFileSync(path.join(src.sessionDir, "app-state-sync-key-AAA@1.json"), "{}");
  return src;
}

const TIMESTAMP_FREE = ["SettingOverride", "TextOverride"];
async function sameModels(a, b, names = format.MODELS) {
  for (const name of names) {
    // setting values are compared through the stores (another key encrypts them differently)
    const omit = TIMESTAMP_FREE.includes(name) ? ["createdAt", "updatedAt", "version", ...(name === "SettingOverride" ? ["value"] : [])] : [];
    assert.deepEqual(await kit.canonical(b, name, { omit }), await kit.canonical(a, name, { omit }), `${name} differs after the restore`);
  }
}

/** Export the source, hand the file to the target as an upload, inspect it */
async function exportAndInspect(src, tgt, { passphrase = PASS, includeSession = false, sessionId = "s1" } = {}) {
  const file = path.join(src.home, `export-${++seq}.owb`);
  const exported = await src.exporter.exportToFile({ file, passphrase, includeSession, now: T0 });
  const uploadId = tgt.uploads.addFile(file, sessionId);
  const inspected = await tgt.restorer.inspect({ uploadId, passphrase, adminSessionId: sessionId });
  return { file, exported, uploadId, inspected };
}

beforeEach(async () => {
  if (!root) root = fs.mkdtempSync(path.join(require("os").tmpdir(), "owb-backup-test-"));
  maintenanceMode._reset();
  await clearSource();
});

afterEach(async () => {
  maintenanceMode._reset();
  languageManager.reload();
});

after(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("every model is either backed up or deliberately excluded (CLAUDE.md \"Database\")", () => {
  const MODELS_DIR = path.join(__dirname, "..", "lib", "database", "models");
  const modelFiles = () => fs.readdirSync(MODELS_DIR).filter((name) => name.endsWith(".js")).map((name) => path.basename(name, ".js")).sort();

  test("each file of lib/database/models/ is in exactly one of MODELS and EXCLUDED_MODELS", () => {
    const files = modelFiles();
    assert.ok(files.length >= 33, "the model files were found");
    for (const name of files) {
      const inModels = format.MODELS.includes(name);
      const inExcluded = format.EXCLUDED_MODELS.includes(name);
      assert.ok(inModels || inExcluded, `${name} is in neither MODELS nor EXCLUDED_MODELS of lib/admin/backup/format.js: its rows would silently miss every backup`);
      assert.ok(!(inModels && inExcluded), `${name} is in both MODELS and EXCLUDED_MODELS`);
    }
  });

  test("both lists only name models that exist, each once; together they cover every model", async () => {
    const files = modelFiles();
    for (const list of [format.MODELS, format.EXCLUDED_MODELS]) assert.equal(new Set(list).size, list.length, "no name twice in a list");
    for (const name of [...format.MODELS, ...format.EXCLUDED_MODELS]) assert.ok(files.includes(name), `${name} has no file in lib/database/models/`);
    assert.deepEqual([...format.MODELS, ...format.EXCLUDED_MODELS].sort(), files);
    assert.equal(format.MODELS.length + format.EXCLUDED_MODELS.length, files.length);

    // the loaded models: Sequelize registers each under its file name, which is what the two lists use
    for (const name of files) {
      assert.ok(db[name], `${name} is loaded by lib/database`);
      assert.equal(db[name].name, name, `${name} is defined under its file name`);
    }
  });

  test("AUTO_INCREMENT_MODELS only names exported models", () => {
    for (const name of format.AUTO_INCREMENT_MODELS) assert.ok(format.MODELS.includes(name), `${name} is auto-increment but not exported`);
  });

  test("the four messaging API models (004) are excluded: MODELS stays at 26, EXCLUDED_MODELS goes from 7 to 11", () => {
    const api = ["ApiKey", "ApiMessage", "ApiMessageResponse", "ApiState"];
    for (const name of api) {
      assert.ok(format.EXCLUDED_MODELS.includes(name), `${name} is excluded`);
      assert.ok(!format.MODELS.includes(name), `${name} is not exported`);
      assert.ok(!format.AUTO_INCREMENT_MODELS.includes(name), `${name} has no sequence to move`);
    }
    assert.equal(format.MODELS.length, 26);
    assert.equal(format.EXCLUDED_MODELS.length, 11);
    assert.deepEqual(format.EXCLUDED_MODELS.slice(0, 7), ["AdminAccount", "AdminSession", "AdminToken", "AuditLog", "AlertState", "AlertOutbox", "Conversation"], "the seven of earlier features keep their place");
  });

  test("PermissionRule (003) is exported, right after CommandState, with a composite key and no sequence to move", () => {
    assert.equal(format.MODELS.length, 26);
    assert.equal(format.MODELS[format.MODELS.indexOf("CommandState") + 1], "PermissionRule");
    assert.ok(!format.EXCLUDED_MODELS.includes("PermissionRule"));
    assert.ok(!format.AUTO_INCREMENT_MODELS.includes("PermissionRule"));
    assert.deepEqual(db.PermissionRule.primaryKeyAttributes, ["command", "scope"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("SC-011: export then restore on a fresh database", () => {
  test("each of the 26 exported models comes back identical", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    const tgt = await installation("target", target);
    const { inspected, exported } = await exportAndInspect(src, tgt);

    assert.equal(format.MODELS.length, 26);
    assert.deepEqual(Object.keys(exported.counts).sort(), [...format.MODELS].sort());
    assert.equal(inspected.summary.counts.Group, 2);
    assert.equal(inspected.summary.counts.SettingOverride, 4);
    assert.equal(inspected.summary.counts.TextOverride, 1);

    const done = await tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "127.0.0.1", adminSessionId: "s1" });
    assert.equal(done.ok, true);
    assert.deepEqual(done.warnings, []);

    await sameModels(db, target);
    // spot checks of types that differ between dialects
    const group = await target.Group.findByPk("120363000000000001@g.us");
    assert.equal(group.antilink, true);
    assert.equal(group.get({ plain: true }).createdAt.toISOString(), "2026-03-01T08:00:00.000Z");
    const idea = await target.Idea.findByPk(6);
    assert.deepEqual(idea.get({ plain: true }).voters, ["237600000001@s.whatsapp.net", "237600000002@s.whatsapp.net"]);
    assert.deepEqual((await target.Broadcast.findByPk(21)).targets, ["120363000000000001@g.us", "237600000001@s.whatsapp.net"]);
  });

  test("settings and texts: the same effective values, secrets re-encrypted with the TARGET key, which is created", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    const tgt = await installation("target", target);
    assert.equal(tgt.box.status().keyPresent, false);

    const { inspected } = await exportAndInspect(src, tgt);
    assert.equal(tgt.box.status().keyPresent, false, "inspect must not create the key (it dry-runs in a scratch directory)");
    await tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" });

    assert.equal(tgt.box.status().keyPresent, true);
    assert.equal(tgt.box.status().keyValid, true);
    const strip = (rows) => rows.map(({ key, value }) => ({ key, value })).sort((a, b) => (a.key < b.key ? -1 : 1));
    assert.deepEqual(strip(tgt.store.rawOverrides({ decrypted: true })), strip(src.store.rawOverrides({ decrypted: true })));
    assert.equal(tgt.store.get("OPENAI_API_KEY"), SECRET);
    assert.equal(tgt.store.get("PREFIX"), "!");

    const sourceRow = await db.SettingOverride.findByPk("OPENAI_API_KEY");
    const targetRow = await target.SettingOverride.findByPk("OPENAI_API_KEY");
    assert.match(targetRow.value, /^enc:v1:/);
    assert.notEqual(targetRow.value, sourceRow.value, "another key and another iv");
    assert.ok(!targetRow.value.includes(SECRET));

    assert.equal(tgt.calls.textsLoaded, 1);
    assert.ok(tgt.calls.cleared >= 1);
    const text = await target.TextOverride.findOne({ where: { key: "common.error", lang: "fr" } });
    assert.equal(text.text, "Oups, un souci est survenu.");
    assert.equal(text.originalHash.length, 16);
  });

  test("the archive holds decrypted secrets and typed rows (booleans, ISO dates, parsed JSON), and nothing excluded", async () => {
    const src = await filledSource();
    const file = path.join(src.home, "inspect-me.owb");
    await src.exporter.exportToFile({ file, passphrase: PASS, includeSession: false, now: T0 });
    const records = await kit.readAll(file, PASS);

    const first = records[0];
    assert.equal(first.t, "manifest");
    assert.equal(first.botVersion, VERSION);
    assert.equal(first.createdAt, new Date(T0).toISOString());
    assert.equal(first.dialect, "sqlite");
    assert.equal(first.includesSession, false);
    assert.equal(Object.keys(first.counts).length, 26);

    const rows = (model) => records.filter((r) => r.t === "rows" && r.model === model).flatMap((r) => r.rows);
    const secret = rows("SettingOverride").find((row) => row.key === "OPENAI_API_KEY");
    assert.equal(secret.value, SECRET, "decrypted inside the encrypted archive");

    const group = rows("Group").find((row) => row.jid === "120363000000000001@g.us");
    assert.strictEqual(group.antilink, true);
    assert.strictEqual(group.mute, false);
    assert.equal(group.createdAt, "2026-03-01T08:00:00.000Z");
    assert.deepEqual(rows("Broadcast")[0].targets, ["120363000000000001@g.us", "237600000001@s.whatsapp.net"]);
    assert.deepEqual(rows("Idea")[0].voters, ["237600000001@s.whatsapp.net", "237600000002@s.whatsapp.net"]);

    const models = new Set(records.filter((r) => r.t === "rows").map((r) => r.model));
    for (const excluded of format.EXCLUDED_MODELS) assert.ok(!models.has(excluded), `${excluded} must never be exported`);
    assert.ok(!JSON.stringify(first).includes("scrypt$"), "no admin password hash anywhere");
    assert.equal(records.filter((r) => r.t === "session").length, 0);
  });

  test("a Conversation row (and any other excluded table) is not restored, even when the file carries rows for it", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    await kit.seedExcluded(target);
    const tgt = await installation("target", target);
    const before = await dumpAll(target);

    const file = path.join(src.home, "hostile.owb");
    await kit.buildArchive({
      file,
      passphrase: PASS,
      records: [
        kit.manifest({ botVersion: "1.0.0", counts: { Group: 1, AdminAccount: 1, Conversation: 1, AuditLog: 1 } }),
        { t: "rows", model: "Group", rows: [{ jid: "1@g.us", name: "ok" }] },
        { t: "rows", model: "AdminAccount", rows: [{ id: 1, passwordHash: "scrypt$16$1$1$ZZZ$ZZZ", uiLang: "en", theme: "dark" }] },
        { t: "rows", model: "Conversation", rows: [{ jid: "x@s.whatsapp.net", messages: "SECRET CHAT" }] },
        { t: "rows", model: "AuditLog", rows: [{ action: "forged", result: "ok" }] },
      ],
    });
    const uploadId = tgt.uploads.addFile(file);
    const inspected = await tgt.restorer.inspect({ uploadId, passphrase: PASS, adminSessionId: "s1" });
    assert.deepEqual(
      inspected.summary.ignoredModels.map((m) => m.model).sort(),
      ["AdminAccount", "AuditLog", "Conversation"],
    );
    await tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" });

    const after = await dumpAll(target);
    for (const excluded of format.EXCLUDED_MODELS) assert.deepEqual(after[excluded], before[excluded], `${excluded} untouched`);
    assert.equal(await target.Group.count(), 1);
    assert.equal(await target.Conversation.count(), 1);
    assert.ok(!JSON.stringify(after.Conversation).includes("SECRET CHAT"));
  });

  test("an export carries none of the four API tables: no key, no hash, no message, no answer, no staged media (U9, FR-076)", async () => {
    const src = await filledSource();
    assert.equal(await db.ApiKey.count(), 1, "the source holds API rows");
    const stage = path.join(src.dataDir, "api-media", kit.API_SEED.publicId);
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, "source"), "API-MEDIA-CANARY");

    const file = path.join(src.home, "api-excluded.owb");
    await src.exporter.exportToFile({ file, passphrase: PASS, includeSession: false, now: T0 });
    const records = await kit.readAll(file, PASS);

    const models = new Set(records.filter((r) => r.t === "rows").map((r) => r.model));
    for (const name of ["ApiKey", "ApiMessage", "ApiMessageResponse", "ApiState"]) assert.ok(!models.has(name), `${name} is not in the archive`);
    assert.deepEqual(Object.keys(records[0].counts).filter((name) => name.startsWith("Api")), []);

    const text = JSON.stringify(records);
    for (const needle of [kit.API_SEED.lookupId, kit.API_SEED.secretHash, kit.API_SEED.publicId, kit.API_SEED.waId, kit.API_SEED.keyName, "api-media", Buffer.from("API-MEDIA-CANARY").toString("base64")]) {
      assert.ok(!text.includes(needle), `the archive must not contain ${needle}`);
    }
    // the only media directory an archive reads is data/broadcast-media
    const mediaPaths = records.filter((r) => r.t === "blob").map((r) => r.path);
    assert.ok(mediaPaths.length > 0, "the broadcast media is still exported");
    for (const mediaPath of mediaPaths) assert.match(mediaPath, /^data\/broadcast-media\//);
    assert.ok(!records[0].files.some((f) => /api-media/.test(JSON.stringify(f))));
  });

  test("a restore leaves the four API tables byte for byte as they are: no revoked key comes back, the switch stays off, no row appears", async () => {
    const src = await filledSource();
    const hostile = path.join(src.home, "hostile-api.owb");
    const nowStamp = "2026-03-01T08:00:00.000Z";
    await kit.buildArchive({
      file: hostile,
      passphrase: PASS,
      records: [
        kit.manifest({ botVersion: "1.0.0", counts: { Group: 1, ApiKey: 1, ApiMessage: 1, ApiMessageResponse: 1, ApiState: 1 } }),
        { t: "rows", model: "Group", rows: [{ jid: "1@g.us", name: "ok" }] },
        // an OLDER archive of the key the target has since revoked, and of a switch that was on
        { t: "rows", model: "ApiKey", rows: [{ id: 1, name: kit.API_SEED.keyName, nameKey: "seed api key", lookupId: kit.API_SEED.lookupId, secretHash: kit.API_SEED.secretHash, last4: "wXyZ", rights: ["messages.send.text", "messages.send.image"], policyMode: "anyone", recipients: [], ipAllow: [], seenIps: [], revokedAt: null, version: 1, createdAt: nowStamp, updatedAt: nowStamp }] },
        { t: "rows", model: "ApiMessage", rows: [{ id: 1, publicId: "msg_REPLAYREPLAYREPLAYREPLA", apiKeyId: 1, source: "api", recipient: "237600000001@s.whatsapp.net", format: "text", status: "queued", acceptedAt: nowStamp, expiresAt: nowStamp, payload: { v: 1, input: { text: "REPLAY ME" } }, createdAt: nowStamp, updatedAt: nowStamp }] },
        { t: "rows", model: "ApiMessageResponse", rows: [{ id: 1, messageId: 1, kind: "choice", author: "237600000001@s.whatsapp.net", choiceIds: ["x"], respondedAt: nowStamp, createdAt: nowStamp, updatedAt: nowStamp }] },
        { t: "rows", model: "ApiState", rows: [{ id: 1, enabled: true, plainHttpFrom: ["10.0.0.0/8", "192.168.0.0/16"], createdAt: nowStamp, updatedAt: nowStamp }] },
      ],
    });

    const restoreInto = async (target) => {
      const tgt = await installation("target", target);
      const uploadId = tgt.uploads.addFile(hostile);
      const inspected = await tgt.restorer.inspect({ uploadId, passphrase: PASS, adminSessionId: "s1" });
      assert.deepEqual(
        inspected.summary.ignoredModels.map((m) => m.model).sort(),
        ["ApiKey", "ApiMessage", "ApiMessageResponse", "ApiState"],
        "the file's rows for the four tables are reported as ignored",
      );
      const done = await tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" });
      assert.equal(done.ok, true);
      assert.equal(await target.Group.count(), 1, "the exported models were restored");
      assert.ok(!fs.existsSync(path.join(tgt.dataDir, "api-media")), "a restore stages no API media");
      return tgt;
    };

    // an installation that has API data
    const withData = await kit.makeDb();
    await kit.seedExcluded(withData);
    const before = await dumpAll(withData);
    await restoreInto(withData);
    const after = await dumpAll(withData);
    for (const name of ["ApiKey", "ApiMessage", "ApiMessageResponse", "ApiState"]) assert.deepEqual(after[name], before[name], `${name} byte for byte`);
    for (const name of format.EXCLUDED_MODELS) assert.deepEqual(after[name], before[name], `${name} untouched`);
    const key = await withData.ApiKey.findByPk(1);
    assert.ok(key.revokedAt, "a revoked key is never resurrected");
    assert.equal(key.nameKey, null);
    assert.equal(key.version, 2);
    assert.equal((await withData.ApiState.findByPk(1)).enabled, false, "a restore never switches the API on");
    assert.deepEqual((await withData.ApiState.findByPk(1)).plainHttpFrom, ["10.0.0.0/8"], "nor widens the network list");
    assert.equal(await withData.ApiMessage.count({ where: { status: "queued" } }), 0, "no send is replayed");

    // a fresh installation: nothing appears
    const fresh = await kit.makeDb();
    await restoreInto(fresh);
    for (const name of ["ApiKey", "ApiMessage", "ApiMessageResponse", "ApiState"]) assert.equal(await fresh[name].count(), 0, `${name} stays empty`);
  });

  test("a restore into an installation that already has data replaces it", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    await target.Group.create({ jid: "old@g.us", name: "avant" });
    await target.Quote.create({ groupJid: "old@g.us", authorJid: "a", text: "t", savedBy: "b" });
    const tgt = await installation("target", target);
    const { inspected } = await exportAndInspect(src, tgt);
    await tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" });
    assert.equal(await target.Group.findByPk("old@g.us"), null);
    await sameModels(db, target);
  });

  test("PermissionRule: composite key order, people kept as arrays, timestamps kept (generic path)", async () => {
    const src = await filledSource();
    // a third row sharing a command with the seeded "vv" rule: ordered by (command, scope), "*" before a group JID
    await db.PermissionRule.bulkCreate([{ command: "vv", scope: "120363000000000001@g.us", mode: "extra", people: [], createdAt: TIMES_DONE, updatedAt: TIMES_DONE }]);
    const file = path.join(src.home, "permission-rules.owb");
    const exported = await src.exporter.exportToFile({ file, passphrase: PASS, includeSession: false, now: T0 });
    assert.equal(exported.counts.PermissionRule, 3);

    const records = await kit.readAll(file, PASS);
    assert.equal(records[0].counts.PermissionRule, 3);
    const rows = records.filter((r) => r.t === "rows" && r.model === "PermissionRule").flatMap((r) => r.rows);
    assert.deepEqual(rows.map((r) => `${r.command}|${r.scope}`), ["save|120363000000000001@g.us", "vv|*", "vv|120363000000000001@g.us"], "ordered by the composite primary key");
    assert.ok(rows.every((r) => Array.isArray(r.people)), "people travel as a JSON array, never as a string");
    assert.deepEqual(rows[0].people, [{ pn: "237600000002@s.whatsapp.net", lid: null }, { pn: null, lid: "987654321098765@lid" }]);
    assert.deepEqual(rows[1].people, [{ pn: "237600000001@s.whatsapp.net", lid: "123456789012345@lid" }]);
    assert.deepEqual(rows[2].people, []);
    assert.deepEqual(rows.map((r) => r.mode), ["extra", "only", "extra"]);
    assert.equal(rows[0].createdAt, "2026-03-01T08:00:00.000Z");
    assert.equal(rows[0].updatedAt, "2026-03-02T09:30:00.000Z");
    assert.equal(rows[2].createdAt, TIMES_DONE.toISOString());

    const target = await kit.makeDb();
    const tgt = await installation("target", target);
    const uploadId = tgt.uploads.addFile(file);
    const inspected = await tgt.restorer.inspect({ uploadId, passphrase: PASS, adminSessionId: "s1" });
    assert.equal(inspected.summary.counts.PermissionRule, 3);
    await tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" });

    assert.deepEqual(await kit.canonical(target, "PermissionRule"), await kit.canonical(db, "PermissionRule"));
    const restored = await target.PermissionRule.findAll({ order: [["command", "ASC"], ["scope", "ASC"]] });
    assert.deepEqual(restored.map((r) => `${r.command}|${r.scope}`), ["save|120363000000000001@g.us", "vv|*", "vv|120363000000000001@g.us"]);
    for (const row of restored) assert.ok(Array.isArray(row.people), "people read back as an array through model instances");
    assert.deepEqual(restored[0].people, rows[0].people);
    assert.deepEqual(restored[1].people, rows[1].people);
    assert.deepEqual(restored[2].people, []);
    assert.equal(restored[0].createdAt.toISOString(), "2026-03-01T08:00:00.000Z");
    assert.equal(restored[0].updatedAt.toISOString(), "2026-03-02T09:30:00.000Z");
    assert.equal(restored[2].updatedAt.toISOString(), TIMES_DONE.toISOString());
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("passphrase and damage", () => {
  test("a wrong passphrase is reported before anything is decrypted, and the upload stays for another try", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    const tgt = await installation("target", target);
    const file = path.join(src.home, "x.owb");
    await src.exporter.exportToFile({ file, passphrase: PASS, now: T0 });
    // damage the ciphertext AND the tag: only the check value can be reported first
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 40] ^= 0xff;
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(file, bytes);
    const uploadId = tgt.uploads.addFile(file);

    await assert.rejects(() => tgt.restorer.inspect({ uploadId, passphrase: "wrong passphrase!!", adminSessionId: "s1" }), { code: "bad_passphrase" });
    assert.ok(tgt.uploads.peek(uploadId, "s1", { purpose: "backup" }), "the upload is still there");
    // with the right passphrase the damage is now found
    await assert.rejects(() => tgt.restorer.inspect({ uploadId, passphrase: PASS, adminSessionId: "s1" }), { code: "file_altered" });
  });

  test("the passphrase is NFKC-normalised: a composed and a decomposed accent open the same file", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    const tgt = await installation("target", target);
    const composed = "phrase secrète très longue é";
    const file = path.join(src.home, "nfkc.owb");
    await src.exporter.exportToFile({ file, passphrase: composed, now: T0 });
    const uploadId = tgt.uploads.addFile(file);
    const decomposed = composed.normalize("NFD");
    assert.notEqual(decomposed, composed);
    const inspected = await tgt.restorer.inspect({ uploadId, passphrase: decomposed, adminSessionId: "s1" });
    assert.ok(inspected.restoreToken);
  });

  test("one altered byte, or a truncated file: file_altered at inspect", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    const tgt = await installation("target", target);
    const file = path.join(src.home, "ok.owb");
    await src.exporter.exportToFile({ file, passphrase: PASS, now: T0 });
    const original = fs.readFileSync(file);

    const flipped = Buffer.from(original);
    flipped[Math.floor(flipped.length / 2)] ^= 0x01;
    await assert.rejects(
      () => tgt.restorer.inspect({ uploadId: tgt.uploads.add(flipped), passphrase: PASS, adminSessionId: "s1" }),
      { code: "file_altered" },
    );
    const cut = original.subarray(0, original.length - 60);
    await assert.rejects(() => tgt.restorer.inspect({ uploadId: tgt.uploads.add(cut), passphrase: PASS, adminSessionId: "s1" }), { code: "file_altered" });
    const header = original.subarray(0, 30);
    await assert.rejects(() => tgt.restorer.inspect({ uploadId: tgt.uploads.add(header), passphrase: PASS, adminSessionId: "s1" }), { code: "file_altered" });
    assert.equal(await target.Group.count(), 0);
  });

  test("a header edit fails the tag (the header is the AAD)", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    const tgt = await installation("target", target);
    const file = path.join(src.home, "hdr.owb");
    await src.exporter.exportToFile({ file, passphrase: PASS, now: T0 });
    const bytes = fs.readFileSync(file);
    const text = bytes.toString("latin1");
    const at = text.indexOf('"N":');
    // N is written as a number: change its last digit but keep the length (16 -> 17 would still derive another key,
    // so edit the iv instead: it keeps the same key and only the AAD / the nonce change)
    const iv = text.indexOf('"iv":"') + 6;
    bytes[iv] = bytes[iv] === 0x30 ? 0x31 : 0x30;
    assert.ok(at > 0);
    await assert.rejects(
      () => tgt.restorer.inspect({ uploadId: tgt.uploads.add(bytes), passphrase: PASS, adminSessionId: "s1" }),
      { code: "file_altered" },
    );
  });

  test("damage in the GCM tag only: the whole file decrypts, yet apply rolls EVERYTHING back (tag verified before COMMIT)", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    await target.Group.create({ jid: "keep@g.us", name: "keep me" });
    await target.Quote.create({ groupJid: "keep@g.us", authorJid: "a", text: "t", savedBy: "b" });
    const tgt = await installation("target", target);
    const { inspected } = await exportAndInspect(src, tgt);
    const before = await dumpAll(target);

    // after the inspection the file sits in data/tmp: flip the last bit of the tag
    const stored = path.join(tgt.dataDir, "tmp", `restore-${inspected.restoreToken}.owb`);
    assert.ok(exists(stored));
    const bytes = fs.readFileSync(stored);
    bytes[bytes.length - 1] ^= 0x01;
    fs.writeFileSync(stored, bytes);

    await assert.rejects(
      () => tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" }),
      (error) => error.code === "apply_failed" && error.params.phase === "database" && error.params.reason === "file_altered",
    );
    assert.deepEqual(await dumpAll(target), before, "every table is unchanged");
    assert.equal(maintenanceMode.isActive(), false, "maintenance mode is left");
    assert.equal(exists(tgt.lockFile), false);
    assert.equal(tgt.calls.restarts.length, 0, "no restart for a restore that did not happen");
    assert.equal(exists(stored), false, "the unusable file is removed");
    assert.equal(tgt.store.get("PREFIX"), ".", "settings in memory untouched");
    // the pre-restore backup was written before the attempt and stays available
    assert.equal(fs.readdirSync(path.join(tgt.dataDir, "backups")).filter((n) => n.startsWith("pre-restore-")).length, 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("versions and validation", () => {
  async function inspectArchive(records, { enforceLengths, passphrase = PASS, models } = {}) {
    const target = models || (await kit.makeDb());
    const tgt = await installation("target", target, { extra: enforceLengths ? { enforceLengths } : {} });
    const file = path.join(tgt.home, "hand-made.owb");
    await kit.buildArchive({ file, passphrase, records });
    const uploadId = tgt.uploads.addFile(file);
    return { tgt, target, uploadId, run: () => tgt.restorer.inspect({ uploadId, passphrase, adminSessionId: "s1" }) };
  }

  test("a newer bot version is refused with both versions; an older one is accepted", async () => {
    const newer = await inspectArchive([kit.manifest({ botVersion: "10.0.0" })]);
    await assert.rejects(newer.run, (error) => error.code === "newer_version" && error.params.backupVersion === "10.0.0" && error.params.currentVersion === VERSION);
    const sameMinor = await inspectArchive([kit.manifest({ botVersion: "9.9.10" })]);
    await assert.rejects(sameMinor.run, { code: "newer_version" });
    const equal = await inspectArchive([kit.manifest({ botVersion: VERSION })]);
    assert.ok((await equal.run()).restoreToken);
    const older = await inspectArchive([kit.manifest({ botVersion: "0.1.0" })]);
    assert.ok((await older.run()).restoreToken);
  });

  test("an unknown container format is refused", async () => {
    const file = path.join(root, "format2.owb");
    await kit.buildArchive({
      file,
      passphrase: PASS,
      records: [kit.manifest()],
      headerEdit(target) {
        const bytes = fs.readFileSync(target);
        const text = bytes.toString("latin1");
        const at = text.indexOf('"format":1');
        bytes.write('"format":2', at, "latin1");
        fs.writeFileSync(target, bytes);
      },
    });
    const target = await kit.makeDb();
    const tgt = await installation("target", target);
    await assert.rejects(
      () => tgt.restorer.inspect({ uploadId: tgt.uploads.addFile(file), passphrase: PASS, adminSessionId: "s1" }),
      { code: "format_unsupported" },
    );
    const notABackup = tgt.uploads.add(Buffer.from("PK\u0003\u0004 definitely not a backup file at all............"));
    await assert.rejects(() => tgt.restorer.inspect({ uploadId: notABackup, passphrase: PASS, adminSessionId: "s1" }), { code: "format_unsupported" });
  });

  test("older backup: a model absent from the file is emptied, a missing column takes the default, an unknown column is dropped and counted", async () => {
    const target = await kit.makeDb();
    await target.Quote.create({ groupJid: "g", authorJid: "a", text: "present in the target, absent from the file", savedBy: "b" });
    await target.Group.create({ jid: "old@g.us", name: "old" });
    const { tgt, run } = await inspectArchive(
      [
        kit.manifest({ botVersion: "0.5.0", counts: { Group: 2, FutureModel: 3 } }),
        { t: "rows", model: "Group", rows: [{ jid: "a@g.us", name: "A", legacyColumn: 1 }, { jid: "b@g.us", legacyColumn: 2, other: "x" }] },
        { t: "rows", model: "FutureModel", rows: [{ a: 1 }, { a: 2 }, { a: 3 }] },
      ],
      { models: target },
    );
    const inspected = await run();
    assert.deepEqual(inspected.summary.ignoredModels, [{ model: "FutureModel", rows: 3 }]);
    assert.deepEqual(
      inspected.summary.ignoredColumns.sort((x, y) => (x.column < y.column ? -1 : 1)),
      [
        { model: "Group", column: "legacyColumn", rows: 2 },
        { model: "Group", column: "other", rows: 1 },
      ],
    );
    assert.deepEqual(inspected.summary.counts, { Group: 2 });

    await tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" });
    assert.equal(await target.Quote.count(), 0, "a model absent from the file is emptied");
    assert.equal(await target.Group.findByPk("old@g.us"), null);
    const b = await target.Group.findByPk("b@g.us");
    assert.equal(b.name, "", "the model default");
    assert.equal(b.welcomeMsg, "Welcome @user to @group");
    assert.equal(b.antilink, false);
  });

  test("an invalid row is refused with its model, its position and the field; nothing is changed", async () => {
    const target = await kit.makeDb();
    const keep = await target.Group.create({ jid: "keep@g.us", name: "keep" });
    const before = await dumpAll(target);
    const { run } = await inspectArchive(
      [
        kit.manifest({ counts: { Group: 3 } }),
        { t: "rows", model: "Group", rows: [{ jid: "a@g.us" }, { jid: "b@g.us", antilink: "maybe" }] },
        { t: "rows", model: "Group", rows: [{ jid: "c@g.us" }] },
      ],
      { models: target },
    );
    await assert.rejects(run, (error) => error.code === "invalid_row" && error.params.model === "Group" && error.params.index === 1 && error.params.field === "antilink");
    assert.deepEqual(await dumpAll(target), before);
    assert.ok(keep);

    const numbering = await inspectArchive(
      [
        kit.manifest({ counts: { Group: 3 } }),
        { t: "rows", model: "Group", rows: [{ jid: "a@g.us" }, { jid: "b@g.us" }] },
        { t: "rows", model: "Group", rows: [{ jid: "c@g.us" }, { jid: null }] },
      ],
      { models: target },
    );
    await assert.rejects(numbering.run, (error) => error.code === "invalid_row" && error.params.index === 3 && error.params.field === "jid");

    const enumProblem = await inspectArchive(
      [kit.manifest({ counts: { GroupRole: 1 } }), { t: "rows", model: "GroupRole", rows: [{ groupJid: "g", userJid: "u", role: "emperor" }] }],
      { models: target },
    );
    await assert.rejects(enumProblem.run, (error) => error.code === "invalid_row" && error.params.model === "GroupRole" && error.params.field === "role");
  });

  test("PermissionRule: a bad mode, 101 persons or a person with both forms null is refused as invalid_row (backup_invalid_row over HTTP); nothing is changed", async () => {
    const target = await kit.makeDb();
    await target.PermissionRule.create({ command: "vv", scope: "*", mode: "only", people: [{ pn: "237690000001@s.whatsapp.net", lid: null }] });
    const before = await dumpAll(target);
    const good = { command: "save", scope: "*", mode: "extra", people: [{ pn: "237690000002@s.whatsapp.net", lid: null }] };
    const person = (i) => ({ pn: `2376900${String(i).padStart(5, "0")}@s.whatsapp.net`, lid: null });
    const cases = [
      ["mode: all", { ...good, command: "kick", mode: "all" }, "mode"],
      ["101 persons", { ...good, command: "kick", people: Array.from({ length: 101 }, (_, i) => person(i)) }, "people"],
      ["both forms null", { ...good, command: "kick", people: [{ pn: null, lid: null }] }, "people"],
      ["a device suffix", { ...good, command: "kick", people: [{ pn: "237690000001:7@s.whatsapp.net", lid: null }] }, "people"],
      ["people stored as a string", { ...good, command: "kick", people: "[]" }, "people"],
      ["no mode at all", { command: "kick", scope: "*", people: [] }, "mode"],
    ];
    for (const [label, bad, field] of cases) {
      const { run } = await inspectArchive(
        [kit.manifest({ counts: { PermissionRule: 2 } }), { t: "rows", model: "PermissionRule", rows: [good, bad] }],
        { models: target },
      );
      await assert.rejects(
        run,
        (error) => error.code === "invalid_row" && error.params.model === "PermissionRule" && error.params.index === 1 && error.params.field === field,
        label,
      );
      assert.deepEqual(await dumpAll(target), before, `${label}: nothing changed`);
    }
    // the same rows, valid, are accepted (the refusals above come from the validators, not from the shape of the archive)
    const fine = await inspectArchive(
      [kit.manifest({ counts: { PermissionRule: 2 } }), { t: "rows", model: "PermissionRule", rows: [good, { ...good, command: "kick", mode: "only", people: [] }] }],
      { models: target },
    );
    assert.equal((await fine.run()).summary.counts.PermissionRule, 2);
  });

  test("PermissionRule: a backup whose manifest has no PermissionRule count (made before 003) empties the table", async () => {
    const target = await kit.makeDb();
    await target.PermissionRule.bulkCreate([
      { command: "vv", scope: "*", mode: "only", people: [{ pn: "237690000001@s.whatsapp.net", lid: null }] },
      { command: "save", scope: "120363@g.us", mode: "extra", people: [] },
    ]);
    await target.Group.create({ jid: "old@g.us", name: "old" });
    const { tgt, run } = await inspectArchive(
      [
        kit.manifest({ botVersion: "0.5.0", counts: { Group: 1 } }),
        { t: "rows", model: "Group", rows: [{ jid: "a@g.us", name: "A" }] },
      ],
      { models: target },
    );
    const inspected = await run();
    assert.equal(inspected.summary.counts.PermissionRule, undefined, "no count for a model the file does not carry");
    assert.deepEqual(inspected.summary.ignoredModels, []);
    await tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" });
    assert.equal(await target.PermissionRule.count(), 0, "a full restore replaces the rules: a file without any leaves none");
    assert.equal(await target.Group.count(), 1);
  });

  test("PermissionRule: a rule on a non-delegable command (eval) is restored untouched, never filtered by the backup", async () => {
    const target = await kit.makeDb();
    const people = [{ pn: "237690000001@s.whatsapp.net", lid: "123456789012345@lid" }];
    const rows = [
      { command: "eval", scope: "*", mode: "only", people, createdAt: "2026-03-01T08:00:00.000Z", updatedAt: "2026-03-02T09:30:00.000Z" },
      { command: "eval", scope: "120363@g.us", mode: "extra", people, createdAt: "2026-03-01T08:00:00.000Z", updatedAt: "2026-03-02T09:30:00.000Z" },
      { command: "ghostcommand", scope: "*", mode: "extra", people, createdAt: "2026-03-01T08:00:00.000Z", updatedAt: "2026-03-02T09:30:00.000Z" },
    ];
    const { tgt, run } = await inspectArchive(
      [kit.manifest({ counts: { PermissionRule: 3 } }), { t: "rows", model: "PermissionRule", rows }],
      { models: target },
    );
    const inspected = await run();
    assert.equal(inspected.summary.counts.PermissionRule, 3);
    await tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" });

    const restored = await target.PermissionRule.findAll({ order: [["command", "ASC"], ["scope", "ASC"]] });
    assert.deepEqual(restored.map((r) => `${r.command}|${r.scope}|${r.mode}`), ["eval|*|only", "eval|120363@g.us|extra", "ghostcommand|*|extra"]);
    for (const row of restored) assert.deepEqual(row.people, people);
    assert.equal(restored[0].createdAt.toISOString(), "2026-03-01T08:00:00.000Z");
    assert.equal(restored[0].updatedAt.toISOString(), "2026-03-02T09:30:00.000Z");
  });

  test("STRING length is enforced for a Postgres target (a SQLite target accepts the long value)", async () => {
    const long = "x".repeat(300);
    const records = [kit.manifest({ counts: { Group: 1 } }), { t: "rows", model: "Group", rows: [{ jid: "a@g.us", name: long }] }];
    const strict = await inspectArchive(records, { enforceLengths: true });
    await assert.rejects(strict.run, (error) => error.code === "invalid_row" && error.params.field === "name" && error.params.index === 0);
    const lenient = await inspectArchive(records);
    assert.ok((await lenient.run()).restoreToken);
  });

  test("settings: unknown, boot-only and read-only keys are dropped and counted; an invalid value refuses the restore", async () => {
    const intKey = require("../lib/utils/settingsCatalog").entries.find((e) => e.type === "int" && e.source === "env" && !e.readonly && e.effect !== "boot-only" && !e.inactive);
    assert.ok(intKey, "the catalog has a writable integer setting");
    const ok = await inspectArchive([
      kit.manifest({ counts: { SettingOverride: 4 } }),
      {
        t: "rows",
        model: "SettingOverride",
        rows: [
          { key: "PREFIX", value: "?", version: 3 },
          { key: "NOT_A_SETTING", value: "1", version: 1 },
          { key: "PANEL_PORT", value: "9999", version: 1 },
          { key: "ADMIN_PANEL", value: "true", version: 1 },
        ],
      },
    ]);
    const inspected = await ok.run();
    assert.equal(inspected.summary.ignoredSettings, 3);
    await ok.tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" });
    assert.deepEqual(await ok.target.SettingOverride.findAll({ raw: true }).then((rows) => rows.map((r) => r.key)), ["PREFIX"]);
    assert.ok((await ok.target.SettingOverride.findByPk("PREFIX")).version >= 4, "version moves past the backup's");

    const bad = await inspectArchive([
      kit.manifest({ counts: { SettingOverride: 1 } }),
      { t: "rows", model: "SettingOverride", rows: [{ key: intKey.key, value: "not a number at all" }] },
    ]);
    await assert.rejects(bad.run, (error) => error.code === "invalid_row" && error.params.model === "SettingOverride" && error.params.field === "value");
  });

  test("texts that no longer fit this installation are skipped and counted", async () => {
    const run = await inspectArchive([
      kit.manifest({ counts: { TextOverride: 3 } }),
      {
        t: "rows",
        model: "TextOverride",
        rows: [
          { key: "common.error", lang: "fr", text: "Un autre texte", originalHash: "0123456789abcdef" },
          { key: "no.such.key.at.all", lang: "fr", text: "x", originalHash: "0" },
          { key: "common.error", lang: "xx", text: "x", originalHash: "0" },
        ],
      },
    ]);
    const inspected = await run.run();
    assert.equal(inspected.summary.ignoredTexts, 2);
    await run.tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" });
    const rows = await run.target.TextOverride.findAll({ raw: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].originalHash, "0123456789abcdef", "the stored hash is kept so originalChanged still tells");
  });

  test("a manifest that disagrees with the rows, or rows that arrive before the manifest, is file_altered", async () => {
    const lie = await inspectArchive([kit.manifest({ counts: { Group: 5 } }), { t: "rows", model: "Group", rows: [{ jid: "a@g.us" }] }]);
    await assert.rejects(lie.run, { code: "file_altered" });
    const noManifest = await inspectArchive([{ t: "rows", model: "Group", rows: [{ jid: "a@g.us" }] }]);
    await assert.rejects(noManifest.run, { code: "file_altered" });
    const garbage = await inspectArchive([kit.manifest(), "this is not json at all"]);
    await assert.rejects(garbage.run, { code: "file_altered" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("session, media and the status file", () => {
  test("the session folder is included only with includeSession, copied as bytes, never parsed or logged", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    const logger = kit.recordingLogger();
    const tgt = await installation("target", target, { logger });

    const without = path.join(src.home, "without.owb");
    await src.exporter.exportToFile({ file: without, passphrase: PASS, includeSession: false, now: T0 });
    assert.equal((await kit.readAll(without, PASS)).filter((r) => r.t === "session").length, 0);
    assert.equal((await kit.readAll(without, PASS))[0].includesSession, false);

    const { inspected, exported } = await exportAndInspect(src, tgt, { includeSession: true });
    assert.equal(exported.includesSession, true);
    assert.equal(inspected.summary.includesSession, true);

    // the target already has a session of its own: it is replaced, the old one is not kept after success
    fs.mkdirSync(tgt.sessionDir, { recursive: true });
    fs.writeFileSync(path.join(tgt.sessionDir, "creds.json"), "OLD-SESSION");
    fs.writeFileSync(path.join(tgt.sessionDir, "stale.json"), "STALE");
    await tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" });

    assert.equal(fs.readFileSync(path.join(tgt.sessionDir, "creds.json"), "utf8"), '{"marker":"SESSION-SECRET-MARKER-1"}');
    assert.deepEqual(fs.readFileSync(path.join(tgt.sessionDir, "pre-key-7.json")), Buffer.from([0, 1, 2, 250, 251, 252]));
    assert.equal(exists(path.join(tgt.sessionDir, "stale.json")), false, "the folder is swapped, not merged");
    assert.deepEqual(fs.readdirSync(path.join(tgt.home, "sessions")).sort(), ["main"], "no staging or replaced folder left behind");
    assert.deepEqual(fs.readdirSync(path.join(tgt.dataDir, "backups")).filter((n) => n.startsWith("sessions-")), []);

    const logged = logger.lines.map((l) => l.text).join("\n");
    assert.ok(!logged.includes("SESSION-SECRET-MARKER"), "session contents never reach a log line");
    assert.ok(!logged.includes("creds.json"), "nor do their names");
  });

  test("an export of a source without a session folder says includesSession: false even when asked", async () => {
    const src = await installation("nosession", db);
    const file = path.join(src.home, "ns.owb");
    const out = await src.exporter.exportToFile({ file, passphrase: PASS, includeSession: true, now: T0 });
    assert.equal(out.includesSession, false);
  });

  test("a file name that is not a plain file name is refused, whatever its record says", async () => {
    const target = await kit.makeDb();
    const tgt = await installation("target", target);
    const file = path.join(tgt.home, "evil.owb");
    await kit.buildArchive({
      file,
      passphrase: PASS,
      records: [kit.manifest({ includesSession: true }), { t: "session", name: "../../etc/passwd", b64: Buffer.from("x").toString("base64") }],
    });
    await assert.rejects(
      () => tgt.restorer.inspect({ uploadId: tgt.uploads.addFile(file), passphrase: PASS, adminSessionId: "s1" }),
      { code: "file_altered" },
    );
  });

  test("media of the broadcasts that can still send, and the status file, come back; a final one-shot loses its media path", async () => {
    const src = await filledSource();
    // broadcast 23: one-shot, its only run is completed: its media is on its way out and is not carried
    await db.Broadcast.create({
      id: 23, kind: "once", text: "fini", targets: ["237600000001@s.whatsapp.net"], runAt: TIMES_DONE,
      mediaKind: "image", mediaPath: "data/broadcast-media/23/done.png", mediaName: "done.png", mediaMime: "image/png", mediaSize: 3,
    });
    await db.BroadcastRun.create({ id: 33, broadcastId: 23, dueAt: TIMES_DONE, status: "completed", total: 1, targetsReady: true, finishedAt: TIMES_DONE });
    fs.mkdirSync(path.join(src.dataDir, "broadcast-media", "23"), { recursive: true });
    fs.writeFileSync(path.join(src.dataDir, "broadcast-media", "23", "done.png"), "abc");

    const target = await kit.makeDb();
    const tgt = await installation("target", target);
    const { inspected, file } = await exportAndInspect(src, tgt);
    const records = await kit.readAll(file, PASS);
    const blobs = records.filter((r) => r.t === "blob");
    assert.deepEqual([...new Set(blobs.map((b) => b.path))].sort(), ["data/broadcast-media/21/photo.png", "data/broadcast-media/22/menu café.pdf"]);
    const chunks21 = blobs.filter((b) => b.path.includes("/21/"));
    assert.ok(chunks21.length >= 3, "1 MiB chunks");
    assert.deepEqual(chunks21.map((c) => c.seq), chunks21.map((_, i) => i));
    assert.deepEqual(chunks21.map((c) => c.last), chunks21.map((_, i) => i === chunks21.length - 1));

    await tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" });
    for (const [id, name] of [["21", "photo.png"], ["22", "menu café.pdf"]]) {
      assert.deepEqual(
        fs.readFileSync(path.join(tgt.dataDir, "broadcast-media", id, name)),
        fs.readFileSync(path.join(src.dataDir, "broadcast-media", id, name)),
      );
    }
    assert.equal((await target.Broadcast.findByPk(23)).mediaPath, null);
    assert.equal(exists(path.join(tgt.dataDir, "broadcast-media", "23")), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tgt.dataDir, "status_save.json"), "utf8")), { enabled: true, list: ["237600000001", "237600000002"] });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("inspect and the restore token", () => {
  test("inspect changes nothing: no table, no data/backups, no maintenance mode, no restart", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    await target.Group.create({ jid: "keep@g.us", name: "keep" });
    const tgt = await installation("target", target);
    const before = await dumpAll(target);
    const { inspected } = await exportAndInspect(src, tgt);
    assert.deepEqual(await dumpAll(target), before);
    assert.equal(exists(path.join(tgt.dataDir, "backups")), false);
    assert.equal(maintenanceMode.isActive(), false);
    assert.equal(tgt.calls.restarts.length, 0);
    assert.equal(tgt.calls.textsLoaded, 0);
    assert.equal(tgt.box.status().keyPresent, false);
    assert.match(inspected.restoreToken, /^[A-Za-z0-9_-]{20,}$/);
    assert.deepEqual(
      Object.keys(inspected.summary).sort(),
      ["botVersion", "counts", "createdAt", "dialect", "format", "ignoredColumns", "ignoredModels", "ignoredSettings", "ignoredTexts", "includesSession"],
    );
    assert.equal(inspected.summary.format, 1);
    assert.equal(inspected.summary.botVersion, VERSION);
  });

  test("the token lasts 15 minutes and is bound to the admin session", async () => {
    const clock = mutableClock();
    const src = await filledSource();
    const target = await kit.makeDb();
    const tgt = await installation("target", target, { clock });
    const { inspected } = await exportAndInspect(src, tgt);
    assert.equal(inspected.expiresAt, new Date(T0 + 15 * 60 * 1000).toISOString());

    assert.throws(() => tgt.restorer.checkToken(inspected.restoreToken, "another-session"), { code: "token_expired" });
    assert.throws(() => tgt.restorer.checkToken("not-the-token", "s1"), { code: "token_expired" });
    clock.t = T0 + 15 * 60 * 1000 - 1;
    assert.ok(tgt.restorer.checkToken(inspected.restoreToken, "s1"));
    clock.t = T0 + 15 * 60 * 1000;
    assert.throws(() => tgt.restorer.checkToken(inspected.restoreToken, "s1"), { code: "token_expired" });
    await assert.rejects(
      () => tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" }),
      { code: "token_expired" },
    );
    await fakes.waitFor(() => fs.readdirSync(path.join(tgt.dataDir, "tmp")).filter((n) => n.startsWith("restore-")).length === 0);
  });

  test("a token is single use and apply needs confirm: true", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    const tgt = await installation("target", target);
    const { inspected } = await exportAndInspect(src, tgt);
    await assert.rejects(
      () => tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: false, actor: "x", adminSessionId: "s1" }),
      { code: "confirmation_required" },
    );
    assert.equal(await target.Group.count(), 0);
    await tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" });
    await assert.rejects(
      () => tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" }),
      { code: "token_expired" },
    );
  });

  test("only one restore is active: a second inspect replaces the first token and removes its file", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    const tgt = await installation("target", target);
    const first = await exportAndInspect(src, tgt);
    const second = await exportAndInspect(src, tgt);
    assert.throws(() => tgt.restorer.checkToken(first.inspected.restoreToken, "s1"), { code: "token_expired" });
    assert.ok(tgt.restorer.checkToken(second.inspected.restoreToken, "s1"));
    assert.deepEqual(
      fs.readdirSync(path.join(tgt.dataDir, "tmp")).filter((n) => n.startsWith("restore-")),
      [`restore-${second.inspected.restoreToken}.owb`],
    );
  });

  test("an upload of another session, or an unknown one, is not found", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    const tgt = await installation("target", target);
    const file = path.join(src.home, "own.owb");
    await src.exporter.exportToFile({ file, passphrase: PASS, now: T0 });
    const uploadId = tgt.uploads.addFile(file, "s1");
    await assert.rejects(() => tgt.restorer.inspect({ uploadId, passphrase: PASS, adminSessionId: "s2" }), { code: "upload_not_found" });
    await assert.rejects(() => tgt.restorer.inspect({ uploadId: "f".repeat(32), passphrase: PASS, adminSessionId: "s1" }), { code: "upload_not_found" });
  });

  test("a successful inspect consumes the upload; a refused file is dropped", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    const tgt = await installation("target", target);
    const { uploadId } = await exportAndInspect(src, tgt);
    assert.equal(tgt.uploads.peek(uploadId, "s1"), null);
    const bad = tgt.uploads.add(Buffer.from("OWBBACKUP\n\u0000\u0000\u0000\u0004{}  garbage........................................"));
    await assert.rejects(() => tgt.restorer.inspect({ uploadId: bad, passphrase: PASS, adminSessionId: "s1" }));
    assert.equal(tgt.uploads.peek(bad, "s1"), null);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("apply", () => {
  test("maintenance mode, lock, pre-restore backup, in-process restart, then maintenance is left", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    await target.Group.create({ jid: "before@g.us", name: "avant" });
    const tgt = await installation("target", target);
    const { inspected } = await exportAndInspect(src, tgt);

    const phases = [];
    const result = await tgt.restorer.apply({
      restoreToken: inspected.restoreToken,
      confirm: true,
      actor: "10.0.0.8",
      adminSessionId: "s1",
      onPhase: (phase) => phases.push({ phase, maintenance: maintenanceMode.isActive() }),
    });

    assert.deepEqual(phases.map((p) => p.phase), ["maintenance", "pre_backup", "database", "session", "finalize", "restarting"]);
    assert.ok(phases.slice(1).every((p) => p.maintenance), "after the first phase the pipeline is paused");
    assert.equal(tgt.calls.restarts.length, 1);
    assert.equal(tgt.calls.restarts[0].actor, "10.0.0.8");
    assert.equal(tgt.calls.restarts[0].maintenance, true, "the restart happens inside maintenance mode");
    assert.equal(tgt.calls.restarts[0].lock, true, "restore.lock exists until the end");
    assert.equal(maintenanceMode.isActive(), false);
    assert.equal(exists(tgt.lockFile), false);
    assert.equal(result.restarted, true);
    assert.equal(tgt.restorer.hasToken(), false);
    assert.equal(fs.readdirSync(path.join(tgt.dataDir, "tmp")).length, 0, "no staging, no restore file left");

    // the pre-restore backup holds the PREVIOUS state and opens with the same passphrase
    assert.match(result.preRestoreFile, /^pre-restore-[0-9A-Za-z_-]{1,40}\.owb$/);
    const records = await kit.readAll(path.join(tgt.dataDir, "backups", result.preRestoreFile), PASS);
    assert.equal(records[0].counts.Group, 1);
    assert.deepEqual(records.find((r) => r.t === "rows" && r.model === "Group").rows.map((r) => r.jid), ["before@g.us"]);
    assert.equal(fs.statSync(path.join(tgt.dataDir, "backups", result.preRestoreFile)).mode & 0o777, 0o600);
  });

  test("only the last 3 pre-restore backups are kept", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    const clock = mutableClock();
    const tgt = await installation("target", target, { clock });
    const names = [];
    for (let i = 0; i < 4; i += 1) {
      clock.t += 1000;
      const { inspected } = await exportAndInspect(src, tgt);
      const done = await tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" });
      names.push(done.preRestoreFile);
    }
    const kept = fs.readdirSync(path.join(tgt.dataDir, "backups")).filter((n) => n.startsWith("pre-restore-")).sort();
    assert.deepEqual(kept, names.slice(1).sort());
    const stored = await tgt.restorer.listStored();
    assert.deepEqual(stored.map((item) => item.name), [...kept].reverse());
    assert.ok(stored.every((item) => item.kind === "pre-restore" && item.size > 0 && !Number.isNaN(Date.parse(item.createdAt))));
    const opened = await tgt.restorer.openStored(kept[0]);
    assert.equal(opened.size, stored.find((item) => item.name === kept[0]).size);
    opened.stream.destroy();
    for (const bad of ["../x.owb", "pre-restore-.owb", "pre-restore-a.txt", "restore.lock", "pre-restore-ok.owb", `pre-restore-${"a".repeat(41)}.owb`]) {
      assert.equal(await tgt.restorer.openStored(bad), null, bad);
    }
  });

  test("maintenance mode is left and the state is kept when the restart itself fails after the commit", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    const runtime = { restartBot: async () => ({ ok: false, code: "timeout", status: "disconnected" }) };
    const tgt = await installation("target", target, { runtime });
    const { inspected } = await exportAndInspect(src, tgt);
    const done = await tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" });
    assert.equal(done.ok, true);
    assert.equal(done.restarted, false);
    assert.deepEqual(done.warnings, ["restart_timeout"]);
    assert.equal(maintenanceMode.isActive(), false);
    await sameModels(db, target);
  });

  test("an interrupted apply keeps the previous state; the boot recovery says so and puts a half-swapped session back", async () => {
    const target = await kit.makeDb();
    const logger = kit.recordingLogger();
    const tgt = await installation("target", target, { logger });
    // a restore that died between the two renames of the session swap
    const backups = path.join(tgt.dataDir, "backups");
    const replaced = path.join(backups, "sessions-20260601-100000-000");
    const staged = path.join(path.dirname(tgt.sessionDir), ".restore-20260601-100000-000");
    fs.mkdirSync(replaced, { recursive: true });
    fs.writeFileSync(path.join(replaced, "creds.json"), "PREVIOUS");
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(staged, "creds.json"), "HALF");
    fs.writeFileSync(tgt.lockFile, JSON.stringify({ v: 1, phase: "session", session: { dir: tgt.sessionDir, staged, replaced } }));
    // leftovers of an upload and of an export
    fs.mkdirSync(path.join(tgt.dataDir, "tmp"), { recursive: true });
    fs.writeFileSync(path.join(tgt.dataDir, "tmp", "restore-abc.owb"), "x");
    fs.writeFileSync(path.join(tgt.dataDir, "tmp", "export-abc.owb"), "x");
    fs.writeFileSync(path.join(tgt.dataDir, "tmp", "someone-elses.txt"), "keep");

    assert.equal(tgt.restorer.isInterrupted(), false);
    const out = await tgt.restorer.recoverAtBoot();
    assert.deepEqual(out, { interrupted: true, swept: 2, sessionRestored: true });
    assert.equal(tgt.restorer.isInterrupted(), true);
    assert.equal(fs.readFileSync(path.join(tgt.sessionDir, "creds.json"), "utf8"), "PREVIOUS");
    assert.equal(exists(staged), false);
    assert.equal(exists(tgt.lockFile), false);
    assert.deepEqual(fs.readdirSync(path.join(tgt.dataDir, "tmp")), ["someone-elses.txt"]);
    assert.ok(logger.lines.some((l) => l.level === "warn" && l.text.includes("restore interrupted, previous state kept")));

    // a second boot finds nothing to do
    const again = await tgt.restorer.recoverAtBoot();
    assert.equal(again.interrupted, false);
  });

  test("boot recovery without a lock sweeps data/tmp and raises nothing; a lock naming foreign paths moves nothing", async () => {
    const target = await kit.makeDb();
    const tgt = await installation("target", target);
    assert.deepEqual(await tgt.restorer.recoverAtBoot(), { interrupted: false, swept: 0, sessionRestored: false });
    const foreign = path.join(tgt.home, "precious");
    fs.mkdirSync(foreign, { recursive: true });
    fs.mkdirSync(path.dirname(tgt.lockFile), { recursive: true });
    fs.writeFileSync(tgt.lockFile, JSON.stringify({ phase: "session", session: { dir: tgt.sessionDir, staged: foreign, replaced: foreign } }));
    const out = await tgt.restorer.recoverAtBoot();
    assert.equal(out.interrupted, true);
    assert.equal(out.sessionRestored, false);
    assert.ok(exists(foreign), "paths read from the lock file are checked, never trusted");
    fs.writeFileSync(tgt.lockFile, "{ not json");
    assert.equal((await tgt.restorer.recoverAtBoot()).interrupted, true);
  });

  test("two applies at once: the second is busy", async () => {
    const src = await filledSource();
    const target = await kit.makeDb();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const runtime = { restartBot: async () => (await gate, { ok: true }) };
    const tgt = await installation("target", target, { runtime });
    const { inspected } = await exportAndInspect(src, tgt);
    const running = tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" });
    await fakes.waitFor(() => maintenanceMode.isActive() && tgt.restorer.isBusy());
    await assert.rejects(() => tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" }), { code: "busy" });
    await assert.rejects(() => tgt.restorer.inspect({ uploadId: "a".repeat(32), passphrase: PASS, adminSessionId: "s1" }), { code: "busy" });
    release();
    await running;
    assert.equal(tgt.restorer.isBusy(), false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("the key derivation gate and the stream", () => {
  test("one scrypt in flight, four waiting, the sixth caller gets rate_limited", async () => {
    const gate = format.createKdfGate();
    const releases = [];
    const slow = () => new Promise((resolve) => releases.push(resolve));
    const runs = [];
    for (let i = 0; i < 5; i += 1) runs.push(gate.run(slow));
    assert.deepEqual(gate.stats(), { inFlight: 1, waiting: 4, maxWaiting: 4 });
    await assert.rejects(() => gate.run(slow), (error) => error.code === "rate_limited" && error.params.retryAfterMs > 0);
    for (let i = 0; i < 5; i += 1) {
      await fakes.waitFor(() => releases.length > i);
      releases[i](i);
    }
    assert.deepEqual(await Promise.all(runs), [0, 1, 2, 3, 4]);
    assert.deepEqual(gate.stats(), { inFlight: 0, waiting: 0, maxWaiting: 4 });
  });

  test("scrypt cost in a header is bounded: a file may not ask for gigabytes", async () => {
    const target = await kit.makeDb();
    const tgt = await installation("target", target);
    const file = path.join(tgt.home, "huge.owb");
    await kit.buildArchive({ file, passphrase: PASS, records: [kit.manifest()] });
    const bytes = fs.readFileSync(file);
    const text = bytes.toString("latin1");
    const at = text.indexOf('"N":16');
    bytes.write('"N":99999999', at, "latin1"); // longer than the original: the length prefix no longer fits the header
    const patched = Buffer.concat([bytes.subarray(0, 0), bytes]);
    await assert.rejects(
      () => tgt.restorer.inspect({ uploadId: tgt.uploads.add(patched), passphrase: PASS, adminSessionId: "s1" }),
      (error) => ["format_unsupported", "file_altered"].includes(error.code),
    );
  });

  test("exportStream: a stream of the file, a dated name, counts, and the temporary file goes away with the stream", async () => {
    const src = await filledSource();
    const out = await src.exporter.exportStream({ passphrase: PASS, includeSession: false, now: Date.UTC(2026, 11, 31, 23, 5, 9) });
    assert.equal(out.filename, "openwabot-backup-20261231-230509.owb");
    assert.equal(out.counts.Group, 2);
    assert.equal(out.includesSession, false);
    const tmp = path.join(src.dataDir, "tmp");
    assert.equal(fs.readdirSync(tmp).length, 1);
    const chunks = [];
    for await (const chunk of out.stream) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    assert.equal(body.length, out.size);
    assert.equal(body.subarray(0, 10).toString("latin1"), "OWBBACKUP\n");
    await fakes.waitFor(() => fs.readdirSync(tmp).length === 0);
  });

  test("the passphrase never appears in the archive, the logs or the file names", async () => {
    const src = await filledSource();
    const logger = kit.recordingLogger();
    const exporter = createExporter({ ...src.deps, logger });
    const file = path.join(src.home, "leak.owb");
    await exporter.exportToFile({ file, passphrase: PASS, now: T0 });
    assert.ok(!fs.readFileSync(file).includes(Buffer.from(PASS)));
    assert.ok(!logger.lines.some((l) => l.text.includes(PASS)));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("Postgres round trip (opt-in: TEST_POSTGRES_URL, a throwaway database whose name contains \"test\")", () => {
  const url = process.env.TEST_POSTGRES_URL;
  const usable = Boolean(url) && /test/i.test(url.split("/").pop() || "");

  test("export from SQLite, restore on Postgres: identical rows, sequences moved past the restored ids", { skip: usable ? false : "TEST_POSTGRES_URL is not set to a test database" }, async () => {
    const { Sequelize } = require("sequelize");
    const sequelize = new Sequelize(url, { logging: false });
    const models = { DATABASE: sequelize };
    const dir = path.join(__dirname, "..", "lib", "database", "models");
    for (const file of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) models[path.basename(file, ".js")] = require(path.join(dir, file))(sequelize);
    try {
      await sequelize.sync({ force: true });
      const src = await filledSource();
      const tgt = await installation("pg", models);
      const { inspected } = await exportAndInspect(src, tgt);
      await tgt.restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" });
      await sameModels(db, models);
      for (const name of format.AUTO_INCREMENT_MODELS) {
        const max = (await models[name].max(models[name].primaryKeyAttributes[0])) || 0;
        const created = await models[name].create(await nextRow(models, name, max));
        assert.ok(created.get(models[name].primaryKeyAttributes[0]) > max, `${name}: the sequence follows the restored ids`);
      }
    } finally {
      await sequelize.drop();
      await sequelize.close();
    }
  });
});

/** A minimal valid row for each auto-increment model, to prove the sequence moved */
async function nextRow(models, name, max) {
  const rows = {
    Filter: { pattern: "p", response: "r" },
    Warn: { jid: "j", groupJid: `g-${max}` },
    Idea: { groupJid: "g", authorJid: "a", text: "t" },
    Quote: { groupJid: "g", authorJid: "a", text: "t", savedBy: "b" },
    Task: { chatJid: "c", text: "t", createdBy: "u" },
    Reminder: { chatJid: "c", creatorJid: "u", text: "t", dueAt: new Date() },
    NotifyKeyword: { userJid: "u", keyword: "abc", scopeJid: "g" },
    StickerCommand: { stickerHash: `h${max}`, command: "c", createdBy: "u" },
    AntiDelete: {},
    ViewOnce: {},
    AutoResponder: {},
    Broadcast: { kind: "once", text: "t", targets: ["x@s.whatsapp.net"], runAt: new Date() },
    BroadcastRun: { broadcastId: 21, dueAt: new Date(Date.now() + max * 1000 + 1000) },
    BroadcastTarget: { runId: 31, chatJid: `c${max}@s.whatsapp.net`, position: 9 },
  };
  return rows[name];
}
