"use strict";
/**
 * lib/admin/audit.js (data-model 1.7, runtime.md section 15, admin-http-api.md 1.15):
 * record() swallows a failed write without a transaction and rejects with one, auditDiff never carries a secret,
 * a seeded secret is scrubbed from `detail`, an oversized detail becomes a summary (never cut mid-JSON), the
 * "origin never seen" detection and the AUD-1 query helpers (prefix, result, range, pagination).
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const redactor = require("../lib/admin/logs/redactor");
const defaultAudit = require("../lib/admin/audit");
const { createAudit, auditDiff, ACTIONS, MAX_DETAIL } = defaultAudit;

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const MINUTE = 60 * 1000;

let db;
let now = T0;
let audit;

before(async () => {
  db = await fakes.syncDb();
});

beforeEach(async () => {
  now = T0;
  await db.AuditLog.destroy({ where: {}, truncate: true });
  audit = createAudit({ models: db, now: () => now });
});

const rows = () => db.AuditLog.findAll({ raw: true, order: [["id", "ASC"]] });

describe("record", () => {
  test("stores action, target, origin, result and the clock time", async () => {
    const row = await audit.record({ action: "setting.update", target: "PREFIX", origin: "203.0.113.7", detail: { from: ".", to: "!" } });
    assert.equal(row.action, "setting.update");
    const [stored] = await rows();
    assert.equal(stored.target, "PREFIX");
    assert.equal(stored.origin, "203.0.113.7");
    assert.equal(stored.result, "ok");
    assert.deepEqual(JSON.parse(stored.detail), { from: ".", to: "!" });
    assert.equal(new Date(stored.createdAt).getTime(), T0);
  });

  test("absent target, origin and detail are null; result defaults to ok", async () => {
    await audit.record({ action: "logout" });
    const [stored] = await rows();
    assert.equal(stored.target, null);
    assert.equal(stored.origin, null);
    assert.equal(stored.detail, null);
    assert.equal(stored.result, "ok");
  });

  test("result: fail and blocked are kept, refused is stored as blocked, anything else is a failure", async () => {
    await audit.record({ action: "login.failure", result: "fail" });
    await audit.record({ action: "login.blocked", result: "blocked" });
    await audit.record({ action: "login.blocked", result: "refused" });
    await audit.record({ action: "restart", result: "weird" });
    assert.deepEqual((await rows()).map((row) => row.result), ["fail", "blocked", "blocked", "fail"]);
  });

  test("long action, target and origin are cut to their columns", async () => {
    await audit.record({ action: "x".repeat(80), target: "t".repeat(400), origin: "o".repeat(100) });
    const [stored] = await rows();
    assert.equal(stored.action.length, 48);
    assert.equal(stored.target.length, 255);
    assert.equal(stored.origin.length, 64);
  });

  test("without a transaction a failed write is swallowed and logged without values", async () => {
    const lines = [];
    const broken = createAudit({
      models: {
        AuditLog: {
          create: async () => {
            throw Object.assign(new Error("secret-token-in-message"), { name: "SequelizeDatabaseError", code: "SQLITE_ERROR" });
          },
        },
      },
      logger: { warn: (...args) => lines.push(args) },
    });
    const result = await broken.record({ action: "restart", detail: { a: 1 } });
    assert.equal(result, null);
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0][0], { name: "SequelizeDatabaseError", code: "SQLITE_ERROR", action: "restart" });
    assert.ok(!JSON.stringify(lines).includes("secret-token-in-message"), "the error message is not logged");
  });

  test("with a transaction a failed write rejects and nothing is written", async () => {
    const tx = await db.DATABASE.transaction();
    await assert.rejects(audit.record({ action: "" }, { transaction: tx }), TypeError);
    const failing = createAudit({
      models: {
        AuditLog: {
          create: async () => {
            throw new Error("boom");
          },
        },
      },
    });
    await assert.rejects(failing.record({ action: "restart" }, { transaction: tx }), /boom/);
    await tx.rollback();
    assert.equal((await rows()).length, 0);
  });

  test("with a transaction the row commits or rolls back with the caller", async () => {
    const rolled = await db.DATABASE.transaction();
    await audit.record({ action: "economy.adjust", detail: { delta: 5 } }, { transaction: rolled });
    await rolled.rollback();
    assert.equal((await rows()).length, 0);

    const committed = await db.DATABASE.transaction();
    await audit.record({ action: "economy.adjust", detail: { delta: 5 } }, { transaction: committed });
    await committed.commit();
    assert.equal((await rows()).length, 1);
  });

  test("a missing action without a transaction is swallowed too (never breaks the caller)", async () => {
    const quiet = createAudit({ models: db, logger: { warn() {} } });
    assert.equal(await quiet.record({}), null);
  });

  test("the vocabulary lists the login events and the CLI reset", () => {
    for (const action of ["login.success", "login.failure", "login.blocked", "logout", "setup.complete", "reset.issued", "reset.complete", "account.update"]) {
      assert.ok(ACTIONS.includes(action), action);
    }
    assert.ok(Object.isFrozen(ACTIONS));
  });
});

describe("auditDiff", () => {
  test("a non-secret setting records { from, to }", () => {
    assert.deepEqual(auditDiff({ key: "PREFIX" }, ".", "!"), { from: ".", to: "!" });
    assert.deepEqual(auditDiff({ key: "X", secret: false }, undefined, undefined), { from: null, to: null });
  });

  test("a secret records only { secret: true, op } and never a value", () => {
    const set = auditDiff({ key: "OPENAI_API_KEY", secret: true }, "sk-old-123456", "sk-new-123456");
    assert.deepEqual(set, { secret: true, op: "set" });
    assert.deepEqual(auditDiff({ secret: true }, "sk-old-123456", ""), { secret: true, op: "clear" });
    assert.deepEqual(auditDiff({ secret: true }, "sk-old-123456", null), { secret: true, op: "clear" });
    assert.ok(!JSON.stringify(set).includes("sk-"));
  });
});

describe("detail", () => {
  test("a seeded secret is scrubbed before it reaches the row", async () => {
    redactor.register("audit-test", "S3cr3t-Value-1234");
    try {
      await audit.record({ action: "setting.test", detail: { note: "key S3cr3t-Value-1234 refused", plain: "ok" } });
    } finally {
      redactor.unregister("audit-test");
    }
    const [stored] = await rows();
    assert.ok(!stored.detail.includes("S3cr3t-Value-1234"));
    assert.deepEqual(JSON.parse(stored.detail), { note: "key [redacted] refused", plain: "ok" });
  });

  test("a redacted bare number still leaves valid JSON", async () => {
    redactor.register("audit-number", "9876543");
    try {
      await audit.record({ action: "restart", detail: { id: 9876543 } });
    } finally {
      redactor.unregister("audit-number");
    }
    const [stored] = await rows();
    assert.doesNotThrow(() => JSON.parse(stored.detail));
    assert.ok(!stored.detail.includes("9876543"));
  });

  test("an oversized detail becomes a summary object, never a string cut mid-JSON", async () => {
    const big = {};
    for (let i = 0; i < 100; i += 1) big[`key${i}`] = "v".repeat(60);
    await audit.record({ action: "setting.update", detail: big });
    const [stored] = await rows();
    assert.ok(stored.detail.length <= MAX_DETAIL, `${stored.detail.length} characters`);
    const parsed = JSON.parse(stored.detail);
    assert.equal(parsed.truncated, true);
    assert.ok(parsed.length > MAX_DETAIL);
    assert.ok(Array.isArray(parsed.keys) && parsed.keys.length === 20);
  });

  test("a detail of exactly the limit is kept whole; an array detail is summarised without keys", async () => {
    await audit.record({ action: "restart", detail: { text: "a".repeat(MAX_DETAIL - 11) } }); // {"text":""} is 11 characters
    await audit.record({ action: "restart", detail: Array.from({ length: 800 }, (_, i) => i * 1000) });
    const [exact, array] = await rows();
    assert.equal(exact.detail.length, MAX_DETAIL);
    assert.equal(JSON.parse(exact.detail).text.length, MAX_DETAIL - 11);
    assert.equal(JSON.parse(array.detail).truncated, true);
    assert.equal(JSON.parse(array.detail).keys, undefined);
  });

  test("an unserialisable detail (circular) is replaced, not thrown", async () => {
    const loop = {};
    loop.self = loop;
    await audit.record({ action: "restart", detail: loop });
    const [stored] = await rows();
    assert.deepEqual(JSON.parse(stored.detail), { unserializable: true });
  });
});

describe("origin never seen before", () => {
  test("false until a login.success row carries the origin", async () => {
    assert.equal(await audit.hasSeenOrigin("203.0.113.7"), false);
    await audit.record({ action: "login.failure", origin: "203.0.113.7", result: "fail" });
    assert.equal(await audit.hasSeenOrigin("203.0.113.7"), false, "a failure does not make an origin known");
    await audit.record({ action: "login.success", origin: "203.0.113.7" });
    assert.equal(await audit.hasSeenOrigin("203.0.113.7"), true);
    assert.equal(await audit.hasSeenOrigin("198.51.100.9"), false);
  });

  test("the actions that count can be widened (setup and reset rows)", async () => {
    await audit.record({ action: "setup.complete", origin: "192.0.2.1" });
    assert.equal(await audit.hasSeenOrigin("192.0.2.1"), false);
    assert.equal(await audit.hasSeenOrigin("192.0.2.1", { actions: ["login.success", "setup.complete"] }), true);
  });

  test("recentFailures returns the login.failure rows since a time, oldest first", async () => {
    now = T0;
    await audit.record({ action: "login.failure", origin: "a", result: "fail" });
    now = T0 + 5 * MINUTE;
    await audit.record({ action: "login.failure", origin: "b", result: "fail" });
    await audit.record({ action: "login.success", origin: "b" });
    now = T0 + 20 * MINUTE;
    await audit.record({ action: "login.failure", origin: "a", result: "fail" });
    const recent = await audit.recentFailures({ since: T0 + 4 * MINUTE });
    assert.deepEqual(recent, [
      { origin: "b", at: T0 + 5 * MINUTE },
      { origin: "a", at: T0 + 20 * MINUTE },
    ]);
  });
});

describe("list (AUD-1)", () => {
  async function seed() {
    const plan = [
      ["login.success", "ok", 0],
      ["login.failure", "fail", 1],
      ["login.blocked", "blocked", 2],
      ["logout", "ok", 3],
      ["setting.update", "ok", 4],
      ["setting.reset", "ok", 5],
      ["setting.update", "fail", 6],
    ];
    for (const [action, result, minutes] of plan) {
      now = T0 + minutes * MINUTE;
      await audit.record({ action, result, target: action, origin: "o", detail: { n: minutes } });
    }
  }

  test("newest first, with at, parsed detail and the page envelope", async () => {
    await seed();
    const page = await audit.list({});
    assert.equal(page.total, 7);
    assert.equal(page.page, 1);
    assert.equal(page.pageSize, 50);
    assert.deepEqual(page.items.map((item) => item.detail.n), [6, 5, 4, 3, 2, 1, 0]);
    assert.equal(page.items[0].at, new Date(T0 + 6 * MINUTE).toISOString());
    assert.deepEqual(Object.keys(page.items[0]).sort(), ["action", "at", "detail", "id", "origin", "result", "target"]);
  });

  test("action is a prefix: login matches login.*, setting.update is exact", async () => {
    await seed();
    assert.equal((await audit.list({ action: "login" })).total, 3);
    assert.equal((await audit.list({ action: "setting" })).total, 3);
    assert.equal((await audit.list({ action: "setting.update" })).total, 2);
    assert.equal((await audit.list({ action: "nothing" })).total, 0);
  });

  test("a prefix with LIKE wildcards or odd characters matches nothing", async () => {
    await seed();
    for (const action of ["%", "_", "login%", "log in", "x".repeat(60)]) {
      const page = await audit.list({ action });
      assert.equal(page.total, 0, action);
      assert.deepEqual(page.items, []);
    }
  });

  test("result filter, refused being the blocked ones", async () => {
    await seed();
    assert.equal((await audit.list({ result: "ok" })).total, 4);
    assert.equal((await audit.list({ result: "fail" })).total, 2);
    assert.equal((await audit.list({ result: "refused" })).total, 1);
    assert.equal((await audit.list({ result: "blocked" })).total, 1);
  });

  test("from and to bound the range, inclusive; an unparsable bound is ignored", async () => {
    await seed();
    const range = await audit.list({ from: new Date(T0 + 2 * MINUTE).toISOString(), to: new Date(T0 + 4 * MINUTE).toISOString() });
    assert.deepEqual(range.items.map((item) => item.detail.n), [4, 3, 2]);
    assert.equal((await audit.list({ from: "not a date" })).total, 7);
  });

  test("pagination: pages of 50 over 120 rows, pageSize capped at 200, page floored at 1", async () => {
    const batch = [];
    for (let i = 0; i < 120; i += 1) {
      batch.push({ action: "restart", target: String(i), origin: "o", result: "ok", detail: null, createdAt: new Date(T0 + i * 1000) });
    }
    await db.AuditLog.bulkCreate(batch);
    const p1 = await audit.list({ page: 1 });
    const p2 = await audit.list({ page: 2 });
    const p3 = await audit.list({ page: 3 });
    const p4 = await audit.list({ page: 4 });
    assert.deepEqual([p1.items.length, p2.items.length, p3.items.length, p4.items.length], [50, 50, 20, 0]);
    assert.deepEqual([p1.total, p2.total, p3.total, p4.total], [120, 120, 120, 120]);
    assert.equal(p1.items[0].target, "119");
    assert.equal(p3.items[19].target, "0");
    assert.equal((await audit.list({ pageSize: 1000 })).pageSize, 200);
    assert.equal((await audit.list({ pageSize: 1000 })).items.length, 120);
    assert.equal((await audit.list({ page: 0 })).page, 1);
    assert.equal((await audit.list({ pageSize: 10, page: 12 })).items.length, 10);
  });

  test("the default instance is usable as the audit of createAdmin (record and list exist)", () => {
    for (const name of ["record", "list", "hasSeenOrigin", "recentFailures"]) assert.equal(typeof defaultAudit[name], "function", name);
  });
});
