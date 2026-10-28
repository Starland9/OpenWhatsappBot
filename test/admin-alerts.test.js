"use strict";
/**
 * ALR-1 and the alert hooks (admin-http-api.md 2.16, specs/002-admin-panel T200; US13), through the real admin on
 * the test harness.
 *
 *  - ALR-1 needs a session and answers `{ canDeliver, ownerCount, types, recent }`: the six types in the order of the
 *    contract with their `ALERT_*` setting, `enabled`, `lastSentAt`, `pending`; `recent` lists id, type, status and
 *    times and never a payload;
 *  - `canDeliver: false` when `SUDO` is empty, and the `no_owner` banner shows (US13 scenario 5);
 *  - a toggle is the `ALERT_*` setting written by SET-2 (the page is a convenience view);
 *  - the authentication raises `login_blocked` after the 5th failure and `new_origin` on a first-seen origin
 *    (F8 hooks), with the real engine behind them the owner receives the message;
 *  - each of the nine plugins that pass `service` to `classifyError` produces `key:refused`, and the ids equal the
 *    `testService` ids of the settings catalog (Alpha Vantage, which cannot be tested, excepted).
 */

const { test, describe, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fakes = require("./helpers/fakes");

const config = fakes.setupEnv({ sudo: "111", lang: "en" });
fakes.stubNetwork(); // nothing in this file reaches the network
// a stand-in for ffmpeg, installed before plugins/voice.js is required (it captures runFfmpeg at load time)
require("../lib/utils/ffmpeg").runFfmpeg = async (args) => {
  fs.writeFileSync(args[args.length - 1], Buffer.from("mp3"));
  return { stdout: Buffer.alloc(0), stderr: "" };
};

const { createTestAdmin } = require("./helpers/adminHarness");
const { createClock } = require("./helpers/fakeClock");
const bus = require("../lib/utils/events");
const alerts = require("../lib/utils/alerts");
const settingsStore = require("../lib/utils/settingsStore");
const catalog = require("../lib/utils/settingsCatalog");
const { createAlertsService, ALERT_TYPES } = require("../lib/admin/services/alerts");
const { RECIPES } = require("../lib/admin/services/keyTests");

const MINUTE = 60 * 1000;
const PASSWORD = "correct horse battery";
const OWNER = "111@s.whatsapp.net";
const ALERT_KEYS = ["ALERT_RECONNECT", "ALERT_ERROR_BURST", "ALERT_KEY_REFUSED", "ALERT_LOGIN_BLOCKED", "ALERT_NEW_ORIGIN", "ALERT_UPDATE"];

let t;
let sock;
let client;
let connected;

/** Boot the admin with the REAL alerts engine (started on a fake client) unless `real: false` */
async function boot({ real = true, ...opts } = {}) {
  t = await createTestAdmin({ ...(real ? { alerts } : {}), ...opts });
  sock = fakes.fakeSocket();
  client = fakes.fakeClient(sock);
  connected = true;
  client.ready = () => connected;
  if (real) alerts.start(client, { now: () => t.clock.now(), timers: t.clock.timers });
  return t;
}

async function shutdown() {
  if (t) {
    await alerts._settled();
    alerts._reset();
    await t.close();
    t = null;
  }
  bus.removeAllListeners();
  for (const key of ALERT_KEYS) settingsStore.clearRuntime(key);
  settingsStore.clearRuntime("SUDO");
}

before(async () => {
  const db = await fakes.syncDb();
  require("./helpers/botFragments").applyBotFragments();
  await db.AlertOutbox.destroy({ where: {}, truncate: true });
  await db.AlertState.destroy({ where: {}, truncate: true });
});

afterEach(shutdown);

const resetAlertTables = async () => {
  await t.db.AlertOutbox.destroy({ where: {}, truncate: true });
  await t.db.AlertState.destroy({ where: {}, truncate: true });
};

async function loggedIn() {
  const c = await t.loginClient(PASSWORD);
  return c;
}

describe("ALR-1", () => {
  test("needs a session", async () => {
    await boot();
    const res = await t.client().get("/admin/api/alerts");
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, "unauthenticated");
  });

  test("the route is declared: session, no CSRF, the database is required", async () => {
    await boot();
    const route = t.admin.routes().find((r) => r.method === "GET" && r.path === "/admin/api/alerts");
    assert.ok(route, "GET /admin/api/alerts is registered");
    assert.equal(route.auth, "session");
    assert.equal(route.mutates, false);
    assert.equal(route.csrf, false);
    assert.ok(!route.db, "no db:r flag");
    assert.equal(t.admin.routes().filter((r) => r.path === "/admin/api/alerts").length, 1, "read only: no other method");
  });

  test("shape: canDeliver, ownerCount, the six types in order with their setting, nothing recent", async () => {
    await boot();
    await resetAlertTables();
    const c = await loggedIn();
    const res = await c.get("/admin/api/alerts");
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(Object.keys(res.json).sort(), ["canDeliver", "ownerCount", "recent", "types"]);
    assert.equal(res.json.canDeliver, true);
    assert.equal(res.json.ownerCount, 1);
    assert.deepEqual(
      res.json.types,
      [
        { type: "reconnected", settingKey: "ALERT_RECONNECT", enabled: true, lastSentAt: null, pending: 0 },
        { type: "errors_series", settingKey: "ALERT_ERROR_BURST", enabled: true, lastSentAt: null, pending: 0 },
        { type: "key_refused", settingKey: "ALERT_KEY_REFUSED", enabled: true, lastSentAt: null, pending: 0 },
        { type: "login_blocked", settingKey: "ALERT_LOGIN_BLOCKED", enabled: true, lastSentAt: null, pending: 0 },
        { type: "new_origin", settingKey: "ALERT_NEW_ORIGIN", enabled: true, lastSentAt: null, pending: 0 },
        { type: "update_available", settingKey: "ALERT_UPDATE", enabled: true, lastSentAt: null, pending: 0 },
      ],
      "all on by default (U12)",
    );
    assert.deepEqual(res.json.recent, []);
  });

  test("the types, their settings and the engine agree, and the settings exist in the catalog as booleans on by default", () => {
    assert.deepEqual(
      Object.fromEntries(ALERT_TYPES.map(({ type, settingKey }) => [type, settingKey])),
      alerts.TYPE_SETTINGS,
    );
    for (const key of ALERT_KEYS) {
      const entry = catalog.entries.find((e) => e.key === key);
      assert.ok(entry, `${key} is in the catalog`);
      assert.equal(entry.type, "bool");
      assert.equal(entry.theme, "alerts");
      assert.equal(entry.default, true);
    }
  });

  test("lastSentAt, pending and the recent rows follow the engine; a payload never leaves", async () => {
    await boot();
    await resetAlertTables();
    const c = await loggedIn();
    await alerts.raise("key_refused", { service: "openai" }, { now: t.clock.now() });
    const sentAt = new Date(t.clock.now()).toISOString();

    connected = false; // cut: the next alerts wait in the outbox
    await t.clock.advance(MINUTE);
    await alerts.raise("new_origin", { origin: "198.51.100.1" }, { now: t.clock.now() });
    await alerts.raise("new_origin", { origin: "198.51.100.2" }, { now: t.clock.now() });
    await alerts._settled();

    const res = await c.get("/admin/api/alerts");
    const byType = Object.fromEntries(res.json.types.map((row) => [row.type, row]));
    assert.equal(byType.key_refused.lastSentAt, sentAt);
    assert.equal(byType.key_refused.pending, 0);
    assert.equal(byType.new_origin.pending, 2);
    assert.equal(byType.new_origin.lastSentAt, null, "queued, not sent");

    assert.deepEqual(
      res.json.recent.map((row) => [row.type, row.status]),
      [["new_origin", "pending"], ["new_origin", "pending"], ["key_refused", "sent"]],
      "newest first",
    );
    for (const row of res.json.recent) assert.deepEqual(Object.keys(row).sort(), ["createdAt", "id", "sentAt", "status", "type"]);
    assert.equal(res.json.recent[2].sentAt, sentAt);
    assert.equal(res.json.recent[0].sentAt, null);
    assert.doesNotMatch(res.text, /198\.51\.100|payload|openai/, "no payload, no origin, no service in the answer");
  });

  test("at most 20 recent rows", async () => {
    await boot();
    await resetAlertTables();
    const c = await loggedIn();
    for (let i = 0; i < 25; i += 1) await alerts.raise("new_origin", { origin: `10.0.0.${i}` }, { now: t.clock.now() });
    const res = await c.get("/admin/api/alerts");
    assert.equal(res.json.recent.length, 20);
  });

  test("the service answers with a stand-in engine that has no getStatus (the real one is used)", async () => {
    const service = createAlertsService({ alerts: { raise() {} } });
    await boot({ real: false });
    const answer = await service.list();
    assert.equal(answer.types.length, 6);
  });
});

