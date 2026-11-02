"use strict";
/**
 * The render-loop guard of the view tests (test/helpers/viewGuard.js, contracts/panel-ui.md section 9): it has to
 * stop a runaway loop at its source. A component with `useEffect(() => setN(n + 1))` trips `renders`, one that
 * re-fetches on every render trips `perRoute`, the total cap trips `requests`, and a quiet component stays clean.
 *
 * Every loop test uses a tiny cap and a fixed number of event-loop turns, never a "wait until it stops" loop.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createDom, importPublic } = require("./helpers/fakeDom");
const { createViewGuard, answer } = require("./helpers/viewGuard");

let dom;
let h;
let hooks;

before(async () => {
  dom = await createDom();
  h = await importPublic("js/components/html.mjs");
  hooks = h;
});

after(() => {
  dom.restore();
  delete globalThis.fetch;
});

describe("the helper", () => {
  test("a runaway setState loop trips renders and the test ends", async () => {
    const guard = createViewGuard({ preact: dom.preact, maxRenders: 12 });
    function Loop() {
      const [n, setN] = hooks.useState(0);
      hooks.useEffect(() => setN(n + 1)); // no deps: every render schedules the next one
      return h.html`<p>${n}</p>`;
    }
    const root = dom.mount(h.html`<${Loop} />`);
    try {
      await dom.settle(40);
      assert.equal(guard.tripped(), "renders");
      assert.ok(guard.renders() > 12 && guard.renders() < 40, `stopped near the cap, not ${guard.renders()}`);
      assert.throws(() => guard.assertClean(), /tripped on "renders".*12 render batch|tripped on "renders"/);
      const frozen = guard.renders();
      await dom.settle(20);
      assert.equal(guard.renders(), frozen, "the loop is frozen for good");
    } finally {
      dom.unmount(root);
      guard.restore();
    }
  });

  test("a component that re-fetches on every render trips perRoute and its request never resolves", async () => {
    const guard = createViewGuard({ preact: dom.preact, maxPerRoute: 5 });
    globalThis.fetch = guard.fetch({ "GET /admin/api/ping": () => answer(200, { ok: true }) });
    function Refetch() {
      const [n, setN] = hooks.useState(0);
      hooks.useEffect(() => {
        fetch("/admin/api/ping").then(() => setN(n + 1));
      }); // no deps: a request per render
      return h.html`<p>${n}</p>`;
    }
    const root = dom.mount(h.html`<${Refetch} />`);
    try {
      await dom.settle(40);
      assert.equal(guard.tripped(), "perRoute");
      assert.equal(guard.count("GET /admin/api/ping"), 6, "the sixth request tripped the cap and was never answered");
      assert.throws(() => guard.assertClean(), /tripped on "perRoute".*GET \/admin\/api\/ping x6/);
      await dom.settle(10);
      assert.equal(guard.count("GET /admin/api/ping"), 6, "nothing follows");
    } finally {
      dom.unmount(root);
      guard.restore();
      delete globalThis.fetch;
    }
  });

  test("the total of requests is capped too, across routes", async () => {
    const guard = createViewGuard({ preact: dom.preact, maxRequests: 4, maxPerRoute: 100 });
    const call = guard.fetch({ "GET /admin/api/a": () => answer(200, {}), "GET /admin/api/b": () => answer(200, {}) });
    try {
      for (const path of ["a", "b", "a", "b"]) assert.equal((await call(`/admin/api/${path}`)).status, 200);
      assert.equal(guard.tripped(), null);
      const fifth = call("/admin/api/a");
      const outcome = await Promise.race([fifth.then(() => "answered"), new Promise((resolve) => setTimeout(() => resolve("pending"), 20))]);
      assert.equal(outcome, "pending", "past the cap the promise never resolves");
      assert.equal(guard.tripped(), "requests");
      assert.equal(guard.requests.length, 4, "at most maxRequests entries are recorded");
      assert.throws(() => guard.assertClean(), /tripped on "requests"/);
    } finally {
      guard.restore();
    }
  });

  test("an unexpected request throws, with its method and path, and is recorded", async () => {
    const guard = createViewGuard({ preact: dom.preact });
    const call = guard.fetch({ "GET /admin/api/known": () => answer(200, {}) });
    try {
      await assert.rejects(() => call("/admin/api/unknown?x=1", { method: "POST", body: JSON.stringify({ a: 1 }) }), /unexpected request POST \/admin\/api\/unknown/);
      assert.deepEqual(guard.requests, [{ key: "POST /admin/api/unknown", search: "x=1", body: { a: 1 } }]);
      assert.equal(guard.tripped(), null, "an unexpected request is a test failure, not a trip");
    } finally {
      guard.restore();
    }
  });

  test("the scripted routes receive the body and the query and their answer is what fetch returns", async () => {
    const guard = createViewGuard({ preact: dom.preact });
    const seen = [];
    const call = guard.fetch({
      "PUT /admin/api/api/state": (body, search) => {
        seen.push({ body, search });
        return answer(200, { enabled: true }, { "X-Request-Id": "abc" });
      },
    });
    try {
      const res = await call("/admin/api/api/state?q=1", { method: "PUT", body: JSON.stringify({ enabled: true }) });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-request-id"), "abc");
      assert.deepEqual(JSON.parse(await res.text()), { enabled: true });
      assert.deepEqual(seen, [{ body: { enabled: true }, search: "q=1" }]);
      assert.equal(guard.count("PUT /admin/api/api/state"), 1);
    } finally {
      guard.restore();
    }
  });

  test("a quiet component stays clean, and restore gives the Preact option back", async () => {
    const before = dom.preact.options.debounceRendering;
    const guard = createViewGuard({ preact: dom.preact });
    assert.notEqual(dom.preact.options.debounceRendering, before, "the guard wraps the option");
    globalThis.fetch = guard.fetch({ "GET /admin/api/once": () => answer(200, { n: 1 }) });
    function Quiet() {
      const [data, setData] = hooks.useState(null);
      hooks.useEffect(() => {
        fetch("/admin/api/once").then((res) => res.text()).then((text) => setData(JSON.parse(text)));
      }, []);
      return h.html`<p>${data ? `n=${data.n}` : "loading"}</p>`;
    }
    const root = dom.mount(h.html`<${Quiet} />`);
    try {
      await dom.settle(6);
      assert.equal(dom.text(root), "n=1");
      assert.equal(guard.tripped(), null);
      assert.equal(guard.count("GET /admin/api/once"), 1);
      assert.ok(guard.renders() >= 1 && guard.renders() < 5);
      guard.assertClean();
    } finally {
      dom.unmount(root);
      guard.restore();
      delete globalThis.fetch;
    }
    assert.equal(dom.preact.options.debounceRendering, before);
    guard.restore(); // idempotent
    assert.equal(dom.preact.options.debounceRendering, before);
  });

  test("rendering still works after a tripped test once the option is back (the frozen batch is dropped)", async () => {
    const guard = createViewGuard({ preact: dom.preact, maxRenders: 5 });
    function Loop() {
      const [n, setN] = hooks.useState(0);
      hooks.useEffect(() => setN(n + 1));
      return h.html`<p>${n}</p>`;
    }
    const loop = dom.mount(h.html`<${Loop} />`);
    await dom.settle(20);
    assert.equal(guard.tripped(), "renders");
    dom.unmount(loop);
    guard.restore();

    const next = createViewGuard({ preact: dom.preact });
    function Counter() {
      const [n, setN] = hooks.useState(0);
      return h.html`<button onClick=${() => setN(n + 1)}>count ${n}</button>`;
    }
    const root = dom.mount(h.html`<${Counter} />`);
    try {
      dom.click(dom.byText(root, "count 0", "button")[0]);
      await dom.settle(4);
      assert.equal(dom.text(root), "count 1", "a later test renders normally");
      next.assertClean();
    } finally {
      dom.unmount(root);
      next.restore();
    }
  });
});
