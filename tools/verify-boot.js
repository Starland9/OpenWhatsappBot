#!/usr/bin/env node
"use strict";

/**
 * Smoke boot of the code on disk (contracts/runtime.md section 11, "updater" step c). The self-update runs this in a
 * child process after the new code is merged and before the bot restarts, so a bad commit is caught while the old
 * version is still reachable by `git reset --hard`:
 *
 *   node tools/verify-boot.js
 *
 * It loads `config`, `lib/database` (models, additive `sync()` on an in-memory database) and every plugin, and exits
 * non-zero unless at least one command registered. It never connects to WhatsApp, never opens the real database,
 * never binds a port and never starts the update checker: the environment is forced below, whatever the caller
 * passed. A 60 s watchdog ends a hung load.
 *
 * Exit code: 0 booted, 1 not bootable (the reason goes to stderr, never a setting value), 3 timeout.
 */

const WATCHDOG_MS = 60 * 1000;

// Forced before anything requires `config`: the real database, panel and checker stay out of this process
process.env.DATABASE_URL = ":memory:";
process.env.LOG_LEVEL = "silent";
process.env.ADMIN_PANEL = "false";
process.env.UPDATE_CHECK = "false";

const fail = (message) => {
  process.stderr.write(`verify-boot: ${message}\n`);
  process.exit(1);
};

async function main() {
  const database = require("../lib/database");
  if (typeof database.sync === "function") await database.sync();

  const loader = require("../lib/plugins/loader");
  const registry = require("../lib/plugins/registry");
  const { loaded, failed } = await loader.loadAll();

  const commands = registry.getCommands().length;
  if (commands < 1) fail(`no command registered (${loaded.length} plugin(s) loaded, ${failed.length} failed)`);

  for (const entry of failed) process.stderr.write(`verify-boot: plugin ${entry.file} failed to load\n`);
  process.stdout.write(`verify-boot: ok, ${commands} command(s) from ${loaded.length} plugin(s)\n`);
}

const watchdog = setTimeout(() => {
  process.stderr.write("verify-boot: timeout\n");
  process.exit(3);
}, WATCHDOG_MS);

main().then(
  () => {
    clearTimeout(watchdog);
    process.exit(0); // plugins may leave handles open: the check is done
  },
  (err) => fail(`${(err && err.name) || "Error"}: ${(err && err.message) || "unknown"}`.slice(0, 300)),
);
