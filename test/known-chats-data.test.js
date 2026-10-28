"use strict";
/**
 * lib/utils/knownChats.js, data layer only (specs/002-admin-panel T015, data-model 1.9,
 * runtime.md section 8, FR-046). The hook plugin and the routes belong to W-GRP.
 *
 *  - record() stores a private chat once and writes `lastSeenAt` at most once per hour per JID;
 *  - listDestinations() / assertDestinations(): private rows not in BannedChat, group rows not
 *    left, de-duplicated by `pnJid || jid`; a typed number, status@broadcast, a left group and
 *    a banned chat are refused with `invalid_destination`;
 *  - markLeft / clearLeft / refreshGroups; pruneSilent; seedIfEmpty; list() for CHAT-1.
 */

const { test, describe, before, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv();
const knownChats = require("../lib/utils/knownChats");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);

const PN_A = "237600000001@s.whatsapp.net";
const PN_B = "237600000002@s.whatsapp.net";
const LID_A = "900000000001@lid";
const LID_C = "900000000003@lid";
const G1 = "120363000000000001@g.us";
const G2 = "120363000000000002@g.us";
const G3 = "120363000000000003@g.us";

let db;

const dm = (jid, extra = {}) => ({ jid, isGroup: false, fromMe: false, sender: jid, ...extra });
const row = async (jid) => db.KnownChat.findByPk(jid, { raw: true });
const jids = async () => (await db.KnownChat.findAll({ order: [["jid", "ASC"]], raw: true })).map((r) => r.jid);

async function chat(jid, kind, extra = {}) {
  const at = new Date(extra.lastSeenAt || T0);
  return db.KnownChat.create({ jid, kind, firstSeenAt: at, lastSeenAt: at, ...extra });
}

before(async () => {
  db = await fakes.syncDb();
});

beforeEach(async () => {
  knownChats._reset();
  for (const model of ["KnownChat", "BannedChat", "Conversation", "User", "Group", "Filter", "GroupRole", "UserStats", "Warn", "GroupEconomy", "Idea", "Quote"]) {
    await db[model].destroy({ where: {} });
  }
});

afterEach(() => {
  mock.restoreAll();
});

