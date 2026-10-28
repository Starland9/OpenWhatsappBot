"use strict";

/**
 * Auto-loader of the route modules (rule 13 of the implementation plan): every `lib/admin/routes/*.js` except
 * this file, in sorted order, is required and its `register()` is called once:
 *
 *   register({ router, deps, hub, jobs, audit, onStart, onStop })
 *
 *   router            `route({...})` of lib/admin/http/router.js (see its header for the options)
 *   deps              the dependencies handed to createAdmin plus the shared instances (auth, hub, jobs, uploads,
 *                     sse, trustProxy, clock, logger, dataDir, rootDir). Engines are resolved lazily by the module,
 *                     inside register() or the handler: `deps.settingsStore || require("../../utils/settingsStore")`
 *   hub               topic hub (lib/admin/events.js): publish / subscribe / setSnapshot / publishState
 *   jobs              registry of long operations (lib/admin/jobs.js)
 *   audit             lib/admin/audit.js (record, auditDiff...), or a no-op stand-in while that module is absent
 *   onStart(fn)       run `fn` (sync or async) when admin.start() runs, after the database is ready
 *   onStop(fn)        run `fn` when admin.stop() runs (clear timers, unsubscribe)
 *
 * Nobody edits a shared index: a new area adds one file here. A module without `register`, or whose `register`
 * throws, aborts createAdmin loudly (a half-registered admin would silently leave routes without their guard).
 */

const fs = require("fs");
const path = require("path");

function registerAll({ dir = __dirname, ...registerArgs } = {}) {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".js") && name !== "index.js")
    .sort();
  for (const file of files) {
    let mod;
    try {
      mod = require(path.join(dir, file));
    } catch (err) {
      throw new Error(`admin route module ${file} failed to load: ${err.message}`, { cause: err });
    }
    if (typeof mod.register !== "function") {
      throw new Error(`admin route module ${file} does not export register()`);
    }
    try {
      mod.register(registerArgs);
    } catch (err) {
      throw new Error(`admin route module ${file} failed to register: ${err.message}`, { cause: err });
    }
  }
  return files;
}

module.exports = { registerAll };
