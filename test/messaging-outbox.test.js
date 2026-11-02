"use strict";
/**
 * The outbox of the messaging engine (feature 004, contracts/runtime.md 4.1 to 4.9 and 11). Part 1: the queue core
 * (accept to sent, pacing SC-005, the shared gate, the two crash windows SC-006, expiry, the pick-step guards, the
 * verification, settling). Part 2: waiters, cancellation, pause, lifecycle. The media cases close the file; the
 * receipts are in messaging-receipts.test.js, the replies in messaging-replies.test.js.
 *
 * A real facade over the in-memory database, a fake clock, a fake socket, a private gate (test/helpers/
 * messagingKit.js); `assertMessageInvariants` runs after every scenario (afterEach).
 */

const { test, describe, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const { createEngineKit, samples } = require("./helpers/messagingKit");
const { createBroadcaster } = require("../lib/utils/broadcaster");
const { createSendGate } = require("../lib/utils/sendGate");
const maintenanceMode = require("../lib/utils/maintenanceMode");
const sentIds = require("../lib/messaging/sentIds");
const { MessagingError } = require("../lib/messaging/errors");

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const PN = "237690000001@s.whatsapp.net";
const PN2 = "237690000002@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";

let kit;
let key;
let opened = [];

/** Build a kit and start the engine (the switch is on unless told otherwise) */
async function boot(options = {}) {
  kit = await createEngineKit(options);
  opened.push(kit);
  key = await kit.key();
  if (options.start !== false) await kit.start();
  return kit;
}

beforeEach(() => {
  opened = [];
  maintenanceMode._reset();
});

afterEach(async () => {
  for (const k of opened) {
    await k.check({ pendingMedia: true });
    await k.close();
  }
  mock.restoreAll();
  maintenanceMode._reset();
});

/** The error a socket raises when the connection is gone / the call times out / WhatsApp refuses */
const timeoutError = () => Object.assign(new Error("send timed out"), { code: "ETIMEDOUT" });
const closedError = () => Object.assign(new Error("Connection Closed"), { output: { statusCode: 428 } });
const refusedError = () => Object.assign(new Error("bad request"), { output: { statusCode: 400 } });

/** A promise whose resolution the test decides */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Wait (real time) until `fn()` is truthy: the engine's hung work runs on real promises */
async function until(fn, label = "condition") {
  for (let i = 0; i < 200; i += 1) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** The models wrapped so that `ApiMessage.update` can be intercepted: hook(values, options, original) */
function interceptUpdate(db, hook) {
  const target = db.ApiMessage;
  const wrapped = new Proxy(target, {
    get(t, prop) {
      if (prop === "update") return (values, opts) => hook(values, opts, () => t.update(values, opts));
      const value = t[prop];
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
  return { ...db, ApiMessage: wrapped };
}

const rowsByStatus = async (status) => (await kit.rows()).filter((r) => r.status === status);

// =====================================================================================================================
// Part 1: the queue core
// =====================================================================================================================

describe("accept to sent: one send per row, at-most-once ids (4.3, 4.4)", () => {
  test("a queued text goes out verbatim with the pre-generated id as messageId and ends sent with its content erased", async () => {
    await boot();
    const { message } = await kit.send({ fields: { text: "Hello Awa" } });
    await kit.tick();
    assert.equal(kit.sock.sent.length, 1);
    const sent = kit.sock.sent[0];
    assert.equal(sent.jid, PN);
    assert.equal(sent.content.text, "Hello Awa");
    assert.equal(sent.content.linkPreview, null, "Baileys never fetches a link of an API text (X16)");

    const row = await kit.row(message.publicId);
    assert.equal(row.status, "sent");
    assert.match(row.waId, /^3EB0\w{16,}$/);
    assert.equal(sent.options.messageId, row.waId, "the id WhatsApp sees is the id written at the claim");
    assert.equal(sent.key.id, row.waId);
    assert.equal(row.payload, null, "the content is erased by the settle UPDATE (RT-40)");
    assert.equal(row.repliesUntil, null);
    assert.equal(row.sendingAt.getTime(), kit.now());
    assert.equal(row.sentAt.getTime(), kit.now());
    assert.equal(row.endedAt, null);
    assert.ok(sentIds.has(row.waId, kit.now()), "remembered before the call so an echo is ignored (RT-51)");
    assert.equal(kit.gate.lastSendAt(), kit.now(), "reserved at the claim");
  });

  test("a group target is sent to the group id and stops at sent", async () => {
    await boot();
    const { message } = await kit.send({ to: GROUP });
    await kit.tick();
    assert.equal(kit.sock.sent[0].jid, GROUP);
    assert.equal((await kit.row(message.publicId)).status, "sent");
  });

  test("a tick sends at most one message; the next waits for the gate", async () => {
    await boot();
    await kit.send({ fields: { text: "one" } });
    await kit.send({ fields: { text: "two" } });
    await kit.tick();
    assert.equal(kit.sock.sent.length, 1);
    await kit.tick(1000);
    assert.equal(kit.sock.sent.length, 1, "1 s after: still inside the 2 s floor");
    await kit.tick(1000);
    assert.equal(kit.sock.sent.length, 2);
    assert.deepEqual(kit.sock.sent.map((s) => s.content.text), ["one", "two"], "oldest first");
  });

  test("the oldest accepted goes first whatever the order of the ids", async () => {
    await boot();
    const late = await kit.send({ fields: { text: "late" }, now: kit.T0 + 5000 });
    const early = await kit.send({ fields: { text: "early" }, now: kit.T0 });
    await kit.tick();
    assert.equal(kit.sock.sent[0].content.text, "early");
    assert.equal((await kit.row(late.message.publicId)).status, "queued");
    assert.ok(early);
  });

  test("a message accepted before start() waits and is sent after it (requests between dbReady and the engine start)", async () => {
    await boot({ start: false });
    await kit.send();
    await kit.start();
    await kit.tick();
    assert.equal(kit.sock.sent.length, 1);
  });
});

describe("SC-005: pacing", () => {
  test("100 accepted, ticks every 250 ms for 5 minutes: every gap is at least 2000 and at most 2400 plus the tick", async () => {
    await boot({ random: Math.random });
    for (let i = 0; i < 100; i += 1) await kit.send({ fields: { text: `m${i}` } });
    await kit.run(5 * MIN, 250);
    assert.equal(kit.times.length, 100, "all 100 left inside the 5 minutes");
    for (let i = 1; i < kit.times.length; i += 1) {
      const gap = kit.times[i] - kit.times[i - 1];
      assert.ok(gap >= 2000, `gap ${gap} at ${i} is below the 2 s floor`);
      assert.ok(gap <= 2400 + 250, `gap ${gap} at ${i} is above 2400 plus a tick`);
    }
    assert.equal((await rowsByStatus("sent")).length, 100);
  });

  test("the spacing setting is read at call time and only ever raises the floor", async () => {
    await boot();
    await kit.send({ fields: { text: "a" } });
    await kit.send({ fields: { text: "b" } });
    await kit.tick();
    kit.config.SEND_MIN_SPACING_MS = 10000;
    await kit.tick(9000);
    assert.equal(kit.sock.sent.length, 1);
    await kit.tick(1000);
    assert.equal(kit.sock.sent.length, 2);
  });

  test("M1: a slow recipient check does not shorten the gap: the gate is reserved at the real send time, not at the pass start", async () => {
    let slow = false;
    await boot({
      sockOptions: {
        onWhatsApp: (jid) => {
          if (slow) kit.clock.set(kit.now() + 1500); // the lookup takes 1.5 s
          return [{ jid, exists: true }];
        },
      },
    });
    const at = async (ms) => {
      kit.clock.set(kit.T0 + ms); // set, not advance: only the explicit passes run
      await kit.messaging.tick(kit.now());
    };
    await kit.send({ to: "237690000001", fields: { text: "one" } });
    await kit.send({ to: "237690000002", fields: { text: "two" } });
    await kit.send({ to: "237690000003", fields: { text: "three" } });
    await at(0);
    assert.deepEqual(kit.times, [kit.T0]);

    slow = true;
    await at(2000); // the pass starts at +2000, the lookup ends and the message leaves at +3500
    assert.deepEqual(kit.times, [kit.T0, kit.T0 + 3500]);
    assert.equal(kit.gate.lastSendAt(), kit.T0 + 3500, "reserved at the real send time");
    const second = (await kit.rows())[1];
    assert.equal(second.sendingAt.getTime(), kit.T0 + 3500, "sendingAt is the claim time");
    assert.ok(second.sentAt.getTime() >= second.sendingAt.getTime(), "sentAt never precedes sendingAt");

    slow = false;
    await at(4000); // 2000 after the pass start of the previous message, 500 after its real send
    assert.equal(kit.times.length, 2, "still inside the 2 s floor of the real send");
    await at(5400);
    assert.equal(kit.times.length, 2);
    await at(5500);
    assert.equal(kit.times.length, 3);
    for (let i = 1; i < kit.times.length; i += 1) assert.ok(kit.times[i] - kit.times[i - 1] >= 2000, `gap ${kit.times[i] - kit.times[i - 1]} at ${i}`);
  });

  test("M1: a broadcaster tick that slips in during the recipient check is not followed by an API send inside the gap", async () => {
    let hook = null;
    const gate = createSendGate({ clock: () => kit.clock.now(), random: () => 0, config: { SEND_MIN_SPACING_MS: 2000 } });
    await boot({
      gate,
      sockOptions: {
        onWhatsApp: async (jid) => {
          if (hook) await hook();
          return [{ jid, exists: true }];
        },
      },
    });
    const engine = createBroadcaster({
      rootDir: kit.tmp,
      config: { TIMEZONE: "Europe/Paris", MAX_UPLOAD: 1, BROADCAST_DELAY_MS: 5000 },
      clock: () => kit.clock.now(),
      random: () => 0,
      timers: kit.clock.timers,
      settingsStore: { onChange: () => () => {} },
      gate,
    });
    engine.start(kit.client);
    try {
      const jid = "237600000200@s.whatsapp.net";
      await kit.db.KnownChat.create({ jid, kind: "private", pnJid: jid, name: "chat", firstSeenAt: new Date(kit.T0), lastSeenAt: new Date(kit.T0) });
      await kit.send({ to: "237690000001", fields: { text: "one" } });
      await kit.send({ to: "237690000002", fields: { text: "two" } });
      kit.clock.set(kit.T0);
      await kit.messaging.tick(kit.now());
      assert.deepEqual(kit.times, [kit.T0]);

      hook = async () => {
        hook = null;
        kit.clock.set(kit.T0 + 3500); // the lookup is slow; a broadcast falls due and leaves meanwhile
        await engine.createOnce({ text: "broadcast", targets: [jid], spacingMs: 60000 }, { now: kit.clock.now() });
        const result = await engine.tick(kit.clock.now());
        assert.equal(result.sent, 1, "the broadcaster found the gate free");
      };
      kit.clock.set(kit.T0 + 2000);
      await kit.messaging.tick(kit.now());
      assert.deepEqual(kit.times, [kit.T0, kit.T0 + 3500], "only the broadcast left: the API message waits");
      const queued = await kit.rows();
      assert.deepEqual(queued.map((r) => r.status), ["sent", "queued"]);
      assert.equal(queued[1].waId, null, "the row is back in the queue untouched (no claim)");
      assert.equal(kit.gate.lastSendAt(), kit.T0 + 3500, "the broadcast's reservation was not overwritten");

      kit.clock.set(kit.T0 + 5500);
      await kit.messaging.tick(kit.now());
      assert.deepEqual(kit.times, [kit.T0, kit.T0 + 3500, kit.T0 + 5500]);
    } finally {
      engine.stop();
      for (const name of ["BroadcastTarget", "BroadcastRun", "Broadcast"]) await kit.db[name].destroy({ where: {} }); // the kit does not clear them
    }
  });

  test("a broadcast and API messages interleaved on one shared gate stay 2000 ms apart; a 60 s broadcast is not starved", async () => {
    const gate = createSendGate({ clock: () => kit.clock.now(), random: () => 0, config: { SEND_MIN_SPACING_MS: 2000 } });
    await boot({ gate });
    const engine = createBroadcaster({
      rootDir: kit.tmp,
      config: { TIMEZONE: "Europe/Paris", MAX_UPLOAD: 1, BROADCAST_DELAY_MS: 5000 },
      clock: () => kit.clock.now(),
      random: () => 0,
      timers: kit.clock.timers,
      settingsStore: { onChange: () => () => {} },
      gate,
    });
    engine.start(kit.client);
    try {
      const rows = [];
      for (let i = 0; i < 3; i += 1) {
        const jid = `${237600000100 + i}@s.whatsapp.net`;
        rows.push({ jid, kind: "private", pnJid: jid, name: `chat ${i}`, firstSeenAt: new Date(kit.T0), lastSeenAt: new Date(kit.T0) });
      }
      await kit.db.KnownChat.bulkCreate(rows);
      await engine.createOnce({ text: "broadcast", targets: rows.map((r) => r.jid), spacingMs: 60000 }, { now: kit.clock.now() });

      const broadcastAt = [];
      for (let s = 0; s <= 140; s += 1) {
        kit.clock.set(kit.T0 + s * 1000);
        // an API message every 30 s, offset so it never lands on a broadcast instant
        if (s % 30 === 15) await kit.send({ fields: { text: `api ${s}` } });
        const before = kit.times.length;
        const result = await engine.tick(kit.clock.now());
        if (result.sent) broadcastAt.push(kit.clock.now());
        await kit.messaging.tick(kit.clock.now());
        assert.ok(kit.times.length - before <= 2);
      }
      assert.deepEqual(broadcastAt, [kit.T0, kit.T0 + 60000, kit.T0 + 120000], "one broadcast send every 60 s despite the API traffic");
      assert.ok((await rowsByStatus("sent")).length >= 4, "the API messages went out too");
      for (let i = 1; i < kit.times.length; i += 1) {
        assert.ok(kit.times[i] - kit.times[i - 1] >= 2000, `gap ${kit.times[i] - kit.times[i - 1]} at ${i}`);
      }
    } finally {
      engine.stop();
    }
  });
});

describe("SC-006: the two crash windows, a message is never sent twice", () => {
  test("after the claim: engine A's socket hangs, engine B recovers and ticks: unknown / interrupted, one send, same id", async () => {
    await boot();
    const attempts = [];
    const never = new Promise(() => {});
    kit.sock.sendMessage = async (jid, content, options) => {
      attempts.push({ jid, id: options.messageId });
      return never;
    };
    const { message } = await kit.send();
    const hung = kit.messaging.tick(kit.now()); // never settles: the process "crashes" here
    await until(async () => (await kit.row(message.publicId)).status === "sending", "the claim");
    const claimed = await kit.row(message.publicId);
    assert.equal(claimed.status, "sending");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].id, claimed.waId);

    const b = await createEngineKit({ clear: false, sharedClock: kit.clock });
    opened.push(b);
    await b.start(); // recover()
    const recovered = await b.row(message.publicId);
    assert.equal(recovered.status, "unknown");
    assert.equal(recovered.errorCode, "interrupted");
    assert.equal(recovered.waId, claimed.waId, "the id WhatsApp may have seen is kept");
    assert.equal(recovered.payload, null);
    assert.ok(recovered.endedAt);

    await b.tick(5 * SEC);
    await b.tick(5 * SEC);
    assert.equal(attempts.length, 1, "engine A's socket saw exactly one send");
    assert.equal(b.sock.sent.length, 0, "engine B never resent it");
    assert.equal((await b.row(message.publicId)).status, "unknown");
    void hung;
  });

  test("before the claim: engine A dies on the claim UPDATE, nothing left the socket, engine B sends it once", async () => {
    const base = await createEngineKit();
    const db = base.db;
    await base.close();
    const hold = deferred();
    const a = await createEngineKit({
      clear: false,
      models: interceptUpdate(db, (values, opts, original) => (values.status === "sending" ? hold.promise : original())),
    });
    opened.push(a);
    const owner = await a.key();
    await a.start();
    const { message } = await a.send({ apiKeyId: owner.id });
    void a.messaging.tick(a.now()); // dies on the claim: the id is minted and remembered, nothing is sent
    await until(() => sentIds.size() > 0, "the id was minted");
    assert.equal(a.sock.sent.length, 0);
    assert.equal((await a.row(message.publicId)).status, "queued");

    const b = await createEngineKit({ clear: false, sharedClock: a.clock });
    opened.push(b);
    await b.start();
    assert.equal((await b.row(message.publicId)).status, "queued", "a queued row resumes");
    await b.tick(SEC);
    assert.equal(b.sock.sent.length, 1);
    assert.equal(a.sock.sent.length, 0, "A never sent");
    assert.equal((await b.row(message.publicId)).status, "sent");
    hold.resolve([0]);
  });
});

describe("expiry (4.3 step 2, 4.9)", () => {
  test("a message not sent 10 minutes after acceptance expires, connected or not, and is never sent later", async () => {
    await boot();
    kit.client.setReady(false); // disconnected
    const { message } = await kit.send();
    await kit.tick(9 * MIN);
    assert.equal((await kit.row(message.publicId)).status, "queued");
    await kit.tick(MIN);
    const expired = await kit.row(message.publicId);
    assert.equal(expired.status, "expired");
    assert.equal(expired.errorCode, null, "expired carries no code");
    assert.equal(expired.payload, null);
    assert.equal(expired.endedAt.getTime(), kit.now());
    assert.equal(kit.sock.sent.length, 0);

    kit.client.setReady(true);
    await kit.tick(SEC);
    await kit.tick(3 * SEC);
    assert.equal(kit.sock.sent.length, 0, "an expired message is never sent later");
    assert.equal((await kit.row(message.publicId)).status, "expired");
  });

  test("a disconnected client only expires rows: nothing is claimed, a reconnection resumes inside the window", async () => {
    await boot();
    kit.client.setReady(false);
    const { message } = await kit.send();
    await kit.tick(2 * MIN);
    assert.equal(kit.sock.sent.length, 0);
    assert.equal((await kit.row(message.publicId)).status, "queued");
    kit.client.setReady(true);
    await kit.tick(SEC);
    assert.equal(kit.sock.sent.length, 1);
  });

  test("the expiry is the snapshot of acceptance, not the current setting", async () => {
    await boot({ config: { API_QUEUE_EXPIRY_MIN: 1 } });
    const { message } = await kit.send();
    kit.config.API_QUEUE_EXPIRY_MIN = 60;
    kit.client.setReady(false);
    await kit.tick(MIN);
    assert.equal((await kit.row(message.publicId)).status, "expired");
  });

  test("an expired row's staged directory goes with it", async () => {
    await boot();
    const publicId = `msg_${"E".repeat(22)}`;
    const source = path.join(kit.tmp, "incoming");
    fs.writeFileSync(source, "pixels");
    const { mediaPath } = await kit.stage.adopt(publicId, source, { mode: "move" });
    await kit.db.ApiMessage.create({
      publicId,
      apiKeyId: key.id,
      recipient: PN,
      format: "image",
      status: "queued",
      acceptedAt: new Date(kit.now()),
      expiresAt: new Date(kit.now() + MIN),
      payload: { v: 1, input: {}, media: { source: "upload", mime: "image/png", ext: "png", size: 6, fileName: null }, quote: null },
      mediaPath,
    });
    await kit.messaging.outbox.reseed();
    kit.client.setReady(false);
    await kit.tick(MIN);
    const row = await kit.row(publicId);
    assert.equal(row.status, "expired");
    assert.equal(row.mediaPath, null);
    assert.equal(fs.existsSync(path.join(kit.stage.rootDir(), publicId)), false);
  });
});

describe("the pick step: key guard, disabled chat, own number, unreadable payload (4.3 step 4)", () => {
  test("a revoked key's queued message is cancelled key_revoked at the pick, not sent", async () => {
    await boot();
    const { message } = await kit.send();
    await kit.db.ApiKey.update({ revokedAt: new Date(kit.now()), nameKey: null }, { where: { id: key.id } });
    await kit.tick();
    const row = await kit.row(message.publicId);
    assert.deepEqual([row.status, row.errorCode, row.payload], ["cancelled", "key_revoked", null]);
    assert.equal(kit.sock.sent.length, 0);
    assert.equal(kit.gate.lastSendAt(), null, "nothing was reserved");
  });

  test("a key expired by date gives key_expired; a missing key row gives key_revoked; the panel has no key guard", async () => {
    await boot();
    const dated = await kit.key({ expiresAt: new Date(kit.now() + 5 * MIN) });
    const a = await kit.send({ apiKeyId: dated.id });
    const b = await kit.send({ apiKeyId: 9999 });
    const c = await kit.send({ source: "panel", apiKeyId: null, policy: null, limits: null, fields: { text: "panel" } });
    kit.clock.set(kit.T0 + 6 * MIN); // set, not advance: the interval must not run while the key is still valid
    await kit.tick();
    assert.deepEqual([(await kit.row(a.message.publicId)).status, (await kit.row(a.message.publicId)).errorCode], ["cancelled", "key_expired"]);
    assert.deepEqual([(await kit.row(b.message.publicId)).status, (await kit.row(b.message.publicId)).errorCode], ["cancelled", "key_revoked"]);
    assert.equal((await kit.row(c.message.publicId)).status, "sent");
    assert.equal(kit.sock.sent.length, 1);
  });

  test("the key is read from the table at every send: a revoke between two ticks applies to the very next message", async () => {
    await boot();
    await kit.send({ fields: { text: "one" } });
    await kit.send({ fields: { text: "two" } });
    await kit.tick();
    await kit.db.ApiKey.update({ revokedAt: new Date(kit.now()), nameKey: null }, { where: { id: key.id } });
    await kit.tick(3 * SEC);
    assert.equal(kit.sock.sent.length, 1);
    assert.equal((await rowsByStatus("cancelled")).length, 1);
  });

  describe("L7: a key narrowed after acceptance does not send what it may no longer send", () => {
    const narrow = (changes) => kit.db.ApiKey.update(changes, { where: { id: key.id } });
    const cancelledAs = async (publicId) => {
      const row = await kit.row(publicId);
      return [row.status, row.errorCode, row.payload, row.waId];
    };

    test("the send right of the format was removed: cancelled key_revoked, nothing sent, nothing reserved", async () => {
      await boot();
      const { message } = await kit.send();
      await narrow({ rights: ["messages.send.image"] });
      await kit.tick();
      assert.deepEqual(await cancelledAs(message.publicId), ["cancelled", "key_revoked", null, null]);
      assert.equal(kit.sock.sent.length, 0);
      assert.equal(kit.gate.lastSendAt(), null);
    });

    test("a key that still has the right sends; the right of another format does not count", async () => {
      await boot();
      const { message } = await kit.send();
      await narrow({ rights: ["messages.send.text"] });
      await kit.tick();
      assert.equal((await kit.row(message.publicId)).status, "sent");
      const more = await kit.send({ fields: { text: "again" } });
      await narrow({ rights: ["messages.send.poll", "media.url"] });
      await kit.tick(3 * SEC);
      assert.deepEqual((await cancelledAs(more.message.publicId)).slice(0, 2), ["cancelled", "key_revoked"]);
    });

    test("media.url was removed: a message whose file came from a URL (or a link preview) is cancelled, an uploaded one is not", async () => {
      await boot();
      const fromUrl = await kit.send({ format: "image", fields: {}, media: { ...kit.file(await samples.png()), source: "url" } });
      const uploaded = await kit.send({ format: "image", to: "237690000002", fields: {}, media: kit.file(await samples.png()) });
      const preview = await kit.send({ to: "237690000003", fields: { text: "see https://a.example/x", linkPreview: true } });
      const plain = await kit.send({ to: "237690000004", fields: { text: "plain" } });
      await narrow({ rights: ["messages.send.text", "messages.send.image"] });
      await kit.run(10 * SEC, SEC);
      assert.deepEqual((await cancelledAs(fromUrl.message.publicId)).slice(0, 2), ["cancelled", "key_revoked"]);
      assert.deepEqual((await cancelledAs(preview.message.publicId)).slice(0, 2), ["cancelled", "key_revoked"]);
      assert.equal((await kit.row(uploaded.message.publicId)).status, "sent");
      assert.equal((await kit.row(plain.message.publicId)).status, "sent");
      assert.equal(fs.existsSync(path.join(kit.stage.rootDir(), fromUrl.message.publicId)), false, "the staged file of a cancelled row goes");
    });

    test("the recipient policy was narrowed: list without the recipient, or known without a known chat, cancels; a list with it does not", async () => {
      await boot();
      const a = await kit.send({ to: "237690000001", fields: { text: "a" } });
      const b = await kit.send({ to: "237690000002", fields: { text: "b" } });
      const c = await kit.send({ to: "237690000003", fields: { text: "c" } });
      await narrow({ policyMode: "list", recipients: [PN2] });
      await kit.tick();
      assert.deepEqual((await cancelledAs(a.message.publicId)).slice(0, 2), ["cancelled", "key_revoked"], "not in the list any more");
      assert.equal((await kit.row(b.message.publicId)).status, "sent", "a cancellation does not use up the pass: the next candidate went out");
      await narrow({ policyMode: "known" });
      await kit.tick(3 * SEC);
      assert.deepEqual((await cancelledAs(c.message.publicId)).slice(0, 2), ["cancelled", "key_revoked"], "no known chat for it");
      assert.equal(kit.sock.sent.length, 1);
    });

    test("the panel has no key and nothing to narrow", async () => {
      await boot();
      const { message } = await kit.send({ source: "panel", apiKeyId: null, policy: null, limits: null, fields: { text: "panel" } });
      await kit.tick();
      assert.equal((await kit.row(message.publicId)).status, "sent");
    });
  });

  test("a ban after acceptance gives failed / chat_disabled and reserves nothing", async () => {
    await boot();
    const { message } = await kit.send();
    kit.banned.add(PN);
    await kit.tick();
    const row = await kit.row(message.publicId);
    assert.deepEqual([row.status, row.errorCode, row.payload], ["failed", "chat_disabled", null]);
    assert.equal(kit.sock.sent.length, 0);
    assert.equal(kit.gate.lastSendAt(), null);
  });

  test("the bot's own number at the pick gives failed / send_failed", async () => {
    await boot({ start: false });
    const { message } = await kit.send({ to: kit.OWN_NUMBER }); // no identity seen yet: accepted (skipped, not failed)
    await kit.start();
    await kit.tick();
    const row = await kit.row(message.publicId);
    assert.deepEqual([row.status, row.errorCode], ["failed", "send_failed"]);
    assert.equal(kit.sock.sent.length, 0);
  });

  test("an unreadable payload, an unknown format or a missing stage gives payload_unavailable, never a text-only send", async () => {
    await boot();
    const base = { apiKeyId: key.id, recipient: PN, status: "queued", acceptedAt: new Date(kit.now()), expiresAt: new Date(kit.now() + 10 * MIN) };
    const bad = await kit.db.ApiMessage.create({ ...base, publicId: `msg_${"A".repeat(22)}`, format: "text", payload: null });
    const wrongVersion = await kit.db.ApiMessage.create({ ...base, publicId: `msg_${"B".repeat(22)}`, format: "text", payload: { v: 2, input: { text: "x" } } });
    const unknownFormat = await kit.db.ApiMessage.create({ ...base, publicId: `msg_${"C".repeat(22)}`, format: "hologram", payload: { v: 1, input: {}, media: null, quote: null } });
    const noStage = await kit.db.ApiMessage.create({
      ...base,
      publicId: `msg_${"D".repeat(22)}`,
      format: "image",
      payload: { v: 1, input: { caption: "never sent as text" }, media: { source: "upload", mime: "image/png", ext: "png", size: 3, fileName: null }, quote: null },
      mediaPath: `data/api-media/msg_${"D".repeat(22)}/source`,
    });
    await kit.messaging.outbox.reseed();
    for (let i = 0; i < 4; i += 1) await kit.tick(i === 0 ? 0 : SEC);
    for (const row of [bad, wrongVersion, unknownFormat, noStage]) {
      const stored = await kit.row(row.publicId);
      assert.deepEqual([stored.status, stored.errorCode, stored.payload], ["failed", "payload_unavailable", null], row.publicId);
    }
    assert.equal(kit.sock.sent.length, 0);
    assert.equal(kit.gate.lastSendAt(), null);
  });

  test("a failure at the pick does not use up the tick: the next candidate is sent in the same pass", async () => {
    await boot();
    const first = await kit.send({ fields: { text: "banned" } });
    const second = await kit.send({ to: "237690000002", fields: { text: "fine" } });
    kit.banned.add(PN);
    await kit.tick();
    assert.equal((await kit.row(first.message.publicId)).status, "failed");
    assert.equal((await kit.row(second.message.publicId)).status, "sent");
  });
});

describe("verification before the claim (5.3, 5.4)", () => {
  test("a number not on WhatsApp fails not_on_whatsapp, reserves nothing and ends the pass (no bulk probing)", async () => {
    await boot({ sockOptions: { onWhatsApp: () => [{ jid: PN, exists: false }] } });
    const a = await kit.send();
    const b = await kit.send({ fields: { text: "b" } });
    await kit.tick();
    const row = await kit.row(a.message.publicId);
    assert.deepEqual([row.status, row.errorCode, row.payload], ["failed", "not_on_whatsapp", null]);
    assert.equal(kit.gate.lastSendAt(), null, "no gate reservation");
    assert.equal((await kit.row(b.message.publicId)).status, "queued", "one lookup per pass");
    assert.equal(kit.sock.sent.length, 0);
  });

  test("a chat the bot knows is not looked up; a group is not looked up", async () => {
    let lookups = 0;
    await boot({ sockOptions: { onWhatsApp: () => { lookups += 1; return [{ jid: PN, exists: true }]; } } });
    await kit.db.KnownChat.create({ jid: PN, kind: "private", pnJid: PN, name: "Awa", firstSeenAt: new Date(kit.now()), lastSeenAt: new Date(kit.now()) });
    await kit.send();
    await kit.send({ to: GROUP });
    await kit.tick();
    await kit.tick(3 * SEC);
    assert.equal(kit.sock.sent.length, 2);
    assert.equal(lookups, 0);
  });

  test("an unknown number is looked up once; WhatsApp's own form of the number is the destination", async () => {
    let lookups = 0;
    await boot({ sockOptions: { onWhatsApp: (jid) => { lookups += 1; return [{ jid: "237690000077@s.whatsapp.net", exists: true }]; } } });
    const { message } = await kit.send();
    await kit.tick();
    assert.equal(lookups, 1);
    assert.equal(kit.sock.sent[0].jid, "237690000077@s.whatsapp.net");
    assert.equal((await kit.row(message.publicId)).recipient, PN, "the row keeps the requested form");
  });

  test("a group the bot is not in fails not_in_group; an announce-only group the bot does not administer fails group_announce_only", async () => {
    await boot({ sockOptions: { groupMetadataError: Object.assign(new Error("forbidden"), { output: { statusCode: 403 } }) } });
    const a = await kit.send({ to: GROUP });
    await kit.tick();
    assert.deepEqual([(await kit.row(a.message.publicId)).status, (await kit.row(a.message.publicId)).errorCode], ["failed", "not_in_group"]);
    assert.equal(kit.gate.lastSendAt(), null);

    kit.sock.groupMetadataError = null;
    const sockB = await createEngineKit({ clear: false, sharedClock: kit.clock, sockOptions: { announce: true, botAdmin: false } });
    opened.push(sockB);
    await sockB.start();
    const b = await sockB.send({ to: GROUP, apiKeyId: key.id });
    await sockB.tick();
    assert.deepEqual([(await sockB.row(b.message.publicId)).status, (await sockB.row(b.message.publicId)).errorCode], ["failed", "group_announce_only"]);
  });

  test("an announce-only group is fine when the bot is an admin", async () => {
    await boot({ sockOptions: { announce: true, botAdmin: true } });
    const { message } = await kit.send({ to: GROUP });
    await kit.tick();
    assert.equal((await kit.row(message.publicId)).status, "sent");
  });

  test("a transient verification error defers that row 15 s without blocking the queue behind it", async () => {
    let broken = true;
    await boot({
      sockOptions: {
        onWhatsApp: (jid) => {
          if (jid === PN && broken) throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
          return [{ jid, exists: true }];
        },
      },
    });
    const stuck = await kit.send({ fields: { text: "stuck" } });
    const free = await kit.send({ to: "237690000002", fields: { text: "free" } });
    await kit.tick();
    assert.equal((await kit.row(stuck.message.publicId)).status, "queued", "a transient error fails nothing");
    assert.equal(kit.sock.sent.length, 0, "the pass ends on the deferral");
    await kit.tick(SEC);
    assert.equal((await kit.row(free.message.publicId)).status, "sent", "the queue behind it moves on");
    broken = false;
    await kit.tick(5 * SEC);
    assert.equal((await kit.row(stuck.message.publicId)).status, "queued", "still deferred inside the 15 s");
    await kit.tick(11 * SEC);
    assert.equal((await kit.row(stuck.message.publicId)).status, "sent");
    assert.deepEqual(kit.sock.sent.map((s) => s.content.text), ["free", "stuck"]);
  });
});

describe("settling (4.3 step 10, 4.4)", () => {
  test("a socket timeout is unknown / timeout, never retried; the id and the erased payload are kept as T8 says", async () => {
    await boot();
    kit.sock.sendMessage = async () => {
      throw timeoutError();
    };
    const { message } = await kit.send();
    await kit.tick();
    await kit.tick(10 * SEC);
    await kit.tick(10 * SEC);
    const row = await kit.row(message.publicId);
    assert.deepEqual([row.status, row.errorCode, row.payload, row.sentAt], ["unknown", "timeout", null, null]);
    assert.ok(row.waId && row.endedAt);
  });

  test("the send timeout is driven by the clock: a socket that never answers is unknown / timeout at 30 s", async () => {
    await boot();
    kit.sock.sendMessage = () => new Promise(() => {});
    const { message } = await kit.send();
    const pass = kit.messaging.tick(kit.now());
    await until(async () => (await kit.row(message.publicId)).status === "sending", "the claim");
    await kit.clock.advance(29 * SEC);
    assert.equal((await kit.row(message.publicId)).status, "sending");
    await kit.clock.advance(SEC);
    await pass;
    assert.deepEqual([(await kit.row(message.publicId)).status, (await kit.row(message.publicId)).errorCode], ["unknown", "timeout"]);
  });

  test("connection closed is unknown / connection_closed; a refusal (4xx) is failed / send_failed", async () => {
    await boot();
    let error = closedError;
    kit.sock.sendMessage = async () => {
      throw error();
    };
    const a = await kit.send({ fields: { text: "a" } });
    await kit.tick();
    assert.deepEqual([(await kit.row(a.message.publicId)).status, (await kit.row(a.message.publicId)).errorCode], ["unknown", "connection_closed"]);
    error = refusedError;
    const b = await kit.send({ fields: { text: "b" } });
    await kit.tick(3 * SEC);
    const row = await kit.row(b.message.publicId);
    assert.deepEqual([row.status, row.errorCode, row.payload], ["failed", "send_failed", null]);
  });

  test("exactly one send per claimed row: no retry of unknown, failed or a timeout (RT-53)", async () => {
    await boot();
    let calls = 0;
    kit.sock.sendMessage = async () => {
      calls += 1;
      throw refusedError();
    };
    await kit.send();
    for (let i = 0; i < 12; i += 1) await kit.tick(SEC);
    assert.equal(calls, 1);
  });

  test("the settle UPDATE is retried once; when both attempts fail the row stays sending and is never resent", async () => {
    const base = await createEngineKit();
    const db = base.db;
    await base.close();
    let fail = 1;
    kit = await createEngineKit({
      clear: false,
      models: interceptUpdate(db, (values, opts, original) => {
        if (values.status === "sent" && fail > 0) {
          fail -= 1;
          return Promise.reject(new Error("database is locked"));
        }
        return original();
      }),
    });
    opened.push(kit);
    key = await kit.key();
    await kit.start();
    const { message } = await kit.send();
    await kit.tick();
    assert.equal((await kit.row(message.publicId)).status, "sent", "the second attempt succeeded");
    assert.equal(kit.sock.sent.length, 1);

    fail = 2;
    const second = await kit.send({ fields: { text: "two" } });
    await kit.tick(3 * SEC);
    assert.equal((await kit.row(second.message.publicId)).status, "sending", "both attempts failed: the row waits for recovery");
    assert.equal(kit.sock.sent.length, 2);
    for (let i = 0; i < 5; i += 1) await kit.tick(3 * SEC);
    assert.equal(kit.sock.sent.length, 2, "never resent");
    await kit.messaging.outbox.recover({ now: kit.now() });
    const recovered = await kit.row(second.message.publicId);
    assert.deepEqual([recovered.status, recovered.errorCode], ["unknown", "interrupted"]);
  });

  test("a build that throws fails the row as send_failed before the claim; a prepare that throws is media_conversion_failed", async () => {
    await boot();
    const formats = kit.messaging.formats;
    const text = formats.get("text");
    const realBuild = text.build;
    const realPrepare = text.prepare;
    text.build = () => {
      throw new Error("boom");
    };
    try {
      const a = await kit.send({ fields: { text: "a" } });
      await kit.tick();
      const row = await kit.row(a.message.publicId);
      assert.deepEqual([row.status, row.errorCode, row.waId, row.sendingAt], ["failed", "send_failed", null, null], "never claimed");
      assert.equal(kit.sock.sent.length, 0);
      text.build = realBuild;
      text.prepare = async () => {
        throw Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
      };
      const b = await kit.send({ fields: { text: "b" } });
      await kit.tick(SEC);
      const prepared = await kit.row(b.message.publicId);
      assert.deepEqual([prepared.status, prepared.errorCode, prepared.waId], ["failed", "media_conversion_failed", null]);
    } finally {
      text.build = realBuild;
      text.prepare = realPrepare;
    }
  });

  test("a link preview that prepare fetched reaches the content; a failing preview never fails the message", async () => {
    await boot();
    const text = kit.messaging.formats.get("text");
    const realPrepare = text.prepare;
    text.prepare = async () => ({ preview: { "matched-text": "https://a.example/x", "canonical-url": "https://a.example/x", title: "Title" } });
    try {
      await kit.send({ fields: { text: "see https://a.example/x", linkPreview: true } });
      await kit.tick();
      assert.equal(kit.sock.sent[0].content.linkPreview.title, "Title");
    } finally {
      text.prepare = realPrepare;
    }
  });
});

describe("ids and logs", () => {
  test("without an injected generator the id is Baileys' own (generateMessageIDV2): a 3EB0 id derived from the bot's user", async () => {
    await boot({ deps: { newMessageId: undefined } });
    const { message } = await kit.send();
    await kit.tick();
    const row = await kit.row(message.publicId);
    assert.match(row.waId, /^3EB0[0-9A-F]{18,}$/);
    assert.equal(kit.sock.sent[0].key.id, row.waId);
  });

  test("RT-05: the logs name a message by its public id and a recipient masked, never the text or the number", async () => {
    const logger = require("../lib/utils/logger");
    const lines = [];
    logger.setLevel("debug");
    logger.setOutput((text) => lines.push(String(text)));
    try {
      await boot();
      await kit.send({ fields: { text: "CANARY-TEXT-9f2c one" } });
      await kit.send({ to: "237690000002", fields: { text: "CANARY-TEXT-9f2c two" } });
      await kit.tick();
      kit.sock.sendMessage = async () => {
        throw refusedError();
      };
      await kit.tick(3 * SEC);
      await kit.send({ to: "237690000002", fields: { text: "CANARY-TEXT-9f2c three" } });
      kit.banned.add(PN2);
      await kit.tick(3 * SEC);
    } finally {
      logger.setOutput();
      logger.setLevel("silent");
    }
    const output = lines.join("\n");
    assert.ok(lines.length > 0, "something was logged at debug");
    assert.match(output, /msg_[A-Za-z0-9_-]{22}/);
    assert.match(output, /237\.\.\.01/, "the recipient appears masked");
    assert.doesNotMatch(output, /CANARY-TEXT-9f2c/);
    assert.doesNotMatch(output, /237690000001|237690000002/);
  });
});

describe("the quoted shell of U13, per format (4.3 step 9)", () => {
  const SHELLS = {
    text: { conversation: "" },
    location: { conversation: "" },
    contact: { conversation: "" },
    poll: { conversation: "" },
    buttons: { conversation: "" },
    list: { conversation: "" },
    image: { imageMessage: {} },
    sticker: { imageMessage: {} },
    video: { videoMessage: {} },
    gif: { videoMessage: {} },
    audio: { audioMessage: {} },
    voice: { audioMessage: {} },
    document: { documentMessage: {} },
  };

  test("every format of the quoted message maps to its typed empty shell, with the quoted key of this chat", async () => {
    await boot();
    for (const [format, shell] of Object.entries(SHELLS)) {
      const waId = `3EB0QUOTED${format.toUpperCase().padEnd(10, "X")}`;
      await kit.db.ApiMessage.create({
        publicId: `msg_${format.padEnd(22, "q")}`.slice(0, 26),
        apiKeyId: key.id,
        recipient: PN,
        format: "text",
        status: "queued",
        acceptedAt: new Date(kit.now()),
        expiresAt: new Date(kit.now() + 10 * MIN),
        payload: { v: 1, input: { text: `re ${format}`, linkPreview: false }, media: null, quote: { publicId: `msg_${"Z".repeat(22)}`, waId, format } },
      });
      await kit.messaging.outbox.reseed();
      await kit.tick(3 * SEC);
      const call = kit.sock.sent.at(-1);
      assert.equal(call.content.text, `re ${format}`);
      assert.deepEqual(call.options.quoted, { key: { remoteJid: PN, fromMe: true, id: waId }, message: shell }, format);
    }
    assert.equal(kit.sock.sent.length, 13);
  });

  test("an unquoted message carries no quoted option", async () => {
    await boot();
    await kit.send();
    await kit.tick();
    assert.equal(kit.sock.sent[0].options.quoted, undefined);
  });
});

describe("interactive messages: one attempt through sendPrepared, never a fallback (RT-52, X13)", () => {
  test("buttons: the claim writes the choices, the send carries the pre-generated id, the numbered text is in the body", async () => {
    await boot();
    const { message } = await kit.send({ format: "buttons", fields: { text: "Confirm?", buttons: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] } });
    await kit.tick();
    const row = await kit.row(message.publicId);
    assert.equal(row.status, "sent");
    assert.deepEqual(row.choices, [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }]);
    assert.equal(row.repliesUntil.getTime(), row.sentAt.getTime() + 7 * DAY, "the reply window is a snapshot of the setting at the settle");
    assert.equal(row.payload, null);
    assert.equal(kit.sock.sent.length, 1);
    assert.equal(kit.sock.sent[0].options.messageId, row.waId);
    assert.equal(kit.sock.sent[0].kind, "interactive");
    const wire = JSON.stringify(kit.sock.sent[0].content);
    assert.ok(wire.includes(`api:reply:${row.waId}:yes`), "wire ids carry the id the engine minted");
    assert.ok(/1\. Yes/.test(kit.sock.sent[0].text), "numbered text version in the body");
  });

  test("a failing interactive send is one attempt: no second plain message, failed / send_failed, reply material erased", async () => {
    await boot();
    let relays = 0;
    kit.sock.relayMessage = async () => {
      relays += 1;
      throw refusedError();
    };
    const { message } = await kit.send({ format: "buttons", fields: { text: "Ok?", buttons: [{ id: "a", label: "A" }] } });
    await kit.tick();
    for (let i = 0; i < 4; i += 1) await kit.tick(3 * SEC);
    assert.equal(relays, 1);
    assert.equal(kit.sock.sent.length, 0, "no fallback message");
    const row = await kit.row(message.publicId);
    assert.deepEqual([row.status, row.errorCode, row.choices, row.repliesUntil], ["failed", "send_failed", null, null]);
  });

  test("a timeout of an interactive send is unknown and keeps the reply material and the window", async () => {
    await boot();
    kit.sock.relayMessage = async () => {
      throw timeoutError();
    };
    const { message } = await kit.send({ format: "buttons", fields: { text: "Ok?", buttons: [{ id: "a", label: "A" }] } });
    await kit.tick();
    const row = await kit.row(message.publicId);
    assert.equal(row.status, "unknown");
    assert.deepEqual(row.choices, [{ id: "a", label: "A" }]);
    assert.equal(row.repliesUntil.getTime(), row.endedAt.getTime() + 7 * DAY);
  });

  test("a list: single_select with the numbered titles; a poll: the secret is encrypted, the digests are kept", async () => {
    await boot();
    const list = await kit.send({ format: "list", fields: { text: "Pick", buttonLabel: "Open", choices: [{ id: "c1", title: "One" }, { id: "c2", title: "Two", description: "second" }] } });
    const poll = await kit.send({ format: "poll", fields: { question: "Day?", options: ["Tue", "Thu"], multiple: false } });
    await kit.tick();
    await kit.tick(3 * SEC);
    const listRow = await kit.row(list.message.publicId);
    assert.deepEqual(listRow.choices, [{ id: "c1", label: "One" }, { id: "c2", label: "Two" }]);

    const pollRow = await kit.row(poll.message.publicId);
    assert.equal(pollRow.status, "sent");
    assert.deepEqual(pollRow.choices, [{ id: "0", label: "Tue" }, { id: "1", label: "Thu" }]);
    assert.equal(pollRow.replyData.v, 1);
    assert.equal(pollRow.replyData.hashes.length, 2);
    assert.match(pollRow.pollSecret, /^enc:v1:/);
    const content = kit.sock.sent.find((s) => s.content.poll).content.poll;
    const { createSecretBox } = require("../lib/utils/secretBox");
    const opened_ = createSecretBox({ dir: path.join(kit.tmp, "data") }).decrypt(pollRow.pollSecret, `api-poll:${pollRow.publicId}`);
    assert.equal(opened_.ok, true);
    assert.equal(opened_.value, Buffer.from(content.messageSecret).toString("hex"), "the stored secret is the one WhatsApp got");
    assert.equal(content.selectableCount, 1);
  });

  test("the engine never calls a helper with a text fallback (static)", () => {
    const source = fs.readFileSync(require.resolve("../lib/messaging/outbox"), "utf8");
    for (const forbidden of ["sendQuickReplies", "sendList", "sendButtons"]) assert.ok(!source.includes(forbidden), forbidden);
    assert.ok(source.includes("sendPrepared"));
  });
});

// =====================================================================================================================
// Part 2: waiters, cancellation, pause, lifecycle
// =====================================================================================================================

describe("waiters (4.7)", () => {
  test("waitFor resolves on sent, with a fresh view, not later on delivered", async () => {
    await boot();
    const { message } = await kit.send();
    const waiting = kit.messaging.waitFor(message.publicId, 20 * SEC);
    let settled = false;
    waiting.promise.then(() => {
      settled = true;
    });
    await kit.clock.advance(100);
    assert.equal(settled, false, "queued: held");
    await kit.tick();
    const view = await waiting.promise;
    assert.equal(view.status, "sent");
    assert.equal(view.publicId, message.publicId);
    assert.equal(kit.clock.pending() > 0, true);
  });

  test("a row already sent, delivered, read, failed, expired, cancelled or unknown resolves at once", async () => {
    await boot();
    for (const status of ["sent", "delivered", "read", "failed", "expired", "cancelled", "unknown"]) {
      const { message } = await kit.send({ fields: { text: status } });
      // the status is forced: this scenario only looks at the waiter
      await kit.db.ApiMessage.update({ status }, { where: { publicId: message.publicId } });
      const view = await kit.messaging.waitFor(message.publicId, 20 * SEC).promise;
      assert.equal(view.status, status);
    }
    await kit.db.ApiMessage.destroy({ where: {} });
  });

  test("the deadline resolves with the current row; the wait is capped at 30 s", async () => {
    await boot();
    kit.client.setReady(false);
    const { message } = await kit.send();
    const short = kit.messaging.waitFor(message.publicId, 5000);
    await kit.clock.advance(4999);
    let done = false;
    short.promise.then(() => {
      done = true;
    });
    await kit.clock.advance(0);
    assert.equal(done, false);
    await kit.clock.advance(1);
    assert.equal((await short.promise).status, "queued");

    const long = kit.messaging.waitFor(message.publicId, 600000);
    let longDone = false;
    long.promise.then(() => {
      longDone = true;
    });
    await kit.clock.advance(29999);
    assert.equal(longDone, false);
    await kit.clock.advance(1);
    assert.equal((await long.promise).status, "queued");
  });

  test("cancel() drops the waiter and its timer", async () => {
    await boot();
    kit.client.setReady(false);
    const { message } = await kit.send();
    const before = kit.clock.pending();
    const waiting = kit.messaging.waitFor(message.publicId, 20 * SEC);
    await kit.clock.advance(0);
    assert.equal(kit.clock.pending(), before + 1);
    waiting.cancel();
    assert.equal(kit.clock.pending(), before);
  });

  test("above 200 waiters the call resolves at once with the current row", async () => {
    await boot();
    kit.client.setReady(false);
    const { message } = await kit.send();
    const waiters = Array.from({ length: 200 }, () => kit.messaging.waitFor(message.publicId, 20 * SEC));
    await kit.clock.advance(0);
    const extra = await kit.messaging.waitFor(message.publicId, 20 * SEC).promise;
    assert.equal(extra.status, "queued", "resolved at once, not an error");
    for (const waiting of waiters) waiting.cancel();
  });

  test("disable() and stop() resolve every waiter with the current rows", async () => {
    await boot();
    const a = await kit.send({ fields: { text: "a" } });
    const first = kit.messaging.waitFor(a.message.publicId, 20 * SEC);
    const second = kit.messaging.waitFor(a.message.publicId, 20 * SEC);
    await kit.clock.advance(0);
    const { cancelled } = await kit.messaging.disable();
    assert.equal(cancelled, 1);
    assert.equal((await first.promise).status, "cancelled");
    assert.equal((await second.promise).status, "cancelled");

    kit.setEnabled(true);
    await kit.messaging.enable();
    const b = await kit.send({ fields: { text: "b" } });
    kit.client.setReady(false);
    const third = kit.messaging.waitFor(b.message.publicId, 20 * SEC);
    await kit.clock.advance(0);
    await kit.messaging.stop();
    assert.equal((await third.promise).status, "queued", "stop() ends the wait, the row stays queued (FR-038)");
  });

  test("an unknown message id resolves to null", async () => {
    await boot();
    assert.equal(await kit.messaging.waitFor(`msg_${"N".repeat(22)}`, 1000).promise, null);
  });
});

describe("cancellation (4.8)", () => {
  test("cancelByKey cancels the key's queued rows only, with the reason, and reports the count", async () => {
    await boot();
    const other = await kit.key();
    const mine1 = await kit.send({ fields: { text: "1" } });
    const mine2 = await kit.send({ fields: { text: "2" } });
    const theirs = await kit.send({ apiKeyId: other.id });
    assert.equal(await kit.messaging.cancelForKey(key.id, "key_revoked"), 2);
    for (const m of [mine1, mine2]) {
      const row = await kit.row(m.message.publicId);
      assert.deepEqual([row.status, row.errorCode, row.payload], ["cancelled", "key_revoked", null]);
      assert.ok(row.endedAt);
    }
    assert.equal((await kit.row(theirs.message.publicId)).status, "queued");
    assert.equal(await kit.messaging.cancelForKey(key.id, "key_revoked"), 0, "idempotent");
  });

  test("cancelByKey racing a claim: the claim loses the compare-and-swap and nothing is sent; after the claim it cannot cancel", async () => {
    const base = await createEngineKit();
    const db = base.db;
    await base.close();
    let racing = false;
    kit = await createEngineKit({
      clear: false,
      models: interceptUpdate(db, async (values, opts, original) => {
        if (values.status === "sending" && racing) {
          racing = false;
          await kit.messaging.cancelForKey(key.id, "key_revoked"); // lands between the pick and the claim
        }
        return original();
      }),
    });
    opened.push(kit);
    key = await kit.key();
    await kit.start();
    racing = true;
    const { message } = await kit.send();
    await kit.tick();
    const row = await kit.row(message.publicId);
    assert.deepEqual([row.status, row.errorCode], ["cancelled", "key_revoked"], "the cancel won the compare-and-swap");
    assert.equal(kit.sock.sent.length, 0);
    assert.equal(kit.gate.lastSendAt(), null);

    // the other way round: once claimed, cancelByKey leaves the row alone and it finishes normally
    const release = deferred();
    kit.sock.sendMessage = () => release.promise.then(() => ({ key: { id: "x" } }));
    const second = await kit.send({ fields: { text: "second" } });
    const pass = kit.messaging.tick(kit.now());
    await until(async () => (await kit.row(second.message.publicId)).status === "sending", "the claim");
    assert.equal(await kit.messaging.cancelForKey(key.id, "key_revoked"), 0);
    release.resolve();
    await pass;
    assert.equal((await kit.row(second.message.publicId)).status, "sent");
  });

  test("disable() cancels every queued row with api_disabled while a sending row finishes normally", async () => {
    await boot();
    const release = deferred();
    kit.sock.sendMessage = () => release.promise.then(() => ({ key: { id: "x" } }));
    const inFlight = await kit.send({ fields: { text: "in flight" } });
    const waiting = await kit.send({ fields: { text: "waiting" } });
    const other = await kit.send({ to: "237690000002", fields: { text: "other" } });
    const pass = kit.messaging.tick(kit.now());
    await until(async () => (await kit.row(inFlight.message.publicId)).status === "sending", "the claim");

    const { cancelled } = await kit.messaging.disable();
    assert.equal(cancelled, 2);
    for (const m of [waiting, other]) {
      const row = await kit.row(m.message.publicId);
      assert.deepEqual([row.status, row.errorCode, row.payload], ["cancelled", "api_disabled", null]);
    }
    release.resolve();
    await pass;
    assert.equal((await kit.row(inFlight.message.publicId)).status, "sent");
  });

  test("cancelAll cancels every queued row of every key and removes their staged media; recover() removes the stage of a sending row", async () => {
    await boot();
    const other = await kit.key();
    const staged = async (tag, status, over = {}) => {
      const publicId = `msg_${tag.repeat(22)}`;
      const source = path.join(kit.tmp, `incoming-${tag}`);
      fs.writeFileSync(source, "pixels");
      const { mediaPath } = await kit.stage.adopt(publicId, source, { mode: "move" });
      await kit.db.ApiMessage.create({
        publicId,
        apiKeyId: over.apiKeyId || key.id,
        recipient: PN,
        format: "image",
        status,
        acceptedAt: new Date(kit.now() - 10 * SEC),
        expiresAt: new Date(kit.now() + 5 * MIN),
        payload: { v: 1, input: {}, media: { source: "upload", mime: "image/png", ext: "png", size: 6, fileName: null }, quote: null },
        mediaPath,
        ...over.row,
      });
      return publicId;
    };
    const dirOf = (publicId) => path.join(kit.stage.rootDir(), publicId);
    const a = await staged("A", "queued");
    const b = await staged("B", "queued", { apiKeyId: other.id });
    const c = await staged("C", "sending", { row: { sendingAt: new Date(kit.now() - 5 * SEC), waId: "3EB0STAGEDSENDING0001" } });
    assert.ok([a, b, c].every((id) => fs.existsSync(dirOf(id))));

    assert.equal(await kit.messaging.outbox.cancelAll("api_disabled"), 2);
    for (const id of [a, b]) {
      const row = await kit.row(id);
      assert.deepEqual([row.status, row.errorCode, row.mediaPath, row.payload], ["cancelled", "api_disabled", null, null]);
      assert.equal(fs.existsSync(dirOf(id)), false, "the staged directory is gone");
    }
    assert.equal((await kit.row(c)).status, "sending", "a sending row is never cancelled");
    assert.ok(fs.existsSync(dirOf(c)));

    assert.deepEqual(await kit.messaging.outbox.recover({ now: kit.now() }), { unknown: 1, cancelled: 0 });
    const recovered = await kit.row(c);
    assert.deepEqual([recovered.status, recovered.errorCode, recovered.mediaPath], ["unknown", "interrupted", null]);
    assert.equal(fs.existsSync(dirOf(c)), false, "boot recovery removes the stage of the row it moves to unknown");
  });

  test("the switch turned off through apiState cancels the queue and leaves no timer and no listener", async () => {
    await boot({ deps: { receipts: () => ({ handle() {} }) } });
    assert.equal(kit.messaging.isRunning(), true);
    assert.equal(kit.client.listenerCount("messages.update"), 1);
    assert.equal(kit.clock.pending(), 1);
    const { message } = await kit.send();
    kit.setEnabled(false);
    await until(async () => (await kit.row(message.publicId)).status === "cancelled", "the cancellation");
    assert.equal((await kit.row(message.publicId)).errorCode, "api_disabled");
    assert.equal(kit.messaging.isRunning(), false);
    assert.equal(kit.client.listenerCount("messages.update"), 0);
    assert.equal(kit.clock.pending(), 0);
  });

  test("a submit that passed the switch check but meets the switch off inside the lock is refused", async () => {
    await boot();
    kit.setEnabled(false);
    await assert.rejects(kit.send(), (err) => err instanceof MessagingError && err.code === "api_disabled");
    assert.equal(await kit.db.ApiMessage.count(), 0);
  });
});

describe("recover() at boot (RT-54)", () => {
  async function seedRows() {
    const base = { apiKeyId: key.id, recipient: PN, acceptedAt: new Date(kit.now() - MIN), expiresAt: new Date(kit.now() + 5 * MIN) };
    const stuck = await kit.db.ApiMessage.create({
      ...base,
      publicId: `msg_${"S".repeat(22)}`,
      format: "text",
      status: "sending",
      sendingAt: new Date(kit.now() - 30 * SEC),
      waId: "3EB0STUCKSTUCKSTUCK01",
      payload: { v: 1, input: { text: "x" }, media: null, quote: null },
    });
    const stuckPoll = await kit.db.ApiMessage.create({
      ...base,
      publicId: `msg_${"P".repeat(22)}`,
      format: "poll",
      status: "sending",
      sendingAt: new Date(kit.now() - 20 * SEC),
      waId: "3EB0STUCKSTUCKSTUCK02",
      choices: [{ id: "0", label: "a" }, { id: "1", label: "b" }],
      replyData: { v: 1, multi: false, hashes: ["a".repeat(64), "b".repeat(64)] },
      pollSecret: "enc:v1:x:y:z",
      payload: { v: 1, input: { question: "q", options: ["a", "b"], multiple: false }, media: null, quote: null },
    });
    const queued = await kit.db.ApiMessage.create({ ...base, publicId: `msg_${"Q".repeat(22)}`, format: "text", status: "queued", payload: { v: 1, input: { text: "q", linkPreview: false }, media: null, quote: null } });
    const old = await kit.db.ApiMessage.create({ ...base, publicId: `msg_${"O".repeat(22)}`, format: "text", status: "queued", expiresAt: new Date(kit.now() - SEC), payload: { v: 1, input: { text: "o", linkPreview: false }, media: null, quote: null } });
    return { stuck, stuckPoll, queued, old };
  }

  test("every sending row becomes unknown / interrupted (never resent, interactive keeps its reply material); queued resumes unless expired", async () => {
    await boot({ start: false });
    const rows = await seedRows();
    await kit.start();
    const stuck = await kit.row(rows.stuck.publicId);
    assert.deepEqual([stuck.status, stuck.errorCode, stuck.payload, stuck.waId], ["unknown", "interrupted", null, "3EB0STUCKSTUCKSTUCK01"]);
    assert.ok(stuck.endedAt);
    const poll = await kit.row(rows.stuckPoll.publicId);
    assert.equal(poll.status, "unknown");
    assert.ok(poll.pollSecret && poll.replyData && poll.choices);
    assert.equal(poll.repliesUntil.getTime(), poll.endedAt.getTime() + 7 * DAY);

    await kit.tick();
    assert.equal((await kit.row(rows.queued.publicId)).status, "sent", "a queued row resumes");
    assert.equal((await kit.row(rows.old.publicId)).status, "expired", "the first tick expires an expired one");
    assert.equal(kit.sock.sent.length, 1, "the sending rows were not resent");
  });

  test("with the switch off, recover() moves every queued row to cancelled / api_disabled (ADMIN_PANEL=false after a crash)", async () => {
    await boot({ start: false, enabled: false });
    const rows = await seedRows();
    await kit.start();
    for (const r of [rows.queued, rows.old]) {
      const row = await kit.row(r.publicId);
      assert.deepEqual([row.status, row.errorCode, row.payload], ["cancelled", "api_disabled", null]);
    }
    assert.equal((await kit.row(rows.stuck.publicId)).status, "unknown");
    assert.equal(kit.messaging.isRunning(), false, "recovery-only mode: no timer");
    assert.equal(kit.clock.pending(), 0);
  });

  test("a sending row seeds the gate at start(): no burst right behind the last message", async () => {
    await boot({ start: false });
    await kit.db.ApiMessage.create({
      publicId: `msg_${"G".repeat(22)}`,
      apiKeyId: key.id,
      recipient: PN,
      format: "text",
      status: "sent",
      acceptedAt: new Date(kit.now() - SEC),
      expiresAt: new Date(kit.now() + MIN),
      sendingAt: new Date(kit.now() - 500),
      sentAt: new Date(kit.now() - 400),
      waId: "3EB0GATEGATEGATEGATE",
    });
    await kit.send();
    await kit.start();
    await kit.tick();
    assert.equal(kit.sock.sent.length, 0, "inside 2 s of the stored send");
    await kit.tick(1000);
    assert.equal(kit.sock.sent.length, 0);
    await kit.tick(500);
    assert.equal(kit.sock.sent.length, 1);
  });
});

describe("the 463 breaker (4.6, Y7)", () => {
  const restrict = (at) => kit.messaging.outbox.onRestricted("463", at);

  test("one or two restriction acks pause nothing and raise nothing", async () => {
    await boot();
    restrict(kit.now());
    restrict(kit.now() + MIN);
    assert.equal(kit.messaging.stats ? (await kit.messaging.stats()).pausedUntil : null, null);
    assert.deepEqual(kit.alerts.calls, []);
    await kit.send();
    await kit.tick();
    assert.equal(kit.sock.sent.length, 1);
  });

  test("three within 10 minutes pause the queue for 15 minutes, expiries unchanged, one alert with resumesAt", async () => {
    await boot();
    const t = kit.now();
    restrict(t);
    restrict(t + 2 * MIN);
    restrict(t + 4 * MIN);
    const pausedUntil = t + 4 * MIN + 15 * MIN;
    assert.equal((await kit.messaging.stats()).pausedUntil, pausedUntil);
    assert.deepEqual(kit.alerts.calls, [{ type: "api_paused", payload: { resumesAt: pausedUntil } }]);

    kit.clock.set(t + 4 * MIN);
    const { message } = await kit.send({ now: t + 4 * MIN });
    await kit.tick(5 * MIN);
    assert.equal(kit.sock.sent.length, 0, "nothing is claimed while paused");
    assert.equal((await kit.row(message.publicId)).status, "queued");
    await kit.tick(5 * MIN + SEC); // 10 minutes after acceptance: expired, the pause does not extend it
    assert.equal((await kit.row(message.publicId)).status, "expired");

    // resumes after the pause
    await kit.clock.advance(pausedUntil - kit.now() + SEC);
    const later = await kit.send();
    await kit.tick();
    assert.equal((await kit.row(later.message.publicId)).status, "sent");
    assert.equal((await kit.messaging.stats()).pausedUntil, null, "the pause is over");
  });

  test("two in 10 minutes plus a third later do not pause; the list is emptied when the breaker opens", async () => {
    await boot();
    const t = kit.now();
    restrict(t);
    restrict(t + MIN);
    restrict(t + 11 * MIN);
    assert.equal((await kit.messaging.stats()).pausedUntil, null);
    assert.deepEqual(kit.alerts.calls, []);

    restrict(t + 12 * MIN);
    restrict(t + 13 * MIN);
    assert.ok((await kit.messaging.stats()).pausedUntil);
    assert.equal(kit.alerts.calls.length, 1);
    // emptied: two more right after the pause ends do not reopen it
    const resume = t + 13 * MIN + 15 * MIN;
    restrict(resume + SEC);
    restrict(resume + 2 * SEC);
    assert.equal(kit.alerts.calls.length, 1);
  });

  test("a code that is not a restriction code is ignored", async () => {
    await boot();
    for (let i = 0; i < 5; i += 1) kit.messaging.outbox.onRestricted("401", kit.now() + i);
    assert.equal((await kit.messaging.stats()).pausedUntil, null);
  });
});

describe("lifecycle: no timer and no listener while disabled, a tick sleeps when idle (RT-02, RT-03, FR-001)", () => {
  test("a disabled API holds no timer and no client listener; the only subscription is apiState.onChange", async () => {
    await boot({ enabled: false, deps: { receipts: () => ({ handle() {} }) } });
    assert.equal(kit.clock.pending(), 0);
    assert.equal(kit.client.listenerCount("messages.update"), 0);
    assert.equal(kit.messaging.isRunning(), false);
    assert.equal(kit.listeners.length, 1);
    await kit.messaging.stop();
    assert.equal(kit.listeners.length, 0, "stop() unsubscribes");
  });

  test("switching on starts the timer and the receipts listener and kicks a tick; switching off removes them", async () => {
    await boot({ enabled: false, autoKick: true, deps: { receipts: () => ({ handle() {} }) } });
    await assert.rejects(kit.send(), (err) => err instanceof MessagingError && err.code === "api_disabled");
    kit.setEnabled(true);
    assert.equal(kit.messaging.isRunning(), true);
    assert.equal(kit.clock.pending(), 1);
    assert.equal(kit.client.listenerCount("messages.update"), 1);
    const accepted = await kit.send();
    await until(() => kit.sock.sent.length === 1, "the kick after the accept");
    assert.equal((await kit.row(accepted.message.publicId)).status, "sent");
    kit.setEnabled(false);
    await until(() => !kit.messaging.isRunning(), "disable");
    assert.equal(kit.clock.pending(), 0);
    assert.equal(kit.client.listenerCount("messages.update"), 0);
  });

  test("enable() is idempotent: one timer, one listener", async () => {
    await boot({ deps: { receipts: () => ({ handle() {} }) } });
    kit.messaging.enable();
    kit.messaging.enable();
    assert.equal(kit.clock.pending(), 1);
    assert.equal(kit.client.listenerCount("messages.update"), 1);
  });

  test("an idle tick (nothing queued) runs no query; a queued row wakes it", async () => {
    const counts = { total: 0 };
    const base = await createEngineKit();
    const db = base.db;
    await base.close();
    const spied = {};
    for (const [name, model] of Object.entries(db)) {
      spied[name] =
        model && typeof model.findAll === "function"
          ? new Proxy(model, {
              get(t, prop) {
                const value = t[prop];
                if (typeof value !== "function") return value;
                return (...args) => {
                  if (["findAll", "findOne", "count", "update", "findByPk", "max", "sum", "create", "bulkCreate"].includes(prop)) counts.total += 1;
                  return value.apply(t, args);
                };
              },
            })
          : model;
    }
    kit = await createEngineKit({ clear: false, models: spied });
    opened.push(kit);
    key = await kit.key();
    await kit.start();
    await new Promise((resolve) => setTimeout(resolve, 50)); // the seed query and the first kick settle
    counts.total = 0;
    for (let i = 0; i < 10; i += 1) await kit.tick(SEC);
    assert.equal(counts.total, 0, "pendingHint is 0: the tick returns before any query");
    assert.equal(kit.clock.pending(), 1, "only the interval timer exists");
    await kit.send();
    await kit.tick();
    assert.equal(kit.sock.sent.length, 1);
  });

  test("maintenance mode makes the tick return; begin() brackets claim to settle and done() always runs", async () => {
    await boot();
    await kit.send();
    await maintenanceMode.enter("restore");
    await kit.tick();
    assert.equal(kit.sock.sent.length, 0, "no send during a restore");
    maintenanceMode.leave();

    const dones = [];
    const begin = mock.method(maintenanceMode, "begin", () => () => dones.push("done"));
    await kit.tick();
    assert.equal(kit.sock.sent.length, 1);
    assert.equal(begin.mock.calls.length, 1);
    assert.deepEqual(dones, ["done"]);

    kit.sock.sendMessage = async () => {
      throw refusedError();
    };
    await kit.send({ fields: { text: "fails" } });
    await kit.tick(3 * SEC);
    assert.equal(begin.mock.calls.length, 2);
    assert.deepEqual(dones, ["done", "done"], "done() runs when the send fails too");
  });

  test("stop() clears the timer and detaches the listener; the queued rows stay queued", async () => {
    await boot({ deps: { receipts: () => ({ handle() {} }) } });
    const { message } = await kit.send({ source: "panel", apiKeyId: null, policy: null, limits: null });
    await kit.messaging.stop();
    assert.equal(kit.clock.pending(), 0);
    assert.equal(kit.client.listenerCount("messages.update"), 0);
    assert.equal(kit.messaging.isRunning(), false);
    assert.ok(["queued", "sent"].includes((await kit.row(message.publicId)).status));
  });

  test("start() is idempotent and a second call changes nothing", async () => {
    await boot({ deps: { receipts: () => ({ handle() {} }) } });
    await kit.start();
    await kit.start();
    assert.equal(kit.clock.pending(), 1);
    assert.equal(kit.listeners.length, 1);
  });

  test("a failing format registry leaves the engine not running: start() reports it, enable() does nothing, queued rows are kept", async () => {
    const bad = path.join(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "owb-badformats-")), "formats");
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, "nothing.js"), "module.exports = { name: 'other' };\n");
    const formats = require("../lib/messaging/formats").createRegistry({ dir: bad });
    kit = await createEngineKit({ deps: { formats } });
    opened.push(kit);
    key = await kit.key();
    await assert.rejects(kit.start(), (err) => err.name === "FormatRegistryError");
    assert.equal(kit.messaging.isRunning(), false);
    kit.messaging.enable();
    assert.equal(kit.messaging.isRunning(), false);
    assert.equal(kit.clock.pending(), 0);
  });

  test("the process-wide facade requires no work at load: no timer, no listener", () => {
    const messaging = require("../lib/messaging");
    assert.equal(messaging.isRunning(), false);
    assert.equal(typeof messaging.createMessaging, "function");
    assert.equal(messaging.MessagingError, MessagingError);
    assert.equal(messaging.MESSAGING_STATUS.queue_full, 503);
  });
});

