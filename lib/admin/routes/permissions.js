"use strict";

/**
 * Command permission routes (feature 003, contracts/admin-permissions-api.md section 2, PERM-1..PERM-7). The logic is
 * lib/admin/services/permissions.js; the decision itself, at the registry, is lib/utils/commandPermissions.js.
 *
 *   GET    /admin/api/permissions                              PERM-1  every command with its rules' counts, the inert rows
 *   GET    /admin/api/commands/:name/permissions               PERM-2  one command: its `*` rule and the groups with a rule
 *   PUT    /admin/api/commands/:name/permissions/everywhere    PERM-3  audit command.permission.set
 *   DELETE /admin/api/commands/:name/permissions/everywhere    PERM-4  audit command.permission.delete
 *   GET    /admin/api/groups/:jid/permissions                  PERM-5  this group's rules and the rules that apply here
 *   PUT    /admin/api/groups/:jid/permissions/:name            PERM-6  audit command.permission.set
 *   DELETE /admin/api/groups/:jid/permissions/:name            PERM-7  audit command.permission.delete
 *
 * Every route needs the session (and the CSRF token for the unsafe methods) and the database. A PUT body is the strict
 * schema `{ mode, people }` (both required); the DELETE routes take no body and no `?confirm=true` (one rule,
 * idempotent). A route audits ONCE per request, and only when something changed. The literal path segment
 * `everywhere` stands for the scope `*`, which is not valid in a path segment.
 */

const { createPermissionsService } = require("../services/permissions");

const PERSON_MAX_LENGTH = 64;

function register({ router, deps }) {
  const { groupsServiceOf } = require("../services/groups");
  groupsServiceOf(deps); // the instance guard.js and chats.js share: the permissions service resolves it from deps
  const { MODES, MAX_PEOPLE } = deps.commandPermissions || require("../../utils/commandPermissions");
  const service = createPermissionsService(deps);

  const BODY = {
    mode: { type: "string", required: true, enum: Object.values(MODES) },
    people: { type: "array", required: true, max: MAX_PEOPLE, items: { type: "string", maxLength: PERSON_MAX_LENGTH } },
  };

  /** One audit row when the service says something changed */
  async function audited(ctx, action, result) {
    if (result.audit) await ctx.audit(action, result.audit.target, "ok", result.audit.detail);
  }

  // ---- PERM-1 --------------------------------------------------------------------------------------------
  router.route({
    method: "GET",
    path: "/admin/api/permissions",
    auth: "session",
    handler: () => service.overview(),
  });

  // ---- PERM-2 -------------------------------------------------------------------------------------------
  router.route({
    method: "GET",
    path: "/admin/api/commands/:name/permissions",
    auth: "session",
    handler: (ctx) => service.commandView(ctx.params.name),
  });

  // ---- PERM-3, PERM-4: the rule of scope `*` ---------------------------------------------------------------
  router.route({
    method: "PUT",
    path: "/admin/api/commands/:name/permissions/everywhere",
    auth: "session",
    schema: BODY,
    handler: async (ctx) => {
      const result = await service.putGlobalRule(ctx.params.name, ctx.body);
      await audited(ctx, "command.permission.set", result);
      return { rule: result.rule, changed: result.changed };
    },
  });

  router.route({
    method: "DELETE",
    path: "/admin/api/commands/:name/permissions/everywhere",
    auth: "session",
    handler: async (ctx) => {
      const result = await service.deleteGlobalRule(ctx.params.name);
      await audited(ctx, "command.permission.delete", result);
      return { deleted: result.deleted };
    },
  });

  // ---- PERM-5 .. PERM-7: one group ---------------------------------------------------------------------------
  router.route({
    method: "GET",
    path: "/admin/api/groups/:jid/permissions",
    auth: "session",
    handler: (ctx) => service.groupView(ctx.params.jid),
  });

  router.route({
    method: "PUT",
    path: "/admin/api/groups/:jid/permissions/:name",
    auth: "session",
    schema: BODY,
    handler: async (ctx) => {
      const result = await service.putGroupRule(ctx.params.jid, ctx.params.name, ctx.body);
      await audited(ctx, "command.permission.set", result);
      return { rule: result.rule, changed: result.changed };
    },
  });

  router.route({
    method: "DELETE",
    path: "/admin/api/groups/:jid/permissions/:name",
    auth: "session",
    handler: async (ctx) => {
      const result = await service.deleteGroupRule(ctx.params.jid, ctx.params.name);
      await audited(ctx, "command.permission.delete", result);
      return { deleted: result.deleted };
    },
  });
}

module.exports = { register };
