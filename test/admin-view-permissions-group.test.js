"use strict";
/**
 * The group "Permissions" tab in a fake DOM (specs/003-command-permissions T027; contracts/panel-ui.md sections 2, 7, 9
 * and 13 "Group tab"): lib/admin/public/js/views/groups-permissions.mjs and its wiring in groups-page.mjs.
 *
 * `createDom`, a scripted `fetch` that throws on an unexpected request, the real panel catalogs overlaid with the 003
 * fragment (so the file also runs before the catalogs are merged), `ui.confirmStore` / `resolveConfirm`.
 *
 *  1. the rules with their badges, the "allowed everywhere" card and its link to the Commands page;
 *  2. the create flow: select, "Create the rule", two members, the admin warning before Save, the exact PUT, PERM-5 again;
 *  3. locked commands: disabled options of the "Never delegable" optgroup with their reason (and the fallback reason);
 *  4. Delete asks first;
 *  5. the bot cannot read the members (PERM-5 `available: false`, or GRP-11 answering 409);
 *  6. an empty `extra` rule is saveable, the empty `only` rule warns, an edit that changes nothing leaves Save disabled;
 *  7. an orphan row deletes without a dialog; the tab badge and the TabPanel wiring through GroupPage;
 *  8. (T050) the deletion of a former group's settings reports the permission rules.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createDom, importPublic } = require("./helpers/fakeDom");

const ROOT = path.resolve(__dirname, "..");
const CATALOG_DIR = path.join(ROOT, "lib", "admin", "public", "i18n");
const FRAGMENT = path.join(ROOT, "specs", "003-command-permissions", "i18n", "panel-permissions.json");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** The real panel catalogs overlaid with the 003 fragment (the fragment wins, as in the merge) */
function catalogOf(lang) {
  const catalog = { ...readJson(path.join(CATALOG_DIR, `${lang}.json`)) };
  if (fs.existsSync(FRAGMENT)) Object.assign(catalog, readJson(FRAGMENT)[lang] || {});
  return catalog;
}
const CATALOGS = { en: catalogOf("en"), fr: catalogOf("fr") };

const pn = (digits) => `${digits}@s.whatsapp.net`;
const A = pn("237690000001");
const B = pn("237690000002");
const C = pn("237690000003");
const D = pn("237690000004");
const E = pn("237690000005");
const GROUP = "120363000000000000@g.us";
const GROUP_PATH = `/admin/api/groups/${encodeURIComponent(GROUP)}`;
const PERM5 = `GET ${GROUP_PATH}/permissions`;
const MEMBERS = `GET ${GROUP_PATH}/members`;
const CMD1 = "GET /admin/api/commands";
const PERM1 = "GET /admin/api/permissions";
const rulePath = (name) => `${GROUP_PATH}/permissions/${encodeURIComponent(name)}`;

const person = (jid, over = {}) => ({ jid, name: null, present: true, admin: null, ...over });
const rule = (command, mode, people, warnings = []) => ({ command, scope: GROUP, mode, people, warnings, createdAt: "2026-10-30T10:00:00.000Z", updatedAt: "2026-10-30T10:00:00.000Z" });
const everywhere = (command, mode, people) => ({ command, scope: "*", mode, people, warnings: [], createdAt: "2026-10-30T10:00:00.000Z", updatedAt: "2026-10-30T10:00:00.000Z" });
const warning = {
  opens: (count) => ({ code: "opens_admin_command", tone: "warn", params: { count, everywhere: false } }),
  normalHere: (tone) => ({ code: "normal_here", tone, params: {} }),
  emptyOnly: () => ({ code: "empty_only", tone: "warn", params: {} }),
};

const command = (name, access = {}) => ({
  name,
  aliases: [name],
  type: "general",
  desc: `desc of ${name}`,
  access: { owner: false, admin: false, group: false, pm: false, ...access },
  disabledGlobal: false,
  disabledGroups: [],
});
const COMMANDS = [
  command("vv", { owner: true }),
  command("kick", { admin: true, group: true }),
  command("dice"),
  command("sticker"),
  command("eval", { owner: true }),
  command("ban", { admin: true, group: true }),
  command("legacy", { owner: true }),
];
const item = (name, over = {}) => ({ name, delegable: true, lockReason: null, everywhere: null, groups: 0, ...over });
const lockedItem = (name, lockReason) => item(name, { delegable: false, lockReason });
const ITEMS = [item("vv"), item("kick"), item("dice"), item("sticker"), lockedItem("eval", "code"), lockedItem("ban", "lockout"), lockedItem("legacy", "mystery")];

