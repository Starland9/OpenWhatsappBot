"use strict";

/**
 * Format `buttons` (feature 004, contracts/runtime.md sections 3.6 and 3.7, public-api.md 3.8): 1 to 3 quick-reply
 * buttons. The message always carries the numbered text version of the buttons and a hint line (FR-057, U14), built
 * by `plugins/buttons.js#buildQuickReplies(..., { numbered: true })`; it has no footer and no header and is never
 * recorded in `buttonRegistry`: the id mapping lives in the row's `choices`, so a numbered answer works for the whole
 * reply window. Wire ids are `api:reply:<waId>:<callerId>` (at most 97 characters, no colon in the caller's id).
 * Limits are rejected, never truncated.
 */

const { LIMITS } = require("../limits");

const wireId = (waId, id) => `api:reply:${waId}:${id}`;

/** The composed body (text, numbered lines, hint) the phone will show; null when the builder is unavailable */
function composedBody(text, buttons) {
  try {
    const { buildQuickReplies } = require("../../../plugins/buttons");
    return buildQuickReplies(text, buttons.map((b) => ({ id: `api:reply:x:${b.id}`, text: b.label })), { numbered: true }).body;
  } catch {
    return null;
  }
}

module.exports = {
  name: "buttons",
  order: 120,
  interactive: true,

  fields: {
    text: { type: "string", required: true, minLength: 1, maxLength: LIMITS.INTERACTIVE_TEXT, trim: true },
    buttons: {
      type: "array",
      required: true,
      min: 1,
      max: LIMITS.BUTTONS_MAX,
      items: {
        type: "object",
        shape: {
          id: { type: "string", required: true, pattern: LIMITS.ID_PATTERN },
          label: { type: "string", required: true, minLength: 1, maxLength: LIMITS.BUTTON_LABEL, trim: true },
        },
      },
    },
  },

  /** Distinct ids (the repeat is `buttons.N.id = duplicate`) and a composed body within BODY_COMPOSED */
  refine(input) {
    const faults = {};
    if (!Array.isArray(input.buttons)) return null;
    const seen = new Set();
    input.buttons.forEach((button, index) => {
      if (!button || typeof button.id !== "string") return;
      if (seen.has(button.id)) faults[`buttons.${index}.id`] = { code: "duplicate" };
      else seen.add(button.id);
    });
    if (typeof input.text === "string" && input.buttons.every((b) => b && typeof b.id === "string" && typeof b.label === "string")) {
      const body = composedBody(input.text, input.buttons);
      if (body !== null && Array.from(body).length > LIMITS.BODY_COMPOSED) faults.text = { code: "too_long", params: { max: LIMITS.BODY_COMPOSED } };
    }
    return Object.keys(faults).length ? faults : null;
  },

  size(input) {
    return Buffer.byteLength(input.text, "utf8");
  },

  build(ctx) {
    const { input, waId } = ctx;
    // plugins/buttons.js pulls in the button helper: loaded when a message is built (RT-04)
    const { buildQuickReplies } = require("../../../plugins/buttons");
    const prepared = buildQuickReplies(input.text, input.buttons.map((b) => ({ id: wireId(waId, b.id), text: b.label })), { numbered: true });
    return { transport: "interactive", content: prepared, choices: input.buttons.map((b) => ({ id: b.id, label: b.label })) };
  },

  /** A tap whose id is one of the row's choices, or a number 1..n (the quoted answer "2"); anything else is null */
  interpretReply({ row, event }) {
    const choices = row && Array.isArray(row.choices) ? row.choices : [];
    if (!event) return null;
    if (event.type === "tap") {
      const found = choices.find((choice) => choice && choice.id === event.id);
      return found ? { choiceIds: [found.id] } : null;
    }
    if (event.type === "number") {
      const n = event.number;
      return Number.isInteger(n) && n >= 1 && n <= choices.length ? { choiceIds: [choices[n - 1].id] } : null;
    }
    return null;
  },

  doc: {
    summary: "Send quick-reply buttons",
    description: "Sends a text with 1 to 3 buttons, native on phones that show them and a numbered text on those that do not. Taps and quoted numbers are captured.",
    examples: [
      {
        format: "buttons",
        to: "237690000001",
        text: "Do you confirm your appointment tomorrow at 10:00?",
        buttons: [
          { id: "confirm", label: "Yes" },
          { id: "cancel", label: "No" },
        ],
      },
    ],
  },
};
