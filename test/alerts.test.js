"use strict";
/**
 * lib/utils/alerts.js (specs/002-admin-panel T199; runtime.md section 10, data-model 1.13, 1.14 and 2.6).
 *
 *  - SC-015: 100 command errors in an hour give exactly one `errors_series` alert (the window is cleared at 10 entries
 *    whether or not the limiter let the alert through);
 *  - `reconnected`: after a cut of more than 5 minutes, with `downMs` read from the persisted heartbeat; none under
 *    5 minutes, none on the very first boot;
 *  - `key_refused` once per service per 24 h, `login_blocked` once per origin per 15 min, `new_origin` without a limit,
 *    `update_available` once per version;
 *  - the order of `raise`: toggle, owners, persisted compare-and-swap, outbox row, flush when connected;
 *  - an alert born during a disconnection is sent at the reconnection, neither duplicated nor lost; a restart does not
 *    send it again; 3 attempts at most; pending rows expire after 24 h; resolved rows are deleted after 7 days;
 *  - the text is rendered at send time; a payload holds no key, stack or third-party JID; every type is on by default.
 *
 * In-memory database, fake clock, fake client and socket: no network, no WhatsApp.
 */

const { test, describe, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");
const { createClock } = require("./helpers/fakeClock");
const { applyBotFragments } = require("./helpers/botFragments");

const config = fakes.setupEnv({ sudo: "111", lang: "en" });
const bus = require("../lib/utils/events");
const settingsStore = require("../lib/utils/settingsStore");
const { languageManager } = require("../lib/utils/language");
const alerts = require("../lib/utils/alerts");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 2, 1, 8, 0, 0);
const OWNER = "111@s.whatsapp.net";

/** The alert settings of the catalog, each of which can be switched off by a runtime assignment */
const ALERT_SETTINGS = ["ALERT_RECONNECT", "ALERT_ERROR_BURST", "ALERT_KEY_REFUSED", "ALERT_LOGIN_BLOCKED", "ALERT_NEW_ORIGIN", "ALERT_UPDATE"];

let db;
let clock;
let sock;
let client;
let connected;

/** A client that is connected or not on demand (`connected`), recording what the socket sends */
function makeClient() {
  sock = fakes.fakeSocket();
  client = fakes.fakeClient(sock);
  client.ready = () => connected;
  return client;
}

/** Start the engine on the fake clock; `connected` decides whether raise() flushes at once */
async function startEngine({ ready = true } = {}) {
  connected = ready;
  alerts.start(client, { now: () => clock.now(), timers: clock.timers });
  await settle(); // an engine started while connected behaves like after a ready: let that finish
}

/** Move the clock without firing the timers (the 30 s flush would run thousands of times over days) */
const jump = (ms) => clock.set(clock.now() + ms);

const settle = () => alerts._settled();
const rows = () => db.AlertOutbox.findAll({ order: [["id", "ASC"]] });
const payloadOf = (row) => JSON.parse(row.payload);
const sentTexts = () => sock.sent.map((entry) => entry.text);
const slot = (key) => db.AlertState.findByPk(key);

/** Emit `n` command errors, one every `everyMs` (time moves, the timers fire) */
async function commandErrors(n, everyMs, names = ["play"]) {
  for (let i = 0; i < n; i += 1) {
    bus.emitSafe("command:error", { name: names[i % names.length], at: clock.now() });
    await settle();
    await clock.advance(everyMs);
  }
}

/** Cut the connection and reconnect `downMs` later, as the client does */
async function outage(downMs) {
  connected = false;
  client.emit("close");
  await settle();
  await clock.advance(downMs);
  connected = true;
  client.emit("ready");
  await settle();
}

before(async () => {
  db = await fakes.syncDb();
  applyBotFragments();
});

beforeEach(async () => {
  clock = createClock(START);
  alerts._reset();
  bus.removeAllListeners();
  for (const key of ALERT_SETTINGS) settingsStore.clearRuntime(key);
  settingsStore.clearRuntime("SUDO");
  await db.AlertOutbox.destroy({ where: {}, truncate: true });
  await db.AlertState.destroy({ where: {}, truncate: true });
  makeClient();
});

