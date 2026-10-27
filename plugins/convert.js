const fs = require("fs").promises;
const path = require("path");
const { extractMessageContent, getContentType } = require("baileys");
const PDFDocument = require("pdfkit");
const config = require("../config");
const { getLang } = require("../lib/utils/language");
const { convertImage, withTempDir } = require("../lib/utils/media");
const { runFfmpeg } = require("../lib/utils/ffmpeg");
const { classifyError, replyKeyFor, safeLog } = require("../lib/utils/http");

const MEDIA_TYPES = {
  imageMessage: "image",
  videoMessage: "video",
  audioMessage: "audio",
  documentMessage: "document",
  stickerMessage: "sticker",
};

// Shortcut aliases and the target format they stand for
const ALIAS_TARGETS = {
  topng: "png",
  tojpg: "jpg",
  topdf: "pdf",
  tomp3: "mp3",
};

const IMAGE_TARGETS = ["png", "jpg", "webp", "pdf"];
const AUDIO_TARGETS = ["mp3", "ogg", "m4a"];

const IMAGE_MIMES = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

// ogg is Opus in an Ogg container (what WhatsApp plays), not Vorbis
const AUDIO_CODEC_ARGS = {
  mp3: ["-c:a", "libmp3lame", "-q:a", "2"],
  ogg: ["-c:a", "libopus", "-b:a", "96k"],
  m4a: ["-c:a", "aac", "-b:a", "128k"],
};

// Biggest file converted, in MB (also bounded by MAX_UPLOAD)
const MAX_INPUT_MB = 50;
// Longest side of a PDF page, in points (A4 long edge)
const PDF_MAX_SIDE = 842;
// Longest side of the picture embedded in a PDF, in pixels
const PDF_MAX_PIXELS = 2480;

