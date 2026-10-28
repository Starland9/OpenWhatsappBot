// The update card (MNT-1 to MNT-3, US11 scenarios 1 to 3, FR-054): installed and remote versions, the list of
// changes, why an install cannot update itself, the how-to text of images and archives, the apply button behind a
// confirmation, the progress of the job and the "restart the program to finish" state (U6).

import { html, useState, useAsync, useAction, Spinner, EmptyState, Icon } from "../components/index.mjs";
import { t, tError, formatDateTime, formatNumber } from "../i18n.mjs";
import { api } from "../api.mjs";
import { confirm } from "../ui.mjs";
import { buildUpdateModel, applyConfirmation, applyFailure, checkFailureKey, jobProgress, INSTALL_KEYS, STATUS_KEYS } from "./maintenance-logic.mjs";
import { useJobFollower } from "./maintenance-job.mjs";

const UPDATE_JOBS = ["update.check", "update.apply"];

function Versions({ model }) {
  return html`<dl class="kv">
    <dt>${t("maintenance.installed_version")}</dt><dd class="mono">${model.localVersion || t("common.unknown")}</dd>
    <dt>${t("maintenance.latest_version")}</dt><dd class="mono">${model.remoteVersion || t("maintenance.not_checked")}</dd>
    <dt>${t("maintenance.install_type")}</dt><dd>${t(INSTALL_KEYS[model.installType])}</dd>
    ${model.branch ? html`<dt>${t("maintenance.branch")}</dt><dd class="mono">${model.branch}</dd>` : null}
    <dt>${t("maintenance.last_check")}</dt><dd>${model.checkedAt ? formatDateTime(model.checkedAt) : t("maintenance.not_checked")}</dd>
  </dl>`;
}

function Changes({ model }) {
  if (!model.commits.length) return null;
  return html`<div>
    <h3>${t("maintenance.changes_title", { count: model.behind })}</h3>
    <ul class="stack-sm">
      ${model.commits.map((c) => html`<li key=${c.sha}><span class="mono">${c.sha}</span> ${c.subject}</li>`)}
    </ul>
    ${model.moreCommits > 0 ? html`<p class="muted">${t("maintenance.changes_more", { count: formatNumber(model.moreCommits) })}</p>` : null}
  </div>`;
}

function Outcome({ outcome }) {
  if (!outcome) return null;
  if (outcome.kind === "apply_failed") {
    const failure = outcome.failure;
    return html`<div class="stack-sm" role="alert">
      <p><strong>${t("maintenance.apply_failed", { reason: t(failure.reasonKey) })}</strong></p>
      ${failure.phaseKey ? html`<p class="muted">${t("maintenance.failed_phase", { phase: t(failure.phaseKey) })}</p>` : null}
      <p class="muted">${failure.rolledBack ? t("maintenance.rolled_back") : t("maintenance.not_changed")}</p>
    </div>`;
  }
  if (outcome.kind === "check_failed") {
    return html`<p role="alert"><strong>${t("maintenance.check_failed", { reason: t(outcome.reasonKey) })}</strong></p>`;
  }
  if (outcome.kind === "up_to_date") return html`<p role="status">${t("maintenance.already_up_to_date")}</p>`;
  if (outcome.kind === "applied") {
    return html`<p role="status"><strong>${t(outcome.willRestart ? "maintenance.applied_restarting" : "maintenance.applied_manual", { from: outcome.from, to: outcome.to })}</strong></p>`;
  }
  return null;
}

export function UpdateCard() {
  const { data, error, loading, reload } = useAsync(() => api("GET", "/admin/api/maintenance/update"), []);
  const [outcome, setOutcome] = useState(null);
  const [applied, setApplied] = useState(false); // an update was installed in this session: nothing more to apply
  const [busy, run] = useAction();
  const model = buildUpdateModel(data);

  const [job, follow] = useJobFollower(UPDATE_JOBS, async (final) => {
    if (final.type === "update.check") {
      setOutcome(final.status === "done" ? null : { kind: "check_failed", reasonKey: checkFailureKey(final.error) });
    } else if (final.status === "done") {
      const result = final.result || {};
      if (!result.upToDate) setApplied(true);
      setOutcome(result.upToDate ? { kind: "up_to_date" } : { kind: "applied", from: result.from, to: result.to, willRestart: result.willRestart === true });
    } else {
      setOutcome({ kind: "apply_failed", failure: applyFailure(final.error) });
    }
    await reload();
  });

  const check = async () => {
    setOutcome(null);
    const answer = await run(() => api("POST", "/admin/api/maintenance/update/check", {}));
    if (answer && answer.job) follow(answer.job);
  };

  const apply = async () => {
    const asked = applyConfirmation(model);
    const ok = await confirm({
      title: t("maintenance.apply_title"),
      message: t(asked.messageKey, asked.params),
      confirmLabel: t("maintenance.apply_confirm"),
    });
    if (!ok) return;
    setOutcome(null);
    const answer = await run(() => api("POST", "/admin/api/maintenance/update/apply", { confirm: true }));
    if (answer && answer.job) follow(answer.job);
  };

  if (!model) {
    return html`<section class="card">
      <h2 class="card-title">${t("maintenance.update_title")}</h2>
      ${
        loading
          ? html`<${Spinner} />`
          : html`<${EmptyState} icon="error" title=${error ? tError(error) : t("common.view_error")}>
              <button type="button" class="btn" onClick=${reload}>${t("common.retry")}</button>
            <//>`
      }
    </section>`;
  }

  const progress = job ? jobProgress(job) : null;
  const working = Boolean(job) || busy;
  return html`<section class="card" aria-labelledby="maintenance-update-title">
    <h2 class="card-title" id="maintenance-update-title">${t("maintenance.update_title")}</h2>
    <${Versions} model=${model} />
    <p role="status">${t(STATUS_KEYS[model.status], { count: model.behind, version: model.remoteVersion || "" })}</p>
    ${model.ahead > 0 ? html`<p class="muted">${t("maintenance.ahead", { count: model.ahead })}</p>` : null}

    ${model.mode === "instructions" ? html`<p>${t(model.howToKey)}</p>` : null}
    ${
      model.blockers.length
        ? html`<div class="stack-sm">
            <h3>${t("maintenance.blockers_title")}</h3>
            <ul class="stack-sm">${model.blockers.map((b) => html`<li key=${b.code}><${Icon} name="warning" /> ${t(b.key)}</li>`)}</ul>
          </div>`
        : null
    }

    ${
      model.restartPending
        ? html`<p class="muted" role="status"><${Icon} name="info" /> ${t(model.supervised ? "maintenance.restart_pending_auto" : "maintenance.restart_pending_manual")}</p>`
        : null
    }

    <div class="actions">
      <button type="button" class="btn" disabled=${working} onClick=${check}><${Icon} name="refresh" />${t("maintenance.check")}</button>
      ${
        model.mode === "git"
          ? html`<button type="button" class="btn btn-primary" disabled=${working || applied || !model.canApply} onClick=${apply}>${t("maintenance.apply")}</button>`
          : null
      }
    </div>

    ${
      progress
        ? html`<p role="status" class="muted">
            ${job.type === "update.apply"
              ? t("maintenance.update_progress", { phase: progress.phaseKey ? t(progress.phaseKey) : t("jobs.type.update.apply"), step: progress.step || 1, steps: progress.steps })
              : t("maintenance.check_progress")}
          </p>`
        : null
    }
    <${Outcome} outcome=${outcome} />
    <${Changes} model=${model} />
  </section>`;
}

