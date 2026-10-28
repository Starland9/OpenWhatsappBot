"use strict";
/**
 * Pure logic of the dashboard view (lib/admin/public/js/views/dashboard-logic.mjs): the status label mapping for
 * the 8 client states (FR-012), uptime and memory figures, the list of last errors, the restart button rules and the
 * progress of the restart job. The logic has no DOM, so Node imports it as it is; the view and its texts are checked
 * for the keys they use.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const VIEWS = path.join(ROOT, "lib", "admin", "public", "js", "views");
const load = (name) => import(pathToFileURL(path.join(VIEWS, name)).href);

test("every client status has a group, a tone and a catalog key; an unknown one reads as idle", async () => {
  const { statusInfo, CLIENT_STATUSES } = await load("dashboard-logic.mjs");
  assert.deepEqual(CLIENT_STATUSES, ["idle", "connecting", "qr", "open", "reconnecting", "restarting", "stopped", "logged_out"]);
  const expected = {
    open: ["connected", "ok"],
    qr: ["pairing", "warn"],
    logged_out: ["pairing", "warn"],
    connecting: ["transitional", "info"],
    reconnecting: ["transitional", "info"],
    restarting: ["transitional", "info"],
    idle: ["disconnected", "neutral"],
    stopped: ["disconnected", "neutral"],
  };
  for (const status of CLIENT_STATUSES) {
    const info = statusInfo(status);
    assert.deepEqual([info.group, info.tone], expected[status], status);
    assert.equal(info.status, status);
    assert.equal(info.labelKey, `status.${status}`);
  }
  for (const odd of ["", undefined, null, "weird", 3]) assert.equal(statusInfo(odd).status, "idle");
});

test("the group matches the FR-012 labels: connected, waiting for pairing, disconnected, in transition", async () => {
  const { statusInfo } = await load("dashboard-logic.mjs");
  assert.equal(statusInfo("open").group, "connected");
  assert.equal(statusInfo("qr").group, "pairing");
  assert.equal(statusInfo("logged_out").group, "pairing");
  assert.equal(statusInfo("stopped").group, "disconnected");
});

test("the status tone agrees with the badge of the top bar (ui.mjs statusTone)", async () => {
  const { statusInfo, CLIENT_STATUSES } = await load("dashboard-logic.mjs");
  const { statusTone } = await import(pathToFileURL(path.join(ROOT, "lib", "admin", "public", "js", "ui.mjs")).href);
  for (const status of CLIENT_STATUSES) assert.equal(statusInfo(status).tone, statusTone(status), status);
});

test("uptimeParts splits seconds into days, hours, minutes and seconds", async () => {
  const { uptimeParts } = await load("dashboard-logic.mjs");
  assert.deepEqual(uptimeParts(0), { days: 0, hours: 0, minutes: 0, seconds: 0 });
  assert.deepEqual(uptimeParts(59), { days: 0, hours: 0, minutes: 0, seconds: 59 });
  assert.deepEqual(uptimeParts(3725), { days: 0, hours: 1, minutes: 2, seconds: 5 });
  assert.deepEqual(uptimeParts(93784), { days: 1, hours: 2, minutes: 3, seconds: 4 });
  assert.deepEqual(uptimeParts(-5), { days: 0, hours: 0, minutes: 0, seconds: 0 });
  assert.deepEqual(uptimeParts("abc"), { days: 0, hours: 0, minutes: 0, seconds: 0 });
  assert.deepEqual(uptimeParts(61.9), { days: 0, hours: 0, minutes: 1, seconds: 1 });
});

test("liveUptime adds the seconds since the state arrived, and never goes backwards", async () => {
  const { liveUptime } = await load("dashboard-logic.mjs");
  assert.equal(liveUptime(100, 1000, 1000), 100);
  assert.equal(liveUptime(100, 1000, 3999), 102);
  assert.equal(liveUptime(100, 1000, 61000), 160);
  assert.equal(liveUptime(100, 5000, 1000), 100, "a clock that went back adds nothing");
  assert.equal(liveUptime(undefined, 1000, 4000), 3);
  assert.equal(liveUptime(100, undefined, 4000), 100);
  assert.equal(liveUptime(-4, 0, 0), 0);
});

test("memory: rows in a fixed order, megabytes with a sensible precision, heap share", async () => {
  const { memoryRows, toMegabytes, heapPercent } = await load("dashboard-logic.mjs");
  assert.deepEqual(memoryRows({ external: 4, rss: 1, heapTotal: 3, heapUsed: 2, arrayBuffers: 9 }), [
    { key: "rss", bytes: 1 },
    { key: "heapUsed", bytes: 2 },
    { key: "heapTotal", bytes: 3 },
    { key: "external", bytes: 4 },
  ]);
  assert.deepEqual(memoryRows(null).map((row) => row.bytes), [0, 0, 0, 0]);
  assert.deepEqual(memoryRows({ rss: "x", heapUsed: -3 }).map((row) => row.bytes), [0, 0, 0, 0]);
  assert.equal(toMegabytes(5 * 1024 * 1024), 5);
  assert.equal(toMegabytes(5.5 * 1024 * 1024), 5.5);
  assert.equal(toMegabytes(123456789), 118);
  assert.equal(toMegabytes(0), 0);
  assert.equal(toMegabytes("nope"), 0);
  assert.equal(heapPercent({ heapUsed: 50, heapTotal: 80 }), 63);
  assert.equal(heapPercent({ heapUsed: 90, heapTotal: 80 }), 100);
  assert.equal(heapPercent({ heapUsed: 5, heapTotal: 0 }), 0);
  assert.equal(heapPercent(undefined), 0);
});

test("shapeErrors: a summary line and the rest as detail, newest first order kept, rubbish skipped", async () => {
  const { shapeErrors } = await load("dashboard-logic.mjs");
  const list = shapeErrors([
    { seq: 9, ts: "2026-01-01T12:00:00.000Z", name: "cmd", msg: "TypeError: x is not a function\n    at run (a.js:1:1)\n    at b (b.js:2:2)" },
    { seq: 8, ts: "2026-01-01T11:59:00.000Z", name: "", msg: "plain message" },
    null,
    "text",
    { seq: 7, ts: 12, name: "svc", msg: "\n\n  first real line  \nsecond" },
    { name: "no seq", msg: undefined },
  ]);
  assert.deepEqual(list.map((e) => e.key), [9, 8, 7, 3]);
  assert.equal(list[0].summary, "TypeError: x is not a function");
  assert.equal(list[0].detail, "at run (a.js:1:1)\n    at b (b.js:2:2)");
  assert.equal(list[1].summary, "plain message");
  assert.equal(list[1].detail, "");
  assert.equal(list[2].summary, "first real line");
  assert.equal(list[2].detail, "second");
  assert.equal(list[2].ts, null, "a timestamp that is not a string is dropped");
  assert.equal(list[3].summary, "");
  assert.deepEqual(shapeErrors(undefined), []);
  assert.deepEqual(shapeErrors("nope"), []);
});

test("shapeErrors cuts a very long line and keeps it whole in the detail", async () => {
  const { shapeErrors } = await load("dashboard-logic.mjs");
  const long = "x".repeat(500);
  const [entry] = shapeErrors([{ seq: 1, ts: "2026-01-01T00:00:00.000Z", name: "n", msg: `${long}\nmore` }], { maxSummary: 50 });
  assert.equal(entry.summary.length, 50);
  assert.ok(entry.summary.endsWith("…"));
  assert.ok(entry.detail.startsWith(long));
  assert.ok(entry.detail.endsWith("more"));
});

test("restartAvailability: the button is off during a job, a restart or a restore", async () => {
  const { restartAvailability } = await load("dashboard-logic.mjs");
  const idle = { bot: { status: "open" }, job: null, maintenance: false };
  assert.deepEqual(restartAvailability(idle), { disabled: false, reason: null });
  assert.deepEqual(restartAvailability({ ...idle, job: { id: 1, type: "update.apply", status: "running" } }), { disabled: true, reason: "job" });
  assert.deepEqual(restartAvailability({ ...idle, bot: { status: "restarting" } }), { disabled: true, reason: "restarting" });
  assert.deepEqual(restartAvailability({ ...idle, maintenance: true }), { disabled: true, reason: "maintenance" });
  assert.deepEqual(restartAvailability(idle, { id: 5, status: "running" }), { disabled: true, reason: "job" }, "a job just started here");
  assert.deepEqual(restartAvailability(idle, { id: 5, status: "done" }), { disabled: false, reason: null });
  assert.deepEqual(restartAvailability(null), { disabled: false, reason: null });
});

test("jobProgress: the four restart phases are steps 1 to 4; other jobs have no step", async () => {
  const { jobProgress, RESTART_PHASES } = await load("dashboard-logic.mjs");
  assert.deepEqual(RESTART_PHASES, ["stop", "settings", "start", "ready"]);
  RESTART_PHASES.forEach((phase, index) => {
    const progress = jobProgress({ id: 3, type: "restart", status: "running", phase });
    assert.equal(progress.step, index + 1);
    assert.equal(progress.steps, 4);
    assert.equal(progress.running, true);
    assert.equal(progress.phaseKey, `jobs.phase.${phase}`);
    assert.equal(progress.typeKey, "jobs.type.restart");
  });
  const starting = jobProgress({ id: 3, type: "restart", status: "running", phase: null });
  assert.deepEqual([starting.step, starting.phaseKey], [0, null]);
  const other = jobProgress({ id: 4, type: "update.apply", status: "failed", phase: "merge" });
  assert.deepEqual([other.step, other.steps, other.failed, other.running], [0, 0, true, false]);
  assert.equal(jobProgress({ id: 3, type: "restart", status: "done", phase: "ready" }).done, true);
  assert.equal(jobProgress(null), null);
});

test("restartFailureReason keeps the known reasons and reduces the rest to `failed`", async () => {
  const { restartFailureReason } = await load("dashboard-logic.mjs");
  const job = (reason) => ({ status: "failed", error: { code: "restart_failed", params: { reason } } });
  assert.equal(restartFailureReason(job("timeout")), "timeout");
  assert.equal(restartFailureReason(job("busy")), "busy");
  assert.equal(restartFailureReason(job("unavailable")), "unavailable");
  assert.equal(restartFailureReason(job("<script>")), "failed");
  assert.equal(restartFailureReason({ status: "failed", error: { code: "restart_failed" } }), "failed");
  assert.equal(restartFailureReason(null), "failed");
});

test("buildDashboardModel turns a DASH-1 object into the view model; null until a state arrived", async () => {
  const { buildDashboardModel } = await load("dashboard-logic.mjs");
  assert.equal(buildDashboardModel(null), null);
  assert.equal(buildDashboardModel({}), null);
  const state = {
    at: "2026-01-01T12:00:00.000Z",
    bot: { status: "qr", number: null, since: "2026-01-01T11:00:00.000Z", uptimeSec: 3725, version: "1.2.3", messagesProcessed: 42, lastActivity: null, registered: false },
    memory: { rss: 100, heapUsed: 50, heapTotal: 80, external: 4 },
    errors: [{ seq: 1, ts: "2026-01-01T11:59:00.000Z", name: "cmd", msg: "boom" }],
    restartPending: [],
    banners: [],
    db: "ok",
    maintenance: false,
    job: { id: 7, type: "restart", status: "running", phase: "start" },
  };
  const model = buildDashboardModel(state, { receivedAt: 1000, now: 4500 });
  assert.equal(model.status.group, "pairing");
  assert.equal(model.number, null);
  assert.equal(model.uptimeSec, 3728);
  assert.equal(model.version, "1.2.3");
  assert.equal(model.messagesProcessed, 42);
  assert.equal(model.registered, false);
  assert.equal(model.heapPercent, 63);
  assert.equal(model.errors.length, 1);
  assert.equal(model.job.step, 3);
  assert.deepEqual(model.restart, { disabled: true, reason: "job" });
  assert.equal(model.database, "ok");
  assert.equal(buildDashboardModel({ ...state, db: "unavailable" }).database, "unavailable");
});

test("the view exports its meta and a component, and every text it names exists in the fragment", async () => {
  const view = await load("dashboard.mjs");
  assert.deepEqual(view.meta, { area: "dashboard", titleKey: "dashboard.title", icon: "dashboard" });
  assert.equal(typeof view.default, "function");

  const fragment = JSON.parse(fs.readFileSync(path.join(ROOT, "specs", "002-admin-panel", "i18n", "panel-dashboard.json"), "utf8"));
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "lib", "admin", "public", "i18n", "en.json"), "utf8"));
  const known = (lang) => new Set([...Object.keys(fragment[lang]), ...Object.keys(base)]);
  // the families the view builds with a template string or a table
  const dynamic = [
    ...["rss", "heap_used", "heap_total", "external"].map((n) => `dashboard.memory_${n}`),
    ...["timeout", "busy", "unavailable", "failed"].map((n) => `dashboard.restart_reason_${n}`),
    ...["job", "restarting", "maintenance"].map((n) => `dashboard.restart_blocked_${n}`),
  ];
  for (const lang of ["en", "fr"]) for (const key of dynamic) assert.ok(known(lang).has(key), `${key} (${lang})`);
  assert.deepEqual(Object.keys(fragment.en).sort(), Object.keys(fragment.fr).sort());
});
