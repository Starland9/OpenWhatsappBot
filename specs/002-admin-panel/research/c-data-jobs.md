# Research C: data model, jobs (broadcast, recurrence), backup, alerts, stats, audit

Feature `002-admin-panel`, Phase 0. Scope: Key Entities, group/data FRs (FR-028..FR-032, FR-041..FR-049), backup (FR-050..FR-052), alerts (FR-060..FR-062), stats/audit (FR-033..FR-035), SC-011, SC-012, SC-015, SC-016. Authentication, settings registry, texts and UI live in sibling research files; their tables are listed here only so `data-model.md` is complete.

## Spike results (run on Node 24.20, SQLite 3.52 in-memory, models loaded from `lib/database/models`; nothing in the repo was changed)

| # | Fact | Consequence |
|---|------|-------------|
| S1 | `Model.findAll()` + `row.get({plain:true})` returns booleans as `true/false`, dates as JS `Date` (ISO via JSON), `JSON` columns parsed, `Idea.voters` as an array. `raw:true` returns SQLite-isms (`1`, `"2026-10-28 00:39:32.541 +00:00"`, JSON as text). | Backup export must use model instances + `get({plain:true})`, never `raw:true`. |
| S2 | `bulkCreate` keeps explicit `id`, `createdAt`, `updatedAt` (no `silent` needed); ISO strings are accepted for DATE; unknown keys are ignored; absent keys get the model default. SQLite autoincrement continues after the max imported id. | Restore = `bulkCreate` per model. Postgres sequences do NOT follow (see C6). |
| S3 | `Model.build(row).validate()` rejects `len`/`allowNull` violations (`Reminder.text` 501 chars, null `creatorJid`). | Restore "dry run" validates every row before any write. |
| S4 | On `:memory:` SQLite (tests) two concurrent `DATABASE.transaction()` calls fail with `cannot rollback - no transaction is active` (one connection). Plain concurrent `UPDATE ... WHERE status='pending'` is fine (5 racers: `[1,0,0,0,0]`). | Transactions in new jobs must be serialized in-process (mutex, same idea as `economy.withLock`, `scheduler.scheduleChain`); CAS claims need no transaction. |
| S5 | `INSERT ... ON CONFLICT (day,metric,subject) DO UPDATE SET count = daily_stats.count + excluded.count` works (7 after 3+4). `UPDATE ... SET balance = COALESCE(balance,0) + (-20) WHERE balance >= 20` affects 0 rows when short, 1 when exact. | Atomic stat upsert and balance guard are portable. |
| S6 | `crypto.scrypt` with N=2^15 needs an explicit `maxmem` (default limit 32 MiB). N=2^16,r=8,p=2 = 64 MiB, about 200 ms; N=2^17 = 128 MiB. `hkdfSync`, AES-256-GCM, gzip stream round-trip OK; wrong passphrase detected by a key-check value; a flipped ciphertext byte fails at `final()` ("unable to authenticate data"). | Format in C6. Keep N=2^16 (the host cap is 500 MB, ecosystem.config.js). |
| S7 | luxon: a local time inside a spring-forward gap resolves forward (Paris 02:30 on 2026-03-29 gives 03:30+02:00; Cairo 00:30 on 2026-04-24 gives 01:30+03:00). In a fall-back overlap it picks one instant (Paris 02:30 on 2026-10-25), never two. Day 31 of February is invalid. | Recurrence design in C5; one occurrence per local calendar day, always. |

## Findings that affect the plan