describe("record()", () => {
  test("stores a private chat the first time it writes, with its phone number and push name", async () => {
    await knownChats.record(dm(LID_A, { sender: PN_A, pushName: "Alice" }), { now: T0 });
    const stored = await row(LID_A);
    assert.equal(stored.kind, "private");
    assert.equal(stored.pnJid, PN_A);
    assert.equal(stored.name, "Alice");
    assert.deepEqual(new Date(stored.firstSeenAt), new Date(T0));
    assert.deepEqual(new Date(stored.lastSeenAt), new Date(T0));
    assert.equal(stored.leftAt, null);

    await knownChats.record(dm(PN_B, { data: { pushName: "Bob" } }), { now: T0 });
    const pn = await row(PN_B);
    assert.equal(pn.pnJid, PN_B, "a phone-number chat is its own phone number");
    assert.equal(pn.name, "Bob", "push name from the raw message");
  });

  test("a LID chat whose phone number is unknown has no pnJid", async () => {
    await knownChats.record(dm(LID_C, { sender: LID_C }), { now: T0 });
    assert.equal((await row(LID_C)).pnJid, null);
  });

  test("throttles lastSeenAt writes to one per hour per JID", async () => {
    const bulkCreate = mock.method(db.KnownChat, "bulkCreate");

    assert.ok(knownChats.record(dm(PN_A, { pushName: "Alice" }), { now: T0 }));
    assert.equal(knownChats.record(dm(PN_A), { now: T0 + 1000 }), null, "same instant: throttled");
    assert.equal(knownChats.record(dm(PN_A), { now: T0 + 59 * 60 * 1000 }), null, "59 minutes: throttled");
    assert.ok(knownChats.record(dm(PN_B), { now: T0 + 1000 }), "another JID is not throttled");
    assert.equal(bulkCreate.mock.calls.length, 2);
    await Promise.all(bulkCreate.mock.calls.map((c) => c.result));

    assert.ok(knownChats.record(dm(PN_A), { now: T0 + HOUR }), "one hour later: written again");
    await bulkCreate.mock.calls.at(-1).result;
    assert.equal(bulkCreate.mock.calls.length, 3);

    const stored = await row(PN_A);
    assert.deepEqual(new Date(stored.lastSeenAt), new Date(T0 + HOUR), "lastSeenAt moved");
    assert.deepEqual(new Date(stored.firstSeenAt), new Date(T0), "firstSeenAt did not");
    assert.equal(stored.name, "Alice", "a message without push name keeps the known name");
    assert.equal(await db.KnownChat.count(), 2);
  });

  test("a new push name replaces the old one", async () => {
    await knownChats.record(dm(PN_A, { pushName: "Alice" }), { now: T0 });
    await knownChats.record(dm(PN_A, { pushName: "Alice M." }), { now: T0 + 2 * HOUR });
    assert.equal((await row(PN_A)).name, "Alice M.");
  });

  test("entries older than 1 h are dropped from the throttle map on each write", async () => {
    await knownChats.record(dm(PN_A), { now: T0 });
    await knownChats.record(dm(PN_B), { now: T0 + 45 * 60 * 1000 });
    assert.equal(knownChats._touchedSize(), 2);
    // PN_A is now 90 min old (dropped), PN_B 45 min old (kept)
    await knownChats.record(dm(LID_C), { now: T0 + 90 * 60 * 1000 });
    assert.equal(knownChats._touchedSize(), 2);
    assert.equal(knownChats.record(dm(PN_B), { now: T0 + 90 * 60 * 1000 }), null, "PN_B is still throttled");
    assert.ok(knownChats.record(dm(PN_A), { now: T0 + 90 * 60 * 1000 }), "PN_A may be written again");
  });

  test("ignores groups, own messages, status, newsletters, broadcast lists and junk", async () => {
    const bulkCreate = mock.method(db.KnownChat, "bulkCreate");
    const ignored = [
      { jid: G1, isGroup: true, fromMe: false, sender: PN_A },
      dm(PN_A, { fromMe: true }),
      dm("status@broadcast"),
      dm("120363000000000099@newsletter"),
      dm("1234567890@broadcast"),
      dm(""),
      dm(undefined),
      null,
      undefined,
      {},
    ];
    for (const message of ignored) assert.equal(knownChats.record(message, { now: T0 }), null);
    assert.equal(bulkCreate.mock.calls.length, 0);
    assert.equal(await db.KnownChat.count(), 0);
  });

  test("never throws or rejects: a failed write is logged and retried with the next message", async () => {
    mock.method(db.KnownChat, "bulkCreate", async () => {
      throw new Error("database is down");
    }, { times: 1 });
    await assert.doesNotReject(knownChats.record(dm(PN_A), { now: T0 }));
    assert.equal(await db.KnownChat.count(), 0);

    const retry = knownChats.record(dm(PN_A), { now: T0 + 1000 });
    assert.ok(retry, "the throttle entry was released by the failure");
    await retry;
    assert.equal(await db.KnownChat.count(), 1);
  });
});

