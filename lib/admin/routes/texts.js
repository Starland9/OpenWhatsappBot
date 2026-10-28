"use strict";

/**
 * Bot-text routes (admin-http-api.md section 2.15, logic in lib/admin/services/texts.js):
 *
 *   GET    /admin/api/texts?q&command&overridden&changed&page&pageSize   TXT-1  every key of lang/en.json, filtered
 *   PUT    /admin/api/texts/:lang/:key                                   TXT-2  { text }  -> { item }; audit text.update
 *   DELETE /admin/api/texts/:lang/:key                                   TXT-3  back to the original -> { item }; audit text.reset
 *
 * `:lang` is `en` or `fr` (the router's pattern: another locale is a 404), `:key` a text key. The audit detail of an
 * update is `{ length }` only: the text itself is never written to the history.
 */

const { createTextsService } = require("../services/texts");

const FLAG = { type: "string", enum: ["0", "1"] };
const COUNT = { type: "string", pattern: /^\d{1,6}$/ };

function register({ router, deps }) {
  const texts = deps.textsService || createTextsService(deps);

  router.route({
    method: "GET",
    path: "/admin/api/texts",
    auth: "session",
    query: {
      q: { type: "string", maxLength: 100 },
      command: { type: "string", maxLength: 64 },
      overridden: FLAG,
      changed: FLAG,
      page: COUNT,
      pageSize: COUNT,
    },
    handler: (ctx) =>
      texts.list({
        q: ctx.query.q,
        command: ctx.query.command,
        overridden: ctx.query.overridden === "1",
        changed: ctx.query.changed === "1",
        page: ctx.query.page === undefined ? 1 : Number(ctx.query.page),
        pageSize: ctx.query.pageSize === undefined ? undefined : Number(ctx.query.pageSize),
      }),
  });

  router.route({
    method: "PUT",
    path: "/admin/api/texts/:lang/:key",
    auth: "session",
    schema: { text: { type: "string", required: true } },
    handler: async (ctx) => {
      const { lang, key } = ctx.params;
      const answer = await texts.save(lang, key, ctx.body.text, { actor: ctx.origin });
      await ctx.audit("text.update", `${lang}:${key}`, "ok", { length: ctx.body.text.length });
      return { item: answer.item };
    },
  });

  router.route({
    method: "DELETE",
    path: "/admin/api/texts/:lang/:key",
    auth: "session",
    handler: async (ctx) => {
      const { lang, key } = ctx.params;
      const answer = await texts.reset(lang, key, { actor: ctx.origin });
      if (answer.removed) await ctx.audit("text.reset", `${lang}:${key}`, "ok");
      return { item: answer.item };
    },
  });
}

module.exports = { register };
