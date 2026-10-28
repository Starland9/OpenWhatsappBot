import { html, Fragment, useState, useEffect, useRef, useStore, useLive, useAction, StatusBadge, EmptyState, Spinner, Icon } from "../components/index.mjs";
import { t, tError, formatDateTime, formatBytes, formatNumber, formatUptime } from "../i18n.mjs";
import { api } from "../api.mjs";
import { live } from "../live.mjs";
import { buildHash } from "../router.mjs";
import { botStore, confirm, toastSuccess, toastError } from "../ui.mjs";
import { buildDashboardModel, restartFailureReason } from "./dashboard-logic.mjs";
import { messageLines } from "./logs-logic.mjs";

export const meta = { area: "dashboard", titleKey: "dashboard.title", icon: "dashboard" };

const MEMORY_LABELS = {
  rss: "dashboard.memory_rss",
  heapUsed: "dashboard.memory_heap_used",
  heapTotal: "dashboard.memory_heap_total",
  external: "dashboard.memory_external",
};

/** The state pushed by the live stream (app.mjs keeps it in botStore), with one immediate fetch on arrival. */
function useDashboardState() {
  const { state, connection } = useStore(botStore);
  const [error, setError] = useState(null);
  const received = useRef({ state: null, at: Date.now() });
  const [, setTick] = useState(0);
  if (state !== received.current.state) received.current = { state, at: Date.now() };

  const load = async () => {
    try {
      const data = await api("GET", "/admin/api/state");
      setError(null);
      botStore.set({ state: data });
    } catch (err) {
      setError(err);
    }
  };

  useEffect(() => {
    if (!botStore.get().state) load();
  }, []);
  // the uptime moves every second between two events
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return { state, connection, receivedAt: received.current.at, error, reload: load };
}

function ConnectionCard({ model }) {
  return html`<section class="card">
    <h2 class="card-title">${t("dashboard.connection")}</h2>
    <dl class="kv">
      <dt>${t("dashboard.status")}</dt><dd><span class="nowrap"><${StatusBadge} status=${model.status.status} /></span></dd>
      <dt>${t("dashboard.number")}</dt><dd class="mono">${model.number || t("dashboard.number_none")}</dd>
      <dt>${t("dashboard.since")}</dt><dd>${model.since ? formatDateTime(model.since) : t("common.none")}</dd>
      <dt>${t("dashboard.uptime")}</dt><dd>${formatUptime(model.uptimeSec)}</dd>
      <dt>${t("dashboard.version")}</dt><dd class="mono">${model.version || t("common.unknown")}</dd>
    </dl>
    ${
      model.status.group === "pairing"
        ? html`<p class="muted">${t("dashboard.pairing_hint")} <a href=${buildHash("pairing")}>${t("dashboard.pairing_link")}</a></p>`
        : null
    }
  </section>`;
}

