"use strict";
/**
 * AUD-1 `GET /admin/api/audit` (US7, FR-036): the history of administration actions, newest first, with the
 * filters `action` (prefix), `result` (ok, fail, refused), `from` / `to`, pagination (pageSize at most 200), a
 * sanitised `detail`. Rows produced by the other routes (setup, login, password change, restart...) hold no secret.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createTestAdmin } = require("./helpers/adminHarness");
const { createFakeRuntime } = require("./helpers/fakeBotRuntime");
const redactor = require("../lib/admin/logs/redactor");

const HOUR = 60 * 60 * 1000;
const PASSWORD = "a long enough password";

let t;
let client;
let rt;

async function boot() {
  rt = createFakeRuntime();
  t = await createTestAdmin({ deps: { runtime: rt, dbProbe: async () => true } });
  await t.admin.start();
  client = await t.loginClient(PASSWORD);
  await t.db.AuditLog.destroy({ where: {}, truncate: true }); // the setup row is not what these tests look at
}

afterEach(async () => {
  if (t) await t.close();
  t = null;
  redactor.unregister("test:audit");
});

const audit = async (query = "") => client.get(`/admin/api/audit${query ? `?${query}` : ""}`);
const actions = (res) => res.json.items.map((i) => i.action);

/** Rows at known instants, newest last in time: a (T-5h) ... */
async function seedRows() {
  const base = t.clock.now();
  const at = (hoursAgo) => base - hoursAgo * HOUR;
  const rows = [
    { action: "login.success", target: null, origin: "10.0.0.1", result: "ok", at: at(6) },
    { action: "login.failure", target: null, origin: "10.0.0.2", result: "fail", at: at(5) },
    { action: "login.blocked", target: null, origin: "10.0.0.2", result: "refused", at: at(4) },
    { action: "setting.update", target: "PREFIX", origin: "10.0.0.1", result: "ok", detail: { from: ".", to: "!" }, at: at(3) },
    { action: "setting.reset", target: "TIMEZONE", origin: "10.0.0.1", result: "ok", detail: { from: "UTC", to: "Africa/Douala" }, at: at(2) },
    { action: "restart", target: null, origin: "10.0.0.1", result: "ok", at: at(1) },
  ];
  for (const row of rows) await t.audit.record(row);
  return rows;
}

