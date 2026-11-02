# Research B: data model and panel backend (feature 003)

Scope: persistence, backup, panel HTTP routes and services, audit, tests. Bot-side decision engine = stream A (`research/a-runtime.md`), panel UI = stream C (`research/c-panel-ui.md`). Evidence is `file:line` on branch `003-command-permissions` (7f20ca3). Two throwaway spikes (scratchpad, not in the repo) checked the Sequelize behaviours cited in B1 and B2.

## B1. Data model: ONE table `permission_rules`, people embedded as a JSON list

**Decision.** One model `PermissionRule` (file `lib/database/models/PermissionRule.js`, table `permission_rules`), composite primary key `(command, scope)`, the beneficiaries stored in a JSON column. No second table, no surrogate id.

| Column | Type | Rule |
| --- | --- | --- |
| `command` | `STRING(64)`, PK, not null | registry entry `name` (first alias, lower case), same convention as `CommandState.command` |
| `scope` | `STRING(255)`, PK, not null, default `"*"` | `"*"` = "partout" (every group and every private chat), else a group JID |
| `mode` | `STRING(5)`, not null, `validate: { isIn: [["extra","only"]] }` | `extra` = "normal + ces personnes", `only` = "ces personnes seulement". "normal" is never stored (spec Assumptions). No `DataTypes.ENUM` (project convention, additive sync) |
| `people` | `JSON`, not null, default `[]`, custom validator | array, at most 100 items, each `{ pn: string\|null, lid: string\|null }`, at least one non-null; `pn` ends with `@s.whatsapp.net`, `lid` with `@lid`; both normalized (no device suffix, `normalizeJid`). Same pattern as `Broadcast.targets` |
| `createdAt`, `updatedAt` | timestamps | `timestamps: true` (spec Key Entities: creation and modification dates) |

No secondary index: a composite PK already gives the uniqueness "one rule per (command, scope)" at database level, and the table holds a few hundred rows at most. `scope` is not validated by the model (like `CommandState`); the engine ignores a scope that is neither `*` nor a known group.

**Rationale.**
- A rule is edited as a whole (spec edge case: "dernier enregistrement gagne"), so the beneficiaries are a value object of the rule. One row = one atomic write: no transaction, no orphan beneficiary rows, no ordering constraint in backup, `MODELS` grows by 1 instead of 2.
- The reads the product needs are all by command or by group (overview, group tab, engine cache = one `findAll`). Nothing in the spec queries "which commands does person X have", which is the only thing a member table would make cheap.
- Uniqueness "a person once per rule" is a service invariant (identity merge, B2). A DB unique index could not enforce it anyway: a person stored under PN in one row and LID in another is the same person (spec edge case "deux identités").
- `JSON` is already used and backup-proof: `Broadcast.targets` (`lib/database/models/Broadcast.js:77-91`) is exported with `row.get({plain:true})` (`lib/admin/backup/export.js:80-90`) and re-validated on restore by `instance.validate()` (`lib/admin/backup/restore.js:166-190`). Spike: a validator on a JSON attribute rejects `[]`-as-string, a bad `mode`, and a member with two nulls on `Model.build().validate()`, accepts the valid rows.
- Composite PK table without surrogate id has two precedents in the same layer: `CommandState` (`lib/database/models/CommandState.js:11-34`) and `GroupRole` (`lib/database/models/GroupRole.js:7-35`). The export keyset pagination handles composite keys (`export.js:46-55`). No `AUTO_INCREMENT_MODELS` entry, no Postgres sequence reset.

**Pitfall (hand to stream A).** Spike on SQLite: with `raw: true` a JSON column comes back as a **string** (`"[{\"pn\":...}]"`), with model instances as an array; Postgres returns an object in both cases. The engine loader must call `findAll()` without `raw: true` (or parse strings defensively), and must sanitize each element (SC-003: a hand-edited backup). `dumpTables()` in `test/helpers/adminHarness.js:167` only stringifies, so it is unaffected.

