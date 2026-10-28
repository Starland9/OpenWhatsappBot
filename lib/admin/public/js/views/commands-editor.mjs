// Scope editor of one command (CMD-2): the global switch and the list of groups where it is off.
import { html, useState, useEffect, useRef, useUnsavedGuard, Field, Icon } from "../components/index.mjs";
import { t } from "../i18n.mjs";
import { addGroup, removeGroup, setGlobal, draftOf, diffScopes, isDirty, shortJid } from "./commands-logic.mjs";

/**
 * Edits `command.disabledGlobal` and `command.disabledGroups`. Nothing is sent until "Save":
 *   onSave(draft) -> Promise (the parent builds the CMD-2 body with diffScopes and shows the warnings)
 *   onClose()
 * The parent gives the component a `key` that changes with the server state, so a saved change starts a
 * fresh draft.
 */
export function ScopeEditor({ command, busy, onSave, onClose }) {
  const [draft, setDraft] = useState(() => draftOf(command));
  const [input, setInput] = useState("");
  const [error, setError] = useState(null);
  const heading = useRef(null);
  const dirty = isDirty(command, draft);
  useUnsavedGuard(`commands-${command.name}`, dirty);

  useEffect(() => {
    if (heading.current) {
      heading.current.focus();
      if (typeof heading.current.scrollIntoView === "function") heading.current.scrollIntoView({ block: "nearest" });
    }
  }, [command.name]);

  const add = (event) => {
    event.preventDefault();
    const result = addGroup(draft, input);
    if (result.error) {
      setError(result.error);
      return;
    }
    setDraft(result.draft);
    setInput("");
    setError(null);
  };

  const change = diffScopes(command, draft);

  return html`<section class="card" aria-labelledby="commands-editor-title">
    <h2 class="card-title" id="commands-editor-title" tabIndex="-1" ref=${heading}>${t("commands.editor_title", { name: command.name })}</h2>
    <div class="stack">
      <${Field}
        type="bool"
        name="commands-global"
        label=${t("commands.editor_enabled_everywhere")}
        hint=${t("commands.editor_global_hint")}
        value=${!draft.global}
        onChange=${(enabled) => setDraft(setGlobal(draft, !enabled))}
        disabled=${busy}
      />

      <div class="stack-sm">
        <h3 class="field-label">${t("commands.editor_groups")}</h3>
        <p class="muted">${t(draft.global ? "commands.editor_groups_ignored" : "commands.editor_groups_hint")}</p>
        ${draft.groups.length === 0
          ? html`<p class="muted">${t("commands.editor_no_groups")}</p>`
          : html`<ul class="stack-sm" aria-label=${t("commands.editor_groups")}>
              ${draft.groups.map(
                (jid) => html`<li key=${jid} class="row">
                  <span class="chip grow"><span class="chip-text mono" title=${jid}>${shortJid(jid)}</span></span>
                  <button type="button" class="icon-btn" disabled=${busy} aria-label=${t("commands.editor_remove_group", { group: shortJid(jid) })} onClick=${() => setDraft(removeGroup(draft, jid))}><${Icon} name="trash" /></button>
                </li>`,
              )}
            </ul>`}
        <form class="row-wrap" onSubmit=${add} noValidate>
          <div class="grow">
            <${Field}
              name="commands-group"
              label=${t("commands.editor_add_label")}
              value=${input}
              onChange=${(value) => {
                setInput(value);
                setError(null);
              }}
              error=${error}
              placeholder="120363000000000000@g.us"
              hint=${t("commands.editor_add_hint")}
              disabled=${busy}
            />
          </div>
          <div><button type="submit" class="btn" disabled=${busy || !input.trim()}><${Icon} name="plus" />${t("common.add")}</button></div>
        </form>
      </div>

      <div class="actions">
        <button type="button" class="btn btn-primary" disabled=${busy || !dirty} onClick=${() => onSave(change)}>${t("common.save")}</button>
        <button type="button" class="btn" disabled=${busy} onClick=${onClose}>${t("common.close")}</button>
        ${dirty ? html`<span class="muted">${t("commands.editor_pending", { count: change.disable.length + change.enable.length })}</span>` : null}
      </div>
    </div>
  </section>`;
}
