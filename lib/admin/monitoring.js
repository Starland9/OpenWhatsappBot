"use strict";

/**
 * The legacy public routes of panel.js, moved verbatim (admin-http-api.md section 1.2, FR-011, SC-010):
 * `/`, `/health`, `/healthz`, `/status`, `/ping`, `/metrics`, `/api/info`, `POST /api/restart`, `OPTIONS`, and the
 * status page for any other path. Matching is exact equality on the RAW `req.url` (a query string defeats it) and
 * the method is ignored except for `/api/restart`. Frozen by test/panel-legacy.test.js and test/panel.test.js.
 *
 *   const handler = createLegacyHandler({ botState });      // (req, res) => void
 *
 * Every answer keeps the legacy CORS headers (`Access-Control-Allow-Origin: *`...), `/api/restart` included
 * (byte compatibility wins over the proposal to drop them there). The only change since panel.js: `/api/info`
 * `prefix` reads the live `config.PREFIX`. `PANEL_TOKEN` is read per request, constant-time compared as digests.
 * The restart is the legacy one (`process.exit(0)` one second after the answer, a supervisor restarts the process);
 * the in-process restart of the panel is POST /admin/api/restart, a different code path.
 *
 * `config`, the logger and `process.exit` are resolved when used, so a test can replace them.
 */

const crypto = require("crypto");
const { createLogger } = require("../utils/logger");

const RESTART_DELAY = 1000; // ms between the /api/restart answer and process.exit

const getConfig = () => require("../../config");

/**
 * Check `Authorization: Bearer <token>` against the configured token.
 * Both sides are hashed first so that the buffers handed to timingSafeEqual always have the
 * same length (a token of another length takes the same time and leaks nothing).
 */
function hasValidToken(req, token) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  if (!match) return false;
  const digest = (value) => crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(digest(match[1].trim()), digest(token));
}

/** Format uptime in human-readable format */
function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

const uptimeOf = (botState) =>
  botState.startTime ? Math.floor((Date.now() - botState.startTime) / 1000) : 0;

/**
 * @param {object} options
 * @param {object} options.botState  the shared bot state object (status, startTime, isConnected, ...)
 * @param {(code: number) => void} [options.exit]  defaults to process.exit, looked up when called
 * @param {object} [options.logger]
 * @returns {(req: import("http").IncomingMessage, res: import("http").ServerResponse) => void}
 */
function createLegacyHandler({ botState, exit, logger } = {}) {
  if (!botState) throw new Error("createLegacyHandler needs a botState object");
  const log = logger || createLogger("panel");
  const doExit = exit || ((code) => process.exit(code));

  function handleHealthCheck(res) {
    const isHealthy = botState.status === "running" && botState.isConnected;
    res.writeHead(isHealthy ? 200 : 503);
    res.end(JSON.stringify({
      status: isHealthy ? "healthy" : "unhealthy",
      botStatus: botState.status,
      connected: botState.isConnected,
      timestamp: new Date().toISOString(),
    }));
  }

  function handleStatus(res) {
    const uptime = uptimeOf(botState);
    res.writeHead(200);
    res.end(JSON.stringify({
      status: botState.status,
      connected: botState.isConnected,
      uptime: uptime,
      uptimeFormatted: formatUptime(uptime),
      version: botState.version,
      messagesProcessed: botState.messagesProcessed,
      lastActivity: botState.lastActivity,
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    }));
  }

  function handlePing(res) {
    res.writeHead(200);
    res.end(JSON.stringify({
      pong: true,
      timestamp: Date.now(),
      latency: 0,
    }));
  }

  function handleMetrics(res) {
    const mem = process.memoryUsage();
    const uptime = uptimeOf(botState);
    res.writeHead(200);
    res.end(JSON.stringify({
      bot: {
        status: botState.status,
        connected: botState.isConnected,
        uptime: uptime,
        version: botState.version,
        messagesProcessed: botState.messagesProcessed,
      },
      system: {
        memory: {
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
          rss: Math.round(mem.rss / 1024 / 1024),
          external: Math.round(mem.external / 1024 / 1024),
        },
        memoryUnit: "MB",
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      timestamp: new Date().toISOString(),
    }));
  }

  function handleBotInfo(res) {
    const config = getConfig();
    res.writeHead(200);
    res.end(JSON.stringify({
      name: "OpenWhatsappBot",
      version: config.VERSION,
      prefix: config.PREFIX, // live: the module constant of panel.js went stale after a change
      repository: "https://github.com/Starland9/OpenWhatsappBot",
      documentation: "https://starland9.github.io/OpenWhatsappBot",
      features: [
        "AI Chat (Gemini, GPT)",
        "Media Downloads",
        "Sticker Creation",
        "Group Management",
        "Auto Responder",
        "Multi-language Support",
      ],
    }));
  }

  /**
   * Restart endpoint handler. Disabled (403) unless PANEL_TOKEN is set; then it needs
   * `Authorization: Bearer <PANEL_TOKEN>` (401 otherwise). config.PANEL_TOKEN is read per request.
   */
  function handleRestart(req, res) {
    const token = getConfig().PANEL_TOKEN;
    if (!token) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "Restart endpoint disabled: PANEL_TOKEN is not configured" }));
      return;
    }
    if (!hasValidToken(req, token)) {
      log.warn("Rejected unauthorized /api/restart request");
      res.setHeader("WWW-Authenticate", "Bearer");
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    res.writeHead(200);
    res.end(JSON.stringify({
      message: "Bot restart initiated",
      timestamp: new Date().toISOString(),
    }));

    // Schedule restart after response is sent
    setTimeout(() => {
      log.info("Restart requested via panel API");
      doExit(0); // PM2/panel will restart the process
    }, RESTART_DELAY);
  }

  return function legacyHandler(req, res) {
    const url = req.url;
    const method = req.method;

    // Set CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Content-Type", "application/json");

    // Handle OPTIONS preflight
    if (method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    // Route handling
    switch (url) {
      case "/":
      case "/health":
      case "/healthz":
        handleHealthCheck(res);
        break;

      case "/status":
        handleStatus(res);
        break;

      case "/ping":
        handlePing(res);
        break;

      case "/metrics":
        handleMetrics(res);
        break;

      case "/api/info":
        handleBotInfo(res);
        break;

      case "/api/restart":
        if (method === "POST") {
          handleRestart(req, res);
        } else {
          res.setHeader("Allow", "POST");
          res.writeHead(405);
          res.end(JSON.stringify({ error: "Method not allowed" }));
        }
        break;

      default:
        // Serve a simple status page for unknown routes
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(getStatusHTML(botState, getConfig().VERSION));
    }
  };
}

