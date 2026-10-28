// Pure logic of the maintenance page (US11, FR-054 to FR-056): no DOM, no network, no timer, so node:test can import
// it. The views (maintenance*.mjs) turn these models into markup; every text still goes through t(). The i18n keys
// are written out literally in the maps below so a scan (and test/admin-view-maintenance.test.js) can check them.

// ---- update (MNT-1 to MNT-3) --------------------------------------------------------------------------------

/** Phases of an `update.apply` job, in order (admin-http-api.md 1.16) */
export const APPLY_PHASES = Object.freeze(["fetch", "merge", "install", "verify"]);

export const PHASE_KEYS = Object.freeze({
  fetch: "jobs.phase.fetch",
  merge: "jobs.phase.merge",
  install: "jobs.phase.install",
  verify: "jobs.phase.verify",
});

/** Why an install cannot update itself, and what to do about it (reason codes of `update_unavailable`) */
export const BLOCKER_KEYS = Object.freeze({
  image: "maintenance.blocker_image",
  archive: "maintenance.blocker_archive",
  no_git_binary: "maintenance.blocker_no_git_binary",
  dubious_ownership: "maintenance.blocker_dubious_ownership",
  detached: "maintenance.blocker_detached",
  no_remote_branch: "maintenance.blocker_no_remote_branch",
  dirty_tree: "maintenance.blocker_dirty_tree",
  not_writable: "maintenance.blocker_not_writable",
});

/** Install type as the card names it */
export const INSTALL_KEYS = Object.freeze({
  git: "maintenance.install_git",
  image: "maintenance.install_image",
  archive: "maintenance.install_archive",
});

/** Headline of the update card per status */
export const STATUS_KEYS = Object.freeze({
  unknown: "maintenance.update_status_unknown",
  available: "maintenance.update_status_available",
  release: "maintenance.update_status_release",
  up_to_date: "maintenance.update_status_up_to_date",
});

/** "How to update" text of the installs that have no apply button */
export const HOWTO_KEYS = Object.freeze({
  image: "maintenance.howto_image",
  archive: "maintenance.howto_archive",
});

/** Reasons of a failed `update.check` job (params.reason): the blockers, plus the network and the lock */
export const CHECK_REASON_KEYS = Object.freeze({
  no_git_binary: BLOCKER_KEYS.no_git_binary,
  dubious_ownership: BLOCKER_KEYS.dubious_ownership,
  detached: BLOCKER_KEYS.detached,
  no_remote_branch: BLOCKER_KEYS.no_remote_branch,
  unreachable: "maintenance.reason_unreachable",
  busy: "maintenance.reason_busy",
});

/** Reasons of a failed `update.apply` job (params.reason) */
export const APPLY_REASON_KEYS = Object.freeze({
  unavailable: "maintenance.reason_unavailable",
  busy: "maintenance.reason_busy",
  no_remote_branch: BLOCKER_KEYS.no_remote_branch,
  dubious_ownership: BLOCKER_KEYS.dubious_ownership,
  network: "maintenance.reason_network",
  diverged: "maintenance.reason_diverged",
  merge_failed: "maintenance.reason_merge_failed",
  install_failed: "maintenance.reason_install_failed",
  smoke_failed: "maintenance.reason_smoke_failed",
});

const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Number(value)) : 0);

/** `{ code, key }` of a blocker; an unknown code reads as a generic explanation */
export function blockerInfo(code) {
  const key = Object.prototype.hasOwnProperty.call(BLOCKER_KEYS, code) ? BLOCKER_KEYS[code] : "maintenance.blocker_unknown";
  return { code: String(code), key };
}

/** Key of the "how to update" text for an install without an apply button (an unknown type reads as an archive) */
export function howToKey(installType) {
  return Object.prototype.hasOwnProperty.call(HOWTO_KEYS, installType) ? HOWTO_KEYS[installType] : HOWTO_KEYS.archive;
}

/**
 * The update card from the MNT-1 object.
 *   mode        "git" (can show blockers and apply) or "instructions" (image, archive: a how-to text only)
 *   status      "unknown" (never checked, or nothing to compare), "available" (a git install is behind), "release" (an
 *               image or archive learned of a newer release), "up_to_date"
 *   canApply    a git install with no blocker and something behind
 *   commits / moreCommits   the first changes listed, and how many more there are than listed
 *   restartPending / supervised   the update is installed and the program must restart (or does by itself)
 */
