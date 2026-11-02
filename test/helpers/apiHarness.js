"use strict";
/**
 * Full-stack harness of the public messaging API (feature 004, F-PUB; tasks T050). The REAL `createApi`, the real
 * messaging engine (lib/messaging, through test/helpers/messagingKit.js), the real endpoint modules, the real key
 * store, the real quotas and formats, over the in-memory database, a fake socket and client and a fake clock, behind
 * the real `createPanelServer` (so an unclaimed URL gets the real legacy answer) on 127.0.0.1:0.
 * Nothing touches the network beyond loopback, the real `data/`, `sessions/` or a phone. The caller runs
 * `fakes.setupEnv()` before requiring this file.
 *
 *   const h = await createApiHarness({ enabled, config, realTime, mount, endpointsDir, logs, start, ready })
 *   h.api / h.engine / h.messaging / h.db / h.clock / h.sock / h.client / h.config / h.alerts / h.audit.rows
 *   h.createKey({ name, rights ("all" | string[]), policy ("anyone" | "list" | "known"), recipients, limits,
 *                 ipAllow, expiresAt, revokedAt })               -> { id, name, token, row, authorization }
 *   h.request(method, path, { key | token, headers, body, files, rawBody, contentType, remote, https, chunked,
 *                             order, boundary })                  -> { status, headers, json, text, raw }
 *   h.get(path, key, opts) / h.post(path, key, body, opts)
 *   h.send(key, body, opts)             POST /api/v1/messages with a JSON body
 *   h.sendFile(key, message, file, opts) POST a multipart request (`message` then `file`)
 *   h.tick(ms) / h.run(ms, step)        advance the fake clock, then run engine passes (the queue sends)
 *   h.setEnabled(bool)                  flip the switch like apiState does (listeners awaited)
 *   h.setConnected(bool)                simulate a WhatsApp disconnection
 *   h.revokeKey(key)                    what the panel does: revoke the row, drop the cache, cancel the queue
 *   h.dumpTables()                      the four API tables as plain objects (a test scans or compares them)
 *   h.rows() / h.row(publicId)          ApiMessage instances
 *   h.legacy(path, opts)                the answer of the panel server to a URL (unclaimed by the API)
 *   h.web                               the fake Internet behind `media.url` (see createWeb)
 *   h.captureLogs() / h.logText()       everything logged (raw API logger arguments + final log output + ring)
 *   h.samples                           small real files: png, jpeg-less, gif, mp4, wav, pdf, text, exe
 *   h.close()
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const EventEmitter = require("node:events");
const { Readable } = require("node:stream");
const { createEngineKit } = require("./messagingKit");

const OWN_NUMBER = "237690000099";
const MSG_ID = /^msg_[A-Za-z0-9_-]{22}$/;
const PUBLIC_IP = "93.184.216.34";

// ---- small real files -----------------------------------------------------------------------------------------------
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const samples = {
  png: () => require("sharp")({ create: { width: 16, height: 16, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer(),
  jpeg: () => require("sharp")({ create: { width: 16, height: 16, channels: 3, background: { r: 30, g: 30, b: 200 } } }).jpeg().toBuffer(),
  gif: () => Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
  // an ISO base media header is enough for the type detection (the conversion is not exercised over HTTP)
  mp4: () => Buffer.concat([u32(24), Buffer.from("ftypisom"), u32(512), Buffer.from("isomiso2"), u32(8), Buffer.from("free")]),
  wav: () => {
    const data = Buffer.alloc(1600, 0);
    const head = Buffer.alloc(44);
    head.write("RIFF", 0);
    head.writeUInt32LE(36 + data.length, 4);
    head.write("WAVEfmt ", 8);
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22);
    head.writeUInt32LE(8000, 24);
    head.writeUInt32LE(16000, 28);
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write("data", 36);
    head.writeUInt32LE(data.length, 40);
    return Buffer.concat([head, data]);
  },
  pdf: () => Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"),
  text: () => Buffer.from("name,amount\nAwa,1200\n"),
  exe: () => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]), Buffer.alloc(64)]),
};

/** A sample that the given format accepts (the contract examples post these) */
async function sampleFor(format) {
  switch (format) {
    case "image":
    case "sticker":
      return { data: await samples.png(), name: "sample.png", type: "image/png" };
    case "video":
      return { data: samples.mp4(), name: "sample.mp4", type: "video/mp4" };
    case "gif":
      return { data: samples.gif(), name: "sample.gif", type: "image/gif" };
    case "audio":
    case "voice":
      return { data: samples.wav(), name: "sample.wav", type: "audio/wav" };
    case "document":
      return { data: samples.pdf(), name: "sample.pdf", type: "application/pdf" };
    default:
      return null;
  }
}

