"use strict";

/**
 * Backup container (data-model.md 4.3, contracts/runtime.md section 13): the byte layout of an `.owb` file, the
 * key derivation and the streaming (de)cryption. Nothing here touches the database or the panel.
 *
 *   "OWBBACKUP\n" | uint32 BE header length H | header JSON (plaintext) | ciphertext | 16-byte GCM tag
 *
 *   header  { format: 1, kdf: { name: "scrypt", N, r, p, salt }, cipher: "aes-256-gcm", iv, check }  (hex fields)
 *   payload AES-256-GCM( gzip( NDJSON records ) ), AAD = (the 4 length bytes || the header bytes)
 *
 * Key derivation: master = scrypt(NFKC(passphrase), salt, 32, { N, r, p }); encKey and check are two HKDF-SHA256
 * outputs of the master ("owb-backup/enc" 32 bytes, "owb-backup/check" 16 bytes). `check` sits in the header, so a
 * wrong passphrase is told apart from a damaged file before anything is decrypted. If `check` matches but the tag
 * fails, the file was altered or cut short. Tampering with the header fails the tag too (AAD).
 *
 * Every scrypt run goes through ONE gate (at most one in flight, a queue of 4, then `rate_limited`): each run takes
 * about 64 MiB. The cost is injectable (`kdf: { N, r, p }`) so tests use a tiny one; the cost a file was written with
 * is read from its header, within bounds (a damaged header must not ask for gigabytes).
 *
 * NDJSON record types: `manifest`, `rows` (batches of 500 ordered by primary key), `file`, `blob` (1 MiB chunks) and
 * `session`. Streaming throughout: a reader holds one record at a time, never the file.
 */

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const zlib = require("zlib");
const { Transform, pipeline } = require("stream");

const MAGIC = Buffer.from("OWBBACKUP\n", "latin1");
const FORMAT = 1;
const CIPHER = "aes-256-gcm";
const TAG_BYTES = 16;
const IV_BYTES = 12;
const SALT_BYTES = 16;
const CHECK_BYTES = 16;
const KEY_BYTES = 32;
const PREFIX_BYTES = MAGIC.length + 4;
const MAX_HEADER_BYTES = 4096;
const MAX_LINE_BYTES = 64 * 1024 * 1024;

const ROWS_BATCH = 500;
const BLOB_CHUNK = 1024 * 1024;

const DEFAULT_KDF = Object.freeze({ N: 1 << 16, r: 8, p: 2 });
const MAX_KDF_BYTES = 128 * 1024 * 1024; // 128 * N * r
const MAX_KDF_P = 16;
const MAX_KDF_R = 32;
const KDF_MAX_WAITING = 4;
const KDF_RETRY_AFTER_MS = 2000;

/** The 25 exported models, in restore (dependency) order. */
const MODELS = Object.freeze([
  // group data
  "Group",
  "GroupEconomy",
  "GroupRole",
  "Filter",
  "Warn",
  "BannedChat",
  // bot features
  "AntiDelete",
  "ViewOnce",
  "AutoResponder",
  "User",
  "UserStats",
  "NotifyKeyword",
  "StickerCommand",
  "Idea",
  "Quote",
  "Task",
  "Reminder",
  // panel configuration
  "SettingOverride",
  "CommandState",
  "TextOverride",
  "DailyStat",
  "KnownChat",
  // jobs
  "Broadcast",
  "BroadcastRun",
  "BroadcastTarget",
]);

/** Never exported, never restored, even when a file carries rows for them (data-model 4.3, research U12). */
const EXCLUDED_MODELS = Object.freeze([
  "AdminAccount",
  "AdminSession",
  "AdminToken",
  "AuditLog",
  "AlertState",
  "AlertOutbox",
  "Conversation",
]);

/** Tables whose Postgres sequence must follow the explicit ids a restore inserts. */
const AUTO_INCREMENT_MODELS = Object.freeze([
  "Filter",
  "Warn",
  "Idea",
  "Quote",
  "Task",
  "Reminder",
  "NotifyKeyword",
  "StickerCommand",
  "AntiDelete",
  "ViewOnce",
  "AutoResponder",
  "Broadcast",
  "BroadcastRun",
  "BroadcastTarget",
]);

const MODEL_SET = new Set(MODELS);

/** Names of the session folder files (flat: Baileys writes `<type>-<id>.json` with `/` and `:` already replaced). */
const SAFE_FILE_NAME = /^[A-Za-z0-9_@][A-Za-z0-9._@+=-]{0,254}$/;

/**
 * `data/broadcast-media/<id>/<name>` as the broadcaster stores `Broadcast.mediaPath`: a numeric directory and a
 * file name with no path syntax (no separator, no control character, no leading dot), up to 255 code points.
 * @returns {{ id: string, name: string }|null}
 */
