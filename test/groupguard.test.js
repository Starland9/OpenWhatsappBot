"use strict";
/**
 * T130: plugins/groupguard.js (specs/002-admin-panel: contracts/runtime.md section 7, research U3, U16, U17).
 *
 *  - pure helpers: `containsLink`, `looksLikeBotId` and the exported pattern lists, with the anti-bot id
 *    fixtures of U16 (bot / suspect / near misses / ordinary phone-client ids);
 *  - anti-link through the real pipeline and the real plugins: a link from a member is deleted and the
 *    author warned, also inside a command (which then does not run); admins and owners are untouched;
 *    removal at WARN_LIMIT with `guardTarget` + `assertParticipantResult` (warnings cleared, or kept and
 *    reported when the removal fails); a VIP gets the deletion only; nothing without bot admin rights;
 *  - anti-bot: `bot` ids removed with ANTIBOT_MSG, `suspect` ids only logged once per sender per group per
 *    day (bus event `groupguard:action`), near misses and phone ids never match;
 *  - a non-guarded group is untouched and the hook costs no query beyond the cached `group:<jid>` lookup.
 */

const { test, before, after, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

const { IDS } = fakes;
const config = fakes.setupEnv({ sudo: "111" });
const net = fakes.stubNetwork();

const { getLang } = require("../lib/utils/language");
const { invalidateGroupMetadata } = require("../lib/classes/Message");
const pipeline = require("../lib/core/pipeline");
const registry = require("../lib/plugins/registry");
const cooldown = require("../lib/utils/cooldown");
const bus = require("../lib/utils/events");
const groupguard = require("../plugins/groupguard");
const { invalidateGroupSettings } = require("../plugins/setwelcome");
const { invalidateRoles } = require("../plugins/role");

let db;
const probeSeen = []; // bodies that reached the lowest-priority onMessage hook (not consumed upstream)
const events = []; // groupguard:action payloads
const onAction = (payload) => events.push(payload);

before(async () => {
  const setup = await fakes.setup();
  db = setup.db;
  registry.registerPlugin(
    {
      hookPriority: { onMessage: 100 },
      onMessage(message) {
        probeSeen.push(message.body);
        return false;
      },
    },
    "zz-probe.js",
  );
  bus.on("groupguard:action", onAction);
});

afterEach(() => {
  mock.timers.reset();
});

after(() => {
  bus.off("groupguard:action", onAction);
  net.restore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let groupSeq = 0;
const newGroup = () => `1203630002${String(++groupSeq).padStart(5, "0")}@g.us`;
const PN = (n) => `${n}@s.whatsapp.net`;
const HEX = "0123456789ABCDEF";
/** `count` upper-case hex characters, deterministic */
const hex = (count) => Array.from({ length: count }, (_, i) => HEX[(i * 7 + 3) % 16]).join("");

/** A fake connection with the shared pipeline attached and one group ready to be guarded. */
function world(socketOptions = {}) {
  invalidateGroupMetadata();
  const sock = fakes.fakeSocket(socketOptions);
  const client = fakes.fakeClient(sock);
  pipeline.attachHandlers(client);
  const w = {
    sock,
    client,
    /** Send a message through the pipeline. */
    async say(opts) {
      await pipeline.processMessage(fakes.rawMessage(opts), client);
    },
    member(group, body, extra = {}) {
      return w.say({ body, from: IDS.MEMBER_PN, group, ...extra });
    },
    deletes: () => sock.sent.filter((s) => s.kind === "delete"),
    texts: () => sock.sent.filter((s) => s.kind === "text").map((s) => s.text),
    removals: () => sock.participantUpdates.filter((u) => u.action === "remove"),
  };
  return w;
}

/** Turn the guard on for a group (and drop the cached row). */
async function guard(group, settings = { antilink: true }) {
  await db.Group.upsert({ jid: group, antilink: false, antibot: false, ...settings });
  invalidateGroupSettings(group);
}

const warnRows = (group) => db.Warn.findAll({ where: { groupJid: group }, raw: true });

/** Run `fn` and return the SQL statements Sequelize logged meanwhile. */
async function sqlOf(fn) {
  const statements = [];
  const previous = db.DATABASE.options.logging;
  db.DATABASE.options.logging = (sql) => statements.push(sql);
  try {
    await fn();
  } finally {
    db.DATABASE.options.logging = previous;
  }
  return statements;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("exports: containsLink, looksLikeBotId and the three pattern lists; hook-only, priority 50", () => {
  for (const name of ["containsLink", "looksLikeBotId"]) assert.equal(typeof groupguard[name], "function", name);
  for (const name of ["LINK_PATTERNS", "BOT_ID_PATTERNS", "SUSPECT_ID_PATTERNS"]) {
    assert.ok(Array.isArray(groupguard[name]) && groupguard[name].every((p) => p instanceof RegExp), name);
  }
  assert.equal(groupguard.command, undefined, "hook-only: no command");
  assert.deepEqual(groupguard.hookPriority, { onMessage: 50 });
  assert.equal(typeof groupguard.onMessage, "function");

  const entry = registry.getHooks("onMessage").find((h) => h.file === "groupguard.js");
  assert.ok(entry, "registered as an onMessage hook");
  assert.equal(entry.priority, 50);
});

test("containsLink: scheme URLs, www hosts, chat.whatsapp.com and wa.me; bare domains are not links", () => {
  for (const text of [
    "https://example.com",
    "see HTTP://EXAMPLE.COM/path?q=1 now",
    "http://a.b",
    "ftp://files.example.org/x",
    "www.example.com",
    "go to WWW.Example.co.uk please",
    "https://chat.whatsapp.com/AbCdEf123456",
    "join chat.whatsapp.com/AbCdEf123456",
    "wa.me/237600000000",
    "(https://x.test)",
    "line one\nhttps://x.test\nline three",
  ]) {
    assert.equal(groupguard.containsLink(text), true, `"${text}" is a link`);
  }
  for (const text of [
    "",
    "hello world",
    "example.com",
    "visit example.com or foo.org",
    "name@example.com",
    "www",
    "www.",
    "www.x",
    "http:/missing",
    "see it at 3.5 km",
    "schwa.me",
    "https://",
    "a:// ",
  ]) {
    assert.equal(groupguard.containsLink(text), false, `"${text}" is not a link`);
  }
  for (const value of [undefined, null, 42, {}, []]) assert.equal(groupguard.containsLink(value), false);
  // no state between calls (no `g` flag)
  assert.equal(groupguard.containsLink("https://a.b"), true);
  assert.equal(groupguard.containsLink("https://a.b"), true);
});

test("looksLikeBotId: U16 fixtures", () => {
  const classify = groupguard.looksLikeBotId;

  // removed: shapes no WhatsApp client produces
  assert.equal(classify(`3EB0${hex(36)}`), "bot", "3EB0 + 36 hex (Baileys generateMessageID, 40 characters)");
  assert.equal(`3EB0${hex(36)}`.length, 40);
  assert.equal(classify(`BAE5${hex(12)}`), "bot", "BAE5 + 12 hex (earlier Baileys 6 scheme, 16 characters)");
  assert.equal(`BAE5${hex(12)}`.length, 16);
  assert.equal(classify("3EB0" + "A".repeat(36)), "bot");
  assert.equal(classify("BAE5" + "0".repeat(12)), "bot");

  // logged only
  assert.equal(classify(`3EB0${hex(18)}`), "suspect", "3EB0 + 18 hex (Baileys 7 generateMessageIDV2, 22 characters)");
  assert.equal(`3EB0${hex(18)}`.length, 22);

  // near misses
  for (const count of [17, 19, 35, 37]) {
    assert.equal(classify(`3EB0${hex(count)}`), null, `3EB0 with ${count} hex characters`);
  }
  for (const count of [11, 13]) assert.equal(classify(`BAE5${hex(count)}`), null, `BAE5 with ${count} hex characters`);
  assert.equal(classify(`3EB0${hex(36).toLowerCase()}`), null, "lower-case hex");
  assert.equal(classify(`3eb0${hex(36)}`), null, "lower-case prefix");
  assert.equal(classify(`BAE5${hex(12).toLowerCase()}`), null, "lower-case hex (BAE5)");
  assert.equal(classify(`3EB0${hex(36)}G`), null, "a trailing character");
  assert.equal(classify(`3EB0${hex(18)}Z`), null, "a trailing character (suspect shape)");
  assert.equal(classify(` 3EB0${hex(36)}`), null, "a leading space");
  assert.equal(classify(`3EB0${hex(36)}\n`), null, "a trailing newline");
  assert.equal(classify(`BAE5${hex(12)}0`), null, "BAE5 with a trailing hex digit is 13 digits");
  assert.equal(classify(`3EB1${hex(36)}`), null, "another prefix");
  assert.equal(classify(`BAE4${hex(12)}`), null, "another prefix (BAE4)");
  assert.equal(classify(`XX3EB0${hex(36)}`), null, "anchored at the start");

  // ordinary phone-client ids and non-strings
  for (const id of [
    "7B1E2F3A4C5D6E7F8A9B0C1D2E3F4A5B", // Android style, 32 hex characters
    "3A1B2C3D4E5F6A7B8C9D", // iPhone style, 20 characters
    "AC3F5E7D9B1A2C4E6F80123456789ABC",
    "2A11F4B7C9D0E6A3B5C7D9E1F3A5B7C9",
    "3AD4C5B6A7F8E9D0C1B2",
    "A1B2C3D4E5F6A7B8",
    "BOT1",
    "IN12",
    "",
  ]) {
    assert.equal(classify(id), null, `"${id}" is an ordinary id`);
  }
  for (const value of [undefined, null, 12, {}, []]) assert.equal(classify(value), null);

  // the pattern lists are what the classification is made of
  assert.equal(groupguard.BOT_ID_PATTERNS.length, 2);
  assert.equal(groupguard.SUSPECT_ID_PATTERNS.length, 1);
  assert.ok(groupguard.BOT_ID_PATTERNS.every((p) => /^\^.*\$$/.test(p.source)), "anchored");
  assert.ok(groupguard.SUSPECT_ID_PATTERNS.every((p) => /^\^.*\$$/.test(p.source)), "anchored");
});

// ---------------------------------------------------------------------------
// Anti-link
// ---------------------------------------------------------------------------

test("anti-link: a link from a member is deleted and the author warned; the pipeline stops", async () => {
  const group = newGroup();
  await guard(group);
  const w = world();
  events.length = 0;
  const seenBefore = probeSeen.length;

  await w.member(group, "look https://spam.example/offer", { id: "LINK1" });

  assert.equal(w.deletes().length, 1, "one deletion");
  assert.equal(w.deletes()[0].jid, group);
  assert.equal(w.deletes()[0].content.delete.id, "LINK1");
  assert.equal(w.deletes()[0].content.delete.remoteJid, group, "the key of the offending message");

  const rows = await warnRows(group);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].jid, IDS.MEMBER_PN, "stored under the phone-number form");
  assert.equal(rows[0].count, 1);
  assert.equal(rows[0].reason, getLang("groupguard.reason_link"));

  const [notice] = w.sock.sent.filter((s) => s.kind === "text");
  assert.ok(notice, "the warning is sent");
  assert.match(notice.text, /@333/);
  assert.match(notice.text, /Warn:\* 1/);
  assert.match(notice.text, new RegExp(`Remaining:\\* ${config.WARN_LIMIT - 1}`));
  assert.deepEqual(notice.content.mentions, [IDS.MEMBER_PN]);
  assert.equal(notice.options, undefined, "a plain message with a mention, not a reply to the deleted message");
  assert.equal(w.removals().length, 0);
  assert.equal(probeSeen.length, seenBefore, "consumed: later hooks never see the message");
  assert.deepEqual(events.map((e) => e.outcome), ["link_deleted"]);
  assert.deepEqual(events[0], { rule: "antilink", groupJid: group, userJid: IDS.MEMBER_PN, outcome: "link_deleted" });
});

test("anti-link: the same member addressed by LID or phone number shares one warning row", async () => {
  const group = newGroup();
  await guard(group);
  const w = world();

  await w.member(group, "https://a.example");
  await w.member(group, "https://b.example", { lid: true });

  const rows = await warnRows(group);
  assert.equal(rows.length, 1, "one row for the person");
  assert.equal(rows[0].count, 2);
});

test("anti-link: a command that contains a link is a violation too, and the command does not run (U17)", async () => {
  const group = newGroup();
  await guard(group);
  const w = world();
  const seenBefore = probeSeen.length;

  await w.member(group, ".ping https://example.com/x");

  assert.equal(w.deletes().length, 1, "deleted");
  assert.ok(
    !w.texts().some((t) => t === getLang("plugins.ping.ping_sent")),
    `the command did not run: ${JSON.stringify(w.texts())}`,
  );
  assert.equal((await warnRows(group))[0].count, 1, "and the author is warned");
  assert.equal(probeSeen.length, seenBefore);

  // the same command without a link runs
  await w.member(group, ".ping");
  assert.ok(w.texts().includes(getLang("plugins.ping.ping_sent")), "no link: the command runs");
});

test("anti-link: group admins and owners are untouched, commands with links included", async () => {
  const group = newGroup();
  await guard(group, { antilink: true, antibot: true });
  const w = world({ admins: ["333"] });
  const seenBefore = probeSeen.length;

  // an admin posts a link and runs a command with a link
  await w.member(group, "https://admin.example/ok");
  await w.member(group, ".ping https://admin.example/cmd");
  // an owner (not a group admin) as well, with a bot-shaped id on top
  await w.say({ body: "https://owner.example", from: IDS.OWNER_PN, group });
  await w.say({ body: ".ping https://owner.example", from: IDS.OWNER_PN, group, id: `3EB0${hex(36)}` });
  // the group creator (superadmin)
  await w.say({ body: "https://creator.example", from: IDS.CREATOR_PN, group });

  assert.equal(w.deletes().length, 0, "nothing deleted");
  assert.equal(w.removals().length, 0, "nobody removed");
  assert.equal((await warnRows(group)).length, 0, "nobody warned");
  assert.equal(probeSeen.length, seenBefore + 5, "nothing is consumed: the five messages reach the end of the chain");
  assert.equal(
    w.texts().filter((t) => t === getLang("plugins.ping.ping_sent")).length,
    2,
    "the commands with links ran",
  );
});

test("anti-link: removal at WARN_LIMIT through guardTarget + assertParticipantResult, ANTILINK_MSG sent, warnings cleared", async () => {
  const group = newGroup();
  await guard(group);
  const w = world();
  events.length = 0;

  for (let i = 1; i < config.WARN_LIMIT; i += 1) {
    await w.member(group, `https://spam${i}.example`);
    assert.equal(w.removals().length, 0, `warning ${i}: not removed yet`);
  }
  await w.member(group, "https://last.example");

  assert.equal(w.deletes().length, config.WARN_LIMIT, "every link was deleted");
  assert.deepEqual(w.removals(), [{ jid: group, jids: ["888@lid"], action: "remove" }], "removed with the group-side id");
  assert.ok(
    w.texts().includes(config.ANTILINK_MSG.replace("&mention", "@333")),
    `ANTILINK_MSG sent: ${JSON.stringify(w.texts())}`,
  );
  assert.equal((await warnRows(group)).length, 0, "warnings cleared after the removal");
  assert.ok(events.some((e) => e.outcome === "link_removed" && e.rule === "antilink"));
  assert.ok(!events.some((e) => e.outcome === "removed"), "anti-link never reuses the anti-bot outcome");
});

test("anti-link: when the removal fails the warnings are kept and the failure is reported", async () => {
  const group = newGroup();
  await guard(group);
  const w = world({ participantStatus: "403" });

  for (let i = 0; i < config.WARN_LIMIT; i += 1) await w.member(group, `https://spam${i}.example`);

  assert.equal(w.removals().length, 1, "the removal was attempted");
  assert.ok(w.texts().includes(getLang("plugins.warnuser.kick_failed", "@333")), `failure reported: ${JSON.stringify(w.texts())}`);
  assert.ok(!w.texts().includes(config.ANTILINK_MSG.replace("&mention", "@333")), "no 'kicked' notice");
  const rows = await warnRows(group);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, config.WARN_LIMIT, "warnings kept");
});

test("anti-link: a VIP gets the deletion but no warning and no removal", async () => {
  const group = newGroup();
  await guard(group);
  await db.GroupRole.create({ groupJid: group, userJid: IDS.MEMBER_PN, role: "vip", setBy: IDS.OWNER_PN });
  invalidateRoles(group);
  const w = world();
  const seenBefore = probeSeen.length;

  for (let i = 0; i < config.WARN_LIMIT + 1; i += 1) await w.member(group, `https://vip${i}.example`);

  assert.equal(w.deletes().length, config.WARN_LIMIT + 1, "every link is deleted");
  assert.equal((await warnRows(group)).length, 0, "never warned");
  assert.equal(w.removals().length, 0, "never removed");
  assert.deepEqual(w.texts(), [], "no notice");
  assert.equal(probeSeen.length, seenBefore, "the deleted messages were consumed");
});

test("no action when the bot is not a group admin", async () => {
  const group = newGroup();
  await guard(group, { antilink: true, antibot: true });
  const w = world({ botAdmin: false });
  const seenBefore = probeSeen.length;

  await w.member(group, "https://spam.example");
  await w.member(group, "plain text", { id: `3EB0${hex(36)}` });

  assert.equal(w.deletes().length, 0);
  assert.equal(w.removals().length, 0);
  assert.deepEqual(w.texts(), []);
  assert.equal((await warnRows(group)).length, 0);
  assert.equal(probeSeen.length, seenBefore + 2, "the messages go on as if the guard did not exist");
});

test("a group that is not guarded is untouched, whatever the message", async () => {
  const off = newGroup();
  const none = newGroup(); // no Group row at all
  await guard(off, { antilink: false, antibot: false });
  const w = world();
  const seenBefore = probeSeen.length;

  for (const group of [off, none]) {
    await w.member(group, "https://spam.example");
    await w.member(group, "hello", { id: `3EB0${hex(36)}` });
    await w.member(group, ".ping https://spam.example");
  }

  assert.equal(w.deletes().length, 0);
  assert.equal(w.removals().length, 0);
  assert.equal((await db.Warn.count({ where: { groupJid: [off, none] } })), 0);
  assert.equal(probeSeen.length, seenBefore + 6, "nothing is consumed: the six messages reach the end of the chain");
});

test("antilink and antibot are independent switches", async () => {
  const onlyLink = newGroup();
  const onlyBot = newGroup();
  await guard(onlyLink, { antilink: true, antibot: false });
  await guard(onlyBot, { antilink: false, antibot: true });
  const w = world();

  await w.member(onlyLink, "hello", { id: `3EB0${hex(36)}` });
  assert.equal(w.removals().length, 0, "antibot off: a bot id is left alone");
  await w.member(onlyBot, "https://spam.example");
  assert.equal(w.deletes().length, 0, "antilink off: a link is left alone");
  assert.equal(await db.Warn.count({ where: { groupJid: [onlyLink, onlyBot] } }), 0);
});

test("the guard ignores private chats, the bot's own messages and button replies", async () => {
  const group = newGroup();
  await guard(group, { antilink: true, antibot: true });
  const w = world();

  await w.say({ body: "https://pm.example", from: IDS.MEMBER_PN });
  await w.say({ body: "https://mine.example", from: IDS.BOT_PN, fromMe: true, group });
  await w.say({ from: IDS.MEMBER_PN, group, interactive: { id: "role:set:abcd:vip", kind: "button" } });
  assert.equal(w.deletes().length, 0);
  assert.equal(w.removals().length, 0);
});

// ---------------------------------------------------------------------------
// Anti-bot
// ---------------------------------------------------------------------------

test("anti-bot: a 40-character 3EB0 id and a BAE5 id are removed with ANTIBOT_MSG", async () => {
  for (const [id, rule] of [
    [`3EB0${hex(36)}`, "3EB0-40"],
    [`BAE5${hex(12)}`, "BAE5-16"],
  ]) {
    const group = newGroup();
    await guard(group, { antilink: false, antibot: true });
    const w = world();
    events.length = 0;
    const seenBefore = probeSeen.length;

    await w.member(group, ".ping", { id });

    assert.deepEqual(w.removals(), [{ jid: group, jids: ["888@lid"], action: "remove" }], `${rule}: removed`);
    assert.ok(
      w.texts().includes(config.ANTIBOT_MSG.replace("&mention", "@333")),
      `${rule}: ANTIBOT_MSG sent: ${JSON.stringify(w.texts())}`,
    );
    assert.equal(w.deletes().length, 1, `${rule}: the message is deleted too`);
    assert.ok(!w.texts().includes(getLang("plugins.ping.ping_sent")), `${rule}: the command did not run`);
    assert.equal(probeSeen.length, seenBefore, `${rule}: consumed`);
    assert.deepEqual(events, [{ rule, groupJid: group, userJid: IDS.MEMBER_PN, outcome: "removed" }]);
    assert.equal((await warnRows(group)).length, 0, "anti-bot does not warn");
  }
});

test("anti-bot: a failed removal does nothing else", async () => {
  const group = newGroup();
  await guard(group, { antilink: false, antibot: true });
  const w = world({ participantStatus: "403" });
  events.length = 0;
  const seenBefore = probeSeen.length;

  await w.member(group, "hi", { id: `3EB0${hex(36)}` });

  assert.equal(w.removals().length, 1, "attempted");
  assert.equal(w.deletes().length, 0);
  assert.deepEqual(w.texts(), []);
  assert.deepEqual(events, []);
  assert.equal(probeSeen.length, seenBefore + 1, "not consumed");
});

test("anti-bot: a 22-character 3EB0 id is a suspect: logged once per sender per group per day, never removed", async () => {
  const group = newGroup();
  const other = newGroup();
  await guard(group, { antilink: false, antibot: true });
  await guard(other, { antilink: false, antibot: true });
  const w = world();
  const suspectId = () => `3EB0${hex(18)}`;
  const seenBefore = probeSeen.length;

  mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 28, 8, 0, 0) });
  for (const jid of [IDS.MEMBER_PN, IDS.MEMBER2_PN]) {
    for (const g of [group, other]) cooldown.reset(jid, `antibot-suspect:${g}`);
  }
  events.length = 0;

  await w.member(group, "one", { id: suspectId() });
  await w.member(group, "two", { id: suspectId() });
  assert.deepEqual(events, [{ rule: "3EB0-22", groupJid: group, userJid: IDS.MEMBER_PN, outcome: "suspect" }], "once");

  await w.member(other, "same sender, another group", { id: suspectId() });
  assert.equal(events.length, 2, "another group: logged again");
  assert.equal(events[1].groupJid, other);

  await w.say({ body: "another sender", from: IDS.MEMBER2_PN, group, id: suspectId() });
  assert.equal(events.length, 3, "another sender: logged again");
  assert.equal(events[2].userJid, IDS.MEMBER2_PN);

  mock.timers.tick(23 * 60 * 60 * 1000);
  await w.member(group, "23 h later", { id: suspectId() });
  assert.equal(events.length, 3, "still the same day");
  mock.timers.tick(2 * 60 * 60 * 1000);
  await w.member(group, "25 h later", { id: suspectId() });
  assert.equal(events.length, 4, "a day later: logged again");

  assert.ok(events.every((e) => e.outcome === "suspect"));
  assert.equal(w.removals().length, 0, "never removed");
  assert.equal(w.deletes().length, 0, "never deleted");
  assert.deepEqual(w.texts(), [], "never announced");
  assert.equal((await db.Warn.count({ where: { groupJid: [group, other] } })), 0, "never warned");
  assert.equal(probeSeen.length, seenBefore + 6, "the messages continue down the pipeline");
});

