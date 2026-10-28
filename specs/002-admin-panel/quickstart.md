# Quickstart: validating the admin panel

How to run and validate feature 002 end to end: one scenario per user story (US1-US13), a check for every success criterion (SC-001 to SC-016), deployment notes, the memory measurement and a manual checklist for a real device. No implementation code here; module behaviour is in [contracts/runtime.md](contracts/runtime.md), routes in [contracts/admin-http-api.md](contracts/admin-http-api.md).

Legend: **Auto** = covered by `yarn test` (offline, no WhatsApp), **Manual** = needs a browser and/or a real phone. Page names ("Dashboard", "Settings", "Commands", "Groups", "Pairing", "Data", "Broadcasts", "Backup", "Maintenance", "Texts", "Alerts", "Logs", "Stats", "History") are the English labels of the panel.

## Prerequisites

| Tool | Version | Check |
| ---- | ------- | ----- |
| Node.js | >= 24 (`package.json` engines) | `source ~/.nvm/nvm.sh && nvm use 24 && node -v` (the default Node of a shell may be older) |
| Yarn | 4.17, vendored | `node .yarn/releases/yarn-4.17.0.cjs -v` (or `corepack enable`, then `yarn -v`) |
| git | any recent | needed by the updater (US11) and its tests |
| ffmpeg, yt-dlp | recent | media commands; `yt-dlp --version` for the download-tools update (US11) |
| Browser | the two latest versions of Chrome, Firefox or Safari, desktop and phone | DevTools device toolbar for the 360 px checks |
| Real accounts | a test number set as owner (`SUDO`), a second test number, a test group where the bot is admin, a second group, a WhatsApp Web session | pairing, group guard, broadcasts, alerts |
| Docker (optional) | any recent | the container scenarios of section 5 |

## 0. Work in a sandbox

Manual scenarios create a session, a database, `data/panel.key` and backups. Run them in a scratch worktree so your real `sessions/`, `database.db` and `data/` are never touched.

```bash
source ~/.nvm/nvm.sh && nvm use 24
git worktree add ../owb-qs 002-admin-panel      # or a fresh clone of the branch
cd ../owb-qs
node .yarn/releases/yarn-4.17.0.cjs install     # no config.env in the sandbox: pass settings inline
```

Start the bot with inline variables, for example `SUDO=<your test number> LOG_LEVEL=info node index.js` (or `node panel.js`, same panel). To start over: stop the bot and delete `sessions/main`, `database.db` and `data/` inside the sandbox.

## 1. Automated check

```bash
yarn test                                   # node --test --test-force-exit "test/**/*.test.js"
BOT_LANG=en yarn test                       # same in English (default is fr)
node --test --test-force-exit test/admin-security.test.js   # one file
node tools/check-unused-deps.js             # expected: "0 unused dependencies"
```

Expected: every test passes with no network, no WhatsApp and no write to the real `data/`, `sessions/` or `database.db`; the run stays under the 2-minute budget of feature 001 (the baseline was about 10 s; report the figure in the PR). `LOG_LEVEL=debug node index.js` prints `Loaded 81 plugins` (the 79 of feature 001 plus the hook-only `groupguard` and `knownchats`; still 78 commands), no `Failed to load plugin` and no `Duplicate alias`.

New suites and what they pin (existing suites gain cases; see runtime.md section 16):

