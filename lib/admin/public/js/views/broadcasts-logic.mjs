// Pure helpers of the broadcasts view (BC-1 to BC-10, specs/002-admin-panel US9): the create form model, the
// request bodies, the client-side pre-checks, the destination selection, the "new broadcast to the failed
// destinations" pre-fill, the live progress merge. No DOM access and no imports, so node:test can load this file.
//
// Nothing here re-sends a failed message (U14): a failed destination is served again by a new broadcast that the owner reviews
// and submits like any other; `buildPrefill` only fills the ordinary create form.

export const MAX_TARGETS = 200;
export const MIN_SPACING_MS = 2000;
export const MAX_SPACING_MS = 600000;
export const DEFAULT_SPACING_SECONDS = 5;
export const TEXT_MAX = 4096;
export const CAPTION_MAX = 1024;
export const TITLE_MAX = 100;
export const IN_PAST_TOLERANCE_MS = 60 * 1000;

/** Failure codes after which the message may already have reached the destination */
export const UNSURE_CODES = Object.freeze(["timeout", "connection_closed", "interrupted"]);
export const OPEN_STATUSES = Object.freeze(["scheduled", "running"]);
export const TERMINAL_STATUSES = Object.freeze(["completed", "failed", "cancelled", "expired"]);
export const STATES = Object.freeze(["scheduled", "running", "paused", "completed", "failed", "cancelled", "expired"]);
export const WEEKDAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);

/** Badge tone of a derived state */
export function stateTone(state) {
  switch (state) {
    case "running":
      return "info";
    case "completed":
      return "ok";
    case "failed":
      return "danger";
    case "paused":
    case "expired":
      return "warn";
    default:
      return "neutral";
  }
}

/** Badge tone of the status of one destination */
export function targetTone(status) {
  if (status === "sent") return "ok";
  if (status === "failed") return "danger";
  if (status === "cancelled") return "neutral";
  return "info";
}

export const isOpenStatus = (status) => OPEN_STATUSES.includes(status);
export const isTerminalStatus = (status) => TERMINAL_STATUSES.includes(status);
export const isUnsureCode = (code) => UNSURE_CODES.includes(code);

const codePoints = (text) => Array.from(String(text ?? "")).length;

/** De-duplication key of a destination: the phone-number form when known */
export const destinationKey = (item) => (item && (item.pnJid || item.jid)) || "";

