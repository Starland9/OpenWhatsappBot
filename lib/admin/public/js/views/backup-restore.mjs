import { html, Fragment, useState, useEffect, useRef, useLanguage, useLive, Field, Icon } from "../components/index.mjs";
import { t, formatDateTime, formatDuration, formatNumber } from "../i18n.mjs";
import { api, upload } from "../api.mjs";
import { live } from "../live.mjs";
import { confirm } from "../ui.mjs";
import { inspectBlocker, shapeSummary, tokenRemainingMs, canRetryWithSameFile, restoreProgress, restoreWarnings } from "./backup-logic.mjs";
import { refusalText } from "./backup-export.mjs";

const POLL_MS = 2000;

/** The refusal block of a failed request (kept on the page: the person may need to read it twice) */
function Refusal({ error }) {
  if (!error) return null;
  return html`<div class="banner banner-error" role="alert">
    <${Icon} name="error" />
    <div class="banner-body">${refusalText(error)}</div>
  </div>`;
}

/** The BAK-2 summary as the person reads it before confirming: header, counts per group, absent and ignored data. */
export function SummaryView({ summary }) {
  const model = shapeSummary(summary);
  if (!model) return null;
  const countsText = t("backup.summary_total", { total: formatNumber(model.total), types: model.groups.reduce((sum, group) => sum + group.rows.length, 0) });
  return html`<div class="stack">
    <dl class="kv">
      <dt>${t("backup.summary_created")}</dt>
      <dd>${model.createdAt ? formatDateTime(model.createdAt) : "-"}</dd>
      <dt>${t("backup.summary_version")}</dt>
      <dd>${model.botVersion || "-"}</dd>
      <dt>${t("backup.summary_dialect")}</dt>
      <dd>${model.dialect || "-"}</dd>
      <dt>${t("backup.summary_session")}</dt>
      <dd>${model.includesSession ? t("backup.summary_session_yes") : t("backup.summary_session_no")}</dd>
    </dl>
    <p class="muted">${countsText}</p>
    <div class="grid">
      ${model.groups.map(
        (group) => html`<div class="stack-sm" key=${group.id}>
          <strong>${t(group.titleKey)}</strong>
          <dl class="kv">
            ${group.rows.map((row) => html`<${RowCount} key=${row.model} row=${row} />`)}
          </dl>
        </div>`,
      )}
    </div>
    ${model.absent.length
      ? html`<p class="muted">${t("backup.absent_note", { count: model.absent.length, list: model.absent.map((name) => t(`backup.model_${name}`)).join(", ") })}</p>`
      : null}
    ${model.hasIgnored
      ? html`<div class="stack-sm">
          <strong>${t("backup.ignored_title")}</strong>
          <ul class="stack-sm">
            ${model.ignored.models.map((m) => html`<li key=${`m-${m.model}`}>${t("backup.ignored_model", { model: m.model, rows: formatNumber(m.rows) })}</li>`)}
            ${model.ignored.columns.map(
              (c) => html`<li key=${`c-${c.model}-${c.column}`}>${t("backup.ignored_column", { model: c.model, column: c.column, rows: formatNumber(c.rows) })}</li>`,
            )}
            ${model.ignored.settings ? html`<li>${t("backup.ignored_settings", { count: model.ignored.settings })}</li>` : null}
            ${model.ignored.texts ? html`<li>${t("backup.ignored_texts", { count: model.ignored.texts })}</li>` : null}
          </ul>
        </div>`
      : null}
  </div>`;
}

function RowCount({ row }) {
  return html`<${Fragment}><dt>${t(row.labelKey)}</dt><dd>${formatNumber(row.count)}</dd><//>`;
}

/** The phases of the running restore, with the one in progress marked */
function Progress({ progress }) {
  return html`<ol class="stack-sm" aria-label=${t("backup.progress_title")}>
    ${progress.stepList.map(
      (step) => html`<li key=${step.phase} aria-current=${step.state === "current" ? "step" : undefined}>
        <span class=${step.state === "failed" ? "badge badge-danger" : step.state === "current" ? "badge badge-info" : step.state === "done" ? "badge badge-ok" : "badge"}>
          ${t(`backup.phase_state_${step.state}`)}
        </span>
        ${" "}${t(step.labelKey)}
      </li>`,
    )}
  </ol>`;
}

