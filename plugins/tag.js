const { getLang } = require("../lib/utils/language");
const { safeLog } = require("../lib/utils/http");
const {
  normalizeJid,
  jidUser,
  getBotJids,
} = require("../lib/utils/permissions");

// A group below this size gets a single message. Larger groups are split so
// that one message never carries an unreasonable number of mentions.
const CHUNK_SIZE = 800;
const CHUNK_DELAY_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tag command - Mention every member of the group in one message
 */
module.exports = {
  command: {
    pattern: "tagall",
    desc: getLang("plugins.tag.desc"),
    type: "group",
    adminOnly: true,
  },

  // rawArgs keeps the line breaks of a multi-line announcement
  async execute(message, argsString, ctx) {
    const metadata = await message.getGroupMetadata();
    if (!metadata) {
      return await message.reply(getLang("plugins.tag.no_metadata"));
    }

    // The same normalized id feeds the "@text" and the mentions array
    const sock = message.client.getSocket();
    const bot = getBotJids(sock);
    const members = [
      ...new Set(
        (metadata.participants || [])
          .map((p) => normalizeJid(p?.id))
          .filter((id) => id && id !== bot.pn && id !== bot.lid),
      ),
    ];
    if (!members.length) {
      return await message.reply(getLang("plugins.tag.no_members"));
    }

    const header =
      String(ctx?.rawArgs ?? argsString ?? "").trim() ||
      getLang("plugins.tag.default_header");

    const total = Math.ceil(members.length / CHUNK_SIZE);
    let sent = 0;
    for (let n = 0; n < total; n++) {
      const chunk = members.slice(n * CHUNK_SIZE, (n + 1) * CHUNK_SIZE);
      const mentionLine = chunk.map((id) => `@${jidUser(id)}`).join(" ");
      // Header only on the first message
      const text = n === 0 ? `${header}\n\n${mentionLine}` : mentionLine;

      if (n > 0) await sleep(CHUNK_DELAY_MS);
      try {
        await sock.sendMessage(message.jid, { text, mentions: chunk });
        sent++;
      } catch (err) {
        console.error("tagall: failed to send a message", safeLog(err));
      }
    }

    if (sent === 0) {
      return await message.reply(getLang("plugins.tag.failed"));
    }
    if (sent < total) {
      await message.reply(getLang("plugins.tag.partial", sent, total));
    }
  },
};
