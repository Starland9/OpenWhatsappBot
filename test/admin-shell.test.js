"use strict";
/**
 * T209: the banners of the app shell (lib/admin/public/js/components/banner-list.mjs, ui.mjs).
 *
 * The 11 banners of admin-http-api.md 3.3 render through `banners.<id>` in both languages, with their parameters
 * (setting keys named, long lists cut, phases and unknown versions filled in), the right link, and the "Restart now"
 * button only on `restart_needed`, whose click goes through the confirmation dialog (FR-039) before RST-1 is called.
 * The shell puts them above the page content, and the screens shown before login render the client-side ones.
 */

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createDom, importPublic } = require("./helpers/fakeDom");

const ROOT = path.resolve(__dirname, "..");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const catalogFile = (lang) => path.join(ROOT, "lib", "admin", "public", "i18n", `${lang}.json`);

const ALL_BANNERS = [
  { id: "restart_needed", severity: "info", params: { keys: ["PREFIX", "SOME_UNKNOWN_KEY"] } },
  { id: "update_restart", severity: "warn", params: { from: "1.0.0", to: "1.1.0" } },
  { id: "undeclared_proxy", severity: "warn", params: { headers: ["X-Forwarded-For", "X-Real-IP"] } },
  { id: "no_https", severity: "warn", params: {} },
  { id: "secret_key_lost", severity: "error", params: { keys: ["OPENAI_API_KEY"] } },
  { id: "db_unavailable", severity: "error", params: {} },
  { id: "no_owner", severity: "warn", params: {} },
  { id: "maintenance", severity: "info", params: { phase: "database" } },
  { id: "restore_interrupted", severity: "error", params: {} },
  { id: "logged_out", severity: "warn", params: {} },
  { id: "invalid_file_values", severity: "warn", params: { keys: ["PREFIX"] } },
];

let dom;
let i18n;
let ui;
let preactHtml;
let bannerList;
let layout;

before(async () => {
  dom = await createDom();
  i18n = await importPublic("js/i18n.mjs");
  for (const lang of ["en", "fr"]) i18n.setCatalog(lang, readJson(catalogFile(lang)));
  await i18n.setLanguage("en", { remember: false });
  ui = await importPublic("js/ui.mjs");
  preactHtml = (await importPublic("js/components/html.mjs")).html;
  bannerList = await importPublic("js/components/banner-list.mjs");
  layout = await importPublic("js/components/layout.mjs");
});

after(() => {
  dom.restore();
  i18n.__resetForTests();
  delete globalThis.fetch;
});

const render = (banners) => dom.mount(preactHtml`<${bannerList.BannerList} banners=${banners} />`);
const bannerOf = (root, id) => dom.byAttr(root, "data-banner", id)[0];

