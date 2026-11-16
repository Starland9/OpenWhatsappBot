"use strict";
/**
 * `.takeover` (plugins/takeover.js): taking control of a group.
 *
 * WhatsApp only lets an administrator change group settings, so the command escalates first:
 *   1. the bot is already admin            -> the lock runs straight away;
 *   2. the bot is not admin but promotable -> it promotes itself, then locks;
 *   3. the bot cannot be promoted          -> the group is cloned (the bot becomes creator), then locked.
 * Nobody has to be an admin to type the command: only the bot's rank matters.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });
const net = fakes.stubNetwork();

const { getLang } = require("../lib/utils/language");

let registry;

before(async () => {
  const setup = await fakes.setup();
  registry = setup.registry;
});

after(() => {
  net.restore();
});

/** Run `.takeover [args]` in a group as `who` (owner by default) and return the fake socket. */
async function run(args = "", { who = fakes.IDS.OWNER_PN, ...opts } = {}) {
  const sock = fakes.fakeSocket(opts);
  const message = fakes.makeMessage({ body: `.takeover${args ? ` ${args}` : ""}`, group: true, from: who, sock });
  await registry.executeCommand(message);
  return sock;
}

const texts = (sock) => fakes.sentTexts(sock);
const methods = (sock) => sock.calls.map((call) => call.method);

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

test("takeover: a plain member can run it when the bot is admin", async () => {
  const sock = await run("", { who: fakes.IDS.MEMBER_PN, botAdmin: true });
  assert.ok(texts(sock).some((text) => text.includes(getLang("plugins.takeover.title"))));
  assert.ok(methods(sock).includes("groupSettingUpdate"));
});

test("takeover: refused outside a group", async () => {
  const sock = fakes.fakeSocket({ botAdmin: true });
  const message = fakes.makeMessage({ body: ".takeover", group: false, sock });
  await registry.executeCommand(message);
  assert.deepEqual(texts(sock), [getLang("extra.group_cmd")]);
});

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

test("takeover: the bot is admin, nothing is promoted", async () => {
  const sock = await run("", { botAdmin: true });
  assert.equal(sock.participantUpdates.filter((u) => u.action === "promote").length, 0);
  assert.ok(!texts(sock).some((text) => text.includes(getLang("plugins.takeover.promoted"))));
});

test("takeover: the bot is promoted first when it is not admin", async () => {
  const sock = await run("", { botAdmin: false });
  const promotes = sock.participantUpdates.filter((u) => u.action === "promote");
  assert.equal(promotes.length, 1, "the bot promotes itself once");
  assert.deepEqual(promotes[0].jids, [fakes.IDS.BOT_PN]);
  assert.ok(texts(sock).some((text) => text.includes(getLang("plugins.takeover.promoted"))));
  assert.ok(methods(sock).includes("groupSettingUpdate"), "the lock still runs");
});

test("takeover: a refused promotion falls back to cloning the group", async () => {
  const sock = await run("", { botAdmin: false, promoteStatus: "403" });
  assert.equal(sock.createdGroups.length, 1, "the group is cloned");
  assert.ok(!sock.createdGroups[0].jids.includes(fakes.IDS.BOT_PN), "the bot is not added to its own clone");
  assert.ok(texts(sock).some((text) => text.includes(getLang("plugins.takeover.cloned_members", 5, 0))));
  assert.ok(methods(sock).includes("groupSettingUpdate"), "the clone is locked");
});

test("takeover: cloning failure answers the not_admin card", async () => {
  const sock = await run("", { botAdmin: false, promoteStatus: "403", groupCreateError: new Error("nope") });
  assert.deepEqual(texts(sock), [getLang("plugins.takeover.not_admin")]);
});

// ---------------------------------------------------------------------------
// The lock itself
// ---------------------------------------------------------------------------

