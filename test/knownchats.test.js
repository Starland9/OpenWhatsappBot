"use strict";
/**
 * T131: plugins/knownchats.js, the hook that feeds `known_chats` (specs/002-admin-panel: contracts/runtime.md
 * section 8). The data layer has its own suite (test/known-chats-data.test.js); here:
 *
 *  - `onMessage` records a private chat (not `fromMe`, `@s.whatsapp.net` or `@lid`, never `status@broadcast`
 *    or a newsletter, never a group), runs first (priority 5) and never consumes;
 *  - `onReady` seeds an empty table, then refreshes the group names and `leftAt` at most every 6 hours;
 *  - `onGroupParticipants` sets `leftAt` when the bot itself is removed (and clears it when it is added back).
 */

const { test, before, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

const { IDS } = fakes;
fakes.setupEnv({ sudo: "111" });

const knownChats = require("../lib/utils/knownChats");
const plugin = require("../plugins/knownchats");
const registry = require("../lib/plugins/registry");

let db;
const T0 = Date.UTC(2026, 9, 28, 8, 0, 0);
const HOUR = 60 * 60 * 1000;
const G = (n) => `1203630003${String(n).padStart(5, "0")}@g.us`;
const PN = (n) => `${n}@s.whatsapp.net`;

before(async () => {
  const setup = await fakes.setup();
  db = setup.db;
});

beforeEach(async () => {
  await db.KnownChat.destroy({ where: {}, truncate: true });
  for (const name of ["Group", "Filter", "GroupRole", "UserStats", "Warn", "GroupEconomy", "Idea", "Quote", "Conversation", "User"]) {
    await db[name].destroy({ where: {}, truncate: true });
  }
  knownChats._reset();
  plugin._reset();
});

afterEach(() => {
  mock.timers.reset();
});

const rows = (where = {}) => db.KnownChat.findAll({ where, raw: true, order: [["jid", "ASC"]] });

/** A private message, with the chat JID overridable to reach the cases Baileys never delivers to a plain chat. */
function privateMessage(opts = {}) {
  const { jid, ...rest } = opts;
  const message = fakes.makeMessage({ body: "hello", from: IDS.MEMBER_PN, ...rest });
  if (jid) message.jid = jid;
  return message;
}

const wait = (fn) => fakes.waitFor(fn, { timeout: 2000 });

// ---------------------------------------------------------------------------
// onMessage
// ---------------------------------------------------------------------------

test("registration: hook-only, onMessage priority 5, first in the chain", () => {
  assert.equal(plugin.command, undefined, "hook-only");
  assert.deepEqual(plugin.hookPriority, { onMessage: 5 });
  for (const name of ["onMessage", "onReady", "onGroupParticipants"]) assert.equal(typeof plugin[name], "function", name);

  const hooks = registry.getHooks("onMessage");
  const mine = hooks.find((h) => h.file === "knownchats.js");
  assert.ok(mine, "registered as an onMessage hook");
  assert.equal(mine.priority, 5);
  assert.equal(hooks[0].file, "knownchats.js", `runs before every other hook: ${hooks.map((h) => h.file).join(", ")}`);
  assert.ok(registry.getHooks("onReady").some((h) => h.file === "knownchats.js"));
  assert.ok(registry.getHooks("onGroupParticipants").some((h) => h.file === "knownchats.js"));
});

test("onMessage records a private chat the first time it writes, with the push name and the phone-number JID", async () => {
  const message = privateMessage({ pushName: "Alice" });
  assert.equal(plugin.onMessage(message), false, "never consumes");

  const [row] = await wait(async () => {
    const found = await rows();
    return found.length ? found : null;
  });
  assert.equal(row.jid, IDS.MEMBER_PN);
  assert.equal(row.kind, "private");
  assert.equal(row.pnJid, IDS.MEMBER_PN);
  assert.equal(row.name, "Alice");
  assert.equal(row.leftAt, null);
});

test("onMessage: a LID chat is recorded with the phone-number form of the sender", async () => {
  const message = privateMessage({ from: IDS.MEMBER_PN, lid: true, pushName: "Bob" });
  assert.equal(message.jid, IDS.MEMBER_LID);
  plugin.onMessage(message);

  const [row] = await wait(async () => {
    const found = await rows();
    return found.length ? found : null;
  });
  assert.equal(row.jid, IDS.MEMBER_LID);
  assert.equal(row.pnJid, IDS.MEMBER_PN);
});

test("onMessage never records the bot's own messages, groups, status broadcasts or newsletters, and never consumes", async () => {
  const ignored = [
    privateMessage({ from: IDS.BOT_PN, fromMe: true }),
    fakes.makeMessage({ body: "in a group", from: IDS.MEMBER_PN, group: IDS.GROUP }),
    privateMessage({ jid: "status@broadcast" }),
    privateMessage({ jid: "120363000000000009@newsletter" }),
    privateMessage({ jid: "12345@broadcast" }),
  ];
  for (const message of ignored) assert.equal(plugin.onMessage(message), false);

  // one that is recorded proves the write path works, and that nothing else sneaked in before it
  plugin.onMessage(privateMessage({ from: IDS.MEMBER2_PN }));
  const found = await wait(async () => {
    const all = await rows();
    return all.length ? all : null;
  });
  assert.deepEqual(found.map((r) => r.jid), [IDS.MEMBER2_PN]);
  assert.equal(await db.KnownChat.count(), 1);
});

test("onMessage writes a chat once an hour: the second message does not touch the row", async () => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  plugin.onMessage(privateMessage());
  await wait(async () => (await db.KnownChat.count()) === 1);
  const first = (await rows())[0];

  mock.timers.tick(30 * 60 * 1000);
  plugin.onMessage(privateMessage());
  await fakes.sleep(50); // a write, if there were one, is done by now
  assert.equal(new Date((await rows())[0].lastSeenAt).getTime(), new Date(first.lastSeenAt).getTime(), "30 min later: throttled");

  mock.timers.tick(31 * 60 * 1000);
  plugin.onMessage(privateMessage());
  await wait(async () => new Date((await rows())[0].lastSeenAt).getTime() > new Date(first.lastSeenAt).getTime());
  assert.equal(await db.KnownChat.count(), 1);
});

