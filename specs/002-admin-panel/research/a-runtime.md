# Research A: runtime (settings, commands, texts, restart, pairing, panel boot, stats)

Phase 0 research for `002-admin-panel`. Method: static reading of `config.js`, `index.js`, `panel.js`, `lib/**`, `plugins/**`,
`test/**`, `node_modules/baileys` (7.0.0-rc14) plus one throw-away Node run that loaded the 79 plugin modules (78 commands) to
introspect descriptions. Nothing was started against WhatsApp; `config.env`, `sessions/`, `database.db` and `data/` were not read.
Decisions already taken by the user (panel overrides file, panel on by default in both modes, global + per-group command disable,
editable bot texts, in-process restart, browser pairing) are treated as fixed. Line numbers are those of the current branch.

### A1. Config consumption and the override mechanism

**Decision.** Replace the plain object exported by `config.js` with a catalog-driven object whose keys are accessor properties backed
by an in-memory `settings store` (synchronous reads, hydrated from the database at boot, updated in place on every panel write).

- `lib/settings/catalog.js`: pure data, one entry per setting (`key`, `env`, `theme`, `type`, `validate`, `default` or `defaultFn`,
  `secret`, `effect` = `immediate | restart | boot`, `backing` = `config | adapter`, `flags`). Appendix A is its first draft.
- `lib/settings/store.js`: no database import (config.js must stay loadable before Sequelize models exist). Resolution order per key:
  panel override, then `process.env[env]` (non-empty, parsed and validated), then default. An invalid file value falls back to the
  default and is recorded in `store.problems[key]` (spec edge case "valeur invalide dans le fichier"). Values are precomputed on
  `hydrate/set/reset`, so a read is a property lookup (155 `config.PREFIX` reads stay free). Derived defaults (`GEMINI_VISION_MODEL`
  falls back to `GEMINI_MODEL`, config.js:86) use `dependsOn`.
- `lib/database/models/Setting.js`: `key` PK, `value` TEXT stored in the same raw string format as the environment (`"true"`,
  `"3"`, `"a,b"`), `version` INT, `updatedAt`. One shared parse/validate path for env and panel; backups stay trivial. An override of `""`
  is a deliberate value ("clear the API key"); "revert to file" deletes the row (two different actions, FR-017/FR-021).
- Write path: validate the whole batch (types, bounds, cross-field rules such as `AUTO_RESPONDER_MIN_DELAY <= MAX_DELAY`), then one
  transaction with `UPDATE ... WHERE key=:k AND version=:v` per key (409 on mismatch, FR-020), then update memory, then
  `store.emit("change", keys)`. Secrets never leave the store: snapshots expose `{set, last4}` and `store.secretValues()` feeds the redactor.
- `config.js` keeps `DATABASE`, `VERSION`, `BRANCH` as data properties and installs the accessors. A property setter stores a
  non-persistent "runtime" value, because tests assign `config.SUDO = ""` and `config.PANEL_TOKEN = TOKEN`
  (`test/permissions.test.js:179,232`, `test/panel.test.js:58-144`) and `fakes.setupEnv` sets `process.env` before the first
  `require("config")` (`test/helpers/fakes.js:102-123`). With no database rows the object behaves exactly like today.
- Boot order (both entry points): `authenticate()` -> `sync()` -> `settings.load()` -> `languageManager.reload()` -> `PluginLoader.loadAll()`
  -> `attachHandlers` -> `client.initialize()`.
- "Restart required" (FR-016, US3 AS4): `store.inForce[key]` is snapshotted at boot and after each in-process restart; a key of effect
  `restart` whose resolved value differs from `inForce` is listed as pending until the restart.
- Adapter-backed settings (the config value is only a seed): AutoResponder row (cache key `auto_responder`), AntiDelete row
  (`anti_delete`), ViewOnce row (`view_once`) and `data/status_save.json` (`statusListStore`). The panel edits these through their
  existing stores plus `settingsCache.invalidate(key)` (CLAUDE.md rule), never through an env override that would be ignored.

**Rationale.** ~260 of the ~273 `config.X` references (92 files: 72 plugins, 18 in `lib/`, `index.js`, `panel.js`; 55 distinct names)
already read at call time, so accessors apply an override on the next message with no call-site change. Only the captures below break that.

**Require-time captures (the work list).**

| Kind | Where | Effect on panel overrides |
|---|---|---|
| Destructured at require | `index.js:5` (`VERSION`, constant), `lib/database/index.js:1` (`DATABASE`) | none / boot-only |
| Module constants | `panel.js:39-45` (`PREFIX` is stale in `/api/info`, `PORT`, `HOST`, `KEEP_ALIVE_INTERVAL`), `plugins/imagesearch.js:24` (`MAX_UPLOAD`) | fix `imagesearch` (lazy function) and `panel.js:40`; the rest is boot-only |
| Logger level at require | `plugins/feedback.js:8`, `update.js:11`, `vv.js:11` (`config.LOG_LEVEL`) + 15 `pino({ level: process.env.LOG_LEVEL })` | `LOG_LEVEL` is boot-only |
| Singleton constructors | `lib/utils/language.js:10` (`LANG`), `conversationManager.js:26-27`, `antiDeleteHandler.js:57-58`, `memoryManager.js:11-12` | `LANG` needs a change hook (A3); 3 intervals need `reconfigure()`; 3 thresholds become live getters |
| `process.env` bypassing config | `lib/baileys/client.js:98` (`BAILEYS_LOG_LVL`), `:100` (`ALWAYS_ONLINE`), `panel.js:43` (`PORT`) | switch to `config.*` (effect `restart`) |
| Derived credential caches | `autoResponderHandler.js:37-41` (`genAI`), `plugins/music.js:25,31` (`spotifyToken`), `plugins/reddit.js:37` (`tokenCache`) | reset on `change` of the matching keys |
| Seeds, not live values | `autoResponderHandler.js:87-89,185`, `statusListStore.js:48-49,99` | adapters (above) |

`parseCommand(body, prefix = config.PREFIX)` (`registry.js:204`) and `registry.executeCommand` (`:257`) evaluate per call: fine.

