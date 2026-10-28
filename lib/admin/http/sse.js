"use strict";

/**
 * Server-sent events: one multiplexed stream per browser tab (admin-http-api.md section 3, EVT-1).
 *
 *   GET /admin/api/events?logs=0|1&since=<seq>      (session, touch:false, same-origin, db:r)
 *
 *   const sse = createSse({ hub, auth, ring });
 *   router.route({ ..., handler: sse.handler });    // see lib/admin/routes/events.js
 *   sse.count() / sse.closeAll()                    // admin.stop() closes every stream
 *
 * The stream starts with `retry: 3000` and a 2 KB comment (to flush buffering proxies), then one `state` and one
 * `pairing` event (the hub snapshots), then with `logs=1` the replay of the log ring after `Last-Event-ID` (which
 * wins) or `since`, then live events from the hub: `state`, `pairing`, `log` (its `id:` is the log `seq`), `job`
 * and `session`. A heartbeat comment (`: hb`) every 15 s keeps proxies open and re-checks the session through
 * `deps.auth.authenticate` (it must not extend the idle clock): when the session is gone the server sends the
 * `session` event and ends the stream. Limits: 5 streams per session and 20 in total (429 rate_limited), and a
 * client whose `res.writableLength` exceeds 1 MiB is dropped. The heartbeat timer exists only while a stream is
 * open (unref()'d), and every stream is torn down when the socket closes. Payloads never hold a secret, the QR
 * string or a pairing code (the producers' business).
 */

const { AdminError } = require("./response");

const RETRY_MS = 3000;
const HEARTBEAT_MS = 15 * 1000;
const PREAMBLE_COMMENT_BYTES = 2048;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const PER_SESSION = 5;
const TOTAL = 20;
const REPLAY_LIMIT = 1000;
const LIVE_TOPICS = ["state", "pairing", "job"];
const SESSION_GONE = new Set(["session_expired", "unauthenticated", "token_invalid"]);

const globalTimers = {
  setInterval: (...args) => setInterval(...args),
  clearInterval: (handle) => clearInterval(handle),
};

