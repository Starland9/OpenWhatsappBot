"use strict";

/**
 * Update and download-tools pages (US11, FR-054, FR-055; admin-http-api.md MNT-1..MNT-5; contracts/runtime.md
 * section 11). The engines are lib/utils/updater.js and lib/utils/ytdlpUpdate.js; this service shapes their
 * answers for HTTP, runs them as jobs, and keeps two small throttles. Storage (MNT-6, MNT-7) is
 * lib/admin/services/storage.js.
 *
 *   const service = createMaintenanceService(deps);
 *   await service.describeUpdate()            MNT-1 object
 *   service.takeCheckSlot(now)                1 update check per 30 s, else rate_limited (retryAfterMs)
 *   await service.runCheck(handle)            body of the `update.check` job   -> the MNT-1 object
 *   await service.assertCanApply()            update_unavailable (params.blockers) | busy, before the 202
 *   await service.runApply(handle, { actor }) body of the `update.apply` job   -> { from, to, versions, ... }
 *   await service.describeYtdlp()             MNT-4 object
 *   service.assertCanUpdateYtdlp()            downloads_active | busy, before the 202
 *   await service.runYtdlpUpdate()            body of the `ytdlp.update` job   -> { verdict, from, to, hint }
 *   service.bannerProvider()                  `update_restart` for state.addBannerProvider
 *
 * A failed job throws an error that carries a snake_case `code` and `params`, which the job registry keeps:
 *   update_check_failed   params.reason: no_git_binary, dubious_ownership, detached, no_remote_branch, unreachable, busy
 *   update_failed         params.phase (fetch|merge|install|verify), params.reason, params.rolledBack
 * The yt-dlp outcomes are verdicts in the job result, not errors. Raw git, yarn and yt-dlp output never leaves the
 * engines' logs; `YTDLP_PATH` never leaves this service (only the command name does).
 *
 * DEPS (all optional, looked up when used): updater, ytdlpUpdate, downloader, config, clock, logger.
 */

const { AdminError } = require("../http/response");

const CHECK_GAP_MS = 30 * 1000;
const COMMITS_SHOWN = 50;
const APPLY_PHASES = new Set(["fetch", "merge", "install", "verify"]);

/** An error the job registry keeps as `{ code, params }` */
function jobError(code, params) {
  const err = new Error(code);
  err.code = code;
  err.params = params;
  return err;
}

