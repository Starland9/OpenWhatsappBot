# Phase 0 Research: decisions

Inputs: four parallel research streams (Sonnet, read-only, 2026-10-28), each with file:line evidence and throwaway spikes outside the repo:

| Stream | File | Scope |
| --- | --- | --- |
| A | [research/a-runtime.md](research/a-runtime.md) | config overrides applied live, settings catalog (Appendix A), text overrides, command disable, in-process restart, pairing, panel in both modes, stats hooks |
| B | [research/b-web-security.md](research/b-web-security.md) | HTTP layer, UI without build, auth/sessions, cross-site defences, throttling, SSE, logs without secrets, panel i18n/theme, testability |
| C | [research/c-data-jobs.md](research/c-data-jobs.md) | 14 new tables, known chats, economy adjustments, broadcast + recurrence engine, backup format, alerts, stats/audit, test design |
| D | [research/d-maintenance-ops.md](research/d-maintenance-ops.md) | self-update with rollback, yt-dlp update, storage, API key tests, legacy endpoints, deployment, memory |

The stream files hold the detail (Decision / Rationale / Alternatives / Evidence / Files impacted). **This file is authoritative where they disagree**: the user's decisions and the arbitration below override any stream recommendation. FR numbers quoted inside the stream files refer to an earlier draft of the spec; use the requirement text, not the number.

## 1. User decisions taken during research (2026-10-28)

| # | Question | Decision | Overrides |
| --- | --- | --- | --- |
| U1 | Default bind address | Auto: `127.0.0.1` locally; `0.0.0.0` when a container (`/.dockerenv`, cgroup) or a panel host (`PORT` env) is detected; `PANEL_HOST` always wins | B "open point 1", D7 |
| U2 | Activation switch | New key **`ADMIN_PANEL`** (default `true`). The old `PANEL_ENABLED` (never read, shipped as `false`) is ignored and removed from `config.env.example` and the docs | D7, A8 ("PANEL_ENABLED default true") |
| U3 | Anti-link / anti-bot / mute | **Implement** them (spec FR on group enforcement) | A8 (recommended leaving out) |
| U4 | Mute semantics | Toggle WhatsApp's group setting "only admins can send messages" (`groupSettingUpdate(jid, "announcement" / "not_announcement")`), bot admin required; `Group.mute` mirrors the last state set by the bot | — |
| U5 | Storage page | Real categories only: temp media, in-memory anti-delete cache, panel backups, logs, database (size only). `STATUS_SAVE_FOLDER` has no consumer and joins the "no effect" group | D3 (listed the statuses folder) |
| U6 | Update with no supervisor | Apply (with rollback if the smoke boot fails), then show "restart the program to finish" until the process restarts | D1 |
| U7 | Owner stack-trace DMs | Throttle `registry.notifyOwners` to one stack per command per 10 min (`cooldown.hit`), plus the "errors in series" alert | C7 |
| U8 | Settings no code reads (~20) | Read-only, folded group "sans effet aujourd'hui" (`inactive: true` in the catalog); removal in a later feature | A8, D4 |
| U9 | Secrets saved by the panel | **Encrypted at rest** (C1 below) | A8 (plain text) |
| U10 | Undeclared reverse proxy | Banner + explicit `PANEL_TRUST_PROXY` (CIDR list); never trust forwarded headers automatically | B "open point 3" |
| U11 | Hardening | Absolute session cap 7 days (on top of 24 h idle); executable paths (`YTDLP_PATH`) read-only in the panel | B "open point 2", A8 |
| U12 | Defaults | Backup excludes the AI `Conversation` table and the audit log (and the `Admin*` tables); every alert type on by default; a recurring "31st" fires on the last day of shorter months | C5, C6 |
| U13 | UI library | **Preact 10.29.8 + htm 3.1.1**, vendored ES modules, no build step (user confirmed over htmx/Alpine) | — (confirms B2) |

### User decisions taken during Phase 1 design (2026-10-28)

