// The generic descriptor renderer of the Test tab (feature 004, contracts/panel-ui.md 7.10 and 5): a format descriptor of
// the catalogue becomes a form made of the existing controls. Nothing here names a format (SC-009): a new format module
// appears in the Test tab with no edit. `values` and the paths are those of api-form-logic.mjs; `errors` maps a dotted
// path to a `{ code, params }`. The browser objects a test cannot supply come in through `deps = { upload, removeUpload }`.
import { html, Field, Icon } from "../components/index.mjs";
import { t, hasKey, formatBytes } from "../i18n.mjs";
import { api, upload } from "../api.mjs";
import { errorText } from "./api-ips.mjs";
import { GroupPicker } from "./api-recipients.mjs";
import { addRow, getPath, pathKey, removeRow, rowBounds, setPath } from "./api-form-logic.mjs";

/** Best effort: an upload that is removed, replaced or abandoned is deleted; a failure changes nothing for the owner. */
export function removeUpload(id) {
  return Promise.resolve(api("DELETE", `/admin/api/uploads/${encodeURIComponent(id)}`)).catch(() => {});
}

const text = (key, fallback) => (key && hasKey(key) ? t(key) : fallback);
const errorOf = (errors, parts) => {
  const error = errors && errors[pathKey(parts)];
  return error ? errorText(error) : null;
};

/** The recipient: a number with its country code, or one group of the picker. */
export function RecipientField({ field, value, error, onChange, disabled }) {
  const to = value && typeof value === "object" ? value : { kind: "number", number: "", group: null };
  const group = to.group ? (typeof to.group === "string" ? { jid: to.group, name: null } : to.group) : null;
  return html`<fieldset class="choice-group">
    <legend>${text(field.labelKey, field.name)}${field.required ? " *" : ""}</legend>
    <label class="choice"><input type="radio" name="api-test-to-kind" checked=${to.kind !== "group"} disabled=${disabled} onChange=${() => onChange({ ...to, kind: "number" })} /><span>${t("api.test_to_number")}</span></label>
    <label class="choice"><input type="radio" name="api-test-to-kind" checked=${to.kind === "group"} disabled=${disabled} onChange=${() => onChange({ ...to, kind: "group" })} /><span>${t("api.test_to_group")}</span></label>
    ${to.kind === "group"
      ? html`<${GroupPicker} selected=${group ? [group] : []} max=${1} single disabled=${disabled} onToggle=${(entry) => onChange({ ...to, kind: "group", group: entry })} />`
      : html`<${Field} name="api-test-to-number" label=${t("api.test_to_number")} hint=${t("api.test_to_hint")} inputMode="tel" value=${to.number} disabled=${disabled} onChange=${(number) => onChange({ ...to, kind: "number", number })} />`}
    ${error ? html`<div class="field-error" role="alert">${error}</div>` : null}
  </fieldset>`;
}