describe("AUD-1", () => {
  beforeEach(boot);

  test("a touching, database-backed GET for a session", async () => {
    const route = t.admin.routes().find((r) => r.path === "/admin/api/audit");
    assert.deepEqual({ method: route.method, auth: route.auth, touch: route.touch, db: route.db, mutates: route.mutates }, { method: "GET", auth: "session", touch: true, db: null, mutates: false });
    assert.equal((await t.client().get("/admin/api/audit")).status, 401);
    rt.dbReady = false;
    const early = await audit();
    assert.equal(early.status, 503);
    assert.equal(early.json.error.code, "starting");
  });

  test("an empty history answers { items: [], page: 1, pageSize: 50, total: 0 }", async () => {
    const res = await audit();
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { items: [], page: 1, pageSize: 50, total: 0 });
  });

  test("items are { id, at, action, target, origin, result, detail }, newest first", async () => {
    await seedRows();
    const res = await audit();
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ["items", "page", "pageSize", "total"]);
    assert.equal(res.json.total, 6);
    assert.deepEqual(actions(res), ["restart", "setting.reset", "setting.update", "login.blocked", "login.failure", "login.success"]);
    const update = res.json.items.find((i) => i.action === "setting.update");
    assert.deepEqual(Object.keys(update), ["id", "at", "action", "target", "origin", "result", "detail"]);
    assert.equal(update.target, "PREFIX");
    assert.equal(update.origin, "10.0.0.1");
    assert.deepEqual(update.detail, { from: ".", to: "!" });
    assert.match(update.at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    assert.equal(Number.isInteger(update.id), true);
    const restart = res.json.items[0];
    assert.equal(restart.target, null);
    assert.equal(restart.detail, null);
  });

  test("action is a prefix: `login` matches the three login events, `setting.update` only itself", async () => {
    await seedRows();
    assert.deepEqual(actions(await audit("action=login")).sort(), ["login.blocked", "login.failure", "login.success"]);
    assert.deepEqual(actions(await audit("action=setting")), ["setting.reset", "setting.update"]);
    assert.deepEqual(actions(await audit("action=setting.update")), ["setting.update"]);
    assert.deepEqual(actions(await audit("action=restart")), ["restart"]);
    assert.deepEqual(actions(await audit("action=nothing")), []);
    const none = await audit("action=nothing");
    assert.equal(none.json.total, 0);
  });

  test("a prefix is not a pattern: wildcards and uppercase are refused, never interpreted", async () => {
    await seedRows();
    for (const bad of ["%25", "login%25", "_", "Login", "a b", "a;b", "x".repeat(49)]) {
      const res = await audit(`action=${bad}`);
      assert.equal(res.status, 422, bad);
      assert.equal(res.json.error.fields.action.code, "invalid_format", bad);
    }
  });

  test("result: ok, fail or refused (a refused action reads `refused` in the answer too)", async () => {
    await seedRows();
    assert.deepEqual(actions(await audit("result=ok")), ["restart", "setting.reset", "setting.update", "login.success"]);
    assert.deepEqual(actions(await audit("result=fail")), ["login.failure"]);
    const refused = await audit("result=refused");
    assert.deepEqual(actions(refused), ["login.blocked"]);
    assert.equal(refused.json.items[0].result, "refused");
    assert.equal((await audit("result=blocked")).status, 422, "the storage word is not part of the API");
    assert.equal((await audit("result=maybe")).status, 422);
  });

  test("from and to are ISO instants, inclusive", async () => {
    const rows = await seedRows();
    const iso = (ms) => new Date(ms).toISOString();
    const from = await audit(`from=${encodeURIComponent(iso(rows[3].at))}`);
    assert.deepEqual(actions(from), ["restart", "setting.reset", "setting.update"], "from the 4th row on, the 4th included");
    const to = await audit(`to=${encodeURIComponent(iso(rows[2].at))}`);
    assert.deepEqual(actions(to), ["login.blocked", "login.failure", "login.success"]);
    const window = await audit(`from=${encodeURIComponent(iso(rows[1].at))}&to=${encodeURIComponent(iso(rows[3].at))}`);
    assert.deepEqual(actions(window), ["setting.update", "login.blocked", "login.failure"]);
    const day = await audit(`from=${encodeURIComponent(iso(rows[0].at).slice(0, 10))}`);
    assert.equal(day.status, 200, "a plain date is an instant too");
    const combined = await audit(`action=login&result=fail&from=${encodeURIComponent(iso(rows[0].at))}`);
    assert.deepEqual(actions(combined), ["login.failure"]);
  });

  test("a malformed date is a validation error and echoes nothing", async () => {
    for (const bad of ["yesterday", "2026-13-45", "12", "2026-01-01T99:00:00Z", "<script>"]) {
      const res = await audit(`from=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 422, bad);
      assert.equal(res.json.error.fields.from.code, "invalid_format", bad);
      assert.ok(!res.text.includes("script"));
    }
    assert.equal((await audit("to=nope")).json.error.fields.to.code, "invalid_format");
  });

  test("pagination: page and pageSize, total stays the whole count, a page past the end is empty", async () => {
    await seedRows();
    const first = await audit("pageSize=4");
    assert.deepEqual([first.json.page, first.json.pageSize, first.json.total, first.json.items.length], [1, 4, 6, 4]);
    const second = await audit("pageSize=4&page=2");
    assert.deepEqual([second.json.page, second.json.items.length], [2, 2]);
    assert.deepEqual([...actions(first), ...actions(second)], ["restart", "setting.reset", "setting.update", "login.blocked", "login.failure", "login.success"]);
    const past = await audit("pageSize=4&page=9");
    assert.deepEqual([past.json.items.length, past.json.total], [0, 6]);
  });

  test("pageSize is at most 200, page starts at 1, and nothing else is accepted", async () => {
    assert.equal((await audit("pageSize=200")).status, 200);
    for (const bad of ["201", "0", "-5", "abc", "1.5"]) {
      const res = await audit(`pageSize=${bad}`);
      assert.equal(res.status, 422, bad);
      assert.ok(["out_of_range", "invalid_format"].includes(res.json.error.fields.pageSize.code), bad);
    }
    const tooBig = await audit("pageSize=201");
    assert.deepEqual(tooBig.json.error.fields.pageSize, { code: "out_of_range", params: { min: 1, max: 200 } });
    for (const bad of ["0", "-1", "x"]) assert.equal((await audit(`page=${bad}`)).status, 422, `page=${bad}`);
    const unknown = await audit("sort=asc");
    assert.equal(unknown.status, 422);
    assert.deepEqual(unknown.json.error.fields.$unknown, { code: "unknown_field" });
  });

  test("the default page size is 50", async () => {
    for (let i = 0; i < 55; i += 1) await t.audit.record({ action: "restart", target: null, origin: "x", result: "ok", at: t.clock.now() - i });
    const res = await audit();
    assert.equal(res.json.items.length, 50);
    assert.equal(res.json.total, 55);
    assert.equal(res.json.pageSize, 50);
  });

  test("detail is sanitised: a secret is redacted, also when it was registered after the row was written", async () => {
    await t.audit.record({ action: "setting.update", target: "OPENAI_API_KEY", origin: "x", result: "ok", detail: { secret: true, op: "set" } });
    await t.audit.record({ action: "setting.test", target: "openai", origin: "x", result: "fail", detail: { note: "key sk-audit-0123456789abcdef was refused", list: ["sk-audit-0123456789abcdef"] } });
    redactor.register("test:audit", "sk-audit-0123456789abcdef");
    await t.audit.record({ action: "setting.test", target: "openai", origin: "x", result: "fail", detail: { note: "again sk-audit-0123456789abcdef" } });
    const res = await audit("action=setting");
    assert.equal(res.json.total, 3);
    assert.ok(!res.text.includes("sk-audit-0123456789abcdef"));
    assert.deepEqual(res.json.items.find((i) => i.target === "OPENAI_API_KEY").detail, { secret: true, op: "set" });
    assert.ok(res.text.includes("[redacted]"));
  });

  test("no secret in any row produced by the other routes (setup, login, password change, restart, preferences)", async () => {
    const secrets = ["a wrong password nobody should log", "brand new strong password!", PASSWORD];
    // a failed login, from another browser
    const stranger = t.client();
    const failed = await stranger.login(secrets[0]);
    assert.equal(failed.status, 401);
    // preferences and a password change
    assert.equal((await client.api("PATCH", "/admin/api/account/preferences", { theme: "dark" })).status, 200);
    const changed = await client.api("PATCH", "/admin/api/account/password", { currentPassword: PASSWORD, newPassword: secrets[1] });
    assert.equal(changed.status, 200, changed.text);
    // the restart
    const restart = await client.api("POST", "/admin/api/restart", { confirm: true });
    assert.equal(restart.status, 202);
    await fakes.waitFor(async () => (await client.get(`/admin/api/jobs/${restart.json.job.id}`)).json.job.status !== "running");

    const res = await audit("pageSize=200");
    assert.equal(res.status, 200);
    const seen = new Set(actions(res));
    for (const expected of ["login.failure", "account.update", "restart"]) assert.ok(seen.has(expected), `${expected} is in the history`);
    for (const secret of secrets) assert.ok(!res.text.includes(secret), "no password in the history");
    for (const item of res.json.items) {
      assert.ok(typeof item.origin === "string" && item.origin.length > 0 && item.origin.length <= 64, "the origin is an address, nothing else");
      assert.ok(!/csrf|cookie|token/i.test(JSON.stringify(item.detail) || ""), "no credential in a detail");
    }
  });

  test("the history does not change when it is read, and it does not need the session to be touched twice", async () => {
    await seedRows();
    const before = JSON.stringify((await audit()).json);
    const after = JSON.stringify((await audit()).json);
    assert.equal(before, after);
  });
});
