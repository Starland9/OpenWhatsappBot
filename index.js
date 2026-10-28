// First line of the entry file: the console capture must see everything the next lines print.
require("./lib/utils/logger").install();

// Start-up (database, settings, plugins, engines, admin panel, client) lives in lib/core/boot.js,
// shared with panel.js.
const { bootstrap } = require("./lib/core/boot");

// bootstrap() reports its own failures and exits; this only guards what happens before it starts
bootstrap({ mode: "normal" }).catch((error) => {
  console.error("Failed to start bot:", error && error.message);
  process.exit(1);
});
