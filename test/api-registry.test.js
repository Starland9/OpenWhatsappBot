"use strict";
/**
 * Endpoint registry and router of the messaging API (feature 004, contracts/runtime.md sections 15.3-15.5):
 * every ApiRegistryError names the endpoint (deny by default: no endpoint without a declared right), a registry
 * failure serves nothing and the bot keeps running (RT-131, FR-090), the rights catalogue, the router (exact match,
 * ambiguity at build, Allow) and the mapping of a dynamic `requires()` outside `rights()`.
 */

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadEndpoints, rightsOf, ApiRegistryError } = require("../lib/api/registry");
const { createApiRouter } = require("../lib/api/router");

const ID = /^msg_[A-Za-z0-9_-]{22}$/;
const fakeFormats = {
  rights: () => ["messages.send.text", "messages.send.image"],
  list: () => [{ name: "text" }, { name: "image" }],
  load() {},
  get: (name) => (["text", "image"].includes(name) ? { name } : null),
};

/** Source text of an endpoint module; a value of null drops the key, a string is inserted verbatim as code */
function source(overrides = {}) {
  const base = {
    id: '"demo.get"',
    method: '"GET"',
    path: '"/api/v1/demo"',
    right: '"demo.read"',
    doc: '{ summary: "Demo" }',
    handle: "async () => ({ status: 200, body: {} })",
  };
  const merged = { ...base, ...overrides };
  const lines = Object.entries(merged)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `  ${key}: ${value},`);
  return `"use strict";\nmodule.exports = {\n${lines.join("\n")}\n};\n`;
}