// ---------------------------------------------------------------------------
// onReady
// ---------------------------------------------------------------------------

/** A client whose socket counts the group fetches. */
function clientWith(groups, extra = {}) {
  const sock = fakes.fakeSocket({ groups, ...extra });
  const original = sock.groupFetchAllParticipating;
  sock.fetches = 0;
  sock.groupFetchAllParticipating = async () => {
    sock.fetches += 1;
    return original();
  };
  return { sock, client: fakes.fakeClient(sock) };
}

test("onReady seeds an empty table from the other tables, then takes the group names from WhatsApp", async () => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  await db.User.create({ jid: PN(701) });
  await db.Conversation.create({ jid: PN(702) });
  await db.Filter.create({ groupJid: G(1), pattern: "x", response: "y" });
  await db.Warn.create({ jid: PN(703), groupJid: G(2), count: 1 });
  await db.Group.create({ jid: G(3), name: "Old name" });

  const { client, sock } = clientWith([G(1), G(2), G(4)], { subject: "Fresh subject" });
  await plugin.onReady(client);

  const byJid = Object.fromEntries((await rows()).map((r) => [r.jid, r]));
  assert.equal(byJid[PN(701)]?.kind, "private", "seeded from User");
  assert.equal(byJid[PN(702)]?.kind, "private", "seeded from Conversation");
  assert.equal(byJid[G(1)].name, "Fresh subject", "name refreshed from the fetch");
  assert.equal(byJid[G(2)].leftAt, null);
  assert.equal(byJid[G(4)]?.kind, "group", "a group nobody had configured is known too");
  assert.ok(byJid[G(3)].leftAt, "a group the bot is no longer in is a former group");
  assert.equal(sock.fetches, 1);
});

test("onReady refreshes the groups at most every 6 hours (reconnections are cheap)", async () => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  const { client, sock } = clientWith([G(10)]);

  await plugin.onReady(client);
  assert.equal(sock.fetches, 1);
  await plugin.onReady(client);
  mock.timers.tick(5 * HOUR + 59 * 60 * 1000);
  await plugin.onReady(client);
  assert.equal(sock.fetches, 1, "under 6 h: no second fetch");

  mock.timers.tick(2 * 60 * 1000);
  await plugin.onReady(client);
  assert.equal(sock.fetches, 2, "after 6 h: fetched again");
  assert.equal(await db.KnownChat.count({ where: { kind: "group" } }), 1, "idempotent");
});

