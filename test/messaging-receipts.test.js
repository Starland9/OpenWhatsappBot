"use strict";
/**
 * Delivery, read and negative acknowledgements (feature 004, contracts/runtime.md section 8, data-model 2.5 T9-T11,
 * RT-90): `lib/messaging/receipts.js` bound to `client.on("messages.update")` by the outbox while the switch is on.
 *
 * Real facade over the in-memory database with the REAL receipts handler (the kit's default); updates are dispatched
 * through `client.dispatch("messages.update", [...])`. `assertMessageInvariants` runs after every scenario.
 */

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const { createEngineKit } = require("./helpers/messagingKit");
const { createReceiptHandler } = require("../lib/messaging/receipts");
const logger = require("../lib/utils/logger");

const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 24 * 60 * MIN;
const PN = "237690000001@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";

let kit;
let key;
let seq = 0;

beforeEach(async () => {
  kit = await createEngineKit();
  key = await kit.key();
  await kit.start();
});

afterEach(async () => {
  await kit.check();
  await kit.close();
});

/** A message that already left: `sent` by default, any later status on request */
async function row(over = {}) {
  const n = ++seq;
  const sentAt = new Date(kit.T0 + 1000);
  const base = {
    publicId: `msg_${String(n).padStart(22, "R")}`,
    apiKeyId: key.id,
    recipient: PN,
    format: "text",
    status: "sent",
    acceptedAt: new Date(kit.T0),
    expiresAt: new Date(kit.T0 + 10 * MIN),
    sendingAt: new Date(kit.T0 + 500),
    sentAt,
    waId: `3EB0RECEIPT${String(n).padStart(9, "0")}`,
  };
  return kit.db.ApiMessage.create({ ...base, ...over });
}

const update = (waId, status, extra = {}, keyOver = {}) => ({
  key: { remoteJid: PN, fromMe: true, id: waId, ...keyOver },
  update: { status, ...extra },
});
const dispatch = (...updates) => kit.client.dispatch("messages.update", updates);
const fresh = (r) => kit.db.ApiMessage.findByPk(r.id);

