"use strict";
/**
 * T220: the admin with every real service and engine (test/helpers/adminFull.js: in-memory database, real plugin
 * registry, settings store, secret box, texts, stats, alerts, broadcaster, updater, log ring, event bus and a REAL
 * bot runtime over a fake client), and what the W1 agents could not test alone.
 *
 *  - the route table: every route of admin-http-api.md section 2 is registered (and nothing undocumented is), every
 *    FR of the coverage matrix of section 4 maps to a registered route or to an engine test that exists, every route
 *    declares its auth level;
 *  - every hub topic has a publisher, shown by triggering it through the real producer;
 *  - US7: a command error appears in the log ring (LOG-1, the dashboard) and increments the failing commands (STAT-1);
 *  - US13: `login_blocked` and `new_origin` raised by the authentication reach the owner through the real alerts engine;
 *  - US9 x US11: the `broadcast_media` purge of the storage page, through the real broadcaster, frees the media of a
 *    finished one-shot broadcast and keeps what can still be sent;
 *  - US10: a restore, then the in-process restart of the real runtime, leave the administrator logged in
 *    (AdminSession untouched);
 *  - US12: a text edited in the panel changes a command description in the help card and the button menu.
 *
 * Offline: the network is stubbed, nothing touches the real data/, sessions/ or database.db.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const fakes = require("./helpers/fakes");

const config = fakes.setupEnv({ sudo: "111", lang: "fr" });
fakes.stubNetwork();

const { createFullAdmin } = require("./helpers/adminFull");
const { createClock } = require("./helpers/fakeClock");
const logger = require("../lib/utils/logger");
const ring = require("../lib/admin/logs/ring");
const bus = require("../lib/utils/events");
const maintenanceMode = require("../lib/utils/maintenanceMode");
const { createBotRuntime } = require("../lib/core/botRuntime");
const { TOPICS } = require("../lib/admin/events");
const { languageManager } = require("../lib/utils/language");

const ROOT = fakes.ROOT;
const CONTRACT = fs.readFileSync(path.join(ROOT, "specs", "002-admin-panel", "contracts", "admin-http-api.md"), "utf8");
const PASSWORD = "a long enough password";
const OWNER = "111@s.whatsapp.net";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let t;
let client;
let clock;
let sock;
let quiet;

before(async () => {
  clock = createClock(Date.now()); // the statistics count on the real day: the panel's window follows the same clock
  quiet = { level: logger.getLevel() };
  logger.setLevel("info"); // the registry's error lines must reach the ring
  logger.setOutput(() => {}); // ... and not the terminal
  ring.clear();
  maintenanceMode._reset();
  t = await createFullAdmin({
    clock,
    trustProxy: "loopback",
    logger: logger.createLogger("admin"),
    // the real runtime over the fake client: restartBot, the state events and the settings reload are the real ones
    runtime: (botClient) => {
      const runtime = createBotRuntime({ client: botClient, mode: "normal", exit: () => {}, reconfigure: () => {} });
      runtime.dbReady = true;
      return runtime;
    },
  });
  sock = t.botClient.getSocket();
  await t.admin.start();
  client = await t.loginClient(PASSWORD);
});

after(async () => {
  if (t) await t.closeFull();
  logger.setOutput();
  logger.setLevel(quiet.level === "silent" ? "silent" : quiet.level);
  maintenanceMode._reset();
  ring.clear();
});

const keyOf = (route) => `${route.method} ${route.path}`;
const waitFor = (fn, timeout = 4000) => fakes.waitFor(fn, { timeout });
const fieldsOf = (answer) => answer.json && answer.json.error && answer.json.error.fields;

async function waitJob(id, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const answer = await client.get(`/admin/api/jobs/${id}`);
    const job = answer.json && answer.json.job ? answer.json.job : answer.json;
    if (job && job.status !== "running") return job;
    assert.ok(Date.now() < deadline, "the job did not finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// The contract: routes and requirements
// ---------------------------------------------------------------------------

/** The route rows of section 2: { id, method, path } (STA-1 is the static wildcard and has no single method/path) */
function contractRoutes() {
  const section = CONTRACT.slice(CONTRACT.indexOf("## 2. Routes"), CONTRACT.indexOf("## 3. Live stream"));
  const out = [];
  for (const match of section.matchAll(/^\| ([A-Z]+-\d+) \| `([A-Z]+) (\/[^`?]*)(?:\?[^`]*)?`/gm)) {
    out.push({ id: match[1], method: match[2], path: match[3] });
  }
  return out;
}

