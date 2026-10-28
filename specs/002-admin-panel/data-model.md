# Phase 1: data model

Feature `002-admin-panel`. Inputs: [spec.md](spec.md), [research.md](research.md) (authoritative: user decisions U1-U19, arbitration R1-R5, C1), the stream files `research/{a,b,c,d}-*.md`, the 18 existing models in `lib/database/models/`, and the house style of [001's data model](../001-audit-fix-commands/data-model.md). Where a stream file disagrees with `research.md` or with another stream, section 7 lists the choice that was made.

Sequelize 6, SQLite (default, `DATABASE_URL` or `./database.db`) or Postgres (`DATABASE_URL` containing `postgres`). Nothing here has been implemented yet; field lists are the contract for the model files.

## 0. Compliance, conventions, dialects

### 0.1 Additive-sync compliance

`lib/database/index.js#sync()` is additive: it creates missing tables with their indexes, adds missing nullable/defaulted columns, never alters or drops a column, and a new unique index on an existing table is not allowed (CLAUDE.md, "Database").

- **14 new tables**, all created by `Model.sync()` (step 1 of `sync()`), together with their composite primary keys and unique indexes.
- **0 existing table altered**: no column added, no index added, no existing model file touched. Every existing table the panel uses (section 3) is used as it is; nothing in this feature needs a new column on `groups`, `warns`, `banned_chats`, `reminders`, etc.
- The unique indexes (`admin_tokens.tokenHash`, `broadcast_runs (broadcastId, dueAt)`, `broadcast_targets (runId, chatJid)`) and the composite primary keys (`command_states`, `text_overrides`, `daily_stats`) exist only on tables created by this feature, which is the one case the rule allows.
- From the first release that contains these tables, the rule applies to them too: later columns must be nullable or defaulted, no later unique index, no column type change. Widths are therefore chosen generously now (JIDs and free identifiers use the default `STRING` = 255).

### 0.2 Conventions

| Topic | Rule |
|---|---|
| File and model name | One file per model in `lib/database/models/<ModelName>.js`, exporting `(sequelize) => Model`; auto-loaded under the file name (`lib/database/index.js`). `sequelize.define("<ModelName>", attrs, { tableName, timestamps })`. |
| Table names | `snake_case`, plural (`admin_accounts`, `daily_stats`). The three singular legacy names (`anti_delete`, `view_once`, `auto_responder`) are not touched. |
| Columns | camelCase, as every existing model. `createdAt`/`updatedAt` are on unless stated (`DailyStat`: none, `AuditLog`: `createdAt` only). |
| Foreign keys | None (repo convention; none of the 18 models has one). Cascades are done by services, children first, in one transaction. |
| Enumerations | `STRING` with `validate: { isIn: [...] }` (as `Reminder.status`), never `DataTypes.ENUM`: a Postgres enum type cannot be extended by an additive `sync()` (`GroupRole.role` is the only existing ENUM and is not changed). |
| Dates | `DATE`, UTC `Date` objects. "Day" buckets (`DailyStat.day`) are the local date in `config.TIMEZONE`. |
| Secrets | Never in clear in the database: setting secrets are encrypted (`enc:v1:`), session ids and one-time tokens are stored as SHA-256 hashes, the password as a scrypt hash. |
| Identifiers in raw SQL | Quote every identifier (`"leaseUntil"`): Sequelize creates camelCase columns, which Postgres folds to lower case when unquoted. Prefer model methods (`update`, `destroy`, `Op`, `literal('"count" + 1')`) over raw SQL; the only raw statement planned is the `daily_stats` upsert (research C8, written out in 1.8). |
| Reserved-looking names | Columns named `key`, `value`, `count`, `kind`, `scope`, `position`, `action`, `result`, `text` are fine because Sequelize quotes them; keep them quoted in any raw SQL. |
| Index names | Default Sequelize names (`<table>_<field>_<field>`); the longest planned is 39 characters, under Postgres' 63 limit. |

### 0.3 Dialect notes

| Aspect | SQLite | Postgres |
|---|---|---|
| `DATE` | text `YYYY-MM-DD HH:MM:SS.SSS +00:00` (ms) | `timestamptz` |
| `BOOLEAN` | 0/1 (Sequelize converts) | native |
| `JSON` (`Broadcast.targets`) | text, parsed by Sequelize | `json`; never queried into |
| Auto-increment after a restore with explicit ids | continues after the max id | **sequences do not follow**: restore runs `setval(pg_get_serial_sequence('"t"','id'), COALESCE(MAX(id),1), MAX(id) IS NOT NULL)` on each auto-increment table (list in 4.3) |
| Upsert | `INSERT ... ON CONFLICT (...) DO UPDATE` (SQLite >= 3.24) | same syntax |
| Compare-and-swap | `UPDATE ... WHERE status = :from` returns affected rows (`Model.update` gives `[n]`) | same |
| Concurrent transactions | `:memory:` has ONE connection: see 0.4. A file database opens one connection per transaction, so concurrent writers may meet `SQLITE_BUSY` | real concurrency, row locks |
| Cross-dialect backup | rows exported through model instances (`get({plain:true})`), never `raw:true` (4.3) | same |

The Postgres path is untested in this repository (CLAUDE.md); the cross-dialect guarantees above are covered by an opt-in test (`TEST_POSTGRES_URL`, research C6).

### 0.4 Test caveat: in-memory SQLite

On `:memory:` SQLite two concurrent `DATABASE.transaction()` calls fail (`cannot rollback - no transaction is active`, spike S4). Plain single-statement CAS updates are fine (5 racers give `[1,0,0,0,0]`). Rule for every multi-statement write of this feature (broadcast creation and materialization, economy adjustment, account/token consumption, restore apply, backup read snapshot): run it behind one **in-process mutex** (same idea as `economy.withLock` and `scheduler.scheduleChain`), then open the transaction. CAS claims (target claim, alert rate-limit slot, setting version check) need no transaction and no mutex.

### 0.5 Spec entity to storage map

| Spec "Key Entity" | Stored in |
|---|---|
| Compte administrateur | `AdminAccount` |
| Session d'administration | `AdminSession` |
| Lien de configuration initiale / de réinitialisation | `AdminToken` |
| Réglage | `SettingOverride` (value + version) + the code catalog (4.1) |
| État de commande | `CommandState` |
| Diffusion | `Broadcast` + `BroadcastRun` + `BroadcastTarget` |
| Texte personnalisé | `TextOverride` |
| Alerte | `AlertState` + `AlertOutbox` (+ `ALERT_*` settings) |
| Sauvegarde | archive file (4.3), no table |
| Réglages de groupe | existing tables (section 3) |
| Entrée d'historique d'administration | `AuditLog` |
| Statistique d'usage | `DailyStat` |

Relationships between the new tables (logical, no FK):

```text
AdminAccount (1 row, id=1)  <--  AdminSession (<= 10 live rows)        AdminToken (setup | reset, <= 1 live of each kind)

Broadcast 1 ---- N BroadcastRun 1 ---- N BroadcastTarget ----> KnownChat.jid (validated at create/edit, not a FK)
   |  text/media/targets/rule        |  one per occurrence        |  one per destination, UNIQUE (runId, chatJid)
   |  UNIQUE (broadcastId, dueAt) on BroadcastRun

CommandState.command  --> registry entry name        CommandState.scope --> "*" | group JID
TextOverride.key      --> lang/en.json + lang/fr.json key
SettingOverride.key   --> settings catalog entry (source "env")
DailyStat.subject     --> command name | group JID | ""
AlertState.key        --> alert rate-limit slot       AlertOutbox.type --> alert type (toggle ALERT_*)
AuditLog              --> free-standing history (target is free text)
KnownChat             --> feeds the broadcast destination picker and the "ancien groupe" list
```

---

## 1. New models

Each section gives: purpose, table, fields, indexes, relationships, retention, backup membership, writer module, cache and invalidation, sensitivity. Module names follow R1 (`lib/admin/` for what only exists to serve the panel; engines that must run when `ADMIN_PANEL=false` stay in `lib/utils/` or `lib/core/`).

### 1.1 AdminAccount

**Purpose.** The single administrator (FR-002).
**Table** `admin_accounts`. **Backup**: no (FR-051: "le compte administrateur du panel n'y figure jamais"). **Retention**: forever. **Writers**: `lib/admin/auth/*` (setup and reset consumption, login, preference change), `tools/admin-reset.js` does not write here (it only issues a token). **Cache**: none (login reads the row; `uiLang`/`theme` are returned by `GET /admin/api/session`). **Sensitivity**: `passwordHash` is never serialized in any response or log.

| Field | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `id` | INTEGER, PK, **no** autoIncrement | not null | always `1`, inserted explicitly; the primary key makes a second account impossible, also under a race between two setup requests (the loser fails on the PK) |
| `passwordHash` | STRING(255) | not null | `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>`, N=2^15, r=8, p=3, 16-byte salt, 32-byte key; self-describing so a later `needsRehash()` or a switch to `crypto.argon2` is possible; verified with `timingSafeEqual`; about 90 characters |
| `uiLang` | STRING(2) | default `fr` | `en` or `fr` (FR-037, independent of `BOT_LANG`) |
| `theme` | STRING(8) | default `auto` | `auto`, `light`, `dark` (FR-041) |
| `lastLoginAt` | DATE | null | set at each successful login (Key Entity: "dernière connexion") |
| `createdAt` / `updatedAt` | timestamps | | `createdAt` = account creation date (Key Entity) |

Password policy (enforced in code, not in the schema): "au moins 12 caractères" (FR-004), NFKC-normalized, 12 to 256 code points, no all-same-character or trivial sequence, small built-in denylist. A password change requires the current password and deletes every other `AdminSession`. At most one scrypt hash in flight (queue of 4, then HTTP 429) because each costs about 32 MiB.

### 1.2 AdminSession

**Purpose.** An open admin access after login (FR-006).
**Table** `admin_sessions`. **Backup**: no. **Writers**: `lib/admin/auth/sessions.js`. **Cache**: in-process `Map<idHash, session>` with a 60 s TTL (not `settingsCache`), updated on logout and password change. **Sensitivity**: only the SHA-256 of the cookie value is stored, so a database leak or copy yields no usable cookie.

| Field | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `idHash` | STRING(64), PK | not null | hex SHA-256 of the 32-byte random cookie value (base64url in the cookie `__Host-owb_sid`, or `owb_sid` on plain HTTP) |
| `csrfSecret` | STRING(64) | not null | per-session CSRF token returned by `GET /admin/api/session`; compared with `timingSafeEqual` against `X-CSRF-Token`; useless without the session cookie |
| `origin` | STRING(64) | not null | client address key at login after trust-proxy resolution (IPv4, or IPv6 grouped by /64) |
| `userAgent` | STRING(200) | null | truncated, display only |
| `lastSeenAt` | DATE | not null | sliding idle clock; write-behind, at most one write per 60 s per session |
| `createdAt` / `updatedAt` | timestamps | | `createdAt` = login time = anchor of the absolute cap |

**Expiry rules** (FR-006, U11): idle expiry when `now - lastSeenAt > 24 h`; absolute expiry when `now - createdAt > 7 days`, whatever the activity; deleted at explicit logout. Routes flagged `touch:false` (SSE heartbeats, 2 s state/log polling) never extend `lastSeenAt`, otherwise a forgotten open tab would never expire. At most 10 live sessions: creating the 11th deletes the oldest. A new id is issued at every login, setup and password change (rotation); a pre-login cookie is discarded.
**Indexes**: PK, plus `lastSeenAt` (sweep). The table never holds more than 10 live rows.
**Retention**: expired rows (idle or absolute) are deleted when presented and by an hourly sweep (the sweep timer is `unref`'d and started by `start()`, not at `require` time). See 1.15 for the corrected rule (research C1 only had the 24 h idle clause).
**Survives a restart**: yes (DB-backed), so the legacy `process.exit(0)` restart, a PM2 memory restart, and restore-then-restart return the admin to the dashboard. When the database is unreachable, cached sessions keep working and uncached ones get `503 db_unavailable` (not 401).

### 1.3 AdminToken

**Purpose.** One-time first-run setup link and password-reset link (FR-003, FR-007).
**Table** `admin_tokens`. **Backup**: no. **Writers**: `lib/admin/auth/tokens.js` (issue at boot when no account exists; consume), `tools/admin-reset.js` and the `data/admin-reset` marker file (issue a `reset`). **Cache**: none. **Sensitivity**: only the hash is stored; the clear token is printed once to the console with the original `process.stdout.write` and registered with the log redactor, never logged through pino.

| Field | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `id` | INTEGER, PK, autoIncrement | not null | |
| `kind` | STRING(8) | not null | `setup` or `reset` (`isIn`) |
| `tokenHash` | STRING(64) | not null | hex SHA-256 of 32 random bytes (base64url in the link); **UNIQUE** |
| `expiresAt` | DATE | not null | `createdAt + 30 minutes` ("valable 30 minutes", FR-003) |
| `usedAt` | DATE | null | set in the same transaction that creates the account / changes the password |
| `createdAt` / `updatedAt` | timestamps | | |

**Indexes**: UNIQUE `tokenHash`.
**Retention**: purged 1 day after `expiresAt`.
**Rules**: a new setup token is issued at every boot while no account exists, and older `setup` tokens are deleted first (FR-003: "un nouveau lien est émis à chaque démarrage"); issuing a token of a kind deletes the unused tokens of that kind, so at most one live link per kind exists (derived rule, symmetric with the setup behaviour); creating the account deletes all `setup` tokens. Consuming a `reset` sets the new password, deletes all `AdminSession` rows, and clears the in-memory login lockouts.

### 1.4 SettingOverride

**Purpose.** A value set in the panel for an environment-backed setting; it wins over `config.env`/environment (FR-021). A row's absence means "use the file value, else the default".
**Table** `setting_overrides`. **Backup**: yes (research C6; holds API keys, hence encrypted at rest and carried decrypted inside the passphrase-encrypted archive, see 4.2). **Retention**: until the owner resets the setting (row deleted). **Writers**: `lib/utils/settingsStore.js` (R1), called by the settings routes, by restore and by the alert/broadcast toggles. **Cache**: the synchronous in-memory store of `settingsStore` (not `settingsCache`: `config.X` reads are synchronous, ~273 sites); loaded after `sync()`, updated in place on every write, reloaded on restart and restore. **Sensitivity**: secret values are `enc:v1:...` ciphertext; every secret value (clear form) is registered with the log redactor.

| Field | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `key` | STRING(64), PK | not null | catalog key (`PREFIX`, `OPENAI_API_KEY`, `ALERT_UPDATE`, `BROADCAST_DELAY_MS`...). Only keys of the catalog with `source: "env"`, an `effect` other than `boot-only`, and not `readonly` may have a row |
| `value` | TEXT | not null | **raw string in the same format as the environment** (`"true"`, `"3"`, `"a,b"`), parsed and validated by the same catalog code as an environment value. `''` is a deliberate value ("clear the API key"), distinct from "no row". Secrets: `enc:v1:<iv>:<tag>:<ciphertext>` (4.2); an empty secret is stored as `''` (nothing to protect) |
| `version` | INTEGER | not null, default 1 | optimistic-concurrency counter (FR-020): a write is `UPDATE ... WHERE key = :k AND version = :v` (0 rows = HTTP 409 "ce réglage a changé depuis l'ouverture de la page"); first creation is an insert whose PK conflict is the same 409 |
| `createdAt` / `updatedAt` | timestamps | | `updatedAt` = "modifié le" in the panel |

**Write path** (research A1): validate the whole batch (types, bounds, cross-field rules such as `AUTO_RESPONDER_MIN_DELAY <= AUTO_RESPONDER_MAX_DELAY`), then one transaction (behind the in-process mutex, 0.4), then update the in-memory store, then emit `change` for the dependent caches (language reload, derived credential caches, interval singletons). Nothing is written when any field is invalid (FR-015).
**Not stored here**: boot-only startup settings (`ADMIN_PANEL`, `PANEL_HOST`, `PANEL_PORT`, `PANEL_PUBLIC_URL`, `PANEL_TRUST_PROXY`, `LOG_FORMAT`, `SUPERVISED`, `UPDATE_CHECK`, `DATABASE_URL`, `DATABASE_SSL`, `YTDLP_PATH`, plus the other `boot-only` entries of the catalog): the panel needs them before the database exists. And adapter-backed settings (model/file source, 4.1): their source of truth is the existing row or file; no override is ever written for them.
**Version after a reset**: a reset deletes the row, so the next creation restarts at 1. To avoid an ABA overwrite by a stale tab, the store keeps the last known version of each key in a bounded in-memory map and creates the new row at `last + 1`; after a process restart the window is the single admin's two-tab race, accepted.
**Restore**: rows for keys that are unknown, `boot-only` or `readonly` in the current catalog are dropped and counted; a value that fails catalog validation refuses the restore (dry run, 4.3).

### 1.5 CommandState

**Purpose.** Commands disabled globally or in one group (FR-026, FR-027). A row means "disabled".
**Table** `command_states`. **Backup**: yes. **Retention**: stale rows are kept and shown as "unknown command" so the owner can remove them. **Writers**: `lib/utils/commandState.js` (`set(name, scope, disabled)`), called by `lib/admin/stores`. **Reader**: `registry.executeCommand`, after the owner gate and before the group/PM/admin checks. **Cache**: `settingsCache` key **`command_state`**, one value `{ global: Set, byGroup: Map<groupJid, Set> }` (one `findAll`, default 5 min TTL). Invalidate on every `set`, on restore and on in-process restart. Fail-open: if the load fails, `getOrLoad` returns `null` and nothing is disabled. **Sensitivity**: none.

| Field | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `command` | STRING(64), PK part | not null | the registry entry's `name` (first alias, lower case). Keys survive added aliases but not a changed first alias |
| `scope` | STRING(255), PK part | not null, default `*` | `*` = global, otherwise a group JID |
| `createdAt` / `updatedAt` | timestamps | | `createdAt` = "date du changement" |

**Semantics**: disabled iff `global.has(name) || (message.isGroup && byGroup.get(message.jid)?.has(name))`; a global row wins over group rows (FR-027, edge case "désactivée partout et activée dans un groupe"). There is no "enabled" row: re-enabling deletes the row, and the history lives in `AuditLog` (`command.toggle`). A disabled command answers `common.command_disabled` to everyone, owners included, for every alias (also sticker-bound calls, which go through `executeCommand`). `onMessage` hooks (`afk`, `addfilter`, `notify`, `trackmessages`) keep running when their command is disabled. The panel warns before disabling `unban`/`ban` (a disabled `unban` in a banned chat leaves the panel as the only way back).
**Cascade**: deleting a former group's settings deletes the rows whose `scope` is that JID (3.5).

### 1.6 TextOverride

**Purpose.** Bot texts replaced from the panel, per language (FR-057 to FR-060).
**Table** `text_overrides`. **Backup**: yes (FR-051, FR-060). **Retention**: forever; a row whose key disappeared from `lang/*.json` in a later release is listed as "unknown text" and removable. **Writers**: the admin text service (via `lib/admin/stores`), then `languageManager.setOverrides(lang, Map)`. **Cache**: the `LanguageManager` in-memory maps (`overrides[lang].get(key)`), loaded at boot and replaced after each write, restore and restart; **not** `settingsCache` (`getLang` is synchronous with ~800 call sites; no TTL, so "dès le message suivant" holds). **Sensitivity**: none.

| Field | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `key` | STRING(160), PK part | not null | a key present in `lang/en.json` (1004 keys, identical to `fr.json`) |
| `lang` | STRING(8), PK part | not null | `en` or `fr` in this feature (the two maintained locales, FR-057); the column width leaves room for others |
| `text` | TEXT | not null | 1 to 4000 characters; the multiset of `/\{\d+\}/g` tokens must equal the original's (same regex as `test/i18n.test.js`), otherwise the save is refused and the response lists the expected tokens (FR-059) |
| `originalHash` | STRING(16) | not null | first 16 hex characters of the SHA-1 of the original file text of `(lang, key)` at override time; the panel flags "original changed" when the current file text hashes differently (US12 scenario 4) |
| `createdAt` / `updatedAt` | timestamps | | |

**Resolution order** in `getLang(key, ...args)`: `overrides[currentLang][key]`, then `translations[key]` (file), then `overrides.en[key]`, then the English file, then the key itself; placeholders are substituted after resolution. Command descriptions are made lazy at plugin load (research A3) so overrides of `plugins.<x>.desc` apply to menus and help.
**Interaction with the parity test**: `test/i18n.test.js` reads `lang/*.json` statically, so database overrides never reach it.

### 1.7 AuditLog

**Purpose.** History of administration actions (FR-036), no secret value.
**Table** `audit_logs`. **Backup**: **no** (U12): restoring an old backup must not erase what happened since. **Retention**: 180 days and 20 000 rows (trim rule in 1.15). **Writers**: `lib/utils/audit.js` only: `record({ action, target, origin, result, detail }, { transaction })`. **Cache**: none. **Sensitivity**: contains client addresses (`origin`) and group/user JIDs; never a secret: `detail` of a setting change is `{ from, to }` for a non-secret setting and only `{ secret: true, op: "set" | "clear" }` for a secret, produced by the single helper `auditDiff(settingDef, before, after)`; a final guard strips any string matching the redactor patterns. The backup passphrase is never recorded (the `backup.export` entry holds counts and `includesSession` only).

| Field | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `id` | INTEGER, PK, autoIncrement | not null | |
| `action` | STRING(48) | not null | dotted: `login.success`, `login.failure`, `login.blocked`, `logout`, `setup.complete`, `reset.issued`, `reset.complete`, `account.update`, `setting.update`, `setting.reset`, `command.toggle`, `text.update`, `text.reset`, `group.update`, `group.delete`, `economy.adjust`, `data.delete`, `broadcast.create`, `broadcast.update`, `broadcast.cancel`, `broadcast.delete`, `backup.export`, `backup.restore`, `restart`, `pair.request`, `pair.code`, `session.logout`, `update.apply`, `ytdlp.update`, `storage.purge`, `guard.antibot.remove`, `guard.antibot.suspect`. The vocabulary is a constant in `lib/utils/audit.js`; stores add entries as needed |
| `target` | STRING(255) | null | setting key, command, `<groupJid>:<userJid>`, broadcast id... |
| `origin` | STRING(64) | null | client address key of the request (null for bot-side events) |
| `result` | STRING(12) | not null, default `ok` | `ok`, `fail`, `blocked` |
| `detail` | TEXT | null | sanitized JSON, at most 2000 characters; an oversized detail is replaced by a summary object, never cut mid-JSON |
| `createdAt` | DATE | | `timestamps: true, updatedAt: false` |

**Indexes**: `createdAt`; `(action, createdAt)`; `(origin, createdAt)`.
**Uses beyond the history page**: (a) "connexion depuis une origine jamais vue" (FR-061): a successful login whose `origin` has no earlier `login.success` row; (b) optional rehydration of the login limiter at boot from the `login.failure` rows of the last 15 minutes (so a restart does not reset counters); the limiter itself is in memory (research B6).
**Per-event volume**: `login.blocked` is recorded once when a block starts, not per refused attempt, so a flood is bounded to one row per origin per 15 minutes.
`guard.antibot.remove` (R4): one entry per anti-bot removal, `detail = { jid, rule }`, `result = ok`. `guard.antibot.suspect` (U16): same shape, written when a 22-character `3EB0...` id is seen from a non-exempt sender; nothing is removed, and the entry is rate-limited to one per sender per group per day (in memory, so a restart may repeat one).

### 1.8 DailyStat

**Purpose.** Usage counters per day (FR-035, US7).
**Table** `daily_stats`. **Backup**: yes (SC-011; the in-memory buffer is flushed before the export). **Retention**: 90 days (the panel displays 7). **Writers**: `lib/utils/stats.js`. **Cache**: in-memory counter `Map` flushed every 30 s (`unref`'d) and from the shutdown hooks; a crash loses at most 30 s of counters (`index.js` mode ends in `process.exit(0)` on SIGTERM: same bound). **Sensitivity**: group JIDs.

| Field | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `day` | STRING(10), PK part | not null | `YYYY-MM-DD` in `config.TIMEZONE` at write time; a later `TIMEZONE` change does not rewrite history |
| `metric` | STRING(16), PK part | not null | `messages` (subject `''`, non-`fromMe` messages, status broadcasts excluded), `group_msgs` (subject = group JID), `cmd_ok` (after `execute` resolves), `cmd_fail` (in the registry's catch block, after the media-too-large user-error branch) |
| `subject` | STRING(255), PK part | not null, default `''` | command name or group JID |
| `count` | INTEGER | not null, default 0 | |

`timestamps: false`. Composite PK `(day, metric, subject)` is the upsert target:

```sql
INSERT INTO "daily_stats" ("day","metric","subject","count") VALUES (:d,:m,:s,:n), ...
ON CONFLICT ("day","metric","subject") DO UPDATE SET "count" = "daily_stats"."count" + excluded."count";
```

**Panel queries** (window = today and the 6 previous local days, "sur 7 jours"): messages per day `SUM(count) WHERE metric='messages' GROUP BY day`; top 10 commands `WHERE metric='cmd_ok' GROUP BY subject ORDER BY 2 DESC LIMIT 10`; failures likewise with `cmd_fail`; most active groups likewise with `group_msgs`. Worst-case size: about 100 commands plus N groups per day for 90 days, a few tens of thousands of rows.

### 1.9 KnownChat

**Purpose.** The chats the panel may offer as broadcast destinations, and the list of former groups (FR-046, US6 scenario 7). No reliable record existed (`User` is written only by `.afk`, `Conversation` only by the AI responder, `UserStats` is groups only).
**Table** `known_chats`. **Backup**: yes. **Writers**: hook-only plugin `plugins/knownchats.js` (`onMessage`, `hookPriority.onMessage = 5`; `onReady` seeding and refresh) through `lib/utils/knownChats.js`; the group settings delete service removes a row. **Cache**: none in `settingsCache`; an in-memory `Map<jid, lastTouchMs>` throttles `lastSeenAt` writes to one per hour per JID (entries older than 1 h are dropped on each write); the group metadata (names, member count, "bot is admin") comes from `groupFetchAllParticipating()` cached in memory for 60 s. **Sensitivity**: JIDs and WhatsApp push names of people who wrote to the bot (personal data); never exposed on the public monitoring endpoints; included in backups, which are passphrase-encrypted.

| Field | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `jid` | STRING, PK | not null | `@s.whatsapp.net` or `@lid` for `private`, `@g.us` for `group`; never `status@broadcast` or newsletters |
| `kind` | STRING(8) | not null | `private` or `group` (`isIn`) |
| `pnJid` | STRING | null | phone-number form (`message.sender`) so a person seen as PN and as LID is de-duplicated in the picker |
| `name` | STRING | null | `pushName` for a private chat, subject for a group |
| `firstSeenAt` | DATE | not null | |
| `lastSeenAt` | DATE | not null | |
| `leftAt` | DATE | null | set when `groupFetchAllParticipating()` no longer lists the group, cleared when the bot is back ("ancien groupe") |
| `createdAt` / `updatedAt` | timestamps | | |

**Indexes**: `(kind, lastSeenAt)`, `pnJid`.
**Fill rules**: the hook records a private chat the first time it writes (`!isGroup && !fromMe`), runs after the disabled-chat gate (so chats in `BannedChat` are not recorded) and does not touch `pipeline.js`. `onReady` seeds an empty table from `Conversation.jid` and `User.jid` (non-group) and from every `groupJid` found in `Group`, `Filter`, `GroupRole`, `UserStats`, `Warn`, `GroupEconomy`, `Idea`, `Quote`; it refreshes group names and `leftAt` at most every 6 h, plus the panel's refresh button.
**Broadcast validation** (FR-046): a destination is accepted only if it is a `private` row not in `BannedChat`, or a `group` row with `leftAt IS NULL`; de-duplicated by `pnJid || jid`; any other JID, in particular a number typed by hand, is rejected server-side.
**Retention**: `private` rows silent for more than 365 days are pruned. `group` rows stay (so "ancien groupe" keeps showing) until the owner deletes that group's settings (3.5).
**Not persisted**: member count and "bot is administrator" (FR-028) are live values; while the bot is disconnected the list shows the last known name and "unknown" for them.

### 1.10 Broadcast

**Purpose.** The definition of a broadcast: content, destinations, pacing, schedule or recurrence rule (FR-047 to FR-050).
**Table** `broadcasts`. **Backup**: yes, plus the media files of non-final broadcasts (4.3). **Retention**: deleted by the owner; a `once` broadcast with no remaining runs is removed 90 days after its last run finished (1.15). **Media (U15)**: the media of a `once` broadcast is deleted 7 days after its run ends (`BroadcastRun.finishedAt`, whatever the final status); the media of a recurring broadcast is kept as long as the broadcast exists. The Storage page also lists a "broadcast media" category that can be emptied; it only touches media that can no longer be sent (1.15, runtime.md section 14). **Writers**: `lib/admin/stores/broadcast.js` (create, edit, pause, resume, delete) and the engine (`nextRunAt`, `lastRunAt`). **Cache**: none; the engine reads the database at each tick. **Sensitivity**: message content and destination JIDs.

| Field | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `id` | INTEGER, PK, autoIncrement | not null | |
| `kind` | STRING(10) | not null | `once` or `recurring` |
| `title` | STRING(100) | null | owner's label |
| `text` | TEXT | not null | message or media caption; at most 4096 characters without media, 1024 with media (constants) |
| `mediaKind` | STRING(10) | null | `image` or `document`, at most one media (FR-047) |
| `mediaPath` | STRING(255) | null | relative to the repository root, always `data/broadcast-media/<id>/<sanitizedName>`; re-resolved at read time and refused if it leaves that directory; set to NULL when the retention rule or a storage purge deletes the file (`mediaKind`, `mediaName`, `mediaMime` and `mediaSize` stay, so the history still shows what was sent) |
| `mediaName` | STRING(255) | null | sanitized display name |
| `mediaMime` | STRING(100) | null | sniffed with `file-type`, never trusted from the client header |
| `mediaSize` | INTEGER | null | bytes; capped by `MAX_UPLOAD` (1 to 2000 MB by validation, 2000 MB < 2^31, so it fits a 32-bit INTEGER on Postgres) |
| `targets` | JSON | not null | array of 1 to **200** JIDs ("au plus 200 destinations par diffusion"), validated against `KnownChat` at create/edit and copied verbatim into `BroadcastTarget` rows at each materialization (a group left meanwhile fails at send time, which is the spec's edge case) |
| `spacingMs` | INTEGER | not null, default 5000 | **default 5 s, never less than 2 s** (FR-048); validated `2000 <= v <= 600000`; copied from the setting `BROADCAST_DELAY_MS` at creation unless the form overrides it; the engine also applies `max(2000, spacingMs)` at send time |
| `status` | STRING(10) | not null, default `active` | `active` or `paused` (recurring only; a `once` broadcast ends with its run) |
| `runAt` | DATE | null | `once`: scheduled time; null = send now |
| `recurKind` | STRING(10) | null | `daily`, `weekly`, `monthly` |
| `recurDays` | STRING(20) | null | `1,3,5` (ISO weekdays, Monday=1) for `weekly`; `15` (1 to 31) for `monthly` |
| `recurTime` | STRING(5) | null | `HH:mm` in `config.TIMEZONE` |
| `nextRunAt` | DATE | null | next occurrence (recurring); the engine's single indexed range |
| `lastRunAt` | DATE | null | last occurrence materialized |
| `createdAt` / `updatedAt` | timestamps | | |

**Indexes**: `(status, nextRunAt)`.
**Rules**: `kind='once'` requires `recurKind/recurDays/recurTime/nextRunAt` null; `kind='recurring'` requires `recurKind` and `recurTime`, and `recurDays` for `weekly`/`monthly`, and `runAt` null. Editing a rule or `TIMEZONE`, and resuming, recompute `nextRunAt` from `now` (no catch-up burst). Deleting removes definition, runs, targets and the media directory in one transaction behind the mutex. A row with `mediaKind` set and `mediaPath` NULL is never sendable; only a final `once` broadcast can be in that state, because the retention rule and the purge skip anything that may still send.
**Displayed state** (spec: programmée, en cours, en pause, terminée, annulée, expirée) is derived: the status of the latest run (`scheduled` = programmée, `running` = en cours, `completed` and `failed` = terminée with per-destination results, `cancelled` = annulée, `expired` = expirée), plus "en pause" when `Broadcast.status='paused'` or when the client is down while a run is open.

### 1.11 BroadcastRun

**Purpose.** One occurrence of a broadcast (the only run of a `once` broadcast; one per date for a recurring one), and the unit of "exactly once per occurrence".
**Table** `broadcast_runs`. **Backup**: yes. **Retention**: 90 days after `finishedAt`. **Writers**: the engine (`lib/utils/broadcaster.js`, R1; research C4 called it `broadcast.js`) and the cancel/delete service. **Cache**: none.

| Field | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `id` | INTEGER, PK, autoIncrement | not null | |
| `broadcastId` | INTEGER | not null | logical link to `broadcasts.id` |
| `dueAt` | DATE | not null | the occurrence instant (UTC); for "send now" the creation time |
| `status` | STRING(10) | not null, default `scheduled` | `scheduled`, `running`, `completed`, `failed`, `cancelled`, `expired` |
| `total` | INTEGER | not null, default 0 | number of targets materialized |
| `targetsReady` | BOOLEAN | not null, default false | set to true last; the engine ignores a run whose targets are not ready |
| `startedAt` | DATE | null | set by the first claim |
| `finishedAt` | DATE | null | set on `completed`, `failed`, `cancelled`, `expired` |
| `note` | STRING(100) | null | `late` (expired for lateness, also used for a skipped recurring occurrence) or `stale` (closed by the 24 h safety) |
| `createdAt` / `updatedAt` | timestamps | | |

**Indexes**: **UNIQUE `(broadcastId, dueAt)`** (turns "chaque occurrence [...] partir au plus une fois" (FR-050) into a database invariant, also across restarts and across two processes on one database); `(status, dueAt)`.
Per-status counts (sent, failed, cancelled) are computed with `GROUP BY status` on the targets, not stored.

### 1.12 BroadcastTarget

**Purpose.** One delivery to one destination for one run; makes "au plus une fois par destination" a pair of CAS updates plus a unique index.
**Table** `broadcast_targets`. **Backup**: yes. **Retention**: with its run. **Writers**: the engine; the cancel service. **Cache**: none. **Sensitivity**: destination JIDs and WhatsApp message ids.

| Field | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `id` | INTEGER, PK, autoIncrement | not null | |
| `runId` | INTEGER | not null | logical link to `broadcast_runs.id` |
| `chatJid` | STRING | not null | |
| `position` | INTEGER | not null | send order inside the run |
| `status` | STRING(10) | not null, default `pending` | `pending`, `sending`, `sent`, `failed`, `cancelled` |
| `attempts` | INTEGER | not null, default 0 | incremented by the claim |
| `leaseUntil` | DATE | null | claim time + 60 s; an expired lease means the process died mid-send |
| `sentAt` | DATE | null | also the source of the global pacing clock (`max(sentAt)` read once at start) |
| `messageId` | STRING(64) | null | WhatsApp id on success |
| `errorCode` | STRING(40) | null | a code, never raw error text: `forbidden`, `not_found`, `timeout`, `connection_closed`, `error`, `interrupted`. `timeout`, `connection_closed` and `interrupted` are flagged "may have been delivered" |
| `createdAt` / `updatedAt` | timestamps | | |

**Indexes**: **UNIQUE `(runId, chatJid)`** (a second materialization of the same run is harmless); `(runId, status, position)`; `sentAt`.

### 1.13 AlertState

**Purpose.** Persisted rate-limit slots and connection heartbeat for the alerts (FR-062), so a restart cannot re-spam.
**Table** `alert_states`. **Backup**: no (per-installation). **Writers**: `lib/utils/alerts.js`. **Cache**: none.

| Field | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `key` | STRING(96), PK | not null | see the table below |
| `lastSentAt` | DATE | null | last time the slot was taken |
| `value` | STRING(255) | null | `conn_heartbeat`: ISO timestamp; `update_available`: last notified version |
| `count` | INTEGER | not null, default 0 | number of alerts allowed through this slot |
| `createdAt` / `updatedAt` | timestamps | | |

| Key | Window | Slot rule |
|---|---|---|
| `reconnected` | 10 min | CAS on `lastSentAt` |
| `errors_series` | 1 h | CAS on `lastSentAt` ("au plus une alerte « erreurs en série » par heure") |
| `key_refused:<service>` | 24 h | CAS on `lastSentAt`, per service ("par service et par 24 heures") |
| `login_blocked:<origin>` | 15 min | CAS on `lastSentAt` |
| `update_available` | once per version | `UPDATE ... SET value = :v, lastSentAt = :now WHERE key = 'update_available' AND (value IS NULL OR value <> :v)` |
| `conn_heartbeat` | rewritten every 60 s while connected and on `close` | not a rate limit; read at `ready` to compute the outage duration |

The CAS is one statement: `UPDATE alert_states SET lastSentAt = :now, count = count + 1 WHERE key = :k AND (lastSentAt IS NULL OR lastSentAt <= :now_minus_window)`; one affected row = allowed (the row is created first with `ignoreDuplicates`). The first boot (no `conn_heartbeat`) raises nothing.
**Retention**: tiny, but `login_blocked:<origin>` keys grow with the number of attacking origins, so rows with that prefix and `lastSentAt` older than 24 h are pruned (1.15; research C1 said "forever").

### 1.14 AlertOutbox

**Purpose.** Queue of alerts born while the bot is disconnected (FR-063); flushed at reconnection.
**Table** `alert_outbox`. **Backup**: no. **Writers**: `lib/utils/alerts.js`. **Cache**: none. **Sensitivity**: payloads carry service names, versions, durations, origin and times, never a key or a stack.

| Field | Type | Null / default | Constraint and notes |
|---|---|---|---|
| `id` | INTEGER, PK, autoIncrement | not null | |
| `type` | STRING(24) | not null | `reconnected`, `errors_series`, `key_refused`, `login_blocked`, `new_origin`, `update_available` (`isIn`) |
| `payload` | TEXT | null | JSON, never a secret |
| `status` | STRING(10) | not null, default `pending` | `pending`, `sent`, `expired`, `dropped` |
| `attempts` | INTEGER | not null, default 0 | at most 3 |
| `sentAt` | DATE | null | |
| `createdAt` / `updatedAt` | timestamps | | |

**Indexes**: `(status, createdAt)`.
**Type to toggle** (U12: every type on by default; the toggles are settings in `SettingOverride`, not a table): `reconnected` = `ALERT_RECONNECT`, `errors_series` = `ALERT_ERROR_BURST`, `key_refused` = `ALERT_KEY_REFUSED`, `login_blocked` = `ALERT_LOGIN_BLOCKED`, `new_origin` = `ALERT_NEW_ORIGIN`, `update_available` = `ALERT_UPDATE`.
**Retention**: rows not `pending` are deleted 7 days after `updatedAt`; `pending` rows older than 24 h become `expired`.

### 1.15 Housekeeping (retention, consolidated)

One daily job in `lib/utils/housekeeping.js` (first run 2 minutes after boot, like `conversationManager.startPurge`, `unref`'d, started by `start()` and never at `require` time) applies the retention below, each statement idempotent and written with model methods or quoted identifiers. Corrections to research C1 are marked.

| Table | Rule |
|---|---|
| `daily_stats` | delete `day < today - 90 days` |
| `audit_logs` | delete `createdAt < now - 180 days`; then keep the newest 20 000 rows **except** `login.success` rows, which are exempt from the row cap (kept up to 180 days, at most 500) so that a flood of failures cannot make a known origin look "never seen" (FR-061) (correction) |
| `admin_sessions` | delete `lastSeenAt < now - 24 h` **or `createdAt < now - 7 days`** (correction: C1 only had the idle clause; U11 adds the absolute cap); the hourly sweep lives in the sessions module |
| `admin_tokens` | delete `expiresAt < now - 1 day` |
| `alert_outbox` | delete `status <> 'pending'` with `updatedAt < now - 7 days`; set `pending` with `createdAt < now - 24 h` to `expired` |
| `alert_states` | delete keys starting `login_blocked:` with `lastSentAt < now - 24 h` (correction) |
| `broadcast_targets` / `broadcast_runs` | delete runs with `finishedAt < now - 90 days`, targets first; delete runs with `targetsReady = false` and `createdAt < now - 1 h`, targets first (defence in depth: creation is one transaction) |
| `broadcasts` | delete `kind='once'` rows with no remaining run, and any media directory still present |
| `broadcasts` (media, U15) | for `kind='once'` rows with `mediaPath` set whose run is final with `finishedAt < now - 7 days`: delete `data/broadcast-media/<id>/` and set `mediaPath = NULL`. Recurring broadcasts are never touched. Also set `mediaPath = NULL` when the file no longer exists and no run is open (a final broadcast restored from a backup, which carries the media of non-final broadcasts only) |
| `known_chats` | delete `kind='private'` with `lastSeenAt < now - 365 days` |
| Files | `data/admin-uploads/*` older than 1 h; `data/tmp/*` at boot; `data/broadcast-media/<id>/` with no `Broadcast` row `<id>` (for instance after a restore) |

---

## 2. State machines

Every transition is a conditional `UPDATE ... WHERE status = <from>` (or the equivalent guard); a lost race changes 0 rows and is ignored.

### 2.1 AdminToken

```text
                       issue (boot with no account | tools/admin-reset.js | data/admin-reset marker)
                                           |
                                           v
   GET /admin/setup?token validates   +----------+   now >= expiresAt            +---------+
   without consuming (sets owb_setup) |  ISSUED  |------------------------------>| EXPIRED |
   +--------------------------------> | usedAt=  |                               +---------+
                                      |  NULL    |   a newer token of the same kind is issued,
                                      |          |   or (setup) the account gets created
                                      |          |------------------------------> deleted (SUPERSEDED)
                                      +----+-----+
                                           | POST /admin/api/setup | /reset  (same transaction as
                                           v   account creation | password change; usedAt set)
                                      +----------+
                                      |   USED   |   a used or expired link never works again
                                      +----------+
   USED | EXPIRED --(expiresAt + 1 day)--> PURGED (housekeeping)
```

Wrong token attempts use their own bucket in the in-memory limiter. A link scanner that only fetches the page cannot consume the token (consumption is the POST).

### 2.2 AdminSession

```text
  login | setup | reset consumed | password change  --(rotation: new id, old cookie discarded)-->  ACTIVE
  ACTIVE --request on a touch:true route--> ACTIVE          (lastSeenAt refreshed, write-behind >= 60 s)
  ACTIVE --now - lastSeenAt > 24 h--------> EXPIRED (idle)
  ACTIVE --now - createdAt  > 7 days------> EXPIRED (absolute, even if continuously active)
  ACTIVE --POST /admin/api/logout---------> DELETED
  ACTIVE --password change (all others) | reset consumed (all)--> DELETED
  ACTIVE --11th live session created------> DELETED (oldest evicted)
  EXPIRED --presented once | hourly sweep--> DELETED
```

SSE streams re-check the session at each 15 s heartbeat; on expiry the server sends a `session` event, then ends the stream. A save attempted with an expired session is refused, and the panel warns that the typed input will be lost before redirecting to the login (edge case).

### 2.3 Broadcast and BroadcastRun

```text
BroadcastRun
  scheduled --first claim-----------------------------------------> running
  running   --no pending/sending target left, >= 1 sent-----------> completed
  running   --no pending/sending target left, 0 sent--------------> failed
  scheduled --now - dueAt > 1 h and nothing started--------------> expired   (note=late, targets cancelled)
  scheduled | running --owner cancels----------------------------> cancelled (pending targets cancelled; the one
                                                                              in-flight message completes and is reported sent)
  running   --started more than 24 h ago-------------------------> cancelled (note=stale, remaining targets cancelled)

Broadcast (recurring only)
  active <--pause / resume--> paused        resume: nextRunAt recomputed from now, no catch-up
  "once": ends with its run                 delete: definition, runs, targets, media removed together

While the client is disconnected: tick() returns immediately. No state changes in the database;
the broadcast is displayed "en pause" and sending resumes, paced, at reconnection.
A run that already started is NOT expired by a long outage (only the 24 h safety applies).
A run still `scheduled` more than 1 h past its dueAt (e.g. bot down at the scheduled time) is expired, not sent.
```

**No retry (U14).** No transition leaves a final state: a run that is `completed`, `failed`, `cancelled` or `expired` is never reopened, and a target that is `sent`, `failed` or `cancelled` never returns to `pending`. A failed destination is served again only by a **new broadcast** that the owner creates and confirms: the UI reads the `failed` targets (`interrupted` included, flagged "may have been delivered") from the run report route, pre-fills the ordinary create form with them and submits it through the existing create route (at most 200 destinations, `confirmTargets`, the same `KnownChat` validation). That broadcast has its own `Broadcast`, run and targets, so the unique indexes of 1.11 and 1.12 are untouched. Its media is copied from the source broadcast while the file still exists (7 days for a `once` broadcast, 1.10).

Pacing (global, one send per tick, FIFO by `run.dueAt` then `position`): a send is eligible only if `now - lastSendAt >= max(2000, spacingMs) * (1 + jitter)` with `jitter` drawn once per send in `[0, 0.2]` (it only lengthens the gap, so the 2 s floor always holds). `lastSendAt` is read once at start as `max(sentAt)` and kept in memory, so a restart cannot burst.

### 2.4 BroadcastTarget

```text
pending --claim (UPDATE ... SET status='sending', attempts=attempts+1, leaseUntil=now+60s WHERE id=? AND status='pending';
          only the caller that sees 1 affected row sends)-------------------------------------------> sending
sending --send ok (UPDATE ... SET status='sent', sentAt, messageId WHERE id=? AND status='sending')--> sent
sending --send error (errorCode in forbidden | not_found | timeout | connection_closed | error)------> failed
sending --leaseUntil < now (process died mid-send)------------------------------------------------> failed (errorCode=interrupted)
pending --owner cancels | run expired | run closed stale------------------------------------------> cancelled
sent | failed | cancelled are final: no transition leaves them (U14, see "No retry" in 2.3)
```

A target caught mid-send by a crash is never retried automatically: WhatsApp gives no idempotency key, so the send and the `sent` write cannot be atomic, and "never twice" ranks above "always delivered" (FR-048, SC-012). Sending is strictly sequential, so a crash leaves at most one uncertain target.
There is no retry transition for a target and no reopen transition for its run (U14).

### 2.5 Recurrence rules

Pure module `lib/utils/recurrence.js` (no clock, no database): `validateRule(rule)`, `nextOccurrence(rule, afterMs, zone)`, `describe(rule, lang)`.

| Rule | Shape | Fires on |
|---|---|---|
| daily | `{ kind: 'daily', time }` | every local calendar day |
| weekly | `{ kind: 'weekly', days: [1..7], time }` | listed ISO weekdays (Monday=1) |
| monthly | `{ kind: 'monthly', day: 1..31, time }` | `min(day, daysInMonth)`: "le 31" fires on 28/29 February, 30 April... (FR-050, U12) |

- The zone is `config.TIMEZONE`, validated with `Info.isValidIANAZone`, falling back to `UTC`. It is read at computation time ("fuseau horaire du bot"); changing it recomputes `nextRunAt` from `now`.
- `nextOccurrence` iterates local calendar days from the local day of `afterMs` (at most 400 steps), keeps a day if the rule matches, builds the instant with luxon `DateTime.fromObject({ year, month, day, hour, minute }, { zone })` and returns the first instant strictly after `afterMs`. A rule evaluated exactly at an occurrence returns the next one.
- DST: one local day yields at most one instant, so an occurrence is neither duplicated nor dropped. A time inside a spring-forward gap resolves forward (Paris 02:30 on 2026-03-29 gives 03:30+02:00; Cairo 00:30 on 2026-04-24 gives 01:30+03:00); in a fall-back overlap one instant is picked (Paris 02:30 on 2026-10-25), never two.
- Lateness: an occurrence with `now - dueAt > 1 h` is recorded as a `BroadcastRun` with `status='expired'`, `note='late'`, no targets (the "notée dans l'historique" of FR-050) and the schedule moves on; within 1 h it is materialized normally.

Materialization, in the engine tick before delivery, for each `Broadcast` with `kind='recurring'`, `status='active'`, `nextRunAt <= now` (loop of at most 50 iterations, `d = nextRunAt`):

```text
1. CAS the schedule:  UPDATE broadcasts SET nextRunAt = nextOccurrence(rule, d), lastRunAt = d
                       WHERE id = ? AND nextRunAt = d             (0 rows = another tick won; stop)
2. INSERT broadcast_runs (broadcastId, dueAt = d, status = 'expired' | 'scheduled', note)  -- UNIQUE (broadcastId, dueAt)
3. if on time: INSERT up to 200 broadcast_targets, then set targetsReady = true            -- steps 1-3 in one transaction
4. continue while the new nextRunAt <= now; after 50 iterations jump nextRunAt to nextOccurrence(rule, now)
```

SC-016: a daily message followed for 7 occurrences with one during an outage of more than an hour yields 7 runs (6 `completed`, 1 `expired/late`), exactly 6 sends, `nextRunAt` on the next day; ticking the same instant twice or restarting the engine adds nothing (unique index).

### 2.6 AlertOutbox (and the rate-limit slot)

```text
raise(type, payload, { now })
   1. toggle ALERT_<TYPE> off .................................. drop (no row, no slot consumed)
   2. getOwnerJids() is empty ................................... drop (no row, no slot consumed; the panel shows "no recipient")
   3. rate-limit CAS on AlertState lost .......................... drop (no row)
   4. INSERT alert_outbox status=pending, then flush() at once if client.ready()

pending --flush (on onReady, then every 30 s while connected): >= 1 owner received--> sent        (sentAt)
pending --flush: nobody received, attempts < 3 ------------------------------------> pending     (attempts + 1)
pending --attempts = 3 -----------------------------------------------------------> dropped
pending --no owner configured at send time ---------------------------------------> dropped
pending --createdAt older than 24 h ----------------------------------------------> expired
sent | expired | dropped --(updatedAt + 7 days)--> deleted
```

The slot is consumed at creation time, not at send time, so an alert queued during a disconnection is neither duplicated nor lost. The `errors_series` window (last 10 minutes of command errors, in memory) is cleared when it reaches 10 entries, whether or not the rate limit let the alert through.

---

## 3. Existing models read or written by the panel

All writes go through store functions in `lib/admin/stores/*.js`, the only place that knows the (model, cache key) pair, and reuse the helpers plugins already export (CLAUDE.md: "a setter that writes a cached setting must call `settingsCache.invalidate(key)`"). Contract test: write through the store, read through the plugin's own reader, expect the new value without waiting for the 5 minute TTL (FR-030, FR-045).

### 3.1 Table

| Model (table) | Panel use | Fields | Code path to reuse | `settingsCache` key to invalidate |
|---|---|---|---|---|
| `Group` (`groups`) | read and write group settings | `welcome`, `goodbye`, `welcomeMsg`, `goodbyeMsg`, `antilink`, `antibot`, `mute` (semantics in 3.2); `truthDareEnabled` and `truthDareMode` are not exposed | `plugins/setwelcome.js` exports `getGroupSettings`, `invalidateGroupSettings`, `findOrCreateGroup`, `renderTemplate`, `isDefaultTemplate` (the panel uses `Group.findOrCreate({ where: { jid } })` since `findOrCreateGroup` takes a message) | `group:<jid>` |
| `Filter` (`filters`) | list, add, edit, delete per group | `pattern`, `response`, `groupJid` (`isGlobal` unused) | `plugins/addfilter.js` exports `loadFilters`, `getGroupFilters`, `invalidateFilters`, `normalizePattern`; limits are module constants (50 per group, pattern at most 100, response at most 1000 characters) and must be exported; no unique index, so duplicates are avoided with `findOrCreate` on the normalized pattern; "edit" is new (update in place, same duplicate check) | `filters:<jid>` |
| `GroupRole` (`group_roles`) | list and set member roles | composite PK `(groupJid, userJid)`, `role` (`vip`, `muted`, `banned`, `regular`), `setBy`, `setAt` | same code path as `.role set`; `regular` is stored by **deleting** the row (`plugins/role.js:217-218`); both identity forms (PN and LID) must be handled; `invalidateRoles` is not exported | `roles:<jid>` (export `invalidateRoles` or call `settingsCache.invalidate("roles:" + jid)`) |
| `Warn` (`warns`) | list, reset | unique `(jid, groupJid)`, `count`, `reason`; list = `count > 0` ordered by `count` then `updatedAt`; reset = `Warn.destroy` over every identity form of the user | `plugins/warnuser.js` exports nothing reusable: extract `identityForms`, `findOrCreateRow` and the SQL `increment` into a shared helper (no behaviour change) used by the command, the anti-link guard and the panel | none (read from the database each time) |
| `BannedChat` (`banned_chats`) | list disabled chats, disable or re-enable the bot in a chat | `jid`, `bannedBy` (the panel writes `null`: the admin has no JID; the action is in `AuditLog`) | same as `plugins/banchat.js` / `unbanchat.js` | `banned_chats` (`BANNED_CHATS_KEY` from `lib/core/pipeline.js`) |
| `GroupEconomy` (`group_economy`) | balances per group, adjust | composite PK `(groupJid, userJid)`, `balance` (nullable column, read with `COALESCE`), `streak`, `lastDailyAt` | `plugins/economy.js` exports `withLock`, `ensureAccount`, `getAccount`, `getBalance`, `applyDelta`; adjustment runs inside `withLock("give:<groupJid>", ...)` and one transaction (3.3) | none |
| `Reminder` (`reminders`) | list pending, cancel | `chatJid`, `creatorJid`, `text`, `dueAt`, `status` | `scheduler.list({ limit })` (no chat filter = all pending) and `scheduler.cancel(id)`, the idempotent CAS `status='pending'`, so "un rappel annulé n'est jamais envoyé" holds | none |
| `NotifyKeyword` (`notify_keywords`) | list, delete | `userJid`, `keyword`, `scopeJid`, `enabled` | `plugins/notify.js` | prefix `notify:` (`invalidatePrefix("notify:")`) |
| `StickerCommand` (`sticker_commands`) | list, delete | `stickerHash` (unique), `command`, `createdBy` | `plugins/delcmd.js` | `sticker_cmds` (`STICKER_CMDS_KEY`) |
| `User` (`users`) | list AFK statuses, clear | `afkReason`, `afkTime` (null = not away); other columns untouched | `plugins/afk.js` (`User.update({ afkReason: null, afkTime: null })`) | `afk_users` (the plugin mutates a `Map` in place: call `invalidate("afk_users")` after the update) |
| `Task` (`tasks`) | list, delete | `chatJid`, `text`, `done`, `createdBy`, `doneBy` | direct `destroy` | none |
| `Idea` (`ideas`) | list, delete | `groupJid`, `authorJid`, `text`, `category`, `voters` (comma-joined text with getter/setter; read through model instances) | direct `destroy` | none |
| `Quote` (`quotes`) | list, delete | `groupJid`, `authorJid`, `authorName`, `text`, `savedBy` | direct `destroy` | none |
| `AntiDelete` (`anti_delete`), `ViewOnce` (`view_once`), `AutoResponder` (`auto_responder`) | settings rows, `id = 1` | `enabled`, `antiDelMode` / `antiDelJid`, `vvMode` / `vvJid`, `ignoreNumbers`, `personality` | same code as the commands `antidelete`, `vv`, `ar` (adapters, 4.1); the env values `AUTO_RESPONDER_*` only seed the row | `anti_delete`, `view_once`, `auto_responder` |
| `data/status_save.json` | auto status save switch and watch list | `{ enabled, list[] }` | `lib/utils/statusListStore.js` (`get`, `add`, `remove`, `setEnabled`, atomic write); env values only seed a missing file | none (the store re-reads when the mtime changes) |

Tables the panel does not read or write: `UserStats` (kept for leaderboards; only seeds `KnownChat`) and `Conversation` (AI private-chat context, 30-day TTL; only seeds `KnownChat`; excluded from backups, U12).

### 3.2 Group semantics (U3, U4, R3, R4)

| Column | Meaning and enforcement |
|---|---|
| `welcome`, `goodbye`, `welcomeMsg`, `goodbyeMsg` | unchanged. Placeholders `@user`, `@group`, `@desc`; template at most 1000 characters (`MAX_TEMPLATE_LENGTH`). `null` or the legacy default `"Welcome @user to @group"` means "not customised" (`isDefaultTemplate`) and the localized default is used, so the panel's "reset" writes `null`, exactly like `.welcome reset`. The preview uses `renderTemplate`; an unknown variable is flagged and refuses the save (spec edge case). |
| `antilink` | Enforced by the new hook-only `plugins/groupguard.js` (`hookPriority.onMessage = 50`: after role 10, trackmessages 20, afk 30, notify 40; before addfilter 90). In a group with `antilink` on and the bot administrator, a message with a link (URL or `chat.whatsapp.com` invite) from a non-administrator, non-owner, non-`fromMe` sender is deleted (`sendMessage(jid, { delete: key })`); the author gets a warning through the **existing `Warn` table** (same `(jid, groupJid)` row, same `count`, so `.warn list` and the panel show it) and `WARN_LIMIT`; at the limit the author is removed (`guardTarget` + `assertParticipantResult`) with `ANTILINK_MSG`. The rule is strict (U17): it applies to every message from a non-administrator, commands included (a member's `.dl <url>` is deleted and warned, and the command does not run because the hook consumes the message); only group administrators and owners are exempt. Settings are read through `settingsCache` `group:<jid>`: one cached lookup per group message. |
| `antibot` | Same hook. A non-administrator sender whose message id has a shape no WhatsApp client produces (`BAE5` + 12 hex characters, or `3EB0` + 36 hex characters, 40 in all) is removed with `ANTIBOT_MSG` (U16). The 22-character `3EB0...` ids (Baileys 7, and probably WhatsApp Web) are only logged as suspects: a log line and an `AuditLog` row `guard.antibot.suspect`, at most once per sender per group per day, never a removal. Never acts on timing. Each removal is an `AuditLog` row `guard.antibot.remove` with the matched rule (R4); fixtures pin the shapes (removed, suspect, and ordinary phone ids plus near-miss lengths that must not match). |
| `mute` | No hook. The group service calls `groupSettingUpdate(jid, "announcement" | "not_announcement")` (bot administrator required) and **only on success** writes `Group.mute` (then `invalidateGroupSettings`). `Group.mute` therefore mirrors the last state set **by the bot**, not WhatsApp's live setting (an administrator can change it from a phone); the panel labels it accordingly. |
| Bot not administrator | The panel warns when `antilink`, `antibot` or `mute` is set and the bot is not an administrator (FR-032). Administrators of the group and the owners are exempt from the guard. |

### 3.3 Economy adjustment contract (C3)

Mode "add" (delta may be negative) and mode "set" (target `X >= 0`), reason 1 to 200 characters, inside `economy.withLock("give:<groupJid>", ...)` and one `DATABASE.transaction`: `ensureAccount` only for a credit (never for a debit), then `applyDelta(delta, { minBalance: -delta })` for a debit (single `UPDATE ... WHERE balance >= :n`; 0 rows = refused with nothing written, FR-043), then `getBalance`, then an `AuditLog` row `economy.adjust` with `{ mode, delta, balance, reason }` in the same transaction (the "motif trace dans l'historique" is the admin history; balance deltas are not secrets). "Set" reads the old balance in the same transaction and applies `delta = X - old` through the same guarded `applyDelta`, so a concurrent gain or spend is kept and the balance never goes below 0; the UI shows the balance actually returned.

### 3.4 Other notes

- **Cache coherence**: the panel never writes a cached model without invalidating its key; restore and in-process restart call `settingsCache.clear()` and then reload the settings store and the text overrides.
- **Cache key inventory** (the comment in `lib/utils/settingsCache.js` and CLAUDE.md list it): the existing keys `view_once`, `anti_delete`, `auto_responder`, `banned_chats`, `sticker_cmds`, `afk_users`, `filters:<jid>`, `group:<jid>`, `roles:<jid>`, prefix `notify:`; this feature adds **`command_state`** and nothing else (settings store, text overrides, sessions and the group metadata cache are separate in-memory structures, 4.5).
- **Two JID forms**: a person may be stored as phone-number JID (the form the bot persists) or LID. Every panel lookup on `Warn`, `GroupRole` and `GroupEconomy` must try both forms like the plugins do (`identityForms`, `toPnJid`).

### 3.5 Deleting a former group's settings (US6 scenario 7, FR-039)

"Ses réglages" means the categories the spec lists as group settings (Key Entity "Réglages de groupe"): in one transaction, children first, delete the `Group` row, the group's `Filter` rows, `GroupRole` rows, `Warn` rows, its `BannedChat` row, the `CommandState` rows whose `scope` is the group JID, and its `KnownChat` row; then invalidate `group:<jid>`, `filters:<jid>`, `roles:<jid>`, `banned_chats`, `command_state`. Group data (economy balances, ideas, quotes, tasks, `UserStats`, `DailyStat` history) is data, not settings, and is left alone (managed on the data pages). The action asks for confirmation (FR-039) and writes `group.delete` to `AuditLog`.

---

## 4. Non-database entities

### 4.1 Setting definition (catalog entry)

One code catalog (`lib/utils/settingsCatalog.js`, data only, no database import so `config.js` can load it before any model exists) is the single source for validation, panel forms, the backup restore check and the parity test between `config.js`, `config.env.example` and the catalog. `config.js` exposes accessor properties reading **override, then environment/file, then default**. [settings-catalog.md section 1](contracts/settings-catalog.md#1-entry-shape) is the authoritative entry shape (it also defines `envAliases`, `configProp`, `unit`, `fileTransform`, `onChange` and `flags`); this table keeps the properties the storage layer depends on, in the same vocabulary as that file, `contracts/runtime.md` and the API.

| Property | Type | Meaning |
|---|---|---|
| `key` | string | unique; equals `SettingOverride.key` (at most 64 characters) and, when `env` is set, the environment variable name (`BOT_LANG`; its `config` property is `LANG`, `configProp`) |
| `env` | string or null | environment variable name; null for panel-only keys (`BROADCAST_DELAY_MS`, `ALERT_*`) and for the virtual keys of adapters |
| `theme` | enum | functional themes `general`, `behavior`, `api-keys`, `responder`, `moderation`, `limits`, `advanced`, `boot`, `alerts`, plus the display group `inactive` (see the `inactive` row). `alerts` holds the six `ALERT_*` toggles: ordinary settings stored in `SettingOverride` (`env: null`, default `true`), not in `AlertState` or `AlertOutbox`, which only hold rate-limit slots and queued messages (1.13, 1.14). `BROADCAST_DELAY_MS` goes with `limits` |
| `type` | enum | `string`, `text`, `int`, `bool`, `enum`, `list`, `url` |
| `validate` | object or function | per type: length, regex, `min`/`max`, enum values, list item rule and maximum count (`SUDO`: at most 20 entries, each 6-15 digits with optional `+` or a JID); cross-field rules (`AUTO_RESPONDER_MIN_DELAY <= MAX_DELAY`) |
| `default` / `derived` | any | static default, or `derived` (`same_as:<KEY>` for `GEMINI_VISION_MODEL`, which falls back to `GEMINI_MODEL`; `auto_host` for `PANEL_HOST`); the panel shows the **code** default, not the example file's when they differ (U19: `AUTO_STATUS_VIEW`, `ENABLE_MESSAGE_REACTIONS`, `AUTO_READ`, `VPS`, `STICKER_AUTHOR`) |
| `secret` | bool | write-only; snapshot exposes `{ set, last4 }` only (FR-017); registered with the log redactor; encrypted at rest when stored (4.2). Secret values must be at least 8 characters (the redactor ignores shorter ones) |
| `mask` | enum | `last4` (default), `scheme` (`DATABASE_URL` shows the scheme only), `url` (credentials, query and fragment stripped), `none` |
| `effect` | enum | `immediate` (next message), `restart` (needs the in-process restart: `ALWAYS_ONLINE`, `BAILEYS_LOG_LVL`, the interval singletons), `boot-only` (startup setting, read-only in the panel, file/environment only; the `inactive` entries are `boot-only` by convention) |
| `readonly` | bool | true when `effect = "boot-only"` (which covers every `inactive` entry) and for executable paths (`YTDLP_PATH`, U11); the API refuses a write |
| `inactive` | bool | **flag** (`inactive: true`): no code reads the key today (U8, about 20 keys: `SESSION_ID`, `AUTO_READ`, `STATUS_SAVE_FOLDER`, `ANTI_DELETE`, `VPS`, `GROQ_API_KEY`, the deployment-host keys...); kept in the catalog so SC-002 holds. The UI shows these entries read-only in the folded group "sans effet aujourd'hui", whose theme id `inactive` is a display group only, set on exactly the flagged entries (rule stated once in [settings-catalog.md section 4](contracts/settings-catalog.md#4-themes)) |
| `source` | enum | `env` (override row over environment/file/default), `model` (an existing settings row), `file` (`data/status_save.json`) |
| `adapter` | string or null | for `model`/`file`: an adapter id (the catalog stays data only). The implementation, registered by id in `lib/admin/services/settings.js`, is `{ cacheKeys, read(), write(value) }` calling the same code as the commands, then `settingsCache.invalidate(key)` for every cache key; the matching env keys (`AUTO_RESPONDER_ENABLED`, `AUTO_RESPONDER_IGNORE_NUMBERS`, `AUTO_RESPONDER_PERSONALITY`, `AUTO_STATUS_SAVE`, `STATUS_SAVE_LIST`) are only seeds for the row or file |
| `confirm` | string or null | extra confirmation (clearing `SUDO`: "plus personne ne pourra utiliser les commandes réservées", scenario 5) |
| `testService` | string or null | API-key test target (FR-022); null for services that cannot be verified (Alpha Vantage) and for unused keys |

Adapter-backed rows: `AutoResponder` (`enabled`, `ignoreNumbers`, `personality`; key `auto_responder`), `AntiDelete` (`enabled`, `antiDelMode`, `antiDelJid`; key `anti_delete`), `ViewOnce` (`enabled`, `vvMode`, `vvJid`; key `view_once`), `data/status_save.json` (`enabled`, `list`). The tuning keys `AUTO_RESPONDER_MIN_DELAY` etc. are ordinary `env` settings.

**Resolved snapshot** returned to the panel (per key): `{ key, source, value (non-secret) | { set, last4 }, default, origin: "default" | "env" | "override", canRevert, version, problem?, pendingRestart }` (full view: settings-catalog.md 2.4). `origin` says where the effective value comes from: `override` (a `SettingOverride` row; for adapter-backed entries, the value stored by the bot in its row or file, set from the panel or from a WhatsApp command), `env` (environment/file) or `default`. There is no `store` or `panel` origin value: `source` (`model` / `file`) and `canRevert` (false for adapter-backed entries) carry that distinction, and the UI labels `override` "panel" for `source: env` entries. Resolution per key: an override row if present; else `process.env[env]` if non-empty and valid; else the default. An invalid file value falls back to the default and is recorded in `problems[key]` (edge case "valeur invalide déjà présente dans le fichier"). `pendingRestart` is true when `effect = "restart"` and the resolved value differs from `inForce[key]`, a snapshot taken at boot and after each in-process restart (FR-016). Startup settings (R5): `ADMIN_PANEL`, `PANEL_HOST`, `PANEL_PORT`, `PANEL_PUBLIC_URL`, `PANEL_TRUST_PROXY`, `LOG_FORMAT`, `SUPERVISED`, `UPDATE_CHECK`, `DATABASE_URL`, `DATABASE_SSL`, `YTDLP_PATH`; `PANEL_TOKEN` stays an editable secret (Bearer of the legacy `POST /api/restart`). The old `PANEL_ENABLED` is ignored and removed from the example (U2); when it is present in the environment, one console line at boot says it is no longer read (U18).

### 4.2 Secrets at rest (U9, C1 of research.md)

`secret: true` settings stored by the panel are written to `SettingOverride.value` as `enc:v1:<iv>:<tag>:<ciphertext>` (AES-256-GCM, `node:crypto`; 12-byte iv, 16-byte tag, each part base64url) by `lib/utils/secretBox.js`. The key is 32 random bytes in `data/panel.key`, created with mode 0600 on the first secret write; `data/` is already a gitignored Docker volume. The ciphertext is bound to its row by using the setting `key` as the GCM additional authenticated data (a proposal beyond research C1: it stops a ciphertext from being copied onto another row). When the key file is missing or a value fails to decrypt, the override is ignored (environment/file value applies), the setting shows "à ressaisir" and one error is logged. A new key is generated only on the next secret write; values encrypted under the lost key stay "à ressaisir" until overwritten or reset. `data/panel.key` is not in backups; backups carry decrypted values inside the passphrase-encrypted archive and a restore re-encrypts them with the target installation's key.

### 4.3 Backup archive (US10, FR-051 to FR-053, research C6)

File `openwabot-backup-<date>.owb`, produced and consumed as a stream (never buffered whole).

```text
offset  size       content
0       10         magic "OWBBACKUP\n"
10      4          uint32 big-endian: header length H
14      H          header JSON (UTF-8, plaintext)
14+H    n          ciphertext  = AES-256-GCM( gzip( NDJSON records ) ),  AAD = (4 length bytes || header bytes)
end-16  16         GCM authentication tag
```

| Header field | Value |
|---|---|
| `format` | integer, `1`; bumped only for container changes |
| `kdf` | `{ name: "scrypt", N: 65536, r: 8, p: 2, salt: hex(16 bytes) }`; about 64 MiB and 200 ms per attempt, `maxmem` 128 MiB |
| `cipher` | `"aes-256-gcm"` |
| `iv` | hex, 12 bytes |
| `check` | hex, 16 bytes: key-check value so a wrong passphrase is reported before decrypting everything |

Key derivation: `master = scrypt(NFKC(passphrase), salt, 32, { N, r, p })`; `encKey = hkdf-sha256(master, salt, "owb-backup/enc", 32)`; `check = hkdf-sha256(master, salt, "owb-backup/check", 16)`. The passphrase has at least 12 characters (FR-051) and is never logged or audited. The header carries only what decryption needs; the manifest is inside the encrypted stream, so the file leaks no counts. If `check` matches but the tag fails, the answer is "file altered or truncated"; tampering with the header also fails the tag (AAD).

NDJSON records, in this order:

| Record | Content |
|---|---|
| `{ t: "manifest", format, botVersion, createdAt, dialect, includesSession, counts: { Model: n }, files: [...] }` | summary shown before a restore (date, bot version, count per type) |
| `{ t: "rows", model, rows: [...] }` | batches of 500 rows ordered by primary key, built from model instances with `row.get({ plain: true })` (typed booleans, ISO dates, parsed JSON; never `raw:true`, which returns SQLite-isms) |
| `{ t: "file", name: "data/status_save.json", b64 }` | whitelisted file outside the database |
| `{ t: "blob", path, seq, last, b64 }` | 1 MiB chunks, media of non-final broadcasts |
| `{ t: "session", name, b64 }` | optional, one per file of `sessions/main/`, read as bytes and never parsed or logged; only after the explicit warning and confirmation (FR-051) |

**Exported models (25)**, in restore (dependency) order:

- group data: `Group`, `GroupEconomy`, `GroupRole`, `Filter`, `Warn`, `BannedChat`
- bot features: `AntiDelete`, `ViewOnce`, `AutoResponder`, `User`, `UserStats`, `NotifyKeyword`, `StickerCommand`, `Idea`, `Quote`, `Task`, `Reminder`
- panel configuration: `SettingOverride`, `CommandState`, `TextOverride`, `DailyStat`, `KnownChat`
- jobs: `Broadcast`, `BroadcastRun`, `BroadcastTarget`

**Excluded on purpose (7)**: `AdminAccount`, `AdminSession`, `AdminToken` (FR-051); `AuditLog` (U12); `AlertState`, `AlertOutbox` (per-installation); `Conversation` (U12: AI context with private message content, 30-day TTL). Also excluded: `data/panel.key`, saved-status media (nothing is stored), the pre-restore backups.

**Auto-increment tables needing a Postgres sequence reset after restore (14)**: `Filter`, `Warn`, `Idea`, `Quote`, `Task`, `Reminder`, `NotifyKeyword`, `StickerCommand`, `AntiDelete`, `ViewOnce`, `AutoResponder`, `Broadcast`, `BroadcastRun`, `BroadcastTarget`.

**Version rules** (FR-053):

| Case | Result |
|---|---|
| backup `botVersion` lower than the running bot | accepted; a model absent from the backup is emptied on restore (its state at backup time was empty); a column absent from a row takes the model default (nullable gives `NULL`); a key unknown to the current model is dropped and counted in the summary |
| backup `botVersion` higher than `config.VERSION` | refused with the reason (simple numeric `major.minor.patch` comparison, no `semver` dependency) |
| `format` higher than the code understands | refused |
| model in the backup that no longer exists in the code | ignored, counted |
| different database dialect on the two installations | accepted: rows are typed model-level JSON, applied with `bulkCreate` (explicit ids and `createdAt`/`updatedAt` kept, `hooks:false`) |
| `SettingOverride` rows | decrypted at export, re-encrypted at restore (4.2); unknown, `boot-only` and `readonly` keys dropped and counted; a value invalid in the catalog refuses the restore |

**Restore** is two steps and nothing changes before the second. (1) `inspect`: upload to `data/tmp/restore-<token>.owb` (mode 0600, size cap), derive the key, check `check`, stream-decrypt to the end (tag verified), parse every record, build and `validate()` every row (including STRING lengths for Postgres targets), compare versions; returns the summary and a `restoreToken` (15 minutes, bound to the admin session; the derived key stays in memory and is wiped on use or expiry). Refusals name the reason: wrong passphrase, altered file, unknown format, newer bot, invalid row (model, index, field). (2) `apply({ restoreToken, confirm })`: enter maintenance mode (the pipeline's `processMessage` returns early; engines and the stats flush skip; wait up to 10 s for in-flight handlers); write the pre-restore backup `data/backups/pre-restore-<ts>.owb` (keep the last 3); write `data/backups/restore.lock`; then ONE transaction: per model in order `destroy({ where: {} })` then `bulkCreate(batch)`; the GCM tag is verified (`final()`) **before** `COMMIT`, so a tampered or truncated file rolls everything back; on Postgres, reset the sequences; swap `sessions/main` by rename only after the commit (`data/backups/sessions-<ts>` keeps the old one); finally `settingsCache.clear()`, reload the settings store and text overrides, in-process restart, leave maintenance, write `backup.restore` to `AuditLog`. At boot, `data/tmp/` is swept and a leftover `restore.lock` logs "restore interrupted, previous state kept" (the database transaction was atomic; a half-swapped session directory is detected by `sessions/main` missing next to a `sessions-<ts>` and renamed back). `AdminSession` rows are untouched, so the admin stays logged in. A backup restored on two live installations can double-send pending `Reminder`s and broadcasts; the restore screen warns about it.

### 4.4 Files owned by the panel under `data/`

| Path | Content | Mode / lifetime | In backup |
|---|---|---|---|
| `data/panel.key` | 32-byte secret-box key | 0600, forever | no |
| `data/backups/pre-restore-<ts>.owb` | automatic backup before a restore | last 3 kept; storage-page category "sauvegardes du panel" | no |
| `data/backups/restore.lock`, `data/backups/sessions-<ts>/` | restore crash markers and the replaced session | removed at the end of a successful restore | no |
| `data/tmp/restore-<token>.owb` | uploaded restore file | 0600; swept at boot and after use | no |
| `data/admin-uploads/<id>.part` | streamed uploads (backup file, broadcast media) | 1 h TTL; one upload in flight per session; per-purpose cap and total quota | no |
| `data/broadcast-media/<broadcastId>/<name>` | the media of a broadcast | `once`: deleted 7 days after its run ends; recurring: while the broadcast exists (1.10, U15); Storage-page category "médias de diffusion" | yes for non-final broadcasts |
| `data/admin-reset` | empty marker: issue a reset link at next boot, then deleted | until boot | no |
| `data/status_save.json` | existing auto status save settings | existing | yes (whitelisted) |

### 4.5 In-memory structures and their bounds

| Structure | Module | Shape | Bound | Lifetime |
|---|---|---|---|---|
| Log ring | `lib/admin/logs/ring.js` | circular array `{ seq, ts, level, name, msg }` | **1000 entries**; `msg` at most 2000 characters and 12 stack lines; about 0.4 MB typical, 2 MB worst | process; "10 dernières erreurs" = last 10 entries with level >= error |
| Login limiter | `lib/admin/auth/rateLimit.js` | `Map<originKey, { fails: number[], blockedUntil }>`; window 15 min, threshold 5, block 15 min; separate bucket for wrong setup/reset tokens | 10 000 entries, oldest evicted | process; a restart only resets counters (optional rehydration from `audit_logs`, 1.7) |
| Session cache | `lib/admin/auth/sessions.js` | `Map<idHash, session>` | at most 10 live sessions; 60 s TTL | process |
| SSE hub | `lib/admin/http/sse.js` | set of response objects per topic (`state`, `pairing`, `log`, `job`, `session`) | 5 streams per session, 20 total; a client with `writableLength` above 1 MiB is dropped; heartbeat 15 s | per connection |
| Settings store | `lib/utils/settingsStore.js` | resolved values, `inForce` snapshot, `problems[key]`, last-known versions of reset keys | one entry per catalog key (about 100) | process; reloaded on restart/restore |
| Text overrides | `lib/utils/language.js` | `overrides[lang]: Map<key, text>` | at most 2 x 1004 entries | process; reloaded on write/restore/restart |
| Command state | `settingsCache` key `command_state` | `{ global: Set, byGroup: Map }` | commands x groups with a row | 5 min TTL, invalidated on write |
| Stats buffer | `lib/utils/stats.js` | `Map<day|metric|subject, n>` | distinct (metric, subject) pairs seen in 30 s, i.e. commands + groups + 2 | flushed every 30 s and on shutdown |
| Alert error window | `lib/utils/alerts.js` | timestamps of command errors, last 10 min | cleared at 10 entries | process |
| Known-chat touch map | `plugins/knownchats.js` | `Map<jid, lastTouchMs>` | entries older than 1 h dropped on write | process |
| Group metadata cache | admin groups service | names, member count, bot-admin flag from `groupFetchAllParticipating()` | one entry per group (500 groups in under 2 s, edge case) | 60 s |
| Pairing / QR state | `lib/baileys/client.js` | `state = { status, qr, qrAt, me, registered, lastClose, since }`, `status` in `idle`, `connecting`, `qr`, `open`, `reconnecting`, `stopped`, `logged_out` | one object | process; the QR string and pairing code are credentials: authenticated endpoint only, `Cache-Control: no-store`, registered with the redactor for 5 min, never logged; pairing code requests limited to one per 30 s, pairing window 3 min |
| Restore tokens | `lib/admin/backup/restore.js` | `{ restoreToken, derived key, summary, sessionIdHash }` | one active restore | 15 min |
| Upload registry | `lib/admin/http/uploads.js` | `{ uploadId, purpose, size, mime, sessionIdHash, createdAt }` | one in flight per session, quota | 1 h TTL |
| Hash/KDF gate | `lib/admin/auth/password.js` | counter and queue | 1 scrypt in flight, queue of 4, then HTTP 429 (each login hash is about 32 MiB, each backup KDF about 64 MiB) | process |
| Key-test cooldown | `lib/utils/cooldown.js` | `hit("panel", "keytest:<service>", 10000)` | one entry per service | existing helper |
| Maintenance flag | `lib/admin/maintenance.js` | boolean + in-flight handler count | 1 | during a restore |
| Anti-delete cache | `lib/utils/antiDeleteHandler.js` (existing) | `Map` of messages | 100 messages per chat, 1 h TTL; only its size and a purge (`clearCache()`, new) are exposed, never its content | process |

SC-009 is met only if every structure above stays bounded: the panel's budget is under 50 MB of added memory, the plugin-loaded baseline measured about 167 MB RSS.

---

## 5. Summary

| Model | Table | New / existing | In backup | Retention |
|---|---|---|---|---|
| AdminAccount | `admin_accounts` | new | no | forever |
| AdminSession | `admin_sessions` | new | no | 24 h idle, 7 days absolute; hourly sweep |
| AdminToken | `admin_tokens` | new | no | 30 min validity; purged 1 day after expiry |
| SettingOverride | `setting_overrides` | new | yes (secrets decrypted inside the encrypted archive) | until reset by the owner |
| CommandState | `command_states` | new | yes | stale rows kept until removed |
| TextOverride | `text_overrides` | new | yes | forever |
| AuditLog | `audit_logs` | new | no | 180 days, 20 000 rows (`login.success` exempt from the row cap) |
| DailyStat | `daily_stats` | new | yes | 90 days (panel shows 7) |
| KnownChat | `known_chats` | new | yes | private chats silent > 365 days |
| Broadcast | `broadcasts` | new | yes (+ media of non-final) | until deleted; `once` rows 90 days after last run; `once` media 7 days after its run ends (recurring: while it exists) |
| BroadcastRun | `broadcast_runs` | new | yes | 90 days after `finishedAt` |
| BroadcastTarget | `broadcast_targets` | new | yes | with its run |
| AlertState | `alert_states` | new | no | `login_blocked:*` rows 24 h; others forever |
| AlertOutbox | `alert_outbox` | new | no | 7 days after resolution; `pending` > 24 h expires |
| Group | `groups` | existing | yes | existing (deleted with the group's settings on request) |
| GroupEconomy | `group_economy` | existing | yes | existing |
| GroupRole | `group_roles` | existing | yes | existing |
| Filter | `filters` | existing | yes | existing |
| Warn | `warns` | existing | yes | existing |
| BannedChat | `banned_chats` | existing | yes | existing |
| AntiDelete | `anti_delete` | existing | yes | existing (row id 1) |
| ViewOnce | `view_once` | existing | yes | existing (row id 1) |
| AutoResponder | `auto_responder` | existing | yes | existing (row id 1) |
| User | `users` | existing | yes | existing |
| UserStats | `user_stats` | existing | yes | existing |
| NotifyKeyword | `notify_keywords` | existing | yes | existing |
| StickerCommand | `sticker_commands` | existing | yes | existing |
| Idea | `ideas` | existing | yes | existing |
| Quote | `quotes` | existing | yes | existing |
| Task | `tasks` | existing | yes | existing |
| Reminder | `reminders` | existing | yes | existing |
| Conversation | `conversations` | existing | **no** (U12) | existing, 30-day purge |

14 new + 18 existing = 32 models; 25 in the backup, 7 excluded (3 admin, `AuditLog`, 2 alert tables, `Conversation`).

---

## 6. Decisions taken (formerly open points)

No question for the user remains in this document.

**D1. Manual "retry failed" for broadcast targets. Resolved: U14.** Option (a). There is no retry route, no retry transition and no automatic retry: a target caught mid-send by a crash is `failed/interrupted` and may have been delivered, so it is never re-sent implicitly (FR-048, SC-012). The run report offers "new broadcast to the failed destinations": a pre-filled new broadcast, built by the UI from the report and submitted through the existing create route, which the owner confirms like any other (2.3, 2.4; API: BC-10 and BC-3).

**D2. Broadcast media retention and visibility. Resolved: U15.** Option (a). The media of a `once` broadcast is deleted 7 days after its run ends (long enough to build the pre-filled broadcast of D1); the media of a recurring broadcast is kept while the broadcast exists; "broadcast media" is a Storage-page category that can be emptied, and the emptying never touches media that may still be sent (1.10, 1.15, 4.4; runtime.md section 14).

---

## 7. Inconsistencies resolved between the research files

| # | Topic | Files | Choice |
|---|---|---|---|
| 1 | `SettingOverride.value` format: "JSON scalar" (C1) or the raw environment string (A1) | C1 vs A1; research.md R2 only fixes the table name | Raw environment-format string: one catalog parse/validate path for the file and the panel, boolean flags stay "true only for the exact string", `''` stays distinguishable from "no row". Secrets are `enc:v1:` strings either way. |
| 2 | Admin tables' columns: `uiLang`/`theme` columns (C1) vs `prefs` JSON (B3, B9); `kind` (C1) vs `purpose` (B3); `csrfSecret`/`origin`/`userAgent` (C1) vs `csrf`/`ip`/`uaShort`/`expiresAt` (B4) | C1 vs B | C1's names (C1 is the data-model stream and research.md refers to it). `expiresAt` is derived (`lastSeenAt + 24 h`, `createdAt + 7 d`), not stored. |
| 3 | Session lifetime: housekeeping in C1 only purges the 24 h idle clause | C1 vs U11 | Absolute 7-day cap added to the purge and to the session rules (1.2, 1.15). |
| 4 | Login throttle store: counts `login.failure` rows (C8) vs in-memory map (B6) | C8 vs B6; research.md section 3 lists B6 | In-memory limiter (B6). The `(origin, createdAt)` index of C1 is kept for new-origin detection and optional boot rehydration. |
| 5 | Table names and columns: `command_state` (A4) vs `command_states` (C1); `text_overrides(lang,key,value,baseHash)` (A3) vs `(key,lang,text,originalHash)` (C1); `daily_stats(day,kind,key)` with kinds `msg/cmd/cmd_fail/group` (A7) vs `(day,metric,subject)` with `messages/cmd_ok/cmd_fail/group_msgs` (C1, C8); `Setting` (A1) vs `SettingOverride` | A vs C | C1/C8 (research.md R2 already renames A's `Setting`). Hash of the original text: SHA-1 (A3) truncated to 16 hex characters (C1 width). |
| 6 | Module names: `broadcaster.js` (R1) vs `broadcast.js` (C4); `settingsStore.js` (R1) vs `lib/settings/store.js` (A1); `stats.js` (C8) vs `usageStats.js` (A7); `audit.record(req, ...)` (B, cross-stream contracts) vs `audit.record({...}, { transaction })` (C8) | R1, A, B, C | R1 where it names the module; `stats.js`; the C8 `audit.record` signature, because the economy adjustment needs the `transaction` option. The catalog is at `lib/utils/settingsCatalog.js` (runtime.md 17, row 14; A1's `lib/settings/` is not used). |
| 7 | Session cap: 10 (B4) vs 20 (D8 "e.g."); SSE clients 5 per session / 20 total (B7) vs 10 (D8 "e.g.") | B vs D | B's numbers (specific, D8 was illustrative). |
| 8 | Pacing field: C4 reads `run.spacingMs` but `BroadcastRun` (C1) has no such column | C4 vs C1 | The engine reads `Broadcast.spacingMs` through `broadcastId` (an edit applies to the next send; the 2 s floor is applied at send time too). |
| 9 | "Dashboard last 10 errors": error ring of 100 fed by `onError` (A7) vs last 10 log-ring entries of level >= error (B8) | A7 vs B8 | B8 (the log ring is the single source; no second ring). |
| 10 | Alert type and toggle names: C7 ids (`errors_series`, `reconnected`) vs `ALERT_*` keys of A Appendix B (`ALERT_ERROR_BURST`, `ALERT_RECONNECT`) | C7 vs A | Both kept; the mapping is fixed in 1.14. All default to `true` (U12 overrides A Appendix B's "to be decided"). |
| 11 | `AlertState` "forever" (C1) vs unbounded `login_blocked:<origin>` keys | C1 | Prefix pruned after 24 h (1.13, 1.15). |
| 12 | `AuditLog` row cap of 20 000 can evict `login.success` rows that FR-061's "origin jamais vue" relies on | C1/C7 | `login.success` exempt from the row cap (at most 500, 180 days). |
| 13 | Catalog entry vocabulary: effect `boot` (here, runtime.md) vs `boot-only` (settings-catalog); `inactive` as flag vs theme; origin `panel` / `store` vs `override`; adapter object vs id; key `LANG` vs `BOT_LANG`; catalog path `lib/settings/catalog.js` vs `lib/utils/settingsCatalog.js` | data-model 4.1, settings-catalog 1, runtime 1 | One vocabulary: effect `immediate \| restart \| boot-only`; `inactive` is a flag (display group `inactive` only for flagged entries); origin `default \| env \| override` with `source` and `canRevert` instead of `store`; adapter id string; key `BOT_LANG` with `configProp` `LANG`; path `lib/utils/settingsCatalog.js` (runtime.md 17, row 14). |

Derived rules this document adds (not stated in a stream file, kept small and reversible): one live token per kind (1.3); `targetsReady=false` sweep (1.15); AAD = setting key in the secret box (4.2); `SettingOverride` version continuity after a reset (1.4); "delete a former group's settings" scope (3.5); `mediaPath` set to NULL by the media retention rule (1.10, 1.15); media copied into the pre-filled broadcast of U14 (2.3); restriction of `TextOverride.lang` to `en`/`fr` (1.6).
