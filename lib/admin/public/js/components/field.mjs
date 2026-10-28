import { html, useId } from "./html.mjs";
import { t, tField } from "../i18n.mjs";
import { Icon } from "./icon.mjs";

/** Text of a field error: a string as is, `{ code, params }` (an ApiError `fields` entry) through `fields.<code>`. */
export function fieldErrorText(error) {
  if (!error) return "";
  return typeof error === "string" ? error : tField(error);
}

function optionList(options) {
  return (options || []).map((option) => (typeof option === "object" && option !== null ? option : { value: option, label: String(option) }));
}

/** Repeatable text inputs for a list of strings (owners, keywords...). Empty rows are kept; filter on save. */
function ListControl({ id, value, onChange, disabled, placeholder, addLabel, inputMode }) {
  const items = Array.isArray(value) ? value : [];
  const set = (index, text) => onChange(items.map((item, i) => (i === index ? text : item)));
  return html`<div class="list-control" id=${id}>
    ${items.map(
      (item, index) => html`<div class="list-row" key=${index}>
        <input class="input" type="text" value=${item} disabled=${disabled} placeholder=${placeholder} inputmode=${inputMode} autocomplete="off" aria-label=${`${index + 1}`} onInput=${(event) => set(index, event.currentTarget.value)} />
        <button type="button" class="icon-btn" disabled=${disabled} aria-label=${t("common.remove")} onClick=${() => onChange(items.filter((_, i) => i !== index))}><${Icon} name="trash" /></button>
      </div>`,
    )}
    <div><button type="button" class="btn btn-sm" disabled=${disabled} onClick=${() => onChange([...items, ""])}><${Icon} name="plus" />${addLabel ?? t("common.add")}</button></div>
  </div>`;
}

/**
 * One labelled form control with its hint and the per-field error from the API `fields` map.
 *   type: "text" | "url" | "password" | "textarea" | "int" | "bool" | "enum" | "list"
 *   value / onChange(value): text -> string, int -> number or null, bool -> boolean, enum -> the option value,
 *   list -> array of strings.
 *   enum `options`: [{ value, label }] or plain strings. `error`: string or { code, params }.
 */
export function Field({
  label,
  name,
  type = "text",
  value,
  onChange = () => {},
  error,
  hint,
  required = false,
  disabled = false,
  readOnly = false,
  placeholder,
  options,
  min,
  max,
  step,
  unit,
  maxLength,
  inputMode,
  rows,
  autoComplete,
  addLabel,
  children,
}) {
  const uid = useId();
  const id = `f-${name || "x"}-${uid}`;
  const errorText = fieldErrorText(error);
  const describedBy = [hint ? `${id}-hint` : "", errorText ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
  const aria = { "aria-invalid": errorText ? "true" : undefined, "aria-describedby": describedBy, "aria-required": required ? "true" : undefined };

  let control;
  if (type === "bool") {
    control = html`<label class="switch"><input type="checkbox" role="switch" id=${id} name=${name} checked=${Boolean(value)} disabled=${disabled || readOnly} ...${aria} onChange=${(event) => onChange(event.currentTarget.checked)} /><span class="field-label">${label}</span></label>`;
  } else if (type === "enum") {
    const list = optionList(options);
    control = html`<select class="select" id=${id} name=${name} disabled=${disabled || readOnly} ...${aria} onChange=${(event) => {
      const picked = list.find((o) => String(o.value) === event.currentTarget.value);
      onChange(picked ? picked.value : event.currentTarget.value);
    }}>${list.map((o) => html`<option key=${String(o.value)} value=${String(o.value)} selected=${String(o.value) === String(value)}>${o.label}</option>`)}</select>`;
  } else if (type === "list") {
    control = html`<${ListControl} id=${id} value=${value} onChange=${onChange} disabled=${disabled || readOnly} placeholder=${placeholder} addLabel=${addLabel} inputMode=${inputMode} />`;
  } else if (type === "textarea") {
    control = html`<textarea class="textarea" id=${id} name=${name} rows=${rows ?? 4} value=${value ?? ""} maxlength=${maxLength} placeholder=${placeholder} disabled=${disabled} readonly=${readOnly} ...${aria} onInput=${(event) => onChange(event.currentTarget.value)}></textarea>`;
  } else if (type === "int") {
    control = html`<div class="input-group"><input class="input" type="number" inputmode="numeric" id=${id} name=${name} value=${value ?? ""} min=${min} max=${max} step=${step ?? 1} placeholder=${placeholder} disabled=${disabled} readonly=${readOnly} ...${aria} onInput=${(event) => {
      const raw = event.currentTarget.value;
      onChange(raw === "" ? null : Number(raw));
    }} />${unit ? html`<span class="input-unit">${unit}</span>` : null}</div>`;
  } else {
    const inputType = type === "url" || type === "password" ? type : "text";
    control = html`<input class="input" type=${inputType} id=${id} name=${name} value=${value ?? ""} maxlength=${maxLength} placeholder=${placeholder} inputmode=${inputMode ?? (type === "url" ? "url" : undefined)} autocomplete=${autoComplete ?? (type === "password" ? "off" : undefined)} disabled=${disabled} readonly=${readOnly} ...${aria} onInput=${(event) => onChange(event.currentTarget.value)} />`;
  }

  return html`<div class="field">
    ${type === "bool" ? null : html`<label class="field-label" for=${id}>${label}${required ? html`<span class="field-required" aria-hidden="true"> *</span>` : null}</label>`}
    ${control}
    ${hint ? html`<div class="field-hint" id=${`${id}-hint`}>${hint}</div>` : null}
    ${errorText ? html`<div class="field-error" id=${`${id}-err`} role="alert">${errorText}</div>` : null}
    ${children}
  </div>`;
}
