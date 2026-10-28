"use strict";
/**
 * T024: logger, redactor, ring and console capture (contracts/runtime.md section 12).
 *
 *  - redactor: variants (raw, JSON-escaped, URL-encoded, base64, base64url), values under 6
 *    characters ignored, replacement of a name, longest value first, ephemeral expiry (lazy and
 *    swept), no timer that keeps the process alive;
 *  - ring: bound of 1000, msg cap, 12 stack lines, level as a minimum, q, since, limit,
 *    lastErrors, subscribe, pino lines;
 *  - consoleCapture: scrubs, never pushes QR art, printToConsole bypasses the ring (child
 *    process, so the real stdout is observed);
 *  - createLogger: output reaches the ring scrubbed, setLevel reaches the children created
 *    before the call.
 */

// The logger is silent unless a test raises its level.
process.env.LOG_LEVEL = "silent";
delete process.env.LOG_FORMAT;

const { test, describe, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const redactor = require("../lib/admin/logs/redactor");
const ring = require("../lib/admin/logs/ring");
const consoleCapture = require("../lib/admin/logs/consoleCapture");
const logger = require("../lib/utils/logger");

const SECRET = "s3cr3t-value-123456";

describe("redactor", () => {
  beforeEach(() => redactor.clear());
  afterEach(() => {
    redactor.clear();
    mock.timers.reset();
  });

  test("scrubs the raw value wherever it appears", () => {
    redactor.register("api", SECRET);
    assert.equal(redactor.scrub(`key=${SECRET} again ${SECRET}`), "key=[redacted] again [redacted]");
    assert.equal(redactor.scrub("nothing to hide"), "nothing to hide");
  });

  test("scrubs the JSON-escaped variant", () => {
    const value = 'ab"cd\nef\\gh';
    redactor.register("quoted", value);
    const escaped = JSON.stringify({ msg: value });
    assert.ok(escaped.includes('ab\\"cd\\nef\\\\gh'));
    const out = redactor.scrub(escaped);
    assert.ok(!out.includes("ab\\\"cd"));
    assert.equal(JSON.parse(out).msg, "[redacted]");
  });

  test("scrubs the URL-encoded variant", () => {
    const value = "pass word&x=y/1";
    redactor.register("pwd", value);
    const encoded = encodeURIComponent(value);
    assert.notEqual(encoded, value);
    assert.equal(redactor.scrub(`GET /?p=${encoded}`), "GET /?p=[redacted]");
  });

  test("scrubs the base64 and base64url variants", () => {
    const value = "???>>>???";
    redactor.register("b64", value);
    const b64 = Buffer.from(value).toString("base64");
    const b64url = Buffer.from(value).toString("base64url");
    assert.ok(/[+/]/.test(b64), "fixture must exercise the + and / alphabet");
    assert.ok(/[-_]/.test(b64url));
    assert.equal(redactor.scrub(`a ${b64} b`), "a [redacted] b");
    assert.equal(redactor.scrub(`a ${b64url} b`), "a [redacted] b");
  });

  test("values shorter than 6 characters are ignored", () => {
    redactor.register("short", "abcde");
    assert.equal(redactor.size(), 0);
    assert.equal(redactor.scrub("abcde and abcde"), "abcde and abcde");
    redactor.register("ok", "abcdef");
    assert.equal(redactor.scrub("abcde abcdef"), "abcde [redacted]");
  });

  test("a non-string input is returned untouched", () => {
    redactor.register("api", SECRET);
    assert.equal(redactor.scrub(undefined), undefined);
    assert.equal(redactor.scrub(12), 12);
    assert.equal(redactor.scrub(""), "");
  });

  test("register replaces the previous value of the same name", () => {
    redactor.register("api", "first-secret-value");
    redactor.register("api", "second-secret-value");
    assert.equal(redactor.size(), 1);
    assert.equal(redactor.scrub("first-secret-value second-secret-value"), "first-secret-value [redacted]");
    // replacing by an unusable (too short) value forgets the old one
    redactor.register("api", "x");
    assert.equal(redactor.size(), 0);
    assert.equal(redactor.scrub("second-secret-value"), "second-secret-value");
  });

  test("unregister forgets a name", () => {
    redactor.register("api", SECRET);
    redactor.unregister("api");
    redactor.unregister("never-registered");
    assert.equal(redactor.scrub(SECRET), SECRET);
  });

  test("the longest value wins when one contains another", () => {
    redactor.register("short", "secret-token");
    redactor.register("long", "secret-token-extended");
    assert.equal(redactor.scrub("x secret-token-extended y"), "x [redacted] y");
    assert.equal(redactor.scrub("x secret-token y"), "x [redacted] y");
  });

  test("regular expression metacharacters in a secret are matched literally", () => {
    redactor.register("meta", "a.b*c+d?e(f)[g]");
    assert.equal(redactor.scrub("v=a.b*c+d?e(f)[g]."), "v=[redacted].");
    assert.equal(redactor.scrub("v=aXbbbcd"), "v=aXbbbcd");
  });

  test("ephemeral values expire (checked lazily, through the now option)", () => {
    redactor.registerEphemeral("qr", "qr-string-0123456789", 5 * 60 * 1000, { now: 1000 });
    assert.equal(redactor.scrub("qr-string-0123456789", { now: 1000 + 60 * 1000 }), "[redacted]");
    assert.equal(redactor.scrub("qr-string-0123456789", { now: 1000 + 5 * 60 * 1000 + 1 }), "qr-string-0123456789");
    assert.equal(redactor.size(), 0);
  });

  test("an unref()'d sweep drops expired ephemeral values without any scrub", () => {
    mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
    redactor.registerEphemeral("setup", "setup-token-0123456789", 10 * 1000);
    redactor.register("permanent", SECRET);
    assert.equal(redactor.size(), 2);
    mock.timers.tick(5 * 1000);
    assert.equal(redactor.size(), 2);
    mock.timers.tick(60 * 1000);
    assert.equal(redactor.size(), 1);
    assert.equal(redactor.scrub(`${SECRET} setup-token-0123456789`), "[redacted] setup-token-0123456789");
  });

  test("registering a permanent value over an ephemeral one makes it permanent", () => {
    redactor.registerEphemeral("tok", "token-aaaaaaaaaa", 1000, { now: 0 });
    redactor.register("tok", "token-bbbbbbbbbb");
    assert.equal(redactor.scrub("token-bbbbbbbbbb token-aaaaaaaaaa", { now: 10 * 60 * 1000 }), "[redacted] token-aaaaaaaaaa");
  });

  test("an ephemeral value never keeps the process alive and nothing runs at require time", () => {
    const script = `
      const redactor = require(${JSON.stringify(path.join(ROOT, "lib/admin/logs/redactor"))});
      require(${JSON.stringify(path.join(ROOT, "lib/admin/logs/ring"))});
      require(${JSON.stringify(path.join(ROOT, "lib/admin/logs/consoleCapture"))});
      require(${JSON.stringify(path.join(ROOT, "lib/utils/logger"))});
      redactor.registerEphemeral("qr", "qr-string-0123456789", 60 * 60 * 1000);
      process.stdout.write("done\\n");
    `;
    const res = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 8000 });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.signal, null);
    assert.equal(res.stdout, "done\n");
  });
});

