# Contract: admin permissions API

Feature `003-command-permissions`. Inputs: [spec.md](../spec.md) (FR-001 to FR-031), [research.md](../research.md) (**authoritative**: U1-U8 and X1-X12 override the stream files), [research/b-data-backend.md](../research/b-data-backend.md) (B2, B6-B9), [research/a-runtime.md](../research/a-runtime.md) (A2, A5), [research/c-panel-ui.md](../research/c-panel-ui.md) (C2, C6), [data-model.md](../data-model.md). This file **adds** 7 routes (PERM-1 to PERM-7) to the 002 contract [admin-http-api.md](../../002-admin-panel/contracts/admin-http-api.md) and amends two of its answers (section 3). Nothing of 002 is edited: CMD-1, CMD-2 and GRP-17 stay frozen (X3).

All server code lives in `lib/admin/routes/permissions.js` (auto-loaded, one new area) and `lib/admin/services/permissions.js` (`createPermissionsService(deps)`, never touches `req`/`res`, resolves `registry`, `commandPermissions`, `models` and the groups service lazily from `deps` so tests inject fakes). The engine side (decision, cache) is not an HTTP concern: see data-model section 2.

## Machine-read format (for `test/admin-integration.test.js#contractRoutes()`)

The plan extends `contractRoutes()` so the route-contract guard also covers this file. The parser must:

1. read this file and take the text from the level-2 heading numbered 2 (title "Routes") up to the level-2 heading numbered 3 (title "Changes to existing routes"). Search each as a line start (a newline, two hash signs, a space, then the number and title) so that nothing in the prose can be hit first; the 002 slice ends at its own "3. Live stream" heading, so the end marker is a parameter of the helper;
2. apply the **same two regexes** as for 002, unchanged (flags `gm`), to that slice:

```text
route row   ^\| ([A-Z]+-\d+) \| `([A-Z]+) (\/[^`?]*)(?:\?[^`]*)?`
auth column ^\| ([A-Z]+-\d+) \| `([A-Z]+) (\/[^`?]*)(?:\?[^`]*)?`[^|]*\| (public|session|setup) \|
```

3. union the rows with those of 002 before the three checks (documented routes are registered, the `auth` column matches, no registered route is undocumented).

Format guarantees of this file:

- exactly 7 route rows, ids `PERM-1` to `PERM-7`, one per line of the table in the routes section, each shaped as: pipe, id, pipe, the backticked `METHOD /path`, pipe, `session`, pipe, and the remaining cells;
- the only path parameters are `:name` and `:jid` (names with a default pattern in `PARAM_PATTERNS`, `lib/admin/http/router.js`; `:command` makes `router.route` throw, and `*` is not valid in a path segment, hence the literal segment `everywhere`);
- no query string in the path cell;
- no other table row of this file starts with a pipe, an id and a backticked `METHOD /path`;
- the two level-2 headings named above appear once each, as a line start, and no prose of this file spells them out with the leading hashes.

---

## 1. Conventions

### 1.1 Inheritance

Everything in section 1 of the 002 contract applies unchanged: `session` auth and the unsafe-request guard (CSRF, Origin, JSON content type), request limits (64 KiB default body), the error envelope and field codes, `X-Request-Id`, security headers, `maintenance` and `db_unavailable` (these routes need the database: no `db:r` flag). Language-neutral answers (codes and parameters, never prose). Timestamps are ISO-8601 strings, absent values are `null`.

### 1.2 Objects

**Rule**

| Field | Type | Notes |
|---|---|---|
| `command` | string | canonical registry name (first alias), whatever alias the path carried |
| `scope` | string | `"*"` ("partout") or a group JID |
| `mode` | string | `"extra"` (normal + these people) or `"only"` (these people only) |
| `people` | `[Person]` | stored order |
| `warnings` | `[Warning]` | recomputed on every read and returned by PUT (1.5) |
| `createdAt`, `updatedAt` | string | `createdAt` is kept by every replace |

**Person** `{ jid, name, present?, admin? }`

