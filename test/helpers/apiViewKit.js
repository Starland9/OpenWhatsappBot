"use strict";
/**
 * Shared set-up and fixtures of the API-area view tests (feature 004, tasks T054 to T142): the fake DOM with the panel
 * catalogs overlaid with the two 004 fragments, the REAL format descriptors of the registry, and builders for the answers
 * of API-1 to API-13. Every view test uses it with the render guards of test/helpers/viewGuard.js.
 *
 *   const kit = await boot();                          dom, i18n, ui, reauth, html, modules
 *   const t = kit.mountApi({ routes, route });         mounts ApiView + the reauth host under a guard
 *   await t.settle(); t.done();                        done() unmounts, asserts the guard is clean, restores fetch
 */

const fs = require("fs");
const path = require("path");
const { createDom, importPublic } = require("./fakeDom");
const { createViewGuard, answer } = require("./viewGuard");

const ROOT = path.resolve(__dirname, "..", "..");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const FRAGMENT_DIR = path.join(ROOT, "specs", "004-messaging-api", "i18n");

/** The panel catalog of a language with the 004 fragments overlaid (so a file runs before the merge). */
function catalogOf(lang) {
  const base = readJson(path.join(ROOT, "lib", "admin", "public", "i18n", `${lang}.json`));
  for (const name of ["panel-api.json", "panel-api-server.json"]) {
    const file = path.join(FRAGMENT_DIR, name);
    if (fs.existsSync(file)) Object.assign(base, readJson(file)[lang]);
  }
  return base;
}

/** The descriptors of the real registry, in their order. */
function realFormats() {
  const registry = require("../../lib/messaging/formats");
  return registry.list().map((entry) => registry.describe(typeof entry === "string" ? entry : entry.name));
}

const GROUPS = { text: "send" };
function realRights(formats) {
  return [
    ...formats.map((format) => ({ id: format.right, group: "send", format: format.name })),
    { id: "messages.read", group: "read", format: null },
    { id: "media.url", group: "media", format: null },
    { id: "api.docs", group: "docs", format: null },
  ];
}

const ENDPOINTS = [
  { id: "messages.create", method: "POST", path: "/api/v1/messages", rights: realRights(realFormats()).filter((r) => r.group === "send").map((r) => r.id), dynamic: false, idempotent: true, summary: "Send a message.", body: { kinds: ["json", "multipart"], limitBytes: 1048576 } },
  { id: "messages.get", method: "GET", path: "/api/v1/messages/:id", rights: ["messages.read"], dynamic: true, idempotent: false, summary: "Read a message.", body: { kinds: [], limitBytes: null } },
  { id: "openapi.json", method: "GET", path: "/api/v1/openapi.json", rights: ["api.docs"], dynamic: false, idempotent: false, summary: "The OpenAPI document.", body: { kinds: [], limitBytes: null } },
];

function makeCatalog(over = {}) {
  const formats = over.formats || realFormats();
  return {
    version: "v1",
    basePath: "/api/v1",
    rights: realRights(formats),
    formats,
    endpoints: ENDPOINTS,
    limits: { keyNameMax: 64, rightsMax: 64, recipientsMax: 200, ipAllowMax: 50, plainHttpFromMax: 20, keysMax: 50, perMinute: [1, 1000], perDay: [1, 100000], maxPending: [1, 5000] },
    ...over,
  };
}

function makeState(over = {}) {
  return {
    enabled: true,
    changedAt: "2026-11-01T10:00:00.000Z",
    failure: null,
    queued: 0,
    pausedUntil: null,
    botReady: true,
    https: true,
    baseUrl: "https://bot.example.org/api/v1",
    plainHttpFrom: [],
    stepUp: { confirmedUntil: null, windowMs: 300000 },
    counts: { active: 1, expired: 0, revoked: 0 },
    settings: {
      minSpacingMs: 2000, perMinute: 30, perDay: 1000, maxPending: 100, queueMax: 500, expiryMin: 10, retentionDays: 30, replyWindowDays: 7,
      alerts: { originBlocked: true, keyNewIp: false, paused: true },
      settingKeys: { minSpacingMs: "SEND_MIN_SPACING_MS", perMinute: "API_RATE_PER_MINUTE", perDay: "API_RATE_PER_DAY", maxPending: "API_MAX_PENDING", queueMax: "API_QUEUE_MAX", expiryMin: "API_QUEUE_EXPIRY_MIN", retentionDays: "API_RETENTION_DAYS", replyWindowDays: "API_REPLY_WINDOW_DAYS", alerts: { originBlocked: "ALERT_API_ORIGIN_BLOCKED", keyNewIp: "ALERT_API_KEY_NEW_IP", paused: "ALERT_API_PAUSED" } },
    },
    ...over,
  };
}

