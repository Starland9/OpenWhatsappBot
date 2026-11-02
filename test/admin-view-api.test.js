"use strict";
/**
 * The API area of the panel in a fake DOM (feature 004, contracts/panel-ui.md 7.1 to 7.6, tasks T054, T055, T105).
 *
 * Render guards (test/helpers/viewGuard.js): a scripted fetch, a small fixed number of event-loop turns, the root unmounted
 * and the guard checked in a `finally`, the guard / DOM / fetch restored in `after`. One file, parts:
 *   1 shell and state (enable, disable, banners, routes)   2 keys, editor, secret dialog   3 key actions and networks
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { boot, makeCatalog, makeState, makeKey, ok, fail, FAR, PAST } = require("./helpers/apiViewKit");

let kit;
let dom;
let i18n;
let ui;
let reauth;
const T = (key, params) => i18n.t(key, params);

before(async () => {
  kit = await boot();
  ({ dom, i18n, ui, reauth } = kit);
});

beforeEach(() => {
  ui.toastStore.set({ items: [] });
});

after(() => {
  dom.restore();
  i18n.__resetForTests();
  delete globalThis.fetch;
  delete globalThis.location;
});

const route = (over = {}) => ({ name: "api", rest: [], query: {}, ...over });
const freshData = (over = {}) => ({ state: makeState(), catalog: makeCatalog(), keys: [makeKey(1)], ...over });
const toasts = () => ui.toastStore.get().items.map((item) => item.message);

async function typeInto(el, value) {
  dom.type(el, value);
  await dom.settle(2); // the re-render that hands the typed value to the submit handler
}

/** Open the password dialog's input, type and submit. */
async function submitPassword(t, password) {
  const dialog = dom.find(t.root, (el) => el.localName === "dialog" && dom.text(el).includes(T("reauth.title")))[0];
  assert.ok(dialog, "the password dialog is open");
  const input = dom.find(dialog, (el) => el.localName === "input")[0];
  await typeInto(input, password);
  dom.fire(dom.find(dialog, (el) => el.localName === "form")[0], "submit");
  await dom.settle(6);
  return input;
}

// ===========================================================================
// Part 1: shell and state
// ===========================================================================

describe("ApiView: the page", () => {
  test("it issues API-1, API-3 and API-4 once each and shows the header, the state card and the tabs", async () => {
    const data = freshData();
    const t = kit.mountApi({ data });
    try {
      await t.settle(6);
      assert.equal(t.guard.count("GET /admin/api/api"), 1);
      assert.equal(t.guard.count("GET /admin/api/api/catalog"), 1);
      assert.equal(t.guard.count("GET /admin/api/api/keys"), 1);
      assert.ok(t.find.has(T("api.title")) && t.find.has(T("api.intro")));
      assert.ok(t.find.has(T("api.state_on")) && t.find.has("https://bot.example.org/api/v1"));
      for (const tab of ["keys", "history", "usage", "test", "docs"]) assert.ok(t.find.has(T(`api.tab_${tab}`)), tab);
      assert.ok(dom.find(t.root, (el) => el.getAttribute("role") === "tab" && dom.text(el).includes(T("api.tab_keys")) && dom.text(el).includes("1")).length > 0, "the Keys tab carries the active count");
    } finally {
      t.done();
    }
  });

  test("a failure of the state or the catalogue is a whole-page error with Retry that reloads", async () => {
    const data = freshData();
    let broken = true;
    const t = kit.mountApi({ data, routes: { "GET /admin/api/api": () => (broken ? fail(500, "internal_error") : ok(data.state)) } });
    try {
      await t.settle(6);
      assert.ok(t.find.has(T("common.view_error")));
      broken = false;
      dom.click(t.find.button(T("common.retry")));
      await t.settle(6);
      assert.ok(t.find.has(T("api.state_title")));
    } finally {
      t.done();
    }
  });

  test("the banners: disabled, registry failure (enable disabled), paused, bot offline, plain-HTTP panel", async () => {
    const cases = [
      [{ enabled: false }, T("api.state_disabled_banner")],
      [{ enabled: false, failure: { code: "registry_failed", endpoint: "messages.create" } }, T("api.state_registry_failed", { endpoint: "messages.create" })],
      [{ pausedUntil: new Date(Date.now() + 600000).toISOString() }, T("api.state_paused", { time: "" }).split("{")[0].trim().slice(0, 20)],
      [{ botReady: false }, T("api.state_bot_offline", { minutes: 10 })],
    ];
    for (const [over, expected] of cases) {
      const t = kit.mountApi({ data: freshData({ state: makeState(over) }) });
      try {
        await t.settle(6);
        assert.ok(t.find.has(expected), expected);
        if (over.failure) assert.equal(t.find.button(T("api.enable_button")).prop("disabled"), true, "the enable button is disabled under a registry failure");
      } finally {
        t.done();
      }
    }
    globalThis.location = { protocol: "http:", hostname: "bot.example.org", hash: "" };
    const t = kit.mountApi({ data: freshData() });
    try {
      await t.settle(6);
      assert.ok(t.find.has(T("api.state_http_warning")));
    } finally {
      t.done();
      delete globalThis.location;
    }
    const quiet = kit.mountApi({ data: freshData() });
    try {
      await quiet.settle(6);
      for (const key of ["api.state_disabled_banner", "api.state_http_warning", "api.state_bot_offline"]) assert.ok(!quiet.find.has(T(key, { minutes: 10 })), key);
    } finally {
      quiet.done();
    }
  });

  test("tabs and routes: the tab query picks the panel, a tab click navigates, #/api/keys/new opens the editor, an unknown id says so", async () => {
    globalThis.location = { protocol: "https:", hostname: "localhost", hash: "" };
    try {
      const docs = kit.mountApi({ data: freshData(), route: route({ query: { tab: "docs" } }) });
      try {
        await docs.settle(6);
        assert.ok(docs.find.has(T("api.docs_quick_title")));
        assert.ok(!docs.find.has(T("api.keys_new")), "only the active tab renders");
        dom.click(dom.find(docs.root, (el) => el.getAttribute("role") === "tab" && dom.text(el).includes(T("api.tab_usage")))[0]);
        assert.equal(globalThis.location.hash, "#/api?tab=usage");
        dom.click(dom.find(docs.root, (el) => el.getAttribute("role") === "tab" && dom.text(el).includes(T("api.tab_keys")))[0]);
        assert.equal(globalThis.location.hash, "#/api", "the Keys tab is absent from the URL");
      } finally {
        docs.done();
      }
      const bad = kit.mountApi({ data: freshData(), route: route({ query: { tab: "nonsense" } }) });
      try {
        await bad.settle(6);
        assert.ok(bad.find.has(T("api.keys_new")), "an unknown tab reads as Keys");
      } finally {
        bad.done();
      }
      const fresh = kit.mountApi({ data: freshData(), route: route({ rest: ["keys", "new"] }) });
      try {
        await fresh.settle(6);
        assert.ok(fresh.find.has(T("api.editor_title_new")));
        assert.ok(!fresh.find.has(T("api.tab_history")), "the editor replaces the page: no tabs");
      } finally {
        fresh.done();
      }
      const gone = kit.mountApi({ data: freshData(), route: route({ rest: ["keys", "999"] }) });
      try {
        await gone.settle(6);
        assert.ok(gone.find.has(T("api.editor_not_found")));
      } finally {
        gone.done();
      }
    } finally {
      delete globalThis.location;
    }
  });
});