/** A PERM-5 answer */
const perm5 = ({ rules = [], everywhere: everywhereRules = [], orphans = [], available = true } = {}) => ({
  rules,
  everywhere: everywhereRules,
  orphans,
  members: { available, fetchedAt: available ? "2026-10-30T10:00:00.000Z" : null },
  limits: { peopleMax: 100 },
});

/** The first scenario: two group rules, two "everywhere" rules, one of which the group overrides */
const scenario1 = () => ({
  perm: perm5({
    rules: [rule("dice", "extra", [], [warning.normalHere("info")]), rule("kick", "extra", [person(A), person(B, { present: false }), person(C, { admin: "admin" })], [warning.opens(2)])],
    everywhere: [everywhere("vv", "extra", [person(D, { present: false, admin: "admin" }), person(E)]), everywhere("dice", "only", [])],
  }),
});

let dom;
let ui;
let htmlTag;
let view;
let pageView;
let requests;
let routes;
let reloads;

const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const failure = (status, code) => answer(status, { error: { code, fields: {}, params: {}, requestId: "r1" } });
const button = (root, text) => dom.byText(root, text, "button")[0];
const byLabel = (root, label, tag) => dom.byAttr(root, "aria-label", label, tag)[0];
const countOf = (key) => requests.filter((r) => r.key === key).length;
const select = (root) => dom.find(root, (el) => el.localName === "select")[0];
const optgroup = (root, label) => dom.find(root, (el) => el.localName === "optgroup" && el.prop("label") === label)[0];
const options = (group) => dom.find(group, (el) => el.localName === "option");
/** The section whose heading (h2) is `title` */
const card = (root, title) => dom.find(root, (el) => el.localName === "section" && el.childNodes.some((child) => child.localName === "h2" && dom.text(child) === title))[0];
const chips = (root) => dom.find(root, (el) => el.localName === "li" && el.prop("class") === "chip");
const toasts = () => ui.toastStore.get().items.map((entry) => entry.message);

/** Mount the tab with a scripted server: the three loads are always answered, `extra` adds or overrides routes */
function open(state, extra = {}, { group = {} } = {}) {
  requests = [];
  reloads = 0;
  routes = {
    [PERM5]: () => answer(200, state.perm),
    [CMD1]: () => answer(200, { commands: state.commands || COMMANDS, types: [], orphans: [] }),
    [PERM1]: () => answer(200, { items: state.items || ITEMS, orphans: [], limits: { peopleMax: 100 } }),
    ...extra,
  };
  globalThis.fetch = async (url, init) => {
    const [route, search] = url.split("?");
    const key = `${init.method} ${route}`;
    requests.push({ key, search: search || "", body: init.body ? JSON.parse(init.body) : undefined });
    if (!routes[key]) throw new Error(`unexpected request ${key}`);
    return routes[key](init.body ? JSON.parse(init.body) : undefined, search || "");
  };
  const props = { jid: GROUP, name: "Chess club", former: false, disabledCommands: [], ...group };
  return dom.mount(htmlTag`<${view.PermissionsTab} group=${props} onGroup=${() => {}} reload=${async () => { reloads += 1; }} />`);
}

before(async () => {
  dom = await createDom();
  const i18n = await importPublic("js/i18n.mjs");
  for (const lang of ["en", "fr"]) i18n.setCatalog(lang, CATALOGS[lang]);
  await i18n.setLanguage("en", { remember: false });
  ui = await importPublic("js/ui.mjs");
  htmlTag = (await importPublic("js/components/html.mjs")).html;
  view = await importPublic("js/views/groups-permissions.mjs");
  pageView = await importPublic("js/views/groups-page.mjs");
});

after(() => {
  if (dom) dom.restore();
  delete globalThis.fetch;
});

beforeEach(() => {
  ui.toastStore.set({ items: [] });
});

describe("the module", () => {
  test("it imports in plain Node and exports PermissionsTab", () => {
    assert.equal(typeof view.PermissionsTab, "function");
  });
});