const FAR = "2099-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

function makeKey(id, over = {}) {
  return {
    id,
    name: `key ${id}`,
    last4: "x9Qa",
    status: "active",
    createdAt: "2026-11-01T09:00:00.000Z",
    updatedAt: "2026-11-01T09:00:00.000Z",
    revokedAt: null,
    expiresAt: null,
    version: 1,
    lastUsedAt: null,
    lastUsedIp: null,
    seenIpCount: 0,
    rights: ["messages.send.text"],
    orphanRights: [],
    policy: { mode: "list", recipients: [{ jid: "237690000001@s.whatsapp.net", name: "Ada" }] },
    limits: { perMinute: null, perDay: 500, maxPending: null },
    ipAllow: [],
    queued: 0,
    ...over,
  };
}

const ok = (body, status = 200) => answer(status, body);
const fail = (status, code, extra = {}) => answer(status, { error: { code, requestId: "r1", ...extra } });

/** The three calls ApiView makes on mount, plus whatever `extra` adds. Handlers read the live `data` object, so a test can change it. */
function baseRoutes(data, extra = {}) {
  return {
    "GET /admin/api/api": () => ok(data.state),
    "GET /admin/api/api/catalog": () => ok(data.catalog),
    "GET /admin/api/api/keys": () => ok({ items: data.keys }),
    ...extra,
  };
}

async function boot() {
  const dom = await createDom();
  const i18n = await importPublic("js/i18n.mjs");
  for (const lang of ["en", "fr"]) i18n.setCatalog(lang, catalogOf(lang));
  await i18n.setLanguage("en", { remember: false });
  const ui = await importPublic("js/ui.mjs");
  const reauth = await importPublic("js/reauth.mjs");
  const components = await importPublic("js/components/index.mjs");
  const apiModule = await importPublic("js/api.mjs");
  const view = await importPublic("js/views/api.mjs");
  const { html, Fragment } = components;

  /** Wait until `condition()` holds, one event-loop turn at a time, at most `turns` of them. */
  async function until(condition, turns = 12) {
    for (let i = 0; i < turns; i += 1) {
      if (condition()) return true;
      await dom.settle(1);
    }
    return Boolean(condition());
  }

  /** Mount a vnode under a guard; `done()` unmounts, asserts the guard is clean and restores fetch. */
  function mount(vnode, routes, options = {}) {
    const guard = createViewGuard({ preact: dom.preact, ...options });
    globalThis.fetch = guard.fetch(routes);
    const root = dom.mount(html`<${Fragment}>${vnode}<${components.ReauthDialog} /><//>`);
    const done = () => {
      try {
        dom.unmount(root);
        guard.assertClean();
      } finally {
        guard.restore();
        delete globalThis.fetch;
        reauth.forgetConfirmation();
        if (reauth.reauthStore.get().request) reauth.resolveReauth(false);
        if (ui.confirmStore.get().request) ui.resolveConfirm(false);
        ui.clearDirty();
      }
    };
    const find = {
      button: (text) => dom.byText(root, text, "button")[0],
      input: (name) => dom.byAttr(root, "name", name, "input")[0],
      has: (text) => dom.text(root).includes(text),
    };
    return { root, guard, done, until, find, settle: (n = 4) => dom.settle(n) };
  }

  function mountApi({ data, routes = {}, route = { name: "api", rest: [], query: {} } }) {
    return mount(html`<${view.default} route=${route} />`, baseRoutes(data, routes));
  }

  /** Answer the confirmation dialog that is (or is about to be) open; returns its request. */
  async function answerConfirm(accept) {
    await until(() => ui.confirmStore.get().request);
    const { request } = ui.confirmStore.get();
    ui.resolveConfirm(accept);
    return request;
  }

  return { dom, i18n, ui, reauth, components, apiModule, view, html, Fragment, mount, mountApi, until, answerConfirm, preact: dom.preact };
}

module.exports = { boot, catalogOf, realFormats, makeCatalog, makeState, makeKey, baseRoutes, ok, fail, answer, FAR, PAST, ENDPOINTS, GROUPS };
