"use strict";
/**
 * Authentication and account (SC-001 setup flow, US1 scenarios 1-6, FR-001 to FR-009):
 * the setup link (printed once per boot, valid 30 minutes, single use, a new one at every start), the password
 * policy, login / logout, the session cookie (names, flags, hashed at rest, rotation), idle and absolute expiry
 * and the touch:false rule on a fake clock, the login lockout (5 failures in 15 minutes -> refused for 15 minutes,
 * the right password included), trust-proxy, the reset flow (CLI and marker file), the password change, the
 * preferences, and the units behind them (password, rate limit, tokens).
 *
 * Offline: in-memory SQLite, a fake clock, a very low scrypt cost, the real createAdmin on 127.0.0.1:0.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createTestAdmin } = require("./helpers/adminHarness");
const { parseSetCookie } = require("./helpers/adminClient");
const { createPasswords, checkPolicy, PRODUCTION_KDF } = require("../lib/admin/auth/password");
const { createLimiter, createRateLimits } = require("../lib/admin/auth/rateLimit");
const { createTokens } = require("../lib/admin/auth/tokens");
const { parseCookies } = require("../lib/admin/auth/sessions");
const redactor = require("../lib/admin/logs/redactor");
const adminReset = require("../tools/admin-reset");

const PASSWORD = "correct horse battery";
const OTHER = "another long password!";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
/** BOT_LANG as the panel understands it (en or fr), whichever language the suite runs in. */
const botLang = () => (["en", "fr"].includes(String(require("../config").LANG).slice(0, 2)) ? String(require("../config").LANG).slice(0, 2) : "fr");

let t;

async function boot(opts) {
  t = await createTestAdmin(opts);
  await t.admin.start();
  return t;
}

/** Create the account through the printed link; returns the logged-in client. */
async function setUp(client = t.client(), password = PASSWORD) {
  const { token } = t.lastLink();
  const { answer } = await client.setup(password, { token });
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  return client;
}

/** A fresh browser logged in with the password. */
async function loggedIn(password = PASSWORD) {
  const client = t.client();
  const answer = await client.login(password);
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  return client;
}

/** "not_found" = authenticated (the job does not exist), else the 401/503 code. jobs is a touch:false route. */
const probe = async (client) => (await client.get("/admin/api/jobs/1")).json.error.code;
/** A touching session route (extends the idle clock). */
const touchRoute = (client) => client.api("PATCH", "/admin/api/account/preferences", { theme: "auto" });
const auditRows = (where = {}) => t.db.AuditLog.findAll({ where, raw: true, order: [["id", "ASC"]] });
const flagsOf = (line) => parseSetCookie(line).attrs;

afterEach(async () => {
  if (t) await t.close();
  t = null;
  redactor.unregister("admin.token.setup");
  redactor.unregister("admin.token.reset");
});

// ---------------------------------------------------------------------------
// Setup link (US1 scenario 1, FR-003)
// ---------------------------------------------------------------------------

describe("setup link", () => {
  test("no account: only the invitation, and the setup link is printed once", async () => {
    await boot();
    const c = t.client();
    const session = await c.get("/admin/api/session");
    assert.equal(session.status, 200);
    assert.deepEqual(session.json, { accountExists: false, authenticated: false, https: false, proxyHint: false, setup: null });

    assert.equal(t.printed.length, 1);
    const link = t.lastLink();
    assert.match(link.url, /^http:\/\/localhost:\d+\/admin\/setup\?token=[A-Za-z0-9_-]{43}$/);
    assert.ok(link.url.includes(String(t.port)), "the link carries the listening port");
    assert.equal((await c.get("/admin/api/jobs/1")).json.error.code, "unauthenticated");
    assert.equal((await c.login(PASSWORD)).json.error.code, "setup_required");
  });

  test("PANEL_PUBLIC_URL is the base of the link", async () => {
    await boot({ publicUrl: "https://panel.example.org/" });
    assert.match(t.lastLink().url, /^https:\/\/panel\.example\.org\/admin\/setup\?token=/);
  });

  test("the link never reaches the logs: the original stdout only, the token registered with the redactor", async () => {
    await boot();
    const { token, line } = t.lastLink();
    assert.ok(!JSON.stringify(t.logger.lines).includes(token), "no log line holds the token");
    assert.ok(!redactor.scrub(line).includes(token), "the redactor hides the token");
  });

  test("only the SHA-256 of the token is stored, valid 30 minutes", async () => {
    await boot();
    const { token } = t.lastLink();
    const rows = await t.db.AdminToken.findAll({ raw: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "setup");
    assert.equal(rows[0].tokenHash, sha256(token));
    assert.ok(!JSON.stringify(rows).includes(token));
    assert.equal(new Date(rows[0].expiresAt).getTime() - t.clock.now(), 30 * MINUTE);
    assert.equal(rows[0].usedAt, null);
  });

  test("the landing validates without consuming: a scanner cannot burn the link", async () => {
    await boot();
    const { token } = t.lastLink();
    const scanner = t.client();
    for (let i = 0; i < 3; i += 1) {
      const landing = await scanner.get(`/admin/setup?token=${token}`);
      assert.equal(landing.status, 303);
      assert.equal(landing.headers.get("location"), "/admin/#/setup");
    }
    assert.equal((await t.db.AdminToken.findAll({ raw: true }))[0].usedAt, null);
    const owner = t.client();
    const { answer } = await owner.setup(PASSWORD, { token });
    assert.equal(answer.status, 200);
  });

  test("the landing sets owb_setup (HttpOnly, Strict, scoped path) and strips the token from the URL", async () => {
    await boot();
    const { token } = t.lastLink();
    const landing = await t.client().get(`/admin/setup?token=${token}`);
    assert.equal(landing.status, 303);
    assert.equal(landing.headers.get("referrer-policy"), "no-referrer");
    assert.equal(landing.headers.get("cache-control"), "no-store");
    const cookie = parseSetCookie(landing.setCookies[0]);
    assert.equal(cookie.name, "owb_setup");
    assert.equal(cookie.value, token);
    // scoped to the API, and wide enough for AUTH-1 (/admin/api/session) to see it: the SPA shows the form from there
    assert.equal(cookie.attrs.path, "/admin/api");
    assert.ok(cookie.attrs.httponly);
    assert.equal(cookie.attrs.samesite, "Strict");
    assert.equal(cookie.attrs["max-age"], String(30 * 60));
    assert.equal(cookie.attrs.secure, undefined, "no Secure over plain HTTP");
  });

  test("AUTH-1 reports the valid link as setup { purpose, expiresAt } and nothing else", async () => {
    await boot();
    const c = t.client();
    await c.get(`/admin/setup?token=${t.lastLink().token}`);
    const session = (await c.get("/admin/api/session")).json;
    assert.deepEqual(Object.keys(session).sort(), ["accountExists", "authenticated", "https", "proxyHint", "setup"]);
    assert.deepEqual(session.setup, { purpose: "setup", expiresAt: new Date(t.clock.now() + 30 * MINUTE).toISOString() });
  });

  test("valid 30 minutes on the clock, then the landing sends to the invalid page and sets nothing", async () => {
    await boot();
    const { token } = t.lastLink();
    await t.clock.advance(29 * MINUTE + 59 * 1000);
    assert.equal((await t.client().get(`/admin/setup?token=${token}`)).headers.get("location"), "/admin/#/setup");
    await t.clock.advance(2000);
    const late = await t.client().get(`/admin/setup?token=${token}`);
    assert.equal(late.status, 303);
    assert.equal(late.headers.get("location"), "/admin/#/setup/invalid");
    assert.deepEqual(late.setCookies, []);
  });

  test("a wrong or missing token goes to the invalid page", async () => {
    await boot();
    for (const query of ["", "?token=", "?token=nope", `?token=${"A".repeat(43)}`]) {
      const landing = await t.client().get(`/admin/setup${query}`);
      assert.equal(landing.status, 303, query);
      assert.equal(landing.headers.get("location"), "/admin/#/setup/invalid", query);
      assert.deepEqual(landing.setCookies, [], query);
    }
  });

  test("wrong tokens are throttled in their own bucket: the sixth is a 429, logins are unaffected", async () => {
    await boot();
    await setUp();
    const c = t.client();
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await c.get(`/admin/setup?token=${"B".repeat(43)}`)).status, 303);
    }
    const blocked = await c.get(`/admin/setup?token=${"B".repeat(43)}`);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error.code, "rate_limited");
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    assert.equal((await t.client().login(PASSWORD)).status, 200, "the login bucket is separate");
    await t.clock.advance(15 * MINUTE);
    assert.equal((await c.get(`/admin/setup?token=${"B".repeat(43)}`)).status, 303);
  });

  test("a new link at every start, and only one live setup token", async () => {
    await boot();
    const first = t.lastLink();
    await t.admin.stop();
    await t.admin.start();
    const second = t.lastLink();
    assert.notEqual(second.token, first.token);
    assert.equal(t.printed.length, 2);
    const rows = await t.db.AdminToken.findAll({ raw: true });
    assert.equal(rows.length, 1, "issuing deletes the unused tokens of the kind");
    assert.equal(rows[0].tokenHash, sha256(second.token));
    assert.equal((await t.client().get(`/admin/setup?token=${first.token}`)).headers.get("location"), "/admin/#/setup/invalid");
  });

  test("start() is idempotent: one link per boot", async () => {
    await boot();
    await t.admin.start();
    await t.admin.start();
    assert.equal(t.printed.length, 1);
  });

  test("with an account no link is printed", async () => {
    await boot();
    await setUp();
    await t.admin.stop();
    t.printed.length = 0;
    await t.admin.start();
    assert.deepEqual(t.printed, []);
    assert.equal(await t.db.AdminToken.count({ where: { kind: "setup" } }), 0, "creating the account deleted the setup tokens");
  });
});

