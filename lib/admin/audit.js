"use strict";

/**
 * History of administration actions (contracts/runtime.md section 15 "Audit and hub", data-model 1.7,
 * admin-http-api.md 1.15, FR-036). No secret value ever reaches a row.
 *
 *   audit.record({ action, target, origin, result = "ok", detail }, { transaction })
 *       Without `transaction` a failed write is logged (error name and code only) and swallowed: an audit
 *       failure never breaks the action. With `transaction` it rejects, so an economy adjustment and its audit
 *       row commit or fail together. `origin` is the throttling origin of the request, "cli" for
 *       tools/admin-reset.js and "system" at boot. `detail` is JSON-serialised, passed through
 *       `redactor.scrub` and limited to 2000 characters: an oversized detail becomes a summary object, never a
 *       string cut in the middle of the JSON.
 *   auditDiff(def, before, after)
 *       { from, to } for a non-secret setting, only { secret: true, op: "set" | "clear" } for a secret.
 *   audit.list({ action, result, from, to, page, pageSize })       AUD-1: prefix filter, result, range, pagination
 *   audit.hasSeenOrigin(origin, { actions })                       "origin never seen before" (an earlier row)
 *   audit.recentFailures({ since })                                login.failure rows, to rehydrate the limiter
 *
 * `result` is stored as ok | fail | blocked (the model); "refused" is accepted as a synonym of "blocked".
 * The module exports a default instance (lazy models, Date.now) and `createAudit({ models, now, redactor,
 * logger })` for tests and for a fake clock.
 */

const { Op } = require("sequelize");

/** Action vocabulary of admin-http-api.md 1.15 (stores may add entries as needed). */
const ACTIONS = Object.freeze([
  "login.success",
  "login.failure",
  "login.blocked",
  "logout",
  "setup.complete",
  "reset.issued",
  "reset.complete",
  "account.update",
  "setting.update",
  "setting.reset",
  "setting.test",
  "restart",
  "pair.request",
  "pair.code",
  "session.logout",
  "command.toggle",
  "group.update",
  "group.guard",
  "group.mute",
  "group.delete",
  "group.filter",
  "group.role",
  "group.warnings",
  "chat.enable",
  "economy.adjust",
  "data.delete",
  "broadcast.create",
  "broadcast.update",
  "broadcast.pause",
  "broadcast.resume",
  "broadcast.cancel",
  "broadcast.delete",
  "backup.export",
  "backup.restore",
  "update.check",
  "update.apply",
  "ytdlp.update",
  "storage.purge",
  "text.update",
  "text.reset",
  "guard.antibot.remove",
  "guard.antibot.suspect",
]);

const MAX_DETAIL = 2000;
const MAX_ACTION = 48;
const MAX_TARGET = 255;
const MAX_ORIGIN = 64;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const RESULTS = new Set(["ok", "fail", "blocked"]);

/** Action filter of AUD-1: dotted lower-case words only, so no LIKE wildcard can slip in. */
const PREFIX_PATTERN = /^[a-z0-9.]{1,48}$/;

function normalizeResult(result) {
  if (result === undefined || result === null) return "ok";
  const value = String(result);
  if (value === "refused") return "blocked";
  return RESULTS.has(value) ? value : "fail";
}

function isEmptySecret(value) {
  return value === undefined || value === null || value === "";
}

/**
 * The only way to describe a setting change in `detail`.
 * @param {{ secret?: boolean }} def  catalog entry
 */
function auditDiff(def, before, after) {
  if (def && def.secret) return { secret: true, op: isEmptySecret(after) ? "clear" : "set" };
  return { from: before === undefined ? null : before, to: after === undefined ? null : after };
}

/** `detail` -> the TEXT column: scrubbed, valid JSON, at most MAX_DETAIL characters, or null. */
function serializeDetail(detail, scrub) {
  if (detail === undefined || detail === null) return null;
  let text;
  try {
    text = JSON.stringify(detail);
  } catch {
    text = JSON.stringify({ unserializable: true });
  }
  if (text === undefined) return null;
  text = scrub(text);
  try {
    JSON.parse(text);
  } catch {
    // a redacted number or literal broke the JSON: keep the scrubbed text as a string value
    text = JSON.stringify({ scrubbed: text });
  }
  if (text.length <= MAX_DETAIL) return text;
  const summary = { truncated: true, length: text.length };
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    summary.keys = Object.keys(detail)
      .slice(0, 20)
      .map((key) => String(key).slice(0, 40));
  }
  return scrub(JSON.stringify(summary));
}

