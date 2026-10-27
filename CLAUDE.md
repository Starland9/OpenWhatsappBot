# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Plain CommonJS JavaScript: no build step, no test suite, no linter configured. Yarn 4 is vendored (`.yarn/releases`, `.yarnrc.yml`). Node >= 24 (per `package.json` engines; the README's "Node 20" is outdated). FFmpeg must be on the PATH for media plugins.

```bash
yarn install            # postinstall re-adds sharp if its native binary fails to load
yarn dev                # node index.js — prints a QR code in the terminal on first login
yarn start / yarn stop  # run under PM2 (ecosystem.config.js: 500M restart, --expose-gc)
yarn panel              # panel.js: HTTP server (/health, /metrics, status page) + bot, for panel hosts
docker compose up -d    # Dockerfile runs `node --expose-gc index.js`; volumes for sessions/, db/, data/
```

Verify a change by running `yarn dev` and sending the command from WhatsApp. `LOG_LEVEL=debug` shows plugin registration and command dispatch; `BAILEYS_LOG_LVL` controls Baileys' own logger (default `silent`).

Configuration comes from `config.env` (copy `config.env.example`), loaded by `config.js` via dotenv. Every setting is read through `config.js`. Boolean flags are true only when the value is the exact string `"true"`. `BOT_LANG` defaults to `fr`.

## Architecture

### Boot (`index.js`)
memory manager → `DATABASE.authenticate()` → `sync()` → `PluginLoader.loadAll()` → `WhatsAppClient.initialize()`. A global axios timeout of 30s is set here, and `uncaughtException`/`unhandledRejection` are logged instead of crashing the process.

### WhatsApp client (`lib/baileys/client.js`)
Wraps Baileys v7 (rc). Baileys is loaded with `require`, falling back to `import()` for ESM builds, and exports are resolved defensively (`tryGet`). `lib/baileys/mediaAdapter.js` hides download/reupload API differences between Baileys versions. Auth is multi-file under `sessions/main/`; delete that folder to re-pair. The client reconnects itself after 3s unless logged out, and re-emits Baileys events as `messages`, `messages.update`, `groups.update`, `group-participants.update`, `ready`. Auto status view/react happens inside the client. `group-participants.update` is emitted but nothing subscribes to it.

### Message pipeline (`processMessage` in `index.js`)
Messages are processed in batches of `MESSAGE_CONCURRENCY_LIMIT`. For each message, in order:
1. `status@broadcast` → `statusSaver`, then stop.
2. Wrap in `Message` and cache it for anti-delete (`setImmediate`).
3. `viewOnceHandler` (does not stop processing).
4. If quoted or an interactive (button/list) reply: first `quiz.handleReply`, then **every** loaded plugin's `handleButtonReply` (or `handleReply`) is called with the message; the first one to return `true` consumes it. Button `id`s become `message.body`, so these handlers must return `false` quickly for ids they don't own.
5. `trackmessages.trackMessage(message)` (stats/levels/leaderboard).
6. Stickers whose `fileSha256` is bound in `StickerCommand` are rewritten to `PREFIX + command` and executed silently.
7. Non-command, non-`fromMe` messages → `autoResponderHandler` (Gemini); stop if it replied.
8. `executeCommand(message)` from the registry.

**`panel.js` contains its own, older copy of `processMessage`** without steps 1, 4 (global dispatcher) and 5. Any pipeline change made in `index.js` must also be made there, or panel deployments will behave differently.

### Plugins (`plugins/*.js`, `lib/plugins/`)
`loader.js` `require`s every `plugins/*.js` and registers those that export `command` + `execute`. Files without `command` (e.g. `plugins/buttons.js`, the shared `sendQuickReplies`/`sendList` helper wrapping `@ryuu-reinzz/button-helper`) are silently skipped. Plugins may `require` each other: `buttons`, `trackmessages` (`computeLevel`), and `banchat` are imported this way.

```js
module.exports = {
  command: { pattern: "cmd|alias", desc, type, fromMe, onlyGroup, onlyPm },
  async execute(message, argsString) {},          // argsString = text after the command word
  async handleButtonReply(message) { return false }, // optional, see pipeline step 4
};
```

Registry behaviour (`lib/plugins/registry.js`) that matters:
- Matching builds `new RegExp(`^${pattern}$`, "i")` from the raw pattern, so `"gpt|ai"` becomes `^gpt|ai$` and matches *any* word that starts with `gpt` or ends with `ai`. Regex metacharacters in patterns are live. The first match in registration order wins.
- `fromMe: true` means sudo-only (`message.isSudo()` compares the sender against the `SUDO` list, given as bare numbers or full JIDs). It does not mean "sent by the bot".
- `ownerOnly` is checked in `executeCommand`, but `registerCommand` doesn't copy it into the stored entry, so it is never enforced. Plugins that use it (`update`, `exportcontacts`) also check `isSudo()` themselves; do the same.
- An exception thrown from `execute` is caught: the user gets `❌ Error: <message>` and the first `SUDO` number is DM'd the stack trace.
- `getPlugin(name)` looks up by any alias; `getPlugins()` returns deduplicated plugin objects.

Prefer the `Message` helpers (`lib/classes/Message.js`: `reply`, `send*`, `react`, `downloadMedia`, `isSudo`, `isBotAdmin`, `isSenderAdmin`, `kick/add/promote/demote`, `sendPoll`, …) over calling the socket. Use `message.client.getSocket()` when raw Baileys is needed (e.g. for the button helpers). Check `await message.isBotAdmin()` before group admin actions.

### Database (`lib/database/`)
Sequelize. Uses Postgres when `DATABASE_URL` contains `postgres` (SSL on unless `DATABASE_SSL=false`); otherwise SQLite at `DATABASE_URL` or `./database.db`. Every file in `lib/database/models/` exports `(sequelize) => Model` and is auto-loaded and exported under its filename (`const { Group, Warn } = require("../lib/database")`). There are no migrations: `DATABASE.sync({ alter: true })` runs on every boot, so schema changes are applied by editing the model. Hot settings read on every message (anti-delete, auto-responder) go through `lib/utils/settingsCache.js` (5-minute TTL).

### i18n (`lib/utils/language.js`, `lang/*.json`)
`getLang("plugins.<name>.<key>", ...args)` fills `{0}`, `{1}` placeholders. If a key is missing in the active language it falls back to `en`, then returns the key itself. Language files have two top-level sections, `plugins` and `extra`. Only `en.json` and `fr.json` are complete; the other locales are partial and rely on the fallback. Add new keys to at least `en.json` and `fr.json`. Many older plugins still hard-code strings, and `getLang` is evaluated at require time when it is used in `command.desc`.

## Repo conventions and references

- Commits use Conventional Commit prefixes (`feat:`, `fix:`, `style:`) with descriptions mostly in French.
- Plugin authoring guides: `docs/PLUGIN_CREATION_DOC.md`, `.github/agents/plugin-creator.md` (French), `.github/copilot-instructions.md`.
- Spec Kit is installed (`.specify/`, `speckit-*` skills in `.claude/skills/`); `.specify/memory/constitution.md` is still the unfilled template.
- `docs-site/` is a standalone static documentation SPA, unrelated to the bot runtime.
- Gitignored runtime state: `sessions/`, `database.db`, `config.env`, `data/`, `logs/`, `media/temp`.
