"use strict";
/**
 * LOG-1 `GET /admin/api/logs` (US7, FR-034): the 1000-entry ring through the panel. `level` is a minimum, `q` a
 * case-insensitive substring, `since` a sequence number, `limit` 1 to 1000; values are scrubbed (also those of a
 * secret registered after the entry was logged) and QR output is never present. The route does not extend the
 * session (touch:false) and answers without the database (db:r). New entries reach an SSE client opened with
 * `logs=1`, and are replayed after `Last-Event-ID` (SC-004 slice: a seeded API key never appears).
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createTestAdmin } = require("./helpers/adminHarness");
const { createFakeRuntime } = require("./helpers/fakeBotRuntime");
const { openEventStream } = require("./helpers/sseTap");
const ring = require("../lib/admin/logs/ring");
const redactor = require("../lib/admin/logs/redactor");
const logger = require("../lib/utils/logger");
const { safeLog } = require("../lib/utils/http");

const HOUR = 60 * 60 * 1000;
const KEY = "sk-live-9f8e7d6c5b4a39281706";

let t;
let client;
let rt;
const streams = [];

async function boot() {
  ring.clear();
  rt = createFakeRuntime();
  t = await createTestAdmin({ deps: { runtime: rt, ring, dbProbe: async () => true } });
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
  redactor.unregister("test:key");
  redactor.unregister("setting:OPENAI_API_KEY");
});

const logs = async (query = "") => client.get(`/admin/api/logs${query ? `?${query}` : ""}`);
const msgs = (res) => res.json.entries.map((e) => e.msg);

/** `n` entries "line 1".."line n", every third an error, every fifth a warning. */
function seed(n) {
  for (let i = 1; i <= n; i += 1) {
    const level = i % 3 === 0 ? "error" : i % 5 === 0 ? "warn" : "info";
    ring.push({ level, name: i % 2 ? "alpha" : "beta", msg: `line ${i}` });
  }
}

const openStream = async (target, headers) => {
  const stream = await openEventStream({ port: t.port, client, target, headers });
  streams.push(stream);
  return stream;
};

