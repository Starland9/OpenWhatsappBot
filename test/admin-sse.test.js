"use strict";
/**
 * Live updates of the admin panel (admin-http-api.md section 3 and 1.16): the topic hub, the SSE stream
 * (EVT-1) and the jobs registry (JOB-1). The clock and the timers are fake (test/helpers/fakeClock.js): the
 * heartbeat, the state ticker and the job retention are driven by `clock.advance()`, never by waiting.
 */

const { test, describe, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const net = require("net");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createHub } = require("../lib/admin/events");
const { createJobs, MAX_JOBS, RETENTION_MS } = require("../lib/admin/jobs");
const { frame, PER_SESSION, TOTAL, MAX_BUFFERED_BYTES, PREAMBLE_COMMENT_BYTES, HEARTBEAT_MS } = require("../lib/admin/http/sse");
const { SECURITY_HEADERS } = require("../lib/admin/http/security");
const { startStubAdmin } = require("./helpers/adminStub");
const { createClock } = require("./helpers/fakeClock");

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

describe("hub", () => {
  test("publish, subscribe, unsubscribe and subscriberCount", () => {
    const hub = createHub();
    const seen = [];
    const off = hub.subscribe("job", (payload) => seen.push(payload));
    assert.equal(hub.subscriberCount("job"), 1);
    hub.publish("job", { id: 1 });
    off();
    hub.publish("job", { id: 2 });
    assert.deepEqual(seen, [{ id: 1 }]);
    assert.equal(hub.subscriberCount("job"), 0);
    assert.deepEqual(hub.TOPICS, ["state", "pairing", "log", "job", "session"]);
  });

  test("only the five topics exist", () => {
    const hub = createHub();
    assert.throws(() => hub.publish("nope", {}), /unknown hub topic/);
    assert.throws(() => hub.subscribe("nope", () => {}), /unknown hub topic/);
    assert.throws(() => hub.subscribe("job", "not a function"), /needs a function/);
  });

  test("a throwing subscriber never starves the others", () => {
    const hub = createHub();
    const seen = [];
    hub.subscribe("pairing", () => {
      throw new Error("bad subscriber");
    });
    hub.subscribe("pairing", (payload) => seen.push(payload));
    assert.doesNotThrow(() => hub.publish("pairing", { status: "qr" }));
    assert.deepEqual(seen, [{ status: "qr" }]);
  });

  test("snapshots: async providers, a failing provider and no provider all resolve", async () => {
    const hub = createHub();
    assert.equal(await hub.snapshot("state"), null);
    hub.setSnapshot("state", async () => ({ at: 1 }));
    assert.deepEqual(await hub.snapshot("state"), { at: 1 });
    hub.setSnapshot("pairing", () => {
      throw new Error("boom");
    });
    assert.equal(await hub.snapshot("pairing"), null);
    hub.setSnapshot("state", null);
    assert.equal(await hub.snapshot("state"), null);
  });

  test("state is coalesced to one per second; a forced publish goes out at once", async () => {
    const clock = createClock();
    const hub = createHub({ now: clock.now, timers: clock.timers });
    const seen = [];
    hub.subscribe("state", (payload) => seen.push(payload.n));

    hub.publish("state", { n: 1 });
    assert.deepEqual(seen, [1], "the first one goes out at once");
    hub.publish("state", { n: 2 });
    hub.publish("state", { n: 3 });
    assert.deepEqual(seen, [1], "within the second: held back");
    await clock.advance(999);
    assert.deepEqual(seen, [1]);
    await clock.advance(1);
    assert.deepEqual(seen, [1, 3], "only the newest payload of the second is delivered");

    hub.publish("state", { n: 4 }, { force: true });
    assert.deepEqual(seen, [1, 3, 4], "forced (ready / close / qr): immediate");
    hub.publish("state", { n: 5 });
    hub.publish("state", { n: 6 }, { force: true });
    assert.deepEqual(seen, [1, 3, 4, 6]);
    await clock.advance(5000);
    assert.deepEqual(seen, [1, 3, 4, 6], "a forced publish cancels the held one");
    hub.publish("state", { n: 7 });
    assert.deepEqual(seen, [1, 3, 4, 6, 7], "a second later the next one is immediate again");
  });

  test("other topics are never coalesced", () => {
    const hub = createHub();
    const seen = [];
    hub.subscribe("job", (p) => seen.push(p.n));
    for (let n = 0; n < 5; n += 1) hub.publish("job", { n });
    assert.deepEqual(seen, [0, 1, 2, 3, 4]);
  });

  test("no timer without a subscriber; the 2 s ticker arms with the first and clears with the last", async () => {
    const clock = createClock();
    const hub = createHub({ now: clock.now, timers: clock.timers });
    let n = 0;
    hub.setSnapshot("state", () => ({ n: (n += 1) }));
    assert.equal(clock.pending(), 0);
    assert.equal(hub.tickerArmed(), false);

    const seen = [];
    const offA = hub.subscribe("state", (p) => seen.push(p.n));
    const offB = hub.subscribe("state", () => {});
    assert.equal(hub.tickerArmed(), true);
    assert.equal(clock.pending(), 1, "one ticker for any number of subscribers");

    await clock.advance(2000);
    await clock.advance(2000);
    assert.deepEqual(seen, [1, 2], "the snapshot is republished every 2 s");

    offA();
    assert.equal(hub.tickerArmed(), true);
    offB();
    assert.equal(hub.tickerArmed(), false);
    assert.equal(clock.pending(), 0);
    await clock.advance(10000);
    assert.equal(n, 2, "the snapshot is not even computed any more");
  });

  test("publishState publishes the snapshot, and does nothing without a subscriber", async () => {
    const hub = createHub();
    let calls = 0;
    hub.setSnapshot("state", () => ({ n: (calls += 1) }));
    await hub.publishState();
    assert.equal(calls, 0);
    const seen = [];
    hub.subscribe("state", (p) => seen.push(p.n));
    await hub.publishState({ force: true });
    assert.deepEqual(seen, [1]);
  });

  test("stop() clears timers and subscribers", () => {
    const clock = createClock();
    const hub = createHub({ now: clock.now, timers: clock.timers });
    hub.subscribe("state", () => {});
    hub.subscribe("log", () => {});
    hub.stop();
    assert.equal(clock.pending(), 0);
    assert.equal(hub.subscriberCount("state"), 0);
    assert.equal(hub.subscriberCount("log"), 0);
  });
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

describe("jobs registry", () => {
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  test("a job runs after start() returned, moves through its phases and ends done with a result", async () => {
    const clock = createClock(Date.UTC(2026, 0, 1));
    const events = [];
    const hub = createHub({ now: clock.now, timers: clock.timers });
    hub.subscribe("job", (job) => events.push([job.status, job.phase]));
    const jobs = createJobs({ hub, now: clock.now });
    const gate = deferred();

    const started = jobs.start("restart", async (handle) => {
      handle.setPhase("stop");
      await gate.promise;
      handle.setPhase("ready", 100);
      return { ok: true };
    });
    assert.equal(started.status, "running");
    assert.equal(started.phase, null, "the 202 answer shows the job before its first phase");
    assert.deepEqual(Object.keys(started).sort(), ["error", "finishedAt", "id", "phase", "progress", "result", "startedAt", "status", "type"]);
    assert.equal(started.startedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(Number.isInteger(started.id) && started.id > 0, true);

    await settle();
    assert.equal(jobs.get(started.id).phase, "stop");
    await clock.advance(5000);
    gate.resolve();
    await settle();
    const done = jobs.get(started.id);
    assert.equal(done.status, "done");
    assert.equal(done.phase, "ready");
    assert.equal(done.progress, 100);
    assert.deepEqual(done.result, { ok: true });
    assert.equal(done.error, null);
    assert.equal(done.finishedAt, "2026-01-01T00:00:05.000Z");
    assert.deepEqual(events, [["running", null], ["running", "stop"], ["running", "ready"], ["done", "ready"]]);
  });

  test("a failure keeps a typed code, falls back to failureCode, then to internal_error; params are kept", async () => {
    const jobs = createJobs();
    const typed = jobs.start("update.check", async () => {
      const err = new Error("unreachable");
      err.code = "update_check_failed";
      err.params = { reason: "unreachable" };
      throw err;
    });
    const fallback = jobs.start("restore", async () => {
      throw new Error("whatever");
    }, { failureCode: "restore_failed" });
    await settle();
    const untyped = jobs.start("update.check", async () => {
      throw new Error("raw message that must never be exposed");
    });
    await settle();
    assert.deepEqual(jobs.get(typed.id).error, { code: "update_check_failed", params: { reason: "unreachable" } });
    assert.equal(jobs.get(typed.id).status, "failed");
    assert.deepEqual(jobs.get(fallback.id).error, { code: "restore_failed" });
    assert.deepEqual(jobs.get(untyped.id).error, { code: "internal_error" });
    assert.ok(!JSON.stringify(jobs.list()).includes("raw message"));
  });

  test("the heavy types exclude each other (busy), the others do not", async () => {
    const jobs = createJobs();
    const gate = deferred();
    jobs.start("restart", () => gate.promise);
    for (const type of ["restore", "update.apply", "ytdlp.update", "restart"]) {
      assert.throws(() => jobs.start(type, async () => {}), (err) => err.code === "busy", type);
    }
    assert.doesNotThrow(() => jobs.start("update.check", async () => {}), "update.check is not a heavy job");
    assert.equal(jobs.isBusy("restart"), true);
    gate.resolve();
    await settle();
    assert.equal(jobs.isBusy(), false);
    assert.doesNotThrow(() => jobs.start("restore", async () => {}));
  });

  test("a light job does not block, but a heavy one is refused while an exclusive light job runs", async () => {
    const jobs = createJobs();
    const gate = deferred();
    jobs.start("update.check", () => gate.promise, { exclusive: true });
    assert.throws(() => jobs.start("restart", async () => {}), (err) => err.code === "busy");
    gate.resolve();
    await settle();
  });

  test("only the last 20 jobs are kept, for one hour; a running job is never dropped", async () => {
    const clock = createClock(Date.UTC(2026, 0, 1));
    const jobs = createJobs({ now: clock.now });
    const ids = [];
    for (let i = 0; i < MAX_JOBS + 5; i += 1) {
      ids.push(jobs.start("update.check", async () => i).id);
      await settle();
    }
    assert.equal(jobs.list().length, MAX_JOBS);
    assert.equal(jobs.get(ids[0]), null);
    assert.equal(jobs.get(ids[4]), null);
    assert.notEqual(jobs.get(ids[5]), null);
    assert.equal(jobs.list()[0].id, ids[ids.length - 1], "newest first");

    const gate = deferred();
    const running = jobs.start("restart", () => gate.promise);
    await clock.advance(RETENTION_MS + 1000);
    assert.equal(jobs.list().length, 1, "finished jobs expire after an hour");
    assert.equal(jobs.current().id, running.id);
    assert.equal(jobs.get(running.id).status, "running");
    gate.resolve();
    await settle();
    await clock.advance(RETENTION_MS + 1000);
    assert.equal(jobs.get(running.id), null);
  });

  test("ids are positive integers, unique, and an unknown or malformed id is null", async () => {
    const jobs = createJobs();
    const a = jobs.start("update.check", async () => {});
    const b = jobs.start("update.check", async () => {});
    assert.notEqual(a.id, b.id);
    assert.equal(jobs.get("not a number"), null);
    assert.equal(jobs.get(0), null);
    assert.equal(jobs.get(String(a.id)).id, a.id);
    await settle();
  });

  test("no timer is ever created", async () => {
    const created = [];
    const real = global.setInterval;
    global.setInterval = (...args) => {
      created.push(args);
      return real(...args);
    };
    try {
      const jobs = createJobs();
      jobs.start("update.check", async () => {});
      await settle();
      jobs.stop();
    } finally {
      global.setInterval = real;
    }
    assert.deepEqual(created, []);
  });
});

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

/** Parse the complete frames of an SSE text. A frame is { event, data, id, retry, comment }. */
function parseFrames(text) {
  const complete = text.slice(0, text.lastIndexOf("\n\n") + 2);
  return complete
    .split("\n\n")
    .filter((block) => block.length)
    .map((block) => {
      const out = {};
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) {
          out.comment = line.slice(1);
          continue;
        }
        const i = line.indexOf(":");
        out[line.slice(0, i)] = line.slice(i + 1).trimStart();
      }
      if (out.data !== undefined) out.payload = JSON.parse(out.data);
      return out;
    });
}

/** Open an event stream; resolves once the response head is there. */
function openStream(t, target, { headers = {}, name = "good" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: t.port, path: target, headers: { Cookie: `sid=${name}`, ...headers }, agent: false },
      (res) => {
        res.setEncoding("utf8");
        const stream = {
          status: res.statusCode,
          headers: res.headers,
          text: "",
          ended: false,
          frames: () => parseFrames(stream.text),
          events: (name) => parseFrames(stream.text).filter((f) => f.event === name),
          close: () => req.destroy(),
          async waitFor(predicate, timeout = 3000) {
            const ok = await fakes.waitFor(() => predicate(stream), { timeout });
            if (!ok) assert.fail(`timeout; received so far: ${JSON.stringify(stream.text.slice(-400))}`);
          },
        };
        res.on("data", (chunk) => {
          stream.text += chunk;
        });
        res.on("end", () => {
          stream.ended = true;
        });
        res.on("close", () => {
          stream.ended = true;
        });
        res.on("error", () => {
          stream.ended = true;
        });
        resolve(stream);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("event stream (EVT-1)", () => {
  const clock = createClock(Date.UTC(2026, 3, 1));
  const entries = [1, 2, 3, 4, 5].map((seq) => ({ seq, ts: "2026-04-01T00:00:00.000Z", level: "info", name: "t", msg: `line ${seq}` }));
  const ring = {
    list: ({ since }) => entries.filter((e) => e.seq > since),
    subscribe: () => () => {},
  };
  let t;
  const opened = [];

  async function start(options = {}) {
    t = await startStubAdmin({ clock, timers: clock.timers, ring, ...options });
    let state = 0;
    t.admin.hub.setSnapshot("state", () => ({ at: ++state, bot: { status: "open" } }));
    t.admin.hub.setSnapshot("pairing", () => ({ status: "open", registered: true }));
    return t;
  }
  const open = async (target, options) => {
    const stream = await openStream(t, target, options);
    opened.push(stream);
    return stream;
  };

  // every test starts with no stream open: the per-session limit is part of what is tested
  afterEach(async () => {
    for (const stream of opened.splice(0)) stream.close();
    if (t) await fakes.waitFor(() => t.admin.sse.count() === 0, { timeout: 3000 });
  });

  after(async () => {
    for (const stream of opened) stream.close();
    if (t) await t.close();
  });

  test("headers, then retry, a 2 KB comment, and the state and pairing snapshots", async () => {
    await start();
    const stream = await open("/admin/api/events");
    assert.equal(stream.status, 200);
    assert.equal(stream.headers["content-type"], "text/event-stream; charset=utf-8");
    assert.equal(stream.headers["cache-control"], "no-cache, no-transform");
    assert.equal(stream.headers["x-accel-buffering"], "no");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(stream.headers[name.toLowerCase()], value, name);
    for (const name of Object.keys(stream.headers)) assert.ok(!name.startsWith("access-control-"));

    await stream.waitFor((s) => s.events("pairing").length === 1);
    assert.ok(stream.text.startsWith("retry: 3000\n\n"), "retry first");
    const frames = stream.frames();
    assert.equal(frames[0].retry, "3000");
    assert.ok(frames[1].comment.length >= PREAMBLE_COMMENT_BYTES, "a 2 KB comment flushes buffering proxies");
    assert.deepEqual(frames.filter((f) => f.event).map((f) => f.event), ["state", "pairing"]);
    assert.deepEqual(stream.events("state")[0].payload, { at: 1, bot: { status: "open" } });
    assert.deepEqual(stream.events("pairing")[0].payload, { status: "open", registered: true });
    assert.equal(stream.events("state")[0].id, undefined, "only log events carry an id");
  });

  test("live events of the hub are forwarded: state, pairing and job; log only with logs=1", async () => {
    const plain = await open("/admin/api/events");
    const withLogs = await open("/admin/api/events?logs=1");
    await plain.waitFor((s) => s.events("pairing").length === 1);
    await withLogs.waitFor((s) => s.events("pairing").length === 1);
    assert.equal(t.admin.hub.subscriberCount("log"), 1, "only the logs=1 stream follows the log topic");

    const hub = t.admin.hub;
    hub.publish("pairing", { status: "qr", registered: false, qr: { version: 2, issuedAt: "x" } });
    hub.publish("job", { id: 7, type: "restart", status: "running", phase: "stop", progress: null, result: null, error: null });
    hub.publish("log", { seq: 9, ts: "t", level: "error", name: "n", msg: "boom" });
    hub.publish("state", { at: 99 }, { force: true });

    await withLogs.waitFor((s) => s.events("log").length === 1 && s.events("state").length === 2);
    await plain.waitFor((s) => s.events("job").length === 1 && s.events("state").length === 2);
    assert.equal(plain.events("log").length, 0);
    assert.equal(plain.events("pairing")[1].payload.status, "qr");
    assert.equal(plain.events("job")[0].payload.phase, "stop");
    const log = withLogs.events("log")[0];
    assert.equal(log.id, "9", "a log event carries its seq as id");
    assert.deepEqual(log.payload.msg, "boom");
  });

  test("with logs=1 the ring is replayed after ?since=, and Last-Event-ID wins over it", async () => {
    const bySince = await open("/admin/api/events?logs=1&since=3");
    await bySince.waitFor((s) => s.events("log").length === 2);
    assert.deepEqual(bySince.events("log").map((f) => f.payload.seq), [4, 5]);
    assert.deepEqual(bySince.events("log").map((f) => f.id), ["4", "5"]);

    const byHeader = await open("/admin/api/events?logs=1&since=3", { headers: { "Last-Event-ID": "4" } });
    await byHeader.waitFor((s) => s.events("log").length === 1);
    assert.deepEqual(byHeader.events("log").map((f) => f.payload.seq), [5]);

    const nothing = await open("/admin/api/events?logs=1");
    await nothing.waitFor((s) => s.events("pairing").length === 1);
    assert.equal(nothing.events("log").length, 0, "neither Last-Event-ID nor since: no replay");

    const logsOff = await open("/admin/api/events?logs=0&since=1");
    await logsOff.waitFor((s) => s.events("pairing").length === 1);
    assert.equal(logsOff.events("log").length, 0);
  });

  test("a live log entry that arrives during the snapshot and is also in the replay is sent once", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    t.admin.hub.setSnapshot("pairing", () => gate.then(() => ({ status: "open", registered: true })));
    const stream = await open("/admin/api/events?logs=1&since=4");
    await fakes.waitFor(() => t.admin.hub.subscriberCount("log") >= 1);
    // published while the snapshot is still pending: queued, and also returned by ring.list({ since: 4 })
    t.admin.hub.publish("log", { seq: 5, ts: "t", level: "info", name: "t", msg: "line 5" });
    release();
    await stream.waitFor((s) => s.events("pairing").length === 1);
    t.admin.hub.publish("log", { seq: 6, ts: "t", level: "info", name: "t", msg: "line 6" });
    await stream.waitFor((s) => s.events("log").length === 2);
    assert.deepEqual(stream.events("log").map((f) => f.payload.seq), [5, 6]);
    t.admin.hub.setSnapshot("pairing", () => ({ status: "open", registered: true }));
    stream.close();
  });

  test("a heartbeat comment every 15 s, and the state ticker while a client listens", async () => {
    const stream = await open("/admin/api/events");
    await stream.waitFor((s) => s.events("pairing").length === 1);
    const hb = () => stream.frames().filter((f) => f.comment === " hb").length;
    const before = hb();
    await clock.advance(HEARTBEAT_MS);
    await stream.waitFor(() => hb() === before + 1);
    await clock.advance(HEARTBEAT_MS);
    await stream.waitFor(() => hb() === before + 2);
    const states = stream.events("state").length;
    await clock.advance(2000);
    await stream.waitFor((s) => s.events("state").length > states);
  });

  test("the session is re-checked at each heartbeat: a gone session gets the session event, then the stream ends", async () => {
    t.auth.addSession("shortlived");
    const stream = await open("/admin/api/events", { name: "shortlived" });
    await stream.waitFor((s) => s.events("pairing").length === 1);
    t.auth.sessions.delete("shortlived");
    await clock.advance(HEARTBEAT_MS);
    await stream.waitFor((s) => s.events("session").length === 1 && s.ended);
    assert.deepEqual(stream.events("session")[0].payload, { reason: "expired" });
  });

  test("a heartbeat re-check never extends the session (no touch)", async () => {
    t.auth.addSession("quiet");
    const before = t.auth.calls.touch.length;
    const stream = await open("/admin/api/events", { name: "quiet" });
    await stream.waitFor((s) => s.events("pairing").length === 1);
    await clock.advance(HEARTBEAT_MS * 2);
    await stream.waitFor((s) => s.frames().filter((f) => f.comment === " hb").length >= 2);
    assert.equal(t.auth.calls.touch.length, before, "touch:false: the stream and its heartbeats do not extend the idle clock");
    stream.close();
  });

  test("publishing on the session topic closes the streams of that session only", async () => {
    t.auth.addSession("a");
    t.auth.addSession("b");
    const a = await open("/admin/api/events", { name: "a" });
    const b = await open("/admin/api/events", { name: "b" });
    await a.waitFor((s) => s.events("pairing").length === 1);
    await b.waitFor((s) => s.events("pairing").length === 1);
    t.admin.hub.publish("session", { sessionId: "session-a", reason: "logout" });
    await a.waitFor((s) => s.ended);
    assert.deepEqual(a.events("session")[0].payload, { reason: "logout" });
    assert.equal(b.ended, false);
    assert.equal(b.events("session").length, 0);
    b.close();
  });

  test("the guard: no session is 401, a foreign Origin or a cross-site fetch is 403, a bad query is 422", async () => {
    const none = await t.raw({ path: "/admin/api/events" });
    assert.equal(none.status, 401);
    assert.equal((await t.raw({ path: "/admin/api/events", headers: { Cookie: "sid=good", Origin: "https://evil.example" } })).status, 403);
    assert.equal((await t.raw({ path: "/admin/api/events", headers: { Cookie: "sid=good", "Sec-Fetch-Site": "cross-site" } })).status, 403);
    const same = await open("/admin/api/events", { headers: { Origin: t.base, "Sec-Fetch-Site": "same-origin" } });
    assert.equal(same.status, 200);
    same.close();
    const bad = await t.get("/admin/api/events?logs=2");
    assert.equal(bad.status, 422);
    assert.equal((await t.get("/admin/api/events?since=abc")).status, 422);
    assert.equal((await t.get("/admin/api/events?other=1")).status, 422);
  });

  test("5 streams per session and 20 in total: the next one is 429 rate_limited, and closing frees a slot", async () => {
    await t.close();
    t = undefined;
    await start();
    const mine = [];
    for (let i = 0; i < PER_SESSION; i += 1) mine.push(await open("/admin/api/events"));
    await Promise.all(mine.map((s) => s.waitFor((x) => x.events("pairing").length === 1)));
    assert.equal(t.admin.sse.countForSession("session-good"), PER_SESSION);

    const sixth = await t.get("/admin/api/events");
    assert.equal(sixth.status, 429);
    assert.equal(sixth.json.error.code, "rate_limited");

    mine[0].close();
    await fakes.waitFor(() => t.admin.sse.countForSession("session-good") === PER_SESSION - 1);
    const again = await open("/admin/api/events");
    assert.equal(again.status, 200);
    again.close();

    // the total: 20 streams over 4 sessions, then a fifth session is refused
    for (const name of ["s1", "s2", "s3", "s4", "s5"]) t.auth.addSession(name);
    for (const s of mine) s.close();
    await fakes.waitFor(() => t.admin.sse.count() === 0);
    const all = [];
    for (const name of ["s1", "s2", "s3", "s4"]) {
      for (let i = 0; i < PER_SESSION; i += 1) all.push(await open("/admin/api/events", { name }));
    }
    await fakes.waitFor(() => t.admin.sse.count() === TOTAL);
    const overflow = await t.get("/admin/api/events", {}, "s5");
    assert.equal(overflow.status, 429);
    for (const s of all) s.close();
    await fakes.waitFor(() => t.admin.sse.count() === 0);
  });

  test("a client that does not read is dropped once 1 MiB is queued for it", async () => {
    await t.close();
    t = undefined;
    await start();
    const socket = net.connect(t.port, "127.0.0.1");
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(`GET /admin/api/events HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: sid=good\r\nConnection: keep-alive\r\n\r\n`);
    await fakes.waitFor(() => t.admin.sse.count() === 1);
    socket.pause(); // never read again

    const big = "x".repeat(64 * 1024);
    let dropped = false;
    for (let i = 0; i < 400 && !dropped; i += 1) {
      t.admin.hub.publish("job", { id: i, type: "restart", status: "running", phase: big, progress: null, result: null, error: null });
      dropped = t.admin.sse.count() === 0;
      if (i % 20 === 19) await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(dropped, true, "the slow client was dropped");
    assert.equal(MAX_BUFFERED_BYTES, 1024 * 1024);
    socket.destroy();
  });

  test("no timer remains once the last stream is closed, and admin.stop() ends every stream", async () => {
    await t.close();
    t = undefined;
    await start();
    assert.equal(clock.pending(), 0, "nothing is armed without a subscriber");
    const a = await open("/admin/api/events");
    const b = await open("/admin/api/events");
    await a.waitFor((s) => s.events("pairing").length === 1);
    await b.waitFor((s) => s.events("pairing").length === 1);
    assert.equal(clock.pending(), 3, "one heartbeat per stream and the shared state ticker");
    a.close();
    await fakes.waitFor(() => t.admin.sse.count() === 1);
    assert.equal(clock.pending(), 2);
    await t.admin.stop();
    await b.waitFor((s) => s.ended);
    assert.equal(clock.pending(), 0);
    assert.equal(t.admin.sse.count(), 0);
  });

  test("frame() serialises on a single data line", () => {
    assert.equal(frame("state", { a: "x\ny" }), 'event: state\ndata: {"a":"x\\ny"}\n\n');
    assert.equal(frame("log", { seq: 3 }, 3), 'id: 3\nevent: log\ndata: {"seq":3}\n\n');
  });
});

// ---------------------------------------------------------------------------
// JOB-1
// ---------------------------------------------------------------------------

describe("JOB-1", () => {
  test("GET /admin/api/jobs/:id answers { job }, 404 for an unknown or expired id, and works with the database down", async () => {
    const clock = createClock(Date.UTC(2026, 0, 1));
    const t = await startStubAdmin({ clock, runtime: { dbReady: false } });
    try {
      const started = t.admin.jobs.start("update.check", async () => ({ behind: 0 }));
      await new Promise((resolve) => setImmediate(resolve));
      const res = await t.get(`/admin/api/jobs/${started.id}`);
      assert.equal(res.status, 200);
      assert.equal(res.json.job.status, "done");
      assert.deepEqual(res.json.job.result, { behind: 0 });
      assert.equal(res.json.job.id, started.id);

      const missing = await t.get(`/admin/api/jobs/${started.id + 1000}`);
      assert.equal(missing.status, 404);
      assert.equal(missing.json.error.code, "not_found");
      assert.equal((await t.get("/admin/api/jobs/abc")).status, 404);

      const before = t.auth.calls.touch.length;
      await t.get(`/admin/api/jobs/${started.id}`);
      assert.equal(t.auth.calls.touch.length, before, "touch:false");

      await clock.advance(RETENTION_MS + 1000);
      assert.equal((await t.get(`/admin/api/jobs/${started.id}`)).status, 404, "expired");
    } finally {
      await t.close();
    }
  });
});
