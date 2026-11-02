"use strict";
/**
 * Lifecycle of the messaging engine inside the bot (feature 004, contracts/runtime.md 16.1-16.5 and 18): how it boots
 * with and without the admin panel, what the switch does to the timer, the listeners and the queue, and what a
 * restore, an in-process restart and a registry failure leave behind.
 *
 * The REAL lib/utils/apiState.js drives the switch (config.ADMIN_PANEL is turned on for the test that needs it); the
 * engine is the real facade over the in-memory database with a fake clock and socket (test/helpers/messagingKit.js).
 * Boot is the real `bootstrap` with recorders for everything but the messaging collaborators. (That createPanelServer
 * tries `api.handle` before `admin.handle` is pinned by test/api-mount.test.js; the boot order by test/boot.test.js.)
 */

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const { createEngineKit } = require("./helpers/messagingKit");
const config = require("../config");
const apiState = require("../lib/utils/apiState");
const maintenanceMode = require("../lib/utils/maintenanceMode");
const { bootstrap } = require("../lib/core/boot");

const SEC = 1000;
const MIN = 60 * SEC;
const PN = "237690000001@s.whatsapp.net";

let kit;
let key;
let originalPanel;

beforeEach(() => {
  originalPanel = config.ADMIN_PANEL;
  maintenanceMode._reset();
});

afterEach(async () => {
  config.ADMIN_PANEL = originalPanel;
  if (kit) {
    await kit.check({ pendingMedia: true });
    await kit.close();
    kit = null;
  }
  // the real switch is process-wide: leave it as it was found (off, no row)
  const db = await fakes.syncDb();
  await db.ApiState.destroy({ where: {} });
  await apiState.load({ models: db });
  maintenanceMode._reset();
});

async function boot(options = {}) {
  kit = await createEngineKit({ deps: { apiState, ...options.deps }, ...options.kit });
  key = await kit.key();
  await apiState.load({ models: kit.db });
  return kit;
}

const queuedRow = (over = {}) => ({
  publicId: `msg_${(over.tag || "A").repeat(22)}`,
  apiKeyId: key.id,
  recipient: PN,
  format: "text",
  status: "queued",
  acceptedAt: new Date(kit.now()),
  expiresAt: new Date(kit.now() + 10 * MIN),
  payload: { v: 1, input: { text: "left behind", linkPreview: false }, media: null, quote: null },
  ...over.row,
});

/** The real bootstrap with recorders for everything but the messaging collaborators */
function miniBoot({ panel, engines = {} }) {
  const log = [];
  const proc = new EventEmitter();
  proc.env = {};
  const runtime = {
    client: kit.client,
    state: { status: "starting", isConnected: false, lastActivity: null, errors: [] },
    handlerOptions: {},
    errors: [],
    dbReady: false,
    recordError() {},
    onShutdown(fn) {
      this.hooks.push(fn);
    },
    hooks: [],
    setTextOverrides() {},
    shutdown() {},
  };
  const recorder = (name) => ({ start: () => log.push(`${name}.start`), startChecker: () => log.push(`${name}.start`), stop() {} });
  const deps = {
    process: proc,
    env: proc.env,
    exit: (code) => log.push(`exit:${code}`),
    logger: { install() {}, createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return this; } }), setLevel() {} },
    config: { VERSION: "0.0.0-test", ADMIN_PANEL: panel, LOG_LEVEL: "silent", KEEP_ALIVE_INTERVAL: 60000 },
    memoryManager: { performCleanup() {} },
    WhatsAppClient: function () {
      throw new Error("a client was supplied");
    },
    settingsStore: { onChange() {}, load: async () => {}, markInForce() {} },
    secretBox: {},
    redactor: {},
    languageManager: { reload() {} },
    database: { DATABASE: { authenticate: async () => {} }, sync: async () => {}, ApiState: kit.db.ApiState },
    registry: {},
    bus: {},
    ring: {},
    PluginLoader: { loadAll: async () => {} },
    attachHandlers: () => {},
    createAdmin: () => {
      log.push("createAdmin");
      return { handle: () => false, start: async () => {}, stop: async () => {} };
    },
    createApi: () => {
      log.push("createApi");
      throw new Error("no API may be built");
    },
    startAdminServer: async () => ({ server: { close: (cb) => cb && cb() } }),
    engines: {
      stats: recorder("stats"),
      housekeeping: recorder("housekeeping"),
      broadcaster: recorder("broadcaster"),
      messaging: kit.messaging,
      alerts: recorder("alerts"),
      updater: recorder("updater"),
      textOverrides: { load: async () => {} },
      commandState: null,
      ytdlpUpdate: null,
      apiState,
      ...engines,
    },
  };
  return { log, deps, runtime, run: () => bootstrap({ mode: "normal", client: kit.client, runtime, deps }) };
}

