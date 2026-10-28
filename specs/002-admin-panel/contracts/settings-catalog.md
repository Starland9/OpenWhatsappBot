# Contract: settings catalog

Feature `002-admin-panel`. Inputs: [spec.md](../spec.md) (FR-014 to FR-022, US3, SC-002 to SC-004), [research.md](../research.md) (**authoritative**: U1, U2, U3, U5, U8, U9, U11, U12, U18, U19, R2, R3, R5, C1), research streams A (Appendix A and B, A1 to A5, A8), B (B5), C (C7), D (D1, D4, D7), [data-model.md](../data-model.md) (section 4.1 entry shape, 1.4 `SettingOverride`), [admin-http-api.md](admin-http-api.md) (SET-1, SET-2, SET-3).

The catalog is **data only** (`lib/utils/settingsCatalog.js`, no database import so `config.js` can load it before any model exists). It is the single source for validation, panel forms, restore checks, the API-key tests and the parity test of section 8. `config.js` exposes accessor properties that read **override, then environment/file, then default**.

---

## 1. Entry shape

One object per setting. **101 entries**: 67 editable, 34 read-only (13 startup, 21 inactive); 22 secrets; 5 with effect `restart`.

| Property | Type | Meaning |
| --- | --- | --- |
| `key` | string, `^[A-Z][A-Z0-9_]{1,63}$` | unique id and `SettingOverride.key`. Equals the environment variable name when `env` is set (`BOT_LANG`, not `LANG`) |
| `env` | string or null | environment variable read from `process.env` after dotenv loaded `config.env`. `null` for panel-only keys (`ALERT_*`, `BROADCAST_DELAY_MS`) and for the virtual keys of database or file adapters (section 3) |
| `envAliases` | string[] | extra names read when `env` is empty: `PANEL_PORT` accepts `PORT`, `PANEL_HOST` accepts `HOST` (panel hosts set those) |
| `configProp` | string | property of the object exported by `config.js`; default `key`. `BOT_LANG` is `LANG` |
| `theme` | enum | functional themes `general`, `behavior`, `api-keys`, `responder`, `moderation`, `limits`, `advanced`, `boot`, `alerts`, plus `inactive`, a display group reserved for entries carrying the `inactive` flag (rule in section 4) |
| `type` | enum | `bool`, `int`, `string`, `text` (multi-line), `enum`, `list`, `url` |
| `validate` | rule object | length, pattern, `min`/`max`, enum values, list item rule and `maxItems`, cross-field rules (section 6). Also shipped to the SPA as `rules` for client-side pre-validation; the server is authoritative |
| `default` | any | static default (JSON-typed). A setting whose default is computed has `derived` instead: `same_as:<KEY>` (`GEMINI_VISION_MODEL`), `auto_host` (`PANEL_HOST`). The panel shows the **code** default, not the example file's |
| `unit` | string or null | display only: `ms`, `MB`, `chars`, `chars/s`, `items` |
| `secret` | bool | write-only. The API exposes `{ set, last4 }` only, the value is registered with the log redactor (every secret in effect, whatever its origin), and a value stored by the panel is encrypted at rest (section 2.5). Secret values are 8 characters or more (the redactor ignores shorter ones) |
| `mask` | enum | how a set value is shown: `last4` (default for secrets), `scheme` (`DATABASE_URL`: scheme only), `url` (credentials, query and fragment stripped), `none` |
| `effect` | enum | `immediate`: next message or call. `restart`: stored at once, applied by the in-process restart (RST-1), listed in `restartPending` until then. `boot-only`: read before the database exists or at process start; **read-only in the panel**, changed in the file/environment and applied at the next process start. Inactive entries are `boot-only` by convention (nothing reads them at all) and the UI shows the "sans effet" group instead of an effect badge |
| `readonly` | bool | the API refuses a write (`fields[key] = readonly`). True for every `boot-only` and every `inactive` entry, and for executable paths (`YTDLP_PATH`, U11). Kept explicit so the UI needs no derivation |
| `inactive` | bool | **flag**: no code reads the key today (U8). Shown read-only in the folded group "sans effet aujourd'hui" (FR-014, display rule in section 4); kept in the catalog so SC-002 holds; removal is a later feature |
| `source` | enum | `env`: override row over environment/file over default. `model`: the value lives in an existing settings row (adapter). `file`: the value lives in `data/status_save.json` (adapter) |
| `adapter` | string or null | adapter id when `source` is `model` or `file` (section 3) |
| `confirm` | string or null | confirmation token required by SET-2 when the change is risky (`SUDO`: `owners_empty`) |
| `testService` | string or null | API-key test target (section 7); `null` when the key cannot be verified or is unused |
| `fileTransform` | string or null | applied to environment/file values only: `unescapeNewlines` (a literal `\n` in an unquoted `config.env` value becomes a line break) for `WARN_MESSAGE` and `WARN_KICK_MESSAGE`. A value typed in the panel keeps its real newlines |
| `onChange` | string[] | hooks run after a successful write (section 2.6) |
| `flags` | string[] | `not-in-example` (read by `config.js`, absent from `config.env.example`), `default-differs` (example and code defaults differ; the panel shows the code default, U19), `seed` (the environment value only seeds a row or file), `legacy-alias` |

Labels and descriptions are **not** stored in the catalog: the panel catalog `lib/admin/public/i18n/{en,fr}.json` holds `settings.<KEY>.label`, `settings.<KEY>.desc` and `settings.theme.<theme>` for every entry and theme (parity test, section 8). They are separate from `lang/*.json` (bot texts).

**Vocabulary** (identical in [data-model.md](../data-model.md) 4.1, [runtime.md](runtime.md) section 1 and the API): `effect` is `immediate | restart | boot-only`; `inactive` is a flag, and `inactive` as a `theme` is only the display group of flagged entries (section 4); `origin` is `default | env | override`, with `source` (`env | model | file`) and `canRevert` carrying what an adapter-backed entry adds (section 2.1); `alerts` is a functional theme whose six toggles are ordinary `SettingOverride` rows.

---

## 2. Resolution, origin, versions, secrets

### 2.1 Resolution order

