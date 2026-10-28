"use strict";

/**
 * Statistics page (US7, FR-035; admin-http-api.md 2.16 "STAT-1"):
 *
 *   const service = createStatsService(deps);
 *   await service.get() ->
 *     { timezone, days: [{ day, messages }] (7, zero-filled, oldest first),
 *       topCommands: [{ name, count }] (10, cmd_ok), failedCommands: [{ name, count }] (cmd_fail, at most 50),
 *       topGroups: [{ jid, name, count }] (10, name null when unknown) }
 *
 * The numbers come from lib/utils/stats.js (counters flushed to `daily_stats`); the window is today and the six
 * previous local days of the bot's TIMEZONE (an invalid zone reads as UTC, like the counters themselves). The
 * pending counters are flushed first, so a command that has just failed is already there. A command that always
 * fails is only in `failedCommands` (it never succeeded): the lists are not derived from each other.
 *
 * Group names: `deps.groupNames(jids) -> Map | object` (the groups snapshot of the groups area, optional), then the
 * `known_chats` table (names kept by plugins/knownchats.js); a jid that nothing names has `name: null`. A failing
 * name source costs the names, never the page.
 *
 * DEPS (all optional, looked up when used): stats (the engine), models (database), config, clock, groupNames, logger.
 */

const { DateTime, Info } = require("luxon");

const WINDOW_DAYS = 7;
const TOP = 10;
const FAILED_SHOWN = 50;

function createStatsService(deps = {}) {
  const now = () => (deps.clock && typeof deps.clock.now === "function" ? deps.clock.now() : Date.now());
  const getEngine = () => deps.stats || require("../../utils/stats");

  /** The configured IANA zone, or UTC (same rule as the counters). */
  function zoneOf() {
    const configured = deps.config && deps.config.TIMEZONE !== undefined ? deps.config.TIMEZONE : require("../../../config").TIMEZONE;
    const zone = typeof configured === "string" && configured ? configured : "UTC";
    return Info.isValidIANAZone(zone) ? zone : "UTC";
  }

  /** Local dates of the window, oldest first. */
  function windowDays(at, zone) {
    const end = DateTime.fromMillis(at, { zone }).startOf("day");
    const out = [];
    for (let back = WINDOW_DAYS - 1; back >= 0; back -= 1) out.push(end.minus({ days: back }).toFormat("yyyy-MM-dd"));
    return out;
  }

  /** jid -> name from the injected source, then from the chats table. */
  async function namesOf(jids) {
    const names = new Map();
    if (!jids.length) return names;
    if (typeof deps.groupNames === "function") {
      try {
        const found = await deps.groupNames(jids);
        const entries = found instanceof Map ? found.entries() : Object.entries(found || {});
        for (const [jid, name] of entries) if (typeof name === "string" && name) names.set(jid, name);
      } catch {
        // the names are a convenience
      }
    }
    const missing = jids.filter((jid) => !names.has(jid));
    const models = deps.models || (missing.length ? safeModels() : null);
    if (missing.length && models && models.KnownChat) {
      try {
        const rows = await models.KnownChat.findAll({ where: { jid: missing }, attributes: ["jid", "name"], raw: true });
        for (const row of rows) if (row.name) names.set(row.jid, String(row.name));
      } catch {
        // idem
      }
    }
    return names;
  }

  function safeModels() {
    try {
      return require("../../database");
    } catch {
      return null;
    }
  }

  return {
    async get() {
      const engine = getEngine();
      const at = now();
      const zone = zoneOf();
      try {
        await engine.flush();
      } catch {
        // an unflushed counter only delays the figure by a few seconds
      }
      const options = { now: at };
      const [byDay, commands, failing, groups] = await Promise.all([
        engine.messagesByDay(WINDOW_DAYS, options),
        engine.topCommands(TOP, WINDOW_DAYS, options),
        engine.failingCommands(WINDOW_DAYS, options),
        engine.topGroups(TOP, WINDOW_DAYS, options),
      ]);

      const messages = new Map((byDay || []).map((row) => [row.day, Number(row.messages) || 0]));
      const names = await namesOf((groups || []).map((row) => row.jid));
      return {
        timezone: zone,
        days: windowDays(at, zone).map((day) => ({ day, messages: messages.get(day) || 0 })),
        topCommands: (commands || []).slice(0, TOP).map((row) => ({ name: row.name, count: row.count })),
        failedCommands: (failing || []).slice(0, FAILED_SHOWN).map((row) => ({ name: row.name, count: row.count })),
        topGroups: (groups || []).slice(0, TOP).map((row) => ({ jid: row.jid, name: names.get(row.jid) || null, count: row.count })),
      };
    },
  };
}

module.exports = { createStatsService, WINDOW_DAYS };
