const { extractMessageContent } = require("baileys");
const { getLang } = require("../lib/utils/language");
const { StickerCommand } = require("../lib/database");
const settingsCache = require("../lib/utils/settingsCache");
const { STICKER_CMDS_KEY } = require("../lib/core/pipeline");
const config = require("../config");

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
 * Delete command from a sticker
 */
module.exports = {
  command: {
    pattern: "delcmd",
    desc: getLang("plugins.delcmd.desc"),
    type: "utility",
    fromMe: true,
  },

  async execute(message) {
    // The command must be run in reply to a sticker
    const { isSticker, hash } = quotedStickerHash(message);
    if (!isSticker) {
      return await message.reply(getLang("plugins.delcmd.usage", config.PREFIX));
    }
    if (!hash) {
      return await message.reply(getLang("plugins.delcmd.cannot_identify"));
    }

    // Remove from the database
    const deleted = await StickerCommand.destroy({ where: { stickerHash: hash } });

    // The pipeline reads sticker commands through the cache
    settingsCache.invalidate(STICKER_CMDS_KEY);

    if (deleted === 0) {
      return await message.reply(getLang("plugins.delcmd.none"));
    }

    return await message.reply(getLang("plugins.delcmd.deleted"));
  },
};
