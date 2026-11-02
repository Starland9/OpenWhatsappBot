# Research A: bot runtime (feature 003, Phase 0)

Scope: decision engine, `delegable` flag, `.vv`/`.save`, menu/help, tests, docs. Bot side only; the panel (HTTP, UI) and the data layer (tables, backup) are streams B and C. Clarifications and edge cases of `spec.md` are taken as final. Evidence is `file:line` at the start of branch `003-command-permissions` (7f20ca3). A throwaway spike (scratchpad, not in the repo) confirmed the identity shapes of section A5 and that a Map/Set lookup stays around 1 microsecond with 500 commands x 100,000 members.

## A1. New module `lib/utils/commandPermissions.js` (read side), API

**Decision.** One engine module, same family as `commandState.js`, exporting:

- `decide(entry, message, { isOwner }?) -> Promise<{ verdict, scope, mode }>` with `verdict` in `"owner" | "granted" | "closed" | "normal"` (frozen constants, `scope` is `"group" | "global" | null`). Never throws: any error returns `normal` (FR-011).
- `invalidate()` (drops the `command_perms` cache key), `MODES = { ADD: "add", ONLY: "only" }` (provisional names, stream B owns the stored values), `CACHE_KEY = "command_perms"`, `VERDICTS`.
- Stream B decides whether the write helpers live in this file (as in `commandState`) or in a store module; the contract is only "every write calls `invalidate()`".

`decide` is the single source for execution (A3) and for visibility (A11), which is what FR-028 asks ("selon la même décision que FR-006"). Callers never re-implement the rules.

**Rationale.** `commandState` is the proven pattern (one `getOrLoad` key, Map/Set indexes, fail-open, `invalidate()` on every write, `settingsCache.clear()` already called by restore and by in-process restart). A verdict (not a boolean) lets the registry apply the right message per case (silent, owner gate bypassed, normal).