describe("ring", () => {
  beforeEach(() => {
    redactor.clear();
    ring.clear();
  });
  afterEach(() => {
    redactor.clear();
    ring.clear();
  });

  test("keeps the 1000 newest entries, in order", () => {
    for (let i = 1; i <= 1005; i += 1) ring.push({ level: "info", name: "t", msg: `m${i}` });
    const all = ring.list();
    assert.equal(ring.CAPACITY, 1000);
    assert.equal(all.length, 1000);
    assert.equal(all[0].msg, "m6");
    assert.equal(all[999].msg, "m1005");
    assert.equal(all[999].seq - all[0].seq, 999);
    assert.ok(all.every((e, i) => i === 0 || e.seq === all[i - 1].seq + 1));
  });

  test("stores { seq, ts, level, name, msg } and nothing else", () => {
    const stored = ring.push({ level: 50, name: "db", msg: "boom", ts: 0, extra: "dropped", apiKey: "k" });
    assert.deepEqual(Object.keys(stored).sort(), ["level", "msg", "name", "seq", "ts"]);
    assert.equal(stored.level, "error");
    assert.equal(stored.ts, "1970-01-01T00:00:00.000Z");
    assert.deepEqual(ring.list()[0], stored);
  });

  test("caps msg at 2000 characters", () => {
    ring.push({ level: "info", name: "t", msg: "x".repeat(5000) });
    assert.equal(ring.list()[0].msg.length, 2000);
  });

  test("keeps 12 stack lines at most and every other line", () => {
    const stack = ["Error: boom", ...Array.from({ length: 30 }, (_, i) => `    at fn${i} (file.js:${i}:1)`), "tail line"].join("\n");
    ring.push({ level: "error", name: "t", msg: stack });
    const lines = ring.list()[0].msg.split("\n");
    assert.equal(lines.filter((l) => /^\s+at /.test(l)).length, 12);
    assert.equal(lines[0], "Error: boom");
    assert.equal(lines[lines.length - 1], "tail line");
    assert.ok(lines.includes("    at fn11 (file.js:11:1)"));
    assert.ok(!lines.includes("    at fn12 (file.js:12:1)"));
  });

  test("scrubs the message through the redactor", () => {
    redactor.register("api", SECRET);
    ring.push({ level: "info", name: "t", msg: `token ${SECRET}` });
    assert.equal(ring.list()[0].msg, "token [redacted]");
  });

  test("level is a minimum", () => {
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) ring.push({ level, name: "t", msg: level });
    assert.deepEqual(ring.list({ level: "error" }).map((e) => e.level), ["error", "fatal"]);
    assert.deepEqual(ring.list({ level: "warn" }).map((e) => e.level), ["warn", "error", "fatal"]);
    assert.equal(ring.list({ level: "trace" }).length, 6);
    assert.equal(ring.list({ level: "nonsense" }).length, 6);
    assert.equal(ring.list().length, 6);
  });

  test("q is a case-insensitive substring of the message", () => {
    ring.push({ level: "info", name: "t", msg: "Connection OPENED" });
    ring.push({ level: "info", name: "t", msg: "something else" });
    assert.deepEqual(ring.list({ q: "opened" }).map((e) => e.msg), ["Connection OPENED"]);
    assert.equal(ring.list({ q: "absent" }).length, 0);
  });

  test("since is a sequence number and limit keeps the newest entries", () => {
    for (let i = 1; i <= 10; i += 1) ring.push({ level: "info", name: "t", msg: `m${i}` });
    const all = ring.list();
    const cursor = all[3].seq;
    assert.deepEqual(ring.list({ since: cursor }).map((e) => e.msg), ["m5", "m6", "m7", "m8", "m9", "m10"]);
    assert.deepEqual(ring.list({ limit: 3 }).map((e) => e.msg), ["m8", "m9", "m10"]);
    // with a cursor, a polling client gets the entries right after it (no hole)
    assert.deepEqual(ring.list({ since: cursor, limit: 2 }).map((e) => e.msg), ["m5", "m6"]);
    assert.equal(ring.list({ since: all[9].seq }).length, 0);
    assert.equal(ring.lastSeq(), all[9].seq);
  });

  test("lastErrors returns the newest error and fatal entries first, 10 by default", () => {
    for (let i = 1; i <= 15; i += 1) {
      ring.push({ level: "error", name: "t", msg: `e${i}` });
      ring.push({ level: "info", name: "t", msg: `i${i}` });
    }
    ring.push({ level: "fatal", name: "t", msg: "f" });
    const errors = ring.lastErrors();
    assert.equal(errors.length, 10);
    assert.deepEqual(errors.slice(0, 3).map((e) => e.msg), ["f", "e15", "e14"]);
    assert.ok(errors.every((e) => e.level === "error" || e.level === "fatal"));
    assert.equal(ring.lastErrors(2).length, 2);
    assert.equal(ring.lastErrors(0).length, 0);
  });

  test("subscribe delivers new entries until unsubscribed; a throwing subscriber is isolated", () => {
    const seen = [];
    ring.subscribe(() => {
      throw new Error("broken subscriber");
    });
    const off = ring.subscribe((e) => seen.push(e.msg));
    ring.push({ level: "info", name: "t", msg: "one" });
    off();
    off();
    ring.push({ level: "info", name: "t", msg: "two" });
    assert.deepEqual(seen, ["one"]);
    assert.equal(ring.list().length, 2);
    assert.throws(() => ring.subscribe("nope"), TypeError);
  });

  test("returned entries are copies", () => {
    ring.push({ level: "info", name: "t", msg: "keep" });
    ring.list()[0].msg = "changed";
    assert.equal(ring.list()[0].msg, "keep");
  });

  test("pushFromPinoLine reads level, time, name, msg and appends the error stack", () => {
    const time = Date.UTC(2026, 0, 2, 3, 4, 5);
    ring.pushFromPinoLine(JSON.stringify({ level: 30, time, pid: 1, hostname: "h", name: "loader", msg: "hello", ignored: { a: 1 } }) + "\n");
    ring.pushFromPinoLine(JSON.stringify({ level: 50, time, name: "db", msg: "failed", err: { type: "Error", message: "boom", stack: "Error: boom\n    at a (f.js:1:1)" } }));
    const [info, error] = ring.list();
    assert.deepEqual(info, { seq: info.seq, ts: "2026-01-02T03:04:05.000Z", level: "info", name: "loader", msg: "hello" });
    assert.equal(error.level, "error");
    assert.equal(error.msg, "failed\nError: boom\n    at a (f.js:1:1)");
  });

  test("pushFromPinoLine keeps a line that is not JSON and ignores an empty one", () => {
    assert.equal(ring.pushFromPinoLine("   \n"), null);
    ring.pushFromPinoLine("plain text line\n");
    assert.equal(ring.list()[0].msg, "plain text line");
    assert.equal(ring.list()[0].level, "info");
  });
});

