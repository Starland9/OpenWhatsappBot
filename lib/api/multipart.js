"use strict";

/**
 * Restricted streaming multipart/form-data parser of the public messaging API (feature 004, contracts/runtime.md
 * section 15.11, public-api.md 3.4, research X12). Hand-written, no dependency: the grammar of the API is two parts, so
 * the parser is small and a strict subset removes the smuggling and quirk surface of general parsers.
 *
 *   boundaryOf(contentType)                    -> string | null    1-70 RFC 2046 boundary characters, quoted or not
 *   createReader(source, boundary)             -> { nextPart() }   pull parser over an async iterable of Buffers
 *   parseMultipart(source, boundary, onPart)   -> Promise<void>    sequential: awaits onPart(part) for each part
 *   readMessagePart(req, { limit, header })    -> Promise<{ raw, filename, contentType, next() }>
 *
 * Grammar: `multipart/form-data; boundary=<1-70 chars>`; at most two parts, in the order `message` (JSON text, any part
 * Content-Type or none: no-code tools send a text field) then `file`; each header block at most 4 KiB with only
 * `Content-Disposition: form-data; name="..."[; filename="..."]` and an optional `Content-Type`; a duplicate or folded
 * header, a `Content-Transfer-Encoding` (so no base64), any other header, a third part, a missing closing boundary or a
 * preamble over 1 KiB are `400 bad_request`. A `file` part before `message` is `422 validation_failed` with
 * `fields.file = { code: "invalid_order" }` (the right and the size cap depend on the first part). A `message` over
 * `limit` bytes is `413 payload_too_large`.
 *
 * Pull model: the source is read only when the consumer asks for bytes, so a part that is not consumed holds the request
 * paused (the HTTP side applies backpressure by itself) and the file bytes never accumulate: a part is an async
 * generator over slices of the current chunk. The boundary is searched as `\r\n--boundary`; a hit that is not followed
 * by `\r\n` or `--` is data. After the closing boundary the epilogue is ignored and never read.
 */

const { ApiError } = require("./errors");

const MAX_HEADER_BYTES = 4096;
const MAX_PREAMBLE_BYTES = 1024;
const BOUNDARY_CHARS = /^[0-9A-Za-z'()+_,\-./:=?]{1,70}$/; // RFC 2046 bchars, without the trailing space
const HEADER_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*?)[ \t]*$/;
const CRLF = Buffer.from("\r\n");
const DASHES = Buffer.from("--");
const HEADER_END = Buffer.from("\r\n\r\n");
const ALLOWED_HEADERS = new Set(["content-disposition", "content-type"]);

const bad = () => new ApiError("bad_request");

/** The boundary of a multipart/form-data Content-Type header, or null */
function boundaryOf(header) {
  const text = String(header || "");
  const parts = text.split(";");
  if (parts[0].trim().toLowerCase() !== "multipart/form-data") return null;
  let found = null;
  for (const raw of parts.slice(1)) {
    const match = /^\s*boundary\s*=\s*(?:"([^"]*)"|([^\s";]+))\s*$/i.exec(raw);
    if (!match) continue;
    if (found !== null) return null; // two boundaries
    found = match[1] !== undefined ? match[1] : match[2];
  }
  return found !== null && BOUNDARY_CHARS.test(found) ? found : null;
}

