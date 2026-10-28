# Research D: maintenance, API-key tests, deployment and memory (feature 002-admin-panel)

Scope: US11 (update, download tools, storage), FR-022 (API key test), FR-053..055, FR-060 (update alert), FR-011 and SC-010 (existing endpoints), FR-039 (panel on by default), SC-009 (memory).
Method: code reading plus a few read-only probes (local memory measurement; 10 `curl` calls with obviously fake keys; local yt-dlp source). No file other than this one was modified.

## Findings that change the spec's assumptions (read first)

1. **There is no stored anti-delete or view-once archive, and saved statuses are not on disk.** `AntiDelete` and `ViewOnce` tables hold one settings row each (`lib/database/models/AntiDelete.js:14-33`, `ViewOnce.js`). The anti-delete "archive" is an in-memory `Map` (100 messages per chat, 1 h TTL, lost at restart: `lib/utils/antiDeleteHandler.js:55-56,98-127`, `config.js:193`). View-once is forwarded immediately and stores nothing. Statuses are forwarded to the first owner (commit `9239efa`); `STATUS_SAVE_FOLDER` (`config.js:69`, default `media/status`) has **no consumer** and the folder does not exist. See D3.
2. **`.update` has no rollback and can kill the bot for good.** After the pull, a failed `yarn install` returns with the new code on disk (`plugins/update.js:183-213`); with no PM2 it falls back to `process.exit(0)` and hopes something restarts the bot (`plugins/update.js:238-245`). See D1.
3. **`classifyError` cannot tell "key refused" from "service down"** (both give `service_unavailable`, `lib/utils/http.js:249-253`), and Alpha Vantage answers 200 with real data to a fake key. See D4.
4. **`PANEL_ENABLED` exists but nothing reads it** (`config.js:206`), and `config.env.example:113` ships `PANEL_ENABLED=false`; `docs/BOT_HOSTING_GUIDE.md:145` documents it as "active le mode panel". Flipping its meaning needs care. See D7.

## Decisions at a glance

| # | Topic | Decision |
|---|---|---|
| D1 | Self-update | Shared `lib/utils/updater.js`; git installs only; follow the current branch's upstream (`origin/<branch>`), never `config.BRANCH`; `fetch` -> `merge --ff-only` -> vendored Yarn install if deps changed -> smoke boot in a child -> rollback with `reset --hard prevHead` on any failure |
| D1 | Restart after update | New process needed: `process.exit(0)` only when a supervisor is detected (`pm_id`, panel host env, `SUPERVISED=true`); otherwise "restart manually" banner, no exit |
| D2 | Download tools | `yt-dlp -U`, verdict from the version before/after; variant heuristics (release script vs apt/pip stub); per-case instructions; refuse while downloads run |
| D3 | Storage | Truthful categories (statuses folder, temp media, in-memory anti-delete cache, no view-once store, database, logs); capped async walk; allow-listed purge, truncate logs, never `sessions/`, `data/`, the database |
| D4 | API key tests | Server-side, saved key only, one fixed read-only request per service, verdict `accepted/refused/unreachable`, 10 s per-service limit via `cooldown.hit`; Alpha Vantage not testable; 18 settings have no consumer |
| D5 | Update alert | Checker 2 min after `ready`, then every 6 h; one alert per greater remote `package.json` version |
| D6 | Legacy endpoints | Frozen contract, shared server for both launchers, admin under `/admin*` without CORS, contract test added |
| D7 | On by default | `PANEL_ENABLED` default true; `EXPOSE` + `/ping` healthcheck; compose `expose` (no default host publish); `PANEL_PUBLIC_URL`; port conflict never aborts the bot |
| D8 | Memory | Budget is ample (plugin-loaded baseline 167 MB RSS); bound every cache; measure with a child-process script, median of 3 |

---

### D1. Self-update of the bot (git installs only)

**What `.update` does today** (`plugins/update.js`, command `update now`, owner only):
`simpleGit({ baseDir: process.cwd() })` (:137) -> `git.status()`, refuses on tracked changes (:146-151) or detached HEAD (:153-157) -> `git fetch origin <current branch>` (:162) -> `rev-list --left-right --count HEAD...FETCH_HEAD` (:167); `behind == 0` = up to date, `ahead > 0` = diverged (:170-180) -> `git pull origin <branch> --ff-only` (:183) -> `yarn install --immutable`, timeout 5 min (:201) -> `yt-dlp -U` best effort (:216, :72-84) -> `pm2 restart open-whatsapp-bot`, else `process.exit(0)` (:238-245). A module flag `updateRunning` (:19) prevents two updates at once. No rollback, no check that the new code boots, `cwd`-dependent.

**Decision.** Extract the logic into `lib/utils/updater.js` (injectable `git`, `run`, `env`, `fs` for tests) used by both the panel and the `.update` command (the command keeps its replies and gains rollback and the shared lock). Flow:

1. **Install type** (computed once, cached): `ROOT = path.resolve(__dirname, "..", "..")` (never `process.cwd()`).
   - `git`: `ROOT/.git` exists AND `git rev-parse --show-toplevel` (realpath) equals `ROOT` AND `git --version` works. Anything else is `image` (container marker: `/.dockerenv`, or `/proc/1/cgroup` matching `docker|kubepods|containerd`, or env `container`) or `archive` (ZIP upload, `docs/BOT_HOSTING_GUIDE.md` option B). `.dockerignore:9` excludes `.git`, so Docker images are never `git`.
   - `image`/`archive` get instructions only (FR-053): `docker compose pull && docker compose up -d` (or `build --no-cache`, or "Redeploy" on Dokploy); for `archive`, re-upload the ZIP keeping `config.env`, `sessions/`, `data/`, `database.db`, then `yarn install`.
   - Git blockers, each with its own reason code shown in the UI: `no_git_binary`, `dubious_ownership` (git refuses a repo owned by another uid), `detached`, `no_remote_branch`, `dirty_tree` (`git status --porcelain --untracked-files=no`, same rule as `plugins/update.js:60-69`), `not_writable`.