**Alternatives considered.**
- Two tables (`PermissionRule` + `PermissionMember(command, scope, userJid, lid)`, composite PK like `GroupRole`): follows the spec's two entities literally and keeps scalar columns (no raw-JSON pitfall), but every replace becomes delete + insert in a transaction under a lock, a rule can lose its rows in a crafted backup, `MODELS` gets two entries (and two UI labels), `deleteSettings` two destroys. Rejected: cost without a query that needs it. Reversible later (additive migration from JSON to a table).
- One flat table, a row per person: cannot represent an `only` rule with an empty list (US2.5), repeats `mode` on every row, can disagree with itself. Rejected.
- Surrogate `id` + unique index `(command, scope)`: adds `AUTO_INCREMENT_MODELS`, a Postgres `setval` and an index for nothing. Rejected.

**Evidence.** `lib/database/index.js:254-290` (`sync()` creates a missing table with its PK, never alters existing ones; a new table is the supported case); additive-only rule in `CLAUDE.md` "Database"; spike results above.

**Files impacted.** new `lib/database/models/PermissionRule.js`; `test/database.test.js` (B12).

## B2. Person identity: how a beneficiary is stored, merged and resolved

**Decision.**
- Stored person = `{ pn, lid }`, either may be null (spec: "numéro dès qu'il est connu, LID seul accepté"). Display/API key `jid = pn || lid`.
- Input accepted by the API (a string, `maxLength: 64`, the schema helper has no nested object schema, `lib/admin/http/request.js:188-190`): a JID `<digits>@s.whatsapp.net` / `@lid` / `@c.us` (device suffix dropped by `normalizeJid`, `lib/utils/permissions.js:17-30`), or a typed number. A typed number is stripped of spaces, `+`, `-`, `.`, parentheses and a leading `00`, then must be 8 to 15 digits (the rule of `PHONE_RE` in `lib/admin/services/pairing.js:30` and of C8), becomes `<digits>@s.whatsapp.net`. Anything else: `422 validation_failed`, `fields.people = { code: "invalid_phone" | "invalid_jid", params: { indices } }` (positions only, never the value; precedent `unknown_target` with `indices`).
- Resolution of the missing form, best effort and never fatal, in this order: (1) group participants of the scope group (`participants[].id/phoneNumber/lid`), same shape as `formsFor` (`lib/admin/services/groups.js:274-286`); (2) `KnownChat` rows matching `jid IN forms OR pnJid IN forms` (gives PN for a LID chat; `lib/database/models/KnownChat.js`); (3) LID to PN through `toPnJid` (`lib/utils/permissions.js:123-132`, Baileys `lidMapping.getPNForLID`, local); (4) optional PN to LID through `signalRepository.lidMapping.getLIDForPN` (it may hit the network: only when the socket is open, `withTimeout` 3 s, errors ignored). A person saved with one form only is not a bug: stream A's slow path resolves the other form at decision time (`a-runtime.md` A5).
- Merge rule (PUT replace): an input that matches a stored person (`pn` equal or `lid` equal) keeps the stored person and is enriched with the newly learned form, with no network lookup; only new inputs are resolved. Two inputs that resolve to the same person are one person.
- Removal is implicit in PUT (a stored person absent from the body is removed). Matching for "absent" uses the same `pn`/`lid` equality.
- Names (`name`) are never stored. They are read from `KnownChat.name` (push name of people who wrote to the bot in private) by one `jid IN (...) OR pnJid IN (...)` query chunked by 400 values (SQLite variable limit). Group metadata has no names; `null` is normal. Read-only routes write nothing (`test/admin-security.test.js:405-417` compares all tables around every GET).
- Limits: 100 people per rule (also audit-size driven, B9). Not a membership check: the server does not require that a person is currently in the group (the UI picker is limited to members, FR-020; the bot may be offline; the owner may pre-authorize). The server only annotates `present`.

**Rationale.** Same identity discipline as roles (`plugins/role.js:96-103` matches either form) and `message.isSudo()` (`lib/classes/Message.js:459-463`). Keeping the stored shape `{pn, lid}` is exactly what A's loader indexes (`a-runtime.md` A2: both forms go in the Set).

**Alternatives.** Store only one normalized `userJid` like `GroupRole`: simplest, but a LID-only author can then never match a PN rule without the slow path on every message. Require membership at save time: breaks offline editing (`members()` answers `not_connected`, `groups.js:641`).

