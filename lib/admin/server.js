"use strict";

/**
 * The shared HTTP server of both launchers, index.js and panel.js (contracts/runtime.md section 15,
 * admin-http-api.md section 1.1).
 *
 *   createPanelServer({ botState, admin })     an unstarted http.Server. The handler is
 *                                              `(admin && admin.handle(req, res)) || legacy(req, res)`: the admin
 *                                              claims only `/admin` and `/admin/**`, every other URL (including
 *                                              `/administrator`) reaches the legacy routes of monitoring.js
 *                                              unchanged. Without an admin (ADMIN_PANEL=false) `/admin*` answers
 *                                              the JSON 404 instead of the legacy status page.
 *   startAdminServer({ admin, runtime, bind }) listen, never fatal (FR-040): resolves `{ server, url, adminUrl }`,
 *                                              or `null` when the port cannot be used (EADDRINUSE, EACCES,
 *                                              EADDRNOTAVAIL...), after one error line naming PANEL_PORT,
 *                                              PANEL_HOST and ADMIN_PANEL=false. The bot keeps running.
 *
 * The bind comes from lib/utils/runtime.js#resolveBind() (research U1: PANEL_HOST always wins, else 0.0.0.0 in a
 * container or on a panel host, else 127.0.0.1; PANEL_PORT || PORT || 3000, no drift to another port); a test
 * injects `bind` ({ host, port } or a function returning it). The printed URL is PANEL_PUBLIC_URL or
 * `http://localhost:<port>`. Limits: headersTimeout 15 s, maxHeadersCount 50, maxConnections 256, and
 * `server.close()` also closes every open connection (an SSE stream would keep it from ever finishing).
 */

const http = require("http");
const { createLegacyHandler } = require("./monitoring");
const { finish, errorBody } = require("./http/response");
const { splitUrl } = require("./http/request");
const { createLogger } = require("../utils/logger");

const HEADERS_TIMEOUT_MS = 15 * 1000;
const MAX_HEADERS_COUNT = 50;
const MAX_CONNECTIONS = 256;

function isAdminPath(url) {
  const { pathname } = splitUrl(url);
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

/** `/admin*` while no admin is mounted: the JSON 404, never the legacy status page, never a CORS header. */
function adminDisabled(req, res) {
  finish(res, { status: 404, body: errorBody({ code: "not_found" }) });
}

/**
 * @param {object} options
 * @param {object} options.botState  shared legacy bot state (runtime.state)
 * @param {object} [options.admin]   createAdmin() result; omit for the legacy-only server
 * @param {Function} [options.legacy] replaces the legacy handler (tests)
 */
function createPanelServer({ botState, admin, legacy, exit } = {}) {
  const legacyHandler = legacy || createLegacyHandler({ botState, exit });
  const server = http.createServer((req, res) => {
    if (admin && admin.handle(req, res)) return;
    if (!admin && isAdminPath(req.url)) {
      adminDisabled(req, res);
      return;
    }
    legacyHandler(req, res);
  });

  // server.close() waits for open connections: end them (SSE streams, keep-alive sockets)
  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    return originalClose(callback);
  };
  return server;
}

function publicUrlOf(config) {
  const value = (config && config.PANEL_PUBLIC_URL) || process.env.PANEL_PUBLIC_URL || "";
  return String(value).trim().replace(/\/+$/, "");
}

/**
 * @param {object} options
 * @param {object} options.admin
 * @param {object} [options.runtime]  BotRuntime: `runtime.state` is the legacy botState
 * @param {object} [options.botState]
 * @param {{ host: string, port: number }|(() => { host: string, port: number })} [options.bind]
 * @param {object} [options.config]
 * @param {object} [options.logger]
 * @returns {Promise<{ server: http.Server, url: string, adminUrl: string }|null>}
 */
async function startAdminServer(options = {}) {
  const logger = options.logger || createLogger("admin");
  const { getLang } = require("../utils/language");
  const bind =
    typeof options.bind === "function"
      ? options.bind()
      : options.bind || require("../utils/runtime").resolveBind();
  const botState = options.botState || (options.runtime && options.runtime.state);

  const server = createPanelServer({ botState, admin: options.admin, exit: options.exit });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.maxHeadersCount = MAX_HEADERS_COUNT;
  server.maxConnections = MAX_CONNECTIONS;

  return new Promise((resolve) => {
    const onError = (err) => {
      logger.error(getLang("admin.listen_failed", bind.host, bind.port, (err && err.code) || "error"));
      resolve(null);
    };
    // registered before listen(): a busy port must not become an uncaught exception
    server.once("error", onError);
    server.listen(bind.port, bind.host, () => {
      server.removeListener("error", onError);
      server.on("error", (err) => logger.error({ code: err && err.code }, "admin: http server error"));
      const port = server.address().port;
      const base = publicUrlOf(options.config) || `http://localhost:${port}`;
      const adminUrl = `${base}/admin/`;
      logger.info(getLang("admin.panel_listening", adminUrl));
      resolve({ server, url: base, adminUrl });
    });
  });
}

module.exports = {
  createPanelServer,
  startAdminServer,
  isAdminPath,
  HEADERS_TIMEOUT_MS,
  MAX_HEADERS_COUNT,
  MAX_CONNECTIONS,
};
