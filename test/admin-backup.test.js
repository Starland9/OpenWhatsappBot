"use strict";
/**
 * BAK-1 to BAK-5 of the admin panel (T168, SC-011; admin-http-api.md 2.13), through the real createAdmin on the test
 * harness: the real authentication, the real uploads, an in-memory database, temporary directories, a stand-in for
 * the bot runtime and a key file of the secret box in a temporary directory.
 *
 *  - BAK-1: a passphrase of at least 12 code points (NFKC), `includeSession` needs `confirmSession: true`, the
 *    validation happens before any byte is sent, the streaming headers, `409 busy`, the passphrase in no log and no
 *    audit row (counts and `includesSession` only);
 *  - BAK-2 over an UP-1 upload: the summary and the five 422 reasons;
 *  - BAK-3: `confirm: true` and a valid token, 202 with a `restore` job (phases maintenance, pre_backup, database,
 *    session, finalize, restarting), `503 maintenance` on mutating routes while the reads answer, the failure shape;
 *  - BAK-4 / BAK-5: the pre-restore backups; the boot banner `restore_interrupted`.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ lang: "fr" });

const { createTestAdmin } = require("./helpers/adminHarness");
const { createFakeRuntime } = require("./helpers/fakeBotRuntime");
const kit = require("./helpers/backupKit");
const format = require("../lib/admin/backup/format");
const { createExporter } = require("../lib/admin/backup/export");
const { createSettingsStore } = require("../lib/utils/settingsStore");
const { createSecretBox } = require("../lib/utils/secretBox");
const maintenanceMode = require("../lib/utils/maintenanceMode");
const { languageManager } = require("../lib/utils/language");

const PASS = "a long enough passphrase";
const PASSWORD = "a long enough password";

let db;
let root;
let t;
let client;
let rt;
let store;
let box;
let sessionDir;

before(async () => {
  db = await fakes.syncDb();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-admin-backup-"));
});

after(() => {
  maintenanceMode._reset();
  fs.rmSync(root, { recursive: true, force: true });
});

async function clearData() {
  for (const name of [...format.MODELS]) await db[name].destroy({ where: {} });
  languageManager.reload();
}

async function boot({ beforeStart, runtime, deps: extraDeps = {} } = {}) {
  await clearData();
  maintenanceMode._reset();
  rt = runtime || createFakeRuntime();
  box = createSecretBox({ dir: fs.mkdtempSync(path.join(root, "key-")) });
  store = createSettingsStore({ models: db, secretBox: box });
  await store.load();
  sessionDir = path.join(fs.mkdtempSync(path.join(root, "sess-")), "main");
  const deps = {
    runtime: rt,
    settingsStore: store,
    secretBox: box,
    maintenanceMode,
    stats: { flush: async () => {} },
    sessionDir,
    ...extraDeps,
  };
  t = await createTestAdmin({ deps });
  if (beforeStart) await beforeStart(t);
  await t.admin.start();
  client = await t.loginClient(PASSWORD);
  return t;
}

afterEach(async () => {
  if (t) await t.close();
  t = null;
  maintenanceMode._reset();
  languageManager.reload();
});

const headersFor = (extra = {}) => ({ Origin: t.base, "X-CSRF-Token": client.csrf, ...extra });
const rawPost = (pathname, body) =>
  client.raw({ method: "POST", path: pathname, headers: headersFor({ "Content-Type": "application/json", Accept: "*/*" }), body: JSON.stringify(body) });
const exportRaw = (body) => rawPost("/admin/api/backup/export", body);
const rawGet = (pathname) => client.raw({ method: "GET", path: pathname, headers: { Origin: t.base, Accept: "*/*" } });

async function uploadFile(buffer, who = client) {
  const res = await who.raw({
    method: "PUT",
    path: "/admin/api/uploads?purpose=backup&name=backup.owb",
    headers: { Origin: t.base, "Content-Type": "application/octet-stream", "X-CSRF-Token": who.csrf },
    body: buffer,
  });
  assert.equal(res.status, 201, res.text);
  return res.json.uploadId;
}

