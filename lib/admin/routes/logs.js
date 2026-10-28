"use strict";

/**
 * LOG-1 of admin-http-api.md 2.16: `GET /admin/api/logs?level&q&since&limit` -> `200 { entries, lastSeq }`.
 *
 *   level   a MINIMUM: trace, debug, info, warn, error, fatal (`error` returns error and fatal)
 *   q       case-insensitive substring of the message or the module name, at most 100 characters
 *   since   a sequence number: only the entries with a greater `seq`
 *   limit   1 to 1000, default 200: the newest entries, or the first ones after `since` (a polling client must
 *           not skip a gap)
 *
 * The entries come from the 1000-entry in-memory ring (lib/admin/logs/ring.js), oldest first, as
 * `{ seq, ts, level, name, msg }`. Every message is scrubbed once more with the redactor (a secret registered
 * after the entry was logged is caught here) and QR output is never returned. `lastSeq` is the cursor for the next
 * poll: the newest sequence examined, or the last entry returned when `limit` cut the answer short.
 *
 * Session, `touch: false` (polling must not keep an idle session alive), `db: "optional"` (the ring is memory).
 * It is the polling fallback of the SSE `log` event; the live stream itself is routes/events.js.
 */

const { AdminError } = require("../http/response");
const { cleanLogEntry } = require("../services/state");

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function register({ router, deps }) {
  router.route({
    method: "GET",
    path: "/admin/api/logs",
    auth: "session",
    touch: false,
    db: "optional",
    query: {
      level: { type: "string", enum: LEVELS },
      q: { type: "string", maxLength: 100 },
      since: { type: "string", pattern: /^\d{1,15}$/ },
      limit: { type: "string", pattern: /^\d{1,9}$/ },
    },
    handler: (ctx) => {
      const { level, q, since } = ctx.query;
      const limit = ctx.query.limit === undefined ? DEFAULT_LIMIT : Number(ctx.query.limit);
      if (limit < 1 || limit > MAX_LIMIT) {
        throw new AdminError("validation_failed", { fields: { limit: { code: "out_of_range", params: { min: 1, max: MAX_LIMIT } } } });
      }
      const ring = deps.ring || require("../logs/ring");
      const redactor = deps.redactor || require("../logs/redactor");
      const cursor = since === undefined ? undefined : Number(since);

      const found = ring.list({ level, q, since: cursor, limit });
      const entries = [];
      for (const entry of found) {
        const clean = cleanLogEntry(entry, redactor);
        if (clean) entries.push(clean);
      }

      // the ring is read synchronously twice in a row: nothing can be pushed in between
      const newest = typeof ring.lastSeq === "function" ? ring.lastSeq() : found.length ? found[found.length - 1].seq : cursor || 0;
      const truncated = cursor !== undefined && found.length >= limit && found.length > 0;
      const lastSeq = truncated ? found[found.length - 1].seq : Math.max(newest, cursor || 0);
      return { entries, lastSeq };
    },
  });
}

module.exports = { register, LEVELS, DEFAULT_LIMIT, MAX_LIMIT };
