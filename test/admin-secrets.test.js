"use strict";
/**
 * SC-004 (T218; admin-http-api.md section 5, item 8): seeded secrets are found nowhere.
 *
 * Distinct, recognisable values are planted in every place a secret can live:
 *   - the 22 secret settings, from the environment (and, for the 10 editable ones, a second value written through the
 *     panel, so the override rows are exercised too), PANEL_TOKEN, SESSION_ID and the DATABASE_URL password;
 *   - the administrator's password, the setup token, the CSRF token, the session cookie, a fake QR string and the
 *     pairing sentinels of the fake runtime, a backup passphrase.
 *
 * The real admin (every real service and engine, test/helpers/adminFull.js) then runs a long scenario: the setup,
 * wrong logins until the origin is blocked, the settings written, every GET route (the event stream included), a
 * hostile request to every other route, every error path (invalid secret submissions, stale versions, malformed
 * bodies, missing CSRF, wrong origin, unknown paths with a probe in the query), a key test, an export and the
 * inspection of the archive. Then every sink is searched for every value:
 *   response bodies and headers (the Set-Cookie of the session is excepted by design, the CSRF token may only be in
 *   the answers that deliver it), the log ring, the logger output and the console, the audit_logs and alert_outbox
 *   tables, a dump of the whole database, the exported file and its manifest.
 * A value of a key matches when its first characters (all but the last four) are found: `last4` is the one part that
 * may be shown. The scan is checked against itself: it must detect a planted value in each kind of sink.
 *
 * Offline: no network (stubbed), an in-memory database, the secret key in a temporary directory.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const fakes = require("./helpers/fakes");

const hex = (bytes = 6) => crypto.randomBytes(bytes).toString("hex");

// ---------------------------------------------------------------------------
// The seeds
// ---------------------------------------------------------------------------

const catalogModule = require("../lib/utils/settingsCatalog");
const SECRET_KEYS = catalogModule.entries.filter((entry) => entry.secret).map((entry) => entry.key);
const EDITABLE_SECRET_KEYS = catalogModule.entries.filter((entry) => entry.secret && !entry.readonly).map((entry) => entry.key);

const DB_PASSWORD = `dbpass${hex(5)}Zq`;
const ENV_SEEDS = {};
SECRET_KEYS.forEach((key, index) => {
  ENV_SEEDS[key] = key === "DATABASE_URL" ? `postgres://seeduser:${DB_PASSWORD}@db.example.invalid:5432/seed` : `envseed-${key.toLowerCase()}-${hex()}-E${index % 10}x9`;
});
const PANEL_SEEDS = {};
EDITABLE_SECRET_KEYS.forEach((key, index) => {
  PANEL_SEEDS[key] = `panelseed-${key.toLowerCase()}-${hex()}-P${index % 10}z7`;
});

const ADMIN_PASSWORD = `Adm1n-pass-${hex()}-seed`;
const NEW_PASSWORD = `New-pass-${hex()}-seed`;
const WRONG_PASSWORDS = Array.from({ length: 6 }, (_, i) => `wrong-login-${i}-${hex(4)}`);
const SHORT_SETUP_PASSWORD = "QzKrTv7"; // 7 characters: refused by the setup (12 at least)
const BACKUP_PASSPHRASE = `backup-pass-${hex()}-seed`;
const WRONG_PASSPHRASE = `wrong-backup-pass-${hex()}`;
const SHORT_PASSPHRASE = "Wd7Hn3Kx"; // 8 characters: refused (12 at least)
const QR_STRING = `2@QRSEED${hex(12)},${hex(8)}==`;
const PROBE = `probe-${hex()}-unknown`;
const INVALID_SECRET = `inv alid secret ${hex()}`; // a space: refused by the charset rule
const TOO_SHORT_SECRET = "KjTq7Zx"; // 7 characters: refused (8 at least)
const TOO_LONG_SECRET = `toolong-${hex()}-${"L".repeat(260)}`;
const STALE_SECRET = `stale-version-${hex()}-S1t2`;
const READONLY_ATTEMPT = `attempt-session-${hex()}-R0n1`;
const DB_ATTEMPT_PASSWORD = `newdbpw${hex(5)}Qx`;
const MALFORMED_SECRET = `malformed-${hex()}-M4l5`;
const WRONG_CURRENT_PASSWORD = `current-wrong-${hex()}`;

fakes.setupEnv({ env: ENV_SEEDS_WITHOUT_DATABASE() });
fakes.stubNetwork();

function ENV_SEEDS_WITHOUT_DATABASE() {
  const copy = { ...ENV_SEEDS };
  delete copy.DATABASE_URL; // the database of the test is :memory: until the store has been built
  return copy;
}

const { createFullAdmin } = require("./helpers/adminFull");
const { QR_SENTINEL, CODE_SENTINEL } = require("./helpers/fakeBotRuntime");
const { openEventStream } = require("./helpers/sseTap");
const { readAll } = require("./helpers/backupKit");
const settingsStore = require("../lib/utils/settingsStore");
const loggerModule = require("../lib/utils/logger");
const ring = require("../lib/admin/logs/ring");
const redactor = require("../lib/admin/logs/redactor");
const maintenanceMode = require("../lib/utils/maintenanceMode");

// ---------------------------------------------------------------------------
// The needles
// ---------------------------------------------------------------------------

/** { name, text, allowIn: [labels where it may legitimately appear] } */
const needles = [];
/** A key's value matches by everything but its last four characters (`last4` is the part that may be shown) */
const addKey = (name, value) => needles.push({ name, text: value.slice(0, -4), allowIn: [] });
const addValue = (name, value, allowIn = []) => needles.push({ name, text: value, allowIn });