export function buildUpdateModel(data) {
  if (!data || typeof data !== "object") return null;
  const git = data.installType === "git";
  const behind = count(data.behind);
  const commits = Array.isArray(data.commits) ? data.commits : [];
  const blockers = git && Array.isArray(data.blockers) ? data.blockers.map(blockerInfo) : [];
  const checked = typeof data.checkedAt === "string" && data.checkedAt !== "";
  const remoteVersion = typeof data.remoteVersion === "string" && data.remoteVersion ? data.remoteVersion : null;
  const localVersion = typeof data.localVersion === "string" && data.localVersion ? data.localVersion : null;
  // a git install knows from its fetch; an image or an archive only from the release check (which may be off)
  let status = "unknown";
  if (behind > 0) status = "available";
  else if (!git && remoteVersion && localVersion && remoteVersion !== localVersion) status = "release";
  else if (checked && (git || remoteVersion)) status = "up_to_date";
  return {
    mode: git ? "git" : "instructions",
    installType: git ? "git" : data.installType === "image" ? "image" : "archive",
    howToKey: git ? null : howToKey(data.installType),
    branch: typeof data.branch === "string" && data.branch ? data.branch : null,
    localVersion,
    remoteVersion,
    behind,
    ahead: count(data.ahead),
    checkedAt: checked ? data.checkedAt : null,
    status,
    blockers,
    canApply: git && data.canSelfUpdate === true && blockers.length === 0 && behind > 0,
    canCheck: true,
    commits: commits.map((c) => ({ sha: String((c && c.sha) || ""), subject: String((c && c.subject) || "") })),
    moreCommits: Math.max(0, behind - commits.length),
    restartPending: data.restartRequired === true,
    supervised: data.supervised === true,
    lastResult: data.lastResult && typeof data.lastResult === "object" ? data.lastResult : null,
  };
}

/** Text and parameters of the confirmation before MNT-3: the restart is automatic only when a supervisor exists */
export function applyConfirmation(model) {
  return {
    messageKey: model && model.supervised ? "maintenance.apply_confirm_supervised" : "maintenance.apply_confirm_manual",
    params: { from: (model && model.localVersion) || "?", to: (model && model.remoteVersion) || "?", count: model ? model.behind : 0 },
  };
}

/** Where an `update.apply` job is: `{ phase, phaseKey, step, steps }` (step is 1-based; 0 before the first phase) */
export function jobProgress(job) {
  const phase = job && typeof job.phase === "string" ? job.phase : null;
  const index = phase ? APPLY_PHASES.indexOf(phase) : -1;
  return {
    phase,
    phaseKey: phase && Object.prototype.hasOwnProperty.call(PHASE_KEYS, phase) ? PHASE_KEYS[phase] : null,
    step: index + 1,
    steps: APPLY_PHASES.length,
  };
}

/**
 * A failed `update.apply` job: the reason's text key, the phase it failed in, and whether the previous version was
 * restored (it always is when `rolledBack`; otherwise nothing had been changed yet or the rollback itself failed).
 */
export function applyFailure(error) {
  const params = (error && error.params) || {};
  const reason = typeof params.reason === "string" ? params.reason : null;
  return {
    reason,
    reasonKey: reason && Object.prototype.hasOwnProperty.call(APPLY_REASON_KEYS, reason) ? APPLY_REASON_KEYS[reason] : "maintenance.reason_unknown",
    phase: typeof params.phase === "string" ? params.phase : null,
    phaseKey: typeof params.phase === "string" && Object.prototype.hasOwnProperty.call(PHASE_KEYS, params.phase) ? PHASE_KEYS[params.phase] : null,
    rolledBack: params.rolledBack === true,
  };
}

/** Text key for the reason of a failed `update.check` job */
export function checkFailureKey(error) {
  const reason = error && error.params && error.params.reason;
  return typeof reason === "string" && Object.prototype.hasOwnProperty.call(CHECK_REASON_KEYS, reason) ? CHECK_REASON_KEYS[reason] : "maintenance.reason_unreachable";
}

// ---- download tools (MNT-4, MNT-5) --------------------------------------------------------------------------

export const SELF_UPDATABLE_KEYS = Object.freeze({
  likely: "maintenance.ytdlp_likely",
  no: "maintenance.ytdlp_no",
  missing: "maintenance.ytdlp_missing",
});

export const YTDLP_REASON_KEYS = Object.freeze({
  read_only: "maintenance.ytdlp_reason_read_only",
  package_managed: "maintenance.ytdlp_reason_package_managed",
});

