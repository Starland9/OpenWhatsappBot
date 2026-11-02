"use strict";
/**
 * The History, Detail and Usage parts of the API area, and the bounded status poller (feature 004,
 * contracts/panel-ui.md 7.7 to 7.9, task T090). Fake DOM, fakeClock for the poller, render guards of viewGuard.js.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { boot, makeCatalog, makeState, makeKey, ok, fail } = require("./helpers/apiViewKit");
const { createClock } = require("./helpers/fakeClock");

let kit;
let dom;
let i18n;
let ui;
let watch;
const T = (key, params) => i18n.t(key, params);

before(async () => {
  kit = await boot();
  ({ dom, i18n, ui } = kit);
  watch = await require("./helpers/fakeDom").importPublic("js/views/api-watch.mjs");
});
beforeEach(() => ui.toastStore.set({ items: [] }));
after(() => {
  dom.restore();
  i18n.__resetForTests();
  delete globalThis.fetch;
  delete globalThis.location;
});

const route = (query = {}, rest = []) => ({ name: "api", rest, query });
const freshData = (over = {}) => ({ state: makeState(), catalog: makeCatalog(), keys: [makeKey(1, { name: "n8n" }), makeKey(2, { name: "mailer" })], ...over });
const search = (request) => Object.fromEntries(new URLSearchParams(request.search));

const row = (id, over = {}) => ({
  id, source: "api", key: { id: 1, name: "n8n" }, to: "237690000001@s.whatsapp.net", toName: "Ada", kind: "private", format: "text", size: null,
  status: "delivered", failureCode: null, acceptedAt: "2026-11-02T09:00:00.000Z", ...over,
});
const page = (items, over = {}) => ({ items, page: 1, pageSize: 25, total: items.length, ...over });

// ===========================================================================
// History
// ===========================================================================

describe("HistoryTab", () => {
  const historyRoute = (query = {}) => route({ tab: "history", ...query });

  test("the first request is the exact API-9 query; the columns hold no message content; the cells follow the contract", async () => {
    const items = [
      row(1),
      row(2, { source: "panel", key: null, kind: "group", to: "120363000000000001@g.us", toName: "Team", format: "image", size: 2048, status: "sent" }),
      row(3, { status: "failed", failureCode: "not_on_whatsapp", key: { id: 9, name: null } }),
      row(4, { status: "read", format: "mystery" }),
    ];
    const t = kit.mountApi({ data: freshData(), route: historyRoute(), routes: { "GET /admin/api/api/messages": () => ok(page(items)) } });
    try {
      await t.settle(6);
      assert.equal(t.guard.count("GET /admin/api/api/messages"), 1);
      assert.deepEqual(search(t.guard.requests.find((r) => r.key === "GET /admin/api/api/messages")), { page: "1", pageSize: "25" });
      const headers = dom.find(t.root, (el) => el.localName === "th").map((el) => dom.text(el));
      assert.deepEqual(headers, ["col_when", "col_source", "col_recipient", "col_format", "col_size", "col_status", "col_failure", "col_open"].map((k) => T(`api.${k}`)));
      assert.ok(t.find.has(T("api.history_no_content", { days: 30 })));
      const cells = (n) => dom.text(dom.find(t.root, (el) => el.localName === "tr" && dom.text(el).includes(n))[0]);
      assert.ok(cells("Ada").includes("n8n") && cells("Ada").includes("+237690000001") && cells("Ada").includes(T("api.msg_status.delivered")));
      const group = cells("Team");
      assert.ok(group.includes(T("api.source_panel")) && group.includes(T("api.kind_group")) && group.includes("120363000000000001@g.us"));
      assert.ok(group.includes(T("api.status_group_note")) && group.includes(i18n.formatBytes(2048)));
      assert.ok(cells(T("api.failure.not_on_whatsapp")).includes("not_on_whatsapp") && cells(T("api.failure.not_on_whatsapp")).includes(T("api.source_key_gone")));
      assert.ok(cells("mystery").includes("mystery"), "an unknown format is shown raw");
      const open = dom.find(t.root, (el) => el.localName === "a" && el.getAttribute("href") === "#/api/history/3");
      assert.equal(open.length, 1);
    } finally {
      t.done();
    }
  });

  test("filters preset from route.query; Apply sends the exact query with local-day bounds; an end before the start is refused", async () => {
    const t = kit.mountApi({ data: freshData(), route: historyRoute({ key: "panel", status: "failed", format: "text", from: "2026-03-05", to: "2026-03-06", bogus: "x" }), routes: { "GET /admin/api/api/messages": () => ok(page([row(1)])) } });
    try {
      await t.settle(6);
      const first = search(t.guard.requests.find((r) => r.key === "GET /admin/api/api/messages"));
      assert.deepEqual(first, { key: "panel", status: "failed", format: "text", from: new Date(2026, 2, 5, 0, 0, 0, 0).toISOString(), to: new Date(2026, 2, 6, 23, 59, 59, 999).toISOString(), page: "1", pageSize: "25" });
      // an end before the start is refused and sends nothing
      await dom.settle(1);
      dom.type(dom.byAttr(t.root, "id", "api-filter-to", "input")[0], "2026-03-01");
      await dom.settle(2);
      dom.fire(dom.find(t.root, (el) => el.localName === "form")[0], "submit");
      await t.settle(3);
      assert.equal(t.guard.count("GET /admin/api/api/messages"), 1);
      assert.ok(t.find.has(T("api.filter_end_before_start")));
      // a coherent range applies and goes back to page 1
      dom.type(dom.byAttr(t.root, "id", "api-filter-to", "input")[0], "2026-03-07");
      await dom.settle(2);
      dom.fire(dom.find(t.root, (el) => el.localName === "form")[0], "submit");
      await t.settle(4);
      assert.equal(t.guard.count("GET /admin/api/api/messages"), 2);
      assert.equal(search(t.guard.requests.filter((r) => r.key === "GET /admin/api/api/messages")[1]).to, new Date(2026, 2, 7, 23, 59, 59, 999).toISOString());
      // Reset clears every filter
      dom.click(t.find.button(T("api.filter_reset")));
      await t.settle(4);
      assert.deepEqual(search(t.guard.requests.filter((r) => r.key === "GET /admin/api/api/messages")[2]), { page: "1", pageSize: "25" });
    } finally {
      t.done();
    }
  });

  test("an invalid day in the link is dropped; pagination asks the next page; the key and status selects feed the query", async () => {
    const items = Array.from({ length: 25 }, (_, i) => row(i + 1));
    const t = kit.mountApi({ data: freshData(), route: historyRoute({ from: "2026-02-30", status: "weird" }), routes: { "GET /admin/api/api/messages": () => ok(page(items, { total: 60 })) } });
    try {
      await t.settle(6);
      assert.deepEqual(search(t.guard.requests.find((r) => r.key === "GET /admin/api/api/messages")), { page: "1", pageSize: "25" });
      dom.click(t.find.button(T("common.next")));
      await t.settle(4);
      assert.equal(search(t.guard.requests.filter((r) => r.key === "GET /admin/api/api/messages")[1]).page, "2");
      const keySelect = dom.byAttr(t.root, "name", "api-filter-key", "select")[0];
      dom.choose(keySelect, "2");
      dom.choose(dom.byAttr(t.root, "name", "api-filter-status", "select")[0], "failed");
      await dom.settle(2);
      dom.fire(dom.find(t.root, (el) => el.localName === "form")[0], "submit");
      await t.settle(4);
      const last = search(t.guard.requests.filter((r) => r.key === "GET /admin/api/api/messages").pop());
      assert.equal(last.key, "2");
      assert.equal(last.status, "failed");
      assert.equal(last.page, "1");
    } finally {
      t.done();
    }
  });

  test("the empty state, the error with Retry, and no auto-refresh: a long wait sends no request", async () => {
    const data = freshData();
    let broken = true;
    const t = kit.mountApi({ data, route: historyRoute(), routes: { "GET /admin/api/api/messages": () => (broken ? fail(500, "internal_error") : ok(page([]))) } });
    const clock = createClock();
    try {
      await t.settle(6);
      assert.ok(t.find.has(T("common.view_error")));
      broken = false;
      dom.click(dom.byText(t.root, T("common.retry"), "button").pop());
      await t.settle(4);
      assert.ok(t.find.has(T("api.history_empty")));
      const before = t.guard.count("GET /admin/api/api/messages");
      await clock.advance(10 * 60 * 1000);
      await t.settle(8);
      assert.equal(t.guard.count("GET /admin/api/api/messages"), before, "nothing polls the history");
      assert.equal(clock.pending(), 0);
    } finally {
      clock.restore();
      t.done();
    }
  });
});

// ===========================================================================
// Detail
// ===========================================================================

describe("MessageDetail", () => {
  const detail = (over = {}) => ({
    ...row(12), publicId: "msg_AAAAAAAAAAAAAAAAAAAAAA", waId: "3EB0ABC", expiresAt: "2026-11-02T09:10:00.000Z", interactive: false, responses: null,
    steps: [{ status: "queued", at: "2026-11-02T09:00:00.000Z" }, { status: "sending", at: "2026-11-02T09:00:03.000Z" }, { status: "sent", at: "2026-11-02T09:00:04.000Z" }, { status: "read", at: "2026-11-02T09:00:30.000Z" }],
    ...over, status: over.status || "read",
  });
  const open = (message, extra = {}) => kit.mountApi({ data: freshData(), route: route({}, ["history", String(message.id)]), routes: { [`GET /admin/api/api/messages/${message.id}`]: () => ok({ message }), ...extra } });

  test("facts, the timeline and the settled status: one request, no polling timer left", async () => {
    const message = detail();
    const t = open(message);
    try {
      await t.settle(6);
      assert.equal(t.guard.count("GET /admin/api/api/messages/12"), 1);
      const text = dom.text(t.root);
      for (const expected of [T("api.detail_title", { id: 12 }), "msg_AAAAAAAAAAAAAAAAAAAAAA", "3EB0ABC", "+237690000001", "n8n", T("api.timeline_title")]) assert.ok(text.includes(expected), expected);
      const steps = dom.find(t.root, (el) => el.localName === "li" && ["queued", "sending", "sent", "read"].some((s) => dom.text(el).includes(T(`api.msg_status.${s}`))));
      assert.equal(steps.length, 4);
      assert.ok(t.find.has(T("api.watch_stopped")), "a settled message is not followed");
      assert.ok(!t.find.has(T("api.responses_title")), "a non-interactive message has no replies card");
    } finally {
      t.done();
    }
  });

  test("buttons and lists: a table of replies; an empty window says so; the failure shows text and raw code", async () => {
    const message = detail({
      format: "buttons", interactive: true, status: "failed", failureCode: "send_failed",
      responses: { until: "2026-11-09T09:00:00.000Z", total: 1, items: [{ at: "2026-11-02T09:01:00.000Z", author: "237690000009", kind: "choice", via: "tap", choices: [{ id: "confirm", label: "Yes" }] }], totals: null },
    });
    const t = open(message);
    try {
      await t.settle(6);
      const text = dom.text(t.root);
      assert.ok(text.includes(T("api.responses_title")) && text.includes("+237690000009") && text.includes("confirm") && text.includes("Yes"));
      assert.ok(text.includes(T("api.responses_window", { days: 7 })));
      assert.ok(text.includes(T("api.failure.send_failed")) && text.includes("send_failed"));
    } finally {
      t.done();
    }
    const empty = open(detail({ format: "list", interactive: true, responses: { until: "2026-11-09T09:00:00.000Z", total: 0, items: [], totals: null } }));
    try {
      await empty.settle(6);
      assert.ok(empty.find.has(T("api.responses_empty")));
    } finally {
      empty.done();
    }
  });

  test("a poll: totals as bars, a null label is Option n, one row per voter and a cleared vote shows a dash", async () => {
    const message = detail({
      format: "poll", interactive: true,
      responses: {
        until: "2026-11-09T09:00:00.000Z", total: 2,
        items: [
          { at: "2026-11-02T09:01:00.000Z", author: "237690000009", kind: "vote", via: null, choices: [{ id: "0", label: "Red" }] },
          { at: "2026-11-02T09:02:00.000Z", author: "123456789@lid", kind: "vote", via: null, choices: [] },
        ],
        totals: [{ id: "0", label: "Red", count: 3 }, { id: "1", label: null, count: 1 }],
      },
    });
    const t = open(message);
    try {
      await t.settle(6);
      const bars = dom.find(t.root, (el) => el.localName === "progress");
      assert.deepEqual(bars.map((bar) => Number(bar.getAttribute("value") ?? bar.value)), [1, 1 / 3]);
      assert.ok(t.find.has(T("api.responses_option", { n: 2 })), "a null label reads Option 2");
      assert.ok(t.find.has("@123456789"));
      const cleared = dom.find(t.root, (el) => el.localName === "tr" && dom.text(el).includes("@123456789"))[0];
      assert.ok(dom.text(cleared).endsWith("-"), "a cleared vote shows a dash");
    } finally {
      t.done();
    }
  });

  test("a 404 says the message is gone, with a way back", async () => {
    const t = kit.mountApi({ data: freshData(), route: route({}, ["history", "99"]), routes: { "GET /admin/api/api/messages/99": () => fail(404, "not_found", { params: { resource: "message" } }) } });
    try {
      await t.settle(6);
      assert.ok(t.find.has(T("api.detail_not_found")));
      assert.ok(dom.find(t.root, (el) => el.localName === "a" && el.getAttribute("href") === "#/api?tab=history").length >= 1);
      assert.equal(t.guard.count("GET /admin/api/api/messages/99"), 1, "a 404 stops the chain");
    } finally {
      t.done();
    }
    const bad = kit.mountApi({ data: freshData(), route: route({}, ["history", "abc"]) });
    try {
      await bad.settle(6);
      assert.ok(bad.find.has(T("api.detail_not_found")), "a non-numeric id never reaches the server");
    } finally {
      bad.done();
    }
  });
});

// ===========================================================================
// useMessage, the bounded poller
// ===========================================================================

describe("useMessage", () => {
  /** A probe component that exposes the hook's result; the fake clock drives its timers. */
  function probe({ id = "5", initial = null, routes, delays, options }) {
    const clock = createClock();
    const timers = {
      setTimeout: (fn, ms) => {
        delays.push(ms);
        return clock.timers.setTimeout(fn, ms);
      },
      clearTimeout: (handle) => clock.timers.clearTimeout(handle),
    };
    const sink = { current: null };
    function Probe() {
      const result = watch.useMessage({ id, initial, timers });
      sink.current = result;
      return kit.html`<span>${result.message ? result.message.status : "-"}</span>`;
    }
    const t = kit.mount(kit.html`<${Probe} />`, routes, options);
    return { t, clock, sink };
  }
  const msg = (status, over = {}) => ({ message: { ...row(5), status, steps: [], interactive: false, responses: null, publicId: "msg_x", waId: null, expiresAt: "2026-11-02T09:10:00.000Z", ...over } });
  const tick = async (clock, ms) => {
    await clock.advance(ms);
    await dom.settle(3);
  };

  test("the first load is at once; 2 s for the first polls, then 10 s, and it stops at 60 polls", async () => {
    const delays = [];
    const { t, clock, sink } = probe({ delays, options: { maxPerRoute: 70 }, routes: { "GET /admin/api/api/messages/5": () => ok(msg("queued")) } });
    try {
      await dom.settle(4);
      assert.equal(t.guard.count("GET /admin/api/api/messages/5"), 1, "no waiting for the first answer");
      assert.equal(sink.current.message.status, "queued");
      for (let i = 0; i < 80 && delays.length && sink.current.polling; i += 1) await tick(clock, delays[delays.length - 1]);
      assert.equal(t.guard.count("GET /admin/api/api/messages/5"), 60, "60 polls at most");
      assert.equal(sink.current.polling, false);
      assert.equal(clock.pending(), 0);
      assert.deepEqual(delays.slice(0, 14), Array(14).fill(2000));
      assert.ok(delays.slice(14).every((ms) => ms === 10000));
      assert.equal(delays.length, 59);
    } finally {
      t.done();
      clock.restore();
    }
  });

  test("with an initial message the first poll waits 2 s; `sent` on a private chat goes on, `read` settles", async () => {
    const delays = [];
    const answers = [msg("queued"), msg("sent"), msg("read")];
    const { t, clock, sink } = probe({ initial: msg("queued").message, delays, routes: { "GET /admin/api/api/messages/5": () => ok(answers.shift()) } });
    try {
      await dom.settle(3);
      assert.equal(t.guard.count("GET /admin/api/api/messages/5"), 0);
      assert.deepEqual(delays, [2000]);
      await tick(clock, 2000);
      assert.equal(sink.current.message.status, "queued");
      await tick(clock, 2000);
      assert.equal(sink.current.message.status, "sent");
      assert.equal(sink.current.polling, true, "delivered or read may still follow a private send");
      assert.equal(clock.pending(), 1);
      await tick(clock, 2000);
      assert.equal(sink.current.message.status, "read");
      assert.equal(sink.current.polling, false);
      assert.equal(clock.pending(), 0);
    } finally {
      t.done();
      clock.restore();
    }
  });

  test("a final status, a read and a 404 stop the chain at once", async () => {
    for (const [answer, expectedPolls] of [[() => ok(msg("failed")), 1], [() => ok(msg("read")), 1], [() => fail(404, "not_found"), 1], [() => ok(msg("sent", { kind: "group" })), 1]]) {
      const delays = [];
      const { t, clock, sink } = probe({ delays, routes: { "GET /admin/api/api/messages/5": answer } });
      try {
        await dom.settle(4);
        assert.equal(t.guard.count("GET /admin/api/api/messages/5"), expectedPolls);
        assert.equal(sink.current.polling, false);
        assert.equal(clock.pending(), 0);
        assert.deepEqual(delays, []);
      } finally {
        t.done();
        clock.restore();
      }
    }
  });

  test("three consecutive errors stop the chain; refresh polls now and restarts the counter", async () => {
    const delays = [];
    let broken = true;
    const { t, clock, sink } = probe({ delays, routes: { "GET /admin/api/api/messages/5": () => (broken ? fail(500, "internal_error") : ok(msg("queued"))) } });
    try {
      await dom.settle(4);
      await tick(clock, 2000);
      await tick(clock, 2000);
      assert.equal(t.guard.count("GET /admin/api/api/messages/5"), 3);
      assert.equal(sink.current.polling, false);
      assert.ok(sink.current.error);
      assert.equal(clock.pending(), 0);
      broken = false;
      sink.current.refresh();
      await dom.settle(4);
      assert.equal(t.guard.count("GET /admin/api/api/messages/5"), 4);
      assert.equal(sink.current.polling, true);
      assert.equal(sink.current.error, null);
      assert.equal(clock.pending(), 1, "the chain is armed again");
    } finally {
      t.done();
      clock.restore();
    }
  });

  test("unmounting leaves no timer, and an answer that arrives after it is dropped", async () => {
    const delays = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const { t, clock } = probe({ delays, routes: { "GET /admin/api/api/messages/5": () => { calls += 1; return calls === 1 ? ok(msg("queued")) : gate.then(() => ok(msg("queued"))); } } });
    try {
      await dom.settle(4);
      assert.equal(clock.pending(), 1);
      await tick(clock, 2000); // the second poll is now in flight
      assert.equal(calls, 2);
      dom.unmount(t.root);
      assert.equal(clock.pending(), 0, "unmounting clears the timer");
      release();
      await dom.settle(4);
      assert.equal(clock.pending(), 0, "the late answer arms nothing");
    } finally {
      t.done();
      clock.restore();
    }
  });
});

