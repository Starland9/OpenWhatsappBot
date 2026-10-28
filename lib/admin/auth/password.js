"use strict";

/**
 * Administrator password: scrypt hashing, verification and policy
 * (data-model 1.1, admin-http-api.md 2.2, FR-004, research B3).
 *
 *   const passwords = createPasswords({ kdf });          // `kdf`: low scrypt cost for the tests
 *   await passwords.hash(plain)                          -> "scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>"
 *   await passwords.verify(plain, stored)                -> boolean (timingSafeEqual; false on a malformed hash)
 *   passwords.needsRehash(stored)                        -> true when the parameters differ from the current ones
 *   passwords.checkPolicy(plain)                         -> null | { code: "too_short"|"too_long"|"too_weak", params? }
 *
 * Parameters: N = 2^15, r = 8, p = 3 (32 MiB), 16-byte salt, 32-byte key, maxmem 64 MiB (Node's default
 * 32 MiB rejects this combination). The hash string is self-describing: a test hash made with a low cost
 * still verifies, and a later switch of the cost only needs `needsRehash()` at the next login.
 *
 * Every hash and every verification goes through ONE gate: at most one scrypt in flight and a queue of 4
 * (each costs about 32 MiB; ecosystem.config.js restarts at 500M). The sixth concurrent caller gets the
 * typed error `rate_limited` (HTTP 429) with `params.retryAfterMs`.
 *
 * Passwords are NFKC-normalised everywhere (policy, hash, verification), length counted in code points.
 */

const crypto = require("crypto");
const { AdminError } = require("../http/response");

/** Production cost (contracts: N=2^15, r=8, p=3, 32-byte key, 16-byte salt). */
const PRODUCTION_KDF = Object.freeze({ N: 1 << 15, r: 8, p: 3, keyLength: 32, saltLength: 16 });

const MIN_LENGTH = 12;
const MAX_LENGTH = 256;
const MAX_WAITING = 4;
const RETRY_AFTER_MS = 2000;

// Bounds accepted when verifying a stored hash (a damaged row must not ask for gigabytes of memory)
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;
const MAX_MEMORY = 256 * 1024 * 1024;

/** Passwords a person would try first. Compared lower-cased, without spaces; the policy needs 12+ characters anyway. */
const DENYLIST = new Set(
  [
    "password1234",
    "password12345",
    "password123456",
    "passwordpassword",
    "motdepasse123",
    "motdepasse1234",
    "motdepasse12345",
    "azertyuiop12",
    "azertyuiopqsdf",
    "azertyazerty",
    "qwertyuiop12",
    "qwertyqwerty",
    "qwertyuiopasdf",
    "administrator",
    "administrateur",
    "adminadminadmin",
    "adminadmin1234",
    "whatsappbot123",
    "openwhatsappbot",
    "whatsappwhatsapp",
    "letmein123456",
    "welcome12345",
    "welcome123456",
    "iloveyou1234",
    "changeme1234",
    "changemechangeme",
    "bonjour123456",
    "123456789012",
    "1234567890123",
    "111111111111",
    "000000000000",
    "azerty123456",
    "qwerty123456",
    "abcdefghijkl",
    "abcd12345678",
    "1q2w3e4r5t6y",
    "1qaz2wsx3edc",
    "trustno1trustno1",
  ].map((word) => word.toLowerCase()),
);

/** The word a password starts with once the trailing digits and symbols are stripped ("password2024!" -> "password"). */
const WEAK_STEMS = new Set([
  "password",
  "motdepasse",
  "azerty",
  "azertyuiop",
  "qwerty",
  "qwertyuiop",
  "administrator",
  "administrateur",
  "admin",
  "whatsapp",
  "whatsappbot",
  "openwhatsappbot",
  "letmein",
  "welcome",
  "bienvenue",
  "iloveyou",
  "changeme",
  "bonjour",
  "secret",
  "master",
]);

/** NFKC form used by the policy, the hash and the verification. */
function normalize(password) {
  return String(password === undefined || password === null ? "" : password).normalize("NFKC");
}

const codePointsOf = (text) => Array.from(text);

/** Only one character, repeated ("aaaaaaaaaaaa"). */
function isRepeatedCharacter(chars) {
  return chars.length > 0 && chars.every((c) => c === chars[0]);
}

/** A run that goes up or down by one code point, or one digit modulo 10 ("abcdefghijkl", "901234567890"). */
function isSequence(chars) {
  if (chars.length < 3) return false;
  const lower = chars.map((c) => c.toLowerCase());
  const points = lower.map((c) => c.codePointAt(0));
  const step = points[1] - points[0];
  if (Math.abs(step) === 1 && points.every((p, i) => i === 0 || p - points[i - 1] === step)) return true;
  if (lower.every((c) => c >= "0" && c <= "9")) {
    const digits = lower.map(Number);
    const wrap = (digits[1] - digits[0] + 10) % 10;
    if ((wrap === 1 || wrap === 9) && digits.every((d, i) => i === 0 || (d - digits[i - 1] + 10) % 10 === wrap)) return true;
  }
  return false;
}

/** A short unit repeated over the whole password ("abababababab", "123123123123"). */
function isRepeatedUnit(chars) {
  for (let unit = 2; unit <= 4; unit += 1) {
    if (chars.length < unit * 3) continue;
    if (chars.length % unit !== 0) continue;
    let same = true;
    for (let i = unit; i < chars.length; i += 1) {
      if (chars[i] !== chars[i % unit]) {
        same = false;
        break;
      }
    }
    if (same) return true;
  }
  return false;
}

