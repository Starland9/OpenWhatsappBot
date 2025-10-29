# Auto Status Viewer & AI Auto-Responder

This document describes the new features added to OpenWhatsappBot.

## Features

### 1. Auto Status Viewer

Automatically view and react to WhatsApp statuses with random emojis.

#### Configuration

Add to your `config.env`:

```env
# Auto Status Viewer
AUTO_STATUS_REACT=true
STATUS_EMOJIS=😀,👍,❤️,🔥,💯,✨,🎉,👏,💪,🙌
```

#### How it works

- When enabled, the bot automatically views all status updates
- Randomly selects an emoji from the configured list
- Reacts to the status with the selected emoji
- Works for image, video, and text statuses

### 2. AI Auto-Responder (Gemini)

Automatically respond to private messages using Google's Gemini AI with conversation context management.

#### Configuration

Add to your `config.env`:

```env
# Auto Responder (Gemini AI)
AUTO_RESPONDER_ENABLED=true
AUTO_RESPONDER_IGNORE_NUMBERS=1234567890,0987654321
AUTO_RESPONDER_PERSONALITY=You are a helpful and friendly assistant. Respond naturally and conversationally.

# Anti-ban measures for auto responder
AUTO_RESPONDER_MIN_DELAY=1000
AUTO_RESPONDER_MAX_DELAY=3000
AUTO_RESPONDER_TYPING_SPEED=50
AUTO_RESPONDER_MAX_TYPING_TIME=10000
AUTO_RESPONDER_RATE_LIMIT=5
AUTO_RESPONDER_RATE_WINDOW=60000

# Required: Gemini API Key
GEMINI_API_KEY=your_gemini_api_key_here
```

#### Features

- **Context-Aware**: Remembers the last 10 messages in each conversation
- **Auto-Expire**: Conversation context expires after 30 minutes of inactivity
- **Personality**: Customizable AI personality via command or ENV
- **Ignore List**: Manage numbers that should not receive auto-responses
- **Private Only**: Only responds to private messages (not groups)
- **Typing Indicator**: Shows "typing..." while generating response
- **Anti-Ban Protection**: Built-in measures to prevent WhatsApp bans:
  - **Random Delays**: Configurable delays before responding (simulate reading time)
  - **Human-Like Typing**: Typing speed simulation based on message length
  - **Rate Limiting**: Prevents too many responses in a short time window
  - **Natural Behavior**: Combines delays and typing indicators for realistic interaction

#### Commands

All commands require sudo access (configured via `SUDO` env variable).

##### View Status
```
.ar status
```
Shows current auto-responder configuration, ignored numbers, and personality.

##### Enable/Disable
```
.ar on
.ar off
```
Enable or disable the auto-responder.

##### Manage Ignore List
```
# Add a number to ignore list
.ar ignore add 1234567890

# Remove a number from ignore list
.ar ignore remove 1234567890

# List all ignored numbers
.ar ignore list

# Clear all ignored numbers
.ar ignore clear
```

##### Set Personality
```
.ar personality You are a professional business assistant who speaks formally and provides detailed answers.
```

Sets the AI's personality. The personality prompt guides how the AI responds.

##### Example Personalities

**Friendly Assistant:**
```
.ar personality You are a helpful and friendly assistant. Respond naturally and conversationally. Keep answers concise and use emojis occasionally.
```

**Professional:**
```
.ar personality You are a professional business assistant. Respond formally and provide accurate, detailed information. Always maintain a respectful tone.
```

**Casual Friend:**
```
.ar personality You are a close friend who speaks casually and uses slang. Be fun, supportive, and use lots of emojis. Keep responses short and natural.
```

**Tech Expert:**
```
.ar personality You are a technical expert who explains complex topics in simple terms. Be patient and provide step-by-step guidance when needed.
```

## Technical Details

### Anti-Ban Configuration

The bot includes several configurable anti-ban measures to make responses appear more human-like:

