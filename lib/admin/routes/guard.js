"use strict";

/**
 * Group guard and mute routes (admin-http-api.md section 2.8). The logic is lib/admin/services/groups.js; the
 * enforcement of the switches is the hook-only plugins/groupguard.js, not an HTTP concern.
 *
 *   PUT /admin/api/groups/:jid/guard   GRD-1  { antilink?, antibot? } -> { antilink, antibot, warnings }  audit group.guard
 *   PUT /admin/api/groups/:jid/mute    GRD-2  { muted }               -> { muted }                        audit group.mute
 *
 * GRD-1 saves the switches even when the bot is not a group administrator (`warnings: ["bot_not_admin"]`, FR-032).
 * GRD-2 calls `groupSettingUpdate` and only a success writes `Group.mute`: `409 bot_not_admin`, `409 not_connected`,
 * `409 group_left`, `502 whatsapp_error`.
 */

const { AdminError } = require("../http/response");

function register({ router, deps }) {
  const { groupsServiceOf } = require("../services/groups");
  const groups = () => groupsServiceOf(deps);

  router.route({
    method: "PUT",
    path: "/admin/api/groups/:jid/guard",
    auth: "session",
    schema: { antilink: { type: "boolean" }, antibot: { type: "boolean" } },
    handler: async (ctx) => {
      if (ctx.body.antilink === undefined && ctx.body.antibot === undefined) {
        throw new AdminError("validation_failed", {
          fields: { antilink: { code: "required" }, antibot: { code: "required" } },
        });
      }
      const { result, changed } = await groups().setGuard(ctx.params.jid, ctx.body);
      await ctx.audit("group.guard", ctx.params.jid, "ok", changed);
      return result;
    },
  });

  router.route({
    method: "PUT",
    path: "/admin/api/groups/:jid/mute",
    auth: "session",
    schema: { muted: { type: "boolean", required: true } },
    handler: async (ctx) => {
      const result = await groups().setMute(ctx.params.jid, ctx.body.muted);
      await ctx.audit("group.mute", ctx.params.jid, "ok", { muted: result.muted });
      return result;
    },
  });
}

module.exports = { register };
