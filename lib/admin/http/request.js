"use strict";

/**
 * Request side of the admin HTTP layer (admin-http-api.md section 1.7).
 *
 *   readJsonBody(req, { limit })    JSON only, UTF-8, default cap 64 KiB (a route may declare up to 1 MiB):
 *                                   early 413 from Content-Length, bytes counted while streaming, 400 on a parse
 *                                   error, an empty body is read as {}
 *   splitUrl(url)                   { pathname, search } of a raw request target (no URL object, no decoding)
 *   parseQuery(search)              null-prototype object, the first value of a repeated key wins
 *   validate(input, schema)         strict schema: builds a FRESH object, never merges the parsed input
 *
 * Schema (one rule per field):
 *   { type: "string"|"int"|"number"|"boolean"|"array"|"object", required, nullable, default,
 *     min, max (numbers and array length), minLength, maxLength (code points), pattern (RegExp),
 *     enum: [values], trim, nfkc (passwords and passphrases: NFKC instead of NFC), items: Rule }
 * Field codes are those of section 1.9: required, invalid_type, invalid_format, too_short, too_long,
 * out_of_range, not_allowed, too_many_items. An unknown property gives 422 validation_failed with
 * fields.$unknown = { code: "unknown_field" } (the name is never echoed). A failing validation throws one
 * AdminError listing every field; the submitted values are never echoed.
 */

const { AdminError } = require("./response");

const DEFAULT_BODY_LIMIT = 64 * 1024;
const MAX_BODY_LIMIT = 1024 * 1024;

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Split a raw request target at the first "?" (the target is never decoded here). */
function splitUrl(url) {
  const target = String(url || "/");
  const mark = target.indexOf("?");
  const hash = target.indexOf("#");
  const end = hash === -1 ? target.length : hash;
  if (mark === -1 || mark > end) return { pathname: target.slice(0, end), search: "" };
  return { pathname: target.slice(0, mark), search: target.slice(mark + 1, end) };
}

function parseQuery(search) {
  const query = Object.create(null);
  if (!search) return query;
  let params;
  try {
    params = new URLSearchParams(search);
  } catch {
    throw new AdminError("bad_request");
  }
  for (const [key, value] of params) {
    if (!(key in query)) query[key] = value;
  }
  return query;
}

/** Content-Length header as a non-negative integer, null when absent; throws 400 when it is not a number. */
function declaredLength(req) {
  const header = req.headers["content-length"];
  if (header === undefined) return null;
  if (!/^\d{1,15}$/.test(String(header))) throw new AdminError("bad_request");
  return Number(header);
}

/**
 * Read the whole request body into a Buffer, refusing more than `limit` bytes.
 * The 413 for a declared length is thrown before reading anything.
 */
function readBody(req, { limit = DEFAULT_BODY_LIMIT } = {}) {
  const max = Math.min(limit, MAX_BODY_LIMIT);
  const length = declaredLength(req);
  if (length !== null && length > max) {
    return Promise.reject(tooLarge(max));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      req.removeListener("data", onData);
      reject(err);
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > max) {
        fail(tooLarge(max));
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks, total));
    });
    req.once("error", (err) => fail(err));
    req.once("aborted", () => fail(new AdminError("bad_request")));
  });
}

function tooLarge(max) {
  const err = new AdminError("payload_too_large", { params: { maxBytes: max } });
  // the rest of the body is never read: the connection is closed after the answer
  err.headers = { Connection: "close" };
  return err;
}

/** Parse a JSON body into a plain object ({} for an empty body); throws 400 otherwise. */
function parseJsonObject(buffer) {
  if (!buffer.length) return {};
  let text;
  try {
    text = utf8.decode(buffer);
  } catch {
    throw new AdminError("bad_request");
  }
  if (!text.trim()) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AdminError("bad_request");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AdminError("bad_request");
  return value;
}

async function readJsonBody(req, options) {
  return parseJsonObject(await readBody(req, options));
}

