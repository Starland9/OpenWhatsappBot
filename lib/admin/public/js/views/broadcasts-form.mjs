// The create / edit form of a broadcast: content (text, one optional image or document through the shared
// upload()), destinations (the picker, no free-text number), sending (spacing, now / later / recurring), then the
// preview (BC-2) and the confirmation that states the destination count (BC-3). Edit mode (BC-5) is recurring only.
import {
  html,
  useState,
  useMemo,
  useAsync,
  useAction,
  useId,
  useLanguage,
  useUnsavedGuard,
  EmptyState,
  Field,
  Icon,
  Spinner,
  StatusBadge,
  fieldErrorText,
} from "../components/index.mjs";
import { t, tError, formatBytes, formatDateTime, formatDuration } from "../i18n.mjs";
import { api, upload, ApiError } from "../api.mjs";
import { confirm, toast, toastSuccess, clearDirty } from "../ui.mjs";
import { navigate } from "../router.mjs";
import { DestinationPicker } from "./broadcasts-picker.mjs";
import {
  WEEKDAYS,
  weekdayName,
  emptyForm,
  formFromBroadcast,
  buildPrefill,
  buildBody,
  buildPatch,
  validateForm,
  hasMedia,
  failedSummary,
  errorFor,
  TEXT_MAX,
  CAPTION_MAX,
} from "./broadcasts-logic.mjs";

const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf,application/zip,text/plain,text/csv,.csv,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp";

/** A labelled control that Field does not cover (date, time, checkboxes) */
function Row({ label, hint, error, forId, children }) {
  const text = fieldErrorText(error);
  return html`<div class="field">
    <label class="field-label" for=${forId}>${label}</label>
    ${children}
    ${hint ? html`<div class="field-hint">${hint}</div>` : null}
    ${text ? html`<div class="field-error" role="alert">${text}</div>` : null}
  </div>`;
}

function Lines({ text }) {
  const lines = String(text || "").split("\n");
  return html`<p>${lines.map((line, index) => html`${index ? html`<br />` : null}${line}`)}</p>`;
}

/** The media of the form: an upload, a reused file, or nothing; an upload goes through UP-1 with progress */
function MediaControl({ form, setForm, error, disabled }) {
  const uid = useId();
  const [progress, setProgress] = useState(null);
  const [busy, run] = useAction();
  useLanguage();

  const dropUpload = (current) => {
    // the staged file is only useful to this form: remove it (best effort, it also expires after an hour)
    if (current) api("DELETE", `/admin/api/uploads/${current.uploadId}`).catch(() => {});
  };

  const choose = (event) => {
    const file = event.currentTarget.files && event.currentTarget.files[0];
    event.currentTarget.value = "";
    if (!file) return;
    run(async () => {
      setProgress(0);
      try {
        const answer = await upload(file, "broadcast", file.name, (p) => setProgress(p.ratio));
        dropUpload(form.upload);
        setForm({ ...form, upload: { uploadId: answer.uploadId, name: answer.name || file.name, kind: answer.kind, size: answer.size }, reuseMediaOf: null, reuseMedia: null });
      } finally {
        setProgress(null);
      }
    });
  };

  const clear = () => {
    dropUpload(form.upload);
    setForm({ ...form, upload: null, reuseMediaOf: null, reuseMedia: null });
  };

  const current = form.upload || (form.reuseMedia && { ...form.reuseMedia, reused: Boolean(form.reuseMediaOf) });
  return html`<div class="field">
    <label class="field-label" for=${`${uid}-file`}>${t("broadcasts.media_label")}</label>
    ${current
      ? html`<div class="row-wrap">
          <${Icon} name="info" />
          <span class="mono">${current.name}</span>
          <span class="muted">${t(`broadcasts.media_kind_${current.kind}`)}${current.size ? ` · ${formatBytes(current.size)}` : ""}</span>
          ${current.reused ? html`<span class="badge">${t("broadcasts.media_reused")}</span>` : null}
          ${current.available === false ? html`<span class="badge badge-warn">${t("broadcasts.media_gone")}</span>` : null}
          ${form.upload || form.reuseMediaOf ? html`<button type="button" class="btn btn-sm" disabled=${disabled || busy} onClick=${clear}>${t("broadcasts.media_remove")}</button>` : null}
        </div>`
      : html`<p class="muted">${t("broadcasts.media_none")}</p>`}
    <input class="input" type="file" id=${`${uid}-file`} accept=${ACCEPT} disabled=${disabled || busy} onChange=${choose} />
    ${progress !== null ? html`<progress max="1" value=${progress} aria-label=${t("broadcasts.media_uploading")}></progress>` : null}
    <div class="field-hint">${t("broadcasts.media_hint", { caption: CAPTION_MAX })}</div>
    ${fieldErrorText(error) ? html`<div class="field-error" role="alert">${fieldErrorText(error)}</div>` : null}
  </div>`;
}