/** `form-data; name="x"[; filename="y"]` -> { name, filename } (strict: those two parameters only, each at most once) */
function parseDisposition(value) {
  const match = /^form-data\s*(?:;(.*))?$/i.exec(value);
  if (!match) throw bad();
  const out = { name: null, filename: null };
  let rest = (match[1] || "").trim();
  while (rest) {
    const param = /^([A-Za-z]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s";]+))\s*(?:;\s*|$)/.exec(rest);
    if (!param) throw bad();
    const key = param[1].toLowerCase();
    const text = param[2] !== undefined ? param[2].replace(/\\(.)/g, "$1") : param[3];
    if (key !== "name" && key !== "filename") throw bad();
    if (out[key] !== null) throw bad();
    out[key] = text;
    rest = rest.slice(param[0].length).trim();
  }
  if (out.name === null) throw bad();
  return out;
}

function parseHeaders(block) {
  const text = block.toString("utf8");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw bad();
  const headers = new Map();
  if (text === "") throw bad();
  for (const line of text.split("\r\n")) {
    if (/^[ \t]/.test(line)) throw bad(); // folded line
    const match = HEADER_LINE.exec(line);
    if (!match) throw bad();
    const name = match[1].toLowerCase();
    if (!ALLOWED_HEADERS.has(name) || headers.has(name)) throw bad(); // Content-Transfer-Encoding included
    headers.set(name, match[2]);
  }
  if (!headers.has("content-disposition")) throw bad();
  return headers;
}

/**
 * Pull parser over `source` (an async iterable of Buffers: an IncomingMessage, a generator...).
 * `nextPart()` resolves the next part or null after the closing boundary; the previous part is drained first.
 */
function createReader(source, boundary) {
  if (!BOUNDARY_CHARS.test(String(boundary))) throw bad();
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const iterator = source[Symbol.asyncIterator]();
  // the first boundary has no CRLF before it: pretend there was one
  let buf = Buffer.from(CRLF);
  let eof = false;
  let state = "preamble"; // preamble | headers | body | closed
  let parts = 0;
  let current = null;

  async function pull() {
    if (eof) return false;
    let step;
    try {
      step = await iterator.next();
    } catch {
      eof = true;
      throw bad(); // the request was aborted or failed while we were reading it
    }
    if (step.done) {
      eof = true;
      return false;
    }
    const chunk = Buffer.isBuffer(step.value) ? step.value : Buffer.from(step.value);
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    return true;
  }

  async function need(length) {
    while (buf.length < length) if (!(await pull())) throw bad();
  }

  /** After a delimiter: `--` closes, CRLF opens another part (only if the grammar allows one) */
  async function afterDelimiter() {
    await need(2);
    const mark = buf.subarray(0, 2);
    if (mark.equals(DASHES)) {
      buf = buf.subarray(2);
      state = "closed";
    } else if (mark.equals(CRLF)) {
      if (parts >= 2) throw bad(); // a third part
      buf = buf.subarray(2);
      state = "headers";
    } else {
      throw bad();
    }
  }

  async function* bodyOf() {
    for (;;) {
      const at = buf.indexOf(delimiter);
      if (at === -1) {
        const safe = buf.length - (delimiter.length - 1);
        if (safe > 0) {
          const out = buf.subarray(0, safe);
          buf = buf.subarray(safe);
          yield out;
        }
        if (!(await pull())) throw bad(); // no closing boundary
        continue;
      }
      if (buf.length < at + delimiter.length + 2) {
        if (at > 0) {
          const out = buf.subarray(0, at);
          buf = buf.subarray(at);
          yield out;
        }
        if (!(await pull())) throw bad();
        continue;
      }
      const tail = buf.subarray(at + delimiter.length, at + delimiter.length + 2);
      if (tail.equals(DASHES) || tail.equals(CRLF)) {
        if (tail.equals(CRLF) && parts >= 2) throw bad(); // the file part is the last one: a third part
        const out = buf.subarray(0, at);
        buf = buf.subarray(at + delimiter.length);
        state = "afterBody";
        if (out.length) yield out;
        return;
      }
      // boundary-like text inside the data: keep it
      const out = buf.subarray(0, at + 1);
      buf = buf.subarray(at + 1);
      yield out;
    }
  }

  async function drain(part) {
    if (part && !part.finished) for await (const chunk of part.stream) void chunk;
  }

  async function nextPart() {
    if (current) {
      await drain(current);
      current = null;
    }
    if (state === "afterBody") await afterDelimiter();
    if (state === "closed") return null;

    if (state === "preamble") {
      for (;;) {
        const at = buf.indexOf(delimiter);
        if (at !== -1) {
          if (at - CRLF.length > MAX_PREAMBLE_BYTES) throw bad();
          buf = buf.subarray(at + delimiter.length);
          break;
        }
        if (buf.length > MAX_PREAMBLE_BYTES + CRLF.length + delimiter.length) throw bad();
        if (!(await pull())) throw bad(); // no boundary at all
      }
      await afterDelimiter();
      if (state === "closed") throw bad(); // an empty form: the first part is mandatory
    }

    // headers
    let end;
    for (;;) {
      end = buf.indexOf(HEADER_END); // an empty header block is end 0 and refused by parseHeaders
      if (end !== -1) break;
      if (buf.length > MAX_HEADER_BYTES + HEADER_END.length) throw bad();
      if (!(await pull())) throw bad();
    }
    if (end > MAX_HEADER_BYTES) throw bad();
    const headers = parseHeaders(buf.subarray(0, end));
    buf = buf.subarray(end + HEADER_END.length);
    const disposition = parseDisposition(headers.get("content-disposition"));

    parts += 1;
    if (parts === 1 && disposition.name !== "message") {
      if (disposition.name === "file") throw new ApiError("validation_failed", { fields: { file: { code: "invalid_order" } } });
      throw bad();
    }
    if (parts === 2 && disposition.name !== "file") throw bad();

    state = "body";
    const part = {
      name: disposition.name,
      filename: disposition.filename,
      contentType: headers.has("content-type") ? headers.get("content-type") : null,
      finished: false,
    };
    const stream = bodyOf();
    part.stream = {
      [Symbol.asyncIterator]: () => ({
        async next() {
          if (part.finished) return { done: true, value: undefined };
          const step = await stream.next();
          if (step.done) {
            part.finished = true;
            return { done: true, value: undefined };
          }
          return step;
        },
        async return() {
          part.finished = true;
          return { done: true, value: undefined };
        },
      }),
    };
    current = part;
    return part;
  }

  return { nextPart };
}

/** Sequential callback form: `onPart(part)` is awaited for each part; an unconsumed part is drained */
async function parseMultipart(source, boundary, onPart) {
  const reader = createReader(source, boundary);
  for (;;) {
    const part = await reader.nextPart();
    if (part === null) return;
    await onPart(part);
  }
}

/**
 * The `message` part of a request, read whole (at most `limit` bytes), and a `next()` that continues with the `file`
 * part (a stream, consumed by upload.js) or resolves null when the request ends there.
 */
async function readMessagePart(req, { limit = 64 * 1024, header } = {}) {
  const boundary = boundaryOf(header !== undefined ? header : req.headers["content-type"]);
  if (!boundary) throw bad();
  const reader = createReader(req, boundary);
  const part = await reader.nextPart();
  if (part === null) throw bad();
  const chunks = [];
  let total = 0;
  for await (const chunk of part.stream) {
    total += chunk.length;
    if (total > limit) throw new ApiError("payload_too_large", { params: { maxBytes: limit } });
    chunks.push(chunk);
  }
  return {
    raw: Buffer.concat(chunks, total),
    filename: part.filename,
    contentType: part.contentType,
    next: () => reader.nextPart(),
  };
}

module.exports = { boundaryOf, createReader, parseMultipart, readMessagePart, MAX_HEADER_BYTES, MAX_PREAMBLE_BYTES };