/** The first occurrence of each destination, order kept */
export function dedupeDestinations(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const key = destinationKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export const kindOfJid = (jid) => (String(jid).endsWith("@g.us") ? "group" : "private");

/** A destination as the form keeps it */
export function destination(item) {
  return {
    jid: item.jid,
    name: item.name || null,
    kind: item.kind || kindOfJid(item.jid),
    ...(item.pnJid ? { pnJid: item.pnJid } : {}),
    ...(item.mayHaveBeenDelivered ? { mayHaveBeenDelivered: true } : {}),
  };
}

export function emptyRule() {
  return { kind: "daily", days: [1], day: 1, time: "08:00" };
}

/** A blank create form */
export function emptyForm(over = {}) {
  return {
    kind: "once",
    title: "",
    text: "",
    upload: null, // { uploadId, name, kind, size }
    reuseMediaOf: null, // broadcast id whose stored media is copied
    reuseMedia: null, // { name, kind, size } shown while reuseMediaOf is set
    targets: [], // [{ jid, name, kind, mayHaveBeenDelivered? }]
    keepTargets: false, // edit mode: leave the destinations as they are
    spacingSeconds: DEFAULT_SPACING_SECONDS,
    when: "now", // once: "now" | "later"
    runAtLocal: "", // <input type="datetime-local"> value
    recurrence: emptyRule(),
    ...over,
  };
}

export const hasMedia = (form) => Boolean(form.upload || form.reuseMediaOf);

/** The rule object of the API from the form's rule fields */
export function ruleFromForm(rule) {
  const r = rule || emptyRule();
  if (r.kind === "weekly") {
    const days = [...new Set((r.days || []).map(Number).filter((d) => Number.isInteger(d)))].sort((a, b) => a - b);
    return { kind: "weekly", days, time: r.time };
  }
  if (r.kind === "monthly") return { kind: "monthly", day: Number(r.day), time: r.time };
  return { kind: "daily", time: r.time };
}

/** The form's rule fields from the rule of a broadcast */
export function ruleToForm(rule) {
  if (!rule) return emptyRule();
  return {
    kind: rule.kind,
    days: rule.kind === "weekly" ? [...rule.days] : [1],
    day: rule.kind === "monthly" ? rule.day : 1,
    time: rule.time,
  };
}

/** `2026-06-01T09:30` (local, from a datetime-local input) to an ISO instant; null when it is not a date */
export function localToIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

const pad = (n) => String(n).padStart(2, "0");

/** An ISO instant to the value of a datetime-local input (local time) */
export function isoToLocal(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const spacingMsOf = (form) => Math.round(Number(form.spacingSeconds) * 1000);

/**
 * The body of BC-2 / BC-3 from the form. `confirmTargets` is the size of the selection, the number the owner
 * confirmed (BC-2 takes none: pass `{ confirm: false }`).
 */
export function buildBody(form, { confirm = true } = {}) {
  const targets = dedupeDestinations(form.targets).map((item) => item.jid);
  const body = { kind: form.kind, text: String(form.text ?? "").trim(), targets, spacingMs: spacingMsOf(form) };
  const title = String(form.title ?? "").trim();
  if (title) body.title = title;
  if (form.upload) body.uploadId = form.upload.uploadId;
  else if (form.reuseMediaOf) body.reuseMediaOf = form.reuseMediaOf;
  if (form.kind === "once" && form.when === "later") {
    const at = localToIso(form.runAtLocal);
    if (at) body.runAt = at;
  }
  if (form.kind === "recurring") body.recurrence = ruleFromForm(form.recurrence);
  if (confirm) body.confirmTargets = targets.length;
  return body;
}

/**
 * The body of BC-5 (recurring only): the fields that differ from the broadcast, `targets` only when the owner
 * replaced them (then with `confirmTargets`), a new media only when one was chosen.
 */
export function buildPatch(form, original) {
  const patch = {};
  const title = String(form.title ?? "").trim();
  if (title !== (original.title || "")) patch.title = title || null;
  const text = String(form.text ?? "").trim();
  if (text !== original.text) patch.text = text;
  const spacingMs = spacingMsOf(form);
  if (spacingMs !== original.spacingMs) patch.spacingMs = spacingMs;
  const rule = ruleFromForm(form.recurrence);
  if (JSON.stringify(rule) !== JSON.stringify(original.recurrence)) patch.recurrence = rule;
  if (form.upload) patch.uploadId = form.upload.uploadId;
  if (!form.keepTargets) {
    const targets = dedupeDestinations(form.targets).map((item) => item.jid);
    patch.targets = targets;
    patch.confirmTargets = targets.length;
  }
  return patch;
}

/** The form of an existing recurring broadcast (BC-4) for editing; its destinations are kept until replaced */
export function formFromBroadcast(broadcast) {
  return emptyForm({
    kind: "recurring",
    title: broadcast.title || "",
    text: broadcast.text,
    spacingSeconds: broadcast.spacingMs / 1000,
    recurrence: ruleToForm(broadcast.recurrence),
    keepTargets: true,
    reuseMedia: broadcast.mediaKind ? { name: broadcast.mediaName, kind: broadcast.mediaKind, size: broadcast.mediaSize, available: broadcast.mediaAvailable } : null,
  });
}

/** How a report splits the failed destinations (the label and the hint of the "new broadcast" button) */
export function failedSummary(report) {
  const failed = ((report && report.targets) || []).filter((target) => target.status === "failed");
  return {
    failed: failed.length,
    selectable: failed.filter((target) => target.selectable).length,
    unselectable: failed.filter((target) => !target.selectable).length,
    unsure: failed.filter((target) => target.selectable && target.mayHaveBeenDelivered).length,
  };
}

/**
 * "New broadcast to the failed destinations": the ordinary create form, pre-filled with the text and spacing of the
 * source broadcast, the failed destinations of its run that are still selectable (those that may have been
 * delivered are flagged and can be unticked), and `reuseMediaOf` only while the source still has its media.
 * @param {object} source  BC-4 `broadcast`
 * @param {object} report  BC-10 answer
 */
export function buildPrefill(source, report) {
  const failed = ((report && report.targets) || []).filter((target) => target.status === "failed");
  const usable = failed.filter((target) => target.selectable);
  const withMedia = source.mediaAvailable === true;
  return {
    form: emptyForm({
      kind: "once",
      title: source.title || "",
      text: source.text,
      spacingSeconds: source.spacingMs / 1000,
      reuseMediaOf: withMedia ? source.id : null,
      reuseMedia: source.mediaKind ? { name: source.mediaName, kind: source.mediaKind, size: source.mediaSize, available: withMedia } : null,
      targets: dedupeDestinations(
        usable.map((target) => destination({ jid: target.chatJid, name: target.name, mayHaveBeenDelivered: target.mayHaveBeenDelivered })),
      ),
    }),
    skipped: failed.length - usable.length,
    mediaGone: Boolean(source.mediaKind) && !withMedia,
  };
}

/** Add or remove one destination (immutable). Adding beyond 200 is refused (`added: false`). */
export function toggleDestination(selection, item) {
  const key = destinationKey(item);
  const list = selection || [];
  if (list.some((entry) => destinationKey(entry) === key)) {
    return { selection: list.filter((entry) => destinationKey(entry) !== key), added: false, full: false };
  }
  if (list.length >= MAX_TARGETS) return { selection: list, added: false, full: true };
  return { selection: [...list, destination(item)], added: true, full: false };
}

/** Add many destinations (a page of the picker), de-duplicated and capped at 200 */
export function addDestinations(selection, items) {
  const merged = dedupeDestinations([...(selection || []), ...(items || []).map(destination)]);
  return { selection: merged.slice(0, MAX_TARGETS), truncated: merged.length > MAX_TARGETS };
}

export function removeDestination(selection, jid) {
  return (selection || []).filter((entry) => entry.jid !== jid);
}

export const isSelected = (selection, item) => (selection || []).some((entry) => destinationKey(entry) === destinationKey(item));

/**
 * Client-side pre-check of the form, as the same `{ code, params }` the API returns in `fields`. The server stays
 * the authority; this only avoids a round trip for the obvious mistakes. `{}` means "looks fine".
 */
export function validateForm(form, { now = Date.now(), editing = false } = {}) {
  const errors = {};
  const text = String(form.text ?? "").trim();
  const cap = hasMedia(form) ? CAPTION_MAX : TEXT_MAX;
  if (!text) errors.text = { code: "required" };
  else if (codePoints(text) > cap) errors.text = { code: "too_long", params: { max: cap } };
  if (codePoints(String(form.title ?? "").trim()) > TITLE_MAX) errors.title = { code: "too_long", params: { max: TITLE_MAX } };

  if (!(editing && form.keepTargets)) {
    const count = dedupeDestinations(form.targets).length;
    if (count === 0) errors.targets = { code: "too_short", params: { min: 1 } };
    else if (count > MAX_TARGETS) errors.targets = { code: "too_many_items", params: { max: MAX_TARGETS } };
  }

  const spacing = spacingMsOf(form);
  if (!Number.isFinite(spacing)) errors.spacingMs = { code: "invalid_type" };
  else if (spacing < MIN_SPACING_MS || spacing > MAX_SPACING_MS) {
    errors.spacingMs = { code: "out_of_range", params: { min: MIN_SPACING_MS / 1000, max: MAX_SPACING_MS / 1000 } };
  }

  if (form.kind === "once" && form.when === "later") {
    const at = localToIso(form.runAtLocal);
    if (!form.runAtLocal) errors.runAt = { code: "required" };
    else if (!at) errors.runAt = { code: "invalid_format" };
    else if (Date.parse(at) < now - IN_PAST_TOLERANCE_MS) errors.runAt = { code: "in_past" };
  }

  if (form.kind === "recurring") {
    const rule = form.recurrence || emptyRule();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(rule.time || ""))) errors["recurrence.time"] = { code: "invalid_format" };
    if (rule.kind === "weekly" && !(rule.days || []).length) errors["recurrence.days"] = { code: "required" };
    if (rule.kind === "monthly") {
      const day = Number(rule.day);
      if (!Number.isInteger(day) || day < 1 || day > 31) errors["recurrence.day"] = { code: "out_of_range", params: { min: 1, max: 31 } };
    }
  }
  return errors;
}