test("anti-bot: suspect ids from admins and owners are not even logged; nothing without bot admin", async () => {
  const group = newGroup();
  await guard(group, { antilink: false, antibot: true });
  const w = world({ admins: ["333"] });
  const suspectId = () => `3EB0${hex(18)}`;
  events.length = 0;
  for (const jid of [IDS.MEMBER_PN, IDS.OWNER_PN]) cooldown.reset(jid, `antibot-suspect:${group}`);

  await w.member(group, "admin", { id: suspectId() });
  await w.say({ body: "owner", from: IDS.OWNER_PN, group, id: suspectId() });
  await w.member(group, "admin with a bot id", { id: `3EB0${hex(36)}` });
  assert.deepEqual(events, []);
  assert.equal(w.removals().length, 0);

  const noAdmin = world({ botAdmin: false });
  const other = newGroup();
  await guard(other, { antilink: false, antibot: true });
  cooldown.reset(IDS.MEMBER_PN, `antibot-suspect:${other}`);
  await noAdmin.member(other, "x", { id: suspectId() });
  await noAdmin.member(other, "y", { id: `3EB0${hex(36)}` });
  assert.deepEqual(events, [], "bot not admin: nothing");
  assert.equal(noAdmin.removals().length, 0);
});

test("anti-bot: near-miss ids and ordinary phone-client ids never act", async () => {
  const group = newGroup();
  await guard(group, { antilink: false, antibot: true });
  const w = world();
  events.length = 0;
  const seenBefore = probeSeen.length;

  const ids = [
    ...[17, 19, 35, 37].map((n) => `3EB0${hex(n)}`),
    ...[11, 13].map((n) => `BAE5${hex(n)}`),
    `3EB0${hex(36).toLowerCase()}`,
    `3EB0${hex(36)}G`,
    "7B1E2F3A4C5D6E7F8A9B0C1D2E3F4A5B",
    "3A1B2C3D4E5F6A7B8C9D",
    "AC3F5E7D9B1A2C4E6F80123456789ABC",
  ];
  for (const id of ids) await w.member(group, "plain", { id });

  assert.deepEqual(events, []);
  assert.equal(w.removals().length, 0);
  assert.equal(w.deletes().length, 0);
  assert.equal(probeSeen.length, seenBefore + ids.length);
});

