"use strict";
/**
 * Kit of the panel's API page tests (feature 004, H-PANEL): the real `createAdmin` of test/helpers/adminHarness.js
 * (real authentication, in-memory database, fake clock, very low scrypt cost) with the engines of the API page
 * replaced by recording stand-ins, and the real `apiState`, key store, IP grammar and format registry.
 *
 *   const kit = await bootApiPanel({ failure, rights, messaging, api, enabled, setup });
 *   kit.t / kit.client / kit.db / kit.clock / kit.messaging / kit.api / kit.keyStore / kit.apiState
 *   await kit.confirm()                    the owner types the password again (AUTH-7): the step-up window opens
 *   await kit.expireConfirmation()         move the clock past the 5-minute window (the login started one)
 *   await kit.makeKey(over)                an ApiKey row written directly (the secret is returned, never stored)
 *   await kit.get(path) / put / post       the guarded calls of the logged-in client
 *   await kit.rows(model, where)           plain rows of a table
 *   await kit.audits(prefix)               the AuditLog rows whose action starts with `prefix`
 *   await kit.snapshot()                   the four Api tables and the audit log as JSON text (a refused call changes none;
 *                                          the session table is left out: every request touches its idle clock)
 *   await kit.close()
 *
 * The clock starts on 2026-01-15 so the instants of test/fixtures/api-widenings.json (2026-06-30, 2026-12-31,
 * 2027-06-30 in the future, 2020-01-01 in the past) keep their meaning.
 *
 * `fakeMessaging()` records every call and implements the accept path of lib/messaging/index.js with the REAL format
 * registry (so the dotted field errors are the engine's) and an `ApiMessage` row per accepted send. `fakeApi()` is the
 * public API object the panel reads (`state()`, `catalog()`, `openapi()`, `keys`, `ipRules`) over the same registry.
 */

const crypto = require("node:crypto");
const fakes = require("./fakes");
const { createClock } = require("./fakeClock");
const { createTestAdmin } = require("./adminHarness");

const PASSWORD = "correct horse battery";
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
const TABLES = ["ApiMessageResponse", "ApiMessage", "ApiKey", "ApiState", "KnownChat", "AuditLog"];
const DEFAULT_RIGHTS = [
  "messages.send.text",
  "messages.send.image",
  "messages.send.video",
  "messages.send.poll",
  "messages.read",
  "media.upload",
];

/** group of a right id, as lib/api/registry.js groups them */
const groupOf = (id) => (id.startsWith("messages.send.") ? "send" : id === "messages.read" ? "read" : id.split(".")[0]);