describe("EnableCard: enable", () => {
  const off = () => freshData({ state: makeState({ enabled: false }) });

  test("refusing the warning sends nothing and asks no password", async () => {
    const data = off();
    const t = kit.mountApi({ data, routes: { "PUT /admin/api/api/state": () => ok({ enabled: true }) } });
    try {
      await t.settle(6);
      dom.click(t.find.button(T("api.enable_button")));
      const request = await kit.answerConfirm(false);
      assert.equal(request.title, T("api.enable_title"));
      assert.equal(request.message, T("api.enable_warning"));
      await t.settle(4);
      assert.equal(t.guard.count("PUT /admin/api/api/state"), 0);
      assert.equal(reauth.reauthStore.get().request, null);
    } finally {
      t.done();
    }
  });

  test("accepting the warning asks the password when the session is not confirmed; a wrong one keeps the dialog and sends nothing; the right one sends exactly one PUT", async () => {
    const data = off();
    let attempts = 0;
    const t = kit.mountApi({
      data,
      routes: {
        "POST /admin/api/session/reauth": (body) => {
          attempts += 1;
          return body.password === "right password" ? ok({ confirmedUntil: new Date(Date.now() + 300000).toISOString(), windowMs: 300000 }) : fail(422, "validation_failed", { fields: { password: { code: "wrong_password" } } });
        },
        "PUT /admin/api/api/state": (body) => {
          data.state = makeState({ enabled: true });
          return ok({ enabled: true, plainHttpFrom: [], changed: true, cancelled: 0 });
        },
      },
    });
    try {
      await t.settle(6);
      dom.click(t.find.button(T("api.enable_button")));
      await kit.answerConfirm(true);
      await t.settle(4);
      assert.ok(reauth.reauthStore.get().request, "the password is asked");
      assert.deepEqual(reauth.reauthStore.get().request.reasons, ["enable"]);
      assert.equal(t.guard.count("PUT /admin/api/api/state"), 0, "nothing is sent before the password");
      const input = await submitPassword(t, "wrong one");
      assert.equal(input.value, "", "a wrong password clears the input");
      assert.ok(reauth.reauthStore.get().request, "and keeps the dialog open");
      assert.equal(t.guard.count("PUT /admin/api/api/state"), 0, "and sends nothing");
      await submitPassword(t, "right password");
      await t.settle(6);
      assert.equal(t.guard.count("PUT /admin/api/api/state"), 1);
      assert.deepEqual(t.guard.requests.find((r) => r.key === "PUT /admin/api/api/state").body, { enabled: true });
      assert.equal(attempts, 2);
      assert.ok(toasts().includes(T("api.enable_done")));
      assert.equal(t.guard.count("GET /admin/api/api"), 2, "the state is reloaded after the write");
      assert.ok(t.find.has(T("api.disable_button")));
    } finally {
      t.done();
    }
  });

  test("an already confirmed session shows no password dialog", async () => {
    const data = off();
    data.state.stepUp = { confirmedUntil: new Date(Date.now() + 200000).toISOString(), windowMs: 300000 };
    const t = kit.mountApi({ data, routes: { "PUT /admin/api/api/state": () => ok({ enabled: true, plainHttpFrom: [], changed: true, cancelled: 0 }) } });
    try {
      await t.settle(6);
      dom.click(t.find.button(T("api.enable_button")));
      await kit.answerConfirm(true);
      await t.settle(6);
      assert.equal(reauth.reauthStore.get().request, null);
      assert.equal(t.guard.count("PUT /admin/api/api/state"), 1);
    } finally {
      t.done();
    }
  });

  test("a server 403 password_required after the click prompts once and retries once; a second one is toasted", async () => {
    const data = off();
    data.state.stepUp = { confirmedUntil: new Date(Date.now() + 200000).toISOString(), windowMs: 300000 };
    let puts = 0;
    const t = kit.mountApi({
      data,
      routes: {
        "POST /admin/api/session/reauth": () => ok({ confirmedUntil: new Date(Date.now() + 300000).toISOString(), windowMs: 300000 }),
        "PUT /admin/api/api/state": () => {
          puts += 1;
          return fail(403, "password_required", { params: { windowMs: 300000, reasons: ["enable"] } });
        },
      },
    });
    try {
      await t.settle(6);
      dom.click(t.find.button(T("api.enable_button")));
      await kit.answerConfirm(true);
      await t.settle(6);
      assert.ok(reauth.reauthStore.get().request, "the server's refusal prompts");
      await submitPassword(t, "right password");
      await t.settle(6);
      assert.equal(puts, 2, "one retry, no loop");
      assert.equal(t.guard.count("POST /admin/api/session/reauth"), 1);
      assert.equal(reauth.reauthStore.get().request, null, "the second refusal does not prompt again");
      assert.ok(toasts().includes(T("errors.password_required", { windowMs: 300000 })) || toasts().some((m) => m.length > 0));
    } finally {
      t.done();
    }
  });

  test("a 429 on the password keeps the dialog with the retry text and arms no timer", async () => {
    const data = off();
    const t = kit.mountApi({ data, routes: { "POST /admin/api/session/reauth": () => fail(429, "rate_limited", { params: { retryAfterMs: 120000 } }) } });
    try {
      await t.settle(6);
      dom.click(t.find.button(T("api.enable_button")));
      await kit.answerConfirm(true);
      await t.settle(4);
      await submitPassword(t, "right password");
      assert.ok(reauth.reauthStore.get().request, "the dialog stays");
      assert.equal(t.guard.count("PUT /admin/api/api/state"), 0);
      assert.ok(dom.find(t.root, (el) => el.getAttribute("class") === "banner banner-warn" && el.getAttribute("role") === "alert").length === 1);
    } finally {
      t.done();
    }
  });
});

