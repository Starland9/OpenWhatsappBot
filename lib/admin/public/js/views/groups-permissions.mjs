// The "Permissions" tab of one group (feature 003, contracts/panel-ui.md section 7): who may use which command here
// (PERM-5, PERM-6, PERM-7), next to the commands list (CMD-1) and the delegation flags (PERM-1) that PERM-5 does not carry.
// The rule editor and the member picker are the shared pieces of permissions-*.mjs; this file only decides what to
// load, what to list, and which request a button sends.
import { html, useState, useAsync, useAction, useId, DataTable, EmptyState, Icon, Spinner, StatusBadge } from "../components/index.mjs";
import { t, tError } from "../i18n.mjs";
import { api } from "../api.mjs";
import { confirm, toastSuccess } from "../ui.mjs";
import { buildHash } from "../router.mjs";
import { commandState, shortJid } from "./groups-logic.mjs";
import {
  MODES,
  commandPanelTarget,
  everywhereRows,
  lockReasonKey,
  mergePermissions,
  normalizeWarnings,
  peopleSummary,
  personBadges,
  personKey,
  personLabel,
  splitCommands,
  warningBadges,
} from "./permissions-logic.mjs";
import { RuleEditor } from "./permissions-editor.mjs";
import { GroupMemberPicker } from "./permissions-members.mjs";

const permissionsPath = (jid) => `/admin/api/groups/${encodeURIComponent(jid)}/permissions`;

/** `permissions.mode_extra`, `mode_only`, or `mode_normal` for "no rule" */
const modeLabel = (mode) => t(mode === MODES.ONLY ? "permissions.mode_only" : mode === MODES.EXTRA ? "permissions.mode_extra" : "permissions.mode_normal");

/** The badges of one chip: "no longer in the group", the admin status, "not an admin" (the editor's chips read the same) */
function PersonBadges({ person, adminCommand }) {
  return personBadges(person, { adminCommand }).map((badge) => {
    const label = badge.id === "admin" ? t(`groups.admin_${person.admin === "superadmin" ? "superadmin" : "admin"}`) : t(`permissions.badge_${badge.id}`);
    return html`<${StatusBadge} key=${badge.id} tone=${badge.tone} label=${label} />`;
  });
}

/**
 * The people of a rule as chips. `preview` cuts the list to the first chips and a "+N more"; `badges` adds the group
 * annotations (the "allowed everywhere" card shows plain chips: those people have access wherever they are).
 */
function PeopleChips({ people, adminCommand = false, preview = true, badges = true }) {
  const list = Array.isArray(people) ? people : [];
  if (list.length === 0) return html`<span class="muted">-</span>`;
  const { shown, more } = preview ? peopleSummary(list) : { shown: list, more: 0 };
  return html`<ul class="row-wrap" aria-label=${t("permissions.people_title")}>
    ${shown.map((person) => {
      const label = personLabel(person);
      return html`<li key=${personKey(person.jid)} class="chip" title=${person.jid}>
        <span class="chip-text mono">${label.name ? `${label.number} ${label.name}` : label.number}</span>
        ${badges ? html`<${PersonBadges} person=${person} adminCommand=${adminCommand} />` : null}
      </li>`;
    })}
    ${more > 0 ? html`<li key="more" class="muted">${t("permissions.people_more", { count: more })}</li>` : null}
  </ul>`;
}

/** The select of the new-rule card: delegable commands without a rule, then the locked ones (disabled, with their reason) */
function CommandSelect({ id, delegable, locked, value, onChange }) {
  return html`<select id=${id} class="select" value=${value} onChange=${(event) => onChange(event.currentTarget.value)}>
    <option value="">${t("permissions.new_command_placeholder")}</option>
    ${delegable.length
      ? html`<optgroup label=${t("permissions.optgroup_delegable")}>
          ${delegable.map((command) => html`<option key=${command.name} value=${command.name}>${command.name}</option>`)}
        </optgroup>`
      : null}
    ${locked.length
      ? html`<optgroup label=${t("permissions.optgroup_locked")}>
          ${locked.map(
            (command) => html`<option key=${command.name} value=${command.name} disabled>${t("permissions.locked_option", { name: command.name, reason: t(lockReasonKey(command.perm.lockReason)) })}</option>`,
          )}
        </optgroup>`
      : null}
  </select>`;
}

