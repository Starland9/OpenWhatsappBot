"use strict";

/**
 * Data service of the admin panel (admin-http-api.md 2.10, DATA-1 to DATA-3; data-model 3.1 and 3.3, FR-042 to
 * FR-045). It never touches `req`/`res`; the HTTP layer is lib/admin/routes/data.js.
 *
 *   const data = createDataService(deps);
 *   await data.list(kind, query)                 DATA-1  { items, page, pageSize, total }
 *   await data.remove(kind, id)                  DATA-2  { cancelled: true } | { deleted: true }
 *   await data.adjustEconomy(body, { origin })   DATA-3  { balance, delta }
 *
 * `kind` is one of KINDS. The data lives in the existing tables (reminders, group_economy, notify_keywords,
 * sticker_commands, users, tasks, ideas, quotes). Every write goes through the same code path as the WhatsApp
 * command that owns the data, and drops the same `settingsCache` key, so the bot sees a panel change at its next
 * message without waiting for the 5 minute TTL (FR-045):
 *
 *   afk              `afk_users`                 (the cached Map of the afk plugin)
 *   keywords         prefix `notify:`            (plugins/notify.js, one entry per group)
 *   sticker-commands `sticker_cmds`              (lib/core/pipeline.js)
 *
 * Reminders are cancelled with `scheduler.cancel(id)`, the idempotent compare-and-swap `status = 'pending'`: a
 * cancelled reminder is never sent. The list reads the table directly (the scheduler's own `list` has neither
 * pagination, search nor a way to show the finished ones).
 *
 * Economy (data-model 3.3): "add" (the amount may be negative) and "set" (a target balance, 0 or more) run inside
 * `economy.withLock("give:<groupJid>")`, the lock the `give` command uses, and in one `DATABASE.transaction`:
 * a credit goes through `ensureAccount` + `applyDelta`, a debit through the guarded
 * `UPDATE ... WHERE balance >= :n` (`applyDelta(delta, { minBalance: -delta })`), so a simultaneous gain or spend
 * is kept and a balance never goes below 0. A debit that cannot be covered is `422 negative_balance` and nothing
 * is written. "Set" reads the old balance in the same transaction and applies `delta = X - old` through the same
 * guarded statement. The `economy.adjust` audit row (`{ mode, delta, balance, reason }`) is written in that
 * transaction: it commits or fails with the balance. The account is looked up under every identity form of the
 * member (phone-number JID and LID), the one the bot persists being the phone-number form.
 *
 * Engines and models are resolved lazily (`deps.models`, `deps.scheduler`, `deps.economy`, `deps.settingsCache`,
 * `deps.audit`, `deps.client`), so a test can inject a fake and a module delivered later never breaks loading.
 * Errors are `AdminError`s of the envelope: `not_found` (`params.resource`), `not_pending`, `negative_balance`,
 * `conflict` and `validation_failed` with field codes. Raw errors never reach the client.
 */

const { Op } = require("sequelize");
const { AdminError } = require("../http/response");

const KINDS = Object.freeze(["reminders", "economy", "keywords", "sticker-commands", "afk", "tasks", "ideas", "quotes"]);

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const PREVIEW_LENGTH = 80;
/** Largest balance, and largest single amount: well inside a 32-bit INTEGER column (Postgres) */
const MAX_BALANCE = 2000000000;
const MAX_REASON = 200;
/** A "set" whose guarded debit loses a race with a concurrent spend recomputes the delta this many times */
const SET_ATTEMPTS = 3;

const AFK_KEY = "afk_users";
const STICKER_CMDS_KEY = "sticker_cmds";
const NOTIFY_PREFIX = "notify:";

/** A group JID, and any chat JID a filter may name */
const GROUP_JID = /^\d{5,20}(?:-\d{1,20})?@g\.us$/;
const CHAT_JID = /^\d{5,20}(?:-\d{1,20})?@(?:g\.us|s\.whatsapp\.net|lid)$/;
const NUMERIC_ID = /^[1-9]\d{0,9}$/;

