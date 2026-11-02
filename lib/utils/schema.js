"use strict";

/**
 * Strict schema core shared by the admin panel (through lib/admin/http/request.js) and the messaging API
 * (feature 004, contracts/runtime.md section 12). It lives outside lib/admin so an engine may require it (RT-01).
 *
 *   check(input, schema, { path })   pure: { value, fields }; `fields` is {} when the input is valid
 *   validate(input, schema)          the value, or throws SchemaError("validation_failed", { fields })
 *                                    / SchemaError("bad_request") when the input is not an object
 *   SchemaError                      Error with `code` and `fields`
 *   codePoints(text)                 length in code points
 *
 * Schema (one rule per field, an unknown property is refused):
 *   { type: "string"|"int"|"number"|"boolean"|"array"|"object", required, nullable, default,
 *     min, max (numbers and array length), minLength, maxLength (code points), pattern (RegExp),
 *     enum: [values], trim, nfkc (NFKC instead of NFC), items: Rule,
 *     shape: { ...schema }   (object, or items of an array: recursive, strict, builds a fresh object)
 *     unique: true           (array of scalars: the later occurrence is reported as "duplicate") }
 *
 * Field codes: required, invalid_type, invalid_format, too_short, too_long, out_of_range, not_allowed,
 * too_many_items, unknown_field, duplicate. Errors are keyed by dotted path with numeric indices
 * (`buttons.1.id`, `contacts.0.phones.2`); an unknown property is `<path>.$unknown` (`$unknown` at the top
 * level) and neither its name nor any submitted value is ever echoed (RT-121).
 *
 * Array item faults: an array rule with `unique` or with object `items.shape` reports each faulty item under
 * `<path>.<index>` (every fault at once); any other array rule keeps the historical behaviour, one fault
 * reported on the array path itself. A schema without `shape`/`unique` therefore validates exactly as before.
 */

const codePoints = (text) => Array.from(text).length;

class SchemaError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = "SchemaError";
    this.code = code;
    this.fields = options.fields || undefined;
  }
}

const join = (path, key) => (path ? `${path}.${key}` : String(key));

const isPlainObjectLike = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function normalizeString(value, rule) {
  let text = value.normalize(rule.nfkc ? "NFKC" : "NFC");
  if (rule.trim) text = text.trim();
  return text;
}

/** The value a scalar is compared by for `unique`: trimmed and NFC-normalised when it is a string. */
function uniqueKey(value) {
  return typeof value === "string" ? value.trim().normalize("NFC") : value;
}

const isScalar = (value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** Items of this array rule are reported one by one under `<path>.<index>`. */
function reportsByIndex(rule) {
  return rule.unique === true || Boolean(rule.items && rule.items.type === "object" && rule.items.shape);
}

/**
 * Validate one value against a rule. Returns { value } or { errors }, `errors` mapping a dotted path to
 * { code, params? }.
 */
function checkValue(input, rule, path) {
  const fail = (code, params) => ({ errors: { [path]: params ? { code, params } : { code } } });

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
    case "array":
      return checkArray(input, rule, path, fail);
    case "object": {
      if (!isPlainObjectLike(input)) return fail("invalid_type");
      if (!rule.shape) return { value: input };
      const nested = check(input, rule.shape, { path });
      return Object.keys(nested.fields).length ? { errors: nested.fields } : { value: nested.value };
    }
    default:
      return { value: input };
  }
}

function checkArray(input, rule, path, fail) {
  if (!Array.isArray(input)) return fail("invalid_type");
  if (rule.max !== undefined && input.length > rule.max) return fail("too_many_items", { max: rule.max });
  if (rule.min !== undefined && input.length < rule.min) return fail("too_short", { min: rule.min });

  const out = [];

  if (!reportsByIndex(rule)) {
    // historical behaviour: the first faulty item is reported on the array itself
    for (const item of input) {
      if (!rule.items) {
        out.push(item);
        continue;
      }
      const checked = checkValue(item, rule.items, path);
      if (checked.errors) return checked;
      out.push(checked.value);
    }
    return { value: out };
  }

  const errors = {};
  const seen = new Set();
  input.forEach((item, index) => {
    const at = join(path, index);
    if (!rule.items) {
      out.push(item);
    } else {
      const checked = checkValue(item, rule.items, at);
      if (checked.errors) {
        Object.assign(errors, checked.errors);
        return;
      }
      out.push(checked.value);
      item = checked.value;
    }
    if (rule.unique === true && isScalar(item)) {
      const key = uniqueKey(item);
      if (seen.has(key)) errors[at] = { code: "duplicate" };
      else seen.add(key);
    }
  });
  return Object.keys(errors).length ? { errors } : { value: out };
}

/**
 * Check `input` against `schema` and return a FRESH object holding only the schema's fields, together with
 * every fault found. Pure: never throws, never echoes a submitted value.
 * @param {object|null|undefined} input undefined and null are read as {}
 * @param {object} schema one rule per field
 * @param {{ path?: string }} [options] prefix of every reported key (nested use)
 * @returns {{ value: object, fields: Record<string, {code: string, params?: object}> }}
 */
function check(input, schema, { path = "" } = {}) {
  const source = input === undefined || input === null ? {} : input;
  const out = {};
  const fields = {};

  if (!isPlainObjectLike(source)) {
    fields[path || "$"] = { code: "invalid_type" };
    return { value: out, fields };
  }

  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(schema, key)) {
      fields[join(path, "$unknown")] = { code: "unknown_field" };
      break;
    }
  }

  for (const [name, rule] of Object.entries(schema)) {
    const raw = Object.hasOwn(source, name) ? source[name] : undefined;
    const at = join(path, name);
    // absent, or an explicit null on a field that does not accept it
    if (raw === undefined || (raw === null && !rule.nullable)) {
      if (rule.default !== undefined) out[name] = rule.default;
      else if (rule.required) fields[at] = { code: "required" };
      continue;
    }
    if (raw === null) {
      out[name] = null;
      continue;
    }
    const checked = checkValue(raw, rule, at);
    if (checked.errors) Object.assign(fields, checked.errors);
    else out[name] = checked.value;
  }

  return { value: out, fields };
}

/**
 * Validate `input` against `schema` and return a fresh object holding only the schema's fields.
 * @throws {SchemaError} validation_failed with `fields` (nothing is echoed), bad_request when `input` is not an object
 */
function validate(input, schema) {
  const source = input === undefined || input === null ? {} : input;
  if (!isPlainObjectLike(source)) throw new SchemaError("bad_request");
  const { value, fields } = check(source, schema);
  if (Object.keys(fields).length) throw new SchemaError("validation_failed", { fields });
  return value;
}

module.exports = { check, validate, SchemaError, codePoints };
