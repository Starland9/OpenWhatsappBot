"use strict";

/**
 * Recurrence rules of the recurring broadcasts (specs/002-admin-panel: contracts/runtime.md section 9
 * "Recurrence", data-model 2.5, research C5 and U12).
 *
 * Pure: no clock, no database, nothing read from `config`. The zone is an argument.
 *
 *   validateRule(rule)                 -> { ok: true } | { ok: false, code }
 *                                         codes: bad_kind, bad_days, bad_day, bad_time (checked in that order)
 *   normalizeRule(rule)                -> a FRESH { kind, days?, day?, time } (days sorted and unique), or null
 *   nextOccurrence(rule, afterMs, zone) -> ms of the first occurrence STRICTLY after `afterMs`, or null
 *   describe(rule, lang)               -> "Every day at 08:00" (empty string for an invalid rule)
 *
 * Rule: { kind: "daily" }, { kind: "weekly", days: [1..7] } (ISO weekdays, Monday = 1) or
 * { kind: "monthly", day: 1..31 }, plus `time: "HH:mm"` in the zone.
 *
 * Algorithm: walk the LOCAL calendar days from the day of `afterMs` (at most 400 steps), keep a day when the
 * rule matches, build the instant with luxon in the zone. One local day therefore yields at most one instant:
 *  - a time inside a spring-forward gap resolves forward and still fires once that day
 *    (Paris 02:30 on 2026-03-29 gives 03:30+02:00; Cairo 00:30 on 2026-04-24 gives 01:30+03:00);
 *  - a fall-back overlap picks one instant (Paris 02:30 on 2026-10-25), never two;
 *  - a monthly day absent from the month fires on the LAST day of that month (U12: the 31st gives
 *    02-28, 03-31, 04-30...);
 *  - a rule evaluated exactly at one of its occurrences returns the next one.
 * An invalid zone falls back to UTC.
 */

const { DateTime, Info } = require("luxon");

const MAX_STEPS = 400;
const KINDS = Object.freeze(["daily", "weekly", "monthly"]);
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The zone when it is a valid IANA name, "UTC" otherwise */
function resolveZone(zone) {
  return typeof zone === "string" && zone && Info.isValidIANAZone(zone) ? zone : "UTC";
}

const isIsoDay = (value) => Number.isInteger(value) && value >= 1 && value <= 7;

/**
 * @param {unknown} rule
 * @returns {{ ok: true } | { ok: false, code: "bad_kind"|"bad_days"|"bad_day"|"bad_time" }}
 */
function validateRule(rule) {
  if (!rule || typeof rule !== "object" || !KINDS.includes(rule.kind)) return { ok: false, code: "bad_kind" };
  if (rule.kind === "weekly") {
    if (!Array.isArray(rule.days) || rule.days.length === 0 || rule.days.length > 7 || !rule.days.every(isIsoDay)) {
      return { ok: false, code: "bad_days" };
    }
  }
  if (rule.kind === "monthly") {
    if (!Number.isInteger(rule.day) || rule.day < 1 || rule.day > 31) return { ok: false, code: "bad_day" };
  }
  if (typeof rule.time !== "string" || !TIME.test(rule.time)) return { ok: false, code: "bad_time" };
  return { ok: true };
}

/** A fresh, canonical copy of a valid rule (days sorted and de-duplicated), or null when it is invalid */
function normalizeRule(rule) {
  if (!validateRule(rule).ok) return null;
  if (rule.kind === "weekly") return { kind: "weekly", days: [...new Set(rule.days)].sort((a, b) => a - b), time: rule.time };
  if (rule.kind === "monthly") return { kind: "monthly", day: rule.day, time: rule.time };
  return { kind: "daily", time: rule.time };
}

/**
 * First occurrence strictly after `afterMs`.
 * @param {object} rule
 * @param {number|Date} afterMs
 * @param {string} [zone] IANA zone, UTC when missing or invalid
 * @returns {number|null} epoch ms, or null for an invalid rule (or when nothing is found in 400 days)
 */
function nextOccurrence(rule, afterMs, zone) {
  if (!validateRule(rule).ok) return null;
  const after = Number(afterMs);
  if (!Number.isFinite(after)) return null;
  const tz = resolveZone(zone);
  const [hour, minute] = rule.time.split(":").map(Number);
  const weekdays = rule.kind === "weekly" ? new Set(rule.days) : null;

  // The calendar is walked in UTC so that a day without midnight (Cairo, Sao Paulo) cannot shift it
  const start = DateTime.fromMillis(after, { zone: tz });
  let day = DateTime.utc(start.year, start.month, start.day);

  for (let step = 0; step < MAX_STEPS; step += 1, day = day.plus({ days: 1 })) {
    if (weekdays && !weekdays.has(day.weekday)) continue;
    if (rule.kind === "monthly" && day.day !== Math.min(rule.day, day.daysInMonth)) continue;
    const at = DateTime.fromObject({ year: day.year, month: day.month, day: day.day, hour, minute }, { zone: tz });
    if (!at.isValid) continue;
    const ms = at.toMillis();
    if (ms > after) return ms;
  }
  return null;
}

/** Translation of a bot text for one language, English as the fallback; undefined when no text exists */
function text(lang, key, ...args) {
  const { languageManager } = require("./language");
  const raw = languageManager.getEffective(lang, key) ?? languageManager.getEffective("en", key);
  return typeof raw === "string" ? languageManager.replacePlaceholders(raw, args) : undefined;
}

/**
 * A readable sentence for a rule ("Every Monday and Wednesday at 08:00").
 * @param {object} rule
 * @param {string} [lang="en"] "en" or "fr" (any other language is described in English)
 * @returns {string} "" for an invalid rule
 */
function describe(rule, lang = "en") {
  const clean = normalizeRule(rule);
  if (!clean) return "";
  const locale = lang === "fr" ? "fr" : "en";

  if (clean.kind === "daily") {
    return text(locale, "broadcasts.rule_daily", clean.time) ?? `daily ${clean.time}`;
  }
  if (clean.kind === "weekly") {
    // 2024-01-01 is a Monday: day n of that week is ISO weekday n
    const names = clean.days.map((n) => DateTime.utc(2024, 1, n).setLocale(locale).toFormat("cccc"));
    const list = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
    return text(locale, "broadcasts.rule_weekly", list, clean.time) ?? `weekly ${clean.days.join(",")} ${clean.time}`;
  }
  const key = clean.day >= 29 ? "broadcasts.rule_monthly_last" : "broadcasts.rule_monthly";
  return text(locale, key, clean.day, clean.time) ?? `monthly ${clean.day} ${clean.time}`;
}

module.exports = { validateRule, normalizeRule, nextOccurrence, describe, resolveZone, MAX_STEPS, KINDS };
