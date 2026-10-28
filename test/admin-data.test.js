"use strict";
/**
 * DATA-1 to DATA-3 of the admin panel (T150, FR-042 to FR-045; admin-http-api.md 2.10), through the real createAdmin
 * and an in-memory database.
 *
 *  - DATA-1: the eight kinds with their item shapes, the q / chat / groupJid / status filters, pagination, the
 *    refusals (unknown kind 404, economy without a group 422, unknown parameters);
 *  - DATA-2: a cancelled reminder is never sent (scheduler.tick after the cancel), 409 not_pending, afk keeps the row,
 *    economy has no delete, and every delete is visible at once to the command that reads it (afk_users, the notify:
 *    prefix and sticker_cmds), audit data.delete;
 *  - DATA-3 (FR-043): 20 concurrent `give` commands and 20 panel adds end at the exact sum, a debit that would go
 *    negative is refused (422 negative_balance, nothing written), "set" computes the delta in the same transaction,
 *    the economy.adjust audit row commits or fails with the balance, both identity forms.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ lang: "fr", sudo: "111" });

const { createTestAdmin } = require("./helpers/adminHarness");
const { createDataService, preview } = require("../lib/admin/services/data");
const settingsCache = require("../lib/utils/settingsCache");
const scheduler = require("../lib/utils/scheduler");
const economy = require("../plugins/economy");
const cooldown = require("../lib/utils/cooldown");

const G1 = "120363111111111111@g.us";
const G2 = "120363222222222222@g.us";
const U1 = "237690000001@s.whatsapp.net";
const U2 = "237690000002@s.whatsapp.net";
const U3 = "237690000003@s.whatsapp.net";

const TABLES = ["Reminder", "GroupEconomy", "NotifyKeyword", "StickerCommand", "User", "Task", "Idea", "Quote", "KnownChat"];

let db;
let t;
let client;
let bot; // the fake WhatsApp client handed to the panel and to the scheduler

before(async () => {
  db = await fakes.syncDb();
});

after(() => {
  scheduler.stop();
});

beforeEach(async () => {
  for (const name of TABLES) await db[name].destroy({ where: {} });
  settingsCache.clear();
  bot = fakes.fakeClient(fakes.fakeSocket());
  t = await createTestAdmin({ deps: { client: bot } });
  await t.admin.start();
  client = await t.loginClient();
});

afterEach(async () => {
  scheduler.stop();
  await t.close();
});

const query = (params) => {
  const search = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== "")).toString();
  return search ? `?${search}` : "";
};
const list = (kind, params) => client.get(`/admin/api/data/${kind}${query(params)}`);
const remove = (kind, id) => client.api("DELETE", `/admin/api/data/${kind}/${encodeURIComponent(id)}`);
const adjust = (body) => client.api("POST", "/admin/api/data/economy/adjust", body);
const auditRows = (where = {}) => t.db.AuditLog.findAll({ where, raw: true, order: [["id", "ASC"]] });
const balanceOf = async (groupJid, userJid) => {
  const row = await db.GroupEconomy.findOne({ where: { groupJid, userJid }, raw: true });
  return row ? row.balance : null;
};
const accounts = (groupJid) => db.GroupEconomy.findAll({ where: { groupJid }, raw: true, order: [["userJid", "ASC"]] });
const reminder = (over = {}) =>
  db.Reminder.create({ chatJid: G1, creatorJid: U1, text: "water the plants", dueAt: new Date(Date.now() + 3600 * 1000), ...over });

describe("DATA-1: GET /admin/api/data/:kind", () => {
  test("is a session route", async () => {
    const answer = await t.client().get("/admin/api/data/tasks");
    assert.equal(answer.status, 401);
  });

  test("an unknown kind is 404; economy needs a group; bad parameters are refused", async () => {
    assert.equal((await list("users")).status, 404);
    assert.equal((await list("constructor")).status, 404);

    let answer = await list("economy");
    assert.equal(answer.status, 422);
    assert.equal(answer.json.error.code, "validation_failed");
    assert.equal(answer.json.error.fields.groupJid.code, "required");
    answer = await list("economy", { groupJid: "123@s.whatsapp.net" });
    assert.equal(answer.json.error.fields.groupJid.code, "invalid_jid");

    answer = await list("tasks", { chat: "not a jid" });
    assert.equal(answer.json.error.fields.chat.code, "invalid_jid");
    answer = await list("tasks", { pageSize: "201" });
    assert.equal(answer.json.error.fields.pageSize.code, "out_of_range");
    answer = await list("tasks", { page: "0" });
    assert.equal(answer.status, 422);
    answer = await list("tasks", { q: "x".repeat(101) });
    assert.equal(answer.json.error.fields.q.code, "too_long");
    answer = await list("tasks", { status: "done" });
    assert.equal(answer.json.error.fields.status.code, "not_allowed");
    answer = await client.get("/admin/api/data/tasks?nope=1");
    assert.equal(answer.json.error.fields.$unknown.code, "unknown_field");
  });

  test("reminders: item shape, a preview of 80 characters, the chat name, pending by default", async () => {
    await db.KnownChat.create({ jid: G1, kind: "group", name: "Family", firstSeenAt: new Date(), lastSeenAt: new Date() });
    const due = new Date(Date.UTC(2030, 0, 2, 3, 4, 5));
    const long = await reminder({ text: `first\n\nline ${"x".repeat(200)}`, dueAt: due });
    const sent = await reminder({ text: "already sent", status: "sent" });
    const other = await reminder({ chatJid: U2, creatorJid: U2, text: "private one", dueAt: new Date(due.getTime() + 1000) });

    const answer = await list("reminders");
    assert.equal(answer.status, 200);
    assert.deepEqual([answer.json.page, answer.json.pageSize, answer.json.total], [1, 50, 2]);
    assert.deepEqual(answer.json.items.map((item) => item.id), [long.id, other.id], "soonest first, the sent one hidden");
    const [first, second] = answer.json.items;
    assert.deepEqual(Object.keys(first).sort(), ["chatJid", "chatName", "creatorJid", "dueAt", "id", "status", "textPreview"]);
    assert.equal(first.chatName, "Family");
    assert.equal(second.chatName, null);
    assert.equal(first.dueAt, due.toISOString());
    assert.equal(first.status, "pending");
    assert.equal(Array.from(first.textPreview).length, 80);
    assert.ok(first.textPreview.startsWith("first line xxx") && first.textPreview.endsWith("…"), first.textPreview);

    const all = await list("reminders", { status: "all" });
    assert.equal(all.json.total, 3);
    assert.ok(all.json.items.some((item) => item.id === sent.id && item.status === "sent"));
    assert.equal((await list("reminders", { status: "pending" })).json.total, 2);
  });

  test("reminders: the q search is a plain substring (a % is not a wildcard) and chat filters one chat", async () => {
    await reminder({ text: "Pay the RENT" });
    await reminder({ text: "100% sure", chatJid: U2 });
    await reminder({ text: "100 percent" });

    assert.equal((await list("reminders", { q: "rent" })).json.total, 1, "case-insensitive");
    assert.equal((await list("reminders", { q: "100%" })).json.total, 1, "% is a character");
    assert.equal((await list("reminders", { q: "%" })).json.total, 1);
    assert.equal((await list("reminders", { q: "_" })).json.total, 0, "_ is a character too");
    assert.equal((await list("reminders", { chat: U2 })).json.total, 1);
    assert.equal((await list("reminders", { chat: G1 })).json.total, 2);
    assert.equal((await list("reminders", { chat: G2 })).json.total, 0);
    assert.equal((await list("reminders", { q: "zzz" })).json.total, 0);
  });

  test("economy: one group, the richest first, q on the member", async () => {
    await db.GroupEconomy.bulkCreate([
      { groupJid: G1, userJid: U1, balance: 50, streak: 2, lastDailyAt: new Date(Date.UTC(2030, 5, 6)) },
      { groupJid: G1, userJid: U2, balance: 700, streak: 0, lastDailyAt: null },
      { groupJid: G1, userJid: U3, balance: null, streak: 0, lastDailyAt: null },
      { groupJid: G2, userJid: U1, balance: 9, streak: 0, lastDailyAt: null },
    ]);
    const answer = await list("economy", { groupJid: G1 });
    assert.equal(answer.json.total, 3);
    assert.deepEqual(answer.json.items.map((item) => [item.userJid, item.balance]), [[U2, 700], [U1, 50], [U3, 0]]);
    assert.deepEqual(answer.json.items[1], { groupJid: G1, userJid: U1, balance: 50, streak: 2, lastDailyAt: "2030-06-06T00:00:00.000Z" });
    assert.equal(answer.json.items[0].lastDailyAt, null);
    assert.deepEqual((await list("economy", { groupJid: G1, q: "0002" })).json.items.map((item) => item.userJid), [U2]);
    assert.equal((await list("economy", { groupJid: G2 })).json.total, 1);
  });

  test("keywords, sticker commands, afk, tasks, ideas and quotes: item shapes and filters", async () => {
    const kw = await db.NotifyKeyword.create({ userJid: U1, keyword: "banana", scopeJid: G1, enabled: false });
    await db.NotifyKeyword.create({ userJid: U2, keyword: "apple", scopeJid: G2 });
    let answer = await list("keywords");
    assert.equal(answer.json.total, 2);
    assert.deepEqual(answer.json.items.find((item) => item.id === kw.id), { id: kw.id, userJid: U1, keyword: "banana", scopeJid: G1, enabled: false });
    assert.deepEqual((await list("keywords", { chat: G2 })).json.items.map((item) => item.keyword), ["apple"]);
    assert.deepEqual((await list("keywords", { q: "BAN" })).json.items.map((item) => item.keyword), ["banana"]);

    const sc = await db.StickerCommand.create({ stickerHash: "ab12", command: "ping", createdBy: U1 });
    await db.StickerCommand.create({ stickerHash: "cd34", command: "menu", createdBy: U2 });
    answer = await list("sticker-commands");
    assert.equal(answer.json.total, 2);
    assert.deepEqual(answer.json.items.find((item) => item.id === sc.id), { id: sc.id, stickerHash: "ab12", command: "ping", createdBy: U1 });
    assert.deepEqual((await list("sticker-commands", { q: "men" })).json.items.map((item) => item.command), ["menu"]);

    const since = new Date(Date.UTC(2030, 0, 1));
    await db.User.create({ jid: U1, name: "Ann", afkReason: "lunch", afkTime: since });
    await db.User.create({ jid: U2, name: "Bob" });
    await db.User.create({ jid: U3, name: "Cat", afkReason: null, afkTime: new Date(since.getTime() + 1000) });
    answer = await list("afk");
    assert.equal(answer.json.total, 2, "only users who are away");
    assert.deepEqual(answer.json.items, [
      { jid: U3, name: "Cat", afkReason: null, afkTime: new Date(since.getTime() + 1000).toISOString() },
      { jid: U1, name: "Ann", afkReason: "lunch", afkTime: since.toISOString() },
    ]);
    assert.deepEqual((await list("afk", { q: "lunch" })).json.items.map((item) => item.jid), [U1]);

    const task = await db.Task.create({ chatJid: G1, text: "buy milk", done: true, createdBy: U1, doneBy: U2 });
    await db.Task.create({ chatJid: G2, text: "call mom", createdBy: U2 });
    answer = await list("tasks");
    assert.equal(answer.json.total, 2);
    assert.deepEqual(answer.json.items.find((item) => item.id === task.id), { id: task.id, chatJid: G1, text: "buy milk", done: true, createdBy: U1, doneBy: U2 });
    assert.equal((await list("tasks", { chat: G2 })).json.items[0].doneBy, null);
    assert.deepEqual((await list("tasks", { q: "milk" })).json.items.map((item) => item.id), [task.id]);

    const idea = await db.Idea.create({ groupJid: G1, authorJid: U1, text: "a pool", category: "fun", voters: [U1, U2, U3] });
    await db.Idea.create({ groupJid: G2, authorJid: U2, text: "a park" });
    answer = await list("ideas");
    assert.equal(answer.json.total, 2);
    assert.deepEqual(answer.json.items.find((item) => item.id === idea.id), { id: idea.id, groupJid: G1, authorJid: U1, text: "a pool", category: "fun", voters: 3 });
    assert.equal(answer.json.items.find((item) => item.id !== idea.id).voters, 0);
    assert.deepEqual((await list("ideas", { chat: G1 })).json.items.map((item) => item.id), [idea.id]);

    const quote = await db.Quote.create({ groupJid: G1, authorJid: U1, authorName: "Ann", text: "carpe diem", savedBy: U2 });
    await db.Quote.create({ groupJid: G2, authorJid: U2, text: "other", savedBy: U1 });
    answer = await list("quotes");
    assert.equal(answer.json.total, 2);
    assert.deepEqual(answer.json.items.find((item) => item.id === quote.id), {
      id: quote.id, groupJid: G1, authorJid: U1, authorName: "Ann", text: "carpe diem", savedBy: U2,
    });
    assert.deepEqual((await list("quotes", { q: "carpe" })).json.items.map((item) => item.id), [quote.id]);
  });

  test("pagination: pages of the requested size, a stable order, the total of the whole filter", async () => {
    for (let i = 1; i <= 7; i += 1) await db.Task.create({ chatJid: G1, text: `task ${i}`, createdBy: U1 });
    const first = (await list("tasks", { pageSize: "3" })).json;
    assert.deepEqual([first.page, first.pageSize, first.total, first.items.length], [1, 3, 7, 3]);
    const second = (await list("tasks", { pageSize: "3", page: "2" })).json;
    const third = (await list("tasks", { pageSize: "3", page: "3" })).json;
    const beyond = (await list("tasks", { pageSize: "3", page: "4" })).json;
    assert.deepEqual([second.items.length, third.items.length, beyond.items.length, beyond.total], [3, 1, 0, 7]);
    const ids = [...first.items, ...second.items, ...third.items].map((item) => item.id);
    assert.equal(new Set(ids).size, 7, "no row twice, none missing");
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a), "newest first");
    assert.equal((await list("tasks", { pageSize: "200" })).json.items.length, 7);
  });
});

describe("DATA-2: DELETE /admin/api/data/:kind/:id", () => {
  test("a reminder is cancelled; it is never sent afterwards; the others still are", async () => {
    const cancelled = await reminder({ text: "do not send me", dueAt: new Date(Date.now() - 10000) });
    const kept = await reminder({ text: "send me", dueAt: new Date(Date.now() - 9000) });

    const answer = await remove("reminders", cancelled.id);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { cancelled: true });
    assert.equal((await db.Reminder.findByPk(cancelled.id)).status, "cancelled");

    await scheduler.start(bot);
    const stats = await scheduler.tick();
    assert.equal(stats.sent, 1, JSON.stringify(stats));
    const texts = bot.getSocket().sent.map((s) => s.text);
    assert.equal(texts.length, 1);
    assert.match(texts[0], /send me/);
    assert.ok(!texts.some((text) => /do not send me/.test(text)), "the cancelled reminder was not delivered");
    assert.equal((await db.Reminder.findByPk(kept.id)).status, "sent");
    assert.equal((await db.Reminder.findByPk(cancelled.id)).status, "cancelled");
    assert.equal((await list("reminders")).json.total, 0);
  });

  test("a reminder that already left the pending state is 409 not_pending; an absent one is 404", async () => {
    const row = await reminder();
    assert.equal((await remove("reminders", row.id)).status, 200);
    let answer = await remove("reminders", row.id);
    assert.equal(answer.status, 409);
    assert.equal(answer.json.error.code, "not_pending");

    const sent = await reminder({ status: "sent" });
    answer = await remove("reminders", sent.id);
    assert.equal(answer.json.error.code, "not_pending");
    assert.equal((await db.Reminder.findByPk(sent.id)).status, "sent");

    answer = await remove("reminders", 987654);
    assert.equal(answer.status, 404);
    assert.equal(answer.json.error.code, "not_found");
    assert.equal((await remove("reminders", "abc")).status, 404);
  });

  test("keywords, sticker commands, tasks, ideas and quotes: deleted once, then 404", async () => {
    const rows = {
      keywords: await db.NotifyKeyword.create({ userJid: U1, keyword: "banana", scopeJid: G1 }),
      "sticker-commands": await db.StickerCommand.create({ stickerHash: "ab12", command: "ping", createdBy: U1 }),
      tasks: await db.Task.create({ chatJid: G1, text: "t", createdBy: U1 }),
      ideas: await db.Idea.create({ groupJid: G1, authorJid: U1, text: "i" }),
      quotes: await db.Quote.create({ groupJid: G1, authorJid: U1, text: "q", savedBy: U2 }),
    };
    const models = { keywords: "NotifyKeyword", "sticker-commands": "StickerCommand", tasks: "Task", ideas: "Idea", quotes: "Quote" };
    for (const [kind, row] of Object.entries(rows)) {
      const answer = await remove(kind, row.id);
      assert.equal(answer.status, 200, kind);
      assert.deepEqual(answer.json, { deleted: true }, kind);
      assert.equal(await db[models[kind]].findByPk(row.id), null, kind);
      const again = await remove(kind, row.id);
      assert.equal(again.status, 404, kind);
      assert.equal(again.json.error.code, "not_found", kind);
    }
    assert.equal((await remove("tasks", "abc")).status, 404);
    assert.equal((await remove("tasks", "12345678901")).status, 404, "an id longer than 10 digits");
  });

  test("a delete touches only its row", async () => {
    const keep = await db.Task.create({ chatJid: G1, text: "keep", createdBy: U1 });
    const gone = await db.Task.create({ chatJid: G1, text: "gone", createdBy: U1 });
    await remove("tasks", gone.id);
    assert.deepEqual((await db.Task.findAll({ raw: true })).map((row) => row.id), [keep.id]);
  });

  test("afk clears the reason and the time and keeps the row; 404 when the user is not away", async () => {
    await db.User.create({ jid: U1, name: "Ann", afkReason: "lunch", afkTime: new Date() });
    await db.User.create({ jid: U2, name: "Bob" });

    let answer = await remove("afk", U1);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { deleted: true });
    const row = await db.User.findByPk(U1);
    assert.ok(row, "the row stays");
    assert.deepEqual([row.name, row.afkReason, row.afkTime], ["Ann", null, null]);
    assert.equal((await list("afk")).json.total, 0);

    assert.equal((await remove("afk", U1)).status, 404, "no longer away");
    assert.equal((await remove("afk", U2)).status, 404, "never away");
    assert.equal((await remove("afk", "237699999999@s.whatsapp.net")).status, 404, "unknown user");

    // the id can be a bare number too
    await db.User.update({ afkReason: "back soon", afkTime: new Date() }, { where: { jid: U1 } });
    answer = await remove("afk", U1.split("@")[0]);
    assert.equal(answer.status, 200);
    assert.equal((await db.User.findByPk(U1)).afkTime, null);
  });

  test("economy has no delete", async () => {
    await db.GroupEconomy.create({ groupJid: G1, userJid: U1, balance: 10 });
    for (const id of [U1, "5"]) {
      const answer = await remove("economy", id);
      assert.equal(answer.status, 404, id);
    }
    // `adjust` is the path of DATA-3: known, but not for DELETE
    const wrongMethod = await remove("economy", "adjust");
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
    assert.equal(await balanceOf(G1, U1), 10);
  });

  test("an unknown kind is 404 and a delete is a guarded session route", async () => {
    assert.equal((await remove("users", 1)).status, 404);
    const anonymous = t.client();
    assert.equal((await anonymous.api("DELETE", "/admin/api/data/tasks/1")).status, 401);
    const noCsrf = await client.api("DELETE", "/admin/api/data/tasks/1", undefined, { headers: { "X-CSRF-Token": null } });
    assert.equal(noCsrf.status, 403);
  });

  test("every delete is audited as data.delete with <kind>:<id>", async () => {
    const task = await db.Task.create({ chatJid: G1, text: "t", createdBy: U1 });
    const due = await reminder();
    await db.User.create({ jid: U1, afkReason: "x", afkTime: new Date() });
    await remove("tasks", task.id);
    await remove("reminders", due.id);
    await remove("afk", U1);
    await remove("tasks", task.id); // 404: not audited
    const rows = await auditRows({ action: "data.delete" });
    assert.deepEqual(rows.map((row) => [row.target, row.result]), [
      [`tasks:${task.id}`, "ok"],
      [`reminders:${due.id}`, "ok"],
      [`afk:${U1}`, "ok"],
    ]);
  });

  describe("visible to the commands at once (FR-045)", () => {
    test("sticker_cmds: the pipeline reader no longer knows the sticker", async () => {
      const pipeline = require("../lib/core/pipeline");
      const row = await db.StickerCommand.create({ stickerHash: "ab12cd", command: "ping", createdBy: U1 });
      assert.equal((await pipeline.getStickerCommands()).get("ab12cd"), "ping", "loaded and cached");
      await remove("sticker-commands", row.id);
      assert.equal((await pipeline.getStickerCommands()).has("ab12cd"), false);
    });

    test("notify: the keyword stops alerting its owner", async () => {
      const notify = require("../plugins/notify");
      const group = "120363333333333333@g.us";
      const { Message } = require("../lib/classes/Message");
      const sock = fakes.fakeSocket({ extraParticipants: [{ id: U1 }, { id: U2 }] });
      const bytes = fakes.fakeClient(sock);
      const say = async () => {
        const message = new Message(bytes, fakes.rawMessage({ body: "I love banana bread", from: U2, group }));
        await notify.onMessage(message);
      };
      const row = await db.NotifyKeyword.create({ userJid: U1, keyword: "banana", scopeJid: group });

      await say();
      assert.equal(sock.sent.filter((s) => s.jid === U1).length, 1, "alerted before the delete (and cached)");
      cooldown.reset(U1, `notify:${group}:banana`);

      assert.equal((await remove("keywords", row.id)).status, 200);
      await say();
      assert.equal(sock.sent.filter((s) => s.jid === U1).length, 1, "no second alert once the panel removed the keyword");
    });

    test("afk_users: the afk plugin no longer sees the user as away", async () => {
      const afk = require("../plugins/afk");
      const { Message } = require("../lib/classes/Message");
      const sock = fakes.fakeSocket();
      const bytes = fakes.fakeClient(sock);
      const group = "120363444444444444@g.us";
      const as = (body, from) => new Message(bytes, fakes.rawMessage({ body, from, group }));

      await afk.execute(as(".afk lunch", U1), "lunch", { rawArgs: "lunch" });
      assert.ok((await db.User.findByPk(U1)).afkTime, "away, and cached");

      assert.equal((await remove("afk", U1)).status, 200);
      const before = sock.sent.length;
      await afk.onMessage(as("hello again", U1));
      assert.equal(sock.sent.length, before, "no 'welcome back' notice: the status is gone from the cache");
      assert.equal((await db.User.findByPk(U1)).afkTime, null);
    });
  });
});

describe("DATA-3: POST /admin/api/data/economy/adjust", () => {
  const body = (over = {}) => ({ groupJid: G1, userJid: U1, mode: "add", amount: 10, reason: "event prize", ...over });

  test("add credits (the account is created), answers the balance and the delta, and is audited", async () => {
    const answer = await adjust(body({ amount: 25 }));
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { balance: 25, delta: 25 });
    assert.equal(await balanceOf(G1, U1), 25);

    const second = await adjust(body({ amount: -5, reason: "  correction  " }));
    assert.deepEqual(second.json, { balance: 20, delta: -5 });

    const rows = await auditRows({ action: "economy.adjust" });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].target, `${G1}:${U1}`);
    assert.equal(rows[0].result, "ok");
    assert.deepEqual(JSON.parse(rows[0].detail), { mode: "add", delta: 25, balance: 25, reason: "event prize" });
    assert.deepEqual(JSON.parse(rows[1].detail), { mode: "add", delta: -5, balance: 20, reason: "correction" });
  });

  test("a debit that would go negative is refused with nothing written", async () => {
    await adjust(body({ amount: 10 }));
    const before = await t.dumpTables();
    let answer = await adjust(body({ amount: -11 }));
    assert.equal(answer.status, 422);
    assert.equal(answer.json.error.code, "negative_balance");
    assert.equal(await balanceOf(G1, U1), 10);

    // an account that does not exist is a balance of 0
    answer = await adjust(body({ userJid: U2, amount: -1 }));
    assert.equal(answer.json.error.code, "negative_balance");
    assert.equal(await balanceOf(G1, U2), null, "no account was created for a refused debit");

    // the only difference since the first call is nothing: tables are identical (audit included)
    assert.deepEqual(await t.dumpTables(), before);
    assert.equal((await adjust(body({ amount: -10 }))).json.balance, 0, "spending exactly the balance is fine");
  });

  test("set computes the delta in the same transaction and never goes below 0", async () => {
    await db.GroupEconomy.create({ groupJid: G1, userJid: U1, balance: 40 });
    let answer = await adjust(body({ mode: "set", amount: 100 }));
    assert.deepEqual(answer.json, { balance: 100, delta: 60 });
    answer = await adjust(body({ mode: "set", amount: 30 }));
    assert.deepEqual(answer.json, { balance: 30, delta: -70 });
    answer = await adjust(body({ mode: "set", amount: 0 }));
    assert.deepEqual(answer.json, { balance: 0, delta: -30 });
    answer = await adjust(body({ mode: "set", amount: 0 }));
    assert.deepEqual(answer.json, { balance: 0, delta: 0 });

    answer = await adjust(body({ mode: "set", amount: -1 }));
    assert.equal(answer.status, 422);
    assert.equal(answer.json.error.fields.amount.code, "out_of_range");
    assert.equal(await balanceOf(G1, U1), 0);

    // a new account gets its balance
    answer = await adjust(body({ userJid: U2, mode: "set", amount: 15 }));
    assert.deepEqual(answer.json, { balance: 15, delta: 15 });
    // "set 0" on a missing account creates nothing
    answer = await adjust(body({ userJid: U3, mode: "set", amount: 0 }));
    assert.deepEqual(answer.json, { balance: 0, delta: 0 });
    assert.equal(await balanceOf(G1, U3), null);

    const details = (await auditRows({ action: "economy.adjust" })).map((row) => JSON.parse(row.detail));
    assert.deepEqual(details[0], { mode: "set", delta: 60, balance: 100, reason: "event prize" });
  });

  test("the reason is kept in the history only: 1 to 200 characters", async () => {
    let answer = await adjust(body({ reason: "" }));
    assert.equal(answer.json.error.fields.reason.code, "too_short");
    answer = await adjust(body({ reason: "   " }));
    assert.equal(answer.json.error.fields.reason.code, "too_short");
    answer = await adjust(body({ reason: "r".repeat(201) }));
    assert.equal(answer.json.error.fields.reason.code, "too_long");
    answer = await adjust({ groupJid: G1, userJid: U1, mode: "add", amount: 1 });
    assert.equal(answer.json.error.fields.reason.code, "required");
    answer = await adjust(body({ reason: "r".repeat(200) }));
    assert.equal(answer.status, 200);
    assert.equal(JSON.parse((await auditRows({ action: "economy.adjust" }))[0].detail).reason.length, 200);
  });

  test("validation: identities, mode, amount and unknown fields (nothing written)", async () => {
    const before = await t.dumpTables();
    const fields = async (over) => {
      const answer = await adjust(body(over));
      assert.equal(answer.status, 422, JSON.stringify(over));
      assert.equal(answer.json.error.code, "validation_failed");
      return answer.json.error.fields;
    };
    assert.equal((await fields({ userJid: "nobody" })).userJid.code, "invalid_jid");
    assert.equal((await fields({ userJid: G1 })).userJid.code, "invalid_jid", "a group is not a member");
    assert.equal((await fields({ userJid: "12@s.whatsapp.net" })).userJid.code, "invalid_jid");
    assert.equal((await fields({ groupJid: U1 })).groupJid.code, "invalid_jid");
    assert.equal((await fields({ groupJid: "123@g.us" })).groupJid.code, "invalid_jid");
    assert.equal((await fields({ mode: "mul" })).mode.code, "not_allowed");
    assert.equal((await fields({ amount: 1.5 })).amount.code, "invalid_type");
    assert.equal((await fields({ amount: "5" })).amount.code, "invalid_type");
    assert.equal((await fields({ amount: 3000000000 })).amount.code, "out_of_range");
    assert.equal((await fields({ mode: "set", amount: -5 })).amount.code, "out_of_range");
    assert.equal((await fields({ extra: 1 })).$unknown.code, "unknown_field");
    assert.deepEqual(await t.dumpTables(), before);

    // a balance cannot grow past the INTEGER range
    await adjust(body({ amount: 1500000000 }));
    const over = await adjust(body({ amount: 1000000000 }));
    assert.equal(over.json.error.fields.amount.code, "out_of_range");
    assert.equal(await balanceOf(G1, U1), 1500000000);
  });

  test("a user can be named by phone number, by LID or by a bare number (both identity forms)", async () => {
    // a phone number: a device suffix is dropped and a bare number is a phone-number JID
    const long = "237690000009@s.whatsapp.net";
    let answer = await adjust(body({ userJid: "237690000009:12@s.whatsapp.net", amount: 5 }));
    assert.deepEqual(answer.json, { balance: 5, delta: 5 });
    answer = await adjust(body({ userJid: "+237 690 000 009", amount: 5 }));
    assert.deepEqual(answer.json, { balance: 10, delta: 5 });
    assert.deepEqual((await accounts(G1)).map((row) => row.userJid), [long], "one account for the three spellings");

    // an account stored under the phone number is found through the LID (the socket maps it)
    const rich = "237690000010@s.whatsapp.net";
    const richLid = "999900000010@lid";
    bot.getSocket().signalRepository.lidMapping.getPNForLID = async (value) => (value === richLid ? rich : null);
    await db.GroupEconomy.create({ groupJid: G1, userJid: rich, balance: 40 });
    answer = await adjust(body({ userJid: richLid, amount: 2 }));
    assert.deepEqual(answer.json, { balance: 42, delta: 2 });
    assert.equal(await balanceOf(G1, richLid), null, "no second account under the LID");
    assert.equal(await balanceOf(G1, rich), 42);

    // an account stored under a LID nobody can map is the one adjusted when that form is named
    const stray = "999900000011@lid";
    await db.GroupEconomy.create({ groupJid: G1, userJid: stray, balance: 7 });
    answer = await adjust(body({ userJid: stray, mode: "set", amount: 9 }));
    assert.deepEqual(answer.json, { balance: 9, delta: 2 });
    assert.equal(await balanceOf(G1, stray), 9);

    // the audit target names the account really changed
    const targets = (await auditRows({ action: "economy.adjust" })).map((row) => row.target);
    assert.deepEqual(targets, [`${G1}:${long}`, `${G1}:${long}`, `${G1}:${rich}`, `${G1}:${stray}`]);
  });

  test("a group is separate: the same member has one balance per group", async () => {
    await adjust(body({ amount: 10 }));
    await adjust(body({ groupJid: G2, amount: 3 }));
    assert.equal(await balanceOf(G1, U1), 10);
    assert.equal(await balanceOf(G2, U1), 3);
  });

  test("the adjustment and its audit row commit or fail together", async () => {
    await db.GroupEconomy.create({ groupJid: G1, userJid: U1, balance: 10 });
    const service = createDataService({
      models: db,
      audit: { record: async () => { throw new Error("history unavailable"); } },
    });
    await assert.rejects(() => service.adjustEconomy({ groupJid: G1, userJid: U1, mode: "add", amount: 5, reason: "x" }), /history unavailable/);
    assert.equal(await balanceOf(G1, U1), 10, "rolled back with the failed audit write");
    await assert.rejects(() => service.adjustEconomy({ groupJid: G1, userJid: U2, mode: "set", amount: 5, reason: "x" }), /history unavailable/);
    assert.equal(await balanceOf(G1, U2), null, "the account created by the credit was rolled back too");

    // and the other way round: the audit row exists only when the balance moved
    const ok = createDataService({ models: db, audit: t.audit });
    await ok.adjustEconomy({ groupJid: G1, userJid: U1, mode: "add", amount: 5, reason: "fine" }, { origin: "203.0.113.9" });
    const rows = await auditRows({ action: "economy.adjust" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin, "203.0.113.9");
    assert.equal(await balanceOf(G1, U1), 15);
  });

  test("20 concurrent give commands and 20 panel adds end at the exact sum", async () => {
    const give = require("../plugins/give");
    const { Message, invalidateGroupMetadata } = require("../lib/classes/Message");
    const group = "120363555555555555@g.us";
    const giver = "237690000020@s.whatsapp.net";
    const taker = "237690000021@s.whatsapp.net";
    invalidateGroupMetadata();
    await db.GroupEconomy.create({ groupJid: group, userJid: giver, balance: 150 });

    const gives = [];
    for (let i = 0; i < 20; i += 1) {
      const sock = fakes.fakeSocket({ extraParticipants: [{ id: giver }, { id: taker }] });
      const message = new Message(
        fakes.fakeClient(sock),
        fakes.rawMessage({ body: ".give @taker 5", from: giver, group, mentions: [taker] }),
      );
      gives.push(give.execute(message, "5", { command: "give", rawArgs: "5" }));
    }
    const panel = [];
    for (let i = 0; i < 20; i += 1) panel.push(adjust({ groupJid: group, userJid: taker, mode: "add", amount: 7, reason: `credit ${i}` }));
    // the giver also spends through the panel: 10 x 5 = 50, so the 150 coins are used up exactly
    for (let i = 0; i < 10; i += 1) panel.push(adjust({ groupJid: group, userJid: giver, mode: "add", amount: -5, reason: `debit ${i}` }));

    const answers = await Promise.all(panel);
    await Promise.all(gives);
    assert.deepEqual([...new Set(answers.map((a) => a.status))], [200], JSON.stringify(answers.filter((a) => a.status !== 200).map((a) => a.json)));
    assert.equal(await balanceOf(group, taker), 20 * 5 + 20 * 7);
    assert.equal(await balanceOf(group, giver), 0);

    // nothing left to spend: refused, nothing written
    const refused = await adjust({ groupJid: group, userJid: giver, mode: "add", amount: -1, reason: "too much" });
    assert.equal(refused.json.error.code, "negative_balance");
    assert.equal(await balanceOf(group, giver), 0);
    assert.equal((await auditRows({ action: "economy.adjust" })).length, 30, "one history row per adjustment that went through");
  });
});

describe("a set that loses a race against a spend", () => {
  /** A scripted economy: the guarded debit fails `failures` times because the balance moved meanwhile */
  function scripted(failures) {
    const state = { balance: 50, calls: [] };
    const eco = {
      withLock: (key, fn) => fn(),
      ensureAccount: async () => {},
      getBalance: async () => state.balance,
      applyDelta: async (group, user, delta, options) => {
        state.calls.push({ delta, minBalance: options.minBalance });
        if (state.calls.length <= failures) {
          state.balance = 20; // a spend of the member got in between the read and the guarded statement
          return false;
        }
        state.balance += delta;
        return true;
      },
    };
    const models = { GroupEconomy: { findAll: async () => [] }, DATABASE: { transaction: async (fn) => fn({}) } };
    return { state, service: createDataService({ models, economy: eco }) };
  }
  const set = (amount) => ({ groupJid: G1, userJid: U1, mode: "set", amount, reason: "reset" });

  test("the delta is computed again from the balance that is there now", async () => {
    const { state, service } = scripted(1);
    assert.deepEqual(await service.adjustEconomy(set(10)), { balance: 10, delta: -10 });
    assert.deepEqual(state.calls, [{ delta: -40, minBalance: 40 }, { delta: -10, minBalance: 10 }]);
  });

  test("after three attempts the answer is a conflict and nothing is claimed to have changed", async () => {
    const { state, service } = scripted(3);
    await assert.rejects(() => service.adjustEconomy(set(10)), (error) => error.code === "conflict");
    assert.equal(state.calls.length, 3);
  });

  test("an add that cannot be covered is negative_balance at once, carrying the balance read back", async () => {
    const { state, service } = scripted(1);
    await assert.rejects(
      () => service.adjustEconomy({ groupJid: G1, userJid: U1, mode: "add", amount: -45, reason: "x" }),
      (error) => error.code === "negative_balance" && error.params.balance === 20,
    );
    assert.equal(state.calls.length, 1, "no retry for an add");
  });
});

describe("pure helpers", () => {
  test("preview keeps 80 characters on one line", () => {
    assert.equal(preview("a\n\n  b"), "a b");
    assert.equal(preview("x".repeat(80)), "x".repeat(80));
    assert.equal(Array.from(preview("é".repeat(120))).length, 80);
    assert.equal(preview(null), "");
  });

  test("the service keeps its parts lazy: an unknown kind is a 404 envelope", async () => {
    const service = createDataService({ models: db });
    await assert.rejects(() => service.list("nope"), (error) => error.code === "not_found");
    await assert.rejects(() => service.remove("nope", 1), (error) => error.code === "not_found");
    assert.deepEqual(service.kinds, ["reminders", "economy", "keywords", "sticker-commands", "afk", "tasks", "ideas", "quotes"]);
    assert.ok(economy.withLock, "the lock of the give command is the one the service takes");
  });
});
