// One broadcast: its derived state, the live progress of its latest run, cancel, the per-destination report, and
// the "new broadcast to the failed destinations" button that opens the ordinary create form pre-filled (U14: there
// is no re-send action; a failed destination is served again only by a new broadcast the owner confirms).
// Pause, resume, edit and delete are offered for recurring messages.
import {
  html,
  useState,
  useEffect,
  useAsync,
  useAction,
  useLanguage,
  useLive,
  DataTable,
  EmptyState,
  Icon,
  Spinner,
  StatusBadge,
} from "../components/index.mjs";
import { t, tError, formatDateTime, formatBytes } from "../i18n.mjs";
import { api } from "../api.mjs";
import { live } from "../live.mjs";
import { confirm, toastSuccess } from "../ui.mjs";
import { navigate } from "../router.mjs";
import {
  stateTone,
  targetTone,
  closesRun,
  mergeDetailProgress,
  openRun,
  runProgress,
  failedSummary,
  ruleText,
  labelOf,
  isUnsureCode,
} from "./broadcasts-logic.mjs";

function Lines({ text }) {
  const lines = String(text || "").split("\n");
  return html`<p>${lines.map((line, index) => html`${index ? html`<br />` : null}${line}`)}</p>`;
}

/** The state badge, with who paused it */
export function StateBadge({ broadcast }) {
  const label = broadcast.paused ? t(`broadcasts.paused_${broadcast.paused.by}`) : t(`broadcasts.state_${broadcast.state}`);
  return html`<${StatusBadge} tone=${stateTone(broadcast.state)} label=${label} />`;
}

/** Sent / failed / cancelled / waiting counters of a run, with a bar while it is open */
export function RunCounters({ run }) {
  if (!run) return html`<span class="muted">${t("broadcasts.no_run_yet")}</span>`;
  const { done, total, ratio } = runProgress(run);
  const open = run.status === "scheduled" || run.status === "running";
  return html`<div class="stack-sm">
    <span class="nowrap">${t("broadcasts.counters", { sent: run.sent, failed: run.failed, cancelled: run.cancelled, pending: run.pending })}</span>
    ${open ? html`<progress max="1" value=${ratio} aria-label=${t("broadcasts.progress_label", { done, total })}></progress>` : null}
  </div>`;
}

function RunReport({ broadcast, run, onClose }) {
  useLanguage();
  const { data, error, loading, reload } = useAsync(
    () => api("GET", `/admin/api/broadcasts/${broadcast.id}/runs/${run.id}`),
    [broadcast.id, run.id, run.status, run.sent, run.failed, run.cancelled],
  );
  if (loading && !data) return html`<${Spinner} />`;
  if (error && !data) {
    return html`<${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}>
      <button type="button" class="btn" onClick=${reload}><${Icon} name="refresh" />${t("common.retry")}</button>
    <//>`;
  }
  const summary = failedSummary(data);
  const columns = [
    { key: "position", label: t("broadcasts.col_position"), align: "right", render: (row) => row.position },
    {
      key: "name",
      label: t("broadcasts.col_name"),
      render: (row) => html`<div class="stack-sm"><span>${row.name || html`<span class="muted">${t("broadcasts.no_name")}</span>`}</span>${row.selectable ? null : html`<span class="muted">${t("broadcasts.not_selectable")}</span>`}</div>`,
    },
    { key: "status", label: t("broadcasts.col_status"), render: (row) => html`<${StatusBadge} tone=${targetTone(row.status)} label=${t(`broadcasts.target_${row.status}`)} />` },
    {
      key: "error",
      label: t("broadcasts.col_error"),
      render: (row) =>
        row.errorCode
          ? html`<div class="stack-sm"><span>${t(`broadcasts.error_${row.errorCode}`)}</span>${row.mayHaveBeenDelivered || isUnsureCode(row.errorCode) ? html`<span class="badge badge-warn" title=${t("broadcasts.unsure_hint")}>${t("broadcasts.unsure_flag")}</span>` : null}</div>`
          : html`<span class="muted">—</span>`,
    },
    { key: "sentAt", label: t("broadcasts.col_sent_at"), render: (row) => (row.sentAt ? formatDateTime(row.sentAt, { dateStyle: "short", timeStyle: "medium" }) : "—") },
  ];

  return html`<section class="card stack" aria-live="polite">
    <div class="view-header">
      <h2 class="card-title">${t("broadcasts.report_title", { date: formatDateTime(data.run.dueAt) })}</h2>
      <button type="button" class="btn btn-sm" onClick=${onClose}>${t("common.close")}</button>
    </div>
    <${RunCounters} run=${data.run} />
    <${DataTable} columns=${columns} rows=${data.targets} rowKey="chatJid" caption=${t("broadcasts.report_caption")} empty=${html`<${EmptyState} icon="info" title=${t("broadcasts.report_empty")} />`} />
    ${summary.failed > 0
      ? html`<div class="stack-sm">
          <p class="muted">${t("broadcasts.failed_summary", { count: summary.failed, failed: summary.failed, selectable: summary.selectable, unsure: summary.unsure })}${summary.unselectable ? ` ${t("broadcasts.failed_unselectable", { count: summary.unselectable })}` : ""}</p>
          <div>
            <button type="button" class="btn btn-primary" disabled=${summary.selectable === 0} onClick=${() => navigate("broadcasts", ["new"], { from: broadcast.id, run: run.id })}><${Icon} name="plus" />${t("broadcasts.new_to_failed")}</button>
          </div>
          <p class="field-hint">${t("broadcasts.new_to_failed_hint")}</p>
        </div>`
      : null}
  </section>`;
}