const inspect = (uploadId, passphrase = PASS) => client.api("POST", "/admin/api/backup/inspect", { uploadId, passphrase });
const restore = (restoreToken, extra = {}) => client.api("POST", "/admin/api/backup/restore", { restoreToken, confirm: true, ...extra });
const codeOf = (answer) => answer.json && answer.json.error && answer.json.error.code;
const paramsOf = (answer) => answer.json && answer.json.error && answer.json.error.params;
const fieldsOf = (answer) => answer.json && answer.json.error && answer.json.error.fields;
const auditRows = (action) => db.AuditLog.findAll({ where: { action }, raw: true, order: [["id", "ASC"]] });

async function waitJob(id, { timeout = 8000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const answer = await client.get(`/admin/api/jobs/${id}`);
    const job = answer.json && answer.json.job ? answer.json.job : answer.json;
    if (job && job.status !== "running") return job;
    assert.ok(Date.now() < deadline, "the job did not finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Fill the database with something recognisable, export it through BAK-1, return the file */
async function exportedFile({ includeSession = false } = {}) {
  await clearData();
  await store.reload(); // the table was emptied behind its back
  await db.Group.bulkCreate([
    { jid: "1@g.us", name: "Un", antilink: true },
    { jid: "2@g.us", name: "Deux" },
  ]);
  await db.Quote.create({ groupJid: "1@g.us", authorJid: "a", text: "citation", savedBy: "b" });
  await db.CommandState.create({ command: "ping", scope: "*" });
  await store.set({ PREFIX: "?", OPENAI_API_KEY: "sk-http-secret" });
  const body = { passphrase: PASS };
  if (includeSession) Object.assign(body, { includeSession: true, confirmSession: true });
  const res = await exportRaw(body);
  assert.equal(res.status, 200, res.text);
  return res.buffer;
}

describe("routes", () => {
  test("BAK-1 to BAK-5 are session routes, the three POSTs are CSRF-guarded mutations, the GETs mutate nothing", async () => {
    await boot();
    const routes = t.admin.routes().filter((r) => r.path.startsWith("/admin/api/backup"));
    assert.deepEqual(
      routes.map((r) => `${r.method} ${r.path}`).sort(),
      [
        "GET /admin/api/backup/stored",
        "GET /admin/api/backup/stored/:name",
        "POST /admin/api/backup/export",
        "POST /admin/api/backup/inspect",
        "POST /admin/api/backup/restore",
      ],
    );
    for (const route of routes) {
      assert.equal(route.auth, "session");
      assert.equal(route.mutates, route.method === "POST");
      assert.equal(route.csrf, route.method === "POST");
    }
    const anonymous = t.client();
    for (const [method, url] of [["POST", "/admin/api/backup/export"], ["POST", "/admin/api/backup/inspect"], ["POST", "/admin/api/backup/restore"], ["GET", "/admin/api/backup/stored"], ["GET", "/admin/api/backup/stored/pre-restore-x.owb"]]) {
      const answer = await anonymous.api(method, url, method === "POST" ? {} : undefined);
      assert.equal(answer.status, 401, `${method} ${url}`);
    }
    const noToken = await client.raw({
      method: "POST",
      path: "/admin/api/backup/export",
      headers: { Origin: t.base, "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase: PASS }),
    });
    assert.equal(noToken.status, 403);
  });
});

describe("BAK-1 export", () => {
  test("the passphrase needs 12 code points after NFKC; nothing is streamed for a refused request", async () => {
    await boot();
    const short = await exportRaw({ passphrase: "too short" });
    assert.equal(short.status, 422);
    assert.deepEqual(fieldsOf(short), { passphrase: { code: "too_short", params: { min: 12 } } });
    assert.match(short.headers["content-type"], /json/);
    assert.ok(!short.text.includes("too short"), "the submitted value is never echoed");

    const emoji11 = await exportRaw({ passphrase: "😀".repeat(11) });
    assert.equal(emoji11.status, 422, "11 code points are 22 UTF-16 units: code points count");
    const emoji12 = await exportRaw({ passphrase: "😀".repeat(12) });
    assert.equal(emoji12.status, 200);
    const decomposed11 = await exportRaw({ passphrase: "é".repeat(11) });
    assert.equal(decomposed11.status, 422, "NFKC makes 11 characters of 22 code points");
    const decomposed12 = await exportRaw({ passphrase: "é".repeat(12) });
    assert.equal(decomposed12.status, 200);

    assert.equal((await exportRaw({})).status, 422);
    assert.equal((await exportRaw({ passphrase: PASS, extra: 1 })).status, 422);
    assert.deepEqual(fieldsOf(await exportRaw({ passphrase: PASS, extra: 1 })), { $unknown: { code: "unknown_field" } });
    assert.equal((await exportRaw({ passphrase: "x".repeat(257) })).status, 422);
  });

  test("includeSession needs confirmSession: true, else 409 confirmation_required with params.confirm = include_session", async () => {
    await boot();
    for (const body of [{ passphrase: PASS, includeSession: true }, { passphrase: PASS, includeSession: true, confirmSession: false }]) {
      const answer = await exportRaw(body);
      assert.equal(answer.status, 409);
      assert.equal(codeOf(answer), "confirmation_required");
      assert.deepEqual(paramsOf(answer), { confirm: "include_session" });
    }
    // a bad passphrase is a 422 even when the confirmation is also missing: validation comes first
    assert.equal((await exportRaw({ passphrase: "short", includeSession: true })).status, 422);
    assert.equal((await exportRaw({ passphrase: PASS, confirmSession: true })).status, 200, "confirmSession alone is harmless");
  });

  test("200 streams the file with attachment and no-store headers; the archive opens with the passphrase", async () => {
    await boot();
    const before = Date.now();
    const res = await exportRaw({ passphrase: PASS });
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "application/octet-stream");
    assert.match(res.headers["content-disposition"], /^attachment; filename="openwabot-backup-\d{8}-\d{6}\.owb"$/);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(Number(res.headers["content-length"]), res.buffer.length);
    assert.equal(res.buffer.subarray(0, 10).toString("latin1"), "OWBBACKUP\n");
    assert.ok(Date.now() - before < 8000);
    await fakes.waitFor(() => fs.readdirSync(path.join(t.dataDir, "tmp")).length === 0); // removed when the stream closes

    const file = path.join(root, "downloaded.owb");
    fs.writeFileSync(file, res.buffer);
    const records = await kit.readAll(file, PASS);
    assert.equal(records[0].t, "manifest");
    assert.equal(records[0].includesSession, false);
    assert.equal(Object.keys(records[0].counts).length, 25);
  });

  test("includeSession: true carries the session files of the folder", async () => {
    await boot();
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "creds.json"), '{"x":1}');
    const res = await exportRaw({ passphrase: PASS, includeSession: true, confirmSession: true });
    assert.equal(res.status, 200);
    const file = path.join(root, "with-session.owb");
    fs.writeFileSync(file, res.buffer);
    const records = await kit.readAll(file, PASS);
    assert.equal(records[0].includesSession, true);
    assert.deepEqual(records.filter((r) => r.t === "session").map((r) => r.name), ["creds.json"]);
    const audit = (await auditRows("backup.export")).pop();
    assert.equal(JSON.parse(audit.detail).includesSession, true);
  });

  test("the passphrase is in no log line and no audit row: counts and includesSession only", async () => {
    await boot();
    const secretPass = "UNIQUE-pass-phrase-0042";
    await db.Group.create({ jid: "9@g.us", name: "g" });
    const res = await exportRaw({ passphrase: secretPass });
    assert.equal(res.status, 200);
    const refused = await exportRaw({ passphrase: secretPass, includeSession: true });
    assert.equal(refused.status, 409);
    const rows = await auditRows("backup.export");
    assert.equal(rows.length, 1, "a refused request is not an export");
    assert.deepEqual(Object.keys(JSON.parse(rows[0].detail)).sort(), ["counts", "includesSession"]);
    assert.equal(rows[0].target, null);
    assert.equal(rows[0].result, "ok");
    assert.equal(JSON.parse(rows[0].detail).counts.Group, 1);
    assert.ok(!JSON.stringify(await t.dumpTables()).includes(secretPass));
    assert.ok(!JSON.stringify(t.logger.lines).includes(secretPass));
    assert.ok(!refused.text.includes(secretPass));
    assert.ok(!res.buffer.includes(Buffer.from(secretPass)));
  });

  test("409 busy while another export runs", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let real = null;
    const slow = {
      exportToFile: (o) => (real || (real = createExporter(t.deps))).exportToFile(o),
      exportStream: async (o) => {
        await gate;
        return (real || (real = createExporter(t.deps))).exportStream(o);
      },
    };
    await boot({ deps: { backupExporter: slow } });

    const first = exportRaw({ passphrase: PASS });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await exportRaw({ passphrase: PASS });
    assert.equal(second.status, 409);
    assert.equal(codeOf(second), "busy");
    release();
    assert.equal((await first).status, 200);
    assert.equal((await exportRaw({ passphrase: PASS })).status, 200, "free again once the first stream is closed");
  });
});

