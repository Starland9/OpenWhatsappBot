// The routed key editor (feature 004, contracts/panel-ui.md 7.5). `KeyEditor` finds the saved key and mounts `KeyForm`
// keyed `${id}:${version}`: a save, a reload or a `409 conflict` starts a fresh draft from the server state, and the draft
// is NEVER re-synchronised by an effect (the list is reloaded to new objects every time).
import { html, useEffect, useRef, useState, useAction, useUnsavedGuard, EmptyState, Field, Icon, Spinner } from "../components/index.mjs";
import { t, tError, formatDateTime } from "../i18n.mjs";
import { toastError, toastSuccess } from "../ui.mjs";
import { buildHash } from "../router.mjs";
import {
  DEFAULT_LIMITS,
  LIMIT_NAMES,
  activeNames,
  canDuplicate,
  canRevoke,
  draftOf,
  isDirty,
  isEditable,
  keyErrors,
  keyState,
  needsRecipients,
  orphanRights,
  pendingCount,
  setGroupRights,
  toggleRight,
} from "./api-logic.mjs";
import { askAnyone, duplicateKey, revokeKey, saveKey } from "./api-key-actions.mjs";
import { RightsChecklist } from "./api-rights.mjs";
import { RecipientsEditor } from "./api-recipients.mjs";
import { IpListEditor, errorText } from "./api-ips.mjs";

const LIMIT_FIELDS = { perMinute: "api.limits_per_minute", perDay: "api.limits_per_day", maxPending: "api.limits_pending" };
const DEFAULT_OF = { perMinute: "perMinute", perDay: "perDay", maxPending: "maxPending" };