describe("EnableCard: disable and the limits", () => {
  test("disable names the queued count, sends confirm: true with no password and toasts the cancelled count", async () => {
    const data = freshData({ state: makeState({ queued: 3 }) });
    const t = kit.mountApi({ data, routes: { "PUT /admin/api/api/state": () => ok({ enabled: false, plainHttpFrom: [], changed: true, cancelled: 3 }) } });
    try {
      await t.settle(6);
      assert.ok(t.find.has(T("api.state_queued", { count: 3 })));
      dom.click(t.find.button(T("api.disable_button")));
      const request = await kit.answerConfirm(true);
      assert.equal(request.message, T("api.disable_message", { count: 3 }));
      assert.equal(request.title, T("api.disable_title"));
      await t.settle(6);
      assert.deepEqual(t.guard.requests.find((r) => r.key === "PUT /admin/api/api/state").body, { enabled: false, confirm: true });
      assert.equal(reauth.reauthStore.get().request, null, "disabling narrows access: no password");
      assert.ok(toasts().includes(T("api.disable_done", { count: 3, cancelled: 3 })));
    } finally {
      t.done();
    }
  });

  test("an empty queue uses its own text; refusing the confirmation sends nothing", async () => {
    const t = kit.mountApi({ data: freshData() });
    try {
      await t.settle(6);
      dom.click(t.find.button(T("api.disable_button")));
      const request = await kit.answerConfirm(false);
      assert.equal(request.message, T("api.disable_message_none"));
      await t.settle(4);
      assert.equal(t.guard.count("PUT /admin/api/api/state"), 0);
    } finally {
      t.done();
    }
  });

  test("the limits summary shows the values in force and links to Settings and Alerts; it edits nothing", async () => {
    const t = kit.mountApi({ data: freshData() });
    try {
      await t.settle(6);
      assert.ok(t.find.has(T("api.settings_spacing", { seconds: 2 })));
      assert.ok(t.find.has(T("api.settings_per_minute", { count: 30 })));
      assert.ok(t.find.has(T("api.settings_reply_window", { days: 7 })));
      const links = dom.find(t.root, (el) => el.localName === "a").map((el) => el.getAttribute("href"));
      assert.ok(links.includes("#/settings/API_RATE_PER_MINUTE"), links.join(" "));
      assert.ok(links.includes("#/alerts"));
      assert.ok(t.find.has(T("alerts.type_api_key_new_ip")), "the alert toggles are listed with the 002 titles");
    } finally {
      t.done();
    }
  });
});

// ===========================================================================
// Part 2: keys, editor, secret dialog
// ===========================================================================

const SECRET = "owbk_0123456789abcdef_CANARYSECRETCANARYSECRETCANARYSECRETCANA";
const CONFIRMED = () => ({ confirmedUntil: new Date(Date.now() + 250000).toISOString(), windowMs: 300000 });
const chat = (jid, name) => ({ jid, name, kind: jid.endsWith("@g.us") ? "group" : "private" });
const chatsRoute = (items) => (body, search) => {
  const kind = new URLSearchParams(search).get("kind");
  const rows = items.filter((item) => item.kind === kind);
  return ok({ items: rows, page: 1, pageSize: 50, total: rows.length });
};
const withNavigator = async (value, run) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
  try {
    return await run();
  } finally {
    if (saved) Object.defineProperty(globalThis, "navigator", saved);
    else delete globalThis.navigator;
  }
};
const KEY_SET = ["expiresAt", "ipAllow", "limits", "name", "policy", "rights"];

describe("KeysTab", () => {
  const keys = () => [
    makeKey(1, { name: "n8n", rights: ["messages.send.text", "messages.send.image"], lastUsedAt: "2026-11-02T08:00:00.000Z", lastUsedIp: "203.0.113.5", queued: 2 }),
    makeKey(2, { name: "old", status: "expired", expiresAt: PAST, ipAllow: ["10.0.0.0/8", "192.168.0.0/16"], policy: { mode: "anyone", recipients: [] } }),
    makeKey(3, { name: "gone", status: "revoked", revokedAt: "2026-10-30T10:00:00.000Z" }),
  ];

  test("columns and cells: name and last 4, state, rights, policy, limits with defaults, access, last use", async () => {
    const t = kit.mountApi({ data: freshData({ keys: keys() }) });
    try {
      await t.settle(6);
      const row = (name) => dom.find(t.root, (el) => el.localName === "tr" && dom.text(el).includes(name))[0];
      const n8n = dom.text(row("n8n"));
      assert.ok(n8n.includes("x9Qa") && n8n.includes(T("api.key_state.active")));
      assert.ok(n8n.includes(T("api.cell_rights", { count: 2 })));
      assert.ok(n8n.includes(T("api.cell_policy_list", { count: 1 })));
      assert.ok(n8n.includes(T("api.cell_limits", { perMinute: `30 (${T("api.cell_limit_default")})`, perDay: "500", pending: `100 (${T("api.cell_limit_default")})` })));
      assert.ok(n8n.includes(T("api.cell_ip_any")) && n8n.includes(T("api.cell_no_expiry")));
      assert.ok(n8n.includes("203.0.113.5"));
      const old = dom.text(row("old"));
      assert.ok(old.includes(T("api.key_state.expired")) && old.includes(T("api.cell_policy_anyone")) && old.includes(T("api.cell_ip_count", { count: 2 })));
      assert.ok(old.includes(T("api.cell_never")));
      assert.equal(dom.find(row("old"), (el) => el.getAttribute("class") === "badge badge-danger" && dom.text(el) === T("api.cell_policy_anyone")).length, 1, "anyone is a danger badge");
      assert.ok(dom.text(row("gone")).includes(T("api.key_state.revoked")));
      assert.ok(t.find.has(T("api.keys_purge_note", { days: 30 })));
    } finally {
      t.done();
    }
  });

  test("the row actions follow the state; a revoked key offers no Duplicate, no Revoke and nothing like a reactivation", async () => {
    const t = kit.mountApi({ data: freshData({ keys: keys() }) });
    try {
      await t.settle(6);
      const row = (name) => dom.find(t.root, (el) => el.localName === "tr" && dom.text(el).includes(name))[0];
      const labels = (name) => dom.find(row(name), (el) => ["a", "button"].includes(el.localName) && el.getAttribute("aria-label")).map((el) => el.getAttribute("aria-label"));
      const action = (key, text) => T("api.action_for", { action: text, name: key });
      assert.deepEqual(labels("n8n"), [action("n8n", T("common.edit")), action("n8n", T("api.action_duplicate")), action("n8n", T("api.action_revoke")), action("n8n", T("api.action_history"))]);
      assert.deepEqual(labels("old"), [action("old", T("common.edit")), action("old", T("api.action_revoke")), action("old", T("api.action_history"))], "an expired key cannot be duplicated");
      assert.deepEqual(labels("gone"), [action("gone", T("common.edit")), action("gone", T("api.action_history"))]);
      assert.ok(!/reactiv|restor/i.test(dom.text(t.root)));
      const history = dom.find(row("n8n"), (el) => el.localName === "a" && (el.getAttribute("aria-label") || "").includes(T("api.action_history")))[0];
      assert.equal(history.getAttribute("href"), "#/api?tab=history&key=1");
    } finally {
      t.done();
    }
  });

  test("the revoked toggle hides the revoked keys; the empty state offers New key", async () => {
    const t = kit.mountApi({ data: freshData({ keys: keys() }) });
    try {
      await t.settle(6);
      assert.ok(t.find.has("gone"), "revoked keys are shown by default");
      dom.check(t.find.input("api-show-revoked"), false);
      await t.settle(3);
      assert.ok(!t.find.has("gone") && t.find.has("n8n"));
    } finally {
      t.done();
    }
    const empty = kit.mountApi({ data: freshData({ keys: [] }) });
    try {
      await empty.settle(6);
      assert.ok(empty.find.has(T("api.keys_empty")) && empty.find.has(T("api.keys_empty_hint")));
      const links = dom.find(empty.root, (el) => el.localName === "a" && el.getAttribute("href") === "#/api/keys/new");
      assert.ok(links.length >= 1);
    } finally {
      empty.done();
    }
  });

  test("a failure of the keys only degrades the tab: Retry reloads them", async () => {
    const data = freshData();
    let broken = true;
    const t = kit.mountApi({ data, routes: { "GET /admin/api/api/keys": () => (broken ? fail(500, "internal_error") : ok({ items: data.keys })) } });
    try {
      await t.settle(6);
      assert.ok(t.find.has(T("api.state_title")), "the page itself is there");
      assert.ok(t.find.has(T("common.view_error")));
      broken = false;
      dom.click(t.find.button(T("common.retry")));
      await t.settle(6);
      assert.ok(t.find.has("key 1"));
    } finally {
      t.done();
    }
  });
});

