const { getLang } = require("../lib/utils/language");
const sharp = require("sharp");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs").promises;
const path = require("path");
const config = require("../config");

const execAsync = promisify(exec);

/**
 * Sticker command - Create stickers from images/videos
 */
module.exports = {
  command: {
    pattern: "sticker|s",
    desc: getLang("plugins.sticker.desc"),
    type: "media",
  },

  async execute(message) {
    try {
      // Check for media
      let buffer;

      if (message.quoted && message.quoted.message) {
        // Get media from quoted message
        const quotedMsg = message.quoted.message;
        const quotedType = Object.keys(quotedMsg)[0];

        if (!["imageMessage", "videoMessage"].includes(quotedType)) {
          return await message.reply(getLang("plugins.sticker.reply_required"));
        }

        buffer = await message.client
          .getSocket()
          .downloadMediaMessage(message.quoted);
      } else if (message.hasMedia) {
        buffer = await message.downloadMedia();
      } else {
        return await message.reply(getLang("plugins.sticker.reply_required"));
      }

      if (!buffer) {
        return await message.reply("❌ Failed to download media");
      }

      // Process based on type
      let stickerBuffer;

      if (
        message.type === "videoMessage" ||
        (message.quoted && message.quoted.message?.videoMessage)
      ) {
        // Convert video to webp
        const tempInput = path.join("/tmp", `input_${Date.now()}.mp4`);
        const tempOutput = path.join("/tmp", `output_${Date.now()}.webp`);

        await fs.writeFile(tempInput, buffer);

        // Use ffmpeg to convert video to animated webp sticker
        await execAsync(
          `ffmpeg -i ${tempInput} -vcodec libwebp -vf "scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:-1:-1:color=white@0.0" -loop 0 -preset default -an -vsync 0 ${tempOutput}`
        );

        stickerBuffer = await fs.readFile(tempOutput);

        // Cleanup
        await fs.unlink(tempInput).catch(() => {});
        await fs.unlink(tempOutput).catch(() => {});
      } else {
        // Convert image to webp
        stickerBuffer = await sharp(buffer)
          .resize(512, 512, {
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .webp()
          .toBuffer();
      }

      // Send sticker
      await message.sendSticker(stickerBuffer, {
        packname: config.STICKER_PACKNAME,
        author: config.STICKER_AUTHOR,
      });
    } catch (error) {
      console.error("Sticker error:", error);
      await message.reply(`❌ Failed to create sticker: ${error.message}`);
    }
  },
};