| Test file | Covers |
| --------- | ------ |
| `test/settings-store.test.js` | precedence, validation, version conflicts, restart-needed, boot-only keys, encrypted secrets, catalog vs `config.env.example` parity |
| `test/texts.test.js` | text overrides, placeholder rule, original-changed flag, lazy descriptions |
| `test/command-state.test.js` | global and per-group disable, check position, fail-open, cache coherence |
| `test/client-lifecycle.test.js` | states, generation token, restart, pairing code, `resetSession` guards |
| `test/groupguard.test.js`, `test/knownchats.test.js` | anti-link (commands with links included), anti-bot id-shape fixtures (removed, logged suspect, never removed), exemptions, warn reuse; known-chat recording |
| `test/stats.test.js` | counters, flush, day boundaries in the bot timezone |
| `test/recurrence.test.js`, `test/broadcaster.test.js` | DST and short months; at-most-once delivery, pacing, cancel, resume, expiry; no retry transition; `once` media deleted 7 days after its run ends, recurring media kept, pre-filled copy of the media |
| `test/alerts.test.js` | types, rate limits, outbox during a disconnection |
| `test/updater.test.js`, `test/runtime.test.js` | temporary git repos (behind, diverged, dirty, no remote branch, rollback); supervisor, container and bind detection |
| `test/storage.test.js`, `test/keytests.test.js` | safe purge, symlink escapes, broadcast-media purge that keeps scheduled and recurring media; verdicts, 10 s limit, no key in output |
| `test/backup.test.js` | round trip, wrong passphrase, altered or truncated file, newer version, interrupted restore |
| `test/admin-security.test.js` | every route: 401 without session, CSRF and Origin refusals, headers, traversal, throttling, trust-proxy |
| `test/admin-secrets.test.js` | seeded secrets never found in responses, logs, audit, outbox or backup manifest |
| `test/admin-logging.test.js`, `test/admin-frontend.test.js`, `test/admin-i18n.test.js` | logger rules; no `innerHTML`/external URL in the SPA, vendored hashes; panel translations |
| `test/admin-stores.test.js`, `test/admin-live.test.js` | panel writes visible to the commands (cache coherence), economy adjustments, 500 groups; SSE and polling |
| `test/panel-legacy.test.js` | frozen contract of the legacy endpoints (status, keys, content type) |
| `test/admin-memory.test.js` | caps and heap/external delta of the panel (`test/panel-memory.test.js` is the opt-in RSS wrapper) |

## 2. First run: the console setup link (US1, SC-001)

```bash
rm -rf data database.db sessions/main            # sandbox only
SUDO=<your test number> LOG_LEVEL=info node index.js
```

1. Start a stopwatch. The console prints the bot banner, then a line with a URL of the form `http://localhost:3000/admin/setup?token=...` (it uses `PANEL_PUBLIC_URL` when set, and is printed once per start while no account exists; valid 30 minutes, single use).
2. Open the URL. The browser is redirected to the panel setup view (the token leaves the address bar). Choose a password of at least 12 characters and confirm: you land on the Dashboard, logged in.
3. Open **Settings**, change one value (for example `STICKER_PACKNAME`), save. Stop the stopwatch.

Expected: under 5 minutes, no file edited (SC-001). Reusing the link, or a link older than 30 minutes, is refused. Restarting the bot while no account exists prints a **new** link.

## 3. One scenario per user story

### US1 Secure access (P1)

*Setup*: section 2 up to step 1, before opening the link.

1. In a private window open `http://localhost:3000/admin/`: only an invitation to follow the setup link is shown.
2. `curl -si http://127.0.0.1:3000/admin/api/settings | head -1` (any data route under `/admin/api/`): `401`.
3. Open the setup link with a password of 11 characters: refused with a field message. Use 12 or more: logged in. Open the link again: refused.
4. Log out. Wrong passwords from one origin:
   ```bash
   for i in 1 2 3 4 5 6; do
     curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/admin/api/login \
       -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' \
       -d '{"password":"definitely-wrong-123"}'
   done
   ```
   The first five answer `401`, the sixth `429` with a `Retry-After`. Log in with the **correct** password in the browser: still refused for 15 minutes. **History** shows the blocked origin.
5. A session idle for 24 hours, or older than 7 days, is refused (Auto only: fake clock).
6. Reset: stop the bot, run `node tools/admin-reset.js`: it prints a new single-use link. Open it, choose a new password: every older session is invalid and lockouts are cleared.

Coverage: Auto `admin-security.test.js` (setup, login, throttle, expiry, reset, rotation, hashed ids at rest). Manual: the steps above.

### US2 Dashboard and restart (P1)

*Setup*: a paired sandbox (US4 first if the session is empty), logged in.

1. Dashboard shows connected, the bot number, uptime, version, messages processed, memory and the last 10 errors.
2. In a terminal run `watch -n1 'curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/health'`.
3. Click **Restart**, confirm. The state goes to restarting, then connected again within seconds, no QR, session kept; `/health` shows `503` for the few seconds in between.
4. To see a state change from outside: on the phone remove the device under Linked devices. The Dashboard moves to "logged out / re-pair" within 5 seconds of the client noticing. A silent network drop depends on the WhatsApp keep-alive (up to about a minute); the 5-second figure is the lag between the client's state and the screen.

Coverage: Auto `admin-live.test.js` (state pushed on `ready`/`close`/`qr`, 2 s polling fallback), `client-lifecycle.test.js` (restart single-flight, stale events ignored). Manual: steps 3 and 4.

