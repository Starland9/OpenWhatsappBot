# Phase 1: data model

Feature `004-messaging-api`. Inputs: [spec.md](spec.md) (FR-001 to FR-094, SC-001 to SC-011, three Clarifications sessions), [research.md](research.md) (**authoritative**: owner decisions U1-U15 and arbitration X1-X22 override the stream files), research streams [A](research/a-http-security.md) (key format, quotas, idempotency), [B](research/b-messaging-engine.md) (status machine, receipts, replies, media) and [C](research/c-data-panel-backend.md) (models, backup, settings, retention, which owns the column names, X3). Other contracts: [public-api.md](contracts/public-api.md) (HTTP shapes of messages and responses), [runtime.md](contracts/runtime.md) (engine, queue, pacing, capture), [admin-api.md](contracts/admin-api.md) (panel routes and services), [panel-ui.md](contracts/panel-ui.md), [quickstart.md](quickstart.md).

Sequelize 6.37, SQLite (default) or Postgres (`DATABASE_URL` containing `postgres`). The four tables below are the contract of the model files `lib/database/models/{ApiKey,ApiMessage,ApiMessageResponse,ApiState}.js`. Every claim marked **(spike)** was run on SQLite through Sequelize 6.37.8 with draft models outside the repository (index names and lengths, NULL-distinct unique indexes, `silent` updates, CAS update counts, JSON read-back).

## 0. Compliance and conventions

### 0.1 Additive-sync compliance (CLAUDE.md "Database", G5)

| Rule | Status |
|---|---|
| New tables are created by `Model.sync()` (step 1 of `sync()`, `lib/database/index.js`) | 4 new tables: `api_keys`, `api_messages`, `api_message_responses`, `api_state` |
| No existing table altered (no column, no index, no type) | 0 existing table touched. Existing **model files** edited only for a constant: `AlertOutbox.TYPES` (+3 values, section 8.3); the column stays `STRING(24)` |
| Unique indexes only on new tables | 7 unique indexes, all declared in the first version of their table (`indexes: [{ unique: true, fields }]`, as `AdminToken`, `BroadcastTarget`): never a per-column `unique: true` (it would add a UNIQUE constraint to `CREATE TABLE`; `test/database.test.js` asserts "no UNIQUE constraint per column" on every new table) |
| Later columns on these tables | nullable or defaulted; **no later unique index** and no column type change on any of the four (a hand-written migration otherwise) |
| Foreign keys | none (repo convention). Logical links: `api_messages.apiKeyId -> api_keys.id`, `api_message_responses.messageId -> api_messages.id`; orphans are removed by housekeeping (section 5) |
| ENUM | none. Closed sets are `STRING` + `validate.isIn`; open sets (`ApiMessage.format`, `errorCode`) have no `isIn` because formats and codes are modules |
| Literals repeated in the model | the model cannot import an engine constant: `lib/database/index.js` loads every model synchronously (`PermissionRule.js` header). A test pins that each repeated set equals the engine constant |
| Index names | Sequelize derives `<table>_<snake_case fields>`; longest is `api_message_responses_message_id_responded_at` (45 characters), under Postgres' 63 **(spike)** |

Dialects: `INTEGER` (the largest `size` is `MAX_UPLOAD` 2000 MB = 2 097 152 000 < 2^31), `BOOLEAN`, `DATE` (timestamptz on Postgres), `JSON` (text on SQLite, `json` on Postgres), `STRING(n)`. No dialect branch anywhere. A unique index treats NULLs as distinct on SQLite and Postgres **(spike on SQLite)**: this is what lets rows without an idempotency key, rows with `waId` not yet assigned, panel rows (`apiKeyId` NULL), vote-less response rows and revoked keys (`nameKey` NULL) coexist. The Postgres path is untested in this repository, as for every table. Raw SQL in housekeeping quotes camelCase identifiers (`"apiKeyId"`), as `pruneOnceBroadcasts` does.

### 0.2 JSON columns are read through model instances

A JSON column read with `raw: true` is a **string** on SQLite and an object on Postgres **(spike)**; instances parse on both. Every reader of these tables uses instances or `row.get({ plain: true })`, never `raw: true` on a query that selects a JSON column (`PermissionRule.js` header, 003 finding B1). Counting and projection queries that select no JSON column (`count`, `attributes: ["apiKeyId", "status", "acceptedAt"]`) may use `raw: true`. Store modules share `asList(value)` (parses a string defensively, returns `[]` on failure). `test/database.test.js` pins that `findAll()` returns arrays for `rights`, `recipients`, `ipAllow`, `seenIps`, `choiceIds`, `plainHttpFrom`.

### 0.3 Spec entity to storage map

| Spec "Key Entity" | Stored in |
|---|---|
| Clé d'API (name, irreversible fingerprint, last 4, rights, policy, quotas, IP restrictions, expiry, state, creation and last use, last IP, seen IPs) | one `api_keys` row; `state` is derived (1.4) |
| Message de l'API (public id, key or source "panel", idempotency key, recipient, format, size, status and times, failure code, WhatsApp id, accepted/expiry times, content only while waiting) | one `api_messages` row; the content is the `payload` column plus the staged file, both erased when the message leaves `queued|sending` |
| Réponse reçue (message, author, choice ids and short labels, time; a poll vote replaces the previous one) | one `api_message_responses` row (ids, author, time); the short labels live in `api_messages.choices` |
| Média en attente | a file under `data/api-media/<publicId>/` plus `api_messages.mediaPath` (section 7) |
| Réglages de l'API (switch, spacing, default quotas, queue expiry, retention, alerts) | switch and plain-HTTP list: the singleton `api_state` row; the rest: 11 panel-only catalog settings (section 8.1) |
| Endpoint, Format | **not stored**: module declarations (`lib/api/endpoints/*`, `lib/messaging/formats/*`) |

### 0.4 Writers and readers

| Table | Writers | Readers |
|---|---|---|
| `api_keys` | configuration columns: the panel service `lib/admin/services/api.js` only (create, update, duplicate, revoke), under `withLock("api-keys")`. Usage columns (`lastUsedAt`, `lastIp`, `seenIps`): the key store `lib/api/keys.js` only, write-behind. Purge: housekeeping | the key store (cached, `api_keys`), the panel service (direct, always fresh), housekeeping |
| `api_messages` | the engine `lib/messaging` (insert at acceptance through `submit`, every status write, receipts, recovery), the API layer for the lazy idempotency release, housekeeping (idempotency release, transient columns, purge) | engine, API layer, panel service (history, detail, usage, test send), housekeeping |
| `api_message_responses` | the reply-capture module (`lib/messaging/replies.js`, hook plugin `plugins/apireplies.js`), housekeeping | API layer (message detail), panel service |
| `api_state` | `lib/utils/apiState.js` only, driven by panel route API-2 | `apiState` (cached in memory), nobody queries it directly |

---

## 1. ApiKey

**Purpose.** A named access for an external program (FR-010 to FR-021). **Table** `api_keys`. **Backup**: excluded (section 6). **Retention**: a revoked key is purged `API_RETENTION_DAYS` after `revokedAt` (U10); an expired, non-revoked key stays (the owner may extend it); at most 50 non-revoked keys (service rule, `409 limit_reached`). **Sensitivity**: `secretHash` and `lookupId` never leave the process in any response, log or audit detail; the plaintext secret is **never stored** anywhere.

### 1.1 Columns