describe("1. the rules and the allowed-everywhere card", () => {
  test("rules sorted by command with their mode, count, badges and people chips", async () => {
    const root = open(scenario1());
    await dom.settle(12);
    const text = dom.text(root);
    assert.ok(text.includes("Permissions of this group"), "the new rule card");
    const rules = card(root, "Rules of this group");
    assert.ok(rules, "the rules card");
    const rows = dom.find(rules, (el) => el.localName === "tr" && el.parentNode.localName === "tbody");
    assert.equal(rows.length, 2);
    assert.ok(dom.text(rows[0]).startsWith("dice") && dom.text(rows[1]).startsWith("kick"), "sorted by command");
    assert.ok(dom.text(rows[0]).includes("Normal + these people") && dom.text(rows[0]).includes("0 people"));
    assert.ok(dom.text(rows[0]).includes("Exception: normal level here"), "an empty extra rule reads as an exception");
    assert.ok(dom.text(rows[1]).includes("3 people"));
    assert.ok(dom.text(rows[1]).includes("Opens an admin command"), "the server's warning as a short badge");
    assert.ok(dom.text(rows[1]).includes("+237690000001") && dom.text(rows[1]).includes("+237690000003"));
    assert.ok(dom.text(rows[1]).includes("Not an admin"), "present, not an admin, on an admin command");
    assert.ok(dom.text(rows[1]).includes("No longer in the group"), "former");
    assert.ok(dom.text(rows[1]).includes("Admin"), "the admin badge");
    assert.ok(byLabel(root, "Edit the rule for kick", "button") && byLabel(root, "Edit the rule for dice", "button"));
    dom.unmount(root);
  });

  test("more than six people: the first six and '+N more'", async () => {
    const many = Array.from({ length: 9 }, (_, i) => person(pn(`23769000010${i}`)));
    const root = open({ perm: perm5({ rules: [rule("dice", "extra", many)] }) });
    await dom.settle(12);
    const rules = card(root, "Rules of this group");
    assert.equal(chips(rules).length, 6);
    assert.ok(dom.text(rules).includes("+3 more"));
    assert.ok(dom.text(rules).includes("9 people"));
    dom.unmount(root);
  });

  test("an empty group: the empty state", async () => {
    const root = open({ perm: perm5() });
    await dom.settle(12);
    assert.ok(dom.text(card(root, "Rules of this group")).includes("No rule in this group."));
    assert.ok(dom.text(root).includes("Every command keeps its normal level."));
    assert.equal(card(root, "Rules without a usable command"), undefined, "no orphan card without orphans");
    dom.unmount(root);
  });

  test("the allowed-everywhere card: the mode that applies here, plain chips, only-owner and the link (T049)", async () => {
    const root = open(scenario1());
    await dom.settle(12);
    const box = card(root, "Allowed everywhere");
    assert.ok(box, "the card");
    const text = dom.text(box);
    assert.ok(text.includes("Edit them on the Commands page"));
    const items = dom.find(box, (el) => el.localName === "li" && el.parentNode.localName === "ul" && el.parentNode.prop("class") !== "row-wrap");
    assert.equal(items.length, 2);
    const vv = items.find((el) => dom.text(el).startsWith("vv"));
    const dice = items.find((el) => dom.text(el).startsWith("dice"));
    assert.ok(dom.text(vv).includes("Mode here: Normal + these people"), "no group rule: the everywhere mode");
    assert.ok(!dom.text(vv).includes("rule of this group"));
    assert.ok(dom.text(vv).includes("+237690000004") && dom.text(vv).includes("+237690000005"), "the people of the everywhere rule");
    assert.ok(!dom.text(vv).includes("No longer in the group") && !dom.text(vv).includes("Admin") && !dom.text(vv).includes("Not an admin"), "plain chips: no badge");
    assert.ok(dom.text(dice).includes("Mode here: Normal + these people (rule of this group)"), "the group rule wins");
    assert.ok(dom.text(dice).includes("Only the owner"), "an only rule with nobody");
    const link = dom.byAttr(vv, "href", "#/commands?command=vv&panel=permissions", "a")[0];
    assert.ok(link, dom.find(vv, (el) => el.localName === "a").map((el) => el.prop("href")).join(","));
    assert.ok(dom.text(link).includes("Edit vv on the Commands page"));
    dom.unmount(root);
  });

  test("the allowed-everywhere card says when nobody is allowed everywhere", async () => {
    const root = open({ perm: perm5({ rules: [rule("dice", "extra", [])] }) });
    await dom.settle(12);
    assert.ok(dom.text(card(root, "Allowed everywhere")).includes("Nobody is allowed everywhere."));
    dom.unmount(root);
  });

  test("an everywhere rule on a locked or unknown command is not a row", async () => {
    const root = open({ perm: perm5({ everywhere: [everywhere("eval", "extra", [person(D)]), everywhere("ghost", "extra", [person(E)])] }) });
    await dom.settle(12);
    assert.ok(dom.text(card(root, "Allowed everywhere")).includes("Nobody is allowed everywhere."));
    dom.unmount(root);
  });
});

