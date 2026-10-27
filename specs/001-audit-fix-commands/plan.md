# Implementation Plan: Audit et correction des commandes du bot

**Branch**: `001-audit-fix-commands` | **Date**: 2026-10-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-audit-fix-commands/spec.md`

## Summary

The audit covered 80 commands in 5 parallel batches, with liveness checks on 2026-10-27; the findings are in [audit-findings.md](audit-findings.md) and the decisions in [research.md](research.md). Most plugin defects are symptoms of a few core gaps, so the core goes first:

1. **Registry**: regex matching (`.kiss` → `statussave`), `ownerOnly` ignored, `this` unbound (crashes `role`, `leaderboard`, `quote`, `idea`), errors leaked to users, whitespace collapsed in arguments.
2. **Pipeline**: two diverging copies; hooks exported but never called (AFK, filters, tracking, welcome/goodbye, notify, ban); **button clicks never parsed** (native-flow), so no button handler can fire; history batches re-run.
3. **Identity**: no LID support, so the owner fails sudo checks and admin checks fail in LID chats.
4. **Persistence**: AFK, ban, reminders, tasks and notify are held in memory; the economy is not atomic (double spending, plus the `dice` bug that generates coins).
5. **External services**: 9 commands are dead (YouTube/play-dl, Instagram, socialdl backend, lyrics, Pinterest, Reddit, Giphy, Imagen 4, quotable).
6. **Dependencies**: 3 major upgrades, 18 unused packages, 2 abandoned or deprecated packages (`play-dl` → `yt-dlp`, `fluent-ffmpeg` → `execFile`), and a stale local `node_modules`.
7. **i18n**: about 300 hard-coded replies, and keys called but missing from the language files.

Approach: dependencies and the core first (a shared pipeline with a hook contract, an exact alias map, LID-aware `Message` helpers, new models, shared utilities). Then the plugins are fixed in **parallel batches with disjoint files**. Translations are written as fragments and merged by a script. Verification uses `node:test` with no network.

## Technical Context

**Language/Version**: JavaScript (CommonJS), Node.js >= 24 (engines, `node:24-alpine`); locally `nvm use 24`.

**Primary Dependencies**: `baileys` 7.0.0-rc14, `sequelize` 6, `axios` 1.21, `@google/genai` 2.31, `openai` 7, `@ryuu-reinzz/button-helper`, `pino` 10. System binaries: `ffmpeg`, **`yt-dlp`** (new).

**Storage**: Sequelize (SQLite / Postgres), `sync({ alter: true })`. 4 new tables and 1 new column, all additive ([data-model.md](data-model.md)).

**Testing**: `node:test` via `yarn test` (built in; fakes and stubs, no network) plus a manual checklist ([quickstart.md](quickstart.md)).

**Target Platform**: Linux server (Docker, PM2, panel hosts).

**Project Type**: long-running bot service (WhatsApp client plus plugins).

**Performance Goals**: `onMessage` hooks served from caches, with no DB query per message on the hot path; external calls capped at 30 s (SC-004; 180 s for yt-dlp downloads).

**Constraints**: public command names unchanged, except to fix collisions and add documented aliases; additive DB changes; panel mode identical to normal mode; tests under 2 min.

**Scale/Scope**: 81 plugin files (~10 500 lines), 13 `lib/` modules, 10 locales (`en` and `fr` maintained).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the unfilled template, so no ratified principle applies. The provisional gates are drawn from `CLAUDE.md`:

| Gate | Pre-research | Post-design |
| ------ | -------------- | ------------- |
| G1 Plugins use `Message` helpers and `config.js`, not raw env or socket internals | ❌ (env read in plugins, quoted shapes rebuilt by hand) | ✅ helpers (research E), config keys centralized |
| G2 No new dependency without justification | ✅ | ✅ only `luxon` (time zones) and the `yt-dlp` binary (replaces dead play-dl), both justified in research D/C; 18 removed |
| G3 One source of truth for message processing | ❌ | ✅ `lib/core/pipeline.js` |
| G4 User-facing text via `getLang`, `en` + `fr` | ❌ | ✅ fragments + merge + tests |
| G5 Additive schema changes under `alter` | n/a | ✅ [data-model.md](data-model.md) |

Recommendation (out of scope): ratify a constitution from G1 to G5 with `/speckit-constitution`.

## Project Structure

### Documentation (this feature)

```text
specs/001-audit-fix-commands/
├── spec.md, plan.md, research.md, data-model.md, quickstart.md
├── audit-findings.md      # raw per-plugin findings (file:line), input for implementers
├── contracts/
│   ├── plugin-contract.md   # exports, flags, ctx, hooks, helpers
│   ├── registry-matching.md # exact alias matching
│   └── pipeline.md          # shared processMessage + events
├── i18n/                  # per-plugin translation fragments (wave 1 output, merged in wave 2)
└── tasks.md               # /speckit-tasks
```

### Source Code (repository root)

```text
lib/
├── core/pipeline.js             # NEW: attachHandlers + processMessage
├── plugins/{loader,registry}.js # sorted load, hooks, alias map, flags, ctx, `this`, generic errors
├── classes/Message.js           # LID, nativeFlow, quoted.key, getQuotedMedia/Text, sendAudioFile/Voice
├── database/models/             # NEW: BannedChat, Reminder, Task, NotifyKeyword; Group.goodbye
└── utils/
    ├── permissions.js           # NEW: getOwnerJids, guardTarget, assertParticipantResult
    ├── http.js                  # NEW: fetchJson/fetchBuffer/classifyError/withTimeout
    ├── ffmpeg.js                # NEW: runFfmpeg, toOpusVoice (replaces fluent-ffmpeg)
    ├── downloader.js            # NEW: yt-dlp wrapper
    ├── gameStore.js, cooldown.js# NEW
    ├── scheduler.js             # NEW: persisted reminders
    └── media.js, settingsCache.js, *Handler.js  # fixes
