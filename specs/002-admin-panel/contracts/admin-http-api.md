# Contract: admin HTTP API

Feature `002-admin-panel`. Inputs: [spec.md](../spec.md) (FR-001 to FR-064, US1 to US13), [research.md](../research.md) (**authoritative**: U1 to U19, R1 to R5, C1 override the stream files), research streams B (web layer, security), A (runtime), C (data, jobs), D (maintenance), [data-model.md](../data-model.md), and [settings-catalog.md](settings-catalog.md) (keys, validation, the `ResolvedSetting` view quoted below). House style: the 001 contracts.

All server code behind this contract lives under `lib/admin/` (R1): `lib/admin/http/router.js`, one file per area in `lib/admin/routes/`, static assets in `lib/admin/public/`. Engines the routes call (`settingsStore`, `alerts`, `updater`, `broadcaster`, `logger`, `audit`...) stay in `lib/utils/` or `lib/core/` and never import `lib/admin`.

Legend used in the route tables: **Auth** `public`, `setup`, `session` (section 1.3); **CSRF** `yes` (full guard of section 1.6), `origin` (pre-session routes: guard steps 2, 3 and 5 only, no CSRF header exists yet), `no` (safe methods); **Flags** `touch:n` (the route does not extend the session idle clock), `confirm` (server-enforced confirmation, section 1.10), `db:r` (still answers without the database, section 1.14), `job` (answers `202` with a job, section 1.16).

---

## 1. Conventions

### 1.1 Mounting, namespaces, activation

- One `http.Server` is built by `lib/admin/server.js#createPanelServer()` and used by **both** launchers (`index.js` and `panel.js`). `panel.js` keeps exporting `createServer` and `botState`. Dispatch is `admin.handle(req, res) || legacy(req, res)`.
- `admin.handle` claims a request only when `pathname === "/admin"` or `pathname.startsWith("/admin/")`. Everything else, including `/administrator`, `/adminfoo` and every legacy path, reaches the legacy code unchanged (section 1.2). The admin namespace never falls into the legacy catch-all.
- Namespaces: `/admin/` (static single-page app, hash routes such as `/admin/#/groups`, so the server needs no history fallback), `/admin/setup` (one-time link landing), `/admin/api/*` (JSON). Under `/admin`: no CORS header ever, `OPTIONS` answers `405`, every non-2xx answer is the JSON envelope of section 1.9 (including static misses and `404`/`405`).
- `GET /admin` answers `308 Location: /admin/`.
- Activation (U2): `ADMIN_PANEL` (default `true`, off only for the exact string `false`). When off, `index.js` starts no HTTP server (as today); `panel.js` keeps its legacy server and `/admin*` answers `404 not_found`. The legacy `PANEL_ENABLED` is ignored (U18: one console warning at boot when it is still set; it never switches anything).
- Listening (U1): host and port come from `PANEL_HOST` / `PANEL_PORT` (see the catalog: auto bind address). A listen failure (`EADDRINUSE`, `EACCES`, `EADDRNOTAVAIL`) never stops the bot: one console error names `PANEL_PORT`, `PANEL_HOST` and `ADMIN_PANEL=false` (FR-040).
- Server limits: `headersTimeout` 15 s, `maxHeadersCount` 50, Node's default `requestTimeout` (300 s, enough for a 230 MB upload at about 6 Mbps), `maxConnections` 256, `closeAllConnections()` on close (open SSE sockets would otherwise block `server.close`).

### 1.2 Legacy routes (frozen, FR-011, SC-010)

Moved verbatim from `panel.js` into the shared server. Pinned by `test/panel.test.js` (lines 62 to 159) plus a new legacy contract test asserting status code, exact key set and `Content-Type` of each row. A legacy body never contains a token, an owner number, a session id or a path.

Matching is the current one: **exact equality on the raw `req.url`** (a query string defeats it: `/health?x=1` falls to the catch-all), method ignored except for `/api/restart`.

| Request | Behaviour (today) |
| --- | --- |
| `OPTIONS` on any non-`/admin` path | `200`, empty body, CORS headers |
| `GET /`, `/health`, `/healthz` (any method) | `200` when `botState.status === "running" && isConnected`, else `503`; JSON `{ status: "healthy" or "unhealthy", botStatus, connected, timestamp }` |
| `/status` | `200` JSON `{ status, connected, uptime, uptimeFormatted, version, messagesProcessed, lastActivity, memory, timestamp }` |
| `/ping` | `200` JSON `{ pong: true, timestamp, latency: 0 }` |
| `/metrics` | `200` JSON `{ bot: { status, connected, uptime, version, messagesProcessed }, system: { memory: { heapUsed, heapTotal, rss, external }, memoryUnit: "MB", nodeVersion, platform, arch }, timestamp }` |
| `/api/info` | `200` JSON `{ name, version, prefix, repository, documentation, features }`; same key set, `prefix` now reads the live `config.PREFIX` (the module constant of `panel.js:40` was stale) |
| `POST /api/restart` | `403 { error: "Restart endpoint disabled: PANEL_TOKEN is not configured" }` when `PANEL_TOKEN` is empty; `401 { error: "Unauthorized" }` plus `WWW-Authenticate: Bearer` without the right `Authorization: Bearer <PANEL_TOKEN>` (scheme case-insensitive, token trimmed, constant-time compare of SHA-256 digests); `200 { message: "Bot restart initiated", timestamp }` then `process.exit(0)` 1000 ms later. `PANEL_TOKEN` is read per request |
| `/api/restart` with another method | `405`, `Allow: POST`, `{ error: "Method not allowed" }` |
| any other path, any method | `200 text/html`, the status page |

Headers on every legacy answer: `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type`, default `Content-Type: application/json`. They are **kept as they are, including on `/api/restart`**: research B5 proposed dropping the wildcard there, but research.md and D6 require byte compatibility and the header is harmless (the endpoint is Bearer-based, no cookie). The legacy restart (`process.exit(0)`, needs a supervisor) is a different code path from the panel's in-process restart `POST /admin/api/restart` (RST-1). The `/` route stays the health JSON: no content negotiation, no redirect to `/admin/` (research A6 proposed one; D6 and research.md forbid touching `/`).

### 1.3 Auth levels

Every route is registered through one function, `route({ method, path, auth, csrf, touch, bodyLimit, handler })`. `auth` has **no default**: registering without it throws at boot (deny by default). `router.routes()` returns the table and drives SC-005.

| Level | Requirement | Used by |
| --- | --- | --- |
| `public` | none. Still subject to throttling, security headers and, for unsafe methods, the Origin checks | static files, `GET /admin/setup`, AUTH-1, AUTH-2 |
| `setup` | cookie `owb_setup` holding a valid, unexpired, unused setup or reset token (no session) | AUTH-4 only |
| `session` | valid session cookie (section 1.5) | everything else |

Expected `public` set, snapshotted by `test/admin-security.test.js`: the static files, `GET /admin/setup`, `GET /admin/api/session`, `POST /admin/api/login`; `setup` set: `POST /admin/api/setup`. Adding a route to these sets forces a test edit.

### 1.4 Cookies

| Cookie | Set by | Flags | Lifetime |
| --- | --- | --- | --- |
| `__Host-owb_sid` over HTTPS, `owb_sid` over plain HTTP | login, setup, password change | `Path=/; HttpOnly; SameSite=Strict`, plus `Secure` over HTTPS (the `__Host-` form requires `Secure`, `Path=/` and no `Domain`) | `Max-Age = min(86400, remaining absolute lifetime)`; re-issued on touching answers at most once per 60 s (same cadence as the idle write-behind); cleared (`Max-Age=0`) at logout, expiry and rotation |
| `owb_setup` | `GET /admin/setup` | `Path=/admin/api; HttpOnly; SameSite=Strict` (AUTH-1 must see it to show the setup form; it was `/admin/api/setup`, which a browser never sends to `/admin/api/session`), plus `Secure` over HTTPS (no `__Host-` form: the path is not `/`) | remaining life of the token (at most 30 min); cleared when consumed |

"HTTPS" means the socket is encrypted, or `X-Forwarded-Proto: https` arrived from a peer matched by `PANEL_TRUST_PROXY`. Both session cookie names are accepted on read (the `__Host-` one wins). The value is 32 random bytes in base64url; the database stores only its SHA-256.

### 1.5 Sessions

- Idle expiry 24 h sliding (`lastSeenAt + 24 h`), **absolute cap 7 days** from login (U11, FR-006), explicit logout. At most 10 live sessions (the oldest is evicted). A new id is issued at every login, setup and password change; any pre-login cookie is discarded.
- A request on a `touch: n` route (SSE, `state`, `logs`, `pairing`, `jobs` polling) does **not** extend the idle clock, otherwise a forgotten open tab would never expire. Every other `session` route does (write-behind, at most one write per 60 s).
- A presented cookie that is unknown, idle-expired, absolute-expired or revoked gives `401 session_expired`; no cookie gives `401 unauthenticated`. The SPA reacts to `session_expired` by warning that unsaved input will be lost before redirecting to login (edge case "session expirée pendant la saisie"); password errors never use 401 (section 1.9).
- Database unreachable: cached sessions keep working, uncached ones get `503 db_unavailable` (never 401, so the SPA does not drop to login).

### 1.6 Unsafe-request guard (FR-008, SC-005)

Applies to `POST`, `PUT`, `PATCH`, `DELETE`. No `GET`/`HEAD` route mutates anything (registry flag `mutates`, checked by a test). Checks run in this order and **all** must pass:

1. The auth level is satisfied, else `401` (`unauthenticated`, `session_expired`, `token_invalid`). This comes first so the SPA can drop to login.
2. `Origin` is present and its `host[:port]` belongs to {`Host` header, `X-Forwarded-Host` from a trusted peer, host of `PANEL_PUBLIC_URL`}. Without `Origin`, `Referer` is used; both absent gives `403 origin_mismatch`. A mismatch is logged once a minute with received and expected hosts (hint to set `PANEL_PUBLIC_URL`).
3. `Sec-Fetch-Site`, when the browser sends it, is `same-origin` (`none` is not accepted for unsafe methods), else `403 origin_mismatch`.
4. `X-CSRF-Token` equals the session's token (`crypto.timingSafeEqual`), else `403 csrf_invalid`. The token comes from AUTH-1 or from the login, setup and password-change answers and is kept in a JS variable. Not applied to `csrf: origin` routes (AUTH-2, AUTH-4: no session exists yet).
5. `Content-Type` is `application/json` (or `application/octet-stream` on UP-1), else `415 unsupported_media_type`. This holds **even when the body is empty**: a bodiless unsafe request sends `{}` or no body with the JSON type, and an empty body is read as `{}`. A cross-site form cannot send either type without a CORS preflight, which the server never approves.

`GET /admin/api/events` and `GET /admin/api/pairing/qr.svg` (EventSource and `<img>` cannot set headers) require the session and, when sent, `Sec-Fetch-Site: same-origin` and a matching `Origin`. No `Access-Control-*` header is ever sent under `/admin`.

### 1.7 Request format and limits