/** The recurrence rule: daily, weekly (days) or monthly (day of the month, le 31 = last day of short months) */
function RuleControl({ rule, onChange, errors, disabled }) {
  const uid = useId();
  const lang = useLanguage();
  const set = (patch) => onChange({ ...rule, ...patch });
  const toggleDay = (day) => {
    const days = rule.days.includes(day) ? rule.days.filter((d) => d !== day) : [...rule.days, day];
    set({ days: days.sort((a, b) => a - b) });
  };
  return html`<div class="stack-sm">
    <${Field}
      type="enum"
      name="rule-kind"
      label=${t("broadcasts.rule_kind")}
      value=${rule.kind}
      disabled=${disabled}
      options=${[
        { value: "daily", label: t("broadcasts.rule_kind_daily") },
        { value: "weekly", label: t("broadcasts.rule_kind_weekly") },
        { value: "monthly", label: t("broadcasts.rule_kind_monthly") },
      ]}
      error=${errorFor(errors, "recurrence.kind")}
      onChange=${(kind) => set({ kind })}
    />
    ${rule.kind === "weekly"
      ? html`<fieldset class="choice-group">
          <legend class="field-label">${t("broadcasts.rule_days")}</legend>
          ${WEEKDAYS.map(
            (day) => html`<label class="choice" key=${day}><input type="checkbox" checked=${rule.days.includes(day)} disabled=${disabled} onChange=${() => toggleDay(day)} />${weekdayName(day, lang)}</label>`,
          )}
          ${fieldErrorText(errorFor(errors, "recurrence.days")) ? html`<div class="field-error" role="alert">${fieldErrorText(errorFor(errors, "recurrence.days"))}</div>` : null}
        </fieldset>`
      : null}
    ${rule.kind === "monthly"
      ? html`<${Field}
          type="int"
          name="rule-day"
          label=${t("broadcasts.rule_day")}
          hint=${t("broadcasts.rule_day_hint")}
          value=${rule.day}
          min="1"
          max="31"
          disabled=${disabled}
          error=${errorFor(errors, "recurrence.day")}
          onChange=${(day) => set({ day })}
        />`
      : null}
    <${Row} label=${t("broadcasts.rule_time")} hint=${t("broadcasts.rule_time_hint")} error=${errorFor(errors, "recurrence.time")} forId=${`${uid}-time`}>
      <input class="input" type="time" id=${`${uid}-time`} value=${rule.time} disabled=${disabled} onInput=${(event) => set({ time: event.currentTarget.value })} />
    <//>
  </div>`;
}

