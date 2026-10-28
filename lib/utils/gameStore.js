const crypto = require("crypto");

const logger = require("./logger").createLogger("gameStore");

/**
 * Per-chat game state with expiry.
 *
 * Replaces the plain Maps the game plugins used to keep (they never expired).
 * One store per game plugin, one game per chat. A single module-level timer
 * (unref'd) sweeps every store once a minute.
 *
 *   const store = createStore("hangman", { ttlMs: 10 * 60 * 1000 });
 *   const { ok, existing } = store.start(message.jid, { word: "bot" });
 *   if (!ok) return message.reply(...);           // a game is already running
 *   store.get(message.jid).nonce                  // for button ids <plugin>:<action>:<nonce>
 *   store.touch(message.jid);                     // activity: extend the expiry
 *   store.end(message.jid);
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX = 500;
const SWEEP_INTERVAL_MS = 60 * 1000;

/** @type {Map<string, Object>} every store by name, for the shared sweeper */
const stores = new Map();

function newNonce() {
  return crypto.randomBytes(4).toString("hex");
}

/** Run a user callback without letting it break the store or the sweeper */
function safeCall(fn, ...args) {
  if (typeof fn !== "function") return;
  try {
    const result = fn(...args);
    if (result && typeof result.catch === "function") {
      result.catch((err) => logger.warn({ message: err && err.message }, "gameStore onExpire failed"));
    }
  } catch (err) {
    logger.warn({ message: err && err.message }, "gameStore onExpire failed");
  }
}

/**
 * Create (or get, when the name already exists) a game store.
 * @param {string} name - Store name, usually the plugin name
 * @param {Object} [opts]
 * @param {number} [opts.ttlMs=600000] - Inactivity time before a game expires
 * @param {number} [opts.max=500] - Max games kept; the oldest is evicted beyond that
 * @param {(chatJid: string, game: Object, reason: "expired"|"evicted") => void} [opts.onExpire]
 *   Called when a game expires or is evicted (not on end()). Errors are swallowed.
 * @returns {{
 *   start: (chatJid: string, game: Object, opts?: { ttlMs?: number }) => { ok: boolean, existing: Object|null, game?: Object },
 *   get: (chatJid: string) => Object|null,
 *   touch: (chatJid: string) => Object|null,
 *   end: (chatJid: string) => boolean,
 *   size: () => number,
 *   clear: () => void,
 *   sweep: () => number,
 * }}
 */
function createStore(name, { ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX, onExpire } = {}) {
  if (stores.has(name)) return stores.get(name);

  /** @type {Map<string, Object>} insertion order = creation order (oldest first) */
  const games = new Map();
  const ttls = new WeakMap();

  const isExpired = (game, now) => game.expiresAt <= now;

  function drop(chatJid, reason) {
    const game = games.get(chatJid);
    if (!game) return;
    games.delete(chatJid);
    safeCall(onExpire, chatJid, game, reason);
  }

  function sweep() {
    const now = Date.now();
    let removed = 0;
    for (const [chatJid, game] of [...games]) {
      if (isExpired(game, now)) {
        drop(chatJid, "expired");
        removed++;
      }
    }
    return removed;
  }

  const store = {
    /**
     * Register a new game for the chat. Refuses while a non-expired game exists.
     * The game object is completed in place with `nonce` (kept if you set one),
     * `createdAt` and `expiresAt`.
     */
    start(chatJid, game, { ttlMs: gameTtl } = {}) {
      const now = Date.now();
      const current = games.get(chatJid);
      if (current) {
        if (!isExpired(current, now)) return { ok: false, existing: current };
        drop(chatJid, "expired");
      }

      if (games.size >= max) {
        sweep();
        while (games.size >= max) {
          drop(games.keys().next().value, "evicted");
        }
      }

      const ttl = gameTtl > 0 ? gameTtl : ttlMs;
      const stored = game && typeof game === "object" ? game : { value: game };
      if (typeof stored.nonce !== "string" || !stored.nonce) stored.nonce = newNonce();
      stored.createdAt = now;
      stored.expiresAt = now + ttl;
      ttls.set(stored, ttl);
      games.set(chatJid, stored);
      return { ok: true, existing: null, game: stored };
    },

    /** The running game of the chat, or null (an expired game is removed) */
    get(chatJid) {
      const game = games.get(chatJid);
      if (!game) return null;
      if (isExpired(game, Date.now())) {
        drop(chatJid, "expired");
        return null;
      }
      return game;
    },

    /** Activity in the game: push the expiry back. Returns the game or null. */
    touch(chatJid) {
      const game = store.get(chatJid);
      if (!game) return null;
      game.expiresAt = Date.now() + (ttls.get(game) || ttlMs);
      return game;
    },

    /** Remove the game. Returns true when there was one. */
    end(chatJid) {
      return games.delete(chatJid);
    },

    /** Number of running (non-expired) games */
    size() {
      const now = Date.now();
      let count = 0;
      for (const game of games.values()) if (!isExpired(game, now)) count++;
      return count;
    },

    /** Remove every game (tests) */
    clear() {
      games.clear();
    },

    /** Remove the expired games now. Returns how many. */
    sweep,
  };

  stores.set(name, store);
  return store;
}

/** Sweep every store. Returns how many games were removed. */
function sweepAll() {
  let removed = 0;
  for (const store of stores.values()) removed += store.sweep();
  return removed;
}

// One timer for all the stores
setInterval(sweepAll, SWEEP_INTERVAL_MS).unref();

module.exports = { createStore, sweepAll };
