"use strict";
/**
 * The step-up flow of the shell (feature 004, contracts/panel-ui.md section 6): lib/admin/public/js/reauth.mjs
 * (the local belief about the confirmation, the pending request, withStepUp, submitPassword) and the password dialog
 * lib/admin/public/js/components/reauth-dialog.mjs rendered in a fake DOM with a scripted AUTH-7.
 *
 * Render guards (test/helpers/viewGuard.js): a scripted fetch, a small fixed number of event-loop turns, the root
 * unmounted and the guard checked in a `finally`, the guard / DOM / fetch restored in `after`.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createDom, importPublic } = require("./helpers/fakeDom");
const { createViewGuard, answer } = require("./helpers/viewGuard");

const ROOT = path.resolve(__dirname, "..");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const FRAGMENT_DIR = path.join(ROOT, "specs", "004-messaging-api", "i18n");

function catalogOf(lang) {
  const base = readJson(path.join(ROOT, "lib", "admin", "public", "i18n", `${lang}.json`));
  for (const name of ["panel-api.json", "panel-api-server.json"]) {
    const file = path.join(FRAGMENT_DIR, name);
    if (fs.existsSync(file)) Object.assign(base, readJson(file)[lang]);
  }
  return base;
}

let dom;
let i18n;
let ui;
let reauth;
let dialog;
let html;
let apiModule;

before(async () => {
  dom = await createDom();
  i18n = await importPublic("js/i18n.mjs");
  for (const lang of ["en", "fr"]) i18n.setCatalog(lang, catalogOf(lang));
  await i18n.setLanguage("en", { remember: false });
  ui = await importPublic("js/ui.mjs");
  reauth = await importPublic("js/reauth.mjs");
  dialog = await importPublic("js/components/reauth-dialog.mjs");
  html = (await importPublic("js/components/html.mjs")).html;
  apiModule = await importPublic("js/api.mjs");
});

after(() => {
  dom.restore();
  i18n.__resetForTests();
  delete globalThis.fetch;
});

const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);
const WINDOW = { confirmedUntil: new Date(T0 + 300000).toISOString(), windowMs: 300000 };

// ===========================================================================
// reauth.mjs
// ===========================================================================

describe("the local belief about the confirmation", () => {
  test("isConfirmed keeps a margin of 2 seconds before the end of the window", () => {
    reauth.markConfirmed(WINDOW, T0);
    assert.equal(reauth.STEP_UP_MARGIN_MS, 2000);
    assert.equal(reauth.isConfirmed(T0), true);
    assert.equal(reauth.isConfirmed(T0 + 297999), true);
    assert.equal(reauth.isConfirmed(T0 + 298000), false, "2 s before the end it is already over");
    assert.equal(reauth.isConfirmed(T0 + 400000), false);
    reauth.forgetConfirmation();
    assert.equal(reauth.isConfirmed(T0), false);
  });

  test("markConfirmed counts windowMs from receipt, whatever the server clock says; an unusable answer is no confirmation", () => {
    reauth.markConfirmed({ confirmedUntil: new Date(T0 + 3600000).toISOString(), windowMs: 300000 }, T0);
    assert.equal(reauth.isConfirmed(T0 + 297999), true);
    assert.equal(reauth.isConfirmed(T0 + 298000), false, "the far-away server time is not trusted");
    for (const bad of [null, undefined, {}, { windowMs: 0 }, { windowMs: -5 }, { windowMs: "soon" }]) {
      reauth.markConfirmed(WINDOW, T0);
      assert.equal(reauth.markConfirmed(bad, T0), 0);
      assert.equal(reauth.isConfirmed(T0), false);
    }
  });

  test("syncConfirmation from API-1: null is none, else the earlier of the server's end and now + windowMs", () => {
    assert.equal(reauth.syncConfirmation({ confirmedUntil: null, windowMs: 300000 }, T0), 0);
    assert.equal(reauth.isConfirmed(T0), false);
    reauth.syncConfirmation({ confirmedUntil: new Date(T0 + 120000).toISOString(), windowMs: 300000 }, T0);
    assert.equal(reauth.isConfirmed(T0 + 117999), true);
    assert.equal(reauth.isConfirmed(T0 + 118000), false);
    reauth.syncConfirmation({ confirmedUntil: new Date(T0 + 9999999).toISOString(), windowMs: 300000 }, T0);
    assert.equal(reauth.isConfirmed(T0 + 297999), true, "capped at now + windowMs");
    assert.equal(reauth.isConfirmed(T0 + 298000), false);
    assert.equal(reauth.syncConfirmation({ confirmedUntil: "garbage", windowMs: 300000 }, T0), 0);
    assert.equal(reauth.syncConfirmation(undefined, T0), 0);
    reauth.forgetConfirmation();
  });
});

describe("requestReauth and resolveReauth", () => {
  test("one dialog at a time: a concurrent caller gets the pending promise; the answer resolves both and clears the store", async () => {
    const first = reauth.requestReauth({ reasons: ["rights"] });
    const second = reauth.requestReauth({ reasons: ["policy"] });
    assert.equal(first, second, "the same promise");
    const { request } = reauth.reauthStore.get();
    assert.deepEqual(request.reasons, ["rights"], "the first request wins");
    assert.equal(typeof request.id, "number");
    reauth.resolveReauth(true);
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.equal(reauth.reauthStore.get().request, null);
    reauth.resolveReauth(true); // nothing pending: no throw

    const next = reauth.requestReauth({});
    assert.notEqual(next, first, "a new request after the answer");
    reauth.resolveReauth(false);
    assert.equal(await next, false);
  });
});

describe("withStepUp", () => {
  const fresh = () => reauth.forgetConfirmation();
  const passwordRequired = (reasons) => Object.assign(new Error("password_required"), { code: "password_required", status: 403, params: reasons ? { windowMs: 300000, reasons } : { windowMs: 300000 } });

  test("not needed: the request goes out, no question", async () => {
    fresh();
    const asked = [];
    const result = await reauth.withStepUp(async () => 42, { needed: false, ask: async (x) => asked.push(x) });
    assert.deepEqual(result, { ok: true, value: 42 });
    assert.deepEqual(asked, []);
  });

  test("needed and unconfirmed: asks with the reasons; a refusal sends nothing and is a cancel, not an error", async () => {
    fresh();
    let ran = 0;
    const asked = [];
    const result = await reauth.withStepUp(async () => (ran += 1), { needed: true, reasons: ["rights", "expiry"], ask: async (x) => { asked.push(x); return false; } });
    assert.deepEqual(result, { ok: false, cancelled: true });
    assert.equal(ran, 0);
    assert.deepEqual(asked, [{ reasons: ["rights", "expiry"] }]);
  });

  test("needed and confirmed: no question", async () => {
    reauth.markConfirmed(WINDOW, T0);
    const asked = [];
    const result = await reauth.withStepUp(async () => "done", { needed: true, ask: async (x) => asked.push(x), now: () => T0 + 1000 });
    assert.deepEqual(result, { ok: true, value: "done" });
    assert.deepEqual(asked, []);
    // past the window the question comes back
    const late = await reauth.withStepUp(async () => "done", { needed: true, ask: async (x) => { asked.push(x); return true; }, now: () => T0 + 299000 });
    assert.equal(late.ok, true);
    assert.equal(asked.length, 1);
    fresh();
  });

  test("a 403 password_required after the click: forget, ask once with the server's reasons, retry once", async () => {
    reauth.markConfirmed(WINDOW, Date.now());
    let calls = 0;
    const asked = [];
    const result = await reauth.withStepUp(
      async () => {
        calls += 1;
        if (calls === 1) throw passwordRequired(["policy"]);
        return "saved";
      },
      { needed: false, ask: async (x) => { asked.push(x); return true; } },
    );
    assert.deepEqual(result, { ok: true, value: "saved" });
    assert.equal(calls, 2);
    assert.deepEqual(asked, [{ reasons: ["policy"] }], "the reasons of the server answer");
    assert.equal(reauth.isConfirmed(Date.now()), false, "the local belief was dropped");
  });

  test("reasons given by the caller win over those of the server", async () => {
    fresh();
    let calls = 0;
    const asked = [];
    await reauth.withStepUp(async () => { calls += 1; if (calls === 1) throw passwordRequired(["policy"]); return 1; }, { reasons: ["create"], ask: async (x) => { asked.push(x); return true; } });
    assert.deepEqual(asked, [{ reasons: ["create"] }]);
  });

  test("a second password_required goes to the caller: one retry only, no loop", async () => {
    fresh();
    let calls = 0;
    const asked = [];
    const error = passwordRequired();
    await assert.rejects(
      () => reauth.withStepUp(async () => { calls += 1; throw error; }, { ask: async (x) => { asked.push(x); return true; } }),
      (thrown) => thrown === error,
    );
    assert.equal(calls, 2);
    assert.equal(asked.length, 1);
  });

  test("a cancel after the 403 sends nothing more; any other error is rethrown untouched, without a question", async () => {
    fresh();
    let calls = 0;
    const cancelled = await reauth.withStepUp(async () => { calls += 1; throw passwordRequired(); }, { ask: async () => false });
    assert.deepEqual(cancelled, { ok: false, cancelled: true });
    assert.equal(calls, 1);

    const boom = Object.assign(new Error("conflict"), { code: "conflict", status: 409 });
    const asked = [];
    await assert.rejects(() => reauth.withStepUp(async () => { throw boom; }, { ask: async (x) => asked.push(x) }), (thrown) => thrown === boom);
    assert.deepEqual(asked, []);
    await assert.rejects(() => reauth.withStepUp(async () => { throw null; }, {}), (thrown) => thrown === null);
  });
});

describe("submitPassword and classifyReauthError", () => {
  test("it posts the password to AUTH-7, starts the local window from receipt and returns the answer", async () => {
    reauth.forgetConfirmation();
    const sent = [];
    const result = await reauth.submitPassword("hunter2 hunter2", { apiImpl: async (...args) => { sent.push(args); return WINDOW; }, now: () => T0 });
    assert.deepEqual(sent, [["POST", "/admin/api/session/reauth", { password: "hunter2 hunter2" }]]);
    assert.equal(reauth.REAUTH_PATH, "/admin/api/session/reauth");
    assert.deepEqual(result, WINDOW);
    assert.equal(reauth.isConfirmed(T0 + 1000), true);
    reauth.forgetConfirmation();
  });

  test("a refusal reaches the caller and confirms nothing", async () => {
    reauth.forgetConfirmation();
    const error = new apiModule.ApiError({ status: 422, code: "validation_failed", fields: { password: { code: "wrong_password" } } });
    await assert.rejects(() => reauth.submitPassword("x", { apiImpl: async () => { throw error; } }), (thrown) => thrown === error);
    assert.equal(reauth.isConfirmed(Date.now()), false);
  });

  test("classifyReauthError: wrong, throttled, other", () => {
    const { ApiError } = apiModule;
    assert.equal(reauth.classifyReauthError(new ApiError({ status: 422, code: "validation_failed", fields: { password: { code: "wrong_password" } } })), "wrong");
    assert.equal(reauth.classifyReauthError(new ApiError({ status: 429, code: "rate_limited", params: { retryAfterMs: 5000 } })), "throttled");
    assert.equal(reauth.classifyReauthError(new ApiError({ status: 500, code: "internal_error" })), "other");
    assert.equal(reauth.classifyReauthError(new ApiError({ status: 422, code: "validation_failed", fields: { other: { code: "x" } } })), "other");
    assert.equal(reauth.classifyReauthError(new ApiError({ status: 401, code: "session_expired" })), "other");
    assert.equal(reauth.classifyReauthError(null), "other");
  });
});

describe("the source of the modules", () => {
  const read = (relative) => fs.readFileSync(path.join(ROOT, "lib", "admin", "public", "js", relative), "utf8");

  test("reauth.mjs has the AUTH-7 literals, no timer and no direct fetch; the dialog has no timer", () => {
    const source = read("reauth.mjs");
    assert.ok(source.includes('export const REAUTH_PATH = "/admin/api/session/reauth";'));
    assert.ok(source.includes('api("POST", REAUTH_PATH, { password })'));
    for (const file of ["reauth.mjs", "components/reauth-dialog.mjs"]) {
      const text = read(file);
      assert.ok(!/\bsetTimeout\s*\(|\bsetInterval\s*\(|\bfetch\s*\(|\bXMLHttpRequest\b|localStorage|sessionStorage|document\.cookie/.test(text), `${file}: no timer, direct request or storage`);
    }
  });
});

// ===========================================================================
// The dialog
// ===========================================================================

const REASONS = ["rights", "expiry", "brand_new_reason"];
const wrongAnswer = () => answer(422, { error: { code: "validation_failed", fields: { password: { code: "wrong_password" } }, requestId: "r1" } });

/** Mount ReauthView under a guard and a scripted AUTH-7; returns what a test needs and a `done()` for the finally. */
async function open({ reasons = REASONS, scripted } = {}) {
  const guard = createViewGuard({ preact: dom.preact });
  const attempts = [];
  globalThis.fetch = guard.fetch({
    "POST /admin/api/session/reauth": (body) => {
      attempts.push(body);
      return scripted ? scripted(body, attempts.length) : answer(200, WINDOW);
    },
  });
  reauth.forgetConfirmation();
  const resolved = [];
  const root = dom.mount(html`<${dialog.ReauthView} request=${{ id: 1, reasons }} onResolve=${(value) => resolved.push(value)} />`);
  await dom.settle(4);
  const input = dom.find(root, (el) => el.localName === "input")[0];
  const form = dom.find(root, (el) => el.localName === "form")[0];
  const button = (text) => dom.byText(root, text, "button")[0];
  const done = () => {
    try {
      dom.unmount(root);
      guard.assertClean();
    } finally {
      guard.restore();
      delete globalThis.fetch;
    }
  };
  return { root, guard, attempts, resolved, input, form, button, done };
}

