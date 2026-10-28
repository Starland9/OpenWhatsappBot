"use strict";

/**
 * STAT-1 of admin-http-api.md 2.16: `GET /admin/api/stats` -> `200 { timezone, days, topCommands, failedCommands,
 * topGroups }` (shape and rules in lib/admin/services/stats.js). Session; it reads `daily_stats`, so it needs the
 * database (503 `starting` / `db_unavailable` otherwise). The service is built on the first request, so the
 * counters engine is only loaded when somebody asks.
 */

const { createStatsService } = require("../services/stats");

function register({ router, deps }) {
  let service = null;
  router.route({
    method: "GET",
    path: "/admin/api/stats",
    auth: "session",
    handler: () => {
      if (!service) service = createStatsService(deps);
      return service.get();
    },
  });
}

module.exports = { register };
