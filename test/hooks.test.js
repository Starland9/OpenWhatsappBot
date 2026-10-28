"use strict";
/**
 * T028: features that must take effect (FR-013 to FR-018), driven through the real plugins and the real
 * pipeline with a fake socket:
 *
 *  - welcome / goodbye (`onGroupParticipants`): one message mentioning every participant (string and object
 *    entries), the bot itself skipped, disabled chats silent;
 *  - filters: case-insensitive, whole word, `.*` is literal, the pipeline stops (cooldown included);
 *  - AFK: a mention / quote gets a notice, the AFK user's next message clears the status (DB-backed);
 *  - BannedChat: commands ignored, `unban` from the owner gets through, the ban survives a cache flush
 *    and a re-require of the pipeline (DB);
 *  - tracking: group messages counted atomically, private chats / bot messages not;
 *  - the onMessage hooks run by priority (knownchats 5, role 10, tracking 20, afk 30, notify 40, groupguard 50,
 *    filters 90), so a message that matches a filter is still counted and still clears AFK;
 *  - reminders: a reminder due in the past is delivered exactly once by scheduler.tick(), then `sent`.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

const { IDS } = fakes;
fakes.setupEnv({ sudo: "111" });
const net = fakes.stubNetwork();

const { getLang } = require("../lib/utils/language");
const { invalidateGroupMetadata } = require("../lib/classes/Message");
const pipeline = require("../lib/core/pipeline");
const registry = require("../lib/plugins/registry");
const settingsCache = require("../lib/utils/settingsCache");
const cooldown = require("../lib/utils/cooldown");
const scheduler = require("../lib/utils/scheduler");

let db;
const probeSeen = []; // bodies that reached the lowest-priority onMessage hook

before(async () => {
  const setup = await fakes.setup();
  db = setup.db;
  // Observer at the end of the onMessage chain: tells whether something upstream consumed the message
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
});

after(() => {
  scheduler.stop();
  net.restore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let groupSeq = 0;
/** A fresh group JID: no cooldown or cache is shared between scenarios */
const newGroup = () => `1203630001${String(++groupSeq).padStart(5, "0")}@g.us`;
const PN = (n) => `${n}@s.whatsapp.net`;

/** A fake bot connection with the shared pipeline attached. */
function world(socketOptions = {}) {
  invalidateGroupMetadata();
  const sock = fakes.fakeSocket(socketOptions);
  const client = fakes.fakeClient(sock);
  pipeline.attachHandlers(client);
  const world = {
    sock,
    client,
    /** Send a message through the pipeline; resolves with what the bot sent meanwhile. */
    async say(opts) {
      const before = sock.sent.length;
      await pipeline.processMessage(fakes.rawMessage(opts), client);
      return world.sentSince(before);
    },
    sentSince(index) {
      return sock.sent.slice(index).filter((s) => s.kind !== "react" && s.kind !== "delete");
    },
    /** Send the owner's command in a group (owner passes every permission check). */
    owner(group, body) {
      return world.say({ body, from: IDS.OWNER_PN, group });
    },
    async participants(update) {
      const before = sock.sent.length;
      await client.dispatch("group-participants.update", { author: IDS.OWNER_PN, ...update });
      return world.sentSince(before);
    },
  };
  return world;
}

const textsOf = (sends) => sends.map((s) => s.text);
const sleep = fakes.sleep;

// ---------------------------------------------------------------------------
// Welcome / goodbye
// ---------------------------------------------------------------------------

