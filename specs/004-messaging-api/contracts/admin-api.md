# Contract: admin API page routes

Feature `004-messaging-api`. Inputs: [spec.md](../spec.md) (FR-001 to FR-094, US4), [research.md](../research.md) (**authoritative**: U1-U15 and X1-X22 override the stream files), [research/c-data-panel-backend.md](../research/c-data-panel-backend.md) (C4, C5, C6, C9), [research/d-panel-ui.md](../research/d-panel-ui.md) ("Needed from C"). Siblings: [../data-model.md](../data-model.md) (the four `Api*` tables, `ApiState`, the 11 settings entries), [public-api.md](public-api.md) (the key-authenticated surface: message resource, formats, error catalogue), [runtime.md](runtime.md) (engine facade, format registry, `describe(name)`, boot wiring), [panel-ui.md](panel-ui.md) (the SPA that calls these routes).

This file **adds** 14 routes to the 002 contract [admin-http-api.md](../../002-admin-panel/contracts/admin-http-api.md) (API-1 to API-13 under `/admin/api/api`, and AUTH-7 `POST /admin/api/session/reauth`) and amends a few of its answers (section 3). Nothing of 002 or 003 is edited. The public `/api/v1` surface has no route here and the panel session never opens it (FR-004).

Server code: `lib/admin/routes/api.js` (auto-loaded, one new area; `register()` requires no engine, so the harnesses of `admin-security` and `adminFull` register it with stubs), `lib/admin/services/api.js` (`createApiService(deps)`, never touches `req`/`res`; resolves `apiState`, `messaging`, `registry`, `keyStore`, `ipRules`, `uploads`, `alerts`, `redactor` and `models` lazily from `deps`, so tests inject fakes), AUTH-7 in `lib/admin/routes/auth.js`. Multi-statement writes run under `withLock("api-keys")` (keys) or `withLock("api-state")` (switch and `plainHttpFrom`).

## Machine-read format (for `test/admin-integration.test.js#contractRoutes()`)

The plan extends `contractRoutes()` so the route-contract guard also covers this file (same mechanism as feature 003). The parser must:

1. read this file and take the text from the level-2 heading numbered 2 (title "Routes") up to the level-2 heading numbered 3 (title "Changes to existing routes"). Search each as a line start (a newline, two hash signs, a space, then the number and title) so that nothing in the prose can be hit first. This is `SECTIONS` entry `{ name: "004", text: API_CONTRACT, from: "## 2. Routes", to: "## 3. Changes to existing routes" }`;
2. apply the **same two regexes** as for 002 and 003, unchanged (flags `gm`), to that slice:

```text
route row   ^\| ([A-Z]+-\d+) \| `([A-Z]+) (\/[^`?]*)(?:\?[^`]*)?`
auth column ^\| ([A-Z]+-\d+) \| `([A-Z]+) (\/[^`?]*)(?:\?[^`]*)?`[^|]*\| (public|session|setup) \|
```

3. union the rows with those of 002 and 003 before the three checks (documented routes are registered, the `auth` column matches, no registered route is undocumented).

Format guarantees of this file:

- exactly 14 route rows, ids `API-1` to `API-13` then `AUTH-7`, one per line of the table in the routes section, each shaped as: pipe, id, pipe, the backticked `METHOD /path`, pipe, `session`, pipe, and the remaining cells;
- the only path parameter is `:id` (default pattern `^[1-9]\d{0,9}$` of `PARAM_PATTERNS`, `lib/admin/http/router.js:102`);
- no query string in the path cell (the queries of API-9 and API-12 are described under the table);
- no other table row of this file starts with a pipe, an id and a backticked `METHOD /path`;
- the two level-2 headings named above appear once each, as a line start, and no prose of this file spells them out with the leading hashes.

---

## 1. Conventions

### 1.1 Inheritance and prefix

Everything in section 1 of the 002 contract applies unchanged: `session` auth and the unsafe-request guard (CSRF, Origin, JSON content type), the 64 KiB default body, the error envelope and field codes, `X-Request-Id`, security headers (`Cache-Control: no-store` on every `/admin/api/*` answer), `maintenance`, `db_unavailable` and `starting` gates. **No route of this file is `db:r`**: every one reads a table. All answers are language-neutral (codes and parameters, never prose), timestamps are ISO-8601 UTC strings, absent values are `null`, sizes are bytes. List answers follow the 002 pagination convention `{ items, page, pageSize, total }`.

`P` below is `/admin/api/api` (research/d D1: the area name is the path segment). Query strings are validated with a strict `query` schema (values are strings, an unknown parameter is `422 validation_failed` with `fields.$unknown`). Request bodies use the nested-object rule `shape` and the array rule `unique` of `lib/utils/schema.js` (research.md X5), which `lib/admin/http/request.js` re-exports; error paths are dotted (`policy.mode`, `limits.perDay`, `ipAllow`), and for lists only **indices** are reported, never the value.

No GET of this contract writes anything. In particular `API-1` never creates the `ApiState` row (absence reads as disabled; the first `API-2` write inserts it, research.md X1).

### 1.2 Objects

**State** (API-1)

| Field | Type | Notes |
|---|---|---|
| `enabled` | boolean | the stored switch (`apiState`); absent row = `false` |
| `changedAt` | string or null | last switch change |
| `failure` | null or `{ code: "registry_failed", endpoint: string or null }` | the endpoint/format registry failed at boot (runtime.md): the API is unmounted, the switch cannot be turned on |
| `queued` | integer | messages in `queued`, all keys and the panel |
| `pausedUntil` | string or null | end of the 15-minute pause after a WhatsApp restriction (research.md U5), else `null` |
| `botReady` | boolean | the WhatsApp client is connected (a disconnected bot still accepts sends) |
| `https` | boolean | the server's view of this very request (trust-proxy aware) |
| `baseUrl` | string | absolute `<origin>/api/v1`: origin of `PANEL_PUBLIC_URL` when set, else the request's own origin |
| `plainHttpFrom` | `[string]` | normalised private ranges allowed to call over plain HTTP (U1), empty by default, at most 50 |
| `stepUp` | `{ confirmedUntil: string or null, windowMs: 300000 }` | this session's confirmation (1.5); `null` when absent or past |
| `counts` | `{ active, expired, revoked }` | keys by derived status |
| `settings` | object | effective values: `minSpacingMs`, `perMinute`, `perDay`, `maxPending`, `queueMax`, `expiryMin`, `retentionDays`, `replyWindowDays` (minutes and days, not ms); `alerts: { originBlocked, keyNewIp, paused }` (booleans); `settingKeys`: the catalog key of each, e.g. `perMinute: "API_RATE_PER_MINUTE"`, `minSpacingMs: "SEND_MIN_SPACING_MS"`, `alerts` keys `ALERT_API_ORIGIN_BLOCKED`, `ALERT_API_KEY_NEW_IP`, `ALERT_API_PAUSED`. Edited through SET-2 (one write path), never here |

