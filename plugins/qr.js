const QRCode = require("qrcode");
const config = require("../config");
const { getLang } = require("../lib/utils/language");
const { safeLog } = require("../lib/utils/http");

// A QR code at level M holds about 2300 bytes: stay well below, even for
// text made of multi-byte characters
const MAX_CHARS = 1000;
const MAX_BYTES = 2000;
const CAPTION_MAX_CHARS = 200;

function truncate(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/**
 * QR Code command - Generate QR codes
 */
module.exports = {
  command: {
    pattern: "qr",
    desc: getLang("plugins.qr.desc"),
    type: "utility",
  },

  async execute(message, args, ctx) {
    // rawArgs keeps the line breaks (vCard, Wi-Fi payloads)
    const text = (
      String(ctx?.rawArgs ?? args ?? "").trim() || message.getQuotedText()
    ).trim();

    if (!text) {
      return await message.reply(
        `${getLang("common.usage_prefix")}\n${getLang("plugins.qr.usage", config.PREFIX, MAX_CHARS)}`,
      );
    }
    if (
      Array.from(text).length > MAX_CHARS ||
      Buffer.byteLength(text, "utf8") > MAX_BYTES
    ) {
      return await message.reply(getLang("plugins.qr.too_long", MAX_CHARS));
    }

    await message.react("⏳");

    try {
      const qrBuffer = await QRCode.toBuffer(text, {
        errorCorrectionLevel: "M",
        type: "png",
        width: 512,
        margin: 2,
      });

      await message.sendImage(
        qrBuffer,
        getLang("plugins.qr.caption", truncate(text, CAPTION_MAX_CHARS)),
      );
      await message.react("✅");
    } catch (error) {
      console.error("QR code error:", safeLog(error));
      await message.react("❌");
      await message.reply(getLang("plugins.qr.error"));
    }
  },
};
