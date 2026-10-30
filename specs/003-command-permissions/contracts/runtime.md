# Contract: runtime modules (bot side)

Internal module contracts of feature 003 for the bot process: the decision engine, the registry, the plugin contract, `.vv` / `.save` delegated, menu and help, tests and docs. The panel routes and the data model are the business of streams B and C (`research/b-data-backend.md`, `research/c-panel-ui.md`); this file only states what they must find on the bot side.

Where the stream files in [../research/](../research/) disagree, [../research.md](../research.md) wins (owner decisions U1-U8, arbitration X1-X12). Where the spec was rewritten after the streams (FR-006, second Clarifications session), the spec wins. The points settled while writing this contract are in [section 10](#10-points-settled-while-writing-this-contract), the inconsistencies found between sources in [section 11](#11-inconsistencies-between-sources).

Contents: [0 map](#0-module-map-and-rules) / [1 engine](#1-libutilscommandpermissionsjs) / [2 registry](#2-registry-libpluginsregistryjs) / [3 plugin contract](#3-plugin-contract-delegable-and-lockreason) / [4 `.vv`](#4-vv-delegated) / [5 `.save`](#5-save-delegated) / [6 menu and help](#6-menu-and-help) / [7 not covered](#7-what-the-rules-do-not-cover) / [8 tests](#8-tests-to-add) / [9 docs](#9-docs-to-update) / [10 settled](#10-points-settled-while-writing-this-contract) / [11 inconsistencies](#11-inconsistencies-between-sources)

## 0. Module map and rules

| File | Change | Section |
| ---- | ------ | ------- |
| `lib/utils/commandPermissions.js` | new, engine (read side only) | 1 |
| `lib/utils/permissions.js` | export `identitiesOf` (one line in `module.exports`, `permissions.js:182-193`) | 1.5 |
| `lib/plugins/registry.js` | entry gains `delegable` and `lockReason`; `executeCommand` calls `decide` | 2 |
| `plugins/{eval,update,exportcontacts,banchat,unbanchat,viewonce,getvv,antidel,getantidel,autorespond,statussave,stickercmd,delcmd,getcmd}.js` | add `delegable: false, lockReason` | 3 |
| `plugins/vv.js`, `plugins/save.js` | add `delegable: true`; `.vv` destination and notices, `.save` fallback | 3, 4, 5 |
| `plugins/help.js`, `plugins/menu.js`, `plugins/buttonmenu.js` | async `getVisibleCommands`, new `findVisibleCommand` | 6 |
| `lib/utils/settingsCache.js` | header comment lists `command_state` and `command_perms` | 9 |

No change in `lib/core/pipeline.js` (G3): stickers bound by `setcmd` already reach `registry.executeCommand` (`pipeline.js:184`), plain commands reach it at `:201`. No new lang key, no new setting, no new bus topic, no new stats metric, no new dependency.

Rules that apply to the new module (same as 002 section 0):

| Rule | Detail |
| ---- | ------ |
| Layer | engine in `lib/utils`: requires only `../database`, `./settingsCache`, `./permissions`, `./logger`. Never `lib/admin/**`, never `lib/plugins/registry` (the entry is passed in, so the registry can require the engine without a cycle). |
| Timers, config | none at `require` time; reads no `config.X` (nothing to capture, `test/capture-sites.test.js` unchanged). |
| Models must not require the engine | `lib/database/index.js:13-17` requires every model synchronously and the engine requires `../database`: a `PermissionRule.js` that imported `MODES` / `MAX_PEOPLE` would see a half-loaded `lib/database`. The model repeats the literals (`["extra","only"]`, 100) and a test pins that they equal the engine constants (section 8, file 1). |
| Writes | the engine has no write function. The panel service (stream B, B3) is the only writer and calls `invalidate()` after each write. |
| Load order | the engine destructures `PermissionRule` from `../database` at `require` time, like `commandState.js:23`. Until stream B's model exists the loader throws a `TypeError` that fails open (1.6), so stream A can land first, but its tests that insert rows need the model. |

## 1. `lib/utils/commandPermissions.js`

### 1.1 Exports

```js
decide(entry, message, { isOwner } = {}) -> Promise<Access>   // never rejects (1.6)
invalidate() -> void                                           // settingsCache.invalidate(CACHE_KEY)
CACHE_KEY    = "command_perms"
GLOBAL_SCOPE = "*"
MODES        = Object.freeze({ EXTRA: "extra", ONLY: "only" })           // the stored values (X1)
MAX_PEOPLE   = 100
VERDICTS     = Object.freeze({ OWNER: "owner", GRANTED: "granted", CLOSED: "closed", NORMAL: "normal" })
```

Nothing else is exported (no `set`, no `snapshot`: the panel reads the table directly, B10). `Access = Object.freeze({ verdict, scope, mode })`, `scope` in `"global" | "group" | null`, `mode` in `"extra" | "only" | null`. Results may be shared frozen objects: callers never mutate them.

| `verdict` | Meaning for the caller | `scope` | `mode` |
| --------- | ---------------------- | ------- | ------ |
| `owner` | sender is a `SUDO` owner: the rules never restrict him | `null` | `null` |
| `granted` | sender is listed in the global rule or in the rule of this group: skip the owner gate and the admin gate | the rule that listed him (global is tested first) | that rule's mode |
| `closed` | the deciding rule is `only` and he is not listed: refuse in silence | the deciding rule | `only` |
| `normal` | today's checks apply unchanged | the deciding rule when one exists but does not close (an `extra` rule, also an empty group `extra` = "niveau normal ici"), else `null` | `extra` or `null` |

`isOwner` is passed by the registry (it already called `message.isSudo()`); when absent, `decide` calls `message.isSudo()` itself inside the try/catch.

### 1.2 Algorithm (FR-006 steps 2 to 5, with X1)

```text
1. isOwner                                   -> OWNER                          (before any data)
2. entry missing or entry.delegable !== true -> NORMAL                         (before reading the cache: FR-014, SC-003)
3. rules = state.byCommand.get(entry.name)   ; none -> NORMAL
   groupRule  = message.isGroup ? rules.groups.get(message.jid) : null
   globalRule = rules.global                  ; neither -> NORMAL
4. listed in globalRule, then in groupRule (1.5)  -> GRANTED(scope of the rule that matched)
5. deciding = groupRule || globalRule        (the group rule wins as soon as it exists, whatever its mode or list)
   deciding.mode === ONLY -> CLOSED(scope of deciding, ONLY)
   otherwise              -> NORMAL(scope of deciding, EXTRA)
```

- Step 4 before step 5 is what makes a global listing "un passe-droit personnel" in every group (US3.4) and an `only` rule still let its listed people in.
- Step 5 makes the group rule override the global one for everybody not listed: a group `extra` rule with an empty list restores the normal level against a global `only` rule (U3, US3.3); a group `only` rule overrides a global `extra` one.
- In a private chat only the global rule exists (`groupRule` is `null`). A group rule never applies to another group or to a private chat (US1.3).
- Keyed by `entry.name` (first alias), like `commandState`: every alias and every `setcmd` sticker go through the same rows.
- The disabled state is not read here: it is checked by the registry after the verdict (section 2), so the engine stays a pure "who may".

### 1.3 Cache and loader (X11, B10)

One `settingsCache` key, TTL 5 minutes, `getState() = (await settingsCache.getOrLoad(CACHE_KEY, load, TTL_MS)) || emptyState()`.

```js
state = { byCommand: Map<string, { global: Rule | null, groups: Map<groupJid, Rule> }> }
Rule  = { mode: "extra" | "only", members: Set<normalizedJid> }
```

`members` holds the normalized PN **and** LID of every stored person, so the fast path is at most two `Set.has` per rule. Loader contract:

| Input | Handling |
| ----- | -------- |
| query | `PermissionRule.findAll()` (model instances). **No `raw: true`**: on SQLite a `JSON` column comes back as a string with `raw` (B1 spike). |
| `command` | `String(row.command).trim().toLowerCase()`; empty: skip the row. Not checked against the registry (a restored or orphan row is inert: step 2 and the `entry.name` lookup decide). |
| `mode` | not in `Object.values(MODES)`: skip the row. |
| `scope` | `"*"` = global; else `normalizeJid(scope)` must end with `@g.us`, otherwise skip the row. Two rows colliding after normalization: the last one read wins. |
| `people` | an array, or a JSON string parsed defensively (`JSON.parse` failure or a non-array: skip the row). Each element must be an object; add `normalizeJid(el.pn)` and `normalizeJid(el.lid)` when non-empty; any other element is dropped, the row stays (an `only` row left with no member then closes the command to everybody but the owners, the strict side). No cap at load (`MAX_PEOPLE` is enforced by the model and the panel). |
| report | one `logger.warn` per load with the number of skipped rows and dropped elements, never one line per row. |
| `delegable` | **not** applied at load (the registry may not be loaded yet and a plugin reload would make it stale): step 2 of 1.2 uses the live entry. |

`invalidate()` is called by every panel write (PERM-3/4/6/7, GRP-6 "forget this group"). `settingsCache.clear()` already runs on backup restore (`lib/admin/backup/restore.js:663`) and on in-process restart (`lib/core/botRuntime.js:203`), so nothing else is needed (FR-010). A write is visible on the next message: `invalidate` bumps the key generation, so a load started before the write cannot store a stale state (`settingsCache.js:56,94-99`).

### 1.4 Cost

Warm cache: no query, two `Map.get` and at most two `Set.has` per decision (O(1), SC-005; a spike measured about 1 microsecond with 500 commands x 100,000 members). Cold or expired: one `findAll` shared by concurrent callers (`inflight`). A command with `delegable !== true` or no rule never reaches the identity slow path.

### 1.5 Identity matching (FR-004, A5)

A message has up to two identities: `message.sender` (PN when Baileys gives one, otherwise the LID) and `message.senderLid` (`Message.js:52-57,203-205`). A LID-only author has `sender === senderLid`.

1. **Fast path** (no await): `ids = unique(normalizeJid(sender), normalizeJid(senderLid)) minus ""`. Listed when any id is in `rule.members`. This covers a rule stored with PN only (author with a PN), LID only (author with a LID), or both.
2. **Slow path**, only when the fast path missed, at least one applicable rule has `members.size > 0`, and `ids` does not contain both a PN and a LID (`isPnJid` / `isLidJid`): `expanded = await expandedIdentities(message)`, then the same `Set.has` tests. `expandedIdentities` is `identitiesOf(message, id, metadata)` for each id, with `metadata = message.isGroup ? await message.getGroupMetadata() : null` (already cached 60 s and memoized per message, never throws). It resolves PN/LID through the group participants (`id`, `phoneNumber`, `lid`) and, for a LID target with no PN yet, through `signalRepository.lidMapping.getPNForLID`.
3. The result of step 2 is memoized per message object in a module `WeakMap<Message, Promise<Set<string>>>` (the menu evaluates about 80 commands for one message; `Message` is not modified). The promise never rejects: on any failure the set is the sender's own ids.
4. Failure or unresolved identity means **not listed**, the safe side: `only` closes the command, `extra` leaves the normal level. Known limit: a PN-only author in a private chat against a rule that stores only a LID cannot be resolved (`identitiesOf` maps LID to PN, not PN to LID, and a private chat has no group metadata). The panel stores both forms whenever it learns them (B2).
5. `identitiesOf` is exported from `lib/utils/permissions.js` (today private, `permissions.js:93`). Owner detection is unchanged (`isSudo()` already matches both forms, `Message.js:459-463`).

### 1.6 Failure semantics (FR-011)

- `decide` wraps its whole body in try/catch and returns the shared frozen `NORMAL` result on any error (one `logger.warn({ err: err?.message }, ...)`, like `commandState.isDisabled`).
- A load error: `getOrLoad` returns the previous expired state if there is one, else `null` (`settingsCache.js:64-70`), and `getState()` then returns an empty state. That last-known-good behaviour is kept. The loader throws instead of caching the failure, so the next message retries (same as `commandState`: a database that is down already breaks the bot, and a transient error must not hide valid rules for 5 minutes).
- Cold failure effects: owner-only commands stay owner-only (owner gate, section 2), `only` is not applied (the command falls back to its normal level), grants are not applied. The owner is never affected.

## 2. Registry (`lib/plugins/registry.js`)

### 2.1 Entry normalization (X2, U6)

`registerCommand` destructures two more fields next to `adminOnly` (`registry.js:85-94`) and adds them to the entry (`registry.js:121-136`):

```js
const { /* ... */ delegable, lockReason } = plugin.command;
// on the entry:
delegable:  typeof delegable === "boolean" ? delegable : !(fromMe || ownerOnly),
lockReason: /* delegable === false */ typeof lockReason === "string" && lockReason.trim() ? lockReason.trim() : null,
// lockReason is null whenever the entry is delegable, even if the plugin declared one
```

| Plugin declares | `entry.delegable` | `entry.lockReason` |
| --------------- | ----------------- | ------------------ |
| nothing, public or admin-only command | `true` | `null` |
| nothing, `fromMe` / `ownerOnly` command (a future `.eval`) | `false` | `null` (the panel shows "reserved to the owner", FR-022 fallback) |
| `delegable: true` | `true` | `null` |
| `delegable: false` | `false` | the declared code, else `null` |

The registry does not validate the code against the five-code vocabulary (the panel falls back for an unknown one); the guard test of section 3 pins the 14 declared codes. `entry.fromMe` and `entry.ownerOnly` stay what they are: the owner gate does not consult `delegable`. The panel (stream B) reads `entry.delegable` and `entry.lockReason`; nothing in the panel can change them.

### 2.2 `executeCommand` order (X9, FR-006, U1)

Inside the existing `try`, replacing `registry.js:289-317`. The banned-chat gate (FR-006 step 1) stays in the pipeline (`pipeline.js:129-131`), so a person named in a rule gets nothing from a disabled chat.

```js
const isOwner = message.isSudo();                                           // unchanged
const access  = await commandPermissions.decide(entry, message, { isOwner });  // never throws
if (access.verdict === VERDICTS.CLOSED) { logSilentRefusal(message, label, access); return true; }
const granted = access.verdict === VERDICTS.GRANTED;
```

| # | Check | Condition | Outcome |
| - | ----- | --------- | ------- |
| 0 | pipeline | chat in `BannedChat`, not an owner `unban` | nothing reaches the registry (unchanged) |
| 1 | verdict | `decide(...)` | computed once; `granted` / `closed` derived from it |
| 2 | **silent refusal** | `closed` | `return true`; no reply, no reaction, no `execute`, no `cmd_ok` / `cmd_fail`, no bus topic; log (2.3) |
| 3 | owner gate | `(entry.fromMe \|\| entry.ownerOnly) && !isOwner && !granted` | `common.owner_only` (unchanged text) |
| 4 | disabled | `commandState.isDisabled(entry, message)` | `common.command_disabled`, for everybody (owner and granted included) |
| 5 | context | `(onlyGroup \|\| adminOnly) && !isGroup` / `onlyPm && isGroup` | `extra.group_cmd` / `common.pm_only` (unchanged, also for granted: FR-008) |
| 6 | admin gate | `adminOnly && !isOwner && !granted && !(await isSenderAdmin())` | `common.sender_not_admin`; `granted` short-circuits before `isSenderAdmin()` (no group-metadata round trip, FR-009) |
| 7 | run | unchanged | `logger.info("Invoked command...")`, `execute`, `stats.count("cmd_ok")`, the unchanged `catch` (`MEDIA_TOO_LARGE`, `common.error`, owner DM throttle) |

Observable result by verdict:

| Verdict | Command disabled | Outcome |
| ------- | ---------------- | ------- |
| `closed` | yes or no | silence (U1: disabled does not leak to a person the command is hidden from) |
| `owner` | no | runs (owner gate passes; `adminOnly` skipped by `isOwner`, as today) |
| `owner` | yes | `common.command_disabled` (unchanged, spec US2.6) |
| `granted` | no | context checks, then runs; owner and admin gates skipped |
| `granted` | yes | `common.command_disabled` |
| `normal` | any | exactly today's sequence |

`isBotAdmin()` stays inside the plugins: a delegated `.kick` by a non-admin runs, then answers with the plugin's usual "the bot must be admin" reply if it is not (FR-009).

### 2.3 Silent refusal log

```js
const who = message.sender || message.senderLid || message.jid;
const first = cooldown.hit(who, "permlog:" + entry.name, 60_000) === 0;
(first ? logger.info : logger.debug).call(logger, `Silent refusal (command permissions): ${who} -> ${label} [${access.scope}]`);
```

At most one `info` line per sender and command per minute, the rest at `debug`, so a spammer cannot fill the 1000-entry log ring shown by the panel's Logs page. No new `METRICS` entry (`stats.js` set is frozen), no new bus topic (`events.js`: "don't add topics casually"). `stats.count("messages")` already ran in the pipeline.

### 2.4 Invariant: no rule means byte-identical (SC-004)

With no rule, an unreadable table, or a non-delegable command, `decide` returns `owner` or `normal`, so `granted` is `false` and `closed` is unreachable: steps 3 to 7 reduce to today's code, same texts, same order, same stats, same `cooldown` and bus effects. The only differences are one awaited call and, once per 5 minutes, one `findAll`. `decide` has no side effect when it returns `normal` (no cooldown hit, nothing above `debug` except the failure `warn`). `isSenderAdmin()` is still called in exactly the same cases when `granted` is false.

Existing tests that pin today's order and outputs, none of which may change (they are the proof of SC-004 for the runtime):

| Test | What it pins |
| ---- | ------------ |
| `test/command-state.test.js:186` | owner gate before `command_disabled` (non-owner gets `owner_only`, the owner is refused) |
| `test/command-state.test.js:193` | `command_disabled` before `onlyGroup` / `onlyPm` / `adminOnly`, and no `isSenderAdmin()` call |
| `test/command-state.test.js:218,269,293` | refused call counted nowhere; sticker-bound commands go through the same check; hooks keep running |
| `test/permissions.test.js:74,121,144,161,177,202,229,245` | owner refusals for every `fromMe` command (PM, LID, group admin), `sender_not_admin`, `group_cmd`, `pm_only`, `SUDO=""`, LID owner, `execute` never reached on refusal |
| `test/owner-dm-throttle.test.js:101-178` | error path, `MEDIA_TOO_LARGE`, stats and bus unchanged |
| `test/registry.test.js:62,77,112` | alias resolution and exact matching |
| `test/commands.test.js`, `test/pipeline.test.js:233,342`, `test/admin-commands.test.js:85,301,308` | every command through `executeCommand` with no rule; hook order; sticker command; panel disable |

## 3. Plugin contract: `delegable` and `lockReason`

```js
command: { pattern, desc, type, fromMe, ownerOnly, onlyGroup, onlyPm, adminOnly,
           delegable,    // boolean, optional: see 2.1 for the default
           lockReason }  // "code" | "update" | "data" | "lockout" | "config", only with delegable: false
```

Edit for each of the 16 owner-only plugins (`grep -E "fromMe: *true|ownerOnly: *true" plugins/*.js` gives exactly these 16; no plugin uses `ownerOnly`): add the two properties right after `fromMe: true,` and keep `fromMe: true` (the owner gate and the default stay the second line of defence).

| File | `entry.name` (aliases) | `delegable` | `lockReason` |
| ---- | ---------------------- | ----------- | ------------ |
| `eval.js` | `exec` (`exec`, `eval`) | `false` | `code` |
| `update.js` | `update` | `false` | `update` |
| `exportcontacts.js` | `exportcontacts` | `false` | `data` |
| `banchat.js` | `ban` | `false` | `lockout` |
| `unbanchat.js` | `unban` | `false` | `lockout` |
| `viewonce.js` | `setvv` | `false` | `config` |
| `getvv.js` | `getvv` | `false` | `config` |
| `antidel.js` | `antidelete` (`antidelete`, `antidel`) | `false` | `config` |
| `getantidel.js` | `getantidelete` (`getantidelete`, `getantidel`) | `false` | `config` |
| `autorespond.js` | `ar` (the spec's `.autorespond`) | `false` | `config` |
| `statussave.js` | `statussave` (`statussave`, `ss`) | `false` | `config` |
| `stickercmd.js` | `setcmd` | `false` | `config` |
| `delcmd.js` | `delcmd` | `false` | `config` |
| `getcmd.js` | `getcmd` | `false` | `config` |
| `vv.js` | `vv` | `true` | (none) |
| `save.js` | `save` | `true` | (none) |

14 never delegable (FR-013) + 2 explicitly delegable. The nine admin-only plugins (`kick`, `promote`, `demote`, `tag`, `warnuser`, `setwelcome`, `goodbye`, `addfilter`, `delfilter`) and every other command stay delegable by default (US1.5: the panel warns, X5 `opens_admin_command`). Hook-only modules (`trackmessages`, `knownchats`, `groupguard`, `buttons`, `pollplus`) have no command, nothing to flag.

**Guard test** (`test/command-delegable.test.js`, section 8 file 2) fails when: the set of loaded entries with `delegable === false` differs from the 14 files above (adding a non-delegable command means editing the test on purpose); `vv.js` or `save.js` is not `true`; a `fromMe` / `ownerOnly` plugin does not declare `plugin.command.delegable` as a boolean itself (so the next owner-only command forces a conscious choice, U6); a non-delegable entry's `lockReason` is not one of the five codes; a delegable entry has a `lockReason`.

## 4. `.vv` delegated

Spec: FR-015, FR-017, FR-018, U2. File `plugins/vv.js`; the `command` block gains `delegable: true` (still `fromMe: true`, so it stays owner-only until the panel opens it). Header comment `vv.js:32` "(owner only)" becomes "(owner; delegable from the panel)".

`delegated = !message.isSudo()`, computed once at the top of `execute`.

**Destination** (`resolveDestination(message)`):

| Requester | Destination |
| --------- | ----------- |
| owner | unchanged: the `view_once` settings (`vvMode` `p` / `jid`), else `message.jid` |
| non-owner, in a group | `message.sender \|\| message.senderLid` (PN preferred, LID fallback, like `.save`); never read from the message body |
| non-owner, private chat | `message.jid` (the requester's own chat, whatever its addressing) |

A non-owner path **never reads** the `view_once` setting (FR-015: whatever the auto-vv destination is). If the requester JID is empty, the command ends silently.

**Outputs** (nothing is ever posted in the group for a delegated requester, FR-018):

| Case | Owner | Delegated |
| ---- | ----- | --------- |
| nothing quoted | `message.reply(getLang("plugins.vv.usage", config.PREFIX))` in the chat | same text, sent to the requester's DM |
| quoted message is not a view-once, unsupported kind, `getQuotedMedia()` returns `null`, download error | silent (`vv.js:52,58,67-70`) | silent |
| `MEDIA_TOO_LARGE` (`vv.js:66`) | rethrown; the registry replies `common.media_too_large` in the chat | not rethrown: `getLang("common.media_too_large", error.maxMB \|\| Math.round(Number(config.MAX_UPLOAD) \|\| 230))` (the registry's own formula, `registry.js:329-331`) to the DM, then return |
| media sent | to the destination above, caption `mediaMessage.caption \|\| plugins.viewonce.forwarded` | same |
| `sendMessage` fails | propagates: `common.error` in the chat and the stack to the owners | swallowed: `logger.warn(safeLog(err), ...)`, return. Nothing in the group, no `common.error`, no owner DM |

DMs go through a local helper `notifyRequester(message, text)`: `socket.sendMessage(requesterJid, { text })` in a try/catch that logs at `debug` (best effort; WhatsApp may refuse a person who never wrote to the bot, and the person then gets nothing, spec edge case). It must not use `message.reply` (that quotes into the group).

Existing lang keys only (checked in `lang/en.json` and `lang/fr.json`): `plugins.vv.usage` ({0} = prefix), `common.media_too_large` ({0} = MB), `plugins.viewonce.forwarded`. No new key (X12).

Known limits (documented, not fixed): a delegated too-large notice returns normally, so the registry counts `cmd_ok` (the owner path counts nothing); a LID-only requester in a group is the least tested addressing and goes in the real-device checklist (section 9).

## 5. `.save` delegated

Spec: FR-016, FR-017. File `plugins/save.js`: `command` gains `delegable: true`. The destination is already the requester (`save.js:40`, `message.sender || message.senderLid`), in a group and in a private chat. One hardening: drop the last fallback `|| getOwnerJids()[0]` (`save.js:40`) and the then unused `getOwnerJids` import (`save.js:3`). It is dead code for an owner (an owner always has `sender` or `senderLid`, `isSudo()` requires one) and for a delegated person it would send his media to the owner. An empty sender still answers `plugins.save.no_sudo`. The reactions and text replies of `.save` (`reply_required`, `no_message`, `download_failed`, `no_media`, the hourglass and check marks) stay in the chat exactly as today: FR-016 specifies only where the media goes, and `.save` is not made discreet.

## 6. Menu and help

Spec: FR-028, FR-029; decision source `decide` (the same function as execution, no second predicate).

`plugins/help.js`:

```js
getVisibleCommands(message) -> Promise<CommandEntry[]>      // now async
findVisibleCommand(message, name) -> Promise<CommandEntry | null>   // new, exported next to the others
```

`getVisibleCommands`: `owner = !!(message && message.isSudo && message.isSudo())` once; for each entry of `getCommands()` in order (sequential awaits, order preserved), `{ verdict } = await decide(cmd, message, { isOwner: owner })`:

| `verdict` | owner-only command | other command |
| --------- | ------------------ | ------------- |
| `owner` | shown | shown |
| `granted` | shown (a delegated `.vv` appears for B in group A, not in group D) | shown |
| `normal` | hidden (today's rule) | shown |
| `closed` | hidden | hidden |

`findVisibleCommand`: `cmd = getCommandByPattern(name)`; `null` when there is none **or** the verdict is `closed`; otherwise the entry. It hides only `closed`, never owner-only, so `.help eval` from a non-owner still shows the card (FR-029: today's output, `help.js:116-122`).

| Caller (line today) | Change |
| ------------------- | ------ |
| `menu.js:130` | `buildMenu(await getVisibleCommands(message))` |
| `buttonmenu.js:41` (`sendCategories`) | `await getVisibleCommands(message)` |
| `buttonmenu.js:69` (`sendCategory`) | `(await getVisibleCommands(message)).filter(...).sort(...)` |
| `help.js:116` (`execute`) | `await findVisibleCommand(message, name)`; `null` falls into the existing `plugins.help.not_found` reply, so a closed command answers like an unknown one |
| `buttonmenu.js:115` (`sendCommand`, serves `.bmenu <cmd>` and the `menu:cmd:<name>` button) | `await findVisibleCommand(message, name)`; `null` gives the existing `plugins.buttonmenu.not_found` reply |

A category whose commands are all closed disappears through the existing paths (`buttonmenu.js:73` not-found reply, no row in the category list). `describeAccess` is untouched. No rule, or a failed load: every verdict is `owner` or `normal`, the filter reduces to `owner || !isOwnerOnly(cmd)`, and menu, categories, counts, order and text are identical (FR-029). No test calls `getVisibleCommands` or `isOwnerOnly` today (grep); no external module (panel, tools) imports them.

## 7. What the rules do not cover

Documented, as 002 did for `disabled` (research.md section 3):

- `onMessage` hooks (`afk`, `addfilter`, `notify`, `trackmessages`, `groupguard`) and `handleButtonReply` handlers are not command dispatch. A rule never stops them, and a click on an old interactive message is not gated. The auto-vv (`viewOnceHandler`) is unrelated to `.vv`.
- Checks inside a plugin (`stats reset`, `idea`, `quote`, `reminder list all`, the cooldown exemptions of `chatgpt`, `gemini`, `imagen`, `voice`) stay as they are: a rule opens the command, not its owner-only sub-actions.
- `describeAccess` in `.help` is unchanged: a granted member sees "owner" on the `.vv` card.
- `.help <command>` from a non-owner on an owner-only command still shows the card (today's behaviour); only `closed` commands are hidden.
- A person's `.role` (muted, banned) is not an input of the engine (Assumptions): `groupguard` and `role` keep their own effect.
- The `Group` settings, `BannedChat` and `commandState` are read where they were; the engine never writes them.

## 8. Tests to add

Style of `test/command-state.test.js` (`registry._reset()` plus probe plugins, `fakes.makeMessage({ from, lid, alt, group, admin, sticker, quoted })`, `fakes.syncDb()`, real models for rows, `settingsCache.clear()` in `beforeEach`) and of `test/permissions.test.js` (real plugins through `fakes.setup()` with a spy `execute`). `fakes.setupEnv({ sudo: "111" })`. No existing test changes for the runtime.

1. **`test/command-permissions.test.js`** (engine and registry)
   - FR-006 as a table: owner (also under `only` with an empty list, by LID, listed in a rule); listed in the global rule; listed in the group rule; group mode beats global mode; global pass inside a group `only`; `only` unlisted is silent (no reply, no reaction, `execute` not called, no `cmd_ok` / `cmd_fail`, no bus topic, one log line); `extra` leaves the normal level (public runs, owner-only gives `owner_only`, admin-only gives `sender_not_admin`); `only` with an empty list; a group rule inert in group D and in a private chat; a global rule in a private chat; an empty group `extra` rule overriding a global `only` (US3.3); group `only` overriding a global `extra`.
   - FR-008 / FR-009: granted + `onlyGroup` in a private chat gives `extra.group_cmd`; granted + `onlyPm` in a group gives `pm_only`; a granted non-admin runs an `adminOnly` command and `isSenderAdmin` is never called.
   - Disabled: granted + disabled gives `command_disabled`; owner + disabled gives `command_disabled`; closed + disabled is silent (U1); a banned chat through `pipeline.processMessage` gives nothing; the owner `unban` still gets through a banned chat.
   - Identity (PN and LID): rule with PN only vs author LID + alt PN; rule with LID only vs PN + LID author; rule with PN only vs LID-only author resolved through group participants (`lidParticipants`); rule with LID only vs PN-only author listed in the participants; device suffix `:7`; an unknown LID is not granted; the slow path runs once per message (spy `getGroupMetadata`) across many commands; it does not run for a message with both namespaces, nor without a non-empty rule.
   - Cache: a write through the (test) setter plus `invalidate()` changes the next message, a removal too, no restart; `settingsCache.clear()` rebuilds; a warm cache issues zero `findAll`; 500 rules x 1,000 decisions under a loose time bound; a load started before an invalidation does not store its result.
   - Loader contract: a row with an unknown `mode`, a non-group scope, an unparsable `people` string is skipped (one warn); a `people` JSON string is parsed; an element that normalizes to `""` is dropped; `raw` is not used (a SQLite JSON column is an array).
   - Fail-open (FR-011): cold cache plus `PermissionRule.findAll` rejecting: owner-only commands still give `owner_only`, `only` not applied, no throw; warm cache plus a failing reload keeps the last state.
   - SC-003: for each non-delegable real entry (`fakes.setup()`), insert `extra` and `only` rows by hand, global and group, also after `settingsCache.clear()`: a non-owner still gets `owner_only`, never silence, `execute` never called; a non-delegable probe on a public command is likewise inert.
   - Stickers: `processMessage` with a `sticker` and a `StickerCommand` row: a granted author runs, a closed author is silent, an ungranted author on an owner-only command gets `owner_only`.
   - Every alias of a command; an orphan row (unknown command) is inert.
   - Stored values: `MODES` values and `MAX_PEOPLE` equal the `PermissionRule` validators (`rawAttributes.mode.validate.isIn`, the `people` limit), since the model cannot import them.
2. **`test/command-delegable.test.js`**: the guard of section 3; the normalization table of 2.1 with probes (a probe without the flag is delegable; an owner-only probe without the flag is not; `lockReason` is `null` on a delegable entry even if declared).
3. **`test/vv-save-delegated.test.js`** (stub `mediaAdapter.downloadMedia` through `getQuotedMedia`; `view_once` row in modes `p`, `jid`, `g`): owner `.vv` unchanged in each mode; delegated in a group gives one send to the requester's PN, none to the group, whatever `view_once` says; a LID-only requester gets the LID; delegated in a private chat gives `message.jid`; not a view-once or download failure sends nothing anywhere; `sendMessage` rejecting gives nothing in the group, no `common.error`, no owner DM; usage and `media_too_large` go to the DM (and a failing DM is swallowed); the owner's usage and too-large replies stay in the chat; `.save` delegated sends to the requester, never to the owner, and an empty sender gives `plugins.save.no_sudo` with no fallback to the owner.
4. **`test/help-menu-visibility.test.js`**: with no rule, `buildMenu`, `help <cmd>` and `bmenu` output for owner, member and group admin (private chat and group) equals the legacy formula `getCommands().filter(c => owner || !isOwnerOnly(c))`; `.help eval` from a member still returns the card; with rules, a granted member sees `vv` in group A, not in group D nor in a private chat; a closed member does not see `imagen` in the menu, the category count drops, `.help imagen` equals `getLang("plugins.help.not_found", "imagen", ".")`, `.bmenu imagen` and `menu:cmd:imagen` give the `plugins.buttonmenu.not_found` reply; owner and listed member still see it; a failed load gives the no-rule menu.

Out of this file, owned by stream B and listed there: database, backup, groups (GRP-3 / GRP-6), panel routes, integration contract tests.

## 9. Docs to update

| File | Change |
| ---- | ------ |
| `CLAUDE.md` line 52 | add `delegable, lockReason` to the `command` object |
| `CLAUDE.md` line 63 | replace the gate sentence by the order of 2.2 (verdict, `closed` silent, owner gate unless granted, `command_disabled`, context, admin unless granted) and add a bullet: rules are set from the panel only, 14 commands are never delegable (declared in code, owner-only commands default to non-delegable), what is not covered (section 7) |
| `CLAUDE.md` line 72 | `permissions.js` bullet: `identitiesOf` is exported |
| `CLAUDE.md` line 75 | `settingsCache.js` bullet: add key `command_perms` (and keep `command_state`) |
| `CLAUDE.md` line 79 | engines list: `commandPermissions.js` (read-side decision, `decide`) |
| `CLAUDE.md` Database section | table `permission_rules`, `MODELS` 26 (stream B text) |
| `docs/AUDIT_COMMANDES.md` rows | `.bmenu` (137) and `.menu` (140): commands closed to the person are hidden; `.help` (139): a closed command answers as unknown; `.save` (172): also usable by a person the owner delegates to, media to that person; `.vv` (175): access "Owner, delegable from the panel", media sent to the requester's DM when delegated |
| `docs/AUDIT_COMMANDES.md` section 4 "Accès" (282-288) | new bullets: delegation from the panel, the 14 never-delegable commands, silent refusal of `only` rules |
| `docs/AUDIT_COMMANDES.md` section 7 (near 400-402 and 449) | new items: delegated `.vv` in a group lands in the requester's DM and nothing in the group (member with a PN, member addressed by LID only); `.vv` delegated without a quote answers in DM; a command closed to a member is ignored in silence and absent from `.menu` / `.help`; `.help eval` from a member unchanged; `.vv` delegated in a private chat; disabled plus closed gives silence for an unlisted member |
| `lib/utils/settingsCache.js` header (lines 8-11) | list `command_state` (missing today) and `command_perms` |
| `specs/003-command-permissions/quickstart.md` | the real-device items above (Phase 1, not this file) |

No `config.env.example` line, no catalog entry, no lang file change on the bot side.

## 10. Points settled while writing this contract

| # | Question | Settled as | Why |
| - | -------- | ---------- | --- |
| 1 | `scope` of `granted` when a person is in both rules | the global rule is tested first (A2) | it is only a label for logs and tests |
| 2 | `scope` / `mode` of a `normal` verdict | filled when a rule decided it, `null` otherwise | tests and logs can tell "niveau normal ici" from "no rule" |
| 3 | A row the loader cannot read | skip the row for an unknown mode, a bad scope or unparsable people; drop single bad persons | a rule is never half-applied; the panel still lists the stored row |
| 4 | Where the stored constants live | in the engine (X1, B10); the model repeats the literals | `lib/database/index.js` loads models first: an import would be circular |
| 5 | `lockReason` vocabulary | the registry copies any non-empty string, only the guard test knows the five codes | the panel already has a fallback (FR-022) |
| 6 | Delegated too-large `.vv` | notice sent by the plugin, no rethrow, `cmd_ok` counted | rethrowing makes the registry reply in the group |
| 7 | `.save` discretion | not changed | FR-016 only fixes the media destination |
| 8 | Menu evaluation | sequential `await`s over `getCommands()` | deterministic order; the slow path is memoized per message |
| 9 | Spec `.autorespond` | the command is `ar` (`autorespond.js:119`); there is no `autorespond` alias | the registry key is `entry.name` |

## 11. Inconsistencies between sources

Reported, not decided here:

| # | Sources | Inconsistency | Treatment in this contract |
| - | ------- | ------------- | -------------------------- |
| 1 | spec SC-004 vs B4 / B11 | SC-004 says the existing suite passes without modification of its expectations; B edits expectations in `test/database.test.js`, `backup.test.js`, `admin-backup.test.js`, `admin-view-backup.test.js`, `backupKit.js`, `admin-groups.test.js:465,739` (25 to 26 models, new table, `counts.permissions`, `permissionRules`) | runtime side honours SC-004 literally (no edit, section 2.4); the owner should read SC-004 as "command behaviour", since a new table and a new field cannot keep a frozen count |
| 2 | spec FR-013 vs code | `.autorespond` is not an alias: the command is `ar` | table of section 3 uses `ar` |
| 3 | A8 evidence vs `test/permissions.test.js:97-100` | the list there holds 14 files in total (12 non-delegable plus `vv.js` and `save.js`), not "the same 14 plus 2": `autorespond.js` and `getcmd.js` are missing | not edited (SC-004); the new guard test covers all 16 by scanning `fromMe` / `ownerOnly` |
| 4 | `plan.md` vs spec | the plan says 29 functional requirements; the spec now has FR-001 to FR-031 (31) after the second Clarifications session | `plan.md` to refresh when Phase 1 is closed |
