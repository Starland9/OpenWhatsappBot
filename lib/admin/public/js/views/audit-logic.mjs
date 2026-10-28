// Pure logic of the history view (US7, FR-036): the filter form, the AUD-1 query and the way a row's `detail` is
// summarised. No DOM, no network, no timer.

export const PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const RESULTS = ["ok", "fail", "refused"];

// Prefixes of the vocabulary of admin-http-api.md 1.15, for the "action" filter. The server matches a prefix, so
// `setting` covers setting.update, setting.reset and setting.test.
export const ACTION_PREFIXES = [
  "login",
  "logout",
  "setup",
  "reset",
  "account",
  "setting",
  "restart",
  "pair",
  "session",
  "command",
  "group",
  "chat",
  "economy",
  "data",
  "broadcast",
  "backup",
  "update",
  "ytdlp",
  "storage",
  "text",
  "guard",
];

export const EMPTY_FILTERS = Object.freeze({ action: "", result: "", from: "", to: "" });

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A local calendar day `YYYY-MM-DD` -> the Date at its first (or last) instant, or null. */
function dayBound(text, end) {
  const match = DAY.exec(String(text || ""));
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = end ? new Date(year, month - 1, day, 23, 59, 59, 999) : new Date(year, month - 1, day, 0, 0, 0, 0);
  // new Date(2026, 1, 31) rolls over to March: refuse it
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

/**
 * Is the form coherent? `{ ok, errors: { from?, to? } }`: a malformed day is `invalid_format` (a field code of the
 * catalog), an end before the start is `end_before_start` (the view names it with audit.end_before_start).
 */
export function validateFilters(filters) {
  const errors = {};
  const f = { ...EMPTY_FILTERS, ...(filters || {}) };
  const from = f.from ? dayBound(f.from, false) : null;
  const to = f.to ? dayBound(f.to, true) : null;
  if (f.from && !from) errors.from = "invalid_format";
  if (f.to && !to) errors.to = "invalid_format";
  if (from && to && from.getTime() > to.getTime()) errors.to = "end_before_start";
  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Query of `GET /admin/api/audit` from the form and the page. The day filters are the browser's local days
 * (from the first instant of `from` to the last one of `to`), sent as ISO instants. Empty or invalid filters
 * are left out; the page size is kept within the server's limits.
 */
export function buildAuditQuery(filters = {}, page = 1, pageSize = PAGE_SIZE) {
  const f = { ...EMPTY_FILTERS, ...filters };
  const query = {};
  if (/^[a-z0-9.]{1,48}$/.test(f.action)) query.action = f.action;
  if (RESULTS.includes(f.result)) query.result = f.result;
  const from = f.from ? dayBound(f.from, false) : null;
  const to = f.to ? dayBound(f.to, true) : null;
  if (from) query.from = from.toISOString();
  if (to) query.to = to.toISOString();
  query.page = Math.max(1, Math.trunc(Number(page)) || 1);
  query.pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(pageSize)) || PAGE_SIZE));
  return query;
}

/** True when any filter is set (the "reset" button shows only then). */
export function hasFilters(filters) {
  const f = { ...EMPTY_FILTERS, ...(filters || {}) };
  return Boolean(f.action || f.result || f.from || f.to);
}

/** Badge tone of a result. */
export function resultTone(result) {
  if (result === "ok") return "ok";
  if (result === "fail") return "danger";
  if (result === "refused") return "warn";
  return "neutral";
}

const MAX_SUMMARY = 160;

const show = (value) => {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value === "" ? '""' : value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "?";
    }
  }
  return String(value);
};

const cut = (text) => (text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text);

/**
 * How a row's `detail` reads:
 *   { kind: "none" }                                  no detail
 *   { kind: "secret", op: "set" | "clear" }           a secret setting changed (never a value)
 *   { kind: "change", from, to }                      a setting changed: the two values as text
 *   { kind: "text", text, truncated }                 anything else, as compact JSON cut to 160 characters
 */
export function summarizeDetail(detail) {
  if (detail === null || detail === undefined) return { kind: "none" };
  if (typeof detail === "object" && !Array.isArray(detail)) {
    const keys = Object.keys(detail);
    if (detail.secret === true && (detail.op === "set" || detail.op === "clear") && keys.every((k) => k === "secret" || k === "op")) {
      return { kind: "secret", op: detail.op };
    }
    if (keys.length === 2 && keys.includes("from") && keys.includes("to")) {
      return { kind: "change", from: cut(show(detail.from)), to: cut(show(detail.to)) };
    }
    if (!keys.length) return { kind: "none" };
  }
  const text = show(detail);
  return { kind: "text", text: cut(text), truncated: text.length > MAX_SUMMARY };
}