export function BroadcastDetail({ id }) {
  const lang = useLanguage();
  const { data, error, loading, reload } = useAsync(() => api("GET", `/admin/api/broadcasts/${id}`), [id]);
  const [view, setView] = useState(null);
  const [reportRun, setReportRun] = useState(null);
  const [busy, run] = useAction();

  useEffect(() => setView(data), [data]);
  // while this page is open the polling fallback follows this broadcast too
  useEffect(() => live.watchBroadcast(id), [id]);
  useLive("job", (event) => {
    if (!event || event.type !== "broadcast" || event.broadcastId !== Number(id)) return;
    const known = view && view.runs.some((r) => r.id === event.runId);
    if (closesRun(event) || !known) reload();
    else setView((current) => mergeDetailProgress(current, event));
  });

  const back = html`<a class="btn btn-sm" href="#/broadcasts"><${Icon} name="chevron-left" />${t("common.back")}</a>`;
  if (loading && !view) return html`<section class="view"><div class="view-header"><h1>${t("broadcasts.title")}</h1></div><${Spinner} /></section>`;
  if (error && !view) {
    return html`<section class="view">
      <div class="view-header"><h1>${t("broadcasts.title")}</h1>${back}</div>
      <${EmptyState} icon="error" title=${t("common.view_error")} message=${tError(error)}>
        <button type="button" class="btn" onClick=${reload}><${Icon} name="refresh" />${t("common.retry")}</button>
      <//>
    </section>`;
  }
  if (!view) return null;

  const { broadcast, runs, nextOccurrences } = view;
  const recurring = broadcast.kind === "recurring";
  const open = openRun(view);
  const rule = ruleText(broadcast.recurrence, lang);
  const selectedRun = reportRun ? runs.find((r) => r.id === reportRun) : null;

  const act = (work) =>
    run(async () => {
      await work();
      await reload();
    });

  const cancel = () =>
    act(async () => {
      const ok = await confirm({ title: t("broadcasts.cancel_title"), message: t("broadcasts.cancel_message"), confirmLabel: t("broadcasts.cancel_confirm"), danger: true });
      if (!ok) return;
      await api("POST", `/admin/api/broadcasts/${broadcast.id}/cancel`, {});
      toastSuccess(t("broadcasts.cancelled"));
    });

  const toggle = (action) =>
    act(async () => {
      await api("POST", `/admin/api/broadcasts/${broadcast.id}/${action}`, {});
      toastSuccess(t(action === "pause" ? "broadcasts.paused_done" : "broadcasts.resumed_done"));
    });

  const remove = () =>
    run(async () => {
      const ok = await confirm({ title: t("broadcasts.delete_title"), message: t("broadcasts.delete_message", { count: runs.length }), confirmLabel: t("common.delete"), danger: true });
      if (!ok) return;
      await api("DELETE", `/admin/api/broadcasts/${broadcast.id}?confirm=true`);
      toastSuccess(t("broadcasts.deleted"));
      navigate("broadcasts");
    });

  const runColumns = [
    { key: "dueAt", label: t("broadcasts.col_due"), render: (row) => formatDateTime(row.dueAt) },
    {
      key: "status",
      label: t("broadcasts.col_status"),
      render: (row) => html`<div class="stack-sm"><${StatusBadge} tone=${stateTone(row.status)} label=${t(`broadcasts.state_${row.status}`)} />${row.note ? html`<span class="muted">${t(`broadcasts.note_${row.note}`)}</span>` : null}</div>`,
    },
    { key: "counters", label: t("broadcasts.col_progress"), render: (row) => html`<${RunCounters} run=${row} />` },
    {
      key: "actions",
      label: t("broadcasts.col_actions"),
      render: (row) => html`<div class="cell-actions"><button type="button" class="btn btn-sm" aria-pressed=${reportRun === row.id} disabled=${row.total === 0} onClick=${() => setReportRun(reportRun === row.id ? null : row.id)}>${t("broadcasts.report_button")}</button></div>`,
    },
  ];

  return html`<section class="view stack">
    <div class="view-header">
      <h1>${labelOf(broadcast)}</h1>
      <div class="row-wrap">
        ${back}
        <button type="button" class="btn btn-sm" disabled=${busy} onClick=${reload}><${Icon} name="refresh" />${t("common.refresh")}</button>
      </div>
    </div>

    <section class="card stack">
      <div class="row-wrap">
        <${StateBadge} broadcast=${broadcast} />
        <${StatusBadge} tone="neutral" label=${t(`broadcasts.kind_${broadcast.kind}`)} />
        ${broadcast.paused && broadcast.paused.by === "disconnected" ? html`<span class="muted">${t("broadcasts.paused_disconnected_hint")}</span>` : null}
      </div>
      <${Lines} text=${broadcast.text} />
      <dl class="kv">
        <dt>${t("broadcasts.preview_destinations")}</dt><dd>${broadcast.targetCount}</dd>
        <dt>${t("broadcasts.preview_spacing")}</dt><dd>${t("broadcasts.seconds", { n: broadcast.spacingMs / 1000 })}</dd>
        <dt>${t("broadcasts.preview_media")}</dt>
        <dd>${broadcast.mediaKind
          ? html`<span class="mono">${broadcast.mediaName}</span> <span class="muted">(${t(`broadcasts.media_kind_${broadcast.mediaKind}`)}${broadcast.mediaSize ? ` · ${formatBytes(broadcast.mediaSize)}` : ""})</span> ${broadcast.mediaAvailable === false ? html`<span class="badge badge-warn">${t("broadcasts.media_gone")}</span>` : null}`
          : t("broadcasts.media_none_short")}</dd>
        ${rule ? html`<dt>${t("broadcasts.field_rule")}</dt><dd>${t(rule.key, rule.params)}</dd>` : null}
        ${recurring && broadcast.nextRunAt && broadcast.state !== "paused" ? html`<dt>${t("broadcasts.next_run")}</dt><dd>${formatDateTime(broadcast.nextRunAt)}</dd>` : null}
        ${!recurring && broadcast.runAt ? html`<dt>${t("broadcasts.run_at")}</dt><dd>${formatDateTime(broadcast.runAt)}</dd>` : null}
        <dt>${t("broadcasts.created_at")}</dt><dd>${formatDateTime(broadcast.createdAt)}</dd>
      </dl>
      ${nextOccurrences && nextOccurrences.length
        ? html`<div class="stack-sm"><strong>${t("broadcasts.preview_next")}</strong><ul>${nextOccurrences.map((instant) => html`<li key=${instant}>${formatDateTime(instant, { dateStyle: "full", timeStyle: "short" })}</li>`)}</ul></div>`
        : null}
      ${broadcast.latestRun ? html`<div class="stack-sm"><strong>${t("broadcasts.latest_run")}</strong><${RunCounters} run=${broadcast.latestRun} /></div>` : null}
      ${broadcast.mediaAvailable === false && !recurring ? html`<p class="muted">${t("broadcasts.media_gone_hint")}</p>` : null}

      <div class="actions">
        ${open ? html`<button type="button" class="btn btn-danger" disabled=${busy} onClick=${cancel}>${t("broadcasts.cancel_button")}</button>` : null}
        ${recurring && broadcast.paused && broadcast.paused.by === "admin" ? html`<button type="button" class="btn" disabled=${busy} onClick=${() => toggle("resume")}>${t("broadcasts.resume")}</button>` : null}
        ${recurring && !(broadcast.paused && broadcast.paused.by === "admin") ? html`<button type="button" class="btn" disabled=${busy} onClick=${() => toggle("pause")}>${t("broadcasts.pause")}</button>` : null}
        ${recurring ? html`<a class="btn" href=${`#/broadcasts/${broadcast.id}/edit`}><${Icon} name="edit" />${t("common.edit")}</a>` : null}
        <button type="button" class="btn btn-danger" disabled=${busy} onClick=${remove}><${Icon} name="trash" />${t("common.delete")}</button>
      </div>
    </section>

    <section class="stack">
      <h2>${t("broadcasts.runs_title")}</h2>
      <${DataTable} columns=${runColumns} rows=${runs} rowKey="id" caption=${t("broadcasts.runs_title")} empty=${html`<${EmptyState} icon="info" title=${t("broadcasts.runs_empty")} message=${t(recurring ? "broadcasts.runs_empty_recurring" : "broadcasts.runs_empty_once")} />`} />
    </section>

    ${selectedRun ? html`<${RunReport} key=${selectedRun.id} broadcast=${broadcast} run=${selectedRun} onClose=${() => setReportRun(null)} />` : null}
  </section>`;
}
