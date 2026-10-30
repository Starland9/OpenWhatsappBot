// The permissions part of the Commands page (feature 003, contracts/panel-ui.md section 8): the card of one command's
// "everywhere" rule with the read-only list of the groups that have a rule of their own, and the card of the rules whose
// command can no longer be used. The rule editor and the person picker are the shared ones; this file only knows the
// routes (PERM-2, PERM-3, PERM-4, PERM-7) and makes the api() calls, so the contract test that matches every literal
// path sees them here.
import { html, useState, useId, useAsync, useAction, EmptyState, Icon, Spinner, StatusBadge } from "../components/index.mjs";
import { t, tError } from "../i18n.mjs";
import { api } from "../api.mjs";
import { confirm, toastSuccess } from "../ui.mjs";
import { buildHash } from "../router.mjs";
import { RuleEditor } from "./permissions-editor.mjs";
import { PersonPicker } from "./permissions-picker.mjs";
import { GLOBAL_SCOPE, MODES, groupOrphanRules, groupTabTarget, normalizeWarnings, warningBadges } from "./permissions-logic.mjs";
import { shortJid } from "./commands-logic.mjs";

const permissionsPath = (name) => `/admin/api/commands/${encodeURIComponent(name)}/permissions`;
const groupRulePath = (jid, name) => `/admin/api/groups/${encodeURIComponent(jid)}/permissions/${encodeURIComponent(name)}`;

const MODE_VALUES = Object.values(MODES);
/** The label of a stored mode; anything else (it cannot happen) is shown as written */
const modeLabel = (mode) => (MODE_VALUES.includes(mode) ? t(`permissions.mode_${mode}`) : String(mode ?? ""));
const scopeLabel = (scope) => (scope === GLOBAL_SCOPE ? t("commands.scope_everywhere") : shortJid(scope));

/** The groups that have their own rule for this command: read-only, a link to each group's Permissions tab */
function GroupRules({ groups }) {
  const rows = Array.isArray(groups) ? groups : [];
  const titleId = `commands-perm-groups-${useId()}`;
  return html`<section class="card stack-sm" aria-labelledby=${titleId}>
    <h2 class="card-title" id=${titleId}>${t("permissions.cmd_groups_title", { count: rows.length })}</h2>
    ${rows.length === 0
      ? html`<p class="muted">${t("permissions.cmd_groups_empty")}</p>`
      : html`<ul class="stack-sm">
          ${rows.map((group) => {
            const label = group.name || shortJid(group.jid);
            const target = groupTabTarget(group.jid);
            return html`<li key=${group.jid} class="row">
              <div class="grow row-wrap">
                <span class=${group.name ? undefined : "mono"}><strong>${label}</strong></span>
                <span>${modeLabel(group.mode)}</span>
                <span class="muted">${t("permissions.people_count", { count: Number(group.count) || 0 })}</span>
                ${warningBadges(normalizeWarnings(group.warnings)).map((badge) => html`<${StatusBadge} key=${badge.code} tone=${badge.tone} label=${t(badge.key)} />`)}
              </div>
              <a class="btn btn-sm" href=${buildHash(target.name, target.rest, target.query)} aria-label=${t("permissions.cmd_group_open", { group: label })}>${t("common.open")}</a>
            </li>`;
          })}
        </ul>`}
  </section>`;
}

/**
 * The "everywhere" rule of one command (PERM-2 to PERM-4) and the groups with a rule of their own.
 *   command         the merged command (name, access)
 *   limits          { peopleMax } from PERM-1 (PERM-2 carries none)
 *   disabledGlobal  the command is switched off everywhere (only a banner of the editor)
 *   busy            the page runs another action
 *   onChanged()     async; reloads PERM-1 for the table column
 *   onClose()
 * The parent gives the component a `key` per command name.
 */
