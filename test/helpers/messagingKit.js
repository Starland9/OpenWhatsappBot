"use strict";
/**
 * Engine kit of feature 004 (E-OUT): a real messaging facade (lib/messaging/index.js#createMessaging) over the
 * in-memory database, a fake clock, a fake socket and client, a private send gate, a fake switch (the real
 * apiState reads ADMIN_PANEL, which setupEnv turns off), fake alerts and a temporary data root. Used by
 * test/messaging-submit, messaging-outbox, messaging-never-command and api-lifecycle.
 *
 *   const kit = await createEngineKit({ config, sockOptions, enabled, realTime, clear, sharedClock, models, deps })
 *   kit.messaging / kit.db / kit.sock / kit.client / kit.clock / kit.gate / kit.config / kit.alerts (recorded raise calls)
 *   kit.key(over)                  an ApiKey row (live, rights/policy irrelevant to the engine)
 *   kit.request(over)              a `submit` request (text to 237690000001 by the first key, policy anyone)
 *   kit.send(over)                 await messaging.submit(kit.request(over))
 *   kit.start()                    await messaging.start(client) (recovery, gate seed, enable when the switch is on)
 *   kit.tick(ms)                   advance the fake clock by `ms`, then one engine tick at the new time
 *   kit.run(ms, step)              tick every `step` ms for `ms` ms
 *   kit.row(publicId) / kit.rows() fresh ApiMessage rows (model instances)
 *   kit.check()                    assertMessageInvariants on every row
 *   kit.setEnabled(bool)           flip the fake switch and notify the listeners like apiState does
 *   kit.banned                     the Set of disabled chats the engine reads
 *   kit.close()                    stop the engine, restore the clock, remove the temporary root
 *
 * `realTime: true` uses Date.now and real timers (the pipeline's `sentIds.has` reads the real clock).
 * `realConfig: true` uses the real config module instead of a plain object (a test changes it through the settings store).
 * `autoKick: true` lets an accept run a pass at once (the default is off: every pass is an explicit `tick`, so a test
 * decides which rows a pass sees). Rows inserted straight into the table are announced with
 * `kit.messaging.outbox.reseed()`.
 * `clear: false` keeps the tables (a second engine on the same database: the crash tests); `sharedClock` is a
 * createClock() instance several engines share (never restored by `close()`); `models` replaces the models the
 * facade is given (a wrapper that fails or holds a statement); `deps` goes straight to createMessaging.
 * The caller calls fakes.setupEnv() before requiring this file's consumers (the bot modules are required lazily).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fakes = require("./fakes");
const { createClock } = require("./fakeClock");
const { assertMessageInvariants } = require("./apiInvariants");

const T0 = Date.UTC(2026, 2, 10, 8, 0, 0);
const OWN_NUMBER = "237690000099";
const TABLES = ["ApiMessageResponse", "ApiMessage", "ApiKey", "KnownChat", "BannedChat", "AlertOutbox", "AlertState"];

/** Empty the tables the engine touches (the database module is shared by the whole test file) */
async function clearTables(db) {
  for (const name of TABLES) if (db[name]) await db[name].destroy({ where: {} });
}

