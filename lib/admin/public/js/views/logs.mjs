import { html, useState, useEffect, useLive, Field, DataTable, EmptyState, Spinner, StatusBadge } from "../components/index.mjs";
import { t, tError, formatDateTime, formatNumber } from "../i18n.mjs";
import { api } from "../api.mjs";
import { live } from "../live.mjs";
import {
  LEVELS,
  MAX_ENTRIES,
  MAX_QUERY_LENGTH,
  PAGE_SIZE,
  appendEntries,
  buildLogsQuery,
  filterEntries,
  levelTone,
  messageLines,
  newestFirst,
  paginate,
  splitPaused,
} from "./logs-logic.mjs";

export const meta = { area: "logs", titleKey: "logs.title", icon: "logs" };

const LEVEL_OPTIONS = [{ value: "", label: "logs.level_all" }, ...LEVELS.filter((level) => level !== "trace").map((level) => ({ value: level, label: `logs.level_${level}` }))];

/**
 * US7: the last 1000 log entries, filtered by level (a minimum, as on the server) and by text, kept up to date by the
 * live stream (`logs=1`, replayed from the last sequence held after a reconnection) or by polling, with pause and
 * resume. Values are scrubbed on the server; a secret never reaches this view.
 */
export default function LogsView() {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [level, setLevel] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pausedAt, setPausedAt] = useState(null);

  // The initial list, then the live stream from the newest sequence held (nothing is missed, nothing repeats).
  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    api("GET", "/admin/api/logs", buildLogsQuery({ limit: MAX_ENTRIES }))
      .then((data) => {
        if (cancelled) return;
        setEntries(Array.isArray(data.entries) ? data.entries : []);
        live.setLogs(true, data.lastSeq);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
      live.setLogs(false);
    };
  }, [attempt]);

  useLive("log", (entry) => {
    setEntries((current) => (current === null ? current : appendEntries(current, entry)));
  });

  if (error) {
    return html`<section class="view">
      <div class="view-header"><h1>${t("logs.title")}</h1></div>
      <${EmptyState} icon="error" title=${tError(error)}>
        <button type="button" class="btn" onClick=${() => setAttempt((n) => n + 1)}>${t("common.retry")}</button>
      <//>
    </section>`;
  }
  if (entries === null) {
    return html`<section class="view">
      <div class="view-header"><h1>${t("logs.title")}</h1></div>
      <${Spinner} />
    </section>`;
  }

  const { shown, pending } = splitPaused(entries, pausedAt);
  const matching = newestFirst(filterEntries(shown, { level, q }));
  const view = paginate(matching, page, PAGE_SIZE);
  const paused = pausedAt !== null;

  const columns = [
    { key: "ts", label: t("logs.col_time"), render: (row) => html`<span class="nowrap">${formatDateTime(row.ts, { dateStyle: "short", timeStyle: "medium" })}</span>` },
    { key: "level", label: t("logs.col_level"), render: (row) => html`<${StatusBadge} tone=${levelTone(row.level)} label=${row.level} />` },
    { key: "name", label: t("logs.col_source"), render: (row) => (row.name ? html`<span class="mono">${row.name}</span>` : "") },
    { key: "msg", label: t("logs.col_message"), render: (row) => html`<div class="mono log-msg">${messageLines(row.msg).map((line, index) => html`<div key=${index}>${line || "\u00a0"}</div>`)}</div>` },
  ];

  return html`<section class="view stack">
    <div class="view-header">
      <h1>${t("logs.title")}</h1>
      <div class="actions">
        <button type="button" class="btn btn-sm" onClick=${() => setPausedAt(paused ? null : entries.length ? entries[entries.length - 1].seq : 0)} aria-pressed=${paused ? "true" : "false"}>
          ${paused ? t("logs.resume") : t("logs.pause")}
        </button>
      </div>
    </div>

    <section class="card">
      <div class="grid">
        <${Field}
          label=${t("logs.filter_level")}
          name="level"
          type="enum"
          value=${level}
          onChange=${(value) => {
            setLevel(value);
            setPage(1);
          }}
          options=${LEVEL_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) }))}
          hint=${t("logs.filter_level_hint")}
        />
        <${Field}
          label=${t("logs.filter_text")}
          name="q"
          value=${q}
          maxLength=${MAX_QUERY_LENGTH}
          placeholder=${t("logs.filter_text_placeholder")}
          onChange=${(value) => {
            setQ(value);
            setPage(1);
          }}
        />
      </div>
      <p class="muted" role="status">
        ${paused ? html`${t("logs.paused")} ` : null}${pending ? t("logs.pending", { count: pending }) : ""}
        ${t("logs.summary", { shown: formatNumber(matching.length), held: formatNumber(shown.length) })}
      </p>
    </section>

    <${DataTable}
      columns=${columns}
      rows=${view.items}
      rowKey="seq"
      caption=${t("logs.title")}
      empty=${html`<${EmptyState} icon="info" title=${entries.length ? t("logs.no_match") : t("logs.empty")} />`}
      pagination=${{ page: view.page, pageSize: PAGE_SIZE, total: view.total, onPage: setPage }}
    />
  </section>`;
}
