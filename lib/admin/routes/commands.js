"use strict";

/**
 * Commands routes (admin-http-api.md 2.6):
 *
 *   GET   /admin/api/commands               CMD-1  every loaded command once, plus `types` and the orphan rows
 *   PATCH /admin/api/commands/:name/state   CMD-2  body { disable?: [scope], enable?: [scope] }, scope is "*" or a
 *                                                  group JID; idempotent and set-based; audit `command.toggle` once
 *                                                  per scope whose state really changed
 *
 * The logic lives in lib/admin/services/commands.js; the state itself in lib/utils/commandState.js, so a change is
 * live at the next message (the registry reads it).
 */

const { createCommandsService, MAX_SCOPES } = require("../services/commands");

/** "*" (everywhere) or the JID of a group */
const SCOPE = /^(\*|\d{1,32}(-\d{1,32})?@g\.us)$/;

const scopeList = { type: "array", max: MAX_SCOPES, items: { type: "string", pattern: SCOPE, maxLength: 64 } };

function register({ router, deps }) {
  const service = createCommandsService(deps);

  router.route({
    method: "GET",
    path: "/admin/api/commands",
    auth: "session",
    handler: () => service.list(),
  });

  router.route({
    method: "PATCH",
    path: "/admin/api/commands/:name/state",
    auth: "session",
    schema: { disable: scopeList, enable: scopeList },
    handler: async (ctx) => {
      const { changes, ...answer } = await service.toggle(ctx.params.name, ctx.body, { actor: "admin" });
      for (const { scope, disabled } of changes) {
        await ctx.audit("command.toggle", `${answer.name}:${scope}`, "ok", { disabled });
      }
      return answer;
    },
  });
}

module.exports = { register };
