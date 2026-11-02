"use strict";

/**
 * Endpoint registry of the public messaging API (feature 004, contracts/runtime.md sections 15.3 and 15.4).
 *
 *   loadEndpoints({ dir, formats }) -> { endpoints, rights, byRoute, router }
 *   rightsOf(endpoint, { formats }) -> string[]       every right id the endpoint can require
 *   ApiRegistryError { endpoint, file, reason }        the message names the endpoint
 *
 * Requires `<dir>/*.js` in sorted order; each module is one endpoint (the shape of 15.3). **Deny by default**: an
 * endpoint declares a STATIC `right` or a DYNAMIC pair `rights({ formats })` + `requires(peek, { formats })`; there is no
 * public level, and one violation anywhere throws, so the caller serves no endpoint at all (RT-131, FR-090).
 * Violations: neither (or both, or a malformed) right declaration; an `id` or a `method path` that is not unique; a
 * path outside `/api/v<n>/`; a `:param` without a pattern; `GET` with a body kind other than `none`; `body.limit`
 * above 1 MiB; `multipart` without `file`; an invalid `schema`, `query` or `variants`; `doc.summary` missing;
 * `handle` not a function; two paths that could match the same URL.
 *
 * The rights catalogue `[{ id, group, format }]` is the union of the declared rights: the ids of `formats.rights()`
 * are group `send` (with their format name), `messages.read` is `read`, `media.url` is `media`, `api.docs` is `docs`,
 * any other id takes its first dotted segment as group. Order: send (in the formats' order), read, media, docs, then
 * the other groups alphabetically, ids alphabetical inside a group.
 *
 * A missing directory is an empty registry (the API then serves nothing but answers like any claimed path).
 */

const fs = require("fs");
const path = require("path");
const { createApiRouter, ApiRouterError } = require("./router");

