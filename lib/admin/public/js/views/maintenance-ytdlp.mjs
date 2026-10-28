// The download-tools card (MNT-4, MNT-5, FR-055): the yt-dlp version, whether it can update itself, the update behind a
// confirmation, and the verdict with the instructions that fit it. The command name is shown, never its path.

import { html, useState, useAsync, useAction, Spinner, EmptyState, StatusBadge } from "../components/index.mjs";
import { t, tError, formatNumber } from "../i18n.mjs";
import { api } from "../api.mjs";
import { confirm, toastError } from "../ui.mjs";
import { buildYtdlpModel, ytdlpResult } from "./maintenance-logic.mjs";
import { useJobFollower } from "./maintenance-job.mjs";

export function YtdlpCard() {
  const { data, error, loading, reload } = useAsync(() => api("GET", "/admin/api/maintenance/ytdlp"), []);
  const [result, setResult] = useState(null);
  const [busy, run] = useAction();
  const model = buildYtdlpModel(data);

  const [job, follow] = useJobFollower(["ytdlp.update"], async (final) => {
    if (final.status === "done") setResult(ytdlpResult(final.result));
    else toastError({ code: final.error && final.error.code, params: final.error && final.error.params });
    await reload();
  });

  const update = async () => {
    const ok = await confirm({
      title: t("maintenance.ytdlp_confirm_title"),
      message: t("maintenance.ytdlp_confirm_message"),
      confirmLabel: t("maintenance.ytdlp_update"),
      danger: false,
    });
    if (!ok) return;
    setResult(null);
    const answer = await run(() => api("POST", "/admin/api/maintenance/ytdlp/update", { confirm: true }));
    if (answer && answer.job) follow(answer.job);
  };

  if (!model) {
    return html`<section class="card">
      <h2 class="card-title">${t("maintenance.ytdlp_title")}</h2>
      ${
        loading
          ? html`<${Spinner} />`
          : html`<${EmptyState} icon="error" title=${error ? tError(error) : t("common.view_error")}>
              <button type="button" class="btn" onClick=${reload}>${t("common.retry")}</button>
            <//>`
      }
    </section>`;
  }

  const working = Boolean(job) || busy;
  return html`<section class="card" aria-labelledby="maintenance-ytdlp-title">
    <h2 class="card-title" id="maintenance-ytdlp-title">${t("maintenance.ytdlp_title")}</h2>
    <dl class="kv">
      <dt>${t("maintenance.ytdlp_command")}</dt><dd class="mono">${model.command}</dd>
      <dt>${t("maintenance.ytdlp_version")}</dt><dd class="mono">${model.version || t("common.unknown")}</dd>
      <dt>${t("maintenance.ytdlp_self_update")}</dt><dd>${t(model.selfUpdatableKey)}${model.reasonKey ? html` <span class="muted">(${t(model.reasonKey)})</span>` : null}</dd>
      <dt>${t("maintenance.ytdlp_downloads")}</dt><dd>${formatNumber(model.activeDownloads)}</dd>
    </dl>
    <div class="actions">
      <button type="button" class="btn" disabled=${working || !model.canUpdate} onClick=${update}>${t("maintenance.ytdlp_update")}</button>
    </div>
    ${model.blocked ? html`<p class="muted">${t(model.blocked === "missing" ? "maintenance.ytdlp_blocked_missing" : "maintenance.ytdlp_blocked_downloads")}</p>` : null}
    ${job ? html`<p role="status" class="muted">${t("maintenance.ytdlp_progress")}</p>` : null}
    ${
      result
        ? html`<div class="stack-sm" role="status">
            <p><${StatusBadge} tone=${result.tone} label=${t(result.verdictKey)} /></p>
            ${result.changed ? html`<p class="mono">${result.from} → ${result.to}</p>` : null}
            ${result.hintKey ? html`<p class="muted">${t(result.hintKey)}</p>` : null}
          </div>`
        : null
    }
  </section>`;
}