describe("banner rendering", () => {
  for (const lang of ["en", "fr"]) {
    test(`all 11 banners render a translated text in ${lang}, with no raw key and no placeholder left`, async () => {
      await i18n.setLanguage(lang, { remember: false });
      const root = render(ALL_BANNERS);
      await dom.settle();
      const problems = [];
      for (const banner of ALL_BANNERS) {
        const el = bannerOf(root, banner.id);
        if (!el) {
          problems.push(`${banner.id}: not rendered`);
          continue;
        }
        const text = dom.text(el);
        if (/banners\.|\{[a-zA-Z]+\}/.test(text)) problems.push(`${banner.id}: "${text}"`);
        const role = el.getAttribute("role");
        if (role !== (banner.severity === "error" ? "alert" : "status")) problems.push(`${banner.id}: role ${role}`);
        if (!el.getAttribute("class").includes(`banner-${banner.severity}`)) problems.push(`${banner.id}: class ${el.getAttribute("class")}`);
      }
      assert.deepEqual(problems, []);
      assert.equal(dom.find(root, (el) => el.getAttribute("data-banner")).length, 11);
      dom.unmount(root);
    });
  }

  test("the parameters are shown: keys by label, versions, headers, the phase of a restore", async () => {
    await i18n.setLanguage("en", { remember: false });
    const root = render(ALL_BANNERS);
    await dom.settle();
    assert.match(dom.text(bannerOf(root, "restart_needed")), /Saved settings only apply after the bot restarts: .*\(PREFIX\), SOME_UNKNOWN_KEY\./, "a known key gets its label, an unknown one stays as is");
    assert.match(dom.text(bannerOf(root, "update_restart")), /\(1\.0\.0 → 1\.1\.0\)/);
    assert.match(dom.text(bannerOf(root, "undeclared_proxy")), /X-Forwarded-For, X-Real-IP.*PANEL_TRUST_PROXY/, "explains the setting that declares the proxy");
    assert.match(dom.text(bannerOf(root, "secret_key_lost")), /OPENAI_API_KEY/);
    assert.match(dom.text(bannerOf(root, "maintenance")), new RegExp(i18n.t("jobs.phase.database")), "the phase is translated");
    assert.match(dom.text(bannerOf(root, "no_https")), /HTTPS/);
    dom.unmount(root);
  });

  test("an update applied by a script has no known versions: the text still reads well", async () => {
    await i18n.setLanguage("en", { remember: false });
    const root = render([{ id: "update_restart", severity: "warn", params: { from: null, to: null } }]);
    await dom.settle();
    assert.match(dom.text(bannerOf(root, "update_restart")), /\(Unknown → Unknown\)/);
    dom.unmount(root);
  });

  test("a lost key file with no named setting uses the text that does not end on an empty list", async () => {
    await i18n.setLanguage("en", { remember: false });
    const root = render([{ id: "secret_key_lost", severity: "error", params: { keys: [] } }]);
    await dom.settle();
    const text = dom.text(bannerOf(root, "secret_key_lost"));
    assert.doesNotMatch(text, /: \./);
    assert.match(text, /panel\.key/);
    assert.equal(bannerList.bannerTextKey({ id: "secret_key_lost", params: { keys: ["A"] } }), "banners.secret_key_lost");
    assert.equal(bannerList.bannerTextKey({ id: "secret_key_lost", params: {} }), "banners.secret_key_lost_unknown");
    assert.equal(bannerList.bannerTextKey({ id: "no_owner" }), "banners.no_owner");
    dom.unmount(root);
  });

  test("long lists are cut after five entries", async () => {
    const params = bannerList.bannerParams({ id: "invalid_file_values", params: { keys: ["A", "B", "C", "D", "E", "F", "G"] } });
    assert.equal(params.keys, "A, B, C, D, E (+2)");
  });

  test("links lead to the page that fixes the problem; no_https and db_unavailable have none", async () => {
    await i18n.setLanguage("en", { remember: false });
    const hrefOf = (id) => bannerList.bannerHref({ id });
    assert.equal(hrefOf("update_restart"), "#/maintenance");
    assert.equal(hrefOf("undeclared_proxy"), "#/settings/PANEL_TRUST_PROXY");
    assert.equal(hrefOf("no_owner"), "#/settings/SUDO");
    assert.equal(hrefOf("secret_key_lost"), "#/settings");
    assert.equal(hrefOf("invalid_file_values"), "#/settings");
    assert.equal(hrefOf("logged_out"), "#/pairing");
    assert.equal(hrefOf("maintenance"), "#/backup");
    assert.equal(hrefOf("restore_interrupted"), "#/backup");
    assert.equal(hrefOf("no_https"), null);
    assert.equal(hrefOf("db_unavailable"), null);
    const root = render(ALL_BANNERS);
    await dom.settle();
    assert.equal(dom.find(bannerOf(root, "no_https"), (el) => el.localName === "a").length, 0);
    assert.equal(dom.find(bannerOf(root, "update_restart"), (el) => el.localName === "a")[0].getAttribute("href"), "#/maintenance");
    dom.unmount(root);
  });

  test("nothing to show renders nothing", () => {
    const root = render([]);
    assert.equal(root.childNodes.length, 0);
    const none = render(undefined);
    assert.equal(none.childNodes.length, 0);
  });
});