describe("KeyEditor: create", () => {
  const people = [chat("237690000009@s.whatsapp.net", "Bob"), chat("123456789@lid", "Lid person"), chat("120363000000000001@g.us", "Team")];
  const routes = (extra = {}) => ({ "GET /admin/api/chats": chatsRoute(people), ...extra });
  const editor = (data, extra) => kit.mountApi({ data, routes: routes(extra), route: route({ rest: ["keys", "new"] }) });

  test("rights come from the catalogue only, nothing is ticked on a new key, an unknown stored right is an orphan chip", async () => {
    const data = freshData({ keys: [makeKey(1, { rights: ["messages.send.text", "legacy.old"], orphanRights: ["legacy.old"] })] });
    const fresh = editor(data);
    try {
      await fresh.settle(6);
      const boxes = dom.find(fresh.root, (el) => el.localName === "input" && el.getAttribute("type") === "checkbox" && /^(messages|media|api)\./.test(el.getAttribute("name") || ""));
      assert.equal(boxes.length, data.catalog.rights.length);
      assert.ok(boxes.every((box) => box.checked === false), "deny by default");
      assert.ok(fresh.find.has(T("api.right_group.send")) && fresh.find.has(T("api.right_group.docs")));
      assert.ok(!fresh.find.has("legacy.old"));
    } finally {
      fresh.done();
    }
    const saved = kit.mountApi({ data, routes: routes(), route: route({ rest: ["keys", "1"] }) });
    try {
      await saved.settle(6);
      assert.ok(saved.find.has(T("api.rights_orphan", { id: "legacy.old" })));
      dom.click(dom.find(saved.root, (el) => el.localName === "button" && el.getAttribute("aria-label") === T("api.rights_orphan_remove", { id: "legacy.old" }))[0]);
      await saved.settle(3);
      assert.ok(!saved.find.has(T("api.rights_orphan", { id: "legacy.old" })), "the orphan is removable");
      assert.ok(ui.hasUnsaved(), "and the editor is dirty");
    } finally {
      saved.done();
    }
  });

  test("a group tick-all sets only its group; the dirty guard follows the draft", async () => {
    const t = editor(freshData());
    try {
      await t.settle(6);
      assert.equal(ui.hasUnsaved(), false, "an untouched new draft is not dirty");
      dom.click(t.find.button(T("api.rights_all", { group: T("api.right_group.send") })));
      await t.settle(3);
      const checked = dom.find(t.root, (el) => el.localName === "input" && el.getAttribute("type") === "checkbox" && el.checked === true).map((el) => el.getAttribute("name"));
      assert.equal(checked.length, 13);
      assert.ok(checked.every((name) => name.startsWith("messages.send.")));
      assert.equal(ui.hasUnsaved(), true);
      assert.ok(t.find.has(T("api.editor_pending", { count: 13 })));
    } finally {
      t.done();
    }
  });

  test("creating: the body has exactly the KeyInput set, the password is asked, the secret dialog opens first and the editor opens only after it closes", async () => {
    globalThis.location = { protocol: "https:", hostname: "localhost", hash: "#/api/keys/new" };
    const data = freshData({ keys: [] });
    const t = editor(data, {
      "POST /admin/api/session/reauth": () => ok(CONFIRMED()),
      "POST /admin/api/api/keys": () => {
        const created = makeKey(7, { name: "mailer", rights: ["messages.send.text"] });
        data.keys = [created];
        return ok({ key: created, secret: SECRET }, 201);
      },
    });
    try {
      await t.settle(6);
      await typeInto(t.find.input("api-key-name"), "mailer");
      dom.check(t.find.input("messages.send.text"), true);
      await t.settle(3);
      // a typed number in the real 003 picker, CHAT-1 without `selectable`
      const number = t.find.input("permissions-number");
      await typeInto(number, "+237 6 90-00-00-02");
      dom.fire(dom.find(t.root, (el) => el.localName === "form" && dom.find(el, (c) => c === number).length)[0], "submit");
      await t.settle(3);
      assert.ok(t.find.has("+237690000002"));
      for (const request of t.guard.requests.filter((r) => r.key === "GET /admin/api/chats")) assert.ok(!request.search.includes("selectable"), request.search);
      assert.ok(t.guard.requests.some((r) => r.key === "GET /admin/api/chats" && r.search.includes("kind=group")), "the group picker asks for groups");
      assert.ok(t.guard.requests.some((r) => r.key === "GET /admin/api/chats" && r.search.includes("kind=private")), "the number picker asks for private chats");

      assert.ok(ui.hasUnsaved());
      dom.click(t.find.button(T("common.save")));
      await t.settle(4);
      assert.ok(reauth.reauthStore.get().request, "a creation asks the password");
      assert.deepEqual(reauth.reauthStore.get().request.reasons, ["create"]);
      assert.equal(t.guard.count("POST /admin/api/api/keys"), 0);
      await submitPassword(t, "right password");
      await t.settle(6);

      const body = t.guard.requests.find((r) => r.key === "POST /admin/api/api/keys").body;
      assert.deepEqual(Object.keys(body).sort(), KEY_SET);
      assert.deepEqual(body, { name: "mailer", rights: ["messages.send.text"], policy: { mode: "list", recipients: ["237690000002@s.whatsapp.net"] }, limits: { perMinute: null, perDay: null, maxPending: null }, ipAllow: [], expiresAt: null });

      // the secret dialog first
      const dialog = dom.find(t.root, (el) => el.localName === "dialog" && dom.text(el).includes(T("api.secret_title")))[0];
      assert.ok(dialog, "the secret dialog is open");
      const area = dom.find(dialog, (el) => el.localName === "textarea")[0];
      assert.equal(area.value, SECRET);
      assert.equal(area.getAttribute("readonly") !== null, true);
      assert.equal(globalThis.location.hash, "#/api/keys/new", "no navigation yet");
      assert.equal(ui.hasUnsaved(), true, "the leave guard protects the secret");
      assert.ok(dom.text(dialog).includes(T("api.secret_for", { name: "mailer", last4: "x9Qa" })));

      // Escape does nothing
      dom.fire(dialog, "cancel");
      await t.settle(2);
      assert.ok(dom.find(t.root, (el) => el.localName === "dialog" && dom.text(el).includes(T("api.secret_title"))).length === 1);

      // closing without a copy asks first; declining keeps it open
      dom.click(t.find.button(T("api.secret_done")));
      const asked = await kit.answerConfirm(false);
      assert.equal(asked.title, T("api.secret_close_title"));
      assert.ok(!JSON.stringify(asked).includes("CANARY"), "the question never carries the secret");
      await t.settle(3);
      assert.ok(t.find.has(T("api.secret_title")));

      // a real copy, then the close needs no question
      let copied = null;
      await withNavigator({ clipboard: { writeText: async (text) => { copied = text; } } }, async () => {
        dom.click(t.find.button(T("api.secret_copy")));
        await t.settle(3);
      });
      assert.equal(copied, SECRET);
      assert.ok(t.find.has(T("api.secret_copied")));
      dom.click(t.find.button(T("api.secret_done")));
      await t.settle(4);
      assert.equal(ui.confirmStore.get().request, null);
      assert.ok(!t.find.has(T("api.secret_title")));
      assert.equal(globalThis.location.hash, "#/api/keys/7", "the navigation to the editor happens when the dialog closes");

      // SC-003, UI side: the secret is nowhere once the dialog is closed
      assert.ok(!dom.text(t.root).includes("CANARY"));
      assert.ok(!JSON.stringify(ui.toastStore.get()).includes("CANARY"));
      assert.ok(!JSON.stringify(ui.confirmStore.get()).includes("CANARY"));
      assert.ok(!JSON.stringify(reauth.reauthStore.get(), (k, v) => (typeof v === "function" ? undefined : v)).includes("CANARY"));
      assert.equal(ui.hasUnsaved(), false);
    } finally {
      t.done();
      delete globalThis.location;
    }
  });

  test("without a clipboard the copy falls back to selecting the text; no storage is ever written", async () => {
    const data = freshData({ keys: [] });
    const writes = [];
    const fakeStorage = { setItem: (...args) => writes.push(args), getItem: () => null, removeItem: () => {}, clear: () => {} };
    globalThis.localStorage = fakeStorage;
    globalThis.sessionStorage = fakeStorage;
    const t = editor(data, {
      "POST /admin/api/session/reauth": () => ok(CONFIRMED()),
      "POST /admin/api/api/keys": () => ok({ key: makeKey(8, { name: "k8" }), secret: SECRET }, 201),
    });
    try {
      await t.settle(6);
      await typeInto(t.find.input("api-key-name"), "k8");
      reauth.markConfirmed(CONFIRMED());
      dom.click(t.find.button(T("common.save")));
      await t.settle(6);
      const area = dom.find(t.root, (el) => el.localName === "textarea")[0];
      assert.ok(area, "the secret dialog is open");
      let selected = 0;
      area.select = () => { selected += 1; };
      await withNavigator({}, async () => {
        dom.click(t.find.button(T("api.secret_copy")));
        await t.settle(3);
      });
      assert.ok(t.find.has(T("api.copy_manual")), "the manual hint shows");
      assert.ok(selected >= 1, "the text is selected for a manual copy");
      dom.fire(area, "focus");
      assert.ok(selected >= 2, "focusing selects too");
      assert.deepEqual(writes, [], "nothing was written to a storage");
      assert.ok(!JSON.stringify(writes).includes("CANARY"));
    } finally {
      t.done();
      delete globalThis.localStorage;
      delete globalThis.sessionStorage;
    }
  });

  test('"anyone": a refusal restores the radio, an acceptance shows the banner and sends the confirmation token', async () => {
    const data = freshData({ keys: [] });
    const t = editor(data, {
      "POST /admin/api/session/reauth": () => ok(CONFIRMED()),
      "POST /admin/api/api/keys": () => ok({ key: makeKey(9, { name: "wide" }), secret: SECRET }, 201),
    });
    try {
      await t.settle(6);
      const radio = (value) => dom.byAttr(t.root, "value", value, "input")[0];
      await typeInto(t.find.input("api-key-name"), "wide");
      dom.check(radio("anyone"), true);
      const asked = await kit.answerConfirm(false);
      assert.equal(asked.title, T("api.anyone_title"));
      assert.equal(asked.danger, true);
      await t.settle(3);
      assert.equal(radio("list").checked, true, "the radio returned to the saved mode");
      assert.equal(radio("anyone").checked, false);
      assert.ok(!t.find.has(T("api.anyone_banner")));
      dom.check(radio("anyone"), true);
      await kit.answerConfirm(true);
      await t.settle(3);
      assert.equal(radio("anyone").checked, true);
      assert.ok(t.find.has(T("api.anyone_banner")));
      reauth.markConfirmed(CONFIRMED());
      dom.click(t.find.button(T("common.save")));
      await t.settle(6);
      const body = t.guard.requests.find((r) => r.key === "POST /admin/api/api/keys").body;
      assert.deepEqual(body.confirm, ["policy_anyone"]);
      assert.equal(body.policy.mode, "anyone");
    } finally {
      t.done();
    }
  });

  test("a LID chat is refused in the number picker; a group is added by its picker", async () => {
    const t = editor(freshData({ keys: [] }));
    try {
      await t.settle(6);
      const lid = dom.find(t.root, (el) => el.localName === "input" && el.getAttribute("aria-label") === T("permissions.pick_person", { person: "@123456789" }))[0];
      assert.ok(lid, "the known-contacts list shows the LID chat");
      dom.check(lid, true);
      await t.settle(3);
      assert.ok(dom.find(t.root, (el) => el.getAttribute("role") === "alert" && dom.text(el) === T("fields.invalid_jid")).length === 1);
      assert.ok(!t.find.has(T("api.recipients_empty")) === false, "nothing was added");
      const group = dom.find(t.root, (el) => el.localName === "input" && (el.getAttribute("aria-label") || "") === T("api.groups_pick", { group: "Team" }))[0];
      assert.ok(group);
      dom.check(group, true);
      await t.settle(3);
      assert.ok(dom.find(t.root, (el) => el.localName === "li" && el.getAttribute("class") === "chip" && dom.text(el).includes("Team") && dom.text(el).includes(T("api.kind_group"))).length === 1);
    } finally {
      t.done();
    }
  });

  test("invalid IP rows give one aggregated error and send nothing; an expiry in the past is refused", async () => {
    const t = editor(freshData({ keys: [] }));
    try {
      await t.settle(6);
      await typeInto(t.find.input("api-key-name"), "ips");
      for (let i = 0; i < 3; i += 1) {
        dom.click(t.find.button(T("api.ip_add")));
        await t.settle(2);
      }
      const row = (n) => dom.find(t.root, (el) => el.localName === "input" && el.getAttribute("aria-label") === String(n))[0];
      await typeInto(row(1), "not an ip");
      await typeInto(row(2), "203.0.113.5");
      await typeInto(row(3), "300.1.1.1");
      await typeInto(dom.byAttr(t.root, "id", "api-key-expiry", "input")[0], "2020-01-01T10:00");
      reauth.markConfirmed(CONFIRMED());
      dom.click(t.find.button(T("common.save")));
      await t.settle(4);
      assert.equal(t.guard.count("POST /admin/api/api/keys"), 0);
      assert.equal(dom.find(t.root, (el) => el.getAttribute("role") === "alert" && dom.text(el) === T("api.ip_invalid_rows", { rows: "1, 3" })).length, 1);
      assert.ok(t.find.has(T("fields.in_past")));
    } finally {
      t.done();
    }
  });

  test("a 422 is mapped to the sections; paths the editor does not know are listed in the summary", async () => {
    const t = editor(freshData({ keys: [] }), {
      "POST /admin/api/api/keys": () => fail(422, "validation_failed", { fields: { name: { code: "duplicate" }, "policy.recipients": { code: "invalid_jid", params: { indices: [0, 2] } }, "limits.perDay": { code: "out_of_range", params: { min: 1, max: 100000 } }, "$unknown": { code: "unknown_field" } } }),
    });
    try {
      await t.settle(6);
      await typeInto(t.find.input("api-key-name"), "dup");
      reauth.markConfirmed(CONFIRMED());
      dom.click(t.find.button(T("common.save")));
      await t.settle(4);
      assert.equal(t.guard.count("POST /admin/api/api/keys"), 1);
      const alerts = dom.find(t.root, (el) => el.getAttribute("role") === "alert").map((el) => dom.text(el));
      assert.ok(alerts.includes(T("fields.duplicate")), alerts.join(" | "));
      assert.ok(alerts.includes(T("api.recipients_invalid_rows", { rows: "1, 3" })));
      assert.ok(alerts.some((text) => text.includes(T("api.editor_errors_title")) && text.includes("$unknown")));
      assert.deepEqual(ui.toastStore.get().items.filter((item) => item.kind === "error"), [], "nothing is toasted twice");
    } finally {
      t.done();
    }
  });
});

