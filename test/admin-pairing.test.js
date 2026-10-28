"use strict";
/**
 * Pairing from the browser (US4, FR-023, FR-024, SC-006): PAIR-1 to PAIR-4 of admin-http-api.md section 2.4 and
 * the hub `pairing` topic, over the real createAdmin (test/helpers/adminHarness.js) with the fake client of
 * test/helpers/fakes.js. A last group runs the REAL WhatsAppClient on test/helpers/fakeBaileys.js in a temporary
 * sessions directory, to prove that the events it emits reach the hub.
 *
 *  - PAIR-1 shape, without the QR string or the code; `codeCooldownMs`;
 *  - PAIR-2 `image/svg+xml` made with `qrcode`, `no-store`, its own `default-src 'none'` CSP, `404 no_qr`,
 *    session and same-origin required;
 *  - PAIR-3 number normalisation and `fields.phone = invalid_phone`, the code sent in that answer only, the
 *    409/429/502 answers, the audit row `pair.code` with the last two digits;
 *  - PAIR-4 `confirm: true`, `resetSession()`, a dead socket, the audit row `session.logout`;
 *  - the QR string, the code and the number never appear in a log, an audit row or an error body.
 *
 * Offline: in-memory SQLite, a fake clock, no WhatsApp. Nothing touches the real sessions/ or data/.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const nodeHttp = require("http");
const os = require("os");
const path = require("path");
const QRCode = require("qrcode");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createTestAdmin } = require("./helpers/adminHarness");
const { loadClientWithFakeBaileys } = require("./helpers/fakeBaileys");
const redactor = require("../lib/admin/logs/redactor");

const QR_A = "2@alpha-secret-qr-payload-AAAA1111,key=,more";
const QR_B = "2@bravo-secret-qr-payload-BBBB2222,key=,more";
const CODE = "ABCD-1234";
const PHONE = "12025550123"; // 202 555 01xx: fictional
const COOLDOWN = 30 * 1000;
const WINDOW = 3 * 60 * 1000;
const PAIR_PATHS = ["/admin/api/pairing", "/admin/api/pairing/qr.svg", "/admin/api/pairing/code", "/admin/api/pairing/logout"];

let t;
let cleanups = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  if (t) await t.close();
  t = null;
  for (const name of ["pairing-code", "pairing-code-plain", "qr:1", "qr:2", "qr:3"]) redactor.unregister(name);
});

/** A fake client that is not paired yet and waits for a scan. */
function unpairedClient(status = "qr") {
  const client = fakes.fakeClient();
  client.setState({ registered: false, status, me: null, hasQr: false, pairing: null });
  return client;
}

/** The admin over `client`, started, with a logged-in browser. */
async function boot(client = unpairedClient(), opts = {}) {
  t = await createTestAdmin({ ...opts, deps: { client, ...(opts.deps || {}) } });
  const http = await t.loginClient();
  return { client, http };
}

/** The client has a QR on screen. */
function showQr(client, qr = QR_A) {
  client.setState({ qrIssuedAt: t.clock.now() });
  client.setQr(qr);
}

const issue = (client) => {
  client.pairingImpl = async () => ({ code: CODE, expiresAt: t.clock.now() + WINDOW });
};
const callsOf = (client, method) => client.calls.filter((c) => c.method === method);
const auditRows = (where = {}) => t.db.AuditLog.findAll({ where, raw: true, order: [["id", "ASC"]] });
const postCode = (http, phone = PHONE) => http.api("POST", "/admin/api/pairing/code", { phone });
const postLogout = (http, body = { confirm: true }) => http.api("POST", "/admin/api/pairing/logout", body);