function fakeMessaging(options = {}) {
  const formats = options.formats || require("../../lib/messaging/formats");
  const { MessagingError } = require("../../lib/messaging/errors");
  const recipients = require("../../lib/messaging/recipients");
  const m = {
    calls: { disable: [], enable: 0, cancelForKey: [], submit: [], resolveRecipient: [], validateInput: [], inspectMedia: [], fetchMedia: [], describeResponses: [] },
    queued: 0,
    pausedUntil: null,
    botReady: true,
    cancelledOnDisable: 0,
    cancelledForKey: 0,
    cancelThrows: false,
    refuse: {}, // { resolveRecipient, inspectMedia, fetchMedia, submit }: a function (or an error) the call throws
    quotable: new Set(), // public ids of earlier panel messages a `quote` may point to
    responses: null, // what describeResponses answers (a function of (row, answers) or a value)
    formats,
  };

  const maybeRefuse = (name) => {
    const hook = m.refuse[name];
    if (!hook) return;
    throw typeof hook === "function" ? hook() : hook;
  };

  m.stats = async () => ({ enabled: true, running: false, queued: m.queued, sending: 0, pausedUntil: m.pausedUntil, lastSendAt: null, botReady: m.botReady });
  m.disable = async (opts) => {
    m.calls.disable.push(opts);
    return { cancelled: m.cancelledOnDisable };
  };
  m.enable = () => {
    m.calls.enable += 1;
  };
  m.cancelForKey = async (id, reason) => {
    m.calls.cancelForKey.push({ id, reason });
    if (m.cancelThrows) throw new Error("engine down");
    return m.cancelledForKey;
  };
  m.resolveRecipient = async (to, opts) => {
    m.calls.resolveRecipient.push({ to, opts });
    maybeRefuse("resolveRecipient");
    const parsed = recipients.parseRecipient(to);
    if (parsed.error) throw new MessagingError("validation_failed", { fields: { to: { code: parsed.error } } });
    return { jid: parsed.jid, kind: parsed.kind, number: parsed.number || null };
  };
  m.validateInput = async (name, body, opts = {}) => {
    m.calls.validateInput.push({ name, body, opts });
    const checked = formats.checkInput(name, body, { target: opts.target });
    const fields = { ...checked.fields };
    const quote = checked.value && typeof checked.value.quote === "string" && checked.value.quote ? checked.value.quote : null;
    if (quote && !fields.quote && opts.target && !m.quotable.has(quote)) fields.quote = { code: "not_found" };
    if (Object.keys(fields).length) throw new MessagingError("validation_failed", { fields });
    return { format: checked.value.format, to: checked.value.to, quote, mediaMarker: checked.mediaMarker, fields: checked.own, quoteRef: null };
  };
  m.inspectMedia = async (name, file, opts) => {
    m.calls.inspectMedia.push({ name, file, opts });
    maybeRefuse("inspectMedia");
    return { kind: "image", mime: "image/png", ext: "png", size: file.size };
  };
  m.fetchMedia = async (name, url, opts) => {
    m.calls.fetchMedia.push({ name, url, opts });
    maybeRefuse("fetchMedia");
    if (!options.fetched) throw new Error("fetchMedia: give the kit a `fetched` file");
    return options.fetched();
  };
  m.submit = async (request) => {
    m.calls.submit.push(request);
    maybeRefuse("submit");
    // the real submit detects the type again and applies the cap, as the public pipeline asked inspectMedia before it
    if (request.media) await m.inspectMedia(request.format, request.media, { name: request.media.name });
    const { ApiMessage } = require("../../lib/database");
    const target = recipients.parseRecipient(request.to);
    const publicId = `msg_${crypto.randomBytes(16).toString("base64url")}`;
    const at = new Date(request.now);
    await ApiMessage.create({
      publicId,
      apiKeyId: request.apiKeyId,
      source: request.source,
      recipient: target.jid,
      format: request.format,
      size: request.media ? request.media.size : null,
      status: "queued",
      requestId: request.requestId,
      acceptedAt: at,
      expiresAt: new Date(request.now + 600000),
    });
    return { message: { publicId, status: "queued", source: request.source, recipient: target.jid }, replayed: false, requestHash: null };
  };
  m.describeResponses = async (row, answers) => {
    m.calls.describeResponses.push({ row, answers });
    return typeof m.responses === "function" ? m.responses(row, answers) : m.responses;
  };
  return m;
}

/** The public API object the panel reads, over the real format registry and a real key store */
function fakeApi({ keyStore, failure = null, rights = DEFAULT_RIGHTS, formats, endpoints, openapi } = {}) {
  const registry = formats || require("../../lib/messaging/formats");
  const ipRules = require("../../lib/api/ipRules");
  const api = {
    failure,
    rights: () => rights.map((id) => ({ id, group: groupOf(id), format: id.startsWith("messages.send.") ? id.slice(14) : null })),
    state: () => ({ loaded: !api.failure, failure: api.failure ? { code: "registry_failed", endpoint: api.failure.endpoint ?? null, reason: "a reason that must stay in the log" } : null, version: "v1" }),
    catalog: () => ({
      version: "v1",
      basePath: "/api/v1",
      rights: api.rights(),
      formats: registry.list().map((row) => registry.describe(row.name)),
      endpoints: endpoints || [
        { id: "messages.create", method: "POST", path: "/api/v1/messages", rights: rights.filter((id) => id.startsWith("messages.send.")), dynamic: true, idempotent: true, summary: "Send a message", body: { kinds: ["json", "multipart"], limitBytes: 65536 } },
      ],
    }),
    openapi: ({ baseUrl } = {}) => (openapi ? openapi({ baseUrl }) : { openapi: "3.1.0", info: { title: "OpenWhatsappBot API", version: "1.0.0" }, servers: [{ url: `${baseUrl || ""}/api/v1` }], paths: {} }),
    keys: keyStore,
    ipRules,
    handle: () => false,
    start: async () => {},
    stop: async () => {},
  };
  return api;
}

async function clearTables(db) {
  for (const name of TABLES) if (db[name]) await db[name].destroy({ where: {}, truncate: true });
  require("../../lib/utils/settingsCache").clear();
}

/**
 * @param {object} [options]
 * @param {object|null} [options.failure]    registry failure `{ endpoint }`
 * @param {string[]} [options.rights]        the right ids of the catalogue
 * @param {object} [options.messaging]       replaces fakeMessaging()
 * @param {object} [options.api]             replaces fakeApi()
 * @param {object} [options.deps]            anything else for createAdmin
 * @param {object} [options.config]          settings handed to createAdmin
 * @param {object} [options.setup]           fakes.setupEnv options of the harness
 * @param {Function} [options.fetched]       what the fake engine's fetchMedia returns
 */
