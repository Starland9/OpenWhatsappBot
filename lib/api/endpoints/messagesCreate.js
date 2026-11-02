"use strict";

/**
 * PUB-1 `POST /api/v1/messages`: send one message (feature 004, contracts/public-api.md sections 2.1, 3, 5 and 7.4).
 *
 * Rights are DYNAMIC: the catalogue is `messages.send.<format>` for every registered format plus `media.url`, and the
 * pipeline evaluates `formats.rightsFor(peek.format, peek)` at step 12b (the format's own right, `media.url` when the
 * body carries a URL, the module's `requires`). The body is one of the 13 format schemas (`variants` by `format`), JSON
 * or multipart (`message` then `file`); the file rules of the format (accepted kinds, byte cap) come from the registry.
 *
 * `handle` runs after the pipeline's steps 1-19: the key, the rights, the recipient policy, the disabled chat, the
 * idempotency lookup, the quota reserve, the strict validation and the media (an upload already streamed to
 * `ctx.file`, or a `media.url` already downloaded). It hands the accepted input to the engine and answers `202`:
 *   - a replay found by the pipeline (`ctx.idempotency.replay`) or by a lost race inside `submit` answers `202` with
 *     `Idempotent-Replayed: true`, never calls `submit` twice and honours `wait` like any other request;
 *   - `wait=N` holds the answer until the message is `sent`, `failed`, `expired`, `cancelled` or `unknown`, or N seconds
 *     (`delivered` and `read` never end a wait); a caller that disconnects only abandons the wait.
 * The HTTP side never names a destination for the file: the engine moves the temporary file (Y3). The content (text,
 * caption, options) is never logged or returned.
 */

const { reply } = require("../../admin/http/response");
const { splitUrl, parseQuery } = require("../../admin/http/request");
const { ApiError } = require("../errors");
const { presentMessage, locationOf } = require("../present");

const WAIT_MAX_SECONDS = 30;

/** The format module of the body, or null (the pipeline validated the discriminator before it asks) */
const formatOf = (formats, peek) => (peek && typeof peek.format === "string" ? formats.get(peek.format) : null);

/**
 * `wait` of the request. The pipeline validates the query with the body, and skips both for a replay (a stored key can
 * only replay or conflict), yet the wait applies to a replay as well: validate it here with the same rules.
 */
function waitOf(ctx) {
  if (!(ctx.idempotency && ctx.idempotency.replay)) return ctx.query.wait || 0;
  const { coerceQuery } = require("../pipeline");
  const schema = require("../../utils/schema");
  const raw = parseQuery(splitUrl(ctx.req.url).search);
  const coerced = coerceQuery(raw, module.exports.query);
  const checked = schema.check({ ...coerced.query }, module.exports.query);
  const fields = { ...coerced.fields, ...checked.fields };
  if (Object.keys(fields).length) throw new ApiError("validation_failed", { fields });
  return checked.value.wait || 0;
}

/** Hold the answer until the message settles, the bound passes or the caller disconnects; the freshest view wins */
async function holdFor(messaging, view, seconds, signal) {
  if (!(seconds > 0) || signal.aborted) return view;
  const waiter = messaging.waitFor(view.publicId, seconds * 1000);
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const settled = await Promise.race([waiter.promise, aborted]);
    return settled || view;
  } finally {
    signal.removeEventListener("abort", onAbort);
    waiter.cancel();
  }
}

/** A poll, buttons or list message shows the replies collected so far: the engine's own read has them */
async function withResponses(messaging, apiKeyId, view) {
  if (!view.interactive) return view;
  const fresh = await messaging.get({ apiKeyId, publicId: view.publicId });
  if (fresh) return fresh;
  return { ...view, responses: messaging.describeResponses(view, []) };
}

module.exports = {
  id: "messages.create",
  method: "POST",
  path: "/api/v1/messages",

  rights: ({ formats }) => [...formats.rights(), "media.url"],
  requires: (peek, { formats }) => formats.rightsFor(peek.format, peek),

  query: { wait: { type: "int", min: 0, max: WAIT_MAX_SECONDS, default: 0 } },

  body: {
    kinds: ["json", "multipart"],
    limit: 65536,
    variants: {
      by: "format",
      schemas: ({ formats }) => Object.fromEntries(formats.list().map((row) => [row.name, formats.schemaOf(row.name)])),
    },
    file: {
      part: "file",
      // the cap and the accepted kinds are those of the format, known once the discriminator is valid
      maxBytes: (peek, { formats }) => {
        const format = formatOf(formats, peek);
        return format && format.media ? require("../../messaging/sniff").effectiveMax(format) : 0;
      },
      accept: (peek, { formats }) => {
        const format = formatOf(formats, peek);
        return format && format.media ? { kinds: format.media.kinds.slice() } : null;
      },
    },
  },

  recipient: (peek) => peek.to,
  idempotent: true,
  quota: { messages: true },

  response: {
    status: 202,
    headers: ["Location"],
    openapi: { type: "object", required: ["message"], additionalProperties: false, properties: { message: { $ref: "#/components/schemas/Message" } } },
  },

  doc: {
    summary: "Send one message",
    description:
      "Queues one message (text, image, video, gif, audio, voice note, document, sticker, location, contact, poll, buttons or list) for one recipient and answers 202 at once; the queue sends it at a paced rhythm. The body is JSON, or multipart (a `message` part then a `file` part) for a media format. `wait` (0 to 30 seconds) holds the answer until the message is sent.",
    tags: ["messages"],
  },

  async handle(ctx) {
    const messaging = ctx.services.messaging;
    let view;
    let replayed = false;

    if (ctx.idempotency && ctx.idempotency.replay) {
      view = ctx.idempotency.replay;
      replayed = true;
    } else {
      const body = ctx.body;
      const result = await messaging.submit({
        source: "api",
        apiKeyId: ctx.key.id,
        requestId: ctx.requestId,
        format: body.format,
        to: body.to,
        quote: body.quote || null,
        fields: body.fields,
        media: ctx.file
          ? { path: ctx.file.path, size: ctx.file.size, name: ctx.file.name || null, sha256: ctx.file.sha256, source: ctx.file.source === "url" ? "url" : "upload" }
          : null,
        idempotency: ctx.idempotency ? { key: ctx.idempotency.key, requestHash: ctx.idempotency.requestHash } : null,
      });
      view = result.message;
      replayed = result.replayed === true;
    }

    view = await holdFor(messaging, view, waitOf(ctx), ctx.signal);
    view = await withResponses(messaging, ctx.key.id, view);

    const headers = { Location: locationOf(view.publicId) };
    if (replayed) headers["Idempotent-Replayed"] = "true";
    return reply(202, { message: presentMessage(view, { withResponses: true }) }, headers);
  },
};