/** One control for one field, recursive through the rows of a list. `parts` is the dotted path as an array. */
function FieldControl({ field, parts, values, errors, onChange, disabled, deps }) {
  const value = getPath(values, parts);
  const error = errorOf(errors, parts);
  const label = text(field.labelKey, field.name);
  const hint = field.hintKey && hasKey(field.hintKey) ? t(field.hintKey) : undefined;
  const placeholder = field.placeholderKey && hasKey(field.placeholderKey) ? t(field.placeholderKey) : undefined;
  const set = (next) => onChange(setPath(values, parts, next));
  const name = `api-${parts.join("-")}`;
  const common = { name, label, hint, placeholder, error, disabled, required: Boolean(field.required) };

  switch (field.type) {
    case "recipient":
      return html`<${RecipientField} field=${field} value=${value} error=${error} onChange=${set} disabled=${disabled} />`;
    case "list":
      return html`<${RepeatedItems} field=${field} parts=${parts} values=${values} errors=${errors} onChange=${onChange} disabled=${disabled} deps=${deps} />`;
    case "boolean":
      return html`<${Field} ...${common} type="bool" value=${Boolean(value)} onChange=${set} />`;
    case "select":
      return html`<${Field} ...${common} type="enum" value=${value} options=${(field.options || []).map((option) => ({ value: option.value, label: text(option.labelKey, String(option.value)) }))} onChange=${set} />`;
    case "textarea":
      return html`<${Field} ...${common} type="textarea" value=${value} maxLength=${field.max} onChange=${set} />`;
    case "number":
      // a decimal keypad has no minus sign: signed values (latitude, longitude) use the plain text keyboard
      return html`<${Field} ...${common} value=${value} inputMode=${field.signed ? undefined : "decimal"} onChange=${set} />`;
    case "phone":
      return html`<${Field} ...${common} value=${value} inputMode="tel" onChange=${set} />`;
    case "url":
      return html`<${Field} ...${common} type="url" value=${value} maxLength=${field.max} onChange=${set} />`;
    default:
      return html`<${Field} ...${common} value=${value} maxLength=${field.max} onChange=${set} />`;
  }
}

/** `RepeatedItems`: one fieldset per row, stable row keys, Add and Remove bounded by the descriptor. */
export function RepeatedItems({ field, parts, values, errors, onChange, disabled, deps }) {
  const rows = getPath(values, parts) || [];
  const { min, max } = rowBounds(field);
  const label = text(field.labelKey, field.name);
  const listError = errorOf(errors, parts);
  const nested = field.items && Array.isArray(field.items.fields) ? field.items.fields : null;
  const hint = field.hintKey && hasKey(field.hintKey) ? t(field.hintKey) : null;
  return html`<div class="stack-sm" data-list=${pathKey(parts)}>
    <span class="field-label">${label}${field.required ? html`<span class="field-required" aria-hidden="true"> *</span>` : null}</span>
    ${hint ? html`<span class="field-hint">${hint}</span>` : null}
    ${rows.map((row, index) => {
      const rowParts = [...parts, String(index)];
      return html`<fieldset class="choice-group" key=${row._k}>
        <legend>${t("api.form_list_row", { label, n: index + 1 })}</legend>
        ${nested
          ? nested.map((child) => html`<${FieldControl} key=${child.name} field=${child} parts=${[...rowParts, child.name]} values=${values} errors=${errors} onChange=${onChange} disabled=${disabled} deps=${deps} />`)
          : html`<${FieldControl} field=${{ ...(field.item || { type: "text" }), name: `${field.name}`, labelKey: field.labelKey, required: true }} parts=${rowParts} values=${values} errors=${errors} onChange=${onChange} disabled=${disabled} deps=${deps} />`}
        <div><button type="button" class="btn btn-sm" data-remove=${pathKey(rowParts)} disabled=${disabled || rows.length <= min} onClick=${() => onChange(removeRow(values, parts, index, field))}><${Icon} name="trash" />${t("api.form_list_remove")}</button></div>
      </fieldset>`;
    })}
    <div><button type="button" class="btn btn-sm" data-add=${pathKey(parts)} disabled=${disabled || rows.length >= max} onClick=${() => onChange(addRow(values, parts, field))}><${Icon} name="plus" />${t("api.form_list_add")}</button></div>
    ${listError ? html`<div class="field-error" role="alert">${listError}</div>` : null}
  </div>`;
}

/**
 * The media of a format: a file uploaded through UP-1 `purpose=api` (size pre-check only: the server judges the type from
 * the bytes) or a public address. `value` = `{ source, file: { uploadId, name, kind, size } | null, url, progress, sizeError }`;
 * `onChange` takes the next value or an updater function.
 */
