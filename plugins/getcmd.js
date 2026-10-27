const { extractMessageContent } = require("baileys");
const { getLang } = require("../lib/utils/language");
const { StickerCommand } = require("../lib/database");
const config = require("../config");

// A WhatsApp message cannot hold an unbounded list
const MAX_LISTED = 30;

/**
 * Hex hash of the quoted sticker, as the pipeline computes it.
 * @returns {{ isSticker: boolean, hash: string|null }}
 */
function quotedStickerHash(message) {
  const content = extractMessageContent(message.quoted?.message);
  const sticker = content?.stickerMessage;
  if (!sticker) return { isSticker: false, hash: null };

  const sha = sticker.fileSha256;
  if (!sha || (typeof sha !== "string" && !sha.length)) {
    return { isSticker: true, hash: null };
  }
  const bytes = typeof sha === "string" ? Buffer.from(sha, "base64") : Buffer.from(sha);
  return { isSticker: true, hash: bytes.toString("hex") };
}

/**
 * Get command assigned to a sticker or list all sticker commands
 */
module.exports = {
  command: {
    pattern: "getcmd",
    desc: getLang("plugins.getcmd.desc"),
    type: "utility",
    fromMe: true,
  },

  async execute(message) {
    const prefix = config.PREFIX;

    // In reply to a sticker: show its command
    const { isSticker, hash } = quotedStickerHash(message);
    if (isSticker) {
      if (!hash) {
        return await message.reply(getLang("plugins.getcmd.cannot_identify"));
      }

      const stickerCmd = await StickerCommand.findOne({ where: { stickerHash: hash } });
      if (!stickerCmd) {
        return await message.reply(getLang("plugins.getcmd.none_for_sticker", prefix));
      }

      return await message.reply(getLang("plugins.getcmd.assigned", stickerCmd.command));
    }

    // Otherwise, list every sticker command (most recent first)
    const total = await StickerCommand.count();
    if (total === 0) {
      return await message.reply(getLang("plugins.getcmd.empty", prefix));
    }

    const rows = await StickerCommand.findAll({
      order: [["createdAt", "DESC"]],
      limit: MAX_LISTED,
    });

    const lines = rows.map((cmd, index) =>
      getLang("plugins.getcmd.item", index + 1, cmd.command, cmd.stickerHash.substring(0, 16)),
    );
    let response = `${getLang("plugins.getcmd.list_title", total)}\n\n${lines.join("\n\n")}`;
    if (total > rows.length) {
      response += `\n\n${getLang("plugins.getcmd.more", total - rows.length)}`;
    }
    response += `\n\n${getLang("plugins.getcmd.footer", prefix)}`;

    return await message.reply(response);
  },
};
