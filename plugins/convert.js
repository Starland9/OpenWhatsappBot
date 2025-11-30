const { getLang } = require("../lib/utils/language");
const { convertImage, resizeImage } = require("../lib/utils/media");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const sharp = require("sharp");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs").promises;
const path = require("path");
const PDFDocument = require("pdfkit");

const execAsync = promisify(exec);

/**
 * File Converter Plugin - Convert files between formats
 */
module.exports = {
  command: {
    pattern: "convert|topng|tojpg|topdf|tomp3",
    desc: getLang("plugins.convert.desc"),
    type: "media",
  },

  async execute(message, query) {
    const command = message.body
      .split(" ")[0]
      .replace(require("../config").PREFIX, "")
      .toLowerCase();

    try {
      // Determine target format from command
      let targetFormat = query?.toLowerCase().trim() || "";

      if (command === "topng") targetFormat = "png";
      else if (command === "tojpg") targetFormat = "jpg";
      else if (command === "topdf") targetFormat = "pdf";
      else if (command === "tomp3") targetFormat = "mp3";

      if (!targetFormat) {
        return await message.reply(getLang("plugins.convert.usage"));
      }

      // Check for media
      let buffer;
      let mediaType;

      if (message.quoted && message.quoted.message) {
        const quotedMsg = message.quoted.message;
        const quotedType = Object.keys(quotedMsg)[0];

        if (
          ![
            "imageMessage",
            "videoMessage",
            "audioMessage",
            "documentMessage",
          ].includes(quotedType)
        ) {
          return await message.reply(getLang("plugins.convert.reply_media"));
        }

        buffer = await downloadMediaMessage(
          message.quoted,
          "buffer",
          {},
          {
            logger: { info() {}, error() {}, warn() {} },
            reuploadRequest: message.client.getSocket().updateMediaMessage,
          }
        );

        mediaType = quotedType.replace("Message", "");
      } else if (message.hasMedia) {
        buffer = await message.downloadMedia();
        mediaType = message.getMediaType();
      } else {
        return await message.reply(getLang("plugins.convert.reply_media"));
      }

      if (!buffer) {
        return await message.reply(
          `❌ ${getLang("plugins.convert.download_failed")}`
        );
      }

      await message.react("⏳");

      let convertedBuffer;
      let fileName;
      let caption;

      // Image conversions
      if (
        mediaType === "image" &&
        ["png", "jpg", "jpeg", "webp"].includes(targetFormat)
      ) {
        convertedBuffer = await convertImage(buffer, targetFormat);
        fileName = `converted.${targetFormat}`;
        caption = `✅ ${getLang(
          "plugins.convert.success"
        )} → ${targetFormat.toUpperCase()}`;

        await message.react("✅");
        await message.sendImage(convertedBuffer, caption);
        return;
      }

      // Image to PDF
      if (mediaType === "image" && targetFormat === "pdf") {
        const tempPdf = path.join("/tmp", `converted_${Date.now()}.pdf`);

        try {
          const metadata = await sharp(buffer).metadata();
          const doc = new PDFDocument({
            size: [metadata.width, metadata.height],
          });
          const stream = require("fs").createWriteStream(tempPdf);

          doc.pipe(stream);
          doc.image(buffer, 0, 0, {
            width: metadata.width,
            height: metadata.height,
          });
          doc.end();

          await new Promise((resolve, reject) => {
            stream.on("finish", resolve);
            stream.on("error", reject);
          });

          convertedBuffer = await fs.readFile(tempPdf);

          await message.react("✅");
          await message.sendDocument(convertedBuffer, {
            fileName: "converted.pdf",
            mimetype: "application/pdf",
            caption: `✅ ${getLang("plugins.convert.success")} → PDF`,
          });
        } finally {
          await fs.unlink(tempPdf).catch(() => {});
        }
        return;
      }

      // Video to MP3
      if (mediaType === "video" && targetFormat === "mp3") {
        const tempInput = path.join("/tmp", `video_${Date.now()}.mp4`);
        const tempOutput = path.join("/tmp", `audio_${Date.now()}.mp3`);

        try {
          await fs.writeFile(tempInput, buffer);

          await execAsync(
            `ffmpeg -i ${tempInput} -vn -acodec libmp3lame -q:a 2 ${tempOutput}`
          );

          convertedBuffer = await fs.readFile(tempOutput);

          await message.react("✅");
          await message.sendAudio(convertedBuffer, {
            caption: `✅ ${getLang("plugins.convert.success")} → MP3`,
          });
        } finally {
          await fs.unlink(tempInput).catch(() => {});
          await fs.unlink(tempOutput).catch(() => {});
        }
        return;
      }

      // Audio format conversion
      if (
        mediaType === "audio" &&
        ["mp3", "ogg", "m4a"].includes(targetFormat)
      ) {
        const tempInput = path.join("/tmp", `audio_in_${Date.now()}.tmp`);
        const tempOutput = path.join(
          "/tmp",
          `audio_out_${Date.now()}.${targetFormat}`
        );

        try {
          await fs.writeFile(tempInput, buffer);

          const codecMap = {
            mp3: "libmp3lame",
            ogg: "libvorbis",
            m4a: "aac",
          };

          await execAsync(
            `ffmpeg -i ${tempInput} -acodec ${codecMap[targetFormat]} ${tempOutput}`
          );

          convertedBuffer = await fs.readFile(tempOutput);

          await message.react("✅");
          await message.sendAudio(convertedBuffer, {
            caption: `✅ ${getLang(
              "plugins.convert.success"
            )} → ${targetFormat.toUpperCase()}`,
          });
        } finally {
          await fs.unlink(tempInput).catch(() => {});
          await fs.unlink(tempOutput).catch(() => {});
        }
        return;
      }

      // Unsupported conversion
      await message.react("❌");
      await message.reply(getLang("plugins.convert.unsupported"));
    } catch (error) {
      await message.react("❌");
      console.error("Convert error:", error);
      await message.reply(
        `❌ ${getLang("plugins.convert.error")}: ${error.message}`
      );
    }
  },
};