### US3 Settings (P1)

*Setup*: logged in, a paired bot, your second number.

1. **Prefix**: Settings > General, set `!`, save. From the second number send `!ping` (answers) then `.ping` (silence), without restarting (SC-003).
2. **Validation**: an empty prefix, a prefix with a space, an unknown language, a malformed owner number, a number out of bounds: each refused with one message per field, nothing saved.
3. **Secrets**: enter a `GIPHY_API_KEY`, save, reload: only "set" and the last four characters. The full value is in no page, response, log or History entry. Check at rest: `ls -l data/panel.key` shows mode `-rw-------`; `sqlite3 database.db "select key, substr(value,1,7) from setting_overrides where key='GIPHY_API_KEY'"` prints `enc:v1:`.
4. **Restart-needed**: change `ALWAYS_ONLINE`: a "restart needed" banner with a button appears and stays until you restart.
5. **Owners emptied**: clear the owner list: a confirmation warns that nobody can run owner commands.
6. **Origin**: start with `PREFIX=#` in the environment; Settings shows origin "environment". Change it in the panel: origin "panel" and a "revert to file" action that brings `#` back (a different action from clearing).
7. **Key test**: with a deliberately wrong GIPHY key click Test: "refused". Click again within 10 seconds: a rate-limit message. A correct key: "accepted". Alpha Vantage has no Test button (its endpoint accepts any key).
8. **Two tabs**: open Settings in two tabs, change a value in tab A, save in tab B: "this setting changed since you opened the page", nothing overwritten.
9. **Lost key**: stop the bot, delete `data/panel.key`, start: the saved key shows "re-enter", the environment/file value applies, one error is logged.
10. **Inactive group**: the folded group "no effect today" lists unread settings read-only.
11. **Code defaults (U19)**: with no `config.env` value, `AUTO_STATUS_VIEW`, `ENABLE_MESSAGE_REACTIONS` and `STICKER_AUTHOR` show their code defaults (off, off, `Bot`) with origin "default"; with `AUTO_STATUS_VIEW=true` in the environment (the example's suggested value) the same key shows on, origin "environment", and the default column still says off. Nothing changes in how the bot behaves.

Coverage: Auto `settings-store.test.js`, `admin-secrets.test.js` (SC-004), `keytests.test.js`, `admin-i18n.test.js`. Manual: steps 1, 3 (at rest), 4, 8, 9.

### US4 Pair WhatsApp from the browser (P2)

*Setup*: empty `sessions/main` (fresh sandbox), logged in, a phone with WhatsApp.

1. **Pairing** shows a QR within 5 seconds and renews it when it expires. On the phone: Linked devices > Link a device > scan. The Dashboard shows connected and the number within 10 seconds of the scan (SC-006).
2. Disconnect (confirm), then choose "code": type your number as digits with country code (no `+`), request the code: an `XXXX-XXXX` code appears; on the phone choose "Link with phone number instead" and enter it. Connected again.
3. Disconnect while connected: confirm; the phone drops the device, the panel returns to waiting for pairing, `ls sessions/main` shows no stale credentials.
4. Request a code while connected: refused until you disconnect.
5. Request a code and **do not** enter it: after about 3 minutes the half-created session is wiped and a fresh QR appears.
6. Hit Pairing twice in 30 seconds with a code request: rate-limited.

Coverage: Auto `client-lifecycle.test.js` (fake Baileys: QR event, `restartRequired` without delay, preconditions, rate limit, symlink and path guards of `resetSession`), `admin-security.test.js` (QR route needs a session, `no-store`). Manual only: the real scan and code (steps 1-6).

### US5 Enable and disable commands (P2)

*Setup*: logged in, a paired bot, the second number, two groups A and B.

1. **Commands** lists each command once with aliases, category, description, access level; search "dice" and filter by category.
2. Disable `dice`: from the second number `.dice` answers "command disabled", through every alias; the owner is refused too. Restart the bot: still disabled. Re-enable: it answers.
3. Disable `dice` in group A only: refused in A, works in B and in private chat.
4. Disable globally and enable in group A: the global disable wins.
5. **Groups** > A shows its disabled commands and edits them without going through Commands.
6. Disable `unban`: the panel warns that the panel is then the only way back.

Coverage: Auto `command-state.test.js`, `registry.test.js` (check sits after the owner gate; sticker-bound commands covered), `admin-stores.test.js` (SC-013). Manual: steps 2-3 on a device.

### US6 Groups and the group guard (P2)

*Setup*: a test group with the bot as admin, a non-admin member (second number), a WhatsApp Web session of that member.

1. **Groups** lists name, member count, "bot admin" or not; filter by name. 500 groups list in under 2 seconds (Auto: seeded rows).
2. **Welcome**: enable with a message using the available variables, check the preview, add a member: the message is sent. An unknown variable is flagged in the preview and refused.
3. **Filters**: add, edit, delete one: the next message in the group follows, no restart.
4. **Anti-link**: enable in a group where the bot is **not** admin: the panel warns. Promote the bot, then as the member send `https://example.com`: the message is deleted and the member warned; keep going to `WARN_LIMIT`: the member is removed. An admin and an owner posting links are untouched. The rule is strict (U17): as the member send `.dl https://example.com` too; the message is deleted and the member warned, and the download never starts. As an admin or an owner, `.dl <url>` still runs.
5. **Anti-bot (U16)**: a Baileys-driven test account whose ids are the 40-character `3EB0...` or `BAE5`+12 hex shapes is removed (Auto: fixtures). A message with a 22-character `3EB0...` id (Baileys 7, probably WhatsApp Web) is never removed: the log shows one "suspect" line and **History** one `guard.antibot.suspect` entry per sender and group per day. Ordinary members on Android, iPhone **and WhatsApp Web** are never removed. Capture the `key.id` of a message sent from WhatsApp Web (a temporary debug log in the sandbox) and check that it is not in the removal shapes of `plugins/groupguard.js`; add the capture to the fixtures.
6. **Mute**: toggle on: only admins can send (the phone shows "only admins can send messages"); toggle off reopens the group.
7. **Former group**: make the bot leave a group: it shows as "former group", its settings are kept and can be deleted.
8. **Private chats**: the disabled-chat list shows chats disabled with `.ban` and re-enables them.

Coverage: Auto `groupguard.test.js` (delete, warn, remove at limit, a link inside a command is deleted and the command does not run, exemptions, id-shape fixtures with near misses, suspect logged once per day and never removed, no action without bot admin, no database query beyond the cached group row), `knownchats.test.js`, `admin-stores.test.js` (writes visible to `.welcome`/`.filter`), `hooks.test.js` (order role, tracking, afk, notify, groupguard, filters). Manual: steps 2, 4-7 (real group).

### US7 Logs and statistics (P3)

*Setup*: logged in; a throwaway, gitignored `plugins/test.js` that exports a command `boom` whose `execute` throws (delete it afterwards).

1. **Logs**: filter on level "error"; new entries arrive without reloading.
2. Send `.boom` from the second number: the entry appears; **Stats** shows `boom` among the failing commands, count +1.
3. With a deliberately wrong GIPHY key run `.gif cat`: the log shows the service error; search the page for the key text: no match.
4. **Stats** shows messages per day over 7 days, the 10 most used commands and the failing commands.

Coverage: Auto `admin-logging.test.js`, `admin-secrets.test.js`, `stats.test.js`, `admin-live.test.js` (log replay with `Last-Event-ID`). Manual: steps 1-4 once.

### US8 Bot data (P3)

*Setup*: logged in, second number, a group with economy.

1. `.remind 10m test` from the second number; **Data > Reminders** shows chat, author, due date. Cancel it: it is never sent (wait out the 10 minutes).
2. **Data > Economy**: after `.daily`, add 50 with a reason, then set a balance; `.balance` matches at once. An adjustment that would go below zero is refused. Reasons appear in **History**.
3. Delete a notify keyword, a sticker command, an AFK status, a task, an idea and a quote in the panel; the matching WhatsApp commands no longer list them.

Coverage: Auto `admin-stores.test.js` (20 concurrent `give` + 20 panel adds end at the exact sum; negative refused with zero writes; every delete visible to the command's own reader). Manual: step 1 (the 10 minutes).

### US9 Broadcasts and recurring messages (P3)

*Setup*: two test groups and a private chat that has written to the bot; a spacing long enough to watch (Settings > Limits, `BROADCAST_DELAY_MS`, 2-600 s).

1. **Broadcasts > New**: text plus an image; the destination picker offers only known groups and chats, with no free-text number field. Preview, confirm (the dialog states the destination count), send. Watch live progress; messages are at least the configured spacing apart; each destination receives it once.
2. Cancel a run while it is going: no further destination receives it; the report lists served, failed and cancelled.
3. Restart the bot (panel Restart, then also `kill -9` the process and start it again) during a run: it resumes with the remaining destinations and nobody receives it twice.
4. Schedule one for two minutes ahead; restart the bot before it is due: it still goes out.
5. Recurring "every day at HH:MM" two minutes ahead: one send per occurrence; pause, resume, edit and delete work.
6. Make the bot leave one of the target groups, then broadcast: that destination fails, the others continue. Cut the network mid-run: it pauses and resumes on reconnection.
7. **Failed destinations (U14)**: open the report of step 6. There is no "retry" button. "New broadcast to the failed destinations" opens the create form pre-filled with the same text, the same image and only the failed destinations that are still valid (the left group is dropped); a destination that may have been delivered (`timeout`, `connection closed`, `interrupted`) is marked and can be unticked. Nothing is sent until you confirm the destination count, and the result is an ordinary new broadcast with its own report.
8. **Media retention (U15)**: **Maintenance > Storage** lists "broadcast media" with its size and how much is kept for broadcasts that are scheduled or recurring. Emptying it removes the image of the finished broadcast of step 1 (the report then shows the media as deleted) and keeps the one attached to a recurring or still scheduled broadcast; the confirmation says how many are kept. The 7-day deletion after a `once` run is Auto only (fake clock).

Coverage: Auto `broadcaster.test.js` (SC-012 with 50 targets and both crash windows; SC-016 seven daily occurrences; no function or route moves a final target back to `pending`; a pre-filled broadcast made from a report sends only to the chosen failed destinations and reuses the media; `once` media removed 7 days after the run, recurring media kept), `recurrence.test.js` (DST gap and overlap, the 31st), `storage.test.js` (broadcast-media purge keeps scheduled and recurring media). Manual: steps 1, 4, 5, 7, 8 on real groups.

### US10 Backup and restore (P3)

*Setup*: a sandbox with some data (settings, a disabled command, a group welcome, a reminder, a text override) and a second empty sandbox (`../owb-qs2`).

1. **Backup** > Export with a passphrase of 12 or more characters: a `.owb` file downloads. Export again ticking "include the WhatsApp session": a warning that the file allows taking over the number; confirm to proceed.
2. In the second sandbox: Backup > Restore, upload the file, enter the passphrase: a summary (date, bot version, counts per type) appears and nothing has changed yet. Confirm: a pre-restore backup is written under `data/backups/`, data is replaced, the bot restarts. Compare settings, disabled commands, group settings, data and text overrides: identical (no admin account in the file; log in again).
3. Refusals, nothing modified: wrong passphrase; the same file with one byte changed (`printf '\x00' | dd of=file.owb bs=1 seek=100 conv=notrunc`); a truncated copy.
4. Restore a SQLite backup on Postgres and back (Auto, opt-in `TEST_POSTGRES_URL`).

Coverage: Auto `backup.test.js` (SC-011 round trip with canonical JSON per model, `Conversation` row not restored, newer `botVersion` refused, older backup missing a model or column accepted, interrupted apply leaves every table unchanged, session bytes copied unread). Manual: steps 1-3 once.

### US11 Maintenance (P3)

*Setup*: a git sandbox whose `origin` has one more commit with a higher `package.json` version; also an apt-installed yt-dlp if you have one.

1. **Maintenance > Update**: shows the installed version, the newer version and the commit list; Apply after confirmation: merge, dependency install only if the lockfile changed, smoke boot in a child, then the restart message. Under PM2 (`pm_id` present) the process restarts; with no supervisor detected the page keeps "restart the program to finish" until you restart it.
2. A pushed commit that breaks the boot: the update is rolled back to the previous commit and the page shows the reason; the bot keeps running the old version.
3. A branch with no remote counterpart (this very branch): blocker `no remote branch`, not a network error. Uncommitted tracked changes: blocker `dirty tree`.
4. In Docker: the page explains `docker compose pull && docker compose up -d` instead.
5. **Update download tools**: with the official yt-dlp "updated" or "up to date"; with an apt install "managed by your system" plus the right command; refused while a download runs.
6. **Storage**: lists temp media, broadcast media, anti-delete cache (in memory), panel backups, logs, database (size only); no anti-delete or view-once archive and no statuses folder. Create 5 MB in `media/temp`, wait over 60 seconds, purge it: 0 bytes. The database has no purge button. Broadcast media: see US9 step 8.

Coverage: Auto `updater.test.js`, `runtime.test.js`, `storage.test.js` (injected `run` for install and smoke failures; symlink escape; logs truncated, not unlinked). Manual: steps 1, 5 on a real install.

### US12 Bot texts (P3)

*Setup*: logged in, the second number.

1. **Texts**: search "owner"; open the "owner only" text in the bot language, change it, save. From the second number run an owner command: the new text arrives at once. "Revert to original": the original is back.
2. Remove a `{0}`-style placeholder from a text that has one: refused, with the expected tokens listed. Add one: refused.
3. Change a command description: `.help` and the menu show it immediately.
4. In the sandbox edit the file text of an overridden key in `lang/fr.json`, restart: your version stays in force and the page flags "original changed".

Coverage: Auto `texts.test.js` (SC-014), `registry.test.js` (description getter stays a string), `i18n.test.js`. Manual: step 1 on a device.

### US13 Alerts (P3)

*Setup*: `SUDO` set to your number; logged in.

1. **Alerts**: all six types listed, all on by default, with the number of recipients. Restart with empty `SUDO`: the page says alerts cannot be sent to anyone.
2. **Reconnected**: cut the network for over 5 minutes, restore it: one message with the outage duration. Under 5 minutes: nothing.
3. **Key refused**: wrong GIPHY key, `.gif cat`: one alert naming `giphy` and no key; again within 24 hours: none.
4. **Login blocked / new origin**: five wrong passwords (US1 step 4): an alert with time and origin. Log in from your phone on mobile data: an alert for the new origin.
5. **Errors in series**: use the throwaway `boom` plugin of US7 ten times within 10 minutes: one summary alert, and one stack DM for `boom` (not ten) in those 10 minutes; nothing more for an hour.
6. **Update available**: Auto only (needs a remote with a higher version).

Coverage: Auto `alerts.test.js` (SC-015, outbox during a disconnection, restart does not re-send, toggle off). Manual: steps 2, 3, 4.

## 4. Success criteria

| SC | Target | Auto | Manual |
| -- | ------ | ---- | ------ |
| SC-001 | secure the panel and change a setting in under 5 min | `admin-security.test.js` (setup flow) | stopwatch run of section 2 |
| SC-002 | 100 % of the example's settings shown; all editable except startup ones | `settings-store.test.js` (catalog = `config.env.example` = `config.js` reads), `admin-frontend.test.js` | open Settings and scan every group |
| SC-003 | every "immediate" setting applies on the next message | `settings-store.test.js` (generated per catalog key: write, then the accessor returns it), `pipeline.test.js` (prefix) | US3 step 1 |
| SC-004 | seeded secrets never in pages, responses, logs, history | `admin-secrets.test.js` | US3 step 3 |
| SC-005 | no page or action without a session; no change from another site | `admin-security.test.js` (generated from the route table) | US1 steps 1-2 |
| SC-006 | "connected" within 10 s of the scan | `client-lifecycle.test.js` (515 reconnects at once) | US4 step 1 with a timer |
| SC-007 | dashboard follows the real state within 5 s | `admin-live.test.js` | US2 steps 3-4 |
| SC-008 | every function usable at 360 px, no horizontal scroll | none (no browser in CI) | per view in the DevTools device toolbar at 360 x 640, run `document.documentElement.scrollWidth > document.documentElement.clientWidth` in the console: must be `false` |
| SC-009 | idle panel adds under 50 MB | `admin-memory.test.js` (heap and external under 25 MB, caps, no un-`unref`'d timer) | section 6 |
| SC-010 | existing checks and monitoring endpoints unchanged | `yarn test`, `panel-legacy.test.js`, `check-unused-deps.js` | the `curl` loop of section 5 |
| SC-011 | backup then restore gives identical data | `backup.test.js` | US10 step 2 |
| SC-012 | 50-destination broadcast interrupted by a restart: never twice, all remaining served | `broadcaster.test.js` | US9 step 3 (2 destinations) |
| SC-013 | a command disabled in a group is refused there at once and works elsewhere | `command-state.test.js` | US5 step 3 |
| SC-014 | an edited text is what the bot sends; placeholders never lost | `texts.test.js` | US12 steps 1-2 |
| SC-015 | 100 errors in an hour give one "errors in series" alert | `alerts.test.js` | US13 step 5 (10 errors) |
| SC-016 | daily message, 7 simulated occurrences with one outage over 1 h: exactly 6 sends | `broadcaster.test.js`, `recurrence.test.js` | none |

## 5. Deployment notes

### Bind address, activation, public URL, proxies

| Setting | Behaviour | Check |
| ------- | --------- | ----- |
| Default bind (U1) | `127.0.0.1` on a bare machine; `0.0.0.0` when a container (`/.dockerenv`, cgroup) or a panel host (`PORT` set) is detected; `PANEL_HOST` always wins | `node index.js` then `ss -ltn \| grep :3000` shows `127.0.0.1:3000`; `PORT=3000 node index.js` shows `0.0.0.0:3000`; `PANEL_HOST=0.0.0.0 node index.js` too |
| `ADMIN_PANEL` | on unless exactly `false`; `PANEL_ENABLED` is ignored and gone from the example (U18) | `ADMIN_PANEL=false node index.js`: the console says the panel is off, `/admin/` is not served, the bot runs. `PANEL_ENABLED=false node index.js`: one console line says the variable is no longer read and names `ADMIN_PANEL=false`; the panel still starts |
| Busy port | the bot keeps running and the console names `PANEL_PORT`, `PANEL_HOST` and `ADMIN_PANEL=false` | start a second instance on the same port |
| `PANEL_PUBLIC_URL` | base of the printed setup link and an allowed Origin host | `PANEL_PUBLIC_URL=https://bot.example.com node index.js` prints that base |
| `PANEL_TRUST_PROXY` | empty = forwarded headers never trusted; otherwise IPs/CIDRs or `loopback`, `private`, `all` | `curl -H 'X-Forwarded-For: 203.0.113.9' http://127.0.0.1:3000/admin/api/session`: ignored, and the panel shows the undeclared-proxy banner; with `PANEL_TRUST_PROXY=loopback` the same header becomes the throttling origin |
| HTTPS warning | permanent banner when reached off localhost without TLS | open the panel by LAN IP over HTTP |
| Legacy endpoints | unchanged | `for p in / /health /healthz /status /ping /metrics /api/info; do curl -s -o /dev/null -w "$p %{http_code} %{content_type}\n" http://127.0.0.1:3000$p; done` (503 on `/` and `/health` until connected; no number, token or path in any body) |
| `POST /api/restart` | still bearer-token protected, still `process.exit(0)` | `curl -si -X POST http://127.0.0.1:3000/api/restart` is `403` without `PANEL_TOKEN`, `401` with a wrong token |

### Docker

```bash
docker compose build && docker compose up -d
docker compose logs bot | grep "admin/setup"        # the setup link is in the container logs
```

Inside a container the panel binds `0.0.0.0`. `docker-compose.yml` only `expose`s the port; to reach it from the host uncomment `ports: ["127.0.0.1:3000:3000"]`, or put a reverse proxy in front (then set `PANEL_PUBLIC_URL` and `PANEL_TRUST_PROXY` to the proxy's network). The image health check calls `/ping` (not `/health`, which is 503 while unpaired and would block the first pairing). Persistent state lives in the volumes: `bot_data` holds `data/panel.key` and `data/backups/`, `bot_sessions` the WhatsApp session, `bot_db` the SQLite file. Losing `bot_data` costs only re-typing the saved API keys. An image install shows update instructions, not an update button; a yt-dlp update lives in the container's writable layer and is lost when the container is recreated.

### PM2

`yarn start` runs `index.js` under PM2 (the panel is inside it). PM2 sets `pm_id`, so the updater treats the install as supervised and the process exits after an update to be restarted by PM2. On a VPS keep the default local bind and use an SSH tunnel (`ssh -L 3000:127.0.0.1:3000 server`) or a reverse proxy with TLS; opening it to the Internet shows the HTTPS warning.

### Panel hosts (bot-hosting.net and similar)

`node panel.js` or `node index.js` both serve the panel on the host's `PORT`. Read the console for the setup link and set `PANEL_PUBLIC_URL` to the public address so the link is clickable. No terminal on the host: create an empty `data/admin-reset` file and restart to get a fresh link.

## 6. Memory measurement (SC-009)

```bash
node tools/measure-panel-memory.js
MEASURE_MEMORY=1 node --test test/panel-memory.test.js    # the same, as a test
```

The script runs a baseline child (config, database, plugins) and a panel child (admin created, a login, every page and read-only API fetched once, one SSE stream open, idle for 20 s) three times each with `--expose-gc`, an in-memory database and blank secrets (it never reads `config.env`). Expected: it prints the median RSS of both modes and the delta, and exits `0` when the delta is under 50 MB (the loaded bot is about 167 MB). The always-on `test/admin-memory.test.js` runs the same child once per mode and asserts the heap-plus-external delta under 25 MB and the structural caps (1000-entry ring, session and SSE limits, no timer left running).

## 7. Reset and recovery

| Situation | Action |
| --------- | ------ |
| Forgot the password | stop or leave the bot running, then `node tools/admin-reset.js`: prints a single-use link (30 minutes), records the issue in History; consuming it sets a new password, revokes every session, clears lockouts |
| No second shell on the host | create an empty `data/admin-reset` file and restart: the same link is printed and the file deleted |
| Origin blocked by mistake | consume a reset link (it lifts lockouts) or wait 15 minutes |
| Lost `data/panel.key` | saved API keys show "re-enter"; the environment/file values apply meanwhile |
| Restore interrupted | the previous state is kept; the console says "restore interrupted, previous state kept" at the next start; the pre-restore backup is under `data/backups/` |

## 8. Manual checklist (real device)

Add the rows that apply to the checklist of section 7 of `docs/AUDIT_COMMANDES.md` once validated, and update the `update` row of that report.

### Access and dashboard

- [ ] Section 2 under 5 minutes; the setup link is single use and expires after 30 minutes.
- [ ] Five wrong passwords block the origin; the correct one is refused for 15 minutes; History and an owner alert record it.
- [ ] Dashboard state, number, uptime, memory, last 10 errors; Restart keeps the session (no QR) and `/health` is `503` only briefly.

### Pairing

- [ ] Fresh sandbox: QR in under 5 s, renews, scan, connected in under 10 s.
- [ ] Pairing by code (digits with country code): `XXXX-XXXX` entered on the phone, connected.
- [ ] Disconnect removes the device on the phone and empties `sessions/main`.
- [ ] An abandoned code attempt wipes the session after about 3 minutes and a QR returns.

### Settings, commands, texts

- [ ] Prefix change works on the next message; invalid values refused per field.
- [ ] API key shown as set + last 4 only; Test says refused or accepted; second click within 10 s is rate-limited; `enc:v1:` at rest; file mode 600.
- [ ] Command disabled globally and in one group; owner refused; survives restart.
- [ ] Edited text and command description appear at once; placeholder removal refused.

### Groups and group guard

- [ ] Welcome with preview; unknown variable refused; filters live.
- [ ] Anti-link: warning panel notice without bot admin; link deleted and member warned; removed at the limit; a member's `.dl <url>` deleted and not run; admin and owner exempt, commands included.
- [ ] Anti-bot (U16): a 40-character `3EB0...` or `BAE5` bot-library account removed; a 22-character `3EB0...` id only logged as a suspect; **a human on WhatsApp Web, Android and iPhone is not removed**; the captured WhatsApp Web `key.id` added to the fixtures.
- [ ] Mute toggles "only admins can send messages" both ways.
- [ ] Former group listed and deletable.

### Data, broadcasts, backup

- [ ] A reminder cancelled in the panel never arrives; an economy adjustment shows in `.balance`; a negative result refused.
- [ ] Broadcast to two groups plus a private chat: spacing respected, once each, cancel works, restart mid-run resumes without duplicates, scheduled and recurring fire once; the report of a failed destination offers a pre-filled new broadcast (no retry button) and Storage lists "broadcast media" that keeps recurring media when emptied.
- [ ] Export, restore on a clean sandbox, identical data; wrong passphrase and altered file refused.

### Maintenance and alerts

- [ ] Update with a newer remote; rollback on a broken commit; container shows instructions; yt-dlp update outcomes; temp media purge.
- [ ] Alerts received: reconnect after over 5 minutes, key refused (once per day), login blocked, new origin, errors in series (one alert, one stack DM per command per 10 minutes).

### Cross-cutting

- [ ] Every view at 360 px without horizontal scroll; light and dark themes follow the device.
- [ ] No request to a third-party host while using the panel (DevTools Network tab).
- [ ] `yarn test`, `node tools/check-unused-deps.js` (0 unused dependencies), the legacy `curl` loop and `node tools/measure-panel-memory.js` all green.