describe("no recipient (US13 scenario 5)", () => {
  test("canDeliver is false and ownerCount 0 when SUDO is empty; the no_owner banner shows", async () => {
    await boot();
    await resetAlertTables();
    const c = await loggedIn();
    config.SUDO = "";

    const res = await c.get("/admin/api/alerts");
    assert.equal(res.json.canDeliver, false);
    assert.equal(res.json.ownerCount, 0);
    assert.ok(res.json.types.every((row) => row.enabled), "the toggles keep their value");

    const state = await c.get("/admin/api/state");
    assert.ok(state.json.banners.some((banner) => banner.id === "no_owner"), "the dashboard says nobody can be reached");

    // the engine drops without spending a slot, so the first alert after an owner is added still goes out
    assert.deepEqual(await alerts.raise("key_refused", { service: "openai" }, { now: t.clock.now() }), { queued: false, reason: "no_recipient" });
    config.SUDO = "111,112";
    assert.equal((await c.get("/admin/api/alerts")).json.ownerCount, 2);
    assert.deepEqual(await alerts.raise("key_refused", { service: "openai" }, { now: t.clock.now() }), { queued: true });
  });
});

describe("toggles are the ALERT_* settings (SET-2)", () => {
  const versionOf = async (c, key) => (await c.get("/admin/api/settings")).json.settings.find((s) => s.key === key).version;

  test("switching a type off with SET-2 shows in ALR-1 and stops the engine; switching it on restores it", async () => {
    await boot();
    await resetAlertTables();
    const c = await loggedIn();
    const patch = async (value) =>
      c.api("PATCH", "/admin/api/settings", { changes: [{ key: "ALERT_KEY_REFUSED", op: "set", value, version: await versionOf(c, "ALERT_KEY_REFUSED") }] });

    const off = await patch(false);
    assert.equal(off.status, 200, off.text);
    const status = (await c.get("/admin/api/alerts")).json.types.find((row) => row.type === "key_refused");
    assert.equal(status.enabled, false);
    assert.deepEqual(await alerts.raise("key_refused", { service: "openai" }, { now: t.clock.now() }), { queued: false, reason: "disabled" });
    assert.equal(await t.db.AlertState.findByPk("key_refused:openai"), null, "no slot spent while off");
    bus.emitSafe("key:refused", { service: "openai", at: t.clock.now() });
    await alerts._settled();
    assert.equal(await t.db.AlertOutbox.count(), 0);

    assert.equal((await patch(true)).status, 200);
    assert.equal((await c.get("/admin/api/alerts")).json.types.find((row) => row.type === "key_refused").enabled, true);
    bus.emitSafe("key:refused", { service: "openai", at: t.clock.now() });
    await alerts._settled();
    assert.equal(await t.db.AlertOutbox.count(), 1);
    assert.equal(sock.sent.length, 1);
  });

  test("reverting the override gives back the default, which is on", async () => {
    await boot();
    const c = await loggedIn();
    const set = await c.api("PATCH", "/admin/api/settings", {
      changes: [{ key: "ALERT_UPDATE", op: "set", value: false, version: await versionOf(c, "ALERT_UPDATE") }],
    });
    assert.equal(set.status, 200, set.text);
    assert.equal((await c.get("/admin/api/alerts")).json.types.find((row) => row.type === "update_available").enabled, false);
    const back = await c.api("PATCH", "/admin/api/settings", {
      changes: [{ key: "ALERT_UPDATE", op: "revert", version: await versionOf(c, "ALERT_UPDATE") }],
    });
    assert.equal(back.status, 200, back.text);
    assert.equal((await c.get("/admin/api/alerts")).json.types.find((row) => row.type === "update_available").enabled, true);
  });
});