export const VERDICT_KEYS = Object.freeze({
  updated: "maintenance.ytdlp_verdict_updated",
  up_to_date: "maintenance.ytdlp_verdict_up_to_date",
  managed_externally: "maintenance.ytdlp_verdict_managed_externally",
  read_only: "maintenance.ytdlp_verdict_read_only",
  unreachable: "maintenance.ytdlp_verdict_unreachable",
  failed: "maintenance.ytdlp_verdict_failed",
  missing: "maintenance.ytdlp_verdict_missing",
  busy: "maintenance.ytdlp_verdict_busy",
});

export const VERDICT_TONES = Object.freeze({
  updated: "ok",
  up_to_date: "ok",
  managed_externally: "warn",
  read_only: "warn",
  unreachable: "warn",
  failed: "danger",
  missing: "danger",
  busy: "warn",
});

/** Instructions per hint (the help is UI text; the server only names the variant) */
export const HINT_KEYS = Object.freeze({
  apt: "maintenance.ytdlp_hint_apt",
  pip: "maintenance.ytdlp_hint_pip",
  official_binary: "maintenance.ytdlp_hint_official_binary",
  rebuild_image: "maintenance.ytdlp_hint_rebuild_image",
});

/** The download-tools card from the MNT-4 object */
export function buildYtdlpModel(data) {
  if (!data || typeof data !== "object") return null;
  const selfUpdatable = Object.prototype.hasOwnProperty.call(SELF_UPDATABLE_KEYS, data.selfUpdatable) ? data.selfUpdatable : "no";
  const activeDownloads = count(data.activeDownloads);
  let blocked = null;
  if (selfUpdatable === "missing") blocked = "missing";
  else if (activeDownloads > 0) blocked = "downloads";
  return {
    command: typeof data.command === "string" && data.command ? data.command : "yt-dlp",
    version: typeof data.version === "string" && data.version ? data.version : null,
    selfUpdatable,
    selfUpdatableKey: SELF_UPDATABLE_KEYS[selfUpdatable],
    reasonKey: typeof data.reason === "string" && Object.prototype.hasOwnProperty.call(YTDLP_REASON_KEYS, data.reason) ? YTDLP_REASON_KEYS[data.reason] : null,
    activeDownloads,
    blocked,
    canUpdate: blocked === null,
  };
}

/** The result of a finished `ytdlp.update` job: the verdict's text and tone, the hint's instructions, the versions */
export function ytdlpResult(result) {
  const verdict = result && Object.prototype.hasOwnProperty.call(VERDICT_KEYS, result.verdict) ? result.verdict : "failed";
  const hint = result && typeof result.hint === "string" && Object.prototype.hasOwnProperty.call(HINT_KEYS, result.hint) ? result.hint : null;
  const from = (result && result.from) || null;
  const to = (result && result.to) || null;
  return { verdict, verdictKey: VERDICT_KEYS[verdict], tone: VERDICT_TONES[verdict], hintKey: hint ? HINT_KEYS[hint] : null, from, to, changed: Boolean(from && to && from !== to) };
}

// ---- storage (MNT-6, MNT-7) ---------------------------------------------------------------------------------

export const CATEGORY_LABEL_KEYS = Object.freeze({
  temp_media: "maintenance.cat_temp_media",
  broadcast_media: "maintenance.cat_broadcast_media",
  antidelete_cache: "maintenance.cat_antidelete_cache",
  panel_backups: "maintenance.cat_panel_backups",
  logs: "maintenance.cat_logs",
  database: "maintenance.cat_database",
});

export const CATEGORY_NOTE_KEYS = Object.freeze({
  temp_media: "maintenance.note_temp_media",
  broadcast_media: "maintenance.note_broadcast_media",
  antidelete_cache: "maintenance.note_antidelete_cache",
  panel_backups: "maintenance.note_panel_backups",
  logs: "maintenance.note_logs",
  database: "maintenance.note_database",
});

export const PURGE_CONFIRM_KEYS = Object.freeze({
  temp_media: "maintenance.purge_confirm_temp_media",
  broadcast_media: "maintenance.purge_confirm_broadcast_media",
  antidelete_cache: "maintenance.purge_confirm_antidelete_cache",
  panel_backups: "maintenance.purge_confirm_panel_backups",
  logs: "maintenance.purge_confirm_logs",
});

export const UNIT_KEYS = Object.freeze({
  files: "maintenance.unit_files",
  messages: "maintenance.unit_messages",
  bytes: "maintenance.unit_files",
});

