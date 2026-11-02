"use strict";

/**
 * Format `contact` (feature 004, contracts/runtime.md sections 3.6 and 3.8, public-api.md 3.6): 1 to 10 contact
 * cards. The bot builds every vCard itself from the declared fields (`vcard.buildVCard`): the caller never sends raw
 * card text, and no value can add a property (FR-055). One card is a contact message, several a contact array
 * (Baileys decides).
 */

const { LIMITS } = require("../limits");
const { parsePhoneNumber } = require("../../utils/permissions");
const { buildVCard } = require("../vcard");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = {
  name: "contact",
  order: 100,
  interactive: false,

  fields: {
    contacts: {
      type: "array",
      required: true,
      min: 1,
      max: LIMITS.CONTACTS_MAX,
      items: {
        type: "object",
        shape: {
          name: { type: "string", required: true, minLength: 1, maxLength: LIMITS.CONTACT_NAME, trim: true },
          phones: {
            type: "array",
            required: true,
            min: 1,
            max: LIMITS.PHONES_MAX,
            unique: true,
            items: { type: "string", minLength: 1, maxLength: 64, trim: true },
          },
          organization: { type: "string", minLength: 1, maxLength: LIMITS.CONTACT_ORG, trim: true },
          email: { type: "string", minLength: 1, maxLength: LIMITS.CONTACT_EMAIL, trim: true, pattern: EMAIL },
        },
      },
    },
  },

  /** Phone syntax and distinct phones (compared as digits: `+237 690 00 00 02` and `237690000002` are one phone) */
  refine(input) {
    if (!Array.isArray(input.contacts)) return null;
    const faults = {};
    input.contacts.forEach((card, i) => {
      if (!card || !Array.isArray(card.phones)) return;
      const seen = new Set();
      card.phones.forEach((phone, j) => {
        const parsed = parsePhoneNumber(phone);
        if (parsed.error) faults[`contacts.${i}.phones.${j}`] = { code: "invalid_format" };
        else if (seen.has(parsed.digits)) faults[`contacts.${i}.phones.${j}`] = { code: "duplicate" };
        else seen.add(parsed.digits);
      });
    });
    return Object.keys(faults).length ? faults : null;
  },

  normalize(input) {
    return {
      ...input,
      contacts: input.contacts.map((card) => ({ ...card, phones: card.phones.map((phone) => parsePhoneNumber(phone).digits) })),
    };
  },

  size() {
    return null;
  },

  build(ctx) {
    const cards = ctx.input.contacts.map((card) => ({
      displayName: card.name,
      vcard: buildVCard({ name: card.name, organization: card.organization, email: card.email, phones: card.phones }),
    }));
    return { content: { contacts: { displayName: cards[0].displayName, contacts: cards } } };
  },

  doc: {
    summary: "Send contact cards",
    description: "Sends 1 to 10 contact cards built by the bot from a name, 1 to 5 phone numbers, an optional organization and e-mail.",
    examples: [
      {
        format: "contact",
        to: "237690000001",
        contacts: [{ name: "Acme Support", phones: ["+237 690 00 00 02"], organization: "Acme", email: "support@acme.example" }],
      },
    ],
  },
};