- JSON only, UTF-8. Default body cap **64 KiB** (a route may declare more, at most 1 MiB; none in this contract does). Early `413 payload_too_large` from `Content-Length`, byte counting while streaming, `400 bad_request` on a parse error. A route that declares no `bodyLimit` accepts only an empty body or `{}`.
- **Strict schemas**: every handler validates against a schema and builds a fresh object (never merges parsed input, no prototype pollution). An unknown property gives `422 validation_failed` with `fields.$unknown = { code: "unknown_field" }` (the unknown name is not echoed). Strings are NFC-normalised except passwords and passphrases (NFKC).
- Path parameters are decoded once (`400` if malformed). A group `:jid` matches `^\d+(-\d+)?@g\.us$`; a user JID is normalised with `normalizeJid` (phone-number or LID form); a numeric `:id` matches `^[1-9]\d{0,9}$`; `:key` (text key) matches `^[A-Za-z0-9_.-]{1,160}$`; `:lang` is `en` or `fr`. A non-matching value is `404 not_found` (the route does not exist for that value).
- Query parameters are validated like body fields. Pagination convention for list routes: `page` (1-based, default 1), `pageSize` (default 50, maximum 200), answer `{ items, page, pageSize, total }`.
- **Uploads** (UP-1): `PUT /admin/api/uploads?purpose=backup|broadcast&name=<display name>` with `Content-Type: application/octet-stream`. `Content-Length` is required (`411 length_required`) and checked first, then counted while streaming to `data/admin-uploads/<id>.part` (mode 0600), renamed on success. Cap = `MAX_UPLOAD` MB (live setting, default 230) for both purposes; total pending quota 2 x `MAX_UPLOAD` MB (`507 quota_exceeded`); one upload in flight per session (`409 upload_in_progress`); 1 h TTL janitor. `name` is metadata only (sanitised basename, never used in a path). The type is sniffed with `file-type`, never trusted from a header. The browser uses `XMLHttpRequest` for progress. The follow-up JSON request references the returned `uploadId`.
- Every answer carries `X-Request-Id` (random, 8 bytes hex). The access log is `debug` level and records method, route pattern, status and duration only (no query string: the setup token travels in one; no header, no body).

### 1.8 Response format

- JSON, `Content-Type: application/json; charset=utf-8`. Timestamps are ISO-8601 UTC strings, durations in milliseconds (`...Ms`) or seconds (`...Sec`) as named, sizes in bytes, JIDs in normalised form. Absent values are `null`, not omitted. Property order is not significant.
- Success: `200` (read, update, delete), `201` (resource created), `202` (job accepted, section 1.16). No `204`. Redirects: `303` (setup link), `308` (`/admin`), `304` (static revalidation).
- A secret never appears in any response: only `{ set, last4 }` (FR-017), see the catalog.
- Language-neutral: the API sends codes and parameters, never prose; the SPA translates `errors.<code>` and `fields.<code>` from `lib/admin/public/i18n/{en,fr}.json` (FR-037).

### 1.9 Error envelope

```json
{ "error": { "code": "validation_failed", "fields": { "PREFIX": { "code": "invalid_format", "params": { "reason": "whitespace" } } }, "params": {}, "requestId": "9f3c1a2b4d5e6f70" } }
```

- `error.code`: stable snake_case (table below). `error.fields` (optional, with `validation_failed` and `conflict` only): map from a **field name of the route's own schema** (a catalog key, a body property, `$unknown`) to `{ code, params? }`. `error.params` (optional): parameters of the top-level code (`retryAfterMs`, `blockers`, `expected`...). `error.requestId` is always present on `internal_error`, optional elsewhere (it is also the `X-Request-Id` header).
- **Never echoed**: a submitted value, a secret, a password, a passphrase, a token. `params` carry only values the server derives (limits, allowed values, expected placeholder tokens, retry delays, indices into a submitted list) and, for non-secret text, the offending **placeholder names** found by a closed grammar (`@[a-z]+`, `&[a-z]+`, `{n}`). Raw upstream or stack text goes to the logger through `safeLog`, never to the client.

**Envelope codes** (HTTP status in parentheses):

| Code | Status | Meaning |
| --- | --- | --- |
| `bad_request` | 400 | malformed JSON, path or query parameter, encoding |
| `unauthenticated` | 401 | no session cookie |
| `session_expired` | 401 | cookie presented but the session is unknown, expired (idle or absolute) or revoked |
| `invalid_credentials` | 401 | wrong login password |
| `token_invalid` | 401 | setup or reset token missing, expired, used or unknown |
| `origin_mismatch` | 403 | Origin, Referer or Sec-Fetch-Site check failed |
| `csrf_invalid` | 403 | `X-CSRF-Token` missing or wrong |
| `forbidden` | 403 | reserved (never expected from a registered route) |
| `not_found` | 404 | unknown route, resource or path value; `params.resource` names the kind (`group`, `command`, `broadcast`...) |
| `no_qr` | 404 | no QR code is currently available |
| `method_not_allowed` | 405 | known path, other method; `Allow` header; also every `OPTIONS` |
| `conflict` | 409 | optimistic-concurrency mismatch (section 1.11) |
| `busy` | 409 | single-flight operation already running (restart, restore, update, yt-dlp update, export, purge of the same category, delete of a running broadcast) |
| `confirmation_required` | 409 | the `confirm` of section 1.10 is missing; `params.confirm` names what to confirm |
| `setup_required` | 409 | login attempted while no account exists |
| `not_connected` | 409 | the operation needs the open WhatsApp connection |
| `bot_not_admin` | 409 | the operation needs the bot to be a group administrator |
| `group_left` | 409 | the bot is no longer in that group |
| `already_paired` | 409 | pairing requested while a session is registered (log out first) |
| `not_configured` | 409 | no key saved for the service to test |
| `not_pending` | 409 | reminder or broadcast run is not in a state that allows the action |
| `not_editable` | 409 | the broadcast kind or state does not allow editing |
| `limit_reached` | 409 | a fixed per-group limit is reached (50 filters) |
| `duplicate` | 409 | the item already exists (same normalised filter pattern) |
| `upload_in_progress` | 409 | one upload at a time per session |
| `update_unavailable` | 409 | self-update impossible; `params.blockers` lists reason codes (`image`, `archive`, `no_git_binary`, `dubious_ownership`, `detached`, `no_remote_branch`, `dirty_tree`, `not_writable`) |
| `downloads_active` | 409 | yt-dlp downloads are running |
| `restore_token_invalid` | 409 | unknown, expired, used or foreign `restoreToken` |
| `length_required` | 411 | upload without `Content-Length` |
| `payload_too_large` | 413 | body or upload over its cap; `params.maxBytes` |
| `unsupported_media_type` | 415 | wrong `Content-Type` |
| `validation_failed` | 422 | at least one field invalid; `error.fields` lists them; nothing was written |
| `not_testable` | 422 | the service has no valid key test (Alpha Vantage, unused keys) |
| `not_purgeable` | 422 | the storage category cannot be emptied (`database`) |
| `unsupported_file_type` | 422 | uploaded content is not an allowed type for its purpose |
| `target_protected` | 422 | the target is the bot, an owner or the group creator (`guardTarget`) |
| `negative_balance` | 422 | the economy adjustment would make a balance negative (nothing written) |
| `wrong_passphrase` | 422 | backup passphrase does not match |
| `backup_corrupted` | 422 | backup altered or truncated |
| `backup_unsupported_format` | 422 | unknown container `format` |
| `backup_too_new` | 422 | backup made by a newer bot version; `params.backupVersion`, `params.currentVersion` |
| `backup_invalid_row` | 422 | a row fails model validation; `params.model`, `params.index`, `params.field` |
| `login_blocked` | 429 | origin blocked after 5 failures in 15 minutes; `Retry-After` |
| `rate_limited` | 429 | any other throttle (table 1.12); `Retry-After`, `params.retryAfterMs` |
| `internal_error` | 500 | unexpected failure; the stack went to the logger |
| `whatsapp_error` | 502 | the WhatsApp call failed (mute, group fetch) |
| `db_unavailable` | 503 | the database is unreachable |
| `maintenance` | 503 | a restore is applying; mutations are refused; `Retry-After: 5` |
| `quota_exceeded` | 507 | uploads quota reached |

**Field codes** (inside `error.fields[name].code`): `required`, `invalid_type`, `invalid_format`, `too_short` (`params.min`), `too_long` (`params.max`), `out_of_range` (`params.min`, `params.max`), `not_allowed` (`params.allowed`), `readonly`, `unknown_setting`, `unknown_field`, `unknown_variable` (`params.names`), `placeholder_mismatch` (`params.expected`), `bound_conflict` (`params.other`), `invalid_timezone`, `invalid_phone`, `invalid_jid`, `invalid_url`, `invalid_emoji`, `too_many_items` (`params.max`), `duplicate`, `in_past`, `unknown_target` (`params.indices`), `forced_by_env`, `not_applicable`, `too_weak`, `wrong_password`, `same_as_current`, `conflict` (`params.version`), `negative_balance`.

### 1.10 Confirmation convention (FR-039)

The UI always asks before a destructive or disruptive action. The server additionally enforces it where the spec makes the confirmation part of the scenario. A confirmed request carries `"confirm": true` in the JSON body (`POST`, `PUT`, `PATCH`) or `?confirm=true` (`DELETE`); missing or false gives `409 confirmation_required` with `params.confirm` and nothing is done. Three routes use a richer form: BC-3 (`confirmTargets` must equal the resolved destination count, FR-047), SET-2 (`confirm: ["owners_empty"]`, scenario 3.5) and BAK-1 (`confirmSession: true`, scenario 10.2).

Routes needing it: RST-1, PAIR-4, GRP-6, GRP-16, MNT-3, MNT-5, MNT-7, BAK-3, BC-9, plus the three rich forms above.

### 1.11 Optimistic concurrency (FR-020)

Settings carry an integer `version` (see the catalog). A write sends the `version` it read; if the stored version differs, **nothing in the batch is written** and the answer is `409 conflict` with `fields[key] = { code: "conflict", params: { version } }` where `version` is the current one (the UI then reloads that setting; the message is "ce réglage a changé depuis l'ouverture de la page"). A key never created has version `0`. Other resources (commands, filters, data rows) use idempotent set-based operations instead of a version: they cannot clobber each other.

### 1.12 Rate limits and throttles

| Scope | Limit | Answer |
| --- | --- | --- |
| Login failures (AUTH-2) | 5 failures in 15 min per origin, then blocked 15 min. Checked **before** any password verification (the right password is refused too); blocked attempts do not extend the block; success clears the key; consuming a reset link lifts it | `429 login_blocked`, `Retry-After`, `params.retryAfterMs`; audit `login.blocked`; alert `login_blocked` (US13) |
| Wrong setup or reset token (STA-3, AUTH-4) | same thresholds, separate bucket per origin | `429 rate_limited` |
| Password and passphrase hashing (AUTH-2, AUTH-4, AUTH-5, BAK-1, BAK-2) | one scrypt in flight, queue of 4 | then `429 rate_limited` |
| API key test (SET-3) | 1 per service per 10 s (`cooldown.hit("panel", "keytest:<service>", 10000)`) | `429 rate_limited`, `params.retryAfterMs` |
| Pairing code (PAIR-3) | 1 per 30 s | `429 rate_limited` |
| Update check (MNT-2) | 1 per 30 s | `429 rate_limited` |
| Storage re-measure (MNT-6 `?refresh=1`) | 1 per 5 s, results cached 30 s | `429 rate_limited` |
| Group list refresh (GRP-2) | WhatsApp fetch at most once per 60 s | `200` with `cached: true` |
| SSE streams (EVT-1) | 5 per session, 20 total | `429 rate_limited` |
| Heavy jobs | one at a time among restart, restore, update apply, yt-dlp update | `409 busy` |

