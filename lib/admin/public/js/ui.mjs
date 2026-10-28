// Shared UI state and helpers: small stores, the session and bot-state stores, the confirmation helper
// used by every destructive action (FR-039), toasts, theme application (FR-041), the client-side
// `no_https` banner (FR-009) and the unsaved-input warning. No DOM access at import time.

import { api, setCsrf } from "./api.mjs";
import { live } from "./live.mjs";
import { setLanguage, detectLanguage, tError, t } from "./i18n.mjs";
import { restartFailureReason } from "./views/dashboard-logic.mjs";

// ---- stores ----------------------------------------------------------------------------------

/** Minimal observable store: `get()`, `set(patchOrFn)`, `subscribe(fn)` (returns the unsubscribe). */
export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      state = typeof patch === "function" ? patch(state) : { ...state, ...patch };
      for (const fn of [...subs]) fn(state);
      return state;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** What AUTH-1 told us (plus the login/setup answers). `loaded` is false until the first answer. */
export const sessionStore = createStore({
  loaded: false,
  loadError: null,
  accountExists: false,
  authenticated: false,
  https: false,
  proxyHint: false,
  setup: null,
  account: null,
  session: null,
  bot: null,
});

/** Latest DASH-1 object pushed by the live stream (null until the first one), plus the transport mode. */
export const botStore = createStore({ state: null, connection: "idle" });

// ---- theme -----------------------------------------------------------------------------------

export const THEMES = ["auto", "light", "dark"];
export const THEME_STORAGE_KEY = "owb.theme";

function readStorage(key) {
  try {
    return globalThis.localStorage ? globalThis.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem(key, value);
  } catch {
    // storage blocked: the theme still applies for this page
  }
}