For a `source: env` entry: the override row if one exists (even `''`, a deliberate value); else the environment/file value if non-empty and valid (an empty variable counts as unset, as `||` does today); else the default (`derived` defaults are computed from the other key's effective value). An invalid environment/file value falls back to the default and is recorded in `problems[key]` (spec edge case "valeur invalide déjà présente dans le fichier"): SET-1 reports `problem: "invalid_file_value"` and the `invalid_file_values` banner appears. Adapter-backed entries read their row or file (section 3).

`origin` in `ResolvedSetting` is `override` (a `SettingOverride` row exists), `env` (the environment/file value is used) or `default`. Adapter-backed entries (section 3) report `override` when their row or file holds the value (stored by the bot, set from the panel or from a WhatsApp command, which are indistinguishable by design: both write the same row, FR-030), `env` while only the environment seed applies (row or file not created yet, or `AUTO_STATUS_SAVE` forced on by the environment) and `default` otherwise. There is no `store` or `panel` value: the response also carries `source`, and `canRevert` is always false for adapter-backed entries. The UI labels `default`, `env` and `override` "défaut", "fichier/environnement" and "panel" (FR-014), and an adapter-backed `override` "enregistré par le bot".

### 2.2 Value formats (three layers, one parser)

| Layer | bool | int | list | text |
| --- | --- | --- | --- | --- |
| Environment/file (`config.env`) | exact `"true"` is true (default-false keys); exact `"false"` is false (default-true keys, below) | base-10 integer | comma-separated | `\n` unescaped for the two `fileTransform` keys |
| `SettingOverride.value` (raw string, same format as the environment; data-model 1.4) | same | same | same | real newlines, no unescape |
| API (JSON) | boolean | number (integer) | array of strings | string |

- **Boolean rule**: a `bool` with `default: false` is true only for the exact string `"true"` (CLAUDE.md convention); a `bool` with `default: true` is false only for the exact string `"false"` (`ADMIN_PANEL`, `UPDATE_CHECK`, `DATABASE_SSL`, `ALERT_*`). Anything else keeps the default.
- **Integer rule**: strict (`^\d+$` in the environment); a malformed or out-of-bounds value is invalid (default + `problem`). Today's `parseInt(x) || default` accepts `12abc` as 12 and turns `0` into the default; the catalog bounds below decide which zeros are meaningful (`AUTO_RESPONDER_MIN_DELAY`, `AUTO_RESPONDER_MAX_DELAY`, `AUTO_RESPONDER_MAX_TYPING_TIME` allow 0).
- **List rule**: stored comma-joined without spaces; items never contain a comma (item patterns forbid it); the API sends and receives arrays.

### 2.3 Versions (FR-020)

`version` is an integer the client echoes back. For `source: env` entries it is `SettingOverride.version` (0 when the key has never had a row since the process started; after a reset the store continues from the last known version, data-model 1.4). For adapter entries it is an opaque integer derived from the store's own change marker (row `updatedAt` in epoch milliseconds, file `mtimeMs`; 0 when the row does not exist yet). Equality is the only operation.

### 2.4 `ResolvedSetting` (the SET-1 / SET-2 view)

```json
{
  "key": "PREFIX",
  "theme": "general",
  "source": "env",
  "type": "string",
  "rules": { "minChars": 1, "maxChars": 3, "noWhitespace": true },
  "unit": null,
  "default": ".",
  "derived": null,
  "value": "!",
  "secret": null,
  "fileValue": ".",
  "origin": "override",
  "canRevert": true,
  "version": 3,
  "effect": "immediate",
  "readonly": false,
  "inactive": false,
  "pendingRestart": false,
  "problem": null,
  "testService": null,
  "confirm": null
}
```

- `value` is the effective value for non-secrets (typed JSON); it is absent for secrets, which carry `secret: { set, last4, needsReentry }` instead (`last4` is the last four characters of the effective value, `null` when unset; `needsReentry` is true when the stored ciphertext cannot be decrypted, section 2.5). For `mask: scheme` the secret object is `{ set, scheme }`; for `mask: url`, `value` has credentials, query and fragment stripped.
- `fileValue` is the environment/file value (non-secrets only, `null` when absent or invalid): it lets the form show "valeur du fichier" next to "modifié dans le panel" (US3 scenario 6). `canRevert` is true when `origin` is `override` and `source` is `env`.
- `pendingRestart` is true when `effect` is `restart` and the resolved value differs from `inForce[key]`, a snapshot taken at boot and after each in-process restart (FR-016).
- Boot-only entries show the **effective** value of the running process (for `PANEL_HOST`, the address actually bound).

### 2.5 Secrets at rest (U9, C1)

A secret stored by the panel is `SettingOverride.value = enc:v1:<iv>:<tag>:<ciphertext>` (AES-256-GCM, `node:crypto`, key = 32 random bytes in `data/panel.key`, mode 0600, created on the first secret write; the setting `key` is bound as additional authenticated data). An empty secret is stored as `''`. When the key file is missing or a value fails to decrypt, the override is **ignored** (the environment/file value applies), the entry reports `needsReentry: true` (UI: "à ressaisir"), the `secret_key_lost` banner shows and one error is logged. Backups carry the decrypted values inside the passphrase-encrypted archive and a restore re-encrypts with the target installation's key. Every secret value in effect (override, environment or file) is registered with the log redactor in raw, JSON-escaped, URL-encoded and base64 forms; error bodies, audit details (`{ secret: true, op }`) and logs never contain it. Last-4 display is the one allowed exposure (FR-017).

### 2.6 `onChange` hooks

| Hook | Runs for | Effect |
| --- | --- | --- |
| `languageReload` | `BOT_LANG` | `languageManager.reload()`: re-reads the language; command descriptions and the menu follow |
| `resetGeminiClient` | `GEMINI_API_KEY` | drops the cached `genAI` client of the auto responder (`autoResponderHandler.js:37`) |
| `resetSpotifyToken` | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | drops the cached token of `plugins/music.js:25` |
| `resetRedditToken` | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | drops `tokenCache` of `plugins/reddit.js:37` |
| `recomputeRecurrences` | `TIMEZONE` | recomputes `nextRunAt` of active recurring broadcasts from now; statistics days follow the new zone |
| `setLogLevel` | `LOG_LEVEL` | `lib/utils/logger.js#setLevel` updates the root logger and every child it created (requires the shared logger factory of research B8; if the plan cannot deliver it, the effect must be downgraded to `restart`) |

Every successful write also registers secrets with the redactor and, for adapter entries, invalidates the matching `settingsCache` key (CLAUDE.md rule).

---

## 3. Adapters (research C "findings" 2, R2)

Settings whose source of truth is already an existing row or file are edited through the **same code as the WhatsApp commands**, never duplicated in `SettingOverride`, and never given an override row. Their virtual keys have `env: null` except where an environment seed exists. The environment values only **seed** the row or file when it does not exist yet.

| Adapter | Source | Catalog keys | Mapping | Cache key | Notes |
| --- | --- | --- | --- | --- | --- |
| `autoResponder` | model `AutoResponder`, row `id = 1` | `AUTO_RESPONDER_ENABLED`, `AUTO_RESPONDER_IGNORE_NUMBERS`, `AUTO_RESPONDER_PERSONALITY` | `enabled`, `ignoreNumbers` (comma text), `personality` | `auto_responder` | env values seed the row at creation (`autoResponderHandler.js:87-89`); `personality` is also the fallback (`:185`). Same code as `.ar` |
| `antiDelete` | model `AntiDelete`, row `id = 1` | `ANTIDELETE_MODE`, `ANTIDELETE_JID` (virtual, no env) | `off` writes `antiDelMode "null"`, `enabled false`, `antiDelJid null`; `p`, `g`, `sudo` write the mode with `enabled true`, `antiDelJid null`; `jid` writes `antiDelMode "jid"`, `antiDelJid`, `enabled true` | `anti_delete` | the real anti-delete switch. The environment key `ANTI_DELETE` is dead (inactive group). Same code as `.antidelete` (`parseMode`) |
| `viewOnce` | model `ViewOnce`, row `id = 1` | `VIEWONCE_MODE`, `VIEWONCE_JID` (virtual, no env) | `off`, `p`, `g`, `jid` as above (`vvMode`, `vvJid`, `enabled`) | `view_once` | same code as `.setvv` |
| `statusSave` | file `data/status_save.json` (`{ enabled, list }`) | `AUTO_STATUS_SAVE`, `STATUS_SAVE_LIST` | `enabled`, `list` (digits-only numbers) | none (`statusListStore` re-reads on `mtime` change) | calls `statusListStore.setEnabled` / `add` / `remove`. `AUTO_STATUS_SAVE=true` in the environment forces the feature on whatever the file says (`forcedByEnv`): setting it to `false` is then refused with `forced_by_env` |

A batch that changes `ANTIDELETE_MODE` and `ANTIDELETE_JID` (or the view-once pair) is applied as one row update. `ANTIDELETE_JID` is required when the mode is `jid` and must be empty otherwise (the adapter clears it; a non-empty value with another mode is `not_applicable`). Database adapters join the SET-2 transaction; the file adapter is written last.

---

## 4. Themes

| Id | Panel label (fr / en) | Content |
| --- | --- | --- |
| `general` | Général / General | prefix, language, time zone, owners, sticker texts |
| `behavior` | Comportement / Behaviour | always online, status view/react/save, reactions, anti-delete, view-once |
| `api-keys` | Clés API / API keys | keys, models, social-download backend |
| `responder` | Répondeur / Auto responder | AI responder switch, personality, anti-ban tuning |
| `moderation` | Modération / Moderation | warnings, anti-link and anti-bot messages |
| `limits` | Limites / Limits | media size, timeouts, concurrency, broadcast spacing |
| `advanced` | Avancé / Advanced | log levels, caches, memory, `PANEL_TOKEN` |
| `boot` | Démarrage / Startup | read-only startup settings (FR-019) |
| `alerts` | Alertes / Alerts | the six alert toggles (US13): ordinary `SettingOverride` rows (`env: null`, default `true`), never stored in `AlertState` or `AlertOutbox`; an addition to the themes listed in US3, because alerts have their own page |
| `inactive` | Sans effet aujourd'hui / No effect today | read-only, folded group (FR-014, U8) |

**Rule for `inactive` (stated once; the other files point here).** `inactive` is a flag (`inactive: true`, U8) and the source of truth. The UI shows every flagged entry, whatever its functional theme, in one folded group; the catalog gives that group the theme id `inactive`, so `inactive: true` holds if and only if `theme` is `inactive` (parity test, section 8). The id is a display group only: no functional page uses it, and the theme an entry would have once a feature reads it is recorded in the `Was` column of section 5.10, not stored on the entry.

---

## 5. The catalog

Defaults are the **code** defaults (U19): for the five keys flagged `default-differs` (`AUTO_STATUS_VIEW`, `ENABLE_MESSAGE_REACTIONS`, `AUTO_READ`, `VPS`, `STICKER_AUTHOR`) `config.env.example` suggests another value, which it keeps; a fresh install without a file value gets the code default, and an installation that copied the example shows origin `env` with the example's value. No behaviour change. "Readers" cite the file that consumes the value; "Work" lists the require-time captures that must change so an override applies on the next message (research A1). Rule ids (`R-...`) are defined in section 6. All `secret: true` entries use `mask: last4` unless stated.

### 5.1 `general` (6)

| Key | Type | Validation | Default | Secret | Effect | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `PREFIX` | string | R-prefix: 1 to 3 characters, no whitespace | `.` | no | immediate | read per message (`pipeline.js:116`, `registry.js:257`); `panel.js:40` constant is stale (fix) |
| `SUDO` | list | R-sudo: at most 20 entries | empty | no | immediate | `confirm: owners_empty`; empty makes every owner command refuse and alerts undeliverable (`permissions.js:49`) |
| `BOT_LANG` | enum | R-lang: a file name in `lang/` (ar bn en es fr hi id ru tr ur) | `fr` | no | immediate | `configProp: LANG`; `onChange: languageReload`; `language.js:10` fixes the language at require time (Work) |
| `TIMEZONE` | string | R-tz: IANA zone | `UTC` | no | immediate | `onChange: recomputeRecurrences`; read by `scheduler.js:88`, `antiDeleteHandler.js:42` |
| `STICKER_PACKNAME` | string | 0 to 64 characters | `Made with` | no | immediate | `sticker.js:184` |
| `STICKER_AUTHOR` | string | 0 to 64 characters | `Bot` | no | immediate | `sticker.js:185`; flag `default-differs` (example: `Levanter Bot`) |

### 5.2 `behavior` (11)

| Key | Type | Validation | Default | Secret | Effect | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `ALWAYS_ONLINE` | bool | | false | no | restart | `client.js:100` reads `process.env` directly (Work: use `config`) |
| `AUTO_STATUS_VIEW` | bool | | false | no | immediate | `client.js:205`; flag `default-differs` (example: true) |
| `AUTO_STATUS_REACT` | bool | | false | no | immediate | `client.js:211` |
| `STATUS_EMOJIS` | list | R-emoji: 1 to 30 items | 😀 👍 ❤️ 🔥 💯 ✨ 🎉 👏 💪 🙌 | no | immediate | `client.js:214-231` |
| `AUTO_STATUS_SAVE` | bool | | false | no | immediate | `source: file`, `adapter: statusSave`, flags `not-in-example`, `seed`; `forced_by_env` |
| `STATUS_SAVE_LIST` | list | R-numlist (digits only, 6 to 15) | empty | no | immediate | `source: file`, `adapter: statusSave`, flags `not-in-example`, `seed` |
| `ENABLE_MESSAGE_REACTIONS` | bool | | false | no | immediate | `Message.js:367`; flag `default-differs` (example: true) |
| `ANTIDELETE_MODE` | enum | `off`, `p`, `g`, `sudo`, `jid` | `off` | no | immediate | `env: null`, `source: model`, `adapter: antiDelete` |
| `ANTIDELETE_JID` | string | R-chatjid; required iff mode is `jid` | empty | no | immediate | `env: null`, `source: model`, `adapter: antiDelete` |
| `VIEWONCE_MODE` | enum | `off`, `p`, `g`, `jid` | `off` | no | immediate | `env: null`, `source: model`, `adapter: viewOnce` |
| `VIEWONCE_JID` | string | R-chatjid; required iff mode is `jid` | empty | no | immediate | `env: null`, `source: model`, `adapter: viewOnce` |

### 5.3 `api-keys` (16)

| Key | Type | Validation | Default | Secret | Effect | `testService` / notes |
| --- | --- | --- | --- | --- | --- | --- |
| `OPENAI_API_KEY` | string | R-secret | empty | yes | immediate | `openai`; `chatgpt.js:76`, `voice.js:117` |
| `GEMINI_API_KEY` | string | R-secret | empty | yes | immediate | `gemini`; `gemini.js:92`, `imagen.js:45`, `autoResponderHandler.js:37`; `onChange: resetGeminiClient` |
| `WEATHER_API_KEY` | string | R-secret | empty | yes | immediate | `weather`; `weather.js:66` (keyless Open-Meteo fallback) |
| `UNSPLASH_API_KEY` | string | R-secret | empty | yes | immediate | `unsplash`; `imagesearch.js:91` |
| `GIPHY_API_KEY` | string | R-secret | empty | yes | immediate | `giphy`; `imagesearch.js:44` |
| `NEWS_API_KEY` | string | R-secret | empty | yes | immediate | `news`; `news.js:89` |
| `ALPHA_VANTAGE_KEY` | string | R-secret | empty | yes | immediate | none (not verifiable, section 7); `news.js:176-187`, free quota 25 requests a day |
| `SPOTIFY_CLIENT_ID` | string | R-id | empty | no | immediate | `spotify` (tested together with the secret); `onChange: resetSpotifyToken` |
| `SPOTIFY_CLIENT_SECRET` | string | R-id | empty | yes | immediate | `spotify`; `onChange: resetSpotifyToken` |
| `REDDIT_CLIENT_ID` | string | R-id | empty | no | immediate | `reddit`; `onChange: resetRedditToken` |
| `REDDIT_CLIENT_SECRET` | string | R-id | empty | yes | immediate | `reddit`; `onChange: resetRedditToken` |
| `GEMINI_MODEL` | string | R-model | `gemini-2.5-flash` | no | immediate | `autoResponderHandler.js:192`, `gemini.js:117` |
| `GEMINI_VISION_MODEL` | string | R-model, empty allowed | empty | no | immediate | `derived: same_as:GEMINI_MODEL` |
| `IMAGE_MODEL` | string | R-model, empty allowed | empty (the plugin picks its default) | no | immediate | `imagen.js:44` |
| `OPENAI_MODEL` | string | R-model | `gpt-4o-mini` | no | immediate | `chatgpt.js:98` |
| `BACKEND_URL` | url | R-url: empty or http(s) URL | empty (disabled) | no | immediate | `mask: url`; `socialdl.js:51-53`, used only after yt-dlp |

### 5.4 `responder` (9)

| Key | Type | Validation | Default | Secret | Effect | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `AUTO_RESPONDER_ENABLED` | bool | | false | no | immediate | `source: model`, `adapter: autoResponder`, flag `seed` |
| `AUTO_RESPONDER_IGNORE_NUMBERS` | list | R-numlist | empty | no | immediate | `source: model`, `adapter: autoResponder`, flag `seed` |
| `AUTO_RESPONDER_PERSONALITY` | text | 1 to 2000 characters | "You are a helpful and friendly assistant. Respond naturally and conversationally." | no | immediate | `source: model`, `adapter: autoResponder`, flag `seed` |
| `AUTO_RESPONDER_MIN_DELAY` | int | 0 to 600000 ms, not above `AUTO_RESPONDER_MAX_DELAY` | 1000 | no | immediate | `autoResponderHandler.js:231` |
| `AUTO_RESPONDER_MAX_DELAY` | int | 0 to 600000 ms, not below `AUTO_RESPONDER_MIN_DELAY` | 3000 | no | immediate | `:232` |
| `AUTO_RESPONDER_TYPING_SPEED` | int | 1 to 1000 chars/s | 50 | no | immediate | `:57` |
| `AUTO_RESPONDER_MAX_TYPING_TIME` | int | 0 to 120000 ms | 10000 | no | immediate | `:58` |
| `AUTO_RESPONDER_RATE_LIMIT` | int | 1 to 1000 | 5 | no | immediate | `:104` |
| `AUTO_RESPONDER_RATE_WINDOW` | int | 1000 to 86400000 ms | 60000 | no | immediate | `:103` |

### 5.5 `moderation` (5)

`ANTILINK_MSG` and `ANTIBOT_MSG` were dead keys in research A; U3/R3 (enforcement implemented by `plugins/groupguard.js`) make them live, so they are **not** in the inactive group.

| Key | Type | Validation | Default | Secret | Effect | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `WARN_LIMIT` | int | 1 to 50 | 3 | no | immediate | `warnuser.js:90,164`; also the removal limit of the anti-link guard; today `0` falls back to 3 |
| `WARN_MESSAGE` | text | R-tpl: 1 to 1000 characters; tokens `&mention`, `&warn`, `&remaining` | the warning card of `config.js:149` | no | immediate | `fileTransform: unescapeNewlines`; `warnuser.js:167` |
| `WARN_KICK_MESSAGE` | text | R-tpl: 1 to 500 characters; token `&mention` | `&mention kicked` | no | immediate | `fileTransform: unescapeNewlines`; `warnuser.js:196` |
| `ANTILINK_MSG` | text | R-tpl: 1 to 500 characters; token `&mention` | `_Antilink Detected &mention kicked_` | no | immediate | read by the group guard (R3); previously unused |
| `ANTIBOT_MSG` | text | R-tpl: 1 to 500 characters; token `&mention` | `&mention removed` | no | immediate | read by the group guard (R3); previously unused |

### 5.6 `limits` (5)

| Key | Type | Validation | Default | Secret | Effect | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `MAX_UPLOAD` | int | 1 to 2000 MB | 230 | no | immediate | 28 reads; captured at require time in `imagesearch.js:24` (Work: make lazy). Also the cap of panel uploads and broadcast media |
| `DOWNLOAD_TIMEOUT` | int | 10000 to 1800000 ms | 180000 | no | immediate | `downloader.js:58`, `apkdownload.js:180` |
| `TTS_MAX_LENGTH` | int | 50 to 5000 chars | 500 | no | immediate | flag `not-in-example`; `tts.js:27`, `voice.js:19` |
| `MESSAGE_CONCURRENCY_LIMIT` | int | 1 to 50 | 5 | no | immediate | flag `not-in-example`; read per batch in `pipeline.js:231` |
| `BROADCAST_DELAY_MS` | int | 2000 to 600000 ms | 5000 | no | immediate | `env: null`; default spacing of **new** broadcasts (FR-048: never under 2 s); existing broadcasts keep their own `spacingMs` |

### 5.7 `advanced` (9)

| Key | Type | Validation | Default | Secret | Effect | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `LOG_LEVEL` | enum | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent` | `info` | no | immediate | `onChange: setLogLevel` (needs the shared logger of research B8, which replaces the 19 `pino(` sites) |
| `BAILEYS_LOG_LVL` | enum | same values | `silent` | no | restart | `client.js:98` reads `process.env` (Work: use `config`); read when the socket is created |
| `CACHE_CLEANUP_INTERVAL` | int | 10000 to 86400000 ms | 600000 | no | restart | flag `not-in-example`; `antiDeleteHandler.js:57` needs `reconfigure()` |
| `CACHE_MAX_AGE` | int | 60000 to 86400000 ms | 3600000 | no | immediate | flag `not-in-example`; `antiDeleteHandler.js:58` becomes a live getter |
| `CONVERSATION_UPDATE_INTERVAL` | int | 500 to 60000 ms | 2000 | no | restart | flag `not-in-example`; `conversationManager.js:26` |
| `CONVERSATION_BATCH_SIZE` | int | 1 to 100 | 5 | no | immediate | flag `not-in-example`; `conversationManager.js:27` becomes a live getter |
| `MEMORY_CLEANUP_INTERVAL` | int | 60000 to 86400000 ms | 900000 | no | restart | flag `not-in-example`; `memoryManager.js:11` |
| `MEMORY_WARN_THRESHOLD` | int | 50 to 16384 MB | 400 | no | immediate | flag `not-in-example`; heap threshold, `memoryManager.js:12` becomes a live getter |
| `PANEL_TOKEN` | string | empty or R-token (16 to 256 characters) | empty | yes | immediate | Bearer token of the legacy `POST /api/restart`, read per request (`panel.js:247`); empty means that endpoint answers `403` |

### 5.8 `alerts` (6)

All `env: null`, type `bool`, default **true** (U12), effect `immediate`, stored in `SettingOverride`. Alert `type` ids are those of `AlertOutbox.type`; toggling is SET-2 on the key (the alerts page is a view over these keys).

| Key | Alert type | Trigger (research C7) |
| --- | --- | --- |
| `ALERT_RECONNECT` | `reconnected` | reconnection after a cut longer than 5 minutes (duration in the message) |
| `ALERT_ERROR_BURST` | `errors_series` | 10 command errors in 10 minutes; at most one alert per hour |
| `ALERT_KEY_REFUSED` | `key_refused` | a service refused its API key; at most one per service per 24 h; never contains the key |
| `ALERT_LOGIN_BLOCKED` | `login_blocked` | an origin was blocked after 5 failed panel logins |
| `ALERT_NEW_ORIGIN` | `new_origin` | successful login from an origin never seen before |
| `ALERT_UPDATE` | `update_available` | a greater remote version exists; once per version |

### 5.9 `boot` (13, all read-only, effect `boot-only`)

Read before the database exists or at process start (FR-019, R5, U11). Edited only in the environment or `config.env`; the panel shows the effective value. The set is R5's eleven names plus `KEEP_ALIVE_INTERVAL` and the fixed session folder.

| Key | Type | Validation | Default | Secret | Notes |
| --- | --- | --- | --- | --- | --- |
| `ADMIN_PANEL` | bool | | **true** | no | activation (U2). Off only for the exact string `false`. Replaces the dead `PANEL_ENABLED`, which is ignored (U18, section 8) |
| `PANEL_HOST` | string | R-host | `derived: auto_host` (U1) | no | `envAliases: [HOST]`. Auto: `127.0.0.1` locally; `0.0.0.0` when a container (`/.dockerenv`, cgroup) or a panel host (`PORT` set) is detected; a set value always wins. The example file must stop shipping `PANEL_HOST=0.0.0.0` (section 8) |
| `PANEL_PORT` | int | 1 to 65535 | 3000 | no | `envAliases: [PORT]`; order `PANEL_PORT`, `PORT`, 3000 |
| `PANEL_PUBLIC_URL` | url | R-origin: an http(s) origin, no path | empty | no | base of the setup link and an allowed `Origin` (B5, U10) |
| `PANEL_TRUST_PROXY` | string | R-trust | empty (off) | no | forwarded headers honoured only from matching peers (U10); never automatic |
| `KEEP_ALIVE_INTERVAL` | int | 5000 to 600000 ms | 60000 | no | `panel.js:45,488` (only updates `lastActivity`) |
| `LOG_FORMAT` | enum | `pretty`, `json` | `pretty` | no | chosen when the logger stream is created |
| `SUPERVISED` | enum | `auto`, `true`, `false` | `auto` | no | overrides supervisor detection for updates (D1) |
| `UPDATE_CHECK` | bool | | **true** | no | off only for `false`; disables the release check (D5) |
| `DATABASE_URL` | string | postgres URL, or empty for the SQLite file `./database.db` | empty | yes, `mask: scheme` | shows `sqlite` or `postgres` only |
| `DATABASE_SSL` | bool | | **true** | no | off only for `false`; opt-out semantics (`config.js:18`) |
| `YTDLP_PATH` | string | executable name or path | `yt-dlp` | no | read-only on purpose (U11): an editable executable path would be an arbitrary-binary primitive (`downloader.js:115`, `update.js:75`) |
| `SESSION_DIR` | string | fixed | `sessions/main` | no | `env: null`; the WhatsApp auth folder (`client.js:21`), shown relative to the repository |

### 5.10 `inactive` (21, all read-only, effect `boot-only`)

No code reads these today (verified by search over `lib`, `plugins`, `index.js`, `panel.js`; only `test/helpers/fakes.js` mentions some). They stay in the example file and in the panel so SC-002 holds; removal is a later feature (U8). "Was" is the theme each would have once a feature reads it. Secrets are shown as `{ set, last4 }`.

| Key | Type | Default | Secret | Was | Notes |
| --- | --- | --- | --- | --- | --- |
| `SESSION_ID` | string | empty | yes | `boot` | legacy; `sessions/main` multi-file auth replaced it |
| `AUTO_READ` | bool | false | no | `behavior` | only status reads exist (`client.js:206`); flag `default-differs` (example: true) |
| `STATUS_SAVE_FOLDER` | string | `media/status` | no | `behavior` | no consumer: statuses are forwarded to the owners, not stored (U5); flag `not-in-example` |
| `ANTI_DELETE` | bool | false | no | `behavior` | the real feature is `ANTIDELETE_MODE` (adapter) |
| `VPS` | bool | false | no | `behavior` | flag `default-differs` (example: true) |
| `GROQ_API_KEY` | string | empty | yes | `api-keys` | |
| `RMBG_KEY` | string | empty | yes | `api-keys` | no `rmbg` plugin |
| `CLOUDMERSIVE_API_KEY` | string | empty | yes | `api-keys` | |
| `APYHUB_API_KEY` | string | empty | yes | `api-keys` | |
| `DEEPAI_API_KEY` | string | empty | yes | `api-keys` | |
| `WAIFUPICS_API_KEY` | string | empty | yes | `api-keys` | |
| `PUTERJS_API_KEY` | string | empty | yes | `api-keys` | |
| `IMAGE_API_TIMEOUT` | int | 20000 | no | `limits` | |
| `IMAGE_API_MAX_SIZE_MB` | int | 10 | no | `limits` | |
| `HEROKU_APP_NAME` | string | empty | no | `advanced` | deployment leftover |
| `HEROKU_API_KEY` | string | empty | yes | `advanced` | |
| `KOYEB` | bool | false | no | `advanced` | |
| `KOYEB_NAME` | string | empty | no | `advanced` | |
| `KOYEB_API` | string | empty | yes | `advanced` | |
| `RENDER_NAME` | string | empty | no | `advanced` | |
| `RENDER_API_KEY` | string | empty | yes | `advanced` | |

Not catalog entries: `VERSION`, `DATABASE` (the Sequelize instance), `BRANCH` (constant `"master"`, no consumer) stay plain data properties of `config.js`.

---

## 6. Validation rules

Applied by the server to the **whole** batch before anything is written (FR-015). Field codes are those of [admin-http-api.md](admin-http-api.md) section 1.9. Submitted values are never echoed; `params` carry limits and allowed values only.

**R-prefix** (`PREFIX`): with no trimming, the value has 1 to 3 Unicode code points (`[...value].length`) and matches `^[^\s\p{C}]+$` (no whitespace, no control or format character). Valid: `.`, `!`, `/`, `#`, `bot!`. Invalid: empty, a space, `. `, `a b`. Codes: `required`, `too_long` (`max` 3), `invalid_format` (`reason: whitespace`).

**R-lang** (`BOT_LANG`): lower-cased, then must equal the basename of a `lang/*.json` file (currently `ar bn en es fr hi id ru tr ur`; the list is read from the directory). Code `not_allowed` with `params.allowed`. `en` and `fr` are the complete locales; the others fall back to `en` for missing keys.

**R-sudo** (`SUDO`): a list of at most 20 entries (`too_many_items`). Each entry, after trimming and dropping one leading `+`, is a number `^\d{6,15}$` or a JID `^\d{6,20}(:\d{1,3})?@(s\.whatsapp\.net|c\.us|lid)$`. The panel normalises (no `+`, lower case), de-duplicates by user part (the digits before `:` or `@`) and stores the comma-joined list. An invalid entry gives `invalid_phone` with `params.indices` (positions in the submitted array, not values). An empty list is valid only with `confirm: ["owners_empty"]` (otherwise `409 confirmation_required`).

**R-tz** (`TIMEZONE`): at most 64 characters and `luxon.Info.isValidIANAZone(value)` is true (the same check as `scheduler.js`; `UTC` and `Africa/Douala` pass, `UTC+3` and `Paris` fail). Code `invalid_timezone`. Changing it recomputes recurring broadcasts.

**Integers** (all `int`): JSON integer within the table's bounds, else `out_of_range` with `params.min` and `params.max` (or `invalid_type`). Cross-field rule evaluated on the **resulting effective values** of the batch: `AUTO_RESPONDER_MIN_DELAY` <= `AUTO_RESPONDER_MAX_DELAY`; a violation reports `bound_conflict` (`params.other`) on each key of the pair that is part of the batch.

**R-emoji** (`STATUS_EMOJIS`): 1 to 30 items (`too_many_items` / `required`); each item is at most 16 UTF-16 code units, contains no comma or whitespace, and matches `^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣)+$` while containing at least one pictographic character or two regional indicators (a flag). So `ok` is refused (`invalid_emoji`, `params.indices`) and `❤️`, `👨‍👩‍👧‍👦`, `🇨🇲` pass. Stored comma-joined.

**R-secret** (API keys): `^[\x21-\x7E]{8,256}$` (visible ASCII, no whitespace or newline). Empty is accepted and means "cleared". **R-id** (client ids and the Spotify and Reddit secrets): `^[\x21-\x7E]{8,128}$`, empty accepted. **R-token** (`PANEL_TOKEN`): empty or `^[\x21-\x7E]{16,256}$`. Codes `too_short`, `too_long`, `invalid_format`. A rejected secret is never echoed.

**R-model**: `^[A-Za-z0-9._:/-]{1,80}$`; empty only where the table says so.

**R-url** (`BACKEND_URL`): empty, or a URL parsed by `new URL()` with protocol `http:` or `https:`, at most 2048 characters, no username or password, no fragment, no whitespace (`invalid_url`). A file value that carries credentials is displayed with `mask: url`. **R-origin** (`PANEL_PUBLIC_URL`, file only): protocol `http:` or `https:`, no path other than `/`, no query, no fragment; a trailing slash is stripped.

**R-tpl** (message templates): length bounds per key; control characters other than `\n` are refused; every token of the form `&` followed by lower-case letters must be in the key's allowed set (`WARN_MESSAGE`: `&mention`, `&warn`, `&remaining`; the other three: `&mention`), else `unknown_variable` with `params.names` (the offending tokens only). A panel value keeps real newlines; an environment/file value goes through `unescapeNewlines` first.

**R-numlist** (`AUTO_RESPONDER_IGNORE_NUMBERS`, `STATUS_SAVE_LIST`): array of strings, each `^\+?\d{6,15}$` after removing spaces (`invalid_phone`, `params.indices`); `STATUS_SAVE_LIST` stores digits only (the `normalizeNumber` form of `statusListStore`), the ignore list stores the cleaned strings comma-joined. De-duplicated.

**R-chatjid** (`ANTIDELETE_JID`, `VIEWONCE_JID`): a JID `^[^@\s]+@(s\.whatsapp\.net|g\.us|lid)$` or a number `^\+?\d{6,16}$` (the forms the commands accept), normalised with `normalizeJid`; empty means none. Required when the matching mode is `jid` (`required`), refused with `not_applicable` for other modes.

**R-host / R-trust** (file-validated, read-only): `PANEL_HOST` is an IPv4 or IPv6 literal or a hostname (at most 253 characters). `PANEL_TRUST_PROXY` is empty or a comma-separated list of IP addresses, CIDR ranges and the keywords `loopback`, `private`, `all`; an invalid file value turns the feature off (default) and raises `invalid_file_values`.

**Unknown or forbidden keys**: a key not in the catalog is `unknown_setting`; a `boot-only` or `inactive` key is `readonly`; `revert` on an adapter-backed key is `not_applicable`.

---

## 7. API-key tests (FR-022, D4, SET-3)

The server reads the saved value (panel value wins), sends **one fixed read-only request** through `fetchJson` (10 s timeout, errors scrubbed by `scrubError`), and answers only `{ verdict, detail, checkedAt }`. The key never travels in the panel's request or answer; upstream bodies are never forwarded or logged (OpenAI echoes a masked key in its 401 body); errors go through `safeLog`. At most one test per service per 10 s (`cooldown.hit("panel", "keytest:<service>", 10000)`). Service ids are also the `service` option plugins pass to `classifyError(err, { hasKey, service })`, which feeds the `key_refused` alert. `lib/utils/http.js` gains small exports `isAuthFailure(err)` and `statusOf(err)`.

**Verdict mapping**

| Outcome | Verdict |
| --- | --- |
| 2xx with the expected body | `accepted` |
| 400, 401 or 403 on the fixed request (list per service below) | `refused` |
| 429, or a quota body (OpenAI `insufficient_quota`, NewsAPI `rateLimited`, vendor quota codes) | `accepted` with `detail: "quota"` (the key was recognised) |
| no response, `ENOTFOUND`, timeout, TLS error, 5xx, 408, an HTML page (`ERR_BAD_RESPONSE_FORMAT`) | `unreachable` |

**Per service** ("observed" = confirmed with a fake key during research; other rows come from plugin code or vendor documentation)

| Service id | Settings | Test request | Accepted | Refused | Quota | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | `GET https://api.openai.com/v1/models`, `Authorization: Bearer <key>` | 200 | 401 `invalid_api_key` (observed) | 429 `insufficient_quota` | |
| `gemini` | `GEMINI_API_KEY` | `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1`, header `x-goog-api-key` (keeps the key out of the URL) | 200 | **400** `INVALID_ARGUMENT` / `API_KEY_INVALID` (observed), 403 `PERMISSION_DENIED` | 429 | classify on status, not on the generic axios message |
| `weather` | `WEATHER_API_KEY` | `GET https://api.weatherapi.com/v1/current.json?key=<key>&q=Paris&aqi=no` | 200 | 401 code 2006 (observed); codes 2008, 2009 | 403 code 2007 | key is in the query string: never log the URL |
| `news` | `NEWS_API_KEY` | `GET https://newsapi.org/v2/top-headlines/sources`, header `X-Api-Key` | 200 | 401 `apiKeyInvalid` (observed) | 429 `rateLimited` | costs 1 of the 100 daily calls |
| `unsplash` | `UNSPLASH_API_KEY` | `GET https://api.unsplash.com/search/photos?query=test&per_page=1`, `Authorization: Client-ID <key>` | 200 | 401 (observed) | 403 "Rate Limit Exceeded" | demo apps: 50 requests an hour |
| `giphy` | `GIPHY_API_KEY` | `GET https://api.giphy.com/v1/gifs/trending?api_key=<key>&limit=1` | 200 | 401 (observed) | 429 | key is in the query string |
| `spotify` | `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` together | `POST https://accounts.spotify.com/api/token`, body `grant_type=client_credentials`, `Authorization: Basic base64(id:secret)` | 200 with `access_token` (discarded) | 400 `invalid_client` (observed), 401 | none | both values must be saved (else `not_configured`) |
| `reddit` | `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` together | `POST https://www.reddit.com/api/v1/access_token`, same body, Basic auth, **the plugin's `User-Agent`** (`reddit.js:24`; export the constant) | 200 with `access_token` | 401 (observed); 200 with an `error` field | 429 maps to `unreachable` | datacenter IPs often get 403/429 without a clear body: 429 and a non-JSON 403 are `unreachable` |
| `alphavantage` | `ALPHA_VANTAGE_KEY` | none | n/a | n/a | n/a | **not testable** (`not_testable`): `GLOBAL_QUOTE` with a fake key returned real quotes (observed); the UI hides the button |

Unused keys (the whole `inactive` API-key set) have no test either (`not_testable`). A test never raises the `key_refused` alert; that alert comes from real use.

---

## 8. Alignment with the example file, legacy names, parity test

**Legacy and aliases**
- `PANEL_ENABLED` is **ignored** (U2): it is not in the catalog, is removed from `config.env.example` and from the docs, and `config.js:206` no longer reads it. **Boot warning (U18, resolved)**: when the name is present in the environment (including a value loaded from `config.env`, as in a copy of the old example), the boot prints exactly one console line saying it is no longer read and that `ADMIN_PANEL=false` turns the panel off (runtime.md section 15, boot step 1); the panel still starts.
- `PORT` and `HOST` are aliases of `PANEL_PORT` and `PANEL_HOST`, not entries. `SERVER_PORT` (optional in D7) is not added.

**Changes to `config.env.example`** (implementation task, listed here because SC-002 and U1 depend on them)
1. Replace the `PANEL_ENABLED` block by `ADMIN_PANEL=true` with a comment.
2. Remove `PANEL_HOST=0.0.0.0` (it would defeat the automatic bind address of U1 for everyone who copies the file) and comment out `PANEL_PORT=3000` (so a host-provided `PORT` is honoured).
3. Add the names `config.js` reads that the example lacks: `AUTO_STATUS_SAVE`, `STATUS_SAVE_LIST`, `STATUS_SAVE_FOLDER`, `TTS_MAX_LENGTH`, `MESSAGE_CONCURRENCY_LIMIT`, `CACHE_CLEANUP_INTERVAL`, `CACHE_MAX_AGE`, `CONVERSATION_UPDATE_INTERVAL`, `CONVERSATION_BATCH_SIZE`, `MEMORY_CLEANUP_INTERVAL`, `MEMORY_WARN_THRESHOLD`, and mention the `PORT` / `HOST` aliases in a comment.
4. Add the new startup names: `PANEL_PUBLIC_URL`, `PANEL_TRUST_PROXY`, `LOG_FORMAT`, `SUPERVISED`, `UPDATE_CHECK`.
5. Mark the 21 inactive keys with a comment "no effect in this version".
6. The five `default-differs` keys (`AUTO_READ`, `AUTO_STATUS_VIEW`, `ENABLE_MESSAGE_REACTIONS`, `VPS`, `STICKER_AUTHOR`) keep their example values (they are `env` origin values for anyone who copied the file); the panel's default column shows the code default, which is what applies without a file value (U19). No behaviour change.

**Parity test `test/settings.test.js`** (new, offline)
1. Every `process.env.X` name read by `config.js` (and by `client.js`, `index.js`, `panel.js` for the keys above) is a catalog `env` or `envAliases` entry, and vice versa.
2. Every catalog `env` except the panel-only and virtual keys appears in `config.env.example`, and every name in the example is a catalog `env`, alias or documented legacy name (none remains: `PANEL_ENABLED` is gone).
3. Keys unique and matching the key pattern; `theme` in the enumeration; `readonly` true for every `boot-only` and `inactive` entry; `inactive` iff `theme` is `inactive`; `secret` entries have a `mask`; no `inactive` entry has `onChange` or `testService`.
4. Every entry has `settings.<KEY>.label` and `.desc` in both panel catalogs, with identical key sets in `en` and `fr`; every theme has its `settings.theme.<id>` label.
5. SC-003: a table-driven test sets an override for every editable `immediate` entry and reads the new value through `config[configProp]` (or the adapter's reader) on the next call, without a restart; entries with effect `restart` show in `restartPending`.
6. Validation table tests: each rule of section 6 with valid and invalid samples, including `PREFIX` (empty, space, `ab cd`), `BOT_LANG` (`xx`), `SUDO` (malformed number, 21 entries, empty without confirmation), `TIMEZONE` (`UTC+3`), integer bounds and the min/max pair, `STATUS_EMOJIS` (`ok`).
7. Secret test (SC-004): no secret value in `ResolvedSetting`, error bodies, audit detail or logs; last-4 only.
8. Every `testService` id has a row in section 7, and each row's service id matches the `service` option used by the corresponding plugins.
9. U18: with `PANEL_ENABLED` in the environment the boot logs exactly one warning, still reads `ADMIN_PANEL` only, and the panel starts; without it no warning is logged.
10. U19: for each `default-differs` key the catalog default equals the `config.js` code default and differs from the example's value.