describe("BAK-2 inspect", () => {
  test("an UP-1 upload gives the summary and a token; nothing is modified", async () => {
    await boot();
    const file = await exportedFile();
    await db.Group.create({ jid: "3@g.us", name: "after the export" });
    const before = await t.dumpTables();
    const uploadId = await uploadFile(file);
    const answer = await inspect(uploadId);
    assert.equal(answer.status, 200, answer.text);
    assert.match(answer.json.restoreToken, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(answer.json.expiresAt, new Date(t.clock.now() + 15 * 60 * 1000).toISOString());
    assert.deepEqual(
      Object.keys(answer.json.summary).sort(),
      ["botVersion", "counts", "createdAt", "dialect", "format", "ignoredColumns", "ignoredModels", "ignoredSettings", "ignoredTexts", "includesSession"],
    );
    const { summary } = answer.json;
    assert.equal(summary.format, 1);
    assert.equal(summary.botVersion, t.config.VERSION);
    assert.equal(summary.dialect, "sqlite");
    assert.equal(summary.includesSession, false);
    assert.equal(summary.counts.Group, 2);
    assert.equal(summary.counts.Quote, 1);
    assert.equal(summary.counts.CommandState, 1);
    assert.equal(summary.counts.SettingOverride, 2);
    assert.deepEqual([summary.ignoredModels, summary.ignoredColumns], [[], []]);
    assert.ok(!answer.text.includes("sk-http-secret"), "the summary never carries a value");

    assert.deepEqual(await t.dumpTables(), before, "no table changed");
    assert.equal(fs.existsSync(path.join(t.dataDir, "backups")), false);
    assert.equal(maintenanceMode.isActive(), false);
    assert.equal(rt.restarts.length, 0);
    assert.equal(store.get("PREFIX"), "?", "settings in memory untouched");
  });

  test("the five 422 reasons: wrong_passphrase, backup_corrupted, backup_unsupported_format, backup_too_new, backup_invalid_row", async () => {
    await boot();
    const good = await exportedFile();

    const wrong = await inspect(await uploadFile(good), "another passphrase!!");
    assert.equal(wrong.status, 422);
    assert.equal(codeOf(wrong), "wrong_passphrase");

    const altered = Buffer.from(good);
    altered[Math.floor(altered.length / 2)] ^= 1;
    const corrupted = await inspect(await uploadFile(altered));
    assert.equal(corrupted.status, 422);
    assert.equal(codeOf(corrupted), "backup_corrupted");
    const truncated = await inspect(await uploadFile(good.subarray(0, good.length - 30)));
    assert.equal(codeOf(truncated), "backup_corrupted");

    const format2 = path.join(root, "format2.owb");
    await kit.buildArchive({
      file: format2,
      passphrase: PASS,
      records: [kit.manifest()],
      headerEdit(target) {
        const bytes = fs.readFileSync(target);
        bytes.write('"format":2', bytes.toString("latin1").indexOf('"format":1'), "latin1");
        fs.writeFileSync(target, bytes);
      },
    });
    const unsupported = await inspect(await uploadFile(fs.readFileSync(format2)));
    assert.equal(unsupported.status, 422);
    assert.equal(codeOf(unsupported), "backup_unsupported_format");

    const newer = path.join(root, "newer.owb");
    await kit.buildArchive({ file: newer, passphrase: PASS, records: [kit.manifest({ botVersion: "99.1.2" })] });
    const tooNew = await inspect(await uploadFile(fs.readFileSync(newer)));
    assert.equal(tooNew.status, 422);
    assert.equal(codeOf(tooNew), "backup_too_new");
    assert.deepEqual(paramsOf(tooNew), { backupVersion: "99.1.2", currentVersion: t.config.VERSION });

    const invalid = path.join(root, "invalid.owb");
    await kit.buildArchive({
      file: invalid,
      passphrase: PASS,
      records: [
        kit.manifest({ counts: { Group: 2 } }),
        { t: "rows", model: "Group", rows: [{ jid: "ok@g.us" }, { jid: "bad@g.us", mute: "perhaps" }] },
      ],
    });
    const badRow = await inspect(await uploadFile(fs.readFileSync(invalid)));
    assert.equal(badRow.status, 422);
    assert.equal(codeOf(badRow), "backup_invalid_row");
    assert.deepEqual(paramsOf(badRow), { model: "Group", index: 1, field: "mute" });
    assert.ok(!badRow.text.includes("perhaps"), "the offending value is not echoed");
  });

  test("a wrong passphrase leaves the upload for another try; a damaged file is dropped", async () => {
    await boot();
    const good = await exportedFile();
    const uploadId = await uploadFile(good);
    assert.equal(codeOf(await inspect(uploadId, "wrong passphrase!!")), "wrong_passphrase");
    const second = await inspect(uploadId);
    assert.equal(second.status, 200, "same upload, right passphrase");

    const altered = Buffer.from(good);
    altered[altered.length - 5] ^= 1;
    const damaged = await uploadFile(altered);
    assert.equal(codeOf(await inspect(damaged)), "backup_corrupted");
    assert.equal(codeOf(await inspect(damaged)), "not_found", "consumed");
  });

  test("an unknown, expired or foreign upload is 404; the body is strict", async () => {
    await boot();
    const good = await exportedFile();
    const uploadId = await uploadFile(good);
    const other = t.client();
    const login = await other.login(PASSWORD);
    assert.equal(login.status, 200, login.text);
    const foreign = await other.api("POST", "/admin/api/backup/inspect", { uploadId, passphrase: PASS });
    assert.equal(foreign.status, 404);
    assert.equal(codeOf(foreign), "not_found");
    assert.equal(codeOf(await inspect("0".repeat(32))), "not_found");
    assert.equal((await client.api("POST", "/admin/api/backup/inspect", { uploadId: "xyz", passphrase: PASS })).status, 422);
    assert.equal((await client.api("POST", "/admin/api/backup/inspect", { uploadId, passphrase: PASS, extra: true })).status, 422);
    assert.equal((await inspect(uploadId)).status, 200, "the owner's own session still has it");
  });
});

describe("BAK-3 restore", () => {
  test("needs confirm: true and a valid token", async () => {
    await boot();
    const file = await exportedFile();
    const { restoreToken } = (await inspect(await uploadFile(file))).json;

    const unconfirmed = await client.api("POST", "/admin/api/backup/restore", { restoreToken });
    assert.equal(unconfirmed.status, 409);
    assert.equal(codeOf(unconfirmed), "confirmation_required");
    assert.deepEqual(paramsOf(unconfirmed), { confirm: "restore" });
    const falsy = await client.api("POST", "/admin/api/backup/restore", { restoreToken, confirm: false });
    assert.equal(codeOf(falsy), "confirmation_required");

    const unknown = await restore("not-a-token-at-all");
    assert.equal(unknown.status, 409);
    assert.equal(codeOf(unknown), "restore_token_invalid");
    assert.equal((await client.api("POST", "/admin/api/backup/restore", { confirm: true })).status, 422);

    // nothing was done by any of those: the token still works
    const ok = await restore(restoreToken);
    assert.equal(ok.status, 202, ok.text);
    await waitJob(ok.json.job.id);
  });

  test("202 with a restore job; the data comes back, the settings are reloaded, the bot restarts in process", async () => {
    await boot();
    const file = await exportedFile();
    // the installation drifts after the backup
    await db.Group.destroy({ where: {} });
    await db.Group.create({ jid: "9@g.us", name: "new" });
    await db.Quote.destroy({ where: {} });
    await store.set({ PREFIX: "#" });
    const uploadId = await uploadFile(file);
    const { restoreToken } = (await inspect(uploadId)).json;

    const phases = [];
    const off = t.hub.subscribe("job", (event) => {
      if (event && event.type === "restore" && event.phase) phases.push(event.phase);
    });
    const accepted = await restore(restoreToken);
    assert.equal(accepted.status, 202, accepted.text);
    assert.equal(accepted.json.job.type, "restore");
    assert.equal(accepted.json.job.status, "running");
    const job = await waitJob(accepted.json.job.id);
    off();

    assert.equal(job.status, "done", JSON.stringify(job));
    assert.deepEqual([...new Set(phases)], ["maintenance", "pre_backup", "database", "session", "finalize", "restarting"]);
    assert.equal(job.result.ok, true);
    assert.match(job.result.preRestoreFile, /^pre-restore-/);
    assert.equal(job.result.restarted, true);

    assert.deepEqual((await db.Group.findAll({ order: [["jid", "ASC"]] })).map((g) => g.jid), ["1@g.us", "2@g.us"]);
    assert.equal(await db.Quote.count(), 1);
    assert.equal(await db.CommandState.count(), 1);
    assert.equal(store.get("PREFIX"), "?", "settings reloaded");
    assert.equal(store.get("OPENAI_API_KEY"), "sk-http-secret");
    assert.equal(rt.restarts.length, 1);
    assert.equal(maintenanceMode.isActive(), false);
    assert.equal(fs.existsSync(path.join(t.dataDir, "backups", "restore.lock")), false);

    const rows = await auditRows("backup.restore");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, "ok");
    assert.deepEqual(Object.keys(JSON.parse(rows[0].detail)).sort(), ["counts", "includesSession"]);

    // the admin stays logged in: AdminSession rows are untouched
    assert.equal((await client.get("/admin/api/state")).status, 200);
    assert.equal((await client.get("/admin/api/backup/stored")).status, 200);
  });

  test("while the restore applies, mutating routes answer 503 maintenance and the reads still answer", async () => {
    await boot();
    const file = await exportedFile();
    const uploadId = await uploadFile(file);
    const { restoreToken } = (await inspect(uploadId)).json;
    const hold = rt.holdRestart();

    const accepted = await restore(restoreToken);
    assert.equal(accepted.status, 202);
    await fakes.waitFor(() => rt.restarts.length === 1);
    assert.equal(maintenanceMode.isActive(), true);

    const mutation = await client.api("POST", "/admin/api/backup/inspect", { uploadId: "0".repeat(32), passphrase: PASS });
    assert.equal(mutation.status, 503);
    assert.equal(codeOf(mutation), "maintenance");
    assert.equal(mutation.headers.get("retry-after"), "5");
    assert.equal((await exportRaw({ passphrase: PASS })).status, 503);
    assert.equal((await client.api("POST", "/admin/api/restart", { confirm: true })).status, 503);
    const state = await client.get("/admin/api/state");
    assert.equal(state.status, 200);
    assert.equal(state.json.maintenance, true);
    assert.ok(state.json.banners.some((b) => b.id === "maintenance"));
    assert.equal(state.json.job.type, "restore");
    assert.equal((await client.get("/admin/api/backup/stored")).status, 200);
    assert.equal((await client.get(`/admin/api/jobs/${accepted.json.job.id}`)).status, 200);

    hold.release();
    const job = await waitJob(accepted.json.job.id);
    assert.equal(job.status, "done");
    assert.equal(maintenanceMode.isActive(), false);
    const after = await client.api("POST", "/admin/api/backup/inspect", { uploadId: "0".repeat(32), passphrase: PASS });
    assert.equal(after.status, 404, "mutations are accepted again");
  });

  test("a damaged file fails the job with restore_failed and the phase; every table keeps its state", async () => {
    await boot();
    const file = await exportedFile();
    await db.Group.destroy({ where: {} });
    await db.Group.create({ jid: "keep@g.us", name: "keep" });
    const { restoreToken } = (await inspect(await uploadFile(file))).json;
    const before = await t.dumpTables();
    delete before.AuditLog;
    delete before.AdminSession; // touched by the requests themselves

    const stored = path.join(t.dataDir, "tmp", `restore-${restoreToken}.owb`);
    const bytes = fs.readFileSync(stored);
    bytes[bytes.length - 1] ^= 1; // the tag only
    fs.writeFileSync(stored, bytes);

    const accepted = await restore(restoreToken);
    assert.equal(accepted.status, 202);
    const job = await waitJob(accepted.json.job.id);
    assert.equal(job.status, "failed");
    assert.equal(job.error.code, "restore_failed");
    assert.deepEqual(job.error.params, { phase: "database", reason: "file_altered" });

    const after = await t.dumpTables();
    delete after.AuditLog;
    delete after.AdminSession;
    assert.deepEqual(after, before);
    assert.equal(maintenanceMode.isActive(), false);
    assert.equal(rt.restarts.length, 0);
    const rows = await auditRows("backup.restore");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, "fail");
    assert.deepEqual(JSON.parse(rows[0].detail), { phase: "database", reason: "file_altered" });
  });

  test("a restore job excludes other heavy jobs (409 busy) and a token cannot be used twice", async () => {
    await boot();
    const file = await exportedFile();
    const { restoreToken } = (await inspect(await uploadFile(file))).json;
    const hold = rt.holdRestart();
    const restartJob = await client.api("POST", "/admin/api/restart", { confirm: true });
    assert.equal(restartJob.status, 202);
    await fakes.waitFor(() => rt.restarts.length === 1);
    const blocked = await restore(restoreToken);
    assert.equal(blocked.status, 409);
    assert.equal(codeOf(blocked), "busy");
    hold.release();
    await waitJob(restartJob.json.job.id);

    const ok = await restore(restoreToken);
    assert.equal(ok.status, 202, "the token survived the refusal");
    await waitJob(ok.json.job.id);
    assert.equal(codeOf(await restore(restoreToken)), "restore_token_invalid");
  });
});