export function MediaField({ media, value, onChange, disabled, error, deps = {} }) {
  const send = deps.upload || upload;
  const drop = deps.removeUpload || removeUpload;
  const both = media.sources.includes("file") && media.sources.includes("url");
  const source = both ? value.source : media.sources[0];

  const choose = async (event) => {
    const input = event.currentTarget;
    const file = input && input.files && input.files[0];
    if (!file) return;
    if (media.maxBytes && file.size > media.maxBytes) {
      onChange((current) => ({ ...current, sizeError: t("api.media_too_large", { max: formatBytes(media.maxBytes) }) }));
      return;
    }
    if (value.file) drop(value.file.uploadId);
    onChange((current) => ({ ...current, file: null, sizeError: null, progress: 0 }));
    try {
      const answer = await send(file, "api", file.name, (progress) => onChange((current) => ({ ...current, progress: progress.ratio })));
      onChange((current) => ({ ...current, file: { uploadId: answer.uploadId, name: answer.name || file.name, kind: answer.kind, size: answer.size }, progress: null }));
    } catch {
      onChange((current) => ({ ...current, file: null, progress: null, sizeError: null, failed: true }));
    }
  };
  const remove = () => {
    if (value.file) drop(value.file.uploadId);
    onChange((current) => ({ ...current, file: null, sizeError: null, progress: null, failed: false }));
  };

  return html`<div class="stack-sm">
    ${both
      ? html`<fieldset class="choice-group">
          <label class="choice"><input type="radio" name="api-media-source" checked=${source === "file"} disabled=${disabled} onChange=${() => onChange((current) => ({ ...current, source: "file" }))} /><span>${t("api.media_source_file")}</span></label>
          <label class="choice"><input type="radio" name="api-media-source" checked=${source === "url"} disabled=${disabled} onChange=${() => onChange((current) => ({ ...current, source: "url" }))} /><span>${t("api.media_source_url")}</span></label>
        </fieldset>`
      : null}
    ${source === "url"
      ? html`<${Field} type="url" name="api-media-url" label=${t("api.media_url_label")} value=${value.url} disabled=${disabled} onChange=${(url) => onChange((current) => ({ ...current, url }))} />`
      : html`<div class="field">
          <label class="field-label" for="api-media-file">${t("api.media_file_label")}</label>
          <input class="input" id="api-media-file" type="file" accept=${(media.accept || []).join(",")} disabled=${disabled || value.progress !== null} onChange=${choose} />
          ${value.progress !== null && value.progress !== undefined ? html`<progress max="1" value=${value.progress} aria-label=${t("api.media_uploading")}></progress><span class="muted">${t("api.media_uploading")}</span>` : null}
          ${value.file
            ? html`<div class="row-wrap"><span class="mono">${value.file.name}</span><span class="muted">${formatBytes(value.file.size)}</span><button type="button" class="btn btn-sm" disabled=${disabled} onClick=${remove}><${Icon} name="trash" />${t("api.media_remove")}</button></div>`
            : html`<p class="muted">${t("api.media_none")}</p>`}
        </div>`}
    ${value.sizeError ? html`<div class="field-error" role="alert">${value.sizeError}</div>` : null}
    ${error ? html`<div class="field-error" role="alert">${error}</div>` : null}
  </div>`;
}

/** `DescriptorForm({ descriptor, values, errors, onChange, disabled, deps, media, onMedia, mediaError })` */
export function DescriptorForm({ descriptor, values, errors = {}, onChange, disabled = false, deps = {}, media, onMedia, mediaError }) {
  return html`<div class="stack">
    ${(descriptor.fields || []).map(
      (field) => html`<${FieldControl} key=${field.name} field=${field} parts=${[field.name]} values=${values} errors=${errors} onChange=${onChange} disabled=${disabled} deps=${deps} />`,
    )}
    ${descriptor.media && media ? html`<${MediaField} media=${descriptor.media} value=${media} onChange=${onMedia} disabled=${disabled} error=${mediaError} deps=${deps} />` : null}
  </div>`;
}
