"use strict";

/**
 * Raw uploads (admin-http-api.md sections 1.7 and 2.12, UP-1 and UP-2).
 *
 *   PUT /admin/api/uploads?purpose=backup|broadcast&name=<display name>     Content-Type: application/octet-stream
 *   DELETE /admin/api/uploads/:id
 *
 * The body is streamed to `<dir>/<id>.part` (mode 0600, default `data/admin-uploads`), counted while it flows
 * and renamed to `<id>.dat` once it has been sniffed. Rules:
 *   - `Content-Length` is required (411 length_required) and checked first against the cap `MAX_UPLOAD` MB
 *     (live setting, default 230; 413 payload_too_large with params.maxBytes);
 *   - one upload in flight per session (409 upload_in_progress);
 *   - the pending quota (stored + in flight) is 2 x the cap (507 quota_exceeded);
 *   - the content is sniffed, never trusted from a header (422 unsupported_file_type): a `backup` file starts
 *     with the magic `OWBBACKUP\n`; a `broadcast` file is an image (JPEG, PNG, WebP) or a document (PDF, Office,
 *     OpenDocument, ZIP, text, CSV);
 *   - an upload belongs to its session and lives one hour; a janitor (started by start(), unref()'d) removes the
 *     expired ones and the leftovers of an earlier run. `name` is display metadata only (sanitised, never a path).
 *
 * Helpers for the services that use an upload (W-BAK, W-BC), always passing the id and the SESSION id of the
 * request (ctx.session.id): an unknown, expired or foreign id is `null`, never an error that tells them apart.
 *
 *   uploads.peek(id, sessionId, { purpose })           -> { id, purpose, kind, mime, size, name, path } | null
 *   uploads.consume(id, sessionId, opts?, fn?)         -> the same record | null. The upload is taken out of the
 *        registry at once and its file is DELETED when the call returns; with `fn(record)` the file is still
 *        there while fn runs (read it, or move it elsewhere with fs.rename: a missing file is fine afterwards).
 *   uploads.pendingBytes()   uploads.sweep()   uploads.start()   uploads.stop()
 *
 * Nothing runs at require time: the directory is created by the first upload and the janitor by start().
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { AdminError, reply } = require("./response");
const { declaredLength } = require("./request");

const MIB = 1024 * 1024;
const TTL_MS = 60 * 60 * 1000;
const JANITOR_MS = 5 * 60 * 1000;
const BACKUP_MAGIC = Buffer.from("OWBBACKUP\n", "latin1");
const MAX_NAME = 120;
const PURPOSES = ["backup", "broadcast"];

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/zip",
  "application/x-cfb", // legacy Office (doc, xls, ppt)
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
]);

const globalTimers = {
  setInterval: (...args) => setInterval(...args),
  clearInterval: (handle) => clearInterval(handle),
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A display name: NFC, control characters removed, at most 120 code points. Never used in a path. */
function cleanName(value) {
  const text = String(value === undefined || value === null ? "" : value)
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "");
  return Array.from(text).slice(0, MAX_NAME).join("").trim();
}