/** Estimated duration of a run, as the server computes it (the average jitter is 10 %) */
export function estimateDurationMs(count, spacingMs) {
  return Math.round(Math.max(0, count - 1) * Math.max(MIN_SPACING_MS, spacingMs) * 1.1);
}

/** Share of the destinations of a run that are settled (sent, failed or cancelled) */
export function runProgress(run) {
  if (!run || !run.total) return { done: 0, total: run ? run.total || 0 : 0, ratio: 0 };
  const done = (run.sent || 0) + (run.failed || 0) + (run.cancelled || 0);
  return { done, total: run.total, ratio: Math.min(1, done / run.total) };
}

/**
 * Merge an SSE `job` event of type "broadcast" into a list of broadcasts (BC-1 items). Returns the new list; the
 * list is returned untouched for an unrelated event. A paused broadcast keeps its derived state.
 */
export function mergeProgress(items, event) {
  if (!event || event.type !== "broadcast") return items;
  let changed = false;
  const next = (items || []).map((item) => {
    if (item.id !== event.broadcastId) return item;
    changed = true;
    const latestRun = {
      ...(item.latestRun || {}),
      id: event.runId,
      status: event.status,
      total: event.total,
      sent: event.sent,
      failed: event.failed,
      cancelled: event.cancelled,
      pending: event.pending,
    };
    const keepsPause = item.state === "paused" && item.paused && item.paused.by === "admin";
    return { ...item, latestRun, state: keepsPause ? item.state : event.status };
  });
  return changed ? next : items;
}

