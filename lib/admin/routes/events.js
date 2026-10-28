"use strict";

/**
 * EVT-1 of admin-http-api.md sections 2.3 and 3: `GET /admin/api/events?logs=0|1&since=<seq>`.
 *
 * Session, `touch: false` (a forgotten open tab must still expire), `db: "optional"` (the stream works while the
 * database is down), same-origin checked (EventSource cannot send headers). The stream itself is
 * lib/admin/http/sse.js; the shared instance is `deps.sse` (created by createAdmin), closed by admin.stop().
 */

function register({ router, deps, hub, onStop }) {
  const sse = deps.sse || require("../http/sse").createSse({ hub, auth: deps.auth, logger: deps.logger });

  router.route({
    method: "GET",
    path: "/admin/api/events",
    auth: "session",
    touch: false,
    db: "optional",
    sameOrigin: true,
    query: {
      logs: { type: "string", enum: ["0", "1"] },
      since: { type: "string", pattern: /^\d{1,15}$/ },
    },
    handler: (ctx) => sse.handler(ctx),
  });

  onStop(() => sse.closeAll());
}

module.exports = { register };