describe("delivery and read receipts (T9, T10)", () => {
  test("status 3 (delivery ack): sent becomes delivered at WhatsApp's time", async () => {
    const r = await row();
    await dispatch(update(r.waId, 3, { messageTimestamp: Math.floor((kit.T0 + 5 * SEC) / 1000) }));
    const stored = await fresh(r);
    assert.equal(stored.status, "delivered");
    assert.equal(stored.deliveredAt.getTime(), Math.floor((kit.T0 + 5 * SEC) / 1000) * 1000);
    assert.equal(stored.readAt, null);
  });

  test("without a timestamp the time is the engine's clock", async () => {
    const r = await row();
    kit.clock.set(kit.T0 + 20 * SEC);
    await dispatch(update(r.waId, 3));
    assert.equal((await fresh(r)).deliveredAt.getTime(), kit.T0 + 20 * SEC);
  });

  test("status 4 and 5 (read, played): read, and deliveredAt is filled only when it was empty", async () => {
    const a = await row();
    await dispatch(update(a.waId, 4, { messageTimestamp: 1_800_000_100 }));
    let stored = await fresh(a);
    assert.equal(stored.status, "read");
    assert.equal(stored.readAt.getTime(), 1_800_000_100_000);
    assert.equal(stored.deliveredAt.getTime(), 1_800_000_100_000, "a read straight from sent sets both");

    const b = await row();
    await dispatch(update(b.waId, 3, { messageTimestamp: 1_800_000_000 }));
    await dispatch(update(b.waId, 5, { messageTimestamp: 1_800_000_200 }));
    stored = await fresh(b);
    assert.equal(stored.status, "read");
    assert.equal(stored.deliveredAt.getTime(), 1_800_000_000_000, "the earlier delivery time is kept");
    assert.equal(stored.readAt.getTime(), 1_800_000_200_000);
  });

  test("status moves forward only: a late delivered after read, and a repeated read, change nothing", async () => {
    const r = await row();
    await dispatch(update(r.waId, 4, { messageTimestamp: 1_800_000_200 }));
    await dispatch(update(r.waId, 3, { messageTimestamp: 1_800_000_300 }));
    let stored = await fresh(r);
    assert.deepEqual([stored.status, stored.deliveredAt.getTime(), stored.readAt.getTime()], ["read", 1_800_000_200_000, 1_800_000_200_000]);
    await dispatch(update(r.waId, 4, { messageTimestamp: 1_800_000_400 }));
    stored = await fresh(r);
    assert.equal(stored.readAt.getTime(), 1_800_000_200_000, "read is read");
  });

  test("statuses 1 and 2 (pending, server ack) and anything unknown are ignored", async () => {
    const r = await row();
    await dispatch(update(r.waId, 1), update(r.waId, 2), update(r.waId, 9), update(r.waId, -1), update(r.waId, "3"), update(r.waId, null));
    assert.equal((await fresh(r)).status, "sent");
  });

  test("the Long-like and string timestamps Baileys may give are read", async () => {
    const a = await row();
    const b = await row();
    await dispatch(update(a.waId, 3, { messageTimestamp: { toNumber: () => 1_800_000_000 } }), update(b.waId, 3, { messageTimestamp: "1800000050" }));
    assert.equal((await fresh(a)).deliveredAt.getTime(), 1_800_000_000_000);
    assert.equal((await fresh(b)).deliveredAt.getTime(), 1_800_000_050_000);
  });

  test("the row is found by its WhatsApp id alone: a LID chat jid, any remoteJidAlt, any form", async () => {
    const r = await row();
    await dispatch(update(r.waId, 3, { messageTimestamp: 1_800_000_000 }, { remoteJid: "99999999999999@lid", remoteJidAlt: PN }));
    assert.equal((await fresh(r)).status, "delivered");
  });

  test("an id that is not an API message (the bot's own replies get receipts too) changes nothing and costs no error", async () => {
    const r = await row();
    await dispatch(update("3EB0NOTOURS000000001", 3), update("BOT17", 4));
    assert.equal((await fresh(r)).status, "sent");
  });

  test("only the bot's own messages: a receipt on an incoming message is ignored", async () => {
    const r = await row();
    await dispatch(update(r.waId, 3, {}, { fromMe: false }));
    assert.equal((await fresh(r)).status, "sent");
  });

  test("a group id is never consumed: group receipts do not exist here, a group stays at sent (I9)", async () => {
    const r = await row({ recipient: GROUP });
    await dispatch(update(r.waId, 3, {}, { remoteJid: GROUP }), update(r.waId, 4, {}, { remoteJid: GROUP }));
    assert.equal((await fresh(r)).status, "sent");
  });

  test("a queued or sending row has no WhatsApp id to match yet: nothing moves", async () => {
    const sending = await row({ status: "sending", sentAt: null });
    await dispatch(update(sending.waId, 3));
    assert.equal((await fresh(sending)).status, "sending", "a receipt cannot move a row that has not settled");
  });
});

describe("an unknown message upgraded by a late receipt (T9, T10)", () => {
  async function unknownRow(over = {}) {
    return row({
      status: "unknown",
      sentAt: null,
      endedAt: new Date(kit.T0 + 40 * SEC),
      errorCode: "timeout",
      ...over,
    });
  }

  test("delivered: endedAt and errorCode are cleared, sentAt stays empty, nothing is resent", async () => {
    const r = await unknownRow();
    await dispatch(update(r.waId, 3, { messageTimestamp: 1_800_000_000 }));
    const stored = await fresh(r);
    assert.deepEqual([stored.status, stored.endedAt, stored.errorCode, stored.sentAt], ["delivered", null, null, null]);
    await kit.tick(5 * SEC);
    await kit.tick(5 * SEC);
    assert.equal(kit.sock.sent.length, 0, "an upgrade proves the send: it is never a resend");
  });

  test("read: the same, and deliveredAt takes the read time", async () => {
    const r = await unknownRow({ errorCode: "interrupted" });
    await dispatch(update(r.waId, 4, { messageTimestamp: 1_800_000_100 }));
    const stored = await fresh(r);
    assert.deepEqual([stored.status, stored.endedAt, stored.errorCode], ["read", null, null]);
    assert.equal(stored.deliveredAt.getTime(), 1_800_000_100_000);
  });

  test("an interactive unknown message keeps its reply material and window when upgraded", async () => {
    const r = await unknownRow({
      format: "buttons",
      choices: [{ id: "a", label: "A" }],
      repliesUntil: new Date(kit.T0 + 40 * SEC + 7 * DAY),
    });
    await dispatch(update(r.waId, 3, { messageTimestamp: 1_800_000_000 }));
    const stored = await fresh(r);
    assert.equal(stored.status, "delivered");
    assert.deepEqual(stored.choices, [{ id: "a", label: "A" }]);
    assert.ok(stored.repliesUntil);
  });

  test("a group unknown message stays unknown", async () => {
    const r = await unknownRow({ recipient: GROUP });
    await dispatch(update(r.waId, 3, {}, { remoteJid: GROUP }));
    assert.equal((await fresh(r)).status, "unknown");
  });
});