afterEach(async () => {
  await alerts._settled(); // no flush of this test may run into the next one
  alerts._reset();
  bus.removeAllListeners();
  clock.restore();
  for (const key of ALERT_SETTINGS) settingsStore.clearRuntime(key);
  settingsStore.clearRuntime("SUDO");
});

describe("defaults and wiring", () => {
  test("every type is on by default (U12) and the six toggles are the ALERT_* settings", async () => {
    assert.deepEqual(alerts.TYPES, ["reconnected", "errors_series", "key_refused", "login_blocked", "new_origin", "update_available"]);
    assert.deepEqual(alerts.TYPE_SETTINGS, {
      reconnected: "ALERT_RECONNECT",
      errors_series: "ALERT_ERROR_BURST",
      key_refused: "ALERT_KEY_REFUSED",
      login_blocked: "ALERT_LOGIN_BLOCKED",
      new_origin: "ALERT_NEW_ORIGIN",
      update_available: "ALERT_UPDATE",
    });
    for (const key of ALERT_SETTINGS) assert.equal(config[key], true, `${key} defaults to true`);
    const status = await alerts.getStatus();
    assert.ok(Object.values(status.enabled).every((on) => on === true));
    assert.equal(status.recipients, 1);
    assert.equal(status.pending, 0);
  });

  test("start() is idempotent and stop() removes every listener and timer", async () => {
    const busBefore = bus.listenerCount("command:error") + bus.listenerCount("key:refused");
    const readyBefore = client.listenerCount("ready");
    const closeBefore = client.listenerCount("close");
    await startEngine();
    await startEngine();
    assert.equal(bus.listenerCount("command:error") + bus.listenerCount("key:refused") - busBefore, 2);
    assert.equal(client.listenerCount("ready") - readyBefore, 1);
    assert.equal(client.listenerCount("close") - closeBefore, 1);
    assert.equal(clock.pending(), 2, "the 60 s heartbeat and the 30 s flush");

    await alerts.stop();
    assert.equal(bus.listenerCount("command:error") + bus.listenerCount("key:refused"), busBefore);
    assert.equal(client.listenerCount("ready"), readyBefore);
    assert.equal(client.listenerCount("close"), closeBefore);
    assert.equal(clock.pending(), 0);
  });

  test("the timers are unref'd (they never hold the process open)", () => {
    const unrefs = [];
    const timers = {
      setInterval: (fn, ms) => ({ unref: () => unrefs.push(ms) }),
      clearInterval() {},
    };
    connected = false;
    alerts.start(client, { now: () => clock.now(), timers });
    assert.deepEqual(unrefs.sort((a, b) => a - b), [30000, 60000]);
  });
});

