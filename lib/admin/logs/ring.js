/**
 * In-memory ring of the latest log entries (contracts/runtime.md section 12).
 *
 * Leaf module: it imports only Node built-ins and the other log leaves (enforced by
 * test/admin-logging.test.js). The ring is always on, whether or not the admin panel is
 * enabled, so the dashboard shows the same last errors in both cases.
 *
 *   push(entry) / pushFromPinoLine(line)
 *   list({ level, q, since, limit }) -> [{ seq, ts, level, name, msg }]   (ascending seq)
 *   subscribe(fn) -> unsubscribe
 *   lastErrors(n = 10)                                                     (newest first)
 *
 * Entry shape: `seq` is a strictly increasing integer starting at 1 (SSE `id:` and the `since`
 * cursor of LOG-1), `ts` an ISO-8601 UTC string, `level` one of trace, debug, info, warn, error,
 * fatal, `name` the module name, `msg` the scrubbed message. Nothing else is kept.
 *
 * `msg` is capped at MAX_MSG characters and MAX_STACK_LINES stack lines ("    at ..."); the
 * other structured fields of a pino line are dropped from the panel view. Every message goes
 * through the redactor once more here (defence in depth: callers already scrub).
 */

const redactor = require("./redactor");

const CAPACITY = 1000;
const MAX_MSG = 2000;
const MAX_STACK_LINES = 12;

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const LEVEL_NAMES = Object.keys(LEVELS);

const buf = new Array(CAPACITY);
let head = 0; // next slot to write
let count = 0;
let seq = 0;
const subscribers = new Set();

/** Level name from a name ("warning", "log"...) or a pino number (30, 50...). */
function normalizeLevel(level) {
  if (typeof level === "number" && Number.isFinite(level)) {
    if (level >= 60) return "fatal";
    if (level >= 50) return "error";
    if (level >= 40) return "warn";
    if (level >= 30) return "info";
    if (level >= 20) return "debug";
    return "trace";
  }
  const name = String(level || "").toLowerCase();
  if (LEVELS[name]) return name;
  if (name === "warning") return "warn";
  if (name === "err") return "error";
  return "info";
}

/** At most MAX_STACK_LINES stack lines, then at most MAX_MSG characters. */
function capMessage(text) {
  let msg = text;
  if (msg.indexOf("\n") !== -1) {
    let stack = 0;
    const kept = [];
    for (const line of msg.split("\n")) {
      if (/^\s+at\s/.test(line)) {
        stack += 1;
        if (stack > MAX_STACK_LINES) continue;
      }
      kept.push(line);
    }
    msg = kept.join("\n");
  }
  if (msg.length > MAX_MSG) msg = msg.slice(0, MAX_MSG);
  return msg;
}

function toIso(ts) {
  const d = ts instanceof Date ? ts : new Date(ts === undefined || ts === null ? Date.now() : ts);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** Add an entry `{ level, name, msg, ts? }`; returns the stored copy (with its `seq`). */
function push(entry) {
  const e = entry || {};
  seq += 1;
  const stored = {
    seq,
    ts: toIso(e.ts),
    level: normalizeLevel(e.level),
    name: e.name === undefined || e.name === null ? "" : String(e.name).slice(0, 64),
    msg: capMessage(redactor.scrub(e.msg === undefined || e.msg === null ? "" : String(e.msg))),
  };
  buf[head] = stored;
  head = (head + 1) % CAPACITY;
  if (count < CAPACITY) count += 1;
  for (const fn of [...subscribers]) {
    try {
      fn({ ...stored });
    } catch {
      // a broken subscriber never stops the logger
    }
  }
  return { ...stored };
}

/** Parse one line written by pino (`{"level":30,"time":...,"name":"x","msg":"..."}`) and push it. */
function pushFromPinoLine(line) {
  const text = typeof line === "string" ? line.trim() : String(line === undefined || line === null ? "" : line).trim();
  if (!text) return null;
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    obj = null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return push({ level: "info", name: "", msg: text });
  }
  let msg = typeof obj.msg === "string" ? obj.msg : obj.msg === undefined ? "" : String(obj.msg);
  const err = obj.err && typeof obj.err === "object" ? obj.err : null;
  if (err) {
    const detail = typeof err.stack === "string" && err.stack ? err.stack : typeof err.message === "string" ? err.message : "";
    if (detail) msg = msg ? `${msg}\n${detail}` : detail;
  }
  return push({ level: obj.level, ts: obj.time, name: obj.name, msg });
}

function ordered() {
  const out = [];
  const start = (head - count + CAPACITY) % CAPACITY;
  for (let i = 0; i < count; i += 1) out.push(buf[(start + i) % CAPACITY]);
  return out;
}

/**
 * Entries in ascending `seq` order.
 *   level  minimum level ("error" returns error and fatal); unknown values filter nothing
 *   q      case-insensitive substring of the message or the module name
 *   since  only entries with a greater `seq`
 *   limit  at most that many entries: the newest ones, or the first ones after `since`
 *          when `since` is given (a polling client must not skip a gap)
 */
function list(opts) {
  const { level, q, since, limit } = opts || {};
  let items = ordered();
  if (level !== undefined && level !== null && level !== "") {
    const min = LEVELS[String(level).toLowerCase()];
    if (min !== undefined) items = items.filter((e) => LEVELS[e.level] >= min);
  }
  const cursor = Number(since);
  const hasSince = since !== undefined && since !== null && since !== "" && Number.isFinite(cursor);
  if (hasSince) items = items.filter((e) => e.seq > cursor);
  if (typeof q === "string" && q !== "") {
    const needle = q.toLowerCase();
    items = items.filter((e) => e.msg.toLowerCase().includes(needle) || e.name.toLowerCase().includes(needle));
  }
  const max = Number(limit);
  if (Number.isFinite(max) && max >= 0 && items.length > max) {
    items = hasSince ? items.slice(0, max) : items.slice(items.length - max);
  }
  return items.map((e) => ({ ...e }));
}

/** Subscribe to every new entry; returns the unsubscribe function. */
function subscribe(fn) {
  if (typeof fn !== "function") throw new TypeError("ring.subscribe needs a function");
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** The `n` newest entries of level error or above, newest first (dashboard). */
function lastErrors(n = 10) {
  const max = Number.isFinite(Number(n)) ? Math.max(0, Number(n)) : 10;
  const out = [];
  const all = ordered();
  for (let i = all.length - 1; i >= 0 && out.length < max; i -= 1) {
    if (LEVELS[all[i].level] >= LEVELS.error) out.push({ ...all[i] });
  }
  return out;
}

/** `seq` of the newest entry (0 when nothing was ever pushed). */
function lastSeq() {
  return seq;
}

/** Empty the ring and the subscribers; `seq` is NOT reset (test seam). */
function clear() {
  buf.fill(undefined);
  head = 0;
  count = 0;
  subscribers.clear();
}

module.exports = {
  push,
  pushFromPinoLine,
  list,
  subscribe,
  lastErrors,
  lastSeq,
  clear,
  CAPACITY,
  MAX_MSG,
  MAX_STACK_LINES,
  LEVELS: LEVEL_NAMES,
};