**Files impacted.** new `lib/admin/services/permissions.js` (parser, resolver); small addition to `lib/admin/services/groups.js` (B6).

## B3. Writes: lock, no transaction, invalidation

**Decision.** Every write goes through `mutex.withLock("permissions", ...)` (`lib/utils/mutex.js:27`): read the row, compute the new rule and the diff, then one `create` / `update` / `destroy` (a single statement, atomic; no explicit transaction). `commandPermissions.invalidate()` (stream A; `settingsCache.invalidate("command_perms")`) is called right after the write resolves, like `commandState.write()` (`lib/utils/commandState.js:164-175`).
- Where the write code lives: in the panel service (the panel is the only writer, FR-019, and there is no command), not in `lib/utils/commandPermissions.js`; the engine module exports only `invalidate()`, the constants and the read path. Stream A's contract "every write calls `invalidate()`" holds because the service is the only caller.
- `transaction.afterCommit` is not needed on the PUT/DELETE paths (no transaction). It is needed nowhere else: the group-settings deletion (below) already calls its invalidations after `await DATABASE.transaction(...)` returned, i.e. after the commit (`services/groups.js:556-560`).
- Group-settings deletion (GRP-6): add `PermissionRule.destroy({ where: { scope: jid }, transaction })` next to `CommandState.destroy` (`services/groups.js:549`) and call `commandPermissions.invalidate()` next to `commandState().invalidate()` (`:560`). The answer gains `permissionRules: <n>`. This is a decision beyond the spec text (see Open point 2).
- Restore and in-process restart need nothing: both call `settingsCache.clear()` (`lib/admin/backup/restore.js:663`, `lib/core/botRuntime.js:203`), which drops `command_perms`.
- Race with GRP-6 on the same group (different lock key) can at worst recreate one rule after the delete; accepted, same exposure as roles/filters today.

**Rationale.** `withLock` + single statement is the lightest pattern that is correct for one process; the multi-statement/transaction pattern (`deleteSettings`, `setRole`) is only needed when several rows change together, which B1 avoids. In-memory SQLite has one connection, so serialising writes also keeps tests deterministic (`mutex.js` header).

**Alternatives.** Put `setRule/deleteRule/snapshot` in `lib/utils/commandPermissions.js` like `commandState.js`: mirrors the precedent, but then the panel layer is a thin wrapper that audits; the precedent exists because commands could also toggle state. With a single writer the extra layer buys nothing. Reversible.

## B4. Backup (FR-026)

**Decision.** Add `"PermissionRule"` to `MODELS` in `lib/admin/backup/format.js:54-85`, right after `"CommandState"` (the page order is pinned against `logic.ALL_MODELS`, `test/admin-view-backup.test.js:104`). `EXCLUDED_MODELS` unchanged. `AUTO_INCREMENT_MODELS` unchanged (composite PK, B1). 25 exported models become 26.
- Restore wipes then refills every model in `MODELS` (`restore.js:566-568`, `onManifest`), so restoring a backup that predates 003 empties the rules (same as every other model: documented behaviour of a full restore).
- Rows are rebuilt and validated by the model (`prepareGeneric`, `restore.js:166-190`): the `mode` and `people` validators of B1 make a hand-damaged backup fail with `backup_invalid_row` instead of storing junk. A rule on a non-delegable command is restored as is (FR-014: the engine ignores it, SC-003; the panel lists it as an orphan, B8).
- Cache after restore: nothing to add (`restore.js:663` clears the whole cache). Backup older than 003 opened by a 003 bot: manifest has no `PermissionRule` count, `counts[model] || 0` handles it (`restore.js:366-368`).
- Frontend: `lib/admin/public/js/views/backup-logic.mjs:21` (`config` group gets `"PermissionRule"` after `"CommandState"`), catalog key `backup.model_PermissionRule` in `lib/admin/public/i18n/{en,fr}.json` (en "Permission rules", fr "Règles de permission"); the test "every key the page can ask for" (`test/admin-view-backup.test.js:279`) fails without them. Header comments "25 exported models" in `format.js:53`, `backup-logic.mjs:18` to update.