describe("destinations", () => {
  async function fill() {
    await chat(PN_A, "private", { pnJid: PN_A, name: "Alice", lastSeenAt: T0 - 1000 });
    await chat(LID_A, "private", { pnJid: PN_A, name: "Alice (lid)", lastSeenAt: T0 }); // same person, newer row
    await chat(PN_B, "private", { pnJid: PN_B, name: "Bob", lastSeenAt: T0 - 5000 });
    await chat(LID_C, "private", { pnJid: null, name: "Chloé", lastSeenAt: T0 - 9000 });
    await chat(G1, "group", { name: "Famille", lastSeenAt: T0 - 2000 });
    await chat(G2, "group", { name: "Ancien groupe", leftAt: new Date(T0 - DAY), lastSeenAt: T0 - 3000 });
  }

  test("listDestinations: private rows and groups not left, de-duplicated by pnJid || jid", async () => {
    await fill();
    const items = await knownChats.listDestinations();
    assert.deepEqual(items.map((i) => i.jid), [LID_A, G1, PN_B, LID_C], "newest first, one row per person");
    assert.ok(!items.some((i) => i.jid === G2), "a left group is not a destination");
    assert.deepEqual(Object.keys(items[0]).sort(), ["jid", "kind", "lastSeenAt", "name", "pnJid"]);
  });

  test("listDestinations: banned chats are excluded, by JID or by phone number", async () => {
    await fill();
    await db.BannedChat.create({ jid: PN_B });
    await db.BannedChat.create({ jid: PN_A }); // banned under the phone number, seen as LID too
    const items = await knownChats.listDestinations();
    assert.deepEqual(items.map((i) => i.jid), [G1, LID_C]);
  });

  test("listDestinations: a banned duplicate does not hide the usable row of the same person", async () => {
    await fill();
    await db.BannedChat.create({ jid: LID_A });
    const items = await knownChats.listDestinations();
    assert.ok(items.some((i) => i.pnJid === PN_A), "the phone-number row stays a destination");
    assert.ok(!items.some((i) => i.jid === LID_A));
  });

  test("listDestinations: kind and q filters (name, JID, case-insensitive)", async () => {
    await fill();
    assert.deepEqual((await knownChats.listDestinations({ kind: "group" })).map((i) => i.jid), [G1]);
    assert.deepEqual((await knownChats.listDestinations({ kind: "private" })).map((i) => i.jid), [LID_A, PN_B, LID_C]);
    assert.deepEqual((await knownChats.listDestinations({ q: "FAMI" })).map((i) => i.jid), [G1]);
    assert.deepEqual((await knownChats.listDestinations({ q: "chlo" })).map((i) => i.jid), [LID_C]);
    assert.deepEqual((await knownChats.listDestinations({ q: "00002" })).map((i) => i.jid), [PN_B]);
    assert.deepEqual(await knownChats.listDestinations({ q: "nobody" }), []);
  });

  test("assertDestinations accepts known destinations and de-duplicates by phone number", async () => {
    await fill();
    assert.deepEqual(await knownChats.assertDestinations([G1, PN_B]), [G1, PN_B]);
    assert.deepEqual(await knownChats.assertDestinations([PN_A, LID_A, G1]), [PN_A, G1], "one destination per person");
    assert.deepEqual(await knownChats.assertDestinations([]), []);
  });

  test("assertDestinations refuses a number typed by hand, status@broadcast, a left group and a banned chat (FR-046)", async () => {
    await fill();
    await db.BannedChat.create({ jid: PN_B });
    const cases = {
      "a number typed by hand": ["237699999999@s.whatsapp.net"],
      "a bare number": ["237699999999"],
      "status@broadcast": ["status@broadcast"],
      "a group never seen": [G3],
      "a left group": [G2],
      "a banned chat": [PN_B],
      "junk": [null, 42, "", {}],
    };
    for (const [label, list] of Object.entries(cases)) {
      await assert.rejects(knownChats.assertDestinations(list), (err) => {
        assert.equal(err.code, "invalid_destination", label);
        assert.deepEqual(err.params.indices, list.map((_, i) => i), label);
        return true;
      });
    }
    await assert.rejects(knownChats.assertDestinations("not a list"), { code: "invalid_destination" });
    await assert.rejects(knownChats.assertDestinations(undefined), { code: "invalid_destination" });
  });

  test("assertDestinations reports the positions of every refused entry, never the values", async () => {
    await fill();
    await assert.rejects(knownChats.assertDestinations([G1, "12345", PN_B, G2, G3]), (err) => {
      assert.deepEqual(err.params, { indices: [1, 3, 4] });
      assert.doesNotMatch(err.message, /12345/);
      return true;
    });
  });
});