**KeyView** (API-4, API-5, API-6, API-7, API-8). No hash, no lookup id, no secret, no `seenIps` (only its length).

| Field | Type | Notes |
|---|---|---|
| `id`, `name`, `last4` | integer, string, string | `last4` = last 4 characters of the token, the only fragment ever shown (FR-010) |
| `status` | `active` or `expired` or `revoked` | derived at request time: `revokedAt` set, else `expiresAt <= now`, else active |
| `createdAt`, `updatedAt`, `revokedAt`, `expiresAt` | string or null | |
| `version` | integer | optimistic concurrency (1.6); never moved by the usage columns |
| `lastUsedAt`, `lastUsedIp`, `seenIpCount` | string or null, string or null, integer | usage columns written by the API layer, not here |
| `rights` | `[string]` | stored right ids, sorted |
| `orphanRights` | `[string]` | subset of `rights` absent from the catalogue (a removed module): ignored at runtime, removable only |
| `policy` | `{ mode: list or known or anyone, recipients: [{ jid, name: string or null }] }` | `recipients` kept when the mode changes; `name` from `KnownChat` (private push name, group subject) |
| `limits` | `{ perMinute, perDay, maxPending }` | integers or `null` (`null` = follow the setting, so a changed default applies) |
| `ipAllow` | `[string]` | normalised, masked, empty = no restriction |
| `queued` | integer | this key's messages in `queued` (what a revoke would cancel) |

Order of API-4: non-revoked keys by `id` ascending, then revoked keys by `revokedAt` descending.

**KeyInput** (API-5 body; API-6 body plus `version`). Strict: an unknown property is `$unknown`. Create and update are full values, never patches.

| Field | Type | Rule |
|---|---|---|
| `name` | string, required | NFC, trimmed, 1 to 64 code points, no control character (`invalid_format`) |
| `rights` | array of string, required | at most 64, `unique`, each `^[a-z]+(\.[a-z0-9_]+)*$` and at most 64 characters; empty allowed (a new key has no right, FR-011) |
| `policy` | object, required | `mode` required (`list`, `known`, `anyone`); `recipients` required, array of string, at most 200, each at most 64 characters |
| `limits` | object, required | `perMinute` 1-1000, `perDay` 1-100000, `maxPending` 1-5000, each optional and nullable (absent = `null`) |
| `ipAllow` | array of string, required | at most 50 (research.md X22), grammar of `lib/api/ipRules.js` (IPv4, IPv4/n, IPv6, IPv6/n; host bits masked; `0.0.0.0/0` and `::/0` accepted) |
| `expiresAt` | string or null, required | ISO-8601 with `Z` or an offset |
| `version` | integer >= 1 | API-6 only, required there; `unknown_field` on API-5 |
| `confirm` | array of string | `["policy_anyone"]` (1.6), enum of one value |

**MessageRow** (API-9, API-11): `{ id, source: "api" or "panel", key: { id, name: string or null } or null, to, toName: string or null, kind: "private" or "group", format, size: integer or null, status, failureCode: string or null, acceptedAt }`. `id` is the internal integer; `key` is `null` for `source: "panel"`; `to` is the full normalised JID (recipients are masked in logs, not in the panel, FR-073); `status` is one of the nine of public-api.md section 4.2; `failureCode` is the message-level code of public-api.md section 4.3 (set for `failed`, `cancelled`, `unknown`).

**MessageDetail** (API-10) = MessageRow plus:

| Field | Type | Notes |
|---|---|---|
| `publicId` | string | the `msg_...` id the API caller holds, to match their logs |
| `waId` | string or null | WhatsApp message id |
| `expiresAt` | string | acceptance + queue expiry |
| `steps` | `[{ status, at }]` | built from the timestamp columns, ascending by time (ties in the order queued, sending, sent, delivered, read, then the terminal one): `queued` at `acceptedAt`, `sending`, `sent`, `delivered`, `read` when reached, and the terminal `failed`/`expired`/`cancelled`/`unknown` at `endedAt` |
| `interactive` | boolean | the format captures replies |
| `responses` | object or null | exactly the object of public-api.md section 4.4 (`until`, `total`, `items` oldest first with `kind` and `via`, `totals` for polls), built by the engine's `describeResponses`; `null` for non-interactive formats. Labels are the short texts kept for the retention period; `label` may be `null` |

**Catalog** (API-3): `{ version: "v1", basePath: "/api/v1", rights, formats, endpoints, limits }`.

- `rights`: `[{ id, group: send or read or media or docs or <other>, format: string or null }]`, the registry's rights catalogue (public-api.md 2.5); stable order: groups `send` (by format `order`), `read`, `media`, `docs`, then others alphabetically.
- `formats`: `[FormatDescriptor]` by `order`, the output of the registry's `describe(name)` served unchanged (research.md X6; production in runtime.md): `{ name, right, interactive, order, labelKey, descKey, media: null or { sources: ["file","url"], accept: [mime], maxBytes, captionMax: integer or null }, example: { flat sample body, no secret }, fields: [Field] }`, `Field = { name, type: text or textarea or number or boolean or select or phone or url or list or recipient, required, labelKey, hintKey?, placeholderKey?, min?, max?, step?, signed?, pattern?, patternHintKey?, options?: [{ value, labelKey }], default?, item?: Field, items?: { min, max, fields: [Field] } }`. Property names are the public JSON names (a flat body). Keys follow `api.format.<name>.label|desc` and `api.format.<name>.field.<field>.label|hint`.
- `endpoints`: `[{ id, method, path, rights: [string], dynamic: boolean, idempotent: boolean, summary: string, body: { kinds: ["json" or "multipart"], limitBytes: integer or null } }]`. `summary` is the English text of the endpoint module (the API documentation is English only, research.md U8); the SPA translates nothing in it.
- `limits`: `{ keyNameMax: 64, rightsMax: 64, recipientsMax: 200, ipAllowMax: 50, plainHttpFromMax: 50, keysMax: 50, perMinute: [1,1000], perDay: [1,100000], maxPending: [1,5000] }`.
- While `State.failure` is non-null, `rights`, `formats` and `endpoints` are `[]` and key writes accept only rights already stored (nothing new can be granted).

**Usage** (API-12): `{ timezone, from: "YYYY-MM-DD", to: "YYYY-MM-DD", keys: [{ id: integer or null, name: string or null, source: "api" or "panel", revoked: boolean, days: [{ day, sent, failed }] }] }`. Dense: every day from `from` to `to` appears for every entry, zeros included.

### 1.3 Limits