function createMaintenanceService(deps = {}) {
  const now = () => (deps.clock && typeof deps.clock.now === "function" ? deps.clock.now() : Date.now());
  const getUpdater = () => deps.updater || require("../../utils/updater");
  const getYtdlp = () => deps.ytdlpUpdate || require("../../utils/ytdlpUpdate");
  const getDownloader = () => deps.downloader || require("../../utils/downloader");

  let lastCheckSlot = null;

  // ----- update -----------------------------------------------------------------------------------

  /** MNT-1 (also the result of an `update.check` job) */
  async function describeUpdate() {
    const updater = getUpdater();
    const info = await updater.getInstallInfo();
    const last = typeof updater.lastCheck === "function" ? updater.lastCheck() : null;
    const restart = updater.restartRequired();
    const lastResult = typeof updater.lastApply === "function" ? updater.lastApply() : null;
    return {
      installType: info.type,
      canSelfUpdate: info.canSelfUpdate,
      blockers: info.blockers,
      branch: info.branch ?? null,
      behind: last ? last.behind : 0,
      ahead: last ? last.ahead : 0,
      localVersion: (last && last.localVersion) || (typeof updater.localVersion === "function" ? updater.localVersion() : null),
      remoteVersion: last ? last.remoteVersion ?? null : null,
      commits: last ? (last.commits || []).slice(0, COMMITS_SHOWN).map(({ hash, subject }) => ({ sha: hash, subject })) : [],
      checkedAt: last ? last.checkedAt : null,
      restartRequired: Boolean(restart && restart.required),
      supervised: Boolean(info.supervised),
      lastResult: lastResult
        ? { ok: lastResult.ok, from: lastResult.from ?? null, to: lastResult.to ?? null, at: lastResult.at, phase: lastResult.phase, reason: lastResult.reason ?? null, rolledBack: Boolean(lastResult.rolledBack) }
        : null,
    };
  }

  /** MNT-2 throttle: one check per 30 s */
  function takeCheckSlot(at = now()) {
    if (lastCheckSlot !== null && at - lastCheckSlot < CHECK_GAP_MS) {
      throw new AdminError("rate_limited", { params: { retryAfterMs: CHECK_GAP_MS - (at - lastCheckSlot) } });
    }
    lastCheckSlot = at;
  }

  async function runCheck(handle) {
    const updater = getUpdater();
    if (handle) handle.setPhase("fetch");
    try {
      await updater.check({ force: true });
    } catch (err) {
      const reason = err && err.params && err.params.reason ? err.params.reason : "unreachable";
      throw jobError("update_check_failed", { reason });
    }
    return describeUpdate();
  }

  /** Before the 202 of MNT-3: the install can update itself and nothing else is updating */
  async function assertCanApply() {
    const updater = getUpdater();
    const info = await updater.getInstallInfo();
    if (!info.canSelfUpdate) throw new AdminError("update_unavailable", { params: { blockers: info.blockers } });
    if (updater.isBusy()) throw new AdminError("busy", { params: { type: "update.apply" } });
    return info;
  }

  /**
   * Body of the `update.apply` job. Supervised: the exit is scheduled once the job has its result, so the browser
   * hears `done` first (the engine ends the process about 1 s later). Unsupervised (U6): nothing exits.
   */
  async function runApply(handle, { actor, beforeResult } = {}) {
    const updater = getUpdater();
    const outcome = await updater.apply({
      actor,
      onProgress: ({ phase }) => {
        if (handle && APPLY_PHASES.has(phase)) handle.setPhase(phase);
      },
    });
    if (!outcome.ok) {
      throw jobError("update_failed", { phase: outcome.phase, reason: outcome.reason, rolledBack: Boolean(outcome.rolledBack) });
    }
    const result = {
      from: outcome.from,
      to: outcome.to,
      versions: { from: outcome.from, to: outcome.to },
      restartRequired: Boolean(outcome.restartRequired),
      willRestart: Boolean(outcome.willRestart),
      upToDate: Boolean(outcome.upToDate),
    };
    if (typeof beforeResult === "function") await beforeResult(result); // the audit row is written before any exit
    if (result.willRestart && !result.upToDate) updater.scheduleExit();
    return result;
  }

  // ----- yt-dlp -----------------------------------------------------------------------------------

  async function describeYtdlp() {
    const ytdlp = getYtdlp();
    const inspected = await ytdlp.inspect();
    return {
      command: typeof ytdlp.command === "function" ? ytdlp.command() : "yt-dlp",
      version: inspected.version ?? null,
      selfUpdatable: inspected.selfUpdatable,
      reason: inspected.reason ?? null,
      activeDownloads: getDownloader().getActiveDownloads(),
      latest: null, // the optional "latest release" lookup is not made: one GitHub call per page view is not worth it
    };
  }

  function assertCanUpdateYtdlp() {
    if (getDownloader().getActiveDownloads() > 0) throw new AdminError("downloads_active");
    const ytdlp = getYtdlp();
    if (typeof ytdlp.isUpdating === "function" && ytdlp.isUpdating()) throw new AdminError("busy", { params: { type: "ytdlp.update" } });
  }

  async function runYtdlpUpdate() {
    const ytdlp = getYtdlp();
    const inspected = await ytdlp.inspect();
    const outcome = await ytdlp.update(); // one step, no phase to report
    const verdict = outcome.outcome;
    // instructions depend on the verdict: where the binary lives, or the container's writable layer
    const withHint = ["managed_externally", "read_only", "updated"].includes(verdict);
    return { verdict, from: outcome.before ?? null, to: outcome.after ?? null, hint: withHint ? inspected.hint ?? null : null };
  }

  // ----- banner -----------------------------------------------------------------------------------

  /** `update_restart` of admin-http-api.md 3.3: an update was applied and nothing restarts the process */
  function bannerProvider() {
    const updater = getUpdater();
    const verdict = updater.restartRequired();
    if (!verdict || verdict.required !== true) return null;
    return { id: "update_restart", severity: "warn", params: { from: verdict.from ?? null, to: verdict.to ?? null } };
  }

  return {
    describeUpdate,
    takeCheckSlot,
    runCheck,
    assertCanApply,
    runApply,
    describeYtdlp,
    assertCanUpdateYtdlp,
    runYtdlpUpdate,
    bannerProvider,
  };
}

module.exports = { createMaintenanceService, CHECK_GAP_MS };
