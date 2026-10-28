"use strict";

/**
 * Group routes (admin-http-api.md section 2.7, GRP-1..GRP-17). The logic is lib/admin/services/groups.js; the guard
 * and mute routes (GRD-1, GRD-2) are in guard.js and the chat picker (CHAT-1..3) in chats.js.
 *
 *   GET    /admin/api/groups                       GRP-1   ?page&pageSize&q&status
 *   POST   /admin/api/groups/refresh               GRP-2
 *   GET    /admin/api/groups/:jid                  GRP-3
 *   PATCH  /admin/api/groups/:jid                  GRP-4   audit group.update
 *   POST   /admin/api/groups/:jid/preview          GRP-5   writes nothing
 *   DELETE /admin/api/groups/:jid?confirm=true     GRP-6   audit group.delete
 *   GET    /admin/api/groups/:jid/filters          GRP-7
 *   POST   /admin/api/groups/:jid/filters          GRP-8   201, audit group.filter
 *   PUT    /admin/api/groups/:jid/filters/:id      GRP-9   audit group.filter
 *   DELETE /admin/api/groups/:jid/filters/:id      GRP-10  audit group.filter
 *   GET    /admin/api/groups/:jid/members          GRP-11
 *   GET    /admin/api/groups/:jid/roles            GRP-12
 *   PUT    /admin/api/groups/:jid/roles/:userJid   GRP-13  audit group.role
 *   GET    /admin/api/groups/:jid/warnings         GRP-14
 *   DELETE /admin/api/groups/:jid/warnings/:userJid GRP-15 audit group.warnings
 *   DELETE /admin/api/groups/:jid/warnings?confirm=true GRP-16 audit group.warnings
 *   PATCH  /admin/api/groups/:jid/commands         GRP-17  audit command.toggle (one row per command changed)
 *
 * Every route needs the session (and the CSRF token for the unsafe methods) and the database. Schemas are strict: an
 * unknown property is a 422 `fields.$unknown`. A group that has never been seen is a 404; the cache keys the writes
 * invalidate are the service's business.
 */

const { AdminError, reply } = require("../http/response");
const { validate } = require("../http/request");

const CONFIRM_QUERY = { confirm: { type: "string", enum: ["true", "false"] } };

/**
 * A member in a path: a phone number or a LID, bare or with its server (normalised later by `normalizeJid`).
 * Looser than the router's default (`\d{5,20}`) on purpose: it also takes the short numbers of the test fakes
 * (`111@s.whatsapp.net`), which the route enumeration of test/admin-security.test.js samples with.
 */
const MEMBER_JID = /^\d{3,20}(?::\d{1,4})?(?:@(?:s\.whatsapp\.net|lid))?$/;

/** `?confirm=true` of a DELETE (admin-http-api.md 1.10) */
function requireConfirm(ctx, what) {
  if (ctx.query.confirm !== "true") throw new AdminError("confirmation_required", { params: { confirm: what } });
}

/**
 * Validate a nested body object (`welcome`, `goodbye`) with its own strict schema; its field errors are keyed
 * `welcome.message`, an unknown nested property is `$unknown` like at the top level.
 */
function nested(name, value, schema) {
  try {
    return validate(value, schema);
  } catch (err) {
    if (err instanceof AdminError && err.code === "validation_failed" && err.fields) {
      const fields = {};
      for (const [key, detail] of Object.entries(err.fields)) fields[key === "$unknown" ? key : `${name}.${key}`] = detail;
      throw new AdminError("validation_failed", { fields });
    }
    throw err;
  }
}

const TEMPLATE_PART = {
  enabled: { type: "boolean" },
  message: { type: "string", nullable: true, trim: true, minLength: 1, maxLength: 1000 },
};

const FILTER_BODY = {
  pattern: { type: "string", required: true, trim: true, maxLength: 1000 },
  response: { type: "string", required: true, trim: true, maxLength: 5000 },
};

