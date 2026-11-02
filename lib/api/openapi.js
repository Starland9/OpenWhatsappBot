"use strict";

/**
 * OpenAPI 3.1 document of the public messaging API (feature 004, contracts/runtime.md section 15.12, public-api.md
 * section 10, FR-084). A pure function of the registered endpoint modules and the format registry: nothing is
 * maintained by hand, so the document, the validation and the panel cannot drift (SC-009).
 *
 *   buildOpenApi({ endpoints, formats, info, serverUrl, errors }) -> object
 *   createOpenApi({ endpoints, formats, info, errors })           -> { document(serverUrl) }
 *   schemaOfRule(rule), schemaOfShape(shape)                     the one mapper from the dialect of lib/utils/schema.js
 *
 * One mapper feeds the document from the same rules that validate the requests: `string` -> `type: string` with
 * `minLength` / `maxLength` (JSON Schema counts code points, like the validator) / `pattern` / `enum`; `int` ->
 * `integer`; `number`; `boolean`; `array` -> `items`, `minItems` / `maxItems`, `uniqueItems` for `unique`; a nested
 * `shape` -> `object` with `properties` and `required`; `nullable` -> `type: [T, "null"]`; every object has
 * `additionalProperties: false` (an unknown property is refused).
 *
 * One operation per endpoint (`operationId` = the registry id) with its path and query parameters, `Idempotency-Key`,
 * a `requestBody` offering `application/json` and `multipart/form-data` (with `encoding` for the `message` part), the
 * success response and the error responses by `$ref`; the extensions `x-required-rights`, `x-quota`, `x-idempotent`.
 * The send operation lists the format schemas under `oneOf` with a `discriminator` on `format` and one named example
 * per format. `components.schemas.Error` enumerates `Object.keys({ ...MESSAGING_STATUS, ...API_STATUS })`,
 * `FailureCode` the 14 message-level codes, `MessageStatus` the nine statuses. English only (research U8).
 *
 * W3 completion (F-PUB): an endpoint names the components its success answer returns with `response.openapi` (a ready
 * JSON Schema, for example `{ properties: { message: { $ref: "#/components/schemas/Message" } } }`); `response.headers`
 * (`Location`) and a deprecated endpoint's `Deprecation` / `Sunset` / `Link` are declared on the success response; the
 * `Message` component is pinned to the real resource by test/api-openapi.test.js.
 *
 * Memoised after the first build (declarations are static after boot): the base document is built once per
 * (endpoints, formats, info, errors) and only `servers` varies per call. The output is byte-stable. The shared base is
 * frozen (a caller that wants to change a document copies it).
 */

const { API_VERSION, PATH_VERSION, BASE_PATH } = require("./version");
const { rightsOf } = require("./registry");

const FIELD_CODES = [
  "required",
  "invalid_type",
  "invalid_format",
  "too_short",
  "too_long",
  "out_of_range",
  "not_allowed",
  "too_many_items",
  "unknown_field",
  "invalid_order",
  "duplicate",
  "not_found",
];
const ERROR_RESPONSES = Object.freeze({
  400: "The request is malformed (bad JSON, bad multipart, a key in the URL).",
  401: "The key is missing, unknown, wrong, revoked or expired.",
  403: "HTTPS is required, a browser call, an IP outside the allowlist, a missing right or a recipient outside the policy.",
  404: "Unknown path, unknown message, another key's message.",
  405: "The verb is not allowed for this path.",
  409: "A conflict (a disabled chat, an idempotency key reused with another content).",
  413: "The body or the file is too large.",
  415: "The Content-Type is neither JSON nor multipart.",
  422: "The request is invalid (see `fields`) or its content does not match.",
  429: "A rate limit, a quota or the origin block (see Retry-After).",
  500: "Internal error, logged with the request id.",
  502: "The remote of a media URL failed.",
  503: "Unavailable: starting, restore in progress, queue full.",
});