const iso = (value) => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const fieldError = (name, code, params) =>
  new AdminError("validation_failed", { fields: { [name]: params ? { code, params } : { code } } });

const notFound = (resource) => new AdminError("not_found", { params: { resource } });

/** One line of at most `max` characters (code points), cut with an ellipsis */
function preview(text, max = PREVIEW_LENGTH) {
  const chars = Array.from(String(text === undefined || text === null ? "" : text).replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

function createDataService(deps = {}) {
  const models = () => deps.models || require("../../database");
  const scheduler = () => deps.scheduler || require("../../utils/scheduler");
  const economy = () => deps.economy || require("../../../plugins/economy");
  const settingsCache = () => deps.settingsCache || require("../../utils/settingsCache");
  const perms = () => deps.permissions || require("../../utils/permissions");

  // ---- search ----------------------------------------------------------------------------------------

  /**
   * `instr(lower(column), needle) > 0` on any of `columns`: a plain substring match, so `%` and `_` typed by the
   * administrator are ordinary characters (a LIKE pattern would give them a meaning). `strpos` on Postgres.
   */
  function contains(columns, q) {
    const { DATABASE } = models();
    const needle = String(q).toLowerCase();
    const find = DATABASE.getDialect() === "postgres" ? "strpos" : "instr";
    return {
      [Op.or]: columns.map((column) =>
        DATABASE.where(
          DATABASE.fn(find, DATABASE.fn("lower", DATABASE.fn("coalesce", DATABASE.col(column), "")), needle),
          Op.gt,
          0,
        ),
      ),
    };
  }

  // ---- DATA-1 ----------------------------------------------------------------------------------------

  /** The paging of a query: 1-based `page`, `pageSize` 1 to 200 (default 50) */
  function paging(query) {
    const page = query.page === undefined ? 1 : Number(query.page);
    const pageSize = query.pageSize === undefined ? DEFAULT_PAGE_SIZE : Number(query.pageSize);
    if (!Number.isInteger(page) || page < 1) throw fieldError("page", "out_of_range", { min: 1 });
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw fieldError("pageSize", "out_of_range", { min: 1, max: MAX_PAGE_SIZE });
    }
    return { page, pageSize };
  }

  /** The `chat` filter: a JID (unknown shapes are refused, nothing is searched by guess) */
  function chatFilter(query) {
    if (query.chat === undefined || query.chat === "") return null;
    if (!CHAT_JID.test(query.chat)) throw fieldError("chat", "invalid_jid");
    return query.chat;
  }

  /** Display names of chats from `known_chats` (a group name, a contact's push name), by JID */
  async function chatNames(jids) {
    const unique = [...new Set(jids.filter(Boolean))];
    if (!unique.length) return new Map();
    const rows = await models().KnownChat.findAll({ where: { jid: { [Op.in]: unique } }, attributes: ["jid", "name"], raw: true });
    return new Map(rows.map((row) => [row.jid, row.name || null]));
  }

  /**
   * What differs per kind: model, the columns `q` searches, an extra condition, the `chat` column, the order, and
   * how a page of rows becomes items.
   */
  const SPECS = {
    reminders: {
      model: "Reminder",
      search: ["text"],
      chatColumn: "chatJid",
      base: (query) => (query.status === "all" ? [] : [{ status: "pending" }]),
      order: (query) =>
        query.status === "all"
          ? [["dueAt", "DESC"], ["id", "DESC"]]
          : [["dueAt", "ASC"], ["id", "ASC"]],
      async items(rows) {
        const names = await chatNames(rows.map((row) => row.chatJid));
        return rows.map((row) => ({
          id: row.id,
          chatJid: row.chatJid,
          chatName: names.get(row.chatJid) || null,
          creatorJid: row.creatorJid,
          dueAt: iso(row.dueAt),
          status: row.status,
          textPreview: preview(row.text),
        }));
      },
    },
    economy: {
      model: "GroupEconomy",
      search: ["userJid"],
      base: (query) => {
        if (query.groupJid === undefined || query.groupJid === "") throw fieldError("groupJid", "required");
        if (!GROUP_JID.test(query.groupJid)) throw fieldError("groupJid", "invalid_jid");
        return [{ groupJid: query.groupJid }];
      },
      order: () => [["balance", "DESC"], ["userJid", "ASC"]],
      items: async (rows) =>
        rows.map((row) => ({
          groupJid: row.groupJid,
          userJid: row.userJid,
          balance: row.balance || 0,
          streak: row.streak || 0,
          lastDailyAt: iso(row.lastDailyAt),
        })),
    },
    keywords: {
      model: "NotifyKeyword",
      search: ["keyword"],
      chatColumn: "scopeJid",
      order: () => [["id", "DESC"]],
      items: async (rows) =>
        rows.map((row) => ({ id: row.id, userJid: row.userJid, keyword: row.keyword, scopeJid: row.scopeJid, enabled: Boolean(row.enabled) })),
    },
    "sticker-commands": {
      model: "StickerCommand",
      search: ["command"],
      order: () => [["id", "DESC"]],
      items: async (rows) => rows.map((row) => ({ id: row.id, stickerHash: row.stickerHash, command: row.command, createdBy: row.createdBy })),
    },
    afk: {
      model: "User",
      search: ["jid", "name", "afkReason"],
      base: () => [{ afkTime: { [Op.ne]: null } }],
      order: () => [["afkTime", "DESC"], ["jid", "ASC"]],
      items: async (rows) =>
        rows.map((row) => ({ jid: row.jid, name: row.name || null, afkReason: row.afkReason || null, afkTime: iso(row.afkTime) })),
    },
    tasks: {
      model: "Task",
      search: ["text"],
      chatColumn: "chatJid",
      order: () => [["id", "DESC"]],
      items: async (rows) =>
        rows.map((row) => ({
          id: row.id,
          chatJid: row.chatJid,
          text: row.text,
          done: Boolean(row.done),
          createdBy: row.createdBy,
          doneBy: row.doneBy || null,
        })),
    },
    ideas: {
      model: "Idea",
      search: ["text"],
      chatColumn: "groupJid",
      order: () => [["id", "DESC"]],
      items: async (rows) =>
        rows.map((row) => ({
          id: row.id,
          groupJid: row.groupJid,
          authorJid: row.authorJid,
          text: row.text,
          category: row.category || "general",
          voters: Array.isArray(row.voters) ? row.voters.length : 0, // the getter of the model: a count only
        })),
    },
    quotes: {
      model: "Quote",
      search: ["text"],
      chatColumn: "groupJid",
      order: () => [["id", "DESC"]],
      items: async (rows) =>
        rows.map((row) => ({
          id: row.id,
          groupJid: row.groupJid,
          authorJid: row.authorJid,
          authorName: row.authorName || "",
          text: row.text,
          savedBy: row.savedBy,
        })),
    },
  };

  /**
   * DATA-1. `query` holds the strings of the request: `page`, `pageSize`, `q`, `chat`, `groupJid`, `status`.
   * A filter that does not apply to the kind is ignored; `groupJid` is required for `economy`.
   * @returns {Promise<{ items: object[], page: number, pageSize: number, total: number }>}
   */
  async function list(kind, query = {}) {
    const spec = Object.hasOwn(SPECS, kind) ? SPECS[kind] : null;
    if (!spec) throw notFound("kind");

    const { page, pageSize } = paging(query);
    const conditions = spec.base ? spec.base(query) : [];
    if (spec.chatColumn) {
      const chat = chatFilter(query);
      if (chat) conditions.push({ [spec.chatColumn]: chat });
    }
    const q = typeof query.q === "string" ? query.q.trim() : "";
    if (q) conditions.push(contains(spec.search, q));

    const { rows, count } = await models()[spec.model].findAndCountAll({
      where: conditions.length ? { [Op.and]: conditions } : {},
      order: spec.order(query),
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return { items: await spec.items(rows), page, pageSize, total: count };
  }

  // ---- DATA-2 ----------------------------------------------------------------------------------------

  /** A numeric id from the path, or a 404 (the route does not exist for that value) */
  function numericId(id, resource) {
    const text = String(id);
    if (!NUMERIC_ID.test(text)) throw notFound(resource);
    return Number(text);
  }

  /** Delete by id, 404 when no row matched, then drop the cache entries the owning command reads */
  async function destroyRow(modelName, id, resource, invalidate) {
    const removed = await models()[modelName].destroy({ where: { id: numericId(id, resource) } });
    if (!removed) throw notFound(resource);
    invalidate();
    return { deleted: true };
  }

  /**
   * DATA-2. `id` is the numeric id, except for `afk` where it is the user JID.
   *   reminders         cancelled through the scheduler (compare-and-swap); `not_pending` when it already left
   *                     the pending state
   *   afk               `afkReason` and `afkTime` cleared, the row stays
   *   economy           no delete: 404
   *   others            the row is deleted; 404 when it is absent
   * @returns {Promise<{ cancelled: true } | { deleted: true }>}
   */
  async function remove(kind, id) {
    if (!KINDS.includes(kind)) throw notFound("kind");
    switch (kind) {
      case "reminders": {
        const reminderId = numericId(id, "reminder");
        if (await scheduler().cancel(reminderId)) return { cancelled: true };
        const row = await models().Reminder.findByPk(reminderId, { attributes: ["id"], raw: true });
        if (!row) throw notFound("reminder");
        throw new AdminError("not_pending");
      }
      case "keywords":
        return destroyRow("NotifyKeyword", id, "keyword", () => settingsCache().invalidatePrefix(NOTIFY_PREFIX));
      case "sticker-commands":
        return destroyRow("StickerCommand", id, "sticker_command", () => settingsCache().invalidate(STICKER_CMDS_KEY));
      case "tasks":
        return destroyRow("Task", id, "task", () => {});
      case "ideas":
        return destroyRow("Idea", id, "idea", () => {});
      case "quotes":
        return destroyRow("Quote", id, "quote", () => {});
      case "afk": {
        const jid = perms().normalizeJid(String(id));
        if (!jid) throw notFound("afk");
        const [changed] = await models().User.update(
          { afkReason: null, afkTime: null },
          { where: { jid: { [Op.in]: [...new Set([jid, String(id)])] }, afkTime: { [Op.ne]: null } } },
        );
        if (!changed) throw notFound("afk");
        settingsCache().invalidate(AFK_KEY);
        return { deleted: true };
      }
      default: // economy
        throw notFound("economy");
    }
  }

  // ---- DATA-3 ----------------------------------------------------------------------------------------

  /** The open socket, or null (used only to resolve a LID to a phone number) */
  function socket() {
    const client = deps.client;
    if (!client) return null;
    try {
      if (typeof client.ready === "function" && !client.ready()) return null;
      return (typeof client.getSocket === "function" && client.getSocket()) || null;
    } catch {
      return null;
    }
  }

  /** Every form the member may be stored under, the phone-number form (the one the bot persists) first */
  async function identityForms(target) {
    const { toPnJid } = perms();
    let pn = target;
    try {
      pn = (await toPnJid({ isGroup: false, client: { getSocket: socket } }, target)) || target;
    } catch {
      pn = target; // the LID mapping is best effort
    }
    return { pn, forms: [...new Set([pn, target])] };
  }

  /** Validate the body of DATA-3 and derive the member's identity; throws `validation_failed` */
  function checkAdjustment(body) {
    const { normalizeJid } = perms();
    const problems = {};
    if (typeof body.groupJid !== "string" || !GROUP_JID.test(body.groupJid)) problems.groupJid = { code: "invalid_jid" };
    const target = normalizeJid(typeof body.userJid === "string" ? body.userJid : "");
    if (!/^\d{5,20}@(?:s\.whatsapp\.net|lid)$/.test(target)) problems.userJid = { code: "invalid_jid" };
    if (body.mode !== "set" && body.mode !== "add") problems.mode = { code: "not_allowed", params: { allowed: ["set", "add"] } };
    if (!Number.isSafeInteger(body.amount)) {
      problems.amount = { code: "invalid_type" };
    } else if (body.mode === "set" && (body.amount < 0 || body.amount > MAX_BALANCE)) {
      problems.amount = { code: "out_of_range", params: { min: 0, max: MAX_BALANCE } };
    } else if (body.mode === "add" && Math.abs(body.amount) > MAX_BALANCE) {
      problems.amount = { code: "out_of_range", params: { min: -MAX_BALANCE, max: MAX_BALANCE } };
    }
    const reason = typeof body.reason === "string" ? body.reason.normalize("NFC").trim() : "";
    const length = Array.from(reason).length;
    if (length < 1) problems.reason = { code: typeof body.reason === "string" ? "too_short" : "required", params: { min: 1 } };
    else if (length > MAX_REASON) problems.reason = { code: "too_long", params: { max: MAX_REASON } };
    if (Object.keys(problems).length) throw new AdminError("validation_failed", { fields: problems });
    return { target, reason };
  }

  /**
   * DATA-3. `body` is `{ groupJid, userJid, mode: "set"|"add", amount, reason }`; `origin` is the request origin,
   * kept in the audit row. Resolves with `{ balance, delta }` (the balance read back, the delta really applied).
   * @throws {AdminError} `validation_failed`, `negative_balance` (nothing written), `conflict`
   */
  async function adjustEconomy(body = {}, { origin = null } = {}) {
    const { target, reason } = checkAdjustment(body);
    const { groupJid, mode, amount } = body;
    const { pn, forms } = await identityForms(target);
    const eco = economy();
    const { GroupEconomy, DATABASE } = models();

    return eco.withLock(`give:${groupJid}`, () =>
      DATABASE.transaction(async (transaction) => {
        // The account to change: the form the administrator named, else the phone-number form, else any known
        // form; a new account is created under the phone-number form
        const rows = await GroupEconomy.findAll({ where: { groupJid, userJid: { [Op.in]: forms } }, transaction });
        const existing = rows.find((row) => row.userJid === target) || rows.find((row) => row.userJid === pn) || rows[0] || null;
        const userJid = existing ? existing.userJid : pn;

        let delta = 0;
        for (let attempt = 1; ; attempt += 1) {
          const old = (await eco.getBalance(groupJid, userJid, transaction)) || 0;
          delta = mode === "set" ? amount - old : amount;
          if (old + delta > MAX_BALANCE) throw fieldError("amount", "out_of_range", { min: mode === "set" ? 0 : -MAX_BALANCE, max: MAX_BALANCE });
          if (delta >= 0) {
            if (delta > 0) {
              await eco.ensureAccount(groupJid, userJid, transaction);
              await eco.applyDelta(groupJid, userJid, delta, { transaction });
            }
            break;
          }
          // A debit: one guarded statement, 0 rows means the balance would go below 0 and nothing is written
          if (await eco.applyDelta(groupJid, userJid, delta, { minBalance: -delta, transaction })) break;
          const current = (await eco.getBalance(groupJid, userJid, transaction)) || 0;
          if (mode === "add") throw new AdminError("negative_balance", { params: { balance: current } });
          // "set" computed its delta from a balance that moved meanwhile: read again, a few times at most
          if (attempt >= SET_ATTEMPTS) throw new AdminError("conflict");
        }

        const balance = (await eco.getBalance(groupJid, userJid, transaction)) || 0;
        const audit = deps.audit;
        if (audit && typeof audit.record === "function") {
          // with a transaction `record` rejects on failure: the adjustment and its history commit or fail together
          await audit.record(
            { action: "economy.adjust", target: `${groupJid}:${userJid}`, origin, result: "ok", detail: { mode, delta, balance, reason } },
            { transaction },
          );
        }
        return { balance, delta };
      }),
    );
  }

  return { kinds: KINDS, list, remove, adjustEconomy };
}

module.exports = { createDataService, KINDS, MAX_BALANCE, MAX_REASON, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, preview };
