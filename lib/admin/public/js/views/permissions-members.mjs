// Picker of the rule editor for a group scope (contracts/panel-ui.md section 6): the members of the group, from GRP-11.
// It holds no draft: ticking a box asks the editor (`onToggle`) to add or remove the person. A group rule is for
// members (FR-020), so there is no typed number here.
import { html, useState, useAsync, useId, DataTable, EmptyState, Pagination, Spinner, StatusBadge } from "../components/index.mjs";
import { t } from "../i18n.mjs";
import { api } from "../api.mjs";
import { MEMBER_PAGE_SIZE, SEARCH_MAX, filterMembers, paginate, shortJid, sortMembers } from "./groups-logic.mjs";
import { personKey } from "./permissions-logic.mjs";

const membersPath = (jid) => `/admin/api/groups/${encodeURIComponent(jid)}/members`;

/**
 *   jid        the group
 *   available  PERM-5 `members.available`: false means the bot cannot read the member list (offline, left the group)
 *   selected   the people of the editor's draft      max   the cap of the rule      disabled   the parent is busy
 *   onToggle(person)  person = { jid, name: null, present: true, admin }
 */
export function GroupMemberPicker({ jid, available, selected, max, disabled = false, onToggle }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const searchId = `permissions-members-search-${useId()}`;
  // an unavailable list makes no call at all: people can still be removed in the editor
  const { data, error, loading } = useAsync(() => (available ? api("GET", membersPath(jid)) : Promise.resolve(null)), [jid, available]);

  if (!available || (error && !data)) return html`<p class="muted" role="status">${t("permissions.members_unavailable")}</p>`;
  if (loading && !data) return html`<${Spinner} />`;

  const picked = new Set((selected || []).map((person) => personKey(person.jid)));
  const full = (selected || []).length >= max;
  const members = (data && data.items) || [];
  const shown = paginate(sortMembers(filterMembers(members, query)), page, MEMBER_PAGE_SIZE);

  const columns = [
    {
      key: "pick",
      label: t("permissions.col_pick"),
      render: (member) => {
        const checked = picked.has(personKey(member.jid));
        return html`<label class="choice"><input type="checkbox" checked=${checked} disabled=${disabled || (full && !checked)} aria-label=${t("permissions.pick_person", { person: shortJid(member.jid) })} onChange=${() => onToggle({ jid: member.jid, name: null, present: true, admin: member.admin || null })} /></label>`;
      },
    },
    { key: "jid", label: t("groups.col_member"), render: (member) => html`<span class="mono">${shortJid(member.jid)}</span>` },
    {
      key: "admin",
      label: t("groups.col_admin"),
      render: (member) => (member.admin ? html`<${StatusBadge} tone="info" label=${t(`groups.admin_${member.admin}`)} />` : html`<span class="muted">-</span>`),
    },
  ];

  return html`<div class="stack-sm">
    <h4 class="field-label">${t("permissions.members_title")}</h4>
    <div class="field">
      <label class="field-label" for=${searchId}>${t("groups.members_search")}</label>
      <input id=${searchId} class="input" type="search" inputmode="search" maxlength=${SEARCH_MAX} value=${query} placeholder=${t("groups.members_search_placeholder")} autocomplete="off" onInput=${(event) => {
        setQuery(event.currentTarget.value);
        setPage(1);
      }} />
    </div>
    <${DataTable}
      columns=${columns}
      rows=${shown.items}
      rowKey="jid"
      caption=${t("permissions.members_title")}
      empty=${html`<${EmptyState} icon="info" title=${t("groups.members_no_match")} />`}
    />
    <${Pagination} page=${shown.page} pageSize=${MEMBER_PAGE_SIZE} total=${shown.total} onPage=${setPage} />
  </div>`;
}