test("takeover: every lock step is applied and the invite is revoked", async () => {
  const sock = await run("", { botAdmin: true });
  assert.deepEqual(methods(sock), [
    "groupSettingUpdate",
    "groupSettingUpdate",
    "groupMemberAddMode",
    "groupJoinApprovalMode",
    "groupRevokeInvite",
  ]);
  const settings = sock.calls.filter((c) => c.method === "groupSettingUpdate").map((c) => c.args[1]);
  assert.deepEqual(settings, ["announcement", "locked"]);
  assert.deepEqual(sock.calls.find((c) => c.method === "groupMemberAddMode").args[1], "admin_add");
  assert.deepEqual(sock.calls.find((c) => c.method === "groupJoinApprovalMode").args[1], "on");
});

test("takeover: a failing step is reported and the others still run", async () => {
  const sock = fakes.fakeSocket({ botAdmin: true });
  sock.groupSettingUpdate = async (jid, setting) => {
    sock.calls.push({ method: "groupSettingUpdate", args: [jid, setting] });
    if (setting === "locked") throw new Error("boom");
  };
  const message = fakes.makeMessage({ body: ".takeover", group: true, from: fakes.IDS.OWNER_PN, sock });
  await registry.executeCommand(message);

  const sent = texts(sock).join("\n");
  assert.ok(sent.includes(getLang("plugins.takeover.step_failed", getLang("plugins.takeover.lock"))));
  assert.ok(sent.includes(getLang("plugins.takeover.step_ok", getLang("plugins.takeover.close"))));
  assert.ok(methods(sock).includes("groupRevokeInvite"));
});

test("takeover: the author is mentioned", async () => {
  const sock = await run("", { botAdmin: true, who: fakes.IDS.MEMBER_PN });
  const sent = sock.sent.find((s) => s.kind !== "react");
  assert.ok(sent.content.mentions.includes(fakes.IDS.MEMBER_PN));
  assert.ok(texts(sock).some((text) => text.includes(getLang("plugins.takeover.by", "@333"))));
});

// ---------------------------------------------------------------------------
// Sub-commands
// ---------------------------------------------------------------------------

test("takeover status: reads the live settings", async () => {
  const sock = await run("status", { botAdmin: true });
  const sent = texts(sock).join("\n");
  assert.ok(sent.includes(getLang("plugins.takeover.state_write", getLang("plugins.takeover.state_off"))));
  assert.ok(sent.includes(getLang("plugins.takeover.state_admins", 2)));
  assert.ok(!methods(sock).includes("groupSettingUpdate"), "status changes nothing");
});

test("takeover invite: revokes and returns the new link", async () => {
  const sock = await run("invite", { botAdmin: true });
  assert.ok(methods(sock).includes("groupRevokeInvite"));
  assert.ok(texts(sock).some((text) => text.includes("https://chat.whatsapp.com/FAKENEWCODE")));
});

test("takeover purge: demotes the other admins, keeps the bot, the owner and the creator", async () => {
  const sock = await run("purge", { botAdmin: true, admins: ["111", "333"] });
  const demotes = sock.participantUpdates.filter((u) => u.action === "demote");
  assert.equal(demotes.length, 1);
  assert.deepEqual(demotes[0].jids, [fakes.IDS.MEMBER_PN], "only the ordinary admin is demoted");
  assert.ok(texts(sock).some((text) => text.includes(getLang("plugins.takeover.purged", "@333"))));
});

test("takeover purge: nothing to do when the bot is the only admin", async () => {
  const sock = await run("purge", { botAdmin: true });
  assert.equal(sock.participantUpdates.filter((u) => u.action === "demote").length, 0);
  assert.ok(texts(sock).some((text) => text.includes(getLang("plugins.takeover.purge_none"))));
});

test("takeover release: opens the group back up", async () => {
  const sock = await run("release", { botAdmin: true });
  const settings = sock.calls.filter((c) => c.method === "groupSettingUpdate").map((c) => c.args[1]);
  assert.deepEqual(settings, ["not_announcement", "unlocked"]);
  assert.deepEqual(sock.calls.find((c) => c.method === "groupMemberAddMode").args[1], "all_member_add");
  assert.deepEqual(sock.calls.find((c) => c.method === "groupJoinApprovalMode").args[1], "off");
});

test("takeover: an unknown sub-command shows the usage", async () => {
  const sock = await run("wat", { botAdmin: true });
  assert.deepEqual(texts(sock), [getLang("plugins.takeover.usage", ".")]);
});
