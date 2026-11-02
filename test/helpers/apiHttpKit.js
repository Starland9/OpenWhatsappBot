"use strict";
/**
 * Raw HTTP kit around `createApi` with fake dependencies (feature 004, D-HTTP; tasks T040). The helper the later API
 * harness builds upon. Nothing here touches the network beyond 127.0.0.1:0, the real `data/` or a phone.
 *
 *   const kit = await createApiKit(options);
 *   kit.request(path, { method, token, headers, json, body, contentType, remote, https })  -> { status, headers, json, text, raw }
 *   kit.get(path, token, opts) / kit.post(path, token, json, opts)
 *   kit.makeKey({ name, rights, policyMode, recipients, ipAllow, expiresAt, revokedAt, limitPerMinute... }) -> { token, row, id }
 *   kit.api         the real createApi() result      kit.engine   the fake messaging engine (records its calls)
 *   kit.clock       fake clock (limiter, quotas)     kit.alerts / kit.audit   recorders       kit.config   mutable settings
 *   kit.apiState    { enabled, plain }               kit.runtime / kit.maintenance            switches
 *   kit.db          real models on an in-memory SQLite database
 *   kit.legacy      what the stand-in legacy handler answers for a URL the API does not claim
 *   kit.close()
 *
 * The server stands for lib/admin/server.js: `api.handle(req, res)` first, else the legacy answer (200 text/html), so a
 * test can compare an unclaimed URL byte for byte. Every connection is loopback, which is the "local request"
 * exception; the kit sets PANEL_TRUST_PROXY=loopback, so a test builds a REMOTE caller with `remote: "203.0.113.9"`
 * (X-Forwarded-For plus X-Forwarded-Proto: https unless `https: false`), exactly like a reverse proxy would.
 *
 * Endpoint modules are test fixtures written in a temporary directory (`FIXTURES`, or `options.endpoints` = { file:
 * source }); the formats are a small fake registry (`text`, `image`, `document`) so the real one is not needed.
 */

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const kitDb = require("./backupKit");
const { createClock } = require("./fakeClock");
const { createApi } = require("../../lib/api");
const { createKeyStore } = require("../../lib/api/keyStore");
const { createUploader } = require("../../lib/api/upload");
const SettingsCache = require("../../lib/utils/settingsCache").constructor;
const schema = require("../../lib/utils/schema");
const { MessagingError } = require("../../lib/messaging/errors");

const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);
const OWN_NUMBER = "237690009999";
const MSG_ID = /^msg_[A-Za-z0-9_-]{22}$/;

// ---- fake formats ----------------------------------------------------------------------------------------------
const COMMON = (name) => ({
  format: { type: "string", required: true, enum: [name] },
  to: { type: "string", required: true, trim: true, minLength: 1, maxLength: 64 },
  quote: { type: "string", pattern: MSG_ID },
});
const MEDIA = { type: "object", shape: { url: { type: "string", required: true, minLength: 1, maxLength: 2048 } } };
const FORMAT_DEFS = {
  text: { order: 10, media: null, fields: { text: { type: "string", required: true, minLength: 1, maxLength: 4096 }, linkPreview: { type: "boolean" } } },
  image: { order: 20, media: { kinds: ["image"], maxBytes: 1024 * 1024 }, fields: { caption: { type: "string", minLength: 1, maxLength: 1024 }, media: MEDIA } },
  document: { order: 70, media: { kinds: ["document"], maxBytes: 4 * 1024 * 1024 }, fields: { caption: { type: "string", minLength: 1, maxLength: 1024 }, fileName: { type: "string", minLength: 1, maxLength: 255 }, media: MEDIA } },
};

const fakeFormats = {
  loaded: false,
  load() {
    fakeFormats.loaded = true;
  },
  list: () => Object.entries(FORMAT_DEFS).map(([name, def]) => ({ name, order: def.order, right: `messages.send.${name}`, interactive: false, media: Boolean(def.media) })),
  rights: () => Object.keys(FORMAT_DEFS).map((name) => `messages.send.${name}`),
  get: (name) => (Object.hasOwn(FORMAT_DEFS, name) ? { name, ...FORMAT_DEFS[name] } : null),
  schemaOf: (name) => ({ ...COMMON(name), ...FORMAT_DEFS[name].fields }),
  rightsFor: (name, input) => [`messages.send.${name}`, ...(input && input.media && input.media.url ? ["media.url"] : [])],
  describe: (name) => ({ name, right: `messages.send.${name}` }),
};

