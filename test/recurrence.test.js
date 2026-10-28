"use strict";
/**
 * lib/utils/recurrence.js (specs/002-admin-panel T158, contracts/runtime.md section 9, data-model 2.5, research C5).
 *
 * Pure: no clock and no database. Every instant is written as an ISO string with its offset, so the expected
 * values read like the spec. Covered: validateRule codes, daily / weekly (ISO, Monday = 1) / monthly rules,
 * "le 31" on the last day of shorter months (U12), DST (Paris, Cairo, a fall-back overlap), the strict
 * "after" rule, the invalid-zone fallback, the 400-step bound and describe().
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { DateTime } = require("luxon");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const recurrence = require("../lib/utils/recurrence");

const PARIS = "Europe/Paris";
const CAIRO = "Africa/Cairo";

const ms = (iso, zone = "UTC") => DateTime.fromISO(iso, { zone }).toMillis();
/** The instant as `YYYY-MM-DDTHH:mm±hh:mm` in the zone */
const show = (value, zone = "UTC") => DateTime.fromMillis(value, { zone }).toISO({ suppressMilliseconds: true });

const daily = (time = "08:00") => ({ kind: "daily", time });
const weekly = (days, time = "08:00") => ({ kind: "weekly", days, time });
const monthly = (day, time = "08:00") => ({ kind: "monthly", day, time });

/** The first n occurrences after `from` */
function walk(rule, from, zone, n) {
  const out = [];
  let cursor = ms(from, zone);
  for (let i = 0; i < n; i += 1) {
    cursor = recurrence.nextOccurrence(rule, cursor, zone);
    out.push(show(cursor, zone));
  }
  return out;
}

describe("validateRule", () => {
  test("accepts the three shapes", () => {
    assert.deepEqual(recurrence.validateRule(daily()), { ok: true });
    assert.deepEqual(recurrence.validateRule(weekly([1, 3, 5])), { ok: true });
    assert.deepEqual(recurrence.validateRule(monthly(31, "23:59")), { ok: true });
    assert.deepEqual(recurrence.validateRule(daily("00:00")), { ok: true });
  });

  test("bad_kind", () => {
    for (const rule of [null, undefined, "daily", 5, [], {}, { kind: "yearly", time: "08:00" }, { kind: "DAILY", time: "08:00" }]) {
      assert.deepEqual(recurrence.validateRule(rule), { ok: false, code: "bad_kind" }, JSON.stringify(rule));
    }
  });

  test("bad_days: weekly needs a non-empty list of ISO weekdays 1..7", () => {
    for (const days of [undefined, null, [], "1", [0], [8], [1.5], ["1"], [1, 2, 3, 4, 5, 6, 7, 1], [-1]]) {
      assert.deepEqual(recurrence.validateRule(weekly(days)), { ok: false, code: "bad_days" }, JSON.stringify(days));
    }
    assert.deepEqual(recurrence.validateRule(weekly([1, 2, 3, 4, 5, 6, 7])), { ok: true });
  });

  test("bad_day: monthly needs an integer 1..31", () => {
    for (const day of [undefined, null, 0, 32, -1, 1.5, "15", NaN]) {
      assert.deepEqual(recurrence.validateRule(monthly(day)), { ok: false, code: "bad_day" }, String(day));
    }
    assert.deepEqual(recurrence.validateRule(monthly(1)), { ok: true });
  });

  test("bad_time: HH:mm from 00:00 to 23:59", () => {
    for (const time of [undefined, null, "", "8:00", "08:0", "24:00", "23:60", "08-00", "08:00:00", 800, " 08:00"]) {
      assert.deepEqual(recurrence.validateRule({ kind: "daily", time }), { ok: false, code: "bad_time" }, String(time));
    }
  });

  test("the kind is checked first, then days or day, then the time", () => {
    assert.equal(recurrence.validateRule({ kind: "weekly", days: [9], time: "99:99" }).code, "bad_days");
    assert.equal(recurrence.validateRule({ kind: "monthly", day: 40, time: "99:99" }).code, "bad_day");
    assert.equal(recurrence.validateRule({ kind: "nope", days: [9], time: "99:99" }).code, "bad_kind");
  });

  test("normalizeRule returns a fresh canonical copy, or null", () => {
    const input = { kind: "weekly", days: [5, 1, 5, 3], time: "08:00", extra: "x" };
    const clean = recurrence.normalizeRule(input);
    assert.deepEqual(clean, { kind: "weekly", days: [1, 3, 5], time: "08:00" });
    assert.notEqual(clean, input);
    assert.deepEqual(input.days, [5, 1, 5, 3], "the input is not modified");
    assert.equal(recurrence.normalizeRule({ kind: "daily", time: "nope" }), null);
  });
});