/** "GRP-3 to GRP-17" and "AUTH-1..AUTH-6" expanded, every other id kept */
function idsOf(text) {
  const ids = new Set();
  const range = /\b([A-Z]+)-(\d+)(?:\.\.| to )\1-(\d+)\b/g;
  let rest = text;
  for (const m of text.matchAll(range)) for (let i = Number(m[2]); i <= Number(m[3]); i += 1) ids.add(`${m[1]}-${i}`);
  rest = rest.replace(range, " ");
  for (const m of rest.matchAll(/\b(STA|AUTH|DASH|JOB|RST|EVT|PAIR|SET|CMD|GRP|GRD|CHAT|DATA|BC|UP|BAK|MNT|TXT|ALR|LOG|STAT|AUD)-(\d+)\b/g)) ids.add(`${m[1]}-${m[2]}`);
  return [...ids];
}

/** Requirements whose text names an engine, the UI or the frozen legacy routes: the tests that carry them */
const ENGINE_TESTS = {
  "FR-003": ["test/admin-auth.test.js"],
  "FR-007": ["test/admin-auth.test.js"],
  "FR-008": ["test/admin-security.test.js"],
  "FR-011": ["test/panel-legacy.test.js", "test/panel.test.js"],
  "FR-030": ["test/admin-groups.test.js", "test/admin-data.test.js"],
  "FR-031": ["test/groupguard.test.js"],
  "FR-038": ["test/admin-frontend.test.js"],
  "FR-045": ["test/admin-data.test.js"],
  "FR-049": ["test/broadcaster.test.js"],
  "FR-050": ["test/broadcaster.test.js", "test/recurrence.test.js"],
  "FR-061": ["test/alerts.test.js", "test/admin-alerts.test.js"],
  "FR-062": ["test/alerts.test.js"],
  "FR-063": ["test/alerts.test.js"],
  "FR-064": ["test/owner-dm-throttle.test.js"],
};

/** Registered routes that section 2 does not list (each one is a decision to write down) */
const UNDOCUMENTED = new Set([
  "GET /admin/api/broadcasts/preview", // W-BC: a 405 guard so the literal path is never read as `:id`
]);