// ---- multipart bodies -----------------------------------------------------------------------------------------------
/**
 * @param {{ name: string, data: Buffer|string, filename?: string, type?: string }[]} parts
 */
function multipartBody(parts, boundary) {
  const chunks = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) head += `; filename="${part.filename}"`;
    head += "\r\n";
    if (part.type) head += `Content-Type: ${part.type}\r\n`;
    chunks.push(Buffer.from(`${head}\r\n`), Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data)), Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

// ---- the fake Internet behind media.url -------------------------------------------------------------------------------
function createWeb(tmpDir) {
  const { createUrlFetcher } = require("../../lib/messaging/urlFetch");
  const web = { calls: [], resolved: [], hosts: {}, handler: null };
  const reply = ({ status = 200, headers = {}, body = Buffer.alloc(0) }) => {
    const res = Readable.from([body], { objectMode: false });
    res.statusCode = status;
    res.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return res;
  };
  web.reply = reply;
  /** The next answers: a body with its headers (or a function (options, index) -> reply | { error }) */
  web.serve = (body, headers = {}) => {
    web.handler = typeof body === "function" ? body : () => reply({ body, headers });
  };
  const resolve = async (host) => {
    web.resolved.push(host);
    const entry = Object.hasOwn(web.hosts, host) ? web.hosts[host] : [PUBLIC_IP];
    return entry.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  const request = (options, callback) => {
    const index = web.calls.length;
    web.calls.push(options);
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => {
      req.destroyed = true;
      return req;
    };
    req.end = () => {
      setImmediate(async () => {
        if (req.destroyed) return;
        let out;
        try {
          out = web.handler ? await web.handler(options, index) : reply({ status: 404 });
        } catch (err) {
          out = { error: err };
        }
        if (req.destroyed) return;
        if (out && out.error) req.emit("error", out.error);
        else callback(out);
      });
    };
    return req;
  };
  web.fetcher = createUrlFetcher({ resolve, request, tmpDir });
  return web;
}

// ---- the harness ------------------------------------------------------------------------------------------------------
async function createApiHarness(options = {}) {
  const { createApi } = require("../../lib/api");
  const { createUploader } = require("../../lib/api/upload");
  const { createPanelServer } = require("../../lib/admin/server");
  const SettingsCache = require("../../lib/utils/settingsCache").constructor;
  const logger = require("../../lib/utils/logger");

  const config = {
    ADMIN_PANEL: true,
    PANEL_TRUST_PROXY: "loopback",
    API_RATE_PER_MINUTE: 30,
    API_RATE_PER_DAY: 1000,
    API_MAX_PENDING: 100,
    TIMEZONE: "UTC",
    MAX_UPLOAD: 230,
    ...(options.config || {}),
  };

  // the switch, like lib/utils/apiState (the panel switch AND the row), listeners awaited
  const state = { enabled: options.enabled !== false, plain: [...(options.plainHttpFrom || [])] };
  const listeners = [];
  const apiState = {
    isEnabled: () => state.enabled && config.ADMIN_PANEL !== false,
    plainHttpFrom: () => state.plain,
    onChange(fn) {
      listeners.push(fn);
      return () => {
        const at = listeners.indexOf(fn);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
  };

  // the engine downloads through the fake web: the fetcher is bound late (the web needs the engine's data root)
  let web = null;
  const lateFetcher = {
    fetchMedia: (...args) => web.fetcher.fetchMedia(...args),
    fetchPreview: (...args) => web.fetcher.fetchPreview(...args),
  };
  const engine = await createEngineKit({
    realTime: options.realTime === true,
    config,
    sockOptions: options.sockOptions,
    enabled: state.enabled,
    deps: { apiState, urlFetch: lateFetcher, ...(options.engineDeps || {}) },
  });
  web = createWeb(path.join(engine.dataDir, "tmp", "api"));
  const messaging = engine.messaging;

  const runtime = { dbReady: true };
  const maintenance = { active: false, isActive: () => maintenance.active };
  const audit = { rows: [], record: async (row) => audit.rows.push(row) };
  const logLines = [];
  const apiLogger = new Proxy({}, { get: (_, level) => (...args) => logLines.push({ level, args }) });

  const api = createApi({
    config,
    models: engine.db,
    runtime,
    messaging,
    apiState,
    alerts: engine.alerts,
    audit,
    maintenanceMode: maintenance,
    settingsCache: new SettingsCache(),
    clock: { now: engine.now },
    logger: apiLogger,
    dataDir: engine.dataDir,
    upload: createUploader({ config, dataDir: engine.dataDir, idleMs: options.idleMs }),
    ...(options.endpointsDir ? { endpointsDir: options.endpointsDir } : {}),
    ...(options.apiDeps || {}),
  });

  const botState = { status: "running", isConnected: true, startTime: null, version: "test", messagesProcessed: 0, lastActivity: null };
  const server = createPanelServer({ botState, api: options.mount === false ? null : api });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });

  if (options.start !== false) await engine.start();

  // ---- keys ----------------------------------------------------------------------------------------------------------
  let keySeq = 0;
  const allRights = () => api.rights().map((row) => row.id);
  async function createKey(over = {}) {
    const made = api.keys.generateSecret();
    const n = ++keySeq;
    const name = over.name || `Harness key ${n}`;
    const limits = over.limits || {};
    const row = await engine.db.ApiKey.create({
      name,
      nameKey: over.revokedAt ? null : name.toLowerCase(),
      lookupId: made.lookupId,
      secretHash: made.secretHash,
      last4: made.last4,
      rights: over.rights === undefined || over.rights === "all" ? allRights() : over.rights,
      policyMode: over.policy || "anyone",
      recipients: over.recipients || [],
      limitPerMinute: limits.perMinute ?? null,
      limitPerDay: limits.perDay ?? null,
      limitPending: limits.pending ?? null,
      ipAllow: over.ipAllow || [],
      expiresAt: over.expiresAt || null,
      revokedAt: over.revokedAt || null,
    });
    api.keys.invalidate();
    return { id: row.id, name, token: made.secret, secret: made.secret.slice(-43), lookupId: made.lookupId, row, authorization: `Bearer ${made.secret}` };
  }

  /** What the panel's revoke does, in the same order: the row, the cache, the queue */
  async function revokeKey(key) {
    await engine.db.ApiKey.update({ revokedAt: new Date(engine.now()), nameKey: null }, { where: { id: key.id } });
    api.keys.invalidate();
    return messaging.cancelForKey(key.id, "key_revoked");
  }

  // ---- raw HTTP ------------------------------------------------------------------------------------------------------
  // `fresh: true` comes from a new address behind the trusted proxy, so the failures of one test never spend the
  // authentication budget (10 in 5 minutes per origin) of the next
  let originSeq = 0;
  const freshOrigin = () => {
    originSeq += 1;
    return `198.18.${Math.floor(originSeq / 250) % 250}.${(originSeq % 250) + 1}`;
  };
  function request(method, pathText, opts = {}) {
    return new Promise((resolve, reject) => {
      if (opts.fresh && !opts.remote) opts = { ...opts, remote: freshOrigin() };
      const headers = { ...(opts.headers || {}) };
      const token = opts.token !== undefined ? opts.token : opts.key ? opts.key.token || opts.key : undefined;
      if (token) headers.Authorization = `Bearer ${token}`;
      if (opts.remote) {
        headers["X-Forwarded-For"] = opts.remote;
        if (opts.https !== false) headers["X-Forwarded-Proto"] = "https";
      }
      let payload = opts.rawBody;
      if (payload === undefined && opts.files) {
        const boundary = opts.boundary || `----owbharness${crypto.randomBytes(6).toString("hex")}`;
        const parts = [];
        const messagePart = { name: "message", data: opts.body !== undefined ? JSON.stringify(opts.body) : "{}", type: opts.messageType === null ? undefined : opts.messageType || "application/json" };
        const filePart = (name, spec) => {
          const file = Buffer.isBuffer(spec) ? { data: spec } : spec;
          return { name, data: file.data, filename: file.name || "upload.bin", type: file.type };
        };
        const files = Object.entries(opts.files).map(([name, spec]) => filePart(name, spec));
        if (opts.order === "file-first") parts.push(...files, messagePart);
        else parts.push(messagePart, ...files);
        payload = multipartBody(parts, boundary);
        headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
      } else if (payload === undefined && opts.body !== undefined) {
        payload = JSON.stringify(opts.body);
        headers["Content-Type"] = headers["Content-Type"] || "application/json";
      }
      if (opts.contentType) headers["Content-Type"] = opts.contentType;
      if (payload !== undefined && headers["Content-Length"] === undefined && !opts.chunked) headers["Content-Length"] = Buffer.byteLength(payload);
      const req = http.request(`${base}${pathText}`, { method, headers, agent: opts.agent === false ? false : agent }, (res) => {
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
          const answer = { status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, json, text, raw };
          // `harness.record = []` keeps every answer (the leak scan reads them all)
          if (harness.record) harness.record.push({ method, path: pathText, res: answer });
          resolve(answer);
        });
      });
      req.on("error", reject);
      if (opts.signal) opts.signal.addEventListener("abort", () => req.destroy(), { once: true });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  const harness = {
    api,
    engine,
    messaging,
    db: engine.db,
    clock: engine.clock,
    sock: engine.sock,
    client: engine.client,
    config,
    alerts: engine.alerts,
    audit,
    apiState,
    state,
    runtime,
    maintenance,
    logLines,
    web,
    server,
    base,
    samples,
    sampleFor,
    multipartBody,
    OWN_NUMBER,
    MSG_ID,
    allRights,
    createKey,
    revokeKey,
    request,
    get: (p, key, opts) => request("GET", p, { ...opts, key }),
    post: (p, key, body, opts) => request("POST", p, { ...opts, key, body }),
    send: (key, body, opts) => request("POST", "/api/v1/messages", { ...opts, key, body }),
    async sendFile(key, message, file, opts) {
      return request("POST", "/api/v1/messages", { ...opts, key, body: message, files: { file } });
    },
    /** Poll (real time) until the table holds at least `n` messages: a request in flight has been accepted */
    async accepted(n = 1, { timeout = 3000 } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if ((await engine.db.ApiMessage.count()) >= n) return true;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return false;
    },
    /**
     * Resolve `promise` (an HTTP request in flight) while moving the fake clock `step` ms at a time after each real
     * pause: a held `wait` ends at its bound without a real sleep. Rejects after `max` rounds.
     */
    async until(promise, { step = 1000, max = 60, advance = true } = {}) {
      let done = false;
      let value;
      let failure = null;
      promise.then(
        (v) => {
          done = true;
          value = v;
        },
        (e) => {
          done = true;
          failure = e;
        },
      );
      for (let i = 0; i < max && !done; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (!done && advance) await engine.clock.advance(step);
      }
      if (!done) throw new Error("the request did not settle");
      if (failure) throw failure;
      return value;
    },
    /** Run engine passes (2.2 s apart) until nothing is queued or sending; the gate is open again afterwards */
    async drain({ step = 2200, max = 600 } = {}) {
      const { Op } = require("sequelize");
      for (let i = 0; i < max; i += 1) {
        const open = await engine.db.ApiMessage.count({ where: { status: { [Op.in]: ["queued", "sending"] } } });
        if (!open) {
          await engine.clock.advance(step);
          return i;
        }
        await engine.tick(step);
      }
      throw new Error("the queue did not drain");
    },
    /**
     * Record a reply the way the engine does (lib/messaging/replies.js#record, on the harness clock): a tap, a numbered
     * answer or a poll vote. `at` defaults to the harness time. Resolves true when something was written.
     */
    async recordReply(publicId, { kind, author, choiceIds, via, at, sourceId } = {}) {
      const { createReplies } = require("../../lib/messaging/replies");
      const replies = createReplies({ clock: engine.now });
      const row = await engine.row(publicId);
      return replies.record({ row, kind, author, choiceIds, via, sourceId, at: at === undefined ? new Date(engine.now()) : at });
    },
    tick: (ms) => engine.tick(ms),
    run: (ms, step) => engine.run(ms, step),
    now: engine.now,
    rows: () => engine.rows(),
    row: (publicId) => engine.row(publicId),
    async setEnabled(value) {
      const previous = { enabled: state.enabled };
      state.enabled = value === true;
      for (const fn of listeners.slice()) await fn({ enabled: state.enabled, plainHttpFrom: [...state.plain], previous });
    },
    setConnected: (value) => engine.client.setReady(value),
    async dumpTables() {
      const out = {};
      for (const name of ["ApiKey", "ApiMessage", "ApiMessageResponse", "ApiState"]) {
        out[name] = (await engine.db[name].findAll()).map((row) => row.get({ plain: true }));
      }
      return out;
    },
    legacy: (p, opts = {}) => request(opts.method || "GET", p, opts),
    captureLogs() {
      const lines = [];
      logger.setOutput((text) => lines.push(String(text)));
      logger.setLevel("trace");
      harness._logOutput = lines;
      harness._logging = true;
      return lines;
    },
    logText() {
      const ring = require("../../lib/admin/logs/ring");
      const parts = [JSON.stringify(logLines), (harness._logOutput || []).join("\n"), JSON.stringify(ring.list({ limit: 1000 }))];
      return parts.join("\n");
    },
    async close() {
      agent.destroy();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections && server.closeAllConnections();
      });
      await api.stop();
      if (harness._logging) {
        logger.setOutput();
        logger.setLevel("silent");
      }
      await engine.close();
    },
  };

  return harness;
}

module.exports = { createApiHarness, samples, sampleFor, multipartBody, createWeb, OWN_NUMBER, MSG_ID, PUBLIC_IP };
