"use strict";

/**
 * Image to sticker conversion, moved unchanged out of plugins/sticker.js (feature 004, contracts/runtime.md
 * section 14.4) so the messaging engine's `sticker` format can build a sticker without loading a plugin:
 *
 *   imageToWebp(buffer)        photo to a 512x512 WebP (transparent padding), re-encoded with a lower quality until
 *                              it fits MAX_STICKER_BYTES; resolves null when no attempt fits, rejects on a bad image
 *   buildExif(pack, author)    the EXIF block that makes WhatsApp show the pack name and the author
 *   withStickerExif(buffer)    that block added to a WebP; STICKER_PACKNAME and STICKER_AUTHOR are read at call time
 *
 * `videoToWebp` stays in plugins/sticker.js and imports the constants. `sharp` and `node-webpmux` are heavy and are
 * required inside the functions that need them (RT-04, SC-011), so requiring this module loads neither.
 */

const crypto = require("crypto");
const config = require("../../config");

const STICKER_SIZE = 512;
// WhatsApp refuses (or silently drops) heavy stickers: stay under this size
const MAX_STICKER_BYTES = 900 * 1024;

// At most 3 encodes, each lighter than the previous one
const IMAGE_QUALITIES = [80, 60, 40];

// TIFF header WhatsApp expects in front of the sticker metadata JSON (22 bytes)
const EXIF_HEADER = Buffer.from([
  0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
]);

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
  const webp = require("node-webpmux");
  const image = new webp.Image();
  await image.load(buffer);
  image.exif = buildExif(
    String(config.STICKER_PACKNAME || ""),
    String(config.STICKER_AUTHOR || ""),
  );
  return await image.save(null);
}

module.exports = {
  STICKER_SIZE,
  MAX_STICKER_BYTES,
  IMAGE_QUALITIES,
  EXIF_HEADER,
  imageToWebp,
  buildExif,
  withStickerExif,
};