/** Start a rule: choose a delegable command, then "Create the rule" opens the editor on it */
function NewRuleCard({ delegable, locked, onCreate }) {
  const [choice, setChoice] = useState("");
  const selectId = `permissions-new-command-${useId()}`;
  // a locked name (or any name that is not on offer) never enables the button
  const pick = (name) => setChoice(delegable.some((command) => command.name === name) ? name : "");
  return html`<section class="card stack">
    <h2 class="card-title">${t("permissions.group_title")}</h2>
    <p class="muted">${t("permissions.group_intro")}</p>
    <div class="field">
      <label class="field-label" for=${selectId}>${t("permissions.new_command_label")}</label>
      <div class="row-wrap">
        <${CommandSelect} id=${selectId} delegable=${delegable} locked=${locked} value=${choice} onChange=${pick} />
        <button
          type="button"
          class="btn"
          disabled=${!choice}
          onClick=${() => {
            onCreate(choice);
            setChoice("");
          }}
        >${t("permissions.new_create")}</button>
      </div>
    </div>
  </section>`;
}

/** The rules of this group, one row per command */
function RulesCard({ rules, commands, busy, onEdit }) {
  const byName = new Map(commands.map((command) => [command.name, command]));
  const isAdminCommand = (name) => Boolean(byName.has(name) && byName.get(name).access && byName.get(name).access.admin);
  const columns = [
    { key: "command", label: t("groups.col_command"), render: (rule) => html`<span class="mono"><strong>${rule.command}</strong></span>` },
    {
      key: "mode",
      label: t("permissions.mode_label"),
      render: (rule) => {
        const badges = warningBadges(normalizeWarnings(rule.warnings));
        return html`<div class="stack-sm">
          <span>${modeLabel(rule.mode)}</span>
          <span class="muted">${t("permissions.people_count", { count: rule.people.length })}</span>
          ${badges.length ? html`<div class="row-wrap">${badges.map((badge) => html`<${StatusBadge} key=${badge.code} tone=${badge.tone} label=${t(badge.key)} />`)}</div>` : null}
        </div>`;
      },
    },
    {
      key: "people",
      label: t("permissions.people_title"),
      render: (rule) => html`<${PeopleChips} people=${rule.people} adminCommand=${isAdminCommand(rule.command)} />`,
    },
    {
      key: "actions",
      label: t("commands.col_actions"),
      render: (rule) => html`<div class="cell-actions">
        <button type="button" class="btn btn-sm" disabled=${busy} aria-label=${t("permissions.edit_rule", { name: rule.command })} onClick=${() => onEdit(rule.command)}>${t("common.edit")}</button>
      </div>`,
    },
  ];
  return html`<section class="card stack">
    <h2 class="card-title">${t("permissions.rules_title")}</h2>
    <${DataTable}
      columns=${columns}
      rows=${rules}
      rowKey="command"
      caption=${t("permissions.rules_title")}
      empty=${html`<${EmptyState} icon="info" title=${t("permissions.rules_empty")} message=${t("permissions.rules_empty_hint")} />`}
    />
  </section>`;
}

/** The "everywhere" rules, read-only: the mode that applies in this group, who has access, and the way to edit them */
function EverywhereCard({ rows }) {
  return html`<section class="card stack">
    <h2 class="card-title">${t("permissions.everywhere_title")}</h2>
    <p class="muted">${t("permissions.everywhere_intro")}</p>
    ${rows.length === 0
      ? html`<p class="muted">${t("permissions.everywhere_empty")}</p>`
      : html`<ul class="stack-sm">
          ${rows.map(({ command, rule, effective }) => {
            const target = commandPanelTarget(command.name);
            return html`<li key=${command.name} class="stack-sm">
              <div class="row-wrap">
                <span class="mono"><strong>${command.name}</strong></span>
                <span>${t(effective.source === "group" ? "permissions.mode_here_group" : "permissions.mode_here", { mode: modeLabel(effective.mode) })}</span>
              </div>
              ${rule.mode === MODES.ONLY && rule.people.length === 0
                ? html`<span class="muted">${t("permissions.only_owner")}</span>`
                : html`<${PeopleChips} people=${rule.people} preview=${false} badges=${false} />`}
              <div><a class="btn btn-sm" href=${buildHash(target.name, target.rest, target.query)}>${t("permissions.everywhere_edit", { name: command.name })}</a></div>
            </li>`;
          })}
        </ul>`}
  </section>`;
}