test("onReady sets leftAt for a group that is gone and clears it when the bot is back", async () => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  await plugin.onReady(clientWith([G(20), G(21)]).client);
  assert.deepEqual((await rows({ kind: "group" })).map((r) => r.leftAt), [null, null]);

  mock.timers.tick(7 * HOUR);
  await plugin.onReady(clientWith([G(20)]).client);
  const afterLeaving = Object.fromEntries((await rows({ kind: "group" })).map((r) => [r.jid, r.leftAt]));
  assert.equal(afterLeaving[G(20)], null);
  assert.ok(afterLeaving[G(21)], "G(21) is a former group now");

  mock.timers.tick(7 * HOUR);
  await plugin.onReady(clientWith([G(20), G(21)]).client);
  assert.equal((await db.KnownChat.findByPk(G(21))).leftAt, null, "back in the group");
});

test("onReady ignores an empty answer while groups are known (a failed fetch must not mark everything as left)", async () => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  await plugin.onReady(clientWith([G(30), G(31)]).client);
  mock.timers.tick(7 * HOUR);
  await plugin.onReady(clientWith([]).client);
  assert.deepEqual((await rows({ kind: "group" })).map((r) => r.leftAt), [null, null]);
});

test("onReady never throws: a failing fetch or a missing socket is only logged", async () => {
  const failing = fakes.fakeSocket({ groups: [G(40)] });
  failing.groupFetchAllParticipating = async () => {
    throw new Error("rate-overlimit");
  };
  await plugin.onReady(fakes.fakeClient(failing));
  await plugin.onReady({ getSocket: () => null });
  await plugin.onReady(undefined);
  assert.equal(await db.KnownChat.count(), 0);
});

test("subscribeGroups hears every fetch made by the hook, and stops after unsubscribe", async () => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  const heard = [];
  const off = plugin.subscribeGroups((groups, at) => heard.push({ jids: Object.keys(groups), at }));
  await plugin.onReady(clientWith([G(50), G(51)]).client);
  assert.deepEqual(heard, [{ jids: [G(50), G(51)], at: T0 }]);

  off();
  mock.timers.tick(7 * HOUR);
  await plugin.onReady(clientWith([G(50)]).client);
  assert.equal(heard.length, 1);
});

// ---------------------------------------------------------------------------
// onGroupParticipants
// ---------------------------------------------------------------------------

test("onGroupParticipants sets leftAt when the bot itself is removed, in any identity form", async () => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  const { client } = clientWith([G(60), G(61), G(62), G(63)]);
  await plugin.onReady(client);

  await plugin.onGroupParticipants({ id: G(60), action: "remove", participants: [PN(999)] }, client);
  await plugin.onGroupParticipants({ id: G(61), action: "remove", participants: ["555:3@lid"] }, client);
  await plugin.onGroupParticipants({ id: G(62), action: "remove", participants: [{ id: "555@lid", phoneNumber: PN(999) }] }, client);
  // somebody else leaves: nothing changes
  await plugin.onGroupParticipants({ id: G(63), action: "remove", participants: [PN(333), "888@lid"] }, client);

  const left = Object.fromEntries((await rows({ kind: "group" })).map((r) => [r.jid, r.leftAt]));
  assert.ok(left[G(60)] && left[G(61)] && left[G(62)], "the three removals of the bot");
  assert.equal(new Date(left[G(60)]).getTime(), T0);
  assert.equal(left[G(63)], null, "another member");
});

test("onGroupParticipants: other actions and other chats change nothing; the bot added back clears leftAt", async () => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  const { client } = clientWith([G(70)]);
  await plugin.onReady(client);

  for (const action of ["promote", "demote", "modify"]) {
    await plugin.onGroupParticipants({ id: G(70), action, participants: [PN(999)] }, client);
  }
  await plugin.onGroupParticipants({ id: PN(333), action: "remove", participants: [PN(999)] }, client);
  await plugin.onGroupParticipants(null, client);
  await plugin.onGroupParticipants({ id: G(70), action: "remove" }, client);
  assert.equal((await db.KnownChat.findByPk(G(70))).leftAt, null);

  await plugin.onGroupParticipants({ id: G(70), action: "remove", participants: [PN(999)] }, client);
  assert.ok((await db.KnownChat.findByPk(G(70))).leftAt);
  await plugin.onGroupParticipants({ id: G(70), action: "add", participants: [PN(999)] }, client);
  assert.equal((await db.KnownChat.findByPk(G(70))).leftAt, null, "added back");

  // an unknown group the bot was removed from is recorded as already left
  await plugin.onGroupParticipants({ id: G(71), action: "remove", participants: [PN(999)] }, client);
  assert.ok((await db.KnownChat.findByPk(G(71))).leftAt);
});
