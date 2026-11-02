"use strict";

/**
 * Routes of the panel's API page (feature 004, contracts/admin-api.md section 2). The logic is
 * lib/admin/services/api.js; the engines behind it are lib/utils/apiState.js (the switch), lib/api (the key store, the
 * registries) and lib/messaging (the queue). `register()` requires no engine: `admin-security` and `adminFull`
 * register this module with stubs.
 *
 *   GET  /admin/api/api                         API-1   State (writes nothing: the ApiState row is created by API-2)
 *   PUT  /admin/api/api/state                   API-2   switch and plain-HTTP networks, stepUp conditional,
 *                                                       audit api.enable | api.disable | api.plainhttp.update
 *   GET  /admin/api/api/catalog                 API-3   rights, formats, endpoints, limits
 *   GET  /admin/api/api/keys                    API-4   { items: [KeyView] }
 *   POST /admin/api/api/keys                    API-5   201 { key, secret }, stepUp true, audit api.key.create
 *   PUT  /admin/api/api/keys/:id                API-6   200 { key, changed }, stepUp conditional, audit api.key.update
 *   POST /admin/api/api/keys/:id/duplicate      API-7   201 { key, secret }, stepUp true, audit api.key.duplicate
 *   POST /admin/api/api/keys/:id/revoke         API-8   200 { key, cancelled }, confirm, audit api.key.revoke
 *   GET  /admin/api/api/messages                API-9   history, filters and pages
 *   GET  /admin/api/api/messages/:id            API-10  one message with its steps and answers
 *   POST /admin/api/api/test                    API-11  the test send, 202 { message }, audit api.test
 *   GET  /admin/api/api/usage                   API-12  messages per day
 *   GET  /admin/api/api/openapi                 API-13  the OpenAPI document as a download
 *
 * Every route is `auth: "session"` (CSRF on the unsafe ones). There is no `GET /keys/:id`: the list already carries
 * every field. A handler returns codes and parameters, never prose; it audits through `ctx.audit(...)` once per
 * distinct action and only when something changed. The answer that carries a key secret is `Cache-Control: no-store`.
 */

const { AdminError, reply } = require("../http/response");
const {
  createApiService,
  KEY_INPUT,
  KEY_UPDATE,
  KEY_DUPLICATE,
  KEY_REVOKE,
  STATE_INPUT,
  MESSAGES_QUERY,
  USAGE_QUERY,
} = require("../services/api");

const TEST_BODY_LIMIT = 64 * 1024;
const MAX_ID = 2147483647; // INTEGER primary keys: a larger id matches nothing