| # | Question | Decision |
| --- | --- | --- |
| U14 | Failed broadcast targets | No retry route and no automatic retry. The report offers "new broadcast to the failed targets", a pre-filled new broadcast that the owner confirms. An interrupted target may have received the message, so it is never re-sent implicitly |
| U15 | Broadcast media retention | A `once` broadcast's media is deleted 7 days after its run ends. A recurring broadcast's media is kept while the broadcast exists. A "broadcast media" category appears on the Storage page and can be emptied |
| U16 | Anti-bot id shapes | Remove only the shapes no WhatsApp client produces (`BAE5` + 12 hex, 40-char `3EB0…`). The 22-char `3EB0…` ids (Baileys 7 and probably WhatsApp Web) are only logged as suspects (audit + log), never removed. Pin the shapes with fixtures |
| U17 | Links inside commands | Strict: anti-link applies to every message from a non-admin, commands included (`.dl <url>` is deleted and warned). Group admins and owners are exempt |
| U18 | Legacy `PANEL_ENABLED` | Ignored. If it is present in the environment, one console line at boot says it is no longer read and how to disable the panel (`ADMIN_PANEL=false`) |
| U19 | Example vs code defaults (`AUTO_STATUS_VIEW`, `ENABLE_MESSAGE_REACTIONS`, `AUTO_READ`, `VPS`, `STICKER_AUTHOR`) | The panel shows the code default, which is what applies without a file value. `config.env.example` keeps its suggested values. No behaviour change |

### Decisions taken by the orchestrator while the user was away (2026-10-28 night)

The user delegated the remaining decisions ("je te laisse les prendre s'il y a encore des décisions"). Each one takes the safest option closest to earlier choices; review them here.

| # | Question | Decision |
| --- | --- | --- |
| O1 | Media of a "new broadcast to the failed targets" (U14) | Copied server-side from the original broadcast (`reuseMediaOf`) while it still exists (7-day retention, U15); otherwise the owner re-uploads |
| O2 | `LOG_LEVEL` effect | Immediate (`logger.setLevel`), as in the catalog |
| O3 | Listing/downloading pre-restore backups (BAK-4/5, optional) | Kept: they are the only way back after a bad restore (US10 "retour arrière") |
| O4 | CORS on the legacy `POST /api/restart` | Unchanged (byte-compatible, admin-http-api.md wins over runtime.md §15) |
| O5 | CSRF secret stored in clear in `AdminSession.csrfSecret` (data-model) vs "no database dump holds it" (API contract §5 item 8) | Kept as data-model.md documents: the CSRF secret is useless without the session cookie, which is only stored hashed; the secrets test allows it in that column only. Hashing or HMAC-deriving it is a possible later hardening |
| O6 | W-BC's `GET /admin/api/broadcasts/preview` 405 guard route (redundant since the router fix) | Kept: harmless, it pins the 405 answer; whitelisted in the integration test |

## 2. Arbitration between streams

### R1. One module root: `lib/admin/`

**Decision**: everything served by the panel lives under `lib/admin/` (layout of B, "Proposed layout"). D's `lib/panel/storage.js` and `lib/panel/keyTests.js` become `lib/admin/services/storage.js` and `lib/admin/services/keyTests.js`. Engines that must run whether or not the panel is enabled stay in `lib/utils/` or `lib/core/`: `settingsStore.js`, `secretBox.js`, `logger.js`, `broadcaster.js`, `alerts.js`, `updater.js`, `runtime.js` (supervisor/container detection).
Rationale: B's router enforces `auth` per route; one root keeps SC-005's route enumeration complete. Engines must not depend on the HTTP layer (a scheduled broadcast fires even with `ADMIN_PANEL=false`).
Alternatives: `lib/panel/` (D): clashes with the existing `panel.js` launcher name.

### R2. Settings store and table

**Decision**: one model `SettingOverride` (`setting_overrides`: `key` PK, `value` TEXT, `version` INT; C1), loaded into a synchronous in-memory store (`lib/utils/settingsStore.js`) after `sync()`. `config.js` exposes accessor properties reading `override → env/file → default` (A1). Settings whose source of truth is already a model or a file (`AntiDelete`, `ViewOnce`, `AutoResponder` rows, `data/status_save.json`; C "findings" 2) are edited through adapters that call the same code as the commands, never duplicated in `SettingOverride`.
Rationale: about 260 of ~273 `config.X` reads already happen at call time (A1), so accessors make overrides live with a handful of fixes (A1 "captures to fix").
Alternatives: A's `Setting` table name (same shape; renamed to match C's data model).

