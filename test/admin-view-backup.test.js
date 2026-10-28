"use strict";
/**
 * The backup page (T175, FR-051 to FR-053; views/backup-logic.mjs, backup*.mjs, panel-backup.json).
 *
 *  - the passphrase rule counts code points of the NFKC form, like the server; the bodies sent to BAK-1;
 *  - the BAK-2 summary shaped into groups and counts (absent data types, ignored data);
 *  - the 422 codes mapped to the page's own messages, with the parameters the server derived;
 *  - the restore job read as a list of phases (running, failed, done) and the warnings of a finished restore;
 *  - the fragment panel-backup.json: same keys and placeholders in both languages, every key the page can ask for;
 *  - the page rendered in a fake DOM with a scripted server: export validation, upload with progress, the summary
 *    before the confirmation, the confirmation dialog, the restore job, the refusals, the safety copies.
 *
 * No browser and no server: the logic module has no DOM access at import time.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ lang: "fr" });

const { createDom, importPublic } = require("./helpers/fakeDom");
const format = require("../lib/admin/backup/format");

const ROOT = path.resolve(__dirname, "..");
const VIEWS = path.join(ROOT, "lib", "admin", "public", "js", "views");
const FRAGMENT = path.join(ROOT, "specs", "002-admin-panel", "i18n", "panel-backup.json");
const load = (file) => import(pathToFileURL(path.join(VIEWS, file)).href);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const placeholdersOf = (text) => (String(text).match(/\{[A-Za-z0-9_]+\}/g) || []).sort().join(",");

let logic;
before(async () => {
  logic = await load("backup-logic.mjs");
});

describe("the passphrase", () => {
  test("its length is counted in code points of the NFKC form, like the server does", () => {
    assert.equal(logic.passphraseLength("abc"), 3);
    assert.equal(logic.passphraseLength("😀".repeat(12)), 12, "an emoji is one code point, not two UTF-16 units");
    assert.equal(logic.passphraseLength("é".repeat(12)), 12, "e + combining accent is one character after NFKC");
    assert.equal(logic.passphraseLength("ＡＢＣ"), 3, "full-width letters stay three");
    assert.equal(logic.passphraseLength("ﬁﬁ"), 4, "NFKC expands the ligature: two characters become four");
    assert.equal(logic.passphraseLength(undefined), 0);
    assert.equal(logic.passphraseLength(null), 0);
  });

  test("12 to 256 characters; the repeat must match; the errors are field codes the catalog translates", () => {
    assert.deepEqual(logic.checkPassphrase("short"), { code: "too_short", params: { min: 12 } });
    assert.deepEqual(logic.checkPassphrase("😀".repeat(11)), { code: "too_short", params: { min: 12 } });
    assert.equal(logic.checkPassphrase("😀".repeat(12)), null);
    assert.equal(logic.checkPassphrase("a".repeat(256)), null);
    assert.deepEqual(logic.checkPassphrase("a".repeat(257)), { code: "too_long", params: { max: 256 } });
    assert.equal(logic.checkPassphrase("twelve chars", { repeat: "twelve chars" }), null);
    assert.deepEqual(logic.checkPassphrase("twelve chars", { repeat: "twelve charz" }), { code: "mismatch" });
    assert.equal(logic.checkPassphrase("café café café", { repeat: "café café café" }), null, "the same text, composed or not");
    // length first: a short passphrase is reported as short, whatever the repeat says
    assert.equal(logic.checkPassphrase("short", { repeat: "other" }).code, "too_short");
    assert.equal(logic.PASSPHRASE_MIN, format.codePoints("x".repeat(12)));
  });
});

describe("what is sent", () => {
  test("BAK-1: the session is asked for only after the takeover warning was confirmed", () => {
    assert.deepEqual(logic.exportBody({ passphrase: "p" }), { passphrase: "p" });
    assert.deepEqual(logic.exportBody({ passphrase: "p", includeSession: false, sessionConfirmed: true }), { passphrase: "p" }, "confirmation alone adds nothing");
    assert.deepEqual(logic.exportBody({ passphrase: "p", includeSession: true }), { passphrase: "p", includeSession: true, confirmSession: false });
    assert.deepEqual(logic.exportBody({ passphrase: "p", includeSession: true, sessionConfirmed: true }), { passphrase: "p", includeSession: true, confirmSession: true });
  });

  test("the fallback file name is the one the server builds", () => {
    assert.equal(logic.fallbackFileName(new Date(Date.UTC(2026, 11, 31, 23, 5, 9))), "openwabot-backup-20261231-230509.owb");
    assert.match(logic.fallbackFileName(), /^openwabot-backup-\d{8}-\d{6}\.owb$/);
  });

  test("the check cannot start without a file, with an empty file or without a passphrase", () => {
    assert.equal(logic.inspectBlocker({ file: null, passphrase: "x" }), "no_file");
    assert.equal(logic.inspectBlocker({ file: { size: 0 }, passphrase: "x" }), "empty_file");
    assert.equal(logic.inspectBlocker({ file: { size: 10 }, passphrase: "" }), "passphrase_required");
    assert.equal(logic.inspectBlocker({ file: { size: 10 }, passphrase: "x" }), null);
  });
});

describe("the summary table", () => {
  const SUMMARY = {
    format: 1,
    createdAt: "2026-03-01T08:00:00.000Z",
    botVersion: "1.4.0",
    dialect: "sqlite",
    includesSession: true,
    counts: { Group: 2, GroupEconomy: 0, Quote: 5, SettingOverride: 4, Broadcast: 1 },
    ignoredModels: [{ model: "FutureModel", rows: 3 }],
    ignoredColumns: [{ model: "Group", column: "legacy", rows: 2 }],
    ignoredSettings: 1,
    ignoredTexts: 0,
  };

  test("the 25 models of the page are the 25 the engine exports, in the same order", () => {
    assert.deepEqual(logic.ALL_MODELS, [...format.MODELS]);
  });

  test("counts per group and model, in the order of the page; empty groups are left out", () => {
    const model = logic.shapeSummary(SUMMARY);
    assert.deepEqual(
      model.groups.map((group) => [group.id, group.total, group.rows.map((row) => row.model)]),
      [
        ["groups", 2, ["Group", "GroupEconomy"]],
        ["features", 5, ["Quote"]],
        ["config", 4, ["SettingOverride"]],
        ["jobs", 1, ["Broadcast"]],
      ],
    );
    assert.equal(model.total, 12);
    assert.equal(model.groups[0].titleKey, "backup.group_groups");
    assert.deepEqual(model.groups[0].rows[0], { model: "Group", labelKey: "backup.model_Group", count: 2 });
    assert.equal(model.groups[0].rows[1].count, 0, "a model present and empty is shown with 0");
  });

  test("a data type the file does not hold is listed as absent: a restore empties it", () => {
    const model = logic.shapeSummary(SUMMARY);
    assert.equal(model.absent.length, 25 - 5);
    assert.ok(model.absent.includes("Warn") && !model.absent.includes("Group"));
    assert.deepEqual(logic.shapeSummary({ ...SUMMARY, counts: {} }).groups, []);
  });

  test("header fields and what was ignored", () => {
    const model = logic.shapeSummary(SUMMARY);
    assert.deepEqual([model.createdAt, model.botVersion, model.dialect, model.includesSession], ["2026-03-01T08:00:00.000Z", "1.4.0", "sqlite", true]);
    assert.deepEqual(model.ignored, {
      models: [{ model: "FutureModel", rows: 3 }],
      columns: [{ model: "Group", column: "legacy", rows: 2 }],
      settings: 1,
      texts: 0,
    });
    assert.equal(model.hasIgnored, true);
    assert.equal(logic.shapeSummary({ ...SUMMARY, ignoredModels: [], ignoredColumns: [], ignoredSettings: 0 }).hasIgnored, false);
    assert.equal(logic.shapeSummary(null), null);
    assert.equal(logic.shapeSummary("nope"), null);
    // garbage counts are not trusted
    const odd = logic.shapeSummary({ counts: { Group: -4, Quote: "x", Task: 7.9 } });
    assert.deepEqual(odd.groups.flatMap((g) => g.rows.map((r) => [r.model, r.count])), [["Task", 7]]);
  });

  test("the time left on the token", () => {
    const at = Date.UTC(2026, 5, 1, 10, 0, 0);
    assert.equal(logic.tokenRemainingMs(new Date(at + 90_000).toISOString(), at), 90_000);
    assert.equal(logic.tokenRemainingMs(new Date(at).toISOString(), at), 0);
    assert.equal(logic.tokenRemainingMs(new Date(at - 5).toISOString(), at), 0);
    assert.equal(logic.tokenRemainingMs("garbage", at), 0);
  });
});

describe("refusals", () => {
  const ERRORS = JSON.parse(fs.readFileSync(path.join(ROOT, "lib", "admin", "public", "i18n", "en.json"), "utf8"));

  test("every 422 code of BAK-2 has its own message, with the parameters the server derived", () => {
    assert.deepEqual(logic.refusalFor({ code: "wrong_passphrase" }), { key: "backup.refusal_wrong_passphrase", params: {} });
    assert.deepEqual(logic.refusalFor({ code: "backup_corrupted" }), { key: "backup.refusal_backup_corrupted", params: {} });
    assert.deepEqual(logic.refusalFor({ code: "backup_unsupported_format" }), { key: "backup.refusal_backup_unsupported_format", params: {} });
    assert.deepEqual(logic.refusalFor({ code: "backup_too_new", params: { backupVersion: "2.0.0", currentVersion: "1.4.0" } }), {
      key: "backup.refusal_backup_too_new",
      params: { backupVersion: "2.0.0", currentVersion: "1.4.0" },
    });
    assert.deepEqual(logic.refusalFor({ code: "backup_invalid_row", params: { model: "Group", index: 1, field: "mute" } }), {
      key: "backup.refusal_backup_invalid_row",
      params: { model: "Group", index: 2, field: "mute" },
    }, "the position is shown counting from 1");
    assert.deepEqual(logic.refusalFor({ code: "payload_too_large", params: { maxBytes: 1000 } }).params, { maxBytes: 1000 });
  });

  test("a code the page does not word itself falls back to the generic message; nothing else is copied", () => {
    assert.equal(logic.refusalFor({ code: "internal_error" }), null);
    assert.equal(logic.refusalFor({ code: "validation_failed" }), null);
    assert.equal(logic.refusalFor(null), null);
    assert.equal(logic.refusalFor(new Error("x")), null);
    const leaked = logic.refusalFor({ code: "backup_invalid_row", params: { model: "Group", index: 0, field: "x", value: "SECRET" } });
    assert.ok(!JSON.stringify(leaked).includes("SECRET"));
  });

  test("a wrong passphrase leaves the file for another try; a damaged file does not", () => {
    for (const code of ["wrong_passphrase", "rate_limited", "busy"]) assert.equal(logic.canRetryWithSameFile({ code }), true, code);
    for (const code of ["backup_corrupted", "backup_too_new", "not_found", "backup_invalid_row"]) assert.equal(logic.canRetryWithSameFile({ code }), false, code);
    assert.equal(logic.canRetryWithSameFile(null), false);
  });

  test("every code the page words has a message in both languages; the generic catalog covers the same codes", () => {
    const fragment = readJson(FRAGMENT);
    for (const lang of ["en", "fr"]) {
      for (const code of logic.REFUSAL_CODES) assert.ok(fragment[lang][`backup.refusal_${code}`], `${lang}: backup.refusal_${code}`);
    }
    for (const code of logic.REFUSAL_CODES) assert.ok(ERRORS[`errors.${code}`], `errors.${code} exists for the fallback`);
  });
});

describe("the restore job", () => {
  test("running: the phases before the current one are done", () => {
    const progress = logic.restoreProgress({ id: 7, type: "restore", status: "running", phase: "database" });
    assert.deepEqual(progress.stepList.map((s) => [s.phase, s.state]), [
      ["maintenance", "done"],
      ["pre_backup", "done"],
      ["database", "current"],
      ["session", "todo"],
      ["finalize", "todo"],
      ["restarting", "todo"],
    ]);
    assert.deepEqual([progress.running, progress.done, progress.failed, progress.step, progress.steps], [true, false, false, 3, 6]);
    assert.equal(progress.phaseKey, "jobs.phase.database");
    assert.equal(progress.stepList[0].labelKey, "jobs.phase.maintenance");
    assert.deepEqual(logic.RESTORE_PHASES, ["maintenance", "pre_backup", "database", "session", "finalize", "restarting"]);
  });

  test("done: every phase is done and the result is kept", () => {
    const result = { ok: true, preRestoreFile: "pre-restore-1.owb", warnings: ["restart_timeout"] };
    const progress = logic.restoreProgress({ id: 7, type: "restore", status: "done", phase: "restarting", result });
    assert.ok(progress.stepList.every((s) => s.state === "done"));
    assert.deepEqual([progress.done, progress.step], [true, 6]);
    assert.equal(progress.result.preRestoreFile, "pre-restore-1.owb");
  });

  test("failed: the failing phase and the reason come from error.params", () => {
    const progress = logic.restoreProgress({ id: 7, type: "restore", status: "failed", phase: "database", error: { code: "restore_failed", params: { phase: "database", reason: "file_altered" } } });
    assert.equal(progress.failed, true);
    assert.equal(progress.failedPhase, "database");
    assert.equal(progress.reason, "file_altered");
    assert.deepEqual(progress.stepList.map((s) => s.state), ["done", "done", "failed", "todo", "todo", "todo"]);
    const unknown = logic.restoreProgress({ id: 8, status: "failed", error: { code: "restore_failed", params: { phase: "mystery" } } });
    assert.equal(unknown.failedPhase, null);
    assert.equal(logic.restoreProgress(null), null);
  });

  test("only the known warnings are shown", () => {
    assert.deepEqual(logic.restoreWarnings({ warnings: ["session_not_swapped", "restart_timeout", "whatever", "reload_failed"] }), ["session_not_swapped", "restart_timeout", "reload_failed"]);
    assert.deepEqual(logic.restoreWarnings(null), []);
    assert.deepEqual(logic.restoreWarnings({}), []);
  });
});

describe("the safety copies", () => {
  test("newest first; only names of the right shape; the path is the BAK-5 route", () => {
    const rows = logic.storedRows([
      { name: "pre-restore-20260101-000000-000.owb", kind: "pre-restore", size: 10, createdAt: "2026-01-01T00:00:00.000Z" },
      { name: "pre-restore-20260301-000000-000.owb", kind: "pre-restore", size: 30, createdAt: "2026-03-01T00:00:00.000Z" },
      { name: "../evil.owb", size: 1, createdAt: "2026-04-01T00:00:00.000Z" },
      { name: "restore.lock", size: 1, createdAt: "2026-04-01T00:00:00.000Z" },
      null,
    ]);
    assert.deepEqual(rows.map((r) => r.name), ["pre-restore-20260301-000000-000.owb", "pre-restore-20260101-000000-000.owb"]);
    assert.equal(rows[0].path, "/admin/api/backup/stored/pre-restore-20260301-000000-000.owb");
    assert.equal(rows[0].size, 30);
    assert.deepEqual(logic.storedRows(undefined), []);
  });
});

describe("panel-backup.json", () => {
  const fragment = readJson(FRAGMENT);

  test("same keys and placeholders in both languages, no empty text, nothing defined twice with another text", () => {
    assert.deepEqual(Object.keys(fragment).sort(), ["en", "fr"]);
    assert.deepEqual(Object.keys(fragment.en).sort(), Object.keys(fragment.fr).sort());
    // once the fragment is merged (W2-A) its keys are in the catalog with the same text; what must never happen is a
    // key that another area defined with a different text (the merge would silently replace it)
    const catalog = readJson(path.join(ROOT, "lib", "admin", "public", "i18n", "en.json"));
    for (const [key, text] of Object.entries(fragment.en)) {
      assert.ok(typeof text === "string" && text.trim() && fragment.fr[key].trim(), key);
      assert.equal(placeholdersOf(text), placeholdersOf(fragment.fr[key]), `${key}: placeholders`);
      assert.ok(key.startsWith("backup."), key);
      assert.ok(!(key in catalog) || catalog[key] === text, `${key} would be defined twice`);
    }
    assert.ok(Object.keys(fragment.en).length > 100);
  });

  test("every key the page can ask for at run time is there", () => {
    const wanted = [
      ...logic.ALL_MODELS.map((m) => `backup.model_${m}`),
      ...logic.MODEL_GROUPS.map((g) => `backup.group_${g.id}`),
      ...["done", "current", "todo", "failed"].map((s) => `backup.phase_state_${s}`),
      ...["no_file", "empty_file", "passphrase_required"].map((b) => `backup.blocker_${b}`),
      ...["session_not_swapped", "reload_failed", "media_not_restored", "status_not_restored", "restart"].map((w) => `backup.warning_${w}`),
      ...["file_altered", "secret_storage_unavailable", "busy", "other"].map((r) => `backup.failed_reason_${r}`),
      ...logic.REFUSAL_CODES.map((c) => `backup.refusal_${c}`),
    ];
    const catalog = readJson(path.join(ROOT, "lib", "admin", "public", "i18n", "en.json"));
    for (const key of wanted) assert.ok(key in fragment.en && key in fragment.fr, key);
    for (const phase of logic.RESTORE_PHASES) assert.ok(catalog[`jobs.phase.${phase}`], `jobs.phase.${phase}`);
    for (const code of ["too_short", "too_long", "mismatch"]) assert.ok(catalog[`fields.${code}`], `fields.${code}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("the page renders and works", () => {
  let dom;
  let ui;
  let htmlTag;
  let view;
  let requests;
  let routes;
  let uploads;
  let xhr;

  const answer = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? headers[String(name).toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
    blob: async () => new Blob([JSON.stringify(body)]),
  });
  const refusal = (status, code, params) => answer(status, { error: { code, params } });

  const SUMMARY = {
    format: 1,
    createdAt: "2026-03-01T08:00:00.000Z",
    botVersion: "1.4.0",
    dialect: "postgres",
    includesSession: false,
    counts: { Group: 3, Quote: 5 },
    ignoredModels: [],
    ignoredColumns: [{ model: "Group", column: "legacy", rows: 3 }],
    ignoredSettings: 0,
    ignoredTexts: 0,
  };
  const INSPECTED = { restoreToken: "tok-1", expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), summary: SUMMARY };

  before(async () => {
    dom = await createDom();
    const i18n = await importPublic("js/i18n.mjs");
    const fragment = readJson(FRAGMENT);
    for (const lang of ["en", "fr"]) {
      i18n.setCatalog(lang, { ...readJson(path.join(ROOT, "lib", "admin", "public", "i18n", `${lang}.json`)), ...fragment[lang] });
    }
    await i18n.setLanguage("en", { remember: false });
    ui = await importPublic("js/ui.mjs");
    htmlTag = (await importPublic("js/components/html.mjs")).html;
    view = await importPublic("js/views/backup.mjs");
    // the download goes through a Blob and an <a download>: give the fake document what it needs
    dom.document.body = { append() {} };
    const original = dom.document.createElement;
    dom.document.createElement = (name) => {
      const el = original(name);
      if (name === "a") {
        el.click = () => (globalThis.__saved = { href: el.href, download: el.download });
        el.remove = () => {};
      }
      return el;
    };
    globalThis.XMLHttpRequest = class {
      constructor() {
        this.upload = {};
        this.headers = {};
        xhr = this;
      }
      open(method, url) {
        this.method = method;
        this.url = url;
      }
      setRequestHeader(name, value) {
        this.headers[name] = value;
      }
      send(body) {
        uploads.push({ url: this.url, body, headers: this.headers });
        setTimeout(() => {
          this.upload.onprogress && this.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 });
          const result = routes["PUT /admin/api/uploads"]();
          this.status = result.status;
          this.responseText = result.body;
          this.getResponseHeader = () => null;
          this.onload();
        }, 0);
      }
    };
  });

  after(() => {
    dom.restore();
    delete globalThis.fetch;
    delete globalThis.XMLHttpRequest;
    delete globalThis.__saved;
  });

  async function open(script = {}) {
    requests = [];
    uploads = [];
    delete globalThis.__saved;
    routes = {
      "GET /admin/api/backup/stored": () => answer(200, { items: [] }),
      "PUT /admin/api/uploads": () => ({ status: 201, body: JSON.stringify({ uploadId: "u".repeat(32), purpose: "backup", kind: "backup", size: 10 }) }),
      ...script,
    };
    globalThis.fetch = async (url, init) => {
      const [route, search] = url.split("?");
      const key = `${init.method} ${route}`;
      const body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ key, body, search: search || "" });
      if (!routes[key]) throw new Error(`unexpected request ${key}`);
      return routes[key](body);
    };
    const root = dom.mount(htmlTag`<${view.default} route=${{ rest: [] }} />`);
    await dom.settle(10);
    return root;
  }

  const button = (root, text) => dom.byText(root, text, "button")[0];
  const input = (root, name) => dom.byAttr(root, "name", name, "input")[0];
  const submit = (root, name) => {
    const form = dom.find(root, (el) => el.localName === "form" && dom.byAttr(el, "name", name, "input").length)[0];
    dom.fire(form, "submit");
  };
  const pick = async (root, size = 1234) => {
    const el = input(root, "backup_file");
    el.files = [{ name: "my-backup.owb", size }];
    dom.fire(el, "change");
    await dom.settle();
  };
  // a handler closes over the state of its last render: let Preact render between two gestures
  const fill = async (root, name, value) => {
    dom.type(input(root, name), value);
    await dom.settle();
  };

  test("the explanation, the three sections and the empty list of safety copies", async () => {
    const root = await open();
    const text = dom.text(root);
    assert.ok(text.includes("Backup and restore"));
    assert.ok(text.includes("What a backup contains") && text.includes("Never included"));
    assert.ok(text.includes("Export a backup") && text.includes("Restore a backup") && text.includes("Safety copies made before a restore"));
    assert.ok(text.includes("Do not restore the same file on two installations"));
    assert.ok(text.includes("No safety copy yet."));
    dom.unmount(root);
  });

  test("export: the passphrase rule is shown, nothing is sent while it is not met, the repeat must match", async () => {
    const root = await open();
    await fill(root, "passphrase", "short");
    await fill(root, "passphrase_repeat", "short");
    submit(root, "passphrase");
    await dom.settle();
    assert.ok(dom.text(root).includes("Too short (at least 12 characters)."));
    assert.equal(requests.filter((r) => r.key.startsWith("POST")).length, 0);

    await fill(root, "passphrase", "a long enough phrase");
    await fill(root, "passphrase_repeat", "another long phrase!");
    submit(root, "passphrase");
    await dom.settle();
    assert.equal(requests.filter((r) => r.key.startsWith("POST")).length, 0);
    assert.ok(dom.text(root).includes("The two entries are different."), "the repeat field says so");
    dom.unmount(root);
  });

  test("export: a valid passphrase posts to BAK-1 and the file is saved under the name the server gave", async () => {
    const root = await open({
      "POST /admin/api/backup/export": () => answer(200, { binary: true }, { "Content-Disposition": 'attachment; filename="openwabot-backup-20260301-080000.owb"' }),
    });
    await fill(root, "passphrase", "a long enough phrase");
    await fill(root, "passphrase_repeat", "a long enough phrase");
    submit(root, "passphrase");
    await dom.settle(12);
    const post = requests.find((r) => r.key === "POST /admin/api/backup/export");
    assert.deepEqual(post.body, { passphrase: "a long enough phrase" });
    assert.ok(dom.text(root).includes("openwabot-backup-20260301-080000.owb"));
    assert.equal(globalThis.__saved.download, "openwabot-backup-20260301-080000.owb");
    assert.equal(input(root, "passphrase").value, "", "the passphrase leaves the page once the file is made");
    dom.unmount(root);
  });

  test("export with the session: the takeover warning is shown, confirmed, then confirmSession travels with the request", async () => {
    const root = await open({ "POST /admin/api/backup/export": () => answer(200, {}, { "Content-Disposition": 'attachment; filename="x.owb"' }) });
    dom.check(input(root, "include_session"), true);
    await dom.settle();
    await dom.settle();
    assert.ok(dom.text(root).includes("take over the WhatsApp number of the bot"));
    await fill(root, "passphrase", "a long enough phrase");
    await fill(root, "passphrase_repeat", "a long enough phrase");
    submit(root, "passphrase");
    await dom.settle();
    assert.equal(requests.filter((r) => r.key.startsWith("POST")).length, 0, "waiting for the confirmation");
    const asked = ui.confirmStore.get().request;
    assert.ok(asked, "the confirmation dialog is open");
    assert.ok(asked.message.includes("taking over the WhatsApp number"));
    ui.resolveConfirm(true);
    await dom.settle(12);
    assert.deepEqual(requests.find((r) => r.key === "POST /admin/api/backup/export").body, {
      passphrase: "a long enough phrase",
      includeSession: true,
      confirmSession: true,
    });
    dom.unmount(root);
  });

  test("export with the session, then 'cancel' in the dialog: nothing is sent", async () => {
    const root = await open();
    dom.check(input(root, "include_session"), true);
    await dom.settle();
    await fill(root, "passphrase", "a long enough phrase");
    await fill(root, "passphrase_repeat", "a long enough phrase");
    submit(root, "passphrase");
    await dom.settle();
    ui.resolveConfirm(false);
    await dom.settle();
    assert.equal(requests.filter((r) => r.key.startsWith("POST")).length, 0);
    dom.unmount(root);
  });

  test("restore: the file is sent with progress, the summary is shown before anything is confirmed", async () => {
    const root = await open({ "POST /admin/api/backup/inspect": () => answer(200, INSPECTED) });
    submit(root, "restore_passphrase");
    await dom.settle();
    assert.ok(dom.text(root).includes("Choose a backup file first."));

    await pick(root);
    submit(root, "restore_passphrase");
    await dom.settle();
    assert.ok(dom.text(root).includes("Enter the passphrase of the file."));

    await fill(root, "restore_passphrase", "the file passphrase");
    submit(root, "restore_passphrase");
    await dom.settle(12);
    assert.equal(uploads.length, 1);
    assert.match(uploads[0].url, /^\/admin\/api\/uploads\?purpose=backup&name=my-backup\.owb$/);
    assert.equal(uploads[0].headers["Content-Type"], "application/octet-stream");
    assert.deepEqual(requests.find((r) => r.key === "POST /admin/api/backup/inspect").body, { uploadId: "u".repeat(32), passphrase: "the file passphrase" });

    const text = dom.text(root);
    assert.ok(text.includes("What this backup contains"));
    assert.ok(text.includes("1.4.0") && text.includes("postgres"));
    assert.ok(text.includes("Group settings") && text.includes("Quotes"));
    assert.ok(text.includes("8 records in 2 data types."));
    assert.ok(text.includes("are not in this file, so they will be emptied"), "the data types the file lacks");
    assert.ok(text.includes("Column legacy of Group no longer exists (3 rows)."));
    assert.ok(text.includes("Not included: the current one is kept"));
    assert.ok(text.includes("Restoring replaces ALL the data"));
    assert.equal(requests.filter((r) => r.key === "POST /admin/api/backup/restore").length, 0, "nothing is applied before the confirmation");
    dom.unmount(root);
  });

  test("restore: the confirmation dialog, then BAK-3 with confirm: true, then the job's phases and its end", async () => {
    let jobAnswer = { id: 5, type: "restore", status: "running", phase: "pre_backup" };
    const root = await open({
      "POST /admin/api/backup/inspect": () => answer(200, INSPECTED),
      "POST /admin/api/backup/restore": () => answer(202, { job: jobAnswer }),
    });
    await pick(root);
    await fill(root, "restore_passphrase", "the file passphrase");
    submit(root, "restore_passphrase");
    await dom.settle(12);

    dom.click(button(root, "Restore this backup"));
    await dom.settle();
    const asked = ui.confirmStore.get().request;
    assert.ok(asked && asked.message.includes("All the current data will be replaced by the backup of"));
    ui.resolveConfirm(true);
    await dom.settle(12);
    assert.deepEqual(requests.find((r) => r.key === "POST /admin/api/backup/restore").body, { restoreToken: "tok-1", confirm: true });

    const text = dom.text(root);
    assert.ok(text.includes("Restore in progress"));
    assert.ok(/done\s+maintenance/.test(text) || text.includes("maintenance"), "the phases are listed");
    assert.ok(text.includes("in progress") && text.includes("safety backup"));
    dom.unmount(root);
    assert.ok(jobAnswer);
  });

  test("restore: a job that is already finished in the answer shows the outcome, the safety copy and the warnings", async () => {
    const done = {
      id: 6,
      type: "restore",
      status: "done",
      phase: "restarting",
      result: { ok: true, preRestoreFile: "pre-restore-20260301-080000-000.owb", warnings: ["restart_timeout", "unknown_warning"] },
    };
    const root = await open({
      "POST /admin/api/backup/inspect": () => answer(200, INSPECTED),
      "POST /admin/api/backup/restore": () => answer(202, { job: done }),
      "GET /admin/api/backup/stored": () => answer(200, { items: [{ name: "pre-restore-20260301-080000-000.owb", kind: "pre-restore", size: 2048, createdAt: "2026-03-01T08:00:00.000Z" }] }),
    });
    await pick(root);
    await fill(root, "restore_passphrase", "the file passphrase");
    submit(root, "restore_passphrase");
    await dom.settle(12);
    dom.click(button(root, "Restore this backup"));
    await dom.settle();
    ui.resolveConfirm(true);
    await dom.settle(15);
    const text = dom.text(root);
    assert.ok(text.includes("Restore finished"));
    assert.ok(text.includes("A copy of the previous data is kept in pre-restore-20260301-080000-000.owb"));
    assert.ok(text.includes("did not confirm its restart"), "the restart warning");
    assert.ok(!text.includes("unknown_warning"));
    // the list of safety copies was reloaded
    assert.ok(requests.filter((r) => r.key === "GET /admin/api/backup/stored").length >= 2);
    assert.ok(text.includes("pre-restore-20260301-080000-000.owb") && text.includes("2.0 KB"));
    dom.unmount(root);
  });

  test("restore: a failed job says which step, that the data was kept, and why", async () => {
    const failed = { id: 9, type: "restore", status: "failed", phase: "database", error: { code: "restore_failed", params: { phase: "database", reason: "file_altered" } } };
    const root = await open({
      "POST /admin/api/backup/inspect": () => answer(200, INSPECTED),
      "POST /admin/api/backup/restore": () => answer(202, { job: failed }),
    });
    await pick(root);
    await fill(root, "restore_passphrase", "the file passphrase");
    submit(root, "restore_passphrase");
    await dom.settle(12);
    dom.click(button(root, "Restore this backup"));
    await dom.settle();
    ui.resolveConfirm(true);
    await dom.settle(15);
    const text = dom.text(root);
    assert.ok(text.includes("The restore failed"));
    assert.ok(text.includes("It stopped during the step: database."));
    assert.ok(text.includes("altered or cut short"));
    assert.ok(text.includes("The previous data was kept: nothing was changed."));
    dom.unmount(root);
  });

  test("restore: a wrong passphrase is explained and the SAME upload is reused for the next try", async () => {
    let calls = 0;
    const root = await open({
      "POST /admin/api/backup/inspect": () => {
        calls += 1;
        return calls === 1 ? refusal(422, "wrong_passphrase") : answer(200, INSPECTED);
      },
    });
    await pick(root);
    await fill(root, "restore_passphrase", "not the one");
    submit(root, "restore_passphrase");
    await dom.settle(12);
    assert.ok(dom.text(root).includes("Wrong passphrase. Use the one chosen when the file was exported"));
    assert.equal(uploads.length, 1);

    await fill(root, "restore_passphrase", "the right one");
    submit(root, "restore_passphrase");
    await dom.settle(12);
    assert.equal(uploads.length, 1, "no second upload: the server kept the first");
    assert.deepEqual(requests.filter((r) => r.key === "POST /admin/api/backup/inspect").map((r) => r.body.uploadId), ["u".repeat(32), "u".repeat(32)]);
    assert.ok(dom.text(root).includes("What this backup contains"));
    dom.unmount(root);
  });

  test("restore: the other refusals name their reason; a damaged file is sent again next time", async () => {
    const cases = [
      ["backup_corrupted", undefined, "altered or incomplete"],
      ["backup_unsupported_format", undefined, "not a backup this version can read"],
      ["backup_too_new", { backupVersion: "9.0.0", currentVersion: "1.4.0" }, "newer version of the bot (9.0.0); this one is 1.4.0"],
      ["backup_invalid_row", { model: "Group", index: 4, field: "mute" }, "data type Group, position 5, field mute"],
    ];
    for (const [code, params, expected] of cases) {
      const root = await open({ "POST /admin/api/backup/inspect": () => refusal(422, code, params) });
      await pick(root);
      await fill(root, "restore_passphrase", "the file passphrase");
      submit(root, "restore_passphrase");
      await dom.settle(12);
      assert.ok(dom.text(root).includes(expected), `${code}: ${dom.text(root).slice(0, 400)}`);
      assert.ok(dom.byText(root, "Check the file", "button").length === 1, "back to the form");
      dom.unmount(root);
    }
  });

  test("the safety copies are listed with a download that goes through BAK-5", async () => {
    const root = await open({
      "GET /admin/api/backup/stored": () =>
        answer(200, { items: [{ name: "pre-restore-20260301-080000-000.owb", kind: "pre-restore", size: 3 * 1024 * 1024, createdAt: "2026-03-01T08:00:00.000Z" }] }),
      "GET /admin/api/backup/stored/pre-restore-20260301-080000-000.owb": () => answer(200, {}, { "Content-Disposition": 'attachment; filename="pre-restore-20260301-080000-000.owb"' }),
    });
    const text = dom.text(root);
    assert.ok(text.includes("pre-restore-20260301-080000-000.owb") && text.includes("3.0 MB"));
    dom.click(button(root, "Download"));
    await dom.settle(10);
    assert.ok(requests.some((r) => r.key === "GET /admin/api/backup/stored/pre-restore-20260301-080000-000.owb"));
    assert.equal(globalThis.__saved.download, "pre-restore-20260301-080000-000.owb");
    dom.unmount(root);
  });
});