describe("daily", () => {
  test("fires every local day, the same wall-clock time", () => {
    assert.deepEqual(walk(daily("08:00"), "2026-11-02T00:00:00", "UTC", 3), [
      "2026-11-02T08:00:00.000Z".replace(".000", ""),
      "2026-11-03T08:00:00Z",
      "2026-11-04T08:00:00Z",
    ]);
  });

  test("the occurrence of the day is skipped when it has already passed", () => {
    assert.equal(show(recurrence.nextOccurrence(daily("08:00"), ms("2026-11-02T08:00:01"), "UTC")), "2026-11-03T08:00:00Z");
    assert.equal(show(recurrence.nextOccurrence(daily("08:00"), ms("2026-11-02T07:59:59"), "UTC")), "2026-11-02T08:00:00Z");
  });

  test("the zone decides the local day", () => {
    // 23:30 UTC on Nov 2 is already Nov 3 in Douala (UTC+1)
    const after = ms("2026-11-02T23:30:00");
    assert.equal(show(recurrence.nextOccurrence(daily("08:00"), after, "Africa/Douala"), "Africa/Douala"), "2026-11-03T08:00:00+01:00");
  });
});

describe("weekly (ISO weekdays, Monday = 1)", () => {
  // 2026-11-02 is a Monday
  test("Monday and Wednesday step 11-02, 11-04, 11-09, 11-11", () => {
    assert.deepEqual(walk(weekly([1, 3]), "2026-11-01T00:00:00", "UTC", 4), [
      "2026-11-02T08:00:00Z",
      "2026-11-04T08:00:00Z",
      "2026-11-09T08:00:00Z",
      "2026-11-11T08:00:00Z",
    ]);
  });

  test("Sunday is 7, Monday is 1", () => {
    assert.equal(show(recurrence.nextOccurrence(weekly([7]), ms("2026-11-02T00:00:00"), "UTC")), "2026-11-08T08:00:00Z");
    assert.equal(show(recurrence.nextOccurrence(weekly([1]), ms("2026-11-03T00:00:00"), "UTC")), "2026-11-09T08:00:00Z");
  });

  test("the order and duplicates of the days do not matter", () => {
    const a = recurrence.nextOccurrence(weekly([5, 1, 5]), ms("2026-11-02T09:00:00"), "UTC");
    const b = recurrence.nextOccurrence(weekly([1, 5]), ms("2026-11-02T09:00:00"), "UTC");
    assert.equal(a, b);
    assert.equal(show(a), "2026-11-06T08:00:00Z");
  });

  test("a single day is found within a week", () => {
    assert.equal(show(recurrence.nextOccurrence(weekly([2]), ms("2026-11-03T08:00:00"), "UTC")), "2026-11-10T08:00:00Z");
  });
});

describe("monthly", () => {
  test("the 15th", () => {
    assert.deepEqual(walk(monthly(15), "2026-01-01T00:00:00", "UTC", 3), ["2026-01-15T08:00:00Z", "2026-02-15T08:00:00Z", "2026-03-15T08:00:00Z"]);
  });

  test("U12: le 31 fires on the last day of shorter months (02-28, 03-31, 04-30, 05-31)", () => {
    assert.deepEqual(walk(monthly(31), "2026-02-01T00:00:00", "UTC", 4), [
      "2026-02-28T08:00:00Z",
      "2026-03-31T08:00:00Z",
      "2026-04-30T08:00:00Z",
      "2026-05-31T08:00:00Z",
    ]);
  });

  test("le 31 gives 02-29 in a leap year; le 30 gives 02-28 / 02-29; le 29 gives 02-28 in a common year", () => {
    assert.equal(show(recurrence.nextOccurrence(monthly(31), ms("2028-02-01T00:00:00"), "UTC")), "2028-02-29T08:00:00Z");
    assert.equal(show(recurrence.nextOccurrence(monthly(30), ms("2026-02-01T00:00:00"), "UTC")), "2026-02-28T08:00:00Z");
    assert.equal(show(recurrence.nextOccurrence(monthly(30), ms("2028-02-01T00:00:00"), "UTC")), "2028-02-29T08:00:00Z");
    assert.equal(show(recurrence.nextOccurrence(monthly(29), ms("2026-02-01T00:00:00"), "UTC")), "2026-02-28T08:00:00Z");
  });

  test("the 1st fires once a month, also across a year end", () => {
    assert.deepEqual(walk(monthly(1), "2026-11-15T00:00:00", "UTC", 3), ["2026-12-01T08:00:00Z", "2027-01-01T08:00:00Z", "2027-02-01T08:00:00Z"]);
  });

  test("a month day that already passed moves to the next month", () => {
    assert.equal(show(recurrence.nextOccurrence(monthly(10), ms("2026-11-10T08:00:00"), "UTC")), "2026-12-10T08:00:00Z");
  });
});

