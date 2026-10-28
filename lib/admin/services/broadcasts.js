"use strict";

/**
 * Broadcasts service (admin-http-api.md 2.11, BC-1 to BC-10): request validation, the derived `state` and `paused`
 * fields, `mediaAvailable`, the destination count to confirm, the per-destination report with `selectable`
 * computed against the CHAT-1 rules. Never touches `req`/`res`; the HTTP layer is lib/admin/routes/broadcasts.js.
 *
 *   const broadcasts = createBroadcastsService(deps);
 *   await broadcasts.list({ kind, state, page, pageSize })              BC-1  { items, page, pageSize, total }
 *   await broadcasts.preview(body, { sessionId })                       BC-2  writes nothing
 *   await broadcasts.create(body, { sessionId })                        BC-3  { broadcast, run, summary }
 *   await broadcasts.get(id)                                            BC-4  { broadcast, runs, nextOccurrences }
 *   await broadcasts.update(id, body, { sessionId })                    BC-5  { broadcast, summary }
 *   await broadcasts.pause(id) / resume(id)                             BC-6 / BC-7  { broadcast }
 *   await broadcasts.cancel(id, { runId })                              BC-8  { run }
 *   await broadcasts.remove(id, { confirm })                            BC-9  { deleted: true }
 *   await broadcasts.report(id, runId)                                  BC-10 { run, targets }
 *
 * The engine (lib/utils/broadcaster.js) does the work; this module translates its errors into the envelope:
 * a field error is a `validation_failed` with `fields` (never the submitted value), the others keep their code
 * (`busy`, `not_pending`, `not_editable`, `not_found`). There is NO retry: the report lists the failed
 * destinations and the UI pre-fills an ordinary create form with them (U14).
 *
 * The engines are resolved lazily (`deps.broadcaster`, `deps.knownChats`, `deps.uploads`, `deps.models`,
 * `deps.client`, `deps.config`), so a test can inject a fake and a module delivered later never breaks loading.
 */

const { AdminError } = require("../http/response");

const KINDS = ["once", "recurring"];
const STATES = ["scheduled", "running", "paused", "completed", "failed", "cancelled", "expired"];
const OPEN_RUN = new Set(["scheduled", "running"]);
const MAX_TARGETS = 200;
const IN_PAST_TOLERANCE_MS = 60 * 1000;
const NEXT_OCCURRENCES = 5;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MIN_SPACING_MS = 2000;
const JITTER_MEAN = 0.1;
const RULE_KEYS = new Set(["kind", "days", "day", "time"]);

const iso = (value) => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const codePoints = (text) => Array.from(String(text)).length;

/** One `validation_failed` listing every field error at once */
function invalid(fields) {
  return new AdminError("validation_failed", { fields });
}

