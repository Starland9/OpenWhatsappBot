"use strict";

/**
 * Maintenance routes (US11; admin-http-api.md 2.14, FR-054, FR-055, FR-056). The logic is in
 * lib/admin/services/maintenance.js (update, yt-dlp) and lib/admin/services/storage.js.
 *
 *   MNT-1  GET  /admin/api/maintenance/update                      session, db:r   install type, blockers, versions, changes
 *   MNT-2  POST /admin/api/maintenance/update/check                session, job    `update.check`, 1 per 30 s (429)
 *   MNT-3  POST /admin/api/maintenance/update/apply                session, confirm, job   `update.apply`
 *   MNT-4  GET  /admin/api/maintenance/ytdlp                       session, db:r
 *   MNT-5  POST /admin/api/maintenance/ytdlp/update                session, confirm, job   `ytdlp.update`
 *   MNT-6  GET  /admin/api/maintenance/storage?refresh=1           session, db:r   the six categories + free disk
 *   MNT-7  POST /admin/api/maintenance/storage/:category/purge     session, confirm
 *
 * Audit (admin-http-api.md 1.15): `update.check`, `update.apply`, `ytdlp.update` are written when the job ends (ok
 * or fail, with the versions as target), `storage.purge` with the category as target. The `update_restart` banner
 * (an update was applied and no supervisor restarts the process) is added to the dashboard state here.
 *
 * Engines are resolved lazily: `deps.updater`, `deps.ytdlpUpdate`, `deps.storage` replace them in tests.
 */

const { AdminError, reply } = require("../http/response");
const { createMaintenanceService } = require("../services/maintenance");
const { createStorageService } = require("../services/storage");
const { getStateService } = require("../services/state");

const CONFIRM_BODY = { confirm: { type: "boolean" } };
const REFRESH_QUERY = { refresh: { type: "string", enum: ["0", "1", "true", "false"] } };

function requireConfirm(ctx, what) {
  if (ctx.body.confirm !== true) throw new AdminError("confirmation_required", { params: { confirm: what } });
}

function register({ router, deps, jobs, audit, onStop }) {
  const service = deps.maintenanceService || createMaintenanceService(deps);
  const storage = deps.storage || createStorageService(deps);

  // the banner comes from the same source as the dashboard's own check; the first banner of an id wins
  const removeBanner = getStateService(deps).addBannerProvider(() => service.bannerProvider());
  onStop(() => removeBanner());

  // ---- MNT-1 ------------------------------------------------------------------------------------
  router.route({
    method: "GET",
    path: "/admin/api/maintenance/update",
    auth: "session",
    db: "optional",
    handler: () => service.describeUpdate(),
  });

  // ---- MNT-2 ------------------------------------------------------------------------------------
  router.route({
    method: "POST",
    path: "/admin/api/maintenance/update/check",
    auth: "session",
    handler: async (ctx) => {
      service.takeCheckSlot(ctx.now);
      const origin = ctx.origin;
      const job = jobs.start(
        "update.check",
        async (handle) => {
          try {
            const result = await service.runCheck(handle);
            await audit.record({ action: "update.check", target: result.remoteVersion || null, origin, result: "ok", detail: { behind: result.behind } });
            return result;
          } catch (err) {
            await audit.record({ action: "update.check", target: null, origin, result: "fail", detail: { reason: err && err.params ? err.params.reason : "failed" } });
            throw err;
          }
        },
        { failureCode: "update_check_failed" },
      );
      return reply(202, { job });
    },
  });

  // ---- MNT-3 ------------------------------------------------------------------------------------
  router.route({
    method: "POST",
    path: "/admin/api/maintenance/update/apply",
    auth: "session",
    schema: CONFIRM_BODY,
    handler: async (ctx) => {
      requireConfirm(ctx, "update_apply");
      await service.assertCanApply(); // update_unavailable (params.blockers) | busy
      const origin = ctx.origin;
      const job = jobs.start(
        "update.apply",
        async (handle) => {
          try {
            return await service.runApply(handle, {
              actor: "admin",
              beforeResult: (result) =>
                audit.record({
                  action: "update.apply",
                  target: `${result.from}->${result.to}`,
                  origin,
                  result: "ok",
                  detail: { upToDate: result.upToDate, willRestart: result.willRestart },
                }),
            });
          } catch (err) {
            await audit.record({ action: "update.apply", target: null, origin, result: "fail", detail: err && err.params ? err.params : { reason: "failed" } });
            throw err;
          }
        },
        { failureCode: "update_failed" },
      );
      return reply(202, { job });
    },
  });

  // ---- MNT-4 ------------------------------------------------------------------------------------
  router.route({
    method: "GET",
    path: "/admin/api/maintenance/ytdlp",
    auth: "session",
    db: "optional",
    handler: () => service.describeYtdlp(),
  });

  // ---- MNT-5 ------------------------------------------------------------------------------------
  router.route({
    method: "POST",
    path: "/admin/api/maintenance/ytdlp/update",
    auth: "session",
    schema: CONFIRM_BODY,
    handler: async (ctx) => {
      requireConfirm(ctx, "ytdlp_update");
      service.assertCanUpdateYtdlp(); // downloads_active | busy
      const origin = ctx.origin;
      const job = jobs.start(
        "ytdlp.update",
        async () => {
          try {
            const result = await service.runYtdlpUpdate();
            const ok = result.verdict === "updated" || result.verdict === "up_to_date";
            await audit.record({
              action: "ytdlp.update",
              target: result.from && result.to ? `${result.from}->${result.to}` : null,
              origin,
              result: ok ? "ok" : "fail",
              detail: { verdict: result.verdict },
            });
            return result;
          } catch (err) {
            await audit.record({ action: "ytdlp.update", target: null, origin, result: "fail", detail: { verdict: "failed" } });
            throw err;
          }
        },
        { failureCode: "internal_error" },
      );
      return reply(202, { job });
    },
  });

  // ---- MNT-6 ------------------------------------------------------------------------------------
  router.route({
    method: "GET",
    path: "/admin/api/maintenance/storage",
    auth: "session",
    db: "optional",
    query: REFRESH_QUERY,
    handler: (ctx) => storage.list({ refresh: ctx.query.refresh === "1" || ctx.query.refresh === "true" }),
  });

  // ---- MNT-7 ------------------------------------------------------------------------------------
  router.route({
    method: "POST",
    path: "/admin/api/maintenance/storage/:category/purge",
    auth: "session",
    schema: CONFIRM_BODY,
    handler: async (ctx) => {
      // unknown category (404) and the database (422) answer before the confirmation, as the service orders them
      const result = await storage.purge(ctx.params.category, { confirm: ctx.body.confirm === true, actor: "admin", now: ctx.now });
      await ctx.audit("storage.purge", ctx.params.category, "ok", { freedBytes: result.freedBytes, removed: result.removed, skipped: result.skipped });
      return result;
    },
  });
}

module.exports = { register };