/** BC-2 answer, shown before the confirmation */
function PreviewCard({ preview, form, busy, onConfirm, onBack, confirmLabel }) {
  return html`<section class="card stack" aria-live="polite">
    <h2 class="card-title">${t("broadcasts.preview_title")}</h2>
    <dl class="kv">
      <dt>${t("broadcasts.preview_destinations")}</dt><dd><strong>${preview.targetCount}</strong></dd>
      <dt>${t("broadcasts.preview_duration")}</dt><dd>${preview.targetCount > 1 ? `≈ ${formatDuration(preview.estimatedDurationMs)}` : t("broadcasts.preview_immediate")}</dd>
      <dt>${t("broadcasts.preview_spacing")}</dt><dd>${formatDuration(preview.spacingMs)}</dd>
      <dt>${t("broadcasts.preview_media")}</dt><dd>${preview.mediaKind ? t(`broadcasts.media_kind_${preview.mediaKind}`) : t("broadcasts.media_none_short")}</dd>
      <dt>${t("broadcasts.preview_length")}</dt><dd>${preview.textLength}</dd>
    </dl>
    ${preview.nextOccurrences
      ? html`<div class="stack-sm">
          <strong>${t("broadcasts.preview_next")}</strong>
          <ul>${preview.nextOccurrences.map((instant) => html`<li key=${instant}>${formatDateTime(instant, { dateStyle: "full", timeStyle: "short" })}</li>`)}</ul>
        </div>`
      : null}
    ${preview.warnings.map((warning) => html`<div key=${warning} class="banner banner-warn" role="status"><span class="banner-body">${t(`broadcasts.warning_${warning}`)}</span></div>`)}
    <div class="stack-sm">
      <strong>${t("broadcasts.preview_message")}</strong>
      <div class="card"><${Lines} text=${form.text.trim()} /></div>
    </div>
    <div class="actions">
      <button type="button" class="btn" disabled=${busy} onClick=${onBack}>${t("broadcasts.back_to_edit")}</button>
      <button type="button" class="btn btn-primary" disabled=${busy} onClick=${onConfirm}>${confirmLabel}</button>
    </div>
  </section>`;
}

