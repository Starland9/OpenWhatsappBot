# Phase 1: data model

All changes are **additive**. `lib/database/index.js#sync()` no longer uses `sync({ alter: true })` (on SQLite it turned composite unique keys into per-column UNIQUE constraints; on Postgres it piles up duplicate constraints). Each boot now creates missing tables, adds missing nullable/defaulted columns and missing indexes, and on SQLite rebuilds tables damaged by earlier `alter` runs (rows kept). Rules for new schema:
- new tables;
- new columns that are nullable or have a default;
- no new unique index on an existing table (it would fail on existing duplicates).

## New models (`lib/database/models/`)

### BannedChat (R13)

| Field | Type | Rules |
| ------- | ------ | ------- |
| `jid` | STRING, PK | group or private chat JID |
| `bannedBy` | STRING, nullable | JID of the owner who disabled the bot |
| `createdAt` / `updatedAt` | timestamps | |

Lifecycle: `.ban` creates the row (`findOrCreate`); `.unban` deletes it. Read through a cached set (`settingsCache` key `banned_chats`), invalidated on each change.

### Reminder (R17)

| Field | Type | Rules |
| ------- | ------ | ------- |
| `id` | INTEGER PK autoincrement | shown to the user for `cancel` |
| `chatJid` | STRING, not null | target chat |
| `creatorJid` | STRING, not null | mentioned on delivery |
| `text` | TEXT, not null | 1 to 500 characters |
| `dueAt` | DATE, not null, indexed | UTC |
| `status` | STRING, default `pending` | `pending`, `sent`, `cancelled`, `missed`, `failed` |
| `attempts` | INTEGER, default 0 | `failed` after 5 |
| `lastError` | TEXT, nullable | logs only, never shown to users |
| `sentAt` | DATE, nullable | |

State transitions:

```text
pending ──(dueAt reached, send ok)──────────────▶ sent
pending ──(send error, attempts < 5)────────────▶ pending (attempts+1, retry after backoff)
pending ──(attempts = 5)────────────────────────▶ failed
pending ──(cancel by creator/admin/owner)───────▶ cancelled
pending ──(found at startup, overdue > 6 h)─────▶ missed
```

Every transition is an `UPDATE … WHERE id = ? AND status = 'pending'`, so it is idempotent. Validation: at most 20 `pending` reminders per `creatorJid`, `dueAt` between now + 5 s and now + 1 year.

### Task (R17)

| Field | Type | Rules |
| ------- | ------ | ------- |
| `id` | INTEGER PK autoincrement | |
| `chatJid` | STRING, not null, indexed | per-chat list |
| `text` | TEXT, not null | 1 to 300 characters |
| `done` | BOOLEAN, default false | |
| `createdBy` | STRING, not null | delete and clear: creator, group admin or owner |
| `doneBy` | STRING, nullable | |

At most 100 tasks per chat.

### NotifyKeyword (R17)

| Field | Type | Rules |
| ------- | ------ | ------- |
| `id` | INTEGER PK autoincrement | |
| `userJid` | STRING, not null, indexed | who receives the alert by DM |
| `keyword` | STRING, not null | lower-cased, at least 3 characters, matched on word boundaries |
| `scopeJid` | STRING, not null | the group where the keyword was registered; alerts come only from that group |
| `enabled` | BOOLEAN, default true | |

Limits: 20 keywords per user. Delivery only if `userJid` is a member of `scopeJid` and is not the author; never from a private chat. Deduplication of 5 min per (user, keyword) in memory, with pruning.

## Modified models

### Group (R14)

| Field | Change |
| ------- | -------- |
| `goodbye` | **new** BOOLEAN, default false |
| `welcome`, `welcomeMsg`, `goodbyeMsg` | unchanged. Placeholders: `@user` (mentions every participant), `@group` (subject), `@desc` (description) |

### User (R12): no schema change, fields finally used

| Field | Use |
| ------- | ----- |
| `jid` | PK, phone-number JID (R9) |
| `afkReason` | TEXT, nullable; `null` with `afkTime` set means "AFK without a reason" |
| `afkTime` | DATE, nullable; `null` means not AFK |

### Filter (R15): no schema change

`pattern` is compared case-insensitively at runtime. Duplicates are avoided with `findOrCreate` (no unique index; see the constraint above). `isGlobal` stays unused.

### UserStats (R16): no schema change

Writes go through atomic `increment` (`messageCount`, `mediaCount`, `commandCount`, `xp`), and `level` is recomputed with `computeLevel(xp) = floor(sqrt(xp / 100))`. XP is 5 per text, 15 per media, 10 per command, with a 60 s cooldown per (user, group). Only groups are tracked.

### GroupEconomy: no schema change

All debits are conditional and atomic (`balance >= :n` in the `WHERE` clause), inside a transaction for `give` (debit plus credit). `daily` is a conditional `UPDATE` on `lastDailyAt` (24 h); its streak restarts at 1, not 0.

### GroupRole (R18): no schema change

The roles `muted`, `banned` and `vip` are enforced by `role.onMessage` and `role.onGroupParticipants` (actions only when the bot is admin).

## Settings caches (`settingsCache` keys)

| Key | Content | Invalidated by |
| ----- | --------- | ---------------- |
| `banned_chats` | Set of JIDs | `ban`, `unban` |
| `afk_users` | Map jid → {reason, time} | `afk`, AFK return |
| `filters:<groupJid>` | Filter list | `filter`, `delfilter` |
| `group:<groupJid>` | Group row (welcome/goodbye) | `welcome`, `goodbye` |
| `sticker_cmds` | Map hash → command | `setcmd`, `delcmd` |
| `view_once`, `anti_delete`, `auto_responder` | existing | `setvv`, `antidelete`, `ar` (**invalidation is missing today**) |
| `roles:<groupJid>` | Map jid → role | `role set` |
