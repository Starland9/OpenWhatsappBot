"use strict";
/**
 * Feature 003 (specs/003-command-permissions, contracts/runtime.md section 3 and 2.1): which commands the
 * panel may open to other people.
 *
 *  - the guard: the loaded entries with `delegable === false` are exactly the 14 owner-only commands of the
 *    contract table, each with its lockReason (one of five codes); `vv` and `save` are delegable;
 *  - every plugin whose `command` is fromMe / ownerOnly declares `delegable` as a boolean itself, so the
 *    next owner-only command forces a conscious choice (U6);
 *  - the normalization of `registerCommand` (table of 2.1) on probe plugins.
 *
 * Adding a non-delegable command means editing NON_DELEGABLE below on purpose.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });
const net = fakes.stubNetwork();

let registry;
let commands;

before(async () => {
  const setup = await fakes.setup();
  registry = setup.registry;
  commands = setup.commands;
});

after(() => {
  net.restore();
});

/** plugin file -> [entry name (first alias), lockReason code], runtime.md section 3 */
const NON_DELEGABLE = {
  "eval.js": ["exec", "code"],
  "update.js": ["update", "update"],
  "exportcontacts.js": ["exportcontacts", "data"],
  "banchat.js": ["ban", "lockout"],
  "unbanchat.js": ["unban", "lockout"],
  "viewonce.js": ["setvv", "config"],
  "getvv.js": ["getvv", "config"],
  "antidel.js": ["antidelete", "config"],
  "getantidel.js": ["getantidelete", "config"],
  "autorespond.js": ["ar", "config"],
  "statussave.js": ["statussave", "config"],
  "stickercmd.js": ["setcmd", "config"],
  "delcmd.js": ["delcmd", "config"],
  "getcmd.js": ["getcmd", "config"],
};
const DELEGABLE_OWNER_FILES = { "vv.js": "vv", "save.js": "save" };
const LOCK_CODES = ["code", "update", "data", "lockout", "config"];

const byFile = () => new Map(commands.map((entry) => [entry.file, entry]));
const isOwnerCommand = (entry) => entry.fromMe || entry.ownerOnly;

// ---------------------------------------------------------------------------
// The guard (real plugins)
// ---------------------------------------------------------------------------

test("guard: the entries with delegable === false are exactly the 14 owner-only commands of the contract", () => {
  const found = commands
    .filter((entry) => entry.delegable === false)
    .map((entry) => `${entry.file}:${entry.name}`)
    .sort();
  const expected = Object.entries(NON_DELEGABLE)
    .map(([file, [name]]) => `${file}:${name}`)
    .sort();
  assert.equal(expected.length, 14);
  assert.deepEqual(found, expected, "a command was made (non-)delegable: edit NON_DELEGABLE on purpose");
});

test("guard: every entry carries a boolean delegable", () => {
  for (const entry of commands) {
    assert.equal(typeof entry.delegable, "boolean", `${entry.file}: entry.delegable must be a boolean`);
  }
});

test("guard: each non-delegable entry has its exact lockReason, one of the five codes", () => {
  const files = byFile();
  const problems = [];
  for (const [file, [name, code]] of Object.entries(NON_DELEGABLE)) {
    const entry = files.get(file);
    if (!entry) {
      problems.push(`${file}: no command registered`);
      continue;
    }
    if (entry.name !== name) problems.push(`${file}: entry name is "${entry.name}", expected "${name}"`);
    if (entry.lockReason !== code) problems.push(`${file}: lockReason is ${JSON.stringify(entry.lockReason)}, expected "${code}"`);
    if (!LOCK_CODES.includes(entry.lockReason)) problems.push(`${file}: lockReason is not one of ${LOCK_CODES.join(", ")}`);
    if (!isOwnerCommand(entry)) problems.push(`${file}: a non-delegable command must stay fromMe/ownerOnly (second line of defence)`);
  }
  fakes.assertNone(problems);
});

test("guard: vv and save are explicitly delegable and carry no lockReason", () => {
  const files = byFile();
  for (const [file, name] of Object.entries(DELEGABLE_OWNER_FILES)) {
    const entry = files.get(file);
    assert.ok(entry, `${file}: no command registered`);
    assert.equal(entry.name, name);
    assert.equal(entry.delegable, true, `${file} must be delegable`);
    assert.equal(entry.lockReason, null);
    assert.ok(isOwnerCommand(entry), `${file} stays owner-only until the panel opens it`);
    assert.equal(entry.plugin.command.delegable, true, `${file} must declare delegable: true itself`);
  }
});

test("guard: a delegable entry never has a lockReason", () => {
  for (const entry of commands.filter((e) => e.delegable)) {
    assert.equal(entry.lockReason, null, `${entry.file} (.${entry.name}) is delegable and must not carry a lockReason`);
  }
});

