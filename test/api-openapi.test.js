"use strict";
/**
 * Feature 004 (messaging API): the OpenAPI 3.1 document (contracts/public-api.md section 10, FR-084, FR-090 to FR-092)
 * and SC-009: structural checks (every reference resolves, unique operation ids, every parameter declared, every
 * operation secured and listing its rights, every error code in the catalogue, an example per format, byte-stable,
 * `info.version` major equal to the path version), PUB-4 over HTTP, and the demo-module test: a temporary endpoint and a
 * temporary format appear in the document, in the rights catalogue and in the panel catalogue with no other edit, and an
 * endpoint without a right keeps the whole API unserved while the bot keeps running.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const { createApiHarness } = require("./helpers/apiHarness");
const { createApi } = require("../lib/api");
const { API_VERSION, PATH_VERSION, majorOf } = require("../lib/api/version");
const { API_STATUS } = require("../lib/api/errors");
const { MESSAGING_STATUS, STATUSES, CODE_STATUS } = require("../lib/messaging/errors");
const formats = require("../lib/messaging/formats");
const schema = require("../lib/utils/schema");
const config = require("../config");

const ROOT = path.join(__dirname, "..");
const SEC = 1000;

let h;
let key;
let doc;
before(async () => {
  h = await createApiHarness({});
  key = await h.createKey({ name: "docs", rights: "all" });
  doc = h.api.openapi();
});
after(async () => {
  await h.close();
});

const walk = (node, visit, trail = "") => {
  visit(node, trail);
  if (node && typeof node === "object") for (const [name, value] of Object.entries(node)) walk(value, visit, `${trail}/${name}`);
};
const resolve = (ref) => ref.slice(2).split("/").reduce((node, part) => (node === undefined ? undefined : node[part.replace(/~1/g, "/").replace(/~0/g, "~")]), doc);

describe("structure", () => {
  test("OpenAPI 3.1.0, info.version is API_VERSION and its major equals the path version", () => {
    assert.equal(doc.openapi, "3.1.0");
    assert.equal(doc.info.version, API_VERSION);
    assert.equal(`v${majorOf(doc.info.version)}`, PATH_VERSION);
    assert.equal(PATH_VERSION, "v1");
    assert.equal(doc.servers.length, 1);
    assert.deepEqual(doc.security, [{ bearerAuth: [] }]);
    assert.deepEqual(doc.components.securitySchemes.bearerAuth, { type: "http", scheme: "bearer", bearerFormat: "owbk_<id>_<secret>" });
  });

  test("every $ref resolves", () => {
    let count = 0;
    walk(doc, (node) => {
      if (node && typeof node === "object" && typeof node.$ref === "string") {
        count += 1;
        assert.match(node.$ref, /^#\/components\//);
        assert.notEqual(resolve(node.$ref), undefined, node.$ref);
      }
    });
    assert.ok(count > 40);
  });

  test("one operation per endpoint, with a unique operationId equal to the registry id", () => {
    const ids = [];
    for (const [route, item] of Object.entries(doc.paths)) {
      for (const [verb, operation] of Object.entries(item)) {
        ids.push(operation.operationId);
        assert.ok(["get", "post", "put", "patch", "delete"].includes(verb), `${verb} ${route}`);
      }
    }
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual([...ids].sort(), h.api.routes().map((r) => r.id).sort());
    assert.deepEqual([...ids].sort(), ["messages.create", "messages.get", "messages.list", "openapi.get"]);
  });

  test("every parameter is declared: the path templates, the query and the Idempotency-Key header", () => {
    for (const [route, item] of Object.entries(doc.paths)) {
      for (const operation of Object.values(item)) {
        const params = operation.parameters.map((p) => (p.$ref ? resolve(p.$ref) : p));
        const names = params.map((p) => `${p.in}:${p.name}`);
        assert.equal(new Set(names).size, names.length, "no duplicate parameter");
        for (const template of route.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
          const declared = params.find((p) => p.in === "path" && p.name === template[1]);
          assert.ok(declared && declared.required === true, `${route} {${template[1]}}`);
        }
        for (const p of params.filter((x) => x.in === "path")) assert.ok(route.includes(`{${p.name}}`));
        for (const p of params) assert.ok(p.name && ["path", "query", "header"].includes(p.in) && p.schema);
      }
    }
    const create = doc.paths["/messages"].post;
    const query = create.parameters.filter((p) => p.in === "query").map((p) => p.name);
    assert.deepEqual(query, ["wait"]);
    assert.ok(create.parameters.some((p) => p.$ref === "#/components/parameters/IdempotencyKey"));
    const list = doc.paths["/messages"].get.parameters.filter((p) => p.in === "query").map((p) => p.name);
    assert.deepEqual(list, ["status", "format", "since", "until", "limit", "after"]);
  });

  test("every operation has security and x-required-rights equal to the registry's rights; x-quota and x-idempotent", () => {
    const routes = new Map(h.api.routes().map((r) => [r.id, r]));
    for (const item of Object.values(doc.paths)) {
      for (const operation of Object.values(item)) {
        assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
        assert.ok(Array.isArray(operation["x-required-rights"]) && operation["x-required-rights"].length > 0);
        assert.deepEqual(operation["x-required-rights"], routes.get(operation.operationId).rights);
        assert.equal(typeof operation["x-idempotent"], "boolean");
        assert.ok(operation["x-quota"] === null || typeof operation["x-quota"] === "object");
      }
    }
    assert.equal(doc.paths["/messages"].post["x-idempotent"], true);
    assert.deepEqual(doc.paths["/messages"].post["x-quota"], { messages: true });
    assert.equal(doc.paths["/messages"].get["x-idempotent"], false);
  });

  test("the success responses reference the Message component, with Location on PUB-1", () => {
    const created = doc.paths["/messages"].post.responses["202"];
    assert.equal(created.content["application/json"].schema.properties.message.$ref, "#/components/schemas/Message");
    assert.ok(created.headers.Location && created.headers["Idempotent-Replayed"] && created.headers["RateLimit-Limit"]);
    assert.equal(doc.paths["/messages/{id}"].get.responses["200"].content["application/json"].schema.properties.message.$ref, "#/components/schemas/Message");
    const list = doc.paths["/messages"].get.responses["200"].content["application/json"].schema;
    assert.equal(list.properties.messages.items.$ref, "#/components/schemas/Message");
    assert.deepEqual(Object.keys(doc.paths["/openapi.json"].get.responses).filter((s) => s.startsWith("2")), ["200"]);
  });

  test("every error code is in the catalogue, every error status is one of the contract's", () => {
    const catalogue = new Set(Object.keys({ ...API_STATUS, ...MESSAGING_STATUS }));
    const codes = doc.components.schemas.Error.properties.error.properties.code.enum;
    assert.deepEqual([...codes].sort(), [...catalogue].sort());
    const statuses = new Set([...Object.values(API_STATUS), ...Object.values(MESSAGING_STATUS)].map(String));
    for (const item of Object.values(doc.paths)) {
      for (const operation of Object.values(item)) {
        for (const [status, response] of Object.entries(operation.responses)) {
          if (Number(status) < 400) continue;
          assert.ok(statuses.has(status), status);
          assert.match(response.$ref, new RegExp(`^#/components/responses/Error${status}$`));
          const target = resolve(response.$ref);
          assert.equal(target.content["application/json"].schema.$ref, "#/components/schemas/Error");
          assert.ok(target.headers["X-Request-Id"]);
          if (status === "429" || status === "503") assert.ok(target.headers["Retry-After"], `${status} documents Retry-After`);
        }
      }
    }
    // every status of the catalogue is documented somewhere
    for (const status of statuses) assert.ok(doc.components.responses[`Error${status}`], status);
    assert.deepEqual(doc.components.schemas.FieldError.properties.code.enum.length, 12);
  });

  test("the enums: MessageStatus, FailureCode and Right", () => {
    assert.deepEqual(doc.components.schemas.MessageStatus.enum, [...STATUSES]);
    assert.deepEqual(doc.components.schemas.FailureCode.enum, Object.keys(CODE_STATUS));
    assert.deepEqual([...doc.components.schemas.Right.enum].sort(), h.api.rights().map((r) => r.id).sort());
  });

  test("every object schema is closed (additionalProperties: false), a free-form one is explicit", () => {
    const open = [];
    walk(doc.components.schemas, (node, trail) => {
      if (node && typeof node === "object" && node.type === "object" && node.properties && node.additionalProperties !== false) open.push(trail);
    });
    assert.deepEqual(open, []);
  });

  test("the Message component matches a real message resource, field for field", async () => {
    await h.drain();
    const res = await h.send(key, { format: "poll", to: "237690000001", question: "Q?", options: ["a", "b"] });
    const message = res.json.message;
    const component = doc.components.schemas.Message;
    assert.deepEqual(Object.keys(component.properties).sort(), Object.keys(message).sort());
    for (const name of component.required) assert.ok(Object.hasOwn(message, name), name);
    assert.deepEqual(Object.keys(component.properties.steps.properties), Object.keys(message.steps));
    assert.deepEqual(Object.keys(doc.components.schemas.MessageResponses.properties), Object.keys(message.responses));
    assert.match(message.id, new RegExp(component.properties.id.pattern));
    assert.match(message.requestId, /^[0-9a-f]{16}$/);
  });
});

describe("the send operation", () => {
  const create = () => doc.paths["/messages"].post;

  test("a oneOf of the 13 format schemas with a discriminator on format, and one named example per format", () => {
    const body = create().requestBody.content["application/json"];
    const names = formats.list().map((row) => row.name);
    assert.equal(body.schema.oneOf.length, 13);
    assert.equal(body.schema.discriminator.propertyName, "format");
    assert.deepEqual(Object.keys(body.schema.discriminator.mapping), names);
    for (const name of names) {
      const target = resolve(body.schema.discriminator.mapping[name]);
      assert.equal(target.additionalProperties, false);
      assert.deepEqual(target.properties.format.enum, [name]);
      assert.ok(target.required.includes("format") && target.required.includes("to"));
    }
    assert.deepEqual(Object.keys(body.examples), names);
    for (const name of names) {
      const example = body.examples[name].value;
      const checked = schema.check(example, formats.schemaOf(name));
      assert.deepEqual(checked.fields, {}, `the ${name} example validates against its own schema`);
    }
  });

  test("multipart/form-data offers the message part (JSON) and the file part", () => {
    const multipart = create().requestBody.content["multipart/form-data"];
    assert.deepEqual(Object.keys(multipart.schema.properties), ["message", "file"]);
    assert.equal(multipart.schema.properties.file.format, "binary");
    assert.equal(multipart.encoding.message.contentType, "application/json");
    assert.deepEqual(multipart.schema.required, ["message"]);
  });

  test("the schemas carry the limits the validator enforces", () => {
    const text = doc.components.schemas.MessagesCreateText.properties;
    assert.equal(text.text.maxLength, 4096);
    assert.equal(text.text.minLength, 1);
    assert.equal(text.mentions.maxItems, 50);
    assert.equal(doc.components.schemas.MessagesCreateLocation.properties.latitude.maximum, 90);
    assert.equal(doc.components.schemas.MessagesCreatePoll.properties.options.maxItems, 12);
    assert.equal(doc.components.schemas.MessagesCreatePoll.properties.options.uniqueItems, true);
    assert.equal(doc.components.schemas.MessagesCreateButtons.properties.buttons.maxItems, 3);
    assert.equal(doc.paths["/messages"].post.parameters.find((p) => p.name === "wait").schema.maximum, 30);
  });
});

describe("determinism", () => {
  test("byte-stable: two builds are identical, only servers varies per call", () => {
    const a = JSON.stringify(h.api.openapi({ baseUrl: "https://one.example.com" }));
    const b = JSON.stringify(h.api.openapi({ baseUrl: "https://one.example.com" }));
    assert.equal(a, b);
    const c = h.api.openapi({ baseUrl: "https://two.example.com" });
    assert.deepEqual(c.servers, [{ url: "https://two.example.com/api/v1" }]);
    assert.equal(JSON.stringify({ ...c, servers: null }), JSON.stringify({ ...JSON.parse(a), servers: null }));
    assert.equal(h.api.openapi().servers[0].url, "/api/v1");
  });

  test("the memoised base cannot be altered by a caller", () => {
    const first = h.api.openapi();
    assert.throws(() => {
      "use strict";
      first.paths["/messages"] = {};
    });
    assert.ok(first.paths["/messages"].post);
  });
});

describe("PUB-4 GET /api/v1/openapi.json", () => {
  test("serves the document for a key holding api.docs, English only", async () => {
    const res = await h.get("/api/v1/openapi.json", key);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /^application\/json; charset=utf-8$/);
    assert.deepEqual({ ...res.json, servers: null }, { ...JSON.parse(JSON.stringify(h.api.openapi())), servers: null });
    assert.match(res.json.servers[0].url, /^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/, "the origin the request came in on");
  });

  test("servers[0].url is the public panel URL plus /api/v1 when configured", async () => {
    config.PANEL_PUBLIC_URL = "https://bot.example.com/";
    try {
      const res = await h.get("/api/v1/openapi.json", key);
      assert.equal(res.json.servers[0].url, "https://bot.example.com/api/v1");
    } finally {
      config.PANEL_PUBLIC_URL = undefined;
    }
  });

  test("the Host header is never reflected when it is not a plain host name", async () => {
    const res = await h.get("/api/v1/openapi.json", key, { headers: { Host: "evil.example.com/<script>" } }).catch(() => null);
    if (res && res.status === 200) assert.equal(res.json.servers[0].url, "/api/v1");
  });

  test("the right api.docs is off for a key that does not hold it", async () => {
    const reader = await h.createKey({ name: "no docs", rights: h.allRights().filter((r) => r !== "api.docs") });
    const res = await h.get("/api/v1/openapi.json", reader);
    assert.equal(res.status, 403);
    assert.deepEqual(res.json.error.params, { right: "api.docs" });
  });
});

describe("SC-009: a new endpoint and a new format are one new file each", () => {
  const dirs = [];
  after(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });
  const temp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-sc009-"));
    dirs.push(dir);
    return dir;
  };
  const shim = (dir, name, target) => fs.writeFileSync(path.join(dir, name), `"use strict";\nmodule.exports = require(${JSON.stringify(target)});\n`);

  /** the four real endpoint modules plus a demo one, in a temporary directory */
  function endpointsWith(extra = {}) {
    const dir = temp();
    for (const name of ["messagesCreate", "messagesGet", "messagesList", "openapiJson"]) shim(dir, `${name}.js`, path.join(ROOT, "lib", "api", "endpoints", `${name}.js`));
    fs.writeFileSync(
      path.join(dir, "zping.js"),
      `"use strict";
const { reply } = require(${JSON.stringify(path.join(ROOT, "lib", "admin", "http", "response.js"))});
module.exports = {
  id: "ping.get",
  method: "GET",
  path: "/api/v1/ping",
  right: "ping.read",
  doc: { summary: "Ping the API", description: "A demo endpoint." },
  async handle() { return reply(200, { pong: true }); },
};
`,
    );
    for (const [name, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), text);
    return dir;
  }

  /** the thirteen real format modules plus a demo `shout` format */
  function formatsWith() {
    const dir = temp();
    for (const row of formats.list()) shim(dir, `${row.name}.js`, path.join(ROOT, "lib", "messaging", "formats", `${row.name}.js`));
    fs.writeFileSync(
      path.join(dir, "shout.js"),
      `"use strict";
module.exports = {
  name: "shout",
  order: 140,
  interactive: false,
  fields: { note: { type: "string", required: true, minLength: 1, maxLength: 100, trim: true } },
  size: (input) => Buffer.byteLength(input.note, "utf8"),
  build: (ctx) => ({ content: { text: ctx.input.note.toUpperCase() } }),
  doc: { summary: "Shout a note", examples: [{ format: "shout", to: "237690000001", note: "hello" }] },
};
`,
    );
    return dir;
  }

  test("the document, the rights catalogue and the panel catalogue show them with no other edit", () => {
    const registry = formats.createRegistry({ dir: formatsWith() });
    const api = createApi({ config: {}, formats: registry, endpointsDir: endpointsWith(), apiState: { isEnabled: () => true, plainHttpFrom: () => [] }, runtime: { dbReady: true } });
    assert.equal(api.state().failure, null);

    const rights = api.rights();
    assert.ok(rights.some((r) => r.id === "messages.send.shout" && r.group === "send" && r.format === "shout"));
    assert.ok(rights.some((r) => r.id === "ping.read" && r.group === "ping"));
    assert.equal(rights.filter((r) => r.group === "send").length, 14);

    const catalog = api.catalog();
    assert.ok(catalog.formats.some((f) => f.name === "shout" && f.right === "messages.send.shout"));
    assert.ok(catalog.endpoints.some((e) => e.id === "ping.get" && e.method === "GET" && e.path === "/api/v1/ping"));
    assert.deepEqual(catalog.rights.map((r) => r.id), rights.map((r) => r.id));

    const doc2 = api.openapi();
    assert.ok(doc2.paths["/ping"].get);
    assert.deepEqual(doc2.paths["/ping"].get["x-required-rights"], ["ping.read"]);
    assert.ok(doc2.components.schemas.MessagesCreateShout);
    assert.equal(doc2.paths["/messages"].post.requestBody.content["application/json"].schema.oneOf.length, 14);
    assert.ok(doc2.paths["/messages"].post.requestBody.content["application/json"].examples.shout);
    assert.ok(doc2.paths["/messages"].post["x-required-rights"].includes("messages.send.shout"));
    assert.ok(doc2.components.schemas.Right.enum.includes("ping.read"));
  });

  test("end to end: the new format is validated, sent and listed, and the new endpoint is served, by the same stack", async () => {
    const registry = formats.createRegistry({ dir: formatsWith() });
    registry.load();
    const harness = await createApiHarness({ endpointsDir: endpointsWith(), engineDeps: { formats: registry }, apiDeps: { formats: registry } });
    try {
      const own = await harness.createKey({ name: "demo", rights: "all" });
      assert.ok(own.row.rights.includes("messages.send.shout") && own.row.rights.includes("ping.read"));
      const ping = await harness.get("/api/v1/ping", own);
      assert.deepEqual(ping.json, { pong: true });
      const other = await harness.createKey({ name: "no ping", rights: harness.allRights().filter((r) => r !== "ping.read") });
      assert.equal((await harness.get("/api/v1/ping", other)).status, 403);
      assert.equal((await harness.get("/api/v1/ping")).status, 401);

      const bad = await harness.send(own, { format: "shout", to: "237690000001" });
      assert.deepEqual(bad.json.error.fields, { note: { code: "required" } });
      const res = await harness.send(own, { format: "shout", to: "237690000001", note: "hello" });
      assert.equal(res.status, 202, res.text);
      assert.equal(res.json.message.format, "shout");
      assert.equal(res.json.message.size, 5);
      await harness.tick(2 * SEC);
      assert.equal((await harness.row(res.json.message.id)).status, "sent");
      assert.equal(harness.sock.sent[harness.sock.sent.length - 1].content.text, "HELLO");
      const noRight = await harness.createKey({ name: "no shout", rights: harness.allRights().filter((r) => r !== "messages.send.shout") });
      assert.deepEqual((await harness.send(noRight, { format: "shout", to: "237690000001", note: "x" })).json.error.params, { right: "messages.send.shout" });
      // `api.openapi()` is what the panel's download serves: the registry that is running
      assert.ok(harness.api.openapi().paths["/ping"]);
      assert.ok(harness.api.openapi().components.schemas.MessagesCreateShout);
    } finally {
      await harness.close();
    }
  });

  test("an endpoint without a right keeps the whole API unserved; the bot keeps running", async () => {
    const dir = endpointsWith({ "zbad.js": '"use strict";\nmodule.exports = { id: "bad.get", method: "GET", path: "/api/v1/bad", doc: { summary: "x" }, handle() {} };\n' });
    const api = createApi({ config: {}, endpointsDir: dir, apiState: { isEnabled: () => true, plainHttpFrom: () => [] }, runtime: { dbReady: true } });
    assert.equal(api.state().loaded, false);
    assert.equal(api.state().failure.code, "registry_failed");
    assert.equal(api.state().failure.endpoint, "bad.get");
    assert.deepEqual(api.routes(), []);
    assert.deepEqual(api.rights(), []);
    assert.deepEqual(api.catalog().endpoints, []);
    const untouched = { url: "/api/v1/messages", method: "GET" };
    assert.equal(api.handle(new Proxy(untouched, { get: (t, n) => (n in t ? t[n] : assert.fail(`req.${String(n)}`)) }), new Proxy({}, { get: (_, n) => assert.fail(`res.${String(n)}`) })), false);

    const harness = await createApiHarness({ endpointsDir: dir });
    try {
      assert.equal(harness.api.state().failure.endpoint, "bad.get");
      // `api.rights()` is empty under a failed registry: the send right is given by hand (the engine re-reads it at the pick, L7)
      const own = await harness.createKey({ name: "survivor", rights: ["messages.send.text"] });
      const row = await harness.messaging.submit(harness.engine.request({ apiKeyId: own.id }));
      await harness.tick(2 * SEC);
      assert.equal((await harness.row(row.message.publicId)).status, "sent", "the engine keeps working");
    } finally {
      await harness.close();
    }
  });
});