**Rationale.** Smallest change that makes the guard tests drive the work: `format.js` is the single registry of what is exported (`CLAUDE.md` "Database": "A new model must also be listed in MODELS or EXCLUDED_MODELS").

**Alternatives.** `EXCLUDED_MODELS`: contradicts FR-026.

**Test impact (existing tests, expectation edits only).** `test/backup.test.js:195-203` (title, `MODELS.length` 25 to 26), `:263` (`Object.keys(first.counts).length`), the "25 + 7" comment at `:128`; `test/admin-backup.test.js:237` (25 to 26); `test/admin-view-backup.test.js:103` (title) and the key list at `:279`; `test/helpers/backupKit.js:70-` `seedAll` gets one `db.PermissionRule.bulkCreate` (a `*` rule `only` with a PN+LID person, a group rule `extra`, explicit `...stamps`), header comments "25"; the Postgres-only test `backup.test.js:1030` needs nothing (no autoincrement). Plus `test/database.test.js` (B12).

## B5. Panel area: new files, nothing else extended

**Decision.** New `lib/admin/routes/permissions.js` (auto-loaded, `lib/admin/routes/index.js:229-254` sorts and requires every file) and `lib/admin/services/permissions.js` (`createPermissionsService(deps)`; never touches `req`/`res`; resolves `registry`, `commandPermissions`, `models`, `groups` lazily from `deps` so tests inject fakes, as `services/commands.js:113-117`). It shares the groups service instance through `groupsServiceOf(deps)` (`services/groups.js:927-944`). CMD-1 and CMD-2 stay untouched; GRP-4..GRP-17 stay untouched except the two small groups-service changes of B6.

**Rationale.** `routes/commands.js` and `routes/groups.js` have exact-shape tests (`test/admin-commands.test.js:99,104` pins the CMD-1 key set and one full item; `test/admin-groups.test.js:455-470` pins the GRP-3 object). A new area keeps the 002 contract frozen and puts the feature in two reviewable files.

**Alternatives.** Extend CMD-1 with `delegable`, `lockReason`, `permissions {...}` (what `c-panel-ui.md` C2 assumed): one request instead of two, but two pinned assertions to rewrite. Not wrong; if the owner prefers it the cost is exactly those two assertions (the data comes from the same service function). Recommended: the separate `GET /admin/api/permissions` below; the SPA merges by `name`.

## B6. Route table

All routes: `auth: "session"` (CSRF on unsafe methods and `touch` default), strict body schema, errors as codes. Path parameters must use names that have a default pattern in `PARAM_PATTERNS` (`lib/admin/http/router.js:81-92`): **`:jid`** (group JID) and **`:name`** (`[A-Za-z0-9_.-]{1,64}`). A parameter called `:command` (used in `c-panel-ui.md`) makes `router.route` throw (`router.js` "no pattern for :param") and the route sampler of `test/admin-security.test.js:36,66-87` would not find a valid sample. Use `:name`.

| ID | Method and path | Request | Answer | Audit |
| --- | --- | --- | --- | --- |
| PERM-1 | `GET /admin/api/permissions` | none | `{ items: [{ name, delegable, lockReason, everywhere: { mode, count }\|null, groups: <n> }], orphans: [{ command, scope, mode, count, reason }], limits: { peopleMax } }` | no |
| PERM-2 | `GET /admin/api/commands/:name/permissions` | none | `{ command, delegable, lockReason, access, everywhere: Rule\|null, groups: [{ jid, name\|null, mode, count, warnings }] }` | no |
| PERM-3 | `PUT /admin/api/commands/:name/permissions/everywhere` | `{ mode, people: [string] }` | `{ rule: Rule, changed: bool }` | `command.permission.set` |
| PERM-4 | `DELETE /admin/api/commands/:name/permissions/everywhere` | none | `{ deleted: bool }` | `command.permission.delete` |
| PERM-5 | `GET /admin/api/groups/:jid/permissions` | none | `{ rules: [Rule], everywhere: [Rule], orphans: [{ command, mode, count, reason }], members: { available, fetchedAt }, limits }` | no |
| PERM-6 | `PUT /admin/api/groups/:jid/permissions/:name` | `{ mode, people: [string] }` | `{ rule: Rule, changed: bool }` | `command.permission.set` |
| PERM-7 | `DELETE /admin/api/groups/:jid/permissions/:name` | none | `{ deleted: bool }` | `command.permission.delete` |

