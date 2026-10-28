// Pure logic of the backup page (US10; admin-http-api.md 2.13): the passphrase rules, the bodies sent to BAK-1 to BAK-3,
// the shaping of the BAK-2 summary into the table shown before the confirmation, the reading of a refusal and of the
// restore job. No DOM access and no import: node:test loads this file as is.

/** The BAK-1 route */
export const EXPORT_PATH = "/admin/api/backup/export";

export const PASSPHRASE_MIN = 12;
export const PASSPHRASE_MAX = 256;

/** Phases of the `restore` job, in order (admin-http-api.md 1.16) */
export const RESTORE_PHASES = ["maintenance", "pre_backup", "database", "session", "finalize", "restarting"];

/** The 25 exported models in the groups the summary shows (data-model 4.3); `labelKey` is `backup.model_<name>` */
export const MODEL_GROUPS = [
  { id: "groups", models: ["Group", "GroupEconomy", "GroupRole", "Filter", "Warn", "BannedChat"] },
  {
    id: "features",
    models: ["AntiDelete", "ViewOnce", "AutoResponder", "User", "UserStats", "NotifyKeyword", "StickerCommand", "Idea", "Quote", "Task", "Reminder"],
  },
  { id: "config", models: ["SettingOverride", "CommandState", "TextOverride", "DailyStat", "KnownChat"] },
  { id: "jobs", models: ["Broadcast", "BroadcastRun", "BroadcastTarget"] },
];

export const ALL_MODELS = MODEL_GROUPS.flatMap((group) => group.models);

// ---- the passphrase -------------------------------------------------------------------------------------------

/** Length in code points of the NFKC form: the way the server counts (an emoji is one, "e" + accent is one) */
export function passphraseLength(text) {
  return Array.from(String(text === undefined || text === null ? "" : text).normalize("NFKC")).length;
}

/**
 * Check a passphrase before it is sent. `repeat` (when given) must be the same text. Returns null when it is fine,
 * else a field error `{ code, params? }` that `fields.<code>` translates: too_short, too_long, mismatch.
 */
export function checkPassphrase(passphrase, { repeat } = {}) {
  const length = passphraseLength(passphrase);
  if (length < PASSPHRASE_MIN) return { code: "too_short", params: { min: PASSPHRASE_MIN } };
  if (length > PASSPHRASE_MAX) return { code: "too_long", params: { max: PASSPHRASE_MAX } };
  if (repeat !== undefined && String(repeat).normalize("NFKC") !== String(passphrase).normalize("NFKC")) return { code: "mismatch" };
  return null;
}

// ---- BAK-1: the export -------------------------------------------------------------------------------------------

/**
 * Body of BAK-1. The session is only asked for after the person confirmed the takeover warning: `confirmSession`
 * then travels with `includeSession`, never alone.
 */
export function exportBody({ passphrase, includeSession = false, sessionConfirmed = false }) {
  const body = { passphrase };
  if (includeSession) {
    body.includeSession = true;
    body.confirmSession = Boolean(sessionConfirmed);
  }
  return body;
}

/** Name the browser saves the file under when the server sent none: `openwabot-backup-<yyyymmdd-HHmmss>.owb` (UTC) */
export function fallbackFileName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const d = now instanceof Date ? now : new Date(now);
  return `openwabot-backup-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.owb`;
}

// ---- BAK-2: the file and its summary ---------------------------------------------------------------------------------

/** Why the check cannot start yet: no_file, empty_file, passphrase_required; null when it can */
export function inspectBlocker({ file, passphrase }) {
  if (!file) return "no_file";
  if (!Number.isFinite(file.size) || file.size <= 0) return "empty_file";
  if (!passphrase) return "passphrase_required";
  return null;
}

const countOf = (counts, model) => {
  const n = counts && Number(counts[model]);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
};

/**
 * The BAK-2 summary as the table the person reads before confirming: a header (date, bot version, database type,
 * session), the counts per group and model, the data types the file does not hold (they will be emptied) and what was
 * ignored.
 * @returns {null | {
 *   createdAt: string, botVersion: string, dialect: string, includesSession: boolean, total: number,
 *   groups: Array<{ id: string, titleKey: string, total: number, rows: Array<{ model: string, labelKey: string, count: number }> }>,
 *   absent: string[], ignored: { models: Array<{model:string,rows:number}>, columns: Array<{model:string,column:string,rows:number}>, settings: number, texts: number },
 *   hasIgnored: boolean }}
 */
export function shapeSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  const counts = summary.counts && typeof summary.counts === "object" ? summary.counts : {};
  const absent = [];
  const groups = MODEL_GROUPS.map((group) => {
    const rows = [];
    for (const model of group.models) {
      const count = countOf(counts, model);
      if (count === null) {
        absent.push(model);
        continue;
      }
      rows.push({ model, labelKey: `backup.model_${model}`, count });
    }
    return { id: group.id, titleKey: `backup.group_${group.id}`, total: rows.reduce((sum, row) => sum + row.count, 0), rows };
  }).filter((group) => group.rows.length > 0);

  const ignored = {
    models: Array.isArray(summary.ignoredModels) ? summary.ignoredModels.map((m) => ({ model: String(m.model), rows: Number(m.rows) || 0 })) : [],
    columns: Array.isArray(summary.ignoredColumns)
      ? summary.ignoredColumns.map((c) => ({ model: String(c.model), column: String(c.column), rows: Number(c.rows) || 0 }))
      : [],
    settings: Number(summary.ignoredSettings) || 0,
    texts: Number(summary.ignoredTexts) || 0,
  };
  return {
    createdAt: summary.createdAt || "",
    botVersion: summary.botVersion || "",
    dialect: summary.dialect || "",
    includesSession: summary.includesSession === true,
    total: groups.reduce((sum, group) => sum + group.total, 0),
    groups,
    absent,
    ignored,
    hasIgnored: ignored.models.length > 0 || ignored.columns.length > 0 || ignored.settings > 0 || ignored.texts > 0,
  };
}

