// Pure logic of the statistics view (US7, FR-035): the 7-day bar chart (SVG geometry), the ranked lists and the
// labels. No DOM, no network, no timer, so node:test can import it. The numbers come from STAT-1.

export const CHART = Object.freeze({ slot: 44, barWidth: 30, height: 140, top: 18, bottom: 22 });

/**
 * Geometry of the 7-day chart: one bar per day, scaled to the busiest day (a day with messages is at least 2 units
 * tall so it stays visible, an empty day has no bar). `viewBox` is the SVG box; every number is an integer.
 *   { max, total, viewBox: { width, height }, baseline: y, bars: [{ day, label, messages, x, y, width, height, labelX, labelY }] }
 */
export function chartModel(days, chart = CHART) {
  const list = (Array.isArray(days) ? days : []).map((entry) => ({
    day: entry && typeof entry.day === "string" ? entry.day : "",
    messages: Math.max(0, Math.trunc(Number(entry && entry.messages) || 0)),
  }));
  const max = list.reduce((best, entry) => Math.max(best, entry.messages), 0);
  const total = list.reduce((sum, entry) => sum + entry.messages, 0);
  const drawable = chart.height - chart.top - chart.bottom;
  const baseline = chart.height - chart.bottom;
  const bars = list.map((entry, index) => {
    const height = max === 0 || entry.messages === 0 ? 0 : Math.max(2, Math.round((entry.messages / max) * drawable));
    const x = index * chart.slot + Math.round((chart.slot - chart.barWidth) / 2);
    return {
      day: entry.day,
      label: shortDay(entry.day),
      messages: entry.messages,
      x,
      y: baseline - height,
      width: chart.barWidth,
      height,
      labelX: index * chart.slot + Math.round(chart.slot / 2),
      labelY: chart.height - 6,
    };
  });
  return { max, total, viewBox: { width: list.length * chart.slot, height: chart.height }, baseline, bars };
}

/** `2026-03-11` -> `03-11` (the year is the same all week; an unexpected value is returned as it is). */
export function shortDay(day) {
  const match = /^\d{4}-(\d{2}-\d{2})$/.exec(String(day));
  return match ? match[1] : String(day);
}

/**
 * A ranked list for `<progress>` bars: `[{ key, name, count, ratio }]` with `ratio` against the first (largest)
 * count, 0 to 1. `nameOf(row)` gives the label (default `row.name`). Rubbish rows are skipped.
 */
export function rankedRows(rows, nameOf = (row) => row.name) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === "object" && Number(row.count) > 0);
  const top = list.reduce((best, row) => Math.max(best, Number(row.count)), 0);
  return list.map((row, index) => ({
    key: row.jid || row.name || index,
    name: String(nameOf(row) ?? ""),
    count: Number(row.count),
    ratio: top > 0 ? Number(row.count) / top : 0,
  }));
}

/** A group is named after its subject; an unknown name falls back to the JID (the number part, never empty). */
export function groupLabel(row) {
  if (row && typeof row.name === "string" && row.name !== "") return row.name;
  const jid = row && typeof row.jid === "string" ? row.jid : "";
  return jid || "?";
}

/** True when nothing at all was counted in the window (the view shows one hint instead of empty lists). */
export function isEmptyStats(stats) {
  if (!stats || typeof stats !== "object") return true;
  const days = Array.isArray(stats.days) ? stats.days : [];
  return (
    days.every((d) => !Number(d && d.messages)) &&
    !(stats.topCommands || []).length &&
    !(stats.failedCommands || []).length &&
    !(stats.topGroups || []).length
  );
}

/** The accessible description of the chart: "03-05: 12, 03-06: 0, ..." (read by screen readers). */
export function chartSummary(days) {
  return (Array.isArray(days) ? days : []).map((entry) => `${shortDay(entry.day)}: ${Math.max(0, Math.trunc(Number(entry.messages) || 0))}`).join(", ");
}