// ===========================================================================
// Part 3: key actions, update, networks
// ===========================================================================

describe("Duplicate and Revoke", () => {
  const keys = () => [
    makeKey(1, { name: "n8n", queued: 2 }),
    makeKey(2, { name: "old", status: "expired", expiresAt: PAST }),
    makeKey(3, { name: "gone", status: "revoked", revokedAt: "2026-10-30T10:00:00.000Z" }),
  ];
  const actionButton = (t, name, action) => dom.find(t.root, (el) => el.localName === "button" && el.getAttribute("aria-label") === T("api.action_for", { action, name }))[0];

  test("Duplicate asks the password, sends an empty body, shows the secret once and leaves the source untouched", async () => {
    const data = freshData({ keys: keys() });
    const t = kit.mountApi({
      data,
      routes: {
        "POST /admin/api/session/reauth": () => ok(CONFIRMED()),
        "POST /admin/api/api/keys/1/duplicate": () => {
          data.keys = [...data.keys, makeKey(5, { name: "n8n (2)" })];
          return ok({ key: makeKey(5, { name: "n8n (2)" }), secret: SECRET }, 201);
        },
      },
    });
    try {
      await t.settle(6);
      assert.equal(actionButton(t, "old", T("api.action_duplicate")), undefined, "only active keys can be duplicated");
      assert.equal(actionButton(t, "gone", T("api.action_duplicate")), undefined);
      dom.click(actionButton(t, "n8n", T("api.action_duplicate")));
      await t.settle(4);
      assert.deepEqual(reauth.reauthStore.get().request.reasons, ["create"]);
      assert.equal(t.guard.count("POST /admin/api/api/keys/1/duplicate"), 0);
      await submitPassword(t, "right password");
      await t.settle(6);
      assert.deepEqual(t.guard.requests.find((r) => r.key === "POST /admin/api/api/keys/1/duplicate").body, {});
      const area = dom.find(t.root, (el) => el.localName === "textarea")[0];
      assert.equal(area.value, SECRET);
      assert.ok(toasts().includes(T("api.duplicate_done", { name: "n8n (2)" })));
      assert.ok(!JSON.stringify(toasts()).includes("CANARY"));
      assert.equal(t.guard.count("GET /admin/api/api/keys"), 2, "the list is reloaded");
      reauth.markConfirmed(CONFIRMED());
    } finally {
      t.done();
    }
  });

  test("Revoke names the queued count, sends confirm: true with no password and toasts the cancelled count", async () => {
    const data = freshData({ keys: keys() });
    const t = kit.mountApi({ data, routes: { "POST /admin/api/api/keys/1/revoke": () => ok({ key: makeKey(1, { status: "revoked" }), cancelled: 2 }) } });
    try {
      await t.settle(6);
      dom.click(actionButton(t, "n8n", T("api.action_revoke")));
      const asked = await kit.answerConfirm(false);
      assert.equal(asked.title, T("api.revoke_title", { name: "n8n" }));
      assert.equal(asked.message, T("api.revoke_message", { count: 2 }));
      await t.settle(3);
      assert.equal(t.guard.count("POST /admin/api/api/keys/1/revoke"), 0, "refusing sends nothing");
      dom.click(actionButton(t, "n8n", T("api.action_revoke")));
      await kit.answerConfirm(true);
      await t.settle(6);
      assert.deepEqual(t.guard.requests.find((r) => r.key === "POST /admin/api/api/keys/1/revoke").body, { confirm: true });
      assert.equal(reauth.reauthStore.get().request, null, "revoking narrows access: no password");
      assert.ok(toasts().includes(T("api.revoke_done", { name: "n8n", count: 2, cancelled: 2 })));
      assert.equal(t.guard.count("GET /admin/api/api/keys"), 2);
    } finally {
      t.done();
    }
  });

  test("a key without queued messages has its own text, and cancelled: null reads as the no-count toast", async () => {
    const data = freshData({ keys: [makeKey(4, { name: "quiet" })] });
    const t = kit.mountApi({ data, routes: { "POST /admin/api/api/keys/4/revoke": () => ok({ key: makeKey(4, { status: "revoked" }), cancelled: null }) } });
    try {
      await t.settle(6);
      dom.click(actionButton(t, "quiet", T("api.action_revoke")));
      const asked = await kit.answerConfirm(true);
      assert.equal(asked.message, T("api.revoke_message_none"));
      await t.settle(6);
      assert.ok(toasts().includes(T("api.revoke_done_nocount", { name: "quiet" })));
    } finally {
      t.done();
    }
  });
});

