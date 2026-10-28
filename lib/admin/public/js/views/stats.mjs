import { html, useEffect, useAsync, EmptyState, Spinner, Icon } from "../components/index.mjs";
import { t, tError, formatNumber } from "../i18n.mjs";
import { api } from "../api.mjs";
import { chartModel, chartSummary, groupLabel, isEmptyStats, rankedRows } from "./stats-logic.mjs";

export const meta = { area: "stats", titleKey: "stats.title", icon: "stats" };

const REFRESH_MS = 30 * 1000; // the counters are written every 30 s

/** The 7-day bars as SVG: no script-drawn canvas, no inline style, colours from the theme tokens. */
function MessagesChart({ days }) {
  const model = chartModel(days);
  const { width, height } = model.viewBox;
  return html`<svg
    class="chart"
    viewBox=${`0 0 ${width} ${height}`}
    width=${width * 2}
    role="img"
    aria-label=${t("stats.chart_label", { summary: chartSummary(days) })}
  >
    <line x1="0" x2=${width} y1=${model.baseline} y2=${model.baseline} stroke="var(--border)" stroke-width="1"></line>
    ${model.bars.map(
      (bar) => html`<g key=${bar.day}>
        <rect x=${bar.x} y=${bar.y} width=${bar.width} height=${bar.height} rx="3" fill="var(--primary)">
          <title>${`${bar.day}: ${formatNumber(bar.messages)}`}</title>
        </rect>
        ${
          bar.messages > 0
            ? html`<text x=${bar.labelX} y=${bar.y - 4} text-anchor="middle" font-size="11" fill="var(--text)">${formatNumber(bar.messages)}</text>`
            : null
        }
        <text x=${bar.labelX} y=${bar.labelY} text-anchor="middle" font-size="11" fill="var(--muted)">${bar.label}</text>
      </g>`,
    )}
  </svg>`;
}

/** A ranked list: the label, the count, and a proportional bar (`<progress>`, so it needs no inline style). */
function RankedList({ rows, nameOf, emptyText }) {
  const items = rankedRows(rows, nameOf);
  if (!items.length) return html`<p class="muted">${emptyText}</p>`;
  return html`<ol class="bar-list">
    ${items.map(
      (item) => html`<li key=${item.key}>
        <div class="row">
          <span class="grow mono">${item.name}</span>
          <strong>${formatNumber(item.count)}</strong>
        </div>
        <progress max="1" value=${item.ratio} aria-label=${item.name}></progress>
      </li>`,
    )}
  </ol>`;
}

/** US7 (FR-035): messages per day over 7 days, the 10 most used commands, the failing commands, the busiest groups. */
export default function StatsView() {
  const { data, error, loading, reload } = useAsync(() => api("GET", "/admin/api/stats"), []);
  useEffect(() => {
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const header = html`<div class="view-header">
    <h1>${t("stats.title")}</h1>
    <button type="button" class="btn btn-sm" disabled=${loading} onClick=${reload}><${Icon} name="refresh" />${t("common.refresh")}</button>
  </div>`;

  if (!data) {
    if (error) {
      return html`<section class="view">${header}<${EmptyState} icon="error" title=${tError(error)}>
        <button type="button" class="btn" onClick=${reload}>${t("common.retry")}</button>
      <//></section>`;
    }
    return html`<section class="view">${header}<${Spinner} /></section>`;
  }

  return html`<section class="view stack">
    ${header}
    ${error ? html`<p class="banner banner-warn" role="alert">${tError(error)}</p>` : null}
    ${isEmptyStats(data) ? html`<p class="muted">${t("stats.nothing_yet")}</p>` : null}
    <section class="card">
      <h2 class="card-title">${t("stats.messages_per_day")}</h2>
      <${MessagesChart} days=${data.days} />
      <p class="muted">${t("stats.timezone", { zone: data.timezone })}</p>
    </section>
    <div class="grid">
      <div>
        <section class="card">
          <h2 class="card-title">${t("stats.top_commands")}</h2>
          <${RankedList} rows=${data.topCommands} emptyText=${t("stats.no_commands")} />
        </section>
      </div>
      <div>
        <section class="card">
          <h2 class="card-title">${t("stats.failed_commands")}</h2>
          <${RankedList} rows=${data.failedCommands} emptyText=${t("stats.no_failures")} />
        </section>
      </div>
    </div>
    <section class="card">
      <h2 class="card-title">${t("stats.top_groups")}</h2>
      <${RankedList} rows=${data.topGroups} nameOf=${groupLabel} emptyText=${t("stats.no_groups")} />
    </section>
  </section>`;
}
