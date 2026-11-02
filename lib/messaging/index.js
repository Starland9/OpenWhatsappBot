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
 * Delivered with the media path (Phase 4), the receipts (Phase 5) and the replies (Phases 7 and 8): `inspectMedia`,
 * `fetchMedia`, `sweepMedia`, `get`, `list`, `describeResponses`.
 *
 * `module.exports` is a process-wide instance of `createMessaging()` plus `createMessaging`, `MessagingError` and
 * `MESSAGING_STATUS`. Requiring this file starts nothing: no timer, listener, query or directory (RT-02); every
 * collaborator is resolved where it is used, `options` replaces any of them (tests).
 */

const { Op } = require("sequelize");
const { MessagingError, MESSAGING_STATUS } = require("./errors");
const { LIMITS } = require("./limits");
const { createOutbox, createDeps } = require("./outbox");
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
  // Lifecycle
  // -------------------------------------------------------------------------------------------------------------------

  const outbox = createOutbox({ ...options, deps: d, validateInput, resolveRecipient });

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
    // T085 (media path): one sweepMedia({ now }) here, before the loop starts
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
  // Reading
  // -------------------------------------------------------------------------------------------------------------------

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
    findByIdempotency,
    submit: (request) => outbox.accept(request),

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