const pascal = (text) => String(text).replace(/(^|[._-])([a-z0-9])/g, (_, __, c) => c.toUpperCase());

// ---- the mapper from the dialect of lib/utils/schema.js ------------------------------------------------------------
function schemaOfRule(rule) {
  const out = {};
  switch (rule.type) {
    case "string":
      out.type = "string";
      if (rule.minLength !== undefined) out.minLength = rule.minLength;
      if (rule.maxLength !== undefined) out.maxLength = rule.maxLength;
      if (rule.pattern) out.pattern = rule.pattern.source;
      if (rule.enum) out.enum = [...rule.enum];
      break;
    case "int":
    case "number":
      out.type = rule.type === "int" ? "integer" : "number";
      if (rule.min !== undefined) out.minimum = rule.min;
      if (rule.max !== undefined) out.maximum = rule.max;
      if (rule.enum) out.enum = [...rule.enum];
      break;
    case "boolean":
      out.type = "boolean";
      break;
    case "array":
      out.type = "array";
      if (rule.items) out.items = schemaOfRule(rule.items);
      if (rule.min !== undefined) out.minItems = rule.min;
      if (rule.max !== undefined) out.maxItems = rule.max;
      if (rule.unique) out.uniqueItems = true;
      break;
    case "object":
      if (rule.shape) return nullable(rule, { ...schemaOfShape(rule.shape) });
      out.type = "object";
      out.additionalProperties = false;
      break;
    default:
      break;
  }
  return nullable(rule, out);
}

function nullable(rule, schema) {
  if (rule.default !== undefined) schema.default = rule.default;
  if (rule.nullable && typeof schema.type === "string") schema.type = [schema.type, "null"];
  return schema;
}

/** A schema (name -> rule) as an object schema: properties, required, additionalProperties: false */
function schemaOfShape(shape) {
  const properties = {};
  const required = [];
  for (const [name, rule] of Object.entries(shape)) {
    properties[name] = schemaOfRule(rule);
    if (rule.required) required.push(name);
  }
  const out = { type: "object", properties, additionalProperties: false };
  if (required.length) out.required = required;
  return out;
}