#### Delay Settings
- **AUTO_RESPONDER_MIN_DELAY** (default: 1000ms): Minimum delay before responding
- **AUTO_RESPONDER_MAX_DELAY** (default: 3000ms): Maximum delay before responding
- The bot waits a random time between these values before starting to type

#### Typing Simulation
- **AUTO_RESPONDER_TYPING_SPEED** (default: 50): Characters per second typing speed
- **AUTO_RESPONDER_MAX_TYPING_TIME** (default: 10000ms): Maximum typing indicator duration
- The bot calculates typing time based on response length, capped at max time
- Adds ±20% randomness to typing duration for natural variation

#### Rate Limiting
- **AUTO_RESPONDER_RATE_LIMIT** (default: 5): Maximum responses within time window
- **AUTO_RESPONDER_RATE_WINDOW** (default: 60000ms): Time window for rate limiting (60 seconds)
- Prevents the bot from responding too frequently
- Automatically cleans up old entries from rate limit history

#### How Anti-Ban Works

1. **User sends message** → Bot waits random delay (1-3 seconds)
2. **Show typing indicator** → Bot appears to be "typing"
3. **Generate AI response** → Process happens in background
4. **Simulate typing time** → Based on response length (50 chars/sec)
5. **Send response** → After realistic typing simulation
6. **Clear typing** → Mark as "available" again

This makes the bot's responses indistinguishable from a human typing on their phone.

### Database Models

#### Conversation Model
Stores conversation context for each chat:
- `jid`: Chat identifier
- `context`: Array of messages (user and assistant)
- `lastMessageTime`: Timestamp of last message

#### AutoResponder Model
Stores auto-responder settings:
- `ignoreNumbers`: Comma-separated list of numbers to ignore
- `personality`: AI personality prompt
- `enabled`: Whether auto-responder is active

### Conversation Management

- **Maximum Context**: 10 messages per conversation
- **Context Timeout**: 30 minutes
- **Context Format**: Messages are stored as `{ role, content }` objects
- **Auto-Cleanup**: Old contexts are automatically cleared

### Security Features

- Only responds to private messages (not groups)
- Respects ignore list (both ENV and database)
- Requires sudo access for management commands
- Doesn't respond to own messages
- Prevents duplicate processing with message tracking
- **Rate limiting** to prevent spam detection
- **Natural delays** to avoid automation detection
- **Typing simulation** for human-like behavior

## Usage Examples

### Example 1: Basic Setup

1. Get Gemini API key from https://aistudio.google.com/app/apikey
2. Add to `config.env`:
   ```env
   GEMINI_API_KEY=your_api_key
   AUTO_RESPONDER_ENABLED=true
   ```
3. Restart bot
4. Send a private message to the bot number
5. Bot will respond automatically

### Example 2: Business Bot

1. Set professional personality:
   ```
   .ar personality You are a customer service representative for XYZ Company. Be professional, helpful, and provide accurate information about our products and services.
   ```
2. Enable auto-responder:
   ```
   .ar on
   ```
3. Add VIP numbers to ignore list (they should talk to humans):
   ```
   .ar ignore add 1234567890
   ```

### Example 3: Personal Assistant

1. Set friendly personality:
   ```
   .ar personality You are my personal assistant. Help me stay organized, remind me of tasks, and chat with my friends when I'm busy. Be friendly and casual.
   ```
2. Enable auto-responder:
   ```
   .ar on
   ```
3. Bot will handle your private messages automatically

## Troubleshooting

### Auto-responder not working

1. Check if enabled: `.ar status`
2. Verify Gemini API key is set in `config.env`
3. Check if sender is in ignore list: `.ar ignore list`
4. Ensure message is private (not group)
5. Check bot logs for errors

### Status viewer not working

1. Verify `AUTO_STATUS_REACT=true` in `config.env`
2. Restart bot after config changes
3. Check bot logs for errors
4. Ensure bot has permission to view statuses

### Context not working

1. Context expires after 30 minutes
2. Context is cleared after timeout
3. Each chat has separate context
4. Maximum 10 messages per context

### Rate limit triggering too often