2. **Branch rule.** Follow the checked-out branch's upstream (`@{u}`), else `origin/<current branch>`; never fall back to `master`, never switch branches. `config.BRANCH = "master"` (`config.js:161`) has no consumer: ignore it. This repo is the proof: local `002-admin-panel` has no upstream and no `origin/002-admin-panel`, so `git fetch origin 002-admin-panel` fails ("couldn't find remote ref") and must show `no_remote_branch`, not "network error" (the current `errorKey` maps every fetch failure to `network_error`, :96-101). Production installs on `master` simply track `origin/master`.
3. **Check** (read-only): `git fetch origin <branch>` with `GIT_TERMINAL_PROMPT=0` (no credential prompt hang; verify simple-git 4.0.2 accepts it via `.env()`), 120 s block timeout; `rev-list --left-right --count HEAD...FETCH_HEAD`; changes = `git log --no-decorate --format=%h%x09%s -n 50 HEAD..FETCH_HEAD`; remote version = `git show FETCH_HEAD:package.json` -> `version`. Show the `origin` URL only with credentials stripped (reuse `logSafe`, `plugins/update.js:54-57`) or not at all.
4. **Apply**, under one process-wide lock (`updating`), recording `prevHead = rev-parse HEAD`:
   - a. `git merge --ff-only FETCH_HEAD` (not `pull`: guarantees the commits that were listed are the ones applied). `ahead > 0` -> refuse (`diverged`).
   - b. If `git diff --name-only prevHead..HEAD` touches `package.json`, `yarn.lock`, `.yarnrc.yml` or `.yarn/releases/*`: run `process.execPath <yarnPath> install --immutable` (5 min). Resolve `yarnPath` from `.yarnrc.yml` **after** the merge (currently `.yarn/releases/yarn-4.17.0.cjs`). Do not rely on a `yarn` on PATH, as `plugins/update.js:201` does.
   - c. **Smoke test the new code** in a child: `process.execPath tools/verify-boot.js` (new, about 20 lines: require `config`, `lib/database`, run `PluginLoader.loadAll()`, assert commands > 0) with `DATABASE_URL=:memory:`, `LOG_LEVEL=silent`, 60 s timeout. Loading all plugins works offline and takes a few seconds (measured in D8). It catches a bad commit before the restart instead of after (PM2 would otherwise crash-loop, `ecosystem.config.js:24-25`).
   - d. **Any failure in a-c**: `git reset --hard prevHead` (safe: the tree was clean and the merge was fast-forward only), re-run `install --immutable` if (b) ran, report `{ phase, reason, rolledBack: true }`. Raw stderr goes to the logs through `safeLog`/`logSafe`, never to the UI. `sync()` is additive (CLAUDE.md), so older code on a newer schema is safe.
   - e. Success: record `{ from, to, versions, at }` in the admin history (FR-035) and let `restartRequired` turn true.
   - f. `yt-dlp -U` is no longer part of the code update (separate action, D2).
5. **`restartRequired` is derived, not stored**: `bootHead` (read once at boot) differs from the current `HEAD`, or the `package.json` version on disk differs from `config.VERSION`. It also catches a manual `git pull`.
6. **Restart after an update needs a NEW process** (the in-process restart of FR-013 reloads settings, not code). Supervisor detection (`lib/utils/runtime.js`, new), first match wins:
   - `process.env.SUPERVISED` (new boot setting `auto|true|false`, default `auto`) overrides everything.
   - PM2: `process.env.pm_id !== undefined` (PM2 itself relies on it, `node_modules/pm2/lib/Common.js:162`). PM2 restarts on **any** exit code unless `autorestart:false`, status stopping, or the code is in `stop_exit_codes` (`node_modules/pm2/lib/God.js:435-446`); `ecosystem.config.js:7` has `autorestart: true`.
   - Pterodactyl-style panel hosts (bot-hosting.net, assumed): env `P_SERVER_UUID` or `SERVER_MEMORY`. Wings restarts after a crash; whether a clean exit counts is host configuration (unverified), hence the override.
   - Container: `/.dockerenv` etc. The restart depends on the policy (`docker-compose.yml:4` `unless-stopped` restarts on exit 0; plain `docker run` does not). Containers are `image` installs, so this only matters for the `.update` command.
   - systemd (`INVOCATION_ID`): policy unknown, treat as unsupervised unless `SUPERVISED=true`.
   - **Supervised**: answer the browser first, then `process.exit(0)` after about 1 s (same convention as `/api/restart`, `panel.js:268-271`); `.update` keeps `pm2 restart` as a fast path when `pm_id` is set.
   - **Unsupervised**: do NOT exit (the bot would die and stay dead). Show "Update installed (X -> Y). Restart the bot manually to load it" with a persistent banner driven by `restartRequired`, and require a checkbox "I will restart it myself" before applying.
   - A self-respawn (`spawn(process.execPath, argv, { detached })`) is rejected: it fails under Docker and Pterodactyl (the container dies with PID 1) and needs a port and session hand-over.