let root;
let seq = 0;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-api-registry-"));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** A fresh directory holding the given files ({ name: source }) */
function dirWith(files) {
  const dir = path.join(root, `d${++seq}`);
  fs.mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

function rejects(files, match) {
  try {
    loadEndpoints({ dir: dirWith(files), formats: fakeFormats });
  } catch (err) {
    assert.ok(err instanceof ApiRegistryError, `expected an ApiRegistryError, got ${err && err.name}: ${err && err.message}`);
    assert.match(err.reason, match, err.reason);
    assert.ok(err.endpoint && err.message.includes(err.endpoint), "the message names the endpoint");
    assert.ok(err.file);
    return err;
  }
  assert.fail("the registry should have refused the endpoint");
}

describe("loadEndpoints: a valid directory", () => {
  test("loads modules in sorted order and returns endpoints, rights, byRoute and the router", () => {
    const dir = dirWith({
      "b.js": source({ id: '"demo.b"', path: '"/api/v1/b"' }),
      "a.js": source({ id: '"demo.a"', path: '"/api/v1/a"', right: '"demo.write"' }),
    });
    const registry = loadEndpoints({ dir, formats: fakeFormats });
    assert.deepEqual(registry.endpoints.map((e) => e.id), ["demo.a", "demo.b"]);
    assert.ok(registry.byRoute.get("GET /api/v1/a"));
    assert.deepEqual(registry.rights.map((r) => r.id), ["demo.read", "demo.write"]);
    assert.equal(typeof registry.router.match, "function");
  });

  test("a missing directory is an empty registry", () => {
    const registry = loadEndpoints({ dir: path.join(root, "nope"), formats: fakeFormats });
    assert.deepEqual(registry.endpoints, []);
    assert.deepEqual(registry.rights, []);
  });

  test("non-js files are ignored", () => {
    const dir = dirWith({ "a.js": source(), "notes.txt": "x", "b.json": "{}" });
    assert.equal(loadEndpoints({ dir, formats: fakeFormats }).endpoints.length, 1);
  });
});

describe("loadEndpoints: every violation names the endpoint (deny by default)", () => {
  test("neither right nor rights + requires: no public level exists", () => {
    const err = rejects({ "x.js": source({ right: null }) }, /no right declared/);
    assert.equal(err.endpoint, "demo.get");
  });

  test("a malformed static right", () => {
    for (const right of ['"Messages.Read"', '"messages..read"', '""', '"a b"', "42", `"${"a".repeat(65)}"`]) {
      rejects({ "x.js": source({ right }) }, /malformed right id/);
    }
  });

  test("both static and dynamic declarations", () => {
    rejects({ "x.js": source({ rights: "() => ['a.b']", requires: "() => ['a.b']" }) }, /both a static right and a dynamic/);
  });

  test("a dynamic declaration needs both functions and a non-empty list", () => {
    rejects({ "x.js": source({ right: null, rights: "() => ['a.b']" }) }, /must both be functions/);
    rejects({ "x.js": source({ right: null, requires: "() => []" }) }, /must both be functions/);
    rejects({ "x.js": source({ right: null, rights: "() => []", requires: "() => []" }) }, /non-empty array/);
    rejects({ "x.js": source({ right: null, rights: "() => ['a.b', 'a.b']", requires: "() => []" }) }, /duplicate right id/);
  });

  test("a duplicate id", () => {
    rejects({ "a.js": source({ path: '"/api/v1/a"' }), "b.js": source({ path: '"/api/v1/b"' }) }, /duplicate id/);
  });

  test("a duplicate method and path", () => {
    rejects({ "a.js": source({ id: '"demo.a"' }), "b.js": source({ id: '"demo.b"' }) }, /duplicate method and path/);
  });

  test("a path outside /api/v<n>/ or malformed", () => {
    for (const p of ['"/api/info"', '"/admin/api/x"', '"/api/v1"', '"/api/v1/"', '"/api/v1/a/"', '"/api/v1//a"', '"/v1/a"', '"/api/x/a"']) {
      rejects({ "x.js": source({ path: p }) }, /path outside/);
    }
  });

  test("a :param without a pattern, a pattern for a missing param, a stateful pattern", () => {
    rejects({ "x.js": source({ path: '"/api/v1/items/:id"' }) }, /has no pattern/);
    rejects({ "x.js": source({ params: "{ id: /^a$/ }" }) }, /no such parameter/);
    rejects({ "x.js": source({ path: '"/api/v1/items/:id"', params: "{ id: /^a$/g }" }) }, /global or sticky/);
  });

  test("GET with a body kind other than none", () => {
    rejects({ "x.js": source({ body: '{ kinds: ["json"], schema: {} }' }) }, /GET with a body kind other than none/);
  });

  test("body.limit above 1 MiB", () => {
    rejects({ "x.js": source({ method: '"POST"', body: '{ kinds: ["json"], limit: 1048577, schema: {} }' }) }, /above 1 MiB/);
  });

  test("multipart without file", () => {
    rejects({ "x.js": source({ method: '"POST"', body: '{ kinds: ["json", "multipart"], schema: {} }' }) }, /multipart without a file/);
  });

  test("an invalid schema, query or variants", () => {
    rejects({ "x.js": source({ method: '"POST"', body: '{ kinds: ["json"], schema: { a: { type: "bogus" } } }' }) }, /invalid body schema/);
    rejects({ "x.js": source({ method: '"POST"', body: '{ kinds: ["json"] }' }) }, /neither schema nor variants/);
    rejects({ "x.js": source({ query: '{ a: { type: "array" } }' }) }, /only string, int and boolean/);
    rejects({ "x.js": source({ query: '{ a: { type: "nope" } }' }) }, /invalid query schema/);
    rejects({ "x.js": source({ method: '"POST"', body: '{ kinds: ["json"], variants: { by: "format", schemas: () => ({ text: { a: { type: "x" } } }) } }' }) }, /invalid variant schema/);
  });

  test("doc.summary missing, handle not a function", () => {
    rejects({ "x.js": source({ doc: "{}" }) }, /doc\.summary is missing/);
    rejects({ "x.js": source({ doc: "null" }) }, /doc\.summary is missing/);
    rejects({ "x.js": source({ handle: '"nope"' }) }, /handle is not a function/);
  });

  test("an invalid id or method", () => {
    rejects({ "x.js": source({ id: '"Demo.get"' }) }, /invalid id/);
    rejects({ "x.js": source({ id: '"demo"' }) }, /invalid id/);
    rejects({ "x.js": source({ method: '"OPTIONS"' }) }, /invalid method/);
  });

  test("a module that does not load is reported by file name, without its message", () => {
    const err = rejects({ "broken.js": "module.exports = {;" }, /failed to load/);
    assert.equal(err.endpoint, "broken.js");
    assert.ok(!err.message.includes("Unexpected"));
  });

  test("two paths that could match the same URL", () => {
    const files = {
      "a.js": source({ id: '"demo.a"', path: '"/api/v1/items/:id"', params: "{ id: /^a$/ }" }),
      "b.js": source({ id: '"demo.b"', path: '"/api/v1/items/list"' }),
    };
    rejects(files, /ambiguous with demo\.a/);
  });
});

describe("rights catalogue", () => {
  test("groups: send (formats' order), read, media, docs, then others alphabetically", () => {
    const dir = dirWith({
      "send.js": source({
        id: '"messages.create"',
        method: '"POST"',
        path: '"/api/v1/messages"',
        right: null,
        rights: '({ formats }) => [...formats.rights(), "media.url"]',
        requires: "(peek) => ['messages.send.text']",
        body: '{ kinds: ["json"], schema: {} }',
      }),
      "get.js": source({ id: '"messages.get"', path: '"/api/v1/messages/:id"', right: '"messages.read"', params: `{ id: ${ID} }` }),
      "docs.js": source({ id: '"openapi.get"', path: '"/api/v1/openapi.json"', right: '"api.docs"' }),
      "z.js": source({ id: '"zed.get"', path: '"/api/v1/zed"', right: '"zed.read"' }),
      "k.js": source({ id: '"keys.get"', path: '"/api/v1/keys"', right: '"keys.list"' }),
    });
    const registry = loadEndpoints({ dir, formats: fakeFormats });
    assert.deepEqual(registry.rights, [
      { id: "messages.send.text", group: "send", format: "text" },
      { id: "messages.send.image", group: "send", format: "image" },
      { id: "messages.read", group: "read", format: null },
      { id: "media.url", group: "media", format: null },
      { id: "api.docs", group: "docs", format: null },
      { id: "keys.list", group: "keys", format: null },
      { id: "zed.read", group: "zed", format: null },
    ]);
  });

  test("rightsOf: a static endpoint lists its right, a dynamic one expands through formats", () => {
    assert.deepEqual(rightsOf({ right: "a.b" }), ["a.b"]);
    assert.deepEqual(rightsOf({ rights: ({ formats }) => formats.rights() }, { formats: fakeFormats }), ["messages.send.text", "messages.send.image"]);
  });
});

describe("router", () => {
  const ep = (id, method, p, params) => ({ id, method, path: p, params: params || {} });

  test("exact match on the raw pathname, with a pattern per parameter", () => {
    const router = createApiRouter({
      endpoints: [ep("messages.create", "POST", "/api/v1/messages"), ep("messages.list", "GET", "/api/v1/messages"), ep("messages.get", "GET", "/api/v1/messages/:id", { id: ID })],
    });
    const good = "msg_Vx3k9QfL2mNvB7aRtYhZwc";
    assert.equal(router.match("GET", "/api/v1/messages").endpoint.id, "messages.list");
    assert.equal(router.match("POST", "/api/v1/messages").endpoint.id, "messages.create");
    const hit = router.match("GET", `/api/v1/messages/${good}`);
    assert.equal(hit.endpoint.id, "messages.get");
    assert.deepEqual(hit.params, { id: good });
    for (const miss of ["/api/v1/messages/", "/api/v1//messages", "/api/V1/messages", "/api/v1/Messages", "/api/v1/messages/short", `/api/v1/messages/${good}/`, `/api/v1/messages/${good}x`, "/api/v1/message", "api/v1/messages", ""]) {
      assert.equal(router.match("GET", miss), null, miss);
    }
  });

  test("a path that exists for other verbs gives the sorted Allow list", () => {
    const router = createApiRouter({ endpoints: [ep("a.b", "POST", "/api/v1/x"), ep("a.c", "GET", "/api/v1/x")] });
    assert.deepEqual(router.match("DELETE", "/api/v1/x"), { allow: ["GET", "POST"] });
    assert.deepEqual(router.match("PUT", "/api/v1/x"), { allow: ["GET", "POST"] });
    assert.equal(router.match("GET", "/api/v1/y"), null);
  });

  test("the pathname is never decoded", () => {
    const router = createApiRouter({ endpoints: [ep("a.b", "GET", "/api/v1/x")] });
    assert.equal(router.match("GET", "/api/v1/%78"), null);
    assert.equal(router.match("GET", "/api/v1/x%2f"), null);
  });

  test("the table lists id, method and path", () => {
    const router = createApiRouter({ endpoints: [ep("a.b", "GET", "/api/v1/x")] });
    assert.deepEqual(router.table(), [{ id: "a.b", method: "GET", path: "/api/v1/x" }]);
  });

  test("two parametrised paths of the same shape are ambiguous, different verbs or lengths are not", () => {
    assert.throws(() => createApiRouter({ endpoints: [ep("a.b", "GET", "/api/v1/x/:id", { id: /^a$/ }), ep("a.c", "GET", "/api/v1/x/:name", { name: /^b$/ })] }), /ambiguous/);
    assert.throws(() => createApiRouter({ endpoints: [ep("a.b", "GET", "/api/v1/x/:id", { id: /^a$/ }), ep("a.c", "GET", "/api/v1/x/y")] }), /ambiguous/);
    assert.doesNotThrow(() => createApiRouter({ endpoints: [ep("a.b", "GET", "/api/v1/x/:id", { id: /^a$/ }), ep("a.c", "POST", "/api/v1/x/:id", { id: /^a$/ }), ep("a.d", "GET", "/api/v1/x")] }));
  });
});

describe("createApi: a registry failure serves nothing and the bot keeps running (RT-131, FR-090)", () => {
  const { createApi } = require("../lib/api");

  function api(files, extra = {}) {
    return createApi({
      endpointsDir: dirWith(files),
      formats: fakeFormats,
      config: { ADMIN_PANEL: true },
      apiState: { isEnabled: () => true, plainHttpFrom: () => [] },
      ...extra,
    });
  }

  test("a broken endpoint sets state().failure naming it; handle() claims nothing and catalog() is empty", () => {
    const a = api({ "good.js": source({ id: '"good.get"', path: '"/api/v1/good"' }), "bad.js": source({ id: '"bad.get"', path: '"/api/v1/bad"', right: null }) });
    const state = a.state();
    assert.equal(state.loaded, false);
    assert.equal(state.version, "v1");
    assert.equal(state.failure.code, "registry_failed");
    assert.equal(state.failure.endpoint, "bad.get");
    assert.match(state.failure.reason, /no right declared/);
    const req = { url: "/api/v1/good", method: "GET", headers: {}, socket: {} };
    assert.equal(a.handle(req, {}), false, "nothing is served, not even the good endpoint");
    assert.deepEqual(a.catalog().endpoints, []);
    assert.deepEqual(a.catalog().rights, []);
    assert.deepEqual(a.catalog().formats, []);
    assert.deepEqual(a.routes(), []);
    assert.deepEqual(a.rights(), []);
  });

  test("a valid registry reports loaded with no failure; routes() and rights() describe it", () => {
    const a = api({ "get.js": source({ id: '"messages.get"', path: '"/api/v1/messages/:id"', right: '"messages.read"', params: `{ id: ${ID} }` }) });
    assert.deepEqual(a.state(), { loaded: true, failure: null, version: "v1" });
    const [route] = a.routes();
    assert.deepEqual(route, { id: "messages.get", method: "GET", path: "/api/v1/messages/:id", rights: ["messages.read"], dynamic: false, body: { kinds: ["none"], limitBytes: 0 }, idempotent: false });
    assert.deepEqual(a.rights(), [{ id: "messages.read", group: "read", format: null }]);
  });

  test("a broken format registry is a failure too", () => {
    const { FormatRegistryError } = (() => {
      class FormatRegistryError extends Error {
        constructor(file, reason) {
          super(`${file}: ${reason}`);
          this.file = file;
          this.reason = reason;
        }
      }
      return { FormatRegistryError };
    })();
    const broken = { ...fakeFormats, load() { throw new FormatRegistryError("voice.js", "basename differs from name"); } };
    const a = api({ "a.js": source() }, { formats: broken });
    assert.equal(a.state().loaded, false);
    assert.equal(a.state().failure.code, "registry_failed");
    assert.equal(a.state().failure.endpoint, null);
    assert.match(a.state().failure.reason, /voice\.js/);
  });
});

describe("a requires() result outside rights() is never a grant", () => {
  test("rightsOf lets the pipeline compare the two (a 500 is the pipeline's job, covered in api-pipeline)", () => {
    const endpoint = { rights: () => ["messages.send.text"], requires: () => ["messages.send.voice"] };
    const declared = new Set(rightsOf(endpoint));
    assert.ok(!declared.has(endpoint.requires()[0]));
  });
});
