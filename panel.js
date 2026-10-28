/**
 * Panel.js - launcher for Bot-Hosting.net and similar panel-based hosting platforms.
 *
 * It starts the same bot as index.js (lib/core/boot.js, "panel" mode) and always answers the legacy monitoring
 * routes of lib/admin/monitoring.js (health check, status, metrics, keep-alive ping, POST /api/restart with
 * PANEL_TOKEN), even when the admin panel is turned off (ADMIN_PANEL=false): hosting panels probe them.
 *
 * Requiring this file binds no port and installs no signal handler; only running it does.
 * Exports `createServer` (the legacy-only server, or the admin one when `options.admin` is given) and `botState`,
 * the legacy state object of the bot runtime.
 */

// First line of the entry file: the console capture must see everything the next lines print.
// Only when run as the entry point, so that requiring this file (tests) changes nothing.
if (require.main === module) require("./lib/utils/logger").install();

const { WhatsAppClient } = require('./lib/baileys/client');
const { createBotRuntime } = require('./lib/core/botRuntime');
const { createPanelServer } = require('./lib/admin/server');
const { bootstrap } = require('./lib/core/boot');

// The client and the runtime exist from the start (no I/O): botState is the runtime's own object
const client = new WhatsAppClient();
const runtime = createBotRuntime({ client, mode: 'panel' });
const botState = runtime.state;

/**
 * Create the HTTP server (not listening). Without `options.admin` it serves the legacy routes only.
 * PREFIX and PANEL_TOKEN are read per request by the legacy handler.
 */
function createServer(options = {}) {
  return createPanelServer({ botState, admin: options.admin, exit: options.exit });
}

/**
 * Main entry point
 */
async function main() {
  try {
    await bootstrap({ mode: 'panel', client, runtime });
  } catch (error) {
    console.error('Fatal error:', error && error.message);
    process.exit(1);
  }
}

// Export for testing
module.exports = { createServer, botState };

// Run if this is the main module
if (require.main === module) {
  main();
}
