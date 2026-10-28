// The chats where the bot is disabled, with a button to switch it back on (CHAT-2, CHAT-3, FR-033).
import { html, useAsync, useAction, DataTable, EmptyState, Icon } from "../components/index.mjs";
import { t, tError, formatDateTime } from "../i18n.mjs";
import { api } from "../api.mjs";
import { toastSuccess } from "../ui.mjs";
import { buildHash } from "../router.mjs";
import { shortJid } from "./groups-logic.mjs";

const chatPath = (jid) => `/admin/api/chats/disabled/${encodeURIComponent(jid)}`;

export function DisabledChats() {
  const { data, error, loading, reload } = useAsync(() => api("GET", "/admin/api/chats/disabled"), []);
  const [busy, run] = useAction();

  const enable = (row) =>
    run(async () => {
      await api("DELETE", chatPath(row.jid));
      toastSuccess(t("groups.disabled_enabled"));
      await reload();
    });

  if (error && !data) {
    return html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}>
      <button type="button" class="btn" onClick=${reload}>${t("common.retry")}</button>
    <//>`;
  }

  const columns = [
    {
      key: "name",
      label: t("groups.col_name"),
      render: (row) => html`<div class="stack-sm">
        ${row.kind === "group" ? html`<a href=${buildHash("groups", [row.jid])}>${row.name || t("groups.unnamed")}</a>` : html`<span>${row.name || t("groups.unnamed_chat")}</span>`}
        <span class="muted mono">${shortJid(row.jid)}</span>
      </div>`,
    },
    { key: "kind", label: t("groups.col_kind"), render: (row) => t(`groups.kind_${row.kind}`) },
    { key: "since", label: t("groups.col_since"), render: (row) => formatDateTime(row.since) },
    {
      key: "actions",
      label: t("groups.col_actions"),
      render: (row) => html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => enable(row)}><${Icon} name="check" />${t("groups.disabled_enable")}</button>`,
    },
  ];

  return html`<div class="stack">
    <p class="muted">${t("groups.disabled_intro")}</p>
    <${DataTable}
      columns=${columns}
      rows=${data ? data.items : []}
      rowKey="jid"
      loading=${loading}
      caption=${t("groups.list_tab_disabled")}
      empty=${html`<${EmptyState} icon="check" title=${t("groups.disabled_empty")} message=${t("groups.disabled_empty_hint")} />`}
    />
  </div>`;
}