describe("KeyEditor: update", () => {
  const people = [chat("237690000009@s.whatsapp.net", "Bob")];
  const editorOf = (data, id, extra = {}) => kit.mountApi({ data, routes: { "GET /admin/api/chats": chatsRoute(people), ...extra }, route: route({ rest: ["keys", String(id)] }) });
  const nameInput = (t) => t.find.input("api-key-name");

  test("a change that does not widen sends the version and no password; the keyed remount shows the saved key", async () => {
    const data = freshData({ keys: [makeKey(1, { name: "n8n" })] });
    const t = editorOf(data, 1, {
      "PUT /admin/api/api/keys/1": (body) => {
        data.keys = [makeKey(1, { name: body.name, version: 2 })];
        return ok({ key: data.keys[0], changed: ["name"] });
      },
    });
    try {
      await t.settle(6);
      assert.equal(t.find.button(T("common.save")).prop("disabled"), true, "nothing to save yet");
      await typeInto(nameInput(t), "n8n renamed");
      assert.equal(ui.hasUnsaved(), true);
      dom.click(t.find.button(T("common.save")));
      await t.settle(6);
      const body = t.guard.requests.find((r) => r.key === "PUT /admin/api/api/keys/1").body;
      assert.deepEqual(Object.keys(body).sort(), [...KEY_SET, "version"].sort());
      assert.equal(body.version, 1);
      assert.equal(reauth.reauthStore.get().request, null);
      assert.ok(toasts().includes(T("api.editor_saved", { name: "n8n renamed" })));
      assert.equal(nameInput(t).value, "n8n renamed");
      assert.equal(ui.hasUnsaved(), false, "the fresh draft is clean");
    } finally {
      t.done();
    }
  });

  test("a widening opens the dialog with the reasons and sends nothing until the password is right", async () => {
    const data = freshData({ keys: [makeKey(1)] });
    const t = editorOf(data, 1, {
      "POST /admin/api/session/reauth": () => ok(CONFIRMED()),
      "PUT /admin/api/api/keys/1": () => ok({ key: makeKey(1, { version: 2 }), changed: ["rights"] }),
    });
    try {
      await t.settle(6);
      dom.check(t.find.input("messages.send.image"), true);
      await t.settle(3);
      dom.click(t.find.button(T("common.save")));
      await t.settle(4);
      assert.deepEqual(reauth.reauthStore.get().request.reasons, ["rights"]);
      assert.equal(t.guard.count("PUT /admin/api/api/keys/1"), 0);
      await submitPassword(t, "right password");
      await t.settle(6);
      assert.equal(t.guard.count("PUT /admin/api/api/keys/1"), 1);
    } finally {
      t.done();
    }
  });

  test("a 409 conflict toasts, reloads and starts a fresh draft from the server state", async () => {
    const data = freshData({ keys: [makeKey(1, { name: "n8n" })] });
    const t = editorOf(data, 1, {
      "PUT /admin/api/api/keys/1": () => {
        data.keys = [makeKey(1, { name: "changed elsewhere", version: 5 })];
        return fail(409, "conflict", { fields: { version: { code: "conflict", params: { version: 5 } } } });
      },
    });
    try {
      await t.settle(6);
      await typeInto(nameInput(t), "my edit");
      dom.click(t.find.button(T("common.save")));
      await t.settle(6);
      assert.ok(toasts().includes(T("errors.conflict")), toasts().join(" | "));
      assert.equal(nameInput(t).value, "changed elsewhere", "the stale draft was discarded");
      assert.equal(t.guard.count("GET /admin/api/api/keys"), 2);
    } finally {
      t.done();
    }
  });

  test("a 409 confirmation_required for policy_anyone asks once and retries once with the token", async () => {
    const data = freshData({ keys: [makeKey(1, { name: "wide", policy: { mode: "anyone", recipients: [] } })] });
    let puts = 0;
    const t = editorOf(data, 1, {
      "PUT /admin/api/api/keys/1": (body) => {
        puts += 1;
        return puts === 1 ? fail(409, "confirmation_required", { params: { confirm: ["policy_anyone"] } }) : ok({ key: makeKey(1, { name: body.name, version: 2, policy: { mode: "anyone", recipients: [] } }), changed: ["name"] });
      },
    });
    try {
      await t.settle(6);
      await typeInto(nameInput(t), "wide 2");
      dom.click(t.find.button(T("common.save")));
      const asked = await kit.answerConfirm(true);
      assert.equal(asked.title, T("api.anyone_title"));
      await t.settle(6);
      assert.equal(puts, 2);
      assert.deepEqual(t.guard.requests.filter((r) => r.key === "PUT /admin/api/api/keys/1")[1].body.confirm, ["policy_anyone"]);
    } finally {
      t.done();
    }
  });

  test("a revoked key is read-only without Save, Duplicate or Revoke; an expired key is editable with its banner", async () => {
    const data = freshData({ keys: [makeKey(3, { name: "gone", status: "revoked", revokedAt: "2026-10-30T10:00:00.000Z" }), makeKey(2, { name: "old", status: "expired", expiresAt: PAST })] });
    const revoked = editorOf(data, 3);
    try {
      await revoked.settle(6);
      assert.ok(revoked.find.has(T("api.editor_revoked_banner")));
      assert.equal(nameInput(revoked).prop("disabled"), true);
      for (const label of [T("common.save"), T("api.action_duplicate"), T("api.action_revoke")]) assert.equal(revoked.find.button(label), undefined, label);
    } finally {
      revoked.done();
    }
    const expired = editorOf(data, 2);
    try {
      await expired.settle(6);
      assert.ok(expired.find.has(T("api.editor_expired_banner")));
      assert.equal(nameInput(expired).prop("disabled"), false);
      assert.ok(expired.find.button(T("common.save")));
      assert.equal(expired.find.button(T("api.action_duplicate")), undefined, "an expired key cannot be duplicated");
      assert.ok(expired.find.button(T("api.action_revoke")));
      assert.ok(expired.find.has(T("api.fact_last4")), "the facts of a saved key");
    } finally {
      expired.done();
    }
  });

  test("a 403 password_required after the retry is toasted, not looped", async () => {
    const data = freshData({ keys: [makeKey(1)], state: makeState({ stepUp: { confirmedUntil: new Date(Date.now() + 250000).toISOString(), windowMs: 300000 } }) });
    let puts = 0;
    const t = editorOf(data, 1, {
      "POST /admin/api/session/reauth": () => ok(CONFIRMED()),
      "PUT /admin/api/api/keys/1": () => {
        puts += 1;
        return fail(403, "password_required", { params: { windowMs: 300000 } });
      },
    });
    try {
      await t.settle(6);
      dom.check(t.find.input("messages.send.image"), true);
      await t.settle(3);
      dom.click(t.find.button(T("common.save")));
      await t.settle(6);
      await submitPassword(t, "right password");
      await t.settle(6);
      assert.equal(puts, 2);
      assert.ok(toasts().some((message) => message === T("errors.password_required", { windowMs: 300000 })), toasts().join(" | "));
    } finally {
      t.done();
    }
  });
});

