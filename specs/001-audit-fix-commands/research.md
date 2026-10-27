# Phase 0 Research: decisions

Inputs: static review of the core, 5 parallel plugin audits (Sonnet, read-only, with liveness checks on 2026-10-27), the npm registry, and Google's deprecations page. Raw per-plugin findings with file:line references are in [audit-findings.md](audit-findings.md). This file records only the decisions.

Format: **Decision** / Rationale / Alternatives rejected.

## A. Core

### R1. Command matching: exact alias map

**Decision**: replace the regex matching with `Map<alias, entry>`. Load files in sorted order, warn on duplicate aliases (the first registered keeps the alias), and use literal patterns (`poll\\+` becomes `poll+`). See [contracts/registry-matching.md](contracts/registry-matching.md).
Rationale: 8 verified false-positive families (`.kiss`, `.class` → statussave; `.export` → level; `.faq` → quote; …) and 3 aliases hijacked today (`quoteof`, `lyrics`, `quiz2`).
Alternatives: anchoring the regex `^(?:a|b)$` (rejected: patterns would still be live regex, and the load order would stay nondeterministic).

### R2. Plugin `this` binding

**Decision**: the registry keeps a reference to the plugin module and calls `plugin.execute.call(plugin, message, args, ctx)`; the dispatcher calls `handler.call(plugin, message)`. Plugins touched in wave 1 also move their `this._x` helpers to module-level functions.
Rationale: `role`, `leaderboard`, `quote` and `idea` crash today (`this._x is not a function`); the fix in the core covers them all at once.

### R3. `execute` signature

**Decision**: `execute(message, argsString, ctx)`, where `ctx = { command, rawArgs }`. `command` is the alias that matched, lower-case. `rawArgs` is the body after the command word, with newlines and spacing kept. `argsString` stays as it is today, for backward compatibility.
Rationale: multi-line input is impossible today (welcome, goodbye, filter, tagall, pdf, qr, eval, feedback), and 6 plugins re-parse `message.body.split(" ")[0]`, which breaks on upper case and newlines.

### R4. Permissions

**Decision**: the registry enforces `fromMe` and `ownerOnly` (synonyms), `onlyGroup`, `onlyPm`, and the new `adminOnly` (group admin or owner, implies a group). Inline duplicate checks are removed in wave 1. Sensitive commands get these flags:

| Command | Flags |
| --------- | ------- |
| `vv`, `exec`, `update`, `exportcontacts`, `ban`, `unban`, `statussave` | `fromMe` |
| `exec`, `exportcontacts` | also `onlyPm` |
| `kick`, `promote`, `demote`, `tagall`, `warn`, `welcome`, `goodbye`, `filter`, `delfilter` | `adminOnly` |
| `role set` | `adminOnly` checked inside (`role list` stays public) |

Rationale: FR-003 to FR-006. `vv` lets anyone unveil view-once media in a group (privacy). `afk` becomes per-user (R12) and therefore stays open to everyone.

### R5. Error replies

**Decision**: the registry replies `common.error` (generic and localized). The stack is logged and sent by DM to the owners. Plugins never interpolate `error.message` in replies. External failures map to `common.service_unavailable`, `common.not_configured` or `common.rate_limited` through `lib/utils/http.js` (`classifyError`). Logs keep `message` and `status` only, never the axios config, which contains API keys.
Rationale: leaks of the ffmpeg banner, of SQL text, and of an OpenAI key fragment were seen; `console.error(axiosError)` writes `params.apiKey` to the logs.

### R6. Shared pipeline

**Decision**: `lib/core/pipeline.js` with `attachHandlers(client)` and `processMessage`, used by `index.js` and `panel.js` (see [contracts/pipeline.md](contracts/pipeline.md)). History batches are skipped (`messages.upsert` with `type !== "notify"`). The auto-responder is not awaited inside a batch.
Rationale: FR-022. In panel mode there is currently no button dispatcher, no tracking and no status saving. History batches currently re-run commands after a reconnect.