describe("consoleCapture", () => {
  const METHODS = ["log", "info", "debug", "warn", "error"];
  const saved = {};

  beforeEach(() => {
    redactor.clear();
    ring.clear();
    for (const m of METHODS) {
      saved[m] = console[m];
      console[m] = () => {}; // silent originals: install() wraps whatever is there
    }
  });
  afterEach(() => {
    consoleCapture.uninstall();
    for (const m of METHODS) console[m] = saved[m];
    redactor.clear();
    ring.clear();
  });

  test("pushes every console method with its level, name 'console', formatted and scrubbed", () => {
    redactor.register("api", SECRET);
    assert.equal(consoleCapture.install(), true);
    assert.equal(consoleCapture.install(), false, "install is idempotent");
    console.log("a %s %d", "b", 3, { k: 1 });
    console.info(`info ${SECRET}`);
    console.debug("dbg");
    console.warn("warn");
    console.error("err");
    const entries = ring.list();
    assert.deepEqual(entries.map((e) => e.level), ["info", "info", "debug", "warn", "error"]);
    assert.ok(entries.every((e) => e.name === "console"));
    assert.equal(entries[0].msg, "a b 3 { k: 1 }");
    assert.equal(entries[1].msg, "info [redacted]");
  });

  test("calls the original, with a scrubbed message when a secret was present", () => {
    const calls = [];
    for (const m of METHODS) console[m] = (...args) => calls.push([m, args]);
    redactor.register("api", SECRET);
    consoleCapture.install();
    console.log("plain", 1);
    console.warn(`leak ${SECRET}`);
    assert.deepEqual(calls, [
      ["log", ["plain", 1]],
      ["warn", ["leak [redacted]"]],
    ]);
  });

  test("never pushes QR art or a 'QR available' line, and leaves them untouched", () => {
    const calls = [];
    console.log = (...args) => calls.push(args);
    redactor.register("qr", "qr-string-0123456789");
    consoleCapture.install();
    console.log("██████████████ ▀▀▀▄▄▄");
    console.log("QR available: qr-string-0123456789");
    console.log("█▀▄ short");
    assert.equal(calls.length, 3);
    assert.equal(calls[1][0], "QR available: qr-string-0123456789");
    const msgs = ring.list().map((e) => e.msg);
    assert.deepEqual(msgs, ["█▀▄ short"]);
  });

  test("printToConsole writes to the real stdout, unscrubbed, and stays out of the ring", () => {
    const script = `
      const redactor = require(${JSON.stringify(path.join(ROOT, "lib/admin/logs/redactor"))});
      const ring = require(${JSON.stringify(path.join(ROOT, "lib/admin/logs/ring"))});
      const cc = require(${JSON.stringify(path.join(ROOT, "lib/admin/logs/consoleCapture"))});
      redactor.register("setup", "setup-token-0123456789");
      cc.install();
      cc.printToConsole("SETUP http://localhost:3000/admin/setup?token=setup-token-0123456789");
      console.log("seen setup-token-0123456789");
      process.stderr.write("__RING__" + JSON.stringify(ring.list()) + "\\n");
    `;
    const res = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 8000 });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(res.stdout.split("\n").filter(Boolean), [
      "SETUP http://localhost:3000/admin/setup?token=setup-token-0123456789",
      "seen [redacted]",
    ]);
    const ringLine = res.stderr.split("\n").find((l) => l.startsWith("__RING__"));
    const entries = JSON.parse(ringLine.slice("__RING__".length));
    assert.deepEqual(entries.map((e) => e.msg), ["seen [redacted]"]);
    assert.ok(!JSON.stringify(entries).includes("setup-token-0123456789"));
  });
});