describe("former groups", () => {
  test("markLeft sets leftAt once; clearLeft brings the group back", async () => {
    await chat(G1, "group", { name: "Famille" });
    assert.equal(await knownChats.markLeft(G1, T0 + DAY), true);
    assert.deepEqual(new Date((await row(G1)).leftAt), new Date(T0 + DAY));
    assert.equal(await knownChats.markLeft(G1, T0 + 2 * DAY), false, "already left");
    assert.deepEqual(new Date((await row(G1)).leftAt), new Date(T0 + DAY), "the first leftAt is kept");
    assert.equal((await knownChats.listDestinations()).length, 0);

    assert.equal(await knownChats.clearLeft(G1), true);
    assert.equal((await row(G1)).leftAt, null);
    assert.equal(await knownChats.clearLeft(G1), false, "nothing to clear");
    assert.equal((await knownChats.listDestinations()).length, 1);
  });

  test("markLeft records an unknown group as already left; a non-group JID is ignored", async () => {
    assert.equal(await knownChats.markLeft(G3, T0), true);
    const stored = await row(G3);
    assert.equal(stored.kind, "group");
    assert.deepEqual(new Date(stored.leftAt), new Date(T0));
    assert.equal(await knownChats.markLeft(PN_A, T0), false);
    assert.equal(await knownChats.markLeft(undefined, T0), false);
    assert.equal(await row(PN_A), null);
  });

  test("refreshGroups adds groups, updates names, marks absent groups as left and brings back returning ones", async () => {
    await chat(G1, "group", { name: "Old name" });
    await chat(G2, "group", { name: "Gone" });
    await chat(G3, "group", { name: "Returning", leftAt: new Date(T0 - DAY) });
    await chat(PN_A, "private", { pnJid: PN_A });

    const result = await knownChats.refreshGroups(
      [
        { id: G1, subject: "New name" },
        { id: G3, subject: "Returning" },
        { id: "120363000000000004@g.us", subject: "Brand new" },
        { id: "not-a-group@s.whatsapp.net", subject: "ignored" },
      ],
      T0 + HOUR,
    );
    assert.deepEqual(result, { listed: 3, added: 1, back: 1, left: 1 });

    assert.equal((await row(G1)).name, "New name");
    assert.equal((await row(G1)).leftAt, null);
    assert.deepEqual(new Date((await row(G1)).lastSeenAt), new Date(T0 + HOUR));
    assert.deepEqual(new Date((await row(G2)).leftAt), new Date(T0 + HOUR), "absent group is a former group");
    assert.equal((await row(G3)).leftAt, null, "back");
    assert.equal((await row("120363000000000004@g.us")).name, "Brand new");
    assert.equal((await row(PN_A)).leftAt, null, "private chats are not touched");

    // a second pass keeps the first leftAt
    await knownChats.refreshGroups([{ id: G1, subject: "New name" }], T0 + 2 * HOUR);
    assert.deepEqual(new Date((await row(G2)).leftAt), new Date(T0 + HOUR));
  });

  test("refreshGroups accepts the object keyed by JID that Baileys returns and keeps a known name when the subject is missing", async () => {
    await chat(G1, "group", { name: "Kept" });
    await knownChats.refreshGroups({ [G1]: { subject: "" }, [G2]: { subject: "Second" } }, T0);
    assert.equal((await row(G1)).name, "Kept");
    assert.equal((await row(G2)).name, "Second");
  });
});

describe("retention", () => {
  test("pruneSilent deletes private rows silent for more than 365 days and keeps groups", async () => {
    const now = T0;
    await chat(PN_A, "private", { lastSeenAt: now - 366 * DAY });
    await chat(PN_B, "private", { lastSeenAt: now - 364 * DAY });
    await chat(LID_C, "private", { lastSeenAt: now - 400 * DAY });
    await chat(G1, "group", { lastSeenAt: now - 800 * DAY, leftAt: new Date(now - 700 * DAY) });
    assert.equal(await knownChats.pruneSilent(now), 2);
    assert.deepEqual(await jids(), [PN_B, G1].sort());
    assert.equal(await knownChats.pruneSilent(now), 0, "idempotent");
  });

  test("remove forgets a chat", async () => {
    await chat(G1, "group");
    assert.equal(await knownChats.remove(G1), true);
    assert.equal(await knownChats.remove(G1), false);
    assert.equal(await db.KnownChat.count(), 0);
  });
});