async function bootApiPanel(options = {}) {
  const config = require("../../config");
  config.ADMIN_PANEL = true; // setupEnv turns the panel off; the switch tests need it on
  const db = await fakes.syncDb();
  await clearTables(db);
  const apiState = require("../../lib/utils/apiState");
  await apiState.load({ models: db });
  const { createKeyStore } = require("../../lib/api/keyStore");
  const clock = createClock(T0);
  const keyStore = createKeyStore({ models: db, now: () => clock.now() });
  const messaging = options.messaging || fakeMessaging({ fetched: options.fetched });
  const api = options.api || fakeApi({ keyStore, failure: options.failure || null, rights: options.rights });

  const t = await createTestAdmin({
    clock,
    setup: options.setup,
    config: { ADMIN_PANEL: true, ...(options.config || {}) },
    deps: { createApi: () => api, messaging, apiState, ...(options.deps || {}) },
  });
  await t.admin.start();
  const client = await t.loginClient(PASSWORD);

  const call = (method) => (path, body, extra) => client.api(method, path, body, extra);
  const kit = {
    t,
    client,
    db: t.db,
    clock,
    messaging,
    api,
    keyStore,
    apiState,
    PASSWORD,

    get: (path, extra) => client.get(path, extra),
    put: call("PUT"),
    post: call("POST"),
    del: call("DELETE"),

    /** The id uploads and the step-up are keyed by, for the logged-in client */
    async sessionId() {
      return (await t.auth.sessions.resolve(client.cookie("owb_sid"))).id;
    },

    /** AUTH-7: the owner types the password again */
    async confirm(password = PASSWORD) {
      const res = await client.api("POST", "/admin/api/session/reauth", { password });
      if (res.status !== 200) throw new Error(`reauth refused: ${res.status} ${res.text}`);
      return res;
    },
    /** The login started a 5-minute window: move past it so the next widening asks for the password */
    async expireConfirmation() {
      await clock.advance(5 * 60 * 1000 + 1000);
    },

    async makeKey(over = {}) {
      const generated = keyStore.generateSecret();
      const name = over.name || `Key ${generated.lookupId.slice(0, 6)}`;
      const row = await t.db.ApiKey.create({
        name,
        nameKey: over.revokedAt ? null : name.toLowerCase(),
        lookupId: generated.lookupId,
        secretHash: generated.secretHash,
        last4: generated.last4,
        rights: ["messages.send.text"],
        policyMode: "list",
        recipients: ["237690000001@s.whatsapp.net"],
        ipAllow: [],
        version: 1,
        ...over,
        ...(over.revokedAt ? { nameKey: null } : {}),
      });
      return { row, id: row.id, secret: generated.secret, lookupId: generated.lookupId };
    },

    /** A message row written directly (an API message without `apiKeyId` belongs to a key made on demand) */
    async makeMessage(over = {}) {
      let apiKeyId = null;
      if (over.source !== "panel") {
        if (over.apiKeyId !== undefined && over.apiKeyId !== null) apiKeyId = over.apiKeyId;
        else {
          if (!kit.defaultKey) kit.defaultKey = await kit.makeKey({ name: "Default key" });
          apiKeyId = kit.defaultKey.id;
        }
      }
      const row = await t.db.ApiMessage.create({
        publicId: `msg_${crypto.randomBytes(16).toString("base64url")}`,
        apiKeyId,
        source: "api",
        recipient: "237690000001@s.whatsapp.net",
        format: "text",
        status: "sent",
        acceptedAt: new Date(clock.now()),
        expiresAt: new Date(clock.now() + 600000),
        ...over,
        apiKeyId,
      });
      return row;
    },

    async rows(model, where = {}) {
      return (await t.db[model].findAll({ where, order: [["id", "ASC"]] })).map((row) => row.get({ plain: true }));
    },
    async snapshot() {
      const out = {};
      for (const name of ["ApiKey", "ApiMessage", "ApiMessageResponse", "ApiState", "AuditLog"]) {
        out[name] = (await t.db[name].findAll({ raw: true })).map((row) => JSON.stringify(row)).sort();
      }
      return out;
    },
    async audits(prefix = "") {
      return (await t.db.AuditLog.findAll({ order: [["id", "ASC"]] }))
        .filter((row) => row.action.startsWith(prefix))
        .map((row) => ({ action: row.action, target: row.target, result: row.result, detail: row.detail ? JSON.parse(row.detail) : null, raw: row.detail }));
    },

    async close() {
      await t.close();
      config.ADMIN_PANEL = undefined; // drop the runtime assignment
    },
  };
  return kit;
}

module.exports = { bootApiPanel, fakeMessaging, fakeApi, PASSWORD, T0, DEFAULT_RIGHTS, clearTables };