describe("2. the create flow", () => {
  test("select, Create the rule, two members, the warning before Save, the exact PUT, PERM-5 again and the parent reload", async () => {
    const state = { perm: perm5() };
    const root = open(state, {
      [MEMBERS]: () => answer(200, { items: [{ jid: A, admin: null, role: "regular" }, { jid: B, admin: null, role: "regular" }, { jid: C, admin: "admin", role: "regular" }] }),
      [`PUT ${rulePath("kick")}`]: (body) => {
        state.perm = perm5({ rules: [rule("kick", body.mode, body.people.map((jid) => person(jid)), [warning.opens(body.people.length)])] });
        return answer(200, { rule: state.perm.rules[0], changed: true });
      },
    });
    await dom.settle(12);
    assert.equal(countOf(PERM5), 1);
    const create = button(root, "Create the rule");
    assert.equal(create.prop("disabled"), true, "disabled until a command is chosen");
    assert.equal(dom.find(root, (el) => el.localName === "h2" && dom.text(el).startsWith("Rule for")).length, 0, "no editor yet");

    dom.choose(select(root), "kick");
    await dom.settle();
    assert.equal(create.prop("disabled"), false);
    dom.click(create);
    await dom.settle(12);
    assert.ok(dom.text(root).includes("Rule for kick"), "the editor opens");
    assert.equal(countOf(MEMBERS), 1, "the member list is read once");
    assert.ok(!dom.text(root).includes("not known to be"), "no warning without people");

    dom.check(byLabel(root, "Allow +237690000001", "input"), true);
    dom.check(byLabel(root, "Allow +237690000002", "input"), true);
    await dom.settle();
    assert.ok(dom.text(root).includes("2 people are not known to be admins of this group"), "the admin-command warning is visible before Save");
    assert.equal(countOf(`PUT ${rulePath("kick")}`), 0);

    dom.click(button(root, "Save"));
    await dom.settle(15);
    const puts = requests.filter((r) => r.key === `PUT ${rulePath("kick")}`);
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0].body, { mode: "extra", people: [A, B] }, "mode and the two jids, nothing else");
    assert.equal(countOf(PERM5), 2, "PERM-5 is read again");
    assert.equal(reloads, 1, "the parent reloads the tab badge");
    assert.ok(toasts().includes("Rule saved for kick."), toasts().join("|"));
    assert.ok(dom.text(root).includes("Rule for kick"), "the editor stays open on the saved rule");
    assert.ok(button(root, "Delete the rule"), "and offers Delete now that the rule exists");
    assert.equal(button(root, "Save").prop("disabled"), true, "nothing left to save");
    assert.ok(dom.text(card(root, "Rules of this group")).includes("2 people"), "the rule is listed");
    assert.ok(!dom.byText(root, "kick", "option").length, "kick left the select: it is edited from its row");
    dom.unmount(root);
  });

  test("a failing save is toasted and keeps the draft", async () => {
    const root = open(
      { perm: perm5() },
      {
        [MEMBERS]: () => answer(200, { items: [{ jid: A, admin: null, role: "regular" }] }),
        [`PUT ${rulePath("kick")}`]: () => failure(409, "not_connected"),
      },
    );
    await dom.settle(12);
    dom.choose(select(root), "kick");
    await dom.settle();
    dom.click(button(root, "Create the rule"));
    await dom.settle(12);
    dom.check(byLabel(root, "Allow +237690000001", "input"), true);
    await dom.settle();
    dom.click(button(root, "Save"));
    await dom.settle(12);
    assert.ok(ui.toastStore.get().items.some((entry) => entry.kind === "error"), "the error is toasted");
    assert.equal(chips(root).length, 1, "the draft is kept");
    assert.equal(countOf(PERM5), 1, "no reload after a failure");
    assert.equal(reloads, 0);
    dom.unmount(root);
  });
});

