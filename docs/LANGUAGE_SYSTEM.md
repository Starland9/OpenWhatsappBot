# Language System Documentation

## Overview

The OpenWhatsappBot now supports multi-language translations through a centralized language system. This allows the bot to display messages in different languages based on the `LANG` configuration setting.

## Configuration

Set the language in your `config.env` file:

```env
LANG=en  # Options: en, fr, id, ar, es, tr, ru, bn, hi, ur
```

## Available Languages

- **en** - English (default)
- **fr** - French
- **id** - Indonesian
- **ar** - Arabic
- **es** - Spanish
- **tr** - Turkish
- **ru** - Russian
- **bn** - Bengali
- **hi** - Hindi
- **ur** - Urdu

## Usage in Plugins

### 1. Import the Language Utility

```javascript
const { getLang } = require("../lib/utils/language");
```

### 2. Use in Command Descriptions

```javascript
module.exports = {
  command: {
    pattern: "ping",
    desc: getLang("plugins.ping.desc"),
    type: "general",
  },
  // ...
};
```

### 3. Use in Messages

```javascript
// Simple message
await message.reply(getLang("plugins.common.not_admin"));

// Message with placeholders
await message.reply(getLang("plugins.ping.pong", latency));

// Multiple placeholders
await message.reply(getLang("extra.reconnect", "main", 3));
```

## Language Key Structure

Language keys use dot notation to access nested objects:

```javascript
// Language file structure (en.json):
{
  "extra": {
    "group_cmd": "This command is only available in group chats."
  },
  "plugins": {
    "common": {
      "not_admin": "I'm not admin."
    },
    "ping": {
      "desc": "Check the bot's response time (latency).",
      "pong": "Pong! Response time: {0} ms"
    }
  }
}

// Usage:
getLang("extra.group_cmd")                 // "This command is only available..."
getLang("plugins.common.not_admin")        // "I'm not admin."
getLang("plugins.ping.desc")               // "Check the bot's response time..."
getLang("plugins.ping.pong", "42")         // "Pong! Response time: 42 ms"
```

## Placeholder Replacement

Use `{0}`, `{1}`, `{2}`, etc. in language strings for dynamic values:

```javascript
// In language file:
"pong": "Pong! Response time: {0} ms"

// In code:
getLang("plugins.ping.pong", latency)  // "Pong! Response time: 42 ms"
```

Multiple placeholders:

```javascript
// In language file:
"reconnect": "[{0}] reconnecting...({1})"

// In code:
getLang("extra.reconnect", "main", 3)  // "[main] reconnecting...(3)"
```

## Fallback Behavior

1. If a key doesn't exist in the selected language, it falls back to English
2. If the key doesn't exist in English either, it returns the key itself
3. This ensures the bot always has something to display

## Adding New Language Keys

### Step 1: Add to English (en.json)

```json
{
  "plugins": {
    "newcommand": {
      "desc": "Description of new command",
      "success": "Command executed successfully!"
    }
  }
}
```

### Step 2: Translate to Other Languages

Add the same structure to other language files (fr.json, es.json, etc.)

### Step 3: Use in Code

```javascript
const { getLang } = require("../lib/utils/language");

module.exports = {
  command: {
    pattern: "newcommand",
    desc: getLang("plugins.newcommand.desc"),
    type: "general",
  },
  async execute(message) {
    await message.reply(getLang("plugins.newcommand.success"));
  },
};
```

## Best Practices

1. **Always use English as the base**: Add keys to `en.json` first
2. **Use descriptive key names**: `plugins.kick.not_admin` instead of `plugins.kick.err1`
3. **Group related keys**: Keep command-related keys under `plugins.[command_name]`
4. **Use placeholders wisely**: Don't hardcode dynamic values in language files
5. **Test with different languages**: Set `LANG=fr` to test French translations

## File Locations

- **Language files**: `/lang/*.json`
- **Language utility**: `/lib/utils/language.js`
- **Plugin examples**: `/plugins/*.js`

## Common Language Keys

### Common Messages

- `plugins.common.not_admin` - "I'm not admin."
- `plugins.common.reply_to_message` - "Reply to a message"
- `plugins.common.update` - "Settings updated successfully!"

### Extra/System Messages

- `extra.group_cmd` - "This command is only available in group chats."
- `extra.connected` - "[{0}] Connected {1}"
- `extra.instance_close` - "[{0}] Connection closed"
- `extra.reconnect` - "[{0}] reconnecting...({1})"

## Troubleshooting

### Key Not Found

If you see the key itself instead of translated text:
1. Check that the key exists in `en.json`
2. Verify the dot notation path is correct
3. Make sure you imported `getLang` correctly

### Placeholder Not Replaced

If you see `{0}` in the output:
1. Make sure you're passing arguments to `getLang()`
2. Check that argument count matches placeholder count
3. Verify placeholders are numbered sequentially (0, 1, 2...)

### Wrong Language Displayed

1. Check the `LANG` setting in `config.env`
2. Verify the language file exists in `/lang/`
3. Restart the bot after changing `LANG`

## Testing

Run the language system test:

```bash
node /tmp/test_language_integration.js
```

This verifies:
- All language files exist
- Required keys are present
- Placeholder format is correct

## Contributing Translations

To add a new language:

1. Copy `lang/en.json` to `lang/[code].json` (e.g., `lang/pt.json` for Portuguese)
2. Translate all string values (keep keys in English)
3. Update the LANG options in this README
4. Test the bot with your language: `LANG=[code]`

---

**Note**: The language system is automatically loaded on bot startup. No manual initialization required.