/** Rows of this group whose command is no longer loaded or no longer delegable: they do nothing, so they can go */
function OrphansCard({ orphans, scope, busy, onRemove }) {
  const sorted = [...orphans].sort((a, b) => (a.command < b.command ? -1 : a.command > b.command ? 1 : 0));
  return html`<section class="card stack" aria-labelledby="permissions-orphans-title">
    <h2 class="card-title" id="permissions-orphans-title">${t("permissions.orphans_title")}</h2>
    <p class="muted">${t("permissions.orphans_hint")}</p>
    <ul class="stack-sm">
      ${sorted.map(
        (orphan) => html`<li key=${orphan.command} class="row-wrap">
          <span class="mono"><strong>${orphan.command}</strong></span>
          <span class="muted">${t(`permissions.orphan_${orphan.reason === "not_delegable" ? "not_delegable" : "unknown_command"}`)}</span>
          <button type="button" class="icon-btn" disabled=${busy} aria-label=${t("permissions.orphan_remove", { command: orphan.command, scope })} onClick=${() => onRemove(orphan.command)}><${Icon} name="trash" /></button>
        </li>`,
      )}
    </ul>
  </section>`;
}

/** `PermissionsTab({ group, onGroup, reload })`: `reload` refreshes the group (GRP-3), which carries the tab badge */
export function PermissionsTab({ group, reload }) {
  const base = permissionsPath(group.jid);
  const { data, error, loading, reload: reloadData } = useAsync(async () => {
    const [rules, list, items] = await Promise.all([api("GET", base), api("GET", "/admin/api/commands"), api("GET", "/admin/api/permissions")]);
    return { ...rules, commands: mergePermissions(list.commands, items.items) };
  }, [group.jid]);
  const [busy, run] = useAction();
  const [editing, setEditing] = useState(null); // { name } | null
  const [version, setVersion] = useState(0); // bumped after each saved change, so the editor starts a fresh draft

  if (loading && !data) return html`<${Spinner} />`;
  if (error && !data) {
    return html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}>
      <button type="button" class="btn" onClick=${reloadData}><${Icon} name="refresh" />${t("common.retry")}</button>
    <//>`;
  }

  const { rules, commands } = data;
  const { delegable, locked } = splitCommands(commands, rules.map((rule) => rule.command));
  const refresh = () => Promise.all([reloadData(), reload()]);

  const save = (name, body) =>
    run(async () => {
      await api("PUT", `${base}/${encodeURIComponent(name)}`, body);
      toastSuccess(t("permissions.saved", { name }));
      await refresh();
      setVersion((n) => n + 1); // after the reload: the editor remounts on the rule the server now holds
    });

  const remove = (name) =>
    run(async () => {
      const ok = await confirm({ title: t("permissions.delete_title", { name }), message: t("permissions.delete_message_group"), confirmLabel: t("permissions.delete_rule") });
      if (!ok) return;
      await api("DELETE", `${base}/${encodeURIComponent(name)}`);
      toastSuccess(t("permissions.deleted", { name }));
      setEditing(null);
      await refresh();
    });

  const removeOrphan = (name) =>
    run(async () => {
      await api("DELETE", `${base}/${encodeURIComponent(name)}`); // no dialog: the row does nothing
      toastSuccess(t("permissions.orphan_removed", { command: name }));
      await refresh();
    });

  const command = editing ? commands.find((entry) => entry.name === editing.name) : null;
  const saved = editing ? rules.find((rule) => rule.command === editing.name) || null : null;
  const state = command ? commandState(command, group.jid, group.disabledCommands || []) : "on";

  return html`<div class="stack">
    <${NewRuleCard} delegable=${delegable} locked=${locked} onCreate=${(name) => setEditing({ name })} />
    <${RulesCard} rules=${rules} commands=${commands} busy=${busy} onEdit=${(name) => setEditing({ name })} />
    ${command
      ? html`<${RuleEditor}
          key=${`${group.jid}:${command.name}:${version}`}
          command=${command}
          scope=${group.jid}
          saved=${saved}
          busy=${busy}
          limits=${data.limits}
          context=${{ disabled: state === "on" ? null : state, hasEverywhereOnly: data.everywhere.some((rule) => rule.command === command.name && rule.mode === MODES.ONLY) }}
          Picker=${GroupMemberPicker}
          pickerProps=${{ jid: group.jid, available: Boolean(data.members && data.members.available) }}
          onSave=${(body) => save(command.name, body)}
          onDelete=${() => remove(command.name)}
          onClose=${() => setEditing(null)}
        />`
      : null}
    <${EverywhereCard} rows=${everywhereRows(data.everywhere, rules, commands)} />
    ${data.orphans && data.orphans.length ? html`<${OrphansCard} orphans=${data.orphans} scope=${group.name || shortJid(group.jid)} busy=${busy} onRemove=${removeOrphan} />` : null}
  </div>`;
}