describe("ReauthView", () => {
  test("it shows the title, the 5 minutes, the reasons (a code without a text raw) and a labelled current-password field", async () => {
    const view = await open();
    try {
      const text = dom.text(view.root);
      assert.ok(text.includes(i18n.t("reauth.title")));
      assert.ok(text.includes(i18n.t("reauth.message", { minutes: 5 })));
      assert.ok(i18n.t("reauth.message", { minutes: 5 }).includes("5"));
      assert.ok(text.includes(i18n.t("reauth.reasons_title")));
      assert.ok(text.includes(i18n.t("api.reason_rights")) && text.includes(i18n.t("api.reason_expiry")));
      const raw = dom.find(view.root, (el) => el.localName === "span" && el.getAttribute("class") === "mono" && dom.text(el) === "brand_new_reason");
      assert.equal(raw.length, 1, "an unknown reason is shown raw in span.mono");
      assert.equal(view.input.getAttribute("type"), "password");
      assert.equal(view.input.getAttribute("name"), "reauth-password");
      assert.equal(view.input.getAttribute("autocomplete"), "current-password");
      assert.ok(text.includes(i18n.t("reauth.password_label")));
      const dialogEl = dom.find(view.root, (el) => el.localName === "dialog")[0];
      assert.ok(dialogEl.getAttribute("aria-labelledby") && dialogEl.getAttribute("aria-describedby"));
      assert.equal(view.guard.count("POST /admin/api/session/reauth"), 0, "nothing is sent before a click");
    } finally {
      view.done();
    }
  });

  test("without reasons there is no reasons block", async () => {
    const view = await open({ reasons: [] });
    try {
      assert.ok(!dom.text(view.root).includes(i18n.t("reauth.reasons_title")));
    } finally {
      view.done();
    }
  });

  test("Escape and Cancel resolve false and send nothing", async () => {
    const escape = await open();
    try {
      dom.fire(dom.find(escape.root, (el) => el.localName === "dialog")[0], "cancel");
      assert.deepEqual(escape.resolved, [false]);
      assert.equal(escape.attempts.length, 0);
    } finally {
      escape.done();
    }
    const cancel = await open();
    try {
      dom.type(cancel.input, "something typed");
      await dom.settle(2); // the re-render that hands the typed value to the submit handler
      dom.click(cancel.button(i18n.t("common.cancel")));
      assert.deepEqual(cancel.resolved, [false]);
      assert.equal(cancel.attempts.length, 0);
    } finally {
      cancel.done();
    }
  });

  test("the right password: one AUTH-7 request, the window starts, the input is cleared and the answer is true", async () => {
    const view = await open();
    try {
      dom.type(view.input, "correct horse battery");
      await dom.settle(2); // the re-render that hands the typed value to the submit handler
      assert.equal(view.input.value, "correct horse battery");
      dom.fire(view.form, "submit");
      await dom.settle(6);
      assert.deepEqual(view.attempts, [{ password: "correct horse battery" }]);
      assert.deepEqual(view.resolved, [true]);
      assert.equal(reauth.isConfirmed(Date.now()), true);
      assert.equal(view.input.value, "", "the password is gone from the input");
      // the password is nowhere else: not in the store, the text, the toasts
      assert.ok(!JSON.stringify(reauth.reauthStore.get(), (k, v) => (typeof v === "function" ? undefined : v)).includes("correct horse"));
      assert.ok(!dom.text(view.root).includes("correct horse"));
      assert.ok(!JSON.stringify(ui.toastStore.get()).includes("correct horse"));
    } finally {
      view.done();
      reauth.forgetConfirmation();
    }
  });

  test("both buttons are disabled while the request is out, and Escape is ignored meanwhile", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const view = await open({ scripted: () => gate.then(() => answer(200, WINDOW)) });
    try {
      dom.type(view.input, "correct horse battery");
      await dom.settle(2); // the re-render that hands the typed value to the submit handler
      dom.fire(view.form, "submit");
      await dom.settle(3);
      assert.equal(view.button(i18n.t("common.cancel")).prop("disabled"), true);
      assert.equal(view.button(i18n.t("reauth.confirm")).prop("disabled"), true);
      dom.fire(dom.find(view.root, (el) => el.localName === "dialog")[0], "cancel");
      dom.fire(view.form, "submit");
      assert.deepEqual(view.resolved, [], "Escape during the request does nothing");
      release();
      await dom.settle(6);
      assert.deepEqual(view.resolved, [true]);
      assert.equal(view.attempts.length, 1, "a second submit while busy sends nothing");
    } finally {
      view.done();
      reauth.forgetConfirmation();
    }
  });

  test("an empty password cannot be submitted", async () => {
    const view = await open();
    try {
      assert.equal(view.button(i18n.t("reauth.confirm")).prop("disabled"), true);
      dom.fire(view.form, "submit");
      await dom.settle(3);
      assert.equal(view.attempts.length, 0);
    } finally {
      view.done();
    }
  });

  test("a wrong password (422) keeps the dialog open with the field error, clears the input and focuses it; nothing is confirmed", async () => {
    const view = await open({ scripted: () => wrongAnswer() });
    try {
      const body = dom.find(view.root, (el) => el.localName === "div" && el.getAttribute("class") === "stack-sm" && dom.find(el, (c) => c.localName === "input").length === 1)[0];
      let focused = 0;
      view.input.focus = () => { focused += 1; };
      body.querySelector = (selector) => (selector === "input" ? view.input : null);
      dom.type(view.input, "not the password");
      await dom.settle(2); // the re-render that hands the typed value to the submit handler
      dom.fire(view.form, "submit");
      await dom.settle(6);
      assert.deepEqual(view.resolved, [], "the dialog stays open");
      assert.equal(view.input.value, "", "the input is cleared");
      assert.equal(focused, 1, "and focused again");
      const alerts = dom.find(view.root, (el) => el.getAttribute("role") === "alert");
      assert.equal(alerts.length, 1);
      assert.equal(dom.text(alerts[0]), i18n.t("fields.wrong_password", { code: "wrong_password" }));
      assert.equal(reauth.isConfirmed(Date.now()), false);
      assert.ok(!dom.text(view.root).includes("not the password"));
      // typing again is possible and the next try goes out
      dom.type(view.input, "second try");
      await dom.settle(2); // the re-render that hands the typed value to the submit handler
      assert.equal(view.button(i18n.t("reauth.confirm")).prop("disabled"), false);
    } finally {
      view.done();
    }
  });

  test("a block (429) shows the retry text in a banner, stays open and arms no timer", async () => {
    const view = await open({ scripted: () => answer(429, { error: { code: "rate_limited", params: { retryAfterMs: 120000 } } }, { "Retry-After": "120" }) });
    try {
      dom.type(view.input, "correct horse battery");
      await dom.settle(2); // the re-render that hands the typed value to the submit handler
      dom.fire(view.form, "submit");
      await dom.settle(6);
      assert.deepEqual(view.resolved, []);
      const banner = dom.find(view.root, (el) => el.getAttribute("class") === "banner banner-warn")[0];
      assert.ok(banner, "a warning banner");
      assert.equal(banner.getAttribute("role"), "alert");
      const expected = i18n.tError({ code: "rate_limited", params: { retryAfterMs: 120000 }, retryAfterMs: 120000 });
      assert.equal(dom.text(banner), expected);
      assert.ok(/2/.test(expected), "the delay is in the text");
      assert.equal(reauth.isConfirmed(Date.now()), false);
      // another submit is cheap and goes out (the server refuses it the same way)
      dom.type(view.input, "correct horse battery");
      await dom.settle(2); // the re-render that hands the typed value to the submit handler
      dom.fire(view.form, "submit");
      await dom.settle(6);
      assert.equal(view.attempts.length, 2);
    } finally {
      view.done();
    }
  });

  test("any other failure shows the same kind of banner", async () => {
    const view = await open({ scripted: () => answer(500, { error: { code: "internal_error", requestId: "abc" } }) });
    try {
      dom.type(view.input, "correct horse battery");
      await dom.settle(2); // the re-render that hands the typed value to the submit handler
      dom.fire(view.form, "submit");
      await dom.settle(6);
      assert.deepEqual(view.resolved, []);
      const banner = dom.find(view.root, (el) => el.getAttribute("class") === "banner banner-warn")[0];
      assert.ok(banner && dom.text(banner).length > 0);
    } finally {
      view.done();
    }
  });

  test("the French texts exist for every key the dialog uses", () => {
    const keys = ["reauth.title", "reauth.message", "reauth.reasons_title", "reauth.password_label", "reauth.confirm", "common.cancel", "fields.wrong_password", "errors.rate_limited", "errors.password_required"];
    for (const lang of ["en", "fr"]) for (const key of keys) assert.equal(typeof catalogOf(lang)[key], "string", `${key} (${lang})`);
    assert.match(catalogOf("fr")["reauth.message"], /\{minutes\}/);
  });
});

describe("ReauthDialog (the host)", () => {
  test("it renders nothing without a request, the view when requestReauth is called, and nothing again once answered", async () => {
    const guard = createViewGuard({ preact: dom.preact });
    const root = dom.mount(html`<${dialog.ReauthDialog} />`);
    try {
      await dom.settle(3);
      assert.equal(dom.find(root, (el) => el.localName === "dialog").length, 0);
      const pending = reauth.requestReauth({ reasons: ["create"] });
      await dom.settle(4);
      assert.equal(dom.find(root, (el) => el.localName === "dialog").length, 1);
      assert.ok(dom.text(root).includes(i18n.t("api.reason_create")));
      dom.click(dom.byText(root, i18n.t("common.cancel"), "button")[0]);
      assert.equal(await pending, false);
      await dom.settle(4);
      assert.equal(dom.find(root, (el) => el.localName === "dialog").length, 0);
      guard.assertClean();
    } finally {
      dom.unmount(root);
      guard.restore();
    }
  });
});