function isDenied(normalized) {
  const compact = normalized.toLowerCase().replace(/\s+/g, "");
  if (DENYLIST.has(compact)) return true;
  const stem = compact.replace(/[0-9!?@#$%^&*._\-+=~]+$/u, "");
  if (stem && stem !== compact && WEAK_STEMS.has(stem)) return true;
  // the stem repeated ("passwordpassword2024")
  for (const word of WEAK_STEMS) {
    if (stem.length >= word.length * 2 && stem.length % word.length === 0 && word.repeat(stem.length / word.length) === stem) return true;
  }
  return false;
}

/**
 * Policy of FR-004. Returns null when the password is acceptable, else the first field error.
 * @returns {null | { code: "too_short" | "too_long" | "too_weak", params?: object }}
 */
function checkPolicy(password) {
  const normalized = normalize(password);
  const chars = codePointsOf(normalized);
  if (chars.length < MIN_LENGTH) return { code: "too_short", params: { min: MIN_LENGTH } };
  if (chars.length > MAX_LENGTH) return { code: "too_long", params: { max: MAX_LENGTH } };
  if (isRepeatedCharacter(chars) || isSequence(chars) || isRepeatedUnit(chars) || isDenied(normalized)) {
    return { code: "too_weak" };
  }
  return null;
}

/** maxmem for scrypt: a little over the 128 * N * r bytes it needs. */
function maxmemFor(N, r, p) {
  return 128 * N * r * 2 + 128 * r * p * 2 + 1024 * 1024;
}

function parseHash(stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 2 || N > MAX_N || (N & (N - 1)) !== 0 || r < 1 || r > MAX_R || p < 1 || p > MAX_P) return null;
  if (128 * N * r > MAX_MEMORY) return null;
  const salt = Buffer.from(parts[4], "base64");
  const hash = Buffer.from(parts[5], "base64");
  if (salt.length < 8 || salt.length > 64 || hash.length < 16 || hash.length > 64) return null;
  return { N, r, p, salt, hash };
}

/**
 * @param {object} [options]
 * @param {Partial<typeof PRODUCTION_KDF>} [options.kdf]  cost overrides (tests)
 * @param {Function} [options.scrypt]                     crypto.scrypt stand-in (tests of the queue)
 * @param {number} [options.maxWaiting=4]
 */
function createPasswords(options = {}) {
  const kdf = { ...PRODUCTION_KDF, ...(options.kdf || {}) };
  const scrypt = options.scrypt || crypto.scrypt;
  const maxWaiting = options.maxWaiting === undefined ? MAX_WAITING : options.maxWaiting;

  let inFlight = 0;
  /** @type {Array<() => void>} */
  const waiting = [];

  /** The gate: one scrypt at a time, `maxWaiting` waiting, then rate_limited. */
  function gated(work) {
    if (inFlight >= 1 && waiting.length >= maxWaiting) {
      return Promise.reject(new AdminError("rate_limited", { params: { retryAfterMs: RETRY_AFTER_MS } }));
    }
    return new Promise((resolve, reject) => {
      const settle = (finish) => (value) => {
        // free the gate before the caller sees the result, then start the next waiting job
        inFlight -= 1;
        const next = waiting.shift();
        if (next) next();
        finish(value);
      };
      const run = () => {
        inFlight += 1;
        work().then(settle(resolve), settle(reject));
      };
      if (inFlight < 1) run();
      else waiting.push(run);
    });
  }

  const derive = (password, salt, length, N, r, p) =>
    new Promise((resolve, reject) => {
      scrypt(Buffer.from(normalize(password), "utf8"), salt, length, { N, r, p, maxmem: maxmemFor(N, r, p) }, (err, key) => {
        if (err) reject(err);
        else resolve(key);
      });
    });

  return {
    kdf: Object.freeze({ ...kdf }),
    normalize,
    checkPolicy,

    /** Hash a password with the current parameters. */
    hash(password) {
      return gated(async () => {
        const salt = crypto.randomBytes(kdf.saltLength);
        const key = await derive(password, salt, kdf.keyLength, kdf.N, kdf.r, kdf.p);
        return ["scrypt", kdf.N, kdf.r, kdf.p, salt.toString("base64"), key.toString("base64")].join("$");
      });
    },

    /** True when `password` matches `stored`. A malformed hash never matches (and never throws). */
    verify(password, stored) {
      const parsed = parseHash(stored);
      if (!parsed) return Promise.resolve(false);
      return gated(async () => {
        const key = await derive(password, parsed.salt, parsed.hash.length, parsed.N, parsed.r, parsed.p);
        return key.length === parsed.hash.length && crypto.timingSafeEqual(key, parsed.hash);
      });
    },

    /** The stored hash uses other parameters than the current ones (re-hash at the next successful login). */
    needsRehash(stored) {
      const parsed = parseHash(stored);
      if (!parsed) return true;
      return parsed.N !== kdf.N || parsed.r !== kdf.r || parsed.p !== kdf.p || parsed.hash.length !== kdf.keyLength;
    },

    /** { inFlight, waiting, maxWaiting } of the hashing gate. */
    queueStats() {
      return { inFlight, waiting: waiting.length, maxWaiting };
    },
  };
}

module.exports = {
  createPasswords,
  checkPolicy,
  normalize,
  parseHash,
  PRODUCTION_KDF,
  MIN_LENGTH,
  MAX_LENGTH,
  MAX_WAITING,
};
