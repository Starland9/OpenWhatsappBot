"use strict";

/**
 * Alerts route (admin-http-api.md 2.16):
 *
 *   GET /admin/api/alerts   ALR-1  { canDeliver, ownerCount, types: [{ type, settingKey, enabled, lastSentAt,
 *                                  pending }], recent: [{ id, type, status, createdAt, sentAt }] }
 *
 * A convenience view of the alerts engine (lib/utils/alerts.js): there is nothing to write here, the six toggles are
 * the `ALERT_*` settings changed with SET-2. The rate limits and the owner-DM throttle are engine rules without an
 * HTTP surface. The logic is in lib/admin/services/alerts.js.
 */

const { createAlertsService } = require("../services/alerts");

function register({ router, deps }) {
  const service = deps.alertsService || createAlertsService(deps);

  router.route({
    method: "GET",
    path: "/admin/api/alerts",
    auth: "session",
    handler: () => service.list(),
  });
}

module.exports = { register };
