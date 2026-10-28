// Pure logic of the logs view (US7, FR-034): no DOM, no network, no timer. The server keeps the last 1000 entries
// (lib/admin/logs/ring.js) and answers `GET /admin/api/logs` with the same filtering rules as the functions below,
// so the view can filter what it already holds without asking again.

export const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];
export const MAX_ENTRIES = 1000; // the size of the server's ring
export const MAX_QUERY_LENGTH = 100; // LOG-1 `q`
export const PAGE_SIZE = 100;

const RANK = Object.fromEntries(LEVELS.map((level, index) => [level, index]));

/** Position of a level name (trace = 0 ... fatal = 5), -1 for anything else. */
export function levelRank(level) {
  return Object.hasOwn(RANK, String(level).toLowerCase()) ? RANK[String(level).toLowerCase()] : -1;
}

/**
 * The minimum rule of the server: `error` keeps error and fatal. An empty or unknown minimum filters nothing.
 * An entry with an unknown level is kept only when nothing is filtered.
 */
export function matchesLevel(entry, minimum) {
  const min = levelRank(minimum);
  if (min === -1) return true;
  return levelRank(entry && entry.level) >= min;
}

/** Case-insensitive substring of the message or the module name (the server rule); empty text matches all. */
export function matchesText(entry, text) {
  if (typeof text !== "string" || text === "") return true;
  const needle = text.toLowerCase();
  const msg = entry && entry.msg !== undefined && entry.msg !== null ? String(entry.msg) : "";
  const name = entry && entry.name !== undefined && entry.name !== null ? String(entry.name) : "";
  return msg.toLowerCase().includes(needle) || name.toLowerCase().includes(needle);
}

/** `{ level, q }` applied to a list of entries (a new array, order kept). */
export function filterEntries(entries, { level = "", q = "" } = {}) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => matchesLevel(entry, level) && matchesText(entry, q));
}

/** `seq` of the newest entry, or `fallback` for an empty list. */
export function lastSeqOf(entries, fallback = null) {
  return Array.isArray(entries) && entries.length ? entries[entries.length - 1].seq : fallback;
}

/**
 * Add entries pushed by the stream (or polled) to the list held by the view: only those newer than the newest held
 * (a replay after a reconnection repeats some), oldest first, at most `max` kept (the oldest fall off).
 */
export function appendEntries(current, incoming, max = MAX_ENTRIES) {
  const held = Array.isArray(current) ? current : [];
  let newest = held.length ? held[held.length - 1].seq : -Infinity;
  const added = [];
  for (const entry of Array.isArray(incoming) ? incoming : [incoming]) {
    if (!entry || typeof entry !== "object" || !Number.isFinite(entry.seq) || entry.seq <= newest) continue;
    newest = entry.seq;
    added.push(entry);
  }
  if (!added.length) return held;
  const all = held.concat(added);
  return all.length > max ? all.slice(all.length - max) : all;
}

/** Entries as the view lists them: newest first. */
export function newestFirst(entries) {
  return (Array.isArray(entries) ? entries : []).slice().reverse();
}

/**
 * Pause/resume: while paused the view shows the entries up to the sequence it was paused at; the rest is counted
 * ("12 new entries"). `pausedAt` is null when running.
 */
export function splitPaused(entries, pausedAt) {
  const list = Array.isArray(entries) ? entries : [];
  if (pausedAt === null || pausedAt === undefined) return { shown: list, pending: 0 };
  const shown = list.filter((entry) => entry.seq <= pausedAt);
  return { shown, pending: list.length - shown.length };
}

/** Slice a list into pages: `{ items, page, pages, total }`, the page clamped into range. */
export function paginate(list, page, pageSize = PAGE_SIZE) {
  const total = Array.isArray(list) ? list.length : 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, Math.trunc(Number(page)) || 1), pages);
  return { items: (list || []).slice((current - 1) * pageSize, current * pageSize), page: current, pages, total };
}

/**
 * A (multi-line) message as lines for the view. HTML collapses the blanks at the start of a line, which would flatten
 * a stack trace, so they become non-breaking spaces (a tab is four). Trailing empty lines are dropped, at most
 * `maxLines` are kept. Always at least one line.
 */
export function messageLines(text, { maxLines = 200 } = {}) {
  const lines = String(text === undefined || text === null ? "" : text).split(/\r?\n/);
  while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(0, maxLines).map((line) => line.replace(/^[ \t]+/, (lead) => lead.replace(/\t/g, "    ").replace(/ /g, "\u00a0")));
}

/** Badge tone of a level. */
export function levelTone(level) {
  const rank = levelRank(level);
  if (rank >= RANK.error) return "danger";
  if (rank === RANK.warn) return "warn";
  if (rank === RANK.info) return "info";
  return "neutral";
}

/** Query of `GET /admin/api/logs` (empty values are left out; `q` is cut to the server's limit). */
export function buildLogsQuery({ level, q, since, limit } = {}) {
  const query = {};
  if (levelRank(level) !== -1) query.level = String(level).toLowerCase();
  if (typeof q === "string" && q !== "") query.q = Array.from(q).slice(0, MAX_QUERY_LENGTH).join("");
  if (Number.isFinite(Number(since)) && since !== null && since !== "" && since !== undefined) query.since = Number(since);
  if (Number.isFinite(Number(limit)) && Number(limit) >= 1) query.limit = Math.min(MAX_ENTRIES, Math.trunc(Number(limit)));
  return query;
}