const ID_PATTERN = /^[a-z]+(\.[a-z]+)+$/;
const RIGHT_PATTERN = /^[a-z]+(\.[a-z0-9_]+)*$/;
const RIGHT_MAX = 64;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const PATH_PREFIX = /^\/api\/v[0-9]+\/[^?#\s]+$/;
const BODY_KINDS = new Set(["json", "multipart", "none"]);
const BODY_LIMIT_DEFAULT = 64 * 1024;
const BODY_LIMIT_MAX = 1024 * 1024;
const RULE_TYPES = new Set(["string", "int", "number", "boolean", "array", "object"]);
const QUERY_TYPES = new Set(["string", "int", "boolean"]);
const FIXED_GROUPS = Object.freeze({ "messages.read": "read", "media.url": "media", "api.docs": "docs" });
const GROUP_ORDER = ["send", "read", "media", "docs"];

class ApiRegistryError extends Error {
  /**
   * @param {string} endpoint  id of the endpoint (the file name when it has none)
   * @param {string} file      base name of the module
   * @param {string} reason    short code-like text, no secret
   */
  constructor(endpoint, file, reason) {
    super(`API endpoint "${endpoint}" (${file}): ${reason}`);
    this.name = "ApiRegistryError";
    this.endpoint = endpoint;
    this.file = file;
    this.reason = reason;
  }
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isFunction = (value) => typeof value === "function";

/** Is `rule` a rule of lib/utils/schema.js (type known, nested rules valid)? Returns a reason or null. */
function ruleProblem(rule) {
  if (!isPlainObject(rule) || !RULE_TYPES.has(rule.type)) return "unknown rule type";
  if (rule.pattern !== undefined && !(rule.pattern instanceof RegExp)) return "pattern is not a RegExp";
  if (rule.enum !== undefined && !Array.isArray(rule.enum)) return "enum is not an array";
  for (const key of ["min", "max", "minLength", "maxLength"]) {
    if (rule[key] !== undefined && !Number.isFinite(rule[key])) return `${key} is not a number`;
  }
  if (rule.items !== undefined) {
    const nested = ruleProblem(rule.items);
    if (nested) return `items: ${nested}`;
  }
  if (rule.shape !== undefined) {
    const nested = schemaProblem(rule.shape);
    if (nested) return `shape: ${nested}`;
  }
  return null;
}

/** A schema is an object of rules; returns a reason or null. */
function schemaProblem(schema) {
  if (!isPlainObject(schema)) return "schema is not an object";
  for (const [name, rule] of Object.entries(schema)) {
    const problem = ruleProblem(rule);
    if (problem) return `${name}: ${problem}`;
  }
  return null;
}

function pathParams(pathText) {
  return String(pathText)
    .split("/")
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => segment.slice(1));
}

/** The right ids an endpoint can require (static: its one right; dynamic: the list its `rights()` returns) */
function rightsOf(endpoint, { formats } = {}) {
  if (isFunction(endpoint.rights)) return endpoint.rights({ formats });
  return [endpoint.right];
}

function validateRights(endpoint, formats, fail) {
  const hasStatic = endpoint.right !== undefined;
  const hasDynamic = endpoint.rights !== undefined || endpoint.requires !== undefined;
  if (hasStatic && hasDynamic) fail("both a static right and a dynamic rights/requires are declared");
  if (!hasStatic && !hasDynamic) fail("no right declared (deny by default: an endpoint needs `right` or `rights` + `requires`)");
  let list;
  if (hasStatic) {
    list = [endpoint.right];
  } else {
    if (!isFunction(endpoint.rights) || !isFunction(endpoint.requires)) fail("`rights` and `requires` must both be functions");
    try {
      list = endpoint.rights({ formats });
    } catch {
      fail("`rights()` threw");
    }
    if (!Array.isArray(list) || list.length === 0) fail("`rights()` must return a non-empty array");
  }
  const seen = new Set();
  for (const id of list) {
    if (typeof id !== "string" || id.length > RIGHT_MAX || !RIGHT_PATTERN.test(id)) fail("malformed right id");
    if (seen.has(id)) fail("duplicate right id");
    seen.add(id);
  }
  return list;
}

function validateQuery(query, fail) {
  if (query === undefined) return;
  const problem = schemaProblem(query);
  if (problem) fail(`invalid query schema (${problem})`);
  for (const [name, rule] of Object.entries(query)) {
    if (!QUERY_TYPES.has(rule.type)) fail(`query ${name}: only string, int and boolean are allowed`);
  }
}

function validateBody(endpoint, formats, fail) {
  const body = endpoint.body === undefined ? { kinds: ["none"] } : endpoint.body;
  if (!isPlainObject(body)) fail("body is not an object");
  const kinds = body.kinds === undefined ? ["none"] : body.kinds;
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((kind) => !BODY_KINDS.has(kind))) fail("invalid body.kinds");
  if (kinds.includes("none") && kinds.length > 1) fail("body kind none cannot be combined");
  const hasBody = !kinds.includes("none");
  if (endpoint.method === "GET" && hasBody) fail("GET with a body kind other than none");

  if (body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1)) fail("invalid body.limit");
  if (body.limit > BODY_LIMIT_MAX) fail("body.limit above 1 MiB");

  if (kinds.includes("multipart")) {
    if (!isPlainObject(body.file) || typeof body.file.part !== "string" || !body.file.part) fail("multipart without a file declaration");
    if (!isFunction(body.file.maxBytes) || !isFunction(body.file.accept)) fail("body.file needs maxBytes() and accept()");
  }
  if (hasBody) {
    if (body.schema === undefined && body.variants === undefined) fail("body has neither schema nor variants");
    if (body.schema !== undefined && body.variants !== undefined) fail("body has both schema and variants");
    if (body.schema !== undefined) {
      const problem = schemaProblem(body.schema);
      if (problem) fail(`invalid body schema (${problem})`);
    }
    if (body.variants !== undefined) {
      const variants = body.variants;
      if (!isPlainObject(variants) || typeof variants.by !== "string" || !variants.by) fail("invalid body.variants");
      let schemas = variants.schemas;
      if (isFunction(schemas)) {
        try {
          schemas = schemas({ formats });
        } catch {
          fail("body.variants.schemas() threw");
        }
      }
      if (!isPlainObject(schemas) || Object.keys(schemas).length === 0) fail("invalid body.variants.schemas");
      for (const [name, schema] of Object.entries(schemas)) {
        const problem = schemaProblem(schema);
        if (problem) fail(`invalid variant schema ${name} (${problem})`);
      }
    }
    if (body.refine !== undefined && !isFunction(body.refine)) fail("body.refine is not a function");
  }
}