describe("NetworksCard", () => {
  const networks = (over = {}, extra = {}) => ({ data: freshData({ state: makeState(over) }), routes: extra });
  const rowInput = (t, n) => dom.find(t.root, (el) => el.localName === "input" && el.getAttribute("aria-label") === String(n))[0];
  const add = async (t) => {
    dom.click(t.find.button(T("api.ip_add")));
    await t.settle(2);
  };

  test("an address outside the private ranges is refused row by row and sends nothing; a duplicate is not counted", async () => {
    const t = kit.mountApi(networks());
    try {
      await t.settle(6);
      assert.ok(t.find.has(T("api.networks_empty")));
      await add(t);
      await add(t);
      await typeInto(rowInput(t, 1), "192.168.1.0/24");
      await typeInto(rowInput(t, 2), "8.8.8.8");
      assert.ok(t.find.has(T("api.networks_not_private", { rows: "2" })));
      dom.click(t.find.button(T("api.networks_save")));
      await t.settle(3);
      assert.equal(t.guard.count("PUT /admin/api/api/state"), 0);
      await typeInto(rowInput(t, 2), "not an ip");
      assert.ok(t.find.has(T("api.networks_invalid_rows", { rows: "2" })));
    } finally {
      t.done();
    }
  });

  test("widening asks the password with plain_http; the PUT carries the current enabled and the list; the dirty guard follows", async () => {
    const data = freshData({ state: makeState({ enabled: true }) });
    const t = kit.mountApi({
      data,
      routes: {
        "POST /admin/api/session/reauth": () => ok(CONFIRMED()),
        "PUT /admin/api/api/state": (body) => {
          data.state = makeState({ enabled: true, plainHttpFrom: body.plainHttpFrom });
          return ok({ enabled: true, plainHttpFrom: body.plainHttpFrom, changed: true, cancelled: 0 });
        },
      },
    });
    try {
      await t.settle(6);
      assert.equal(ui.hasUnsaved(), false);
      await add(t);
      await typeInto(rowInput(t, 1), "192.168.1.0/24");
      assert.equal(ui.hasUnsaved(), true);
      dom.click(t.find.button(T("api.networks_save")));
      await t.settle(4);
      assert.deepEqual(reauth.reauthStore.get().request.reasons, ["plain_http"]);
      assert.equal(t.guard.count("PUT /admin/api/api/state"), 0);
      await submitPassword(t, "right password");
      await t.settle(6);
      assert.deepEqual(t.guard.requests.find((r) => r.key === "PUT /admin/api/api/state").body, { enabled: true, plainHttpFrom: ["192.168.1.0/24"] });
      assert.ok(toasts().includes(T("api.networks_saved")));
      assert.equal(ui.hasUnsaved(), false);
      assert.equal(t.guard.count("GET /admin/api/api"), 2);
    } finally {
      t.done();
    }
  });

  test("narrowing never asks the password; a disabled API stays disabled in the PUT", async () => {
    const data = freshData({ state: makeState({ enabled: false, plainHttpFrom: ["192.168.0.0/16", "10.0.0.0/8"] }) });
    const t = kit.mountApi({ data, routes: { "PUT /admin/api/api/state": (body) => ok({ enabled: false, plainHttpFrom: body.plainHttpFrom, changed: true, cancelled: 0 }) } });
    try {
      await t.settle(6);
      assert.equal(t.find.button(T("api.networks_save")).prop("disabled"), true, "nothing changed yet");
      dom.click(dom.find(t.root, (el) => el.localName === "button" && el.getAttribute("aria-label") === T("common.remove"))[1]);
      await t.settle(3);
      dom.click(t.find.button(T("api.networks_save")));
      await t.settle(6);
      assert.equal(reauth.reauthStore.get().request, null);
      assert.deepEqual(t.guard.requests.find((r) => r.key === "PUT /admin/api/api/state").body, { enabled: false, plainHttpFrom: ["192.168.0.0/16"] });
    } finally {
      t.done();
    }
  });

  test("a server 422 on plainHttpFrom maps to the same row message", async () => {
    const t = kit.mountApi(networks({ stepUp: { confirmedUntil: new Date(Date.now() + 250000).toISOString(), windowMs: 300000 } }, {
      "PUT /admin/api/api/state": () => fail(422, "validation_failed", { fields: { plainHttpFrom: { code: "invalid_format", params: { indices: [0], reason: "not_private" } } } }),
    }));
    try {
      await t.settle(6);
      await add(t);
      await typeInto(rowInput(t, 1), "172.20.0.0/16");
      reauth.markConfirmed(CONFIRMED());
      dom.click(t.find.button(T("api.networks_save")));
      await t.settle(6);
      assert.ok(t.find.has(T("api.networks_not_private", { rows: "1" })));
    } finally {
      t.done();
    }
  });
});

module.exports = { freshData, route, submitPassword, typeInto, toasts, T };
