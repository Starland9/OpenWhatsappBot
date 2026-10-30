# Phase 0 Research: decisions

Inputs: three parallel research streams (Sonnet, read-only, 2026-10-30), each with `file:line` evidence and throwaway spikes outside the repo:

| Stream | File | Scope |
| --- | --- | --- |
| A | [research/a-runtime.md](research/a-runtime.md) | decision engine `lib/utils/commandPermissions.js`, registry order, PN/LID matching, `delegable` flag and the 16 owner-only plugins, `.vv`/`.save` delegated, menu/help visibility, bot tests, docs |
| B | [research/b-data-backend.md](research/b-data-backend.md) | `PermissionRule` model, backup, panel routes PERM-1..7 and service, identity parsing/merging, warnings/orphans, audit, backend tests |
| C | [research/c-panel-ui.md](research/c-panel-ui.md) | group "Permissions" tab, Commands page column and editor, shared `RuleEditor` and pickers, pure logic, panel i18n fragment, audit page, view tests |

The stream files hold the detail (Decision / Rationale / Alternatives / Evidence / Files). **This file is authoritative where they disagree**: the owner's decisions (section 1) and the arbitration (section 2) override any stream recommendation.

## 1. Owner decisions taken during research (2026-10-30)

All eight follow the recommended answer; the spec was updated accordingly (Clarifications, second session).

| # | Question | Decision | Spec |
| --- | --- | --- | --- |
| U1 | Command both disabled and `only`, person not listed | **Silence** (the command is invisible to him); listed people and the owner get `common.command_disabled` | FR-006 step 5 |
| U2 | Delegated `.vv` usage text / media too large | **DM to the requester**, best effort; nothing in the group | FR-018 |
| U3 | Restore the normal level in one group despite an "everywhere" `only` rule | A group rule `extra` **with an empty list** = "niveau normal ici"; allowed for a group scope only, shown as an exception | US3.3, FR-020 |
| U4 | "Oublier ce groupe" (GRP-6) | **Also deletes** the group's rules; a group the bot simply left keeps them | FR-030 |
| U5 | Typed numbers | **Country code required**, 8 to 15 digits; spaces, `+`, `-`, `.`, parentheses and a leading `00` stripped; no default-country setting | US3.5, FR-031 |
| U6 | Default for a future owner-only command | **Non-delegable unless its code says `delegable: true`**; a test forces the explicit choice | FR-012 |
| U7 | Reason shown for non-delegable commands | **Five codes** `code`, `update`, `data`, `lockout`, `config`, plus a fallback | FR-022 |
| U8 | Rule editor save model | **Draft + explicit Save**, warnings shown before the save, one audit row per save | FR-020 |

The server does not check that a person is a member of the group when a rule is saved (B open point 3). This follows from the spec, since the bot may be offline (FR-031), so it is not an owner decision.

## 2. Arbitration between the streams

