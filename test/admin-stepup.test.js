"use strict";
/**
 * Step-up re-authentication (feature 004, contracts/admin-api.md 1.5, AUTH-7 of section 2, research.md X8 and Y8):
 * the 5-minute confirmation window in the in-memory session cache, the `requireRecent` gate, the router option
 * `stepUp` (`true` and `"conditional"`) and `POST /admin/api/session/reauth`.
 *
 * Offline: in-memory SQLite, a fake clock, a very low scrypt cost, the real createAdmin on 127.0.0.1:0, two test
 * routes (`/admin/api/t/gated`, `/admin/api/t/maybe`) registered next to the real ones.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createTestAdmin } = require("./helpers/adminHarness");
const sessionsModule = require("../lib/admin/auth/sessions");
const { AdminError } = require("../lib/admin/http/response");

const PASSWORD = "correct horse battery";
const OTHER = "another long password!";
const MINUTE = 60 * 1000;
const WINDOW = 5 * MINUTE;

let t;
let calls;

function testRoutes({ router }) {
  router.route({
    method: "POST",
    path: "/admin/api/t/gated",
    auth: "session",
    stepUp: true,
    schema: { name: { type: "string", required: true, maxLength: 10 } },
    handler: async (ctx) => {
      calls.gated += 1;
      await ctx.audit("restart", ctx.body.name, "ok"); // a table row: proves a refused call writes nothing
      return { ok: true };
    },
  });
  router.route({
    method: "POST",
    path: "/admin/api/t/maybe",
    auth: "session",
    stepUp: "conditional",
    schema: { widen: { type: "boolean" } },
    handler: async (ctx) => {
      if (ctx.body.widen) ctx.stepUp(["rights", "expiry"]);
      calls.maybe += 1;
      return { ok: true };
    },
  });
  router.route({
    method: "POST",
    path: "/admin/api/t/plain",
    auth: "session",
    handler: async (ctx) => {
      ctx.stepUp(["rights"]);
      return { ok: true };
    },
  });
}

async function boot(opts = {}) {
  calls = { gated: 0, maybe: 0 };
  t = await createTestAdmin({ extraRoutes: [testRoutes], ...opts });
  await t.admin.start();
}

/** Create the account through the printed link: returns the logged-in client (the setup opens a session). */
async function setUp(password = PASSWORD) {
  const client = t.client();
  const { answer } = await client.setup(password, { token: t.lastLink().token });
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  return client;
}

async function loggedIn(password = PASSWORD) {
  const client = t.client();
  const answer = await client.login(password);
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  return client;
}

const gated = (c, name = "a") => c.api("POST", "/admin/api/t/gated", { name });
const maybe = (c, widen) => c.api("POST", "/admin/api/t/maybe", { widen });
const reauth = (c, password) => c.api("POST", "/admin/api/session/reauth", { password });
const rows = (where = {}) => t.db.AuditLog.findAll({ where, raw: true, order: [["id", "ASC"]] });
const sessionOf = (c) => t.auth.sessions.resolve(c.cookie("owb_sid"));

afterEach(async () => {
  if (t) await t.close();
  t = null;
});

// ---------------------------------------------------------------------------
// The window in the session cache (sessions.js)
// ---------------------------------------------------------------------------