/**
 * Generate HTML status page
 */
function getStatusHTML(botState, VERSION) {
  const uptime = botState.startTime 
    ? Math.floor((Date.now() - botState.startTime) / 1000) 
    : 0;
  const statusColor = botState.isConnected ? '#25D366' : '#FF6B6B';
  const statusText = botState.isConnected ? 'Connected' : 'Disconnected';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenWhatsappBot - Panel</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%);
      color: #fff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      max-width: 500px;
      width: 100%;
      background: #1e1e1e;
      border-radius: 16px;
      padding: 32px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    }
    .header {
      text-align: center;
      margin-bottom: 32px;
    }
    .logo {
      font-size: 48px;
      margin-bottom: 8px;
    }
    h1 {
      font-size: 24px;
      color: #25D366;
      margin-bottom: 4px;
    }
    .version {
      color: #666;
      font-size: 14px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: ${statusColor}22;
      border: 1px solid ${statusColor};
      color: ${statusColor};
      padding: 8px 16px;
      border-radius: 20px;
      font-weight: 600;
      margin: 16px 0;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: ${statusColor};
      animation: ${botState.isConnected ? 'pulse 2s infinite' : 'none'};
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
      margin-top: 24px;
    }
    .stat {
      background: #2a2a2a;
      padding: 16px;
      border-radius: 12px;
      text-align: center;
    }
    .stat-value {
      font-size: 24px;
      font-weight: bold;
      color: #25D366;
    }
    .stat-label {
      font-size: 12px;
      color: #888;
      margin-top: 4px;
    }
    .endpoints {
      margin-top: 24px;
      padding: 16px;
      background: #2a2a2a;
      border-radius: 12px;
    }
    .endpoints h3 {
      font-size: 14px;
      color: #888;
      margin-bottom: 12px;
    }
    .endpoint {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #333;
      font-size: 14px;
    }
    .endpoint:last-child { border: none; }
    .endpoint code {
      background: #333;
      padding: 2px 8px;
      border-radius: 4px;
      color: #25D366;
    }
    .footer {
      text-align: center;
      margin-top: 24px;
      color: #666;
      font-size: 12px;
    }
    .footer a { color: #25D366; text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">📱</div>
      <h1>OpenWhatsappBot</h1>
      <span class="version">v${VERSION}</span>
      <div class="status-badge">
        <span class="status-dot"></span>
        ${statusText}
      </div>
    </div>
    
    <div class="stats">
      <div class="stat">
        <div class="stat-value">${formatUptime(uptime)}</div>
        <div class="stat-label">Uptime</div>
      </div>
      <div class="stat">
        <div class="stat-value">${botState.messagesProcessed}</div>
        <div class="stat-label">Messages</div>
      </div>
      <div class="stat">
        <div class="stat-value">${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB</div>
        <div class="stat-label">Memory</div>
      </div>
      <div class="stat">
        <div class="stat-value">${botState.status}</div>
        <div class="stat-label">Status</div>
      </div>
    </div>

    <div class="endpoints">
      <h3>API Endpoints</h3>
      <div class="endpoint">
        <span>Health Check</span>
        <code>GET /health</code>
      </div>
      <div class="endpoint">
        <span>Status</span>
        <code>GET /status</code>
      </div>
      <div class="endpoint">
        <span>Ping</span>
        <code>GET /ping</code>
      </div>
      <div class="endpoint">
        <span>Metrics</span>
        <code>GET /metrics</code>
      </div>
    </div>

    <div class="footer">
      <p>Powered by <a href="https://github.com/Starland9/OpenWhatsappBot" target="_blank">OpenWhatsappBot</a></p>
      <p>Compatible with bot-hosting.net</p>
    </div>
  </div>
</body>
</html>
  `.trim();
}


module.exports = { createLegacyHandler, getStatusHTML, formatUptime, hasValidToken, RESTART_DELAY };
