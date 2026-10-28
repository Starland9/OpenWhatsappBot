"use strict";
/**
 * SC-013 (specs/002-admin-panel T120): the registry refuses a command the panel disabled.
 *
 *  - disabled in group A: refused in A from the very next message, served in group B and in private chat
 *    (100 generated cases); a global disable refuses everywhere and wins over an enable in a group;
 *  - owners are refused too, and every alias of the command;
 *  - a sticker bound by `setcmd` (pipeline step 7) goes through the same check;
 *  - the check sits after the owner gate and before onlyGroup/onlyPm/adminOnly (no isSenderAdmin() round trip);
 *  - the reply is `common.command_disabled`; a refused call is counted in neither `cmd_ok` nor `cmd_fail`;
 *  - the state survives `settingsCache.clear()` and a fresh registry; `onMessage` hooks keep running;
 *  - fail-open when the state cannot be loaded.
 *
 * Only test plugins are registered (registry reset), so the result does not depend on the real plugins.
 */

const { test, before, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");
const { applyBotFragments } = require("./helpers/botFragments");

const { IDS } = fakes;
fakes.setupEnv({ sudo: "111" });

const registry = require("../lib/plugins/registry");
const commandState = require("../lib/utils/commandState");
const pipeline = require("../lib/core/pipeline");
const settingsCache = require("../lib/utils/settingsCache");
const stats = require("../lib/utils/stats");
const { getLang } = require("../lib/utils/language");

const GROUP_A = "120363000000000001@g.us";
const GROUP_B = "120363000000000002@g.us";
const PRIVATE_CHAT = IDS.MEMBER_PN;

let db;
const ran = []; // "<file>:<alias>" recorded by the probes

before(async () => {
  db = await fakes.syncDb();
  applyBotFragments(); // common.command_disabled, until the W2-A merge puts it in lang/*.json
});

beforeEach(async () => {
  await db.CommandState.destroy({ where: {} });
  settingsCache.clear();
  ran.length = 0;
  registry._reset();
  for (const [file, plugin] of Object.entries(probes())) registry.registerPlugin(plugin, file);
});

afterEach(() => {
  mock.restoreAll();
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
    "zz-one.js": probe("zz-one.js", { pattern: "zzone|zzuno" }),
    "zz-two.js": probe("zz-two.js", { pattern: "zztwo" }),
    "zz-three.js": probe("zz-three.js", { pattern: "zzthree|zz3" }),
    "zz-owner.js": probe("zz-owner.js", { pattern: "zzowner", ownerOnly: true }),
    "zz-admin.js": probe("zz-admin.js", { pattern: "zzadmin", adminOnly: true }),
    "zz-group.js": probe("zz-group.js", { pattern: "zzgroup", onlyGroup: true }),
    "zz-pm.js": probe("zz-pm.js", { pattern: "zzpm", onlyPm: true }),
  };
}

const DISABLED = () => getLang("common.command_disabled");

/** Send `.alias` as `from`, in `where` ("private" or a group JID); returns { texts, message }. */
async function send(alias, { from = IDS.MEMBER_PN, where = "private", admin } = {}) {
  const message = fakes.makeMessage({
    body: `.${alias}`,
    from,
    group: where === "private" ? undefined : where,
    admin,
  });
  const handled = await registry.executeCommand(message);
  return { handled, message, texts: fakes.sentTexts(message.client.getSocket()) };
}

const disabledReply = (result) => assert.deepEqual(result.texts, [DISABLED()]);

test("the reply key is common.command_disabled, translated (not a raw key)", async () => {
  assert.notEqual(DISABLED(), "common.command_disabled", "common.command_disabled is missing from the language files");
  await commandState.set("zzone", "*", true);
  const result = await send("zzone");
  assert.equal(result.handled, true, "a refused command still counts as matched");
  disabledReply(result);
  assert.deepEqual(ran, []);
});

test("SC-013: disabled in group A, refused in A from the very next message, served in B and in private (100 cases)", async () => {
  const cases = [];
  let seed = 20260428;
  const next = (n) => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed % n;
  };
  const commandNames = [
    ["zzone", ["zzone", "zzuno"]],
    ["zztwo", ["zztwo"]],
    ["zzthree", ["zzthree", "zz3"]],
  ];
  const senders = [IDS.MEMBER_PN, IDS.MEMBER2_PN, IDS.OWNER_PN];
  for (let i = 0; i < 100; i++) {
    const [name, aliases] = commandNames[next(commandNames.length)];
    cases.push({
      name,
      alias: aliases[next(aliases.length)],
      sender: senders[next(senders.length)],
      disabledIn: next(2) === 0 ? GROUP_A : GROUP_B,
    });
  }

  let refused = 0;
  let served = 0;
  for (const { name, alias, sender, disabledIn } of cases) {
    const other = disabledIn === GROUP_A ? GROUP_B : GROUP_A;
    ran.length = 0;
    await commandState.set(name, disabledIn, true);

    // the very next message, no waiting and no cache clearing
    disabledReply(await send(alias, { from: sender, where: disabledIn }));
    assert.deepEqual(ran, [], `${alias} ran in the group where ${name} is disabled`);
    refused++;

    for (const where of [other, "private"]) {
      const result = await send(alias, { from: sender, where });
      assert.deepEqual(result.texts, [`ran:${alias}`], `${alias} must work in ${where} while ${name} is disabled in ${disabledIn}`);
      served++;
    }

    // back on: the very next message works again
    await commandState.set(name, disabledIn, false);
    assert.deepEqual((await send(alias, { from: sender, where: disabledIn })).texts, [`ran:${alias}`]);
  }
  assert.equal(refused, 100);
  assert.equal(served, 200);
});

