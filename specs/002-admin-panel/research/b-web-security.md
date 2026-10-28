# Research B: web layer, security, live updates, logs, panel UI (feature 002-admin-panel)

Scope: FR-001..011, live updates (FR-012, SC-007), logs (FR-033), UI (FR-036/037/038/040), SC-004, SC-005, SC-008, SC-009.
Date: 2026-10-28. Node 24.20.0. Nothing was installed or modified; measurements are throw-away `node -e` scripts.

## Decision summary

| # | Topic | Decision |
|---|-------|----------|
| B1 | HTTP | Raw `node:http` + in-house router (about 150 lines) with a mandatory per-route `auth` flag; JSON bodies capped; uploads as raw `application/octet-stream` streamed to disk (no multipart, no busboy) |
| B2 | UI | Static SPA: Preact 10.29.8 + htm 3.1.1 as ES modules, vendored under `lib/admin/public/vendor/`; zero server-side HTML templating; strict CSP |
| B3 | Passwords | `crypto.scrypt` N=2^15 r=8 p=3, self-describing hash, concurrency gate 1; accounts and one-time tokens in DB (tokens hashed) |
| B4 | Sessions | DB-backed (hashed ids) + in-process cache, `HttpOnly; SameSite=Strict`, `Secure` when HTTPS, rotation at login, 24 h sliding idle expiry |
| B5 | Cross-site | SameSite=Strict + per-session CSRF header + Origin/Sec-Fetch-Site checks + JSON-only bodies; no CORS on `/admin`; trust proxy via `PANEL_TRUST_PROXY` (CIDR list) |
| B6 | Throttling | In-memory per-origin limiter (IPv6 grouped by /64), scrypt gate; block state lifted by consuming a reset link |
| B7 | Live updates | One multiplexed SSE stream per tab (`/admin/api/events`) + 2 s polling fallback |
| B8 | Logs | Shared logger factory `lib/utils/logger.js` (replaces 19 `pino(` sites) + `console.*` wrap + value-based redactor + 1000-entry ring |
| B9 | i18n/theme | Separate `lib/admin/public/i18n/{en,fr}.json` (not `lang/`), client-side `t()`, API returns error codes; CSS variables, mobile-first |
| B10 | Tests | Route registry enumerated by tests (401 / CSRF / secret scan), `.mjs` browser modules importable from node:test, forked memory probe |

New npm dependencies: **none** (see "Dependencies").

---

### B1. HTTP layer, body parsing and uploads

**Decision**
- Keep `node:http`; add a tiny router in `lib/admin/http/router.js`. Every route is registered through one function and the registry is enumerable:
  `route({ method, path: "/admin/api/groups/:jid", auth: "session" | "public", csrf?: bool (default true for POST/PUT/PATCH/DELETE), touch?: bool (default true), bodyLimit?: bytes, handler })`.
  `auth` has no default: registering without it throws at boot (deny by default). `router.routes()` returns the table for tests.
- Matching: exact method + segment match, `:param` decoded once with `decodeURIComponent` (400 on malformed), no regex routes. Unknown `/admin/api/*` gives JSON 404 `{error:"not_found"}`; known path with another method gives 405 with `Allow`. `/admin/` owns its prefix and must never fall into the legacy catch-all (panel.js:116-119 answers 200 HTML for any unknown path).
- Legacy compatibility: `panel.createServer()` (panel.js:64) stays exported and keeps the same switch; it becomes `(req,res) => admin.handle(req,res) || legacy(req,res)` where `admin.handle` only claims URLs starting with `/admin`. The same `lib/admin/server.js#createPanelServer()` is used by `index.js` (no HTTP server today) so FR-039 holds in both modes.
- JSON body: `Content-Type: application/json` required (else 415), default cap 64 KiB (per-route override up to 1 MiB), early 413 on `Content-Length`, byte counting while streaming, 400 on parse error, then **schema validation that builds a fresh object** (never merge parsed input; avoids `__proto__` pollution). A route that does not declare `bodyLimit` rejects any body.
- Uploads (restore file: tens of MB; broadcast media up to `MAX_UPLOAD` = 230 MB by default, config.js:159): two-step flow. `PUT /admin/api/uploads?purpose=backup|broadcast` with a raw `application/octet-stream` body is streamed to `data/admin-uploads/<random-id>.part` (mode 0600), renamed on success, returns `{uploadId, size, mime}`. The follow-up JSON request (create broadcast, restore) references `uploadId`. Rules: size checked against `Content-Length` first, then counted; per-purpose cap; one upload in flight per session; 1 h TTL janitor; total quota; the client filename is metadata only (sanitized basename, never used in a path); MIME sniffed with `file-type` (already a dependency), not trusted from the header. The browser uses `XMLHttpRequest` for upload progress.
- Server limits: `headersTimeout` 15 s, `maxHeadersCount` 50, keep Node's `requestTimeout` (300 s, enough for 50 MB at about 1.3 Mbps), `maxConnections` 256. `server.closeAllConnections()` on close (SSE sockets would otherwise block `server.close`, which test/panel.test.js:58 awaits).
- Handler exceptions give `500 {error:"internal_error", requestId}`; the stack goes to the logger via `safeLog(err)` (lib/utils/http.js:306), never to the client. The access log is `debug` level and records method + route pattern + status + duration only (no query string, no headers: the setup token travels in a query string).