/** What a finished or failed restore says */
function Outcome({ progress, preRestoreFile, onAgain }) {
  if (progress.done) {
    const warnings = restoreWarnings(progress.result);
    return html`<div class="stack">
      <div class="banner banner-info" role="status">
        <${Icon} name="check" />
        <div class="banner-body">${t("backup.done_message", { file: progress.result && progress.result.preRestoreFile ? progress.result.preRestoreFile : preRestoreFile || "-" })}</div>
      </div>
      ${warnings.map((code) => html`<div class="banner banner-warn" role="status" key=${code}><${Icon} name="warning" /><div class="banner-body">${t(/^restart_/.test(code) ? "backup.warning_restart" : `backup.warning_${code}`)}</div></div>`)}
      <div class="actions"><button type="button" class="btn" onClick=${onAgain}>${t("backup.done_again")}</button></div>
    </div>`;
  }
  const before = ["maintenance", "pre_backup", "database", null].includes(progress.failedPhase);
  return html`<div class="stack">
    <div class="banner banner-error" role="alert">
      <${Icon} name="error" />
      <div class="banner-body">
        <strong>${t("backup.failed_title")}</strong>
        <div>${progress.failedPhase ? t("backup.failed_phase", { phase: t(`jobs.phase.${progress.failedPhase}`) }) : null}</div>
        <div>${progress.reason ? t(`backup.failed_reason_${["file_altered", "secret_storage_unavailable", "busy"].includes(progress.reason) ? progress.reason : "other"}`) : null}</div>
        <div>${before ? t("backup.failed_kept") : t("backup.failed_replaced")}</div>
      </div>
    </div>
    <div class="actions"><button type="button" class="btn" onClick=${onAgain}>${t("backup.done_again")}</button></div>
  </div>`;
}

