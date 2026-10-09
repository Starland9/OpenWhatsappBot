# Copilot Instructions for OpenWhatsappBot

These guidelines help AI coding agents work effectively in this codebase. Focus on the actual patterns and workflows used here.

## Architecture Overview

- **Entry point:** `index.js` boots the bot, initializes DB (`lib/database`), loads plugins (`lib/plugins/loader.js`), and starts the WhatsApp client (`lib/baileys/client.js`).
- **WhatsApp client:** `lib/baileys/client.js` wraps Baileys with events (`messages`, `messages.update`, groups). It auto-reconnects, binds an in-memory store, and handles status auto-view/react based on `config` flags.
- **Message abstraction:** `lib/classes/Message.js` provides helpers: `reply`, `sendImage|Video|Sticker|Audio`, `react`, media download, and group admin utilities.
- **Plugins system:** Files under `plugins/*.js` export `{ command, execute }`. Loader registers each command via `lib/plugins/registry.js`, which matches messages with `config.PREFIX`, checks permissions (`fromMe`, `onlyGroup`, `onlyPm`), and calls `execute(message, argsString)`.
- **Utilities:** `lib/utils/*` includes auto-responder, view-once, anti-delete, memory manager, language. `language.js` reads `lang/*.json` and exposes `getLang(key, ...args)`.
- **Config & runtime:** `config.js` centralizes env-driven flags and keys. Sessions are stored under `sessions/<sessionId>` using Baileys multi-file auth.

## Key Conventions

- **Command definition:**
  ```js
  module.exports = {
    command: {
      pattern: "tts",
      desc: "Convert text to speech",
      type: "converter",
      fromMe: false,
      onlyGroup: false,
      onlyPm: false,
    },
    async execute(message, argsString) {
      /* use Message helpers */
    },
  };
  ```
- **Prefix:** All commands start with `config.PREFIX` (default `.`). Registry splits `pattern` by `|` to support aliases.
- **Args handling:** Registry passes a single `argsString` containing the remainder of the message after the command. Plugins should parse internally.
- **Permissions:** Use `message.isSudo()` for sudo checks. For group-only commands, set `onlyGroup: true` and test `message.isGroup`.
- **Translations:** Call `const { getLang } = require("../lib/utils/language")` in plugins/utilities and use dot keys present in `lang/*.json`.

## Typical Data Flow

1. Baileys emits `messages.upsert` → client re-emits `messages`.
2. `index.js` batches by `MESSAGE_CONCURRENCY_LIMIT` and calls `processMessage`.
3. Message handlers run in order: view-once → quiz reply hook (if any) → sticker command binding → auto-responder → registry command execution.
4. Plugins use `Message` helpers to interact with WhatsApp.

## Development Workflows

- **Run in dev:**
  - `yarn` to install deps.
  - `yarn dev` to start `index.js` (prints QR for login).
- **PM2 managed:**
  - `yarn start` to launch with PM2.
  - `yarn stop` to stop the PM2 process.
- **Docker:** Use `Dockerfile` + `docker-compose.yml`; entry uses `pm2-runtime` via `yarn docker` script.
- **Environment:** Edit `config.env` (see `config.env.example`). `config.js` reads it automatically. Requires Node >= 20.
- **Database:**
  - Defaults to SQLite (`database.db`) or Postgres via `DATABASE_URL`.
  - Models auto-loaded from `lib/database/models`; synced at boot with `alter: true`.

## Important Flags (from `config.js`)

- Behavior: `ALWAYS_ONLINE`, `AUTO_READ`, `ANTI_DELETE`, `ENABLE_MESSAGE_REACTIONS`.
- Status: `AUTO_STATUS_VIEW`, `AUTO_STATUS_REACT`, `STATUS_EMOJIS`.
- Auto-responder: `AUTO_RESPONDER_*` rate limits and timings.
- Performance: `MESSAGE_CONCURRENCY_LIMIT`, cache/memory intervals.

## Plugin Examples

- **TTS (`plugins/tts.js`):** Parses optional language `{xx}` from args, truncates input to 200 chars, fetches audio via `google-tts-api`, then `message.sendAudio(buffer, { ptt: false })`.
- **Sticker commands:** Sticker hashes map to commands via DB (`StickerCommand`); when a sticker arrives, registry executes the bound command silently.

## Integration Points

- **Baileys:** Core messaging API; respect `getSocket()` contract from `Message`.
- **Sequelize:** DB configured from env; prefer adding models under `lib/database/models` exporting a factory `(DATABASE) => model` (see existing files).
- **External APIs:** Keys in `config.js` (OpenAI/Gemini/Groq/etc.). Use existing plugins as references for HTTP (`axios`) and rate limiting where applicable.

## Coding Patterns to Follow

- Use `pino` for logging with `process.env.LOG_LEVEL`.
- Avoid long blocking operations inside `execute`; prefer short awaits and batched work if needed.
- Keep command files small, self-contained, and rely on `Message` helpers instead of accessing Baileys directly.
- Read feature flags from `config.js` rather than hard-coding behavior.

## Common Pitfalls

- Don’t access `message.data.message` directly; use `Message` helpers and content extraction already done in the class.
- When adding new translations, ensure keys exist in `lang/en.json`; other locales can fallback.
- For group admin actions, check `await message.isBotAdmin()` first to avoid failures.

## Where to Look First

- `index.js` for boot flow.
- `lib/plugins/registry.js` for command matching rules.
- `lib/classes/Message.js` for WhatsApp interactions.
- `config.js` + `config.env.example` for runtime behavior knobs.
- `plugins/` for concrete command patterns and best practices.