function toNumber(value) {
  if (value && typeof value.toNumber === "function") return value.toNumber();
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function maxInputBytes() {
  const limitMB = Math.min(MAX_INPUT_MB, Number(config.MAX_UPLOAD) || MAX_INPUT_MB);
  return limitMB * 1024 * 1024;
}

// Same shape as Message#getQuotedMedia errors: the registry replies common.media_too_large
function mediaTooLarge(maxBytes) {
  const error = new Error("MEDIA_TOO_LARGE");
  error.code = "MEDIA_TOO_LARGE";
  error.maxMB = Math.max(1, Math.round(maxBytes / (1024 * 1024)));
  return error;
}

/**
 * What the user pointed at, without downloading anything: the quoted media,
 * else the media sent with the command (caption). `null` when neither.
 * @returns {{ quoted: boolean, type: string|null, size: number }|null}
 */
function pickSource(message) {
  let quoted = null;
  if (message.quoted?.message) {
    const content = extractMessageContent(message.quoted.message);
    const key = getContentType(content);
    quoted = {
      quoted: true,
      type: MEDIA_TYPES[key] || null,
      size: toNumber(content?.[key]?.fileLength),
    };
    if (quoted.type) return quoted;
  }
  if (message.hasMedia) {
    return {
      quoted: false,
      type: MEDIA_TYPES[message.type] || null,
      size: toNumber(message.content?.[message.type]?.fileLength),
    };
  }
  return quoted;
}

async function downloadSource(message, source, maxBytes) {
  if (source.quoted) {
    const media = await message.getQuotedMedia({ maxBytes });
    return media?.buffer || null;
  }
  return await message.downloadMedia();
}

function normalizeTarget(word) {
  const target = String(word || "").toLowerCase();
  return target === "jpeg" ? "jpg" : target;
}

// image -> png/jpg/webp/pdf, audio and video (audio track) -> mp3/ogg/m4a
function canConvert(kind, target) {
  if (kind === "image") return IMAGE_TARGETS.includes(target);
  return AUDIO_TARGETS.includes(target);
}

/**
 * Picture to a one-page PDF (page size = picture size, scaled to A4 at most).
 * The picture goes through sharp first: pdfkit only reads jpeg and png, and
 * not every png (webp, gif, avif, interlaced png and 16-bit png would fail).
 * The PDF is built in memory.
 */
async function imageToPdf(buffer) {
  const sharp = require("sharp");
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({
      width: PDF_MAX_PIXELS,
      height: PDF_MAX_PIXELS,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer({ resolveWithObject: true });

  const scale = Math.min(1, PDF_MAX_SIDE / Math.max(info.width, info.height));
  const width = Math.max(1, Math.round(info.width * scale));
  const height = Math.max(1, Math.round(info.height * scale));

  const doc = new PDFDocument({ autoFirstPage: false });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.addPage({ size: [width, height], margin: 0 });
  doc.image(data, 0, 0, { width, height });
  doc.end();
  return done;
}

/**
 * Audio (or the audio track of a video) to mp3 / ogg (opus) / m4a.
 */
function convertToAudio(buffer, target) {
  return withTempDir(async (dir) => {
    const input = path.join(dir, "input");
    const output = path.join(dir, `output.${target}`);
    await fs.writeFile(input, buffer);
    await runFfmpeg(
      ["-i", input, "-vn", ...AUDIO_CODEC_ARGS[target], output],
      { timeout: 120000 },
    );
    return fs.readFile(output);
  });
}

// Lang key of the reply for a conversion that failed
function failureKey(error) {
  if (/does not contain any stream|matches no streams/i.test(error?.stderr || "")) {
    return "plugins.convert.no_audio";
  }
  const kind = classifyError(error);
  return kind === "error" ? "plugins.convert.error" : replyKeyFor(kind);
}

/**
 * File Converter Plugin - Convert images, audio and videos between formats
 */
module.exports = {
  command: {
    pattern: "convert|topng|tojpg|topdf|tomp3",
    desc: getLang("plugins.convert.desc"),
    type: "media",
  },

  async execute(message, args, ctx) {
    const target =
      ALIAS_TARGETS[ctx?.command] || normalizeTarget(String(args || "").split(" ")[0]);

    if (!target) {
      return await message.reply(
        `${getLang("common.usage_prefix")}\n${getLang("plugins.convert.usage", config.PREFIX)}`,
      );
    }
    if (!IMAGE_TARGETS.includes(target) && !AUDIO_TARGETS.includes(target)) {
      return await message.reply(getLang("plugins.convert.unknown_format", target));
    }

    // Validate the input before reacting or downloading anything
    const source = pickSource(message);
    if (!source?.type) {
      return await message.reply(getLang("plugins.convert.reply_media"));
    }
    if (source.type === "document") {
      return await message.reply(getLang("plugins.convert.document_unsupported"));
    }
    const kind = source.type === "sticker" ? "image" : source.type;
    if (!canConvert(kind, target)) {
      return await message.reply(getLang("plugins.convert.unsupported"));
    }

    const maxBytes = maxInputBytes();
    if (source.size > maxBytes) throw mediaTooLarge(maxBytes);

    const buffer = await downloadSource(message, source, maxBytes);
    if (!buffer) {
      return await message.reply(getLang("plugins.convert.download_failed"));
    }

    await message.react("⏳");

    try {
      if (kind === "image") {
        const converted =
          target === "pdf"
            ? await imageToPdf(buffer)
            : await convertImage(buffer, target);

        // As a document: sendImage would recompress the file and lose png / webp
        await message.sendDocument(converted, {
          fileName: `converted.${target}`,
          mimetype: target === "pdf" ? "application/pdf" : IMAGE_MIMES[target],
          caption: getLang("plugins.convert.success", target.toUpperCase()),
        });
      } else {
        const converted = await convertToAudio(buffer, target);
        // The mimetype is sniffed from the content (mp3, ogg/opus, m4a)
        await message.sendAudioFile(converted);
      }
      await message.react("✅");
    } catch (error) {
      if (error?.code === "MEDIA_TOO_LARGE") throw error;
      console.error("Convert error:", safeLog(error));
      await message.react("❌");
      await message.reply(getLang(failureKey(error)));
    }
  },
};
