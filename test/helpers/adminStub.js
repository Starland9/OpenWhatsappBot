"use strict";
/**
 * Test scaffolding for the HTTP core of the admin panel (no database, no WhatsApp): a stub of the `deps.auth`
 * interface documented in lib/admin/http/router.js, an unstarted admin on 127.0.0.1:0, and a raw HTTP requester
 * that sends the request target exactly as written (fetch would normalise `..` and `%2e`).
 *
 *   const t = await startStubAdmin({ extraRoutes: [fn], runtime: { dbReady: true }, ... });
 *   t.session()                      -> { cookie, csrf, headers } of a logged-in stub session
 *   t.get(path, headers)             authenticated GET            t.send(method, path, { headers, body, json })
 *   t.raw({ method, path, headers, body, chunks })   -> { status, headers, text, json }
 *   t.close()
 *
 * The full end-to-end harness of the auth feature is test/helpers/adminHarness.js (agent F8); this one only
 * exists so the HTTP core can be tested before, and independently of, the real authentication.
 */

const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { createAdmin } = require("../../lib/admin");
const { createPanelServer } = require("../../lib/admin/server");
const { AdminError } = require("../../lib/admin/http/response");
const { createClock } = require("./fakeClock");

function recordingLogger() {
  const lines = [];
  const log = (level) => (...args) => lines.push({ level, args });
  return { lines, debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

/** A stub of deps.auth: cookie `sid=<name>` selects a session, `owb_setup=ok` is a valid setup grant. */
function createStubAuth() {
  const sessions = new Map();
  const calls = { authenticate: [], touch: [] };
  return {
    sessions,
    calls,
    addSession(name = "good", extra = {}) {
      const session = { id: `session-${name}`, csrf: `csrf-${name}`, ...extra };
      sessions.set(name, session);
      return session;
    },
    authenticate(ctx, route) {
      calls.authenticate.push(`${route.method} ${route.path}`);
      const header = ctx.req.headers.cookie || "";
      if (route.auth === "setup") {
        if (/(?:^|;\s*)owb_setup=ok/.test(header)) return { kind: "setup" };
        throw new AdminError("token_invalid");
      }
      const match = /(?:^|;\s*)sid=([^;]+)/.exec(header);
      if (!match) throw new AdminError("unauthenticated");
      const session = sessions.get(match[1]);
      if (!session) throw new AdminError("session_expired");
      return session;
    },
    touch(session) {
      calls.touch.push(session.id);
    },
  };
}

/** Send a request whose target is used verbatim. `chunks` sends a chunked body in several writes. */
function rawRequest({ port, method = "GET", path: target = "/", headers = {}, body, chunks }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: target, headers, agent: false }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => {
        const buffer = Buffer.concat(parts);
        const text = buffer.toString("utf8");
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buffer,
          text,
          get json() {
            return JSON.parse(text);
          },
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (chunks) {
      for (const chunk of chunks) req.write(chunk);
      req.end();
    } else {
      req.end(body);
    }
  });
}

/**
 * @param {object} [options]  createAdmin deps (extraRoutes, runtime, config, maintenanceMode, publicDir...) plus
 *   `auth` (default: a stub with one session "good") and `clock`
 */
async function startStubAdmin(options = {}) {
  const auth = options.auth || createStubAuth();
  if (auth.addSession && !auth.sessions.size) auth.addSession("good");
  const clock = options.clock || createClock();
  const logger = options.logger || recordingLogger();
  const ownDataDir = !options.dataDir;
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "owb-admin-http-"));
  const admin = createAdmin({
    config: {}, // never load the real config.js from these tests
    runtime: { dbReady: true },
    maintenanceMode: { isActive: () => false },
    bus: new (require("events").EventEmitter)(),
    ring: {
      list: () => [],
      subscribe: () => () => {},
    },
    ...options,
    auth,
    clock,
    logger,
    dataDir,
  });
  const server = createPanelServer({ botState: { status: "starting" }, admin });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const t = {
    admin,
    server,
    auth,
    clock,
    logger,
    dataDir,
    port,
    base,
    raw: (req) => rawRequest({ port, ...req }),

    /** Headers of a fully valid unsafe request of the stub session `name`. */
    session(name = "good") {
      const session = auth.sessions.get(name);
      return {
        cookie: `sid=${name}`,
        csrf: session.csrf,
        headers: {
          Cookie: `sid=${name}`,
          Origin: base,
          "X-CSRF-Token": session.csrf,
          "Content-Type": "application/json",
        },
      };
    },

    get(target, headers = {}, name = "good") {
      return rawRequest({ port, path: target, headers: { Cookie: `sid=${name}`, ...headers } });
    },

    /** An authenticated, fully guarded request; `body` (object) is sent as JSON unless `rawBody` is given. */
    send(method, target, { headers = {}, body, rawBody, name = "good" } = {}) {
      const base = t.session(name).headers;
      const payload = rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body);
      const merged = { ...base, ...headers };
      for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
      if (payload !== undefined) merged["Content-Length"] = Buffer.byteLength(payload);
      return rawRequest({ port, method, path: target, headers: merged, body: payload });
    },

    async close() {
      await admin.stop();
      await new Promise((resolve) => server.close(resolve));
      clock.restore();
      if (ownDataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return t;
}

module.exports = { startStubAdmin, createStubAuth, rawRequest, recordingLogger };
