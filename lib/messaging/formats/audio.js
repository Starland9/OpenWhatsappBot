"use strict";

/**
 * Format `audio` (feature 004, contracts/runtime.md section 3.6, public-api.md 3.3): an audio file (MP3, Ogg, M4A,
 * WAV, FLAC, AAC, AMR; not WebM) sent as it is, as an audio file and not as a voice note.
 */

const { LIMITS } = require("../limits");

/** WhatsApp has no `audio/x-m4a`: the same container goes out as `audio/mp4` */
const mimetypeOf = (mime) => (mime === "audio/x-m4a" ? "audio/mp4" : mime);

module.exports = {
  name: "audio",
  order: 50,
  interactive: false,

  fields: {},
  media: { kinds: ["audio"], maxBytes: LIMITS.MEDIA_MAX.audio, required: true, sources: ["file", "url"] },

  build(ctx) {
    const { media } = ctx;
    const url = require("../stage").assertStaged(media.path, ctx.dir);
    return { content: { audio: { url }, mimetype: mimetypeOf(media.mime), ptt: false } };
  },

  doc: {
    summary: "Send an audio file",
    description: "Sends an MP3, Ogg, M4A, WAV, FLAC, AAC or AMR file (up to 16 MB) as an audio file.",
    examples: [{ format: "audio", to: "237690000001" }],
  },
};