describe("SC-015: errors in series", () => {
  test("100 command errors in an hour give exactly one errors_series alert naming the commands", async () => {
    await startEngine();
    // 100 errors, one every 35 s: 10 errors always fall within 6 minutes, so ten bursts of 10 happen in 58 minutes
    await commandErrors(100, 35 * 1000, ["play", "play", "play", "image", "news"]);

    const all = await rows();
    assert.equal(all.length, 1, "one alert for the hour");
    assert.equal(all[0].type, "errors_series");
    assert.equal(all[0].status, "sent");
    const stored = payloadOf(all[0]);
    assert.equal(stored.count, 10);
    assert.deepEqual(stored.top, [{ name: "play", count: 6 }, { name: "image", count: 2 }, { name: "news", count: 2 }]);

    assert.equal(sock.sent.length, 1);
    assert.equal(sock.sent[0].jid, OWNER);
    assert.match(sock.sent[0].text, /10 command errors in 10 minutes/);
    assert.match(sock.sent[0].text, /play \(6\), image \(2\), news \(2\)/);

    const state = await slot("errors_series");
    assert.equal(state.count, 1, "the other nine bursts lost the compare-and-swap");
  });

  test("the window is cleared at 10 entries, whether or not the limiter let the alert through", async () => {
    await startEngine();
    await commandErrors(10, 1000);
    assert.equal(alerts._windowSize(), 0, "cleared after the first burst (alert sent)");
    await commandErrors(9, 1000);
    assert.equal(alerts._windowSize(), 9);
    await commandErrors(1, 1000);
    assert.equal(alerts._windowSize(), 0, "cleared after the second burst, which the limiter refused");
    assert.equal((await rows()).length, 1);
  });

  test("errors older than 10 minutes leave the window, so slow errors never raise", async () => {
    await startEngine();
    await commandErrors(30, 2 * MINUTE); // at most 5 entries within any 10-minute window
    assert.equal((await rows()).length, 0);
    assert.ok(alerts._windowSize() < 10);
  });

  test("a new alert is allowed an hour after the first", async () => {
    await startEngine();
    await commandErrors(10, 1000, ["a"]);
    jump(HOUR + MINUTE);
    await commandErrors(10, 1000, ["b"]);
    const all = await rows();
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((row) => row.status), ["sent", "sent"]);
  });

  test("with the toggle off the burst is dropped without consuming the slot, and the window still clears", async () => {
    config.ALERT_ERROR_BURST = false;
    await startEngine();
    await commandErrors(10, 1000);
    assert.equal(alerts._windowSize(), 0);
    assert.equal((await rows()).length, 0);
    assert.equal(await slot("errors_series"), null, "no slot taken");
  });
});

describe("reconnected", () => {
  test("the very first boot raises nothing but stamps the heartbeat", async () => {
    await startEngine({ ready: false });
    connected = true;
    client.emit("ready");
    await settle();
    assert.equal((await rows()).length, 0);
    const beat = await slot(alerts.HEARTBEAT_KEY);
    assert.equal(beat.value, new Date(START).toISOString());
  });

  test("the 60 s heartbeat keeps the stamp fresh while connected and stops while cut", async () => {
    await startEngine();
    client.emit("ready");
    await settle();
    await clock.advance(3 * MINUTE + 5000);
    await settle();
    assert.equal((await slot(alerts.HEARTBEAT_KEY)).value, new Date(START + 3 * MINUTE).toISOString());

    connected = false;
    await clock.advance(5 * MINUTE);
    await settle();
    assert.equal((await slot(alerts.HEARTBEAT_KEY)).value, new Date(START + 3 * MINUTE).toISOString(), "no stamp while disconnected");
  });

  test("a cut of 4 minutes is not announced, one of 10 minutes is, with downMs", async () => {
    await startEngine();
    client.emit("ready");
    await settle();

    await outage(4 * MINUTE);
    assert.equal((await rows()).length, 0, "under 5 minutes");

    await outage(10 * MINUTE);
    const all = await rows();
    assert.equal(all.length, 1);
    assert.equal(all[0].type, "reconnected");
    assert.equal(payloadOf(all[0]).downMs, 10 * MINUTE);
    assert.match(sock.sent.at(-1).text, /back online after 10 min/);
  });

  test("the duration comes from the persisted heartbeat: a crash and a restart 20 minutes later is announced", async () => {
    await db.AlertState.create({ key: alerts.HEARTBEAT_KEY, value: new Date(START - 20 * MINUTE).toISOString() });
    await startEngine({ ready: false });
    connected = true;
    client.emit("ready");
    await settle();
    const all = await rows();
    assert.equal(all.length, 1);
    assert.equal(payloadOf(all[0]).downMs, 20 * MINUTE);
    assert.equal(all[0].status, "sent");
    assert.match(sock.sent[0].text, /20 min/);
  });

  test("two long cuts within 10 minutes give one alert (the slot lasts 10 minutes)", async () => {
    await startEngine();
    client.emit("ready");
    await settle();
    await outage(6 * MINUTE);
    assert.equal((await rows()).length, 1);
    await outage(6 * MINUTE);
    assert.equal((await rows()).length, 1, "the second one is rate limited");
    await outage(6 * MINUTE);
    assert.equal((await rows()).length, 2, "a third, more than 10 minutes after the first slot");
  });

  test("an engine started while the client is already connected behaves like after a ready", async () => {
    await db.AlertState.create({ key: alerts.HEARTBEAT_KEY, value: new Date(START - 7 * MINUTE).toISOString() });
    await startEngine({ ready: true });
    await settle();
    assert.equal((await rows()).length, 1);
  });
});