describe("the authentication raises alerts (F8 hooks)", () => {
  test("login_blocked after the 5th failure: one alert, with the origin, to the owner", async () => {
    await boot();
    await resetAlertTables();
    await loggedIn();
    const attacker = t.client();
    for (let i = 0; i < 5; i += 1) assert.equal((await attacker.login(`wrong ${i}`)).status, 401);
    assert.equal((await attacker.login(PASSWORD)).status, 429, "blocked");
    await alerts._settled();

    const rows = await t.db.AlertOutbox.findAll({ where: { type: "login_blocked" } });
    assert.equal(rows.length, 1, "one alert for the block, not one per refused attempt");
    const payload = JSON.parse(rows[0].payload);
    assert.equal(payload.origin, "127.0.0.1");
    assert.equal(payload.retryAfterMs, 15 * MINUTE);
    assert.equal(rows[0].status, "sent");
    const message = sock.sent.find((entry) => /127\.0\.0\.1/.test(entry.text));
    assert.ok(message, "the owner was told");
    assert.equal(message.jid, OWNER);
    assert.match(message.text, /15 minutes/);
  });

  test("login_blocked is called with the origin, retryAfterMs, at and { now } the engine expects", async () => {
    await boot({ real: false });
    await loggedIn();
    const attacker = t.client();
    for (let i = 0; i < 5; i += 1) await attacker.login(`wrong ${i}`);
    const calls = t.alerts.calls.filter((call) => call.type === "login_blocked");
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0].payload).sort(), ["at", "origin", "retryAfterMs"]);
    assert.equal(calls[0].options.now, t.clock.now());
    // the engine accepts exactly that call
    const out = await alerts.raise(calls[0].type, calls[0].payload, calls[0].options);
    assert.equal(typeof out.queued, "boolean");
  });

  test("new_origin on the first login from an origin never seen, not for the origin of the setup, not twice", async () => {
    await boot({ trustProxy: "loopback" });
    await resetAlertTables();
    await loggedIn();
    await t.client().login(PASSWORD);
    await alerts._settled();
    assert.equal(await t.db.AlertOutbox.count({ where: { type: "new_origin" } }), 0, "the setup origin is known");

    const remote = (address) => t.client().api("POST", "/admin/api/login", { password: PASSWORD }, { headers: { "X-Forwarded-For": address } });
    assert.equal((await remote("203.0.113.50")).status, 200);
    await alerts._settled();
    const rows = await t.db.AlertOutbox.findAll({ where: { type: "new_origin" } });
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].payload).origin, "203.0.113.50");
    assert.match(sock.sent.at(-1).text, /203\.0\.113\.50/);

    assert.equal((await remote("203.0.113.50")).status, 200);
    await alerts._settled();
    assert.equal(await t.db.AlertOutbox.count({ where: { type: "new_origin" } }), 1, "the origin is now seen");
  });

  test("with the toggle off nothing is queued", async () => {
    await boot({ trustProxy: "loopback" });
    await resetAlertTables();
    await loggedIn();
    config.ALERT_NEW_ORIGIN = false;
    const res = await t.client().api("POST", "/admin/api/login", { password: PASSWORD }, { headers: { "X-Forwarded-For": "203.0.113.77" } });
    assert.equal(res.status, 200);
    await alerts._settled();
    assert.equal(await t.db.AlertOutbox.count(), 0);
  });
});