**Alternatives considered.**
- Write overrides into `config.env`: read-only on many hosts, no origin tracking, no concurrency control, secrets in a file the panel is supposed to supersede.
- Mutate `process.env`: loses the origin (cannot "revert to file"), strings only, and `execFile` children (yt-dlp, ffmpeg) inherit it, widening secret exposure.
- `Proxy` around config: works, but accessors are faster and keep `Object.keys(config)` honest.
- Replace `config.X` by `await settings.get("X")`: touches ~273 sites, impossible in sync contexts (default parameter, constructors).

**Evidence.** config.js:12-209; registry.js:204,257; pipeline.js:116,231; client.js:98,100,192-267; language.js:10; imagesearch.js:24;
panel.js:39-45,247; fakes.js:102-123.

**Files impacted.** `config.js` (rewrite around the catalog), new `lib/settings/{catalog,store}.js`, new `lib/database/models/Setting.js`,
`lib/baileys/client.js:98,100`, `lib/utils/{conversationManager,antiDeleteHandler,memoryManager,language,autoResponderHandler}.js`,
`plugins/{imagesearch,music,reddit}.js`, `panel.js:40`, `config.env.example` (add the 13 missing names, flip `PANEL_ENABLED`),
new `test/settings.test.js` (catalog, `config.env.example` and `process.env.*` reads of config.js must list the same names).

### A2. Settings catalog (summary; full table in Appendix A)

**Decision.** Catalog = every name read by `config.js` (86 environment variables, 85 exported keys) plus the 4 adapter-backed
rows and the new keys of Appendix B. Each row carries a theme, type, validation, default, `secret`, `effect` and flags.

**Findings.**
- 23 environment-backed keys have no reader anywhere (grep over `lib`, `plugins`, `index.js`, `panel.js`): `SESSION_ID`, `AUTO_READ`,
  `STATUS_SAVE_FOLDER`, `ANTI_DELETE`, `VPS`, `ANTILINK_MSG`, `ANTIBOT_MSG`, `GROQ_API_KEY`, `RMBG_KEY`, `CLOUDMERSIVE_API_KEY`,
  `APYHUB_API_KEY`, `DEEPAI_API_KEY`, `WAIFUPICS_API_KEY`, `PUTERJS_API_KEY`, `IMAGE_API_TIMEOUT`, `IMAGE_API_MAX_SIZE_MB`,
  `HEROKU_APP_NAME`, `HEROKU_API_KEY`, `KOYEB`, `KOYEB_NAME`, `KOYEB_API`, `RENDER_NAME`, `RENDER_API_KEY` (plus the constant `BRANCH`).
  `PANEL_ENABLED` is also unread today (config.js:206 only). SC-002 ("100 % of the example appears") would show editable controls with no effect.
- Read by config.js but absent from `config.env.example` (13): `AUTO_STATUS_SAVE`, `STATUS_SAVE_LIST`, `STATUS_SAVE_FOLDER`,
  `TTS_MAX_LENGTH`, `MESSAGE_CONCURRENCY_LIMIT`, `CACHE_CLEANUP_INTERVAL`, `CACHE_MAX_AGE`, `CONVERSATION_UPDATE_INTERVAL`,
  `CONVERSATION_BATCH_SIZE`, `MEMORY_CLEANUP_INTERVAL`, `MEMORY_WARN_THRESHOLD`, and the host fallbacks `PORT`, `HOST`. Nothing in the example is unread by config.js.
- Example and code defaults diverge: `AUTO_STATUS_VIEW` and `ENABLE_MESSAGE_REACTIONS` are `true` in the example but `false` in code
  (`toBool(undefined)`, config.js:12,64,72); `STICKER_AUTHOR` is `Levanter Bot` vs `Bot` (config.js:76). The panel shows the code default.
- `ANTILINK_MSG`/`ANTIBOT_MSG` and `Group.antilink/antibot` (Group.js:19-26) exist, but no plugin enforces anti-link or anti-bot. See A8.
- `ANTI_DELETE` is unread; the real feature is the AntiDelete row (`antiDelMode` p/g/sudo/jid), handled by `antiDeleteHandler.js:165`.

**Rationale.** The catalog must be the single source for validation, panel forms, backup and the parity test, so dead keys need an explicit decision (A8).

**Alternatives considered.** Hide dead keys (violates SC-002 literally); show them editable (misleading). Recommended: show them in a
collapsed "inactive" group, read-only, tagged "no effect in this version", and remove them from the example in a follow-up.

**Evidence.** config.js:47-209; config.env.example:1-130; grep counts reproduced in Appendix A "Notes" column.

**Files impacted.** `lib/settings/catalog.js`, `config.env.example`, `test/settings.test.js`.

### A3. i18n overrides

**Decision.** Layer overrides inside `LanguageManager`, in memory and synchronous, persisted in a `TextOverride` table; make command
descriptions lazy through a description key captured at plugin load.

- Storage: `text_overrides(lang, key, value, baseHash, updatedAt)` with composite PK `(lang, key)`. `baseHash` = sha1 of the file text at
  override time; the panel flags `originalChanged` when the current file text hashes differently (FR-059, US12 AS4).
- Resolution in `getLang(key, ...args)`: `overrides[currentLang][key]` -> `translations[key]` (file) -> `overrides.en[key]` -> `en` file -> the key itself.
  Placeholders are replaced after resolution (`replacePlaceholders`, language.js:123-132), so an override keeps `{0}` semantics.
- New API on `languageManager`: `reload()` (re-read `config.LANG` and the file; needed because `currentLang` is fixed at language.js:10),
  `setOverrides(lang, Map)`, `getBase(lang, key)`, `getEffective(lang, key)`, `listKeys()`. Keep the property names `translations` and
  `currentLang`: `fakes.applyPendingI18n` mutates them (fakes.js:194-218).
- Why not `settingsCache`: `getLang` is synchronous with ~800 call sites and `settingsCache.getOrLoad` is async. The in-memory map is
  loaded at boot and replaced by a direct call after each panel write, restore or restart (single process). No TTL, so "next message" holds.
- Placeholder rule: the multiset of `/\{\d+\}/g` in the new text must equal the original's (same regex as `test/i18n.test.js:71`); on
  mismatch the response lists the expected tokens. Also non-empty, at most 4000 chars. Only keys present in `lang/en.json` can be overridden.
- Perf fix to ship with it: `getFallback` re-reads and re-parses `lang/en.json` from disk on every miss for non-English languages
  (language.js:85-95); cache the parsed English tree once.
