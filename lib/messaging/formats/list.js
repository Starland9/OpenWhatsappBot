"use strict";

/**
 * Format `list` (feature 004, contracts/runtime.md sections 3.6 and 3.7, public-api.md 3.9): a single-select list of
 * 1 to 10 choices behind a button. One section titled with the button label; the body always carries the numbered
 * titles and a hint line (FR-057, `buildList(..., { numbered: true })`); no footer, no header, never recorded in
 * `buttonRegistry`. A choice's `label` in the row's `choices` is its title (the description and the button label are
 * not kept). Limits are rejected, never truncated.
 */

const { LIMITS } = require("../limits");

const wireId = (waId, id) => `api:reply:${waId}:${id}`;

const sectionsOf = (input, idOf) => [
  {
    title: input.buttonLabel,
    rows: input.choices.map((c) => ({ id: idOf(c.id), title: c.title, ...(c.description ? { description: c.description } : {}) })),
  },
];

function composedBody(input) {
  try {
    const { buildList } = require("../../../plugins/buttons");
    return buildList(input.text, sectionsOf(input, (id) => `api:reply:x:${id}`), { buttonLabel: input.buttonLabel, numbered: true }).body;
  } catch {
    return null;
  }
}

module.exports = {
  name: "list",
  order: 130,
  interactive: true,

  fields: {
    text: { type: "string", required: true, minLength: 1, maxLength: LIMITS.INTERACTIVE_TEXT, trim: true },
    buttonLabel: { type: "string", required: true, minLength: 1, maxLength: LIMITS.LIST_BUTTON_LABEL, trim: true },
    choices: {
      type: "array",
      required: true,
      min: 1,
      max: LIMITS.LIST_ROWS_MAX,
      items: {
        type: "object",
        shape: {
          id: { type: "string", required: true, pattern: LIMITS.ID_PATTERN },
          title: { type: "string", required: true, minLength: 1, maxLength: LIMITS.LIST_TITLE, trim: true },
          description: { type: "string", minLength: 1, maxLength: LIMITS.LIST_DESCRIPTION, trim: true },
        },
      },
    },
  },

  /** Distinct ids (`choices.N.id = duplicate`) and a composed body within BODY_COMPOSED */
  refine(input) {
    const faults = {};
    if (!Array.isArray(input.choices)) return null;
    const seen = new Set();
    input.choices.forEach((choice, index) => {
      if (!choice || typeof choice.id !== "string") return;
      if (seen.has(choice.id)) faults[`choices.${index}.id`] = { code: "duplicate" };
      else seen.add(choice.id);
    });
    if (typeof input.text === "string" && typeof input.buttonLabel === "string" && input.choices.every((c) => c && typeof c.id === "string" && typeof c.title === "string")) {
      const body = composedBody(input);
      if (body !== null && Array.from(body).length > LIMITS.BODY_COMPOSED) faults.text = { code: "too_long", params: { max: LIMITS.BODY_COMPOSED } };
    }
    return Object.keys(faults).length ? faults : null;
  },

  size(input) {
    return Buffer.byteLength(input.text, "utf8");
  },

  build(ctx) {
    const { input, waId } = ctx;
    const { buildList } = require("../../../plugins/buttons");
    const prepared = buildList(input.text, sectionsOf(input, (id) => wireId(waId, id)), { buttonLabel: input.buttonLabel, numbered: true });
    return { transport: "interactive", content: prepared, choices: input.choices.map((c) => ({ id: c.id, label: c.title })) };
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
    summary: "Send a list",
    description: "Sends a text with a button that opens a list of 1 to 10 choices, native on phones that show it and a numbered text on those that do not. Taps and quoted numbers are captured.",
    examples: [
      {
        format: "list",
        to: "237690000001",
        text: "Choose a delivery slot",
        buttonLabel: "See slots",
        choices: [
          { id: "slot-am", title: "Morning", description: "8:00 - 12:00" },
          { id: "slot-pm", title: "Afternoon", description: "14:00 - 18:00" },
        ],
      },
    ],
  },
};
