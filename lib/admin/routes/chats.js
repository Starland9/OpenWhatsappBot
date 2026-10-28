"use strict";

/**
 * Chat routes (admin-http-api.md section 2.9): the known-chat picker and the chats where the bot is disabled.
 *
 *   GET    /admin/api/chats?kind&q&page&pageSize&selectable   CHAT-1  { items, page, pageSize, total }
 *   GET    /admin/api/chats/disabled                          CHAT-2  { items: [{ jid, kind, name, since }] }
 *   DELETE /admin/api/chats/disabled/:jid                     CHAT-3  { enabled: true }, audit chat.enable, 404 when not disabled
 *
 * CHAT-1 is backed by `known_chats` and is the only source of broadcast destinations (a number can never be
 * typed in, FR-046). The logic is lib/admin/services/groups.js.
 */

/** A chat JID the bot may be disabled in: a group, a phone-number chat or a LID chat */
const CHAT_JID = /^\d{5,20}(?:-\d{1,20})?@(?:g\.us|s\.whatsapp\.net|lid)$/;

function register({ router, deps }) {
  const { groupsServiceOf } = require("../services/groups");
  const groups = () => groupsServiceOf(deps);

  router.route({
    method: "GET",
    path: "/admin/api/chats",
    auth: "session",
    query: {
      kind: { type: "string", enum: ["private", "group"] },
      q: { type: "string", maxLength: 100 },
      page: { type: "string", pattern: /^\d{1,6}$/ },
      pageSize: { type: "string", pattern: /^\d{1,4}$/ },
      selectable: { type: "string", enum: ["0", "1"] },
    },
    handler: (ctx) => groups().listChats(ctx.query),
  });

  router.route({
    method: "GET",
    path: "/admin/api/chats/disabled",
    auth: "session",
    handler: () => groups().listDisabledChats(),
  });

  router.route({
    method: "DELETE",
    path: "/admin/api/chats/disabled/:jid",
    auth: "session",
    params: { jid: CHAT_JID },
    handler: async (ctx) => {
      const result = await groups().enableChat(ctx.params.jid);
      await ctx.audit("chat.enable", ctx.params.jid, "ok");
      return result;
    },
  });
}

module.exports = { register };
