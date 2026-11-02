// The History tab (feature 004, contracts/panel-ui.md 7.7): filters, the message table, pages. No content column exists
// (a message's text and media are never kept), and no auto-refresh timer: Refresh is manual.
import { html, useState, useAsync, DataTable, EmptyState, Field, Icon, StatusBadge } from "../components/index.mjs";
import { t, tError, tField, formatBytes, formatDateTime } from "../i18n.mjs";
import { api } from "../api.mjs";
import { buildHash } from "../router.mjs";
import { HISTORY_PAGE_SIZE, STATUSES, failureText, historyKey, historyQuery, parseHistoryQuery, recipientCell, sourceCell, statusTone, validateHistoryFilters, visibleKeys } from "./api-logic.mjs";
import { orderedFormats } from "./api-form-logic.mjs";

const base = "/admin/api/api";
const EMPTY = Object.freeze({ key: "", status: "", format: "", from: "", to: "" });

function DayField({ id, label, value, onChange, error }) {
  return html`<div class="field">
    <label class="field-label" for=${id}>${label}</label>
    <input class="input" type="date" id=${id} value=${value} aria-invalid=${error ? "true" : undefined} onInput=${(event) => onChange(event.currentTarget.value)} />
    ${error ? html`<div class="field-error" role="alert">${error === "end_before_start" ? t("api.filter_end_before_start") : tField(error)}</div>` : null}
  </div>`;
}

const hasFilter = (filters) => Boolean(filters.key || filters.status || filters.format || filters.from || filters.to);

/** `HistoryTab({ keys, catalog, state, route })` */
export function HistoryTab({ keys, catalog, state, route }) {
  const initial = parseHistoryQuery(route && route.query);
  const [form, setForm] = useState(initial);
  const [applied, setApplied] = useState(initial);
  const [errors, setErrors] = useState({});
  const [page, setPage] = useState(1);
  const queryKey = historyKey(applied, page);
  const { data, error, loading, reload } = useAsync(() => api("GET", `${base}/messages`, historyQuery(applied, page)), [queryKey]);

  const set = (name) => (value) => setForm((current) => ({ ...current, [name]: value }));
  const apply = (event) => {
    event.preventDefault();
    const check = validateHistoryFilters(form);
    setErrors(check.errors);
    if (!check.ok) return;
    setPage(1);
    setApplied({ ...form });
  };
  const reset = () => {
    setForm({ ...EMPTY });
    setErrors({});
    setPage(1);
    setApplied({ ...EMPTY });
  };

  const formats = orderedFormats(catalog);
  const keyOptions = [
    { value: "", label: t("api.filter_key_all") },
    { value: "panel", label: t("api.filter_key_panel") },
    ...visibleKeys(keys ? keys.items : [], { showRevoked: true }).map((key) => ({ value: String(key.id), label: key.name })),
  ];
  const statusOptions = [{ value: "", label: t("api.filter_status_all") }, ...STATUSES.map((status) => ({ value: status, label: t(`api.msg_status.${status}`) }))];
  const formatOptions = [{ value: "", label: t("api.filter_format_all") }, ...formats.map((format) => ({ value: format.name, label: t(format.labelKey) }))];

  const columns = [
    { key: "when", label: t("api.col_when"), render: (row) => html`<span class="nowrap">${formatDateTime(row.acceptedAt, { dateStyle: "short", timeStyle: "medium" })}</span>` },
    {
      key: "source",
      label: t("api.col_source"),
      render: (row) => {
        const source = sourceCell(row);
        return source.kind === "panel" ? t("api.source_panel") : source.kind === "key" ? source.name : html`<span class="muted">${t("api.source_key_gone")}</span>`;
      },
    },
    {
      key: "recipient",
      label: t("api.col_recipient"),
      render: (row) => {
        const cell = recipientCell(row);
        return html`<div class="stack-sm"><span class="row-wrap">${cell.group ? html`<span class="badge">${t("api.kind_group")}</span>` : null}${cell.name ? html`<span>${cell.name}</span>` : null}<span class="mono">${cell.number}</span></span></div>`;
      },
    },
    {
      key: "format",
      label: t("api.col_format"),
      render: (row) => {
        const format = formats.find((item) => item.name === row.format);
        return format ? t(format.labelKey) : html`<span class="mono">${row.format}</span>`;
      },
    },
    { key: "size", label: t("api.col_size"), render: (row) => (row.size === null || row.size === undefined ? "-" : formatBytes(row.size)) },
    {
      key: "status",
      label: t("api.col_status"),
      render: (row) => html`<div class="stack-sm"><${StatusBadge} tone=${statusTone(row.status)} label=${t(`api.msg_status.${row.status}`)} />${row.kind === "group" && row.status === "sent" ? html`<span class="muted">${t("api.status_group_note")}</span>` : null}</div>`,
    },
    {
      key: "failure",
      label: t("api.col_failure"),
      render: (row) => {
        if (!row.failureCode) return "-";
        const text = failureText(row.failureCode);
        return html`${text.key ? t(text.key) : null} <span class="mono">${text.code}</span>`;
      },
    },
    { key: "open", label: t("api.col_open"), render: (row) => html`<a class="btn btn-sm" href=${buildHash("api", ["history", String(row.id)])}>${t("common.open")}</a>` },
  ];

  return html`<div class="stack">
    <form class="card form" onSubmit=${apply} noValidate>
      <div class="grid">
        <${Field} type="enum" name="api-filter-key" label=${t("api.filter_key")} value=${form.key} options=${keyOptions} onChange=${set("key")} />
        <${Field} type="enum" name="api-filter-status" label=${t("api.filter_status")} value=${form.status} options=${statusOptions} onChange=${set("status")} />
        <${Field} type="enum" name="api-filter-format" label=${t("api.filter_format")} value=${form.format} options=${formatOptions} onChange=${set("format")} />
        <${DayField} id="api-filter-from" label=${t("api.filter_from")} value=${form.from} onChange=${set("from")} error=${errors.from} />
        <${DayField} id="api-filter-to" label=${t("api.filter_to")} value=${form.to} onChange=${set("to")} error=${errors.to} />
      </div>
      <div class="actions">
        <button type="submit" class="btn btn-primary">${t("api.filter_apply")}</button>
        ${hasFilter(form) || hasFilter(applied) ? html`<button type="button" class="btn" onClick=${reset}>${t("api.filter_reset")}</button>` : null}
        <button type="button" class="btn" disabled=${loading} onClick=${reload}><${Icon} name="refresh" />${t("common.refresh")}</button>
      </div>
    </form>
    <p class="muted">${t("api.history_no_content", { days: state.settings ? state.settings.retentionDays : "" })}</p>
    ${error && !data
      ? html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}>
          <button type="button" class="btn" onClick=${reload}><${Icon} name="refresh" />${t("common.retry")}</button>
        <//>`
      : html`<${DataTable}
          columns=${columns}
          rows=${data ? data.items : []}
          rowKey="id"
          loading=${loading}
          caption=${t("api.tab_history")}
          empty=${html`<${EmptyState} icon="info" title=${t("api.history_empty")} />`}
          pagination=${data ? { page: data.page, pageSize: data.pageSize || HISTORY_PAGE_SIZE, total: data.total, onPage: setPage } : undefined}
        />`}
  </div>`;
}
