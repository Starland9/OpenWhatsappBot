// One setting of the settings view: its label and control, its origin and effect badges, the default and the file
// value, the field error, the conflict message and the actions (reset to default, revert to the file value, test
// the key). Presentational: the state lives in views/settings.mjs.
import { html, Field, SecretInput, Spinner } from "../components/index.mjs";
import { t, tError, formatDateTime, getLanguage } from "../i18n.mjs";
import { isEditable, originKind, describeDefault, plainValue, canTest, verdictTone, jidApplies, unitKey, MODE_KEYS } from "./settings-logic.mjs";

const BADGE_TONE = { default: "badge", env: "badge badge-info", panel: "badge badge-ok", bot: "badge badge-ok" };

/** A language code with its name in the panel language: "fr (français)" */
function languageName(code) {
  try {
    const name = new Intl.DisplayNames([getLanguage()], { type: "language" }).of(code);
    return name && name !== code ? `${code} (${name})` : code;
  } catch {
    return code;
  }
}

/** Options of an enumeration: modes are described, languages named, the rest shown as they are written */
export function enumOptions(setting) {
  const values = (setting.rules && setting.rules.enum) || [];
  return values.map((value) => {
    if (MODE_KEYS.includes(setting.key)) return { value, label: t(`settings.mode.${value}`) };
    if (setting.key === "BOT_LANG") return { value, label: languageName(value) };
    return { value, label: String(value) };
  });
}

/** A stored value as text, for the read-only entries and the "default" and "file value" lines */
export function displayValue(setting, value) {
  if (typeof value === "boolean") return value ? t("common.yes") : t("common.no");
  const text = plainValue(value);
  return text === "" ? t("common.none") : text;
}

function SecretState({ setting }) {
  const secret = setting.secret || { set: false };
  if (secret.scheme) return html`<span class="badge">${secret.scheme}</span>`;
  if (secret.needsReentry) return html`<span class="badge badge-warn">${t("settings.needs_reentry")}</span>`;
  if (secret.set) return html`<span class="badge badge-ok">${secret.last4 ? t("secret.set_last4", { last4: secret.last4 }) : t("secret.set")}</span>`;
  return html`<span class="badge">${t("secret.unset")}</span>`;
}

/** Read-only entries (startup and "no effect today"): the effective value, never a control */
function ReadOnlyRow({ setting }) {
  const label = t(`settings.${setting.key}.label`);
  return html`<div class="card">
    <div class="row-wrap">
      <span class="field-label">${label}</span>
      <span class="mono muted">${setting.key}</span>
      <${SettingBadges} setting=${setting} />
    </div>
    <div class="mono">${setting.secret ? html`<${SecretState} setting=${setting} />` : displayValue(setting, setting.value)}</div>
    <div class="field-hint">${t(`settings.${setting.key}.desc`)}</div>
  </div>`;
}

function SettingBadges({ setting }) {
  const kind = originKind(setting);
  return html`<span class="row-wrap">
    ${setting.inactive ? null : html`<span class=${BADGE_TONE[kind]}>${t(`settings.origin_${kind}`)}</span>`}
    ${setting.effect === "restart" ? html`<span class="badge badge-warn">${t("settings.effect_restart")}</span>` : null}
    ${setting.effect === "boot-only" && !setting.inactive ? html`<span class="badge">${t("settings.effect_boot")}</span>` : null}
    ${setting.pendingRestart ? html`<span class="badge badge-warn">${t("settings.restart_pending")}</span>` : null}
    ${setting.problem ? html`<span class="badge badge-warn">${t(`settings.problem.${setting.problem.code}`)}</span>` : null}
  </span>`;
}

function TestResult({ result }) {
  if (!result) return null;
  if (result.error) return html`<span class="field-error" role="alert">${tError(result.error)}</span>`;
  return html`<span class="row-wrap" role="status">
    <span class=${`badge badge-${verdictTone(result.verdict)}`}>${t(`settings.test.${result.verdict}`)}</span>
    ${result.detail === "quota" ? html`<span class="muted">${t("settings.test.quota")}</span>` : null}
    <span class="muted">${formatDateTime(result.checkedAt)}</span>
  </span>`;
}

