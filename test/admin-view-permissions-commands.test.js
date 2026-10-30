"use strict";
/**
 * The Commands page with the permissions of feature 003 (specs/003-command-permissions T040, contracts/panel-ui.md
 * section 13, cases 8 to 12), rendered in the fake DOM against a scripted `fetch` that refuses any request it was not
 * given: lib/admin/public/js/views/commands.mjs and commands-permissions.mjs.
 *
 *  8. the "Permissions" column and its summaries (rule, none, groups count, unavailable), a locked row, a PERM-1
 *     failure that leaves the page working;
 *  9. the "everywhere" card: a contact from CHAT-1 (no `selectable`), a typed number, the refusals, Save (PERM-3),
 *     Delete behind a confirmation (PERM-4), PERM-1 read again, the cap from `limits`;
 * 10. the groups list is read-only and links to the group tab;
 * 11. `?command=<name>&panel=permissions` opens the card (an unknown or locked command does not); one editor at a time;
 * 12. permission orphans: scope `*` calls PERM-4, a group scope PERM-7, no dialog.
 *
 * The panel catalogs are the real files overlaid with the 003 fragment, so the file also runs before they are merged.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createDom, importPublic, FakeElement } = require("./helpers/fakeDom");

const ROOT = path.resolve(__dirname, "..");
const CATALOG_DIR = path.join(ROOT, "lib", "admin", "public", "i18n");
const FRAGMENT = path.join(ROOT, "specs", "003-command-permissions", "i18n", "panel-permissions.json");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const pn = (digits) => `${digits}@s.whatsapp.net`;
const A = pn("237690000001");
const B = pn("237690000002");
const C = pn("237690000003");
const D = pn("237690000004");
const E = pn("237690000005");
const G1 = "120363111111111111@g.us";
const G2 = "120363222222222222@g.us";
const G3 = "120363333333333333@g.us";
const enc = encodeURIComponent;

const VV_RULE = (people = [A, B], over = {}) => ({
  command: "vv",
  scope: "*",
  mode: "extra",
  people: people.map((jid) => ({ jid, name: jid === A ? "Alice" : null })),
  warnings: [],
  createdAt: "2026-10-30T10:00:00.000Z",
  updatedAt: "2026-10-30T10:00:00.000Z",
  ...over,
});

const cmd = (name, over = {}) => ({
  name,
  aliases: [name],
  type: "general",
  desc: `desc of ${name}`,
  access: { owner: false, admin: false, group: false, pm: false },
  disabledGlobal: false,
  disabledGroups: [],
  ...over,
});
const item = (name, over = {}) => ({ name, delegable: true, lockReason: null, everywhere: null, groups: 0, ...over });

/** CMD-1: a delegable command with a rule, an admin one, a plain one, two locked ones and one PERM-1 knows nothing about */
const cmd1 = (over = {}) => ({
  commands: [
    cmd("vv", { aliases: ["vv", "vo"] }),
    cmd("kick", { access: { owner: false, admin: true, group: true, pm: false }, type: "group" }),
    cmd("dice"),
    cmd("eval", { access: { owner: true, admin: false, group: false, pm: false }, type: "owner" }),
    cmd("ban", { access: { owner: true, admin: false, group: false, pm: false }, type: "owner" }),
    cmd("ghost"),
  ],
  types: ["general", "group", "owner"],
  orphans: [],
  ...over,
});

/** PERM-1: no item for `ghost` */
const perm1 = (over = {}) => ({
  items: [
    item("ban", { delegable: false, lockReason: null }),
    item("dice"),
    item("eval", { delegable: false, lockReason: "code" }),
    item("kick", { groups: 2 }),
    item("vv", { everywhere: { mode: "extra", count: 2 }, groups: 1 }),
  ],
  orphans: [],
  limits: { peopleMax: 100 },
  ...over,
});

/** PERM-2 of `vv`: the "everywhere" rule and two groups with their own */
const vvDetail = (over = {}) => ({
  command: "vv",
  delegable: true,
  lockReason: null,
  access: { owner: false, admin: false, group: false, pm: false },
  everywhere: VV_RULE(),
  groups: [
    { jid: G1, name: "Chess club", mode: "only", count: 3, warnings: [] },
    { jid: G2, name: null, mode: "extra", count: 0, warnings: [{ code: "normal_here", tone: "warn", params: {} }] },
  ],
  ...over,
});

const diceDetail = () => ({ command: "dice", delegable: true, lockReason: null, access: { owner: false, admin: false, group: false, pm: false }, everywhere: null, groups: [] });
const kickDetail = () => ({ command: "kick", delegable: true, lockReason: null, access: { owner: false, admin: true, group: true, pm: false }, everywhere: null, groups: [] });

const chats = (items) => ({ items, page: 1, pageSize: 50, total: items.length });

