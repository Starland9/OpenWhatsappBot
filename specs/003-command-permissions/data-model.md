# Phase 1: data model

Feature `003-command-permissions`. Inputs: [spec.md](spec.md) (FR-001 to FR-031, second Clarifications session), [research.md](research.md) (**authoritative**: owner decisions U1-U8 and arbitration X1-X12 override the stream files), research streams [A](research/a-runtime.md) (engine), [B](research/b-data-backend.md) (data, backend), [C](research/c-panel-ui.md) (UI), and the house style of [002's data model](../002-admin-panel/data-model.md). API shapes live in [contracts/admin-permissions-api.md](contracts/admin-permissions-api.md).

Sequelize 6, SQLite (default) or Postgres (`DATABASE_URL` containing `postgres`). Nothing here is implemented yet; the tables below are the contract for the model file `lib/database/models/PermissionRule.js`.

## 0. Compliance and conventions

### 0.1 Additive-sync compliance (CLAUDE.md "Database", G5)

| Rule | Status |
|---|---|
| New tables are created by `Model.sync()` (step 1 of `sync()`, `lib/database/index.js`) with their primary key | 1 new table: `permission_rules`, composite PK `(command, scope)` |
| No existing table altered (no column, no index, no type change) | 0 existing model file touched |
| No new unique index on an existing table | none; the composite PK is the only uniqueness, on the new table |
| Later columns on this table | must be nullable or defaulted; no later unique index, no column type change |
| Secondary index | none: a few hundred rows at most, always read whole (engine cache) or by `command` / `scope` (panel) |
| Foreign keys | none (repo convention). `command` points at a registry entry name, `scope` at `*` or a group JID; nothing enforces it, orphans are handled by the service (section 3) |

Dialects: `JSON` is `json` on Postgres (an object comes back in both read modes) and `JSON` text on SQLite (see the pitfall in 1.4). Spike on SQLite: `defaultValue: []` creates `people JSON NOT NULL DEFAULT '[]'` and reads back as an array. The Postgres path is untested in this repository, as for every table.

### 0.2 Conventions followed

| Topic | Rule applied here |
|---|---|
| File and model | `lib/database/models/PermissionRule.js`, `sequelize.define("PermissionRule", attrs, { tableName: "permission_rules", timestamps: true })`, auto-loaded under the file name |
| Enumeration | `STRING` + `validate.isIn`, never `DataTypes.ENUM` (as `Reminder.status`) |
| Composite PK without surrogate id | precedents `CommandState`, `GroupRole`; no `AUTO_INCREMENT_MODELS` entry, no Postgres sequence reset |
| JSON column | precedent `Broadcast.targets`: exported with `row.get({ plain: true })`, re-validated on restore by `instance.validate()` |
| Names | `command` = registry entry `name` (first alias, lower case), same convention as `CommandState.command` |

### 0.3 Spec entity to storage map

| Spec "Key Entity" | Stored in |
|---|---|
| Règle de permission (command, scope, mode, dates) | one `permission_rules` row |
| Bénéficiaire (number, LID when known, once per rule) | one element of the row's `people` list; "once per rule" is a service invariant (contract 1.3), not a database constraint |
| Commande: attribute "jamais délégable" | **not stored**: declared in plugin code, copied onto the registry entry (section 2.4) |

---

## 1. PermissionRule

**Purpose.** Who may use one command in one scope, beyond or instead of its normal level (FR-001, FR-002).
**Table** `permission_rules`. **Backup**: yes (FR-026, section 4). **Retention**: forever, removed only by the owner (FR-005; housekeeping never touches it). **Writer**: the panel service `lib/admin/services/permissions.js` only (FR-019: no WhatsApp command writes a rule); plus the GRP-6 transaction in `services/groups.js`, restore, and a manual edit. **Readers**: the engine `lib/utils/commandPermissions.js` (cached), the panel service (direct, always fresh). **Cache**: `settingsCache` key `command_perms` (section 2). **Sensitivity**: phone numbers of the people named (like `GroupRole.userJid`); never in a response or log beyond what the contract lists.

### 1.1 Columns

| Column | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `command` | STRING(64), PK part | not null | registry entry `name` (first alias, lower case). A renamed first alias orphans the row (as for `CommandState`) |
| `scope` | STRING(255), PK part | not null, default `"*"` | `"*"` = "partout" (every group **and** private chats), otherwise a group JID. Not validated by the model; the engine consults a group scope only when `message.jid` equals it, so a malformed scope is inert |
| `mode` | STRING(5) | not null | `extra` = "normal + ces personnes", `only` = "ces personnes seulement". `validate: { isIn: [["extra", "only"]] }`. The constants `MODES = { EXTRA: "extra", ONLY: "only" }` live in `lib/utils/commandPermissions.js` (X1) |
| `people` | JSON | not null, default `[]` | list of `{ pn, lid }`, at most 100, custom validator (1.3) |
| `createdAt` / `updatedAt` | timestamps | | `createdAt` = first save of the rule, kept by every replace; `updatedAt` = last write that changed the row |

PK `(command, scope)` gives "one rule per command and scope" (spec Key Entities) at database level. SQL shape (SQLite): `CREATE TABLE permission_rules (command VARCHAR(64) NOT NULL, scope VARCHAR(255) NOT NULL DEFAULT '*', mode VARCHAR(5) NOT NULL, people JSON NOT NULL DEFAULT '[]', createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL, PRIMARY KEY (command, scope))`.

### 1.2 Validators

| Attribute | Validator | Failure |
|---|---|---|
| `mode` | `isIn(["extra", "only"])` | `build().validate()` rejects; on restore: `backup_invalid_row` |
| `people` | custom `personList(value)` (1.3) | same |

No validator ties `mode` to `people.length`: `extra` with an empty list is a legal **row** (group scope = "niveau normal ici"); the refusal of that combination for `*` is a service rule (contract 1.6), so a hand-made row cannot break the engine (an empty `extra` at `*` is a no-op).

### 1.3 `people` element and normalization

```json
[{ "pn": "237690000001@s.whatsapp.net", "lid": "123456789012345@lid" }, { "pn": null, "lid": "987654321098765@lid" }]
```

| Property | Rule |
|---|---|
| shape | array, 0 to 100 items (`MAX_PEOPLE = 100`); each item an object with exactly the keys `pn` and `lid` |
| `pn` | `string` ending `@s.whatsapp.net`, or `null` |
| `lid` | `string` ending `@lid`, or `null` |
| at least one form | `pn` and `lid` both `null` is invalid |
| normalized | each non-null form equals `normalizeJid(form)` (`lib/utils/permissions.js`): no device suffix (`:7`), `c.us` mapped, lower-case server, non-empty user part |
| duplicates | not rejected by the validator: "a person once per rule" is a service invariant (identity merge, contract 1.3); the engine indexes into a `Set`, so a duplicate in a hand-edited backup is harmless |
| order | as saved (display order); carries no meaning for the engine |

`pn` is stored as soon as it is known (spec Assumptions, as for group roles); a LID-only person is accepted when the number is unknown. A person stored with one form is not an error: the engine's slow path resolves the other form at decision time (a-runtime A5). The panel's display key is `jid = pn || lid`; names are never stored.

**Pitfall (loader and exporters).** On SQLite, `findAll({ raw: true })` returns `people` as a **string**; model instances return an array. The engine loader and any reader must use instances (or `row.get({ plain: true })`) and sanitize each element (skip a non-object, a form that normalizes to `""`). `dumpTables()` in `test/helpers/adminHarness.js` only stringifies and is unaffected.

### 1.4 Row semantics

| Scope | Mode | People | Meaning | Written by the panel |
|---|---|---|---|---|
| `*` | `extra` | 1+ | command keeps its normal level; the people listed may also use it in every group and in private | yes |
| `*` | `extra` | 0 | no-op ("normal") | **refused** `422 people: required` (X4) |
| `*` | `only` | 1+ | only the people listed and the owner, everywhere, except in a group that has its own rule | yes |
| `*` | `only` | 0 | the owner alone, everywhere, except in a group that has its own rule (warning `empty_only`) | yes |
| group JID | `extra` | 1+ | normal level + the people listed, in that group; also cancels an everywhere `only` for that group | yes |
| group JID | `extra` | 0 | **"niveau normal ici"** (U3, X4): cancels an everywhere `only` for that group; people listed everywhere keep their personal pass. Shown as an exception | yes (group scope only) |
| group JID | `only` | 1+ / 0 | only the people listed and the owner, in that group (0 people: owner alone, warning `empty_only`) | yes |

Reading rule (FR-006 steps 3-4, a-runtime A2, for reference; the engine owns the algorithm): a person listed in the `*` row **or** in the row of the current group is granted. Otherwise the mode of the current group's row applies if that row exists (whatever its mode or list), else the mode of the `*` row, else normal. `only` closes the command to everyone not granted and not the owner (silent); `extra` leaves the normal gates. A person's `*` listing is a personal pass in every group, including a group whose row says `only` without that person (US3.4).

### 1.5 What is NOT stored

| Not stored | Where it lives instead |
|---|---|
| Mode "normal" | nothing: absence of a row. Deleting the `*` row returns the command to its normal level; deleting a group row restores what the `*` row says (spec Assumptions) |
| Person names | read from `KnownChat.name` (push names of people who wrote to the bot in private) at read time; `null` is normal for group members |
| Delegability and its reason | plugin code (`delegable`, `lockReason`), copied onto the registry entry (2.4); the panel cannot change it |
| `present` / `admin` of a person | computed per request from group metadata (contract `Person`) |
| Warnings and orphan status | computed per request (contract 1.5, 1.6) |
| Expiry, grant history | no expiry (FR-005); history is the audit trail (`command.permission.set` / `.delete`) |
| Group roles (`vip`, `muted`, `banned`) | `GroupRole`, unrelated (spec Assumptions) |

---

## 2. Engine cache and registry additions

### 2.1 Cache shape (`settingsCache` key `command_perms`, TTL 5 min)

```text
state = { byCommand: Map<commandName, { global: Rule | null, groups: Map<groupJid, Rule> }> }
Rule  = { mode: "extra" | "only", members: Set<normalizedJid> }
```

`members` holds **both** the `pn` and the `lid` of every person (normalized), so a message is tested with at most two `Set.has` (sender and `senderLid`). A global row goes to `global`, any other scope to `groups.get(scope)`. One `findAll`, normalized at load, O(1) per message. The cache key is added to the header comment of `lib/utils/settingsCache.js` and to the key list in CLAUDE.md.

### 2.2 Loader contract (B10, A4)

| Rule | Detail |
|---|---|
| Source | `PermissionRule.findAll()` as model instances; never `raw: true` (1.3 pitfall) |
| Skip | a row whose `mode` is not `extra`/`only`; a person that normalizes to `""`; non-object elements |
| Delegability | **not** checked at load: `decide` tests the live `entry.delegable` first and returns normal before reading any rule (FR-014, SC-003). A rule on `eval` is never read, even after a restore |
| Failure | the loader throws, nothing is cached, the next message retries; `settingsCache.getOrLoad` keeps the previous value on a failed reload and returns `null` when there is none: `decide` then returns normal (FR-011) |
| Invalidation | `commandPermissions.invalidate()` = `settingsCache.invalidate("command_perms")`, called by every write (section 3). `settingsCache.clear()` by restore and in-process restart already drops it |
| Panel reads | read the table directly (always fresh), never the 5-minute cache |

Exports needed by the panel from `lib/utils/commandPermissions.js`: `CACHE_KEY = "command_perms"`, `GLOBAL_SCOPE = "*"`, `MODES`, `MAX_PEOPLE = 100`, `invalidate()`. The write helpers live in the panel service, not in this module (B3: the panel is the only writer).

### 2.3 Registry entry additions (X2, A7)

A plugin declares `command: { ..., delegable: false, lockReason: "<code>" }`. `registerCommand` (`lib/plugins/registry.js`) copies two fields onto the entry:

| Entry field | Value |
|---|---|
| `delegable` | `typeof delegable === "boolean" ? delegable : !(fromMe \|\| ownerOnly)`. Non-owner commands are delegable by default; an owner-only command is **not** delegable unless its code says `delegable: true` (U6). The panel cannot change it |
| `lockReason` | the declared non-empty string when `delegable === false`, otherwise `null`. Vocabulary `code`, `update`, `data`, `lockout`, `config` (U7). `null` or an unknown string with `delegable === false` is shown by the panel as "réservée au propriétaire" (`reason_unknown`, FR-022) |

Declarations (16 owner-only plugins, no other plugin sets the flags; verified by grep in A8):

| Plugin file | Aliases | `delegable` | `lockReason` |
|---|---|---|---|
| `eval.js` | `exec`, `eval` | `false` | `code` |
| `update.js` | `update` | `false` | `update` |
| `exportcontacts.js` | `exportcontacts` | `false` | `data` |
| `banchat.js`, `unbanchat.js` | `ban`; `unban` | `false` | `lockout` |
| `viewonce.js`, `getvv.js` | `setvv`; `getvv` | `false` | `config` |
| `antidel.js`, `getantidel.js` | `antidelete`, `antidel`; `getantidelete`, `getantidel` | `false` | `config` |
| `autorespond.js` | `ar` | `false` | `config` |
| `statussave.js` | `statussave`, `ss` | `false` | `config` |
| `stickercmd.js`, `delcmd.js`, `getcmd.js` | `setcmd`; `delcmd`; `getcmd` | `false` | `config` |
| `vv.js`, `save.js` | `vv`; `save` | `true` | n/a (`null`) |

A test (`test/command-delegable.test.js`, A12) pins the set of `delegable === false` files to this list and requires every `fromMe`/`ownerOnly` plugin to declare `delegable` explicitly, so a future owner-only command forces a conscious choice. Admin-only plugins (`kick`, `promote`, `demote`, `tag`, `warnuser`, `setwelcome`, `goodbye`, `addfilter`, `delfilter`) stay delegable by default.

---

## 3. Lifecycle

Writes are made by the panel service under `mutex.withLock("permissions", ...)`: read the stored row, compute the new rule and the diff, then **one** statement (`create`, `update` or `destroy`; no explicit transaction), then `commandPermissions.invalidate()` once the statement resolved. The next message reloads the cache (FR-010). The single in-memory SQLite connection makes the lock also keep tests deterministic.

| Event | Effect on `permission_rules` | Cache |
|---|---|---|
| PUT PERM-3 / PERM-6 (create or replace) | upsert of the whole row; `createdAt` kept; nothing written when the content is identical (contract 1.8) | `invalidate()` |
| DELETE PERM-4 / PERM-7 | destroy one row; `deleted:false` when none | `invalidate()` |
| GRP-6 "oublier ce groupe" (U4, FR-030) | `PermissionRule.destroy({ where: { scope: jid }, transaction })` inside the existing transaction, next to `CommandState.destroy` (`services/groups.js:549`); count returned as `deleted.permissionRules` | `invalidate()` after the transaction returns (`:560`) |
| The bot leaves a group, or GRP-2 marks it "former" | nothing; rules stay and become active again if the bot returns (spec edge case) | none |
| A listed person leaves the group | row unchanged; the person is shown `present: false` and can be removed | none |
| Plugin removed, or its first alias renamed | row stays, inert; listed as orphan `unknown_command`; deletable | none |
| Command becomes non-delegable in code | row stays, ignored by the engine; listed as orphan `not_delegable`; deletable | none |
| Restore | tables wiped, then refilled in `MODELS` order; a backup that predates 003 empties the rules (as for every model of a full restore) | `settingsCache.clear()` (`restore.js:663`) |
| In-process restart | none | `settingsCache.clear()` (`botRuntime.js:203`) |

Race accepted: a PUT on a group (lock key `permissions`) running while GRP-6 deletes the same group (lock key `groups:settings-delete`) can at worst recreate one rule after the delete, the same exposure as roles and filters today. Two tabs saving the same rule: last save wins, both audited.

---

## 4. Backup (FR-026)

| Item | Change |
|---|---|
| `lib/admin/backup/format.js` `MODELS` | add `"PermissionRule"` right after `"CommandState"` (the `config` group of the page is pinned against `logic.ALL_MODELS`, which equals `[...format.MODELS]`): **25 becomes 26** exported models. Header comment ("The 25 exported models") updated |
| `EXCLUDED_MODELS`, `AUTO_INCREMENT_MODELS` | unchanged (composite PK, nothing excluded) |
| Export | generic path: batches of 500 ordered by primary key (composite keys supported), rows through `get({ plain: true })` |
| Restore | wipes then refills every model of `MODELS`, rows rebuilt and validated by the model (`prepareGeneric`, `instance.validate()`): a bad `mode`, a 101-person list or a person with two `null` forms fails with `backup_invalid_row` (`params.model = "PermissionRule"`) instead of storing junk. A rule on a non-delegable command is restored untouched (the engine ignores it, SC-003; the panel lists it as orphan `not_delegable`) |
| Older backup | no `PermissionRule` count in the manifest: `counts[model] \|\| 0` (`restore.js:366-368`) applies, the table is emptied |
| Cache | nothing to add (`settingsCache.clear()` at the end of a restore) |
| Panel | `lib/admin/public/js/views/backup-logic.mjs`: `config` group gets `"PermissionRule"` after `"CommandState"`, header "25 exported models" updated; catalog key `backup.model_PermissionRule` (en "Permission rules", fr "Règles de permission") in the 003 panel i18n fragment |

---

## 5. Existing tests whose expectations change

Expectation edits only; no behaviour test of 002 or of a command changes (SC-004). Line numbers are those of branch HEAD `2f76ed8`.

| Test file | Lines | Edit |
|---|---|---|
| `test/database.test.js` | `:593`, `:595` | the created-table lists must also contain `permission_rules`: add `FEATURE_003_TABLES` next to `NEW_TABLES` (`:460`, which stays at 14 entries, `:590`); new schema test: columns `command, scope, mode, people, createdAt, updatedAt`, PK `[command, scope]`, no per-column UNIQUE, no index. The "predates the feature" test (`:616-630`) keeps working: it only drops `NEW_TABLES` |
| `test/backup.test.js` | `:5`, `:128`, `:195`, `:201`, `:263` | titles and comments "25" to "26" (the "25 + 7" at `:128`), `MODELS.length` 25 to 26, `Object.keys(first.counts).length` 25 to 26 |
| `test/admin-backup.test.js` | `:237` | `Object.keys(records[0].counts).length` 25 to 26 |
| `test/admin-view-backup.test.js` | `:103`, `:126`, `:279` | title "25 models"; `model.absent.length` `25 - 5` to `26 - 5` (**not listed in stream B**); the catalog key list at `:279` is derived from `logic.ALL_MODELS` and fails without `backup.model_PermissionRule` |
| `test/helpers/backupKit.js` | `:70` (`seedAll`), header `:4`, `:8` | one `db.PermissionRule.bulkCreate` (a `*` rule `only` with a PN+LID person, a group rule `extra`, explicit `...stamps`); comments "25" to "26" |
| `test/admin-groups.test.js` | `:465`, `:739` | GRP-3 `counts` gains `permissions: 0`; GRP-6 `deleted` gains `permissionRules: 0` |
| `test/admin-integration.test.js` | `contractRoutes()` `:106-113` | also parse `specs/003-command-permissions/contracts/admin-permissions-api.md` (format stated at the top of the contract) |

Unchanged on purpose: `test/admin-commands.test.js:99,104` (CMD-1 frozen, X3), `test/command-state.test.js:186` (owner gate before "disabled", X9), `test/permissions.test.js`. The new test files (engine, delegable list, delegated `.vv`/`.save`, menu visibility, `admin-permissions.test.js`, view tests) are listed in a-runtime A12, b-data-backend B11 and c-panel-ui C11.

Docs touched by the data layer: CLAUDE.md "Database" (new table, `MODELS` 26, key `command_perms`), `lib/utils/settingsCache.js` header comment.

---

## 6. Conflicts between sources and the choice made here

| Topic | Sources | Choice |
|---|---|---|
| Stored mode names | A `add`/`only` vs B, C `extra`/`only` | `extra`/`only` (X1) |
| Empty `extra` list | A needs it, B and C refused it | allowed for a group scope only; refused for `*` (X4, U3) |
| Flag name | A `delegable`, C `neverDelegable` | `delegable` + `lockReason` (X2) |
| `people.length` and the audit cap | B9 claims 100 people always fit in 2000 characters | true for a one-sided change of PN ids only; the contract adds a degrade rule (contract 1.7) |
| Count of the GRP-3 badge | B: `count({ where: { scope } })` | all rows of the scope, orphans included (they are listed on the same tab) |