test("a global disable refuses everywhere and wins over an enable in a group", async () => {
  await commandState.set("zztwo", "*", true);
  for (const where of [GROUP_A, GROUP_B, "private"]) disabledReply(await send("zztwo", { where }));

  // enabling in a group does not undo the global row; a group row does not either once global is set
  await commandState.set("zztwo", GROUP_A, false);
  disabledReply(await send("zztwo", { where: GROUP_A }));
  await commandState.set("zztwo", GROUP_A, true);
  await commandState.set("zztwo", "*", false);
  disabledReply(await send("zztwo", { where: GROUP_A }));
  assert.deepEqual((await send("zztwo", { where: GROUP_B })).texts, ["ran:zztwo"]);
  assert.deepEqual((await send("zztwo", { where: "private" })).texts, ["ran:zztwo"]);
  assert.deepEqual(ran, ["zz-two.js:zztwo", "zz-two.js:zztwo"]);
});

test("the owner is refused too", async () => {
  await commandState.set("zzone", GROUP_A, true);
  disabledReply(await send("zzone", { from: IDS.OWNER_PN, where: GROUP_A }));
  await commandState.set("zzone", "*", true);
  disabledReply(await send("zzone", { from: IDS.OWNER_PN, where: "private" }));
  disabledReply(await send("zzone", { from: IDS.OWNER_LID, where: GROUP_B }));
  assert.deepEqual(ran, []);
});

test("every alias is refused (the row is keyed by the first alias)", async () => {
  await commandState.set("zzone", "*", true);
  for (const alias of ["zzone", "zzuno", "ZZUNO", "ZzOnE"]) disabledReply(await send(alias));
  assert.deepEqual(ran, []);
  // a command that is not disabled is untouched
  assert.deepEqual((await send("zz3")).texts, ["ran:zz3"]);
});

test("the check sits after the owner gate: a non-owner still gets common.owner_only, the owner is refused", async () => {
  await commandState.set("zzowner", "*", true);
  assert.deepEqual((await send("zzowner", { from: IDS.MEMBER_PN })).texts, [getLang("common.owner_only")]);
  disabledReply(await send("zzowner", { from: IDS.OWNER_PN }));
  assert.deepEqual(ran, []);
});

test("the check sits before onlyGroup, onlyPm and adminOnly", async () => {
  await commandState.set("zzgroup", "*", true);
  await commandState.set("zzpm", "*", true);
  await commandState.set("zzadmin", "*", true);

  // used in private, an onlyGroup command says "disabled", not "group only"
  disabledReply(await send("zzgroup", { where: "private" }));
  // used in a group, an onlyPm command says "disabled", not "pm only"
  disabledReply(await send("zzpm", { where: GROUP_A }));
  // a non-admin calling a disabled adminOnly command: "disabled", and no admin lookup at all
  const message = fakes.makeMessage({ body: ".zzadmin", from: IDS.MEMBER_PN, group: GROUP_A, admin: false });
  const isSenderAdmin = mock.method(message, "isSenderAdmin");
  await registry.executeCommand(message);
  assert.equal(isSenderAdmin.mock.callCount(), 0, "a disabled command must skip isSenderAdmin()");
  disabledReply({ texts: fakes.sentTexts(message.client.getSocket()) });

  // the same commands, enabled, keep their own refusals
  await commandState.set("zzgroup", "*", false);
  await commandState.set("zzpm", "*", false);
  await commandState.set("zzadmin", "*", false);
  assert.deepEqual((await send("zzgroup", { where: "private" })).texts, [getLang("extra.group_cmd")]);
  assert.deepEqual((await send("zzpm", { where: GROUP_A })).texts, [getLang("common.pm_only")]);
  assert.deepEqual((await send("zzadmin", { where: GROUP_A, admin: false })).texts, [getLang("common.sender_not_admin")]);
});