**Alternatives.** (a) Merge into `commandState`: rejected, it would mix "disabled" (a hard stop for everybody, owner included) with "who may". (b) Boolean `isAllowed()`: rejected, the registry needs to tell "closed" (silent) from "normal" (today's messages) and "granted" (skip owner/admin gates).

**Evidence.** `lib/utils/commandState.js:30-31,50-75,87-98`; `lib/admin/backup/restore.js:663` and `lib/core/botRuntime.js:203` (`settingsCache.clear()`); `specs/002-admin-panel/contracts/runtime.md:279-303`.

**Files.** new `lib/utils/commandPermissions.js`; `lib/utils/settingsCache.js:8-11` (header comment: add `command_perms`).

## A2. FR-006 as an algorithm (the exact verdict function)

**Decision.** Pure function over the cached state and the message, in this order:

1. `isOwner` (computed once by the registry with `message.isSudo()`, passed in) -> `owner`.
2. `entry.delegable !== true` -> `normal`, **before touching the cache** (FR-014: a row on `eval` is never read, so a restored or hand-edited row cannot matter, SC-003).
3. `rules = state.byCommand.get(entry.name)`; none -> `normal`. `groupRule = message.isGroup ? rules.groups.get(message.jid) : null`; `globalRule = rules.global`; neither -> `normal`.
4. Listed in `globalRule` or in `groupRule` (A5) -> `granted` (scope = the rule that matched; global first). A global listing is a personal pass in every group (US3.4).
5. `mode = (groupRule || globalRule).mode`: the group rule wins as soon as it exists, whatever its mode (US3.3). `ONLY` -> `closed`.
6. Otherwise `normal` (covers `ADD`, where the command's own level decides).

State shape (one cache key, O(1) per message, built by one `findAll` per table, normalized at load):
`{ byCommand: Map<name, { global: Rule|null, groups: Map<groupJid, Rule> }> }`, `Rule = { mode, members: Set<normalizedJid> }`. `members` holds **both** the PN and the LID form of each beneficiary, so a message is tested with at most two `Set.has`. The loader skips unknown modes and members that normalize to `""`.

**Rationale.** Steps 1 and 2 first make the two security invariants (owner never locked out, non-delegable never opened) independent of the data. Keying by `entry.name` (first alias) is the `commandState` convention, so every alias and sticker goes through the same row.

**Alternatives.** A per-user index (`Map<jid, Map<command, ...>>`): rejected, the panel's reverse view ("who may use X here") is by command and the lookup is already O(1). Checking `delegable` at load time: rejected, the registry may not be loaded yet and a plugin reload would make it stale; checking at decision time with the live `entry` is free.

**Spec subtlety (for streams B and C).** US3.3 ("groupe A réglé en mode normal") can only be expressed by a stored group rule in mode `ADD` with an **empty list**, since "normal" itself is not stored and deleting the group rule falls back to the global `ONLY`. Rules in `ADD` mode with an empty list must therefore be allowed and must not be pruned. The engine handles them (step 5 returns `normal`).

**Evidence.** `spec.md` FR-006, US3 scenarios 3 and 4; `registry.js:121-136` (entry has `name`); `commandState.js:87-98`.

**Files.** `lib/utils/commandPermissions.js`.

## A3. Insertion in `registry.executeCommand`: order, silent refusal

**Decision.** Call `decide` right after `isOwner`, then thread `granted` through the existing gates. Final order:

1. `access = await commandPermissions.decide(entry, message, { isOwner })`.
2. `closed` -> log, `return true`, nothing else (no reply, no reaction, no `execute`, no stats, no bus topic).
3. Owner gate: `(fromMe || ownerOnly) && !isOwner && !granted` -> `common.owner_only` (unchanged text).
4. `commandState.isDisabled` -> `common.command_disabled` (unchanged; applies to granted people and owners too, US2.6).
5. `onlyGroup/adminOnly && !isGroup` -> `extra.group_cmd`; `onlyPm && isGroup` -> `common.pm_only` (unchanged, FR-008, also for granted).
6. `adminOnly && !isOwner && !granted && !isSenderAdmin()` -> `common.sender_not_admin` (granted skips the check, so no `isSenderAdmin()` round trip, FR-009). `isBotAdmin()` stays inside the plugins.

The banned-chat gate (FR-006 step 1, first half) already runs before the registry (`pipeline.js:129-131`), so a granted person in a disabled chat gets nothing (edge case).

Silent refusal details: `logger.info("Silent refusal (command permissions): <sender> -> <label> [<scope>]")`, deduplicated with `cooldown.hit(sender, "permlog:"+name, 60000)` (first per minute at `info`, the rest at `debug`) so a spammer cannot fill the 1000-entry log ring shown by the panel's Logs page. No new stats metric (`METRICS` is a frozen 4-entry set, adding one touches the DB and the panel), no new bus topic ("don't add topics casually"). `return true` keeps "a command matched" semantics, as for the other refusals.

**Rationale.** With no rule `decide` returns `normal` and the sequence is exactly today's (SC-004): owner gate, then disabled, then context, then admin. `closed` before the owner gate mirrors why the owner gate precedes `disabled` today (a refused person learns nothing). Putting `decide` before the owner gate also means non-delegable commands cost one `entry.delegable` test.

**Deviation from the literal FR-006 order (see open point 1).** FR-006 lists "disabled" first, but today the owner gate precedes it (`registry.js:291-299`, pinned by `test/command-state.test.js:186`) and SC-004 forbids changing that. So the verdict is computed first and "closed" wins over "disabled" for a non-listed person; every case that has a rule-less person or a listed person keeps FR-006's observable result.

**Alternatives.** Evaluate `closed` after `isDisabled`: leaks "command disabled" to people the command is hidden from, and breaks the "owner-only stay hidden" comment at `registry.js:296`. A reaction or a generic refusal: rejected by FR-007.

**Evidence.** `lib/plugins/registry.js:277-325` (esp. 289-317); `pipeline.js:129-131`; `test/command-state.test.js:186-191`; `lib/utils/stats.js:47`; `lib/utils/cooldown.js:31`.

**Files.** `lib/plugins/registry.js` (require + the block above).

## A4. Cache, invalidation, FR-010, FR-011

**Decision.** `getOrLoad("command_perms", load, 5 min)`, `getState()` returns `state || emptyState()`. Every write calls `invalidate()` (FR-010: the next message reloads, no restart). Restore and `restartBot` already `settingsCache.clear()`. Group-settings deletion in the panel (`services/groups.js:549` deletes `CommandState` rows by scope) must also delete the group's permission rows and invalidate (stream B).

Fail-open (FR-011): a load error leaves the cold state empty, so `decide` returns `normal`: owner-only commands stay owner-only (owner gate), "only" modes are not applied (the command falls to its normal level), grants are not applied. `settingsCache.getOrLoad` returns the **previous (expired) value** on a failed reload and `null` only when there is none; that last-known-good behavior is kept (shared by every cache) and the test pins the cold case. `decide` also wraps everything in try/catch.

**Rationale.** Identical semantics to `commandState`. The loader throws on error so a failure is not cached and the next message retries (same as `commandState`; a down database already breaks the bot).

**Alternatives.** Cache the failure as an empty state: rejected, a transient error would hide valid rules for 5 minutes.

**Evidence.** `settingsCache.js:45-78` (error branch 64-70), `94-99`; `commandState.js:66-70`; `lib/admin/services/groups.js:549,560`.

**Files.** `lib/utils/commandPermissions.js`; stream B writers.

## A5. Identity matching (FR-004): PN and LID

**Decision.** A message has two identities: `message.sender` (PN when Baileys gives one, otherwise the LID) and `message.senderLid` (the LID or null). A LID-only author has `sender === senderLid` (spike: `{from:"123456@lid", alt:null}`). Matching:

1. Fast path (no await): `ids = {normalizeJid(sender), normalizeJid(senderLid)} \ {""}`; granted when any id is in `rule.members`. Rows store the PN and, when known, the LID (Key Entities); the loader normalizes both and indexes both.
2. Slow path, only when the fast path misses **and** a non-empty rule applies **and** the message lacks one of the two namespaces: `await identitiesOf(message, id, groupMetadata)` and test the expanded set. This resolves LID->PN through group participants (`phoneNumber`, `lid`) and `signalRepository.lidMapping.getPNForLID`, so a rule saved with a PN only still recognizes a LID-only author, and a rule saved with a LID only recognizes a PN-only author when the group metadata lists both. Memoized per message in a module `WeakMap` (the menu evaluates ~80 commands for one message; no change to `Message`).
3. Never throws; failure of the slow path means "not listed" (the safe side: `only` -> closed, `add` -> normal level).

`identitiesOf` is currently private to `permissions.js` and must be exported (one line). Owner detection is unchanged (`isSudo()` matches both forms).

**Rationale.** Same approach as `toPnJid`/`guardTarget` and the existing tests ("an owner arriving as @lid with participantAlt"). The expensive part runs only for non-listed people on commands that actually have a non-empty rule; the group metadata is cached 60 s and already fetched by `isSenderAdmin`.

**Alternatives.** Persist only PN and always resolve at runtime: rejected (an extra async lookup per message for every rule). Compare `jidUser` digits: rejected, PN and LID user parts live in different number spaces; compare full normalized JIDs.

**Evidence.** `Message.js:52-74,203-205,459-463`; `permissions.js:17-30,73-77,93-114,182-193`; spike output; `test/permissions.test.js:202-227`.

**Files.** `lib/utils/permissions.js` (export `identitiesOf`), `lib/utils/commandPermissions.js`.

## A6. Sticker-bound commands

**Decision.** No special case. Pipeline step 7 rewrites `message.body = PREFIX + command`, sets `isCommand`, and calls the same `registry.executeCommand(message)` on the same `Message` (so `sender`/`senderLid` are the sticker's author). Rules therefore apply to the author exactly as if he typed the command (FR-003, edge case). A member sending a sticker bound to `.vv` is refused as today unless granted. The only other caller of `executeCommand` is step 9 (`pipeline.js:184,201`); no plugin or panel service calls `entry.execute` directly (grep).

**Not covered (document, same as 002 for `disabled`):** `onMessage` hooks (`afk`, `addfilter`, `notify`, `trackmessages`) and `handleButtonReply` handlers are not command dispatch; a rule on `.afk`/`.addfilter` does not stop their hooks, and a button reply on an old interactive message is not gated. Inner checks inside a plugin (`isSudo()`/`isSenderAdmin()` in `stats reset`, `idea`, `quote`, `reminder list all`, cooldown exemptions in `chatgpt`/`gemini`/`imagen`/`voice`) remain: a rule opens the command, not its sub-actions.

**Evidence.** `pipeline.js:175-190,200-201`; `plugins/stickercmd.js:55-80`; grep `executeCommand` (only `pipeline.js`); `plugins/stats.js:66`, `idea.js:200`, `quote.js:74`, `reminder.js:80`, `imagen.js:122`.

**Files.** none (test + doc note).

## A7. The `delegable` flag: declaration, normalization, default

**Decision.** A plugin declares `command: { ..., delegable: false }`. `registerCommand` destructures `delegable` and sets `entry.delegable`:

```js
delegable: typeof delegable === "boolean" ? delegable : !(fromMe || ownerOnly)
```

- Everything non-owner-only is delegable by default (FR-013).
- Owner-only commands are **non-delegable by default**; `.vv` and `.save` opt in with explicit `delegable: true`. Result today is exactly FR-013's list, and a future owner-only command (the next `eval`) cannot be opened by forgetting a flag.
- The 14 listed commands also get an explicit `delegable: false` (FR-012 says "déclarée dans son code"; it also survives someone dropping `fromMe`).
- A test pins the set of `delegable === false` plugin files to the FR-013 list and requires every `fromMe`/`ownerOnly` plugin to declare `delegable` explicitly (A12), so adding an owner-only command forces a conscious choice.

The flag is read by `decide` (A2) and exposed on the entry for the panel (stream B adds `delegable` next to `accessOf(entry)` in `lib/admin/services/commands.js:24-31`; the panel cannot change it).

**Alternatives.** A central list in `commandPermissions.js` keyed by file or name: rejected (drifts when an alias changes, far from the command; the spec wants the declaration in the command's code). Default `true` for owner-only: rejected (unsafe default).

**Evidence.** `registry.js:85-94,121-136`; `lib/admin/services/commands.js:24-31`; `plan.md` (16 owner-only, 14 non-delegable). No existing test pins the entry's key set (grep `rawPattern`).

**Files.** `lib/plugins/registry.js`, 16 plugin files (A8), `lib/admin/services/commands.js` (stream B).

## A8. Classification of every `fromMe`/`ownerOnly` plugin

Checked with `grep "fromMe: true|ownerOnly: true" plugins/*.js`: exactly **16** commands, no other owner-only command, and no plugin uses `ownerOnly` (all use `fromMe`). `admin-only` plugins (`kick`, `promote`, `demote`, `tag`, `warnuser`, `setwelcome`, `goodbye`, `addfilter`, `delfilter`) stay delegable by default (US1.5 accepts `.kick` with a panel warning).

| File | Pattern | Status | Edit |
| --- | --- | --- | --- |
| `eval.js` | `exec\|eval` | never delegable | add `delegable: false` |
| `update.js` | `update` | never delegable | add `delegable: false` |
| `exportcontacts.js` | `exportcontacts` | never delegable | add `delegable: false` |
| `banchat.js` | `ban` | never delegable | add `delegable: false` |
| `unbanchat.js` | `unban` | never delegable | add `delegable: false` |
| `viewonce.js` | `setvv` | never delegable | add `delegable: false` |
| `getvv.js` | `getvv` | never delegable | add `delegable: false` |
| `antidel.js` | `antidelete\|antidel` | never delegable | add `delegable: false` |
| `getantidel.js` | `getantidelete\|getantidel` | never delegable | add `delegable: false` |
| `autorespond.js` | `ar` | never delegable | add `delegable: false` |
| `statussave.js` | `statussave\|ss` | never delegable | add `delegable: false` |
| `stickercmd.js` | `setcmd` | never delegable | add `delegable: false` |
| `delcmd.js` | `delcmd` | never delegable | add `delegable: false` |
| `getcmd.js` | `getcmd` | never delegable | add `delegable: false` |
| `vv.js` | `vv` | **delegable** | add `delegable: true`, A9 |
| `save.js` | `save` | **delegable** | add `delegable: true`, A10 |

Hook-only modules (`trackmessages`, `knownchats`, `groupguard`, `buttons`, `pollplus`) have no command, nothing to flag.

**Evidence.** grep results above; `test/permissions.test.js:97-100` already lists the same 14 files plus `vv.js`/`save.js` as owner files.

**Files.** the 16 plugin files.

## A9. `.vv` delegated (FR-015, FR-017, FR-018)

**Decision.** In `plugins/vv.js`:

- `resolveDestination(message)`: owner -> unchanged. Non-owner -> **never read `view_once` settings**; destination = `message.isGroup ? (message.sender || message.senderLid) : message.jid`. In a private chat with the bot the requester's private chat is the chat itself, so it works with whatever addressing the chat uses; in a group it is the requester's PN (LID if no PN is known).
- Which JID: PN preferred, LID fallback, exactly like `.save`. Baileys 7 rc14 `relayMessage` handles `@lid` conversations (`isLid` branch, own LID used for addressing), and PN sends work today (owner `SUDO` numbers, `.save`); a LID-only author is the least tested case, so it goes in the real-device checklist.
- A send failure for a non-owner must not surface: wrap the `sendMessage` in try/catch (log with `safeLog`, return). Otherwise the registry replies `common.error` **in the group** and DMs the stack to the owner, which breaks the edge case "rien n'apparaît dans le groupe".
- Discretion (FR-018): not a view-once and download failure already return silently. The two remaining public outputs would break it for a delegated person: the **usage** reply when nothing is quoted (`vv.js:47-49`) and `MEDIA_TOO_LARGE` (rethrown at `vv.js:66`, the registry then replies in the chat). For a non-owner, send both to his DM, best effort (open point 2).

**Rationale.** The destination is derived from the requester, so no JID is trusted from the message body, and the owner path is byte-identical (FR-017).

**Alternatives.** Resolve PN through `toPnJid` before sending: unnecessary, `message.sender` is already PN whenever Baileys knows it. Keep the usage reply in the chat: reveals the delegation to the group.

**Evidence.** `plugins/vv.js:19-29,45-84`; `Message.js:52-57`; `node_modules/baileys/lib/Socket/messages-send.js:437,590-592`; `registry.js:328-333`.

**Files.** `plugins/vv.js`; header comment "(owner only)" at `vv.js:32`.

## A10. `.save` delegated (FR-016)

**Decision.** Nothing changes functionally: the inbox is already `message.sender || message.senderLid`, i.e. the requester (`save.js:40`), and the CLAUDE-documented behavior since audit 001 ("envoyé à celui qui lance la commande"). Add `delegable: true`. One hardening: the last fallback `|| getOwnerJids()[0]` (`save.js:40`) is dead code for an owner (an owner always has `sender`), but it would send a delegated person's media to the **owner** if a sender were ever empty; drop it (or limit it to `message.isSudo()`), keeping the `no_sudo` reply. The reactions and the text replies of `.save` stay in the chat as today (only the media destination is specified).

**Evidence.** `plugins/save.js:21,39-44`; `docs/AUDIT_COMMANDES.md:172`.

**Files.** `plugins/save.js`.

## A11. Menu and help (FR-028, FR-029)

**Decision.** Reuse `decide`; no second predicate in the engine.

- `help.js#getVisibleCommands(message)` becomes `async`: for each command `v = (await decide(cmd, message, { isOwner })).verdict`; skip `closed`; keep when `granted` or `isOwner` or `!isOwnerOnly(cmd)`. Callers: `menu.js:130`, `buttonmenu.js:41` and `:69` (add `await`). Menu does not filter by disabled/adminOnly/context today and still does not.
- New shared helper `help.js#findVisibleCommand(message, name)`: `getCommandByPattern(name)`, then `null` when the verdict is `closed`. Used by `help.execute` (`help.js:116`, falls into the existing `plugins.help.not_found` reply, so a closed command answers exactly like an unknown one) and `buttonmenu.sendCommand` (`buttonmenu.js:115`, same for `.bmenu <cmd>` and the `menu:cmd:<name>` button). Categories whose commands are all closed disappear (existing "not found" path).
- FR-029 trap: today `.help eval` from a non-owner **shows the card** (`help.js:116-122` never checks visibility, only the menu hides owner-only commands). The new helper only hides `closed`, never owner-only, so with no rule the help output is byte-identical. Do not "fix" that here.
- `describeAccess` is left untouched: a granted member sees "owner" on the `.vv` card; correct wording would be spec creep.
- No rule / failed load -> `normal` for all -> `owner || !isOwnerOnly` -> identical menu (count, order, text).

**Alternatives.** Keep `getVisibleCommands` synchronous with a peek at the cache: rejected (cold cache would show a wrong menu). Hide owner-only cards from non-owners in help: changes today's output (FR-029).

**Evidence.** `plugins/help.js:13-22,107-123`; `plugins/menu.js:129-131`; `plugins/buttonmenu.js:41,69,113-119,150-160`; no test calls `getVisibleCommands`/`isOwnerOnly` (grep), `test/admin-integration.test.js:540-541` and `test/texts.test.js:103` only read help cards.

**Files.** `plugins/help.js`, `plugins/menu.js`, `plugins/buttonmenu.js`.

## A12. Tests

No existing test needs to change (SC-004): `test/permissions.test.js` (owner-only refusals with no rule, `owner_only` text, SUDO empty, LID owner, 14+2 owner files list), `test/command-state.test.js:186` (owner gate before disabled), `test/pipeline.test.js`, `test/commands.test.js` (runs `.menu`, `.help`, `.vv`, `.save` with no rules; the DB is synced there, and an unsynced DB just fails open). Proposed new files (probe-plugin style of `command-state.test.js`: `registry._reset()` + probes, `fakes.makeMessage({from, lid, alt, group, admin, sticker, quoted})`, `fakes.syncDb()`, real models for rows; real plugins via `fakes.setup()` with spy `execute` as in `permissions.test.js`):

1. `test/command-permissions.test.js` (engine + registry):
   - every FR-006 branch as a table: owner (also in `ONLY` with empty list, by LID, listed) / listed global / listed group / group mode beats global mode / global pass inside a group `ONLY` / `ONLY` -> silent (no reply, no react, `execute` not called, no `cmd_ok`/`cmd_fail`, one log line) / `ADD` -> normal level (public runs, owner-only gives `owner_only`, admin-only gives `sender_not_admin`) / empty `ONLY` list / rule of group A inert in group D and PM / global rule in PM / empty `ADD` group rule overriding global `ONLY`;
   - FR-008/009: granted + `onlyGroup` in PM -> `extra.group_cmd`; granted + `onlyPm` in group -> `pm_only`; granted non-admin runs an `adminOnly` command without a `groupMetadata` call;
   - disabled wins: granted + disabled -> `command_disabled`; owner + disabled -> `command_disabled`; closed + disabled -> silent; banned chat via `pipeline.processMessage` -> nothing;
   - PN+LID: rule PN-only vs author LID+alt PN; rule with LID only vs PN+LID author; rule PN-only vs LID-only author resolved through group participants (`lidParticipants`); device suffix `:7`; unknown LID not granted;
   - FR-010: write through the setter, next message obeys, removal obeys, no restart; `settingsCache.clear()` rebuilds; a warm cache issues zero `findAll`; 500 rules x 1,000 decisions under a loose time bound;
   - FR-011: cold cache + `findAll` rejecting -> owner-only still `owner_only`, `ONLY` not applied, no throw;
   - SC-003: for each non-delegable real entry, insert `ADD` and `ONLY` rows by hand (also after a restore-like `clear()`): non-owner still gets `owner_only`, never silence, `execute` never called;
   - stickers: `processMessage` with a `sticker` + a `StickerCommand` row: granted author runs, closed author is silent, ungranted author on an owner-only command gets `owner_only`;
   - every alias of a command; an orphan row (unknown command) is inert.
2. `test/command-delegable.test.js`: the set of `delegable === false` files equals the FR-013 list; `vv.js` and `save.js` are `true`; every `fromMe`/`ownerOnly` entry declares `delegable` explicitly; a probe without the flag is delegable, an owner-only probe without the flag is not.
3. `test/vv-save-delegated.test.js` (stub `mediaAdapter.downloadMedia` via `getQuotedMedia`; `view_once` row in modes `p`, `jid`, `g`): owner `.vv` unchanged in each mode; delegated in a group -> one send to the requester's PN, none to the group, whatever `view_once` says; LID-only requester -> LID; delegated in PM -> `message.jid`; not view-once / download failure -> nothing anywhere; `sendMessage` rejecting -> nothing in the group, no `common.error`, no owner DM; usage and too-large go to the DM (if open point 2 is accepted); `.save` delegated -> inbox is the requester, never the owner, empty sender -> no fallback to the owner.
4. `test/help-menu-visibility.test.js`: with no rule, `buildMenu`/`help <cmd>`/`bmenu` output for owner, member, group admin (PM and group) equals the legacy formula (`getCommands().filter(c => owner || !isOwnerOnly(c))`), and `.help eval` from a member still returns the card; with rules: granted sees `vv` in group A, not in group D or PM; closed member does not see `imagen` in the menu, category count drops, `.help imagen` reply equals `getLang("plugins.help.not_found", "imagen", ".")`, `.bmenu imagen` and `menu:cmd:imagen` give the not-found reply; owner and listed member still see it; fail-open menu equals the no-rule menu.
5. Extend `test/capture-sites.test.js`-style check only if the engine caches a `config.X` (it does not); extend `test/permissions.test.js` is not needed.

**Evidence.** `test/helpers/fakes.js:32-44,107-137,647-738`; `test/command-state.test.js:44-80,186-191`; `test/permissions.test.js:97-100`.

## A13. Docs to update

- `CLAUDE.md`: Plugins section (line 52) add `delegable` to the `command` object and to the owner/level bullet; replace line 63 with the decision order of A3 (verdict first, `closed` silent, owner gate unless granted, `command_disabled`, context, admin unless granted) and the "not covered" note (hooks, button replies, inner checks); `settingsCache.js` bullet (line 75) add key `command_perms`; `lib/utils` list: `commandPermissions.js`; Database section: new tables and `lib/admin/backup/format.js` `MODELS` (stream B); `permissions.js` bullet: `identitiesOf` export.
- `docs/AUDIT_COMMANDES.md`: rows `.vv` (line 175: access "Propriétaire, délégable depuis le panel", destination en privé chez le demandeur), `.save` (172), `.help` (139), `.menu` (140), `.bmenu` (137: "commandes fermées à la personne cachées"), section 4 "Accès" (lines 282-288: new paragraph on delegation and the 14 non-delegable commands), section 7 manual checklist (new items near 400-402 and 449: delegated `.vv` in a group lands in the requester's DM and nothing in the group, with a PN and with a LID-only member; closed command is ignored in silence; menu/help for a granted and for a closed member).
- `lib/utils/settingsCache.js` header comment; `specs/003-command-permissions/contracts/` (Phase 1) gets the A1-A3 API.
- No new lang key on the bot side: silent refusal has no text, `.vv` DMs reuse `plugins.vv.usage` and `common.media_too_large`. Panel texts are stream C (FR-027).

## Open points for the owner

1. **"Closed" versus "disabled" for a non-listed person.** If `.imagen` is both disabled and `ONLY` for group A, should C (not listed) get silence (recommended: the command is invisible to him, as today's owner gate precedes the disabled message) or "commande désactivée" (literal FR-006 order)? Granted people and the owner get "commande désactivée" either way.
2. **Delegated `.vv`: where do the two non-media notices go?** Today the owner gets the usage text (nothing quoted) and `common.media_too_large` in the chat where he typed. For a delegated member that would post in the group and reveal the delegation. Recommended: send both to the requester's DM, best effort, nothing in the group. Alternative: stay completely silent.
3. **Default of `delegable` for future owner-only commands.** Recommended: non-delegable unless the plugin says `delegable: true` (A7). Alternative: delegable unless flagged (literal reading of FR-013, unsafe default). No difference for today's 83 plugins.