describe("3. the never-delegable commands", () => {
  test("disabled options with their reason, an unknown reason shows the fallback", async () => {
    const root = open(scenario1());
    await dom.settle(12);
    const delegable = optgroup(root, "Commands you can delegate");
    const locked = optgroup(root, "Never delegable");
    assert.ok(delegable && locked, "the two optgroups");
    assert.deepEqual(options(delegable).map((o) => o.prop("value")), ["sticker", "vv"], "delegable commands without a rule, sorted");
    for (const o of options(delegable)) assert.equal(o.prop("disabled"), false, o.prop("value"));
    const lockedOptions = options(locked);
    assert.deepEqual(lockedOptions.map((o) => o.prop("value")), ["ban", "eval", "legacy"], "every locked command, sorted");
    for (const o of lockedOptions) assert.equal(o.prop("disabled"), true, o.prop("value"));
    const texts = Object.fromEntries(lockedOptions.map((o) => [o.prop("value"), dom.text(o)]));
    assert.equal(texts.eval, "eval - it runs code on the bot's machine");
    assert.equal(texts.ban, "ban - it can lock the owner out of a chat");
    assert.equal(texts.legacy, "legacy - it is reserved to the owner", "an unknown lockReason shows the fallback");
    dom.unmount(root);
  });

  test("choosing a locked name never enables Create the rule", async () => {
    const root = open(scenario1());
    await dom.settle(12);
    dom.choose(select(root), "eval");
    await dom.settle();
    assert.equal(button(root, "Create the rule").prop("disabled"), true);
    dom.choose(select(root), "vv");
    await dom.settle();
    assert.equal(button(root, "Create the rule").prop("disabled"), false);
    dom.choose(select(root), "");
    await dom.settle();
    assert.equal(button(root, "Create the rule").prop("disabled"), true);
    dom.unmount(root);
  });

  test("a command with no PERM-1 item is in neither list", async () => {
    const root = open({ ...scenario1(), items: ITEMS.filter((entry) => entry.name !== "sticker") });
    await dom.settle(12);
    assert.deepEqual(options(optgroup(root, "Commands you can delegate")).map((o) => o.prop("value")), ["vv"]);
    dom.unmount(root);
  });
});

describe("4. Delete asks first", () => {
  test("refusing sends nothing; accepting sends DELETE, reloads and closes the editor", async () => {
    const state = scenario1();
    const root = open(
      state,
      {
        [`DELETE ${rulePath("kick")}`]: () => {
          state.perm = perm5({ rules: state.perm.rules.filter((r) => r.command !== "kick"), everywhere: state.perm.everywhere });
          return answer(200, { deleted: true });
        },
      },
    );
    await dom.settle(12);
    dom.click(byLabel(root, "Edit the rule for kick", "button"));
    await dom.settle(12);
    assert.ok(dom.text(root).includes("Rule for kick"));

    dom.click(button(root, "Delete the rule"));
    await dom.settle();
    const request = ui.confirmStore.get().request;
    assert.equal(request.title, "Delete the rule for kick?");
    assert.ok(request.message.includes("goes back to its normal level here"));
    assert.equal(request.confirmLabel, "Delete the rule");
    assert.equal(countOf(`DELETE ${rulePath("kick")}`), 0, "nothing before the confirmation");
    ui.resolveConfirm(false);
    await dom.settle(10);
    assert.equal(requests.filter((r) => r.key.startsWith("DELETE")).length, 0, "refusing sends nothing");
    assert.ok(dom.text(root).includes("Rule for kick"), "the editor is still open");

    dom.click(button(root, "Delete the rule"));
    await dom.settle();
    ui.resolveConfirm(true);
    await dom.settle(15);
    assert.equal(countOf(`DELETE ${rulePath("kick")}`), 1);
    assert.equal(countOf(PERM5), 2, "PERM-5 is read again");
    assert.equal(reloads, 1, "the badge");
    assert.ok(toasts().includes("Rule removed for kick."), toasts().join("|"));
    assert.ok(!dom.text(root).includes("Rule for kick"), "the editor closed");
    assert.equal(byLabel(root, "Edit the rule for kick", "button"), undefined, "the row is gone");
    dom.unmount(root);
  });
});

