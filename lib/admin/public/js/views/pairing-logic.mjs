// Pure helpers of the pairing view (PAIR-1 to PAIR-4, FR-023, FR-024). No DOM access, no storage: node:test
// imports this file. The phone number and the pairing code live in the component state only.

import { qrUrl } from "../live.mjs";

export const CODE_COOLDOWN_MS = 30 * 1000; // one code request per 30 s (admin-http-api.md table 1.12)
export const CODE_WINDOW_MS = 3 * 60 * 1000; // a pairing code is valid about 3 minutes
export const PAIRING_STATUSES = ["idle", "connecting", "qr", "open", "reconnecting", "restarting", "stopped", "logged_out"];

// The sentence of the "waiting" and "logged_out" panels, per client status (literal keys, so a scan finds them).
export const STATE_KEYS = Object.freeze({
  idle: "pairing.state_idle",
  connecting: "pairing.state_connecting",
  qr: "pairing.state_qr",
  open: "pairing.state_open",
  reconnecting: "pairing.state_reconnecting",
  restarting: "pairing.state_restarting",
  stopped: "pairing.state_stopped",
  logged_out: "pairing.state_logged_out",
});

// ---- phone number ------------------------------------------------------------------------------

/** What the user typed, without the separators people put in a number: spaces, `+`, `-`, `.` and brackets. */
export function sanitizePhone(input) {
  return String(input ?? "").replace(/[\s+().-]/g, "");
}

export const isValidPhone = (phone) => /^\d{8,15}$/.test(String(phone ?? ""));

/**
 * Check a typed number before PAIR-3. `error` is a field error `{ code }` for the shared Field component, in the
 * vocabulary of the API (`required`, `invalid_phone`); the server checks again.
 * @returns {{ ok: boolean, phone: string, error: { code: string } | null }}
 */
export function validatePhone(input) {
  const phone = sanitizePhone(input);
  if (!phone) return { ok: false, phone, error: { code: "required" } };
  if (!isValidPhone(phone)) return { ok: false, phone, error: { code: "invalid_phone" } };
  return { ok: true, phone, error: null };
}

// ---- pairing code and countdowns ---------------------------------------------------------------

/** "abcd1234" -> "ABCD-1234" (the server already sends this shape; anything else is shown as typed, upper case). */
export function formatPairingCode(raw) {
  const compact = String(raw ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (compact.length === 8) return `${compact.slice(0, 4)}-${compact.slice(4)}`;
  return String(raw ?? "").trim().toUpperCase();
}

/** An ISO string, a Date or a number of ms -> ms, null when it is none of them. */
export function toMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/** Whole seconds left before `deadline` (ceil, never negative); 0 for an unknown deadline. */
export function secondsLeft(deadline, nowMs) {
  const end = toMs(deadline);
  if (end === null) return 0;
  return Math.max(0, Math.ceil((end - nowMs) / 1000));
}

/** 165 -> "2:45", 5 -> "0:05". */
export function formatCountdown(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Remaining cooldown in ms before another code can be requested (0 when it can). */
export function cooldownLeftMs(until, nowMs) {
  const end = toMs(until);
  return end === null ? 0 : Math.max(0, end - nowMs);
}

/**
 * The code the PAIR-3 answer carries, with a deadline on the browser's clock. The server's `expiresAt` is used
 * when it is plausible (between now and the 3-minute window plus a margin); a browser clock that is far off would
 * otherwise show a code as expired the moment it arrives, so the window from the moment of receipt is used then.
 * @returns {{ code: string, deadline: number, cooldownUntil: number }}
 */
export function codeFromAnswer(answer, receivedMs) {
  const remaining = (toMs(answer && answer.expiresAt) ?? NaN) - receivedMs;
  const plausible = Number.isFinite(remaining) && remaining > 0 && remaining <= CODE_WINDOW_MS + 30 * 1000;
  return {
    code: formatPairingCode(answer && answer.code),
    deadline: receivedMs + (plausible ? remaining : CODE_WINDOW_MS),
    cooldownUntil: receivedMs + CODE_COOLDOWN_MS,
  };
}

// ---- which panel for which state ---------------------------------------------------------------

/** A PAIR-1 answer or a `pairing` event, completed with the defaults a missing property deserves. */
export function normalizePairing(payload, previous) {
  const p = payload && typeof payload === "object" ? payload : {};
  const status = PAIRING_STATUSES.includes(p.status) ? p.status : "idle";
  return {
    status,
    registered: Boolean(p.registered),
    number: p.number ? String(p.number).replace(/\D/g, "") || null : null,
    qr: p.qr && p.qr.version !== undefined && p.qr.version !== null ? { version: p.qr.version, issuedAt: p.qr.issuedAt ?? null } : null,
    code: p.code && typeof p.code === "object" ? { pending: Boolean(p.code.pending), expiresAt: p.code.expiresAt ?? null } : null,
    // only PAIR-1 carries the cooldown: a live event keeps the last one known
    codeCooldownMs: Number.isFinite(p.codeCooldownMs) ? p.codeCooldownMs : previous ? previous.codeCooldownMs : 0,
  };
}

/**
 * Which panel the pairing page shows (FR-023, FR-024):
 *   connected   status `open`: the number and the "disconnect" button
 *   pairing     not registered and the socket is `connecting` or `qr`: the QR code and the phone-number form
 *   logged_out  the device was unlinked from the phone: explanation and "pair again"
 *   waiting     any other state (idle, reconnecting, restarting, stopped, or a registered bot that is not open yet):
 *               a sentence that names the state; a registered bot can still be disconnected
 * `logoutAction` is the button shown: `logout` (disconnect), `repair` (pair again after a logout), or null.
 * @returns {{ kind: string, showQr: boolean, showCodeForm: boolean, logoutAction: string|null, statusKey: string|null }}
 */
export function panelFor(view) {
  const status = view && PAIRING_STATUSES.includes(view.status) ? view.status : "idle";
  const registered = Boolean(view && view.registered);

  if (status === "open") {
    return { kind: "connected", showQr: false, showCodeForm: false, logoutAction: "logout", statusKey: null };
  }
  if (status === "logged_out") {
    return { kind: "logged_out", showQr: false, showCodeForm: false, logoutAction: "repair", statusKey: STATE_KEYS.logged_out };
  }
  if (!registered && (status === "connecting" || status === "qr")) {
    return { kind: "pairing", showQr: true, showCodeForm: true, logoutAction: null, statusKey: null };
  }
  // restarting: the bot is busy for a few seconds, nothing to offer; otherwise a registered bot can be disconnected
  const logoutAction = registered && status !== "restarting" ? "logout" : null;
  return { kind: "waiting", showQr: false, showCodeForm: false, logoutAction, statusKey: STATE_KEYS[status] };
}

/** URL of the current QR image, null when the state carries none (PAIR-2 is fetched with the new version). */
export function qrSource(view) {
  return view && view.qr ? qrUrl(view.qr.version) : null;
}

/** True while a code issued by this page is still valid on the browser's clock. */
export const codeIsLive = (issued, nowMs) => Boolean(issued) && secondsLeft(issued.deadline, nowMs) > 0;
