"use strict";

/**
 * Format `voice` (feature 004, contracts/runtime.md section 3.6, public-api.md 3.3): any audio file, WebM or MP4
 * (the audio track is extracted) converted to Ogg/Opus and sent as a voice note. The waveform is flat, exactly like
 * `Message#sendVoice`. A conversion that fails is `media_conversion_failed`, before the message is claimed.
 */

const fsp = require("node:fs/promises");
const { LIMITS } = require("../limits");

module.exports = {
  name: "voice",
  order: 60,
  interactive: false,

  fields: {},
  media: { kinds: ["audio_or_container"], maxBytes: LIMITS.MEDIA_MAX.voice, required: true, sources: ["file", "url"] },

  /** @returns {Promise<{ path: string, mime: string, ext: string }>} prepared.ogg inside the stage directory */
  async prepare(ctx) {
    const { media, dir } = ctx;
    const output = require("../stage").preparedFile(dir, "ogg");
    const { toOpusVoice } = ctx.ffmpeg || require("../../utils/ffmpeg");
    const ogg = await toOpusVoice(await fsp.readFile(media.path));
    if (!ogg || ogg.length === 0) throw new Error("the voice note is empty");
    await fsp.writeFile(output, ogg, { mode: 0o600 });
    return { path: output, mime: "audio/ogg; codecs=opus", ext: "ogg" };
  },

  build(ctx) {
    if (!ctx.prepared) throw Object.assign(new Error("the voice note was not prepared"), { code: "media_conversion_failed" });
    const url = require("../stage").assertStaged(ctx.prepared.path, ctx.dir);
    return { content: { audio: { url }, mimetype: "audio/ogg; codecs=opus", ptt: true } };
  },

  doc: {
    summary: "Send a voice note",
    description: "Sends any audio file (or a WebM/MP4 with an audio track, up to 16 MB) as a voice note, converted to Ogg/Opus.",
    examples: [{ format: "voice", to: "237690000001" }],
  },
};
