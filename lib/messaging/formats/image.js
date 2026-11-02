"use strict";

/**
 * Format `image` (feature 004, contracts/runtime.md section 3.6, public-api.md 3.3): a JPEG, PNG or WebP sent as it
 * is, with an optional caption. The type sent is the one detected from the bytes (RT-100); the staged path is the
 * only thing handed to Baileys (RT-101), never a caller string.
 */

const { LIMITS } = require("../limits");

module.exports = {
  name: "image",
  order: 20,
  interactive: false,

  fields: {
    caption: { type: "string", minLength: 1, maxLength: LIMITS.CAPTION, trim: true },
  },
  media: { kinds: ["image"], maxBytes: LIMITS.MEDIA_MAX.image, required: true, sources: ["file", "url"] },

  build(ctx) {
    const { input, media } = ctx;
    const url = require("../stage").assertStaged(media.path, ctx.dir);
    return { content: { image: { url }, ...(input.caption ? { caption: input.caption } : {}), mimetype: media.mime } };
  },

  doc: {
    summary: "Send an image",
    description: "Sends a JPEG, PNG or WebP image (up to 16 MB) with an optional caption, as a file part or from a URL.",
    examples: [{ format: "image", to: "237690000001", caption: "Your receipt" }],
  },
};