describe("BAK-4 and BAK-5: the pre-restore backups", () => {
  async function oneRestore() {
    const file = await exportedFile();
    const { restoreToken } = (await inspect(await uploadFile(file))).json;
    const accepted = await restore(restoreToken);
    return (await waitJob(accepted.json.job.id)).result.preRestoreFile;
  }

  test("listed newest first, downloadable, still encrypted by the passphrase", async () => {
    await boot();
    assert.deepEqual((await client.get("/admin/api/backup/stored")).json, { items: [] });
    const name = await oneRestore();
    const listed = await client.get("/admin/api/backup/stored");
    assert.equal(listed.status, 200);
    assert.equal(listed.json.items.length, 1);
    assert.deepEqual(Object.keys(listed.json.items[0]).sort(), ["createdAt", "kind", "name", "size"]);
    assert.equal(listed.json.items[0].name, name);
    assert.equal(listed.json.items[0].kind, "pre-restore");

    const download = await rawGet(`/admin/api/backup/stored/${name}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers["content-type"], "application/octet-stream");
    assert.equal(download.headers["content-disposition"], `attachment; filename="${name}"`);
    assert.equal(download.headers["cache-control"], "no-store");
    assert.deepEqual(download.buffer, fs.readFileSync(path.join(t.dataDir, "backups", name)));
    assert.equal(download.buffer.subarray(0, 10).toString("latin1"), "OWBBACKUP\n");
    const copy = path.join(root, "pre.owb");
    fs.writeFileSync(copy, download.buffer);
    assert.equal((await kit.readAll(copy, PASS))[0].t, "manifest");
  });

  test("only names of the pattern inside data/backups are served", async () => {
    await boot();
    await oneRestore();
    fs.writeFileSync(path.join(t.dataDir, "secret.txt"), "outside");
    fs.writeFileSync(path.join(t.dataDir, "backups", "notes.txt"), "not a backup");
    for (const name of [
      "pre-restore-absent.owb",
      "notes.txt",
      "restore.lock",
      "..%2Fsecret.txt",
      "pre-restore-..%2F..%2Fsecret.owb",
      `pre-restore-${"a".repeat(41)}.owb`,
      "pre-restore-x.owb%00.txt",
    ]) {
      const answer = await rawGet(`/admin/api/backup/stored/${name}`);
      assert.equal(answer.status, 404, name);
      assert.ok(!answer.text.includes("outside"));
    }
    // a symlink with a good name that points outside is refused
    fs.symlinkSync(path.join(t.dataDir, "secret.txt"), path.join(t.dataDir, "backups", "pre-restore-link.owb"));
    assert.equal((await rawGet("/admin/api/backup/stored/pre-restore-link.owb")).status, 404);
    const listed = (await client.get("/admin/api/backup/stored")).json.items.map((i) => i.name);
    assert.ok(!listed.includes("pre-restore-link.owb"));
  });

  test("the last 3 are kept", async () => {
    await boot();
    const names = [];
    for (let i = 0; i < 4; i += 1) {
      names.push(await oneRestore());
      t.clock.set(t.clock.now() + 1000);
    }
    const listed = (await client.get("/admin/api/backup/stored")).json.items.map((i) => i.name);
    assert.deepEqual(listed.sort(), names.slice(1).sort());
  });
});

describe("start-up: the interrupted restore", () => {
  test("a leftover restore.lock raises the restore_interrupted banner, once recovered; data/tmp is swept", async () => {
    await boot({
      beforeStart: async (admin) => {
        const backups = path.join(admin.dataDir, "backups");
        fs.mkdirSync(backups, { recursive: true });
        fs.writeFileSync(path.join(backups, "restore.lock"), JSON.stringify({ v: 1, phase: "database" }));
        fs.mkdirSync(path.join(admin.dataDir, "tmp"), { recursive: true });
        fs.writeFileSync(path.join(admin.dataDir, "tmp", "restore-leftover.owb"), "x");
      },
    });
    const state = await client.get("/admin/api/state");
    const banner = state.json.banners.find((b) => b.id === "restore_interrupted");
    assert.deepEqual(banner, { id: "restore_interrupted", severity: "error", params: {} });
    assert.equal(fs.existsSync(path.join(t.dataDir, "backups", "restore.lock")), false);
    assert.equal(fs.existsSync(path.join(t.dataDir, "tmp", "restore-leftover.owb")), false);
    assert.ok(t.logger.lines.some((l) => l.level === "warn" && JSON.stringify(l.args).includes("restore interrupted, previous state kept")));
  });

  test("no banner on a clean start", async () => {
    await boot();
    const state = await client.get("/admin/api/state");
    assert.ok(!state.json.banners.some((b) => b.id === "restore_interrupted"));
  });
});
