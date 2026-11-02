"use strict";

/**
 * The messaging engine's facade and composition root (feature 004, contracts/runtime.md section 1). It is the only
 * module `lib/api`, the panel service, `boot.js` and the housekeeping talk to.
 *
 *   lifecycle (the `messaging` entry of boot.js ENGINES: `start(engine, client) => engine.start(client)`)
 *     start(client)    idempotent; remembers the client, loads the format registry (a FormatRegistryError is
 *                      rethrown AFTER recovery and the subscription, enable() then does nothing), recovers the rows
 *                      a crash left (RT-54), seeds the send gate, and enables the loop only when the switch is on.
 *                      It subscribes to `apiState.onChange`: that subscription is the only listener a disabled
 *                      API holds
 *     stop()           clears the timer, detaches the listeners, ends the waiters; queued rows stay queued (FR-038)
 *     isRunning() / enable() / disable({ reason }) / cancelForKey(apiKeyId, reason)
 *   accept path (lib/api/pipeline.js steps 11-20 and the panel service)
 *     formats, resolveRecipient, validateInput, checkAdmission, findByIdempotency, submit
 *   queue
 *     waitFor, pendingOf, queueSize, pendingMediaBytes, spacingMs, stats, parseRecipient, mask
 *   engine access (tests, wiring)
 *     tick(now), kick(), outbox
 *
 *   media              inspectMedia(format, file, { name }), fetchMedia(format, url, { signal }), sweepMedia({ now })
 *   reading            get({ apiKeyId, publicId }, { responses }), list({ apiKeyId, status, format, since, until, limit,
 *                      after }), describeResponses(row, responses)
 *
 * `module.exports` is a process-wide instance of `createMessaging()` plus `createMessaging`, `MessagingError` and
 * `MESSAGING_STATUS`. Requiring this file starts nothing: no timer, listener, query or directory (RT-02); every
 * collaborator is resolved where it is used, `options` replaces any of them (tests).
 */

const fsp = require("node:fs/promises");
const path = require("node:path");
const { Op } = require("sequelize");
const { MessagingError, MESSAGING_STATUS } = require("./errors");
const { LIMITS } = require("./limits");
const { createOutbox, createDeps } = require("./outbox");
const { createReplies } = require("./replies");
const { createLogger } = require("../utils/logger");
const { safeLog } = require("../utils/http");

const logger = createLogger("messaging");

/**
 * @param {object} [options] every field optional: models, clock, random, timers, config, apiState, gate, formats,
 *   recipients, stage, alerts, mutex, secretBox, newMessageId, mintBytes, bannedChats, sock (a socket accessor),
 *   receipts (a factory ({ models, clock, onRestricted }) -> { handle(updates) }, or such a handler), maintenanceMode,
 *   buttons, sentIds, classify, dataDir, rootDir
 */