// ---- a stand-in for lib/messaging/sniff.js: PNG and PDF by their signature, everything else undecided ------------------
const fakeSniff = {
  classifyHead: async (buffer) => {
    const head = buffer.subarray(0, 5).toString("latin1");
    if (buffer[0] === 0x89 && head.slice(1, 4) === "PNG") return { mime: "image/png", ext: "png" };
    if (head.startsWith("%PDF-")) return { mime: "application/pdf", ext: "pdf" };
    return null;
  },
  accepts: (kinds, detected) =>
    kinds.some((kind) => (kind === "image" && detected.mime.startsWith("image/")) || (kind === "document" && detected.mime === "application/pdf")),
};

// ---- fixture endpoints (what F-PUB's four modules look like to the pipeline) ----------------------------------------
const FIXTURES = {
  "create.js": `"use strict";
const { reply } = require(${JSON.stringify(path.join(__dirname, "..", "..", "lib", "admin", "http", "response.js"))});
module.exports = {
  id: "messages.create",
  method: "POST",
  path: "/api/v1/messages",
  rights: ({ formats }) => [...formats.rights(), "media.url"],
  requires: (peek, { formats }) => formats.rightsFor(peek.format, peek),
  query: { wait: { type: "int", min: 0, max: 30, default: 0 } },
  body: {
    kinds: ["json", "multipart"],
    limit: 65536,
    variants: { by: "format", schemas: ({ formats }) => Object.fromEntries(formats.list().map((f) => [f.name, formats.schemaOf(f.name)])) },
    file: {
      part: "file",
      maxBytes: (peek, { formats }) => formats.get(peek.format).media ? formats.get(peek.format).media.maxBytes : 0,
      accept: (peek, { formats }) => { const media = formats.get(peek.format).media; return media ? { kinds: media.kinds } : null; },
    },
  },
  recipient: (peek) => peek.to,
  idempotent: true,
  quota: { messages: true },
  doc: { summary: "Send one message" },
  async handle(ctx) {
    if (ctx.idempotency && ctx.idempotency.replay) {
      return reply(202, { message: ctx.idempotency.replay }, { Location: "/api/v1/messages/" + ctx.idempotency.replay.id, "Idempotent-Replayed": "true" });
    }
    const target = await ctx.services.messaging.resolveRecipient(ctx.body.to, {});
    const result = await ctx.services.messaging.submit({
      source: "api",
      apiKeyId: ctx.key.id,
      requestId: ctx.requestId,
      format: ctx.body.format,
      to: target.jid,
      quote: ctx.body.quote || null,
      fields: ctx.body.fields,
      media: ctx.file ? { path: ctx.file.path, size: ctx.file.size, name: ctx.file.name, sha256: ctx.file.sha256 } : null,
      idempotency: ctx.idempotency ? { key: ctx.idempotency.key, requestHash: ctx.idempotency.requestHash } : null,
    });
    const headers = { Location: "/api/v1/messages/" + result.message.id };
    if (result.replayed) headers["Idempotent-Replayed"] = "true";
    return reply(202, { message: result.message }, headers);
  },
};
`,
  "get.js": `"use strict";
const { reply } = require(${JSON.stringify(path.join(__dirname, "..", "..", "lib", "admin", "http", "response.js"))});
const { ApiError } = require(${JSON.stringify(path.join(__dirname, "..", "..", "lib", "api", "errors.js"))});
module.exports = {
  id: "messages.get",
  method: "GET",
  path: "/api/v1/messages/:id",
  params: { id: /^msg_[A-Za-z0-9_-]{22}$/ },
  right: "messages.read",
  doc: { summary: "Status of one message" },
  async handle(ctx) {
    const message = await ctx.services.messaging.get({ apiKeyId: ctx.key.id, publicId: ctx.params.id });
    if (!message) throw new ApiError("not_found");
    return reply(200, { message });
  },
};
`,
  "list.js": `"use strict";
const { reply } = require(${JSON.stringify(path.join(__dirname, "..", "..", "lib", "admin", "http", "response.js"))});
module.exports = {
  id: "messages.list",
  method: "GET",
  path: "/api/v1/messages",
  right: "messages.read",
  query: { limit: { type: "int", min: 1, max: 100, default: 25 }, status: { type: "string", maxLength: 16 } },
  doc: { summary: "Own messages" },
  async handle(ctx) {
    return reply(200, { messages: [], next: null, query: ctx.query });
  },
};
`,
  "docs.js": `"use strict";
const { reply } = require(${JSON.stringify(path.join(__dirname, "..", "..", "lib", "admin", "http", "response.js"))});
module.exports = {
  id: "openapi.get",
  method: "GET",
  path: "/api/v1/openapi.json",
  right: "api.docs",
  doc: { summary: "OpenAPI document" },
  async handle() {
    return reply(200, { openapi: "3.1.0" });
  },
};
`,
  "echo.js": `"use strict";
const { reply } = require(${JSON.stringify(path.join(__dirname, "..", "..", "lib", "admin", "http", "response.js"))});
module.exports = {
  id: "echo.post",
  method: "POST",
  path: "/api/v1/echo",
  right: "echo.write",
  body: { kinds: ["json"], limit: 1024, schema: { a: { type: "string", maxLength: 8 } } },
  doc: { summary: "Echo" },
  async handle(ctx) {
    return reply(200, { body: ctx.body });
  },
};
`,
  "probe.js": `"use strict";
const { reply } = require(${JSON.stringify(path.join(__dirname, "..", "..", "lib", "admin", "http", "response.js"))});
module.exports = {
  id: "probe.get",
  method: "GET",
  path: "/api/v1/probe",
  right: "probe.read",
  doc: { summary: "What a handler sees" },
  async handle(ctx) {
    return reply(200, {
      keyFields: Object.keys(ctx.key),
      keyFrozen: Object.isFrozen(ctx.key),
      servicesFrozen: Object.isFrozen(ctx.services),
      ctxFields: Object.keys(ctx).sort(),
      keyText: JSON.stringify(ctx.key),
    });
  },
};
`,
  "bad.js": `"use strict";
module.exports = {
  id: "bad.post",
  method: "POST",
  path: "/api/v1/bad",
  rights: () => ["bad.write"],
  requires: () => ["bad.other"],
  body: { kinds: ["json"], schema: {} },
  doc: { summary: "requires() outside rights()" },
  async handle() {
    return { status: 200, body: {} };
  },
};
`,
  "boom.js": `"use strict";
module.exports = {
  id: "boom.get",
  method: "GET",
  path: "/api/v1/boom",
  right: "boom.read",
  doc: { summary: "Throws" },
  async handle() {
    throw new TypeError("secret detail /etc/passwd");
  },
};
`,
  "slow.js": `"use strict";
module.exports = {
  id: "slow.get",
  method: "GET",
  path: "/api/v1/slow",
  right: "slow.read",
  doc: { summary: "Waits for its abort signal" },
  async handle(ctx) {
    globalThis.__owbSlowStarted = (globalThis.__owbSlowStarted || 0) + 1;
    await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
    return { status: 200, body: { aborted: ctx.signal.aborted } };
  },
};
`,
  "old.js": `"use strict";
module.exports = {
  id: "old.get",
  method: "GET",
  path: "/api/v1/old",
  right: "old.read",
  deprecated: { since: "2026-01-01T00:00:00Z", sunset: "2027-01-01T00:00:00Z", link: "/api/v1/messages" },
  doc: { summary: "Deprecated" },
  async handle() {
    return { status: 200, body: { old: true } };
  },
};
`,
};