| Limit | Value | Where |
|---|---|---|
| Non-revoked keys | 50 | `409 limit_reached { max: 50 }` on create and duplicate |
| Key name | 64 code points | schema |
| Rights per key / recipients per key / IP entries / `plainHttpFrom` entries | 64 / 200 / 50 / 50 | schema `max` on the submitted array (a normalisation can only shrink it) |
| Body | 64 KiB, declared explicitly on API-11 (a route without `schema` must declare `bodyLimit` to accept a body) | router |
| History page | `pageSize` default 50, 1 to 200 | API-9 |
| Usage window | 7 or 30 days, in `TIMEZONE` | API-12 |
| Step-up window | 300 000 ms, fixed from the confirmation | 1.5 |
| Audit target / detail | 255 characters / 2000 characters (1900 rule in 1.7) | `lib/admin/audit.js` |

### 1.4 Errors

Checks run in the order of each route's description; the first failing stage answers (the schema stage reports all its fields at once). Nothing is written on any refusal.

**Envelope codes this contract adds or relies on**

| Code | Status | Params | Notes |
|---|---|---|---|
| `password_required` | 403 | `windowMs`; `reasons` (array of codes of 1.5, only when the handler supplied them) | 403, not 401, so the SPA keeps its session; new key of `STATUS_BY_CODE` and of `EXTRA_SERVER_CODES` in `admin-i18n.test.js` |
| `api_disabled` | 409 | `reason`: `switch_off` or `registry_failed`; `endpoint` with the latter | API-11 while the switch is off or the registry failed; API-2 `enabled: true` while the registry failed. Replaces D's `bot_unavailable`: a disconnected bot still accepts |
| `confirmation_required` | 409 | `confirm`: `"disable_api"` (API-2), `"revoke_key"` (API-8), `["policy_anyone"]` (API-5, API-6) | 002 section 1.10; the bare-string form for `confirm: true`, the array form as SET-2 |
| `conflict` | 409 | `fields.version = { code: "conflict", params: { version } }` with the current version | API-6 |
| `not_editable` | 409 | none | API-6 on a revoked key; API-7 on a revoked or expired source |
| `limit_reached` | 409 | `max` | 50 non-revoked keys |
| `not_found` | 404 | `resource`: `key` or `message` | path value that matches `:id` but designates nothing |
| `rate_limited` | 429 | `retryAfterMs` | AUTH-7 while the origin is blocked |
| `payload_too_large` | 413 | `maxBytes` | API-11 body over 64 KiB |
| the engine refusals of `MESSAGING_STATUS` | per `lib/messaging/errors.js` | per public-api.md section 6 | imported into `STATUS_BY_CODE` wholesale (research.md X4), each with a panel text `errors.<code>` and listed in `EXTRA_SERVER_CODES`. Reachable from API-11: `chat_disabled` 409, `queue_full` 503 (`scope`: `global`, `wait`, `disk`; `retryAfterMs` becomes `Retry-After`), `media_type_mismatch` 422, `media_too_large` 413, `url_forbidden` 422, `url_unreachable` 502. The others (`recipient_not_allowed`, `pending_limit_reached`, `daily_quota_exceeded`) need a key and cannot occur from the panel but still need their texts. `validation_failed` and `rate_limited` keep their panel entries |

HTTP-layer codes of the public API (`unauthenticated`... `origin_blocked`, `https_required`, `key_in_url`, `unavailable`...) stay in `lib/api/errors.js` and are **not** added to the panel table.

**Field codes.** The existing vocabulary of 002 section 1.9 plus one new code, `not_found` (`fields.quote`, `fields.uploadId`; panel text `fields.not_found` in both catalogs). Used as follows.

| Field path | Code and params | Situation |
|---|---|---|
| `name` | `required`, `too_short`, `too_long`, `invalid_format`, `duplicate` | `duplicate`: another non-revoked key has the same name (compared after NFC, trim and `toLowerCase()`; the key being edited excluded). 422, not 409: the editor shows it under the field |
| `rights` | `not_allowed { allowed: [catalogue ids], indices }` | an id neither in the catalogue nor already stored on this key |
| `policy.mode` | `not_allowed { allowed }` | |
| `policy.recipients` | `invalid_phone` or `invalid_jid`, `{ indices }` | one code per field: the code of the first failing entry, `indices` = every failing entry with that code. Accepted forms: a typed number (strip spaces, `+`, `-`, `.`, `(`, `)`, a leading `00`; 8-15 digits, not starting with `0`; becomes `<digits>@s.whatsapp.net`), a `<digits>@s.whatsapp.net` JID, a group id `^\d{5,25}(-\d+)?@g\.us$`. A LID or any other JID is `invalid_jid` (the API addresses numbers and groups only). Entries resolving to one JID collapse silently |
| `limits.perMinute`, `limits.perDay`, `limits.maxPending` | `out_of_range { min, max }`, `invalid_type` | |
| `ipAllow` | `invalid_format { indices }` | |
| `expiresAt` | `invalid_format`, `in_past` | `in_past`: on a create any value at or before now; on an update only when the value differs from the stored one (editing an already expired key without touching its date is not an error) |
| `plainHttpFrom` | `invalid_format { indices }`; `{ indices, reason: "not_private" }` for a syntactically valid entry outside RFC 1918, ULA `fc00::/7` and CGNAT `100.64.0.0/10` | API-2 |
| `version` | `conflict { version }` | API-6 |
| `confirm` | `not_allowed { allowed }` | an unknown token |
| `uploadId` | `not_found` | API-11: unknown, expired, foreign, consumed or wrong-purpose upload, never distinguished |
| dotted paths | the codes of public-api.md section 6.1 | API-11, produced by the engine's validation |

### 1.5 Step-up re-authentication (FR-021, research.md X8)

**Where it lives.** `confirmedAt` (ms, `0` = never) on the in-process session cache entry of `lib/admin/auth/sessions.js`, exposed as `ctx.session.confirmedAt` by `snapshot()` (`:150`), copied by `entryFromRow(row, previous)` (`:182`) so the 60 s database refresh keeps it. No schema change. New session members: `confirm(id, at) -> confirmedAt`, `isRecent(session, at)`, constant `STEP_UP_MS = 300000`. A confirmation is fixed (not sliding), is **not consumed** by use, and is per session id: another browser is not confirmed. A login does **not** count as a confirmation (a fresh session has `confirmedAt` 0). It is lost by a restart, `clearCache()` (`:411`), logout, a password change (the session is rotated), `destroyAll` and expiry: the safe direction. `isRecent` is `confirmedAt > 0 && at < confirmedAt + STEP_UP_MS`.

**Gate.** `deps.auth.requireRecent(session, at)` throws `AdminError("password_required", { params: { windowMs: 300000 } })` (403). A stub `auth` without the method fails closed (the route answers `password_required`).

**Router option** `stepUp: true | "conditional"`, accepted on `session` routes with an unsafe method only (any other value or placement throws at registration, like `csrf`).