describe("ADMIN_PANEL=false: no API is built and the engine boots in recovery-only mode (16.4, FR-007)", () => {
  test("leftover queued rows are cancelled api_disabled, a sending row becomes unknown, no timer, no listener", async () => {
    await boot({ deps: { receipts: () => ({ handle() {} }) } });
    config.ADMIN_PANEL = false;
    await kit.db.ApiMessage.bulkCreate([
      queuedRow({ tag: "A" }),
      queuedRow({ tag: "B" }),
      queuedRow({ tag: "C", row: { status: "sending", acceptedAt: new Date(kit.now() - 10 * SEC), sendingAt: new Date(kit.now() - 5 * SEC), waId: "3EB0LEFTOVERSENDING001" } }),
    ]);

    const b = miniBoot({ panel: false });
    const result = await b.run();
    assert.ok(result, "the boot completed");
    assert.ok(!b.log.includes("createAdmin"), "no admin");
    assert.ok(!b.log.includes("createApi"), "no API");
    assert.ok(!b.log.some((l) => l.startsWith("exit")));

    const rows = await kit.rows();
    const byTag = Object.fromEntries(rows.map((r) => [r.publicId.slice(4, 5), r]));
    assert.deepEqual([byTag.A.status, byTag.A.errorCode, byTag.A.payload], ["cancelled", "api_disabled", null]);
    assert.deepEqual([byTag.B.status, byTag.B.errorCode], ["cancelled", "api_disabled"]);
    assert.deepEqual([byTag.C.status, byTag.C.errorCode], ["unknown", "interrupted"]);
    assert.equal(kit.messaging.isRunning(), false);
    assert.equal(kit.clock.pending(), 0, "no timer");
    assert.equal(kit.client.listenerCount("messages.update"), 0, "no listener");
    assert.equal(kit.sock.sent.length, 0);
    await assert.rejects(kit.send(), (err) => err.code === "api_disabled");
  });
});

