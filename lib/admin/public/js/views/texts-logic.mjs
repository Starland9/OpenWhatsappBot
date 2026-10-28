// Pure logic of the bot-texts view (TXT-1 to TXT-3 of contracts/admin-http-api.md 2.15, contracts/runtime.md 4):
// the `{n}` placeholders of a text, the check an edited text must pass before it is sent, change detection, and the
// query of the list. No DOM access and no import: node:test loads this file. The server stays authoritative (it
// refuses a text whose placeholders differ from the original's with `placeholder_mismatch`); the same rule here only
// shows the expected tokens while the administrator types.

export const LANGS = ["en", "fr"];
/** Longest replacement text, in characters (code points) */
export const MAX_LENGTH = 4000;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * The `{n}` tokens of a text, sorted by number, duplicates kept (it is a multiset). Same regex and same order as the
 * server's `placeholdersOf` (lib/utils/textOverrides.js): `{0}`, `{1}`... and nothing else.
 */
export function extractPlaceholders(text) {
  return (String(text === undefined || text === null ? "" : text).match(/\{\d+\}/g) || []).sort(
    (a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10),
  );
}

/** What is missing from `actual` and what it has too many of, compared as multisets */
export function comparePlaceholders(expected, actual) {
  const remaining = new Map();
  for (const token of actual) remaining.set(token, (remaining.get(token) || 0) + 1);
  const missing = [];
  for (const token of expected) {
    const left = remaining.get(token) || 0;
    if (left > 0) remaining.set(token, left - 1);
    else missing.push(token);
  }
  const extra = [];
  for (const [token, count] of remaining) for (let i = 0; i < count; i += 1) extra.push(token);
  extra.sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

const codePoints = (text) => Array.from(String(text)).length;

/** The tokens a text of this item must keep: those of the original of the language, else of the English one */
export function expectedTokens(item, lang) {
  const original = item && item.texts && item.texts[lang] ? item.texts[lang].original : null;
  const base = original !== null && original !== undefined ? original : item && item.texts && item.texts.en ? item.texts.en.original : "";
  return extractPlaceholders(base);
}

/**
 * Check an edited text like the server will: `{ code, params }` with the field codes of the API, or null when it
 * would be accepted. `required` for a blank text, `too_long` over 4000 characters, `placeholder_mismatch` when the
 * tokens differ from the original's (`params.expected` lists them, as the API does).
 */
export function validateDraft(item, lang, draft) {
  const text = draft === undefined || draft === null ? "" : String(draft);
  if (text.trim() === "") return { code: "required" };
  if (text.length > MAX_LENGTH && codePoints(text) > MAX_LENGTH) return { code: "too_long", params: { max: MAX_LENGTH } };
  const expected = expectedTokens(item, lang);
  const found = extractPlaceholders(text);
  if (expected.join(",") !== found.join(",")) return { code: "placeholder_mismatch", params: { expected } };
  return null;
}

/** The text a language currently uses (the replacement when there is one) */
export function effectiveText(item, lang) {
  const entry = item && item.texts ? item.texts[lang] : null;
  if (!entry) return "";
  return entry.effective === null || entry.effective === undefined ? "" : entry.effective;
}

/** Has the editor text changed from what is in force? */
export function isDirty(item, lang, draft) {
  return String(draft === undefined || draft === null ? "" : draft) !== effectiveText(item, lang);
}

/** The drafts the editor starts with: the text in force, per language */
export function initialDrafts(item) {
  const out = {};
  for (const lang of LANGS) out[lang] = effectiveText(item, lang);
  return out;
}

/** "original" (untouched), "edited" (replaced) or "stale" (replaced, and the file text changed since) */
export function statusOf(item, lang) {
  const entry = item && item.texts ? item.texts[lang] : null;
  if (!entry || !entry.overridden) return "original";
  return entry.originalChanged ? "stale" : "edited";
}

/** Any language replaced? / any replacement made stale by a change of the original? */
export const isOverridden = (item) => LANGS.some((lang) => statusOf(item, lang) !== "original");
export const isStale = (item) => LANGS.some((lang) => statusOf(item, lang) === "stale");

/** `{n}` tokens as one line: "{0}, {1}" */
export function formatTokens(tokens) {
  return (tokens || []).join(", ");
}

/** A command typed in the filter: trimmed, lower-case, without the prefix the user may have typed */
export function normalizeCommand(text) {
  return String(text === undefined || text === null ? "" : text)
    .trim()
    .toLowerCase()
    .replace(/^[.!/#]+/, "");
}

/** The TXT-1 query for a set of filters: empty filters are left out, flags are sent as 1 */
export function listQuery(filters = {}, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const query = {};
  const q = String(filters.q === undefined || filters.q === null ? "" : filters.q).trim();
  if (q) query.q = q.slice(0, 100);
  const command = normalizeCommand(filters.command);
  if (command) query.command = command.slice(0, 64);
  if (filters.overridden) query.overridden = 1;
  if (filters.changed) query.changed = 1;
  if (page > 1) query.page = page;
  if (pageSize !== DEFAULT_PAGE_SIZE) query.pageSize = pageSize;
  return query;
}

/** Replace an item (same key) in a page of results, keeping the order */
export function replaceItem(items, item) {
  return (items || []).map((current) => (current.key === item.key ? item : current));
}

/** The error of a rejected save as `{ code, params }` for the text field, or null when it is not a field error */
export function textFieldError(error) {
  const field = error && error.fields && error.fields.text;
  return field && typeof field.code === "string" ? { code: field.code, ...(field.params ? { params: field.params } : {}) } : null;
}
