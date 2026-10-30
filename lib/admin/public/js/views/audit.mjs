import { html, useState, useId, useAsync, Field, DataTable, EmptyState, StatusBadge, Icon } from "../components/index.mjs";
import { t, tError, tField, formatDateTime } from "../i18n.mjs";
import { api } from "../api.mjs";
import {
  ACTION_PREFIXES,
  EMPTY_FILTERS,
  PAGE_SIZE,
  RESULTS,
  buildAuditQuery,
  hasFilters,
  resultTone,
  ruleIdLabel,
  summarizeDetail,
  validateFilters,
} from "./audit-logic.mjs";
import { MODES } from "./permissions-logic.mjs";

export const meta = { area: "audit", titleKey: "audit.title", icon: "audit" };

const RULE_MODES = Object.values(MODES);
/** The name of a rule mode; an unknown one (an older or newer server) is shown as written */
const ruleModeLabel = (mode) => (RULE_MODES.includes(mode) ? t(`permissions.mode_${mode}`) : mode);

/** One list of ids as badges: a sign, then the number (or `@lid`), the full id; nothing when only the count is known */
function RuleIds({ ids, sign, tone }) {
  if (!ids || ids.length === 0) return null;
  return ids.map((id, index) => html`<span key=${`${index}:${id}`} class=${`badge badge-${tone}`}>${sign} <span class="mono">${ruleIdLabel(id)}</span></span>`);
}

/** A permission rule that changed: "mode: +N, -M", the mode it was, and who was added and removed */
function RuleDetail({ summary }) {
  const was = summary.previousMode && summary.previousMode !== summary.mode ? t("audit.detail_rule_was", { mode: ruleModeLabel(summary.previousMode) }) : "";
  const hasIds = (summary.added && summary.added.length > 0) || (summary.removed && summary.removed.length > 0);
  return html`<div class="stack-sm">
    <span>${t("audit.detail_rule", { mode: ruleModeLabel(summary.mode), added: summary.addedCount, removed: summary.removedCount })}${was ? html` <span class="muted">${`(${was})`}</span>` : null}</span>
    ${hasIds
      ? html`<span class="row-wrap">
          <${RuleIds} ids=${summary.added} sign="+" tone="ok" />
          <${RuleIds} ids=${summary.removed} sign="-" tone="danger" />
        </span>`
      : null}
  </div>`;
}

function Detail({ detail }) {
  const summary = summarizeDetail(detail);
  if (summary.kind === "none") return "-";
  if (summary.kind === "secret") return t(summary.op === "clear" ? "audit.detail_secret_clear" : "audit.detail_secret_set");
  if (summary.kind === "change") {
    return html`<span class="mono">${summary.from}</span> → <span class="mono">${summary.to}</span>`;
  }
  if (summary.kind === "rule") return html`<${RuleDetail} summary=${summary} />`;
  return html`<span class="mono">${summary.text}</span>`;
}

function DayField({ label, value, onChange, error }) {
  const id = useId();
  return html`<div class="field">
    <label class="field-label" for=${id}>${label}</label>
    <input class="input" type="date" id=${id} value=${value} aria-invalid=${error ? "true" : undefined} onInput=${(event) => onChange(event.currentTarget.value)} />
    ${error ? html`<div class="field-error" role="alert">${error === "end_before_start" ? t("audit.end_before_start") : tField(error)}</div>` : null}
  </div>`;
}

/** US7 (FR-036): the history of administration actions, newest first, with filters and pages. */
export default function AuditView() {
  const [form, setForm] = useState({ ...EMPTY_FILTERS });
  const [applied, setApplied] = useState({ ...EMPTY_FILTERS });
  const [errors, setErrors] = useState({});
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useAsync(() => api("GET", "/admin/api/audit", buildAuditQuery(applied, page, PAGE_SIZE)), [applied, page]);

  const set = (name) => (value) => setForm((current) => ({ ...current, [name]: value }));
  const apply = (event) => {
    event.preventDefault();
    const check = validateFilters(form);
    setErrors(check.errors);
    if (!check.ok) return;
    setPage(1);
    setApplied({ ...form });
  };
  const reset = () => {
    setForm({ ...EMPTY_FILTERS });
    setErrors({});
    setPage(1);
    setApplied({ ...EMPTY_FILTERS });
  };

  const actionOptions = [{ value: "", label: t("audit.all_actions") }, ...ACTION_PREFIXES.map((prefix) => ({ value: prefix, label: t(`audit.prefix_${prefix}`) }))];
  const resultOptions = [{ value: "", label: t("audit.all_results") }, ...RESULTS.map((result) => ({ value: result, label: t(`audit.result_${result}`) }))];

  const columns = [
    { key: "at", label: t("audit.col_when"), render: (row) => html`<span class="nowrap">${formatDateTime(row.at, { dateStyle: "short", timeStyle: "medium" })}</span>` },
    { key: "action", label: t("audit.col_action"), render: (row) => html`<span class="mono nowrap">${row.action}</span>` },
    { key: "target", label: t("audit.col_target"), render: (row) => (row.target ? html`<span class="mono">${row.target}</span>` : "-") },
    { key: "origin", label: t("audit.col_origin"), render: (row) => (row.origin ? html`<span class="mono nowrap">${row.origin}</span>` : "-") },
    { key: "result", label: t("audit.col_result"), render: (row) => html`<span class="nowrap"><${StatusBadge} tone=${resultTone(row.result)} label=${t(`audit.result_${row.result}`)} /></span>` },
    { key: "detail", label: t("audit.col_detail"), render: (row) => html`<${Detail} detail=${row.detail} />` },
  ];

  return html`<section class="view stack">
    <div class="view-header">
      <h1>${t("audit.title")}</h1>
      <button type="button" class="btn btn-sm" disabled=${loading} onClick=${reload}><${Icon} name="refresh" />${t("common.refresh")}</button>
    </div>

    <form class="card form" onSubmit=${apply} noValidate>
      <div class="grid">
        <${Field} label=${t("audit.filter_action")} name="action" type="enum" value=${form.action} onChange=${set("action")} options=${actionOptions} />
        <${Field} label=${t("audit.filter_result")} name="result" type="enum" value=${form.result} onChange=${set("result")} options=${resultOptions} />
        <${DayField} label=${t("audit.filter_from")} value=${form.from} onChange=${set("from")} error=${errors.from} />
        <${DayField} label=${t("audit.filter_to")} value=${form.to} onChange=${set("to")} error=${errors.to} />
      </div>
      <div class="actions">
        <button type="submit" class="btn btn-primary">${t("audit.apply")}</button>
        ${hasFilters(form) || hasFilters(applied) ? html`<button type="button" class="btn" onClick=${reset}>${t("audit.reset")}</button>` : null}
      </div>
    </form>

    ${error && !data ? html`<${EmptyState} icon="error" title=${tError(error)}><button type="button" class="btn" onClick=${reload}>${t("common.retry")}</button><//>` : null}
    ${
      data || !error
        ? html`<${DataTable}
            columns=${columns}
            rows=${data ? data.items : []}
            rowKey="id"
            loading=${loading}
            caption=${t("audit.title")}
            empty=${html`<${EmptyState} icon="info" title=${hasFilters(applied) ? t("audit.no_match") : t("audit.empty")} />`}
            pagination=${data ? { page: data.page, pageSize: data.pageSize, total: data.total, onPage: setPage } : undefined}
          />`
        : null
    }
  </section>`;
}