**Panel API shape**: `GET /…/maintenance/update` returns `{ installType, canSelfUpdate, blockers[], branch, behind, ahead, localVersion, remoteVersion, commits[], checkedAt, restartRequired, supervised }`; `POST …/update/check` (rate limit 1 per 30 s) and `POST …/update/apply` (CSRF + confirm) start a job; progress through the same live channel as the dashboard (phases `fetch|merge|install|verify|done|failed`).

**Rationale.** Reuses the proven logic, adds exactly what FR-053 requires (a failed update leaves the bot on the current version) and what the audit lacked (rollback, smoke test, branch-aware errors).
**Alternatives considered.** (a) `git pull` + `yarn` unchanged, no rollback: violates FR-053. (b) Stash/reset local changes automatically: data-loss risk, rejected, show `dirty_tree` instead. (c) Run `yarn test` as smoke test: 10 s and fails on unrelated test changes; `verify-boot` is narrower. (d) Install into a staging directory and swap: safest, but doubles disk and breaks `.git` semantics. (e) Always `process.exit`: kills unsupervised bots.
**Evidence.** `plugins/update.js:19,54-84,137-244`; `config.js:161`; `.dockerignore:9`; `docs/BOT_HOSTING_GUIDE.md:40-46` (clone vs ZIP upload); PM2 sources above; `git rev-parse --abbrev-ref @{u}` fails on this branch; `git branch -r` has no `origin/002-admin-panel`.
**Files impacted.** New `lib/utils/updater.js`, `lib/utils/runtime.js`, `tools/verify-boot.js`; edit `plugins/update.js` (thin client of the updater, keeps `plugins.update.*` keys, adds `no_remote_branch`/`rolled_back` keys in `lang/en.json` and `lang/fr.json`), `config.js` (`SUPERVISED`), `test/updater.test.js` (temp bare repo + clone, no network: up to date, behind, diverged, dirty, no remote branch, install failure with injected `run` -> rollback, smoke failure -> rollback), `test/runtime.test.js`.

---

### D2. Download tools update (yt-dlp)

**Facts.** Docker: official release script downloaded to `/usr/local/bin/yt-dlp` (`Dockerfile:14-16`), python3 installed (:7), container runs as root (no `USER`), so `yt-dlp -U` can rewrite it. Local/VPS: whatever the owner installed. On this machine it is the **apt** package: `/usr/bin/yt-dlp` is a 205-byte python stub, version `2024.04.09` (stale, exactly the failure the Dockerfile comment warns about). yt-dlp's own updater decides by variant (`/usr/lib/python3/dist-packages/yt_dlp/update.py:116-126`): `zip` (release script) and `*_exe` (PyInstaller binaries) are self-updatable; pip/apt/pipx/apk installs are `unknown` and `-U` fails with `ERROR: You installed yt-dlp from a manual build or with a package manager; Use that to update` (exit 1, `_download_retcode`); a read-only file/dir gives a permission message. `--version` prints no variant and `-v` prints no header without a URL, so variant cannot be read from the CLI cheaply.

**Decision.**

- **Detect** (informational, before the click): resolve the binary like `downloader.js` (`config.YTDLP_PATH`, :54), then `fs.stat` + read the first 512 bytes. ELF magic or size > 1 MB with a python shebang -> `selfUpdatable: "likely"` (release script / PyInstaller). Small python stub (< 4 KB) or path under a package-managed prefix -> `"no"` (apt/pip). Missing -> `"missing"`. Not writable (`fs.access W_OK` on file and dir) -> `"no"` with reason `read_only`.
- **Apply**: `execFile(binary, ["-U"], { timeout: 60 s })`, same as `updateYtDlp` (`plugins/update.js:72-84`); `.update` then calls the shared function instead of its own copy.
  - The verdict comes from the **version before/after** (`downloader.resetCache(); await isAvailable(); getVersion()`, `downloader.js:166,191,196`), not from parsing stdout.
  - Version changed -> `updated`. Unchanged and exit 0 -> `up_to_date`.
  - Exit != 0 with stderr matching `/package manager|manual build|unofficial build/i` -> `managed_externally`; `/permission|Unable to write/i` -> `read_only`; network codes -> `unreachable`; anything else -> `failed`. Stderr goes to the logs only.
- **Messages per outcome**:
  - `managed_externally`: "yt-dlp is managed by your system. Update it with `sudo apt install --only-upgrade yt-dlp`, `pipx upgrade yt-dlp` or `pip install -U yt-dlp`, or install the official binary and set `YTDLP_PATH`: `curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ~/.local/bin/yt-dlp && chmod a+rx ~/.local/bin/yt-dlp`." (distro packages lag behind and the extractors break.)
  - `read_only` (for example a read-only root filesystem): rebuild the image or fix the permissions.
- **Docker caveat to display**: the update lives in the container's writable layer. It is lost when the container is recreated, and `docker build` reuses the cached `latest` layer unless `--no-cache`. Possible later improvement: keep a copy under the `bot_data` volume and point `YTDLP_PATH` at it.
- **Concurrency**: refuse while `activeDownloads > 0` and block new downloads during the update. The counter is module-private (`downloader.js:239-240`): export `getActiveDownloads()` and a `setMaintenance(true)` flag that makes `download()` throw `YTDLP_BUSY` (already classified `rate_limited`, `http.js:238`). The zip variant is replaced in place, which could break a running download.
- Latest-version display is optional: one `fetchJson("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")` (unauthenticated, 60 requests/h per IP), cached 6 h, compare `tag_name` with `--version`.