// ---- shared components --------------------------------------------------------------------------------------------
function messageComponents(errors) {
  const { MESSAGING_STATUS, API_STATUS, FAILURE_CODES, CANCEL_REASONS, UNKNOWN_REASONS, STATUSES } = errors;
  const iso = { type: "string", format: "date-time" };
  const isoOrNull = { type: ["string", "null"], format: "date-time" };
  return {
    Error: {
      type: "object",
      required: ["error"],
      additionalProperties: false,
      properties: {
        error: {
          type: "object",
          required: ["code", "requestId"],
          additionalProperties: false,
          properties: {
            code: { type: "string", enum: Object.keys({ ...MESSAGING_STATUS, ...API_STATUS }) },
            fields: { type: "object", description: "Only for validation_failed: dotted path to field error.", additionalProperties: { $ref: "#/components/schemas/FieldError" } },
            params: { type: "object", description: "Numbers and codes only (limit, retryAfterMs, right, scope, reason, maxBytes, expected).", additionalProperties: true },
            requestId: { type: "string", pattern: "^[0-9a-f]{16}$" },
          },
        },
      },
    },
    FieldError: {
      type: "object",
      required: ["code"],
      additionalProperties: false,
      properties: { code: { type: "string", enum: FIELD_CODES }, params: { type: "object", additionalProperties: true } },
    },
    MessageStatus: { type: "string", enum: [...STATUSES] },
    FailureCode: { type: "string", enum: [...Object.keys(FAILURE_CODES), ...Object.keys(CANCEL_REASONS), ...Object.keys(UNKNOWN_REASONS)] },
    Message: {
      type: "object",
      required: ["id", "format", "to", "chatType", "status", "size", "requestId", "steps", "expiresAt", "endedAt", "failure"],
      additionalProperties: false,
      properties: {
        id: { type: "string", pattern: "^msg_[A-Za-z0-9_-]{22}$" },
        format: { type: "string" },
        to: { type: "string" },
        chatType: { type: "string", enum: ["private", "group"] },
        status: { $ref: "#/components/schemas/MessageStatus" },
        size: { type: ["integer", "null"] },
        requestId: { type: "string" },
        steps: {
          type: "object",
          additionalProperties: false,
          required: ["queued", "sending", "sent", "delivered", "read"],
          properties: { queued: iso, sending: isoOrNull, sent: isoOrNull, delivered: isoOrNull, read: isoOrNull },
        },
        expiresAt: iso,
        endedAt: isoOrNull,
        failure: {
          oneOf: [{ type: "null" }, { type: "object", required: ["code"], additionalProperties: false, properties: { code: { $ref: "#/components/schemas/FailureCode" } } }],
        },
        responses: { oneOf: [{ type: "null" }, { $ref: "#/components/schemas/MessageResponses" }] },
      },
    },
    MessageResponses: {
      type: "object",
      required: ["until", "total", "items", "totals"],
      additionalProperties: false,
      properties: {
        until: isoOrNull,
        total: { type: "integer" },
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["at", "author", "kind", "via", "choices"],
            additionalProperties: false,
            properties: {
              at: iso,
              author: { type: "string" },
              kind: { type: "string", enum: ["choice", "vote"] },
              via: { type: ["string", "null"], enum: ["tap", "number", null] },
              choices: {
                type: "array",
                items: { type: "object", required: ["id", "label"], additionalProperties: false, properties: { id: { type: "string" }, label: { type: "string" } } },
              },
            },
          },
        },
        totals: {
          type: ["array", "null"],
          items: { type: "object", required: ["id", "label", "count"], additionalProperties: false, properties: { id: { type: "string" }, label: { type: "string" }, count: { type: "integer" } } },
        },
      },
    },
  };
}

function responseComponents() {
  const retry = { "Retry-After": { description: "Seconds to wait.", schema: { type: "integer", minimum: 1 } } };
  const out = {};
  for (const [status, description] of Object.entries(ERROR_RESPONSES)) {
    out[`Error${status}`] = {
      description,
      headers: { "X-Request-Id": { $ref: "#/components/headers/XRequestId" }, ...(status === "429" || status === "503" ? retry : {}) },
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    };
  }
  return out;
}

// ---- the operations ------------------------------------------------------------------------------------------------
function relativePath(endpointPath) {
  return endpointPath.replace(new RegExp(`^${BASE_PATH.replace(/\//g, "\\/")}`), "").replace(/:([A-Za-z0-9_]+)/g, "{$1}") || "/";
}

function parametersOf(endpoint) {
  const out = [];
  for (const [name, pattern] of Object.entries(endpoint.params || {})) {
    out.push({ name, in: "path", required: true, schema: { type: "string", pattern: pattern.source } });
  }
  for (const [name, rule] of Object.entries(endpoint.query || {})) {
    const schema = schemaOfRule(rule);
    out.push({ name, in: "query", required: Boolean(rule.required), schema });
  }
  if (endpoint.idempotent) out.push({ $ref: "#/components/parameters/IdempotencyKey" });
  return out;
}

