// Panel translations (FR-037). Independent of the bot language (BOT_LANG): the language comes from the
// account (`account.uiLang`), else the browser. Catalogs are flat JSON maps (`"nav.dashboard": "..."`)
// served from /admin/i18n/<lang>.json; a nested catalog is flattened on load.
// No DOM access at import time, so node:test can load this module.

export const LANGUAGES = ["fr", "en"];
export const FALLBACK_LANGUAGE = "en";
export const LANG_STORAGE_KEY = "owb.lang";

const catalogs = { en: Object.create(null), fr: Object.create(null) };
let current = FALLBACK_LANGUAGE;
const listeners = new Set();

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Flat `{ "a.b": "text" }` view of a flat or nested catalog (non-string leaves are ignored). */
export function flatten(data, prefix = "", out = Object.create(null)) {
  for (const [key, value] of Object.entries(data || {})) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[full] = value;
    else if (value && typeof value === "object" && !Array.isArray(value)) flatten(value, full, out);
  }
  return out;
}

export function setCatalog(lang, data) {
  catalogs[lang] = flatten(data);
}

export function hasKey(key, lang = current) {
  return has(catalogs[lang] || {}, key) || has(catalogs[FALLBACK_LANGUAGE], key);
}

export function getLanguage() {
  return current;
}

export function onLanguageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

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
    // storage blocked: the language still applies for this page
  }
}

/** Language to use before the account is known: last choice, else the browser, else English. */
export function detectLanguage(nav = globalThis.navigator) {
  const saved = readStorage(LANG_STORAGE_KEY);
  if (LANGUAGES.includes(saved)) return saved;
  const candidates = [...((nav && nav.languages) || []), nav && nav.language].filter(Boolean);
  for (const candidate of candidates) {
    const base = String(candidate).toLowerCase().split("-")[0];
    if (LANGUAGES.includes(base)) return base;
  }
  return FALLBACK_LANGUAGE;
}

export async function loadCatalog(lang, fetchImpl = globalThis.fetch) {
  if (!LANGUAGES.includes(lang)) throw new Error("unknown_language");
  const res = await fetchImpl(`/admin/i18n/${lang}.json`, { credentials: "same-origin" });
  if (!res || !res.ok) throw new Error("catalog_unavailable");
  setCatalog(lang, await res.json());
}

/**
 * Load the catalogs (English always, as the fallback) and switch to `lang`.
 * A catalog that cannot be loaded is not fatal: `t()` falls back to English, then to the key.
 */
export async function setLanguage(lang, { fetch: fetchImpl, remember = true } = {}) {
  const wanted = LANGUAGES.includes(lang) ? lang : FALLBACK_LANGUAGE;
  let ok = true;
  for (const code of new Set([FALLBACK_LANGUAGE, wanted])) {
    if (Object.keys(catalogs[code]).length) continue;
    try {
      await loadCatalog(code, fetchImpl);
    } catch {
      ok = false;
    }
  }
  const changed = current !== wanted;
  current = wanted;
  if (remember) writeStorage(LANG_STORAGE_KEY, wanted);
  if (typeof document !== "undefined" && document.documentElement) document.documentElement.lang = wanted;
  if (changed) for (const fn of [...listeners]) fn(wanted);
  return ok;
}

function format(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(format).join(", ");
  return String(value);
}

function pluralCategory(lang, count) {
  try {
    return new Intl.PluralRules(lang).select(count);
  } catch {
    return count === 1 ? "one" : "other";
  }
}

function pick(key, params) {
  const count = params && typeof params.count === "number" ? params.count : null;
  for (const lang of [current, FALLBACK_LANGUAGE]) {
    const catalog = catalogs[lang];
    if (count !== null) {
      const specific = `${key}_${pluralCategory(lang, count)}`;
      if (has(catalog, specific)) return catalog[specific];
      if (has(catalog, `${key}_other`)) return catalog[`${key}_other`];
    }
    if (has(catalog, key)) return catalog[key];
  }
  return undefined;
}

/**
 * Translate `key`, replacing `{name}` with `params.name` (arrays are joined with ", ").
 * Plurals: with a numeric `params.count`, `key_one` / `key_other`... are tried first (Intl.PluralRules).
 * A missing key returns the key itself, so a gap is visible without breaking the page.
 */
export function t(key, params) {
  const template = pick(key, params);
  if (template === undefined) return String(key);
  if (!params) return template;
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => (has(params, name) ? format(params[name]) : match));
}

/** "45 s", "15 min", "2 h": a delay for messages such as "retry in {retryAfter}". */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.ceil(Number(ms) / 1000) || 0);
  if (seconds >= 3600) return t("common.duration_hours", { n: Math.ceil(seconds / 3600) });
  if (seconds >= 60) return t("common.duration_minutes", { n: Math.ceil(seconds / 60) });
  return t("common.duration_seconds", { n: seconds });
}

function codeOf(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.code === "string") return value.code;
  return "unknown";
}

/** Message for an ApiError (or an envelope code): `errors.<code>`, else `errors.unknown`. */
export function tError(err) {
  const code = codeOf(err);
  const params = { ...((err && err.params) || {}), code };
  const retry = (err && err.retryAfterMs) ?? params.retryAfterMs;
  params.retryAfter = typeof retry === "number" ? formatDuration(retry) : t("common.moment");
  params.requestId = (err && err.requestId) || "-";
  const key = `errors.${code}`;
  return hasKey(key) ? t(key, params) : t("errors.unknown", params);
}

/** Message for a field error `{ code, params }` (or just its code): `fields.<code>`, else `fields.unknown`. */
export function tField(codeOrField, params) {
  const code = codeOf(codeOrField);
  const all = { ...((codeOrField && codeOrField.params) || {}), ...(params || {}), code };
  const key = `fields.${code}`;
  return hasKey(key) ? t(key, all) : t("fields.unknown", all);
}

function locale() {
  return current === "fr" ? "fr-FR" : "en-GB";
}

export function formatDateTime(value, options = { dateStyle: "medium", timeStyle: "short" }) {
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale(), options).format(date);
}

export function formatNumber(value, options) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return new Intl.NumberFormat(locale(), options).format(n);
}

/** 1536 -> "1.5 KB" (binary units, one decimal under 10). */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${formatNumber(value, { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${units[unit]}`;
}

/** 93784 s -> "1 d 2 h 3 min" (the two or three biggest non-zero parts). */
export function formatUptime(totalSeconds) {
  let rest = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const days = Math.floor(rest / 86400);
  rest -= days * 86400;
  const hours = Math.floor(rest / 3600);
  rest -= hours * 3600;
  const minutes = Math.floor(rest / 60);
  const seconds = rest - minutes * 60;
  const parts = [];
  if (days) parts.push(t("common.duration_days", { n: days }));
  if (hours) parts.push(t("common.duration_hours", { n: hours }));
  if (minutes && parts.length < 3) parts.push(t("common.duration_minutes", { n: minutes }));
  if (!parts.length) parts.push(t("common.duration_seconds", { n: seconds }));
  return parts.join(" ");
}

export function __resetForTests() {
  catalogs.en = Object.create(null);
  catalogs.fr = Object.create(null);
  current = FALLBACK_LANGUAGE;
  listeners.clear();
}
