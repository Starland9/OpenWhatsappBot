"use strict";
/**
 * lib/utils/sendGate.js and the five gate lines of lib/utils/broadcaster.js (feature 004, contracts/runtime.md
 * section 11, RT-110, RT-111): the process-wide pacing floor shared by the messaging outbox and the broadcaster.
 *
 *  - the gate: ready / waitMs / reserve / seed / lastSendAt, the jitter drawn once per reserve for the NEXT gap,
 *    the upward-only setting SEND_MIN_SPACING_MS read at call time, the process-wide `shared` instance;
 *  - the broadcaster: a private gate by default, seeding at ensureLastSendAt, ready() after its own gap, reserve()
 *    after the claim; foreign reservations on one shared gate keep the 2 s floor without starving a slow broadcast.
 *
 * Fake clock, fake socket, in-memory database. test/broadcaster.test.js is untouched and must keep passing.
 */

const { test, describe, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createClock } = require("./helpers/fakeClock");
const sendGate = require("../lib/utils/sendGate");
const { createSendGate } = sendGate;
const { createBroadcaster } = require("../lib/utils/broadcaster");

const T0 = Date.UTC(2026, 5, 1, 10, 0, 0);

/** A config stand-in whose spacing can change between two calls. */
const configWith = (value) => ({ SEND_MIN_SPACING_MS: value });

describe("createSendGate: ready, waitMs, reserve", () => {
  test("a gate that never reserved is ready, lastSendAt is null", () => {
    const gate = createSendGate({ random: () => 0, config: configWith(2000) });
    assert.equal(gate.lastSendAt(), null);
    assert.equal(gate.ready(0), true);
    assert.equal(gate.ready(T0), true);
    assert.equal(gate.waitMs(T0), 0);
  });

  test("after reserve(at) the next send waits the spacing", () => {
    const gate = createSendGate({ random: () => 0, config: configWith(2000) });
    gate.reserve(T0);
    assert.equal(gate.lastSendAt(), T0);
    assert.equal(gate.ready(T0), false);
    assert.equal(gate.ready(T0 + 1999), false);
    assert.equal(gate.ready(T0 + 2000), true, "at - last >= gap is ready");
    assert.equal(gate.waitMs(T0), 2000);
    assert.equal(gate.waitMs(T0 + 500), 1500);
    assert.equal(gate.waitMs(T0 + 2000), 0);
    assert.equal(gate.waitMs(T0 + 99999), 0);
  });

  test("extraMs raises the gap, never lowers it below the spacing", () => {
    const gate = createSendGate({ random: () => 0, config: configWith(2000) });
    gate.reserve(T0);
    assert.equal(gate.ready(T0 + 2000, 5000), false);
    assert.equal(gate.ready(T0 + 4999, 5000), false);
    assert.equal(gate.ready(T0 + 5000, 5000), true);
    assert.equal(gate.waitMs(T0 + 1000, 5000), 4000);
    // an extra below the floor changes nothing
    assert.equal(gate.ready(T0 + 1999, 500), false);
    assert.equal(gate.ready(T0 + 2000, 500), true);
  });

  test("the jitter is random() * 0.2, drawn once per reserve, for the NEXT gap", () => {
    const draws = [];
    const values = [1, 0, 0.5];
    const gate = createSendGate({ random: () => (draws.push(1), values[draws.length - 1]), config: configWith(2000) });
    assert.equal(draws.length, 0, "nothing drawn at creation");
    gate.ready(T0);
    gate.waitMs(T0);
    assert.equal(draws.length, 0, "ready / waitMs never draw");

    gate.reserve(T0); // draw 1 -> jitter 0.2 -> gap 2400
    assert.equal(draws.length, 1);
    for (let i = 0; i < 5; i += 1) {
      gate.ready(T0 + 100 * i);
      gate.waitMs(T0 + 100 * i);
    }
    assert.equal(draws.length, 1, "held while it waits");
    assert.equal(gate.ready(T0 + 2399), false);
    assert.equal(gate.ready(T0 + 2400), true);
    assert.equal(gate.waitMs(T0), 2400);

    gate.reserve(T0 + 2400); // draw 2 -> jitter 0 -> gap 2000
    assert.equal(draws.length, 2);
    assert.equal(gate.ready(T0 + 2400 + 1999), false);
    assert.equal(gate.ready(T0 + 2400 + 2000), true);

    gate.reserve(T0 + 5000); // draw 3 -> jitter 0.1 -> gap 2200
    assert.equal(gate.waitMs(T0 + 5000), 2200);
  });

  test("the extra is multiplied by the jitter too (the formula of broadcaster.js)", () => {
    const gate = createSendGate({ random: () => 1, config: configWith(2000) });
    gate.reserve(T0);
    assert.equal(gate.waitMs(T0, 5000), 6000, "5000 x 1.2");
    assert.equal(gate.ready(T0 + 5999, 5000), false);
    assert.equal(gate.ready(T0 + 6000, 5000), true);
  });

  test("the default clock and random are usable", () => {
    const gate = createSendGate({ config: configWith(2000) });
    gate.reserve(Date.now());
    assert.equal(gate.ready(Date.now()), false);
  });
});