**Rationale** Zero dependencies and no extra RSS; the existing server is already `node:http`; a home-made registry is what makes SC-005 testable (a test can iterate every route). The surface is about 60 JSON routes with no middleware ecosystem need.
Octet-stream avoids a multipart parser, avoids buffering in memory, and keeps validation errors per field in the later JSON step.

**Alternatives considered**
- Express 5.3.0 (28 direct deps), Fastify 5.12.7 (15 direct deps; excellent `inject()` and `onRoute`, but heavier, own logger and plugin model clash with pino setup), find-my-way 9.10.0 (3 deps; saves only about 40 lines). Rejected: dependency weight and `check-unused-deps` churn for no capability we lack.
- multipart: `busboy` 1.6.0 (last release 2022-04-19, npm modified 2026-04), `@fastify/busboy` 3.2.4. Rejected: extra parser, boundary edge cases, forces form-encoded errors.
- WebSocket upload: no.

**Evidence** panel.js:64-124 (switch router + wildcard CORS at 69-73), panel.js:235-240 (`hasValidToken`), test/panel.test.js:49-58 (server on port 0, `server.close`), config.js:159 (`MAX_UPLOAD`), package.json (`file-type ^22.2.0`, `qrcode ^1.5.4` present). npm data above.

**Files impacted** new `lib/admin/http/{router,request,response,static,security,trustProxy}.js`, `lib/admin/server.js`; edit `panel.js` (createServer wrapper), `index.js` (start the shared server).

---

### B2. UI approach, asset delivery, XSS strategy