describe("negative acknowledgements (T11, Y7)", () => {
  async function pollRow(over = {}) {
    return row({
      format: "poll",
      choices: [{ id: "0", label: "Yes" }, { id: "1", label: "No" }],
      replyData: { v: 1, multi: false, hashes: ["a".repeat(64), "b".repeat(64)] },
      pollSecret: "enc:v1:x:y:z",
      repliesUntil: new Date(kit.T0 + 7 * DAY),
      ...over,
    });
  }

  test("status 0 fails a sent message as whatsapp_rejected and erases the reply material", async () => {
    const r = await pollRow();
    await dispatch(update(r.waId, 0, { messageTimestamp: 1_800_000_000, messageStubParameters: ["479"] }));
    const stored = await fresh(r);
    assert.deepEqual([stored.status, stored.errorCode], ["failed", "whatsapp_rejected"]);
    assert.equal(stored.endedAt.getTime(), 1_800_000_000_000);
    assert.deepEqual([stored.choices, stored.replyData, stored.pollSecret, stored.repliesUntil], [null, null, null, null]);
    assert.ok(stored.waId, "the id WhatsApp saw is kept");
  });

  test("it also fails an unknown message (the one non-monotone move), but not a delivered or read one", async () => {
    const unknown = await row({ status: "unknown", sentAt: null, endedAt: new Date(kit.T0 + 40 * SEC), errorCode: "timeout" });
    const delivered = await row({ status: "delivered", deliveredAt: new Date(kit.T0 + 3 * SEC) });
    const read = await row({ status: "read", deliveredAt: new Date(kit.T0 + 3 * SEC), readAt: new Date(kit.T0 + 4 * SEC) });
    await dispatch(update(unknown.waId, 0), update(delivered.waId, 0), update(read.waId, 0));
    assert.deepEqual([(await fresh(unknown)).status, (await fresh(unknown)).errorCode], ["failed", "whatsapp_rejected"]);
    assert.equal((await fresh(delivered)).status, "delivered");
    assert.equal((await fresh(read)).status, "read");
  });

  test("one or two 463 refusals only fail their own messages; three within 10 minutes pause the queue and raise api_paused once", async () => {
    const rows = [await row(), await row(), await row(), await row()];
    const nack = (r, extra = {}) => update(r.waId, 0, { messageStubParameters: ["463"], ...extra });
    await dispatch(nack(rows[0]));
    await dispatch(nack(rows[1]));
    assert.equal((await kit.messaging.stats()).pausedUntil, null);
    assert.deepEqual(kit.alerts.calls, []);
    assert.equal((await fresh(rows[0])).errorCode, "whatsapp_rejected");

    await dispatch(nack(rows[2]));
    const stats = await kit.messaging.stats();
    assert.equal(stats.pausedUntil, kit.now() + 15 * MIN);
    assert.deepEqual(kit.alerts.calls, [{ type: "api_paused", payload: { resumesAt: kit.now() + 15 * MIN } }]);

    // the breaker holds: the queue claims nothing while paused
    await kit.send({ fields: { text: "waits" } });
    await kit.tick(5 * SEC);
    assert.equal(kit.sock.sent.length, 0);
  });

  test("the same refusal delivered twice counts once (0 rows the second time), a code other than 463 never counts", async () => {
    const rows = [await row(), await row(), await row()];
    const nack = (r, code = "463") => update(r.waId, 0, { messageStubParameters: [code] });
    await dispatch(nack(rows[0]), nack(rows[0]), nack(rows[0]));
    await dispatch(nack(rows[1]), nack(rows[1]));
    assert.equal((await kit.messaging.stats()).pausedUntil, null, "two distinct messages only");
    await dispatch(nack(rows[2], "479"));
    assert.equal((await kit.messaging.stats()).pausedUntil, null);
  });

  test("a refusal of a message that is not ours (0 rows) does not feed the breaker", async () => {
    for (let i = 0; i < 4; i += 1) await dispatch(update(`3EB0FOREIGN${i}`, 0, { messageStubParameters: ["463"] }));
    assert.equal((await kit.messaging.stats()).pausedUntil, null);
  });
});

