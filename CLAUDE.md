# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Plain CommonJS JavaScript: no build step, no linter. Yarn 4 is vendored (`.yarn/releases`, `.yarnrc.yml`). Node >= 24 (`package.json` engines): run `nvm use 24` first. System binaries: `ffmpeg` (media plugins) and `yt-dlp` (`youtube`, `insta`, `dl`; keep it recent, the Dockerfile installs the latest and `.update` runs `yt-dlp -U`).

```bash
yarn install            # no postinstall anymore
yarn test               # node --test --test-force-exit "test/**/*.test.js": ~2,350 tests, ~20 s, no network, no WhatsApp
node --test --test-force-exit test/registry.test.js   # one test file (BOT_LANG=en for English; default fr)
node tools/check-unused-deps.js   # must print "0 unused dependencies"
yarn dev                # node index.js — prints a QR code and the admin panel setup link on first login
yarn start / yarn stop  # run under PM2 (ecosystem.config.js: 500M restart, --expose-gc)
yarn panel              # panel.js: same bot; with ADMIN_PANEL=false it keeps the legacy monitoring routes alone, for panel hosts
docker compose up -d    # Dockerfile runs `node --expose-gc index.js`; volumes for sessions/, db/, data/; /ping health check
node tools/admin-reset.js   # prints a single-use admin panel password reset link (bot may stay running)
node tools/merge-i18n.js / node tools/merge-panel-i18n.js   # merge translation fragments (see i18n)
node tools/measure-panel-memory.js   # RSS of the bot with and without the admin panel; exits 0 when the delta is under 50 MB (never reads config.env)
```

