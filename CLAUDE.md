# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Plain CommonJS JavaScript: no build step, no linter. Yarn 4 is vendored (`.yarn/releases`, `.yarnrc.yml`). Node >= 24 (`package.json` engines): run `nvm use 24` first. System binaries: `ffmpeg` (media plugins) and `yt-dlp` (`youtube`, `insta`, `dl`; keep it recent, the Dockerfile installs the latest and `.update` runs `yt-dlp -U`).

```bash
yarn install            # no postinstall anymore
yarn test               # node --test --test-force-exit "test/**/*.test.js": ~10 s, no network, no WhatsApp
node --test --test-force-exit test/registry.test.js   # one test file (BOT_LANG=en for English; default fr)
node tools/check-unused-deps.js   # must print "0 unused dependencies"
yarn dev                # node index.js — prints a QR code in the terminal on first login
yarn start / yarn stop  # run under PM2 (ecosystem.config.js: 500M restart, --expose-gc)
yarn panel              # panel.js: HTTP server (/health, /metrics, status page) + bot, for panel hosts
docker compose up -d    # Dockerfile runs `node --expose-gc index.js`; volumes for sessions/, db/, data/
```

`LOG_LEVEL=debug` shows plugin registration and command dispatch; `BAILEYS_LOG_LVL` controls Baileys' own logger (default `silent`). Configuration comes from `config.env` (copy `config.env.example`), loaded by `config.js` via dotenv; every setting is read through `config.js`. Boolean flags are true only for the exact string `"true"`. `BOT_LANG` defaults to `fr`. `yarn test` cannot cover buttons, anti-delete or welcome/goodbye on a real device: see the checklist in `docs/AUDIT_COMMANDES.md` section 7.

## Architecture

### Boot and client
`index.js` and `panel.js`: memory manager → `DATABASE.authenticate()` → `sync()` → `PluginLoader.loadAll()` → `attachHandlers(client)` → `client.initialize()`. `panel.js` only adds the HTTP server and counters (`attachHandlers(client, { onMessageProcessed, onError })`). `lib/baileys/client.js` wraps Baileys v7 (rc14; the 7.x line only exists as a prerelease), loaded with `require` then `import()` fallback; `mediaAdapter.js` hides download API differences. Auth is multi-file under `sessions/main/` (delete it to re-pair); it reconnects after 3s unless logged out and re-emits `messages` (notify batches only), `messages.update`, `groups.update`, `group-participants.update`, `ready`. Auto status view/react lives in the client.

### Pipeline (`lib/core/pipeline.js`, the only copy)
`processMessage` never throws; `attachHandlers` also wires `messages.update` (anti-delete), `group-participants.update` (`onGroupParticipants` hooks) and `ready` (`onReady` hooks). Per message:

1. `status@broadcast` → `statusSaver`, stop.
2. Wrap in `Message`, set `isCommand`, cache for anti-delete.
3. Disabled-chat gate (`BannedChat`): stop, except `unban` from an owner.
4. `viewOnceHandler` (never stops).
5. Quoted or interactive reply: a bare number quoting a message known to `buttonRegistry` becomes its button id; then each plugin's `handleButtonReply` (legacy `handleReply`) runs and the first truthy return consumes it. A prefixed command skips this step.
6. `onMessage` hooks, stop on truthy.
7. Sticker bound by `setcmd` → body becomes `PREFIX + command`.
8. Plain non-`fromMe` message → `autoResponderHandler` (not awaited), stop.
9. `registry.executeCommand`.

Each hook is isolated in try/catch. Pipeline changes go in this file only.

### Plugins (`plugins/*.js`, `lib/plugins/`)
`loader.js` requires `plugins/*.js` in sorted order and registers modules exporting `command` + `execute` and/or hooks. Modules with neither (`buttons.js`, the empty `pollplus.js`) are skipped; `trackmessages.js` is hook-only.

```js
module.exports = {
  command: { pattern: "name|alias", desc: getLang("plugins.x.desc"), type, fromMe, ownerOnly, onlyGroup, onlyPm, adminOnly },
  async execute(message, argsString, ctx) {},   // ctx = { command, rawArgs }; `this` is the plugin module
  async handleButtonReply(message) { return false }, // true only for your own ids
  async onMessage(message) {},                  // cheap and cached; truthy return consumes the message
  async onGroupParticipants(update, client) {}, // add/remove/promote/demote
  async onReady(client) {},                     // idempotent: runs on every (re)connection
  hookPriority: { onMessage: 20 },              // lower first, default 100, then load order
};
```

- Matching is exact: `pattern` is a `|` list of **literal** lower-case aliases in an alias map; the word after the prefix, lower-cased, must equal one (no regex). A duplicate alias logs a warning and the first registered keeps it.
- The registry enforces `fromMe`/`ownerOnly` (synonyms; owner = `SUDO`, empty `SUDO` refuses everybody), `onlyGroup`, `onlyPm`, `adminOnly` (group admin or owner) before `execute`. Don't re-check them in the plugin; only `isBotAdmin()` before admin actions.
- `argsString` is whitespace-collapsed: use `ctx.rawArgs` to keep newlines and `ctx.command` to know which alias matched.
- An exception from `execute` gives the user `common.error` (never `error.message`) and DMs the stack to the owners.
- `onMessage` order: role (10) → trackmessages (20) → afk (30) → notify (40) → addfilter (90, consumes). Observers stay before consumers.
- Button ids are `<plugin>:<action>[:<nonce>][:<arg>]`, never with JIDs (chat = `message.jid`). Send interactive messages through `plugins/buttons.js` (`sendQuickReplies`, `sendList`, `sendConfirm`, `sendPaginatedList`): it adds a numbered text fallback and records the ids in `lib/utils/buttonRegistry.js` (TTL 1 h) so a quoted number works. Clicks arrive as native-flow `paramsJson`; `Message` sets `body` to the id.

