"use strict";

/**
 * The outbox of the messaging API (feature 004, contracts/runtime.md section 4): the accept path, the queue loop,
 * pacing, the claim and the single send, expiry, cancellation, the pause on a WhatsApp restriction, waiters,
 * recovery. A row of `api_messages` IS the queue (data-model.md 2): every transition T1-T11 is one conditional
 * `UPDATE ... WHERE status = :from`, and a lost race (0 rows changed) is ignored (RT-07).
 *
 *   createOutbox(options)    -> the engine; `lib/messaging/index.js` is its only caller and exposes it as a facade
 *   createDeps(options)      -> the lazily resolved collaborators (shared with the facade; nothing is required at load)
 *   quotedShell(format)      -> the typed empty shell WhatsApp needs under a quoted key (U13)
 *
 *   engine.accept(request)                       the nine steps of 4.2; returns { message, replayed, requestHash }
 *   engine.admit({ apiKeyId, maxPending, mediaSize })  the admission table of 4.5 (check only, throws MessagingError)
 *   engine.tick(now?) / kick()                   one pass (never rejects) / a pass at once when idle
 *   engine.start(client) / enable() / disable({ reason }) / stop() / isRunning()
 *   engine.cancelByKey(apiKeyId, reason) / cancelAll(reason)
 *   engine.recover({ now })                      boot recovery (RT-54)
 *   engine.waitFor(publicId, ms)                 -> { promise, cancel() }
 *   engine.onRestricted(code, at)                the 463 breaker (Y7); called by the receipts handler
 *   engine.viewOf(row)                           the MessageView of a row
 *
 * At-most-once (RT-50 to RT-54): the WhatsApp id is generated here, remembered in `sentIds`, written with the
 * claim (`sending`) BEFORE `sendMessage`, and nothing ever moves a row from `sending`, `sent` or `unknown` toward a
 * resend. There is exactly one send call per claimed row, no retry, and no helper with a text fallback.
 *
 * No timer, listener, query or directory at `require` (RT-02); every setting is read where it is used (RT-03);
 * everything that depends on time takes `now` or the injected clock (RT-08). Nothing logged carries a text, a
 * caption, a file name, a URL, a label or a recipient in clear (RT-05): a message is its `publicId` or `waId`, a
 * recipient is `mask(jid)`.
 */

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Op, UniqueConstraintError } = require("sequelize");
const { MessagingError, FAILURE_CODES, CANCEL_REASONS } = require("./errors");
const { LIMITS } = require("./limits");
const sentIdsModule = require("./sentIds");
const { createLogger } = require("../utils/logger");
const { safeLog } = require("../utils/http");

const logger = createLogger("messaging");

const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING = ["queued", "sending"];
const SETTLED_FOR_WAIT = new Set(["sent", "delivered", "read", "failed", "expired", "cancelled", "unknown"]);
const INTERACTIVE_FALLBACK = new Set(["poll", "buttons", "list"]);
const PICK_BATCH = 20;
const SWEEP_BATCH = 500;

/** The typed empty message WhatsApp needs under the quoted key, by the format of the quoted message (U13) */
const SHELLS = Object.freeze({
  text: () => ({ conversation: "" }),
  location: () => ({ conversation: "" }),
  contact: () => ({ conversation: "" }),
  poll: () => ({ conversation: "" }),
  buttons: () => ({ conversation: "" }),
  list: () => ({ conversation: "" }),
  image: () => ({ imageMessage: {} }),
  sticker: () => ({ imageMessage: {} }),
  video: () => ({ videoMessage: {} }),
  gif: () => ({ videoMessage: {} }),
  audio: () => ({ audioMessage: {} }),
  voice: () => ({ audioMessage: {} }),
  document: () => ({ documentMessage: {} }),
});

const quotedShell = (format) => (Object.hasOwn(SHELLS, format) ? SHELLS[format]() : { conversation: "" });

const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)));

/** The target of a STORED recipient (always a normalised JID, never what a caller typed); null if the row is damaged */
function targetOf(jid) {
  if (typeof jid !== "string") return null;
  if (/^\d{5,25}(-\d+)?@g\.us$/.test(jid)) return { kind: "group", jid, number: null };
  const pn = /^([1-9]\d{7,14})@s\.whatsapp\.net$/.exec(jid);
  return pn ? { kind: "private", jid, number: pn[1] } : null;
}

/** The default WhatsApp id generator: Baileys' own, loaded when the first message is built (RT-04) */
async function defaultMessageId(userId) {
  let baileys;
  try {
    baileys = require("baileys");
  } catch {
    baileys = await import("baileys");
  }
  const make = baileys.generateMessageIDV2 || (baileys.default && baileys.default.generateMessageIDV2);
  if (typeof make !== "function") throw new Error("generateMessageIDV2 is not available");
  return make(userId);
}

/**
 * The collaborators of the engine, each resolved on first use from `options` or from the real module: a test hands
 * fakes in, `require("./lib/messaging")` alone loads none of the heavy ones.
 */
