---

description: "Task list: audit and fix every bot command, update dependencies"
---

# Tasks: Audit et correction des commandes du bot

**Input**: Design documents from `specs/001-audit-fix-commands/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md), [audit-findings.md](audit-findings.md)

**Tests**: requested by the spec (FR-024: automated local check). Tests use `node:test` and live in `test/`.

**Organization**: tasks are grouped by user story. Every plugin file is **owned by exactly one task**, which applies all findings for that file in one pass: permissions, responses, effects, i18n. The task sits in the phase of the story that is the file's main driver. This keeps file sets disjoint, so agents can run in parallel.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 to US7 from spec.md
- **Agent / model**: each task ends with `— agent X (model)`. Following the user's routing rule, `sonnet` = Sonnet 5.5 subagent and `opus` = Opus 5.5 subagent (core contracts and final review only). `main` = the orchestrating session.

## Rules for every implementation agent (include in each agent prompt)

1. Read first: `CLAUDE.md`, [contracts/plugin-contract.md](contracts/plugin-contract.md), [contracts/pipeline.md](contracts/pipeline.md), [research.md](research.md) (the R-sections cited by the task), and the sections of [audit-findings.md](audit-findings.md) for the owned files.
2. Edit **only the files listed in your task**. Never edit `lang/*.json`, `lib/core/*`, `lib/plugins/*`, `lib/classes/Message.js` or `config.js` after Phase 2. If you need a change there, list it under "Requests" in your final report.
3. i18n (FR-023): every user-facing string goes through `getLang("plugins.<file>.<key>", ...args)` (`{0}` placeholders) or a `common.*` key. Write the translations to `specs/001-audit-fix-commands/i18n/<file>.json` as **flat dot-keys**: `{ "en": { "plugins.x.usage": "…" }, "fr": { "plugins.x.usage": "…" } }`. Existing keys may be reused as they are, or overridden by putting them in the fragment. French uses natural wording with proper accents. Never write `getLang(k) || "fallback"`, and never concatenate an emoji onto a string that already contains one.
4. Errors (R5): never put `error.message` in a reply. Use `classifyError` from `lib/utils/http.js`, then `common.service_unavailable`, `common.not_configured`, `common.rate_limited` or `common.error`. Log only `message` and `status`.
5. Match the surrounding code style: CommonJS, double quotes, 2 spaces, existing comment density, module-level helpers instead of `this._x`.
6. Before finishing, run `node --check <file>` on every edited file, and `node -e "require('./plugins/<file>')"` with Node 24 (`export PATH=$HOME/.nvm/versions/node/v24.20.0/bin:$PATH`).
7. Final report: for each owned file, the status (`Corrigée` / `OK` / `Désactivée` / `À surveiller`), a one-line list of fixes, the external services with their state, and any Requests. This report feeds US1.

---

## Phase 1: Setup

**Purpose**: a clean, reproducible environment on a feature branch.

- [X] T001 Create and switch to branch `001-audit-fix-commands` from `master` (no commit), at the repository root. — main
- [X] T002 Create `specs/001-audit-fix-commands/i18n/README.md` documenting the fragment format (rule 3 above) and the merge command `node tools/merge-i18n.js`. — main

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: dependencies, core contracts and shared utilities. Agents A, B and C start in parallel; agent D starts when B is done.

**⚠️ CRITICAL**: no plugin task (Phase 3+) may start before this phase is complete.

### Agent A: dependencies (delivers most of US7), sonnet

- [X] T003 [P] Update `package.json` per [research.md §D](research.md#d-dependencies-fr-026-to-fr-029):
  - upgrade majors (`openai` ^7, `simple-git` ^4, `dotenv` ^18) and within-major versions to the latest listed;
  - set `baileys` to `7.0.0-rc14`;
  - remove the 18 unused packages, `fluent-ffmpeg` and `play-dl`;
  - add `luxon` (latest);
  - delete the `postinstall` sharp pin;
  - add `"test": "node --test test/"`.

  Then run, with Node 24, `node .yarn/releases/yarn-4.17.0.cjs install` to regenerate `yarn.lock`, and confirm that `require("@ryuu-reinzz/button-helper")` and `require("html-entities")` resolve. — agent A (sonnet)
- [X] T004 Adapt `config.js` to dotenv 18 (read the changelog), and add config keys with defaults, documented in `config.env.example`:
  - `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`;
  - `IMAGE_MODEL`, `GEMINI_MODEL` (default `gemini-2.5-flash`), `GEMINI_VISION_MODEL`;
  - `YTDLP_PATH` (default `yt-dlp`), `DOWNLOAD_TIMEOUT` (default 180000).

  Also convert literal `\n` to newlines in `WARN_MESSAGE` and `WARN_KICK_MESSAGE`, and quote those values in the example file. Files: `config.js`, `config.env.example`. — agent A (sonnet)
- [X] T005 Adapt the breaking call sites of the upgraded libraries, and touch nothing else in those files:
  - openai 7: `plugins/chatgpt.js`, `plugins/voice.js`;
  - simple-git 4: `plugins/update.js`;
  - file-type 22 ESM: `await import("file-type")` and `fileTypeFromBuffer` in `lib/utils/statusSaver.js` and `plugins/gemini.js`.

  Read each changelog first. — agent A (sonnet)
- [X] T006 Create `lib/utils/ffmpeg.js`, exporting `runFfmpeg(args, { timeout = 120000, input })` (`execFile` with no shell, `-y -nostdin -loglevel error`, an error that does not include the banner) and `toOpusVoice(buffer)` (libopus 24k mono 48 kHz ogg). Replace the `fluent-ffmpeg` usage in `plugins/tts.js` with it. — agent A (sonnet)
- [X] T007 Install the latest `yt-dlp` in `Dockerfile` (official release binary into `/usr/local/bin`, python3 is already present). Create `tools/check-unused-deps.js`: it lists `dependencies` that are never `require`d or `import`ed in `index.js`, `panel.js`, `config.js`, `lib/`, `plugins/`, `tools/` or `test/`, with an allow-list for implicit uses (`pg`, `sqlite3`, `pino-pretty`, `pm2`), and exits 1 when any are found. — agent A (sonnet)

### Agent B: core contracts (US2, US5, US6 mechanics), opus

- [X] T008 Rewrite `lib/plugins/registry.js` and `lib/plugins/loader.js` per [contracts/registry-matching.md](contracts/registry-matching.md), [contracts/plugin-contract.md](contracts/plugin-contract.md) and [research.md](research.md) R1 to R5 and R7:
  - sorted loading; alias map with a duplicate warning; literal patterns;
  - enforcement of `fromMe`/`ownerOnly`/`onlyGroup`/`onlyPm`/`adminOnly`;
  - `execute.call(plugin, message, argsString, { command, rawArgs })`;
  - hook registries (`getHooks("onMessage" | "onGroupParticipants" | "onReady" | "handleButtonReply")`, including modules without `command`);
  - `common.error` reply, plus the stack sent by DM to `getOwnerJids()`;
  - `getCommands()` returns `aliases[]`.

  Keep the existing exports working. — agent B (opus)
- [X] T009 Update `lib/classes/Message.js` and create `lib/utils/permissions.js` per research R8, R9, R10 and §E:
  - native-flow `paramsJson` parsing into `body`, `isButtonReply` and `isListReply`;
  - LID: `sender` set to the PN from `participantAlt`/`remoteJidAlt`, plus `senderLid`;
  - `isSudo`, `isBotAdmin` and `isSenderAdmin` LID-aware, with memoized metadata and a 60 s cache;
  - `quoted.key`; `getQuotedMedia({ maxBytes })` with a pre-download `fileLength` guard; `getQuotedText()`;
  - `sendAudioFile(buffer)` (mimetype sniffed) and `sendVoice(buffer)` (via `toOpusVoice` from T006);
  - `permissions.js`: `getOwnerJids()`, `guardTarget(message, jid)` (refuses the bot, an owner, the group creator, the sender), and `assertParticipantResult(res)` (status `"200"`).

  — agent B (opus)
- [X] T010 Create `lib/core/pipeline.js` per [contracts/pipeline.md](contracts/pipeline.md):
  - `attachHandlers(client)` and `processMessage`;
  - the disabled-chat gate (cached `BannedChat` set, `unban` from an owner allowed through);
  - interactive dispatch with `handler.call(plugin, message)`;
  - `onMessage` hooks isolated; the auto-responder not awaited inside a batch;
  - `group-participants.update` and `ready` fan-out.

  Also create `lib/utils/buttonRegistry.js` (`record(sentMsgId, ids[])` with TTL 1 h and at most 500 entries; `resolve(quotedId, digitBody)`); the pipeline rewrites a bare digit replying to a recorded message into its id. Then make `index.js` and `panel.js` call `attachHandlers(client)` and delete their own `processMessage`, keeping panel's HTTP server and `botState` updates. In `lib/baileys/client.js`, emit `messages` only for upsert `type === "notify"`, and emit a `groupMetadata` cache invalidation on `groups.update` and `group-participants.update`. — agent B (opus)
- [X] T011 Create `lib/database/models/BannedChat.js` (`jid` STRING PK, `bannedBy` STRING nullable, timestamps). Add `goodbye: { type: BOOLEAN, defaultValue: false }` to `lib/database/models/Group.js`. Extend `lib/utils/settingsCache.js` with `invalidate(key)`, `invalidatePrefix(prefix)` and a `getOrLoad(key, loader, ttl)` helper used for the keys listed in [data-model.md](data-model.md#settings-caches-settingscache-keys). — agent B (opus)
- [X] T012 Add to `lang/en.json` and `lang/fr.json`:
  - a `common` section: `error`, `owner_only`, `admin_only`, `sender_not_admin`, `bot_not_admin`, `pm_only`, `service_unavailable`, `not_configured`, `rate_limited`, `cooldown`, `usage_prefix`, `reply_required`, `media_too_large`, `no_media`;
  - `extra.instance_close`, `extra.reconnect`, `extra.connected` (used by `lib/baileys/client.js`).

  This is the only lang edit before Phase 10. — agent B (opus)

### Agent C: shared utilities, sonnet

- [X] T013 [P] Create `lib/utils/http.js` per [research.md §E](research.md#e-shared-helpers-avoid-10-copies):
  - `fetchJson(url, opts)` and `fetchBuffer(url, { maxBytes = config.MAX_UPLOAD MB, timeoutMs = 30000 })`, using axios with `maxContentLength` and `signal: AbortSignal.timeout`;
  - `classifyError(err)` → `"not_configured" | "rate_limited" | "service_unavailable" | "error"` (401/403 → not configured or unavailable depending on whether a key is set, 429 → rate_limited, ENOTFOUND/ECONNREFUSED/timeout/5xx → service_unavailable);
  - `withTimeout(promise, ms)`;
  - `safeLog(err)` → `{ message, status }`.

  — agent C (sonnet)
- [X] T014 [P] In `lib/utils/media.js`: add `withTempDir(fn)` (`fs.promises.mkdtemp` + `rm -rf` in `finally`); switch `file-type` to `await import()` and `fileTypeFromBuffer`; flatten alpha onto white for JPG in `convertImage`; replace `Date.now()` temp names. — agent C (sonnet)
- [X] T015 [P] Create `lib/utils/downloader.js` wrapping `config.YTDLP_PATH` with `execFile`, honouring `DOWNLOAD_TIMEOUT` and `MAX_UPLOAD`:
  - `download(url, { audio=false })` → `{ buffer, mimetype, fileName, title }`, using `--no-playlist`, `-f "best[height<=720][ext=mp4]/best"` (video) or `-x --audio-format m4a` (audio), `--max-filesize`, and `withTempDir`;
  - `search(query, n=5)` → `ytsearch<n>:` JSON (`--dump-json --flat-playlist`);
  - `isAvailable()`.

  A missing binary throws an error that `classifyError` maps to `service_unavailable`. — agent C (sonnet)
- [X] T016 [P] Create `lib/utils/gameStore.js` (per-chat Map with `expiresAt`, a single `setInterval(...).unref()` sweeper, max 500 games, `start(chat, game)` refusing while a game is active, `get`, `end`) and `lib/utils/cooldown.js` (`hit(userJid, key, ms)` → remaining ms or 0, pruned). — agent C (sonnet)
- [X] T017 [P] Create `tools/merge-i18n.js`: read every `specs/001-audit-fix-commands/i18n/*.json`, deep-set the flat dot-keys into `lang/en.json` and `lang/fr.json` (fragment wins; keep key order stable; 2-space JSON + newline), report conflicts between fragments and any key present in one language but missing in the other, and exit 1 on a missing translation. — agent C (sonnet)

### Agent D: test harness (after T008 to T012), sonnet

- [ ] T018 Create `test/helpers/fakes.js`, providing:
  - `setupEnv()`: sets `DATABASE_URL=":memory:"`, `BOT_LANG`, `SUDO=111`, `PREFIX="."` **before** requiring `config.js`, then syncs the DB;
  - `fakeSocket()`: records `sendMessage`, `groupMetadata` with configurable admins, `groupParticipantsUpdate` returning `[{status:"200"}]`;
  - `fakeClient(sock)`;
  - `makeMessage({ body, from, group, admin, quoted, interactive })`: builds a raw Baileys message and wraps it in `Message`;
  - `stubNetwork()`: axios adapter that rejects with ECONNREFUSED, `global.fetch` that rejects, `child_process.execFile` that fails;
  - `loadAllPlugins()`.

  — agent D (sonnet)

**Checkpoint**: `node -e "require('./lib/core/pipeline')"` works on Node 24 and `node tools/check-unused-deps.js` exits 0. Plugin phases may start.

---

## Phase 3: User Story 2: sensitive commands restricted (Priority: P1) 🎯 MVP

**Goal**: no owner or admin command can be run by an unauthorized user (FR-003 to FR-006).

**Independent Test**: `node --test test/permissions.test.js`, then quickstart §4 scenario 2.

### Tests for User Story 2

- [ ] T019 [P] [US2] `test/permissions.test.js`:
  - every command with `fromMe`/`ownerOnly` replies `common.owner_only` to a non-owner, and `execute` is never called (spy);
  - `adminOnly` commands reply `common.sender_not_admin` to a non-admin in a group, and `extra.group_cmd` in a private chat;
  - with `SUDO=""`, owner commands refuse everyone;
  - an owner whose message arrives as `@lid` with `participantAlt` set to a PN is recognized.

  — agent D (sonnet)

### Implementation for User Story 2

- [X] T020 [P] [US2] Owner and WhatsApp-feature plugins: apply [audit-findings.md](audit-findings.md) "Batch 1" plus research R4, R5, R11 and R13 to these files: `plugins/eval.js` (alias `eval`, `onlyPm`, `rawArgs`, `util.inspect`, masked config secrets), `plugins/update.js` (`--ff-only`, ignore untracked files, `--immutable`, timeout, lock, `yt-dlp -U` best-effort), `plugins/exportcontacts.js` (export group participants via `groupFetchAllParticipating`/metadata, send by DM to the sender, `onlyPm` not required, CSV injection guard), `plugins/save.js`, `plugins/statussave.js` (`fromMe`, the file as the single source of truth, normalized numbers, warning on an empty list), `plugins/viewonce.js`, `plugins/getvv.js`, `plugins/vv.js` (`fromMe`, `extractMessageContent`, size cap), `plugins/getantidel.js`, `plugins/antidel.js`, `plugins/delcmd.js`, `plugins/getcmd.js`, `plugins/stickercmd.js` (strip `config.PREFIX`, validate the command exists, invalidate `sticker_cmds`), `plugins/banchat.js` and `plugins/unbanchat.js` (BannedChat persistence, `fromMe`, invalidate `banned_chats`; delete the in-memory Set), `plugins/feedback.js` (correct `forward` shape, wording no longer claims anonymity, 60 s cooldown, 1000-character cap), `lib/utils/antiDeleteHandler.js` (REVOKE detected via `messageStubType`), `lib/utils/viewOnceHandler.js` (`extractMessageContent`, `getOwnerJids`), `lib/utils/statusSaver.js` (no `key.from`, LID participant, size cap), `lib/utils/statusListStore.js`. Write the i18n fragments. — agent E1 (sonnet)
- [X] T021 [P] [US2] Group moderation plugins: `plugins/kick.js`, `plugins/promote.js`, `plugins/demote.js`, `plugins/tag.js`, `plugins/warnuser.js`. Apply:
  - `adminOnly`;
  - `guardTarget` and `assertParticipantResult`;
  - targets taken from all mentions or from the quote, normalized and non-empty;
  - `tag`: a single message, header once;
  - `warn`: mention or quote, `increment`, Warn row deleted only after a successful kick, `replaceAll` on the placeholders, `rawArgs` for the reason;
  - `common.sender_not_admin` vs `plugins.common.not_admin`.

  Write the i18n fragments. — agent E2 (sonnet)

**Checkpoint**: US2 testable on its own.

---

## Phase 4: User Story 3: every command responds (Priority: P1)

**Goal**: every command replies with a result, a usage, or an understandable error (FR-007 to FR-012), and dead services are replaced or marked unavailable ([research.md §C](research.md#c-external-services-fr-012-replace-otherwise-service-indisponible)).

**Independent Test**: `node --test test/commands.test.js`, then quickstart §4 scenario 12.

### Tests for User Story 3

- [ ] T022 [P] [US3] `test/commands.test.js`: with `stubNetwork()`, for **every** registered command called with no argument by the owner in a group where the bot and the sender are admins, at least one `sendMessage` happens within 5 s. No sent text matches `/\b(plugins|common|extra)\.[a-z_]+/` (raw key) or `/Error:|at .*\.js:\d+/` (leak). A command with a stubbed dead dependency replies `common.service_unavailable` or `common.not_configured`. Total runtime < 60 s. — agent D (sonnet)
- [ ] T023 [P] [US3] `test/i18n.test.js`:
  - every literal `getLang("…")` key in `plugins/`, `lib/` and `index.js` exists in both `lang/en.json` and `lang/fr.json`;
  - `en` and `fr` have the same key set;
  - lint: no `.reply(` / `sendMessage({ text:` whose first argument is a string literal or template containing letters outside `${}`.

  — agent D (sonnet)

### Implementation for User Story 3

- [X] T024 [P] [US3] Media-processing plugins: `plugins/convert.js` (send as document with the right mimetype, `fileLength` guard, sharp→png before pdfkit, `runFfmpeg`, libopus for ogg), `plugins/sticker.js` (`withTempDir`, `-t 10`, size loop ≤ 900 KB, EXIF via `node-webpmux` from `STICKER_PACKNAME`/`STICKER_AUTHOR`, validation before the ⏳ reaction), `plugins/voice.js` (`speak` via `getAllAudioUrls`, then `sendVoice`; `getQuotedMedia` with a 25 MB cap for Whisper; OpenAI `timeout: 60000, maxRetries: 0`; key checked before downloading), `plugins/tts.js` (`{ translate }` import, `raw.src` detection, `sendVoice`), `plugins/pdfmaker.js` (`getQuotedMedia`/`getQuotedText`, `rawArgs` to keep newlines, in-memory PDF, webp→png), `plugins/qr.js` (level M, input cap with a friendly message, truncated caption, `rawArgs`). Apply the findings in audit-findings "Batch 4" and write the i18n fragments. — agent E3 (sonnet)
- [X] T025 [P] [US3] Downloader plugins, all using `lib/utils/downloader.js`, `getQuotedText()` and URL host allow-lists (`new URL()`):
  - `plugins/youtube.js`: yt-dlp, `.yts` via `search`;
  - `plugins/instagram.js`: alias to the downloader;
  - `plugins/socialdl.js`: yt-dlp first; `BACKEND_URL` only if explicitly set; content-type sniffing; `MAX_UPLOAD`;
  - `plugins/music.js`: remove the `lyrics` alias and `handleLyrics`; preview in memory; say "30 s preview";
  - `plugins/lyrics.js`: LRCLIB `https://lrclib.net/api/search?q=`;
  - `plugins/pinterest.js`: `common.service_unavailable` plus a suggestion of `.image`;
  - `plugins/reddit.js`: OAuth client credentials with `REDDIT_CLIENT_ID`/`SECRET`, else `common.not_configured`; subreddit regex `^[A-Za-z0-9_]{2,21}$`; skip `over_18`; host allow-list `i.redd.it`, `preview.redd.it`, `i.imgur.com`;
  - `plugins/imagesearch.js`: `GIPHY_API_KEY` required; `images.original.mp4`; `maxContentLength`.

  Write the i18n fragments. — agent E4 (sonnet)
- [ ] T026 [P] [US3] AI and information plugins:
  - `plugins/chatgpt.js` (own desc key; timeout);
  - `plugins/gemini.js` (`config.GEMINI_MODEL`; `httpOptions.timeout`; empty `response.text` handled; validation before the ⏳ reaction; `getQuotedMedia`);
  - `plugins/imagen.js`: Gemini native image model from `config.IMAGE_MODEL`. **First** verify the current model id and call shape against the Google GenAI docs or `models.list` for the installed `@google/genai` version, use `config: { numberOfImages: 1, aspectRatio }`, and read the correct response shape;
  - `plugins/fact.js` (uselessfacts v2 → local list; remove api-ninjas);
  - `plugins/fancy.js` (`String.fromCodePoint`, correct Unicode bases from audit-findings, `Array.from`, 500-character cap);
  - `plugins/joke.js`;
  - `plugins/quote.js` (module functions instead of `this._*`; drop the Save button; captions);
  - `plugins/quoteof.js` (ZenQuotes, filtering `a === "zenquotes.io"` → dummyjson → local list);
  - `plugins/news.js` (`classifyError`; no axios config in logs; 2-letter country check else `q=`; AlphaVantage `Information`/`Note` → quota message; 60 s CoinGecko cache);
  - `plugins/weather.js` (`lang` = `config.LANG`; Open-Meteo keyless fallback with WMO codes);
  - `plugins/translate.js` (aliases `trt|translate|tr`; `getQuotedText`; ISO code validation; default `config.LANG`; MyMemory fallback; timeout);
  - `plugins/autorespond.js` (invalidate `auto_responder`);
  - `lib/utils/autoResponderHandler.js` (`config: { systemInstruction, maxOutputTokens, temperature }`; skip empty or reaction bodies; per-JID rate limit recorded at the start; empty `response.text` guarded; typing not blocking);
  - `lib/utils/conversationManager.js` (read through pending updates; `upsert`; `unref` + flush on SIGTERM; 30-day purge).

  Write the i18n fragments. — agent E5 (sonnet)
- [ ] T027 [P] [US3] Game plugins, following the research R8 id contract (`<plugin>:<action>:<nonce>[:<arg>]`, chat from `message.jid`, explicit `true` for owned ids, `false` otherwise, never throwing; free-text replies require game + `quoted.id === botMessageId` + a non-empty body + not starting with `PREFIX`) and `lib/utils/gameStore.js`:
  - `plugins/hangman.js` (words filtered with `/^[a-z]+$/` and deduplicated; a localized word list; `.hangman <letter>` and `.hangman stop`);
  - `plugins/quiz.js` (subcommands from `ctx.command`; ignore PREFIX and empty replies; drop the special-case reliance);
  - `plugins/rps.js` (the player picks via buttons; picks collected without public disclosure; `tie_game`/`win_game` keys; timer identity);
  - `plugins/tictactoe.js` (`buttons.js` helpers with fallback; no overwriting another game; `stop`; normalized players);
  - `plugins/trivia.js` (`const { decode } = require("html-entities")`; one attempt per user; score kept; nonce; `response_code` check);
  - `plugins/truthdare.js` (correct `common.*` keys; no Group rows for private chats; lowercased args; content typos fixed).

  Write the i18n fragments. — agent E6 (sonnet)

**Checkpoint**: US3 testable on its own.

---

## Phase 5: User Story 4: saved settings take effect (Priority: P2)

**Goal**: welcome/goodbye, filters, AFK, disabling the bot, stats/levels and reminders/notifications actually work (FR-013 to FR-018).

**Independent Test**: `node --test test/hooks.test.js`, then quickstart §4 scenarios 3 to 9.

### Tests for User Story 4

- [ ] T028 [P] [US4] `test/hooks.test.js`:
  - `onGroupParticipants` `add` with welcome on → one message mentioning every participant (both string and object participants); `remove` with goodbye on → goodbye;
  - a filter matches case-insensitively at a word boundary and the pipeline stops; the pattern `.*` is treated literally;
  - AFK: a mention gets an AFK reply, and the AFK user's next message clears the status;
  - BannedChat: commands are ignored, `unban` from the owner gets through, and the ban survives a re-require (DB);
  - tracking: 3 group messages → `messageCount` 3; private chats are not tracked;
  - a reminder with `dueAt` in the past is delivered once by `scheduler.tick()` with the fake socket, and status becomes `sent`.

  — agent D (sonnet)

### Implementation for User Story 4

- [ ] T029 [P] [US4] Group-feature plugins per research R12, R14, R15, R18 and R19:
  - `plugins/setwelcome.js` and `plugins/goodbye.js`: `onGroupParticipants`; placeholders `@user` `@group` `@desc` in one global-regex pass; `.goodbye on|off|reset|<text>` using `Group.goodbye`; `rawArgs`; `findOrCreate`; previews with placeholders substituted; invalidate `group:<jid>`;
  - `plugins/addfilter.js`: `onMessage` with an escaped word-boundary match and a 10 s cooldown per (group, pattern); cached `filters:<jid>`;
  - `plugins/delfilter.js`: also accepts a list index;
  - `plugins/afk.js`: per-user, persisted in `User.afkReason`/`afkTime`; `onReady` loads the cache; `onMessage` handles mention/quote replies and return; 60 s cooldown;
  - `plugins/role.js`: module functions; `onMessage` enforces `muted`/`banned`; `vip` exempt from warn via an exported `isVip`; a warning when the bot is not admin; `slice(3).join(":")`;
  - `plugins/groupinfo.js`: remove peak hours; mentions;
  - `plugins/poll.js` and `plugins/pollplus.js`: a single native poll command `poll|vote|poll+|pollplus` in `poll.js`; `pollplus.js` reduced to a re-export or removed from registration with no duplicate aliases; split at the first `?`; `|` also accepted; deduplicated options, 2 to 12; no fake tally.

  Write the i18n fragments. — agent E7 (sonnet)
- [ ] T030 [P] [US4] Stats and economy plugins per research R16 and [data-model.md](data-model.md) (UserStats, GroupEconomy):
  - `plugins/trackmessages.js`: `onMessage`; groups only; type whitelist; XP cooldown 60 s; atomic `increment`;
  - `plugins/stats.js`: rebuilt on UserStats; in-memory state removed;
  - `plugins/level.js`: `findOne`, no phantom rows; global rank by distinct users;
  - `plugins/leaderboard.js`: module functions; clamped pages; readable labels;
  - `plugins/dice.js`: `count>=1`, `sides>=2`; house-edge payouts with EV < 1 (document the odds in the usage text); `onlyGroup` for bets; atomic conditional debit; fix the `econ` scope;
  - `plugins/economy.js`: `findOne`; Top-5 with `balance>0`; explicit `true`; mentions;
  - `plugins/daily.js`: conditional `UPDATE` on `lastDailyAt`; streak restarts at 1;
  - `plugins/give.js`: a transaction with conditional decrement/increment; no gift to the bot or self; first numeric token.

  Write the i18n fragments. — agent E8 (sonnet)
- [ ] T031 [P] [US4] Scheduling per research R17 and [data-model.md](data-model.md):
  - Create `lib/database/models/Reminder.js`:
    - `id` INTEGER PK autoincrement; `chatJid` STRING not null; `creatorJid` STRING not null;
    - `text` TEXT not null "1 to 500 characters"; `dueAt` DATE not null indexed (UTC);
    - `status` STRING default `pending`, one of `pending|sent|cancelled|missed|failed`;
    - `attempts` INTEGER default 0, "`failed` after 5"; `lastError` TEXT nullable; `sentAt` DATE nullable.
  - Create `lib/database/models/Task.js`: `text` "1 to 300 characters"; `createdBy` not null; `doneBy` nullable; "At most 100 tasks per chat".
  - Create `lib/database/models/NotifyKeyword.js`: `keyword` "lower-cased, at least 3 characters"; `scopeJid` not null; `enabled` default true; "20 keywords per user".
  - Create `lib/utils/scheduler.js`:
    - `start(client)` guarded against double start; `tick()` every 20 s;
    - idempotent `UPDATE … WHERE status='pending'`; `getSocket()` at send time; backoff;
    - restart policy: overdue < 6 h sent with a "delayed" note, older ones marked `missed`;
    - parse `s|m|h|d|j` and `HH:MM` in `config.TIMEZONE` with luxon; limits of 20 pending per user, 5 s minimum, 1 year maximum.
  - Rewrite `plugins/reminder.js` (`onReady` → `scheduler.start`; `list`; `cancel <id>`), `plugins/task.js` (Task model; creator/admin/owner permission for delete/clear; remove the dead reminder code) and `plugins/notify.js` (NotifyKeyword; `onMessage` scoped to `scopeJid`; delivery only to members, never from private chats; word boundary; DM rate limit; `list_title` key).

  Write the i18n fragments. — agent E9 (sonnet)

**Checkpoint**: US4 testable on its own.

---

## Phase 6: User Story 5: exact command matching (Priority: P2)

**Goal**: a command triggers only on its exact name or alias, and every alias has a single owner (FR-019 to FR-021).

**Independent Test**: `node --test test/registry.test.js`, then quickstart §4 scenario 1.

### Tests for User Story 5

- [ ] T032 [P] [US5] `test/registry.test.js`:
  - every alias of every command resolves, case-insensitively;
  - none of `kiss class boss guess export expire giftcard faq iq display topng2 replay` resolves to a command other than one they name exactly;
  - no duplicate aliases (no warning logged);
  - `poll+` resolves;
  - the loader order is sorted.

  — agent D (sonnet)

### Implementation for User Story 5

- [ ] T033 [P] [US5] Menu, help and utility plugins:
  - `plugins/help.js`: normalize the argument (strip prefix, first token); show the main name plus `aliases`; usage when available;
  - `plugins/menu.js`: localized; icons applied per real `type`; aliases shown; owner-only commands hidden from non-owners; no unused imports;
  - `plugins/buttonmenu.js`: ids `menu:cmd:<name>`; no dead `||` fallbacks;
  - `plugins/buttons.js`: call `buttonRegistry.record(sentMsgId, ids)` on every send, including fallbacks; no dead fallbacks; localized fallback text;
  - `plugins/alive.js`, `plugins/ping.js`: i18n;
  - `plugins/apkdownload.js`: do not auto-download on every search; `.apk <name>` lists, `.apk dl <n>` downloads with `fetchBuffer` and the size cap;
  - `plugins/idea.js`: module functions instead of `this._*`; Top computed in SQL; atomic votes; drop the unused CATEGORIES.

  Write the i18n fragments. — agent E10 (sonnet)

**Checkpoint**: US5 testable on its own.

---

## Phase 7: User Story 7: up-to-date dependencies (Priority: P2)

**Goal**: every dependency is at its latest stable major or recorded as an exception; nothing unused or deprecated remains (FR-026 to FR-029). Most of the work is done in T003 to T007.

**Independent Test**: quickstart §5.

- [ ] T034 [US7] Run `node tools/check-unused-deps.js` and `node .yarn/releases/yarn-4.17.0.cjs outdated` with Node 24. Write `specs/001-audit-fix-commands/deps-report.md`: one row per dependency (before → after, action: upgraded / removed / replaced / added / exception + reason), from the `package.json` diff against `master`. — agent A (sonnet)

---

## Phase 8: User Story 6: identical behaviour in panel mode (Priority: P3)

**Goal**: one pipeline for both start modes (FR-022). The mechanics are delivered by T010.

**Independent Test**: `node --test test/pipeline.test.js`, then quickstart §4 scenario 11.

- [ ] T035 [US6] `test/pipeline.test.js`:
  - `index.js` and `panel.js` contain no `processMessage` definition (static check) and both call `attachHandlers`;
  - with a fake client, the same sequence (command, native-flow button reply, numeric fallback reply, status message, history `append` batch ignored) produces identical sends through `attachHandlers`;
  - panel's `createServer()` answers `/health` 200.

  — agent D (sonnet)

---

## Phase 9: User Story 1: audit report (Priority: P1, final deliverable)

**Goal**: one French report covering 100 % of the commands (FR-001, FR-002, FR-025, FR-029). It comes last because it records the final statuses.

**Independent Test**: every command listed by `.menu` appears in the report with a status and a justification.

- [ ] T036 [US1] Write `docs/AUDIT_COMMANDES.md` in French from [audit-findings.md](audit-findings.md), the final reports of agents E1 to E10, `deps-report.md` and `getCommands()`. Include:
  - a summary (counts per status, cross-cutting fixes);
  - a table with one row per command: name, aliases, category, access, external services (key, state on 2026-10-27), status `OK | Corrigée | Désactivée | À surveiller`, defects found → fix;
  - a section on dead services and their replacements, including the note on the owner's own backend `api.socialdl.starland9.dev` (Traefik default certificate, 404) to repair outside this repo;
  - the dependency table;
  - the manual checklist from quickstart §4, with checkboxes.

  — agent R (sonnet)

---

## Phase 10: Polish and cross-cutting

- [ ] T037 Run `node tools/merge-i18n.js` (it must exit 0), then review the diff of `lang/en.json` and `lang/fr.json`. Files: `lang/en.json`, `lang/fr.json`. — main
- [ ] T038 Run `yarn test` with Node 24, with `BOT_LANG=fr` and with `BOT_LANG=en`, and fix the failures. This may touch any file, so it runs serially after every other task. Target: < 2 min (SC-010). — agent F (sonnet)
- [ ] T039 Startup smoke: `timeout 25 node index.js` with `LOG_LEVEL=debug` and a throwaway `sessions/` path. Expected: the plugin count is the total, there is no `Failed to load plugin` and no duplicate-alias warning, and the DB syncs against a copy of the existing `database.db`. Files: none. — main
- [ ] T040 [P] Update `CLAUDE.md`:
  - new pipeline and hooks; `ctx`; exact matching; LID helpers; utilities; `yarn test`; i18n fragments workflow;
  - drop the gotchas that are now fixed.

  Also update `README.md` (Node 24, yt-dlp, commands whose syntax changed). — agent R (sonnet)
- [ ] T041 Final review of the full branch diff, focused on the core (`lib/core`, `lib/plugins`, `lib/classes/Message.js`), security (permissions, notify scope, reddit SSRF, eval) and data integrity (economy atomicity, additive `alter`). Report findings, then fix any confirmed critical issue. — agent Z (opus)

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1** → **Phase 2**: A, B and C run in parallel; D starts after B (T008 to T012).
- **Phase 2 checkpoint** → Phases 3 to 8 **all in parallel** (disjoint files, see the ownership map below).
- **Phase 9 (US1)** depends on the final reports of E1 to E10 and on T034.
- **Phase 10**: T037 → T038 → T039 serially; T040 ∥ T041 after T038.

### File ownership (no file has two writers in the same wave)

| Owner | Files |
| ------- | ------- |
| A | `package.json`, `yarn.lock`, `config.js`, `config.env.example`, `Dockerfile`, `lib/utils/ffmpeg.js`, `tools/check-unused-deps.js`; T005 call sites only (chatgpt, voice, update, gemini, statusSaver) **in Phase 2** |
| B | `lib/plugins/*`, `lib/core/*`, `lib/classes/Message.js`, `lib/utils/{permissions,buttonRegistry,settingsCache}.js`, `lib/baileys/client.js`, `lib/database/models/{BannedChat,Group}.js`, `index.js`, `panel.js`, `lang/*.json` (`common` + `extra` only) |
| C | `lib/utils/{http,media,downloader,gameStore,cooldown}.js`, `tools/merge-i18n.js` |
| D | `test/**` |
| E1 to E10 | the plugin and lib files listed in T020, T021, T024 to T027, T029 to T031 and T033; together they cover all 81 files in `plugins/` exactly once |

### Within each story

The tests (agent D) are written in parallel with the implementation and must pass at T038. Each E agent edits its files in one pass and writes its i18n fragments.

## Parallel execution examples

```text
# Phase 2 (3 agents at once):
Agent A (sonnet): T003 → T004 → T005 → T006 → T007
Agent B (opus):   T008 → T009 → T010 → T011 → T012
Agent C (sonnet): T013 ∥ T014 ∥ T015 ∥ T016 ∥ T017
then Agent D (sonnet): T018

# Phases 3 to 8 (concurrency limited to 5 to 6 agents at a time):
Wave 1a: E1 (T020), E2 (T021), E3 (T024), E4 (T025), E5 (T026), D (T019, T022, T023)
Wave 1b: E6 (T027), E7 (T029), E8 (T030), E9 (T031), E10 (T033), D (T028, T032, T035)
then A (T034)

# Phase 9 to 10:
R (T036) → main (T037) → F (T038) → main (T039) → R (T040) ∥ Z (T041, opus)
```

## Implementation strategy

### MVP first (US2)

Phase 1 → Phase 2 → Phase 3 (US2: no more privilege escalation) → T038 on `test/permissions.test.js`. This closes the most serious risks first: `vv`, `ban`/`unban`, `statussave`, `exec` in groups, owner refusal under LID.

### Incremental delivery

1. Foundation (core + dependencies): the regex matching, `this` binding, button and panel bugs are fixed for every plugin at once.
2. US2 → US3 → US4 → US5 → US7 → US6, each testable on its own.
3. US1, the report, closes the feature with final statuses.

### Cost control (user's rule)

- Opus is used only for T008 to T012 (core contracts everything else depends on) and T041 (final review). Everything else runs on Sonnet.
- Agents receive file paths and the R-section references, not the whole spec, so each one reads only what it needs.

## Notes

- `[P]` = different files and no dependency on an incomplete task.
- No commits during implementation unless the user asks; the work stays on branch `001-audit-fix-commands`.
- If a plugin agent needs a core change, it reports a Request instead of editing core files; main batches the Requests after each wave.
