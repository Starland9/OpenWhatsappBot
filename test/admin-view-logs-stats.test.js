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

// Rule details of feature 003 (specs/003-command-permissions T045, contracts/panel-ui.md section 9): the detail of
// `command.permission.set` and `command.permission.delete` is `{ mode, previousMode, added, removed }`, where a list
// the server found too long is replaced by `removedCount` / `addedCount` (admin-permissions-api.md 1.7).

test("summarizeDetail: a rule detail reads as a rule, with counts from the lists", async () => {
  const { summarizeDetail } = await load("audit-logic.mjs");
  const detail = { mode: "extra", previousMode: "only", added: ["237690000001", "237690000002@lid"], removed: ["237690000003"] };
  assert.deepEqual(summarizeDetail(detail), {
    kind: "rule",
    mode: "extra",
    previousMode: "only",
    added: ["237690000001", "237690000002@lid"],
    removed: ["237690000003"],
    addedCount: 2,
    removedCount: 1,
  });
  // a creation has no previous mode, a rule without previousMode reads the same
  assert.equal(summarizeDetail({ mode: "only", previousMode: null, added: ["1"], removed: [] }).previousMode, null);
  assert.equal(summarizeDetail({ mode: "only", added: ["1"], removed: [] }).previousMode, null);
  // a deletion: the removed rule's mode twice, nothing added, every id removed
  assert.deepEqual(summarizeDetail({ mode: "only", previousMode: "only", added: [], removed: ["237690000001"] }), {
    kind: "rule",
    mode: "only",
    previousMode: "only",
    added: [],
    removed: ["237690000001"],
    addedCount: 0,
    removedCount: 1,
  });
  // an enrichment-only save has two empty lists
  const same = summarizeDetail({ mode: "extra", previousMode: "extra", added: [], removed: [] });
  assert.deepEqual([same.kind, same.addedCount, same.removedCount], ["rule", 0, 0]);
  // an unknown mode is kept as written (the view shows the raw string)
  assert.equal(summarizeDetail({ mode: "mystery", previousMode: null, added: [], removed: [] }).mode, "mystery");
  // the input is not mutated and the lists are copies
  const input = { mode: "extra", previousMode: null, added: ["1"], removed: [] };
  const out = summarizeDetail(input);
  out.added.push("2");
  assert.deepEqual(input.added, ["1"]);
});

test("summarizeDetail: a list the server replaced by its count keeps the number without ids", async () => {
  const { summarizeDetail } = await load("audit-logic.mjs");
  assert.deepEqual(summarizeDetail({ mode: "extra", previousMode: "extra", added: ["237690000001"], removedCount: 40 }), {
    kind: "rule",
    mode: "extra",
    previousMode: "extra",
    added: ["237690000001"],
    removed: null,
    addedCount: 1,
    removedCount: 40,
  });
  assert.deepEqual(summarizeDetail({ mode: "extra", previousMode: "only", addedCount: 25, removedCount: 60 }), {
    kind: "rule",
    mode: "extra",
    previousMode: "only",
    added: null,
    removed: null,
    addedCount: 25,
    removedCount: 60,
  });
  // zero is a count too
  assert.equal(summarizeDetail({ mode: "extra", previousMode: null, added: ["1"], removedCount: 0 }).removedCount, 0);
  // a count that is not a whole non-negative number is not trusted
  for (const bad of [-1, 1.5, NaN, Infinity, "4", null, true, [], {}]) {
    assert.equal(summarizeDetail({ mode: "extra", previousMode: null, added: ["1"], removedCount: bad }).kind, "text", `removedCount ${String(bad)}`);
  }
});

