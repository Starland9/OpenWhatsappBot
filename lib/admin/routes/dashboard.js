"use strict";

/**
 * Dashboard routes (US2, admin-http-api.md 2.3):
 *
 *   DASH-1  GET  /admin/api/state     the state of the bot, the SSE `state` payload and the 2 s polling fallback.
 *                                     Session, `touch: false` (a forgotten tab must still expire), `db: "optional"`.
 *   RST-1   POST /admin/api/restart   `{ confirm: true }` -> 202 with a `restart` job (phases stop, settings, start,
 *                                     ready). In-process restart of the bot: the settings are read again, the
 *                                     WhatsApp session is kept, the process never exits. Not the legacy
 *                                     `POST /api/restart` (which exits and needs a supervisor). Audit `restart`.
 *
 * The state service (lib/admin/services/state.js) is created here (or earlier by an area that adds a banner) and
 * wired to the hub: its snapshot answers new streams and the 2 s ticker, the runtime's `state` events and the
 * settings changes become forced or coalesced `state` events. Listeners are attached when the admin starts and
 * removed when it stops.
 */

const { AdminError, reply } = require("../http/response");
const { getStateService } = require("../services/state");

function register({ router, deps, hub, jobs, audit, onStart, onStop }) {
  const state = getStateService(deps);
  state.install();
  onStart(() => state.attach());
  onStop(() => state.detach());

  router.route({
    method: "GET",
    path: "/admin/api/state",
    auth: "session",
    touch: false,
    db: "optional",
    handler: async (ctx) => {
      // forwarded headers from a peer PANEL_TRUST_PROXY does not declare: the `undeclared_proxy` banner
      try {
        const trust = deps.trustProxy;
        if (trust && typeof trust.proxyHint === "function") state.noteProxyHeaders(trust.proxyHint(ctx.req));
      } catch {
        // a hint is a convenience, never a failure
      }
      return state.build();
    },
  });

  router.route({
    method: "POST",
    path: "/admin/api/restart",
    auth: "session",
    db: "optional",
    schema: { confirm: { type: "boolean" } },
    handler: async (ctx) => {
      if (ctx.body.confirm !== true) throw new AdminError("confirmation_required", { params: { confirm: "restart" } });
      const origin = ctx.origin;
      // single flight: another heavy job running gives `busy`, nothing is audited
      const job = jobs.start(
        "restart",
        async (handle) => {
          try {
            return await state.runRestart(handle);
          } catch (err) {
            // the accepted request is already in the history: a failure adds its own row (best effort)
            await audit.record({ action: "restart", target: null, origin, result: "fail", detail: { reason: err && err.params ? err.params.reason : "failed" } });
            throw err;
          }
        },
        { failureCode: "restart_failed" },
      );
      await ctx.audit("restart", null, "ok");
      return reply(202, { job });
    },
  });
}

module.exports = { register };