test("welcome: one message mentioning every participant (strings and objects), the bot itself skipped", async () => {
  const group = newGroup();
  const w = world({ subject: "Team @user", desc: "About us" });

  assert.deepEqual(await w.participants({ id: group, action: "add", participants: [PN(444)] }), [], "welcome is off by default");

  let sent = await w.owner(group, ".welcome on");
  assert.deepEqual(textsOf(sent), [getLang("plugins.setwelcome.enabled")]);
  sent = await w.owner(group, ".welcome Hello @user, welcome to @group (@desc)");
  assert.equal(sent.length, 1, "the new text is acknowledged");

  const added = await w.participants({
    id: group,
    action: "add",
    participants: [
      PN(444), // string entry
      { id: "888@lid", phoneNumber: PN(333), lid: "888@lid" }, // object entry (LID addressing)
      { id: "888@lid", phoneNumber: PN(333) }, // the same person again
      PN(999), // the bot itself
      "555:3@lid", // the bot, LID form
    ],
  });
  assert.equal(added.length, 1, `one message for the whole event, got ${JSON.stringify(textsOf(added))}`);
  const [message] = added;
  assert.equal(message.jid, group);
  assert.deepEqual([...message.content.mentions].sort(), [PN(333), PN(444)], "mentions: everybody who joined, nobody else");
  assert.match(message.text, /@444/);
  assert.match(message.text, /@333/);
  assert.doesNotMatch(message.text, /@999|@555/, "the bot is not welcomed");
  assert.match(message.text, /welcome to Team @user \(About us\)/, "@group and @desc are replaced, and a value is never substituted again");

  // only strings / only objects: still a single message each
  assert.equal((await w.participants({ id: group, action: "add", participants: [PN(444), PN(333)] })).length, 1);
  assert.equal((await w.participants({ id: group, action: "add", participants: [{ id: "888@lid", phoneNumber: PN(333) }] })).length, 1);

  // the bot alone: nothing to say
  assert.deepEqual(await w.participants({ id: group, action: "add", participants: [PN(999)] }), []);
  // other actions are not a welcome
  for (const action of ["remove", "promote", "demote"]) {
    assert.deepEqual(await w.participants({ id: group, action, participants: [PN(444)] }), [], `${action} must not welcome`);
  }

  sent = await w.owner(group, ".welcome off");
  assert.deepEqual(textsOf(sent), [getLang("plugins.setwelcome.disabled")]);
  assert.deepEqual(await w.participants({ id: group, action: "add", participants: [PN(444)] }), [], "welcome off: silent");
});

test("goodbye: remove → goodbye message (once, everybody mentioned); off by default; add is not a goodbye", async () => {
  const group = newGroup();
  const w = world();

  assert.deepEqual(await w.participants({ id: group, action: "remove", participants: [PN(444)] }), [], "goodbye is off by default");

  await w.owner(group, ".goodbye on");
  await w.owner(group, ".goodbye See you @user from @group");

  const left = await w.participants({
    id: group,
    action: "remove",
    participants: [PN(444), { id: "888@lid", phoneNumber: PN(333) }, PN(999)],
  });
  assert.equal(left.length, 1);
  assert.deepEqual([...left[0].content.mentions].sort(), [PN(333), PN(444)]);
  assert.match(left[0].text, /See you @\d{3}, @\d{3} from Test group|See you @\d{3} from Test group/);
  assert.match(left[0].text, /@444/);
  assert.match(left[0].text, /@333/);

  assert.deepEqual(await w.participants({ id: group, action: "add", participants: [PN(444)] }), [], "add is not a goodbye (welcome is off here)");

  await w.owner(group, ".goodbye off");
  assert.deepEqual(await w.participants({ id: group, action: "remove", participants: [PN(444)] }), []);
});

