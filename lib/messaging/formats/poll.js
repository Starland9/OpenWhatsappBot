"use strict";

/**
 * Format `poll` (feature 004, contracts/runtime.md sections 3.2, 3.6 and 7.3, public-api.md 3.7): a question with 2 to
 * 12 distinct options. Votes are captured (interactive): the 32-byte `messageSecret` is generated here and handed to
 * the engine (`secret`), which stores it encrypted; it is what lets the votes be decrypted later. The options are kept
 * as SHA-256 digests (`replyData.hashes`) because that is all a vote carries.
 *
 * A single-choice poll has `selectableCount: 1` (a V3 poll); a multiple one `values.length` (V1). `0` would pass
 * Baileys' check but means "device default" to WhatsApp, and `toAnnouncementGroup` is never set.
 */

const crypto = require("node:crypto");
const { LIMITS } = require("../limits");

const digest = (option) => crypto.createHash("sha256").update(Buffer.from(option, "utf8")).digest("hex");

module.exports = {
  name: "poll",
  order: 110,
  interactive: true,

  fields: {
    question: { type: "string", required: true, minLength: 1, maxLength: LIMITS.POLL_QUESTION, trim: true },
    // `unique` reports a repeat as `options.N = duplicate`, comparing the trimmed value (case-sensitive)
    options: {
      type: "array",
      required: true,
      min: LIMITS.POLL_OPTIONS_MIN,
      max: LIMITS.POLL_OPTIONS_MAX,
      unique: true,
      items: { type: "string", minLength: 1, maxLength: LIMITS.POLL_OPTION, trim: true },
    },
    multiple: { type: "boolean", default: false },
  },

  size(input) {
    return Buffer.byteLength(input.question, "utf8");
  },

  build(ctx) {
    const { input } = ctx;
    const randomBytes = ctx.randomBytes || crypto.randomBytes;
    const values = input.options.slice();
    const multiple = input.multiple === true;
    const secret = randomBytes(32);
    return {
      content: {
        poll: {
          name: input.question,
          values,
          selectableCount: multiple ? values.length : 1,
          messageSecret: secret,
        },
      },
      choices: values.map((label, index) => ({ id: String(index), label })),
      replyData: { v: 1, multi: multiple, hashes: values.map(digest) },
      secret,
    };
  },

  /** A vote: the digests it carries mapped to option indexes (unknown ones dropped, option order, maybe empty) */
  interpretReply({ row, event }) {
    if (!event || event.type !== "vote" || !Array.isArray(event.digests)) return null;
    const hashes = row && row.replyData && Array.isArray(row.replyData.hashes) ? row.replyData.hashes : null;
    if (!hashes) return null;
    const voted = new Set(event.digests.map((value) => String(value).toLowerCase()));
    const choiceIds = [];
    hashes.forEach((hash, index) => {
      if (voted.has(hash)) choiceIds.push(String(index));
    });
    return { choiceIds };
  },

  doc: {
    summary: "Send a poll",
    description: "Sends a poll with 2 to 12 distinct options. Votes are captured and returned in the message's responses.",
    examples: [{ format: "poll", to: "120363025246125486@g.us", question: "Which day for training?", options: ["Tuesday", "Thursday", "Saturday"], multiple: false }],
  },
};