/** Everything that could leak: logs, audit rows, every table. */
async function everythingWritten() {
  return JSON.stringify([t.logger.lines, await t.dumpTables(), t.printed]);
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

describe("route table", () => {
  test("the four routes declare their auth, csrf, touch and db flags", async () => {
    await boot();
    const byRoute = Object.fromEntries(t.admin.routes().filter((r) => PAIR_PATHS.includes(r.path)).map((r) => [`${r.method} ${r.path}`, r]));
    assert.equal(Object.keys(byRoute).length, 4);
    for (const route of Object.values(byRoute)) {
      assert.equal(route.auth, "session");
      assert.equal(route.db, "optional", "the pairing page works without the database");
    }
    assert.deepEqual(
      [byRoute["GET /admin/api/pairing"].touch, byRoute["GET /admin/api/pairing/qr.svg"].touch],
      [false, false],
      "a forgotten tab must still expire",
    );
    assert.equal(byRoute["POST /admin/api/pairing/code"].touch, true);
    assert.equal(byRoute["POST /admin/api/pairing/logout"].touch, true);
    assert.equal(byRoute["POST /admin/api/pairing/code"].csrf, true);
    assert.equal(byRoute["POST /admin/api/pairing/logout"].csrf, true);
    assert.equal(byRoute["GET /admin/api/pairing"].csrf, false);
  });

  test("every route needs a session", async () => {
    await boot();
    const anon = t.client();
    for (const answer of [
      await anon.get("/admin/api/pairing"),
      await anon.get("/admin/api/pairing/qr.svg"),
      await anon.api("POST", "/admin/api/pairing/code", { phone: PHONE }),
      await anon.api("POST", "/admin/api/pairing/logout", { confirm: true }),
    ]) {
      assert.equal(answer.status, 401);
      assert.equal(answer.json.error.code, "unauthenticated");
    }
    assert.deepEqual(callsOf(t.deps.client, "requestPairingCode"), []);
    assert.deepEqual(callsOf(t.deps.client, "resetSession"), []);
  });

  test("the unsafe routes refuse a missing CSRF token", async () => {
    const { client, http } = await boot();
    const headers = { "X-CSRF-Token": null };
    assert.equal((await http.api("POST", "/admin/api/pairing/code", { phone: PHONE }, { headers })).json.error.code, "csrf_invalid");
    assert.equal((await http.api("POST", "/admin/api/pairing/logout", { confirm: true }, { headers })).json.error.code, "csrf_invalid");
    assert.deepEqual(callsOf(client, "requestPairingCode"), []);
    assert.deepEqual(callsOf(client, "resetSession"), []);
  });
});

// ---------------------------------------------------------------------------
// PAIR-1
// ---------------------------------------------------------------------------

describe("PAIR-1", () => {
  test("a bot waiting for a scan: status, qr { version, issuedAt }, no code, no cooldown, never the QR string", async () => {
    const { client, http } = await boot();
    showQr(client);
    const answer = await http.get("/admin/api/pairing");
    assert.equal(answer.status, 200);
    assert.deepEqual(Object.keys(answer.json).sort(), ["code", "codeCooldownMs", "number", "qr", "registered", "status"]);
    assert.deepEqual(answer.json, {
      status: "qr",
      registered: false,
      number: null,
      qr: { version: 1, issuedAt: new Date(t.clock.now()).toISOString() },
      code: null,
      codeCooldownMs: 0,
    });
    assert.ok(!answer.text.includes(QR_A) && !answer.text.includes("secret"), "the QR string is not part of the answer");
  });

  test("a paired bot: registered, the number as digits, no QR", async () => {
    const { client, http } = await boot(fakes.fakeClient());
    client.setState({ me: { number: "237655443322", name: "Bot" } });
    const answer = await http.get("/admin/api/pairing");
    assert.deepEqual(answer.json, { status: "open", registered: true, number: "237655443322", qr: null, code: null, codeCooldownMs: 0 });
  });

  test("a pending code is reported by its expiry only; once the window is over it is not pending any more", async () => {
    const { client, http } = await boot();
    const expiresAt = t.clock.now() + WINDOW;
    client.setState({ pairing: { requestedAt: t.clock.now(), expiresAt } });
    const pending = (await http.get("/admin/api/pairing")).json.code;
    assert.deepEqual(pending, { pending: true, expiresAt: new Date(expiresAt).toISOString() });
    await t.clock.advance(WINDOW + 1000);
    assert.equal((await http.get("/admin/api/pairing")).json.code.pending, false);
  });

  test("codeCooldownMs counts down after a code was issued, and the code is not in the answer", async () => {
    const { client, http } = await boot();
    issue(client);
    assert.equal((await postCode(http)).status, 200);
    const first = await http.get("/admin/api/pairing");
    assert.equal(first.json.codeCooldownMs, COOLDOWN);
    assert.ok(!first.text.includes("ABCD"), "the code is sent once, by PAIR-3");
    await t.clock.advance(12000);
    assert.equal((await http.get("/admin/api/pairing")).json.codeCooldownMs, COOLDOWN - 12000);
    await t.clock.advance(COOLDOWN);
    assert.equal((await http.get("/admin/api/pairing")).json.codeCooldownMs, 0);
  });

  test("GET /admin/api/pairing does not need a client (the page still loads)", async () => {
    t = await createTestAdmin({ deps: { client: null } });
    const http = await t.loginClient();
    const answer = await http.get("/admin/api/pairing");
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { status: "idle", registered: false, number: null, qr: null, code: null, codeCooldownMs: 0 });
    assert.equal((await postCode(http)).json.error.code, "not_connected");
    assert.equal((await postLogout(http)).json.error.code, "not_connected");
  });

  test("it works while the process is still starting (db: optional), an ordinary route does not", async () => {
    const runtime = { dbReady: true };
    const { client, http } = await boot(unpairedClient(), { deps: { runtime } });
    runtime.dbReady = false; // the database is not ready: routes without db:r answer 503 starting
    showQr(client);
    assert.equal((await http.api("PATCH", "/admin/api/account/preferences", { theme: "auto" })).json.error.code, "starting");
    assert.equal((await http.get("/admin/api/pairing")).status, 200);
    assert.equal((await http.get("/admin/api/pairing/qr.svg")).status, 200);
    issue(client);
    assert.equal((await postCode(http)).status, 200);
    assert.equal((await postLogout(http)).status, 200);
  });
});

// ---------------------------------------------------------------------------
// PAIR-2
// ---------------------------------------------------------------------------

