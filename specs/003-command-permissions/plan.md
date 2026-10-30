# Implementation Plan: Permissions par commande

**Branch**: `003-command-permissions` | **Date**: 2026-10-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-command-permissions/spec.md`

## Summary

<!-- filled after Phase 0 -->

## Technical Context

**Language/Version**: JavaScript, CommonJS on the bot side and native ES modules (`.mjs`) in the panel SPA; Node >= 24 (`package.json` engines). No build step.

**Primary Dependencies**: Baileys v7 (rc), Sequelize (SQLite, or Postgres when `DATABASE_URL` says so), pino through `lib/utils/logger.js`, vendored Preact 10.29.8 + htm 3.1.1 for the panel. No new dependency is planned.

**Storage**: the existing database through Sequelize, with new tables only (additive `sync()`); in-memory cache through `lib/utils/settingsCache.js`.

**Testing**: `node:test` (`yarn test`, about 2,350 tests in about 20 s, no network, no WhatsApp), in-memory SQLite, `test/helpers/` (fakes, adminHarness, adminClient, fakeDom).

**Target Platform**: Linux server or container (Docker, PM2); the panel runs in current desktop and mobile browsers.

**Project Type**: a single Node process (WhatsApp bot) serving its own admin panel (raw `node:http` + SPA).

**Performance Goals**: the permission decision adds no perceptible delay to a command (SC-005). With a warm cache it costs no database query, and it stays O(1) per message even with several hundred rules.

**Constraints**:

- with no rule, behaviour is byte-identical to today (SC-004, FR-029);
- if the rules cannot be loaded, owner-only commands stay owner-only (FR-011);
- one pipeline (`lib/core/pipeline.js`) and one registry;
- panel security rules (every route declares `auth`, CSRF, strict schemas, audit);
- strict CSP in the SPA;
- `en`/`fr` with the same keys.

**Scale/Scope**:

- 83 plugin files: 16 owner-only commands, 14 of them non-delegable, and 9 admin-only commands;
- one group tab and one Commands page extension in the panel;
- 29 functional requirements and 6 success criteria.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the unfilled template. The provisional gates are those of features 001 and 002, taken from `CLAUDE.md`:

| Gate | Pre-research | Post-design |
| ---- | ------------ | ----------- |
| G1 Settings read through `config.js`, not raw env; no capture of a `config.X` at module level | ✅ the feature adds no setting | <!-- post-design --> |
| G2 No new dependency without justification | ✅ none planned | <!-- post-design --> |
| G3 One message pipeline (`lib/core/pipeline.js`) and one registry | ✅ the decision goes into `registry.executeCommand` | <!-- post-design --> |
| G4 User-facing text via `getLang`; `en` and `fr` with the same keys (bot and panel) | ✅ | <!-- post-design --> |
| G5 Additive schema changes (new tables only, no unique index on an existing table) | ✅ new tables only | <!-- post-design --> |
| G6 Panel security (every route declares `auth`, CSRF, strict schema, audit, `confirm` for destructive routes) | ✅ | <!-- post-design --> |
| G7 (new) Owner-only safety: no rule, even a forged one, can open a non-delegable command (SC-003) | n/a | <!-- post-design --> |

## Project Structure

### Documentation (this feature)

```text
specs/003-command-permissions/
├── spec.md              # /speckit-specify
├── plan.md              # This file (/speckit-plan)
├── research.md          # Phase 0 decisions (consolidated)
├── research/            # Phase 0 streams A (runtime), B (data + backend), C (panel UI)
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1 (manual checklist on a real device)
├── contracts/           # Phase 1
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks, not created here)
```

### Source Code (repository root)

<!-- filled after Phase 1 -->

## Execution Strategy (models and parallelism)

<!-- filled after Phase 1 -->

## Complexity Tracking

<!-- filled after the post-design gate check -->