function createDeps(options = {}) {
  const lazy = (name, load) => {
    let box;
    let loaded = false;
    return () => {
      if (!loaded) {
        box = options[name] !== undefined ? options[name] : load();
        loaded = true;
      }
      return box;
    };
  };
  return {
    models: lazy("models", () => require("../database")),
    config: lazy("config", () => require("../../config")),
    apiState: lazy("apiState", () => require("../utils/apiState")),
    gate: lazy("gate", () => require("../utils/sendGate").shared),
    formats: lazy("formats", () => require("./formats")),
    recipients: lazy("recipients", () => require("./recipients")),
    stage: lazy("stage", () => require("./stage")),
    sniff: lazy("sniff", () => require("./sniff")),
    safeFs: lazy("safeFs", () => require("../utils/safeFs")),
    urlFetch: lazy("urlFetch", () => require("./urlFetch")),
    sanitizeName: lazy("sanitizeName", () => require("../utils/broadcaster").sanitizeName),
    alerts: lazy("alerts", () => require("../utils/alerts")),
    mutex: lazy("mutex", () => require("../utils/mutex")),
    secretBox: lazy("secretBox", () => require("../utils/secretBox")),
    maintenance: lazy("maintenanceMode", () => require("../utils/maintenanceMode")),
    sentIds: lazy("sentIds", () => sentIdsModule),
    buttons: lazy("buttons", () => require("../../plugins/buttons")),
    classify: lazy("classify", () => require("../utils/broadcaster").classify),
    newMessageId: lazy("newMessageId", () => defaultMessageId),
    mintBytes: lazy("mintBytes", () => () => crypto.randomBytes(16)),
    bannedChats: options.bannedChats,
    // the delivery / read / negative-ack handler, attached to `messages.update` while the switch is on; `null` = none
    receipts: options.receipts !== undefined ? options.receipts : (opts) => require("./receipts").createReceiptHandler(opts),
    clock: typeof options.clock === "function" ? options.clock : () => Date.now(),
    timers: options.timers || {
      setTimeout: (...args) => setTimeout(...args),
      clearTimeout: (...args) => clearTimeout(...args),
      setInterval: (...args) => setInterval(...args),
      clearInterval: (...args) => clearInterval(...args),
    },
  };
}

const isUniqueViolation = (err) => err instanceof UniqueConstraintError || Boolean(err && err.name === "SequelizeUniqueConstraintError");

/**
 * @param {object} options  the options of the facade, plus `validateInput` and `resolveRecipient` (the facade owns them)
 */
