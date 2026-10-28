"use strict";
/**
 * Dashboard (US2, FR-012, FR-013): DASH-1 `GET /admin/api/state` (shape of admin-http-api.md 2.3, the banners of
 * 3.3 computed from their sources, the provider hook) and RST-1 `POST /admin/api/restart` (confirmation, job with
 * the phases stop / settings / start / ready, single flight, failure, audit). The real createAdmin with the real
 * authentication on an in-memory database; the bot runtime, the updater, the maintenance flag and the database
 * probe are stand-ins; the key file of the secret box lives in a temporary directory.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createTestAdmin } = require("./helpers/adminHarness");
const { createFakeRuntime } = require("./helpers/fakeBotRuntime");
const { createSettingsStore } = require("../lib/utils/settingsStore");
const { createSecretBox } = require("../lib/utils/secretBox");
const { getStateService } = require("../lib/admin/services/state");
const ring = require("../lib/admin/logs/ring");
const redactor = require("../lib/admin/logs/redactor");

const MINUTE = 60 * 1000;
const MEMORY = { rss: 120_000_000, heapUsed: 50_000_000, heapTotal: 80_000_000, external: 4_000_000, arrayBuffers: 1_000 };
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-dash-key-"));
const secretBox = createSecretBox({ dir: keyDir });

let t;
let client;
let rt;
let maintenance;

after(() => fs.rmSync(keyDir, { recursive: true, force: true }));

/** The admin on a fake runtime; extra `deps` and `config` replace the defaults. */
async function boot({ runtime, deps = {}, config } = {}) {
  ring.clear();
  rt = runtime || createFakeRuntime();
  maintenance = {
    active: false,
    reason: null,
    isActive() {
      return this.active;
    },
    getReason() {
      return this.reason;
    },
  };
  t = await createTestAdmin({
    config,
    deps: {
      runtime: rt,
      ring,
      memoryUsage: () => ({ ...MEMORY }),
      secretBox,
      dbProbe: async () => true,
      updater: { restartRequired: () => ({ required: false }) },
      maintenanceMode: maintenance,
      ...deps,
    },
  });
  await t.admin.start();
  client = await t.loginClient();
  return t;
}

afterEach(async () => {
  if (t) await t.close();
  t = null;
  for (const name of ["test:late", "test:early"]) redactor.unregister(name);
  fs.rmSync(path.join(keyDir, "panel.key"), { force: true });
});

const state = async (extra) => {
  const res = await client.get("/admin/api/state", extra);
  assert.equal(res.status, 200, res.text);
  return res.json;
};
const bannerIds = (body) => body.banners.map((b) => b.id);
const bannerOf = (body, id) => body.banners.find((b) => b.id === id);

/**
 * A settings store of its own (own environment, same database) so a test can plant invalid values. `rows` are
 * override rows that exist only while it loads: the process-wide store of the harness never sees them.
 */
async function makeStore({ env = {}, rows = [] } = {}) {
  const db = await fakes.syncDb();
  for (const row of rows) await db.SettingOverride.create(row);
  try {
    const store = createSettingsStore({ env, models: db, secretBox });
    await store.load();
    return store;
  } finally {
    for (const row of rows) await db.SettingOverride.destroy({ where: { key: row.key } });
  }
}

/** Make ALWAYS_ONLINE (a restart-effect setting) differ from the value in force; returns the cleanup. */
async function makeRestartPending(store) {
  const db = await fakes.syncDb();
  await db.SettingOverride.create({ key: "ALWAYS_ONLINE", value: String(!store.get("ALWAYS_ONLINE")), version: 1 });
  await store.reload();
  return () => db.SettingOverride.destroy({ where: { key: "ALWAYS_ONLINE" } });
}

async function jobDone(id) {
  const job = await fakes.waitFor(async () => {
    const res = await client.get(`/admin/api/jobs/${id}`);
    return res.status === 200 && res.json.job.status !== "running" ? res.json.job : null;
  });
  assert.ok(job, `job ${id} did not finish`);
  return job;
}

// ---------------------------------------------------------------------------
// DASH-1
// ---------------------------------------------------------------------------