// ---- the fake engine ------------------------------------------------------------------------------------------------
function createFakeEngine() {
  const engine = {
    calls: [],
    order: [],
    messages: new Map(),
    idem: new Map(),
    banned: new Set(),
    known: new Set(),
    ownNumber: OWN_NUMBER,
    refuseAdmission: null,
    submitDelayMs: 0,
    mediaBytes: 0,
    staged: null,
    formats: fakeFormats,
  };
  const record = (name, args) => {
    engine.calls.push({ name, args });
    engine.order.push(name);
  };
  const count = (name) => engine.calls.filter((c) => c.name === name).length;
  engine.count = count;

  engine.resolveRecipient = async (to, { policy } = {}) => {
    record("resolveRecipient", [to]);
    const text = String(to).replace(/[\s+\-.()]/g, "");
    let jid;
    let kind;
    if (/^\d{5,25}(-\d+)?@g\.us$/.test(String(to))) {
      jid = String(to);
      kind = "group";
    } else if (/^[1-9]\d{7,14}$/.test(text)) {
      jid = `${text}@s.whatsapp.net`;
      kind = "private";
    } else {
      throw new MessagingError("validation_failed", { fields: { to: { code: "invalid_format" } } });
    }
    if (policy) {
      const allowed = policy.mode === "anyone" || (policy.mode === "list" && policy.entries.includes(jid)) || (policy.mode === "known" && engine.known.has(jid));
      if (!allowed) throw new MessagingError("recipient_not_allowed");
    }
    if (jid === `${engine.ownNumber}@s.whatsapp.net`) throw new MessagingError("validation_failed", { fields: { to: { code: "not_allowed" } } });
    if (engine.banned.has(jid)) throw new MessagingError("chat_disabled");
    return { jid, kind, number: kind === "private" ? text : null };
  };

  engine.checkAdmission = async (args) => {
    record("checkAdmission", [args]);
    if (engine.refuseAdmission) throw new MessagingError(engine.refuseAdmission.code, { params: engine.refuseAdmission.params });
  };

  engine.validateInput = async (format, body, ctx) => {
    record("validateInput", [format, ctx && ctx.apiKeyId]);
    const rules = fakeFormats.schemaOf(format);
    const { value, fields } = schema.check(body, rules);
    if (Object.keys(fields).length) throw new MessagingError("validation_failed", { fields });
    const { format: f, to, quote, media, ...rest } = value;
    return { format: f, to, quote: quote || null, mediaMarker: Boolean(media && media.url), fields: rest };
  };

  engine.findByIdempotency = async ({ apiKeyId, key }) => {
    record("findByIdempotency", [apiKeyId, key]);
    return engine.idem.get(`${apiKeyId}:${key}`) || null;
  };

  engine.fetchMedia = async (format, url) => {
    record("fetchMedia", [format]);
    if (engine.staged instanceof Error) throw engine.staged;
    const file = path.join(engine.tmpDir, `fetched-${crypto.randomBytes(4).toString("hex")}.part`);
    fs.writeFileSync(file, "fetched");
    return { path: file, size: 7, name: "fetched", sha256: crypto.createHash("sha256").update("fetched").digest("hex"), mime: "image/png", ext: "png", kind: "image" };
  };

  engine.inspectMedia = async (format, file, opts) => {
    record("inspectMedia", [format]);
    if (engine.inspectError) throw engine.inspectError;
    return { kind: "image", mime: "image/png", ext: "png", size: file.size };
  };

  engine.pendingMediaBytes = async () => engine.mediaBytes;

  engine.submit = async (request) => {
    record("submit", [request]);
    if (engine.submitDelayMs) await new Promise((r) => setTimeout(r, engine.submitDelayMs));
    const idemKey = request.idempotency ? `${request.apiKeyId}:${request.idempotency.key}` : null;
    if (idemKey && engine.idem.has(idemKey)) {
      const stored = engine.idem.get(idemKey);
      return { message: stored.message, replayed: true, requestHash: stored.requestHash };
    }
    const id = `msg_${crypto.randomBytes(16).toString("base64url")}`;
    const message = { id, format: request.format, to: request.to, status: "queued", apiKeyId: request.apiKeyId };
    engine.messages.set(id, message);
    if (idemKey) engine.idem.set(idemKey, { message, requestHash: request.idempotency.requestHash });
    // the real engine moves (API) the staged file into data/api-media
    if (request.media && request.media.path) fs.rmSync(request.media.path, { force: true });
    return { message, replayed: false, requestHash: request.idempotency ? request.idempotency.requestHash : null };
  };

  engine.get = async ({ apiKeyId, publicId }) => {
    record("get", [publicId]);
    const message = engine.messages.get(publicId);
    return message && message.apiKeyId === apiKeyId ? message : null;
  };
  return engine;
}