1. **No enforcement exists for `Group.antilink`, `Group.antibot`, `Group.mute`.** The columns are in `lib/database/models/Group.js:19-28`, only `ANTILINK_MSG`/`ANTIBOT_MSG` exist in `config.js:145-147`; `grep -rniE "antilink|antibot" plugins lib` finds nothing (001's `audit-findings.md:32` already says "unused?"). FR-029 and US6 ask the panel to set them. A switch without behavior breaks FR-030 (consistency with commands). Needs a decision (see the end).
2. `AntiDelete`, `ViewOnce`, `AutoResponder` are single DB rows (`id = 1`) written by `.antidelete`, `.vv`, `.ar` and read through cache keys `anti_delete`, `view_once`, `auto_responder` (`plugins/antidel.js:53`, `viewonce.js:53`, `autorespond.js:37,45`). Auto status save is a JSON file (`lib/utils/statusListStore.js:19-20`, `data/status_save.json`). So these settings already have a source of truth that is not `config.js`: the panel must edit those rows/files through the same code (settings registry adapter `source: model|file`), not duplicate them in `SettingOverride`.
3. **No reliable "private chat that wrote to the bot" record exists.** `User` is only written by `.afk` (`plugins/afk.js:194`), `Conversation` only by the AI auto-responder (30-day purge, `lib/utils/conversationManager.js:11`), `UserStats` is groups only (`plugins/trackmessages.js:11`). A new `KnownChat` table is required (C2).
4. `registry.notifyOwners` DMs the full stack to every owner on every command exception, with no throttle (`lib/plugins/registry.js:226-253`, called at `:310`). With SC-015 (100 errors in an hour, owners get one "errors in series" alert) this flood must be throttled (C7).
5. `classifyError` returns `service_unavailable` for 401/403 with a key (`lib/utils/http.js:249-250`) and has no service name, so "key refused" cannot be told from "service down" today (C7).

---

### C1. Data model: 14 new tables, 0 altered tables

**Decision.** Add 14 models, one file each in `lib/database/models/` (auto-loaded under the file name, `lib/database/index.js:13-19`). No column is added to an existing table, so the additive `sync()` rules are respected by construction (new tables are created by `model.sync()` at `lib/database/index.js:264-270`, including their composite primary keys and unique indexes, which are only forbidden on *existing* tables). No foreign keys (repo convention: none of the 18 models has one); cascades are done in the services, in one transaction. Timestamps are on unless stated.

| Model (table) | Fields (type, null/default) | Keys / indexes | Retention | In backup |
|---|---|---|---|---|
| **AdminAccount** (`admin_accounts`) | `id` INT PK (always 1); `passwordHash` STRING(255) not null (`scrypt$N$r$p$salt$hash`); `uiLang` STRING(2) default `fr`; `theme` STRING(8) default `auto`; `lastLoginAt` DATE null | PK id (single row by construction, FR-002) | forever | no (FR-050) |
| **AdminSession** (`admin_sessions`) | `idHash` STRING(64) PK (sha256 of cookie); `csrfSecret` STRING(64); `origin` STRING(64); `userAgent` STRING(200) null; `lastSeenAt` DATE not null | PK; index `lastSeenAt` | expired (24 h idle) purged hourly | no |
| **AdminToken** (`admin_tokens`) | `id` INT PK auto; `kind` STRING(8) `setup`/`reset`; `tokenHash` STRING(64) not null; `expiresAt` DATE; `usedAt` DATE null | UNIQUE `tokenHash` | purge 1 day after expiry | no |
| **SettingOverride** (`setting_overrides`) | `key` STRING(64) PK; `value` TEXT not null (JSON scalar); `version` INT default 1 (FR-020 compare-and-swap) | PK | row removed = back to file/default (FR-021) | yes (holds API keys, hence encrypted) |
| **CommandState** (`command_states`) | `command` STRING(64), `scope` STRING(255) default `*` (`*` = global, else group JID) | composite PK (command, scope); a row means "disabled" (global wins, FR-027) | stale rows kept, shown as "unknown command" | yes |
| **TextOverride** (`text_overrides`) | `key` STRING(160), `lang` STRING(8); `text` TEXT not null; `originalHash` STRING(16) not null | composite PK (key, lang) | forever | yes |
| **AuditLog** (`audit_logs`) | `id` INT PK auto; `action` STRING(48); `target` STRING(255) null; `origin` STRING(64) null; `result` STRING(12) default `ok`; `detail` TEXT null (sanitized JSON, 2000 chars max); `createdAt` only (`updatedAt:false`) | idx `createdAt`; `(action, createdAt)`; `(origin, createdAt)` (login throttle) | 180 days and 20 000 rows, pruned daily | no (security record, see C6) |
| **DailyStat** (`daily_stats`) | `day` STRING(10) (`YYYY-MM-DD`, bot TIMEZONE); `metric` STRING(16) (`messages`, `cmd_ok`, `cmd_fail`, `group_msgs`); `subject` STRING(255) default `''`; `count` INT not null default 0; no timestamps | composite PK (day, metric, subject) | 90 days | yes |
| **KnownChat** (`known_chats`) | `jid` STRING PK; `kind` STRING(8) `private`/`group`; `pnJid` STRING null; `name` STRING null; `firstSeenAt` DATE; `lastSeenAt` DATE; `leftAt` DATE null | PK; idx `(kind, lastSeenAt)`, `pnJid` | private rows silent > 365 days pruned | yes |
| **Broadcast** (`broadcasts`) | `id` INT PK auto; `kind` STRING(10) `once`/`recurring`; `title` STRING(100) null; `text` TEXT not null; `mediaKind` STRING(10) null (`image`/`document`); `mediaPath` STRING(255) null; `mediaName` STRING(255) null; `mediaMime` STRING(100) null; `mediaSize` INT null; `targets` JSON not null (array, 1..200 JIDs); `spacingMs` INT default 5000; `status` STRING(10) default `active` (`active`/`paused`); `runAt` DATE null (once); `recurKind` STRING(10) null (`daily`/`weekly`/`monthly`); `recurDays` STRING(20) null (`1,3,5` ISO weekdays, or `15`); `recurTime` STRING(5) null (`08:00`); `nextRunAt` DATE null; `lastRunAt` DATE null | PK; idx `(status, nextRunAt)` | with its runs | yes (+ media files of non-final ones) |
| **BroadcastRun** (`broadcast_runs`) | `id` INT PK auto; `broadcastId` INT not null; `dueAt` DATE not null (the occurrence); `status` STRING(10) default `scheduled` (`scheduled`/`running`/`completed`/`failed`/`cancelled`/`expired`); `total` INT; `targetsReady` BOOL default false; `startedAt`, `finishedAt` DATE null; `note` STRING(100) null (`late`, `stale`) | **UNIQUE `(broadcastId, dueAt)`**; idx `(status, dueAt)` | 90 days after `finishedAt` | yes |
| **BroadcastTarget** (`broadcast_targets`) | `id` INT PK auto; `runId` INT not null; `chatJid` STRING not null; `position` INT; `status` STRING(10) default `pending` (`pending`/`sending`/`sent`/`failed`/`cancelled`); `attempts` INT default 0; `leaseUntil` DATE null; `sentAt` DATE null; `messageId` STRING(64) null; `errorCode` STRING(40) null (code only, never raw text) | **UNIQUE `(runId, chatJid)`**; idx `(runId, status, position)`, `sentAt` | with its run | yes |
| **AlertState** (`alert_states`) | `key` STRING(96) PK; `lastSentAt` DATE null; `value` STRING(255) null; `count` INT default 0 | PK | forever (tiny) | no (per-installation rate limits) |
| **AlertOutbox** (`alert_outbox`) | `id` INT PK auto; `type` STRING(24); `payload` TEXT null (JSON, never a secret); `status` STRING(10) default `pending` (`pending`/`sent`/`expired`/`dropped`); `attempts` INT default 0; `sentAt` DATE null | idx `(status, createdAt)` | 7 days after `sentAt`; `pending` > 24 h becomes `expired` | no |

Alert toggles are settings (`ALERT_*` keys in `SettingOverride`), not a table. Per-chat "bot disabled" stays in the existing `BannedChat`. `Conversation` (AI context, private chat content, 30-day TTL) is left alone and excluded from backups (C6).

**Housekeeping.** One daily `unref`'d job in `lib/utils/housekeeping.js` (first run 2 minutes after boot, like `conversationManager.startPurge`, `lib/utils/conversationManager.js:48-57`) applies the retention column above, each statement idempotent and bounded:

```sql
DELETE FROM daily_stats      WHERE day < :today_minus_90;
DELETE FROM audit_logs       WHERE createdAt < :now_minus_180d;                -- then keep newest 20000
DELETE FROM admin_sessions   WHERE lastSeenAt < :now_minus_24h;
DELETE FROM admin_tokens     WHERE expiresAt < :now_minus_1d;
DELETE FROM alert_outbox     WHERE status <> 'pending' AND updatedAt < :now_minus_7d;
UPDATE alert_outbox SET status = 'expired' WHERE status = 'pending' AND createdAt < :now_minus_24h;
-- runs older than 90 days: targets first, then runs, then orphan broadcasts of kind 'once'
DELETE FROM broadcast_targets WHERE runId IN (SELECT id FROM broadcast_runs WHERE finishedAt < :now_minus_90d);
DELETE FROM broadcast_runs    WHERE finishedAt < :now_minus_90d;
DELETE FROM known_chats       WHERE kind = 'private' AND lastSeenAt < :now_minus_365d;
```

Writing these tables is cheap (a handful of rows per day) except `daily_stats` (about 100 commands + N groups per day) and `broadcast_targets` (up to 200 per occurrence); both are bounded by the 90-day window, so the worst case is a few tens of thousands of rows.

**Rationale.** Everything the spec's Key Entities describe fits these tables; keeping `Broadcast` (definition), `BroadcastRun` (occurrence) and `BroadcastTarget` (delivery) separate is what makes "exactly once per target and per occurrence" a pair of unique indexes. Generic `DailyStat(day, metric, subject)` needs one composite-PK table instead of one column per metric, and PKs on new tables are safe (UserStats and GroupEconomy already do it, `lib/database/models/UserStats.js:11-22`).

**Alternatives considered.** (a) One `Broadcast` table with embedded JSON of per-target results: no atomic per-target CAS, and an in-flight status write would rewrite a 200-entry blob. (b) Settings as columns of one `PanelSettings` row: adding a setting would need a column on an existing table, which `sync()` forbids unless nullable, and loses the per-key version. (c) Separate `EconomyLog` for balance reasons: rejected, `AuditLog` is the history the spec asks for (C3).

**Evidence.** `lib/database/index.js:21-35` (additive rules), `:185-211` (columns only if nullable/default), `:213-239` (indexes), `:255-286` (`sync()` creates missing tables with their indexes); composite PK precedent `lib/database/models/GroupEconomy.js:11-22`; `Reminder` status/lease columns `lib/database/models/Reminder.js:14-72`.

**Files impacted.** New: 14 files in `lib/database/models/`. `test/database.test.js` (new tables created, idempotent second `sync()`). No change to existing models.

---

### C2. Known chats, and the paths the panel must share with the commands

**Decision A (known chats).** New hook-only plugin `plugins/knownchats.js` (like `trackmessages`): `onMessage` with `hookPriority: { onMessage: 5 }` records a private chat the first time it writes (`!isGroup && !fromMe`, JID ending `@s.whatsapp.net` or `@lid`, never `status@broadcast`/newsletters) and refreshes `lastSeenAt` at most once an hour per JID (in-memory `Map`, like `knownRows` in `plugins/trackmessages.js:39-40`; DB write is a fire-and-forget `bulkCreate(..., {updateOnDuplicate})`). It stores `pnJid` (`message.sender`) so the picker de-duplicates a person seen as PN and as LID, and `name` from `message.data.pushName` when present. Being an `onMessage` hook it runs after the disabled-chat gate, so chats where the owner disabled the bot are not recorded, and pipeline.js is not touched (the "pipeline changes go in this file only" rule is respected). `onReady` (a) seeds an empty table from `Conversation.jid` and `User.jid` (non-group) and from every `groupJid` found in `Group`/`Filter`/`GroupRole`/`UserStats`/`Warn`/`GroupEconomy`/`Idea`/`Quote`, and (b) calls `groupFetchAllParticipating()` (at most every 6 h, plus the panel's refresh button, 60 s cache) to upsert group names, set `leftAt` for absent groups and clear it when the bot is back (feeds "ancien groupe", US6.5, and the broadcast destination list).

**Decision B (shared writes).** Every panel write goes through store functions in `lib/admin/stores/*.js` that are the only place knowing the (model, cache key) pair, and reuse the helpers plugins already export. Contract test: write through the store, read through the plugin's own reader, expect the new value without waiting for the 5-min TTL.

| Data | Model | Cache key and the call the panel must make | Existing helper to reuse |
|---|---|---|---|
| Group welcome/goodbye, antilink, antibot, mute, truth-dare | `Group` (`findOrCreate` + `update`) | `group:<jid>` -> `invalidateGroupSettings(jid)` | `plugins/setwelcome.js` exports `getGroupSettings`, `invalidateGroupSettings`, `findOrCreateGroup`, `renderTemplate` |
| Filters | `Filter` | `filters:<jid>` -> `invalidateFilters(jid)` | `plugins/addfilter.js` exports `loadFilters`, `invalidateFilters`, `normalizePattern`; limits (50/group, 100/1000 chars) are module constants, export them |
| Roles | `GroupRole` | `roles:<jid>`; `invalidateRoles` is NOT exported (`plugins/role.js:87`), use `settingsCache.invalidate("roles:"+jid)` or export it | `getRole` |
| Warnings (list, reset) | `Warn` (unique `(jid, groupJid)`) | none | reset = `Warn.destroy` as `plugins/warnuser.js` `resetWarnings` |
| Disabled chats | `BannedChat` | `banned_chats` -> `BANNED_CHATS_KEY` from `lib/core/pipeline.js` | same as `plugins/unbanchat.js:23` |
| AFK status | `User.afkReason/afkTime` | `afk_users` (a `Map` mutated in place by the plugin) -> `invalidate("afk_users")` after `User.update` | `plugins/afk.js:169` |
| Alert keywords | `NotifyKeyword` | prefix `notify:` -> `invalidatePrefix("notify:")` | `plugins/notify.js:30,69` |
| Sticker commands | `StickerCommand` | `sticker_cmds` -> `STICKER_CMDS_KEY` | `plugins/delcmd.js:50` |
| Tasks, ideas, quotes | `Task` / `Idea` / `Quote` | none (read from DB each time) | direct `destroy` |
| Reminders | `Reminder` | none | `scheduler.list({limit})` (no chat filter = all pending) and `scheduler.cancel(id)`, which is the idempotent CAS `status='pending'` (`lib/utils/scheduler.js:267-275`), so "cancelled is never sent" holds |
| Anti-delete, view-once, auto-responder | rows `id=1` | `anti_delete`, `view_once`, `auto_responder` | same code as the three commands (finding 2) |

**Rationale.** FR-030/FR-044 are a cache-coherence requirement: `settingsCache` serves reads for 5 minutes, so a panel write that forgets `invalidate` is invisible to the bot (CLAUDE.md: "a setter that writes a cached setting must call `settingsCache.invalidate(key)`").

**Alternatives considered.** Making the plugins call a new service layer (refactor of 15 plugins): too wide, 001 tests would churn. Panel code writing models directly with its own invalidations: rejected, the pair (model, key) would be duplicated in two places.

**Evidence.** `lib/utils/settingsCache.js:46-79,95-111`; invalidation sites listed in the table; `lib/core/pipeline.js:126` (banned gate), `:18` and `:272-279` (exported keys).

**Files impacted.** New `plugins/knownchats.js`, `lib/utils/knownChats.js`, `lib/admin/stores/*.js`. Small exports added to `plugins/addfilter.js`, `plugins/role.js`, `plugins/setwelcome.js` (no behavior change). Tests: `test/admin-stores.test.js`.

---

### C3. Economy adjustments (FR-042, US8 scenarios 2-3)

**Decision.** `lib/admin/stores/economy.js` calls the helpers exported by `plugins/economy.js` (`require("../../../plugins/economy")`, the same way `plugins/give.js` does), inside the same lock key and one transaction, and writes the reason to `AuditLog` in that transaction:

```js
// mode "add" (delta may be negative), reason 1..200 chars
economy.withLock(`give:${groupJid}`, () => DATABASE.transaction(async (transaction) => {
  if (delta > 0) await economy.ensureAccount(groupJid, userJid, transaction);   // INSERT OR IGNORE; never for a debit
  const ok = await economy.applyDelta(groupJid, userJid, delta,
    delta < 0 ? { minBalance: -delta, transaction } : { transaction });         // single UPDATE ... WHERE balance >= :n
  if (!ok) return { ok: false, error: "insufficient" };                         // refused: nothing was written (no account row either)
  const balance = await economy.getBalance(groupJid, userJid, transaction);
  await audit.record({ action: "economy.adjust", target: `${groupJid}:${userJid}`,
    detail: { mode: "add", delta, balance, reason } }, { transaction });
  return { ok: true, balance };
}));
// mode "set" to X >= 0: read `old` in the same transaction, then delta = X - old through the SAME guarded applyDelta;
// the audit entry stores delta, balanceAfter and reason. A concurrent gain or spend between read and write is kept
// (final = X + concurrent change, never below 0); the UI shows the real balance returned.
```

**Rationale.** `applyDelta` is already "one SQL statement that re-checks funds in its WHERE" (`plugins/economy.js:71-85`; spike S5), so two simultaneous `give`/`daily`/`dice` and a panel adjustment cannot overdraw or lose an update. Sharing the `give:<groupJid>` lock keeps multi-statement transfers and adjustments sequential in-process (on `:memory:` it is also what prevents the S4 failure). The spec's "history keeps the reason" has no existing ledger, and the spec defines the history as the admin history (FR-035), so the reason goes in `AuditLog.detail` (balance deltas are not secrets).

**Alternatives considered.** An absolute `UPDATE ... SET balance = :X` for "set": simplest but then the audit delta is a guess under concurrency. A new `EconomyLog` table: more schema, a second history screen. Moving the helpers to `lib/utils/economyStore.js`: cleaner dependency direction (lib -> plugins is new) but touches 001 code, so only recommended if reviewers object.

**Evidence.** `plugins/economy.js:24-41` (`withLock`), `:44-50` (`ensureAccount`, `ignoreDuplicates`), `:71-85` (`applyDelta`), `:87-100` (`debit`/`credit`), `plugins/give.js:81-100` (lock + `DATABASE.transaction`, transaction at `:83`), `lib/database/models/GroupEconomy.js:7-34`.

**Files impacted.** New `lib/admin/stores/economy.js`, `lib/utils/audit.js`. Tests: concurrent `Promise.all` of 20 `give` + 20 panel adds ends at the exact expected sum; adjustment to negative refused with zero writes.

---

### C4. Broadcast engine (US9, FR-045..FR-048, SC-012)

**Decision.** Do NOT generalize `lib/utils/scheduler.js` into job types. Add a sibling `lib/utils/broadcast.js` that copies its proven shape (single `unref`'d loop, `start(client)` idempotent, `tick(now)` test hook, `clientIsDown()` skip, compare-and-swap claims) and leave `scheduler.js` and its tests untouched. Started from a hook-only `plugins/adminjobs.js` `onReady` (the `plugins/reminder.js:142` pattern, idempotent on each reconnection).

**Delivery contract (at most once per target, never twice).** One send per tick, global FIFO by `run.dueAt` then `position`, so a single account is never hit by two campaigns at once.

1. **Gate (every tick, before sending).** Runs `scheduled` with nothing started and `now - dueAt > 1 h` become `expired` (`note='late'`), targets `cancelled`; runs `running` for more than 24 h are closed with the remaining targets `cancelled` (`note='stale'`, safety against sending a week-old announcement). Targets stuck in `sending` with `leaseUntil < now` (process died mid-send) become `failed`/`errorCode='interrupted'`; they are NEVER retried automatically because the message may have gone out.
2. **Pick.** `Run.findOne({status in (scheduled,running), targetsReady, dueAt <= now})`, then `Target.findOne({runId, status:'pending', order position})`.
3. **Pace.** Eligible only if `now - lastSendAt >= max(2000, run.spacingMs) * (1 + jitter)`, `jitter` drawn once per send in `[0, 0.2]` (it only lengthens the gap, so the 2 s floor of FR-047 always holds). `lastSendAt` is read once at start as `max(sentAt)` of `broadcast_targets` and kept in memory, so a restart cannot burst. Global gap across runs.
4. **Claim (CAS).** `UPDATE broadcast_targets SET status='sending', attempts=attempts+1, leaseUntil=now+60s WHERE id=? AND status='pending'`; only the caller that sees 1 affected row sends (spike S4: `[1,0,0,0,0]`). Cancellation is `UPDATE ... SET status='cancelled' WHERE runId=? AND status='pending'`, so it wins before any later claim; the one in-flight message completes and is reported `sent`.
5. **Send.** `sock.sendMessage(jid, {text})`, or `{image:{url:path}, caption}` / `{document:{url:path}, mimetype, fileName, caption}` (Baileys reads the file, no buffer in memory), wrapped in `withTimeout(30 s)`; socket read at send time from `client.getSocket()`; `clientIsDown()` is re-checked right before the claim, not after.
6. **Settle.** Success: `UPDATE ... SET status='sent', sentAt=now, messageId=? WHERE id=? AND status='sending'`. Error: `failed` with `errorCode` in `forbidden | not_found | timeout | connection_closed | error` (from Boom `output.statusCode` / `ETIMEDOUT`; raw text only goes through `safeLog`). `timeout` and `connection_closed` are flagged "may have been delivered"; the panel offers a manual "retry failed" with that warning, which is the only way a failed target returns to `pending`. A group the bot left fails here (`forbidden`/`not_found`) and the run goes on (edge case in the spec).
7. **Complete.** When no `pending`/`sending` remain: run `completed` (or `failed` when 0 sent), `finishedAt`, counts by `GROUP BY status`.
8. **Disconnection.** `tick` returns at once while `!client.ready()` (as `lib/utils/scheduler.js:290-292`); pending targets simply wait and resume paced after reconnection. A run that already started is not expired by a long outage (spec: "pauses and resumes"); only the 24 h safety applies.

**State machines** (every transition is a conditional `UPDATE ... WHERE status = <from>`; a lost race changes 0 rows and is ignored):

```
BroadcastTarget  pending --claim--> sending --ok--> sent
                    |                  |--error--> failed (errorCode)
                    |                  |--lease expired (crash)--> failed (interrupted)
                    |--cancel / run expired / stale--> cancelled
                 failed --manual "retry", admin only--> pending
BroadcastRun     scheduled --first claim--> running --no pending/sending left--> completed | failed (0 sent)
                 scheduled --now-dueAt > 1h, nothing started--> expired
                 scheduled|running --cancel--> cancelled        running --24 h--> cancelled (note=stale)
Broadcast        active <--pause / resume--> paused            (recurring only; "once" ends with its run)
```

The displayed state of a diffusion (programmée, en cours, en pause, terminée, annulée, expirée) is derived: the latest run's status, plus "en pause" when `Broadcast.status='paused'` or when the client is down while a run is open.

**Core statements** (identical on SQLite and Postgres, parameters bound by Sequelize):

```sql
-- first claim of a run
UPDATE broadcast_runs SET status='running', startedAt=:now WHERE id=:run AND status='scheduled';
-- claim: only the caller that sees changes() = 1 sends
UPDATE broadcast_targets SET status='sending', attempts=attempts+1, leaseUntil=:now+60s
 WHERE id=:id AND status='pending';
-- settle
UPDATE broadcast_targets SET status='sent', sentAt=:now, messageId=:mid WHERE id=:id AND status='sending';
-- crash recovery, every tick
UPDATE broadcast_targets SET status='failed', errorCode='interrupted'
 WHERE status='sending' AND leaseUntil < :now;
-- cancel a run (the in-flight target, if any, is left to finish)
UPDATE broadcast_targets SET status='cancelled' WHERE runId=:run AND status='pending';
UPDATE broadcast_runs    SET status='cancelled', finishedAt=:now WHERE id=:run AND status IN ('scheduled','running');
-- expiry gate
UPDATE broadcast_runs SET status='expired', note='late', finishedAt=:now
 WHERE status='scheduled' AND startedAt IS NULL AND dueAt < :now_minus_1h;
```

**Creation rules.** One-shot: insert `Broadcast` + `BroadcastRun` (`dueAt = runAt` or now) + up to 200 `BroadcastTarget` rows (`position`, status `pending`) and set `targetsReady=true` last, all inside the in-process mutex plus a transaction (S4). Destinations are validated server-side against `KnownChat` (`private` rows, excluding `BannedChat`; `group` rows with `leftAt IS NULL`), de-duplicated by `pnJid || jid`; any other JID is rejected, which makes arbitrary numbers impossible (FR-045). Media: stored under `data/broadcast-media/<id>/`, name sanitized and path checked to stay inside, type sniffed with `file-type` (image or document only), size capped by `MAX_UPLOAD`. Caption/text caps as constants (1024 with media, 4096 without).

**Rationale.** WhatsApp gives no idempotency key for `sendMessage`, so the send and the "sent" write cannot be atomic. FR-048 and SC-012 rank "never twice" above "always delivered", hence at-most-once with an explicit `interrupted` state, at most one uncertain target per crash because sending is strictly sequential. Reminders use at-least-once (lease expires and it is re-sent, `scheduler.js:23-24`), which is acceptable for one reminder but wrong for a 200-chat campaign. A target-level row with unique `(runId, chatJid)` also makes a second materialization of the same run harmless.

**Alternatives considered.** (a) Generic job-type scheduler: `Reminder` is one row = one send and has its own `missed` semantics (6 h, DM to creator); pacing, per-target state and recurrence do not fit, and changing it risks `test/hooks.test.js:511-620`. (b) Sleep between sends inside one tick: a 200-target run would hold `busy` for 17 minutes and cannot be tested with a fake clock. (c) Per-target `plannedAt = dueAt + i*spacing` with per-target expiry: an outage of an hour in the middle of a run would expire the rest, contradicting "resumes at reconnection". (d) At-least-once with retries: violates FR-048.

**Evidence.** `lib/utils/scheduler.js:15-34` (contract text), `:36-48` (constants), `:304-322` (`expireOverdue`), `:357-404` (`deliver`: claim, settle), `:414-436` (`tick(nowArg)`), `:457-469` (`start`); `lib/baileys/client.js:306-308` (`ready()`); `lib/utils/http.js:279-290` (`withTimeout`), `:306-317` (`safeLog`); `plugins/reminder.js:142-144`.

**Files impacted.** New `lib/utils/broadcast.js`, `plugins/adminjobs.js`, `lib/admin/stores/broadcast.js`. `scheduler.js` unchanged.

---

### C5. Recurrence (FR-049, SC-016)

**Decision.** Pure module `lib/utils/recurrence.js` (no clock, no DB): `validateRule(rule)`, `nextOccurrence(rule, afterMs, zone)` returning the first occurrence strictly after `afterMs`, `describe(rule, lang)`. Rule = `{kind:'daily'}` | `{kind:'weekly', days:[1..7]}` (ISO, Monday=1) | `{kind:'monthly', day:1..31}` plus `time:'HH:mm'`. Zone = `config.TIMEZONE` validated with `Info.isValidIANAZone`, falling back to UTC (same as `scheduler.js:87-90`; three lines duplicated rather than touching the scheduler). Algorithm: iterate calendar days from the local day of `afterMs` (max 400 steps), keep the day if the rule matches (monthly: `day === min(rule.day, daysInMonth)`, so "31" fires on the last day of shorter months), build the instant with `DateTime.fromObject({year,month,day,hour,minute},{zone})`, return the first instant `> afterMs`.

Verified outputs (spike): Paris daily 02:30 gives 03:30+02:00 on 2026-03-29 (gap, shifted forward, still exactly once that day) and a single 02:30 on 2026-10-25 (overlap, one instant); Cairo 00:30 gives 01:30+03:00 on 2026-04-24; monthly 31 gives 02-28, 03-31, 04-30, 05-31; weekly Mon/Wed steps 11-02, 11-04, 11-09; a rule evaluated at exactly its occurrence returns the next day (strict).

**Materialization (in `tick`, before delivery).** For each `Broadcast` with `kind='recurring'`, `status='active'`, `nextRunAt <= now`: loop (max 50 iterations) with `d = nextRunAt`. An occurrence late by more than 1 h (`now - d > 1 h`) is recorded as a `BroadcastRun` with `status='expired'`, `note='late'` and no targets (this is the "noted in the history" of FR-049); one within 1 h is materialized normally (run `scheduled`, targets `pending`). Each iteration advances the schedule with `UPDATE broadcasts SET nextRunAt=:next, lastRunAt=:d WHERE id=? AND nextRunAt=:d` where `next = nextOccurrence(rule, d, zone)` (CAS), then `INSERT run` plus the targets, all in one transaction behind the in-process mutex (S4); the loop ends when `nextRunAt > now`. The unique `(broadcastId, dueAt)` is a second guard (spike: `SequelizeUniqueConstraintError`), so even two bot processes on one database cannot create an occurrence twice. If the cap of 50 is hit (bot down for weeks), `nextRunAt` jumps to `nextOccurrence(rule, now)`. Pause = `status='paused'` (engine ignores it); resume recomputes `nextRunAt` from `now` (no catch-up burst); editing the rule or `TIMEZONE` recomputes `nextRunAt` from `now`; delete removes definition, runs, targets, media in one transaction.

**Rationale.** One local calendar day yields at most one instant, so DST can neither duplicate nor drop an occurrence; storing `nextRunAt` makes the engine query a single indexed range; `UNIQUE (broadcastId, dueAt)` turns "exactly once per occurrence across restarts" into a database invariant. Bot TIMEZONE is read at computation time (FR-049 says "fuseau horaire du bot"), and changing it is a recompute event.

**Alternatives considered.** Cron strings (`cron-parser` not a dependency, weekdays/monthly are the only shapes needed); a fixed 24 h step (drifts at DST); skipping the 31st in short months (surprising: a "monthly" message would silently disappear 5 times a year).

**Evidence.** `package.json:28` (`luxon ^3.7.2`), `lib/utils/scheduler.js:2,87-90,118-131` (luxon already used in the same way), spike S7.

**Files impacted.** New `lib/utils/recurrence.js` (+ `describe` keys in `lang/*.json` via `specs/.../i18n/broadcast.json` fragment).

---

### C6. Backup format and restore (US10, FR-050..FR-052, SC-011)

**Decision.** One file `openwabot-backup-<date>.owb`, produced as a stream and never buffered whole:

```
"OWBBACKUP\n" (10 B) | uint32 BE headerLen | header JSON (UTF-8, plaintext) | ciphertext | GCM tag (16 B)
header   = { format:1, kdf:{name:"scrypt",N:65536,r:8,p:2,salt:hex16}, cipher:"aes-256-gcm", iv:hex12, check:hex16 }
payload  = gzip( NDJSON )  encrypted with AES-256-GCM, AAD = (headerLen || header)
key      = scrypt(passphrase.normalize("NFKC"), salt, 32, {N,r,p, maxmem:128 MiB})  (async crypto.scrypt)
encKey   = hkdf-sha256(master, salt, "owb-backup/enc", 32);  check = hkdf(..., "owb-backup/check", 16)
```

The header only holds what is needed to decrypt; the manifest is inside the encrypted stream, so the file leaks no counts. `check` lets restore answer "wrong passphrase" before decrypting everything; if `check` matches but the tag fails, the answer is "file altered or truncated". Because the header is AAD, tampering with it also fails the tag.

NDJSON records, in this order:

1. `{t:"manifest", format, botVersion, createdAt, dialect, includesSession, counts:{Model:n}, files:[...]}`;
2. `{t:"rows", model, rows:[...]}`, batches of 500, ordered by primary key;
3. `{t:"file", name:"data/status_save.json", b64}` (whitelisted, it is not in the DB);
4. `{t:"blob", path, seq, last, b64}`, 1 MiB chunks, for the media of non-final broadcasts;
5. optionally `{t:"session", name, b64}`, one per file of `sessions/main/`, read as bytes and never parsed or logged.

Schema evolution: an older backup (lower `botVersion`) is accepted; a model absent from it is emptied on restore, a column absent from a row takes the model default (nullable gives `NULL`), a key unknown to the current model is dropped and counted in the summary. `format` is bumped only for container changes; a higher `format` or a higher `botVersion` is refused.

**Exported models**, in restore (dependency) order, 25 of them:

- group data: `Group, GroupEconomy, GroupRole, Filter, Warn, BannedChat`
- bot features: `AntiDelete, ViewOnce, AutoResponder, User, UserStats, NotifyKeyword, StickerCommand, Idea, Quote, Task, Reminder`
- panel configuration: `SettingOverride, CommandState, TextOverride, DailyStat, KnownChat`
- jobs: `Broadcast, BroadcastRun, BroadcastTarget` (after a restore the normal rules apply: a `sending` target whose lease is past becomes `failed/interrupted`, a not-yet-started run beyond its 1 h gate expires, a started run resumes where the backup left it and targets already `sent` stay `sent`; restoring the same file on two live installations can still double-send, the restore screen warns about it)
- plus the whitelisted file `data/status_save.json` and the media files of non-final broadcasts.

**Excluded, on purpose**:

- `AdminAccount`, `AdminSession`, `AdminToken` (FR-050);
- `AuditLog`: restoring an old backup must not erase what happened since;
- `AlertState`, `AlertOutbox`: per-installation rate limits and queue;
- `Conversation`: AI context holding private message content, 30-day TTL, rebuilt on use;
- saved-status media (it is forwarded to the owner, not stored, `lib/utils/statusSaver.js`).

Secrets in `SettingOverride` are included and protected by the passphrase; the export screen says so.

**Export.** Flush the stats buffer; read all tables inside one read transaction (consistent snapshot); per model `findAll({order: pk, limit: 500, offset})` then `row.get({plain:true})` (S1), Dates to ISO. Session only if `includeSession` and confirmed. Passphrase at least 12 characters (same rule as the admin password), NFKC-normalized. It is never written to the audit log (the audit entry holds counts and `includesSession` only). The builder returns a `Readable` (`rows -> NDJSON -> gzip -> cipher -> AppendTag transform`), so the same function feeds an HTTP response, a temp file, or the pre-restore backup.

**Restore (two steps, nothing changes before step 2).**
1. `inspect`: upload to `data/tmp/restore-<token>.owb` (0600, size cap), derive the key, check `check`, stream-decrypt to the end (tag verified), parse every record, build and `validate()` every row (S3) including STRING length for Postgres targets, tally counts, compare versions. Returns the summary (date, botVersion, counts, includesSession, ignored unknown models) and a `restoreToken` (15 min, bound to the admin session); the derived key stays in memory only, wiped on use or expiry. Refusals with reason: bad passphrase, altered file, `format` unknown, `compare(botVersion, config.VERSION) > 0` (newer bot, FR-052; simple numeric compare, no `semver` dependency), invalid row (model, index, field).
2. `apply({restoreToken, confirm})`: enter maintenance mode (pipeline `processMessage` returns early, engines and stats flush skip, wait up to 10 s for in-flight handlers); write the pre-restore backup `data/backups/pre-restore-<ts>.owb` (same exporter, same passphrase, includes the session only when the restore replaces it; keep the last 3); write marker `data/backups/restore.lock`; then ONE transaction: for each model in order `destroy({truncate:false, where:{}})` then `bulkCreate(batch, {hooks:false})`, a model absent from an older backup is emptied (its state at backup time was empty), unknown columns stripped, missing ones take model defaults (S2); Postgres only: after each auto-increment table `SELECT setval(pg_get_serial_sequence('"t"','id'), COALESCE(MAX(id),1), MAX(id) IS NOT NULL) FROM "t"`. The tag is verified (`final()`) BEFORE `COMMIT`, so a tampered or truncated file rolls everything back. Then session swap by rename (`sessions/main` to `data/backups/sessions-<ts>`, new dir in place), only after the DB commit. Finally: `settingsCache.clear()`, reload overrides/texts, in-process restart (the FR-013 service), leave maintenance, audit `backup.restore`. Boot sweeps `data/tmp/` and, if `restore.lock` exists, logs "restore interrupted, previous state kept" (the DB transaction was atomic; a half-swapped session directory is detected by `sessions/main` missing next to a `sessions-<ts>` and renamed back).

**Rationale.** AES-GCM gives confidentiality and integrity in one primitive and is in `node:crypto`; scrypt N=2^16, r=8, p=2 is one of the OWASP-listed memory-hard settings: about 200 ms and 64 MiB transient per attempt, fine for a rare operation and a brake on guessing (SC-009 is about idle memory). Model-level JSON through Sequelize is what makes SQLite and Postgres interchangeable (typed values come out the same, S1) and old backups loadable (S2). Streaming keeps memory flat whatever the size of `user_stats` or the session folder; GCM's late tag check is why the DB transaction must commit only after `final()`.

**Alternatives considered.** Copying `database.db` (not portable to Postgres, includes admin account); `pg_dump` (not for SQLite); a tar of files (needs a dependency or a hand-rolled format); chunked-AEAD (STREAM construction) so each chunk is authenticated on arrival: more code, and the transaction-commit-after-final already gives the same safety; reading the whole thing in memory: fine for 20 MB but a 200 MB broadcast media blob or a large session folder would not be.

**Evidence.** `lib/database/models/*.js` (the 18 existing models, no FK), `lib/database/index.js:255-286`; `plugins/economy.js` shows `DATABASE.transaction` use; `lib/utils/statusListStore.js:19-20` (file outside the DB); `ecosystem.config.js` (`max_memory_restart: 500M`); `Dockerfile:28` and `docker-compose.yml` (`data/` is a volume, so `data/backups` survives a redeploy; ephemeral hosts lose it, the UI says so); spikes S1, S2, S3, S6.

**Files impacted.** New `lib/admin/backup/{format,export,restore}.js`, `lib/admin/maintenance.js`. `lib/core/pipeline.js` (early return while in maintenance, one line, count of in-flight handlers). `lib/utils/stats.js` flush hook. Tests: `test/backup.test.js`: round trip on two in-memory DBs with a canonical-JSON comparison of every exported model (SC-011), wrong passphrase, one flipped byte (no row changed), truncated file, newer `botVersion`, older backup lacking a model and a column, unknown column, interrupted apply (stub `bulkCreate` to throw on the 3rd model: all tables unchanged), session files copied byte-for-byte without being opened. Cross-dialect proof: SQLite file to SQLite memory in CI, and an opt-in Postgres test enabled by `TEST_POSTGRES_URL` (the Postgres path is untested today, `CLAUDE.md`).

---

### C7. Alerts (US13, FR-060..FR-062, SC-015)

**Decision.** `lib/utils/alerts.js` exposes `raise(type, payload, {now})`, `recordCommandError(commandName, {now})`, `flush(client)`, `start(client)`. `raise` does, in order: (1) the type's toggle `ALERT_<TYPE>` (settings), (2) `getOwnerJids().length > 0` (else drop without consuming a rate limit; the panel shows "no recipient", FR-062), (3) the rate-limit CAS on `AlertState`, (4) insert into `AlertOutbox`, (5) `flush()` at once when `client.ready()`. `flush` runs on `onReady`, and every 30 s while connected: sends the text (rendered at send time with `getLang("alerts.<type>", ...)`) to each owner with `withTimeout`, marks `sent` when at least one owner received it, 3 attempts, `pending` older than 24 h becomes `expired`. Payloads carry service names, versions, durations, origin and times only, never a key or a stack.

**Rate limits are persisted CAS updates, so a restart cannot re-spam:**

```sql
-- ensure the row (bulkCreate with ignoreDuplicates), then try to take the slot
UPDATE alert_states SET lastSentAt = :now, count = count + 1
 WHERE key = :k AND (lastSentAt IS NULL OR lastSentAt <= :now_minus_window);   -- 1 row changed = allowed
-- once per version
UPDATE alert_states SET value = :version, lastSentAt = :now
 WHERE key = 'update_available' AND (value IS NULL OR value <> :version);
-- connection heartbeat (every 60 s while connected, and on "close")
UPDATE alert_states SET value = :iso_now WHERE key = 'conn_heartbeat';
```

| Alert | Trigger and hook | State key / window |
|---|---|---|
| Reconnected after > 5 min | `lib/core/pipeline.js` `attachHandlers` gains `client.on("close")` (record `conn_heartbeat = now`) and uses the existing `ready` handler (`pipeline.js:264`). While connected a 60 s heartbeat writes `AlertState('conn_heartbeat').value`; on `ready`, `now - heartbeat > 300 000 ms` raises with the duration. The heartbeat is what survives a crash or a PM2 restart. First boot (no row) raises nothing. | `reconnected`, 10 min (stops a flapping link from spamming) |
| 10 command errors in 10 min | `lib/plugins/registry.js` catch block (`:305-310`) calls `alerts.recordCommandError(entry.name)`; in-memory window of the last 10 min; at 10 entries it raises with the top commands (names and counts) and clears the window whether or not the rate limit let the alert through; exceptions only, not plugin-handled "service unavailable" replies | `errors_series`, 1 h |
| API key refused | `classifyError(err, {hasKey, service})` gains an optional `service`; in the branch `lib/utils/http.js:249-250`, when `hasKey !== false` and a `service` is given, it calls `alerts.raise("key_refused", {service})`. The 9 plugins that pass `hasKey` (chatgpt, gemini, imagen, imagesearch, music, news, reddit, voice, weather) add `service: "openai"` etc. | `key_refused:<service>`, 24 h |
| Login origin blocked | auth module (sibling research) calls `alerts.raise("login_blocked", {origin, at})` when it blocks | `login_blocked:<origin>`, 15 min |
| Login from a never-seen origin | auth module, after a successful login whose origin has no earlier `login.success` row for that origin (`AuditLog (origin, createdAt)` index) | none (origin becomes seen) |
| Update available | maintenance check calls `alerts.raise("update_available", {version})` | `update_available`, `value = last notified version`, CAS `WHERE value IS NULL OR value <> :v` (once per version) |

**Existing flood.** `registry.notifyOwners` must stop DMing a stack per exception: add `cooldown.hit(entry.name, "ownerdm", 10 min)` so an owner gets the first stack per command per 10 minutes (count shown in the "errors in series" alert). Without it SC-015 cannot hold, owners would receive 100 stack DMs plus the alert.

**Rationale.** Raising consumes the rate limit at creation time, not at send time, so an alert queued during a disconnection is neither duplicated nor lost (FR-062); the heartbeat plus `close` timestamp gives the outage duration even when the process itself died; no new HOOK_NAME is added to the registry (the `close` wiring sits in `attachHandlers`, which already owns `ready`).

**Alternatives considered.** Persisting the error window (rejected: a burst spanning a restart is rare and the persisted 1 h limit already prevents spam); inferring the service from the axios URL host inside `classifyError` (fragile for the `openai` and `@google/genai` SDK errors); alerting from every plugin (44 call sites).

**Evidence.** `lib/baileys/client.js:147-178` (`close`/`open` and `emit("close"|"ready")`), `lib/core/pipeline.js:264-267` (`ready` handler in `attachHandlers`), `lib/plugins/registry.js:226-253,305-310`, `lib/utils/http.js:228-250`, `lib/utils/permissions.js:69-77` (`getOwnerJids`), `lib/utils/cooldown.js` (`hit(user,key,ms)`).

**Files impacted.** New `lib/utils/alerts.js`, `lib/database/models/Alert*.js`. Edited: `lib/core/pipeline.js`, `lib/plugins/registry.js`, `lib/utils/http.js`, 9 plugins (one option each), `lang/en.json`+`fr.json` (`alerts.*`).

---

### C8. Statistics and audit log (FR-033..FR-035, SC-004, SC-015)

**Decision (stats).** `lib/utils/stats.js`: `count(metric, subject = "", n = 1, now)` increments an in-memory `Map`; a 30 s `unref`'d flush writes all pending counters in one multi-row `INSERT ... ON CONFLICT (day,metric,subject) DO UPDATE SET count = daily_stats.count + excluded.count` (S5, valid SQLite >= 3.24 and Postgres) and runs from the shutdown hooks like `ConversationManager` (`lib/utils/conversationManager.js:78-90`); a crash loses at most 30 s of counters. `day` is the local date in `config.TIMEZONE`. Counted at: `pipeline.processMessage` (`messages`, and `group_msgs` with the group JID for non-`fromMe` group messages, status broadcasts excluded) and `registry.executeCommand` (`cmd_ok` after `execute` resolves, `cmd_fail` in the catch block, subject = command name). Queries: 7-day messages `GROUP BY day`, top 10 `SUM(count) WHERE metric='cmd_ok' AND day >= :d GROUP BY subject ORDER BY 2 DESC LIMIT 10`, failures likewise, top groups. Pruned daily (`day < today-90`).

**Decision (audit).** `audit.record({action, target, origin, result, detail}, {transaction})`; actions are dotted (`login.success|failure|blocked`, `logout`, `setting.update|reset`, `command.toggle`, `group.update`, `economy.adjust`, `broadcast.create|cancel`, `backup.export|restore`, `restart`, `pair.*`, `session.logout`). `detail` for a non-secret setting is `{from, to}`; for a secret only `{secret:true, op:"set"|"clear"}`, built by one helper `auditDiff(settingDef, before, after)` so no caller formats a secret itself; a final guard strips any string matching `redact()` patterns (`lib/utils/http.js:293-303`). Login throttle (FR-005) counts `login.failure` rows by `(origin, createdAt)` over 15 min, so it survives restarts without another table. Retention 180 days / 20 000 rows.

**Rationale.** Counters via SQL upsert avoid the read-modify-write races that `trackmessages` avoids with `increment` (`plugins/trackmessages.js:133-139`) and cost one write per 30 s instead of one per message; one generic table keeps the schema stable when metrics are added. A single `auditDiff` entry point is what makes SC-004 testable: inject known secrets, run every panel action, then scan the `audit_logs` dump, HTTP responses and captured pino output.

**Alternatives considered.** Derive stats from `UserStats` (groups only, no per-day, no failures); one row per command call (millions of rows); log-file parsing for the audit trail (loses structure and survives secrets poorly).

**Evidence.** `plugins/trackmessages.js:6-20,133-139`, `lib/utils/conversationManager.js:36-46,78-90`, `lib/plugins/registry.js:256-310`, `lib/core/pipeline.js:200-215`.

**Files impacted.** New `lib/utils/stats.js`, `lib/utils/audit.js`. Edited `lib/core/pipeline.js`, `lib/plugins/registry.js`, `panel.js` shutdown path (flush).

---

### C9. Test design for the success criteria

All new jobs take `now` as a parameter (the `scheduler.tick(nowArg)` convention, `test/hooks.test.js:573`), use no timers in tests, and run on the in-memory database of `test/helpers/fakes.js`.

- **SC-012 (50 targets, restart).** Create 50 `KnownChat`s and one broadcast (`spacingMs 5000`, `runAt = t0`). Advance virtual time 5 s per `tick(t)`; assert one send per tick and gaps >= 5000 ms (from stored `sentAt`). After 20 sends: simulate the crash window in both ways (a target left in `sending` with an expired lease; a target whose send succeeded but whose `sent` update was made to throw), `broadcast.stop()`, fresh `start()`, keep ticking. Assert: no JID in `sock.sent` more than once; every other target exactly once; the interrupted one is `failed/interrupted` and never re-sent; counts sum to 50; 3 concurrent `tick(t)` produce 1 send; `ready=false` produces 0 claims then resumes; `cancel` after 10 sends leaves the rest `cancelled` and no further send; a run at `dueAt = now - 61 min` is `expired` with 0 sends, at `-59 min` it sends.
- **SC-016 (daily message, 7 occurrences, one during an outage).** Daily 08:00 in `Europe/Paris`; tick at each occurrence, skip ticking from D4 06:00 to 09:30, then tick: expect exactly 6 sends, 7 runs (6 `completed`, 1 `expired/late`), `nextRunAt` at D5 08:00; ticking the same instant twice or restarting the engine adds nothing (unique index). Pure unit tests of `nextOccurrence` for the DST dates and rules in C5.
- **SC-015.** 100 `recordCommandError` calls spread over 60 virtual minutes with the toggle on: exactly one `AlertOutbox` row and one DM per owner; a second burst more than 60 minutes after the first alert raises again; toggle off raises none; with the client down the row waits and is sent on `onReady`; restart (module reset, same DB) does not re-send.
- **SC-011.** Seed every exported model (including a `Conversation` row that must NOT come back), export, restore into a fresh DB, compare canonical JSON per model.
- **SC-004.** Secrets injected in every secret setting, then scan HTTP bodies, `audit_logs`, captured logs, `AlertOutbox.payload`, and a backup's manifest.

---

## Open points for the user (also in the hand-off)

1. **Anti-lien / anti-bot / mute have no enforcement today** (finding 1). Options: (a) implement them in this feature as a small hook-only `plugins/groupguard.js` using the existing `ANTILINK_MSG`/`ANTIBOT_MSG` (recommended: the spec lists them and a dead switch breaks FR-030); (b) keep the switches but label them "not enforced yet" (misleading); (c) remove them from the panel scope and edit FR-029.
2. **Throttle the per-error owner DMs** (`notifyOwners`, one stack per command per 10 min) so SC-015 can hold (C7). Recommended yes; the alternative is to reword SC-015 to count only alert messages.
3. Decisions taken, change on request: backup excludes `Conversation`, `AuditLog`, alert state, status media; monthly day 31 fires on the last day of short months; an in-flight broadcast target interrupted by a crash is marked failed ("may have been sent") and never retried automatically; alert toggles default to on.
