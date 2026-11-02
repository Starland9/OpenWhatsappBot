// The rule editor of feature 003 (contracts/panel-ui.md section 5): one rule of one command in one scope, shared by the
// group "Permissions" tab (scope = a group JID) and the Commands page card (scope "*"). It owns the draft and knows no
// route: the parent makes the api() call, so the contract test that matches every literal path sees them in the parent.
import { html, useState, useEffect, useRef, useId, useUnsavedGuard, Icon, StatusBadge, fieldErrorText } from "../components/index.mjs";
import { t } from "../i18n.mjs";
import {
  GLOBAL_SCOPE,
  MODES,
  PEOPLE_MAX,
  canSave,
  computeWarnings,
  draftOf,
  isDirty,
  normalLevel,
  pendingCount,
  personBadges,
  personLabel,
  personKey,
  removePerson,
  ruleBody,
  setMode,
  togglePerson,
  addPerson,
  warningTextKey,
} from "./permissions-logic.mjs";

const MODE_OPTIONS = [MODES.EXTRA, MODES.ONLY];

/** The badges of one chip: "no longer in the group", the admin status, "not an admin" */
function PersonBadges({ person, adminCommand }) {
  return personBadges(person, { adminCommand }).map((badge) => {
    const label = badge.id === "admin" ? t(`groups.admin_${person.admin === "superadmin" ? "superadmin" : "admin"}`) : t(`permissions.badge_${badge.id}`);
    return html`<${StatusBadge} key=${badge.id} tone=${badge.tone} label=${label} />`;
  });
}

/**
 *   command   the merged command (needs `name` and `access`)
 *   scope     "*" (everywhere) or a group JID
 *   saved     the saved Rule, or null for a rule being created
 *   busy      the parent's useAction flag
 *   limits    { peopleMax }
 *   context   { disabled: null | "global" | "group", hasEverywhereOnly: boolean } (only decides some banners)
 *   intro     optional text under the scope line
 *   Picker    component rendered in the picker slot, with `pickerProps`, `selected`, `max`, `disabled`, `onToggle`, `onAdd`
 *   onSave(body, draft)  async; body = ruleBody(draft)      onDelete()  async, the parent asks for confirmation first
 *   onClose()
 * The parent gives the component a `key` that changes with the server state, so a saved change starts a fresh draft.
 */