describe("key_refused, login_blocked, new_origin, update_available", () => {
  test("key_refused: once per service per 24 h, services are independent", async () => {
    await startEngine();
    bus.emitSafe("key:refused", { service: "openai", at: clock.now() });
    bus.emitSafe("key:refused", { service: "openai", at: clock.now() });
    bus.emitSafe("key:refused", { service: "gemini", at: clock.now() });
    await settle();
    let all = await rows();
    assert.deepEqual(all.map((row) => payloadOf(row).service).sort(), ["gemini", "openai"]);
    assert.match(sentTexts().join("\n"), /The openai service refused/);

    jump(23 * HOUR);
    bus.emitSafe("key:refused", { service: "openai", at: clock.now() });
    await settle();
    assert.equal((await rows()).length, 2, "still inside the 24 h window");

    jump(2 * HOUR);
    bus.emitSafe("key:refused", { service: "openai", at: clock.now() });
    await settle();
    all = await rows();
    assert.equal(all.length, 3);
    assert.equal((await slot("key_refused:openai")).count, 2);
  });

  test("login_blocked: once per origin per 15 minutes", async () => {
    await startEngine();
    const blocked = (origin) => alerts.raise("login_blocked", { origin, retryAfterMs: 15 * MINUTE }, { now: clock.now() });
    assert.deepEqual(await blocked("203.0.113.9"), { queued: true });
    assert.deepEqual(await blocked("203.0.113.9"), { queued: false, reason: "rate_limited" });
    assert.deepEqual(await blocked("203.0.113.10"), { queued: true });
    assert.match(sentTexts()[0], /203\.0\.113\.9/);
    assert.match(sentTexts()[0], /15 minutes/);

    jump(14 * MINUTE);
    assert.equal((await blocked("203.0.113.9")).queued, false);
    jump(2 * MINUTE);
    assert.equal((await blocked("203.0.113.9")).queued, true);
    assert.equal((await rows()).length, 3);
  });

  test("new_origin has no limiter: every call is announced", async () => {
    await startEngine();
    const first = await alerts.raise("new_origin", { origin: "198.51.100.7" }, { now: clock.now() });
    const second = await alerts.raise("new_origin", { origin: "198.51.100.8" }, { now: clock.now() });
    assert.deepEqual([first, second], [{ queued: true }, { queued: true }]);
    assert.equal(await slot("new_origin"), null);
    assert.equal(sock.sent.length, 2);
    assert.match(sock.sent[0].text, /198\.51\.100\.7/);
  });

  test("update_available: once per version", async () => {
    await startEngine();
    const notify = (version) => alerts.raise("update_available", { version }, { now: clock.now() });
    assert.equal((await notify("2.4.0")).queued, true);
    assert.deepEqual(await notify("2.4.0"), { queued: false, reason: "rate_limited" });
    jump(10 * DAY);
    assert.equal((await notify("2.4.0")).queued, false, "the same version is never announced twice");
    assert.equal((await notify("2.5.0")).queued, true, "a newer version is");
    assert.equal((await slot("update_available")).value, "2.5.0");
    assert.match(sentTexts().at(-1), /Version 2\.5\.0/);
  });

  test("the auth module's payload (origin, retryAfterMs, at) and options ({ now }) are accepted", async () => {
    await startEngine();
    const at = new Date(clock.now()).toISOString();
    const out = await alerts.raise("login_blocked", { origin: "10.0.0.1", retryAfterMs: 900000, at }, { now: clock.now() });
    assert.deepEqual(out, { queued: true });
    assert.deepEqual(payloadOf((await rows())[0]), { origin: "10.0.0.1", retryAfterMs: 900000, at });
  });
});