describe("5. the bot cannot read the members", () => {
  const savedRule = () => rule("kick", "only", [person(A, { present: null }), person(B, { present: null })], [warning.opens(2)]);

  test("members.available false: the notice, no GRP-11 call, no picker, removing and Save still work, no 'former' badge", async () => {
    const state = { perm: perm5({ available: false, rules: [savedRule()] }) };
    const root = open(state, { [`PUT ${rulePath("kick")}`]: () => answer(200, { rule: state.perm.rules[0], changed: true }) });
    await dom.settle(12);
    dom.click(byLabel(root, "Edit the rule for kick", "button"));
    await dom.settle(12);
    assert.ok(dom.text(root).includes("The bot cannot read the member list right now"));
    assert.equal(requests.filter((r) => r.key === MEMBERS).length, 0, "no GRP-11 request");
    assert.equal(dom.find(root, (el) => el.localName === "input" && el.prop("type") === "checkbox").length, 0, "no picker");
    assert.equal(dom.find(root, (el) => el.localName === "input" && el.prop("type") === "search").length, 0);
    assert.ok(!dom.text(root).includes("No longer in the group"), "present is unknown, not a fact");

    dom.click(byLabel(root, "Remove +237690000001", "button"));
    await dom.settle();
    assert.equal(button(root, "Save").prop("disabled"), false);
    dom.click(button(root, "Save"));
    await dom.settle(15);
    const puts = requests.filter((r) => r.key === `PUT ${rulePath("kick")}`);
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0].body, { mode: "only", people: [B] });
    dom.unmount(root);
  });

  test("GRP-11 answering 409 gives the same result", async () => {
    const state = { perm: perm5({ rules: [savedRule()] }) };
    const root = open(state, { [MEMBERS]: () => failure(409, "not_connected"), [`PUT ${rulePath("kick")}`]: () => answer(200, { rule: state.perm.rules[0], changed: true }) });
    await dom.settle(12);
    dom.click(byLabel(root, "Edit the rule for kick", "button"));
    await dom.settle(12);
    assert.equal(requests.filter((r) => r.key === MEMBERS).length, 1);
    assert.ok(dom.text(root).includes("The bot cannot read the member list right now"));
    assert.equal(dom.find(root, (el) => el.localName === "input" && el.prop("type") === "checkbox").length, 0);
    dom.click(byLabel(root, "Remove +237690000002", "button"));
    await dom.settle();
    dom.click(button(root, "Save"));
    await dom.settle(15);
    assert.deepEqual(requests.find((r) => r.key === `PUT ${rulePath("kick")}`).body, { mode: "only", people: [A] });
    dom.unmount(root);
  });
});

describe("6. empty lists", () => {
  test("an extra rule with nobody can be saved in a group (normal level here)", async () => {
    const state = { perm: perm5({ everywhere: [everywhere("dice", "only", [])] }) };
    const root = open(state, {
      [MEMBERS]: () => answer(200, { items: [] }),
      [`PUT ${rulePath("dice")}`]: (body) => {
        state.perm = perm5({ rules: [rule("dice", body.mode, [], [warning.normalHere("info")])], everywhere: state.perm.everywhere });
        return answer(200, { rule: state.perm.rules[0], changed: true });
      },
    });
    await dom.settle(12);
    dom.choose(select(root), "dice");
    await dom.settle();
    dom.click(button(root, "Create the rule"));
    await dom.settle(12);
    assert.ok(dom.text(root).includes('An empty list means "normal level here"'), "information when an everywhere only rule exists");
    assert.equal(button(root, "Save").prop("disabled"), false, "Save is enabled");
    assert.ok(!dom.text(root).includes("Add at least one person"), "no everywhere-style refusal in a group");
    dom.click(button(root, "Save"));
    await dom.settle(15);
    assert.deepEqual(requests.find((r) => r.key === `PUT ${rulePath("dice")}`).body, { mode: "extra", people: [] });
    assert.ok(dom.text(card(root, "Rules of this group")).includes("Exception: normal level here"));
    dom.unmount(root);
  });

  test("an empty extra rule with no everywhere rule says it has no effect", async () => {
    const root = open({ perm: perm5() }, { [MEMBERS]: () => answer(200, { items: [] }) });
    await dom.settle(12);
    dom.choose(select(root), "dice");
    await dom.settle();
    dom.click(button(root, "Create the rule"));
    await dom.settle(12);
    assert.ok(dom.text(root).includes("This rule has no effect"));
    dom.unmount(root);
  });

  test("the empty only rule shows the 'Empty list' banner; an edit that changes nothing leaves Save disabled", async () => {
    const root = open({ perm: perm5({ rules: [rule("vv", "only", [], [warning.emptyOnly()])] }) }, { [MEMBERS]: () => answer(200, { items: [] }) });
    await dom.settle(12);
    assert.ok(dom.text(card(root, "Rules of this group")).includes("Empty list"), "the short badge of the row");
    dom.click(byLabel(root, "Edit the rule for vv", "button"));
    await dom.settle(12);
    assert.ok(dom.text(root).includes("The list is empty: only the owner will be able to use this command."), "the banner");
    assert.equal(button(root, "Save").prop("disabled"), true, "unchanged");
    const radio = (mode) => dom.find(root, (el) => el.localName === "input" && el.prop("type") === "radio" && el.prop("value") === mode)[0];
    dom.check(radio("extra"), true);
    await dom.settle();
    assert.equal(button(root, "Save").prop("disabled"), false, "a real change");
    dom.check(radio("only"), true);
    await dom.settle();
    assert.equal(button(root, "Save").prop("disabled"), true, "back to the saved rule: nothing to save");
    dom.unmount(root);
  });
});

