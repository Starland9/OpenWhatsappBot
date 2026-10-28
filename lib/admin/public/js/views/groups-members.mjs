// Member roles (GRP-11..GRP-13) and warnings (GRP-14..GRP-16) of one group.
import { html, useState, useAsync, useAction, DataTable, EmptyState, Icon, Pagination, StatusBadge } from "../components/index.mjs";
import { t, tError, formatDateTime } from "../i18n.mjs";
import { api } from "../api.mjs";
import { confirm, toastSuccess } from "../ui.mjs";
import { MEMBER_PAGE_SIZE, ROLES, SEARCH_MAX, filterMembers, paginate, roleBody, shortJid, sortMembers } from "./groups-logic.mjs";

const groupBase = (group) => `/admin/api/groups/${encodeURIComponent(group.jid)}`;

function RoleSelect({ member, disabled, onPick }) {
  return html`<select class="select" aria-label=${t("groups.role_of", { member: shortJid(member.jid) })} disabled=${disabled} onChange=${(event) => onPick(member, event.currentTarget.value)}>
    ${ROLES.map((role) => html`<option key=${role} value=${role} selected=${role === member.role}>${t(`groups.role_${role}`)}</option>`)}
  </select>`;
}

/** Roles: the members of the group when WhatsApp answers, else the members that have a role. */
function RolesCard({ group, reloadGroup }) {
  const base = groupBase(group);
  const { data, loading, error, reload } = useAsync(async () => {
    const roles = await api("GET", `${base}/roles`);
    let members = null;
    let membersError = null;
    try {
      members = (await api("GET", `${base}/members`)).items;
    } catch (err) {
      membersError = err;
    }
    return { roles: roles.items, members, membersError };
  }, [group.jid]);
  const [busy, run] = useAction();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState({}); // jid -> role just set, until the next load
  const [tick, setTick] = useState(0); // remounts the selects after a refused change, so they show the real role

  // members known by WhatsApp, or (offline) the stored roles
  const rows = data
    ? (data.members || data.roles.map((r) => ({ jid: r.userJid, admin: null, role: r.role }))).map((m) => ({ ...m, role: picked[m.jid] || m.role }))
    : [];
  const shown = paginate(sortMembers(filterMembers(rows, query)), page, MEMBER_PAGE_SIZE);

  const setRole = async (member, role) => {
    const body = roleBody(member.role, role);
    const saved = body
      ? await run(async () => {
          await api("PUT", `${base}/roles/${encodeURIComponent(member.jid)}`, body);
          setPicked((p) => ({ ...p, [member.jid]: role }));
          toastSuccess(t("groups.role_saved"));
          await reloadGroup();
          return true;
        })
      : null;
    if (!saved) setTick((n) => n + 1);
  };

  const columns = [
    { key: "jid", label: t("groups.col_member"), render: (row) => html`<span class="mono">${shortJid(row.jid)}</span>` },
    {
      key: "admin",
      label: t("groups.col_admin"),
      render: (row) => (row.admin ? html`<${StatusBadge} tone="info" label=${t(`groups.admin_${row.admin}`)} />` : html`<span class="muted">-</span>`),
    },
    { key: "role", label: t("groups.col_role"), render: (row) => html`<${RoleSelect} key=${`${row.jid}-${tick}`} member=${row} disabled=${busy} onPick=${setRole} />` },
  ];

  return html`<section class="card stack">
    <h2 class="card-title">${t("groups.roles_title")}</h2>
    <p class="muted">${t("groups.roles_intro")}</p>
    ${data && data.membersError ? html`<p class="muted" role="status">${t("groups.members_unavailable", { reason: tError(data.membersError) })}</p>` : null}
    ${error && !data
      ? html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}><button type="button" class="btn" onClick=${reload}>${t("common.retry")}</button><//>`
      : html`<div class="stack">
          ${data && data.members
            ? html`<div class="field">
                <label class="field-label" for="members-search">${t("groups.members_search")}</label>
                <input id="members-search" class="input" type="search" inputmode="search" maxlength=${SEARCH_MAX} value=${query} placeholder=${t("groups.members_search_placeholder")} autocomplete="off" onInput=${(event) => { setQuery(event.currentTarget.value); setPage(1); }} />
              </div>`
            : null}
          <${DataTable}
            columns=${columns}
            rows=${shown.items}
            rowKey="jid"
            loading=${loading}
            caption=${t("groups.roles_title")}
            empty=${html`<${EmptyState} icon="info" title=${query ? t("groups.members_no_match") : t("groups.roles_empty")} message=${query ? undefined : t("groups.roles_empty_hint")} />`}
          />
          <${Pagination} page=${shown.page} pageSize=${MEMBER_PAGE_SIZE} total=${shown.total} onPage=${setPage} />
        </div>`}
  </section>`;
}

/** Warnings: who has some, reset one member or the whole group. */
function WarningsCard({ group, reloadGroup }) {
  const base = groupBase(group);
  const { data, loading, error, reload } = useAsync(() => api("GET", `${base}/warnings`), [group.jid]);
  const [busy, run] = useAction();

  const resetOne = (row) =>
    run(async () => {
      const ok = await confirm({ title: t("groups.warnings_reset_title"), message: t("groups.warnings_reset_message", { member: shortJid(row.jid) }), confirmLabel: t("common.reset") });
      if (!ok) return;
      await api("DELETE", `${base}/warnings/${encodeURIComponent(row.jid)}`);
      toastSuccess(t("groups.warnings_reset_done"));
      await Promise.all([reload(), reloadGroup()]);
    });

  const resetAll = () =>
    run(async () => {
      const ok = await confirm({ title: t("groups.warnings_reset_all_title"), message: t("groups.warnings_reset_all_message"), confirmLabel: t("groups.warnings_reset_all") });
      if (!ok) return;
      await api("DELETE", `${base}/warnings?confirm=true`);
      toastSuccess(t("groups.warnings_reset_done"));
      await Promise.all([reload(), reloadGroup()]);
    });

  const items = data ? data.items : [];
  const columns = [
    { key: "jid", label: t("groups.col_member"), render: (row) => html`<span class="mono">${shortJid(row.jid)}</span>` },
    { key: "count", label: t("groups.col_warnings"), align: "right", render: (row) => t("groups.warnings_count", { count: row.count, limit: data.limit }) },
    { key: "reason", label: t("groups.col_reason"), render: (row) => row.reason || html`<span class="muted">-</span>` },
    { key: "updatedAt", label: t("groups.col_updated"), render: (row) => formatDateTime(row.updatedAt) },
    {
      key: "actions",
      label: t("groups.col_actions"),
      render: (row) => html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => resetOne(row)}><${Icon} name="refresh" />${t("common.reset")}</button>`,
    },
  ];

  return html`<section class="card stack">
    <div class="row-wrap">
      <h2 class="card-title grow">${t("groups.warnings_title")}</h2>
      ${items.length ? html`<button type="button" class="btn btn-danger btn-sm" disabled=${busy} onClick=${resetAll}><${Icon} name="trash" />${t("groups.warnings_reset_all")}</button>` : null}
    </div>
    <p class="muted">${t("groups.warnings_intro", { limit: data ? data.limit : "" })}</p>
    ${error && !data
      ? html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}><button type="button" class="btn" onClick=${reload}>${t("common.retry")}</button><//>`
      : html`<${DataTable}
          columns=${columns}
          rows=${items}
          rowKey="jid"
          loading=${loading}
          caption=${t("groups.warnings_title")}
          empty=${html`<${EmptyState} icon="check" title=${t("groups.warnings_empty")} />`}
        />`}
  </section>`;
}

export function MembersTab({ group, reload }) {
  return html`<div class="stack">
    <${RolesCard} group=${group} reloadGroup=${reload} />
    <${WarningsCard} group=${group} reloadGroup=${reload} />
  </div>`;
}