test("a refused call is counted in neither cmd_ok nor cmd_fail; a served call is counted in cmd_ok", async () => {
  const count = mock.method(stats, "count");
  const counted = () => count.mock.calls.map((c) => c.arguments.slice(0, 2));

  await commandState.set("zzone", "*", true);
  disabledReply(await send("zzuno"));
  assert.deepEqual(counted(), []);

  assert.deepEqual((await send("zztwo")).texts, ["ran:zztwo"]);
  assert.deepEqual(counted(), [["cmd_ok", "zztwo"]]);
});

test("the disable survives settingsCache.clear() and a fresh registry", async () => {
  await commandState.set("zzone", GROUP_A, true);

  settingsCache.clear();
  disabledReply(await send("zzone", { where: GROUP_A }));

  registry._reset();
  for (const [file, plugin] of Object.entries(probes())) registry.registerPlugin(plugin, file);
  settingsCache.clear();
  disabledReply(await send("zzuno", { where: GROUP_A }));
  assert.deepEqual((await send("zzone", { where: GROUP_B })).texts, ["ran:zzone"]);
});

test("fail-open: when the state cannot be loaded, nothing is disabled", async () => {
  await commandState.set("zzone", "*", true);
  settingsCache.clear();
  mock.method(db.CommandState, "findAll", async () => {
    throw new Error("database is down");
  });
  assert.deepEqual((await send("zzone")).texts, ["ran:zzone"]);
  assert.deepEqual((await send("zzone", { where: GROUP_A })).texts, ["ran:zzone"]);

  // the database is back: the row applies again as soon as the cache is renewed
  mock.restoreAll();
  settingsCache.clear();
  disabledReply(await send("zzone"));
});

// ---------------------------------------------------------------------------
// Through the pipeline
// ---------------------------------------------------------------------------

function attach() {
  const sock = fakes.fakeSocket();
  const client = fakes.fakeClient(sock);
  pipeline.attachHandlers(client);
  return { sock, client };
}

test("a sticker bound by setcmd goes through the same check (pipeline step 7)", async () => {
  const sha = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  await db.StickerCommand.create({ stickerHash: sha.toString("hex"), command: "zzuno", createdBy: IDS.OWNER_PN });
  settingsCache.invalidate(pipeline.STICKER_CMDS_KEY);

  const { sock, client } = attach();
  const sticker = () => fakes.rawMessage({ sticker: { sha256: sha }, from: IDS.MEMBER_PN, group: GROUP_A });

  await client.dispatch("messages", [sticker()], "notify");
  assert.deepEqual(fakes.sentTexts(sock), ["ran:zzuno"], "the bound command runs while it is enabled");

  sock.reset();
  await commandState.set("zzone", GROUP_A, true);
  await client.dispatch("messages", [sticker()], "notify");
  assert.deepEqual(fakes.sentTexts(sock), [DISABLED()], "the sticker must not bypass the disable");

  sock.reset();
  await client.dispatch("messages", [fakes.rawMessage({ sticker: { sha256: sha }, from: IDS.MEMBER_PN, group: GROUP_B })], "notify");
  assert.deepEqual(fakes.sentTexts(sock), ["ran:zzuno"], "another group is not affected");

  await db.StickerCommand.destroy({ where: {} });
  settingsCache.invalidate(pipeline.STICKER_CMDS_KEY);
});

test("onMessage hooks keep running for a disabled command", async () => {
  const hooked = [];
  registry._reset();
  registry.registerPlugin(
    probe("zz-hooked.js", { pattern: "zzhooked" }, {
      async onMessage(message) {
        hooked.push(message.body);
        return false;
      },
    }),
    "zz-hooked.js",
  );
  await commandState.set("zzhooked", "*", true);

  const { sock, client } = attach();
  await client.dispatch("messages", [fakes.rawMessage({ body: ".zzhooked now", from: IDS.MEMBER_PN })], "notify");
  assert.deepEqual(hooked, [".zzhooked now"], "the hook of a disabled command still sees the message");
  assert.deepEqual(fakes.sentTexts(sock), [DISABLED()]);
  assert.deepEqual(ran, []);
});
