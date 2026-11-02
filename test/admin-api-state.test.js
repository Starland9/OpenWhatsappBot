"use strict";
/**
 * The API page's state routes (feature 004, contracts/admin-api.md sections 1.2, 1.4, 1.5 and 2).
 *
 * Part 1: API-1 `GET /admin/api/api` (shape and sources, no row created by a read) and API-2
 * `PUT /admin/api/api/state` (the switch and the plain-HTTP networks: step-up reasons, confirmation, the cancelled
 * count, `changed: false`, the field errors with indices, the registry failure, audit rows).
 * Part 2: API-3 `GET /admin/api/api/catalog` and API-13 `GET /admin/api/api/openapi` (below).
 *
 * The real createAdmin, authentication, apiState and key store over an in-memory database and a fake clock; the engine
 * and the registries are the recording stand-ins of test/helpers/apiPanelKit.js. Offline.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { bootApiPanel, fakeMessaging } = require("./helpers/apiPanelKit");
const config = require("../config");
const formatsDefault = require("../lib/messaging/formats");

const P = "/admin/api/api";
const MINUTE = 60 * 1000;

let kit;
let tmp = null;
afterEach(async () => {
  if (kit) await kit.close();
  kit = null;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

const boot = async (options) => {
  kit = await bootApiPanel(options);
  return kit;
};
const errorOf = (res) => (res.json && res.json.error) || {};

// ---------------------------------------------------------------------------------------------------------------
// API-1
// ---------------------------------------------------------------------------------------------------------------

describe("API-1 GET /admin/api/api", () => {
  test("the State of a fresh install: switched off, no failure, defaults, no row created", async () => {
    await boot();
    const res = await kit.get(P);
    assert.equal(res.status, 200, res.text);
    const s = res.json;
    assert.deepEqual(Object.keys(s).sort(), [
      "baseUrl", "botReady", "changedAt", "counts", "enabled", "failure", "https", "pausedUntil", "plainHttpFrom", "queued", "settings", "stepUp",
    ]);
    assert.equal(s.enabled, false);
    assert.equal(s.changedAt, null);
    assert.equal(s.failure, null);
    assert.equal(s.queued, 0);
    assert.equal(s.pausedUntil, null);
    assert.equal(s.botReady, true);
    assert.equal(s.https, false);
    assert.equal(s.baseUrl, `http://127.0.0.1:${kit.t.port}/api/v1`);
    assert.deepEqual(s.plainHttpFrom, []);
    assert.deepEqual(s.counts, { active: 0, expired: 0, revoked: 0 });
    assert.equal(await kit.db.ApiState.count(), 0, "a read never creates the ApiState row (absence reads as disabled)");
  });

  test("the effective settings in minutes and days, and the catalog key of each", async () => {
    await boot();
    const { settings } = (await kit.get(P)).json;
    assert.deepEqual(settings.settingKeys, {
      minSpacingMs: "SEND_MIN_SPACING_MS",
      perMinute: "API_RATE_PER_MINUTE",
      perDay: "API_RATE_PER_DAY",
      maxPending: "API_MAX_PENDING",
      queueMax: "API_QUEUE_MAX",
      expiryMin: "API_QUEUE_EXPIRY_MIN",
      retentionDays: "API_RETENTION_DAYS",
      replyWindowDays: "API_REPLY_WINDOW_DAYS",
      alerts: { originBlocked: "ALERT_API_ORIGIN_BLOCKED", keyNewIp: "ALERT_API_KEY_NEW_IP", paused: "ALERT_API_PAUSED" },
    });
    const { settingKeys, ...values } = settings;
    assert.deepEqual(values, {
      minSpacingMs: 2000,
      perMinute: 30,
      perDay: 1000,
      maxPending: 100,
      queueMax: 500,
      expiryMin: 10,
      retentionDays: 30,
      replyWindowDays: 7,
      alerts: { originBlocked: true, keyNewIp: false, paused: true },
    });

    // the values follow the settings store at call time (capture-site rule)
    config.API_RATE_PER_DAY = 77;
    config.ALERT_API_KEY_NEW_IP = true;
    try {
      const again = (await kit.get(P)).json.settings;
      assert.equal(again.perDay, 77);
      assert.equal(again.alerts.keyNewIp, true);
    } finally {
      config.API_RATE_PER_DAY = undefined;
      config.ALERT_API_KEY_NEW_IP = undefined;
    }
  });

  test("queued, pausedUntil and botReady come from the engine; a disconnected bot is reported, not an error", async () => {
    await boot();
    kit.messaging.queued = 4;
    kit.messaging.pausedUntil = kit.clock.now() + 15 * MINUTE;
    kit.messaging.botReady = false;
    const s = (await kit.get(P)).json;
    assert.equal(s.queued, 4);
    assert.equal(s.pausedUntil, new Date(kit.clock.now() + 15 * MINUTE).toISOString());
    assert.equal(s.botReady, false);
  });

  test("the key counts follow the derived status (revoked over expired over active)", async () => {
    await boot();
    await kit.makeKey({ name: "live" });
    await kit.makeKey({ name: "later", expiresAt: new Date(kit.clock.now() + 3600000) });
    await kit.makeKey({ name: "old", expiresAt: new Date(kit.clock.now() - 1000) });
    await kit.makeKey({ name: "gone", revokedAt: new Date(kit.clock.now() - 5000) });
    await kit.makeKey({ name: "gone and old", revokedAt: new Date(kit.clock.now() - 5000), expiresAt: new Date(kit.clock.now() - 1000) });
    assert.deepEqual((await kit.get(P)).json.counts, { active: 2, expired: 1, revoked: 2 });
  });

  test("baseUrl: PANEL_PUBLIC_URL wins, else the request's own origin; a malformed one falls back", async () => {
    await boot();
    kit.t.config.PANEL_PUBLIC_URL = "https://panel.example.org/some/path";
    assert.equal((await kit.get(P)).json.baseUrl, "https://panel.example.org/api/v1");
    kit.t.config.PANEL_PUBLIC_URL = "not a url";
    assert.equal((await kit.get(P)).json.baseUrl, `http://127.0.0.1:${kit.t.port}/api/v1`);
  });

  test("stepUp: the login opened a window, the answer says until when; none once it passed", async () => {
    await boot();
    const first = (await kit.get(P)).json.stepUp;
    assert.equal(first.windowMs, 300000);
    assert.equal(first.confirmedUntil, new Date(kit.clock.now() + 5 * MINUTE).toISOString());
    await kit.expireConfirmation();
    assert.deepEqual((await kit.get(P)).json.stepUp, { confirmedUntil: null, windowMs: 300000 });
    await kit.confirm();
    assert.equal((await kit.get(P)).json.stepUp.confirmedUntil, new Date(kit.clock.now() + 5 * MINUTE).toISOString());
  });

  test("a registry failure is reported as a code and an endpoint, never its reason", async () => {
    await boot({ failure: { endpoint: "messages.create" } });
    const s = (await kit.get(P)).json;
    assert.deepEqual(s.failure, { code: "registry_failed", endpoint: "messages.create" });
    assert.ok(!JSON.stringify(s).includes("must stay in the log"));
  });

  test("the stored switch is reported once API-2 wrote it, with its date", async () => {
    await boot();
    await kit.apiState.setState({ enabled: true, plainHttpFrom: ["10.0.0.0/8"] }, { now: kit.clock.now() });
    const s = (await kit.get(P)).json;
    assert.equal(s.enabled, true);
    assert.deepEqual(s.plainHttpFrom, ["10.0.0.0/8"]);
    assert.equal(s.changedAt, new Date(kit.clock.now()).toISOString());
  });
});

// ---------------------------------------------------------------------------------------------------------------
// API-2
// ---------------------------------------------------------------------------------------------------------------

describe("API-2 PUT /admin/api/api/state", () => {
  const put = (body) => kit.put(`${P}/state`, body);
  const stored = async () => (await kit.db.ApiState.findByPk(1))?.get({ plain: true }) || null;

  test("enabling asks the password through ctx.stepUp(['enable']) and saves nothing without it", async () => {
    await boot();
    await kit.expireConfirmation();
    const before = await kit.snapshot();
    const res = await put({ enabled: true });
    assert.equal(res.status, 403);
    assert.equal(errorOf(res).code, "password_required");
    assert.deepEqual(errorOf(res).params, { windowMs: 300000, reasons: ["enable"] });
    assert.deepEqual(await kit.snapshot(), before, "no row, no audit");
    assert.equal(kit.apiState.isEnabled(), false);
  });

  test("after the confirmation: 200 { enabled, plainHttpFrom, changed, cancelled: 0 }, one api.enable row, the engine listens", async () => {
    await boot();
    await kit.expireConfirmation();
    await kit.confirm();
    const res = await put({ enabled: true });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json, { enabled: true, plainHttpFrom: [], changed: true, cancelled: 0 });
    assert.equal((await stored()).enabled, true);
    assert.equal(kit.apiState.isEnabled(), true, "memory follows the row");
    const audits = await kit.audits("api.");
    assert.deepEqual(audits.map((a) => [a.action, a.target, a.result, a.detail]), [["api.enable", null, "ok", {}]]);
    assert.equal(kit.messaging.calls.disable.length, 0);
  });

  test("the login window is enough: a freshly logged-in owner enables without a second password", async () => {
    await boot();
    const res = await put({ enabled: true });
    assert.equal(res.status, 200, res.text);
  });

  test("disabling needs confirm: true (409 confirmation_required { confirm: 'disable_api' }) and asks no password", async () => {
    await boot();
    await kit.apiState.setState({ enabled: true }, { now: kit.clock.now() });
    await kit.expireConfirmation();
    const before = await kit.snapshot();
    const refused = await put({ enabled: false });
    assert.equal(refused.status, 409);
    assert.equal(errorOf(refused).code, "confirmation_required");
    assert.deepEqual(errorOf(refused).params, { confirm: "disable_api" });
    assert.deepEqual(await kit.snapshot(), before);

    kit.messaging.cancelledOnDisable = 4;
    const res = await put({ enabled: false, confirm: true });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json, { enabled: false, plainHttpFrom: [], changed: true, cancelled: 4 });
    assert.deepEqual(kit.messaging.calls.disable, [{ reason: "api_disabled" }]);
    assert.equal(kit.apiState.isEnabled(), false);
    const audits = await kit.audits("api.");
    assert.deepEqual(audits.map((a) => [a.action, a.detail]), [["api.disable", { cancelled: 4 }]]);
  });

  test("a write that fails after the queue was cancelled restarts the engine: the switch is still on", async () => {
    const real = require("../lib/utils/apiState");
    const failing = {
      get: real.get,
      isEnabled: real.isEnabled,
      setState: async () => {
        throw new Error("disk full");
      },
    };
    await boot({ deps: { apiState: failing } });
    await real.setState({ enabled: true }, { now: kit.clock.now() });
    const res = await put({ enabled: false, confirm: true });
    assert.equal(res.status, 500);
    assert.equal(errorOf(res).code, "internal_error");
    assert.equal(kit.messaging.calls.enable, 1, "the engine was restarted");
    assert.deepEqual(await kit.audits("api."), []);
  });

  test("L3: a disable that fails midway restarts the engine too: the switch stays on, nothing is written or audited", async () => {
    await boot();
    await kit.apiState.setState({ enabled: true }, { now: kit.clock.now() });
    const before = await kit.snapshot();
    kit.messaging.disable = async (opts) => {
      kit.messaging.calls.disable.push(opts);
      throw new Error("database is gone"); // the queue could not be cancelled; the timer and the listener are already off
    };
    const res = await put({ enabled: false, confirm: true });
    assert.equal(res.status, 500);
    assert.equal(errorOf(res).code, "internal_error");
    assert.equal(kit.messaging.calls.enable, 1, "the engine was restarted: it is not left stopped under a switch that is on");
    assert.equal(kit.apiState.isEnabled(), true);
    assert.deepEqual(await kit.snapshot(), before);
    assert.deepEqual(await kit.audits("api."), []);
  });

  test("the same state is changed: false, no write, no audit, no row created, the engine untouched", async () => {
    await boot();
    const off = await put({ enabled: false });
    assert.equal(off.status, 200);
    assert.deepEqual(off.json, { enabled: false, plainHttpFrom: [], changed: false, cancelled: 0 });
    assert.equal(await kit.db.ApiState.count(), 0);

    await kit.apiState.setState({ enabled: true, plainHttpFrom: ["192.168.0.0/16"] }, { now: kit.clock.now() });
    const updatedAt = (await stored()).updatedAt;
    await kit.clock.advance(MINUTE);
    const on = await put({ enabled: true, plainHttpFrom: ["192.168.0.0/16"] });
    assert.deepEqual(on.json, { enabled: true, plainHttpFrom: ["192.168.0.0/16"], changed: false, cancelled: 0 });
    assert.deepEqual((await stored()).updatedAt, updatedAt, "nothing was written");
    assert.deepEqual(await kit.audits("api."), []);
    assert.equal(kit.messaging.calls.disable.length, 0);
  });

  test("a pure plainHttpFrom edit sends the current enabled; absent means unchanged, a present list replaces", async () => {
    await boot();
    await kit.apiState.setState({ enabled: true, plainHttpFrom: ["10.0.0.0/8", "172.16.0.0/12"] }, { now: kit.clock.now() });
    const kept = await put({ enabled: true });
    assert.deepEqual(kept.json.plainHttpFrom, ["10.0.0.0/8", "172.16.0.0/12"]);
    assert.equal(kept.json.changed, false);
    const cleared = await put({ enabled: true, plainHttpFrom: [] });
    assert.deepEqual(cleared.json, { enabled: true, plainHttpFrom: [], changed: true, cancelled: 0 });
  });

  test("a plainHttpFrom widening asks with 'plain_http'; a narrowing, a removal and a reorder do not", async () => {
    await boot();
    await kit.apiState.setState({ enabled: true, plainHttpFrom: ["192.168.0.0/16"] }, { now: kit.clock.now() });
    await kit.expireConfirmation();

    const wide = await put({ enabled: true, plainHttpFrom: ["192.168.0.0/16", "10.0.0.0/8"] });
    assert.equal(wide.status, 403);
    assert.deepEqual(errorOf(wide).params, { windowMs: 300000, reasons: ["plain_http"] });
    assert.deepEqual(kit.apiState.plainHttpFrom(), ["192.168.0.0/16"], "nothing was saved");

    const narrow = await put({ enabled: true, plainHttpFrom: ["192.168.7.0/24"] });
    assert.equal(narrow.status, 200, narrow.text);
    assert.deepEqual(narrow.json.plainHttpFrom, ["192.168.7.0/24"]);
    const none = await put({ enabled: true, plainHttpFrom: [] });
    assert.equal(none.status, 200, none.text);
    assert.deepEqual(await kit.audits("api.plainhttp"), [
      { action: "api.plainhttp.update", target: null, result: "ok", detail: { added: ["192.168.7.0/24"], removed: ["192.168.0.0/16"] }, raw: JSON.stringify({ added: ["192.168.7.0/24"], removed: ["192.168.0.0/16"] }) },
      { action: "api.plainhttp.update", target: null, result: "ok", detail: { added: [], removed: ["192.168.7.0/24"] }, raw: JSON.stringify({ added: [], removed: ["192.168.7.0/24"] }) },
    ]);
  });

  test("the reasons come in the fixed order, enable first", async () => {
    await boot();
    await kit.expireConfirmation();
    const res = await put({ enabled: true, plainHttpFrom: ["100.64.0.0/10"] });
    assert.equal(res.status, 403);
    assert.deepEqual(errorOf(res).params.reasons, ["enable", "plain_http"]);
    await kit.confirm();
    const done = await put({ enabled: true, plainHttpFrom: ["100.64.0.0/10"] });
    assert.equal(done.status, 200);
    assert.deepEqual((await kit.audits("api.")).map((a) => a.action), ["api.enable", "api.plainhttp.update"], "one row per distinct action");
  });

  test("both fields go to the row in one statement and one notification", async () => {
    await boot();
    const seen = [];
    kit.apiState.onChange((change) => seen.push({ enabled: change.enabled, plainHttpFrom: [...change.plainHttpFrom] }));
    const res = await put({ enabled: true, plainHttpFrom: ["10.0.0.0/8"] });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(seen, [{ enabled: true, plainHttpFrom: ["10.0.0.0/8"] }]);
    const row = await stored();
    assert.equal(row.enabled, true);
    assert.deepEqual(row.plainHttpFrom, ["10.0.0.0/8"]);
  });

  test("invalid entries: invalid_format with the indices, not_private with its reason, no value echoed, nothing saved", async () => {
    await boot();
    const before = await kit.snapshot();
    const syntax = await put({ enabled: true, plainHttpFrom: ["10.0.0.0/8", "wat-is-this", "8.8.8.8", "also bad"] });
    assert.equal(syntax.status, 422);
    assert.deepEqual(errorOf(syntax).fields, { plainHttpFrom: { code: "invalid_format", params: { indices: [1, 3] } } });
    assert.ok(!syntax.text.includes("wat-is-this") && !syntax.text.includes("8.8.8.8"));

    const outside = await put({ enabled: true, plainHttpFrom: ["10.0.0.0/8", "8.8.8.8", "127.0.0.1", "0.0.0.0/0", "::/0"] });
    assert.deepEqual(errorOf(outside).fields, { plainHttpFrom: { code: "invalid_format", params: { indices: [1, 2, 3, 4], reason: "not_private" } } });
    assert.deepEqual(await kit.snapshot(), before);
  });

  test("schema: enabled is required, an unknown property and 21 entries are refused", async () => {
    await boot();
    assert.deepEqual(errorOf(await put({})).fields, { enabled: { code: "required" } });
    assert.deepEqual(errorOf(await put({ enabled: "yes" })).fields, { enabled: { code: "invalid_type" } });
    assert.deepEqual(errorOf(await put({ enabled: true, extra: 1 })).fields, { $unknown: { code: "unknown_field" } });
    const many = Array.from({ length: 21 }, (_, i) => `10.0.${i}.0/24`);
    assert.equal(errorOf(await put({ enabled: true, plainHttpFrom: many })).fields.plainHttpFrom.code, "too_many_items");
    assert.equal((await put({ enabled: true, plainHttpFrom: many.slice(0, 20) })).status, 200);
  });

  test("a failed registry refuses to switch on (409 api_disabled { reason: registry_failed, endpoint }) but may switch off", async () => {
    await boot({ failure: { endpoint: "messages.create" } });
    const refused = await put({ enabled: true });
    assert.equal(refused.status, 409);
    assert.equal(errorOf(refused).code, "api_disabled");
    assert.deepEqual(errorOf(refused).params, { reason: "registry_failed", endpoint: "messages.create" });
    assert.equal(await kit.db.ApiState.count(), 0);

    await kit.apiState.setState({ enabled: true }, { now: kit.clock.now() });
    const off = await put({ enabled: false, confirm: true });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.enabled, false);
  });

  test("a refused request writes no audit row (validation, confirmation, step-up)", async () => {
    await boot();
    await put({ enabled: true, plainHttpFrom: ["nope"] });
    await kit.apiState.setState({ enabled: true }, { now: kit.clock.now() });
    await put({ enabled: false });
    await kit.expireConfirmation();
    await put({ enabled: true, plainHttpFrom: ["10.0.0.0/8"] });
    assert.deepEqual(await kit.audits("api."), []);
  });

  test("the route table: PUT /admin/api/api/state is session-authenticated with a conditional step-up", async () => {
    await boot();
    const row = kit.t.admin.routes().find((r) => r.method === "PUT" && r.path === `${P}/state`);
    assert.deepEqual({ auth: row.auth, csrf: row.csrf, stepUp: row.stepUp, mutates: row.mutates }, { auth: "session", csrf: true, stepUp: "conditional", mutates: true });
    const get = kit.t.admin.routes().find((r) => r.method === "GET" && r.path === P);
    assert.deepEqual({ auth: get.auth, csrf: get.csrf, stepUp: get.stepUp }, { auth: "session", csrf: false, stepUp: false });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Part 2: API-3 and API-13
// ---------------------------------------------------------------------------------------------------------------

describe("API-3 GET /admin/api/api/catalog", () => {
  test("Catalog = { version, basePath, rights, formats, endpoints, limits }; the formats are the registry's descriptors, unchanged", async () => {
    await boot();
    const res = await kit.get(`${P}/catalog`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(Object.keys(res.json), ["version", "basePath", "rights", "formats", "endpoints", "limits"]);
    assert.equal(res.json.version, "v1");
    assert.equal(res.json.basePath, "/api/v1");
    assert.deepEqual(res.json.formats, formatsDefault.list().map((row) => JSON.parse(JSON.stringify(formatsDefault.describe(row.name)))), "describe(name) served as it is");
    assert.deepEqual(res.json.rights.map((r) => r.id), kit.api.rights().map((r) => r.id));
    assert.ok(res.json.rights.every((r) => typeof r.group === "string" && "format" in r));
    assert.equal(res.json.endpoints[0].id, "messages.create");
    assert.equal(typeof res.json.endpoints[0].summary, "string");
  });

  test("limits are the fixed numbers of admin-api.md 1.2", async () => {
    await boot();
    assert.deepEqual((await kit.get(`${P}/catalog`)).json.limits, {
      keyNameMax: 64,
      rightsMax: 64,
      recipientsMax: 200,
      ipAllowMax: 50,
      plainHttpFromMax: 20,
      keysMax: 50,
      perMinute: [1, 1000],
      perDay: [1, 100000],
      maxPending: [1, 5000],
    });
  });

  test("while the registry failed rights, formats and endpoints are empty; the limits stay", async () => {
    await boot({ failure: { endpoint: "messages.create" } });
    const catalog = (await kit.get(`${P}/catalog`)).json;
    assert.deepEqual([catalog.rights, catalog.formats, catalog.endpoints], [[], [], []]);
    assert.equal(catalog.limits.keysMax, 50);
  });

  test("a new format module appears in the catalogue, in the rights of a key and in the test send with no edit of the panel (SC-009)", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-demo-registry-"));
    const formatsDir = path.join(tmp, "formats");
    const endpointsDir = path.join(tmp, "endpoints");
    fs.mkdirSync(formatsDir);
    fs.mkdirSync(endpointsDir);
    fs.writeFileSync(path.join(formatsDir, "demo.js"), `"use strict";
module.exports = {
  name: "demo",
  order: 5,
  fields: { note: { type: "string", required: true, maxLength: 20 } },
  build() { return { content: { text: "x" } }; },
  doc: { summary: "Demo", examples: [{ format: "demo", to: "237690000001", note: "hi" }] },
};
`);
    fs.writeFileSync(path.join(endpointsDir, "messages.js"), `"use strict";
module.exports = {
  id: "messages.create",
  method: "POST",
  path: "/api/v1/messages",
  rights: ({ formats }) => formats.rights(),
  requires: (peek, { formats }) => formats.rightsFor(peek.format, peek),
  body: { kinds: ["json"], variants: { by: "format", schemas: ({ formats }) => Object.fromEntries(formats.list().map((row) => [row.name, formats.schemaOf(row.name)])) } },
  idempotent: true,
  doc: { summary: "Send a message (demo endpoint)" },
  handle: async () => ({ status: 202, body: {} }),
};
`);
    const registry = formatsDefault.createRegistry();
    registry.load({ dir: formatsDir });
    const demoFormats = new Proxy(registry, { get: (target, prop) => (prop === "load" ? () => {} : target[prop]) });
    const { createApi } = require("../lib/api");
    const api = createApi({ formats: demoFormats, endpointsDir, models: require("../lib/database") });
    assert.equal(api.state().failure, null, JSON.stringify(api.state()));

    await boot({ api, messaging: fakeMessaging({ formats: demoFormats }) });
    await kit.apiState.setState({ enabled: true }, { now: kit.clock.now() });
    const catalog = (await kit.get(`${P}/catalog`)).json;
    assert.deepEqual(catalog.formats.map((f) => f.name), ["demo"]);
    assert.deepEqual(catalog.formats[0], JSON.parse(JSON.stringify(demoFormats.describe("demo"))));
    assert.deepEqual(catalog.rights, [{ id: "messages.send.demo", group: "send", format: "demo" }]);
    assert.deepEqual(catalog.endpoints.map((e) => [e.id, e.method, e.path, e.dynamic, e.idempotent, e.summary]), [["messages.create", "POST", "/api/v1/messages", true, true, "Send a message (demo endpoint)"]]);

    // a key may be granted its right ...
    const key = await kit.post(`${P}/keys`, { name: "demo key", rights: ["messages.send.demo"], policy: { mode: "list", recipients: [] }, limits: {}, ipAllow: [], expiresAt: null });
    assert.equal(key.status, 201, key.text);
    assert.deepEqual(key.json.key.rights, ["messages.send.demo"]);
    // ... and the test send validates and accepts the new format with the registry's own rules
    const sent = await kit.post(`${P}/test`, { format: "demo", to: "237690000001", note: "hi" });
    assert.equal(sent.status, 202, sent.text);
    assert.equal(sent.json.message.format, "demo");
    const refused = await kit.post(`${P}/test`, { format: "demo", to: "237690000001" });
    assert.deepEqual(JSON.parse(refused.text).error.fields, { note: { code: "required" } });

    // and the OpenAPI document is built from the same registries
    const doc = (await kit.get(`${P}/openapi`)).json;
    assert.ok(doc.paths["/messages"], "the demo endpoint is documented");
  });

  test("a read writes nothing", async () => {
    await boot();
    const before = await kit.snapshot();
    await kit.get(`${P}/catalog`);
    assert.deepEqual(await kit.snapshot(), before);
  });
});

describe("API-13 GET /admin/api/api/openapi", () => {
  test("the document as a download: JSON UTF-8, Content-Disposition attachment with the fixed file name", async () => {
    await boot();
    const res = await kit.get(`${P}/openapi`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="openwhatsappbot-api-v1.openapi.json"');
    assert.equal(res.json.openapi, "3.1.0");
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  test("it works while the API is switched off (the owner reads the documentation before enabling)", async () => {
    await boot();
    assert.equal((await kit.get(P)).json.enabled, false);
    assert.equal((await kit.get(`${P}/openapi`)).status, 200);
  });

  test("servers[0].url equals State.baseUrl, with PANEL_PUBLIC_URL or the request's own origin", async () => {
    await boot();
    for (const publicUrl of ["", "https://panel.example.org"]) {
      kit.t.config.PANEL_PUBLIC_URL = publicUrl;
      const state = (await kit.get(P)).json;
      const doc = (await kit.get(`${P}/openapi`)).json;
      assert.equal(doc.servers[0].url, state.baseUrl);
    }
    assert.equal((await kit.get(`${P}/openapi`)).json.servers[0].url, "https://panel.example.org/api/v1");
  });

  test("the document is English and the real builder's: it is produced by lib/api (api.openapi) from the registries", async () => {
    const { createApi } = require("../lib/api");
    const api = createApi({ models: require("../lib/database") });
    await boot({ api });
    const res = await kit.get(`${P}/openapi`);
    assert.equal(res.status, 200, res.text);
    assert.match(res.json.info.title, /^[\x20-\x7e]+$/);
    assert.equal(res.json.info.version, "1.0.0");
    assert.ok(res.json.components && res.json.components.schemas.Error);
  });

  test("409 api_disabled { reason: 'registry_failed' } when the registry failed: there is nothing to describe", async () => {
    await boot({ failure: { endpoint: "messages.create" } });
    const res = await kit.get(`${P}/openapi`);
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, "api_disabled");
    assert.deepEqual(res.json.error.params, { reason: "registry_failed", endpoint: "messages.create" });
  });

  test("a read writes nothing", async () => {
    await boot();
    const before = await kit.snapshot();
    await kit.get(`${P}/openapi`);
    assert.deepEqual(await kit.snapshot(), before);
  });
});
