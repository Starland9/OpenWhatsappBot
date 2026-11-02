// The Keys tab (feature 004, contracts/panel-ui.md 7.4): the key table, the row actions, the empty state and the
// plain-HTTP networks card below it. There is no reactivate action anywhere (U10, FR-014): a revoked key is read-only.
import { html, useState, useAction, DataTable, EmptyState, Field, Icon, Spinner, StatusBadge } from "../components/index.mjs";
import { t, tError, formatDateTime } from "../i18n.mjs";
import { buildHash } from "../router.mjs";
import { canDuplicate, canRevoke, keyRow, visibleKeys } from "./api-logic.mjs";
import { duplicateKey, revokeKey } from "./api-key-actions.mjs";
import { rightLabel } from "./api-rights.mjs";
import { NetworksCard } from "./api-networks.mjs";

const STATE_TONE = { active: "ok", expired: "neutral", revoked: "danger" };

function PolicyCell({ policy }) {
  if (policy.mode === "anyone") return html`<span class="badge badge-danger">${t("api.cell_policy_anyone")}</span>`;
  if (policy.mode === "known") return html`<span class="badge">${t("api.cell_policy_known")}</span>`;
  return html`<span class="badge">${t("api.cell_policy_list", { count: policy.count })}</span>`;
}

const limitText = (limit) => `${limit.value ?? "-"}${limit.isDefault ? ` (${t("api.cell_limit_default")})` : ""}`;

/** `KeysTab({ keys, error, reload, state, catalog, onChanged, onSecret })` */
export function KeysTab({ keys, error, reload, state, catalog, onChanged, onSecret }) {
  const [showRevoked, setShowRevoked] = useState(true);
  const [busy, run] = useAction();

  if (!keys) {
    if (error) {
      return html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}>
        <button type="button" class="btn" onClick=${reload}><${Icon} name="refresh" />${t("common.retry")}</button>
      <//>`;
    }
    return html`<${Spinner} />`;
  }

  const now = Date.now();
  const items = visibleKeys(keys.items, { showRevoked, now });
  const rows = items.map((key) => ({ key, cell: keyRow(key, { settings: state.settings, now }) }));
  const newLink = html`<a class="btn btn-primary" href=${buildHash("api", ["keys", "new"])}><${Icon} name="plus" />${t("api.keys_new")}</a>`;

  const columns = [
    {
      key: "name",
      label: t("api.col_key"),
      render: ({ key, cell }) => html`<div class="stack-sm"><a href=${buildHash("api", ["keys", String(key.id)])}><strong>${cell.name}</strong></a><span class="mono">…${cell.last4}</span></div>`,
    },
    { key: "state", label: t("api.col_state"), render: ({ cell }) => html`<${StatusBadge} tone=${STATE_TONE[cell.state] || "neutral"} label=${t(`api.key_state.${cell.state}`)} />` },
    {
      key: "rights",
      label: t("api.col_rights"),
      render: ({ cell }) => html`<div class="stack-sm">
        <span>${cell.rightsCount === 0 ? t("api.cell_rights_none") : t("api.cell_rights", { count: cell.rightsCount })}</span>
        <span class="row-wrap">${cell.rightsPreview.map((id) => html`<span class="chip" key=${id}>${rightLabel(id)}</span>`)}${cell.rightsMore ? html`<span class="muted">${t("api.cell_rights_more", { count: cell.rightsMore })}</span>` : null}</span>
      </div>`,
    },
    { key: "recipients", label: t("api.col_recipients"), render: ({ cell }) => html`<${PolicyCell} policy=${cell.policy} />` },
    {
      key: "limits",
      label: t("api.col_limits"),
      render: ({ cell }) => t("api.cell_limits", { perMinute: limitText(cell.limits[0]), perDay: limitText(cell.limits[1]), pending: limitText(cell.limits[2]) }),
    },
    {
      key: "access",
      label: t("api.col_access"),
      render: ({ cell }) => html`<div class="stack-sm">
        <span>${cell.ipCount === 0 ? t("api.cell_ip_any") : t("api.cell_ip_count", { count: cell.ipCount })}</span>
        <span class="muted">${cell.expiresAt ? t("api.cell_expires", { date: formatDateTime(cell.expiresAt) }) : t("api.cell_no_expiry")}</span>
      </div>`,
    },
    {
      key: "lastUse",
      label: t("api.col_last_use"),
      render: ({ cell }) => (cell.lastUsedAt ? html`<div class="stack-sm"><span>${formatDateTime(cell.lastUsedAt)}</span>${cell.lastUsedIp ? html`<span class="mono">${cell.lastUsedIp}</span>` : null}</div>` : html`<span class="muted">${t("api.cell_never")}</span>`),
    },
    { key: "created", label: t("api.col_created"), render: ({ cell }) => formatDateTime(cell.createdAt) },
    {
      key: "actions",
      label: t("api.col_actions"),
      render: ({ key }) => {
        const label = (action) => t("api.action_for", { action, name: key.name });
        return html`<div class="cell-actions">
          <a class="btn btn-sm" href=${buildHash("api", ["keys", String(key.id)])} aria-label=${label(t("common.edit"))}>${t("common.edit")}</a>
          ${canDuplicate(key, now) ? html`<button type="button" class="btn btn-sm" disabled=${busy} aria-label=${label(t("api.action_duplicate"))} onClick=${() => duplicateKey(key, { run, onSecret, onChanged })}>${t("api.action_duplicate")}</button>` : null}
          ${canRevoke(key, now) ? html`<button type="button" class="btn btn-sm btn-danger" disabled=${busy} aria-label=${label(t("api.action_revoke"))} onClick=${() => revokeKey(key, { run, onChanged })}>${t("api.action_revoke")}</button>` : null}
          <a class="btn btn-sm" href=${buildHash("api", [], { tab: "history", key: String(key.id) })} aria-label=${label(t("api.action_history"))}>${t("api.action_history")}</a>
        </div>`;
      },
    },
  ];

  return html`<div class="stack">
    <div class="row-wrap">
      <button type="button" class="btn btn-sm" onClick=${reload}><${Icon} name="refresh" />${t("common.refresh")}</button>
      ${newLink}
    </div>
    <${Field} type="bool" name="api-show-revoked" label=${t("api.keys_show_revoked")} value=${showRevoked} onChange=${setShowRevoked} />
    <p class="muted">${t("api.keys_purge_note", { days: state.settings ? state.settings.retentionDays : "" })}</p>
    <${DataTable}
      columns=${columns}
      rows=${rows}
      rowKey=${(row) => row.key.id}
      caption=${t("api.tab_keys")}
      empty=${html`<${EmptyState} icon="info" title=${t("api.keys_empty")} message=${t("api.keys_empty_hint")}>${newLink}<//>`}
    />
    <${NetworksCard} key=${(state.plainHttpFrom || []).join("|")} state=${state} catalog=${catalog} onChanged=${onChanged} />
  </div>`;
}