for (const key of SECRET_KEYS) {
  if (key === "DATABASE_URL") {
    addValue("env:DATABASE_URL", ENV_SEEDS[key]);
    addValue("env:DATABASE_URL password", DB_PASSWORD);
  } else {
    addKey(`env:${key}`, ENV_SEEDS[key]);
  }
}
for (const key of EDITABLE_SECRET_KEYS) addKey(`panel:${key}`, PANEL_SEEDS[key]);
addValue("admin password", ADMIN_PASSWORD);
addValue("new password", NEW_PASSWORD);
WRONG_PASSWORDS.forEach((value, i) => addValue(`wrong password ${i}`, value));
addValue("short setup password", SHORT_SETUP_PASSWORD);
addValue("backup passphrase", BACKUP_PASSPHRASE);
addValue("wrong passphrase", WRONG_PASSPHRASE);
addValue("short passphrase", SHORT_PASSPHRASE);
addValue("QR string", QR_STRING);
addValue("QR sentinel", QR_SENTINEL);
addValue("pairing code sentinel", CODE_SENTINEL);
addValue("probe", PROBE);
addValue("invalid secret", INVALID_SECRET);
addValue("too short secret", TOO_SHORT_SECRET);
addValue("too long secret", TOO_LONG_SECRET.slice(0, 40));
addValue("stale secret", STALE_SECRET);
addValue("read-only attempt", READONLY_ATTEMPT);
addValue("database attempt", DB_ATTEMPT_PASSWORD);
addValue("malformed secret", MALFORMED_SECRET);
addValue("wrong current password", WRONG_CURRENT_PASSWORD);

/** The names of the needles found in `text` (outside the ones the label may carry) */
function leaksIn(text, label = "") {
  const found = [];
  for (const needle of needles) {
    if (needle.allowIn.some((allowed) => label.startsWith(allowed))) continue;
    if (text.includes(needle.text)) found.push(needle.name);
  }
  return found;
}

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

const G = "120363000000000001@g.us";
const U = "237600000001@s.whatsapp.net";
const SAMPLE = { jid: G, userJid: U, id: "1", runId: "1", name: "ping", kind: "reminders", lang: "en", key: "common.error", service: "openai", category: "logs" };
/** Routes whose valid-header probe could do something even with an unknown field: they are only hit without CSRF */
const SKIP_PROBE = new Set([
  "POST /admin/api/logout",
  "POST /admin/api/restart",
  "POST /admin/api/pairing/logout",
  "POST /admin/api/backup/restore",
  "POST /admin/api/maintenance/update/apply",
  "POST /admin/api/maintenance/ytdlp/update",
  "POST /admin/api/maintenance/storage/:category/purge",
  "PUT /admin/api/uploads",
]);

/** every response of the scenario: { label, status, headers, text, buffer? } */
const responses = [];
const captured = { logger: [], console: [] };

let t;
let client;
let tmp;
let exportedFile;
let outbox;
let auditRows;
let dump;
let consoleMocks = [];
let savedEnv;

