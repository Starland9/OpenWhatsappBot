// Welcome and goodbye messages of one group (GRP-4, GRP-5): switch, text, live preview, back to the default.
import { html, useState, useEffect, useAction, useUnsavedGuard, Field } from "../components/index.mjs";
import { t } from "../i18n.mjs";
import { api } from "../api.mjs";
import { confirm, toastSuccess, toastError } from "../ui.mjs";
import {
  VARIABLES,
  appendVariable,
  previewLines,
  renderTemplate,
  resetBody,
  templateBody,
  templateDirty,
  templateDraft,
  validateTemplate,
} from "./groups-logic.mjs";

const groupPath = (group) => `/admin/api/groups/${encodeURIComponent(group.jid)}`;

function TemplateEditor({ group, kind, onGroup }) {
  const part = group[kind];
  const max = group.limits.messageMax;
  const [draft, setDraft] = useState(() => templateDraft(group, kind));
  const [serverError, setServerError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, run] = useAction();

  // a saved change (or a reload) starts a fresh draft
  useEffect(() => {
    setDraft(templateDraft(group, kind));
    setServerError(null);
  }, [part.enabled, part.message]);

  const dirty = templateDirty(group, kind, draft);
  useUnsavedGuard(`groups-${group.jid}-${kind}`, dirty);

  const check = validateTemplate(draft.message, max);
  const fieldError = serverError || check.error;

  // the server renders the preview (it knows the group's name and description); a pause after each keystroke
  useEffect(() => {
    if (!check.ok) {
      setPreview(null);
      return undefined;
    }
    let current = true;
    const handle = setTimeout(async () => {
      try {
        const answer = await api("POST", `${groupPath(group)}/preview`, { kind, message: draft.message.trim() });
        if (current) setPreview(answer.rendered);
      } catch {
        if (current) setPreview(null);
      }
    }, 400);
    return () => {
      current = false;
      clearTimeout(handle);
    };
  }, [draft.message, kind, group.jid]);

  const shown = preview ?? renderTemplate(draft.message, { user: "@member", group: group.name, desc: "" });

  const save = () =>
    run(
      async () => {
        const body = templateBody(group, kind, draft);
        if (!body) return;
        try {
          onGroup(await api("PATCH", groupPath(group), body));
          setServerError(null);
          toastSuccess(t("common.saved"));
        } catch (err) {
          if (err.code === "validation_failed" && err.fields && err.fields[`${kind}.message`]) setServerError(err.fields[`${kind}.message`]);
          else toastError(err);
        }
      },
      { silent: true },
    );

  const restoreDefault = () =>
    run(async () => {
      const ok = await confirm({
        title: t("groups.template_reset_title"),
        message: t("groups.template_reset_message"),
        confirmLabel: t("groups.template_reset_confirm"),
      });
      if (!ok) return;
      onGroup(await api("PATCH", groupPath(group), resetBody(kind)));
      toastSuccess(t("groups.template_reset_done"));
    });

  return html`<section class="card stack">
    <h2 class="card-title">${t(`groups.${kind}_title`)}</h2>
    <p class="muted">${t(`groups.${kind}_hint`)}</p>
    <${Field} type="bool" name=${`${kind}-enabled`} label=${t(`groups.${kind}_enabled`)} value=${draft.enabled} disabled=${busy} onChange=${(enabled) => setDraft((d) => ({ ...d, enabled }))} />
    <${Field}
      type="textarea"
      name=${`${kind}-message`}
      label=${t("groups.template_message")}
      value=${draft.message}
      rows=${4}
      disabled=${busy}
      error=${fieldError}
      hint=${t("groups.template_count", { count: Array.from(draft.message).length, max })}
      onChange=${(message) => {
        setServerError(null);
        setDraft((d) => ({ ...d, message }));
      }}
    />
    <div class="row-wrap">
      <span class="muted">${t("groups.template_variables")}</span>
      ${VARIABLES.map(
        (variable) => html`<button key=${variable} type="button" class="badge" disabled=${busy} title=${t(`groups.variable_${variable.slice(1)}`)} onClick=${() => setDraft((d) => ({ ...d, message: appendVariable(d.message, variable) }))}>${variable}</button>`,
      )}
    </div>
    <div class="stack-sm" aria-live="polite">
      <span class="field-label">${t("groups.template_preview")}</span>
      <div class="card">${shown ? previewLines(shown).map((line, index) => html`<div key=${index}>${line || "\u00a0"}</div>`) : html`<span class="muted">${t("groups.template_preview_empty")}</span>`}</div>
    </div>
    <div class="actions">
      <button type="button" class="btn btn-primary" disabled=${busy || !dirty || !check.ok} onClick=${save}>${t("common.save")}</button>
      <button type="button" class="btn" disabled=${busy || !dirty} onClick=${() => { setDraft(templateDraft(group, kind)); setServerError(null); }}>${t("groups.discard")}</button>
      ${part.custom ? html`<button type="button" class="btn btn-ghost" disabled=${busy} onClick=${restoreDefault}>${t("groups.template_reset")}</button>` : null}
    </div>
  </section>`;
}

/** The "Messages" tab: welcome and goodbye. */
export function MessagesTab({ group, onGroup }) {
  return html`<div class="stack">
    <${TemplateEditor} group=${group} kind="welcome" onGroup=${onGroup} />
    <${TemplateEditor} group=${group} kind="goodbye" onGroup=${onGroup} />
  </div>`;
}