### R7. Plugin hooks

**Decision**: the hooks `onMessage`, `onGroupParticipants` and `onReady` are discovered by the loader, including in modules with no `command` (`trackmessages`). This replaces `getPlugin("trackmessages")` and the exported `handleAfkResponse`, `checkNotifications` and `isBanned`, which are never called.

### R8. Interactive replies

**Decision**: `Message` parses `interactiveResponseMessage.nativeFlowResponseMessage.paramsJson` and sets `body` to its `id` and `isButtonReply`/`isListReply` to true. `buttons.js` records `{sentMessageId → ids[]}` (TTL 1 h, at most 500 entries). When a user quotes one of those messages with a bare number, the pipeline turns the number into the matching id before dispatching. Button ids follow `<plugin>:<action>[:<nonce>][:<arg>]`, contain no JIDs, and take the chat from `message.jid`.
Rationale: `@ryuu-reinzz/button-helper` sends native-flow buttons, whose clicks are never parsed today, so **no button handler can fire**. The text fallback "reply with the number" is not handled by anything. To confirm on a real device (manual checklist).

### R9. LID addressing (Baileys 7)

**Decision**: `Message.sender` becomes the phone-number JID when Baileys provides one (`key.participantAlt` / `key.remoteJidAlt`). `message.senderLid` keeps the LID. `isSudo` accepts both. `isBotAdmin` and `isSenderAdmin` match `p.id`, `p.phoneNumber`, `p.lid` and the bot's `user.id`/`user.lid` after normalization. Group metadata is memoized per message, with a 60 s TTL cache invalidated on `groups.update` and `group-participants.update`. A shared `getOwnerJids()` replaces the 7 copies of `SUDO.split(",")[0] + "@s.whatsapp.net"`.
Rationale: in LID chats the owner currently fails every sudo check, and admin checks fail. Persisted ids (Warn, UserStats, GroupEconomy) would otherwise split between the PN and LID forms.

### R10. Group actions

**Decision**: shared `guardTarget(message, jid)` (refuses the bot, an owner, the group creator, the sender themself) and `assertParticipantResult(res)`. `groupParticipantsUpdate` returns per-target `status` values instead of throwing, so success is reported only when `status === "200"`. A new key `common.sender_not_admin`; `plugins.common.not_admin` keeps its meaning ("the bot must be admin").

### R11. Settings cache

**Decision**: every setter that writes a cached setting calls `settingsCache.invalidate(key)` (`setvv`, `antidelete`, `ar`, `welcome`, `goodbye`, `filter`, `delfilter`, `ban`/`unban`, `setcmd`/`delcmd`). Sticker commands, filters, banned chats and AFK users are served from the cache.

## B. Features that must take effect (US4)

### R12. AFK: per user, persisted

**Decision**: use the existing `User.afkReason` / `User.afkTime` (planned but unused). `.afk [reason]` is available to every user. `onMessage`: when the author is AFK, clear the status and post "back" with the duration; when an AFK user is mentioned or quoted, reply with the reason and duration (cooldown 60 s per chat and AFK user). AFK users are cached in memory (a set loaded on `onReady`).
Alternatives: owner-only AFK (the current in-memory code). Rejected: the model shows per-user intent, and the spec's US4 describes users.

### R13. Disabling the bot in a chat

**Decision**: new `BannedChat` model (covers private chats and groups), checked by the pipeline gate (cached set). `ban` and `unban` are owner-only; `unban` is let through by the gate.

### R14. Welcome and goodbye

**Decision**: `onGroupParticipants` in `setwelcome.js` and `goodbye.js`. Add `Group.goodbye BOOLEAN default false`; `.goodbye on|off|reset|<text>`. Placeholders `@user` (mentions of all participants), `@group` and `@desc`, replaced in one pass with a global regex. Skip the bot itself. Handle `participants` entries that are objects (`{id, phoneNumber, lid}`) or strings. Settings are read through `settingsCache`.

