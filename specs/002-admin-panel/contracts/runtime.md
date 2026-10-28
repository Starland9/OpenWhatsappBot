# Contract: runtime modules

Internal module contracts of feature 002 (signatures, behaviour, invariants, errors, events, who calls whom). Routes, error envelopes and SSE events are in [admin-http-api.md](admin-http-api.md); the per-setting table is in [settings-catalog.md](settings-catalog.md); tables and columns are in [../data-model.md](../data-model.md).

Where the stream files in [../research/](../research/) disagree, [../research.md](../research.md) wins (decisions U1-U19, arbitration R1-R5, C1). The points settled while writing this file are listed in [section 17](#17-points-settled-while-writing-this-contract); no product question is open.

Contents: [0 conventions](#0-conventions-and-module-map) / [1 settings store](#1-settingsstore-and-the-configjs-accessor) / [2 secretBox](#2-secretbox) / [3 capture sites](#3-capture-sites-to-fix) / [4 texts](#4-bot-texts-languagemanager-overrides) / [5 registry, stats, bus](#5-registry-command-state-stats-and-the-core-bus) / [6 client and runtime](#6-whatsappclient-lifecycle-attachhandlers-and-botruntime) / [7 groupguard](#7-pluginsgroupguardjs) / [8 knownchats](#8-pluginsknownchatsjs) / [9 broadcaster](#9-broadcaster-and-recurrence) / [10 alerts](#10-alerts) / [11 updater](#11-updater-runtime-and-ytdlpupdate) / [12 logger](#12-logger-redactor-and-ring) / [13 backup](#13-backup-and-maintenance-mode) / [14 storage and key tests](#14-storage-and-key-tests) / [15 admin composition](#15-libadmin-composition-and-boot) / [16 test seams](#16-test-seams) / [17 settled points](#17-points-settled-while-writing-this-contract)

## 0. Conventions and module map

### Dependency direction

| From | May require | Must not require |
| ---- | ----------- | ---------------- |
| `lib/admin/**` | everything below | - |
| `lib/utils/**`, `lib/core/**`, `lib/plugins/**`, `lib/baileys/**`, `plugins/**` | each other, `lib/database`, `config` | `lib/admin/**`, with one exception: `lib/utils/logger.js` and `lib/utils/settingsStore.js` may require the three leaf modules `lib/admin/logs/{redactor,ring,consoleCapture}.js`. A leaf imports only Node built-ins and the other leaves (enforced by `test/admin-logging.test.js`). |
| `config.js` | `lib/utils/settingsCatalog.js`, `lib/utils/settingsStore.js`, `lib/utils/runtime.js` | `lib/database/**` and any model (`config.js` stays loadable before Sequelize models exist) |
| engines (`broadcaster`, `alerts`, `updater`, `stats`...) | `lib/utils/http.js` (`withTimeout`, `safeLog`), `cooldown`, `permissions` | any HTTP code; `lib/admin/audit.js` (callers audit, engines return results) |

Core-to-engine notifications that would create a require cycle (`http.js` would require `alerts.js`, which requires `http.js`) go through the tiny bus of [section 5](#5-registry-command-state-stats-and-the-core-bus).

### Rules that apply to every new module

| Rule | Detail |
| ---- | ------ |
| Time | Anything that depends on the clock takes `now` (ms number or `Date`) in its options, default `Date.now()`; same convention as `scheduler.tick(nowArg)`. `cooldown.hit` still reads `Date.now()`: tests of throttles use `mock.timers.enable({ apis: ["Date"] })`. |
| Timers | None at `require` time. `start()` is idempotent, creates `unref()`'d timers, `stop()` clears them. `test/panel.test.js` unrefs intervals while requiring `panel.js`; that workaround must stay unnecessary for the new modules. |
| Errors | Typed errors extend `Error` with a stable snake_case `code` and optional `fields` (per-field `{ code, params }`) or `params`. Messages are for logs only and never carry a secret. The HTTP layer maps `code` to a status. |
| Logging | `createLogger(name)` from `lib/utils/logger.js`; no `console.*` in `lib/admin/**`; errors from axios/SDKs go through `safeLog(err)`. |
| Secrets | Runtime code reads secrets through `config.X`. No module copies `config` into a structure that is serialized or logged. |
| i18n | Texts the bot sends (alerts, `common.command_disabled`, broadcast report lines, console setup link, the `PANEL_ENABLED` boot warning) use `getLang("<area>.<key>")` with keys in both `lang/en.json` and `lang/fr.json` (edit both files directly; the merge tool and `fakes.pendingI18nKeys` are hard-wired to the 001 fragment folder). Panel UI strings are separate (`lib/admin/public/i18n/{en,fr}.json`). |
| Idempotence | Everything started from `onReady` or `bootstrap` tolerates being called again after a reconnection or an in-process restart. |

### Where things live

| Module | Layer | Needs the panel? | Sections |
| ------ | ----- | ---------------- | -------- |
| `config.js`, `lib/utils/settingsCatalog.js`, `settingsStore.js`, `secretBox.js` | engine | no | 1, 2 |
| `lib/utils/language.js` (edit), `textOverrides.js`, `commandState.js`, `stats.js`, `events.js` | engine | no | 4, 5 |
| `lib/baileys/client.js` (edit), `lib/core/botRuntime.js`, `lib/core/boot.js` | core | no | 6, 15 |
| `plugins/groupguard.js`, `plugins/knownchats.js`, `lib/utils/knownChats.js` | plugin + engine | no | 7, 8 |
| `lib/utils/broadcaster.js`, `recurrence.js`, `mutex.js`, `housekeeping.js` | engine | no | 9 |
| `lib/utils/alerts.js` | engine | no | 10 |
| `lib/utils/updater.js`, `runtime.js`, `ytdlpUpdate.js`, `plugins/update.js` (edit) | engine | no | 11 |
| `lib/utils/logger.js`, `lib/admin/logs/*` | engine + leaves | no | 12 |
| `lib/utils/maintenanceMode.js`, `lib/admin/backup/*`, `lib/admin/services/backup.js` | engine + admin | restore: yes | 13 |
| `lib/utils/safeFs.js`, `lib/admin/services/{storage,keyTests}.js` | engine + admin | yes | 14 |
| `lib/admin/**` (router, auth, audit, hub, services, routes, public) | admin | yes | 15 |

Engines run whether or not `ADMIN_PANEL` is enabled (R1): a scheduled broadcast, an alert or a text override must keep working with the panel off.

## 1. `settingsStore` and the `config.js` accessor

### Resolution order

For every key of the catalog, `config.KEY` resolves, synchronously, in this order; the first tier that holds a valid value wins.

| Tier | Source | Origin reported |
| ---- | ------ | --------------- |
| 1 | runtime assignment `config.KEY = v` (tests only, never persisted) | `override` (never reaches the API) |
| 2 | panel override: row of `setting_overrides` loaded in memory | `override` |
| 3 | environment, then `config.env` (dotenv does not override `process.env`), parsed with the key's legacy parser | `env` |
| 4 | catalog default (`default` or `defaultFn(get)` for derived defaults such as `GEMINI_VISION_MODEL`) | `default` |

Invariants:

- **Types do not change.** The accessor returns what `config.js` returns today: numbers for integers, booleans for flags, plain strings for lists (`SUDO`, `STATUS_SAVE_LIST`, `AUTO_RESPONDER_IGNORE_NUMBERS`, `STATUS_EMOJIS` stay comma-joined strings). No call site changes.
- An invalid tier-3 value (unparsable, out of bounds, unknown enum member) falls back to tier 4 and is recorded in `store.problems()[key]` (spec edge case "valeur invalide dans le fichier"). An invalid tier-2 value cannot exist (validated before it is written); a corrupted row falls through like an undecryptable secret.
- Legacy `parseInt(x) || default` made `0` mean "default". Keys whose catalog minimum is 1 or more behave the same (0 is invalid, so default); keys whose minimum is 0 now honour 0.
- Env values of `WARN_MESSAGE` / `WARN_KICK_MESSAGE` keep passing through `unescapeNewlines`; panel values do not.
- `ADMIN_PANEL` is true unless the string is exactly `false` (same opt-out shape as the existing `DATABASE_SSL`). The old `PANEL_ENABLED` is no longer read anywhere (U2, U18); `bootstrap` only warns once when it is present in the environment (section 15, step 1).
- Boot-only keys (`effect: "boot-only"`, which includes every `inactive` entry) are resolved once from tiers 3-4 and cannot be written.

### Catalog entry (`lib/utils/settingsCatalog.js`, pure data, no imports)

```js
{
  key: "PREFIX",                 // catalog key = SettingOverride.key = environment variable name (BOT_LANG, not LANG)
  env: "PREFIX",                 // variable read in tier 3 (null: panel-only key such as BROADCAST_DELAY_MS, ALERT_*, or an adapter virtual key)
  configProp: "PREFIX",          // property of the config object (BOT_LANG -> LANG); defaults to key
  theme: "general",              // general | behavior | api-keys | responder | moderation | limits | advanced | boot | alerts, plus the display group "inactive" (flagged entries only)
  type: "string",                // string | text | int | bool | list | enum | url
  default: ".",                  // or derived: "same_as:KEY" | "auto_host", computed by defaultFn(get)
  parse(raw) -> value,           // legacy parsing of an env/file string (throws or returns undefined when unparsable)
  serialize(value) -> string,    // raw env-format string stored in the table
  validate(value, ctx) -> null | { code, params },   // compiled from the rule object of settings-catalog.md section 6
  secret: false,                 // write-only in the panel, encrypted at rest
  effect: "immediate",           // immediate | restart | boot-only
  readonly: false,               // true for every boot-only entry and for YTDLP_PATH (U11)
  inactive: false,               // flag: no code reads it (U8); shown read-only under "sans effet aujourd'hui"
  source: "env",                 // env (override row over environment/file/default) | model | file
  adapter: null,                 // adapter id when source is model or file (see "Adapter-backed settings")
  confirm: null                  // confirmation token enforced by SET-2, e.g. "owners_empty" for SUDO
}
```

The catalog (entry shape and vocabulary: [settings-catalog.md](settings-catalog.md) section 1) is the single source for validation, panel forms, parity tests and backup. `test/settings-store.test.js` asserts that catalog keys, `config.env.example`, and the `process.env.*` reads left in `config.js` list the same names.

### Store API (`lib/utils/settingsStore.js`)

```js
store.load({ models, secretBox, redactor })        // async, after sync(); fills memory from setting_overrides; idempotent
store.reload()                                     // async; re-reads the table (restore, restartBot)
store.get(key)                                     // sync, typed value; the only call the config.js accessors make
store.origin(key)                                  // "override" | "env" | "default"
store.version(key)                                 // int; 0 when the key has no override row
store.describe(key) / store.snapshot()             // SettingView(s), safe to send to the browser
store.set(changes, opts)                           // async -> { changed: string[], versions: { [key]: int } }
store.unset(keys, opts)                            // async -> { changed: string[] }   (back to file/default, FR-021)
store.addValidator(fn)                             // cross-field: fn(projected: (key) => value) -> { [key]: { code, params } } | null
store.pendingRestart()                             // string[]: keys of effect "restart" whose value differs from inForce
store.markInForce()                                // snapshot inForce; called at boot and by BotRuntime.restartBot
store.problems()                                   // { [key]: { code, params } }: bad file values, undecryptable secrets
store.setRuntime(key, v) / store.clearRuntime()    // tier 1; used by the config.js setter and by tests
store.onChange(keysOrNull, fn)                     // fn({ keys, source, at }); also store.on("change", fn)
store.rawOverrides({ decrypted }) / store.importOverrides(rows)   // backup and restore only
```

`set(changes, opts)` with `opts = { expectedVersions: { KEY: n }, confirmed: ["owners_empty"], actor }`:

1. Reject unknown keys (`unknown_key`), boot-only and `inactive` keys (`read_only`). Serialized by `mutex("settings")`.
2. Coerce and validate each value with the catalog, then run the cross-field validators on the projected state (for example `AUTO_RESPONDER_MIN_DELAY <= AUTO_RESPONDER_MAX_DELAY`, `GEMINI_VISION_MODEL` derived default). Check each entry's `confirm` token against `opts.confirmed`.
3. Any failure throws `SettingsValidationError` with `fields: { KEY: { code, params } }`; nothing is written. Submitted values are never echoed, secrets included.
4. Secrets: `secretBox.encrypt(value, "setting:" + key)`; a `SecretBoxError` aborts the whole batch before the transaction.
5. One transaction: per key `UPDATE ... SET value, version = version + 1 WHERE key = :k AND version = :expected`, or `INSERT` when the expected version is 0 (a unique violation counts as a conflict). Zero affected rows throws `SettingsConflictError { keys }` and rolls back (FR-020; HTTP 409 `settings_changed`).
6. After the commit: update memory (values are precomputed, so a read stays a property lookup), `redactor.register("setting:" + key, plaintext)` for secrets, then emit `change`.

An override equal to the empty string is a deliberate value ("clear the API key"); `unset` deletes the row (revert to file). They are different actions (FR-017, FR-021).

Failure behaviour: with the database down, `set`/`unset`/`reload` throw `db_unavailable` (HTTP 503); reads keep serving memory.

### SettingView (what leaves the store)

```js
{ key, theme, source, type, effect, inactive, readonly, secret: bool,
  default,                                    // omitted for secrets
  value,                                      // omitted for secrets
  secretState: { set: bool, last4: string },  // secrets only, any origin (env included); last4 only if the value is at least 8 chars
  origin, canRevert, version,                 // origin: "default" | "env" | "override"; canRevert: override over source "env" only
  pendingRestart: bool,                       // restart needed
  problem: null | { code, params } }          // "reenter" for an undecryptable secret
```

### Change events

`change` fires after memory is updated, with `{ keys, source: "panel" | "unset" | "restore" | "load", at }`. Listeners are isolated (an exception is logged and never fails the write). Subscribers:

| Subscriber | Keys | Reaction |
| ---------- | ---- | -------- |
| `languageManager` | `BOT_LANG` | `reload()` (descriptions follow because they are lazy, section 4) |
| `autoResponderHandler` | `GEMINI_API_KEY` | `genAI = null` |
| `plugins/music.js` | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | drop `spotifyToken` |
| `plugins/reddit.js` | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | drop `tokenCache` |
| `alerts` | `ALERT_*` | none (read per raise) |
| `broadcaster` | `TIMEZONE` | recompute `nextRunAt` of active recurring broadcasts |
| `logger` | `LOG_LEVEL` | `logger.setLevel(level)` (section 12) |
| redactor | secret keys | registered by the store itself |

Keys of effect `restart` are applied by `BotRuntime.restartBot()` (section 6): `ALWAYS_ONLINE`, `BAILEYS_LOG_LVL` are read when the socket is created; `CACHE_CLEANUP_INTERVAL`, `CONVERSATION_UPDATE_INTERVAL`, `MEMORY_CLEANUP_INTERVAL` through `reconfigure()` of their singletons. The accessor returns the new value at once; `effect` only drives the "restart needed" banner (`pendingRestart()` against `inForce`) and tells the implementer which readers re-read at call time.

### Adapter-backed settings

`AUTO_RESPONDER_ENABLED`, `AUTO_RESPONDER_IGNORE_NUMBERS`, `AUTO_RESPONDER_PERSONALITY` (fallback), `AUTO_STATUS_SAVE`, `STATUS_SAVE_LIST`, anti-delete and view-once have a real source of truth elsewhere (rows `id = 1` of `AutoResponder`, `AntiDelete`, `ViewOnce`; `data/status_save.json`). `config.X` keeps returning the env seed. The panel reads and writes them through `lib/admin/services/settings.js` adapters:

```js
adapter = { read: async () => value, write: async (value) => void, cacheKeys: ["auto_responder"] }
```

Each adapter is registered by the `adapter` id of its catalog entries. `write` calls the same helpers as the WhatsApp commands (`plugins/antidel.js`, `viewonce.js`, `autorespond.js`, `statusListStore.setEnabled/add/remove`) and then `settingsCache.invalidate(key)` for every cache key. Nothing is written to `setting_overrides` for these.

### Accessor construction (`config.js`)

`VERSION`, `DATABASE`, `BRANCH` stay data properties (`DATABASE` is built from `process.env` exactly as today). Every catalog key becomes `Object.defineProperty(config, key, { enumerable: true, configurable: true, get: () => store.get(key), set: (v) => store.setRuntime(key, v) })`. `Object.keys(config)` stays honest. Before `store.load()` the object behaves exactly like today (tiers 3-4).

Startup keys added or reshaped (all read-only in the panel, R5): `ADMIN_PANEL`, `PANEL_PORT` (`PANEL_PORT || PORT || 3000`, unchanged), `PANEL_HOST` (explicit `PANEL_HOST || HOST`, otherwise `""`; the effective value comes from `runtime.resolveBind()`, section 11), `PANEL_PUBLIC_URL`, `PANEL_TRUST_PROXY`, `LOG_FORMAT`, `SUPERVISED`, `UPDATE_CHECK`. `PANEL_TOKEN` stays an editable secret read per request by `POST /api/restart`. Panel-only keys (no env var): `BROADCAST_DELAY_MS`, `ALERT_RECONNECT`, `ALERT_ERROR_BURST`, `ALERT_KEY_REFUSED`, `ALERT_LOGIN_BLOCKED`, `ALERT_NEW_ORIGIN`, `ALERT_UPDATE` (default true).

## 2. `secretBox`

`lib/utils/secretBox.js`, AES-256-GCM from `node:crypto`; protects secret overrides stored in the database (U9, C1).

```js
secretBox.encrypt(plain, context) -> "enc:v1:<iv>:<tag>:<ciphertext>"     // sync; creates the key file when absent
secretBox.decrypt(token, context) -> { ok: true, value } | { ok: false, code }
secretBox.isEncrypted(str) -> boolean
secretBox.status() -> { keyPresent, keyValid }                            // never the path or any byte
createSecretBox({ dir, fs }) / secretBox.configure({ dir })                // tests point it at a temp dir
```

| Item | Contract |
| ---- | -------- |
| Token | `enc:v1:` then base64url of the 12-byte IV, the 16-byte tag and the ciphertext, separated by `:`. |
| Context | AAD = `"owb-secret/v1\0" + context`. The store passes `"setting:" + key`, so a ciphertext copied to another setting fails authentication. |
| Key file | `<root>/data/panel.key`, exactly 32 random bytes, mode 0600, `data/` created with mode 0700 when missing. |
| Creation | Lazy: only the first `encrypt`. Atomic and never overwriting (temp file then exclusive `link`, falling back to `wx`); an in-process mutex serializes it. |
| Never | Regenerated on `decrypt`. A key lost while `enc:` rows exist is reported, not silently replaced. |
| Invalid key file | A file that is not 32 bytes counts as lost: `encrypt` renames it to `panel.key.invalid-<ts>` and creates a new key. `decrypt` returns `key_invalid`. |

`decrypt` failure codes: `key_missing`, `key_invalid`, `auth_failed` (tampered or another key), `unsupported_version`, `malformed`. `encrypt` throws `SecretBoxError { code: "key_unavailable" }` when `data/` cannot be written.

Failure behaviour in the store (FR-017): an override that cannot be decrypted is ignored (tier 3 or 4 applies), `describe().problem = { code: "reenter" }`, one `error` log per key per boot (key name and code only). Entering a new value for that key works as soon as `encrypt` works; other undecryptable rows stay `reenter` until re-entered or unset. A secret write when `encrypt` throws returns HTTP 500 `secret_storage_unavailable` and writes nothing.

Backups carry decrypted values inside the passphrase-encrypted archive (`store.rawOverrides({ decrypted: true })`); restore re-encrypts them with this installation's key through `store.importOverrides` (section 13).

## 3. Capture sites to fix

Line numbers are those of this branch; re-grep before editing. Everything else reads `config.X` at call time and needs no change (about 260 of 273 reads).

| # | Site | Problem | Fix |
| - | ---- | ------- | --- |
| 1 | `lib/baileys/client.js:100` | `process.env.ALWAYS_ONLINE === "true"` bypasses `config` | `config.ALWAYS_ONLINE` (effect `restart`: read when the socket is created) |
| 2 | `lib/baileys/client.js:98` | `process.env.BAILEYS_LOG_LVL` | `config.BAILEYS_LOG_LVL` (effect `restart`) |
| 3 | `panel.js:40` | `PREFIX` captured at require, stale in `/api/info` | read `config.PREFIX` per request; `PORT`, `HOST`, `KEEP_ALIVE_INTERVAL` (`:43-45`) stay boot-only |
| 4 | `plugins/imagesearch.js:24` | `MEDIA_MAX_BYTES` computed from `config.MAX_UPLOAD` at require | function evaluated per call |
| 5 | `lib/utils/language.js:10` | `currentLang` fixed in the constructor | `reload()` (section 4) |
| 6 | `lib/utils/conversationManager.js:26-27` | interval and batch size in the constructor | `reconfigure()` re-arms the timer; batch size read through a getter |
| 7 | `lib/utils/antiDeleteHandler.js:57-58` | cleanup interval and max age in the constructor | `reconfigure()` for the interval; `maxCacheAge` through a getter |
| 8 | `lib/utils/memoryManager.js:11-12` | interval and threshold via `require("../../config")` in the constructor | `reconfigure()` for the interval; threshold through a getter |
| 9 | `lib/utils/autoResponderHandler.js:27,37-42` | `genAI` built once from `GEMINI_API_KEY` | reset on `change` of that key |
| 10 | `plugins/music.js:25` | `spotifyToken` outlives a credential change | reset on `change` |
| 11 | `plugins/reddit.js:37` | `tokenCache` likewise | reset on `change` |
| 12 | `plugins/{feedback,update,vv}.js:8/11/11` | `pino({ level: config.LOG_LEVEL })` | replaced by `createLogger` (section 12); `LOG_LEVEL` stays live through `logger.setLevel` |
| 13 | `lib/utils/autoResponderHandler.js:87-89,185`, `lib/utils/statusListStore.js:48-49,99` | env value only seeds a row or file | adapters (section 1); no code change beyond them |
| 14 | `index.js:5`, `lib/database/index.js:1` | `VERSION`, `DATABASE` destructured at require | constants, boot-only: no change |
| 15 | `config.js:206` | `PANEL_ENABLED` unread | removed; `ADMIN_PANEL` added; `config.env.example` drops `PANEL_ENABLED` and gains the 13 names it lacks; `bootstrap` warns once when `PANEL_ENABLED` is still in the environment (U18, section 15) |

`reconfigure()` is a new method on the three singletons: it clears the old timer and creates a new `unref()`'d one from the current `config` values. `BotRuntime.restartBot()` calls the three of them.

## 4. Bot texts (`LanguageManager` overrides)

### `LanguageManager` additions (`lib/utils/language.js`)

```js
languageManager.reload()                           // re-read config.LANG and the language file; keeps overrides
languageManager.setOverride(lang, key, text)       // sync, in memory -> { originalHash }; throws TextOverrideError
languageManager.clearOverride(lang, key)           // sync
languageManager.setOverrides(lang, mapOrObject)    // bulk replace (boot, restore); same validation, invalid entries skipped and logged
languageManager.getBase(lang, key)                 // text of lang/<lang>.json, parsed once and cached
languageManager.getEffective(lang, key)            // override if any, else base
languageManager.getOverride(lang, key)             // { text, originalHash } | undefined
languageManager.originalHash(lang, key)            // sha1(base text) as hex, first 16 characters
languageManager.isOriginalChanged(lang, key)       // stored originalHash !== current originalHash
languageManager.listKeys()                         // flat keys of lang/en.json (the override universe)
languageManager.capture(fn) -> { result, calls }   // records { key, result } of every getLang call made synchronously by fn
```

`getLang(key, ...args)` stays synchronous. Resolution: `overrides[currentLang][key]` -> `translations[key]` -> `overrides.en[key]` -> `en.json` (parsed once, not re-read on every miss: `getFallback` currently reads the file each time) -> the key itself. `{n}` placeholders are replaced after resolution. Property names `translations` and `currentLang` stay (`fakes.applyPendingI18n` mutates them).

`TextOverrideError.code`:

| Code | When |
| ---- | ---- |
| `unsupported_lang` | `lang` is not `en` or `fr` |
| `unknown_key` | key absent from `lang/en.json` |
| `empty` / `too_long` | blank, or more than 4000 characters |
| `placeholder_mismatch` | the multiset of `/\{\d+\}/g` differs from the base text of that language; `params.expected` lists the tokens (FR-059, same regex as `test/i18n.test.js:71`) |

### Persistence (`lib/utils/textOverrides.js`)

```js
textOverrides.load({ models })                     // async; reads text_overrides, calls languageManager.setOverrides per lang
textOverrides.save(lang, key, text, { actor })     // validate -> upsert row { key, lang, text, originalHash } -> memory
textOverrides.clear(lang, key, { actor })          // delete row -> memory
textOverrides.list({ q, command, lang }) -> rows   // { key, base: {en, fr}, override: {en, fr}, originalChanged, command }
textOverrides.exportRows() / importRows(rows)      // backup and restore
```

Boot order: `settingsStore.load()` -> `languageManager.reload()` -> `textOverrides.load()` -> `PluginLoader.loadAll()`. After a restore or an in-process restart the same three calls run again. There is no TTL: "next message" holds because the map is replaced directly. A stored text whose `originalHash` no longer matches stays in force and is flagged `originalChanged` (FR-060). `command` filtering maps a key's segment to a command by file name, alias or `descKey`.

### Lazy command descriptions (no plugin file changes)

1. `loader.loadPlugin` wraps `require(file)` in `languageManager.capture(...)`.
2. It passes the key whose captured `result` equals `plugin.command.desc` to `registry.registerPlugin(plugin, file, { descKey })` (null when the description is a literal).
3. The registry defines `entry.desc` as an **enumerable getter** returning `getLang(descKey)` when `descKey` is set, the stored string otherwise, and exposes `entry.descKey`.

`help`, `buttonmenu` and the panel read `entry.desc` at use time, so an override or a `BOT_LANG` change shows up at once. `test/registry.test.js:204-210` (string, translated, not a raw key) keeps passing.

## 5. Registry: command state, stats and the core bus

### Command state (`lib/utils/commandState.js`)

```js
commandState.isDisabled(entry, message) -> Promise<boolean>     // global wins; group scope only when message.isGroup
commandState.set(name, scope, disabled, { actor }) -> Promise<void>   // scope "*" or a normalized group JID; writes, then invalidates
commandState.snapshot() -> { global: string[], byGroup: { [jid]: string[] }, orphans: string[] }
```

- Rows are `command_states(command, scope)`; a row means disabled and re-enabling deletes it. `command` is `entry.name` (first alias after duplicate removal).
- One `settingsCache` key `command_state` holds `{ global: Set, byGroup: Map }` (one `findAll`, 5-minute TTL). Every setter calls `settingsCache.invalidate("command_state")`; restore and restart clear it.
- **Fail-open**: if `getOrLoad` returns `null` after a load error, nothing is disabled.
- `orphans` are rows whose command no longer exists (alias renamed); the panel lists them.

### Check position in `registry.executeCommand`

Inside the existing `try`, **after** the owner gate (`registry.js:270-273`) and **before** the `onlyGroup`/`onlyPm`/`adminOnly` checks:

```js
if (await commandState.isDisabled(entry, message)) {
  await safeReply(message, getLang("common.command_disabled"));
  return true;                                   // a command matched, even though it was refused
}
```

Why there: a non-owner still gets `common.owner_only` (so owner-only commands stay hidden, as `help` hides them), the owner is refused like everybody (spec edge case), and the network call `isSenderAdmin()` is skipped for disabled commands. Reply key: `common.command_disabled` (no placeholder; new in `en` and `fr`). A refused call is not counted in the stats. Sticker-bound commands reach the same `executeCommand` (pipeline step 7), so there is no bypass. Not covered, and documented in the panel: `onMessage` hooks (`afk`, `addfilter`, `notify`, `trackmessages`) keep running when their command is disabled; disabling `unban`/`banchat` warns that the panel is then the only way back.

### Error path and owner DM throttle (U7)

In the `catch` of `executeCommand`, in this order:

1. `MEDIA_TOO_LARGE`: unchanged reply; a user error, so counted in neither `cmd_ok` nor `cmd_fail`, no bus event.
2. `logger.error(...)` (unchanged), `stats.count("cmd_fail", entry.name)`, `bus.emitSafe("command:error", { name: entry.name, at })`.
3. `safeReply(message, getLang("common.error"))` (unchanged).
4. `if (cooldown.hit(entry.name, "ownerdm", 10 * 60 * 1000) === 0) await notifyOwners(...)`: at most one stack DM per command per 10 minutes (FR-064). Suppressed errors still reach the log, the stats and the bus, so the "errors in series" alert sees all of them.

Success path: after `entry.execute.call(...)` resolves, `stats.count("cmd_ok", entry.name)`.

### Stats (`lib/utils/stats.js`)

```js
stats.count(metric, subject = "", n = 1, now)    // sync, never throws, in-memory Map (bounded: 5000 keys then an early flush)
stats.flush({ now }) -> Promise<number>          // one multi-row upsert; skipped while maintenance mode is active
stats.start() / stats.stop()                      // 30 s unref'd flush timer; stop() flushes
stats.messagesByDay(days = 7) / topCommands(limit = 10, days = 7) / failingCommands(days = 7) / topGroups(limit, days)
```

Metrics: `messages`, `group_msgs` (subject = group JID), `cmd_ok`, `cmd_fail` (subject = command name). `day` is `YYYY-MM-DD` in `config.TIMEZONE` (invalid zone falls back to UTC like `scheduler.resolveZone`). Upsert: `INSERT ... ON CONFLICT (day, metric, subject) DO UPDATE SET count = daily_stats.count + excluded.count` (SQLite >= 3.24 and Postgres). "Most used commands" = `cmd_ok` per command and "failing commands" = `cmd_fail` per command, as in [data-model.md](../data-model.md) (so a command that always fails shows only in the failing list). A crash or an `index.js` SIGTERM loses at most 30 s of counters; the shared shutdown of section 15 flushes. Retention 90 days (`housekeeping`).

### Core bus (`lib/utils/events.js`)

An `EventEmitter` singleton plus `emitSafe(topic, payload)` (try/catch around listeners). Three topics only:

| Topic | Payload | Emitter | Subscriber |
| ----- | ------- | ------- | ---------- |
| `command:error` | `{ name, at }` | `registry.executeCommand` | `alerts` (error window) |
| `key:refused` | `{ service, at }` | `http.classifyError` | `alerts` (once per service per 24 h) |
| `groupguard:action` | `{ rule, groupJid, userJid, outcome }` | `plugins/groupguard.js` | admin audit (`admin.start()` subscribes; with the panel off the action is only logged) |

`http.js` also exports `isAuthFailure(err)` and `statusOf(err)` (extracted from the `:249` condition, behaviour unchanged) for the key tests, and `classifyError(err, { hasKey, userUrl, service })` gains the optional `service`: when set, `hasKey !== false`, and the error is an authentication failure, it emits `key:refused`. The nine plugins that pass `hasKey` (chatgpt, gemini, imagen, imagesearch, music, news, reddit, voice, weather) add `service: "openai"` etc.

### Touch points in the single pipeline file (`lib/core/pipeline.js`)

| Where | Change |
| ----- | ------ |
| top of `handleMessage` | `if (maintenanceMode.isActive()) return;` and `processMessage` brackets the work with `const done = maintenanceMode.begin(); try {...} finally { done(); }` |
| after the disabled-chat gate (step 3) | `if (!message.fromMe) { stats.count("messages"); if (message.isGroup) stats.count("group_msgs", message.jid); }` |
| `attachHandlers` | unchanged; `options` stays `{ onMessageProcessed, onError }` and is applied by the first call only (the `WeakSet` guard), so `bootstrap` passes the runtime's callbacks once |

Nothing else changes in the pipeline: new behaviour arrives as hooks (`knownchats` 5, `groupguard` 50) and registry checks. Update `test/hooks.test.js:476` to list `groupguard.js` between `notify.js` and `addfilter.js`.

## 6. `WhatsAppClient` lifecycle, `attachHandlers` and `BotRuntime`

### State

```js
client.getState() -> {
  status,            // idle | connecting | qr | open | reconnecting | stopped | logged_out
  since,             // ms timestamp of the last status change
  generation,        // socket generation currently allowed to act
  registered,        // creds.registered of the current auth state
  me,                // { number, name } | null   (number only, never a JID or LID)
  qrVersion, hasQr,  // the QR string itself is not part of the state
  pairing,           // null | { requestedAt, expiresAt }   (the phone number is never stored)
  lastClose,         // null | { at, code, loggedOut }
  reconnectAttempt
}
client.getPairingArtifacts() -> { qr: string | null, qrVersion }   // for authenticated admin routes only
```

Transitions:

| From | Trigger | To |
| ---- | ------- | -- |
| idle, stopped, logged_out, reconnecting | `initialize()` | connecting |
| connecting | `connection.update { qr }` | qr (`qrVersion++`) |
| connecting, qr | `connection.update { connection: "open" }` | open (`registered = true`, `me` from `sock.user`) |
| open, connecting, qr | `close` of the current generation, ordinary reason | reconnecting, then `initialize()` after 3 s |
| any | `close` with `restartRequired` (515, follows every successful pairing) | connecting at once, no delay (keeps SC-006 within 10 s) |
| any | `close` with `loggedOut` (401, unlinked from the phone) | logged_out (no reconnect; the panel offers "re-pair") |
| any | `stop()` | stopped |
| any | `resetSession()` | logged_out, then connecting once the folder is emptied |

### Events

Existing and unchanged: `ready`, `close(error)`, `messages`, `messages.update`, `groups.update`, `group-participants.update`. New: `qr(qrString, version)` and `state(stateCopy)` on every status, QR or pairing change. Listeners of `qr` must not log the payload (it is an account-takeover credential); the client registers each QR with the redactor as an ephemeral secret (TTL 5 minutes), and the terminal QR art stays but never enters the log ring.

### Generation token and single-flight

- `generation` is incremented by `initialize()`, `stop()`, `logout()` and `resetSession()`. Listeners of a socket capture the generation at creation and return at once when it is no longer current.
- Exception: `stop()`/`logout()`/`resetSession()` set `closingGeneration` to the generation they close before `sock.end()`. The `close` caused by that call is processed in "stopped" mode (emits `close`, no reconnect, `status = stopped`); `test/panel.test.js:251` keeps passing. Every other late event of an old socket is dropped, so it can never reset `isReady` of the new socket.
- `initialize()` is single-flight: concurrent calls share the pending promise. A `stop()` during socket creation closes that socket (existing behaviour, generation-checked).
- The reconnect timer checks the generation after the delay; a failing `initialize()` inside a reconnect is retried with backoff 3 s x 2^n capped at 60 s (reset on `open`), status `reconnecting`, instead of the unhandled rejection today.
- `saveCreds` writes (fire-and-forget at `client.js:183`) are tracked in a set so `resetSession()` can await them.

### Methods

```js
client.restart() -> Promise<socket|null>           // single-flight: await stop(); await initialize(); session kept, no QR
client.requestPairingCode(phone) -> Promise<{ code, expiresAt }>
client.logout()                                     // unchanged: unlinks on WhatsApp, never reconnects
client.resetSession() -> Promise<{ removed }>       // logout best effort, wipe sessions/<id> contents, then initialize()
```

`requestPairingCode(phone)`: digits only after stripping spaces and `+`, `^\d{8,15}$`. Errors (`ClientError.code`): `invalid_phone`, `not_connecting` (no socket, or status not `connecting`/`qr`; the call awaits `sock.waitForSocketOpen()` first), `already_registered` (the panel demands a confirmed logout first), `rate_limited` (one per 30 s, `params.retryAfterMs`), `pairing_failed`. Returns the 8 characters formatted `XXXX-XXXX` and `expiresAt = now + 3 min`. Logs only the last two digits. The call sets `creds.me` and persists it before pairing succeeds, so an abandoned attempt would poison the session: **a pending pairing triggers `resetSession()` when the connection closes for any reason other than 515 while `registered` is false, or when the 3-minute window ends without `open`.**

`resetSession()` guards: `path.resolve(sessionPath)` equals `<repo>/sessions/<id>` with `id` matching `/^[\w-]+$/`; `lstat` shows a real directory (no symlink); only the **contents** are removed (`sessions/` is a volume mount in Docker); no file is read; only the number of removed entries is logged. `sock.logout()` throws when the socket is down: catch, fall back to `sock.end()`.

Constraint kept: `.logout(` appears in `lib/baileys/client.js` only. `test/panel.test.js:356-366` greps `panel.js`, `index.js` and the body of `stop()`.

### What `attachHandlers` guarantees across socket swaps

1. Its listeners live on the client `EventEmitter`, not on a socket; they survive `restart()`, `resetSession()` and reconnects. The `WeakSet` makes a second call a no-op.
2. `messages` are emitted only by the current generation, `notify` batches only.
3. `ready` runs every `onReady` hook again after each (re)connection; hooks are idempotent by contract and read the socket with `client.getSocket()` at use time, never capturing it.
4. Between `stop()` and the next `open`, `getSocket()` is `null` or not ready: engines already skip (`client.ready()`), hooks that send must tolerate it.

### `BotRuntime` (`lib/core/botRuntime.js`)

```js
createBotRuntime({ client, mode, settingsStore, languageManager, textOverrides, settingsCache, reconfigure, clock }) -> runtime
runtime.state            // legacy botState object, same keys as today (status, startTime, isConnected, messagesProcessed, lastActivity, version, uptime, errors, client); panel.js re-exports this very object
runtime.handlerOptions   // { onMessageProcessed, onError } for attachHandlers
runtime.events           // EventEmitter: "state" (client state + restarting flag)
runtime.getStatus()      // { ...client.getState(), restarting, pendingRestart: string[], codeChanged: bool, uptimeMs, version, messagesProcessed, memory }
runtime.restartBot({ actor }) -> Promise<{ ok, code?: "busy" | "timeout" | "failed", status }>
runtime.shutdown(signal)
```

`restartBot()` is single-flight (`busy` -> HTTP 409). Sequence: legacy `state.status = "restarting"` (so `/health` answers 503 for a few seconds) -> `settingsCache.clear()` -> `settingsStore.reload()` -> `languageManager.reload()` and `textOverrides.load()` -> `reconfigure()` of the three singletons -> `client.restart()` -> wait for status in {`open`, `qr`, `logged_out`} (60 s, then `timeout`; the client keeps converging) -> `settingsStore.markInForce()`. The WhatsApp session is kept. The legacy `POST /api/restart` keeps its `process.exit(0)` after 1 s; the two paths are different on purpose.

## 7. `plugins/groupguard.js`

Hook-only plugin (no `command`), `hookPriority: { onMessage: 50 }`: after the observers role (10), trackmessages (20), afk (30), notify (40), before the consumer addfilter (90). It returns `true` (consumed) only when it deleted the message.

Order of checks, cheapest first; any miss returns `false`:

1. `message.isGroup && !message.fromMe`.
2. Group row through `getGroupSettings(jid)` (cache key `group:<jid>`, one cached lookup per group message). Stop when neither `antilink` nor `antibot` is set.
3. **Anti-link**: the message text matches `LINK_PATTERNS` (scheme URLs, `www.` hosts, `chat.whatsapp.com` and `wa.me` hosts; bare domains are not matched). **Anti-bot**: the message id is classified by `looksLikeBotId(id)` as `"bot"` (`BOT_ID_PATTERNS`: removal), `"suspect"` (`SUSPECT_ID_PATTERNS`: log only) or `null` (U16, table below).
4. `await message.isBotAdmin()`; without it, do nothing (the panel already warns, FR-032).
5. Exemptions: `message.isSudo()` (owners) and `await message.isSenderAdmin()` (group admins), nobody else (FR-031). The anti-link rule is strict (U17): a command that contains a link (`.dl https://...`) sent by a non-admin, non-owner is a violation like any other message. The hook runs at pipeline step 6 and returns `true` after deleting, so the command never reaches the registry; admins and owners keep running link commands.

Anti-link action:

| Step | Behaviour |
| ---- | --------- |
| Delete | `sock.sendMessage(jid, { delete: message.key })` |
| Warn | Reuses the `Warn` model, `WARN_LIMIT` and `WARN_MESSAGE` through helpers exported by `plugins/warnuser.js` (`identityForms`, row creation with the SQL increment, `fillPlaceholders`; no behaviour change there). The warning is sent as a plain message with a mention, not as a reply to the deleted message. A VIP (`role.isVip`, "can't be warned") gets the message deleted but no warning and no removal. |
| Remove | At the limit: `guardTarget` then `groupParticipantsUpdate(..., "remove")` checked with `assertParticipantResult`; on success send `ANTILINK_MSG` (placeholder `&mention`) and clear the warnings; on failure keep the warnings and say so, as `warnuser` does. |

Anti-bot action (R3/R4, U16): only a `"bot"` classification removes the sender, with `ANTIBOT_MSG`, through the same `guardTarget` and `assertParticipantResult` pair. A `"suspect"` classification removes and deletes nothing: it writes one `logger.warn` line and emits the bus event with `outcome: "suspect"`, at most once per sender per group per day (`cooldown.hit(userJid, "antibot-suspect:" + groupJid, 86400000) === 0`; in memory, so a restart may repeat one line). Every removal and every suspect writes an audit entry (`guard.antibot.remove`, `guard.antibot.suspect`) carrying the matched rule, through a small callback so the plugin does not import `lib/admin`: `require("../lib/utils/events").emitSafe("groupguard:action", { rule, groupJid, userJid, outcome })`, with `outcome` `"removed"` or `"suspect"` for anti-bot, persisted by the admin audit subscriber when the panel is enabled, logged otherwise.

**Mute** has no hook. The group service of the panel calls `sock.groupSettingUpdate(jid, "announcement" | "not_announcement")`, requires the bot to be admin, writes `Group.mute` (a mirror of the last state the bot set, U4) and calls `invalidateGroupSettings(jid)`.

Exports for tests: `containsLink(text)`, `looksLikeBotId(id) -> "bot" | "suspect" | null`, `LINK_PATTERNS`, `BOT_ID_PATTERNS`, `SUSPECT_ID_PATTERNS`. Contract tests: a link from a member is deleted and warned, also when it is inside a command, which then does not run (U17); admins and owners are untouched, commands with links included; a `bot` id is removed and a `suspect` id is only logged (once per day per sender and group); no action when the bot is not admin; removal at `WARN_LIMIT`; ordinary phone-client ids and the near-miss fixtures never match anti-bot; the message of a non-guarded group is untouched; the hook costs no database query beyond the cached group lookup.

**Anti-bot id shapes (U16).** In Baileys 7.0.0-rc14 every normal send uses `generateMessageIDV2`, which yields `3EB0` followed by 18 uppercase hex characters (22 characters in all, `node_modules/baileys/lib/Utils/generics.js:134-148`); its source says it is "inspired from whatsmeow", and WhatsApp Web probably produces the same shape, so a human on WhatsApp Web must never be removed on it. Classification of `message.key.id`, anchored and case-sensitive:

| Class | Pattern | Length | Action |
| ----- | ------- | ------ | ------ |
| `bot` | `^3EB0[0-9A-F]{36}$` (Baileys `generateMessageID`, present in rc14) | 40 | removal |
| `bot` | `^BAE5[0-9A-F]{12}$` (older Baileys scheme, recalled from Baileys 6) | 16 | removal |
| `suspect` | `^3EB0[0-9A-F]{18}$` (`generateMessageIDV2`) | 22 | log + audit, no removal |
| none | anything else | | nothing |

Fixtures in `test/groupguard.test.js` pin every class, plus near misses that must classify as none (`3EB0` with 17, 19, 35 or 37 hex characters, `BAE5` with 11 or 13, lower-case hex, a trailing character) and ordinary phone-client ids. The `BAE5` shape is recalled from Baileys 6: confirm it against that version's source when the fixture is written. Real `key.id` captures from Android, iPhone and WhatsApp Web (manual checklist of the quickstart) join the fixtures when available; a capture that matches a `bot` pattern removes that pattern from the class, it is never narrowed by a heuristic.

## 8. `plugins/knownchats.js`

Hook-only observer, `hookPriority: { onMessage: 5 }`, never consumes. Table `known_chats`; data helpers in `lib/utils/knownChats.js`.

| Hook | Behaviour |
| ---- | --------- |
| `onMessage(message)` | Records a private chat the first time it writes: `!message.isGroup && !message.fromMe`, JID ending `@s.whatsapp.net` or `@lid`, never `status@broadcast` or newsletters. Stores `pnJid` (`message.sender`) and `name` (`pushName`). Refreshes `lastSeenAt` at most once per hour per JID (in-memory `Map`; the write is fire-and-forget `bulkCreate(..., { updateOnDuplicate })`). Chats where the bot is disabled never reach it (the pipeline gate runs first). |
| `onReady(client)` | Seeds an empty table from `Conversation.jid`, `User.jid` and every `groupJid` found in `Group`, `Filter`, `GroupRole`, `UserStats`, `Warn`, `GroupEconomy`, `Idea`, `Quote`. Then `groupFetchAllParticipating()` (at most every 6 h, plus the panel's refresh button with a 60 s cache) upserts group names, sets `leftAt` for absent groups and clears it when the bot is back. |
| `onGroupParticipants(update)` | When the bot itself is removed, sets `leftAt` (feeds "ancien groupe", US6.5). |

`knownChats.listDestinations({ q, kind })` returns what the broadcaster accepts (private rows not in `BannedChat`, group rows with `leftAt IS NULL`, de-duplicated by `pnJid || jid`); `assertDestinations(jids)` throws `invalid_destination` for anything else (FR-046).

## 9. Broadcaster and recurrence

`lib/utils/broadcaster.js` is a sibling of `lib/utils/scheduler.js`, which stays untouched together with its tests. Same shape (one `unref`'d loop, `start(client)` idempotent, `tick(now)` test hook, `clientIsDown()` skip, compare-and-swap claims). It is started by `bootstrap`, so it runs with the panel disabled.

```js
broadcaster.start(client) / stop() / isRunning()
broadcaster.tick(now?) -> { materialized, claimed, sent, failed, expired, skipped }
broadcaster.createOnce(input, { now }) -> { broadcastId, runId }
broadcaster.createRecurring(input, { now }) -> { broadcastId, nextRunAt }
broadcaster.updateRecurring(id, patch, { now }) / pause(id) / resume(id, { now }) / remove(id)
broadcaster.cancelRun(runId)                                  // there is no retry API: no function moves a target out of a final state (U14)
broadcaster.report(runId) / list({ status }) / subscribe(fn)  // fn({ type, runId, ... }) feeds the "job" SSE topic; report targets carry `mayHaveBeenDelivered`
broadcaster.sweepMedia({ now }) / purgeFinishedMedia({ now }) // media retention (U15), see "Media retention" below
broadcaster.LIMITS   // { MAX_TARGETS: 200, MIN_SPACING_MS: 2000, LATE_MS: 3600000, STALE_RUN_MS: 86400000, TEXT: 4096, CAPTION: 1024 }
```

`input = { title?, text, media?: { path, name, mime, size } | reuseMediaOf?: broadcastId, targets: [jid], spacingMs?, runAt? | rule }`. `reuseMediaOf` serves the pre-filled "new broadcast to the failed destinations" of U14: the stored media of that broadcast is copied into the new broadcast's own directory (mutually exclusive with `media`). Errors (`BroadcastError.code`): `invalid_destination`, `too_many_targets`, `empty_text`, `text_too_long`, `media_type`, `media_too_large` (against live `config.MAX_UPLOAD`), `media_unavailable` (`reuseMediaOf` names a broadcast with no stored media, none or already deleted), `invalid_rule`, `not_found`, `busy`. Media is moved from the upload staging area into `data/broadcast-media/<broadcastId>/` with a sanitized name, the path checked to stay inside, the type sniffed with `file-type` (image or document only).

### Delivery contract (at most once per target, SC-012)

One send per tick, global FIFO by `run.dueAt` then `position`. Every transition is a conditional `UPDATE ... WHERE status = <from>`; a lost race changes 0 rows and is ignored. Creation (definition, run, up to 200 targets, `targetsReady = true` last) runs inside the in-process mutex plus a transaction.

1. **Gate.** Runs `scheduled` with nothing started and `now - dueAt > 1 h` become `expired` (`note = late`), targets `cancelled`. Runs `running` for more than 24 h are closed (`note = stale`), remaining targets `cancelled`. Targets in `sending` with `leaseUntil < now` become `failed` / `errorCode = interrupted` and are **never retried automatically** (the message may have gone out).
2. **Pick.** First run with `status in (scheduled, running)`, `targetsReady`, `dueAt <= now`; then its first `pending` target by `position`.
3. **Pace.** Eligible only if `now - lastSendAt >= max(2000, spacingMs) * (1 + jitter)`, `jitter` in `[0, 0.2]` drawn once per send (it only lengthens the gap, so the 2 s floor of FR-048 holds). `lastSendAt` starts as `max(sentAt)` read once, kept in memory (a restart cannot burst), global across runs. New broadcasts default `spacingMs` to `config.BROADCAST_DELAY_MS` (5000).
4. **Claim.** `UPDATE broadcast_targets SET status = 'sending', attempts = attempts + 1, leaseUntil = now + 60 s WHERE id = ? AND status = 'pending'`; only the caller seeing 1 affected row sends. Cancellation sets `pending` targets to `cancelled`, so it wins before any later claim; the one in-flight message completes and is reported `sent`.
5. **Send.** `client.getSocket()` read at send time and `clientIsDown()` re-checked right before the claim; `{ text }`, `{ image: { url: path }, caption }` or `{ document: { url: path }, mimetype, fileName, caption }` under `withTimeout(30 s)`. A broadcast with `mediaKind` set whose file is missing settles the target `failed` / `error` and never falls back to a text-only send.
6. **Settle.** `sent` (`sentAt`, `messageId`) or `failed` with `errorCode` in `forbidden | not_found | timeout | connection_closed | error`. `timeout` and `connection_closed` are flagged "may have been delivered". Raw error text only goes through `safeLog`.
7. **Complete.** No `pending`/`sending` left: run `completed` (or `failed` with 0 sent), `finishedAt`.
8. **Disconnection.** `tick` returns at once while the client is not ready; a started run resumes paced after reconnection (only the 24 h safety applies).

```text
BroadcastTarget  pending -> sending -> sent | failed(errorCode) | failed(interrupted)
                 pending -> cancelled (cancel, expired run, stale run)        sent | failed | cancelled are final (no retry, U14)
BroadcastRun     scheduled -> running -> completed | failed
                 scheduled -> expired (late)    scheduled|running -> cancelled    running -> cancelled (stale)
Broadcast        active <-> paused   (recurring only)
```

The displayed state (programmee, en cours, en pause, terminee, annulee, expiree) is derived: latest run status, plus "en pause" when `Broadcast.status = 'paused'` or when the client is down while a run is open.

**No retry (U14).** A failed or interrupted target is never re-sent by the engine or by an API: `interrupted` may already have been delivered. The owner serves failed destinations again with a new broadcast, pre-filled by the UI from `report(runId)` and created through `createOnce` like any other (cap of 200 targets, `confirmTargets`, `KnownChat` validation, media through `reuseMediaOf`). That broadcast has its own run and targets, so the at-most-once indexes are unaffected.

### Media retention (U15)

`sweepMedia({ now })` is called by the daily `housekeeping` job (data-model 1.15) and `purgeFinishedMedia({ now })` by the Storage page (section 14). Both serialize with creation through `mutex("broadcasts")` and are no-ops on a broadcast whose `mediaPath` is already NULL.

| Broadcast | `sweepMedia` | `purgeFinishedMedia` |
| --------- | ------------ | -------------------- |
| `once`, run final (`completed`, `failed`, `cancelled`, `expired`) | deletes the media 7 days after the run's `finishedAt` | deletes the media at once |
| `once`, run `scheduled` or `running` | keeps it | keeps it, counted in `skipped` |
| `recurring` | keeps it (deleted only with the broadcast, `remove`) | keeps it, counted in `skipped` |

Deleting means: remove `data/broadcast-media/<id>/` (path checked with `safeFs.assertInside`), then set `Broadcast.mediaPath = NULL` (`mediaKind`, `mediaName`, `mediaMime`, `mediaSize` stay for the history); a crash between the two steps is repaired by the next sweep (data-model 1.15). `purgeFinishedMedia` never refuses: it returns `{ freedBytes, removed, skipped }`, so a scheduled or recurring broadcast can never lose its media and the Storage page needs no extra error code. The sweep also clears `mediaPath` when the file is gone and no run is open (a final broadcast restored from a backup).

### Recurrence (`lib/utils/recurrence.js`, pure: no clock, no database)

```js
recurrence.validateRule(rule) -> { ok } | { ok: false, code }     // codes: bad_kind, bad_days, bad_day, bad_time
recurrence.nextOccurrence(rule, afterMs, zone) -> ms               // first occurrence strictly after afterMs
recurrence.describe(rule, lang)
```

Rule: `{ kind: "daily" }`, `{ kind: "weekly", days: [1..7] }` (ISO, Monday = 1) or `{ kind: "monthly", day: 1..31 }`, plus `time: "HH:mm"`. `zone` is `config.TIMEZONE` validated with luxon (`Info.isValidIANAZone`), falling back to `UTC`. The algorithm walks local calendar days (at most 400 steps) and builds the instant with luxon, so one local day yields at most one instant: a time inside a spring-forward gap resolves forward and still fires once that day, a fall-back overlap picks one instant. **A monthly day absent from the month fires on the last day of that month** (U12: the 31st gives 02-28, 03-31, 04-30...).

Materialization, in `tick` before delivery: for each `recurring`, `active` broadcast with `nextRunAt <= now`, loop (at most 50 iterations) on `d = nextRunAt`. An occurrence late by more than 1 h becomes a `BroadcastRun` with `status = expired`, `note = late` and no targets (the "noted in the history" of FR-050); otherwise it is materialized (`scheduled`, targets `pending`). Each iteration first advances the schedule with `UPDATE broadcasts SET nextRunAt = :next, lastRunAt = :d WHERE id = ? AND nextRunAt = :d`, then inserts the run and its targets in one transaction behind the mutex. The unique index `(broadcastId, dueAt)` is the second guard, so an occurrence can never exist twice. After 50 iterations (bot down for weeks) `nextRunAt` jumps to `nextOccurrence(rule, now)`. Pause = `status = paused`; resume, a rule edit and a `TIMEZONE` change recompute `nextRunAt` from `now` (no catch-up burst). Delete removes definition, runs, targets and media in one transaction.

## 10. Alerts

`lib/utils/alerts.js`; started by `bootstrap` (`alerts.start(client)`), so it works with the panel disabled. It subscribes itself to the client's `close` and `ready` events and to the bus; the pipeline is not involved.

```js
alerts.start(client) / stop()
alerts.raise(type, payload, { now }) -> Promise<{ queued: boolean, reason?: "disabled" | "no_recipient" | "rate_limited" }>
alerts.flush(client)                 // sends pending outbox rows; on ready and every 30 s while connected
alerts.getStatus() -> { enabled: { [type]: bool }, recipients: number, lastSent: { [type]: iso }, pending: number }
```

| Type | Setting | Trigger | Rate-limit key (persisted CAS on `alert_states`) |
| ---- | ------- | ------- | ----------------------------------------------- |
| `reconnected` | `ALERT_RECONNECT` | `ready` when `now - conn_heartbeat > 300 000 ms`; payload `{ downMs }`. A 60 s heartbeat while connected plus the `close` timestamp survive a crash or a PM2 restart. No row yet (first boot) raises nothing. | `reconnected`, 10 min |
| `errors_series` | `ALERT_ERROR_BURST` | bus `command:error`: in-memory window of the last 10 minutes; at 10 entries it raises with the top commands (names and counts) and clears the window whether or not the limiter let it through | `errors_series`, 1 h |
| `key_refused` | `ALERT_KEY_REFUSED` | bus `key:refused { service }` | `key_refused:<service>`, 24 h |
| `login_blocked` | `ALERT_LOGIN_BLOCKED` | called by the auth module when an origin is blocked | `login_blocked:<origin>`, 15 min |
| `new_origin` | `ALERT_NEW_ORIGIN` | called by the auth module after a successful login from an origin with no earlier `login.success` row | none (the origin becomes seen) |
| `update_available` | `ALERT_UPDATE` | called by the updater checker | `update_available`, `value = last notified version`, CAS `WHERE value IS NULL OR value <> :v` |

`raise` order: (1) the type's toggle; (2) `getOwnerJids().length > 0` (else drop **without** consuming a limit; the panel shows "no recipient", US13 AS5); (3) the limiter CAS (`UPDATE alert_states SET lastSentAt = :now, count = count + 1 WHERE key = :k AND (lastSentAt IS NULL OR lastSentAt <= :now_minus_window)`; one changed row means allowed); (4) insert into `alert_outbox`; (5) `flush()` at once when `client.ready()`. The limit is consumed at creation, so an alert queued during a disconnection is neither duplicated nor lost (FR-063).

`flush` renders each text at send time with `getLang("alerts.<type>", ...)`, sends to each owner under `withTimeout`, marks `sent` when at least one owner received it, retries up to 3 attempts, and turns `pending` rows older than 24 h into `expired`. Payloads carry service names, versions, durations, origins and times only: never a key, a stack or a JID of a third party. All toggles default to true (U12).

## 11. Updater, `runtime` and `ytdlpUpdate`

### `lib/utils/runtime.js` (pure: `fs` and `process.env` only)

```js
runtime.isContainer()            // /.dockerenv, /proc/1/cgroup matching docker|kubepods|containerd, or env container
runtime.hasHostPort()            // process.env.PORT is set (a panel host allocates the port)
runtime.isPanelHost()            // env P_SERVER_UUID or SERVER_MEMORY (Pterodactyl-style hosts)
runtime.detectSupervisor() -> { kind: "env" | "pm2" | "panel-host" | "container" | "systemd" | "none", supervised: bool }
runtime.resolveBind({ env }) -> { host, port, hostSource, portSource }
```

- **Bind (U1)**: `PANEL_HOST` (or `HOST`) always wins (`hostSource = "explicit"`); otherwise `0.0.0.0` when `isContainer()` or `hasHostPort()` (`auto-container` / `auto-panel-host`), else `127.0.0.1` (`auto-local`). The port stays `PANEL_PORT || PORT || 3000`. No automatic port drift (A6): a busy port disables the panel with a clear message.
- **Supervisor** first match: `SUPERVISED=true|false` (explicit) -> PM2 (`pm_id` defined; supervised) -> panel host (supervised, assumed) -> container (not supervised: depends on the restart policy) -> systemd (`INVOCATION_ID`; not supervised unless `SUPERVISED=true`) -> none.

### `lib/utils/updater.js`

```js
createUpdater({ git, run, env, fs, clock, rootDir }) / default singleton
updater.getInstallInfo() -> { type: "git" | "image" | "archive", canSelfUpdate, blockers: string[], branch, supervised }
updater.check({ force }) -> { behind, ahead, localVersion, remoteVersion, commits: [{ hash, subject }], checkedAt, blockers }
updater.apply({ onProgress, actor }) -> { ok, from, to, phase, reason, rolledBack }
updater.restartRequired() -> { required: bool, reason }
updater.startChecker(client) / stop()
```

- `rootDir` is `path.resolve(__dirname, "..", "..")`, never `process.cwd()`. `git` type = `.git` present, `git rev-parse --show-toplevel` equals `rootDir`, `git --version` works; otherwise `image` (container marker) or `archive`. Those two get instructions only (FR-054).
- Blocker codes: `no_git_binary`, `dubious_ownership`, `detached`, `no_remote_branch` (distinct from a network failure: this very branch has no upstream), `dirty_tree` (tracked changes only), `not_writable`. Failure `reason` adds `diverged`, `install_failed`, `smoke_failed`, `busy`, `network`.
- Branch rule: the upstream `@{u}` of the checked-out branch, else `origin/<current branch>`; never `config.BRANCH`, never a branch switch.
- **Apply** under one process-wide lock shared with `plugins/update.js`, recording `prevHead`: (a) `git merge --ff-only FETCH_HEAD`; (b) if `package.json`, `yarn.lock`, `.yarnrc.yml` or `.yarn/releases/*` changed, `process.execPath <yarnPath> install --immutable` (5 min; `yarnPath` read from `.yarnrc.yml` after the merge); (c) smoke boot in a child (`process.execPath tools/verify-boot.js`, `DATABASE_URL=:memory:`, `LOG_LEVEL=silent`, 60 s) that loads `config`, `lib/database` and every plugin and asserts at least one command; (d) any failure in (a)-(c): `git reset --hard prevHead`, repeat (b) if it ran, return `{ ok: false, phase, reason, rolledBack: true }`; raw stderr goes to the logs only (`logSafe`). Progress phases: `fetch | merge | install | verify | done | failed`.
- `restartRequired()` is derived (boot HEAD differs from the current `HEAD`, or the `package.json` version on disk differs from `config.VERSION`), so it also catches a manual `git pull`.
- **After success**: supervised -> the caller answers first, then `process.exit(0)` about 1 s later (the `/api/restart` convention); unsupervised (U6) -> no exit, the panel shows "restart the program to finish" until the process restarts; the confirmation text differs but no extra field is needed. The in-process restart reloads settings, not code, so it is never used for this.
- **Checker**: first run 2 minutes after the first `ready`, then every 6 h with jitter, `unref()`'d, disabled by `UPDATE_CHECK=false`. Git installs use `check()`; others read `package.json` from the repository's `master` on GitHub once. It calls `alerts.raise("update_available", { version })` once per remote version greater than the local one; a commit without a version bump only shows a badge.

`plugins/update.js` becomes a thin client of the updater (same `plugins.update.*` replies plus new `no_remote_branch` and `rolled_back` keys, same lock; keeps `pm2 restart` as the fast path when `pm_id` is set).

### `lib/utils/ytdlpUpdate.js`

```js
ytdlpUpdate.inspect() -> { selfUpdatable: "likely" | "no" | "missing", reason?: "read_only" | "package_managed", version }
ytdlpUpdate.update({ onProgress }) -> { outcome, before, after }   // outcome: updated | up_to_date | managed_externally | read_only | unreachable | failed | busy | missing
downloader.getActiveDownloads() / downloader.setMaintenance(bool)  // new; download() throws YTDLP_BUSY while set
```

`update` runs `execFile(config.YTDLP_PATH, ["-U"], { timeout: 60 s })`. The verdict comes from the version before and after (`downloader.resetCache()` then `getVersion()`), not from stdout; stderr is matched only to classify (`/package manager|manual build|unofficial build/i` -> `managed_externally`, `/permission|Unable to write/i` -> `read_only`, network codes -> `unreachable`) and goes to the logs only. Refused (`busy`) while a download runs; new downloads wait for the end of the update. `YTDLP_PATH` is read-only in the panel (U11).

## 12. Logger, redactor and ring

`lib/utils/logger.js` replaces the 20 `pino(` calls in 19 files (`index.js`, `panel.js`, the 17 module loggers listed in research B8). Both Baileys loggers in `lib/baileys/client.js:93,98` stay as they are: at debug they carry payloads.

```js
logger.createLogger(name) -> pino child       // level from config.LOG_LEVEL (silent in tests)
logger.setLevel(level)                         // LOG_LEVEL onChange: updates the root logger and every child created so far
logger.install()                               // consoleCapture; called first in index.js and panel.js
logger.printToConsole(line)                    // the ORIGINAL stdout write captured at module load (setup link, QR art)
```

- Root pino writes to one destination whose `write(line)` runs `redactor.scrub(line)`, then forwards to an in-process `pino-pretty` stream (same options as `index.js:9-18`; replaces the two worker-thread transports) or raw JSON when `LOG_FORMAT=json`, and to `ring.pushFromPinoLine(line)`.
- `consoleCapture.install()` wraps `console.log/info/debug/warn/error`: format, scrub, push to the ring with the matching level and `name: "console"`, then call the original. Lines that are QR art (`/[▀▄█]{8,}/`) or contain `QR available` are never pushed.

### `redactor` (`lib/admin/logs/redactor.js`, leaf)

```js
redactor.register(name, value)                 // replaces the previous value of that name
redactor.registerEphemeral(name, value, ttlMs) // QR string (5 min), setup/reset token
redactor.unregister(name)
redactor.scrub(text) -> text                   // [redacted]
```

Value-based: each value is registered with its variants (raw, JSON-escaped, URL-encoded, base64, base64url), compiled lazily into one escaped alternation sorted by length. Values shorter than 6 characters are ignored (secret settings require 8 or more). Sources: every `secret: true` setting whatever its tier (registered by the store), `SESSION_ID`, `PANEL_TOKEN`, `DATABASE_URL` (whole and password part), setup and reset tokens, the current QR string, the deployment keys. Defence in depth stays: the key-shape pass `redact()` in `http.js:293-299` and pino `redact.paths` (`*.apiKey`, `*.token`, `*.password`, `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]`).

### `ring` (`lib/admin/logs/ring.js`, leaf)

```js
ring.push(entry) / ring.pushFromPinoLine(line)
ring.list({ level, q, since, limit }) -> [{ seq, ts, level, name, msg }]
ring.subscribe(fn) -> unsubscribe
ring.lastErrors(n = 10)
```

Circular array of 1000 entries; `msg` capped at 2000 characters and 12 stack lines; other structured fields are dropped from the panel view. The ring is always on (about 0.4 MB typical, 2 MB worst), so the dashboard works the same whether or not the panel is enabled. `Last-Event-ID` replay is served from `seq`.

Enforced by `test/admin-logging.test.js`: no `pino(` outside `lib/utils/logger.js` (allowlist: the two Baileys calls); no `console.` in `lib/admin/**`; request bodies, headers and query strings are never logged; validation errors never echo a submitted secret.

## 13. Backup and maintenance mode

### `lib/utils/maintenanceMode.js` (core, read by the pipeline)

```js
maintenanceMode.enter(reason) -> Promise<void>   // sets the flag, then waits up to 10 s for in-flight work
maintenanceMode.leave()
maintenanceMode.isActive() -> boolean
maintenanceMode.begin() -> done()                // the pipeline brackets each message with it
```

While active: the pipeline returns early, `stats.flush` and `broadcaster.tick` skip, `settingsStore.set` is refused with `busy`.

### Backup service (`lib/admin/backup/{format,export,restore}.js`, facade `lib/admin/services/backup.js`)

```js
backup.exportStream({ passphrase, includeSession, now }) -> { stream: Readable, filename, counts }
backup.inspect({ uploadId, passphrase, adminSessionId }) -> { restoreToken, summary }    // nothing changes
backup.apply({ restoreToken, confirm: true, actor }) -> { ok: true, preRestoreFile }
```

`BackupError.code`: `passphrase_too_short` (under 12), `bad_passphrase`, `file_altered` (tag failure or truncation), `format_unsupported`, `newer_version` (backup `botVersion` above `config.VERSION`; plain numeric compare), `invalid_row` (`params`: model, index, field), `secret_storage_unavailable`, `busy`, `token_expired`, `apply_failed`.

File format (container version `format: 1`): `"OWBBACKUP\n"` + uint32 BE header length + plaintext header JSON `{ format, kdf: { name: "scrypt", N: 65536, r: 8, p: 2, salt }, cipher: "aes-256-gcm", iv, check }` + ciphertext + 16-byte GCM tag. The payload is `gzip(NDJSON)` encrypted with AES-256-GCM, AAD = header; the key is `scrypt(passphrase NFKC-normalized)` split by HKDF into an encryption key and a `check` value (wrong passphrase is detected before decrypting everything). Records, in order: `manifest` (format, `botVersion`, `createdAt`, dialect, `includesSession`, counts per model), `rows` batches of 500 per model ordered by primary key, `file` (whitelisted `data/status_save.json`), `blob` (1 MiB chunks of the media of non-final broadcasts), optional `session` (one record per file of `sessions/main/`, read as bytes, never parsed or logged).

Invariants:

- **Models**: export and restore use the fixed ordered list of [data-model.md](../data-model.md) (group data, bot features, panel configuration, jobs). **Never exported**: `AdminAccount`, `AdminSession`, `AdminToken`, `AuditLog`, `AlertState`, `AlertOutbox`, `Conversation`. Settings secrets travel decrypted inside the archive. The passphrase is never written to the audit log (counts and `includesSession` only).
- **Export** reads all tables in one read transaction through model instances and `row.get({ plain: true })` (never `raw: true`, whose SQLite types differ from Postgres). The session is included only when `includeSession` and the caller confirmed the takeover warning.
- **Restore step 1, `inspect`**: stream-decrypt to the end (tag verified), parse every record, build and `validate()` every row (length limits included, for Postgres targets), compare versions, dry-run `secretBox.encrypt`, tally counts. Returns a `restoreToken` (15 minutes, bound to the admin session, derived key kept in memory only). Older backups load: a model absent from the file is emptied, a missing column takes the model default, an unknown column is dropped and counted in the summary.
- **Restore step 2, `apply`**: `maintenanceMode.enter` -> write `data/backups/pre-restore-<ts>.owb` (same exporter, same passphrase; keep the last 3) and `data/backups/restore.lock` -> **one transaction**: per model in order `destroy({ where: {} })` then `bulkCreate(batch, { hooks: false })` (on Postgres, `setval` of every auto-increment sequence afterwards) -> the GCM tag is verified (`final()`) **before COMMIT**, so a tampered or truncated file rolls everything back -> session swap by rename after the commit -> `settingsCache.clear()`, `settingsStore.reload()`, `textOverrides.load()`, `commandState` invalidation -> `runtime.restartBot()` -> `maintenanceMode.leave()` -> audit `backup.restore`. A failure at any point keeps the previous state (FR-052); boot sweeps `data/tmp/` and, if `restore.lock` remains, logs "restore interrupted, previous state kept" and renames a half-swapped session directory back.
- **After a restore** the engines' normal rules apply (a `sending` target past its lease becomes `failed/interrupted`, a not-yet-started run beyond the 1 h gate expires, `sent` targets stay `sent`).
- Streaming throughout: memory stays flat whatever the size of `user_stats` or the session folder. Restoring the same file on two live installations can double-send queued broadcasts; the restore screen warns about it.

## 14. Storage and key tests

### `lib/utils/safeFs.js` (shared)

```js
safeFs.measure(dir, { maxEntries: 50000, maxDepth: 4, budgetMs: 2000 }) -> { bytes, files, truncated }   // opendir + lstat, never follows symlinks, setImmediate every 200 entries
safeFs.purgeChildren(dir, { olderThanMs, skip }) -> { freedBytes, removed, skipped }
safeFs.truncateFiles(dir, pattern) -> { freedBytes }
safeFs.assertInside(root, candidate)   // realpath must stay under realpath(root) + sep
```

Purge rules: the request carries only a category id and a confirmation, paths come from constants; only **children** of the target are deleted (never the target); each entry is `lstat`'d, a symlink is unlinked and never followed; `.gitkeep` is skipped; `sessions/`, `data/` (except the listed subfolders), the `media/` root and the database file are never touched; `data/broadcast-media/` is only ever handled through `broadcaster`.

### `lib/admin/services/storage.js`

```js
storage.list() -> [{ id, bytes, files, truncated, purgeable, protectedBytes?, note? }]   // cached 30 s per category; refresh limited to 1 per 5 s; `protectedBytes` only for broadcast_media
storage.purge(id, { confirm, actor }) -> { freedBytes, removed, skipped }   // one purge at a time per category
```

| `id` | Measured | Purge |
| ---- | -------- | ----- |
| `temp_media` | `media/temp` and `os.tmpdir()` entries `owb-*` / `voice-*` older than 15 min and owned by our uid | children of `media/temp` (skip entries modified in the last 60 s) and those tmp dirs |
| `broadcast_media` | `data/broadcast-media/` (every broadcast directory); `protectedBytes` = media of recurring broadcasts and of `once` broadcasts whose run is not final | `broadcaster.purgeFinishedMedia()` (U15): deletes only media that can never be sent again (final `once` broadcasts), clears their `mediaPath`, reports the rest in `skipped`; never a generic `purgeChildren`, so a scheduled or recurring broadcast keeps its media. The confirmation text states how many are kept |
| `antidelete_cache` | entry count and rough text size from `antiDeleteHandler.getCacheStats()` (new) | `antiDeleteHandler.clearCache()` (new); the confirmation warns that deleted messages of the last hour become unrecoverable |
| `panel_backups` | `data/backups/` | its files |
| `logs` | `logs/*.log` (PM2 only; Docker is 0) | **truncate**, not unlink (PM2 holds the descriptors) |
| `database` | SQLite file plus `-wal`/`-shm`/`-journal`, or `pg_database_size(current_database())` | none: `purge("database")` throws `not_purgeable` |

Also reported: free disk (`fs.statfs(rootDir)`). The categories are those of U5 plus broadcast media (U15); there is no anti-delete or view-once archive and no statuses folder (`STATUS_SAVE_FOLDER` has no consumer, U5).

### `lib/admin/services/keyTests.js`

```js
keyTests.services() -> [{ id, settings: [KEY...], testable: bool }]
keyTests.test(serviceId, { actor }) -> { verdict: "accepted" | "refused" | "unreachable", detail?: "quota", checkedAt }
```

No key in the request: the service reads `config[KEY]` at call time (panel value wins), sends one fixed read-only request through `fetchJson(url, { timeoutMs: 10000 })`, and answers only the verdict. Limit: `cooldown.hit("panel", "keytest:" + serviceId, 10000)`; a non-zero result throws `rate_limited` with `params.retryAfterMs` (HTTP 429, FR-022). Upstream bodies and messages are never forwarded or logged (`safeLog` only; OpenAI echoes a masked key in its 401).

| Service id | Settings | Request | Refused |
| ---------- | -------- | ------- | ------- |
| `openai` | `OPENAI_API_KEY` | `GET /v1/models`, Bearer | 401 |
| `gemini` | `GEMINI_API_KEY` | `GET /v1beta/models?pageSize=1`, header `x-goog-api-key` (key kept out of the URL) | 400, 403 |
| `weather` | `WEATHER_API_KEY` | `GET api.weatherapi.com/v1/current.json?key=K&q=Paris&aqi=no` | 401 (code 2006, 2008, 2009) |
| `news` | `NEWS_API_KEY` | `GET /v2/top-headlines/sources`, header `X-Api-Key` | 401 |
| `unsplash` | `UNSPLASH_API_KEY` | `GET /search/photos?query=test&per_page=1`, `Client-ID` | 401 |
| `giphy` | `GIPHY_API_KEY` | `GET /v1/gifs/trending?api_key=K&limit=1` | 401 |
| `spotify` | `SPOTIFY_CLIENT_ID` + `_SECRET` | client-credentials token request, Basic auth | 400, 401 |
| `reddit` | `REDDIT_CLIENT_ID` + `_SECRET` | token request with the plugin's `User-Agent` (constants exported from `plugins/reddit.js`) | 401, or 200 with an `error` field |
| `alphavantage` | `ALPHA_VANTAGE_KEY` | none | not testable: the endpoint accepts fake keys (`testable: false`, no button) |

Verdict mapping: 2xx with the expected body -> `accepted`; 400/401/403 on these fixed requests -> `refused`; 429 or a quota body -> `accepted` with `detail: "quota"` (the key was recognised); no response, DNS/TLS/timeout, 5xx, 408, an HTML page, or a non-JSON 403/429 from Reddit -> `unreachable`. Settings with no consumer (U8) get no test button.

## 15. `lib/admin` composition and boot

### `createAdmin(deps)` (`lib/admin/index.js`)

```js
const admin = createAdmin({
  config, models, settingsStore, secretBox, languageManager, textOverrides,
  runtime,                       // BotRuntime (section 6)
  client, registry, commandState, stats, broadcaster, alerts, updater, ytdlpUpdate,
  logger, ring, redactor, bus,
  clock,                         // { now(): ms }, default Date
  kdf,                           // scrypt cost overrides for tests
  rootDir, dataDir,              // default: repository root and <root>/data
});
admin.handle(req, res)   // -> boolean: false for any URL outside /admin (the caller falls through to the legacy handler);
                         //    true once it owns the response, including 404/405 under /admin
admin.routes()           // -> [{ method, path, auth, csrf, mutates, touch }] for tests
admin.hub                // topic hub (below)
admin.start()            // async, called after sync() + settings load: janitors, setup token and console link, SSE ticker armed lazily
admin.stop()             // clears timers, closes SSE streams
```

`createAdmin` does no I/O and starts no timer. DB-backed routes answer `503 { error: "starting" }` until `runtime.dbReady` is true.

### Router (`lib/admin/http/router.js`)

```js
router.route({
  method,                        // GET | POST | PUT | PATCH | DELETE
  path,                          // "/admin/api/groups/:jid"; exact segment match, :param decoded once (400 when malformed), no regex
  auth,                          // "session" | "public"; REQUIRED, registering without it throws at boot (deny by default)
  csrf,                          // true (default for unsafe methods) | "origin" (public POST such as login/setup: no session token yet, Origin/Sec-Fetch-Site/content-type checks still apply) | false (GET only, enforced at registration)
  mutates,                       // default method !== "GET"; a test fails if any GET route declares it
  touch,                         // default true; false for SSE heartbeats and 2 s polling so a forgotten tab still expires
  bodyLimit,                     // bytes; default 0 = any body rejected; JSON routes up to 1 MiB
  upload,                        // { purpose: "backup" | "broadcast", maxBytes } for the raw octet-stream route
  handler: async (ctx) => result
});
```

`ctx = { req, res, params, query, body, session, origin, now, audit(action, target, result, detail), publish(topic, payload), signal }`. `body` is a fresh object built by the route's validation, never a merge of parsed input. A handler returns a plain object (200 JSON), `{ status, body, headers }`, or takes over `ctx.res` for SSE, a QR image and a backup download. Exceptions: typed errors map by `code` (envelope in [admin-http-api.md](admin-http-api.md)); anything else gives `500 { error: "internal_error", requestId }` with the stack sent to the logger through `safeLog`, never to the client. `router.routes()` is what `test/admin-security.test.js` enumerates for SC-005.

### Audit and hub

```js
audit.record({ action, target, origin, result = "ok", detail }, { transaction })
```

(`lib/admin/audit.js`.) `detail` passes through `redactor.scrub`; for settings it is built only by `auditDiff(def, before, after)`: `{ from, to }` for a non-secret, `{ secret: true, op: "set" | "clear" }` for a secret. Without `transaction`, a failed write is logged and swallowed; with `transaction` it rejects, so an economy adjustment and its audit row commit or fail together. `origin` is the throttling origin of the request, `"cli"` for `tools/admin-reset.js`, `"system"` for boot. `ctx.audit` is `audit.record` with the request's origin filled in.

```js
hub.publish(topic, payload) / hub.subscribe(topic, fn) -> unsubscribe / hub.subscriberCount(topic)
```

Topics `state`, `pairing`, `log`, `job`, `session`. Sources: `runtime.events` and `client` events (`state`, `pairing`), `ring.subscribe` (`log`), `broadcaster.subscribe` and the `onProgress` callbacks of `updater.apply`, `ytdlpUpdate.update`, `backup.apply` (`job`). The 2 s state ticker exists only while at least one SSE client is subscribed; `state` is coalesced to at most one per second except when forced by `ready`, `close` or `qr`.

### Starting it: `bootstrap({ mode })` (`lib/core/boot.js`)

`index.js` and `panel.js` become thin wrappers; both call the same function (`mode` is `"normal"` or `"panel"`).

| # | Step | Failure |
| - | ---- | ------- |
| 1 | `logger.install()` (first line of the entry file); global `uncaughtException` / `unhandledRejection` handlers; if `PANEL_ENABLED` is present in `process.env` (U18; `config.env` values count, dotenv has loaded them), exactly one `console.warn(getLang("admin.panel_enabled_ignored"))` line saying the variable is no longer read and that `ADMIN_PANEL=false` disables the panel. Nothing else changes: the variable is never consulted | - |
| 2 | `memoryManager.performCleanup()` | - |
| 3 | `client = new WhatsAppClient()` and `runtime = createBotRuntime(...)` (cheap, no I/O); install `SIGTERM`/`SIGINT` -> `runtime.shutdown(signal)` | - |
| 4 | If `config.ADMIN_PANEL`: `createAdmin(...)` and `startAdminServer({ admin, runtime })` **before the database**, as `panel.js` listens first today, so hosts see the port during boot | `EADDRINUSE`, `EACCES`, `EADDRNOTAVAIL`: log an error naming `PANEL_PORT`, `PANEL_HOST` and `ADMIN_PANEL=false`, continue without a panel. Never fatal (FR-040). |
| 5 | `DATABASE.authenticate({ retry: { max: 3 } })` -> `sync()` -> `runtime.dbReady = true` | fatal: `process.exit(1)` in both modes |
| 6 | `settingsStore.load()` -> `languageManager.reload()` -> `textOverrides.load()` -> `settingsStore.markInForce()` | - |
| 7 | `PluginLoader.loadAll()` | per-plugin failures as today |
| 8 | `attachHandlers(client, runtime.handlerOptions)` (before `initialize()`, as the pipeline contract requires) | - |
| 9 | Engines: `stats.start()`, `housekeeping.start()`, `broadcaster.start(client)`, `alerts.start(client)`, `updater.startChecker(client)`; then `admin.start()` (prints the setup link when no account exists) | - |
| 10 | `client.initialize()` | as today |

`runtime.shutdown`: status `shutting_down`, close the HTTP server with `closeAllConnections()` (SSE sockets would otherwise block it), `stats.flush()`, `conversationManager.flush()` (its own once-listener sees another listener and stops exiting), `client.stop()` (**never** a logout), `DATABASE.close()`, `process.exit(0)` after 2 s. This is `panel.js`'s existing shutdown, now shared; `index.js` gains it (under Docker, `node` is PID 1 and today waits for SIGKILL). The keep-alive timer moves to `bootstrap`, `unref()`'d.

`startAdminServer({ admin, runtime })` (`lib/admin/server.js`) resolves `runtime.resolveBind()` (U1), creates `createPanelServer(...)`, registers `server.once("error")` before `listen`, sets `headersTimeout` 15 s, `maxHeadersCount` 50, `maxConnections` 256, and resolves `{ server, url }` or `null`. The console line names the URL (`PANEL_PUBLIC_URL` if set, else `http://localhost:<port>`) or the reason the panel is off.

### Legacy endpoints and `test/panel.test.js`

- `lib/admin/monitoring.js` holds the current public routes moved verbatim: `/`, `/health`, `/healthz`, `/status`, `/ping`, `/metrics`, `/api/info`, `POST /api/restart`, `OPTIONS`, and the status page for any unknown path. CORS `*` stays on the read-only GETs only (it is dropped from `/api/restart`, which is bearer-protected; no test asserts it). `/admin/**` sends no `Access-Control-*` header and answers `OPTIONS` with 405.
- `createPanelServer({ botState, admin })` returns `http.Server` with `(req, res) => (admin && admin.handle(req, res)) || legacy(req, res)`; `admin.handle` claims only URLs starting with `/admin`.
- `panel.js` keeps `module.exports = { createServer, botState }`. `createServer(options = {})` returns the legacy-only server unless `options.admin` is given, so `test/panel.test.js` (which calls `createServer()` with no database) is unchanged; `botState` is the very object created by `createBotRuntime`. `main()` calls `bootstrap({ mode: "panel" })`.
- Requiring `panel.js` still binds nothing and installs no signal handler (only `main()` does), and every new module starts timers in `start()` only.
- A new `test/panel-legacy.test.js` freezes the status code, exact key set and `Content-Type` of every legacy route (SC-010), next to the existing no-leak test.
- `GET /` keeps returning the health JSON for `*/*` and `curl`; the legacy contract does not redirect.

## 16. Test seams

All suites stay offline: in-memory SQLite, fake client and socket, stubbed axios/fetch/`execFile`, local temporary git repositories, fake executables.

| Seam | How |
| ---- | --- |
| Clock | Every engine takes `now`; `createAdmin({ clock })` for the 15-minute lockout, the 24 h idle and 7-day cap, the 30-minute setup link; `mock.timers.enable({ apis: ["Date"] })` where `cooldown` or `Date.now()` is involved. |
| Client | `fakes.fakeClient()` gains `getState()`, `restart()`, `requestPairingCode()`, `resetSession()`, `logout()` recorders and a settable state that emits `state`/`qr`. |
| KDF cost | `createAdmin({ kdf })` and the backup/password modules accept low scrypt parameters; production constants stay in the modules (the hash string is self-describing, so a test hash still verifies). |
| Directories | `rootDir` and `dataDir` are injectable for `secretBox`, `storage`, `safeFs`, `backup`, `updater`, `broadcaster` media; tests use `fs.mkdtemp`. Nothing in a test touches the real `data/`, `sessions/` or `database.db`. |
| SQLite memory | One connection: concurrent `DATABASE.transaction()` calls fail with `cannot rollback - no transaction is active`. New jobs serialize their transactions with `lib/utils/mutex.js` (`withLock(key, fn)`); CAS claims need no transaction. The economy adjustment reuses `plugins/economy.withLock("give:<groupJid>")`. |
| Env | `fakes.setupEnv` sets `ADMIN_PANEL=false` and `UPDATE_CHECK=false` so no test binds a port or starts a checker by accident; admin tests build the admin explicitly. |
| Memory probe | One child script `tools/panel-memory-child.js` (`baseline` and `panel` modes) serves both `test/admin-memory.test.js` (one run per mode, asserts `heapUsed + external` delta under 25 MB, reports RSS) and `tools/measure-panel-memory.js` (median of 3). |

Helpers to add in `test/helpers/`:

| File | Content |
| ---- | ------- |
| `adminHarness.js` | `createTestAdmin(opts)`: `setupEnv`, `syncDb`, store load, unstarted admin on `listen(0, "127.0.0.1")`, teardown |
| `adminClient.js` | cookie jar over `res.headers.getSetCookie()`, `setup()`, `login()`, `api(method, path, body)` adding `Origin`, `X-CSRF-Token` and JSON headers, `raw()` for hostile requests |
| `fakeBaileys.js` | `loadClientWithFakeBaileys()` extracted from `test/panel.test.js`, plus `requestPairingCode`, `waitForSocketOpen`, `authState.creds` |
| `fakeClock.js` | `createClock(start)` with `advance(ms)` and `mock.timers` Date wiring |
| `tmpRepo.js` | temporary bare repository plus clone for `test/updater.test.js` |
| `fakeExec.js` | fake `yt-dlp` / `git` / `yarn` executables and an injectable `run` |

The index of the new suites, with what each pins, is in [quickstart.md](../quickstart.md#1-automated-check). Existing suites to adjust (additions only): `test/hooks.test.js` (order list), `test/registry.test.js` (`desc` getter, command state), `test/pipeline.test.js` (counters, maintenance gate), `test/database.test.js` (14 new tables, idempotent second `sync()`), `test/i18n.test.js` (scans `lib/admin/**` automatically; new keys must exist in `en` and `fr`).

## 17. Points settled while writing this contract

| # | Conflict between sources | Settled as | Why |
| - | ------------------------ | ---------- | --- |
| 1 | Two `runtime.js`: A5 `lib/admin/runtime.js` (restart, state) vs R1 `lib/utils/runtime.js` (supervisor detection) | `lib/utils/runtime.js` = environment detection only; restart and bot state = `lib/core/botRuntime.js` | restart must work with the panel off and `core` may not import `lib/admin` |
| 2 | Stats: A7 `usageStats.js`, `DailyStat(day, kind, key)` vs C8 `stats.js`, `(day, metric, subject)` | C8 names (`lib/utils/stats.js`, metrics `messages`, `group_msgs`, `cmd_ok`, `cmd_fail`) | C1 is the data model of record |
| 3 | Setting value format: A1 raw env string vs C1 JSON scalar | raw env-format string (`serialize`/`parse`) | one parse/validate path for file and panel; lists and backups stay trivial |
| 4 | `classifyError` alert: C7 calls `alerts.raise` directly vs D4 emitter in `http.js` | bus event `key:refused`, subscribed by `alerts` | `alerts.js` requires `http.js`: a direct call is a cycle |
| 5 | Audit: B `audit.record(req, ...)` vs C `audit.record({...}, { transaction })` at `lib/utils/audit.js` | object form with `{ transaction }` in `lib/admin/audit.js` (plan layout); `ctx.audit` adds the request origin | the economy adjustment needs the transaction; the CLI has no `req`; only admin code and tools audit |
| 6 | Engines start: C4 `plugins/adminjobs.js` `onReady` vs A6 "timers start in bootstrap" | `bootstrap` starts `stats`, `housekeeping`, `broadcaster`, `alerts`, `updater` checker with the client it owns | no extra plugin; tests that load plugins start no timers |
| 7 | Alert wiring: C7 in `attachHandlers` vs plan G3 "pipeline only gains counters" | `alerts.start(client)` subscribes to `close`/`ready` itself | pipeline keeps one change set (counters + maintenance gate) |
| 8 | Restore flag: C6 `lib/admin/maintenance.js` vs plan `services/maintenance.js` (update page) | `lib/utils/maintenanceMode.js` | the core pipeline reads it |
| 9 | Log leaves: R1 "engines in `lib/utils`" vs plan `lib/admin/logs/*` | redactor, ring, consoleCapture stay under `lib/admin/logs/` as dependency-free leaves | matches the plan tree; `logger.js` needs them with the panel off |
| 10 | Memory tests: B10 `admin-memory.test.js` (always on) vs D8 `panel-memory.test.js` (`MEASURE_MEMORY=1`) and two child scripts | both kept, one shared child `tools/panel-memory-child.js` | structural/heap guard in `yarn test`, RSS median by script |
| 11 | Port conflict: A6 never drift vs D7 try 10 following ports | never drift | predictable URL; the console message names `PANEL_PORT` |
| 12 | Index mode shutdown: A6 "no signal handlers" vs D6 shared handler | shared `runtime.shutdown` in both modes; it flushes `conversationManager` itself | `docker stop` and `pm2 restart` stop waiting for SIGKILL |
| 13 | Stats count point: A7/C8 "right after `Message` is built" | after the disabled-chat gate | a fully ignored chat is not "processed" |
| 14 | `settingsCatalog` location: A1 `lib/settings/` | `lib/utils/settingsCatalog.js` | no new top-level folder |
| 15 | Panel services: C2 `lib/admin/stores/*` vs plan `lib/admin/services/{groups,data}.js` | plan layout | one folder for panel-facing write paths |
| 16 | `GET /`: A6 redirects browsers (`Accept: text/html`) to `/admin/` vs D6 "never touch legacy paths" | no redirect; `/` stays the health JSON, the console prints the full `/admin` URL | "legacy routes byte-compatible" (FR-011, SC-010); some uptime monitors send `Accept: text/html` |
| 17 | `GET /admin/**` for unknown paths: the legacy catch-all answers 200 HTML for any path | `/admin` owns its prefix: JSON 404 under `/admin/api`, SPA shell elsewhere, never the status page | B1 |
| 18 | Failed broadcast targets: C4 `retryFailed` vs the spec's "au plus une fois" | Resolved U14: no retry function, route or transition; the UI pre-fills a new broadcast from the run report and submits it through the create route (section 9) | a retry can send twice (`interrupted` may have been delivered) |
| 19 | Broadcast media lifetime: C1 90 days, no storage category | Resolved U15: `once` media deleted 7 days after its run ends, recurring media kept while the broadcast exists, "broadcast media" storage category that never touches media that may still be sent (sections 9 and 14) | long enough to build the pre-filled broadcast, visible and emptiable |
| 20 | Anti-bot id shapes: R3 "Web clients' long hex ids" | Resolved U16: remove only `BAE5`+12 hex and 40-character `3EB0...`; the 22-character `3EB0...` is a logged suspect (section 7) | removing a human is worse than missing a bot |
| 21 | Links inside commands: exempt or not | Resolved U17: strict, commands included; admins and owners exempt (section 7) | the hook consumes the message before the registry |
| 22 | Legacy `PANEL_ENABLED` | Resolved U18: ignored, one boot warning when present (section 15) | a copy of the old example ships `PANEL_ENABLED=false` |
| 23 | Catalog vocabulary: `boot` / `boot-only`, `backing` / `source`, origin `panel` / `store` / `runtime` vs `override`, `confirmWhen` token, `LANG` / `BOT_LANG` key | the vocabulary of settings-catalog.md section 1 (data-model.md section 7, row 13) | one spelling in the three files and the API |
| 24 | `LOG_LEVEL`: A "boot-only" vs settings-catalog "immediate" | live through `logger.setLevel` (section 12) | the shared logger factory (B8) is decided, which is what A said would make it live |

**No open question.** D-1 of earlier drafts (anti-bot id shapes) is resolved by U16 (section 7); rows 18 to 24 record the Phase 1 decisions U14 to U19 and the vocabulary reconciliation. Everything else above follows the research arbitration or is an implementation detail inside it.
