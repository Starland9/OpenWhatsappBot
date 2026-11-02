"use strict";
/**
 * SC-009 (T217): the admin panel adds under 50 MB to the bot at rest.
 *
 *  - one child process per mode (tools/panel-memory-child.js, --expose-gc, in-memory database, blank secrets): the
 *    panel child creates the admin, logs in, fetches every page and read-only route once and keeps one SSE stream
 *    open; heapUsed + external of the panel child exceeds the baseline's by less than 25 MB (the RSS figure, under
 *    50 MB, is the business of tools/measure-panel-memory.js and the opt-in test/panel-memory.test.js);
 *  - the structural caps behind that figure, checked on the real admin: the 1000-entry log ring and its replay,
 *    10 sessions, the SSE limits, the bounded maps (login limiter, jobs, audit page), no ticker without a stream;
 *  - no timer is left running: every timer the admin creates is unref()'d while it runs, none survives stop(), and
 *    requiring the admin modules starts none;
 *  - SC-011 (feature 004, the messaging API): the child also runs in `api-off` (the API built and wired as boot.js does,
 *    switch off) and `api-on` (switch on and idle); heapUsed + external of `api-on` exceeds `api-off` by less than
 *    20 MiB and `api-off` stays within the panel's budget (the RSS figures are the business of
 *    tools/measure-panel-memory.js and the opt-in test/panel-memory.test.js); requiring the admin, the API and the
 *    messaging modules leaves `urlFetch`, `file-type`, `sharp`, `node-webpmux`, `stickerMaker` and the button helper
 *    unloaded (RT-04) and starts no timer (RT-02).
 *
 * Offline: no network, an in-memory database, a temporary data directory; config.env is never read.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createTestAdmin } = require("./helpers/adminHarness");
const { openEventStream } = require("./helpers/sseTap");
const ring = require("../lib/admin/logs/ring");
const { createLimiter, MAX_ENTRIES } = require("../lib/admin/auth/rateLimit");
const { MAX_SESSIONS } = require("../lib/admin/auth/sessions");
const { MAX_JOBS } = require("../lib/admin/jobs");
const { PER_SESSION, TOTAL, MAX_BUFFERED_BYTES } = require("../lib/admin/http/sse");
const { runChild } = require("../tools/measure-panel-memory");

const MB = 1024 * 1024;
const PASSWORD = "a long enough password";

// ---------------------------------------------------------------------------
// The measure (two child processes)
// ---------------------------------------------------------------------------

describe("SC-009: heap plus external memory added by the panel", () => {
  test("a panel child that logged in, fetched every page and route and holds an SSE stream stays within 25 MB of the baseline", async (t) => {
    const [baseline, panel] = await Promise.all([runChild("baseline", { idleMs: 1000 }), runChild("panel", { idleMs: 1000 })]);

    assert.equal(baseline.mode, "baseline");
    assert.equal(panel.mode, "panel");
    assert.deepEqual(panel.failed, [], "no page and no read-only route may answer 5xx (or 404 for a page)");
    assert.ok(panel.routes >= 20, `${panel.routes} read-only routes fetched`);
    assert.ok(panel.fetched >= panel.routes + 20, `${panel.fetched} requests in all (pages included)`);
    assert.equal(baseline.routes, 0, "the baseline has no admin");

    const delta = panel.heapUsed + panel.external - (baseline.heapUsed + baseline.external);
    t.diagnostic(
      `baseline heap+external ${((baseline.heapUsed + baseline.external) / MB).toFixed(1)} MB, panel ${((panel.heapUsed + panel.external) / MB).toFixed(1)} MB, delta ${(delta / MB).toFixed(1)} MB (RSS delta ${((panel.rss - baseline.rss) / MB).toFixed(1)} MB)`,
    );
    assert.ok(delta < 25 * MB, `heapUsed + external grew by ${(delta / MB).toFixed(1)} MB`);
  });
});

// ---------------------------------------------------------------------------
// SC-011: the messaging API (feature 004)
// ---------------------------------------------------------------------------

describe("SC-011: the memory the messaging API adds", () => {
  test("the child runs in four modes: baseline, panel, api-off and api-on", () => {
    const { MODES } = require("../tools/panel-memory-child");
    assert.deepEqual(MODES, ["baseline", "panel", "api-off", "api-on"]);
  });

  test("switched off the API stays within the panel's budget and answers like an unknown URL; switched on and idle it adds under 20 MiB", async (t) => {
    const [baseline, off] = await Promise.all([runChild("baseline", { idleMs: 1000 }), runChild("api-off", { idleMs: 1000 })]);
    const on = await runChild("api-on", { idleMs: 1000 });

    assert.equal(off.mode, "api-off");
    assert.equal(on.mode, "api-on");
    for (const sample of [off, on]) {
      assert.deepEqual(sample.failed, [], `${sample.mode}: no page and no read-only route may answer 5xx`);
      assert.ok(sample.routes >= 30, `${sample.mode}: ${sample.routes} read-only routes fetched (the thirteen of the API page included)`);
    }

    // the switch really took effect in each child (a measure of an API that never started would prove nothing)
    assert.ok(off.api && on.api, "the api modes report the state they measured");
    assert.equal(off.api.enabled, false);
    assert.equal(off.api.probe.status, 200, "off: any /api/v1 path is the answer of an unknown URL");
    assert.equal(off.api.probe.json, false, "off: no JSON, no hint that an API exists");
    assert.equal(on.api.enabled, true);
    assert.equal(on.api.probe.status, 401, "on: a call without a key is refused by the API itself");
    assert.equal(on.api.probe.code, "unauthenticated");
    assert.equal(baseline.api, null);

    const heap = (sample) => sample.heapUsed + sample.external;
    const offDelta = heap(off) - heap(baseline);
    const onDelta = heap(on) - heap(off);
    t.diagnostic(
      `heap+external: baseline ${(heap(baseline) / MB).toFixed(1)} MB, api-off ${(heap(off) / MB).toFixed(1)} MB (+${(offDelta / MB).toFixed(1)}), api-on ${(heap(on) / MB).toFixed(1)} MB (+${(onDelta / MB).toFixed(1)} over api-off); RSS api-off ${(off.rss / MB).toFixed(1)} MB, api-on ${(on.rss / MB).toFixed(1)} MB`,
    );
    assert.ok(offDelta < 25 * MB, `the panel with the API switched off grew heapUsed + external by ${(offDelta / MB).toFixed(1)} MB over the baseline`);
    assert.ok(onDelta < 20 * MB, `switching the API on grew heapUsed + external by ${(onDelta / MB).toFixed(1)} MB`);
  });
});

// ---------------------------------------------------------------------------
// Structural caps, on the real admin
// ---------------------------------------------------------------------------

describe("the caps behind the figure", () => {
  let t;
  let client;

  /** A new session (the cap of 10 evicts the oldest ones, the first client's included) */
  async function freshClient() {
    const fresh = t.client();
    assert.equal((await fresh.login(PASSWORD)).status, 200);
    return fresh;
  }

  before(async () => {
    ring.clear();
    t = await createTestAdmin({ deps: { ring } });
    await t.admin.start();
    client = await t.loginClient(PASSWORD);
  });

  after(async () => {
    await t.close();
    ring.clear();
  });

  test("the log ring keeps 1000 entries, 2000 characters each, and the stream replays no more than 1000", async () => {
    for (let i = 1; i <= 1500; i += 1) ring.push({ level: "info", name: "memory", msg: i === 1500 ? "x".repeat(5000) : `entry ${i}` });
    const kept = ring.list({ limit: 100000 });
    assert.equal(kept.length, 1000);
    assert.equal(kept[kept.length - 1].seq - kept[0].seq, 999, "consecutive: the 500 oldest were overwritten");
    assert.ok(kept.every((entry) => entry.msg.length <= 2000), "a message is capped");

    const reader = await freshClient();
    const stream = await openEventStream({ port: t.port, client: reader, target: "/admin/api/events?logs=1&since=0", headers: { Origin: t.base } });
    try {
      assert.equal(stream.status, 200);
      await stream.waitFor((s) => s.events("log").length >= 1000, 5000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(stream.events("log").length, 1000);
    } finally {
      stream.close();
    }
  });

  test("at most 10 sessions are kept: the oldest go first", async () => {
    assert.equal(MAX_SESSIONS, 10);
    for (let i = 0; i < 12; i += 1) {
      const answer = await t.client().login(PASSWORD);
      assert.equal(answer.status, 200, `login ${i}`);
    }
    assert.ok((await t.db.AdminSession.count()) <= MAX_SESSIONS);
  });

  test("SSE: 5 streams per session and 20 in all, a slow client is dropped past 1 MiB, closing frees the ticker", async () => {
    assert.equal(PER_SESSION, 5);
    assert.equal(TOTAL, 20);
    assert.equal(MAX_BUFFERED_BYTES, 1024 * 1024);
    assert.equal(t.hub.tickerArmed(), false, "no 2 s ticker while nobody listens");

    const reader = await freshClient();
    const mine = [];
    for (let i = 0; i < PER_SESSION; i += 1) mine.push(await openEventStream({ port: t.port, client: reader, headers: { Origin: t.base } }));
    assert.deepEqual(mine.map((s) => s.status), Array(PER_SESSION).fill(200));
    assert.equal(t.hub.tickerArmed(), true);

    const sixth = await openEventStream({ port: t.port, client: reader, headers: { Origin: t.base } });
    assert.equal(sixth.status, 429);
    assert.equal(t.admin.sse.count(), PER_SESSION);

    for (const stream of mine) stream.close();
    assert.ok(await fakes.waitFor(() => t.admin.sse.count() === 0, { timeout: 3000 }), "every stream was torn down");
    assert.equal(t.hub.tickerArmed(), false, "the ticker stops with the last stream");
    assert.equal(t.hub.subscriberCount("state"), 0);
  });

  test("bounded maps: the login limiter (10000 entries), the jobs (20) and the audit page (200)", async () => {
    assert.equal(MAX_ENTRIES, 10000);
    const limiter = createLimiter({ maxEntries: 50 });
    for (let i = 0; i < 500; i += 1) limiter.fail(`origin-${i}`);
    assert.ok(limiter.size() <= 50, `${limiter.size()} entries`);

    for (let i = 0; i < 40; i += 1) t.admin.jobs.start("memory.test", async () => i, { exclusive: false });
    await fakes.waitFor(() => t.admin.jobs.list().every((job) => job.status !== "running"), { timeout: 3000 });
    assert.ok(t.admin.jobs.list().length <= MAX_JOBS, `${t.admin.jobs.list().length} jobs kept`);

    const page = await (await freshClient()).get("/admin/api/audit?pageSize=100000");
    if (page.status === 200) assert.ok(page.json.items.length <= 200, `${page.json.items.length} audit rows in one page`);
    else assert.equal(page.status, 422, "or the oversized page is refused");
  });
});

