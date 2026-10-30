"use strict";
/**
 * Feature 003 (specs/003-command-permissions, contracts/runtime.md sections 1, 2 and 8): per-command
 * permission rules read by the registry.
 *
 * Part 1: the decision table of FR-006 through `registry.executeCommand`, FR-008 / FR-009, the disabled
 * state, the banned chat, stickers bound by `setcmd`, aliases and orphan rows.
 * Part 2: identity (PN and LID), cache and invalidation, the loader contract, fail-open (FR-011), SC-003
 * (a rule never opens a non-delegable command), the stored values pinned against the model.
 *
 * Probe plugins are registered on a fresh registry; the SC-003 test loads the real plugins.
 */

const { test, before, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

const { IDS } = fakes;
fakes.setupEnv({ sudo: "111" });

const registry = require("../lib/plugins/registry");
const commandPermissions = require("../lib/utils/commandPermissions");
const commandState = require("../lib/utils/commandState");
const pipeline = require("../lib/core/pipeline");
const settingsCache = require("../lib/utils/settingsCache");
const stats = require("../lib/utils/stats");
const bus = require("../lib/utils/events");
const cooldown = require("../lib/utils/cooldown");
const logger = require("../lib/utils/logger");
const ring = require("../lib/admin/logs/ring");
const { getLang } = require("../lib/utils/language");
const { invalidateGroupMetadata } = require("../lib/classes/Message");

const { VERDICTS, MODES, MAX_PEOPLE, GLOBAL_SCOPE, CACHE_KEY } = commandPermissions;

const GROUP_A = IDS.GROUP; // 120363000000000001@g.us
const GROUP_D = "120363000000000004@g.us";
const PRIVATE = "private";

// Actors (senders). B is named in the rules; C, E are not. All three are plain members.
const OWNER = { from: IDS.OWNER_PN };
const OWNER_VIA_LID = { from: IDS.OWNER_PN, lid: true };
const B = { from: IDS.MEMBER_PN }; // 333, LID 888 in the group participants
const C = { from: IDS.MEMBER2_PN }; // 444, PN only
const E = { from: "237690000009@s.whatsapp.net" };

/** A stored person. */
const person = (pn, lid = null) => ({ pn, lid });
const PB = person(IDS.MEMBER_PN); // B by phone number only
const PC = person(IDS.MEMBER2_PN);

const ORIGINAL_LOG_LEVEL = logger.getLevel();

let db;
const ran = []; // "<file>:<alias>" recorded by the probes

before(async () => {
  db = await fakes.syncDb();
});

beforeEach(async () => {
  await db.PermissionRule.destroy({ where: {} });
  await db.CommandState.destroy({ where: {} });
  await db.BannedChat.destroy({ where: {} });
  await db.StickerCommand.destroy({ where: {} });
  settingsCache.clear();
  invalidateGroupMetadata();
  ran.length = 0;
  registry._reset();
  for (const [file, plugin] of Object.entries(probes())) registry.registerPlugin(plugin, file);
});

afterEach(() => {
  mock.restoreAll();
  logger.setOutput();
  logger.setLevel(ORIGINAL_LOG_LEVEL);
});

/** A command that records its calls: the same shape as a real plugin. */
function probe(file, command, extra = {}) {
  return {
    command: { desc: file, type: "test", ...command },
    async execute(message, args, ctx) {
      ran.push(`${file}:${ctx.command}`);
      await message.reply(`ran:${ctx.command}`);
    },
    ...extra,
  };
}

function probes() {
  return {
    "zz-pub.js": probe("zz-pub.js", { pattern: "zzpub|zzpublic" }),
    "zz-pub2.js": probe("zz-pub2.js", { pattern: "zzpub2" }),
    // owner-only but explicitly delegable (the same shape as .vv)
    "zz-owner.js": probe("zz-owner.js", { pattern: "zzowner|zzboss", fromMe: true, delegable: true }),
    "zz-admin.js": probe("zz-admin.js", { pattern: "zzadmin", adminOnly: true }),
    "zz-group.js": probe("zz-group.js", { pattern: "zzgroup", onlyGroup: true }),
    "zz-pm.js": probe("zz-pm.js", { pattern: "zzpm", onlyPm: true }),
    // public command that declares itself non-delegable, and an owner-only one without the flag
    "zz-locked.js": probe("zz-locked.js", { pattern: "zzlocked", delegable: false, lockReason: "config" }),
    "zz-lockedowner.js": probe("zz-lockedowner.js", { pattern: "zzlockedowner", fromMe: true }),
    "zz-unban.js": probe("zz-unban.js", { pattern: "unban", fromMe: true, delegable: false, lockReason: "lockout" }),
  };
}

/** Insert a valid rule (model validators run) and drop the engine cache, as the panel does. */
async function rule(command, scope, mode, people) {
  await db.PermissionRule.create({ command, scope, mode, people });
  commandPermissions.invalidate();
}

const REPLY = {
  owner_only: "common.owner_only",
  sender_not_admin: "common.sender_not_admin",
  group_cmd: "extra.group_cmd",
  pm_only: "common.pm_only",
  disabled: "common.command_disabled",
};

/** Send `.alias` as `who` in `where` (PRIVATE or a group JID). */
async function send(alias, who, where = PRIVATE, { admin, body } = {}) {
  const message = fakes.makeMessage({
    body: body ?? `.${alias}`,
    ...who,
    group: where === PRIVATE ? undefined : where,
    admin,
  });
  const before = ran.length;
  const handled = await registry.executeCommand(message);
  const sock = message.client.getSocket();
  return {
    handled,
    message,
    sock,
    alias: String(alias).toLowerCase(),
    texts: fakes.sentTexts(sock),
    sent: sock.sent.slice(),
    ran: ran.slice(before),
  };
}

/** `expected`: "runs" | "silent" | a REPLY key */
function assertOutcome(result, expected, label = "") {
  const where = label ? ` (${label})` : "";
  if (expected === "runs") {
    assert.deepEqual(result.texts, [`ran:${result.alias}`], `expected the command to run${where}`);
    assert.equal(result.ran.length, 1, `execute must be called once${where}`);
  } else if (expected === "silent") {
    assert.deepEqual(result.sent, [], `expected silence: no reply, no reaction${where}`);
    assert.deepEqual(result.ran, [], `execute must not be called${where}`);
  } else {
    assert.ok(REPLY[expected], `unknown expectation ${expected}`);
    assert.deepEqual(result.texts, [getLang(REPLY[expected])], `expected ${expected}${where}`);
    assert.deepEqual(result.ran, [], `execute must not be called${where}`);
  }
}

// ---------------------------------------------------------------------------
// Module surface
// ---------------------------------------------------------------------------

test("exports: exactly decide, invalidate and the constants of contracts/runtime.md 1.1", () => {
  assert.deepEqual(Object.keys(commandPermissions).sort(), [
    "CACHE_KEY",
    "GLOBAL_SCOPE",
    "MAX_PEOPLE",
    "MODES",
    "VERDICTS",
    "decide",
    "invalidate",
  ]);
  assert.equal(CACHE_KEY, "command_perms");
  assert.equal(GLOBAL_SCOPE, "*");
  assert.equal(MAX_PEOPLE, 100);
  assert.deepEqual({ ...MODES }, { EXTRA: "extra", ONLY: "only" });
  assert.deepEqual({ ...VERDICTS }, { OWNER: "owner", GRANTED: "granted", CLOSED: "closed", NORMAL: "normal" });
  assert.ok(Object.isFrozen(MODES) && Object.isFrozen(VERDICTS));
});

test("invalidate() drops the settingsCache key", async () => {
  await rule("zzpub", "*", "only", [PB]);
  assert.equal((await send("zzpub", E)).sent.length, 0); // loads the cache
  assert.ok(settingsCache.cache.has(CACHE_KEY), "the state is cached under command_perms");
  commandPermissions.invalidate();
  assert.equal(settingsCache.cache.has(CACHE_KEY), false);
});

test("the verdicts are shared frozen { verdict, scope, mode } objects", async () => {
  const pub = registry.getCommandByPattern("zzpub");
  const message = (who, where) => fakes.makeMessage({ body: ".zzpub", ...who, group: where === PRIVATE ? undefined : where });

  const owner = await commandPermissions.decide(pub, message(OWNER, GROUP_A));
  assert.deepEqual({ ...owner }, { verdict: "owner", scope: null, mode: null });

  const none = await commandPermissions.decide(pub, message(E, GROUP_A));
  assert.deepEqual({ ...none }, { verdict: "normal", scope: null, mode: null });

  await rule("zzpub", "*", "extra", [PB]);
  const grantedGlobal = await commandPermissions.decide(pub, message(B, GROUP_A));
  assert.deepEqual({ ...grantedGlobal }, { verdict: "granted", scope: "global", mode: "extra" });

  await rule("zzpub", GROUP_A, "only", [PC]);
  const closed = await commandPermissions.decide(pub, message(E, GROUP_A));
  assert.deepEqual({ ...closed }, { verdict: "closed", scope: "group", mode: "only" });
  const grantedGroup = await commandPermissions.decide(pub, message(C, GROUP_A));
  assert.deepEqual({ ...grantedGroup }, { verdict: "granted", scope: "group", mode: "only" });
  // the global rule is tested first: B is listed in both rules
  await db.PermissionRule.update({ people: [PB, PC] }, { where: { command: "zzpub", scope: GROUP_A } });
  commandPermissions.invalidate();
  assert.equal((await commandPermissions.decide(pub, message(B, GROUP_A))).scope, "global");

  // an empty group "extra" rule is "niveau normal ici": normal, carrying the deciding rule
  await rule("zzpub", GROUP_D, "extra", []);
  const normalHere = await commandPermissions.decide(pub, message(E, GROUP_D));
  assert.deepEqual({ ...normalHere }, { verdict: "normal", scope: "group", mode: "extra" });

  assert.ok(Object.isFrozen(owner) && Object.isFrozen(closed) && Object.isFrozen(grantedGroup) && Object.isFrozen(normalHere));
  assert.equal(await commandPermissions.decide(pub, message(E, GROUP_A)), closed, "results are shared, not rebuilt");
});

test("decide never rejects: bad input, a throwing isSudo and a missing entry all give the normal verdict", async () => {
  const normal = { verdict: "normal", scope: null, mode: null };
  assert.deepEqual({ ...(await commandPermissions.decide(undefined, undefined)) }, normal);
  assert.deepEqual({ ...(await commandPermissions.decide(null, null, {})) }, normal);
  const pub = registry.getCommandByPattern("zzpub");
  const broken = { isSudo() { throw new Error("boom"); }, isGroup: true, jid: GROUP_A };
  assert.deepEqual({ ...(await commandPermissions.decide(pub, broken)) }, normal);
  // the owner flag passed in wins over a throwing isSudo
  assert.equal((await commandPermissions.decide(pub, broken, { isOwner: true })).verdict, "owner");
  // isOwner omitted: decide asks the message
  const owner = fakes.makeMessage({ body: ".zzpub", ...OWNER });
  assert.equal((await commandPermissions.decide(pub, owner)).verdict, "owner");
  assert.equal((await commandPermissions.decide(pub, owner, { isOwner: false })).verdict, "normal", "an explicit false is honoured");
});

// ---------------------------------------------------------------------------
// FR-006 as a table (steps 2 to 5)
// ---------------------------------------------------------------------------

/**
 * [title, rules, command, who, where, expected]; a rule is [command, scope, mode, people].
 * Scopes: "*" = everywhere, GROUP_A / GROUP_D = that group.
 */
const TABLE = [
  // The owner is never restricted
  ["owner under an everywhere `only` rule with an empty list", [["zzpub", "*", "only", []]], "zzpub", OWNER, GROUP_A, "runs"],
  ["owner (addressed by LID too) under a group `only` rule with an empty list", [["zzpub", GROUP_A, "only", []]], "zzpub", OWNER_VIA_LID, GROUP_A, "runs"],
  ["owner under `only` in a private chat", [["zzpub", "*", "only", [PB]]], "zzpub", OWNER, PRIVATE, "runs"],
  ["owner who is also listed", [["zzpub", "*", "only", [person(IDS.OWNER_PN)]]], "zzpub", OWNER, GROUP_A, "runs"],

  // Listed people
  ["listed in the everywhere rule, in a group", [["zzpub", "*", "only", [PB]]], "zzpub", B, GROUP_A, "runs"],
  ["listed in the everywhere rule, in a private chat (the rule applies there)", [["zzpub", "*", "only", [PB]]], "zzpub", B, PRIVATE, "runs"],
  ["unlisted under the everywhere `only` rule, in a private chat", [["zzpub", "*", "only", [PB]]], "zzpub", C, PRIVATE, "silent"],
  ["listed in the rule of this group", [["zzpub", GROUP_A, "only", [PB]]], "zzpub", B, GROUP_A, "runs"],
  ["unlisted under the `only` rule of this group", [["zzpub", GROUP_A, "only", [PB]]], "zzpub", C, GROUP_A, "silent"],
  ["a group rule is inert in group D", [["zzpub", GROUP_A, "only", [PB]]], "zzpub", C, GROUP_D, "runs"],
  ["a group rule is inert in a private chat", [["zzpub", GROUP_A, "only", [PB]]], "zzpub", C, PRIVATE, "runs"],

  // `extra` leaves the normal level
  ["extra: an unlisted member still runs a public command", [["zzpub", "*", "extra", [PB]]], "zzpub", E, GROUP_A, "runs"],
  ["extra, group rule: listed member runs an owner-only delegable command in the group", [["zzowner", GROUP_A, "extra", [PB]]], "zzowner", B, GROUP_A, "runs"],
  ["extra, group rule: the same member in group D gets owner_only", [["zzowner", GROUP_A, "extra", [PB]]], "zzowner", B, GROUP_D, "owner_only"],
  ["extra, group rule: the same member in a private chat gets owner_only", [["zzowner", GROUP_A, "extra", [PB]]], "zzowner", B, PRIVATE, "owner_only"],
  ["extra: an unlisted member gets owner_only on an owner-only command", [["zzowner", GROUP_A, "extra", [PB]]], "zzowner", C, GROUP_A, "owner_only"],
  ["extra, everywhere rule: listed member runs an owner-only command in group D and in private", [["zzowner", "*", "extra", [PB]]], "zzowner", B, GROUP_D, "runs"],
  ["extra, everywhere rule, private chat", [["zzowner", "*", "extra", [PB]]], "zzowner", B, PRIVATE, "runs"],
  ["extra: an unlisted member still gets sender_not_admin on an admin-only command", [["zzadmin", "*", "extra", [PB]]], "zzadmin", E, GROUP_A, "sender_not_admin"],

  // `only` with an empty list
  ["only with an empty list closes the command to a member", [["zzpub", "*", "only", []]], "zzpub", B, GROUP_A, "silent"],
  ["only with an empty list, group scope: closed here", [["zzpub", GROUP_A, "only", []]], "zzpub", E, GROUP_A, "silent"],
  ["only with an empty list, group scope: normal in group D", [["zzpub", GROUP_A, "only", []]], "zzpub", E, GROUP_D, "runs"],

  // Group mode beats global mode
  ["an empty group `extra` rule restores the normal level against an everywhere `only` rule (US3.3)", [["zzpub", "*", "only", [PB]], ["zzpub", GROUP_A, "extra", []]], "zzpub", C, GROUP_A, "runs"],
  ["... which stays closed in another group", [["zzpub", "*", "only", [PB]], ["zzpub", GROUP_A, "extra", []]], "zzpub", C, GROUP_D, "silent"],
  ["... and the person listed everywhere keeps the pass in group D", [["zzpub", "*", "only", [PB]], ["zzpub", GROUP_A, "extra", []]], "zzpub", B, GROUP_D, "runs"],
  ["a group `only` rule overrides an everywhere `extra` rule for people not listed", [["zzowner", "*", "extra", [PB]], ["zzowner", GROUP_A, "only", [PC]]], "zzowner", E, GROUP_A, "silent"],
  ["... the person listed in the group rule runs", [["zzowner", "*", "extra", [PB]], ["zzowner", GROUP_A, "only", [PC]]], "zzowner", C, GROUP_A, "runs"],
  ["a global pass works inside a group `only` rule", [["zzpub", "*", "extra", [PB]], ["zzpub", GROUP_A, "only", [PC]]], "zzpub", B, GROUP_A, "runs"],
  ["a global `only` pass works inside a group `only` rule too", [["zzpub", "*", "only", [PB]], ["zzpub", GROUP_A, "only", [PC]]], "zzpub", B, GROUP_A, "runs"],
  ["... and the group-listed person runs", [["zzpub", "*", "only", [PB]], ["zzpub", GROUP_A, "only", [PC]]], "zzpub", C, GROUP_A, "runs"],
  ["... and a third person is closed", [["zzpub", "*", "only", [PB]], ["zzpub", GROUP_A, "only", [PC]]], "zzpub", E, GROUP_A, "silent"],
  ["a group `extra` rule overrides an everywhere `only` rule (non-empty list)", [["zzpub", "*", "only", [PB]], ["zzpub", GROUP_A, "extra", [PC]]], "zzpub", E, GROUP_A, "runs"],
];

for (const [title, rules, command, who, where, expected] of TABLE) {
  test(`FR-006: ${title}`, async () => {
    for (const [cmd, scope, mode, people] of rules) await rule(cmd, scope, mode, people);
    assertOutcome(await send(command, who, where), expected, title);
  });
}

test("FR-006: `only` and not listed is silent: no reply, no reaction, no execute, no stats, no bus topic, one log line", async () => {
  await rule("zzpub", "*", "only", [PB]);
  const count = mock.method(stats, "count");
  const topics = [];
  const listeners = Object.values(bus.TOPICS).map((topic) => {
    const fn = (payload) => topics.push([topic, payload]);
    bus.on(topic, fn);
    return [topic, fn];
  });
  const handle = logStart();
  cooldown.reset(E.from, "permlog:zzpub");
  let result;
  try {
    result = await send("zzpub", E, GROUP_A);
  } finally {
    for (const [topic, fn] of listeners) bus.off(topic, fn);
  }
  const lines = logLines(handle, "Silent refusal");

  assert.equal(result.handled, true, "the command is matched, so no other handler sees it");
  assert.deepEqual(result.sock.sent, [], "nothing is sent, not even a reaction");
  assert.deepEqual(result.sock.calls.filter((c) => c.method !== "sendPresenceUpdate"), [], "no other socket call either");
  assert.deepEqual(ran, []);
  assert.deepEqual(count.mock.calls.map((c) => c.arguments[0]).filter((name) => name === "cmd_ok" || name === "cmd_fail"), []);
  assert.deepEqual(topics, []);
  assert.equal(lines.length, 1, "exactly one log line");
  assert.equal(lines[0].level, "info");
  assert.match(lines[0].msg, /Silent refusal \(command permissions\)/);
  assert.match(lines[0].msg, /\.zzpub/);
  assert.match(lines[0].msg, /\[global\]/);
});

test("the silent refusal is logged at info once per sender and command per minute, then at debug", async () => {
  await rule("zzpub", GROUP_A, "only", [PB]);
  cooldown.reset(E.from, "permlog:zzpub");
  cooldown.reset(C.from, "permlog:zzpub");
  const handle = logStart();
  await send("zzpub", E, GROUP_A);
  await send("zzpublic", E, GROUP_A); // another alias, same command
  await send("zzpub", E, GROUP_A);
  await send("zzpub", C, GROUP_A); // another sender: its own first line
  const lines = logLines(handle, "Silent refusal");
  assert.deepEqual(lines.map((line) => line.level), ["info", "debug", "debug", "info"]);
  assert.match(lines[0].msg, /\[group\]/);
});

// ---------------------------------------------------------------------------
// FR-008 / FR-009: a grant opens the owner gate and the admin gate, nothing else
// ---------------------------------------------------------------------------

test("FR-008: granted + onlyGroup in a private chat gives extra.group_cmd", async () => {
  await rule("zzgroup", "*", "extra", [PB]);
  assertOutcome(await send("zzgroup", B, PRIVATE), "group_cmd");
  assertOutcome(await send("zzgroup", B, GROUP_A), "runs");
});

test("FR-008: granted + onlyPm in a group gives common.pm_only", async () => {
  await rule("zzpm", "*", "only", [PB]);
  assertOutcome(await send("zzpm", B, GROUP_A), "pm_only");
  assertOutcome(await send("zzpm", B, PRIVATE), "runs");
});

test("FR-008: a granted person on an adminOnly command in a private chat gets extra.group_cmd", async () => {
  await rule("zzadmin", "*", "extra", [PB]);
  assertOutcome(await send("zzadmin", B, PRIVATE), "group_cmd");
});

test("FR-009: a granted non-admin runs an adminOnly command and isSenderAdmin is never called", async () => {
  for (const mode of ["extra", "only"]) {
    await db.PermissionRule.destroy({ where: {} });
    await rule("zzadmin", GROUP_A, mode, [PB]);
    const message = fakes.makeMessage({ body: ".zzadmin", ...B, group: GROUP_A, admin: false });
    const isSenderAdmin = mock.method(message, "isSenderAdmin");
    const getGroupMetadata = mock.method(message, "getGroupMetadata");
    await registry.executeCommand(message);
    assert.deepEqual(fakes.sentTexts(message.client.getSocket()), ["ran:zzadmin"], mode);
    assert.equal(isSenderAdmin.mock.callCount(), 0, `${mode}: the grant short-circuits before isSenderAdmin()`);
    assert.equal(getGroupMetadata.mock.callCount(), 0, `${mode}: no group-metadata round trip for a fast-path grant`);
  }
});

test("FR-009: a person who is not granted is still checked with isSenderAdmin()", async () => {
  await rule("zzadmin", GROUP_A, "extra", [PB]);
  const message = fakes.makeMessage({ body: ".zzadmin", ...C, group: GROUP_A, admin: false });
  const isSenderAdmin = mock.method(message, "isSenderAdmin");
  await registry.executeCommand(message);
  assert.equal(isSenderAdmin.mock.callCount(), 1);
  assert.deepEqual(fakes.sentTexts(message.client.getSocket()), [getLang("common.sender_not_admin")]);
});

test("FR-009: a real group admin who is not listed still runs an adminOnly command under `extra`", async () => {
  await rule("zzadmin", GROUP_A, "extra", [PB]);
  assertOutcome(await send("zzadmin", C, GROUP_A, { admin: true }), "runs");
});

// ---------------------------------------------------------------------------
// The disabled state (U1)
// ---------------------------------------------------------------------------

test("disabled: a granted person gets common.command_disabled", async () => {
  await rule("zzowner", "*", "extra", [PB]);
  await commandState.set("zzowner", "*", true);
  assertOutcome(await send("zzowner", B, GROUP_A), "disabled");
  assertOutcome(await send("zzboss", B, PRIVATE), "disabled");
});

test("disabled: the owner gets common.command_disabled", async () => {
  await rule("zzpub", "*", "only", [PB]);
  await commandState.set("zzpub", GROUP_A, true);
  assertOutcome(await send("zzpub", OWNER, GROUP_A), "disabled");
  assertOutcome(await send("zzpub", OWNER, GROUP_D), "runs", "disabled only in group A");
});

test("disabled: a closed person is refused in silence, the command is invisible to him (U1)", async () => {
  await rule("zzpub", "*", "only", [PB]);
  await commandState.set("zzpub", "*", true);
  assertOutcome(await send("zzpub", E, GROUP_A), "silent");
  assertOutcome(await send("zzpub", E, PRIVATE), "silent");
  assertOutcome(await send("zzpub", B, GROUP_A), "disabled");
  assertOutcome(await send("zzpub", OWNER, PRIVATE), "disabled");
});

test("disabled: an ungranted person on an owner-only command still gets owner_only first", async () => {
  await rule("zzowner", "*", "extra", [PB]);
  await commandState.set("zzowner", "*", true);
  assertOutcome(await send("zzowner", E, GROUP_A), "owner_only");
});

test("disabled: a refused granted call is counted nowhere; a served one is counted in cmd_ok", async () => {
  await rule("zzpub", "*", "extra", [PB]);
  const count = mock.method(stats, "count");
  const counted = () => count.mock.calls.map((c) => c.arguments.slice(0, 2));
  await commandState.set("zzpub", "*", true);
  assertOutcome(await send("zzpub", B, GROUP_A), "disabled");
  assert.deepEqual(counted(), []);
  await commandState.set("zzpub", "*", false);
  assertOutcome(await send("zzpub", B, GROUP_A), "runs");
  assert.deepEqual(counted(), [["cmd_ok", "zzpub"]]);
});

// ---------------------------------------------------------------------------
// Through the pipeline: the banned chat and stickers bound by setcmd
// ---------------------------------------------------------------------------

function attach() {
  const sock = fakes.fakeSocket();
  const client = fakes.fakeClient(sock);
  pipeline.attachHandlers(client);
  return { sock, client };
}

test("a banned chat gives nothing, whoever is named in a rule; the owner unban still gets through", async () => {
  await rule("zzpub", GROUP_A, "only", [PB]);
  await rule("zzowner", "*", "extra", [PB]);
  await db.BannedChat.create({ jid: GROUP_A });
  settingsCache.invalidate(pipeline.BANNED_CHATS_KEY);

  const { sock, client } = attach();
  await client.dispatch("messages", [fakes.rawMessage({ body: ".zzpub", ...B, group: GROUP_A })], "notify");
  await client.dispatch("messages", [fakes.rawMessage({ body: ".zzowner", ...B, group: GROUP_A })], "notify");
  assert.deepEqual(sock.sent, [], "a person named in a rule gets nothing from a banned chat");
  assert.deepEqual(ran, []);

  await client.dispatch("messages", [fakes.rawMessage({ body: ".unban", ...OWNER, group: GROUP_A })], "notify");
  assert.deepEqual(ran, ["zz-unban.js:unban"], "the owner's unban reaches the registry");
  assert.deepEqual(fakes.sentTexts(sock), ["ran:unban"]);

  // a non-owner unban does not get through, listed or not
  sock.reset();
  ran.length = 0;
  await client.dispatch("messages", [fakes.rawMessage({ body: ".unban", ...B, group: GROUP_A })], "notify");
  assert.deepEqual(sock.sent, []);
  assert.deepEqual(ran, []);
});

const STICKER_SHA = Buffer.from("00112233445566778899aabbccddeeff", "hex");

async function bindSticker(command) {
  await db.StickerCommand.create({ stickerHash: STICKER_SHA.toString("hex"), command, createdBy: IDS.OWNER_PN });
  settingsCache.invalidate(pipeline.STICKER_CMDS_KEY);
}
const stickerFrom = (who, where) => fakes.rawMessage({ sticker: { sha256: STICKER_SHA }, ...who, group: where });

test("stickers bound by setcmd: a granted author runs, a closed author is silent", async () => {
  await bindSticker("zzpub");
  await rule("zzpub", GROUP_A, "only", [PB]);
  const { sock, client } = attach();

  await client.dispatch("messages", [stickerFrom(B, GROUP_A)], "notify");
  assert.deepEqual(fakes.sentTexts(sock), ["ran:zzpub"], "the granted author runs the bound command");

  sock.reset();
  ran.length = 0;
  await client.dispatch("messages", [stickerFrom(E, GROUP_A)], "notify");
  assert.deepEqual(sock.sent, [], "a closed author gets nothing");
  assert.deepEqual(ran, []);

  await client.dispatch("messages", [stickerFrom(E, GROUP_D)], "notify");
  assert.deepEqual(fakes.sentTexts(sock), ["ran:zzpub"], "another group is not affected");
});

test("stickers bound by setcmd: an ungranted author on an owner-only command gets owner_only", async () => {
  await bindSticker("zzowner");
  await rule("zzowner", GROUP_A, "extra", [PB]);
  const { sock, client } = attach();

  await client.dispatch("messages", [stickerFrom(B, GROUP_A)], "notify");
  assert.deepEqual(fakes.sentTexts(sock), ["ran:zzowner"], "the granted author runs it");

  sock.reset();
  ran.length = 0;
  await client.dispatch("messages", [stickerFrom(E, GROUP_A)], "notify");
  assert.deepEqual(fakes.sentTexts(sock), [getLang("common.owner_only")]);
  assert.deepEqual(ran, []);
});

// ---------------------------------------------------------------------------
// Aliases and orphan rows
// ---------------------------------------------------------------------------

test("every alias of a command hits the same rows (keyed by the first alias)", async () => {
  await rule("zzpub", "*", "only", [PB]);
  for (const alias of ["zzpub", "zzpublic", "ZZPUBLIC", "ZzPuB"]) {
    assertOutcome(await send(alias, E, GROUP_A), "silent", alias);
    assertOutcome(await send(alias, B, GROUP_A), "runs", alias);
  }
  // another command is untouched
  assertOutcome(await send("zzpub2", E, GROUP_A), "runs");

  await rule("zzowner", "*", "extra", [PB]);
  assertOutcome(await send("zzboss", B, PRIVATE), "runs", "second alias of an owner-only command");
});

test("an orphan row (unknown command) is inert", async () => {
  await db.PermissionRule.bulkCreate([
    { command: "nosuchcommand", scope: "*", mode: "only", people: [] },
    { command: "nosuchcommand", scope: GROUP_A, mode: "only", people: [PB] },
  ]);
  commandPermissions.invalidate();
  assertOutcome(await send("zzpub", E, GROUP_A), "runs");
  assertOutcome(await send("zzowner", E, GROUP_A), "owner_only");
});

test("a rule keyed by an alias other than the first one is inert (the name is the first alias)", async () => {
  await db.PermissionRule.bulkCreate([{ command: "zzpublic", scope: "*", mode: "only", people: [PB] }]);
  commandPermissions.invalidate();
  assertOutcome(await send("zzpub", E, GROUP_A), "runs");
});

// ---------------------------------------------------------------------------
// SC-003: a rule never opens a non-delegable command
// ---------------------------------------------------------------------------

test("SC-003: decide checks delegable before reading any rule", async () => {
  await rule("zzlocked", "*", "only", [PB]);
  settingsCache.clear();
  const findAll = mock.method(db.PermissionRule, "findAll");
  const message = fakes.makeMessage({ body: ".zzlocked", ...E, group: GROUP_A });

  const locked = registry.getCommandByPattern("zzlocked");
  assert.equal(locked.delegable, false);
  assert.deepEqual({ ...(await commandPermissions.decide(locked, message)) }, { verdict: "normal", scope: null, mode: null });
  const lockedOwner = registry.getCommandByPattern("zzlockedowner");
  assert.equal(lockedOwner.delegable, false, "an owner-only command without the flag is not delegable");
  assert.equal((await commandPermissions.decide(lockedOwner, message)).verdict, "normal");
  assert.equal((await commandPermissions.decide(undefined, message)).verdict, "normal");
  // `delegable` must be exactly true: nothing truthy-looking opens the rules
  assert.equal((await commandPermissions.decide({ name: "zzlocked", delegable: "true" }, message)).verdict, "normal");
  assert.equal((await commandPermissions.decide({ name: "zzlocked", delegable: 1 }, message)).verdict, "normal");
  assert.equal((await commandPermissions.decide({ name: "zzlocked" }, message)).verdict, "normal");
  assert.equal(findAll.mock.callCount(), 0, "no rule, not even the table, is read for a non-delegable command");

  // the same rows do apply to a delegable entry
  assert.equal((await commandPermissions.decide(registry.getCommandByPattern("zzpub"), message)).verdict, "normal");
  await rule("zzpub", "*", "only", [PB]);
  assert.equal((await commandPermissions.decide(registry.getCommandByPattern("zzpub"), message)).verdict, "closed");
});

test("SC-003: a non-delegable probe on a public command is inert under extra and only, global and group", async () => {
  for (const [scope, mode] of [["*", "extra"], ["*", "only"], [GROUP_A, "extra"], [GROUP_A, "only"]]) {
    await db.PermissionRule.destroy({ where: {} });
    await rule("zzlocked", scope, mode, [PB]);
    settingsCache.clear();
    for (const who of [B, C, E]) {
      assertOutcome(await send("zzlocked", who, GROUP_A), "runs", `${scope} ${mode}`);
    }
    // an owner-only probe without the flag: owner_only for everybody, listed or not
    await rule("zzlockedowner", scope, mode, [PB]);
    for (const who of [B, E]) {
      assertOutcome(await send("zzlockedowner", who, GROUP_A), "owner_only", `${scope} ${mode}`);
    }
    assertOutcome(await send("zzlockedowner", OWNER, GROUP_A), "runs");
  }
});

test("SC-003: for each non-delegable real command, rules never open it and never silence it", async () => {
  const setup = await fakes.setup(); // the real plugins replace the probes
  const spied = [];
  for (const entry of setup.commands) {
    entry.execute = async function spy(message, args, ctx) {
      spied.push({ file: entry.file, alias: ctx.command });
    };
  }
  const locked = setup.commands.filter((entry) => entry.delegable === false);
  assert.equal(locked.length, 14, "the 14 never-delegable commands");

  const findAll = mock.method(db.PermissionRule, "findAll");
  const refusal = getLang("common.owner_only");
  const problems = [];
  const combos = [["*", "extra"], ["*", "only"], [GROUP_A, "extra"], [GROUP_A, "only"]];

  for (const [scope, mode] of combos) {
    await db.PermissionRule.destroy({ where: {} });
    await db.PermissionRule.bulkCreate(locked.map((entry) => ({ command: entry.name, scope, mode, people: [PB] })));
    for (const clear of [false, true]) {
      commandPermissions.invalidate();
      if (clear) settingsCache.clear();
      for (const entry of locked) {
        for (const [who, label] of [[B, "listed"], [E, "unlisted"]]) {
          for (const where of [GROUP_A, PRIVATE]) {
            const before = spied.length;
            const message = fakes.makeMessage({ body: `.${entry.name} x`, ...who, group: where === PRIVATE ? undefined : where });
            await setup.registry.executeCommand(message);
            const texts = fakes.sentTexts(message.client.getSocket());
            const what = `${entry.file} ${mode}@${scope} ${label} in ${where}`;
            if (spied.length !== before) problems.push(`${what}: execute was called`);
            else if (texts.length !== 1 || texts[0] !== refusal) problems.push(`${what}: expected exactly common.owner_only, got ${JSON.stringify(texts)}`);
          }
        }
      }
    }
  }
  fakes.assertNone(problems, `over ${locked.length} non-delegable commands`);
  assert.equal(findAll.mock.callCount(), 0, "the table is never read for a non-delegable command");
});

test("SC-003 counterpart: the two delegable real owner commands (vv, save) obey their rules", async () => {
  const setup = await fakes.setup();
  const spied = [];
  for (const entry of setup.commands) {
    entry.execute = async function spy(message, args, ctx) {
      spied.push(`${entry.file}:${ctx.command}`);
    };
  }
  for (const name of ["vv", "save"]) {
    assert.equal(setup.registry.getCommandByPattern(name).delegable, true);
    await db.PermissionRule.destroy({ where: {} });
    await db.PermissionRule.create({ command: name, scope: GROUP_A, mode: "extra", people: [PB] });
    commandPermissions.invalidate();

    spied.length = 0;
    const listed = fakes.makeMessage({ body: `.${name}`, ...B, group: GROUP_A });
    await setup.registry.executeCommand(listed);
    assert.deepEqual(spied, [`${name}.js:${name}`], `${name}: the listed member runs it`);
    assert.deepEqual(fakes.sentTexts(listed.client.getSocket()), []);

    spied.length = 0;
    const unlisted = fakes.makeMessage({ body: `.${name}`, ...E, group: GROUP_A });
    await setup.registry.executeCommand(unlisted);
    assert.deepEqual(spied, []);
    assert.deepEqual(fakes.sentTexts(unlisted.client.getSocket()), [getLang("common.owner_only")]);

    const elsewhere = fakes.makeMessage({ body: `.${name}`, ...B, group: GROUP_D });
    await setup.registry.executeCommand(elsewhere);
    assert.deepEqual(fakes.sentTexts(elsewhere.client.getSocket()), [getLang("common.owner_only")], "the rule is inert in another group");

    // `only` closes it in silence to everybody else
    await db.PermissionRule.update({ mode: "only" }, { where: { command: name } });
    commandPermissions.invalidate();
    const closed = fakes.makeMessage({ body: `.${name}`, ...E, group: GROUP_A });
    await setup.registry.executeCommand(closed);
    assert.deepEqual(closed.client.getSocket().sent, []);
  }
});

// ===========================================================================
// Part 2: identity, cache, loader, fail-open, stored values
// ===========================================================================

/** The log lines (ring entries) written since `logStart()` whose message contains `needle`. */
function logStart() {
  const last = ring.list({ limit: 1 }).at(-1);
  const previous = logger.getLevel();
  logger.setLevel("debug");
  logger.setOutput(() => {});
  return { since: last ? last.seq : 0, previous };
}

function logLines(handle, needle, name) {
  const entries = ring.list({ since: handle.since, limit: 100000 }).filter((entry) => entry.seq > handle.since);
  logger.setLevel(handle.previous);
  logger.setOutput();
  return entries.filter((entry) => entry.msg.includes(needle) && (!name || entry.name === name));
}

// ---------------------------------------------------------------------------
// Identity (FR-004)
// ---------------------------------------------------------------------------

const PN_333 = IDS.MEMBER_PN;
const LID_888 = IDS.MEMBER_LID;

test("identity: a rule stored with the PN only, an author with a LID plus the alt PN", async () => {
  await rule("zzpub", GROUP_A, "only", [person(PN_333, null)]);
  assertOutcome(await send("zzpub", { from: PN_333, lid: true }, GROUP_A), "runs");
  assertOutcome(await send("zzpub", { from: IDS.MEMBER2_PN, lid: true }, GROUP_A), "silent");
});

test("identity: a rule stored with the LID only, an author with a PN plus a LID", async () => {
  await rule("zzpub", GROUP_A, "only", [person(null, LID_888)]);
  assertOutcome(await send("zzpub", { from: PN_333, lid: true }, GROUP_A), "runs");
  assertOutcome(await send("zzpub", { from: IDS.MEMBER2_PN, lid: true }, GROUP_A), "silent");
});

test("identity: a rule stored with both forms matches either one", async () => {
  await rule("zzpub", GROUP_A, "only", [person(PN_333, LID_888)]);
  assertOutcome(await send("zzpub", { from: PN_333 }, GROUP_A), "runs", "PN only author");
  assertOutcome(await send("zzpub", { from: LID_888 }, GROUP_A), "runs", "LID only author");
});

test("identity: a rule with the PN only, a LID-only author resolved through the group participants", async () => {
  await rule("zzpub", GROUP_A, "only", [person(PN_333, null)]);
  const lidOnly = { from: LID_888 }; // no alt: sender === senderLid === the LID
  const message = fakes.makeMessage({ body: ".zzpub", ...lidOnly, group: GROUP_A });
  assert.equal(message.sender, LID_888);
  assert.equal(message.senderLid, LID_888);
  assertOutcome(await send("zzpub", lidOnly, GROUP_A), "runs");
});

test("identity: a rule with the LID only, a PN-only author listed in the group participants", async () => {
  await rule("zzpub", GROUP_A, "only", [person(null, LID_888)]);
  const pnOnly = { from: PN_333 };
  const message = fakes.makeMessage({ body: ".zzpub", ...pnOnly, group: GROUP_A });
  assert.equal(message.senderLid, null);
  assertOutcome(await send("zzpub", pnOnly, GROUP_A), "runs");
});

test("identity: a LID-only author in a private chat is resolved through the LID mapping", async () => {
  await rule("zzpub", "*", "only", [person(PN_333, null)]);
  assertOutcome(await send("zzpub", { from: LID_888 }, PRIVATE), "runs");
});

test("identity: a device suffix on the author or in a hand-made row does not matter", async () => {
  await rule("zzpub", GROUP_A, "only", [person(PN_333, null)]);
  assertOutcome(await send("zzpub", { from: "333:7@s.whatsapp.net" }, GROUP_A), "runs", "author with :7");
  await db.PermissionRule.destroy({ where: {} });
  await db.PermissionRule.bulkCreate([
    { command: "zzpub", scope: GROUP_A, mode: "only", people: [{ pn: "333:7@s.whatsapp.net", lid: null }] },
  ]);
  commandPermissions.invalidate();
  assertOutcome(await send("zzpub", { from: PN_333 }, GROUP_A), "runs", "row with :7");
  assertOutcome(await send("zzpub", { from: "333:12@s.whatsapp.net" }, GROUP_A), "runs", "both with a suffix");
});

test("identity: an unknown LID is not granted", async () => {
  const stranger = { from: "999999@lid" };
  await rule("zzpub", GROUP_A, "only", [person(PN_333, null)]);
  assertOutcome(await send("zzpub", stranger, GROUP_A), "silent");
  await db.PermissionRule.destroy({ where: {} });
  await rule("zzowner", GROUP_A, "extra", [person(PN_333, null)]);
  assertOutcome(await send("zzowner", stranger, GROUP_A), "owner_only");
  assertOutcome(await send("zzowner", stranger, PRIVATE), "owner_only");
});

test("identity: a person on another number is not mistaken for a listed one", async () => {
  await rule("zzpub", GROUP_A, "only", [person(PN_333, LID_888)]);
  assertOutcome(await send("zzpub", { from: "3330@s.whatsapp.net" }, GROUP_A), "silent");
  assertOutcome(await send("zzpub", { from: "33@s.whatsapp.net" }, GROUP_A), "silent");
});

/** A fresh group message with a spy on getGroupMetadata. */
function spiedMessage(who, where = GROUP_A) {
  const message = fakes.makeMessage({ body: ".zzpub", ...who, group: where === PRIVATE ? undefined : where });
  const spy = mock.method(message, "getGroupMetadata");
  return { message, spy };
}

test("identity: the slow path runs once per message across many commands", async () => {
  for (const command of ["zzpub", "zzpub2", "zzowner", "zzadmin", "zzgroup"]) {
    await rule(command, GROUP_A, "only", [person(PN_333, null)]);
  }
  const { message, spy } = spiedMessage({ from: LID_888 }); // LID-only: the slow path is needed
  for (const entry of registry.getCommands()) await commandPermissions.decide(entry, message);
  const delegable = registry.getCommands().filter((entry) => entry.delegable);
  assert.ok(delegable.length >= 5);
  assert.equal(spy.mock.callCount(), 1, "one resolution for the whole message");
  // and the results are right
  const pub = registry.getCommandByPattern("zzpub");
  assert.equal((await commandPermissions.decide(pub, message)).verdict, "granted");
  assert.equal(spy.mock.callCount(), 1);
});

test("identity: the slow path is not taken when the message carries both namespaces", async () => {
  await rule("zzpub", GROUP_A, "only", [person(IDS.MEMBER2_PN, null)]);
  const { message, spy } = spiedMessage({ from: PN_333, lid: true });
  assert.equal((await commandPermissions.decide(registry.getCommandByPattern("zzpub"), message)).verdict, "closed");
  assert.equal(spy.mock.callCount(), 0);
});

test("identity: the slow path is not taken without a non-empty applicable rule", async () => {
  const pub = registry.getCommandByPattern("zzpub");
  const idle = async (label) => {
    const { message, spy } = spiedMessage({ from: PN_333 }); // PN only: it would need the slow path
    await commandPermissions.decide(pub, message);
    assert.equal(spy.mock.callCount(), 0, label);
  };
  await idle("no rule at all");
  await rule("zzpub", GROUP_A, "extra", []);
  await idle("an empty group extra rule");
  await rule("zzpub", "*", "only", []);
  await idle("an empty everywhere only rule");
  await rule("zzpub", GROUP_D, "only", [PC]);
  await idle("a non-empty rule of another group");
  await rule("zzpub2", GROUP_A, "only", [PC]);
  await idle("a non-empty rule of another command");
});

test("identity: the slow path is not taken for a non-delegable command or for the owner", async () => {
  await rule("zzpub", GROUP_A, "only", [PC]);
  const { message, spy } = spiedMessage({ from: LID_888 });
  await commandPermissions.decide(registry.getCommandByPattern("zzlocked"), message);
  const owner = spiedMessage(OWNER);
  await commandPermissions.decide(registry.getCommandByPattern("zzpub"), owner.message);
  assert.equal(spy.mock.callCount(), 0);
  assert.equal(owner.spy.mock.callCount(), 0);
});

test("identity: a failing group-metadata lookup means not listed, never an error", async () => {
  await rule("zzpub", GROUP_A, "only", [person(PN_333, null)]);
  const message = fakes.makeMessage({ body: ".zzpub", from: LID_888, group: GROUP_A });
  mock.method(message, "getGroupMetadata", async () => {
    throw new Error("metadata is down");
  });
  assert.equal((await commandPermissions.decide(registry.getCommandByPattern("zzpub"), message)).verdict, "closed");
});

// ---------------------------------------------------------------------------
// Cache and invalidation (FR-010, SC-005)
// ---------------------------------------------------------------------------

test("cache: a write plus invalidate() changes the next message, a removal too, without a restart", async () => {
  assertOutcome(await send("zzpub", E, GROUP_A), "runs", "no rule yet");

  await db.PermissionRule.create({ command: "zzpub", scope: GROUP_A, mode: "only", people: [PB] });
  assertOutcome(await send("zzpub", E, GROUP_A), "runs", "the 5-minute cache still holds the old state");
  commandPermissions.invalidate();
  assertOutcome(await send("zzpub", E, GROUP_A), "silent", "the very next message after invalidate()");
  assertOutcome(await send("zzpub", B, GROUP_A), "runs");

  await db.PermissionRule.update({ people: [PB, PC] }, { where: { command: "zzpub", scope: GROUP_A } });
  commandPermissions.invalidate();
  assertOutcome(await send("zzpub", C, GROUP_A), "runs", "a person added");

  await db.PermissionRule.destroy({ where: { command: "zzpub", scope: GROUP_A } });
  commandPermissions.invalidate();
  assertOutcome(await send("zzpub", E, GROUP_A), "runs", "the rule removed");
});

test("cache: settingsCache.clear() rebuilds the state (restore, in-process restart)", async () => {
  await rule("zzpub", "*", "only", [PB]);
  assertOutcome(await send("zzpub", E, GROUP_A), "silent");
  await db.PermissionRule.destroy({ where: {} }); // a restore wiped the table behind the cache
  assertOutcome(await send("zzpub", E, GROUP_A), "silent", "still cached");
  settingsCache.clear();
  assertOutcome(await send("zzpub", E, GROUP_A), "runs");
});

test("cache: a warm cache issues zero findAll (SC-005)", async () => {
  await rule("zzpub", "*", "only", [PB]);
  settingsCache.clear();
  const findAll = mock.method(db.PermissionRule, "findAll");
  for (let i = 0; i < 25; i++) {
    await send("zzpub", i % 2 ? B : E, i % 3 ? GROUP_A : PRIVATE);
    await send("zzowner", E, GROUP_A);
  }
  assert.equal(findAll.mock.callCount(), 1, "one load for the whole run");
});

test("cache: concurrent cold decisions share one findAll", async () => {
  await rule("zzpub", "*", "only", [PB]);
  settingsCache.clear();
  const findAll = mock.method(db.PermissionRule, "findAll");
  const pub = registry.getCommandByPattern("zzpub");
  const verdicts = await Promise.all(
    Array.from({ length: 20 }, () => commandPermissions.decide(pub, fakes.makeMessage({ body: ".zzpub", ...E, group: GROUP_A }))),
  );
  assert.ok(verdicts.every((access) => access.verdict === "closed"));
  assert.equal(findAll.mock.callCount(), 1);
});

test("cache: 500 rules x 1,000 decisions stay under a loose time bound (SC-005)", async () => {
  const people = Array.from({ length: 20 }, (_, i) => person(`2377000${String(i).padStart(5, "0")}@s.whatsapp.net`));
  const rows = [];
  for (let i = 0; i < 500; i++) {
    rows.push({ command: `cmd${i}`, scope: i % 2 ? "*" : GROUP_A, mode: i % 3 ? "only" : "extra", people });
  }
  await db.PermissionRule.bulkCreate(rows);
  commandPermissions.invalidate();

  const entries = Array.from({ length: 500 }, (_, i) => ({ name: `cmd${i}`, delegable: true }));
  const message = fakes.makeMessage({ body: ".cmd1", ...E, group: GROUP_A });
  const findAll = mock.method(db.PermissionRule, "findAll");

  const started = performance.now();
  let closed = 0;
  for (let i = 0; i < 1000; i++) {
    const access = await commandPermissions.decide(entries[i % 500], message);
    if (access.verdict === "closed") closed++;
  }
  const elapsed = performance.now() - started;

  assert.ok(closed > 0, "the rules are really applied");
  assert.equal(findAll.mock.callCount(), 1);
  assert.ok(elapsed < 2000, `1,000 decisions took ${Math.round(elapsed)} ms`);
});

test("cache: a load started before an invalidate() does not store its result", async () => {
  await rule("zzpub", "*", "only", [PB]);
  settingsCache.clear();
  const realFindAll = db.PermissionRule.findAll.bind(db.PermissionRule);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  mock.method(db.PermissionRule, "findAll", async (...args) => {
    calls++;
    if (calls === 1) {
      await gate; // the slow load of the OLD state
      return [];
    }
    return realFindAll(...args);
  });

  const pub = registry.getCommandByPattern("zzpub");
  const first = commandPermissions.decide(pub, fakes.makeMessage({ body: ".zzpub", ...E, group: GROUP_A }));
  await new Promise((resolve) => setImmediate(resolve)); // the first load is in flight
  commandPermissions.invalidate(); // a panel write lands meanwhile
  release();
  assert.equal((await first).verdict, "normal", "the stale load answers its own caller");

  const next = await commandPermissions.decide(pub, fakes.makeMessage({ body: ".zzpub", ...E, group: GROUP_A }));
  assert.equal(next.verdict, "closed", "the stale result was not stored: the next message sees the row");
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------------------
// Loader contract (1.3)
// ---------------------------------------------------------------------------

test("loader: a row with an unknown mode, a non-group scope or an unparsable people string is skipped, one warn per load", async () => {
  await db.PermissionRule.bulkCreate([
    { command: "zzpub", scope: GROUP_A, mode: "all", people: [PB] }, // unknown mode
    { command: "zzpub", scope: "not-a-group", mode: "only", people: [PB] }, // bad scope
    { command: "zzpub", scope: "237690000001@s.whatsapp.net", mode: "only", people: [PB] }, // a person, not a group
    { command: "zzpub2", scope: "*", mode: "only", people: "this is not json" }, // unparsable string
    { command: "zzowner", scope: "*", mode: "extra", people: { pn: PN_333 } }, // not an array
    { command: "zzadmin", scope: "*", mode: "only", people: [PB] }, // a good row
  ]);
  commandPermissions.invalidate();
  const handle = logStart();
  assertOutcome(await send("zzpub", E, GROUP_A), "runs", "unknown mode and bad scopes are skipped, not applied");
  assertOutcome(await send("zzpub2", E, GROUP_A), "runs", "an unparsable people string skips the row");
  assertOutcome(await send("zzowner", B, GROUP_A), "owner_only", "a non-array people skips the row");
  assertOutcome(await send("zzadmin", E, GROUP_A, { admin: true }), "silent", "the good row still applies");
  const warns = logLines(handle, "", "commandPermissions").filter((entry) => entry.level === "warn");
  assert.equal(warns.length, 1, `one warn for the load, never one per row (got ${warns.length})`);
});

test("loader: a people JSON string is parsed", async () => {
  await db.PermissionRule.bulkCreate([
    { command: "zzpub", scope: GROUP_A, mode: "only", people: JSON.stringify([PB]) },
  ]);
  commandPermissions.invalidate();
  assertOutcome(await send("zzpub", B, GROUP_A), "runs");
  assertOutcome(await send("zzpub", E, GROUP_A), "silent");
});

test("loader: elements that normalize to nothing are dropped; the row stays", async () => {
  await db.PermissionRule.bulkCreate([
    {
      command: "zzpub",
      scope: GROUP_A,
      mode: "only",
      people: [{ pn: null, lid: null }, { pn: "", lid: "" }, "garbage", 42, null, ["x"], { pn: PN_333, lid: null }],
    },
  ]);
  commandPermissions.invalidate();
  assertOutcome(await send("zzpub", B, GROUP_A), "runs", "the good element is kept");
  assertOutcome(await send("zzpub", E, GROUP_A), "silent");
});

test("loader: an `only` row left with no usable member closes the command to everybody but the owners", async () => {
  await db.PermissionRule.bulkCreate([
    { command: "zzpub", scope: "*", mode: "only", people: [{ pn: null, lid: null }, "garbage"] },
  ]);
  commandPermissions.invalidate();
  assertOutcome(await send("zzpub", B, GROUP_A), "silent");
  assertOutcome(await send("zzpub", OWNER, GROUP_A), "runs");
});

test("loader: the command name is trimmed and lower-cased", async () => {
  await db.PermissionRule.bulkCreate([{ command: "  ZZPUB ", scope: "*", mode: "only", people: [PB] }]);
  commandPermissions.invalidate();
  assertOutcome(await send("zzpub", E, GROUP_A), "silent");
  assertOutcome(await send("zzpub", B, GROUP_A), "runs");
});

test("loader: a group scope is normalized (case of the server)", async () => {
  await db.PermissionRule.bulkCreate([{ command: "zzpub", scope: GROUP_A.replace("@g.us", "@G.US"), mode: "only", people: [PB] }]);
  commandPermissions.invalidate();
  assertOutcome(await send("zzpub", E, GROUP_A), "silent");
});

test("loader: model instances are used, never raw (a SQLite JSON column is a string with raw)", async () => {
  await rule("zzpub", "*", "only", [PB]);
  settingsCache.clear();
  const findAll = mock.method(db.PermissionRule, "findAll");
  assertOutcome(await send("zzpub", B, GROUP_A), "runs");
  assert.equal(findAll.mock.callCount(), 1);
  const options = findAll.mock.calls[0].arguments[0] || {};
  assert.notEqual(options.raw, true, "findAll({ raw: true }) would hand back people as a string");
  // and the model really hands back an array through instances
  const row = await db.PermissionRule.findOne({ where: { command: "zzpub" } });
  assert.ok(Array.isArray(row.people));
});

test("loader: delegable is not applied at load; a rule on a non-delegable name is stored but never used", async () => {
  await db.PermissionRule.bulkCreate([{ command: "zzlocked", scope: "*", mode: "only", people: [PB] }]);
  commandPermissions.invalidate();
  assertOutcome(await send("zzlocked", E, GROUP_A), "runs");
});

// ---------------------------------------------------------------------------
// Fail-open (FR-011)
// ---------------------------------------------------------------------------

test("fail-open: a cold cache and a failing findAll keep owner-only commands owner-only, `only` is not applied, nothing throws", async () => {
  await rule("zzpub", "*", "only", [PB]);
  await rule("zzowner", "*", "extra", [PB]);
  settingsCache.clear();
  mock.method(db.PermissionRule, "findAll", async () => {
    throw new Error("database is down");
  });
  assertOutcome(await send("zzpub", E, GROUP_A), "runs", "`only` is not applied");
  assertOutcome(await send("zzpub", E, PRIVATE), "runs");
  assertOutcome(await send("zzowner", B, GROUP_A), "owner_only", "a grant is not applied: owner-only stays owner-only");
  assertOutcome(await send("zzowner", E, GROUP_A), "owner_only");
  assertOutcome(await send("zzowner", OWNER, GROUP_A), "runs", "the owner is never affected");
  assertOutcome(await send("zzadmin", E, GROUP_A, { admin: false }), "sender_not_admin");

  // the database is back: the rules apply again as soon as the cache is renewed
  mock.restoreAll();
  settingsCache.clear();
  assertOutcome(await send("zzpub", E, GROUP_A), "silent");
  assertOutcome(await send("zzowner", B, GROUP_A), "runs");
});

test("fail-open: a warm cache and a failing reload keep the last state", async () => {
  await rule("zzpub", "*", "only", [PB]);
  assertOutcome(await send("zzpub", E, GROUP_A), "silent"); // warm
  // make the cached state look expired, then break the reload
  settingsCache.cache.get(CACHE_KEY).timestamp = 0;
  mock.method(db.PermissionRule, "findAll", async () => {
    throw new Error("database is down");
  });
  assertOutcome(await send("zzpub", E, GROUP_A), "silent", "the expired state is kept");
  assertOutcome(await send("zzpub", B, GROUP_A), "runs");
});

test("fail-open: a missing model (TypeError) is a failed load, not an error", async () => {
  await rule("zzpub", "*", "only", [PB]);
  settingsCache.clear();
  mock.method(db.PermissionRule, "findAll", () => {
    throw new TypeError("findAll is not a function");
  });
  assertOutcome(await send("zzpub", E, GROUP_A), "runs");
});

// ---------------------------------------------------------------------------
// No rule: nothing changes (SC-004)
// ---------------------------------------------------------------------------

test("SC-004: with no rule the registry gives today's answers", async () => {
  assertOutcome(await send("zzpub", E, GROUP_A), "runs");
  assertOutcome(await send("zzowner", E, GROUP_A), "owner_only");
  assertOutcome(await send("zzowner", OWNER, GROUP_A), "runs");
  assertOutcome(await send("zzadmin", E, GROUP_A, { admin: false }), "sender_not_admin");
  assertOutcome(await send("zzadmin", E, PRIVATE), "group_cmd");
  assertOutcome(await send("zzgroup", E, PRIVATE), "group_cmd");
  assertOutcome(await send("zzpm", E, GROUP_A), "pm_only");
  assertOutcome(await send("zzlocked", E, GROUP_A), "runs");
  assertOutcome(await send("zzlockedowner", E, GROUP_A), "owner_only");
});

test("SC-004: a call with no rule writes no silent-refusal line", async () => {
  const handle = logStart();
  await send("zzpub", E, GROUP_A);
  await send("zzowner", E, GROUP_A);
  assert.deepEqual(logLines(handle, "Silent refusal"), []);
});

// ---------------------------------------------------------------------------
// Stored values: the model repeats the engine literals (it cannot import them)
// ---------------------------------------------------------------------------

test("the engine's MODES and MAX_PEOPLE equal the PermissionRule validators", async () => {
  const isIn = db.PermissionRule.rawAttributes.mode.validate.isIn;
  assert.deepEqual([...isIn[0]].sort(), Object.values(MODES).sort());

  const base = { command: "zzpub", scope: "*", mode: "extra" };
  const exactly = Array.from({ length: MAX_PEOPLE }, (_, i) => person(`2376900${String(i).padStart(5, "0")}@s.whatsapp.net`));
  await db.PermissionRule.build({ ...base, people: exactly }).validate();
  await assert.rejects(
    db.PermissionRule.build({ ...base, people: [...exactly, person("237699999999@s.whatsapp.net")] }).validate(),
    /at most/,
  );
  for (const mode of Object.values(MODES)) await db.PermissionRule.build({ ...base, mode, people: [] }).validate();
  await assert.rejects(db.PermissionRule.build({ ...base, mode: "all", people: [] }).validate());
  assert.equal(GLOBAL_SCOPE, db.PermissionRule.rawAttributes.scope.defaultValue, "the default scope is the everywhere scope");
});