// ---- the kit ---------------------------------------------------------------------------------------------------------
async function createApiKit(options = {}) {
  const db = await kitDb.makeDb();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-api-kit-"));
  const endpointsDir = path.join(tmp, "endpoints");
  fs.mkdirSync(endpointsDir);
  for (const [name, text] of Object.entries(options.endpoints || FIXTURES)) fs.writeFileSync(path.join(endpointsDir, name), text);

  const clock = createClock(T0);
  const config = {
    ADMIN_PANEL: true,
    PANEL_TRUST_PROXY: "loopback",
    API_RATE_PER_MINUTE: 30,
    API_RATE_PER_DAY: 1000,
    API_MAX_PENDING: 100,
    MAX_UPLOAD: 230,
    TIMEZONE: "UTC",
    ...(options.config || {}),
  };
  const alerts = { calls: [], raise: async (type, payload) => alerts.calls.push({ type, payload }) };
  const audit = { rows: [], record: async (row) => audit.rows.push(row) };
  const apiState = { enabled: true, plain: [], isEnabled: () => apiState.enabled, plainHttpFrom: () => apiState.plain };
  const runtime = { dbReady: true };
  const maintenance = { active: false, isActive: () => maintenance.active };
  const engine = createFakeEngine();
  engine.tmpDir = path.join(tmp, "tmp");
  fs.mkdirSync(engine.tmpDir);
  const settingsCache = new SettingsCache();
  const logLines = [];
  const logger = new Proxy({}, { get: (_, level) => (...args) => logLines.push({ level, args }) });

  const api = createApi({
    config,
    models: db,
    runtime,
    messaging: engine,
    formats: fakeFormats,
    apiState,
    alerts,
    audit,
    maintenanceMode: maintenance,
    settingsCache,
    clock,
    logger,
    endpointsDir,
    dataDir: tmp,
    upload: createUploader({ sniff: fakeSniff, config, dataDir: tmp, idleMs: options.idleMs }),
    ...(options.deps || {}),
  });
  const keyMaker = createKeyStore({ models: db, settingsCache, now: () => clock.now() });

  const LEGACY_BODY = "<!DOCTYPE html><html>legacy</html>";
  const server = http.createServer((req, res) => {
    if (api.handle(req, res)) return;
    res.writeHead(200, { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" });
    res.end(LEGACY_BODY);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // a keep-alive client, so `Connection: close` in an answer comes from the server and not from a one-shot client
  const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  let seq = 0;
  async function makeKey(over = {}) {
    const made = keyMaker.generateSecret();
    const n = ++seq;
    const name = over.name || `Kit key ${n}`;
    const row = await db.ApiKey.create({
      name,
      nameKey: over.revokedAt ? null : name.toLowerCase(),
      lookupId: made.lookupId,
      secretHash: made.secretHash,
      last4: made.last4,
      rights: ["messages.send.text", "messages.read"],
      policyMode: "anyone",
      ...over,
    });
    api.keys.invalidate();
    return { token: made.secret, row, id: row.id, made };
  }

  /** One raw HTTP request; resolves { status, headers, json, text, raw } */
  function request(pathText, opts = {}) {
    return new Promise((resolve, reject) => {
      const headers = { ...(opts.headers || {}) };
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      if (opts.remote) {
        headers["X-Forwarded-For"] = opts.remote;
        if (opts.https !== false) headers["X-Forwarded-Proto"] = "https";
      }
      let payload = opts.body;
      if (opts.json !== undefined) {
        payload = JSON.stringify(opts.json);
        headers["Content-Type"] = headers["Content-Type"] || "application/json";
      }
      if (opts.contentType) headers["Content-Type"] = opts.contentType;
      if (payload !== undefined && headers["Content-Length"] === undefined && !opts.chunked) headers["Content-Length"] = Buffer.byteLength(payload);
      const req = http.request(`${base}${pathText}`, { method: opts.method || "GET", headers, agent }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const text = raw.toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, json, text, raw });
        });
      });
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  const kit = {
    api,
    engine,
    clock,
    config,
    alerts,
    audit,
    apiState,
    runtime,
    maintenance,
    db,
    logLines,
    base,
    endpointsDir,
    tmp,
    T0,
    legacy: { status: 200, contentType: "text/html", body: LEGACY_BODY },
    request,
    get: (p, token, opts) => request(p, { ...opts, token }),
    post: (p, token, json, opts) => request(p, { method: "POST", ...opts, token, json }),
    makeKey,
    async close() {
      agent.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await api.stop();
      await db.DATABASE.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
  return kit;
}

module.exports = { createApiKit, fakeFormats, fakeSniff, createFakeEngine, FIXTURES, T0, OWN_NUMBER };
