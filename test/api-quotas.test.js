"use strict";
/**
 * Per-key quotas of the messaging API (feature 004, contracts/runtime.md section 15.8, public-api.md 7.1): the sliding
 * minute, the calendar day of TIMEZONE (23 and 25 hour days included), the rebuild from the stored messages after a
 * restart, the non-consuming check, the synchronous reserve under 50-way concurrency, refunds, limits read at call
 * time and the RateLimit snapshot. Fake clock, in-memory models.
 */

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { DateTime } = require("luxon");

const kit = require("./helpers/backupKit");
const { createClock } = require("./helpers/fakeClock");
const { createQuotas } = require("../lib/api/limits");
const { ApiError } = require("../lib/api/errors");

let db;
before(async () => {
  db = await kit.makeDb();
});
after(async () => {
  if (db) await db.DATABASE.close();
});
beforeEach(async () => {
  await db.ApiMessage.destroy({ where: {} });
});

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);

const keyOf = (id, limits = {}) => ({ id, limits: { perMinute: null, perDay: null, maxPending: null, ...limits } });
function setup({ config = {}, zone, start = T0 } = {}) {
  const clock = createClock(start);
  const cfg = { API_RATE_PER_MINUTE: 30, API_RATE_PER_DAY: 1000, API_MAX_PENDING: 100, TIMEZONE: "UTC", ...config };
  const quotas = createQuotas({ now: () => clock.now(), config: cfg, models: db, zone });
  return { clock, cfg, quotas };
}
const refusal = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ApiError, `expected an ApiError, got ${err && err.name}`);
    return err;
  }
  return assert.fail("expected a refusal");
};
const refusalAsync = async (promise) => {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ApiError);
    return err;
  }
  return assert.fail("expected a refusal");
};

describe("the sliding minute", () => {
  test("reserve counts, the (limit+1)th is rate_limited with retryAfterMs = oldest + 60 s - now, and the window slides", async () => {
    const { clock, quotas } = setup();
    const key = keyOf(1, { perMinute: 3 });
    await quotas.check(key);
    quotas.reserve(key);
    await clock.advance(10 * SEC);
    quotas.reserve(key);
    await clock.advance(10 * SEC);
    quotas.reserve(key);

    const err = refusal(() => quotas.reserve(key));
    assert.equal(err.code, "rate_limited");
    assert.deepEqual(err.params, { scope: "minute", limit: 3, retryAfterMs: 40 * SEC });
    assert.deepEqual(quotas.snapshot(key), { limit: 3, remaining: 0, resetSeconds: 40 });

    await clock.advance(39 * SEC);
    refusal(() => quotas.reserve(key));
    await clock.advance(2 * SEC); // the oldest left the window
    quotas.reserve(key);
    // window now holds the acceptances of t=10 s, t=20 s and t=61 s: the next slot opens at t=70 s
    assert.deepEqual(quotas.snapshot(key), { limit: 3, remaining: 0, resetSeconds: 9 });
  });

  test("snapshot of an empty window: remaining = limit, reset 0", () => {
    const { quotas } = setup();
    assert.deepEqual(quotas.snapshot(keyOf(2, { perMinute: 5 })), { limit: 5, remaining: 5, resetSeconds: 0 });
  });

  test("keys are independent", async () => {
    const { quotas } = setup();
    const a = keyOf(3, { perMinute: 1 });
    const b = keyOf(4, { perMinute: 1 });
    quotas.reserve(a);
    quotas.reserve(b);
    refusal(() => quotas.reserve(a));
  });
});

describe("check is non-consuming and ordered day then minute", () => {
  test("check never changes the counters", async () => {
    const { quotas } = setup();
    const key = keyOf(5, { perMinute: 1 });
    for (let i = 0; i < 10; i++) await quotas.check(key);
    quotas.reserve(key);
    refusal(() => quotas.reserve(key));
  });

  test("check refuses a key at its limit, the day before the minute", async () => {
    const { quotas } = setup();
    const key = keyOf(6, { perMinute: 1, perDay: 1 });
    quotas.reserve(key);
    const err = await refusalAsync(quotas.check(key));
    assert.equal(err.code, "daily_quota_exceeded", "both exceeded: the day is reported");
    const minuteOnly = keyOf(7, { perMinute: 1, perDay: 10 });
    quotas.reserve(minuteOnly);
    assert.equal((await refusalAsync(quotas.check(minuteOnly))).code, "rate_limited");
  });
});