/** The event closes a run: the view reloads to show the final numbers and dates */
export const closesRun = (event) => Boolean(event) && event.type === "broadcast" && isTerminalStatus(event.status);

/** The same merge for one BC-4 answer `{ broadcast, runs, nextOccurrences }` */
export function mergeDetailProgress(detail, event) {
  if (!detail || !event || event.type !== "broadcast" || event.broadcastId !== detail.broadcast.id) return detail;
  const [merged] = mergeProgress([detail.broadcast], event);
  const runs = (detail.runs || []).map((run) =>
    run.id === event.runId
      ? { ...run, status: event.status, total: event.total, sent: event.sent, failed: event.failed, cancelled: event.cancelled, pending: event.pending }
      : run,
  );
  return { ...detail, broadcast: merged, runs };
}

/** The open run of a BC-4 answer (the one BC-8 cancels by default), or null */
export function openRun(detail) {
  return ((detail && detail.runs) || []).find((run) => isOpenStatus(run.status)) || null;
}

/** Name of an ISO weekday (1 = Monday) in a language */
export function weekdayName(day, lang = "en") {
  // 2024-01-01 is a Monday
  return new Intl.DateTimeFormat(lang, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, day)));
}

/** The translation key and parameters that describe a rule (the view passes them to t()) */
export function ruleText(rule, lang = "en") {
  if (!rule) return null;
  if (rule.kind === "weekly") {
    const names = rule.days.map((day) => weekdayName(day, lang));
    const list = new Intl.ListFormat(lang, { style: "long", type: "conjunction" }).format(names);
    return { key: "broadcasts.rule_weekly", params: { days: list, time: rule.time } };
  }
  if (rule.kind === "monthly") {
    return { key: rule.day >= 29 ? "broadcasts.rule_monthly_last" : "broadcasts.rule_monthly", params: { day: rule.day, time: rule.time } };
  }
  return { key: "broadcasts.rule_daily", params: { time: rule.time } };
}

/** A name for a broadcast in lists: its title, else the beginning of the text on one line */
export function labelOf(broadcast, max = 60) {
  if (broadcast.title) return broadcast.title;
  const flat = String(broadcast.text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Page query for BC-1 */
export function listQuery({ kind, state, page, pageSize = 20 } = {}) {
  return { kind: kind || undefined, state: state || undefined, page: page && page > 1 ? page : undefined, pageSize };
}

/** Query for the destination picker (CHAT-1): only valid destinations, no free-text number */
export function pickerQuery({ q, kind, page, pageSize = 50 } = {}) {
  return { selectable: 1, q: String(q || "").trim() || undefined, kind: kind || undefined, page: page && page > 1 ? page : undefined, pageSize };
}

/** The error of a field, from the client pre-check or the server's `fields` (null when there is none) */
export function errorFor(errors, name) {
  return (errors && errors[name]) || null;
}