| Value | Behaviour |
|---|---|
| absent | the route never asks; `ctx.stepUp` throws a plain `Error` when called (a 500 logged), so the table cannot understate what a handler does |
| `true` | after query and body validation (step 3 of `dispatch`, `router.js:377`) and before the touch and the handler, the router calls `env.auth.requireRecent(ctx.session, ctx.now)`. A request that fails validation is never asked for a password. `ctx.stepUp` is not provided (the router already asked) |
| `"conditional"` | nothing automatic; `ctx.stepUp(reasons)` is added to `ctx` and calls the same gate; on failure the error carries `params: { windowMs, reasons }`. The handler decides, from the diff against the stored row |

`router.routes()` rows gain `stepUp: true | "conditional" | false`. The exact set is pinned: `true` on API-5 and API-7; `"conditional"` on API-2 and API-6; `false` everywhere else (AUTH-7 included, it is the door itself).

**The widening predicate is server-side and exact.** `lib/admin/services/api.js#widenings(before, after)` returns the reason codes in this fixed order, on the **stored** state (`before`) and the **normalised submitted** state (`after`); the SPA's pure `widenings()` mirrors it and may over-report, never under-report.

| Reason | Route | True when |
|---|---|---|
| `enable` | API-2 | `before.enabled === false` and `after.enabled === true` |
| `create` | API-5, API-7 | always (the router asks; a duplicate is a creation) |
| `rights` | API-6 | some id of `after.rights` is not in `before.rights` |
| `policy` | API-6 | (a) rank of `after.policy.mode` is above that of `before.policy.mode`, with `list` 0 < `known` 1 < `anyone` 2; or (b) some JID of `after.policy.recipients` is not in `before.policy.recipients`, **whatever the mode**: a recipient stored while the mode ignores it would otherwise activate later without a prompt |
| `ip` | API-6 | `before.ipAllow` is non-empty and (`after.ipAllow` is empty, or some entry `e` of `after.ipAllow` has `!covers(before.ipAllow, e)`: coverage = same family and the range of `e` inside the range of one old entry, BigInt compare, `lib/api/ipRules.js#covers`) |
| `expiry` | API-6 | `before.expiresAt` is set and (`after.expiresAt` is `null` or later than it) |
| `plain_http` | API-2 | some entry `e` of `after.plainHttpFrom` has `!covers(before.plainHttpFrom, e)` (an empty old list: every entry) |

Never widening, so never asked: name, limits (FR-021 does not list quotas; a deliberate reading), removing a right, narrowing the mode, removing a recipient, an IP list where there was none, narrowing or removing IP entries, setting or advancing an expiry, removing a `plainHttpFrom` entry, disabling the API, revoking, and any edit whose normalised result equals the stored state (`changed: false`).

**Confirm route** AUTH-7 (section 2). It shares the `limits.password` bucket of AUTH-5 (5 failures in 15 minutes per origin, then a 15-minute block; `rateLimit.js:26-28`) and is checked **before** hashing, so the right password is refused while the block lasts. A wrong password is `422`, never 401 (the SPA would drop to the login).

**Order inside a conditional handler.** Schema, key or state lookup, semantics, version, `policy_anyone` confirmation, then `ctx.stepUp(reasons)` last, then the write: a wrong password or a missing confirmation saves nothing (US4.7).

```json
{ "error": { "code": "password_required", "params": { "windowMs": 300000, "reasons": ["rights", "expiry"] }, "requestId": "9f3c1a2b4d5e6f70" } }
```

### 1.6 Key lifecycle

- **Secret once.** API-5 and API-7 answer `201 { key: KeyView, secret }`; `secret` is the whole token (`owbk_<16 hex>_<43 base64url>`, 65 characters, public-api.md 1.3), generated by `keyStore.generateSecret()`. It appears nowhere else: not in `KeyView`, any other answer, an audit row, a log line, a database column (only its SHA-256 and `last4`). Before the write the service registers it with `redactor.registerEphemeral("apikey:<lookupId>", secret, 600000)`, so an error log of that request is scrubbed (the built-in `owbk_...` pattern is the second line of defence). The answer carries `Cache-Control: no-store`.
- **Names (U11).** Unique among non-revoked keys, case-insensitively (field code `duplicate`, 1.4); a revoked key frees its name. The invariant is checked under `withLock("api-keys")` (no database index can express it).
- **Version.** Created at `1`; API-6 and API-8 add `1` when something changed; the usage columns never touch it. API-6 must send the `version` it read: a different stored value is `409 conflict` and nothing is written (the SPA reloads).
- **Revoke (U10).** Final: no route reactivates a key. API-8 requires `confirm: true`, sets `revokedAt`, bumps `version`, calls `keyStore.invalidate(id)` (effect on the very next request, FR-014) and `messaging.cancelForKey(id, "key_revoked")`, whose count is `cancelled`. The revoke is committed first and never rolled back; if the cancellation throws, it is logged, `cancelled` is `null`, and the claim-time `keyGuard` of the engine cancels what is left, so a revoked key never sends. Already revoked: `200`, `cancelled: 0`, no audit. A revoked key leaves the list, with its history, `API_RETENTION_DAYS` after revocation (housekeeping); its audit rows stay.
- **Duplicate (FR-015).** API-7 copies rights (orphan rights dropped), policy (mode and recipients), limits, `ipAllow` and `expiresAt` into a **new** key with a new secret, `version` 1 and empty usage columns; the source is untouched. A revoked or expired source is `409 not_editable` (the copy of an expired key would be born expired; extend the original with API-6 instead). Name: `name` of the body when given (same rules as KeyInput), else `<source name> (n)` with the first free `n >= 2`, the base truncated so the whole stays within 64 code points. Always password-gated; **no `policy_anyone` confirmation** (the mode is inherited from a key whose owner already confirmed it).
- **`policy_anyone`.** Setting the mode to `anyone` on a create, or on an update whose stored mode is not `anyone`, requires `confirm: ["policy_anyone"]` in the body, else `409 confirmation_required { confirm: ["policy_anyone"] }`. An update that keeps `anyone` needs none; the token is ignored when not needed. The SPA shows the ban-risk warning before sending it (FR-012, US4.6); the server enforces it.
- **Rights.** An id of a removed module stays stored (`orphanRights`) and may be kept or removed; no new id outside the catalogue can be added.
- **Cache.** Every write calls `keyStore.invalidate(id)` (`settingsCache.invalidate("api_keys")`) in the same request, after the write commits.

### 1.7 Audit (FR-020, FR-082)

`ctx.audit(action, target, result, detail)` is called by the route, **once per distinct action and request, only when something changed**. A request that fails validation, the guard or the step-up is not audited (002 section 1.15), except AUTH-7 which is an authentication event. No detail holds a secret, a recipient, a message text, a caption or a file name.

