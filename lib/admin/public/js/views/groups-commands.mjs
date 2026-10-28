// Commands switched off in one group (GRP-17, FR-027): the group page's mirror of the commands area.
import { html, useState, useAsync, useAction, DataTable, EmptyState, Field, Pagination, StatusBadge } from "../components/index.mjs";
import { t, tError } from "../i18n.mjs";
import { api } from "../api.mjs";
import { confirm, toastSuccess } from "../ui.mjs";
import { SEARCH_MAX, commandBody, commandState, filterCommands, lockoutKey, paginate } from "./groups-logic.mjs";

const PAGE = 20;

export function CommandsTab({ group, reload: reloadGroup }) {
  const path = `/admin/api/groups/${encodeURIComponent(group.jid)}/commands`;
  const { data, error, loading, reload } = useAsync(() => api("GET", "/admin/api/commands"), []);
  const [busy, run] = useAction();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [here, setHere] = useState(group.disabledCommands); // names off in this group, kept from the last answer

  const commands = data ? data.commands : [];
  const shown = paginate(filterCommands(commands, query), page, PAGE);

  const toggle = (command, enabled) =>
    run(async () => {
      const lockout = !enabled && lockoutKey(command.name);
      if (lockout) {
        const ok = await confirm({ title: t("groups.lockout_title", { name: command.name }), message: t(lockout), confirmLabel: t("groups.lockout_confirm") });
        if (!ok) return;
      }
      const answer = await api("PATCH", path, commandBody(command.name, !enabled));
      setHere(answer.disabledCommands);
      toastSuccess(t(enabled ? "groups.command_on" : "groups.command_off", { name: command.name }));
      await reloadGroup();
    });

  const columns = [
    {
      key: "name",
      label: t("groups.col_command"),
      render: (row) => html`<div class="stack-sm"><span class="mono">${row.name}</span><span class="muted">${row.desc}</span></div>`,
    },
    {
      key: "state",
      label: t("groups.col_state"),
      render: (row) => {
        const state = commandState(row, group.jid, here);
        if (state === "global") return html`<${StatusBadge} tone="danger" label=${t("groups.command_global")} />`;
        return html`<${Field} type="bool" name=${`cmd-${row.name}`} label=${t("groups.command_switch", { name: row.name })} value=${state === "on"} disabled=${busy} onChange=${(enabled) => toggle(row, enabled)} />`;
      },
    },
  ];

  return html`<section class="card stack">
    <h2 class="card-title">${t("groups.commands_title")}</h2>
    <p class="muted">${t("groups.commands_intro")}</p>
    ${error && !data
      ? html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}><button type="button" class="btn" onClick=${reload}>${t("common.retry")}</button><//>`
      : html`<div class="stack">
          <div class="field">
            <label class="field-label" for="commands-search">${t("groups.commands_search")}</label>
            <input id="commands-search" class="input" type="search" maxlength=${SEARCH_MAX} value=${query} placeholder=${t("groups.commands_search_placeholder")} autocomplete="off" onInput=${(event) => { setQuery(event.currentTarget.value); setPage(1); }} />
          </div>
          <${DataTable}
            columns=${columns}
            rows=${shown.items}
            rowKey="name"
            loading=${loading}
            caption=${t("groups.commands_title")}
            empty=${html`<${EmptyState} icon="info" title=${t("groups.commands_no_match")} />`}
          />
          <${Pagination} page=${shown.page} pageSize=${PAGE} total=${shown.total} onPage=${setPage} />
        </div>`}
  </section>`;
}