async function readHead(file, bytes) {
  const fh = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Sniff a stored file. Returns { kind, mime } or null when the content is not allowed for the purpose.
 * @param {string} file
 * @param {"backup"|"broadcast"} purpose
 * @param {string} name display name (only used to tell CSV from plain text)
 */
async function sniffFile(file, purpose, name) {
  if (purpose === "backup") {
    const head = await readHead(file, BACKUP_MAGIC.length);
    return head.equals(BACKUP_MAGIC) ? { kind: "backup", mime: "application/octet-stream" } : null;
  }

  let detected = null;
  try {
    const { fileTypeFromFile } = await import("file-type"); // ESM only
    detected = await fileTypeFromFile(file);
  } catch {
    detected = null; // a truncated container: treated as unknown below
  }
  if (detected) {
    if (IMAGE_MIMES.has(detected.mime)) return { kind: "image", mime: detected.mime };
    if (DOCUMENT_MIMES.has(detected.mime)) return { kind: "document", mime: detected.mime };
    return null;
  }

  // text and CSV have no signature: accept clean UTF-8 without NUL bytes
  const head = await readHead(file, 8192);
  if (!head.length || head.includes(0)) return null;
  try {
    utf8.decode(head);
  } catch {
    // the 8 KiB cut may split a character at the very end: retry without the last 3 bytes
    try {
      utf8.decode(head.subarray(0, Math.max(0, head.length - 3)));
    } catch {
      return null;
    }
  }
  return { kind: "document", mime: /\.csv$/i.test(name) ? "text/csv" : "text/plain" };
}

/**
 * @param {object} [options]
 * @param {string} [options.dir]            default <repo>/data/admin-uploads
 * @param {() => number} [options.maxBytes] the cap in bytes, read at each upload (default config.MAX_UPLOAD MB)
 * @param {() => number} [options.now]
 * @param {object} [options.timers]         { setInterval, clearInterval }
 * @param {number} [options.ttlMs]
 * @param {Function} [options.sniff]        async (file, purpose, name) => { kind, mime } | null
 * @param {object} [options.logger]
 */
function createUploads(options = {}) {
  const dir = options.dir || path.join(__dirname, "..", "..", "..", "data", "admin-uploads");
  const now = options.now || Date.now;
  const timers = options.timers || globalTimers;
  const ttlMs = options.ttlMs || TTL_MS;
  const sniff = options.sniff || sniffFile;
  const logger = options.logger;
  const maxBytes =
    options.maxBytes ||
    (() => {
      const mb = Number(require("../../../config").MAX_UPLOAD) || 230;
      return mb * MIB;
    });

  /** @type {Map<string, object>} id -> record */
  const stored = new Map();
  /** @type {Map<string, number>} session id -> declared size of the upload in flight */
  const inFlight = new Map();
  let janitor = null;

  const fileOf = (id) => path.join(dir, `${id}.dat`);
  const partOf = (id) => path.join(dir, `${id}.part`);

  const pendingBytes = () => {
    let total = 0;
    for (const record of stored.values()) total += record.size;
    for (const size of inFlight.values()) total += size;
    return total;
  };

  const view = (record) => ({
    id: record.id,
    purpose: record.purpose,
    kind: record.kind,
    mime: record.mime,
    size: record.size,
    name: record.name,
    path: record.path,
  });

  async function unlinkQuiet(file) {
    try {
      await fsp.unlink(file);
    } catch {
      // already gone
    }
  }

  /** UP-1 */
  async function put(ctx) {
    const { req, session, query } = ctx;
    const sessionId = String(session.id);

    const length = declaredLength(req);
    if (length === null) throw new AdminError("length_required");
    const cap = maxBytes();
    if (length > cap) {
      throw new AdminError("payload_too_large", { params: { maxBytes: cap }, headers: { Connection: "close" } });
    }

    const purpose = query.purpose;
    if (!PURPOSES.includes(purpose)) {
      throw new AdminError("validation_failed", {
        fields: { purpose: purpose === undefined ? { code: "required" } : { code: "not_allowed", params: { allowed: PURPOSES } } },
      });
    }
    const name = cleanName(query.name);

    if (inFlight.has(sessionId)) throw new AdminError("upload_in_progress");
    if (pendingBytes() + length > 2 * cap) throw new AdminError("quota_exceeded");

    inFlight.set(sessionId, length);
    const id = crypto.randomBytes(16).toString("hex");
    const part = partOf(id);
    try {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

      let received = 0;
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (received > length || received > cap) {
            callback(new AdminError("payload_too_large", { params: { maxBytes: Math.min(length, cap) } }));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(req, counter, fs.createWriteStream(part, { flags: "wx", mode: 0o600 }));
      if (received !== length) throw new AdminError("bad_request");

      const sniffed = await sniff(part, purpose, name);
      if (!sniffed) throw new AdminError("unsupported_file_type");

      const final = fileOf(id);
      await fsp.rename(part, final);
      const at = now();
      const record = {
        id,
        sessionId,
        purpose,
        kind: sniffed.kind,
        mime: sniffed.mime,
        size: length,
        name,
        path: final,
        createdAt: at,
        expiresAt: at + ttlMs,
      };
      stored.set(id, record);
      return reply(201, {
        uploadId: id,
        purpose,
        kind: record.kind,
        mime: record.mime,
        size: record.size,
        name: record.name,
        expiresAt: new Date(record.expiresAt).toISOString(),
      });
    } catch (err) {
      await unlinkQuiet(part);
      // a client that went away mid-stream, or a truncated body, is just a bad request
      if (err && (err.code === "ERR_STREAM_PREMATURE_CLOSE" || err.code === "ECONNRESET")) throw new AdminError("bad_request");
      throw err;
    } finally {
      inFlight.delete(sessionId);
    }
  }

  function owned(id, sessionId, purpose) {
    const record = stored.get(String(id));
    if (!record || record.sessionId !== String(sessionId)) return null;
    if (record.expiresAt <= now()) return null;
    if (purpose && record.purpose !== purpose) return null;
    return record;
  }

  /** UP-2 */
  async function remove(ctx) {
    const record = owned(ctx.params.id, ctx.session.id);
    if (!record) throw new AdminError("not_found", { params: { resource: "upload" } });
    stored.delete(record.id);
    await unlinkQuiet(record.path);
    return { deleted: true };
  }

  /** Remove the expired uploads and, at the first call, the leftovers of an earlier process. */
  async function sweep() {
    const at = now();
    let removed = 0;
    for (const record of [...stored.values()]) {
      if (record.expiresAt <= at) {
        stored.delete(record.id);
        await unlinkQuiet(record.path);
        removed += 1;
      }
    }
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return removed;
    }
    const live = new Set([...stored.values()].map((r) => path.basename(r.path)));
    for (const entry of names) {
      if (!/^[0-9a-f]{32}\.(dat|part)$/.test(entry) || live.has(entry)) continue;
      const id = entry.slice(0, 32);
      if (inFlight.size && entry.endsWith(".part")) continue; // may belong to the upload in flight
      try {
        const stat = await fsp.lstat(path.join(dir, entry));
        if (stat.isFile() && at - stat.mtimeMs > ttlMs && !stored.has(id)) {
          await unlinkQuiet(path.join(dir, entry));
          removed += 1;
        }
      } catch {
        // gone meanwhile
      }
    }
    return removed;
  }

  return {
    put,
    remove,
    sweep,
    pendingBytes,
    PURPOSES,

    peek(id, sessionId, { purpose } = {}) {
      const record = owned(id, sessionId, purpose);
      return record ? view(record) : null;
    },

    async consume(id, sessionId, opts, fn) {
      if (typeof opts === "function") {
        fn = opts;
        opts = {};
      }
      const record = owned(id, sessionId, (opts || {}).purpose);
      if (!record) return null;
      stored.delete(record.id);
      try {
        if (typeof fn === "function") await fn(view(record));
      } finally {
        await unlinkQuiet(record.path);
      }
      return view(record);
    },

    start() {
      if (janitor) return;
      sweep().catch((err) => {
        if (logger) logger.warn({ name: err && err.name, code: err && err.code }, "admin: upload sweep failed");
      });
      janitor = timers.setInterval(() => {
        sweep().catch(() => {});
      }, JANITOR_MS);
      if (janitor && janitor.unref) janitor.unref();
    },

    stop() {
      if (janitor) timers.clearInterval(janitor);
      janitor = null;
    },

    /** Test seam: is the janitor armed. */
    janitorArmed: () => janitor !== null,
  };
}

module.exports = { createUploads, sniffFile, cleanName, BACKUP_MAGIC, IMAGE_MIMES, DOCUMENT_MIMES, TTL_MS, JANITOR_MS };