1. Increase **AUTO_RESPONDER_RATE_LIMIT** (e.g., from 5 to 10)
2. Increase **AUTO_RESPONDER_RATE_WINDOW** (e.g., from 60000 to 120000 for 2 minutes)
3. Check logs to see rate limit messages

### Responses are too slow

1. Decrease **AUTO_RESPONDER_MIN_DELAY** (e.g., from 1000 to 500)
2. Decrease **AUTO_RESPONDER_MAX_DELAY** (e.g., from 3000 to 1500)
3. Increase **AUTO_RESPONDER_TYPING_SPEED** (e.g., from 50 to 100)

### Responses are too fast (risk of ban)

1. Increase **AUTO_RESPONDER_MIN_DELAY** (e.g., from 1000 to 2000)
2. Increase **AUTO_RESPONDER_MAX_DELAY** (e.g., from 3000 to 5000)
3. Decrease **AUTO_RESPONDER_TYPING_SPEED** (e.g., from 50 to 30)
4. Decrease **AUTO_RESPONDER_RATE_LIMIT** (e.g., from 5 to 3)

## Multilingual Support

All auto-responder commands and messages support these languages:
- English (en)
- French (fr)
- Spanish (es)
- Arabic (ar)
- Bengali (bn)
- Hindi (hi)
- Indonesian (id)
- Russian (ru)
- Turkish (tr)
- Urdu (ur)

Set your language in `config.env`:
```env
LANG=en
```

## Performance Considerations

- Each auto-response makes an API call to Gemini
- Conversation context is stored in database
- Context is cached in memory during conversation
- Old contexts are auto-cleaned to save space

### Recommended Anti-Ban Settings

**Conservative (Safest - Slowest):**
```env
AUTO_RESPONDER_MIN_DELAY=2000        # 2-5 seconds before typing
AUTO_RESPONDER_MAX_DELAY=5000
AUTO_RESPONDER_TYPING_SPEED=30       # Slow typing (30 chars/sec)
AUTO_RESPONDER_MAX_TYPING_TIME=15000 # Up to 15 seconds typing
AUTO_RESPONDER_RATE_LIMIT=3          # Max 3 messages per minute
AUTO_RESPONDER_RATE_WINDOW=60000
```

**Balanced (Default - Recommended):**
```env
AUTO_RESPONDER_MIN_DELAY=1000        # 1-3 seconds before typing
AUTO_RESPONDER_MAX_DELAY=3000
AUTO_RESPONDER_TYPING_SPEED=50       # Normal typing (50 chars/sec)
AUTO_RESPONDER_MAX_TYPING_TIME=10000 # Up to 10 seconds typing
AUTO_RESPONDER_RATE_LIMIT=5          # Max 5 messages per minute
AUTO_RESPONDER_RATE_WINDOW=60000
```

**Aggressive (Faster - Higher Risk):**
```env
AUTO_RESPONDER_MIN_DELAY=500         # 0.5-1.5 seconds before typing
AUTO_RESPONDER_MAX_DELAY=1500
AUTO_RESPONDER_TYPING_SPEED=80       # Fast typing (80 chars/sec)
AUTO_RESPONDER_MAX_TYPING_TIME=8000  # Up to 8 seconds typing
AUTO_RESPONDER_RATE_LIMIT=10         # Max 10 messages per minute
AUTO_RESPONDER_RATE_WINDOW=60000
```

**Note:** Start with Conservative or Balanced settings. Only increase speed after monitoring for several days without issues.

## Privacy & Security

- Conversation history is stored locally in your database
- No data is sent to third parties except Gemini AI
- You can clear conversation history anytime
- Ignore list prevents unwanted auto-responses
- Only sudo users can manage auto-responder settings

## API Costs

Gemini API has a free tier and paid tiers:
- Free tier: 60 requests per minute
- Paid tier: Higher limits

Monitor your usage at https://console.cloud.google.com/

## Future Enhancements

Potential improvements:
- Group chat support with mention detection
- Scheduled auto-responses
- Response templates
- Analytics and usage statistics
- Multiple personalities per contact
- Voice message support