describe("seedIfEmpty()", () => {
  test("seeds from Conversation, User and the group JIDs of the other tables", async () => {
    await db.Conversation.create({ jid: PN_A });
    await db.Conversation.create({ jid: G3 }); // a group in Conversation is not a private chat
    await db.User.create({ jid: PN_B });
    await db.User.create({ jid: LID_C });
    await db.User.create({ jid: PN_A }); // already seen through Conversation
    await db.Group.create({ jid: G1, name: "Famille" });
    await db.Filter.create({ pattern: "hi", response: "yo", groupJid: G2 });
    await db.Filter.create({ pattern: "global", response: "yo", groupJid: null, isGlobal: true });
    await db.GroupRole.create({ groupJid: G3, userJid: PN_A });
    await db.UserStats.create({ jid: PN_A, groupJid: "120363000000000010@g.us" });
    await db.Warn.create({ jid: PN_A, groupJid: "120363000000000011@g.us" });
    await db.GroupEconomy.create({ groupJid: "120363000000000012@g.us", userJid: PN_A });
    await db.Idea.create({ groupJid: "120363000000000013@g.us", authorJid: PN_A, text: "x" });
    await db.Quote.create({ groupJid: "120363000000000014@g.us", authorJid: PN_A, text: "x", savedBy: PN_B });

    assert.equal(await knownChats.seedIfEmpty({ now: T0 }), 11);
    const stored = await db.KnownChat.findAll({ order: [["jid", "ASC"]], raw: true });
    assert.equal(stored.length, 11);
    assert.deepEqual(
      stored.filter((r) => r.kind === "private").map((r) => r.jid).sort(),
      [LID_C, PN_A, PN_B].sort(),
    );
    assert.equal(stored.filter((r) => r.kind === "group").length, 8);
    assert.ok(stored.every((r) => r.leftAt === null));
    assert.equal(stored.find((r) => r.jid === G1).name, "Famille", "group names come from Group");
    assert.equal(stored.find((r) => r.jid === PN_A).pnJid, PN_A);
    assert.equal(stored.find((r) => r.jid === LID_C).pnJid, null);
    assert.deepEqual(new Date(stored[0].firstSeenAt), new Date(T0));
  });

  test("does nothing when the table already has a row, and is idempotent", async () => {
    await db.Conversation.create({ jid: PN_A });
    await chat(G1, "group");
    assert.equal(await knownChats.seedIfEmpty(), 0);
    assert.deepEqual(await jids(), [G1]);

    await db.KnownChat.destroy({ where: {} });
    assert.equal(await knownChats.seedIfEmpty(), 1);
    assert.equal(await knownChats.seedIfEmpty(), 0);
  });

  test("an empty database seeds nothing", async () => {
    assert.equal(await knownChats.seedIfEmpty(), 0);
  });
});

describe("list() for the picker (CHAT-1)", () => {
  async function fill() {
    await chat(PN_A, "private", { pnJid: PN_A, name: "Alice", lastSeenAt: T0 - 1000 });
    await chat(LID_A, "private", { pnJid: PN_A, name: "Alice", lastSeenAt: T0 });
    await chat(PN_B, "private", { pnJid: PN_B, name: "Bob", lastSeenAt: T0 - 5000 });
    await chat(G1, "group", { name: "Famille", lastSeenAt: T0 - 2000 });
    await chat(G2, "group", { name: "Ancien", lastSeenAt: T0 - 3000, leftAt: new Date(T0 - DAY) });
    await db.BannedChat.create({ jid: PN_B });
  }

  test("every kind of row with its `selectable` flag, one row per person", async () => {
    await fill();
    const result = await knownChats.list();
    assert.equal(result.total, 4);
    assert.deepEqual(result.items.map((i) => [i.jid, i.selectable]), [
      [LID_A, true],
      [G1, true],
      [G2, false],
      [PN_B, false],
    ]);
    assert.deepEqual(Object.keys(result.items[0]).sort(), ["jid", "kind", "lastSeenAt", "name", "selectable"]);
    assert.deepEqual([result.page, result.pageSize], [1, 50]);
  });

  test("selectable keeps only valid destinations; kind and q filter; pagination", async () => {
    await fill();
    assert.deepEqual((await knownChats.list({ selectable: true })).items.map((i) => i.jid), [LID_A, G1]);
    assert.deepEqual((await knownChats.list({ kind: "group" })).items.map((i) => i.jid), [G1, G2]);
    assert.deepEqual((await knownChats.list({ q: "bob" })).items.map((i) => i.jid), [PN_B]);

    const first = await knownChats.list({ page: 1, pageSize: 3 });
    assert.deepEqual([first.items.length, first.total, first.page, first.pageSize], [3, 4, 1, 3]);
    const second = await knownChats.list({ page: 2, pageSize: 3 });
    assert.deepEqual([second.items.length, second.page], [1, 2]);
    assert.equal((await knownChats.list({ page: 99, pageSize: 3 })).page, 2, "a page past the end is clamped");
    assert.equal((await knownChats.list({ pageSize: 5000 })).pageSize, 200);
  });

  test("an empty table gives an empty page", async () => {
    assert.deepEqual(await knownChats.list(), { items: [], page: 1, pageSize: 50, total: 0 });
  });
});