describe("7. orphans, the tab badge and the GroupPage wiring", () => {
  const orphans = [
    { command: "oldcmd", mode: "extra", count: 2, reason: "unknown_command" },
    { command: "eval", mode: "only", count: 1, reason: "not_delegable" },
  ];

  test("an orphan row deletes with DELETE and no dialog, then reloads (T049)", async () => {
    const state = { perm: perm5({ orphans }) };
    const root = open(state, {
      [`DELETE ${rulePath("oldcmd")}`]: () => {
        state.perm = perm5({ orphans: orphans.filter((o) => o.command !== "oldcmd") });
        return answer(200, { deleted: true });
      },
    });
    await dom.settle(12);
    const box = card(root, "Rules without a usable command");
    assert.ok(box, "the orphan card");
    const text = dom.text(box);
    assert.ok(text.includes("They have no effect: you can delete them."));
    assert.ok(text.includes("oldcmd") && text.includes("Command no longer loaded"));
    assert.ok(text.includes("eval") && text.includes("Command that can no longer be delegated"));
    const trash = dom.find(box, (el) => el.localName === "button" && el.prop("aria-label") === "Delete the rule for oldcmd (Chess club)")[0];
    assert.ok(trash, dom.find(box, (el) => el.localName === "button").map((el) => el.prop("aria-label")).join("|"));

    dom.click(trash);
    await dom.settle(15);
    assert.equal(ui.confirmStore.get().request, null, "no dialog");
    assert.equal(countOf(`DELETE ${rulePath("oldcmd")}`), 1);
    assert.equal(countOf(PERM5), 2);
    assert.equal(reloads, 1);
    assert.ok(toasts().includes("Rule for oldcmd deleted."), toasts().join("|"));
    assert.ok(!dom.text(card(root, "Rules without a usable command")).includes("oldcmd"), "the row is gone");
    assert.ok(dom.text(card(root, "Rules without a usable command")).includes("eval"), "the other one stays");
    dom.unmount(root);
  });

  test("an orphan the server no longer has answers deleted:false without breaking the tab", async () => {
    const root = open({ perm: perm5({ orphans }) }, { [`DELETE ${rulePath("eval")}`]: () => answer(200, { deleted: false }) });
    await dom.settle(12);
    dom.click(dom.find(root, (el) => el.localName === "button" && el.prop("aria-label") === "Delete the rule for eval (Chess club)")[0]);
    await dom.settle(15);
    assert.equal(countOf(`DELETE ${rulePath("eval")}`), 1);
    assert.equal(countOf(PERM5), 2);
    dom.unmount(root);
  });

  test("a failing load shows the error state with Retry (any of the three requests)", async () => {
    for (const failing of [PERM5, CMD1, PERM1]) {
      const root = open(scenario1(), { [failing]: () => failure(500, "internal_error") });
      await dom.settle(12);
      assert.ok(dom.text(root).includes("This page could not be displayed"), failing);
      assert.ok(button(root, "Try again"), failing);
      assert.equal(card(root, "Rules of this group"), undefined);
      routes[failing] = () => answer(200, failing === PERM5 ? scenario1().perm : failing === CMD1 ? { commands: COMMANDS, types: [], orphans: [] } : { items: ITEMS, orphans: [], limits: { peopleMax: 100 } });
      dom.click(button(root, "Try again"));
      await dom.settle(12);
      assert.ok(card(root, "Rules of this group"), `${failing}: the retry works`);
      dom.unmount(root);
    }
  });

  describe("through GroupPage", () => {
    const GRP3 = `GET ${GROUP_PATH}`;
    const groupBody = (over = {}) => ({
      jid: GROUP,
      name: "Chess club",
      former: false,
      botIsAdmin: true,
      members: 12,
      leftAt: null,
      disabled: false,
      disabledCommands: [],
      warnings: [],
      counts: { filters: 0, roles: 0, warnings: 0, permissions: 3 },
      ...over,
    });
    const openPage = (body, tab, extra = {}) => {
      const state = scenario1();
      requests = [];
      routes = {
        [GRP3]: () => answer(200, body),
        [PERM5]: () => answer(200, state.perm),
        [CMD1]: () => answer(200, { commands: COMMANDS, types: [], orphans: [] }),
        [PERM1]: () => answer(200, { items: ITEMS, orphans: [], limits: { peopleMax: 100 } }),
        ...extra,
      };
      globalThis.fetch = async (url, init) => {
        const [route, search] = url.split("?");
        const key = `${init.method} ${route}`;
        requests.push({ key, search: search || "", body: init.body ? JSON.parse(init.body) : undefined });
        if (!routes[key]) throw new Error(`unexpected request ${key}`);
        return routes[key](init.body ? JSON.parse(init.body) : undefined, search || "");
      };
      return dom.mount(htmlTag`<${pageView.GroupPage} jid=${GROUP} tab=${tab} />`);
    };
    const tabButton = (root, id) => dom.byAttr(root, "id", `group-tab-${id}`, "button")[0];

    test("tab=permissions renders the tab between Commands and Advanced, with the GRP-3 count as its badge", async () => {
      const root = openPage(groupBody(), "permissions");
      await dom.settle(15);
      const order = dom.find(root, (el) => el.localName === "button" && el.prop("role") === "tab").map((el) => el.prop("id"));
      assert.deepEqual(order, ["messages", "protection", "filters", "members", "commands", "permissions", "advanced"].map((id) => `group-tab-${id}`));
      assert.equal(tabButton(root, "permissions").prop("aria-selected"), "true");
      assert.equal(dom.text(tabButton(root, "permissions")), "Permissions 3", "the badge is counts.permissions");
      const panel = dom.byAttr(root, "id", "group-tab-panel-permissions", "div")[0];
      assert.ok(panel, "the TabPanel");
      assert.ok(dom.text(panel).includes("Permissions of this group") && dom.text(panel).includes("Rules of this group"));
      assert.equal(countOf(PERM5), 1);
      dom.unmount(root);
    });

    test("a real 0 shows 0; a missing field shows no badge", async () => {
      const zero = openPage(groupBody({ counts: { filters: 0, roles: 0, warnings: 0, permissions: 0 } }), "permissions");
      await dom.settle(15);
      assert.equal(dom.text(tabButton(zero, "permissions")), "Permissions 0");
      dom.unmount(zero);

      const missing = openPage(groupBody({ counts: { filters: 0, roles: 0, warnings: 0 } }), "permissions");
      await dom.settle(15);
      assert.equal(dom.text(tabButton(missing, "permissions")), "Permissions");
      dom.unmount(missing);
    });

    test("another tab does not load the permissions", async () => {
      const root = openPage(groupBody(), "protection");
      await dom.settle(15);
      assert.equal(dom.byAttr(root, "id", "group-tab-panel-permissions", "div").length, 0);
      assert.equal(countOf(PERM5), 0, "nothing is requested before the tab opens");
      dom.unmount(root);
    });
  });
});

