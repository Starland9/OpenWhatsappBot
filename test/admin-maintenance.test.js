"use strict";
/**
 * Maintenance routes MNT-1 to MNT-7 (US11; admin-http-api.md 2.14, FR-054, FR-055, FR-056) over the real createAdmin
 * (test/helpers/adminHarness.js). The updater and the yt-dlp updater are stand-ins (their engines have their own
 * suites: test/updater.test.js, test/ytdlp-update.test.js); the storage service is the real one over temporary
 * directories (test/storage.test.js covers its rules), with a fake broadcaster and a fake anti-delete cache.
 *
 *  - MNT-1 shape, the `update_unavailable` blockers, db:r; MNT-2 job and its 429 (1 per 30 s);
 *  - MNT-3 needs `confirm: true`, 202 job, 409 update_unavailable / busy, a failure becomes a failed job
 *    `update_failed` with params.phase / reason / rolledBack; the supervised exit is scheduled, the unsupervised one
 *    is not and the `update_restart` banner appears;
 *  - MNT-4 / MNT-5: downloads_active, the verdicts and their hints, the command name instead of the path;
 *  - MNT-6: the six categories, ?refresh limited to one per 5 s, db:r; MNT-7: confirm, 422 not_purgeable, 404, busy.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createTestAdmin } = require("./helpers/adminHarness");
const { createFakeRuntime } = require("./helpers/fakeBotRuntime");
const { UpdaterError } = require("../lib/utils/updater");
const { FAKE_STDERR } = require("./helpers/fakeExec");

const SECRET_PATH = "/home/owner/private-bin/yt-dlp";

let t;
let http;
let updater;
let ytdlp;
let downloader;
let antiDelete;
let broadcaster;
let maintenance;
let dirs;

function fakeUpdater() {
  const u = {
    info: { type: "git", canSelfUpdate: true, blockers: [], branch: "master", upstream: "origin/master", supervised: false, supervisor: "none" },
    checkResult: null,
    checkImpl: null,
    applyImpl: null,
    applyCalls: [],
    checkCalls: [],
    busy: false,
    lastApplied: null,
    restart: { required: false, from: null, to: null, reason: null },
    exitScheduled: 0,
    async getInstallInfo() {
      return { ...u.info, blockers: [...u.info.blockers] };
    },
    async check(options) {
      u.checkCalls.push(options);
      u.checkResult = await u.checkImpl();
      return u.checkResult;
    },
    lastCheck: () => u.checkResult,
    lastApply: () => u.lastApplied,
    async apply(options) {
      u.applyCalls.push({ actor: options.actor });
      u.busy = true;
      try {
        const out = await u.applyImpl(options);
        u.lastApplied = { ok: out.ok, from: out.from, to: out.to, at: "2026-01-01T12:00:00.000Z", phase: out.phase, reason: out.reason ?? null, rolledBack: Boolean(out.rolledBack) };
        return out;
      } finally {
        u.busy = false;
      }
    },
    restartRequired: () => ({ ...u.restart }),
    scheduleExit() {
      u.exitScheduled += 1;
      return { scheduled: u.info.supervised };
    },
    isBusy: () => u.busy,
    localVersion: () => "1.0.0",
  };
  u.checkImpl = async () => ({ behind: 2, ahead: 0, localVersion: "1.0.0", remoteVersion: "1.1.0", commits: [{ hash: "abc1234", subject: "feat: one" }, { hash: "def5678", subject: "fix: two" }], checkedAt: "2026-01-01T12:00:00.000Z", blockers: [], installType: "git", upstream: "origin/master" });
  u.applyImpl = async ({ onProgress }) => {
    for (const phase of ["fetch", "merge", "install", "verify"]) await onProgress({ phase });
    u.restart = { required: true, from: "1.0.0", to: "1.1.0", reason: "version" };
    return { ok: true, from: "1.0.0", to: "1.1.0", upToDate: false, phase: "done", restartRequired: true, willRestart: u.info.supervised, rolledBack: false };
  };
  return u;
}

function fakeYtdlp() {
  const y = {
    inspected: { selfUpdatable: "likely", version: "2024.04.09", hint: null },
    outcome: { outcome: "updated", before: "2024.04.09", after: "2025.01.01" },
    updating: false,
    calls: 0,
    gate: null,
    async inspect() {
      return { ...y.inspected };
    },
    async update() {
      y.calls += 1;
      if (y.gate) await y.gate;
      return { ...y.outcome };
    },
    command: () => "yt-dlp",
    isUpdating: () => y.updating,
  };
  return y;
}

async function boot({ deps = {}, config } = {}) {
  updater = fakeUpdater();
  ytdlp = fakeYtdlp();
  downloader = { active: 0, getActiveDownloads: () => downloader.active };
  antiDelete = {
    getCacheStats: () => ({ entries: 4, chats: 1, bytes: 80 }),
    clearCache: () => ({ entries: 4, chats: 1, bytes: 80 }),
  };
  broadcaster = { gate: null, calls: 0, purgeFinishedMedia: async () => (broadcaster.calls++, broadcaster.gate && (await broadcaster.gate), { freedBytes: 0, removed: 0, skipped: 3 }) };
  maintenance = { active: false, isActive: () => maintenance.active, getReason: () => null };
  dirs = {
    root: fs.mkdtempSync(path.join(os.tmpdir(), "owb-mnt-root-")),
    tmp: fs.mkdtempSync(path.join(os.tmpdir(), "owb-mnt-tmp-")),
  };
  t = await createTestAdmin({
    config: { YTDLP_PATH: SECRET_PATH, ...(config || {}) },
    deps: {
      runtime: createFakeRuntime(),
      dbProbe: async () => true,
      updater,
      ytdlpUpdate: ytdlp,
      downloader,
      antiDeleteHandler: antiDelete,
      broadcaster,
      maintenanceMode: maintenance,
      rootDir: dirs.root,
      tmpDir: dirs.tmp,
      ...deps,
    },
  });
  await t.admin.start();
  http = await t.loginClient();
  return t;
}

afterEach(async () => {
  if (t) await t.close();
  t = null;
  for (const dir of Object.values(dirs || {})) fs.rmSync(dir, { recursive: true, force: true });
  dirs = null;
});

const A = "/admin/api/maintenance";
const post = (suffix, body = {}) => http.api("POST", `${A}${suffix}`, body);

async function jobDone(id) {
  const job = await fakes.waitFor(async () => {
    const res = await http.get(`/admin/api/jobs/${id}`);
    return res.status === 200 && res.json.job.status !== "running" ? res.json.job : null;
  });
  assert.ok(job, `job ${id} did not finish`);
  return job;
}
const auditRows = (action) => t.db.AuditLog.findAll({ where: { action }, raw: true, order: [["id", "ASC"]] });

// ---------------------------------------------------------------------------------------------------------------
describe("the route table", () => {
  test("MNT-1..MNT-7: session auth, CSRF on the POSTs, db:r exactly on MNT-1, MNT-4 and MNT-6", async () => {
    await boot();
    const mine = t.admin.routes().filter((r) => r.path.startsWith(`${A}`));
    const key = (r) => `${r.method} ${r.path}`;
    assert.deepEqual(mine.map(key).sort(), [
      `GET ${A}/storage`,
      `GET ${A}/update`,
      `GET ${A}/ytdlp`,
      `POST ${A}/storage/:category/purge`,
      `POST ${A}/update/apply`,
      `POST ${A}/update/check`,
      `POST ${A}/ytdlp/update`,
    ]);
    for (const r of mine) {
      assert.equal(r.auth, "session", key(r));
      assert.equal(r.mutates, r.method === "POST", key(r));
      if (r.method === "POST") assert.equal(r.csrf, true, key(r));
      assert.equal(r.db === "optional", ["GET /admin/api/maintenance/update", "GET /admin/api/maintenance/ytdlp", "GET /admin/api/maintenance/storage"].includes(key(r)), key(r));
    }
  });

  test("anonymous callers get 401, a POST without the CSRF token gets 403", async () => {
    await boot();
    const anon = t.client();
    for (const suffix of ["/update", "/ytdlp", "/storage"]) assert.equal((await anon.get(`${A}${suffix}`)).status, 401, suffix);
    for (const suffix of ["/update/check", "/update/apply", "/ytdlp/update", "/storage/logs/purge"]) {
      assert.equal((await anon.api("POST", `${A}${suffix}`, { confirm: true })).status, 401, suffix);
    }
    const noToken = await http.api("POST", `${A}/update/apply`, { confirm: true }, { headers: { "X-CSRF-Token": null } });
    assert.equal(noToken.status, 403);
    assert.equal(updater.applyCalls.length, 0);
  });

  test("a restore in progress refuses the mutating routes with 503 maintenance; the pages still read", async () => {
    await boot();
    maintenance.active = true;
    for (const suffix of ["/update/check", "/update/apply", "/ytdlp/update", "/storage/logs/purge"]) {
      const res = await post(suffix, { confirm: true });
      assert.equal(res.status, 503, suffix);
      assert.equal(res.json.error.code, "maintenance");
    }
    assert.equal((await http.get(`${A}/update`)).status, 200);
    assert.equal(updater.applyCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("MNT-1 GET /maintenance/update", () => {
  test("the shape of the page object, before any check", async () => {
    await boot();
    const res = await http.get(`${A}/update`);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), [
      "ahead", "behind", "blockers", "branch", "canSelfUpdate", "checkedAt", "commits", "installType", "lastResult",
      "localVersion", "remoteVersion", "restartRequired", "supervised",
    ].sort());
    assert.deepEqual(res.json, {
      installType: "git", canSelfUpdate: true, blockers: [], branch: "master", behind: 0, ahead: 0, localVersion: "1.0.0",
      remoteVersion: null, commits: [], checkedAt: null, restartRequired: false, supervised: false, lastResult: null,
    });
  });

  test("blockers explain why an install cannot update itself (image, dirty tree...)", async () => {
    await boot();
    updater.info = { ...updater.info, type: "image", canSelfUpdate: false, blockers: ["image"], branch: null };
    let body = (await http.get(`${A}/update`)).json;
    assert.equal(body.installType, "image");
    assert.equal(body.canSelfUpdate, false);
    assert.deepEqual(body.blockers, ["image"]);

    updater.info = { ...updater.info, type: "git", canSelfUpdate: false, blockers: ["dirty_tree", "not_writable"], branch: "master" };
    body = (await http.get(`${A}/update`)).json;
    assert.deepEqual(body.blockers, ["dirty_tree", "not_writable"]);
  });

  test("after a check: behind, versions and the list of changes as { sha, subject }", async () => {
    await boot();
    const job = (await post("/update/check")).json.job;
    await jobDone(job.id);
    const body = (await http.get(`${A}/update`)).json;
    assert.equal(body.behind, 2);
    assert.equal(body.remoteVersion, "1.1.0");
    assert.deepEqual(body.commits, [{ sha: "abc1234", subject: "feat: one" }, { sha: "def5678", subject: "fix: two" }]);
    assert.equal(body.checkedAt, "2026-01-01T12:00:00.000Z");
  });

  test("restartRequired and supervised come from the updater; lastResult after an attempt", async () => {
    await boot();
    updater.info.supervised = true;
    updater.restart = { required: true, from: "1.0.0", to: "1.1.0", reason: "version" };
    updater.lastApplied = { ok: false, from: "1.0.0", to: "1.1.0", at: "2026-01-01T11:00:00.000Z", phase: "install", reason: "install_failed", rolledBack: true };
    const body = (await http.get(`${A}/update`)).json;
    assert.equal(body.restartRequired, true);
    assert.equal(body.supervised, true);
    assert.deepEqual(body.lastResult, { ok: false, from: "1.0.0", to: "1.1.0", at: "2026-01-01T11:00:00.000Z", phase: "install", reason: "install_failed", rolledBack: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("MNT-2 POST /maintenance/update/check", () => {
  test("202 with an update.check job whose result is the MNT-1 object; audited", async () => {
    await boot();
    const res = await post("/update/check");
    assert.equal(res.status, 202);
    assert.equal(res.json.job.type, "update.check");
    assert.equal(res.json.job.status, "running");
    const job = await jobDone(res.json.job.id);
    assert.equal(job.status, "done");
    assert.equal(job.result.behind, 2);
    assert.equal(job.result.remoteVersion, "1.1.0");
    assert.deepEqual(updater.checkCalls, [{ force: true }]);
    const rows = await auditRows("update.check");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, "ok");
    assert.equal(rows[0].target, "1.1.0");
  });

  test("429 rate_limited: one check per 30 s (Retry-After), allowed again after 30 s", async () => {
    await boot();
    assert.equal((await post("/update/check")).status, 202);
    t.clock.advance(10 * 1000);
    const limited = await post("/update/check");
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error.code, "rate_limited");
    assert.equal(limited.json.error.params.retryAfterMs, 20 * 1000);
    assert.equal(limited.headers.get("retry-after"), "20");
    assert.equal(updater.checkCalls.length <= 1, true);
    await t.clock.advance(20 * 1000);
    assert.equal((await post("/update/check")).status, 202);
  });

  test("a failing check is a failed job update_check_failed with the reason (no_remote_branch, unreachable...)", async () => {
    await boot();
    updater.checkImpl = async () => {
      throw new UpdaterError("update_check_failed", { reason: "no_remote_branch" });
    };
    const job = await jobDone((await post("/update/check")).json.job.id);
    assert.equal(job.status, "failed");
    assert.deepEqual(job.error, { code: "update_check_failed", params: { reason: "no_remote_branch" } });
    const rows = await auditRows("update.check");
    assert.equal(rows[0].result, "fail");
    assert.deepEqual(JSON.parse(rows[0].detail), { reason: "no_remote_branch" });
  });

  test("a body property is refused: the body is {}", async () => {
    await boot();
    const res = await post("/update/check", { force: true });
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, "validation_failed");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("MNT-3 POST /maintenance/update/apply", () => {
  test("needs confirm: true: otherwise 409 confirmation_required and nothing is started", async () => {
    await boot();
    for (const body of [{}, { confirm: false }]) {
      const res = await post("/update/apply", body);
      assert.equal(res.status, 409);
      assert.equal(res.json.error.code, "confirmation_required");
      assert.equal(res.json.error.params.confirm, "update_apply");
    }
    assert.equal((await post("/update/apply", { confirm: "yes" })).status, 422);
    assert.equal(updater.applyCalls.length, 0);
    assert.equal((await auditRows("update.apply")).length, 0);
  });

  test("409 update_unavailable with params.blockers when the install cannot update itself", async () => {
    await boot();
    updater.info = { ...updater.info, canSelfUpdate: false, blockers: ["dirty_tree"] };
    const res = await post("/update/apply", { confirm: true });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, "update_unavailable");
    assert.deepEqual(res.json.error.params.blockers, ["dirty_tree"]);
    assert.equal(updater.applyCalls.length, 0);

    updater.info = { ...updater.info, type: "image", blockers: ["image"] };
    assert.deepEqual((await post("/update/apply", { confirm: true })).json.error.params.blockers, ["image"]);
  });

  test("409 busy while the updater lock is held (the .update command)", async () => {
    await boot();
    updater.busy = true;
    const res = await post("/update/apply", { confirm: true });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, "busy");
    assert.equal(updater.applyCalls.length, 0);
  });

  test("202 job: the phases fetch / merge / install / verify, result { from, to, versions, restartRequired, willRestart }", async () => {
    await boot();
    const res = await post("/update/apply", { confirm: true });
    assert.equal(res.status, 202);
    assert.equal(res.json.job.type, "update.apply");
    const job = await jobDone(res.json.job.id);
    assert.equal(job.status, "done", JSON.stringify(job));
    assert.equal(job.phase, "verify", "the last phase reported by the engine");
    assert.deepEqual(job.result, { from: "1.0.0", to: "1.1.0", versions: { from: "1.0.0", to: "1.1.0" }, restartRequired: true, willRestart: false, upToDate: false });
    assert.deepEqual(updater.applyCalls, [{ actor: "admin" }]);
    const rows = await auditRows("update.apply");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, "ok");
    assert.equal(rows[0].target, "1.0.0->1.1.0");
  });

  test("unsupervised (U6): no exit is scheduled and the update_restart banner asks for a manual restart", async () => {
    await boot();
    assert.equal((await http.get("/admin/api/state")).json.banners.some((b) => b.id === "update_restart"), false);
    const job = await jobDone((await post("/update/apply", { confirm: true })).json.job.id);
    assert.equal(job.result.willRestart, false);
    assert.equal(updater.exitScheduled, 0, "the process keeps running");
    const banner = (await http.get("/admin/api/state")).json.banners.find((b) => b.id === "update_restart");
    assert.deepEqual(banner, { id: "update_restart", severity: "warn", params: { from: "1.0.0", to: "1.1.0" } });
    assert.equal((await http.get(`${A}/update`)).json.restartRequired, true);

    updater.restart = { required: false, from: null, to: null, reason: null };
    assert.equal((await http.get("/admin/api/state")).json.banners.some((b) => b.id === "update_restart"), false, "cleared once the process restarts");
  });

  test("supervised: willRestart is true and the exit is scheduled once the result is recorded", async () => {
    await boot();
    updater.info.supervised = true;
    const job = await jobDone((await post("/update/apply", { confirm: true })).json.job.id);
    assert.equal(job.result.willRestart, true);
    assert.equal(updater.exitScheduled, 1);
    assert.equal((await auditRows("update.apply")).length, 1, "the audit row is written before the exit");
  });

  test("an up-to-date answer schedules no exit even when supervised", async () => {
    await boot();
    updater.info.supervised = true;
    updater.applyImpl = async () => ({ ok: true, from: "1.0.0", to: "1.0.0", upToDate: true, phase: "done", restartRequired: false, willRestart: false, rolledBack: false });
    const job = await jobDone((await post("/update/apply", { confirm: true })).json.job.id);
    assert.equal(job.result.upToDate, true);
    assert.equal(updater.exitScheduled, 0);
  });

  test("a failed update is a failed job update_failed with phase, reason and rolledBack; the bot stays on its version", async () => {
    await boot();
    updater.applyImpl = async () => ({ ok: false, from: "1.0.0", to: "1.1.0", phase: "install", reason: "install_failed", rolledBack: true, stderr: FAKE_STDERR });
    const res = await post("/update/apply", { confirm: true });
    assert.equal(res.status, 202);
    const job = await jobDone(res.json.job.id);
    assert.equal(job.status, "failed");
    assert.deepEqual(job.error, { code: "update_failed", params: { phase: "install", reason: "install_failed", rolledBack: true } });
    assert.equal(JSON.stringify(job).includes(FAKE_STDERR), false);
    assert.equal(updater.exitScheduled, 0);
    const rows = await auditRows("update.apply");
    assert.equal(rows[0].result, "fail");
    assert.deepEqual(JSON.parse(rows[0].detail), { phase: "install", reason: "install_failed", rolledBack: true });
  });

  test("heavy jobs are exclusive: while an update runs, a second one and a yt-dlp update answer 409 busy", async () => {
    await boot();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    updater.applyImpl = async () => {
      await gate;
      return { ok: true, from: "1.0.0", to: "1.1.0", upToDate: false, phase: "done", restartRequired: true, willRestart: false, rolledBack: false };
    };
    const first = await post("/update/apply", { confirm: true });
    assert.equal(first.status, 202);
    assert.equal((await post("/update/apply", { confirm: true })).json.error.code, "busy");
    const other = await post("/ytdlp/update", { confirm: true });
    assert.equal(other.status, 409);
    assert.equal(other.json.error.code, "busy");
    assert.equal(ytdlp.calls, 0);
    release();
    assert.equal((await jobDone(first.json.job.id)).status, "done");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("MNT-4 GET /maintenance/ytdlp", () => {
  test("{ command, version, selfUpdatable, reason, activeDownloads, latest }: the command name, never the path", async () => {
    await boot();
    downloader.active = 1;
    const res = await http.get(`${A}/ytdlp`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { command: "yt-dlp", version: "2024.04.09", selfUpdatable: "likely", reason: null, activeDownloads: 1, latest: null });
    assert.equal(res.text.includes(SECRET_PATH), false);
    assert.equal(res.text.includes("private-bin"), false);
  });

  test("a managed install reports why", async () => {
    await boot();
    ytdlp.inspected = { selfUpdatable: "no", reason: "package_managed", version: "2024.04.09", hint: "apt" };
    const body = (await http.get(`${A}/ytdlp`)).json;
    assert.equal(body.selfUpdatable, "no");
    assert.equal(body.reason, "package_managed");
  });

  test("a missing binary", async () => {
    await boot();
    ytdlp.inspected = { selfUpdatable: "missing", version: null, hint: null };
    const body = (await http.get(`${A}/ytdlp`)).json;
    assert.equal(body.selfUpdatable, "missing");
    assert.equal(body.version, null);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("MNT-5 POST /maintenance/ytdlp/update", () => {
  test("needs confirm: true", async () => {
    await boot();
    const res = await post("/ytdlp/update", {});
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, "confirmation_required");
    assert.equal(ytdlp.calls, 0);
  });

  test("409 downloads_active while downloads run; nothing is started", async () => {
    await boot();
    downloader.active = 2;
    const res = await post("/ytdlp/update", { confirm: true });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, "downloads_active");
    assert.equal(ytdlp.calls, 0);
  });

  test("409 busy while another yt-dlp update runs", async () => {
    await boot();
    ytdlp.updating = true;
    assert.equal((await post("/ytdlp/update", { confirm: true })).json.error.code, "busy");
  });

  test("the verdicts are results of the job, not errors: { verdict, from, to, hint }", async () => {
    await boot();
    const cases = [
      [{ outcome: "updated", before: "2024.04.09", after: "2025.01.01" }, { selfUpdatable: "likely", hint: "rebuild_image" }, { verdict: "updated", from: "2024.04.09", to: "2025.01.01", hint: "rebuild_image" }, "ok"],
      [{ outcome: "up_to_date", before: "2025.01.01", after: "2025.01.01" }, { selfUpdatable: "likely", hint: null }, { verdict: "up_to_date", from: "2025.01.01", to: "2025.01.01", hint: null }, "ok"],
      [{ outcome: "managed_externally", before: "2024.04.09", after: "2024.04.09" }, { selfUpdatable: "no", reason: "package_managed", hint: "apt" }, { verdict: "managed_externally", from: "2024.04.09", to: "2024.04.09", hint: "apt" }, "fail"],
      [{ outcome: "read_only", before: "2024.04.09", after: "2024.04.09" }, { selfUpdatable: "no", reason: "read_only", hint: "official_binary" }, { verdict: "read_only", from: "2024.04.09", to: "2024.04.09", hint: "official_binary" }, "fail"],
      [{ outcome: "unreachable", before: "2024.04.09", after: "2024.04.09" }, { selfUpdatable: "likely", hint: "pip" }, { verdict: "unreachable", from: "2024.04.09", to: "2024.04.09", hint: null }, "fail"],
      [{ outcome: "failed", before: "2024.04.09", after: "2024.04.09" }, { selfUpdatable: "likely", hint: null }, { verdict: "failed", from: "2024.04.09", to: "2024.04.09", hint: null }, "fail"],
      [{ outcome: "missing", before: null, after: null }, { selfUpdatable: "missing", version: null, hint: null }, { verdict: "missing", from: null, to: null, hint: null }, "fail"],
    ];
    let expectedAudit = 0;
    for (const [outcome, inspected, expected, auditResult] of cases) {
      ytdlp.outcome = outcome;
      ytdlp.inspected = { version: outcome.before, ...inspected };
      const res = await post("/ytdlp/update", { confirm: true });
      assert.equal(res.status, 202, JSON.stringify(res.json));
      assert.equal(res.json.job.type, "ytdlp.update");
      const job = await jobDone(res.json.job.id);
      assert.equal(job.status, "done", `${outcome.outcome}: a verdict is a result, not an error`);
      assert.deepEqual(job.result, expected, outcome.outcome);
      expectedAudit += 1;
      const rows = await auditRows("ytdlp.update");
      assert.equal(rows.length, expectedAudit);
      assert.equal(rows[rows.length - 1].result, auditResult, outcome.outcome);
      assert.equal(JSON.parse(rows[rows.length - 1].detail).verdict, outcome.outcome);
    }
    // the path of the binary never appears in a job or an audit row
    const dump = JSON.stringify([await t.db.AuditLog.findAll({ raw: true }), (await http.get("/admin/api/jobs/1")).json]);
    assert.equal(dump.includes(SECRET_PATH), false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("MNT-6 GET /maintenance/storage", () => {
  const write = (rel, text) => {
    const file = path.join(dirs.root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };

  test("the six categories and the free disk", async () => {
    await boot();
    write("logs/out.log", "l".repeat(25));
    write("media/temp/a.bin", "a".repeat(10));
    const res = await http.get(`${A}/storage`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.categories.map((c) => c.id), ["temp_media", "broadcast_media", "antidelete_cache", "panel_backups", "logs", "database"]);
    for (const c of res.json.categories) {
      assert.deepEqual(Object.keys(c).sort(), ["bytes", "dialect", "files", "id", "items", "measuredAt", "protectedBytes", "protectedItems", "purgeable", "truncated", "unit"].sort(), c.id);
    }
    const by = Object.fromEntries(res.json.categories.map((c) => [c.id, c]));
    assert.equal(by.logs.bytes, 25);
    assert.equal(by.temp_media.bytes, 10);
    assert.equal(by.antidelete_cache.unit, "messages");
    assert.equal(by.database.purgeable, false);
    assert.equal(by.broadcast_media.protectedBytes, 0);
    assert.deepEqual(Object.keys(res.json.disk).sort(), ["freeBytes", "totalBytes"]);
  });

  test("?refresh=1 re-measures, limited to one per 5 s (429); an invalid value is 422", async () => {
    await boot();
    write("logs/out.log", "1234567890");
    assert.equal((await http.get(`${A}/storage?refresh=1`)).status, 200);
    write("logs/more.log", "x".repeat(40));
    assert.equal((await http.get(`${A}/storage`)).json.categories.find((c) => c.id === "logs").bytes, 10, "cached 30 s");

    const limited = await http.get(`${A}/storage?refresh=1`);
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error.code, "rate_limited");
    assert.ok(limited.json.error.params.retryAfterMs > 0 && limited.json.error.params.retryAfterMs <= 5000);

    await t.clock.advance(5000);
    const fresh = await http.get(`${A}/storage?refresh=1`);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.json.categories.find((c) => c.id === "logs").bytes, 50);

    assert.equal((await http.get(`${A}/storage?refresh=maybe`)).status, 422);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("MNT-7 POST /maintenance/storage/:category/purge", () => {
  const logFile = () => path.join(dirs.root, "logs", "out.log");

  test("needs confirm: true; otherwise 409 and nothing is deleted", async () => {
    await boot();
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    fs.writeFileSync(logFile(), "keep");
    for (const body of [{}, { confirm: false }]) {
      const res = await post("/storage/logs/purge", body);
      assert.equal(res.status, 409);
      assert.equal(res.json.error.code, "confirmation_required");
    }
    assert.equal(fs.readFileSync(logFile(), "utf8"), "keep");
    assert.equal((await auditRows("storage.purge")).length, 0);
  });

  test("200 { freedBytes, removed, skipped }; logs are truncated; audited with the category", async () => {
    await boot();
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    fs.writeFileSync(logFile(), "x".repeat(64));
    const res = await post("/storage/logs/purge", { confirm: true });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { freedBytes: 64, removed: 1, skipped: 0 });
    assert.equal(fs.statSync(logFile()).size, 0);
    const rows = await auditRows("storage.purge");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target, "logs");
    assert.deepEqual(JSON.parse(rows[0].detail), { freedBytes: 64, removed: 1, skipped: 0 });
    // the space reads zero at the next list
    assert.equal((await http.get(`${A}/storage`)).json.categories.find((c) => c.id === "logs").bytes, 0);
  });

  test("broadcast_media reports the media it kept in skipped and never fails for them", async () => {
    await boot();
    const res = await post("/storage/broadcast_media/purge", { confirm: true });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { freedBytes: 0, removed: 0, skipped: 3 });
    assert.equal(broadcaster.calls, 1);
  });

  test("422 not_purgeable for the database; 404 for an unknown category", async () => {
    await boot();
    const database = await post("/storage/database/purge", { confirm: true });
    assert.equal(database.status, 422);
    assert.equal(database.json.error.code, "not_purgeable");
    const unknown = await post("/storage/sessions/purge", { confirm: true });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error.code, "not_found");
    assert.equal(unknown.json.error.params.resource, "category");
    // a path never reaches the service: the segment must be a plain name
    assert.equal((await post("/storage/..%2Fdata/purge", { confirm: true })).status, 404);
    assert.equal((await auditRows("storage.purge")).length, 0);
  });

  test("409 busy for a purge of the same category already running", async () => {
    await boot();
    let release;
    broadcaster.gate = new Promise((resolve) => (release = resolve));
    const first = post("/storage/broadcast_media/purge", { confirm: true });
    await fakes.waitFor(() => broadcaster.calls === 1);
    const second = await post("/storage/broadcast_media/purge", { confirm: true });
    assert.equal(second.status, 409);
    assert.equal(second.json.error.code, "busy");
    release();
    assert.equal((await first).status, 200);
  });

  test("the antidelete cache is emptied through the handler", async () => {
    await boot();
    const res = await post("/storage/antidelete_cache/purge", { confirm: true });
    assert.deepEqual(res.json, { freedBytes: 80, removed: 4, skipped: 0 });
  });

  test("GET on a purge path is not allowed (405)", async () => {
    await boot();
    assert.equal((await http.get(`${A}/storage/logs/purge`)).status, 405);
  });
});
