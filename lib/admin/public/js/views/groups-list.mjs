// The groups list (GRP-1, GRP-2) and its tabs: the groups, and the chats where the bot is disabled (CHAT-2).
import { html, useState, useEffect, useAsync, useAction, DataTable, EmptyState, Icon, StatusBadge, Tabs, TabPanel } from "../components/index.mjs";
import { t, tError, formatDateTime, formatNumber } from "../i18n.mjs";
import { api } from "../api.mjs";
import { toastSuccess } from "../ui.mjs";
import { buildHash, navigate } from "../router.mjs";
import { DisabledChats } from "./groups-disabled.mjs";
import { listQuery, rowBadges, rowFeatures, shortJid, tabOf, LIST_TABS, STATUSES, PAGE_SIZE, SEARCH_MAX } from "./groups-logic.mjs";

function GroupName({ row }) {
  const label = row.name || t("groups.unnamed");
  return html`<div class="stack-sm">
    <a href=${buildHash("groups", [row.jid])}>${label}</a>
    <span class="muted mono">${shortJid(row.jid)}</span>
  </div>`;
}

function Badges({ row }) {
  const badges = rowBadges(row);
  const features = rowFeatures(row);
  if (!badges.length && !features.length) return html`<span class="muted">${t("common.none")}</span>`;
  return html`<span class="row-wrap">
    ${badges.map((badge) => html`<${StatusBadge} key=${badge.id} tone=${badge.tone} label=${t(`groups.badge_${badge.id}`)} />`)}
    ${features.map((feature) => html`<span key=${feature} class="badge">${t(`groups.feature_${feature}`)}</span>`)}
  </span>`;
}

function GroupTable() {
  const [filters, setFilters] = useState({ q: "", status: "all", page: 1 });
  const [typed, setTyped] = useState("");
  const [busy, run] = useAction();

  // typing is applied after a short pause, and goes back to the first page
  useEffect(() => {
    const handle = setTimeout(() => setFilters((f) => (f.q === typed ? f : { ...f, q: typed, page: 1 })), 300);
    return () => clearTimeout(handle);
  }, [typed]);

  const query = listQuery({ ...filters, pageSize: PAGE_SIZE });
  const { data, error, loading, reload } = useAsync(() => api("GET", "/admin/api/groups", query), [JSON.stringify(query)]);

  const refresh = () =>
    run(async () => {
      const answer = await api("POST", "/admin/api/groups/refresh", {});
      toastSuccess(answer.cached ? t("groups.refresh_cached") : t("groups.refresh_done"));
      await reload();
    });

  const filtered = Boolean(filters.q) || filters.status !== "all";
  let body;
  if (error && !data) {
    body = html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}>
      <button type="button" class="btn" onClick=${reload}>${t("common.retry")}</button>
    <//>`;
  } else {
    const columns = [
      { key: "name", label: t("groups.col_name"), render: (row) => html`<${GroupName} row=${row} />` },
      { key: "members", label: t("groups.col_members"), align: "right", render: (row) => (row.members === null ? html`<span class="muted" title=${t("groups.unknown_hint")}>-</span>` : formatNumber(row.members)) },
      { key: "state", label: t("groups.col_state"), render: (row) => html`<${Badges} row=${row} />` },
      {
        key: "actions",
        label: t("groups.col_actions"),
        render: (row) => html`<a class="btn btn-sm" href=${buildHash("groups", [row.jid])}><${Icon} name="edit" />${t("groups.configure")}</a>`,
      },
    ];
    body = html`<${DataTable}
      columns=${columns}
      rows=${data ? data.items : []}
      rowKey="jid"
      loading=${loading}
      caption=${t("groups.title")}
      empty=${html`<${EmptyState} icon="groups" title=${filtered ? t("groups.no_match") : t("groups.empty")} message=${filtered ? t("groups.no_match_hint") : t("groups.empty_hint")} />`}
      pagination=${data ? { page: data.page, pageSize: data.pageSize, total: data.total, onPage: (page) => setFilters((f) => ({ ...f, page })), disabled: loading } : undefined}
    />`;
  }

  return html`<div class="stack">
    <div class="card stack-sm">
      <div class="row-wrap">
        <div class="grow field">
          <label class="field-label" for="groups-search">${t("groups.search_label")}</label>
          <input id="groups-search" class="input" type="search" value=${typed} maxlength=${SEARCH_MAX} placeholder=${t("groups.search_placeholder")} autocomplete="off" onInput=${(event) => setTyped(event.currentTarget.value)} />
        </div>
        <div class="field">
          <label class="field-label" for="groups-status">${t("groups.status_label")}</label>
          <select id="groups-status" class="select" onChange=${(event) => setFilters((f) => ({ ...f, status: event.currentTarget.value, page: 1 }))}>
            ${STATUSES.map((status) => html`<option key=${status} value=${status} selected=${status === filters.status}>${t(`groups.status_${status}`)}</option>`)}
          </select>
        </div>
      </div>
      <div class="row-wrap">
        <button type="button" class="btn" disabled=${busy} onClick=${refresh}><${Icon} name="refresh" />${t("groups.refresh")}</button>
        <span class="muted">${data && data.refreshedAt ? t("groups.refreshed_at", { when: formatDateTime(data.refreshedAt) }) : t("groups.never_refreshed")}</span>
      </div>
    </div>
    ${body}
  </div>`;
}

/** `#/groups` : the groups, and the chats where the bot is disabled. */
export function GroupsList({ tab }) {
  const active = tabOf(tab, LIST_TABS);
  const tabs = LIST_TABS.map((id) => ({ id, label: t(`groups.list_tab_${id}`) }));
  return html`<section class="view stack">
    <div class="view-header"><h1>${t("groups.title")}</h1></div>
    <p class="muted">${t("groups.intro")}</p>
    <${Tabs} tabs=${tabs} active=${active} label=${t("groups.title")} idPrefix="groups-tab" onChange=${(id) => navigate("groups", [], id === LIST_TABS[0] ? {} : { tab: id })} />
    <${TabPanel} id="groups" active=${active} idPrefix="groups-tab"><${GroupTable} /><//>
    <${TabPanel} id="disabled" active=${active} idPrefix="groups-tab"><${DisabledChats} /><//>
  </section>`;
}
