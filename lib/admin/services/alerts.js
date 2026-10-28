"use strict";

/**
 * Alerts service (admin-http-api.md 2.16, ALR-1; US13): what the alerts engine (lib/utils/alerts.js) is doing,
 * for the "Alerts" page. Never touches `req`/`res`; the HTTP layer is lib/admin/routes/alerts.js.
 *
 *   const alerts = createAlertsService(deps);
 *   await alerts.list()  -> { canDeliver, ownerCount, types: [{ type, settingKey, enabled, lastSentAt, pending }],
 *                             recent: [{ id, type, status, createdAt, sentAt }] }
 *
 * The page is read-only: the six toggles are the `ALERT_*` settings, written by SET-2. `canDeliver` is false when
 * `SUDO` holds no owner (US13 scenario 5): the engine then drops every alert without spending a rate-limit slot.
 * The rows listed never carry the payload of an alert, only its type, status and times.
 *
 * The engine is resolved lazily as `deps.alerts` (the one `createAdmin` was given), else lib/utils/alerts.js. A stand-in
 * without `getStatus` (the tests' recorder) is replaced by the real module, so the route always answers.
 */

/** The six types in the order of the contract, with the setting that switches each one */
const ALERT_TYPES = Object.freeze([
  Object.freeze({ type: "reconnected", settingKey: "ALERT_RECONNECT" }),
  Object.freeze({ type: "errors_series", settingKey: "ALERT_ERROR_BURST" }),
  Object.freeze({ type: "key_refused", settingKey: "ALERT_KEY_REFUSED" }),
  Object.freeze({ type: "login_blocked", settingKey: "ALERT_LOGIN_BLOCKED" }),
  Object.freeze({ type: "new_origin", settingKey: "ALERT_NEW_ORIGIN" }),
  Object.freeze({ type: "update_available", settingKey: "ALERT_UPDATE" }),
]);

/** Rows of recent alerts listed on the page */
const RECENT_ROWS = 20;

const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Number(value)) : 0);

function createAlertsService(deps = {}) {
  const engine = () => (deps.alerts && typeof deps.alerts.getStatus === "function" ? deps.alerts : require("../../utils/alerts"));

  /** ALR-1 */
  async function list() {
    const status = await engine().getStatus({ recent: RECENT_ROWS });
    const enabled = status.enabled || {};
    const lastSent = status.lastSent || {};
    const pending = status.pendingByType || {};
    const ownerCount = count(status.recipients);
    return {
      canDeliver: ownerCount > 0,
      ownerCount,
      types: ALERT_TYPES.map(({ type, settingKey }) => ({
        type,
        settingKey,
        enabled: enabled[type] !== false, // every type is on by default (U12)
        lastSentAt: lastSent[type] || null,
        pending: count(pending[type]),
      })),
      recent: (status.recent || []).map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        createdAt: row.createdAt || null,
        sentAt: row.sentAt || null,
      })),
    };
  }

  return { list };
}

module.exports = { createAlertsService, ALERT_TYPES, RECENT_ROWS };