- Menu: already dynamic. `buildHeader`, `typeLabel`, footer and all labels call `getLang` at execution time (`plugins/menu.js:67-107`,
  `help.js:25-30`). Only `cmd.desc` is stale: 78/78 commands store `desc: getLang("...")` evaluated at require time and
  `help.js:83` / `buttonmenu.js:80` display it.
- Descriptions: `languageManager.capture(fn)` records `{key, result}` for each `getLang` call made while `loader.loadPlugin` runs
  `require(file)`; the loader passes the key whose result equals `command.desc` to `registerPlugin(plugin, file, { descKey })`. The registry
  then defines `entry.desc` as an enumerable getter returning `getLang(descKey)` (fallback: the stored string). Bonus: descriptions also
  follow a `BOT_LANG` change, which they do not today. No plugin file changes (plugins stay free of new conventions).
  Probe over the real plugins: reverse lookup of the French description is unique for 78/78 commands, 73/78 follow `plugins.<file|name>.desc`
  (`antidel`, `apkdownload`, `tictactoe`, `vv`, `getvv`... use other segments), so capture beats naming conventions.
- Panel listing: `lang/en.json` has 1004 keys, identical to `fr.json`. Group by `common.*`, `extra.*` and `plugins.<segment>`; map a segment to a
  command by file name, alias or `descKey`; the "filter by command" of FR-056 uses that map.

**Constraints from `test/i18n.test.js`.**
- It reads `lang/*.json` and `specs/001-audit-fix-commands/i18n/*.json` statically, so DB overrides never reach it.
- It scans `plugins/`, `lib/` (recursively, so `lib/admin/**` too), `index.js`, `panel.js`: every literal `getLang("k")` must exist in `en` and `fr`
  with equal placeholders and non-empty values; `reply()`/`sendMessage()` `text|caption` must not hold letter-bearing literals
  (`// i18n-ignore` on the same or previous line is the escape hatch). New bot-side texts (`common.command_disabled`, alert texts,
  broadcast report lines) go through `getLang` and need `en` + `fr` entries.
- Panel UI strings (FR-036) belong in a separate catalog (`lib/admin/ui/i18n/{fr,en}.json`, own parity test), not in `lang/*.json`:
  they are not bot replies and must not appear in the FR-056 list.

**Alternatives considered.** Rewrite `lang/*.json` on disk (breaks git updates and FR-059); resolve overrides in `settingsCache` (async);
add `descKey` to each of the 78 plugins (large diff, new convention to enforce); reverse lookup by text (breaks once two keys share a text or
once the base text is overridden at load time).

**Evidence.** language.js:10-45,53-132; plugins/menu.js:67-107; plugins/help.js:25-30,83; plugins/buttonmenu.js:80; registry.js:113-128;
loader.js:55-60; test/i18n.test.js:39-71,117-135,162-185,262-272; test/registry.test.js:208-210 (`entry.desc` must stay a string; a getter is fine).

**Files impacted.** `lib/utils/language.js`, `lib/plugins/loader.js`, `lib/plugins/registry.js`, new `lib/database/models/TextOverride.js`,
`lang/{en,fr}.json` (new keys), new admin text service (validation, hash, listing).

### A4. Command disable (global and per group)

**Decision.** One chokepoint in `registry.executeCommand`, placed after the owner gate and before the group/PM/admin checks.

```js
// registry.js, inside the try (line 266), after the owner gate (270-273), before line 275
if (await commandState.isDisabled(entry, message)) {
  await safeReply(message, getLang("common.command_disabled"));
  return true;
}
```

- Data: table `command_state(command, scope, createdAt, updatedAt)`, composite PK; `command` = `entry.name` (first alias, registry.js:117),
  `scope` = `"*"` (global) or a group JID. A row means "disabled"; re-enabling deletes it (history lives in the admin audit log). Global wins
  automatically: `state.global.has(name) || (message.isGroup && state.byGroup.get(message.jid)?.has(name))`.
- Module: `lib/utils/commandState.js` (core must not import `lib/admin`): `isDisabled(entry, message)`, `load()`, `set(name, scope, disabled)`
  which writes then calls `settingsCache.invalidate("command_state")`. One cache key holding `{ global:Set, byGroup:Map }` (one `findAll`,
  default 5 min TTL). Fail-open: if `getOrLoad` returns `null` after a load error (settingsCache.js:65-71), nothing is disabled.
  Invalidate also on restore and in-process restart.
- Why after the owner gate: the spec wants "commande désactivée" for everyone including owners, but `help.js:19-22` hides owner-only commands from
  non-owners; answering "disabled" before the owner check would reveal hidden commands. After it, a non-owner still gets `common.owner_only`.
  Doing it before the group/admin checks avoids `isSenderAdmin()` (a network call, registry.js:285) for disabled commands.
- Pipeline interaction: `BannedChat` gate (pipeline.js:125-127) runs first and drops everything silently in a disabled chat, except an
  owner's `unban` (`isOwnerUnban`, pipeline.js:75-82), which then reaches the registry. If `unban` itself is disabled there, the owner gets
  "disabled" and must use the panel (FR-032); the panel should warn when disabling `unban`/`banchat`. Sticker-bound commands call the same
  `executeCommand` (pipeline.js:172-174) and are covered; `executeCommand` has no other caller (grep), so there is no bypass.
- Limits to document in the panel: `onMessage` hooks (`afk`, `addfilter`, `notify`, `trackmessages`) keep running when their command is disabled;
  commands are matched by alias, so state keys survive alias additions but not a changed first alias (the panel lists orphaned rows).
  Optional: hide disabled commands from `getVisibleCommands` (help.js:19-22) with a sync snapshot.
- Panel list: `registry.getCommands()` (each command once) plus `descKey`, `type`, aliases, and access flags derived like `describeAccess`
  (`help.js:60-68`: `fromMe/ownerOnly`, `adminOnly`, `onlyGroup`, `onlyPm`).

**Rationale.** Single entry point, cheap (a Set lookup after a cached load), consistent with the existing refusal style.

**Alternatives considered.** Unregister the alias (breaks "répond commande désactivée", needs reload); check in the pipeline (duplicates
alias resolution); per-plugin check (78 files, violates "don't re-check in plugins"); storing an explicit `enabled` boolean row (no semantic
beyond "absent", more states to back up).