describe("DASH-1 GET /admin/api/state", () => {
  test("the route is session-authenticated, touch:false and db:r; RST-1 is a guarded db:r mutation", async () => {
    await boot();
    const routes = t.admin.routes();
    const dash = routes.find((r) => r.method === "GET" && r.path === "/admin/api/state");
    assert.deepEqual({ auth: dash.auth, touch: dash.touch, db: dash.db, mutates: dash.mutates }, { auth: "session", touch: false, db: "optional", mutates: false });
    const restart = routes.find((r) => r.method === "POST" && r.path === "/admin/api/restart");
    assert.deepEqual({ auth: restart.auth, csrf: restart.csrf, db: restart.db, mutates: restart.mutates }, { auth: "session", csrf: true, db: "optional", mutates: true });
    const anonymous = await t.client().get("/admin/api/state");
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json.error.code, "unauthenticated");
  });

  test("the documented object, field by field", async () => {
    await boot();
    const body = await state();
    assert.deepEqual(Object.keys(body).sort(), ["at", "banners", "bot", "db", "errors", "job", "maintenance", "memory", "restartPending"]);
    assert.equal(body.at, new Date(t.clock.now()).toISOString());
    assert.deepEqual(body.bot, {
      status: "open",
      number: "237600000001",
      since: "2026-01-01T11:00:00.000Z",
      uptimeSec: 3725,
      version: "9.9.9-test",
      messagesProcessed: 42,
      lastActivity: "2026-01-01T11:59:30.000Z",
      registered: true,
    });
    assert.deepEqual(body.memory, { rss: MEMORY.rss, heapUsed: MEMORY.heapUsed, heapTotal: MEMORY.heapTotal, external: MEMORY.external });
    assert.deepEqual(body.errors, []);
    assert.deepEqual(body.restartPending, []);
    assert.deepEqual(body.banners, []);
    assert.equal(body.db, "ok");
    assert.equal(body.maintenance, false);
    assert.equal(body.job, null);
  });

  test("the process memory is read when no stand-in is given", async () => {
    await boot({ deps: { memoryUsage: undefined } });
    const body = await state();
    assert.deepEqual(Object.keys(body.memory), ["rss", "heapUsed", "heapTotal", "external"]);
    assert.ok(Object.values(body.memory).every((n) => Number.isInteger(n) && n > 0));
  });

  test("the bot number is digits only, or null", async () => {
    await boot();
    rt.status.me = { number: "237600000001@s.whatsapp.net", name: "Bot" };
    assert.equal((await state()).bot.number, "237600000001");
    rt.status.me = { number: "+237 6 00 00 00 01" };
    assert.equal((await state()).bot.number, "237600000001");
    rt.status.me = null;
    assert.equal((await state()).bot.number, null);
  });

  test("every client status is reported; a restart in progress reads `restarting`", async () => {
    await boot();
    for (const status of ["idle", "connecting", "qr", "open", "reconnecting", "stopped", "logged_out"]) {
      rt.status.status = status;
      assert.equal((await state()).bot.status, status);
    }
    rt.status.status = "open";
    rt.status.restarting = true;
    assert.equal((await state()).bot.status, "restarting");
    rt.status.restarting = false;
    rt.status.status = "something-new";
    assert.equal((await state()).bot.status, "idle", "an unknown status never reaches the client");
  });

  test("the payload copies nothing but the documented fields (no QR string, no pairing code)", async () => {
    await boot();
    const text = JSON.stringify(await state());
    assert.ok(!text.includes(rt.status.qr), "the QR string is not part of the state");
    assert.ok(!text.includes(rt.status.pairingCode), "the pairing code is not part of the state");
    assert.ok(!/"(qr|pairing|me|generation|lastClose)"/.test(text));
  });

  test("errors: the 10 newest entries of level error or above, newest first, with seq, ts, name and msg only", async () => {
    await boot();
    for (let i = 1; i <= 12; i += 1) {
      ring.push({ level: "error", name: "cmd", msg: `boom ${i}` });
      ring.push({ level: "info", name: "chatter", msg: `noise ${i}` });
    }
    ring.push({ level: "fatal", name: "core", msg: "fatal one" });
    ring.push({ level: "warn", name: "chatter", msg: "only a warning" });
    const body = await state();
    assert.equal(body.errors.length, 10);
    assert.deepEqual(body.errors.map((e) => e.msg), ["fatal one", ...[12, 11, 10, 9, 8, 7, 6, 5, 4].map((n) => `boom ${n}`)]);
    assert.deepEqual(Object.keys(body.errors[0]).sort(), ["msg", "name", "seq", "ts"]);
    assert.ok(body.errors.every((e, i, all) => i === 0 || e.seq < all[i - 1].seq), "newest first");
  });

  test("errors are scrubbed, also for a secret registered after the entry was logged", async () => {
    await boot();
    redactor.register("test:early", "sk-early-0123456789");
    ring.push({ level: "error", name: "svc", msg: "call failed with key sk-early-0123456789" });
    ring.push({ level: "error", name: "svc", msg: "call failed with key sk-late-0123456789" });
    redactor.register("test:late", "sk-late-0123456789");
    const text = JSON.stringify(await state());
    assert.ok(!text.includes("sk-early-0123456789"));
    assert.ok(!text.includes("sk-late-0123456789"), "scrubbed again when read");
    assert.ok(text.includes("[redacted]"));
  });

  test("it answers without the database: db is `unavailable`, with its banner, and a database route says `starting`", async () => {
    await boot();
    rt.dbReady = false;
    const body = await state();
    assert.equal(body.db, "unavailable");
    assert.ok(bannerIds(body).includes("db_unavailable"));
    const other = await client.get("/admin/api/audit");
    assert.equal(other.status, 503);
    assert.equal(other.json.error.code, "starting");
  });

  test("a probe that finds the database down gives the db_unavailable banner (severity error), and it clears", async () => {
    let alive = false;
    await boot({ deps: { dbProbe: async () => alive } });
    const down = await state();
    assert.equal(down.db, "unavailable");
    assert.deepEqual(bannerOf(down, "db_unavailable"), { id: "db_unavailable", severity: "error", params: {} });
    alive = true;
    const up = await state();
    assert.equal(up.db, "ok");
    assert.ok(!bannerIds(up).includes("db_unavailable"));
  });

  test("a probe that throws counts as down", async () => {
    await boot({
      deps: {
        dbProbe: async () => {
          throw new Error("SQLITE_BUSY");
        },
      },
    });
    assert.equal((await state()).db, "unavailable");
  });

  test("the default probe asks the database itself", async () => {
    await boot({ deps: { dbProbe: undefined } });
    assert.equal((await state()).db, "ok");
  });

  test("the running job and the maintenance flag are reported", async () => {
    await boot();
    const hold = rt.holdRestart();
    const res = await client.api("POST", "/admin/api/restart", { confirm: true });
    assert.equal(res.status, 202);
    const body = await state();
    assert.deepEqual(body.job, { id: res.json.job.id, type: "restart", status: "running", phase: body.job.phase });
    maintenance.active = true;
    maintenance.reason = "restore";
    assert.equal((await state()).maintenance, true);
    maintenance.active = false;
    hold.release();
    await jobDone(res.json.job.id);
    assert.equal((await state()).job, null);
  });
});

