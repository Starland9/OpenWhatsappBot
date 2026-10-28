import {
  html,
  useState,
  useEffect,
  useAsync,
  useLanguage,
  useLive,
  DataTable,
  EmptyState,
  Icon,
  Spinner,
} from "../components/index.mjs";
import { t, tError, formatDateTime } from "../i18n.mjs";
import { api } from "../api.mjs";
import { BroadcastDetail, StateBadge, RunCounters } from "./broadcasts-detail.mjs";
import { BroadcastForm } from "./broadcasts-form.mjs";
import { STATES, listQuery, mergeProgress, closesRun, labelOf, ruleText } from "./broadcasts-logic.mjs";

export const meta = { area: "broadcasts", titleKey: "broadcasts.title", icon: "broadcasts" };

const PAGE_SIZE = 20;

/** BC-1: the list with the derived states and the live progress of the running ones */
function BroadcastList() {
  const lang = useLanguage();
  const [kind, setKind] = useState("");
  const [state, setState] = useState("");
  const [page, setPage] = useState(1);
  const query = listQuery({ kind, state, page, pageSize: PAGE_SIZE });
  const { data, error, loading, reload } = useAsync(() => api("GET", "/admin/api/broadcasts", query), [kind, state, page]);
  const [items, setItems] = useState([]);

  useEffect(() => setItems((data && data.items) || []), [data]);
  useEffect(() => setPage(1), [kind, state]);
  useLive("job", (event) => {
    if (closesRun(event)) reload();
    else setItems((current) => mergeProgress(current, event));
  });

  const columns = [
    {
      key: "label",
      label: t("broadcasts.col_broadcast"),
      render: (row) => html`<div class="stack-sm"><a href=${`#/broadcasts/${row.id}`}><strong>${labelOf(row)}</strong></a><span class="muted">${t(`broadcasts.kind_${row.kind}`)}${row.recurrence ? ` · ${t(ruleText(row.recurrence, lang).key, ruleText(row.recurrence, lang).params)}` : ""}</span></div>`,
    },
    { key: "state", label: t("broadcasts.col_state"), render: (row) => html`<${StateBadge} broadcast=${row} />` },
    { key: "targets", label: t("broadcasts.col_destinations"), align: "right", render: (row) => row.targetCount },
    { key: "progress", label: t("broadcasts.col_progress"), render: (row) => html`<${RunCounters} run=${row.latestRun} />` },
    {
      key: "when",
      label: t("broadcasts.col_when"),
      render: (row) => {
        const at = row.kind === "recurring" ? (row.state === "paused" && row.paused && row.paused.by === "admin" ? null : row.nextRunAt) : (row.latestRun && row.latestRun.dueAt) || row.runAt;
        return at ? formatDateTime(at) : html`<span class="muted">—</span>`;
      },
    },
    { key: "actions", label: t("broadcasts.col_actions"), render: (row) => html`<div class="cell-actions"><a class="btn btn-sm" href=${`#/broadcasts/${row.id}`}>${t("common.open")}</a></div>` },
  ];

  const header = html`<div class="view-header">
    <h1>${t("broadcasts.title")}</h1>
    <div class="row-wrap">
      <button type="button" class="btn btn-sm" disabled=${loading} onClick=${reload}><${Icon} name="refresh" />${t("common.refresh")}</button>
      <a class="btn btn-sm btn-primary" href="#/broadcasts/new"><${Icon} name="plus" />${t("broadcasts.new_button")}</a>
    </div>
  </div>`;

  if (loading && !data) return html`<section class="view">${header}<${Spinner} /></section>`;
  if (error && !data) {
    return html`<section class="view">
      ${header}
      <${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}>
        <button type="button" class="btn" onClick=${reload}><${Icon} name="refresh" />${t("common.retry")}</button>
      <//>
    </section>`;
  }

  return html`<section class="view stack">
    ${header}
    <p class="muted">${t("broadcasts.intro")}</p>
    <div class="row-wrap">
      <select class="select" value=${kind} aria-label=${t("broadcasts.filter_kind")} onChange=${(event) => setKind(event.currentTarget.value)}>
        <option value="" selected=${kind === ""}>${t("broadcasts.filter_kind_all")}</option>
        <option value="once" selected=${kind === "once"}>${t("broadcasts.kind_once")}</option>
        <option value="recurring" selected=${kind === "recurring"}>${t("broadcasts.kind_recurring")}</option>
      </select>
      <select class="select" value=${state} aria-label=${t("broadcasts.filter_state")} onChange=${(event) => setState(event.currentTarget.value)}>
        <option value="" selected=${state === ""}>${t("broadcasts.filter_state_all")}</option>
        ${STATES.map((name) => html`<option key=${name} value=${name} selected=${state === name}>${t(`broadcasts.state_${name}`)}</option>`)}
      </select>
    </div>
    <${DataTable}
      columns=${columns}
      rows=${items}
      rowKey="id"
      caption=${t("broadcasts.title")}
      empty=${html`<${EmptyState} icon="info" title=${t("broadcasts.empty")} message=${t("broadcasts.empty_hint")}>
        <a class="btn btn-primary" href="#/broadcasts/new">${t("broadcasts.new_button")}</a>
      <//>`}
      pagination=${data ? { page: data.page, pageSize: data.pageSize, total: data.total, onPage: setPage } : null}
    />
  </section>`;
}

/**
 * Routes of the area:  #/broadcasts            the list
 *                      #/broadcasts/new        the create form (`?from=<id>&run=<runId>`: pre-filled from the failed
 *                                              destinations of a run, a NEW broadcast, never a re-send)
 *                      #/broadcasts/<id>       the detail, progress and per-destination report
 *                      #/broadcasts/<id>/edit  the edit form of a recurring message
 */
export default function BroadcastsView({ route }) {
  const [first, second] = (route && route.rest) || [];
  const query = (route && route.query) || {};
  if (first === "new") {
    return html`<${BroadcastForm} fromId=${/^\d+$/.test(query.from || "") ? Number(query.from) : undefined} fromRun=${/^\d+$/.test(query.run || "") ? Number(query.run) : undefined} />`;
  }
  if (first && /^\d+$/.test(first)) {
    return second === "edit" ? html`<${BroadcastForm} editId=${Number(first)} />` : html`<${BroadcastDetail} id=${Number(first)} />`;
  }
  return html`<${BroadcastList} />`;
}