### C1. Secrets at rest (user decision U9)

**Decision**: values of `secret: true` settings are stored as `enc:v1:<iv>:<tag>:<ciphertext>` (AES-256-GCM, `node:crypto`), key = 32 random bytes in `data/panel.key` (created with mode 0600 on first write; `data/` is already a gitignored Docker volume). `lib/utils/secretBox.js` encrypts and decrypts. When the key is missing or a value fails to decrypt, the override is ignored (env/file value applies), the setting shows "à ressaisir" in the panel and an error is logged once. Backups carry decrypted values inside the passphrase-encrypted archive, so a restore on another installation re-encrypts with that installation's key. Every secret value is registered with the log redactor (B8).
Rationale: protects remote Postgres databases and leaked DB copies; a lost key costs only re-typing the keys.
Alternatives: plain text (rejected by the user); a key derived from the admin password (the bot needs the secrets without anyone logged in).

### R3. Group guard (user decisions U3, U4)

**Decision**: new hook-only plugin `plugins/groupguard.js`, `hookPriority.onMessage = 50` (after the observers role/trackmessages/afk/notify, before `addfilter` at 90). Anti-link: in a group with `antilink` on and the bot admin, a link (URL or `chat.whatsapp.com` invite) from a non-admin non-owner is deleted (`sendMessage(jid, { delete: key })`), the author gets a warning through the existing `Warn` model and `WARN_LIMIT`/`ANTILINK_MSG`, and is removed at the limit (`guardTarget` + `assertParticipantResult`). Anti-bot: per U16, a non-admin sender is removed with `ANTIBOT_MSG` only for id shapes no WhatsApp client produces (`BAE5` + 12 hex, 40-char `3EB0…`); 22-char `3EB0…` ids are logged as suspects, never removed. Mute: no hook; the group service calls `groupSettingUpdate` and writes `Group.mute`. Group settings are read through `settingsCache` `group:<jid>` (existing key), so the guard costs one cached lookup per group message.
Rationale: the columns and messages (`ANTILINK_MSG`, `ANTIBOT_MSG`, `WARN_*`) already exist; only enforcement is missing (C "findings" 1).
Alternatives: flagged switches or dropping them (rejected by the user).

### R4. Bot-id heuristic is a known false-positive risk

**Decision**: anti-bot acts only on the id shapes listed in R3, never on message timing, and logs each removal to the audit log with the matched rule; the contract test covers ordinary phone ids (no removal).
Rationale: removing a human is worse than missing a bot.

### R5. Naming of new startup settings

**Decision**: read-only in the panel: `ADMIN_PANEL`, `PANEL_HOST`, `PANEL_PORT`, `PANEL_PUBLIC_URL`, `PANEL_TRUST_PROXY`, `LOG_FORMAT`, `SUPERVISED`, `UPDATE_CHECK`, `DATABASE_URL`, `DATABASE_SSL`, `YTDLP_PATH`. `PANEL_TOKEN` stays the Bearer token of the legacy `POST /api/restart` (secret, editable).

## 3. Decisions by area (summary; detail in the stream files)

