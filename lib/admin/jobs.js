"use strict";

/**
 * In-memory registry of long operations (admin-http-api.md section 1.16).
 *
 *   const jobs = createJobs({ hub });
 *   const job = jobs.start("restart", async (handle) => {
 *     handle.setPhase("stop");
 *     ...
 *     return { ok: true };                                    // -> status "done", result
 *   }, { failureCode: "restart_failed" });
 *   return reply(202, { job });                               // { id, type, status: "running", ... }
 *
 * Shape: { id, type, status: "running" | "done" | "failed", phase, progress, startedAt, finishedAt, result, error }
 * with `error = { code, params? }` (job codes: restart_failed, update_check_failed, update_failed, restore_failed;
 * a thrown error that carries a snake_case `code` keeps it, otherwise `options.failureCode`, otherwise
 * `internal_error`). Times are ISO-8601 UTC strings; `id` is a positive integer (JOB-1 `:id` is numeric).
 *
 * The callback receives a handle: { id, type, setPhase(phase, progress?), setProgress(progress), signal }.
 * It runs after `start()` returned, so the 202 answer always shows `running`. Every start, phase change and end is
 * published on the hub `job` topic and (when a `state` snapshot exists) triggers a forced `state` event.
 *
 * Mutual exclusion: the heavy types `restart`, `restore`, `update.apply` and `ytdlp.update` never run together:
 * starting one while another is running throws `busy` (HTTP 409). Other types (`update.check`...) are free unless
 * `exclusive: true` is passed. The registry keeps the last 20 jobs for one hour (running jobs are never dropped).
 *
 *   jobs.get(id) -> job | null     jobs.list() -> job[] (newest first)     jobs.current() -> running job | null
 *   jobs.isBusy(type?)             jobs.stop()                             (drops the timers; running jobs go on)
 *
 * The clock is injectable (`now`). No timer is created at all: pruning happens on access.
 */

const crypto = require("crypto");
const { AdminError } = require("./http/response");

const HEAVY_TYPES = Object.freeze(["restart", "restore", "update.apply", "ytdlp.update"]);
const MAX_JOBS = 20;
const RETENTION_MS = 60 * 60 * 1000;

function createJobs({ hub, now = Date.now, firstId } = {}) {
  /** @type {Map<number, object>} insertion order = start order */
  const registry = new Map();
  let nextId = firstId !== undefined ? firstId : crypto.randomInt(1, 1_000_000_000);

  const iso = (ms) => new Date(ms).toISOString();

  function prune() {
    const at = now();
    for (const [id, job] of registry) {
      if (job.status !== "running" && job.finishedAtMs !== null && at - job.finishedAtMs > RETENTION_MS) registry.delete(id);
    }
    const finished = [...registry.values()].filter((job) => job.status !== "running");
    // keep the newest MAX_JOBS in all, running ones always
    let excess = registry.size - MAX_JOBS;
    for (const job of finished) {
      if (excess <= 0) break;
      registry.delete(job.id);
      excess -= 1;
    }
  }

  function view(job) {
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      phase: job.phase,
      progress: job.progress,
      startedAt: iso(job.startedAtMs),
      finishedAt: job.finishedAtMs === null ? null : iso(job.finishedAtMs),
      result: job.result,
      error: job.error,
    };
  }

  function announce(job, { forceState = false } = {}) {
    if (!hub) return;
    try {
      hub.publish("job", view(job));
      if (forceState && typeof hub.publishState === "function") hub.publishState({ force: true }).catch(() => {});
    } catch {
      // publishing never breaks a job
    }
  }

  function errorOf(err, failureCode) {
    const code = err && typeof err.code === "string" && /^[a-z][a-z0-9_]*$/.test(err.code) ? err.code : failureCode || "internal_error";
    const out = { code };
    if (err && err.params && typeof err.params === "object") out.params = err.params;
    return out;
  }

  function isBusy(type) {
    for (const job of registry.values()) {
      if (job.status !== "running") continue;
      if (type === undefined || job.type === type) return true;
    }
    return false;
  }

  function start(type, fn, { exclusive, failureCode } = {}) {
    if (typeof type !== "string" || !type) throw new Error("jobs.start needs a type");
    if (typeof fn !== "function") throw new Error("jobs.start needs a function");
    prune();

    const heavy = HEAVY_TYPES.includes(type);
    const wantsExclusive = exclusive === undefined ? heavy : Boolean(exclusive);
    if (wantsExclusive) {
      for (const job of registry.values()) {
        if (job.status === "running" && (HEAVY_TYPES.includes(job.type) || job.exclusive)) {
          throw new AdminError("busy", { params: { type: job.type } });
        }
      }
    }

    const abort = new AbortController();
    const job = {
      id: nextId,
      type,
      exclusive: wantsExclusive,
      status: "running",
      phase: null,
      progress: null,
      startedAtMs: now(),
      finishedAtMs: null,
      result: null,
      error: null,
      abort,
    };
    nextId += 1;
    registry.set(job.id, job);
    const started = view(job);
    announce(job, { forceState: true });

    const handle = {
      id: job.id,
      type,
      signal: abort.signal,
      setPhase(phase, progress) {
        if (job.status !== "running") return;
        job.phase = phase;
        if (progress !== undefined) job.progress = progress;
        announce(job, { forceState: true });
      },
      setProgress(progress) {
        if (job.status !== "running") return;
        job.progress = progress;
        announce(job);
      },
    };

    Promise.resolve()
      .then(() => fn(handle))
      .then(
        (result) => {
          job.status = "done";
          job.result = result === undefined ? null : result;
        },
        (err) => {
          job.status = "failed";
          job.error = errorOf(err, failureCode);
        },
      )
      .then(() => {
        job.finishedAtMs = now();
        announce(job, { forceState: true });
      });

    return started;
  }

  return {
    HEAVY_TYPES,
    start,
    get(id) {
      prune();
      const job = registry.get(Number(id));
      return job ? view(job) : null;
    },
    list() {
      prune();
      return [...registry.values()].reverse().map(view);
    },
    current() {
      for (const job of [...registry.values()].reverse()) {
        if (job.status === "running") return view(job);
      }
      return null;
    },
    isBusy,
    stop() {
      // no timer exists; running jobs are not interrupted
    },
  };
}

module.exports = { createJobs, HEAVY_TYPES, MAX_JOBS, RETENTION_MS };
