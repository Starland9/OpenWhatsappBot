"use strict";
/**
 * SC-007: the dashboard follows the real state of the bot within 5 seconds (FR-012). Fake clock and fake runtime:
 * a `state` event is pushed at once on ready / close / qr / restart phases and otherwise at most once per second;
 * a change reaches an SSE client in well under 5 s; the `state` and `pairing` events carry neither the QR string
 * nor the pairing code; the 2 s polling fallback (`GET /admin/api/state`) answers the very object of the stream and
 * does not extend the session.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createTestAdmin } = require("./helpers/adminHarness");
const { createFakeRuntime, QR_SENTINEL, CODE_SENTINEL } = require("./helpers/fakeBotRuntime");
const { openEventStream } = require("./helpers/sseTap");
const { getStateService } = require("../lib/admin/services/state");
const ring = require("../lib/admin/logs/ring");

const SECOND = 1000;
const HOUR = 60 * 60 * 1000;

let t;
let client;
let rt;
let mem;
const streams = [];

/** Let the promise chains of a published state (snapshot, publish) settle. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function boot() {
  ring.clear();
  rt = createFakeRuntime();
  mem = { rss: 100, heapUsed: 50, heapTotal: 80, external: 4 };
  t = await createTestAdmin({
    deps: {
      runtime: rt,
      ring,
      memoryUsage: () => ({ ...mem }),
      dbProbe: async () => true,
      updater: { restartRequired: () => ({ required: false }) },
    },
  });
  await t.admin.start();
  client = await t.loginClient();
}

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close();
  if (t) {
    await fakes.waitFor(() => t.admin.sse.count() === 0, { timeout: 3000 });
    await t.close();
  }
  t = null;
});

const open = async (target = "/admin/api/events", headers) => {
  const stream = await openEventStream({ port: t.port, client, target, headers });
  streams.push(stream);
  return stream;
};

describe("state events on the hub", () => {
  beforeEach(boot);

  test("pushed at once on qr, ready (open), close and every restart phase, even within the same second", async () => {
    const seen = [];
    t.hub.subscribe("state", (state) => seen.push(state));
    rt.set({ status: "qr", qrVersion: 1, hasQr: true });
    await settle();
    assert.deepEqual(seen.map((s) => s.bot.status), ["qr"], "the first change goes out immediately");

    // all of these happen inside the same second: a forced publish bypasses the coalescing
    rt.set({ status: "open", hasQr: false, registered: true });
    await settle();
    rt.set({ status: "reconnecting" });
    await settle();
    rt.set({ status: "open" });
    await settle();
    rt.set({ restarting: true });
    await settle();
    rt.set({ status: "stopped" });
    await settle();
    rt.set({ status: "connecting" });
    await settle();
    rt.set({ status: "open", restarting: false });
    await settle();
    assert.deepEqual(
      seen.map((s) => s.bot.status),
      ["qr", "open", "reconnecting", "open", "restarting", "restarting", "restarting", "open"],
      "eight changes, eight events (the client statuses stopped and connecting read `restarting` while the runtime restarts)",
    );
    assert.equal(t.clock.now(), Date.UTC(2026, 0, 1, 12, 0, 0), "no time went by: nothing waited for a second");
  });

  test("a new QR (same status) is pushed at once too, even right after another event", async () => {
    const seen = [];
    t.hub.subscribe("state", (state) => seen.push(state));
    rt.set({ status: "qr", qrVersion: 1, hasQr: true });
    await settle();
    rt.set({ qrVersion: 2 });
    await settle();
    assert.equal(seen.length, 2, "the renewal does not wait for the end of the second");
  });

  test("other changes are held back: at most one event per second, always the newest data", async () => {
    const seen = [];
    const times = [];
    t.hub.subscribe("state", (state) => {
      seen.push(state);
      times.push(t.clock.now());
    });
    rt.set({ status: "reconnecting" }); // forced, starts the second
    await settle();
    assert.equal(seen.length, 1);

    for (let n = 1; n <= 20; n += 1) rt.set({ messagesProcessed: 100 + n });
    await settle();
    assert.equal(seen.length, 1, "twenty counter updates inside the second: nothing yet");
    await t.clock.advance(999);
    await settle();
    assert.equal(seen.length, 1);
    await t.clock.advance(1);
    await settle();
    assert.equal(seen.length, 2, "one event once the second is over");
    assert.equal(seen[1].bot.messagesProcessed, 120, "carrying the newest value, not the first");

    // the 2 s ticker keeps the uptime and the counters fresh while somebody listens
    rt.status.uptimeMs += 2000;
    await t.clock.advance(2 * SECOND);
    await settle();
    assert.equal(seen.length, 3);
    assert.equal(seen[2].bot.uptimeSec, seen[1].bot.uptimeSec + 2);
    for (let i = 1; i < times.length; i += 1) assert.ok(times[i] - times[i - 1] >= SECOND, "never two events within a second");
  });

  test("no ticker without a listener: the hub arms its 2 s ticker with the first subscriber only", async () => {
    assert.equal(t.hub.tickerArmed(), false);
    const off = t.hub.subscribe("state", () => {});
    assert.equal(t.hub.tickerArmed(), true);
    off();
    assert.equal(t.hub.tickerArmed(), false);
  });

  test("stop() detaches the dashboard from the runtime; start() attaches it again", async () => {
    const service = getStateService(t.deps);
    const calls = [];
    const publishState = t.hub.publishState;
    t.hub.publishState = (...args) => {
      calls.push(args);
      return publishState(...args);
    };
    assert.equal(service.attached(), true);
    await t.admin.stop();
    assert.equal(service.attached(), false);
    rt.set({ status: "stopped" });
    await settle();
    assert.equal(calls.length, 0, "a stopped admin does not follow the runtime");
    await t.admin.start();
    assert.equal(service.attached(), true);
    rt.set({ status: "connecting" });
    await settle();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [{ force: true }]);
    t.hub.publishState = publishState;
  });
});

describe("the live stream (EVT-1)", () => {
  beforeEach(boot);

  test("a client gets the current state on connecting, then every change", async () => {
    const stream = await open();
    await stream.waitFor((s) => s.events("state").length >= 1);
    const first = stream.events("state")[0].payload;
    assert.equal(first.bot.status, "open");
    assert.equal(first.bot.version, "9.9.9-test");
    assert.deepEqual(Object.keys(first.memory), ["rss", "heapUsed", "heapTotal", "external"]);

    rt.set({ status: "reconnecting" });
    await stream.waitFor((s) => s.events("state").some((f) => f.payload.bot.status === "reconnecting"));
    rt.set({ status: "qr", qrVersion: 3, hasQr: true });
    await stream.waitFor((s) => s.events("state").some((f) => f.payload.bot.status === "qr"));
  });

  test("SC-007: a change the runtime does not announce reaches the client within 5 s (the 2 s ticker)", async () => {
    const stream = await open();
    await stream.waitFor((s) => s.events("state").length >= 1);
    const before = stream.events("state").length;

    mem.rss = 777; // nothing emits for a memory change
    rt.status.messagesProcessed = 4242;
    const started = t.clock.now();
    await t.clock.advance(2 * SECOND);
    await stream.waitFor((s) => s.events("state").length > before);
    const latest = stream.events("state").pop().payload;
    assert.equal(latest.memory.rss, 777);
    assert.equal(latest.bot.messagesProcessed, 4242);
    assert.ok(t.clock.now() - started < 5 * SECOND, "well under the 5 s of SC-007");
  });

  test("the event stream carries no QR string and no pairing code, in any event", async () => {
    const stream = await open();
    await stream.waitFor((s) => s.events("state").length >= 1);
    rt.set({ status: "qr", qrVersion: 1, hasQr: true, pairing: { requestedAt: 1, expiresAt: 2, code: CODE_SENTINEL } });
    await stream.waitFor((s) => s.events("state").some((f) => f.payload.bot.status === "qr"));
    await t.clock.advance(2 * SECOND);
    assert.ok(!stream.text.includes(QR_SENTINEL), "no QR string");
    assert.ok(!stream.text.includes(CODE_SENTINEL), "no pairing code");
    for (const frame of stream.events("pairing")) {
      assert.notEqual(typeof frame.payload.qr, "string", "the pairing event describes the QR, it never carries it");
      assert.ok(!("code" in frame.payload) || typeof frame.payload.code !== "string");
    }
  });

  test("the polling fallback returns the very object of the stream", async () => {
    const stream = await open();
    await stream.waitFor((s) => s.events("state").length >= 1);
    const before = stream.events("state").length;
    rt.status.messagesProcessed = 99;
    await t.clock.advance(2 * SECOND);
    await stream.waitFor((s) => s.events("state").length > before);
    const pushed = stream.events("state").pop().payload;

    const polled = await client.get("/admin/api/state");
    assert.equal(polled.status, 200);
    assert.deepEqual(polled.json, pushed);
  });

  test("polling does not extend the session: it expires 24 h after the last touching request", async () => {
    const probe = async () => (await client.get("/admin/api/state")).status;
    await t.clock.advance(23 * HOUR);
    assert.equal(await probe(), 200);
    await t.clock.advance(59 * 60 * SECOND);
    assert.equal(await probe(), 200, "still alive at 23 h 59 min");
    await t.clock.advance(60 * SECOND + 1);
    const late = await client.get("/admin/api/state");
    assert.equal(late.status, 401);
    assert.equal(late.json.error.code, "session_expired", "the polls in between did not extend the idle clock");
  });
});
