# Translation fragments (feature 002)

Implementation agents never edit `lang/*.json` or `lib/admin/public/i18n/*.json`. They write fragments here; only agent W2-A merges them.

Two families, same shape (flat dot keys, identical key sets in `en` and `fr`, natural French with accents):

```json
{ "en": { "area.key": "Text with {0}" }, "fr": { "area.key": "Texte avec {0}" } }
```

| Family | File | Used by | Merged into | Command |
| --- | --- | --- | --- | --- |
| Bot texts | `bot-<area>.json` | `getLang("<area>.<key>")` (WhatsApp replies, alerts, console lines) | `lang/{en,fr}.json` | `node tools/merge-i18n.js --frag-dir specs/002-admin-panel/i18n --pattern "bot-*.json"` |
| Panel UI | `panel-<area>.json` | `t("<area>.<key>")` in `lib/admin/public/js/**` | `lib/admin/public/i18n/{en,fr}.json` | `node tools/merge-panel-i18n.js` |

Areas in use: `auth`, `runtime`, `commands`, `groupguard`, `alerts`, `update`, `shell`, `dashboard`, `settings`, `pairing`, `groups`, `data`, `broadcasts`, `backup`, `maintenance`, `texts`, `logs`, `stats`, `audit`.

Run each merge with `--dry-run` first.