/** Milliseconds left on the restore token (0 once it ran out or when the date is unreadable) */
export function tokenRemainingMs(expiresAt, nowMs = Date.now()) {
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, at - nowMs);
}

// ---- refusals --------------------------------------------------------------------------------------------------------

/** Envelope codes whose message the backup page words itself (`backup.refusal_<code>`) */
export const REFUSAL_CODES = [
  "wrong_passphrase",
  "backup_corrupted",
  "backup_unsupported_format",
  "backup_too_new",
  "backup_invalid_row",
  "restore_token_invalid",
  "not_found",
  "busy",
  "maintenance",
  "unsupported_file_type",
  "payload_too_large",
  "upload_in_progress",
  "quota_exceeded",
  "rate_limited",
];

/**
 * How a refused request is explained on this page. `{ key, params }` for a message of the backup catalog, or null for a
 * code that the generic `errors.<code>` message already covers. Parameters are the ones the server derived (versions,
 * model, position, field); a submitted value is never in them.
 */
export function refusalFor(error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  if (!REFUSAL_CODES.includes(code)) return null;
  const given = (error && error.params) || {};
  const params = {};
  if (code === "backup_too_new") {
    params.backupVersion = given.backupVersion ?? "?";
    params.currentVersion = given.currentVersion ?? "?";
  } else if (code === "backup_invalid_row") {
    params.model = given.model ?? "?";
    params.index = Number.isInteger(given.index) ? given.index + 1 : "?"; // shown as a position, counting from 1
    params.field = given.field ?? "?";
  } else if (code === "payload_too_large") {
    params.maxBytes = given.maxBytes ?? "?";
  }
  return { key: `backup.refusal_${code}`, params };
}

/** Should the person type the passphrase again (the file is fine) rather than pick another file? */
export function canRetryWithSameFile(error) {
  return Boolean(error) && ["wrong_passphrase", "rate_limited", "busy"].includes(error.code);
}

// ---- the restore job ---------------------------------------------------------------------------------------------------

/**
 * The restore job as the progress block shows it: the phases with their state, the failure phase and reason.
 * @returns {null | { id: number, running: boolean, done: boolean, failed: boolean, step: number, steps: number,
 *   phase: string|null, phaseKey: string|null, steps_: Array<{ phase: string, labelKey: string, state: "done"|"current"|"todo"|"failed" }>,
 *   failedPhase: string|null, reason: string|null, result: object|null }}
 */
export function restoreProgress(job) {
  if (!job || typeof job !== "object") return null;
  const running = job.status === "running";
  const failed = job.status === "failed";
  const done = job.status === "done";
  const params = (job.error && job.error.params) || {};
  const failedPhase = failed ? (RESTORE_PHASES.includes(params.phase) ? params.phase : null) : null;
  const current = failed ? failedPhase : job.phase;
  const index = RESTORE_PHASES.indexOf(current);
  const steps = RESTORE_PHASES.map((phase, i) => {
    let state = "todo";
    if (done || (index !== -1 && i < index)) state = "done";
    else if (i === index) state = failed ? "failed" : "current";
    return { phase, labelKey: `jobs.phase.${phase}`, state };
  });
  return {
    id: job.id,
    running,
    done,
    failed,
    step: done ? RESTORE_PHASES.length : index === -1 ? 0 : index + 1,
    steps: RESTORE_PHASES.length,
    phase: job.phase || null,
    phaseKey: job.phase ? `jobs.phase.${job.phase}` : null,
    stepList: steps,
    failedPhase,
    reason: failed && typeof params.reason === "string" ? params.reason : null,
    result: done && job.result && typeof job.result === "object" ? job.result : null,
  };
}

/** Warnings of a finished restore (`result.warnings`) the page explains: only the known ones */
export function restoreWarnings(result) {
  const known = ["session_not_swapped", "reload_failed", "media_not_restored", "status_not_restored"];
  const list = result && Array.isArray(result.warnings) ? result.warnings : [];
  return list.filter((code) => known.includes(code) || /^restart_/.test(code));
}

// ---- BAK-4: the stored pre-restore backups ----------------------------------------------------------------------------------

/** Rows of the stored-backups table, newest first, as the server sent them (`{ name, kind, size, createdAt }`) */
export function storedRows(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item.name === "string" && /^pre-restore-[0-9A-Za-z_-]{1,40}\.owb$/.test(item.name))
    .map((item) => ({ name: item.name, size: Number(item.size) || 0, createdAt: item.createdAt || "", path: `/admin/api/backup/stored/${item.name}` }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.name < b.name ? 1 : -1));
}