### `Message` and `lib/utils/`
Prefer `Message` helpers (`lib/classes/Message.js`) over the raw socket: `reply`, `react`, `send*`, `sendAudioFile` (sniffs type), `sendVoice` (ogg/opus), `getQuotedMedia({ maxBytes })` (null, or `{buffer,type,mimetype,fileLength}`; checks size before downloading), `getQuotedText()`, `quoted.key`, `isSudo`, `isBotAdmin`, `isSenderAdmin`, `kick/add/promote/demote`. `sender` is the phone-number JID when Baileys gives one, `senderLid` the LID; sudo and admin checks match both.
- `permissions.js`: `getOwnerJids`, `guardTarget(message, jid)` (refuses bot/owner/creator/self), `assertParticipantResult(res)` (`groupParticipantsUpdate` returns per-target `status`, success is `"200"`).
- `http.js`: `fetchJson`/`fetchBuffer` (30 s timeout, `MAX_UPLOAD` cap), `withTimeout`, `classifyError(err, { hasKey })` + `replyKeyFor(kind)` → `common.service_unavailable|not_configured|rate_limited`; `safeLog(err)` (never log an axios error: it holds API keys). Answer a missing key with `common.not_configured` before calling.
- `ffmpeg.js` (`runFfmpeg`, `toOpusVoice`; `execFile`, no shell), `media.js#withTempDir`, `downloader.js` (yt-dlp), `gameStore.js` (`createStore`: one game per chat, TTL, nonce), `cooldown.js` (`hit(user, key, ms)` → remaining ms), `scheduler.js` (persisted reminders, one 20 s loop started by `reminder.onReady`).
- `settingsCache.js`: `getOrLoad(key, loader, ttl)`, 5-minute TTL; keys `view_once`, `anti_delete`, `auto_responder`, `banned_chats`, `sticker_cmds`, `afk_users`, `filters:<jid>`, `group:<jid>`, `roles:<jid>`. **A setter that writes a cached setting must call `settingsCache.invalidate(key)`.**

### Database (`lib/database/`)
Sequelize: Postgres when `DATABASE_URL` contains `postgres` (SSL unless `DATABASE_SSL=false`), else SQLite at `DATABASE_URL` or `./database.db` (`:memory:` in tests). Each file in `models/` exports `(sequelize) => Model` and is auto-loaded under its filename. `sync()` is **additive**, not `alter: true` (which turned composite keys into per-column UNIQUE on SQLite): it creates missing tables and indexes, adds missing nullable/defaulted columns, and repairs SQLite tables damaged by the old `alter`. It never alters or drops a column, and a new unique index on an existing table is not allowed; a column change needs a hand-written migration. The Postgres path is untested. Economy updates are atomic (`UPDATE ... WHERE balance >= :n`, transactions); stats use `increment`.

### i18n (`lib/utils/language.js`, `lang/*.json`)
Every user-facing string goes through `getLang("plugins.<name>.<key>", ...args)` (`{0}`, `{1}`); shared text lives under `common.*`. Never `getLang(k) || "fallback"` (a missing key returns the key). `en` and `fr` must have the **same keys**; other locales fall back to `en`. `command.desc` is evaluated at require time. Add keys in a fragment `specs/001-audit-fix-commands/i18n/<plugin>.json` (`{ "en": { "plugins.x.k": "…" }, "fr": {…} }`, flat dot keys) then run `node tools/merge-i18n.js` (`--dry-run` first), or edit both `lang/en.json` and `lang/fr.json`. `test/i18n.test.js` fails on a missing key or a literal text passed to `reply()`/`sendMessage`; a deliberate exception takes `// i18n-ignore` on the same or previous line.

### Tests (`test/`)
`node:test` with `test/helpers/fakes.js` (`setupEnv`, `fakeSocket`, `makeMessage`, `stubNetwork`) and an in-memory database. They load every plugin and check alias uniqueness and exact matching, permission refusals, a no-argument call of every command, the pipeline, hook order, database sync and translations. New commands are picked up automatically.

## Repo conventions and references

- Commits use Conventional Commit prefixes (`feat:`, `fix:`, `docs:`, `test:`) with descriptions mostly in French.
- `docs/AUDIT_COMMANDES.md` is the per-command report (status, access, services, syntax changes, manual checklist): update a command's row when its behavior changes. Contracts and decisions: `specs/001-audit-fix-commands/`.
- Plugin guides (`docs/PLUGIN_CREATION_DOC.md`, `.github/agents/plugin-creator.md`, `.github/copilot-instructions.md`) predate the exact-matching registry: follow this file where they differ.
- Spec Kit is installed (`.specify/`, `speckit-*` skills in `.claude/skills/`); `.specify/memory/constitution.md` is still the unfilled template. `docs-site/` is a static docs SPA unrelated to the runtime.
- Gitignored runtime state: `sessions/`, `database.db`, `config.env`, `data/`, `logs/`, `media/temp`. `data/status_save.json` is ignored but still tracked (it holds phone numbers).
