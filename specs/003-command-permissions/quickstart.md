# Quickstart: validating command permissions

How to validate feature 003 end to end: the automated checks, one scenario per user story (US1-US4), a check for every success criterion (SC-001 to SC-006), the edge cases worth running by hand, and a manual checklist for a real device. No implementation code here: the rules of the decision are in [spec.md](spec.md) (FR-006) and the [runtime contract](contracts/runtime.md), the routes in [contracts/admin-permissions-api.md](contracts/admin-permissions-api.md), the screens in [contracts/panel-ui.md](contracts/panel-ui.md), the table in [data-model.md](data-model.md).

Legend: **Auto** = covered by `yarn test` (offline, no WhatsApp), **Manual** = needs a browser and a real phone. Page names ("Dashboard", "Commands", "Groups", "Backup", "History") are the English labels of the panel. The bot answers in French unless `BOT_LANG=en`; the expected bot texts below are quoted in French with the English meaning.

## Prerequisites

| Tool | Version | Check |
| ---- | ------- | ----- |
| Node.js | >= 24 (`package.json` engines) | `source ~/.nvm/nvm.sh && nvm use 24 && node -v` (the default Node of a shell may be older) |
| Yarn | vendored (`.yarn/releases`) | `node .yarn/releases/yarn-4.17.0.cjs -v` (or `corepack enable`, then `yarn -v`) |
| Browser | the two latest versions of Chrome, Firefox or Safari | DevTools device toolbar for the 360 px check |
| sqlite3 (optional) | any | one optional check in section 5 |

