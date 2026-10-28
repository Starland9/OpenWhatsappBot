"use strict";
/**
 * The admin panel with every REAL service and engine behind it (T218 secrets scan, T220 integration): the real
 * `createAdmin` and authentication of test/helpers/adminHarness.js, an in-memory database, the real plugin registry,
 * settings store, secret box (in a temporary directory), text overrides, command state, statistics, housekeeping,
 * broadcaster, alerts, updater and yt-dlp updater, the real log ring, redactor and event bus. Only the WhatsApp side is
 * a stand-in: a fake client and a fake bot runtime (with QR and pairing-code sentinels a leak would show).
 *
 *   fakes.setupEnv({ env: {...} });                       FIRST, before anything of the bot is required
 *   const t = await createFullAdmin({ setup: { env } });  t.admin is NOT started: call `await t.admin.start()`
 *   t.engines.alerts / .broadcaster / ...                 the engine modules (none is started by the helper)
 *   t.botClient, t.runtime, t.registry, t.root
 *   await t.closeFull()                                   stops what the test started, closes the admin, removes the
 *                                                         temporary directory
 *
 * The broadcaster is the real engine built by `createBroadcaster` on the fake clock and on a media root inside the
 * temporary directory (the default instance of the module would write under the real `data/`); `rootDir` and
 * `dataDir` of the admin point to that directory too, so the storage page, the backups and the uploads stay in it.
 *
 * Options: `setup` (fakes.setupEnv options of the harness), `config`, `clock`, `logger` (default: the harness'
 * silent recorder), `plugins: false` (do not load the plugins), `runtime` (an object, or `(botClient) => runtime`;
 * default: the fake bot runtime), `deps`
 * (anything else for createAdmin, wins).
 * The helper never touches the real `data/`, `sessions/` or `database.db`, and never reads `config.env`.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const fakes = require("./fakes");
const { createTestAdmin } = require("./adminHarness");
const { createFakeRuntime } = require("./fakeBotRuntime");
const { createClock } = require("./fakeClock");

const ENGINE_NAMES = ["stats", "housekeeping", "broadcaster", "alerts", "updater", "textOverrides", "commandState", "ytdlpUpdate"];

async function createFullAdmin(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-admin-full-"));
  const ROOT = fakes.ROOT;
  const rootRequire = (id) => require(path.join(ROOT, id));

  // the key of the secret box goes to the temporary directory BEFORE anything can encrypt a setting
  const secretBox = rootRequire("lib/utils/secretBox");
  secretBox.configure({ dir: path.join(root, "data") });

  const clock = opts.clock || createClock();
  const engines = {};
  for (const name of ENGINE_NAMES) engines[name] = rootRequire(`lib/utils/${name}`);
  engines.broadcaster = rootRequire("lib/utils/broadcaster").createBroadcaster({
    rootDir: root,
    clock: () => clock.now(),
    random: () => 0,
    timers: clock.timers,
  });
  const registry = opts.plugins === false ? rootRequire("lib/plugins/registry") : (await fakes.loadAllPlugins()).registry;

  const botClient = opts.client || fakes.fakeClient();
  const runtime = typeof opts.runtime === "function" ? opts.runtime(botClient) : opts.runtime || createFakeRuntime();

  const t = await createTestAdmin({
    setup: opts.setup,
    clock,
    config: opts.config,
    logger: opts.logger,
    kdf: opts.kdf,
    trustProxy: opts.trustProxy,
    deps: {
      secretBox,
      settingsStore: rootRequire("lib/utils/settingsStore"),
      languageManager: rootRequire("lib/utils/language").languageManager,
      textOverrides: engines.textOverrides,
      runtime,
      client: botClient,
      registry,
      commandState: engines.commandState,
      stats: engines.stats,
      bus: rootRequire("lib/utils/events"),
      ring: rootRequire("lib/admin/logs/ring"),
      redactor: rootRequire("lib/admin/logs/redactor"),
      broadcaster: engines.broadcaster,
      alerts: opts.alerts || engines.alerts,
      updater: engines.updater,
      ytdlpUpdate: engines.ytdlpUpdate,
      maintenanceMode: rootRequire("lib/utils/maintenanceMode"),
      rootDir: root,
      dataDir: path.join(root, "data"),
      ...(opts.deps || {}),
    },
  });
  await engines.textOverrides.load({ models: t.db });

  const started = [];
  t.engines = engines;
  t.runtime = runtime;
  t.botClient = botClient;
  t.registry = registry;
  t.root = root;
  t.secretBox = secretBox;
  /** Remember an engine the test started, so closeFull() stops it */
  t.track = (stop) => {
    started.push(stop);
    return stop;
  };
  t.closeFull = async () => {
    for (const stop of started.splice(0).reverse()) {
      try {
        await stop();
      } catch {
        // stopping never throws
      }
    }
    await t.close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return t;
}

module.exports = { createFullAdmin, ENGINE_NAMES };
