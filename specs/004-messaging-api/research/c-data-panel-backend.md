# Research C: data, panel backend and operations (feature 004, Phase 0)

Scope: models and indexes, backup, settings, step-up re-authentication, panel routes/service for the API page, audit, alerts, housekeeping/stats, boot wiring, backend tests. The public HTTP layer is stream A, the send engine stream B, the SPA stream D. `spec.md` (with its clarifications) is final. Evidence is `file:line` on branch `004-messaging-api` (4ea4b61). `d-panel-ui.md` was already written when this file was: where it proposed names (route prefix, `PUT` with `version`, `session/reauth`, flat test body, upload purpose `api`) they are adopted here and the few differences are listed in "Interfaces". No spike was needed; everything was read from code.

## C1. Models

**Decision.** Four new files in `lib/database/models/`, each `(sequelize) => Model`, no `DataTypes.ENUM` (strings + `validate.isIn`, as `database.test.js` enforces for the 14 panel tables), no foreign keys (logical links, `BroadcastTarget.runId` precedent), literals repeated in the model (a model cannot import an engine constant: `lib/database/index.js` loads every model synchronously, `PermissionRule.js:5-9`). Tables are created whole on first boot, so unique composite indexes are allowed (the ban concerns an index added to an existing table). Later columns must be nullable or defaulted.

**`ApiKey` -> `api_keys`**

