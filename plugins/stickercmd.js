const { extractMessageContent } = require("baileys");
const { getLang } = require("../lib/utils/language");
const { StickerCommand } = require("../lib/database");
const settingsCache = require("../lib/utils/settingsCache");
const registry = require("../lib/plugins/registry");
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

/** "  .Ping  x" -> { name: "ping", text: "ping x" }, without the prefix */
function parseCommandText(query) {
  let text = String(query || "").trim();
  const prefix = config.PREFIX;
  while (prefix && text.startsWith(prefix)) text = text.slice(prefix.length).trim();

  const [first = "", ...rest] = text.split(/\s+/).filter(Boolean);
  const name = first.toLowerCase();
  return { name, text: [name, ...rest].join(" ") };
}

/**
 * Set command for a sticker
 */
module.exports = {
  command: {
    pattern: "setcmd",
    desc: getLang("plugins.stickercmd.desc"),
    type: "utility",
    fromMe: true,
  },

  async execute(message, query) {
    const prefix = config.PREFIX;

    // The command must be run in reply to a sticker
    const { isSticker, hash } = quotedStickerHash(message);
    if (!isSticker) {
      return await message.reply(getLang("plugins.stickercmd.reply_sticker", prefix));
    }

    const { name, text } = parseCommandText(query);
    if (!name) {
      return await message.reply(getLang("plugins.stickercmd.usage", prefix));
    }

    if (!hash) {
      return await message.reply(getLang("plugins.stickercmd.cannot_identify"));
    }

    // Only real commands: a typo would otherwise be bound silently
    if (!registry.getCommandByPattern(name)) {
      return await message.reply(getLang("plugins.stickercmd.unknown_command", name, prefix));
    }

    // Save in the database
    const [stickerCmd, created] = await StickerCommand.findOrCreate({
      where: { stickerHash: hash },
      defaults: {
        stickerHash: hash,
        command: text,
        createdBy: message.sender || message.senderLid || "",
      },
    });
    if (!created) await stickerCmd.update({ command: text });

    // The pipeline reads sticker commands through the cache
    settingsCache.invalidate(STICKER_CMDS_KEY);

    return await message.reply(
      getLang(created ? "plugins.stickercmd.assigned" : "plugins.stickercmd.updated", text),
    );
  },
};
