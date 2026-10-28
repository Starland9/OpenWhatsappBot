"use strict";

/**
 * Data routes (admin-http-api.md section 2.10): what the bot's commands keep in the database, seen and cleaned
 * from the panel (FR-042 to FR-045).
 *
 *   GET    /admin/api/data/:kind?page&pageSize&q&chat&groupJid&status   DATA-1  { items, page, pageSize, total }
 *   DELETE /admin/api/data/:kind/:id                                    DATA-2  { cancelled: true } | { deleted: true }
 *   POST   /admin/api/data/economy/adjust                               DATA-3  { balance, delta }
 *
 * `:kind` is reminders, economy, keywords, sticker-commands, afk, tasks, ideas or quotes; any other value is a
 * 404. `:id` is the numeric id, except for `afk` where it is the user JID. DATA-2 is audited as `data.delete`
 * (`<kind>:<id>`); DATA-3 as `economy.adjust`, written by the service inside the transaction of the adjustment so
 * the history row and the balance commit or fail together. The logic is lib/admin/services/data.js.
 */

const { createDataService, KINDS } = require("../services/data");
const { AdminError } = require("../http/response");

/** A numeric id, or a user JID (afk): the kind decides which one is valid, the service answers 404 otherwise */
const ID = /^(?:[1-9]\d{0,9}|\d{5,20}(?::\d{1,4})?(?:@(?:s\.whatsapp\.net|lid))?)$/;

function register({ router, deps }) {
  const service = createDataService(deps);

  /** 404 for a kind the route does not serve (before anything is read) */
  const checkKind = (kind) => {
    if (!KINDS.includes(kind)) throw new AdminError("not_found", { params: { resource: "kind" } });
    return kind;
  };

  router.route({
    method: "GET",
    path: "/admin/api/data/:kind",
    auth: "session",
    query: {
      page: { type: "string", pattern: /^[1-9]\d{0,5}$/ },
      pageSize: { type: "string", pattern: /^[1-9]\d{0,3}$/ },
      q: { type: "string", maxLength: 100, trim: true },
      chat: { type: "string", maxLength: 64 },
      groupJid: { type: "string", maxLength: 64 },
      status: { type: "string", enum: ["pending", "all"] },
    },
    handler: (ctx) => service.list(checkKind(ctx.params.kind), ctx.query),
  });

  // The literal segment wins over `:kind/:id` for this POST (a different method anyway)
  router.route({
    method: "POST",
    path: "/admin/api/data/economy/adjust",
    auth: "session",
    schema: {
      groupJid: { type: "string", required: true, maxLength: 64 },
      userJid: { type: "string", required: true, maxLength: 64 },
      mode: { type: "string", required: true, enum: ["set", "add"] },
      amount: { type: "int", required: true, min: -2000000000, max: 2000000000 },
      reason: { type: "string", required: true, minLength: 1, maxLength: 200, trim: true },
    },
    handler: (ctx) => service.adjustEconomy(ctx.body, { origin: ctx.origin }),
  });

  router.route({
    method: "DELETE",
    path: "/admin/api/data/:kind/:id",
    auth: "session",
    params: { id: ID },
    handler: async (ctx) => {
      const kind = checkKind(ctx.params.kind);
      const result = await service.remove(kind, ctx.params.id);
      await ctx.audit("data.delete", `${kind}:${ctx.params.id}`, "ok", result.cancelled ? { cancelled: true } : undefined);
      return result;
    },
  });
}

module.exports = { register };
