"use strict";
/**
 * The OpenAPI builder (feature 004, contracts/runtime.md section 15.12, public-api.md section 10): a pure function of
 * fake endpoint and format registries. The mapper from the dialect of lib/utils/schema.js, one operation per endpoint,
 * the request bodies, the shared components, memoisation and byte stability. The document served by the real
 * endpoints is checked by test/api-openapi.test.js (F-PUB).
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { buildOpenApi, createOpenApi, schemaOfRule, schemaOfShape } = require("../lib/api/openapi");
const { API_VERSION, majorOf } = require("../lib/api/version");
const { API_STATUS } = require("../lib/api/errors");
const { MESSAGING_STATUS, FAILURE_CODES, CANCEL_REASONS, UNKNOWN_REASONS, STATUSES, CODE_STATUS } = require("../lib/messaging/errors");

const MSG_ID = /^msg_[A-Za-z0-9_-]{22}$/;

// ---- fake registries ----------------------------------------------------------------------------------------------
const textSchema = {
  format: { type: "string", required: true, enum: ["text"] },
  to: { type: "string", required: true, trim: true, minLength: 1, maxLength: 64 },
  text: { type: "string", required: true, minLength: 1, maxLength: 4096 },
  mentions: { type: "array", max: 50, unique: true, items: { type: "string", maxLength: 20 } },
  linkPreview: { type: "boolean", default: false },
};
const contactSchema = {
  format: { type: "string", required: true, enum: ["contact"] },
  to: { type: "string", required: true },
  contacts: {
    type: "array",
    required: true,
    min: 1,
    max: 10,
    items: { type: "object", shape: { name: { type: "string", required: true, maxLength: 128 }, email: { type: "string", nullable: true, pattern: /^[^@]+@[^@]+$/ } } },
  },
};
const fakeFormats = {
  list: () => [{ name: "text" }, { name: "contact" }],
  rights: () => ["messages.send.text", "messages.send.contact"],
  schemaOf: (name) => ({ text: textSchema, contact: contactSchema })[name],
  describe: (name) => ({ name, example: { format: name, to: "237690000001" } }),
  doc: (name) => ({ summary: `Send a ${name}`, examples: [{ format: name, to: "237690000001", ...(name === "text" ? { text: "hello" } : { contacts: [{ name: "Acme" }] }) }] }),
};

const create = {
  id: "messages.create",
  method: "POST",
  path: "/api/v1/messages",
  rights: ({ formats }) => [...formats.rights(), "media.url"],
  requires: () => [],
  query: { wait: { type: "int", min: 0, max: 30, default: 0 } },
  body: {
    kinds: ["json", "multipart"],
    limit: 65536,
    variants: { by: "format", schemas: ({ formats }) => Object.fromEntries(formats.list().map((f) => [f.name, formats.schemaOf(f.name)])) },
    file: { part: "file", maxBytes: () => 1, accept: () => null },
  },
  idempotent: true,
  quota: { messages: true },
  response: { status: 202, headers: ["Location"] },
  doc: { summary: "Send one message", description: "Queues a message.", tags: ["messages"] },
  handle() {},
};
const get = {
  id: "messages.get",
  method: "GET",
  path: "/api/v1/messages/:id",
  params: { id: MSG_ID },
  right: "messages.read",
  doc: { summary: "Status of one message" },
  handle() {},
};
const list = {
  id: "messages.list",
  method: "GET",
  path: "/api/v1/messages",
  right: "messages.read",
  query: { status: { type: "string", enum: [...STATUSES] }, limit: { type: "int", min: 1, max: 100, default: 25 } },
  doc: { summary: "Own messages" },
  handle() {},
};
const docs = { id: "openapi.get", method: "GET", path: "/api/v1/openapi.json", right: "api.docs", doc: { summary: "OpenAPI document" }, handle() {} };
const ENDPOINTS = [create, get, list, docs];

// ---- a structural checker (no validator dependency exists in the tree) ------------------------------------------------
function resolve(doc, ref) {
  assert.ok(ref.startsWith("#/"), `local ref ${ref}`);
  return ref.slice(2).split("/").reduce((node, key) => {
    assert.ok(node && Object.hasOwn(node, key), `ref ${ref} does not resolve`);
    return node[key];
  }, doc);
}
function walk(node, visit, at = "$") {
  if (Array.isArray(node)) return node.forEach((item, i) => walk(item, visit, `${at}[${i}]`));
  if (node && typeof node === "object") {
    visit(node, at);
    for (const [key, value] of Object.entries(node)) walk(value, visit, `${at}.${key}`);
  }
  return undefined;
}
function operationsOf(doc) {
  const out = [];
  for (const [p, item] of Object.entries(doc.paths)) for (const [method, op] of Object.entries(item)) out.push({ path: p, method, op });
  return out;
}

describe("the mapper (schemaOfRule / schemaOfShape)", () => {
  test("string: lengths, pattern source, enum", () => {
    assert.deepEqual(schemaOfRule({ type: "string", minLength: 1, maxLength: 4096, pattern: /^a+$/, enum: ["a", "aa"] }), { type: "string", minLength: 1, maxLength: 4096, pattern: "^a+$", enum: ["a", "aa"] });
    assert.deepEqual(schemaOfRule({ type: "string" }), { type: "string" });
  });

  test("int and number: bounds become minimum and maximum; defaults are kept", () => {
    assert.deepEqual(schemaOfRule({ type: "int", min: 0, max: 30, default: 0 }), { type: "integer", minimum: 0, maximum: 30, default: 0 });
    assert.deepEqual(schemaOfRule({ type: "number", min: -90, max: 90 }), { type: "number", minimum: -90, maximum: 90 });
    assert.deepEqual(schemaOfRule({ type: "boolean", default: false }), { type: "boolean", default: false });
  });

  test("array: items, minItems, maxItems, uniqueItems", () => {
    assert.deepEqual(schemaOfRule({ type: "array", min: 2, max: 12, unique: true, items: { type: "string", maxLength: 100 } }), {
      type: "array",
      items: { type: "string", maxLength: 100 },
      minItems: 2,
      maxItems: 12,
      uniqueItems: true,
    });
  });

  test("a nested shape: an object with properties, required and additionalProperties false at every level", () => {
    const schema = schemaOfShape({ name: { type: "string", required: true }, phones: { type: "array", items: { type: "object", shape: { n: { type: "string", required: true } } } } });
    assert.deepEqual(schema, {
      type: "object",
      properties: {
        name: { type: "string" },
        phones: { type: "array", items: { type: "object", properties: { n: { type: "string" } }, additionalProperties: false, required: ["n"] } },
      },
      additionalProperties: false,
      required: ["name"],
    });
  });

  test("nullable becomes type: [T, \"null\"]", () => {
    assert.deepEqual(schemaOfRule({ type: "string", nullable: true, maxLength: 5 }), { type: ["string", "null"], maxLength: 5 });
    assert.deepEqual(schemaOfRule({ type: "int", nullable: true }), { type: ["integer", "null"] });
    assert.deepEqual(schemaOfRule({ type: "object", nullable: true, shape: { a: { type: "string" } } }).type, ["object", "null"]);
  });

  test("the mapper agrees with the validator on what it describes", () => {
    const { check } = require("../lib/utils/schema");
    const rule = { type: "string", minLength: 2, maxLength: 4 };
    assert.equal(check({ a: "x" }, { a: rule }).fields.a.code, "too_short");
    assert.equal(check({ a: "xxxxx" }, { a: rule }).fields.a.code, "too_long");
    const mapped = schemaOfRule(rule);
    assert.deepEqual([mapped.minLength, mapped.maxLength], [2, 4]);
  });
});

describe("the document", () => {
  const doc = buildOpenApi({ endpoints: ENDPOINTS, formats: fakeFormats, serverUrl: "https://bot.example.com/api/v1" });

  test("OpenAPI 3.1.0, info.version is API_VERSION and its major is the path version", () => {
    assert.equal(doc.openapi, "3.1.0");
    assert.equal(doc.info.version, API_VERSION);
    assert.equal(majorOf(doc.info.version), 1);
    assert.equal(doc.servers[0].url, "https://bot.example.com/api/v1");
    assert.match(doc.info.title, /messaging API/);
  });

  test("bearerAuth is an http bearer scheme with the owbk format, applied globally and to every operation", () => {
    assert.deepEqual(doc.components.securitySchemes.bearerAuth, { type: "http", scheme: "bearer", bearerFormat: "owbk_<id>_<secret>" });
    assert.deepEqual(doc.security, [{ bearerAuth: [] }]);
    for (const { op } of operationsOf(doc)) assert.deepEqual(op.security, [{ bearerAuth: [] }]);
  });

  test("one operation per endpoint, operationId = the registry id, paths relative to the server", () => {
    const ops = operationsOf(doc);
    assert.deepEqual(ops.map((o) => o.op.operationId).sort(), ENDPOINTS.map((e) => e.id).sort());
    assert.equal(new Set(ops.map((o) => o.op.operationId)).size, ops.length);
    assert.deepEqual(Object.keys(doc.paths).sort(), ["/messages", "/messages/{id}", "/openapi.json"]);
    assert.ok(doc.paths["/messages"].post && doc.paths["/messages"].get);
    assert.equal(doc.paths["/messages/{id}"].get.operationId, "messages.get");
  });

  test("every {param} of a path is declared; query parameters and Idempotency-Key are listed", () => {
    for (const { path: p, op } of operationsOf(doc)) {
      for (const [, name] of p.matchAll(/\{([^}]+)\}/g)) {
        const found = op.parameters.find((param) => param.in === "path" && param.name === name);
        assert.ok(found && found.required === true, `${op.operationId} declares {${name}}`);
      }
    }
    const post = doc.paths["/messages"].post;
    assert.deepEqual(post.parameters.find((p) => p.name === "wait"), { name: "wait", in: "query", required: false, schema: { type: "integer", minimum: 0, maximum: 30, default: 0 } });
    assert.deepEqual(post.parameters.find((p) => p.$ref), { $ref: "#/components/parameters/IdempotencyKey" });
    assert.equal(resolve(doc, "#/components/parameters/IdempotencyKey").name, "Idempotency-Key");
    assert.equal(doc.paths["/messages/{id}"].get.parameters.find((p) => p.name === "id").schema.pattern, MSG_ID.source);
    assert.ok(!doc.paths["/messages/{id}"].get.parameters.some((p) => p.$ref), "GET is not idempotent-keyed");
    const status = doc.paths["/messages"].get.parameters.find((p) => p.name === "status");
    assert.deepEqual(status.schema.enum, [...STATUSES]);
  });

  test("x-required-rights (static and dynamic), x-quota, x-idempotent", () => {
    assert.deepEqual(doc.paths["/messages"].post["x-required-rights"], ["messages.send.text", "messages.send.contact", "media.url"]);
    assert.deepEqual(doc.paths["/messages/{id}"].get["x-required-rights"], ["messages.read"]);
    assert.deepEqual(doc.paths["/openapi.json"].get["x-required-rights"], ["api.docs"]);
    assert.deepEqual(doc.paths["/messages"].post["x-quota"], { messages: true });
    assert.equal(doc.paths["/messages"].get["x-quota"], null);
    assert.equal(doc.paths["/messages"].post["x-idempotent"], true);
    assert.equal(doc.paths["/messages"].get["x-idempotent"], false);
    for (const { op } of operationsOf(doc)) assert.ok(Array.isArray(op["x-required-rights"]) && op["x-required-rights"].length > 0, op.operationId);
  });

  test("the send operation: JSON and multipart bodies, oneOf with a discriminator on format, one named example per format", () => {
    const body = doc.paths["/messages"].post.requestBody;
    assert.equal(body.required, true);
    assert.deepEqual(Object.keys(body.content).sort(), ["application/json", "multipart/form-data"]);
    const json = body.content["application/json"];
    assert.deepEqual(json.schema.oneOf, [{ $ref: "#/components/schemas/MessagesCreateText" }, { $ref: "#/components/schemas/MessagesCreateContact" }]);
    assert.deepEqual(json.schema.discriminator, {
      propertyName: "format",
      mapping: { text: "#/components/schemas/MessagesCreateText", contact: "#/components/schemas/MessagesCreateContact" },
    });
    assert.deepEqual(Object.keys(json.examples).sort(), ["contact", "text"]);
    assert.equal(json.examples.text.value.text, "hello");
    assert.equal(json.examples.text.summary, "Send a text");
    assert.equal(resolve(doc, "#/components/schemas/MessagesCreateText").properties.text.maxLength, 4096);

    const multipart = body.content["multipart/form-data"];
    assert.deepEqual(multipart.schema.required, ["message"]);
    assert.equal(multipart.schema.properties.file.format, "binary");
    assert.deepEqual(multipart.encoding.message, { contentType: "application/json" });
    assert.ok(multipart.schema.properties.message.contentSchema.oneOf);
  });

  test("a GET has no requestBody; success responses use the declared status and headers", () => {
    assert.equal(doc.paths["/messages"].get.requestBody, undefined);
    const accepted = doc.paths["/messages"].post.responses["202"];
    assert.ok(accepted);
    assert.ok(accepted.headers.Location && accepted.headers["Idempotent-Replayed"] && accepted.headers["RateLimit-Remaining"]);
    assert.ok(doc.paths["/messages/{id}"].get.responses["200"]);
    assert.equal(doc.paths["/messages/{id}"].get.responses["202"], undefined);
  });

  test("error responses are $refs to components.responses; bodies add 413, 415, 422; idempotent adds 409", () => {
    const post = doc.paths["/messages"].post.responses;
    for (const code of ["400", "401", "403", "404", "405", "409", "413", "415", "422", "429", "500", "503"]) {
      assert.deepEqual(post[code], { $ref: `#/components/responses/Error${code}` }, code);
    }
    const getResponses = doc.paths["/messages/{id}"].get.responses;
    for (const code of ["413", "415", "422", "409"]) assert.equal(getResponses[code], undefined, `GET has no ${code}`);
    const throttled = resolve(doc, "#/components/responses/Error429");
    assert.ok(throttled.headers["Retry-After"]);
    assert.equal(throttled.content["application/json"].schema.$ref, "#/components/schemas/Error");
  });

  test("components.schemas.Error enumerates both code tables; FailureCode the 14 codes; MessageStatus the nine statuses", () => {
    const codes = doc.components.schemas.Error.properties.error.properties.code.enum;
    assert.deepEqual(codes, Object.keys({ ...MESSAGING_STATUS, ...API_STATUS }));
    assert.equal(codes.length, 28);
    assert.deepEqual(doc.components.schemas.FailureCode.enum.slice().sort(), Object.keys(CODE_STATUS).sort());
    assert.equal(doc.components.schemas.FailureCode.enum.length, 14);
    assert.deepEqual(doc.components.schemas.FailureCode.enum.slice().sort(), [...Object.keys(FAILURE_CODES), ...Object.keys(CANCEL_REASONS), ...Object.keys(UNKNOWN_REASONS)].sort());
    assert.deepEqual(doc.components.schemas.MessageStatus.enum, [...STATUSES]);
    assert.equal(doc.components.schemas.MessageStatus.enum.length, 9);
    assert.deepEqual(doc.components.schemas.Right.enum, ["messages.send.text", "messages.send.contact", "media.url", "messages.read", "api.docs"]);
  });

  test("the Message resource matches public-api.md 4.1", () => {
    const message = doc.components.schemas.Message;
    assert.deepEqual(Object.keys(message.properties), ["id", "format", "to", "chatType", "status", "size", "requestId", "steps", "expiresAt", "endedAt", "failure", "responses"]);
    assert.deepEqual(Object.keys(message.properties.steps.properties), ["queued", "sending", "sent", "delivered", "read"]);
    assert.equal(message.properties.id.pattern, MSG_ID.source);
    assert.equal(message.additionalProperties, false);
  });

  test("every $ref resolves, every object schema has additionalProperties false (apart from free-form params)", () => {
    const refs = [];
    walk(doc, (node) => {
      if (typeof node.$ref === "string") refs.push(node.$ref);
    });
    assert.ok(refs.length > 20);
    for (const ref of refs) resolve(doc, ref);
    const open = [];
    walk(doc.components.schemas, (node, at) => {
      if (node.type === "object" && node.properties && node.additionalProperties !== false) open.push(at);
    });
    walk(doc.paths, (node, at) => {
      if (node.type === "object" && node.properties && node.additionalProperties !== false) open.push(at);
    });
    assert.deepEqual(open, []);
  });

  test("every error code a response mentions is in the catalogue (all responses are the shared ones)", () => {
    const used = new Set();
    for (const { op } of operationsOf(doc)) for (const [, value] of Object.entries(op.responses)) if (value.$ref) used.add(value.$ref.split("/").pop());
    for (const name of used) assert.ok(Object.hasOwn(doc.components.responses, name), name);
  });
});

describe("deprecation", () => {
  test("a deprecated endpoint is flagged and announces Deprecation and Sunset", () => {
    const old = { id: "old.get", method: "GET", path: "/api/v1/old", right: "old.read", deprecated: { since: "2026-01-01T00:00:00Z", sunset: "2027-01-01T00:00:00Z", link: "/api/v1/messages" }, doc: { summary: "Old" }, handle() {} };
    const doc = buildOpenApi({ endpoints: [old], formats: fakeFormats });
    const op = doc.paths["/old"].get;
    assert.equal(op.deprecated, true);
    assert.deepEqual(op["x-deprecation"], { since: "2026-01-01T00:00:00Z", sunset: "2027-01-01T00:00:00Z", link: "/api/v1/messages" });
    assert.ok(op.responses["200"].headers.Deprecation && op.responses["200"].headers.Sunset);
    assert.equal(doc.paths["/messages"], undefined);
  });
});

describe("memoisation and stability", () => {
  test("the base document is built once; only `servers` varies per call", () => {
    const endpoints = [get, docs];
    const a = buildOpenApi({ endpoints, formats: fakeFormats, serverUrl: "https://a.example/api/v1" });
    const b = buildOpenApi({ endpoints, formats: fakeFormats, serverUrl: "https://b.example/api/v1" });
    assert.notDeepEqual(a.servers, b.servers);
    assert.equal(a.components, b.components, "memoised: the same objects");
    assert.equal(a.paths, b.paths);
    assert.deepEqual({ ...a, servers: null }, { ...b, servers: null });
  });

  test("byte-stable: the same declarations give the same text, key order included", () => {
    const first = JSON.stringify(buildOpenApi({ endpoints: ENDPOINTS, formats: fakeFormats }));
    const second = JSON.stringify(buildOpenApi({ endpoints: [...ENDPOINTS], formats: fakeFormats }));
    assert.equal(first, second);
  });

  test("another set of endpoints or formats is another document (SC-009: a demo module appears with no other edit)", () => {
    const before = buildOpenApi({ endpoints: ENDPOINTS, formats: fakeFormats });
    const demo = { id: "demo.get", method: "GET", path: "/api/v1/demo", right: "demo.read", doc: { summary: "Demo module" }, handle() {} };
    const after = buildOpenApi({ endpoints: [...ENDPOINTS, demo], formats: fakeFormats });
    assert.equal(before.paths["/demo"], undefined);
    assert.equal(after.paths["/demo"].get.operationId, "demo.get");
    assert.ok(after.components.schemas.Right.enum.includes("demo.read"));

    const withFormat = { ...fakeFormats, list: () => [{ name: "text" }, { name: "contact" }, { name: "demo" }], rights: () => ["messages.send.text", "messages.send.contact", "messages.send.demo"], schemaOf: (n) => (n === "demo" ? { format: { type: "string", required: true, enum: ["demo"] }, to: { type: "string", required: true } } : fakeFormats.schemaOf(n)) };
    const formatted = buildOpenApi({ endpoints: ENDPOINTS, formats: withFormat });
    assert.ok(formatted.components.schemas.MessagesCreateDemo);
    assert.ok(formatted.paths["/messages"].post["x-required-rights"].includes("messages.send.demo"));
  });

  test("the shared base is frozen: a caller cannot alter the next document", () => {
    const shared = buildOpenApi({ endpoints: ENDPOINTS, formats: fakeFormats });
    assert.ok(Object.isFrozen(shared.components) && Object.isFrozen(shared.paths));
    assert.throws(() => shared.components.schemas.FailureCode.enum.push("x"), TypeError);
  });

  test("works with no formats and no endpoints (a failed registry, a disabled API)", () => {
    const empty = buildOpenApi({ endpoints: [], formats: null });
    assert.equal(empty.openapi, "3.1.0");
    assert.deepEqual(empty.paths, {});
    assert.deepEqual(empty.components.schemas.Right.enum, []);
  });

  test("createOpenApi({...}).document(serverUrl) is the facade used by api.openapi()", () => {
    const facade = createOpenApi({ endpoints: ENDPOINTS, formats: fakeFormats });
    assert.equal(facade.document("https://x.example/api/v1").servers[0].url, "https://x.example/api/v1");
    assert.equal(facade.document("/api/v1").components, facade.document("https://y.example/api/v1").components);
  });

  test("the module is pure: it requires no timer, no database and no heavy module", () => {
    const text = require("node:fs").readFileSync(require.resolve("../lib/api/openapi"), "utf8");
    assert.ok(!/setTimeout|setInterval|require\("sharp"\)|require\("file-type"\)|\.\.\/database/.test(text.replace(/\/\*[\s\S]*?\*\//g, "")));
  });
});