/** Throws an ApiRegistryError naming the endpoint; returns the declared rights of the endpoint */
function validateEndpoint(endpoint, file, formats) {
  const name = isPlainObject(endpoint) && typeof endpoint.id === "string" && endpoint.id ? endpoint.id : file;
  const fail = (reason) => {
    throw new ApiRegistryError(name, file, reason);
  };
  if (!isPlainObject(endpoint)) fail("the module does not export an object");
  if (typeof endpoint.id !== "string" || !ID_PATTERN.test(endpoint.id)) fail("invalid id");
  if (!METHODS.has(endpoint.method)) fail("invalid method");
  if (typeof endpoint.path !== "string" || !PATH_PREFIX.test(endpoint.path) || /\/\/|\/$/.test(endpoint.path)) {
    fail("path outside /api/v<n>/ or malformed");
  }
  const params = endpoint.params === undefined ? {} : endpoint.params;
  if (!isPlainObject(params)) fail("params is not an object");
  const declared = pathParams(endpoint.path);
  for (const param of declared) {
    const pattern = params[param];
    if (!(pattern instanceof RegExp)) fail(`path parameter :${param} has no pattern`);
    if (pattern.global || pattern.sticky) fail(`pattern of :${param} must not be global or sticky`);
  }
  for (const param of Object.keys(params)) {
    if (!declared.includes(param)) fail(`pattern for :${param} but the path has no such parameter`);
  }
  const rights = validateRights(endpoint, formats, fail);
  validateQuery(endpoint.query, fail);
  validateBody(endpoint, formats, fail);
  if (endpoint.recipient !== undefined && !isFunction(endpoint.recipient)) fail("recipient is not a function");
  if (endpoint.idempotent !== undefined && typeof endpoint.idempotent !== "boolean") fail("idempotent is not a boolean");
  if (endpoint.quota !== undefined && !isPlainObject(endpoint.quota)) fail("quota is not an object");
  if (endpoint.deprecated !== undefined) {
    const d = endpoint.deprecated;
    if (!isPlainObject(d) || typeof d.since !== "string" || typeof d.sunset !== "string") fail("invalid deprecated declaration");
  }
  if (!isPlainObject(endpoint.doc) || typeof endpoint.doc.summary !== "string" || !endpoint.doc.summary.trim()) {
    fail("doc.summary is missing");
  }
  if (!isFunction(endpoint.handle)) fail("handle is not a function");
  return rights;
}

function groupOf(id, formatRights) {
  if (formatRights.has(id)) return { group: "send", format: id.slice("messages.send.".length) };
  if (Object.hasOwn(FIXED_GROUPS, id)) return { group: FIXED_GROUPS[id], format: null };
  return { group: id.split(".")[0], format: null };
}

function buildCatalogue(declared, formats) {
  const formatOrder = formats && isFunction(formats.rights) ? formats.rights() : [];
  const formatRights = new Set(formatOrder);
  const rows = [...declared].map((id) => ({ id, ...groupOf(id, formatRights) }));
  const rank = (row) => {
    const at = GROUP_ORDER.indexOf(row.group);
    return at === -1 ? GROUP_ORDER.length : at;
  };
  rows.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.group !== b.group) return a.group < b.group ? -1 : 1;
    if (a.group === "send") return formatOrder.indexOf(a.id) - formatOrder.indexOf(b.id);
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return rows;
}

/**
 * @param {{ dir: string, formats?: object }} options
 * @returns {{ endpoints: object[], rights: {id: string, group: string, format: string|null}[], byRoute: Map<string, object>, router: object }}
 * @throws {ApiRegistryError}
 */
function loadEndpoints({ dir, formats } = {}) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith(".js")).sort();
  } catch (err) {
    if (err && err.code === "ENOENT") files = [];
    else throw new ApiRegistryError(path.basename(String(dir)), path.basename(String(dir)), "endpoint directory unreadable");
  }

  const endpoints = [];
  const ids = new Set();
  const routes = new Map();
  const declared = new Set();

  for (const file of files) {
    let endpoint;
    try {
      endpoint = require(path.join(dir, file));
    } catch (err) {
      throw new ApiRegistryError(file, file, `module failed to load (${(err && err.name) || "Error"})`);
    }
    const rights = validateEndpoint(endpoint, file, formats);
    if (ids.has(endpoint.id)) throw new ApiRegistryError(endpoint.id, file, "duplicate id");
    const route = `${endpoint.method} ${endpoint.path}`;
    if (routes.has(route)) throw new ApiRegistryError(endpoint.id, file, "duplicate method and path");
    ids.add(endpoint.id);
    routes.set(route, endpoint);
    endpoints.push(endpoint);
    for (const id of rights) declared.add(id);
  }

  let router;
  try {
    router = createApiRouter({ endpoints });
  } catch (err) {
    if (err instanceof ApiRouterError) {
      const owner = endpoints.find((endpoint) => endpoint.id === err.endpoint);
      throw new ApiRegistryError(err.endpoint, owner ? `${owner.id}` : "router", err.reason);
    }
    throw err;
  }

  return { endpoints, rights: buildCatalogue(declared, formats), byRoute: routes, router };
}

module.exports = { loadEndpoints, rightsOf, ApiRegistryError, BODY_LIMIT_DEFAULT, BODY_LIMIT_MAX };