// ---------------------------------------------------------------------------
// Account creation and the password policy (FR-004)
// ---------------------------------------------------------------------------

describe("account creation", () => {
  test("a password of 11 characters is refused with a field code, 12 is accepted", async () => {
    await boot();
    const c = t.client();
    const { token } = t.lastLink();
    await c.get(`/admin/setup?token=${token}`);
    const short = await c.api("POST", "/admin/api/setup", { password: "elevenchars" });
    assert.equal("elevenchars".length, 11);
    assert.equal(short.status, 422);
    assert.equal(short.json.error.code, "validation_failed");
    assert.deepEqual(short.json.error.fields.password, { code: "too_short", params: { min: 12 } });
    assert.equal(await t.db.AdminAccount.count(), 0);
    assert.equal((await t.db.AdminToken.findAll({ raw: true }))[0].usedAt, null, "a refused password does not burn the link");

    const ok = await c.api("POST", "/admin/api/setup", { password: "twelvechars!" });
    assert.equal("twelvechars!".length, 12);
    assert.equal(ok.status, 200);
  });

  test("weak passwords are too_weak: repeated character, sequence, denylist", async () => {
    await boot();
    const c = t.client();
    await c.get(`/admin/setup?token=${t.lastLink().token}`);
    for (const weak of ["aaaaaaaaaaaa", "abcdefghijkl", "123456789012", "987654321098", "abababababab", "password1234", "Motdepasse123"]) {
      const res = await c.api("POST", "/admin/api/setup", { password: weak });
      assert.equal(res.status, 422, weak);
      assert.deepEqual(res.json.error.fields.password, { code: "too_weak" }, weak);
    }
    assert.equal(await t.db.AdminAccount.count(), 0);
  });

  test("a password over 256 code points is too_long; the unknown field gives $unknown", async () => {
    await boot();
    const c = t.client();
    await c.get(`/admin/setup?token=${t.lastLink().token}`);
    const long = await c.api("POST", "/admin/api/setup", { password: "x1".repeat(129) });
    assert.deepEqual(long.json.error.fields.password, { code: "too_long", params: { max: 256 } });
    const extra = await c.api("POST", "/admin/api/setup", { password: PASSWORD, admin: true });
    assert.equal(extra.status, 422);
    assert.deepEqual(extra.json.error.fields.$unknown, { code: "unknown_field" });
  });

  test("without the cookie the setup is a 401 token_invalid; with a made-up cookie too, and it counts", async () => {
    await boot();
    const c = t.client();
    const bare = await c.api("POST", "/admin/api/setup", { password: PASSWORD });
    assert.equal(bare.status, 401);
    assert.equal(bare.json.error.code, "token_invalid");
    c.setCookie("owb_setup", "C".repeat(43));
    const fake = await c.api("POST", "/admin/api/setup", { password: PASSWORD });
    assert.equal(fake.json.error.code, "token_invalid");
    assert.equal(await t.db.AdminAccount.count(), 0);
  });

  test("the account is stored with a scrypt hash, the first session opens, the link is spent", async () => {
    await boot();
    const c = t.client();
    const { token } = t.lastLink();
    const { landing, answer } = await c.setup(PASSWORD, { token });
    assert.equal(landing.status, 303);
    assert.equal(answer.status, 200);
    assert.equal(answer.json.purpose, "setup");
    assert.equal(typeof answer.json.csrf, "string");
    assert.deepEqual(Object.keys(answer.json.account).sort(), ["lastLoginAt", "theme", "uiLang"]);
    assert.equal(answer.json.account.theme, "auto");
    assert.equal(answer.json.account.uiLang, botLang(), "the panel language starts from BOT_LANG");
    assert.deepEqual(answer.json.session, {
      idleExpiresAt: new Date(t.clock.now() + DAY).toISOString(),
      absoluteExpiresAt: new Date(t.clock.now() + 7 * DAY).toISOString(),
    });

    const account = await t.db.AdminAccount.findByPk(1, { raw: true });
    assert.match(account.passwordHash, /^scrypt\$16\$1\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.ok(!account.passwordHash.includes(PASSWORD));
    assert.equal((await t.db.AdminToken.count({ where: { kind: "setup" } })), 0, "the setup tokens are deleted with the account creation");
    // the link no longer works
    const again = await t.client().get(`/admin/setup?token=${token}`);
    assert.equal(again.headers.get("location"), "/admin/#/setup/invalid");
    const replay = t.client();
    replay.setCookie("owb_setup", token);
    assert.equal((await replay.api("POST", "/admin/api/setup", { password: OTHER })).json.error.code, "token_invalid");
    // the cookie of the setup is cleared
    assert.ok(answer.setCookies.some((line) => line.startsWith("owb_setup=;") && /Max-Age=0/.test(line)));
    assert.equal(c.cookie("owb_setup"), null);
  });

  test("two racing requests with the same link: exactly one wins", async () => {
    await boot();
    const { token } = t.lastLink();
    const a = t.client();
    const b = t.client();
    await a.get(`/admin/setup?token=${token}`);
    await b.get(`/admin/setup?token=${token}`);
    const [ra, rb] = await Promise.all([
      a.api("POST", "/admin/api/setup", { password: PASSWORD }),
      b.api("POST", "/admin/api/setup", { password: OTHER }),
    ]);
    assert.deepEqual([ra.status, rb.status].sort(), [200, 401]);
    assert.equal(await t.db.AdminAccount.count(), 1);
    assert.equal(await t.db.AdminSession.count(), 1);
  });

  test("setup.complete is audited, never the password", async () => {
    await boot();
    await setUp();
    const rows = await auditRows({ action: "setup.complete" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin, "127.0.0.1");
    assert.ok(!JSON.stringify(await auditRows()).includes(PASSWORD));
  });
});

// ---------------------------------------------------------------------------
// Login, logout, cookies, rotation
// ---------------------------------------------------------------------------

describe("login and logout", () => {
  beforeEach(async () => {
    await boot();
    await setUp();
  });

  test("login: the answer, the cookie flags, the session id hashed at rest", async () => {
    const c = t.client();
    const res = await c.login(PASSWORD);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ["account", "csrf", "session"]);
    assert.equal(res.json.account.lastLoginAt, new Date(t.clock.now()).toISOString());
    const cookie = parseSetCookie(res.setCookies[0]);
    assert.equal(cookie.name, "owb_sid", "plain HTTP: no __Host- prefix");
    assert.match(cookie.value, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(cookie.attrs.path, "/");
    assert.ok(cookie.attrs.httponly);
    assert.equal(cookie.attrs.samesite, "Strict");
    assert.equal(cookie.attrs.secure, undefined);
    assert.equal(cookie.attrs.domain, undefined);
    assert.equal(cookie.attrs["max-age"], "86400");

    const rows = await t.db.AdminSession.findAll({ raw: true });
    const row = rows.find((r) => r.idHash === sha256(cookie.value));
    assert.ok(row, "stored under the SHA-256 of the cookie value");
    assert.equal(row.csrfSecret, res.json.csrf);
    assert.ok(!JSON.stringify(await t.dumpTables()).includes(cookie.value), "the cookie value is nowhere in the database");
  });

  test("a wrong password is a 401 invalid_credentials, audited as login.failure with the origin", async () => {
    const res = await t.client().login("not the password");
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, "invalid_credentials");
    assert.deepEqual(res.setCookies, []);
    const rows = await auditRows({ action: "login.failure" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin, "127.0.0.1");
    assert.equal(rows[0].result, "fail");
    assert.ok(!JSON.stringify(rows).includes("not the password"));
  });

  test("login.success is audited and lastLoginAt moves", async () => {
    await t.clock.advance(HOUR);
    await loggedIn();
    const rows = await auditRows({ action: "login.success" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target, "127.0.0.1");
    const account = await t.db.AdminAccount.findByPk(1, { raw: true });
    assert.equal(new Date(account.lastLoginAt).getTime(), t.clock.now());
  });

  test("the login is guarded: a foreign Origin is a 403, text/plain a 415, and the schema is strict", async () => {
    const c = t.client();
    const foreign = await c.api("POST", "/admin/api/login", { password: PASSWORD }, { headers: { Origin: "https://evil.example" } });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.json.error.code, "origin_mismatch");
    const plain = await c.api("POST", "/admin/api/login", JSON.stringify({ password: PASSWORD }), { headers: { "Content-Type": "text/plain" } });
    assert.equal(plain.status, 415);
    const extra = await c.api("POST", "/admin/api/login", { password: PASSWORD, remember: true });
    assert.equal(extra.status, 422);
    assert.deepEqual(extra.json.error.fields.$unknown, { code: "unknown_field" });
    const missing = await c.api("POST", "/admin/api/login", {});
    assert.deepEqual(missing.json.error.fields.password, { code: "required" });
    assert.equal(await t.db.AuditLog.count({ where: { action: "login.failure" } }), 0, "a request that fails validation or the guard is not audited");
  });

  test("AUTH-1 when logged in: csrf, account, session, bot", async () => {
    const c = await loggedIn();
    const session = (await c.get("/admin/api/session")).json;
    assert.equal(session.authenticated, true);
    assert.equal(session.accountExists, true);
    assert.equal(session.csrf, c.csrf);
    assert.equal(session.setup, null);
    assert.deepEqual(Object.keys(session.account).sort(), ["lastLoginAt", "theme", "uiLang"]);
    assert.deepEqual(Object.keys(session.session).sort(), ["absoluteExpiresAt", "idleExpiresAt"]);
    assert.deepEqual(Object.keys(session.bot).sort(), ["lang", "timezone", "version"]);
    assert.ok(!JSON.stringify(session).includes("idHash"));
  });

  test("logout: the row is deleted, the cookie cleared, the old cookie is a 401 session_expired", async () => {
    const c = await loggedIn();
    const value = c.cookie("owb_sid");
    const res = await c.api("POST", "/admin/api/logout", {});
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    assert.ok(res.setCookies.some((line) => line.startsWith("owb_sid=;") && /Max-Age=0/.test(line)));
    assert.equal(await t.db.AdminSession.count({ where: { idHash: sha256(value) } }), 0);
    assert.equal(c.cookie("owb_sid"), null);
    assert.equal(await probe(c), "unauthenticated");
    const old = await t.client().raw({ path: "/admin/api/jobs/1", headers: { Cookie: `owb_sid=${value}` } });
    assert.equal(old.status, 401);
    assert.equal(old.json.error.code, "session_expired");
    assert.equal((await auditRows({ action: "logout" })).length, 1);
  });

  test("logout without the CSRF token is refused and keeps the session", async () => {
    const c = await loggedIn();
    const res = await c.api("POST", "/admin/api/logout", {}, { headers: { "X-CSRF-Token": null } });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, "csrf_invalid");
    assert.equal(await probe(c), "not_found");
  });

  test("an unknown, malformed or empty cookie is session_expired / unauthenticated", async () => {
    const raw = (cookie) => t.client().raw({ path: "/admin/api/jobs/1", headers: cookie === null ? {} : { Cookie: cookie } });
    assert.equal((await raw(null)).json.error.code, "unauthenticated");
    assert.equal((await raw("owb_sid=")).json.error.code, "unauthenticated");
    assert.equal((await raw(`owb_sid=${"D".repeat(43)}`)).json.error.code, "session_expired");
    assert.equal((await raw("owb_sid=short")).json.error.code, "session_expired");
    assert.equal((await raw("other=1")).json.error.code, "unauthenticated");
  });

  test("rotation at login: the cookie presented before is discarded", async () => {
    const c = await loggedIn();
    const before = c.cookie("owb_sid");
    const res = await c.login(PASSWORD);
    assert.equal(res.status, 200);
    const after = c.cookie("owb_sid");
    assert.notEqual(after, before);
    assert.equal(await t.db.AdminSession.count({ where: { idHash: sha256(before) } }), 0);
    assert.equal(await probe(c), "not_found");
    const stale = await t.client().raw({ path: "/admin/api/jobs/1", headers: { Cookie: `owb_sid=${before}` } });
    assert.equal(stale.json.error.code, "session_expired");
  });

  test("rotation at setup: a cookie planted before the setup never becomes the session", async () => {
    await t.close();
    await boot();
    const c = t.client();
    c.setCookie("owb_sid", "E".repeat(43));
    const { token } = t.lastLink();
    const { answer } = await c.setup(PASSWORD, { token });
    assert.equal(answer.status, 200);
    assert.notEqual(c.cookie("owb_sid"), "E".repeat(43));
    assert.equal(await probe(c), "not_found");
  });

  test("at most 10 live sessions: the 11th login evicts the oldest", async () => {
    const clients = [];
    for (let i = 0; i < 11; i += 1) {
      await t.clock.advance(1000);
      clients.push(await loggedIn());
    }
    assert.equal(await t.db.AdminSession.count(), 10);
    assert.equal(await probe(clients[0]), "session_expired", "the oldest was evicted");
    for (const c of clients.slice(1)) assert.equal(await probe(c), "not_found");
  });

  test("the logout closes the live streams of the session through the hub", async () => {
    const events = [];
    t.hub.subscribe("session", (payload) => events.push(payload));
    const c = await loggedIn();
    const id = sha256(c.cookie("owb_sid"));
    await c.api("POST", "/admin/api/logout", {});
    assert.deepEqual(events, [{ sessionId: id, reason: "logout" }]);
  });

  test("a stored hash with an old cost is upgraded at the next successful login", async () => {
    const old = await createPasswords({ kdf: { N: 32, r: 1, p: 1 } }).hash(PASSWORD);
    await t.db.AdminAccount.update({ passwordHash: old }, { where: { id: 1 } });
    assert.equal((await loggedIn()).cookie("owb_sid").length, 43);
    const account = await t.db.AdminAccount.findByPk(1, { raw: true });
    assert.match(account.passwordHash, /^scrypt\$16\$1\$1\$/);
    assert.equal((await t.client().login(PASSWORD)).status, 200);
  });
});

// ---------------------------------------------------------------------------
// Session lifetime on a fake clock (FR-006, U11)
// ---------------------------------------------------------------------------

describe("session lifetime", () => {
  beforeEach(async () => {
    await boot();
    await setUp();
  });

  test("idle expiry at 24 h; a touch:false request does not extend the session", async () => {
    const c = await loggedIn();
    await t.clock.advance(23 * HOUR);
    assert.equal(await probe(c), "not_found");
    await t.clock.advance(59 * MINUTE);
    assert.equal(await probe(c), "not_found", "still alive at 23 h 59 min");
    await t.clock.advance(MINUTE + 1);
    assert.equal(await probe(c), "session_expired", "the polling request in between did not extend the idle clock");
    assert.equal(await t.db.AdminSession.count({ where: { idHash: sha256(c.cookie("owb_sid") || "") } }), 0);
  });

  test("a touching request extends the idle clock", async () => {
    const c = await loggedIn();
    await t.clock.advance(23 * HOUR);
    assert.equal((await touchRoute(c)).status, 200);
    await t.clock.advance(23 * HOUR);
    assert.equal(await probe(c), "not_found", "46 h after the login, 23 h after the last activity");
    await t.clock.advance(HOUR + 1);
    assert.equal(await probe(c), "session_expired");
  });

  test("exactly 24 h of idleness expires the session", async () => {
    const c = await loggedIn();
    await t.clock.advance(DAY - 1);
    assert.equal(await probe(c), "not_found");
    await t.clock.advance(1);
    assert.equal(await probe(c), "session_expired");
  });

  test("absolute cap of 7 days, whatever the activity", async () => {
    const c = await loggedIn();
    for (let i = 0; i < 8; i += 1) {
      await t.clock.advance(20 * HOUR);
      assert.equal((await touchRoute(c)).status, 200, `activity at ${(i + 1) * 20} h`);
    }
    assert.equal(await probe(c), "not_found", "160 h, busy session");
    await t.clock.advance(7 * HOUR + 59 * MINUTE);
    assert.equal((await touchRoute(c)).status, 200, "167 h 59 min");
    await t.clock.advance(MINUTE);
    assert.equal((await touchRoute(c)).json.error.code, "session_expired", "168 h: the cap wins over the activity");
  });

  test("the cookie is re-issued at most once per minute, with Max-Age = min(24 h, remaining lifetime)", async () => {
    const c = await loggedIn();
    for (let i = 0; i < 7; i += 1) {
      await t.clock.advance(20 * HOUR);
      await touchRoute(c);
    }
    // 140 h in: 28 h of absolute lifetime left, the cookie still gets 24 h
    await t.clock.advance(MINUTE);
    const first = await touchRoute(c);
    const line = first.setCookies.find((l) => l.startsWith("owb_sid="));
    assert.ok(line, "re-issued on a touching answer");
    assert.equal(flagsOf(line)["max-age"], "86400");
    const second = await touchRoute(c);
    assert.ok(!second.setCookies.some((l) => l.startsWith("owb_sid=")), "not again within the minute");
    // 160 h 1 min in, then 7 h 50 min later: 9 minutes of absolute lifetime left
    await t.clock.advance(20 * HOUR);
    await touchRoute(c);
    await t.clock.advance(7 * HOUR + 50 * MINUTE);
    const late = await touchRoute(c);
    const lateLine = late.setCookies.find((l) => l.startsWith("owb_sid="));
    assert.ok(lateLine, "re-issued after a minute");
    assert.equal(flagsOf(lateLine)["max-age"], String(9 * 60), "Max-Age follows the remaining absolute lifetime");
  });

  test("a touch:false route never re-issues the cookie", async () => {
    const c = await loggedIn();
    await t.clock.advance(5 * MINUTE);
    const res = await c.get("/admin/api/jobs/1");
    assert.ok(!res.setCookies.some((l) => l.startsWith("owb_sid=")));
  });

  test("the idle clock is written behind: at most one database write per minute", async () => {
    const c = await loggedIn();
    const id = sha256(c.cookie("owb_sid"));
    const lastSeen = async () => new Date((await t.db.AdminSession.findByPk(id, { raw: true })).lastSeenAt).getTime();
    const login = t.clock.now();
    assert.equal(await lastSeen(), login);
    await t.clock.advance(10 * 1000);
    await touchRoute(c);
    assert.equal(await lastSeen(), login, "10 s later: not written");
    await t.clock.advance(55 * 1000);
    await touchRoute(c);
    for (let i = 0; i < 50 && (await lastSeen()) !== login + 65 * 1000; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await lastSeen(), login + 65 * 1000, "65 s later: written");
    await t.clock.advance(5 * 1000);
    await touchRoute(c);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await lastSeen(), login + 65 * 1000, "5 s after the write: not written again");
  });

  test("the pending activity time is written when the admin stops", async () => {
    const c = await loggedIn();
    const id = sha256(c.cookie("owb_sid"));
    await t.clock.advance(10 * 1000);
    await touchRoute(c);
    await t.admin.stop();
    const row = await t.db.AdminSession.findByPk(id, { raw: true });
    assert.equal(new Date(row.lastSeenAt).getTime(), t.clock.now());
    await t.admin.start();
  });

  test("the hourly sweep deletes expired rows; stop() leaves no timer", async () => {
    await loggedIn();
    assert.ok(t.clock.pending() > 0, "the sweep timer runs");
    assert.equal(await t.db.AdminSession.count(), 2, "the setup session and the login");
    await t.clock.advance(25 * HOUR);
    assert.equal(await t.db.AdminSession.count(), 0);
    await t.admin.stop();
    assert.equal(t.clock.pending(), 0);
  });

  test("with the database down a cached session keeps working and an uncached one is a 503, never a 401", async () => {
    const cached = await loggedIn();
    const uncached = await loggedIn();
    t.auth.sessions.clearCache();
    // `cached` is read again (cache warm), `uncached` is not
    assert.equal(await probe(cached), "not_found");
    const model = t.db.AdminSession;
    const original = model.findByPk;
    model.findByPk = async () => {
      throw Object.assign(new Error("connection lost"), { name: "SequelizeConnectionError" });
    };
    try {
      await t.clock.advance(61 * 1000); // past the cache TTL: the revalidation fails
      assert.equal(await probe(cached), "not_found", "the stale cached session still works");
      const down = await uncached.get("/admin/api/jobs/1");
      assert.equal(down.status, 503);
      assert.equal(down.json.error.code, "db_unavailable");
      t.auth.sessions.clearCache();
      assert.equal((await cached.get("/admin/api/jobs/1")).status, 503);
    } finally {
      model.findByPk = original;
    }
    assert.equal(await probe(uncached), "not_found", "back with the database");
  });

  test("AUTH-1 answers 200 with the database down", async () => {
    const c = await loggedIn();
    const model = t.db.AdminAccount;
    const original = model.findByPk;
    model.findByPk = async () => {
      throw Object.assign(new Error("connection lost"), { name: "SequelizeConnectionError" });
    };
    try {
      const authenticated = await c.get("/admin/api/session");
      assert.equal(authenticated.status, 200);
      assert.equal(authenticated.json.authenticated, true);
      const anonymous = await t.client().get("/admin/api/session");
      assert.equal(anonymous.status, 200);
      assert.equal(anonymous.json.accountExists, true, "unknown is not an invitation to set up");
    } finally {
      model.findByPk = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Lockout (FR-005, US1 scenario 4)
// ---------------------------------------------------------------------------

describe("login lockout", () => {
  beforeEach(async () => {
    await boot();
    await setUp();
  });

  const fail = (c, i = 0) => c.login(`wrong password ${i}`);

  test("5 failures -> the 6th attempt is refused for 15 minutes even with the right password, accepted after", async () => {
    const c = t.client();
    for (let i = 0; i < 5; i += 1) {
      const res = await fail(c, i);
      assert.equal(res.status, 401, `failure ${i + 1}`);
      assert.equal(res.json.error.code, "invalid_credentials");
    }
    const blocked = await c.login(PASSWORD);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error.code, "login_blocked");
    assert.equal(blocked.headers.get("retry-after"), "900");
    assert.equal(blocked.json.error.params.retryAfterMs, 15 * MINUTE);
    assert.deepEqual(blocked.setCookies, []);
    assert.equal(await probe(c), "unauthenticated");

    await t.clock.advance(10 * MINUTE);
    const still = await c.login(PASSWORD);
    assert.equal(still.status, 429, "10 minutes in");
    assert.equal(still.json.error.params.retryAfterMs, 5 * MINUTE, "refused attempts do not extend the block");
    assert.equal((await fail(c)).status, 429);

    await t.clock.advance(5 * MINUTE);
    const ok = await c.login(PASSWORD);
    assert.equal(ok.status, 200, "15 minutes after the block started");
  });

  test("login.blocked is logged once and the alert is raised once, however many attempts follow", async () => {
    const c = t.client();
    for (let i = 0; i < 5; i += 1) await fail(c, i);
    for (let i = 0; i < 4; i += 1) await c.login(PASSWORD);
    const blockedRows = await auditRows({ action: "login.blocked" });
    assert.equal(blockedRows.length, 1);
    assert.equal(blockedRows[0].result, "blocked");
    assert.equal(blockedRows[0].target, "127.0.0.1");
    assert.equal((await auditRows({ action: "login.failure" })).length, 5, "refused attempts are not verified, so not failures");
    const alerts = t.alerts.calls.filter((call) => call.type === "login_blocked");
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].payload.origin, "127.0.0.1");
    assert.equal(alerts[0].payload.retryAfterMs, 15 * MINUTE);
    assert.ok(alerts[0].payload.at);
  });

  test("failures spread over more than 15 minutes do not block", async () => {
    const c = t.client();
    for (let i = 0; i < 4; i += 1) await fail(c, i);
    await t.clock.advance(16 * MINUTE);
    for (let i = 0; i < 4; i += 1) assert.equal((await fail(c, i)).status, 401);
    assert.equal((await c.login(PASSWORD)).status, 200);
  });

  test("a success clears the count", async () => {
    const c = t.client();
    for (let i = 0; i < 4; i += 1) await fail(c, i);
    assert.equal((await c.login(PASSWORD)).status, 200);
    for (let i = 0; i < 4; i += 1) assert.equal((await fail(c, i)).status, 401);
    assert.equal((await c.login(PASSWORD)).status, 200);
  });

  test("the block is per origin and is not rehydrated unless asked", async () => {
    await t.close();
    await boot({ trustProxy: "loopback" });
    await setUp();
    const hostile = (address, password = "nope") =>
      t.client().raw({
        method: "POST",
        path: "/admin/api/login",
        headers: { Origin: t.base, "Content-Type": "application/json", "X-Forwarded-For": address },
        body: JSON.stringify({ password }),
        cookies: false,
      });
    for (let i = 0; i < 5; i += 1) assert.equal((await hostile("203.0.113.9")).status, 401);
    assert.equal((await hostile("203.0.113.9", PASSWORD)).status, 429);
    assert.equal((await hostile("203.0.113.10", PASSWORD)).status, 200, "another origin is not blocked");
    assert.equal((await t.client().login(PASSWORD)).status, 200, "nor the socket address");
    const rows = await auditRows({ action: "login.blocked" });
    assert.equal(rows[0].target, "203.0.113.9");
  });

  test("a restart inside a block keeps it when the limiter is rehydrated from the audit rows", async () => {
    await t.close();
    await boot({ rehydrate: true });
    await setUp();
    const c = t.client();
    for (let i = 0; i < 5; i += 1) await fail(c, i);
    await t.auth.stop();
    t.auth.limits.clearAll();
    assert.equal((await c.login(PASSWORD)).status, 200, "without rehydration the counters are fresh");
    for (let i = 0; i < 5; i += 1) await fail(c, i);
    t.auth.limits.clearAll();
    await t.auth.start();
    assert.equal((await c.login(PASSWORD)).status, 429, "the five failures of the last 15 minutes came back");
  });

  test("the lockout is checked before the account lookup", async () => {
    await t.db.AdminAccount.destroy({ where: {} });
    const c = t.client();
    for (let i = 0; i < 5; i += 1) t.auth.limits.login.fail("127.0.0.1", t.clock.now());
    assert.equal((await c.login(PASSWORD)).json.error.code, "login_blocked");
  });
});

// ---------------------------------------------------------------------------
// Trust proxy (U10)
// ---------------------------------------------------------------------------

describe("trust proxy", () => {
  const login = (headers, password = "nope") =>
    t.client().raw({
      method: "POST",
      path: "/admin/api/login",
      headers: { Origin: t.base, "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ password }),
      cookies: false,
    });

  test("X-Forwarded-For from an untrusted peer is ignored: spoofing does not dodge the lockout", async () => {
    await boot({ trustProxy: "" });
    await setUp();
    for (let i = 0; i < 5; i += 1) assert.equal((await login({ "X-Forwarded-For": `198.51.100.${i + 1}` })).status, 401);
    const sixth = await login({ "X-Forwarded-For": "198.51.100.200" }, PASSWORD);
    assert.equal(sixth.status, 429, "all five failures counted against the socket address");
    assert.equal((await auditRows({ action: "login.failure" }))[0].origin, "127.0.0.1");
  });

  test("with PANEL_TRUST_PROXY=loopback the right-most untrusted entry is the origin", async () => {
    await boot({ trustProxy: "loopback" });
    await setUp();
    for (let i = 0; i < 5; i += 1) {
      // the left part is attacker-controlled and changes every time
      assert.equal((await login({ "X-Forwarded-For": `10.0.0.${i + 1}, 203.0.113.9` })).status, 401);
    }
    assert.equal((await login({ "X-Forwarded-For": "1.2.3.4, 203.0.113.9" }, PASSWORD)).status, 429);
    assert.equal((await login({ "X-Forwarded-For": "203.0.113.77" }, PASSWORD)).status, 200);
    assert.equal((await auditRows({ action: "login.failure" }))[0].origin, "203.0.113.9");
  });

  test("proxyHint: forwarded headers from an untrusted peer are reported, from a trusted one are not", async () => {
    await boot({ trustProxy: "" });
    const hinted = await t.client().raw({ path: "/admin/api/session", headers: { "X-Forwarded-For": "203.0.113.9" } });
    assert.equal(hinted.json.proxyHint, true);
    assert.equal((await t.client().raw({ path: "/admin/api/session" })).json.proxyHint, false);
    t.config.PANEL_TRUST_PROXY = "loopback";
    assert.equal((await t.client().raw({ path: "/admin/api/session", headers: { "X-Forwarded-For": "203.0.113.9" } })).json.proxyHint, false);
  });

  test("HTTPS behind a trusted proxy: __Host- cookie with Secure, both names accepted on read", async () => {
    await boot({ trustProxy: "loopback" });
    await setUp();
    const c = t.client();
    const res = await c.api("POST", "/admin/api/login", { password: PASSWORD }, { headers: { "X-Forwarded-Proto": "https" } });
    assert.equal(res.status, 200);
    const cookie = parseSetCookie(res.setCookies[0]);
    assert.equal(cookie.name, "__Host-owb_sid");
    assert.ok(cookie.attrs.secure);
    assert.equal(cookie.attrs.path, "/");
    assert.equal(cookie.attrs.domain, undefined);
    assert.ok(cookie.attrs.httponly);
    assert.equal(cookie.attrs.samesite, "Strict");
    assert.equal((await c.raw({ path: "/admin/api/session", headers: { "X-Forwarded-Proto": "https" } })).json.https, true);

    // the __Host- cookie wins over a stale plain one, and the plain name alone works too
    const value = cookie.value;
    const both = await t.client().raw({ path: "/admin/api/jobs/1", cookies: false, headers: { Cookie: `owb_sid=${"F".repeat(43)}; __Host-owb_sid=${value}` } });
    assert.equal(both.json.error.code, "not_found");
    const plain = await t.client().raw({ path: "/admin/api/jobs/1", cookies: false, headers: { Cookie: `owb_sid=${value}` } });
    assert.equal(plain.json.error.code, "not_found");

    const out = await c.api("POST", "/admin/api/logout", {}, { headers: { "X-Forwarded-Proto": "https" } });
    assert.ok(out.setCookies.some((l) => l.startsWith("__Host-owb_sid=;") && /Secure/.test(l)));
  });

  test("X-Forwarded-Proto from an untrusted peer does not switch the cookie to Secure", async () => {
    await boot({ trustProxy: "" });
    await setUp();
    const res = await t.client().api("POST", "/admin/api/login", { password: PASSWORD }, { headers: { "X-Forwarded-Proto": "https" } });
    const cookie = parseSetCookie(res.setCookies[0]);
    assert.equal(cookie.name, "owb_sid");
    assert.equal(cookie.attrs.secure, undefined);
  });

  test("new_origin: raised for an origin never seen, not for the origin that did the setup, not twice", async () => {
    await boot({ trustProxy: "loopback" });
    await setUp();
    await t.client().login(PASSWORD);
    assert.equal(t.alerts.calls.filter((c) => c.type === "new_origin").length, 0, "the setup origin is known");

    const remote = (address) => t.client().api("POST", "/admin/api/login", { password: PASSWORD }, { headers: { "X-Forwarded-For": address } });
    assert.equal((await remote("203.0.113.50")).status, 200);
    const calls = t.alerts.calls.filter((c) => c.type === "new_origin");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.origin, "203.0.113.50");
    assert.equal((await remote("203.0.113.50")).status, 200);
    assert.equal(t.alerts.calls.filter((c) => c.type === "new_origin").length, 1, "the origin is now seen");
  });

  test("the alert engine is optional: without it nothing breaks", async () => {
    await boot({ deps: { alerts: null } });
    await setUp();
    for (let i = 0; i < 5; i += 1) await t.client().login("nope nope nope");
    assert.equal((await t.client().login(PASSWORD)).json.error.code, "login_blocked");
  });
});

// ---------------------------------------------------------------------------
// Password change and preferences
// ---------------------------------------------------------------------------

describe("password change", () => {
  beforeEach(async () => {
    await boot();
    await setUp();
  });

  const change = (c, body) => c.api("PATCH", "/admin/api/account/password", body);

  test("a wrong current password is a 422 field error, never a 401", async () => {
    const c = await loggedIn();
    const res = await change(c, { currentPassword: "not the password", newPassword: OTHER });
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, "validation_failed");
    assert.deepEqual(res.json.error.fields, { currentPassword: { code: "wrong_password" } });
    assert.equal(await probe(c), "not_found", "the session is untouched");
    assert.ok(!JSON.stringify(res.json).includes(OTHER));
  });

  test("the new password field codes: too_short, too_weak, same_as_current", async () => {
    const c = await loggedIn();
    assert.deepEqual((await change(c, { currentPassword: PASSWORD, newPassword: "short" })).json.error.fields.newPassword, { code: "too_short", params: { min: 12 } });
    assert.deepEqual((await change(c, { currentPassword: PASSWORD, newPassword: "aaaaaaaaaaaa" })).json.error.fields.newPassword, { code: "too_weak" });
    assert.deepEqual((await change(c, { currentPassword: PASSWORD, newPassword: PASSWORD })).json.error.fields.newPassword, { code: "same_as_current" });
    const both = await change(c, { currentPassword: "wrong wrong wrong", newPassword: "aaaaaaaaaaaa" });
    assert.deepEqual(Object.keys(both.json.error.fields).sort(), ["currentPassword", "newPassword"]);
  });

  test("success: other sessions are revoked, this one is rotated, the new password works", async () => {
    const mine = await loggedIn();
    const other = await loggedIn();
    const beforeValue = mine.cookie("owb_sid");
    const events = [];
    t.hub.subscribe("session", (payload) => events.push(payload));

    const res = await change(mine, { currentPassword: PASSWORD, newPassword: OTHER });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json), ["csrf"]);
    assert.equal(res.json.csrf, mine.csrf);

    assert.notEqual(mine.cookie("owb_sid"), beforeValue, "a new cookie");
    assert.equal(await probe(mine), "not_found", "this browser is still in");
    assert.equal(await probe(other), "session_expired", "the other session is gone");
    const old = await t.client().raw({ path: "/admin/api/jobs/1", headers: { Cookie: `owb_sid=${beforeValue}` } });
    assert.equal(old.json.error.code, "session_expired", "the pre-rotation cookie is dead");
    assert.equal(await t.db.AdminSession.count(), 1);
    assert.deepEqual(
      events.map((e) => e.reason).sort(),
      ["revoked", "revoked", "rotated"],
      "the streams of the two other sessions (the setup one and the other browser) and of the rotated one are closed",
    );

    assert.equal((await t.client().login(PASSWORD)).status, 401);
    assert.equal((await t.client().login(OTHER)).status, 200);
    const rows = await auditRows({ action: "account.update" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target, "password");
    assert.ok(!JSON.stringify(await auditRows()).includes(OTHER));
  });

  test("the old CSRF token no longer works after the rotation", async () => {
    const c = await loggedIn();
    const old = c.csrf;
    await change(c, { currentPassword: PASSWORD, newPassword: OTHER });
    assert.notEqual(c.csrf, old);
    const res = await c.api("PATCH", "/admin/api/account/preferences", { theme: "dark" }, { headers: { "X-CSRF-Token": old } });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, "csrf_invalid");
  });

  test("guessing the current password is throttled: five wrong guesses, then a 429", async () => {
    const c = await loggedIn();
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await change(c, { currentPassword: `guess number ${i} !`, newPassword: OTHER })).status, 422);
    }
    const blocked = await change(c, { currentPassword: PASSWORD, newPassword: OTHER });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error.code, "rate_limited");
    assert.ok(blocked.json.error.params.retryAfterMs > 0);
    await t.clock.advance(15 * MINUTE);
    assert.equal((await change(c, { currentPassword: PASSWORD, newPassword: OTHER })).status, 200);
  });
});