export function RuleEditor({ command, scope, saved, busy = false, limits, context, intro, Picker, pickerProps, onSave, onDelete, onClose }) {
  const [draft, setDraft] = useState(() => draftOf(saved));
  const [error, setError] = useState(null);
  const heading = useRef(null);
  const current = useRef(draft); // the latest draft, so two quick clicks in one frame never work from a stale one
  current.current = draft;
  const uid = useId();
  const titleId = `permissions-editor-${uid}`;
  const max = (limits && limits.peopleMax) || PEOPLE_MAX;
  const adminCommand = Boolean(command.access && command.access.admin);
  const dirty = isDirty(saved, draft);
  const check = canSave(draft, saved, { scope });
  useUnsavedGuard(`permissions-${scope}-${command.name}`, dirty);

  useEffect(() => {
    const node = heading.current;
    if (node) {
      if (typeof node.focus === "function") node.focus();
      if (typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
    }
  }, [command.name, scope]);

  const update = (next) => {
    current.current = next;
    setDraft(next);
  };

  // A checkbox of the picker. A refusal (the cap) is shown here: a list of checkboxes has no field of its own.
  const onToggle = (person) => {
    const result = togglePerson(current.current, person, { max });
    if (!result.error) update(result.draft);
    setError(result.error);
    return { error: result.error };
  };

  // A typed number. The picker shows the refusal next to its input, so it is not repeated here.
  const onAdd = (person) => {
    const result = addPerson(current.current, person, { max });
    if (!result.error) update(result.draft);
    setError(null);
    return { error: result.error };
  };

  const remove = (person) => {
    setError(null);
    update(removePerson(current.current, person.jid));
  };

  const save = async () => {
    if (busy || !check.ok) return;
    await onSave(ruleBody(draft), draft);
  };

  const cancel = () => {
    update(draftOf(saved));
    setError(null);
    onClose();
  };

  const warnings = computeWarnings({
    command,
    draft,
    scope,
    disabled: (context && context.disabled) || null,
    hasEverywhereOnly: Boolean(context && context.hasEverywhereOnly),
  });
  const pending = pendingCount(saved, draft);

  return html`<section class="card stack" aria-labelledby=${titleId}>
    <h2 class="card-title" id=${titleId} tabIndex="-1" ref=${heading}>${t("permissions.editor_title", { name: command.name })}</h2>
    <p class="muted">
      ${scope === GLOBAL_SCOPE ? t("permissions.scope_everywhere_label") : t("permissions.scope_group_label")}
      ${" - "}${t("permissions.normal_level", { level: t(`commands.access_${normalLevel(command.access)}`) })}
    </p>
    ${intro ? html`<p class="muted">${intro}</p>` : null}

    <fieldset class="choice-group">
      <legend class="field-label">${t("permissions.mode_label")}</legend>
      ${MODE_OPTIONS.map(
        (mode) => html`<label key=${mode} class="choice">
          <input type="radio" name=${`${titleId}-mode`} value=${mode} checked=${draft.mode === mode} disabled=${busy} onChange=${() => update(setMode(current.current, mode))} />
          <span>${mode === MODES.ONLY ? t("permissions.mode_only") : t("permissions.mode_extra")}</span>
        </label>`,
      )}
      <p class="muted">${draft.mode === MODES.ONLY ? t("permissions.mode_only_hint") : t("permissions.mode_extra_hint")}</p>
    </fieldset>

    <div class="stack-sm">
      <div class="row-wrap">
        <h3 class="field-label">${t("permissions.people_title")}</h3>
        <span class="muted">${t("permissions.people_count", { count: draft.people.length })}</span>
      </div>
      ${draft.people.length === 0
        ? html`<p class="muted">${t("permissions.people_empty")}</p>`
        : html`<ul class="row-wrap" aria-label=${t("permissions.people_title")}>
            ${draft.people.map((person) => {
              const label = personLabel(person);
              return html`<li key=${personKey(person.jid)} class="chip" title=${person.jid}>
                <span class="chip-text mono">${label.name ? `${label.number} ${label.name}` : label.number}</span>
                <${PersonBadges} person=${person} adminCommand=${adminCommand} />
                <button type="button" class="icon-btn" disabled=${busy} aria-label=${t("permissions.remove_person", { person: label.number })} onClick=${() => remove(person)}><${Icon} name="close" /></button>
              </li>`;
            })}
          </ul>`}
      ${error ? html`<div class="field-error" role="alert">${fieldErrorText(error)}</div>` : null}
    </div>

    ${Picker
      ? html`<div class="stack-sm">
          <h3 class="field-label">${t("permissions.picker_title")}</h3>
          <${Picker} selected=${draft.people} max=${max} disabled=${busy} onToggle=${onToggle} onAdd=${onAdd} ...${pickerProps || {}} />
        </div>`
      : null}

    ${warnings.length
      ? html`<div class="stack-sm">
          ${warnings.map(
            (warning) => html`<div key=${warning.code} class=${`banner banner-${warning.tone === "info" ? "info" : "warn"}`} role="status">
              <${Icon} name=${warning.tone === "info" ? "info" : "warning"} />
              <div class="banner-body">${t(warningTextKey(warning), warning.params)}</div>
            </div>`,
          )}
        </div>`
      : null}

    <div class="actions">
      <button type="button" class="btn btn-primary" disabled=${busy || !check.ok} onClick=${save}>${t("common.save")}</button>
      <button type="button" class="btn" disabled=${busy} onClick=${cancel}>${t("common.cancel")}</button>
      ${saved ? html`<button type="button" class="btn btn-danger" disabled=${busy} onClick=${() => onDelete()}><${Icon} name="trash" />${t("permissions.delete_rule")}</button>` : null}
      <span class="muted" aria-live="polite">${dirty ? t("permissions.pending", { count: pending }) : ""}</span>
    </div>
    ${check.reason === "people_required" ? html`<p class="muted">${t("permissions.save_blocked")}</p>` : null}
  </section>`;
}