| Action | Written by | Target | Detail (closed key set) |
|---|---|---|---|
| `api.enable` | API-2 | none | `{}` |
| `api.disable` | API-2 | none | `{ cancelled }` |
| `api.plainhttp.update` | API-2 | none | `{ added: [ranges], removed: [ranges] }` (private ranges, not secrets) |
| `api.key.create` | API-5 | `String(id)` | `{ name, last4, rightsAdded: [ids], policyTo: mode, changed: [field names] }` |
| `api.key.duplicate` | API-7 | `String(new id)` | the create set plus `source: <source id>` |
| `api.key.update` | API-6 | `String(id)` | `{ name, last4, rightsAdded, rightsRemoved, changed, policyFrom, policyTo, widened: [reasons] }`; `policyFrom`/`policyTo` only when the mode changed, `widened` only when a step-up was required |
| `api.key.revoke` | API-8 | `String(id)` | `{ name, last4, cancelled }` |
| `api.test` | API-11, on acceptance only | `String(message id)` | `{ format, kind: "private" or "group" }` |
| `account.confirm` | AUTH-7 | the origin | `ok` and `fail`: none; `blocked`: `{ retryAfterMs }` |
| `api.origin.block` | the API layer, through the injected audit, once when a block starts | the origin key | `blocked`, `{ retryAfterMs }` |

`changed` holds field names among `name`, `rights`, `policy`, `recipients`, `limits`, `ipAllow`, `expiresAt` (for a create or duplicate: those that differ from an empty key). If the serialised detail would exceed 1900 characters, `rightsRemoved` is replaced by `rightsRemovedCount`, then `rightsAdded` by `rightsAddedCount` (`serializeDetail` would otherwise turn it into `{ truncated, length, keys }`, losing the "what").

`account.confirm` follows AUTH-2: a `fail` row per wrong password, plus one `blocked` row when that failure starts the block; no row for a refusal during a block; no alert.

Changes in `lib/admin/audit.js`: `ACTIONS` gains the ten names above (a documentation list, not enforced). The `account` prefix already exists in `ACTION_PREFIXES`; **`api`** is added after `broadcast` in `public/js/views/audit-logic.mjs`, with `audit.prefix_api` in both catalogs (`test/admin-view-logs-stats.test.js:236-241` fails otherwise). The detail keys the audit page may summarise are the union `name, last4, source, rightsAdded, rightsRemoved, changed, policyFrom, policyTo, widened, cancelled` (panel-ui.md owns the `summarizeDetail` branch).

### 1.8 Alerts and settings shown on the page (research.md X2, X9, U12)

Three alert types, raised by a **direct** `alerts.raise(type, payload)` from the API and engine layers through an injected `deps.alerts` (no new bus topic). `AlertOutbox.TYPES` and `ALERT_TYPES` of `lib/admin/services/alerts.js:20-27` grow from 6 to 9 types, and so does the list in `public/js/views/alerts-logic.mjs`; ALR-1 lists them in this order after `update_available`.

| Type | Toggle (default) | Slot and window | Payload (rebuilt field by field in `sanitize`) | Raised when |
|---|---|---|---|---|
| `api_origin_blocked` | `ALERT_API_ORIGIN_BLOCKED` (on) | `api_origin_blocked:<origin>`, 15 min | `{ origin, retryAfterMs, at }` | the origin throttle reports `newlyBlocked` (FR-018) |
| `api_key_new_ip` | `ALERT_API_KEY_NEW_IP` (**off**) | `api_key_new_ip:<keyId>:<ip>`, 24 h | `{ keyId, keyName, ip, at }` | a key authenticates from an IP absent from a non-empty `seenIps` (the first IP of a key never alerts, FR-019) |
| `api_paused` | `ALERT_API_PAUSED` (on) | `api_paused`, 15 min | `{ code, resumesAt, at }` | the engine's restriction breaker opens (U5) |

Texts `alerts.api_origin_blocked` (`{0}` origin, `{1}` minutes), `alerts.api_key_new_ip` (`{0}` key name, `{1}` IP), `alerts.api_paused` (`{0}` minutes) in the bot catalogs; panel keys `alerts.type_<type>` and `alerts.type_<type>_desc`. Slots `api_origin_blocked:*` and `api_key_new_ip:*` are pruned like `login_blocked:*` (`housekeeping.pruneAlertStates`).

The page reads and edits these entries through SET-1/SET-2 (no second write path); the switch and `plainHttpFrom` are **not** catalog entries (API-2 is their only writer):

| Field of `State.settings` | Catalog key | Default | Rule |
|---|---|---|---|
| `minSpacingMs` | `SEND_MIN_SPACING_MS` | 2000 | `int(2000, 600000)`, up only (FR-035) |
| `perMinute` / `perDay` / `maxPending` | `API_RATE_PER_MINUTE` / `API_RATE_PER_DAY` / `API_MAX_PENDING` | 30 / 1000 / 100 | `int(1,1000)` / `int(1,100000)` / `int(1,5000)` |
| `queueMax` | `API_QUEUE_MAX` | 500 | `int(1,5000)` |
| `expiryMin` | `API_QUEUE_EXPIRY_MIN` | 10 | `int(1,1440)` |
| `retentionDays` | `API_RETENTION_DAYS` | 30 | `int(1,365)` |
| `replyWindowDays` | `API_REPLY_WINDOW_DAYS` | 7 | `int(1,30)`, cross rule `<= API_RETENTION_DAYS` (`bound_conflict`) |
| `alerts.*` | the three toggles above | on / off / on | boolean |

All eleven are panel-only (`env: null`), live in the existing `limits` and `alerts` Settings themes, and are read at call time by the engine (capture-site rule).

---

## 2. Routes

Notation as in 002 section 2: every route is `session`-authenticated, fully guarded (CSRF `yes` for unsafe methods, `no` for `GET`), touches the session, needs the database. **Step-up**: `true`, `conditional` (1.5) or `no`. **Confirm**: the server-enforced confirmation (1.4). **Body**: `schema` (strict, nested) or an explicit `bodyLimit`.

| ID | Method and path | Auth | CSRF | Step-up | Confirm | Body | Audit | Success | Spec |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| API-1 | `GET /admin/api/api` | session | no | no | | | none | 200 | FR-001, FR-003, FR-019, FR-036, FR-080 |
| API-2 | `PUT /admin/api/api/state` | session | yes | conditional | `disable_api` | schema | `api.enable`, `api.disable`, `api.plainhttp.update` | 200 | FR-001, FR-002, FR-003, FR-020, FR-021, US4 |
| API-3 | `GET /admin/api/api/catalog` | session | no | no | | | none | 200 | FR-011, FR-082, FR-092 |
| API-4 | `GET /admin/api/api/keys` | session | no | no | | | none | 200 | FR-010, FR-019, FR-080 |
| API-5 | `POST /admin/api/api/keys` | session | yes | true | `policy_anyone` | schema | `api.key.create` | 201 | FR-010, FR-011, FR-012, FR-013, FR-014, FR-020, FR-021, US1.2, US4.7 |
| API-6 | `PUT /admin/api/api/keys/:id` | session | yes | conditional | `policy_anyone` | schema | `api.key.update` | 200 | FR-011, FR-012, FR-013, FR-014, FR-020, FR-021, US4.1, US4.7, US4.8 |
| API-7 | `POST /admin/api/api/keys/:id/duplicate` | session | yes | true | | schema | `api.key.duplicate` | 201 | FR-015, FR-020, FR-021, US4.3 |
| API-8 | `POST /admin/api/api/keys/:id/revoke` | session | yes | no | `revoke_key` | schema | `api.key.revoke` | 200 | FR-014, FR-020, US4.2, US4.8 |
| API-9 | `GET /admin/api/api/messages` | session | no | no | | query | none | 200 | FR-073, FR-081, US3.5 |
| API-10 | `GET /admin/api/api/messages/:id` | session | no | no | | | none | 200 | FR-070, FR-072, FR-081 |
| API-11 | `POST /admin/api/api/test` | session | yes | no | | bodyLimit 64 KiB | `api.test` | 202 | FR-082, US4.4 |
| API-12 | `GET /admin/api/api/usage` | session | no | no | | query | none | 200 | FR-083 |
| API-13 | `GET /admin/api/api/openapi` | session | no | no | | | none | 200 | FR-084 |
| AUTH-7 | `POST /admin/api/session/reauth` | session | yes | no | | schema | `account.confirm` | 200 | FR-021, US4.7 |

