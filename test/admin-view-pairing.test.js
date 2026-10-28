"use strict";
/**
 * The pure logic of the pairing page (lib/admin/public/js/views/pairing-logic.mjs): phone sanitising, code
 * formatting, the countdowns, and which panel shows for each of the 8 client states. Plus the translation
 * fragment (specs/002-admin-panel/i18n/panel-pairing.json): every key the view uses exists in both languages.
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
const FRAGMENT = path.join(ROOT, "specs", "002-admin-panel", "i18n", "panel-pairing.json");
const load = (file) => import(pathToFileURL(path.join(VIEWS, file)).href);

const STATUSES = ["idle", "connecting", "qr", "open", "reconnecting", "restarting", "stopped", "logged_out"];

test("sanitizePhone drops spaces, +, dashes, dots and brackets, and nothing else", async () => {
  const { sanitizePhone } = await load("pairing-logic.mjs");
  assert.equal(sanitizePhone("+237 655 44 33 22"), "237655443322");
  assert.equal(sanitizePhone("  +1 (202) 555-0123 "), "12025550123");
  assert.equal(sanitizePhone("33.6.12.34.56.78"), "33612345678");
  assert.equal(sanitizePhone(" +33 6 12 34 56 78"), "33612345678", "a non-breaking space pasted from a contact card");
  assert.equal(sanitizePhone("12ab34"), "12ab34", "letters stay, so that the check can refuse them");
  assert.equal(sanitizePhone(""), "");
  assert.equal(sanitizePhone(null), "");
  assert.equal(sanitizePhone(undefined), "");
  assert.equal(sanitizePhone(33612345678), "33612345678");
});

test("validatePhone: 8 to 15 digits, with the field error the form shows", async () => {
  const { validatePhone, isValidPhone } = await load("pairing-logic.mjs");
  assert.deepEqual(validatePhone("+33 6 12 34 56 78"), { ok: true, phone: "33612345678", error: null });
  assert.equal(validatePhone("12345678").ok, true, "8 digits");
  assert.equal(validatePhone("123456789012345").ok, true, "15 digits");
  assert.deepEqual(validatePhone("1234567"), { ok: false, phone: "1234567", error: { code: "invalid_phone" } });
  assert.deepEqual(validatePhone("1234567890123456"), { ok: false, phone: "1234567890123456", error: { code: "invalid_phone" } });
  assert.deepEqual(validatePhone("06 12 AB 34 56"), { ok: false, phone: "0612AB3456", error: { code: "invalid_phone" } });
  assert.deepEqual(validatePhone(""), { ok: false, phone: "", error: { code: "required" } });
  assert.deepEqual(validatePhone(" + "), { ok: false, phone: "", error: { code: "required" } });
  assert.equal(isValidPhone("12345678"), true);
  assert.equal(isValidPhone("1234 5678"), false, "the check applies to the sanitised value");
  assert.equal(isValidPhone(undefined), false);
});

test("formatPairingCode shows XXXX-XXXX in capitals", async () => {
  const { formatPairingCode } = await load("pairing-logic.mjs");
  assert.equal(formatPairingCode("abcd1234"), "ABCD-1234");
  assert.equal(formatPairingCode("ABCD-1234"), "ABCD-1234");
  assert.equal(formatPairingCode(" abcd 1234 "), "ABCD-1234");
  assert.equal(formatPairingCode("A1B2C3D4"), "A1B2-C3D4");
  assert.equal(formatPairingCode("abc"), "ABC", "an unexpected shape is shown as received, in capitals");
  assert.equal(formatPairingCode("abcdefghij"), "ABCDEFGHIJ");
  assert.equal(formatPairingCode(null), "");
  assert.equal(formatPairingCode(undefined), "");
});

test("toMs, secondsLeft, formatCountdown and cooldownLeftMs", async () => {
  const { toMs, secondsLeft, formatCountdown, cooldownLeftMs } = await load("pairing-logic.mjs");
  const at = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(toMs("2026-01-01T12:00:00.000Z"), at);
  assert.equal(toMs(at), at);
  assert.equal(toMs(new Date(at)), at);
  assert.equal(toMs(null), null);
  assert.equal(toMs(""), null);
  assert.equal(toMs("not a date"), null);

  assert.equal(secondsLeft(at + 165000, at), 165);
  assert.equal(secondsLeft(at + 164001, at), 165, "rounded up: 0:00 is shown only when it is over");
  assert.equal(secondsLeft(at + 1, at), 1);
  assert.equal(secondsLeft(at, at), 0);
  assert.equal(secondsLeft(at - 5000, at), 0, "never negative");
  assert.equal(secondsLeft("2026-01-01T12:03:00.000Z", at), 180);
  assert.equal(secondsLeft(null, at), 0);

  assert.equal(formatCountdown(165), "2:45");
  assert.equal(formatCountdown(180), "3:00");
  assert.equal(formatCountdown(59), "0:59");
  assert.equal(formatCountdown(5), "0:05");
  assert.equal(formatCountdown(0), "0:00");
  assert.equal(formatCountdown(-3), "0:00");
  assert.equal(formatCountdown("x"), "0:00");

  assert.equal(cooldownLeftMs(at + 30000, at), 30000);
  assert.equal(cooldownLeftMs(at + 30000, at + 12500), 17500);
  assert.equal(cooldownLeftMs(at + 30000, at + 30000), 0);
  assert.equal(cooldownLeftMs(at + 30000, at + 99999), 0);
  assert.equal(cooldownLeftMs(0, at), 0);
  assert.equal(cooldownLeftMs(null, at), 0);
});

test("codeFromAnswer: the server's expiry when it is plausible, else three minutes from receipt", async () => {
  const { codeFromAnswer, CODE_COOLDOWN_MS, CODE_WINDOW_MS } = await load("pairing-logic.mjs");
  const at = Date.UTC(2026, 0, 1, 12, 0, 0);
  const iso = (ms) => new Date(ms).toISOString();

  const normal = codeFromAnswer({ code: "abcd1234", expiresAt: iso(at + 178000) }, at);
  assert.deepEqual(normal, { code: "ABCD-1234", deadline: at + 178000, cooldownUntil: at + CODE_COOLDOWN_MS });

  // a browser clock one hour ahead or behind the server must not show a fresh code as expired
  assert.equal(codeFromAnswer({ code: "ABCD-1234", expiresAt: iso(at - 3600000 + CODE_WINDOW_MS) }, at).deadline, at + CODE_WINDOW_MS);
  assert.equal(codeFromAnswer({ code: "ABCD-1234", expiresAt: iso(at + 3600000 + CODE_WINDOW_MS) }, at).deadline, at + CODE_WINDOW_MS);
  assert.equal(codeFromAnswer({ code: "ABCD-1234", expiresAt: iso(at - 1000) }, at).deadline, at + CODE_WINDOW_MS);
  assert.equal(codeFromAnswer({ code: "ABCD-1234" }, at).deadline, at + CODE_WINDOW_MS);
  assert.equal(codeFromAnswer({ code: "ABCD-1234", expiresAt: "garbage" }, at).deadline, at + CODE_WINDOW_MS);
  assert.equal(codeFromAnswer(null, at).code, "");
});

test("codeIsLive follows the deadline on the browser's clock", async () => {
  const { codeIsLive } = await load("pairing-logic.mjs");
  const at = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(codeIsLive(null, at), false);
  assert.equal(codeIsLive({ code: "ABCD-1234", deadline: at + 1000 }, at), true);
  assert.equal(codeIsLive({ code: "ABCD-1234", deadline: at }, at), false);
  assert.equal(codeIsLive({ code: "ABCD-1234", deadline: at - 1 }, at), false);
});

test("panelFor: which panel shows for each of the 8 client states, paired or not", async () => {
  const { panelFor, PAIRING_STATUSES, STATE_KEYS } = await load("pairing-logic.mjs");
  assert.deepEqual(PAIRING_STATUSES, STATUSES);
  assert.deepEqual(Object.keys(STATE_KEYS).sort(), [...STATUSES].sort());

  const row = (kind, showQr, showCodeForm, logoutAction, statusKey = null) => ({ kind, showQr, showCodeForm, logoutAction, statusKey });
  const expected = {
    // status: [not registered, registered]
    idle: [row("waiting", false, false, null, "pairing.state_idle"), row("waiting", false, false, "logout", "pairing.state_idle")],
    connecting: [row("pairing", true, true, null), row("waiting", false, false, "logout", "pairing.state_connecting")],
    qr: [row("pairing", true, true, null), row("waiting", false, false, "logout", "pairing.state_qr")],
    open: [row("connected", false, false, "logout"), row("connected", false, false, "logout")],
    reconnecting: [row("waiting", false, false, null, "pairing.state_reconnecting"), row("waiting", false, false, "logout", "pairing.state_reconnecting")],
    restarting: [row("waiting", false, false, null, "pairing.state_restarting"), row("waiting", false, false, null, "pairing.state_restarting")],
    stopped: [row("waiting", false, false, null, "pairing.state_stopped"), row("waiting", false, false, "logout", "pairing.state_stopped")],
    logged_out: [row("logged_out", false, false, "repair", "pairing.state_logged_out"), row("logged_out", false, false, "repair", "pairing.state_logged_out")],
  };
  for (const status of STATUSES) {
    assert.deepEqual(panelFor({ status, registered: false }), expected[status][0], `${status}, not registered`);
    assert.deepEqual(panelFor({ status, registered: true }), expected[status][1], `${status}, registered`);
  }
});

test("panelFor: an unknown status or no view at all is the idle panel", async () => {
  const { panelFor } = await load("pairing-logic.mjs");
  assert.equal(panelFor({ status: "exploding", registered: false }).statusKey, "pairing.state_idle");
  assert.equal(panelFor(null).kind, "waiting");
  assert.equal(panelFor(undefined).showCodeForm, false);
  assert.equal(panelFor({}).kind, "waiting");
});

test("the QR code and the number form show together, only while pairing is possible", async () => {
  const { panelFor, PAIRING_STATUSES } = await load("pairing-logic.mjs");
  for (const status of PAIRING_STATUSES) {
    for (const registered of [false, true]) {
      const panel = panelFor({ status, registered });
      assert.equal(panel.showQr, panel.showCodeForm, `${status}/${registered}`);
      assert.equal(panel.showCodeForm, !registered && (status === "connecting" || status === "qr"), `${status}/${registered}`);
      assert.ok(!(panel.logoutAction === "logout" && !registered && status !== "open"), "nothing to disconnect when nothing is paired");
    }
  }
});

test("normalizePairing completes a PAIR-1 answer or a live event and keeps the last cooldown", async () => {
  const { normalizePairing } = await load("pairing-logic.mjs");
  const first = normalizePairing({
    status: "qr",
    registered: false,
    number: null,
    qr: { version: 3, issuedAt: "2026-01-01T12:00:00.000Z" },
    code: null,
    codeCooldownMs: 12000,
  });
  assert.deepEqual(first, { status: "qr", registered: false, number: null, qr: { version: 3, issuedAt: "2026-01-01T12:00:00.000Z" }, code: null, codeCooldownMs: 12000 });

  // a live event has no cooldown: the previous one is kept
  const live = normalizePairing({ status: "open", registered: true, number: "+237 655-44", qr: null, code: { pending: true, expiresAt: "2026-01-01T12:03:00.000Z" } }, first);
  assert.equal(live.codeCooldownMs, 12000);
  assert.equal(live.number, "23765544", "digits only");
  assert.deepEqual(live.code, { pending: true, expiresAt: "2026-01-01T12:03:00.000Z" });

  assert.deepEqual(normalizePairing(null), { status: "idle", registered: false, number: null, qr: null, code: null, codeCooldownMs: 0 });
  assert.equal(normalizePairing({ status: "weird" }).status, "idle");
  assert.equal(normalizePairing({ qr: { version: 0 } }).qr.version, 0, "version 0 is a version");
  assert.equal(normalizePairing({ qr: {} }).qr, null);
});

test("qrSource addresses PAIR-2 by the QR version (a new picture per renewal)", async () => {
  const { qrSource } = await load("pairing-logic.mjs");
  assert.equal(qrSource({ qr: { version: 3 } }), "/admin/api/pairing/qr.svg?v=3");
  assert.equal(qrSource({ qr: { version: 4 } }), "/admin/api/pairing/qr.svg?v=4");
  assert.equal(qrSource({ qr: null }), null);
  assert.equal(qrSource(null), null);
});

test("the view modules import in Node without a DOM and declare their area", async () => {
  const view = await load("pairing.mjs");
  assert.equal(typeof view.default, "function");
  assert.deepEqual(view.meta, { area: "pairing", titleKey: "pairing.title", icon: "pairing" });
});

test("the translation fragment: same keys in en and fr, same placeholders, and every key the view uses", async () => {
  const fragment = JSON.parse(fs.readFileSync(FRAGMENT, "utf8"));
  const { en, fr } = fragment;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(fr).sort(), "identical key sets");
  const placeholders = (text) => [...String(text).matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]).sort().join(",");
  for (const key of Object.keys(en)) {
    assert.ok(typeof en[key] === "string" && en[key].trim() && typeof fr[key] === "string" && fr[key].trim(), key);
    assert.equal(placeholders(en[key]), placeholders(fr[key]), `${key}: placeholders`);
    assert.match(key, /^pairing\.[a-z0-9_]+$/, "flat keys of the area");
  }
  assert.ok(!("pairing.title" in en), "pairing.title already exists in the catalog");

  // every pairing.* key written in the view files is defined (here, or in the merged catalog for pairing.title)
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "lib", "admin", "public", "i18n", "en.json"), "utf8"));
  const used = new Set();
  for (const file of fs.readdirSync(VIEWS).filter((f) => /^pairing.*\.mjs$/.test(f))) {
    for (const match of fs.readFileSync(path.join(VIEWS, file), "utf8").matchAll(/["'`](pairing\.[a-z0-9_]+)["'`]/g)) used.add(match[1]);
  }
  assert.ok(used.size > 20, "the scan found the keys");
  const missing = [...used].filter((key) => !(key in en) && !(key in catalog));
  assert.deepEqual(missing, [], "keys used by the view and defined nowhere");
  const unused = Object.keys(en).filter((key) => !used.has(key));
  assert.deepEqual(unused, [], "keys of the fragment that no view file uses");
});

test("the French texts carry accents and no leftover English markers", () => {
  const { fr } = JSON.parse(fs.readFileSync(FRAGMENT, "utf8"));
  const joined = Object.values(fr).join(" ");
  assert.match(joined, /é/);
  assert.match(joined, /Appareils connectés/);
  for (const text of Object.values(fr)) assert.ok(!/\bthe\b/i.test(text), text);
});