/** Record a response of node:http (`raw`) or fetch (`api`/`get`) shape */
function record(label, res) {
  const headers = {};
  const source = res.headers;
  if (source && typeof source.entries === "function") for (const [name, value] of source.entries()) headers[name.toLowerCase()] = value;
  else for (const [name, value] of Object.entries(source || {})) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  delete headers["set-cookie"]; // the session cookie is the one exception, by design (its names are checked apart)
  responses.push({ label, status: res.status, headers, text: res.buffer ? res.buffer.toString("latin1") : String(res.text || ""), setCookies: res.setCookies || [] });
  return res;
}

/** The upload ids are 32 hexadecimal characters; the other parameters take the samples above */
const fill = (routePath) =>
  routePath.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_, name) =>
    encodeURIComponent(routePath.startsWith("/admin/api/uploads/") && name === "id" ? "0".repeat(32) : SAMPLE[name] || "x1"),
  );
const csrfHeaders = (extra = {}) => ({ Origin: t.base, "X-CSRF-Token": client.csrf, "Content-Type": "application/json", Accept: "application/json", ...extra });

async function scenario() {
  const fresh = t.client();

  // ----- before any account -----
  record("anonymous session", await fresh.get("/admin/api/session"));
  record("index page", await fresh.get("/admin/", { guarded: false }));
  record("unknown static file", await fresh.get("/admin/nope.js?x=" + PROBE, { guarded: false }));
  record("setup with a wrong token", await fresh.get(`/admin/setup?token=${PROBE}`, { guarded: false }));

  // ----- setup: a short password is refused, then the real one -----
  const link = t.lastLink();
  assert.ok(link, "the setup link was printed");
  record("setup landing", await fresh.get(`/admin/setup?token=${encodeURIComponent(link.token)}`, { guarded: false }));
  record("setup short password", await fresh.api("POST", "/admin/api/setup", { password: SHORT_SETUP_PASSWORD }));
  const setup = record("setup", await fresh.api("POST", "/admin/api/setup", { password: ADMIN_PASSWORD }));
  assert.equal(setup.status, 200, setup.text);
  client = fresh;

  // ----- wrong logins until the origin is blocked (an alert is raised), then the clock moves on -----
  const stranger = t.client();
  for (const [i, password] of WRONG_PASSWORDS.entries()) {
    record(`wrong login ${i}`, await stranger.api("POST", "/admin/api/login", { password }));
  }
  record("login while blocked", await stranger.api("POST", "/admin/api/login", { password: ADMIN_PASSWORD }));
  await t.clock.advance(16 * 60 * 1000);
  const login = record("login", await stranger.api("POST", "/admin/api/login", { password: ADMIN_PASSWORD }));
  assert.equal(login.status, 200, login.text);
  record("session", await client.get("/admin/api/session"));

  // ----- the bot has a QR; the panel stores its own key values -----
  t.botClient.setQr(QR_STRING);
  const first = await client.get("/admin/api/settings");
  record("settings before", first);
  const changes = EDITABLE_SECRET_KEYS.map((key) => ({ key, op: "set", value: PANEL_SEEDS[key], version: 0 }));
  const written = record("settings write", await client.api("PATCH", "/admin/api/settings", { changes }));
  assert.equal(written.status, 200, written.text);
  scenario.written = written.json;

  // ----- every GET route (the stream apart), anonymous public ones included -----
  const routes = t.admin.routes();
  for (const route of routes.filter((r) => r.method === "GET" && r.auth === "session" && r.path !== "/admin/api/events")) {
    record(`GET ${route.path}`, await client.get(fill(route.path)));
  }
  const stream = await openEventStream({ port: t.port, client, target: "/admin/api/events?logs=1&since=0", headers: { Origin: t.base } });
  try {
    await stream.waitFor((s) => s.events("state").length >= 1 && s.events("pairing").length >= 1, 3000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    record("event stream", { status: stream.status, headers: stream.headers, text: stream.text });
  } finally {
    stream.close();
  }
  record("GET qr.svg", await client.get("/admin/api/pairing/qr.svg?v=1"));

  // ----- a hostile request to every other route: valid headers, an unknown field; then without a CSRF token -----
  for (const route of routes.filter((r) => r.method !== "GET" && r.auth === "session")) {
    const key = `${route.method} ${route.path}`;
    if (!SKIP_PROBE.has(key)) {
      const res = record(`probe ${key}`, await client.api(route.method, fill(route.path), { [PROBE]: PROBE }));
      assert.ok(res.status >= 400 && res.status < 500, `${key} -> ${res.status}`);
    }
    if (route.path !== "/admin/api/uploads") {
      const res = record(`no csrf ${key}`, await client.api(route.method, fill(route.path), { [PROBE]: PROBE }, { headers: { "X-CSRF-Token": null } }));
      assert.equal(res.status, 403, `${key} without a CSRF token -> ${res.status}`);
    }
  }

  // ----- settings: every way a secret submission can go wrong -----
  const settingsErrors = [
    ["invalid charset", [{ key: "OPENAI_API_KEY", op: "set", value: INVALID_SECRET, version: 1 }]],
    ["too short", [{ key: "GEMINI_API_KEY", op: "set", value: TOO_SHORT_SECRET, version: 1 }]],
    ["too long", [{ key: "NEWS_API_KEY", op: "set", value: TOO_LONG_SECRET, version: 1 }]],
    ["stale version", [{ key: "WEATHER_API_KEY", op: "set", value: STALE_SECRET, version: 0 }]],
    ["read-only SESSION_ID", [{ key: "SESSION_ID", op: "set", value: READONLY_ATTEMPT, version: 0 }]],
    ["read-only DATABASE_URL", [{ key: "DATABASE_URL", op: "set", value: `postgres://u:${DB_ATTEMPT_PASSWORD}@h/db`, version: 0 }]],
    ["unknown key", [{ key: "NOT_A_SETTING", op: "set", value: MALFORMED_SECRET, version: 0 }]],
    ["wrong type", [{ key: "GIPHY_API_KEY", op: "set", value: { nested: MALFORMED_SECRET }, version: 1 }]],
  ];
  for (const [label, body] of settingsErrors) {
    const res = record(`settings error: ${label}`, await client.api("PATCH", "/admin/api/settings", { changes: body }));
    assert.ok(res.status >= 400 && res.status < 500, `${label} -> ${res.status}`);
  }
  record("settings: unknown top-level field", await client.api("PATCH", "/admin/api/settings", { changes: [], [PROBE]: MALFORMED_SECRET }));
  record(
    "settings: malformed JSON",
    await client.raw({
      method: "PATCH",
      path: "/admin/api/settings",
      headers: csrfHeaders(),
      body: `{"changes":[{"key":"OPENAI_API_KEY","op":"set","value":"${MALFORMED_SECRET}"`,
    }),
  );
  record(
    "settings: text/plain",
    await client.raw({ method: "PATCH", path: "/admin/api/settings", headers: csrfHeaders({ "Content-Type": "text/plain" }), body: `OPENAI_API_KEY=${MALFORMED_SECRET}` }),
  );
  record(
    "settings: wrong origin",
    await client.raw({ method: "PATCH", path: "/admin/api/settings", headers: csrfHeaders({ Origin: "https://evil.example" }), body: JSON.stringify({ changes: [{ key: "OPENAI_API_KEY", op: "set", value: MALFORMED_SECRET, version: 1 }] }) }),
  );
  record(
    "settings: no csrf",
    await client.raw({ method: "PATCH", path: "/admin/api/settings", headers: csrfHeaders({ "X-CSRF-Token": "wrong-token" }), body: JSON.stringify({ changes: [{ key: "OPENAI_API_KEY", op: "set", value: MALFORMED_SECRET, version: 1 }] }) }),
  );
  record("settings: after the errors", await client.get("/admin/api/settings"));

  // ----- a key test (the network is stubbed), a revert of a secret with a stale version -----
  record("key test openai", await client.api("POST", "/admin/api/settings/keys/openai/test"));
  record("key test unknown service", await client.api("POST", `/admin/api/settings/keys/${PROBE}/test`));

  // ----- the account: a wrong current password -----
  record("password change, wrong current", await client.api("PATCH", "/admin/api/account/password", { currentPassword: WRONG_CURRENT_PASSWORD, newPassword: NEW_PASSWORD }));
  record("logout without csrf", await client.api("POST", "/admin/api/logout", undefined, { headers: { "X-CSRF-Token": null } }));

  // ----- unknown paths and wrong methods, with the probe in the query string -----
  record("unknown api path", await client.get(`/admin/api/nothing-here?token=${PROBE}&key=${PROBE}`));
  record("wrong method", await client.api("DELETE", `/admin/api/state?x=${PROBE}`));
  record("OPTIONS", await client.raw({ method: "OPTIONS", path: `/admin/api/settings?x=${PROBE}`, headers: { Origin: "https://evil.example" } }));
  record("traversal", await client.raw({ method: "GET", path: `/admin/..%2f..%2fconfig.env?x=${PROBE}` }));

  // ----- backups: export, a wrong passphrase, a too short one -----
  record("export too short passphrase", await client.api("POST", "/admin/api/backup/export", { passphrase: SHORT_PASSPHRASE }));
  record("export unknown field", await client.api("POST", "/admin/api/backup/export", { passphrase: BACKUP_PASSPHRASE, [PROBE]: 1 }));
  const exported = await client.raw({ method: "POST", path: "/admin/api/backup/export", headers: csrfHeaders({ Accept: "*/*" }), body: JSON.stringify({ passphrase: BACKUP_PASSPHRASE }) });
  assert.equal(exported.status, 200, exported.text);
  record("backup file", exported);
  exportedFile = path.join(tmp, "export.owb");
  fs.writeFileSync(exportedFile, exported.buffer);
  const upload = await client.raw({
    method: "PUT",
    path: "/admin/api/uploads?purpose=backup&name=backup.owb",
    headers: { Origin: t.base, "Content-Type": "application/octet-stream", "X-CSRF-Token": client.csrf },
    body: exported.buffer,
  });
  assert.equal(upload.status, 201, upload.text);
  record("upload", upload);
  record("inspect wrong passphrase", await client.api("POST", "/admin/api/backup/inspect", { uploadId: upload.json.uploadId, passphrase: WRONG_PASSPHRASE }));
  const inspected = record("inspect", await client.api("POST", "/admin/api/backup/inspect", { uploadId: upload.json.uploadId, passphrase: BACKUP_PASSPHRASE }));
  assert.equal(inspected.status, 200, inspected.text);
  record("restore with an unknown token", await client.api("POST", "/admin/api/backup/restore", { restoreToken: PROBE, confirm: true }));

  // ----- the sinks that are not responses -----
  outbox = JSON.stringify((await t.db.AlertOutbox.findAll({ raw: true })).concat(await t.db.AlertState.findAll({ raw: true })));
  auditRows = (await t.db.AuditLog.findAll({ raw: true, order: [["id", "ASC"]] })).map((row) => JSON.stringify(row));
  dump = await t.dumpTables();
}

// ---------------------------------------------------------------------------

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-admin-secrets-"));
  savedEnv = { DATABASE_URL: process.env.DATABASE_URL };

  ring.clear();
  loggerModule.setLevel("debug");
  loggerModule.setOutput((text) => captured.logger.push(String(text)));
  for (const name of ["log", "info", "warn", "error", "debug"]) {
    consoleMocks.push(mock.method(console, name, (...args) => captured.console.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "))));
  }

  t = await createFullAdmin({
    // the database URL with a password is only for the settings store: the connection of the test is :memory: already
    setup: { env: ENV_SEEDS },
    logger: loggerModule.createLogger("admin"),
  });
  settingsStore._env = null; // read the environment again, DATABASE_URL included
  maintenanceMode._reset();
  await t.admin.start();
  await scenario();
});

after(async () => {
  for (const m of consoleMocks) m.mock.restore();
  loggerModule.setOutput();
  loggerModule.setLevel("silent");
  process.env.DATABASE_URL = savedEnv.DATABASE_URL;
  for (const key of SECRET_KEYS) process.env[key] = "";
  process.env.DATABASE_URL = ":memory:";
  settingsStore._env = null;
  if (t) await t.closeFull();
  fs.rmSync(tmp, { recursive: true, force: true });
  ring.clear();
});

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

describe("the scan is not vacuous", () => {
  test("it finds a planted value in a response body, a header, a log line, a table row and a binary file", () => {
    const key = EDITABLE_SECRET_KEYS[0];
    assert.deepEqual(leaksIn(`{"value":"${PANEL_SEEDS[key]}"}`), [`panel:${key}`]);
    assert.deepEqual(leaksIn(`prefix ${PANEL_SEEDS[key].slice(0, -4)}`), [`panel:${key}`], "all but the last four characters is a leak");
    assert.deepEqual(leaksIn(`last4 only: ${PANEL_SEEDS[key].slice(-4)}`), []);
    assert.deepEqual(leaksIn(`postgres://x:${DB_PASSWORD}@h/db`), ["env:DATABASE_URL password"]);
    assert.deepEqual(leaksIn(Buffer.from(`xx${ADMIN_PASSWORD}xx`).toString("latin1")), ["admin password"]);
  });

  test("the scenario ran: every kind of sink has content", () => {
    assert.ok(responses.length > 120, `${responses.length} responses recorded`);
    assert.ok(responses.some((r) => r.label === "event stream" && r.text.includes("event: state")));
    assert.ok(responses.filter((r) => r.label.startsWith("GET /admin/api/")).length >= 25);
    assert.ok(responses.filter((r) => r.status === 422).length >= 10, "validation failures were provoked");
    assert.ok(responses.some((r) => r.status === 429), "the origin was blocked");
    assert.ok(captured.logger.length > 10, `${captured.logger.length} logger lines`);
    assert.ok(ring.list({ limit: 100000 }).length > 10);
    assert.ok(auditRows.length >= EDITABLE_SECRET_KEYS.length, `${auditRows.length} audit rows`);
    assert.match(outbox, /login_blocked/, "the blocked origin raised an alert");
    assert.ok(Object.keys(dump).length > 25, "every table was dumped");
    assert.ok(t.printed.some((line) => line.includes(t.lastLink().token)), "the setup link is printed to the console, and only there");
  });

  test("the panel wrote the 10 editable keys and shows only the last four", () => {
    const list = scenario.written.settings;
    assert.equal(list.length, EDITABLE_SECRET_KEYS.length);
    for (const entry of list) {
      assert.equal(entry.origin, "override", entry.key);
      assert.deepEqual(entry.secret, { set: true, last4: PANEL_SEEDS[entry.key].slice(-4), needsReentry: false }, entry.key);
    }
  });

  test("the environment secrets are listed as set with their last four (or the scheme for the database), never a value", () => {
    const after = responses.find((r) => r.label === "settings: after the errors");
    const listing = JSON.parse(after.text);
    assert.equal(listing.settings.filter((s) => s.secret).length, 22);
    const byKey = Object.fromEntries(listing.settings.map((s) => [s.key, s]));
    assert.deepEqual(byKey.SESSION_ID.secret, { set: true, last4: ENV_SEEDS.SESSION_ID.slice(-4), needsReentry: false });
    assert.deepEqual(byKey.DATABASE_URL.secret, { set: true, scheme: "postgres" });
    assert.deepEqual(byKey.GROQ_API_KEY.secret, { set: true, last4: ENV_SEEDS.GROQ_API_KEY.slice(-4), needsReentry: false });
    for (const entry of listing.settings.filter((s) => s.secret)) {
      assert.ok(!("value" in entry) && entry.fileValue === null && entry.default === null, `${entry.key} carries no value`);
    }
  });
});

describe("SC-004: nothing found in", () => {
  test("any response body or header (the session cookie excepted by design)", () => {
    const problems = [];
    for (const r of responses) {
      // the CSRF token is delivered by the authentication answers and by nothing else
      const sink = `${r.text}\n${JSON.stringify(r.headers)}`;
      const found = leaksIn(sink, r.label);
      if (found.length) problems.push(`${r.label} (${r.status}): ${found.join(", ")}`);
    }
    assert.deepEqual(problems, []);
  });

  test("the CSRF token and the setup token appear only where they are delivered, and the session cookie only as Set-Cookie", () => {
    const csrf = client.csrf;
    const setupToken = t.lastLink().token;
    const sessionCookie = client.cookie("owb_sid") || client.cookie("__Host-owb_sid");
    assert.ok(csrf && setupToken && sessionCookie);
    const csrfIn = responses.filter((r) => r.text.includes(csrf) || JSON.stringify(r.headers).includes(csrf)).map((r) => r.label);
    for (const label of csrfIn) assert.ok(["setup", "login", "session"].includes(label), `the CSRF token was found in "${label}"`);
    for (const r of responses) {
      assert.ok(!r.text.includes(setupToken) && !JSON.stringify(r.headers).includes(setupToken), `the setup token was found in "${r.label}"`);
      assert.ok(!r.text.includes(sessionCookie) && !JSON.stringify(r.headers).includes(sessionCookie), `the session id was found in "${r.label}"`);
      for (const cookie of r.setCookies) assert.match(cookie, /^(__Host-)?owb_(sid|setup)=/, `an unexpected cookie in "${r.label}"`);
    }
  });

  test("the log ring", () => {
    const text = JSON.stringify(ring.list({ limit: 100000 }));
    assert.deepEqual(leaksIn(text), []);
    for (const value of [client.csrf, t.lastLink().token, client.cookie("owb_sid") || client.cookie("__Host-owb_sid")]) assert.ok(!text.includes(value));
  });

  test("the logger output and the console", () => {
    const text = `${captured.logger.join("\n")}\n${captured.console.join("\n")}`;
    assert.deepEqual(leaksIn(text), []);
    for (const value of [client.csrf, t.lastLink().token, client.cookie("owb_sid") || client.cookie("__Host-owb_sid")]) assert.ok(!text.includes(value));
  });

  test("the audit_logs table", () => {
    const text = auditRows.join("\n");
    assert.deepEqual(leaksIn(text), []);
    assert.ok(text.includes("setting.update"), "the settings written are in the history");
    assert.ok(!text.includes(client.csrf));
  });

  test("the alert_outbox and alert_state tables", () => {
    assert.deepEqual(leaksIn(outbox), []);
  });

  test("a dump of the whole database (the settings overrides are ciphertext)", () => {
    const problems = [];
    for (const [table, rows] of Object.entries(dump)) {
      const found = leaksIn(rows.join("\n"));
      if (found.length) problems.push(`${table}: ${found.join(", ")}`);
    }
    assert.deepEqual(problems, []);
    // the setup token and the session id (the cookie) are stored hashed; the per-session CSRF secret is stored as is
    // in AdminSession.csrfSecret (data-model.md section 1: "useless without the session cookie"), and nowhere else
    const named = { "setup token": t.lastLink().token, "session id": client.cookie("owb_sid") || client.cookie("__Host-owb_sid") };
    for (const [table, rows] of Object.entries(dump)) {
      const text = rows.join("\n");
      for (const [name, value] of Object.entries(named)) assert.ok(!text.includes(value), `the ${name} is in ${table}`);
      if (table !== "AdminSession") assert.ok(!text.includes(client.csrf), `the CSRF token is in ${table}`);
    }
    assert.ok(dump.AdminSession.join("\n").includes(client.csrf), "documented: the CSRF secret of a session lives in its row");
    assert.equal(dump.SettingOverride.length, EDITABLE_SECRET_KEYS.length, "the 10 secrets are stored");
    assert.ok(dump.SettingOverride.every((row) => /"value":"[^"]*"/.test(row) && !row.includes("panelseed")), "as ciphertext");
  });

  test("the exported file: no value in its bytes, and none in its manifest", async () => {
    const bytes = fs.readFileSync(exportedFile).toString("latin1");
    assert.deepEqual(leaksIn(bytes), [], "the archive is encrypted by the passphrase");
    assert.ok(!bytes.includes(BACKUP_PASSPHRASE));

    const records = await readAll(exportedFile, BACKUP_PASSPHRASE);
    const manifest = records.find((record) => record.t === "manifest");
    assert.ok(manifest, "the manifest is the first record");
    assert.deepEqual(leaksIn(JSON.stringify(manifest)), []);
    assert.ok(!JSON.stringify(manifest).includes(BACKUP_PASSPHRASE));
    // by design the settings rows carry the secrets in clear INSIDE the encrypted archive (a restore must re-encrypt them)
    const settings = records.filter((record) => record.t === "rows" && record.model === "SettingOverride").flatMap((record) => record.rows);
    assert.equal(settings.find((row) => row.key === "OPENAI_API_KEY").value, PANEL_SEEDS.OPENAI_API_KEY);
  });

  test("the redactor is the second line of defence: a value that does reach a log call is scrubbed", () => {
    const log = loggerModule.createLogger("probe");
    const before = captured.logger.length;
    // the values in effect: the panel's own for the ten editable keys, the environment's for the others
    log.error(`oops ${PANEL_SEEDS.OPENAI_API_KEY} and ${ENV_SEEDS.SESSION_ID} and ${ENV_SEEDS.DATABASE_URL}`);
    const lines = captured.logger.slice(before).join("\n");
    assert.match(lines, /\[redacted\]/);
    assert.deepEqual(leaksIn(lines), []);
    assert.equal(redactor.scrub(`k=${ENV_SEEDS.GROQ_API_KEY}`).includes(ENV_SEEDS.GROQ_API_KEY), false, "the inactive keys are registered too");
    assert.deepEqual(leaksIn(JSON.stringify(ring.list({ limit: 100000 }))), []);
  });
});