**API-1.** `200 State`. No query. Reads `apiState` (cached), the key table (counts), the engine (`stats()` of runtime.md: queued count, pause) and the settings store; writes nothing.

**API-2.** Body `{ enabled, plainHttpFrom?, confirm? }`: `enabled` boolean required; `plainHttpFrom` array of string (at most 50, each at most 64 characters), absent = unchanged, a present list replaces the stored one; `confirm` boolean. The desired state is declarative: a pure `plainHttpFrom` edit sends the current `enabled`. Answer `200 { enabled, plainHttpFrom, changed, cancelled }`.
Order: router; schema; `plainHttpFrom` entries (1.4); `enabled: true` while `State.failure` is set gives `409 api_disabled { reason: "registry_failed" }`; `true -> false` without `confirm: true` gives `409 confirmation_required { confirm: "disable_api" }`; the diff is computed under `withLock("api-state")`: nothing changed gives `200 changed: false` and no audit; `ctx.stepUp(reasons)` with `reasons` among `enable`, `plain_http` when the predicate holds; then one write of the `ApiState` row (both fields in the same statement when both changed), memory, listeners (`apiState.onChange` enables or disables the engine), audit. Disabling cancels the queue: `cancelled` is the count from `messaging.disable({ reason: "api_disabled" })`; enabling answers `cancelled: 0`.

**API-3.** `200 Catalog`. Built from the in-memory registries, so new modules appear with no edit here (FR-092).

**API-4.** `200 { items: [KeyView] }`, revoked keys included (until purged). The list already carries every field: there is no `GET /keys/:id` (a `GET` on that path is `405`).

**API-5.** Body `KeyInput` (no `version`). Order: router guard; schema; the router's `stepUp: true` gate (`403 password_required`); pure semantics (rights, recipients, IP, expiry); under `withLock("api-keys")`: `limit_reached`, name `duplicate`; `policy_anyone` confirmation; secret generation and write; audit. `201 { key, secret }`.

**API-6.** Body `KeyInput` plus `version`: full replace. Order: router; schema; `404 not_found { resource: "key" }`; `409 not_editable` when revoked (an **expired** key is editable, so its expiry can be extended); pure semantics; stored-data semantics under the lock (name `duplicate`); `409 conflict`; `policy_anyone` confirmation; `ctx.stepUp(widenings)` when non-empty; write. `200 { key, changed }`; an identical normalised result is `changed: false`, nothing written, no version bump, no audit.

**API-7.** Body `{ name? }` (same rules as KeyInput `name`). Order: router guard; schema; the router's `stepUp: true` gate; `404`; `409 not_editable` (revoked or expired source); name resolution and `duplicate`; `limit_reached`; write. `201 { key, secret }`.

**API-8.** Body `{ confirm }`. Order: router; schema; `confirm !== true` gives `409 confirmation_required { confirm: "revoke_key" }`; `404`; act (1.6). `200 { key, cancelled }`.

**API-9.** Query (all optional, strict): `key` `^(panel|[1-9]\d{0,9})$` (`panel` = `source: "panel"`; an id with no match is an empty page, not a 404), `status` (one of the nine), `format` `^[a-z][a-z0-9_]{0,23}$` (no `isIn`: formats are modules), `from` and `to` (ISO-8601 with `Z` or an offset, inclusive bounds on `acceptedAt`; `from > to` is an empty page), `page` (>= 1), `pageSize` (1 to 200, default 50). `200 { items: [MessageRow], page, pageSize, total }`, newest first (`acceptedAt` descending, then `id`). Content is never part of a row: no text, caption, file or option text exists to return (FR-073).

**API-10.** `:id` is the internal integer. `200 { message: MessageDetail }`; `404 not_found { resource: "message" }`. Polled by the SPA (research/d D5); it writes nothing.

**API-11.** The test send (FR-082), with the same engine, content validation, `chat_disabled` check, pacing, global cap, admission by wait and media rules as the API; `source: "panel"`, no key, so **no** key right, per-key quota or recipient policy applies (public-api.md 7.1). No step-up (not listed in FR-021); no extra throttle (pacing and `API_QUEUE_MAX` bound it); no idempotency key. The body is a **flat** JSON object; the router declares `bodyLimit` 64 KiB and no `schema`, and the service validates through the engine's `validateInput`:

| Property | Rule |
|---|---|
| `format` | required, one of `Catalog.formats[].name` (`required`, `invalid_type`, `not_allowed { allowed }`) |
| `to` | required; exactly the public rule (public-api.md 3.1): a number with country code or a group id; the bot's own number is `not_allowed` (U7) |
| `quote` | optional; the public id of an earlier **panel** message to the same chat in `sent`, `delivered` or `read`, else `fields.quote = { code: "not_found" }` |
| `uploadId` | optional, 32 hex; a media file uploaded with UP-1 `purpose=api` by this session. With `media.url` instead (no right needed, same SSRF protections), exactly one source: neither gives `fields.media = required`, both `fields.media = not_allowed`; `uploadId` on a format without media gives `fields.uploadId = not_allowed` |
| the format's own fields | the property names and rules of public-api.md section 3, dotted `fields` keys (`buttons.1.id`, `contacts.0.phones.2`), `$unknown` at the level of an unknown property |

