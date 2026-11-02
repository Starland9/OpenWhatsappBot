// The rights checklist (feature 004, contracts/panel-ui.md 7.5.1): built only from the catalogue, grouped, deny by default.
// A stored right the catalogue no longer knows is an orphan chip whose only action is Remove.
import { html, Icon } from "../components/index.mjs";
import { t, hasKey } from "../i18n.mjs";
import { rightKeys, rightsGroups } from "./api-logic.mjs";
import { errorText } from "./api-ips.mjs";

/** The label of a right: its text when the catalogs have one, else the raw id in `span.mono`. */
export function rightLabel(id) {
  const key = rightKeys(id).label;
  return hasKey(key) ? t(key) : html`<span class="mono">${id}</span>`;
}

const groupLabel = (group) => (hasKey(`api.right_group.${group}`) ? t(`api.right_group.${group}`) : t("api.right_group_other"));

/** `RightsChecklist({ rights, selected, orphans, disabled, error, needRecipients, onToggle, onGroup, onRemoveOrphan })` */
export function RightsChecklist({ rights, selected, orphans, disabled = false, error, needRecipients = false, onToggle, onGroup, onRemoveOrphan }) {
  const groups = rightsGroups(rights, selected);
  return html`<div class="stack">
    <p class="muted">${t("api.rights_hint")}</p>
    ${groups.map((group) => {
      const name = groupLabel(group.group);
      return html`<fieldset class="choice-group" key=${group.group}>
        <legend>${name}</legend>
        <div class="row-wrap">
          <button type="button" class="btn btn-sm" disabled=${disabled || group.allChecked} onClick=${() => onGroup(group.group, true)}>${t("api.rights_all", { group: name })}</button>
          <button type="button" class="btn btn-sm" disabled=${disabled || group.noneChecked} onClick=${() => onGroup(group.group, false)}>${t("api.rights_none", { group: name })}</button>
        </div>
        ${group.items.map((item) => {
          const keys = rightKeys(item.id);
          return html`<label class="choice" key=${item.id}>
            <input type="checkbox" name=${item.id} checked=${item.checked} disabled=${disabled} onChange=${() => onToggle(item.id)} />
            <span>${rightLabel(item.id)}${hasKey(keys.desc) ? html` <span class="muted">${t(keys.desc)}</span>` : null}</span>
          </label>`;
        })}
      </fieldset>`;
    })}
    ${orphans.length
      ? html`<ul class="row-wrap">
          ${orphans.map(
            (id) => html`<li class="chip" key=${id}>
              <span class="chip-text mono">${t("api.rights_orphan", { id })}</span>
              ${disabled ? null : html`<button type="button" class="icon-btn" aria-label=${t("api.rights_orphan_remove", { id })} onClick=${() => onRemoveOrphan(id)}><${Icon} name="close" /></button>`}
            </li>`,
          )}
        </ul>`
      : null}
    ${needRecipients ? html`<p class="field-hint" role="status">${t("api.rights_need_recipients")}</p>` : null}
    ${error ? html`<div class="field-error" role="alert">${errorText(error)}</div>` : null}
  </div>`;
}