describe("sessions: confirmedAt", () => {
  beforeEach(async () => {
    await boot();
  });

  test("STEP_UP_MS is 5 minutes and is exported", () => {
    assert.equal(sessionsModule.STEP_UP_MS, 300000);
  });

  test("a login starts the window: confirmedAt is the creation time, recent for 299 999 ms and no more", async () => {
    await setUp();
    const started = t.clock.now();
    const c = await loggedIn();
    const session = await sessionOf(c);
    assert.equal(session.confirmedAt, started, "snapshot() exposes confirmedAt");
    const { sessions } = t.auth;
    assert.equal(sessions.isRecent(session, started + WINDOW - 1), true);
    assert.equal(sessions.isRecent(session, started + WINDOW), false);
    assert.equal(sessions.isRecent(session, started), true);
  });

  test("the session opened by the setup, by a password change and by a reset also start the window", async () => {
    const first = await setUp();
    assert.equal((await sessionOf(first)).confirmedAt, t.clock.now(), "setup");

    await t.clock.advance(7 * MINUTE);
    const changed = await first.api("PATCH", "/admin/api/account/password", { currentPassword: PASSWORD, newPassword: OTHER });
    assert.equal(changed.status, 200);
    assert.equal((await sessionOf(first)).confirmedAt, t.clock.now(), "password change (rotation)");

    await t.clock.advance(7 * MINUTE);
    const link = await t.auth.issueLink("reset");
    const other = t.client();
    const { answer } = await other.setup("a brand new password!", { token: link.token });
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    assert.equal((await sessionOf(other)).confirmedAt, t.clock.now(), "password reset");
  });

  test("isRecent: never confirmed (0), no session and an old value are not recent", () => {
    const { sessions } = t.auth;
    assert.equal(sessions.isRecent({ confirmedAt: 0 }, 1000), false);
    assert.equal(sessions.isRecent(null, 1000), false);
    assert.equal(sessions.isRecent({}, 1000), false);
    assert.equal(sessions.isRecent({ confirmedAt: 1000 }, 1000 + WINDOW - 1), true);
    assert.equal(sessions.isRecent({ confirmedAt: 1000 }, 1000 + WINDOW), false);
  });

  test("confirm(id, at) renews the window of that session only and returns confirmedAt", async () => {
    await setUp();
    const a = await loggedIn();
    const b = await loggedIn();
    await t.clock.advance(WINDOW + MINUTE);
    const sessionA = await sessionOf(a);
    const at = t.clock.now();
    assert.equal(t.auth.sessions.isRecent(sessionA, at), false);
    assert.equal(t.auth.sessions.confirm(sessionA.id, at), at);
    assert.equal(t.auth.sessions.isRecent(await sessionOf(a), at), true, "A is confirmed");
    assert.equal(t.auth.sessions.isRecent(await sessionOf(b), at), false, "another session id is not");
    assert.equal(t.auth.sessions.confirm("unknown-session-id", at), 0, "an unknown id confirms nothing");
  });

  test("the window survives the 60 s refresh from the database (entryFromRow keeps it)", async () => {
    await setUp();
    const c = await loggedIn();
    const confirmedAt = (await sessionOf(c)).confirmedAt;
    await t.clock.advance(61 * 1000); // CACHE_TTL_MS: the next resolve re-reads the row
    const again = await sessionOf(c);
    assert.equal(again.confirmedAt, confirmedAt);
    assert.equal(t.auth.sessions.isRecent(again, t.clock.now()), true);
  });

  test("lost with clearCache() (a rebuilt entry has no confirmation), logout, destroyAll and expiry", async () => {
    await setUp();
    const c = await loggedIn();
    const value = c.cookie("owb_sid");
    t.auth.sessions.clearCache();
    const rebuilt = await t.auth.sessions.resolve(value);
    assert.equal(rebuilt.confirmedAt, 0, "the safe direction: asked again");
    assert.equal(t.auth.sessions.isRecent(rebuilt, t.clock.now()), false);

    const d = await loggedIn();
    const dValue = d.cookie("owb_sid"); // the jar forgets the cookie when the logout clears it
    assert.equal((await d.api("POST", "/admin/api/logout", {})).status, 200);
    await assert.rejects(() => t.auth.sessions.resolve(dValue), (err) => err.code === "session_expired");

    const e = await loggedIn();
    const ids = await t.auth.sessions.destroyAll({});
    t.auth.sessions.forget(ids);
    await assert.rejects(() => t.auth.sessions.resolve(e.cookie("owb_sid")), (err) => err.code === "session_expired");

    const f = await loggedIn();
    await t.clock.advance(25 * 60 * MINUTE); // idle expiry
    await assert.rejects(() => t.auth.sessions.resolve(f.cookie("owb_sid")), (err) => err.code === "session_expired");
  });
});

