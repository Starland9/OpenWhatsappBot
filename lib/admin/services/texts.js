"use strict";

/**
 * Bot-text service of the panel (TXT-1 to TXT-3 of admin-http-api.md section 2.15, FR-057 to FR-060). The factory
 * never touches `req`/`res`:
 *
 *   const texts = createTextsService(deps);
 *   texts.list({ q, command, overridden, changed, page, pageSize })   -> { items, page, pageSize, total }
 *   await texts.save(lang, key, text, { actor })                      -> { item }
 *   await texts.reset(lang, key, { actor })                          -> { item, removed }
 *
 * `item` is `{ key, group, command, placeholders, texts: { en: { original, effective, overridden, originalChanged },
 * fr: {...} } }`. The rules and the persistence are lib/utils/textOverrides.js (and the LanguageManager behind it);
 * this layer filters, pages and turns a `TextOverrideError` into the codes of the error envelope:
 *
 *   unsupported_lang, unknown_key    404 not_found (params.resource "text")
 *   empty                            422 fields.text = required
 *   too_long                         422 fields.text = too_long (params.max 4000)
 *   placeholder_mismatch             422 fields.text = placeholder_mismatch (params.expected: the original's tokens)
 *
 * The changes are live for the very next message (the in-memory map is replaced before the answer is sent).
 */

const { AdminError } = require("../http/response");

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function createTextsService(deps = {}) {
  const overrides = () => deps.textOverrides || require("../../utils/textOverrides");
  const language = () => deps.language || require("../../utils/language");
  const registry = () => deps.registry || null;

  /** TXT-1 item of a textOverrides row */
  function itemOf(row) {
    const texts = {};
    for (const lang of overrides().LANGS) {
      const own = row.override[lang];
      texts[lang] = {
        original: row.base[lang],
        effective: own !== null ? own : row.base[lang],
        overridden: own !== null,
        originalChanged: row.changed[lang],
      };
    }
    return { key: row.key, group: row.group, command: row.command, placeholders: row.placeholders.slice(), texts };
  }

  function itemFor(key) {
    const row = overrides().describe(key, { registry: registry() || undefined });
    if (!row) throw new AdminError("not_found", { params: { resource: "text" } });
    return itemOf(row);
  }

  /** TextOverrideError -> AdminError; anything else is passed on untouched */
  function mapError(error) {
    const { TextOverrideError, MAX_OVERRIDE_LENGTH } = language();
    if (!(error instanceof TextOverrideError)) return error;
    switch (error.code) {
      case "empty":
        return new AdminError("validation_failed", { fields: { text: { code: "required" } } });
      case "too_long":
        return new AdminError("validation_failed", { fields: { text: { code: "too_long", params: { max: MAX_OVERRIDE_LENGTH } } } });
      case "placeholder_mismatch":
        return new AdminError("validation_failed", {
          fields: { text: { code: "placeholder_mismatch", params: { expected: (error.params && error.params.expected) || [] } } },
        });
      default: // unsupported_lang, unknown_key
        return new AdminError("not_found", { params: { resource: "text" } });
    }
  }

  /** TXT-1 */
  function list({ q, command, overridden = false, changed = false, page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
    const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE));
    const current = Math.max(1, Number(page) || 1);
    let rows = overrides().list({ q, command, registry: registry() || undefined });
    if (overridden) rows = rows.filter((row) => row.override.en !== null || row.override.fr !== null);
    if (changed) rows = rows.filter((row) => row.originalChanged);
    const start = (current - 1) * size;
    return {
      items: rows.slice(start, start + size).map(itemOf),
      page: current,
      pageSize: size,
      total: rows.length,
    };
  }

  /** TXT-2 */
  async function save(lang, key, text, { actor } = {}) {
    try {
      await overrides().save(lang, key, text, { actor });
    } catch (error) {
      throw mapError(error);
    }
    return { item: itemFor(key) };
  }

  /** TXT-3 */
  async function reset(lang, key, { actor } = {}) {
    let result;
    try {
      result = await overrides().clear(lang, key, { actor });
    } catch (error) {
      throw mapError(error);
    }
    return { item: itemFor(key), removed: result.removed };
  }

  return { list, save, reset, itemFor, mapError };
}

module.exports = { createTextsService, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE };
