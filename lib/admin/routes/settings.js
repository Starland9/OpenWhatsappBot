"use strict";

/**
 * Settings routes (admin-http-api.md section 2.5):
 *
 *   GET   /admin/api/settings                        SET-1  all themes, about 100 ResolvedSetting; db:r (values come
 *                                                    from the in-memory store, so it survives a database outage)
 *   PATCH /admin/api/settings                        SET-2  { changes: [{ key, op, value?, version }], confirm? },
 *                                                    1 to 50 changes with unique keys; all or nothing; audit
 *                                                    `setting.update` / `setting.reset`, one row per key
 *   POST  /admin/api/settings/keys/:service/test     SET-3  no body; { service, verdict, detail, checkedAt }; audit
 *                                                    `setting.test`
 *
 * The logic lives in lib/admin/services/{settings,keyTests}.js (engines are resolved lazily there). A route
 * only reads the request, calls the service and writes the audit rows; the API sends codes, never prose, and
 * never a secret value.
 */

const { createSettingsService } = require("../services/settings");
const { createKeyTestsService } = require("../services/keyTests");

function register({ router, deps }) {
  const settings = deps.settingsService || createSettingsService(deps);
  const keyTests = deps.keyTestsService || createKeyTestsService(deps);

  router.route({
    method: "GET",
    path: "/admin/api/settings",
    auth: "session",
    db: "optional",
    handler: () => settings.list(),
  });

  router.route({
    method: "PATCH",
    path: "/admin/api/settings",
    auth: "session",
    // `changes` items are read one by one by the service (a nested strict schema): the router checks the envelope
    schema: {
      changes: { type: "array", required: true, min: 1, max: 50, items: { type: "object" } },
      confirm: { type: "array", max: 5, items: { type: "string", enum: ["owners_empty"] } },
    },
    handler: async (ctx) => {
      const result = await settings.update(ctx.body, { actor: ctx.origin });
      for (const row of result.applied) await ctx.audit(row.action, row.target, "ok", row.detail);
      return { settings: result.settings, restartPending: result.restartPending };
    },
  });

  router.route({
    method: "POST",
    path: "/admin/api/settings/keys/:service/test",
    auth: "session",
    handler: async (ctx) => {
      const service = ctx.params.service;
      const result = await keyTests.test(service, { actor: ctx.origin });
      await ctx.audit("setting.test", service, "ok", { verdict: result.verdict, detail: result.detail });
      return { service, verdict: result.verdict, detail: result.detail, checkedAt: result.checkedAt };
    },
  });
}

module.exports = { register };