### R15. Filters

**Decision**: `onMessage` in `addfilter.js` for group messages that are not commands and not `fromMe`. Case-insensitive match on the whole message or on a word boundary of the **escaped** pattern (never a raw regex). Cooldown 10 s per (group, pattern). Returns `true`, which stops the pipeline. Filters are cached per group and invalidated by `filter` and `delfilter`. `delfilter` also accepts the index shown by `.filter list`.

### R16. Tracking, levels, stats

**Decision**: `trackmessages.onMessage`: groups only, content-type whitelist (text, media, command), no reactions or protocol messages, XP cooldown 60 s per user, atomic `increment` after `findOrCreate`. `stats.js` is rebuilt on `UserStats`; the in-memory `groupStats` is removed. `groupinfo`'s "peak hours" is removed (the data doesn't support it). `level.js` and `leaderboard.js` use `findOne` (no phantom rows), and leaderboard pages are clamped.

### R17. Scheduler (reminder, task, notify)

**Decision**:
- New `Reminder` model and `lib/utils/scheduler.js`. A single polling loop every 20 s starts in `onReady` (guarded against double start). It sends with `client.getSocket()` at send time and marks rows sent idempotently (`UPDATE … WHERE status='pending'`).
- On restart, reminders overdue by less than 6 h are sent with a "delayed" mention; older ones are marked `missed`.
- Grammar `s|m|h|d|j` and `HH:MM` in `config.TIMEZONE` (via `luxon`).
- Limits: 20 pending per user, 5 s minimum, 1 year maximum, 500 characters. New subcommands `.remind list` and `.remind cancel <id>`.
- New `Task` model (`createdBy`; only the creator, an admin or an owner can delete or clear). The unreachable reminder code in `task.js` is removed.
- New `NotifyKeyword` model scoped to the chat where the keyword was registered. Delivery only if the user is a member of that chat, never from private chats. 20 keywords per user, 3 characters minimum, word-boundary match, DM rate limit.
Rationale: everything was in memory, the socket captured at creation was stale after a reconnect, and `notify` was never called. Once wired, `notify` would have forwarded messages from any group to non-members.

### R18. Roles

**Decision**: `role.js` gets an `onMessage` hook: `muted` → the message is deleted if the bot is admin; `banned` → the member is removed on message or on join if the bot is admin; `vip` → exempt from `warn`. If the bot is not admin, `role set` warns that the role will have no effect.

### R19. Polls

