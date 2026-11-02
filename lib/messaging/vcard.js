"use strict";

/**
 * vCard 3.0 builder of the `contact` format (feature 004, contracts/runtime.md section 3.8, FR-055).
 *
 *   buildVCard({ name, organization, email, phones }) -> string
 *
 * BEGIN:VCARD, VERSION:3.0, FN, ORG (if any), EMAIL;type=INTERNET (if any), one `TEL;type=CELL;waid=<digits>:+<digits>`
 * per phone (the digits come from `parsePhoneNumber`), END:VCARD, CRLF line ends. The caller never supplies card
 * text: every value is escaped (`\`, `;`, `,`), a line break becomes the two characters `\n`, any other control
 * character is dropped, so a value can never add a property (a name holding `\r\nTEL:` yields exactly one TEL line
 * per declared phone).
 */

const { parsePhoneNumber } = require("../utils/permissions");

/** One text value of a card, safe to put after `FN:` */
function escapeValue(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, "\\n")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function buildVCard({ name, organization, email, phones } = {}) {
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${escapeValue(name)}`];
  if (organization) lines.push(`ORG:${escapeValue(organization)}`);
  if (email) lines.push(`EMAIL;type=INTERNET:${escapeValue(email)}`);
  for (const phone of Array.isArray(phones) ? phones : []) {
    const parsed = parsePhoneNumber(phone);
    if (!parsed.error) lines.push(`TEL;type=CELL;waid=${parsed.digits}:+${parsed.digits}`);
  }
  lines.push("END:VCARD");
  return lines.join("\r\n");
}

module.exports = { buildVCard, escapeValue };