describe("the order of raise", () => {
  test("toggle off: dropped without a row and without consuming the slot", async () => {
    await startEngine();
    config.ALERT_KEY_REFUSED = false;
    assert.deepEqual(await alerts.raise("key_refused", { service: "openai" }, { now: clock.now() }), { queued: false, reason: "disabled" });
    assert.equal((await rows()).length, 0);
    assert.equal(await slot("key_refused:openai"), null);

    config.ALERT_KEY_REFUSED = true;
    assert.equal((await alerts.raise("key_refused", { service: "openai" }, { now: clock.now() })).queued, true, "the slot was free");
  });

  test("no owner: dropped without a row and without consuming the slot", async () => {
    await startEngine();
    config.SUDO = "";
    assert.deepEqual(await alerts.raise("key_refused", { service: "openai" }, { now: clock.now() }), { queued: false, reason: "no_recipient" });
    assert.equal((await rows()).length, 0);
    assert.equal(await slot("key_refused:openai"), null);
    assert.equal((await alerts.getStatus()).recipients, 0);

    config.SUDO = "111";
    assert.equal((await alerts.raise("key_refused", { service: "openai" }, { now: clock.now() })).queued, true);
  });

  test("the toggle is checked before the owners", async () => {
    await startEngine();
    config.ALERT_UPDATE = false;
    config.SUDO = "";
    assert.equal((await alerts.raise("update_available", { version: "9.9.9" })).reason, "disabled");
  });

  test("slot lost: dropped, no row", async () => {
    await startEngine();
    await alerts.raise("key_refused", { service: "openai" }, { now: clock.now() });
    assert.deepEqual(await alerts.raise("key_refused", { service: "openai" }, { now: clock.now() }), { queued: false, reason: "rate_limited" });
    assert.equal((await rows()).length, 1);
  });

  test("simultaneous raises cannot both win the slot (the compare-and-swap is one statement)", async () => {
    await startEngine();
    const results = await Promise.all(Array.from({ length: 8 }, () => alerts.raise("key_refused", { service: "weather" }, { now: clock.now() })));
    assert.equal(results.filter((r) => r.queued).length, 1);
    assert.equal((await rows()).length, 1);
    assert.equal((await slot("key_refused:weather")).count, 1);
  });

  test("an unknown type or an unusable payload is refused as invalid, before anything is spent", async () => {
    await startEngine();
    assert.deepEqual(await alerts.raise("nope", {}, { now: clock.now() }), { queued: false, reason: "invalid" });
    assert.deepEqual(await alerts.raise("key_refused", { service: "bad service!" }, { now: clock.now() }), { queued: false, reason: "invalid" });
    assert.deepEqual(await alerts.raise("login_blocked", { origin: "" }, { now: clock.now() }), { queued: false, reason: "invalid" });
    assert.deepEqual(await alerts.raise("update_available", { version: "" }, { now: clock.now() }), { queued: false, reason: "invalid" });
    assert.equal((await rows()).length, 0);
  });

  test("raise never rejects, even when the database fails", async () => {
    await startEngine();
    const original = db.AlertOutbox.create;
    db.AlertOutbox.create = async () => {
      throw new Error("disk full");
    };
    try {
      assert.deepEqual(await alerts.raise("new_origin", { origin: "1.2.3.4" }, { now: clock.now() }), { queued: false });
    } finally {
      db.AlertOutbox.create = original;
    }
  });
});