describe("DST", () => {
  test("Paris 02:30 on 2026-03-29 (spring forward) resolves forward to 03:30+02:00, once", () => {
    const rule = daily("02:30");
    const days = walk(rule, "2026-03-27T12:00:00", PARIS, 4);
    assert.deepEqual(days, [
      "2026-03-28T02:30:00+01:00",
      "2026-03-29T03:30:00+02:00",
      "2026-03-30T02:30:00+02:00",
      "2026-03-31T02:30:00+02:00",
    ]);
  });

  test("Cairo 00:30 on 2026-04-24 (a day without midnight) resolves to 01:30+03:00, once", () => {
    const days = walk(daily("00:30"), "2026-04-22T12:00:00", CAIRO, 4);
    assert.deepEqual(days, [
      "2026-04-23T00:30:00+02:00",
      "2026-04-24T01:30:00+03:00",
      "2026-04-25T00:30:00+03:00",
      "2026-04-26T00:30:00+03:00",
    ]);
  });

  test("Paris 02:30 on 2026-10-25 (fall back overlap) picks ONE instant, never two", () => {
    const days = walk(daily("02:30"), "2026-10-23T12:00:00", PARIS, 4);
    assert.equal(days.filter((d) => d.startsWith("2026-10-25")).length, 1, JSON.stringify(days));
    assert.equal(new Set(days).size, 4);
    // the days around it keep their wall-clock time
    assert.equal(days[0], "2026-10-24T02:30:00+02:00");
    assert.match(days[1], /^2026-10-25T02:30:00\+0[12]:00$/);
    assert.equal(days[2], "2026-10-26T02:30:00+01:00");
    // whichever of the two 02:30 luxon picks, asking again from it gives the next DAY (not the other 02:30)
    const overlap = recurrence.nextOccurrence(daily("02:30"), ms("2026-10-24T12:00:00", PARIS), PARIS);
    assert.match(show(overlap, PARIS), /^2026-10-25T02:30:00\+0[12]:00$/);
    assert.equal(show(recurrence.nextOccurrence(daily("02:30"), overlap, PARIS), PARIS), "2026-10-26T02:30:00+01:00");
  });

  test("a weekly rule keeps its wall-clock time across the change", () => {
    // Paris, Sundays 08:00: 2026-03-22 is +01:00, 2026-03-29 is +02:00
    assert.deepEqual(walk(weekly([7]), "2026-03-20T00:00:00", PARIS, 2), ["2026-03-22T08:00:00+01:00", "2026-03-29T08:00:00+02:00"]);
  });

  test("a time that exists keeps its instant (no drift of 24 h steps)", () => {
    const a = recurrence.nextOccurrence(daily("12:00"), ms("2026-03-28T12:00:00", PARIS), PARIS);
    assert.equal(show(a, PARIS), "2026-03-29T12:00:00+02:00");
    assert.equal(a - ms("2026-03-28T12:00:00", PARIS), 23 * 3600 * 1000);
  });
});