function ActivityCard({ model }) {
  return html`<section class="card">
    <h2 class="card-title">${t("dashboard.activity")}</h2>
    <dl class="kv">
      <dt>${t("dashboard.messages")}</dt><dd>${formatNumber(model.messagesProcessed)}</dd>
      <dt>${t("dashboard.last_activity")}</dt><dd>${model.lastActivity ? formatDateTime(model.lastActivity) : t("common.none")}</dd>
      ${model.memory.map((row) => html`<${Fragment} key=${row.key}><dt>${t(MEMORY_LABELS[row.key])}</dt><dd>${formatBytes(row.bytes)}</dd><//>`)}
    </dl>
  </section>`;
}

function ErrorsCard({ model }) {
  return html`<section class="card">
    <h2 class="card-title">${t("dashboard.errors")}</h2>
    ${
      model.errors.length
        ? html`<ul class="stack-sm" aria-live="polite">
            ${model.errors.map(
              (entry) => html`<li key=${entry.key}>
                <div><span class="muted">${entry.ts ? formatDateTime(entry.ts, { dateStyle: "short", timeStyle: "medium" }) : ""}</span> ${entry.name ? html`<span class="mono">${entry.name}</span>` : null}</div>
                <div>${entry.summary}</div>
                ${
                  entry.detail
                    ? html`<details><summary class="muted">${t("dashboard.error_details")}</summary><div class="mono">${messageLines(entry.detail).map((line, index) => html`<div key=${index}>${line || "\u00a0"}</div>`)}</div></details>`
                    : null
                }
              </li>`,
            )}
          </ul>`
        : html`<p class="muted">${t("dashboard.no_errors")}</p>`
    }
  </section>`;
}

/** The job answers come over the live stream or a poll; the last one seen of each job is kept by id. */
function useRestartJob() {
  const [job, setJob] = useState(null);
  const seen = useRef(new Map()); // id -> latest event, even one that arrives before the POST answer does
  const watching = useRef(null);

  const settle = (event) => {
    if (!event || event.id !== watching.current) return;
    if (event.status === "running") {
      setJob(event);
      return;
    }
    watching.current = null;
    setJob(null);
    if (event.status === "done") toastSuccess(t("dashboard.restart_done"));
    else toastError(t("dashboard.restart_failed", { reason: t(`dashboard.restart_reason_${restartFailureReason(event)}`) }));
  };

  useLive("job", (event) => {
    if (!event || event.type !== "restart") return;
    seen.current.set(event.id, event);
    settle(event);
  });

  // a job that is being followed is also asked for now and then: an event lost in a reconnection never hangs the page
  useEffect(() => {
    if (!job) return undefined;
    const unwatch = live.watchJob(job.id);
    const timer = setInterval(() => {
      api("GET", `/admin/api/jobs/${job.id}`)
        .then((answer) => settle(answer.job))
        .catch(() => {});
    }, 3000);
    return () => {
      unwatch();
      clearInterval(timer);
    };
  }, [job && job.id]);

  /** The POST answered with a running job: follow it, and apply what the stream already said about it. */
  const follow = (started) => {
    watching.current = started.id;
    settle(seen.current.get(started.id) || started);
  };
  return [job, follow];
}

/** Restart button, its confirmation (FR-039), and the progress of the job it starts. */
function RestartControl({ model }) {
  const [busy, run] = useAction();
  const [job, follow] = useRestartJob();

  const availability = job ? { disabled: true, reason: "job" } : model.restart;

  const restart = async () => {
    const ok = await confirm({
      title: t("dashboard.restart_title"),
      message: t("dashboard.restart_message"),
      confirmLabel: t("dashboard.restart_confirm"),
    });
    if (!ok) return;
    const answer = await run(() => api("POST", "/admin/api/restart", { confirm: true }));
    if (answer && answer.job) follow(answer.job);
  };

  const progress = model.job && model.job.type === "restart" ? model.job : null;
  return html`<div class="stack-sm">
    <div class="actions">
      <button type="button" class="btn btn-danger" disabled=${busy || availability.disabled} onClick=${restart}>
        <${Icon} name="refresh" />${t("dashboard.restart")}
      </button>
    </div>
    ${availability.reason ? html`<p class="muted">${t(`dashboard.restart_blocked_${availability.reason}`)}</p>` : null}
    ${
      progress && progress.running
        ? html`<p role="status" class="muted">
            ${t("dashboard.restart_progress", {
              phase: progress.phaseKey ? t(progress.phaseKey) : t("jobs.type.restart"),
              step: progress.step || 1,
              steps: progress.steps || 4,
            })}
          </p>`
        : null
    }
  </div>`;
}

/** US2: the state of the bot at a glance, a live view (SSE, polling fallback) and the in-process restart. */
export default function DashboardView() {
  const { state, connection, receivedAt, error, reload } = useDashboardState();
  const model = buildDashboardModel(state, { receivedAt, now: Date.now() });

  if (!model) {
    if (error) {
      return html`<section class="view">
        <div class="view-header"><h1>${t("dashboard.title")}</h1></div>
        <${EmptyState} icon="error" title=${tError(error)}>
          <button type="button" class="btn" onClick=${reload}>${t("common.retry")}</button>
        <//>
      </section>`;
    }
    return html`<section class="view">
      <div class="view-header"><h1>${t("dashboard.title")}</h1></div>
      <${Spinner} />
    </section>`;
  }

  return html`<section class="view stack">
    <div class="view-header">
      <h1>${t("dashboard.title")}</h1>
      <button type="button" class="btn btn-sm" onClick=${reload}><${Icon} name="refresh" />${t("common.refresh")}</button>
    </div>
    ${connection === "polling" ? html`<p class="muted" role="status">${t("dashboard.polling")}</p>` : null}
    <div class="grid">
      <${ConnectionCard} model=${model} />
      <${ActivityCard} model=${model} />
    </div>
    <${ErrorsCard} model=${model} />
    <section class="card">
      <h2 class="card-title">${t("dashboard.restart_section")}</h2>
      <${RestartControl} model=${model} />
    </section>
  </section>`;
}