function register({ router, deps }) {
  const service = createApiService(deps);

  /** The request facts the service needs, read here so the service never sees `req` */
  function requestInfo(ctx) {
    const trust = deps.trustProxy;
    const sessions = deps.auth && deps.auth.sessions;
    const recent = sessions && typeof sessions.isRecent === "function" && sessions.isRecent(ctx.session, ctx.now);
    return {
      at: ctx.now,
      https: Boolean(trust && typeof trust.isHttps === "function" && trust.isHttps(ctx.req)),
      host: ctx.req.headers.host,
      confirmedUntil: recent ? Number(ctx.session.confirmedAt) + Number(sessions.STEP_UP_MS || 300000) : null,
    };
  }

  const idOf = (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isSafeInteger(id) || id > MAX_ID) throw new AdminError("not_found");
    return id;
  };

  async function audited(ctx, audits) {
    for (const entry of audits) await ctx.audit(entry.action, entry.target, "ok", entry.detail);
  }

  // ---- API-1 ----------------------------------------------------------------------------------------------------
  router.route({
    method: "GET",
    path: "/admin/api/api",
    auth: "session",
    handler: (ctx) => service.state(requestInfo(ctx)),
  });

  // ---- API-2 ----------------------------------------------------------------------------------------------------
  router.route({
    method: "PUT",
    path: "/admin/api/api/state",
    auth: "session",
    stepUp: "conditional",
    schema: STATE_INPUT,
    handler: async (ctx) => {
      const { answer, audits } = await service.setState(ctx.body, { at: ctx.now, stepUp: ctx.stepUp });
      await audited(ctx, audits);
      return answer;
    },
  });

  // ---- API-3 ----------------------------------------------------------------------------------------------------
  router.route({
    method: "GET",
    path: "/admin/api/api/catalog",
    auth: "session",
    handler: () => service.catalog(),
  });

  // ---- API-4, API-5 -----------------------------------------------------------------------------------------------
  router.route({
    method: "GET",
    path: "/admin/api/api/keys",
    auth: "session",
    handler: (ctx) => service.listKeys({ at: ctx.now }),
  });

  router.route({
    method: "POST",
    path: "/admin/api/api/keys",
    auth: "session",
    stepUp: true,
    schema: KEY_INPUT,
    handler: async (ctx) => {
      const { key, secret, audits } = await service.createKey(ctx.body, { at: ctx.now });
      await audited(ctx, audits);
      return reply(201, { key, secret }, { "Cache-Control": "no-store" });
    },
  });

  // ---- API-6, API-7, API-8 ----------------------------------------------------------------------------------------
  router.route({
    method: "PUT",
    path: "/admin/api/api/keys/:id",
    auth: "session",
    stepUp: "conditional",
    schema: KEY_UPDATE,
    handler: async (ctx) => {
      const { key, changed, audits } = await service.updateKey(idOf(ctx), ctx.body, { at: ctx.now, stepUp: ctx.stepUp });
      await audited(ctx, audits);
      return { key, changed };
    },
  });

  router.route({
    method: "POST",
    path: "/admin/api/api/keys/:id/duplicate",
    auth: "session",
    stepUp: true,
    schema: KEY_DUPLICATE,
    handler: async (ctx) => {
      const { key, secret, audits } = await service.duplicateKey(idOf(ctx), ctx.body, { at: ctx.now });
      await audited(ctx, audits);
      return reply(201, { key, secret }, { "Cache-Control": "no-store" });
    },
  });

  router.route({
    method: "POST",
    path: "/admin/api/api/keys/:id/revoke",
    auth: "session",
    schema: KEY_REVOKE,
    handler: async (ctx) => {
      const { key, cancelled, audits } = await service.revokeKey(idOf(ctx), ctx.body, { at: ctx.now });
      await audited(ctx, audits);
      return { key, cancelled };
    },
  });

  // ---- API-9, API-10 ----------------------------------------------------------------------------------------------
  router.route({
    method: "GET",
    path: "/admin/api/api/messages",
    auth: "session",
    query: MESSAGES_QUERY,
    handler: (ctx) => service.listMessages(ctx.query),
  });

  router.route({
    method: "GET",
    path: "/admin/api/api/messages/:id",
    auth: "session",
    handler: (ctx) => service.getMessage(idOf(ctx)),
  });

  // ---- API-11 -----------------------------------------------------------------------------------------------------
  // No `schema`: the body is flat and its rules are the engine's (`validateInput`), so a new format appears here with
  // no edit; the router only bounds it to 64 KiB.
  router.route({
    method: "POST",
    path: "/admin/api/api/test",
    auth: "session",
    bodyLimit: TEST_BODY_LIMIT,
    handler: async (ctx) => {
      const { message, audits } = await service.testSend(ctx.body, {
        at: ctx.now,
        sessionId: String(ctx.session.id),
        requestId: ctx.requestId,
        signal: ctx.signal,
      });
      await audited(ctx, audits);
      return reply(202, { message });
    },
  });

  // ---- API-12, API-13 ----------------------------------------------------------------------------------------------
  router.route({
    method: "GET",
    path: "/admin/api/api/usage",
    auth: "session",
    query: USAGE_QUERY,
    handler: (ctx) => service.usage(ctx.query, { at: ctx.now }),
  });

  router.route({
    method: "GET",
    path: "/admin/api/api/openapi",
    auth: "session",
    handler: (ctx) => {
      const info = requestInfo(ctx);
      return reply(200, service.openapi(info), {
        "Content-Disposition": 'attachment; filename="openwhatsappbot-api-v1.openapi.json"',
      });
    },
  });
}

module.exports = { register };
