"use strict";

/**
 * Delivery, read and negative acknowledgements of the messages the API sent (feature 004, contracts/runtime.md
 * section 8, data-model.md 2.5 T9-T11). `createReceiptHandler({ models, clock, onRestricted })` returns
 * `{ handle(updates) }`; the outbox binds it to `client.on("messages.update")` while the switch is on and removes it
 * with `disable()` and `stop()` (RT-90: it exists only while the switch is on). `lib/baileys/client.js` already
 * re-emits every `messages.update`, so the client needs no change.
 *
 * Private chats only: Baileys emits `{ key, update: { status, messageTimestamp } }` for them (statuses of
 * `Utils/generics.js`: none = 3 delivery ack, `read` = 4, `played` = 5, 0 = error) and only a per-participant
 * `message-receipt.update` for groups, which is not consumed (a group message stops at `sent`).
 *
 * For each `{ key, update }` with `key.fromMe`, a numeric `update.status` and a non-group `remoteJid`, ONE conditional
 * UPDATE by the unique `waId` (no SELECT, no lock: the WhatsApp id is the only key used, because `remoteJid` may be a
 * LID):
 *
 *   3     status='delivered', deliveredAt=:t              WHERE waId AND status IN ('sent','unknown')
 *   4, 5  status='read', readAt=:t, deliveredAt=COALESCE(deliveredAt,:t)   WHERE ... IN ('sent','delivered','unknown')
 *   0     status='failed', errorCode='whatsapp_rejected', endedAt=:t, reply material erased    WHERE ... IN ('sent','unknown')
 *   1, 2  ignored
 *
 * The first two also clear `endedAt` and `errorCode`: a late receipt upgrades an `unknown` message (it proves the send;
 * it is never a resend) and is a no-op write for a `sent` one. A statement that changes 0 rows is a non-API id (the
 * bot's own replies get receipts too) or a status that does not move forward: nothing else happens. `:t` is
 * `update.messageTimestamp * 1000` when present, else the engine's clock. A negative ack whose first
 * `messageStubParameters` entry is a restriction code (`463`) that really failed one of our messages is reported to
 * `onRestricted` (the breaker of 4.6 counts distinct messages, so a redelivered refusal counts once).
 *
 * The handler never throws, never reads the message content (`update.message` is not looked at) and logs nothing
 * above `debug` per event. No timer, no query at `require`.
 */

const { LIMITS } = require("./limits");

const FORWARD_FROM_DELIVERED = ["sent", "unknown"];
const FORWARD_FROM_READ = ["sent", "delivered", "unknown"];

/** Seconds from a number, a numeric string or a Long-like object; NaN otherwise */
function secondsOf(value) {
  if (value === undefined || value === null) return NaN;
  if (typeof value === "object" && typeof value.toNumber === "function") return Number(value.toNumber());
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && !/^\d{1,13}$/.test(value)) return NaN;
  return Number(value);
}

function createReceiptHandler({ models, clock = () => Date.now(), onRestricted } = {}) {
  const M = () => (typeof models === "function" ? models() : models || require("../database"));
  let log = null;
  const logger = () => {
    if (!log) log = require("../utils/logger").createLogger("messaging");
    return log;
  };

  async function apply(item) {
    const key = item && item.key;
    const change = item && item.update;
    if (!key || key.fromMe !== true || typeof key.id !== "string" || !key.id) return;
    if (!change || !Number.isInteger(change.status)) return;
    if (typeof key.remoteJid === "string" && (key.remoteJid.endsWith("@g.us") || key.remoteJid.endsWith("@broadcast"))) return;

    const status = change.status;
    if (status !== 0 && status !== 3 && status !== 4 && status !== 5) return; // 1 and 2 (pending, server ack): nothing to record

    const seconds = secondsOf(change.messageTimestamp);
    const at = new Date(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : clock());
    const { ApiMessage, DATABASE } = M();
    let changed;
    if (status === 3) {
      [changed] = await ApiMessage.update(
        { status: "delivered", deliveredAt: at, endedAt: null, errorCode: null },
        { where: { waId: key.id, status: FORWARD_FROM_DELIVERED } },
      );
    } else if (status === 4 || status === 5) {
      [changed] = await ApiMessage.update(
        { status: "read", readAt: at, deliveredAt: DATABASE.fn("COALESCE", DATABASE.col("deliveredAt"), at), endedAt: null, errorCode: null },
        { where: { waId: key.id, status: FORWARD_FROM_READ } },
      );
    } else {
      [changed] = await ApiMessage.update(
        { status: "failed", errorCode: "whatsapp_rejected", endedAt: at, choices: null, replyData: null, pollSecret: null, repliesUntil: null },
        { where: { waId: key.id, status: FORWARD_FROM_DELIVERED } },
      );
      const params = change.messageStubParameters;
      const code = Array.isArray(params) && params.length ? String(params[0]) : "";
      if (changed > 0 && LIMITS.RESTRICTION_CODES.includes(code) && typeof onRestricted === "function") onRestricted(code, clock());
    }
    if (changed > 0) logger().debug({ waId: key.id, status }, "receipt applied");
  }

  /** @param {object[]} updates the array of a `messages.update` event; anything else is ignored */
  async function handle(updates) {
    if (!Array.isArray(updates)) return;
    for (const item of updates) {
      try {
        await apply(item);
      } catch (err) {
        try {
          logger().debug({ err: require("../utils/http").safeLog(err) }, "receipt not applied");
        } catch {
          // logging never matters here
        }
      }
    }
  }

  return { handle };
}

module.exports = { createReceiptHandler };