function parseMediaPath(value) {
  const match = /^data\/broadcast-media\/(\d{1,10})\/([^\n]+)$/.exec(typeof value === "string" ? value : "");
  if (!match) return null;
  const name = match[2];
  if (/[\\/\u0000-\u001f\u007f]/.test(name) || name.startsWith(".") || Array.from(name).length > 255) return null;
  return { id: match[1], name };
}

/**
 * Typed error of the backup engines. `code`: passphrase_too_short, bad_passphrase, file_altered,
 * format_unsupported, newer_version, invalid_row, secret_storage_unavailable, busy, token_expired, rate_limited,
 * apply_failed. `params` carry derived values only (model, index, field, versions), never a secret or a row.
 */
class BackupError extends Error {
  constructor(code, params, options) {
    super(code);
    this.name = "BackupError";
    this.code = code;
    if (params) this.params = params;
    if (options && options.cause) this.cause = options.cause;
  }
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/** The passphrase as it is hashed: NFKC, so a composed and a decomposed accent give the same key. */
function normalizePassphrase(passphrase) {
  return String(passphrase === undefined || passphrase === null ? "" : passphrase).normalize("NFKC");
}

const codePoints = (text) => Array.from(text).length;

/** scrypt needs a little more than 128 * N * r bytes. */
const maxmemFor = (N, r, p) => 128 * N * r * 2 + 128 * r * p * 2 + 1024 * 1024;

function checkKdfBounds({ N, r, p }) {
  const ok =
    Number.isInteger(N) &&
    Number.isInteger(r) &&
    Number.isInteger(p) &&
    N >= 2 &&
    (N & (N - 1)) === 0 &&
    r >= 1 &&
    r <= MAX_KDF_R &&
    p >= 1 &&
    p <= MAX_KDF_P &&
    128 * N * r <= MAX_KDF_BYTES;
  return ok;
}

/**
 * The scrypt gate: one run in flight, `maxWaiting` waiting, the next caller gets `rate_limited`
 * (admin-http-api.md 1.12). Independent of the login gate of lib/admin/auth/password.js.
 */
function createKdfGate({ maxWaiting = KDF_MAX_WAITING } = {}) {
  let inFlight = 0;
  const waiting = [];
  return {
    run(work) {
      if (inFlight >= 1 && waiting.length >= maxWaiting) {
        return Promise.reject(new BackupError("rate_limited", { retryAfterMs: KDF_RETRY_AFTER_MS }));
      }
      return new Promise((resolve, reject) => {
        const settle = (finish) => (value) => {
          inFlight -= 1;
          const next = waiting.shift();
          if (next) next();
          finish(value);
        };
        const start = () => {
          inFlight += 1;
          Promise.resolve()
            .then(work)
            .then(settle(resolve), settle(reject));
        };
        if (inFlight < 1) start();
        else waiting.push(start);
      });
    },
    stats: () => ({ inFlight, waiting: waiting.length, maxWaiting }),
  };
}

const defaultGate = createKdfGate();

/**
 * Derive the encryption key and the check value.
 * @param {string} passphrase
 * @param {{ N: number, r: number, p: number, salt: Buffer }} kdf
 * @param {{ gate?: object, scrypt?: Function }} [options]
 * @returns {Promise<{ encKey: Buffer, check: Buffer }>}
 */
function deriveKeys(passphrase, kdf, options = {}) {
  const gate = options.gate || defaultGate;
  const scrypt = options.scrypt || crypto.scrypt;
  return gate.run(async () => {
    const { N, r, p, salt } = kdf;
    const master = await new Promise((resolve, reject) => {
      scrypt(Buffer.from(normalizePassphrase(passphrase), "utf8"), salt, KEY_BYTES, { N, r, p, maxmem: maxmemFor(N, r, p) }, (err, key) =>
        err ? reject(err) : resolve(key),
      );
    });
    const encKey = Buffer.from(crypto.hkdfSync("sha256", master, salt, "owb-backup/enc", KEY_BYTES));
    const check = Buffer.from(crypto.hkdfSync("sha256", master, salt, "owb-backup/check", CHECK_BYTES));
    master.fill(0);
    return { encKey, check };
  });
}

/** A fresh kdf descriptor: the injected cost (tests) or the production one, and a random salt. */
function newKdf(cost) {
  const base = { ...DEFAULT_KDF, ...(cost || {}) };
  if (!checkKdfBounds(base)) throw new BackupError("apply_failed", { reason: "kdf_cost" });
  return { N: base.N, r: base.r, p: base.p, salt: crypto.randomBytes(SALT_BYTES) };
}

/** Keys for a new file from a passphrase: `{ encKey, check, kdf }`. */
async function newKeys(passphrase, options = {}) {
  const kdf = newKdf(options.kdf);
  const keys = await deriveKeys(passphrase, kdf, options);
  return { ...keys, kdf };
}

/** Overwrite the key material (a restore token ends, the derived key must not linger). */
function wipeKeys(keys) {
  if (!keys) return;
  if (Buffer.isBuffer(keys.encKey)) keys.encKey.fill(0);
  if (Buffer.isBuffer(keys.check)) keys.check.fill(0);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * The transform that seals a gzip stream: it emits the container prefix first, the ciphertext as it comes and the
 * 16-byte tag last. `keys` is what newKeys() / unlock() return.
 * @param {{ encKey: Buffer, check: Buffer, kdf: { N: number, r: number, p: number, salt: Buffer } }} keys
 * @param {{ iv?: Buffer }} [options]
 */
function createSealStream(keys, options = {}) {
  const iv = options.iv || crypto.randomBytes(IV_BYTES);
  const header = {
    format: FORMAT,
    kdf: { name: "scrypt", N: keys.kdf.N, r: keys.kdf.r, p: keys.kdf.p, salt: keys.kdf.salt.toString("hex") },
    cipher: CIPHER,
    iv: iv.toString("hex"),
    check: keys.check.toString("hex"),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const lengthBytes = Buffer.alloc(4);
  lengthBytes.writeUInt32BE(headerBytes.length, 0);
  const cipher = crypto.createCipheriv(CIPHER, keys.encKey, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.concat([lengthBytes, headerBytes]));

  const seal = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        callback(null, cipher.update(chunk));
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        callback(null, Buffer.concat([cipher.final(), cipher.getAuthTag()]));
      } catch (err) {
        callback(err);
      }
    },
  });
  seal.push(Buffer.concat([MAGIC, lengthBytes, headerBytes]));
  return seal;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const HEX = (length) => new RegExp(`^[0-9a-f]{${length}}$`);