test("summarizeDetail: any other shape keeps the generic text, the server's truncation marker included", async () => {
  const { summarizeDetail } = await load("audit-logic.mjs");
  // the server's own marker for a detail over 2000 characters
  assert.deepEqual(summarizeDetail({ truncated: true, length: 2400, keys: ["mode", "previousMode", "added", "removed"] }), {
    kind: "text",
    text: '{"truncated":true,"length":2400,"keys":["mode","previousMode","added","removed"]}',
    truncated: false,
  });
  // an extra key
  assert.equal(summarizeDetail({ mode: "extra", previousMode: null, added: [], removed: [], note: "x" }).kind, "text");
  // no mode, an empty mode, a mode that is not a string
  for (const mode of [undefined, "", 3, null, ["extra"]]) {
    assert.equal(summarizeDetail({ mode, previousMode: null, added: [], removed: [] }).kind, "text", `mode ${JSON.stringify(mode)}`);
  }
  // a previousMode that is neither a string nor null
  for (const previousMode of [3, true, ["only"], {}]) {
    assert.equal(summarizeDetail({ mode: "extra", previousMode, added: [], removed: [] }).kind, "text", `previousMode ${JSON.stringify(previousMode)}`);
  }
  // ids that are not strings, a list that is not an array
  assert.equal(summarizeDetail({ mode: "extra", previousMode: null, added: [237690000001], removed: [] }).kind, "text");
  assert.equal(summarizeDetail({ mode: "extra", previousMode: null, added: ["1", null], removed: [] }).kind, "text");
  assert.equal(summarizeDetail({ mode: "extra", previousMode: null, added: "237690000001", removed: [] }).kind, "text");
  assert.equal(summarizeDetail({ mode: "extra", previousMode: null, added: { 0: "1" }, removed: [] }).kind, "text");
  assert.equal(summarizeDetail({ mode: "extra", previousMode: null, added: null, removed: [] }).kind, "text");
  // a side with neither its list nor its count
  assert.equal(summarizeDetail({ mode: "extra", previousMode: null, added: ["1"] }).kind, "text");
  assert.equal(summarizeDetail({ mode: "extra", previousMode: null, removed: ["1"] }).kind, "text");
  assert.equal(summarizeDetail({ mode: "extra" }).kind, "text");
  assert.equal(summarizeDetail({ mode: "extra", previousMode: null }).kind, "text");
  assert.equal(summarizeDetail({ mode: "extra", previousMode: null, addedCount: 3 }).kind, "text");
  // nothing that looked like a rule changes the older branches
  assert.deepEqual(summarizeDetail({ from: "extra", to: "only" }), { kind: "change", from: "extra", to: "only" });
});

test("summarizeDetail: ids are cut at 48 characters and lists at 100, the counts stay true", async () => {
  const { summarizeDetail } = await load("audit-logic.mjs");
  const long = "7".repeat(60);
  const cutOne = summarizeDetail({ mode: "extra", previousMode: null, added: [long], removed: [] });
  assert.equal(cutOne.added[0].length, 48);
  assert.equal(cutOne.added[0], long.slice(0, 48));
  const ids = Array.from({ length: 120 }, (_, i) => String(237690000000 + i));
  const many = summarizeDetail({ mode: "only", previousMode: "only", added: ids.slice(0, 100), removed: ids });
  assert.equal(many.added.length, 100);
  assert.equal(many.removed.length, 100, "at most 100 ids are kept");
  assert.equal(many.addedCount, 100);
  assert.equal(many.removedCount, 120, "the count is the real length");
  assert.deepEqual(many.removed, ids.slice(0, 100));
});

test("ruleIdLabel: digits become +digits, digits@lid becomes @digits, anything else is returned as is", async () => {
  const { ruleIdLabel } = await load("audit-logic.mjs");
  assert.equal(ruleIdLabel("237690000001"), "+237690000001");
  assert.equal(ruleIdLabel("237690000002@lid"), "@237690000002");
  assert.equal(ruleIdLabel("120363000000000000@g.us"), "120363000000000000@g.us");
  assert.equal(ruleIdLabel("abc"), "abc");
  assert.equal(ruleIdLabel("+237690000001"), "+237690000001");
  assert.equal(ruleIdLabel("12ab"), "12ab");
  assert.equal(ruleIdLabel("@lid"), "@lid");
  assert.equal(ruleIdLabel(""), "");
  assert.equal(ruleIdLabel("1234567@lid"), "@1234567");
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

// ---------------------------------------------------------------------------
// Feature 004 (contracts/panel-ui.md 11.5): the `api` prefix and the three new detail kinds of the audit page
// ---------------------------------------------------------------------------

test("the api prefix is a filter of the audit page, after broadcast, with its text in both languages; dayBound is exported", async () => {
  const { ACTION_PREFIXES, dayBound } = await load("audit-logic.mjs");
  assert.equal(ACTION_PREFIXES[ACTION_PREFIXES.indexOf("broadcast") + 1], "api");
  for (const lang of ["en", "fr"]) {
    const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "lib", "admin", "public", "i18n", `${lang}.json`), "utf8"));
    assert.equal(typeof catalog["audit.prefix_api"], "string", lang);
  }
  assert.equal(typeof dayBound, "function");
  assert.equal(dayBound("2026-03-05", false).getHours(), 0);
  assert.equal(dayBound("2026-03-05", true).getHours(), 23);
  assert.equal(dayBound("2026-02-30", false), null);
});