**Rationale.** `-U` is the only supported mechanism; the version diff is locale-proof and version-proof. **Alternatives.** Panel downloads the binary itself into `data/bin` with SHA2-256SUMS check: solves apt/Docker persistence but adds supply-chain code and a download-and-exec path, deferred. Parse `-U` stdout: brittle across yt-dlp versions. `pip install -U` from the panel: rejected (arbitrary package-manager execution).
**Evidence.** `Dockerfile:5-16`, `downloader.js:54,158-198,239-240`, `plugins/update.js:72-84`, local `/usr/bin/yt-dlp`, yt-dlp `update.py:116-126`, `__init__.py:971-985`.
**Files impacted.** New `lib/utils/ytdlpUpdate.js` (or inside `updater.js`); edit `lib/utils/downloader.js` (`getActiveDownloads`, maintenance flag), `plugins/update.js` (call the shared function), tests with a fake executable script.

---

### D3. Storage usage and purge

| Category (spec) | What really exists | Measure | Purge |
|---|---|---|---|
| Saved statuses | Nothing is written. `data/status_save.json` is the watch list and switch, not media (`lib/utils/statusListStore.js:9-20`). `STATUS_SAVE_FOLDER` is a vestige. | folder `STATUS_SAVE_FOLDER` if it exists, else 0 | delete children of that folder; **never** `data/status_save.json` |
| Temp media | `media/temp` (legacy, one leftover file today, `.gitignore`, `.dockerignore`) and crash leftovers in `os.tmpdir()`: `owb-*` (`lib/utils/media.js:29`), `voice-*` (`lib/utils/ffmpeg.js:142`), normally removed in `finally` | walk both | children of `media/temp`; tmp dirs matching `^(owb\|voice)-` older than 15 min and owned by our uid |
| Anti-delete | In-memory cache only | entry count (+ rough text size), unit "messages" | new `antiDeleteHandler.clearCache()` (`messageCache.clear()`), confirmation warns that deleted messages of the last hour can no longer be recovered |
| View-once | No storage | show "nothing stored" | none |
| Database | SQLite file (+`-wal`, `-shm`, `-journal` siblings) or Postgres | `DATABASE.getDialect()`; SQLite: `stat` of `DATABASE.options.storage` (skip `:memory:`); Postgres: `SELECT pg_database_size(current_database())` (`QueryTypes.SELECT`, string bigint) | never (spec) |
| Logs | `logs/*.log` written by PM2 only (`ecosystem.config.js:14-16`); Docker uses stdout, so 0 | walk `ROOT/logs` | **truncate** (`fs.truncate(file, 0)`), not unlink: PM2 holds the descriptors, unlink would not free the space |

Also show free disk (`fs.statfs(ROOT)`, Node >= 18.15).

**Decision on honesty vs. spec wording.** Report what exists (table above) and label the anti-delete row "memory (temporary cache)". Do not invent archives (spec section "Assumptions" already puts message contents out of scope, only size and purge are offered). Needs the user's confirmation (open question 1).

**Measuring cheaply**: `fs.opendir` iterative walk with `lstat` (never follows symlinks), limits 50 000 entries, depth 4, 2 s budget, `setImmediate` every 200 entries so the bot's event loop is never starved; result `{ bytes, files, truncated }` (UI shows "at least" when truncated); cached 30 s per category, "Refresh" limited to 1 per 5 s; run lazily when the storage page is opened, never in a timer.

**Purge safety rules** (shared helper `lib/utils/safeFs.js`):

- The request carries only a category id plus confirmation; paths come from constants. The one configurable path, `STATUS_SAVE_FOLDER`, is validated at **save time and again at purge time**: resolved against `ROOT`, must be a strict descendant of `ROOT/media` or `ROOT/data`, must not equal or contain `sessions`, `db`, `data/status_save.json`, `config.env`, `database.db`, `lib`, `plugins`, `node_modules`, `.git`, `.yarn`; must exist as a real directory (`lstat`, not a symlink); `realpath` must still start with `realpath(ROOT) + sep`.
- Delete only **children** of the target (never the target), `lstat` each entry: a symlink is unlinked itself and never followed, directories removed with `fs.rm(recursive)` only when they are real directories. Skip `.gitkeep`. For `media/temp` skip entries modified in the last 60 s.
- Never touch `sessions/` (deleting it unlinks the device), `data/`, `media/` root (tracked assets `black.jpg`, `welFolder`, ...), or the database file. Return `{ freedBytes, removed, skipped }`; one purge at a time per category; history entry (FR-035).

**Alternatives.** Add real archives so the categories are meaningful: out of scope and contradicts the privacy assumption. Store sizes in the DB: unnecessary. Use `du` through a shell: forbidden style (execFile only) and platform-dependent.
**Evidence.** `config.js:69`, `statusListStore.js:9-20`, `antiDeleteHandler.js:55-56,98-127`, `models/AntiDelete.js`, `models/ViewOnce.js`, `media.js:29`, `ffmpeg.js:142`, `ecosystem.config.js:14-16`, `.gitignore`, `git log -S STATUS_SAVE_FOLDER` (`9239efa`), `config.js:16,21` (database selection).
**Files impacted.** New `lib/panel/storage.js` and `lib/utils/safeFs.js`; edit `lib/utils/antiDeleteHandler.js` (two small methods); settings validator for `STATUS_SAVE_FOLDER`; `test/storage.test.js` (temp dir as injected root, symlink escape, `..`, protected names, truncate keeps inode, SQLite sibling files).

---

### D4. API key tests (FR-022)

