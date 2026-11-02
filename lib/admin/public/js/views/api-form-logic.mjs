// Pure logic of the test form of the API area (feature 004, contracts/panel-ui.md section 5): a descriptor of the
// format registry (`Catalog.formats`) becomes a form model, a validation, a request body, the server errors on the
// right control, a curl example and the list of panel text keys. Nothing here names a format: a new format needs no
// edit (SC-009). No DOM, no network, no timer, no `t()`.
//
// `values` is plain data: a field name -> a string (text, textarea, number, url, phone, select), a boolean, a list of
// rows, or for a recipient `{ kind: "number" | "group", number, group }` (`group` is null or `{ jid, name }`; a bare
// JID string is read too). A row is `{ _k, ...values }` (object rows) or `{ _k, value }` (scalar rows). Keys that
// begin with `__` are reserved (`__seq`, the row-key counter): a descriptor must not name a field that way.

import { parseNumber } from "./permissions-logic.mjs";

export const API_KEY_ENV = "OWB_KEY";
export const MEDIA_URL_PATH = "media.url";
export const MEDIA_PLACEHOLDER = "<url of the file>";

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const codePoints = (text) => [...String(text ?? "")].length;
const isScalarRow = (node) => node !== null && typeof node === "object" && !Array.isArray(node) && "_k" in node && "value" in node && Object.keys(node).length === 2;

/** Descriptors by `order`, then name. */
export function orderedFormats(catalog) {
  const list = catalog && Array.isArray(catalog.formats) ? catalog.formats : [];
  return [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || byText(a.name, b.name));
}

/** `{ min, max }` of a list: `field.min ?? field.items.min ?? 0` and `field.max ?? field.items.max ?? Infinity`. */
export function rowBounds(field) {
  const items = (field && field.items) || {};
  return { min: field.min ?? items.min ?? 0, max: field.max ?? items.max ?? Infinity };
}

// ---- values ----------------------------------------------------------------------------------------------------

function scalarInitial(field) {
  if (field.type === "boolean") return Boolean(field.default ?? false);
  if (field.type === "select") return field.default ?? (field.options && field.options[0] ? field.options[0].value : "");
  if (field.type === "recipient") return { kind: "number", number: "", group: null };
  return field.default === undefined || field.default === null ? "" : String(field.default);
}

function initialOf(field, counter) {
  if (field.type !== "list") return scalarInitial(field);
  const { min, max } = rowBounds(field);
  const count = Math.min(max, Math.max(min, field.required ? 1 : 0));
  return Array.from({ length: count }, () => newRow(field, counter));
}

function initialFields(fields, counter) {
  const out = {};
  for (const field of fields || []) out[field.name] = initialOf(field, counter);
  return out;
}

function newRow(field, counter) {
  if (field.items && Array.isArray(field.items.fields)) {
    const key = ++counter.n;
    return { _k: key, ...initialFields(field.items.fields, counter) };
  }
  return { _k: ++counter.n, value: scalarInitial(field.item || { type: "text" }) };
}

/** Empty values: blanks, booleans at their default, the first option of a select, the minimum of rows of each list. */
export function initialValues(descriptor) {
  const counter = { n: 0 };
  const values = initialFields(descriptor.fields, counter);
  values.__seq = counter.n;
  return values;
}

/** A fresh form for another format that keeps the recipient the owner already typed. */
export function carryOver(values, descriptor) {
  const next = initialValues(descriptor);
  for (const field of descriptor.fields || []) {
    if (field.type === "recipient" && values && values[field.name] && typeof values[field.name] === "object") next[field.name] = { ...values[field.name] };
  }
  return next;
}

const partsOf = (path) => (Array.isArray(path) ? path.map(String) : String(path).split("."));

/** Dotted paths with numeric row indices (`buttons.1.label`, `options.2`); a scalar row reads as its value. */
export function getPath(values, path) {
  let node = values;
  for (const part of partsOf(path)) {
    if (node === null || node === undefined || typeof node !== "object") return undefined;
    node = node[part];
  }
  return isScalarRow(node) ? node.value : node;
}

function write(node, parts, index, value) {
  if (index === parts.length) return isScalarRow(node) ? { ...node, value } : value;
  const key = parts[index];
  const copy = Array.isArray(node) ? node.slice() : { ...(node || {}) };
  copy[key] = write(node === null || node === undefined ? undefined : node[key], parts, index + 1, value);
  return copy;
}

/** Immutable: a new tree sharing what did not change. */
export function setPath(values, path, value) {
  return write(values, partsOf(path), 0, value);
}