| Field | Notes |
|---|---|
| `jid` | `pn \|\| lid`, normalized: the display and removal key |
| `name` | push name from `KnownChat` (one `jid IN (...) OR pnJid IN (...)` query, chunked by 400), else `null` |
| `present` | **group routes only** (PERM-5 `rules` and `everywhere`, PERM-6 answer): `true` / `false`, or `null` when unknown (bot offline, group left, metadata unavailable). Omitted in PERM-2 and PERM-3 (no group) |
| `admin` | same routes: `"admin"`, `"superadmin"` or `null` (also `null` when `present` is not `true`) |

`present` and `admin` are computed **server-side** by the groups service `participants(jid)` (section 3), matching any form of the person (`pn`, `lid`) against a participant's `id`, `phoneNumber` or `lid`; the browser never compares JIDs (X10).

**Warning** `{ code, tone, params }`: `tone` is `"warn"` or `"info"`; `params` is always an object (`{}` when none). Vocabulary in 1.5.

**Orphan** `{ command, scope, mode, count, reason }` (`scope` omitted in PERM-5, where it is the path group): `count` = people in the row, `reason` is `unknown_command` (not loaded) or `not_delegable` (loaded, but a restore or a manual insert left a row the engine ignores, FR-014).

### 1.3 Identity input, merging

A person is submitted as a string (`maxLength` 64, NFC).