**Decision.** `POST …/settings/keys/:service/test` with **no key in the request**: the server reads `config[KEY]` (panel value wins) at call time, performs one fixed read-only request through `fetchJson(url, { timeoutMs: 10000 })` (axios, errors already scrubbed by `scrubError`, `http.js:27`), and answers only `{ verdict, detail?, checkedAt }`. Rate limit per service with the existing helper: `cooldown.hit("panel", "keytest:" + service, 10000)` (`cooldown.js:31`; non-zero = remaining ms, answer 429 with `retryAfterMs`). Never forward or log the upstream body or message (OpenAI echoes a masked key in its 401 body: observed `sk-FAKEF***FAKE`); log with `safeLog` only.

**Verdict mapping** (`lib/utils/http.js` gets a small exported `isAuthFailure(err)` extracted from the condition at :249, plus `statusOf(err)`; `classifyError` is refactored to call it, behaviour unchanged):

| Outcome | Verdict |
|---|---|
| 2xx and expected body | `accepted` |
| 400/401/403 on these fixed requests (per-service list below) | `refused` |
| 429, or a quota body (OpenAI `insufficient_quota`, NewsAPI `rateLimited`, vendor quota codes) | `accepted` + `detail: "quota"` (the key was recognised) |
| no response, `ENOTFOUND`/timeouts/TLS, 5xx, 408, HTML page (`ERR_BAD_RESPONSE_FORMAT`), `classifyError` = `service_unavailable` without a refusal status | `unreachable` |

**Services.** "Observed" = confirmed today with a fake key; others from the plugin code or vendor docs (unverified).

| Setting(s) | Used by | Test request | Accepted | Refused | Notes |
|---|---|---|---|---|---|
| `OPENAI_API_KEY` | `gpt` (`plugins/chatgpt.js:76`), `transcribe` (`voice.js:117`) | `GET https://api.openai.com/v1/models`, `Authorization: Bearer` | 200 | 401 `invalid_api_key` (observed) | 429 `insufficient_quota` -> accepted/quota |
| `GEMINI_API_KEY` | `gemini` (`gemini.js:92`), `imagen` (`imagen.js:45`), auto responder (`autoResponderHandler.js:37`) | `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1`, header `x-goog-api-key` (keeps the key out of the URL) | 200 | **400** `INVALID_ARGUMENT` / `API_KEY_INVALID` (observed); 403 `PERMISSION_DENIED` | axios message is generic, so classify on status, not on `AUTH_MESSAGE_RE` |
| `WEATHER_API_KEY` | `weather` (`weather.js:67`, Open-Meteo fallback without key) | `GET https://api.weatherapi.com/v1/current.json?key=K&q=Paris&aqi=no` | 200 | 401 code 2006 (observed) | 403 code 2007 = quota -> accepted/quota; 2008/2009 = refused (docs) |
| `NEWS_API_KEY` | `news` (`news.js:91`) | `GET https://newsapi.org/v2/top-headlines/sources`, header `X-Api-Key` | 200 | 401 `apiKeyInvalid` (observed) | costs 1 of 100 daily calls; 429 `rateLimited` -> quota |
| `UNSPLASH_API_KEY` | `image` (`imagesearch.js:91`) | `GET https://api.unsplash.com/search/photos?query=test&per_page=1`, `Authorization: Client-ID K` | 200 | 401 (observed) | 403 "Rate Limit Exceeded" -> quota (docs); demo apps 50/h |
| `GIPHY_API_KEY` | `gif` (`imagesearch.js:44`) | `GET https://api.giphy.com/v1/gifs/trending?api_key=K&limit=1` | 200 | 401 (observed) | key must be in the query string; 429 -> quota |
| `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` | `music spotify` (`music.js:35-48,189`) | `POST https://accounts.spotify.com/api/token`, body `grant_type=client_credentials`, `Authorization: Basic base64(id:secret)` | 200 with `access_token` (discard it) | 400 `invalid_client` (observed); 401 | no quota; test both values together |
| `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | `reddit` (`reddit.js:46-60`) | `POST https://www.reddit.com/api/v1/access_token`, same body, Basic auth, **plugin's `User-Agent`** (`reddit.js:24`) | 200 with `access_token` | 401 (observed); 200 with an `error` field (`reddit.js` comment) | datacenter IPs often get 403/429 without a clear body: map 429 and a non-JSON 403 to `unreachable`; export the UA/URL constants from the plugin or move them to a shared module |
| `ALPHA_VANTAGE_KEY` | `stock` (`news.js:187`) | none | n/a | n/a | **Not verifiable**: `GLOBAL_QUOTE` with key `fakefakefake` returned HTTP 200 and real quotes for IBM and MSFT (observed). Hide the test button, tooltip "this service does not validate keys on this endpoint". |

**Unused settings (no consumer in `lib/`, `plugins/`, `index.js`, `panel.js`; only `test/helpers/fakes.js` mentions them): candidates to hide the test button and mark "no effect"**: `GROQ_API_KEY`, `RMBG_KEY` (no `rmbg` plugin; only `app.json` mentions it), `CLOUDMERSIVE_API_KEY`, `APYHUB_API_KEY`, `DEEPAI_API_KEY`, `WAIFUPICS_API_KEY`, `PUTERJS_API_KEY`, `HEROKU_APP_NAME`, `HEROKU_API_KEY`, `KOYEB`, `KOYEB_NAME`, `KOYEB_API`, `RENDER_NAME`, `RENDER_API_KEY`, `IMAGE_API_TIMEOUT`, `IMAGE_API_MAX_SIZE_MB`, `VPS`, `SESSION_ID` (read at `config.js:52`, no consumer). SC-002 says 100 % of the example's settings appear, so keep them in a collapsed "legacy, no effect" group instead of dropping them. `BACKEND_URL` is not a key (optional fallback of `dl`, `socialdl.js:50-59`).