// ---------------------------------------------------------------------------
// No timer is left running
// ---------------------------------------------------------------------------

describe("no timer is left running", () => {
  test("requiring the admin modules and the engines starts no timer and opens no handle", () => {
    const script = [
      "const fs = require('fs'), path = require('path');",
      "const load = (dir) => { for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) require(path.resolve(dir, f)); };",
      "require('./lib/admin'); require('./lib/admin/server');",
      "load('./lib/admin/routes'); load('./lib/admin/services');",
      "for (const name of ['alerts', 'broadcaster', 'housekeeping', 'updater', 'stats', 'textOverrides', 'commandState', 'ytdlpUpdate', 'scheduler', 'events']) require('./lib/utils/' + name);",
      "process.stdout.write(JSON.stringify(process.getActiveResourcesInfo()));",
    ].join("\n");
    const output = execFileSync(process.execPath, ["-e", script], {
      cwd: fakes.ROOT,
      env: { PATH: process.env.PATH, OWB_NO_CONFIG_ENV: "1", DATABASE_URL: ":memory:", LOG_LEVEL: "silent" },
      encoding: "utf8",
      timeout: 60 * 1000,
    });
    // the two pipes are this child's own stdout and stderr
    assert.deepEqual(JSON.parse(output).filter((name) => !["PipeWrap", "TTYWrap"].includes(name)), []);
  });

  test("requiring the admin, the API and the messaging modules leaves the heavy modules unloaded and starts no timer (RT-02, RT-04)", () => {
    const script = [
      "const fs = require('fs'), path = require('path');",
      "const load = (dir) => { for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) require(path.resolve(dir, f)); };",
      "require('./lib/admin'); require('./lib/admin/server');",
      "load('./lib/admin/routes'); load('./lib/admin/services');",
      "require('./lib/api'); require('./lib/messaging'); require('./lib/utils/apiState'); require('./lib/utils/sendGate'); require('./lib/messaging/replies'); require('./plugins/apireplies');",
      "for (const name of ['alerts', 'broadcaster', 'housekeeping', 'updater', 'stats', 'textOverrides', 'commandState', 'ytdlpUpdate', 'scheduler', 'events']) require('./lib/utils/' + name);",
      // the registries and the API object are built, the way createAdmin builds them (no network, no database, no timer)
      "require('./lib/messaging/formats').load();",
      "require('./lib/api').createApi({});",
      "const heavy = /lib[\\\\/]messaging[\\\\/]urlFetch|node_modules[\\\\/](?:file-type|sharp|node-webpmux|fluent-ffmpeg|@ryuu-reinzz)|lib[\\\\/]utils[\\\\/]stickerMaker|plugins[\\\\/]buttons/;",
      "const loaded = () => Object.keys(require.cache).filter((key) => heavy.test(key)).map((key) => path.relative(process.cwd(), key));",
      "const before = loaded(); const active = process.getActiveResourcesInfo();",
      // the control: the pattern does find those modules once they are required, so an empty list above means something
      "require('./lib/messaging/urlFetch'); require('./lib/utils/stickerMaker');",
      "process.stdout.write(JSON.stringify({ before, active, after: loaded() }));",
    ].join("\n");
    const output = execFileSync(process.execPath, ["-e", script], {
      cwd: fakes.ROOT,
      env: { PATH: process.env.PATH, OWB_NO_CONFIG_ENV: "1", DATABASE_URL: ":memory:", LOG_LEVEL: "silent" },
      encoding: "utf8",
      timeout: 60 * 1000,
    });
    const report = JSON.parse(output);
    assert.deepEqual(report.before, [], "urlFetch, file-type, sharp, node-webpmux, ffmpeg wrappers, stickerMaker and the button helper stay unloaded");
    assert.deepEqual(report.active.filter((name) => !["PipeWrap", "TTYWrap"].includes(name)), [], "no timer, handle or socket");
    assert.ok(report.after.some((file) => /urlFetch/.test(file)) && report.after.some((file) => /stickerMaker/.test(file)), "the pattern finds the modules when they are loaded (the check is not vacuous)");
  });

  test("every timer the admin creates is unref()'d while it runs, and every interval is cleared by stop()", async () => {
    const recorded = [];
    const real = { setInterval: global.setInterval, setTimeout: global.setTimeout };
    const wrap = (name, repeat) =>
      function recordingTimer(...args) {
        const timer = real[name].apply(this, args);
        const stack = new Error().stack || "";
        if (/[\\/]lib[\\/]admin[\\/]/.test(stack)) recorded.push({ timer, repeat, stack: stack.split("\n").slice(2, 4).join(" | ") });
        return timer;
      };
    global.setInterval = wrap("setInterval", true);
    global.setTimeout = wrap("setTimeout", false);

    let t;
    try {
      // real timers (the harness would otherwise hand the admin a fake clock's timers)
      t = await createTestAdmin({ deps: { timers: undefined, ring } });
      await t.admin.start();
      const client = await t.loginClient(PASSWORD);
      const stream = await openEventStream({ port: t.port, client, target: "/admin/api/events?logs=1", headers: { Origin: t.base } });
      for (const route of ["/admin/api/state", "/admin/api/settings", "/admin/api/commands", "/admin/api/stats"]) await client.get(route);
      t.admin.jobs.start("memory.test", async () => 1, { exclusive: false });
      await fakes.waitFor(() => stream.events("state").length >= 1, { timeout: 3000 });

      assert.ok(recorded.some((entry) => entry.repeat), "the stream armed at least one interval (the hub ticker and the heartbeat)");
      const alive = recorded.filter(({ timer }) => !timer._destroyed);
      assert.ok(alive.length >= 2, `${alive.length} live timers were observed (the check is not vacuous)`);
      for (const { timer, stack } of alive) assert.equal(timer.hasRef(), false, `a ref'd timer was left by ${stack}`);

      stream.close();
      await fakes.waitFor(() => t.admin.sse.count() === 0, { timeout: 3000 });
      await t.close();

      for (const { timer, repeat, stack } of recorded) {
        if (repeat) assert.equal(timer._destroyed, true, `an interval survived stop(): ${stack}`);
        else assert.ok(timer._destroyed || !timer.hasRef(), `a ref'd timeout survived stop(): ${stack}`);
      }
    } finally {
      global.setInterval = real.setInterval;
      global.setTimeout = real.setTimeout;
      if (t && t.server.listening) await t.close().catch(() => {});
    }
  });
});