- `Rule = { command, scope, mode, people: [Person], warnings: [code], createdAt, updatedAt }` (ISO strings). `Person = { jid, name\|null, present?, admin? }`; for the group routes `present: true\|false\|null` (null = bot offline, former group or metadata unavailable) and `admin: "admin"\|"superadmin"\|null`; for the `everywhere` rule of PERM-2/3 those two keys are omitted (no group). In PERM-5, `everywhere[]` people carry `present`/`admin` for this group (FR-020 "qui ont accès dans ce groupe"; the UI may ignore them).
- PERM-1 `items` lists exactly the loaded commands (the same set as CMD-1; the page merges by `name`). `orphans` mixes every scope; `reason` is `unknown_command` (not loaded) or `not_delegable` (loaded, but a restore or a manual insert left a rule the engine ignores, FR-014). `lockReason` is the code declared by the plugin (B7), null when delegable.
- PERM-5 `rules` = this group's rules on loaded delegable commands, sorted by command; `everywhere` = every "partout" rule (all of them, so the UI can compute the mode that applies); `orphans` = this group's stale rows. Unknown group: `404 not_found { resource: "group" }` (uses the groups service `locate`, B6 below). A former group is allowed (rules survive, spec edge case): `members.available: false`, `present: null`.
- PUT is **full replace** (idempotent; the second tab simply wins, spec edge case). `mode` required, `people` required (array, `max` 100). `people: []` is valid only for `only` (US2.5); `extra` with no person: `422 validation_failed { people: { code: "required" } }` (it would be a no-op "normal"; the UI never sends it, C5). The bare minimum diff is computed against the stored row.
- DELETE is idempotent (`deleted: false` and no audit when nothing was there); no `?confirm=true` (single-rule delete, precedent GRP-10 `DELETE filters/:id` and GRP-15). Orphan names are accepted by DELETE only, as CMD-2 enables orphans (`services/commands.js:130-133`). PUT on an unknown command: `404 not_found { resource: "command" }`.
- The alias path parameter is resolved through `registry.getCommandByPattern(raw)` (`lib/plugins/registry.js:379`, same as `toggleCommands`, `services/groups.js:752`) to the canonical `entry.name`; responses always carry the canonical `command`.
- Router constraints honoured: no GET writes (`test/admin-security.test.js:405`), `schema` declared on both PUTs (a route with no schema accepts only `{}`), no `touch: false`, a literal `everywhere` segment is not a wildcard.

**Additions to the groups service** (`lib/admin/services/groups.js`, exposed on the returned object `:898-921`):
- `participants(jid) -> { former, available, fetchedAt, items: [{ pn, lid, admin }] }`: `locate(jid)` (404 for an unknown group), then `metadataOf(jid)` non-required (60 s cache, never throws `not_connected`/`whatsapp_error`), `items` from `participants[].id/phoneNumber/lid/admin` normalized, `available:false` and `items: []` when the bot is offline or the group was left. GRP-11 `members()` keeps throwing (its UI contract).
- `describe()` gains `counts.permissions` (one `PermissionRule.count({ where: { scope: jid } })`, the badge `c-panel-ui.md` asks for); `test/admin-groups.test.js:465` gets `permissions: 0`.
- `deleteSettings()` as in B3 (`test/admin-groups.test.js:739` gets `permissionRules: 0`).

**Alternatives.** `PATCH {add, remove}` set-based like CMD-2: merges concurrent tabs instead of "last wins", but spec chose last-write-wins and C's draft-and-save UI maps to PUT. Reversible (the service can expose a `patch` later). A `scope` path parameter (`*` or JID): impossible, `*` is rejected by the router path grammar and by the sampler.

**Files impacted.** new `lib/admin/routes/permissions.js`, `lib/admin/services/permissions.js`; edit `lib/admin/services/groups.js`.

