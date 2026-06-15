const QRCode = require("qrcode");

/**
 * QR Code command - Generate QR codes
 */
module.exports = {
  command: {
    pattern: "qr",
    desc: "Generate QR code from text",
    type: "utility",
  },

  async execute(message, text) {
    if (!text) {
      return await message.reply(
        "❌ Please provide text to encode\n\nExample: .qr Hello World"
      );
    }

    try {
      await message.react("⏳");

      // Generate QR code
      const qrBuffer = await QRCode.toBuffer(text, {
        errorCorrectionLevel: "H",
        type: "png",
        width: 512,
        margin: 2,
      });

      await message.sendImage(qrBuffer, `*QR Code*\n\n${text}`);
      await message.react("✅");
    } catch (error) {
      await message.react("❌");
      console.error("QR code error:", error);
      await message.reply(`❌ Error: ${error.message}`);
    }
  },
};
