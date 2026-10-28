"use strict";

/**
 * Broadcast routes (admin-http-api.md 2.11). The logic is lib/admin/services/broadcasts.js, the engine
 * lib/utils/broadcaster.js.
 *
 *   GET    /admin/api/broadcasts?kind&state&page&pageSize      BC-1   { items, page, pageSize, total }
 *   POST   /admin/api/broadcasts/preview                       BC-2   { targetCount, estimatedDurationMs, ... }, writes nothing
 *                                                                     (GET on that path is a 405 with Allow: POST, see the guard below)
 *   POST   /admin/api/broadcasts                               BC-3   201 { broadcast, run }, audit broadcast.create
 *   GET    /admin/api/broadcasts/:id                           BC-4   { broadcast, runs, nextOccurrences }, touch: false
 *   PATCH  /admin/api/broadcasts/:id                           BC-5   recurring only, audit broadcast.update
 *   POST   /admin/api/broadcasts/:id/pause                     BC-6   audit broadcast.pause
 *   POST   /admin/api/broadcasts/:id/resume                    BC-7   audit broadcast.resume
 *   POST   /admin/api/broadcasts/:id/cancel                    BC-8   body { runId? }, audit broadcast.cancel
 *   DELETE /admin/api/broadcasts/:id?confirm=true              BC-9   audit broadcast.delete
 *   GET    /admin/api/broadcasts/:id/runs/:runId               BC-10  the per-destination report, touch: false
 *
 * There is NO retry route and none will be added (U14): a request to any `.../retry` path is a plain 404. Failed
 * destinations are served again by a NEW broadcast that the UI pre-fills from BC-10 and submits through BC-3.
 *
 * Progress: the engine's events are published on the hub `job` topic as
 * `{ type: "broadcast", broadcastId, runId, status, total, sent, failed, cancelled, pending, updatedAt }` at every
 * settled target and every run change; the subscription lives between the admin's start and stop.
 */

const { AdminError, reply } = require("../http/response");
const { createBroadcastsService } = require("../services/broadcasts");

/** The shared body of BC-2 / BC-3 / BC-5 (strict: an unknown property is `$unknown`) */
const BODY = {
  title: { type: "string", maxLength: 100, trim: true, nullable: true },
  text: { type: "string", maxLength: 4096, trim: true },
  uploadId: { type: "string", pattern: /^[0-9a-f]{32}$/ },
  reuseMediaOf: { type: "int", min: 1, max: 2147483647 },
  targets: { type: "array", min: 1, max: 200, items: { type: "string", maxLength: 255 } },
  spacingMs: { type: "int", min: 2000, max: 600000 },
  runAt: { type: "string", maxLength: 40 },
  recurrence: { type: "object" },
};
const CREATE = { kind: { type: "string", maxLength: 16 }, ...BODY, confirmTargets: { type: "int", min: 0, max: 100000 } };
const PREVIEW = { kind: CREATE.kind, ...BODY };

const LIST_QUERY = {
  kind: { type: "string", enum: ["once", "recurring"] },
  state: { type: "string", enum: ["scheduled", "running", "paused", "completed", "failed", "cancelled", "expired"] },
  page: { type: "string", pattern: /^\d{1,6}$/ },
  pageSize: { type: "string", pattern: /^\d{1,4}$/ },
};

function register({ router, deps, hub, onStart, onStop }) {
  const service = createBroadcastsService(deps);
  const sessionOf = (ctx) => (ctx.session && ctx.session.id !== undefined ? String(ctx.session.id) : "");

  router.route({
    method: "GET",
    path: "/admin/api/broadcasts",
    auth: "session",
    query: LIST_QUERY,
    handler: (ctx) => service.list(ctx.query),
  });

  router.route({
    method: "POST",
    path: "/admin/api/broadcasts/preview",
    auth: "session",
    schema: PREVIEW,
    handler: (ctx) => service.preview(ctx.body, { sessionId: sessionOf(ctx) }),
  });

  // `GET /admin/api/broadcasts/:id` matches the segment "preview" structurally before its numeric pattern rejects
  // it, which would answer 404 where every other wrong method on a declared path is 405. This guard makes the
  // literal path win for GET and answers the 405 with its Allow header.
  router.route({
    method: "GET",
    path: "/admin/api/broadcasts/preview",
    auth: "session",
    touch: false,
    handler: () => {
      throw new AdminError("method_not_allowed", { headers: { Allow: "POST" } });
    },
  });

  router.route({
    method: "POST",
    path: "/admin/api/broadcasts",
    auth: "session",
    schema: CREATE,
    handler: async (ctx) => {
      const { broadcast, run, summary } = await service.create(ctx.body, { sessionId: sessionOf(ctx) });
      await ctx.audit("broadcast.create", String(broadcast.id), "ok", summary);
      return reply(201, { broadcast, run });
    },
  });

  router.route({
    method: "GET",
    path: "/admin/api/broadcasts/:id",
    auth: "session",
    touch: false,
    handler: (ctx) => service.get(Number(ctx.params.id)),
  });

  router.route({
    method: "PATCH",
    path: "/admin/api/broadcasts/:id",
    auth: "session",
    schema: { ...CREATE },
    handler: async (ctx) => {
      const { broadcast, summary } = await service.update(Number(ctx.params.id), ctx.body, { sessionId: sessionOf(ctx) });
      await ctx.audit("broadcast.update", String(broadcast.id), "ok", summary);
      return { broadcast };
    },
  });

  for (const action of ["pause", "resume"]) {
    router.route({
      method: "POST",
      path: `/admin/api/broadcasts/:id/${action}`,
      auth: "session",
      handler: async (ctx) => {
        const answer = await service[action](Number(ctx.params.id));
        await ctx.audit(`broadcast.${action}`, String(answer.broadcast.id), "ok");
        return answer;
      },
    });
  }

  router.route({
    method: "POST",
    path: "/admin/api/broadcasts/:id/cancel",
    auth: "session",
    schema: { runId: { type: "int", min: 1, max: 2147483647 } },
    handler: async (ctx) => {
      const answer = await service.cancel(Number(ctx.params.id), { runId: ctx.body.runId });
      await ctx.audit("broadcast.cancel", String(ctx.params.id), "ok", { runId: answer.run.id });
      return answer;
    },
  });

  router.route({
    method: "DELETE",
    path: "/admin/api/broadcasts/:id",
    auth: "session",
    query: { confirm: { type: "string", enum: ["true", "false"] } },
    handler: async (ctx) => {
      const answer = await service.remove(Number(ctx.params.id), { confirm: ctx.query.confirm === "true" });
      await ctx.audit("broadcast.delete", String(ctx.params.id), "ok");
      return answer;
    },
  });

  router.route({
    method: "GET",
    path: "/admin/api/broadcasts/:id/runs/:runId",
    auth: "session",
    touch: false,
    handler: (ctx) => service.report(Number(ctx.params.id), Number(ctx.params.runId)),
  });

  // progress on the hub `job` topic (the SSE stream and its 2 s polling fallback show the same numbers)
  let unsubscribe = null;
  onStart(() => {
    if (unsubscribe) return;
    const engine = deps.broadcaster || require("../../utils/broadcaster");
    unsubscribe = engine.subscribe((event) => {
      const { type: _kind, ...progress } = event;
      hub.publish("job", { type: "broadcast", ...progress });
    });
  });
  onStop(() => {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  });
}

module.exports = { register };
