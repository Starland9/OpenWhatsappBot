"use strict";

/**
 * Groups, group guard and chats of the admin panel (admin-http-api.md sections 2.7 to 2.9, GRP-1..17, GRD-1/2,
 * CHAT-1..3; data-model 3.1, 3.2 and 3.5; contracts/runtime.md sections 7 and 8). It never touches `req`/`res`.
 *
 *   const groups = createGroupsService({ models, getClient, now, logger, ... });
 *   groups.list(query)                   GRP-1   { items, page, pageSize, total, refreshedAt }
 *   groups.refresh()                     GRP-2   { refreshedAt, cached }
 *   groups.describe(jid)                 GRP-3   the group object with `warnings` and `limits`
 *   groups.update(jid, patch)            GRP-4   welcome / goodbye / disabled, answers GRP-3
 *   groups.preview(jid, body)            GRP-5   { rendered, unknownVariables }, writes nothing
 *   groups.deleteSettings(jid)           GRP-6   one transaction, data-model 3.5
 *   groups.listFilters / addFilter / editFilter / deleteFilter                    GRP-7..10
 *   groups.members(jid) / listRoles(jid) / setRole(jid, userJid, role)            GRP-11..13
 *   groups.listWarnings / resetWarnings / resetAllWarnings                        GRP-14..16
 *   groups.toggleCommands(jid, lists, { actor })                                  GRP-17
 *   groups.setGuard(jid, flags) / setMute(jid, muted)                             GRD-1, GRD-2
 *   groups.listChats(query) / listDisabledChats() / enableChat(jid)               CHAT-1..3
 *   groups.start() / stop()              follow the group fetches made by plugins/knownchats.js; idempotent
 *
 * Data lives in the existing tables. Every write goes through the helpers the plugins also use and drops the
 * matching `settingsCache` key (`group:<jid>`, `filters:<jid>`, `roles:<jid>`, `banned_chats`, `command_state`),
 * so the bot sees a panel change at its next message without waiting for the 5 minute TTL (FR-030).
 *
 * Group metadata (names, member counts, "the bot is an administrator") is a compact snapshot filled by
 * `groupFetchAllParticipating()`: at most every 6 hours, on GRP-2 (not more than once per 60 s) and by the
 * `onReady` refresh of the hook plugin. A single group's live metadata is cached for 60 s. Anything unknown is
 * `null`; the bot being disconnected never breaks a read.
 *
 * Time: everything that depends on the clock goes through `now()`. No timer exists here.
 * Errors: `AdminError`s (codes of admin-http-api.md 1.9); raw WhatsApp errors go to the logger through `safeLog`.
 */

const { Op } = require("sequelize");
const { AdminError } = require("../http/response");

const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000; // a stale snapshot is refreshed in the background
const REFRESH_MIN_GAP_MS = 60 * 1000; // GRP-2: one WhatsApp fetch per minute at most
const METADATA_TTL_MS = 60 * 1000;
const METADATA_MAX_ENTRIES = 200;
const WHATSAPP_TIMEOUT_MS = 10 * 1000;
const FIRST_FETCH_TIMEOUT_MS = 8 * 1000;

const VARIABLES = Object.freeze(["@user", "@group", "@desc"]);
const ROLES = Object.freeze(["regular", "vip", "muted", "banned"]);
const MAX_COMMAND_NAMES = 200;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const iso = (value) => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const fieldError = (name, code, params) =>
  new AdminError("validation_failed", { fields: { [name]: params ? { code, params } : { code } } });

// ---------------------------------------------------------------------------
// Template variables (the closed grammar of admin-http-api.md 1.9)
// ---------------------------------------------------------------------------

/**
 * Names of the unknown variables of a welcome or goodbye template, lower-cased, with their `@`, in order of
 * appearance, without duplicates. A variable is an `@` followed by letters, not preceded by a letter, a digit,
 * a dot or an underscore (so an e-mail address or a number mention is not one); only `@user`, `@group` and
 * `@desc` are known. The browser mirrors this grammar (views/groups-logic.mjs).
 * @param {string} text
 * @returns {string[]}
 */