describe("the calendar day of TIMEZONE", () => {
  test("the day counter refuses with retryAfterMs to the next local midnight, then resets", async () => {
    // 2026-11-02 10:00 UTC is 05:00 in New York (EST): midnight is 19 h away
    const { clock, quotas } = setup({ config: { TIMEZONE: "America/New_York" } });
    const key = keyOf(10, { perDay: 2, perMinute: 100 });
    quotas.reserve(key);
    quotas.reserve(key);
    const err = refusal(() => quotas.reserve(key));
    assert.equal(err.code, "daily_quota_exceeded");
    assert.deepEqual(err.params, { limit: 2, retryAfterMs: 19 * HOUR });
    await clock.advance(19 * HOUR - 1);
    refusal(() => quotas.reserve(key));
    await clock.advance(1);
    quotas.reserve(key);
    quotas.reserve(key);
    refusal(() => quotas.reserve(key));
  });

  test("the zone changes the day: the same instant is another day in Pacific/Kiritimati", async () => {
    const east = setup({ start: Date.UTC(2026, 10, 2, 9, 30, 0), config: { TIMEZONE: "Pacific/Kiritimati" } });
    const key = keyOf(11, { perDay: 1, perMinute: 100 });
    east.quotas.reserve(key);
    const err = refusal(() => east.quotas.reserve(key));
    // 09:30 UTC = 23:30 local (UTC+14): midnight in 30 minutes
    assert.equal(err.params.retryAfterMs, 30 * MIN);
  });

  test("a 23-hour day (spring forward) and a 25-hour day (fall back) are measured to the real midnight", () => {
    // New York 2026-03-08 loses an hour at 02:00: from 00:30 local (05:30 UTC) midnight is 22.5 h away
    const spring = setup({ start: Date.UTC(2026, 2, 8, 5, 30, 0), config: { TIMEZONE: "America/New_York" } });
    const k1 = keyOf(12, { perDay: 1, perMinute: 100 });
    spring.quotas.reserve(k1);
    assert.equal(refusal(() => spring.quotas.reserve(k1)).params.retryAfterMs, 22.5 * HOUR);
    // 2026-11-01 gains an hour at 02:00: from 00:30 local (04:30 UTC) midnight is 24.5 h away
    const fall = setup({ start: Date.UTC(2026, 10, 1, 4, 30, 0), config: { TIMEZONE: "America/New_York" } });
    const k2 = keyOf(13, { perDay: 1, perMinute: 100 });
    fall.quotas.reserve(k2);
    assert.equal(refusal(() => fall.quotas.reserve(k2)).params.retryAfterMs, 24.5 * HOUR);
  });

  test("an invalid TIMEZONE falls back to UTC", async () => {
    const { quotas } = setup({ config: { TIMEZONE: "Not/AZone" } });
    const key = keyOf(14, { perDay: 1, perMinute: 100 });
    quotas.reserve(key);
    assert.equal(refusal(() => quotas.reserve(key)).params.retryAfterMs, 14 * HOUR, "10:00 UTC to midnight UTC");
  });
});

describe("restart: the counters are rebuilt from the stored messages", () => {
  async function seed(keyId, times, status = "sent") {
    let n = 0;
    for (const at of times) {
      n += 1;
      await db.ApiMessage.create({
        publicId: `msg_${String(keyId * 1000 + n + Math.floor(at % 997)).padStart(22, "A")}`,
        apiKeyId: keyId,
        recipient: "237690000001@s.whatsapp.net",
        format: "text",
        status,
        acceptedAt: new Date(at),
        expiresAt: new Date(at + 10 * MIN),
        ...(status === "failed" ? { endedAt: new Date(at + 1000), errorCode: "send_failed" } : {}),
        ...(status === "cancelled" ? { endedAt: new Date(at + 1000), errorCode: "key_revoked" } : {}),
      });
    }
  }

  test("a second createQuotas over the same rows cannot reset the day, every status counts", async () => {
    const key = keyOf(20, { perDay: 4, perMinute: 100 });
    const midnight = DateTime.fromMillis(T0, { zone: "UTC" }).startOf("day").toMillis();
    await seed(20, [midnight + HOUR, midnight + 2 * HOUR]);
    await seed(20, [midnight + 3 * HOUR], "failed");
    await seed(20, [midnight + 4 * HOUR], "cancelled");
    await seed(20, [midnight - HOUR], "sent"); // yesterday: not counted

    const first = setup();
    const err = await refusalAsync(first.quotas.check(key));
    assert.equal(err.code, "daily_quota_exceeded");
    assert.equal(err.params.limit, 4);
    const restarted = setup();
    assert.equal((await refusalAsync(restarted.quotas.check(key))).code, "daily_quota_exceeded");
  });

  test("the last 60 s of messages feed the minute window", async () => {
    const key = keyOf(21, { perMinute: 2, perDay: 100 });
    await seed(21, [T0 - 30 * SEC, T0 - 10 * SEC]);
    await seed(21, [T0 - 90 * SEC]);
    const { quotas } = setup();
    const err = await refusalAsync(quotas.check(key));
    assert.equal(err.code, "rate_limited");
    assert.equal(err.params.retryAfterMs, 30 * SEC);
    assert.deepEqual(quotas.snapshot(key), { limit: 2, remaining: 0, resetSeconds: 30 });
  });

  test("hydration happens once per key per process, and another key's rows are ignored", async () => {
    await seed(22, [T0 - 5 * SEC]);
    await seed(23, [T0 - 5 * SEC]);
    const { quotas } = setup();
    const spy = [];
    const original = db.ApiMessage.count;
    db.ApiMessage.count = async (...args) => (spy.push(args), original.apply(db.ApiMessage, args));
    try {
      await quotas.check(keyOf(22, { perDay: 5, perMinute: 5 }));
      await quotas.check(keyOf(22, { perDay: 5, perMinute: 5 }));
      assert.equal(spy.length, 1);
      assert.deepEqual(quotas.snapshot(keyOf(24, { perMinute: 5 })), { limit: 5, remaining: 5, resetSeconds: 0 });
    } finally {
      db.ApiMessage.count = original;
    }
  });

  test("a failed hydration is retried next time and does not poison the key", async () => {
    const { quotas } = setup();
    const key = keyOf(25, { perDay: 5, perMinute: 5 });
    const original = db.ApiMessage.count;
    db.ApiMessage.count = async () => {
      throw new Error("database busy");
    };
    try {
      await assert.rejects(quotas.check(key), /database busy/);
    } finally {
      db.ApiMessage.count = original;
    }
    await quotas.check(key);
  });
});

