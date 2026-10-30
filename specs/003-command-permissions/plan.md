# Implementation Plan: Permissions par commande

**Branch**: `003-command-permissions` | **Date**: 2026-10-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-command-permissions/spec.md`

## Summary

From the admin panel only, the owner can open or close any delegable command to named people, either in one group or everywhere.

- **Rules.** A rule is `(command, scope)` with a mode: `extra` means "normal + these people" and `only` means "these people only".
- **Engine.** A new engine, `lib/utils/commandPermissions.js`, returns a verdict for every command call: `owner`, `granted`, `closed` or `normal`. It reads one cached index (`command_perms`) that holds both the phone-number and the LID form of each person.
- **Registry.** `registry.executeCommand` asks for that verdict right after detecting the owner:
  - `closed` returns in silence;
  - `granted` skips the owner and admin gates;
  - every other check keeps today's order and messages, so with no rule the behaviour is byte-identical (SC-004).
- **Non-delegable commands.** Fourteen owner-only commands declare `delegable: false` with a reason code. Owner-only commands are locked by default. The engine checks the flag before reading any rule (SC-003).
- **`.vv`.** When someone other than the owner uses it, the media goes to that person's private chat, never to the group. `.save` already sends to the requester.
- **Menu and help.** They reuse the same verdict.
- **Storage.** Rules live in one new table, `permission_rules`. The people are a JSON list of `{ pn, lid }`, with at most 100 per rule. The table is included in panel backups.
- **Panel API.** It gains 7 routes (PERM-1..7) and the new groups-service helper `participants(jid)`. The UI is a seventh group tab, "Permissions", plus a column and an editor card on the Commands page, sharing one rule editor that saves through an explicit Save. Every write is audited as `command.permission.set` / `command.permission.delete`.

Decisions: [research.md](research.md) (owner decisions U1-U8, arbitration X1-X12).

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
- 31 functional requirements and 6 success criteria.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the unfilled template. The provisional gates are those of features 001 and 002, taken from `CLAUDE.md`:

| Gate | Pre-research | Post-design |
| ---- | ------------ | ----------- |
| G1 Settings read through `config.js`, not raw env; no capture of a `config.X` at module level | ✅ the feature adds no setting | ✅ no setting, no capture (the engine reads only the database and the registry entry) |
| G2 No new dependency without justification | ✅ none planned | ✅ none |
| G3 One message pipeline (`lib/core/pipeline.js`) and one registry | ✅ the decision goes into `registry.executeCommand` | ✅ pipeline untouched; stickers already reach the registry ([contracts/runtime.md](contracts/runtime.md)) |
| G4 User-facing text via `getLang`; `en` and `fr` with the same keys (bot and panel) | ✅ | ✅ no new bot key; panel keys in one fragment, merged into both catalogs ([contracts/panel-ui.md](contracts/panel-ui.md)) |
| G5 Additive schema changes (new tables only, no unique index on an existing table) | ✅ new tables only | ✅ one new table with a composite PK, nothing altered ([data-model.md](data-model.md)) |
| G6 Panel security (every route declares `auth`, CSRF, strict schema, audit, `confirm` for destructive routes) | ✅ | ✅ 7 session routes, strict schemas, audited writes; single-rule idempotent DELETE without `confirm` (precedent GRP-10) ([contracts/admin-permissions-api.md](contracts/admin-permissions-api.md)) |
| G7 (new) Owner-only safety: no rule, even a forged one, can open a non-delegable command (SC-003) | n/a | ✅ `delegable` checked before any rule is read; owner-only locked by default; guard test on hand-inserted rows |

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
├── contracts/           # Phase 1: runtime.md (engine, registry, plugins, .vv/.save, menu/help),
│                        #   admin-permissions-api.md (PERM-1..7), panel-ui.md (views, logic, i18n keys)
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks, not created here)
```

### Source Code (repository root)

