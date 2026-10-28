// Live updates (contracts/admin-http-api.md section 3.1): ONE EventSource per tab on /admin/api/events,
// multiplexed by topic (`state`, `pairing`, `log`, `job`, `session`), and a polling fallback every 2 s
// after 3 consecutive EventSource errors. The EventSource, fetch and timer implementations are
// injectable so node:test can drive it; nothing touches the DOM at import time.
//
//   const live = createLive();
//   live.start();
//   const off = live.subscribe("state", (state) => ...);   // replays the last known state/pairing at once
//   live.setLogs(true, lastSeq);                            // logs=1: reconnects with the log topic on
//   live.watchJob(id);                                      // polled only while the fallback is active
//
// The extra topic `connection` carries `{ mode: "idle" | "sse" | "polling" }`.
//
// Polling covers: GET /admin/api/state, GET /admin/api/pairing (the QR image itself is an <img> whose
// src is qrUrl(version), so a new `qr.version` is all the view needs), GET /admin/api/logs?since=,
// GET /admin/api/jobs/:id and GET /admin/api/broadcasts/:id for the watched job or broadcast. None of
// them extends the session (touch:n routes).

import { createApi, api as defaultApi } from "./api.mjs";

export const TOPICS = ["state", "pairing", "log", "job", "session"];
export const EVENTS_PATH = "/admin/api/events";

/** URL of the current QR image (PAIR-2); `v` is only a cache-buster. */
export function qrUrl(version) {
  return `/admin/api/pairing/qr.svg?v=${encodeURIComponent(version ?? 0)}`;
}

/** SSE `job` payload for a broadcast, built from a BC-4 answer (used by the polling fallback). */
export function broadcastJobPayload(answer, now = new Date()) {
  const broadcast = answer && answer.broadcast;
  const run = answer && Array.isArray(answer.runs) ? answer.runs[0] : null;
  if (!broadcast || !run) return null;
  return {
    type: "broadcast",
    broadcastId: broadcast.id,
    runId: run.id,
    status: run.status,
    total: run.total,
    sent: run.sent,
    failed: run.failed,
    cancelled: run.cancelled,
    pending: run.pending,
    updatedAt: run.finishedAt || run.startedAt || now.toISOString(),
  };
}

