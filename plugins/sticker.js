const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const { extractMessageContent, getContentType } = require("baileys");
const webp = require("node-webpmux");
const config = require("../config");
const { getLang } = require("../lib/utils/language");
const { withTempDir } = require("../lib/utils/media");
const { runFfmpeg } = require("../lib/utils/ffmpeg");
const { classifyError, replyKeyFor, safeLog } = require("../lib/utils/http");

const MEDIA_TYPES = {
  imageMessage: "image",
  videoMessage: "video",
  audioMessage: "audio",
  documentMessage: "document",
  stickerMessage: "sticker",
};

const STICKER_SIZE = 512;
// WhatsApp refuses (or silently drops) heavy stickers: stay under this size
const MAX_STICKER_BYTES = 900 * 1024;
const MAX_VIDEO_SECONDS = 10;
// Biggest source accepted, in MB (also bounded by MAX_UPLOAD)
const MAX_INPUT_MB = 25;

// At most 3 encodes, each lighter than the previous one
const IMAGE_QUALITIES = [80, 60, 40];
const VIDEO_PROFILES = [
  { fps: 15, quality: 50 },
  { fps: 12, quality: 35 },
  { fps: 8, quality: 20 },
];

// TIFF header WhatsApp expects in front of the sticker metadata JSON (22 bytes)
const EXIF_HEADER = Buffer.from([
  0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
]);

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

/**
 * Photo to a 512x512 webp (transparent padding), re-encoded with a lower
 * quality until it fits. Resolves null when no attempt fits.
 */
async function imageToWebp(buffer) {
  const sharp = require("sharp");
  for (const quality of IMAGE_QUALITIES) {
    const output = await sharp(buffer)
      .rotate()
      .resize(STICKER_SIZE, STICKER_SIZE, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality })
      .toBuffer();
    if (output.length <= MAX_STICKER_BYTES) return output;
  }
  return null;
}

/**
 * Short video to an animated 512x512 webp: the first 10 seconds only, then a
 * lower quality and frame rate until it fits. Resolves null when no attempt fits.
 */
function videoToWebp(buffer) {
  return withTempDir(async (dir) => {
    const input = path.join(dir, "input");
    const output = path.join(dir, "output.webp");
    await fs.writeFile(input, buffer);

    for (const { fps, quality } of VIDEO_PROFILES) {
      const filter = [
        `fps=${fps}`,
        `scale=${STICKER_SIZE}:${STICKER_SIZE}:force_original_aspect_ratio=decrease`,
        `pad=${STICKER_SIZE}:${STICKER_SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
        "format=yuva420p",
      ].join(",");

      await runFfmpeg(
        [
          "-t", String(MAX_VIDEO_SECONDS),
          "-i", input,
          "-vf", filter,
          "-c:v", "libwebp",
          "-loop", "0",
          "-preset", "default",
          "-an",
          "-lossless", "0",
          "-compression_level", "6",
          "-q:v", String(quality),
          output,
        ],
        { timeout: 60000 },
      );

      const result = await fs.readFile(output);
      if (result.length <= MAX_STICKER_BYTES) return result;
    }
    return null;
  });
}

/**
 * EXIF block that makes WhatsApp show the pack name and the author.
 * The pack id is derived from both, so every sticker of the bot is one pack.
 */
function buildExif(pack, author) {
  const packId = crypto
    .createHash("sha1")
    .update(`${pack}\u0000${author}`)
    .digest("hex");
  const json = Buffer.from(
    JSON.stringify({
      "sticker-pack-id": packId,
      "sticker-pack-name": pack,
      "sticker-pack-publisher": author,
      emojis: [],
    }),
    "utf8",
  );
  const exif = Buffer.concat([EXIF_HEADER, json]);
  exif.writeUInt32LE(json.length, 14);
  return exif;
}

async function withStickerExif(buffer) {
  const image = new webp.Image();
  await image.load(buffer);
  image.exif = buildExif(
    String(config.STICKER_PACKNAME || ""),
    String(config.STICKER_AUTHOR || ""),
  );
  return await image.save(null);
}

// Lang key of the reply for a sticker that could not be made
function failureKey(error) {
  const kind = classifyError(error);
  return kind === "error" ? "plugins.sticker.error" : replyKeyFor(kind);
}

/**
 * Sticker command - Create stickers from images/videos
 */
module.exports = {
  command: {
    pattern: "sticker",
    desc: getLang("plugins.sticker.desc"),
    type: "media",
  },

  async execute(message) {
    // Validate the input before reacting or downloading anything
    const source = pickSource(message);
    if (source?.type === "sticker") {
      return await message.reply(getLang("plugins.sticker.already_sticker"));
    }
    if (source?.type !== "image" && source?.type !== "video") {
      return await message.reply(
        getLang("plugins.sticker.reply_required", config.PREFIX),
      );
    }

    const maxBytes = maxInputBytes();
    if (source.size > maxBytes) throw mediaTooLarge(maxBytes);

    const buffer = await downloadSource(message, source, maxBytes);
    if (!buffer) {
      return await message.reply(getLang("plugins.sticker.download_failed"));
    }

    await message.react("⏳");

    try {
      const sticker =
        source.type === "video"
          ? await videoToWebp(buffer)
          : await imageToWebp(buffer);

      if (!sticker) {
        await message.react("❌");
        return await message.reply(getLang("plugins.sticker.too_big"));
      }

      let output = sticker;
      try {
        output = await withStickerExif(sticker);
      } catch (error) {
        // The sticker still works without its pack and author
        console.error("Sticker EXIF error:", safeLog(error));
      }

      await message.sendSticker(output);
      await message.react("✅");
    } catch (error) {
      if (error?.code === "MEDIA_TOO_LARGE") throw error;
      console.error("Sticker error:", safeLog(error));
      await message.react("❌");
      await message.reply(getLang(failureKey(error)));
    }
  },
};
