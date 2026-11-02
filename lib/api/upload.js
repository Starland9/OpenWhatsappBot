"use strict";

/**
 * File reception of the public messaging API (feature 004, contracts/runtime.md section 15.11, public-api.md 3.4).
 *
 *   createUploader({ sniff, config, dataDir, idleMs, now }) -> { receive(part, options) }
 *   receive(part, options)  -> Promise<{ path, size, name, sha256, mime }>      (the default instance is exported too)
 *
 * `part` is the `file` part of lib/api/multipart.js (an async iterable of Buffers). The bytes are streamed to
 * `<dataDir>/tmp/api/<random>.part` (mode 0600, flags `wx`, no caller-controlled name) through a counter capped at
 * `options.maxBytes`: an overflow stops the reception at once (the request is not read further, so at most the cap plus
 * one chunk, under 64 KiB, was read) and answers `413 media_too_large { maxBytes }`. SHA-256 is computed on the fly (the
 * idempotency fingerprint of a multipart request). The first 4100 bytes go through `sniff.classifyHead`: a content that
 * is recognised and does not match `options.kinds` is `422 media_type_mismatch { expected }` after the first chunk
 * (the detected type is never echoed); a content that cannot be decided early is left to `messaging.inspectMedia`.
 *
 * Limits: at most 2 uploads in flight per key and 4 in all (`429 rate_limited { scope: "uploads" }`, retry 5 s); a pause
 * of 30 s without a byte ends the upload; the pending media bytes of the engine plus the bytes being received stay under
 * `2 * MAX_UPLOAD` MB, else `503 queue_full { scope: "disk" }`. The `.part` is deleted on every error path and on abort.
 *
 * options: { keyId, maxBytes, kinds (null = no early check), signal, pendingBytes() -> number|Promise<number>, dir }
 * `dir` is the directory of the `.part` files (the pipeline passes `<dataDir>/tmp/api`).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ApiError } = require("./errors");
const { MessagingError } = require("../messaging/errors");

const HEAD_BYTES = 4100;
const PER_KEY_MAX = 2;
const TOTAL_MAX = 4;
const IDLE_MS = 30 * 1000;
const RETRY_MS = 5000;
const MB = 1048576;

function createUploader(deps = {}) {
  const getSniff = () => deps.sniff || require("../messaging/sniff");
  const getConfig = () => deps.config || require("../../config");
  const idleMs = deps.idleMs || IDLE_MS;

  const perKey = new Map();
  let total = 0;
  let receivedInFlight = 0;

  /** Wait for the next chunk, but give up when the connection is idle or the request is being stopped */
  function nextChunk(iterator, signal) {
    let timer;
    let onAbort;
    const guards = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new ApiError("bad_request")), idleMs);
      if (timer.unref) timer.unref();
      if (signal) {
        onAbort = () => reject(new ApiError("unavailable", { params: { retryAfterMs: RETRY_MS } }));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    return Promise.race([iterator.next(), guards]).finally(() => {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    });
  }

  async function receive(part, options = {}) {
    const { keyId, maxBytes, kinds = null, signal, pendingBytes } = options;
    const dir = options.dir || path.join(deps.dataDir || path.join(__dirname, "..", "..", "data"), "tmp", "api");

    if ((perKey.get(keyId) || 0) >= PER_KEY_MAX || total >= TOTAL_MAX) {
      const own = (perKey.get(keyId) || 0) >= PER_KEY_MAX;
      throw new ApiError("rate_limited", { params: { scope: "uploads", limit: own ? PER_KEY_MAX : TOTAL_MAX, retryAfterMs: RETRY_MS } });
    }
    const diskLimit = 2 * (Number(getConfig().MAX_UPLOAD) || 230) * MB;
    const pending = typeof pendingBytes === "function" ? Number(await pendingBytes()) || 0 : 0;
    if (pending + receivedInFlight >= diskLimit) {
      throw new MessagingError("queue_full", { params: { scope: "disk", retryAfterMs: RETRY_MS } });
    }

    perKey.set(keyId, (perKey.get(keyId) || 0) + 1);
    total += 1;
    let mine = 0;
    let handle = null;
    let file = null;
    let finished = false;
    const iterator = part.stream[Symbol.asyncIterator]();
    try {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      file = path.join(dir, `${crypto.randomBytes(16).toString("hex")}.part`);
      handle = await fs.promises.open(file, "wx", 0o600);

      const hash = crypto.createHash("sha256");
      const head = [];
      let headLength = 0;
      let detected = null;
      let size = 0;
      for (;;) {
        const step = await nextChunk(iterator, signal);
        if (step.done) break;
        const chunk = step.value;
        size += chunk.length;
        if (size > maxBytes) throw new MessagingError("media_too_large", { params: { maxBytes } });
        if (pending + receivedInFlight + chunk.length > diskLimit) {
          throw new MessagingError("queue_full", { params: { scope: "disk", retryAfterMs: RETRY_MS } });
        }
        mine += chunk.length;
        receivedInFlight += chunk.length;
        hash.update(chunk);

        if (headLength < HEAD_BYTES) {
          head.push(chunk.subarray(0, HEAD_BYTES - headLength));
          headLength += head[head.length - 1].length;
          if (headLength >= HEAD_BYTES) detected = await classifyEarly(Buffer.concat(head), kinds);
        }
        await handle.write(chunk);
      }
      // a short file: the head was never complete
      if (headLength < HEAD_BYTES && headLength > 0) detected = await classifyEarly(Buffer.concat(head), kinds);
      await handle.close();
      handle = null;
      finished = true;
      return {
        path: file,
        size,
        name: typeof part.filename === "string" && part.filename ? part.filename.slice(0, 255) : null,
        sha256: hash.digest("hex"),
        mime: detected ? detected.mime : null,
      };
    } finally {
      receivedInFlight -= mine;
      total -= 1;
      const left = (perKey.get(keyId) || 1) - 1;
      if (left > 0) perKey.set(keyId, left);
      else perKey.delete(keyId);
      // not awaited: a generator that is blocked on a read only returns when that read ends
      if (typeof iterator.return === "function") Promise.resolve(iterator.return()).catch(() => {});
      if (handle) await handle.close().catch(() => {});
      if (!finished && file) await fs.promises.rm(file, { force: true }).catch(() => {});
    }
  }

  /** Detect from the head; a recognised type that the format does not accept ends the upload at once */
  async function classifyEarly(buffer, kinds) {
    const sniff = getSniff();
    const detected = await sniff.classifyHead(buffer);
    if (detected && kinds && !sniff.accepts(kinds, detected)) {
      throw new MessagingError("media_type_mismatch", { params: { expected: [...kinds] } });
    }
    return detected;
  }

  return { receive };
}

const shared = createUploader();

module.exports = { createUploader, receive: shared.receive, HEAD_BYTES, PER_KEY_MAX, TOTAL_MAX, IDLE_MS };