| Column | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `id` | INTEGER PK autoincrement | | panel id, shown in the audit target and in `KeyView.id`; never part of the token |
| `name` | STRING(64) | not null | trimmed, NFKC-normalised (the panel schema's `nfkc` rule), 1-64 code points, no control character (service validates code points, the model `notEmpty`). The case-insensitive uniqueness among non-revoked keys is carried by `nameKey` (1.5) |
| `nameKey` | STRING(128) | **null** | `name.toLowerCase()` while the key is not revoked, **NULL once revoked** (1.5). Wider than `name` because lower-casing can lengthen a string |
| `lookupId` | STRING(16) | not null | the 16 hexadecimal characters after `owbk_` in the token (64 random bits), `is: /^[0-9a-f]{16}$/`. Public identifier used for the in-memory lookup and in debug logs (A4) |
| `secretHash` | STRING(64) | not null | lower-case hex SHA-256 of the 43-character secret **string** as sent (not of its decoded bytes), `is: /^[0-9a-f]{64}$/`. No salt and no KDF: 256 random bits (A4). Also the HMAC key of `ApiMessage.requestHash` (2.4), so it never changes for a row |
| `last4` | STRING(4) | not null | last 4 characters of the token: the only fragment ever displayed, and only in the panel |
| `rights` | JSON | not null, `[]` | array of at most 64 distinct right ids, each `/^[a-z]+(\.[a-z0-9_]+)*$/` and at most 64 characters (`messages.send.text`, `messages.read`, `media.url`, `api.docs`...). The explicit list is the deny-by-default of FR-011: a right added by a new module is in no stored list. A stored id absent from the catalogue (module removed) is ignored at runtime, shown as an orphan, and can only be removed |
| `policyMode` | STRING(8) | not null, `'list'` | `list` \| `known` \| `anyone` (`isIn`). The engine's `evaluatePolicy` input names the third mode `any`; the key store maps `anyone` to it |
| `recipients` | JSON | not null, `[]` | at most 200 distinct normalised JIDs, each `/^[1-9]\d{7,14}@s\.whatsapp\.net$/` or `/^\d{5,25}(-\d+)?@g\.us$/`. A LID is never an entry. Read only in mode `list`; **kept** when the mode changes, so toggling `anyone` and back loses nothing |
| `limitPerMinute` | INTEGER | null | NULL = follow `API_RATE_PER_MINUTE` (8.1). Bounds 1-1000 |
| `limitPerDay` | INTEGER | null | NULL = follow `API_RATE_PER_DAY`. Bounds 1-100 000 |
| `limitPending` | INTEGER | null | NULL = follow `API_MAX_PENDING`. Bounds 1-5000 |
| `ipAllow` | JSON | not null, `[]` | at most **50** (X22) entries in the normalised grammar of A2 (IPv4, IPv4/n, IPv6, IPv6/n; lower-case canonical form; IPv4-mapped unmapped; host bits masked), each at most 50 characters; empty = no restriction. Parsed and compiled once into a `net.BlockList` by the key store; the shared fixture `test/fixtures/api-ip-entries.json` pins the grammar |
| `expiresAt` | DATE | null | NULL = never. Strictly in the future at write time (service rule) |
| `revokedAt` | DATE | null | set once, by the revoke UPDATE (1.6); never cleared (no route, no code path) |
| `lastUsedAt` | DATE | null | last successful authentication, write-behind (1.6) |
| `lastIp` | STRING(45) | null | full effective client address of that request (unmapped, canonical lower case), not the /64 origin key. 45 = longest textual IPv6 |
| `seenIps` | JSON | not null, `[]` | at most **20** distinct origin keys (`trust.originKey`: IPv4 as is, IPv6 grouped by /64, so rotating interface identifiers do not re-alert), oldest dropped. **Empty means "never used"**: the first use of a key never raises `api_key_new_ip` (C6) |
| `version` | INTEGER | not null, `1` | optimistic concurrency of the panel `PUT` (`409 conflict`). Bumped by update and revoke, **never** by the usage columns |
| `createdAt`, `updatedAt` | timestamps | | `updatedAt` reflects configuration changes only: usage writes pass `silent: true` **(spike)** |

### 1.2 Indexes

| Index | Columns | Purpose |
|---|---|---|
| unique `api_keys_lookup_id` | `lookupId` | authentication lookup (also rebuilt as the in-memory `Map<lookupId, KeyRecord>`); makes a duplicate token id impossible |
| unique `api_keys_name_key` | `nameKey` | U11 (1.5) |

No index on `secretHash`: authentication goes through `lookupId`, then a constant-time compare (research C proposed a unique `secretHash`; with a 64-bit `lookupId` unique and a 256-bit secret it would only cost writes). The table holds at most a few dozen live rows; no other index.

### 1.3 Validators (model-level, run by `build().validate()` and `create`)

| Attribute | Rule |
|---|---|
| `policyMode` | `isIn(["list", "known", "anyone"])` |
| `rights`, `recipients`, `ipAllow`, `seenIps` | custom array validators: array, maximum length (64 / 200 / 50 / 20), element type and shape as in 1.1, no duplicate in `rights` |
| `limitPerMinute`, `limitPerDay`, `limitPending` | integer within the bounds of 1.1 when not NULL |
| `lookupId`, `secretHash` | the two regexes of 1.1 |

Cross-field facts the model does not enforce (static `Model.update` runs partial validation): `revokedAt IS NULL <=> nameKey IS NOT NULL`, and `nameKey = name.toLowerCase()` when set. They are service invariants asserted by the test helper listed under "Test obligations".

### 1.4 Status derivation (never stored)

| `status` | Condition (evaluated at read time, first match) |
|---|---|
| `revoked` | `revokedAt IS NOT NULL` |
| `expired` | `expiresAt IS NOT NULL AND expiresAt <= now` |
| `active` | otherwise |

Only `active` authenticates. `revoked` and `expired` are reported (`key_revoked`, `key_expired`) **only after the secret matched** (A2 step 8). An expired, non-revoked key stays in the table so the owner can extend it (C7); which edits the panel accepts on it is fixed in [admin-api.md](contracts/admin-api.md). Its queued messages are `cancelled` (reason `key_expired`) at their next claim attempt (B3 `keyGuard`); a revoked key's are cancelled by the revoke itself (1.6).

### 1.5 Name uniqueness among non-revoked keys (U11)

A partial unique index (`WHERE revokedAt IS NULL`) could carry the rule, but making it case-insensitive needs an expression (`LOWER(name)`) and SQLite's `LOWER()` folds ASCII only; the repository's tests have no helper for partial or expression indexes either. Decision: **a normalised column plus a plain unique index whose NULLs are distinct**. `nameKey` is `name.toLowerCase()` (JavaScript, so non-ASCII letters fold) for a live key and NULL for a revoked one; the unique index `api_keys_name_key` then forbids two live keys with the same folded name and ignores every revoked key, in the database, with no partial index **(spike: duplicate refused, name reusable after the revoke UPDATE)**. A unique violation on `nameKey` is the `409 duplicate` of the service (detection by `UniqueConstraintError` or SQLSTATE `23505`; `isUniqueViolation` in `lib/database/index.js` is module-local and not exported, so the store repeats the test). The service also checks first, under the lock, to give the `fields.name = { code: "duplicate" }` answer without relying on the exception. The 50-key cap is a count under `withLock("api-keys")`.

### 1.6 Write rules

| Operation | Statement shape | Notes |
|---|---|---|
| Create / duplicate | one INSERT under `withLock("api-keys")` after the count (< 50 non-revoked): `nameKey`, `lookupId`, `secretHash`, `last4` from `keyStore.generateSecret()`; `version` 1; usage columns empty. Duplicate copies `rights`, `policyMode`, `recipients`, `limit*`, `ipAllow`, `expiresAt`, never `revokedAt`, `lastUsedAt`, `lastIp`, `seenIps`; name `<name> (n)` truncated so the result stays at most 64 code points | the secret appears in the HTTP answer of that request only (`Cache-Control: no-store`) |
| Update (API-6) | `UPDATE ... SET <explicit configuration columns>, nameKey, version = :v + 1 WHERE id = :id AND version = :v AND revokedAt IS NULL`; 0 rows = `409 conflict` (stale) or `404`/`not_editable` after a re-read | the column list **never** contains `lastUsedAt`, `lastIp`, `seenIps`, `lookupId`, `secretHash`, `last4`, so a panel save cannot overwrite a concurrent usage write |
| Revoke (API-8) | `UPDATE ... SET revokedAt = :now, nameKey = NULL, version = version + 1 WHERE id = :id AND revokedAt IS NULL`; 0 rows = already revoked (idempotent, no audit). Then `settingsCache.invalidate("api_keys")`, then `messaging.cancelForKey(id, "key_revoked")` | one statement clears the name reservation and sets the revocation, so a name is never both reserved and revoked |
| Usage write | `UPDATE ... SET lastUsedAt, lastIp, seenIps WHERE id` with `{ silent: true }`: at most one per key per 60 s, and at once for a new origin | no `version`, no `updatedAt` **(spike)**. The key store keeps the three values in its cached record and mutates them in place |
| Purge | housekeeping step `apiKeys` (section 5), then `settingsCache.invalidate("api_keys")` | |

Every writer of configuration columns calls `settingsCache.invalidate("api_keys")` in the same tick as its commit (X21), so a revocation applies to the very next request (FR-014).

### 1.7 Cache `api_keys`

`settingsCache.getOrLoad("api_keys", loader, 5 * 60 * 1000)` holds `Map<lookupId, KeyRecord>` built from **all** `ApiKey` rows (revoked included, so a revoked key answers `key_revoked` rather than `unauthenticated`) through model instances: `rights` as a `Set`, `ipAllow` compiled to a `BlockList`, `expiresAt` and `revokedAt` as milliseconds, plus the in-place usage fields. The key `api_keys` is added to the header comment of `lib/utils/settingsCache.js` and to the key list in CLAUDE.md. A load failure with no previous value yields null and the pipeline answers `503 unavailable` (fail closed). Restore and the in-process restart already call `settingsCache.clear()` (`restore.js:663`, `botRuntime.js:203`). The panel never reads this cache.

---

## 2. ApiMessage

**Purpose.** One send requested by a key or by the panel test form (FR-033 to FR-038, FR-070 to FR-075). **Table** `api_messages`. **Backup**: excluded (section 6). **Retention**: row and responses removed `API_RETENTION_DAYS` after `acceptedAt` (FR-074). **Sensitivity**: metadata only; the clear text of a message exists in exactly two places, `payload` and the staged file, only while the status is `queued` or `sending` (2.6). Clear recipient here (the panel shows it); masked in logs (FR-073).

### 2.1 Columns

| Column | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `id` | INTEGER PK autoincrement | | internal; ascending = FIFO order of acceptance; the panel's message id (`/admin/api/api/messages/:id`) |
| `publicId` | STRING(32) | not null | `msg_` + 22 base64url characters (128 random bits), `is: /^msg_[A-Za-z0-9_-]{22}$/` (26 characters used). Unguessable (FR-033); the only id the public API shows; also the staging directory name (section 7) |
| `apiKeyId` | INTEGER | null | logical link to `api_keys.id`; **NULL for source `panel`** |
| `source` | STRING(5) | not null, `'api'` | `api` \| `panel` (`isIn`). Invariant: `source = 'api' <=> apiKeyId IS NOT NULL` (object-level validator on create) |
| `idempotencyKey` | STRING(80) | null | the `Idempotency-Key` header, `/^[A-Za-z0-9._:-]{1,80}$/`. NULLed 24 h after `acceptedAt` (2.4) |
| `requestHash` | STRING(64) | null | HMAC-SHA256 hex (key = the `secretHash` bytes of the owning key; data = endpoint id, canonical JSON of the raw body, file SHA-256 or empty; truncated to 32 characters by A5) of the request: answers `idempotency_conflict` without storing content. NULL exactly when `idempotencyKey` is NULL |
| `recipient` | STRING(64) | not null | normalised requested target: `<digits>@s.whatsapp.net` or `<id>@g.us` (same two regexes as `ApiKey.recipients`). Never a LID. If `onWhatsApp` canonicalises the number at send time, the row keeps the requested form |
| `format` | STRING(24) | not null | format module name, `/^[a-z][a-z0-9_]{1,23}$/`. **No `isIn`**: formats are modules |
| `size` | INTEGER | null | bytes of the accepted **input** media file (before conversion); for `text`, `buttons`, `list`: UTF-8 length of `text`; `poll`: of `question`; `location`, `contact`: NULL. Never content |
| `status` | STRING(10) | not null, `'queued'` | `queued sending sent delivered read failed expired cancelled unknown` (`isIn`); machine in 2.5 |
| `errorCode` | STRING(40) | null | stable snake_case reason, an **open set** owned by the engine catalogue (B): `failed`: `not_on_whatsapp chat_disabled not_in_group group_announce_only media_conversion_failed payload_unavailable send_failed whatsapp_rejected`; `cancelled`: `key_revoked key_expired api_disabled`; `unknown`: `interrupted timeout connection_closed`; NULL otherwise (`expired` carries no code) |
| `waId` | STRING(64) | null | the WhatsApp message id, **pre-generated by the engine and written at the claim**, before `sendMessage` (B3): a row stuck in `sending` knows the id WhatsApp saw. Unique when set |
| `requestId` | STRING(16) | null | `X-Request-Id` (16 hex characters) of the accepting request (FR-094); NULL for panel rows |
| `acceptedAt` | DATE | not null | engine clock (`now` injected), not Sequelize's `createdAt` |
| `expiresAt` | DATE | not null | `acceptedAt + API_QUEUE_EXPIRY_MIN` **as set at acceptance** (a later settings change does not move queued rows) |
| `sendingAt` | DATE | null | the claim (T2) |
| `sentAt` | DATE | null | WhatsApp accepted the message (T3) |
| `deliveredAt`, `readAt` | DATE | null | WhatsApp's receipt time (`messageTimestamp`), else the engine's `now`; private chats only |
| `endedAt` | DATE | null | time of the transition into `failed`, `expired`, `cancelled` or `unknown`; cleared when `unknown` is upgraded by a receipt |
| `repliesUntil` | DATE | null | set when the row leaves `sending` (`sentAt` or `endedAt` + `API_REPLY_WINDOW_DAYS`), **only for interactive formats**; reply capture records only while `now <= repliesUntil` |
| `payload` | JSON | null | **transient content** (2.6), at most 128 KiB (validator; real size is bounded far lower by the format limits). NULLed in the same UPDATE that leaves `queued|sending` |
| `choices` | JSON | null | `[{ id, label }]` of an interactive message, kept for the retention period (2.7) |
| `replyData` | JSON | null | poll option digests (2.7); NULLed when `repliesUntil` passes |
| `pollSecret` | STRING(255) | null | `enc:v1:` ciphertext (`lib/utils/secretBox.js`, AES-256-GCM, AAD context `"api-poll:" + publicId`) of the 32-byte poll `messageSecret` as 64 hex characters (about 135 characters stored); NULLed with `replyData`. Never serialised (section 9) |
| `mediaPath` | STRING(255) | null | repo-relative, forward-slash path of the verified source file, `data/api-media/<publicId>/source` (precedent: `Broadcast.mediaPath`). NULLed after the file is deleted |
| `createdAt`, `updatedAt` | timestamps | | |

### 2.2 Indexes

| Index | Columns | Used by |
|---|---|---|
| unique `api_messages_public_id` | `publicId` | `GET /messages/:id`, quote resolution, staging directory check |
| unique `api_messages_api_key_id_idempotency_key` | `apiKeyId`, `idempotencyKey` | replay and conflict (2.4). NULLs distinct: calls without a key and every panel row never collide **(spike)** |
| unique `api_messages_wa_id` | `waId` | receipts (B6) and reply capture (B7) look rows up by the wire id only. Several NULLs allowed before the claim **(spike)** |
| `api_messages_status_accepted_at` | `status`, `acceptedAt` | claim the oldest `queued`, expiry sweep (at most 500 rows), global pending count, pending media bytes |
| `api_messages_api_key_id_status` | `apiKeyId`, `status` | per-key pending count (hot path) |
| `api_messages_api_key_id_accepted_at` | `apiKeyId`, `acceptedAt` | per-day count hydration, history by key, usage |
| `api_messages_accepted_at` | `acceptedAt` | period filter, retention purge |

Hot-path queries and the index each uses: key pending `COUNT(apiKeyId, status IN (queued, sending))`; queue size `COUNT(status IN (queued, sending))`; day quota `COUNT(apiKeyId, acceptedAt >= start of the local day)` counting **every status** (a rejected or cancelled message still consumed the day); pending media bytes `SUM(size) WHERE status IN (queued, sending) AND mediaPath IS NOT NULL`; usage per key per day `SELECT apiKeyId, status, acceptedAt` over an `acceptedAt` range grouped in JavaScript by the local day in `TIMEZONE` (X20, not `DailyStat`).

### 2.3 Identifier and ordering rules

`publicId` is generated by the engine (`crypto.randomBytes(16)` base64url, prefixed); a collision raises a unique violation and is retried once (negligible). FIFO order is `ORDER BY acceptedAt ASC, id ASC`. Source `panel` rows exist only while the API is enabled (the test route answers `409 api_disabled` otherwise), count toward the global queue cap and pacing, and toward no key quota.

### 2.4 Idempotency (FR-034, SC-006)

| Rule | Detail |
|---|---|
| Scope | one key, one `idempotencyKey`, 24 hours from `acceptedAt` (not settable) |
| Hit, same `requestHash` | the stored row is returned (`202`, `Idempotent-Replayed: true`); no validation, no quota, no engine call |
| Hit, other `requestHash` | `409 idempotency_conflict` |
| Race | two identical concurrent requests: the unique index lets one INSERT win; the loser catches the unique violation, re-reads `(apiKeyId, idempotencyKey)` and replays |
| Release | (a) lazily: a hit whose `acceptedAt` is older than 24 h sets both columns of the old row to NULL inside the lock, then inserts the new message; (b) daily: housekeeping `apiIdempotency` NULLs both columns of every row older than 24 h. The fingerprint therefore lives at most about 48 h; the unique index never blocks a legitimate reuse |
| Content | none stored; `requestHash` is keyed per API key, so a database reader cannot confirm guesses of short texts |

### 2.5 Status machine

```
                      INSERT (accept)
                           |
                        queued ---------- expiresAt passed ----------> expired
                        |  |  \------ key revoked/expired, API off --> cancelled
                        |  \--------- not_on_whatsapp, ban, group,
                        |             conversion, missing payload ---> failed
                 claim (CAS)
                        v
                     sending --- definitive pre-network error -------> failed (send_failed)
                        |   \---- timeout, connection closed, boot --> unknown
                        |         recovery, housekeeping net            (never resent)
                sendMessage ok
                        v
                       sent ----- negative ack (status 0) -----------> failed (whatsapp_rejected)
                        |  \
                  receipt 3      receipt 4 / 5
                        v            v
                    delivered ---> read           unknown --- late receipt --> delivered | read
```

Terminal for the **content rule**: every status except `queued` and `sending`. "Ended" (sets `endedAt`): `failed`, `expired`, `cancelled`, `unknown`. Forward-only chain `queued < sending < sent < delivered < read`; the exceptions are `unknown -> delivered|read` (a receipt proves the send; never a resend) and `sent|unknown -> failed` on a negative ack (the one non-monotone move, B3). Groups (`recipient` ends `@g.us`) stop at `sent`: group receipts are never consumed (spec Assumptions).

Every transition is one conditional `UPDATE ... WHERE id = :id AND status = :from [AND ...]`; 0 rows changed means a lost race and is ignored (`broadcaster.js` contract). The `payload`/`choices` writes below are columns of that same statement.

| # | From -> to | Trigger | Guard (WHERE, besides `status`) | Columns set | Erased in the same UPDATE |
|---|---|---|---|---|---|
| T1 | (none) -> `queued` | acceptance (`submit`) | | `publicId apiKeyId source idempotencyKey requestHash recipient format size requestId acceptedAt expiresAt payload mediaPath` | |
| T2 | `queued` -> `sending` | claim, point of no return (B3 step 6) | `expiresAt > :now` | `sendingAt waId` and, for an interactive format, `choices replyData pollSecret` (the message is built in memory first; `waId` is needed to build button ids) | |
| T3 | `sending` -> `sent` | `sendMessage` resolved | | `sentAt`; `repliesUntil` if interactive | `payload` |
| T4 | `queued` -> `expired` | tick sweep | `expiresAt <= :now` (bulk) | `endedAt` | `payload` |
| T5 | `queued` -> `cancelled` | revoke (`key_revoked`), key expired at the claim (`key_expired`), API switched off (`api_disabled`) | `status = 'queued'` (a `sending` row is never cancelled) | `endedAt errorCode` | `payload` |
| T6 | `queued` -> `failed` | pre-send definitive failure | | `endedAt errorCode` | `payload` |
| T7 | `sending` -> `failed` | `send_failed` (4xx while building or uploading) | | `endedAt errorCode` | `payload`, and the reply material `choices replyData pollSecret repliesUntil` (nothing left, nobody can answer) |
| T8 | `sending` -> `unknown` | `timeout`, `connection_closed`, boot `recover()` (`interrupted`), housekeeping net (5) | | `endedAt errorCode`; `repliesUntil` if interactive | `payload` (reply material kept: the message may have left) |
| T9 | `sent` or `unknown` -> `delivered` | receipt status 3, private chat | | `deliveredAt`; from `unknown`: `endedAt = NULL`, `errorCode = NULL` (`sentAt` stays NULL: nothing proves when WhatsApp accepted it) | |
| T10 | `sent`, `delivered` or `unknown` -> `read` | receipt status 4 or 5, private chat | | `readAt`, `deliveredAt = COALESCE(deliveredAt, :t)`; from `unknown` as T9 | |
| T11 | `sent` or `unknown` -> `failed` | asynchronous negative ack `messages.update` status 0 (`whatsapp_rejected`) | | `endedAt errorCode` | reply material as T7 |

After the UPDATE of T3-T8 commits, the engine removes the staging directory, then runs a second `UPDATE mediaPath = NULL` (best effort). A crash between leaves a terminal row holding `mediaPath`: the pointer of a pending deletion, finished by housekeeping step `apiTransient` (section 5).

**Invariants** (asserted by `assertMessageInvariants(row)` (see "Test obligations") after every engine, receipts, replies and retention test):

| # | Invariant |
|---|---|
| I1 | `endedAt IS NOT NULL <=> status IN (failed, expired, cancelled, unknown)` |
| I2 | `payload IS NOT NULL => status IN (queued, sending)` |
| I3 | `status = 'queued' => waId, sendingAt, sentAt, deliveredAt, readAt, endedAt, errorCode, choices, replyData, pollSecret, repliesUntil` are all NULL |
| I4 | `sendingAt IS NOT NULL <=> waId IS NOT NULL` (one UPDATE writes both); `status IN (sent, delivered, read) => sendingAt NOT NULL`; `sent => sentAt NOT NULL`; `delivered => deliveredAt NOT NULL`; `read => readAt NOT NULL` |
| I5 | engine-clock steps are monotone: `acceptedAt <= sendingAt <= sentAt`; `endedAt >= acceptedAt`. `deliveredAt` and `readAt` carry WhatsApp's time and are not compared with them |
| I6 | `mediaPath IS NOT NULL` on a row outside `queued|sending` is a deletion pending, never a live file |
| I7 | reply material (`choices`, `replyData`, `pollSecret`, `repliesUntil`) is non-NULL only for interactive formats in `sending`, `sent`, `delivered`, `read`, `unknown`; `replyData` and `pollSecret` only for `poll`; `repliesUntil` is NULL in `sending` |
| I8 | `source = 'api' <=> apiKeyId IS NOT NULL`; `idempotencyKey IS NULL <=> requestHash IS NULL` |
| I9 | a group recipient never reaches `delivered` or `read` |

The detail timeline `steps[]` is built from the columns: `queued @ acceptedAt`, `sending @ sendingAt`, `sent @ sentAt`, `delivered @ deliveredAt`, `read @ readAt`, then the ended status `@ endedAt`; absent columns are skipped, order by time. An `unknown` upgraded by a receipt therefore shows no `unknown` step.

### 2.6 `payload` (transient content, U2, FR-073)

The only column that holds the clear text of a message, and only while it waits, so that the queue survives a restart (FR-038). It is written once at T1 and erased by T3-T8. It is never copied to logs, audit, error messages, backups or responses; a rebuild after a restart regenerates `waId` and any derived file from it.

```
payload = {
  "v": 1,
  "input": { ...validated format fields, see below },
  "media": null | { "source": "upload" | "url", "mime": "image/jpeg", "ext": "jpg", "size": 123456, "fileName": "invoice.pdf" | null },
  "quote": null | { "publicId": "msg_...", "waId": "3EB0...", "format": "text" }
}
```

- `input` is the fresh object produced by the format's strict validator, **without** the common fields (`to` is the `recipient` column; `quote`, `wait`, the idempotency key are request-level) and without `fileName` (moved to `media.fileName`, already sanitised by `broadcaster.sanitizeName`).
- `media.source` only records how the file arrived. A URL given by the caller is **never stored** (it was fetched during the request, FR-061, and may carry a token); no cookie, header or remote metadata either. `media.mime` and `media.ext` come from the sniff (B10), never from the caller. The file itself is at `mediaPath`.
- `quote` is resolved at acceptance (same key, same chat, row still present and holding a `waId`; otherwise `validation_failed` with `fields.quote = { code: "not_found" }`): a purge of the quoted row between acceptance and send cannot break the send. Nothing of the quoted content exists to store (U13: typed empty shell derived from `format`).
- Field names below are those of the format modules and of the request bodies in [public-api.md](contracts/public-api.md); if the two files differ, public-api.md wins and this table is edited.

| `format` | `input` | Media (`media`, `mediaPath`) | `choices` / `replyData` / `pollSecret` |
|---|---|---|---|
| `text` | `text` (1-4096), `mentions?` (<= 50 normalised PN JIDs, groups only), `linkPreview?` (boolean; true needs right `media.url`) | none | none |
| `image`, `video`, `gif` | `caption?` (<= 1024) | required | none |
| `audio`, `voice`, `sticker` | `{}` | required | none |
| `document` | `caption?` (<= 1024) | required; `media.fileName` | none |
| `location` | `latitude`, `longitude`, `name?`, `address?` (<= 256) | none | none |
| `contact` | `contacts`: 1-10 of `{ displayName, phones` (1-5 normalised digit strings)`, organization?, email? }` | none | none |
| `poll` | `question` (<= 255), `options` (2-12 distinct, <= 100), `multiple` (boolean) | none | `choices`, `replyData`, `pollSecret` |
| `buttons` | `text` (<= 1024), `buttons`: 1-3 of `{ id, label }` | none | `choices` |
| `list` | `text` (<= 1024), `buttonLabel`, `rows`: 1-10 of `{ id, title, description? }` | none | `choices` |

Button and row ids: `/^[A-Za-z0-9_.-]{1,64}$/`, no colon (B2). Payload size is bounded by these limits well under the 128 KiB validator (largest: 10 contact cards).

### 2.7 `choices`, `replyData`, `pollSecret` (U2, U15, X3)

All three are written by T2 (the build output), never at acceptance: a message that never reaches the claim (cancelled, expired, failed before sending) never holds labels, digests or a secret. They are the only content-derived data that survive the terminal erase, and they hold no question, body, caption, description or media.

| Column | Shape | Lifetime |
|---|---|---|
| `choices` | `[{ "id": string, "label": string }]` in **display order**. `label` is 1-100 code points. buttons: `id` = caller id, `label` = button label (<= 20). list: `id` = caller row id, `label` = row **title** (<= 24; the description and the opener label are not kept); order = rows flattened section by section, so the 1-based numbered answer `n` maps to `choices[n-1]`. poll: `id` = the zero-based option index as a decimal string (`"0"`..`"11"`), `label` = the option text (<= 100); order = option order | with the row, until the retention purge (T7/T11 erase it for a message that did not leave) |
| `replyData` | poll only: `{ "v": 1, "multi": boolean, "hashes": ["<64 hex>", ...] }`, one lower-case SHA-256 hex digest of each UTF-8 option name, same order and length as `choices`. NULL for buttons and list (their ids are in `choices`) | NULLed when `repliesUntil` passes (daily, with `pollSecret`) |
| `pollSecret` | `enc:v1:<iv>:<tag>:<ciphertext>` of the 64-hex `messageSecret` (B2, B7). If `panel.key` is lost, new votes cannot be decoded and are silently not recorded (never an error to the caller) | with `replyData` |

Digests are not the text, but a very common option ("Yes") is guessable from its digest; the labels are kept anyway (U2), so U15 adds no exposure.

---

## 3. ApiMessageResponse

**Purpose.** What a recipient chose on an interactive API message (FR-072, US6, US5.4). **Table** `api_message_responses`. **Backup**: excluded. **Retention**: with the message (5). **Writer**: the reply-capture module only.

### 3.1 Columns

| Column | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `id` | INTEGER PK autoincrement | | |
| `messageId` | INTEGER | not null | logical link to `api_messages.id` |
| `kind` | STRING(6) | not null | `choice` (button or list) \| `vote` (poll), `isIn` |
| `author` | STRING(64) | not null | normalised JID of the person. **Private chat: the message's own `recipient`** (the only person who can answer, whatever form WhatsApp reports); **group: the participant**, PN when known, else LID (display only; the panel shortens it) |
| `voterKey` | STRING(64) | null | `kind = 'vote'`: equals `author`; `kind = 'choice'`: NULL. Carries the "one row per voter" rule (3.2) |
| `choiceIds` | JSON | not null, `[]` | array of strings, each an `id` of the message's `choices`. `choice`: exactly one. `vote`: the voter's **current** selection, possibly empty (vote cleared), in option order. An id absent from `choices` is dropped before the write |
| `via` | STRING(6) | null | `tap` \| `number` for `choice` (native button/row click, or a bare number quoting the message); NULL for `vote` |
| `sourceId` | STRING(64) | null | WhatsApp id of the reply or vote message, the redelivery guard |
| `respondedAt` | DATE | not null | the reply's own timestamp (not the receipt time); for a vote the `pollUpdateMessage` timestamp |
| `createdAt`, `updatedAt` | timestamps | | |

### 3.2 Indexes and semantics

| Index | Columns | Purpose |
|---|---|---|
| unique `api_message_responses_message_id_voter_key` | `messageId`, `voterKey` | **last vote replaces**: one row per voter per poll. `choice` rows have `voterKey` NULL and never collide **(spike)** |
| unique `api_message_responses_message_id_source_id` | `messageId`, `sourceId` | a redelivered event cannot double-count |
| `api_message_responses_message_id_responded_at` | `messageId`, `respondedAt` | read a message's responses in order |
| `api_message_responses_responded_at` | `respondedAt` | retention |

Recording rules (invariants of the module, pinned by `test/messaging-replies.test.js`):

- A reply is recorded only if the message exists, `repliesUntil` is set and `now <= repliesUntil` (then it is consumed either way, US6.4-5), and the message holds fewer than **1000** response rows (the extra is ignored and counted in the log; research C over B's 5000).
- `choice`: append-only. One tap, or one numbered answer, is one row. The same person may answer twice; both rows are kept.
- `vote`: `UPDATE ... SET choiceIds, sourceId, respondedAt WHERE messageId = :m AND voterKey = :v AND respondedAt <= :t`; 0 rows changed then `INSERT`; a unique violation on that INSERT means a concurrent or **newer** vote exists, stop (a stale redelivery never overwrites a newer vote). No lock is needed; research C's delete-then-insert under `withLock("api-responses")` is replaced by the unique index.
- A voter seen first as a LID and later as a PN in a group would produce two rows; in private chats `author` is forced to `recipient`, which removes the case there (residual group case: phone checklist, quickstart).
- Totals per option are computed on read (`describeResponses`) by counting the current `choiceIds` of the vote rows (poll) or the ids of the choice rows (buttons, list); labels come from `ApiMessage.choices`. The HTTP shape of the answer is in [public-api.md](contracts/public-api.md) and [admin-api.md](contracts/admin-api.md).

---

## 4. ApiState

**Purpose.** The API's on/off switch and the plain-HTTP network list (X1, U1, FR-001, FR-003). **Table** `api_state`, a singleton. **Backup**: excluded. **Not a catalog setting**: the settings page, `config.env`, the environment and a restore all reach settings without the password; this row has exactly one writer (panel route API-2) behind the step-up.

| Column | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `id` | INTEGER PK | not null, `1` | always 1 (`isIn: [[1]]` rejects another id **(spike)**) |
| `enabled` | BOOLEAN | not null, `false` | the switch. `apiState.isEnabled()` is `row.enabled && config.ADMIN_PANEL` (FR-007: no panel, no API, whatever the row says) |
| `plainHttpFrom` | JSON | not null, `[]` | private networks allowed to call over plain HTTP (U1): at most **20** entries, each at most 50 characters, canonical form of the A2 grammar. Range rule: every entry lies entirely inside RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), ULA `fc00::/7` or CGNAT `100.64.0.0/10` (a loopback, a public range, `0.0.0.0/0` or `::/0` is refused) and is validated by `apiState.setPlainHttpFrom`, not by the model (which cannot import the grammar). Empty by default = strict |
| `createdAt`, `updatedAt` | timestamps | | `updatedAt` is the "changed at" shown by API-1; there is no `changedBy` (the audit row records the actor) |

- **No row is created by a read.** `load()` treats absence as `{ enabled: false, plainHttpFrom: [] }`; the first `set` or `setPlainHttpFrom` upserts `id: 1`. `test/admin-security.test.js` ("no GET writes") would fail otherwise.
- Written as: `set(enabled)` persists, then memory, then listeners; a failed write keeps memory unchanged. Widening `plainHttpFrom` (an entry not covered by the old list) and `enabled: true` need the step-up; narrowing and `enabled: false` do not ([admin-api.md](contracts/admin-api.md)).
- A restore never touches the table (section 6): it cannot turn the API on, cannot widen the network list.

---

## 5. Retention and housekeeping

Five steps appended to `housekeeping.run()` (each through `step()`, so one failure never stops the others; batches of `LIMITS.BATCH` = 500; time from the injected clock; retention read from `config` at run time). The daily job runs with or without the panel, so FR-074 holds with `ADMIN_PANEL=false`. When the API was never used all five are index-only no-ops. New `LIMITS`: `API_IDEMPOTENCY_MS` = 24 h, `API_SENDING_STUCK_MS` = 15 min.

| Step | Statement | Why |
|---|---|---|
| `apiIdempotency` | `idempotencyKey = NULL, requestHash = NULL` where either is set and `acceptedAt < now - 24 h` | FR-034 window; releases the unique pair |
| `apiTransient` | in this order: (a) safety net: `sending` rows with `sendingAt < now - 15 min` become `unknown / interrupted` through T8 (boot `recover()` is the only other path out of `sending`, and a stuck row would inflate the per-key and global pending counts until the next restart; the settle UPDATE is `WHERE status = 'sending'`, so a late real settle is a harmless no-op, and a send is never repeated); (b) `payload = NULL` where `status NOT IN (queued, sending)` (belt and braces, I2); (c) for every row outside `queued|sending` still holding `mediaPath`: delete the directory, then `mediaPath = NULL`; (d) `replyData = NULL, pollSecret = NULL` where `repliesUntil < now` | FR-073, FR-075, FR-038 |
| `apiMessages` | batches of ids with `acceptedAt < cutoff` and `status NOT IN (queued, sending)`: responses of those ids first, then the messages; then orphan responses (`messageId NOT IN (SELECT "id" FROM "api_messages")` via `DATABASE.literal`, the `pruneOnceBroadcasts` pattern) and responses with `respondedAt < cutoff`. `cutoff = min(now - API_RETENTION_DAYS, start of the current local day in TIMEZONE)`: with retention >= 1 day the second term only matters on a 25-hour day and guarantees that today's rows, which feed the day quota (A5), are never purged | FR-074, US3.6 |
| `apiKeys` | delete revoked keys with `revokedAt < now - API_RETENTION_DAYS`, then `settingsCache.invalidate("api_keys")`. Their messages were all accepted before `revokedAt`, so step `apiMessages` already removed them. Expired, non-revoked keys stay | U10 |
| `apiMedia` | `messaging.sweepMedia({ now })` (resolved lazily like `broadcaster.sweepMedia`, `optionalRequire("../messaging")`): remove each `data/api-media/<name>/` whose `<name>` is not the `publicId` of a `queued` or `sending` row, only when the directory is older than 1 h (grace for an acceptance in progress); also run once at engine `start()`. Reports `{ removed, freedBytes }`. Runs outside any lock the engine takes (B names the same function `sweepOrphans`) | FR-075 orphan sweep |

Order matters: `apiTransient` before `apiMessages` (nothing purged still holds a file), `apiMessages` before `apiKeys` (a message never outlives its key's row except by logical link), `apiMedia` last.

| Data | Lifetime | Mechanism |
|---|---|---|
| `payload`, staged file | until the row leaves `queued|sending` | same UPDATE / after commit; safety nets above |
| `idempotencyKey`, `requestHash` | 24 h from `acceptedAt` | lazy release + `apiIdempotency` |
| `replyData`, `pollSecret` | until `repliesUntil` | `apiTransient` (d) |
| `choices`, response rows | with the message row | `apiMessages` |
| message row | `API_RETENTION_DAYS` (default 30) from `acceptedAt` | `apiMessages` |
| revoked key | `API_RETENTION_DAYS` from `revokedAt` | `apiKeys`; the audit log (180 days) keeps the trace |
| `api_state` | forever | |
| alert slots `api_origin_blocked:<origin>`, `api_key_new_ip:<keyId>:<ip>`, `api_paused` | 24 h | `pruneAlertStates` extended from `login_blocked:` to the three prefixes (the longest key, about 70 characters, fits `AlertState.key` STRING(96)) |

A response written for a message about to be purged is harmless: capture looks the message up first and ignores a missing one. `API_REPLY_WINDOW_DAYS <= API_RETENTION_DAYS` is a cross validator of the catalog (8.1), so a reply window never outlives the history it needs.

---

## 6. Backup and restore (U9, FR-076)

All four models go to `EXCLUDED_MODELS` of `lib/admin/backup/format.js` (7 -> 11 entries); `MODELS` stays at 26, `AUTO_INCREMENT_MODELS` untouched. `test/backup.test.js` ("each file of lib/database/models/ is in exactly one of MODELS and EXCLUDED_MODELS") forces the choice. `restore.js` destroys only `MODELS`, so a restore leaves the four tables exactly as they are.

| Reason | Effect |
|---|---|
| An older archive would flip `revokedAt` back to NULL | a revoked key is never resurrected (same reason as `AuditLog`, `AdminSession`) |
| An archive of `api_keys` is a copy of working credentials | restoring it on a clone or staging installation would activate the same keys against another number; the hashes themselves cannot be cracked offline, so the risk is cloning |
| `api_messages` carries queued sends and idempotency keys | a restore would replay sends that expired or already left (FR-037, FR-038, SC-006) |
| `api_state.enabled` is per installation | a restore never switches the API on (FR-001) |

Consequences: after moving to a new server the owner recreates the keys (quickstart); a restore does change the `API_*` limits that live in `SettingOverride` (exported) but not the switch, the network list or the keys. The staged directory `data/api-media/` is never exported either: `export.js` reads `data/broadcast-media/` only. No `backup.model_*` panel key is needed (those exist for exported models only). `backupKit.seedExcluded` gains one row in each table.

---

## 7. Staged media (B10, FR-061, FR-075)

Root `data/api-media/` (gitignored with `data/`), one directory per message named by `publicId` (validated against `^msg_[A-Za-z0-9_-]{22}$` before any path is built, then `safeFs.assertInside`), mode 0700, files 0600. This replaces research B's `data/api-outbox/<id>/` (B stored `payload.json` there; since U2/X3 the content lives in `ApiMessage.payload`, so the directory holds media only; research C's `api-media` name is kept, as the sibling of `broadcast-media`).

| File | Content | Written by |
|---|---|---|
| `source` | the verified media exactly as received or downloaded (fixed name, no caller-controlled name on disk; the document name is `media.fileName` in the payload) | stream A: the pipeline streams the upload or the URL download into `data/tmp/api/<random>.part` under the byte cap, sniffs it, then `ctx.file.adopt(dest)` renames it here (same filesystem). Panel test form: copied from `data/admin-uploads` (purpose `api`) |
| `prepared.<ext>` | the output of `prepare` (voice to Ogg/Opus, GIF to MP4, sticker to WebP) | the engine, at send time, while the row is still `queued` (B3 step 5) |

`mediaPath` = `data/api-media/<publicId>/source` is written at T1.

| Event | Directory |
|---|---|
| Acceptance refused after `adopt` (quota reserve fails, INSERT fails) | removed by the pipeline's `finally` (A6) |
| Crash between `adopt` and the INSERT | orphan, removed by the daily sweep (older than 1 h, no `queued|sending` row) |
| T3-T8 committed | `fs.rm(dir, { recursive, force })` after the commit, then `mediaPath = NULL` |
| Boot `recover()` | removes the directory of every row it moves to `unknown` |
| A `queued` row whose directory vanished | failed as `payload_unavailable` at its next pick; never sent without its media (the `media_unavailable` rule of `broadcaster.js`) |
| Upload parts under `data/tmp/api/` | swept at boot with the whole `data/tmp` by `housekeeping.bootSweep` |
| Type mismatch, size overflow, conversion failure | file deleted at once (`media_type_mismatch`, `media_too_large`) or the row failed (`media_conversion_failed`) and the directory removed |

Disk bound: `SUM(size)` of media rows in `queued|sending` is what A's `pendingMediaBytes()` reads (2.2); with the in-flight uploads it must stay under `2 * MAX_UPLOAD`.

---

## 8. Settings, cache and alerts

### 8.1 Settings that parametrise the data (X2)

Eleven new `settingsCatalog.js` entries, all `env: null` (panel-only, like `BROADCAST_DELAY_MS` and the `ALERT_*`), so `config.env.example` and `settings-example.test.js` are untouched; panel strings `settings.<KEY>.label` and `.desc` x 11 in `specs/004-messaging-api/i18n/panel-api-server.json`. Catalog count 101 -> **112** (78 editable, 34 read-only, 22 secrets, 5 restart); research C counted ten entries and 111, X2 adds `ALERT_API_PAUSED`.

| Key | Type, default | Rule | Theme, effect | Data it parametrises |
|---|---|---|---|---|
| `SEND_MIN_SPACING_MS` | int ms, 2000 | `int(2000, 600000)` (up only, FR-035) | limits, immediate | pacing gate shared with the broadcaster; seeds from `max(sendingAt)` |
| `API_RATE_PER_MINUTE` | int, 30 | `int(1, 1000)` | limits, immediate | `limitPerMinute ?? this` |
| `API_RATE_PER_DAY` | int, 1000 | `int(1, 100000)` | limits, immediate | `limitPerDay ?? this` |
| `API_MAX_PENDING` | int, 100 | `int(1, 5000)` | limits, immediate | `limitPending ?? this` |
| `API_QUEUE_MAX` | int, 500 | `int(1, 5000)` | limits, immediate | cap of `COUNT(status IN (queued, sending))` at acceptance |
| `API_QUEUE_EXPIRY_MIN` | int minutes, 10 | `int(1, 1440)` | limits, immediate | snapshot into `expiresAt` at acceptance |
| `API_RETENTION_DAYS` | int days, 30 | `int(1, 365)` | limits, immediate | `apiMessages` cutoff, `apiKeys` cutoff |
| `API_REPLY_WINDOW_DAYS` | int days, 7 | `int(1, 30)` | limits, immediate | snapshot into `repliesUntil` |
| `ALERT_API_ORIGIN_BLOCKED` | bool, true | | alerts, immediate | alert type `api_origin_blocked` |
| `ALERT_API_KEY_NEW_IP` | bool, **false** | | alerts, immediate | alert type `api_key_new_ip`; the `alert(key)` helper hard-codes `default: true`, so this entry takes a default argument or is built with `entry()` |
| `ALERT_API_PAUSED` | bool, true | | alerts, immediate | alert type `api_paused` (U5, U12) |

One cross validator beside `responderDelays`: `API_REPLY_WINDOW_DAYS <= API_RETENTION_DAYS` (`bound_conflict`). Capture-site rule: every reader takes `config.X` at call time; values copied into a row (`expiresAt`, `repliesUntil`) are snapshots, so a changed setting applies to the next message and never to rows already queued; `test/capture-sites.test.js` gets one block and a scan that `lib/api/**`, `lib/messaging/**` and `lib/utils/apiState.js` have no top-level `= config.`. The switch (`ApiState.enabled`) and `plainHttpFrom` are deliberately **not** settings (section 4).

### 8.2 Cache keys

| `settingsCache` key | Content | Invalidated by |
|---|---|---|
| `api_keys` (new, X21) | 1.7 | every writer of `api_keys` configuration columns and the purge; `clear()` on restore and in-process restart |

`ApiState` has its own in-memory cache inside `lib/utils/apiState.js` (loaded at boot, `onChange` listeners), not a `settingsCache` key.

### 8.3 Knock-on edits to existing data code

| File | Edit |
|---|---|
| `lib/database/models/AlertOutbox.js` | `TYPES` += `api_origin_blocked`, `api_key_new_ip`, `api_paused` (`isIn` list and column comment; longest 18 characters, fits `STRING(24)`; no schema change) |
| `lib/utils/alerts.js` | three types, slots `api_origin_blocked:<origin>` (15 min), `api_key_new_ip:<keyId>:<ip>` (24 h, X9), `api_paused` (15 min), payloads rebuilt field by field |
| `lib/utils/housekeeping.js` | five steps of section 5; `pruneAlertStates` prefixes |
| `lib/admin/backup/format.js` | `EXCLUDED_MODELS` += the four models |
| `lib/utils/settingsCatalog.js`, `lib/utils/settingsCache.js` (comment), `CLAUDE.md` ("101 entries", the 14-table sentence, cache key list) | sections 8.1-8.2 |

---

## 9. What is NOT stored, and what is never serialised

| Not stored | Where it lives instead |
|---|---|
| The key secret (plaintext) | nowhere: shown once in the create/duplicate answer; `secretHash`, `last4` only |
| Text, caption, media, contact cards, poll question, button/list body and descriptions, location after the send | `payload` and the staged file only while `queued|sending`; never afterwards |
| A media URL, remote headers, the caller's filename on disk | nothing (fetched during the request; `media.fileName` is sanitised) |
| Quoted content | nothing (typed empty shell derived from the stored `format`, U13) |
| The idempotent response body | recomputed from the row on a replay |
| Queue position, queue size, per-minute counters | memory (derived or sliding window); the day count is recomputed from rows at start |
| Origin throttle counters | memory only (A2); a restart resets the budget |
| Rights catalogue, endpoint and format declarations | modules |
| `ApiKey.status`, `kind` (private/group), `toName`, usage per day | derived at read time |

Columns **never** present in any HTTP response, audit detail, log line or error body (the leak scan listed under "Test obligations" enumerates them): `ApiKey.secretHash`, `lookupId` (debug log field only), `seenIps` (its length may be shown as `seenIpCount`), `ApiMessage.pollSecret`, `payload`, `replyData`, `mediaPath`, `requestHash`, `idempotencyKey`. `recipient` appears in the panel history and detail and in the public API to the owning key only, masked in logs. The public API and the panel serialise through explicit field lists (`MessageRow`, `MessageDetail`, `KeyView`, the public message view), never `row.get()` or `toJSON()`.

---

## 10. Concurrency summary

| Concern | Mechanism |
|---|---|
| Single SQLite connection, multi-statement writes | `withLock("api-keys")` (count + insert of keys), `withLock("api-outbox")` (admission count + insert, cancellations); nothing else needs a lock because every other write is a single conditional statement |
| Claim vs cancel/expire | CAS `WHERE status = 'queued'` (T2 vs T4/T5); the loser changes 0 rows and drops out |
| Two identical idempotent requests | unique `(apiKeyId, idempotencyKey)` |
| Two concurrent votes by one voter | unique `(messageId, voterKey)` + `respondedAt <= :t` guard |
| Two panel saves of one key | `version` CAS; usage columns are outside the column list and written `silent` |
| Redelivered reply event | unique `(messageId, sourceId)` |
| Housekeeping vs engine | housekeeping touches only terminal rows, except the 15-minute safety net on `sending`; the media sweep takes no engine lock |

---

## Test obligations

| Test file | Pins |
|---|---|
| `test/database.test.js` (edit) | a `FEATURE_004_TABLES` block next to `FEATURE_003_TABLES`: the 4 tables created (`14 + 18 + 1 + 4` created tables), exact columns, primary keys, the 7 unique and 6 non-unique indexes, **no per-column UNIQUE**, no `DataTypes.ENUM`, model defined under its file name, NOT NULL / default of every column in 1.1, 2.1, 3.1, 4; index names <= 63 characters; a second `sync()` is a no-op; a database predating the feature only gains the 4 tables (0 existing table altered, no row lost); `findAll()` returns arrays for every JSON column (0.2); the NULL-distinct pairs: two rows with `(apiKeyId, idempotencyKey)` both NULL, two panel rows with the same key, two rows with `waId` NULL, two choice responses with `voterKey` NULL, two revoked keys with `nameKey` NULL are accepted, a duplicate non-NULL pair is refused; validators (`status`, `source`, `policyMode`, `kind`, `via` `isIn`; `ApiState.id` only 1; array caps and element shapes of `rights`, `recipients`, `ipAllow`, `seenIps`, `plainHttpFrom`; `publicId`, `lookupId`, `secretHash` regexes) |
| `test/api-data.test.js` (new) | key name rules: case-insensitive duplicate refused while live, reusable after the revoke UPDATE, duplicate suffix fits 64 code points; revoke UPDATE sets `revokedAt`, clears `nameKey`, bumps `version`, is idempotent; `PUT` CAS on `version` (stale = 0 rows) and its column list excludes the usage columns; a usage write with `silent` leaves `version` and `updatedAt` unchanged; the 50-key cap; `status` derivation matrix (revoked over expired over active, expiry at the boundary); idempotency: replay, conflict, concurrent duplicate raising the unique violation, release after 24 h; `waId` unique; the transition table T1-T11 as conditional UPDATEs with their erased columns, plus invariants I1-I9 through `assertMessageInvariants`; response rules (choice append-only, vote replace, stale vote ignored, redelivery guard, 1000-row cap, unknown ids dropped, private `author` forced to `recipient`) |
| `test/helpers/apiInvariants.js` (new) | `assertMessageInvariants(row)` (I1-I9) and `assertKeyInvariants(row)` (`revokedAt IS NULL <=> nameKey IS NOT NULL`, `nameKey = name.toLowerCase()`), called by `messaging-outbox`, `messaging-receipts`, `messaging-replies`, `api-retention` and `admin-api` tests after every scenario |
| `test/api-state.test.js` (new) | absence of a row = disabled with an empty list; a read creates no row; `set` persists, then memory, then listeners; a failed write leaves memory unchanged; `ADMIN_PANEL=false` forces `isEnabled()` false; `plainHttpFrom` refuses a loopback, a public range, `0.0.0.0/0`, more than 20 entries, and canonicalises; widening detection |
| `test/api-retention.test.js` (new) | the five housekeeping steps on the fake clock: idempotency release at 24 h, the 15-minute `sending` net first (becomes `unknown / interrupted`, a late settle is a no-op), belt-and-braces `payload` wipe, `replyData`/`pollSecret` NULLed at `repliesUntil`, message and response purge at `API_RETENTION_DAYS` in batches with orphan responses, today's rows never purged on a 25-hour day, revoked key purge after messages with `api_keys` invalidated, expired key kept, `queued|sending` never purged, media sweep (orphan older than 1 h removed, younger kept, active kept), a failing step does not stop the others |
| `test/backup.test.js` + `test/helpers/backupKit.js` (edit) | the four models are in `EXCLUDED_MODELS` and not in `MODELS` (26 stays); `seedExcluded` gets one row in each; an export carries none of them; a restore leaves them byte-for-byte unchanged, never flips `revokedAt` back, never sets `enabled`; `data/api-media` is absent from every archive |
| `test/housekeeping.test.js`, `test/alerts.test.js`, `test/admin-alerts.test.js` (edit) | the five new report keys; `AlertOutbox.TYPES` accepts the three new types and rejects others; slots pruned after 24 h |
| `test/settings-store.test.js`, `test/admin-settings.test.js`, `test/admin-i18n.test.js`, `test/config-accessors.test.js`, `test/settings-example.test.js` (edit) | 112 entries, 78 editable, 34 read-only; the eleven keys, bounds, defaults (`ALERT_API_KEY_NEW_IP` false), `env: null` accepted without a `config.env.example` line; `API_REPLY_WINDOW_DAYS <= API_RETENTION_DAYS` validator; `settings.<KEY>.label/.desc` in both panel catalogs |
| `test/capture-sites.test.js` (edit) | a changed quota, expiry, reply window or spacing applies to the next request or message and not to queued rows; static scan: no top-level `= config.` in `lib/api/**`, `lib/messaging/**`, `lib/utils/apiState.js` |
| `test/admin-security.test.js` (edit) | no GET of the API area writes any of the four tables (`ApiState` row not created by a read) |
| `test/api-security.test.js` (A10) and the SC-003 leak scan | after the full scenario set, no text/JSON column of the four tables outside `ApiMessage.payload` (rows in `queued|sending` only), `ApiMessage.choices` and `ApiKey.name`/`recipients` contains the secret, a canary text, caption, file name, question, body or list description; no response, audit detail or log line contains a column of section 9's never-serialised list; `payload` is NULL on every row outside `queued|sending` |
| `test/hooks.test.js`, `test/boot.test.js` (edit) | not data, but required by the same change: hook order rows for `apireplies.js`; the `messaging` engine and `apiState` collaborator in the boot sequence |
