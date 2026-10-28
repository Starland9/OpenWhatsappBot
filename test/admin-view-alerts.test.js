"use strict";
/**
 * The alerts page, pure logic (lib/admin/public/js/views/alerts-logic.mjs, specs/002-admin-panel T204) plus its
 * translation fragments (panel-alerts.json, bot-alerts.json): the rows of the toggle table with the SET-1 versions,
 * the SET-2 body of a toggle, the merge of the answer, the badge tones, and the keys the view uses.
 *
 * No browser and no server: the module has no DOM access at import time.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const VIEWS = path.join(ROOT, "lib", "admin", "public", "js", "views");
const FRAGMENTS = path.join(ROOT, "specs", "002-admin-panel", "i18n");
const load = (file) => import(pathToFileURL(path.join(VIEWS, file)).href);
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(FRAGMENTS, file), "utf8"));

const ALR1 = {
  canDeliver: true,
  ownerCount: 1,
  types: [
    { type: "update_available", settingKey: "ALERT_UPDATE", enabled: true, lastSentAt: null, pending: 0 },
    { type: "reconnected", settingKey: "ALERT_RECONNECT", enabled: false, lastSentAt: "2026-03-01T08:00:00.000Z", pending: 2 },
  ],
  recent: [],
};
const SETTINGS = [
  { key: "PREFIX", version: 9 },
  { key: "ALERT_RECONNECT", version: 4, value: false },
  { key: "ALERT_UPDATE", version: 0, value: true },
  { key: "ALERT_NEW_ORIGIN", version: 7, value: true },
];

test("the six types come in the order of the contract, whatever the server sent, with their setting", async () => {
  const { ALERT_TYPES, buildRows } = await load("alerts-logic.mjs");
  assert.deepEqual(
    ALERT_TYPES.map(({ type, settingKey }) => [type, settingKey]),
    [
      ["reconnected", "ALERT_RECONNECT"],
      ["errors_series", "ALERT_ERROR_BURST"],
      ["key_refused", "ALERT_KEY_REFUSED"],
      ["login_blocked", "ALERT_LOGIN_BLOCKED"],
      ["new_origin", "ALERT_NEW_ORIGIN"],
      ["update_available", "ALERT_UPDATE"],
    ],
  );
  assert.deepEqual(buildRows(ALR1, SETTINGS).map((row) => row.type), ALERT_TYPES.map((x) => x.type));
});

test("the rows join ALR-1 with the SET-1 versions; a type the server omitted is shown enabled, with no version", async () => {
  const { buildRows } = await load("alerts-logic.mjs");
  const rows = Object.fromEntries(buildRows(ALR1, SETTINGS).map((row) => [row.type, row]));
  assert.deepEqual(rows.reconnected, {
    type: "reconnected",
    settingKey: "ALERT_RECONNECT",
    enabled: false,
    version: 4,
    lastSentAt: "2026-03-01T08:00:00.000Z",
    pending: 2,
  });
  assert.equal(rows.update_available.version, 0, "version 0 is a version");
  assert.equal(rows.new_origin.enabled, true);
  assert.equal(rows.new_origin.version, 7);
  assert.equal(rows.key_refused.version, null, "no ALERT_KEY_REFUSED in the settings answer");
  assert.equal(rows.key_refused.lastSentAt, null);
  assert.equal(rows.key_refused.pending, 0);
  // nothing loaded yet
  assert.equal(buildRows(null, null).length, 6);
});

test("a toggle answered by SET-2 wins over the loaded row until the next load", async () => {
  const { buildRows } = await load("alerts-logic.mjs");
  const rows = buildRows(ALR1, SETTINGS, { reconnected: { enabled: true, version: 5 } });
  const row = rows.find((r) => r.type === "reconnected");
  assert.equal(row.enabled, true);
  assert.equal(row.version, 5);
});

test("toggleBody is the SET-2 body for the ALERT_* key with its version; none without a version", async () => {
  const { buildRows, toggleBody } = await load("alerts-logic.mjs");
  const rows = Object.fromEntries(buildRows(ALR1, SETTINGS).map((row) => [row.type, row]));
  assert.deepEqual(toggleBody(rows.reconnected, true), { changes: [{ key: "ALERT_RECONNECT", op: "set", value: true, version: 4 }] });
  assert.deepEqual(toggleBody(rows.update_available, false), { changes: [{ key: "ALERT_UPDATE", op: "set", value: false, version: 0 }] });
  assert.equal(toggleBody(rows.key_refused, true), null);
  assert.equal(toggleBody(null, true), null);
});

test("patchFromAnswer reads the key's new value and version from the SET-2 answer", async () => {
  const { patchFromAnswer } = await load("alerts-logic.mjs");
  const answer = { settings: [{ key: "ALERT_RECONNECT", value: true, version: 5 }], restartPending: [] };
  assert.deepEqual(patchFromAnswer(answer, "ALERT_RECONNECT"), { enabled: true, version: 5 });
  assert.equal(patchFromAnswer(answer, "ALERT_UPDATE"), null);
  assert.equal(patchFromAnswer(null, "ALERT_UPDATE"), null);
  assert.deepEqual(patchFromAnswer({ settings: [{ key: "ALERT_UPDATE", value: false, version: 1 }] }, "ALERT_UPDATE"), { enabled: false, version: 1 });
});

test("versionsOf keeps only the ALERT_* settings that carry a version", async () => {
  const { versionsOf } = await load("alerts-logic.mjs");
  assert.deepEqual(versionsOf(SETTINGS), { ALERT_RECONNECT: 4, ALERT_UPDATE: 0, ALERT_NEW_ORIGIN: 7 });
  assert.deepEqual(versionsOf(undefined), {});
});

test("summarize counts the enabled types and the alerts waiting", async () => {
  const { buildRows, summarize } = await load("alerts-logic.mjs");
  assert.deepEqual(summarize(buildRows(ALR1, SETTINGS)), { total: 6, enabled: 5, pending: 2 });
  assert.deepEqual(summarize(null), { total: 0, enabled: 0, pending: 0 });
});

test("noRecipient is true only when the server says nobody can be reached", async () => {
  const { noRecipient } = await load("alerts-logic.mjs");
  assert.equal(noRecipient({ canDeliver: false, ownerCount: 0 }), true);
  assert.equal(noRecipient({ canDeliver: true, ownerCount: 1 }), false);
  assert.equal(noRecipient(null), false);
});

test("status badges: sent is ok, waiting warns, an undelivered alert is an error, an unknown one is neutral", async () => {
  const { statusTone, statusKey } = await load("alerts-logic.mjs");
  assert.deepEqual(["sent", "pending", "dropped", "expired", "?"].map(statusTone), ["ok", "warn", "danger", "neutral", "neutral"]);
  assert.equal(statusKey("sent"), "alerts.status_sent");
  assert.equal(statusKey("constructor"), null);
  assert.equal(statusKey("?"), null);
});

test("the view files load and keep the area contract", async () => {
  const view = await load("alerts.mjs");
  assert.deepEqual(view.meta, { area: "alerts", titleKey: "alerts.title", icon: "alerts" });
  assert.equal(typeof view.default, "function");
});

test("panel-alerts.json: same keys in both languages, same placeholders, every key the view uses", async () => {
  const fragment = readJson("panel-alerts.json");
  const keys = Object.keys(fragment.en);
  assert.deepEqual(keys.sort(), Object.keys(fragment.fr).sort());
  const names = (text) => (String(text).match(/\{[A-Za-z]+\}/g) || []).sort().join(",");
  for (const key of keys) {
    assert.equal(names(fragment.en[key]), names(fragment.fr[key]), key);
    assert.ok(fragment.en[key].trim() && fragment.fr[key].trim(), key);
  }

  // every literal t("alerts.*") of the view, and the keys built from a type or a status
  const { ALERT_TYPES, STATUS_TONES, typeKeys, statusKey } = await load("alerts-logic.mjs");
  const source = fs.readFileSync(path.join(VIEWS, "alerts.mjs"), "utf8");
  const used = new Set([...source.matchAll(/\bt\("(alerts\.[a-z_]+)"/g)].map((m) => m[1]));
  for (const { type } of ALERT_TYPES) {
    used.add(typeKeys(type).title);
    used.add(typeKeys(type).desc);
  }
  for (const status of Object.keys(STATUS_TONES)) used.add(statusKey(status));
  const existing = new Set(Object.keys(readJsonCatalog()));
  for (const key of used) {
    if (key === "alerts.title") continue; // already in the shell catalog
    assert.ok(keys.includes(key), `${key} is in panel-alerts.json`);
    assert.ok(existing.has("alerts.title"));
  }
  assert.ok(!keys.includes("alerts.title"), "alerts.title belongs to the shell catalog");
  // and nothing is defined for nothing
  for (const key of keys) assert.ok(used.has(key), `${key} is used by the view`);
});

function readJsonCatalog() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "lib", "admin", "public", "i18n", "en.json"), "utf8"));
}

test("bot-alerts.json: the six texts, same placeholders in both languages, none empty", () => {
  const fragment = readJson("bot-alerts.json");
  const expected = ["reconnected", "errors_series", "key_refused", "login_blocked", "new_origin", "update_available"].map((type) => `alerts.${type}`);
  assert.deepEqual(Object.keys(fragment.en).sort(), expected.sort());
  assert.deepEqual(Object.keys(fragment.fr).sort(), expected.sort());
  const slots = (text) => (String(text).match(/\{\d\}/g) || []).sort().join(",");
  for (const key of expected) {
    assert.equal(slots(fragment.en[key]), slots(fragment.fr[key]), key);
    assert.ok(fragment.en[key].trim() && fragment.fr[key].trim(), key);
    assert.match(fragment.en[key], /\{0\}/, `${key} names what happened`);
  }
});
