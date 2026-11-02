// Step-up re-authentication of the shell (feature 004, contracts/panel-ui.md section 6, FR-021, research.md X8).
// The server decides (admin-api.md 1.5); the SPA asks early when its own mirror says a request widens access, and
// again when the server answers `403 password_required`. A successful login starts a 5-minute window, so the first
// widening action after a login asks nothing. Not under views/ because any later area can reuse it.
//
// The password lives in the dialog's input and one `useState` only: never in the store, a log, a toast, a URL or
// storage. No `fetch`, no timer, no DOM access at import.

import { api } from "./api.mjs";
import { createStore } from "./ui.mjs";
import { STEP_UP_MARGIN_MS } from "./views/api-logic.mjs";

export { STEP_UP_MARGIN_MS };
export const REAUTH_PATH = "/admin/api/session/reauth";
const DEFAULT_WINDOW_MS = 300000;

/** `request` = `{ id, reasons: [code], resolve }` while the password dialog is wanted, else null. */
export const reauthStore = createStore({ request: null });

// what the browser believes about the confirmation of this session (ms since epoch); the server stays authoritative
let localUntil = 0;
let pending = null;
let seq = 0;

const clockOf = (now) => (typeof now === "function" ? now() : typeof now === "number" ? now : Date.now());

/** True while the confirmation lasts, with a margin so a request never leaves on the last second of the window. */
export function isConfirmed(now = Date.now()) {
  return localUntil > now + STEP_UP_MARGIN_MS;
}

/** After AUTH-7: count `windowMs` from receipt (the server clock is not trusted); 0 when the answer is unusable. */
export function markConfirmed(answer, now = Date.now()) {
  const windowMs = answer ? Number(answer.windowMs) : NaN;
  localUntil = Number.isFinite(windowMs) && windowMs > 0 ? now + windowMs : 0;
  return localUntil;
}

/** From API-1 (`State.stepUp`): the earlier of the server's end and `now + windowMs`; null or unreadable means none. */
export function syncConfirmation(stepUp, now = Date.now()) {
  const until = stepUp && stepUp.confirmedUntil ? Date.parse(stepUp.confirmedUntil) : NaN;
  const window = stepUp && Number(stepUp.windowMs) > 0 ? Number(stepUp.windowMs) : DEFAULT_WINDOW_MS;
  localUntil = Number.isFinite(until) ? Math.min(until, now + window) : 0;
  return localUntil;
}

export function forgetConfirmation() {
  localUntil = 0;
}

/** Ask for the password. One dialog at a time: a second call gets the pending promise. Resolves true or false. */
export function requestReauth({ reasons = [] } = {}) {
  if (pending) return pending;
  let resolve;
  pending = new Promise((done) => {
    resolve = done;
  });
  reauthStore.set({ request: { id: ++seq, reasons: [...reasons], resolve } });
  return pending;
}

/** The dialog's answer: true (confirmed) or false (cancelled, Escape). */
export function resolveReauth(result) {
  const { request } = reauthStore.get();
  if (!request) return;
  pending = null;
  reauthStore.set({ request: null });
  request.resolve(Boolean(result));
}

/**
 * Run a guarded request. `needed` says the SPA's mirror found the request widening: ask first when the window is
 * over (a refusal sends nothing). If the server still answers `password_required`, forget the belief, ask once more
 * and retry ONCE; a second `password_required` goes to the caller, every other error is rethrown untouched.
 * Resolves `{ ok: true, value }` or `{ ok: false, cancelled: true }` (a user cancel is not an error to toast).
 */
export async function withStepUp(run, { needed = false, reasons = [], ask = requestReauth, now = Date.now } = {}) {
  if (needed && !isConfirmed(clockOf(now))) {
    if (!(await ask({ reasons }))) return { ok: false, cancelled: true };
  }
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    if (!err || err.code !== "password_required") throw err;
    forgetConfirmation();
    const wanted = reasons.length ? reasons : Array.isArray(err.params && err.params.reasons) ? err.params.reasons : [];
    if (!(await ask({ reasons: wanted }))) return { ok: false, cancelled: true };
    return { ok: true, value: await run() };
  }
}

/** AUTH-7 with the typed password; the answer starts the local window. Errors reach the dialog. */
export async function submitPassword(password, { apiImpl, now } = {}) {
  const answer = apiImpl ? await apiImpl("POST", REAUTH_PATH, { password }) : await api("POST", REAUTH_PATH, { password });
  markConfirmed(answer, clockOf(now));
  return answer;
}

/** `wrong` (422 on the password field), `throttled` (429) or `other`. */
export function classifyReauthError(err) {
  if (err && (err.status === 429 || err.code === "rate_limited")) return "throttled";
  if (err && err.status === 422 && err.fields && err.fields.password) return "wrong";
  return "other";
}