describe("restart_needed: the Restart now button", () => {
  let requests;

  beforeEach(() => {
    requests = [];
    ui.clearDirty();
    globalThis.fetch = async (url, init) => {
      requests.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
      return { status: 202, headers: { get: () => null }, text: async () => JSON.stringify({ job: { id: "job-1", type: "restart", status: "running" } }) };
    };
  });

  test("only restart_needed has the button", async () => {
    await i18n.setLanguage("en", { remember: false });
    const root = render(ALL_BANNERS);
    await dom.settle();
    const buttons = dom.find(root, (el) => el.localName === "button");
    assert.equal(buttons.length, 1);
    assert.match(dom.text(buttons[0]), /Restart now/);
    assert.equal(dom.find(bannerOf(root, "restart_needed"), (el) => el.localName === "button").length, 1);
    dom.unmount(root);
  });

  test("a click asks first; cancelling sends nothing; confirming calls RST-1 with confirm: true", async () => {
    await i18n.setLanguage("fr", { remember: false });
    const root = render([ALL_BANNERS[0]]);
    await dom.settle();
    const button = dom.byText(root, "Redémarrer maintenant", "button")[0];
    assert.ok(button, "the label is translated");

    dom.click(button);
    await dom.settle();
    const asked = ui.confirmStore.get().request;
    assert.ok(asked, "the confirmation dialog is raised");
    assert.equal(asked.danger, true);
    assert.equal(asked.title, i18n.t("dashboard.restart_title"));
    ui.resolveConfirm(false);
    await dom.settle();
    assert.deepEqual(requests, [], "cancelled: nothing sent");

    dom.click(button);
    await dom.settle();
    ui.resolveConfirm(true);
    await dom.settle(12);
    assert.deepEqual(requests, [{ url: "/admin/api/restart", method: "POST", body: { confirm: true } }]);
    assert.ok(ui.toastStore.get().items.some((item) => item.message === i18n.t("banners.restart_started")), "the administrator is told the restart began");
    dom.unmount(root);
    await i18n.setLanguage("en", { remember: false });
  });

  test("requestRestart follows the job: a toast when it is done, an error toast when it fails; a refusal is toasted", async () => {
    await i18n.setLanguage("en", { remember: false });
    const listeners = new Set();
    const fakeLive = {
      subscribe: (topic, fn) => {
        assert.equal(topic, "job");
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      watchJob: () => () => {},
    };
    const texts = () => ui.toastStore.get().items.map((item) => item.message);
    ui.toastStore.set({ items: [] });

    let pending = ui.requestRestart({ apiImpl: async () => ({ job: { id: 7 } }), liveImpl: fakeLive });
    await dom.settle(2);
    ui.resolveConfirm(true);
    assert.equal(await pending, true);
    assert.equal(listeners.size, 1);
    for (const fn of listeners) fn({ id: 99, status: "done" }); // another job: ignored
    for (const fn of listeners) fn({ id: 7, status: "running" });
    assert.equal(listeners.size, 1, "still waiting");
    for (const fn of listeners) fn({ id: 7, status: "done" });
    assert.equal(listeners.size, 0, "the subscription ends with the job");
    assert.ok(texts().includes(i18n.t("dashboard.restart_done")));

    ui.toastStore.set({ items: [] });
    pending = ui.requestRestart({ apiImpl: async () => ({ job: { id: 8 } }), liveImpl: fakeLive });
    await dom.settle(2);
    ui.resolveConfirm(true);
    await pending;
    for (const fn of listeners) fn({ id: 8, status: "failed", error: { code: "restart_failed", params: { reason: "timeout" } } });
    assert.ok(texts().includes(i18n.t("dashboard.restart_failed", { reason: i18n.t("dashboard.restart_reason_timeout") })));

    ui.toastStore.set({ items: [] });
    const refused = Object.assign(new Error("busy"), { code: "busy", params: {} });
    pending = ui.requestRestart({ apiImpl: async () => { throw refused; }, liveImpl: fakeLive });
    await dom.settle(2);
    ui.resolveConfirm(true);
    assert.equal(await pending, false);
    assert.equal(listeners.size, 0, "no job to follow");
    assert.ok(texts().includes(i18n.t("errors.busy")));
  });
});

describe("the shell", () => {
  test("the banners sit at the top of the main column, above the page", async () => {
    await i18n.setLanguage("en", { remember: false });
    const route = { name: "dashboard", path: "/", rest: [], query: {} };
    const root = dom.mount(preactHtml`<${layout.Layout} route=${route} state=${{ bot: { status: "open" }, job: null }} banners=${ALL_BANNERS.slice(0, 2)} onLogout=${() => {}}><section id="page">Page</section><//>`);
    await dom.settle();
    const main = dom.find(root, (el) => el.localName === "main")[0];
    assert.ok(main);
    const children = main.childNodes.filter((n) => n.nodeType === 1);
    assert.match(children[0].getAttribute("class"), /\bbanners\b/);
    assert.equal(children[1].getAttribute("id"), "page");
    dom.unmount(root);
  });

  test("the client-side banners reach the login and setup screens: no_https and, before login, undeclared_proxy", async () => {
    const at = (protocol, hostname) => ({ protocol, hostname });
    const plain = ui.collectBanners({ session: { authenticated: false, proxyHint: true }, loc: at("http:", "panel.example.org") });
    assert.deepEqual(plain.map((b) => b.id), ["no_https", "undeclared_proxy"]);
    assert.equal(plain[0].severity, "warn");
    const local = ui.collectBanners({ session: { authenticated: false, proxyHint: false }, loc: at("http:", "localhost") });
    assert.deepEqual(local, []);
    for (const view of ["login", "setup"]) {
      const source = fs.readFileSync(path.join(ROOT, "lib", "admin", "public", "js", "views", `${view}.mjs`), "utf8");
      assert.match(source, /collectBanners\(\{ session, loc: globalThis\.location \}\)/, `${view}.mjs asks for them`);
      assert.match(source, /<\$\{AuthFrame\} banners=\$\{banners\}/, `${view}.mjs hands them to the frame`);
    }
    // the shell does the same once logged in, with the list the server sends
    const app = fs.readFileSync(path.join(ROOT, "lib", "admin", "public", "js", "app.mjs"), "utf8");
    assert.match(app, /collectBanners\(\{ state, session, loc: globalThis\.location \}\)/);
  });
});