| # | Topic | Conflict | Decision |
| --- | --- | --- | --- |
| X1 | Stored mode values | A: `add`/`only`; B, C: `extra`/`only` | **`extra` and `only`**. Constants `MODES = { EXTRA: "extra", ONLY: "only" }` live in `lib/utils/commandPermissions.js` (B10) |
| X2 | Non-delegable flag | A: `delegable`; C: `neverDelegable: true \| "<code>"` | **`command: { delegable: false, lockReason: "<code>" }`**. The registry copies both onto the entry: `delegable = typeof delegable === "boolean" ? delegable : !(fromMe \|\| ownerOnly)` (A7, U6), and `lockReason` is set only when `delegable === false`, `null` otherwise. The 14 FR-013 plugins declare `delegable: false` with their code (A8, C7); `vv.js` and `save.js` declare `delegable: true` |
| X3 | Panel API shape | C assumed CMD-1 extended; B kept CMD-1 frozen (`test/admin-commands.test.js:99,104`) | **B's PERM-1..PERM-7** (B6) with path parameters `:name` and `:jid` only (`:command` makes the router throw). The Commands page fetches PERM-1 next to CMD-1 and merges by `name`. GRP-3 gains `counts.permissions` |
| X4 | `extra` with an empty list | A needs it (US3.3); B and C refused it | Allowed **for a group scope only** (U3). Refused for `*` with `422 { people: required }` (it would be a no-op). C's `canSave` follows the same rule |
| X5 | Warning codes | B (server) and C (client) used different ids | One vocabulary, computed by the server on read/PUT and recomputed live by `permissions-logic.mjs`: `opens_admin_command` (params `{ count, everywhere }`), `extra_on_public`, `empty_only`, `normal_here` (group `extra` with an empty list; tone info if an everywhere `only` rule exists, otherwise warn "sans effet"). The client adds two info-only ids from data it already has: `disabled_here` and `context_only` |
| X6 | Audit | C proposed `permission.*` with a new prefix; B `command.permission.*` | **`command.permission.set` / `command.permission.delete`** (prefix `command` already exists, no `ACTION_PREFIXES` change). Target `<command>:<scope>`, detail `{ mode, previousMode, added, removed }` with compact ids (B9). Adopt C10's `summarizeDetail` branch so the audit page shows "mode, +N, -M" with the ids, instead of a JSON cut at 160 characters |
| X7 | Refusal of a non-delegable command | C: `fields.command`; B: `fields.name` | **`422 validation_failed`, `fields.name = { code: "not_allowed" }`** (the path parameter is `name`). No new envelope code |
| X8 | Route-contract guard (`test/admin-integration.test.js:169`) | — | New contract file [contracts/admin-permissions-api.md](contracts/admin-permissions-api.md) (rows PERM-1..7), and `contractRoutes()` also parses it (B11) |
| X9 | Registry order | FR-006 listed "disabled" first; today the owner gate comes first (`test/command-state.test.js:186`) | A3's order, now written in FR-006: banned chat (pipeline) → verdict → `closed` silent → owner gate unless granted → `command_disabled` → context → admin unless granted |
| X10 | Person pickers and annotations | — | Group picker: GRP-11 members (C3). "Everywhere" picker: CHAT-1 `kind=private` plus a typed number (C8, U5). `present` and `admin` are computed **server-side** by a new non-throwing `groups.participants(jid)` (B6); the browser never compares JIDs |
| X11 | Storage | — | One table `permission_rules`, PK `(command, scope)`, `people` JSON `[{ pn, lid }]` (max 100), validators on `mode` and `people` (B1). The engine loader never uses `raw: true` (a JSON column comes back as a string on SQLite) |
| X12 | i18n | — | Panel strings: fragment `specs/003-command-permissions/i18n/panel-permissions.json`, merged with `node tools/merge-panel-i18n.js --frag-dir specs/003-command-permissions/i18n` (C9, `--frag-dir` verified). `test/admin-i18n.test.js` scans both fragment directories. Bot side: no new key; delegated `.vv` DMs reuse existing keys (A13) |

## 3. Behaviour not covered by the rules

These are documented, as feature 002 did for `disabled` (A6):

- `onMessage` hooks (`afk`, `addfilter`, `notify`, `trackmessages`, `groupguard`) and `handleButtonReply` handlers are not command dispatch. A rule never stops them.
- Checks inside a plugin (`stats reset`, `idea`, `quote`, `reminder list all`, cooldown exemptions in `chatgpt`, `gemini`, `imagen`, `voice`) stay as they are: a rule opens the command, not its owner-only sub-actions.
- `describeAccess` in `.help` is unchanged, so a granted member sees "propriétaire" on the `.vv` card.
- `.help eval` from a non-owner still shows the card (today's behaviour, FR-029). Only `closed` commands are hidden.

## 4. Gate notes for the plan

- G2: no new dependency.
- G3: the decision enters through `registry.executeCommand` only; the pipeline is unchanged (stickers already go through the registry, A6).
- G5: one new table, nothing altered.
- G6: 7 routes, all `auth: "session"`, strict schemas, audited writes; the DELETE routes are single-rule, idempotent and need no `confirm` (precedent GRP-10).
- G7 (owner-only safety): `decide` checks `entry.delegable` before reading any rule (A2 step 2). A test inserts rows by hand on each non-delegable command and checks that nothing opens (SC-003).