**Run every ad-hoc script, tool and agent command with `OWB_NO_CONFIG_ENV=1`**: `config.js` then skips `config.env` (the owner's secrets). `test/helpers/fakes.js#setupEnv` sets it for tests. Never read or print `config.env`, `sessions/`, `data/` or `database.db`.

`LOG_LEVEL=debug` shows plugin registration and command dispatch; `BAILEYS_LOG_LVL` controls Baileys' own logger (default `silent`). Configuration comes from `config.env` (copy `config.env.example`), loaded by `config.js` via dotenv, and from the admin panel; every setting is read through `config.js` (see "Settings"). Boolean flags are true only for the exact string `"true"`, except the opt-out ones (`ADMIN_PANEL`, `UPDATE_CHECK`, `DATABASE_SSL`, `ALERT_*`), which are false only for the exact string `"false"`. `BOT_LANG` defaults to `fr`. `yarn test` cannot cover buttons, anti-delete or welcome/goodbye on a real device: see the checklist in `docs/AUDIT_COMMANDES.md` section 7.

## Architecture

### Boot and client
`index.js` and `panel.js` are thin wrappers over `bootstrap({ mode: "normal" | "panel" })` in `lib/core/boot.js`, the single boot path: `logger.install()` and global error handlers → memory manager → `WhatsAppClient` + `BotRuntime` (`lib/core/botRuntime.js`: state, one in-process restart at a time, shutdown that never logs the device out) → HTTP server (`lib/admin/server.js`, started **before** the database so hosts see the port; a busy port is logged and never fatal) → `DATABASE.authenticate()` → `sync()` → `settingsStore.load()` → `languageManager.reload()` → `textOverrides.load()` → `PluginLoader.loadAll()` → `attachHandlers(client, runtime.handlerOptions)` → engines start (`stats`, `housekeeping`, `broadcaster`, `alerts`, `updater` checker) → `admin.start()` → `client.initialize()`. A change to boot order or collaborators goes in `boot.js` only (tests inject fakes through `options.deps`). `lib/baileys/client.js` wraps Baileys v7 (rc14; the 7.x line only exists as a prerelease), loaded with `require` then `import()` fallback; `mediaAdapter.js` hides download API differences. Auth is multi-file under `sessions/main/` (delete it, or use the panel's Pairing page, to re-pair); it reconnects after 3s unless logged out, pairs by QR or pairing code, restarts in-process through a generation token, and re-emits `messages` (notify batches only), `messages.update`, `groups.update`, `group-participants.update`, `ready`. Auto status view/react lives in the client.

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

Each hook is isolated in try/catch. `handleMessage` drops new messages while `maintenanceMode` is active (backup restore) and `processMessage` brackets its work with `maintenanceMode.begin()`; after step 3, `stats.count("messages" | "group_msgs")`. Pipeline changes go in this file only.

### Plugins (`plugins/*.js`, `lib/plugins/`)
`loader.js` requires `plugins/*.js` in sorted order and registers modules exporting `command` + `execute` and/or hooks. Modules with neither (`buttons.js`, the empty `pollplus.js`) are skipped; `trackmessages.js`, `knownchats.js` and `groupguard.js` are hook-only.

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
- The registry enforces `fromMe`/`ownerOnly` (synonyms; owner = `SUDO`, empty `SUDO` refuses everybody), then the command state (a command disabled in the panel, globally or in the group, answers `common.command_disabled`, owners included), then `onlyGroup`, `onlyPm`, `adminOnly` (group admin or owner) before `execute`. Don't re-check them in the plugin; only `isBotAdmin()` before admin actions.
- `argsString` is whitespace-collapsed: use `ctx.rawArgs` to keep newlines and `ctx.command` to know which alias matched.
- An exception from `execute` gives the user `common.error` (never `error.message`) and DMs the stack to the owners, at most once per command per 10 minutes (`cooldown.hit`); every error still reaches the log, the stats and the `command:error` bus topic.
- `onMessage` order: knownchats (5) → role (10) → trackmessages (20) → afk (30) → notify (40) → groupguard (50, consumes when it deletes a message) → addfilter (90, consumes). Observers stay before consumers (`test/hooks.test.js` pins the order).
- `plugins/groupguard.js` enforces the `Group` columns `antilink` and `antibot` (bot admin required; owners and group admins exempt; a command containing a link counts as a link; anti-bot removes only the message-id shapes no WhatsApp client produces, the 22-character `3EB0...` id is only logged). Mute has no hook: the panel's group service calls `groupSettingUpdate`.
- Button ids are `<plugin>:<action>[:<nonce>][:<arg>]`, never with JIDs (chat = `message.jid`). Send interactive messages through `plugins/buttons.js` (`sendQuickReplies`, `sendList`, `sendConfirm`, `sendPaginatedList`): it adds a numbered text fallback and records the ids in `lib/utils/buttonRegistry.js` (TTL 1 h) so a quoted number works. Clicks arrive as native-flow `paramsJson`; `Message` sets `body` to the id.

### `Message` and `lib/utils/`
Prefer `Message` helpers (`lib/classes/Message.js`) over the raw socket: `reply`, `react`, `send*`, `sendAudioFile` (sniffs type), `sendVoice` (ogg/opus), `getQuotedMedia({ maxBytes })` (null, or `{buffer,type,mimetype,fileLength}`; checks size before downloading), `getQuotedText()`, `quoted.key`, `isSudo`, `isBotAdmin`, `isSenderAdmin`, `kick/add/promote/demote`. `sender` is the phone-number JID when Baileys gives one, `senderLid` the LID; sudo and admin checks match both.
- `permissions.js`: `getOwnerJids`, `guardTarget(message, jid)` (refuses bot/owner/creator/self), `assertParticipantResult(res)` (`groupParticipantsUpdate` returns per-target `status`, success is `"200"`).
- `http.js`: `fetchJson`/`fetchBuffer` (30 s timeout, `MAX_UPLOAD` cap), `withTimeout`, `classifyError(err, { hasKey })` + `replyKeyFor(kind)` → `common.service_unavailable|not_configured|rate_limited`; `safeLog(err)` (never log an axios error: it holds API keys). Answer a missing key with `common.not_configured` before calling.
- `ffmpeg.js` (`runFfmpeg`, `toOpusVoice`; `execFile`, no shell), `media.js#withTempDir`, `downloader.js` (yt-dlp), `gameStore.js` (`createStore`: one game per chat, TTL, nonce), `cooldown.js` (`hit(user, key, ms)` → remaining ms), `scheduler.js` (persisted reminders, one 20 s loop started by `reminder.onReady`).
- `settingsCache.js`: `getOrLoad(key, loader, ttl)`, 5-minute TTL; keys `view_once`, `anti_delete`, `auto_responder`, `banned_chats`, `sticker_cmds`, `afk_users`, `command_state`, `filters:<jid>`, `group:<jid>`, `roles:<jid>`. **A setter that writes a cached setting must call `settingsCache.invalidate(key)`** (the panel's services go through the same setters as the commands).
- `warnings.js`: the shared helper over the `Warn` rows (`.warn`, `groupguard`, the panel's Groups page): atomic increment, VIP exemption, placeholders. Don't reimplement it.
- `logger.js`: **the only logger factory**, `createLogger(name)`; one root pino with the secret redactor and a 1000-entry log ring (what the panel's Logs page shows), `printToConsole` for text that must reach the real stdout (setup link, QR), `install()` captures `console.*`. No `pino(` anywhere else except the two Baileys calls of `lib/baileys/client.js` (`test/admin-logging.test.js` fails on it); no `console.*` in `lib/admin/**`.
- `events.js`: the core bus, three topics only (`command:error`, `key:refused`, `groupguard:action`), `emitSafe(topic, payload)` isolates listeners. It exists to avoid require cycles (`http.js` → `alerts.js`); don't add topics casually.
- Engines (run whether or not the panel is enabled; start-up in `boot.js`): `stats.js` (daily counters), `housekeeping.js` (daily retention and `data/tmp` sweep), `broadcaster.js` + `recurrence.js` (one-time and recurring broadcasts, at most once per target), `alerts.js` (owner WhatsApp alerts, rate limits, queue during disconnections), `updater.js` + `ytdlpUpdate.js` (self-update: fast-forward, smoke boot via `tools/verify-boot.js`, rollback; `plugins/update.js` and the panel share it), `runtime.js` (container / supervisor detection, automatic bind address), `maintenanceMode.js`, `commandState.js`, `textOverrides.js`, `knownChats.js`, `mutex.js` (`withLock`: in-memory SQLite has one connection, so multi-statement writes are serialized), `safeFs.js`. Engines take `now` in their options, create no timer at `require` time, `unref()` their timers, and never require `lib/admin/**` (only the three log leaves `lib/admin/logs/*` are allowed).

### Settings (`config.js`, `lib/utils/settingsCatalog.js`, `settingsStore.js`, `secretBox.js`)
`config.js` exports the same object as before, but each setting is an accessor over `settingsStore`: runtime assignment (tests only) → **panel override** (`SettingOverride` row) → environment / `config.env` → code default. `lib/utils/settingsCatalog.js` is the single source (pure data, 101 entries: env name, type, validation, default, theme, `effect` immediate / restart / boot-only, `secret`, `testService`, `adapter`). A new setting is a catalog entry **plus** a line in `config.env.example` (`test/settings-example.test.js`), `settings.<KEY>.label` and `.desc` in the panel catalogs, and a reader that uses `config.KEY`. Settings whose truth already lives in a model or file (anti-delete, view-once, auto responder, the status-save list) are catalog entries with an `adapter` calling the same code as the commands. Secrets set in the panel are stored as `enc:v1:` (AES-256-GCM, key in `data/panel.key`) and registered with the log redactor. Boot-only settings (`ADMIN_PANEL`, `PANEL_*`, `DATABASE_*`, `YTDLP_PATH`, `LOG_FORMAT`...) and the 21 settings no code reads ("inactive") are shown read-only.

**Capture-site rule**: never copy a `config.X` into a module-level constant, a class field or a default parameter (it would ignore later overrides). Read it at call time; a timer built from settings exposes `reconfigure()` (`conversationManager`, `antiDeleteHandler`, `memoryManager`); a cached credential or client is dropped on `settingsStore.onChange([...])`. `test/capture-sites.test.js` pins the known sites.

### Admin panel (`lib/admin/`, feature 002; contracts in `specs/002-admin-panel/contracts/`)
On by default (`ADMIN_PANEL`), part of the bot process, in both launchers. Layout: `http/` (raw `node:http` router, security, SSE, uploads, trust proxy), `auth/` (scrypt password, sessions, one-time tokens, throttling), `routes/<area>.js`, `services/<area>.js`, `backup/`, `logs/` (redactor, ring, console capture: the only `lib/admin` files the engines may require), `monitoring.js` (the legacy public routes, moved verbatim), `server.js`, `public/` (the SPA).
- **Every route declares `auth`** (`"session"` or `"public"`; registering without it throws at boot), plus `csrf`, `touch`, `bodyLimit`/`upload` where needed. Validation is a strict schema that builds a fresh object (an unknown property is `422 validation_failed`). A handler returns codes and parameters of the error envelope, never prose, and audits through `ctx.audit(...)`; a destructive route requires the server-side `confirm`. `test/admin-security.test.js` enumerates the route table (no route without a session, no change from another site).
- A route module exports `register({ router, deps, hub, jobs, audit, onStart, onStop })`; `routes/index.js` loads every file in sorted order, so a new area is one new file. Resolve engines lazily (`deps.x || require("../../utils/x")` inside `register()` or the handler) so a test can inject a fake. A service is a factory `create<Area>Service(deps)` that never touches `req`/`res`.
- The SPA is native ES modules (`.mjs`) with vendored Preact + htm and no build step. Browser code uses no `innerHTML`/`eval`/inline script or style/third-party URL (strict CSP; `test/admin-frontend.test.js`). A view is `public/js/views/<area>.mjs` with its pure logic in `<area>-logic.mjs` (importable by `node:test`).
- The legacy endpoints (`/health`, `/healthz`, `/status`, `/ping`, `/metrics`, `/api/info`, `POST /api/restart`) are frozen by `test/panel.test.js` and `test/panel-legacy.test.js`. Bind address: `127.0.0.1` locally, `0.0.0.0` in a container or when the host sets `PORT`, `PANEL_HOST` wins (`lib/utils/runtime.js`).

### Database (`lib/database/`)
Sequelize: Postgres when `DATABASE_URL` contains `postgres` (SSL unless `DATABASE_SSL=false`), else SQLite at `DATABASE_URL` or `./database.db` (`:memory:` in tests). Each file in `models/` exports `(sequelize) => Model` and is auto-loaded under its filename. `sync()` is **additive**, not `alter: true` (which turned composite keys into per-column UNIQUE on SQLite): it creates missing tables and indexes, adds missing nullable/defaulted columns, and repairs SQLite tables damaged by the old `alter`. It never alters or drops a column, and a new unique index on an existing table is not allowed; a column change needs a hand-written migration. The Postgres path is untested. The admin panel added 14 tables (`AdminAccount`, `AdminSession`, `AdminToken`, `AuditLog`, `SettingOverride`, `TextOverride`, `CommandState`, `KnownChat`, `DailyStat`, `Broadcast`, `BroadcastRun`, `BroadcastTarget`, `AlertState`, `AlertOutbox`) and altered none, so the additive `sync()` holds: they appear on the next start, a new column on one of them must be nullable or defaulted, and a unique index on an existing table is still forbidden. A new model must also be listed in `MODELS` (exported) or `EXCLUDED_MODELS` (never exported) of `lib/admin/backup/format.js`. Economy updates are atomic (`UPDATE ... WHERE balance >= :n`, transactions); stats use `increment`.

### i18n (`lib/utils/language.js`, `lang/*.json`)
Every user-facing string goes through `getLang("plugins.<name>.<key>", ...args)` (`{0}`, `{1}`); shared text lives under `common.*`. Never `getLang(k) || "fallback"` (a missing key returns the key). `en` and `fr` must have the **same keys**; other locales fall back to `en`. `command.desc` is evaluated at require time. Add keys in a fragment `specs/001-audit-fix-commands/i18n/<plugin>.json` (`{ "en": { "plugins.x.k": "…" }, "fr": {…} }`, flat dot keys) then run `node tools/merge-i18n.js` (`--dry-run` first), or edit both `lang/en.json` and `lang/fr.json`. Feature 002 uses two fragment families in `specs/002-admin-panel/i18n/`: `bot-<area>.json` (bot texts: replies, alerts, console lines; merged into `lang/*.json` with `node tools/merge-i18n.js --frag-dir specs/002-admin-panel/i18n --pattern "bot-*.json"`) and `panel-<area>.json` (panel UI strings, `t("area.key")` in `lib/admin/public/js/**`; merged into the flat `lib/admin/public/i18n/{en,fr}.json` with `node tools/merge-panel-i18n.js`). Once merged, the catalogs are the source: edit them directly or add a new fragment. The HTTP API sends codes and parameters, never prose; `test/admin-i18n.test.js` checks the panel catalogs. `test/i18n.test.js` fails on a missing key or a literal text passed to `reply()`/`sendMessage`; a deliberate exception takes `// i18n-ignore` on the same or previous line.

### Tests (`test/`)
`node:test` with `test/helpers/fakes.js` (`setupEnv`, `fakeSocket`, `makeMessage`, `stubNetwork`) and an in-memory database. They load every plugin and check alias uniqueness and exact matching, permission refusals, a no-argument call of every command, the pipeline, hook order, database sync and translations. New commands are picked up automatically. The admin panel tests (`test/admin-*.test.js` and one file per engine) use more helpers in `test/helpers/`: `adminHarness.js` (real `createAdmin` over an in-memory database on `127.0.0.1:0`) with `adminClient.js` (cookie-jar client that adds `Origin` and CSRF) and `sseTap.js`, `adminStub.js` (HTTP core without auth), `fakeClock.js` (injectable time and timers), `fakeBaileys.js`, `fakeBotRuntime.js`, `fakeExec.js` and `tmpRepo.js` (updater: fake `yarn`/smoke boot, local git repositories), `backupKit.js`, `fakeDom.js` (renders Preact views without a browser), `botFragments.js`, `jsScan.js`. Nothing touches the real `data/`, `sessions/` or `database.db`, and nothing needs the network.

## Repo conventions and references

- Commits use Conventional Commit prefixes (`feat:`, `fix:`, `docs:`, `test:`) with descriptions mostly in French.
- `docs/AUDIT_COMMANDES.md` is the per-command report (status, access, services, syntax changes, manual checklist): update a command's row when its behavior changes. Contracts and decisions: `specs/001-audit-fix-commands/` and, for the admin panel, `specs/002-admin-panel/` (spec, plan, research decisions U1-U19, contracts, `tasks.md`, `quickstart.md` with the manual checklist, `implementation-log.md`).
- Plugin guides (`docs/PLUGIN_CREATION_DOC.md`, `.github/agents/plugin-creator.md`, `.github/copilot-instructions.md`) predate the exact-matching registry: follow this file where they differ.
- Spec Kit is installed (`.specify/`, `speckit-*` skills in `.claude/skills/`); `.specify/memory/constitution.md` is still the unfilled template. `docs-site/` is a static docs SPA unrelated to the runtime.
- Gitignored runtime state: `sessions/`, `database.db`, `config.env`, `data/`, `logs/`, `media/temp`. `data/status_save.json` is ignored but still tracked (it holds phone numbers). Inside `data/` the panel keeps `panel.key` (secret encryption key), `backups/`, `tmp/`, `admin-uploads/`, `broadcast-media/` and the `admin-reset` marker.