describe("PAIR-2", () => {
  test("404 no_qr when there is none (paired, or nothing issued yet)", async () => {
    const { client, http } = await boot(fakes.fakeClient());
    const paired = await http.get("/admin/api/pairing/qr.svg");
    assert.equal(paired.status, 404);
    assert.equal(paired.json.error.code, "no_qr");
    client.setState({ registered: false, status: "connecting" });
    assert.equal((await http.get("/admin/api/pairing/qr.svg?v=0")).json.error.code, "no_qr");
  });

  test("an SVG made by qrcode, no-store, with its own default-src 'none' policy", async () => {
    const { client, http } = await boot();
    showQr(client);
    const answer = await http.get("/admin/api/pairing/qr.svg?v=1", { headers: { Accept: "image/svg+xml" } });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get("content-type"), "image/svg+xml; charset=utf-8");
    assert.equal(answer.headers.get("cache-control"), "no-store");
    assert.equal(answer.headers.get("content-security-policy"), "default-src 'none'");
    assert.equal(answer.headers.get("x-content-type-options"), "nosniff");
    assert.equal(answer.headers.get("x-frame-options"), "DENY");
    assert.ok(![...answer.headers.keys()].some((name) => name.startsWith("access-control-")));
    assert.match(answer.text, /^<svg\b[^>]*viewBox="0 0 \d+ \d+"/);
    assert.match(answer.text, /<path\b/);
    assert.ok(!/<script|on\w+=|href=|<image/i.test(answer.text), "a pure drawing");
    assert.ok(!answer.text.includes(QR_A), "the payload is drawn, never written");
    const expected = await QRCode.toString(QR_A, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
    assert.equal(answer.text, expected, "what qrcode draws for this QR string");
  });

  test("`v` is a cache-buster only: the current QR is served, a renewal changes the picture", async () => {
    const { client, http } = await boot();
    showQr(client, QR_A);
    const first = await http.get("/admin/api/pairing/qr.svg?v=1");
    const same = await http.get("/admin/api/pairing/qr.svg?v=987654");
    assert.equal(same.text, first.text);
    showQr(client, QR_B);
    const renewed = await http.get("/admin/api/pairing/qr.svg?v=2");
    assert.notEqual(renewed.text, first.text);
    assert.equal((await http.get("/admin/api/pairing/qr.svg?v=1")).text, renewed.text, "still the current one");
    const bad = await http.get("/admin/api/pairing/qr.svg?v=abc");
    assert.equal(bad.status, 422);
    assert.equal(bad.json.error.code, "validation_failed");
    assert.equal((await http.get("/admin/api/pairing/qr.svg?other=1")).status, 422, "an unknown query parameter");
  });

  test("it is registered with the redactor, so a log line cannot carry it", async () => {
    const { client, http } = await boot();
    showQr(client);
    await http.get("/admin/api/pairing/qr.svg");
    assert.equal(redactor.scrub(`line ${QR_A} end`), "line [redacted] end");
  });

  test("same-origin: a cross-site request is refused, a browser <img> request (no Origin) is served", async () => {
    const { client, http } = await boot();
    showQr(client);
    const cross = await http.get("/admin/api/pairing/qr.svg", { headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(cross.status, 403);
    assert.equal(cross.json.error.code, "origin_mismatch");
    const foreign = await http.get("/admin/api/pairing/qr.svg", { headers: { Origin: "http://evil.example" } });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.json.error.code, "origin_mismatch");
    assert.ok(!cross.text.includes("<svg") && !foreign.text.includes("<svg"));
    // what an <img> of the page sends: Sec-Fetch-Site same-origin, no Origin header
    const image = await http.get("/admin/api/pairing/qr.svg", { guarded: false, headers: { "Sec-Fetch-Site": "same-origin" } });
    assert.equal(image.status, 200);
    assert.match(image.text, /^<svg/);
  });

  test("HEAD answers the headers of the GET without a body", async () => {
    const { client, http } = await boot();
    showQr(client);
    const head = await http.raw({ method: "HEAD", path: "/admin/api/pairing/qr.svg", headers: { Origin: t.base } });
    assert.equal(head.status, 200);
    assert.equal(head.headers["content-type"], "image/svg+xml; charset=utf-8");
    assert.equal(head.text, "");
  });
});

// ---------------------------------------------------------------------------
// PAIR-3
// ---------------------------------------------------------------------------

describe("PAIR-3", () => {
  test("`+` and spaces are stripped; the code is sent in this answer, with its expiry, and nowhere else", async () => {
    const { client, http } = await boot();
    issue(client);
    const answer = await postCode(http, " +1 202 555 0123 ");
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { code: CODE, expiresAt: new Date(t.clock.now() + WINDOW).toISOString() });
    assert.equal(answer.headers.get("cache-control"), "no-store");
    assert.deepEqual(callsOf(client, "requestPairingCode").map((c) => c.args), [[PHONE]], "the client gets digits only");
  });

  test("a bad number is a 422 with fields.phone = invalid_phone and never reaches the client", async () => {
    const { client, http } = await boot();
    issue(client);
    for (const phone of ["", "   ", "abc", "1234567", "1".repeat(16), "06-12-34-56-78", "+33 (6) 12 34 56 78", "1202555012x"]) {
      const answer = await postCode(http, phone);
      assert.equal(answer.status, 422, JSON.stringify(phone));
      assert.equal(answer.json.error.code, "validation_failed");
      assert.deepEqual(answer.json.error.fields, { phone: { code: "invalid_phone" } });
      if (phone.length >= 8) assert.ok(!answer.text.includes(phone), "the submitted value is not echoed");
    }
    assert.deepEqual(callsOf(client, "requestPairingCode"), []);
    assert.deepEqual(await auditRows({ action: "pair.code" }), [], "a rejected request is not audited");
  });

  test("a missing phone, a wrong type and an unknown property are validation errors", async () => {
    const { client, http } = await boot();
    issue(client);
    const missing = await http.api("POST", "/admin/api/pairing/code", {});
    assert.equal(missing.status, 422);
    assert.deepEqual(missing.json.error.fields, { phone: { code: "required" } });
    const typed = await http.api("POST", "/admin/api/pairing/code", { phone: 12025550123 });
    assert.deepEqual(typed.json.error.fields, { phone: { code: "invalid_type" } });
    const extra = await http.api("POST", "/admin/api/pairing/code", { phone: PHONE, force: true });
    assert.equal(extra.status, 422);
    assert.deepEqual(extra.json.error.fields, { $unknown: { code: "unknown_field" } });
    assert.deepEqual(callsOf(client, "requestPairingCode"), []);
  });

  test("409 already_paired when a session is registered; nothing is requested", async () => {
    const { client, http } = await boot(fakes.fakeClient());
    issue(client);
    const answer = await postCode(http);
    assert.equal(answer.status, 409);
    assert.equal(answer.json.error.code, "already_paired");
    assert.deepEqual(callsOf(client, "requestPairingCode"), []);
    assert.equal((await http.get("/admin/api/pairing")).json.codeCooldownMs, 0, "a refusal does not start the cooldown");
  });

  test("409 not_connected while the socket is not open for pairing (idle, reconnecting, restarting, stopped, logged_out)", async () => {
    const { client, http } = await boot();
    issue(client);
    for (const status of ["idle", "reconnecting", "restarting", "stopped", "logged_out"]) {
      client.setState({ status });
      const answer = await postCode(http);
      assert.equal(answer.status, 409, status);
      assert.equal(answer.json.error.code, "not_connected", status);
    }
    assert.deepEqual(callsOf(client, "requestPairingCode"), []);
    client.setState({ status: "connecting" });
    assert.equal((await postCode(http)).status, 200, "connecting is enough: the client waits for the socket itself");
  });

  test("429 rate_limited after one request per 30 s, with Retry-After; the client is asked once", async () => {
    const { client, http } = await boot();
    issue(client);
    assert.equal((await postCode(http)).status, 200);
    await t.clock.advance(8000);
    const again = await postCode(http);
    assert.equal(again.status, 429);
    assert.equal(again.json.error.code, "rate_limited");
    assert.equal(again.json.error.params.retryAfterMs, COOLDOWN - 8000);
    assert.equal(again.headers.get("retry-after"), "22");
    assert.equal(callsOf(client, "requestPairingCode").length, 1);

    await t.clock.advance(COOLDOWN - 8000);
    assert.equal((await postCode(http)).status, 200, "the slot is free again after 30 s");
    assert.equal(callsOf(client, "requestPairingCode").length, 2);
  });

  test("a double click is refused: the slot is claimed before WhatsApp answers", async () => {
    const { client, http } = await boot();
    let release;
    client.pairingImpl = () => new Promise((resolve) => (release = () => resolve({ code: CODE, expiresAt: t.clock.now() + WINDOW })));
    const first = postCode(http);
    await fakes.waitFor(() => callsOf(client, "requestPairingCode").length === 1);
    const second = await postCode(http);
    assert.equal(second.status, 429);
    release();
    assert.equal((await first).status, 200);
    assert.equal(callsOf(client, "requestPairingCode").length, 1);
  });

  test("what the client reports: rate_limited keeps its delay, pairing_failed is a 502 that keeps the cooldown", async () => {
    const { client, http } = await boot();
    const fail = (code, params) => {
      const error = new Error(code);
      error.name = "ClientError";
      error.code = code;
      if (params) error.params = params;
      return error;
    };

    client.pairingImpl = async () => {
      throw fail("rate_limited", { retryAfterMs: 12000 });
    };
    const limited = await postCode(http);
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error.params.retryAfterMs, 12000);
    assert.equal((await http.get("/admin/api/pairing")).json.codeCooldownMs, 12000);
    await t.clock.advance(12000);

    client.pairingImpl = async () => {
      throw fail("pairing_failed");
    };
    const failed = await postCode(http);
    assert.equal(failed.status, 502);
    assert.equal(failed.json.error.code, "whatsapp_error");
    assert.equal((await postCode(http)).status, 429, "the failed attempt counted");
    const rows = await auditRows({ action: "pair.code" });
    assert.deepEqual(rows.map((r) => [r.target, r.result, r.detail]), [["..23", "fail", null]]);
  });

  test("not_connecting and already_registered from the client are 409s that do not start the cooldown", async () => {
    const { client, http } = await boot();
    const fail = (code) => Object.assign(new Error(code), { name: "ClientError", code });
    client.pairingImpl = async () => {
      throw fail("not_connecting");
    };
    assert.equal((await postCode(http)).json.error.code, "not_connected");
    client.pairingImpl = async () => {
      throw fail("already_registered");
    };
    assert.equal((await postCode(http)).json.error.code, "already_paired");
    client.pairingImpl = async () => {
      throw fail("invalid_phone");
    };
    assert.deepEqual((await postCode(http)).json.error.fields, { phone: { code: "invalid_phone" } });
    issue(client);
    assert.equal((await postCode(http)).status, 200, "none of them took the slot");
  });

  test("an unexpected error is a 500 internal_error without detail, and frees the slot", async () => {
    const { client, http } = await boot();
    client.pairingImpl = async () => {
      throw new TypeError(`boom ${PHONE} ${CODE}`);
    };
    const answer = await postCode(http);
    assert.equal(answer.status, 500);
    assert.equal(answer.json.error.code, "internal_error");
    assert.ok(!answer.text.includes("boom") && !answer.text.includes(PHONE));
    issue(client);
    assert.equal((await postCode(http)).status, 200);
  });

  test("audit pair.code: the last two digits as target, no detail, no number, no code", async () => {
    const { client, http } = await boot();
    issue(client);
    await postCode(http, "+237 655 44 33 22");
    const rows = await auditRows({ action: "pair.code" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target, "..22");
    assert.equal(rows[0].result, "ok");
    assert.equal(rows[0].detail, null);
    assert.match(rows[0].origin, /\S/);
    const dump = JSON.stringify(await t.dumpTables());
    assert.ok(!dump.includes("237655443322") && !dump.includes("655443322") && !dump.includes("ABCD"));
  });

  test("the code is registered with the redactor", async () => {
    const { client, http } = await boot();
    issue(client);
    await postCode(http);
    assert.equal(redactor.scrub(`x ${CODE} y`), "x [redacted] y");
    assert.equal(redactor.scrub("x ABCD1234 y"), "x [redacted] y");
  });
});

