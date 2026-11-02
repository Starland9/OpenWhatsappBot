"use strict";

/**
 * Format `video` (feature 004, contracts/runtime.md section 3.6, public-api.md 3.3): an MP4, MOV or 3GP video sent
 * as it is, with an optional caption.
 */

const { LIMITS } = require("../limits");

module.exports = {
  name: "video",
  order: 30,
  interactive: false,

  fields: {
    caption: { type: "string", minLength: 1, maxLength: LIMITS.CAPTION, trim: true },
  },
  media: { kinds: ["video"], maxBytes: LIMITS.MEDIA_MAX.video, required: true, sources: ["file", "url"] },

  build(ctx) {
    const { input, media } = ctx;
    const url = require("../stage").assertStaged(media.path, ctx.dir);
    return { content: { video: { url }, ...(input.caption ? { caption: input.caption } : {}), mimetype: media.mime } };
  },

  doc: {
    summary: "Send a video",
    description: "Sends an MP4, QuickTime or 3GP video (up to 16 MB) with an optional caption, as a file part or from a URL.",
    examples: [{ format: "video", to: "120363025246125486@g.us", caption: "Training session of Saturday" }],
  },
};