function createMessaging(options = {}) {
  const d = createDeps(options);
  const M = () => d.models();
  const formats = d.formats();
  let client = null;
  let started = false;
  let formatsFailed = false;
  let unsubscribe = null;

  const sockAccessor = () => {
    if (typeof options.sock === "function") return options.sock();
    try {
      return client && typeof client.getSocket === "function" ? client.getSocket() : null;
    } catch {
      return null;
    }
  };

  // -------------------------------------------------------------------------------------------------------------------
  // The accept path's building blocks
  // -------------------------------------------------------------------------------------------------------------------

  /** Parse, policy, the bot's own number, disabled chat (FR-032); `policy` null means none (the panel) */
  function resolveRecipient(to, { policy = null } = {}) {
    return d.recipients().resolveRecipient(to, { policy: policy || null, sock: sockAccessor, bannedChats: d.bannedChats });
  }

  /**
   * A sent message of the same key to the same chat that can be quoted (4.2 step 6): its public id, WhatsApp id and
   * format, or null.
   */
  async function findQuotable(publicId, apiKeyId, target) {
    const row = await M().ApiMessage.findOne({
      where: {
        publicId,
        apiKeyId: apiKeyId === undefined ? null : apiKeyId,
        recipient: target.jid,
        status: { [Op.in]: ["sent", "delivered", "read"] },
        waId: { [Op.ne]: null },
      },
      attributes: ["publicId", "waId", "format"],
    });
    return row ? { publicId: row.publicId, waId: row.waId, format: row.format } : null;
  }

  /**
   * The strict schema of the format, the registry's common rules, the module's cross-field rules and the `quote`
   * lookup, in that order, all faults at once; `normalize` ran last, so `fields` is already in stored form.
   * `quoteRef` (beyond the contract's Validated) is the resolved quote `submit` stores in the payload.
   * @throws {MessagingError} validation_failed { fields }
   */
  async function validateInput(formatName, body, { target = null, apiKeyId = null } = {}) {
    const checked = formats.checkInput(formatName, body, { target });
    const fields = { ...checked.fields };
    const quote = checked.value && typeof checked.value.quote === "string" && checked.value.quote ? checked.value.quote : null;
    let quoteRef = null;
    if (quote && !fields.quote && target) {
      quoteRef = await findQuotable(quote, apiKeyId, target);
      if (!quoteRef) fields.quote = { code: "not_found" };
    }
    if (Object.keys(fields).length) throw new MessagingError("validation_failed", { fields });
    return {
      format: checked.value.format,
      to: checked.value.to,
      quote,
      mediaMarker: checked.mediaMarker,
      fields: checked.own,
      quoteRef,
    };
  }

  /** The stored view and fingerprint of an idempotency key, null when unknown or older than 24 h (released lazily) */
  async function findByIdempotency({ apiKeyId, key, now } = {}) {
    if (apiKeyId === null || apiKeyId === undefined || !key) return null;
    const row = await M().ApiMessage.findOne({ where: { apiKeyId, idempotencyKey: key } });
    if (!row) return null;
    const at = Number.isFinite(Number(now)) && now !== undefined && now !== null ? Number(now) : d.clock();
    if (row.acceptedAt.getTime() < at - LIMITS.IDEMPOTENCY_MS) {
      await M().ApiMessage.update({ idempotencyKey: null, requestHash: null }, { where: { id: row.id, idempotencyKey: key } });
      return null;
    }
    return { message: outbox.viewOf(row), requestHash: row.requestHash };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Media (10.1, 10.2, 10.4)
  // -------------------------------------------------------------------------------------------------------------------

  const noFile = () => new MessagingError("validation_failed", { fields: { file: { code: "not_allowed" } } });

  /**
   * The final check of a file on disk: the type is detected from its bytes (the declared one and the name are
   * ignored, RT-100) against the kinds of the format, then the size against the effective cap. A mismatch deletes
   * nothing itself (the caller removes its temporary file) and never carries the detected type.
   * @returns {Promise<{ kind: string, mime: string, ext: string, size: number }>}
   */
  async function inspectMedia(formatName, file, { name } = {}) {
    const format = formats.get(formatName);
    if (!format || !format.media) throw noFile();
    const sniff = d.sniff();
    const size = Number.isFinite(file.size) ? file.size : (await fsp.stat(file.path)).size;
    const maxBytes = sniff.effectiveMax(format);
    if (size > maxBytes) throw new MessagingError("media_too_large", { params: { maxBytes: Math.floor(maxBytes) } });
    const detected = await sniff.classify(file.path, { name: name !== undefined ? name : file.name });
    sniff.check(format.media.kinds, detected);
    const kind = format.media.kinds.find((k) => sniff.KINDS[k] && sniff.KINDS[k].has(detected.mime));
    return { kind, mime: detected.mime, ext: detected.ext, size };
  }

  /**
   * Download the URL of a request through the guarded fetcher (the caller's right `media.url` was checked by the
   * pipeline) and inspect the result; the temporary file is removed when the inspection refuses it. The URL is never
   * stored or logged: the result carries `source: "url"` and no name.
   */
  async function fetchMedia(formatName, url, { signal } = {}) {
    const format = formats.get(formatName);
    if (!format || !format.media || (Array.isArray(format.media.sources) && !format.media.sources.includes("url"))) {
      throw new MessagingError("validation_failed", { fields: { media: { code: "not_allowed" } } });
    }
    const fetched = await d.urlFetch().fetchMedia(url, { maxBytes: d.sniff().effectiveMax(format), kinds: format.media.kinds, signal });
    try {
      const info = await inspectMedia(formatName, { path: fetched.path, size: fetched.size }, {});
      return { path: fetched.path, size: info.size, name: null, sha256: fetched.sha256, mime: info.mime, ext: info.ext, kind: info.kind, source: "url" };
    } catch (err) {
      await fsp.rm(fetched.path, { force: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * Orphans (the daily housekeeping and once at start): each `data/api-media/<name>/` older than the grace whose name
   * is not the public id of a queued or sending row, and every `data/tmp/api/*.part` older than the same grace. Takes
   * no engine lock (Y13): an acceptance in progress is protected by the grace.
   * @returns {Promise<{ removed: number, freedBytes: number }>}
   */
  async function sweepMedia({ now } = {}) {
    const at = Number.isFinite(Number(now)) && now !== undefined && now !== null ? Number(now) : d.clock();
    const safeFs = d.safeFs();
    const stage = d.stage();
    const total = { removed: 0, freedBytes: 0 };
    const add = (result) => {
      total.removed += result.removed;
      total.freedBytes += result.freedBytes;
    };

    const names = (await stage.list()).map((entry) => entry.name);
    const active = new Set();
    for (let i = 0; i < names.length; i += 500) {
      const rows = await M().ApiMessage.findAll({
        where: { publicId: { [Op.in]: names.slice(i, i + 500) }, status: { [Op.in]: ["queued", "sending"] } },
        attributes: ["publicId"],
      });
      for (const row of rows) active.add(row.publicId);
    }
    add(await safeFs.purgeChildren(stage.rootDir(), { olderThanMs: LIMITS.STAGE_GRACE_MS, now: at, skip: (name) => active.has(name) || !names.includes(name) }));
    const tmpApi = options.tmpDir || path.join(path.dirname(stage.rootDir()), "tmp", "api");
    add(await safeFs.purgeChildren(tmpApi, { olderThanMs: LIMITS.STAGE_GRACE_MS, now: at, skip: (name) => !name.endsWith(".part") }));
    return total;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------------------------------

  const outbox = createOutbox({ ...options, deps: d, validateInput, resolveRecipient, inspectMedia });

  /** apiState awaits its listeners: once `setEnabled(false)` resolves, the queue is cancelled and the timer gone */
  async function onSwitch(change) {
    try {
      if (d.apiState().isEnabled()) {
        if (!formatsFailed) outbox.enable();
      } else if (change && change.previous && change.previous.enabled) {
        await outbox.disable({ reason: "api_disabled" });
      }
    } catch (err) {
      logger.error({ err: safeLog(err) }, "switch change not handled");
    }
  }

  /** The gate remembers the last send of a previous run, so a restart cannot burst */
  async function seedGate() {
    const latest = await M().ApiMessage.max("sendingAt");
    const ms = latest instanceof Date ? latest.getTime() : latest ? new Date(latest).getTime() : NaN;
    if (Number.isFinite(ms)) d.gate().seed(ms);
  }

  async function start(newClient) {
    if (newClient) {
      client = newClient;
      outbox.setClient(newClient);
    }
    if (started) return;
    started = true;

    let failure = null;
    try {
      formats.load();
    } catch (err) {
      failure = err;
      formatsFailed = true;
    }
    if (!unsubscribe) unsubscribe = d.apiState().onChange(onSwitch);

    try {
      await outbox.recover({ now: d.clock() });
    } catch (err) {
      logger.error({ err: safeLog(err) }, "messaging recovery failed");
    }
    try {
      await seedGate();
    } catch (err) {
      logger.warn({ err: safeLog(err) }, "send gate not seeded");
    }
    try {
      await sweepMedia({ now: d.clock() });
    } catch (err) {
      logger.warn({ err: safeLog(err) }, "staged media not swept");
    }
    if (!failure && d.apiState().isEnabled()) {
      outbox.enable();
      await outbox.ready(); // the hint is seeded: rows queued before the start are picked up
    }
    if (failure) throw failure;
  }

  async function stop() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    started = false;
    await outbox.stop();
  }

  const enable = () => {
    if (!formatsFailed) outbox.enable();
  };

  // -------------------------------------------------------------------------------------------------------------------
  // Reading (RT-11): scoped by the key in the WHERE clause, so another key's message, a panel message and a purged one
  // are indistinguishable
  // -------------------------------------------------------------------------------------------------------------------

  const PUBLIC_ID = /^msg_[A-Za-z0-9_-]{22}$/;
  const STATUS_SET = new Set(["queued", "sending", "sent", "delivered", "read", "failed", "expired", "cancelled", "unknown"]);

  /**
   * One message of a key as a MessageView, or null. `responses` (default true) adds the collected replies of an
   * interactive message.
   */
  async function get({ apiKeyId, publicId } = {}, { responses = true } = {}) {
    if (apiKeyId === null || apiKeyId === undefined || typeof publicId !== "string" || !PUBLIC_ID.test(publicId)) return null;
    const row = await M().ApiMessage.findOne({ where: { publicId, apiKeyId } });
    if (!row) return null;
    const view = outbox.viewOf(row);
    if (responses && view.interactive) view.responses = await describeStored(row);
    return view;
  }

  /** A bound given as a Date, milliseconds or text; anything unreadable is a fault of that field */
  function boundOf(value, field) {
    if (value === undefined || value === null) return null;
    const date = value instanceof Date ? value : new Date(typeof value === "number" || /^\d+$/.test(String(value)) ? Number(value) : value);
    if (Number.isNaN(date.getTime())) throw new MessagingError("validation_failed", { fields: { [field]: { code: "invalid_format" } } });
    return date;
  }

  /**
   * The messages of a key, newest first (keyset on the internal id). `since` is inclusive and `until` exclusive on the
   * acceptance time; `next` is the public id of the last item when more exist. An `after` that is not a message of
   * this key is `fields.after = not_found`, whatever the reason.
   * @returns {Promise<{ items: object[], next: string|null }>}
   */
  async function list({ apiKeyId, status, format, since, until, limit = 25, after } = {}) {
    const where = { apiKeyId };
    if (status !== undefined && status !== null) {
      const wanted = (Array.isArray(status) ? status : [status]).filter((s) => STATUS_SET.has(s));
      where.status = { [Op.in]: wanted };
    }
    if (format) where.format = format;
    const from = boundOf(since, "since");
    const to = boundOf(until, "until");
    if (from || to) where.acceptedAt = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lt]: to } : {}) };
    if (after !== undefined && after !== null) {
      const edge = typeof after === "string" && PUBLIC_ID.test(after) ? await M().ApiMessage.findOne({ where: { publicId: after, apiKeyId }, attributes: ["id"] }) : null;
      if (!edge) throw new MessagingError("validation_failed", { fields: { after: { code: "not_found" } } });
      where.id = { [Op.lt]: edge.id };
    }
    const size = Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 25));
    const rows = await M().ApiMessage.findAll({ where, order: [["id", "DESC"]], limit: size + 1 });
    const page = rows.slice(0, size);
    return { items: page.map((row) => outbox.viewOf(row)), next: rows.length > size ? page[page.length - 1].publicId : null };
  }

  // the responses object of public-api.md 4.4, built from the rows of the reply capture
  const replies = createReplies({ models: d.models, formats: d.formats, secretBox: d.secretBox, apiState: d.apiState, clock: d.clock });

  /** The stored responses of a row, described (the rows are read oldest first) */
  async function describeStored(row) {
    const stored = await M().ApiMessageResponse.findAll({ where: { messageId: row.id }, order: [["respondedAt", "ASC"], ["id", "ASC"]] });
    return replies.describeResponses(row, stored);
  }

  async function stats() {
    const count = (status) => M().ApiMessage.count({ where: { status } });
    const queued = await count("queued");
    const sending = await count("sending");
    const paused = outbox.pausedUntil();
    let botReady = false;
    try {
      botReady = Boolean(client && (typeof client.ready === "function" ? client.ready() : true));
    } catch {
      botReady = false;
    }
    return {
      enabled: d.apiState().isEnabled(),
      running: outbox.isRunning(),
      queued,
      sending,
      pausedUntil: paused > d.clock() ? paused : null,
      lastSendAt: d.gate().lastSendAt(),
      botReady,
    };
  }

  return {
    start,
    stop,
    isRunning: () => outbox.isRunning(),
    enable,
    disable: (opts) => outbox.disable(opts),
    cancelForKey: (apiKeyId, reason = "key_revoked") => outbox.cancelByKey(apiKeyId, reason),

    formats,
    resolveRecipient,
    validateInput,
    checkAdmission: ({ apiKeyId = null, maxPending } = {}) => outbox.admit({ apiKeyId, maxPending }),
    inspectMedia,
    fetchMedia,
    sweepMedia,
    findByIdempotency,
    submit: (request) => outbox.accept(request),
    get,
    list,
    describeResponses: (row, responses) => replies.describeResponses(row, responses),

    waitFor: (publicId, ms) => outbox.waitFor(publicId, ms),
    pendingOf: (apiKeyId) => outbox.countPending({ apiKeyId }),
    queueSize: () => outbox.countPending(),
    pendingMediaBytes: () => outbox.pendingMediaBytes(),
    spacingMs: () => outbox.spacingMs(),
    stats,
    parseRecipient: (input) => d.recipients().parseRecipient(input),
    mask: (jid) => d.recipients().mask(jid),

    tick: (now) => outbox.tick(now),
    kick: () => outbox.kick(),
    outbox,
  };
}

const instance = createMessaging();

module.exports = Object.assign(instance, { createMessaging, MessagingError, MESSAGING_STATUS });