export function createLive(options = {}) {
  const maxErrors = options.maxErrors ?? 3;
  const pollMs = options.pollMs ?? 2000;
  const sseRetryMs = options.sseRetryMs ?? 30000;
  const reopenMs = options.reopenMs ?? 3000;
  const client = options.client || (options.fetch ? createApi({ fetch: options.fetch }) : null);
  const request = (path, query) => (client ? client.api : defaultApi)("GET", path, query);
  // Looked up at call time so fake timers installed after import still apply.
  const timers = {
    setTimeout: (fn, ms) => (options.setTimeout || globalThis.setTimeout)(fn, ms),
    clearTimeout: (id) => (options.clearTimeout || globalThis.clearTimeout)(id),
    setInterval: (fn, ms) => (options.setInterval || globalThis.setInterval)(fn, ms),
    clearInterval: (id) => (options.clearInterval || globalThis.clearInterval)(id),
  };

  const subs = new Map();
  const latest = { state: undefined, pairing: undefined };
  let source = null;
  let running = false;
  let mode = "idle";
  let errors = 0;
  let wantLogs = false;
  let lastSeq = null;
  let pollTimer = null;
  let retryTimer = null;
  let reopenTimer = null;
  let polling = false;
  let watchedJob = null;
  let watchedBroadcast = null;

  const has = (topic) => (subs.get(topic) || new Set()).size > 0;

  function emit(topic, payload) {
    if (topic in latest) latest[topic] = payload;
    for (const fn of [...(subs.get(topic) || [])]) {
      try {
        fn(payload);
      } catch {
        // a subscriber must never break the stream
      }
    }
  }

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    emit("connection", { mode });
  }

  function subscribe(topic, fn, { replay = true } = {}) {
    if (!subs.has(topic)) subs.set(topic, new Set());
    subs.get(topic).add(fn);
    if (replay && latest[topic] !== undefined) {
      try {
        fn(latest[topic]);
      } catch {
        // ignore
      }
    }
    return () => subs.get(topic).delete(fn);
  }

  function eventsUrl() {
    let url = `${EVENTS_PATH}?logs=${wantLogs ? 1 : 0}`;
    if (wantLogs && lastSeq !== null && lastSeq !== undefined) url += `&since=${encodeURIComponent(lastSeq)}`;
    return url;
  }

  function closeSource() {
    if (!source) return;
    const old = source;
    source = null;
    old.onopen = old.onerror = null;
    try {
      old.close();
    } catch {
      // already closed
    }
  }

  function clearTimers() {
    if (reopenTimer) timers.clearTimeout(reopenTimer);
    if (retryTimer) timers.clearTimeout(retryTimer);
    reopenTimer = retryTimer = null;
    stopPolling();
  }

  function handleMessage(topic, event) {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return; // a malformed frame is dropped
    }
    if (topic === "log" && payload && payload.seq !== undefined) lastSeq = payload.seq;
    emit(topic, payload);
    if (topic === "session") {
      // the server ends the stream: do not reconnect, the app goes back to login
      running = false;
      closeSource();
      clearTimers();
      setMode("idle");
    }
  }

  function openSse() {
    const ES = options.EventSource || globalThis.EventSource;
    if (!running) return;
    if (!ES) {
      fallback();
      return;
    }
    closeSource();
    const es = new ES(eventsUrl());
    source = es;
    es.onopen = () => {
      if (source !== es) return;
      errors = 0;
      stopPolling();
      if (retryTimer) timers.clearTimeout(retryTimer);
      retryTimer = null;
      setMode("sse");
    };
    es.onerror = () => {
      if (source !== es) return;
      errors += 1;
      if (errors >= maxErrors) {
        fallback();
        return;
      }
      // The browser retries by itself while readyState is CONNECTING; a CLOSED source (non-200
      // answer such as a 429) is reopened by us.
      if (es.readyState === 2) {
        closeSource();
        if (reopenTimer) timers.clearTimeout(reopenTimer);
        reopenTimer = timers.setTimeout(() => {
          reopenTimer = null;
          openSse();
        }, reopenMs);
      }
    };
    for (const topic of TOPICS) es.addEventListener(topic, (event) => handleMessage(topic, event));
  }

  /** After `maxErrors` consecutive errors: poll every 2 s, and probe the stream now and then. */
  function fallback() {
    closeSource();
    errors = Math.max(errors, maxErrors - 1); // a single error on a probe returns here
    setMode("polling");
    startPolling();
    if (retryTimer) timers.clearTimeout(retryTimer);
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      if (running && mode === "polling") openSse();
    }, sseRetryMs);
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = timers.setInterval(pollOnce, pollMs);
    if (pollTimer && typeof pollTimer.unref === "function") pollTimer.unref();
    pollOnce();
  }

  function stopPolling() {
    if (pollTimer) timers.clearInterval(pollTimer);
    pollTimer = null;
  }

  async function pollOnce() {
    if (polling || !running || mode !== "polling") return;
    polling = true;
    const tasks = [];
    try {
      if (has("state")) tasks.push(request("/admin/api/state").then((data) => emit("state", data)));
      if (has("pairing")) tasks.push(request("/admin/api/pairing").then((data) => emit("pairing", data)));
      if (wantLogs && has("log")) {
        tasks.push(
          request("/admin/api/logs", lastSeq === null ? undefined : { since: lastSeq }).then((data) => {
            for (const entry of (data && data.entries) || []) {
              lastSeq = entry.seq;
              emit("log", entry);
            }
            if (data && data.lastSeq !== undefined && data.lastSeq !== null) lastSeq = data.lastSeq;
          }),
        );
      }
      if (watchedJob) {
        tasks.push(request(`/admin/api/jobs/${encodeURIComponent(watchedJob)}`).then((data) => data && data.job && emit("job", data.job)));
      }
      if (watchedBroadcast) {
        tasks.push(
          request(`/admin/api/broadcasts/${encodeURIComponent(watchedBroadcast)}`).then((data) => {
            const payload = broadcastJobPayload(data);
            if (payload) emit("job", payload);
          }),
        );
      }
      const results = await Promise.allSettled(tasks);
      // The session is gone (the api client already emitted its event): stop polling.
      if (results.some((r) => r.status === "rejected" && r.reason && r.reason.status === 401)) stop();
    } finally {
      polling = false;
    }
  }

  function start() {
    if (running) return;
    running = true;
    errors = 0;
    openSse();
  }

  function stop() {
    running = false;
    closeSource();
    clearTimers();
    setMode("idle");
  }

  /** `logs=1` while the logs view is open; `since` is the seq of the last entry the client holds. */
  function setLogs(on, since) {
    const next = Boolean(on);
    if (since !== undefined && since !== null) lastSeq = since;
    if (next === wantLogs) return;
    wantLogs = next;
    if (running && source) {
      errors = 0;
      openSse(); // reconnect with the new query; Last-Event-ID is handled by the browser afterwards
    }
  }

  function watchJob(id) {
    watchedJob = id;
    return () => {
      if (watchedJob === id) watchedJob = null;
    };
  }

  function watchBroadcast(id) {
    watchedBroadcast = id;
    return () => {
      if (watchedBroadcast === id) watchedBroadcast = null;
    };
  }

  return {
    start,
    stop,
    subscribe,
    setLogs,
    watchJob,
    watchBroadcast,
    getMode: () => mode,
    isRunning: () => running,
    getLastSeq: () => lastSeq,
  };
}

/** The one instance of the tab (created lazily by the app; importing this file starts nothing). */
export const live = createLive();