/** Binary units, one decimal under 10 ("1536" -> "1.5 KB"); the view uses the locale-aware i18n.formatBytes instead */
export function humanBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * A size to show. A walk that hit its bound (`truncated`) is a lower bound, so the text says "at least"; an unknown
 * size (the measure failed: `null`) has no text.
 * @param {number|null} bytes
 * @param {{ truncated?: boolean, format?: (n: number) => string }} [options] `format` defaults to humanBytes
 * @returns {{ text: string, atLeast: boolean, known: boolean }}
 */
export function describeSize(bytes, { truncated = false, format = humanBytes } = {}) {
  if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes))) return { text: "", atLeast: false, known: false };
  return { text: format(Number(bytes)), atLeast: Boolean(truncated), known: true };
}

/** The six rows of the storage table from the MNT-6 object (an unknown id is kept, with generic texts) */
export function buildStorageRows(data) {
  const categories = data && Array.isArray(data.categories) ? data.categories : [];
  return categories.map((c) => {
    const id = String(c.id);
    const protectedItems = Number.isFinite(c.protectedItems) ? c.protectedItems : null;
    const protectedBytes = Number.isFinite(c.protectedBytes) ? c.protectedBytes : null;
    return {
      id,
      labelKey: CATEGORY_LABEL_KEYS[id] || "maintenance.cat_unknown",
      noteKey: CATEGORY_NOTE_KEYS[id] || null,
      bytes: Number.isFinite(c.bytes) ? c.bytes : null,
      items: Number.isFinite(c.items) ? c.items : null,
      unit: c.unit === "messages" ? "messages" : "files",
      unitKey: UNIT_KEYS[c.unit] || UNIT_KEYS.files,
      truncated: c.truncated === true,
      purgeable: c.purgeable === true && id !== "database",
      protectedBytes,
      protectedItems,
      hasProtected: id === "broadcast_media" && protectedItems !== null && protectedItems > 0,
      dialect: typeof c.dialect === "string" ? c.dialect : null,
    };
  });
}

/** Free disk from the MNT-6 `disk` object: `{ freeBytes, totalBytes, usedRatio }`, nulls when unknown */
export function buildDisk(disk) {
  const free = disk && Number.isFinite(disk.freeBytes) ? disk.freeBytes : null;
  const total = disk && Number.isFinite(disk.totalBytes) ? disk.totalBytes : null;
  return { freeBytes: free, totalBytes: total, usedRatio: free !== null && total ? Math.min(1, Math.max(0, 1 - free / total)) : null };
}

/** Sum of the sizes that are known (the database included: it is part of what the host holds) */
export function totalBytes(rows) {
  return rows.reduce((sum, row) => sum + (row.bytes || 0), 0);
}

/**
 * May the purge button of a row be pressed? `reason`: "not_purgeable" (the database has no button at all),
 * "empty" (nothing to free), "busy" (a purge of this category runs).
 */
export function purgeState(row, busyId = null) {
  if (!row.purgeable) return { show: false, disabled: true, reason: "not_purgeable" };
  if (busyId === row.id) return { show: true, disabled: true, reason: "busy" };
  if (row.bytes === 0 && (row.items === 0 || row.items === null)) return { show: true, disabled: true, reason: "empty" };
  return { show: true, disabled: false, reason: null };
}

/**
 * Text and parameters of the confirmation before MNT-7. Sizes stay numbers here (the view formats them):
 *   size / items            what the category holds
 *   kept / keptBytes        broadcast media: how many broadcasts keep their media (scheduled or recurring), and its size
 */
export function purgeConfirmation(row) {
  return {
    messageKey: Object.prototype.hasOwnProperty.call(PURGE_CONFIRM_KEYS, row.id) ? PURGE_CONFIRM_KEYS[row.id] : PURGE_CONFIRM_KEYS.temp_media,
    params: {
      size: row.bytes,
      items: row.items === null ? 0 : row.items,
      kept: row.id === "broadcast_media" && row.protectedItems !== null ? row.protectedItems : 0,
      keptBytes: row.id === "broadcast_media" && row.protectedBytes !== null ? row.protectedBytes : 0,
    },
  };
}

/** Toast after MNT-7: which message, with the parameters (`skipped` is what the broadcaster kept) */
export function purgeResultMessage(id, result) {
  const skipped = result && Number.isFinite(result.skipped) ? result.skipped : 0;
  return {
    key: id === "broadcast_media" && skipped > 0 ? "maintenance.purged_kept" : "maintenance.purged",
    params: { size: result && Number.isFinite(result.freedBytes) ? result.freedBytes : 0, removed: result && Number.isFinite(result.removed) ? result.removed : 0, kept: skipped },
  };
}
