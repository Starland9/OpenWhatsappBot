"use strict";

/**
 * Pairing service of the admin panel (admin-http-api.md section 2.4, PAIR-1 to PAIR-4; contracts/runtime.md
 * section 6 for the client side). It never touches `req`/`res`.
 *
 *   const pairing = createPairingService({ getClient, hub, now, logger, loadQr, redactor });
 *   pairing.view(at)            PAIR-1 and `pairing` hub payload: { status, registered, number, qr, code }
 *                               (the QR string and the pairing code are never part of it)
 *   pairing.describe(at)        the same plus `codeCooldownMs` (PAIR-1 only)
 *   pairing.qrSvg()             PAIR-2: the current QR as an SVG string, or null when there is none
 *   pairing.parsePhone(raw)     digits of a typed number, or a `validation_failed` / `fields.phone` error
 *   pairing.requestCode(phone)  PAIR-3: { code, expiresAt } (ISO), the ONLY place the code ever leaves
 *   pairing.closeSession()      PAIR-4: client.resetSession(), { removed }
 *   pairing.start() / stop()    subscribe the client `qr` and `state` events, publish the hub `pairing` topic and
 *                               register its snapshot; both idempotent
 *
 * Secrets: the QR string is account-takeover material and the code is a one-time credential. Neither is logged,
 * audited or echoed in an error; both are registered with the log redactor as ephemeral secrets (the client does
 * it too: registering the same name again only refreshes the value).
 *
 * Time: everything that depends on the clock takes `at` (default `now()`); no timer exists here.
 */

const { AdminError } = require("../http/response");