function FormBody({ initial, editing, original, notes }) {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const [preview, setPreview] = useState(null);
  const [busy, run] = useAction();
  const uid = useId();
  useLanguage();

  const snapshot = useMemo(() => JSON.stringify(initial), [initial]);
  const dirty = JSON.stringify(form) !== snapshot;
  useUnsavedGuard(`broadcast-${editing ? original.id : "new"}`, dirty);

  const update = (patch) => {
    setForm({ ...form, ...patch });
    setPreview(null);
  };
  const setWhole = (next) => {
    setForm(next);
    setPreview(null);
  };

  /** Server errors are `fields`: show them next to the controls */
  const showServerError = (err) => {
    if (err instanceof ApiError && err.fields && Object.keys(err.fields).length) {
      setErrors(err.fields);
      toast(tError(err), { kind: "error" });
      return;
    }
    if (err instanceof ApiError && err.code === "confirmation_required" && err.params && err.params.targetCount !== undefined) {
      toast(t("broadcasts.confirm_mismatch", { count: err.params.targetCount }), { kind: "error" });
      return;
    }
    toast(tError(err), { kind: "error" });
  };

  const check = () => {
    const found = validateForm(form, { editing });
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const askPreview = () =>
    run(async () => {
      if (!check()) return;
      try {
        setPreview(await api("POST", "/admin/api/broadcasts/preview", buildBody(form, { confirm: false })));
      } catch (err) {
        showServerError(err);
      }
    });

  const finish = (id) => {
    clearDirty();
    navigate("broadcasts", [String(id)]);
  };

  /** BC-3 after the owner confirmed the destination count */
  const send = () =>
    run(async () => {
      const count = preview ? preview.targetCount : buildBody(form).targets.length;
      const ok = await confirm({
        title: t(form.kind === "recurring" ? "broadcasts.confirm_title_recurring" : form.when === "later" ? "broadcasts.confirm_title_later" : "broadcasts.confirm_title_now"),
        message: t("broadcasts.confirm_message", { count }),
        confirmLabel: t(form.kind === "recurring" ? "broadcasts.confirm_create_recurring" : form.when === "later" ? "broadcasts.confirm_schedule" : "broadcasts.confirm_send", { count }),
        danger: false,
      });
      if (!ok) return;
      try {
        const answer = await api("POST", "/admin/api/broadcasts", buildBody(form));
        toastSuccess(t("broadcasts.created"));
        finish(answer.broadcast.id);
      } catch (err) {
        showServerError(err);
        setPreview(null);
      }
    });

  /** BC-5 */
  const save = () =>
    run(async () => {
      if (!check()) return;
      const patch = buildPatch(form, original);
      if (!Object.keys(patch).length) {
        toast(t("broadcasts.nothing_changed"), { kind: "info" });
        return;
      }
      if (patch.targets) {
        const ok = await confirm({ title: t("broadcasts.confirm_title_edit"), message: t("broadcasts.confirm_message", { count: patch.targets.length }), confirmLabel: t("broadcasts.confirm_save") });
        if (!ok) return;
      }
      try {
        await api("PATCH", `/admin/api/broadcasts/${original.id}`, patch);
        toastSuccess(t("broadcasts.saved"));
        finish(original.id);
      } catch (err) {
        showServerError(err);
      }
    });

  const cap = hasMedia(form) ? CAPTION_MAX : TEXT_MAX;
  const summary = notes.failed;
  const submitLabel = editing ? t("broadcasts.save") : t("broadcasts.preview_button");

  return html`<form class="form stack" onSubmit=${(event) => {
    event.preventDefault();
    if (editing) save();
    else askPreview();
  }}>
    ${summary
      ? html`<div class="banner banner-info" role="status"><span class="banner-body">
          ${t("broadcasts.prefill_notice", { count: form.targets.length })}
          ${summary.skipped ? ` ${t("broadcasts.prefill_skipped", { count: summary.skipped })}` : ""}
          ${summary.unsure ? ` ${t("broadcasts.prefill_unsure", { count: summary.unsure })}` : ""}
          ${notes.mediaGone ? ` ${t("broadcasts.prefill_media_gone")}` : ""}
        </span></div>`
      : null}

    <section class="card stack">
      <h2 class="card-title">${t("broadcasts.section_content")}</h2>
      <${Field} type="text" name="title" label=${t("broadcasts.field_title")} hint=${t("broadcasts.field_title_hint")} maxLength=${100} value=${form.title} error=${errorFor(errors, "title")} disabled=${busy} onChange=${(title) => update({ title })} />
      <${Field}
        type="textarea"
        name="text"
        label=${t("broadcasts.field_text")}
        hint=${t("broadcasts.field_text_hint", { length: Array.from(form.text).length, max: cap })}
        rows=${6}
        value=${form.text}
        required
        error=${errorFor(errors, "text")}
        disabled=${busy}
        onChange=${(text) => update({ text })}
      />
      <${MediaControl} form=${form} setForm=${setWhole} error=${errorFor(errors, "uploadId") || errorFor(errors, "reuseMediaOf")} disabled=${busy} />
    </section>

    <section class="card stack">
      <h2 class="card-title">${t("broadcasts.section_destinations")}</h2>
      ${editing
        ? html`<fieldset class="choice-group">
            <label class="choice"><input type="radio" name=${`${uid}-keep`} checked=${form.keepTargets} disabled=${busy} onChange=${() => update({ keepTargets: true })} />${t("broadcasts.keep_destinations", { count: original.targetCount })}</label>
            <label class="choice"><input type="radio" name=${`${uid}-keep`} checked=${!form.keepTargets} disabled=${busy} onChange=${() => update({ keepTargets: false })} />${t("broadcasts.replace_destinations")}</label>
          </fieldset>`
        : null}
      ${form.keepTargets && editing
        ? null
        : html`<${DestinationPicker} selection=${form.targets} onChange=${(targets) => update({ targets })} error=${errorFor(errors, "targets")} disabled=${busy} />`}
    </section>

    <section class="card stack">
      <h2 class="card-title">${t("broadcasts.section_sending")}</h2>
      ${editing
        ? null
        : html`<fieldset class="choice-group">
            <legend class="field-label">${t("broadcasts.field_kind")}</legend>
            <label class="choice"><input type="radio" name=${`${uid}-kind`} checked=${form.kind === "once"} disabled=${busy} onChange=${() => update({ kind: "once" })} />${t("broadcasts.kind_once")}</label>
            <label class="choice"><input type="radio" name=${`${uid}-kind`} checked=${form.kind === "recurring"} disabled=${busy} onChange=${() => update({ kind: "recurring" })} />${t("broadcasts.kind_recurring")}</label>
          </fieldset>`}

      ${form.kind === "once"
        ? html`<fieldset class="choice-group">
              <legend class="field-label">${t("broadcasts.field_when")}</legend>
              <label class="choice"><input type="radio" name=${`${uid}-when`} checked=${form.when === "now"} disabled=${busy} onChange=${() => update({ when: "now" })} />${t("broadcasts.when_now")}</label>
              <label class="choice"><input type="radio" name=${`${uid}-when`} checked=${form.when === "later"} disabled=${busy} onChange=${() => update({ when: "later" })} />${t("broadcasts.when_later")}</label>
            </fieldset>
            ${form.when === "later"
              ? html`<${Row} label=${t("broadcasts.field_run_at")} hint=${t("broadcasts.field_run_at_hint")} error=${errorFor(errors, "runAt")} forId=${`${uid}-runat`}>
                  <input class="input" type="datetime-local" id=${`${uid}-runat`} value=${form.runAtLocal} disabled=${busy} onInput=${(event) => update({ runAtLocal: event.currentTarget.value })} />
                <//>`
              : null}`
        : html`<${RuleControl} rule=${form.recurrence} errors=${errors} disabled=${busy} onChange=${(recurrence) => update({ recurrence })} />
            <p class="muted">${t("broadcasts.rule_late_hint")}</p>`}

      <${Field}
        type="int"
        name="spacing"
        label=${t("broadcasts.field_spacing")}
        hint=${t("broadcasts.field_spacing_hint")}
        unit=${t("broadcasts.unit_seconds")}
        value=${form.spacingSeconds}
        min="2"
        max="600"
        step="0.5"
        error=${errorFor(errors, "spacingMs")}
        disabled=${busy}
        onChange=${(spacingSeconds) => update({ spacingSeconds })}
      />
    </section>

    ${preview && !editing
      ? html`<${PreviewCard}
          preview=${preview}
          form=${form}
          busy=${busy}
          onBack=${() => setPreview(null)}
          onConfirm=${send}
          confirmLabel=${t(form.kind === "recurring" ? "broadcasts.confirm_create_recurring" : form.when === "later" ? "broadcasts.confirm_schedule" : "broadcasts.confirm_send", { count: preview.targetCount })}
        />`
      : null}

    <div class="actions">
      <a class="btn" href=${editing ? `#/broadcasts/${original.id}` : "#/broadcasts"}>${t("common.cancel")}</a>
      <button type="submit" class="btn btn-primary" disabled=${busy}>${busy ? html`<${Spinner} />` : null}${submitLabel}</button>
    </div>
  </form>`;
}

/**
 * `editId`: edit a recurring broadcast (BC-4 + BC-5). `fromId` + `fromRun`: the "new broadcast to the failed
 * destinations" pre-fill (BC-4 + BC-10 through buildPrefill). Neither: a blank form.
 */
export function BroadcastForm({ editId, fromId, fromRun }) {
  const { data, error, loading, reload } = useAsync(async () => {
    if (editId) {
      const detail = await api("GET", `/admin/api/broadcasts/${editId}`);
      return { form: formFromBroadcast(detail.broadcast), original: detail.broadcast, notes: {} };
    }
    if (fromId && fromRun) {
      const [detail, report] = await Promise.all([api("GET", `/admin/api/broadcasts/${fromId}`), api("GET", `/admin/api/broadcasts/${fromId}/runs/${fromRun}`)]);
      const prefill = buildPrefill(detail.broadcast, report);
      return { form: prefill.form, original: null, notes: { failed: { ...failedSummary(report), skipped: prefill.skipped }, mediaGone: prefill.mediaGone } };
    }
    return { form: emptyForm(), original: null, notes: {} };
  }, [editId, fromId, fromRun]);

  const title = editId ? t("broadcasts.edit_title") : t("broadcasts.new_title");
  const back = html`<a class="btn btn-sm" href=${editId ? `#/broadcasts/${editId}` : "#/broadcasts"}><${Icon} name="chevron-left" />${t("common.back")}</a>`;
  if (loading && !data) return html`<section class="view"><div class="view-header"><h1>${title}</h1></div><${Spinner} /></section>`;
  if (error && !data) {
    return html`<section class="view">
      <div class="view-header"><h1>${title}</h1>${back}</div>
      <${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}>
        <button type="button" class="btn" onClick=${reload}><${Icon} name="refresh" />${t("common.retry")}</button>
      <//>
    </section>`;
  }
  return html`<section class="view stack">
    <div class="view-header"><h1>${title}</h1>${back}</div>
    ${editId ? html`<p class="muted">${t("broadcasts.edit_intro")} <${StatusBadge} tone="neutral" label=${t("broadcasts.kind_recurring")} /></p>` : null}
    <${FormBody} key=${`${editId || ""}:${fromId || ""}:${fromRun || ""}`} initial=${data.form} editing=${Boolean(editId)} original=${data.original} notes=${data.notes} />
  </section>`;
}
