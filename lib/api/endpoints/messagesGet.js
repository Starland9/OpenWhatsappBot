"use strict";

/**
 * PUB-2 `GET /api/v1/messages/:id`: the status of one message (feature 004, contracts/public-api.md section 2.2).
 *
 * The message of another key, a message of the panel, an unknown id and one purged by the retention job are the same
 * `404 not_found` (US3.4): the engine's `get` is scoped by the key in its WHERE clause and answers null for all of
 * them. There is no `wait` here (the wait lives on PUB-1) and no body.
 */

const { reply } = require("../../admin/http/response");
const { ApiError } = require("../errors");
const { presentMessage } = require("../present");

module.exports = {
  id: "messages.get",
  method: "GET",
  path: "/api/v1/messages/:id",
  params: { id: /^msg_[A-Za-z0-9_-]{22}$/ },

  right: "messages.read",

  response: {
    status: 200,
    openapi: { type: "object", required: ["message"], additionalProperties: false, properties: { message: { $ref: "#/components/schemas/Message" } } },
  },

  doc: {
    summary: "Status of one message",
    description: "Returns the message with every step reached, the failure code if any and, for polls, buttons and lists, the responses collected so far.",
    tags: ["messages"],
  },

  async handle(ctx) {
    const view = await ctx.services.messaging.get({ apiKeyId: ctx.key.id, publicId: ctx.params.id });
    if (!view) throw new ApiError("not_found");
    return reply(200, { message: presentMessage(view, { withResponses: true }) });
  },
};