function findUnknownVariables(text) {
  const names = [];
  for (const match of String(text ?? "").matchAll(/(?<![A-Za-z0-9._])@([A-Za-z]+)/g)) {
    const name = `@${match[1].toLowerCase()}`;
    if (!VARIABLES.includes(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/** `{ names }` of a refused template as the `unknown_variable` field error of `<field>` */
const unknownVariableError = (field, names) => fieldError(field, "unknown_variable", { names });

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

const isAdminParticipant = (p) =>
  !!p && (p.admin === "admin" || p.admin === "superadmin" || p.isAdmin === true || p.isSuperAdmin === true);

/** The group metadata says this participant is an administrator? (`ids` are normalized JIDs) */
function hasAdmin(metadata, ids, normalizeJid) {
  const wanted = new Set(ids.filter(Boolean));
  if (!wanted.size) return false;
  const found = (metadata?.participants || []).find((p) =>
    [p.id, p.phoneNumber, p.lid].some((x) => x && wanted.has(normalizeJid(x))),
  );
  return isAdminParticipant(found);
}

/** A WhatsApp failure that means "this group is gone for the bot" */
function isGoneError(err) {
  const status = Number(err?.data ?? err?.output?.statusCode ?? err?.statusCode);
  if (status === 403 || status === 404) return true;
  return /item-not-found|forbidden|not-authorized|not-acceptable/i.test(String(err?.message || ""));
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function createGroupsService(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const logger = options.logger || { debug() {}, info() {}, warn() {}, error() {} };

  // Everything below is resolved lazily so that a missing module never breaks the loading of the others
  const models = () => options.models || require("../../database");
  const clientOf = () => (typeof options.getClient === "function" ? options.getClient() : options.client) || null;
  const perms = () => options.permissions || require("../../utils/permissions");
  const http = () => options.http || require("../../utils/http");
  const settingsCache = () => options.settingsCache || require("../../utils/settingsCache");
  const knownChats = () => options.knownChats || require("../../utils/knownChats");
  const commandState = () => options.commandState || require("../../utils/commandState");
  const warnings = () => options.warnings || require("../../utils/warnings");
  const mutex = () => options.mutex || require("../../utils/mutex");
  const registry = () => options.registry || require("../../plugins/registry");
  const config = () => options.config || require("../../../config");
  const plugin = (name) => (options.plugins && options.plugins[name]) || require(`../../../plugins/${name}`);

  // ---- WhatsApp access ---------------------------------------------------------------------

  /** The open socket, or null when the bot is not connected */
  function socket() {
    const client = clientOf();
    if (!client) return null;
    try {
      if (typeof client.ready === "function" && !client.ready()) return null;
      return (typeof client.getSocket === "function" && client.getSocket()) || null;
    } catch {
      return null;
    }
  }

  const requireSocket = () => {
    const sock = socket();
    if (!sock) throw new AdminError("not_connected");
    return sock;
  };

  const botIds = (sock) => {
    const { pn, lid } = perms().getBotJids(sock);
    return [pn, lid].filter(Boolean);
  };

  // ---- Compact snapshot of every group ---------------------------------------------------

  /** @type {{ at: number|null, byJid: Map<string, { name: string, members: number|null, botIsAdmin: boolean|null }> }} */
  let snapshot = { at: null, byJid: new Map() };
  let lastFetchAt = null;
  let inflight = null;
  let unsubscribe = null;

  /** Keep only what the list needs from the (large) Baileys answer */
  function ingest(groups, at) {
    const sock = socket();
    const ids = sock ? botIds(sock) : [];
    const { normalizeJid } = perms();
    const entries = Array.isArray(groups) ? groups.map((g) => [g?.id, g]) : Object.entries(groups || {});
    const byJid = new Map();
    for (const [jid, metadata] of entries) {
      if (typeof jid !== "string" || !jid) continue;
      const count = Array.isArray(metadata?.participants) ? metadata.participants.length : Number(metadata?.size);
      byJid.set(jid, {
        name: String(metadata?.subject || ""),
        members: Number.isFinite(count) ? count : null,
        botIsAdmin: ids.length && metadata?.participants ? hasAdmin(metadata, ids, normalizeJid) : null,
      });
    }
    snapshot = { at, byJid };
    lastFetchAt = at;
  }

  /** One fetch at a time. Resolves when the snapshot and `known_chats` are synchronized. */
  function fetchGroups(sock) {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const result = await http().withTimeout(
          plugin("knownchats").syncGroups(sock, { now: now() }),
          WHATSAPP_TIMEOUT_MS * 3,
          "group fetch",
        );
        if (result) ingest(result.groups, now());
      } catch (err) {
        logger.warn({ err: http().safeLog(err) }, "groups: the group fetch failed");
        throw new AdminError("whatsapp_error", { cause: err });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /** The first listing after a start waits for the snapshot (bounded); a stale one refreshes behind the answer */
  async function warmSnapshot() {
    const sock = socket();
    if (!sock) return;
    if (snapshot.at === null) {
      try {
        await http().withTimeout(fetchGroups(sock), FIRST_FETCH_TIMEOUT_MS, "first group fetch");
      } catch {
        // unknown stays null
      }
    } else if (now() - snapshot.at > SNAPSHOT_MAX_AGE_MS && !inflight) {
      fetchGroups(sock).catch(() => {});
    }
  }

  // ---- Live metadata of one group (60 s) ----------------------------------------------------

  const metadataCache = new Map(); // jid -> { at, value }

  /**
   * Live metadata of a group, cached for 60 s.
   * `required: true` throws `not_connected`, `group_left` or `whatsapp_error`; otherwise null when unavailable.
   */
  async function metadataOf(jid, { required = false, force = false } = {}) {
    const sock = socket();
    if (!sock) {
      if (required) throw new AdminError("not_connected");
      return null;
    }
    const cached = metadataCache.get(jid);
    if (!force && cached && now() - cached.at < METADATA_TTL_MS) return cached;
    try {
      const value = await http().withTimeout(sock.groupMetadata(jid), WHATSAPP_TIMEOUT_MS, "groupMetadata");
      if (!value) throw Object.assign(new Error("no metadata"), { data: 404 });
      if (metadataCache.size >= METADATA_MAX_ENTRIES) metadataCache.delete(metadataCache.keys().next().value);
      const entry = { at: now(), value };
      metadataCache.set(jid, entry);
      return entry;
    } catch (err) {
      metadataCache.delete(jid);
      if (!required) return null;
      if (isGoneError(err)) throw new AdminError("group_left", { cause: err });
      logger.warn({ err: http().safeLog(err) }, "groups: group metadata unavailable");
      throw new AdminError("whatsapp_error", { cause: err });
    }
  }

  const isBotAdminIn = (metadata) => {
    const sock = socket();
    if (!sock || !metadata) return null;
    const ids = botIds(sock);
    return ids.length ? hasAdmin(metadata, ids, perms().normalizeJid) : null;
  };

  /** A message look-alike for the permission helpers: the panel has no sender, so nobody is "yourself" */
  function standIn(jid) {
    return {
      isGroup: true,
      jid,
      sender: "",
      senderLid: "",
      client: { getSocket: () => socket() },
      getGroupMetadata: async () => (await metadataOf(jid))?.value || null,
    };
  }

  /**
   * Every identity a member may be stored under: the phone-number form (the one the bot persists), the JID as
   * given, and, when the live metadata knows the member, every other form of that participant (LID and PN).
   */
  async function formsFor(jid, target) {
    const { normalizeJid, toPnJid } = perms();
    const pn = await toPnJid(standIn(jid), target);
    const forms = new Set([pn, target].filter(Boolean));
    const metadata = (await metadataOf(jid))?.value;
    for (const participant of metadata?.participants || []) {
      const ids = [participant.id, participant.phoneNumber, participant.lid].map(normalizeJid).filter(Boolean);
      if (ids.includes(target) || (pn && ids.includes(pn))) ids.forEach((id) => forms.add(id));
    }
    return { pn, forms: [...forms] };
  }

  // ---- Which groups exist -------------------------------------------------------------------

  /** Rows that make a group known to the panel (404 otherwise) */
  async function locate(jid) {
    const { Group, KnownChat } = models();
    const [group, chat] = await Promise.all([
      Group.findByPk(jid, { raw: true }),
      KnownChat.findByPk(jid, { raw: true }),
    ]);
    if (!group && !(chat && chat.kind === "group")) {
      throw new AdminError("not_found", { params: { resource: "group" } });
    }
    return { group, chat: chat && chat.kind === "group" ? chat : null };
  }

  /** The Group row (created on first use) */
  async function groupRow(jid, known) {
    const { Group } = models();
    const [row] = await Group.findOrCreate({ where: { jid }, defaults: { name: known?.chat?.name || "" } });
    return row;
  }

  // ---- Cache keys -----------------------------------------------------------------------------

  const invalidateGroup = (jid) => plugin("setwelcome").invalidateGroupSettings(jid);
  const invalidateBanned = () => {
    let key = "banned_chats";
    try {
      key = require("../../core/pipeline").BANNED_CHATS_KEY || key;
    } catch {
      // the literal key is the same one
    }
    settingsCache().invalidate(key);
  };

  // ---- GRP-1, GRP-2 ----------------------------------------------------------------------------

  /** page / pageSize of a list route, clamped by validation (never silently) */
  function pagingOf(query) {
    const page = query.page === undefined ? 1 : Number(query.page);
    const pageSize = query.pageSize === undefined ? DEFAULT_PAGE_SIZE : Number(query.pageSize);
    if (!Number.isInteger(page) || page < 1) throw fieldError("page", "out_of_range", { min: 1 });
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw fieldError("pageSize", "out_of_range", { min: 1, max: MAX_PAGE_SIZE });
    }
    return { page, pageSize };
  }

  async function list(query = {}) {
    const { page, pageSize } = pagingOf(query);
    const status = query.status || "all";
    const needle = String(query.q || "").trim().toLowerCase();

    await warmSnapshot();
    const { Group, KnownChat, BannedChat } = models();
    const [chats, rows, banned] = await Promise.all([
      KnownChat.findAll({ where: { kind: "group" }, attributes: ["jid", "name", "leftAt"], raw: true }),
      Group.findAll({
        attributes: ["jid", "name", "welcome", "goodbye", "antilink", "antibot", "mute"],
        raw: true,
      }),
      BannedChat.findAll({ attributes: ["jid"], raw: true }),
    ]);
    const disabled = new Set(banned.map((row) => row.jid));
    const settings = new Map(rows.map((row) => [row.jid, row]));

    const items = new Map();
    const add = (jid, chat) => {
      const row = settings.get(jid);
      const live = snapshot.byJid.get(jid);
      items.set(jid, {
        jid,
        name: live?.name || chat?.name || row?.name || "",
        members: live ? live.members : null,
        botIsAdmin: live ? live.botIsAdmin : null,
        former: Boolean(chat?.leftAt),
        leftAt: iso(chat?.leftAt),
        welcome: Boolean(row?.welcome),
        goodbye: Boolean(row?.goodbye),
        antilink: Boolean(row?.antilink),
        antibot: Boolean(row?.antibot),
        mute: Boolean(row?.mute),
        disabled: disabled.has(jid),
      });
    };
    for (const chat of chats) add(chat.jid, chat);
    for (const row of rows) if (!items.has(row.jid)) add(row.jid, null);

    const sortKey = (item) => (item.name || item.jid).toLowerCase();
    const selected = [...items.values()]
      .filter((item) => (status === "current" ? !item.former : status === "former" ? item.former : true))
      .filter((item) => !needle || item.name.toLowerCase().includes(needle))
      .sort((a, b) => Number(a.former) - Number(b.former) || sortKey(a).localeCompare(sortKey(b)) || a.jid.localeCompare(b.jid));

    return {
      items: selected.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: selected.length,
      refreshedAt: iso(snapshot.at),
    };
  }

  async function refresh() {
    const sock = requireSocket();
    if (lastFetchAt !== null && now() - lastFetchAt < REFRESH_MIN_GAP_MS) {
      return { refreshedAt: iso(snapshot.at), cached: true };
    }
    await fetchGroups(sock);
    return { refreshedAt: iso(snapshot.at), cached: false };
  }

  // ---- GRP-3 -------------------------------------------------------------------------------------

  async function commandNamesOff(jid) {
    const state = await commandState().snapshot({ commands: [] });
    return (state.byGroup && state.byGroup[jid]) || [];
  }

  async function describe(jid) {
    const known = await locate(jid);
    const { Filter, GroupRole, Warn, BannedChat } = models();
    const row = known.group || {};
    const former = Boolean(known.chat?.leftAt);

    const live = former ? null : await metadataOf(jid);
    const snap = snapshot.byJid.get(jid);
    const members = live
      ? Array.isArray(live.value.participants)
        ? live.value.participants.length
        : Number(live.value.size) || null
      : snap
        ? snap.members
        : null;
    const botIsAdmin = former ? null : live ? isBotAdminIn(live.value) : snap ? snap.botIsAdmin : null;

    const [filters, roles, warned, banned, disabledCommands] = await Promise.all([
      Filter.count({ where: { groupJid: jid } }),
      GroupRole.count({ where: { groupJid: jid, role: { [Op.ne]: "regular" } } }),
      Warn.count({ where: { groupJid: jid, count: { [Op.gt]: 0 } } }),
      BannedChat.count({ where: { jid } }),
      commandNamesOff(jid),
    ]);

    const welcomePlugin = plugin("setwelcome");
    const goodbyePlugin = plugin("goodbye");
    const out = {
      jid,
      name: live?.value?.subject || snap?.name || known.chat?.name || row.name || "",
      members,
      botIsAdmin,
      former,
      leftAt: iso(known.chat?.leftAt),
      welcome: {
        enabled: Boolean(row.welcome),
        message: welcomePlugin.welcomeTemplate(row),
        custom: !welcomePlugin.isDefaultTemplate(row.welcomeMsg),
      },
      goodbye: {
        enabled: Boolean(row.goodbye),
        message: goodbyePlugin.goodbyeTemplate(row),
        custom: !goodbyePlugin.isDefaultTemplate(row.goodbyeMsg),
      },
      antilink: Boolean(row.antilink),
      antibot: Boolean(row.antibot),
      mute: Boolean(row.mute),
      disabled: banned > 0,
      counts: { filters, roles, warnings: warned },
      disabledCommands,
      variables: [...VARIABLES],
      limits: limits(),
      warnings: [],
    };
    if ((out.antilink || out.antibot || out.mute) && botIsAdmin === false) out.warnings.push("bot_not_admin");
    return out;
  }

  function limits() {
    const filtersPlugin = plugin("addfilter");
    return {
      messageMax: plugin("setwelcome").MAX_TEMPLATE_LENGTH,
      filtersMax: filtersPlugin.MAX_FILTERS_PER_GROUP,
      patternMax: filtersPlugin.MAX_PATTERN_LENGTH,
      responseMax: filtersPlugin.MAX_RESPONSE_LENGTH,
    };
  }

  // ---- GRP-4, GRP-5 --------------------------------------------------------------------------------

  /**
   * @param {string} jid
   * @param {{ welcome?: { enabled?: boolean, message?: string|null }, goodbye?: object, disabled?: boolean }} patch
   *   already validated by the route (strict schemas)
   * @returns {Promise<{ group: object, changed: object }>} the GRP-3 object and what was written (for the audit)
   */
  async function update(jid, patch) {
    const known = await locate(jid);
    for (const kind of ["welcome", "goodbye"]) {
      const part = patch[kind];
      if (!part) continue;
      if (part.message !== undefined && part.message !== null) {
        const names = findUnknownVariables(part.message);
        if (names.length) throw unknownVariableError(`${kind}.message`, names);
      }
    }

    const changed = {};
    if (patch.welcome || patch.goodbye) {
      const row = await groupRow(jid, known);
      for (const kind of ["welcome", "goodbye"]) {
        const part = patch[kind];
        if (!part) continue;
        changed[kind] = {};
        if (part.enabled !== undefined) {
          row[kind] = part.enabled;
          changed[kind].enabled = part.enabled;
        }
        if (part.message !== undefined) {
          row[`${kind}Msg`] = part.message; // null = back to the default, like `.welcome reset`
          changed[kind].message = part.message === null ? "reset" : { length: Array.from(part.message).length };
        }
      }
      await row.save();
      invalidateGroup(jid);
    }

    if (patch.disabled !== undefined) {
      const { BannedChat } = models();
      if (patch.disabled) await BannedChat.findOrCreate({ where: { jid }, defaults: { jid, bannedBy: null } });
      else await BannedChat.destroy({ where: { jid } });
      invalidateBanned();
      changed.disabled = patch.disabled;
    }
    return { group: await describe(jid), changed };
  }

  async function preview(jid, { message }) {
    const known = await locate(jid);
    const live = await metadataOf(jid);
    const snap = snapshot.byJid.get(jid);
    return {
      rendered: plugin("setwelcome").renderTemplate(message, {
        user: "@member",
        group: live?.value?.subject || snap?.name || known.chat?.name || known.group?.name || "",
        desc: live?.value?.desc || "",
      }),
      unknownVariables: findUnknownVariables(message),
    };
  }

  // ---- GRP-6 -----------------------------------------------------------------------------------------

  async function deleteSettings(jid) {
    await locate(jid);
    const { DATABASE, Filter, GroupRole, Warn, BannedChat, CommandState, Group, KnownChat } = models();
    const deleted = await mutex().withLock("groups:settings-delete", () =>
      DATABASE.transaction(async (transaction) => {
        const count = {};
        // children first
        count.filters = await Filter.destroy({ where: { groupJid: jid }, transaction });
        count.roles = await GroupRole.destroy({ where: { groupJid: jid }, transaction });
        count.warnings = await Warn.destroy({ where: { groupJid: jid }, transaction });
        await BannedChat.destroy({ where: { jid }, transaction });
        count.commandStates = await CommandState.destroy({ where: { scope: jid }, transaction });
        count.group = await Group.destroy({ where: { jid }, transaction });
        // the chat row of a group the bot has left goes too; a group the bot is in stays known
        await KnownChat.destroy({ where: { jid, leftAt: { [Op.ne]: null } }, transaction });
        return count;
      }),
    );
    invalidateGroup(jid);
    plugin("addfilter").invalidateFilters(jid);
    plugin("role").invalidateRoles(jid);
    invalidateBanned();
    commandState().invalidate();
    return { deleted: { group: deleted.group, filters: deleted.filters, roles: deleted.roles, warnings: deleted.warnings, commandStates: deleted.commandStates } };
  }

  // ---- GRP-7..10 ---------------------------------------------------------------------------------------

  const squash = (text) => String(text).trim().replace(/\s+/g, " ");

  /** Pattern and response of a filter, validated like `.filter` does; returns the stored forms */
  function checkFilterInput({ pattern, response }) {
    const { MAX_PATTERN_LENGTH, MAX_RESPONSE_LENGTH } = plugin("addfilter");
    const cleanPattern = squash(pattern);
    const cleanResponse = String(response).trim();
    const fields = {};
    const length = (text) => Array.from(text).length;
    if (!cleanPattern) fields.pattern = { code: "too_short", params: { min: 1 } };
    else if (length(cleanPattern) > MAX_PATTERN_LENGTH) fields.pattern = { code: "too_long", params: { max: MAX_PATTERN_LENGTH } };
    if (!cleanResponse) fields.response = { code: "too_short", params: { min: 1 } };
    else if (length(cleanResponse) > MAX_RESPONSE_LENGTH) fields.response = { code: "too_long", params: { max: MAX_RESPONSE_LENGTH } };
    if (Object.keys(fields).length) throw new AdminError("validation_failed", { fields });
    return { pattern: cleanPattern, response: cleanResponse };
  }

  const filterView = (row) => ({ id: row.id, pattern: row.pattern, response: row.response });

  async function listFilters(jid) {
    await locate(jid);
    const rows = await plugin("addfilter").loadFilters(jid);
    return { filters: rows.map(filterView), limits: limits() };
  }

  async function addFilter(jid, input) {
    await locate(jid);
    const { Filter } = models();
    const filters = plugin("addfilter");
    const { pattern, response } = checkFilterInput(input);
    return await mutex().withLock(`filters:${jid}`, async () => {
      const rows = await filters.loadFilters(jid);
      const wanted = filters.normalizePattern(pattern);
      if (rows.some((row) => filters.normalizePattern(row.pattern) === wanted)) throw new AdminError("duplicate");
      if (rows.length >= filters.MAX_FILTERS_PER_GROUP) throw new AdminError("limit_reached");
      const created = await Filter.create({ groupJid: jid, pattern, response, isGlobal: false });
      filters.invalidateFilters(jid);
      return filterView(created);
    });
  }

  async function editFilter(jid, id, input) {
    await locate(jid);
    const { Filter } = models();
    const filters = plugin("addfilter");
    const { pattern, response } = checkFilterInput(input);
    return await mutex().withLock(`filters:${jid}`, async () => {
      const rows = await filters.loadFilters(jid);
      if (!rows.some((row) => row.id === id)) throw new AdminError("not_found", { params: { resource: "filter" } });
      const wanted = filters.normalizePattern(pattern);
      if (rows.some((row) => row.id !== id && filters.normalizePattern(row.pattern) === wanted)) {
        throw new AdminError("duplicate");
      }
      await Filter.update({ pattern, response }, { where: { id, groupJid: jid } });
      filters.invalidateFilters(jid);
      return { id, pattern, response };
    });
  }

  async function deleteFilter(jid, id) {
    await locate(jid);
    const { Filter } = models();
    return await mutex().withLock(`filters:${jid}`, async () => {
      const removed = await Filter.destroy({ where: { id, groupJid: jid } });
      if (!removed) throw new AdminError("not_found", { params: { resource: "filter" } });
      plugin("addfilter").invalidateFilters(jid);
      return { deleted: true };
    });
  }

  // ---- GRP-11..13 ---------------------------------------------------------------------------------------

  async function members(jid) {
    const known = await locate(jid);
    if (known.chat?.leftAt) throw new AdminError("group_left");
    requireSocket();
    const entry = await metadataOf(jid, { required: true });
    const { normalizeJid, isPnJid } = perms();
    const roles = plugin("role");

    const items = [];
    for (const p of entry.value.participants || []) {
      const forms = [p.phoneNumber, p.id, p.lid].map(normalizeJid).filter(Boolean);
      if (!forms.length) continue;
      items.push({
        jid: forms.find(isPnJid) || forms[0],
        admin: p.admin === "superadmin" || p.isSuperAdmin === true ? "superadmin" : isAdminParticipant(p) ? "admin" : null,
        role: await roles.getRole(jid, forms),
      });
    }
    return { items, fetchedAt: iso(entry.at) };
  }

  async function listRoles(jid) {
    await locate(jid);
    const { GroupRole } = models();
    const rows = await GroupRole.findAll({
      where: { groupJid: jid, role: { [Op.ne]: "regular" } },
      order: [["setAt", "DESC"]],
      raw: true,
    });
    return {
      items: rows.map((row) => ({ userJid: row.userJid, role: row.role, setBy: row.setBy || null, setAt: iso(row.setAt) })),
    };
  }

  async function setRole(jid, userJid, role) {
    const known = await locate(jid);
    if (!ROLES.includes(role)) throw fieldError("role", "not_allowed", { allowed: [...ROLES] });
    const { normalizeJid, guardTarget } = perms();
    const target = normalizeJid(userJid);
    if (!target) throw fieldError("userJid", "invalid_jid");

    if (role === "muted" || role === "banned") {
      // The target must not be the bot, an owner or the creator: that needs the live metadata
      if (known.chat?.leftAt) throw new AdminError("group_left");
      await metadataOf(jid, { required: true });
      if (await guardTarget(standIn(jid), target)) throw new AdminError("target_protected");
    }

    const { pn, forms } = await formsFor(jid, target);
    const roles = plugin("role");
    const { GroupRole } = models();
    await mutex().withLock(`roles:${jid}`, async () => {
      if (role === "regular") {
        await GroupRole.destroy({ where: { groupJid: jid, userJid: { [Op.in]: forms } } });
        return;
      }
      const [row] = await GroupRole.findOrCreate({
        where: { groupJid: jid, userJid: pn },
        defaults: { role, setBy: null, setAt: new Date(now()) },
      });
      await row.update({ role, setBy: null, setAt: new Date(now()) });
      const others = forms.filter((form) => form !== pn);
      if (others.length) await GroupRole.destroy({ where: { groupJid: jid, userJid: { [Op.in]: others } } });
    });
    roles.invalidateRoles(jid);
    return { userJid: pn, role };
  }

  // ---- GRP-14..16 ----------------------------------------------------------------------------------------

  async function listWarnings(jid) {
    await locate(jid);
    const rows = await warnings().listWarned(jid);
    return {
      items: rows.map((row) => ({ jid: row.jid, count: row.count, reason: row.reason || "", updatedAt: iso(row.updatedAt) })),
      limit: config().WARN_LIMIT,
    };
  }

  async function resetWarnings(jid, userJid) {
    await locate(jid);
    const { normalizeJid } = perms();
    const target = normalizeJid(userJid);
    if (!target) throw fieldError("userJid", "invalid_jid");
    const { forms } = await formsFor(jid, target);
    return { reset: await warnings().clearWarnings(forms, jid) };
  }

  async function resetAllWarnings(jid) {
    await locate(jid);
    return { reset: await warnings().clearGroupWarnings(jid) };
  }

  // ---- GRP-17 -----------------------------------------------------------------------------------------------

  /**
   * Disable and enable commands in this group only (the group page's mirror of CMD-2).
   * @param {string} jid
   * @param {{ disable?: string[], enable?: string[] }} lists command names or aliases
   * @param {{ actor?: string }} [meta]
   * @returns {Promise<{ disabledCommands: string[], warnings: string[], changes: { name: string, disabled: boolean }[] }>}
   */
  async function toggleCommands(jid, { disable = [], enable = [] } = {}, { actor } = {}) {
    await locate(jid);
    if (disable.length + enable.length === 0) {
      throw new AdminError("validation_failed", {
        fields: { disable: { code: "required" }, enable: { code: "required" } },
      });
    }
    if (disable.length + enable.length > MAX_COMMAND_NAMES) {
      throw fieldError(disable.length > MAX_COMMAND_NAMES ? "disable" : "enable", "too_many_items", { max: MAX_COMMAND_NAMES });
    }

    const reg = registry();
    const nameOf = (raw) => {
      const entry = reg.getCommandByPattern(raw);
      return entry ? entry.name : null;
    };
    // a name is resolved through its aliases; an unknown one may only be enabled (an orphan row)
    const toDisable = [];
    for (const raw of disable) {
      const name = nameOf(raw);
      if (!name) throw new AdminError("not_found", { params: { resource: "command" } });
      toDisable.push(name);
    }
    const toEnable = enable.map((raw) => nameOf(raw) || String(raw).trim().toLowerCase());
    if (toDisable.some((name) => toEnable.includes(name))) {
      throw fieldError("disable", "invalid_format");
    }

    const out = { warnings: [], changes: [] };
    try {
      for (const name of new Set(toDisable)) {
        const result = await commandState().toggle(name, { disable: [jid] }, { actor });
        out.warnings.push(...result.warnings);
        out.changes.push({ name, disabled: true });
      }
      for (const name of new Set(toEnable)) {
        await commandState().toggle(name, { enable: [jid] }, { actor });
        out.changes.push({ name, disabled: false });
      }
    } catch (err) {
      if (err && ["invalid_command", "invalid_scope", "invalid_format"].includes(err.code)) {
        throw fieldError(err.code === "invalid_command" ? "enable" : "disable", "invalid_format");
      }
      throw err;
    }
    out.warnings = [...new Set(out.warnings)];
    return { disabledCommands: await commandNamesOff(jid), warnings: out.warnings, changes: out.changes };
  }

  // ---- GRD-1, GRD-2 ---------------------------------------------------------------------------------------------

  async function setGuard(jid, flags) {
    const known = await locate(jid);
    const row = await groupRow(jid, known);
    const changed = {};
    for (const key of ["antilink", "antibot"]) {
      if (flags[key] === undefined) continue;
      row[key] = flags[key];
      changed[key] = flags[key];
    }
    await row.save();
    invalidateGroup(jid);

    // The switches are saved anyway; the bot being unable to enforce them is only a warning (FR-032)
    const live = known.chat?.leftAt ? null : await metadataOf(jid);
    const botIsAdmin = live ? isBotAdminIn(live.value) : (snapshot.byJid.get(jid) || {}).botIsAdmin ?? null;
    const out = { antilink: Boolean(row.antilink), antibot: Boolean(row.antibot), warnings: [] };
    if ((out.antilink || out.antibot) && botIsAdmin === false) out.warnings.push("bot_not_admin");
    return { result: out, changed };
  }

  async function setMute(jid, muted) {
    const known = await locate(jid);
    if (known.chat?.leftAt) throw new AdminError("group_left");
    const sock = requireSocket();
    const live = await metadataOf(jid, { required: true, force: true });
    if (isBotAdminIn(live.value) !== true) throw new AdminError("bot_not_admin");

    try {
      await http().withTimeout(
        sock.groupSettingUpdate(jid, muted ? "announcement" : "not_announcement"),
        WHATSAPP_TIMEOUT_MS,
        "groupSettingUpdate",
      );
    } catch (err) {
      logger.warn({ err: http().safeLog(err) }, "groups: the mute update failed");
      if (isGoneError(err)) throw new AdminError("group_left", { cause: err });
      throw new AdminError("whatsapp_error", { cause: err });
    }

    // Only a success is written: `Group.mute` mirrors the last state the bot set, not WhatsApp's live setting
    const row = await groupRow(jid, known);
    row.mute = muted;
    await row.save();
    invalidateGroup(jid);
    metadataCache.delete(jid);
    return { muted };
  }

  // ---- CHAT-1..3 ----------------------------------------------------------------------------------------------------

  async function listChats(query = {}) {
    const { page, pageSize } = pagingOf(query);
    return await knownChats().list({
      kind: query.kind,
      q: query.q,
      page,
      pageSize,
      selectable: query.selectable === "1",
    });
  }

  async function listDisabledChats() {
    const { BannedChat, KnownChat, Group } = models();
    const [rows, chats, groups] = await Promise.all([
      BannedChat.findAll({ order: [["createdAt", "DESC"]], raw: true }),
      KnownChat.findAll({ attributes: ["jid", "name"], raw: true }),
      Group.findAll({ attributes: ["jid", "name"], raw: true }),
    ]);
    const names = new Map();
    for (const group of groups) if (group.name) names.set(group.jid, group.name);
    for (const chat of chats) if (chat.name) names.set(chat.jid, chat.name);
    return {
      items: rows.map((row) => ({
        jid: row.jid,
        kind: row.jid.endsWith("@g.us") ? "group" : "private",
        name: names.get(row.jid) || null,
        since: iso(row.createdAt),
      })),
    };
  }

  async function enableChat(jid) {
    const { BannedChat } = models();
    const removed = await BannedChat.destroy({ where: { jid } });
    invalidateBanned();
    if (!removed) throw new AdminError("not_found", { params: { resource: "chat" } });
    return { enabled: true };
  }

  // ---- Lifecycle ------------------------------------------------------------------------------------------------------

  /** Follow the group fetches of the hook plugin (member counts and admin flags for free). Idempotent. */
  function start() {
    if (unsubscribe) return;
    try {
      unsubscribe = plugin("knownchats").subscribeGroups((groups, at) => ingest(groups, at));
    } catch (err) {
      logger.warn({ err: err?.message }, "groups: could not follow the group fetches");
    }
  }

  function stop() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    metadataCache.clear();
  }

  return {
    list,
    refresh,
    describe,
    update,
    preview,
    deleteSettings,
    listFilters,
    addFilter,
    editFilter,
    deleteFilter,
    members,
    listRoles,
    setRole,
    listWarnings,
    resetWarnings,
    resetAllWarnings,
    toggleCommands,
    setGuard,
    setMute,
    listChats,
    listDisabledChats,
    enableChat,
    start,
    stop,
    // exposed for the tests
    _snapshot: () => snapshot,
  };
}

/**
 * The one instance shared by the three route modules (groups.js, guard.js, chats.js): created on first use and kept
 * on `deps.groupsService`, which a test may fill with a fake before the routes run.
 */
function groupsServiceOf(deps) {
  if (!deps.groupsService) {
    deps.groupsService = createGroupsService({
      models: deps.models,
      getClient: () => deps.client,
      now: () => deps.clock.now(),
      logger: deps.logger,
      registry: deps.registry,
      commandState: deps.commandState,
    });
  }
  return deps.groupsService;
}

module.exports = { createGroupsService, groupsServiceOf, findUnknownVariables, VARIABLES, ROLES };