/** One SSE frame. `data` is a single JSON line, so no payload can break the framing. */
function frame(event, payload, id) {
  let text = "";
  if (id !== undefined && id !== null) text += `id: ${id}\n`;
  text += `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  return text;
}

function parseSeq(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  return /^\d{1,15}$/.test(text) ? Number(text) : null;
}

function createSse({ hub, auth, ring, now = Date.now, timers = globalTimers, logger } = {}) {
  /** @type {Set<object>} */
  const streams = new Set();
  const perSession = new Map();

  const getRing = () => ring || require("../logs/ring");

  function countFor(sessionId) {
    return perSession.get(sessionId) || 0;
  }

  async function handler(ctx) {
    const { req, res, session } = ctx;
    const sessionId = session && session.id !== undefined ? String(session.id) : "";

    if (streams.size >= TOTAL || countFor(sessionId) >= PER_SESSION) {
      throw new AdminError("rate_limited", { params: { retryAfterMs: RETRY_MS } });
    }

    const wantsLogs = ctx.query.logs === "1";
    // Last-Event-ID (sent by the browser on its own reconnects) overrides ?since=
    const lastEventId = parseSeq(req.headers["last-event-id"]);
    const since = lastEventId !== null ? lastEventId : parseSeq(ctx.query.since);

    const stream = { res, sessionId, closed: false, ready: false, queue: [], unsubscribers: [], heartbeat: null };
    streams.add(stream);
    perSession.set(sessionId, countFor(sessionId) + 1);

    function close() {
      if (stream.closed) return;
      stream.closed = true;
      streams.delete(stream);
      const left = countFor(sessionId) - 1;
      if (left > 0) perSession.set(sessionId, left);
      else perSession.delete(sessionId);
      for (const off of stream.unsubscribers) {
        try {
          off();
        } catch {
          // ignore
        }
      }
      stream.unsubscribers = [];
      if (stream.heartbeat) timers.clearInterval(stream.heartbeat);
      stream.heartbeat = null;
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    }
    stream.close = close;

    /** Write a frame; drops the client when it does not read (backpressure past 1 MiB). */
    function write(text) {
      if (stream.closed || res.writableEnded || res.destroyed) return false;
      try {
        res.write(text);
      } catch {
        close();
        return false;
      }
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        if (logger && logger.debug) logger.debug("admin: slow event-stream client dropped");
        close();
        res.destroy();
        return false;
      }
      return true;
    }

    function send(event, payload, id) {
      if (!stream.ready) {
        stream.queue.push([event, payload, id]);
        return;
      }
      write(frame(event, payload, id));
    }

    function endWithSessionEvent(reason) {
      write(frame("session", { reason }));
      close();
    }

    res.on("close", close);
    res.on("error", close);

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    write(`retry: ${RETRY_MS}\n\n`);
    write(`: ${" ".repeat(PREAMBLE_COMMENT_BYTES)}\n\n`);

    // subscribe BEFORE the snapshots so nothing published in between is lost (queued, then flushed)
    for (const topic of LIVE_TOPICS) {
      stream.unsubscribers.push(hub.subscribe(topic, (payload) => send(topic, payload)));
    }
    stream.unsubscribers.push(
      hub.subscribe("session", (payload) => {
        if (!payload || String(payload.sessionId) !== sessionId) return;
        endWithSessionEvent(payload.reason || "revoked");
      }),
    );
    if (wantsLogs) {
      stream.unsubscribers.push(hub.subscribe("log", (entry) => send("log", entry, entry && entry.seq)));
    }

    // initial snapshots
    for (const topic of ["state", "pairing"]) {
      const payload = await hub.snapshot(topic);
      if (payload !== null) write(frame(topic, payload));
    }

    // replay the log ring (only the `log` topic is replayable)
    let lastReplayed = -1;
    if (wantsLogs && since !== null && !stream.closed) {
      lastReplayed = since;
      for (const entry of getRing().list({ since, limit: REPLAY_LIMIT })) {
        write(frame("log", entry, entry.seq));
        lastReplayed = entry.seq;
      }
    }

    stream.ready = true;
    for (const [event, payload, id] of stream.queue.splice(0)) {
      // a live log entry already sent by the replay is not repeated
      if (event === "log" && payload && payload.seq <= lastReplayed) continue;
      write(frame(event, payload, id));
    }

    // heartbeat: keeps proxies open, re-checks the session, never extends it
    if (!stream.closed) {
      stream.heartbeat = timers.setInterval(async () => {
        if (stream.closed) return;
        write(": hb\n\n");
        if (stream.closed || !auth || typeof auth.authenticate !== "function") return;
        try {
          await auth.authenticate(
            {
              req,
              res: null,
              route: ctx.route,
              requestId: ctx.requestId,
              pathname: ctx.pathname,
              params: ctx.params,
              query: ctx.query,
              body: null,
              session: null,
              origin: ctx.origin,
              now: now(),
            },
            ctx.route,
          );
        } catch (err) {
          if (err && SESSION_GONE.has(err.code)) endWithSessionEvent(err.reason || "expired");
          // anything else (database down...) keeps the stream: the cached session still works
        }
      }, HEARTBEAT_MS);
      if (stream.heartbeat && stream.heartbeat.unref) stream.heartbeat.unref();
    }
  }

  return {
    handler,
    count: () => streams.size,
    countForSession: (sessionId) => countFor(String(sessionId)),
    closeAll() {
      for (const stream of [...streams]) stream.close();
    },
  };
}

module.exports = {
  createSse,
  frame,
  RETRY_MS,
  HEARTBEAT_MS,
  PER_SESSION,
  TOTAL,
  MAX_BUFFERED_BYTES,
  PREAMBLE_COMMENT_BYTES,
};
