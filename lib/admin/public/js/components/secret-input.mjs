import { html, useState, useId } from "./html.mjs";
import { t } from "../i18n.mjs";
import { Icon } from "./icon.mjs";
import { fieldErrorText } from "./field.mjs";

/**
 * Write-only secret control (FR-017). The server only ever sends `{ set, last4 }`, shown as
 * "set (...abcd)"; the input holds what the administrator is typing, never the stored value.
 *   secret    `{ set: boolean, last4: string | null }`
 *   draft     the new value being typed ("" = unchanged); onDraft(text)
 *   cleared   true when the administrator asked to remove the stored value; onClear() / onUndo()
 */
export function SecretInput({ label, name, secret, draft = "", onDraft = () => {}, cleared = false, onClear, onUndo, error, hint, disabled = false }) {
  const [reveal, setReveal] = useState(false);
  const uid = useId();
  const id = `s-${name || "x"}-${uid}`;
  const errorText = fieldErrorText(error);
  const isSet = Boolean(secret && secret.set);
  let state;
  if (cleared) state = html`<span class="badge badge-warn">${t("secret.will_clear")}</span>`;
  else if (isSet) state = html`<span class="badge badge-ok">${secret.last4 ? t("secret.set_last4", { last4: secret.last4 }) : t("secret.set")}</span>`;
  else state = html`<span class="badge">${t("secret.unset")}</span>`;
  const describedBy = [hint ? `${id}-hint` : "", errorText ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
  return html`<div class="field">
    <label class="field-label" for=${id}>${label}</label>
    <div class="secret-state">${state}
      ${isSet && !cleared && !draft && onClear ? html`<button type="button" class="btn btn-sm" disabled=${disabled} onClick=${onClear}>${t("secret.clear")}</button>` : null}
      ${cleared && onUndo ? html`<button type="button" class="btn btn-sm" onClick=${onUndo}>${t("common.undo")}</button>` : null}
    </div>
    <div class="input-group">
      <input class="input" id=${id} name=${name} type=${reveal ? "text" : "password"} value=${draft} autocomplete="new-password" spellcheck="false" autocapitalize="off" disabled=${disabled || cleared} placeholder=${isSet ? t("secret.replace_placeholder") : t("secret.placeholder")} aria-invalid=${errorText ? "true" : undefined} aria-describedby=${describedBy} onInput=${(event) => onDraft(event.currentTarget.value)} />
      <button type="button" class="icon-btn" aria-pressed=${reveal ? "true" : "false"} aria-label=${reveal ? t("secret.hide") : t("secret.show")} onClick=${() => setReveal(!reveal)}><${Icon} name=${reveal ? "eye-off" : "eye"} /></button>
    </div>
    ${hint ? html`<div class="field-hint" id=${`${id}-hint`}>${hint}</div>` : null}
    ${errorText ? html`<div class="field-error" id=${`${id}-err`} role="alert">${errorText}</div>` : null}
  </div>`;
}