/** Append a row; the same object when the list is at its `max`. New rows get a fresh `_k`. */
export function addRow(values, path, field) {
  const list = getPath(values, path);
  if (!Array.isArray(list) || list.length >= rowBounds(field).max) return values;
  const counter = { n: values.__seq || 0 };
  const row = newRow(field, counter);
  const next = setPath(values, path, [...list, row]);
  next.__seq = counter.n;
  return next;
}

/** Drop a row; the same object when the list is at its `min` or the index is not a row. */
export function removeRow(values, path, index, field) {
  const list = getPath(values, path);
  if (!Array.isArray(list) || index < 0 || index >= list.length || list.length <= rowBounds(field).min) return values;
  return setPath(values, path, list.filter((_, i) => i !== index));
}

/** `parts.join(".")`: the syntax of the server `fields` keys. */
export const pathKey = (parts) => parts.join(".");

// ---- validation ------------------------------------------------------------------------------------------------

const NUMBER_TEXT = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/;
const parseNumberText = (text) => Number(String(text).trim().replace(",", "."));

function checkScalar(field, raw, key, errors) {
  const text = String(raw ?? "");
  const trimmed = text.trim();
  if (trimmed === "") {
    if (field.required) errors[key] = { code: "required" };
    return;
  }
  if (field.type === "number") {
    if (!NUMBER_TEXT.test(trimmed)) {
      errors[key] = { code: "invalid_type" };
      return;
    }
    const n = parseNumberText(trimmed);
    if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) {
      errors[key] = { code: "out_of_range", params: { min: field.min, max: field.max } };
    }
    return;
  }
  if (field.type === "phone") {
    if (!parseNumber(trimmed).ok) errors[key] = { code: "invalid_phone" };
    return;
  }
  if (field.type === "select") {
    if (!(field.options || []).some((option) => String(option.value) === trimmed)) errors[key] = { code: "not_allowed" };
    return;
  }
  const length = codePoints(trimmed);
  if (field.min !== undefined && length < field.min) errors[key] = { code: "too_short", params: { min: field.min } };
  else if (field.max !== undefined && length > field.max) errors[key] = { code: "too_long", params: { max: field.max } };
  else if (field.type === "url" && !isUrl(trimmed)) errors[key] = { code: "invalid_format" };
  else if (field.pattern && !safeRegExp(field.pattern).test(trimmed)) errors[key] = { code: "invalid_format" };
}

function safeRegExp(source) {
  try {
    return new RegExp(source);
  } catch {
    return /^/;
  }
}

function isUrl(text) {
  try {
    return /^https?:$/.test(new URL(text).protocol);
  } catch {
    return false;
  }
}

function checkField(field, value, parts, errors) {
  const key = pathKey(parts);
  if (field.type === "boolean") return;
  if (field.type === "recipient") {
    const to = value && typeof value === "object" ? value : {};
    if (to.kind === "group") {
      if (!groupIdOf(to.group)) errors[key] = { code: "required" };
    } else if (String(to.number ?? "").trim() === "") errors[key] = { code: "required" };
    else if (!parseNumber(String(to.number)).ok) errors[key] = { code: "invalid_phone" };
    return;
  }
  if (field.type !== "list") {
    checkScalar(field, value, key, errors);
    return;
  }
  const rows = Array.isArray(value) ? value : [];
  const { min, max } = rowBounds(field);
  if (rows.length < Math.max(min, field.required ? 1 : 0)) {
    errors[key] = rows.length === 0 && min <= 1 ? { code: "required" } : { code: "too_short", params: { min } };
  } else if (rows.length > max) {
    errors[key] = { code: "too_many_items", params: { max } };
  }
  const seen = new Set();
  rows.forEach((row, index) => {
    const rowParts = [...parts, String(index)];
    if (field.items && Array.isArray(field.items.fields)) {
      for (const nested of field.items.fields) checkField(nested, row[nested.name], [...rowParts, nested.name], errors);
      return;
    }
    const item = field.item || { type: "text", required: true };
    checkScalar({ ...item, required: item.required !== false }, row.value, pathKey(rowParts), errors);
    if (field.unique || item.unique) {
      const text = String(row.value ?? "").trim();
      if (text !== "") {
        if (seen.has(text)) errors[pathKey(rowParts)] = { code: "duplicate" };
        seen.add(text);
      }
    }
  });
}

