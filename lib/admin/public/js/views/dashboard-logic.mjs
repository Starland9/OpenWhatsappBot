// Pure logic of the dashboard (US2, FR-012, FR-013): no DOM, no network, no timer, so node:test can import it.
// The view (dashboard.mjs) turns these view models into markup; every text still goes through t().

export const CLIENT_STATUSES = ["idle", "connecting", "qr", "open", "reconnecting", "restarting", "stopped", "logged_out"];

// FR-012: `open` is "connecté", `qr` and `logged_out` are "en attente d'appairage", the rest is "déconnecté" or
// a transition ("connexion en cours").
const GROUPS = {
  open: "connected",
  qr: "pairing",
  logged_out: "pairing",
  connecting: "transitional",
  reconnecting: "transitional",
  restarting: "transitional",
  idle: "disconnected",
  stopped: "disconnected",
};

const TONES = { connected: "ok", pairing: "warn", transitional: "info", disconnected: "neutral" };

/**
 * What to show for a client status: `{ status, group, tone, labelKey }`. An unknown status reads as `idle`
 * (disconnected) so a future status never breaks the page. `labelKey` is a `status.<id>` key of the catalog.
 */
export function statusInfo(status) {
  const id = CLIENT_STATUSES.includes(status) ? status : "idle";
  const group = GROUPS[id];
  return { status: id, group, tone: TONES[group], labelKey: `status.${id}` };
}

/** Seconds -> `{ days, hours, minutes, seconds }` (negative or invalid input reads as 0). */
export function uptimeParts(totalSeconds) {
  let rest = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const days = Math.floor(rest / 86400);
  rest -= days * 86400;
  const hours = Math.floor(rest / 3600);
  rest -= hours * 3600;
  const minutes = Math.floor(rest / 60);
  return { days, hours, minutes, seconds: rest - minutes * 60 };
}

/**
 * Uptime to show now: the server's `uptimeSec` plus the time that went by since the state reached the browser, so
 * the figure moves every second between two events. Both times are the browser's own clock (no skew).
 */
export function liveUptime(uptimeSec, receivedAt, nowMs) {
  const base = Math.max(0, Math.floor(Number(uptimeSec) || 0));
  const received = Number(receivedAt);
  const now = Number(nowMs);
  if (!Number.isFinite(received) || !Number.isFinite(now) || now <= received) return base;
  return base + Math.floor((now - received) / 1000);
}

/** Bytes -> megabytes with one decimal under 10 and none above (`123456789` -> 117.7, `5242880` -> 5). */
export function toMegabytes(bytes) {
  const mb = Math.max(0, Number(bytes) || 0) / (1024 * 1024);
  return mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10;
}

/** Share of the heap in use, 0 to 100 (0 when the total is unknown). */
export function heapPercent(memory) {
  const used = Number(memory && memory.heapUsed) || 0;
  const total = Number(memory && memory.heapTotal) || 0;
  if (total <= 0) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}

/** The memory block as rows for the view: `[{ key, bytes }]` in a fixed order, missing values read as 0. */
export function memoryRows(memory) {
  const source = memory && typeof memory === "object" ? memory : {};
  return ["rss", "heapUsed", "heapTotal", "external"].map((key) => ({ key, bytes: Math.max(0, Number(source[key]) || 0) }));
}

/**
 * The "last errors" list: newest first as the server sends it. Each entry becomes `{ key, ts, name, summary, detail }`
 * where `summary` is the first non-empty line (cut to `maxSummary` characters) and `detail` the rest, which is
 * a stack most of the time. Entries that are not objects are skipped; a text is always a string.
 */
export function shapeErrors(errors, { maxSummary = 200 } = {}) {
  if (!Array.isArray(errors)) return [];
  const out = [];
  for (const entry of errors) {
    if (!entry || typeof entry !== "object") continue;
    const text = entry.msg === undefined || entry.msg === null ? "" : String(entry.msg);
    const lines = text.split("\n");
    const first = lines.findIndex((line) => line.trim() !== "");
    const head = first === -1 ? "" : lines[first].trim();
    const summary = head.length > maxSummary ? `${head.slice(0, maxSummary - 1)}…` : head;
    const detail = first === -1 ? "" : lines.slice(first + 1).join("\n").trim();
    out.push({
      key: entry.seq !== undefined && entry.seq !== null ? entry.seq : out.length,
      ts: typeof entry.ts === "string" ? entry.ts : null,
      name: entry.name === undefined || entry.name === null ? "" : String(entry.name),
      summary,
      detail: head.length > maxSummary ? `${head}\n${detail}`.trim() : detail,
    });
  }
  return out;
}

export const RESTART_PHASES = ["stop", "settings", "start", "ready"];

/**
 * Progress of a job for the dashboard: `{ id, type, typeKey, phase, phaseKey, step, steps, running, failed, done }`
 * with `typeKey` / `phaseKey` into `jobs.type.*` / `jobs.phase.*` (null for a phase without a label). `step` of
 * `steps` is only known for the restart phases.
 */
export function jobProgress(job) {
  if (!job || typeof job !== "object") return null;
  const index = RESTART_PHASES.indexOf(job.phase);
  const known = job.type === "restart" && index !== -1;
  return {
    id: job.id,
    type: job.type,
    typeKey: `jobs.type.${job.type}`,
    phase: job.phase || null,
    phaseKey: job.phase ? `jobs.phase.${job.phase}` : null,
    step: known ? index + 1 : 0,
    steps: known ? RESTART_PHASES.length : 0,
    running: job.status === "running",
    failed: job.status === "failed",
    done: job.status === "done",
  };
}

/** Reason code of a failed restart job (`restart_failed` + `params.reason`), reduced to a known one. */
export function restartFailureReason(job) {
  const reason = job && job.error && job.error.params && job.error.params.reason;
  return ["timeout", "busy", "unavailable"].includes(reason) ? reason : "failed";
}

/**
 * May the Restart button be used? Not while another operation runs (the server answers `busy`), while a restart is
 * under way or while a restore is applying. `reason` is one of `job`, `restarting`, `maintenance` (a hint under
 * the button), null when the button is available.
 */
export function restartAvailability(state, localJob = null) {
  if (state && state.maintenance) return { disabled: true, reason: "maintenance" };
  if (state && state.bot && state.bot.status === "restarting") return { disabled: true, reason: "restarting" };
  const running = (state && state.job && state.job.status === "running") || (localJob && localJob.status === "running");
  if (running) return { disabled: true, reason: "job" };
  return { disabled: false, reason: null };
}

/**
 * Everything the dashboard shows, from a DASH-1 object. `receivedAt` and `now` (browser milliseconds) keep the
 * uptime moving between two events. Returns null while no state has arrived.
 */
export function buildDashboardModel(state, { receivedAt, now, localJob = null } = {}) {
  if (!state || typeof state !== "object" || !state.bot) return null;
  const bot = state.bot;
  return {
    status: statusInfo(bot.status),
    number: bot.number || null,
    since: bot.since || null,
    uptimeSec: liveUptime(bot.uptimeSec, receivedAt, now),
    version: bot.version === undefined ? null : bot.version,
    messagesProcessed: Number(bot.messagesProcessed) || 0,
    lastActivity: bot.lastActivity || null,
    registered: Boolean(bot.registered),
    memory: memoryRows(state.memory),
    heapPercent: heapPercent(state.memory),
    errors: shapeErrors(state.errors),
    restart: restartAvailability(state, localJob),
    job: jobProgress(state.job),
    database: state.db === "unavailable" ? "unavailable" : "ok",
  };
}