test("summarizeDetail: an api detail reads as an api change, with the lists cut and the absent fields null", async () => {
  const { summarizeDetail } = await load("audit-logic.mjs");
  const full = summarizeDetail({
    name: "n8n", last4: "x9Qa", source: 2, rightsAdded: ["messages.send.text"], rightsRemoved: ["messages.read"],
    changed: ["rights", "policy"], policyFrom: "list", policyTo: "known", widened: ["rights", "policy"], cancelled: 3,
  });
  assert.deepEqual(full, {
    kind: "api", name: "n8n", last4: "x9Qa", source: "2", rightsAdded: ["messages.send.text"], rightsRemoved: ["messages.read"],
    rightsAddedCount: null, rightsRemovedCount: null, changed: ["rights", "policy"], policyFrom: "list", policyTo: "known",
    widened: ["rights", "policy"], cancelled: 3,
  });
  // a create: the name and what was granted, nothing else
  const created = summarizeDetail({ name: "n8n", last4: "x9Qa", rightsAdded: ["messages.send.text"], policyTo: "list", changed: ["name", "rights"] });
  assert.equal(created.kind, "api");
  assert.equal(created.source, null);
  assert.equal(created.cancelled, null);
  assert.deepEqual(created.rightsRemoved, null);
  // the disable of the API carries only the count
  assert.deepEqual(summarizeDetail({ cancelled: 0 }), {
    kind: "api", name: null, last4: null, source: null, rightsAdded: null, rightsRemoved: null, rightsAddedCount: null,
    rightsRemovedCount: null, changed: null, policyFrom: null, policyTo: null, widened: null, cancelled: 0,
  });
  // the server replaced a long list by its count
  const counted = summarizeDetail({ name: "n8n", last4: "x9Qa", rightsAddedCount: 40, rightsRemovedCount: 2 });
  assert.equal(counted.rightsAdded, null);
  assert.equal(counted.rightsAddedCount, 40);
  assert.equal(counted.rightsRemovedCount, 2);
  // ids are cut at 64 characters and lists at 100
  const cut = summarizeDetail({ name: "n8n", rightsAdded: Array.from({ length: 150 }, (_, i) => `right.${i}${"x".repeat(80)}`) });
  assert.equal(cut.rightsAdded.length, 100);
  assert.ok(cut.rightsAdded.every((id) => id.length <= 64));
});

test("summarizeDetail: a count in place of a list, an extra key or a non-string id fall back to text", async () => {
  const { summarizeDetail } = await load("audit-logic.mjs");
  for (const detail of [
    { name: "n8n", rightsAdded: 3 },
    { name: "n8n", changed: "rights" },
    { name: "n8n", extra: true },
    { name: "n8n", rightsAdded: ["ok", 4] },
    { name: "n8n", rightsAddedCount: -1 },
    { name: "n8n", cancelled: "3" },
    { name: 7, last4: "x9Qa" },
  ]) {
    assert.equal(summarizeDetail(detail).kind, "text", JSON.stringify(detail));
  }
  // the key set of the other kinds is untouched
  assert.equal(summarizeDetail({ from: "a", to: "b" }).kind, "change");
  assert.equal(summarizeDetail({ mode: "only", added: [], removed: [] }).kind, "rule");
});

test("summarizeDetail: the plain-HTTP networks and the retry delay", async () => {
  const { summarizeDetail } = await load("audit-logic.mjs");
  assert.deepEqual(summarizeDetail({ added: ["192.168.1.0/24"], removed: [] }), { kind: "networks", added: ["192.168.1.0/24"], removed: [] });
  const many = summarizeDetail({ added: Array.from({ length: 130 }, (_, i) => `10.0.${i}.0/24${"x".repeat(80)}`), removed: ["10.0.0.0/8"] });
  assert.equal(many.kind, "networks");
  assert.equal(many.added.length, 100);
  assert.ok(many.added.every((range) => range.length <= 64));
  assert.equal(summarizeDetail({ added: "10.0.0.0/8", removed: [] }).kind, "text");
  assert.equal(summarizeDetail({ added: [], removed: [], extra: 1 }).kind, "text");
  assert.deepEqual(summarizeDetail({ retryAfterMs: 900000 }), { kind: "retry", ms: 900000 });
  assert.deepEqual(summarizeDetail({ retryAfterMs: 0 }), { kind: "retry", ms: 0 });
  for (const bad of [{ retryAfterMs: -1 }, { retryAfterMs: "900000" }, { retryAfterMs: Infinity }, { retryAfterMs: 5, other: 1 }]) {
    assert.equal(summarizeDetail(bad).kind, "text", JSON.stringify(bad));
  }
});

