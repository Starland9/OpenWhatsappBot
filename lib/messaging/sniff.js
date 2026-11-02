"use strict";

/**
 * Content detection for the messaging API (feature 004, contracts/runtime.md section 10.1): the type sent is the
 * type detected from the bytes, never the one the caller declares (RT-100, FR-052).
 *
 *   KINDS                          kind -> Set of mimes: image, animated, video, audio, audio_or_container, document
 *   classifyHead(buffer)           the first 4100 bytes: { mime, ext } | null (early abort of an upload or a download)
 *   classify(file, { name })       the whole file: { mime, ext } | null; text and CSV by content (the name only tells
 *                                  a CSV from a plain text, exactly the broadcast rule)
 *   accepts(kinds, detected)       does one of the kinds allow the detected mime?
 *   check(kinds, detected)         throws MessagingError("media_type_mismatch", { params: { expected: kinds } });
 *                                  the detected type is never echoed (Y17)
 *   effectiveMax(format)           min(format.media.maxBytes, MAX_UPLOAD MB), read at call time
 *
 * `file-type` is ESM only and heavy: it is imported inside the functions (RT-04). An executable, a script (a text
 * starting with `#!`) and everything outside the lists is never accepted.
 */

const fsp = require("node:fs/promises");
const { MessagingError } = require("./errors");
const { LIMITS } = require("./limits");

const HEAD_BYTES = 4100;
const TEXT_BYTES = 8192;

const IMAGE = ["image/jpeg", "image/png", "image/webp"];
const ANIMATED = ["image/gif"];
const VIDEO = ["video/mp4", "video/quicktime", "video/3gpp"];
const AUDIO = ["audio/mpeg", "audio/ogg", "audio/ogg; codecs=opus", "audio/x-m4a", "audio/mp4", "audio/wav", "audio/flac", "audio/aac", "audio/amr"];
// the broadcast whitelist (lib/utils/broadcaster.js DOCUMENT_MIMES, U6) plus text and CSV by content
const DOCUMENT = [
  "application/pdf",
  "application/zip",
  "application/x-cfb",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "text/plain",
  "text/csv",
];

const KINDS = Object.freeze({
  image: new Set(IMAGE),
  animated: new Set(ANIMATED),
  video: new Set(VIDEO),
  audio: new Set(AUDIO),
  audio_or_container: new Set([...AUDIO, "video/webm", "video/mp4"]),
  document: new Set(DOCUMENT),
});

/**
 * Clean UTF-8 without NUL bytes and not a `#!` script: { mime, ext } or null. `truncated` says the buffer is only the
 * start of a longer file, so a multi-byte character cut at its end is not a fault.
 */
function textKind(head, name, truncated) {
  if (!head.length || head.includes(0)) return null;
  if (head[0] === 0x23 && head[1] === 0x21) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    decoder.decode(head);
  } catch {
    if (!truncated) return null;
    try {
      decoder.decode(head.subarray(0, Math.max(0, head.length - 3))); // the cut may split a character
    } catch {
      return null;
    }
  }
  return /\.csv$/i.test(String(name || "")) ? { mime: "text/csv", ext: "csv" } : { mime: "text/plain", ext: "txt" };
}

/** @returns {Promise<{ mime: string, ext: string }|null>} */
async function classifyHead(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const head = buffer.subarray(0, HEAD_BYTES);
  let detected = null;
  try {
    const { fileTypeFromBuffer } = await import("file-type");
    detected = await fileTypeFromBuffer(head);
  } catch {
    detected = null;
  }
  if (detected) return { mime: detected.mime, ext: detected.ext };
  return textKind(head, "", head.length >= HEAD_BYTES);
}

/** @returns {Promise<{ mime: string, ext: string }|null>} */
async function classify(file, { name } = {}) {
  let detected = null;
  try {
    const { fileTypeFromFile } = await import("file-type");
    detected = await fileTypeFromFile(file);
  } catch {
    detected = null;
  }
  if (detected) return { mime: detected.mime, ext: detected.ext };

  let head = Buffer.alloc(0);
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(TEXT_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    head = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  return textKind(head, name, head.length >= TEXT_BYTES);
}

function accepts(kinds, detected) {
  if (!detected || typeof detected.mime !== "string" || !Array.isArray(kinds)) return false;
  return kinds.some((kind) => Object.hasOwn(KINDS, kind) && KINDS[kind].has(detected.mime));
}

function check(kinds, detected) {
  if (!accepts(kinds, detected)) {
    throw new MessagingError("media_type_mismatch", { params: { expected: Array.isArray(kinds) ? kinds.slice() : [] } });
  }
}

function effectiveMax(format) {
  const config = require("../../config");
  const megabytes = Number(config.MAX_UPLOAD) || 230;
  return Math.min(format.media.maxBytes, megabytes * LIMITS.MB);
}

module.exports = { KINDS, HEAD_BYTES, classifyHead, classify, accepts, check, effectiveMax };
