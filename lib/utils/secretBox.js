"use strict";

/**
 * Secret box (contracts/runtime.md section 2): AES-256-GCM protection of the secret settings the
 * panel stores in the database (research U9, C1).
 *
 *   encrypt(plain, context) -> "enc:v1:<iv>:<tag>:<ciphertext>"        sync; creates the key file when absent
 *   decrypt(token, context) -> { ok: true, value } | { ok: false, code }
 *   isEncrypted(str)        -> boolean
 *   status()                -> { keyPresent, keyValid }                never the path nor a byte
 *   createSecretBox({ dir, fs }) / configure({ dir })                  tests point it at a temp directory
 *
 * Token: `enc:v1:` then the base64url of the 12-byte IV, the 16-byte tag and the ciphertext, separated
 * by ":". The additional authenticated data is "owb-secret/v1\0" + context (the store passes
 * "setting:" + key), so a ciphertext copied to another setting fails authentication.
 *
 * Key file `<dir>/panel.key`: exactly 32 random bytes, mode 0600; `dir` (default `<repo>/data`) is
 * created with mode 0700 when missing. The key is created lazily by the first encrypt(), atomically and
 * never over an existing file (a temporary file, then an exclusive link, falling back to an exclusive
 * create); encrypt() is synchronous, so two calls of one process cannot interleave, and the exclusive
 * link keeps two processes apart. decrypt() never creates anything: a key lost while "enc:" rows exist
 * is reported, not silently replaced. A file that is not 32 bytes counts as lost: encrypt() renames it
 * to `panel.key.invalid-<ts>` and creates a new key; decrypt() answers `key_invalid`.
 *
 * Decrypt failure codes: key_missing, key_invalid, auth_failed, unsupported_version, malformed.
 * encrypt() throws SecretBoxError { code: "key_unavailable" } when the directory cannot be written.
 *
 * The key is read from the file at every call (a few bytes): nothing is cached, so status() and
 * decrypt() always reflect what is on disk. No timer, nothing happens at require time.
 */

const nodeFs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KEY_FILE = "panel.key";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = "enc:";
const VERSION_PREFIX = "enc:v1:";
const AAD_PREFIX = "owb-secret/v1\0";

class SecretBoxError extends Error {
  /** @param {string} code stable snake_case code; the message never carries key material */
  constructor(code, message) {
    super(message || code);
    this.name = "SecretBoxError";
    this.code = code;
  }
}

const isFsError = (error, ...codes) => !!error && codes.includes(error.code);

/**
 * @param {{ dir?: string, fs?: object }} [options] `dir` is the folder holding panel.key
 */
function createSecretBox(options = {}) {
  const fs = options.fs || nodeFs;
  let dir = options.dir || path.resolve(__dirname, "..", "..", "data");

  const keyPath = () => path.join(dir, KEY_FILE);

  /** "missing" | "invalid" | { key } | throws SecretBoxError("key_unavailable") on an unreadable file */
  function readKey() {
    let data;
    try {
      data = fs.readFileSync(keyPath());
    } catch (error) {
      if (isFsError(error, "ENOENT", "ENOTDIR")) return "missing";
      throw new SecretBoxError("key_unavailable", "key file unreadable");
    }
    return data.length === KEY_BYTES ? { key: data } : "invalid";
  }

  function ensureDir() {
    try {
      const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // only a directory we created is tightened: an existing data/ is the owner's business
      if (created) fs.chmodSync(dir, 0o700);
    } catch (error) {
      throw new SecretBoxError("key_unavailable", "data directory not writable");
    }
  }

  /** Create the key file atomically, never over an existing one; returns the key that is on disk */
  function createKey() {
    ensureDir();
    const key = crypto.randomBytes(KEY_BYTES);
    const tmp = path.join(dir, `${KEY_FILE}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    try {
      fs.writeFileSync(tmp, key, { flag: "wx", mode: 0o600 });
      try {
        fs.linkSync(tmp, keyPath()); // EEXIST: another creator won, we use its key
      } catch (error) {
        if (isFsError(error, "EEXIST")) return null;
        // no hard links on this file system: an exclusive create is just as safe
        try {
          fs.writeFileSync(keyPath(), key, { flag: "wx", mode: 0o600 });
        } catch (second) {
          if (isFsError(second, "EEXIST")) return null;
          throw second;
        }
      }
      return key;
    } catch (error) {
      if (error instanceof SecretBoxError) throw error;
      throw new SecretBoxError("key_unavailable", "key file not writable");
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch (error) {
        // the temporary file is already gone
      }
    }
  }

  /** The key to encrypt with: reads, repairs an invalid file, creates when missing */
  function keyForEncrypt() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const found = readKey();
      if (found !== "missing" && found !== "invalid") return found.key;
      if (found === "invalid") {
        try {
          fs.renameSync(keyPath(), `${keyPath()}.invalid-${Date.now()}`);
        } catch (error) {
          if (!isFsError(error, "ENOENT")) throw new SecretBoxError("key_unavailable", "invalid key file kept");
        }
      }
      const created = createKey();
      if (created) return created;
      // lost the race: read what the winner wrote
    }
    throw new SecretBoxError("key_unavailable", "key file could not be created");
  }

  const aad = (context) => Buffer.from(AAD_PREFIX + String(context === undefined ? "" : context), "utf8");

  function encrypt(plain, context) {
    const key = keyForEncrypt();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(context));
    const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION_PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${body.toString("base64url")}`;
  }

  function decrypt(token, context) {
    if (typeof token !== "string" || !token.startsWith(PREFIX)) return { ok: false, code: "malformed" };
    const version = /^enc:(v\d+):/.exec(token);
    if (!version) return { ok: false, code: "malformed" };
    if (version[1] !== "v1") return { ok: false, code: "unsupported_version" };

    const parts = token.slice(VERSION_PREFIX.length).split(":");
    if (parts.length !== 3) return { ok: false, code: "malformed" };
    const b64url = /^[A-Za-z0-9_-]*$/;
    if (!parts.every((part) => b64url.test(part))) return { ok: false, code: "malformed" };
    const iv = Buffer.from(parts[0], "base64url");
    const tag = Buffer.from(parts[1], "base64url");
    const body = Buffer.from(parts[2], "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return { ok: false, code: "malformed" };

    let found;
    try {
      found = readKey();
    } catch (error) {
      return { ok: false, code: "key_missing" };
    }
    if (found === "missing") return { ok: false, code: "key_missing" };
    if (found === "invalid") return { ok: false, code: "key_invalid" };

    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", found.key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad(context));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(body), decipher.final()]);
      return { ok: true, value: plain.toString("utf8") };
    } catch (error) {
      return { ok: false, code: "auth_failed" };
    }
  }

  const isEncrypted = (value) => typeof value === "string" && /^enc:v\d+:/.test(value);

  /** { keyPresent, keyValid }: never the path or any byte of the key */
  function status() {
    try {
      const found = readKey();
      if (found === "missing") return { keyPresent: false, keyValid: false };
      return { keyPresent: true, keyValid: found !== "invalid" };
    } catch (error) {
      return { keyPresent: true, keyValid: false };
    }
  }

  /** Point the box at another directory (tests) */
  function configure(config = {}) {
    if (config.dir) dir = config.dir;
  }

  return { encrypt, decrypt, isEncrypted, status, configure };
}

const defaultBox = createSecretBox();

module.exports = {
  ...defaultBox,
  createSecretBox,
  SecretBoxError,
};
