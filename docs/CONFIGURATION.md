# 🔧 Configuration

All settings come from `config.env` (copy `config.env.example`, which documents every option), loaded by `config.js` through dotenv. Boolean flags are true only for the exact string `"true"`. An empty value is the same as an unset one.

## Where settings live

- **`config.env`** is the starting point. Only `SUDO` (your own number) is really needed.
- **The [admin panel](ADMIN_PANEL.md)** (Settings page) edits nearly every setting and applies it on the next message. A value saved in the panel **wins over `config.env`**; "Reset" in the panel goes back to the file value. API keys saved there are stored encrypted.
- **Start-up settings** are only read when the bot starts, so the panel shows them read-only: `ADMIN_PANEL`, `PANEL_*`, `LOG_FORMAT`, `SUPERVISED`, `UPDATE_CHECK`, `DATABASE_*`, `YTDLP_PATH`, `KEEP_ALIVE_INTERVAL`.
- **Settings without effect.** 21 old settings (`SESSION_ID`, `AUTO_READ`, `VPS`, `HEROKU_*`, `KOYEB_*`, `RENDER_*`, ...) are read by no code. They stay at the end of `config.env.example` under "No effect in this version" so an existing file stays valid.
- Debugging: `LOG_LEVEL=debug` shows plugin registration and command dispatch; `BAILEYS_LOG_LVL` controls Baileys' own logger (default `silent`).

## Environment variables

The most useful ones; see `config.env.example` for the full list.

| Variable | Description | Default |
|----------|-------------|---------|
| `PREFIX` | Command prefix | `.` |
| `SUDO` | Owner numbers (comma-separated, digits with the country code). Empty = nobody can use owner commands | - |
| `ALWAYS_ONLINE` | Keep bot always online | `false` |
| `AUTO_STATUS_VIEW` | Auto-view statuses | `false` (`true` in the example file) |
| `AUTO_STATUS_REACT` | Auto-react to statuses | `false` |
| `OPENAI_API_KEY` | OpenAI API key for ChatGPT | - |
| `OPENAI_MODEL` | Model used by `.gpt` | `gpt-4o-mini` |
| `GEMINI_API_KEY` | Google Gemini API key | - |
| `GEMINI_MODEL` | Model used by `.gemini` and the auto-responder | `gemini-2.5-flash` |
| `BOT_LANG` | Bot language (`fr` or `en` are complete) | `fr` |
| `TIMEZONE` | Time zone of reminders | `UTC` |
| `DATABASE_URL` | PostgreSQL URL (optional) | SQLite |
| `LOG_LEVEL` | Logging level | `info` |
| `ADMIN_PANEL` | Admin panel on/off (only `false` turns it off) | `true` |
| `PANEL_HOST` / `PANEL_PORT` | Panel address and port (`HOST` and `PORT` are accepted as aliases) | auto (`127.0.0.1`, `0.0.0.0` in a container or on a host that sets `PORT`) / `3000` |
| `PANEL_PUBLIC_URL` | Public origin of the panel (setup link, accepted `Origin`) | - |
| `PANEL_TRUST_PROXY` | Reverse proxies whose `X-Forwarded-*` headers are trusted | - (never trusted) |
| `PANEL_TOKEN` | Secret for `POST /api/restart` (empty = endpoint answers 403) | - |
| `LOG_FORMAT` | `pretty` or `json` | `pretty` |
| `SUPERVISED` | Who restarts the bot after an update: `auto`, `true`, `false` | `auto` |
| `UPDATE_CHECK` | Background check for a newer version (`false` disables it) | `true` |

Other groups in `config.env.example`: API keys of optional services (weather, images, news, music, Reddit, ...), download limits (`DOWNLOAD_TIMEOUT`, `MAX_UPLOAD`), group messages (`ANTILINK_MSG`, `WARN_*`), sticker pack name, and internal tuning (cache and memory intervals, see [CPU_OPTIMIZATION_GUIDE.md](CPU_OPTIMIZATION_GUIDE.md)).

`BOT_LANG` and the translation system are explained in [LANGUAGE_SYSTEM.md](LANGUAGE_SYSTEM.md).

## Auto Status Viewer

Automatically view and/or react to WhatsApp statuses with random emojis.

```env
AUTO_STATUS_VIEW=true      # Auto-view statuses
AUTO_STATUS_REACT=false    # Auto-react to statuses
STATUS_EMOJIS=😀,👍,❤️,🔥,💯,✨,🎉,👏,💪,🙌
```

- `AUTO_STATUS_VIEW`: automatically mark statuses as viewed.
- `AUTO_STATUS_REACT`: automatically react to statuses with random emojis from the configured list.
- Both features can be enabled independently, and duplicate reactions are prevented with smart tracking.
- Forwarding the statuses of chosen contacts to the owners is a separate feature (`AUTO_STATUS_SAVE`, `STATUS_SAVE_LIST`, `.statussave`); the two variables only seed `data/status_save.json` the first time it is created.

## AI Auto-Responder (Gemini)

Intelligent auto-responder that uses Google Gemini AI with conversation context management.

```env
AUTO_RESPONDER_ENABLED=true
AUTO_RESPONDER_IGNORE_NUMBERS=1234567890,0987654321
AUTO_RESPONDER_PERSONALITY=You are a helpful and friendly assistant.
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash
```

The enabled switch, the ignored numbers and the personality only **seed the database the first time**; afterwards change them with the `.ar` command or in the panel.

**Commands (owner only):**

- `.ar status` - View current settings
- `.ar on/off` - Enable/disable auto-responder
- `.ar ignore add <number>` - Add number to ignore list
- `.ar ignore remove <number>` - Remove number from ignore list
- `.ar ignore list` - Show ignored numbers
- `.ar ignore clear` - Clear ignore list
- `.ar personality <text>` - Set AI personality

**Features:**

- Context-aware conversations (remembers last 10 messages)
- 30-minute context timeout
- Customizable AI personality
- Ignore list management
- Private messages only
- Typing indicator
- Anti-ban measures (random delays, human-like typing speed, rate limit): `AUTO_RESPONDER_MIN_DELAY`, `AUTO_RESPONDER_MAX_DELAY`, `AUTO_RESPONDER_TYPING_SPEED`, `AUTO_RESPONDER_MAX_TYPING_TIME`, `AUTO_RESPONDER_RATE_LIMIT`, `AUTO_RESPONDER_RATE_WINDOW`

See [AUTO_RESPONDER_GUIDE.md](AUTO_RESPONDER_GUIDE.md) for detailed documentation (personalities, anti-ban tuning, troubleshooting).

## Security notes

- No obfuscated code - fully transparent and auditable.
- Official Baileys library - no custom forks.
- Environment-based configuration - no hardcoded secrets; `config.env` is git-ignored. Do not commit it.
- Permission system - sudo and admin controls, enforced by the command registry before a command runs. An empty `SUDO` refuses every owner command.
- Input validation - sanitized user inputs.
- Admin panel - password (scrypt) with 24 h idle / 7 day sessions, per-origin login throttling, CSRF and `Origin` checks, strict CSP with no third-party request, API keys encrypted at rest, secrets masked in every response and log, off the network by default (`127.0.0.1`). See [ADMIN_PANEL.md](ADMIN_PANEL.md).
- Logs and error replies never contain API keys: users only see generic messages, and the stack goes to the owners.
- Runtime state (`sessions/`, `database.db`, `config.env`, `data/`, `logs/`) is git-ignored; the WhatsApp session in `sessions/` lets whoever holds it take over the number, so protect it like a password.