function createBroadcastsService(deps = {}) {
  const engine = () => deps.broadcaster || require("../../utils/broadcaster");
  const knownChats = () => deps.knownChats || require("../../utils/knownChats");
  const recurrence = () => deps.recurrence || require("../../utils/recurrence");
  const models = () => deps.models || require("../../database");
  const config = () => deps.config || require("../../../config");
  const now = () => (deps.clock && typeof deps.clock.now === "function" ? deps.clock.now() : Date.now());

  /** The bot is not connected: a started run waits (the displayed state is "paused by disconnection") */
  function clientIsDown() {
    const client = deps.client;
    if (!client) return false;
    return typeof client.ready === "function" ? !client.ready() : false;
  }

  const zone = () => recurrence().resolveZone(config().TIMEZONE);

  // ----- views -----------------------------------------------------------------------------------

  const runView = (run) =>
    run
      ? {
          id: run.id,
          dueAt: iso(run.dueAt),
          status: run.status,
          total: run.total,
          sent: run.sent,
          failed: run.failed,
          cancelled: run.cancelled,
          pending: run.pending,
          startedAt: iso(run.startedAt),
          finishedAt: iso(run.finishedAt),
          note: run.note || null,
        }
      : null;

  /**
   * The displayed state (data-model 1.10): the status of the latest run, plus "paused" when the recurring
   * broadcast is paused by the owner or when the bot is disconnected while a run is open (a run that already
   * started waits and resumes paced; it is not expired).
   * @returns {{ state: string, paused: { by: "admin"|"disconnected" }|null }}
   */
  function deriveState(broadcast, latestRun, { down = false, at = now() } = {}) {
    if (broadcast.kind === "recurring" && broadcast.status === "paused") return { state: "paused", paused: { by: "admin" } };
    if (!latestRun) return { state: "scheduled", paused: null };
    const open = OPEN_RUN.has(latestRun.status);
    const due = latestRun.status === "running" || (latestRun.status === "scheduled" && new Date(latestRun.dueAt).getTime() <= at);
    if (open && down && due) return { state: "paused", paused: { by: "disconnected" } };
    return { state: latestRun.status, paused: null };
  }

  function broadcastView(broadcast, latestRun, options = {}) {
    const rule = engine().ruleOf(broadcast);
    const { state, paused } = deriveState(broadcast, latestRun, { down: clientIsDown(), ...options });
    const targets = Array.isArray(broadcast.targets) ? broadcast.targets : [];
    return {
      id: broadcast.id,
      kind: broadcast.kind,
      title: broadcast.title || null,
      text: broadcast.text,
      mediaKind: broadcast.mediaKind || null,
      mediaName: broadcast.mediaKind ? broadcast.mediaName || null : null,
      mediaSize: broadcast.mediaKind ? broadcast.mediaSize ?? null : null,
      mediaAvailable: broadcast.mediaKind ? Boolean(broadcast.mediaPath) : null,
      targetCount: targets.length,
      spacingMs: broadcast.spacingMs,
      runAt: iso(broadcast.runAt),
      recurrence: rule,
      nextRunAt: iso(broadcast.nextRunAt),
      lastRunAt: iso(broadcast.lastRunAt),
      state,
      paused,
      createdAt: iso(broadcast.createdAt),
      latestRun: runView(latestRun),
    };
  }

  /** The next instants of a rule after now (BC-2, BC-4) */
  function nextOccurrences(rule, count = NEXT_OCCURRENCES) {
    const out = [];
    let cursor = now();
    for (let i = 0; i < count; i += 1) {
      const next = recurrence().nextOccurrence(rule, cursor, zone());
      if (next === null) break;
      out.push(new Date(next).toISOString());
      cursor = next;
    }
    return out;
  }

  // ----- errors ----------------------------------------------------------------------------------

  const notFound = (resource = "broadcast") => new AdminError("not_found", { params: { resource } });

  const RULE_FIELD = {
    bad_kind: ["recurrence.kind", { code: "not_allowed", params: { allowed: ["daily", "weekly", "monthly"] } }],
    bad_days: ["recurrence.days", { code: "invalid_format" }],
    bad_day: ["recurrence.day", { code: "out_of_range", params: { min: 1, max: 31 } }],
    bad_time: ["recurrence.time", { code: "invalid_format" }],
  };

  /** Engine error -> envelope error. Anything else is rethrown untouched. */
  function toEnvelope(err) {
    if (!err || typeof err.code !== "string") return err;
    const params = err.params || {};
    switch (err.code) {
      case "invalid_destination":
        return invalid({ targets: { code: "unknown_target", params: { indices: params.indices || [] } } });
      case "too_many_targets":
        return invalid({ targets: { code: "too_many_items", params: { max: MAX_TARGETS } } });
      case "empty_text":
        return invalid({ text: { code: "required" } });
      case "text_too_long":
        return invalid({ text: { code: "too_long", params: { max: params.max } } });
      case "media_type":
      case "media_too_large":
        return invalid({ uploadId: { code: "invalid_format" } });
      case "media_unavailable":
        return invalid({ reuseMediaOf: { code: "not_applicable" } });
      case "invalid_rule": {
        const [name, field] = RULE_FIELD[params.code] || ["recurrence", { code: "invalid_format" }];
        return invalid({ [name]: field });
      }
      case "not_found":
        return notFound();
      default:
        return err; // busy, not_pending, not_editable... are envelope codes already
    }
  }

  async function guarded(work) {
    try {
      return await work();
    } catch (err) {
      throw toEnvelope(err);
    }
  }

  // ----- request ---------------------------------------------------------------------------------

  /** A fresh recurrence rule from the submitted object, or the field errors */
  function readRule(raw, fields) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      fields.recurrence = { code: "invalid_type" };
      return null;
    }
    if (Object.keys(raw).some((key) => !RULE_KEYS.has(key))) {
      fields.recurrence = { code: "unknown_field" };
      return null;
    }
    const rule = { kind: raw.kind, time: raw.time };
    if (raw.days !== undefined) rule.days = raw.days;
    if (raw.day !== undefined) rule.day = raw.day;
    const verdict = recurrence().validateRule(rule);
    if (!verdict.ok) {
      const [name, field] = RULE_FIELD[verdict.code];
      fields[name] = field;
      return null;
    }
    return recurrence().normalizeRule(rule);
  }

  /** The media of a request: an upload of this session, or the stored media of another broadcast */
  async function readMedia(body, sessionId, fields) {
    const hasUpload = body.uploadId !== undefined;
    const hasReuse = body.reuseMediaOf !== undefined;
    if (hasUpload && hasReuse) {
      fields.reuseMediaOf = { code: "not_allowed" };
      return null;
    }
    if (hasUpload) {
      const uploads = deps.uploads;
      const record = uploads && typeof uploads.peek === "function" ? uploads.peek(body.uploadId, sessionId, { purpose: "broadcast" }) : null;
      if (!record || !["image", "document"].includes(record.kind)) {
        fields.uploadId = { code: "invalid_format" };
        return null;
      }
      return { kind: record.kind, media: { path: record.path, name: record.name, mime: record.mime, size: record.size }, uploadId: body.uploadId };
    }
    if (hasReuse) {
      const origin = await engine().get(body.reuseMediaOf);
      if (!origin || !origin.broadcast.mediaKind || !origin.broadcast.mediaPath) {
        fields.reuseMediaOf = { code: "not_applicable" };
        return null;
      }
      return { kind: origin.broadcast.mediaKind, reuseMediaOf: body.reuseMediaOf };
    }
    return null;
  }

  /** The destinations that are valid today (CHAT-1 rules), de-duplicated; `unknown_target` carries the indices */
  async function readTargets(targets, fields) {
    try {
      return await knownChats().assertDestinations(targets);
    } catch (err) {
      if (err && err.code === "invalid_destination") {
        fields.targets = { code: "unknown_target", params: { indices: (err.params && err.params.indices) || [] } };
        return null;
      }
      throw err;
    }
  }

  /**
   * Validate the shared body of BC-2 and BC-3. Throws one `validation_failed` with every field error.
   * @returns the engine input plus what the preview needs
   */
  async function resolveCreate(body, { sessionId }) {
    const fields = {};
    const kind = body.kind;
    if (!KINDS.includes(kind)) fields.kind = body.kind === undefined ? { code: "required" } : { code: "not_allowed", params: { allowed: KINDS } };

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) fields.text = { code: "required" };

    const media = await readMedia(body, sessionId, fields);
    if (text && codePoints(text) > (media ? 1024 : 4096)) fields.text = { code: "too_long", params: { max: media ? 1024 : 4096 } };

    if (body.targets === undefined) fields.targets = { code: "required" };
    const resolved = body.targets === undefined ? null : await readTargets(body.targets, fields);

    let rule = null;
    let runAt = null;
    if (kind === "once") {
      if (body.recurrence !== undefined) fields.recurrence = { code: "not_allowed" };
      if (body.runAt !== undefined) {
        const at = Date.parse(body.runAt);
        if (!Number.isFinite(at)) fields.runAt = { code: "invalid_format" };
        else if (at < now() - IN_PAST_TOLERANCE_MS) fields.runAt = { code: "in_past" };
        else runAt = at;
      }
    } else if (kind === "recurring") {
      if (body.runAt !== undefined) fields.runAt = { code: "not_allowed" };
      if (body.recurrence === undefined) fields.recurrence = { code: "required" };
      else rule = readRule(body.recurrence, fields);
    }

    if (Object.keys(fields).length) throw invalid(fields);

    const spacingMs = body.spacingMs !== undefined ? body.spacingMs : Math.max(MIN_SPACING_MS, Number(config().BROADCAST_DELAY_MS) || 5000);
    const input = { title: body.title, text, targets: resolved, spacingMs };
    if (media && media.media) input.media = media.media;
    if (media && media.reuseMediaOf !== undefined) input.reuseMediaOf = media.reuseMediaOf;
    if (kind === "once" && runAt !== null) input.runAt = runAt;
    if (kind === "recurring") input.rule = rule;
    return { kind, input, targetCount: resolved.length, spacingMs, rule, mediaKind: media ? media.kind : null, textLength: codePoints(text), uploadId: media ? media.uploadId : undefined };
  }

  /** `confirmTargets` must equal the resolved destination count (FR-047) */
  function confirmCount(given, targetCount) {
    if (given !== targetCount) throw new AdminError("confirmation_required", { params: { confirm: "targets", targetCount } });
  }

  // ----- BC-1 to BC-10 ---------------------------------------------------------------------------

  /** BC-1 */
  async function list({ kind, state, page, pageSize } = {}) {
    const rows = await engine().list({ kind });
    const at = now();
    const down = clientIsDown();
    let items = rows.map((row) => broadcastView(row.broadcast, row.latestRun, { down, at }));
    if (state) items = items.filter((item) => item.state === state);

    const size = Math.min(Math.max(Math.trunc(Number(pageSize)) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const total = items.length;
    const last = Math.max(Math.ceil(total / size), 1);
    const current = Math.min(Math.max(Math.trunc(Number(page)) || 1, 1), last);
    return { items: items.slice((current - 1) * size, current * size), page: current, pageSize: size, total };
  }

  /** BC-2: nothing is written */
  async function preview(body, { sessionId } = {}) {
    const resolved = await resolveCreate(body, { sessionId });
    const gap = Math.max(MIN_SPACING_MS, resolved.spacingMs) * (1 + JITTER_MEAN);
    const warnings = [];
    if (clientIsDown()) warnings.push("bot_disconnected");
    return {
      targetCount: resolved.targetCount,
      estimatedDurationMs: Math.round(Math.max(0, resolved.targetCount - 1) * gap),
      nextOccurrences: resolved.kind === "recurring" ? nextOccurrences(resolved.rule) : null,
      mediaKind: resolved.mediaKind,
      textLength: resolved.textLength,
      spacingMs: resolved.spacingMs,
      warnings,
    };
  }

  /**
   * BC-3.
   * @returns {Promise<{ broadcast: object, run: object|null, summary: object }>} `summary` is for the audit row
   */
  async function create(body, { sessionId } = {}) {
    const resolved = await resolveCreate(body, { sessionId });
    confirmCount(body.confirmTargets, resolved.targetCount);

    const created = await guarded(() =>
      resolved.kind === "once" ? engine().createOnce(resolved.input, { now: now() }) : engine().createRecurring(resolved.input, { now: now() }),
    );
    if (resolved.uploadId && deps.uploads) await deps.uploads.consume(resolved.uploadId, sessionId, { purpose: "broadcast" });

    const found = await engine().get(created.broadcastId);
    const run = resolved.kind === "once" ? found.latestRun : null;
    return {
      broadcast: broadcastView(found.broadcast, found.latestRun),
      run: runView(run),
      summary: { kind: resolved.kind, targets: resolved.targetCount, media: resolved.mediaKind },
    };
  }

  /** BC-4 */
  async function get(id) {
    const found = await engine().get(id);
    if (!found) throw notFound();
    const runs = await engine().runs(found.broadcast.id, { limit: 20 });
    const view = broadcastView(found.broadcast, found.latestRun);
    let upcoming = null;
    if (view.recurrence) upcoming = view.state === "paused" && view.paused && view.paused.by === "admin" ? [] : nextOccurrences(view.recurrence);
    return { broadcast: view, runs: runs.map(runView), nextOccurrences: upcoming };
  }

  /** BC-5: recurring only; every field optional */
  async function update(id, body, { sessionId } = {}) {
    const found = await engine().get(id);
    if (!found) throw notFound();
    if (found.broadcast.kind !== "recurring" || (body.kind !== undefined && body.kind !== "recurring")) throw new AdminError("not_editable");
    if (body.runAt !== undefined) throw invalid({ runAt: { code: "not_allowed" } });

    const fields = {};
    const patch = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.text !== undefined) {
      const text = body.text.trim();
      if (!text) fields.text = { code: "required" };
      else patch.text = text;
    }
    if (body.spacingMs !== undefined) patch.spacingMs = body.spacingMs;
    if (body.recurrence !== undefined) {
      const rule = readRule(body.recurrence, fields);
      if (rule) patch.rule = rule;
    }
    const media = await readMedia(body, sessionId, fields);
    if (media && media.media) patch.media = media.media;
    if (media && media.reuseMediaOf !== undefined) patch.reuseMediaOf = media.reuseMediaOf;
    if (body.targets !== undefined) {
      const resolved = await readTargets(body.targets, fields);
      if (resolved) patch.targets = resolved;
    }
    if (Object.keys(fields).length) throw invalid(fields);
    if (patch.targets) confirmCount(body.confirmTargets, patch.targets.length);

    if (Object.keys(patch).length) await guarded(() => engine().updateRecurring(found.broadcast.id, patch, { now: now() }));
    if (media && media.uploadId && deps.uploads) await deps.uploads.consume(media.uploadId, sessionId, { purpose: "broadcast" });

    const fresh = await engine().get(found.broadcast.id);
    return { broadcast: broadcastView(fresh.broadcast, fresh.latestRun), summary: { fields: Object.keys(patch) } };
  }

  async function changeStatus(id, action) {
    const found = await engine().get(id);
    if (!found) throw notFound();
    await guarded(() => (action === "pause" ? engine().pause(found.broadcast.id) : engine().resume(found.broadcast.id, { now: now() })));
    const fresh = await engine().get(found.broadcast.id);
    return { broadcast: broadcastView(fresh.broadcast, fresh.latestRun) };
  }

  /** BC-8: `runId` defaults to the open run of the broadcast; `not_pending` when there is none */
  async function cancel(id, { runId } = {}) {
    const found = await engine().get(id);
    if (!found) throw notFound();
    let target = runId;
    if (target === undefined) {
      const open = (await engine().runs(found.broadcast.id, { limit: 20 })).find((run) => OPEN_RUN.has(run.status));
      if (!open) throw new AdminError("not_pending");
      target = open.id;
    } else {
      const own = (await engine().runs(found.broadcast.id, { limit: 200 })).some((run) => run.id === target);
      if (!own) throw notFound("run");
    }
    const run = await guarded(() => engine().cancelRun(target, { now: now() }));
    return { run: runView(run) };
  }

  /** BC-9 */
  async function remove(id, { confirm } = {}) {
    const found = await engine().get(id);
    if (!found) throw notFound();
    if (confirm !== true) throw new AdminError("confirmation_required", { params: { confirm: "delete" } });
    await guarded(() => engine().remove(found.broadcast.id));
    return { deleted: true };
  }

  /**
   * BC-10: the per-destination report. `selectable` says whether the destination is still a valid broadcast
   * destination (a group the bot left or a disabled chat is not).
   */
  async function report(id, runId) {
    const found = await engine().get(id);
    if (!found) throw notFound();
    let detail;
    try {
      detail = await engine().report(runId);
    } catch (err) {
      if (err && err.code === "not_found") throw notFound("run");
      throw err;
    }
    if (detail.run.broadcastId !== found.broadcast.id) throw notFound("run");

    const jids = detail.targets.map((target) => target.chatJid);
    const selectable = new Map(jids.map((jid) => [jid, true]));
    if (jids.length) {
      try {
        await knownChats().assertDestinations(jids);
      } catch (err) {
        if (!err || err.code !== "invalid_destination") throw err;
        for (const index of (err.params && err.params.indices) || []) selectable.set(jids[index], false);
      }
    }
    const names = new Map();
    if (jids.length) {
      const rows = await models().KnownChat.findAll({ where: { jid: jids }, attributes: ["jid", "name"], raw: true });
      for (const row of rows) names.set(row.jid, row.name || null);
    }

    return {
      run: runView(detail.run),
      targets: detail.targets.map((target) => ({
        chatJid: target.chatJid,
        name: names.get(target.chatJid) || null,
        position: target.position,
        status: target.status,
        errorCode: target.errorCode,
        mayHaveBeenDelivered: target.mayHaveBeenDelivered,
        selectable: selectable.get(target.chatJid) !== false,
        sentAt: iso(target.sentAt),
      })),
    };
  }

  return {
    list,
    preview,
    create,
    get,
    update,
    pause: (id) => changeStatus(id, "pause"),
    resume: (id) => changeStatus(id, "resume"),
    cancel,
    remove,
    report,
    deriveState,
    broadcastView,
    STATES,
  };
}

module.exports = { createBroadcastsService, STATES, KINDS };