describe("the listener (8, RT-90, FR-001)", () => {
  test("exactly one listener while the switch is on; disable() and stop() remove it and updates stop applying", async () => {
    assert.equal(kit.client.listenerCount("messages.update"), 1);
    const r = await row();
    await kit.messaging.disable();
    assert.equal(kit.client.listenerCount("messages.update"), 0);
    await dispatch(update(r.waId, 3));
    assert.equal((await fresh(r)).status, "sent", "no handler");

    kit.setEnabled(true);
    assert.equal(kit.client.listenerCount("messages.update"), 1, "back on with the switch");
    await dispatch(update(r.waId, 3));
    assert.equal((await fresh(r)).status, "delivered");
    await kit.messaging.stop();
    assert.equal(kit.client.listenerCount("messages.update"), 0);
  });

  test("a switch that is off at start never attaches it", async () => {
    await kit.close();
    kit = await createEngineKit({ enabled: false });
    key = await kit.key();
    await kit.start();
    assert.equal(kit.client.listenerCount("messages.update"), 0);
  });

  test("the handler never throws: odd payloads and a failing database are swallowed", async () => {
    const calls = [];
    const handler = createReceiptHandler({
      models: {
        ApiMessage: {
          update: async () => {
            calls.push(1);
            throw new Error("database is locked");
          },
        },
        DATABASE: { fn: () => null, col: () => null },
      },
      clock: () => kit.now(),
      onRestricted: () => calls.push("restricted"),
    });
    for (const bad of [null, undefined, "x", 7, {}, [null], [undefined], [{}], [{ key: null }], [{ key: {}, update: null }], [{ key: { fromMe: true }, update: { status: 3 } }]]) {
      await assert.doesNotReject(async () => handler.handle(bad), JSON.stringify(bad));
    }
    await assert.doesNotReject(async () => handler.handle([update("3EB0X", 3), update("3EB0Y", 0, { messageStubParameters: ["463"] })]));
    assert.ok(calls.length >= 2, "the database was asked and failed without a throw");
    assert.ok(!calls.includes("restricted"), "a nack whose update failed is not counted");
  });

  test("it never reads the content and logs nothing above debug per event", async () => {
    const lines = [];
    logger.setLevel("info");
    logger.setOutput((text) => lines.push(String(text)));
    try {
      const r = await row();
      await dispatch(
        { key: { remoteJid: PN, fromMe: true, id: r.waId }, update: { status: 3, message: { conversation: "CANARY-RECEIPT-TEXT" }, messageTimestamp: 1_800_000_000 } },
        update("3EB0UNKNOWNID", 0, { messageStubParameters: ["463"] }),
        update("3EB0UNKNOWNID2", 4),
      );
    } finally {
      logger.setOutput();
      logger.setLevel("silent");
    }
    assert.deepEqual(lines, []);
  });
});

test("receipts.js is a leaf of the engine: no lib/api, no lib/admin, no timer at load", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "messaging", "receipts.js"), "utf8");
  assert.doesNotMatch(source, /require\([^)]*(lib\/api|\.\.\/api|lib\/admin|\.\.\/admin)/);
  assert.doesNotMatch(source, /setInterval|setTimeout/);
});