describe("preferences", () => {
  beforeEach(async () => {
    await boot();
    await setUp();
  });

  test("uiLang and theme are saved and read back by AUTH-1", async () => {
    const c = await loggedIn();
    const res = await c.api("PATCH", "/admin/api/account/preferences", { uiLang: "en", theme: "dark" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { uiLang: "en", theme: "dark" });
    assert.deepEqual((await c.get("/admin/api/session")).json.account.theme, "dark");
    assert.equal((await t.client().login(PASSWORD)).json.account.uiLang, "en");
    const one = await c.api("PATCH", "/admin/api/account/preferences", { theme: "light" });
    assert.deepEqual(one.json, { uiLang: "en", theme: "light" });
  });

  test("an empty body, an unknown value and an unknown field are 422", async () => {
    const c = await loggedIn();
    assert.equal((await c.api("PATCH", "/admin/api/account/preferences", {})).status, 422);
    const bad = await c.api("PATCH", "/admin/api/account/preferences", { theme: "neon" });
    assert.equal(bad.json.error.fields.theme.code, "not_allowed");
    assert.deepEqual(bad.json.error.fields.theme.params.allowed, ["auto", "light", "dark"]);
    const extra = await c.api("PATCH", "/admin/api/account/preferences", { theme: "dark", admin: 1 });
    assert.deepEqual(extra.json.error.fields.$unknown, { code: "unknown_field" });
  });
});

// ---------------------------------------------------------------------------
// Reset (FR-007): the CLI and the marker file
// ---------------------------------------------------------------------------

describe("reset flow", () => {
  async function runCli() {
    const out = [];
    const code = await adminReset.run({
      models: t.db,
      audit: t.audit,
      config: t.config,
      now: () => t.clock.now(),
      print: (line) => out.push(line),
      printError: (line) => out.push(line),
    });
    return { code, out };
  }

  test("without an account the CLI says to run the bot (exit 1) and writes nothing", async () => {
    await boot();
    const { code, out } = await runCli();
    assert.equal(code, 1);
    assert.equal(out.length, 1);
    assert.ok(!/token=/.test(out[0]));
    assert.equal(await t.db.AdminToken.count({ where: { kind: "reset" } }), 0);
  });

  test("CLI: a single-use link, a new password, every session revoked, every lockout cleared", async () => {
    await boot();
    await setUp();
    const stale = await loggedIn();
    // lock the origin out first
    const c = t.client();
    for (let i = 0; i < 5; i += 1) await c.login("nope nope nope");
    assert.equal((await c.login(PASSWORD)).status, 429);

    const { code, out } = await runCli();
    assert.equal(code, 0);
    const match = /\/admin\/setup\?token=([A-Za-z0-9_-]{43})/.exec(out[0]);
    assert.ok(match, "the link is printed");
    assert.match(out[0], /^.*http:\/\/localhost:\d+\/admin\/setup\?token=/);
    const rows = await t.db.AdminToken.findAll({ where: { kind: "reset" }, raw: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tokenHash, sha256(match[1]));
    assert.equal(new Date(rows[0].expiresAt).getTime() - t.clock.now(), 30 * MINUTE);
    const issued = await auditRows({ action: "reset.issued" });
    assert.equal(issued.length, 1);
    assert.equal(issued[0].origin, "cli");

    // the link lands as a reset
    const owner = t.client();
    await owner.get(`/admin/setup?token=${match[1]}`);
    assert.equal((await owner.get("/admin/api/session")).json.setup.purpose, "reset");
    // the old session still works until the link is used
    assert.equal(await probe(stale), "not_found");

    const weak = await owner.api("POST", "/admin/api/setup", { password: "aaaaaaaaaaaa" });
    assert.equal(weak.status, 422);
    const done = await owner.api("POST", "/admin/api/setup", { password: OTHER });
    assert.equal(done.status, 200);
    assert.equal(done.json.purpose, "reset");

    assert.equal(await probe(stale), "session_expired", "all sessions are revoked");
    assert.equal(await probe(owner), "not_found", "the reset opens a new one");
    assert.equal(await t.db.AdminSession.count(), 1);
    assert.equal((await t.client().login(PASSWORD)).json.error.code, "invalid_credentials", "the old password is gone");
    assert.equal((await t.client().login(OTHER)).status, 200, "the lockout was lifted");
    assert.equal((await auditRows({ action: "reset.complete" })).length, 1);

    const replay = t.client();
    await replay.get(`/admin/setup?token=${match[1]}`);
    assert.equal((await replay.get("/admin/api/session")).json.setup, null, "single use");
  });

  test("issuing another reset link invalidates the previous one (one live link per kind)", async () => {
    await boot();
    await setUp();
    const first = /token=([A-Za-z0-9_-]{43})/.exec((await runCli()).out[0])[1];
    const second = /token=([A-Za-z0-9_-]{43})/.exec((await runCli()).out[0])[1];
    assert.notEqual(first, second);
    const c = t.client();
    assert.equal((await c.get(`/admin/setup?token=${first}`)).headers.get("location"), "/admin/#/setup/invalid");
    assert.equal((await c.get(`/admin/setup?token=${second}`)).headers.get("location"), "/admin/#/setup");
  });

  test("the marker file data/admin-reset issues a reset link at the next start and is deleted", async () => {
    await boot();
    await setUp();
    const marker = path.join(t.dataDir, "admin-reset");
    fs.writeFileSync(marker, "");
    t.printed.length = 0;
    await t.admin.stop();
    await t.admin.start();
    assert.equal(t.printed.length, 1);
    const link = t.lastLink();
    assert.ok(link);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(await t.db.AdminToken.count({ where: { kind: "reset" } }), 1);
    const issued = await auditRows({ action: "reset.issued" });
    assert.equal(issued[0].origin, "system");
    const c = t.client();
    await c.get(`/admin/setup?token=${link.token}`);
    assert.equal((await c.get("/admin/api/session")).json.setup.purpose, "reset");

    // no marker: no link
    t.printed.length = 0;
    await t.admin.stop();
    await t.admin.start();
    assert.deepEqual(t.printed, []);
  });

  test("a marker file without any account only removes the marker (the setup link is the way in)", async () => {
    await boot();
    const marker = path.join(t.dataDir, "admin-reset");
    fs.writeFileSync(marker, "");
    t.printed.length = 0;
    await t.admin.stop();
    await t.admin.start();
    assert.equal(t.printed.length, 1);
    assert.equal(await t.db.AdminToken.count({ where: { kind: "reset" } }), 0);
    assert.equal(await t.db.AdminToken.count({ where: { kind: "setup" } }), 1);
    assert.equal(fs.existsSync(marker), false);
  });

  test("a reset link and a setup link do not replace each other", async () => {
    await boot();
    const tokens = createTokens({ models: t.db, now: () => t.clock.now() });
    const setup = await tokens.issue("setup");
    const reset = await tokens.issue("reset");
    assert.ok(await tokens.validate(setup.token, { kind: "setup" }));
    assert.ok(await tokens.validate(reset.token, { kind: "reset" }));
    assert.equal(await tokens.validate(reset.token, { kind: "setup" }), null);
  });
});

// ---------------------------------------------------------------------------
// The CLI as a real process
// ---------------------------------------------------------------------------

describe("tools/admin-reset.js as a process", () => {
  const ROOT = path.resolve(__dirname, "..");
  const preload = path.join(ROOT, "test", "helpers", "botFragments.js");

  function node(args, env) {
    return new Promise((resolve) => {
      execFile(process.execPath, args, { cwd: ROOT, env, timeout: 90000 }, (err, stdout, stderr) => {
        resolve({ code: err ? err.code : 0, stdout, stderr });
      });
    });
  }

  test("exit 1 without an account, exit 0 with the single-use link and a cli audit row", { timeout: 180000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-admin-reset-"));
    const file = path.join(dir, "bot.db");
    const env = {
      ...process.env,
      DATABASE_URL: file,
      OWB_NO_CONFIG_ENV: "1",
      OWB_APPLY_BOT_FRAGMENTS: "1",
      LOG_LEVEL: "silent",
      BOT_LANG: "en",
      PANEL_PUBLIC_URL: "https://panel.example.org",
      PANEL_TOKEN: "",
    };
    try {
      const none = await node(["--require", preload, "tools/admin-reset.js"], env);
      assert.equal(none.code, 1, none.stderr);
      assert.match(none.stdout, /No administrator account/);
      assert.ok(!/token=/.test(none.stdout));

      const seed =
        "(async()=>{const db=require('./lib/database');await db.sync();" +
        "await db.AdminAccount.create({id:1,passwordHash:'scrypt$16$1$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='});" +
        "await db.DATABASE.close();})()";
      const seeded = await node(["--require", preload, "-e", seed], env);
      assert.equal(seeded.code, 0, seeded.stderr);

      const issued = await node(["--require", preload, "tools/admin-reset.js"], env);
      assert.equal(issued.code, 0, issued.stderr);
      const link = /(https:\/\/panel\.example\.org\/admin\/setup\?token=([A-Za-z0-9_-]{43}))/.exec(issued.stdout);
      assert.ok(link, issued.stdout);
      assert.match(issued.stdout, /30 minutes/);

      const sqlite3 = require("sqlite3");
      const rows = await new Promise((resolve, reject) => {
        const database = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (err) => {
          if (err) return reject(err);
          database.all("SELECT kind, tokenHash, usedAt FROM admin_tokens", (error, tokens) => {
            if (error) return reject(error);
            database.all("SELECT action, origin, result FROM audit_logs", (error2, audit) => {
              database.close();
              if (error2) reject(error2);
              else resolve({ tokens, audit });
            });
          });
        });
      });
      assert.equal(rows.tokens.length, 1);
      assert.equal(rows.tokens[0].kind, "reset");
      assert.equal(rows.tokens[0].tokenHash, sha256(link[2]));
      assert.equal(rows.tokens[0].usedAt, null);
      assert.deepEqual(rows.audit, [{ action: "reset.issued", origin: "cli", result: "ok" }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

describe("password.js", () => {
  const passwords = createPasswords({ kdf: { N: 16, r: 1, p: 1 } });

  test("the production cost is N=2^15, r=8, p=3 with a 16-byte salt and a 32-byte key", () => {
    assert.deepEqual({ ...PRODUCTION_KDF }, { N: 32768, r: 8, p: 3, keyLength: 32, saltLength: 16 });
    assert.deepEqual(createPasswords().kdf, PRODUCTION_KDF);
  });

  test("hash format, verification, salt, NFKC", async () => {
    const hash = await passwords.hash("Pässword-with-accents-1");
    const parts = hash.split("$");
    assert.equal(parts.length, 6);
    assert.deepEqual(parts.slice(0, 4), ["scrypt", "16", "1", "1"]);
    assert.equal(Buffer.from(parts[4], "base64").length, 16);
    assert.equal(Buffer.from(parts[5], "base64").length, 32);
    assert.equal(await passwords.verify("Pässword-with-accents-1", hash), true);
    assert.equal(await passwords.verify("Pässword-with-accents-2", hash), false);
    assert.notEqual(await passwords.hash("Pässword-with-accents-1"), hash, "a fresh salt each time");
    // the full-width form normalises (NFKC) to the same password
    const wide = "ＡＢＣＤＥＦＧＨＩＪＫＬ-1";
    const wideHash = await passwords.hash(wide);
    assert.equal(await passwords.verify("ABCDEFGHIJKL-1", wideHash), true);
  });

  test("a hash made with other parameters still verifies, and needsRehash says so", async () => {
    const other = await createPasswords({ kdf: { N: 32, r: 1, p: 1 } }).hash("some long password");
    assert.equal(await passwords.verify("some long password", other), true);
    assert.equal(passwords.needsRehash(other), true);
    assert.equal(passwords.needsRehash(await passwords.hash("x")), false);
    assert.equal(passwords.needsRehash("garbage"), true);
  });

  test("a malformed or hostile stored hash never matches and never throws", async () => {
    for (const stored of ["", null, "plain", "scrypt$a$b$c$d$e", "scrypt$16$1$1$AA==$AA==", "scrypt$3$1$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "scrypt$1073741824$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="]) {
      assert.equal(await passwords.verify("anything long enough", stored), false, String(stored));
    }
  });

  test("policy: lengths in code points after NFKC, repeated character, sequences, denylist", () => {
    assert.deepEqual(checkPolicy("short"), { code: "too_short", params: { min: 12 } });
    assert.deepEqual(checkPolicy("12345678901"), { code: "too_short", params: { min: 12 } });
    assert.equal(checkPolicy("kX9#mQ2$vL7!"), null);
    assert.equal(checkPolicy("correct horse battery"), null);
    assert.deepEqual(checkPolicy("x".repeat(257)), { code: "too_long", params: { max: 256 } });
    assert.equal(checkPolicy(sha256("seed").repeat(4)), null, "256 code points is allowed");
    assert.equal(checkPolicy("😀".repeat(12)).code, "too_weak", "emoji count as one code point each");
    assert.equal(checkPolicy("😀😁😂🤣😃😄😅😆😉😊😋😎"), null);
    for (const weak of ["aaaaaaaaaaaa", "AAAAAAAAAAAA", "abcdefghijkl", "zyxwvutsrqpo", "123456789012", "012345678901", "901234567890", "210987654321", "abababababab", "123123123123", "Password1234", "motdepasse2024!", "openwhatsappbot", "passwordpassword"]) {
      assert.equal(checkPolicy(weak) && checkPolicy(weak).code, "too_weak", weak);
    }
    // a normal word followed by something that is not just digits is fine
    assert.equal(checkPolicy("password-rabbit-staple"), null);
  });

  test("one scrypt in flight, a queue of 4, then rate_limited", async () => {
    const pending = [];
    const slow = createPasswords({
      kdf: { N: 16, r: 1, p: 1 },
      scrypt: (password, salt, length, options, callback) => pending.push(() => callback(null, Buffer.alloc(length, 7))),
    });
    const jobs = [];
    for (let i = 0; i < 5; i += 1) jobs.push(slow.hash(`password number ${i}`));
    assert.deepEqual(slow.queueStats(), { inFlight: 1, waiting: 4, maxWaiting: 4 });
    assert.equal(pending.length, 1, "only one scrypt runs");
    await assert.rejects(slow.hash("one too many!"), (err) => err.code === "rate_limited" && err.params.retryAfterMs > 0);
    // they run one after the other
    for (let i = 0; i < 5; i += 1) {
      while (!pending.length) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(slow.queueStats().inFlight, 1);
      pending.shift()();
      await jobs[i];
    }
    assert.deepEqual(slow.queueStats(), { inFlight: 0, waiting: 0, maxWaiting: 4 });
    const again = slow.hash("room again!!");
    pending.shift()();
    await again;
  });
});

describe("rateLimit.js", () => {
  test("5 failures in 15 minutes block for 15 minutes; refused attempts never extend the block", () => {
    let at = 0;
    const limiter = createLimiter({ now: () => at });
    for (let i = 0; i < 4; i += 1) assert.deepEqual(limiter.fail("a", at), { blocked: false, newlyBlocked: false, failures: i + 1 });
    assert.deepEqual(limiter.check("a"), { blocked: false });
    const fifth = limiter.fail("a", at);
    assert.deepEqual(fifth, { blocked: true, newlyBlocked: true, retryAfterMs: 15 * MINUTE });
    at = 10 * MINUTE;
    assert.deepEqual(limiter.check("a"), { blocked: true, retryAfterMs: 5 * MINUTE });
    assert.deepEqual(limiter.fail("a", at), { blocked: true, newlyBlocked: false, retryAfterMs: 5 * MINUTE });
    at = 15 * MINUTE;
    assert.deepEqual(limiter.check("a"), { blocked: false });
    assert.equal(limiter.size(), 0);
  });

  test("keys are independent; success and clearAll forget", () => {
    let at = 0;
    const limiter = createLimiter({ now: () => at });
    for (let i = 0; i < 5; i += 1) limiter.fail("a");
    assert.equal(limiter.check("a").blocked, true);
    assert.equal(limiter.check("b").blocked, false);
    limiter.success("a");
    assert.equal(limiter.check("a").blocked, false);
    for (let i = 0; i < 5; i += 1) limiter.fail("b");
    limiter.clearAll();
    assert.equal(limiter.check("b").blocked, false);
    at += 1;
  });

  test("failures older than the window are forgotten", () => {
    let at = 0;
    const limiter = createLimiter({ now: () => at });
    for (let i = 0; i < 4; i += 1) limiter.fail("a");
    at = 15 * MINUTE;
    assert.equal(limiter.fail("a").failures, 1);
  });

  test("10 000 entries at most, the oldest evicted first", () => {
    const limiter = createLimiter({ now: () => 0, maxEntries: 10000 });
    for (let i = 0; i < 10005; i += 1) limiter.fail(`origin-${i}`);
    assert.equal(limiter.size(), 10000);
    for (let i = 0; i < 5; i += 1) limiter.fail("origin-0"); // evicted: starts again from one failure
    assert.equal(limiter.check("origin-10004").blocked, false);
  });

  test("rehydrate: five recent failures block, older ones and fewer do not", () => {
    const at = 100 * MINUTE;
    const limiter = createLimiter({ now: () => at });
    const rows = [
      ...[1, 2, 3, 4, 5].map((m) => ({ origin: "blocked", at: at - (10 - m) * MINUTE })),
      ...[1, 2].map((m) => ({ origin: "some", at: at - m * MINUTE })),
      ...[20, 21, 22, 23, 24].map((m) => ({ origin: "old", at: at - m * MINUTE })),
      { origin: "", at },
    ];
    assert.equal(limiter.rehydrate(rows, at), 2);
    const blocked = limiter.check("blocked");
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.retryAfterMs, 15 * MINUTE - 5 * MINUTE, "the block started with the fifth failure");
    assert.equal(limiter.check("some").blocked, false);
    assert.equal(limiter.check("old").blocked, false);
    // two failures were restored: three more block
    limiter.fail("some");
    limiter.fail("some");
    assert.equal(limiter.fail("some").newlyBlocked, true);
  });

  test("createRateLimits: three separate buckets, clearAll empties them all", () => {
    const limits = createRateLimits({ now: () => 0 });
    for (let i = 0; i < 5; i += 1) limits.token.fail("a");
    assert.equal(limits.token.check("a").blocked, true);
    assert.equal(limits.login.check("a").blocked, false);
    assert.equal(limits.password.check("a").blocked, false);
    for (let i = 0; i < 5; i += 1) limits.login.fail("a");
    limits.clearAll();
    assert.equal(limits.token.check("a").blocked, false);
    assert.equal(limits.login.check("a").blocked, false);
  });
});

describe("cookies", () => {
  test("parseCookies keeps the first value of a name and ignores junk", () => {
    const jar = parseCookies("a=1; b=2; a=3; novalue; =x; c = 4 ");
    assert.equal(jar.get("a"), "1");
    assert.equal(jar.get("b"), "2");
    assert.equal(jar.get("c"), "4");
    assert.equal(jar.has("novalue"), false);
    assert.equal(parseCookies(undefined).size, 0);
  });
});
