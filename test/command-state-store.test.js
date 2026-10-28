"use strict";
/**
 * lib/utils/commandState.js, data layer only (specs/002-admin-panel T013, data-model 1.5,
 * runtime.md section 5). The registry check and SC-013 belong to the W-CMD tests.
 *
 *  - set() creates and deletes rows; isDisabled() is "global wins, group rows only in that group";
 *  - fail-open when the load throws;
 *  - one settingsCache key, `command_state`, invalidated by every setter;
 *  - snapshot() lists the orphans;
 *  - toggle() applies disable/enable lists idempotently, caps at 500 scopes, returns the warnings.
 */

const { test, describe, before, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv();
const commandState = require("../lib/utils/commandState");
const settingsCache = require("../lib/utils/settingsCache");

const G1 = "120363000000000001@g.us";
const G2 = "120363000000000002@g.us";
const group = (jid) => ({ isGroup: true, jid });
const privateChat = { isGroup: false, jid: "333@s.whatsapp.net" };
const entry = (name) => ({ name });

let db;

const rows = async () =>
  (await db.CommandState.findAll({ order: [["command", "ASC"], ["scope", "ASC"]], raw: true })).map(({ command, scope }) => ({
    command,
    scope,
  }));

before(async () => {
  db = await fakes.syncDb();
});

beforeEach(async () => {
  await db.CommandState.destroy({ where: {} });
  settingsCache.clear();
});

afterEach(() => {
  mock.restoreAll();
});

describe("set()", () => {
  test("creates a row when disabling and deletes it when enabling", async () => {
    await commandState.set("ping", "*", true);
    assert.deepEqual(await rows(), [{ command: "ping", scope: "*" }]);
    await commandState.set("ping", G1, true);
    assert.deepEqual(await rows(), [
      { command: "ping", scope: "*" },
      { command: "ping", scope: G1 },
    ]);

    await commandState.set("ping", "*", false);
    assert.deepEqual(await rows(), [{ command: "ping", scope: G1 }]);
    await commandState.set("ping", G1, false);
    assert.deepEqual(await rows(), []);
  });

  test("is idempotent: disabling twice keeps one row, enabling a missing row is not an error", async () => {
    await commandState.set("ping", "*", true, { actor: "admin" });
    await commandState.set("ping", "*", true, { actor: "admin" });
    assert.deepEqual(await rows(), [{ command: "ping", scope: "*" }]);
    await commandState.set("menu", "*", false);
    assert.deepEqual(await rows(), [{ command: "ping", scope: "*" }]);
  });

  test("keeps the date of the change when it is applied again", async () => {
    await commandState.set("ping", "*", true);
    const first = await db.CommandState.findOne({ raw: true });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await commandState.set("ping", "*", true);
    const second = await db.CommandState.findOne({ raw: true });
    assert.deepEqual(second.createdAt, first.createdAt);
  });

  test("normalizes the name (lower case) and the group JID (device suffix dropped)", async () => {
    await commandState.set("  PiNg ", "120363000000000001:7@g.us", true);
    assert.deepEqual(await rows(), [{ command: "ping", scope: G1 }]);
  });

  test("refuses a bad command name or scope with a stable code", async () => {
    for (const name of ["", "  ", "two words", "x".repeat(65), null, undefined, 42]) {
      await assert.rejects(commandState.set(name, "*", true), { code: "invalid_command" });
    }
    for (const scope of ["", "all", "333@s.whatsapp.net", "status@broadcast", "**", undefined, null]) {
      await assert.rejects(commandState.set("ping", scope, true), { code: "invalid_scope" });
    }
    assert.deepEqual(await rows(), []);
  });

  test("an orphan name can be enabled (deleted) like any other", async () => {
    await db.CommandState.create({ command: "oldname", scope: "*" });
    await commandState.set("oldname", "*", false);
    assert.deepEqual(await rows(), []);
  });
});

describe("isDisabled()", () => {
  test("a global row disables the command everywhere, owners included (no owner notion here)", async () => {
    await commandState.set("ping", "*", true);
    assert.equal(await commandState.isDisabled(entry("ping"), group(G1)), true);
    assert.equal(await commandState.isDisabled(entry("ping"), group(G2)), true);
    assert.equal(await commandState.isDisabled(entry("ping"), privateChat), true);
    assert.equal(await commandState.isDisabled(entry("menu"), group(G1)), false, "other commands are not touched");
  });

  test("a group row disables the command in that group only", async () => {
    await commandState.set("ping", G1, true);
    assert.equal(await commandState.isDisabled(entry("ping"), group(G1)), true);
    assert.equal(await commandState.isDisabled(entry("ping"), group(G2)), false);
    assert.equal(await commandState.isDisabled(entry("ping"), privateChat), false);
  });

  test("a group row is ignored for a message that is not in a group", async () => {
    await commandState.set("ping", G1, true);
    assert.equal(await commandState.isDisabled(entry("ping"), { isGroup: false, jid: G1 }), false);
  });

  test("global wins over group rows: enabling the group row does not re-enable a globally disabled command", async () => {
    await commandState.set("ping", "*", true);
    await commandState.set("ping", G1, false);
    assert.equal(await commandState.isDisabled(entry("ping"), group(G1)), true);
    // and the reverse: the global row removed, the group row decides
    await commandState.set("ping", G1, true);
    await commandState.set("ping", "*", false);
    assert.equal(await commandState.isDisabled(entry("ping"), group(G1)), true);
    assert.equal(await commandState.isDisabled(entry("ping"), group(G2)), false);
  });

  test("an entry without a name or a missing message disables nothing", async () => {
    await commandState.set("ping", "*", true);
    assert.equal(await commandState.isDisabled({}, group(G1)), false);
    assert.equal(await commandState.isDisabled(null, group(G1)), false);
    assert.equal(await commandState.isDisabled(entry("menu"), undefined), false);
  });

  test("fail-open: when the load throws, nothing is disabled; the next call retries", async () => {
    await commandState.set("ping", "*", true);
    settingsCache.clear();

    mock.method(db.CommandState, "findAll", async () => {
      throw new Error("database is down");
    });
    assert.equal(await commandState.isDisabled(entry("ping"), group(G1)), false);
    assert.deepEqual(await commandState.snapshot({ commands: ["ping"] }), {
      global: [],
      byGroup: {},
      orphans: [],
      orphanRows: [],
    });

    mock.restoreAll();
    assert.equal(await commandState.isDisabled(entry("ping"), group(G1)), true, "the failure was not cached");
  });

  test("fail-open also when the lookup itself blows up", async () => {
    mock.method(settingsCache, "getOrLoad", async () => {
      throw new Error("cache exploded");
    });
    assert.equal(await commandState.isDisabled(entry("ping"), group(G1)), false);
  });
});

describe("cache", () => {
  test("a single settingsCache key `command_state`, loaded once for all lookups", async () => {
    await db.CommandState.bulkCreate([
      { command: "ping", scope: "*" },
      { command: "menu", scope: G1 },
    ]);
    const findAll = mock.method(db.CommandState, "findAll");

    await commandState.isDisabled(entry("ping"), group(G1));
    await commandState.isDisabled(entry("menu"), group(G2));
    await commandState.isDisabled(entry("other"), privateChat);

    assert.equal(findAll.mock.calls.length, 1, "one findAll for every command and every chat");
    assert.deepEqual([...settingsCache.cache.keys()], ["command_state"]);
    assert.equal(settingsCache.cache.get("command_state").ttl, 5 * 60 * 1000);
  });

  test("every setter invalidates the key; a direct write is only seen after that", async () => {
    assert.equal(await commandState.isDisabled(entry("ping"), group(G1)), false);
    await db.CommandState.create({ command: "ping", scope: "*" }); // bypasses the setter
    assert.equal(await commandState.isDisabled(entry("ping"), group(G1)), false, "still the cached state");

    const invalidate = mock.method(settingsCache, "invalidate");
    await commandState.set("menu", G1, true);
    assert.deepEqual(invalidate.mock.calls.map((c) => c.arguments[0]), ["command_state"]);
    assert.equal(await commandState.isDisabled(entry("ping"), group(G1)), true, "the next lookup reloads");

    await commandState.set("menu", G1, false);
    await commandState.toggle("menu", { disable: ["*"] });
    await commandState.toggle("menu", { enable: ["*"] });
    assert.ok(invalidate.mock.calls.length >= 4);
    assert.ok(invalidate.mock.calls.every((c) => c.arguments[0] === "command_state"));
  });

  test("invalidate() drops the cached state (restore, restart)", async () => {
    assert.equal(await commandState.isDisabled(entry("ping"), group(G1)), false);
    await db.CommandState.create({ command: "ping", scope: "*" });
    commandState.invalidate();
    assert.equal(await commandState.isDisabled(entry("ping"), group(G1)), true);
  });
});

describe("snapshot()", () => {
  test("lists what is disabled, globally and per group", async () => {
    await commandState.set("ping", "*", true);
    await commandState.set("menu", "*", true);
    await commandState.set("ping", G2, true);
    await commandState.set("play", G1, true);
    const snap = await commandState.snapshot({ commands: ["ping", "menu", "play"] });
    assert.deepEqual(snap.global, ["menu", "ping"]);
    assert.deepEqual(snap.byGroup, { [G1]: ["play"], [G2]: ["ping"] });
    assert.deepEqual(snap.orphans, []);
  });

  test("orphans are the rows whose command no longer exists", async () => {
    await commandState.set("ping", "*", true);
    await commandState.set("gone", "*", true);
    await commandState.set("gone", G1, true);
    await commandState.set("renamed", G2, true);
    const snap = await commandState.snapshot({ commands: new Set(["ping", "menu"]) });
    assert.deepEqual(snap.orphans, ["gone", "renamed"]);
    assert.deepEqual(snap.orphanRows, [
      { command: "gone", scope: "*" },
      { command: "gone", scope: G1 },
      { command: "renamed", scope: G2 },
    ]);
    assert.deepEqual(snap.global, ["gone", "ping"], "orphans are still listed as disabled");
  });

  test("without a known set of commands (registry not loaded) nothing is called an orphan", async () => {
    await commandState.set("gone", "*", true);
    const snap = await commandState.snapshot();
    assert.deepEqual(snap.orphans, []);
    assert.deepEqual(snap.global, ["gone"]);
  });
});

describe("toggle()", () => {
  test("applies disable and enable lists and reports where the command is disabled", async () => {
    const first = await commandState.toggle("ping", { disable: [G1, G2], enable: ["*"] }, { actor: "admin" });
    assert.deepEqual(first, { disabledGlobal: false, disabledGroups: [G1, G2], warnings: [] });
    assert.deepEqual(await rows(), [
      { command: "ping", scope: G1 },
      { command: "ping", scope: G2 },
    ]);

    const second = await commandState.toggle("ping", { disable: ["*"], enable: [G2] });
    assert.deepEqual(second, { disabledGlobal: true, disabledGroups: [G1], warnings: [] });

    const third = await commandState.toggle("ping", { enable: ["*", G1] });
    assert.deepEqual(third, { disabledGlobal: false, disabledGroups: [], warnings: [] });
    assert.deepEqual(await rows(), []);
  });

  test("is idempotent and set-based: repeating a call changes nothing, other commands are untouched", async () => {
    await commandState.set("menu", "*", true);
    const call = () => commandState.toggle("ping", { disable: [G1, G1, "*"], enable: [G2] });
    const a = await call();
    const b = await call();
    assert.deepEqual(a, b);
    assert.deepEqual(await rows(), [
      { command: "menu", scope: "*" },
      { command: "ping", scope: "*" },
      { command: "ping", scope: G1 },
    ]);
  });

  test("accepts a single scope string and empty lists", async () => {
    assert.deepEqual(await commandState.toggle("ping", { disable: G1 }), { disabledGlobal: false, disabledGroups: [G1], warnings: [] });
    assert.deepEqual(await commandState.toggle("ping", {}), { disabledGlobal: false, disabledGroups: [G1], warnings: [] });
    assert.deepEqual(await commandState.toggle("ping"), { disabledGlobal: false, disabledGroups: [G1], warnings: [] });
  });

  test("warns when it disables unban or ban (the panel is then the only way back)", async () => {
    assert.deepEqual((await commandState.toggle("unban", { disable: ["*"] })).warnings, ["unban_disabled"]);
    assert.deepEqual((await commandState.toggle("ban", { disable: [G1] })).warnings, ["banchat_disabled"]);
    assert.deepEqual((await commandState.toggle("UNBAN", { disable: [G1] })).warnings, ["unban_disabled"]);
    assert.deepEqual((await commandState.toggle("unban", { enable: ["*", G1] })).warnings, [], "enabling does not warn");
    assert.deepEqual((await commandState.toggle("ping", { disable: ["*"] })).warnings, []);
  });

  test("caps at 500 scopes; nothing is written above the cap", async () => {
    const groups = (n, from = 0) => Array.from({ length: n }, (_, i) => `1203630000${String(from + i).padStart(8, "0")}@g.us`);
    await assert.rejects(commandState.toggle("ping", { disable: groups(501) }), { code: "too_many_scopes", params: { max: 500 } });
    await assert.rejects(commandState.toggle("ping", { disable: groups(300), enable: groups(201, 1000) }), { code: "too_many_scopes" });
    assert.deepEqual(await rows(), []);

    const result = await commandState.toggle("ping", { disable: groups(300), enable: groups(200, 1000) });
    assert.equal(result.disabledGroups.length, 300);
    assert.equal(await db.CommandState.count(), 300);
  });

  test("duplicates count once towards the cap", async () => {
    const same = Array.from({ length: 600 }, () => G1);
    const result = await commandState.toggle("ping", { disable: same });
    assert.deepEqual(result.disabledGroups, [G1]);
  });

  test("refuses a scope in both lists, a bad scope and a bad name, writing nothing", async () => {
    await assert.rejects(commandState.toggle("ping", { disable: [G1], enable: [G1] }), { code: "invalid_format" });
    await assert.rejects(commandState.toggle("ping", { disable: ["*"], enable: ["*"] }), { code: "invalid_format" });
    await assert.rejects(commandState.toggle("ping", { disable: [G1, "nope"] }), { code: "invalid_scope" });
    await assert.rejects(commandState.toggle("", { disable: ["*"] }), { code: "invalid_command" });
    assert.deepEqual(await rows(), []);
  });
});
