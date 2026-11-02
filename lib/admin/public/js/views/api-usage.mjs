// The Usage tab (feature 004, contracts/panel-ui.md 7.9): messages per key and day, one table per entry, a proportional
// <progress> per day (the stats pattern, no chart). The answer is dense: the browser never fills days in.
import { html, useState, useAsync, DataTable, EmptyState, Field, Icon, Spinner } from "../components/index.mjs";
import { t, tError, formatNumber } from "../i18n.mjs";
import { api } from "../api.mjs";
import { buildHash } from "../router.mjs";
import { usageModel, usageQuery, visibleKeys } from "./api-logic.mjs";

const base = "/admin/api/api";

function UsageTable({ entry }) {
  const caption = entry.source === "panel" ? t("api.source_panel") : entry.name;
  const keyParam = entry.source === "panel" ? "panel" : String(entry.id);
  const columns = [
    { key: "day", label: t("api.col_day"), render: (row) => html`<span class="mono nowrap">${row.day}</span>` },
    { key: "sent", label: t("api.col_sent"), align: "right", render: (row) => formatNumber(row.sent) },
    {
      key: "failed",
      label: t("api.col_failed"),
      align: "right",
      render: (row) => (row.failed > 0 ? html`<a href=${buildHash("api", [], { tab: "history", key: keyParam, status: "failed" })}>${formatNumber(row.failed)}</a>` : formatNumber(row.failed)),
    },
    {
      key: "bar",
      label: "",
      render: (row) => html`<progress max="1" value=${row.ratio} aria-label=${t("api.usage_bar", { day: row.day, sent: row.sent, failed: row.failed })}></progress>`,
    },
  ];
  return html`<section class="card stack-sm">
    <div class="row-wrap">
      <h3 class="card-title grow">${caption}</h3>
      ${entry.revoked ? html`<span class="badge badge-danger">${t("api.key_state.revoked")}</span>` : null}
    </div>
    <${DataTable} columns=${columns} rows=${entry.rows} rowKey="day" caption=${caption} />
    <p class="muted">${t("api.usage_totals", { sent: formatNumber(entry.totals.sent), failed: formatNumber(entry.totals.failed) })}</p>
  </section>`;
}

/** `UsageTab({ keys, state })` */
export function UsageTab({ keys }) {
  const [days, setDays] = useState(7);
  const [keyId, setKeyId] = useState("all");
  const query = usageQuery(days, keyId);
  const { data, error, loading, reload } = useAsync(() => api("GET", `${base}/usage`, usageQuery(days, keyId)), [days, keyId]);

  const keyOptions = [
    { value: "all", label: t("api.usage_key_all") },
    ...visibleKeys(keys ? keys.items : [], { showRevoked: true }).map((key) => ({ value: String(key.id), label: key.name })),
    { value: "panel", label: t("api.source_panel") },
  ];
  const dayOptions = [
    { value: 7, label: t("api.usage_days_7") },
    { value: 30, label: t("api.usage_days_30") },
  ];
  const entries = data ? usageModel(data) : [];
  const empty = entries.length === 0 || entries.every((entry) => entry.empty);

  return html`<div class="stack">
    <form class="card form" onSubmit=${(event) => event.preventDefault()}>
      <div class="grid">
        <${Field} type="enum" name="api-usage-key" label=${t("api.usage_key")} value=${query.key} options=${keyOptions} onChange=${(value) => setKeyId(String(value))} />
        <${Field} type="enum" name="api-usage-days" label=${t("api.usage_period")} value=${query.days} options=${dayOptions} onChange=${(value) => setDays(Number(value))} />
      </div>
    </form>
    ${loading && !data ? html`<${Spinner} />` : null}
    ${error && !data
      ? html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}>
          <button type="button" class="btn" onClick=${reload}><${Icon} name="refresh" />${t("common.retry")}</button>
        <//>`
      : null}
    ${data && empty ? html`<${EmptyState} icon="info" title=${t("api.usage_empty")} />` : null}
    ${data && !empty ? entries.map((entry) => html`<${UsageTable} key=${`${entry.source}:${entry.id}`} entry=${entry} />`) : null}
    ${data ? html`<p class="muted">${t("api.usage_note")}</p><p class="muted">${t("api.usage_timezone", { zone: data.timezone })}</p>` : null}
  </div>`;
}
