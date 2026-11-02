"use strict";

/**
 * Format `sticker` (feature 004, contracts/runtime.md section 3.6, public-api.md 3.3): a JPEG, PNG or WebP converted
 * to a 512 x 512 WebP sticker carrying the bot's pack and author, at most 900 KiB. A picture that cannot be converted
 * (no quality fits, a corrupt image) is `media_conversion_failed`, before the message is claimed.
 */

const fsp = require("node:fs/promises");
const { LIMITS } = require("../limits");

module.exports = {
  name: "sticker",
  order: 80,
  interactive: false,

  fields: {},
  media: { kinds: ["image"], maxBytes: LIMITS.MEDIA_MAX.sticker, required: true, sources: ["file", "url"] },

  /** @returns {Promise<{ path: string, mime: string, ext: string }>} prepared.webp inside the stage directory */
  async prepare(ctx) {
    const { media, dir } = ctx;
    const output = require("../stage").preparedFile(dir, "webp");
    // sharp and node-webpmux are heavy: loaded here, when a sticker is prepared (RT-04)
    const { imageToWebp, withStickerExif } = ctx.stickerMaker || require("../../utils/stickerMaker");
    const webp = await imageToWebp(await fsp.readFile(media.path));
    if (!webp) throw new Error("no quality makes the sticker fit");
    const sticker = await withStickerExif(webp);
    if (sticker.length > LIMITS.STICKER_OUT) throw new Error("the sticker is too large");
    await fsp.writeFile(output, sticker, { mode: 0o600 });
    return { path: output, mime: "image/webp", ext: "webp" };
  },

  build(ctx) {
    if (!ctx.prepared) throw Object.assign(new Error("the sticker was not prepared"), { code: "media_conversion_failed" });
    const url = require("../stage").assertStaged(ctx.prepared.path, ctx.dir);
    return { content: { sticker: { url } } };
  },

  doc: {
    summary: "Send a sticker",
    description: "Sends a JPEG, PNG or WebP picture (up to 10 MB) as a 512 x 512 sticker with the bot's pack and author.",
    examples: [{ format: "sticker", to: "237690000001" }],
  },
};