describe("the route table", () => {
  test("every route of section 2 of admin-http-api.md is registered, with its auth level", () => {
    const registered = new Map(t.admin.routes().map((route) => [keyOf(route), route]));
    const documented = contractRoutes();
    assert.ok(documented.length >= 75, `${documented.length} route rows parsed from the contract`);

    const missing = documented.filter((row) => !registered.has(`${row.method} ${row.path}`)).map((row) => `${row.id} ${row.method} ${row.path}`);
    assert.deepEqual(missing, [], "documented but not registered");

    // the auth column of the contract
    const section = CONTRACT.slice(CONTRACT.indexOf("## 2. Routes"), CONTRACT.indexOf("## 3. Live stream"));
    for (const match of section.matchAll(/^\| ([A-Z]+-\d+) \| `([A-Z]+) (\/[^`?]*)(?:\?[^`]*)?`[^|]*\| (public|session|setup) \|/gm)) {
      const route = registered.get(`${match[2]}${" "}${match[3]}`);
      assert.equal(route.auth, match[4], `${match[1]} ${match[2]} ${match[3]}`);
    }

    // the shell: the static files and the setup link
    for (const key of ["GET /admin", "GET /admin/*", "GET /admin/setup"]) assert.ok(registered.has(key), key);
  });

  test("no registered route is missing from the contract, and every route declares an auth level", () => {
    const documented = new Set(contractRoutes().map((row) => `${row.method} ${row.path}`));
    const extra = t.admin
      .routes()
      .map(keyOf)
      .filter((key) => !documented.has(key) && !UNDOCUMENTED.has(key) && key !== "GET /admin/*" && key !== "GET /admin");
    assert.deepEqual(extra, []);
    const registered = new Set(t.admin.routes().map(keyOf));
    for (const key of UNDOCUMENTED) assert.ok(registered.has(key), `${key} is no longer registered: drop it from UNDOCUMENTED`);
    for (const route of t.admin.routes()) assert.ok(["public", "session", "setup"].includes(route.auth), keyOf(route));
    assert.equal(t.admin.routes().filter((r) => r.auth === "public").length, 5, "STA-1, STA-2, AUTH-1 and AUTH-2 plus the setup landing");
  });

  test("every requirement of the coverage matrix (section 4) maps to a registered route or to an engine test that exists", () => {
    const registeredIds = new Set();
    const registered = new Set(t.admin.routes().map(keyOf));
    for (const row of contractRoutes()) if (registered.has(`${row.method} ${row.path}`)) registeredIds.add(row.id);
    for (const id of ["STA-1", "STA-2", "STA-3"]) registeredIds.add(id); // checked by the shell test above

    const matrix = CONTRACT.slice(CONTRACT.indexOf("## 4. Coverage matrix"), CONTRACT.indexOf("## 5. Contract tests"));
    const rows = [...matrix.matchAll(/^\| (FR-\d{3}) \| (.+) \|$/gm)].map((m) => ({ fr: m[1], text: m[2] }));
    assert.equal(rows.length, 64, "FR-001 to FR-064");

    for (const { fr, text } of rows) {
      const ids = idsOf(text);
      for (const id of ids) assert.ok(registeredIds.has(id), `${fr} cites ${id}, which is not a registered route`);
      const engine = /\bengine\b|UI only|frozen/.test(text);
      if (ids.length === 0 || engine) {
        const files = ENGINE_TESTS[fr];
        assert.ok(files && files.length, `${fr} ("${text.slice(0, 50)}") needs its engine test listed`);
        for (const file of files) assert.ok(fs.existsSync(path.join(ROOT, file)), `${fr}: ${file} does not exist`);
      }
    }
    for (const fr of Object.keys(ENGINE_TESTS)) assert.ok(rows.some((row) => row.fr === fr), `${fr} is in the matrix`);
  });
});

// ---------------------------------------------------------------------------
// Hub topics
// ---------------------------------------------------------------------------