async function createEngineKit(options = {}) {
  const db = await fakes.syncDb();
  if (options.clear !== false) await clearTables(db);
  const { createMessaging } = require("../../lib/messaging");
  const { createSendGate } = require("../../lib/utils/sendGate");
  const { createStage } = require("../../lib/messaging/stage");
  const { createSecretBox } = require("../../lib/utils/secretBox");
  const recipients = require("../../lib/messaging/recipients");
  const sentIds = require("../../lib/messaging/sentIds");
  recipients._reset();
  sentIds._reset();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-engine-"));
  const dataDir = path.join(tmp, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const clock = options.sharedClock || createClock(T0);
  const realTime = options.realTime === true;
  const now = realTime ? Date.now : () => clock.now();
  const timers = realTime ? undefined : clock.timers;

  // `realConfig: true` hands the engine the real config module (the settings store drives it: capture-sites.test.js)
  const config = options.realConfig ? require("../../config") : {
    ADMIN_PANEL: true,
    API_QUEUE_MAX: 500,
    API_QUEUE_EXPIRY_MIN: 10,
    API_MAX_PENDING: 100,
    API_REPLY_WINDOW_DAYS: 7,
    API_RETENTION_DAYS: 30,
    SEND_MIN_SPACING_MS: 2000,
    MAX_UPLOAD: 230,
    PREFIX: ".",
    ...options.config,
  };

  const sock = options.sock || fakes.fakeSocket({ botUser: { id: `${OWN_NUMBER}:3@s.whatsapp.net`, lid: "555:3@lid", name: "Bot" }, ...options.sockOptions });
  const client = options.client || fakes.fakeClient(sock);

  // the sends with their engine-clock time (the fake socket records none)
  const times = [];
  const rawSend = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    times.push(now());
    return rawSend(...args);
  };
  const rawRelay = sock.relayMessage.bind(sock);
  sock.relayMessage = async (...args) => {
    times.push(now());
    return rawRelay(...args);
  };

  const gate = options.gate || createSendGate({ clock: now, random: options.random || (() => 0), config });

  // the fake switch: apiState.isEnabled() and onChange()
  let enabled = options.enabled !== false;
  const listeners = [];
  const apiState = {
    isEnabled: () => enabled,
    onChange(fn) {
      listeners.push(fn);
      return () => {
        const at = listeners.indexOf(fn);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
  };
  const alerts = { calls: [], raise: async (type, payload) => {
    alerts.calls.push({ type, payload });
    return { queued: true };
  } };
  const banned = new Set();
  let idSeq = 0;

  const messaging = createMessaging({
    models: options.models || db,
    clock: now,
    random: options.random || (() => 0),
    timers,
    config,
    apiState,
    gate,
    alerts,
    stage: createStage({ rootDir: tmp, dataDir }),
    secretBox: createSecretBox({ dir: dataDir }),
    bannedChats: () => banned,
    autoKick: options.autoKick === true,
    newMessageId: (userId) => `3EB0${String(++idSeq).padStart(20, "0")}`,
    dataDir,
    rootDir: tmp,
    ...options.deps,
  });

  let keySeq = 0;
  const keys = [];
  async function key(over = {}) {
    const n = ++keySeq;
    const name = over.name || `Engine key ${n}`;
    const row = await db.ApiKey.create({
      name,
      nameKey: over.revokedAt ? null : name.toLowerCase(),
      lookupId: n.toString(16).padStart(16, "0"),
      secretHash: n.toString(16).padStart(64, "0"),
      last4: "abcd",
      ...over,
    });
    keys.push(row);
    return row;
  }

  function request(over = {}) {
    const apiKeyId = over.apiKeyId !== undefined ? over.apiKeyId : keys.length ? keys[0].id : 1;
    return {
      source: "api",
      apiKeyId,
      requestId: null,
      format: "text",
      to: "237690000001",
      quote: null,
      fields: { text: "hello" },
      media: null,
      policy: { mode: "anyone", entries: [] },
      limits: { maxPending: 100 },
      idempotency: null,
      now: now(),
      ...over,
    };
  }

  const send = (over) => messaging.submit(request(over));
  const start = () => messaging.start(client);
  const rows = () => db.ApiMessage.findAll({ order: [["id", "ASC"]] });
  const row = (publicId) => db.ApiMessage.findOne({ where: { publicId } });

  async function tick(ms = 0) {
    if (ms) await clock.advance(ms);
    await messaging.tick(now());
  }

  async function run(total, step = 250) {
    for (let elapsed = 0; elapsed < total; elapsed += step) await tick(step);
  }

  async function check(opts) {
    for (const r of await rows()) assertMessageInvariants(r, opts);
  }

  function setEnabled(value) {
    const previous = { enabled };
    enabled = value === true;
    for (const fn of listeners.slice()) fn({ enabled, plainHttpFrom: [], previous });
  }

  async function close() {
    try {
      await messaging.stop();
    } catch {
      // already stopped
    }
    if (!options.sharedClock) clock.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return {
    db,
    messaging,
    sock,
    client,
    clock,
    gate,
    config,
    alerts,
    banned,
    tmp,
    dataDir,
    times,
    listeners,
    apiState,
    now,
    key,
    request,
    send,
    start,
    rows,
    row,
    tick,
    run,
    check,
    setEnabled,
    close,
    stage: createStage({ rootDir: tmp, dataDir }),
    T0,
    OWN_NUMBER,
  };
}

module.exports = { createEngineKit, clearTables, T0, OWN_NUMBER };
