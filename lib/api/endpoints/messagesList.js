"use strict";

/**
 * PUB-3 `GET /api/v1/messages`: the messages of the calling key, newest first (feature 004, contracts/public-api.md
 * section 2.3). Keyset pagination: `next` is the id of the last item when more exist, passed back as `after`; the pages
 * stay stable while new messages arrive. Never the messages of another key or of the panel; the items carry no
 * `responses` (PUB-2 has them).
 *
 * The query is validated by the pipeline with the strict schema below (an unknown parameter is `unknown_field`, a repeated
 * one keeps its first value, an integer that is not decimal digits is `invalid_format`, outside its bounds
 * `out_of_range`); the facts a schema cannot hold (the timestamps, `until` after `since`, the registered formats) are
 * checked here, before the engine is asked anything. An `after` that is not a message of this key is the engine's
 * `fields.after = not_found`, the same answer for an unknown, a purged and another key's id.
 */

const { reply } = require("../../admin/http/response");
const { ApiError } = require("../errors");
const { presentMessage } = require("../present");
const { STATUSES } = require("../../messaging/errors");

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** Milliseconds of an RFC 3339 timestamp, or NaN (a date that does not exist is not one) */
function parseTimestamp(text) {
  const match = RFC3339.exec(text);
  if (!match) return NaN;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return NaN;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return NaN;
  // `2026-02-31T...` is rolled over by Date.parse in some engines: the calendar date must survive the round trip
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d ? ms : NaN;
}

module.exports = {
  id: "messages.list",
  method: "GET",
  path: "/api/v1/messages",

  right: "messages.read",

  query: {
    status: { type: "string", enum: [...STATUSES] },
    format: { type: "string", minLength: 1, maxLength: 24 },
    since: { type: "string", minLength: 1, maxLength: 40 },
    until: { type: "string", minLength: 1, maxLength: 40 },
    limit: { type: "int", min: 1, max: 100, default: 25 },
    after: { type: "string", minLength: 1, maxLength: 40 },
  },

  response: {
    status: 200,
    openapi: {
      type: "object",
      required: ["messages", "next"],
      additionalProperties: false,
      properties: {
        messages: { type: "array", items: { $ref: "#/components/schemas/Message" } },
        next: { type: ["string", "null"], pattern: "^msg_[A-Za-z0-9_-]{22}$" },
      },
    },
  },

  doc: {
    summary: "Own messages",
    description: "Lists the messages of the calling key, newest first, with optional filters on status, format and acceptance time. Pass `next` as `after` to continue.",
    tags: ["messages"],
  },

  async handle(ctx) {
    const query = ctx.query;
    const fault = {};
    if (query.format !== undefined) {
      const names = ctx.services.formats.list().map((row) => row.name);
      if (!names.includes(query.format)) fault.format = { code: "not_allowed", params: { allowed: names } };
    }
    const bounds = {};
    for (const name of ["since", "until"]) {
      if (query[name] === undefined) continue;
      const ms = parseTimestamp(query[name]);
      if (Number.isNaN(ms)) fault[name] = { code: "invalid_format" };
      else bounds[name] = ms;
    }
    if (!fault.since && !fault.until && bounds.since !== undefined && bounds.until !== undefined && bounds.until <= bounds.since) {
      fault.until = { code: "out_of_range" };
    }
    if (Object.keys(fault).length) throw new ApiError("validation_failed", { fields: fault });

    const page = await ctx.services.messaging.list({
      apiKeyId: ctx.key.id,
      status: query.status,
      format: query.format,
      since: bounds.since !== undefined ? new Date(bounds.since) : undefined,
      until: bounds.until !== undefined ? new Date(bounds.until) : undefined,
      limit: query.limit,
      after: query.after,
    });
    return reply(200, { messages: page.items.map((view) => presentMessage(view)), next: page.next });
  },
};