The "origin" key is the client address after trust-proxy resolution: the socket address, or the right-most `X-Forwarded-For` entry not itself trusted, honoured only when the **peer** matches `PANEL_TRUST_PROXY` (U10). IPv4-mapped IPv6 is unmapped; IPv6 is grouped by /64. Behind an undeclared proxy all visitors share one origin: the `undeclared_proxy` banner (section 3.3) says how to declare it; the server never trusts forwarded headers automatically.

### 1.13 Security headers

On **every** `/admin` answer, errors and redirects included (one `finish()` helper):

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'` (no `upgrade-insecure-requests`: plain HTTP is allowed with a warning, FR-009) |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` |
| `Cache-Control` | `no-store` on `/admin/api/*`, `/admin/setup` and the QR; `no-cache` plus `ETag` (sha1) and `304` support on static files |

The QR image (PAIR-2) additionally sets its own `Content-Security-Policy: default-src 'none'`. HSTS is left to the proxy. Static serving uses a `Map` built at boot from `lib/admin/public/`: only exact keys are servable (no path-to-file mapping, so `..`, `%2e`, `%00`, `\` simply miss with `404`). No resource is loaded from a third party (FR-010); a test scans `public/` for external URLs and forbidden DOM APIs.

### 1.14 Degraded modes

- **Database down**: routes flagged `db:r` keep working: static files, AUTH-1 (cached session), DASH-1, EVT-1, LOG-1, JOB-1, PAIR-1 to PAIR-4, RST-1, SET-1 (values from the in-memory store; writes need the database), MNT-1, MNT-4, MNT-6 (the database size excepted). Audit writes on those routes are best effort: a failed write is logged and never blocks the action. Every other route answers `503 db_unavailable`. The state banner `db_unavailable` explains it.
- **Maintenance** (a restore is applying): every mutating route answers `503 maintenance` with `Retry-After: 5`; reads still answer; the pipeline drops incoming WhatsApp messages until the in-process restart.
- **Bot disconnected**: pages that do not need WhatsApp work; routes that do (GRP-2, GRP-11, GRD-2, PAIR-3 before the socket opens) answer `409 not_connected`.

### 1.15 Audit vocabulary (FR-036)

`lib/utils/audit.js` records `{ action, target, origin, result, detail }` (`result` is `ok` or `fail`/`refused`). `detail` never holds a secret: a non-secret setting records `{ from, to }`, a secret only `{ secret: true, op }` (single helper `auditDiff`). A request that fails validation or the guard is not audited, except authentication events.

| Action | Written by | Target |
| --- | --- | --- |
| `login.success`, `login.failure`, `login.blocked` | AUTH-2 | the origin |
| `logout` | AUTH-3 | none |
| `setup.complete`, `reset.issued`, `reset.complete` | AUTH-4; the CLI `tools/admin-reset.js` and the `data/admin-reset` marker (`reset.issued`) | none |
| `account.update` | AUTH-5 | `password` |
| `setting.update`, `setting.reset`, `setting.test` | SET-2 (`set` is `update`; `default` and `revert` are `reset`); SET-3 | the key; the service |
| `restart` | RST-1 | none |
| `pair.code`, `session.logout` | PAIR-3, PAIR-4 | last two digits only (`..12`); none |
| `command.toggle` | CMD-2, GRP-17 | command and scope |
| `group.update`, `group.guard`, `group.mute`, `group.delete` | GRP-4, GRD-1, GRD-2, GRP-6 | group JID |
| `group.filter`, `group.role`, `group.warnings` | GRP-8 to GRP-10; GRP-13; GRP-15, GRP-16 | group JID plus item |
| `chat.enable` | CHAT-3 | chat JID |
| `economy.adjust` | DATA-3 | `<group>:<user>`; detail `{ mode, delta, balance, reason }` |
| `data.delete` | DATA-2 | `<kind>:<id>` |
| `broadcast.create`, `broadcast.update`, `broadcast.pause`, `broadcast.resume`, `broadcast.cancel`, `broadcast.delete` | BC-3, BC-5, BC-6, BC-7, BC-8, BC-9 | broadcast id |
| `backup.export`, `backup.restore` | BAK-1, BAK-3 | none; detail holds counts and `includesSession`, never the passphrase |
| `update.check`, `update.apply`, `ytdlp.update` | MNT-2, MNT-3, MNT-5 | versions |
| `storage.purge` | MNT-7 | category |
| `text.update`, `text.reset` | TXT-2, TXT-3 | `<lang>:<key>`; detail `{ length }` |
| `guard.antibot.remove`, `guard.antibot.suspect` | the group-guard hook (not an HTTP route), listed for completeness (data-model.md); `suspect` is a 22-character `3EB0...` id that is only logged (U16) | group JID |

### 1.16 Jobs

Long operations return `202 { job: { id, type, status: "running" } }` and report through the SSE `job` event (section 3) and `GET /admin/api/jobs/:id` (polling fallback). Job `type`: `restart`, `update.check`, `update.apply`, `ytdlp.update`, `restore`. Shape: `{ id, type, status: "running" or "done" or "failed", phase, startedAt, finishedAt, result, error }` where `error` is `{ code, params? }`. Phases: restart `stop, settings, start, ready`; update apply `fetch, merge, install, verify`; restore `maintenance, pre_backup, database, session, finalize, restarting`. The registry is in memory (last 20 jobs, 1 h). Heavy jobs (restart, restore, update apply, yt-dlp update) are mutually exclusive (`409 busy`). A restore ends with the in-process restart; a supervised update ends with `process.exit(0)` about 1 s after the job reaches `done` (the stream then drops and the SPA reconnects). Job `error.code` values: `restart_failed`, `update_check_failed` (`params.reason`: `no_remote_branch`, `unreachable`, `dubious_ownership`...), `update_failed` (`params.phase`, `params.reason`, `params.rolledBack`), `restore_failed` (`params.phase`). yt-dlp outcomes are verdicts in the job `result`, not errors.

---

## 2. Routes

Notation: every route is `session`-authenticated, fully guarded (CSRF `yes` for unsafe methods, `no` for `GET`), touches the session and needs the database, **except where the Auth, CSRF or Flags column says otherwise**. Flags: `touch:n` (does not extend the idle clock), `confirm` (section 1.10), `db:r` (works without the database, section 1.14), `job` (answers `202` with a job). `{...}` names in answers are the objects described in the details below the table. Unless a detail says otherwise, errors are the generic ones: the guard (`401`, `403`, `415`), `400`, `422 validation_failed`, `429`, `500`, `503`.

### 2.1 Static files and the setup link

| ID | Method and path | Auth | CSRF | Flags | Audit | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| STA-1 | `GET`, `HEAD` `/admin/`, `/admin/css/*`, `/admin/js/*`, `/admin/i18n/en.json`, `/admin/i18n/fr.json`, `/admin/vendor/*`, `/admin/icons.svg`, `/admin/favicon.ico` | public | no | db:r | none | FR-001, FR-010, FR-037, FR-038, FR-041 |
| STA-2 | `GET /admin` | public | no | db:r | none | FR-040 |
| STA-3 | `GET /admin/setup?token=<t>` | public | no | | none | FR-003, FR-007, US1 |

- **STA-1**: only exact keys of the in-memory asset map. `index.html` is a static shell (no inline script or style, no data, no CSRF token); everything dynamic comes from authenticated JSON. Public by design (the login view needs the assets and they hold no secret); this is the intended reading of FR-001 "hors connexion".
- **STA-3**: validates the token without consuming it (SHA-256 compared with `timingSafeEqual`), sets `owb_setup`, answers `303 Location: /admin/#/setup`. Invalid, expired or used: `303 Location: /admin/#/setup/invalid`, no cookie. Always `Referrer-Policy: no-referrer`, `Cache-Control: no-store`; the token leaves the URL bar, history and Referer, and a link scanner that only fetches the page cannot consume it. Wrong tokens count in the setup-token throttle (`429` envelope when blocked). The same URL serves the first-run link (`kind` `setup`, printed to the console, valid 30 min, FR-003) and the reset link (`kind` `reset`, issued by `node tools/admin-reset.js` or the `data/admin-reset` marker file, FR-007; neither is an HTTP route).

### 2.2 Authentication and account

| ID | Method and path | Auth | CSRF | Flags | Audit | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| AUTH-1 | `GET /admin/api/session` | public | no | db:r | none | FR-001, FR-005, FR-009, FR-037, FR-041, US1 |
| AUTH-2 | `POST /admin/api/login` | public | origin | | `login.success`, `login.failure`, `login.blocked` | FR-001, FR-004, FR-005, FR-006, US1 |
| AUTH-3 | `POST /admin/api/logout` | session | yes | | `logout` | FR-006 |
| AUTH-4 | `POST /admin/api/setup` | setup | origin | | `setup.complete` or `reset.complete` | FR-003, FR-004, FR-007, US1 |
| AUTH-5 | `PATCH /admin/api/account/password` | session | yes | | `account.update` | FR-004 |
| AUTH-6 | `PATCH /admin/api/account/preferences` | session | yes | | none | FR-037, FR-041 |

- **AUTH-1** answers `200` always. Unauthenticated: `{ accountExists, authenticated: false, https, proxyHint, setup }` and nothing else (`setup` is `{ purpose: "setup" or "reset", expiresAt }` when a valid `owb_setup` cookie is presented, else `null`; `https` is the server's view for the diagnostic banner; `proxyHint` is true when forwarded headers arrived from an untrusted peer). Authenticated adds `csrf`, `account: { uiLang, theme, lastLoginAt }`, `session: { idleExpiresAt, absoluteExpiresAt }`, `bot: { version, lang, timezone }`. With no account, `accountExists: false` and the SPA shows only the invitation to follow the console link (US1 scenario 1). The FR-009 "no HTTPS" warning is computed in the **browser** (`location.protocol !== "https:"` and a non-loopback hostname), which is right whatever the proxy does.
- **AUTH-2**: body `{ password }` (string, 1 to 256). `200 { csrf, account, session }` plus the session cookie (rotation: any earlier cookie is discarded). Errors: `401 invalid_credentials`, `409 setup_required`, `429 login_blocked` (checked before verification), `429 rate_limited` (hash queue full). A new origin with a successful login raises the `new_origin` alert (US13).
- **AUTH-3**: body `{}`. `200 { ok: true }`, session row deleted, cookie cleared.
- **AUTH-4**: body `{ password }`. Policy (FR-004): NFKC, 12 to 256 code points, not one repeated character, not a trivial sequence, not in a small built-in denylist; field codes `too_short` (`params.min` 12), `too_long`, `too_weak`. Consumes the token in the same transaction that creates the account (`purpose` `setup`) or changes the password (`purpose` `reset`: all sessions are revoked and in-memory lockouts cleared). `200 { purpose, csrf, account, session }` plus the session cookie; `owb_setup` is cleared. Errors: `401 token_invalid`, `422`, `429`.
- **AUTH-5**: body `{ currentPassword, newPassword }`. Revokes every other session, rotates this one: `200 { csrf }` plus a new cookie. A wrong current password is `422` with `fields.currentPassword = wrong_password` (never 401, so the SPA does not drop to login); `fields.newPassword` may be `too_short`, `too_long`, `too_weak`, `same_as_current`. Hash queue full: `429`.
- **AUTH-6**: body with at least one of `uiLang` (`fr` or `en`) and `theme` (`auto`, `light`, `dark`). `200 { uiLang, theme }`. The panel language is independent of `BOT_LANG`.

### 2.3 Dashboard, jobs, restart, live stream

| ID | Method and path | Auth | CSRF | Flags | Audit | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| DASH-1 | `GET /admin/api/state` | session | no | touch:n, db:r | none | FR-012, SC-007, US2 |
| JOB-1 | `GET /admin/api/jobs/:id` | session | no | touch:n, db:r | none | FR-013, FR-052, FR-054, FR-055 |
| RST-1 | `POST /admin/api/restart` | session | yes | confirm, job, db:r | `restart` | FR-013, US2 |
| EVT-1 | `GET /admin/api/events` | session | no | touch:n, db:r | none | FR-012, FR-023, FR-034, SC-006, SC-007 |

- **DASH-1** (also the SSE `state` payload, section 3.2, and the polling fallback): 
  `{ at, bot: { status, number, since, uptimeSec, version, messagesProcessed, lastActivity, registered }, memory: { rss, heapUsed, heapTotal, external }, errors: [{ seq, ts, name, msg }], restartPending: [key], banners: [{ id, severity, params }], db: "ok" or "unavailable", maintenance: boolean, job: { id, type, status, phase } or null }`.
  `bot.status` is the client status: `idle`, `connecting`, `qr`, `open`, `reconnecting`, `restarting`, `stopped`, `logged_out` (FR-012 labels: `open` is "connecté"; `qr` and `logged_out` are "en attente d'appairage"; the rest are "déconnecté" or transitional). `number` is the bot's phone number (digits) or `null`. `errors` are the 10 newest log-ring entries of level error or above, already scrubbed, newest first. Memory in bytes. `messagesProcessed` counts since the process started.
- **JOB-1**: `200 { job }` (shape in 1.16); `404 not_found` for an unknown or expired id.
- **RST-1**: body `{ confirm: true }`. `202` with a `restart` job. Single-flight (`409 busy`). Effect: `settingsCache.clear()`, settings reload, language reload, interval reconfiguration, `client.restart()` (stop then initialize, session kept), wait for `ready` (60 s), refresh the `inForce` snapshot (clears `restart_needed`). The WhatsApp session is **not** closed and the process does not exit. Distinct from the legacy `POST /api/restart` (1.2). Failure: job `failed` with `error.code` `restart_failed`.
- **EVT-1**: section 3.

### 2.4 Pairing

| ID | Method and path | Auth | CSRF | Flags | Audit | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| PAIR-1 | `GET /admin/api/pairing` | session | no | touch:n, db:r | none | FR-023, US4 |
| PAIR-2 | `GET /admin/api/pairing/qr.svg?v=<n>` | session | no | touch:n, db:r | none | FR-023, SC-006 |
| PAIR-3 | `POST /admin/api/pairing/code` | session | yes | db:r | `pair.code` | FR-023, US4 |
| PAIR-4 | `POST /admin/api/pairing/logout` | session | yes | confirm, db:r | `session.logout` | FR-024, US4 |

- **PAIR-1**: `200 { status, registered, number, qr: { version, issuedAt } or null, code: { pending, expiresAt } or null, codeCooldownMs }`. Never contains the QR string or the pairing code.
- **PAIR-2**: `200 image/svg+xml`, generated server-side with `qrcode`, shown through `<img>`; `Cache-Control: no-store`, own CSP. `v` is only a cache-buster (the current QR is served). `404 no_qr` when there is none. The QR string is account-takeover material: authenticated, never logged, registered with the redactor for 5 minutes.
- **PAIR-3**: body `{ phone }`; digits only after stripping spaces and `+`, `^\d{8,15}$`, else `fields.phone = invalid_phone`. `200 { code, expiresAt }` with `code` formatted `XXXX-XXXX` (8 characters), valid about 3 minutes; this answer is the only place the code is ever sent. Errors: `409 already_paired` (log out first, edge case), `409 not_connected` (socket not open), `429 rate_limited` (1 per 30 s). Logged and audited with the last two digits only. A connection that closes while a pairing is pending and `registered` is still false triggers an automatic session reset (a failed attempt must not poison the session).
- **PAIR-4**: body `{ confirm: true }`. Closes the session on WhatsApp, removes the contents of `sessions/main` and returns to `qr`: `200 { ok: true }`. Works when the socket is already down.

### 2.5 Settings

| ID | Method and path | Auth | CSRF | Flags | Audit | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| SET-1 | `GET /admin/api/settings` | session | no | db:r | none | FR-014, FR-016, FR-017, FR-019, US3 |
| SET-2 | `PATCH /admin/api/settings` | session | yes | | `setting.update`, `setting.reset` (one per key) | FR-015, FR-016, FR-017, FR-018, FR-019, FR-020, FR-021, US3 |
| SET-3 | `POST /admin/api/settings/keys/:service/test` | session | yes | | `setting.test` | FR-022, US3 scenario 7 |

- **SET-1**: `200 { settings: [ResolvedSetting], restartPending: [key], secretStore: "ok" or "key_missing", ownersConfigured }`. `ResolvedSetting` is defined in [settings-catalog.md](settings-catalog.md) (key, theme, source, type, rules, default, value or `{ set, last4 }`, origin `default` / `env` / `override`, canRevert, version, effect, readonly, inactive, problem, testService...). All themes are returned (about 100 entries); filtering is client-side. Values come from the in-memory settings store, so the route survives a database outage.
- **SET-2**: body
  `{ changes: [{ key, op, value?, version }], confirm?: ["owners_empty"] }` with 1 to 50 changes, unique keys. `op` is `set` (needs `value`, typed JSON: boolean, number, array of strings for lists, string otherwise), `default` (FR-018: store the catalog default as an override, which masks a file value; for a secret this clears it), or `revert` (FR-021: delete the override so the file/environment value, else the default, applies). `version` is required for every change (section 1.11). All-or-nothing: the whole batch is validated (types, bounds, formats, cross-field rules on the resulting values such as `AUTO_RESPONDER_MIN_DELAY` <= `MAX_DELAY`, and `readonly` / `inactive` keys refused with `readonly`), versions are compared, then override rows and database-backed adapters are written in one transaction; the file adapter (`data/status_save.json`) is written last, and a failure there after the commit is reported as `500 internal_error` (the UI reloads; documented limitation). Errors: `422 validation_failed` with `fields[key]` per invalid key (nothing written); `409 conflict` (stale version); `409 confirmation_required` with `params.confirm = ["owners_empty"]` when the resulting `SUDO` list is empty and was not (US3 scenario 5). `revert` on an adapter-backed key is `not_applicable`; setting `AUTO_STATUS_SAVE` to `false` while the environment forces it on is `forced_by_env`.
  `200 { settings: [ResolvedSetting], restartPending: [key] }` for the changed keys. Immediate settings are live before the answer is sent (store updated, dependent caches reset, `settingsCache` keys invalidated by the adapters); `restart` settings appear in `restartPending` and raise the `restart_needed` banner until RST-1 completes. A secret value is registered with the log redactor, encrypted at rest (`enc:v1:`) and never echoed; the audit detail is `{ secret: true, op }`.
- **SET-3**: no body. The key is read server-side (the panel value wins) and **never** travels in the request or the answer. `:service` is one of `openai`, `gemini`, `weather`, `news`, `unsplash`, `giphy`, `spotify`, `reddit` (mapping in the catalog). `200 { service, verdict: "accepted" or "refused" or "unreachable", detail: "quota" or null, checkedAt }`. Errors: `404 not_found` (unknown service), `409 not_configured` (no key saved), `422 not_testable` (`alphavantage` and every unused key), `429 rate_limited` (10 s per service). A refused verdict does not raise the `key_refused` alert (that comes from real use).

### 2.6 Commands

| ID | Method and path | Auth | CSRF | Flags | Audit | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| CMD-1 | `GET /admin/api/commands` | session | no | | none | FR-025, US5 |
| CMD-2 | `PATCH /admin/api/commands/:name/state` | session | yes | | `command.toggle` (one per scope changed) | FR-026, FR-027, US5 |

- **CMD-1**: `200 { commands: [{ name, aliases, type, desc, access: { owner, admin, group, pm }, disabledGlobal, disabledGroups }], types, orphans: [{ command, scope }] }`. Each loaded command appears once (`name` is the first alias, aliases include it). `desc` is the effective description (text overrides included) in the bot language. `orphans` are `CommandState` rows whose command no longer exists. Search and category filter are client-side (about 80 commands).
- **CMD-2**: body `{ disable?: [scope], enable?: [scope] }` where `scope` is `"*"` (everywhere) or a group JID; at least one list non-empty, at most 500 scopes, a scope in both lists is `invalid_format`. Idempotent and set-based (two tabs cannot clobber each other). A disabled command answers `common.command_disabled` to everyone, owners included, for every alias, from the next message; a global row wins over group rows. `200 { name, disabledGlobal, disabledGroups, warnings }` where `warnings` may hold `unban_disabled` or `banchat_disabled` (disabling them can lock a chat out; the panel is then the only way back). `404 not_found` (`resource: command`) unless the name is an orphan row being enabled.

### 2.7 Groups

All routes: `:jid` is a group JID. Data lives in the existing tables; every write goes through the store functions that also invalidate the matching `settingsCache` key (FR-030, FR-045).

| ID | Method and path | Auth | CSRF | Flags | Audit | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| GRP-1 | `GET /admin/api/groups?page&pageSize&q&status` | session | no | | none | FR-028, US6 |
| GRP-2 | `POST /admin/api/groups/refresh` | session | yes | | none | FR-028 |
| GRP-3 | `GET /admin/api/groups/:jid` | session | no | | none | FR-029, FR-032, US6 |
| GRP-4 | `PATCH /admin/api/groups/:jid` | session | yes | | `group.update` | FR-029, FR-030, US6 scenarios 2 and edge cases |
| GRP-5 | `POST /admin/api/groups/:jid/preview` | session | yes | | none | FR-029, US6 scenario 2 |
| GRP-6 | `DELETE /admin/api/groups/:jid?confirm=true` | session | yes | confirm | `group.delete` | FR-029, FR-039, US6 scenario 7 |
| GRP-7 | `GET /admin/api/groups/:jid/filters` | session | no | | none | FR-029, US6 scenario 3 |
| GRP-8 | `POST /admin/api/groups/:jid/filters` | session | yes | | `group.filter` | FR-029, US6 scenario 3 |
| GRP-9 | `PUT /admin/api/groups/:jid/filters/:id` | session | yes | | `group.filter` | FR-029, US6 scenario 3 |
| GRP-10 | `DELETE /admin/api/groups/:jid/filters/:id` | session | yes | | `group.filter` | FR-029, US6 scenario 3 |
| GRP-11 | `GET /admin/api/groups/:jid/members` | session | no | | none | FR-029 |
| GRP-12 | `GET /admin/api/groups/:jid/roles` | session | no | | none | FR-029 |
| GRP-13 | `PUT /admin/api/groups/:jid/roles/:userJid` | session | yes | | `group.role` | FR-029 |
| GRP-14 | `GET /admin/api/groups/:jid/warnings` | session | no | | none | FR-029 |
| GRP-15 | `DELETE /admin/api/groups/:jid/warnings/:userJid` | session | yes | | `group.warnings` | FR-029 |
| GRP-16 | `DELETE /admin/api/groups/:jid/warnings?confirm=true` | session | yes | confirm | `group.warnings` | FR-029, FR-039 |
| GRP-17 | `PATCH /admin/api/groups/:jid/commands` | session | yes | | `command.toggle` | FR-027, US5 scenario 5 |

- **GRP-1**: `status` is `all` (default), `current` or `former`; `q` is a name substring (at most 100 chars). `200 { items: [{ jid, name, members, botIsAdmin, former, leftAt, welcome, goodbye, antilink, antibot, mute, disabled }], page, pageSize, total, refreshedAt }`. `members` and `botIsAdmin` come from the last group-metadata snapshot (WhatsApp fetch at most every 6 h or on GRP-2) and are `null` when unknown. A group the bot left is `former: true` ("ancien groupe", settings kept). 500 groups answer in under 2 s (paged from the database and the in-memory metadata map).
- **GRP-2**: body `{}`. Refreshes names, member counts and bot-admin flags from `groupFetchAllParticipating()`, sets or clears `leftAt`. `200 { refreshedAt, cached }` (`cached: true` when the last fetch is under 60 s old). `409 not_connected`.
- **GRP-3**: `200 { jid, name, members, botIsAdmin, former, leftAt, welcome: { enabled, message, custom }, goodbye: { enabled, message, custom }, antilink, antibot, mute, disabled, counts: { filters, roles, warnings }, disabledCommands: [name], variables: ["@user", "@group", "@desc"], limits: { messageMax: 1000, filtersMax: 50, patternMax: 100, responseMax: 1000 }, warnings: [code] }`. `message` is the effective template; `custom: false` means the localised default applies. `mute` mirrors the last state **set by the bot**, not WhatsApp's live setting. `warnings` holds `bot_not_admin` when `antilink`, `antibot` or `mute` is on and the bot is not a group administrator (FR-032, US6 scenario 4). `404` for a group the panel has never seen.
- **GRP-4**: body with any of `welcome: { enabled?, message? }`, `goodbye: { enabled?, message? }`, `disabled`. `message` is 1 to 1000 characters or `null` (reset to the default, like `.welcome reset`). An unknown variable (an `@` followed by letters, not preceded by a letter, digit, dot or underscore, whose lower-cased name is not `user`, `group` or `desc`) is refused: `fields["welcome.message"] = { code: "unknown_variable", params: { names } }` (spec edge case). `disabled` creates or deletes the `BannedChat` row (`bannedBy` null). `200` with the GRP-3 object. Takes effect at the next message or event.
- **GRP-5**: body `{ kind: "welcome" or "goodbye", message }`. `200 { rendered, unknownVariables }` where `rendered` substitutes `@group` and `@desc` from the cached metadata and `@user` with the literal `@member`. Writes nothing.
- **GRP-6**: deletes the settings categories of Key Entity "Réglages de groupe": the `Group` row, `Filter`, `GroupRole`, `Warn` and `BannedChat` rows, the `CommandState` rows scoped to the group, and (only when the bot has left) its `KnownChat` row. Economy balances, ideas, quotes, tasks and statistics are data and stay. `200 { deleted: { group, filters, roles, warnings, commandStates } }`.
- **GRP-7**: `200 { filters: [{ id, pattern, response }], limits }`.
- **GRP-8 / GRP-9**: body `{ pattern, response }`; `pattern` 1 to 100 characters after whitespace collapse (`normalizePattern`), `response` 1 to 1000. GRP-8 answers `201 { filter }`, GRP-9 `200 { filter }`. Errors: `409 limit_reached` (50 per group), `409 duplicate` (same normalised pattern), `404`. Live at the group's next message.
- **GRP-10**: `200 { deleted: true }`.
- **GRP-11**: `200 { items: [{ jid, admin: "admin" or "superadmin" or null, role }], fetchedAt }` from live metadata (cached 60 s). `409 not_connected`, `409 group_left`. Feeds the role picker.
- **GRP-12**: `200 { items: [{ userJid, role, setBy, setAt }] }` for members that have a non-default role.
- **GRP-13**: body `{ role }` with `role` in `regular`, `vip`, `muted`, `banned` (`regular` deletes the row). The target is checked with `guardTarget` (`422 target_protected` for the bot, an owner or the creator). `setBy` is `null` for the panel. Enforcement is the existing role hook.
- **GRP-14**: `200 { items: [{ jid, count, reason, updatedAt }], limit }` (`limit` is `WARN_LIMIT`). **GRP-15**: resets one member (`200 { reset: n }`). **GRP-16**: resets the whole group (`200 { reset: n }`).
- **GRP-17**: body `{ disable?: [name], enable?: [name] }` (command names, at most 200), the group page's mirror of CMD-2 for scope `<jid>`; same rules and same answer shape as CMD-2 restricted to that group. Used by FR-027 "depuis la page du groupe".

### 2.8 Group guard and mute

| ID | Method and path | Auth | CSRF | Flags | Audit | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| GRD-1 | `PUT /admin/api/groups/:jid/guard` | session | yes | | `group.guard` | FR-029, FR-031, FR-032, US6 scenarios 4 and 5 |
| GRD-2 | `PUT /admin/api/groups/:jid/mute` | session | yes | | `group.mute` | FR-031, US6 scenario 6 |

- **GRD-1**: body with at least one of `antilink`, `antibot` (booleans). Stored on the `Group` row; enforcement is the hook-only `plugins/groupguard.js` (not an HTTP concern): while the bot is a group administrator, a link from a non-administrator non-owner is deleted, commands included (U17: a member's `.dl <url>` is deleted and warned, and the command does not run), the author warned through `Warn` and `WARN_LIMIT` and removed at the limit; a message id of a shape no WhatsApp client produces (`BAE5` + 12 hex, or a 40-character `3EB0...`) is removed with `ANTIBOT_MSG`, while 22-character `3EB0...` ids are only logged as suspects (U16). Group admins and owners are exempt from both. `200 { antilink, antibot, warnings }` where `warnings` may hold `bot_not_admin` (the toggle is saved anyway, FR-032).
- **GRD-2**: body `{ muted: boolean }`. Calls `groupSettingUpdate(jid, "announcement" or "not_announcement")` and only on success writes `Group.mute`. `200 { muted }`. Errors: `409 bot_not_admin` (refused, nothing written), `409 not_connected`, `409 group_left`, `502 whatsapp_error`.

### 2.9 Chats

| ID | Method and path | Auth | CSRF | Flags | Audit | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| CHAT-1 | `GET /admin/api/chats?kind&q&page&pageSize&selectable` | session | no | | none | FR-046, FR-047 |
| CHAT-2 | `GET /admin/api/chats/disabled` | session | no | | none | FR-033, US6 |
| CHAT-3 | `DELETE /admin/api/chats/disabled/:jid` | session | yes | | `chat.enable` | FR-033 |

- **CHAT-1**: the known-chat picker backed by `KnownChat`. `kind` is `private` or `group` (default both); `selectable=1` keeps only valid broadcast destinations (private chats that wrote to the bot and are not disabled, groups with `leftAt` null). `200 { items: [{ jid, kind, name, lastSeenAt, selectable }], page, pageSize, total }`. A number can never be typed in: this list is the only source of destinations (FR-046).
- **CHAT-2**: `200 { items: [{ jid, kind, name, since }] }` (every `BannedChat` row; groups are disabled through GRP-4).
- **CHAT-3**: removes the `BannedChat` row and invalidates `banned_chats`. `200 { enabled: true }`. `404` when not disabled.

### 2.10 Data management

`:kind` is `reminders`, `economy`, `keywords`, `sticker-commands`, `afk`, `tasks`, `ideas` or `quotes`; any other value is `404`.

| ID | Method and path | Auth | CSRF | Flags | Audit | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| DATA-1 | `GET /admin/api/data/:kind?page&pageSize&q&chat&groupJid&status` | session | no | | none | FR-042, FR-043, FR-044, US8 |
| DATA-2 | `DELETE /admin/api/data/:kind/:id` | session | yes | | `data.delete` | FR-042, FR-044, FR-045, US8 |
| DATA-3 | `POST /admin/api/data/economy/adjust` | session | yes | | `economy.adjust` | FR-043, US8 scenarios 2 and 3 |

- **DATA-1** filters: `q` (at most 100 chars) on the text/keyword/command, `chat` (a JID) for tasks, ideas, quotes, reminders and keyword scope, `groupJid` (**required** for `economy`, else `422`), `status` `pending` (default) or `all` for reminders. Items per kind: `reminders` `{ id, chatJid, chatName, creatorJid, dueAt, status, textPreview }` (preview 80 characters: without it duplicates cannot be told apart); `economy` `{ groupJid, userJid, balance, streak, lastDailyAt }`; `keywords` `{ id, userJid, keyword, scopeJid, enabled }`; `sticker-commands` `{ id, stickerHash, command, createdBy }`; `afk` `{ jid, name, afkReason, afkTime }`; `tasks` `{ id, chatJid, text, done, createdBy, doneBy }`; `ideas` `{ id, groupJid, authorJid, text, category, voters }` (`voters` a count); `quotes` `{ id, groupJid, authorJid, authorName, text, savedBy }`. Answer `{ items, page, pageSize, total }`.
- **DATA-2**: `:id` is the numeric id, except `afk` where it is the user JID. `reminders`: cancels through `scheduler.cancel(id)` (idempotent compare-and-swap), `200 { cancelled: true }`, `409 not_pending` if already sent or cancelled, and a cancelled reminder is never sent. Others: `200 { deleted: true }`, `404` when absent. `afk` clears `afkReason` and `afkTime` (the row stays). `economy` has no delete (`404`). Each write invalidates the matching `settingsCache` key (`afk_users`, `notify:` prefix, `sticker_cmds`) so the WhatsApp commands see it at once.
- **DATA-3**: body `{ groupJid, userJid, mode: "set" or "add", amount, reason }`; `amount` an integer (`add` may be negative, `set` must be 0 or more), `reason` 1 to 200 characters. Runs inside `economy.withLock("give:<groupJid>")` and one transaction with the atomic guarded `UPDATE ... WHERE balance >= :n`, so a simultaneous gain or spend is kept. `200 { balance, delta }` (the balance actually returned). `422 negative_balance` (nothing written), `fields.userJid = invalid_jid`. The reason is kept in the audit detail.

### 2.11 Broadcasts and recurring messages

Entities: a **broadcast** (definition), its **runs** (one per occurrence), each run's **targets**. Delivery is at most once per target (research C4). No route moves a `failed` target back to `pending` and none is planned (U14, see "No retry", end of this section).

| ID | Method and path | Auth | CSRF | Flags | Audit | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| BC-1 | `GET /admin/api/broadcasts?kind&state&page&pageSize` | session | no | | none | FR-048, FR-049, FR-050, US9 |
| BC-2 | `POST /admin/api/broadcasts/preview` | session | yes | | none | FR-047, US9 scenario 2 |
| BC-3 | `POST /admin/api/broadcasts` | session | yes | confirm (`confirmTargets`) | `broadcast.create` | FR-046 to FR-050, US9 |
| BC-4 | `GET /admin/api/broadcasts/:id` | session | no | touch:n | none | FR-048, US9 |
| BC-5 | `PATCH /admin/api/broadcasts/:id` | session | yes | | `broadcast.update` | FR-050, US9 scenario 6 |
| BC-6 | `POST /admin/api/broadcasts/:id/pause` | session | yes | | `broadcast.pause` | FR-050 |
| BC-7 | `POST /admin/api/broadcasts/:id/resume` | session | yes | | `broadcast.resume` | FR-050 |
| BC-8 | `POST /admin/api/broadcasts/:id/cancel` | session | yes | | `broadcast.cancel` | FR-048, US9 scenario 3 |
| BC-9 | `DELETE /admin/api/broadcasts/:id?confirm=true` | session | yes | confirm | `broadcast.delete` | FR-050, FR-039 |
| BC-10 | `GET /admin/api/broadcasts/:id/runs/:runId` | session | no | touch:n | none | FR-048, US9 scenarios 3 and 4 |

- **Shared request body** (BC-2, BC-3; BC-5 takes the same fields, all optional, recurring only):
  `{ kind: "once" or "recurring", title?, text, uploadId?, reuseMediaOf?, targets: [jid], spacingMs?, runAt?, recurrence?, confirmTargets }`.
  - `title`: at most 100 characters. `text`: 1 to 4096 characters, **1 to 1024 when `uploadId` is present** (caption); `too_long` with `params.max`.
  - `uploadId`: an UP-1 upload of the same session with `purpose=broadcast`, sniffed as image (JPEG, PNG, WebP) or document (PDF, Office, OpenDocument, ZIP, text, CSV), within `MAX_UPLOAD` MB (FR-047: at most one image or document); else `fields.uploadId = invalid_format`.
  - `reuseMediaOf`: id of an existing broadcast whose stored media is copied into the new one (used by the pre-filled "new broadcast to the failed destinations", see "No retry" below). Mutually exclusive with `uploadId` (`fields.reuseMediaOf = not_allowed`); a source with no stored media, none or already deleted by the 7-day retention (U15), gives `fields.reuseMediaOf = not_applicable`.
  - `targets`: 1 to 200 JIDs (`too_many_items`, `params.max` 200). Each must be a `KnownChat` row that is selectable (CHAT-1); others give `fields.targets = unknown_target` with `params.indices` (positions in the submitted list, no values). De-duplicated by phone-number JID.
  - `spacingMs`: integer 2000 to 600000, default the `BROADCAST_DELAY_MS` setting (FR-048: default 5 s, never under 2 s); the engine re-applies the 2 s floor at send time.
  - `once`: `runAt` an ISO instant or absent (send now); earlier than now minus 60 s is `in_past`; a run more than 1 h late at its time is marked `expired` and not sent (FR-049). `recurrence` must be absent (`not_allowed`).
  - `recurring`: `recurrence` required, `{ kind: "daily" or "weekly" or "monthly", days?, day?, time }` where `time` is `HH:mm` (00:00 to 23:59) in the bot's `TIMEZONE`, `days` is a non-empty array of ISO weekdays 1 to 7 (weekly), `day` is 1 to 31 (monthly; a day missing from a short month fires on the last day of that month, U12). `runAt` must be absent. An occurrence more than 1 h late is skipped and recorded as an `expired` run with `note: "late"` (FR-050).
  - `confirmTargets`: integer that must equal the resolved destination count (FR-047), else `409 confirmation_required` with `params.confirm = "targets"` and `params.targetCount`. BC-2 omits it.
- **BC-2**: `200 { targetCount, estimatedDurationMs, nextOccurrences, mediaKind, textLength, spacingMs, warnings }` where `nextOccurrences` holds the next 5 instants for a recurring rule (else `null`) and `warnings` may hold `bot_disconnected` (the run would wait). Writes nothing; the visual preview is rendered by the SPA from the same fields.
- **BC-3**: `201 { broadcast, run }`. `broadcast` is `{ id, kind, title, text, mediaKind, mediaName, mediaSize, mediaAvailable, targetCount, spacingMs, runAt, recurrence, nextRunAt, lastRunAt, state, paused, createdAt, latestRun }`; `mediaAvailable` is `null` without media and `false` once the retention rule (7 days after a `once` run ends, U15) or a storage purge deleted the file; `state` is derived: `scheduled`, `running`, `paused`, `completed`, `failed`, `cancelled`, `expired`; `paused` is `{ by: "admin" or "disconnected" }` or `null` (a started run waits out a disconnection and resumes paced, it is not expired). `run` is the first run for a `once` broadcast (`null` for a recurring one until its first occurrence), `{ id, dueAt, status, total, sent, failed, cancelled, pending, startedAt, finishedAt, note }`. Sends are strictly sequential, one global queue, jitter of up to 20 % on top of the spacing. Survives restarts: scheduled and running runs resume with the remaining targets, none is sent twice (FR-049, SC-012); progress is pushed on the SSE `job` event with `type: "broadcast"`.
- **BC-1**: `200 { items: [broadcast], page, pageSize, total }`; `state` filter takes a `state` value.
- **BC-4**: `200 { broadcast, runs: [run] (newest 20), nextOccurrences }`. `404` unknown id.
- **BC-5**: recurring only (`409 not_editable` for `once`). Edits apply to future occurrences; already materialised runs keep their targets. Editing `recurrence` recomputes `nextRunAt` from now. `confirmTargets` is required when `targets` is present. `200 { broadcast }`.
- **BC-6 / BC-7**: recurring only (`409 not_editable`). Pause stops materialising occurrences; resume recomputes `nextRunAt` from now (no catch-up burst). `200 { broadcast }`.
- **BC-8**: body `{ runId? }` (default: the open run, `scheduled` or `running`). Pending targets become `cancelled`, the in-flight message completes and is reported `sent`; for a recurring broadcast only that occurrence is cancelled (pause or delete stops the series). `200 { run }`; `409 not_pending` when no open run exists.
- **BC-9**: removes the definition, its runs, targets and stored media in one transaction. `200 { deleted: true }`; `409 busy` while a run is `running` (cancel first).
- **BC-10**: the per-destination report: `200 { run, targets: [{ chatJid, name, position, status, errorCode, mayHaveBeenDelivered, selectable, sentAt }] }`. `selectable` says whether the destination is still a valid broadcast destination (CHAT-1 rules: a group the bot left or a disabled chat is not). `status` is `pending`, `sending`, `sent`, `failed`, `cancelled`; `errorCode` is `forbidden`, `not_found`, `timeout`, `connection_closed`, `interrupted`, `error` or `null` (a code, never raw text); `mayHaveBeenDelivered` is true for `timeout`, `connection_closed`, `interrupted`. A group the bot left fails with `forbidden` or `not_found` and the others continue.
- **No retry (U14)**: there is no "retry failed targets" route and none will be added. A failed or interrupted target may have been delivered, so nothing re-sends it implicitly. The report (BC-10) is how the UI finds the failed destinations: it lists every target with `status`, `errorCode`, `mayHaveBeenDelivered` and `selectable`. "New broadcast to the failed destinations" is a **client-side pre-fill** of the ordinary create form: text and spacing from BC-4, the `failed` targets of BC-10 that are `selectable` (those with `mayHaveBeenDelivered` are marked and can be unticked), and `reuseMediaOf` set to the source broadcast when it still has media. The owner reviews it and submits it through **BC-3** like any other broadcast: at most 200 destinations (a run has at most 200, so a subset always fits), the destination-count confirmation `confirmTargets`, the same `KnownChat` validation (`unknown_target` if a destination stopped being valid since the report was opened), a normal `broadcast.create` audit entry and its own run; the server keeps no link between the two runs.

### 2.12 Uploads

| ID | Method and path | Auth | CSRF | Flags | Audit | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| UP-1 | `PUT /admin/api/uploads?purpose&name` | session | yes (`application/octet-stream`) | | none | FR-047, FR-052 |
| UP-2 | `DELETE /admin/api/uploads/:id` | session | yes | | none | FR-047, FR-052 |

- **UP-1**: raw body streamed to disk (section 1.7). `purpose` is `backup` or `broadcast`; `name` at most 120 characters. Sniffing: a `backup` file must start with the magic `OWBBACKUP\n`; a `broadcast` file must be an allowed image or document type; otherwise `422 unsupported_file_type`. `201 { uploadId, purpose, kind, mime, size, name, expiresAt }` where `kind` is `backup`, `image` or `document`. Errors: `411`, `413 payload_too_large`, `415`, `409 upload_in_progress`, `507 quota_exceeded`. An upload belongs to its session, lives 1 hour and is deleted when consumed.
- **UP-2**: `200 { deleted: true }`; `404` for an unknown, expired or foreign id.

### 2.13 Backup and restore

| ID | Method and path | Auth | CSRF | Flags | Audit | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| BAK-1 | `POST /admin/api/backup/export` | session | yes | confirm (`confirmSession` when the session is included) | `backup.export` | FR-051, US10 scenarios 1 and 2 |
| BAK-2 | `POST /admin/api/backup/inspect` | session | yes | | none | FR-052, FR-053, US10 scenarios 3 and 4 |
| BAK-3 | `POST /admin/api/backup/restore` | session | yes | confirm, job | `backup.restore` | FR-052, FR-053, US10 scenarios 3 to 5 |
| BAK-4 | `GET /admin/api/backup/stored` | session | no | optional | none | FR-052 |
| BAK-5 | `GET /admin/api/backup/stored/:name` | session | no | optional | none | FR-052 |

- **BAK-1**: body `{ passphrase, includeSession?, confirmSession? }`. `passphrase` 12 to 256 code points, NFKC (`fields.passphrase = too_short`), never logged or audited. `includeSession: true` needs `confirmSession: true` (the SPA shows the warning that the file allows taking over the number), else `409 confirmation_required` with `params.confirm = "include_session"`. Validation happens before any byte is sent; then `200` streams the file: `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="openwabot-backup-<yyyymmdd-HHmmss>.owb"`, `Cache-Control: no-store`, chunked. Content: settings (secrets decrypted inside the passphrase-encrypted archive), command states, text overrides, bot data; never the admin account, sessions or tokens, the audit log, alert state, the AI conversation history, nor `data/panel.key` (FR-051, U12). `409 busy` while another export or a restore runs; `429` when the key-derivation queue is full. The audit detail holds counts and `includesSession` only.
- **BAK-2**: body `{ uploadId, passphrase }` (an UP-1 upload with `purpose=backup`). Derives the key, checks it, decrypts the whole stream to verify the tag, parses and validates every row against the models; **nothing is modified**. `200 { restoreToken, expiresAt, summary: { format, createdAt, botVersion, dialect, includesSession, counts, ignoredModels, ignoredColumns } }` (`counts` per model; the token lives 15 minutes, is bound to this session and holds the derived key in memory only). Refusals, all `422` with the reason: `wrong_passphrase`, `backup_corrupted`, `backup_unsupported_format`, `backup_too_new` (a newer bot version, FR-053), `backup_invalid_row`. An older bot version is accepted; the dialect (SQLite or Postgres) does not matter.
- **BAK-3**: body `{ restoreToken, confirm: true }`. `202` with a `restore` job. Enters maintenance mode, writes an automatic backup of the current state to `data/backups/pre-restore-<ts>.owb`, replaces the data in one transaction (committed only after the authentication tag is verified), swaps `sessions/main` only if the file carries a session and only after the commit, reloads settings and texts and restarts the bot in-process. Any failure leaves the previous state untouched (job `failed`, `error.code` `restore_failed`, `params.phase`). `409 restore_token_invalid`, `409 busy`.
- **BAK-4 / BAK-5** (optional: no FR requires them, drop them for a smaller surface): `BAK-4` answers `200 { items: [{ name, kind: "pre-restore", size, createdAt }] }` for `data/backups/`; `BAK-5` streams one of them (`:name` must match `^pre-restore-[0-9A-Za-z_-]{1,40}\.owb$`, resolved inside `data/backups/` only; the file is still passphrase-encrypted) so the owner can recover the pre-restore state without a shell.

### 2.14 Maintenance

| ID | Method and path | Auth | CSRF | Flags | Audit | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| MNT-1 | `GET /admin/api/maintenance/update` | session | no | db:r | none | FR-054, US11 |
| MNT-2 | `POST /admin/api/maintenance/update/check` | session | yes | job | `update.check` | FR-054, FR-061 |
| MNT-3 | `POST /admin/api/maintenance/update/apply` | session | yes | confirm, job | `update.apply` | FR-054, US11 scenarios 1 to 3 |
| MNT-4 | `GET /admin/api/maintenance/ytdlp` | session | no | db:r | none | FR-055 |
| MNT-5 | `POST /admin/api/maintenance/ytdlp/update` | session | yes | confirm, job | `ytdlp.update` | FR-055 |
| MNT-6 | `GET /admin/api/maintenance/storage?refresh` | session | no | db:r | none | FR-056, US11 scenario 4 |
| MNT-7 | `POST /admin/api/maintenance/storage/:category/purge` | session | yes | confirm | `storage.purge` | FR-056, US11 scenario 4 |

- **MNT-1**: `200 { installType: "git" or "image" or "archive", canSelfUpdate, blockers, branch, behind, ahead, localVersion, remoteVersion, commits: [{ sha, subject }], checkedAt, restartRequired, supervised, lastResult }`. `blockers` are the reason codes of `update_unavailable`. `commits` lists at most 50 changes ("liste des changements"). For `image` and `archive` installs there is no apply; the SPA shows the matching how-to text (FR-054) and `remoteVersion` comes only from the optional release check (`UPDATE_CHECK`). `restartRequired` is derived (boot head differs from the current `HEAD`, or the on-disk version differs from the running one) and drives the `update_restart` banner. `supervised` says whether the process would be restarted after exiting (PM2, known panel host, `SUPERVISED=true`).
- **MNT-2**: body `{}`. `202` with an `update.check` job (git fetch up to 120 s); `429` (1 per 30 s). Job result is the MNT-1 object.
- **MNT-3**: body `{ confirm: true }`. `202` with an `update.apply` job: `fetch`, `merge --ff-only` on `origin/<current branch>`, vendored Yarn install if dependency files changed, smoke boot in a child process, rollback with `reset --hard` on any failure (FR-054: a failed update leaves the bot on the current version). `409 update_unavailable` with `params.blockers`; `409 busy`. Job `done` result `{ from, to, versions, restartRequired: true, willRestart }`; `willRestart` is true when a supervisor is detected, in which case the process exits about 1 s after the job completes; with no supervisor (U6) it is applied, the process keeps running and the banner `update_restart` asks for a manual restart. Job `failed`: `error.code` `update_failed`, `params.phase` (`merge`, `install`, `verify`), `params.reason`, `params.rolledBack`.
- **MNT-4**: `200 { command, version, selfUpdatable: "likely" or "no" or "missing", reason, activeDownloads, latest }`; `command` is the configured name, never a path (`YTDLP_PATH` is read-only, U11).
- **MNT-5**: body `{ confirm: true }`. `202` with a `ytdlp.update` job running `yt-dlp -U` (60 s). `409 downloads_active` while downloads run (new ones are blocked during the update). Result `{ verdict: "updated" or "up_to_date" or "managed_externally" or "read_only" or "unreachable" or "failed", from, to, hint }` where `hint` is `apt`, `pip`, `official_binary` or `rebuild_image` (instructions are UI text; stderr only goes to the logs). The verdict comes from the version before and after, not from parsing output.
- **MNT-6**: `200 { categories: [{ id, bytes, files, items, unit, truncated, purgeable, protectedBytes, measuredAt, dialect }], disk: { freeBytes, totalBytes } }`. Category ids (U5, U15): `temp_media` (the `media/temp` folder plus crash leftovers `owb-*` and `voice-*` in the OS temp dir), `broadcast_media` (`data/broadcast-media`; `protectedBytes` counts the media of recurring broadcasts and of `once` broadcasts whose run is not final, which a purge keeps; `null` for every other category), `antidelete_cache` (in-memory, `unit: "messages"`, content never exposed), `panel_backups` (`data/backups`), `logs` (`logs/*.log`, PM2 only), `database` (size only, `purgeable: false`; SQLite file with its `-wal`/`-shm`, or `pg_database_size`). `?refresh=1` forces a re-measure (1 per 5 s, else `429`); results are cached 30 s; the walk is capped (50 000 entries, depth 4, 2 s) and `truncated: true` means "at least". Run lazily when the page opens.
- **MNT-7**: body `{ confirm: true }`. Paths come from constants, never from the request. Deletes only children of the target, never follows symlinks, never touches `sessions/`, `data/` (other than `data/backups` for `panel_backups` and, through the broadcaster, `data/broadcast-media` for `broadcast_media`), the database or `data/status_save.json`; `logs` are truncated, not unlinked; `temp_media` skips entries newer than 60 s. `200 { freedBytes, removed, skipped }`. `422 not_purgeable` for `database`; `404` for an unknown category; `409 busy` for a purge of the same category already running. `antidelete_cache` warns in the confirmation text that deleted messages of the last hour can no longer be recovered; `panel_backups` removes the pre-restore backups; `broadcast_media` deletes only the media of finished `once` broadcasts (U15) and keeps the rest, so a scheduled or recurring broadcast never loses its media: the answer counts the media kept in `skipped` and never fails for them, and the confirmation text says how many are kept.

### 2.15 Bot texts

| ID | Method and path | Auth | CSRF | Flags | Audit | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| TXT-1 | `GET /admin/api/texts?q&command&overridden&changed&page&pageSize` | session | no | | none | FR-057, FR-060, US12 scenarios 1 and 4 |
| TXT-2 | `PUT /admin/api/texts/:lang/:key` | session | yes | | `text.update` | FR-058, FR-059, US12 scenarios 2 and 3 |
| TXT-3 | `DELETE /admin/api/texts/:lang/:key` | session | yes | | `text.reset` | FR-058, US12 |

- **TXT-1**: `q` searches keys and texts in both languages (at most 100 chars); `command` is a command name (maps a text to a command through its plugin segment, description key or file name); `overridden=1` and `changed=1` (original changed since the override) filter. `200 { items: [{ key, group, command, placeholders, texts: { en: { original, effective, overridden, originalChanged }, fr: { ... } } }], page, pageSize, total }`. Covers every key of `lang/en.json` (1004 keys, identical in `fr.json`), menu and command descriptions included.
- **TXT-2**: `:lang` is `en` or `fr` (other locales fall back to English), `:key` must exist in `lang/en.json`. Body `{ text }`: 1 to 4000 characters and **the same multiset of `{n}` placeholders as the original** (`fields.text = placeholder_mismatch` with `params.expected`, e.g. `["{0}", "{1}"]`), else `too_long` / `required`. `200 { item }`. Applies at the next message (in-memory map replaced synchronously); descriptions and the menu follow. The override survives bot updates; the stored fingerprint of the original flags `originalChanged`. `404` for an unknown key.
- **TXT-3**: reverts to the original. `200 { item }`.

### 2.16 Alerts, logs, statistics, audit

| ID | Method and path | Auth | CSRF | Flags | Audit | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| ALR-1 | `GET /admin/api/alerts` | session | no | | none | FR-061, FR-062, FR-063, US13 |
| LOG-1 | `GET /admin/api/logs?level&q&since&limit` | session | no | touch:n, db:r | none | FR-034, US7 |
| STAT-1 | `GET /admin/api/stats` | session | no | | none | FR-035, US7 |
| AUD-1 | `GET /admin/api/audit?page&pageSize&action&result&from&to` | session | no | | none | FR-036 |

- **ALR-1**: `200 { canDeliver, ownerCount, types: [{ type, settingKey, enabled, lastSentAt, pending }], recent: [{ id, type, status, createdAt, sentAt }] }`. Types and toggles: `reconnected` / `ALERT_RECONNECT`, `errors_series` / `ALERT_ERROR_BURST`, `key_refused` / `ALERT_KEY_REFUSED`, `login_blocked` / `ALERT_LOGIN_BLOCKED`, `new_origin` / `ALERT_NEW_ORIGIN`, `update_available` / `ALERT_UPDATE`; all on by default (U12). `canDeliver: false` when no owner is configured (US13 scenario 5). Toggling goes through SET-2 on the `ALERT_*` keys (this page is a convenience view). Rate limits (one error-burst alert per hour, one key-refused alert per service per 24 h, one update alert per version) and the owner-DM throttle (FR-064) are engine rules without an HTTP surface.
- **LOG-1**: `level` is a **minimum** (`trace`, `debug`, `info`, `warn`, `error`, `fatal`; `error` returns error and fatal), `q` a case-insensitive substring (at most 100 chars), `since` a sequence number (entries with a greater `seq`), `limit` 1 to 1000 (default 200). `200 { entries: [{ seq, ts, level, name, msg }], lastSeq }` from the 1000-entry in-memory ring, values scrubbed by the redactor, QR output never present. Polling fallback of the SSE `log` event.
- **STAT-1**: `200 { timezone, days: [{ day, messages }] (7 entries, zero-filled, oldest first), topCommands: [{ name, count }] (10), failedCommands: [{ name, count }], topGroups: [{ jid, name, count }] (10) }`; the window is the last 7 days in the bot's `TIMEZONE`.
- **AUD-1**: `action` is a prefix (`login`, `setting.update`...), `result` is `ok`, `fail` or `refused`, `from` / `to` ISO instants; pageSize at most 200. `200 { items: [{ id, at, action, target, origin, result, detail }], page, pageSize, total }`; `detail` is the sanitised JSON (no secret).

---

## 3. Live stream (SSE) and polling fallback

### 3.1 Transport

`GET /admin/api/events?logs=0|1&since=<seq>` (EVT-1): one multiplexed stream per browser tab. `logs=1` adds the `log` topic and is set only while the logs view is open (the client reconnects to change it). `since` is the `seq` of the last log entry the client already holds (from LOG-1); the server replays ring entries after it and then streams new ones.

- Auth `session`, `touch:n`, `Sec-Fetch-Site` same-origin when sent, `Origin` checked when present. Limits: 5 streams per session, 20 total (`429 rate_limited`); a client whose `res.writableLength` exceeds 1 MiB is dropped.
- Headers: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, plus the section 1.13 set. The stream starts with `retry: 3000` and a 2 KB comment to flush buffering proxies.
- **Heartbeat**: a comment line (`: hb`) every 15 s (under nginx's 60 s idle default). The session is re-checked at every heartbeat; on idle or absolute expiry the server sends the `session` event and ends the stream.
- **Initial snapshot**: right after connecting the server sends one `state` event and one `pairing` event (current values). With `logs=1` it replays log entries after `Last-Event-ID` (the `id:` of a `log` event is its `seq`; the browser sends the header on its automatic reconnects and it overrides `since`), or after `since` on the first connection, or none when neither is given.
- **Reconnection**: `EventSource` reconnects by itself after `retry` ms. Only the `log` topic is replayable; for every other topic the snapshot on reconnect carries the truth. All timers are `unref()`ed and start lazily; the 2 s state ticker runs only while at least one client is subscribed.
- **Polling fallback**: after 3 consecutive `EventSource` errors the client polls every 2 s: `GET /admin/api/state` (DASH-1), `GET /admin/api/pairing` (PAIR-1, plus PAIR-2 with the new `v`), `GET /admin/api/logs?since=<seq>` (LOG-1), `GET /admin/api/jobs/:id` (JOB-1) and `GET /admin/api/broadcasts/:id` (BC-4) for the job or broadcast being watched. None of these extends the session. A 5 s poll plus latency could exceed FR-012's 5 seconds, hence 2 s.

### 3.2 Events

| Event | `id:` | Payload | Emission |
| --- | --- | --- | --- |
| `state` | none | the DASH-1 object | pushed immediately on `ready`, `close`, `qr`, restart phases, a settings change affecting `restartPending`, job start or end; otherwise at most one per second from the ticker (memory, uptime, counters) |
| `pairing` | none | `{ status, registered, number, qr: { version, issuedAt } or null, code: { pending, expiresAt } or null }` (PAIR-1 shape, no QR string, no pairing code) | on every QR renewal and status change; the client then fetches PAIR-2 with the new `v` |
| `log` | log `seq` | `{ seq, ts, level, name, msg }` | every ring entry while `logs=1`; scrubbed |
| `job` | none | `{ id, type, status, phase, progress, result, error }` for `restart`, `update.check`, `update.apply`, `ytdlp.update`, `restore`; and for broadcasts `{ type: "broadcast", broadcastId, runId, status, total, sent, failed, cancelled, pending, updatedAt }` | on every phase change; for a broadcast at every settled target (so at the sending pace, at least every 2 s) |
| `session` | none | `{ reason: "expired" or "revoked" or "logout" }` | once, then the server closes the stream |

Payloads never contain a secret, the QR string or the pairing code. Event names are exactly those five.

### 3.3 Banners (carried in `state.banners`)

`{ id, severity: "info" or "warn" or "error", params }`. The list is recomputed on every `state` event; the SPA renders each `id` through `banners.<id>` in its own catalog.

| `id` | Severity | Source | Condition | `params` | Cleared when |
| --- | --- | --- | --- | --- | --- |
| `restart_needed` | info | server | a `restart`-effect setting differs from the value in force (FR-016, US3 scenario 4) | `keys` | RST-1 completes |
| `update_restart` | warn | server | an update was applied and no supervisor restarts the process (U6) | `from`, `to` | the process restarts |
| `undeclared_proxy` | warn | server | forwarded headers arrived from a peer not matched by `PANEL_TRUST_PROXY` (U10, FR-005) | `headers` | the setting is declared and the process restarted |
| `no_https` | warn | **client** | `location.protocol !== "https:"` and the hostname is not `localhost`, `127.0.0.1` or `[::1]` (FR-009) | none | never on plain HTTP |
| `secret_key_lost` | error | server | `data/panel.key` missing or a stored secret fails to decrypt (FR-017) | `keys` | the values are re-entered |
| `db_unavailable` | error | server | the database is unreachable (spec edge case) | none | it answers again |
| `no_owner` | warn | server | `SUDO` is empty: owner commands and alerts have no recipient (US13 scenario 5) | none | an owner is configured |
| `maintenance` | info | server | a restore is applying | `phase` | it ends |
| `restore_interrupted` | error | server | boot found `restore.lock` (previous state kept) | none | dismissed by a restart |
| `logged_out` | warn | server | status `logged_out` (device unlinked from the phone) | none | pairing completes |
| `invalid_file_values` | warn | server | the file/environment holds invalid values replaced by defaults (spec edge case) | `keys` | the file is fixed and the process restarted |

---

## 4. Coverage matrix

Every requirement that touches the panel, with the route(s) or rule that satisfies it. "Engine" means behaviour without an HTTP surface, specified in the research streams and `data-model.md`.

| FR | Route(s) and rules |
| --- | --- |
| FR-001 | router `auth` mandatory (1.3); STA-1 public by design; AUTH-1..AUTH-6 and every other route `session`; SC-005 enumeration (section 5) |
| FR-002 | AUTH-4 creates the single account; no user-management route exists |
| FR-003 | console link (engine); STA-3, AUTH-4 |
| FR-004 | AUTH-4, AUTH-5 password policy |
| FR-005 | AUTH-2 and 1.12 login throttle; banner `undeclared_proxy`; AUTH-1 `proxyHint` |
| FR-006 | 1.5 sessions (24 h idle, 7 d absolute); AUTH-3; SSE `session` event |
| FR-007 | STA-3, AUTH-4 with `purpose: "reset"`; `tools/admin-reset.js` and `data/admin-reset` (engine) |
| FR-008 | 1.6 guard; 1.13 no CORS under `/admin` |
| FR-009 | banner `no_https` (client, 3.3); AUTH-1 `https` |
| FR-010 | 1.13 CSP and static map; STA-1 |
| FR-011 | 1.2 legacy routes frozen |
| FR-012 | DASH-1, EVT-1 `state`, polling fallback |
| FR-013 | RST-1, JOB-1, EVT-1 `job` |
| FR-014 | SET-1 (`origin`, default, current value, theme, inactive group) |
| FR-015 | SET-2 validation, all-or-nothing, `fields` per key |
| FR-016 | catalog `effect`; SET-1/SET-2 `restartPending`; banner `restart_needed` |
| FR-017 | SET-1 `{ set, last4 }`; SET-2 write-only; 1.9 never echoed; encryption at rest (catalog) |
| FR-018 | SET-2 `op: default` |
| FR-019 | catalog `readonly`; SET-2 `readonly` field error |
| FR-020 | 1.11, SET-2 `version`, `409 conflict` |
| FR-021 | SET-2 `op: revert`, `origin` in SET-1 |
| FR-022 | SET-3, 1.12 (10 s per service) |
| FR-023 | PAIR-1, PAIR-2, PAIR-3, EVT-1 `pairing` |
| FR-024 | PAIR-4 |
| FR-025 | CMD-1 |
| FR-026 | CMD-2 (scope `*`) |
| FR-027 | CMD-2, GRP-17 |
| FR-028 | GRP-1, GRP-2 |
| FR-029 | GRP-3 to GRP-17, GRD-1 |
| FR-030 | engine: panel writes go through the same stores and cache invalidations as the commands; GRP-4 to GRP-17 |
| FR-031 | engine: `plugins/groupguard.js`; settings via GRD-1, GRD-2 |
| FR-032 | `warnings: ["bot_not_admin"]` in GRP-3, GRD-1; `409 bot_not_admin` in GRD-2 |
| FR-033 | CHAT-2, CHAT-3 |
| FR-034 | LOG-1, EVT-1 `log` |
| FR-035 | STAT-1 |
| FR-036 | AUD-1, audit vocabulary (1.15) |
| FR-037 | AUTH-6 `uiLang`; error codes translated client-side (1.8) |
| FR-038 | UI only (no route); 360 px manual checklist |
| FR-039 | 1.10 confirmation convention (RST-1, PAIR-4, SET-2 `owners_empty`, GRP-6, GRP-16, BAK-1, BAK-3, BC-3, BC-9, MNT-3, MNT-5, MNT-7) |
| FR-040 | 1.1 activation and listen failure; STA-2 |
| FR-041 | AUTH-6 `theme` |
| FR-042 | DATA-1 (`reminders`), DATA-2 (cancel) |
| FR-043 | DATA-1 (`economy`), DATA-3 |
| FR-044 | DATA-1, DATA-2 for keywords, sticker commands, afk, tasks, ideas, quotes |
| FR-045 | engine: shared stores; DATA-2 invalidations |
| FR-046 | CHAT-1, BC-3 `unknown_target` |
| FR-047 | UP-1, BC-2, BC-3 (`text`, `uploadId`, `confirmTargets`) |
| FR-048 | BC-3 `spacingMs`, BC-8, BC-10, EVT-1 `job`; no retry, new broadcast to the failed destinations: BC-10 + BC-3 (U14) |
| FR-049 | BC-3 `runAt`; engine: persisted runs, at most once, 1 h expiry |
| FR-050 | BC-3 `recurrence`, BC-5, BC-6, BC-7, BC-9; engine: occurrence uniqueness, 1 h skip |
| FR-051 | BAK-1 |
| FR-052 | BAK-2, BAK-3, BAK-4, BAK-5, UP-1 |
| FR-053 | BAK-2 (`backup_too_new`, older accepted, dialect-neutral) |
| FR-054 | MNT-1, MNT-2, MNT-3 |
| FR-055 | MNT-4, MNT-5 |
| FR-056 | MNT-6, MNT-7 (incl. `broadcast_media`, U15) |
| FR-057 | TXT-1 |
| FR-058 | TXT-2, TXT-3 |
| FR-059 | TXT-2 `placeholder_mismatch` |
| FR-060 | TXT-1 `originalChanged`; override survives updates; included in backups (BAK-1) |
| FR-061 | ALR-1, SET-2 on `ALERT_*`; engine: triggers |
| FR-062 | engine: persisted rate limits; ALR-1 `lastSentAt` |
| FR-063 | engine: outbox flushed on reconnect; ALR-1 `canDeliver`, banner `no_owner` |
| FR-064 | engine: `notifyOwners` throttle (`cooldown.hit`, one per command per 10 min) |

Success criteria that depend on this contract: SC-004 (secret scan over every `GET`, error bodies, logs, audit), SC-005 (route enumeration), SC-006 and SC-007 (EVT-1 and polling latency), SC-010 (1.2 legacy contract test), SC-013 (CMD-2), SC-014 (TXT-2).

---

## 5. Contract tests derived from this file

All generated from `router.routes()` so a new route is covered automatically (`test/admin-security.test.js`, `test/admin-secrets.test.js`, `test/panel.test.js`):

1. The `public` and `setup` sets equal the snapshot of section 1.3.
2. Every other route without a cookie answers `401 unauthenticated` for each declared method; a wrong method answers `405` with `Allow`; an unknown `/admin/api/*` path answers the JSON `404`; `OPTIONS` under `/admin` answers `405` with no `Access-Control-*`.
3. With a session, every unsafe route is refused (`403`) without `X-CSRF-Token`, with a wrong one, with `Origin: https://evil.example`, with no `Origin` and no `Referer`, with `Sec-Fetch-Site: cross-site`, and (`415`) with `text/plain` or form content types; accepted only with all valid.
4. Calling every `GET` route with a session leaves a before/after dump of all tables unchanged.
5. Every response status class (200, 201, 202, 303, 304, 401, 403, 404, 405, 413, 415, 422, 429, 500, 503) carries the 1.13 headers and no `Access-Control-*`.
6. Traversal vectors against static paths (`..`, `%2e%2e`, `%00`, `\`, double encoding) never return file content.
7. Throttling with a fake clock (5 failures, 6th refused with the right password, 15 min later accepted); `X-Forwarded-For` ignored from an untrusted peer and honoured with `PANEL_TRUST_PROXY=loopback`; session rotation and hashed-at-rest id; idle and absolute expiry.
8. Secret scan (SC-004): seed distinct known values in every secret setting, `PANEL_TOKEN`, `SESSION_ID`, the database URL password, the admin password, the setup token, the CSRF token, a fake QR string and a backup passphrase; none appears in any response body or header (the session cookie excepted by design), in the log ring, in captured stdout, in the audit table or in a database dump; invalid secret submissions are not echoed in `422` bodies.
9. Error envelope: every non-2xx body parses as `{ error: { code } }` with a code from section 1.9.
10. Legacy contract: status, key set and `Content-Type` of every row of section 1.2, and the existing `test/panel.test.js` unchanged.
11. Every `api("...")` path the SPA uses exists in the route registry; every FR of section 4 maps to at least one registered route or an engine test.
