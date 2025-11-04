# Translation Files

This directory contains translation files for the OpenWhatsApp Bot in multiple languages.

## Available Languages

- `en.json` - English (default fallback language)
- `fr.json` - French (Français)
- `ar.json` - Arabic (العربية)
- `bn.json` - Bengali (বাংলা)
- `es.json` - Spanish (Español)
- `hi.json` - Hindi (हिन्दी)
- `id.json` - Indonesian (Bahasa Indonesia)
- `ru.json` - Russian (Русский)
- `tr.json` - Turkish (Türkçe)
- `ur.json` - Urdu (اردو)

## How Translations Work

The bot uses the `getLang()` function from `lib/utils/language.js` to retrieve translated strings using dot notation keys.

### Example Usage

```javascript
const { getLang } = require("../lib/utils/language");

// Get a simple translation
const description = getLang("plugins.ping.desc");
// Returns: "Check bot response time"

// Get a translation with placeholders
const message = getLang("plugins.ping.pong", "42");
// Returns: "🏓 Pong!\n*Latency:* 42ms"
```

### Translation File Structure

All translation files follow this JSON structure:

```json
{
  "plugins": {
    "plugin_name": {
      "key": "Translated message",
      "key_with_placeholder": "Message with {0} placeholder"
    }
  },
  "extra": {
    "common_key": "Common message"
  }
}
```

### Placeholders

Use `{0}`, `{1}`, `{2}`, etc. for dynamic values:

```json
{
  "plugins": {
    "example": {
      "message": "User {0} sent {1} messages"
    }
  }
}
```

```javascript
getLang("plugins.example.message", "John", "42");
// Returns: "User John sent 42 messages"
```

## Contributing Translations

To improve translations for a specific language:

1. Open the appropriate `.json` file (e.g., `fr.json` for French)
2. Find the translation key you want to improve
3. Update the translated text while keeping placeholders intact
4. Ensure special characters are properly escaped
5. Test your changes by setting `LANG` in `config.env`

### Tips for Translators

- Keep the same placeholders (`{0}`, `{1}`, etc.) in the translated text
- Maintain formatting characters like `*` for bold and `_` for italic (WhatsApp formatting)
- Preserve emoji characters
- Keep line breaks (`\n`) in the same positions for proper formatting
- Test your translations to ensure they display correctly in WhatsApp

## Setting Language

The bot's language is configured in `config.env`:

```env
LANG=fr
```

Or as an environment variable:

```bash
export LANG=fr
node index.js
```

## Fallback Behavior

If a translation key is not found in the selected language:
1. The system tries to load it from `en.json` (English)
2. If still not found, the key itself is returned

This ensures the bot always displays something meaningful, even if translations are incomplete.
