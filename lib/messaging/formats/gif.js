"use strict";

/**
 * Format `gif` (feature 004, contracts/runtime.md section 3.6, public-api.md 3.3): WhatsApp plays an MP4 with
 * `gifPlayback`, not a raw .gif. A GIF input is converted to a looping MP4 before the send (`prepare`, still queued,
 * so a failure is `media_conversion_failed` and nothing left); an MP4 or MOV input is sent as it is.
 */

const fsp = require("node:fs/promises");
const { LIMITS } = require("../limits");

// the exact conversion of section 3.6 (-i <source> first, <prepared.mp4> last)
const GIF_TO_MP4 = [
  "-movflags",
  "+faststart",
  "-pix_fmt",
  "yuv420p",
  "-vf",
  "scale=trunc(iw/2)*2:trunc(ih/2)*2",
  "-an",
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "28",
];

module.exports = {
  name: "gif",
  order: 40,
  interactive: false,

  fields: {
    caption: { type: "string", minLength: 1, maxLength: LIMITS.CAPTION, trim: true },
  },
  media: { kinds: ["animated", "video"], maxBytes: LIMITS.MEDIA_MAX.gif, required: true, sources: ["file", "url"] },

  /** @returns {Promise<{ path: string, mime: string, ext: string }|null>} null: the input is already an MP4/MOV */
  async prepare(ctx) {
    const { media, dir } = ctx;
    if (media.mime !== "image/gif") return null;
    const stage = require("../stage");
    const output = stage.preparedFile(dir, "mp4");
    const { runFfmpeg } = ctx.ffmpeg || require("../../utils/ffmpeg");
    await runFfmpeg(["-i", media.path, ...GIF_TO_MP4, output]);
    const { size } = await fsp.stat(output);
    if (size === 0 || size > LIMITS.MEDIA_MAX.gif) throw new Error("the converted GIF is empty or too large");
    return { path: output, mime: "video/mp4", ext: "mp4" };
  },

  build(ctx) {
    const { input, media, prepared } = ctx;
    const url = require("../stage").assertStaged(prepared ? prepared.path : media.path, ctx.dir);
    return { content: { video: { url }, gifPlayback: true, ...(input.caption ? { caption: input.caption } : {}), mimetype: "video/mp4" } };
  },

  doc: {
    summary: "Send an animated GIF",
    description: "Sends a GIF, MP4 or MOV (up to 16 MB) as a looping animation. A GIF is converted to MP4 first.",
    examples: [{ format: "gif", to: "237690000001", caption: "Done!" }],
  },
};