function parseDetail(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const toDate = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * @param {object} [options]
 * @param {object} [options.models]    the database module (default: required lazily)
 * @param {() => number} [options.now] clock in ms (default Date.now)
 * @param {object} [options.redactor]  { scrub } (default: the log leaf)
 * @param {object} [options.logger]    default: createLogger("audit")
 */
function createAudit(options = {}) {
  const clock = typeof options.now === "function" ? options.now : () => Date.now();
  let loggerInstance = options.logger || null;

  const modelsOf = () => options.models || require("../database");
  const scrubOf = () => {
    const redactor = options.redactor || require("./logs/redactor");
    return (text) => redactor.scrub(text);
  };
  const logger = () => {
    if (!loggerInstance) loggerInstance = require("../utils/logger").createLogger("audit");
    return loggerInstance;
  };

  async function write(entry, transaction) {
    if (!entry || typeof entry.action !== "string" || !entry.action) throw new TypeError("audit: action is required");
    const { AuditLog } = modelsOf();
    const row = await AuditLog.create(
      {
        action: entry.action.slice(0, MAX_ACTION),
        target: entry.target === undefined || entry.target === null ? null : String(entry.target).slice(0, MAX_TARGET),
        origin: entry.origin === undefined || entry.origin === null ? null : String(entry.origin).slice(0, MAX_ORIGIN),
        result: normalizeResult(entry.result),
        detail: serializeDetail(entry.detail, scrubOf()),
        createdAt: new Date(entry.at !== undefined ? entry.at : clock()),
      },
      transaction ? { transaction } : {},
    );
    return row.get({ plain: true });
  }

  return {
    ACTIONS,

    async record(entry, opts = {}) {
      if (opts && opts.transaction) return write(entry, opts.transaction);
      try {
        return await write(entry, null);
      } catch (err) {
        try {
          logger().warn({ name: err && err.name, code: err && err.code, action: entry && entry.action }, "audit: a write failed");
        } catch {
          // logging never matters here
        }
        return null;
      }
    },

    /** AUD-1 helper: `{ items: [{ id, at, action, target, origin, result, detail }], page, pageSize, total }`. */
    async list(query = {}) {
      const { AuditLog } = modelsOf();
      const where = {};
      if (query.action !== undefined && query.action !== null && query.action !== "") {
        const prefix = String(query.action);
        if (!PREFIX_PATTERN.test(prefix)) return { items: [], page: 1, pageSize: DEFAULT_PAGE_SIZE, total: 0 };
        where.action = { [Op.like]: `${prefix}%` };
      }
      if (query.result) where.result = normalizeResult(query.result);
      const from = toDate(query.from);
      const to = toDate(query.to);
      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt[Op.gte] = from;
        if (to) where.createdAt[Op.lte] = to;
      }
      const page = Math.max(1, parseInt(query.page, 10) || 1);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.pageSize, 10) || DEFAULT_PAGE_SIZE));
      const { rows, count } = await AuditLog.findAndCountAll({
        where,
        order: [
          ["createdAt", "DESC"],
          ["id", "DESC"],
        ],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return {
        items: rows.map((row) => ({
          id: row.id,
          at: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
          action: row.action,
          target: row.target,
          origin: row.origin,
          result: row.result,
          detail: parseDetail(row.detail),
        })),
        page,
        pageSize,
        total: count,
      };
    },

    /** True when an earlier row of one of `actions` (default login.success) carries this origin. */
    async hasSeenOrigin(origin, { actions = ["login.success"] } = {}) {
      const { AuditLog } = modelsOf();
      const row = await AuditLog.findOne({
        attributes: ["id"],
        where: { origin: String(origin).slice(0, MAX_ORIGIN), action: { [Op.in]: actions } },
      });
      return Boolean(row);
    },

    /** `login.failure` rows since `since` (ms or Date), oldest first, as `{ origin, at }` in ms. */
    async recentFailures({ since, limit = 1000 } = {}) {
      const { AuditLog } = modelsOf();
      const start = toDate(since) || new Date(clock() - 15 * 60 * 1000);
      const rows = await AuditLog.findAll({
        attributes: ["origin", "createdAt"],
        where: { action: "login.failure", createdAt: { [Op.gte]: start } },
        order: [["createdAt", "ASC"]],
        limit,
      });
      return rows.filter((row) => row.origin).map((row) => ({ origin: row.origin, at: new Date(row.createdAt).getTime() }));
    },
  };
}

const defaultAudit = createAudit();

module.exports = {
  ...defaultAudit,
  createAudit,
  auditDiff,
  ACTIONS,
  MAX_DETAIL,
  serializeDetail,
};