test("welcome and goodbye are independent, and a chat where the bot is disabled stays silent", async () => {
  const group = newGroup();
  const w = world();
  await w.owner(group, ".welcome on");
  await w.owner(group, ".goodbye on");

  assert.equal((await w.participants({ id: group, action: "add", participants: [PN(444)] })).length, 1);
  assert.equal((await w.participants({ id: group, action: "remove", participants: [PN(444)] })).length, 1);

  // disabled chat (BannedChat): no welcome, no goodbye
  await db.BannedChat.create({ jid: group, bannedBy: IDS.OWNER_PN });
  settingsCache.invalidate(pipeline.BANNED_CHATS_KEY);
  assert.deepEqual(await w.participants({ id: group, action: "add", participants: [PN(444)] }), []);
  assert.deepEqual(await w.participants({ id: group, action: "remove", participants: [PN(444)] }), []);

  // enabled again
  await db.BannedChat.destroy({ where: { jid: group } });
  settingsCache.invalidate(pipeline.BANNED_CHATS_KEY);
  assert.equal((await w.participants({ id: group, action: "add", participants: [PN(444)] })).length, 1);
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test("filters: case-insensitive, whole word, and the pipeline stops on a match", async () => {
  const group = newGroup();
  const w = world();

  const added = await w.owner(group, ".filter hi=Hello there");
  assert.equal(added.length, 1);
  assert.match(added[0].text, /Hello there/);

  const member = (body, extra = {}) => w.say({ body, from: IDS.MEMBER_PN, group, ...extra });
  const seenBefore = probeSeen.length;

  for (const body of ["hi", "HI", "Hi!", "oh HI there", "say hi, please"]) {
    cooldown.reset(group, "filter:hi"); // the 10 s cooldown is tested below
    const sent = await member(body);
    assert.deepEqual(textsOf(sent), ["Hello there"], `"${body}" must trigger the filter`);
  }
  assert.equal(probeSeen.length, seenBefore, "a matching message is consumed: later hooks never see it");

  for (const body of ["this", "hit", "hiking", "high five", "chi", "hi_there", "hi2", "greetings"]) {
    cooldown.reset(group, "filter:hi");
    assert.deepEqual(textsOf(await member(body)), [], `"${body}" must NOT trigger the filter (not a whole word)`);
  }
  assert.equal(probeSeen.length, seenBefore + 8, "non-matching messages continue down the pipeline");

  // replies to a filter-matching message are not sent for commands, the bot's own messages or private chats
  cooldown.reset(group, "filter:hi");
  assert.deepEqual(textsOf(await w.say({ body: "hi", from: IDS.BOT_PN, fromMe: true, group })), []);
  assert.deepEqual(textsOf(await w.say({ body: "hi", from: IDS.MEMBER_PN })), [], "filters are for groups only");
  assert.deepEqual(textsOf(await member(".hi")), [], "a command is never answered by a filter");

  // update, list and delete
  const updated = await w.owner(group, ".filter HI = Bonjour");
  assert.equal(updated.length, 1);
  cooldown.reset(group, "filter:hi");
  assert.deepEqual(textsOf(await member("hi")), ["Bonjour"], "same pattern (case / spaces) updates the filter");
  const list = await w.owner(group, ".filter list");
  assert.match(list[0].text, /hi/);
  assert.equal(await db.Filter.count({ where: { groupJid: group } }), 1, "one row, not two");
});

test("filters: 10 s cooldown per (group, pattern) stays silent but still consumes the message", async () => {
  const group = newGroup();
  const w = world();
  await w.owner(group, ".filter ping pong=Table tennis");
  cooldown.reset(group, "filter:ping pong");

  const seenBefore = probeSeen.length;
  const first = await w.say({ body: "ping   PONG", from: IDS.MEMBER_PN, group });
  assert.deepEqual(textsOf(first), ["Table tennis"], "a phrase matches across spacing and case");
  const second = await w.say({ body: "ping pong again", from: IDS.MEMBER_PN, group });
  assert.deepEqual(textsOf(second), [], "second match within 10 s: no reply");
  assert.equal(probeSeen.length, seenBefore, "...but the message is still consumed");
});

test("filters: a regex-looking pattern such as .* is plain text", async () => {
  const group = newGroup();
  const w = world();

  const added = await w.owner(group, ".filter .*=literal star");
  assert.equal(added.length, 1);
  cooldown.reset(group, "filter:.*");
  const member = (body) => w.say({ body, from: IDS.MEMBER_PN, group });

  for (const body of ["anything at all", "hello world", "a", "", "x*y"]) {
    assert.deepEqual(textsOf(await member(body)), [], `".*" must not match "${body}"`);
  }
  cooldown.reset(group, "filter:.*");
  assert.deepEqual(textsOf(await member("type .* to match everything")), ["literal star"], "the literal text .* does match");

  // other regex syntax: inert, and no catastrophic backtracking
  await w.owner(group, ".filter (a+)+$=boom");
  const started = Date.now();
  assert.deepEqual(textsOf(await member("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!")), []);
  assert.ok(Date.now() - started < 1000, "a hostile pattern must not freeze the pipeline");
  cooldown.reset(group, "filter:(a+)+$");
  assert.deepEqual(textsOf(await member("see (a+)+$ here")), ["boom"]);
});

// ---------------------------------------------------------------------------
// AFK
// ---------------------------------------------------------------------------

test("afk: a mention or a quote gets a notice; the user's next message clears the status (persisted)", async () => {
  const group = newGroup();
  const w = world();
  const away = PN(333);
  const noticeKey = `afk:${away}`;
  const member = (body, extra = {}) => w.say({ body, from: IDS.MEMBER_PN, lid: true, group, ...extra });
  const owner = (body, extra = {}) => w.say({ body, from: IDS.OWNER_PN, group, ...extra });

  // 1. set (open to everybody; the member is addressed by LID, the status is stored under the phone number)
  assert.deepEqual(textsOf(await member(".afk lunch")), [getLang("plugins.afk.set_reason", "lunch")]);
  const row = await db.User.findByPk(away);
  assert.equal(row?.afkReason, "lunch");
  assert.ok(row.afkTime, "afkTime is stored");

  // 2. mention (phone number form)
  let sent = await owner("where is @333 ?", { mentions: [away] });
  assert.equal(sent.length, 1, `expected one AFK notice, got ${JSON.stringify(textsOf(sent))}`);
  assert.match(sent[0].text, /lunch/);
  assert.match(sent[0].text, /@333/);
  assert.ok(sent[0].content.mentions.includes(away));

  // 3. the notice has a cooldown (60 s per chat and user)
  assert.deepEqual(textsOf(await owner("@333 ?", { mentions: [away] })), [], "no second notice within 60 s");

  // 4. mention in LID form (Baileys 7), resolved through the group's participants
  cooldown.reset(group, noticeKey);
  sent = await owner("@888", { mentions: ["888@lid"] });
  assert.equal(sent.length, 1, "a LID mention of an away user is recognised");
  assert.match(sent[0].text, /lunch/);

  // 5. quote
  cooldown.reset(group, noticeKey);
  sent = await owner("you there?", { quoted: { text: "I am eating", sender: IDS.MEMBER_LID } });
  assert.equal(sent.length, 1, "quoting an away user's message is noticed");

  // 6. private chats never get notices
  cooldown.reset(group, noticeKey);
  assert.deepEqual(textsOf(await w.say({ body: "@333", from: IDS.OWNER_PN, mentions: [away] })), []);

  // 7. `.afk` again while away only updates the reason (the start time is kept)
  const since = (await db.User.findByPk(away)).afkTime.getTime();
  assert.deepEqual(textsOf(await member(".afk dinner")), [getLang("plugins.afk.updated_reason", "dinner")]);
  const updated = await db.User.findByPk(away);
  assert.equal(updated.afkReason, "dinner");
  assert.equal(updated.afkTime.getTime(), since);

  // 8. persistence: the in-memory copy is dropped (restart / onReady), the DB still knows
  settingsCache.invalidate("afk_users");
  cooldown.reset(group, noticeKey);
  sent = await owner("@333", { mentions: [away] });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /dinner/);

  // 9. back: the next message of the away user clears the status
  sent = await member("I'm back");
  assert.equal(sent.length, 1, "one 'welcome back' reply");
  assert.match(sent[0].text, /@333/);
  assert.ok(sent[0].content.mentions.includes(away));
  const cleared = await db.User.findByPk(away);
  assert.equal(cleared.afkTime, null);
  assert.equal(cleared.afkReason, null);
  assert.deepEqual(textsOf(await member("still here")), [], "only the first message answers");

  cooldown.reset(group, noticeKey);
  assert.deepEqual(textsOf(await owner("@333", { mentions: [away] })), [], "no longer away: no notice");
});

// ---------------------------------------------------------------------------
// BannedChat
// ---------------------------------------------------------------------------

test("ban: commands are ignored, unban from the owner gets through, the ban survives a cache flush and a re-require", async () => {
  const banned = newGroup();
  const other = newGroup();
  const w = world();
  const member = (body, group = banned) => w.say({ body, from: IDS.MEMBER_PN, group });

  assert.ok((await member(".ping")).length >= 1, "sanity: .ping answers before the ban");

  // ban
  const done = await w.owner(banned, ".ban");
  assert.deepEqual(textsOf(done), [getLang("plugins.banchat.done", ".")]);
  assert.ok((await pipeline.getBannedChats()).has(banned));
  assert.ok(await db.BannedChat.findByPk(banned), "stored in the database");

  // messages sent before the ban were tracked (in the background): let them land, then take a baseline
  await sleep(100);
  const trackedBeforeBan = await db.UserStats.sum("messageCount", { where: { groupJid: banned } });

  // ignored by everybody, owner included, whatever the command
  assert.deepEqual(textsOf(await member(".ping")), []);
  assert.deepEqual(textsOf(await w.owner(banned, ".ping")), []);
  assert.deepEqual(textsOf(await w.owner(banned, ".welcome on")), []);
  assert.deepEqual(textsOf(await member(".unban")), [], "a member cannot unban (dropped silently)");
  // and not by the hooks either: nothing is tracked or filtered in a disabled chat
  await member("hello?");
  await sleep(100);
  assert.equal(await db.UserStats.sum("messageCount", { where: { groupJid: banned } }), trackedBeforeBan, "no tracking in a disabled chat");

  // other chats are not affected
  assert.ok((await member(".ping", other)).length >= 1);

  // persistence: drop every cache, the ban is read back from the database
  settingsCache.clear();
  assert.ok((await pipeline.getBannedChats()).has(banned), "ban survives a cache flush");
  assert.deepEqual(textsOf(await member(".ping")), []);

  // ...and a re-require of the pipeline module
  for (const key of Object.keys(require.cache)) {
    if (key.endsWith("/lib/core/pipeline.js")) delete require.cache[key];
  }
  const fresh = require("../lib/core/pipeline");
  assert.notEqual(fresh, pipeline, "the pipeline module was reloaded");
  assert.ok((await fresh.getBannedChats()).has(banned), "ban survives a re-require");
  invalidateGroupMetadata();
  const freshSock = fakes.fakeSocket();
  const freshClient = fakes.fakeClient(freshSock);
  await fresh.processMessage(fakes.rawMessage({ body: ".ping", from: IDS.MEMBER_PN, group: banned }), freshClient);
  assert.deepEqual(freshSock.sent, [], "still ignored through the reloaded pipeline");

  // owner unban, addressed by LID, gets through the gate
  const unbanned = await w.say({ body: ".unban", from: IDS.OWNER_PN, lid: true, group: banned });
  assert.deepEqual(textsOf(unbanned), [getLang("plugins.unbanchat.done")]);
  assert.equal(await db.BannedChat.findByPk(banned), null);
  assert.ok((await member(".ping")).length >= 1, ".ping answers again after unban");

  // unban of a chat that is not banned
  assert.deepEqual(textsOf(await w.owner(banned, ".unban")), [getLang("plugins.unbanchat.not_banned")]);
});

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

async function statsOf(group, jid = PN(333)) {
  return db.UserStats.findOne({ where: { jid, groupJid: group }, raw: true });
}

/** Wait until the (fire-and-forget) tracker has written `count` messages */
async function waitForCount(group, count, jid) {
  const ok = await fakes.waitFor(async () => (await statsOf(group, jid))?.messageCount >= count, { timeout: 2000, interval: 10 });
  return { ok: !!ok, stats: await statsOf(group, jid) };
}

test("tracking: 3 group messages → messageCount 3 (once XP, atomic under concurrency); private chats are not tracked", async () => {
  const group = newGroup();
  const w = world();
  const member = (body, extra = {}) => w.say({ body, from: IDS.MEMBER_PN, group, ...extra });

  await member("one");
  let { ok, stats } = await waitForCount(group, 1);
  assert.ok(ok, "first message tracked");
  const xpAfterFirst = stats.xp;
  assert.ok(xpAfterFirst > 0, "the first message grants XP");

  await member("two", { lid: true }); // same person addressed by LID: same row
  await member("three");
  ({ ok, stats } = await waitForCount(group, 3));
  assert.ok(ok, `expected messageCount 3, got ${JSON.stringify(stats)}`);
  assert.equal(stats.messageCount, 3);
  assert.equal(stats.xp, xpAfterFirst, "XP is granted once a minute, counters always grow");
  assert.equal(await db.UserStats.count({ where: { groupJid: group } }), 1, "one row for the person (PN and LID forms share it)");

  // concurrent messages: increments are atomic
  await Promise.all(Array.from({ length: 5 }, (_, i) => member(`burst ${i}`)));
  ({ ok, stats } = await waitForCount(group, 8));
  assert.ok(ok);
  assert.equal(stats.messageCount, 8, "5 concurrent messages add exactly 5");

  // media counts as a message and a media
  await member("a picture", { media: "image" });
  ({ stats } = await waitForCount(group, 9));
  assert.equal(stats.messageCount, 9);
  assert.equal(stats.mediaCount, 1);

  // not tracked: private chat, the bot's own messages, reactions, button replies
  const beforeCount = await db.UserStats.count();
  await w.say({ body: "hello in private", from: IDS.MEMBER_PN });
  await w.say({ body: "bot talking", from: IDS.BOT_PN, fromMe: true, group });
  await w.say({ from: IDS.MEMBER_PN, group, message: { reactionMessage: { text: "👍", key: { remoteJid: group, id: "X" } } } });
  await w.say({ from: IDS.MEMBER_PN, group, interactive: { id: "nothing:claims:this", kind: "button" } });
  await sleep(100);
  assert.equal(await db.UserStats.count(), beforeCount, "no row created by private / bot / reaction / button messages");
  assert.equal(await db.UserStats.count({ where: { groupJid: IDS.MEMBER_PN } }), 0);
  assert.equal((await statsOf(group)).messageCount, 9);
});

// ---------------------------------------------------------------------------
// Hook order
// ---------------------------------------------------------------------------

test("onMessage hooks run by priority: knownchats, role, tracking, afk, notify, groupguard, then filters", () => {
  const files = registry.getHooks("onMessage").map((h) => h.file);
  const order = [
    "knownchats.js",
    "role.js",
    "trackmessages.js",
    "afk.js",
    "notify.js",
    "groupguard.js",
    "addfilter.js",
    "zz-probe.js",
  ];
  const positions = order.map((file) => files.indexOf(file));
  assert.ok(positions.every((p) => p >= 0), `missing onMessage hook(s): ${order.filter((f, i) => positions[i] < 0).join(", ")} (have ${files.join(", ")})`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, `onMessage order should be ${order.join(" -> ")}, got ${files.join(" -> ")}`);
});

test("a message that matches a filter is still counted by tracking and still clears AFK", async () => {
  const group = newGroup();
  const w = world();
  const member = (body, extra = {}) => w.say({ body, from: IDS.MEMBER_PN, group, ...extra });

  await w.owner(group, ".filter hello=Hi from the filter");
  cooldown.reset(group, "filter:hello");
  await member(".afk napping");
  assert.ok((await db.User.findByPk(PN(333))).afkTime, "member is away");

  const seenBefore = probeSeen.length;
  const sent = await member("hello everybody");

  const texts = textsOf(sent);
  assert.ok(texts.includes("Hi from the filter"), `the filter answered: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((t) => /@333/.test(t) && t !== "Hi from the filter"), `AFK 'back' reply was sent: ${JSON.stringify(texts)}`);
  assert.equal((await db.User.findByPk(PN(333))).afkTime, null, "AFK cleared although the filter consumed the message");
  assert.equal(probeSeen.length, seenBefore, "the filter did stop the pipeline");

  const { ok, stats } = await waitForCount(group, 2); // ".afk napping" + "hello everybody" (the filter command was the owner's)
  assert.ok(ok, `tracking counted the filter-matching message: ${JSON.stringify(stats)}`);
});

// ---------------------------------------------------------------------------
// Reminders / scheduler
// ---------------------------------------------------------------------------

test("scheduler: tick() does nothing until start(), and not while the client is disconnected", async () => {
  const w = world();
  const chat = newGroup();
  const row = await db.Reminder.create({ chatJid: chat, creatorJid: IDS.OWNER_PN, text: "before start", dueAt: new Date(Date.now() - 5000) });

  assert.equal(scheduler.isRunning(), false);
  assert.deepEqual(await scheduler.tick(), { due: 0, sent: 0, retried: 0, failed: 0, missed: 0, skipped: 0 });
  assert.equal((await db.Reminder.findByPk(row.id)).status, "pending");

  await scheduler.start(w.client);
  assert.equal(scheduler.isRunning(), true);
  await scheduler.start(w.client); // idempotent (reconnection)
  assert.equal(scheduler.isRunning(), true);

  // disconnected: skipped without burning an attempt
  w.client.ready = () => false;
  assert.equal((await scheduler.tick()).sent, 0);
  assert.deepEqual(w.sock.sent, []);
  assert.equal((await db.Reminder.findByPk(row.id)).attempts, 0);
  w.client.ready = () => true;

  scheduler.stop();
  assert.equal(scheduler.isRunning(), false);
  assert.equal((await scheduler.tick()).due, 0, "stopped: nothing is delivered");
  await db.Reminder.update({ status: "cancelled" }, { where: { id: row.id } });
});

test("scheduler: a reminder due in the past is delivered exactly once (even with concurrent ticks), then status sent", async () => {
  const w = world();
  const chat = newGroup();
  await scheduler.start(w.client);
  try {
    const rows = [];
    for (const text of ["water the plants", "call mom", "pay rent"]) {
      rows.push(await db.Reminder.create({ chatJid: chat, creatorJid: IDS.OWNER_PN, text, dueAt: new Date(Date.now() - 2000) }));
    }
    const notDue = await db.Reminder.create({ chatJid: chat, creatorJid: IDS.OWNER_PN, text: "tomorrow", dueAt: new Date(Date.now() + 3600 * 1000) });

    const results = await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]);
    const total = (key) => results.reduce((sum, r) => sum + r[key], 0);
    assert.equal(total("sent"), 3, `each reminder is sent by exactly one tick: ${JSON.stringify(results)}`);
    assert.equal(total("failed") + total("retried") + total("missed"), 0);

    const sends = w.sentSince(0);
    assert.equal(sends.length, 3, `exactly 3 messages, got ${JSON.stringify(textsOf(sends))}`);
    for (const row of rows) {
      const send = sends.filter((s) => s.text.includes(row.text));
      assert.equal(send.length, 1, `"${row.text}" delivered once`);
      assert.equal(send[0].jid, chat);
      assert.deepEqual(send[0].content.mentions, [IDS.OWNER_PN], "the creator is mentioned");
      assert.match(send[0].text, /@111/);
      const stored = await db.Reminder.findByPk(row.id);
      assert.equal(stored.status, "sent");
      assert.ok(stored.sentAt, "sentAt is stored");
    }
    assert.equal((await db.Reminder.findByPk(notDue.id)).status, "pending", "a future reminder is left alone");

    // later ticks: nothing more
    const again = await scheduler.tick();
    assert.equal(again.sent, 0);
    assert.equal(w.sentSince(0).length, 3, "no duplicate on the next tick");
    // until its time comes
    const later = await scheduler.tick(Date.now() + 2 * 3600 * 1000);
    assert.equal(later.sent, 1);
    assert.match(w.sentSince(3)[0].text, /tomorrow/);
  } finally {
    scheduler.stop();
  }
});

test("scheduler: a failed send is retried later (nothing leaked to the chat); very old reminders are marked missed", async () => {
  const w = world();
  const chat = newGroup();
  await scheduler.start(w.client);
  try {
    // a send failure: stays pending with a later dueAt, the error is only stored
    const flaky = await db.Reminder.create({ chatJid: chat, creatorJid: IDS.OWNER_PN, text: "flaky one", dueAt: new Date(Date.now() - 2000) });
    const realSend = w.sock.sendMessage;
    let failures = 1;
    w.sock.sendMessage = async (...args) => {
      if (failures-- > 0) throw new Error("boom secret");
      return realSend(...args);
    };
    const first = await scheduler.tick();
    assert.equal(first.retried, 1);
    assert.equal(first.sent, 0);
    let stored = await db.Reminder.findByPk(flaky.id);
    assert.equal(stored.status, "pending");
    assert.equal(stored.attempts, 1);
    assert.ok(new Date(stored.dueAt).getTime() > Date.now(), "the retry is scheduled in the future");
    assert.deepEqual(w.sock.sent, [], "the failure is not shown to anybody");

    assert.equal((await scheduler.tick()).sent, 0, "not due again yet");
    const retry = await scheduler.tick(Date.now() + 5 * 60 * 1000);
    assert.equal(retry.sent, 1);
    assert.equal((await db.Reminder.findByPk(flaky.id)).status, "sent");
    w.sock.sendMessage = realSend;

    // overdue by more than 6 h: not sent, marked missed, its creator told once in DM
    const old = await db.Reminder.create({ chatJid: chat, creatorJid: IDS.OWNER_PN, text: "ancient news", dueAt: new Date(Date.now() - 7 * 3600 * 1000) });
    const before = w.sock.sent.length;
    const missed = await scheduler.tick();
    assert.equal(missed.missed, 1);
    assert.equal(missed.sent, 0);
    assert.equal((await db.Reminder.findByPk(old.id)).status, "missed");
    const notices = w.sentSince(before);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].jid, IDS.OWNER_PN, "the creator gets the notice by DM");
    assert.match(notices[0].text, /ancient news/);
  } finally {
    scheduler.stop();
  }
});

test("reminders end to end: .remind creates it, the ready hook starts the scheduler, tick() delivers it once, cancel works", async () => {
  const w = world();
  const chat = newGroup();

  // the connection opens: the reminder plugin starts the scheduler (also on a reconnection)
  await w.client.dispatch("ready");
  await w.client.dispatch("ready");
  assert.equal(scheduler.isRunning(), true, "onReady starts the scheduler");

  try {
    const created = await w.owner(chat, ".remind 10s buy milk");
    assert.equal(created.length, 1, `expected an acknowledgement, got ${JSON.stringify(textsOf(created))}`);
    const pending = await scheduler.list({ chatJid: chat });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].text, "buy milk");
    assert.equal(pending[0].status, "pending");

    const cancelled = await w.owner(chat, ".remind 20s call the bank");
    assert.equal(cancelled.length, 1);
    const [, bank] = await scheduler.list({ chatJid: chat });
    assert.equal(bank.text, "call the bank");
    assert.equal(await scheduler.cancel(bank.id), true);
    assert.equal(await scheduler.cancel(bank.id), false, "cancelling twice does nothing");

    const before = w.sock.sent.length;
    const stats = await scheduler.tick(Date.now() + 60 * 1000);
    assert.equal(stats.sent, 1, "only the live reminder is delivered");
    const sends = w.sentSince(before);
    assert.equal(sends.length, 1);
    assert.match(sends[0].text, /buy milk/);
    assert.doesNotMatch(sends[0].text, /bank/);
    assert.equal((await db.Reminder.findByPk(pending[0].id)).status, "sent");
    assert.equal((await db.Reminder.findByPk(bank.id)).status, "cancelled");
    assert.equal((await scheduler.tick(Date.now() + 60 * 1000)).sent, 0, "delivered once");
  } finally {
    scheduler.stop();
  }
});