plugins/*.js                     # per-plugin fixes + getLang
lang/en.json, lang/fr.json       # common.*, extra.*, all plugin keys
tools/merge-i18n.js              # NEW
tools/check-unused-deps.js       # NEW
test/helpers/fakes.js, test/*.test.js  # NEW
docs/AUDIT_COMMANDES.md          # NEW: audit report + manual checklist
index.js, panel.js, config.js, config.env.example, package.json, Dockerfile, CLAUDE.md
```

**Structure Decision**: keep the existing single project; add `lib/core/` and `test/`. No reorganization of `plugins/`.

## Execution strategy (input for `/speckit-tasks`)

User routing preference: **Sonnet 5.5 for all implementation; Opus 5.5 only where a mistake would cascade** (core contracts, final review). Independent tasks run as parallel subagents on **disjoint file sets**.

| Wave | Content | Model | Parallelism |
| ------ | --------- | ------- | ------------- |
| 0 | **A. Dependencies**: package.json, yarn.lock, Dockerfile (yt-dlp), `config.js` (dotenv 18 plus all new config keys), call-site adaptations (openai 7, simple-git 4, file-type ESM), `lib/utils/ffmpeg.js` and `tts.js` (fluent-ffmpeg removal), `tools/check-unused-deps.js` | Sonnet | in parallel with B and C |
| 0 | **B. Core**: registry, loader, pipeline, Message, permissions.js, BannedChat model, Group.goodbye, index.js/panel.js, `common.*` and `extra.*` keys in lang/*.json, settingsCache invalidation | **Opus** | in parallel with A and C |
| 0 | **C. Utilities**: http.js, media.js `withTempDir`, downloader.js, gameStore.js, cooldown.js | Sonnet | in parallel with A and B |
| 1 | 9 plugin groups (owner/WA; group/admin; stats/economy; games; media; downloaders; AI/info; scheduling/menu/utility) + test harness | Sonnet | up to 10 agents, disjoint files; no edits to lang/*.json, lib/core, lib/plugins, Message.js, config.js |
| 2 | i18n merge, `yarn test`, fixes driven by failures | Sonnet | serial |
| 3 | Audit report + CLAUDE.md (Sonnet) ∥ final review (**Opus**) | mixed | 2 in parallel |

## Complexity Tracking

No constitution violations to justify.
