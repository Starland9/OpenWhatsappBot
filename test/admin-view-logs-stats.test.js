"use strict";
/**
 * Pure logic of the logs, statistics and history views (US7): client-side level filtering consistent with the
 * server's minimum rule (checked against the real ring), merging live entries, bar scaling of the 7-day chart,
 * ranked lists, the history filters and the query they build. The logic modules have no DOM, so Node imports them as
 * they are; the views are checked for their meta, their default export and the texts they name.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const VIEWS = path.join(ROOT, "lib", "admin", "public", "js", "views");
const load = (name) => import(pathToFileURL(path.join(VIEWS, name)).href);
const entry = (seq, level = "info", msg = `line ${seq}`, name = "mod") => ({ seq, ts: "2026-01-01T00:00:00.000Z", level, name, msg });

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

test("levelRank orders the six levels and refuses the rest", async () => {
  const { levelRank, LEVELS } = await load("logs-logic.mjs");
  assert.deepEqual(LEVELS, ["trace", "debug", "info", "warn", "error", "fatal"]);
  assert.deepEqual(LEVELS.map(levelRank), [0, 1, 2, 3, 4, 5]);
  assert.equal(levelRank("ERROR"), 4, "case does not matter");
  for (const odd of ["", undefined, null, "loud", "constructor", "__proto__", 3]) assert.equal(levelRank(odd), -1, String(odd));
});

test("matchesLevel is the server's minimum rule: `error` keeps error and fatal; an unknown minimum keeps all", async () => {
  const { matchesLevel, LEVELS } = await load("logs-logic.mjs");
  for (const minimum of LEVELS) {
    const kept = LEVELS.filter((level) => matchesLevel(entry(1, level), minimum));
    assert.deepEqual(kept, LEVELS.slice(LEVELS.indexOf(minimum)), `minimum ${minimum}`);
  }
  for (const none of ["", undefined, null, "loud"]) assert.equal(matchesLevel(entry(1, "trace"), none), true, String(none));
  assert.equal(matchesLevel(entry(1, "mystery"), "info"), false);
  assert.equal(matchesLevel(null, "info"), false);
});

test("matchesText is a case-insensitive substring of the message or the module name, never a pattern", async () => {
  const { matchesText } = await load("logs-logic.mjs");
  const e = entry(1, "error", "Failed to fetch (100%) [x]", "Downloader");
  assert.equal(matchesText(e, ""), true);
  assert.equal(matchesText(e, undefined), true);
  assert.equal(matchesText(e, "FAILED"), true);
  assert.equal(matchesText(e, "downloader"), true);
  assert.equal(matchesText(e, "(100%)"), true);
  assert.equal(matchesText(e, "[x]"), true);
  assert.equal(matchesText(e, ".*"), false);
  assert.equal(matchesText(e, "zzz"), false);
  assert.equal(matchesText(entry(2, "info", undefined, undefined), "a"), false, "missing fields read as empty");
});

test("filterEntries agrees with the real ring on every level and several texts", async () => {
  const { filterEntries, LEVELS } = await load("logs-logic.mjs");
  const ring = require("../lib/admin/logs/ring");
  ring.clear();
  const texts = ["alpha one", "Beta TWO", "gamma", "alpha three"];
  LEVELS.forEach((level, i) => ring.push({ level, name: i % 2 ? "Mod-A" : "mod-b", msg: texts[i % texts.length] }));
  ring.push({ level: "error", name: "extra", msg: "ALPHA again" });
  const held = ring.list({ limit: 1000 });
  for (const level of ["", ...LEVELS]) {
    for (const q of ["", "alpha", "BETA", "mod-a", "nothing"]) {
      const server = ring.list({ level: level || undefined, q: q || undefined, limit: 1000 }).map((e) => e.seq);
      const client = filterEntries(held, { level, q }).map((e) => e.seq);
      assert.deepEqual(client, server, `level=${level || "-"} q=${q || "-"}`);
    }
  }
  assert.deepEqual(filterEntries(null), []);
  ring.clear();
});

test("appendEntries adds only newer entries, keeps the order and the size bound", async () => {
  const { appendEntries, lastSeqOf, MAX_ENTRIES } = await load("logs-logic.mjs");
  const held = [entry(1), entry(2), entry(3)];
  assert.strictEqual(appendEntries(held, entry(3)), held, "nothing new: the very same list");
  assert.strictEqual(appendEntries(held, entry(1)), held);
  const next = appendEntries(held, entry(4));
  assert.deepEqual(next.map((e) => e.seq), [1, 2, 3, 4]);
  assert.deepEqual(held.map((e) => e.seq), [1, 2, 3], "the input is not modified");
  assert.deepEqual(appendEntries(held, [entry(2), entry(5), entry(5), entry(4), entry(6)]).map((e) => e.seq), [1, 2, 3, 5, 6]);
  assert.deepEqual(appendEntries(null, entry(7)).map((e) => e.seq), [7]);
  assert.deepEqual(appendEntries(held, [null, "x", { seq: "9" }, {}]).map((e) => e.seq), [1, 2, 3]);
  const full = Array.from({ length: MAX_ENTRIES }, (_, i) => entry(i + 1));
  const rolled = appendEntries(full, [entry(MAX_ENTRIES + 1), entry(MAX_ENTRIES + 2)]);
  assert.equal(rolled.length, MAX_ENTRIES);
  assert.equal(rolled[0].seq, 3, "the oldest fall off");
  assert.equal(lastSeqOf(rolled), MAX_ENTRIES + 2);
  assert.equal(lastSeqOf([]), null);
  assert.equal(lastSeqOf([], 0), 0);
});

test("newestFirst, splitPaused and paginate", async () => {
  const { newestFirst, splitPaused, paginate } = await load("logs-logic.mjs");
  const list = [entry(1), entry(2), entry(3), entry(4), entry(5)];
  assert.deepEqual(newestFirst(list).map((e) => e.seq), [5, 4, 3, 2, 1]);
  assert.deepEqual(list.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(splitPaused(list, null), { shown: list, pending: 0 });
  const paused = splitPaused(list, 3);
  assert.deepEqual(paused.shown.map((e) => e.seq), [1, 2, 3]);
  assert.equal(paused.pending, 2);
  assert.equal(splitPaused(list, 0).pending, 5);

  const pages = paginate(Array.from({ length: 250 }, (_, i) => i), 2, 100);
  assert.deepEqual([pages.page, pages.pages, pages.total, pages.items.length, pages.items[0]], [2, 3, 250, 100, 100]);
  assert.equal(paginate(Array.from({ length: 250 }, (_, i) => i), 9, 100).page, 3, "clamped to the last page");
  assert.equal(paginate([], 4).page, 1);
  assert.equal(paginate([], 4).pages, 1);
  assert.equal(paginate(null, 1).total, 0);
});

test("messageLines keeps the indentation of a stack (non-breaking spaces), drops trailing blank lines and bounds the length", async () => {
  const { messageLines } = await load("logs-logic.mjs");
  assert.deepEqual(messageLines("Error: x\n    at run (a.js:1:1)\n\tat b (b.js:2:2)\n\n"), ["Error: x", "\u00a0\u00a0\u00a0\u00a0at run (a.js:1:1)", "\u00a0\u00a0\u00a0\u00a0at b (b.js:2:2)"]);
  assert.deepEqual(messageLines("a\r\nb"), ["a", "b"], "Windows line ends");
  assert.deepEqual(messageLines(""), [""], "always at least one line");
  assert.deepEqual(messageLines(undefined), [""]);
  assert.deepEqual(messageLines("a\n\nb"), ["a", "", "b"], "a blank line in the middle stays");
  assert.equal(messageLines("x\n".repeat(500)).length, 200);
  assert.equal(messageLines("x\n".repeat(50), { maxLines: 5 }).length, 5);
  assert.equal(messageLines("  mid  dle ")[0], "\u00a0\u00a0mid  dle ", "only the leading blanks change");
});

test("levelTone and buildLogsQuery", async () => {
  const { levelTone, buildLogsQuery } = await load("logs-logic.mjs");
  assert.deepEqual(["trace", "debug", "info", "warn", "error", "fatal", "x"].map(levelTone), ["neutral", "neutral", "info", "warn", "danger", "danger", "neutral"]);
  assert.deepEqual(buildLogsQuery(), {});
  assert.deepEqual(buildLogsQuery({ level: "ERROR", q: "boom", since: 12, limit: 1000 }), { level: "error", q: "boom", since: 12, limit: 1000 });
  assert.deepEqual(buildLogsQuery({ level: "loud", q: "", since: null, limit: 0 }), {});
  assert.equal(buildLogsQuery({ limit: 5000 }).limit, 1000, "never more than the ring holds");
  assert.equal(buildLogsQuery({ q: "x".repeat(300) }).q.length, 100);
  assert.equal(buildLogsQuery({ since: 0 }).since, 0, "sequence 0 is a real cursor");
});

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

const week = (values) => values.map((messages, i) => ({ day: `2026-03-${String(5 + i).padStart(2, "0")}`, messages }));

test("chartModel scales the bars to the busiest day, keeps small days visible and draws nothing for an empty week", async () => {
  const { chartModel, CHART } = await load("stats-logic.mjs");
  const model = chartModel(week([0, 10, 100, 50, 1, 0, 25]));
  assert.equal(model.bars.length, 7);
  assert.equal(model.max, 100);
  assert.equal(model.total, 186);
  const drawable = CHART.height - CHART.top - CHART.bottom;
  assert.equal(model.bars[2].height, drawable, "the busiest day fills the chart");
  assert.equal(model.bars[3].height, Math.round(drawable / 2));
  assert.equal(model.bars[0].height, 0, "an empty day has no bar");
  assert.ok(model.bars[4].height >= 2, "one message is still visible");
  assert.ok(model.bars.every((b) => Number.isInteger(b.x) && Number.isInteger(b.y) && Number.isInteger(b.height)));
  assert.ok(model.bars.every((b) => b.y + b.height === model.baseline), "every bar stands on the baseline");
  assert.deepEqual(model.viewBox, { width: 7 * CHART.slot, height: CHART.height });
  assert.deepEqual(model.bars.map((b) => b.label), ["03-05", "03-06", "03-07", "03-08", "03-09", "03-10", "03-11"]);
  const xs = model.bars.map((b) => b.x);
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b), "left to right, oldest first");
  assert.ok(model.bars.every((b) => b.x >= 0 && b.x + b.width <= model.viewBox.width));

  const empty = chartModel(week([0, 0, 0, 0, 0, 0, 0]));
  assert.equal(empty.max, 0);
  assert.ok(empty.bars.every((b) => b.height === 0));
  assert.deepEqual(chartModel(undefined).bars, []);
  const rough = chartModel([{ day: "x", messages: -4 }, { messages: "nope" }, null]);
  assert.deepEqual(rough.bars.map((b) => b.messages), [0, 0, 0]);
});

test("rankedRows: ratios against the largest count, rubbish and zero counts skipped, custom labels", async () => {
  const { rankedRows, groupLabel } = await load("stats-logic.mjs");
  const rows = rankedRows([{ name: "ping", count: 40 }, { name: "menu", count: 10 }, null, { name: "zero", count: 0 }, { name: "odd", count: "x" }]);
  assert.deepEqual(rows.map((r) => [r.name, r.count, r.ratio]), [["ping", 40, 1], ["menu", 10, 0.25]]);
  assert.deepEqual(rankedRows(undefined), []);
  const groups = rankedRows([{ jid: "1@g.us", name: "Family", count: 8 }, { jid: "2@g.us", name: null, count: 4 }], groupLabel);
  assert.deepEqual(groups.map((r) => [r.key, r.name, r.ratio]), [["1@g.us", "Family", 1], ["2@g.us", "2@g.us", 0.5]]);
  assert.equal(groupLabel({ jid: "3@g.us", name: "" }), "3@g.us");
  assert.equal(groupLabel(null), "?");
});

test("isEmptyStats and chartSummary", async () => {
  const { isEmptyStats, chartSummary } = await load("stats-logic.mjs");
  const none = { days: week([0, 0, 0, 0, 0, 0, 0]), topCommands: [], failedCommands: [], topGroups: [] };
  assert.equal(isEmptyStats(none), true);
  assert.equal(isEmptyStats({ ...none, days: week([0, 0, 0, 0, 0, 0, 1]) }), false);
  assert.equal(isEmptyStats({ ...none, failedCommands: [{ name: "x", count: 1 }] }), false);
  assert.equal(isEmptyStats(null), true);
  assert.equal(chartSummary(week([1, 2, 0, 0, 0, 0, 3])), "03-05: 1, 03-06: 2, 03-07: 0, 03-08: 0, 03-09: 0, 03-10: 0, 03-11: 3");
  assert.equal(chartSummary(null), "");
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

test("buildAuditQuery: the form becomes the AUD-1 query; empty or invalid filters are left out", async () => {
  const { buildAuditQuery, PAGE_SIZE } = await load("audit-logic.mjs");
  assert.deepEqual(buildAuditQuery(), { page: 1, pageSize: PAGE_SIZE });
  assert.deepEqual(buildAuditQuery({ action: "setting", result: "refused" }, 3, 20), { action: "setting", result: "refused", page: 3, pageSize: 20 });
  assert.deepEqual(buildAuditQuery({ action: "Bad Action!", result: "blocked" }), { page: 1, pageSize: PAGE_SIZE }, "only what the server accepts is sent");
  const query = buildAuditQuery({ from: "2026-03-05", to: "2026-03-07" });
  assert.equal(query.from, new Date(2026, 2, 5, 0, 0, 0, 0).toISOString(), "the first instant of the local day");
  assert.equal(query.to, new Date(2026, 2, 7, 23, 59, 59, 999).toISOString(), "the last instant of the local day");
  assert.equal(buildAuditQuery({ from: "2026-02-31" }).from, undefined, "a day that does not exist");
  assert.equal(buildAuditQuery({ from: "yesterday" }).from, undefined);
  assert.equal(buildAuditQuery({}, 0, 0).page, 1);
  assert.equal(buildAuditQuery({}, "x", 9999).pageSize, 200, "never more than the server allows");
  assert.equal(buildAuditQuery({}, 1, -3).pageSize, 1);
});

test("validateFilters flags a malformed day and an end before the start", async () => {
  const { validateFilters } = await load("audit-logic.mjs");
  assert.deepEqual(validateFilters({}), { ok: true, errors: {} });
  assert.deepEqual(validateFilters({ from: "2026-03-05", to: "2026-03-05" }), { ok: true, errors: {} });
  assert.deepEqual(validateFilters({ from: "2026-03-05" }), { ok: true, errors: {} });
  assert.deepEqual(validateFilters({ from: "05/03/2026" }).errors, { from: "invalid_format" });
  assert.deepEqual(validateFilters({ to: "2026-02-30" }).errors, { to: "invalid_format" });
  assert.deepEqual(validateFilters({ from: "2026-03-07", to: "2026-03-05" }).errors, { to: "end_before_start" });
  assert.equal(validateFilters({ from: "2026-03-07", to: "2026-03-05" }).ok, false);
});

test("hasFilters, resultTone and the lists of the form", async () => {
  const { hasFilters, resultTone, ACTION_PREFIXES, RESULTS, EMPTY_FILTERS } = await load("audit-logic.mjs");
  assert.equal(hasFilters(EMPTY_FILTERS), false);
  assert.equal(hasFilters(undefined), false);
  assert.equal(hasFilters({ result: "ok" }), true);
  assert.equal(hasFilters({ from: "2026-01-01" }), true);
  assert.deepEqual(RESULTS, ["ok", "fail", "refused"]);
  assert.deepEqual(RESULTS.map(resultTone), ["ok", "danger", "warn"]);
  assert.equal(resultTone("blocked"), "neutral");
  assert.ok(ACTION_PREFIXES.every((p) => /^[a-z0-9.]{1,48}$/.test(p)), "every prefix is accepted by the server's pattern");
  assert.equal(new Set(ACTION_PREFIXES).size, ACTION_PREFIXES.length);
});

test("the action prefixes cover the vocabulary of the audit module", async () => {
  const { ACTION_PREFIXES } = await load("audit-logic.mjs");
  const { ACTIONS } = require("../lib/admin/audit");
  const uncovered = ACTIONS.filter((action) => !ACTION_PREFIXES.some((prefix) => action === prefix || action.startsWith(`${prefix}.`)));
  assert.deepEqual(uncovered, [], "every recorded action can be found with the filter");
});

test("summarizeDetail: none, a secret operation (never a value), a change, anything else cut short", async () => {
  const { summarizeDetail } = await load("audit-logic.mjs");
  assert.deepEqual(summarizeDetail(null), { kind: "none" });
  assert.deepEqual(summarizeDetail(undefined), { kind: "none" });
  assert.deepEqual(summarizeDetail({}), { kind: "none" });
  assert.deepEqual(summarizeDetail({ secret: true, op: "set" }), { kind: "secret", op: "set" });
  assert.deepEqual(summarizeDetail({ secret: true, op: "clear" }), { kind: "secret", op: "clear" });
  assert.equal(summarizeDetail({ secret: true, op: "set", value: "sk-1" }).kind, "text", "an unexpected shape is shown as data, not trusted as a secret marker");
  assert.deepEqual(summarizeDetail({ from: ".", to: "!" }), { kind: "change", from: ".", to: "!" });
  assert.deepEqual(summarizeDetail({ from: null, to: false }), { kind: "change", from: "-", to: "false" });
  assert.deepEqual(summarizeDetail({ from: ["a", "b"], to: "" }), { kind: "change", from: '["a","b"]', to: '""' });
  assert.deepEqual(summarizeDetail({ reason: "timeout" }), { kind: "text", text: '{"reason":"timeout"}', truncated: false });
  const long = summarizeDetail({ note: "x".repeat(500) });
  assert.equal(long.kind, "text");
  assert.equal(long.text.length, 160);
  assert.equal(long.truncated, true);
  assert.deepEqual(summarizeDetail("plain"), { kind: "text", text: "plain", truncated: false });
});

// ---------------------------------------------------------------------------
// The views
// ---------------------------------------------------------------------------

test("the three views export their meta and a component, and every text they name exists in the fragments", async () => {
  const expected = { logs: ["logs.title", "logs"], stats: ["stats.title", "stats"], audit: ["audit.title", "audit"] };
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "lib", "admin", "public", "i18n", "en.json"), "utf8"));
  const fragments = {};
  for (const area of Object.keys(expected)) {
    const fragment = JSON.parse(fs.readFileSync(path.join(ROOT, "specs", "002-admin-panel", "i18n", `panel-${area}.json`), "utf8"));
    assert.deepEqual(Object.keys(fragment.en).sort(), Object.keys(fragment.fr).sort(), `${area}: en and fr have the same keys`);
    Object.assign(fragments, fragment.en);
    const view = await load(`${area}.mjs`);
    assert.deepEqual(view.meta, { area, titleKey: expected[area][0], icon: expected[area][1] });
    assert.equal(typeof view.default, "function");
  }
  const known = new Set([...Object.keys(base), ...Object.keys(fragments)]);
  const { LEVELS } = await load("logs-logic.mjs");
  const { ACTION_PREFIXES, RESULTS } = await load("audit-logic.mjs");
  const dynamic = [
    "logs.level_all",
    ...LEVELS.filter((level) => level !== "trace").map((level) => `logs.level_${level}`),
    ...ACTION_PREFIXES.map((prefix) => `audit.prefix_${prefix}`),
    ...RESULTS.map((result) => `audit.result_${result}`),
    "logs.pending_one",
    "logs.pending_other",
  ];
  for (const key of dynamic) assert.ok(known.has(key), key);
  // the pending counter is a plural: the generic form stays as the fallback
  assert.ok(known.has("logs.pending"));
});