describe("createSendGate: seed", () => {
  test("seed keeps the maximum", () => {
    const gate = createSendGate({ random: () => 0, config: configWith(2000) });
    gate.seed(T0);
    assert.equal(gate.lastSendAt(), T0);
    gate.seed(T0 - 5000);
    assert.equal(gate.lastSendAt(), T0, "an older value never moves the gate back");
    gate.seed(T0 + 100);
    assert.equal(gate.lastSendAt(), T0 + 100);
    assert.equal(gate.ready(T0 + 100), false);
    assert.equal(gate.ready(T0 + 2100), true);
  });

  test("a non-finite value is ignored", () => {
    const gate = createSendGate({ random: () => 0, config: configWith(2000) });
    for (const bad of [NaN, Infinity, -Infinity, undefined, null, "x"]) gate.seed(bad);
    assert.equal(gate.lastSendAt(), null);
    assert.equal(gate.ready(T0), true);
    gate.seed(T0);
    gate.seed(NaN);
    gate.seed(-Infinity);
    assert.equal(gate.lastSendAt(), T0);
  });

  test("seed does not draw a jitter", () => {
    let draws = 0;
    const gate = createSendGate({ random: () => (draws += 1, 1), config: configWith(2000) });
    gate.seed(T0);
    assert.equal(draws, 0);
    assert.equal(gate.waitMs(T0), 2000, "a seeded gate uses no jitter until the first reserve");
  });

  test("reserve after a seed replaces the reference (reserve is last = at)", () => {
    const gate = createSendGate({ random: () => 0, config: configWith(2000) });
    gate.seed(T0 + 10000);
    gate.reserve(T0 + 20000);
    assert.equal(gate.lastSendAt(), T0 + 20000);
  });
});

describe("createSendGate: SEND_MIN_SPACING_MS, read at call time, raised only upward", () => {
  test("the setting is read at every call", () => {
    const config = configWith(2000);
    const gate = createSendGate({ random: () => 0, config });
    gate.reserve(T0);
    assert.equal(gate.ready(T0 + 2000), true);
    config.SEND_MIN_SPACING_MS = 10000;
    assert.equal(gate.ready(T0 + 2000), false, "the new spacing applies to the very next call");
    assert.equal(gate.waitMs(T0 + 2000), 8000);
    assert.equal(gate.ready(T0 + 10000), true);
  });

  test("a lower or invalid setting never goes below 2000", () => {
    const config = configWith(500);
    const gate = createSendGate({ random: () => 0, config });
    gate.reserve(T0);
    assert.equal(gate.waitMs(T0), 2000);
    for (const bad of [0, -5, "abc", undefined, null, NaN]) {
      config.SEND_MIN_SPACING_MS = bad;
      assert.equal(gate.waitMs(T0), 2000, `${String(bad)} falls back to 2000`);
    }
    config.SEND_MIN_SPACING_MS = "7000";
    assert.equal(gate.waitMs(T0), 7000, "a numeric string is read as a number");
  });

  test("a config without the key behaves as 2000 (the setting may not exist yet)", () => {
    const gate = createSendGate({ random: () => 0, config: {} });
    gate.reserve(T0);
    assert.equal(gate.waitMs(T0), 2000);
  });

  test("with no config given, the real config is read lazily, not at creation", () => {
    const gate = createSendGate({ random: () => 0 });
    gate.reserve(T0);
    assert.ok(gate.waitMs(T0) >= 2000);
  });
});

describe("sendGate module", () => {
  test("exports createSendGate and the process-wide instance", () => {
    assert.equal(typeof sendGate.createSendGate, "function");
    assert.equal(typeof sendGate.shared, "object");
    for (const name of ["ready", "waitMs", "reserve", "seed", "lastSendAt"]) {
      assert.equal(typeof sendGate.shared[name], "function", name);
    }
  });

  test("shared is one instance for every require", () => {
    assert.equal(require("../lib/utils/sendGate").shared, sendGate.shared);
  });

  test("two created gates are independent", () => {
    const a = createSendGate({ random: () => 0, config: configWith(2000) });
    const b = createSendGate({ random: () => 0, config: configWith(2000) });
    a.reserve(T0);
    assert.equal(b.ready(T0), true);
    assert.equal(b.lastSendAt(), null);
  });

  test("no timer, listener or require of lib/admin at load (RT-01, RT-02)", () => {
    const source = fs.readFileSync(require.resolve("../lib/utils/sendGate"), "utf8");
    assert.doesNotMatch(source, /setInterval|setTimeout/);
    assert.doesNotMatch(source, /require\([^)]*(admin|\/api\/)/);
  });

  test("no config.X is copied into a module-level constant (RT-03)", () => {
    const source = fs.readFileSync(require.resolve("../lib/utils/sendGate"), "utf8");
    assert.doesNotMatch(source, /^(const|let|var)\s+\w+\s*=\s*[\w.()]*config[\w.()]*\.SEND_MIN_SPACING_MS/m);
  });
});

