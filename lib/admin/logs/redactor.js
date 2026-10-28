/**
 * Value-based secret redactor (contracts/runtime.md section 12).
 *
 * Leaf module: it imports only Node built-ins (enforced by test/admin-logging.test.js), so
 * the logger and the settings store can use it whether or not the admin panel is enabled.
 *
 *   register(name, value)                  // replaces the previous value of that name
 *   registerEphemeral(name, value, ttlMs)  // QR string (5 min), setup and reset tokens
 *   unregister(name)
 *   scrub(text) -> text                    // every registered value becomes "[redacted]"
 *
 * Each value is registered with its variants (raw, JSON-escaped, URL-encoded, base64 and
 * base64url) and compiled lazily into one escaped alternation, longest first. Values shorter
 * than MIN_LENGTH characters are ignored: they would garble ordinary log lines.
 *
 * Ephemeral values expire lazily (checked at every scrub) and through an unref()'d sweep that
 * exists only while at least one ephemeral value is registered. No timer exists at require time.
 */

const REPLACEMENT = "[redacted]";
const MIN_LENGTH = 6;
const SWEEP_INTERVAL_MS = 30 * 1000;

/** name -> { variants: string[], expiresAt: number | null } */
const entries = new Map();
let compiled = null; // RegExp | null, rebuilt when `dirty`
let dirty = false;
let nextExpiry = Infinity; // smallest expiresAt among ephemeral entries
let sweeper = null;

function nowOf(opts) {
  if (opts && opts.now !== undefined) return Number(opts.now instanceof Date ? opts.now.getTime() : opts.now);
  return Date.now();
}

/** raw, JSON-escaped, URL-encoded, base64 and base64url forms of a value (de-duplicated). */
function variantsOf(value) {
  const out = new Set([value]);
  try {
    out.add(JSON.stringify(value).slice(1, -1));
  } catch {
    // not serializable: skip this variant
  }
  try {
    out.add(encodeURIComponent(value));
  } catch {
    // lone surrogate: encodeURIComponent throws, skip this variant
  }
  const buf = Buffer.from(value, "utf8");
  out.add(buf.toString("base64"));
  out.add(buf.toString("base64url"));
  return [...out].filter((v) => v.length >= MIN_LENGTH);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function recomputeExpiry() {
  nextExpiry = Infinity;
  for (const e of entries.values()) {
    if (e.expiresAt !== null && e.expiresAt < nextExpiry) nextExpiry = e.expiresAt;
  }
}

function stopSweeper() {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

/** Drop the ephemeral entries whose time is up. */
function prune(now) {
  if (nextExpiry > now) return;
  for (const [name, e] of entries) {
    if (e.expiresAt !== null && e.expiresAt <= now) {
      entries.delete(name);
      dirty = true;
    }
  }
  recomputeExpiry();
  if (nextExpiry === Infinity) stopSweeper();
}

function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => prune(Date.now()), SWEEP_INTERVAL_MS);
  if (typeof sweeper.unref === "function") sweeper.unref();
}

function put(name, value, expiresAt) {
  const key = String(name);
  if (typeof value !== "string" || value.length < MIN_LENGTH) {
    // A previous value of that name must not survive its replacement by an unusable one.
    unregister(key);
    return;
  }
  entries.set(key, { variants: variantsOf(value), expiresAt });
  dirty = true;
  if (expiresAt !== null) {
    if (expiresAt < nextExpiry) nextExpiry = expiresAt;
    startSweeper();
  } else {
    recomputeExpiry();
    if (nextExpiry === Infinity) stopSweeper();
  }
}

/** Register (or replace) the secret value known under `name`. */
function register(name, value) {
  put(name, value, null);
}

/** Register a secret that stops being redacted after `ttlMs` (a QR string, a setup token). */
function registerEphemeral(name, value, ttlMs, opts) {
  const ttl = Number(ttlMs);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    unregister(name);
    return;
  }
  put(name, value, nowOf(opts) + ttl);
}

function unregister(name) {
  if (entries.delete(String(name))) {
    dirty = true;
    recomputeExpiry();
    if (nextExpiry === Infinity) stopSweeper();
  }
}

function compile() {
  const all = new Set();
  for (const e of entries.values()) for (const v of e.variants) all.add(v);
  dirty = false;
  if (all.size === 0) {
    compiled = null;
    return;
  }
  const sorted = [...all].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  compiled = new RegExp(sorted.map(escapeRegExp).join("|"), "g");
}

/** Replace every registered value (and variant) found in `text` with "[redacted]". */
function scrub(text, opts) {
  if (typeof text !== "string" || text.length === 0) return text;
  if (entries.size === 0) return text;
  prune(nowOf(opts));
  if (dirty) compile();
  if (!compiled) return text;
  return text.replace(compiled, REPLACEMENT);
}

/** Number of registered names (test seam). */
function size() {
  return entries.size;
}

/** Forget everything (test seam, also used by a full in-process restart). */
function clear() {
  entries.clear();
  compiled = null;
  dirty = false;
  nextExpiry = Infinity;
  stopSweeper();
}

module.exports = {
  register,
  registerEphemeral,
  unregister,
  scrub,
  size,
  clear,
  REPLACEMENT,
  MIN_LENGTH,
};