`wait` and `idempotencyKey` are transport options of the public API and are `$unknown` here.
Order: router (guard and body read: `413 payload_too_large`, `400 bad_request`); `409 api_disabled { reason: "switch_off" }` (the engine does not run otherwise, FR-001); `format`; `to`; fields; media (upload `peek`, sniff against the format, size cap, URL fetch: `media_type_mismatch`, `media_too_large`, `url_forbidden`, `url_unreachable`); `chat_disabled`; admission (`queue_full`); accept. The service hands the engine `messaging.submit({ source: "panel", apiKeyId: null, to, format, fields, media, requestId })`; the engine copies the file to its staging directory. **Only after acceptance** does the service call `uploads.consume(uploadId, ctx.session.id, { purpose: "api" })`: a refused test leaves the upload in place so the owner can fix the other fields and retry (it expires after 1 hour). Answer `202 { message: MessageRow }` (`source: "panel"`, `key: null`, `status: "queued"`, even when the bot is offline); audit `api.test`. A refusal raised by the engine (`MessagingError`) is mapped by code through `STATUS_BY_CODE` (1.4), never a 500.

**API-12.** Query: `days` `7` or `30` (default 7), `key` `^(all|panel|[1-9]\d{0,9})$` (default `all`). Days are the local calendar days of `TIMEZONE` (`stats.js` `dayOf`), from `today - days + 1` to `today`, attributed by `acceptedAt`. `sent` counts `sent`, `delivered`, `read`; `failed` counts `failed`, `expired`, `unknown`; `queued`, `sending` and `cancelled` are counted in neither. Entries: for `all`, every non-revoked key plus any revoked key with a message in the window, plus a `panel` entry only when it has messages; for `panel`, the `panel` entry; for an id, that key (`404 not_found { resource: "key" }` when unknown). Data older than `API_RETENTION_DAYS` is purged, so those days read zero. `200 Usage`.

**API-13.** `200`, the OpenAPI 3.1 document (public-api.md section 10) as a JSON body, `Content-Type: application/json; charset=utf-8`, `Content-Disposition: attachment; filename="openwhatsappbot-api-v1.openapi.json"`. Works while the API is switched off (the owner reads the documentation before enabling). While `State.failure` is set there is no registry to describe: `409 api_disabled { reason: "registry_failed" }`. `servers[0].url` is `State.baseUrl`. English only.

**AUTH-7.** Body `{ password }` (string, `nfkc`, 1 to 256, the schema of AUTH-2). Order: router; schema; `limits.password.check(origin)` **before** any hashing, blocked gives `429 rate_limited { retryAfterMs }`; the account row; `passwords.verify`; wrong: `limits.password.fail`, audit `account.confirm` `fail` (plus `blocked` when `newlyBlocked`), `422 validation_failed { fields: { password: { code: "wrong_password" } } }`; right: `limits.password.success`, `sessions.confirm(session.id, now)`, audit `ok`. `200 { confirmedUntil, windowMs: 300000 }`. The hash queue being full is `429 rate_limited` as elsewhere.

Example (API-5 answer, abridged):

```json
{ "key": { "id": 3, "name": "n8n", "last4": "x9Qa", "status": "active", "version": 1, "rights": ["messages.send.text"],
    "policy": { "mode": "list", "recipients": [{ "jid": "237690000001@s.whatsapp.net", "name": null }] },
    "limits": { "perMinute": null, "perDay": 500, "maxPending": null }, "ipAllow": [], "expiresAt": null,
    "orphanRights": [], "lastUsedAt": null, "lastUsedIp": null, "seenIpCount": 0, "queued": 0,
    "createdAt": "2026-11-02T10:00:00.000Z", "updatedAt": "2026-11-02T10:00:00.000Z", "revokedAt": null },
  "secret": "owbk_0123456789abcdef_<43 base64url characters>" }
```

---

## 3. Changes to existing routes

The 002 and 003 contracts are not edited; these are the observable changes to existing routes and shared mechanisms, all additive.

| Item | Change |
|---|---|
| UP-1 `PUT /admin/api/uploads?purpose` | `purpose` gains `api` (`PURPOSES` of `lib/admin/http/uploads.js:47` becomes backup, broadcast, api). The sniffer for `api` is the engine's `sniff.classify` (runtime.md, injected through `createUploads({ sniff })`, `uploads.js:144`); `kind` and `mime` of the `201` answer are the detected ones, whatever the format that will use them: whether they suit a format is the engine's `media_type_mismatch`, at API-11. Nothing recognised or not allowed gives `422 unsupported_file_type`. Cap, quota, one-in-flight and the 1 h TTL are unchanged. UP-2 works for these uploads as is |
| ALR-1 `GET /admin/api/alerts` | `types` grows from 6 to 9 entries (1.8), `settingKey` per type; `recent` may list the new types |
| SET-1 / SET-2 | 11 new editable entries (112 in all, 78 editable), all `env: null`; no `API_ENABLED` entry exists, so SET-2 cannot flip the switch |
| AUD-1 | no shape change; the vocabulary gains the actions of 1.7 and the filter prefix `api` |
| `router.routes()` and `ctx` | rows gain `stepUp`; `ctx.stepUp(reasons)` exists on `"conditional"` routes (1.5). `test/admin-http.test.js:99` pins the key set of a row and must list it |
| `STATUS_BY_CODE` (`response.js:22`) | gains `password_required` 403, `api_disabled` 409 and every key of `MESSAGING_STATUS`; all are added to `EXTRA_SERVER_CODES` of `admin-i18n.test.js` (the 49-code pin of the 002 table is untouched) |
| CHAT-1, BAK-1..BAK-5 | none. CHAT-1 feeds the recipient pickers unchanged; the four `Api*` tables are in `EXCLUDED_MODELS`, so an export or a restore never carries keys, history or the switch (research.md U9) |
| EVT-1 | none: no hub topic is added (five are pinned); the SPA polls API-10 |

---

## 4. Coverage matrix

| FR | Route(s) and rules |
|---|---|
| FR-001, FR-002 | API-2 (switch, queue cancelled), API-11 `api_disabled`; engine and availability in public-api.md section 9 |
| FR-003 | API-1 (`https`), API-2 (`plainHttpFrom`, step-up `plain_http`) |
| FR-010 | API-5, API-7 (secret once, `last4`), API-4 |
| FR-011 | API-3 (catalogue), API-5, API-6 (rights, deny by default, `orphanRights`) |
| FR-012 | API-5, API-6 (`policy`, `policy_anyone`) |
| FR-013 | API-5, API-6 (`ipAllow`, `expiresAt`) |
| FR-014 | API-8 (revoke, cancel), API-6 `not_editable`, name uniqueness 1.6 |
| FR-015 | API-7 |
| FR-017 | 1.6 (secret nowhere else), 1.7 (no secret in audit), leak scan |
| FR-019 | API-4 (`lastUsedAt`, `lastUsedIp`); alert `api_key_new_ip` (1.8) |
| FR-020 | 1.7 (audit rows) |
| FR-021 | AUTH-7, 1.5 (router `stepUp`, widening predicate, 5-minute window, shared limiter) |
| FR-036 | API-1 `settings`, 1.8 |
| FR-073 | API-9, API-10 (no content), 1.7 |
| FR-076 | not a route (`EXCLUDED_MODELS`), section 3 |
| FR-080 | API-1, API-4 to API-8 |
| FR-081 | API-9, API-10 |
| FR-082 | API-3, API-11 (+ UP-1 `purpose=api`) |
| FR-083 | API-12 |
| FR-084 | API-13 |
| FR-085 | panel catalogs: `errors.<code>`, `fields.not_found`, `alerts.type_*`, `audit.prefix_api` (panel-ui.md owns the API-area keys) |
| FR-092 | API-3 (new modules appear by themselves) |

