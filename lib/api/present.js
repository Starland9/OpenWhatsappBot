"use strict";

/**
 * The public message resource (feature 004, contracts/public-api.md section 4.1, data-model.md section 9).
 *
 *   presentMessage(view, { withResponses })   a MessageView of the engine (`outbox.viewOf`, `messaging.get/list`) as the
 *                                             object a caller sees, from an EXPLICIT field list: never `row.get()`, never
 *                                             `toJSON()`, so a column added to the table cannot reach the wire by accident.
 *   locationOf(id)                            `/api/v1/messages/<id>`, the relative `Location` of a created message
 *
 * `responses` is part of the resource only where the contract says so (PUB-1 and PUB-2: `withResponses: true`; the
 * items of PUB-3 omit the key). The facade built it with its own `describeResponses`; here it is copied through an
 * explicit shape, so nothing else of a stored response (a source id, a voter key) can leave the process.
 * Content is never part of the resource: no text, caption, file name, question, option or URL, no recipient other than
 * the normalised `to` the caller itself sent, no WhatsApp id, no payload.
 */

const { BASE_PATH } = require("./version");

const FAILURE_STATUSES = new Set(["failed", "cancelled", "unknown"]);

const iso = (value) => (value ? new Date(value).toISOString() : null);

/** The digits of a person, the group id as is */
function toOf(recipient) {
  const text = String(recipient === undefined || recipient === null ? "" : recipient);
  return text.endsWith("@g.us") ? text : text.split("@")[0];
}

/** The `responses` object of 4.4 through an explicit shape, or null */
function presentResponses(responses) {
  if (!responses || typeof responses !== "object") return null;
  const items = Array.isArray(responses.items) ? responses.items : [];
  return {
    until: iso(responses.until),
    total: items.length,
    items: items.map((item) => ({
      at: iso(item.at),
      author: String(item.author),
      kind: item.kind === "vote" ? "vote" : "choice",
      via: item.via === "tap" || item.via === "number" ? item.via : null,
      choices: (Array.isArray(item.choices) ? item.choices : []).map((choice) => ({ id: String(choice.id), label: String(choice.label === null || choice.label === undefined ? "" : choice.label) })),
    })),
    totals: Array.isArray(responses.totals)
      ? responses.totals.map((entry) => ({ id: String(entry.id), label: String(entry.label === null || entry.label === undefined ? "" : entry.label), count: Number(entry.count) || 0 }))
      : null,
  };
}

/**
 * @param {object} view  a MessageView
 * @param {{ withResponses?: boolean }} [options]
 */
function presentMessage(view, { withResponses = false } = {}) {
  const status = view.status;
  const out = {
    id: view.publicId,
    format: view.format,
    to: toOf(view.recipient),
    chatType: String(view.recipient).endsWith("@g.us") ? "group" : "private",
    status,
    size: Number.isFinite(view.size) ? view.size : null,
    requestId: view.requestId || "",
    steps: {
      queued: iso(view.acceptedAt),
      sending: iso(view.sendingAt),
      sent: iso(view.sentAt),
      delivered: iso(view.deliveredAt),
      read: iso(view.readAt),
    },
    expiresAt: iso(view.expiresAt),
    endedAt: iso(view.endedAt),
    failure: FAILURE_STATUSES.has(status) && view.errorCode ? { code: String(view.errorCode) } : null,
  };
  if (withResponses) out.responses = view.interactive ? presentResponses(view.responses) : null;
  return out;
}

const locationOf = (publicId) => `${BASE_PATH}/messages/${publicId}`;

module.exports = { presentMessage, presentResponses, locationOf };