// ---------------------------------------------------------------------------
// PAIR-4
// ---------------------------------------------------------------------------

describe("PAIR-4", () => {
  test("without confirm: true it is a 409 confirmation_required and nothing is done", async () => {
    const { client, http } = await boot(fakes.fakeClient());
    for (const body of [{}, { confirm: false }]) {
      const answer = await postLogout(http, body);
      assert.equal(answer.status, 409);
      assert.equal(answer.json.error.code, "confirmation_required");
      assert.deepEqual(answer.json.error.params, { confirm: "logout" });
    }
    const typed = await postLogout(http, { confirm: "yes" });
    assert.equal(typed.status, 422);
    assert.deepEqual(typed.json.error.fields, { confirm: { code: "invalid_type" } });
    const extra = await postLogout(http, { confirm: true, wipe: true });
    assert.equal(extra.status, 422);
    assert.deepEqual(callsOf(client, "resetSession"), []);
    assert.deepEqual(await auditRows({ action: "session.logout" }), []);
  });

  test("confirmed: resetSession() runs once, { ok: true }, audit session.logout", async () => {
    const { client, http } = await boot(fakes.fakeClient());
    client.resetImpl = async () => ({ removed: 4 });
    const answer = await postLogout(http);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { ok: true });
    assert.equal(callsOf(client, "resetSession").length, 1);
    assert.deepEqual(callsOf(client, "logout"), [], "logout() is not used: resetSession() closes the session itself");
    const rows = await auditRows({ action: "session.logout" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target, null);
    assert.equal(rows[0].result, "ok");
    assert.deepEqual(JSON.parse(rows[0].detail), { removed: 4 });
  });

  test("it works with the socket already down", async () => {
    const { client, http } = await boot(fakes.fakeClient());
    client.setState({ status: "stopped" });
    client.sock = null;
    client.isReady = false;
    const answer = await postLogout(http);
    assert.equal(answer.status, 200);
    assert.equal(callsOf(client, "resetSession").length, 1);
    // and from a bot that was unlinked from the phone
    client.setState({ status: "logged_out", registered: false });
    assert.equal((await postLogout(http)).status, 200);
  });

  test("it also clears the cooldown, so the next pairing can ask for a code at once", async () => {
    const { client, http } = await boot();
    issue(client);
    await postCode(http);
    assert.equal((await http.get("/admin/api/pairing")).json.codeCooldownMs, COOLDOWN);
    await postLogout(http);
    assert.equal((await http.get("/admin/api/pairing")).json.codeCooldownMs, 0);
  });

  test("a failing reset is a 500 without detail and leaves a fail row with the error code only", async () => {
    const { client, http } = await boot(fakes.fakeClient());
    client.resetImpl = async () => {
      throw Object.assign(new Error("EACCES /secret/path/sessions/main"), { name: "ClientError", code: "invalid_session_path" });
    };
    const answer = await postLogout(http);
    assert.equal(answer.status, 500);
    assert.equal(answer.json.error.code, "internal_error");
    assert.ok(!answer.text.includes("secret") && !answer.text.includes("sessions"));
    const rows = await auditRows({ action: "session.logout" });
    assert.deepEqual(rows.map((r) => [r.result, JSON.parse(r.detail)]), [["fail", { code: "invalid_session_path" }]]);
  });

  test("a restore in progress refuses it (mutating route) while the page itself still reads", async () => {
    const maintenance = { isActive: () => false };
    const { client, http } = await boot(fakes.fakeClient(), { deps: { maintenanceMode: maintenance } });
    maintenance.isActive = () => true;
    const answer = await postLogout(http);
    assert.equal(answer.status, 503);
    assert.equal(answer.json.error.code, "maintenance");
    assert.equal((await http.get("/admin/api/pairing")).status, 200);
    assert.deepEqual(callsOf(client, "resetSession"), []);
  });
});