const CODE_COOLDOWN_MS = 30 * 1000; // one pairing code request per 30 s (table 1.12)
const QR_SECRET_TTL_MS = 5 * 60 * 1000;
const CODE_SECRET_TTL_MS = 3 * 60 * 1000 + 10 * 1000; // the code lives about 3 minutes
const PHONE_RE = /^\d{8,15}$/;

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** Digits only after stripping spaces and "+" (the contract's rule; anything else stays and fails the pattern). */
const normalizePhone = (value) => String(value ?? "").replace(/[\s+]/g, "");

/** "..12": the only trace of a phone number allowed in the audit trail. */
const last2Of = (phone) => `..${String(phone).slice(-2)}`;

function createPairingService({
  getClient,
  hub,
  now = () => Date.now(),
  logger,
  loadQr = () => require("qrcode"),
  redactor,
} = {}) {
  const clientOf = typeof getClient === "function" ? getClient : () => getClient;
  const redact = () => redactor || require("../logs/redactor");

  let lastCodeAt = null; // service clock, ms: when the last code request was accepted
  let qrCache = null; // { qr, svg }: the rendering of the QR string currently held by the client
  let listening = null; // the client whose events we follow
  let lastKey = null; // JSON of the last published payload (dedupe)
  let lastCoarse = null; // status|registered|number: when it changes the dashboard state is republished

  // ---- views ------------------------------------------------------------------------------

  /** The `pairing` payload (PAIR-1 without the cooldown). */
  function view(at = now()) {
    const client = clientOf();
    if (!client || typeof client.getState !== "function") {
      return { status: "idle", registered: false, number: null, qr: null, code: null };
    }
    const state = client.getState();
    const pairing = state.pairing;
    const number = state.me && state.me.number ? String(state.me.number).replace(/\D/g, "") : "";
    return {
      status: state.status,
      registered: Boolean(state.registered),
      number: number || null,
      qr: state.hasQr && state.qrVersion ? { version: state.qrVersion, issuedAt: iso(state.qrIssuedAt) } : null,
      code:
        pairing && Number.isFinite(pairing.expiresAt)
          ? { pending: pairing.expiresAt > at, expiresAt: iso(pairing.expiresAt) }
          : null,
    };
  }

  /** Remaining cooldown of the code request, in ms (0 when a code can be requested now). */
  function cooldownLeft(at = now()) {
    if (lastCodeAt === null) return 0;
    return Math.min(CODE_COOLDOWN_MS, Math.max(0, lastCodeAt + CODE_COOLDOWN_MS - at));
  }

  const describe = (at = now()) => ({ ...view(at), codeCooldownMs: cooldownLeft(at) });

  // ---- PAIR-2 -----------------------------------------------------------------------------

  /** The current QR as an SVG document, or null. The `v` of the URL is a cache-buster only. */
  async function qrSvg() {
    const client = clientOf();
    if (!client || typeof client.getPairingArtifacts !== "function") return null;
    const { qr, qrVersion } = client.getPairingArtifacts();
    if (!qr || typeof qr !== "string") return null;
    if (qrCache && qrCache.qr === qr) return qrCache.svg;
    try {
      redact().registerEphemeral(`qr:${qrVersion}`, qr, QR_SECRET_TTL_MS);
    } catch {
      // redaction is a safety net, never a reason to lose the QR
    }
    const svg = await loadQr().toString(qr, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
    qrCache = { qr, svg };
    return svg;
  }

  // ---- PAIR-3 -----------------------------------------------------------------------------

  /** `phone` as digits, else 422 `fields.phone = invalid_phone`. */
  function parsePhone(raw) {
    const phone = normalizePhone(raw);
    if (!PHONE_RE.test(phone)) {
      throw new AdminError("validation_failed", { fields: { phone: { code: "invalid_phone" } } });
    }
    return phone;
  }

  /**
   * Ask for a pairing code. Preconditions in the client's own order (already paired, socket not open, throttle) so
   * that the answer does not depend on which side notices first; the slot is claimed BEFORE the await, so a double
   * click is refused instead of reaching WhatsApp twice.
   * @param {string} phone  digits from parsePhone()
   * @returns {Promise<{ code: string, expiresAt: string }>}
   */
  async function requestCode(phone, at = now()) {
    const client = clientOf();
    if (!client || typeof client.requestPairingCode !== "function") throw new AdminError("not_connected");
    const state = client.getState();
    if (state.registered) throw new AdminError("already_paired");
    if (state.status !== "connecting" && state.status !== "qr") throw new AdminError("not_connected");
    const wait = cooldownLeft(at);
    if (wait > 0) throw new AdminError("rate_limited", { params: { retryAfterMs: wait } });

    const previous = lastCodeAt;
    lastCodeAt = at;
    let result;
    try {
      result = await client.requestPairingCode(phone);
    } catch (err) {
      throw mapClientError(err, at, previous);
    }
    const code = result && typeof result.code === "string" ? result.code : "";
    if (!code) throw new AdminError("whatsapp_error");
    try {
      const compact = code.replace(/[^A-Za-z0-9]/g, "");
      redact().registerEphemeral("pairing-code", code, CODE_SECRET_TTL_MS);
      if (compact !== code) redact().registerEphemeral("pairing-code-plain", compact, CODE_SECRET_TTL_MS);
    } catch {
      // safety net only
    }
    return { code, expiresAt: iso(result.expiresAt) };
  }

  /** ClientError (lib/baileys/client.js) -> the envelope code; the cooldown follows what actually happened. */
  function mapClientError(err, at, previous) {
    const code = err && err.code;
    if (code === "invalid_phone") {
      lastCodeAt = previous;
      return new AdminError("validation_failed", { fields: { phone: { code: "invalid_phone" } } });
    }
    if (code === "already_registered") {
      lastCodeAt = previous;
      return new AdminError("already_paired");
    }
    if (code === "not_connecting") {
      lastCodeAt = previous;
      return new AdminError("not_connected");
    }
    if (code === "rate_limited") {
      const retryAfterMs = Number(err.params && err.params.retryAfterMs) || CODE_COOLDOWN_MS;
      lastCodeAt = at + retryAfterMs - CODE_COOLDOWN_MS;
      return new AdminError("rate_limited", { params: { retryAfterMs } });
    }
    if (code === "pairing_failed") {
      // the client counted the attempt: the cooldown stays
      return new AdminError("whatsapp_error");
    }
    lastCodeAt = previous;
    return err; // unexpected: the router answers 500 and logs it with the reduced error
  }

  // ---- PAIR-4 -----------------------------------------------------------------------------

  /** Close the session on WhatsApp and wipe it; works with the socket already down. */
  async function closeSession() {
    const client = clientOf();
    if (!client || typeof client.resetSession !== "function") throw new AdminError("not_connected");
    const result = await client.resetSession();
    lastCodeAt = null;
    qrCache = null;
    return { removed: result && Number.isFinite(result.removed) ? result.removed : 0 };
  }

  // ---- live publication -------------------------------------------------------------------

  const coarseOf = (payload) => `${payload.status}|${payload.registered}|${payload.number}`;

  function publishIfChanged() {
    try {
      const payload = view();
      const key = JSON.stringify(payload);
      if (key === lastKey) return;
      lastKey = key;
      hub.publish("pairing", payload);
      const coarse = coarseOf(payload);
      if (coarse !== lastCoarse) {
        lastCoarse = coarse;
        // the dashboard state carries the same status and number: push it at once (FR-012, SC-006)
        if (typeof hub.publishState === "function") hub.publishState({ force: true }).catch(() => {});
      }
    } catch (err) {
      if (logger && logger.debug) logger.debug({ name: err && err.name }, "admin pairing: publish failed");
    }
  }

  function start() {
    if (listening) return;
    // what a stream gets as its first event is the snapshot: only a CHANGE from here on is published
    const current = view();
    lastKey = JSON.stringify(current);
    lastCoarse = coarseOf(current);
    const client = clientOf();
    if (client && typeof client.on === "function") {
      client.on("qr", publishIfChanged);
      client.on("state", publishIfChanged);
      listening = client;
    }
    hub.setSnapshot("pairing", () => view());
  }

  function stop() {
    if (listening && typeof listening.off === "function") {
      listening.off("qr", publishIfChanged);
      listening.off("state", publishIfChanged);
    }
    listening = null;
    hub.setSnapshot("pairing", null);
    qrCache = null;
    lastKey = null;
    lastCoarse = null;
  }

  return { view, describe, cooldownLeft, qrSvg, parsePhone, requestCode, closeSession, start, stop };
}

module.exports = { createPairingService, CODE_COOLDOWN_MS, normalizePhone, last2Of };