// ---------------------------------------------------------------------------
// The banners of admin-http-api.md 3.3
// ---------------------------------------------------------------------------

describe("banners", () => {
  test("a healthy bot has none; `no_https` is the browser's and never comes from the server", async () => {
    await boot();
    const body = await state();
    assert.deepEqual(body.banners, []);
    assert.ok(!JSON.stringify(body).includes("no_https"));
  });

  test("restart_needed: a restart-effect setting differs from the value in force (info, keys); restartPending lists them", async () => {
    const store = await makeStore();
    await boot({ deps: { settingsStore: store } });
    assert.deepEqual(bannerIds(await state()), []);
    const cleanup = await makeRestartPending(store);
    try {
      const body = await state();
      assert.deepEqual(body.restartPending, ["ALWAYS_ONLINE"]);
      assert.deepEqual(bannerOf(body, "restart_needed"), { id: "restart_needed", severity: "info", params: { keys: ["ALWAYS_ONLINE"] } });
      store.markInForce();
      assert.deepEqual(bannerIds(await state()), [], "cleared once the value is in force");
    } finally {
      await cleanup();
    }
  });

  test("invalid_file_values: invalid values of the file or environment replaced by defaults (warn, keys)", async () => {
    const store = await makeStore({ env: { MAX_UPLOAD: "not a number" } });
    await boot({ deps: { settingsStore: store } });
    assert.deepEqual(bannerOf(await state(), "invalid_file_values"), { id: "invalid_file_values", severity: "warn", params: { keys: ["MAX_UPLOAD"] } });
  });

  test("secret_key_lost: a stored secret that cannot be decrypted (error, keys)", async () => {
    const store = await makeStore({ rows: [{ key: "OPENAI_API_KEY", value: "enc:v1:AAAA:BBBB:CCCC", version: 1 }] });
    await boot({ deps: { settingsStore: store } });
    const body = await state();
    assert.deepEqual(bannerOf(body, "secret_key_lost"), { id: "secret_key_lost", severity: "error", params: { keys: ["OPENAI_API_KEY"] } });
    assert.ok(!JSON.stringify(body).includes("AAAA"), "nothing of the stored value leaves");
  });

  test("secret_key_lost: a key file that is not a key", async () => {
    fs.writeFileSync(path.join(keyDir, "panel.key"), "short");
    await boot();
    assert.deepEqual(bannerOf(await state(), "secret_key_lost"), { id: "secret_key_lost", severity: "error", params: { keys: [] } });
    fs.rmSync(path.join(keyDir, "panel.key"));
    assert.ok(!bannerIds(await state()).includes("secret_key_lost"), "no key file and no stored secret: nothing is lost");
  });

  test("no_owner: SUDO is empty (warn); a list with an owner clears it", async () => {
    await boot({ config: { SUDO: " , " } });
    assert.deepEqual(bannerOf(await state(), "no_owner"), { id: "no_owner", severity: "warn", params: {} });
    t.config.SUDO = "237600000001,237600000002";
    assert.ok(!bannerIds(await state()).includes("no_owner"));
    t.config.SUDO = ["237600000001"];
    assert.ok(!bannerIds(await state()).includes("no_owner"));
  });

  test("maintenance: a restore is applying (info, phase)", async () => {
    await boot();
    maintenance.active = true;
    maintenance.reason = "restore";
    assert.deepEqual(bannerOf(await state(), "maintenance"), { id: "maintenance", severity: "info", params: { phase: "restore" } });
    maintenance.active = false;
    assert.ok(!bannerIds(await state()).includes("maintenance"));
  });

  test("logged_out: the device was unlinked (warn); pairing again clears it", async () => {
    await boot();
    rt.status.status = "logged_out";
    assert.deepEqual(bannerOf(await state(), "logged_out"), { id: "logged_out", severity: "warn", params: {} });
    rt.status.status = "open";
    assert.ok(!bannerIds(await state()).includes("logged_out"));
  });

  test("update_restart: an update was applied and nothing restarts the process (warn, from, to)", async () => {
    let verdict = { required: true, from: "1.0.0", to: "1.1.0" };
    await boot({ deps: { updater: { restartRequired: () => verdict } } });
    assert.deepEqual(bannerOf(await state(), "update_restart"), { id: "update_restart", severity: "warn", params: { from: "1.0.0", to: "1.1.0" } });
    verdict = { required: false };
    assert.ok(!bannerIds(await state()).includes("update_restart"));
    verdict = null;
    assert.ok(!bannerIds(await state()).includes("update_restart"));
  });

  test("undeclared_proxy: forwarded headers from an undeclared peer (warn, header names); it fades, and a declared proxy never raises it", async () => {
    await boot();
    const first = await state({ headers: { "X-Forwarded-For": "203.0.113.9", "X-Forwarded-Proto": "https" } });
    assert.deepEqual(bannerOf(first, "undeclared_proxy"), { id: "undeclared_proxy", severity: "warn", params: { headers: ["x-forwarded-for", "x-forwarded-proto"] } });
    assert.ok(bannerIds(await state()).includes("undeclared_proxy"), "still reported on the next poll (and on the live stream)");
    await t.clock.advance(11 * MINUTE);
    assert.ok(!bannerIds(await state()).includes("undeclared_proxy"), "no sighting for ten minutes: gone");

    t.config.PANEL_TRUST_PROXY = "loopback";
    const declared = await state({ headers: { "X-Forwarded-For": "203.0.113.9" } });
    assert.ok(!bannerIds(declared).includes("undeclared_proxy"), "the peer is declared as a proxy");
  });

  test("addBannerProvider: other areas add their own (restore_interrupted...), sync or async, and can remove it", async () => {
    await boot();
    const service = getStateService(t.deps);
    assert.equal(typeof service.addBannerProvider, "function");
    assert.equal(t.deps.state, service, "the service is shared through deps.state");
    const remove = service.addBannerProvider(() => ({ id: "restore_interrupted", severity: "error", params: {} }));
    service.addBannerProvider(async () => [{ id: "extra_one", severity: "info", params: { n: 1 } }]);
    service.addBannerProvider(() => null);
    const body = await state();
    assert.deepEqual(bannerOf(body, "restore_interrupted"), { id: "restore_interrupted", severity: "error", params: {} });
    assert.deepEqual(bannerOf(body, "extra_one").params, { n: 1 });
    remove();
    assert.ok(!bannerIds(await state()).includes("restore_interrupted"));
  });

  test("a provider that throws, or returns rubbish, never breaks the state; a duplicate id appears once", async () => {
    await boot();
    const service = getStateService(t.deps);
    service.addBannerProvider(() => {
      throw new Error("provider bug");
    });
    service.addBannerProvider(async () => {
      throw new Error("async provider bug");
    });
    service.addBannerProvider(() => [{ nope: true }, { id: "x", severity: "loud" }, "text", 7, { id: "ok_one", severity: "warn" }]);
    service.addBannerProvider(() => ({ id: "ok_one", severity: "error", params: { second: true } }));
    const body = await state();
    const ids = bannerIds(body);
    assert.equal(ids.filter((id) => id === "ok_one").length, 1);
    assert.deepEqual(bannerOf(body, "ok_one"), { id: "ok_one", severity: "warn", params: {} }, "the first one wins; the params default to {}");
    assert.ok(!ids.includes("x") && !ids.includes(undefined));
    assert.throws(() => service.addBannerProvider("not a function"), /function/);
  });

  test("banners are ordered errors first, then warnings, then information", async () => {
    const store = await makeStore();
    await boot({ deps: { settingsStore: store, dbProbe: async () => false }, config: { SUDO: "" } });
    const cleanup = await makeRestartPending(store);
    try {
      rt.status.status = "logged_out";
      const ids = bannerIds(await state());
      assert.deepEqual(ids, ["db_unavailable", "no_owner", "logged_out", "restart_needed"]);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// RST-1
// ---------------------------------------------------------------------------

describe("RST-1 POST /admin/api/restart", () => {
  test("without the confirmation nothing happens: 409 confirmation_required", async () => {
    await boot();
    for (const body of [{}, { confirm: false }]) {
      const res = await client.api("POST", "/admin/api/restart", body);
      assert.equal(res.status, 409);
      assert.equal(res.json.error.code, "confirmation_required");
      assert.equal(res.json.error.params.confirm, "restart");
    }
    assert.equal(rt.restarts.length, 0);
    assert.equal(await t.db.AuditLog.count({ where: { action: "restart" } }), 0);
  });

  test("an unknown property is a validation error; a missing CSRF token or session is refused; nothing runs", async () => {
    await boot();
    const unknown = await client.api("POST", "/admin/api/restart", { confirm: true, now: true });
    assert.equal(unknown.status, 422);
    assert.deepEqual(unknown.json.error.fields.$unknown, { code: "unknown_field" });
    const noToken = await client.api("POST", "/admin/api/restart", { confirm: true }, { headers: { "X-CSRF-Token": null } });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.json.error.code, "csrf_invalid");
    const stranger = await t.client().api("POST", "/admin/api/restart", { confirm: true });
    assert.equal(stranger.status, 401);
    assert.equal(rt.restarts.length, 0);
  });

  test("confirmed: 202 with a restart job; the phases are stop, settings, start, ready; the job ends done", async () => {
    await boot();
    const phases = [];
    t.hub.subscribe("job", (job) => {
      if (job.type === "restart" && job.phase && phases[phases.length - 1] !== job.phase) phases.push(job.phase);
    });
    const res = await client.api("POST", "/admin/api/restart", { confirm: true });
    assert.equal(res.status, 202);
    assert.deepEqual(Object.keys(res.json.job).sort(), ["error", "finishedAt", "id", "phase", "progress", "result", "startedAt", "status", "type"]);
    assert.equal(res.json.job.type, "restart");
    assert.equal(res.json.job.status, "running");
    const job = await jobDone(res.json.job.id);
    assert.equal(job.status, "done");
    assert.equal(job.error, null);
    assert.equal(job.result.ok, true);
    assert.deepEqual(phases, ["stop", "settings", "start", "ready"]);
    assert.equal(job.phase, "ready");
    assert.equal(rt.restarts.length, 1);
    assert.equal(rt.restarts[0].actor, "panel");
  });

  test("audit: one `restart` row, result ok, no target, the request origin", async () => {
    await boot();
    const res = await client.api("POST", "/admin/api/restart", { confirm: true });
    await jobDone(res.json.job.id);
    const rows = await t.db.AuditLog.findAll({ where: { action: "restart" }, raw: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, "ok");
    assert.equal(rows[0].target, null);
    assert.ok(rows[0].origin, "the throttling origin of the request");
  });

  test("single flight: a second restart while one runs is 409 busy, and again possible afterwards", async () => {
    await boot();
    const hold = rt.holdRestart();
    const first = await client.api("POST", "/admin/api/restart", { confirm: true });
    assert.equal(first.status, 202);
    const second = await client.api("POST", "/admin/api/restart", { confirm: true });
    assert.equal(second.status, 409);
    assert.equal(second.json.error.code, "busy");
    assert.equal(rt.restarts.length, 1);
    assert.equal(await t.db.AuditLog.count({ where: { action: "restart" } }), 1, "a refused request is not audited");
    hold.release();
    await jobDone(first.json.job.id);
    rt.restartImpl = null;
    const third = await client.api("POST", "/admin/api/restart", { confirm: true });
    assert.equal(third.status, 202);
    await jobDone(third.json.job.id);
  });

  test("a restart that does not come back fails the job with restart_failed (reason timeout) and is audited as a failure", async () => {
    await boot();
    rt.restartImpl = async () => ({ ok: false, code: "timeout", status: "disconnected" });
    const res = await client.api("POST", "/admin/api/restart", { confirm: true });
    assert.equal(res.status, 202);
    const job = await jobDone(res.json.job.id);
    assert.equal(job.status, "failed");
    assert.deepEqual(job.error, { code: "restart_failed", params: { reason: "timeout" } });
    const failed = await fakes.waitFor(async () => (await t.db.AuditLog.findAll({ where: { action: "restart", result: "fail" }, raw: true }))[0]);
    assert.ok(failed, "a failure row follows the accepted one");
    assert.deepEqual(JSON.parse(failed.detail), { reason: "timeout" });
  });

  test("a restart that throws fails the job with restart_failed and leaks no message", async () => {
    await boot();
    rt.restartImpl = async () => {
      throw new Error("secret detail sk-should-never-leave");
    };
    const res = await client.api("POST", "/admin/api/restart", { confirm: true });
    const job = await jobDone(res.json.job.id);
    assert.equal(job.status, "failed");
    assert.equal(job.error.code, "restart_failed");
    assert.ok(!JSON.stringify(job).includes("sk-should-never-leave"));
  });

  test("a restart is not available without a runtime that can restart", async () => {
    await boot({ runtime: { dbReady: true, events: createFakeRuntime().events, getStatus: () => ({ status: "open" }) } });
    const res = await client.api("POST", "/admin/api/restart", { confirm: true });
    assert.equal(res.status, 202);
    const job = await jobDone(res.json.job.id);
    assert.equal(job.error.code, "restart_failed");
  });

  test("it works while the database is still starting (db:r) and is refused during a restore (maintenance)", async () => {
    await boot();
    rt.dbReady = false;
    const res = await client.api("POST", "/admin/api/restart", { confirm: true });
    assert.equal(res.status, 202);
    await jobDone(res.json.job.id);
    maintenance.active = true;
    const refused = await client.api("POST", "/admin/api/restart", { confirm: true });
    assert.equal(refused.status, 503);
    assert.equal(refused.json.error.code, "maintenance");
    maintenance.active = false;
  });

  test("the job is also published on the live stream topic `job` with the state forced out", async () => {
    await boot();
    const jobs = [];
    const states = [];
    t.hub.subscribe("job", (job) => jobs.push(job));
    t.hub.subscribe("state", (s) => states.push(s));
    const res = await client.api("POST", "/admin/api/restart", { confirm: true });
    await jobDone(res.json.job.id);
    assert.ok(jobs.length >= 5, "start, four phases and the end");
    assert.equal(jobs[jobs.length - 1].status, "done");
    assert.ok(states.some((s) => s.job && s.job.type === "restart"), "a state event carried the running job");
  });
});
