"use strict";
/**
 * The broadcasts view, pure logic (specs/002-admin-panel T165): lib/admin/public/js/views/broadcasts-logic.mjs.
 *
 *  - the pre-fill of "new broadcast to the failed destinations": failed AND selectable targets only,
 *    `mayHaveBeenDelivered` flagged, `reuseMediaOf` only when the source has `mediaAvailable`; no retry anywhere;
 *  - the recurrence form -> the rule payload;
 *  - `confirmTargets` equals the size of the selection; destination de-duplication and the 200 cap;
 *  - the client pre-checks, the live progress merge, the view files themselves load.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const VIEWS = path.resolve(__dirname, "..", "lib", "admin", "public", "js", "views");
const load = (file) => import(pathToFileURL(path.join(VIEWS, file)).href);

const dest = (n, over = {}) => ({ jid: `${1000 + n}@s.whatsapp.net`, name: `chat ${n}`, kind: "private", ...over });
const target = (n, over = {}) => ({
  chatJid: `${1000 + n}@s.whatsapp.net`,
  name: `chat ${n}`,
  position: n,
  status: "sent",
  errorCode: null,
  mayHaveBeenDelivered: false,
  selectable: true,
  sentAt: null,
  ...over,
});
const source = (over = {}) => ({
  id: 12,
  kind: "once",
  title: "Promo",
  text: "Hello everyone",
  mediaKind: "image",
  mediaName: "flyer.png",
  mediaSize: 2048,
  mediaAvailable: true,
  spacingMs: 7000,
  ...over,
});

test("buildPrefill: only the failed destinations that are still selectable, text and spacing of the source", async () => {
  const { buildPrefill } = await load("broadcasts-logic.mjs");
  const report = {
    run: { id: 5 },
    targets: [
      target(1, { status: "sent" }),
      target(2, { status: "failed", errorCode: "forbidden" }),
      target(3, { status: "failed", errorCode: "forbidden", selectable: false }), // a group the bot left
      target(4, { status: "cancelled" }),
      target(5, { status: "pending" }),
      target(6, { status: "failed", errorCode: "error" }),
    ],
  };
  const { form, skipped, mediaGone } = buildPrefill(source(), report);
  assert.deepEqual(form.targets.map((x) => x.jid), [dest(2).jid, dest(6).jid]);
  assert.equal(skipped, 1, "one failed destination is no longer a valid destination");
  assert.equal(mediaGone, false);
  assert.equal(form.kind, "once");
  assert.equal(form.when, "now");
  assert.equal(form.text, "Hello everyone");
  assert.equal(form.title, "Promo");
  assert.equal(form.spacingSeconds, 7);
  assert.equal(form.keepTargets, false);
  assert.equal(form.upload, null);
});

test("buildPrefill: destinations that may have been delivered are flagged but still included (they can be unticked)", async () => {
  const { buildPrefill, failedSummary } = await load("broadcasts-logic.mjs");
  const report = {
    targets: [
      target(1, { status: "failed", errorCode: "timeout", mayHaveBeenDelivered: true }),
      target(2, { status: "failed", errorCode: "connection_closed", mayHaveBeenDelivered: true }),
      target(3, { status: "failed", errorCode: "interrupted", mayHaveBeenDelivered: true }),
      target(4, { status: "failed", errorCode: "not_found" }),
    ],
  };
  const { form } = buildPrefill(source(), report);
  assert.deepEqual(form.targets.map((x) => [x.name, Boolean(x.mayHaveBeenDelivered)]), [
    ["chat 1", true],
    ["chat 2", true],
    ["chat 3", true],
    ["chat 4", false],
  ]);
  assert.deepEqual(failedSummary(report), { failed: 4, selectable: 4, unselectable: 0, unsure: 3 });
  // unticking one of them keeps the others
  const { toggleDestination } = await load("broadcasts-logic.mjs");
  const after = toggleDestination(form.targets, form.targets[0]);
  assert.deepEqual(after.selection.map((x) => x.name), ["chat 2", "chat 3", "chat 4"]);
});

test("buildPrefill: reuseMediaOf only when the source still has its media", async () => {
  const { buildPrefill } = await load("broadcasts-logic.mjs");
  const report = { targets: [target(1, { status: "failed", errorCode: "error" })] };

  const withMedia = buildPrefill(source({ mediaAvailable: true }), report);
  assert.equal(withMedia.form.reuseMediaOf, 12);
  assert.deepEqual(withMedia.form.reuseMedia, { name: "flyer.png", kind: "image", size: 2048, available: true });

  const gone = buildPrefill(source({ mediaAvailable: false }), report);
  assert.equal(gone.form.reuseMediaOf, null);
  assert.equal(gone.mediaGone, true, "the owner is told to re-upload");

  const none = buildPrefill(source({ mediaKind: null, mediaName: null, mediaSize: null, mediaAvailable: null }), report);
  assert.equal(none.form.reuseMediaOf, null);
  assert.equal(none.form.reuseMedia, null);
  assert.equal(none.mediaGone, false);
});

test("buildPrefill: it never makes a retry, only an ordinary form; the body carries the new confirmation", async () => {
  const { buildPrefill, buildBody } = await load("broadcasts-logic.mjs");
  const report = { targets: [target(1, { status: "failed" }), target(2, { status: "failed" }), target(3, { status: "sent" })] };
  const { form } = buildPrefill(source(), report);
  const body = buildBody(form);
  assert.deepEqual(body, {
    kind: "once",
    text: "Hello everyone",
    targets: [dest(1).jid, dest(2).jid],
    spacingMs: 7000,
    title: "Promo",
    reuseMediaOf: 12,
    confirmTargets: 2,
  });
  const logic = fs.readFileSync(path.join(VIEWS, "broadcasts-logic.mjs"), "utf8");
  const views = fs.readdirSync(VIEWS).filter((f) => f.startsWith("broadcasts"));
  for (const file of views) {
    const text = file === "broadcasts-logic.mjs" ? logic : fs.readFileSync(path.join(VIEWS, file), "utf8");
    assert.ok(!/retry/i.test(text.replace(/common\.retry/g, "")), `${file} has no retry action`);
  }
});

test("ruleFromForm: daily, weekly (sorted, unique, ISO) and monthly payloads", async () => {
  const { ruleFromForm, ruleToForm, emptyRule } = await load("broadcasts-logic.mjs");
  assert.deepEqual(ruleFromForm({ kind: "daily", days: [1, 2], day: 9, time: "08:00" }), { kind: "daily", time: "08:00" });
  assert.deepEqual(ruleFromForm({ kind: "weekly", days: [5, "1", 5, 3], day: 9, time: "07:30" }), { kind: "weekly", days: [1, 3, 5], time: "07:30" });
  assert.deepEqual(ruleFromForm({ kind: "monthly", days: [1], day: "31", time: "23:59" }), { kind: "monthly", day: 31, time: "23:59" });
  assert.deepEqual(ruleFromForm(undefined), { kind: "daily", time: "08:00" });
  assert.deepEqual(ruleFromForm(emptyRule()), { kind: "daily", time: "08:00" });
  // a rule from the server fills the form and goes back unchanged
  for (const rule of [{ kind: "daily", time: "08:00" }, { kind: "weekly", days: [2, 4], time: "18:15" }, { kind: "monthly", day: 15, time: "12:00" }]) {
    assert.deepEqual(ruleFromForm(ruleToForm(rule)), rule);
  }
});

test("buildBody: the recurrence form becomes the rule payload; runAt only for a scheduled one-shot", async () => {
  const { buildBody, emptyForm } = await load("broadcasts-logic.mjs");
  const recurring = buildBody(
    emptyForm({ kind: "recurring", text: " good morning ", targets: [dest(1)], recurrence: { kind: "weekly", days: [3, 1], day: 1, time: "08:00" }, runAtLocal: "2026-06-01T09:00", when: "later" }),
  );
  assert.deepEqual(recurring, {
    kind: "recurring",
    text: "good morning",
    targets: [dest(1).jid],
    spacingMs: 5000,
    recurrence: { kind: "weekly", days: [1, 3], time: "08:00" },
    confirmTargets: 1,
  });
  assert.ok(!("runAt" in recurring));

  const now = buildBody(emptyForm({ text: "x", targets: [dest(1)] }));
  assert.ok(!("runAt" in now) && !("recurrence" in now));
  const later = buildBody(emptyForm({ text: "x", targets: [dest(1)], when: "later", runAtLocal: "2026-06-01T09:30" }));
  assert.equal(later.runAt, new Date("2026-06-01T09:30").toISOString());
  const unparsable = buildBody(emptyForm({ text: "x", targets: [dest(1)], when: "later", runAtLocal: "" }));
  assert.ok(!("runAt" in unparsable));
});

test("buildBody: confirmTargets equals the selection size, after de-duplication; BC-2 carries none", async () => {
  const { buildBody, emptyForm } = await load("broadcasts-logic.mjs");
  const targets = [dest(1), dest(2), dest(1), dest(3, { pnJid: dest(2).jid })];
  const form = emptyForm({ text: "x", targets });
  const body = buildBody(form);
  assert.deepEqual(body.targets, [dest(1).jid, dest(2).jid], "a repeated or phone-number twin destination counts once");
  assert.equal(body.confirmTargets, body.targets.length);
  assert.ok(!("confirmTargets" in buildBody(form, { confirm: false })));
  for (const count of [1, 7, 200]) {
    const many = emptyForm({ text: "x", targets: Array.from({ length: count }, (_, i) => dest(i)) });
    const b = buildBody(many);
    assert.equal(b.confirmTargets, count);
    assert.equal(b.targets.length, count);
  }
});

test("buildBody: spacing in seconds becomes milliseconds; an upload wins over a reused media; title only when set", async () => {
  const { buildBody, emptyForm } = await load("broadcasts-logic.mjs");
  const form = emptyForm({ text: "x", targets: [dest(1)], spacingSeconds: 2.5, upload: { uploadId: "a".repeat(32), name: "p.png", kind: "image", size: 10 }, reuseMediaOf: 3, title: "  " });
  const body = buildBody(form);
  assert.equal(body.spacingMs, 2500);
  assert.equal(body.uploadId, "a".repeat(32));
  assert.ok(!("reuseMediaOf" in body), "the two are mutually exclusive");
  assert.ok(!("title" in body));
});

test("buildPatch sends only what changed; targets only when replaced, with their confirmation", async () => {
  const { buildPatch, formFromBroadcast } = await load("broadcasts-logic.mjs");
  const original = {
    id: 3,
    kind: "recurring",
    title: "Morning",
    text: "good morning",
    spacingMs: 5000,
    recurrence: { kind: "daily", time: "08:00" },
    mediaKind: null,
    mediaAvailable: null,
  };
  const form = formFromBroadcast(original);
  assert.equal(form.kind, "recurring");
  assert.equal(form.keepTargets, true);
  assert.deepEqual(buildPatch(form, original), {}, "nothing changed");

  const edited = { ...form, text: "hello", spacingSeconds: 8, recurrence: { kind: "weekly", days: [2], day: 1, time: "09:00" }, title: "" };
  assert.deepEqual(buildPatch(edited, original), {
    title: null,
    text: "hello",
    spacingMs: 8000,
    recurrence: { kind: "weekly", days: [2], time: "09:00" },
  });

  const replaced = { ...form, keepTargets: false, targets: [dest(1), dest(2)] };
  assert.deepEqual(buildPatch(replaced, original), { targets: [dest(1).jid, dest(2).jid], confirmTargets: 2 });
  const withUpload = { ...form, upload: { uploadId: "b".repeat(32), name: "n.png", kind: "image", size: 1 } };
  assert.deepEqual(buildPatch(withUpload, original), { uploadId: "b".repeat(32) });
});

test("destinations: de-duplication by phone number, toggling and the 200 cap", async () => {
  const { dedupeDestinations, toggleDestination, addDestinations, removeDestination, isSelected, MAX_TARGETS } = await load("broadcasts-logic.mjs");
  assert.equal(MAX_TARGETS, 200);
  const a = dest(1);
  const lid = { jid: "9991@lid", name: "same person", kind: "private", pnJid: a.jid };
  assert.deepEqual(dedupeDestinations([a, lid, dest(2), a]).map((x) => x.jid), [a.jid, dest(2).jid]);
  assert.deepEqual(dedupeDestinations([lid, a]).map((x) => x.jid), ["9991@lid"], "the first one wins");
  assert.deepEqual(dedupeDestinations(null), []);

  let selection = [];
  ({ selection } = toggleDestination(selection, a));
  assert.deepEqual(selection.map((x) => x.jid), [a.jid]);
  assert.equal(isSelected(selection, a), true);
  assert.equal(isSelected(selection, lid), true, "the same person under another id");
  ({ selection } = toggleDestination(selection, lid));
  assert.deepEqual(selection, [], "toggling the twin removes it");
  assert.equal(isSelected(selection, a), false);

  const full = Array.from({ length: 200 }, (_, i) => dest(i));
  const refused = toggleDestination(full, dest(500));
  assert.deepEqual({ added: refused.added, full: refused.full, size: refused.selection.length }, { added: false, full: true, size: 200 });
  assert.equal(toggleDestination(full, dest(5)).selection.length, 199, "an existing one can still be removed");

  const many = addDestinations(full.slice(0, 150), Array.from({ length: 100 }, (_, i) => dest(150 + i)));
  assert.equal(many.selection.length, 200);
  assert.equal(many.truncated, true);
  assert.equal(addDestinations([a], [a, dest(2)]).selection.length, 2);
  assert.deepEqual(removeDestination([a, dest(2)], a.jid).map((x) => x.jid), [dest(2).jid]);
});

test("the destination keeps only what the form needs", async () => {
  const { destination, kindOfJid } = await load("broadcasts-logic.mjs");
  assert.deepEqual(destination({ jid: "120363@g.us", name: null, lastSeenAt: "2026-01-01", selectable: true }), { jid: "120363@g.us", name: null, kind: "group" });
  assert.equal(kindOfJid("1@s.whatsapp.net"), "private");
  assert.equal(kindOfJid("2@lid"), "private");
});

test("validateForm: the obvious mistakes, in the API's field codes", async () => {
  const { validateForm, emptyForm } = await load("broadcasts-logic.mjs");
  const NOW = Date.UTC(2026, 5, 1, 10, 0, 0);
  assert.deepEqual(validateForm(emptyForm({ text: "x", targets: [dest(1)] }), { now: NOW }), {});

  const blank = validateForm(emptyForm(), { now: NOW });
  assert.deepEqual(blank.text, { code: "required" });
  assert.deepEqual(blank.targets, { code: "too_short", params: { min: 1 } });

  assert.deepEqual(validateForm(emptyForm({ text: "x".repeat(4097), targets: [dest(1)] })).text, { code: "too_long", params: { max: 4096 } });
  assert.equal(validateForm(emptyForm({ text: "x".repeat(4096), targets: [dest(1)] })).text, undefined);
  const withMedia = { text: "x".repeat(1025), targets: [dest(1)], upload: { uploadId: "a".repeat(32), name: "p", kind: "image", size: 1 } };
  assert.deepEqual(validateForm(emptyForm(withMedia)).text, { code: "too_long", params: { max: 1024 } });
  assert.deepEqual(validateForm(emptyForm({ ...withMedia, upload: null, reuseMediaOf: 4 })).text, { code: "too_long", params: { max: 1024 } });
  assert.deepEqual(validateForm(emptyForm({ text: "x", targets: [dest(1)], title: "t".repeat(101) })).title, { code: "too_long", params: { max: 100 } });

  const spacing = (s) => validateForm(emptyForm({ text: "x", targets: [dest(1)], spacingSeconds: s })).spacingMs;
  assert.deepEqual(spacing(1.9), { code: "out_of_range", params: { min: 2, max: 600 } });
  assert.equal(spacing(2), undefined);
  assert.equal(spacing(600), undefined);
  assert.equal(spacing(601).code, "out_of_range");
  assert.equal(spacing("fast").code, "invalid_type");

  const tooMany = Array.from({ length: 201 }, (_, i) => dest(i));
  assert.deepEqual(validateForm(emptyForm({ text: "x", targets: tooMany })).targets, { code: "too_many_items", params: { max: 200 } });
});

test("validateForm: a scheduled run and a recurrence rule", async () => {
  const { validateForm, emptyForm } = await load("broadcasts-logic.mjs");
  const NOW = new Date("2026-06-01T10:00").getTime();
  const later = (runAtLocal) => validateForm(emptyForm({ text: "x", targets: [dest(1)], when: "later", runAtLocal }), { now: NOW }).runAt;
  assert.deepEqual(later(""), { code: "required" });
  assert.deepEqual(later("2026-06-01T09:00"), { code: "in_past" });
  assert.equal(later("2026-06-01T09:59"), undefined, "within the 60 s tolerance");
  assert.equal(later("2026-06-01T12:00"), undefined);
  assert.deepEqual(later("not a date"), { code: "invalid_format" });

  const rule = (recurrence) => validateForm(emptyForm({ kind: "recurring", text: "x", targets: [dest(1)], recurrence }), { now: NOW });
  assert.deepEqual(rule({ kind: "daily", days: [1], day: 1, time: "8:00" })["recurrence.time"], { code: "invalid_format" });
  assert.deepEqual(rule({ kind: "daily", days: [1], day: 1, time: "24:00" })["recurrence.time"], { code: "invalid_format" });
  assert.deepEqual(rule({ kind: "weekly", days: [], day: 1, time: "08:00" })["recurrence.days"], { code: "required" });
  assert.deepEqual(rule({ kind: "monthly", days: [1], day: 32, time: "08:00" })["recurrence.day"], { code: "out_of_range", params: { min: 1, max: 31 } });
  assert.deepEqual(rule({ kind: "monthly", days: [1], day: 31, time: "08:00" }), {});
  assert.deepEqual(rule({ kind: "weekly", days: [7], day: 1, time: "00:00" }), {});
});

test("validateForm in edit mode: the kept destinations are not re-checked", async () => {
  const { validateForm, formFromBroadcast } = await load("broadcasts-logic.mjs");
  const form = formFromBroadcast({ title: null, text: "t", spacingMs: 5000, recurrence: { kind: "daily", time: "08:00" } });
  assert.deepEqual(validateForm(form, { editing: true }), {});
  assert.deepEqual(validateForm({ ...form, keepTargets: false }, { editing: true }).targets, { code: "too_short", params: { min: 1 } });
});

test("live progress: an SSE job event updates the list and the detail; unrelated events change nothing", async () => {
  const { mergeProgress, mergeDetailProgress, closesRun, openRun } = await load("broadcasts-logic.mjs");
  const item = (id, over = {}) => ({ id, state: "running", paused: null, latestRun: { id: id * 10, status: "running", total: 3, sent: 1, failed: 0, cancelled: 0, pending: 2 }, ...over });
  const event = { type: "broadcast", broadcastId: 2, runId: 20, status: "running", total: 3, sent: 2, failed: 0, cancelled: 0, pending: 1, updatedAt: "2026-06-01T10:00:00Z" };
  const list = [item(1), item(2)];
  const merged = mergeProgress(list, event);
  assert.equal(merged[1].latestRun.sent, 2);
  assert.equal(merged[1].latestRun.pending, 1);
  assert.equal(merged[0], list[0], "the other items are the same objects");
  assert.equal(mergeProgress(list, { ...event, broadcastId: 99 }), list);
  assert.equal(mergeProgress(list, { type: "restart", broadcastId: 2 }), list);
  assert.equal(mergeProgress(list, null), list);

  const done = mergeProgress(list, { ...event, status: "completed", sent: 3, pending: 0 });
  assert.equal(done[1].state, "completed");
  assert.equal(closesRun({ ...event, status: "completed" }), true);
  assert.equal(closesRun(event), false);
  assert.equal(closesRun({ type: "restart", status: "completed" }), false);

  const adminPaused = [item(2, { state: "paused", paused: { by: "admin" } })];
  assert.equal(mergeProgress(adminPaused, event)[0].state, "paused", "the owner's pause stays");

  const detail = { broadcast: item(2), runs: [{ id: 20, status: "running", total: 3, sent: 1, failed: 0, cancelled: 0, pending: 2 }, { id: 19, status: "completed", total: 3, sent: 3, failed: 0, cancelled: 0, pending: 0 }], nextOccurrences: null };
  const updated = mergeDetailProgress(detail, event);
  assert.equal(updated.runs[0].sent, 2);
  assert.equal(updated.runs[1].sent, 3);
  assert.equal(updated.broadcast.latestRun.sent, 2);
  assert.equal(mergeDetailProgress(detail, { ...event, broadcastId: 5 }), detail);
  assert.equal(openRun(detail).id, 20);
  assert.equal(openRun({ runs: [{ id: 1, status: "completed" }] }), null);
  assert.equal(openRun(null), null);
});

test("runProgress and estimateDurationMs", async () => {
  const { runProgress, estimateDurationMs } = await load("broadcasts-logic.mjs");
  assert.deepEqual(runProgress({ total: 4, sent: 1, failed: 1, cancelled: 0, pending: 2 }), { done: 2, total: 4, ratio: 0.5 });
  assert.deepEqual(runProgress({ total: 0 }), { done: 0, total: 0, ratio: 0 });
  assert.deepEqual(runProgress(null), { done: 0, total: 0, ratio: 0 });
  assert.equal(runProgress({ total: 2, sent: 5 }).ratio, 1);
  assert.equal(estimateDurationMs(5, 4000), Math.round(4 * 4000 * 1.1));
  assert.equal(estimateDurationMs(1, 9000), 0);
  assert.equal(estimateDurationMs(3, 100), Math.round(2 * 2000 * 1.1), "never counted under 2 s");
});

test("ruleText, labelOf and the query builders", async () => {
  const { ruleText, labelOf, listQuery, pickerQuery, weekdayName, stateTone, targetTone, localToIso, isoToLocal } = await load("broadcasts-logic.mjs");
  assert.deepEqual(ruleText({ kind: "daily", time: "08:00" }), { key: "broadcasts.rule_daily", params: { time: "08:00" } });
  assert.deepEqual(ruleText({ kind: "weekly", days: [1, 3], time: "07:30" }, "en"), { key: "broadcasts.rule_weekly", params: { days: "Monday and Wednesday", time: "07:30" } });
  assert.equal(ruleText({ kind: "weekly", days: [1, 5], time: "07:30" }, "fr").params.days, "lundi et vendredi");
  assert.equal(ruleText({ kind: "monthly", day: 15, time: "12:00" }).key, "broadcasts.rule_monthly");
  assert.equal(ruleText({ kind: "monthly", day: 31, time: "12:00" }).key, "broadcasts.rule_monthly_last");
  assert.equal(ruleText(null), null);
  assert.equal(weekdayName(1, "en"), "Monday");
  assert.equal(weekdayName(7, "en"), "Sunday");

  assert.equal(labelOf({ title: "Promo", text: "ignored" }), "Promo");
  assert.equal(labelOf({ title: null, text: "  two\n\nlines  " }), "two lines");
  assert.equal(labelOf({ title: null, text: "x".repeat(100) }).length, 60);

  assert.deepEqual(listQuery({ kind: "once", state: "", page: 1 }), { kind: "once", state: undefined, page: undefined, pageSize: 20 });
  assert.equal(listQuery({ page: 3 }).page, 3);
  assert.deepEqual(pickerQuery({ q: " alice ", kind: "group", page: 2 }), { selectable: 1, q: "alice", kind: "group", page: 2, pageSize: 50 });
  assert.equal(pickerQuery({ q: "   " }).q, undefined);
  assert.equal(pickerQuery().selectable, 1, "the picker only ever asks for valid destinations");

  assert.equal(stateTone("completed"), "ok");
  assert.equal(stateTone("failed"), "danger");
  assert.equal(stateTone("paused"), "warn");
  assert.equal(stateTone("running"), "info");
  assert.equal(stateTone("cancelled"), "neutral");
  assert.equal(targetTone("sent"), "ok");
  assert.equal(targetTone("failed"), "danger");

  assert.equal(localToIso(""), null);
  assert.equal(localToIso("garbage"), null);
  const iso = new Date(2026, 5, 1, 9, 30).toISOString();
  assert.equal(localToIso("2026-06-01T09:30"), iso);
  assert.equal(isoToLocal(iso), "2026-06-01T09:30");
  assert.equal(isoToLocal("nope"), "");
});

test("the view files load and keep the contract: meta, default export, no free-text number field", async () => {
  const mod = await load("broadcasts.mjs");
  assert.deepEqual(mod.meta, { area: "broadcasts", titleKey: "broadcasts.title", icon: "broadcasts" });
  assert.equal(typeof mod.default, "function");
  for (const file of fs.readdirSync(VIEWS).filter((f) => /^broadcasts-.*\.mjs$/.test(f) && f !== "broadcasts-logic.mjs")) {
    const imported = await load(file);
    assert.ok(Object.keys(imported).length > 0, file);
  }
  // the picker is fed by CHAT-1 only; nothing in the view takes a typed number as a destination
  const picker = fs.readFileSync(path.join(VIEWS, "broadcasts-picker.mjs"), "utf8");
  assert.match(picker, /\/admin\/api\/chats/);
  assert.ok(!/type=["']tel["']/.test(picker));
  assert.ok(!/addByNumber|typedNumber|manualNumber/i.test(picker));
});