| Input | Rule | Failure |
|---|---|---|
| contains `@` | JID. Normalized with `normalizeJid` (device suffix `:7` dropped, `c.us` becomes `s.whatsapp.net`). Server must be `s.whatsapp.net` (user part 8 to 15 digits) or `lid` (5 to 20 digits). Any other server (group, `status@broadcast`) is refused | `invalid_jid` |
| no `@` | typed number (U5, FR-031). Strip spaces, `+`, `-`, `.`, `(`, `)` wherever they occur, then a leading `00`; the rest must be 8 to 15 digits **with the country code** (no default country) and must not start with `0` (a national number; E.164 country codes never start with 0, same rule as the client's `parseNumber`). Becomes `<digits>@s.whatsapp.net` | `invalid_phone` |

Both failures are `422 validation_failed` with `fields.people = { code, params: { indices } }`: `indices` are the 0-based positions in the submitted array, never the value.

**Resolution of the missing form** (best effort, never fatal, in this order; the first that answers wins): (1) participants of the scope group (PERM-6 only: `id`/`phoneNumber`/`lid`); (2) `KnownChat` rows (`jid IN forms OR pnJid IN forms`); (3) LID to PN through `toPnJid` (local Baileys `lidMapping`); (4) PN to LID through `signalRepository.lidMapping.getLIDForPN`, only when the socket is open, `withTimeout` 3 s, errors ignored. A person saved with one form only is valid: the engine resolves the other at decision time (a-runtime A5). Read-only routes write nothing.

**Merge rule (PUT):** an input equal (`pn` or `lid`) to a stored person keeps that stored person, enriched with a newly supplied form, with **no lookup**; only new inputs go through the resolution above. Two inputs that resolve to the same person are one person (collapsed silently, no `duplicate` error). A stored person absent from the body is removed (same equality).

**Membership is not checked** (FR-031): the server accepts a person who is not in the group (the bot may be offline; the owner may pre-authorize). The group picker of the UI is limited to members; the server only annotates `present`.

### 1.4 Limits

| Limit | Value | Where |
|---|---|---|
| People per rule | 100 (`MAX_PEOPLE`) | schema `max` on the submitted array, so before parsing; since a merge can only shrink the list, a stored rule never exceeds 100. `limits.peopleMax` in PERM-1 and PERM-5 |
| Characters per person string | 64 | schema `maxLength` |
| Body | default 64 KiB | 100 persons stay far below |
| Rules | no cap | a few hundred at most (SC-005); the engine is O(1) |
| Audit target | 255 characters | `<command>:<scope>` |

### 1.5 Warnings (X5)

Computed by the server on every read and returned by PUT; the SPA recomputes the same four live from its draft (`permissions-logic.mjs`) to show them before the save. Never blocking: the rule is saved, then warned (US1.5). Fixed order as below.

| Code | Tone | Condition | `params` |
|---|---|---|---|
| `opens_admin_command` | warn | the command is admin-only (`accessOf(entry).admin`) **and** `people` is non-empty **and** (scope is `*`, or at least one person is not known to be a group admin: `admin` other than `admin`/`superadmin`, so unknown, former and offline persons count: safe side). Both modes (an `only` rule also lets listed non-admins in, FR-006 step 3) | `{ count, everywhere }`. Group scope: `count` = persons not known as admin, `everywhere: false`. Scope `*`: `count` = `people.length` (admin status depends on the group), `everywhere: true` |
| `extra_on_public` | warn | mode `extra`, `people` non-empty, and the command is neither owner-only nor admin-only (`!access.owner && !access.admin`): adding people changes nothing | `{}` |
| `empty_only` | warn | mode `only`, `people` empty: only the owner can use the command | `{}` |
| `normal_here` | info or warn | scope is a group, mode `extra`, `people` empty ("niveau normal ici", U3). **Tone rule:** `info` when an everywhere (`*`) rule of mode `only` exists for the command (the exception does something); otherwise `warn` ("sans effet") | `{}` |

`extra_on_public` requires a non-empty list so that an empty group `extra` rule on a public command yields `normal_here` alone. The client adds two info-only ids from data it already holds, **never sent by the server**: `disabled_here` and `context_only`. PERM-2's per-group `warnings` omit `opens_admin_command` (it needs participant data and PERM-2 never calls WhatsApp).

### 1.6 Errors

Checks run in this order; the first failing stage answers (the schema stage reports all its fields at once).

| # | Stage | Situation | Answer |
|---|---|---|---|
| 1 | router | no session / bad CSRF, Origin or content type | `401` / `403` / `415` |
| 1 | router | restore in progress / database down | `503 maintenance` / `503 db_unavailable` |
| 2 | schema (PUT) | `mode` missing, `people` missing or `null` | `422 { mode or people: required }` |
| 2 | schema | `mode` not `extra` or `only` | `422 { mode: not_allowed, params: { allowed } }` |
| 2 | schema | `people` not an array, an item not a string | `422 { people: invalid_type }` |
| 2 | schema | more than 100 people | `422 { people: too_many_items, params: { max: 100 } }` |
| 2 | schema | an item longer than 64 characters | `422 { people: too_long, params: { max: 64 } }` |
| 2 | schema | unknown body property | `422 { $unknown: unknown_field }` |
| 3 | path | unknown command (not loaded), no stored row | `404 not_found { resource: "command" }` |
| 3 | path | group the panel has never seen (groups service `locate`) | `404 not_found { resource: "group" }` |
| 4 | delegability (PUT) | command loaded but `delegable === false` | `422 { name: not_allowed }` (X7: the path parameter is `name`; no new envelope code) |
| 5 | semantics (PUT) | scope `*`, mode `extra`, `people: []` (X4: a no-op) | `422 { people: required }` |
| 6 | people | malformed person | `422 { people: invalid_jid or invalid_phone, params: { indices } }` |

`extra` with an empty list is **accepted for a group scope** (U3) and `only` with an empty list is accepted for both scopes (US2.5). Nothing is written on any `422`. DELETE has no body and no stage 2, 4, 5, 6; its stage 3 is relaxed (see PERM-4 and PERM-7).

### 1.7 Audit (FR-025, X6, B9)

`ctx.audit(action, target, "ok", detail)` is called by the route, **once per request, only when something changed**.

| Action | Written by | Target | Detail |
|---|---|---|---|
| `command.permission.set` | PERM-3, PERM-6 | `<command>:<scope>` (scope `*` or the group JID) | `{ mode, previousMode, added, removed }` |
| `command.permission.delete` | PERM-4, PERM-7 | same | `{ mode, previousMode, added: [], removed }` with `mode` = `previousMode` = the removed rule's mode and `removed` = all its ids |

`mode` is the resulting mode, `previousMode` is `null` on creation. `added` / `removed` are lists of **compact ids** from the identity diff (a person in both lists of a replace appears in neither): the PN digits (`237690000001`), or `<digits>@lid` for a person known by LID only. The prefix `command` already exists in `ACTION_PREFIXES`; both actions are added to `ACTIONS` in `lib/admin/audit.js` (a documentation list, not enforced). One audit row per save, whatever the number of people changed (U8).

**Size.** `serializeDetail` replaces a detail over 2000 characters by `{ truncated, length, keys }`, which would lose the "who". About 15 characters per PN id keep 100 ids under the cap, but a replace that adds and removes many people at once, or LID-only ids (about 22 characters), can exceed it. Rule: if the serialized detail would exceed 1900 characters, `removed` is replaced by `removedCount` (number), then, if still too long, `added` by `addedCount`. The audit page shows "mode, +N, -M" with the ids (C10, `summarizeDetail` branch).

### 1.8 Idempotency and concurrency

| Topic | Rule |
|---|---|
| PUT | **full replace** of the `(command, scope)` row, under `mutex.withLock("permissions")`: read the stored row, merge (1.3), compare, write at most once. Always `200` (create and replace look alike) |
| Identical PUT | same mode and same set of persons (order ignored, stored order kept): nothing written, `changed: false`, `updatedAt` untouched, **no audit row** |
| Enrichment only | same set of persons but a newly supplied form (a LID for a PN-only person): the row is written, `changed: true`, `updatedAt` moves, the audit detail has empty `added` and `removed` |
| DELETE | idempotent: `deleted: false` and no audit when no such row; `deleted: true` and one audit row otherwise. **No `?confirm=true`** (single-rule delete, precedent GRP-10; these DELETE routes are not in 002 section 1.10) |
| Two tabs | the last save wins (spec edge case); each effective save is audited. Two simultaneous PUTs on one rule end with one of the two bodies, never a mix; PUTs on different rules both land |
| Cache | `commandPermissions.invalidate()` right after the write resolves: the next message obeys (FR-010) |

### 1.9 Degraded modes

Database down: `503 db_unavailable` on all seven. Bot offline: all seven work; group answers carry `present: null`, `members.available: false` and `admin: null` (so `opens_admin_command` counts everyone: safe side); resolution step (4) of 1.3 is skipped. A group the bot has left (`former`) is allowed: its rules stay listed and editable.

---

## 2. Routes

Notation as in 002 section 2: every route is `session`-authenticated, fully guarded (CSRF `yes` for unsafe methods, `no` for `GET`), touches the session, needs the database.

| ID | Method and path | Auth | CSRF | Flags | Audit | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| PERM-1 | `GET /admin/api/permissions` | session | no | | none | FR-021, FR-022, FR-024, US4 |
| PERM-2 | `GET /admin/api/commands/:name/permissions` | session | no | | none | FR-021, US3, US4 |
| PERM-3 | `PUT /admin/api/commands/:name/permissions/everywhere` | session | yes | | `command.permission.set` | FR-001, FR-002, FR-004, FR-014, FR-021, FR-023, FR-025, FR-031, US3 |
| PERM-4 | `DELETE /admin/api/commands/:name/permissions/everywhere` | session | yes | | `command.permission.delete` | FR-021, FR-024, FR-025 |
| PERM-5 | `GET /admin/api/groups/:jid/permissions` | session | no | | none | FR-020, FR-022, FR-023, FR-024, US1, US2, US4 |
| PERM-6 | `PUT /admin/api/groups/:jid/permissions/:name` | session | yes | | `command.permission.set` | FR-001, FR-002, FR-004, FR-014, FR-020, FR-023, FR-025, FR-031, US1, US2 |
| PERM-7 | `DELETE /admin/api/groups/:jid/permissions/:name` | session | yes | | `command.permission.delete` | FR-020, FR-024, FR-025 |

**Alias resolution (all `:name`).** The raw value is lower-cased and resolved with `registry.getCommandByPattern(raw)` to the canonical `entry.name`; answers always carry the canonical `command`. If nothing is loaded under that name, the lower-cased raw value is used as the stored name (orphans), where a route allows it.

- **PERM-1**: `200 { items, orphans, limits }`.
  - `items`: `[{ name, delegable, lockReason, everywhere, groups }]` for exactly the loaded commands (the set of CMD-1; the Commands page merges by `name`), sorted by `name`. `delegable` is the registry flag; `lockReason` is the declared code (`code`, `update`, `data`, `lockout`, `config`) or `null` (delegable, or no code declared: the UI shows its fallback reason). `everywhere` is `{ mode, count }` or `null`; `groups` is the number of group-scope rules. A non-delegable command always reports `everywhere: null`, `groups: 0` (its stale rows are in `orphans`).
  - `orphans`: `[Orphan]` for every scope (`unknown_command` or `not_delegable`), sorted by `command` then `scope`.
  - `limits: { peopleMax: 100 }`. Read straight from the table (always fresh), writes nothing.
- **PERM-2**: `200 { command, delegable, lockReason, access, everywhere, groups }`. `access` is `{ owner, admin, group, pm }` as in CMD-1. `everywhere` is a `Rule` (people without `present`/`admin`) or `null`. `groups` is `[{ jid, name, mode, count, warnings }]` sorted by `name` (case-insensitive, `null` last) then `jid`; `name` comes from the groups snapshot, the `Group` row or `KnownChat`, else `null`; `warnings` are the data-free codes of 1.5. For a non-delegable command: `everywhere: null`, `groups: []`. `404` when the command is not loaded (its rows are PERM-1 orphans).
- **PERM-3 / PERM-6**: body `{ mode, people }` (both required, strict). Pipeline: schema, alias to canonical command (`404`), group `locate` (PERM-6, `404`), delegability (`422 name`), empty-list rule, people parsing and merge (1.3), diff, write (1.8). `200 { rule, changed }`: `rule` is the stored rule after the write (or as stored when `changed: false`) with its recomputed `warnings`; PERM-6's people carry `present`/`admin` for the path group, PERM-3's do not.
- **PERM-4 / PERM-7**: no body. `200 { deleted }`. Accept an **orphan name**: an unknown command, or a loaded non-delegable one, deletes its stored row (precedent CMD-2). `404 not_found { resource: "command" }` only when the command is not loaded **and** no row exists under that name; a loaded command with no row answers `deleted: false`. PERM-7 on a group the panel has never seen answers `404 { resource: "group" }` unless a row exists for that scope (a stale scope stays removable); a former group is allowed.
- **PERM-5**: `200 { rules, everywhere, orphans, members, limits }` for a group (path `:jid`). `rules`: this group's rules on loaded delegable commands, sorted by `command`, each a `Rule` with annotated people. `everywhere`: **every** `*` rule on loaded delegable commands (all of them, so the UI can compute the mode that applies here), each a `Rule` whose people carry `present`/`admin` **for this group** (FR-020 "qui ont accès dans ce groupe"). `orphans`: this group's stale rows (`Orphan` without `scope`). `members: { available, fetchedAt }` (`available: false`, `fetchedAt: null` when the bot is offline or the group left; every person then has `present: null`). `limits: { peopleMax: 100 }`. `404 { resource: "group" }` for an unknown group; a former group is allowed (rules survive, spec edge case). One `participants(jid)` call serves the whole answer.

Example (PERM-6 answer, `.kick` opened to a non-admin member):

```json
{ "rule": { "command": "kick", "scope": "120363000000000000@g.us", "mode": "extra",
    "people": [{ "jid": "237690000001@s.whatsapp.net", "name": null, "present": true, "admin": null }],
    "warnings": [{ "code": "opens_admin_command", "tone": "warn", "params": { "count": 1, "everywhere": false } }],
    "createdAt": "2026-10-30T10:00:00.000Z", "updatedAt": "2026-10-30T10:00:00.000Z" },
  "changed": true }
```

---

## 3. Changes to existing routes

The 002 contract is not edited; these are the only observable changes to existing routes, all additive. They land with the groups service (`lib/admin/services/groups.js`), covered by `test/admin-groups.test.js` (`:465`, `:739`).

| Route | Change |
|---|---|
| GRP-3 `GET /admin/api/groups/:jid` | `counts` gains `permissions`: the number of `permission_rules` rows whose `scope` is the group (orphans included: they are listed on the same tab). Feeds the tab badge. The object stays otherwise as in 002 |
| GRP-6 `DELETE /admin/api/groups/:jid?confirm=true` | also deletes the group's rules (FR-030, U4), in the existing transaction; `deleted` gains `permissionRules` (number): `{ deleted: { group, filters, roles, warnings, commandStates, permissionRules } }`. A group the bot merely left keeps its rules. Audit unchanged (`group.delete`) |
| CMD-1, CMD-2, GRP-11, GRP-17 | none (frozen) |

**New internal method** `groups.participants(jid)` (not an HTTP route; used by PERM-5 and PERM-6): `locate(jid)` (`404` for an unknown group), then `metadataOf(jid)` non-required (60 s cache). Returns `{ former, available, fetchedAt, items: [{ pn, lid, admin }] }` from `participants[].id/phoneNumber/lid/admin`, normalized; never throws `not_connected` or `whatsapp_error`: `available: false` and `items: []` when the bot is offline or the group was left. GRP-11 `members()` keeps throwing (its UI contract).

---

## 4. Coverage matrix

| FR | Route(s) and rules |
|---|---|
| FR-001, FR-002 | PERM-3, PERM-6 (`mode`, `people`, scope `*` or group) |
| FR-003, FR-005, FR-006 to FR-011 | engine only (data-model 2, a-runtime); rows persist until DELETE |
| FR-004 | 1.3 identity (pn and lid stored; no role or "everyone" input exists) |
| FR-012, FR-013 | registry flags (data-model 2.3); PERM-1, PERM-2 report `delegable` and `lockReason` |
| FR-014 | PERM-3, PERM-6 `422 name: not_allowed`; engine ignores stored rows; PERM-1, PERM-5 orphan `not_delegable` |
| FR-019 | the only writers are PERM-3, PERM-4, PERM-6, PERM-7 (no WhatsApp command) |
| FR-020 | PERM-5, PERM-6, PERM-7 |
| FR-021 | PERM-1, PERM-2, PERM-3, PERM-4 |
| FR-022 | PERM-1, PERM-2 (`lockReason`); PERM-5 `rules` excludes locked commands |
| FR-023 | 1.5 warnings in PERM-2, PERM-3, PERM-5, PERM-6 |
| FR-024 | `present: false` (PERM-5, PERM-6); orphans (PERM-1, PERM-5); PERM-4, PERM-7 remove them |
| FR-025 | 1.7 audit |
| FR-026 | data-model 4 (`MODELS` 26); not a route |
| FR-030 | GRP-6 `deleted.permissionRules` |
| FR-031 | 1.3 typed numbers; membership not required |

Success criteria that depend on this contract: SC-003 (a forged row on a non-delegable command opens nothing: PERM-3/6 refusal plus the engine test), SC-006 (PERM-5 answers "who may use which command in this group" from one request).

---

## 5. Contract tests derived from this file

1. Route table: the 7 rows are registered with `auth: "session"` (extended `contractRoutes()`); `test/admin-security.test.js` enumerates them for free (401 without a session, CSRF and Origin refusals, `:name` and `:jid` sampled, no `GET` mutates, tables unchanged around every `GET`).
2. PERM-1: lists exactly the loaded commands with `delegable`, `lockReason`, `everywhere` count, `groups` count; orphans for an unknown command and for a row on a non-delegable command.
3. PERM-3/PERM-6: `extra` and `only` stored as `{ pn, lid }`; canonical command when an alias is given; `createdAt` kept and `updatedAt` moved on a second PUT; `changed: false` and no audit on an identical PUT; `extra` + `[]` accepted for a group, refused (`people: required`) for `*`; `only` + `[]` accepted and flagged `empty_only`.
4. Identity: `+237 6 90-00-00-03`, `00237...`, `(237) 690.000.003`, a `@lid`, a `:7` device suffix; the same person as PN then as LID is one person; a 7-digit number and `0690000003` (national, no country code) give `invalid_phone` with `indices` and without the value; 101 people give `too_many_items`; a group JID gives `invalid_jid`.
5. Refusals: non-delegable PUT (`name: not_allowed`, nothing written), unknown command (`404`), unknown group (`404`), unknown property (`$unknown`), no `confirm` needed on DELETE.
6. DELETE: idempotent; orphan names accepted (unknown and non-delegable); audit row only when something was deleted.
7. Warnings: each code of 1.5, with the `normal_here` tone rule and the `extra_on_public` / `normal_here` exclusivity; none when everyone is a known admin.
8. PERM-5: `present` / `admin` annotation, `present: null` when offline or for a former group (rules still listed), names from `KnownChat`, `everywhere` rules annotated for the group.
9. Audit: action, target, `added` / `removed` for add, remove, mode change and delete; the degrade rule of 1.7 above 1900 characters.
10. GRP-3 `counts.permissions` and GRP-6 `deleted.permissionRules`; the cache key `command_perms` is absent after each write.