// ---------------------------------------------------------------------------
// The gate (auth.requireRecent)
// ---------------------------------------------------------------------------

describe("auth.requireRecent", () => {
  beforeEach(async () => {
    await boot();
  });

  test("passes inside the window, throws password_required (403) with windowMs outside", async () => {
    await setUp();
    const c = await loggedIn();
    const session = await sessionOf(c);
    assert.doesNotThrow(() => t.auth.requireRecent(session, session.confirmedAt + WINDOW - 1));
    let caught = null;
    try {
      t.auth.requireRecent(session, session.confirmedAt + WINDOW);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof AdminError);
    assert.equal(caught.code, "password_required");
    assert.deepEqual(caught.params, { windowMs: 300000 });
    assert.equal(require("../lib/admin/http/response").toHttpError(caught).status, 403);
  });

  test("a session that was never confirmed, or none at all, is refused", () => {
    assert.throws(() => t.auth.requireRecent({ id: "x", confirmedAt: 0 }, Date.now()), (err) => err.code === "password_required");
    assert.throws(() => t.auth.requireRecent(null, Date.now()), (err) => err.code === "password_required");
  });
});

// ---------------------------------------------------------------------------
// The router options over the real authentication
// ---------------------------------------------------------------------------

describe("stepUp routes", () => {
  beforeEach(async () => {
    await boot();
  });

  test("a true route asks nothing within 5 minutes of the login and asks after", async () => {
    await setUp();
    await t.clock.advance(10 * MINUTE);
    const c = await loggedIn();
    assert.equal((await gated(c)).status, 200, "right after the login");
    await t.clock.advance(WINDOW - 1);
    assert.equal((await gated(c)).status, 200, "299 999 ms after the login");
    await t.clock.advance(1);
    const asked = await gated(c);
    assert.equal(asked.status, 403, "300 000 ms after the login");
    assert.equal(asked.json.error.code, "password_required");
    assert.deepEqual(asked.json.error.params, { windowMs: 300000 });
    assert.equal(calls.gated, 2);
  });

  test("a true route unconfirmed saves nothing, and a 422 body is never asked for a password", async () => {
    await setUp();
    const c = await loggedIn();
    await t.clock.advance(WINDOW + MINUTE);
    const before = await t.dumpTables();
    const refused = await gated(c);
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error.code, "password_required");
    assert.equal(calls.gated, 0);
    assert.deepEqual(await t.dumpTables(), before, "no table changed");

    const invalid = await c.api("POST", "/admin/api/t/gated", { name: "x".repeat(50) });
    assert.equal(invalid.status, 422, "validation comes before the password");
    assert.equal(invalid.json.error.code, "validation_failed");
  });

  test("reauth renews the window: valid at +299 999 ms, 403 at +300 000 ms, for that session only", async () => {
    await setUp();
    const a = await loggedIn();
    const b = await loggedIn();
    await t.clock.advance(WINDOW + MINUTE);
    assert.equal((await gated(a)).status, 403);
    assert.equal((await gated(b)).status, 403);

    const ok = await reauth(a, PASSWORD);
    assert.equal(ok.status, 200);
    const confirmedAt = t.clock.now();
    assert.deepEqual(Object.keys(ok.json).sort(), ["confirmedUntil", "windowMs"]);
    assert.equal(ok.json.windowMs, 300000);
    assert.equal(Date.parse(ok.json.confirmedUntil), confirmedAt + WINDOW);

    assert.equal((await gated(a)).status, 200);
    assert.equal((await gated(b)).status, 403, "another browser is not confirmed");
    await t.clock.advance(WINDOW - 1);
    assert.equal((await gated(a)).status, 200, "+299 999 ms");
    await t.clock.advance(1);
    assert.equal((await gated(a)).status, 403, "+300 000 ms");
  });

  test("a confirmation is not consumed by use", async () => {
    await setUp();
    const c = await loggedIn();
    for (let i = 0; i < 4; i += 1) assert.equal((await gated(c)).status, 200);
    assert.equal(calls.gated, 4);
  });

  test("a conditional route asks only when the handler calls ctx.stepUp(reasons), with the reasons in the error", async () => {
    await setUp();
    const c = await loggedIn();
    await t.clock.advance(WINDOW + MINUTE);
    assert.equal((await maybe(c, false)).status, 200, "nothing widened, nothing asked");
    const asked = await maybe(c, true);
    assert.equal(asked.status, 403);
    assert.deepEqual(asked.json.error, { code: "password_required", params: { windowMs: 300000, reasons: ["rights", "expiry"] }, requestId: asked.json.error.requestId });
    assert.equal(calls.maybe, 1);
    await reauth(c, PASSWORD);
    assert.equal((await maybe(c, true)).status, 200);
  });

  test("ctx.stepUp on a route without the option is a programming error: a logged 500, never a prompt", async () => {
    await setUp();
    const c = await loggedIn();
    const res = await c.api("POST", "/admin/api/t/plain", {});
    assert.equal(res.status, 500);
    assert.equal(res.json.error.code, "internal_error");
  });

  test("a restart (a rebuilt cache) asks again", async () => {
    await setUp();
    const c = await loggedIn();
    assert.equal((await gated(c)).status, 200);
    t.auth.sessions.clearCache();
    assert.equal((await gated(c)).status, 403);
    assert.equal((await reauth(c, PASSWORD)).status, 200);
    assert.equal((await gated(c)).status, 200);
  });
});