Success criteria that depend on this contract: SC-002 (no widening without the password, SC-002-style enumeration of the `stepUp` set), SC-003 (no secret or content in audit or logs), SC-009 (a demo format appears in API-3 and API-11 with no edit here).

---

## 5. Test obligations

Run each file alone with caps (`OWB_NO_CONFIG_ENV=1 timeout 120 node --max-old-space-size=1024 --test --test-force-exit --test-timeout=30000 test/<file>.test.js`); never two suites in parallel.

- `test/admin-integration.test.js`: add `API_CONTRACT` (read of `specs/004-messaging-api/contracts/admin-api.md`), the third `SECTIONS` entry of the machine-read format, and a test beside the 003 one: the slice yields exactly `API-1` to `API-13` and `AUTH-7` with the paths of the table, all registered with `auth: "session"`, and `API_CONTRACT.match(ROUTE_ROW).length === 14`. `UNDOCUMENTED` stays unchanged.
- `test/admin-http.test.js`: the key set of a `routes()` row gains `stepUp` (`:99`); `stepUp` accepts only `true` or `"conditional"` on unsafe `session` routes and throws otherwise; `true` runs after validation (a 422 body is never asked for a password) and before the handler; `ctx.stepUp` exists only on `"conditional"` routes and throws elsewhere; `reasons` reach the error params; an `auth` stub without `requireRecent` fails closed.
- `test/admin-security.test.js`: the exact `stepUp` set (`true`: API-5, API-7; `"conditional"`: API-2, API-6; everything else `false`); the new routes get 401, CSRF, Origin, 415 and 405 coverage from the table for free; the GET-writes-nothing test holds with the four new tables in `dumpTables()` and `ApiState` still empty after API-1.
- `test/admin-stepup.test.js`: AUTH-7 happy path (`confirmedUntil = now + 300000`, audit `ok`); wrong password is `422 wrong_password`, never 401, audit `fail`, nothing confirmed; 5 failures then `429` with the right password refused, one `blocked` row, no row during the block; the bucket is shared with AUTH-5 (failures through either door count); fake clock: valid at +299 999 ms, `403` at +300 000 ms; not valid for another session; lost after logout, password change, `clearCache()` and a rebuilt session cache, kept across the 60 s database refresh; a login does not confirm; a `true` route unconfirmed saves nothing (`dumpTables()` unchanged); CSRF still required on AUTH-7; no alert raised.
- `test/admin-api-state.test.js`: API-1 shape and sources (effective settings in minutes and days, `settingKeys`, `queued`, `pausedUntil`, `failure`), no row created; API-2 matrix (enable asks, disable needs `confirm` and asks nothing, `cancelled` count, same state `changed: false` without audit, `plainHttpFrom` widening asks and narrowing does not, `invalid_format` and `not_private` with `indices`, `api_disabled` on a failed registry, audit rows); API-3 (rights, formats and endpoints from a fake registry plus a demo module appearing with no edit, empty lists on failure); API-13 (headers, works while disabled, English, `baseUrl`).
- `test/admin-api-keys.test.js`: API-4 to API-8: every schema error with dotted paths and `indices` and no value echoed; the widening matrix, one case per reason (`rights`, `policy` (a) and (b) including a recipient added under `known`, `ip` including `covers` and an emptied list, `expiry` including an expired key extended, `plain_http`) and every narrowing case that must not ask, driven by the shared fixture `test/fixtures/api-widenings.json` that `test/admin-view-api-logic.test.js` also loads (client reasons must be a superset of the server's); `policy_anyone` order (confirmation before step-up, none on duplicate, none when kept); `conflict` with the current version; `changed: false`; name uniqueness (case, trim, revoked frees the name) and the duplicate suffix within 64 code points; `limit_reached` at 50; `not_editable` cases; secret returned once, in no other answer, no audit row, no hash or lookup id in any `KeyView`, `Cache-Control: no-store`, redactor registration; revoke cancels (count), invalidates the key cache, is idempotent, survives a throwing `cancelForKey` with `cancelled: null`; audit rows (names, targets, closed detail sets, the 1900-character degrade).
- `test/admin-api-messages.test.js`: API-9 filters (`key` including `panel`, status, format, period), pagination, order and the absence of any content column; API-10 (`steps` order, `responses` for buttons, list and poll with totals and labels, `null` for non-interactive, `404`); API-11 flat body, `uploadId` from purpose `api`, `source: "panel"`, same engine and caps as the API (a fake engine that records `submit`), engine refusals mapped to their statuses (`chat_disabled`, `queue_full` with `Retry-After`, `media_type_mismatch`, `media_too_large`, `url_forbidden`, `url_unreachable`), dotted `fields`, `fields.uploadId` and `fields.quote` `not_found`, upload kept on refusal and consumed on acceptance, `api_disabled`, `payload_too_large`, no audit on refusal, audit `api.test` without recipient or content; API-12 dense zero-filled days in a non-UTC `TIMEZONE` across a day edge, `sent`/`failed` classes, entry selection rules, `404` for an unknown key.
- `test/admin-api-leak.test.js` (SC-003, panel side): after the scenarios above with a canary key secret, text, caption, file name and URL, scan the log ring, every `AuditLog.detail`, every response body other than API-5/API-7's `secret` field, and every text/JSON column of the four tables; none contains the token, its 43-character secret part, a recipient list in an audit detail, or the canary, and `owbk_[0-9a-f]{16}_` appears nowhere outside that one field.
- `test/admin-i18n.test.js`: `EXTRA_SERVER_CODES` gains `password_required`, `api_disabled` and every `MESSAGING_STATUS` code (each with `errors.<code>` in both catalogs); `fields.not_found` exists; `alerts.type_api_*` and `_desc`; `audit.prefix_api`; the key set of `errors.password_required` params is pinned.
- `test/admin-audit.test.js` and `test/admin-view-logs-stats.test.js`: `ACTIONS` lists the ten actions; every action has an `ACTION_PREFIXES` prefix (`api`) and `audit.prefix_api`.
- `test/admin-uploads.test.js`: `purpose=api` accepted, sniffed by the injected classifier, a script or executable refused `422 unsupported_file_type`, consumed by API-11 only after acceptance, an `api` upload invisible to another session.
- `test/alerts.test.js`, `test/admin-alerts.test.js`, `test/admin-view-alerts.test.js`: nine types in order with their toggles, payload sanitising, slots and windows of 1.8, `AlertOutbox` validation, pruning of `api_origin_blocked:*` and `api_key_new_ip:*`.