function bodyOf(endpoint, formats, components, examplesFor) {
  const body = endpoint.body;
  if (!body || !body.kinds || body.kinds.includes("none")) return undefined;
  let jsonSchema;
  let examples;
  if (body.variants) {
    const schemas = typeof body.variants.schemas === "function" ? body.variants.schemas({ formats }) : body.variants.schemas;
    const mapping = {};
    const refs = [];
    examples = {};
    for (const [name, schema] of Object.entries(schemas)) {
      const key = `${pascal(endpoint.id)}${pascal(name)}`;
      components[key] = schemaOfShape(schema);
      mapping[name] = `#/components/schemas/${key}`;
      refs.push({ $ref: mapping[name] });
      const example = examplesFor(name);
      if (example) examples[name] = example;
    }
    jsonSchema = { oneOf: refs, discriminator: { propertyName: body.variants.by, mapping } };
  } else {
    jsonSchema = schemaOfShape(body.schema || {});
  }
  const content = {};
  if (body.kinds.includes("json")) {
    content["application/json"] = { schema: jsonSchema, ...(examples && Object.keys(examples).length ? { examples } : {}) };
  }
  if (body.kinds.includes("multipart")) {
    content["multipart/form-data"] = {
      schema: {
        type: "object",
        required: ["message"],
        additionalProperties: false,
        properties: {
          message: { type: "string", description: "The JSON object of the request, as text (at most 64 KiB). Sent first.", contentMediaType: "application/json", contentSchema: jsonSchema },
          file: { type: "string", format: "binary", description: "The media, for the formats that take one. Sent second. Its content is judged by its bytes." },
        },
      },
      encoding: { message: { contentType: "application/json" }, file: { contentType: "application/octet-stream" } },
    };
  }
  return { required: true, content };
}

function operationOf(endpoint, { formats, components, examplesFor, declared }) {
  const hasBody = Boolean(endpoint.body && endpoint.body.kinds && !endpoint.body.kinds.includes("none"));
  const status = String((endpoint.response && endpoint.response.status) || 200);
  const successHeaders = { "X-Request-Id": { $ref: "#/components/headers/XRequestId" } };
  for (const name of (endpoint.response && endpoint.response.headers) || []) successHeaders[name] = { schema: { type: "string" } };
  if (endpoint.quota) {
    for (const name of ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"]) successHeaders[name] = { schema: { type: "integer" } };
  }
  if (endpoint.idempotent) successHeaders["Idempotent-Replayed"] = { description: "`true` on a replay.", schema: { type: "string", enum: ["true"] } };
  if (endpoint.deprecated) {
    successHeaders.Deprecation = { description: "Set while the endpoint is deprecated (RFC 9745).", schema: { type: "string" } };
    successHeaders.Sunset = { description: "The date from which the endpoint may stop answering (RFC 8594).", schema: { type: "string" } };
    if (endpoint.deprecated.link) successHeaders.Link = { description: 'The replacement, `rel="successor-version"`.', schema: { type: "string" } };
  }
  const success = { description: endpoint.response && endpoint.response.description ? endpoint.response.description : endpoint.doc.summary, headers: successHeaders };
  if (endpoint.response && endpoint.response.openapi) {
    // a ready JSON Schema (the endpoint names the components it returns, for example `Message`)
    success.content = { "application/json": { schema: endpoint.response.openapi } };
  } else if (endpoint.response && endpoint.response.schema) {
    success.content = { "application/json": { schema: schemaOfShape(endpoint.response.schema) } };
  } else if (status !== "204") {
    success.content = { "application/json": { schema: { type: "object" } } };
  }

  const codes = [400, 401, 403, 404, 405, 429, 500, 503];
  if (hasBody) codes.push(413, 415, 422);
  if (endpoint.idempotent) codes.push(409);
  if (hasBody && endpoint.body.variants) codes.push(502);
  const responses = { [status]: success };
  for (const code of [...new Set(codes)].sort()) responses[String(code)] = { $ref: `#/components/responses/Error${code}` };

  const operation = {
    operationId: endpoint.id,
    summary: endpoint.doc.summary,
    ...(endpoint.doc.description ? { description: endpoint.doc.description } : {}),
    tags: endpoint.doc.tags && endpoint.doc.tags.length ? [...endpoint.doc.tags] : [endpoint.id.split(".")[0]],
    security: [{ bearerAuth: [] }],
    "x-required-rights": [...declared],
    "x-quota": endpoint.quota ? { ...endpoint.quota } : null,
    "x-idempotent": endpoint.idempotent === true,
    parameters: parametersOf(endpoint),
    responses,
  };
  const requestBody = bodyOf(endpoint, formats, components, examplesFor);
  if (requestBody) operation.requestBody = requestBody;
  if (endpoint.deprecated) {
    operation.deprecated = true;
    operation["x-deprecation"] = { since: endpoint.deprecated.since, sunset: endpoint.deprecated.sunset, ...(endpoint.deprecated.link ? { link: endpoint.deprecated.link } : {}) };
  }
  return operation;
}

// ---- the document --------------------------------------------------------------------------------------------------
function defaultErrors() {
  const messaging = require("../messaging/errors");
  const { API_STATUS } = require("./errors");
  return { ...messaging, API_STATUS };
}

function buildBase({ endpoints, formats, info, errors }) {
  const tables = { ...defaultErrors(), ...(errors || {}) };
  const formatExample = (name) => {
    if (!formats) return null;
    const doc = typeof formats.doc === "function" ? formats.doc(name) : null;
    const example = (doc && doc.examples && doc.examples[0]) || (typeof formats.describe === "function" && formats.describe(name).example) || null;
    return example ? { summary: (doc && doc.summary) || name, value: example } : null;
  };

  const schemas = messageComponents(tables);
  const paths = {};
  const rights = new Set();
  for (const endpoint of endpoints) {
    const declared = rightsOf(endpoint, { formats });
    declared.forEach((id) => rights.add(id));
    const key = relativePath(endpoint.path);
    paths[key] = paths[key] || {};
    paths[key][endpoint.method.toLowerCase()] = operationOf(endpoint, { formats, components: schemas, examplesFor: formatExample, declared });
  }
  schemas.Right = { type: "string", enum: [...rights] };

  return {
    openapi: "3.1.0",
    info: {
      title: "OpenWhatsappBot messaging API",
      version: API_VERSION,
      description: `Send WhatsApp messages from a program. Version ${PATH_VERSION}; compatible changes keep this version, breaking ones arrive as a new path version served beside it.`,
      ...(info || {}),
    },
    servers: [{ url: BASE_PATH }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "owbk_<id>_<secret>" } },
      headers: { XRequestId: { description: "16 hexadecimal characters, also in `error.requestId`.", schema: { type: "string", pattern: "^[0-9a-f]{16}$" } } },
      parameters: {
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: false,
          description: "Scoped by API key, 24 hours. The same key and content returns the stored message; another content is a 409.",
          schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,80}$" },
        },
      },
      schemas,
      responses: responseComponents(),
    },
  };
}