describe("logger", () => {
  let lines;

  beforeEach(() => {
    redactor.clear();
    ring.clear();
    lines = [];
    logger.setOutput((text) => lines.push(text));
  });
  afterEach(() => {
    logger.setLevel("silent");
    logger.setOutput();
    delete process.env.LOG_FORMAT;
    redactor.clear();
    ring.clear();
  });

  test("is silent by default in tests (LOG_LEVEL=silent)", () => {
    const log = logger.createLogger("quiet");
    log.error("nobody hears this");
    assert.equal(logger.getLevel(), "silent");
    assert.equal(lines.length, 0);
    assert.equal(ring.list().length, 0);
  });

  test("output reaches the ring and stdout, scrubbed, with the module name", () => {
    redactor.register("api", SECRET);
    logger.setLevel("info");
    const log = logger.createLogger("mymodule");
    log.info(`calling with ${SECRET}`);
    log.error({ err: new Error(`failed ${SECRET}`) }, "request failed");
    const entries = ring.list();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].name, "mymodule");
    assert.equal(entries[0].level, "info");
    assert.equal(entries[0].msg, "calling with [redacted]");
    assert.equal(entries[1].level, "error");
    assert.ok(entries[1].msg.startsWith("request failed\nError: failed [redacted]"));
    assert.ok(!JSON.stringify(entries).includes(SECRET));
    assert.ok(lines.length >= 2);
    assert.ok(!lines.join("").includes(SECRET));
    assert.match(lines[0], /calling with .*\[redacted\]/);
  });

  test("LOG_FORMAT=json forwards the scrubbed JSON line", () => {
    process.env.LOG_FORMAT = "json";
    redactor.register("api", SECRET);
    logger.setLevel("info");
    logger.createLogger("jsonmod").info({ ctx: 1 }, `value ${SECRET}`);
    assert.equal(lines.length, 1);
    const obj = JSON.parse(lines[0]);
    assert.equal(obj.name, "jsonmod");
    assert.equal(obj.msg, "value [redacted]");
    assert.equal(obj.ctx, 1);
    assert.equal(ring.list()[0].msg, "value [redacted]");
  });

  test("pino redact paths hide credential-looking fields", () => {
    process.env.LOG_FORMAT = "json";
    logger.setLevel("info");
    logger.createLogger("paths").info(
      {
        cfg: { apiKey: "k-1", token: "t-1", password: "p-1" },
        req: { headers: { authorization: "Bearer abc", cookie: "sid=1", accept: "*/*" } },
        res: { headers: { "set-cookie": "sid=2" } },
      },
      "request",
    );
    const obj = JSON.parse(lines[0]);
    assert.equal(obj.cfg.apiKey, "[redacted]");
    assert.equal(obj.cfg.token, "[redacted]");
    assert.equal(obj.cfg.password, "[redacted]");
    assert.equal(obj.req.headers.authorization, "[redacted]");
    assert.equal(obj.req.headers.cookie, "[redacted]");
    assert.equal(obj.req.headers.accept, "*/*");
    assert.equal(obj.res.headers["set-cookie"], "[redacted]");
  });

  test("setLevel applies to children created before the call, and a quieter level hides lines", () => {
    const early = logger.createLogger("early");
    early.info("hidden while silent");
    assert.equal(ring.list().length, 0);

    assert.equal(logger.setLevel("warn"), true);
    assert.equal(logger.getLevel(), "warn");
    early.info("still hidden");
    early.warn("visible");
    const late = logger.createLogger("late");
    late.info("late hidden");
    late.error("late visible");
    assert.deepEqual(ring.list().map((e) => `${e.name}:${e.msg}`), ["early:visible", "late:late visible"]);

    logger.setLevel("debug");
    early.debug("now visible");
    late.debug("also visible");
    assert.deepEqual(ring.list().slice(2).map((e) => e.msg), ["now visible", "also visible"]);
  });

  test("setLevel refuses an unknown level and keeps the current one", () => {
    logger.setLevel("error");
    assert.equal(logger.setLevel("loud"), false);
    assert.equal(logger.getLevel(), "error");
  });

  test("install() starts the console capture and printToConsole is the capture's", () => {
    const saved = { log: console.log };
    console.log = () => {};
    try {
      assert.equal(logger.install(), true);
      console.log("through the ring");
      assert.deepEqual(ring.list().map((e) => e.msg), ["through the ring"]);
      assert.equal(logger.printToConsole, consoleCapture.printToConsole);
    } finally {
      consoleCapture.uninstall();
      console.log = saved.log;
    }
  });
});
