"use strict";

/**
 * Per-key quotas of the public messaging API (feature 004, contracts/runtime.md section 15.8, public-api.md 7.1).
 *
 *   createQuotas({ now, messaging, config, models, zone }) -> {
 *     hydrate(key)   -> Promise<void>   rebuild the counters of this key once per process from the stored messages
 *     check(key)     -> Promise<void>   non-consuming: the day, then the minute (the engine's admission ran first)
 *     reserve(key)   -> { release() }   synchronous re-check and push; release on any failure before the submit succeeds
 *     snapshot(key)  -> { limit, remaining, resetSeconds }     `RateLimit-*` of the per-minute window
 *   }
 *
 * State per key, in memory: `minute` = the acceptance times of the last 60 s (sliding), `day` = a counter for the
 * calendar day of the bot's TIMEZONE (a 23 or 25 hour day at a DST change, `retryAfterMs` = time to the next local
 * midnight). Both are hydrated lazily, once per key per process, from the `ApiMessage` rows accepted today (every status
 * counts) and in the last 60 s, so a restart cannot reset either. A new local day resets the counter. A message counts
 * when it is accepted and stays counted whatever becomes of it; a replay, a refused request and a request failing after
 * the reserve do not count (the reservation is released).
 *
 * Limits: `key.limits.x ?? config.API_RATE_PER_MINUTE | API_RATE_PER_DAY`, read at call time (RT-03), so a changed
 * default applies to every key without an override. The pending and global refusals are the engine's (4.5).
 * Refusals: `daily_quota_exceeded { limit, retryAfterMs }`, `rate_limited { scope: "minute", limit, retryAfterMs }`.
 */

const { DateTime, Info } = require("luxon");
const { Op } = require("sequelize");
const { ApiError } = require("./errors");

const MINUTE_MS = 60 * 1000;

function createQuotas(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const getConfig = () => options.config || require("../../config");
  const getModels = () => options.models || require("../database");

  /** The IANA zone to count days in; an invalid name is UTC (as lib/utils/stats.js) */
  function zoneName() {
    const value = typeof options.zone === "function" ? options.zone() : options.zone || getConfig().TIMEZONE || "UTC";
    return Info.isValidIANAZone(value) ? value : "UTC";
  }

  const local = (at) => DateTime.fromMillis(at, { zone: zoneName() });

  /** @type {Map<number, { minute: number[], day: { date: string, count: number }, hydration: Promise<void>|null }>} */
  const states = new Map();

  function stateOf(key) {
    let state = states.get(key.id);
    if (!state) {
      state = { minute: [], day: { date: local(now()).toFormat("yyyy-MM-dd"), count: 0 }, hydration: null };
      states.set(key.id, state);
    }
    return state;
  }

  const limitsOf = (key) => {
    const config = getConfig();
    const own = key.limits || {};
    return {
      perMinute: own.perMinute ?? Number(config.API_RATE_PER_MINUTE),
      perDay: own.perDay ?? Number(config.API_RATE_PER_DAY),
    };
  };

  /** Drop what left the window and roll the day over */
  function refresh(state, at) {
    const cutoff = at - MINUTE_MS;
    while (state.minute.length && state.minute[0] <= cutoff) state.minute.shift();
    const today = local(at).toFormat("yyyy-MM-dd");
    if (state.day.date !== today) state.day = { date: today, count: 0 };
  }

  async function load(key, state) {
    const at = now();
    const startOfDay = local(at).startOf("day").toMillis();
    const { ApiMessage } = getModels();
    const day = await ApiMessage.count({ where: { apiKeyId: key.id, acceptedAt: { [Op.gte]: new Date(startOfDay) } } });
    const recent = await ApiMessage.findAll({
      attributes: ["acceptedAt"],
      where: { apiKeyId: key.id, acceptedAt: { [Op.gt]: new Date(at - MINUTE_MS) } },
      order: [["acceptedAt", "ASC"]],
    });
    // what this process reserved while the rows were being read is already counted in memory: keep the larger view
    state.day = { date: local(at).toFormat("yyyy-MM-dd"), count: Math.max(day, state.day.count) };
    const times = recent.map((row) => new Date(row.acceptedAt).getTime());
    const merged = [...new Set([...times, ...state.minute])].sort((a, b) => a - b);
    state.minute.length = 0;
    state.minute.push(...merged);
  }

  function hydrate(key) {
    const state = stateOf(key);
    if (!state.hydration) {
      state.hydration = load(key, state).catch((err) => {
        state.hydration = null; // try again next time; the in-memory counters keep working meanwhile
        throw err;
      });
    }
    return state.hydration;
  }

  /** Throws the refusal of the first limit exceeded: the day, then the minute */
  function assertRoom(key, state, at) {
    refresh(state, at);
    const { perMinute, perDay } = limitsOf(key);
    if (state.day.count >= perDay) {
      const nextMidnight = local(at).plus({ days: 1 }).startOf("day").toMillis();
      throw new ApiError("daily_quota_exceeded", { params: { limit: perDay, retryAfterMs: Math.max(1, nextMidnight - at) } });
    }
    if (state.minute.length >= perMinute) {
      throw new ApiError("rate_limited", {
        params: { scope: "minute", limit: perMinute, retryAfterMs: Math.max(1, state.minute[0] + MINUTE_MS - at) },
      });
    }
  }

  async function check(key) {
    await hydrate(key);
    assertRoom(key, stateOf(key), now());
  }

  function reserve(key) {
    const state = stateOf(key);
    const at = now();
    assertRoom(key, state, at);
    state.minute.push(at);
    state.day.count += 1;
    const date = state.day.date;
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        const index = state.minute.indexOf(at);
        if (index !== -1) state.minute.splice(index, 1);
        if (state.day.date === date && state.day.count > 0) state.day.count -= 1;
      },
    };
  }

  function snapshot(key) {
    const state = stateOf(key);
    const at = now();
    refresh(state, at);
    const { perMinute } = limitsOf(key);
    return {
      limit: perMinute,
      remaining: Math.max(0, perMinute - state.minute.length),
      resetSeconds: state.minute.length ? Math.max(0, Math.ceil((state.minute[0] + MINUTE_MS - at) / 1000)) : 0,
    };
  }

  return { hydrate, check, reserve, snapshot };
}

module.exports = { createQuotas };