describe("LOG-1", () => {
  beforeEach(boot);

  test("session-authenticated, touch:false, db:r, GET only", async () => {
    const route = t.admin.routes().find((r) => r.path === "/admin/api/logs");
    assert.deepEqual({ method: route.method, auth: route.auth, touch: route.touch, db: route.db, mutates: route.mutates }, { method: "GET", auth: "session", touch: false, db: "optional", mutates: false });
    const anonymous = await t.client().get("/admin/api/logs");
    assert.equal(anonymous.status, 401);
  });

  test("the answer is { entries, lastSeq }; an entry is { seq, ts, level, name, msg }, oldest first", async () => {
    seed(6);
    const res = await logs();
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ["entries", "lastSeq"]);
    assert.deepEqual(msgs(res), ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"]);
    assert.deepEqual(Object.keys(res.json.entries[0]), ["seq", "ts", "level", "name", "msg"]);
    assert.ok(res.json.entries.every((e, i, all) => i === 0 || e.seq > all[i - 1].seq));
    assert.equal(res.json.lastSeq, ring.lastSeq());
    assert.equal(res.json.lastSeq, res.json.entries[5].seq);
    assert.match(res.json.entries[0].ts, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  });

  test("an empty ring answers an empty list and the current sequence", async () => {
    const res = await logs();
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.entries, []);
    assert.equal(res.json.lastSeq, ring.lastSeq());
  });

  test("level is a minimum: error returns error and fatal, warn adds warnings, trace everything", async () => {
    ring.push({ level: "trace", name: "x", msg: "t" });
    ring.push({ level: "debug", name: "x", msg: "d" });
    ring.push({ level: "info", name: "x", msg: "i" });
    ring.push({ level: "warn", name: "x", msg: "w" });
    ring.push({ level: "error", name: "x", msg: "e" });
    ring.push({ level: "fatal", name: "x", msg: "f" });
    assert.deepEqual(msgs(await logs("level=error")), ["e", "f"]);
    assert.deepEqual(msgs(await logs("level=fatal")), ["f"]);
    assert.deepEqual(msgs(await logs("level=warn")), ["w", "e", "f"]);
    assert.deepEqual(msgs(await logs("level=info")), ["i", "w", "e", "f"]);
    assert.deepEqual(msgs(await logs("level=trace")), ["t", "d", "i", "w", "e", "f"]);
    assert.deepEqual(msgs(await logs()), ["t", "d", "i", "w", "e", "f"], "no level: everything");
  });

  test("q is a case-insensitive substring of the message or the module name", async () => {
    ring.push({ level: "info", name: "Downloader", msg: "Fetching the thing" });
    ring.push({ level: "error", name: "cmd", msg: "BOOM in the thing" });
    ring.push({ level: "info", name: "cmd", msg: "nothing" });
    assert.deepEqual(msgs(await logs("q=boom")), ["BOOM in the thing"]);
    assert.deepEqual(msgs(await logs("q=THE%20THING")), ["Fetching the thing", "BOOM in the thing"]);
    assert.deepEqual(msgs(await logs("q=downloader")), ["Fetching the thing"]);
    assert.deepEqual(msgs(await logs("q=boom&level=info")), ["BOOM in the thing"]);
    assert.deepEqual(msgs(await logs("q=boom&level=fatal")), []);
    assert.deepEqual(msgs(await logs("q=zzz")), []);
  });

  test("a text filter is not interpreted: percent signs, quotes, regex characters are plain text", async () => {
    ring.push({ level: "info", name: "x", msg: "100% done (ok) [1] .* 'quoted'" });
    ring.push({ level: "info", name: "x", msg: "other" });
    for (const q of ["100%25", "(ok)", "%5B1%5D", ".*", "'quoted'"]) assert.equal((await logs(`q=${q}`)).json.entries.length, 1, q);
  });

  test("q is at most 100 characters", async () => {
    const ok = await logs(`q=${"a".repeat(100)}`);
    assert.equal(ok.status, 200);
    const long = await logs(`q=${"a".repeat(101)}`);
    assert.equal(long.status, 422);
    assert.deepEqual(long.json.error.fields.q, { code: "too_long", params: { max: 100 } });
  });

  test("since returns the entries after that sequence; lastSeq is the newest examined", async () => {
    seed(6);
    const all = (await logs()).json.entries;
    const res = await logs(`since=${all[2].seq}`);
    assert.deepEqual(msgs(res), ["line 4", "line 5", "line 6"]);
    assert.equal(res.json.lastSeq, all[5].seq);
    const none = await logs(`since=${all[5].seq}`);
    assert.deepEqual(none.json.entries, []);
    assert.equal(none.json.lastSeq, all[5].seq, "nothing new: the cursor stays where it is");
    // a filter that matches nothing still moves the cursor to the newest entry, so the next poll starts after it
    const filtered = await logs(`since=${all[0].seq}&level=fatal`);
    assert.deepEqual(filtered.json.entries, []);
    assert.equal(filtered.json.lastSeq, all[5].seq);
  });

  test("limit: the newest entries, or the first ones after `since` (a polling client must not skip a gap)", async () => {
    seed(10);
    const all = (await logs()).json.entries;
    const newest = await logs("limit=3");
    assert.deepEqual(msgs(newest), ["line 8", "line 9", "line 10"]);
    assert.equal(newest.json.lastSeq, all[9].seq);
    const gap = await logs(`since=${all[1].seq}&limit=3`);
    assert.deepEqual(msgs(gap), ["line 3", "line 4", "line 5"]);
    assert.equal(gap.json.lastSeq, all[4].seq, "truncated: the cursor is the last entry returned, not the newest");
    const rest = await logs(`since=${gap.json.lastSeq}&limit=100`);
    assert.deepEqual(msgs(rest), ["line 6", "line 7", "line 8", "line 9", "line 10"]);
  });

  test("limit defaults to 200, accepts 1 to 1000, and refuses the rest", async () => {
    for (let i = 1; i <= 250; i += 1) ring.push({ level: "info", name: "n", msg: `m${i}` });
    const dflt = await logs();
    assert.equal(dflt.json.entries.length, 200);
    assert.equal(dflt.json.entries[199].msg, "m250", "the 200 newest");
    assert.equal((await logs("limit=1")).json.entries.length, 1);
    assert.equal((await logs("limit=1000")).json.entries.length, 250);
    for (const bad of ["0", "1001", "99999"]) {
      const res = await logs(`limit=${bad}`);
      assert.equal(res.status, 422, bad);
      assert.deepEqual(res.json.error.fields.limit, { code: "out_of_range", params: { min: 1, max: 1000 } }, bad);
    }
    for (const bad of ["abc", "-1", "1.5", "1e3", ""]) {
      const res = await logs(`limit=${bad}`);
      if (bad === "") assert.equal(res.status, 422, "an empty limit is not a number");
      else {
        assert.equal(res.status, 422, bad);
        assert.equal(res.json.error.fields.limit.code, "invalid_format", bad);
      }
    }
  });

  test("the ring never holds more than 1000 entries, and 1000 is what limit=1000 returns", async () => {
    for (let i = 1; i <= 1100; i += 1) ring.push({ level: "info", name: "n", msg: `m${i}` });
    const res = await logs("limit=1000");
    assert.equal(res.json.entries.length, 1000);
    assert.equal(res.json.entries[0].msg, "m101");
  });

  test("unknown level, unknown parameter and malformed since are validation errors; nothing is echoed", async () => {
    const level = await logs("level=loud");
    assert.equal(level.status, 422);
    assert.equal(level.json.error.fields.level.code, "not_allowed");
    assert.ok(!level.text.includes("loud"));
    const unknown = await logs("secret=abc");
    assert.equal(unknown.status, 422);
    assert.deepEqual(unknown.json.error.fields.$unknown, { code: "unknown_field" });
    assert.ok(!unknown.text.includes("abc"));
    assert.equal((await logs("since=abc")).status, 422);
    assert.equal((await logs("since=-1")).status, 422);
  });

  test("a repeated parameter counts once (the first value wins)", async () => {
    seed(4);
    assert.equal((await logs("limit=1&limit=3")).json.entries.length, 1);
  });

  test("values are scrubbed: a secret known when the entry was logged, and one registered afterwards", async () => {
    redactor.register("test:key", KEY);
    ring.push({ level: "error", name: "openai", msg: `call failed: Authorization: Bearer ${KEY}` });
    ring.push({ level: "error", name: "openai", msg: "second failure with sk-after-registered-0123456" });
    redactor.register("setting:OPENAI_API_KEY", "sk-after-registered-0123456");
    const res = await logs();
    assert.ok(!res.text.includes(KEY));
    assert.ok(!res.text.includes("sk-after-registered-0123456"), "scrubbed again when read");
    assert.equal(res.json.entries.length, 2);
    assert.ok(res.json.entries.every((e) => e.msg.includes("[redacted]")));
  });

  test("SC-004: a key logged through a failing service call (real logger) never appears, in any encoding", async () => {
    redactor.register("setting:OPENAI_API_KEY", KEY);
    const previousLevel = logger.getLevel();
    logger.setOutput(() => {});
    logger.setLevel("error");
    try {
      const log = logger.createLogger("openai");
      const failure = new Error(`Request failed with status code 401 (key ${KEY})`);
      failure.config = { headers: { Authorization: `Bearer ${KEY}` }, params: { key: KEY } };
      failure.response = { status: 401 };
      log.error({ err: safeLog(failure) }, `openai request failed for ${KEY}`);
      log.error(`url https://api.example/v1?key=${encodeURIComponent(KEY)} and b64 ${Buffer.from(KEY).toString("base64")}`);
    } finally {
      logger.setLevel(previousLevel);
      logger.setOutput();
    }
    const res = await logs("level=error");
    assert.equal(res.status, 200);
    assert.ok(res.json.entries.length >= 2, "the failures are there");
    for (const form of [KEY, encodeURIComponent(KEY), Buffer.from(KEY).toString("base64"), Buffer.from(KEY).toString("base64url")]) {
      assert.ok(!res.text.includes(form), `no ${form.slice(0, 8)}… form`);
    }
  });

  test("QR output is never present, whatever the filter", async () => {
    ring.push({ level: "info", name: "console", msg: "QR available" });
    ring.push({ level: "info", name: "console", msg: "████████▀▀▀▀▄▄▄▄████████" });
    ring.push({ level: "info", name: "client", msg: "connection update: qr" });
    const res = await logs();
    assert.deepEqual(msgs(res), ["connection update: qr"]);
    assert.deepEqual(msgs(await logs("q=qr")), ["connection update: qr"]);
    assert.deepEqual(msgs(await logs("q=available")), []);
  });

  test("it does not extend the session, and it answers while the database is not ready", async () => {
    seed(2);
    await t.clock.advance(23 * HOUR);
    assert.equal((await logs()).status, 200);
    rt.dbReady = false;
    assert.equal((await logs()).status, 200, "db:r");
    await t.clock.advance(59 * 60 * 1000);
    assert.equal((await logs()).status, 200, "still alive at 23 h 59 min");
    await t.clock.advance(60 * 1000 + 1);
    const late = await logs();
    assert.equal(late.status, 401);
    assert.equal(late.json.error.code, "session_expired", "the polls did not extend the idle clock");
  });
});