```text
lib/
├── utils/
│   ├── commandPermissions.js     # NEW engine: decide(), cache command_perms, constants (contracts/runtime.md)
│   ├── permissions.js            # export identitiesOf()
│   └── settingsCache.js          # header: key command_perms
├── plugins/registry.js           # entry.delegable / entry.lockReason; verdict in executeCommand
├── database/models/
│   └── PermissionRule.js         # NEW table permission_rules (data-model.md)
└── admin/
    ├── audit.js                  # ACTIONS += command.permission.set|delete
    ├── backup/format.js          # MODELS += PermissionRule (25 -> 26)
    ├── routes/permissions.js     # NEW PERM-1..7 (contracts/admin-permissions-api.md)
    ├── services/
    │   ├── permissions.js        # NEW createPermissionsService: parse, merge, warnings, orphans, writes
    │   └── groups.js             # participants(jid), counts.permissions, deleteSettings += rules
    └── public/
        ├── i18n/{en,fr}.json     # merged from specs/003-command-permissions/i18n/panel-permissions.json
        └── js/views/
            ├── permissions-logic.mjs     # NEW pure logic (contracts/panel-ui.md)
            ├── permissions-editor.mjs    # NEW RuleEditor (shared)
            ├── permissions-members.mjs   # NEW GroupMemberPicker
            ├── permissions-picker.mjs    # NEW PersonPicker (known chats + typed number)
            ├── groups-permissions.mjs    # NEW group tab
            ├── commands-permissions.mjs  # NEW Commands page card
            ├── groups-logic.mjs, groups-page.mjs, commands.mjs   # edits (tab, column, deep links)
            ├── audit-logic.mjs           # summarizeDetail branch for rule details
            └── backup-logic.mjs          # PermissionRule in the "config" group
plugins/
├── eval.js, update.js, exportcontacts.js, banchat.js, unbanchat.js, viewonce.js, getvv.js,
│   antidel.js, getantidel.js, autorespond.js, statussave.js, stickercmd.js, delcmd.js, getcmd.js
│                                 # delegable: false + lockReason
├── vv.js                         # delegable: true; requester's DM for non-owners
├── save.js                       # delegable: true; no owner fallback
└── help.js, menu.js, buttonmenu.js   # visibility through decide()
specs/003-command-permissions/i18n/panel-permissions.json   # NEW panel strings (en + fr)
test/
├── command-permissions.test.js, command-delegable.test.js,
│   vv-save-delegated.test.js, help-menu-visibility.test.js          # NEW (bot)
├── admin-permissions.test.js                                        # NEW (API)
├── admin-view-permissions.test.js, admin-view-permissions-dom.test.js   # NEW (views)
└── database, backup, admin-backup, admin-view-backup, helpers/backupKit,
    admin-groups, admin-integration (contract parser), admin-view-groups,
    admin-i18n (second fragment dir)                                 # expectation edits only
CLAUDE.md, docs/AUDIT_COMMANDES.md                                   # docs
```

**Structure Decision**: same single-process layout as features 001 and 002. The feature adds one engine module, one model, one panel area (routes + service), six views and seven test files, and touches no boot code, pipeline or client.

## Execution Strategy (models and parallelism)

The user's standing rule applies (reconfirmed 2026-10-30): `/speckit-implement` runs on **Sonnet 5.5 subagents** in parallel, and **Opus 5.5 is used only in extreme necessity**.

- Each agent owns a disjoint set of files.
- Agents never commit. The orchestrator commits after each finished agent, in French conventional commits on `003-command-permissions`.
- Agents never read `config.env`, `sessions/`, `data/` or the database, and run scripts with `OWB_NO_CONFIG_ENV=1`.
- Shared files have a single owner per wave: `registry.js`, `services/groups.js`, `lib/admin/public/i18n/*.json`, `test/helpers/*`.

| Wave | Content | Parallelism |
| ---- | ------- | ----------- |
| W0 Foundation | (a) engine `commandPermissions.js` + `identitiesOf` export + registry flags/verdict + the 16 plugin flags + engine and delegable tests; (b) `PermissionRule` model + backup `MODELS` + database/backup test edits; (c) `permissions-logic.mjs`, `RuleEditor`, both pickers, i18n fragment, logic tests (against a fake `fetch`) | 3 agents, disjoint files |
| W1 Behaviour + API | (d) `.vv`/`.save` delegated + help/menu/buttonmenu visibility + their tests (needs a); (e) panel service + PERM routes + groups-service additions + audit `ACTIONS` + contract parser + `admin-permissions.test.js` (needs a, b) | 2 agents |
| W2 Views | (f) group tab + `groups-logic`/`groups-page` edits + group view tests; (g) Commands page card + column + `audit-logic`/`backup-logic` edits + their tests (both need e for contract test 11); then a single owner merges the panel i18n fragment | 2 agents, then 1 |
| W3 Integration | `CLAUDE.md` and `docs/AUDIT_COMMANDES.md`, full `yarn test`, `node tools/check-unused-deps.js`, quickstart automated checks | 1 agent, then the orchestrator |

Tasks in `tasks.md` carry their wave, their model (`sonnet` by default) and the files they own. Opus is planned for nothing. The orchestrator escalates a task to Opus only if a core W0 piece (engine or registry order) fails review twice.

## Complexity Tracking

No constitution violation to justify.