describe("the outbox: disconnection, restart, attempts, retention", () => {
  test("an alert born during a disconnection is sent at the reconnection, once", async () => {
    await startEngine({ ready: false });
    assert.deepEqual(await alerts.raise("key_refused", { service: "openai" }, { now: clock.now() }), { queued: true });
    assert.deepEqual(await alerts.raise("key_refused", { service: "openai" }, { now: clock.now() }), { queued: false, reason: "rate_limited" }, "not duplicated");
    let all = await rows();
    assert.equal(all.length, 1);
    assert.equal(all[0].status, "pending");
    assert.equal(sock.sent.length, 0, "nothing leaves while the client is cut");

    await clock.advance(2 * MINUTE); // the 30 s flush runs while cut: still nothing
    assert.equal(sock.sent.length, 0);

    connected = true;
    client.emit("ready");
    await settle();
    all = await rows();
    assert.equal(all[0].status, "sent");
    assert.ok(all[0].sentAt);
    assert.equal(sock.sent.length, 1, "sent, not lost");

    await alerts.flush();
    await clock.advance(5 * MINUTE);
    assert.equal(sock.sent.length, 1, "and not sent again by the later flushes");
  });

  test("raise flushes at once when the client is connected", async () => {
    await startEngine();
    await alerts.raise("new_origin", { origin: "9.9.9.9" }, { now: clock.now() });
    assert.equal(sock.sent.length, 1);
    assert.equal((await rows())[0].status, "sent");
  });

  test("the 30 s timer flushes a row queued before the client was connected", async () => {
    await startEngine({ ready: false });
    await alerts.raise("new_origin", { origin: "9.9.9.9" }, { now: clock.now() });
    connected = true; // connected without a ready event reaching the engine
    await clock.advance(31 * 1000);
    await settle();
    assert.equal(sock.sent.length, 1);
  });

  test("a restart does not send an alert again (the slots are persisted)", async () => {
    await startEngine();
    await alerts.raise("key_refused", { service: "openai" }, { now: clock.now() });
    await alerts.raise("update_available", { version: "3.0.0" }, { now: clock.now() });
    assert.equal(sock.sent.length, 2);

    alerts._reset();
    makeClient();
    await startEngine();
    await clock.advance(5 * MINUTE);
    assert.deepEqual(await alerts.raise("key_refused", { service: "openai" }, { now: clock.now() }), { queued: false, reason: "rate_limited" });
    assert.deepEqual(await alerts.raise("update_available", { version: "3.0.0" }, { now: clock.now() }), { queued: false, reason: "rate_limited" });
    assert.equal(sock.sent.length, 0, "the new process sent nothing");
    assert.equal((await rows()).length, 2);
  });

  test("attempts are capped at 3: the row is dropped after the third failure", async () => {
    await startEngine();
    sock.sendMessage = async () => {
      throw new Error("not delivered");
    };
    await alerts.raise("new_origin", { origin: "9.9.9.9" }, { now: clock.now() });
    let [row] = await rows();
    assert.deepEqual([row.status, row.attempts], ["pending", 1]);
    await alerts.flush();
    [row] = await rows();
    assert.deepEqual([row.status, row.attempts], ["pending", 2]);
    await alerts.flush();
    [row] = await rows();
    assert.deepEqual([row.status, row.attempts], ["dropped", 3]);
    await alerts.flush();
    [row] = await rows();
    assert.equal(row.attempts, 3, "a dropped row is not tried again");
  });

  test("one owner out of two receiving is enough to mark the alert sent", async () => {
    config.SUDO = "111,112";
    await startEngine();
    const original = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, content, options) => {
      if (jid.startsWith("111")) throw new Error("blocked");
      return original(jid, content, options);
    };
    await alerts.raise("new_origin", { origin: "9.9.9.9" }, { now: clock.now() });
    const [row] = await rows();
    assert.equal(row.status, "sent");
    assert.deepEqual(sock.sent.map((s) => s.jid), ["112@s.whatsapp.net"]);
  });

  test("an alert goes to every owner", async () => {
    config.SUDO = "111,112";
    await startEngine();
    await alerts.raise("new_origin", { origin: "9.9.9.9" }, { now: clock.now() });
    assert.deepEqual(sock.sent.map((s) => s.jid).sort(), ["111@s.whatsapp.net", "112@s.whatsapp.net"]);
  });

  test("a pending row whose owners were all removed is dropped at send time", async () => {
    await startEngine({ ready: false });
    await alerts.raise("new_origin", { origin: "9.9.9.9" }, { now: clock.now() });
    config.SUDO = "";
    connected = true;
    client.emit("ready");
    await settle();
    const [row] = await rows();
    assert.equal(row.status, "dropped");
    assert.equal(sock.sent.length, 0);
  });

  test("a cut in the middle of a flush leaves the remaining rows pending without burning an attempt", async () => {
    const original = sock.sendMessage.bind(sock);
    let calls = 0;
    sock.sendMessage = async (jid, content, options) => {
      calls += 1;
      const out = await original(jid, content, options);
      connected = false; // the socket drops after the first message
      return out;
    };
    await startEngine({ ready: false });
    for (const origin of ["a.1", "a.2", "a.3"]) await alerts.raise("new_origin", { origin }, { now: clock.now() });
    connected = true;
    await alerts.flush();
    const statuses = (await rows()).map((row) => [row.status, row.attempts]);
    assert.equal(calls, 1);
    assert.deepEqual(statuses, [["sent", 0], ["pending", 0], ["pending", 0]]);
  });

  test("pending rows older than 24 h become expired and are never sent afterwards", async () => {
    await startEngine({ ready: false });
    await alerts.raise("new_origin", { origin: "9.9.9.9" }, { now: clock.now() });
    jump(25 * HOUR);
    await alerts.flush(); // while cut: the rows are not sent, but they age
    let [row] = await rows();
    assert.equal(row.status, "expired");

    connected = true;
    client.emit("ready");
    await settle();
    [row] = await rows();
    assert.equal(row.status, "expired");
    assert.equal(sock.sent.length, 0);
  });

  test("a pending row younger than 24 h survives and is sent", async () => {
    await startEngine({ ready: false });
    await alerts.raise("new_origin", { origin: "9.9.9.9" }, { now: clock.now() });
    jump(23 * HOUR);
    connected = true;
    client.emit("ready");
    await settle();
    assert.equal((await rows())[0].status, "sent");
  });

  test("rows that are not pending are deleted 7 days after their last change; pending ones stay", async () => {
    await startEngine();
    await alerts.raise("new_origin", { origin: "1.1.1.1" }, { now: clock.now() }); // sent at day 0
    connected = false;
    await alerts.raise("new_origin", { origin: "2.2.2.2" }, { now: clock.now() }); // pending at day 0
    assert.deepEqual((await rows()).map((row) => row.status), ["sent", "pending"]);

    jump(2 * DAY);
    await alerts.flush(); // the pending row expires at day 2
    assert.deepEqual((await rows()).map((row) => row.status), ["sent", "expired"]);

    jump(6 * DAY); // day 8: the sent row is 8 days old, the expired one 6
    await alerts.flush();
    assert.deepEqual((await rows()).map((row) => row.status), ["expired"]);

    jump(2 * DAY); // day 10: the expired row is 8 days past its change
    await alerts.flush();
    assert.equal((await rows()).length, 0);
  });

  test("login_blocked slots are pruned after 24 h, the other slots stay", async () => {
    await startEngine();
    await alerts.raise("login_blocked", { origin: "5.5.5.5", retryAfterMs: 900000 }, { now: clock.now() });
    await alerts.raise("key_refused", { service: "openai" }, { now: clock.now() });
    jump(25 * HOUR);
    await alerts.prune({ now: clock.now() });
    assert.equal(await slot("login_blocked:5.5.5.5"), null);
    assert.ok(await slot("key_refused:openai"));
  });
});