describe("every hub topic has a publisher", () => {
  test("state, pairing, log, job and session are each published by their real producer", async () => {
    assert.deepEqual([...TOPICS].sort(), ["job", "log", "pairing", "session", "state"]);
    const seen = {};
    const offs = TOPICS.map((topic) => t.hub.subscribe(topic, (payload) => (seen[topic] = payload)));
    try {
      // state first, before anything else can publish one: the client changes state, the runtime emits, the dashboard
      // publishes (the hub lets one through per second of ITS clock, which is the fake one)
      clock.set(clock.now() + 2000);
      t.botClient.setState({ status: "connecting" });
      await waitFor(() => seen.state);
      assert.ok(seen.state.bot, "a dashboard state payload");
      assert.equal(seen.state.bot.status, "connecting", "the payload follows the client");

      // pairing: a new QR is published without its string
      t.botClient.setQr("2@integration-qr-string");
      await waitFor(() => seen.pairing);
      assert.ok(!JSON.stringify(seen.pairing).includes("integration-qr-string"));

      // session: a logout revokes a session and announces it
      const other = t.client();
      assert.equal((await other.login(PASSWORD)).status, 200);
      assert.equal((await other.api("POST", "/admin/api/logout")).status, 200);
      await waitFor(() => seen.session);
      assert.equal(seen.session.reason, "logout");

      // log: the ring feeds the hub (synchronously)
      ring.push({ level: "info", name: "integration", msg: "hello hub" });
      assert.equal(seen.log.msg, "hello hub");

      // job: the registry announces every job (synchronously)
      t.admin.jobs.start("integration.test", async () => 1, { exclusive: false });
      assert.equal(seen.job.type, "integration.test");
    } finally {
      for (const off of offs) off();
    }
  });

  test("the producers exist in the source (a topic no code publishes would be silent)", () => {
    const dir = path.join(ROOT, "lib", "admin");
    const files = [];
    const walk = (current) => {
      for (const name of fs.readdirSync(current)) {
        const full = path.join(current, name);
        if (fs.statSync(full).isDirectory()) {
          if (name !== "public") walk(full);
        } else if (name.endsWith(".js")) files.push(full);
      }
    };
    walk(dir);
    const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
    for (const topic of ["state", "pairing", "log", "job", "session"]) {
      assert.ok(new RegExp(`(?:publish|publishState)\\(\\s*"${topic}"|hub\\.publish\\(\\s*"${topic}"|publishState\\(`).test(source), `a publisher of "${topic}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// US7: a command error
// ---------------------------------------------------------------------------

describe("US7: a failing command shows up everywhere it should", () => {
  test("the log ring, LOG-1, the dashboard errors, the bus and the failing-commands statistic", async () => {
    t.registry.registerPlugin(
      { command: { pattern: "integrationboom", desc: "boom", type: "test" }, async execute() { throw new Error("integration kaboom"); } },
      "integration-boom.js",
    );
    const busEvents = [];
    const onError = (payload) => busEvents.push(payload);
    bus.on(bus.TOPICS.COMMAND_ERROR, onError);
    const stream = [];
    const off = t.hub.subscribe("log", (entry) => stream.push(entry));
    try {
      const message = fakes.makeMessage({ body: ".integrationboom", sock });
      assert.equal(await t.registry.executeCommand(message), true);
      assert.ok(fakes.sentTexts(sock).length > 0, "the user got the generic error reply");
    } finally {
      bus.off(bus.TOPICS.COMMAND_ERROR, onError);
      off();
    }

    // the bus and the live stream saw it
    assert.deepEqual(busEvents.map((e) => e.name), ["integrationboom"]);
    assert.ok(stream.some((entry) => entry.level === "error" && /integrationboom/.test(entry.msg)), "pushed to the hub as a log event");

    // the ring (LOG-1), filtered by level and text
    const logs = await client.get("/admin/api/logs?level=error&q=integrationboom");
    assert.equal(logs.status, 200);
    assert.ok(logs.json.entries.some((entry) => entry.level === "error" && /integrationboom/.test(entry.msg) && /integration kaboom/.test(entry.msg)));

    // the dashboard's last errors
    const state = await client.get("/admin/api/state");
    assert.ok(state.json.errors.some((entry) => /integrationboom/.test(entry.msg)));

    // the statistic, after the flush the housekeeping would do
    await t.engines.stats.flush();
    const stats = await client.get("/admin/api/stats");
    assert.equal(stats.status, 200);
    const failed = stats.json.failedCommands.find((entry) => entry.name === "integrationboom");
    assert.deepEqual(failed, { name: "integrationboom", count: 1 });
  });
});

// ---------------------------------------------------------------------------
// US13: alerts raised by the authentication
// ---------------------------------------------------------------------------

describe("US13: login_blocked and new_origin reach the owner through the real alerts engine", () => {
  test("a blocked origin and a first login from a new origin are queued, sent to the owner and listed", async () => {
    const alerts = t.engines.alerts;
    alerts.start(t.botClient, { now: () => clock.now(), timers: clock.timers });
    t.track(() => alerts.stop());
    const before = sock.sent.length;

    // five wrong passwords from one origin: the fifth blocks it
    const stranger = t.client();
    const origin = { "X-Forwarded-For": "198.51.100.7" };
    for (let i = 0; i < 5; i += 1) {
      const answer = await stranger.api("POST", "/admin/api/login", { password: `wrong integration password ${i}` }, { headers: origin });
      assert.equal(answer.status, 401);
    }
    assert.equal((await stranger.api("POST", "/admin/api/login", { password: PASSWORD }, { headers: origin })).status, 429);

    // a first successful login from another origin
    const visitor = t.client();
    const login = await visitor.api("POST", "/admin/api/login", { password: PASSWORD }, { headers: { "X-Forwarded-For": "203.0.113.50" } });
    assert.equal(login.status, 200);

    await waitFor(() => sock.sent.length >= before + 2);
    const texts = fakes.sentTexts(sock, { jid: OWNER });
    assert.ok(texts.some((text) => text.includes("198.51.100.7")), "login_blocked names the blocked origin");
    assert.ok(texts.some((text) => text.includes("203.0.113.50")), "new_origin names the new origin");

    const rows = await t.db.AlertOutbox.findAll({ order: [["id", "ASC"]], raw: true });
    const byType = Object.fromEntries(rows.map((row) => [row.type, row.status]));
    assert.equal(byType.login_blocked, "sent");
    assert.equal(byType.new_origin, "sent");
    const slots = await t.db.AlertState.findAll({ raw: true });
    assert.ok(slots.some((slot) => slot.key === "login_blocked:198.51.100.7"));

    const listing = await client.get("/admin/api/alerts");
    assert.equal(listing.status, 200);
    assert.equal(listing.json.canDeliver, true);
    for (const type of ["login_blocked", "new_origin"]) {
      const entry = listing.json.types.find((item) => item.type === type);
      assert.ok(entry.lastSentAt, `${type} has a lastSentAt`);
      assert.equal(entry.pending, 0);
    }

    // the history knows both
    const audit = await client.get("/admin/api/audit?pageSize=200");
    const actions = new Set(audit.json.items.map((item) => item.action));
    assert.ok(actions.has("login.blocked") && actions.has("login.success"));
  });
});

// ---------------------------------------------------------------------------
// US9 x US11: broadcast media and the storage page
// ---------------------------------------------------------------------------

describe("US9 x US11: the broadcast_media purge goes through the real broadcaster", () => {
  test("a finished one-shot loses its media, a recurring one and a scheduled one keep theirs", async () => {
    const engine = t.engines.broadcaster;
    engine.start(t.botClient);
    t.track(() => engine.stop());
    const jids = ["237600000101@s.whatsapp.net", "237600000102@s.whatsapp.net"];
    await t.db.KnownChat.bulkCreate(jids.map((jid) => ({ jid, kind: "private", pnJid: jid, name: jid, firstSeenAt: new Date(clock.now()), lastSeenAt: new Date(clock.now()) })));

    const upload = async (name) => {
      const res = await client.raw({
        method: "PUT",
        path: `/admin/api/uploads?purpose=broadcast&name=${encodeURIComponent(name)}`,
        headers: { Origin: t.base, "Content-Type": "application/octet-stream", "X-CSRF-Token": client.csrf },
        body: PNG,
      });
      assert.equal(res.status, 201, res.text);
      return res.json.uploadId;
    };
    const create = async (body, name) => {
      const answer = await client.api("POST", "/admin/api/broadcasts", { text: "with media", targets: jids, confirmTargets: jids.length, uploadId: await upload(name), ...body });
      assert.equal(answer.status, 201, answer.text);
      return answer.json.broadcast.id;
    };
    const mediaFile = (id, name) => path.join(t.root, "data", "broadcast-media", String(id), name);

    const finished = await create({ kind: "once", spacingMs: 2000 }, "finished.png");
    // the time of day twelve hours from now (in the broadcaster's zone): no occurrence falls due while the test runs
    const farTime = new Date(clock.now() + 12 * 3600 * 1000).toLocaleTimeString("en-GB", { timeZone: config.TIMEZONE || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const recurring = await create({ kind: "recurring", recurrence: { kind: "daily", time: farTime } }, "recurring.png");
    const scheduled = await create({ kind: "once", runAt: new Date(clock.now() + 24 * 3600 * 1000).toISOString() }, "scheduled.png");
    for (const [id, name] of [[finished, "finished.png"], [recurring, "recurring.png"], [scheduled, "scheduled.png"]]) assert.ok(fs.existsSync(mediaFile(id, name)), name);

    // the first one is sent to both destinations by the engine, one send per tick
    for (let i = 0; i < 6; i += 1) {
      await engine.tick(clock.now());
      clock.set(clock.now() + 3000);
      const detail = await client.get(`/admin/api/broadcasts/${finished}`);
      if (detail.json.runs && detail.json.runs.every((run) => run.status === "completed")) break;
    }
    const detail = await client.get(`/admin/api/broadcasts/${finished}`);
    assert.ok(detail.json.runs.length >= 1 && detail.json.runs.every((run) => run.status === "completed"), JSON.stringify(detail.json.runs));
    assert.ok(sock.sent.filter((s) => jids.includes(s.jid)).length >= 2, "both destinations were messaged");

    // the storage page measures it, and says how much is protected (a refresh is allowed once every 5 s of the fake clock)
    clock.set(clock.now() + 6000);
    const before = await client.get("/admin/api/maintenance/storage?refresh=1");
    assert.equal(before.status, 200);
    const category = (answer) => answer.json.categories.find((item) => item.id === "broadcast_media");
    assert.equal(category(before).bytes, PNG.length * 3);
    assert.equal(category(before).protectedItems, 2);
    assert.equal(category(before).protectedBytes, PNG.length * 2);

    // the purge needs the confirmation, then frees only the finished one-shot's media
    const refused = await client.api("POST", "/admin/api/maintenance/storage/broadcast_media/purge", {});
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.json.error.code, "confirmation_required");
    assert.ok(fs.existsSync(mediaFile(finished, "finished.png")), "nothing happened without the confirmation");
    const purged = await client.api("POST", "/admin/api/maintenance/storage/broadcast_media/purge", { confirm: true });
    assert.equal(purged.status, 200, purged.text);
    assert.deepEqual(purged.json, { freedBytes: PNG.length, removed: 1, skipped: 2 });
    assert.ok(!fs.existsSync(mediaFile(finished, "finished.png")), "the finished one-shot lost its media");
    assert.ok(fs.existsSync(mediaFile(recurring, "recurring.png")), "the recurring broadcast keeps it");
    assert.ok(fs.existsSync(mediaFile(scheduled, "scheduled.png")), "so does the scheduled one-shot");

    clock.set(clock.now() + 6000); // a refresh is allowed once every 5 s
    const after = await client.get("/admin/api/maintenance/storage?refresh=1");
    assert.equal(after.status, 200, after.text);
    assert.equal(category(after).bytes, PNG.length * 2);
    const gone = await client.get(`/admin/api/broadcasts/${finished}`);
    assert.equal(gone.json.broadcast.mediaAvailable, false);
    const kept = await client.get(`/admin/api/broadcasts/${recurring}`);
    assert.equal(kept.json.broadcast.mediaAvailable, true);

    const audit = await t.db.AuditLog.findAll({ where: { action: "storage.purge" }, raw: true });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].target, "broadcast_media");
  });
});

// ---------------------------------------------------------------------------
// US10: a restore and the restart that follows it
// ---------------------------------------------------------------------------

describe("US10: a restore followed by the runtime's restart keeps the administrator logged in", () => {
  test("AdminSession is untouched, the cookie and the CSRF token still work, the data and the settings are back", async () => {
    const G = "120363000000000042@g.us";
    await t.db.Group.destroy({ where: {} });
    await t.db.Group.create({ jid: G, name: "Before the backup" });
    assert.equal((await client.api("PATCH", "/admin/api/settings", { changes: [{ key: "PREFIX", op: "set", value: "?", version: (await client.get("/admin/api/settings")).json.settings.find((s) => s.key === "PREFIX").version }] })).status, 200);

    // the backup
    const passphrase = "an integration passphrase";
    const exported = await client.raw({
      method: "POST",
      path: "/admin/api/backup/export",
      headers: { Origin: t.base, "X-CSRF-Token": client.csrf, "Content-Type": "application/json", Accept: "*/*" },
      body: JSON.stringify({ passphrase }),
    });
    assert.equal(exported.status, 200, exported.text);

    // the installation drifts
    await t.db.Group.update({ name: "After the backup" }, { where: { jid: G } });
    const version = (await client.get("/admin/api/settings")).json.settings.find((s) => s.key === "PREFIX").version;
    assert.equal((await client.api("PATCH", "/admin/api/settings", { changes: [{ key: "PREFIX", op: "set", value: "!", version }] })).status, 200);

    const uploaded = await client.raw({
      method: "PUT",
      path: "/admin/api/uploads?purpose=backup&name=backup.owb",
      headers: { Origin: t.base, "Content-Type": "application/octet-stream", "X-CSRF-Token": client.csrf },
      body: exported.buffer,
    });
    assert.equal(uploaded.status, 201, uploaded.text);
    const inspected = await client.api("POST", "/admin/api/backup/inspect", { uploadId: uploaded.json.uploadId, passphrase });
    assert.equal(inspected.status, 200, inspected.text);

    const sessionsBefore = JSON.stringify(await t.db.AdminSession.findAll({ order: [["createdAt", "ASC"], ["idHash", "ASC"]], raw: true }));
    const accountBefore = JSON.stringify(await t.db.AdminAccount.findAll({ raw: true }));
    const restarts = t.botClient.calls.filter((call) => call.method === "restart").length;

    const accepted = await client.api("POST", "/admin/api/backup/restore", { restoreToken: inspected.json.restoreToken, confirm: true });
    assert.equal(accepted.status, 202, accepted.text);
    const job = await waitJob(accepted.json.job.id);
    assert.equal(job.status, "done", JSON.stringify(job));
    assert.equal(job.result.restarted, true);
    assert.equal(maintenanceMode.isActive(), false);

    // what the backup held is back
    assert.equal((await t.db.Group.findByPk(G)).name, "Before the backup");
    assert.equal(require("../lib/utils/settingsStore").get("PREFIX"), "?");
    // the bot restarted in process through the real runtime
    assert.equal(t.botClient.calls.filter((call) => call.method === "restart").length, restarts + 1);

    // the administrator was not logged out: same rows, same cookie, same CSRF token
    assert.equal(JSON.stringify(await t.db.AdminSession.findAll({ order: [["createdAt", "ASC"], ["idHash", "ASC"]], raw: true })).replace(/"lastSeenAt":"[^"]*"/g, ""), sessionsBefore.replace(/"lastSeenAt":"[^"]*"/g, ""));
    assert.equal(JSON.stringify(await t.db.AdminAccount.findAll({ raw: true })), accountBefore);
    const session = await client.get("/admin/api/session");
    assert.equal(session.status, 200);
    assert.equal(session.json.authenticated, true);
    assert.equal((await client.api("PATCH", "/admin/api/account/preferences", { theme: "dark" })).status, 200);
    assert.equal((await client.get("/admin/api/state")).status, 200);
  });
});

// ---------------------------------------------------------------------------
// US12: a text edited in the panel
// ---------------------------------------------------------------------------

describe("US12: a text override edited in the panel changes a command description everywhere it is shown", () => {
  const KEY = "plugins.ping.desc";
  const TEXT = "Mesure la latence (texte modifié dans le panel)";

  test("the commands listing, the help card and the button menu follow at once, and a reset puts the original back", async () => {
    const lang = config.LANG;
    const entry = t.registry.getCommandByPattern("ping");
    assert.equal(entry.descKey, KEY);
    const original = entry.desc;

    const saved = await client.api("PUT", `/admin/api/texts/${lang}/${KEY}`, { text: TEXT });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(entry.desc, TEXT, "the registry's lazy description follows, no restart");

    const listing = await client.get("/admin/api/commands");
    assert.equal(listing.json.commands.find((command) => command.name === "ping").desc, TEXT);

    const ask = async (plugin, args) => {
      const message = fakes.makeMessage({ body: `.x ${args}`, sock });
      const sent = sock.sent.length;
      await plugin.execute(message, args);
      return JSON.stringify(sock.sent.slice(sent));
    };
    assert.ok((await ask(require("../plugins/help"), "ping")).includes("texte modifié dans le panel"), "the help card");
    assert.ok((await ask(require("../plugins/buttonmenu"), "ping")).includes("texte modifié dans le panel"), "the button menu's card");

    const texts = await client.get(`/admin/api/texts?q=${KEY}`);
    assert.equal(texts.json.items[0].texts[lang].effective, TEXT);
    assert.equal(texts.json.items[0].texts[lang].overridden, true);

    // a text that loses a placeholder is refused and changes nothing
    const refused = await client.api("PUT", `/admin/api/texts/${lang}/plugins.menu.footer`, { text: "sans variable" });
    assert.equal(refused.status, 422);
    assert.equal(fieldsOf(refused).text.code, "placeholder_mismatch");

    const reset = await client.api("DELETE", `/admin/api/texts/${lang}/${KEY}`);
    assert.equal(reset.status, 200, reset.text);
    assert.equal(entry.desc, original);
    assert.equal((await client.get("/admin/api/commands")).json.commands.find((command) => command.name === "ping").desc, original);

    const history = await t.db.AuditLog.findAll({ where: { action: ["text.update", "text.reset"] }, raw: true });
    assert.deepEqual(history.map((row) => row.action).sort(), ["text.reset", "text.update"]);
    languageManager.reload();
  });
});