describe("the switch (16.3, 16.4, FR-001, FR-002)", () => {
  test("off at start: nothing runs; turning it on starts the timer and the receipts listener and kicks; off cancels and clears everything", async () => {
    await boot({ kit: { autoKick: true }, deps: { receipts: () => ({ handle() {} }) } });
    config.ADMIN_PANEL = true;
    await kit.start();
    assert.equal(kit.messaging.isRunning(), false);
    assert.equal(kit.clock.pending(), 0);
    assert.equal(kit.client.listenerCount("messages.update"), 0);

    await apiState.setEnabled(true);
    assert.equal(kit.messaging.isRunning(), true);
    assert.equal(kit.clock.pending(), 1, "the interval, nothing else");
    assert.equal(kit.client.listenerCount("messages.update"), 1);

    const first = await kit.send({ fields: { text: "goes out" } });
    for (let i = 0; i < 100 && kit.sock.sent.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(kit.sock.sent.length, 1, "kicked by the accept");
    assert.equal((await kit.row(first.message.publicId)).status, "sent");

    await kit.send({ fields: { text: "will be cancelled" } });
    const second = (await kit.rows()).find((r) => r.status === "queued");
    await apiState.setEnabled(false); // resolves once the listeners are done
    const cancelled = await kit.row(second.publicId);
    assert.deepEqual([cancelled.status, cancelled.errorCode, cancelled.payload], ["cancelled", "api_disabled", null]);
    assert.equal(kit.messaging.isRunning(), false);
    assert.equal(kit.clock.pending(), 0);
    assert.equal(kit.client.listenerCount("messages.update"), 0);
    await assert.rejects(kit.send(), (err) => err.code === "api_disabled");
  });

  test("disabling reports the number of cancelled rows to whoever asks (concurrent calls share one run)", async () => {
    await boot();
    config.ADMIN_PANEL = true;
    await apiState.setEnabled(true);
    await kit.start();
    await kit.send({ fields: { text: "1" } });
    await kit.send({ fields: { text: "2" } });
    await kit.send({ fields: { text: "3" } });
    const [fromSwitch, direct] = await Promise.all([apiState.setEnabled(false), kit.messaging.disable()]);
    assert.equal(fromSwitch.changed, true);
    assert.equal(direct.cancelled, 3);
    assert.equal((await kit.messaging.disable()).cancelled, 0, "idempotent");
  });

  test("ADMIN_PANEL=false forces the engine off whatever the stored switch says", async () => {
    await boot();
    config.ADMIN_PANEL = true;
    await apiState.setEnabled(true);
    config.ADMIN_PANEL = false; // the next boot has no panel: the row still says enabled
    await kit.db.ApiMessage.create(queuedRow());
    await kit.start();
    assert.equal(apiState.get().enabled, true);
    assert.equal(kit.messaging.isRunning(), false);
    const [row] = await kit.rows();
    assert.deepEqual([row.status, row.errorCode], ["cancelled", "api_disabled"]);
  });
});

describe("restore, restart and registry failure (16.4, 16.5)", () => {
  test("a restore in progress stops the tick; the queue resumes by itself afterwards", async () => {
    await boot();
    config.ADMIN_PANEL = true;
    await apiState.setEnabled(true);
    await kit.start();
    await kit.send();
    await maintenanceMode.enter("restore");
    await kit.tick(5 * SEC);
    assert.equal(kit.sock.sent.length, 0);
    maintenanceMode.leave();
    await kit.tick(3 * SEC);
    assert.equal(kit.sock.sent.length, 1);
  });

  test("the in-process restart needs nothing: the socket is read at send time and recovery is not re-run", async () => {
    await boot();
    config.ADMIN_PANEL = true;
    await apiState.setEnabled(true);
    await kit.start();
    await kit.send({ fields: { text: "before" } });
    await kit.tick(SEC);
    assert.equal(kit.sock.sent.length, 1);

    // restart: the client gets a new socket (and was briefly not ready)
    const next = fakes.fakeSocket({ botUser: { id: `${kit.OWN_NUMBER}:9@s.whatsapp.net`, lid: "555:9@lid", name: "Bot" } });
    kit.client.setReady(false);
    kit.client.getSocket = () => next;
    kit.client.setReady(true);
    await kit.send({ fields: { text: "after" } });
    await kit.tick(3 * SEC);
    assert.equal(next.sent.length, 1);
    assert.equal(next.sent[0].content.text, "after");
    assert.equal(kit.sock.sent.length, 1, "the old socket is never used again");
  });

  test("a format registry that fails to load leaves the engine not running: queued rows are neither sent nor lost", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-lifecycle-formats-"));
    fs.writeFileSync(path.join(dir, "text.js"), "module.exports = { name: 'text', order: 10 };\n"); // no build()
    try {
      const formats = require("../lib/messaging/formats").createRegistry({ dir });
      await boot({ deps: { formats } });
      config.ADMIN_PANEL = true;
      await apiState.setEnabled(true);
      await kit.db.ApiMessage.create(queuedRow());

      await assert.rejects(kit.start(), (err) => err.name === "FormatRegistryError" && /text\.js/.test(err.message));
      assert.equal(kit.messaging.isRunning(), false);
      assert.equal(kit.clock.pending(), 0);
      for (let i = 0; i < 5; i += 1) await kit.tick(3 * SEC);
      const [row] = await kit.rows();
      assert.equal(row.status, "queued", "neither sent nor lost");
      assert.equal(kit.sock.sent.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failing messaging start does not stop the boot", async () => {
    await boot();
    const failing = { start: async () => { throw new Error("registry exploded"); }, stop() {} };
    const b = miniBoot({ panel: false, engines: { messaging: failing } });
    const result = await b.run();
    assert.ok(result);
    assert.ok(!b.log.some((l) => l.startsWith("exit")));
  });
});