Run every ad-hoc script and tool with `OWB_NO_CONFIG_ENV=1` (`config.js` then skips `config.env`, the owner's secrets); `yarn test` already does. Never read or print `config.env`, `sessions/`, `data/` or `database.db` of the real install: the manual scenarios run in a sandbox (section 2).

Real accounts for the manual part (the "cast"):

| Name | Who | Notes |
| ---- | --- | ----- |
| O | the owner phone, in `SUDO` | |
| B | a second test account | member of A and D; has written once to the bot in private (it must be a known contact for the "everywhere" picker) |
| C | a third test account | member of A and D; never named in any rule |
| A | a test group | the bot is **admin**; O, B and C are members |
| D | a second test group | the bot is a member (admin optional); O, B and C are members |
| E | a spare group | for the "former group" checks; the bot can be removed from it without harm |
| X | optional: a member whose number WhatsApp hides (LID only) | for the LID check of section 5; skip if you have none and record "not run" |

Also needed: a view-once photo you can send from B (and from C) in A, and a second empty sandbox for the backup round trip.

## 1. Automated checks

```bash
source ~/.nvm/nvm.sh && nvm use 24
yarn test                                   # node --test --test-force-exit "test/**/*.test.js"
BOT_LANG=en yarn test                       # same in English (default is fr)
node --test --test-force-exit test/admin-view-permissions.test.js   # one file
OWB_NO_CONFIG_ENV=1 node tools/check-unused-deps.js                # expected: "0 unused dependencies"
```

Expected: every test passes with no network, no WhatsApp and no write to the real `data/`, `sessions/` or `database.db`; the run stays near the usual 20 s (report the figure and the test count in the PR). `LOG_LEVEL=debug node index.js` (sandbox, section 2) prints the same plugin count as before the feature (no plugin file was added), no `Failed to load plugin` and no `Duplicate alias`.

Translations (panel side only: the feature adds no bot text, so there is no `bot-*.json` fragment and `lang/*.json` is unchanged):

```bash
ls specs/003-command-permissions/i18n/                                                            # only panel-permissions.json
OWB_NO_CONFIG_ENV=1 node tools/merge-panel-i18n.js --frag-dir specs/003-command-permissions/i18n --dry-run   # nothing left to add or change
git status --short lib/admin/public/i18n lang                                                     # the catalogs only differ by the merge of this feature
```

New and edited suites (names as in the contracts; follow the tasks if one was renamed):

| Test file | Covers |
| --------- | ------ |
| `test/command-permissions.test.js` | every FR-006 branch (owner, listed, group mode over global mode, "everywhere" pass inside a group `only`, `only` silent with no reply, no reaction, no `execute`, `extra` keeps the normal level, empty `only` list, rule of A inert in D and in private), FR-008 and FR-009, disabled wins (granted and owner get "command disabled", closed stays silent), PN and LID matching, cache and FR-010, fail-open (FR-011), SC-003 (rows inserted by hand on each non-delegable command open nothing), sticker-bound commands, aliases, orphan rows |
| `test/command-delegable.test.js` | the 14 files declare `delegable: false` with a reason; `vv.js` and `save.js` are `true`; every owner-only command declares the flag explicitly (U6) |
| `test/vv-save-delegated.test.js` | owner `.vv` unchanged in every `view_once` mode; delegated `.vv` goes to the requester's DM only, whatever `.setvv` says; LID-only requester; usage and too-large notices to the DM; a failing send leaves nothing in the group; `.save` to the requester |
| `test/help-menu-visibility.test.js` | no rule gives the legacy menu and help; granted sees the command in A and not in D; closed does not see it (`.help` answers as for an unknown command); `.help eval` from a member still shows the card (FR-029) |
| `test/admin-permissions.test.js` | PERM-1..7: session needed, aliases, identity forms and typed numbers, `not_allowed` on a locked command, warnings, orphans, idempotence, audit rows and the 1900-character degrade rule, `present`/`admin` annotation, GRP-3 `counts.permissions`, GRP-6 `permissionRules`, cache invalidation, a backup round trip |
| `test/admin-view-permissions.test.js`, `test/admin-view-permissions-{group,commands}.test.js` | the pure logic (numbers, draft, warnings, badges, effective mode) and the group tab and Commands page in a fake DOM |
| edited: `database.test.js`, `backup.test.js`, `admin-backup.test.js`, `admin-view-backup.test.js`, `admin-groups.test.js`, `admin-integration.test.js`, `admin-view-groups.test.js`, `admin-view-logs-stats.test.js`, `admin-i18n.test.js` | the new table (26 exported models), the `permissions` tab, the audit detail, the second fragment directory |

## 2. Work in a sandbox

Manual scenarios create a session, a database, `data/panel.key` and backups. Run them in a scratch worktree so the real `sessions/`, `database.db` and `data/` are never touched.

```bash
source ~/.nvm/nvm.sh && nvm use 24
git worktree add ../owb-qs3 003-command-permissions
cd ../owb-qs3
node .yarn/releases/yarn-4.17.0.cjs install                  # no config.env in the sandbox: pass settings inline
SUDO=<O's number, digits only> LOG_LEVEL=info node index.js   # prints the QR and the panel setup link
```

Pair the sandbox bot (QR or pairing code), open the setup link, choose a password, and log in. The bot must be a member of A (as admin), D and E. To start over: stop the bot and delete `sessions/main`, `database.db` and `data/` inside the sandbox.

**Baseline before any rule** (record it, it is the reference for SC-004):

1. From B in A: `.vv` replying to a view-once photo gives "🔒 Cette commande est réservée au propriétaire du bot." (this command is reserved for the owner); `.dice` answers; `.menu` and `.help vv`: save the `.menu` text as seen by B and by C in A, and by B in D.
2. In the panel, **Commands** shows every command, a "Permissions" column reading "No rule everywhere", and `eval`, `exec`, `update`, `exportcontacts`, `ban`, `unban`, `setvv`, `getvv`, `antidel`, `getantidel`, `ar`, `statussave`, `setcmd`, `delcmd`, `getcmd` greyed with "Cannot be delegated" and a reason (see US4).

## 3. One scenario per user story

### US1 Hand a command to someone in a group (P1)

*Setup*: the baseline; owner logged in to the panel; `.setvv p` sent by O (so the auto-vv destination is O's private chat: a delegated `.vv` must ignore it).

1. **Groups** > A > **Permissions**. In the "Command" list, `vv` is in "Commands you can delegate" and `eval` is greyed in "Never delegable" with its reason ("it runs code on the bot's machine").
2. Choose `vv`, "Create the rule". Mode "Normal + these people" is selected; the editor shows the normal level (Owner) and no warning (an owner-level command is the point of the feature). Tick B in "Group members". Save. Stopwatch: well under a minute from step 1 (SC-001).
3. From B in A, reply `.vv` to a view-once photo: B receives the media **in private** from the bot; the group sees nothing (no reply, no reaction); O's private chat receives nothing even though `.setvv p` is set (SC-002).
4. From C, same gesture in A: "🔒 Cette commande est réservée au propriétaire du bot." From B in D, and from B in a private chat with the bot: the same refusal (the rule is for A only).
5. From O in A, `.vv` on a view-once: today's behaviour (the auto-vv destination, here O's private chat).
6. In the panel remove B, Save: from B the next `.vv` in A is refused again, without a restart (SC-005). Add B again and Save.
7. Restart the bot (**Dashboard** > Restart): B's `.vv` in A still works (FR-005).
8. From B, `.menu` in A lists `.vv`; in D it does not. `.help vv` shows the card in both, as it did at baseline: help hides only the commands closed to the person by "These people only" (FR-029).
9. **Admin command warning** (US1.5): in A open a rule for `kick` (an admin command), tick B, who is not an admin of A. The warning "1 person is not known to be an admin of this group..." shows **before** Save and Save is still allowed. Save. From B, `.kick @<a disposable member>` runs (the bot is admin of A). Then make the bot a non-admin of A: B's `.kick` gives the plugin's usual "the bot must be admin" reply, not a permission refusal. Delete the `kick` rule afterwards.
10. **History** shows one `command.permission.set` row per Save, target `vv:<A's jid>`, detail "Normal + these people: +1, -0" with B's number; Delete rows show `command.permission.delete`.

Coverage: Auto `command-permissions.test.js`, `vv-save-delegated.test.js`, `help-menu-visibility.test.js`, `admin-permissions.test.js`, `admin-view-permissions-{group,commands}.test.js`. Manual: the whole list on a device (the real view-once and the real DM).

### US2 Reserve a command to a few people in a group (P1)

*Setup*: the baseline; A has an admin member besides O (use B or C as a group admin for this scenario, then demote).

1. In A: rule for `dice` ("roll" is an alias), mode "These people only", tick B, Save. The editor shows no warning (the list is not empty).
2. From B in A: `.dice` answers. From C in A: nothing, no reply and no reaction. Make C a group admin of A: still nothing. From O in A: `.dice` answers although O is not in the list. Use the alias `.roll` from C: nothing.
3. From C in D and in a private chat with the bot: `.dice` answers (the rule is for A only). The bot log shows at most one `Silent refusal (command permissions)` info line per sender and command per minute.
4. Remove B and Save: the "These people only" rule has an empty list, the banner "The list is empty: only the owner will be able to use this command" shows. From B and C in A: nothing; from O: `.dice` answers. Put B back.
5. **Disabled wins**: in **Commands**, switch `dice` off globally. From B in A: "🚫 Cette commande est désactivée pour le moment." (command disabled); from O: the same; from C in A: still nothing (U1). Switch it back on.
6. **Menu and help**: from C in A, `.menu` does not list `dice` and `.help dice` answers "❌ Commande *dice* introuvable." exactly as for an unknown command; from B and O both show it. Compare with the baseline `.menu`: only `dice` is missing for C.
7. **Sticker-bound command**: O replies `.setcmd dice` to a sticker. In A, C sends that sticker: nothing; B sends it: `.dice` runs. In D, C sends it: `.dice` runs.

Coverage: Auto `command-permissions.test.js` (branches, stickers, aliases), `help-menu-visibility.test.js`. Manual: all steps.

### US3 Give a command to someone everywhere (P2)

*Setup*: B has written once to the bot in private (known contact); no rule yet.

1. **Commands** > `vv` row > **Permissions**. The card shows "Rule for vv", "Scope: everywhere (every group and private chats)" and "Normal level: Owner".
2. Add B from the contact list (the row shows B's name **and** number). Then type B's own number three ways, one at a time, with B's real country code (shown here for +237 690 000 001): `+237 6 90-00-00-01`, `00237690000001`, `(237) 690.000.001`. Each is the same person, so none adds a second chip: the editor says "This value already exists" (or, if the contact list knows B by a LID only, the two chips collapse into one person after Save). Remove B's chip and add B again by typing one of the formats alone: a chip appears. A 7-digit number and a national number without the country code (starting with 0) are refused with the hint "digits with the country code" and add nothing. Save with B only.
3. From B: `.vv` on a view-once in A, in D and in a private chat with the bot: each time the media arrives in B's private chat (in the private chat with the bot, in that same chat).
4. The **Commands** table now reads "Everywhere: Normal + these people (1 person)" for `vv`; the group tab of A has an "Allowed everywhere" card listing `vv` and B.
5. **Mode precedence** (US3.2-3.4) with `dice`: everywhere rule "These people only" with B. From C in A, D and in private: nothing. In A add a group rule `dice` "Normal + these people" **with nobody** and Save: it reads "Exception: normal level here" (information, since an "everywhere" rule in mode "These people only" exists). From C in A: `.dice` answers; in D: still nothing. Now edit A's rule to "These people only" with a list that does **not** contain B: from B in A `.dice` still answers (the "everywhere" pass is personal), from C nothing.
6. Create the same empty "Normal + these people" rule for `ping` in A (no "everywhere" rule exists for it): it reads "No effect". Delete it.
7. Delete the `dice` rules (group first, then everywhere): `.dice` is back to everybody everywhere.

Coverage: Auto `command-permissions.test.js` (precedence table), `admin-view-permissions.test.js` (`parseNumber`, `effectiveMode`), `admin-view-permissions-{group,commands}.test.js`. Manual: steps 2-3 and 5 on a device.

### US4 See and control what is in place (P2)

*Setup*: a rule in A for `vv` (B) and an "everywhere" rule for `dice`.

1. **Commands**: every row shows its normal level (Access column), its "everywhere" rule and the number of groups with their own rule. The locked rows are greyed, the Permissions button is disabled, and each shows its reason as text:

   | Reason | Commands |
   | ------ | -------- |
   | runs code | `eval`, `exec` |
   | updates the bot | `update` |
   | exports personal data | `exportcontacts` |
   | can lock the owner out of a chat | `ban`, `unban` |
   | sets how the bot behaves | `setvv`, `getvv`, `antidel`, `getantidel`, `ar`, `statussave`, `setcmd`, `delcmd`, `getcmd` |

   A request that tries to create a rule on one of them is refused with `422`: Auto only (`admin-permissions.test.js`); the panel never offers it.
2. The `dice` row's card lists the groups that have their own rule, read-only, with an Open link to the group's Permissions tab. The tab badge of A shows its number of rules.
3. **Audit**: **History** filtered on "Commands" shows each Save and Delete with the command, the scope (`<command>:<scope>`), the mode and "+N, -M" with the numbers. A Save that changes nothing adds no row.
4. **Former member**: have B leave A (or remove B), reopen A > Permissions: B's chip reads "No longer in the group" and has a working remove button. Save without B.
5. **Orphans** (optional, sandbox only): stop the bot, insert a rule on an unknown command and one on `getvv` into the sandbox database, start it again:

   ```bash
   sqlite3 database.db "insert into permission_rules(command, scope, mode, people, createdAt, updatedAt) values('nosuchcmd','*','extra','[{\"pn\":\"237690000001@s.whatsapp.net\",\"lid\":null}]',datetime('now'),datetime('now')), ('getvv','*','extra','[{\"pn\":\"237690000001@s.whatsapp.net\",\"lid\":null}]',datetime('now'),datetime('now'))"
   ```

   **Commands** lists "Rules without a usable command" with both rows (the reasons "Command no longer loaded" and "Command that can no longer be delegated"); delete both from the panel. Before deleting, B's `.getvv` is still refused as owner-only (SC-003).
6. **Backup round trip** (US4.6, FR-026): **Backup** > Export (passphrase of 12 characters or more) in the sandbox; in the second empty sandbox Backup > Restore, confirm; after the restart, **Commands** and A's Permissions tab show the same rules, the History is not copied (by design), and B's `.vv` in A works at the next message.

Coverage: Auto `admin-permissions.test.js` (orphans, audit, backup round trip, forged backup), `backup.test.js`. Manual: steps 1-4 and 6; step 5 optional.

## 4. Success criteria

| SC | Target | Auto | Manual |
| -- | ------ | ---- | ------ |
| SC-001 | `.vv` handed to a member from the panel in under a minute, no code, no restart | `admin-view-permissions-{group,commands}.test.js` (create flow), `admin-permissions.test.js` (cache invalidated after each write) | stopwatch on US1 steps 1-2 |
| SC-002 | a delegated `.vv` appears only in the requester's private chat | `vv-save-delegated.test.js` (every `view_once` mode, group, private, LID-only, failing send) | US1 step 3 with `.setvv p`, then again with `.setvv g` |
| SC-003 | no non-delegable command runs for anyone but the owner, whatever the rows (also after a hand-edited restore) | `command-permissions.test.js` (rows inserted by hand on each of the 14), `command-delegable.test.js`, `admin-permissions.test.js` and `backup.test.js` (tampered backup) | US4 step 5, `getvv` row |
| SC-004 | with no rule, every command behaves as before | `yarn test` (no change to command expectations; the 26-model and `counts.permissions` edits are structural), `help-menu-visibility.test.js` (no-rule menu equals the legacy one) | compare the baseline `.menu` of section 2 after deleting every rule |
| SC-005 | a change takes effect on the next message; a few hundred rules cost nothing noticeable | `command-permissions.test.js` (warm cache issues no query, 500 rules x 1,000 decisions under a loose bound) | US1 step 6, US2 step 4 (no restart) |
| SC-006 | "who can use this command in this group" from one page | `admin-permissions.test.js` (PERM-5 answers it in one request) | US1 to US3: the group tab (rules plus "Allowed everywhere") matches what each account actually gets |

## 5. Edge cases by hand

| # | Check | Expected |
| - | ----- | -------- |
| 1 | `.vv` delegated to B (number known): B replies `.vv` to a view-once in A | the media lands in B's private chat with the bot, nothing in A (US1 step 3) |
| 2 | Same with X, a member known by LID only (open A > Permissions: X is offered by the picker; tick and Save), then X replies `.vv` | the media lands in X's chat; nothing in the group. This is the least-tested addressing: record the result in the PR, or "not run" if no such member exists (the engine test fakes it) |
| 3 | B sends `.vv` in A with nothing quoted | the usage text ("Répondez à un message à vue unique avec .vv pour le révéler.") arrives in B's private chat, not in A. O doing the same still gets it in the chat |
| 4 | B sends `.vv` in A replying to a normal (not view-once) message | nothing anywhere |
| 5 | B has never written to the bot in private, then uses a delegated `.vv` | the media still arrives in private; if WhatsApp refuses it, B gets nothing and the group still sees nothing |
| 6 | `only` rule, then a non-listed member sends the command | no reply, no reaction, no error (US2 step 2) |
| 7 | Command disabled **and** `only` | listed people and O get "command disabled", everybody else silence (US2 step 5) |
| 8 | Menu and help | granted sees the command only where the rule applies; closed does not see it; with no rule the menu equals the baseline; `.help eval` from B still shows the card (FR-029) |
| 9 | Sticker bound by `.setcmd` | the rule applies to the sticker's author exactly as if they typed the command (US2 step 7) |
| 10 | Context limits | an `onlyGroup` command opened "everywhere" to B is still refused to B in private with the usual message; an `onlyPm` command is still refused in a group. The editor shows the information banner "only works in groups" or "only works in private chats" |
| 11 | O in a list | no effect (O always has access); no error |
| 12 | Two tabs on the same rule | edit rule R in tab 1 and tab 2, save in tab 1 then tab 2: the last save wins; **History** shows both rows |
| 13 | A group the bot left keeps its rules | remove the bot from E after giving E a rule, open E: the "former group" badge, the Permissions tab lists the rule, the member picker is replaced by "The bot cannot read the member list right now", removing a person and Delete still work. Add the bot back: the rule applies again |
| 14 | **Forget the group** (the spec's "Oublier ce groupe" is the Advanced tab's "Delete the settings", offered for a group the bot has **left** only) | remove the bot from E again, open E > Advanced, Delete the settings, confirm: the toast counts the permission rules, **Commands** no longer counts E among the groups with a rule, and adding the bot back finds no rule |
| 15 | **Bot offline, degraded tab** | cut the host's network for over a minute (the group metadata cache lasts 60 s), reload A > Permissions: the notice replaces the picker, people already in a rule show no "No longer in the group" or "Not an admin" badge, removing a person, changing the mode, Save and Delete still work, and an admin command rule still shows its warning ("not known to be admins"). **Commands** > a command > Permissions still works (contacts and typed numbers do not need WhatsApp). Restore the network: the tab recovers on reload |
| 16 | Deep links | `#/commands?command=vv&panel=permissions` opens the `vv` card; `#/groups/<A's jid>?tab=permissions` opens the tab; the "Allowed everywhere" card and the Commands card link to each other |
| 17 | Roles | `.role` keeps working: a `muted` or `banned` member named in a rule is still handled by `.role` as before (spec Assumptions) |

## 6. Manual checklist (real device)

Add the rows that apply to section 7 of `docs/AUDIT_COMMANDES.md` once validated, and update the rows of `.vv`, `.save`, `.help`, `.menu` and `.bmenu` of that report (runtime contract section 9).

### Delegation in a group (US1)

- [ ] `.vv` opened to B in A from the panel in under a minute, no restart.
- [ ] B's `.vv` in A: media in B's private chat only; nothing in A; O's chat untouched even with `.setvv p`.
- [ ] C, and B in D or in private: the usual owner-only refusal. O: unchanged behaviour.
- [ ] Removing B closes it at the next message; the rule survives a bot restart.
- [ ] `.kick` opened to a non-admin: the warning shows before Save; it runs when the bot is admin and answers as usual when it is not.
- [ ] `.menu` and `.help` show `.vv` to B in A, not in D.
- [ ] Delegated `.vv` with a hidden-number (LID) member: media in the member's chat, nothing in the group, or "not run" noted.

### Reserved commands (US2)

- [ ] `.dice` "These people only": B answers, C silent (also after becoming a group admin), O answers, other groups unchanged, aliases covered.
- [ ] Empty list: only O; the banner says so.
- [ ] Disabled wins: B and O get "command disabled", C silence.
- [ ] Menu and help hide the command from C and keep it for B and O.
- [ ] A sticker bound with `.setcmd` follows the same rules.

### Everywhere (US3)

- [ ] B from the contact list, a typed number in three formats (one person), short and national numbers refused.
- [ ] `.vv` works for B in A, D and private, always to B's private chat.
- [ ] Group rule "Normal + these people" with nobody restores the normal level in one group ("Exception"), "No effect" when nothing restricts the command.
- [ ] An "everywhere" pass survives a group `only` rule that does not list B.

### Visibility and audit (US4)

- [ ] Commands page: normal level, everywhere rule, group count; locked commands greyed with the five reasons.
- [ ] Group tab: rules, "Allowed everywhere", former member badge, orphans (optional).
- [ ] History: one row per effective Save or Delete, with the mode and "+N, -M".
- [ ] Backup export and restore on an empty sandbox bring the rules back and they apply at the next message.

### Cross-cutting

- [ ] Delete the settings of a left group removes its rules; a group the bot merely left keeps them.
- [ ] Bot offline: the group tab degrades as described (edge case 15).
- [ ] Both new screens at 360 px without horizontal scroll (`document.documentElement.scrollWidth > document.documentElement.clientWidth` must be `false`), light and dark themes, keyboard-only use of the editor (radios, chips, remove buttons, Save).
- [ ] No request to a third-party host while using the new screens (DevTools Network tab).
- [ ] `yarn test`, `BOT_LANG=en yarn test`, `node tools/check-unused-deps.js` (0 unused dependencies) and the two merge dry runs are green.
