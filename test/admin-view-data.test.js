"use strict";
/**
 * The data view (T155 and T156, FR-042 to FR-045; views/data-logic.mjs and the parts next to it): the pure logic is
 * tested, and checked against the real DATA-1 to DATA-3 routes so the fixtures cannot drift from the API.
 *
 *  - the query of each tab (only the filters that apply, defaults left out) is accepted by DATA-1;
 *  - the action a row offers, the id and the path it sends (afk uses the user JID), the page after a removal;
 *  - the adjustment: the payload (member normalized, reason trimmed, exactly the five properties), the checks that
 *    mirror the server's, the client-side negative-result pre-check (which agrees with the server's verdict), the
 *    reading of the API errors;
 *  - panel-data.json: every key the view files use (literal or in a family) is defined in English and French;
 *  - the view rendered in a fake DOM with a scripted server: the reminders tab (cancel behind a confirmation), the AFK
 *    tab, the economy tab (group picker, adjust form, the negative-result warning, the payload, a refusal).
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createTestAdmin } = require("./helpers/adminHarness");
const { createDom, importPublic } = require("./helpers/fakeDom");

const ROOT = path.resolve(__dirname, "..");
const VIEWS = path.join(ROOT, "lib", "admin", "public", "js", "views");
const load = (relative) => import(pathToFileURL(path.join(ROOT, "lib", "admin", "public", "js", relative)).href);

const G1 = "120363111111111111@g.us";
const U1 = "237690000001@s.whatsapp.net";
const U2 = "237690000002@s.whatsapp.net";

let logic;
let db;
let t;
let client;
let rendering = false; // the view tests script `fetch` themselves: no real server for them

before(async () => {
  logic = await load("views/data-logic.mjs");
  db = await fakes.syncDb();
});

after(async () => {
  if (t) await t.close();
});

beforeEach(async () => {
  if (rendering) return;
  if (t) await t.close();
  for (const name of ["Reminder", "GroupEconomy", "NotifyKeyword", "StickerCommand", "User", "Task", "Idea", "Quote"]) {
    await db[name].destroy({ where: {} });
  }
  t = await createTestAdmin();
  await t.admin.start();
  client = await t.loginClient();
});

const qs = (query) => {
  const text = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
  return text ? `?${text}` : "";
};

describe("the tabs", () => {
  test("the kinds are the eight of the API, in display order", () => {
    assert.deepEqual([...logic.KINDS], ["reminders", "economy", "keywords", "sticker-commands", "afk", "tasks", "ideas", "quotes"]);
    assert.equal(logic.DEFAULT_KIND, "reminders");
  });

  test("tabOf keeps a known tab and falls back to the first", () => {
    assert.equal(logic.tabOf("economy"), "economy");
    assert.equal(logic.tabOf("sticker-commands"), "sticker-commands");
    for (const bad of [undefined, null, "", "users", "constructor", "__proto__", 4]) assert.equal(logic.tabOf(bad), "reminders");
  });

  test("tabQuery sends only the filters that apply, trimmed, with the defaults left out", () => {
    const filters = { q: "  hello  ", chat: ` ${G1} `, status: "all", groupJid: ` ${G1} ` };
    assert.deepEqual(logic.tabQuery("reminders", filters, 1, 50), { q: "hello", chat: G1, status: "all" });
    assert.deepEqual(logic.tabQuery("economy", filters, 1, 50), { groupJid: G1, q: "hello" });
    assert.deepEqual(logic.tabQuery("keywords", filters, 1, 50), { q: "hello", chat: G1 });
    assert.deepEqual(logic.tabQuery("sticker-commands", filters, 1, 50), { q: "hello" });
    assert.deepEqual(logic.tabQuery("afk", filters, 1, 50), { q: "hello" });
    for (const kind of ["tasks", "ideas", "quotes"]) assert.deepEqual(logic.tabQuery(kind, filters, 1, 50), { q: "hello", chat: G1 }, kind);

    assert.deepEqual(logic.tabQuery("reminders", logic.emptyFilters(), 1, 50), {}, "pending is the default");
    assert.deepEqual(logic.tabQuery("reminders", { ...logic.emptyFilters(), status: "pending" }, 1, 50), {});
    assert.deepEqual(logic.tabQuery("afk", {}, 1, 50), {});
  });

  test("tabQuery pages: page 1 and the server's page size are implied", () => {
    assert.deepEqual(logic.tabQuery("tasks", {}, 1), { pageSize: logic.PAGE_SIZE }, "the view's own page size is sent");
    assert.deepEqual(logic.tabQuery("tasks", {}, 3, 50), { page: 3 });
    assert.deepEqual(logic.tabQuery("tasks", {}, 2, 10), { page: 2, pageSize: 10 });
    assert.equal(logic.tabQuery("tasks", { q: "x".repeat(300) }, 1, 50).q.length, logic.SEARCH_MAX);
  });

  test("the economy tab loads only once a group is chosen", () => {
    assert.equal(logic.canLoad("economy", {}), false);
    assert.equal(logic.canLoad("economy", { groupJid: "nope" }), false);
    assert.equal(logic.canLoad("economy", { groupJid: ` ${G1} ` }), true);
    for (const kind of logic.KINDS.filter((k) => k !== "economy")) assert.equal(logic.canLoad(kind, {}), true, kind);
  });

  test("filterErrors names a chat or a group that is not an identifier, with the API field code", () => {
    assert.deepEqual(logic.filterErrors("tasks", { chat: "banana" }), { chat: { code: "invalid_jid" } });
    assert.deepEqual(logic.filterErrors("tasks", { chat: "237690000001@s.whatsapp.net" }), {});
    assert.deepEqual(logic.filterErrors("tasks", { chat: "" }), {});
    assert.deepEqual(logic.filterErrors("economy", { groupJid: U1 }), { groupJid: { code: "invalid_jid" } });
    assert.deepEqual(logic.filterErrors("economy", { groupJid: G1 }), {});
    assert.deepEqual(logic.filterErrors("afk", { chat: "banana" }), {}, "a filter that does not apply is not checked");
  });

  test("every tab's query is accepted by DATA-1 (and its error check agrees with the server)", async () => {
    await db.Reminder.create({ chatJid: G1, creatorJid: U1, text: "hello world", dueAt: new Date(Date.now() + 3600000) });
    await db.GroupEconomy.create({ groupJid: G1, userJid: U1, balance: 5 });
    const filters = { q: "hello", chat: G1, status: "all", groupJid: G1 };
    for (const kind of logic.KINDS) {
      const answer = await client.get(`/admin/api/data/${kind}${qs(logic.tabQuery(kind, filters, 1, 25))}`);
      assert.equal(answer.status, 200, `${kind}: ${answer.text}`);
      assert.equal(answer.json.pageSize, 25);
    }
    // what the view refuses before asking, the server refuses too
    const refused = await client.get(`/admin/api/data/tasks${qs({ chat: "banana" })}`);
    assert.equal(refused.json.error.fields.chat.code, logic.filterErrors("tasks", { chat: "banana" }).chat.code);
    const noGroup = await client.get("/admin/api/data/economy");
    assert.equal(noGroup.status, 422);
    assert.equal(logic.canLoad("economy", {}), false);
  });
});

describe("the action of a row", () => {
  test("a reminder is cancelled, an AFK status cleared, the rest deleted; the economy has none", () => {
    assert.equal(logic.actionOf("reminders"), "cancel");
    assert.equal(logic.actionOf("afk"), "clear");
    for (const kind of ["keywords", "sticker-commands", "tasks", "ideas", "quotes"]) assert.equal(logic.actionOf(kind), "delete", kind);
    assert.equal(logic.isRemovable("economy"), false);
    assert.equal(logic.isRemovable("afk"), true);
    assert.equal(logic.isRemovable("nope"), false);
  });

  test("a reminder offers its action only while pending", () => {
    assert.equal(logic.canAct("reminders", { id: 1, status: "pending" }), true);
    for (const status of ["sent", "cancelled", "missed", "failed"]) assert.equal(logic.canAct("reminders", { id: 1, status }), false, status);
    assert.equal(logic.canAct("tasks", { id: 1 }), true);
    assert.equal(logic.canAct("economy", { userJid: U1 }), false);
    assert.equal(logic.canAct("tasks", null), false);
  });

  test("the id and the path: the user JID for afk (encoded), the numeric id otherwise", () => {
    assert.equal(logic.removalId("afk", { jid: U1 }), U1);
    assert.equal(logic.removalId("tasks", { id: 7 }), 7);
    assert.equal(logic.removalPath("tasks", 7), "/admin/api/data/tasks/7");
    assert.equal(logic.removalPath("afk", U1), "/admin/api/data/afk/237690000001%40s.whatsapp.net");
    assert.equal(logic.removalPath("sticker-commands", 3), "/admin/api/data/sticker-commands/3");
    assert.equal(logic.rowKey("afk", { jid: U1 }), U1);
    assert.equal(logic.rowKey("economy", { groupJid: G1, userJid: U1 }), `${G1}:${U1}`);
    assert.equal(logic.rowKey("tasks", { id: 4 }), 4);
  });

  test("the paths built here reach DATA-2 (an afk JID travels percent-encoded)", async () => {
    await db.User.create({ jid: U1, afkReason: "lunch", afkTime: new Date() });
    const task = await db.Task.create({ chatJid: G1, text: "t", createdBy: U1 });
    const afk = await client.api("DELETE", logic.removalPath("afk", logic.removalId("afk", { jid: U1 })));
    assert.deepEqual(afk.json, { deleted: true });
    const gone = await client.api("DELETE", logic.removalPath("tasks", logic.removalId("tasks", { id: task.id })));
    assert.deepEqual(gone.json, { deleted: true });
  });

  test("after a removal the view goes back a page when it emptied one", () => {
    assert.equal(logic.pageAfterRemoval(1, 1), 1, "the first page stays");
    assert.equal(logic.pageAfterRemoval(3, 1), 2);
    assert.equal(logic.pageAfterRemoval(3, 2), 3);
    assert.equal(logic.pageAfterRemoval(3, 25), 3);
  });

  test("withoutRow drops the row by its id, afk by its JID", () => {
    assert.deepEqual(logic.withoutRow([{ id: 1 }, { id: 2 }], "tasks", 1), [{ id: 2 }]);
    assert.deepEqual(logic.withoutRow([{ id: 1 }, { id: 2 }], "tasks", "2"), [{ id: 1 }]);
    assert.deepEqual(logic.withoutRow([{ jid: U1 }, { jid: U2 }], "afk", U2), [{ jid: U1 }]);
    assert.deepEqual(logic.withoutRow(undefined, "tasks", 1), []);
  });

  test("display helpers: short identifiers and one-line excerpts", () => {
    assert.equal(logic.shortJid(U1), "237690000001");
    assert.equal(logic.shortJid("99990001@lid"), "99990001 (LID)");
    assert.equal(logic.shortJid(G1), "120363111111111111");
    assert.equal(logic.shortJid(null), "");
    assert.equal(logic.excerpt("a\n\n b"), "a b");
    assert.equal(Array.from(logic.excerpt("x".repeat(500))).length, logic.TEXT_EXCERPT);
    assert.ok(logic.excerpt("x".repeat(500)).endsWith("…"));
  });
});

describe("the economy adjustment", () => {
  const form = (over = {}) => ({ groupJid: G1, userJid: U1, mode: "add", amount: 10, reason: "event prize", ...over });

  test("the payload is exactly the five properties of DATA-3: member normalized, reason trimmed", () => {
    const payload = logic.adjustmentPayload(form({ userJid: " +237 690 000 001 ", reason: "  prize  ", groupJid: ` ${G1} ` }));
    assert.deepEqual(payload, { groupJid: G1, userJid: U1, mode: "add", amount: 10, reason: "prize" });
    assert.deepEqual(Object.keys(payload).sort(), ["amount", "groupJid", "mode", "reason", "userJid"]);
    assert.equal(logic.adjustmentPayload(form({ userJid: "99990001@LID" })).userJid, "99990001@lid");
    assert.equal(logic.adjustmentPayload(form({ userJid: `${U1}` })).userJid, U1);
  });

  test("normalizeMember", () => {
    assert.equal(logic.normalizeMember("237690000001"), U1);
    assert.equal(logic.normalizeMember("(237) 690-000-001"), U1);
    assert.equal(logic.normalizeMember("  "), "");
    assert.equal(logic.normalizeMember(undefined), "");
    assert.equal(logic.normalizeMember("abc"), "abc", "left as typed for the check to refuse");
  });

  test("projectedBalance: add moves from the balance, set replaces it", () => {
    assert.equal(logic.projectedBalance("add", 5, 10), 15);
    assert.equal(logic.projectedBalance("add", -5, 10), 5);
    assert.equal(logic.projectedBalance("set", 5, 10), 5);
    assert.equal(logic.projectedBalance("add", 5, null), 5, "an unknown balance counts as 0 for the preview");
    assert.equal(logic.projectedBalance("add", 1.5, 10), null);
    assert.equal(logic.projectedBalance("add", null, 10), null);
  });

  test("knownBalance reads the balance the list shows for the member of the group", () => {
    const items = [{ groupJid: G1, userJid: U1, balance: 40 }, { groupJid: G1, userJid: U2, balance: 0 }];
    assert.equal(logic.knownBalance(items, G1, "237690000001"), 40);
    assert.equal(logic.knownBalance(items, G1, U2), 0);
    assert.equal(logic.knownBalance(items, G1, "237690000003"), null);
    assert.equal(logic.knownBalance(items, "120363222222222222@g.us", U1), null);
    assert.equal(logic.knownBalance(items, G1, ""), null);
    assert.equal(logic.knownBalance(undefined, G1, U1), null);
  });

  test("a valid form has no error", () => {
    assert.deepEqual(logic.validateAdjustment(form(), null), {});
    assert.deepEqual(logic.validateAdjustment(form({ mode: "set", amount: 0 }), 12), {});
    assert.equal(logic.isAdjustmentValid(form()), true);
    assert.equal(logic.isAdjustmentValid(form({ reason: "" })), false);
  });

  test("the checks answer with the API's field codes", () => {
    const codes = (over, balance = null) => Object.fromEntries(Object.entries(logic.validateAdjustment(form(over), balance)).map(([k, v]) => [k, v.code]));
    assert.deepEqual(codes({ groupJid: "" }), { groupJid: "required" });
    assert.deepEqual(codes({ groupJid: U1 }), { groupJid: "invalid_jid" });
    assert.deepEqual(codes({ userJid: "" }), { userJid: "required" });
    assert.deepEqual(codes({ userJid: "banana" }), { userJid: "invalid_jid" });
    assert.deepEqual(codes({ userJid: G1 }), { userJid: "invalid_jid" });
    assert.deepEqual(codes({ mode: "mul" }), { mode: "not_allowed" });
    assert.deepEqual(codes({ amount: null }), { amount: "required" });
    assert.deepEqual(codes({ amount: 1.5 }), { amount: "invalid_type" });
    assert.deepEqual(codes({ amount: "5" }), { amount: "invalid_type" });
    assert.deepEqual(codes({ mode: "set", amount: -1 }), { amount: "out_of_range" });
    assert.deepEqual(codes({ mode: "set", amount: logic.MAX_BALANCE + 1 }), { amount: "out_of_range" });
    assert.deepEqual(codes({ amount: logic.MAX_BALANCE + 1 }), { amount: "out_of_range" });
    assert.deepEqual(codes({ reason: "   " }), { reason: "required" });
    assert.deepEqual(codes({ reason: "r".repeat(logic.REASON_MAX + 1) }), { reason: "too_long" });
    assert.deepEqual(codes({ reason: "r".repeat(logic.REASON_MAX) }), {});
    assert.deepEqual(logic.validateAdjustment(form({ mode: "set", amount: -1 })).amount.params, { min: 0, max: logic.MAX_BALANCE });
    assert.deepEqual(logic.validateAdjustment(form({ reason: "r".repeat(300) })).reason.params, { max: logic.REASON_MAX });
  });

  test("a debit that would go below zero is flagged when the list shows the balance", () => {
    assert.deepEqual(logic.validateAdjustment(form({ amount: -11 }), 10).amount, { code: "negative_balance" });
    assert.deepEqual(logic.validateAdjustment(form({ amount: -10 }), 10), {});
    assert.deepEqual(logic.validateAdjustment(form({ amount: -1 }), 0).amount, { code: "negative_balance" });
    // a "set" never needs the pre-check: its result is the amount, checked to be 0 or more
    assert.deepEqual(logic.validateAdjustment(form({ mode: "set", amount: 0 }), 10), {});
    // an unknown balance leaves the verdict to the server
    assert.deepEqual(logic.validateAdjustment(form({ amount: -11 }), null), {});
    // a balance cannot grow past the INTEGER range either
    assert.equal(logic.validateAdjustment(form({ amount: 10 }), logic.MAX_BALANCE).amount.code, "out_of_range");
  });

  test("the pre-check agrees with the server on real balances", async () => {
    await db.GroupEconomy.create({ groupJid: G1, userJid: U1, balance: 10 });
    const shown = async () => logic.knownBalance((await client.get(`/admin/api/data/economy${qs({ groupJid: G1 })}`)).json.items, G1, U1);
    // balance 10: -11 is refused, -10 goes through (balance 0), then -1 is refused, +5 goes through
    for (const [amount, expected] of [[-11, 422], [-10, 200], [-1, 422], [5, 200]]) {
      const balance = await shown();
      const f = form({ amount });
      const verdict = logic.validateAdjustment(f, balance);
      const answer = await client.api("POST", "/admin/api/data/economy/adjust", logic.adjustmentPayload(f));
      assert.equal(answer.status, expected, `amount ${amount}: ${answer.text}`);
      if (expected === 422) {
        assert.equal(verdict.amount.code, "negative_balance", `amount ${amount}: the view flags it before asking`);
        assert.equal(answer.json.error.code, "negative_balance");
        assert.deepEqual(logic.adjustmentErrors({ code: answer.json.error.code }), { amount: { code: "negative_balance" } });
      } else {
        assert.deepEqual(verdict, {}, `amount ${amount}: the view lets it through`);
      }
    }
    assert.equal(await shown(), 5);
  });

  test("a payload built here is accepted by DATA-3, in both modes, for a typed phone number", async () => {
    let answer = await client.api("POST", "/admin/api/data/economy/adjust", logic.adjustmentPayload(form({ userJid: "+237 690 000 001", amount: 30 })));
    assert.deepEqual(answer.json, { balance: 30, delta: 30 });
    answer = await client.api("POST", "/admin/api/data/economy/adjust", logic.adjustmentPayload(form({ mode: "set", amount: 7, reason: "  reset  " })));
    assert.deepEqual(answer.json, { balance: 7, delta: -23 });
    assert.equal(logic.formatDelta(answer.json.delta), "-23");
    assert.equal(logic.formatDelta(30), "+30");
    assert.equal(logic.formatDelta(0), "0");
  });

  test("adjustmentErrors reads the API errors: validation fields, a refused debit, nothing else", () => {
    const fields = { reason: { code: "too_long", params: { max: 200 } } };
    assert.deepEqual(logic.adjustmentErrors({ code: "validation_failed", fields }), fields);
    assert.notEqual(logic.adjustmentErrors({ code: "validation_failed", fields }), fields, "a copy");
    assert.deepEqual(logic.adjustmentErrors({ code: "negative_balance" }), { amount: { code: "negative_balance" } });
    assert.equal(logic.adjustmentErrors({ code: "validation_failed", fields: {} }), null);
    assert.equal(logic.adjustmentErrors({ code: "internal_error" }), null);
    assert.equal(logic.adjustmentErrors({ code: "conflict" }), null);
    assert.equal(logic.adjustmentErrors(null), null);
  });

  test("applyAdjustment puts the balance the server returned into the listed row", () => {
    const items = [{ groupJid: G1, userJid: U1, balance: 40 }, { groupJid: G1, userJid: U2, balance: 5 }];
    const next = logic.applyAdjustment(items, G1, "237690000001", 99);
    assert.deepEqual(next.map((row) => row.balance), [99, 5]);
    assert.equal(items[0].balance, 40, "the list is not mutated");
    assert.deepEqual(logic.applyAdjustment(items, G1, "237690000099", 1).map((row) => row.balance), [40, 5], "an unlisted member is not added");
  });

  test("emptyAdjustment starts as an addition in the chosen group", () => {
    assert.deepEqual(logic.emptyAdjustment(G1), { groupJid: G1, userJid: "", mode: "add", amount: null, reason: "" });
    assert.equal(logic.emptyAdjustment().groupJid, "");
  });
});

describe("panel-data.json", () => {
  const fragment = JSON.parse(fs.readFileSync(path.join(ROOT, "specs", "002-admin-panel", "i18n", "panel-data.json"), "utf8"));
  const placeholdersOf = (text) => (String(text).match(/\{[A-Za-z0-9_]+\}/g) || []).sort().join(",");

  test("English and French define the same keys with the same placeholders, none empty", () => {
    const en = Object.keys(fragment.en).sort();
    assert.deepEqual(Object.keys(fragment.fr).sort(), en);
    assert.ok(en.length >= 100);
    for (const key of en) {
      for (const lang of ["en", "fr"]) assert.ok(typeof fragment[lang][key] === "string" && fragment[lang][key].trim(), `${lang} ${key}`);
      assert.equal(placeholdersOf(fragment.fr[key]), placeholdersOf(fragment.en[key]), key);
      assert.ok(key.startsWith("data."), key);
    }
    assert.equal("data.title" in fragment.en, false, "the area title is already in the panel catalog");
  });

  test("no key is both a text and the prefix of another", () => {
    const keys = new Set(Object.keys(fragment.en));
    for (const key of keys) {
      const parts = key.split(".");
      for (let i = 1; i < parts.length; i += 1) assert.equal(keys.has(parts.slice(0, i).join(".")), false, `${key} nests under a text`);
    }
  });

  test("every key the view files use is defined: literals and the dynamic families", () => {
    const main = JSON.parse(fs.readFileSync(path.join(ROOT, "lib", "admin", "public", "i18n", "en.json"), "utf8"));
    const defined = new Set([...Object.keys(fragment.en), ...Object.keys(main)]);
    const used = new Set();
    for (const file of fs.readdirSync(VIEWS).filter((name) => /^data(-.*)?\.mjs$/.test(name))) {
      const source = fs.readFileSync(path.join(VIEWS, file), "utf8");
      for (const match of source.matchAll(/\bt\(\s*"([A-Za-z0-9_.-]+)"/g)) used.add(match[1]);
    }
    assert.ok(used.size > 60, `${used.size} literal keys`);
    for (const key of used) assert.ok(defined.has(key), `${key} is not defined`);

    // the families built with a template: data.tab.<kind>, data.intro.<kind>, ...
    const families = [];
    for (const kind of logic.KINDS) {
      for (const prefix of ["data.tab.", "data.intro.", "data.search_placeholder.", "data.empty.", "data.empty_hint."]) families.push(prefix + kind);
    }
    for (const kind of logic.KINDS.filter(logic.isRemovable)) {
      const action = logic.actionOf(kind);
      families.push(`data.confirm_${action}_title`, `data.confirm_${action}_message.${kind}`, `data.action_${action}`);
    }
    for (const status of ["pending", "sent", "cancelled", "missed", "failed"]) families.push(`data.status_${status}`);
    for (const value of ["pending", "all"]) families.push(`data.status_filter_${value}`);
    for (const mode of logic.MODES) families.push(`data.economy_mode_${mode}`, `data.economy_mode_hint_${mode}`);
    for (const key of families) assert.ok(defined.has(key), `${key} is not defined`);
  });
});

// ---------------------------------------------------------------------------
// The view in a fake DOM
// ---------------------------------------------------------------------------

describe("the view renders and works", () => {
  let dom;
  let ui;
  let htmlTag;
  let view;
  let requests;
  let routes;

  const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const page = (items, extra = {}) => ({ items, page: 1, pageSize: 25, total: items.length, ...extra });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const button = (root, text) => dom.byText(root, text, "button")[0];
  const field = (root, name) => dom.byAttr(root, "name", name)[0];
  const submit = (root, title) => dom.fire(dom.find(root, (el) => el.localName === "form" && dom.text(el).includes(title))[0], "submit");

  before(async () => {
    if (t) await t.close();
    t = null;
    rendering = true;
    dom = await createDom();
    const i18n = await importPublic("js/i18n.mjs");
    for (const lang of ["en", "fr"]) {
      i18n.setCatalog(lang, {
        ...readJson(path.join(ROOT, "lib", "admin", "public", "i18n", `${lang}.json`)),
        ...readJson(path.join(ROOT, "specs", "002-admin-panel", "i18n", "panel-data.json"))[lang],
      });
    }
    await i18n.setLanguage("en", { remember: false });
    ui = await importPublic("js/ui.mjs");
    htmlTag = (await importPublic("js/components/html.mjs")).html;
    view = await importPublic("js/views/data.mjs");
  });

  after(() => {
    dom.restore();
    delete globalThis.fetch;
  });

  async function open(script = {}, tab) {
    requests = [];
    routes = script;
    globalThis.fetch = async (url, init) => {
      const [path_, search] = url.split("?");
      const key = `${init.method} ${path_}`;
      requests.push({ key, search: search || "", body: init.body ? JSON.parse(init.body) : undefined });
      if (!routes[key]) throw new Error(`unexpected request ${key}`);
      return routes[key](init.body ? JSON.parse(init.body) : undefined, search || "");
    };
    const root = dom.mount(htmlTag`<${view.default} route=${{ rest: [], query: tab ? { tab } : {} }} />`);
    await dom.settle(10);
    return root;
  }
  const count = (key) => requests.filter((r) => r.key === key).length;

  test("reminders: the pending ones offer Cancel, which asks first, then cancels and reloads", async () => {
    const reminders = [
      { id: 7, chatJid: G1, chatName: "Family", creatorJid: U1, dueAt: "2030-01-02T03:04:05.000Z", status: "pending", textPreview: "water the plants" },
      { id: 8, chatJid: G1, chatName: null, creatorJid: U2, dueAt: "2030-01-01T03:04:05.000Z", status: "sent", textPreview: "already done" },
    ];
    const root = await open({
      "GET /admin/api/data/reminders": () => answer(200, page(reminders)),
      "DELETE /admin/api/data/reminders/7": () => answer(200, { cancelled: true }),
    });
    const text = dom.text(root);
    assert.ok(text.includes("Reminders") && text.includes("Economy") && text.includes("Sticker commands"), "the eight tabs");
    assert.ok(text.includes("water the plants") && text.includes("Family") && text.includes("237690000001"));
    assert.ok(text.includes("Pending") && text.includes("Sent"));
    assert.equal(requests[0].search, "pageSize=25");
    assert.equal(dom.byText(root, "Cancel", "button").length, 1, "the sent reminder offers nothing");

    dom.click(button(root, "Cancel"));
    await dom.settle();
    assert.equal(count("DELETE /admin/api/data/reminders/7"), 0, "nothing before the confirmation");
    assert.equal(ui.confirmStore.get().request.title, "Cancel this reminder?");
    const gets = count("GET /admin/api/data/reminders");
    ui.resolveConfirm(true);
    await dom.settle(12);
    assert.equal(count("DELETE /admin/api/data/reminders/7"), 1);
    assert.equal(count("GET /admin/api/data/reminders"), gets + 1, "the list is read again");
    dom.unmount(root);
  });

  test("reminders: refusing the confirmation sends nothing", async () => {
    const root = await open({
      "GET /admin/api/data/reminders": () => answer(200, page([{ id: 7, chatJid: G1, chatName: null, creatorJid: U1, dueAt: "2030-01-02T03:04:05.000Z", status: "pending", textPreview: "x" }])),
    });
    dom.click(button(root, "Cancel"));
    await dom.settle();
    ui.resolveConfirm(false);
    await dom.settle(10);
    assert.equal(requests.filter((r) => r.key.startsWith("DELETE")).length, 0);
    dom.unmount(root);
  });

  test("a reminder that was sent meanwhile is reported and the list reloaded", async () => {
    const row = { id: 7, chatJid: G1, chatName: null, creatorJid: U1, dueAt: "2030-01-02T03:04:05.000Z", status: "pending", textPreview: "x" };
    const root = await open({
      "GET /admin/api/data/reminders": () => answer(200, page([row])),
      "DELETE /admin/api/data/reminders/7": () => answer(409, { error: { code: "not_pending" } }),
    });
    dom.click(button(root, "Cancel"));
    await dom.settle();
    const gets = count("GET /admin/api/data/reminders");
    ui.resolveConfirm(true);
    await dom.settle(12);
    assert.equal(count("GET /admin/api/data/reminders"), gets + 1);
    assert.ok(ui.toastStore.get().items.some((item) => item.kind === "error" && /no longer pending/.test(item.message)), JSON.stringify(ui.toastStore.get().items));
    dom.unmount(root);
  });

  test("the search waits for a pause, sends q and the status, and says when nothing matches", async () => {
    const root = await open({ "GET /admin/api/data/reminders": () => answer(200, page([])) });
    assert.ok(dom.text(root).includes("No reminder is waiting"));
    const before = requests.length;
    dom.type(field(root, "q"), "rent");
    dom.choose(field(root, "status"), "all");
    await dom.settle();
    assert.equal(requests.length, before, "nothing is sent while typing");
    await sleep(380);
    await dom.settle(10);
    const sent = requests.slice(before).filter((r) => r.key === "GET /admin/api/data/reminders");
    assert.equal(sent.length, 1);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(sent[0].search)), { q: "rent", status: "all", pageSize: "25" });
    assert.ok(dom.text(root).includes("Nothing matches"));
    dom.unmount(root);
  });

  test("a failed load offers a retry", async () => {
    const root = await open({ "GET /admin/api/data/tasks": () => answer(500, { error: { code: "internal_error" } }) }, "tasks");
    assert.ok(dom.text(root).includes("This page could not be displayed"));
    routes["GET /admin/api/data/tasks"] = () => answer(200, page([{ id: 1, chatJid: G1, text: "buy milk", done: false, createdBy: U1, doneBy: null }]));
    dom.click(button(root, "Try again"));
    await dom.settle(12);
    assert.ok(dom.text(root).includes("buy milk"));
    dom.unmount(root);
  });

  test("afk: Clear status asks, then sends the user JID, percent-encoded", async () => {
    const root = await open(
      {
        "GET /admin/api/data/afk": () => answer(200, page([{ jid: U1, name: "Ann", afkReason: "lunch", afkTime: "2030-01-01T00:00:00.000Z" }])),
        [`DELETE /admin/api/data/afk/${encodeURIComponent(U1)}`]: () => answer(200, { deleted: true }),
      },
      "afk",
    );
    assert.ok(dom.text(root).includes("Ann") && dom.text(root).includes("lunch"));
    dom.click(button(root, "Clear status"));
    await dom.settle();
    assert.equal(ui.confirmStore.get().request.title, "Clear this away status?");
    ui.resolveConfirm(true);
    await dom.settle(12);
    assert.equal(count(`DELETE /admin/api/data/afk/${encodeURIComponent(U1)}`), 1);
    dom.unmount(root);
  });

  test("tasks: Delete asks before deleting", async () => {
    const root = await open(
      {
        "GET /admin/api/data/tasks": () => answer(200, page([{ id: 3, chatJid: G1, text: "buy milk", done: true, createdBy: U1, doneBy: U2 }])),
        "DELETE /admin/api/data/tasks/3": () => answer(200, { deleted: true }),
      },
      "tasks",
    );
    assert.ok(dom.text(root).includes("buy milk") && dom.text(root).includes("Done"));
    dom.click(button(root, "Delete"));
    await dom.settle();
    assert.equal(ui.confirmStore.get().request.title, "Delete this item?");
    ui.resolveConfirm(true);
    await dom.settle(12);
    assert.equal(count("DELETE /admin/api/data/tasks/3"), 1);
    dom.unmount(root);
  });

  test("economy: nothing is asked until a group is chosen; then the balances and the adjustment form", async () => {
    const rows = [
      { groupJid: G1, userJid: U1, balance: 40, streak: 2, lastDailyAt: "2030-01-01T00:00:00.000Z" },
      { groupJid: G1, userJid: U2, balance: 0, streak: 0, lastDailyAt: null },
    ];
    const root = await open(
      {
        "GET /admin/api/chats": () => answer(200, page([{ jid: G1, kind: "group", name: "Family" }], { pageSize: 200 })),
        "GET /admin/api/data/economy": () => answer(200, page(rows)),
        "POST /admin/api/data/economy/adjust": () => answer(200, { balance: 65, delta: 25 }),
      },
      "economy",
    );
    assert.ok(dom.text(root).includes("Choose a group"));
    assert.equal(count("GET /admin/api/data/economy"), 0);
    assert.equal(dom.find(root, (el) => el.localName === "form" && dom.text(el).includes("Adjust a balance")).length, 0, "no form without a group");

    dom.choose(field(root, "economy-group"), G1);
    await dom.settle(12);
    const list = requests.find((r) => r.key === "GET /admin/api/data/economy");
    assert.deepEqual(Object.fromEntries(new URLSearchParams(list.search)), { groupJid: G1, pageSize: "25" });
    assert.ok(dom.text(root).includes("237690000001") && dom.text(root).includes("237690000002"));
    assert.ok(dom.text(root).includes("Adjust a balance"));

    // Adjust fills the member in
    dom.click(dom.byText(root, "Adjust", "button")[0]);
    await dom.settle();
    assert.equal(field(root, "userJid").value, U1);

    // a debit larger than the balance shown is flagged before anything is sent
    dom.type(field(root, "amount"), "-41");
    await dom.settle();
    assert.ok(dom.text(root).includes("The balance would become negative."), dom.text(root));
    dom.type(field(root, "amount"), "25");
    await dom.settle();
    assert.ok(!dom.text(root).includes("The balance would become negative."));
    assert.ok(dom.text(root).includes("Balance: 40, then 65."), "the preview");

    // the reason is mandatory
    submit(root, "Adjust a balance");
    await dom.settle();
    assert.equal(count("POST /admin/api/data/economy/adjust"), 0);
    assert.ok(dom.text(root).includes("This field is required."));

    dom.type(field(root, "reason"), "  event prize ");
    await dom.settle();
    const gets = count("GET /admin/api/data/economy");
    submit(root, "Adjust a balance");
    await dom.settle(12);
    const post = requests.find((r) => r.key === "POST /admin/api/data/economy/adjust");
    assert.deepEqual(post.body, { groupJid: G1, userJid: U1, mode: "add", amount: 25, reason: "event prize" });
    assert.equal(count("GET /admin/api/data/economy"), gets + 1, "the balances are read again");
    assert.equal(field(root, "reason").value, "", "the form is ready for the next adjustment");
    assert.ok(ui.toastStore.get().items.some((item) => item.kind === "success" && item.message.includes("65") && item.message.includes("+25")));
    dom.unmount(root);
  });

  test("economy: a debit the server refuses is shown on the amount, and the list is read again", async () => {
    const root = await open(
      {
        "GET /admin/api/chats": () => answer(200, page([{ jid: G1, kind: "group", name: "Family" }], { pageSize: 200 })),
        "GET /admin/api/data/economy": () => answer(200, page([])),
        "POST /admin/api/data/economy/adjust": () => answer(422, { error: { code: "negative_balance", params: { balance: 3 } } }),
      },
      "economy",
    );
    dom.type(field(root, "economy-group-typed"), G1);
    await dom.settle(12);
    assert.ok(dom.text(root).includes("Adjust a balance"), "a group typed by hand is enough");
    dom.type(field(root, "userJid"), "+237 690 000 009");
    dom.type(field(root, "amount"), "-5");
    dom.type(field(root, "reason"), "correction");
    await dom.settle();
    const gets = count("GET /admin/api/data/economy");
    submit(root, "Adjust a balance");
    await dom.settle(12);
    const post = requests.find((r) => r.key === "POST /admin/api/data/economy/adjust");
    assert.deepEqual(post.body, { groupJid: G1, userJid: "237690000009@s.whatsapp.net", mode: "add", amount: -5, reason: "correction" });
    assert.ok(dom.text(root).includes("The balance would become negative."));
    assert.equal(count("GET /admin/api/data/economy"), gets + 1);
    assert.equal(field(root, "reason").value, "correction", "what was typed is kept");
    dom.unmount(root);
  });

  test("economy: a group identifier that is not one is flagged and nothing is loaded", async () => {
    const root = await open({ "GET /admin/api/chats": () => answer(200, page([])) }, "economy");
    dom.type(field(root, "economy-group-typed"), "banana");
    await dom.settle(10);
    assert.ok(dom.text(root).includes("Invalid WhatsApp identifier."));
    assert.equal(count("GET /admin/api/data/economy"), 0);
    dom.unmount(root);
  });
});