function KeyForm({ saved, keys, catalog, state, onChanged, onSecret }) {
  const [draft, setDraft] = useState(() => draftOf(saved));
  const [errors, setErrors] = useState({});
  const [summary, setSummary] = useState([]);
  const [created, setCreated] = useState(false);
  const [busy, run] = useAction();
  const headRef = useRef(null);
  const formRef = useRef(null);
  const dirty = isDirty(saved, draft) && !created;
  useUnsavedGuard(`api-key-${saved ? saved.id : "new"}`, dirty);

  const limits = { ...DEFAULT_LIMITS, ...(catalog.limits || {}) };
  const state_ = saved ? keyState(saved) : "active";
  const readOnly = Boolean(saved) && !isEditable(saved);
  const rights = catalog.rights || [];
  const orphans = orphanRights(draft.rights, rights);
  const errorCount = Object.keys(errors).length + summary.length;

  useEffect(() => {
    const head = headRef.current;
    if (head && typeof head.focus === "function") head.focus();
  }, []);
  useEffect(() => {
    const form = formRef.current;
    const first = form && typeof form.querySelector === "function" ? form.querySelector("[role=alert]") : null;
    if (first && typeof first.scrollIntoView === "function") first.scrollIntoView();
  }, [errorCount]);

  const edit = (patch) => {
    setErrors({});
    setSummary([]);
    setDraft((current) => ({ ...current, ...patch }));
  };

  const save = () =>
    run(async () => {
      let outcome;
      try {
        outcome = await saveKey({ draft, saved, names: activeNames(keys.items, saved ? saved.id : null), limits });
      } catch (err) {
        if (err && err.code === "validation_failed") {
          const mapped = keyErrors(err.fields);
          setErrors(mapped.errors);
          setSummary(mapped.summary);
          return;
        }
        if (err && err.code === "conflict") {
          toastError(err);
          onChanged();
          return;
        }
        throw err;
      }
      if (outcome.status === "invalid") {
        setErrors(outcome.errors);
        setSummary([]);
      } else if (outcome.status === "created") {
        setCreated(true);
        onSecret({ secret: outcome.secret, name: outcome.key.name, last4: outcome.key.last4, after: `editor:${outcome.key.id}` });
        onChanged();
      } else if (outcome.status === "updated") {
        toastSuccess(t("api.editor_saved", { name: outcome.key.name }));
        onChanged();
      }
    });

  const section = (title, body) => html`<section class="card stack"><h2 class="card-title">${title}</h2>${body}</section>`;
  const pending = pendingCount(saved, draft);

  return html`<div class="stack" ref=${formRef}>
    <div class="view-header">
      <h1 ref=${headRef} tabindex="-1">${saved ? t("api.editor_title", { name: saved.name }) : t("api.editor_title_new")}</h1>
      <a class="btn" href=${buildHash("api")}><${Icon} name="chevron-left" />${t("api.back_keys")}</a>
    </div>
    ${state_ === "revoked" ? html`<div class="banner banner-warn" role="status"><${Icon} name="warning" /><div class="banner-body">${t("api.editor_revoked_banner")}</div></div>` : null}
    ${state_ === "expired" ? html`<div class="banner banner-warn" role="status"><${Icon} name="warning" /><div class="banner-body">${t("api.editor_expired_banner")}</div></div>` : null}
    ${summary.length
      ? html`<div class="banner banner-error" role="alert"><div class="banner-body"><p>${t("api.editor_errors_title")}</p><ul>${summary.map((item) => html`<li key=${item.path}><span class="mono">${item.path}</span>: ${errorText(item.error)}</li>`)}</ul></div></div>`
      : null}
    ${section(
      t("api.name_label"),
      html`<${Field} name="api-key-name" label=${t("api.name_label")} hint=${t("api.name_hint")} required value=${draft.name} maxLength=${limits.keyNameMax} disabled=${readOnly} error=${errors.name ? errorText(errors.name) : null} onChange=${(value) => edit({ name: value })} />`,
    )}
    ${section(
      t("api.section_rights"),
      html`<${RightsChecklist}
        rights=${rights}
        selected=${draft.rights}
        orphans=${orphans}
        disabled=${readOnly}
        error=${errors.rights}
        needRecipients=${needsRecipients(draft)}
        onToggle=${(id) => edit({ rights: toggleRight(draft, id).rights })}
        onGroup=${(group, on) => edit({ rights: setGroupRights(draft, rights, group, on).rights })}
        onRemoveOrphan=${(id) => edit({ rights: draft.rights.filter((item) => item !== id) })}
      />`,
    )}
    ${section(
      t("api.section_recipients"),
      html`<${RecipientsEditor}
        mode=${draft.mode}
        recipients=${draft.recipients}
        max=${limits.recipientsMax}
        disabled=${readOnly}
        errors=${errors}
        askAnyone=${askAnyone}
        onMode=${(mode) => edit({ mode })}
        onChange=${(recipients) => edit({ recipients })}
      />`,
    )}
    ${section(
      t("api.section_limits"),
      html`<p class="muted">${t("api.limits_hint")}</p>
        <div class="grid">
          ${LIMIT_NAMES.map((name) => {
            const [min, max] = limits[name];
            return html`<${Field}
              key=${name}
              type="int"
              name=${`api-limit-${name}`}
              label=${t(LIMIT_FIELDS[name])}
              hint=${t("api.limits_default", { value: state.settings ? state.settings[DEFAULT_OF[name]] : "" })}
              min=${min}
              max=${max}
              value=${draft.limits[name]}
              disabled=${readOnly}
              error=${errors[name] ? errorText(errors[name]) : null}
              onChange=${(value) => edit({ limits: { ...draft.limits, [name]: value } })}
            />`;
          })}
        </div>`,
    )}
    ${section(
      t("api.section_ips"),
      html`<${IpListEditor} rows=${draft.ipRows} disabled=${readOnly} error=${errors.ipAllow} label=${t("api.ip_label")} hint=${t("api.ip_hint")} placeholder=${t("api.ip_placeholder")} onChange=${(ipRows) => edit({ ipRows })} />
        <div class="field">
          <label class="field-label" for="api-key-expiry">${t("api.expiry_label")}</label>
          <div class="row-wrap">
            <input class="input" id="api-key-expiry" type="datetime-local" value=${draft.expiry.local} disabled=${readOnly} onInput=${(event) => edit({ expiry: { ...draft.expiry, local: event.currentTarget.value } })} />
            <button type="button" class="btn btn-sm" disabled=${readOnly || !draft.expiry.local} onClick=${() => edit({ expiry: { ...draft.expiry, local: "" } })}>${t("api.expiry_clear")}</button>
          </div>
          <div class="field-hint">${t("api.expiry_hint")}</div>
          ${errors.expiresAt ? html`<div class="field-error" role="alert">${errorText(errors.expiresAt)}</div>` : null}
        </div>`,
    )}
    ${saved
      ? section(
          t("api.section_facts"),
          html`<dl class="kv">
            <dt>${t("api.fact_id")}</dt><dd class="mono">${saved.id}</dd>
            <dt>${t("api.fact_created")}</dt><dd>${formatDateTime(saved.createdAt)}</dd>
            <dt>${t("api.fact_updated")}</dt><dd>${formatDateTime(saved.updatedAt)}</dd>
            <dt>${t("api.fact_last_use")}</dt><dd>${saved.lastUsedAt ? html`${formatDateTime(saved.lastUsedAt)} <span class="mono">${saved.lastUsedIp || ""}</span>` : t("api.fact_never")}</dd>
            <dt>${t("api.fact_last4")}</dt><dd class="mono">${saved.last4}</dd>
          </dl>`,
        )
      : null}
    <div class="actions">
      ${readOnly ? null : html`<button type="button" class="btn btn-primary" disabled=${busy || !dirty} onClick=${save}>${t("common.save")}</button>`}
      <a class="btn" href=${buildHash("api")}>${t("common.back")}</a>
      ${saved && canDuplicate(saved) ? html`<button type="button" class="btn" disabled=${busy} onClick=${() => duplicateKey(saved, { run, onSecret, onChanged })}>${t("api.action_duplicate")}</button>` : null}
      ${saved && canRevoke(saved) ? html`<button type="button" class="btn btn-danger" disabled=${busy} onClick=${() => revokeKey(saved, { run, onChanged })}>${t("api.action_revoke")}</button>` : null}
      ${dirty ? html`<span class="muted" aria-live="polite">${t("api.editor_pending", { count: pending })}</span>` : null}
    </div>
  </div>`;
}

/** `KeyEditor({ id, keys, keysError, catalog, state, onChanged, onSecret })`, `id` is `new` or the key's integer id. */
export function KeyEditor({ id, keys, keysError, catalog, state, onChanged, onSecret }) {
  if (!keys) {
    if (keysError) {
      return html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(keysError)}>
        <a class="btn" href=${buildHash("api")}>${t("api.back_keys")}</a>
      <//>`;
    }
    return html`<${Spinner} />`;
  }
  const saved = id === "new" ? null : (keys.items || []).find((key) => String(key.id) === String(id));
  if (id !== "new" && !saved) {
    return html`<${EmptyState} icon="info" title=${t("api.editor_not_found")}><a class="btn" href=${buildHash("api")}>${t("api.back_keys")}</a><//>`;
  }
  return html`<${KeyForm} key=${saved ? `${saved.id}:${saved.version}` : "new"} saved=${saved} keys=${keys} catalog=${catalog} state=${state} onChanged=${onChanged} onSecret=${onSecret} />`;
}