function createOutbox(options = {}) {
  const d = options.deps || createDeps(options);
  const { clock, timers } = d;
  const autoKick = options.autoKick !== false;
  const M = () => d.models();

  let client = null;
  let timer = null;
  let running = false;
  let listener = null;
  let pendingHint = 0; // queued rows, only decides whether a pass has work
  let pausedUntil = 0;
  let busy = false;
  let chain = Promise.resolve();
  let seeding = null;
  let disabling = null;
  let restrictions = [];
  const deferred = new Map(); // row id -> ms until which the row is skipped
  const waiters = new Map(); // publicId -> Set<waiter>
  let waiterCount = 0;

  const sockOf = () => {
    try {
      return client && typeof client.getSocket === "function" ? client.getSocket() : null;
    } catch {
      return null;
    }
  };
  const clientReady = () => {
    if (!client) return false;
    try {
      return typeof client.ready === "function" ? Boolean(client.ready()) : true;
    } catch {
      return false;
    }
  };

  // -------------------------------------------------------------------------------------------------------------------
  // Views and waiters
  // -------------------------------------------------------------------------------------------------------------------

  function viewOf(row) {
    const format = d.formats().get(row.format);
    // an instance fresh from `create` leaves the columns it was not given undefined: the view says null
    const n = (value) => (value === undefined ? null : value);
    return {
      publicId: row.publicId,
      source: row.source,
      apiKeyId: n(row.apiKeyId),
      recipient: row.recipient,
      chatType: String(row.recipient).endsWith("@g.us") ? "group" : "private",
      format: row.format,
      size: n(row.size),
      status: row.status,
      errorCode: n(row.errorCode),
      requestId: n(row.requestId),
      waId: n(row.waId),
      acceptedAt: row.acceptedAt,
      expiresAt: row.expiresAt,
      sendingAt: n(row.sendingAt),
      sentAt: n(row.sentAt),
      deliveredAt: n(row.deliveredAt),
      readAt: n(row.readAt),
      endedAt: n(row.endedAt),
      repliesUntil: n(row.repliesUntil),
      interactive: format ? format.interactive === true : INTERACTIVE_FALLBACK.has(row.format),
      choices: Array.isArray(row.choices) ? row.choices.map((c) => ({ id: c.id, label: c.label })) : null,
      responses: null,
    };
  }

  async function currentView(publicId) {
    const row = await M().ApiMessage.findOne({ where: { publicId } });
    return row ? viewOf(row) : null;
  }

  /** Resolve the waiters of these messages with a fresh view; never rejects */
  async function settleWaiters(publicIds) {
    try {
      const wanted = [...new Set(publicIds)].filter((id) => waiters.has(id));
      if (!wanted.length) return;
      const rows = await M().ApiMessage.findAll({ where: { publicId: { [Op.in]: wanted } } });
      for (const row of rows) {
        const view = viewOf(row);
        for (const waiter of [...(waiters.get(row.publicId) || [])]) waiter.finish(view);
      }
    } catch (err) {
      logger.warn({ err: safeLog(err) }, "waiters could not be settled");
    }
  }

  async function resolveAllWaiters() {
    await settleWaiters([...waiters.keys()]);
    // whatever is left (a row purged meanwhile) ends with nothing
    for (const set of [...waiters.values()]) for (const waiter of [...set]) waiter.finish(null);
  }

  function waitFor(publicId, ms) {
    const limit = clamp(Number(ms) || 0, 0, LIMITS.WAIT_MAX_MS);
    let resolveOuter;
    const promise = new Promise((resolve) => {
      resolveOuter = resolve;
    });
    const waiter = { publicId, handle: null, done: false, registered: false };
    waiter.finish = (view) => {
      if (waiter.done) return;
      waiter.done = true;
      if (waiter.handle) timers.clearTimeout(waiter.handle);
      if (waiter.registered) {
        const set = waiters.get(publicId);
        if (set) {
          set.delete(waiter);
          if (!set.size) waiters.delete(publicId);
        }
        waiterCount -= 1;
      }
      resolveOuter(view);
    };

    // more than WAITERS_MAX waiters, or no time to wait: the current row, at once (not an error)
    const immediate = waiterCount >= LIMITS.WAITERS_MAX || limit === 0;
    if (!immediate) {
      waiter.registered = true;
      waiterCount += 1;
      if (!waiters.has(publicId)) waiters.set(publicId, new Set());
      waiters.get(publicId).add(waiter);
      waiter.handle = timers.setTimeout(() => {
        currentView(publicId).then((view) => waiter.finish(view), () => waiter.finish(null));
      }, limit);
      if (waiter.handle && typeof waiter.handle.unref === "function") waiter.handle.unref();
    }
    // registered first, read second: a settle between the two resolves the waiter through the map
    currentView(publicId).then(
      (view) => {
        if (!view) waiter.finish(null);
        else if (immediate || SETTLED_FOR_WAIT.has(view.status)) waiter.finish(view);
      },
      () => waiter.finish(null),
    );
    return {
      promise,
      cancel() {
        if (waiter.done) return;
        waiter.done = true;
        if (waiter.handle) timers.clearTimeout(waiter.handle);
        if (waiter.registered) {
          const set = waiters.get(publicId);
          if (set) {
            set.delete(waiter);
            if (!set.size) waiters.delete(publicId);
          }
          waiterCount -= 1;
        }
      },
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Row transitions
  // -------------------------------------------------------------------------------------------------------------------

  const dropHint = (n = 1) => {
    pendingHint = Math.max(0, pendingHint - n);
  };

  /** After the terminal UPDATE: the staged directory goes, then the pointer (a crash between leaves a pending deletion) */
  async function releaseStage(row) {
    if (!row || !row.mediaPath) return;
    try {
      await d.stage().remove(row.publicId);
      await M().ApiMessage.update({ mediaPath: null }, { where: { id: row.id } });
    } catch (err) {
      logger.warn({ publicId: row.publicId, err: safeLog(err) }, "staged media not removed (the housekeeping finishes it)");
    }
  }

  /** T4, T5, T6 for one queued row; true when this call won the row */
  async function endQueued(row, status, code, at) {
    const [changed] = await M().ApiMessage.update(
      { status, endedAt: new Date(at), errorCode: code, payload: null },
      { where: { id: row.id, status: "queued" } },
    );
    deferred.delete(row.id);
    if (!changed) return false;
    dropHint();
    await releaseStage(row);
    await settleWaiters([row.publicId]);
    return true;
  }

  /** Bulk cancel under the engine lock (4.8): the queued rows matching `extraWhere` become cancelled with `reason` */
  function cancelQueued(extraWhere, reason) {
    return d.mutex().withLock("api-outbox", async () => {
      const at = clock();
      let total = 0;
      for (;;) {
        const rows = await M().ApiMessage.findAll({
          where: { status: "queued", ...extraWhere },
          attributes: ["id", "publicId", "mediaPath"],
          limit: SWEEP_BATCH,
        });
        if (!rows.length) break;
        const ids = rows.map((row) => row.id);
        const [changed] = await M().ApiMessage.update(
          { status: "cancelled", errorCode: reason, endedAt: new Date(at), payload: null },
          { where: { id: { [Op.in]: ids }, status: "queued" } },
        );
        total += changed;
        dropHint(changed);
        // a row claimed meanwhile lost the compare-and-swap and keeps its stage
        const ended =
          changed === ids.length
            ? rows
            : await M().ApiMessage.findAll({ where: { id: { [Op.in]: ids }, status: "cancelled", errorCode: reason }, attributes: ["id", "publicId", "mediaPath"] });
        for (const row of ended) {
          deferred.delete(row.id);
          await releaseStage(row);
        }
        await settleWaiters(ended.map((row) => row.publicId));
        if (changed === 0) break;
      }
      return total;
    });
  }

  const assertReason = (reason) => {
    if (!Object.hasOwn(CANCEL_REASONS, reason)) throw new TypeError(`unknown cancellation reason: ${reason}`);
    return reason;
  };

  const cancelByKey = (apiKeyId, reason = "key_revoked") => cancelQueued({ apiKeyId }, assertReason(reason));
  const cancelAll = (reason = "api_disabled") => cancelQueued({}, assertReason(reason));

  // -------------------------------------------------------------------------------------------------------------------
  // Admission (4.5)
  // -------------------------------------------------------------------------------------------------------------------

  const spacingMs = () => Math.max(2000, Number(d.config().SEND_MIN_SPACING_MS) || 2000);
  const countPending = (where = {}) => M().ApiMessage.count({ where: { status: { [Op.in]: PENDING }, ...where } });

  async function pendingMediaBytes() {
    const total = await M().ApiMessage.sum("size", { where: { status: { [Op.in]: PENDING }, mediaPath: { [Op.ne]: null } } });
    return Number.isFinite(total) ? total : 0;
  }

  /**
   * The check-only twin of the admission inside `accept`: the global cap, the estimated wait, the pending limit of
   * the key (keyed submissions only) and the disk bound (media only), in that order.
   * @throws {MessagingError} queue_full { scope, retryAfterMs } | pending_limit_reached { limit, retryAfterMs }
   */
  async function admit({ apiKeyId = null, maxPending, mediaSize = 0 } = {}) {
    const config = d.config();
    const spacing = spacingMs();
    const retry = (ms) => clamp(ms, LIMITS.RETRY_MIN_MS, LIMITS.RETRY_MAX_MS);

    const cap = Number(config.API_QUEUE_MAX);
    const pending = await countPending();
    if (pending >= cap) {
      throw new MessagingError("queue_full", { params: { scope: "global", retryAfterMs: retry(spacing * (pending - cap + 1)) } });
    }
    const expiryMs = Number(config.API_QUEUE_EXPIRY_MIN) * 60000;
    const estimate = (pending + 1) * spacing * LIMITS.ADMISSION_FACTOR;
    if (estimate > expiryMs) {
      throw new MessagingError("queue_full", { params: { scope: "wait", retryAfterMs: retry(estimate - expiryMs) } });
    }
    if (apiKeyId !== null && apiKeyId !== undefined) {
      const max = Number.isFinite(Number(maxPending)) && maxPending !== null ? Number(maxPending) : Number(config.API_MAX_PENDING);
      const mine = await countPending({ apiKeyId });
      if (mine >= max) {
        throw new MessagingError("pending_limit_reached", { params: { limit: max, retryAfterMs: retry(spacing * (mine - max + 1)) } });
      }
    }
    if (mediaSize > 0) {
      const bytes = await pendingMediaBytes();
      const bound = 2 * (Number(config.MAX_UPLOAD) || 230) * LIMITS.MB;
      if (bytes + mediaSize > bound) throw new MessagingError("queue_full", { params: { scope: "disk", retryAfterMs: 5000 } });
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Accept (4.2)
  // -------------------------------------------------------------------------------------------------------------------

  const mintPublicId = () => `msg_${Buffer.from(d.mintBytes()()).toString("base64url")}`;

  /**
   * The nine steps of 4.2; the first failure answers and nothing is written (RT-12: the earlier calls of the HTTP
   * layer only order the refusals, this one re-runs them).
   * @returns {Promise<{ message: object, replayed: boolean, requestHash: string|null }>}
   */
  async function accept(request) {
    const at = Number.isFinite(Number(request.now)) && request.now !== undefined && request.now !== null ? Number(request.now) : clock();
    const config = d.config();

    // 1. the switch
    if (!d.apiState().isEnabled()) throw new MessagingError("api_disabled", { params: { reason: "switch_off" } });

    // 2-3. the format and the strict schema, re-run on the stored form; an unreadable `to` joins the other faults
    const to = typeof request.to === "string" ? request.to : request.to && typeof request.to.jid === "string" ? request.to.jid : "";
    const parsed = d.recipients().parseRecipient(to);
    const body = { ...(request.fields || {}), format: request.format, to };
    if (typeof request.quote === "string" && request.quote) body.quote = request.quote;
    let validated;
    try {
      validated = await options.validateInput(request.format, body, { target: parsed.error ? null : parsed, apiKeyId: request.apiKeyId ?? null });
    } catch (err) {
      if (parsed.error && err instanceof MessagingError && err.code === "validation_failed") {
        err.fields = { ...(err.fields || {}), to: { code: "invalid_format" } };
      }
      throw err;
    }
    if (parsed.error) throw new MessagingError("validation_failed", { fields: { to: { code: "invalid_format" } } });

    // 4. the recipient: policy, own number, disabled chat
    const target = await options.resolveRecipient(to, { policy: request.policy || null });

    // 5. media: re-detected from the bytes and capped again (the caller's temporary file is left alone on a refusal)
    const format = d.formats().get(request.format);
    const media = await prepareMedia(request, format);

    // 6. the quote was resolved by validateInput (same key, same chat, left WhatsApp)
    const quote = validated.quoteRef ? { publicId: validated.quoteRef.publicId, waId: validated.quoteRef.waId, format: validated.quoteRef.format } : null;

    // 7. the lock: admission, lazy release of an old idempotency key, stage, INSERT
    const own = { ...validated.fields };
    const fileName = own.fileName;
    delete own.fileName; // moved to payload.media.fileName
    const idempotency = request.idempotency && request.idempotency.key ? request.idempotency : null;
    const apiKeyId = request.apiKeyId ?? null;
    const source = request.source === "panel" ? "panel" : "api";

    const outcome = await d.mutex().withLock("api-outbox", async () => {
      // the switch can turn off between the first check and the lock: disable() cancels under this same lock
      if (!d.apiState().isEnabled()) throw new MessagingError("api_disabled", { params: { reason: "switch_off" } });
      if (idempotency) {
        // an older-than-24h fingerprint is released here; one still inside the window is a replay, answered before
        // the admission (a busy queue never turns a legitimate retry into a refusal)
        await M().ApiMessage.update(
          { idempotencyKey: null, requestHash: null },
          { where: { apiKeyId, idempotencyKey: idempotency.key, acceptedAt: { [Op.lt]: new Date(at - LIMITS.IDEMPOTENCY_MS) } } },
        );
        const stored = await M().ApiMessage.findOne({ where: { apiKeyId, idempotencyKey: idempotency.key } });
        if (stored) return { replayed: stored };
      }
      await admit({
        apiKeyId: source === "api" ? apiKeyId : null,
        maxPending: request.limits ? request.limits.maxPending : undefined,
        mediaSize: media ? media.size : 0,
      });
      const payload = { v: 1, input: own, media: media ? mediaPayload(media, format, fileName) : null, quote };
      const values = {
        apiKeyId,
        source,
        idempotencyKey: idempotency ? idempotency.key : null,
        requestHash: idempotency ? idempotency.requestHash : null,
        recipient: target.jid,
        format: request.format,
        size: d.formats().sizeOf(request.format, own, media),
        status: "queued",
        requestId: request.requestId || null,
        acceptedAt: new Date(at),
        expiresAt: new Date(at + Number(config.API_QUEUE_EXPIRY_MIN) * 60000),
        payload,
        mediaPath: null,
      };
      return insertRow(values, media);
    });

    // 8. a lost idempotency race: the stored row comes back and the caller compares the hashes
    if (outcome.replayed) return { message: viewOf(outcome.replayed), replayed: true, requestHash: outcome.replayed.requestHash };

    // 9. the queue has work
    pendingHint += 1;
    kick();
    return { message: viewOf(outcome.row), replayed: false, requestHash: idempotency ? idempotency.requestHash : null };
  }

  /**
   * INSERT of T1, after the file (if any) is adopted under the new public id (move for the API, copy for the panel).
   * A unique violation is either an idempotency race that slipped past the check in the lock (the stored row is
   * re-read and returned) or, without a file, a public id collision (one more draw, then the error is not hidden).
   * With a file the id is checked free BEFORE the adoption, because the staged directory is named after it and must
   * never be written over. RT-42: whatever refuses the row after the adoption removes the directory this call
   * created; a refusal before it leaves the caller's file where it was.
   */
  async function insertRow(values, media) {
    const dropStage = async (publicId) => {
      try {
        await d.stage().remove(publicId);
      } catch (err) {
        logger.warn({ publicId, err: safeLog(err) }, "staged media not removed (the housekeeping finishes it)");
      }
    };
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let publicId = mintPublicId();
      for (let draw = 0; media && draw < 3 && (await M().ApiMessage.findOne({ where: { publicId }, attributes: ["id"] })); draw += 1) {
        publicId = mintPublicId();
      }
      let adopted = false;
      try {
        const row = { ...values, publicId };
        if (media) {
          row.mediaPath = (await d.stage().adopt(publicId, media.path, { mode: media.mode })).mediaPath;
          adopted = true;
        }
        return { row: await M().ApiMessage.create(row) };
      } catch (err) {
        lastError = err;
        if (adopted) await dropStage(publicId);
        if (!isUniqueViolation(err)) throw err;
        if (values.idempotencyKey) {
          const existing = await M().ApiMessage.findOne({ where: { apiKeyId: values.apiKeyId, idempotencyKey: values.idempotencyKey } });
          if (existing) return { replayed: existing };
        }
        if (media) throw err; // the file was moved: there is nothing left to adopt again
      }
    }
    throw lastError;
  }

  /**
   * Step 5: the media of the request. No file for a format that needs none gives null; a file for a format that
   * takes none is `fields.file = not_allowed`; none for one that requires it `fields.media = required`; else the type
   * is detected again from the bytes and the cap applied (`media_type_mismatch`, `media_too_large`).
   */
  async function prepareMedia(request, format) {
    const given = request.media;
    if (!given) {
      if (format && format.media && format.media.required) throw new MessagingError("validation_failed", { fields: { media: { code: "required" } } });
      return null;
    }
    if (!format || !format.media) throw new MessagingError("validation_failed", { fields: { file: { code: "not_allowed" } } });
    const info = await options.inspectMedia(request.format, given, { name: given.name || undefined });
    return {
      path: given.path,
      mode: given.mode === "copy" ? "copy" : "move",
      source: given.source === "url" ? "url" : "upload",
      name: given.name || null,
      size: info.size,
      mime: info.mime,
      ext: info.ext,
      kind: info.kind,
    };
  }

  /** `payload.media`: how the file arrived, its detected type, and the sanitised name a document is sent under */
  function mediaPayload(media, format, fileName) {
    const raw = fileName || (format && format.name === "document" ? media.name : null);
    return { source: media.source, mime: media.mime, ext: media.ext, size: media.size, fileName: raw ? d.sanitizeName()(raw, media.mime) : null };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The tick (4.3)
  // -------------------------------------------------------------------------------------------------------------------

  /** Reject with ETIMEDOUT after `ms` of the injected timers; the work is not cancelled */
  function race(work, ms) {
    let handle;
    const timeout = new Promise((_, reject) => {
      handle = timers.setTimeout(() => reject(Object.assign(new Error(`operation timed out after ${ms}ms`), { code: "ETIMEDOUT" })), ms);
      if (handle && typeof handle.unref === "function") handle.unref();
    });
    const run = typeof work === "function" ? Promise.resolve().then(work) : Promise.resolve(work);
    return Promise.race([run, timeout]).finally(() => timers.clearTimeout(handle));
  }

  /** One pass, serialised behind the one in progress; never rejects (the test hook and the interval share it) */
  function tick(nowArg) {
    const run = () => pass(nowArg);
    const next = chain.then(run, run);
    chain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  async function pass(nowArg) {
    busy = true;
    try {
      const explicit = nowArg !== undefined && nowArg !== null && Number.isFinite(Number(nowArg));
      const at = explicit ? Number(nowArg) : clock();
      await runPass(at, explicit ? () => at : clock);
    } catch (err) {
      logger.warn({ err: safeLog(err) }, "messaging tick failed");
    } finally {
      busy = false;
    }
  }

  function onInterval() {
    if (busy) return; // the previous pass is still running
    void tick();
  }

  /** A pass at once when idle (after an accept); `autoKick: false` leaves every pass to the interval (tests) */
  function kick() {
    if (autoKick && running && !busy) void tick();
  }

  async function runPass(at, settleAt) {
    if (seeding) await seeding;
    // 1. an idle API costs one empty callback per second and no query
    if (pendingHint === 0) return;
    // 2. expire
    await expireDue(at);
    // 3. gates
    const sock = gatesOpen(at);
    if (!sock) return;
    // 4-10. pick, verify, prepare, build, claim, send, settle
    const candidates = await M().ApiMessage.findAll({
      where: { status: "queued", expiresAt: { [Op.gt]: new Date(at) } },
      order: [
        ["acceptedAt", "ASC"],
        ["id", "ASC"],
      ],
      limit: PICK_BATCH,
    });
    if (!candidates.length) {
      // nothing due: the hint was too high (an expired or cancelled row left it behind)
      if ((await M().ApiMessage.count({ where: { status: "queued" } })) === 0) pendingHint = 0;
      return;
    }
    for (const row of candidates) {
      if (isDeferred(row.id, at)) continue;
      const next = await attempt(row, at, settleAt, sock);
      if (next === "stop") return;
    }
  }

  function isDeferred(id, at) {
    const until = deferred.get(id);
    if (until === undefined) return false;
    if (until <= at) {
      deferred.delete(id);
      return false;
    }
    return true;
  }

  /** T4: the queued rows whose expiry passed, connected or not (FR-037) */
  async function expireDue(at) {
    const due = await M().ApiMessage.findAll({
      where: { status: "queued", expiresAt: { [Op.lte]: new Date(at) } },
      attributes: ["id", "publicId", "mediaPath"],
      limit: SWEEP_BATCH,
    });
    if (!due.length) return;
    const ids = due.map((row) => row.id);
    const [changed] = await M().ApiMessage.update(
      { status: "expired", endedAt: new Date(at), payload: null },
      { where: { id: { [Op.in]: ids }, status: "queued" } },
    );
    dropHint(changed);
    const ended =
      changed === ids.length ? due : await M().ApiMessage.findAll({ where: { id: { [Op.in]: ids }, status: "expired" }, attributes: ["id", "publicId", "mediaPath"] });
    for (const row of ended) {
      deferred.delete(row.id);
      await releaseStage(row);
    }
    await settleWaiters(ended.map((row) => row.publicId));
  }

  /** The socket when a message may leave now, else null (queued rows wait and expire, FR-037) */
  function gatesOpen(at) {
    if (!clientReady()) return null;
    const sock = sockOf();
    if (!sock) return null;
    if (d.maintenance().isActive()) return null;
    if (at < pausedUntil) return null;
    if (!d.gate().ready(at)) return null;
    if (!d.apiState().isEnabled()) return null;
    return sock;
  }

  const failureCodeOf = (err) => (err && Object.hasOwn(FAILURE_CODES, err.code) ? err.code : "send_failed");

  /** One queued row: "next" lets the pass try the following candidate, "stop" ends the pass */
  async function attempt(row, at, settleAt, sock) {
    const recipients = d.recipients();
    const fail = (code) => endQueued(row, "failed", code, at);

    const target = targetOf(row.recipient);
    if (!target) {
      await fail("payload_unavailable");
      return "next";
    }

    // the key guard: the row is read by primary key, uncached, once per send (a revoke applies to the next message)
    if (row.source === "api") {
      const key = row.apiKeyId === null || row.apiKeyId === undefined ? null : await M().ApiKey.findByPk(row.apiKeyId, { attributes: ["id", "revokedAt", "expiresAt"] });
      if (!key || key.revokedAt) {
        await endQueued(row, "cancelled", "key_revoked", at);
        return "next";
      }
      if (key.expiresAt && key.expiresAt.getTime() <= at) {
        await endQueued(row, "cancelled", "key_expired", at);
        return "next";
      }
    }
    if (await recipients.isChatDisabled(target, { bannedChats: d.bannedChats })) {
      await fail("chat_disabled");
      return "next";
    }
    if (recipients.isOwnNumber(target, sock)) {
      await fail("send_failed");
      return "next";
    }

    // the stored content: never a send without it (never a text-only send of a media message)
    const format = d.formats().get(row.format);
    const payload = row.payload;
    if (!format || !payload || typeof payload !== "object" || payload.v !== 1 || !payload.input || typeof payload.input !== "object") {
      await fail("payload_unavailable");
      return "next";
    }
    let media = null;
    let dir = null;
    try {
      dir = d.stage().dirOf(row.publicId);
      if (format.media) {
        if (!row.mediaPath || !payload.media) throw new Error("no staged media");
        const file = d.stage().absolute(row.mediaPath);
        if (!(await fsp.stat(file)).isFile()) throw new Error("the staged media is not a file");
        media = { path: file, mime: payload.media.mime, ext: payload.media.ext, name: payload.media.fileName || undefined, size: payload.media.size };
      }
    } catch {
      await fail("payload_unavailable");
      return "next";
    }

    // 5. verify, nothing has been sent yet: a definitive refusal ends the row, a transient error defers it
    let destination = target.jid;
    let metadata = null;
    try {
      if (target.kind === "group") {
        const posting = await recipients.verifyGroupPosting(sock, target);
        if (posting.failure) {
          await fail(posting.failure);
          return "stop";
        }
        metadata = posting.metadata;
      } else {
        const reach = await recipients.verifyReachable(sock, target, { now: at });
        if (reach.failure) {
          await fail(reach.failure);
          return "stop"; // one lookup per pass: probing numbers in bulk is itself a ban signal
        }
        destination = reach.jid || target.jid;
      }
    } catch (err) {
      deferred.set(row.id, at + LIMITS.VERIFY_DEFER_MS);
      logger.debug({ publicId: row.publicId, err: safeLog(err) }, "recipient check deferred");
      return "stop";
    }

    // 6. prepare while the row is still queued (a crash here loses nothing)
    let prepared = null;
    if (typeof format.prepare === "function") {
      try {
        const budget = media ? LIMITS.SEND_TIMEOUT_MEDIA_MS : LIMITS.SEND_TIMEOUT_MS;
        const signal = AbortSignal.timeout(budget);
        prepared = await race(() => format.prepare({ input: payload.input, media, dir, signal, target }), budget);
      } catch (err) {
        logger.warn({ publicId: row.publicId, format: row.format, err: safeLog(err) }, "message preparation failed");
        await fail("media_conversion_failed");
        return "next";
      }
    }

    // 7. the WhatsApp id exists before anything is built or sent; an echo of it must never be handled
    let waId;
    let built;
    let pollSecret = null;
    try {
      waId = await d.newMessageId()(sock.user && sock.user.id);
      d.sentIds().remember(waId, clock());
      const mentions =
        metadata && Array.isArray(payload.input.mentions) && payload.input.mentions.length ? recipients.mentionJids(metadata, payload.input.mentions) : [];
      built = format.build({
        input: payload.input,
        media,
        prepared: prepared && prepared.path ? prepared : null,
        preview: prepared && prepared.preview ? prepared.preview : null,
        target,
        waId,
        mentions,
        dir,
        randomBytes: crypto.randomBytes,
      });
      if (built && built.secret) pollSecret = d.secretBox().encrypt(Buffer.from(built.secret).toString("hex"), `api-poll:${row.publicId}`);
    } catch (err) {
      logger.warn({ publicId: row.publicId, format: row.format, err: safeLog(err) }, "message could not be built");
      await fail(failureCodeOf(err));
      return "next";
    }
    if (!built || !built.content) {
      await fail("send_failed");
      return "next";
    }

    // 8. the claim, the point of no return: the id is written before sendMessage and never undone
    const claim = { status: "sending", sendingAt: new Date(at), waId };
    if (format.interactive) {
      claim.choices = built.choices || null;
      if (built.replyData) claim.replyData = built.replyData;
      if (pollSecret) claim.pollSecret = pollSecret;
    }
    let claimed;
    try {
      [claimed] = await M().ApiMessage.update(claim, { where: { id: row.id, status: "queued", expiresAt: { [Op.gt]: new Date(at) } } });
    } catch (err) {
      logger.error({ publicId: row.publicId, err: safeLog(err) }, "message not claimed");
      return "stop";
    }
    if (!claimed) return "next"; // a concurrent cancel or expiry won the compare-and-swap
    dropHint();
    deferred.delete(row.id);
    d.gate().reserve(at);
    const done = d.maintenance().begin();
    try {
      await sendAndSettle(row, { format, payload, built, waId, destination, media }, sock, settleAt);
    } finally {
      done();
    }
    return "stop"; // at most one send per pass
  }

  /** 9-10. the single send, then T3 / T7 / T8; never throws */
  async function sendAndSettle(row, ctx, sock, settleAt) {
    const { format, payload, built, waId, destination, media } = ctx;
    const sendOptions = { messageId: waId };
    if (payload.quote && payload.quote.waId) {
      sendOptions.quoted = { key: { remoteJid: destination, fromMe: true, id: payload.quote.waId }, message: quotedShell(payload.quote.format) };
    }

    let failure = null;
    try {
      const budget = media ? LIMITS.SEND_TIMEOUT_MEDIA_MS : LIMITS.SEND_TIMEOUT_MS;
      if (built.transport === "interactive") {
        await race(() => d.buttons().sendPrepared(sock, destination, built.content, sendOptions), budget);
      } else {
        await race(() => sock.sendMessage(destination, built.content, sendOptions), budget);
      }
    } catch (err) {
      failure = err;
    }

    const stamp = settleAt();
    const windowMs = Number(d.config().API_REPLY_WINDOW_DAYS) * DAY_MS;
    let values;
    if (!failure) {
      values = { status: "sent", sentAt: new Date(stamp), payload: null };
      if (format.interactive) values.repliesUntil = new Date(stamp + windowMs);
    } else {
      const kind = d.classify()(failure);
      if (kind === "timeout" || kind === "connection_closed") {
        values = { status: "unknown", endedAt: new Date(stamp), errorCode: kind, payload: null };
        if (format.interactive) values.repliesUntil = new Date(stamp + windowMs); // the message may have left: answers still count
      } else {
        values = { status: "failed", endedAt: new Date(stamp), errorCode: "send_failed", payload: null, choices: null, replyData: null, pollSecret: null, repliesUntil: null };
      }
      logger.warn({ publicId: row.publicId, waId, outcome: values.status, kind, err: safeLog(failure) }, "message send did not complete");
    }

    const result = await settleRow(row, values);
    if (result === "failed") return; // the row stays sending: the next boot (or the 15-minute net) reports it unknown
    logger.debug({ publicId: row.publicId, waId, to: d.recipients().mask(row.recipient), format: row.format, status: values.status }, "message settled");
    await releaseStage(row);
    await settleWaiters([row.publicId]);
  }

  /** T3, T7 or T8: one conditional UPDATE, retried once; a lost race (0 rows) is ignored */
  async function settleRow(row, values) {
    for (let attemptNo = 0; attemptNo < 2; attemptNo += 1) {
      try {
        const [changed] = await M().ApiMessage.update(values, { where: { id: row.id, status: "sending" } });
        return changed > 0 ? "done" : "lost";
      } catch (err) {
        logger.error({ publicId: row.publicId, err: safeLog(err) }, "message state not saved");
      }
    }
    return "failed";
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The 463 breaker (4.6, Y7)
  // -------------------------------------------------------------------------------------------------------------------

  /** A negative ack carrying a restriction code: three within ten minutes pause the queue for fifteen */
  function onRestricted(code, at = clock()) {
    if (!LIMITS.RESTRICTION_CODES.includes(String(code))) return;
    restrictions = restrictions.filter((t) => at - t < LIMITS.RESTRICTION_WINDOW_MS);
    restrictions.push(at);
    if (restrictions.length < LIMITS.RESTRICTION_THRESHOLD) return;
    restrictions = [];
    pausedUntil = at + LIMITS.PAUSE_MS;
    logger.warn({ resumesAt: pausedUntil }, "WhatsApp restriction acks: the API queue is paused");
    try {
      Promise.resolve(d.alerts().raise("api_paused", { resumesAt: pausedUntil })).catch(() => {});
    } catch (err) {
      logger.warn({ err: safeLog(err) }, "api_paused alert not raised");
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Recovery and lifecycle
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Boot recovery (RT-54): every `sending` row becomes `unknown / interrupted` (T8, never resent) and loses its
   * stage; with the switch off every `queued` row becomes `cancelled / api_disabled`.
   */
  async function recover({ now = clock() } = {}) {
    const stuck = await M().ApiMessage.findAll({ where: { status: "sending" }, attributes: ["id", "publicId", "format", "mediaPath"] });
    const windowMs = Number(d.config().API_REPLY_WINDOW_DAYS) * DAY_MS;
    let unknown = 0;
    for (const row of stuck) {
      const interactive = (d.formats().get(row.format) || {}).interactive === true;
      const values = { status: "unknown", endedAt: new Date(now), errorCode: "interrupted", payload: null };
      if (interactive) values.repliesUntil = new Date(now + windowMs);
      const [changed] = await M().ApiMessage.update(values, { where: { id: row.id, status: "sending" } });
      if (changed) {
        unknown += 1;
        await releaseStage(row);
      }
    }
    let cancelled = 0;
    if (!d.apiState().isEnabled()) cancelled = await cancelAll("api_disabled");
    if (unknown || cancelled) logger.info({ unknown, cancelled }, "messaging recovery");
    return { unknown, cancelled };
  }

  function setClient(next) {
    client = next || null;
  }

  function detach() {
    if (listener && client && typeof client.off === "function") client.off("messages.update", listener);
    else if (listener && client && typeof client.removeListener === "function") client.removeListener("messages.update", listener);
    listener = null;
  }

  function stopTimer() {
    if (timer) timers.clearInterval(timer);
    timer = null;
  }

  /** The switch turned on: timer, receipts listener, hint seed, a first pass (idempotent) */
  function enable() {
    if (running || !client) return;
    running = true;
    timer = timers.setInterval(onInterval, LIMITS.TICK_INTERVAL_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
    if (d.receipts && typeof client.on === "function") {
      const handler = typeof d.receipts === "function" ? d.receipts({ models: M(), clock, onRestricted }) : d.receipts;
      if (handler && typeof handler.handle === "function") {
        listener = (updates) => {
          try {
            const result = handler.handle(updates);
            if (result && typeof result.catch === "function") result.catch(() => {});
          } catch (err) {
            logger.debug({ err: safeLog(err) }, "receipt handler failed");
          }
        };
        client.on("messages.update", listener);
      }
    }
    reseed().finally(kick);
  }

  /** Count the queued rows into the hint (never lowers it: an accept in flight keeps its +1); resolves when done */
  function reseed() {
    const run = M()
      .ApiMessage.count({ where: { status: "queued" } })
      .then((n) => {
        pendingHint = Math.max(pendingHint, n);
      })
      .catch(() => {
        pendingHint = Math.max(pendingHint, 1);
      })
      .finally(() => {
        if (seeding === run) seeding = null;
      });
    seeding = run;
    return run;
  }

  /** The switch turned off (FR-002): the timer and the listener go, every queued row is cancelled, waiters end */
  function disable({ reason = "api_disabled" } = {}) {
    if (disabling) return disabling;
    running = false;
    stopTimer();
    detach();
    disabling = (async () => {
      const cancelled = await cancelAll(reason);
      await resolveAllWaiters();
      return { cancelled };
    })().finally(() => {
      disabling = null;
    });
    return disabling;
  }

  /** Shutdown: the timer and the listener go, waiters end, queued rows stay queued (FR-038) */
  async function stop() {
    running = false;
    stopTimer();
    detach();
    await resolveAllWaiters();
  }

  return {
    accept,
    admit,
    tick,
    kick,
    start: setClient,
    setClient,
    reseed,
    ready: () => seeding || Promise.resolve(),
    enable,
    disable,
    stop,
    isRunning: () => running,
    cancelByKey,
    cancelAll,
    recover,
    waitFor,
    onRestricted,
    viewOf,
    pendingMediaBytes,
    countPending,
    spacingMs,
    pausedUntil: () => pausedUntil,
    pendingHint: () => pendingHint,
    waiters: () => waiterCount,
  };
}

module.exports = { createOutbox, createDeps, quotedShell, SHELLS };