**Decision** Option (b): a static single-page app with **Preact 10.29.8 + hooks + htm 3.1.1**, written as native ES modules in `.mjs` files, **vendored** (committed copies), no build step. The server sends **no HTML it composed**: `GET /admin/` serves the static `public/index.html` shell (no inline script, no inline style, no data); all data and the CSRF token come from authenticated JSON (`GET /admin/api/session`). Login and setup are SPA views posting JSON.
- Vendored files, all measured through jsDelivr: `preact@10.29.8/dist/preact.mjs` 11,693 B; `preact@10.29.8/hooks/dist/hooks.mjs` 3,647 B (its bare `from"preact"` is rewritten to `from"./preact.mjs"`, one documented sed, because an import map would need an inline `<script>` and a CSP hash); `htm@3.1.1/dist/htm.mjs` 1,207 B. Total about 16.5 KB, about 6 KB gzipped. Licences (MIT, MIT, Apache-2.0) copied beside them with `vendor/MANIFEST.json` (version, source URL, sha256 of upstream and of the committed file). A test recomputes the hashes.
- Why vendored and not served from `node_modules`: `.yarnrc.yml` uses `nodeLinker: node-modules` but production images and panel hosts may prune; serving `node_modules` paths widens traversal risk; vendored copies keep `package.json` unchanged (`tools/check-unused-deps.js` scans only `dependencies`) and make the supply chain a reviewed diff.
- `.mjs` extension on purpose: package.json has no `"type":"module"`, so a `.js` browser module would be parsed as CommonJS by node:test; `.mjs` can be `import()`ed in tests (pure helpers: api client with injected `fetch`, validators, `t()`, formatters). `tools/check-unused-deps.js` already lists `.mjs` (line 19), `test/i18n.test.js` lists only `.js` (so browser code is not linted as bot code).
- Static serving (`http/static.js`): at boot, walk `public/` once and build a `Map<urlPath, {buffer, etag, type}>` (about 0.3 MB). Only keys of this map are servable, so there is no path-to-file mapping to traverse; `..`, `%2e`, `%00`, `\` simply miss and give 404. Allowed types: html, mjs/js, css, json, svg, png, ico. `ETag` = sha1, `Cache-Control: no-cache`, 304 support. Assets are public (the login view needs them) and contain no secret; this is the intended reading of FR-001 ("hors connexion").
- Escaping: Preact escapes text nodes and attributes by default. A static test over `lib/admin/public/**` (excluding `vendor/`) fails on `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `dangerouslySetInnerHTML`, `document.write`, `eval(`, `new Function`, `setAttribute("style"`, `javascript:` URLs, inline `<script>`/`style=`/`on*=` in the HTML, and any `https?://` URL outside an allowlist (FR-010). User-controlled strings (group names, texts) are rendered only as text. The QR is served as `GET /admin/api/pairing/qr.svg` (session required, `no-store`, own `Content-Security-Policy: default-src 'none'`), generated with the existing `qrcode` package, shown through `<img>`.
- `window.confirm` is not used; confirmations use one `<ConfirmDialog>` on native `<dialog>.showModal()` (FR-038).

**Rationale** Strict `script-src 'self'` and `style-src 'self'` are satisfied without exceptions (htm uses no `eval`/`Function`; Preact sets styles through CSSOM, which CSP allows). A JSON API is the single contract: tests use plain `fetch`, the secret scan reads JSON, and per-field errors, version conflicts, the schema-driven settings form (100+ settings) and SSE state are natural in a component model. 16 KB is the smallest of the three.

**Alternatives considered**
| Option | Size (min / gzip) | CSP | Verdict |
|---|---|---|---|
| (a) htmx 2.0.11 (0BSD, 2026-09-22) + SSE ext 2.2.4 + Alpine | htmx 52,182 / 16,826 B; `@alpinejs/csp` 3.17.4 (MIT, 2026-09-21) 72,198 / 23,788 B; plain Alpine 55,891 / 19,895 B | Alpine standard build needs `unsafe-eval`; CSP build forbids inline expressions (every handler becomes `Alpine.data`); htmx needs `allowEval:false`, `includeIndicatorStyles:false`; htmx `latest`=2.0.11, `next`=4.0.0 (not stable) | About 8x larger; every interaction needs a server-rendered fragment, so XSS escaping moves to many server templates, and per-field errors need partials. Rejected |
| (b) Preact + htm | about 16.5 KB raw | clean | **Chosen** |
| (c) vanilla modules | 0 KB | clean | Hand-rolled DOM diffing and re-render logic across 13 areas; high `innerHTML` temptation; rejected |

Preact 11.0.1 (2026-10-08, 20 days old, `.mjs`-only) is eligible, but 11.x is a month-old major; 10.29.8 (2026-08-01) is the last 10.x. Upgrading later is a vendoring change only. Client router: hash-based (`/admin/#/groups`), so the server needs no history fallback; views are lazy `import()`ed.

**Evidence** `npm view` data above (dates, dist-tags, licences); jsDelivr sizes; `tools/check-unused-deps.js:13,17,19`; `test/i18n.test.js:138-160` (what it scans).

**Files impacted** new `lib/admin/public/{index.html, css/{theme,app}.css, js/theme-init.js, js/{app,router,api,i18n,live,ui}.mjs, js/views/*.mjs, js/components/*.mjs, icons.svg, vendor/*}`; new `test/admin-frontend.test.js`.

---

### B3. Password hashing, account, setup and reset tokens

**Decision**
- `crypto.scrypt` (async, libuv pool). Parameters N=2^15, r=8, p=3 (32 MiB, an OWASP-listed combination), 16-byte random salt, 32-byte key, `maxmem: 64 MiB` (Node's default 32 MiB rejects this combination: `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`, measured). Stored as `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>`; `needsRehash()` re-hashes on a successful login when parameters change. Verification uses `crypto.timingSafeEqual` on equal-length buffers.
- Policy: NFKC-normalize, length 12..256 code points, reject all-same-character, trivial sequences and a small built-in denylist (no zxcvbn dependency). Password change requires the current password and revokes all other sessions.
- **Concurrency gate**: at most 1 hash in flight, queue of 4, then `429`. Measured: 4 parallel scrypt at 32 MiB gave +128.8 MiB peak RSS; `ecosystem.config.js:9` restarts at 500M.
- Storage: three Sequelize models (auto-loaded, additive `sync()`): `AdminAccount` (single row: `passwordHash`, `createdAt`, `lastLoginAt`, `prefs` JSON for language/theme), `AdminSession` (B4), `AdminToken` (`purpose` setup|reset, `tokenHash`, `expiresAt`, `usedAt`). They live in the database (the one store that exists on every host, including ephemeral-filesystem ones with Postgres) and are **excluded by name** from backup export and restore (FR-050).
- Setup/reset token: 32 random bytes, base64url; only its SHA-256 is stored; compared with `timingSafeEqual`; 30 min; single use (`usedAt` set in the same transaction that creates the account). At boot with no account: delete older setup tokens, create one, print `${PANEL_PUBLIC_URL || "http://localhost:" + PORT}/admin/setup?token=...` with the **original** `process.stdout.write` (captured at module load) so it is shown to the human but registered as a secret for the ring (B8). Never logged through pino.
- Link handling: `GET /admin/setup?token=` validates without consuming, sets `owb_setup` (HttpOnly, SameSite=Strict, Path=/admin/api/setup, Max-Age = remaining TTL) and answers `303 /admin/#/setup` with `Referrer-Policy: no-referrer`, so the token leaves the URL bar, history and Referer. `POST /admin/api/setup {password}` consumes it, creates the account and a session. A link scanner that only fetches the page cannot consume it.
- Reset (FR-007): `node tools/admin-reset.js` (loads `config.js`, same `DATABASE_URL`) calls `issueResetToken()`, prints the link, writes an audit row `reset_issued source=cli`. For hosts without a second shell: an empty marker file `data/admin-reset` is checked at boot, triggers the same function and is deleted. Consuming a reset token sets the new password, revokes all sessions and clears in-memory lockouts.

**Rationale** scrypt is built in (no native addon, no Alpine/glibc build issues, stable API since Node 10), memory-hard, and 141 ms here. Hash at rest in DB keeps sessions and the account across process restarts and out of backups.

**Alternatives considered** `argon2` 0.45.1 npm (native addon; build tooling on panel hosts). `bcryptjs` 3.0.3 (pure JS, 72-byte limit, not memory-hard). Built-in `crypto.argon2` exists in Node 24.20 (argon2id m=19 MiB t=2: 26 ms measured) but landed in 24.7 while `engines` says `>=24.0.0`; the self-describing hash string allows a later switch. Accounts in a file under `data/`: breaks on hosts where only the DB persists and complicates the "excluded from backup" rule. Plain-text emergency env password: rejected.

**Evidence** benchmark (Node 24.20.0): N=2^15,r=8,p=3 141 ms; N=2^16,p=2 194 ms; N=2^14,p=5 112 ms; N=2^17,p=1 219 ms; default maxmem error; `typeof crypto.argon2 === "function"`. `ecosystem.config.js:9`. CLAUDE.md "Database" (additive sync, models auto-loaded by filename).

**Files impacted** new `lib/admin/auth/{password,tokens,routes}.js`, `lib/database/models/{AdminAccount,AdminSession,AdminToken}.js`, `tools/admin-reset.js`; backup exclusion list (stream owning backups); `docs/` note.

---

### B4. Sessions and cookies

**Decision**
- Session id: 32 random bytes base64url; **only SHA-256(id) is stored** (`AdminSession`: `idHash`, `csrf`, `createdAt`, `lastSeenAt`, `expiresAt`, `ip`, `uaShort`). A hot `Map<idHash, session>` cache (TTL 60 s) avoids one DB read per request; logout and password change update both. If the DB is unreachable, cached sessions keep working and uncached ones get `503 db_unavailable` (not 401, so the SPA does not drop the user to login), matching the edge case in the spec.
- Rotation: a new id is issued at every successful login, setup and password change; any pre-login cookie is discarded. Max 10 live sessions (oldest evicted).
- Expiry: sliding `lastSeenAt + 24 h`; the DB write is write-behind (at most once per 60 s per session). Routes flagged `touch:false` (SSE heartbeats, 2 s state/log polling) do **not** extend the session, otherwise a forgotten open tab would never expire. `POST /admin/api/logout` deletes the row and clears the cookie. Optional hardening, easy to drop: absolute lifetime 7 days.
- Cookie: `Set-Cookie: __Host-owb_sid=<id>; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=86400` when the request is HTTPS (socket `encrypted`, or `X-Forwarded-Proto: https` from a trusted peer); otherwise the same without `Secure` and without the `__Host-` prefix (`owb_sid`). Browsers drop `Secure` cookies on plain HTTP, and the spec allows plain-HTTP use with a warning, so `Secure` must be conditional. Both names are accepted on read.
- Strict and external links: only the first document request lacks the cookie, so `index.html` is public and the SPA's subsequent `fetch` calls are same-site; no redirect loop.
- FR-009 warning: computed **in the browser** (`location.protocol !== "https:"` and hostname not `localhost`/`127.0.0.1`/`[::1]`), which is correct whatever the proxy configuration. The server only adds a diagnostic `proxyHint` when `X-Forwarded-*` headers arrive from an untrusted peer.

**Rationale** DB-backed sessions survive `process.exit(0)` restarts (legacy `/api/restart`, PM2 memory restarts, restore-then-restart in US10) so the admin returns to the dashboard instead of the login page; hashed ids mean a DB leak or backup copy yields no usable cookie.

**Alternatives considered** in-memory only (loses every session on any restart, and FR-013/US10 restarts are first-class flows); signed stateless cookies (no revocation); `localStorage` tokens (readable by any XSS).

**Evidence** panel.js:268-271 (`process.exit(0)` restart), `ecosystem.config.js:9`, spec edge cases "Session expirée pendant la saisie" and "base indisponible".

**Files impacted** new `lib/admin/auth/sessions.js`; `lib/admin/http/request.js` (cookie parse/serialize).

---

### B5. Cross-site defences, headers, CORS, client address

**Decision (state-changing requests, in this order, all must pass)**
1. Method is POST/PUT/PATCH/DELETE only; no GET/HEAD route may mutate (registry flag `mutates`, checked by a test).
2. Valid session cookie (SameSite=Strict).
3. `Origin` present and its host[:port] in the allowed set = {`Host` header, trusted `X-Forwarded-Host`, host of `PANEL_PUBLIC_URL`}; absent `Origin` falls back to `Referer`; both absent gives 403. A mismatch answers `403 origin_mismatch` and logs once per minute the received and expected hosts (covers nginx `proxy_set_header Host $proxy_host`; hint to set `PANEL_PUBLIC_URL`).
4. `Sec-Fetch-Site`, when sent, must be `same-origin` (`none` is not accepted for unsafe methods).
5. `X-CSRF-Token` equals the session's token (random, returned by `GET /admin/api/session` and the login response, kept in a JS variable, compared with `timingSafeEqual`).
6. `Content-Type` is `application/json` or, for the upload route, `application/octet-stream` (a cross-site form cannot send either without a CORS preflight).
`GET /admin/api/events` (EventSource cannot set headers) requires the session plus `Sec-Fetch-Site: same-origin` and the Origin check when an `Origin` is present. Legacy `POST /api/restart` is bearer-token based and cookie-less, so CSRF-immune; unchanged.

**Response headers** on every admin response, errors included (set in one `finish()` helper):
`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'` (no `upgrade-insecure-requests`: it would break the allowed plain-HTTP use); `X-Frame-Options: DENY`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`; `Cross-Origin-Opener-Policy: same-origin`; `Cross-Origin-Resource-Policy: same-origin`; `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`; `Cache-Control: no-store` on all `/admin/api/*`. HSTS is left to the proxy.

**CORS**: no `Access-Control-*` header on any `/admin` response and `OPTIONS` there gives 405, so cross-origin `fetch` dies at preflight. Legacy endpoints today send `Access-Control-Allow-Origin: *` on everything including `POST /api/restart` (panel.js:69-76). Keep the wildcard only for the read-only GET endpoints (`/`, `/health`, `/healthz`, `/status`, `/ping`, `/metrics`, `/api/info`) to preserve FR-011/SC-010 behaviour; drop it from `/api/restart` (bearer-protected; no browser use case; test/panel.test.js asserts nothing on CORS).

**Client address ("origin" for throttling)**: `PANEL_TRUST_PROXY` (startup setting, read-only in the panel): empty = off (socket address only); otherwise a comma list of IPs/CIDRs or the keywords `loopback`, `private`, `all`, matched with `net.BlockList`. `X-Forwarded-For`/`-Proto`/`-Host` are honoured only when the **peer** matches; the client is the right-most XFF entry not itself trusted (proxy-addr algorithm). IPv4-mapped IPv6 is unmapped; IPv6 keys are grouped by /64 (an attacker owns a whole /64). Known limit: behind a proxy not declared in `PANEL_TRUST_PROXY`, all visitors share one origin and five wrong guesses lock the owner out for 15 min; mitigated by the `proxyHint` banner and by the reset link lifting lockouts.

**Rationale** Defence in depth: each layer alone stops classic CSRF; together they also cover non-browser and exotic cases. Host/DNS-rebinding is not exploitable here because the session cookie is host-bound and cookie-less requests get 401.

**Alternatives considered** double-submit cookie CSRF (needs a second cookie, no gain); SameSite=Lax (would allow top-level GET navigation, we have none that mutates but Strict costs nothing with a public shell); CORS allowlist for admin (no use case).

**Evidence** panel.js:69-76, panel.js:246-272; test/panel.test.js:143-159 (public endpoint leak check to extend).

**Files impacted** `lib/admin/http/{security,trustProxy,request,response}.js`; edit `panel.js` CORS lines; new `test/admin-security.test.js`.

---

### B6. Login throttling

**Decision** `auth/rateLimit.js`: `Map<originKey, {fails: number[], blockedUntil}>`, window 15 min, threshold 5, block 15 min, injectable clock. The block is checked **before** any password verification (so the correct password is also refused, scenario 4) and returns `429` + `Retry-After`; blocked attempts do not extend the block. Success clears the key. Entry cap 10,000 with oldest-first eviction. Separate bucket for wrong setup/reset tokens. Events (`lockout`, `login_fail`, `login_ok`, `new_origin`) go to the audit log and to an in-process emitter used by alert type "origine bloquée / nouvelle origine" (US13). In-memory is enough: a restart only resets counters, it never weakens a password.

**Alternatives** persisted counters (extra writes per failure, and the CLI still could not signal a running process); per-IP+UA keys (trivially rotated); exponential delay instead of hard block (contradicts spec scenario 4).

**Files impacted** `lib/admin/auth/rateLimit.js`.

---

### B7. Live updates

**Decision** SSE over a single multiplexed stream per browser tab: `GET /admin/api/events?logs=0|1` (the logs topic is added only while the logs view is open, by reconnecting). Event types: `state` (connection, number, uptime, messages, memory, last 10 errors; at most one per second, pushed immediately on `ready`/`close`/`qr` events and by a 2 s ticker that only runs while at least one client is subscribed), `pairing` (QR version counter, status; the QR image is fetched from `qr.svg?v=`), `log` (`id: <seq>`), `job` (broadcast/restore/update progress), `session` (`expired`, then the server ends the stream). `retry: 3000`; `Last-Event-ID` replays missed log entries from the ring.
- Proxy behaviour: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, a 2 KB initial comment to flush buffering proxies, heartbeat comment every 15 s (below the 60 s idle default of nginx), session re-checked at each heartbeat.
- Limits: 5 streams per session, 20 total, `res.writableLength` above 1 MiB drops the client; all timers `unref()`ed and started lazily so `panel.test.js`'s require-time workaround (test/panel.test.js:27-39) keeps working.
- Fallback: after 3 consecutive `EventSource` errors the client polls `GET /admin/api/state` every 2 s (a 5 s poll plus latency could exceed the "5 seconds at most" of FR-012) and `GET /admin/api/logs?since=<seq>`.
- Pairing needs `lib/baileys/client.js` to emit `qr` (today it only prints it: client.js:137-146) and to expose the current QR string; the QR string is treated as a secret (B8).

**Rationale** One-way push is all that is needed; SSE is native, cookie-authenticated, needs no dependency and reconnects by itself. WebSocket (`ws`) adds a dependency, framing and Origin handling. Polling alone would put SC-007/FR-012 at the edge. Browsers allow 6 HTTP/1.1 connections per origin, hence one stream per tab.

**Alternatives** polling only (simple, proxy-proof, kept as fallback); long polling; WebSocket.

**Files impacted** `lib/admin/http/sse.js`, `lib/admin/events.js` (topic hub: `publish(topic, payload)`), `lib/baileys/client.js` (emit `qr`), `public/js/live.mjs`.

---

### B8. Live logs without secrets

**Today** 20 `pino(` calls in 19 files: `index.js:9` and `panel.js:26` (both with a `pino-pretty` worker-thread transport), 17 module loggers writing raw JSON to stdout (`lib/core/pipeline.js:16`, `lib/plugins/{loader,registry}.js`, `lib/database/index.js:7`, `lib/utils/{settingsCache,viewOnceHandler,gameStore,conversationManager,antiDeleteHandler,memoryManager,statusSaver,downloader,statusListStore}.js`, `plugins/{feedback,vv,update}.js`) and two in `lib/baileys/client.js:93,98` (Baileys, `silent` by default). Plus 114 `console.*` call sites in about 50 files (`client.js:137-146` prints the **QR as ASCII art** or the raw QR string). Output of the worker transport bypasses `process.stdout.write`, so patching stdout would miss the two main loggers.

**Decision (least invasive that is complete)**
1. `lib/utils/logger.js`: `createLogger(name)` returns `root.child({name})`. Root pino writes to one destination object whose `write(line)` runs `redactor.scrub(line)` then forwards to (a) an **in-process** `pino-pretty` stream (same options as index.js:9-18; replaces the two worker threads; measured +5.7 MiB RSS in-process) or raw stdout when `LOG_FORMAT=json`, and (b) `ring.pushFromPinoLine(line)`. Level from `config.LOG_LEVEL`/`LOG_LEVEL` as now (`silent` in tests). Mechanical edit: each of the 19 files swaps its `pino({...})` line for `require("<rel>/logger").createLogger("<name>")` and drops the unused `require("pino")`. Baileys loggers are left untouched on purpose (at debug they carry payloads).
2. `consoleCapture.install()` (called first in index.js/panel.js) wraps `console.log/info/debug/warn/error`: format with `util.format`, scrub, push to the ring with the matching level and `name:"console"`, then call the original. Lines that are QR art (`/[▀▄█]{8,}/`) or contain `QR available` are **never** pushed.
3. `redactor.js` (value-based): a registry of secret **values** with variants (raw, JSON-escaped, URL-encoded, base64 and base64url) compiled lazily into one escaped alternation sorted by length; values shorter than 6 chars are ignored (would garble logs; the settings validator should require 8+ for secret fields). Sources: every `secret:true` setting in effect whatever its origin (env, file, panel), `SESSION_ID`, `PANEL_TOKEN`, `DATABASE_URL` (whole and password part), setup/reset tokens, the current QR string (TTL 5 min), `HEROKU_/RENDER_/KOYEB_` keys. Defence in depth: the existing key-shape pass `redact()` (lib/utils/http.js:293-299) and pino `redact.paths` (`*.apiKey`, `*.token`, `*.password`, `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]`). Replacement text `[redacted]`.
4. `ring.js`: circular array of 1000 entries `{seq, ts, level, name, msg}`; `msg` capped at 2,000 chars and 12 stack lines; other structured fields are dropped from the panel view. Memory about 0.4 MB typical, 2 MB worst. `subscribe(fn)` feeds SSE; `list({level, q, since})` serves REST. Dashboard "10 dernières erreurs" = last 10 ring entries with level >= error.
5. Rules enforced by `test/admin-logging.test.js`: no `pino(` outside `lib/utils/logger.js` (allowlist: the two Baileys calls in client.js); no `console.` in `lib/admin/**`; request bodies, headers and query strings are never logged; validation errors never echo a submitted secret.

**Rationale** One choke point also fixes the bot's own stdout/PM2 files (FR-017 says secrets never appear in "journaux"), gives per-module names for filtering, removes two worker threads, and still needs only a one-line change in each existing file.

**Alternatives** patch `process.stdout/stderr.write` only (zero edits, but misses the pino-pretty worker output, cannot assign levels to `console.*`, and mirrors Baileys debug output); `pino.multistream` per module (same 19 edits, more wiring); `pino` `redact` alone (path-based, cannot catch a key inside a message or error string).

**Evidence** grep of `pino(` (20 matches / 19 files); `lib/utils/http.js:293-317`; `test/helpers/fakes.js:102-111` (tests blank the secret env keys and set `LOG_LEVEL=silent`).

**Files impacted** new `lib/utils/logger.js`, `lib/admin/logs/{ring,redactor,consoleCapture,secrets}.js`; edit the 19 files above.

---

### B9. Panel UI i18n, theme, mobile

**Decision**
- Panel strings live in **`lib/admin/public/i18n/en.json` and `fr.json`** (served as static JSON), not in `lang/`. Reasons: `lang/*.json` is loaded whole by `LanguageManager` at start (language.js:19-45) in the **bot's** language, so putting 1,000 panel keys there costs memory and, more importantly, would pollute US12's "list every text the bot sends" (FR-056). The admin picks `fr|en` independently of `BOT_LANG`, stored in `AdminAccount.prefs` (cached in `localStorage`, default from `navigator.language`).
- The API is language-neutral: errors are `{error, fields:{name:{code, params}}}` and the client maps `errors.<code>`; named placeholders `{name}`, plurals via `key_one`/`key_other` with `Intl.PluralRules`. `test/admin-i18n.test.js` (same shape as test/i18n.test.js:85-132): identical flat key sets, identical placeholders, no empty value, every literal `t("…")` used in `public/js/**` exists, unused keys reported.
- The few server-side human strings (console setup link, alert texts of US13) go through `getLang` in `lang/*.json` under `admin.console.*` and `alerts.*`, as CLAUDE.md requires; `test/i18n.test.js` scans `lib/**/*.js` so literal `getLang` keys there are checked automatically.
- Theme: tokens as CSS variables on `:root` (`--bg --surface --text --muted --border --primary --danger --warn --ok --focus`), dark values under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }` and `:root[data-theme="dark"] {…}`, `color-scheme: light dark`. The user choice (auto/light/dark) is applied before first paint by the external classic script `js/theme-init.js` (inline script is forbidden by CSP). A test parses the tokens and asserts contrast >= 4.5:1 for text pairs in both themes.
- Mobile-first (360 px): single column, top bar + off-canvas nav, tables become labelled cards below 40rem (`td::before{content:attr(data-label)}`), `min-width:0` and `overflow-wrap:anywhere` for JIDs/keys, inputs 16 px, targets >= 44 px, no fixed widths, lists paginated (500 groups in under 2 s is a server paging concern, not a UI one). No web fonts, no icon library (one SVG sprite). SC-008 cannot be asserted in node: add a manual 360 px checklist item per view (and an optional headless-Chromium script outside CI; no Playwright dependency).