export function CommandPermissions({ command, limits, disabledGlobal = false, busy = false, onChanged, onClose }) {
  const base = permissionsPath(command.name);
  const { data, error, loading, reload } = useAsync(() => api("GET", base), [command.name]);
  const [saving, run] = useAction();
  const [version, setVersion] = useState(0);
  const disabled = busy || saving;

  // Read the card's data and the column again, then start a fresh draft on the stored rule
  const refresh = async () => {
    const [fresh] = await Promise.all([reload(), onChanged ? onChanged() : null]);
    if (fresh) setVersion((current) => current + 1);
  };

  const save = (body) =>
    run(async () => {
      await api("PUT", `${base}/everywhere`, body);
      toastSuccess(t("permissions.saved", { name: command.name }));
      await refresh();
    });

  const remove = () =>
    run(async () => {
      const ok = await confirm({
        title: t("permissions.delete_title", { name: command.name }),
        message: t("permissions.delete_message_everywhere"),
        confirmLabel: t("permissions.delete_rule"),
      });
      if (!ok) return;
      await api("DELETE", `${base}/everywhere`);
      toastSuccess(t("permissions.deleted", { name: command.name }));
      await refresh();
    });

  if (loading && !data) return html`<section class="card"><${Spinner} /></section>`;
  if (error && !data) {
    return html`<section class="card">
      <${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}>
        <button type="button" class="btn" onClick=${reload}><${Icon} name="refresh" />${t("common.retry")}</button>
      <//>
    </section>`;
  }

  return html`<div class="stack">
    <${RuleEditor}
      key=${`${GLOBAL_SCOPE}:${command.name}:${version}`}
      command=${command}
      scope=${GLOBAL_SCOPE}
      saved=${data.everywhere}
      busy=${disabled}
      limits=${limits}
      context=${{ disabled: disabledGlobal ? "global" : null, hasEverywhereOnly: false }}
      intro=${t("permissions.cmd_intro")}
      Picker=${PersonPicker}
      onSave=${save}
      onDelete=${remove}
      onClose=${onClose}
    />
    <${GroupRules} groups=${data.groups} />
  </div>`;
}

/**
 * The permission rules whose command is not loaded any more, or can no longer be delegated (PERM-1 `orphans`): one chip
 * per scope. Removing one is PERM-4 ("everywhere") or PERM-7 (a group), without a dialog (it has no effect anyway).
 *   orphans      PERM-1 `orphans`
 *   busy         the page runs another action
 *   onChanged()  async; reloads PERM-1
 */
export function PermissionOrphans({ orphans, busy = false, onChanged }) {
  const [removing, run] = useAction();
  const rows = groupOrphanRules(orphans);
  if (rows.length === 0) return null;

  const removeRule = (command, scope) =>
    run(async () => {
      if (scope === GLOBAL_SCOPE) await api("DELETE", `${permissionsPath(command)}/everywhere`);
      else await api("DELETE", groupRulePath(scope, command));
      toastSuccess(t("permissions.orphan_removed", { command }));
      if (onChanged) await onChanged();
    });

  return html`<section class="card" aria-labelledby="commands-perm-orphans-title">
    <h2 class="card-title" id="commands-perm-orphans-title">${t("permissions.orphans_title")}</h2>
    <p class="muted">${t("permissions.orphans_hint")}</p>
    <ul class="stack-sm">
      ${rows.map(
        ({ command, reason, scopes }) => html`<li key=${command} class="stack-sm">
          <div class="row-wrap">
            <span class="mono">${command}</span>
            <span class="muted">${t(`permissions.orphan_${reason}`)}</span>
          </div>
          <ul class="row-wrap">
            ${scopes.map(
              ({ scope }) => html`<li key=${scope} class="chip">
                <span class="chip-text mono" title=${scope}>${scopeLabel(scope)}</span>
                <button type="button" class="icon-btn" disabled=${busy || removing} aria-label=${t("permissions.orphan_remove", { command, scope: scopeLabel(scope) })} onClick=${() => removeRule(command, scope)}><${Icon} name="trash" /></button>
              </li>`,
            )}
          </ul>
        </li>`,
      )}
    </ul>
  </section>`;
}