## B7. Delegability and errors

**Decision.**
- The service reads the registry entry flags `entry.delegable` and `entry.lockReason` (stream A adds them in `registerCommand`, `lib/plugins/registry.js:85-136`). `delegable` is `true` only when the entry says so (A7: owner-only commands default to false). The panel never writes them.
- A PUT on a command that is not delegable: `422 validation_failed { name: { code: "not_allowed" } }` (precedent: `fieldError("userJid", "invalid_jid")` on a path parameter, `services/groups.js:677`). No new envelope code: a new code would mean `STATUS_BY_CODE` (`lib/admin/http/response.js:22-73`), the contract table, `ENVELOPE_CODES`/`EXTRA_SERVER_CODES` and two catalog entries (`test/admin-i18n.test.js:35-63,182-193`) for an error the UI cannot trigger. If a readable message is wanted later, a `not_delegable` code (422) costs exactly those four edits.
- `lockReason` vocabulary: A declares `delegable: false`; C needs five reason codes. Recommended: the plugin declares `command: { delegable: false, lockReason: "code" | "update" | "data" | "lockout" | "config" }`, `registerCommand` copies both onto the entry (`lockReason: null` otherwise). A and C wrote different names (`delegable` vs `neverDelegable`); this unifies them.

| Situation | Answer |
| --- | --- |
| no session / bad CSRF | 401 / 403 (router) |
| unknown group (never seen) | 404 `not_found { resource: "group" }` |
| unknown command, no row | 404 `not_found { resource: "command" }` |
| non-delegable command (PUT) | 422 `validation_failed { name: not_allowed }` |
| bad `mode` | 422 `{ mode: not_allowed }` (schema enum) |
| missing `mode` / `people`, `extra` with no person | 422 `{ mode\|people: required }` |
| malformed person | 422 `{ people: invalid_jid \| invalid_phone, params: { indices } }` |
| more than 100 people (after merge) | 422 `{ people: too_many_items, params: { max: 100 } }` |
| unknown property | 422 `{ $unknown: unknown_field }` (schema helper) |
| restore in progress | 503 `maintenance` (router) |
| database down | 503 `db_unavailable` (router) |

## B8. Warnings (FR-023) and orphans (FR-024), computed by the server

**Decision.** `Rule.warnings` is a list of codes, recomputed on every read and returned by PUT, so the UI can show them before saving a draft (it can call `computeWarnings` locally too, C6) and after:

| Code | Condition |
| --- | --- |
| `opens_admin_command` | `accessOf(entry).admin` (adminOnly) and `people.length > 0` and (`scope === "*"` or at least one person has `admin !== "admin"/"superadmin"`, unknown counts as not admin). Applies to both modes: an `only` rule also authorizes listed non-admins (FR-006 step 3) |
| `extra_on_public` | `mode === "extra"` and the command is neither owner-only nor admin-only (`!access.owner && !access.admin`) |
| `empty_only` | `mode === "only"` and `people.length === 0` |

`accessOf` is imported from `lib/admin/services/commands.js:73-80` (already exported). Orphans = rows whose command is not in `registry.getCommands()` (`unknown_command`) or is loaded but not delegable (`not_delegable`); computed in the service from one `findAll` plus the registry, the same way `commandState.snapshot` computes orphans (`lib/utils/commandState.js:120-138`). A person who left the group is a `Person` with `present: false`, still removable by PUT.

**Rationale.** The three conditions are exactly the spec's list; keeping the rule next to `accessOf` keeps one definition of "admin command" and "public command" for server and tests.

## B9. Audit (FR-025)

