# Implementation Plan: Panel d'administration du bot

**Branch**: `002-admin-panel` | **Date**: 2026-10-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-admin-panel/spec.md`

## Summary

A web admin panel served by the bot itself, on by default in both launch modes, lets the single owner configure and run the bot without editing files. It covers:

- first-run setup and login;
- a live dashboard and in-process restart;
- every setting, applied live, with encrypted secrets;
- WhatsApp pairing by QR or code;
- commands enabled or disabled globally or per group;
- groups, including a new anti-link, anti-bot and mute guard;
- logs and statistics;
- bot data, broadcasts and recurring messages;
- encrypted backup and restore;
- maintenance (update with rollback, yt-dlp, storage);
- editable bot texts;
- WhatsApp alerts to the owner.

**Technical approach** ([research.md](research.md)):

- **Server**: raw `node:http` with an in-house router, every route declaring its auth level. Live updates use a single SSE stream.
- **UI**: a static single-page app in Preact and htm, vendored as ES modules, with no build step and a strict CSP.
- **Live settings**: `config.js` becomes accessor properties over a synchronous settings store, ordered panel override, then env/file, then default.
- **Data**: 14 new tables and no altered table, so the additive `sync()` still applies.
- **Jobs**: broadcasts and recurrence run on a sibling of the reminder scheduler (compare-and-swap leases).
- **Logs**: a shared logger factory, a secret redactor and a ring buffer of the latest entries.
- **Dependencies**: no new npm dependency.

## Technical Context

**Language/Version**: JavaScript (CommonJS), Node.js ≥ 24 (`engines`), no build step; browser side: native ES modules (`.mjs`), evergreen browsers (last 2 versions, desktop and mobile)

**Primary Dependencies**:

- Existing, reused: `baileys` 7.0.0-rc14, `sequelize` 6, `pino`/`pino-pretty`, `qrcode` (SVG QR), `file-type`, `luxon`, `simple-git`.
- Vendored, not in `package.json`: preact 10.29.8 with hooks, htm 3.1.1.
- Node built-ins: `http`, `crypto` (scrypt, AES-256-GCM, timingSafeEqual), `zlib`, `net.BlockList`.

**Storage**:

- Database: SQLite or Postgres through Sequelize. 14 new tables, see [data-model.md](data-model.md).
- `data/panel.key`: secret-encryption key, mode 0600.
- `data/backups/`: automatic backups taken before a restore.
- Existing `sessions/main/`: WhatsApp session, optionally included in backups.

**Testing**:

- `node:test`, offline: in-memory SQLite, fake client, injectable clock, local temporary git repositories, stubbed HTTP.
- The browser modules are importable from `node:test`.
- Real-device checks are listed in [quickstart.md](quickstart.md).

**Target Platform**: Linux server (VPS, Docker, PM2, panel hosts such as bot-hosting.net); the panel is used from desktop and phone browsers (360 px wide)

**Project Type**: long-running bot process with an embedded web admin (single process, single deployable)

**Performance Goals** (from the spec):

| Target | Value |
| ------ | ----- |
| Dashboard state lag | ≤ 5 s |
| QR displayed | ≤ 5 s |
| "Connecté" shown after scan | ≤ 10 s |
| Group list, 500 groups | < 2 s |
| Live settings | applied on the next message |

**Constraints**:

- **Footprint**: panel idle overhead under 50 MB RSS (the loaded bot is about 167 MB).
- **No outside dependencies**: no CDN, no build, no new npm dependency.
- **Browser security**: strict CSP, no CORS on `/admin`.
- **Secrets**: never sent to the browser or the logs, and encrypted at rest.
- **Legacy endpoints**: `/health`, `/metrics`, `/status`, `/ping`, `/api/info` and `POST /api/restart` with `PANEL_TOKEN` stay byte-compatible.
- **Tests**: `yarn test` stays offline and fast.

**Scale/Scope**:

- One admin, one bot, one WhatsApp session.
- Hundreds of groups.
- At most 200 targets per broadcast.
- About 13 panel screens.
- 64 functional requirements and 16 success criteria.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the unfilled template. The provisional gates come from `CLAUDE.md`, as in feature 001, plus one security gate for this feature:

| Gate | Pre-research | Post-design |
| ---- | ------------ | ----------- |
| G1 Settings read through `config.js`, not raw env | ⚠️ a few captures bypass it (`client.js` env reads, singletons, `imagesearch.js`, `panel.js`; research A1) | ✅ accessor `config.js` over `settingsStore`; capture sites listed in [contracts/runtime.md](contracts/runtime.md) |
| G2 No new dependency without justification | ✅ | ✅ none added. preact and htm are vendored as files (about 16 KB), justified in research B2/U13 |
| G3 One message pipeline (`lib/core/pipeline.js`) | ✅ | ✅ new behaviour enters as hooks (`groupguard` priority 50, `knownchats` observer) and registry checks; the pipeline only gains stat counters |
| G4 User-facing text via `getLang`, `en` and `fr` with the same keys | ✅ | ✅ bot texts stay in `lang/*.json` (overrides layered in `LanguageManager`); the panel UI uses its own `lib/admin/public/i18n/{en,fr}.json`, with the same-keys test |
| G5 Additive schema changes | ✅ | ✅ 14 new tables, 0 altered ([data-model.md](data-model.md)) |
| G6 (new) Panel security | n/a | ✅ every route declares `auth`; tests enumerate all routes for 401/CSRF and scan for seeded secrets (SC-004, SC-005) |

No violation, so Complexity Tracking stays empty. Recommendation (out of scope): ratify G1 to G6 as the constitution with `/speckit-constitution`.

## Project Structure

### Documentation (this feature)

```text
specs/002-admin-panel/
├── spec.md, plan.md, research.md, data-model.md, quickstart.md
├── research/              # Phase 0 streams A–D (detail and evidence; research.md arbitrates)
├── contracts/
│   ├── admin-http-api.md  # routes, auth levels, CSRF, error codes, SSE, legacy endpoints
│   ├── settings-catalog.md# every setting: theme, type, validation, effect, secret, readonly
│   └── runtime.md         # internal module contracts (store, client, registry, engines, admin composition)
├── checklists/requirements.md
└── tasks.md               # /speckit-tasks
```

### Source Code (repository root)

```text
config.js                      # EDIT accessor properties over settingsStore (override → env/file → default)
index.js, panel.js             # EDIT start the shared admin server; legacy exports kept for test/panel.test.js
lib/
├── admin/                     # NEW everything the panel serves
│   ├── index.js server.js events.js audit.js
│   ├── http/   router.js request.js response.js security.js static.js sse.js trustProxy.js
│   ├── auth/   password.js sessions.js tokens.js rateLimit.js
│   ├── logs/   ring.js redactor.js consoleCapture.js
│   ├── services/ settings.js commands.js texts.js groups.js pairing.js data.js broadcasts.js
│   │             backup.js storage.js keyTests.js stats.js alerts.js maintenance.js
│   ├── routes/ one file per area (auth, dashboard, settings, commands, groups, pairing, data,
│   │           broadcasts, backup, maintenance, texts, alerts, logs, stats, audit)
│   └── public/ index.html icons.svg css/{theme,app}.css i18n/{en,fr}.json
│               js/{app,router,api,i18n,live,ui}.mjs js/views/*.mjs js/components/*.mjs
│               vendor/{preact,preact-hooks,htm}.mjs LICENSE-* MANIFEST.json
├── utils/                     # NEW settingsStore.js secretBox.js logger.js broadcaster.js alerts.js
│                              #     updater.js runtime.js
│                              # EDIT language.js (overrides, lazy desc), http.js (key-refused signal,
│                              #      service name), antiDeleteHandler.js (cache stats/clear),
│                              #      downloader.js (busy state), 19 modules: pino( → logger
├── plugins/registry.js        # EDIT command state check, lazy descriptions, notifyOwners throttle, stats
├── core/pipeline.js           # EDIT message counters
├── baileys/client.js          # EDIT qr/state events, restart() single-flight, pairing code, resetSession()
└── database/models/           # NEW 14 models (Admin*, SettingOverride, CommandState, TextOverride,
                               #     AuditLog, DailyStat, KnownChat, Broadcast*, Alert*)
plugins/
├── groupguard.js              # NEW anti-link / anti-bot hook (priority 50)
├── knownchats.js              # NEW observer hook recording chats that wrote to the bot
└── update.js                  # EDIT reuse lib/utils/updater.js (rollback)
tools/                         # NEW admin-reset.js verify-boot.js measure-panel-memory.js
test/                          # NEW admin-*.test.js, broadcaster, alerts, backup, updater, storage,
                               #     keytests, groupguard, settings-store, texts; helpers/ additions
Dockerfile docker-compose.yml config.env.example README.md CLAUDE.md docs/  # EDIT ops and docs
```

**Structure Decision**: one deployable, with the panel embedded under `lib/admin/` (research R1). Code outside `lib/admin/` is limited to two kinds:

- engines that must work with the panel disabled: the store, the broadcaster, the alerts, the updater and the logger;
- hooks into existing seams: the registry, the client, the language manager and plugins.

## Execution Strategy (models and parallelism)

The user's standing rule applies: implementation runs on Sonnet 5.5 subagents in parallel, and Opus 5.5 is used only in extreme necessity. Each agent owns a disjoint set of files. Agents never commit; the orchestrator commits after each one in French conventional commits. Agents never read `config.env`, `sessions/`, `data/` or the database. Shared files (`config.js`, `registry.js`, `client.js`, `language.js`, `lang/*.json`, `lib/admin/public/i18n/*.json`, `test/helpers/fakes.js`) each have one owner per wave.

| Wave | Content | Parallelism |
| ---- | ------- | ----------- |
| W0 Foundation | logger factory and the 19 call sites; `settingsStore` + `secretBox` + accessor `config.js`; 14 models; HTTP core (router, security, static, SSE) + auth; client lifecycle (events, restart, pairing) | 5 agents, disjoint files |
| W1 Areas | one agent per area, owning its service + routes + views + tests: settings & texts, commands & registry hooks, groups & groupguard & knownchats, dashboard & pairing & logs & stats, data management, broadcaster & recurrence, backup, maintenance (updater, yt-dlp, storage, key tests), alerts | up to 9 agents |
| W2 Integration | SPA shell and navigation, panel i18n merge, shared server wiring in `index.js`/`panel.js`, Docker/compose/docs, memory script, full test run, quickstart checks | 2–3 agents, then the orchestrator |

Tasks in `tasks.md` carry their wave, model (`sonnet` by default) and owned files. Opus is planned for nothing. It is used only if a core W0 piece fails review twice.

## Complexity Tracking

No constitution violation to justify.