describe("nextOccurrence contract", () => {
  test("strictly after: an evaluation exactly at an occurrence returns the next one", () => {
    const at = ms("2026-11-02T08:00:00");
    assert.equal(show(recurrence.nextOccurrence(daily("08:00"), at, "UTC")), "2026-11-03T08:00:00Z");
    assert.equal(show(recurrence.nextOccurrence(daily("08:00"), at - 1, "UTC")), "2026-11-02T08:00:00Z");
    assert.equal(show(recurrence.nextOccurrence(weekly([1]), at, "UTC")), "2026-11-09T08:00:00Z");
    assert.equal(show(recurrence.nextOccurrence(monthly(2), at, "UTC")), "2026-12-02T08:00:00Z");
  });

  test("an invalid or missing zone falls back to UTC", () => {
    const after = ms("2026-11-02T00:00:00");
    const utc = recurrence.nextOccurrence(daily("08:00"), after, "UTC");
    for (const zone of [undefined, null, "", "Not/AZone", "UTC+3", 42]) {
      assert.equal(recurrence.nextOccurrence(daily("08:00"), after, zone), utc, String(zone));
    }
    assert.equal(recurrence.resolveZone("Europe/Paris"), "Europe/Paris");
    assert.equal(recurrence.resolveZone("Not/AZone"), "UTC");
  });

  test("an invalid rule or instant gives null, never an exception", () => {
    assert.equal(recurrence.nextOccurrence(null, 0, "UTC"), null);
    assert.equal(recurrence.nextOccurrence({ kind: "daily", time: "25:00" }, 0, "UTC"), null);
    assert.equal(recurrence.nextOccurrence(daily(), NaN, "UTC"), null);
    assert.equal(recurrence.nextOccurrence(daily(), "soon", "UTC"), null);
  });

  test("accepts a Date as the starting point", () => {
    const after = new Date(ms("2026-11-02T00:00:00"));
    assert.equal(show(recurrence.nextOccurrence(daily("08:00"), after, "UTC")), "2026-11-02T08:00:00Z");
  });

  test("walks at most 400 calendar days", () => {
    assert.equal(recurrence.MAX_STEPS, 400);
    // every valid rule is found within 400 days (a yearly-ish gap never exists in the three shapes)
    for (const rule of [daily(), weekly([7]), monthly(31)]) {
      const found = recurrence.nextOccurrence(rule, ms("2026-01-01T00:00:00"), "UTC");
      assert.ok(found > ms("2026-01-01T00:00:00"));
      assert.ok(found - ms("2026-01-01T00:00:00") < 400 * 86400 * 1000);
    }
  });

  test("the result always lies in the future by less than the longest gap of the rule", () => {
    const from = ms("2026-06-15T10:00:00", PARIS);
    for (const rule of [daily("09:00"), weekly([2, 4]), monthly(31)]) {
      const next = recurrence.nextOccurrence(rule, from, PARIS);
      assert.ok(next > from);
      assert.ok(next - from <= 32 * 86400 * 1000, `${rule.kind} gap`);
    }
  });
});

describe("describe", () => {
  test("English and French sentences", () => {
    // The fragment keys are not merged into lang/*.json yet: put them in the parsed language files
    const { languageManager } = require("../lib/utils/language");
    for (const lang of ["en", "fr"]) {
      const tree = languageManager.readFile(lang);
      const fragment = require("../specs/002-admin-panel/i18n/bot-broadcasts.json")[lang];
      for (const [key, text] of Object.entries(fragment)) {
        const [area, name] = key.split(".");
        tree[area] = tree[area] || {};
        tree[area][name] = text;
      }
    }
    assert.equal(recurrence.describe(daily("08:00"), "en"), "Every day at 08:00");
    assert.equal(recurrence.describe(daily("08:00"), "fr"), "Tous les jours à 08:00");
    assert.equal(recurrence.describe(weekly([3, 1]), "en"), "Every Monday and Wednesday at 08:00");
    assert.equal(recurrence.describe(weekly([1, 3, 5]), "fr"), "Chaque lundi, mercredi et vendredi à 08:00");
    assert.equal(recurrence.describe(monthly(15, "20:30"), "en"), "On day 15 of every month at 20:30");
    assert.match(recurrence.describe(monthly(31), "en"), /last day of shorter months/);
    assert.match(recurrence.describe(monthly(31), "fr"), /dernier jour des mois plus courts/);
    // any other language is described in English
    assert.equal(recurrence.describe(daily("08:00"), "de"), "Every day at 08:00");
    assert.equal(recurrence.describe({ kind: "daily", time: "bad" }, "en"), "");
  });
});