| Area | Decision | Stream |
| --- | --- | --- |
| HTTP | Raw `node:http`, in-house router with mandatory per-route `auth`, enumerable routes; JSON bodies capped; uploads as `application/octet-stream` streamed to disk | B1 |
| UI | Static SPA, Preact + htm vendored under `lib/admin/public/vendor/`, no server-side HTML templating, strict CSP (`script-src 'self'`) | B2, U13 |
| Auth | `crypto.scrypt` N=2^15 r=8 p=3, single admin, one-time setup/reset tokens hashed in DB, reset by `tools/admin-reset.js` | B3 |
| Sessions | DB-backed (hashed ids) + in-process cache, `HttpOnly; SameSite=Strict`, `Secure` on HTTPS, rotation at login, 24 h idle + 7 days absolute | B4, U11 |
| Cross-site | SameSite=Strict + per-session CSRF header + Origin/Sec-Fetch-Site checks, JSON-only bodies, no CORS under `/admin` | B5 |
| Throttling | Per-origin limiter (5 failures / 15 min → 15 min block), checked before password verification; undeclared-proxy banner | B6, U10 |
| Live updates | One multiplexed SSE stream per tab (`/admin/api/events`) + 2 s polling fallback | B7 |
| Logs | Shared `lib/utils/logger.js` replacing 19 `pino(` sites, `console.*` capture, value-based redactor, 1000-entry ring | B8 |
| Panel i18n | `lib/admin/public/i18n/{en,fr}.json`, separate from `lang/` (bot texts) | B9 |
| Config live | Accessor `config.js` over `settingsStore`; fix the captures listed in A1 (client.js env reads, singletons, `imagesearch.js`, `panel.js`, credential caches) | A1, R2 |
| Texts | Overrides in `LanguageManager` (sync, in memory, `TextOverride` table); command descriptions made lazy at load time without touching the 78 plugins | A3 |
| Commands | One check in `registry.executeCommand` after the owner gate, before group/admin checks; `CommandState` rows (`scope` `*` or group JID), cached under one `settingsCache` key | A4 |
| Restart / pairing | `client.stop()` then `initialize()` with a generation token and single-flight guard; `qr` event + state; `requestPairingCode`; `resetSession()` wipes `sessions/main` contents | A5 |
| Both modes | Shared server (`lib/admin/server.js`) started by `index.js` and `panel.js`; legacy routes byte-compatible; `EADDRINUSE` never stops the bot | A6, D6, D7 |
| Stats | `DailyStat` fed from the pipeline and the registry's success/failure paths | A7, C8 |
| Data model | 14 new tables, no existing table altered (additive `sync()` holds) | C1 |
| Known chats | New `KnownChat` table filled by a hook-only observer (private chats that wrote to the bot, groups seen) | C2 |
| Economy | Panel adjustments reuse the atomic helpers (no negative balance) | C3 |
| Broadcast | Sibling engine of `scheduler.js`: `Broadcast` / `BroadcastRun` / `BroadcastTarget`, CAS claims, at-most-once per target; a target caught mid-send by a crash is `failed/interrupted`, never retried | C4 |
| Recurrence | luxon in `TIMEZONE`, unique index per occurrence, > 1 h late → skipped and logged | C5, U12 |
| Backup | JSON rows per model → gzip → AES-256-GCM (scrypt key from the passphrase); header with format/bot version and counts; single-transaction restore; pre-restore auto-backup under `data/backups/`; session optional | C6 |
| Alerts | `AlertState` (persisted CAS rate limits) + `AlertOutbox` (queue during disconnection); triggers in client, registry, `http.js`, auth, updater | C7 |
| Tests | Fake clock for SC-012/SC-015/SC-016; in-process mutex for job transactions (in-memory SQLite rejects concurrent transactions) | C9 |
| Update | `lib/utils/updater.js`: `fetch` → `merge --ff-only` on `origin/<current branch>` → vendored Yarn if deps changed → smoke boot in a child → `reset --hard` rollback on failure; `plugins/update.js` reuses it | D1, U6 |
| yt-dlp | `-U`, verdict from version before/after; instructions for apt/pip installs; refused while downloads run | D2 |
| Key tests | One fixed read-only request per service; `accepted / refused / unreachable`; 10 s per service; Alpha Vantage untestable (accepts fake keys) | D4 |
| Memory | Loaded bot ≈ 167 MB RSS; panel budget 50 MB is ample if every cache is bounded; measured by a child-process script | D8 |

## 4. Dependencies

No npm dependency added. Vendored and committed: preact 10.29.8 (MIT), its hooks, htm 3.1.1 (Apache-2.0), with licenses and a `MANIFEST.json`. Reused: `qrcode` (SVG QR), `file-type`, `pino`, `pino-pretty`, `luxon`, `simple-git`. `node tools/check-unused-deps.js` must still print 0.
