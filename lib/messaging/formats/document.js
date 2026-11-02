"use strict";

/**
 * Format `document` (feature 004, contracts/runtime.md section 3.6, public-api.md 3.3): a PDF, ZIP, Office or
 * OpenDocument file, plain text or CSV (the broadcast whitelist, U6; never an executable) sent as it is. The file name
 * is only a label: it is sanitised by the broadcaster's `sanitizeName` and the content goes out with the type detected
 * from its bytes.
 */

const { LIMITS } = require("../limits");

module.exports = {
  name: "document",
  order: 70,
  interactive: false,

  fields: {
    caption: { type: "string", minLength: 1, maxLength: LIMITS.CAPTION, trim: true },
    fileName: { type: "string", minLength: 1, maxLength: LIMITS.FILE_NAME, trim: true },
  },
  media: { kinds: ["document"], maxBytes: LIMITS.MEDIA_MAX.document, required: true, sources: ["file", "url"] },

  build(ctx) {
    const { input, media } = ctx;
    const url = require("../stage").assertStaged(media.path, ctx.dir);
    // heavy and database-bound: loaded when a document is built, not when the registry loads (RT-04)
    const { sanitizeName } = require("../../utils/broadcaster");
    const raw = input.fileName || media.name || `file${media.ext ? `.${media.ext}` : ""}`;
    return {
      content: {
        document: { url },
        mimetype: media.mime,
        fileName: sanitizeName(raw, media.mime),
        ...(input.caption ? { caption: input.caption } : {}),
      },
    };
  },

  doc: {
    summary: "Send a document",
    description: "Sends a PDF, ZIP, Office or OpenDocument file, plain text or CSV (up to 100 MB). The file name is a label only.",
    examples: [{ format: "document", to: "237690000001", caption: "Invoice 2026-0042", fileName: "invoice-2026-0042.pdf" }],
  },
};