function register({ router, deps, onStart, onStop }) {
  const { groupsServiceOf } = require("../services/groups");
  const groups = groupsServiceOf(deps); // guard.js and chats.js share the instance

  onStart(() => groups.start());
  onStop(() => groups.stop());

  // ---- GRP-1 / GRP-2 ---------------------------------------------------------------------------
  router.route({
    method: "GET",
    path: "/admin/api/groups",
    auth: "session",
    query: {
      page: { type: "string", pattern: /^\d{1,6}$/ },
      pageSize: { type: "string", pattern: /^\d{1,4}$/ },
      q: { type: "string", maxLength: 100 },
      status: { type: "string", enum: ["all", "current", "former"] },
    },
    handler: (ctx) => groups.list(ctx.query),
  });

  router.route({
    method: "POST",
    path: "/admin/api/groups/refresh",
    auth: "session",
    handler: () => groups.refresh(),
  });

  // ---- GRP-3 .. GRP-6 --------------------------------------------------------------------------
  router.route({
    method: "GET",
    path: "/admin/api/groups/:jid",
    auth: "session",
    handler: (ctx) => groups.describe(ctx.params.jid),
  });

  router.route({
    method: "PATCH",
    path: "/admin/api/groups/:jid",
    auth: "session",
    schema: {
      welcome: { type: "object" },
      goodbye: { type: "object" },
      disabled: { type: "boolean" },
    },
    handler: async (ctx) => {
      const patch = {};
      if (ctx.body.welcome !== undefined) patch.welcome = nested("welcome", ctx.body.welcome, TEMPLATE_PART);
      if (ctx.body.goodbye !== undefined) patch.goodbye = nested("goodbye", ctx.body.goodbye, TEMPLATE_PART);
      if (ctx.body.disabled !== undefined) patch.disabled = ctx.body.disabled;
      const empty = (part) => !part || Object.keys(part).length === 0;
      if (empty(patch.welcome) && empty(patch.goodbye) && patch.disabled === undefined) {
        throw new AdminError("validation_failed", {
          fields: { welcome: { code: "required" }, goodbye: { code: "required" }, disabled: { code: "required" } },
        });
      }
      const { group, changed } = await groups.update(ctx.params.jid, patch);
      await ctx.audit("group.update", ctx.params.jid, "ok", changed);
      return group;
    },
  });

  router.route({
    method: "POST",
    path: "/admin/api/groups/:jid/preview",
    auth: "session",
    schema: {
      kind: { type: "string", required: true, enum: ["welcome", "goodbye"] },
      message: { type: "string", required: true, trim: true, minLength: 1, maxLength: 1000 },
    },
    handler: (ctx) => groups.preview(ctx.params.jid, ctx.body),
  });

  router.route({
    method: "DELETE",
    path: "/admin/api/groups/:jid",
    auth: "session",
    query: CONFIRM_QUERY,
    handler: async (ctx) => {
      requireConfirm(ctx, "group_settings");
      const result = await groups.deleteSettings(ctx.params.jid);
      await ctx.audit("group.delete", ctx.params.jid, "ok", result.deleted);
      return result;
    },
  });

  // ---- GRP-7 .. GRP-10: filters ------------------------------------------------------------------
  router.route({
    method: "GET",
    path: "/admin/api/groups/:jid/filters",
    auth: "session",
    handler: (ctx) => groups.listFilters(ctx.params.jid),
  });

  router.route({
    method: "POST",
    path: "/admin/api/groups/:jid/filters",
    auth: "session",
    schema: FILTER_BODY,
    handler: async (ctx) => {
      const filter = await groups.addFilter(ctx.params.jid, ctx.body);
      await ctx.audit("group.filter", ctx.params.jid, "ok", { op: "add", id: filter.id, pattern: filter.pattern });
      return reply(201, { filter });
    },
  });

  router.route({
    method: "PUT",
    path: "/admin/api/groups/:jid/filters/:id",
    auth: "session",
    schema: FILTER_BODY,
    handler: async (ctx) => {
      const filter = await groups.editFilter(ctx.params.jid, Number(ctx.params.id), ctx.body);
      await ctx.audit("group.filter", ctx.params.jid, "ok", { op: "update", id: filter.id, pattern: filter.pattern });
      return { filter };
    },
  });

  router.route({
    method: "DELETE",
    path: "/admin/api/groups/:jid/filters/:id",
    auth: "session",
    handler: async (ctx) => {
      const result = await groups.deleteFilter(ctx.params.jid, Number(ctx.params.id));
      await ctx.audit("group.filter", ctx.params.jid, "ok", { op: "delete", id: Number(ctx.params.id) });
      return result;
    },
  });

  // ---- GRP-11 .. GRP-13: members and roles -----------------------------------------------------------
  router.route({
    method: "GET",
    path: "/admin/api/groups/:jid/members",
    auth: "session",
    handler: (ctx) => groups.members(ctx.params.jid),
  });

  router.route({
    method: "GET",
    path: "/admin/api/groups/:jid/roles",
    auth: "session",
    handler: (ctx) => groups.listRoles(ctx.params.jid),
  });

  router.route({
    method: "PUT",
    path: "/admin/api/groups/:jid/roles/:userJid",
    auth: "session",
    params: { userJid: MEMBER_JID },
    schema: { role: { type: "string", required: true, enum: ["regular", "vip", "muted", "banned"] } },
    handler: async (ctx) => {
      const result = await groups.setRole(ctx.params.jid, ctx.params.userJid, ctx.body.role);
      await ctx.audit("group.role", ctx.params.jid, "ok", { userJid: result.userJid, role: result.role });
      return result;
    },
  });

  // ---- GRP-14 .. GRP-16: warnings ------------------------------------------------------------------------
  router.route({
    method: "GET",
    path: "/admin/api/groups/:jid/warnings",
    auth: "session",
    handler: (ctx) => groups.listWarnings(ctx.params.jid),
  });

  router.route({
    method: "DELETE",
    path: "/admin/api/groups/:jid/warnings/:userJid",
    auth: "session",
    params: { userJid: MEMBER_JID },
    handler: async (ctx) => {
      const result = await groups.resetWarnings(ctx.params.jid, ctx.params.userJid);
      await ctx.audit("group.warnings", ctx.params.jid, "ok", { op: "reset", userJid: ctx.params.userJid, reset: result.reset });
      return result;
    },
  });

  router.route({
    method: "DELETE",
    path: "/admin/api/groups/:jid/warnings",
    auth: "session",
    query: CONFIRM_QUERY,
    handler: async (ctx) => {
      requireConfirm(ctx, "group_warnings");
      const result = await groups.resetAllWarnings(ctx.params.jid);
      await ctx.audit("group.warnings", ctx.params.jid, "ok", { op: "reset_all", reset: result.reset });
      return result;
    },
  });

  // ---- GRP-17: commands disabled in this group --------------------------------------------------------------
  const NAMES = { type: "array", max: 200, items: { type: "string", trim: true, minLength: 1, maxLength: 64 } };
  router.route({
    method: "PATCH",
    path: "/admin/api/groups/:jid/commands",
    auth: "session",
    schema: { disable: NAMES, enable: NAMES },
    handler: async (ctx) => {
      const jid = ctx.params.jid;
      const result = await groups.toggleCommands(
        jid,
        { disable: ctx.body.disable || [], enable: ctx.body.enable || [] },
        { actor: "panel" },
      );
      for (const change of result.changes) {
        await ctx.audit("command.toggle", change.name, "ok", { scope: jid, disabled: change.disabled });
      }
      return { disabledCommands: result.disabledCommands, warnings: result.warnings };
    },
  });
}

module.exports = { register };