| column | type | null / default | notes |
| --- | --- | --- | --- |
| `id` | INTEGER pk autoinc | | panel id |
| `name` | STRING(64) | no | 1-64 code points; unique case-insensitively among non-revoked keys (service invariant, `409 duplicate`) |
| `secretHash` | STRING(64) | no | hex SHA-256 of the whole secret (A confirms; 256-bit random, no salt needed); unique index |
| `last4` | STRING(4) | no | the only secret fragment ever shown (FR-010) |
| `rights` | JSON | no, `[]` | array of right ids (`messages.send.text`, `messages.read`, `media.url`...), at most 64. Explicit list = deny by default; a right of a removed module stays stored, is ignored at runtime and shown as orphan |
| `policyMode` | STRING(8) | no, `'list'` | `list` \| `known` \| `anyone` (D's names) |
| `recipients` | JSON | no, `[]` | at most 200 normalized JIDs: `<digits>@s.whatsapp.net` or `<id>@g.us`; kept when the mode changes (only read in mode `list`) |
| `limitPerMinute`, `limitPerDay`, `limitPending` | INTEGER | yes, NULL | NULL = follow the setting (C3), so duplicating inherits, changing the default applies. Bounds 1-1000 / 1-100000 / 1-5000 |
| `ipAllow` | JSON | no, `[]` | at most 20 normalized IPv4/IPv6 or CIDR strings; empty = no restriction |
| `expiresAt`, `revokedAt` | DATE | yes | status is derived: `revoked` > `expired` > `active`; revocation is final (no un-revoke route) |
| `lastUsedAt`, `lastIp` | DATE, STRING(45) | yes | write-behind by A, at most one write per key per 60 s (`sessions.js:38` pattern); full textual address (not the /64 origin key) |
| `seenIps` | JSON | no, `[]` | at most 20 distinct, oldest dropped; empty means "never used", so the first use never alerts (C6) |
| `version` | INTEGER | no, 1 | optimistic concurrency for `PUT` (D's `409 conflict`); bumped by panel writes and revoke, **never** by the usage columns above |
| `createdAt`, `updatedAt` | | | Sequelize |

Indexes: unique `secretHash`. At most 50 non-revoked keys (`409 limit_reached`), so no other index.

**`ApiMessage` -> `api_messages`** (metadata only, FR-073)

| column | type | null / default | notes |
| --- | --- | --- | --- |
| `id` | INTEGER pk autoinc | | internal; ascending = FIFO order of acceptance |
| `publicId` | STRING(32) | no | unguessable (FR-033), format owned by A/B (`msg_` + 22 base64url suggested); unique |
| `apiKeyId` | INTEGER | yes | NULL for source `panel` |
| `source` | STRING(5) | no, `'api'` | `api` \| `panel` |
| `idempotencyKey`, `requestHash` | STRING(128), STRING(64) | yes | hash of the canonical request (fields + media digest) answers `idempotency_conflict` without storing content. Both NULLed after 24 h (C7), so a key is reusable later |
| `recipient` | STRING(64) | no | normalized JID, clear here (the panel shows it), masked only in logs |
| `format` | STRING(24) | no | **no `isIn`**: formats are modules |
| `size` | INTEGER | yes | bytes of the media file, else UTF-8 length of the main text; never content |
| `status` | STRING(10) | no, `'queued'` | `queued sending sent delivered read failed expired cancelled unknown`, `isIn` |
| `errorCode` | STRING(40) | yes | stable code (`not_on_whatsapp`, `media_conversion_failed`, `group_not_writable`...) |
| `waMessageId` | STRING(64) | yes | `key.id` of the sent message |
| `requestId` | STRING(16) | yes | `X-Request-Id` of the accepting request (FR-094) |
| `acceptedAt`, `expiresAt` | DATE | no | engine clock (`now` injected), not Sequelize's `createdAt`; `expiresAt` = acceptance + `API_QUEUE_EXPIRY_MIN` at that moment |
| `sendingAt`, `sentAt`, `deliveredAt`, `readAt`, `endedAt` | DATE | yes | one per step (US3.1); `endedAt` is the time of `failed/expired/cancelled/unknown` |
| `repliesUntil` | DATE | yes | `sentAt + API_REPLY_WINDOW_DAYS`, only for interactive formats |
| `payload` | JSON | yes | **transient content** needed to send after a restart (FR-038); NULLed in the same UPDATE that sets a terminal status; at most 128 KB (validator) |
| `choices` | JSON | yes | `[{ id, label? }]` for buttons/list (caller ids, in order, for the numbered-reply fallback) and polls (`id` = option index); `label` only if open point 1 is accepted |
| `replyData` | JSON | yes | poll decryption material (`messageSecret`, option hashes, multi flag), B's shape, no plaintext; NULLed once `repliesUntil` has passed |
| `mediaPath` | STRING(255) | yes | `data/api-media/<publicId>/<sanitizedName>` (Broadcast precedent); NULLed after the file is deleted |
| `createdAt`, `updatedAt` | | | |

Indexes: unique `publicId`; **unique `(apiKeyId, idempotencyKey)`** (NULLs are distinct on SQLite and Postgres, so API calls without a key and all panel rows never collide; a concurrent duplicate raises a unique violation that A turns into "return the first row", `database/index.js:40` `isUniqueViolation` shows the detection); `waMessageId` (receipts, reply capture); `(status, acceptedAt)` (claim the oldest `queued`, expiry scan over at most 500 rows); `(apiKeyId, status)` (per-key pending count in the hot path); `(apiKeyId, acceptedAt)` (per-minute/day counts, history by key, usage); `acceptedAt` (period filter, retention).

**`ApiMessageResponse` -> `api_message_responses`**: `id` pk; `messageId` INTEGER not null; `kind` STRING(6) `choice` \| `vote`; `author` STRING(64) not null (normalized JID, PN when known); `choiceIds` JSON not null `[]` (button/list: `[id]`, poll: option indexes, several when multiple choice); `via` STRING(6) null `tap` \| `number`; `respondedAt` DATE not null; timestamps. Indexes `(messageId, respondedAt)`, `(messageId, author)` (a poll vote replaces the previous one of the author: delete + insert under `withLock("api-responses")`), `respondedAt`. At most 1000 rows per message (extra taps ignored, counted in the log).

**`ApiState` -> `api_state`**: singleton, `id` INTEGER pk (always 1), `enabled` BOOLEAN not null `false`, `changedAt` DATE null, `changedBy` STRING(64) null (origin key of the session), timestamps. See C3 for why it is not a setting. **No row is created by a read**: `load()` treats absence as disabled, the first `set()` inserts (`admin-security.test.js:404-416` fails if any GET writes a table).

**JSON on SQLite.** A JSON column read with `raw: true` is a string on SQLite and an object on Postgres; with model instances it is parsed on both. Every reader of these tables uses instances or `get({ plain: true })`, never `raw: true` on a JSON column (`PermissionRule.js:37`, `commandPermissions.js:112-119`, finding B1 of 003). Counting queries (`count`, `attributes: ["apiKeyId","status"]` with `raw`) are fine because they do not select JSON. A shared helper `asList(value)` in the store modules parses a string defensively. `test/database.test.js` pins that `findAll()` returns arrays.

**Postgres.** INTEGER (2^31 holds `MAX_UPLOAD` 2000 MB in `size`), BOOLEAN, DATE (timestamptz), JSON, STRING(n) only; index names stay under 63 characters (longest: `api_message_responses_message_id_responded_at`, 45). The Postgres path is untested in this repo (CLAUDE.md), nothing here needs a dialect branch. Sync is additive: the four tables appear on the next start (`database/index.js:254-286`, `Model.sync()` for a missing table); no existing table is touched. `test/database.test.js:676-682` currently asserts `14 + 18 + 1` created tables: it becomes `+ 4`, and a `FEATURE_004_TABLES` block (columns, indexes, NULL-distinct idempotency pair, defaults) is added in the style of `FEATURE_003_TABLES` (`:569-576`).

**Rationale.** Explicit `rights` and `NULL`-means-default limits make "new endpoint granted to nobody" (FR-011) and "changing the default applies" free. Integer `id` + `publicId` keeps FIFO ordering and cheap joins while the outside only sees an unguessable id. `payload` is the only place content exists, and only while a message waits; it is the price of FR-038 (queue survives a restart) and is wiped with the status (open point 1). Per-step timestamps instead of a history table keep one row per message (a status log would triple writes).

**Alternatives.** (a) `ApiKey` limits as NOT NULL copies of the defaults: rejected, a changed default would not reach existing keys and duplicate would freeze old values. (b) A `lookupId` column for key lookup: only if A prefers `owb_<id>_<secret>`; A may add one nullable column. (c) Rights in a join table: rejected, 64 strings, no query needs it. (d) Status history table: rejected (above). (e) Idempotency in memory: rejected, FR-034 + SC-006 span restarts.

**Evidence.** `lib/database/index.js:12-29,55,184,212,254`; `lib/database/models/PermissionRule.js:5-9,37,65-67`; `models/BroadcastTarget.js` (unique composite, logical link, `errorCode`); `models/Broadcast.js:78` (JSON); `models/AdminSession.js` (hash-only secret); `test/database.test.js:569-576,676-682`; `test/admin-security.test.js:404-416`.

**Files.** new `lib/database/models/{ApiKey,ApiMessage,ApiMessageResponse,ApiState}.js`; `test/database.test.js`.

## C2. Backup

**Decision.** All four models go to `EXCLUDED_MODELS` (`lib/admin/backup/format.js:88-97`), none to `MODELS` (stays 26, `AUTO_INCREMENT_MODELS` untouched). The exclusion test (`test/backup.test.js:198-214`) forces the choice; `restore.js:594` only destroys `MODELS`, so a restore leaves the four tables alone (`backup.test.js:353`).

**Rationale.** (1) Restoring an older archive would flip `revokedAt` back to NULL: it would silently undo a security response. This is the reason `AuditLog` and `AdminSession` are excluded (U12). (2) An archive containing `ApiKey` is a copy of working credentials: restoring it on a second installation (staging, clone) activates the same keys against another number. The hashes themselves are not crackable offline (256-bit random), so the risk is cloning, not brute force. (3) `ApiMessage` carries queued messages and idempotency keys: a restore would resurrect sends that expired or already left, against FR-037/FR-038/SC-006. (4) History is transient (30 days). (5) `ApiState.enabled` is per installation; a restore must never turn the API on (FR-001). Cost: after moving to a new server the owner recreates the keys (open point 2). No `backup.model_*` panel key is needed (those exist for exported models only).

**Alternatives.** Export key metadata without hashes: rejected, produces keys that cannot authenticate, a trap. Export `ApiKey` with hashes behind a flag: rejected, (1) and (2) remain.

**Evidence.** `format.js:54-97`; `restore.js:594`; `test/backup.test.js:198-214,320,353`; `test/helpers/backupKit.js:162-170` (`seedExcluded` gets four rows).

**Files.** `lib/admin/backup/format.js`; tests: `backup.test.js` (comment "26 + 7" -> "26 + 11", a test that the four are excluded and untouched by a restore), `backupKit.js`.

## C3. Settings

**Decision.** (a) The on/off switch is **not** a catalog setting: dedicated state `lib/utils/apiState.js` over `ApiState` (C1), API `load({ models })`, `isEnabled()` (sync; `row.enabled && config.ADMIN_PANEL`), `snapshot()`, `set(enabled, { actor, now })` (writes, then memory, then listeners), `onChange(fn) -> off`. Same family as `commandState.js`/`maintenanceMode.js`, in `lib/utils` so API, engine and panel can require it without a cycle (`lib/messaging` may not require `lib/api` or `lib/admin`). (b) Ten tunables become catalog entries, all `env: null` (panel-only, like `BROADCAST_DELAY_MS` and `ALERT_*`, `settingsCatalog.js:789,881`), so `config.env.example` and `settings-example.test.js` are untouched (it only requires a line for entries with an env name, `:73-89`):

| key | type | default | rule | theme | effect | read by |
| --- | --- | --- | --- | --- | --- | --- |
| `SEND_MIN_SPACING_MS` | int ms | 2000 | `int(2000, 600000)` ("up only", FR-035) | limits | immediate | B's pacer and the broadcaster, per send |
| `API_RATE_PER_MINUTE` | int | 30 | `int(1, 1000)` | limits | immediate | A's quota check; `key.limitPerMinute ?? config...` |
| `API_RATE_PER_DAY` | int | 1000 | `int(1, 100000)` | limits | immediate | same |
| `API_MAX_PENDING` | int | 100 | `int(1, 5000)` | limits | immediate | same |
| `API_QUEUE_MAX` | int | 500 | `int(1, 5000)` | limits | immediate | B, at acceptance |
| `API_QUEUE_EXPIRY_MIN` | int min | 10 | `int(1, 1440)` | limits | immediate | B, snapshot into `expiresAt` at acceptance |
| `API_RETENTION_DAYS` | int days | 30 | `int(1, 365)` | limits | immediate | housekeeping, at each run |
| `API_REPLY_WINDOW_DAYS` | int days | 7 | `int(1, 30)` | limits | immediate | B, snapshot into `repliesUntil` at send |
| `ALERT_API_ORIGIN_BLOCKED` | bool | true | none | alerts | immediate | alerts engine |
| `ALERT_API_KEY_NEW_IP` | bool | **false** | none | alerts | immediate | alerts engine ("facultative", opt-in) |

Plus one cross validator beside `responderDelays` (`settingsCatalog.js:997`): `API_REPLY_WINDOW_DAYS <= API_RETENTION_DAYS` (`bound_conflict`). No new theme (the Settings tabs `limits` and `alerts` exist; a new theme costs `THEMES`, `THEME_ORDER` in `settings-logic.mjs:8`, `settings.theme.<x>` and the theme list in `admin-i18n.test.js:58`). The API page reads and edits these through SET-1/SET-2 filtered on the ten keys (API-1 returns the effective values plus `settingKeys`), so there is one write path.

**Why the switch is not a setting.** A catalog entry has three write paths that skip the password: `PATCH /admin/api/settings` (`routes/settings.js:46-60`), the restore (`settingsStore.importOverrides` replaces every override from the archive, `:803-860`, and `SettingOverride` is exported), and the environment tier. Closing each means new generic code (a `stepUp` flag read by the settings service, a skip in `importOverrides`). `store.set` also refuses `readonly` entries (`:560-565`), so a read-only mirror cannot be written by the API service either. An `adapter` entry (D's suggestion) keeps SET-2 as a second writer. The dedicated row has exactly one writer (API-2), is excluded from backups (C2), and does not move the pinned counts (101 entries, 67 editable, `settings-store.test.js:120-147,1413`, `admin-settings.test.js:177`, `admin-i18n.test.js:198-201`). Cost: the switch is absent from the Settings page, which is what FR-001 wants ("the API page owns it").

**Capture-site rule.** No timer is built from these values. Every reader takes `config.API_*` / `config.SEND_MIN_SPACING_MS` at call time, snapshotting into a row only where the spec says a value is fixed at acceptance (`expiresAt`, `repliesUntil`). No `reconfigure()` is needed. `test/capture-sites.test.js` gets one block: a changed quota/expiry/spacing applies to the next request/message and not to rows already queued; plus a static scan that `lib/api/**`, `lib/messaging/**`, `lib/utils/apiState.js` have no top-level `= config.`.

**Counts after the change.** 111 entries (77 editable, 34 read-only), 22 secrets, 5 restart: update `settings-store.test.js:120-147,1413`, `admin-settings.test.js:177`, `admin-i18n.test.js:198-201`, `config-accessors.test.js:107,135` (add the ten names), CLAUDE.md ("101 entries"). Panel catalogs: `settings.<KEY>.label` and `.desc` x 10 x 2 languages (fragment `panel-api-settings.json`, `node tools/merge-panel-i18n.js --frag-dir specs/004-messaging-api/i18n`, `--dry-run` first).

**Alternatives.** `API_ENABLED` as env-visible catalog entry: rejected (FR-001 "only from the panel"). Expiry in ms: rejected, minutes read better and the entry has a `unit`. A per-key spacing: out of scope (the pacing is shared by all automatic sends).

**Evidence.** `settingsCatalog.js:762-795,881-889,997`; `config.js:63-69` (accessor per entry); `settingsStore.js:555-565,803-860`; `routes/settings.js:46-60`; `services/settings.js:391`; `test/settings-example.test.js:73-89`.

**Files.** `lib/utils/settingsCatalog.js`, new `lib/utils/apiState.js`, new `test/api-state.test.js`, tests above.

## C4. Step-up re-authentication (FR-021)

**Decision.** Four small pieces, no schema change.

1. **Where the timestamp lives**: `confirmedAt` (ms) on the in-process session cache entry of `lib/admin/auth/sessions.js`, not in `admin_sessions`. `entryFromRow(row, previous)` (`:182-197`) copies it from `previous` so the 60 s DB refresh (`:315`) keeps it; `snapshot()` (`:150`) exposes `confirmedAt` as `ctx.session.confirmedAt` (0 = never). New session methods: `confirm(id) -> confirmedAt`, `isRecent(session, at)`, constant `STEP_UP_MS = 300000` (fixed window from the confirmation, not sliding). A restart, `clearCache()`, logout, password change (the session is rotated, `routes/auth.js:348-350`), `destroyAll` or expiry lose it: the safe direction. It is per session id, so another browser is not confirmed (FR-021 "pour la session").
2. **Confirm route** `AUTH-7 POST /admin/api/session/reauth` in `routes/auth.js`, body `{ password }` (same schema as login, `nfkc`, 1-256). Same body as AUTH-5's check (`routes/auth.js:316-331`): `limits.password.check` BEFORE hashing, then `passwords.verify`, `fail()` / `success()`. It **shares the `limits.password` bucket** (5 failures / 15 min / origin, then 15 min block, `rateLimit.js:27-31,138-146`) with AUTH-5: a stolen session cannot guess faster through either door, and FR-021 asks "comme la connexion". Answers: `200 { confirmedUntil, windowMs: 300000 }`; wrong `422 validation_failed { fields: { password: { code: "wrong_password" } } }` (never 401, which drops the SPA to the login, AUTH-5 comment); blocked `429 rate_limited { params: { retryAfterMs } }` (the right password is refused during a block). Audit `account.confirm` (`ok`, `fail`, and `blocked` when the block starts, detail `{ retryAfterMs }`), no alert (AUTH-5 raises none either).
3. **Gate**: `deps.auth.requireRecent(session, now)` throws `AdminError("password_required", { params: { windowMs } })`, **403** (new key of `STATUS_BY_CODE`, `response.js:22`; listed in `EXTRA_SERVER_CODES` of `admin-i18n.test.js:65` so the 002 contract is not edited; `errors.password_required` x 2 languages). 403 and not 401 so the SPA keeps its session (D4 already handles it). Fail closed: a stub `auth` without the method makes a `stepUp` route answer `password_required`.
4. **Router**: one route option, `stepUp: true | "conditional"`, unsafe `session` routes only (throws otherwise, like `csrf`). `true`: after query/body validation (step 3 of `dispatch`, `router.js:377-389`) and before the handler, the router calls `env.auth.requireRecent(ctx.session, ctx.now)`; validation errors therefore come first and the password is never asked for a request that would fail anyway. `"conditional"`: documentation + table flag; the handler decides because "widening" depends on the diff, through `ctx.stepUp()` (added to `ctx`, same call). `routes()` (`router.js:220`) adds `stepUp` to the enumerated fields. Net router change about 20 lines.

**Uses.** `stepUp: true`: API-5 create, API-7 duplicate. `"conditional"`: API-2 (only `enabled: true`), API-6 (only when the diff widens). The service computes the diff after the stored row is read under the lock, then calls `ctx.stepUp()` last (after validation and the `policy_anyone` confirmation), so a wrong password or a missing confirmation saves nothing (US4.7).

**Widening predicate (server is authoritative, D mirrors it)** on the stored row `old` vs the submitted `new`: (a) any right in `new.rights` not in `old.rights`; (b) policy rank rises (`list` 0 < `known` 1 < `anyone` 2); (c) `new.policy.mode === "list"` and a recipient of `new.recipients` is not in `old.recipients`; (d) `old.ipAllow` non-empty and (`new.ipAllow` empty or an entry not covered by an old entry; coverage = same family and `start/end` range inside, BigInt compare, A's `ipList.covers`); (e) `old.expiresAt` set and (`new` null or later). Name and limits never count (FR-021 does not list quotas: stated as a deliberate reading). Revoke, narrowing, disabling the API and the usage columns never ask.

**Rationale.** Memory-only keeps the session table and its tests unchanged and expires by construction. Reusing the AUTH-5 bucket avoids a fourth limiter. A declarative flag lets `admin-security.test.js` enumerate which routes can widen access (SC-002-style) instead of trusting each service.

**Alternatives.** DB column `passwordConfirmedAt`: survives a restart for at most 5 minutes, costs a migration and a write: rejected. Password in each widening request: rejected (D4: bodies would carry the password, retry flow harder). Reusing `confirmation_required` (409): rejected, it means "confirm a risky choice" (`confirm` tokens) and the SPA already handles it differently.

**Evidence.** `router.js:97,196-232,352-394` (ctx build, auth, guard, body, handler); `sessions.js:36-41,150-197,311-330,411`; `auth/index.js:165-181,243` (`authenticateSession`, facade `authenticate`); `rateLimit.js:138-146`; `routes/auth.js:307-345`; `response.js:22-72,119-128`; `admin-i18n.test.js:37-65,185-196`.

**Files.** `lib/admin/http/router.js`, `lib/admin/auth/{sessions,index}.js`, `lib/admin/routes/auth.js`, `lib/admin/http/response.js`; tests C9.

## C5. Panel routes and service

**Decision.** `lib/admin/routes/api.js` (`register`, auto-loaded in sorted order, `routes/index.js`) over `lib/admin/services/api.js` (`createApiService(deps)`, never touches `req`/`res`, resolves `apiState`, `messaging`, `registry`, `keyStore`, `uploads`, `models` lazily from `deps` as `deps.x || require(...)`). Prefix `P = /admin/api/api` (D's choice; the segment is the area name, as `/admin/api/broadcasts`; D keeps it in one constant per view file for the route scanner of `admin-frontend.test.js`). All routes `auth: "session"`, CSRF on unsafe, touch default, DB required. Contract file: `specs/004-messaging-api/contracts/admin-api-panel.md`, "## 2. Routes" ... "## 3. Changes to existing routes", ids `API-1..API-13` + `AUTH-7`. Multi-statement key writes run under `withLock("api-keys")` (single SQLite connection, `mutex.js`), after `ctx.stepUp()`-style checks that read only memory.

| ID | Method and path | Flags | Audit | Answer |
| --- | --- | --- | --- | --- |
| API-1 | `GET P` | | | `{ enabled, changedAt, queued, botReady, https, baseUrl, stepUp: { confirmedUntil, windowMs }, counts: { active, expired, revoked }, settings: { minSpacingMs, perMinute, perDay, maxPending, queueMax, expiryMin, retentionDays, replyWindowDays, settingKeys: {...} } }` |
| API-2 | `PUT P/state` | stepUp conditional | `api.enable` / `api.disable` | body `{ enabled, confirm? }`; `true` needs password; `false` needs `confirm: true` (it cancels the queue) and no password. `{ enabled, cancelled }`; same state = `changed: false`, no audit |
| API-3 | `GET P/catalog` | | | `{ version, baseUrl, rights: [{ id, group, format }], formats: [descriptor], endpoints, limits }` from A's registry + B's formats; new modules appear with no edit here (FR-092) |
| API-4 | `GET P/keys` | | | `{ items: [KeyView] }`, revoked included |
| API-5 | `POST P/keys` | stepUp true | `api.key.create` | `201 { key, secret }` (`Cache-Control: no-store`, the secret appears in no other place) |
| API-6 | `PUT P/keys/:id` | stepUp conditional | `api.key.update` | full replace + `version`; `{ key, changed }`; `409 conflict` on stale version. No `GET /keys/:id`: the list already carries every field |
| API-7 | `POST P/keys/:id/duplicate` | stepUp true | `api.key.duplicate` | `{ name? }`; default name `<name> (2)` (first free number, language-neutral); `201 { key, secret }`; `409 not_editable` if the source is revoked or expired |
| API-8 | `POST P/keys/:id/revoke` | | `api.key.revoke` | `{ confirm: true }`; `{ key, cancelled }`; idempotent (`cancelled: 0`, no audit when already revoked) |
| API-9 | `GET P/messages` | | | query `key` (`^(panel\|\d{1,10})$`), `status` (enum of 9), `format` (`^[a-z][a-z0-9_]{0,23}$`), `from`, `to` (ISO), `page`, `pageSize` (default 50, max 200); `{ items: [MessageRow], page, pageSize, total }`, newest first |
| API-10 | `GET P/messages/:id` | | | `{ message: MessageDetail }`, numeric internal id (default `:id` pattern, so `admin-security` samples it); `404 not_found { resource: "message" }` |
| API-11 | `POST P/test` | `bodyLimit` 64 KiB, no `schema` | `api.test` | flat body `{ format, to, uploadId?, ...formatFields }`; `202 { message: MessageRow }` |
| API-12 | `GET P/usage` | | | query `days=7\|30`, `key=<id>\|panel\|all`; `{ timezone, from, to, keys: [{ id, name, revoked, days: [{ day, sent, failed }] }] }`, dense, plus a `panel` entry for `key=panel\|all` |
| API-13 | `GET P/openapi` | | | download (`Content-Disposition: attachment; filename="openwabot-api-v1.openapi.json"`), works while the API is disabled; `baseUrl` = `PANEL_PUBLIC_URL` or the request's own origin |
| AUTH-7 | `POST /admin/api/session/reauth` | | `account.confirm` | C4 |

The numbering is D's (`d-panel-ui.md`, "Needed from C"), paths included.

**Objects.** `KeyView`: `{ id, name, last4, status: "active"|"expired"|"revoked", createdAt, updatedAt, revokedAt, expiresAt, version, lastUsedAt, lastUsedIp, rights, orphanRights, policy: { mode, recipients: [{ jid, name|null }] }, limits: { perMinute, perDay, maxPending } (null = default), ipAllow, queued }` (no hash, no `seenIps`, only its length as `seenIpCount`). `KeyInput`: `{ name, rights, policy: { mode, recipients }, limits: { perMinute?, perDay?, maxPending? }, ipAllow, expiresAt, version?, confirm? }`; `confirm` is `["policy_anyone"]`, required when the resulting mode is `anyone` and the stored one is not (`409 confirmation_required { confirm: ["policy_anyone"] }`, SET-2 pattern). Nested objects are validated by the service with `request.js#validate` and re-keyed `policy.mode`, `limits.perDay`, `ipAllow` (indices only for lists, never the value). `MessageRow`: `{ id, source: "api"|"panel", key: { id, name }|null, to, toName|null, kind: "private"|"group", format, size, status, failureCode, acceptedAt }` (D wrote `"key"` for `source`; the DB and the brief say `api`). `MessageDetail` = row + `{ publicId, waId, expiresAt, steps: [{ status, at }], interactive, responses: { items: [{ at, author, choices: [{ id, label|null }] }], totals: [{ id, label|null, count }]|null, total } }`; `steps` is built from the timestamp columns, `totals` by B's `describeResponses` (latest vote per author for polls).

**Check order** (first failure answers, schema reports all its fields): router (401/403 CSRF/Origin/415, 503 `maintenance`/`db_unavailable`) > schema (`422`, unknown property `$unknown`) > 404 (`key`, `message`) > key state (`409 not_editable` revoked/expired) > semantic (`422`: rights not in the catalog and not already stored `not_allowed`; `invalid_phone`/`invalid_jid` with `indices`; IP entries `invalid_format` with `indices`; `expiresAt` `in_past`; `too_many_items`; names `duplicate`; `limit_reached` at 50 keys) > version (`409 conflict`) > `policy_anyone` confirmation (`409`) > step-up (`403 password_required`) > write. Field codes are the existing vocabulary (no new field code). Recipients typed as numbers go through B's `parseRecipient` (rules of 003 section 1.3: strip `+ - . ( )` and a leading `00`, 8-15 digits, no leading `0`); groups must match `^\d+(-\d+)?@g\.us$`.

**Write effects.** Create/update/revoke call A's `keyStore.invalidate(id)` (revocation takes effect on the next request, FR-014); revoke calls `messaging.cancelForKey(id, "key_revoked")` (queued rows -> `cancelled`, payload and media deleted) and returns the count; API-2 `false` calls `apiState.set(false)` then `messaging.disable()`. `lastUsedAt`/`lastIp`/`seenIps` are written only by A.

**Test send (API-11).** Same engine, `source: "panel"`, `apiKeyId` NULL: content validation, `chat_disabled`, pacing, global queue cap and media rules apply; key rights, per-key quotas and recipient policy do not (no key). It needs the API enabled: `409 api_disabled` (new code, `EXTRA_SERVER_CODES`), because the engine does not run otherwise (FR-001). The flat body reserves `format`, `to`, `uploadId` (B must not name a field like that); the rest is validated strictly by the format module and errors come back as `422 validation_failed` with dotted `fields` keys (`buttons.1.id`). Engine rejections (`chat_disabled`, `media_type_mismatch`, `media_too_large`, `queue_full`, quota codes, `url_forbidden`...) must be keys of `STATUS_BY_CODE`, otherwise `toHttpError` turns a typed error into a 500 (`response.js:119-128`); A owns that list, D writes the `errors.<code>` texts (`admin-i18n.test.js:185-196` enforces both). Media: **upload purpose `api`** (D): add to `PURPOSES` (`uploads.js:47`) and a branch in `sniffFile` (`:94`) that calls B's content sniffer (lazy require, `lib/admin` may require engines), returning `{ kind, mime }` or null; the service takes the file with `uploads.consume(id, ctx.session.id, { purpose: "api" }, fn)` and hands the path to the engine, which copies it to its staging directory (the 1 h upload janitor is unaffected). No extra throttle on panel tests: spacing (2 s) and `API_QUEUE_MAX` already bound them. No step-up (not in FR-021's list).

**Usage (API-12).** `GET` over `api_messages` (`attributes: ["apiKeyId","status","acceptedAt"]`, `raw: true`, indexed range on `acceptedAt`), grouped in JS by the local day in `TIMEZONE` (`stats.js` `dayOf`, luxon) so day edges match the other stats; `sent` = `sent|delivered|read`, `failed` = `failed|expired|unknown`, `cancelled` is counted in neither. At most 30 days (`days` 7 or 30).

**Pickers.** CHAT-1 `GET /admin/api/chats?kind&q&page&selectable` (`routes/chats.js:26-36`) is reused unchanged for known chats and groups; typed numbers go through the same normalization server-side. No new route.

**Audit** (`ACTIONS`, `audit.js:28`): `api.enable`, `api.disable` `{ cancelled }`, `api.key.create` / `api.key.update` / `api.key.duplicate` / `api.key.revoke` (target `String(id)`; detail `{ name, rights: {added, removed} | list, policyMode, recipients: count, limits, ipAllow: count, expiresAt, widened }`, **no recipient list, no secret**), `api.test` (target message id, detail `{ format, kind }`, no recipient, no content), `account.confirm`, optional `api.origin.block` (written once when A starts a block, result `blocked`). One row per request, only when something changed. Add the prefix `api` to `ACTION_PREFIXES` (`audit-logic.mjs:10`; `admin-view-logs-stats.test.js:238` fails otherwise), `audit.prefix_api` and the `detail` summaries (D).

**Rationale.** Everything that decides security (widening, step-up, confirm, state) is in one service behind the router's table; the SPA mirrors it only to ask early. Reusing uploads, CHAT-1, SET-2 and the audit module adds no mechanism.

**Alternatives.** `PATCH` partial update: rejected, `PUT` + `version` gives lost-update protection with D's draft/save flow and a simple diff. A `stepUp` property on every write: rejected, restricting actions must stay free. Multipart in the panel: rejected, the guard accepts JSON or raw octet-stream only (`router.js` `upload`), the broadcast flow already does upload-then-reference. A hub topic for message status: rejected, `admin-integration.test.js` pins five topics; D polls.

**Evidence.** `routes/permissions.js:1-60` and `contracts/admin-permissions-api.md` (style, table format, `contractRoutes()` rules); `test/admin-integration.test.js:44-46,104-110,126-137,208` (a new contract needs one `SECTIONS` entry, its own id test and a row-count assertion; `UNDOCUMENTED` stays unchanged); `routes/settings.js:46-60`; `routes/maintenance.js:27-31` (`confirm` body); `routes/chats.js`; `http/uploads.js:47,94,144,199-203`; `routes/uploads.js:17-24`; `audit.js:28-71`.

**Files.** new `lib/admin/routes/api.js`, `lib/admin/services/api.js`, `specs/004-messaging-api/contracts/admin-api-panel.md`; edits `routes/auth.js`, `http/uploads.js`, `audit.js`.

## C6. Alerts

**Decision.** Two new types in `lib/utils/alerts.js` `TYPES` (`:77-85`): `api_origin_blocked` (toggle `ALERT_API_ORIGIN_BLOCKED`, slot `api_origin_blocked:<origin>`, 15 min, payload `{ origin, retryAfterMs, at }`, copy of `login_blocked`) and `api_key_new_ip` (toggle `ALERT_API_KEY_NEW_IP`, slot `api_key_new_ip:<keyId>`, 1 h so a botnet with a stolen key cannot flood the owners, payload `{ keyId, keyName, ip, at }`, rebuilt field by field in `sanitize`, names/IPs cut with `plain()`). Raised by **direct call** `alerts.raise(type, payload)` from `lib/api` (A) through an injected `deps.alerts`, no new bus topic: `events.js` exists to break the cycle `http.js -> alerts.js` (`events.js` header), and `lib/api -> lib/utils/alerts` has none; "three topics only" (CLAUDE.md) stays true. A raises `api_origin_blocked` when the throttle reports `newlyBlocked` (FR-018) and `api_key_new_ip` after a successful authentication when `seenIps` is non-empty and the IP is not in it (the first IP of a key never alerts). Texts: `alerts.api_origin_blocked` ({0} origin, {1} minutes), `alerts.api_key_new_ip` ({0} key name, {1} IP) in `specs/004-messaging-api/i18n/bot-api.json`, merged with `node tools/merge-i18n.js --frag-dir specs/004-messaging-api/i18n --pattern "bot-*.json"` (`--dry-run` first; same key set in en/fr).

**Knock-on edits (not optional).** `AlertOutbox.js:11` `TYPES` must list both (validation `isIn`; the column is STRING(24), 18 and 14 characters, no DB change); `prune()` and `housekeeping.pruneAlertStates` (`:190`) delete `api_origin_blocked:*` slots after 24 h like `login_blocked:*` (`alerts.js:319-330`, `housekeeping.js:190-193`); `getStatus` already iterates `TYPE_SETTINGS`; `lib/admin/services/alerts.js:20-27` and `public/js/views/alerts-logic.mjs:5-12` append two rows (ALR-1 goes from six to eight types; `alerts.type_*` / `_desc` panel keys, D); tests `alerts.test.js:38,123`, `admin-alerts.test.js:42,126`, `admin-view-alerts.test.js:35-47`.

**Rationale.** The engine already gives persisted compare-and-swap slots, the outbox for disconnections and the owner fan-out; a second mechanism would duplicate it. Default `ALERT_API_ORIGIN_BLOCKED` true (security signal, same as `login_blocked`), `ALERT_API_KEY_NEW_IP` false (FR-019 "facultative"; a key behind a cloud automation tool changes IP often).

**Alternatives.** Bus topics `api:blocked` / `api:newip`: rejected (no cycle to break, listeners to keep). Reusing `login_blocked`/`new_origin` with other text: rejected, different toggle, slot key and wording.

**Evidence.** `alerts.js:1-44,77-85,150-170,211-243,319-330`; `events.js:1-20`; `AlertOutbox.js:11`; `housekeeping.js:190-193`; `services/alerts.js:20-27`; `auth/index.js:144-163` (the panel's own `raiseAlert` guard); `specs/002-admin-panel/i18n/bot-alerts.json`.

**Files.** `lib/utils/alerts.js`, `lib/database/models/AlertOutbox.js`, `lib/utils/housekeeping.js`, `lib/admin/services/alerts.js`, `specs/004-messaging-api/i18n/bot-api.json`.

## C7. Housekeeping and stats

**Decision.** Five steps added to `housekeeping.run()` (`:286-298`, each through `step()` so one failure never stops the others), all with model methods, batches of `LIMITS.BATCH = 500`, retention read from `config.API_RETENTION_DAYS` at run time:

1. `apiIdempotency`: `UPDATE api_messages SET idempotencyKey = NULL, requestHash = NULL WHERE idempotencyKey IS NOT NULL AND acceptedAt < now - 24 h` (`LIMITS.API_IDEMPOTENCY_MS`). The engine also does this lazily for the one row it meets on a replay older than 24 h, so the unique index never blocks a legitimate reuse between two runs.
2. `apiTransient`: NULL `replyData` where `repliesUntil < now`; NULL `payload` where `status NOT IN ('queued','sending')` (belt and braces: the engine clears it with the status); delete files of terminal rows still holding `mediaPath`.
3. `apiMessages`: batches of ids with `acceptedAt < now - retention` and `status NOT IN ('queued','sending')`: responses first (`messageId IN ids`), then messages; then orphan responses (`messageId NOT IN (SELECT id FROM api_messages)` via `DATABASE.literal`, `housekeeping.js:216-221` pattern) and responses with `respondedAt < cutoff`. User story 3.6.
4. `apiKeys`: delete revoked keys with `revokedAt < now - retention` (their messages are all older than that, so step 3 already ran). Expired-not-revoked keys stay (the owner can extend them).
5. `apiMedia`: `messaging.sweepMedia({ now })` resolved lazily like `broadcaster.sweepMedia` (`:253-256`, `optionalRequire("../messaging")`): B removes `data/api-media/<publicId>/` directories with no active (`queued|sending`) message (FR-075, orphan sweep). Runs outside any lock the engine takes.

Idle-time cost: when the API was never used the five steps are index-only no-ops. The daily job already runs with or without the panel, so FR-074 holds with `ADMIN_PANEL=false`.

**Usage per key per day.** `GROUP BY` over `api_messages` (C5, API-12), **not** `DailyStat`. Reasons: the history (30 days by default) and the usage have the same horizon, one truth, exact (no 30 s buffer lost on a crash, `stats.js` header), no new metric (`METRICS` is a frozen 4-entry set read by the stats service, panel and tests), no write on the send path, and purging history purges the figures it explains. Cost: at most one indexed range scan over 30 days x keys x 1000/day on a page that is opened rarely; if retention is raised to 365 days, `days` stays capped at 30. `DailyStat` with `api_sent`/`api_failed` and subject = key id would keep 90 days, but duplicates the engine's own rows and changes the frozen metric set.

**Evidence.** `housekeeping.js:49-67,216-221,253-256,281-300`; `stats.js:47,79-90`; `test/housekeeping.test.js:278-362` (assertions are on `report.errors` and named rules, so new keys do not break them).

**Files.** `lib/utils/housekeeping.js`, `lib/messaging/index.js#sweepMedia` (B); `test/housekeeping.test.js`.

## C8. Boot wiring

**Decision.** Edits to `lib/core/boot.js` only (CLAUDE.md: a change of boot order goes there):

1. `ENGINES` (`:31-37`) gains `{ name: "messaging", id: "../messaging", start: (engine, client) => engine.start(client) }` after `broadcaster`. Hard require like the others (a broken module fails the boot, header `:25-29`). `start(client)` is idempotent, creates **no timer and no listener** unless `apiState.isEnabled()`; it always runs a cheap `recover()` once: leftover `queued` rows are `cancelled` when the API is off, `sending` rows become `unknown` (FR-038), so `ADMIN_PANEL=false` after a crash leaves nothing queued forever. `enable()` / `disable({ reason })` are driven by `apiState.onChange` (subscribed inside `start()`); `stop()` is registered with `runtime.onShutdown` by the existing loop (`:222-232`).
2. `apiState` is a hard-required collaborator beside `textOverrides` (`:146-148`): `engineOf("apiState", "../utils/apiState")`, replaceable through `deps.engines.apiState`. Loaded in step 6 right after `settingsStore.load` and before `runtime.dbReady = true` (`:201-209`): `await apiState.load({ models: database })` (a read failure = disabled, logged).
3. Step 4, inside `if (config.ADMIN_PANEL)` (`:152-177`): `createAdmin({ ..., messaging: engineModules.messaging, apiState })`, then `api = pick("createApi", () => require("../api").createApi)({ config, models: database, runtime, messaging, apiState, alerts: engineModules.alerts, ... })` (A defines the dependency list), `runtime.onShutdown(() => api.stop())`, and `startAdminServer({ admin, api, runtime, bind, config })` -> `createPanelServer({ botState, admin, api })` whose handler becomes `admin.handle(req, res) || api.handle(req, res) || legacy` (`server.js:51-58`). `api.handle` claims only `/api/v1` and `/api/v1/**`, so `/api/info` and `POST /api/restart` stay in `monitoring.js` (frozen by `panel.test.js`, `panel-legacy.test.js`). With `ADMIN_PANEL=false`, `api` is never created and `apiState.isEnabled()` is false whatever the row says (FR-007).
4. Step 9: `if (api) await api.start()` right after `admin.start()` (`:234`).
5. Gate order inside `api.handle` (A implements): not mounted > `runtime.dbReady !== true` -> `503 starting` with `Retry-After` (FR-006) > disabled -> the legacy not-found answer > `maintenanceMode.isActive()` -> `503 maintenance` (`admin/index.js:185-189` is the model) > pipeline.
6. **Maintenance mode.** The engine skips its tick while `maintenanceMode.isActive()` (like `broadcaster.tick`, `maintenanceMode.js` header) and brackets each send with `begin()`/`done()` so a restore waits for the send in flight. The four tables are excluded from backups, so a restore changes neither the queue nor the keys nor the state; the engine resumes by itself. `settingsStore.set` refusing `busy` during a restore is unaffected (no setting is written by the engine).
7. **Registry failure** (US7.2): A builds the endpoint/format registry in `createApi` (fail fast, independent of the switch). Recommended: a throw there is logged with the endpoint name and the API stays unmounted while the bot keeps running (the spec says the API's start fails, not the bot's); the panel page then shows `apiState` disabled and API-2 `true` answers `409 api_disabled`.
8. `options.deps` gains `createApi`, `engines.messaging`, `engines.apiState`; the in-process restart (`botRuntime.js:196-231`) needs nothing: the engine reads `client.getSocket()` per send and the settings at call time.

**Alternatives.** Start the engine only from `admin.start()`: rejected, the cleanup in `recover()` must run without the panel. Create the API object lazily on first enable: rejected, registry errors must show at boot, and the memory of the code is small (SC-011 is measured with `tools/measure-panel-memory.js` on/off; the API disabled holds no timer, no queue, no cache).

**Evidence.** `boot.js:18,25-37,142-148,152-177,179-181,201-209,222-234`; `server.js:31-60,95`; `admin/index.js:185-189`; `maintenanceMode.js:1-20`; `botRuntime.js:196-231`; `test/boot.test.js:215-262,540-600`.

**Files.** `lib/core/boot.js`, `lib/admin/server.js`, `lib/admin/index.js` (pass-through of the two deps), `test/boot.test.js`.

## C9. Backend tests

**Edits to existing pinned tests** (each fails the day the feature lands): `boot.test.js:261,556-557` (six engines, `HARD_REQUIRES`); `backup.test.js:128,198-214` + `backupKit.seedExcluded`; `database.test.js:676-682` (+4 tables) and a 004 block; `settings-store.test.js:120-147,1413`, `admin-settings.test.js:177`, `admin-i18n.test.js:179,198-201` (111 entries, `EXTRA_SERVER_CODES` += `password_required`, `api_disabled`, plus A's codes, new `AREAS`/fragment dir, 20 settings keys), `config-accessors.test.js:107,135`; alerts trio (C6); `admin-integration.test.js` (`SECTIONS` + contract constant + id/row-count test, `:44-46,104-110,208`); `admin-uploads.test.js` (`purpose=api`); `admin-audit.test.js:128-135` (vocabulary), `admin-view-logs-stats.test.js:238` (prefix); `housekeeping.test.js`; `capture-sites.test.js` (C3).

**New files.** `test/api-state.test.js` (load absence = disabled, `set` persists then memory then listeners, failed write keeps memory, `ADMIN_PANEL=false` forces off, no row created by a read). `test/admin-stepup.test.js` (harness: wrong password 422 + audit `fail`, 5 failures then 429 and the right password refused, bucket shared with AUTH-5, 299 s ok / 301 s `403 password_required` on the fake clock, not valid for another session or after logout/password change/`clearCache`, a `stepUp: true` route saves nothing unconfirmed (`t.dumpTables()` unchanged), `"conditional"` route asks only on widening, CSRF still required). `test/admin-api.test.js` (route + service on the real harness with a fake messaging engine and fake key store): every row of the table, the widening matrix (one case per reason (a)-(e), and the narrowing cases that must not ask), `policy_anyone` confirmation order, `version` conflict, secret returned once and absent from audit/list/logs, duplicate suffix and `not_editable`, revoke cancels and invalidates, state toggle audit and cancel count, test send flat body and dotted field errors, `api_disabled`, usage zero-filled in `TIMEZONE`, history filters and pagination, OpenAPI download, a source-scan that no GET writes. `test/api-retention.test.js` (the five housekeeping steps with a fake clock, idempotency release, payload/replyData wiping, revoked key purge). `SC-003` automated check: after the scenarios, scan the log ring, every `AuditLog.detail`, and every text/JSON column of the four tables for the secret and for sample message text, captions and filenames.

**Harness.** `adminHarness.js:35,60-62` clears `AdminSession/Token/Account/AuditLog` per test; add `clearApiTables(db)` (the four tables, `opts.api: true`) and `adminClient.reauth(password)`. `createTestAdmin` already passes unknown `deps` through (`:94-110`), so `messaging`, `apiState`, `registry`, `keyStore` fakes need no harness change. `admin-security.test.js` covers the new routes for free (401 without session, CSRF/Origin, GET leaves every table unchanged, `:34-36,190-224,404-436`), with two additions: `routes()` exposes `stepUp`, and the test asserts the exact set of `stepUp` routes (`true`: API-5, API-7; conditional: API-2, API-6) so a future widening route cannot ship unflagged. Run single files only, capped (`OWB_NO_CONFIG_ENV=1 timeout 120 node --max-old-space-size=1024 --test --test-force-exit --test-timeout=30000 test/<file>.test.js`).

## Interfaces with other streams

**From A.** (1) `keyStore`: `generateSecret() -> { secret, secretHash, last4 }` (fixed prefix, >= 256 bits), `invalidate(id)`, `invalidateAll()`, and ownership of the usage-column write-behind (`lastUsedAt/lastIp/seenIps`, bound 20, never bumps `version`). (2) `registry.catalog()` (rights, endpoints, formats' rights), `openapi.build({ baseUrl, lang })`. (3) `ipList.parse(list) -> { entries, invalidIndices }` and `covers(oldEntries, newEntry)`. (4) The list of public error codes, all added to `STATUS_BY_CODE`. (5) `createApi(deps)` accepted deps and `{ handle, start, stop }`; `createPanelServer({ botState, admin, api })`. (6) Alert calls of C6 with exactly those payloads. (7) The unique violation on `(apiKeyId, idempotencyKey)` handled as "return the first row".

**From B.** (1) `messaging.start(client)`, `stop()`, `enable()`, `disable({ reason }) -> { cancelled }`, `cancelForKey(id, reason) -> n`, `submit({ source, apiKeyId, to, format, fields, media, idempotency, requestId }) -> { message }` or typed rejections, `stats() -> { pending, queueMax, connected }`, `sweepMedia({ now })`, `describeResponses(row, responses)`, `parseRecipient(input)` (pure, outside `lib/admin`), format descriptors. (2) Terminal-status writes clear `payload`, `mediaPath` and set `endedAt` in one UPDATE; lazily release an idempotency key older than 24 h. (3) Shapes of `payload`, `choices`, `replyData` are B's; reserved test-body names `format`, `to`, `uploadId`.

**To D.** Prefix `/admin/api/api`; the route table above (same ids and paths as `d-panel-ui.md` "Needed from C"; the only addition is AUTH-7 = D's REAUTH); `status: "active"|"expired"|"revoked"` (D listed two); `MessageRow.source` is `api|panel`; API-1 settings use minutes/days (`expiryMin`, `replyWindowDays`) and key names `SEND_MIN_SPACING_MS`, `API_*`; no new Settings theme; `api_disabled` replaces `bot_unavailable` (a disconnected bot still accepts); upload purpose `api`; `account.confirm` audit; `policy_anyone`; panel keys to write: `errors.password_required`, `errors.api_disabled`, `errors.<A's codes>`, `audit.prefix_api`, `alerts.type_api_origin_blocked(_desc)`, `alerts.type_api_key_new_ip(_desc)`, 20 settings label/desc keys.

## Open points for the owner

1. **Content kept while a message waits (FR-073 vs FR-038).** A queue that survives a restart must hold the text, caption, contact, poll question and staged file until the message reaches a terminal state; the history keeps none of it. Recommended: yes, as designed (`payload` and the staged file erased at the same moment as the status change, never copied to logs or audit, tables excluded from backups). The alternative (queue in memory, queued messages become `unknown` on restart) breaks FR-038. Linked: D's open point 1 (labels of poll options and buttons shown in responses): recommended keep only those short labels (<= 100 characters) until the retention purge, never the question, body, caption or media.
2. **Backups do not carry API keys, history or the on/off state.** Recommended: yes (C2). After a restore on another machine the owner recreates the keys; restoring an old archive cannot resurrect a revoked key or re-enable the API.
3. **Default of `ALERT_API_KEY_NEW_IP`.** Recommended off (opt-in), `ALERT_API_ORIGIN_BLOCKED` on.
4. **Revoked keys are purged from the list `API_RETENTION_DAYS` after revocation** (with their history), instead of being listed forever. Recommended: purge; the audit log (180 days) keeps the trace.