// ===========================================================================
// Usage
// ===========================================================================

describe("UsageTab", () => {
  const days = (counts) => counts.map(([sent, failed], i) => ({ day: `2026-11-0${i + 1}`, sent, failed }));
  const usage = (keysList) => ({ timezone: "Africa/Douala", from: "2026-11-01", to: "2026-11-03", keys: keysList });
  const usageRoute = (answer) => ({ "GET /admin/api/api/usage": (body, query) => ok(typeof answer === "function" ? answer(Object.fromEntries(new URLSearchParams(query))) : answer) });

  test("the query follows the selects; one table per entry with ratios, the failed link, the totals and the time zone", async () => {
    const answer = usage([
      { id: 1, name: "n8n", source: "api", revoked: false, days: days([[4, 0], [8, 2], [0, 0]]) },
      { id: null, name: null, source: "panel", revoked: false, days: days([[1, 0], [0, 0], [0, 0]]) },
      { id: 5, name: "old", source: "api", revoked: true, days: days([[0, 0], [0, 0], [0, 0]]) },
    ]);
    const t = kit.mountApi({ data: freshData(), route: route({ tab: "usage" }), routes: usageRoute(answer) });
    try {
      await t.settle(6);
      assert.deepEqual(search(t.guard.requests.find((r) => r.key === "GET /admin/api/api/usage")), { days: "7", key: "all" });
      const tables = dom.find(t.root, (el) => el.localName === "table");
      assert.equal(tables.length, 3);
      const text = dom.text(t.root);
      assert.ok(text.includes("n8n") && text.includes(T("api.source_panel")) && text.includes(T("api.key_state.revoked")));
      assert.ok(text.includes(T("api.usage_totals", { sent: 12, failed: 2 })));
      assert.ok(text.includes(T("api.usage_timezone", { zone: "Africa/Douala" })) && text.includes(T("api.usage_note")));
      const bars = dom.find(tables[0], (el) => el.localName === "progress").map((bar) => Number(bar.getAttribute("value") ?? bar.value));
      assert.deepEqual(bars, [0.4, 1, 0], "the ratio is the day over the busiest day of that entry");
      const failedLinks = dom.find(t.root, (el) => el.localName === "a" && (el.getAttribute("href") || "").includes("status=failed")).map((el) => el.getAttribute("href"));
      assert.deepEqual(failedLinks, ["#/api?tab=history&key=1&status=failed"], "only a count above zero is a link");
      // the selects feed the query
      dom.choose(dom.byAttr(t.root, "name", "api-usage-days", "select")[0], "30");
      await t.settle(4);
      dom.choose(dom.byAttr(t.root, "name", "api-usage-key", "select")[0], "panel");
      await t.settle(4);
      const queries = t.guard.requests.filter((r) => r.key === "GET /admin/api/api/usage").map(search);
      assert.deepEqual(queries[queries.length - 1], { days: "30", key: "panel" });
    } finally {
      t.done();
    }
  });

  test("an answer with nothing in it is the empty state; a failure offers Retry", async () => {
    const empty = kit.mountApi({ data: freshData(), route: route({ tab: "usage" }), routes: usageRoute(usage([{ id: 1, name: "n8n", source: "api", revoked: false, days: days([[0, 0], [0, 0], [0, 0]]) }])) });
    try {
      await empty.settle(6);
      assert.ok(empty.find.has(T("api.usage_empty")));
    } finally {
      empty.done();
    }
    let broken = true;
    const t = kit.mountApi({ data: freshData(), route: route({ tab: "usage" }), routes: { "GET /admin/api/api/usage": () => (broken ? fail(500, "internal_error") : ok(usage([]))) } });
    try {
      await t.settle(6);
      assert.ok(t.find.has(T("common.view_error")));
      broken = false;
      dom.click(dom.byText(t.root, T("common.retry"), "button").pop());
      await t.settle(4);
      assert.ok(t.find.has(T("api.usage_empty")));
    } finally {
      t.done();
    }
  });
});