test("guard: every fromMe / ownerOnly plugin declares plugin.command.delegable as a boolean itself (U6)", () => {
  const owner = commands.filter(isOwnerCommand);
  assert.equal(owner.length, 16, "16 owner-only commands (14 never delegable + vv + save)");
  const problems = [];
  for (const entry of owner) {
    // the module, not the entry: the entry would hide a missing declaration behind the registry default
    const declared = entry.plugin.command.delegable;
    if (typeof declared !== "boolean") {
      problems.push(`${entry.file} (.${entry.name}): command.delegable must be declared true or false (found ${typeof declared})`);
    }
  }
  fakes.assertNone(problems, "a new owner-only command must choose delegable: true | false on purpose");
});

test("guard: a non-delegable plugin declares delegable false and a lockReason string itself", () => {
  const files = byFile();
  for (const file of Object.keys(NON_DELEGABLE)) {
    const command = files.get(file).plugin.command;
    assert.equal(command.delegable, false, `${file}: command.delegable`);
    assert.equal(typeof command.lockReason, "string", `${file}: command.lockReason`);
  }
});

// ---------------------------------------------------------------------------
// Normalization of registerCommand (section 2.1), on probes
// ---------------------------------------------------------------------------

function probe(command) {
  return {
    command: { desc: "probe", type: "test", ...command },
    async execute() {},
  };
}

/** Register one probe on an empty registry and return its entry. */
function register(command) {
  registry._reset();
  return registry.registerCommand(probe({ pattern: "zzprobe", ...command }), "zz-probe.js");
}

test("2.1: a probe without the flag is delegable, with no lockReason", () => {
  const entry = register({});
  assert.equal(entry.delegable, true);
  assert.equal(entry.lockReason, null);
});

test("2.1: an admin-only, onlyGroup or onlyPm probe without the flag is delegable (the panel warns instead)", () => {
  for (const flags of [{ adminOnly: true }, { onlyGroup: true }, { onlyPm: true }]) {
    const entry = register(flags);
    assert.equal(entry.delegable, true, JSON.stringify(flags));
    assert.equal(entry.lockReason, null);
  }
});

test("2.1: an owner-only probe without the flag is not delegable and has lockReason null", () => {
  for (const flags of [{ fromMe: true }, { ownerOnly: true }, { fromMe: true, ownerOnly: true }]) {
    const entry = register(flags);
    assert.equal(entry.delegable, false, JSON.stringify(flags));
    assert.equal(entry.lockReason, null, "the panel then shows the 'reserved to the owner' fallback");
  }
});

test("2.1: delegable: true on an owner-only probe is delegable, and fromMe / ownerOnly stay what they are", () => {
  const entry = register({ fromMe: true, delegable: true });
  assert.equal(entry.delegable, true);
  assert.equal(entry.lockReason, null);
  assert.equal(entry.fromMe, true);
  assert.equal(entry.ownerOnly, false);

  const second = register({ ownerOnly: true, delegable: true });
  assert.equal(second.delegable, true);
  assert.equal(second.ownerOnly, true);
});

test("2.1: delegable: false on a public probe makes it non-delegable", () => {
  const entry = register({ delegable: false, lockReason: "config" });
  assert.equal(entry.delegable, false);
  assert.equal(entry.lockReason, "config");
  assert.equal(entry.fromMe, false);
});

test("2.1: lockReason is trimmed; it is copied as is, the registry does not check the five-code vocabulary", () => {
  assert.equal(register({ fromMe: true, delegable: false, lockReason: " code " }).lockReason, "code");
  assert.equal(register({ fromMe: true, delegable: false, lockReason: "something-new" }).lockReason, "something-new");
});

test("2.1: a lockReason declared with delegable: true becomes null", () => {
  const entry = register({ fromMe: true, delegable: true, lockReason: "code" });
  assert.equal(entry.delegable, true);
  assert.equal(entry.lockReason, null);
  // also when the flag is implicit
  const implicit = register({ lockReason: "config" });
  assert.equal(implicit.delegable, true);
  assert.equal(implicit.lockReason, null);
});

test("2.1: delegable: false with a missing, empty or non-string lockReason gives null", () => {
  for (const lockReason of [undefined, "", "   ", null, 42, true, {}, ["code"]]) {
    const entry = register({ fromMe: true, delegable: false, lockReason });
    assert.equal(entry.delegable, false);
    assert.equal(entry.lockReason, null, `lockReason ${JSON.stringify(lockReason)}`);
  }
});

test("2.1: a non-boolean delegable falls back to the default (strings and numbers are not booleans)", () => {
  assert.equal(register({ delegable: "false" }).delegable, true);
  assert.equal(register({ delegable: 0 }).delegable, true);
  assert.equal(register({ fromMe: true, delegable: "true" }).delegable, false);
  assert.equal(register({ fromMe: true, delegable: 1 }).delegable, false);
});