**Evidence.** registry.js:256-313; pipeline.js:75-82,125-127,166-180,191; help.js:19-22,60-68; settingsCache.js:34-100.

**Files impacted.** `lib/plugins/registry.js`, new `lib/utils/commandState.js`, new `lib/database/models/CommandState.js`,
`lang/{en,fr}.json` (`common.command_disabled`), optional `plugins/help.js`.

### A5. In-process restart and browser pairing

**Decision.** Extend `WhatsAppClient` into the single owner of connection state, restart, pairing and session reset; the admin layer only calls it.

**State and events (additions to `lib/baileys/client.js`).**
- `this.state = { status, qr, qrAt, me, registered, lastClose, since }`, `status` in `idle | connecting | qr | open | reconnecting | stopped | logged_out`;
  `getState()` returns a copy; the client emits `state` and `qr`. Fed from the existing `connection.update` handler (client.js:134-180): Baileys
  emits `{connection:"connecting", qr: undefined}` at boot (socket.js:829), `{qr}` per ref (socket.js:721), `{isNewLogin:true}` on pair success (socket.js:736), `open`, `close`.
- The dashboard polls `GET /admin/api/status` every 2 s (works behind any proxy, meets FR-012's 5 s). The terminal QR stays (client.js:137-145).
- QR for the browser: the `qrcode` package is already a dependency, so render server-side with `QRCode.toString(qr, {type:"svg"})`; no CDN.
  The QR and pairing code are account-takeover credentials: authenticated endpoint only, `Cache-Control: no-store`, never logged.

**Restart.** `client.restart()` = `await stop(); await initialize();`.
- Listener safety: every `sock.ev.on` is registered on the new socket (client.js:134-287) and Baileys `end()` removes the old socket's listeners and
  destroys its emitter (socket.js:506-507). Client-level listeners (`attachHandlers`, guarded by a `WeakSet`, pipeline.js:22-24,222-270; the panel's
  own) live on the `EventEmitter` and survive. `test/panel.test.js:298-313` already proves `initialize()` re-arms after `stop()`.
- `runtime.restartBot()` (single-flight, 409 if busy): status `restarting` -> `settingsCache.clear()` -> `settings.reload()` -> `languageManager.reload()` ->
  `reconfigure()` of the 3 interval singletons -> `client.restart()` -> wait for `ready` (60 s) -> refresh `store.inForce` -> audit entry.
  `onReady` hooks run again (pipeline.js:264-267) and are idempotent by contract (`reminder.js:142`, `afk.js:168`, scheduler reads the socket at send time).
- The legacy `POST /api/restart` keeps `process.exit(0)` after 1 s (panel.js:268-271, tested at panel.test.js:116-137).
- Hardening required before the panel can call it (all in client.js):
  1. Reconnect race (client.js:163-165): `stop()` + `initialize()` inside the 3 s reconnect delay yields two sockets. Add a `generation` token incremented by `initialize()/stop()`; the delayed reconnect aborts if it changed.
  2. A late `close` from an old socket sets `isReady=false` on the new one (client.js:154). Ignore events of a stale generation (still emit `close` for the `stop()` path; panel.test.js:251 expects it).
  3. Make `initialize()` single-flight (return the pending promise).
  4. Reconnect after `initialize()` failure: the awaited call inside the event handler (client.js:165) has no catch; add a retry with backoff.
  5. `restartRequired` (515) follows every successful pairing; skip the 3 s delay for it so SC-006 (10 s after the scan) holds.
  6. Track the fire-and-forget `saveCreds` writes (client.js:183) so a session wipe can wait for them.

**Pairing code.** Baileys: `sock.requestPairingCode(phoneNumber: string, customPairingCode?: string): Promise<string>` (socket.d.ts:44, socket.js:596-653).
- Phone: digits only with country code, no `+` (encoded by `jidEncode(phoneNumber, "s.whatsapp.net")`); the code is 8 characters, display `XXXX-XXXX`.
- Preconditions: the WebSocket must be open (`sendNode` throws otherwise, socket.js:74-80): `await sock.waitForSocketOpen()` (exposed at socket.js:937), then
  call once status is `connecting`/`qr`, and only while `!sock.authState.creds.registered`. Already registered -> the panel demands a confirmed logout first.
- Side effect that matters: the call sets `creds.me = { id: <phone>@s.whatsapp.net, name: "~" }` and emits `creds.update`, so it is persisted before pairing succeeds.
  A socket created with `creds.me` takes the LOGIN path instead of REGISTRATION (socket.js:320-325); an abandoned or failed code attempt therefore
  poisons the session. Rule: if the connection closes while a pairing is pending and `registered` is still false (or the 3-minute window expires),
  call `resetSession()` automatically.
- Validate `^\d{8,15}$` after stripping spaces and `+`, allow one request per 30 s, log only the last two digits. Pairing code against a real device
  is not testable here; add it to the manual checklist of `docs/AUDIT_COMMANDES.md` section 7.

**Logout and safe session reset.**
- Existing `client.logout()` (client.js:328-335) unlinks on WhatsApp (`remove-companion-device`, then `end(Boom loggedOut)`, socket.js:572-594) and never reconnects.
  Gaps: nothing removes `sessions/main`, so the next `initialize()` loads invalid credentials and loops on 401; a remote unlink from the phone sets
  `shouldReconnect=false` with `stopped=false` (client.js:148-168) and leaves the client silently dead; `sock.logout()` throws when the socket is down.
- Add `client.resetSession()`: try `logout()` (catch -> `sock.end()`), await pending `saveCreds`, then delete the *contents* of `this.sessionPath`
  (not the directory: in Docker `sessions/` is a volume mount, docker-compose.yml). Guard: `path.resolve(sessionPath)` must equal
  `<repo>/sessions/<id>` with `id` matching `/^[\w-]+$/`, `lstat` must show a real directory (no symlink), and no file content is read; log only the
  number of removed entries. Then `initialize()` for a fresh QR. Status `logged_out` triggers the same "re-pair" call to action in the panel.
- `test/panel.test.js:356-366` fails if `panel.js` or `index.js` contain `.logout(` or if the body of `stop()` does: keep the call sites in `client.js` and `lib/admin/**`.

**Rationale.** All socket life-cycle rules stay in one class that tests already cover with a fake Baileys (`panel.test.js:170-214`); the admin layer is thin.

**Alternatives considered.** Spawn a child process for the socket (heavier, SC-009); restart the whole Node process (violates the decision and fails without a supervisor);
delete the session folder itself (breaks on volume mounts); rely on `printQRInTerminal` (removed in Baileys 7).

**Evidence.** client.js:34-294,314-335; socket.js:74-80,320-325,472-508,572-594,596-653,690-737,829,937; use-multi-file-auth-state.js:30-41;
pipeline.js:22-24,264-267; panel.test.js:170-214,298-366; docker-compose.yml.

**Files impacted.** `lib/baileys/client.js`, new `lib/admin/runtime.js`, `docs/AUDIT_COMMANDES.md` (checklist rows).

### A6. Panel in both launch modes

**Decision.** One shared server module started by both entry points; `panel.js` keeps its exports and URLs.

- Current state. `index.js` (82 lines): no HTTP, no counters, no signal handling (`conversationManager.js:78-91` owns SIGTERM and calls `process.exit(0)` only if no
  other listener exists, so the admin module must not add signal handlers in this mode). `panel.js` (669 lines): HTTP server, `botState`, keep-alive timer,
  graceful shutdown, exports `{ createServer, botState }` used by `test/panel.test.js:49,145,157`.
- Layout: `lib/admin/server.js` (`createServer(runtime)` -> `http.Server`), `lib/admin/monitoring.js` (the current public routes moved verbatim),
  `lib/admin/runtime.js` (state + EventEmitter + `restartBot`), `lib/core/boot.js` (`bootstrap({ mode })`). `index.js` and `panel.js` become thin wrappers;
  `panel.js` re-exports `createServer` and `botState` (alias of `runtime.state`) and keeps its keep-alive and signal handlers.
- Routing: `/ /health /healthz /status /ping /metrics /api/info /api/restart` and the unknown-route status page stay byte-compatible (panel.js:82-120,
  CORS `*` only on these). New namespace `/admin/**` (UI and `/admin/api/**`) never sends CORS headers (FR-008). `/` uses content negotiation:
  `Accept` containing `text/html` -> 302 `/admin/`; otherwise today's health JSON (curl, Docker, uptime robots send `*/*`; node `fetch` too).
- `startAdmin()`: returns `null` when `config.PANEL_ENABLED` is false; registers `server.once("error")` before `listen`; `EADDRINUSE`/`EACCES`/`EADDRNOTAVAIL` log an
  error naming `PANEL_PORT`/`PANEL_HOST`/`PANEL_ENABLED=false` and resolve `null` so the bot keeps running (FR-039). No automatic port increment (predictable URL,
  hosting panels need the exact port). Today a listen error in `panel.js` is an unhandled `error` event.
- Defaults: `PANEL_ENABLED` becomes opt-out (`!== "false"`; config.js:206 is `toBool`, false by default and unread today) and `config.env.example:113` must stop saying
  `false`. This breaks the "true only for the exact string `true`" convention of CLAUDE.md; document it. Port stays `PANEL_PORT || PORT || 3000`, host `PANEL_HOST || HOST || 0.0.0.0`
  (config.js:202-204); the first-run link is printed after `sync()` as `http://localhost:<port>/admin/setup/<token>` when the host is `0.0.0.0`.
- Listen first, as `panel.js` does today (hosts see the port during boot); DB-backed routes answer 503 until `runtime.dbReady`. A database failure at boot stays fatal
  (`process.exit(1)` in both modes); the "base indisponible" edge case then means a loss after boot.
- Memory (SC-009): `node:http` only, static assets read once and cached, no new dependency (`tools/check-unused-deps.js` must keep printing 0). New modules start no timer at
  require time (tests unref intervals while requiring `panel.js`, panel.test.js:27-39); timers start in `bootstrap` and are `unref()`'d.

**Rationale.** One implementation, no drift between modes, existing monitoring contract and tests untouched, and `index.js` users (PM2, Docker) get `/health` as a side benefit.

**Alternatives considered.** Admin server only in `panel.js` (contradicts the decision); second port for the admin (extra config, two ports to expose on hosts); replacing `/` with the UI
(breaks FR-011 consumers); an Express/Fastify dependency (memory, unused-deps check, not needed).

**Evidence.** index.js:49-79; panel.js:15-124,508-569,574-631,664-669; config.js:200-208; config.env.example:111-119; conversationManager.js:78-91; panel.test.js:14-62,143-159.

**Files impacted.** `index.js`, `panel.js`, new `lib/admin/{server,monitoring,runtime}.js`, new `lib/core/boot.js`, `config.js`, `config.env.example`, `docs/BOT_HOSTING_GUIDE.md`.

### A7. Stats hook points

**Decision.** A small buffered counter module with two new call sites, a neutral event bus for errors, and one new table.

- Exists today: (a) `panel.js` `botState.messagesProcessed` via `attachHandlers` option `onMessageProcessed` (pipeline.js:236-241): counts every raw message including `status@broadcast`
  and the bot's own, resets at each boot; (b) `recordError` ring of 100, fed only by `onError` (pipeline.js:205-211), i.e. exceptions outside commands; (c) `UserStats`
  (per user and group, lifetime, no time axis; `commandCount` counts messages that look like a command, trackmessages.js:62-66, not executed or failed ones; groups only).
  None gives per-day, per-command or failure data.
- New table `daily_stats(day, kind, key, count)`, PK `(day, kind, key)`, `day` = `YYYY-MM-DD` in `config.TIMEZONE` (luxon is already a dependency),
  kinds `msg`, `cmd`, `cmd_fail`, `group` (`key` = command name or group JID, `''` for `msg`). Retention 90 days.
- `lib/utils/usageStats.js`: `record(kind, key, n = 1)` into an in-memory Map, flushed every 30 s (`unref`) and on `beforeExit`; SQL increment as in
  trackmessages.js (`bulkCreate ignoreDuplicates` + `increment`). With `index.js` the SIGTERM path ends in `process.exit(0)`, which skips `beforeExit`: accept up to 30 s of loss there,
  `panel.js` flushes in its own shutdown.
- Hook points:
  - messages: `lib/core/pipeline.js` right after the `Message` is built (line 116): `record("msg", "")` when `!message.fromMe`, and `record("group", message.jid)` when `message.isGroup`.
    Statuses are excluded because they return at line 112.
  - command calls: `registry.executeCommand` just before `entry.execute.call` (registry.js:293), after the permission and disabled checks: `record("cmd", entry.name)`.
  - failures: registry.js catch block, after the `MEDIA_TOO_LARGE` branch (a user error, lines 298-303) and next to `notifyOwners` (line 310): `record("cmd_fail", entry.name)`
    and `bus.emit("command:error", { name, error })`.
- `lib/utils/events.js`: tiny `EventEmitter` singleton so core code (registry, client) never imports `lib/admin`. Subscribers: the dashboard error ring (redacted through
  `store.secretValues()`), the alert engine (FR-060: 10 errors in 10 minutes), `runtime` counters.
- Heads-up for the alerts and logs work: `notifyOwners` already DMs a stack trace to every owner on each command error (registry.js:226-250,310); 100 failures send 100 DMs, so the aggregated
  alert (SC-015) should be paired with a rate limit on that DM. Also, the per-module `pino()` instances write straight to fd 1 through SonicBoom (pino `lib/tools.js:366`), bypassing
  `process.stdout.write`: the 1000-entry log view (FR-033) needs a shared logger factory, which would also make `LOG_LEVEL` live.

**Rationale.** Counting at the two existing choke points covers every message and every command, including sticker-bound ones, with no plugin change.

**Alternatives considered.** Derive stats from `UserStats` (no time axis); write one row per event (write amplification on SQLite); count in `panel.js` only (absent in `index.js` mode).

**Evidence.** pipeline.js:101-117,205-211,236-241; registry.js:226-250,290-311; panel.js:48-59,494-503; trackmessages.js:62-66,120-141; UserStats.js:5-50.

**Files impacted.** `lib/core/pipeline.js`, `lib/plugins/registry.js`, new `lib/utils/{usageStats,events}.js`, new `lib/database/models/DailyStat.js`.

### A8. Points needing the user's decision

1. 23 dead settings (A2): show read-only in an "inactive" group, or drop them from the example and the panel? Recommended: read-only group now, removal later.
2. Anti-link and anti-bot (A2): no code enforces them though US6/FR-029 list them. Options: (a) implement enforcement in this feature, (b) show the toggles flagged "not enforced yet",
   (c) leave them out of the panel. Recommended: (c) now, tracked as a separate feature.
3. `YTDLP_PATH` is an executable path (`execFile` in downloader.js:115, `spawn` without a shell in update.js:27,75): editable from the panel it is an arbitrary-binary primitive for anyone holding the admin session.
   Recommended: classify as boot (read-only), a small deviation from SC-002; alternative: allow only bare command names without `/`.
4. Secrets are stored as plain text in the `settings` table, like `config.env` today. Acceptable (backups are passphrase-encrypted, FR-050) unless at-rest encryption is wanted; recommended: keep plain.
5. `PANEL_ENABLED` default flips to true (A6); an existing `.env` copied from the example (`PANEL_ENABLED=false`) keeps the panel off. Recommended: accept, mention in the release notes.

## Appendix A. Settings catalog (draft)

Legend. **Effect**: `imm` = next message/call; `rst` = in-process restart; `boot` = read-only in the panel (file/environment only). **Flags**: `UNUSED` = no reader in code;
`NIE` = not in `config.env.example`; `SEED` = value only seeds a database row/file; `DIV` = example and code defaults differ. **Secret**: write-only, shown as set + last 4.
Themes: general, behavior, api-keys (keys and models), responder, moderation, limits, advanced, boot. File:line = where the value is read.

| Key | Env var | Theme | Type | Validation | Default | Secret | Effect | Notes |
|---|---|---|---|---|---|---|---|---|
| PREFIX | PREFIX | general | string | 1-3 chars, no whitespace | `.` | no | imm | pipeline.js:116, registry.js:257; stale copy panel.js:40 |
| SUDO | SUDO | general | list | comma list; entry = 6-15 digits (optional `+`) or JID `digits[:dev]@s.whatsapp.net/lid/c.us`; max 20; empty needs confirmation | empty | no | imm | permissions.js:49; empty refuses every owner command |
| LANG | BOT_LANG | general | enum | file in `lang/`: ar bn en es fr hi id ru tr ur | `fr` | no | imm | language.js:10 needs a reload hook; env name is BOT_LANG (LANG is the OS locale) |
| TIMEZONE | TIMEZONE | general | string | valid IANA zone (`Intl.DateTimeFormat`) | `UTC` | no | imm | scheduler.js:88, antiDeleteHandler.js:42 |
| STICKER_PACKNAME | STICKER_PACKNAME | general | string | 0-64 chars | `Made with` | no | imm | sticker.js:184 |
| STICKER_AUTHOR | STICKER_AUTHOR | general | string | 0-64 chars | `Bot` | no | imm | sticker.js:185; DIV (example `Levanter Bot`) |
| ALWAYS_ONLINE | ALWAYS_ONLINE | behavior | bool | true/false | false | no | rst | client.js:100 reads process.env directly |
| AUTO_READ | AUTO_READ | behavior | bool | true/false | false | no | boot | UNUSED, DIV (example true); only status reads exist (client.js:206) |
| AUTO_STATUS_VIEW | AUTO_STATUS_VIEW | behavior | bool | true/false | false | no | imm | client.js:205; DIV (example true) |
| AUTO_STATUS_REACT | AUTO_STATUS_REACT | behavior | bool | true/false | false | no | imm | client.js:211 |
| STATUS_EMOJIS | STATUS_EMOJIS | behavior | list | comma list, 1-30 items, each at most 16 chars | 10 emojis (config.js:164) | no | imm | client.js:214-231 |
| AUTO_STATUS_SAVE | AUTO_STATUS_SAVE | behavior | bool | true/false | false | no | imm | NIE, SEED: `active = file.enabled or env` (statusListStore.js:48,99); panel drives `statusListStore.setEnabled` |
| STATUS_SAVE_LIST | STATUS_SAVE_LIST | behavior | list | comma list of numbers (6-15 digits) | empty | no | imm | NIE, SEED of `data/status_save.json` (statusListStore.js:49); panel uses add/remove |
| STATUS_SAVE_FOLDER | STATUS_SAVE_FOLDER | behavior | string | path | `media/status` | no | boot | UNUSED, NIE (statusSaver forwards to owners) |
| ANTI_DELETE | ANTI_DELETE | behavior | bool | true/false | false | no | boot | UNUSED; real state = AntiDelete row id 1 (`enabled`, `antiDelMode` p/g/sudo/jid, `antiDelJid`), cache key `anti_delete`: panel adapter |
| (view once) | none | behavior | adapter | ViewOnce row id 1 (`enabled`, `vvMode` p/g/jid, `vvJid`) | off | no | imm | cache key `view_once` (viewOnceHandler.js:88): panel adapter |
| ENABLE_MESSAGE_REACTIONS | ENABLE_MESSAGE_REACTIONS | behavior | bool | true/false | false | no | imm | Message.js:367; DIV (example true) |
| VPS | VPS | behavior | bool | true/false | false | no | boot | UNUSED, DIV (example true) |
| OPENAI_API_KEY | OPENAI_API_KEY | api-keys | string | 8-256 chars, no whitespace | empty | yes | imm | chatgpt.js:76, voice.js:117; test: `GET /v1/models` |
| GEMINI_API_KEY | GEMINI_API_KEY | api-keys | string | same | empty | yes | imm | gemini.js:92, imagen.js:45; autoResponderHandler.js:37 caches `genAI`: reset on change; test: list models (header, not query string) |
| GROQ_API_KEY | GROQ_API_KEY | api-keys | string | same | empty | yes | boot | UNUSED |
| RMBG_KEY | RMBG_KEY | api-keys | string | same | empty | yes | boot | UNUSED |
| WEATHER_API_KEY | WEATHER_API_KEY | api-keys | string | same | empty | yes | imm | weather.js:66 (Open-Meteo keyless fallback) |
| UNSPLASH_API_KEY | UNSPLASH_API_KEY | api-keys | string | same | empty | yes | imm | imagesearch.js:91 |
| GIPHY_API_KEY | GIPHY_API_KEY | api-keys | string | same | empty | yes | imm | imagesearch.js:44 |
| NEWS_API_KEY | NEWS_API_KEY | api-keys | string | same | empty | yes | imm | news.js:89 |
| ALPHA_VANTAGE_KEY | ALPHA_VANTAGE_KEY | api-keys | string | same | empty | yes | imm | news.js:176-187; free quota 25 requests/day, a test costs one |
| SPOTIFY_CLIENT_ID | SPOTIFY_CLIENT_ID | api-keys | string | 8-128 chars | empty | no | imm | music.js; token cache music.js:25 reset on change |
| SPOTIFY_CLIENT_SECRET | SPOTIFY_CLIENT_SECRET | api-keys | string | 8-128 chars | empty | yes | imm | music.js; test = client-credentials token request |
| REDDIT_CLIENT_ID | REDDIT_CLIENT_ID | api-keys | string | 8-128 chars | empty | no | imm | reddit.js; token cache reddit.js:37 reset on change |
| REDDIT_CLIENT_SECRET | REDDIT_CLIENT_SECRET | api-keys | string | 8-128 chars | empty | yes | imm | reddit.js; test = token request |
| CLOUDMERSIVE_API_KEY, APYHUB_API_KEY, DEEPAI_API_KEY, WAIFUPICS_API_KEY, PUTERJS_API_KEY | same names | api-keys | string | 8-256 chars | empty | yes | boot | UNUSED (5 keys) |
| GEMINI_MODEL | GEMINI_MODEL | api-keys | string | `[A-Za-z0-9._:/-]{1,80}` | `gemini-2.5-flash` | no | imm | autoResponderHandler.js:192, gemini.js:117 |
| GEMINI_VISION_MODEL | GEMINI_VISION_MODEL | api-keys | string | same, empty allowed | empty = GEMINI_MODEL (derived) | no | imm | gemini.js:117 |
| IMAGE_MODEL | IMAGE_MODEL | api-keys | string | same, empty allowed | empty = plugin default | no | imm | imagen.js:44 |
| OPENAI_MODEL | OPENAI_MODEL | api-keys | string | same | `gpt-4o-mini` | no | imm | chatgpt.js:98 |
| BACKEND_URL | BACKEND_URL | api-keys | url | empty or http(s) URL; strip credentials when displayed | empty | no | imm | socialdl.js:51-53 |
| AUTO_RESPONDER_ENABLED | AUTO_RESPONDER_ENABLED | responder | bool | true/false | false | no | imm | SEED of AutoResponder row id 1 (autoResponderHandler.js:87-89); source of truth = row, cache key `auto_responder`: adapter |
| AUTO_RESPONDER_IGNORE_NUMBERS | AUTO_RESPONDER_IGNORE_NUMBERS | responder | list | comma list of numbers | empty | no | imm | SEED (same row) |
| AUTO_RESPONDER_PERSONALITY | AUTO_RESPONDER_PERSONALITY | responder | text | 1-2000 chars | "You are a helpful and friendly assistant..." | no | imm | SEED + fallback (autoResponderHandler.js:185) |
| AUTO_RESPONDER_MIN_DELAY | AUTO_RESPONDER_MIN_DELAY | responder | int | 0-600000 ms, <= MAX_DELAY | 1000 | no | imm | autoResponderHandler.js:231 |
| AUTO_RESPONDER_MAX_DELAY | AUTO_RESPONDER_MAX_DELAY | responder | int | 0-600000 ms, >= MIN_DELAY | 3000 | no | imm | :232 |
| AUTO_RESPONDER_TYPING_SPEED | AUTO_RESPONDER_TYPING_SPEED | responder | int | 1-1000 chars/s | 50 | no | imm | :57 |
| AUTO_RESPONDER_MAX_TYPING_TIME | AUTO_RESPONDER_MAX_TYPING_TIME | responder | int | 0-120000 ms | 10000 | no | imm | :58 |
| AUTO_RESPONDER_RATE_LIMIT | AUTO_RESPONDER_RATE_LIMIT | responder | int | 1-1000 | 5 | no | imm | :104 |
| AUTO_RESPONDER_RATE_WINDOW | AUTO_RESPONDER_RATE_WINDOW | responder | int | 1000-86400000 ms | 60000 | no | imm | :103 |
| WARN_LIMIT | WARN_LIMIT | moderation | int | 1-50 | 3 | no | imm | warnuser.js:90,164 (`0` falls back to 3 today) |
| WARN_MESSAGE | WARN_MESSAGE | moderation | text | 1-1000 chars; tokens `&mention &warn &remaining`, unknown `&word` rejected | warning card (config.js:149) | no | imm | warnuser.js:167; env value goes through `unescapeNewlines`, panel value does not |
| WARN_KICK_MESSAGE | WARN_KICK_MESSAGE | moderation | text | 1-500 chars; token `&mention` | `&mention kicked` | no | imm | warnuser.js:196 |
| ANTILINK_MSG | ANTILINK_MSG | moderation | text | 1-500 chars | `_Antilink Detected &mention kicked_` | no | boot | UNUSED: no enforcement exists (A8) |
| ANTIBOT_MSG | ANTIBOT_MSG | moderation | text | 1-500 chars | `&mention removed` | no | boot | UNUSED (A8) |
| MAX_UPLOAD | MAX_UPLOAD | limits | int | 1-2000 MB | 230 | no | imm | 28 reads; captured at require in imagesearch.js:24 (make lazy) |
| DOWNLOAD_TIMEOUT | DOWNLOAD_TIMEOUT | limits | int | 10000-1800000 ms | 180000 | no | imm | downloader.js:58, apkdownload.js:180 |
| TTS_MAX_LENGTH | TTS_MAX_LENGTH | limits | int | 50-5000 chars | 500 | no | imm | NIE; tts.js:27, voice.js:19 |
| MESSAGE_CONCURRENCY_LIMIT | MESSAGE_CONCURRENCY_LIMIT | limits | int | 1-50 | 5 | no | imm | NIE; pipeline.js:231 |
| IMAGE_API_TIMEOUT | IMAGE_API_TIMEOUT | limits | int | 1000-120000 ms | 20000 | no | boot | UNUSED |
| IMAGE_API_MAX_SIZE_MB | IMAGE_API_MAX_SIZE_MB | limits | int | 1-100 MB | 10 | no | boot | UNUSED |
| YTDLP_PATH | YTDLP_PATH | advanced | string | executable name or path | `yt-dlp` | no | boot | downloader.js:54,115, update.js:75 (no shell); read-only recommended (A8 #3) |
| LOG_LEVEL | LOG_LEVEL | advanced | enum | trace debug info warn error fatal silent | `info` | no | boot | 15 loggers at require + feedback/update/vv; live only with a shared logger factory |
| BAILEYS_LOG_LVL | BAILEYS_LOG_LVL | advanced | enum | same enum | `silent` | no | rst | client.js:98 reads process.env |
| CACHE_CLEANUP_INTERVAL | CACHE_CLEANUP_INTERVAL | advanced | int | 10000-86400000 ms | 600000 | no | rst | NIE; antiDeleteHandler.js:57, needs `reconfigure()` |
| CACHE_MAX_AGE | CACHE_MAX_AGE | advanced | int | 60000-86400000 ms | 3600000 | no | imm | NIE; antiDeleteHandler.js:58 once made a live getter |
| CONVERSATION_UPDATE_INTERVAL | CONVERSATION_UPDATE_INTERVAL | advanced | int | 500-60000 ms | 2000 | no | rst | NIE; conversationManager.js:26 |
| CONVERSATION_BATCH_SIZE | CONVERSATION_BATCH_SIZE | advanced | int | 1-100 | 5 | no | imm | NIE; conversationManager.js:27 once live |
| MEMORY_CLEANUP_INTERVAL | MEMORY_CLEANUP_INTERVAL | advanced | int | 60000-86400000 ms | 900000 | no | rst | NIE; memoryManager.js:11 |
| MEMORY_WARN_THRESHOLD | MEMORY_WARN_THRESHOLD | advanced | int | 50-16384 MB | 400 | no | imm | NIE; memoryManager.js:12 once live |
| PANEL_TOKEN | PANEL_TOKEN | advanced | string | empty or 16-256 chars | empty | yes | imm | panel.js:247 read per request; empty = endpoint answers 403 |
| HEROKU_APP_NAME, HEROKU_API_KEY, KOYEB, KOYEB_NAME, KOYEB_API, RENDER_NAME, RENDER_API_KEY | same names | advanced | string/bool | free text (keys secret) | empty/false | the 3 `*_KEY`/`KOYEB_API`: yes | boot | UNUSED (7 keys, deployment leftovers) |
| DATABASE_URL | DATABASE_URL | boot | string | empty = `./database.db`; `postgres://` URL | empty | yes (embeds credentials; show scheme only) | boot | config.js:16,21 |
| DATABASE_SSL | DATABASE_SSL | boot | bool | `false` disables SSL | true | no | boot | config.js:18; opt-out semantics |
| PANEL_ENABLED | PANEL_ENABLED | boot | bool | `false` disables the panel | proposed true (now false) | no | boot | UNUSED today (config.js:206); A6 |
| PANEL_PORT | PANEL_PORT (fallback PORT) | boot | int | 1-65535 | 3000 | no | boot | config.js:202-203, panel.js:43 |
| PANEL_HOST | PANEL_HOST (fallback HOST) | boot | string | host or IP | `0.0.0.0` | no | boot | config.js:204 |
| KEEP_ALIVE_INTERVAL | KEEP_ALIVE_INTERVAL | boot | int | 5000-600000 ms | 60000 | no | boot | panel.js:45,488 (only updates `lastActivity`) |
| SESSION_ID | SESSION_ID | boot | string | free | empty | yes | boot | UNUSED (legacy; `sessions/main` multi-file auth replaced it) |
| (session dir) | none | boot | path | `sessions/main` | fixed | no | boot | client.js:21, shown read-only |
| VERSION, DATABASE, BRANCH | none | boot | constants | package.json, Sequelize instance, `"master"` | n/a | no | boot | BRANCH UNUSED; not part of the editable catalog |

## Appendix B. New keys required by the spec (no environment variable)

| Key | Type | Validation | Default | Effect | Source |
|---|---|---|---|---|---|
| BROADCAST_DELAY_MS | int | 2000-600000 ms | 5000 | imm | FR-047 |
| ALERT_RECONNECT, ALERT_ERROR_BURST, ALERT_KEY_REFUSED, ALERT_LOGIN_BLOCKED, ALERT_NEW_ORIGIN, ALERT_UPDATE | bool | true/false | decided by the alerts research | imm | FR-060 |

The admin UI language (FR-036) is a per-account preference, not a bot setting; the 200-destination cap and the 5-minute / 10-error / 1-hour alert thresholds are constants.