/** A courtesy mirror of the server schema: `{ [dottedPath]: { code, params? } }`, empty when the form can be sent. */
export function clientValidate(descriptor, values) {
  const errors = {};
  for (const field of descriptor.fields || []) checkField(field, values ? values[field.name] : undefined, [field.name], errors);
  return errors;
}

// ---- request body ----------------------------------------------------------------------------------------------

function groupIdOf(group) {
  if (typeof group === "string") return group.trim();
  if (group && typeof group === "object") return String(group.jid || group.id || "").trim();
  return "";
}

function scalarOut(field, raw) {
  const text = String(raw ?? "");
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  if (field.type === "number") {
    const n = parseNumberText(trimmed);
    return NUMBER_TEXT.test(trimmed) && Number.isFinite(n) ? n : trimmed; // the server names the fault
  }
  if (field.type === "phone") {
    const parsed = parseNumber(trimmed);
    return parsed.ok ? parsed.digits : trimmed;
  }
  if (field.type === "textarea") return text; // judged trimmed, sent as typed
  return trimmed;
}

function valueOut(field, value) {
  if (field.type === "recipient") {
    const to = value && typeof value === "object" ? value : {};
    if (to.kind === "group") return groupIdOf(to.group) || undefined;
    const text = String(to.number ?? "").trim();
    if (text === "") return undefined;
    const parsed = parseNumber(text);
    return parsed.ok ? parsed.digits : text;
  }
  if (field.type === "boolean") {
    const on = Boolean(value);
    return field.required || on !== Boolean(field.default ?? false) ? on : undefined;
  }
  if (field.type === "list") {
    const rows = Array.isArray(value) ? value : [];
    if (rows.length === 0) return field.required ? [] : undefined;
    if (field.items && Array.isArray(field.items.fields)) return rows.map((row) => objectOut(field.items.fields, row));
    const item = field.item || { type: "text" };
    return rows.map((row) => scalarOut(item, row.value) ?? "");
  }
  return scalarOut(field, value);
}

function objectOut(fields, row) {
  const out = {};
  for (const field of fields) {
    const piece = valueOut(field, row ? row[field.name] : undefined);
    if (piece !== undefined) out[field.name] = piece;
  }
  return out;
}

/**
 * The flat body of the public API: `{ format, to, ...fields }` under the public property names, numbers parsed
 * (a comma is read as a point), phones as digits, optional blanks and empty optional lists omitted, an optional
 * boolean only when it differs from its default. `uploadId` when a file was uploaded, `media: { url }` for the URL
 * source. Never `wait`, never `idempotencyKey`.
 */
export function buildRequest(descriptor, values, { uploadId, mediaUrl } = {}) {
  const body = { format: descriptor.name, ...objectOut(descriptor.fields || [], values || {}) };
  if (uploadId) body.uploadId = uploadId;
  else if (mediaUrl) body.media = { url: mediaUrl };
  return body;
}

/** `{ format: descriptor.name, ...descriptor.example }`; a `format` already in the example is kept once, first. */
export function exampleBody(descriptor) {
  const example = descriptor.example && typeof descriptor.example === "object" ? descriptor.example : {};
  return { format: example.format ?? descriptor.name, ...example };
}

// ---- body -> values (the inverse of buildRequest) -------------------------------------------------------------

function recipientFromBody(to) {
  const text = String(to ?? "").trim();
  if (text.endsWith("@g.us")) return { kind: "group", number: "", group: { jid: text, name: null } };
  return { kind: "number", number: text, group: null };
}

function fromBody(field, raw, counter) {
  if (field.type === "recipient") return recipientFromBody(raw);
  if (field.type === "boolean") return raw === undefined ? Boolean(field.default ?? false) : Boolean(raw);
  if (field.type === "list") {
    if (!Array.isArray(raw)) return raw === undefined ? initialOf(field, counter) : [];
    return raw.map((item) => {
      if (field.items && Array.isArray(field.items.fields)) {
        const row = { _k: ++counter.n };
        for (const nested of field.items.fields) row[nested.name] = fromBody(nested, item ? item[nested.name] : undefined, counter);
        return row;
      }
      return { _k: ++counter.n, value: item === undefined || item === null ? "" : String(item) };
    });
  }
  if (raw === undefined || raw === null) return scalarInitial(field);
  return String(raw);
}

/** Form values from a flat body; a property the descriptor does not know is ignored. */
export function valuesFromBody(descriptor, body) {
  const counter = { n: 0 };
  const source = body && typeof body === "object" ? body : {};
  const values = {};
  for (const field of descriptor.fields || []) values[field.name] = fromBody(field, source[field.name], counter);
  values.__seq = counter.n;
  return values;
}