**Alternatives** `panel.*` keys in `lang/*.json` (parity enforced for free by the existing test, but memory and FR-056 pollution); server-rendered translated strings (couples the API to a language); i18n library (unneeded).

**Files impacted** new `lib/admin/public/i18n/{en,fr}.json`, `public/js/i18n.mjs`, `public/css/*.css`, `test/admin-i18n.test.js`, small additions to `lang/{en,fr}.json`.

---

### B10. Testability, SC-004, SC-005, SC-009

**Decision**
- `createPanelServer({ config, db, bot, clock, logger })` returns an unstarted `http.Server`; the bot side is an injected `BotBridge` (`getState()`, `restart()`, `logout()`, `requestPairingCode()`, event emitter) with a fake built on `fakes.fakeClient()` (test/helpers/fakes.js:503). Tests follow test/panel.test.js: `setupEnv`, in-memory SQLite, `listen(0, "127.0.0.1")`, global `fetch` plus a 10-line cookie jar (`res.headers.getSetCookie()`). Clock injection (or `mock.timers` with `apis:["Date"]`) covers the 15 min lockout and the 24 h expiry without sleeping.
- `test/admin-security.test.js` (SC-005), generated from `router.routes()` so new routes are covered automatically:
  1. Allowlist snapshot: the set of `auth:"public"` routes must equal the expected list (shell, assets, `GET /admin/api/session`, `POST /admin/api/login`, `GET /admin/setup`, `POST /admin/api/setup`); adding one forces a test edit.
  2. Every other route without cookie gives 401 (JSON) for every declared method; wrong method gives 405; unknown `/admin/api/*` gives 404 JSON.
  3. With a session, every unsafe route is refused (403) without `X-CSRF-Token`, with a wrong token, with `Origin: https://evil.example`, with no Origin, with `Sec-Fetch-Site: cross-site`, and with `text/plain`/form content types; accepted only with all valid.
  4. Calling every GET route with a session leaves a before/after dump of all tables unchanged.
  5. Header test: every response status class (200/304/401/403/404/405/413/500) carries the headers of B5 and no `Access-Control-*`.
  6. Traversal vectors against `/admin/assets/` (`..`, `%2e%2e`, `%00`, `\`, double-encoding) never return file content.
  7. Throttling with fake clock; trust-proxy cases (`X-Forwarded-For` ignored from an untrusted peer, honoured when `PANEL_TRUST_PROXY=loopback`); session rotation (old id invalid after login), hashed-at-rest check (raw id absent from the DB dump).
- `test/admin-secrets.test.js` (SC-004): seed distinct known values for every secret setting, `PANEL_TOKEN`, `SESSION_ID`, DB URL password, admin password, setup token, CSRF token, a fake QR string, a backup passphrase. Then: call every GET route in the registry with a session; POST invalid secrets and assert the error body does not echo them; trigger logs through `createLogger`, `console.error(seed)`, a thrown handler error and the QR art path; capture `process.stdout.write`. Assert none of the seeds appears in any response body/header (the session cookie is exempt by design), in the ring, in captured stdout, in the audit table or any DB dump. Last-4 display (`…abcd`) is allowed, so seeds are chosen so that the last 4 characters are not a substring check of the full value.
- `test/admin-frontend.test.js`: forbidden-API scan, no external URL (FR-010), vendor hash manifest, every `api("…")` path used by the client exists in the registry.
- SC-009: `test/admin-memory.test.js` forks `test/helpers/admin-memory-child.js` with `--expose-gc` (the helper does not end in `.test.js`, so it is not auto-run). The child loads the bot baseline (config, database, plugin loader, pipeline, Baileys client with the fake), runs `gc()` twice, records `process.memoryUsage()`, then requires the admin module, listens on port 0, fills the ring with 1000 max-size entries, creates 3 sessions, opens 1 SSE client and makes 50 requests via `http.request`, runs `gc()` twice again and reports deltas over IPC. Assert `heapUsed + external` delta < 25 MB (hard), report RSS delta via `t.diagnostic` and assert < 50 MB only when stable. Do not drive it with `fetch` in the same process: loading undici's client added about 16 MiB RSS in a trial.
  Estimate: a micro-trial (bare `node:http` server + 1000 x 300 B ring + 300 KB asset cache + 200 requests) gave +1.5 MiB heap, +0.4 MiB external (+17.6 MiB RSS, mostly lazy loading of `http`, already loaded by axios/Baileys in the bot). Expected idle total: server and router under 1 MB, assets 0.3 MB, ring 0.4 to 2 MB, caches under 1 MB, one SSE client 20 to 50 KB, plus the 32 MiB scrypt buffer only transiently at login. Removing the two pino-pretty worker threads offsets part of it.

**Files impacted** `test/admin-{security,secrets,frontend,i18n,logging,memory}.test.js`, `test/helpers/admin-memory-child.js`, `test/helpers/adminClient.js` (cookie jar, login helper).

---

## Proposed layout

```
lib/admin/
  index.js                 createAdmin(deps) -> { handle(req,res), routes(), start(), stop() }
  server.js                createPanelServer(): http.Server (legacy + admin), timeouts, graceful close
  events.js                topic hub for SSE (publish/subscribe)
  http/    router.js request.js response.js security.js static.js sse.js trustProxy.js
  auth/    password.js sessions.js tokens.js rateLimit.js routes.js
  logs/    ring.js redactor.js secrets.js consoleCapture.js
  routes/  (one file per area, owned by the other research streams: dashboard, settings, commands, groups, pairing, ...)
  public/  index.html  icons.svg
           css/{theme,app}.css   i18n/{en,fr}.json
           js/{theme-init.js, app,router,api,i18n,live,ui}.mjs  js/views/*.mjs  js/components/*.mjs
           vendor/{preact,preact-hooks,htm}.mjs  LICENSE-*  MANIFEST.json
lib/utils/logger.js        shared pino factory (used by the whole bot)
lib/database/models/       AdminAccount.js AdminSession.js AdminToken.js   (+ audit model from another stream)
tools/admin-reset.js
test/                      admin-{security,secrets,frontend,i18n,logging,memory}.test.js, helpers/{adminClient,admin-memory-child}.js
```

## Dependencies

- npm: **none added**. `package.json` untouched; `node tools/check-unused-deps.js` keeps printing "0 unused dependencies".
- Vendored (committed, not in `package.json`): preact 10.29.8 (MIT, published 2026-08-01), preact hooks (same package), htm 3.1.1 (Apache-2.0, 2022-04-26).
- Reused existing deps: `qrcode ^1.5.4` (server-side SVG QR), `file-type ^22.2.0` (upload sniffing), `pino ^10.4.0`, `pino-pretty ^13.2.0` (in-process stream), `luxon` (other streams). Node built-ins: `http`, `crypto` (scrypt, timingSafeEqual, randomBytes, createHash), `net.BlockList`, `fs`.

## New startup settings (read-only in the panel, FR-019)

`PANEL_ENABLED` (default flips to true), `PANEL_HOST`, `PANEL_PORT` (exist: config.js:202-206), `PANEL_PUBLIC_URL` (link base and allowed Origin), `PANEL_TRUST_PROXY` (B5), `LOG_FORMAT` (`pretty` default, `json`).

## Cross-stream contracts

- Routes: other streams register only through `route({...})`; `auth` is mandatory.
- Audit: `audit.record(req, action, target, result, detail)`; detail passes through `redactor.scrub`.
- Secrets: the settings store calls `secrets.register(name, value)` on every change of a `secret:true` setting; error envelopes never echo submitted values.
- Backup/restore must exclude `AdminAccount`, `AdminSession`, `AdminToken` by name.
- `lib/baileys/client.js` must emit `qr` and expose current pairing state; `panel.createServer`/`botState` exports must remain (test/panel.test.js).

## Open points for the user

1. Default bind address now that the panel starts with plain `node index.js`: today `PANEL_HOST` defaults to `0.0.0.0` (config.js:204), exposing the login page and the pre-setup state on the LAN over HTTP. Options: (a) keep `0.0.0.0`; (b) default `127.0.0.1` for `index.js` and set `0.0.0.0` explicitly in the Dockerfile/compose and keep it for `panel.js`; (c) `0.0.0.0` only inside containers (detect `/.dockerenv`). Recommendation: (b).
2. Optional absolute session lifetime (7 days) in addition to the 24 h idle rule: keep (recommended, cheap) or drop.
3. Proxy lockout limit (B5): accept and surface a banner (recommended), or auto-trust loopback/private peers by default (spoofable from the LAN).
