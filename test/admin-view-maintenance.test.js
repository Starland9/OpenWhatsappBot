"use strict";
/**
 * The maintenance page (US11, FR-054 to FR-056): the pure logic of lib/admin/public/js/views/maintenance-logic.mjs
 * (blocker code -> how-to mapping, byte formatting, purge confirmation parameters, job and result mapping), its
 * translation fragment (panel-maintenance.json: same keys in both languages, every key the view files use is
 * defined) and the view itself in a fake DOM with a scripted `fetch` (no server, no browser).
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { createDom, importPublic } = require("./helpers/fakeDom");

const ROOT = path.resolve(__dirname, "..");
const VIEWS = path.join(ROOT, "lib", "admin", "public", "js", "views");
const FRAGMENT = path.join(ROOT, "specs", "002-admin-panel", "i18n", "panel-maintenance.json");
const load = (file) => import(pathToFileURL(path.join(VIEWS, file)).href);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const GIT = {
  installType: "git", canSelfUpdate: true, blockers: [], branch: "master", behind: 2, ahead: 0, localVersion: "1.0.0", remoteVersion: "1.1.0",
  commits: [{ sha: "abc1234", subject: "feat: one" }, { sha: "def5678", subject: "fix: two" }], checkedAt: "2026-01-01T12:00:00.000Z",
  restartRequired: false, supervised: false, lastResult: null,
};

// ---------------------------------------------------------------------------------------------------------------
describe("update model", () => {
  test("a git install that is behind can be applied; the list of changes is cut at what was sent", async () => {
    const { buildUpdateModel } = await load("maintenance-logic.mjs");
    const model = buildUpdateModel({ ...GIT, behind: 60, commits: GIT.commits });
    assert.equal(model.mode, "git");
    assert.equal(model.status, "available");
    assert.equal(model.canApply, true);
    assert.equal(model.moreCommits, 58);
    assert.deepEqual(model.commits[0], { sha: "abc1234", subject: "feat: one" });
  });

  test("never checked, up to date, and nothing behind", async () => {
    const { buildUpdateModel } = await load("maintenance-logic.mjs");
    const unchecked = buildUpdateModel({ ...GIT, behind: 0, commits: [], checkedAt: null, remoteVersion: null });
    assert.equal(unchecked.status, "unknown");
    assert.equal(unchecked.canApply, false);
    const current = buildUpdateModel({ ...GIT, behind: 0, commits: [], remoteVersion: "1.0.0" });
    assert.equal(current.status, "up_to_date");
    assert.equal(current.canApply, false, "nothing to install");
  });

  test("blockers disable the apply button and map to explanations (code -> text key)", async () => {
    const { buildUpdateModel, BLOCKER_KEYS, blockerInfo } = await load("maintenance-logic.mjs");
    const model = buildUpdateModel({ ...GIT, canSelfUpdate: false, blockers: ["dirty_tree", "not_writable"] });
    assert.equal(model.canApply, false);
    assert.deepEqual(model.blockers, [
      { code: "dirty_tree", key: "maintenance.blocker_dirty_tree" },
      { code: "not_writable", key: "maintenance.blocker_not_writable" },
    ]);
    for (const code of ["image", "archive", "no_git_binary", "dubious_ownership", "detached", "no_remote_branch", "dirty_tree", "not_writable"]) {
      assert.equal(blockerInfo(code).key, BLOCKER_KEYS[code], code);
      assert.match(blockerInfo(code).key, /^maintenance\.blocker_/);
    }
    assert.equal(blockerInfo("something_new").key, "maintenance.blocker_unknown", "an unknown code still reads");
  });

  test("an image or an archive has a how-to text and no apply; the release check may say a newer version exists", async () => {
    const { buildUpdateModel, howToKey } = await load("maintenance-logic.mjs");
    const image = buildUpdateModel({ installType: "image", canSelfUpdate: false, blockers: ["image"], branch: null, behind: 0, ahead: 0, localVersion: "1.0.0", remoteVersion: "1.3.0", commits: [], checkedAt: "2026-01-01T12:00:00.000Z", restartRequired: false, supervised: false });
    assert.equal(image.mode, "instructions");
    assert.equal(image.howToKey, "maintenance.howto_image");
    assert.equal(image.canApply, false);
    assert.deepEqual(image.blockers, [], "the how-to replaces the list of blockers");
    assert.equal(image.status, "release");

    const archive = buildUpdateModel({ installType: "archive", canSelfUpdate: false, blockers: ["archive"], localVersion: "1.0.0", remoteVersion: null, checkedAt: "2026-01-01T12:00:00.000Z" });
    assert.equal(archive.howToKey, "maintenance.howto_archive");
    assert.equal(archive.status, "unknown", "checked, but the release check is off: nothing to compare");
    assert.equal(howToKey("whatever"), "maintenance.howto_archive");
    assert.equal(buildUpdateModel(null), null);
  });

  test("the restart-pending state and the confirmation text depend on the supervisor", async () => {
    const { buildUpdateModel, applyConfirmation } = await load("maintenance-logic.mjs");
    const manual = buildUpdateModel({ ...GIT, restartRequired: true });
    assert.equal(manual.restartPending, true);
    assert.equal(manual.supervised, false);
    assert.deepEqual(applyConfirmation(manual), { messageKey: "maintenance.apply_confirm_manual", params: { from: "1.0.0", to: "1.1.0", count: 2 } });
    const auto = buildUpdateModel({ ...GIT, supervised: true });
    assert.equal(applyConfirmation(auto).messageKey, "maintenance.apply_confirm_supervised");
  });

  test("job progress and failures: phase labels, reason texts, rolled back", async () => {
    const { jobProgress, applyFailure, checkFailureKey, APPLY_PHASES } = await load("maintenance-logic.mjs");
    assert.deepEqual(APPLY_PHASES, ["fetch", "merge", "install", "verify"]);
    assert.deepEqual(jobProgress({ phase: "install" }), { phase: "install", phaseKey: "jobs.phase.install", step: 3, steps: 4 });
    assert.deepEqual(jobProgress({ phase: null }), { phase: null, phaseKey: null, step: 0, steps: 4 });
    assert.equal(jobProgress({ phase: "mystery" }).phaseKey, null);

    assert.deepEqual(applyFailure({ code: "update_failed", params: { phase: "verify", reason: "smoke_failed", rolledBack: true } }), {
      reason: "smoke_failed", reasonKey: "maintenance.reason_smoke_failed", phase: "verify", phaseKey: "jobs.phase.verify", rolledBack: true,
    });
    assert.equal(applyFailure({ params: { reason: "diverged", phase: "merge", rolledBack: true } }).reasonKey, "maintenance.reason_diverged");
    assert.equal(applyFailure({ params: { reason: "network", phase: "fetch", rolledBack: false } }).rolledBack, false);
    assert.equal(applyFailure(null).reasonKey, "maintenance.reason_unknown");
    assert.equal(checkFailureKey({ params: { reason: "no_remote_branch" } }), "maintenance.blocker_no_remote_branch");
    assert.equal(checkFailureKey({ params: { reason: "unreachable" } }), "maintenance.reason_unreachable");
    assert.equal(checkFailureKey(null), "maintenance.reason_unreachable");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("download tools model", () => {
  test("the card: command name, self-update wording, downloads block the update, a missing binary blocks it", async () => {
    const { buildYtdlpModel } = await load("maintenance-logic.mjs");
    const ok = buildYtdlpModel({ command: "yt-dlp", version: "2024.04.09", selfUpdatable: "likely", reason: null, activeDownloads: 0, latest: null });
    assert.equal(ok.canUpdate, true);
    assert.equal(ok.selfUpdatableKey, "maintenance.ytdlp_likely");
    const busy = buildYtdlpModel({ command: "yt-dlp", version: "1", selfUpdatable: "likely", activeDownloads: 2 });
    assert.deepEqual([busy.canUpdate, busy.blocked], [false, "downloads"]);
    const missing = buildYtdlpModel({ command: "yt-dlp", version: null, selfUpdatable: "missing", activeDownloads: 0 });
    assert.deepEqual([missing.canUpdate, missing.blocked], [false, "missing"]);
    const managed = buildYtdlpModel({ command: "yt-dlp", version: "1", selfUpdatable: "no", reason: "package_managed", activeDownloads: 0 });
    assert.equal(managed.reasonKey, "maintenance.ytdlp_reason_package_managed");
    assert.equal(managed.canUpdate, true, "a heuristic never forbids trying");
    assert.equal(buildYtdlpModel(null), null);
  });

  test("a verdict maps to a text, a tone and the hint's instructions", async () => {
    const { ytdlpResult, VERDICT_KEYS, VERDICT_TONES, HINT_KEYS } = await load("maintenance-logic.mjs");
    assert.deepEqual(ytdlpResult({ verdict: "updated", from: "1", to: "2", hint: null }), {
      verdict: "updated", verdictKey: "maintenance.ytdlp_verdict_updated", tone: "ok", hintKey: null, from: "1", to: "2", changed: true,
    });
    const managed = ytdlpResult({ verdict: "managed_externally", from: "1", to: "1", hint: "apt" });
    assert.equal(managed.hintKey, "maintenance.ytdlp_hint_apt");
    assert.equal(managed.tone, "warn");
    assert.equal(managed.changed, false);
    assert.equal(ytdlpResult({ verdict: "up_to_date", from: "1", to: "1", hint: "pip" }).hintKey, "maintenance.ytdlp_hint_pip");
    assert.equal(ytdlpResult({ verdict: "zzz" }).verdict, "failed", "an unknown verdict reads as a failure");
    assert.equal(ytdlpResult({ verdict: "failed", hint: "nope" }).hintKey, null);
    for (const verdict of Object.keys(VERDICT_KEYS)) assert.ok(["ok", "warn", "danger"].includes(VERDICT_TONES[verdict]), verdict);
    assert.deepEqual(Object.keys(HINT_KEYS).sort(), ["apt", "official_binary", "pip", "rebuild_image"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("storage model", () => {
  const MNT6 = {
    categories: [
      { id: "temp_media", bytes: 1536, files: 3, items: 3, unit: "files", truncated: false, purgeable: true, protectedBytes: null, protectedItems: null, measuredAt: "2026-01-01T12:00:00.000Z", dialect: null },
      { id: "broadcast_media", bytes: 10 * 1024 * 1024, files: 4, items: 4, unit: "files", truncated: false, purgeable: true, protectedBytes: 4096, protectedItems: 3, measuredAt: "2026-01-01T12:00:00.000Z", dialect: null },
      { id: "antidelete_cache", bytes: 800, files: 0, items: 12, unit: "messages", truncated: false, purgeable: true, protectedBytes: null, protectedItems: null, measuredAt: "2026-01-01T12:00:00.000Z", dialect: null },
      { id: "panel_backups", bytes: 0, files: 0, items: 0, unit: "files", truncated: false, purgeable: true, protectedBytes: null, protectedItems: null, measuredAt: "2026-01-01T12:00:00.000Z", dialect: null },
      { id: "logs", bytes: 2048, files: 2, items: 2, unit: "files", truncated: true, purgeable: true, protectedBytes: null, protectedItems: null, measuredAt: "2026-01-01T12:00:00.000Z", dialect: null },
      { id: "database", bytes: 5 * 1024 * 1024 * 1024, files: 2, items: 2, unit: "files", truncated: false, purgeable: false, protectedBytes: null, protectedItems: null, measuredAt: "2026-01-01T12:00:00.000Z", dialect: "sqlite" },
    ],
    disk: { freeBytes: 50 * 1024 ** 3, totalBytes: 200 * 1024 ** 3 },
  };

  test("byte formatting: binary units, one decimal under 10, \"at least\" for a walk that hit its bound, nothing for an unknown size", async () => {
    const { humanBytes, describeSize } = await load("maintenance-logic.mjs");
    assert.equal(humanBytes(0), "0 B");
    assert.equal(humanBytes(1023), "1023 B");
    assert.equal(humanBytes(1536), "1.5 KB");
    assert.equal(humanBytes(10 * 1024), "10 KB");
    assert.equal(humanBytes(5 * 1024 ** 3), "5.0 GB");
    assert.equal(humanBytes(-1), "");
    assert.equal(humanBytes("x"), "");
    assert.deepEqual(describeSize(1536), { text: "1.5 KB", atLeast: false, known: true });
    assert.deepEqual(describeSize(2048, { truncated: true }), { text: "2.0 KB", atLeast: true, known: true });
    assert.deepEqual(describeSize(null), { text: "", atLeast: false, known: false });
    assert.deepEqual(describeSize(undefined), { text: "", atLeast: false, known: false });
    assert.deepEqual(describeSize(10, { format: (n) => `<${n}>` }), { text: "<10>", atLeast: false, known: true }, "the view injects the locale-aware formatter");
  });

  test("the rows keep the order, mark the database as size only, and carry the protected part of the broadcast media", async () => {
    const { buildStorageRows, buildDisk, totalBytes } = await load("maintenance-logic.mjs");
    const rows = buildStorageRows(MNT6);
    assert.deepEqual(rows.map((r) => r.id), ["temp_media", "broadcast_media", "antidelete_cache", "panel_backups", "logs", "database"]);
    assert.deepEqual(rows.map((r) => r.purgeable), [true, true, true, true, true, false]);
    const broadcast = rows[1];
    assert.equal(broadcast.hasProtected, true);
    assert.equal(broadcast.protectedItems, 3);
    assert.equal(broadcast.protectedBytes, 4096);
    assert.equal(rows[2].unit, "messages");
    assert.equal(rows[4].truncated, true);
    assert.equal(rows[0].hasProtected, false);
    assert.equal(totalBytes(rows), 1536 + 10 * 1024 * 1024 + 800 + 0 + 2048 + 5 * 1024 ** 3);

    const disk = buildDisk(MNT6.disk);
    assert.equal(disk.freeBytes, 50 * 1024 ** 3);
    assert.equal(disk.usedRatio, 0.75);
    assert.deepEqual(buildDisk({ freeBytes: null, totalBytes: null }), { freeBytes: null, totalBytes: null, usedRatio: null });
    assert.deepEqual(buildStorageRows(null), []);
  });

  test("purge state: no button for the database, disabled when empty or while it runs", async () => {
    const { buildStorageRows, purgeState } = await load("maintenance-logic.mjs");
    const rows = Object.fromEntries(buildStorageRows(MNT6).map((r) => [r.id, r]));
    assert.deepEqual(purgeState(rows.database), { show: false, disabled: true, reason: "not_purgeable" });
    assert.deepEqual(purgeState(rows.panel_backups), { show: true, disabled: true, reason: "empty" });
    assert.deepEqual(purgeState(rows.temp_media), { show: true, disabled: false, reason: null });
    assert.deepEqual(purgeState(rows.logs, "logs"), { show: true, disabled: true, reason: "busy" });
    assert.equal(purgeState(rows.logs, "temp_media").disabled, false, "another category purging does not block this one");
  });

  test("purge confirmation parameters: the sizes stay numbers, the broadcast media states how many are kept", async () => {
    const { buildStorageRows, purgeConfirmation, PURGE_CONFIRM_KEYS } = await load("maintenance-logic.mjs");
    const rows = Object.fromEntries(buildStorageRows(MNT6).map((r) => [r.id, r]));
    assert.deepEqual(purgeConfirmation(rows.broadcast_media), {
      messageKey: "maintenance.purge_confirm_broadcast_media",
      params: { size: 10 * 1024 * 1024, items: 4, kept: 3, keptBytes: 4096 },
    });
    assert.deepEqual(purgeConfirmation(rows.antidelete_cache), {
      messageKey: "maintenance.purge_confirm_antidelete_cache",
      params: { size: 800, items: 12, kept: 0, keptBytes: 0 },
    });
    assert.equal(purgeConfirmation(rows.logs).messageKey, "maintenance.purge_confirm_logs");
    assert.equal(purgeConfirmation(rows.panel_backups).messageKey, "maintenance.purge_confirm_panel_backups");
    assert.deepEqual(Object.keys(PURGE_CONFIRM_KEYS).sort(), ["antidelete_cache", "broadcast_media", "logs", "panel_backups", "temp_media"], "no confirmation text exists for the database");
    // an unknown protected part reads as zero, never as NaN
    const unknown = purgeConfirmation({ ...rows.broadcast_media, protectedItems: null, protectedBytes: null });
    assert.deepEqual([unknown.params.kept, unknown.params.keptBytes], [0, 0]);
  });

  test("the toast after a purge: kept broadcasts are mentioned", async () => {
    const { purgeResultMessage } = await load("maintenance-logic.mjs");
    assert.deepEqual(purgeResultMessage("temp_media", { freedBytes: 1024, removed: 2, skipped: 1 }), { key: "maintenance.purged", params: { size: 1024, removed: 2, kept: 1 } });
    assert.equal(purgeResultMessage("broadcast_media", { freedBytes: 5, removed: 1, skipped: 3 }).key, "maintenance.purged_kept");
    assert.equal(purgeResultMessage("broadcast_media", { freedBytes: 5, removed: 1, skipped: 0 }).key, "maintenance.purged");
    assert.equal(purgeResultMessage("logs", undefined).params.size, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("panel-maintenance.json", () => {
  const fragment = readJson(FRAGMENT);
  const placeholdersOf = (text) => (String(text).match(/\{[A-Za-z0-9_]+\}/g) || []).sort().join(",");

  test("English and French define the same keys with the same placeholders, none empty, all under maintenance.", () => {
    const en = Object.keys(fragment.en).sort();
    assert.deepEqual(Object.keys(fragment.fr).sort(), en);
    assert.ok(en.length >= 100);
    for (const key of en) {
      assert.ok(key.startsWith("maintenance."), key);
      for (const lang of ["en", "fr"]) assert.ok(typeof fragment[lang][key] === "string" && fragment[lang][key].trim(), `${lang} ${key}`);
      assert.equal(placeholdersOf(fragment.fr[key]), placeholdersOf(fragment.en[key]), key);
    }
    assert.equal("maintenance.title" in fragment.en, false, "the area title is already in the panel catalog");
    const keys = new Set(en);
    for (const key of keys) {
      const parts = key.split(".");
      for (let i = 1; i < parts.length; i++) assert.equal(keys.has(parts.slice(0, i).join(".")), false, `${key} nests under a text`);
    }
  });

  test("no http(s) address and no markup in the texts (strict CSP, FR-010)", () => {
    for (const lang of ["en", "fr"]) {
      for (const [key, text] of Object.entries(fragment[lang])) {
        assert.ok(!/https?:\/\//i.test(text), `${lang} ${key}`);
        assert.ok(!/<\/?[a-z][^>]*>/i.test(text.replace(/<(branch|branche)>/g, "")), `${lang} ${key}`);
      }
    }
  });

  test("every key of the logic maps and every literal key of the view files is defined", async () => {
    const logic = await load("maintenance-logic.mjs");
    const main = readJson(path.join(ROOT, "lib", "admin", "public", "i18n", "en.json"));
    const defined = new Set([...Object.keys(fragment.en), ...Object.keys(main)]);
    const known = (key) => defined.has(key) || defined.has(`${key}_other`);

    const maps = ["BLOCKER_KEYS", "HOWTO_KEYS", "CHECK_REASON_KEYS", "APPLY_REASON_KEYS", "PHASE_KEYS", "STATUS_KEYS", "INSTALL_KEYS", "SELF_UPDATABLE_KEYS", "YTDLP_REASON_KEYS", "VERDICT_KEYS", "HINT_KEYS", "CATEGORY_LABEL_KEYS", "CATEGORY_NOTE_KEYS", "PURGE_CONFIRM_KEYS", "UNIT_KEYS"];
    for (const name of maps) {
      assert.ok(logic[name], name);
      for (const key of Object.values(logic[name])) assert.ok(known(key), `${name}: ${key} is not defined`);
    }
    for (const key of ["maintenance.blocker_unknown", "maintenance.reason_unknown", "maintenance.cat_unknown", "maintenance.apply_confirm_supervised", "maintenance.apply_confirm_manual", "maintenance.purged", "maintenance.purged_kept"]) {
      assert.ok(known(key), key);
    }

    const used = new Set();
    for (const file of fs.readdirSync(VIEWS).filter((name) => /^maintenance(-.*)?\.mjs$/.test(name))) {
      const source = fs.readFileSync(path.join(VIEWS, file), "utf8");
      for (const match of source.matchAll(/["'`]((?:maintenance|common|jobs|errors)\.[A-Za-z0-9_.]+)["'`]/g)) used.add(match[1]);
    }
    assert.ok(used.size > 50, `${used.size} literal keys`);
    for (const key of used) assert.ok(known(key), `${key} is not defined`);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("the view in a fake DOM", () => {
  let dom;
  let ui;
  let htmlTag;
  let view;
  let requests;
  let routes;

  const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const button = (root, text) => dom.byText(root, text, "button")[0];
  const count = (key) => requests.filter((r) => r.key === key).length;

  const STORAGE = {
    categories: [
      { id: "temp_media", bytes: 1536, files: 3, items: 3, unit: "files", truncated: false, purgeable: true, protectedBytes: null, protectedItems: null, measuredAt: "2026-01-01T12:00:00.000Z", dialect: null },
      { id: "broadcast_media", bytes: 8192, files: 2, items: 2, unit: "files", truncated: false, purgeable: true, protectedBytes: 4096, protectedItems: 3, measuredAt: "2026-01-01T12:00:00.000Z", dialect: null },
      { id: "antidelete_cache", bytes: 0, files: 0, items: 0, unit: "messages", truncated: false, purgeable: true, protectedBytes: null, protectedItems: null, measuredAt: "2026-01-01T12:00:00.000Z", dialect: null },
      { id: "panel_backups", bytes: 0, files: 0, items: 0, unit: "files", truncated: false, purgeable: true, protectedBytes: null, protectedItems: null, measuredAt: "2026-01-01T12:00:00.000Z", dialect: null },
      { id: "logs", bytes: 2048, files: 2, items: 2, unit: "files", truncated: false, purgeable: true, protectedBytes: null, protectedItems: null, measuredAt: "2026-01-01T12:00:00.000Z", dialect: null },
      { id: "database", bytes: 1048576, files: 1, items: 1, unit: "files", truncated: false, purgeable: false, protectedBytes: null, protectedItems: null, measuredAt: "2026-01-01T12:00:00.000Z", dialect: "sqlite" },
    ],
    disk: { freeBytes: 50 * 1024 ** 3, totalBytes: 200 * 1024 ** 3 },
  };
  const YTDLP = { command: "yt-dlp", version: "2024.04.09", selfUpdatable: "likely", reason: null, activeDownloads: 0, latest: null };
  const base = () => ({
    "GET /admin/api/maintenance/update": () => answer(200, GIT),
    "GET /admin/api/maintenance/ytdlp": () => answer(200, YTDLP),
    "GET /admin/api/maintenance/storage": () => answer(200, STORAGE),
  });

  before(async () => {
    dom = await createDom();
    const i18n = await importPublic("js/i18n.mjs");
    for (const lang of ["en", "fr"]) {
      i18n.setCatalog(lang, { ...readJson(path.join(ROOT, "lib", "admin", "public", "i18n", `${lang}.json`)), ...readJson(FRAGMENT)[lang] });
    }
    await i18n.setLanguage("en", { remember: false });
    ui = await importPublic("js/ui.mjs");
    htmlTag = (await importPublic("js/components/html.mjs")).html;
    view = await importPublic("js/views/maintenance.mjs");
  });

  after(() => {
    dom.restore();
    delete globalThis.fetch;
  });

  async function open(script = {}) {
    requests = [];
    routes = { ...base(), ...script };
    globalThis.fetch = async (url, init) => {
      const [path_, search] = url.split("?");
      const key = `${init.method} ${path_}`;
      requests.push({ key, search: search || "", body: init.body ? JSON.parse(init.body) : undefined });
      if (!routes[key]) throw new Error(`unexpected request ${key}`);
      return routes[key](init.body ? JSON.parse(init.body) : undefined, search || "");
    };
    const root = dom.mount(htmlTag`<${view.default} route=${{ rest: [], query: {} }} />`);
    await dom.settle(12);
    return root;
  }

  test("the page exports its meta and shows the three cards: versions, changes, tools, storage", async () => {
    assert.deepEqual(view.meta, { area: "maintenance", titleKey: "maintenance.title", icon: "maintenance" });
    const root = await open();
    const text = dom.text(root);
    assert.ok(text.includes("Bot update") && text.includes("Download tools (yt-dlp)") && text.includes("Storage"));
    assert.ok(text.includes("1.0.0") && text.includes("1.1.0") && text.includes("master"));
    assert.ok(text.includes("abc1234") && text.includes("feat: one") && text.includes("def5678") && text.includes("fix: two"), "the list of changes");
    assert.ok(text.includes("2024.04.09") && text.includes("yt-dlp"));
    assert.ok(text.includes("Temporary media") && text.includes("Broadcast media") && text.includes("Anti-delete cache") && text.includes("Panel backups") && text.includes("Logs") && text.includes("Database"));
    assert.ok(text.includes("of which 4.0 KB kept for 3 broadcast(s)"), "the protected part of the broadcast media");
    assert.ok(text.includes("50 GB free of 200 GB"), "free disk");
    const empties = dom.byText(root, "Empty", "button");
    assert.equal(empties.length, 5, "one button per purgeable category");
    assert.equal(empties.filter((el) => el.prop("disabled") === true).length, 2, "the two empty categories (anti-delete cache, backups) have nothing to free");
    assert.equal(dom.byText(root, "Size only").length >= 1, true, "the database has no purge button");
    assert.ok(!text.includes("/usr/") && !text.includes("/home/"), "no path is shown");
    dom.unmount(root);
  });

  test("Update now asks first (versions, manual restart wording), then applies and shows the restart-to-finish state", async () => {
    const finished = { id: 5, type: "update.apply", status: "done", phase: "verify", result: { from: "1.0.0", to: "1.1.0", versions: { from: "1.0.0", to: "1.1.0" }, restartRequired: true, willRestart: false, upToDate: false } };
    let updateCalls = 0;
    const root = await open({
      "GET /admin/api/maintenance/update": () => answer(200, ++updateCalls === 1 ? GIT : { ...GIT, behind: 0, commits: [], restartRequired: true }),
      "POST /admin/api/maintenance/update/apply": () => answer(202, { job: finished }),
    });
    dom.click(button(root, "Update now"));
    await dom.settle();
    assert.equal(count("POST /admin/api/maintenance/update/apply"), 0, "nothing before the confirmation");
    const asked = ui.confirmStore.get().request;
    assert.equal(asked.title, "Update the bot?");
    assert.ok(asked.message.includes("1.0.0") && asked.message.includes("1.1.0") && asked.message.includes("2 change(s)"));
    assert.ok(asked.message.includes("restart the program yourself"), "unsupervised: the owner is told to restart");

    ui.resolveConfirm(false);
    await dom.settle();
    assert.equal(count("POST /admin/api/maintenance/update/apply"), 0, "cancelled");

    dom.click(button(root, "Update now"));
    await dom.settle();
    ui.resolveConfirm(true);
    await dom.settle(15);
    assert.deepEqual(requests.find((r) => r.key === "POST /admin/api/maintenance/update/apply").body, { confirm: true });
    const text = dom.text(root);
    assert.ok(text.includes("Updated from 1.0.0 to 1.1.0. Restart the program to finish."));
    assert.ok(text.includes("Restart the program to finish: nothing restarts it automatically here."), "the persistent restart state");
    assert.equal(count("GET /admin/api/maintenance/update"), 2, "the card is read again");
    assert.equal(button(root, "Update now").prop("disabled"), true, "nothing left to apply");
    dom.unmount(root);
  });

  test("a failed update explains the reason and that the bot stayed on its version", async () => {
    const failed = { id: 6, type: "update.apply", status: "failed", phase: "verify", error: { code: "update_failed", params: { phase: "verify", reason: "smoke_failed", rolledBack: true } } };
    const root = await open({ "POST /admin/api/maintenance/update/apply": () => answer(202, { job: failed }) });
    dom.click(button(root, "Update now"));
    await dom.settle();
    ui.resolveConfirm(true);
    await dom.settle(15);
    const text = dom.text(root);
    assert.ok(text.includes("The update failed. The new version did not pass its start-up test."));
    assert.ok(text.includes("It failed during this step: checking."));
    assert.ok(text.includes("The bot went back to the version it was running: nothing changed."));
    dom.unmount(root);
  });

  test("a running update shows its phase and locks the buttons", async () => {
    const running = { id: 7, type: "update.apply", status: "running", phase: "install" };
    const root = await open({ "POST /admin/api/maintenance/update/apply": () => answer(202, { job: running }) });
    dom.click(button(root, "Update now"));
    await dom.settle();
    ui.resolveConfirm(true);
    await dom.settle(15);
    assert.ok(dom.text(root).includes("Updating: installing (step 3 of 4)"));
    assert.equal(button(root, "Check for updates").prop("disabled"), true);
    assert.equal(button(root, "Update now").prop("disabled"), true);
    dom.unmount(root);
  });

  test("an image install shows how to update and no Update now button", async () => {
    const root = await open({
      "GET /admin/api/maintenance/update": () => answer(200, { installType: "image", canSelfUpdate: false, blockers: ["image"], branch: null, behind: 0, ahead: 0, localVersion: "1.0.0", remoteVersion: "1.3.0", commits: [], checkedAt: "2026-01-01T12:00:00.000Z", restartRequired: false, supervised: false, lastResult: null }),
    });
    const text = dom.text(root);
    assert.ok(text.includes("runs from a container image") && text.includes("docker compose pull"));
    assert.ok(text.includes("A newer version is available: 1.3.0."));
    assert.equal(dom.byText(root, "Update now", "button").length, 0);
    assert.equal(dom.byText(root, "Check for updates", "button").length, 1);
    dom.unmount(root);
  });

  test("blockers are explained and disable the update", async () => {
    const root = await open({
      "GET /admin/api/maintenance/update": () => answer(200, { ...GIT, canSelfUpdate: false, blockers: ["dirty_tree"] }),
    });
    assert.ok(dom.text(root).includes("Tracked files have local changes."));
    assert.equal(button(root, "Update now").prop("disabled"), true);
    dom.unmount(root);
  });

  test("Check for updates posts an empty body and reads the card again", async () => {
    const done = { id: 8, type: "update.check", status: "done", result: GIT };
    const root = await open({ "POST /admin/api/maintenance/update/check": () => answer(202, { job: done }) });
    dom.click(button(root, "Check for updates"));
    await dom.settle(15);
    assert.deepEqual(requests.find((r) => r.key === "POST /admin/api/maintenance/update/check").body, {});
    assert.equal(count("GET /admin/api/maintenance/update"), 2);
    dom.unmount(root);
  });

  test("a failed check says why (no upstream)", async () => {
    const failed = { id: 9, type: "update.check", status: "failed", error: { code: "update_check_failed", params: { reason: "no_remote_branch" } } };
    const root = await open({ "POST /admin/api/maintenance/update/check": () => answer(202, { job: failed }) });
    dom.click(button(root, "Check for updates"));
    await dom.settle(15);
    assert.ok(dom.text(root).includes("The check failed.") && dom.text(root).includes("no counterpart on GitHub"));
    dom.unmount(root);
  });

  test("the storage table: Empty asks first and says how many broadcasts keep their media; then purges and reads again", async () => {
    const root = await open({
      "POST /admin/api/maintenance/storage/broadcast_media/purge": () => answer(200, { freedBytes: 4096, removed: 1, skipped: 3 }),
    });
    const row = dom.find(root, (el) => el.localName === "tr" && dom.text(el).includes("Broadcast media"))[0];
    const empty = dom.byText(row, "Empty", "button")[0];
    dom.click(empty);
    await dom.settle();
    assert.equal(count("POST /admin/api/maintenance/storage/broadcast_media/purge"), 0, "nothing before the confirmation");
    const asked = ui.confirmStore.get().request;
    assert.equal(asked.title, "Empty “Broadcast media”?");
    assert.ok(asked.message.includes("3 broadcast(s) that are scheduled or recurring keep their media (4.0 KB)"));
    ui.resolveConfirm(true);
    await dom.settle(15);
    assert.deepEqual(requests.find((r) => r.key === "POST /admin/api/maintenance/storage/broadcast_media/purge").body, { confirm: true });
    assert.equal(count("GET /admin/api/maintenance/storage"), 2, "the table is read again");
    assert.ok(ui.toastStore.get().items.some((item) => item.message === "Freed 4.0 KB. 3 broadcast(s) kept their media."));
    dom.unmount(root);
  });

  test("the antidelete confirmation warns about the last hour; the database row has no Empty button", async () => {
    const withCache = { ...STORAGE, categories: STORAGE.categories.map((c) => (c.id === "antidelete_cache" ? { ...c, bytes: 300, items: 5 } : c)) };
    const root = await open({ "GET /admin/api/maintenance/storage": () => answer(200, withCache) });
    const row = dom.find(root, (el) => el.localName === "tr" && dom.text(el).includes("Anti-delete cache"))[0];
    dom.click(dom.byText(row, "Empty", "button")[0]);
    await dom.settle();
    assert.ok(ui.confirmStore.get().request.message.includes("Messages deleted during the last hour can no longer be recovered"));
    ui.resolveConfirm(false);
    await dom.settle();
    const database = dom.find(root, (el) => el.localName === "tr" && dom.text(el).includes("Database"))[0];
    assert.equal(dom.byText(database, "Empty", "button").length, 0);
    assert.ok(dom.text(database).includes("Size only"));
    dom.unmount(root);
  });

  test("Refresh asks for ?refresh=1", async () => {
    const root = await open({});
    dom.click(button(root, "Refresh"));
    await dom.settle(10);
    assert.ok(requests.some((r) => r.key === "GET /admin/api/maintenance/storage" && r.search === "refresh=1"));
    dom.unmount(root);
  });

  test("yt-dlp: the update asks first; the verdict and the hint that fit it are shown", async () => {
    const finished = { id: 10, type: "ytdlp.update", status: "done", result: { verdict: "managed_externally", from: "2024.04.09", to: "2024.04.09", hint: "apt" } };
    const root = await open({ "POST /admin/api/maintenance/ytdlp/update": () => answer(202, { job: finished }) });
    dom.click(button(root, "Update yt-dlp"));
    await dom.settle();
    assert.equal(count("POST /admin/api/maintenance/ytdlp/update"), 0);
    assert.equal(ui.confirmStore.get().request.title, "Update yt-dlp?");
    ui.resolveConfirm(true);
    await dom.settle(15);
    assert.deepEqual(requests.find((r) => r.key === "POST /admin/api/maintenance/ytdlp/update").body, { confirm: true });
    const text = dom.text(root);
    assert.ok(text.includes("yt-dlp is managed by your system and cannot update itself."));
    assert.ok(text.includes("sudo apt install --only-upgrade yt-dlp"));
    dom.unmount(root);
  });

  test("yt-dlp: running downloads disable the update and say why", async () => {
    const root = await open({ "GET /admin/api/maintenance/ytdlp": () => answer(200, { ...YTDLP, activeDownloads: 2 }) });
    assert.equal(button(root, "Update yt-dlp").prop("disabled"), true);
    assert.ok(dom.text(root).includes("Downloads are running: wait for them to finish."));
    dom.unmount(root);
  });

  test("a card that cannot load offers Try again instead of failing the page", async () => {
    const root = await open({ "GET /admin/api/maintenance/ytdlp": () => answer(500, { error: { code: "internal_error", requestId: "abc" } }) });
    const text = dom.text(root);
    assert.ok(text.includes("Bot update") && text.includes("Storage"), "the other cards still render");
    assert.equal(dom.byText(root, "Try again", "button").length, 1);
    dom.unmount(root);
  });
});