**Decision.** Actions `command.permission.set` and `command.permission.delete` (prefix `command` is already offered by the audit page filter and covered by `ACTION_PREFIXES`, `test/admin-view-logs-stats.test.js:236`; no `audit.prefix_*` key to add, nothing in `lib/admin/public/i18n` translates action codes). Add both to `ACTIONS` in `lib/admin/audit.js:28-69` (the list is documentation, not enforced: `record()` accepts any string, `audit.js:167-183`).
- `ctx.audit(action, target, "ok", detail)` called by the route, once per request, only when something changed (idempotent no-op = no row, like CMD-2, `routes/commands.js:37-44`).
- `target`: `<command>:<scope>` with scope `*` or the group JID, like `command.toggle` (`routes/commands.js:40`); at most 255 characters.
- `detail`: `{ mode, previousMode, added: [id], removed: [id] }`; `mode` is the resulting mode (for `delete`, the removed rule's mode and `previousMode` equals it), `previousMode` is `null` on creation. `id` is compact: the digits of the PN, or `<digits>@lid` for a LID-only person. At 15 characters each, 100 people stay under the 2000-character cap of `serializeDetail` (`audit.js:104-129`), above which the detail is replaced by `{ truncated: true, length, keys }` and the "who" is lost. That cap is why the limit is 100 people per rule and why ids are compact.

**Alternatives.** `permission.set` as a new prefix: needs `ACTION_PREFIXES` and `audit.prefix_permission` (guard test above). Full JIDs in the detail (as `group.role` does): too long for 100 people.

## B10. Cache contract with stream A

- Key `command_perms` (A's name), TTL 5 min, invalidated by every write of B3, cleared by restore and restart.
- Loader contract: `PermissionRule.findAll()` (instances), ignore a row whose `mode` is unknown, skip people that normalize to `""`, skip a command that is not delegable at decision time (A2). Never rely on `raw: true` for `people` (B1 pitfall).
- Constants B needs exported from `lib/utils/commandPermissions.js`: `CACHE_KEY`, `GLOBAL_SCOPE = "*"`, `MODES = { EXTRA: "extra", ONLY: "only" }`, `MAX_PEOPLE = 100`, `invalidate()`. A's provisional `MODES.ADD = "add"` must become the stored value `"extra"` (the spec calls it "normal + ces personnes", the orchestrator brief and C use `extra`).
- Panel reads (PERM-1, 2, 5) read the table directly (always fresh), not the 5-minute cache.

## B11. Tests to add or change

New `test/admin-permissions.test.js` (harness `createTestAdmin` + `loginClient`, probe plugins registered like `test/admin-commands.test.js:42-60`, `settingsCache.clear()` and `PermissionRule.destroy` + `AuditLog.destroy` in `beforeEach`, a fake groups service/metadata injected through `deps` for `present`/`admin`):
1. Session needed on all 7 routes (401); CSRF is already enumerated by `test/admin-security.test.js` for free once the routes exist (it reads `admin.routes()`).
2. PERM-1: lists exactly the loaded commands with `delegable`/`lockReason`/`everywhere` count/`groups` count; orphans for an unknown command and for a row on a non-delegable command.
3. PERM-3/6 create: mode `extra` and `only`; stored `people` shape `{pn, lid}`; canonical command when the alias is given (`/permissions/zzuno` stores `zzone`); `createdAt` kept and `updatedAt` moved on a second PUT; `changed:false` and no audit on an identical PUT.
4. Identity: typed `+237 6 90-00-00-03`, `00237...`, a `@lid`, a device suffix `:7`, the same person given as PN then as LID (one person, both forms stored via fake participants / `KnownChat` row), a 7-digit number (`invalid_phone`, `indices` position, value not echoed), 101 people (`too_many_items`).
5. Refusals: non-delegable PUT (`not_allowed`, nothing written), unknown command (404), unknown group (404), `extra` with `[]` (`required`), unknown body property (`$unknown`), `people: []` with `only` accepted and flagged `empty_only`.
6. DELETE: idempotent, orphan names accepted (unknown command and non-delegable), audit row only when something was deleted.
7. Warnings: `opens_admin_command` (admin command, non-admin person, and `scope "*"`), `extra_on_public`, `empty_only`; none when everyone is a known admin.
8. Group view: `present`/`admin` annotation, `present: null` when the bot is offline and for a former group (rules still listed), names from `KnownChat`, `everywhere` rules included with the group's `present`.
9. Audit: action, target `<command>:<scope>`, detail added/removed for add, remove, mode change, delete; the 100-person detail is not truncated.
10. Cache: after each write `settingsCache` has no `command_perms` entry (`settingsCache.cache.has`), and with the real engine a rule written through the route changes `registry.executeCommand` at the next message (shared with A's tests).
11. Concurrency: two simultaneous PUTs on the same rule end with one of the two bodies, never a mix; PUTs on different rules both land.
12. GRP-6 removes the group's rules and reports `permissionRules`; GRP-3 reports `counts.permissions`.
13. Backup round trip: a `*` rule and a group rule survive export then restore on an empty database (`backup.test.js` extension via `seedAll`), a backup carrying a rule with a bad `mode` or 101 people is refused with `backup_invalid_row`, a backup carrying a rule on a non-delegable command restores it untouched.

Existing tests to edit (expectations only, all enumerated above): `test/database.test.js` (add `permission_rules` to the expected created tables at `:593-597` and the matching spec entry in a new `FEATURE_003_TABLES` next to `NEW_TABLES` at `:460`, plus a schema test: columns `command, scope, mode, people, createdAt, updatedAt`, PK `[command, scope]`, no UNIQUE per column, no index; the "predates the feature" test `:616-630` keeps working because it only drops `NEW_TABLES`), `test/backup.test.js`, `test/admin-backup.test.js`, `test/admin-view-backup.test.js`, `test/helpers/backupKit.js`, `test/admin-groups.test.js:465,739`, `test/admin-integration.test.js` (see below).

**Route-contract guard.** `test/admin-integration.test.js:169-178` fails on any registered route that is not a row of section 2 of `specs/002-admin-panel/contracts/admin-http-api.md` or in `UNDOCUMENTED` (`:139`). Recommended: write the 7 routes as rows `PERM-1..PERM-7` in a new `specs/003-command-permissions/contracts/admin-permissions-api.md` and make `contractRoutes()` (`:106-113`) also parse that file (6 lines), so the new contract is enforced the same way. Cheaper: add the 7 `METHOD path` keys to `UNDOCUMENTED` with a comment. Also automatic: `test/admin-frontend.test.js:1102` (SPA literals must match a registered route: B's routes must be in before C's views merge), the DELETE guard (no `?confirm=true` needed, not in section 1.10), and `test/admin-security.test.js` (enumerates the table, samples `:jid` and `:name` successfully).

## B12. Files impacted (summary)

New: `lib/database/models/PermissionRule.js`, `lib/admin/routes/permissions.js`, `lib/admin/services/permissions.js`, `specs/003-command-permissions/contracts/admin-permissions-api.md`, `test/admin-permissions.test.js`.
Edited: `lib/admin/backup/format.js` (+`PermissionRule`), `lib/admin/services/groups.js` (`participants`, `counts.permissions`, `deleteSettings`), `lib/admin/audit.js` (`ACTIONS`), `lib/admin/public/js/views/backup-logic.mjs`, `lib/admin/public/i18n/{en,fr}.json` (`backup.model_PermissionRule`, via a 003 fragment), `lib/plugins/registry.js` (stream A: `delegable`, `lockReason`), `CLAUDE.md` (Database section: new table, `MODELS` 26).
Tests edited: see B11.

## Open points for the owner

1. **"Avec ou sans indicatif" (US3.5) cannot be honoured literally.** A national number without country code (`690000003`) does not identify a WhatsApp account, and there is no default-country setting (`grep` finds none). Recommended: the country code is mandatory; `+`, spaces, dashes, dots, parentheses and a leading `00` are accepted and stripped; 8 to 15 digits, else `invalid_phone` with the existing hint "digits with the country code". (Alternative: add a `DEFAULT_COUNTRY_CODE` setting; I would not.)
2. **Should "delete the settings of a group" (GRP-6, the "forget this group" action) also delete its permission rules?** The spec says a group the bot left keeps its rules, but is silent on the explicit owner action that already deletes the group's command states, roles, filters and warnings. Recommended: yes (no ghost rules for a group the owner asked to forget); costs one `destroy` and one number in the answer.
3. **Should the server refuse to add a person who is not currently in the group?** FR-020 says the picker offers the group's members; nothing says the API must enforce it. Recommended: no (accept, mark `present: false`), because the bot may be offline and the owner may want to pre-authorize someone who is about to join.
