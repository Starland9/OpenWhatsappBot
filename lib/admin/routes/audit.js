"use strict";

/**
 * AUD-1 of admin-http-api.md 2.16: `GET /admin/api/audit?page&pageSize&action&result&from&to` -> `200 { items, page,
 * pageSize, total }`, the history of administration actions (FR-036), newest first.
 *
 *   action    a prefix of the vocabulary of 1.15 (`login`, `setting.update`...): lower-case words and dots only, so
 *             no wildcard can slip into the query
 *   result    ok, fail or refused (what the history stores as `blocked` is named `refused` on the API too)
 *   from, to  ISO instants (a plain date counts), both inclusive
 *   page      1-based (default 1);  pageSize 1 to 200 (default 50)
 *
 * An item is `{ id, at, action, target, origin, result, detail }`; `detail` is the sanitised JSON of the row, with
 * every text scrubbed by the redactor once more when it is read. Session, touches the session, needs the database.
 * The rows themselves are written by `audit.record` (lib/admin/audit.js): a failed action of the routes, a refused
 * login, a restart...
 */

const { AdminError } = require("../http/response");

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const DATE_FORM = /^\d{4}-\d{2}-\d{2}(?:T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const invalid = (field) => new AdminError("validation_failed", { fields: { [field]: { code: "invalid_format" } } });

/** An ISO instant (or a plain date) as a Date; a validation error naming `field` otherwise. */
function instant(text, field) {
  if (text === undefined) return undefined;
  const ms = Date.parse(text);
  if (!DATE_FORM.test(text) || Number.isNaN(ms)) throw invalid(field);
  return new Date(ms);
}

/** Every text inside a parsed JSON value goes through the redactor again. */
function scrubValue(value, scrub, depth = 0) {
  if (typeof value === "string") return scrub(value);
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, scrub, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[scrub(key)] = scrubValue(item, scrub, depth + 1);
  return out;
}

function register({ router, deps, audit }) {
  router.route({
    method: "GET",
    path: "/admin/api/audit",
    auth: "session",
    query: {
      page: { type: "string", pattern: /^[1-9]\d{0,5}$/ },
      pageSize: { type: "string", pattern: /^\d{1,9}$/ },
      action: { type: "string", pattern: /^[a-z0-9.]{1,48}$/ },
      result: { type: "string", enum: ["ok", "fail", "refused"] },
      from: { type: "string", maxLength: 40 },
      to: { type: "string", maxLength: 40 },
    },
    handler: async (ctx) => {
      const pageSize = ctx.query.pageSize === undefined ? DEFAULT_PAGE_SIZE : Number(ctx.query.pageSize);
      if (pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
        throw new AdminError("validation_failed", { fields: { pageSize: { code: "out_of_range", params: { min: 1, max: MAX_PAGE_SIZE } } } });
      }
      const from = instant(ctx.query.from, "from");
      const to = instant(ctx.query.to, "to");
      const history = (deps.audit && typeof deps.audit.list === "function" && deps.audit) || audit;
      if (!history || typeof history.list !== "function") return { items: [], page: 1, pageSize, total: 0 };

      const answer = await history.list({
        action: ctx.query.action,
        result: ctx.query.result,
        from,
        to,
        page: ctx.query.page === undefined ? 1 : Number(ctx.query.page),
        pageSize,
      });
      const redactor = deps.redactor || require("../logs/redactor");
      const scrub = (text) => redactor.scrub(text);
      return {
        items: answer.items.map((item) => ({
          id: item.id,
          at: item.at,
          action: item.action,
          target: item.target === null ? null : scrub(String(item.target)),
          origin: item.origin,
          result: item.result === "blocked" ? "refused" : item.result,
          detail: scrubValue(item.detail, scrub),
        })),
        page: answer.page,
        pageSize: answer.pageSize,
        total: answer.total,
      };
    },
  });
}

module.exports = { register };