// ---------------------------------------------------------------------------
// The hub topic and the event stream
// ---------------------------------------------------------------------------

describe("hub topic `pairing`", () => {
  test("one event per QR renewal and per status change, none when nothing changed", async () => {
    const { client } = await boot();
    const events = [];
    t.hub.subscribe("pairing", (payload) => events.push(payload));

    showQr(client, QR_A);
    assert.equal(events.length, 1, "the qr event and the state event of one renewal give one publication");
    assert.deepEqual(events[0].qr, { version: 1, issuedAt: new Date(t.clock.now()).toISOString() });
    assert.equal(events[0].status, "qr");

    showQr(client, QR_B);
    assert.equal(events.length, 2, "a renewal");
    assert.equal(events[1].qr.version, 2);

    client.setState({}); // a state event that changes nothing visible
    assert.equal(events.length, 2);

    client.setState({ status: "connecting", hasQr: false });
    assert.equal(events.length, 3, "a status change");
    assert.equal(events[2].status, "connecting");
    assert.equal(events[2].qr, null);

    client.setState({ status: "open", registered: true, me: { number: "237655443322", name: "Bot" } });
    assert.equal(events.length, 4);
    assert.deepEqual(events[3], { status: "open", registered: true, number: "237655443322", qr: null, code: null });
  });

  test("the payload is the PAIR-1 shape without the cooldown, with no QR string and no code", async () => {
    const { client, http } = await boot();
    issue(client);
    const events = [];
    t.hub.subscribe("pairing", (payload) => events.push(payload));
    showQr(client, QR_A);
    await postCode(http);
    client.setState({ pairing: { requestedAt: t.clock.now(), expiresAt: t.clock.now() + WINDOW } });
    assert.ok(events.length >= 2);
    for (const payload of events) {
      assert.deepEqual(Object.keys(payload).sort(), ["code", "number", "qr", "registered", "status"]);
    }
    assert.deepEqual(events.at(-1).code, { pending: true, expiresAt: new Date(t.clock.now() + WINDOW).toISOString() });
    const wire = JSON.stringify(events);
    assert.ok(!wire.includes(QR_A) && !wire.includes("secret") && !wire.includes("ABCD"));
  });

  test("a status change also pushes the dashboard state at once", async () => {
    const { client } = await boot();
    let snapshots = 0;
    t.hub.setSnapshot("state", () => ({ at: (snapshots += 1) }));
    const states = [];
    t.hub.subscribe("state", (payload) => states.push(payload));
    client.setState({ status: "connecting" });
    await fakes.waitFor(() => states.length >= 1);
    assert.ok(states.length >= 1);
    const before = states.length;
    showQr(client); // a QR renewal alone is not a state change of the bot
    client.setState({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(states.length, before + 1, "connecting -> qr is one more status change, the renewal itself adds nothing");
  });

  test("the snapshot (what a new stream receives first) is the current value", async () => {
    const { client } = await boot();
    showQr(client, QR_A);
    assert.deepEqual(await t.hub.snapshot("pairing"), {
      status: "qr",
      registered: false,
      number: null,
      qr: { version: 1, issuedAt: new Date(t.clock.now()).toISOString() },
      code: null,
    });
  });

  test("start() is idempotent and stop() unsubscribes and drops the snapshot", async () => {
    const { client } = await boot();
    assert.equal(client.listenerCount("qr"), 1);
    assert.equal(client.listenerCount("state"), 1);
    await t.admin.start();
    assert.equal(client.listenerCount("qr"), 1, "a second start() adds nothing");
    await t.admin.stop();
    assert.equal(client.listenerCount("qr"), 0);
    assert.equal(client.listenerCount("state"), 0);
    assert.equal(await t.hub.snapshot("pairing"), null);
  });

  test("the live stream carries the first pairing snapshot, then each renewal", async () => {
    const { client, http } = await boot();
    showQr(client, QR_A);
    const stream = await openEvents(http);
    cleanups.push(() => stream.close());
    assert.equal(stream.status, 200);
    await stream.waitFor((s) => s.events("pairing").length >= 1);
    assert.equal(stream.events("pairing")[0].payload.qr.version, 1);

    showQr(client, QR_B);
    await stream.waitFor((s) => s.events("pairing").length >= 2);
    assert.equal(stream.events("pairing")[1].payload.qr.version, 2);
    assert.ok(!stream.text.includes(QR_A) && !stream.text.includes(QR_B) && !stream.text.includes("secret"));
  });
});

// ---------------------------------------------------------------------------
// The service on its own
// ---------------------------------------------------------------------------

describe("createPairingService", () => {
  const { createPairingService } = require("../lib/admin/services/pairing");
  const fakeHub = () => {
    const published = [];
    const snapshots = new Map();
    return {
      published,
      snapshots,
      publish: (topic, payload) => published.push([topic, payload]),
      setSnapshot: (topic, fn) => (fn ? snapshots.set(topic, fn) : snapshots.delete(topic)),
    };
  };

  test("start() twice subscribes once; stop() unsubscribes; a hub without publishState is tolerated", () => {
    const client = unpairedClient();
    const hub = fakeHub();
    const service = createPairingService({ getClient: () => client, hub, now: () => 1000 });
    assert.equal(client.listenerCount("qr"), 0, "nothing is subscribed at creation");
    service.start();
    service.start();
    assert.equal(client.listenerCount("qr"), 1);
    assert.equal(client.listenerCount("state"), 1);
    assert.equal(hub.snapshots.get("pairing")().status, "qr");

    client.setState({ status: "connecting" });
    assert.deepEqual(hub.published.map(([topic, payload]) => [topic, payload.status]), [["pairing", "connecting"]]);

    service.stop();
    service.stop();
    assert.equal(client.listenerCount("qr"), 0);
    assert.equal(client.listenerCount("state"), 0);
    assert.equal(hub.snapshots.has("pairing"), false);
    client.setState({ status: "stopped" });
    assert.equal(hub.published.length, 1, "nothing after stop()");
  });

  test("without a client every method answers calmly", async () => {
    const service = createPairingService({ getClient: () => null, hub: fakeHub(), now: () => 1000 });
    service.start();
    assert.deepEqual(service.describe(), { status: "idle", registered: false, number: null, qr: null, code: null, codeCooldownMs: 0 });
    assert.equal(await service.qrSvg(), null);
    await assert.rejects(service.requestCode("12025550123"), { code: "not_connected" });
    await assert.rejects(service.closeSession(), { code: "not_connected" });
    service.stop();
  });

  test("parsePhone follows the contract: spaces and + are stripped, nothing else is", () => {
    const service = createPairingService({ getClient: () => null, hub: fakeHub() });
    assert.equal(service.parsePhone("+1 202 555 0123"), "12025550123");
    assert.equal(service.parsePhone("12345678"), "12345678");
    for (const bad of ["1234567", "1234567890123456", "12-345-678", "(12)345678", "", "abcdefgh", null, undefined]) {
      assert.throws(() => service.parsePhone(bad), (err) => err.code === "validation_failed" && err.fields.phone.code === "invalid_phone", String(bad));
    }
  });

  test("the QR rendering is cached per QR string and re-drawn on a renewal", async () => {
    const client = unpairedClient();
    let renders = 0;
    const loadQr = () => ({ toString: async (text) => `<svg>${(renders += 1)}:${text.length}</svg>` });
    const service = createPairingService({ getClient: () => client, hub: fakeHub(), loadQr });
    showQrOn(client, QR_A, 1);
    const a1 = await service.qrSvg();
    const a2 = await service.qrSvg();
    assert.equal(a1, a2);
    assert.equal(renders, 1);
    showQrOn(client, QR_B, 2);
    assert.notEqual(await service.qrSvg(), a1);
    assert.equal(renders, 2);
    redactor.unregister("qr:1");
    redactor.unregister("qr:2");
  });

  function showQrOn(client, qr, version) {
    client.fakeQr = qr;
    client.fakeState = { ...client.fakeState, status: "qr", hasQr: true, qrVersion: version };
  }
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe("secrets", () => {
  test("a whole pairing session leaves no QR string, code or number in a log, an audit row or an error body", async () => {
    const { client, http } = await boot();
    issue(client);
    showQr(client, QR_A);
    const answers = [
      await http.get("/admin/api/pairing"),
      await postCode(http, "bad number secret-9876"),
      await postCode(http, "+237 655 44 33 22"),
      await postCode(http, "+237 655 44 33 22"), // 429
      await postLogout(http, {}),
      await postLogout(http),
    ];
    client.setState({ registered: true, status: "open" });
    answers.push(await postCode(http)); // 409
    const errorBodies = answers.filter((a) => a.status >= 400).map((a) => a.text).join("\n");
    assert.ok(answers.filter((a) => a.status >= 400).length >= 4);
    for (const secret of [QR_A, "alpha-secret", "ABCD", "237655443322", "655443322", "secret-9876"]) {
      assert.ok(!errorBodies.includes(secret), `error bodies: ${secret}`);
    }
    const written = await everythingWritten();
    for (const secret of [QR_A, "alpha-secret", "ABCD-1234", "ABCD1234", "237655443322", "655443322", "secret-9876"]) {
      assert.ok(!written.includes(secret), `logs, audit and tables: ${secret}`);
    }
  });
});

// ---------------------------------------------------------------------------
// The real client
// ---------------------------------------------------------------------------

describe("with the real WhatsAppClient on a fake Baileys", () => {
  /** The real client in a temporary sessions directory, behind the admin. */
  async function realClient() {
    const log = mock.method(console, "log", () => {});
    const error = mock.method(console, "error", () => {});
    const env = loadClientWithFakeBaileys({ registered: false, pairingCode: "ABCD1234" });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-pairing-"));
    cleanups.push(() => {
      env.restore();
      log.mock.restore();
      error.mock.restore();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const client = new env.WhatsAppClient("main", { sessionsRoot: root });
    await client.initialize();
    return { env, client, root };
  }

  test("a QR, a code and a reset travel through the routes and the hub", async () => {
    const { env, client, root } = await realClient();
    const { http } = await boot(client);
    const events = [];
    t.hub.subscribe("pairing", (payload) => events.push(payload));

    env.qr(env.last(), QR_A);
    const first = await http.get("/admin/api/pairing");
    assert.equal(first.json.status, "qr");
    assert.equal(first.json.registered, false);
    assert.equal(first.json.qr.version, 1);
    assert.match(first.json.qr.issuedAt, /^\d{4}-\d\d-\d\dT/);
    assert.ok(events.some((e) => e.qr && e.qr.version === 1), "the QR reached the hub");
    assert.ok(!first.text.includes(QR_A));

    const svg = await http.get("/admin/api/pairing/qr.svg?v=1");
    assert.equal(svg.status, 200);
    assert.equal(svg.text, await QRCode.toString(QR_A, { type: "svg", margin: 2, errorCorrectionLevel: "M" }));

    env.qr(env.last(), QR_B);
    assert.ok(events.some((e) => e.qr && e.qr.version === 2), "the renewal reached the hub");
    assert.notEqual((await http.get("/admin/api/pairing/qr.svg")).text, svg.text);

    const code = await postCode(http, "+1 202 555 0123");
    assert.equal(code.status, 200);
    assert.equal(code.json.code, CODE);
    assert.ok(Date.parse(code.json.expiresAt) > Date.now(), "about three minutes from the real clock of the client");
    assert.deepEqual(env.last().calls.filter((c) => c.method === "requestPairingCode").map((c) => c.args), [[PHONE]]);
    assert.equal(events.at(-1).code.pending, true);
    assert.ok(!JSON.stringify(events).includes("ABCD"));

    // the service lets a second request through after 30 s of the fake clock, the real client still refuses it
    await t.clock.advance(COOLDOWN);
    const early = await postCode(http);
    assert.equal(early.status, 429);
    assert.ok(early.json.error.params.retryAfterMs > 0);

    // a session on disk is wiped by PAIR-4, the contents only
    fs.mkdirSync(path.join(root, "main"), { recursive: true });
    fs.writeFileSync(path.join(root, "main", "creds.json"), "{}");
    const logout = await postLogout(http);
    assert.equal(logout.status, 200);
    assert.deepEqual(fs.readdirSync(path.join(root, "main")), []);
    assert.ok(fs.existsSync(path.join(root, "main")), "the folder itself stays (volume mount)");
    const rows = await auditRows({ action: "session.logout" });
    assert.deepEqual(JSON.parse(rows[0].detail), { removed: 1 });
    assert.ok(events.some((e) => e.status === "logged_out"), "the reset was published");
    assert.equal((await http.get("/admin/api/pairing")).json.codeCooldownMs, 0);

    const written = await everythingWritten();
    for (const secret of [QR_A, QR_B, "ABCD1234", "ABCD-1234", PHONE]) assert.ok(!written.includes(secret), secret);
    assert.equal(redactor.scrub(`x ${QR_A} y`), "x [redacted] y", "registered by the client");
  });

  test("a bot that is paired is not offered a code", async () => {
    const log = mock.method(console, "log", () => {});
    cleanups.push(() => log.mock.restore());
    const env = loadClientWithFakeBaileys({ registered: true });
    cleanups.push(() => env.restore());
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-pairing-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const client = new env.WhatsAppClient("main", { sessionsRoot: root });
    await client.initialize();
    env.open(env.last());
    const { http } = await boot(client);
    const state = await http.get("/admin/api/pairing");
    assert.equal(state.json.status, "open");
    assert.equal(state.json.registered, true);
    const answer = await postCode(http);
    assert.equal(answer.status, 409);
    assert.equal(answer.json.error.code, "already_paired");
    assert.equal((await http.get("/admin/api/pairing/qr.svg")).json.error.code, "no_qr");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open the event stream of a logged-in browser; frames are parsed on demand. */
function openEvents(browser) {
  return new Promise((resolve, reject) => {
    const cookie = Object.entries(browser.cookies())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    const req = nodeHttp.request(
      { host: "127.0.0.1", port: t.port, path: "/admin/api/events?logs=0", headers: { Cookie: cookie, Origin: t.base, Accept: "text/event-stream" }, agent: false },
      (res) => {
        res.setEncoding("utf8");
        const stream = {
          status: res.statusCode,
          text: "",
          events(name) {
            return stream.text
              .split("\n\n")
              .map((block) => {
                const frame = {};
                for (const line of block.split("\n")) {
                  const i = line.indexOf(":");
                  if (i > 0) frame[line.slice(0, i)] = line.slice(i + 1).trimStart();
                }
                if (frame.data !== undefined) {
                  try {
                    frame.payload = JSON.parse(frame.data);
                  } catch {
                    frame.payload = undefined;
                  }
                }
                return frame;
              })
              .filter((frame) => frame.event === name && frame.payload !== undefined);
          },
          close: () => req.destroy(),
          async waitFor(predicate, timeout = 3000) {
            const ok = await fakes.waitFor(() => predicate(stream), { timeout });
            if (!ok) assert.fail(`timeout; received so far: ${JSON.stringify(stream.text.slice(-300))}`);
          },
        };
        res.on("data", (chunk) => {
          stream.text += chunk;
        });
        res.on("error", () => {});
        resolve(stream);
      },
    );
    req.on("error", reject);
    req.end();
  });
}