test("the audit page renders the api, networks and retry details (feature 004, T121)", async () => {
  const { createDom, importPublic } = require("./helpers/fakeDom");
  const { createViewGuard, answer } = require("./helpers/viewGuard");
  const { catalogOf } = require("./helpers/apiViewKit");
  const dom = await createDom();
  const i18n = await importPublic("js/i18n.mjs");
  for (const lang of ["en", "fr"]) i18n.setCatalog(lang, catalogOf(lang));
  await i18n.setLanguage("en", { remember: false });
  const components = await importPublic("js/components/index.mjs");
  const view = await importPublic("js/views/audit.mjs");
  const guard = createViewGuard({ preact: dom.preact });
  const T = (key, params) => i18n.t(key, params);
  const rows = [
    { id: 1, at: "2026-11-02T09:00:00.000Z", action: "api.key.update", target: "3", origin: "127.0.0.1", result: "ok", detail: { name: "n8n", last4: "x9Qa", rightsAdded: ["messages.send.image"], rightsRemoved: [], changed: ["rights", "policy"], policyFrom: "list", policyTo: "known", widened: ["rights", "policy", "brand_new"] } },
    { id: 2, at: "2026-11-02T09:01:00.000Z", action: "api.key.create", target: "4", origin: "127.0.0.1", result: "ok", detail: { name: "mailer", last4: "ab12", rightsAddedCount: 40, changed: ["name"], source: 3 } },
    { id: 3, at: "2026-11-02T09:02:00.000Z", action: "api.disable", target: null, origin: "127.0.0.1", result: "ok", detail: { cancelled: 1 } },
    { id: 4, at: "2026-11-02T09:03:00.000Z", action: "api.plainhttp.update", target: null, origin: "127.0.0.1", result: "ok", detail: { added: ["192.168.1.0/24"], removed: ["10.0.0.0/8", "172.16.0.0/12"] } },
    { id: 5, at: "2026-11-02T09:04:00.000Z", action: "api.origin.block", target: "203.0.113.9", origin: "203.0.113.9", result: "blocked", detail: { retryAfterMs: 900000 } },
    { id: 6, at: "2026-11-02T09:05:00.000Z", action: "api.test", target: "31", origin: "127.0.0.1", result: "ok", detail: { format: "text", kind: "private" } },
  ];
  globalThis.fetch = guard.fetch({ "GET /admin/api/audit": () => answer(200, { items: rows, page: 1, pageSize: 50, total: rows.length }) });
  const root = dom.mount(components.html`<${view.default} />`);
  try {
    await dom.settle(6);
    const cell = (id) => dom.text(dom.find(root, (el) => el.localName === "tr" && dom.text(el).includes(`api.`) && dom.find(el, (c) => c.localName === "span" && dom.text(c) === rows[id - 1].action).length)[0]);
    const update = cell(1);
    assert.ok(update.includes(T("audit.detail_api_key", { name: "n8n" })) && update.includes("x9Qa") && update.includes("messages.send.image"));
    assert.ok(update.includes(T("audit.detail_api_policy", { from: T("api.policy_list"), to: T("api.policy_known") })));
    assert.ok(update.includes(T("audit.detail_api_changed", { fields: "rights, policy" })));
    assert.ok(update.includes(T("audit.detail_api_widened", { reasons: [T("api.reason_rights"), T("api.reason_policy"), "brand_new"].join(", ") })), "a reason without a text is shown raw");
    const create = cell(2);
    assert.ok(create.includes(T("audit.detail_api_key", { name: "mailer" })) && /\+\s*40/.test(create) && create.includes(T("audit.detail_api_source", { id: "3" })));
    assert.ok(cell(3).includes(T("audit.detail_api_cancelled", { count: 1 })));
    const networks = cell(4);
    assert.ok(networks.includes(T("audit.detail_networks", { added: 1, removed: 2 })) && networks.includes("192.168.1.0/24") && networks.includes("172.16.0.0/12"));
    assert.ok(cell(5).includes(T("audit.detail_retry", { retryAfter: i18n.formatDuration(900000) })));
    assert.ok(cell(6).includes('{"format":"text","kind":"private"}'), "an unknown shape stays as data");
  } finally {
    dom.unmount(root);
    try {
      guard.assertClean();
    } finally {
      guard.restore();
      dom.restore();
      i18n.__resetForTests();
      delete globalThis.fetch;
    }
  }
});