test("a bot-shaped id that also carries a link is removed once, without a warning", async () => {
  const group = newGroup();
  await guard(group, { antilink: true, antibot: true });
  const w = world();

  await w.member(group, "https://spam.example", { id: `3EB0${hex(36)}` });

  assert.equal(w.removals().length, 1);
  assert.equal(w.deletes().length, 1, "deleted once");
  assert.equal((await warnRows(group)).length, 0);
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

test("the hook costs no database query beyond the cached group:<jid> lookup", async () => {
  const guarded = newGroup();
  const open = newGroup();
  await guard(guarded, { antilink: true, antibot: true });
  const sock = fakes.fakeSocket();
  const client = fakes.fakeClient(sock);
  const make = (group, body, extra = {}) => fakes.makeMessage({ client, body, from: IDS.MEMBER_PN, group, ...extra });

  // cold: the group row is loaded once
  const cold = await sqlOf(() => groupguard.onMessage(make(guarded, "hello")));
  assert.ok(cold.length >= 1, "the probe sees the query of the cold lookup");

  // warm: harmless messages of a guarded group, a link in an unguarded group, a bot id in an unguarded group
  const warm = await sqlOf(async () => {
    assert.equal(await groupguard.onMessage(make(guarded, "hello")), false);
    assert.equal(await groupguard.onMessage(make(guarded, "just some text", { id: `3EB0${hex(37)}` })), false);
    assert.equal(await groupguard.onMessage(make(guarded, "example.com is not a link")), false);
  });
  assert.deepEqual(warm, [], "guarded group, no violation: no query");

  await groupguard.onMessage(make(open, "hello")); // loads (and caches) the empty row of the open group
  const unguarded = await sqlOf(async () => {
    assert.equal(await groupguard.onMessage(make(open, "https://spam.example")), false);
    assert.equal(await groupguard.onMessage(make(open, "hi", { id: `3EB0${hex(36)}` })), false);
  });
  assert.deepEqual(unguarded, [], "unguarded group: no query");

  // the bot's own messages and private chats never even read the row
  const skipped = await sqlOf(async () => {
    assert.equal(await groupguard.onMessage(make(guarded, "https://x.test", { fromMe: true, from: IDS.BOT_PN })), false);
    assert.equal(await groupguard.onMessage(fakes.makeMessage({ client, body: "https://x.test", from: IDS.MEMBER_PN })), false);
  });
  assert.deepEqual(skipped, []);
});