describe("content of an alert", () => {
  test("the text is rendered at send time, in the language of that moment", async () => {
    await startEngine({ ready: false });
    await alerts.raise("key_refused", { service: "openai" }, { now: clock.now() }); // born in English
    config.LANG = "fr";
    languageManager.reload();
    applyBotFragments();
    try {
      connected = true;
      client.emit("ready");
      await settle();
      assert.match(sock.sent[0].text, /Le service openai a refusé/);
    } finally {
      config.LANG = "en";
      languageManager.reload();
      applyBotFragments();
    }
  });

  test("a payload is rebuilt field by field: no key, stack, JID or unknown field reaches the outbox", async () => {
    await startEngine();
    await alerts.raise(
      "key_refused",
      { service: "OpenAI", apiKey: "sk-live-0123456789", stack: "Error: x\n    at secret.js:1", jid: "237600000000@s.whatsapp.net", token: "t" },
      { now: clock.now() },
    );
    await alerts.raise("errors_series", { count: 12, top: [{ name: "play\u0000\n", count: 7, stack: "boom" }], error: new Error("x") }, { now: clock.now() });
    const [keyRow, burstRow] = await rows();
    assert.deepEqual(Object.keys(payloadOf(keyRow)).sort(), ["at", "service"]);
    assert.equal(payloadOf(keyRow).service, "openai");
    assert.deepEqual(Object.keys(payloadOf(burstRow)).sort(), ["at", "count", "top"]);
    assert.deepEqual(payloadOf(burstRow).top, [{ name: "play", count: 7 }]);

    const everything = (await rows()).map((row) => row.payload).concat(sentTexts()).join("\n");
    assert.doesNotMatch(everything, /sk-live|secret\.js|237600000000|stack|boom/);
  });

  test("a service name that is a JID is refused, not stored", async () => {
    await startEngine();
    assert.equal((await alerts.raise("key_refused", { service: "237600000000@s.whatsapp.net" }, { now: clock.now() })).reason, "invalid");
  });

  test("every type has a text in both languages and the key is never shown", () => {
    const samples = {
      reconnected: { downMs: 7 * MINUTE },
      errors_series: { count: 10, top: [{ name: "play", count: 4 }] },
      key_refused: { service: "gemini" },
      login_blocked: { origin: "1.2.3.4", retryAfterMs: 900000 },
      new_origin: { origin: "1.2.3.4" },
      update_available: { version: "1.0.1" },
    };
    for (const lang of ["en", "fr"]) {
      config.LANG = lang;
      languageManager.reload();
      applyBotFragments();
      for (const type of alerts.TYPES) {
        const text = alerts._internals.renderText(type, samples[type]);
        assert.ok(text && text !== `alerts.${type}` && !/\{\d\}/.test(text), `${lang} ${type}: ${text}`);
      }
    }
    config.LANG = "en";
    languageManager.reload();
    applyBotFragments();
  });

  test("durations read the same in both languages", () => {
    const { formatDuration } = alerts._internals;
    assert.equal(formatDuration(7 * MINUTE), "7 min");
    assert.equal(formatDuration(60 * MINUTE), "1 h");
    assert.equal(formatDuration(65 * MINUTE), "1 h 05");
    assert.equal(formatDuration(26 * HOUR + 10 * MINUTE), "26 h 10");
  });
});

describe("getStatus", () => {
  test("pending counts per type, last send per type, recent rows", async () => {
    await startEngine();
    await alerts.raise("key_refused", { service: "openai" }, { now: clock.now() });
    await clock.advance(MINUTE);
    connected = false;
    await alerts.raise("new_origin", { origin: "7.7.7.7" }, { now: clock.now() });
    await alerts.raise("new_origin", { origin: "7.7.7.8" }, { now: clock.now() });

    const status = await alerts.getStatus({ recent: 10 });
    assert.equal(status.pending, 2);
    assert.equal(status.pendingByType.new_origin, 2);
    assert.equal(status.pendingByType.key_refused, 0);
    assert.equal(status.lastSent.key_refused, new Date(START).toISOString());
    assert.equal(status.lastSent.new_origin, null, "queued but not sent yet");
    assert.deepEqual(status.recent.map((row) => [row.type, row.status]), [["new_origin", "pending"], ["new_origin", "pending"], ["key_refused", "sent"]]);
    assert.equal(status.recent[2].sentAt, new Date(START).toISOString());
  });
});