// ---- server errors ---------------------------------------------------------------------------------------------

/** Is `parts` a control the form renders (a field, a row, a field of a row)? */
function rendered(fields, parts, values) {
  const field = (fields || []).find((candidate) => candidate.name === parts[0]);
  if (!field) return false;
  if (parts.length === 1) return true;
  if (field.type !== "list") return false;
  const rows = Array.isArray(values && values[field.name]) ? values[field.name] : [];
  const index = /^(0|[1-9]\d*)$/.test(parts[1]) ? Number(parts[1]) : -1;
  if (index < 0 || index >= rows.length) return false;
  if (parts.length === 2) return true;
  if (!(field.items && Array.isArray(field.items.fields))) return false;
  return rendered(field.items.fields, parts.slice(2), rows[index]);
}

/**
 * Split the server `fields` (dotted keys) into those a rendered control shows (`byPath`) and the rest (`other`:
 * `$unknown`, unknown paths, a row that is not there), which the view lists. `media`, `media.url` and `uploadId` all
 * belong to the media control, under the key `media`.
 */
export function splitFieldErrors(fields, descriptor, values) {
  const byPath = {};
  const other = [];
  for (const [path, error] of Object.entries(fields && typeof fields === "object" ? fields : {})) {
    const parts = path.split(".");
    if (path === "media" || path === MEDIA_URL_PATH || path === "uploadId") {
      byPath.media = error;
    } else if (!parts.includes("$unknown") && rendered(descriptor && descriptor.fields, parts, values)) {
      byPath[path] = error;
    } else {
      other.push({ path, error });
    }
  }
  return { byPath, other };
}

// ---- curl ------------------------------------------------------------------------------------------------------

/** Close the single quote around any `'` (`'\''`) and wrap the whole text in single quotes. */
export const shellQuote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;

/**
 * A shell command for the example block. No file: a JSON body. With a file name (and the file source): multipart,
 * the JSON as the `message` part and the file as the `file` part. `source: "url"` puts a placeholder URL in the JSON.
 */
export function curlExample({ url, descriptor, body, fileName, source } = {}) {
  const base = { ...(body || exampleBody(descriptor || {})) };
  const viaUrl = source === "url" && descriptor && descriptor.media;
  if (viaUrl) base.media = { url: MEDIA_PLACEHOLDER };
  const json = JSON.stringify(base);
  const lines = [`curl -X POST "${url}"`, `  -H "Authorization: Bearer $${API_KEY_ENV}"`];
  if (fileName && !viaUrl) {
    lines.push(`  -F ${shellQuote(`message=${json};type=application/json`)}`);
    lines.push(`  -F ${shellQuote(`file=@./${fileName}`)}`);
  } else {
    lines.push(`  -H "Content-Type: application/json"`);
    lines.push(`  -d ${shellQuote(json)}`);
  }
  return lines.join(" \\\n");
}

// ---- panel text keys -------------------------------------------------------------------------------------------

function keysOfField(field, out) {
  for (const name of ["labelKey", "hintKey", "placeholderKey", "patternHintKey"]) if (field[name]) out.push(field[name]);
  for (const option of field.options || []) if (option.labelKey) out.push(option.labelKey);
  if (field.item) keysOfField(field.item, out);
  if (field.items && Array.isArray(field.items.fields)) for (const nested of field.items.fields) keysOfField(nested, out);
}

/** Every panel key a descriptor can need, once each, in the order of the form. */
export function panelKeysOfDescriptor(descriptor) {
  const out = [];
  if (descriptor.labelKey) out.push(descriptor.labelKey);
  if (descriptor.descKey) out.push(descriptor.descKey);
  for (const field of descriptor.fields || []) keysOfField(field, out);
  return [...new Set(out)];
}

/**
 * The key convention of the descriptor builder: `api.format.<name>.field.<path>.label|hint|placeholder`, `<path>` =
 * the field names joined by dots with no row index; a select option is `…<path>.option.<value>`; the common fields
 * are `fieldKeys("common", "to")`.
 */
export function fieldKeys(formatName, fieldPath) {
  const path = partsOf(fieldPath).filter((part) => !/^\d+$/.test(part)).join(".");
  const base = `api.format.${formatName}.field.${path}`;
  return { label: `${base}.label`, hint: `${base}.hint`, placeholder: `${base}.placeholder`, option: (value) => `${base}.option.${value}` };
}