describe("the Commands page with permissions", () => {
  let dom;
  let ui;
  let i18n;
  let htmlTag;
  let view;
  let requests;
  let routes;
  let unexpected;
  let polyfilledFocus = false;

  const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const failure = (status = 500, code = "internal_error") => answer(status, { error: { code } });
  const t = (key, params) => i18n.t(key, params);
  const count = (key) => requests.filter((r) => r.key === key).length;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  before(async () => {
    // the Scopes editor of 002 focuses its heading on mount and the fake elements have no focus(): give them a no-op
    if (!FakeElement.prototype.focus) {
      FakeElement.prototype.focus = function focus() {};
      polyfilledFocus = true;
    }
    dom = await createDom();
    i18n = await importPublic("js/i18n.mjs");
    for (const lang of ["en", "fr"]) {
      const catalog = { ...readJson(path.join(CATALOG_DIR, `${lang}.json`)) };
      if (fs.existsSync(FRAGMENT)) Object.assign(catalog, readJson(FRAGMENT)[lang] || {});
      i18n.setCatalog(lang, catalog);
    }
    await i18n.setLanguage("en", { remember: false });
    ui = await importPublic("js/ui.mjs");
    htmlTag = (await importPublic("js/components/html.mjs")).html;
    view = await importPublic("js/views/commands.mjs");
  });

  after(() => {
    dom.restore();
    delete globalThis.fetch;
    if (polyfilledFocus) delete FakeElement.prototype.focus;
  });

  beforeEach(() => {
    ui.confirmStore.set({ request: null });
    ui.toastStore.set({ items: [] });
  });

  /** The routes every test starts from; a test overrides the ones it scripts */
  const defaults = () => ({
    "GET /admin/api/commands": () => answer(200, cmd1()),
    "GET /admin/api/permissions": () => answer(200, perm1()),
    "GET /admin/api/commands/vv/permissions": () => answer(200, vvDetail()),
    "GET /admin/api/commands/dice/permissions": () => answer(200, diceDetail()),
    "GET /admin/api/commands/kick/permissions": () => answer(200, kickDetail()),
    "GET /admin/api/chats": () => answer(200, chats([{ jid: C, name: "Marie" }, { jid: E, name: null }])),
  });

  async function open(script = {}, query = {}) {
    requests = [];
    unexpected = [];
    routes = { ...defaults(), ...script };
    globalThis.fetch = async (url, init) => {
      const [route, search] = url.split("?");
      const key = `${init.method} ${route}`;
      requests.push({ key, search: search || "", body: init.body ? JSON.parse(init.body) : undefined });
      if (!routes[key]) {
        unexpected.push(key);
        throw new Error(`unexpected request ${key}`);
      }
      return routes[key](init.body ? JSON.parse(init.body) : undefined, search || "");
    };
    const root = dom.mount(htmlTag`<${view.default} route=${{ rest: [], query }} />`);
    await dom.settle(12);
    return root;
  }

  const rerender = async (root, query) => {
    dom.preact.render(htmlTag`<${view.default} route=${{ rest: [], query }} />`, root);
    await dom.settle(12);
  };
  const finish = (root) => {
    dom.unmount(root);
    assert.deepEqual(unexpected, [], "no request outside the script");
  };

  const rowOf = (root, name) => dom.find(root, (el) => el.localName === "tr" && el.childNodes[0] && dom.text(el.childNodes[0]).split(" ")[0] === name)[0];
  const cellOf = (root, name, label) => dom.byAttr(rowOf(root, name), "data-label", label, "td")[0];
  const permissionsButton = (root, name) => dom.byText(rowOf(root, name), "Permissions", "button")[0];
  const scopesButton = (root, name) => dom.byText(rowOf(root, name), "Scopes", "button")[0];
  const button = (root, text) => dom.byText(root, text, "button")[0];
  const chips = (root) => dom.find(root, (el) => el.localName === "li" && el.prop("class") === "chip");
  const chipTexts = (root) => chips(root).map((chip) => dom.text(chip));
  const hasClass = (el, name) => (el.prop("class") || "").split(/\s+/).includes(name);
  const card = (root, title) => dom.find(root, (el) => el.localName === "section" && hasClass(el, "card") && dom.text(el).includes(title))[0];
  const editorCard = (root) => dom.find(root, (el) => el.localName === "section" && hasClass(el, "card") && dom.text(el).includes("Rule for "))[0];
  const field = (root, name) => dom.byAttr(root, "name", name, "input")[0];
  const formOf = (el) => {
    let node = el;
    while (node && node.localName !== "form") node = node.parentNode;
    return node;
  };
  /** Type, let the field re-render (the submit handler reads the state of that render), then submit the form */
  const submitNumber = async (root, text) => {
    const input = field(root, "permissions-number");
    dom.type(input, text);
    await dom.settle(2);
    dom.fire(formOf(input), "submit");
    await dom.settle();
  };
  const toasts = () => ui.toastStore.get().items.map((entry) => entry.message);

  // -------------------------------------------------------------------------
  // Case 8: the column
  // -------------------------------------------------------------------------

  describe("the Permissions column (case 8)", () => {
    test("it sits between State and Actions and summarises the rule, the groups, a lock and a missing item", async () => {
      const root = await open();
      const heads = dom.find(root, (el) => el.localName === "th").map((th) => dom.text(th));
      const at = heads.indexOf(t("commands.col_permissions"));
      assert.ok(at > 0, heads.join("|"));
      assert.equal(heads[at - 1], t("commands.col_state"));
      assert.equal(heads[at + 1], t("commands.col_actions"));

      const cell = (name) => dom.text(cellOf(root, name, "Permissions"));
      assert.ok(cell("vv").includes("Everywhere: Normal + these people (2 people)"), cell("vv"));
      assert.ok(cell("vv").includes("1 group with a rule"), "the singular form");
      assert.ok(cell("kick").includes("No rule everywhere") && cell("kick").includes("2 groups with a rule"), cell("kick"));
      assert.ok(cell("dice").includes("No rule everywhere") && !cell("dice").includes("with a rule"), cell("dice"));
      assert.ok(cell("eval").includes("Cannot be delegated") && cell("eval").includes("Cannot be delegated: it runs code on the bot's machine."), cell("eval"));
      assert.ok(cell("ban").includes("Cannot be delegated: it is reserved to the owner."), "no declared code reads as the fallback reason");
      assert.equal(cell("ghost"), "Not available", "a command PERM-1 does not know");
      finish(root);
    });

    test("an 'only' rule and an empty list read in the cell too", async () => {
      const root = await open({
        "GET /admin/api/permissions": () => answer(200, perm1({ items: [item("vv", { everywhere: { mode: "only", count: 0 } }), item("dice"), item("kick"), item("eval", { delegable: false, lockReason: "code" }), item("ban", { delegable: false })] })),
      });
      assert.ok(dom.text(cellOf(root, "vv", "Permissions")).includes("Everywhere: These people only (0 people)"));
      finish(root);
    });

    test("the row button: aria-pressed, disabled for a locked command and for a command without an item; a locked name is muted", async () => {
      const root = await open();
      for (const name of ["vv", "kick", "dice"]) {
        const b = permissionsButton(root, name);
        assert.equal(b.prop("disabled"), false, name);
        assert.equal(b.getAttribute("aria-pressed"), "false", name);
      }
      for (const name of ["eval", "ban", "ghost"]) assert.equal(permissionsButton(root, name).prop("disabled"), true, name);

      const nameSpan = (name) => dom.find(rowOf(root, name), (el) => el.localName === "span" && (el.prop("class") || "").includes("mono"))[0];
      assert.ok((nameSpan("eval").prop("class") || "").split(" ").includes("muted"), "the locked name is muted");
      assert.ok((nameSpan("ban").prop("class") || "").split(" ").includes("muted"));
      assert.ok(!(nameSpan("vv").prop("class") || "").split(" ").includes("muted"));
      assert.ok(!(nameSpan("ghost").prop("class") || "").split(" ").includes("muted"), "unavailable is not locked");
      finish(root);
    });

    test("the reason is in the cell as text, never only in a tooltip", async () => {
      const root = await open();
      const td = cellOf(root, "eval", "Permissions");
      assert.ok(dom.text(td).includes("it runs code on the bot's machine"));
      assert.equal(dom.find(td, (el) => el.prop("title")).length, 0, "no title attribute carries the reason");
      finish(root);
    });

    test("while PERM-1 is still loading no 'not available' flashes in the cells", async () => {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const root = await open({ "GET /admin/api/permissions": async () => (await gate, answer(200, perm1())) });
      assert.ok(!dom.text(root).includes("Not available"), "still loading");
      release();
      await dom.settle(12);
      assert.ok(dom.text(cellOf(root, "vv", "Permissions")).includes("Everywhere"));
      finish(root);
    });

    test("a PERM-1 failure shows the notice and leaves the page working", async () => {
      const root = await open({ "GET /admin/api/permissions": () => failure(500), "PATCH /admin/api/commands/dice/state": () => answer(200, { disabledGlobal: true, disabledGroups: [], warnings: [] }) });
      const text = dom.text(root);
      assert.ok(text.includes("The permission rules could not be loaded (") && text.includes("The rest of this page still works."), text.slice(0, 400));
      const notice = dom.byText(root, "The permission rules could not be loaded", "p")[0];
      assert.ok(notice, "a paragraph");
      assert.equal(notice.getAttribute("role"), "status");
      assert.ok(text.includes("desc of vv") && text.includes("desc of dice"), "the table is there");
      for (const name of ["vv", "kick", "dice", "eval", "ban", "ghost"]) {
        assert.equal(dom.text(cellOf(root, name, "Permissions")), "Not available", name);
        assert.equal(permissionsButton(root, name).prop("disabled"), true, name);
      }
      // the Scopes editor and the global switch still work
      dom.click(scopesButton(root, "dice"));
      await dom.settle();
      assert.ok(dom.text(root).includes(t("commands.editor_title", { name: "dice" })));
      const toggle = dom.byAttr(rowOf(root, "dice"), "role", "switch", "input")[0];
      dom.check(toggle, false);
      await dom.settle(12);
      assert.equal(count("PATCH /admin/api/commands/dice/state"), 1);
      finish(root);
    });

    test("a CMD-1 failure keeps its own error state (CMD-1 behaviour unchanged)", async () => {
      const root = await open({ "GET /admin/api/commands": () => failure(500) });
      assert.ok(dom.text(root).includes("This page could not be displayed"));
      assert.equal(dom.byText(root, "Try again", "button").length, 1);
      finish(root);
    });
  });

  // -------------------------------------------------------------------------
  // Case 9: the "everywhere" card
  // -------------------------------------------------------------------------

  describe("the 'everywhere' card (case 9)", () => {
    test("opening it reads PERM-2 and shows the saved rule; the button is pressed and the Scopes editor stays closed", async () => {
      const root = await open();
      assert.equal(count("GET /admin/api/commands/vv/permissions"), 0, "nothing is read before the click");
      dom.click(permissionsButton(root, "vv"));
      await dom.settle(12);
      assert.equal(count("GET /admin/api/commands/vv/permissions"), 1);
      const text = dom.text(editorCard(root));
      assert.ok(text.includes("Rule for vv") && text.includes(t("permissions.cmd_intro")), text.slice(0, 300));
      assert.deepEqual(chipTexts(editorCard(root)), ["+237690000001 Alice", "+237690000002"]);
      assert.equal(permissionsButton(root, "vv").getAttribute("aria-pressed"), "true");
      assert.equal(scopesButton(root, "vv").getAttribute("aria-pressed"), "false");
      assert.ok(!dom.text(root).includes(t("commands.editor_title", { name: "vv" })), "no Scopes editor");

      // the same button closes it
      dom.click(permissionsButton(root, "vv"));
      await dom.settle();
      assert.equal(editorCard(root), undefined);
      finish(root);
    });

    test("the card is keyed by the command: another command starts a fresh card", async () => {
      const root = await open();
      dom.click(permissionsButton(root, "vv"));
      await dom.settle(12);
      assert.equal(chips(editorCard(root)).length, 2);
      dom.click(permissionsButton(root, "dice"));
      await dom.settle(12);
      assert.ok(dom.text(editorCard(root)).includes("Rule for dice"));
      assert.equal(chips(editorCard(root)).length, 0);
      assert.equal(permissionsButton(root, "vv").getAttribute("aria-pressed"), "false");
      assert.equal(permissionsButton(root, "dice").getAttribute("aria-pressed"), "true");
      finish(root);
    });

    test("a contact from CHAT-1 (private, 50 a page, never 'selectable'), a typed number, the refusals, Save", async () => {
      const state = { detail: vvDetail() };
      const root = await open({
        "GET /admin/api/commands/vv/permissions": () => answer(200, state.detail),
        "PUT /admin/api/commands/vv/permissions/everywhere": (body) => {
          state.detail = { ...state.detail, everywhere: VV_RULE(body.people, { updatedAt: "2026-10-30T11:00:00.000Z" }) };
          return answer(200, { rule: state.detail.everywhere, changed: true });
        },
      });
      dom.click(permissionsButton(root, "vv"));
      await dom.settle(12);

      // CHAT-1 query
      const chatRequests = requests.filter((r) => r.key === "GET /admin/api/chats");
      assert.equal(chatRequests.length, 1);
      assert.deepEqual(Object.fromEntries(new URLSearchParams(chatRequests[0].search)), { kind: "private", pageSize: "50" });
      assert.ok(!chatRequests[0].search.includes("selectable"));

      const editor = () => editorCard(root);
      assert.equal(button(editor(), "Save").prop("disabled"), true, "nothing changed yet");

      // tick a contact
      dom.check(dom.byAttr(editor(), "aria-label", "Allow +237690000003", "input")[0], true);
      await dom.settle();
      assert.deepEqual(chipTexts(editor()), ["+237690000001 Alice", "+237690000002", "+237690000003 Marie"]);
      assert.ok(dom.text(editor()).includes("Unsaved changes: 1"));
      assert.equal(button(editor(), "Save").prop("disabled"), false);

      // a typed number becomes a chip and the field is cleared
      await submitNumber(editor(), "+237 690 000 004");
      assert.deepEqual(chipTexts(editor()).slice(-1), ["+237690000004"]);
      assert.equal(chips(editor()).length, 4);
      assert.equal(field(editor(), "permissions-number").value, "");

      // an invalid and a too short number add nothing and say why
      await submitNumber(editor(), "12345");
      assert.equal(chips(editor()).length, 4);
      assert.ok(dom.text(editor()).includes("Invalid number (digits with the country code, 8 to 15 digits)."));
      await submitNumber(editor(), "abc");
      assert.equal(chips(editor()).length, 4);
      assert.ok(dom.text(editor()).includes("Invalid number"));

      // a duplicate, spelled another way
      await submitNumber(editor(), "00 237 690 000 001");
      assert.equal(chips(editor()).length, 4);
      assert.ok(dom.text(editor()).includes("This value already exists."), "fields.duplicate");

      // Save sends the mode and the sorted jids, nothing else
      const reads = { perm1: count("GET /admin/api/permissions"), detail: count("GET /admin/api/commands/vv/permissions") };
      dom.click(button(editor(), "Save"));
      await dom.settle(14);
      const puts = requests.filter((r) => r.key === "PUT /admin/api/commands/vv/permissions/everywhere");
      assert.equal(puts.length, 1);
      assert.deepEqual(puts[0].body, { mode: "extra", people: [A, B, C, D] });
      assert.ok(toasts().includes("Rule saved for vv."), toasts().join("|"));
      assert.equal(count("GET /admin/api/permissions"), reads.perm1 + 1, "PERM-1 is read again for the column");
      assert.equal(count("GET /admin/api/commands/vv/permissions"), reads.detail + 1, "and the card's own data");
      // the editor starts afresh on the saved rule and stays open
      assert.equal(chips(editor()).length, 4);
      assert.ok(!dom.text(editor()).includes("Unsaved changes"), dom.text(editor()));
      assert.equal(button(editor(), "Save").prop("disabled"), true);
      finish(root);
    });

    test("the column follows a save: PERM-1 answers the new counts", async () => {
      const state = { perm: perm1(), detail: vvDetail() };
      const root = await open({
        "GET /admin/api/permissions": () => answer(200, state.perm),
        "GET /admin/api/commands/vv/permissions": () => answer(200, state.detail),
        "PUT /admin/api/commands/vv/permissions/everywhere": (body) => {
          state.detail = { ...state.detail, everywhere: VV_RULE(body.people) };
          state.perm = perm1({ items: perm1().items.map((entry) => (entry.name === "vv" ? { ...entry, everywhere: { mode: "extra", count: body.people.length } } : entry)) });
          return answer(200, { rule: state.detail.everywhere, changed: true });
        },
      });
      dom.click(permissionsButton(root, "vv"));
      await dom.settle(12);
      dom.check(dom.byAttr(editorCard(root), "aria-label", "Allow +237690000003", "input")[0], true);
      await dom.settle();
      dom.click(button(editorCard(root), "Save"));
      await dom.settle(14);
      assert.ok(dom.text(cellOf(root, "vv", "Permissions")).includes("(3 people)"), dom.text(cellOf(root, "vv", "Permissions")));
      finish(root);
    });

    test("the mode and the removal of a person are saved as a whole", async () => {
      const root = await open({
        "PUT /admin/api/commands/vv/permissions/everywhere": (body) => answer(200, { rule: VV_RULE(body.people, { mode: body.mode }), changed: true }),
      });
      dom.click(permissionsButton(root, "vv"));
      await dom.settle(12);
      const editor = () => editorCard(root);
      dom.click(dom.byAttr(editor(), "aria-label", "Remove +237690000002", "button")[0]);
      dom.check(dom.byAttr(editor(), "value", "only", "input")[0], true);
      await dom.settle();
      assert.ok(dom.text(editor()).includes("Unsaved changes: 2"));
      dom.click(button(editor(), "Save"));
      await dom.settle(14);
      assert.deepEqual(requests.find((r) => r.key.startsWith("PUT")).body, { mode: "only", people: [A] });
      finish(root);
    });

    test("an 'extra' rule with nobody cannot be saved everywhere: the button stays off and the editor says why", async () => {
      const root = await open();
      dom.click(permissionsButton(root, "dice"));
      await dom.settle(12);
      assert.equal(button(editorCard(root), "Save").prop("disabled"), true);
      assert.ok(dom.text(editorCard(root)).includes(t("permissions.save_blocked")));
      finish(root);
    });

    test("the cap comes from PERM-1 limits: the box of a full list is off and a typed number is refused", async () => {
      const root = await open({ "GET /admin/api/permissions": () => answer(200, perm1({ limits: { peopleMax: 3 } })) });
      dom.click(permissionsButton(root, "vv"));
      await dom.settle(12);
      const editor = () => editorCard(root);
      dom.check(dom.byAttr(editor(), "aria-label", "Allow +237690000003", "input")[0], true);
      await dom.settle();
      assert.equal(chips(editor()).length, 3);
      assert.equal(dom.byAttr(editor(), "aria-label", "Allow +237690000005", "input")[0].prop("disabled"), true, "a full list cannot take another box");
      await submitNumber(editor(), "237690000004");
      assert.equal(chips(editor()).length, 3);
      assert.ok(dom.text(editor()).includes("Too many items (at most 3)."), dom.text(editor()));
      finish(root);
    });

    test("Delete asks first: refusing sends nothing; accepting sends DELETE .../everywhere and reads PERM-1 again", async () => {
      const state = { detail: vvDetail() };
      const root = await open({
        "GET /admin/api/commands/vv/permissions": () => answer(200, state.detail),
        "DELETE /admin/api/commands/vv/permissions/everywhere": () => {
          state.detail = { ...state.detail, everywhere: null };
          return answer(200, { deleted: true });
        },
      });
      dom.click(permissionsButton(root, "vv"));
      await dom.settle(12);

      dom.click(button(editorCard(root), "Delete the rule"));
      await dom.settle();
      const request = ui.confirmStore.get().request;
      assert.equal(request.title, "Delete the rule for vv?");
      assert.equal(request.message, t("permissions.delete_message_everywhere"));
      assert.equal(request.confirmLabel, "Delete the rule");
      ui.resolveConfirm(false);
      await dom.settle(10);
      assert.equal(count("DELETE /admin/api/commands/vv/permissions/everywhere"), 0, "refused: nothing is sent");
      assert.equal(chips(editorCard(root)).length, 2);

      const reads = { perm1: count("GET /admin/api/permissions"), detail: count("GET /admin/api/commands/vv/permissions") };
      dom.click(button(editorCard(root), "Delete the rule"));
      await dom.settle();
      ui.resolveConfirm(true);
      await dom.settle(14);
      assert.equal(count("DELETE /admin/api/commands/vv/permissions/everywhere"), 1);
      assert.ok(toasts().includes("Rule removed for vv."), toasts().join("|"));
      assert.equal(count("GET /admin/api/permissions"), reads.perm1 + 1);
      assert.equal(count("GET /admin/api/commands/vv/permissions"), reads.detail + 1);
      assert.equal(chips(editorCard(root)).length, 0, "the editor restarts without a rule");
      assert.equal(dom.byText(editorCard(root), "Delete the rule", "button").length, 0, "no rule left to delete");
      finish(root);
    });

    test("a refused save is toasted and the draft is kept", async () => {
      const root = await open({
        "PUT /admin/api/commands/vv/permissions/everywhere": () => answer(422, { error: { code: "validation_failed", fields: { name: { code: "not_allowed" } } } }),
      });
      dom.click(permissionsButton(root, "vv"));
      await dom.settle(12);
      dom.check(dom.byAttr(editorCard(root), "aria-label", "Allow +237690000003", "input")[0], true);
      await dom.settle();
      dom.click(button(editorCard(root), "Save"));
      await dom.settle(12);
      assert.equal(count("PUT /admin/api/commands/vv/permissions/everywhere"), 1);
      assert.ok(ui.toastStore.get().items.some((entry) => entry.kind === "error"));
      assert.equal(chips(editorCard(root)).length, 3, "the draft is still there");
      finish(root);
    });

    test("the card disables its controls while the page runs another action (busy)", async () => {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const root = await open({ "PATCH /admin/api/commands/dice/state": async () => (await gate, answer(200, { disabledGlobal: true, disabledGroups: [], warnings: [] })) });
      dom.click(permissionsButton(root, "vv"));
      await dom.settle(12);
      dom.check(dom.byAttr(editorCard(root), "aria-label", "Allow +237690000003", "input")[0], true);
      await dom.settle();
      dom.check(dom.byAttr(rowOf(root, "dice"), "role", "switch", "input")[0], false);
      await dom.settle(4);
      assert.equal(button(editorCard(root), "Save").prop("disabled"), true, "busy");
      release();
      await dom.settle(12);
      assert.equal(button(editorCard(root), "Save").prop("disabled"), false);
      finish(root);
    });

    test("a PERM-2 failure shows an error state with Retry inside the card; the table is unaffected", async () => {
      let fail = true;
      const root = await open({ "GET /admin/api/commands/vv/permissions": () => (fail ? failure(500) : answer(200, vvDetail())) });
      dom.click(permissionsButton(root, "vv"));
      await dom.settle(12);
      assert.ok(dom.text(root).includes("This page could not be displayed"));
      assert.ok(dom.text(cellOf(root, "vv", "Permissions")).includes("Everywhere"), "the column is unaffected");
      fail = false;
      dom.click(button(root, "Try again"));
      await dom.settle(12);
      assert.deepEqual(chipTexts(editorCard(root)), ["+237690000001 Alice", "+237690000002"]);
      finish(root);
    });

    test("an unsaved draft is flagged to the router guard", async () => {
      const root = await open();
      dom.click(permissionsButton(root, "vv"));
      await dom.settle(12);
      assert.equal(ui.hasUnsaved(), false);
      dom.check(dom.byAttr(editorCard(root), "aria-label", "Allow +237690000003", "input")[0], true);
      await dom.settle();
      assert.equal(ui.hasUnsaved(), true);
      dom.click(button(editorCard(root), "Cancel"));
      await dom.settle();
      assert.equal(editorCard(root), undefined, "Cancel closes the card");
      assert.equal(ui.hasUnsaved(), false);
      finish(root);
    });
  });

  // -------------------------------------------------------------------------
  // Case 10: the groups list
  // -------------------------------------------------------------------------

  describe("the groups with their own rule (case 10)", () => {
    test("a read-only list that links to the group tab", async () => {
      const root = await open();
      dom.click(permissionsButton(root, "vv"));
      await dom.settle(12);
      const groups = card(root, "Groups with their own rule");
      assert.ok(groups, dom.text(root).slice(0, 300));
      const text = dom.text(groups);
      assert.ok(text.includes("Groups with their own rule (2)"), text);
      assert.ok(text.includes("Chess club") && text.includes("These people only") && text.includes("3 people"), text);
      assert.ok(text.includes("120363222222222222") && text.includes("Normal + these people") && text.includes("0 people"), "a group without a name shows its short jid");
      assert.ok(text.includes("No effect"), "the server's warning as a short badge");

      const links = dom.find(groups, (el) => el.localName === "a");
      assert.equal(links.length, 2);
      assert.equal(links[0].getAttribute("href"), `#/groups/${enc(G1)}?tab=permissions`);
      assert.equal(links[1].getAttribute("href"), `#/groups/${enc(G2)}?tab=permissions`);
      assert.equal(links[0].getAttribute("aria-label"), "Open the permissions of Chess club");
      assert.ok(dom.text(links[0]).includes("Open"));
      assert.ok((links[0].prop("class") || "").includes("btn"));
      assert.equal(dom.find(groups, (el) => el.localName === "button").length, 0, "no edit, no delete: group rules are edited from the group tab");
      finish(root);
    });

    test("no group has a rule: the empty sentence", async () => {
      const root = await open();
      dom.click(permissionsButton(root, "dice"));
      await dom.settle(12);
      assert.ok(dom.text(root).includes("No group has its own rule for this command."));
      finish(root);
    });
  });

  // -------------------------------------------------------------------------
  // Case 11: deep links, one editor at a time
  // -------------------------------------------------------------------------

  describe("deep links (case 11)", () => {
    test("?command=vv&panel=permissions opens the card once the data is loaded", async () => {
      const root = await open({}, { command: "vv", panel: "permissions" });
      assert.ok(dom.text(editorCard(root)).includes("Rule for vv"));
      assert.equal(count("GET /admin/api/commands/vv/permissions"), 1);
      assert.equal(permissionsButton(root, "vv").getAttribute("aria-pressed"), "true");
      finish(root);
    });

    test("an alias opens the card of its command", async () => {
      const root = await open({}, { command: "vo", panel: "permissions" });
      assert.ok(dom.text(editorCard(root)).includes("Rule for vv"));
      finish(root);
    });

    test("an unknown command, a locked one, a command without an item, another panel or no panel open nothing", async () => {
      for (const query of [{ command: "nope", panel: "permissions" }, { command: "eval", panel: "permissions" }, { command: "ghost", panel: "permissions" }, { command: "vv", panel: "scopes" }, { command: "vv" }, { panel: "permissions" }]) {
        const root = await open({}, query);
        assert.equal(editorCard(root), undefined, JSON.stringify(query));
        assert.ok(!dom.text(root).includes(t("commands.editor_title", { name: "vv" })), JSON.stringify(query));
        assert.equal(requests.filter((r) => r.key.endsWith("/permissions") && r.key.startsWith("GET /admin/api/commands/")).length, 0, "no PERM-2 request");
        finish(root);
      }
    });

    test("when PERM-1 failed the link waits: a refresh that succeeds applies it", async () => {
      let fail = true;
      const root = await open({ "GET /admin/api/permissions": () => (fail ? failure(500) : answer(200, perm1())) }, { command: "vv", panel: "permissions" });
      assert.equal(editorCard(root), undefined);
      fail = false;
      dom.click(button(root, "Refresh"));
      await dom.settle(14);
      assert.ok(dom.text(editorCard(root)).includes("Rule for vv"));
      finish(root);
    });

    test("the link is applied once per distinct query: closing the card and reloading does not reopen it; a new link does", async () => {
      const root = await open({}, { command: "vv", panel: "permissions" });
      assert.ok(editorCard(root));
      dom.click(button(editorCard(root), "Cancel"));
      await dom.settle();
      assert.equal(editorCard(root), undefined);
      dom.click(button(root, "Refresh"));
      await dom.settle(14);
      assert.equal(editorCard(root), undefined, "a reload does not reopen the card");

      await rerender(root, { command: "dice", panel: "permissions" });
      assert.ok(dom.text(editorCard(root)).includes("Rule for dice"), "a different link opens its card");
      finish(root);
    });

    test("a reload (Refresh, a save) never closes an open card", async () => {
      const root = await open({}, { command: "vv", panel: "permissions" });
      dom.click(button(root, "Refresh"));
      await dom.settle(14);
      assert.ok(editorCard(root), "still open after a refresh");
      assert.ok(dom.text(editorCard(root)).includes("Rule for vv"));
      finish(root);
    });

    test("the Scopes editor and the Permissions card are never open together", async () => {
      const root = await open();
      dom.click(permissionsButton(root, "vv"));
      await dom.settle(12);
      assert.ok(editorCard(root));
      dom.click(scopesButton(root, "dice"));
      await dom.settle(12);
      assert.equal(editorCard(root), undefined, "the permissions card is gone");
      assert.ok(dom.text(root).includes(t("commands.editor_title", { name: "dice" })));
      assert.equal(scopesButton(root, "dice").getAttribute("aria-pressed"), "true");
      assert.equal(permissionsButton(root, "vv").getAttribute("aria-pressed"), "false");

      dom.click(permissionsButton(root, "kick"));
      await dom.settle(12);
      assert.ok(!dom.text(root).includes(t("commands.editor_title", { name: "dice" })), "the scopes editor is gone");
      assert.equal(scopesButton(root, "dice").getAttribute("aria-pressed"), "false");
      finish(root);
    });

    test("the Scopes button still opens and closes the scope editor as before", async () => {
      const root = await open();
      dom.click(scopesButton(root, "vv"));
      await dom.settle();
      assert.ok(dom.text(root).includes(t("commands.editor_title", { name: "vv" })));
      dom.click(scopesButton(root, "vv"));
      await dom.settle();
      assert.ok(!dom.text(root).includes(t("commands.editor_title", { name: "vv" })));
      assert.equal(count("GET /admin/api/commands/vv/permissions"), 0);
      finish(root);
    });
  });

  // -------------------------------------------------------------------------
  // Case 12: permission orphans
  // -------------------------------------------------------------------------

  describe("permission orphans (case 12)", () => {
    const orphans = [
      { command: "oldcmd", scope: G1, mode: "extra", count: 1, reason: "unknown_command" },
      { command: "oldcmd", scope: "*", mode: "only", count: 2, reason: "unknown_command" },
      { command: "bye", scope: G2, mode: "only", count: 0, reason: "not_delegable" },
    ];

    test("no orphan, no card", async () => {
      const root = await open();
      assert.ok(!dom.text(root).includes("Rules without a usable command"));
      finish(root);
    });

    test("the card lists each command with its reason and one chip per scope, 'everywhere' first", async () => {
      const root = await open({ "GET /admin/api/permissions": () => answer(200, perm1({ orphans })) });
      const orphanCard = card(root, "Rules without a usable command");
      assert.ok(orphanCard);
      const text = dom.text(orphanCard);
      assert.ok(text.includes("oldcmd") && text.includes("Command no longer loaded"), text);
      assert.ok(text.includes("bye") && text.includes("Command that can no longer be delegated"), text);
      assert.ok(text.indexOf("bye") < text.indexOf("oldcmd"), "sorted by command");
      const oldChips = dom.find(orphanCard, (el) => el.localName === "li" && el.prop("class") === "chip" && dom.text(el).length > 0).map((chip) => dom.text(chip));
      assert.deepEqual(oldChips, ["120363222222222222", "everywhere", "120363111111111111"], "bye first, then oldcmd with 'everywhere' before the group");
      assert.ok(dom.byAttr(orphanCard, "aria-label", "Delete the rule for oldcmd (everywhere)", "button").length === 1);
      finish(root);
    });

    test("it sits below the command-state orphans", async () => {
      const root = await open({
        "GET /admin/api/commands": () => answer(200, cmd1({ orphans: [{ command: "stale", scope: "*" }] })),
        "GET /admin/api/permissions": () => answer(200, perm1({ orphans })),
      });
      const text = dom.text(root);
      assert.ok(text.indexOf("Rows for commands that no longer exist") > -1 && text.indexOf("Rules without a usable command") > -1);
      assert.ok(text.indexOf("Rows for commands that no longer exist") < text.indexOf("Rules without a usable command"));
      finish(root);
    });

    test("a scope '*' row calls PERM-4, with no dialog, then toasts and reads PERM-1 again", async () => {
      let current = orphans;
      const root = await open({
        "GET /admin/api/permissions": () => answer(200, perm1({ orphans: current })),
        "DELETE /admin/api/commands/oldcmd/permissions/everywhere": () => {
          current = current.filter((o) => !(o.command === "oldcmd" && o.scope === "*"));
          return answer(200, { deleted: true });
        },
      });
      const reads = count("GET /admin/api/permissions");
      dom.click(dom.byAttr(root, "aria-label", "Delete the rule for oldcmd (everywhere)", "button")[0]);
      await dom.settle(14);
      assert.equal(ui.confirmStore.get().request, null, "no dialog");
      assert.equal(count("DELETE /admin/api/commands/oldcmd/permissions/everywhere"), 1);
      assert.ok(toasts().includes("Rule for oldcmd deleted."), toasts().join("|"));
      assert.equal(count("GET /admin/api/permissions"), reads + 1);
      assert.equal(dom.byAttr(root, "aria-label", "Delete the rule for oldcmd (everywhere)", "button").length, 0, "the chip is gone");
      assert.equal(dom.byAttr(root, "aria-label", `Delete the rule for oldcmd (${G1.replace("@g.us", "")})`, "button").length, 1, "the group row remains");
      finish(root);
    });

    test("a group row calls PERM-7 with the encoded jid and the command, with no dialog", async () => {
      const key = `DELETE /admin/api/groups/${enc(G1)}/permissions/oldcmd`;
      const root = await open({
        "GET /admin/api/permissions": () => answer(200, perm1({ orphans })),
        [key]: () => answer(200, { deleted: true }),
      });
      dom.click(dom.byAttr(root, "aria-label", `Delete the rule for oldcmd (${G1.replace("@g.us", "")})`, "button")[0]);
      await dom.settle(14);
      assert.equal(ui.confirmStore.get().request, null, "no dialog");
      assert.equal(count(key), 1);
      assert.equal(requests.filter((r) => r.key.startsWith("DELETE")).length, 1, "only that one");
      assert.ok(toasts().includes("Rule for oldcmd deleted."));
      finish(root);
    });

    test("an orphan on a command that exists but cannot be delegated is removed the same way", async () => {
      const key = `DELETE /admin/api/groups/${enc(G2)}/permissions/bye`;
      const root = await open({
        "GET /admin/api/permissions": () => answer(200, perm1({ orphans })),
        [key]: () => answer(200, { deleted: true }),
      });
      dom.click(dom.byAttr(root, "aria-label", `Delete the rule for bye (${G2.replace("@g.us", "")})`, "button")[0]);
      await dom.settle(14);
      assert.equal(count(key), 1);
      finish(root);
    });

    test("a failed removal is toasted and the card stays", async () => {
      const root = await open({
        "GET /admin/api/permissions": () => answer(200, perm1({ orphans })),
        "DELETE /admin/api/commands/oldcmd/permissions/everywhere": () => failure(500),
      });
      dom.click(dom.byAttr(root, "aria-label", "Delete the rule for oldcmd (everywhere)", "button")[0]);
      await dom.settle(14);
      assert.ok(ui.toastStore.get().items.some((entry) => entry.kind === "error"));
      assert.ok(card(root, "Rules without a usable command"));
      finish(root);
    });
  });

  // -------------------------------------------------------------------------
  // The audit page (T052): a permission rule's detail reads as "mode: +N, -M" with the ids
  // -------------------------------------------------------------------------

  describe("the audit page shows what a rule change did", () => {
    const row = (id, action, target, detail) => ({ id, at: "2026-10-30T10:00:00.000Z", action, target, origin: "127.0.0.1", result: "ok", detail });
    const ROWS = [
      row(1, "command.permission.set", "vv:*", { mode: "extra", previousMode: "only", added: ["237690000001", "237690000002@lid"], removed: ["237690000003"] }),
      row(2, "command.permission.delete", `vv:${G1}`, { mode: "only", previousMode: "only", added: [], removed: ["237690000001"] }),
      row(3, "command.permission.set", "kick:*", { mode: "extra", previousMode: null, addedCount: 25, removedCount: 60 }),
      row(4, "command.permission.set", "dice:*", { truncated: true, length: 2400, keys: ["mode", "previousMode", "added", "removed"] }),
      row(5, "command.permission.set", "vv:*", { mode: "weird", previousMode: null, added: [], removed: [] }),
      row(6, "command.permission.set", "vv:*", { mode: "extra", previousMode: "extra", added: ["237690000001"], removedCount: 40 }),
    ];

    async function openAudit() {
      requests = [];
      unexpected = [];
      globalThis.fetch = async (url, init) => {
        const [route, search] = url.split("?");
        requests.push({ key: `${init.method} ${route}`, search: search || "" });
        if (init.method === "GET" && route === "/admin/api/audit") return answer(200, { items: ROWS, page: 1, pageSize: 50, total: ROWS.length });
        unexpected.push(`${init.method} ${route}`);
        throw new Error("unexpected request");
      };
      const audit = await importPublic("js/views/audit.mjs");
      const root = dom.mount(htmlTag`<${audit.default} route=${{ rest: [], query: {} }} />`);
      await dom.settle(12);
      return root;
    }
    const detailOf = (root, id) => {
      const tr = dom.find(root, (el) => el.localName === "tr" && dom.text(el).includes(id))[0];
      return dom.byAttr(tr, "data-label", t("audit.col_detail"), "td")[0];
    };

    test("a change of mode with ids: the line, the previous mode and one badge per person, added green and removed red", async () => {
      const root = await openAudit();
      const cell = detailOf(root, "vv:*");
      const text = dom.text(cell);
      assert.ok(text.includes("Normal + these people: +2, -1"), text);
      assert.ok(text.includes("(was These people only)"), text);
      const added = dom.find(cell, (el) => el.localName === "span" && hasClass(el, "badge-ok")).map((el) => dom.text(el));
      const removed = dom.find(cell, (el) => el.localName === "span" && hasClass(el, "badge-danger")).map((el) => dom.text(el));
      assert.deepEqual(added, ["+ +237690000001", "+ @237690000002"]);
      assert.deepEqual(removed, ["- +237690000003"]);
      finish(root);
    });

    test("a deletion: the same mode is not 'was', the removed ids are all listed", async () => {
      const root = await openAudit();
      const cell = detailOf(root, "command.permission.delete");
      const text = dom.text(cell);
      assert.ok(text.includes("These people only: +0, -1"), text);
      assert.ok(!text.includes("was"), text);
      assert.deepEqual(dom.find(cell, (el) => hasClass(el, "badge-danger")).map((el) => dom.text(el)), ["- +237690000001"]);
      assert.equal(dom.find(cell, (el) => hasClass(el, "badge-ok")).length, 0);
      finish(root);
    });

    test("lists replaced by their counts show the numbers and no ids; a creation has no 'was'", async () => {
      const root = await openAudit();
      const cell = detailOf(root, "kick:*");
      assert.equal(dom.text(cell), "Normal + these people: +25, -60");
      assert.equal(dom.find(cell, (el) => hasClass(el, "badge")).length, 0);
      // one list kept, the other replaced by its count
      const rows = dom.find(root, (el) => el.localName === "tr");
      const partial = rows.find((tr) => dom.text(tr).includes("+1, -40"));
      assert.ok(partial, "added list of 1 and removedCount 40");
      const partialCell = dom.byAttr(partial, "data-label", t("audit.col_detail"), "td")[0];
      assert.deepEqual(dom.find(partialCell, (el) => hasClass(el, "badge-ok")).map((el) => dom.text(el)), ["+ +237690000001"]);
      assert.equal(dom.find(partialCell, (el) => hasClass(el, "badge-danger")).length, 0);
      finish(root);
    });

    test("the server's truncation marker and an unknown mode: generic text, the raw mode", async () => {
      const root = await openAudit();
      assert.ok(dom.text(detailOf(root, "dice:*")).includes("truncated"), "still the generic JSON text");
      assert.equal(dom.find(detailOf(root, "dice:*"), (el) => hasClass(el, "badge")).length, 0);
      const weird = dom.find(root, (el) => el.localName === "tr").find((tr) => dom.text(tr).includes("weird"));
      assert.ok(dom.text(weird).includes("weird: +0, -0"), dom.text(weird));
      finish(root);
    });

    test("French reads the same line", async () => {
      await i18n.setLanguage("fr", { remember: false });
      try {
        const root = await openAudit();
        const text = dom.text(dom.find(root, (el) => el.localName === "tr").find((tr) => dom.text(tr).includes("kick:*")));
        assert.ok(text.includes("Normal + ces personnes : +25, -60"), text);
        const first = dom.text(dom.find(root, (el) => el.localName === "tr").find((tr) => dom.text(tr).includes("237690000003")));
        assert.ok(first.includes("était Ces personnes seulement"), first);
        finish(root);
      } finally {
        await i18n.setLanguage("en", { remember: false });
      }
    });
  });

  test("the view modules export their components", async () => {
    const mod = await importPublic("js/views/commands-permissions.mjs");
    assert.equal(typeof mod.CommandPermissions, "function");
    assert.equal(typeof mod.PermissionOrphans, "function");
    assert.equal(typeof view.default, "function");
    assert.deepEqual(view.meta, { area: "commands", titleKey: "commands.title", icon: "commands" });
    await sleep(0);
  });
});