/** `auto` follows the device (no attribute, theme.css uses prefers-color-scheme); light/dark force it. */
export function applyTheme(theme, root = globalThis.document && globalThis.document.documentElement) {
  const value = THEMES.includes(theme) ? theme : "auto";
  if (root) {
    if (value === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", value);
  }
  writeStorage(THEME_STORAGE_KEY, value);
  return value;
}

/** Apply the last theme and language used on this browser before the account is known. */
export async function initPreferences() {
  const saved = readStorage(THEME_STORAGE_KEY);
  applyTheme(THEMES.includes(saved) ? saved : "auto");
  await setLanguage(detectLanguage(), { remember: false });
}

/** Apply `account.uiLang` and `account.theme` (AUTH-1, login, setup, AUTH-6). */
export async function applyAccountPreferences(account) {
  if (!account) return;
  applyTheme(account.theme);
  await setLanguage(account.uiLang);
}

// ---- session ---------------------------------------------------------------------------------

/** Merge an auth answer (`{ csrf, account, session }`, with `purpose` for setup) into the session store. */
export async function applyAuthenticated(answer) {
  if (answer && typeof answer.csrf === "string") setCsrf(answer.csrf);
  await applyAccountPreferences(answer && answer.account);
  sessionStore.set({
    loaded: true,
    loadError: null,
    accountExists: true,
    authenticated: true,
    setup: null,
    account: (answer && answer.account) || sessionStore.get().account,
    session: (answer && answer.session) || sessionStore.get().session,
    bot: (answer && answer.bot) || sessionStore.get().bot,
  });
}

/** AUTH-1: who are we, is there an account, is a setup link valid. Never throws. */
export async function loadSession() {
  try {
    const data = await api("GET", "/admin/api/session");
    if (data.authenticated) {
      const { csrf, ...rest } = data; // the token stays in api.mjs only
      await applyAccountPreferences(rest.account);
      sessionStore.set({ ...rest, loaded: true, loadError: null, setup: null });
    } else {
      setCsrf(null);
      sessionStore.set({
        loaded: true,
        loadError: null,
        accountExists: Boolean(data.accountExists),
        authenticated: false,
        https: Boolean(data.https),
        proxyHint: Boolean(data.proxyHint),
        setup: data.setup || null,
        account: null,
        session: null,
        bot: null,
      });
    }
  } catch (err) {
    // keep the screen: the app offers a retry instead of guessing whether an account exists
    sessionStore.set({ loaded: true, authenticated: false, loadError: (err && err.code) || "network_error" });
  }
  return sessionStore.get();
}

/** Back to the logged-out state without a request (after a 401 or a logout). */
export function clearSession() {
  setCsrf(null);
  botStore.set({ state: null });
  sessionStore.set({ authenticated: false, account: null, session: null, bot: null, setup: null });
}

// ---- confirmation (FR-039) -------------------------------------------------------------------

export const confirmStore = createStore({ request: null });
const confirmQueue = [];
let confirmSeq = 0;

function showNextConfirm() {
  if (confirmStore.get().request || !confirmQueue.length) return;
  confirmStore.set({ request: confirmQueue.shift() });
}

/**
 * Ask before a destructive or disruptive action. Resolves true (confirmed) or false (cancelled, Escape).
 * `{ title, message, confirmLabel, cancelLabel, danger = true }`; `cancelLabel: null` shows one button
 * (a notice). Texts are already translated by the caller; labels default to common.confirm/common.cancel.
 */
export function confirm(options = {}) {
  return new Promise((resolve) => {
    confirmQueue.push({
      id: ++confirmSeq,
      title: options.title || t("common.confirm_title"),
      message: options.message || "",
      confirmLabel: options.confirmLabel || t("common.confirm"),
      cancelLabel: options.cancelLabel === null ? null : options.cancelLabel || t("common.cancel"),
      danger: options.danger !== false,
      resolve,
    });
    showNextConfirm();
  });
}

export function resolveConfirm(result) {
  const { request } = confirmStore.get();
  if (!request) return;
  confirmStore.set({ request: null });
  request.resolve(Boolean(result));
  showNextConfirm();
}

// ---- toasts ----------------------------------------------------------------------------------

export const toastStore = createStore({ items: [] });
let toastSeq = 0;

export function dismissToast(id) {
  toastStore.set((s) => ({ ...s, items: s.items.filter((item) => item.id !== id) }));
}

/** `toast(message, { kind: "info" | "success" | "error", ttl })`; errors stay longer. Returns the id. */
export function toast(message, { kind = "info", ttl } = {}) {
  const id = ++toastSeq;
  toastStore.set((s) => ({ ...s, items: [...s.items.slice(-3), { id, kind, message: String(message) }] }));
  const life = ttl ?? (kind === "error" ? 9000 : 4500);
  if (life > 0 && typeof setTimeout === "function") {
    const handle = setTimeout(() => dismissToast(id), life);
    if (handle && typeof handle.unref === "function") handle.unref();
  }
  return id;
}

export const toastSuccess = (message) => toast(message, { kind: "success" });
export const toastError = (err) => toast(typeof err === "string" ? err : tError(err), { kind: "error" });

// ---- unsaved input ---------------------------------------------------------------------------

const dirtyKeys = new Set();

/** A view marks a form dirty (`setDirty("settings", true)`) and clean again after a save. */
export function setDirty(key, dirty) {
  if (dirty) dirtyKeys.add(key);
  else dirtyKeys.delete(key);
}

export const hasUnsaved = () => dirtyKeys.size > 0;
export const clearDirty = () => dirtyKeys.clear();

/** Ask before leaving a page with unsaved input; true when it is fine to go on. */
export async function confirmLeave() {
  if (!hasUnsaved()) return true;
  const ok = await confirm({
    title: t("common.unsaved_title"),
    message: t("common.unsaved_message"),
    confirmLabel: t("common.leave_page"),
  });
  if (ok) clearDirty();
  return ok;
}

/** Browser-level guard for a reload or a closed tab while something is unsaved. */
export function installUnsavedGuard(win = globalThis) {
  if (!win || typeof win.addEventListener !== "function") return () => {};
  const handler = (event) => {
    if (!hasUnsaved()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  win.addEventListener("beforeunload", handler);
  return () => win.removeEventListener("beforeunload", handler);
}

// ---- banners ---------------------------------------------------------------------------------

export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

/** FR-009: true when the page is not served over HTTPS and the host is not a loopback address. */
export function isInsecureRemote(loc = globalThis.location) {
  if (!loc) return false;
  return loc.protocol !== "https:" && !LOOPBACK_HOSTS.includes(String(loc.hostname).toLowerCase());
}

/**
 * Banners to show: the server's (`state.banners`), the client-side `no_https`, and, before login,
 * `undeclared_proxy` when AUTH-1 reported `proxyHint`.
 */
export function collectBanners({ state, session, loc } = {}) {
  const banners = Array.isArray(state && state.banners) ? state.banners.map((b) => ({ ...b })) : [];
  if (session && !session.authenticated && session.proxyHint && !banners.some((b) => b.id === "undeclared_proxy")) {
    banners.push({ id: "undeclared_proxy", severity: "warn", params: { headers: "X-Forwarded-*" } });
  }
  if (isInsecureRemote(loc)) banners.unshift({ id: "no_https", severity: "warn", params: {} });
  return banners;
}

// ---- restart (RST-1) from outside the dashboard -----------------------------------------------

const RESTART_FOLLOW_MS = 5 * 60 * 1000;

/**
 * The "Restart" button of the `restart_needed` banner (the dashboard has its own control with the same texts):
 * ask first (FR-039), start RST-1 with `confirm: true`, then say how the `restart` job ended. Resolves true when a
 * restart was started, false when the administrator cancelled or the server refused (the error is toasted).
 */
export async function requestRestart({ apiImpl = api, liveImpl = live } = {}) {
  const ok = await confirm({
    title: t("dashboard.restart_title"),
    message: t("dashboard.restart_message"),
    confirmLabel: t("dashboard.restart_confirm"),
  });
  if (!ok) return false;
  let answer;
  try {
    answer = await apiImpl("POST", "/admin/api/restart", { confirm: true });
  } catch (err) {
    toastError(err);
    return false;
  }
  toast(t("banners.restart_started"), { kind: "info" });
  const id = answer && answer.job && answer.job.id;
  if (id === undefined || id === null) return true;
  let off = () => {};
  let unwatch = () => {};
  let timer = null;
  const stop = () => {
    off();
    unwatch();
    if (timer) clearTimeout(timer);
  };
  off = liveImpl.subscribe(
    "job",
    (event) => {
      if (!event || event.id !== id || event.status === "running") return;
      stop();
      if (event.status === "done") toastSuccess(t("dashboard.restart_done"));
      else toastError(t("dashboard.restart_failed", { reason: t(`dashboard.restart_reason_${restartFailureReason(event)}`) }));
    },
    { replay: false },
  );
  unwatch = liveImpl.watchJob(id);
  if (typeof setTimeout === "function") {
    timer = setTimeout(stop, RESTART_FOLLOW_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
  }
  return true;
}

// ---- bot status ------------------------------------------------------------------------------

export const BOT_STATUSES = ["idle", "connecting", "qr", "open", "reconnecting", "restarting", "stopped", "logged_out"];

/** Badge tone for a client status (FR-012). */
export function statusTone(status) {
  if (status === "open") return "ok";
  if (status === "qr" || status === "logged_out") return "warn";
  if (status === "connecting" || status === "reconnecting" || status === "restarting") return "info";
  return "neutral";
}