**Alert hook for "key refused" (FR-060/061).** Plugins already call `classifyError(error, { hasKey })` in their catch blocks (e.g. `chatgpt.js:120`, `weather.js:225`). Add an optional `service` option: when it is set and `isAuthFailure(err)` with `hasKey !== false`, `classifyError` emits `keyRefused(service)` on a tiny EventEmitter exported by `http.js`; the alerts module subscribes and applies the once-per-service-per-24 h limit. One-line change per plugin (about 8 call sites); no periodic self-test (it would burn quotas).

**Rationale.** Fixed requests keep the surface small and side-effect free; routing everything through `fetchJson` reuses timeouts, size caps and scrubbing. **Alternatives.** Use the vendor SDKs (more code paths, own timeouts, errors not scrubbed). Test a key typed in the form before saving (the browser would send secrets back; FR-022 says "enregistree"). Probe each service with a random key to detect "accepts anything": costs quota.
**Files impacted.** `lib/utils/http.js` (`isAuthFailure`, `statusOf`, emitter, `service` option), new `lib/panel/keyTests.js` (table-driven), plugins above (one-line `service`), `test/keytests.test.js` (stub axios adapter like `fakes.stubNetwork`: each verdict, secret never in output, 10 s limit).

---

### D5. Trigger of the "update available" alert (FR-060/061)

**Decision.** A checker in `lib/utils/updater.js`: first run 2 min after `ready` (not at boot, to avoid fetching during crash loops), then every 6 h with jitter, `unref()`, started from an idempotent `start()` (never at `require` time, see D6). Sources: `git` installs: the D1 check (fetch + `package.json` of `FETCH_HEAD`); `image`/`archive`: one `fetchJson("https://raw.githubusercontent.com/Starland9/OpenWhatsappBot/master/package.json")` (repo constant already in `panel.js:217`; boot switch `UPDATE_CHECK=false` turns it off; default on). Compare numeric `major.minor.patch`. The alert fires once per **remote version greater than the local one**; commits without a version bump only show a badge on the page (otherwise a commit-per-step workflow would alert dozens of times). Persist `lastAlertedVersion` with the other alert state. The checker and "apply" share the git lock.
**Alternatives.** Alert per new commit SHA (noisy). GitHub Releases API (the repo may not publish releases). Check on every dashboard load (needless fetches).
**Files impacted.** `lib/utils/updater.js`, alerts module (other research), `config.js` (`UPDATE_CHECK`).

---

### D6. Existing endpoints must keep working (FR-011, SC-010)

**Contract to freeze** (all served by `panel.js:83-120` today, CORS `*` on everything, `panel.js:70-73`):
`GET /`, `/health`, `/healthz` -> 200/503 JSON `{ status, botStatus, connected, timestamp }`; `/status` -> `{ status, connected, uptime, uptimeFormatted, version, messagesProcessed, lastActivity, memory, timestamp }`; `/ping`; `/metrics`; `/api/info`; `POST /api/restart` -> 403 without `PANEL_TOKEN`, 401 without the bearer, 405 for other methods, 200 then **`process.exit(0)` after 1000 ms** (`panel.js:246-272`); `OPTIONS` -> 200; any other path -> 200 HTML status page. `test/panel.test.js:62-137` pins the restart behaviour and `:143-159` pins "no token, owner number, session or path in any public body" (including `/` and `/unknown`).

**Decision.**

- Move the legacy server (routes, `botState`, counters, the `ready`/`close` wiring that only `panel.js` has, `panel.js:534-554`) into a shared module used by BOTH launchers; `panel.js` keeps exporting `createServer` and `botState` (`panel.js:664`) so the tests stay untouched. Admin routes mount under a dedicated prefix (recommended `/admin` for pages and `/admin/api/*`); never on `/`, `/status`, `/api/*` legacy paths or the catch-all. Monitors pinging `/` (bot-hosting keep-alive, uptime services) would otherwise start getting an HTML 200 instead of the 503 they rely on.
- CORS `*` stays on legacy routes only. `/admin*` must send no `Access-Control-Allow-Origin` and must not answer preflights positively (FR-008 CSRF defence).
- The legacy `/api/restart` keeps exiting the process; the panel's in-process restart is a different code path. Document both.
- No bot number, token or path in any legacy body (the dashboard gets them from authenticated `/admin/api`).
- All new timers (update checker, alert timers, session sweeper, stats flush) are created in `start()` and `unref()`'d: `test/panel.test.js:27-39` requires `panel.js` and only patches `setInterval` while requiring.
- Add a contract test (new test in `test/panel.test.js` or `test/panel-legacy.test.js`) asserting status codes, exact key sets and `Content-Type` of every legacy route, so the refactor cannot silently drop a field. Gate for SC-010: `yarn test`, `node tools/check-unused-deps.js` ("0 unused dependencies"), plus this contract test.
- Keep `panel.js`'s shutdown (`panel.js:574-610`: close server, `client.stop()` without logout, close DB) and reuse it for `index.js`. Today `index.js` handles no SIGTERM/SIGINT (`index.js:21-36`): under Docker (node is PID 1) `docker stop` waits 10 s then SIGKILLs, and `pm2 restart` waits `kill_timeout: 5000` (`ecosystem.config.js:19`). The shared handler fixes both; `test/panel.test.js:356-366` still forbids `.logout(` in both launchers.