// ---------------------------------------------------------------------------
// Strict schema
// ---------------------------------------------------------------------------

const codePoints = (text) => Array.from(text).length;

function normalizeString(value, rule) {
  let text = value.normalize(rule.nfkc ? "NFKC" : "NFC");
  if (rule.trim) text = text.trim();
  return text;
}

/** Validate one value against a rule. Returns { value } or { error: { code, params? } }. */
function checkValue(input, rule) {
  const fail = (code, params) => ({ error: params ? { code, params } : { code } });

  switch (rule.type) {
    case "string": {
      if (typeof input !== "string") return fail("invalid_type");
      const text = normalizeString(input, rule);
      const length = codePoints(text);
      if (rule.minLength !== undefined && length < rule.minLength) return fail("too_short", { min: rule.minLength });
      if (rule.maxLength !== undefined && length > rule.maxLength) return fail("too_long", { max: rule.maxLength });
      if (rule.pattern && !rule.pattern.test(text)) return fail("invalid_format");
      if (rule.enum && !rule.enum.includes(text)) return fail("not_allowed", { allowed: rule.enum.slice() });
      return { value: text };
    }
    case "int":
    case "number": {
      if (typeof input !== "number" || !Number.isFinite(input)) return fail("invalid_type");
      if (rule.type === "int" && !Number.isInteger(input)) return fail("invalid_type");
      if ((rule.min !== undefined && input < rule.min) || (rule.max !== undefined && input > rule.max)) {
        return fail("out_of_range", { min: rule.min, max: rule.max });
      }
      if (rule.enum && !rule.enum.includes(input)) return fail("not_allowed", { allowed: rule.enum.slice() });
      return { value: input };
    }
    case "boolean":
      return typeof input === "boolean" ? { value: input } : fail("invalid_type");
    case "array": {
      if (!Array.isArray(input)) return fail("invalid_type");
      if (rule.max !== undefined && input.length > rule.max) return fail("too_many_items", { max: rule.max });
      if (rule.min !== undefined && input.length < rule.min) return fail("too_short", { min: rule.min });
      const out = [];
      for (const item of input) {
        if (!rule.items) {
          out.push(item);
          continue;
        }
        const checked = checkValue(item, rule.items);
        if (checked.error) return checked;
        out.push(checked.value);
      }
      return { value: out };
    }
    case "object":
      if (input === null || typeof input !== "object" || Array.isArray(input)) return fail("invalid_type");
      return { value: input };
    default:
      return { value: input };
  }
}

/**
 * Validate `input` against `schema` and return a fresh object holding only the schema's fields.
 * @throws {AdminError} validation_failed with `fields` (nothing is echoed)
 */
function validate(input, schema) {
  const source = input === undefined || input === null ? {} : input;
  const out = {};
  const fields = {};

  if (typeof source !== "object" || Array.isArray(source)) throw new AdminError("bad_request");

  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(schema, key)) {
      fields.$unknown = { code: "unknown_field" };
      break;
    }
  }

  for (const [name, rule] of Object.entries(schema)) {
    const raw = Object.hasOwn(source, name) ? source[name] : undefined;
    // absent, or an explicit null on a field that does not accept it
    if (raw === undefined || (raw === null && !rule.nullable)) {
      if (rule.default !== undefined) out[name] = rule.default;
      else if (rule.required) fields[name] = { code: "required" };
      continue;
    }
    if (raw === null) {
      out[name] = null;
      continue;
    }
    const checked = checkValue(raw, rule);
    if (checked.error) fields[name] = checked.error;
    else out[name] = checked.value;
  }

  if (Object.keys(fields).length) throw new AdminError("validation_failed", { fields });
  return out;
}

module.exports = {
  DEFAULT_BODY_LIMIT,
  MAX_BODY_LIMIT,
  splitUrl,
  parseQuery,
  declaredLength,
  readBody,
  readJsonBody,
  parseJsonObject,
  validate,
  codePoints,
};
