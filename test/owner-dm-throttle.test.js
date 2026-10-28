"use strict";
/**
 * FR-064 / research U7 (specs/002-admin-panel T122): the owners get at most one stack DM per command per
 * 10 minutes, whatever the number of errors.
 *
 *  - 5 errors from the same command in 10 minutes send exactly one stack DM; a second command gets its own;
 *    the same command after 10 minutes sends one more;
 *  - the suppressed errors still reach the log, `stats.count("cmd_fail", name)` and the bus event
 *    `command:error`, and the user still gets `common.error` every time;
 *  - `MEDIA_TOO_LARGE` is a user error: counted nowhere, no event, no DM.
 *
 * `Date` is mocked (cooldown.hit and the `at` of the event read it). Only test plugins are registered.
 */

const { test, before, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");
const { applyBotFragments } = require("./helpers/botFragments");

const { IDS } = fakes;
fakes.setupEnv({ sudo: "111" });

const registry = require("../lib/plugins/registry");
const stats = require("../lib/utils/stats");
const bus = require("../lib/utils/events");
const cooldown = require("../lib/utils/cooldown");
const logger = require("../lib/utils/logger");
const ring = require("../lib/admin/logs/ring");
const { getOwnerJids } = require("../lib/utils/permissions");
const { getLang } = require("../lib/utils/language");

const MINUTE = 60 * 1000;
const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);

let sock;
let client;
let events; // bus "command:error" payloads
let logged; // ring entries of the registry logger at error level
let unsubscribeRing;
let busListener;

before(() => {
  applyBotFragments();
});

beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  sock = fakes.fakeSocket();
  client = fakes.fakeClient(sock);

  // the windows live in the process-wide cooldown map: every test starts without one
  for (const name of ["zzboom", "zzbang", "zzlarge", "zzfine"]) cooldown.reset(name, "ownerdm");

  registry._reset();
  const failing = (pattern, error) => ({
    command: { pattern, desc: pattern, type: "test" },
    async execute() {
      throw error();
    },
  });
  registry.registerPlugin(failing("zzboom", () => new Error("boom from zzboom")), "zz-boom.js");
  registry.registerPlugin(failing("zzbang", () => new Error("bang from zzbang")), "zz-bang.js");
  registry.registerPlugin(
    failing("zzlarge", () => Object.assign(new Error("too large"), { code: "MEDIA_TOO_LARGE", maxMB: 7 })),
    "zz-large.js",
  );

  events = [];
  busListener = (payload) => events.push(payload);
  bus.on("command:error", busListener);

  logged = [];
  logger.setLevel("error");
  logger.setOutput(() => {});
  unsubscribeRing = ring.subscribe((entry) => {
    if (entry.name === "registry" && entry.level === "error") logged.push(entry);
  });
});

afterEach(() => {
  unsubscribeRing();
  bus.off("command:error", busListener);
  logger.setOutput();
  logger.setLevel("silent");
  mock.timers.reset();
  mock.restoreAll();
});

const GROUP = IDS.GROUP;

/** Send `.<alias>` from a member in the group, through the shared client (one socket for every message) */
async function call(alias) {
  const message = fakes.makeMessage({ body: `.${alias}`, from: IDS.MEMBER_PN, group: GROUP, client });
  assert.equal(await registry.executeCommand(message), true);
}

const ownerJids = () => getOwnerJids();
const stackDms = () => sock.sent.filter((s) => ownerJids().includes(s.jid) && s.kind === "text");
const userErrors = () => sock.sent.filter((s) => s.jid === GROUP && s.text === getLang("common.error"));

test("5 errors from the same command in 10 minutes send exactly one stack DM", async () => {
  assert.ok(ownerJids().length >= 1, "the test needs an owner");
  for (let i = 0; i < 5; i++) {
    await call("zzboom");
    mock.timers.tick(MINUTE);
  }
  const dms = stackDms();
  assert.equal(dms.length, ownerJids().length, "one DM per owner, not per error");
  assert.match(dms[0].text, /Error in \.zzboom/);
  assert.match(dms[0].text, /boom from zzboom/);
  assert.match(dms[0].text, /at /, "the stack is in the DM");
  assert.equal(userErrors().length, 5, "the user gets common.error every time");
});

test("a second command gets its own DM, and the first stays quiet", async () => {
  await call("zzboom");
  await call("zzbang");
  await call("zzboom");
  await call("zzbang");
  const dms = stackDms();
  assert.equal(dms.length, 2 * ownerJids().length);
  assert.ok(dms.some((s) => /Error in \.zzboom/.test(s.text)));
  assert.ok(dms.some((s) => /Error in \.zzbang/.test(s.text)));
  assert.equal(userErrors().length, 4);
});

test("the same command again after 10 minutes sends one more", async () => {
  await call("zzboom");
  assert.equal(stackDms().length, ownerJids().length);

  mock.timers.tick(10 * MINUTE - 1);
  await call("zzboom");
  assert.equal(stackDms().length, ownerJids().length, "1 ms before the end of the window the DM is still suppressed");

  mock.timers.tick(1);
  await call("zzboom");
  assert.equal(stackDms().length, 2 * ownerJids().length, "the window is over");

  // and the window restarts from that DM
  mock.timers.tick(5 * MINUTE);
  await call("zzboom");
  assert.equal(stackDms().length, 2 * ownerJids().length);
  assert.equal(userErrors().length, 4);
});

test("suppressed errors still reach the log, stats.count and the command:error event", async () => {
  const count = mock.method(stats, "count");
  const startedAt = Date.now();
  for (let i = 0; i < 5; i++) {
    await call("zzboom");
    mock.timers.tick(MINUTE);
  }

  assert.equal(stackDms().length, ownerJids().length);
  assert.equal(logged.length, 5, "every error is logged, the DM is not the only trace");
  assert.deepEqual(
    count.mock.calls.map((c) => c.arguments.slice(0, 2)),
    Array.from({ length: 5 }, () => ["cmd_fail", "zzboom"]),
  );
  assert.deepEqual(
    events,
    Array.from({ length: 5 }, (_, i) => ({ name: "zzboom", at: startedAt + i * MINUTE })),
  );
});

test("MEDIA_TOO_LARGE is a user error: counted nowhere, no event, no DM, no error log", async () => {
  const count = mock.method(stats, "count");
  for (let i = 0; i < 3; i++) await call("zzlarge");

  assert.deepEqual(count.mock.calls, [], "neither cmd_ok nor cmd_fail");
  assert.deepEqual(events, []);
  assert.deepEqual(stackDms(), []);
  assert.deepEqual(logged, []);
  const replies = sock.sent.filter((s) => s.jid === GROUP).map((s) => s.text);
  assert.deepEqual(replies, Array.from({ length: 3 }, () => getLang("common.media_too_large", 7)));
});

test("a served command is counted in cmd_ok, a failing one in cmd_fail", async () => {
  registry.registerPlugin({ command: { pattern: "zzfine", desc: "fine", type: "test" }, async execute(m) { await m.reply("fine"); } }, "zz-fine.js");
  const count = mock.method(stats, "count");
  await call("zzfine");
  await call("zzboom");
  assert.deepEqual(
    count.mock.calls.map((c) => c.arguments.slice(0, 2)),
    [["cmd_ok", "zzfine"], ["cmd_fail", "zzboom"]],
  );
  assert.equal(stackDms().length, ownerJids().length);
});
