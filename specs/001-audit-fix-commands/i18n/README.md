# i18n fragments

Each plugin agent writes its translations here as `<plugin-file>.json`, instead of editing `lang/*.json` directly. This lets agents work in parallel without conflicts.

```json
{
  "en": { "plugins.kick.usage": "Usage: {0}kick @user", "plugins.kick.done": "✅ Removed {0}" },
  "fr": { "plugins.kick.usage": "Utilisation : {0}kick @membre", "plugins.kick.done": "✅ {0} a été retiré" }
}
```

- Keys are **flat dot-paths**. Placeholders are `{0}`, `{1}`… (filled by `getLang(key, ...args)`).
- A fragment may override an existing key.
- `en` and `fr` must contain the same key set.

Merge into `lang/en.json` and `lang/fr.json`:

```bash
node tools/merge-i18n.js   # exits 1 on a missing translation or a conflict between fragments
```
