"use strict";

/**
 * Format `text` (feature 004, contracts/runtime.md sections 3.2, 3.6 and 9; public-api.md 3.2).
 *
 * The text goes out verbatim, apart from the trimming every string gets: it is never interpreted as a command,
 * whatever its first characters (RT-70). Every content carries `linkPreview: null`: left to `undefined`, Baileys
 * would fetch the first `https://` link of any API text itself (X16). A preview exists only when the caller asked
 * for one (right `media.url`), is fetched at send time by `prepare` through the SSRF-safe fetcher, and never makes
 * the message fail.
 */

const { LIMITS } = require("../limits");
const { parsePhoneNumber } = require("../../utils/permissions");

const PREVIEW_BUDGET_MS = 5000;
const LINK = /https:\/\/[^\s<>"'`]+/i;

/** Trailing punctuation that belongs to the sentence, not to the link */
const trimLink = (link) => link.replace(/[.,;:!?)\]}'"]+$/, "");

module.exports = {
  name: "text",
  order: 10,
  interactive: false,

  fields: {
    text: { type: "string", required: true, minLength: 1, maxLength: LIMITS.TEXT, trim: true },
    mentions: {
      type: "array",
      max: LIMITS.MENTIONS_MAX,
      unique: true,
      items: { type: "string", minLength: 1, maxLength: 64, trim: true },
    },
    linkPreview: { type: "boolean", default: false },
  },

  /** `linkPreview: true` needs the right to fetch a URL; tolerant of any input (called before validation) */
  requires(input) {
    return input && typeof input === "object" && input.linkPreview === true ? ["media.url"] : [];
  },

  refine(input, ctx) {
    const faults = {};
    const mentions = Array.isArray(input.mentions) ? input.mentions : [];
    if (mentions.length === 0) return null;
    if (ctx && ctx.target && ctx.target.kind === "private") return { mentions: { code: "not_allowed" } };
    mentions.forEach((value, index) => {
      if (typeof value === "string" && parsePhoneNumber(value).error) faults[`mentions.${index}`] = { code: "invalid_format" };
    });
    return Object.keys(faults).length ? faults : null;
  },

  normalize(input) {
    if (!Array.isArray(input.mentions)) return input;
    const digits = [];
    for (const value of input.mentions) {
      const parsed = parsePhoneNumber(value);
      if (!parsed.error && !digits.includes(parsed.digits)) digits.push(parsed.digits);
    }
    return { ...input, mentions: digits };
  },

  size(input) {
    return Buffer.byteLength(input.text, "utf8");
  },

  /**
   * Link preview, only for `linkPreview: true`: the first `https://` link of the text through the guarded fetcher,
   * under a 5 s budget. No link, a refusal or any failure gives no preview and never fails the message.
   * @returns {Promise<{ preview: object }|null>}
   */
  async prepare(ctx) {
    if (!ctx || !ctx.input || ctx.input.linkPreview !== true) return null;
    const found = LINK.exec(ctx.input.text);
    if (!found) return null;
    const link = trimLink(found[0]);
    try {
      const fetcher = ctx.fetcher || require("../urlFetch");
      const signals = [AbortSignal.timeout(PREVIEW_BUDGET_MS)];
      if (ctx.signal) signals.push(ctx.signal);
      const preview = await fetcher.fetchPreview(link, { signal: AbortSignal.any(signals) });
      return preview ? { preview } : null;
    } catch {
      return null;
    }
  },

  build(ctx) {
    const { input } = ctx;
    const mentions = Array.isArray(ctx.mentions) ? ctx.mentions : [];
    let text = input.text;
    for (const mention of mentions) {
      // in a LID group the client matches the `@token` of the text to the mentioned JID: it must be the LID's user part
      if (typeof mention.jid === "string" && /@(hosted\.)?lid$/.test(mention.jid)) {
        const lidUser = mention.jid.split("@")[0];
        text = text.replace(new RegExp(`@${mention.number}(?!\\d)`, "g"), `@${lidUser}`);
      }
    }
    // `prepare` returns { preview }; the engine may hand build() either that object or the preview inside it
    let preview = ctx.preview && typeof ctx.preview === "object" ? ctx.preview : null;
    if (preview && preview.preview && typeof preview.preview === "object") preview = preview.preview;
    const content = { text, linkPreview: preview };
    if (mentions.length) content.mentions = mentions.map((mention) => mention.jid);
    return { content };
  },

  doc: {
    summary: "Send a text message",
    description: "Sends a text of 1 to 4,096 characters, verbatim, to one number or one group. Mentions work in groups only.",
    examples: [
      {
        format: "text",
        to: "237690000001",
        text: "Hello Awa, your order #4821 has shipped. Tracking: https://track.example.com/4821",
      },
    ],
  },
};