describe("reserve under concurrency and refunds", () => {
  test("50 concurrent reserves never exceed a limit (minute and day)", async () => {
    const { quotas } = setup();
    const key = keyOf(30, { perMinute: 10, perDay: 1000 });
    await quotas.hydrate(key);
    const results = await Promise.all(
      Array.from({ length: 50 }, async () => {
        try {
          return quotas.reserve(key);
        } catch (err) {
          return err;
        }
      }),
    );
    assert.equal(results.filter((r) => !(r instanceof Error)).length, 10);
    assert.equal(results.filter((r) => r instanceof ApiError && r.code === "rate_limited").length, 40);

    const daily = keyOf(31, { perMinute: 1000, perDay: 7 });
    const second = await Promise.all(Array.from({ length: 50 }, async () => { try { return quotas.reserve(daily); } catch (err) { return err; } }));
    assert.equal(second.filter((r) => !(r instanceof Error)).length, 7);
  });

  test("release gives the slot back once; a double release changes nothing", async () => {
    const { quotas } = setup();
    const key = keyOf(32, { perMinute: 1, perDay: 1 });
    const hold = quotas.reserve(key);
    refusal(() => quotas.reserve(key));
    hold.release();
    hold.release();
    const again = quotas.reserve(key);
    refusal(() => quotas.reserve(key));
    again.release();
  });

  test("a release after the day rolled over does not make the new day negative", async () => {
    const { clock, quotas } = setup({ start: Date.UTC(2026, 10, 2, 23, 59, 59) });
    const key = keyOf(33, { perMinute: 100, perDay: 2 });
    const old = quotas.reserve(key);
    await clock.advance(2 * SEC);
    quotas.reserve(key);
    old.release();
    quotas.reserve(key);
    refusal(() => quotas.reserve(key));
  });
});

describe("limits are read at call time", () => {
  test("a key without an override follows the settings, an override wins", async () => {
    const { cfg, quotas } = setup({ config: { API_RATE_PER_MINUTE: 5 } });
    const follower = keyOf(40);
    const pinned = keyOf(41, { perMinute: 2 });
    for (let i = 0; i < 5; i++) quotas.reserve(follower);
    refusal(() => quotas.reserve(follower));
    cfg.API_RATE_PER_MINUTE = 6;
    quotas.reserve(follower);
    refusal(() => quotas.reserve(follower));
    cfg.API_RATE_PER_MINUTE = 1;
    refusal(() => quotas.reserve(follower), "lowering the default applies at once");
    quotas.reserve(pinned);
    quotas.reserve(pinned);
    refusal(() => quotas.reserve(pinned));
    assert.equal(quotas.snapshot(follower).limit, 1);
    assert.equal(quotas.snapshot(pinned).limit, 2);
  });

  test("the day default follows API_RATE_PER_DAY", () => {
    const { cfg, quotas } = setup({ config: { API_RATE_PER_DAY: 1 } });
    const key = keyOf(42, { perMinute: 100 });
    quotas.reserve(key);
    refusal(() => quotas.reserve(key));
    cfg.API_RATE_PER_DAY = 2;
    quotas.reserve(key);
  });
});

describe("the module's own rules", () => {
  test("no timer and no database at construction; the engine's pending and global refusals are not here", () => {
    const clock = createClock(T0);
    createQuotas({ now: () => clock.now(), config: {}, models: null });
    assert.equal(clock.pending(), 0);
    const source = require("node:fs").readFileSync(require.resolve("../lib/api/limits"), "utf8");
    assert.ok(!/pending_limit_reached|queue_full/.test(source.replace(/\/\*[\s\S]*?\*\//g, "")));
  });
});