/**
 * Props: setting, settings (the whole list: a JID depends on its mode), form, error ({ code, params } from the API or
 * the pre-validation), busy, test (the last key-test result of the service), testing (a test is running),
 * onValue(key, value), onSecret(key, patch), onAction(setting, "default" | "revert"), onTest(setting), onReload(key).
 */
export function SettingRow({ setting, settings, form, error, busy, test, testing, onValue, onSecret, onAction, onTest, onReload }) {
  if (!isEditable(setting)) return html`<${ReadOnlyRow} setting=${setting} />`;

  const key = setting.key;
  const label = t(`settings.${key}.label`);
  const hint = t(`settings.${key}.desc`);
  const conflict = error && error.code === "conflict";
  const applies = jidApplies(setting, form, settings);
  const rules = setting.rules || {};
  const unit = setting.unit ? t(`settings.unit.${unitKey(setting.unit)}`) : undefined;

  let control;
  if (setting.secret) {
    const secret = form.secrets[key] || { draft: "", cleared: false };
    control = html`<${SecretInput}
      label=${label}
      name=${key}
      secret=${setting.secret}
      draft=${secret.draft}
      cleared=${secret.cleared}
      error=${error}
      hint=${hint}
      disabled=${busy}
      onDraft=${(draft) => onSecret(key, { draft })}
      onClear=${() => onSecret(key, { cleared: true, draft: "" })}
      onUndo=${() => onSecret(key, { cleared: false })}
    />`;
  } else {
    const value = form.values[key];
    const common = { label, name: key, error, hint, disabled: busy || !applies, onChange: (next) => onValue(key, next) };
    if (setting.type === "bool") control = html`<${Field} type="bool" value=${value} ...${common} />`;
    else if (setting.type === "enum") control = html`<${Field} type="enum" value=${value} options=${enumOptions(setting)} ...${common} />`;
    else if (setting.type === "int") control = html`<${Field} type="int" value=${value} min=${rules.min} max=${rules.max} unit=${unit} ...${common} />`;
    else if (setting.type === "list") control = html`<${Field} type="list" value=${value} inputMode=${rules.digitsOnly ? "numeric" : undefined} ...${common} />`;
    else if (setting.type === "text") control = html`<${Field} type="textarea" rows=${5} value=${value} maxLength=${rules.maxChars} ...${common} />`;
    else control = html`<${Field} type=${setting.type === "url" ? "url" : "text"} value=${value} maxLength=${rules.maxChars} ...${common} />`;
  }

  const def = describeDefault(setting);
  const modified = setting.origin === "override" && setting.source === "env";
  const showFile = modified && setting.fileValue !== null && setting.fileValue !== undefined && setting.fileValue !== "";
  const canReset = setting.secret ? Boolean(setting.secret.set) : setting.origin !== "default";
  const testable = canTest(setting);

  return html`<div class="card" id=${`setting-${key}`}>
    ${control}
    <div class="stack-sm">
      <${SettingBadges} setting=${setting} />
      ${modified ? html`<div class="field-hint">${t("settings.modified_in_panel")}${showFile ? ` ${t("settings.file_value", { value: displayValue(setting, setting.fileValue) })}` : ""}</div>` : null}
      ${def.kind === "value" && !setting.secret ? html`<div class="field-hint">${t("settings.default_value", { value: displayValue(setting, def.value) })}</div>` : null}
      ${def.kind === "same_as" ? html`<div class="field-hint">${t("settings.default_same_as", { other: def.other })}</div>` : null}
      ${def.kind === "auto_host" ? html`<div class="field-hint">${t("settings.default_auto")}</div>` : null}
      <div class="actions">
        ${canReset ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => onAction(setting, "default")}>${t("settings.reset_default")}</button>` : null}
        ${setting.canRevert ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => onAction(setting, "revert")}>${t("settings.revert_file")}</button>` : null}
        ${conflict ? html`<button type="button" class="btn btn-sm btn-primary" disabled=${busy} onClick=${() => onReload(key)}>${t("settings.reload_one")}</button>` : null}
        ${testable ? html`<button type="button" class="btn btn-sm" disabled=${busy || testing || !setting.secret.set} onClick=${() => onTest(setting)}>${testing ? html`<${Spinner} inline />` : null}${t("settings.test.button")}</button>` : null}
      </div>
      ${testable ? html`<div class="field-hint">${t("settings.test.hint")}</div>` : null}
      <${TestResult} result=${test} />
    </div>
  </div>`;
}