describe("8. forgetting a former group (T050)", () => {
  test("the Advanced tab reports the permission rules in its hint and its toast", async () => {
    requests = [];
    const GRP3 = `GET ${GROUP_PATH}`;
    routes = {
      [GRP3]: () => answer(200, { jid: GROUP, name: "Chess club", former: true, botIsAdmin: null, members: null, leftAt: "2026-10-01T10:00:00.000Z", disabled: false, disabledCommands: [], warnings: [], counts: { filters: 1, roles: 0, warnings: 0, permissions: 2 } }),
      [`DELETE ${GROUP_PATH}`]: () => answer(200, { deleted: { filters: 1, roles: 0, warnings: 0, commandStates: 0, permissionRules: 2 } }),
    };
    globalThis.fetch = async (url, init) => {
      const [route, search] = url.split("?");
      const key = `${init.method} ${route}`;
      requests.push({ key, search: search || "" });
      if (!routes[key]) throw new Error(`unexpected request ${key}`);
      return routes[key]();
    };
    const root = dom.mount(htmlTag`<${pageView.GroupPage} jid=${GROUP} tab="advanced" />`);
    await dom.settle(15);
    const text = dom.text(root);
    assert.ok(text.includes("disabled commands and permission rules"), "the hint names the permission rules");
    assert.ok(!text.includes("warnings and disabled commands"), "not the old hint");
    dom.click(button(root, "Delete the settings"));
    await dom.settle();
    ui.resolveConfirm(true);
    await dom.settle(15);
    const call = requests.find((r) => r.key === `DELETE ${GROUP_PATH}`);
    assert.ok(call, "the DELETE is sent");
    assert.equal(call.search, "confirm=true", "the call itself is unchanged");
    assert.ok(toasts().includes("Settings deleted (1 filters, 0 roles, 0 warnings, 0 disabled commands, 2 permission rules)."), toasts().join("|"));
    dom.unmount(root);
  });
});