describe("the nine plugins pass `service` to classifyError", () => {
  const R = "..";
  const axios = require(require.resolve("axios", { paths: [require("path").resolve(__dirname, "..")] }));
  let savedAdapter;
  let savedFetch;
  let seen;

  /** Every HTTP call fails with 401; Reddit's token endpoint answers, so only the data call is refused */
  const refuse = async (cfg) => {
    if (/reddit\.com\/api\/v1\/access_token/.test(String(cfg.url))) {
      return { status: 200, statusText: "OK", data: { access_token: "token-for-tests", expires_in: 3600 }, headers: {}, config: cfg };
    }
    throw new axios.AxiosError("Request failed with status code 401", "ERR_BAD_REQUEST", cfg, null, {
      status: 401,
      statusText: "Unauthorized",
      data: {},
      headers: {},
      config: cfg,
    });
  };
  const refuseFetch = async () =>
    new Response(JSON.stringify({ error: { message: "invalid key", code: 401, status: "UNAUTHENTICATED" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  before(() => {
    for (const key of [
      "OPENAI_API_KEY", "GEMINI_API_KEY", "WEATHER_API_KEY", "NEWS_API_KEY", "ALPHA_VANTAGE_KEY", "UNSPLASH_API_KEY",
      "GIPHY_API_KEY", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET",
    ]) {
      config[key] = "dummy-value-for-tests";
    }
  });

  beforeEach(() => {
    savedAdapter = axios.defaults.adapter;
    savedFetch = global.fetch;
    axios.defaults.adapter = refuse;
    global.fetch = refuseFetch;
    seen = [];
    bus.removeAllListeners();
    bus.on("key:refused", (payload) => seen.push(payload.service));
  });

  afterEach(() => {
    axios.defaults.adapter = savedAdapter;
    global.fetch = savedFetch;
  });

  /** Run `plugins/<file>` as the command `command` from the owner and return the services refused */
  async function run(file, command, args, extra = {}) {
    const plugin = require(`${R}/plugins/${file}.js`);
    const message = fakes.makeMessage({ body: `.${command} ${args}`.trim(), ...extra.message });
    if (extra.prepare) extra.prepare(message);
    seen.length = 0;
    const logs = [];
    const original = console.error;
    console.error = (...a) => logs.push(a);
    try {
      await plugin.execute.call(plugin, message, args, { command, rawArgs: args });
    } finally {
      console.error = original;
    }
    return [...seen];
  }

  const CASES = [
    ["chatgpt", "chatgpt", "hello", "openai"],
    ["gemini", "gemini", "hello", "gemini"],
    ["imagen", "imagen", "a cat", "gemini"],
    ["weather", "weather", "Paris", "weather"],
    ["news", "news", "fr", "news"],
    ["news", "stock", "AAPL", "alphavantage"],
    ["imagesearch", "image", "cat", "unsplash"],
    ["imagesearch", "gif", "cat", "giphy"],
    ["music", "spotify", "a song", "spotify"],
    ["reddit", "reddit", "funny", "reddit"],
  ];

  for (const [file, command, args, service] of CASES) {
    test(`${file} (.${command}) emits key:refused for "${service}" on an authentication failure`, async () => {
      await fakes.syncDb();
      assert.deepEqual(await run(file, command, args), [service]);
    });
  }

  test("voice (.transcribe) emits key:refused for openai", async () => {
    const out = await run("voice", "transcribe", "", {
      message: { quoted: { media: "audio" } },
      prepare: (message) => {
        message.getQuotedMedia = async () => ({ buffer: Buffer.from("audio"), type: "audio", mimetype: "audio/ogg", fileLength: 5 });
      },
    });
    assert.deepEqual(out, ["openai"]);
  });

  test("voice (.speak) does not: its synthesis needs no key", async () => {
    assert.deepEqual(await run("voice", "speak", "hello"), []);
  });

  test("a command without a key (crypto, plain music search) never names a service", async () => {
    assert.deepEqual(await run("news", "crypto", "btc"), []);
    assert.deepEqual(await run("music", "play", "a song"), []);
  });

  test("the services named by the plugins are the testService ids of the settings catalog (Alpha Vantage excepted)", () => {
    const named = new Set(CASES.map(([, , , service]) => service));
    const catalogIds = new Set(catalog.entries.map((entry) => entry.testService).filter(Boolean));
    const testable = new Set(RECIPES.filter((recipe) => recipe.testable !== false).map((recipe) => recipe.id));
    assert.deepEqual([...catalogIds].sort(), [...testable].sort(), "the catalog and the key tests agree");
    named.delete("alphavantage");
    assert.deepEqual([...named].sort(), [...catalogIds].sort());
    assert.equal(catalog.entries.find((entry) => entry.key === "ALPHA_VANTAGE_KEY").testService, null);
    assert.ok(RECIPES.some((recipe) => recipe.id === "alphavantage" && recipe.testable === false));
  });

  test("every classifyError call of the nine plugins that passes hasKey also passes service", () => {
    const path = require("path");
    const files = ["chatgpt", "gemini", "imagen", "imagesearch", "music", "news", "reddit", "voice", "weather"];
    /** The text between the parentheses of each `classifyError(` call (parentheses balanced) */
    const callsOf = (source) => {
      const out = [];
      for (let at = source.indexOf("classifyError("); at !== -1; at = source.indexOf("classifyError(", at + 1)) {
        let depth = 0;
        for (let i = at + "classifyError".length; i < source.length; i += 1) {
          if (source[i] === "(") depth += 1;
          else if (source[i] === ")" && --depth === 0) {
            out.push(source.slice(at + "classifyError(".length, i));
            break;
          }
        }
      }
      return out;
    };
    for (const file of files) {
      const source = fs.readFileSync(path.join(__dirname, "..", "plugins", `${file}.js`), "utf8");
      const calls = callsOf(source).filter((call) => /hasKey/.test(call));
      assert.ok(calls.length >= 1, `${file}: a classifyError call with hasKey`);
      for (const call of calls) assert.match(call, /service/, `${file}: ${call.replace(/\s+/g, " ")}`);
    }
  });
});

describe("the engine is independent of the panel", () => {
  test("alerts are sent with no admin at all (the panel disabled)", async () => {
    // no createTestAdmin here: only the engine, its database and a client
    const fakeClientSock = fakes.fakeSocket();
    const c = fakes.fakeClient(fakeClientSock);
    const clock = createClock(Date.UTC(2026, 5, 1));
    const db = await fakes.syncDb();
    await db.AlertState.destroy({ where: {}, truncate: true });
    await db.AlertOutbox.destroy({ where: {}, truncate: true });
    alerts.start(c, { now: () => clock.now(), timers: clock.timers });
    try {
      assert.deepEqual(await alerts.raise("update_available", { version: "4.0.0" }, { now: clock.now() }), { queued: true });
      assert.equal(fakeClientSock.sent.length, 1);
      assert.equal(fakeClientSock.sent[0].jid, OWNER);
    } finally {
      await alerts._settled();
      alerts._reset();
      clock.restore();
    }
  });

  test("lib/utils/alerts.js never requires lib/admin", () => {
    const source = fs.readFileSync(require("path").join(__dirname, "..", "lib", "utils", "alerts.js"), "utf8");
    assert.doesNotMatch(source, /require\([^)]*admin/);
  });
});
