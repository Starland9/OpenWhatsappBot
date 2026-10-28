"use strict";

/**
 * JOB-1 of admin-http-api.md section 2.3: `GET /admin/api/jobs/:id` -> `200 { job }` (shape in section 1.16),
 * `404 not_found` for an unknown or expired id. Session, `touch: false`, `db: "optional"`: it is the polling
 * fallback of the SSE `job` event and must work while the database restarts (restore, update).
 */

const { AdminError } = require("../http/response");

function register({ router, jobs }) {
  router.route({
    method: "GET",
    path: "/admin/api/jobs/:id",
    auth: "session",
    touch: false,
    db: "optional",
    handler: (ctx) => {
      const job = jobs.get(ctx.params.id);
      if (!job) throw new AdminError("not_found", { params: { resource: "job" } });
      return { job };
    },
  });
}

module.exports = { register };