function altered() {
  return new BackupError("file_altered");
}

/**
 * Read and check the plaintext header of a file. Reads a few bytes: the ciphertext is not touched.
 * @returns {Promise<{ size: number, dataStart: number, aad: Buffer, format: number, kdf: object, iv: Buffer, check: Buffer }>}
 * @throws {BackupError} format_unsupported (not a backup, unknown container format or cipher), file_altered
 */
async function readHeader(file) {
  const handle = await fsp.open(file, "r");
  try {
    const { size } = await handle.stat();
    const prefix = Buffer.alloc(PREFIX_BYTES);
    const { bytesRead } = await handle.read(prefix, 0, PREFIX_BYTES, 0);
    if (bytesRead < PREFIX_BYTES || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new BackupError("format_unsupported");
    }
    const length = prefix.readUInt32BE(MAGIC.length);
    if (length < 2 || length > MAX_HEADER_BYTES || PREFIX_BYTES + length + TAG_BYTES >= size) throw altered();

    const headerBytes = Buffer.alloc(length);
    const read = await handle.read(headerBytes, 0, length, PREFIX_BYTES);
    if (read.bytesRead < length) throw altered();

    let header;
    try {
      header = JSON.parse(headerBytes.toString("utf8"));
    } catch {
      throw altered();
    }
    if (!header || typeof header !== "object" || Array.isArray(header)) throw altered();
    if (typeof header.format !== "number" || !Number.isInteger(header.format) || header.format < 1 || header.format > FORMAT) {
      throw new BackupError("format_unsupported");
    }
    if (header.cipher !== CIPHER) throw new BackupError("format_unsupported");
    const kdf = header.kdf;
    if (!kdf || kdf.name !== "scrypt" || typeof kdf.salt !== "string" || !/^[0-9a-f]{16,128}$/.test(kdf.salt) || kdf.salt.length % 2) {
      throw new BackupError("format_unsupported");
    }
    if (!checkKdfBounds(kdf)) throw new BackupError("format_unsupported");
    if (typeof header.iv !== "string" || !HEX(IV_BYTES * 2).test(header.iv)) throw altered();
    if (typeof header.check !== "string" || !HEX(CHECK_BYTES * 2).test(header.check)) throw altered();

    return {
      size,
      dataStart: PREFIX_BYTES + length,
      aad: Buffer.concat([prefix.subarray(MAGIC.length), headerBytes]),
      format: header.format,
      kdf: { N: kdf.N, r: kdf.r, p: kdf.p, salt: Buffer.from(kdf.salt, "hex") },
      iv: Buffer.from(header.iv, "hex"),
      check: Buffer.from(header.check, "hex"),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Derive the keys of an existing file from the passphrase and compare the check value.
 * @returns {Promise<{ encKey: Buffer, check: Buffer, kdf: object }>}
 * @throws {BackupError} bad_passphrase, rate_limited
 */
async function unlock(info, passphrase, options = {}) {
  const keys = await deriveKeys(passphrase, info.kdf, options);
  if (keys.check.length !== info.check.length || !crypto.timingSafeEqual(keys.check, info.check)) {
    wipeKeys(keys);
    throw new BackupError("bad_passphrase");
  }
  return { ...keys, kdf: info.kdf };
}

/** Splits a byte stream into UTF-8 lines (objectMode on the readable side); a line over the cap is damage. */
class LineSplitter extends Transform {
  constructor(maxLine = MAX_LINE_BYTES) {
    super({ readableObjectMode: true });
    this.maxLine = maxLine;
    this.pending = [];
    this.pendingBytes = 0;
  }

  _emitLine(piece) {
    const line = this.pendingBytes ? Buffer.concat([...this.pending, piece]) : piece;
    this.pending = [];
    this.pendingBytes = 0;
    if (line.length) this.push(line.toString("utf8"));
  }

  _transform(chunk, _encoding, callback) {
    let start = 0;
    let at;
    while ((at = chunk.indexOf(0x0a, start)) !== -1) {
      this._emitLine(chunk.subarray(start, at));
      start = at + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.pending.push(rest);
      this.pendingBytes += rest.length;
      if (this.pendingBytes > this.maxLine) {
        callback(altered());
        return;
      }
    }
    callback();
  }

  _flush(callback) {
    if (this.pendingBytes) this._emitLine(Buffer.alloc(0));
    callback();
  }
}

async function readTag(file, size) {
  const handle = await fsp.open(file, "r");
  try {
    const tag = Buffer.alloc(TAG_BYTES);
    const { bytesRead } = await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    if (bytesRead < TAG_BYTES) throw altered();
    return tag;
  } finally {
    await handle.close();
  }
}

/**
 * Iterate the records of a file: decrypt, gunzip, split, parse. The iteration ENDS normally only after the GCM
 * tag has been verified, so a consumer that wants an atomic result applies its work, reaches the end of the loop
 * and only then commits. Any decryption, decompression or parsing failure, a truncated file included, is
 * `file_altered`. The consumer's own errors are not touched.
 * @param {string} file
 * @param {object} info  readHeader() result
 * @param {Buffer} encKey
 */
async function* readRecords(file, info, encKey) {
  const tag = await readTag(file, info.size);
  const decipher = crypto.createDecipheriv(CIPHER, encKey, info.iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(info.aad);
  decipher.setAuthTag(tag);

  const source = fs.createReadStream(file, { start: info.dataStart, end: info.size - TAG_BYTES - 1 });
  const lines = pipeline(source, decipher, zlib.createGunzip(), new LineSplitter(), () => {});
  try {
    for await (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw altered();
      }
      if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.t !== "string") throw altered();
      yield record;
    }
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError("file_altered", undefined, { cause: err });
  } finally {
    lines.destroy();
  }
}

// ---------------------------------------------------------------------------
// Small helpers shared by the engines
// ---------------------------------------------------------------------------

/** "1.2.3" or "v1.2.3-beta.1" -> [1, 2, 3]; anything else counts as 0. No `semver` dependency (research FR-053). */
function parseVersion(value) {
  const parts = String(value === undefined || value === null ? "" : value)
    .trim()
    .replace(/^v/i, "")
    .split(/[-+]/)[0]
    .split(".");
  return [0, 1, 2].map((i) => {
    const n = Number(parts[i]);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  });
}

/** -1, 0 or 1 */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** yyyymmdd-HHmmss in UTC (file names). */
function stampOf(ms, { millis = false } = {}) {
  const d = new Date(ms);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const base = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return millis ? `${base}-${pad(d.getUTCMilliseconds(), 3)}` : base;
}

module.exports = {
  MAGIC,
  FORMAT,
  CIPHER,
  TAG_BYTES,
  IV_BYTES,
  ROWS_BATCH,
  BLOB_CHUNK,
  DEFAULT_KDF,
  MODELS,
  MODEL_SET,
  EXCLUDED_MODELS,
  AUTO_INCREMENT_MODELS,
  SAFE_FILE_NAME,
  parseMediaPath,
  BackupError,
  normalizePassphrase,
  codePoints,
  createKdfGate,
  deriveKeys,
  newKdf,
  newKeys,
  wipeKeys,
  createSealStream,
  readHeader,
  unlock,
  readRecords,
  LineSplitter,
  parseVersion,
  compareVersions,
  stampOf,
};