// =====================================================================================================================
// Media (Phase 4): staged files, the media timeout, deletion after the terminal UPDATE (4.3, 4.9, 10.3, data-model 7)
// =====================================================================================================================

const { spawnSync } = require("node:child_process");
const haveFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("media messages", () => {
  const dirOf = (publicId) => path.join(kit.stage.rootDir(), publicId);
  const sourceOf = (publicId) => path.join(dirOf(publicId), "source");

  async function sendImage(over = {}) {
    const png = await samples.png();
    const accepted = await kit.send({ format: "image", fields: { caption: "Your receipt" }, media: kit.file(png, "photo.png"), ...over });
    return { ...accepted, png };
  }

  test("an image goes out from its staged path with the detected type; afterwards the file, the directory and mediaPath are gone", async () => {
    await boot();
    const { message, png } = await sendImage();
    assert.ok(fs.existsSync(sourceOf(message.publicId)));
    await kit.tick();
    assert.equal(kit.sock.sent.length, 1);
    const content = kit.sock.sent[0].content;
    assert.equal(content.image.url, sourceOf(message.publicId), "the staged path, never a caller string");
    assert.equal(content.mimetype, "image/png");
    assert.equal(content.caption, "Your receipt");
    assert.equal(kit.sock.sent[0].options.messageId, (await kit.row(message.publicId)).waId);

    const row = await kit.row(message.publicId);
    assert.deepEqual([row.status, row.payload, row.mediaPath], ["sent", null, null]);
    assert.equal(fs.existsSync(dirOf(message.publicId)), false, "removed after the terminal UPDATE");
    assert.equal(row.size, png.length);
  });

  test("a document goes out with the sanitised name and the detected mime", async () => {
    await boot();
    const accepted = await kit.send({ format: "document", fields: { caption: "Invoice", fileName: "Invoice 2026.pdf" }, media: kit.file(samples.pdf(), "x.bin") });
    await kit.tick();
    const content = kit.sock.sent[0].content;
    assert.equal(content.mimetype, "application/pdf");
    assert.match(content.fileName, /\.pdf$/);
    assert.equal(content.document.url, sourceOf(accepted.message.publicId));
    assert.equal(content.caption, "Invoice");
  });

  test("a sticker is converted while the row is still queued: the WebP prepared beside the source is what is sent", async () => {
    await boot();
    const accepted = await kit.send({ format: "sticker", fields: {}, media: kit.file(await samples.png()) });
    const seen = [];
    const sticker = kit.messaging.formats.get("sticker");
    const realPrepare = sticker.prepare;
    sticker.prepare = async (ctx) => {
      seen.push((await kit.row(accepted.message.publicId)).status);
      return realPrepare.call(sticker, ctx);
    };
    try {
      await kit.tick();
    } finally {
      sticker.prepare = realPrepare;
    }
    assert.deepEqual(seen, ["queued"], "a crash during the conversion loses nothing");
    const url = kit.sock.sent[0].content.sticker.url;
    assert.equal(url, path.join(dirOf(accepted.message.publicId), "prepared.webp"));
    assert.equal((await kit.row(accepted.message.publicId)).status, "sent");
    assert.equal(fs.existsSync(dirOf(accepted.message.publicId)), false, "the prepared file goes with the directory");
  });

  test("a voice note is converted to Ogg/Opus (real ffmpeg, skipped when absent)", { skip: !haveFfmpeg && "ffmpeg is not installed" }, async () => {
    await boot();
    const wav = path.join(kit.tmp, "tone.wav");
    assert.equal(spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", wav]).status, 0);
    const accepted = await kit.send({ format: "voice", fields: {}, media: kit.file(fs.readFileSync(wav)) });
    await kit.tick();
    const content = kit.sock.sent[0].content;
    assert.equal(content.ptt, true);
    assert.equal(content.mimetype, "audio/ogg; codecs=opus");
    assert.equal(content.audio.url, path.join(dirOf(accepted.message.publicId), "prepared.ogg"));
    assert.equal((await kit.row(accepted.message.publicId)).status, "sent");
  });

  test("a GIF is converted to an MP4 and played back as a GIF (real ffmpeg, skipped when absent)", { skip: !haveFfmpeg && "ffmpeg is not installed" }, async () => {
    await boot();
    const gif = path.join(kit.tmp, "anim.gif");
    assert.equal(spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=5", gif]).status, 0);
    const accepted = await kit.send({ format: "gif", fields: {}, media: kit.file(fs.readFileSync(gif)) });
    await kit.tick();
    const content = kit.sock.sent[0].content;
    assert.equal(content.gifPlayback, true);
    assert.equal(content.mimetype, "video/mp4");
    assert.equal(content.video.url, path.join(dirOf(accepted.message.publicId), "prepared.mp4"));
  });

  test("a conversion that fails is failed / media_conversion_failed, before the claim, and the directory goes", async () => {
    await boot();
    const sticker = kit.messaging.formats.get("sticker");
    const realPrepare = sticker.prepare;
    sticker.prepare = async () => {
      throw new Error("sharp could not decode the image");
    };
    try {
      const accepted = await kit.send({ format: "sticker", fields: {}, media: kit.file(await samples.png()) });
      await kit.tick();
      const row = await kit.row(accepted.message.publicId);
      assert.deepEqual([row.status, row.errorCode, row.waId, row.mediaPath], ["failed", "media_conversion_failed", null, null]);
      assert.equal(fs.existsSync(dirOf(accepted.message.publicId)), false);
      assert.equal(kit.sock.sent.length, 0);
    } finally {
      sticker.prepare = realPrepare;
    }
  });

  test("M3: a sticker whose picture is a decompression bomb is failed / media_conversion_failed before the claim (real sharp, 25 Mpx limit)", async () => {
    await boot();
    const bomb = samples.bombPng(7000, 7000); // a few KiB declaring 49 million pixels
    assert.ok(bomb.length < 200 * 1024);
    const accepted = await kit.send({ format: "sticker", fields: {}, media: kit.file(bomb) });
    await kit.tick();
    const row = await kit.row(accepted.message.publicId);
    assert.deepEqual([row.status, row.errorCode, row.waId, row.mediaPath], ["failed", "media_conversion_failed", null, null]);
    assert.equal(fs.existsSync(dirOf(accepted.message.publicId)), false);
    assert.equal(kit.sock.sent.length, 0);
    assert.equal(kit.gate.lastSendAt(), null, "nothing reserved");
  });

  test("a directory that vanished fails the row as payload_unavailable: the caption is never sent as a text-only message", async () => {
    await boot();
    const { message } = await sendImage();
    fs.rmSync(dirOf(message.publicId), { recursive: true });
    await kit.tick();
    const row = await kit.row(message.publicId);
    assert.deepEqual([row.status, row.errorCode, row.payload], ["failed", "payload_unavailable", null]);
    assert.equal(kit.sock.sent.length, 0);
    assert.equal(kit.gate.lastSendAt(), null);
  });

  test("a failed or unknown send removes the staged media too (T7, T8)", async () => {
    await boot();
    kit.sock.sendMessage = async () => {
      throw refusedError();
    };
    const first = await sendImage();
    await kit.tick();
    assert.equal((await kit.row(first.message.publicId)).status, "failed");
    assert.equal(fs.existsSync(dirOf(first.message.publicId)), false);

    kit.sock.sendMessage = async () => {
      throw timeoutError();
    };
    const second = await sendImage();
    await kit.tick(3 * SEC);
    const row = await kit.row(second.message.publicId);
    assert.deepEqual([row.status, row.errorCode, row.mediaPath], ["unknown", "timeout", null]);
    assert.equal(fs.existsSync(dirOf(second.message.publicId)), false);
  });

  test("a crash between the terminal UPDATE and the deletion leaves a pending-deletion pointer (I6), never a lost state", async () => {
    let broken = true;
    await boot({
      stageWrap: (stage) => ({
        ...stage,
        remove: async (publicId) => {
          if (broken) throw new Error("EBUSY");
          return stage.remove(publicId);
        },
      }),
    });
    const { message } = await sendImage();
    await kit.tick();
    const row = await kit.row(message.publicId);
    assert.deepEqual([row.status, row.payload], ["sent", null], "the terminal state is committed first");
    assert.equal(row.mediaPath, `data/api-media/${message.publicId}/source`, "the pointer of a deletion pending");
    assert.ok(fs.existsSync(dirOf(message.publicId)), "an orphan, finished by the housekeeping");
    broken = false;
  });

  test("the send of a media row has the media timeout (90 s), a text row 30 s", async () => {
    await boot();
    kit.sock.sendMessage = () => new Promise(() => {});
    const media = await sendImage();
    const pass = kit.messaging.tick(kit.now());
    await until(async () => (await kit.row(media.message.publicId)).status === "sending", "the claim");
    await kit.clock.advance(60 * SEC);
    assert.equal((await kit.row(media.message.publicId)).status, "sending", "still waiting at 60 s");
    await kit.clock.advance(30 * SEC);
    await pass;
    assert.deepEqual([(await kit.row(media.message.publicId)).status, (await kit.row(media.message.publicId)).errorCode], ["unknown", "timeout"]);
  });

  test("cancelling and expiring a media row removes its directory (T4, T5)", async () => {
    await boot();
    const a = await sendImage();
    const b = await sendImage();
    assert.equal(await kit.messaging.cancelForKey(key.id, "key_revoked"), 2);
    for (const accepted of [a, b]) {
      assert.equal(fs.existsSync(dirOf(accepted.message.publicId)), false);
      assert.equal((await kit.row(accepted.message.publicId)).mediaPath, null);
    }
    kit.client.setReady(false);
    const c = await sendImage();
    await kit.tick(10 * MIN);
    assert.equal((await kit.row(c.message.publicId)).status, "expired");
    assert.equal(fs.existsSync(dirOf(c.message.publicId)), false);
  });
});