**Decision**: a single native-poll command, `poll|vote|poll+|pollplus`. Syntax `Question? a, b, c` (split at the first `?`), with `|` also accepted as a separator. Options are deduplicated, between 2 and 12. The fake tallies (votes are never read; reading them needs a message store that v7 doesn't provide) and the in-memory `polls` maps are removed. Multi-select via `.poll+`.

## C. External services (FR-012: replace, otherwise "service indisponible")

| Command | Status (2026-10-27) | Decision |
| --------- | --------------------- | ---------- |
| `youtube` (play-dl) | Hangs forever on HTTP 429; `.ytv` sends audio as a video | **Replace with `yt-dlp`** (system binary, `execFile`, `--no-playlist`, `-f "best[height<=720][ext=mp4]/best"`, `--max-filesize ${MAX_UPLOAD}M`, 180 s timeout); search via `ytsearch5:`. Added to the Dockerfile (latest release); `yt-dlp -U` in `update`. Missing binary → `common.service_unavailable` |
| `insta` | Both providers NXDOMAIN | Becomes an alias of the shared downloader (`yt-dlp`) |
| `dl` (socialdl) | Backend `api.socialdl.starland9.dev`: Traefik default self-signed certificate, 404 | `yt-dlp` first; `BACKEND_URL` only if explicitly configured. **The owner's own infrastructure: to repair outside this repo** |
| `lyrics` | lyrics.ovh misused (404), some-random-api 403 | **LRCLIB** `lrclib.net/api/search?q=` (keyless, 200) |
| `pinterest` | Anonymous search 403, no keyless alternative | Kept, replies `common.service_unavailable` and suggests `.image` |
| `reddit` | `.json` 403 "Blocked" | Reddit OAuth (client credentials) if `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` are set, otherwise `common.not_configured`. `over_18` filtered; media hosts allow-listed (`i.redd.it`, `preview.redd.it`, `i.imgur.com`); subreddit validated |
| `gif` (imagesearch) | Giphy demo key BANNED (403) | `GIPHY_API_KEY` required (otherwise not configured); use `images.original.mp4` |
| `imagen` | `imagen-4.0-fast-generate-001` shut down on 2026-08-17; response read with the wrong shape | Gemini native image model, `config.IMAGE_MODEL` (the task verifies the exact id with `models.list` and the docs before coding); `config: { numberOfImages, aspectRatio }` |
| `quoteof` | quotable.io DNS dead | ZenQuotes (filter its rate-limit reply) → dummyjson → local list |
| `fact` | api-ninjas "demo" key dead; uselessfacts redirects | uselessfacts v2 direct → local list |
| `weather` | WeatherAPI OK (key) | Keep; keyless **Open-Meteo** fallback (geocoding + forecast, WMO codes); `lang = config.LANG` |
| `trt` | Scraper OK | Keep, timeout, **MyMemory** fallback; aliases `trt\|translate\|tr` |
| `news` | OK with keys | Keep; detect the AlphaVantage quota; 60 s cache on CoinGecko |
| `tts`, `speak` | Google TTS OK | Keep; fix the `{ translate }` import; ≤200-character chunks; transcode to ogg/opus for voice notes |
| `gpt`, `gemini`, `transcribe` | OK with keys | Timeouts (`httpOptions.timeout`, OpenAI `timeout: 60000, maxRetries: 0`), handle `response.text` being empty |
| `music`, `joke`, `trivia` (opentdb) | OK | Keep |

## D. Dependencies (FR-026 to FR-029)

Versions from the npm registry on 2026-10-27. Usage was established by grep (imports) plus implicit uses.

| Action | Packages |
| -------- | ---------- |
| Major upgrade | `openai` 6 → **7** (chatgpt, voice), `simple-git` 3 → **4** (update), `dotenv` 17 → **18** (config) |
| Upgrade within the major | `@google/genai` 2.31, `axios` 1.21, `file-type` 22.2, `pdfkit` 0.20, `sharp` 0.35.5, `pino` 10.4, `pino-pretty` 13.2, `pg` 8.23, `pm2` 7.1, `html-entities` 2.6, `qrcode` 1.5.4, `sqlite3` 6.0.1, `sequelize` 6.37.8, `cron` 4.4, `@hapi/boom` 10.0.1, `qrcode-terminal` 0.12, `@vitalets/google-translate-api` 9.2.1, `google-tts-api` 2.0.2, `@ryuu-reinzz/button-helper` 2.2.3 |
| Exception (FR-026) | `baileys` → **7.0.0-rc14** (the 7.x line exists only as a prerelease; `legacy` 6.7 would break the bot). Locally rc.9 is installed: reinstall |
| Removal (unused) | `@distube/ytdl-core`, `@google/generative-ai` (deprecated, replaced by `@google/genai`), `audio-decode`, `browser-id3-writer`, `cheerio`, `cookie`, `fastq`, `form-data`, `fs-extra`, `googleapis`, `heroku-client`, `jimp`, `link-preview-js`, `moment`, `node-fetch` (Node 24 has `fetch`), `qrcode-reader`, `translate-google-api`, `youtubei.js` |
| Replacement | `fluent-ffmpeg` (deprecated) → `lib/utils/ffmpeg.js` (`execFile`); `play-dl` (abandoned in 2023) → `yt-dlp` binary |
| Kept and **used** | `node-webpmux` (unused today) → used for sticker EXIF (pack and author) |
| Addition | `luxon` (latest) for scheduler time zones; it is already a transitive dependency of `cron`, but must not be required implicitly |
| Implicit (kept) | `pg`, `sqlite3` (Sequelize dialects), `pino-pretty` (transport), `pm2` (scripts) |
| Scripts | `postinstall` installs `sharp@0.33.5` against the declared `^0.35` → remove the pin; `"test": "node --test test/"` |

Upgrade constraints:
- `file-type` 22 is ESM-only: load it with `await import("file-type")` and use `fileTypeFromBuffer`; `FileType.fromBuffer` is broken today.
- openai 7, simple-git 4 and dotenv 18: the task reads each changelog and adapts the call sites before the plugin waves.
- Local environment: Node 24 (`nvm use 24`), Yarn 4 vendored (`node .yarn/releases/yarn-4.17.0.cjs install`). The current `node_modules` is stale: button-helper and html-entities are missing; baileys, genai and file-type are at the wrong versions.

## E. Shared helpers (avoid 10 copies)

| Helper | Replaces |
| -------- | ---------- |
| `Message.getQuotedMedia({ maxBytes })` → `{buffer, type, mimetype, fileLength}` with a pre-download size guard | `{key, message}` shapes rebuilt by hand in 6 plugins; `quoted.key` missing in `save`, `vv`, `voice`, `gemini`; `pdf` reads the current message instead of the quoted one |
| `Message.getQuotedText()` (`extractMessageContent`) | `message.quoted && message.body` (insta, socialdl, reddit), `[object Object]` (lyrics, translate) |
| `message.quoted.key` (`{remoteJid, id, participant}`) | `undefined` today |
| `lib/utils/http.js`: `fetchJson`, `fetchBuffer` (total timeout via `AbortSignal.timeout`, `maxContentLength` = `MAX_UPLOAD`), `classifyError`, `withTimeout(promise, ms)` | ad-hoc timeouts; SDKs without timeouts; play-dl hangs |
| `lib/utils/ffmpeg.js`: `runFfmpeg(args, { timeout })`, `toOpusVoice(buffer)`; `lib/utils/media.js#withTempDir(fn)` (`mkdtemp` + `rm` in `finally`) | `exec` template strings, banner leaks, temp files left behind, `Date.now()` name collisions |
| `Message.sendAudioFile(buffer)` (sniffs the mimetype) / `sendVoice` (transcodes to opus) | MP3 labelled `audio/mp4` or ogg |
| `lib/utils/gameStore.js`: per-chat TTL map, a single `unref` sweeper, a size cap, refusal while a game is running | 7 game Maps without expiry |
| `lib/utils/cooldown.js`: per (user, key) | spam on feedback, AI, downloads, filters, AFK |
| Atomic economy: `UPDATE … SET balance = balance - :n WHERE balance >= :n` in a transaction | double spending in `daily`, `give`, `dice` |

## F. Verification (FR-024)

**Decision**: `node:test` (no dependency).
- Environment: `DATABASE_URL=":memory:"` and `BOT_LANG=en|fr`.
- Stubs: fake socket (records `sendMessage`), axios adapter and `global.fetch` that reject, and `child_process.execFile` stubbed (no ffmpeg or yt-dlp).
- Checks: every plugin loads; aliases are unique; exact matching plus the false-positive list; permission refusals (execute is never called); every command called with no argument replies within 5 s, without a raw key (`plugins.` / `common.`) and without `Error:` or a stack; every `getLang` key literal exists in `en` and `fr`; static lint of no literal text in `reply()`; pipeline (banned chat, native-flow parsing, numeric fallback, `onMessage` order, panel equal to index).
- Performance budget: < 2 min.