/** BAK-2 then BAK-3: pick a file and its passphrase, read the summary, confirm, follow the restore job. */
export function RestoreCard({ onRestored }) {
  useLanguage();
  const [stage, setStage] = useState("pick"); // pick | checking | review | running | finished
  const [file, setFile] = useState(null);
  const [passphrase, setPassphrase] = useState("");
  const [blocker, setBlocker] = useState(null);
  const [ratio, setRatio] = useState(0);
  const [step, setStep] = useState("upload");
  const [refusal, setRefusal] = useState(null);
  const [inspection, setInspection] = useState(null);
  const [job, setJob] = useState(null);
  const [now, setNow] = useState(Date.now());
  const kept = useRef(null); // { file, uploadId }: the server keeps an upload after a wrong passphrase
  const watching = useRef(null);
  const seen = useRef(new Map());

  // ----- the check ----------------------------------------------------------------------------------------
  const check = async (event) => {
    if (event && event.preventDefault) event.preventDefault();
    const problem = inspectBlocker({ file, passphrase });
    setBlocker(problem);
    if (problem) return;
    setRefusal(null);
    setRatio(0);
    setStep("upload");
    setStage("checking");
    try {
      let uploadId = kept.current && kept.current.file === file ? kept.current.uploadId : null;
      if (!uploadId) {
        const sent = await upload(file, "backup", file.name, (p) => setRatio(p.ratio));
        uploadId = sent.uploadId;
        kept.current = { file, uploadId };
      }
      setStep("verify");
      const answer = await api("POST", "/admin/api/backup/inspect", { uploadId, passphrase });
      kept.current = null;
      setInspection(answer);
      setNow(Date.now());
      setStage("review");
    } catch (err) {
      if (!canRetryWithSameFile(err)) kept.current = null; // the server dropped the file
      setRefusal(err);
      setStage("pick");
    }
  };

  const reset = () => {
    kept.current = null;
    watching.current = null;
    setStage("pick");
    setFile(null);
    setPassphrase("");
    setInspection(null);
    setJob(null);
    setRefusal(null);
    setBlocker(null);
  };

  // ----- the confirmation -----------------------------------------------------------------------------------
  useEffect(() => {
    if (stage !== "review") return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stage]);

  const remaining = inspection ? tokenRemainingMs(inspection.expiresAt, now) : 0;

  const settle = (event) => {
    if (!event || event.id !== watching.current) return;
    setJob(event);
    if (event.status === "running") return;
    watching.current = null;
    setStage("finished");
    if (event.status === "done" && onRestored) onRestored(event);
  };

  const follow = (started) => {
    watching.current = started.id;
    setStage("running");
    settle(seen.current.get(started.id) || started);
  };

  useLive("job", (event) => {
    if (!event || event.type !== "restore") return;
    seen.current.set(event.id, event);
    settle(event);
  });

  // a job being followed is also asked for now and then: an event lost in the restart never hangs the page
  useEffect(() => {
    if (stage !== "running" || !job) return undefined;
    const unwatch = live.watchJob(job.id);
    const timer = setInterval(() => {
      api("GET", `/admin/api/jobs/${job.id}`)
        .then((answer) => settle(answer.job))
        .catch(() => {});
    }, POLL_MS);
    return () => {
      unwatch();
      clearInterval(timer);
    };
  }, [stage, job && job.id]);

  const restore = async () => {
    const summary = inspection.summary;
    const ok = await confirm({
      title: t("backup.restore_confirm_title"),
      message: t("backup.restore_confirm_message", { date: summary.createdAt ? formatDateTime(summary.createdAt) : "-" }),
      confirmLabel: t("backup.restore_confirm_ok"),
    });
    if (!ok) return;
    setRefusal(null);
    try {
      const answer = await api("POST", "/admin/api/backup/restore", { restoreToken: inspection.restoreToken, confirm: true });
      follow(answer.job);
    } catch (err) {
      setRefusal(err);
      if (err && err.code === "restore_token_invalid") {
        setInspection(null);
        setStage("pick");
      }
    }
  };

  // ----- the screens ------------------------------------------------------------------------------------------
  const progress = restoreProgress(job);
  const percent = Math.round(ratio * 100);

  return html`<section class="card" aria-labelledby="backup-restore-title">
    <h2 class="card-title" id="backup-restore-title">${t("backup.restore_title")}</h2>
    <p class="muted">${t("backup.restore_intro")}</p>
    <div class="banner banner-warn" role="note">
      <${Icon} name="warning" />
      <div class="banner-body">${t("backup.two_installations_warning")}</div>
    </div>

    ${stage === "pick" || stage === "checking"
      ? html`<form class="form stack" onSubmit=${check} autocomplete="off" noValidate>
          <div class="field">
            <label class="field-label" for="backup-file">${t("backup.file_label")}</label>
            <input
              class="input"
              id="backup-file"
              name="backup_file"
              type="file"
              accept=".owb,application/octet-stream"
              disabled=${stage === "checking"}
              onChange=${(event) => {
                const picked = event.currentTarget.files && event.currentTarget.files[0];
                setFile(picked || null);
                setBlocker(null);
              }}
            />
            <div class="field-hint">${t("backup.file_hint")}</div>
            ${blocker === "no_file" || blocker === "empty_file" ? html`<div class="field-error" role="alert">${t(`backup.blocker_${blocker}`)}</div>` : null}
          </div>
          <${Field}
            label=${t("backup.restore_passphrase_label")}
            name="restore_passphrase"
            type="password"
            value=${passphrase}
            onChange=${(value) => {
              setPassphrase(value);
              setBlocker(null);
            }}
            error=${blocker === "passphrase_required" ? t("backup.blocker_passphrase_required") : null}
            autoComplete="off"
            disabled=${stage === "checking"}
            required
          />
          <${Refusal} error=${refusal} />
          ${stage === "checking"
            ? html`<div class="stack-sm" role="status">
                <progress max="1" value=${step === "upload" ? ratio : undefined} aria-label=${t("backup.checking")}></progress>
                <span class="muted">${step === "upload" ? t("backup.uploading", { percent }) : t("backup.verifying")}</span>
              </div>`
            : null}
          <div class="actions">
            <button type="submit" class="btn btn-primary" disabled=${stage === "checking"}>${t("backup.check_button")}</button>
          </div>
        </form>`
      : null}

    ${stage === "review" && inspection
      ? html`<div class="stack">
          <h3 class="card-title">${t("backup.summary_title")}</h3>
          <${SummaryView} summary=${inspection.summary} />
          <p class="muted" role="status">${remaining > 0 ? t("backup.token_valid", { remaining: formatDuration(remaining) }) : t("backup.token_expired")}</p>
          <div class="banner banner-warn" role="note">
            <${Icon} name="warning" />
            <div class="banner-body">${t("backup.replace_warning")}</div>
          </div>
          <${Refusal} error=${refusal} />
          <div class="actions">
            <button type="button" class="btn btn-danger" disabled=${remaining <= 0} onClick=${restore}><${Icon} name="backup" />${t("backup.restore_button")}</button>
            <button type="button" class="btn" onClick=${reset}>${t("backup.cancel_button")}</button>
          </div>
        </div>`
      : null}

    ${stage === "running" && progress
      ? html`<div class="stack" role="status">
          <h3 class="card-title">${t("backup.progress_title")}</h3>
          <p class="muted">${t("backup.progress_note")}</p>
          <${Progress} progress=${progress} />
        </div>`
      : null}

    ${stage === "finished" && progress
      ? html`<div class="stack">
          <h3 class="card-title">${progress.done ? t("backup.done_title") : t("backup.failed_title")}</h3>
          <${Outcome} progress=${progress} onAgain=${reset} />
        </div>`
      : null}
  </section>`;
}