// ---------------------------------------------------------------------------
// AUTH-7
// ---------------------------------------------------------------------------

describe("AUTH-7 POST /admin/api/session/reauth", () => {
  beforeEach(async () => {
    await boot();
  });

  test("happy path: 200, audit account.confirm ok with the origin as target and no detail", async () => {
    await setUp();
    const c = await loggedIn();
    const res = await reauth(c, PASSWORD);
    assert.equal(res.status, 200);
    const audited = await rows({ action: "account.confirm" });
    assert.equal(audited.length, 1);
    assert.equal(audited[0].result, "ok");
    assert.equal(audited[0].target, audited[0].origin);
    assert.equal(audited[0].detail, null);
    assert.ok(!JSON.stringify(await rows()).includes(PASSWORD));
  });

  test("a wrong password is a 422 wrong_password, never a 401; audit fail; nothing confirmed; the session stays", async () => {
    await setUp();
    const c = await loggedIn();
    await t.clock.advance(WINDOW + MINUTE);
    const res = await reauth(c, "not the password!");
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, "validation_failed");
    assert.deepEqual(res.json.error.fields, { password: { code: "wrong_password" } });
    assert.ok(!JSON.stringify(res.json).includes("not the password"));
    assert.equal((await gated(c)).status, 403, "still not confirmed");
    assert.equal((await c.get("/admin/api/jobs/1")).json.error.code, "not_found", "the session is untouched");
    const audited = await rows({ action: "account.confirm" });
    assert.deepEqual(audited.map((row) => row.result), ["fail"]);
  });

  test("five failures, then 429 rate_limited even with the right password; one blocked row, none during the block", async () => {
    await setUp();
    const c = await loggedIn();
    for (let i = 0; i < 5; i += 1) assert.equal((await reauth(c, `wrong guess number ${i}`)).status, 422);
    const blocked = await reauth(c, PASSWORD);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error.code, "rate_limited");
    assert.ok(blocked.json.error.params.retryAfterMs > 0);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    assert.equal((await reauth(c, "wrong once more!!")).status, 429);

    const audited = await rows({ action: "account.confirm" });
    assert.deepEqual(audited.map((row) => row.result), ["fail", "fail", "fail", "fail", "fail", "blocked"]);
    assert.deepEqual(JSON.parse(audited[5].detail), { retryAfterMs: 15 * MINUTE });
    assert.equal(t.alerts.calls.length, 0, "no alert is raised");

    await t.clock.advance(15 * MINUTE);
    assert.equal((await reauth(c, PASSWORD)).status, 200, "accepted after the block");
  });

  test("the bucket is shared with AUTH-5: failures through either door count", async () => {
    await setUp();
    const c = await loggedIn();
    const change = (current) => c.api("PATCH", "/admin/api/account/password", { currentPassword: current, newPassword: OTHER });
    for (let i = 0; i < 3; i += 1) assert.equal((await change(`guess number ${i} !!`)).status, 422);
    for (let i = 0; i < 2; i += 1) assert.equal((await reauth(c, `guess again ${i}`)).status, 422);
    assert.equal((await reauth(c, PASSWORD)).status, 429);
    assert.equal((await change(PASSWORD)).status, 429, "AUTH-5 is blocked by the same bucket");
  });

  test("a success clears the failures of the bucket", async () => {
    await setUp();
    const c = await loggedIn();
    for (let i = 0; i < 4; i += 1) assert.equal((await reauth(c, `guess ${i} guess`)).status, 422);
    assert.equal((await reauth(c, PASSWORD)).status, 200);
    for (let i = 0; i < 4; i += 1) assert.equal((await reauth(c, `again ${i} again`)).status, 422);
    assert.equal((await reauth(c, PASSWORD)).status, 200, "never reached five in a row");
  });

  test("it is guarded like any session POST: CSRF token, session and strict schema", async () => {
    await setUp();
    const c = await loggedIn();
    const noToken = await c.api("POST", "/admin/api/session/reauth", { password: PASSWORD }, { headers: { "X-CSRF-Token": null } });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.json.error.code, "csrf_invalid");
    assert.equal((await t.client().api("POST", "/admin/api/session/reauth", { password: PASSWORD })).status, 401);
    const unknown = await c.api("POST", "/admin/api/session/reauth", { password: PASSWORD, extra: 1 });
    assert.equal(unknown.status, 422);
    assert.equal((await c.api("POST", "/admin/api/session/reauth", {})).status, 422);
    assert.equal((await c.api("POST", "/admin/api/session/reauth", { password: "x".repeat(257) })).status, 422);
    assert.equal((await c.get("/admin/api/session/reauth")).status, 405);
  });

  test("it is listed with stepUp false and auth session in the route table", () => {
    const row = t.admin.routes().find((r) => r.path === "/admin/api/session/reauth");
    assert.ok(row, "registered");
    assert.equal(row.method, "POST");
    assert.equal(row.auth, "session");
    assert.equal(row.stepUp, false, "it is the door itself");
    assert.equal(row.csrf, true);
    const gatedRow = t.admin.routes().find((r) => r.path === "/admin/api/t/gated");
    const maybeRow = t.admin.routes().find((r) => r.path === "/admin/api/t/maybe");
    assert.equal(gatedRow.stepUp, true);
    assert.equal(maybeRow.stepUp, "conditional");
  });

  test("the response and the audit rows never hold the password", async () => {
    await setUp();
    const c = await loggedIn();
    const good = await reauth(c, PASSWORD);
    const bad = await reauth(c, OTHER);
    assert.ok(!good.text.includes(PASSWORD));
    assert.ok(!bad.text.includes(OTHER));
    assert.ok(!JSON.stringify(await rows()).includes(OTHER));
    assert.ok(!JSON.stringify(t.logger.lines).includes(PASSWORD));
  });
});