describe("log entries on the live stream (EVT-1, logs=1)", () => {
  beforeEach(boot);

  test("without logs=1 the stream carries no log event", async () => {
    const stream = await openStream("/admin/api/events");
    await stream.waitFor((s) => s.events("state").length >= 1);
    ring.push({ level: "error", name: "x", msg: "not for this client" });
    await t.clock.advance(2000);
    await stream.waitFor((s) => s.events("state").length >= 2);
    assert.equal(stream.events("log").length, 0);
  });

  test("with logs=1 new entries arrive as `log` events whose id is the sequence", async () => {
    const stream = await openStream("/admin/api/events?logs=1");
    await stream.waitFor((s) => s.events("state").length >= 1);
    const one = ring.push({ level: "error", name: "cmd", msg: "first live line" });
    const two = ring.push({ level: "info", name: "cmd", msg: "second live line" });
    await stream.waitFor((s) => s.events("log").length >= 2);
    const [a, b] = stream.events("log");
    assert.equal(a.id, String(one.seq));
    assert.deepEqual(a.payload, one);
    assert.equal(b.id, String(two.seq));
    assert.equal(b.payload.msg, "second live line");
  });

  test("with since, the entries after it are replayed first; Last-Event-ID wins over since", async () => {
    seed(5);
    const all = (await logs()).json.entries;
    const bySince = await openStream(`/admin/api/events?logs=1&since=${all[2].seq}`);
    await bySince.waitFor((s) => s.events("log").length >= 2);
    assert.deepEqual(bySince.events("log").map((f) => f.payload.msg), ["line 4", "line 5"]);

    const byHeader = await openStream(`/admin/api/events?logs=1&since=${all[0].seq}`, { "Last-Event-ID": String(all[3].seq) });
    await byHeader.waitFor((s) => s.events("log").length >= 1);
    assert.deepEqual(byHeader.events("log").map((f) => f.payload.msg), ["line 5"], "the header, as an automatic reconnect sends it");

    const fresh = await openStream("/admin/api/events?logs=1");
    await fresh.waitFor((s) => s.events("state").length >= 1);
    assert.equal(fresh.events("log").length, 0, "neither header nor since: no replay");
  });

  test("a reconnect after Last-Event-ID misses nothing and repeats nothing", async () => {
    const stream = await openStream("/admin/api/events?logs=1");
    await stream.waitFor((s) => s.events("state").length >= 1);
    ring.push({ level: "info", name: "x", msg: "before the drop" });
    await stream.waitFor((s) => s.events("log").length >= 1);
    const last = stream.events("log").pop().id;
    stream.close();
    ring.push({ level: "info", name: "x", msg: "while disconnected" });
    const again = await openStream("/admin/api/events?logs=1", { "Last-Event-ID": last });
    ring.push({ level: "info", name: "x", msg: "after the return" });
    await again.waitFor((s) => s.events("log").length >= 2);
    assert.deepEqual(again.events("log").map((f) => f.payload.msg), ["while disconnected", "after the return"]);
  });

  test("a seeded key never reaches the live stream either", async () => {
    redactor.register("setting:OPENAI_API_KEY", KEY);
    const stream = await openStream("/admin/api/events?logs=1");
    await stream.waitFor((s) => s.events("state").length >= 1);
    ring.push({ level: "error", name: "openai", msg: `failed with ${KEY}` });
    await stream.waitFor((s) => s.events("log").length >= 1);
    assert.ok(!stream.text.includes(KEY));
    assert.match(stream.events("log")[0].payload.msg, /\[redacted\]/);
  });
});