**Alternatives.** Put the admin UI on `/`: breaks monitors. Separate admin port: contradicts "served at the status server's address" (Assumptions). **Evidence.** as cited. **Files impacted.** New `lib/panel/server.js` (or similar), `panel.js`, `index.js`, `test/panel.test.js` (additions only).

---

### D7. Deployment and ops impact of the panel on by default (FR-039)

- **Setting.** Keep the name `PANEL_ENABLED` (already in `config.js:206`, the example and the docs) but make it default **true** when unset/empty: `process.env.PANEL_ENABLED !== "false"`. This deviates from the "true only for the exact string" convention (CLAUDE.md) and must be commented in `config.js`. Anyone who copied `config.env.example` has `PANEL_ENABLED=false` and keeps the panel off (fail closed); the console must print one line either way ("Panel disabled by PANEL_ENABLED=false" / the URL). Update the example to `PANEL_ENABLED=true`. Alternative `PANEL_DISABLED=true`: no ambiguity with old files, but a second name for the same idea.
- **Bind and port.** `config.js:202-204` keeps `PANEL_PORT || PORT || 3000` and host `PANEL_HOST || HOST || 0.0.0.0`. Add `SERVER_PORT` (Pterodactyl's allocated port) as a last fallback before 3000 (optional). `server.listen` has no `error` handler today (`panel.js:641`): add `server.once("error")`; on `EADDRINUSE`/`EACCES` log "Panel disabled: port N unavailable (set PANEL_PORT)" and continue without panel (FR-039). When neither `PANEL_PORT` nor `PORT` is set (local dev, where 3000 is often taken), try up to 10 following ports and print the real URL; with an explicit port, never drift. Default host for the **normal** mode on a bare machine is a decision for the user (question 3).
- **Setup link** printed in the console needs a reachable base: new optional `PANEL_PUBLIC_URL` (reverse proxy, Dokploy domain), else `http://localhost:<port>`.
- **Dockerfile** (no `EXPOSE`, no `HEALTHCHECK` today, `Dockerfile:31`): add `EXPOSE 3000` and `HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "..."` calling **`/ping`**, not `/health`: `/health` returns 503 while the bot is not paired (`panel.js:129-137`), and an orchestrator that restarts "unhealthy" containers would make first pairing impossible. The check must succeed when `PANEL_ENABLED=false` (exit 0 without calling) and use `PANEL_PORT || PORT || 3000`. `.dockerignore` already excludes `.git`, `specs`, `test`, `docs`.
- **docker-compose.yml** (`restart: unless-stopped`, volumes `bot_sessions`, `bot_db`, `bot_data`): add `expose: ["3000"]` and a commented `ports: ["127.0.0.1:3000:3000"]` with an explanation. Do not publish by default: the comment at `docker-compose.yml:5` shows Dokploy deployments, and Dokploy's own dashboard listens on host port 3000 (from memory, unverified), so a default publish could make `up` fail on existing installs. Reverse-proxy installs need only `expose`. The README `docker run` example (`README.md:326-333`) lacks `-p` and `--restart unless-stopped`: add both.
- **PM2.** No config change needed: `ecosystem.config.js` runs `index.js`, which now also listens. `max_memory_restart: 500M` and `--max-old-space-size=512` stay (D8). `yarn start` = `pm2 start . --attach --name open-whatsapp-bot` (`package.json`); `heroku.yml` runs `npm start` as a **worker** dyno (no `PORT`, panel unreachable but harmless).
- **bot-hosting.net / panel hosts.** `node panel.js` keeps working unchanged; `node index.js` there now serves the same endpoints too, which helps hosts that expect a listening port (assumed, host dependent). QR is viewable in the panel (the guide's step 6 says "read the logs").
- **Docs to update**: `README.md` (Features, Quick Start step 4, Bot-Hosting block `:282-316` incl. "Edit config.env with PANEL_ENABLED=true", Docker block `:326-333`, new "Admin panel" section), `docs/BOT_HOSTING_GUIDE.md` (setup `:78`, step 6 `:97`, table "Différence entre index.js et panel.js" `:120-129` (HTTP server now in both), variables table `:141-150`, endpoints `:193`, restart `:268`), `config.env.example:110-119` (new `PANEL_PUBLIC_URL`, `SUPERVISED`, `UPDATE_CHECK`, `PANEL_ENABLED` default), `CLAUDE.md` (Commands `yarn panel` line, "Boot and client": both launchers now start the HTTP server), `docs/AUDIT_COMMANDES.md` (`update` row, `/api/restart` row at `:482`), `docs-site/js/components.js:728-735` (static SPA, low priority), `app.json` (optional `PORT`).

**Files impacted.** `Dockerfile`, `docker-compose.yml`, `config.js`, `config.env.example`, `index.js`, `panel.js`, docs above, `test/helpers/fakes.js` (add `PANEL_ENABLED` handling so tests never bind a port by accident).

---

### D8. Memory (SC-009) and how to measure the panel's overhead

**Current profile.** `memoryManager.js:11-14,30-50`: every 15 min (`config.js:197-198`) `gc()` if `--expose-gc`, log RSS/heap, warn above `MEMORY_WARN_THRESHOLD` = 400 MB heapUsed (`config.js:199`). PM2: `max_memory_restart: '500M'`, `--max-old-space-size=512 --expose-gc` (`ecosystem.config.js:9-10`). Docker: `--expose-gc` only (`Dockerfile:31`). Measured today (fresh process, `--expose-gc`, forced GC, in-memory SQLite, no WhatsApp socket, test env helper): node + helpers 73 MB RSS / 12 MB heap; + all plugins loaded **167 MB RSS / 55 MB heap**; + an empty `http` server 168 MB / 55 MB. A connected bot is higher (Baileys state), so 50 MB is about a third of the plugin-loaded baseline: ample for a no-build panel, but only if these stay bounded:

- static assets served from disk with streams or a small LRU (<= 1 MB total), no duplicate copies in memory;
- one admin: session `Map` capped (e.g. 20), SSE clients capped (e.g. 10), log ring buffer 1 000 entries, stats counters 7 days, history paged from the DB;
- request body cap (64 KB JSON); backup restore streamed to a temp file, never buffered (a 50 MB upload is a peak that PM2's 500M limit sees);
- QR rendered on demand (`qrcode` is already a dependency, `package.json`);
- password hashing: `crypto.scrypt` with N=2^15, r=8 needs ~32 MiB and exceeds Node's default `maxmem`; run **one hash at a time** (the 5 failures/15 min limit helps) and measure RSS **after** a login, since glibc/musl may not give the pages back immediately. This is transient, not idle, but it can raise the steady RSS.

**Protocol (script, not part of `yarn test`).**
`tools/measure-panel-memory.js` spawns `node --expose-gc tools/panel-memory-child.js <baseline|panel>` three times each with `DATABASE_URL=:memory:`, `LOG_LEVEL=silent` and the secret variables blanked (same as `fakes.setupEnv`, so it never reads `config.env`). Child: load config, sync DB, `PluginLoader.loadAll()`; for `panel` additionally start the panel on port 0, create the admin, log in, fetch every page and read-only API once, open one SSE stream, idle 20 s; then `gc()` twice and print `process.memoryUsage()` as JSON (and one extra sample right after the login). Parent prints medians and exits non-zero when `rss(panel) - rss(baseline) >= 50 MB`. A `node:test` wrapper runs it only when `MEASURE_MEMORY=1` (about 1 minute). The always-on automated guard is structural: assert caps (ring buffer length, session and SSE limits) and that the panel creates no un-`unref`'d timer. In production the dashboard already shows `process.memoryUsage()`.

**Files impacted.** New `tools/measure-panel-memory.js`, `tools/panel-memory-child.js`, `test/panel-memory.test.js` (skipped unless `MEASURE_MEMORY=1`).

---

## Open points for the user

1. **Storage categories (D3).** The spec's "anti-delete archive" and "view-once archive" do not exist as stored data, and "saved statuses" has no folder in use. Options: (a) show truthful categories (statuses folder if present, temp media, in-memory anti-delete cache, no view-once row, database, logs) **recommended**; (b) build real archives (new feature, privacy implications); (c) hide empty categories.
2. **Update without a supervisor (D1).** If neither PM2, a known panel host nor a container is detected: (a) apply the update but do not exit, show "restart manually" and a persistent banner **recommended**; (b) refuse to update; (c) self-respawn (not workable under Docker/Pterodactyl).
3. **Default bind in normal mode (D7).** `index.js` never had an HTTP server. Options: (a) `0.0.0.0` everywhere (simple; the setup link and the password protect it, FR-009 warns on plain HTTP); (b) `127.0.0.1` for `index.js` unless `PANEL_HOST`, `PORT`, a container or a panel host is detected, `0.0.0.0` kept for `panel.js` **recommended** (a fresh `yarn dev` is not exposed to the LAN).
4. **`PANEL_ENABLED` semantics (D7).** Keep the name with default true (old example copies stay off, fail closed) **recommended**, or introduce `PANEL_DISABLED`.

## Consolidated file impact (for the plan's project structure)

| Area | New | Edited |
|---|---|---|
| Update and runtime | `lib/utils/updater.js`, `lib/utils/runtime.js`, `lib/utils/ytdlpUpdate.js` (or inside the updater), `tools/verify-boot.js` | `plugins/update.js`, `lib/utils/downloader.js`, `config.js` (`SUPERVISED`, `UPDATE_CHECK`, `PANEL_PUBLIC_URL`, `PANEL_ENABLED` default), `lang/en.json`, `lang/fr.json` |
| Storage | `lib/utils/safeFs.js`, `lib/panel/storage.js` | `lib/utils/antiDeleteHandler.js` (`clearCache`, `getCacheStats`), settings validator for `STATUS_SAVE_FOLDER` |
| Key tests and alert hook | `lib/panel/keyTests.js` | `lib/utils/http.js` (`isAuthFailure`, `statusOf`, `service` option, emitter), about 8 plugins (`service` option), `plugins/reddit.js` (export UA and token URL) |
| Server and ops | shared server module under `lib/panel/` | `panel.js`, `index.js` (shared shutdown), `Dockerfile`, `docker-compose.yml`, `config.env.example`, `README.md`, `docs/BOT_HOSTING_GUIDE.md`, `CLAUDE.md`, `docs/AUDIT_COMMANDES.md` |
| Tests and tools | `test/updater.test.js`, `test/runtime.test.js`, `test/storage.test.js`, `test/keytests.test.js`, `test/panel-memory.test.js`, `tools/measure-panel-memory.js`, `tools/panel-memory-child.js` | `test/panel.test.js` (additions only), `test/helpers/fakes.js` |

All new tests must stay offline (local temp git repositories, stubbed axios adapter, fake executables) so `yarn test` keeps its roughly 10 s and "no network, no WhatsApp" promise.