// ---------------------------------------------------------------------------
// The broadcaster side
// ---------------------------------------------------------------------------

describe("broadcaster: the five gate lines (RT-110, RT-111)", () => {
  let db;
  let tmp;
  let clock;
  let cfg;
  const engines = [];

  before(async () => {
    db = await fakes.syncDb();
  });

  beforeEach(async () => {
    for (const name of ["BroadcastTarget", "BroadcastRun", "Broadcast", "KnownChat", "BannedChat"]) {
      await db[name].destroy({ where: {} });
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-gate-"));
    clock = createClock(T0);
    cfg = { TIMEZONE: "Europe/Paris", MAX_UPLOAD: 1, BROADCAST_DELAY_MS: 5000 };
  });

  afterEach(() => {
    for (const engine of engines.splice(0)) engine.stop();
    clock.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function newEngine(over = {}) {
    const sock = over.sock || fakes.fakeSocket();
    const client = over.client || fakes.fakeClient(sock);
    const engine = createBroadcaster({
      rootDir: tmp,
      config: cfg,
      clock: () => clock.now(),
      random: over.random || (() => 0),
      timers: clock.timers,
      settingsStore: { onChange: () => () => {} },
      ...over.options,
    });
    engine.start(client);
    engines.push(engine);
    return { engine, sock, client };
  }

  async function chats(count, start = 1000) {
    const jids = [];
    const rows = [];
    for (let i = 0; i < count; i += 1) {
      const jid = `${start + i}@s.whatsapp.net`;
      jids.push(jid);
      rows.push({ jid, kind: "private", pnJid: jid, name: `chat ${start + i}`, firstSeenAt: new Date(T0), lastSeenAt: new Date(T0) });
    }
    await db.KnownChat.bulkCreate(rows);
    return jids;
  }

  test("createBroadcaster() without a gate option owns a private gate (the process-wide one is untouched)", async () => {
    const before = sendGate.shared.lastSendAt();
    const { engine, sock } = newEngine();
    await engine.createOnce({ text: "x", targets: await chats(2), spacingMs: 2000 }, { now: clock.now() });
    assert.equal((await engine.tick(clock.now())).sent, 1);
    assert.equal(sock.sent.length, 1);
    assert.equal(sendGate.shared.lastSendAt(), before, "a test engine never reserves on the shared gate");
  });

  test("the default engine is built on the shared gate (the five places of section 11)", () => {
    const source = fs.readFileSync(require.resolve("../lib/utils/broadcaster"), "utf8");
    assert.match(source, /createBroadcaster\(\{\s*gate:\s*require\("\.\/sendGate"\)\.shared\s*\}\)/);
    assert.match(source, /options\.gate \|\| createSendGate\(\{ clock, random \}\)/);
    assert.match(source, /sendGate\.seed\(lastSendAt\)/);
    assert.match(source, /if \(!sendGate\.ready\(at\)\) return;/);
    assert.match(source, /sendGate\.reserve\(at\)/);
  });

  test("deliverOne reserves on the gate after its claim and ensureLastSendAt seeds it", async () => {
    const gate = createSendGate({ clock: () => clock.now(), random: () => 0, config: configWith(2000) });
    const { engine, sock } = newEngine({ options: { gate } });
    assert.equal(gate.lastSendAt(), null);
    await engine.createOnce({ text: "x", targets: await chats(2), spacingMs: 2000 }, { now: clock.now() });

    assert.equal((await engine.tick(clock.now())).sent, 1);
    assert.equal(gate.lastSendAt(), clock.now(), "reserved at the instant of the claim");
    assert.equal(sock.sent.length, 1);

    // a restarted engine seeds a fresh gate from the stored send time: no burst right behind the last message
    const restartedGate = createSendGate({ clock: () => clock.now(), random: () => 0, config: configWith(2000) });
    const second = newEngine({ sock, options: { gate: restartedGate } });
    clock.set(clock.now() + 500);
    assert.equal((await second.engine.tick(clock.now())).sent, 0);
    assert.ok(restartedGate.lastSendAt() !== null && restartedGate.lastSendAt() >= T0, "seeded from max(sentAt)");
    clock.set(T0 + 2000);
    assert.equal((await second.engine.tick(clock.now())).sent, 1);
  });

  test("a foreign reservation on the shared gate delays the broadcast to the 2 s floor", async () => {
    const gate = createSendGate({ clock: () => clock.now(), random: () => 0, config: configWith(2000) });
    const { engine, sock } = newEngine({ options: { gate } });
    await engine.createOnce({ text: "x", targets: await chats(3), spacingMs: 2000 }, { now: clock.now() });

    gate.reserve(clock.now()); // an API message went out right now
    assert.equal((await engine.tick(clock.now())).sent, 0, "the gate is not ready");
    clock.set(T0 + 1999);
    assert.equal((await engine.tick(clock.now())).sent, 0);
    clock.set(T0 + 2000);
    assert.equal((await engine.tick(clock.now())).sent, 1);
    assert.equal(sock.sent.length, 1);

    // and the other way round: the API sees the broadcast's send
    assert.equal(gate.ready(clock.now() + 1999), false);
    assert.equal(gate.ready(clock.now() + 2000), true);
  });

  test("a broadcast and foreign reservations stay at least 2000 ms apart (RT-110)", async () => {
    const gate = createSendGate({ clock: () => clock.now(), random: () => 0, config: configWith(2000) });
    const { engine } = newEngine({ options: { gate } });
    await engine.createOnce({ text: "x", targets: await chats(40), spacingMs: 2000 }, { now: clock.now() });

    const times = [];
    const foreign = () => {
      if (gate.ready(clock.now())) {
        gate.reserve(clock.now());
        times.push(clock.now());
      }
    };
    for (let step = 0; step < 400; step += 1) {
      clock.set(T0 + step * 250);
      if (step % 7 === 3) foreign();
      const sent = (await engine.tick(clock.now())).sent;
      if (sent) times.push(clock.now());
    }
    assert.ok(times.length > 20, "both sources sent");
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i] - times[i - 1] >= 2000, `gap ${times[i] - times[i - 1]} at ${i}`);
    }
  });

  test("a 60 s-spacing broadcast is not starved and not reset by foreign reservations", async () => {
    const gate = createSendGate({ clock: () => clock.now(), random: () => 0, config: configWith(2000) });
    const { engine, sock } = newEngine({ options: { gate } });
    await engine.createOnce({ text: "x", targets: await chats(3), spacingMs: 60000 }, { now: clock.now() });

    assert.equal((await engine.tick(clock.now())).sent, 1, "first send at 0");
    const sentAt = [clock.now()];
    for (let s = 1; s <= 140; s += 1) {
      clock.set(T0 + s * 1000);
      // an API message every 30 s, offset so it never lands on the broadcast instants
      if (s % 30 === 15 && gate.ready(clock.now())) gate.reserve(clock.now());
      if ((await engine.tick(clock.now())).sent) sentAt.push(clock.now());
    }
    assert.deepEqual(sentAt, [T0, T0 + 60000, T0 + 120000], "one send every 60 s despite 4 foreign reservations");
    assert.equal(sock.sent.length, 3);
  });

  test("a foreign reservation right before the broadcast instant delays it by the floor only", async () => {
    const gate = createSendGate({ clock: () => clock.now(), random: () => 0, config: configWith(2000) });
    const { engine } = newEngine({ options: { gate } });
    await engine.createOnce({ text: "x", targets: await chats(2), spacingMs: 60000 }, { now: clock.now() });
    assert.equal((await engine.tick(clock.now())).sent, 1);

    clock.set(T0 + 59000);
    gate.reserve(clock.now());
    clock.set(T0 + 60000);
    assert.equal((await engine.tick(clock.now())).sent, 0, "1 s behind a foreign send");
    clock.set(T0 + 61000);
    assert.equal((await engine.tick(clock.now())).sent, 1, "2 s behind it");
  });

  test("the setting is read at call time by a broadcaster's gate (raising it slows the next send)", async () => {
    const gateConfig = configWith(2000);
    const gate = createSendGate({ clock: () => clock.now(), random: () => 0, config: gateConfig });
    const { engine } = newEngine({ options: { gate } });
    await engine.createOnce({ text: "x", targets: await chats(3), spacingMs: 2000 }, { now: clock.now() });
    assert.equal((await engine.tick(clock.now())).sent, 1);
    gateConfig.SEND_MIN_SPACING_MS = 9000;
    clock.set(T0 + 2000);
    assert.equal((await engine.tick(clock.now())).sent, 0);
    clock.set(T0 + 9000);
    assert.equal((await engine.tick(clock.now())).sent, 1);
  });
});