/** The memoised base is shared by every caller: freeze it so nobody can alter the next document by accident */
function deepFreeze(node) {
  if (node && typeof node === "object" && !Object.isFrozen(node)) {
    Object.freeze(node);
    for (const value of Object.values(node)) deepFreeze(value);
  }
  return node;
}

const memo = new WeakMap(); // endpoints array -> [{ formats, info, errors, base }]

/** @returns {object} an OpenAPI 3.1 document; `serverUrl` is the only per-call input once the base is built */
function buildOpenApi({ endpoints = [], formats = null, info, serverUrl = BASE_PATH, errors } = {}) {
  let entries = memo.get(endpoints);
  if (!entries) {
    entries = [];
    memo.set(endpoints, entries);
  }
  let entry = entries.find((e) => e.formats === formats && e.info === info && e.errors === errors);
  if (!entry) {
    entry = { formats, info, errors, base: deepFreeze(buildBase({ endpoints, formats, info, errors })) };
    entries.push(entry);
  }
  return { ...entry.base, servers: [{ url: serverUrl }] };
}

function createOpenApi({ endpoints = [], formats = null, info, errors } = {}) {
  return { document: (serverUrl) => buildOpenApi({ endpoints, formats, info, serverUrl, errors }) };
}

module.exports = { buildOpenApi, createOpenApi, schemaOfRule, schemaOfShape, FIELD_CODES };
