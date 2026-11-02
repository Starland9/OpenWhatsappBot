# Contract: runtime modules (bot side)

Feature `004-messaging-api`. Internal module contract of the messaging engine (`lib/messaging/**`), the public API layer (`lib/api/**`), their shared utilities and the edits to existing modules: what each module exports, its invariants, who calls it, and what it reads at call time. Inputs: [../spec.md](../spec.md), [../research.md](../research.md) (**authoritative**: U1-U15 and X1-X22 override the stream files), research streams [A](../research/a-http-security.md) (A1, A3-A8), [B](../research/b-messaging-engine.md) (all) and [C](../research/c-data-panel-backend.md) (C3, C6-C8). Siblings: [public-api.md](public-api.md) (wire format, pipeline table, error catalogue), [admin-api.md](admin-api.md) (panel routes and services), [../data-model.md](../data-model.md) (columns, indexes, status machine T1-T11, retention statements), [panel-ui.md](panel-ui.md). Column names are those of data-model.md; public property names are those of public-api.md. Where a stream disagrees with research.md, research.md wins; the points settled while writing are in [section 20](#20-points-settled-while-writing-this-contract), the inconsistencies between sources in [section 21](#21-inconsistencies-between-sources).

Contents: [0 map](#0-module-map-and-rules) / [1 facade](#1-libmessagingindexjs-the-facade) / [2 errors](#2-errorsjs-and-limitsjs) / [3 formats](#3-formats) / [4 outbox](#4-outboxjs) / [5 recipients](#5-recipientsjs) / [6 never a command](#6-never-a-command) / [7 replies](#7-reply-capture) / [8 receipts](#8-receipts) / [9 URL fetch](#9-urlfetchjs-and-link-preview) / [10 media](#10-media-inspection-and-staging) / [11 send gate](#11-libutilssendgatejs-and-the-broadcaster-change) / [12 schema](#12-libutilsschemajs) / [13 apiState](#13-libutilsapistatejs) / [14 other edits](#14-edits-to-existing-modules) / [15 lib/api](#15-libapi) / [16 boot](#16-boot-and-lifecycle) / [17 settings, alerts, housekeeping](#17-settings-alerts-housekeeping) / [18 tests](#18-test-obligations) / [19 docs](#19-docs-to-update) / [20 settled](#20-points-settled-while-writing-this-contract) / [21 inconsistencies](#21-inconsistencies-between-sources)

## 0. Module map and rules

### 0.1 New files

| File | Role | Section |
| ---- | ---- | ------- |
| `lib/messaging/index.js` | facade and composition root (`createMessaging`), the `ENGINES` entry of `boot.js` | 1 |
| `lib/messaging/errors.js`, `lib/messaging/limits.js` | `MessagingError`, `MESSAGING_STATUS`, failure/cancel/unknown codes; frozen limits | 2 |
| `lib/messaging/formats/index.js` + 13 modules `formats/{text,image,video,gif,audio,voice,document,sticker,location,contact,poll,buttons,list}.js` | format registry and the format modules | 3 |
| `lib/messaging/vcard.js` | vCard 3.0 builder | 3.8 |
| `lib/messaging/outbox.js` | queue, pacing, claim, send, expiry, pause, waiters, cancellation, recovery | 4 |
| `lib/messaging/recipients.js` | recipient parsing, policy, disabled chat, self number, reachability, group posting, mentions, `mask` | 5 |
| `lib/messaging/sentIds.js` | bounded set of the ids this process sent | 6 |
| `lib/messaging/replies.js`, `plugins/apireplies.js` | reply and poll-vote capture, `describeResponses` | 7 |
| `lib/messaging/receipts.js` | delivery/read/negative-ack handler | 8 |
| `lib/messaging/urlFetch.js` | SSRF-safe fetcher and link preview | 9 |
| `lib/messaging/sniff.js`, `lib/messaging/stage.js` | content detection; staged media lifecycle | 10 |
| `lib/utils/sendGate.js` | process-wide pacing shared by the outbox and the broadcaster | 11 |
| `lib/utils/schema.js` | strict schema core (nested objects, `unique`), shared by the panel and the API | 12 |
| `lib/utils/apiState.js` | the switch and the plain-HTTP network list | 13 |
| `lib/utils/stickerMaker.js` | image to sticker conversion, extracted from `plugins/sticker.js` | 14.4 |
| `lib/api/index.js` `router.js` `registry.js` `pipeline.js` `transport.js` `keyStore.js` `limits.js` `idempotency.js` `ipRules.js` `multipart.js` `upload.js` `openapi.js` `present.js` `errors.js` `version.js` `endpoints/{messagesCreate,messagesGet,messagesList,openapiJson}.js` | public API layer | 15 |
| `test/fixtures/api-ip-entries.json` | shared IP grammar fixture | 15.9 |

### 0.2 Edited files

| File | Change | Section |
| ---- | ------ | ------- |
| `lib/core/boot.js` | `ENGINES` entry `messaging`; `apiState` collaborator and `load`; deps passed to `createAdmin` | 16 |
| `lib/core/pipeline.js` | `sentIds` guard (the only pipeline change) | 6, 14.6 |
| `lib/admin/server.js`, `lib/admin/index.js` | `api` mounting, `admin.api`, start/stop | 15.14 |
| `lib/admin/http/{trustProxy,security,response,request}.js`, `lib/admin/logs/redactor.js` | `clientAddress`; `profile: "api"`; `retryAfterHeader` export; `request.js` re-export of `lib/utils/schema.js`; built-in key pattern | 12, 15.14 |
| `lib/utils/broadcaster.js` | global pacing floor (4 lines, 1 option) | 11 |
| `lib/utils/permissions.js`, `lib/admin/services/permissions.js` | `parsePhoneNumber` moved from `parsePerson` | 14.1 |
| `lib/utils/knownChats.js`, `lib/classes/Message.js` | `isKnown`; two exports | 14.2, 14.3 |
| `plugins/buttons.js`, `plugins/sticker.js` | builders + no-fallback sender; sticker helpers moved | 14.4, 14.5 |
| `lib/utils/alerts.js`, `lib/database/models/AlertOutbox.js`, `lib/utils/housekeeping.js`, `lib/utils/settingsCatalog.js`, `lib/utils/settingsCache.js` (comment) | three alert types; five housekeeping steps; eleven settings; cache key | 17 |
| `lib/admin/backup/format.js` | four models in `EXCLUDED_MODELS` | [../data-model.md](../data-model.md) section 6 |
| `tools/panel-memory-child.js` | modes `api-off`, `api-on` | 18 |

No change in `lib/baileys/client.js` (G3: receipts, appends and reconnections are served by what it already emits, 8 and 6). No new dependency (G2). No new core bus topic: the three alerts are direct `alerts.raise` calls.

### 0.3 Rules for every new module

| # | Rule | Detail |
| - | ---- | ------ |
| RT-01 | Layering | `lib/messaging/**`, `lib/utils/{sendGate,schema,apiState}.js` never require `lib/api/**` or `lib/admin/**`, with one exception: `apiState.setPlainHttpFrom` lazily requires `lib/api/ipRules.js`, which is a dependency-free leaf (Node `net` only, 15.9). `lib/api/**` may require only `lib/admin/http/*`, `lib/admin/auth/rateLimit.js` and `lib/admin/logs/redactor.js` from the panel, and `lib/messaging/**`, `lib/utils/**`. `lib/admin/**` may require both (routes and services resolve them lazily: `deps.x \|\| require(...)`). `test/admin-logging.test.js` gets a static scan for the first two lines |
| RT-02 | No work at `require` | no timer, listener, socket, directory or query at load. Timers (`unref()`'d) and listeners exist only while the API is enabled (16.3); a disabled API holds no queue, no timer and no listener (FR-001) |
| RT-03 | Settings at call time | every `config.X` is read where it is used, never in a module-level constant, a class field or a default parameter; a value copied into a row (`expiresAt`, `repliesUntil`) is a snapshot taken at the event the spec names. No `reconfigure()` exists: the tick interval is a constant and no timer is built from a setting (`test/capture-sites.test.js`, 18) |
| RT-04 | Heavy modules are lazy | `sharp`, `node-webpmux`, `file-type`, `ffmpeg`, `urlFetch`, `stickerMaker`, `plugins/buttons.js` and the button helper are required inside the function that needs them, so `require("./lib/admin")` leaves them unloaded (SC-011, `test/admin-memory.test.js`). Format and endpoint modules keep their top-level requires to `lib/utils/{schema,permissions}.js` and `lib/messaging/{limits,vcard}.js` |
| RT-05 | Logging | `createLogger(name)`; `safeLog(err)` for errors. Never logged: the text, caption, URL, file name, option or button label, the recipient in clear (use `mask`), the key token or its secret, `req.url`, `req.headers`, `req.body`. A recipient appears as `mask(jid)`, a message as `publicId` or `waId` |
| RT-06 | Errors | engine refusals are `MessagingError`s (2); the HTTP layer maps them with `toApiHttpError`, the panel with `STATUS_BY_CODE`; no module outside `lib/api` knows an HTTP status except `MESSAGING_STATUS` |
| RT-07 | Locks | `mutex.withLock("api-outbox", ...)` serialises the multi-statement writes of the engine (admission count + insert, cancellations); `withLock("api-keys")` and `withLock("api-state")` belong to the panel service. Every other write is one conditional `UPDATE ... WHERE status = :from` and a lost race (0 rows) is ignored, as in `broadcaster.js` |
| RT-08 | Clock | every engine function that depends on time takes `now` (ms) in its options or uses the injected `clock`; tests drive `test/helpers/fakeClock.js` |

---

## 1. `lib/messaging/index.js`: the facade

`module.exports` is a process-wide instance of `createMessaging(options)` plus `createMessaging`, `MessagingError`, `MESSAGING_STATUS`. This is the only module `lib/api`, the panel service, `boot.js` and `housekeeping.js` talk to; it reconciles the interface lists of streams B (formats, outbox), A (submit, get, list, counts) and C (lifecycle, cancel, stats, sweep, describe).

Options (all optional, tests): `models`, `clock` (`() => ms`), `random`, `timers`, `config`, `apiState`, `gate` (default `require("../utils/sendGate").shared`), `formats`, `recipients`, `sniff`, `urlFetch`, `stage`, `alerts` (default lazy `require("../utils/alerts")`), `mutex`, `settingsCache`, `secretBox`, `dataDir`, `rootDir`, `newMessageId` (default `generateMessageIDV2` from `baileys`, required lazily), `bannedChats`, `sock` accessor.

```js
// ---- lifecycle (boot.js ENGINES entry: start(engine, client) => engine.start(client)) ---------
start(client)                      -> Promise<void>   // idempotent, never rejects except FormatRegistryError; see 16.3
stop()                             -> Promise<void>   // clears the timer, detaches listeners, ends waiters; queued rows stay queued (FR-038)
isRunning()                        -> boolean         // the timer exists
enable()                           -> void            // switch turned on: timer + receipts listener + kick
disable({ reason = "api_disabled" } = {}) -> Promise<{ cancelled: number }>   // switch turned off (FR-002)
cancelForKey(apiKeyId, reason = "key_revoked") -> Promise<number>             // count of rows moved queued -> cancelled

// ---- accept path (called by lib/api/pipeline.js steps 11-20 and by the panel service API-11) ---
formats                                                  // the format registry (3.1)
resolveRecipient(to, { policy } = {})                    -> Promise<Target>        // 5.2: parse, policy, self number, chat disabled
validateInput(format, body, { target, apiKeyId } = {})   -> Promise<Validated>     // strict schema, refine, quote existence
checkAdmission({ apiKeyId, maxPending })                 -> Promise<void>          // check-only twin of the admission in submit (4.5)
inspectMedia(format, file, { name })                     -> Promise<MediaInfo>     // 10.2 (media_type_mismatch / media_too_large)
fetchMedia(format, url, { signal })                      -> Promise<StagedFile>    // urlFetch + inspect, into data/tmp/api (9)
findByIdempotency({ apiKeyId, key, now })                -> Promise<{ message, requestHash } | null>   // lazy 24 h release
submit(request)                                          -> Promise<{ message, replayed, requestHash }>  // 4.2

// ---- read path -------------------------------------------------------------------------------
get({ apiKeyId, publicId }, { responses = true } = {})  -> Promise<MessageView | null>   // null for unknown, other key, panel row
list({ apiKeyId, status, format, since, until, limit = 25, after }) -> Promise<{ items: MessageView[], next: string | null }>
waitFor(publicId, ms)                                    -> { promise: Promise<MessageView>, cancel(): void }   // 4.7
pendingOf(apiKeyId) -> Promise<number>;  queueSize() -> Promise<number>;  pendingMediaBytes() -> Promise<number>
spacingMs() -> number                                    // max(2000, SEND_MIN_SPACING_MS), call time
stats()     -> Promise<{ enabled, running, queued, sending, pausedUntil: number | null, lastSendAt: number | null, botReady: boolean }>
describeResponses(row, responses) -> object              // exactly the object of public-api.md 4.4 (7.5)
sweepMedia({ now })              -> Promise<{ removed: number, freedBytes: number }>   // 10.4, called by housekeeping
parseRecipient(input) -> { kind, jid, number } | { error: "invalid_format" };  mask(jid) -> string      // pure, 5.1
```

`submit(request)` input (the shape `validateInput` returns, without `mediaMarker`, plus context):

```js
{ source: "api" | "panel", apiKeyId: number | null, requestId: string | null,
  format, to, quote, fields,                   // Validated: `fields` = the format's own fields only (no format/to/quote/media)
  media: null | { path, size, name?, sha256?, mode?: "move" | "copy" },    // a file already on disk; mode defaults to "move" (API); the panel passes "copy" (its upload record is consumed after acceptance)
  policy: null | { mode: "list" | "known" | "any", entries: string[] },    // null = no policy (panel). The key store maps stored `anyone` to `any`
  limits: null | { maxPending: number },
  idempotency: null | { key: string, requestHash: string },
  now?: number }
```

`MessageView` (engine-level, `Date` values; the JSON shapes are `lib/api/present.js` for public-api.md 4.1 and the panel service for `MessageRow`/`MessageDetail`):

```js
{ publicId, source, apiKeyId, recipient, chatType: "private" | "group", format, size, status, errorCode, requestId, waId,
  acceptedAt, expiresAt, sendingAt, sentAt, deliveredAt, readAt, endedAt, repliesUntil,
  interactive: boolean, choices: [{ id, label }] | null, responses: object | null }     // `responses` only when requested and interactive
```
`Target` = `{ jid, kind: "private" | "group", number: string | null }`; `Validated` = `{ format, to, quote, mediaMarker: boolean, fields }` (`mediaMarker` is true when the body carried `media.url`; the URL itself is not returned: the caller already used it); `MediaInfo` = `{ kind, mime, ext, size }`; `StagedFile` = `{ path, size, name, sha256, mime, ext, kind }`.

| # | Invariant |
| - | --------- |
| RT-10 | The facade never throws for an expected refusal other than `MessagingError`; a database failure propagates as is (the HTTP layer turns `isDbDown` into `unavailable`) |
| RT-11 | `get`/`list` are scoped by `apiKeyId` in the WHERE clause: another key's row, a panel row and a purged row are indistinguishable (`null`). `list` is keyset on the internal id descending (newest first); `after` is a `publicId` of the same key, anything else is `MessagingError("validation_failed", { fields: { after: { code: "not_found" } } })` |
| RT-12 | `submit` re-runs `validateInput`, `resolveRecipient` (with the given `policy`) and the admission checks itself: the HTTP layer's earlier calls only order the refusals (FR-032); the panel path relies on `submit` alone |
| RT-13 | While the switch is off `submit` throws `MessagingError("api_disabled", { params: { reason: "switch_off" } })`; the code is mapped only by the panel (`admin-api.md` 1.4), not in `MESSAGING_STATUS` or `API_STATUS` |
| RT-14 | `submit` never fetches a URL and never reads `config.PREFIX`; the body's `media.url` is only a marker |

---

## 2. `errors.js` and `limits.js`

### 2.1 `lib/messaging/errors.js`

```js
class MessagingError extends Error { code; fields?; params?; headers? }       // new MessagingError(code, { fields, params, message })
MESSAGING_STATUS = Object.freeze({ ...9 entries... })                          // code -> HTTP status of the engine refusals
FAILURE_CODES  = Object.freeze({ not_on_whatsapp, chat_disabled, not_in_group, group_announce_only, media_conversion_failed,
                                 payload_unavailable, whatsapp_rejected, send_failed })        // status "failed"
CANCEL_REASONS = Object.freeze({ key_revoked, key_expired, api_disabled })                     // status "cancelled"
UNKNOWN_REASONS = Object.freeze({ interrupted, timeout, connection_closed })                   // status "unknown"
CODE_STATUS    = Object.freeze({ <each of the 14 codes above>: "failed" | "cancelled" | "unknown" })
STATUSES = ["queued","sending","sent","delivered","read","failed","expired","cancelled","unknown"]
```

`MESSAGING_STATUS` (the machine-read error rows of public-api.md section 6 are exactly this plus `API_STATUS`):

| Code | HTTP | Params | Raised by |
| ---- | ---- | ------ | --------- |
| `validation_failed` | 422 | `fields` (dotted paths) | `validateInput`, `resolveRecipient`, `submit` |
| `recipient_not_allowed` | 403 | none (never the number) | `resolveRecipient` |
| `chat_disabled` | 409 | none | `resolveRecipient` |
| `queue_full` | 503 | `scope` `global` \| `wait` \| `disk`, `retryAfterMs` | `checkAdmission`, `submit` |
| `pending_limit_reached` | 429 | `limit`, `retryAfterMs` | `checkAdmission`, `submit` |
| `media_type_mismatch` | 422 | `expected` (kind names; the detected type is never echoed) | `inspectMedia`, `submit` |
| `media_too_large` | 413 | `maxBytes` | `inspectMedia`, `fetchMedia`, `submit` |
| `url_forbidden` | 422 | `reason` `scheme` \| `credentials` \| `port` \| `host` \| `redirects` | `fetchMedia` |
| `url_unreachable` | 502 | none | `fetchMedia` |

The panel imports `MESSAGING_STATUS` wholesale into `STATUS_BY_CODE` (admin-api.md 1.4). `errorCode` of a row is one of the 14 codes; `expired` and the receipts states carry none. `FAILURE_CODES`, `CANCEL_REASONS` and `UNKNOWN_REASONS` together are the `FailureCode` enum of the OpenAPI document and the set of panel keys `api.failure.<code>`.

| # | Invariant |
| - | --------- |
| RT-20 | A `MessagingError` carries only codes, field paths and numbers: no submitted value, recipient, URL, path or stack. `fields` keys are dotted paths with numeric indices (`buttons.1.id`, `options.2`); `$unknown` marks an unknown property (`<path>.$unknown`) |
| RT-21 | One source per HTTP code: a code is in exactly one of `MESSAGING_STATUS` (here) and `API_STATUS` (15.13). The message-level codes (`FAILURE_CODES`, `CANCEL_REASONS`, `UNKNOWN_REASONS`) are a separate vocabulary that is never an HTTP error (public-api.md 4.3) and may reuse a name (`chat_disabled`, `key_revoked`, `key_expired`) |

### 2.2 `lib/messaging/limits.js`

`LIMITS` is a frozen object of numbers and patterns, the single source for the format modules, `refine`, the engine and the tests (public-api.md section 3 states the same values; `test/api-formats-contract.test.js` compares):

| Group | Entries |
| ----- | ------- |
| text | `TEXT` 4096, `CAPTION` 1024, `INTERACTIVE_TEXT` 1024, `BODY_COMPOSED` 4096, `MENTIONS_MAX` 50 |
| interactive | `BUTTONS_MAX` 3, `BUTTON_LABEL` 20, `LIST_ROWS_MAX` 10, `LIST_BUTTON_LABEL` 20, `LIST_TITLE` 24, `LIST_DESCRIPTION` 72, `ID_PATTERN` `/^[A-Za-z0-9_.-]{1,64}$/` |
| poll | `POLL_QUESTION` 255, `POLL_OPTIONS_MIN` 2, `POLL_OPTIONS_MAX` 12, `POLL_OPTION` 100 |
| location, contact | `LOCATION_TEXT` 256, `CONTACTS_MAX` 10, `CONTACT_NAME` 128, `CONTACT_ORG` 128, `CONTACT_EMAIL` 254, `PHONES_MAX` 5 |
| media | `MB` 1048576, `FILE_NAME` 255, `MEDIA_URL` 2048, `MEDIA_MAX` per format in 3.6, `STICKER_OUT` 900 KiB |
| engine | `TICK_INTERVAL_MS` 1000, `SEND_TIMEOUT_MS` 30000, `SEND_TIMEOUT_MEDIA_MS` 90000, `VERIFY_TIMEOUT_MS` 10000, `VERIFY_DEFER_MS` 15000, `WAIT_MAX_MS` 30000, `WAITERS_MAX` 200, `PAUSE_MS` 900000, `IDEMPOTENCY_MS` 86400000, `STAGE_GRACE_MS` 3600000, `ADMISSION_FACTOR` 1.1, `RETRY_MIN_MS` 1000, `RETRY_MAX_MS` 300000, `RESPONSES_MAX` 1000, `SENT_IDS_TTL_MS` 900000, `SENT_IDS_MAX` 2000, `ONWHATSAPP_POSITIVE_MS` 86400000, `ONWHATSAPP_NEGATIVE_MS` 600000, `ONWHATSAPP_CACHE_MAX` 1000, `RESTRICTION_CODES` `["463"]` |

---

## 3. Formats

### 3.1 Registry: `lib/messaging/formats/index.js`

Loads every `formats/<name>.js` except `index.js`, in sorted order, once (memoised; `load({ dir })` for tests). A format is a module, not data (FR-091); adding one needs only the file, its tests and its catalog texts (FR-092).

```js
load({ dir } = {})  -> void                  // throws FormatRegistryError { file, reason } on the first violation (3.5)
list()              -> [{ name, order, right, interactive, media: boolean }]   // sorted by order then name; the format rows of public-api.md
get(name)           -> FormatModule | null
rights()            -> ["messages.send.text", ...]       // derived: "messages.send." + name, never declared
rightsFor(name, input) -> string[]            // [right, ...extra]: "media.url" when input.media?.url is present; plus module.requires(input)
schemaOf(name)      -> RuleTree               // 3.3: common fields + module fields, request.js dialect (12), the single source of validation, OpenAPI and the test form
describe(name)      -> FormatDescriptor       // 3.4, memoised
doc(name)           -> { summary, description?, examples }          // English, for OpenAPI only
class FormatRegistryError extends Error
```

| # | Invariant |
| - | --------- |
| RT-30 | The right is derived (`messages.send.<name>`); a module cannot declare one. A new format is granted to no existing key (FR-011): the key store never adds a right |
| RT-31 | `describe(name)` is a pure function of the module; `schemaOf` and `describe` are built from the same `fields`, so validation, documentation and the test form cannot drift (SC-009) |
| RT-32 | `doc.examples[0]` is the descriptor `example`; every example validates against `schemaOf` and builds through `build()`: `test/messaging-formats.test.js` fails otherwise |

### 3.2 The format module

```js
module.exports = {
  name: "image",                 // = file basename, /^[a-z][a-z0-9_]{1,23}$/
  order: 20,                     // docs, rights editor, test form (public-api.md 3.1: text 10 ... list 130)
  interactive: false,            // true => replies are captured and `interpretReply` is required
  fields: { caption: { type: "string", minLength: 1, maxLength: 1024, trim: true } },   // format-specific rules only (12)
  media: { kinds: ["image"], maxBytes: 16 * MB, required: true, sources: ["file", "url"] },   // absent = no media
  requires(input) {},            // optional -> string[] of extra rights ("media.url" for media.url is automatic)
  refine(input, ctx) {},         // optional, sync -> { [dottedPath]: { code, params? } } | null; ctx = { target: Target | null }
  normalize(input, ctx) {},      // optional, pure -> input in its stored form (phones to digits, mentions to PN digits)
  size(input, media) {},         // optional -> integer | null; default: media ? media.size : null (public-api.md 4.1 `size`)
  async prepare(ctx) {},         // optional, send time, row still queued -> { path, mime, ext } | { preview } | null; throws -> media_conversion_failed
  build(ctx) {},                 // required, sync, pure -> { content, transport?, choices?, replyData?, secret? }
  interpretReply({ row, event }) {},     // required iff interactive -> { choiceIds: string[] } | null
  doc: { summary: "Send an image", description: "...", examples: [{ format: "image", to: "237690000001", caption: "Your receipt" }] },
  form: { hints: { caption: { type: "textarea" } } },    // optional overrides of the derived descriptor (3.4)
};
```

`prepare(ctx)`: `{ input, media: { path, mime, ext, kind, size } | null, dir, signal }`. It writes only inside `dir` (the stage directory) and returns a new file `prepared.<ext>`; the engine never trusts a path outside it (`safeFs.assertInside`). `build(ctx)`: `{ input, media, prepared, target: Target, waId, mentions, preview, randomBytes }`; `mentions` is `[{ number, jid }]` resolved by the engine (3.9); `preview` is the object `prepare` returned for text.

`build` result: `content` is the Baileys content (3.6); `transport` is `"message"` (default: `sock.sendMessage(jid, content, options)`) or `"interactive"` (`plugins/buttons.js#sendPrepared`, 14.5); `choices` is `[{ id, label }]` in display order (buttons, list, poll); `replyData` is `{ v: 1, multi, hashes }` (poll); `secret` is the 32-byte poll `messageSecret`, which the engine encrypts as `pollSecret`. The engine owns the send options (`messageId: waId`, `quoted`): a module never calls the socket (pacing, `messageId`, quoting, timeouts and the `sending` mark stay in one place).

`interpretReply({ row, event })`, `event` one of `{ type: "tap", id }`, `{ type: "number", number }` (1-based), `{ type: "vote", digests: ["<64 hex>"] }`, returns the recorded selection or null. buttons/list: a tap whose `id` is in `row.choices`, or a number `n` in `1..choices.length` (`choices[n-1]`); poll: a vote, digests mapped to indexes through `row.replyData.hashes` (unknown digests dropped, result in option order, possibly empty); everything else null.

### 3.3 Common fields (merged by the registry, a module redefining one fails the load)

| Field | Rule | Notes |
| ----- | ---- | ----- |
| `format` | `{ type: "string", required: true, enum: [name] }` | the discriminator; omitted from descriptors |
| `to` | `{ type: "string", required: true, trim: true, minLength: 1, maxLength: 64 }` | meaning in 5.1; `resolveRecipient` produces the `fields.to` codes |
| `quote` | `{ type: "string", pattern: /^msg_[A-Za-z0-9_-]{22}$/ }` | existence: same key, same chat, status `sent`, `delivered` or `read` (`fields.quote = not_found`), checked by `validateInput` |
| `media` | only when the module declares `media`: `{ type: "object", shape: { url: { type: "string", required: true, minLength: 1, maxLength: 2048 } } }` | the URL marker; syntax checked by the registry (`new URL`, else `media.url` `invalid_format`); needs the right `media.url` (`rightsFor`) |

`validateInput(format, body, { target, apiKeyId })` converts any `SchemaError` into `MessagingError("validation_failed", { fields })` and runs, in order: unknown `format` (`fields.format = not_allowed`), `check` of `schemaOf` (all faults at once), the registry's common `refine` (`media.url` syntax), the module's `refine` (with `ctx.target`), the `quote` lookup. `normalize` runs last, so `Validated.fields` is already in stored form. Cross-field rules live in `refine` only: `mentions` on a private chat (`mentions` `not_allowed`), distinct button/choice ids (`<path>.id` `duplicate`), distinct phones in a card, composed interactive body over 4096 (`text` `too_long` with `max: 4096`), phone syntax (`<path>` `invalid_format`).

### 3.4 Descriptor: `describe(name)` (served unchanged by API-3)

Exactly the shape of `research/d-panel-ui.md` "Needed from B" and admin-api.md 1.2 `Catalog.formats`:

```js
{ name, right, interactive, order, labelKey, descKey,
  media: null | { sources: ["file","url"], accept: [mime], maxBytes, captionMax: number | null },
  example: {flat sample body},
  fields: [ { name, type, required, labelKey, hintKey?, placeholderKey?, min?, max?, step?, signed?, pattern?, patternHintKey?,
              options?: [{ value, labelKey }], default?, item?: Field, items?: { min, max, fields: [Field] } } ] }
```

`fields` lists `to` (type `recipient`) first, then the module's fields in declaration order, then `quote` (type `text`); `format` and the media pair are not listed. Derivation: string to `text`, `textarea` when `maxLength > 255`, int/number to `number` (`signed` when `min < 0`), boolean to `boolean`, `enum` to `select` (`options`), array of scalars to `list` (`item`), array of `shape` to `list` with `items.fields`; `min`/`max` mean length for strings, value for numbers, row count for lists. `form.hints[field]` may override `type` (`phone`, `url`, `textarea`), `step`, `placeholderKey`, `patternHintKey`, and nothing else. `media.accept` is the union of mimes of the module's `kinds` (10.1), `captionMax` is `fields.caption.maxLength` or null, `maxBytes` is the format cap (the effective cap `min(cap, MAX_UPLOAD)` is applied at request time). Label keys by convention: `api.format.<name>.label` / `.desc`, `api.format.<name>.field.<path>.label` / `.hint` (`<path>` = field names joined by `.`, no indices), common fields `api.format.common.field.to.label` / `.quote.label`; rights `api.right.<id>.label` / `.desc`. `test/messaging-formats.test.js` proves every key exists in both panel catalogs.

### 3.5 What fails at load (`FormatRegistryError` naming the file)

Basename different from `name`; invalid `name`; duplicate `name`; `build` missing or not a function; `fields` not an object of known rule types, or colliding with a common field; `interactive` without `interpretReply`; `media.kinds` outside `sniff.KINDS` or `maxBytes` not a positive integer; `prepare`, `refine`, `normalize`, `size`, `requires` present but not functions; `order` not a number. A bad `doc.examples` is a test failure, not a boot failure. `messaging.start()` and `createApi` both call `load()`; the first failure is the one reported (16.5).

### 3.6 The 13 formats

Caps are `min(cap, MAX_UPLOAD MB)` at call time. `Content` is what `build` returns to Baileys; `{ url: P }` is always the absolute staged path (asserted with `safeFs.assertInside`), never a caller string, never a Buffer of the whole file. Every text-bearing content that can carry a link is sent with `linkPreview: null`.

| Format (order, right) | Own fields | Media (kinds, cap) | Content | `prepare` (before the claim) | Reply capture |
| --------------------- | ---------- | ------------------ | ------- | ---------------------------- | ------------- |
| `text` (10, `messages.send.text`) | `text` 1-4096; `mentions` string[] <= 50 (groups only); `linkPreview` boolean (true needs `media.url`) | none | `{ text, linkPreview: null, mentions? }`; with a preview: `linkPreview: { "matched-text", "canonical-url", title, description? }` | `linkPreview: true`: first `https://` link of the text through `urlFetch.fetchPreview`; failure or no link gives no preview, never a failure | no |
| `image` (20) | `caption` 1-1024 | `image` (JPEG, PNG, WebP), 16 MB | `{ image: { url }, caption?, mimetype }` | none | no |
| `video` (30) | `caption` | `video` (MP4, MOV, 3GP), 16 MB | `{ video: { url }, caption?, mimetype }` | none | no |
| `gif` (40) | `caption` | `animated` + `video`, 16 MB in and out | `{ video: { url: mp4 }, gifPlayback: true, caption?, mimetype: "video/mp4" }` | a GIF input: `ffmpeg -i <source> -movflags +faststart -pix_fmt yuv420p -vf scale=trunc(iw/2)*2:trunc(ih/2)*2 -an -c:v libx264 -preset veryfast -crf 28 prepared.mp4`; MP4/MOV used as is | no |
| `audio` (50) | none | `audio` (MP3, Ogg, M4A, WAV, FLAC, AAC, AMR; not WebM), 16 MB | `{ audio: { url }, mimetype, ptt: false }`; `audio/x-m4a` is sent as `audio/mp4` | none | no |
| `voice` (60) | none | `audio_or_container` (audio kinds + WebM + MP4), 16 MB | `{ audio: { url: ogg }, mimetype: "audio/ogg; codecs=opus", ptt: true }` | `toOpusVoice(await fs.readFile(media))` (`lib/utils/ffmpeg.js:130`), written as `prepared.ogg` | no |
| `document` (70) | `caption` 1-1024; `fileName` 1-255 | `document` (PDF, ZIP, x-cfb, OOXML, OpenDocument, text, CSV: the broadcast whitelist, U6), 100 MB | `{ document: { url }, mimetype, fileName, caption? }`; `fileName` = `broadcaster.sanitizeName(input.fileName \|\| media.name \|\| "file" + ext, mime)` | none | no |
| `sticker` (80) | none | `image`, 10 MB in, <= 900 KiB out | `{ sticker: { url: webp } }` | `stickerMaker.imageToWebp` then `withStickerExif` (pack/author from `STICKER_PACKNAME`/`STICKER_AUTHOR`); `null` (no quality fits) or a sharp error throws | no |
| `location` (90) | `latitude` -90..90, `longitude` -180..180, `name?`, `address?` <= 256 | none | `{ location: { degreesLatitude, degreesLongitude, name?, address? } }` | none | no |
| `contact` (100) | `contacts` 1-10 of shape `{ name 1-128, phones string[] 1-5 (unique), organization? <= 128, email? <= 254 }` | none | `{ contacts: { displayName, contacts: [{ displayName, vcard }] } }` (one card: `contactMessage`, several: `contactsArrayMessage`, chosen by Baileys) | none | no |
| `poll` (110) | `question` 1-255; `options` string[] 2-12 unique (<= 100); `multiple` boolean | none | `{ poll: { name, values, selectableCount, messageSecret } }`; single: `selectableCount: 1` (V3), multiple: `selectableCount: values.length`; `toAnnouncementGroup` never set | none | yes: votes |
| `buttons` (120) | `text` 1-1024; `buttons` 1-3 of `{ id (ID_PATTERN, unique), label 1-20 }` | none | `transport: "interactive"`, content = `buildQuickReplies(...)` result, `quick_reply` native buttons `{ display_text, id: "api:reply:<waId>:<id>" }` | none | yes: taps, numbers |
| `list` (130) | `text` 1-1024; `buttonLabel` 1-20; `choices` 1-10 of `{ id, title 1-24, description? <= 72 }` | none | `transport: "interactive"`, `buildList(...)`: one section, `single_select`, row `id` = `api:reply:<waId>:<id>` | none | yes: taps, numbers |

Sizes (`size(input, media)`): media formats the staged file size; `text`, `buttons`, `list` the UTF-8 byte length of `text`; `poll` of `question`; `location`, `contact` null.

### 3.7 Interactive messages (FR-057)

- Wire ids are `api:reply:<waId>:<callerId>` (<= 97 characters; `callerId` matches `ID_PATTERN`, no colon). `waId` is known at build time because the engine pre-generates it (4.4).
- The body always carries the numbered text version: `text`, a blank line, `  1. <label>` lines (list rows flattened in order, `title` only), a blank line and `_<hint>_` where the hint is `getLang("plugins.buttons.reply_number")` (buttons) or `getLang("plugins.buttons.pick_list")` (list). The existing plugin adds this only in its failure fallback; the API always adds it (builders' `numbered: true`, 14.5). Phones that render native buttons therefore also show the numbers (U14). The composed body must fit `BODY_COMPOSED`.
- API messages carry no footer and no header, and are never recorded in `buttonRegistry` (TTL 1 h, 500 entries): the mapping lives in `ApiMessage.choices`, so a numbered answer works for 7 days.
- `choices` for buttons: `{ id, label }`; list: `{ id, label: title }` (description not kept); poll: `{ id: "<index>", label: option }`.

### 3.8 `lib/messaging/vcard.js`

`buildVCard({ name, organization, email, phones }) -> string`: `BEGIN:VCARD`, `VERSION:3.0`, `FN`, `ORG` (if any), `EMAIL;type=INTERNET` (if any), one `TEL;type=CELL;waid=<digits>:+<digits>` per phone (digits from `parsePhoneNumber`), `END:VCARD`, CRLF line ends. Text values escape `\`, `;`, `,`; CR/LF become `\n`; other control characters are dropped, so a value cannot add a property (a name holding `\r\nTEL:` yields exactly one `TEL` line per declared phone). The caller never supplies card text (FR-055).

### 3.9 Mentions

`text.mentions` numbers (rules of `to`, 5.1) are accepted for groups only. At the pick step the engine reads `groupMetadata` (already fetched for the posting check, 5.4) and passes `ctx.mentions = recipients.mentionJids(metadata, numbers)`: a participant matches when `normalizeJid(p.phoneNumber) === pn` or `normalizeJid(p.id) === pn`; the mention JID is `p.id` (the group's own addressing form); when it is a LID the `@<number>` tokens of that person in the text are rewritten to `@<lid user part>`. A number that is not a member is ignored and the text is left untouched (the message still goes). Baileys writes `contextInfo.mentionedJid`. LID-group rendering is a phone check (research.md section 3).

---

## 4. `outbox.js`

`createOutbox(options)` (options of the facade plus `client`) holds the queue loop; the facade delegates to it. A row of `api_messages` is the queue (data-model.md 2); the transitions are T1-T11 of data-model.md 2.5, each one conditional UPDATE whose "erased in the same UPDATE" columns are part of the contract.

### 4.1 Internal API (used by the facade; tests may drive it directly)

```js
start(client) / stop() / isRunning() / enable() / disable({ reason })
tick(now?)                       -> Promise<void>      // one pass; never rejects; test hook
kick()                           -> void               // run a tick at once when idle (after an accept)
accept(request)                  -> Promise<...>       // = facade submit
cancelByKey(apiKeyId, reason) / cancelAll(reason)
recover({ now })                 -> Promise<{ unknown, cancelled }>
waitFor(publicId, ms)
onMessagesUpdate(updates)        // the receipts handler (8), bound to client.on("messages.update")
```

State kept in memory (all rebuilt from the table at `start()`): `pendingHint` (integer, seeded by `COUNT(status = 'queued')`, kept by accept/settle/cancel/expiry; it only decides whether the tick has work), `pausedUntil`, `busy`, `waiters`, `deferred` (`Map<id, untilMs>`), the `onWhatsApp` cache.

### 4.2 Accept: `submit(request)`

In order; the first failure answers and nothing is written:

1. switch off: `api_disabled` (RT-13). 2. `format = formats.get(request.format)` else `validation_failed` `fields.format` `not_allowed`. 3. `validateInput` on `{ ...fields, format, to, quote }` (the schema re-run). 4. `resolveRecipient(to, { policy })` (5.2). 5. media: a format with `media.required` and no `media` gives `fields.media = required`; a format without `media` and a file gives `fields.file = not_allowed`; `inspectMedia` re-detects the type from the bytes and applies the cap (`media_type_mismatch`, `media_too_large`). 6. quote: `fields.quote` `not_found` unless a row exists with the same `apiKeyId` (NULL for the panel), the same `recipient` and `status IN (sent, delivered, read)`; the resolved `{ publicId, waId, format }` goes into the payload (data-model.md 2.6). 7. `withLock("api-outbox")`: admission (4.5), lazy idempotency release (`idempotencyKey` of an older-than-24 h row set to NULL together with `requestHash`), stage adoption (`stage.adopt`, move or copy into `data/api-media/<publicId>/source`), then the INSERT of T1 (`expiresAt = now + API_QUEUE_EXPIRY_MIN`, `payload`, `mediaPath`, `size`). 8. a unique violation on `(apiKeyId, idempotencyKey)` removes the stage, re-reads the stored row and returns `{ message, replayed: true, requestHash }` (the caller compares the hashes); a `publicId` collision retries once. 9. `pendingHint += 1`, `kick()`.

| # | Invariant |
| - | --------- |
| RT-40 | The INSERT is the only moment the clear text reaches the database, in `payload` and the staged file; both are erased by the UPDATE of T3-T8 (FR-073). Nothing else (log, audit, error, alert) ever receives it |
| RT-41 | Content goes to `payload` after `normalize`; `payload.input` excludes `to`, `quote`, `fileName` and the `media.url` marker; a URL is never stored (data-model.md 2.6) |
| RT-42 | A refusal after `stage.adopt` removes the stage directory; a failure before it leaves the caller's temp file where it was (the pipeline's `finally` removes it) |
| RT-43 | `size` is `format.size(input, media)`; `expiresAt` is the snapshot taken here |

### 4.3 The tick

`TICK_INTERVAL_MS` (1000 ms) `setInterval`, unref'd, created by `enable()`/`start()` only when the switch is on; `busy` prevents overlap; `kick()` runs a tick at once when idle. A tick does at most one send. Steps, in order:

1. `pendingHint === 0`: return (an idle API costs one empty callback per second and no query). 2. **Expire**: `UPDATE ... SET status='expired', endedAt=:now, payload=NULL WHERE status='queued' AND expiresAt <= :now`; `pendingHint` drops by the rows changed; remove their stages; settle waiters. 3. **Gates**: `client.ready()` and a socket; not `maintenanceMode.isActive()`; `now >= pausedUntil`; `gate.ready(now)`; the switch still on. Otherwise return (queued rows wait and expire at 10 minutes, FR-037).
4. **Pick**: the oldest 20 `queued` rows (`acceptedAt`, `id`, `expiresAt > now`), the first not in `deferred`. **Key guard** (source `api`): read the `ApiKey` row by primary key, uncached (one query per send); revoked gives T5 `cancelled / key_revoked`, expired by date `cancelled / key_expired`, a missing row `key_revoked`. Chat disabled again (`recipients.isChatDisabled`): T6 `failed / chat_disabled`. Recipient equal to the bot's own number: T6 `failed / send_failed`. Payload unreadable or stage missing: T6 `failed / payload_unavailable` (never a text-only send).
5. **Verify** (nothing has been sent yet): 5.3 and 5.4. A definitive refusal is T6; a transient error (timeout, connection) leaves the row `queued`, adds it to `deferred` for `VERIFY_DEFER_MS` and ends the tick, so one stuck row does not block the queue behind it.
6. **Prepare**: `format.prepare` while the row is still `queued` (a crash here loses nothing); a throw is T6 `failed / media_conversion_failed` (ENOENT of ffmpeg included, with one warn log).
7. **Build**: `waId = newMessageId(sock.user.id)`; `sentIds.remember(waId)`; `format.build(...)`. A throw is T6 `failed / send_failed`.
8. **Claim** (T2, the point of no return): `UPDATE ... SET status='sending', sendingAt=:now, waId=:waId [, choices, replyData, pollSecret] WHERE id=:id AND status='queued' AND expiresAt > :now`; 0 rows (a concurrent cancel or expiry) drops the message. Then `gate.reserve(now)` and `const done = maintenanceMode.begin()`.
9. **Send** under `withTimeout(..., SEND_TIMEOUT_MS)` (`SEND_TIMEOUT_MEDIA_MS` when the row has media): `transport "message"`: `sock.sendMessage(jid, content, { messageId: waId, quoted? })`; `transport "interactive"`: `buttons.sendPrepared(sock, jid, content, { messageId: waId, quoted? })`. `quoted` = `{ key: { remoteJid, fromMe: true, id: payload.quote.waId }, message: shellFor(payload.quote.format) }`, the typed empty shell of U13 (`{ conversation: "" }` for text, location, contact, poll, buttons, list; `{ imageMessage: {} }` for image, sticker; `{ videoMessage: {} }` for video, gif; `{ audioMessage: {} }` for audio, voice; `{ documentMessage: {} }` for document).
10. **Settle**: success is T3 (`sentAt`, `repliesUntil = sentAt + API_REPLY_WINDOW_DAYS` for an interactive format, `payload = NULL`); `classify(err)` of `lib/utils/broadcaster.js:205` giving `timeout` or `connection_closed` is T8 `unknown` (the message may have left; `endedAt` set, and `repliesUntil = endedAt + API_REPLY_WINDOW_DAYS` for an interactive format, since a reply may still come); any other error is T7 `failed / send_failed`. The UPDATE is retried once; if it still fails the row stays `sending`, the next boot reports `unknown / interrupted` and the housekeeping net (data-model.md 5) does the same after 15 minutes. After the commit: `stage.remove(publicId)`, then `mediaPath = NULL`; `done()`; settle waiters.

### 4.4 At-most-once

| # | Invariant |
| - | --------- |
| RT-50 | `status = 'sending'` with the pre-generated `waId` is written before `sendMessage` and is never undone: nothing moves a row from `sending`, `sent` or `unknown` toward a resend; `recover()` and the settle path only move it forward (data-model.md 2.5) |
| RT-51 | `waId` is generated by the engine (`generateMessageIDV2`), passed as `options.messageId` (Baileys spreads `...options` after its own id, `Socket/messages-send.js:1086`; the button helper does the same, `button-helper/helpers/buttons.js:863-868`), remembered in `sentIds` before the call, and written at the claim |
| RT-52 | The engine never calls `sendQuickReplies`, `sendList` or any helper with a text fallback: their `catch` sends a second plain message (`plugins/buttons.js:141-154,204-219`), which would duplicate a message whose first attempt left (X13) |
| RT-53 | Exactly one `sock.sendMessage` / `sendPrepared` call per claimed row, ever; no retry of `unknown`, `failed` or a timeout |
| RT-54 | Boot `recover()`: every `sending` row becomes `unknown / interrupted` (T8) and its stage is removed; a `queued` row resumes unless expired (the first tick expires it). With the switch off, `recover()` also moves every `queued` row to `cancelled / api_disabled`, so `ADMIN_PANEL=false` after a crash leaves nothing queued |

### 4.5 Admission (U4, X14)

`checkAdmission({ apiKeyId, maxPending })` is the check-only twin of the admission inside `submit`; both read the database (indexed counts, data-model.md 2.2) and `submit` additionally holds `withLock("api-outbox")` so count-then-insert is atomic. Pending means `status IN ('queued','sending')`. In order:

| Check | Refusal | `retryAfterMs` |
| ----- | ------- | -------------- |
| global pending >= `API_QUEUE_MAX` | `queue_full { scope: "global" }` | `clamp(spacing * (size - cap + 1), 1000, 300000)` |
| `(globalPending + 1) * spacing * 1.1 > API_QUEUE_EXPIRY_MIN * 60000` | `queue_full { scope: "wait" }` | `clamp(estimate - expiry, 1000, 300000)` |
| key pending >= `maxPending` (keyed submissions only) | `pending_limit_reached { limit }` | `clamp(spacing * (pending - max + 1), 1000, 300000)` |
| `pendingMediaBytes() + media.size > 2 * MAX_UPLOAD MB` (media only) | `queue_full { scope: "disk" }` | 5000 |

`spacing = spacingMs()`. The per-minute and per-day quotas are not the engine's: they live in `lib/api/limits.js` (15.8).

### 4.6 Pause on a WhatsApp restriction (U5, FR-045)

The receipts handler (8) calls `outbox.onRestricted(code)` when a negative ack carries a code in `RESTRICTION_CODES`: `pausedUntil = now + PAUSE_MS`; the tick keeps expiring rows but claims nothing until then; expiries are not extended. The first opening raises `alerts.raise("api_paused", { code, resumesAt, at })` (17.2; the 15-minute slot suppresses repeats). The pause is in memory: a restart clears it (documented). Baileys marks `463` "account restricted or missing tctoken" and itself never retries (`Socket/messages-recv.js:1511-1520`); the real-phone behaviour is in the quickstart checklist.

### 4.7 Waiters

`waitFor(publicId, ms)` (`ms` <= `WAIT_MAX_MS`) returns `{ promise, cancel }`. If the row is already in `sent`, `delivered`, `read`, `failed`, `expired`, `cancelled` or `unknown` it resolves at once. Otherwise a `Map<publicId, Set<resolve>>` entry is resolved by the settle paths on `sent`, `failed`, `expired`, `cancelled` and `unknown` (not by `delivered` or `read`, which would hold the request), with a fresh `MessageView`; an unref'd per-waiter timer resolves at the deadline with the current row; `cancel()` (called on `req.close`) drops the waiter. More than `WAITERS_MAX` (200) waiters: the call resolves at once with the current row (not an error). `disable()` and `stop()` resolve every waiter.

### 4.8 Cancellation

`cancelForKey(apiKeyId, reason)` and `cancelAll(reason)` run under `withLock("api-outbox")`: select the `queued` ids, `UPDATE ... SET status='cancelled', errorCode=:reason, endedAt=:now, payload=NULL WHERE id IN (...) AND status='queued'`, remove their stages, settle waiters, return the count. A `sending` row is never cancelled (it is past the claim); the claim CAS makes a race with a concurrent cancel safe. `reason` is a `CANCEL_REASONS` key.

### 4.9 Expiry, disconnection, maintenance, restore

- A message not sent `API_QUEUE_EXPIRY_MIN` after acceptance is `expired` and never sent later, connected or not (FR-037).
- A disconnected client (`client.ready()` false, `lib/baileys/client.js:638`) makes the tick return after the expiry sweep; the socket is read with `client.getSocket()` at send time, never cached, so an in-process restart (`botRuntime.js:196-231`) needs nothing.
- `maintenanceMode.isActive()` makes the tick return; `maintenanceMode.begin()` brackets claim-to-settle so a restore waits for the send in flight (`lib/utils/maintenanceMode.js`). The four `Api*` tables are excluded from backups, so a restore changes neither the queue nor the keys nor the switch and the engine resumes by itself.

---

## 5. `recipients.js`

### 5.1 Parsing

`parseRecipient(input) -> { kind: "private", jid, number } | { kind: "group", jid, number: null } | { error: "invalid_format" }`. A string containing `@g.us` is a group id and must match `^\d{5,25}(-\d+)?@g\.us$`; anything else containing `@` (a LID, `@s.whatsapp.net`) is refused; a string without `@` is a number parsed by `parsePhoneNumber` (14.1: strip spaces, `+`, `-`, `.`, `(`, `)`, drop a leading `00`, 8-15 digits, not starting with `0`) giving `<digits>@s.whatsapp.net`. `mask(jid)`: a private JID keeps the first 3 and last 2 digits (`237...00`), a group id keeps `group:` and its last 4 characters, anything else `?`.

### 5.2 `resolveRecipient(to, { policy })` (public-api.md step 13 and 14)

In order, the first failure answers: (a) parse: `validation_failed` `fields.to` `invalid_format` (`required`/`invalid_type` come from the schema); (b) policy: `recipient_not_allowed`; (c) the bot's own number (`getBotJids(sock)` PN or LID, `sock` being `client.getSocket()` of the client given to `start`, null before it; the last identity seen in this process being kept in memory; skipped, not failed, when none has ever been seen; rechecked at the pick step): `validation_failed` `fields.to = { code: "not_allowed" }` (U7), after the policy so a restricted key learns nothing; (d) chat disabled: `chat_disabled`. `policy` null means no policy.

`evaluatePolicy(policy, target) -> { ok } | { ok: false }` with `{ mode: "list" | "known" | "any", entries }`: `any` always ok; `list`: `target.jid` equals an entry (stored entries are PN or group JIDs only, data-model.md 1.1); `known`: private: `knownChats.isKnown(jid)` (a `KnownChat` row with `jid` or `pnJid` equal to the PN), group: a `KnownChat` row of kind `group` with `leftAt IS NULL`.

`isChatDisabled(target)`: the pipeline's cached set (`require("../core/pipeline").getBannedChats()`, required lazily; injectable as `options.bannedChats`), tested for the PN **and** for the `jid` of any `KnownChat` row whose `pnJid` is that PN (the `ban` command stores `message.jid`, which is a LID in LID-addressed chats; `knownChats.isSelectable` does the same double test, `lib/utils/knownChats.js:294`). Checked at accept and again at the pick step (a ban after acceptance gives `failed / chat_disabled`).

### 5.3 Reachability (FR-040), pick step

Skipped for groups and for any target `isKnown`. Otherwise `sock.onWhatsApp(pn)` (`Socket/socket.js:222`) under `VERIFY_TIMEOUT_MS`: an empty answer or `exists !== true` gives T6 `failed / not_on_whatsapp` and **no gate reservation**; an `@s.whatsapp.net` JID in the answer is the destination (WhatsApp normalises some national formats; the row keeps the requested form). A thrown error is transient (4.3 step 5). At most one lookup per tick; results cached in memory (positive 24 h, negative 10 min, 1000 entries): bulk probing of numbers is itself a ban signal.

### 5.4 Group posting, pick step

`sock.groupMetadata(jid)` under `VERIFY_TIMEOUT_MS`. A definitive Boom 403/404 gives T6 `failed / not_in_group`; `metadata.announce === true` and the bot not an admin gives `failed / group_announce_only` (admin test: `findParticipant` and `isAdminParticipant` exported by `lib/classes/Message.js`, 14.3, with `getBotJids`); a timeout or connection error is transient. The same metadata feeds the mention resolution (3.9).

| # | Invariant |
| - | --------- |
| RT-60 | The API addresses numbers and groups only: a LID is never accepted, stored or compared |
| RT-61 | The order parse, policy, self number, chat disabled is fixed (FR-032); a refusal never echoes the number |
| RT-62 | Checks that need a live socket (reachability, group posting, mentions) happen at send time; a disconnected bot still accepts (edge case "bot déconnecté") |

---

## 6. Never a command

`lib/messaging/sentIds.js`: `remember(id)`, `has(id)`, `size()`, `_reset()`; a `Map<id, expiresAt>` with `SENT_IDS_TTL_MS` (15 min) and `SENT_IDS_MAX` (2000) entries, pruned lazily on `remember`, no timer, no import beyond Node. The engine calls `remember(waId)` before `sendMessage`, so even an echo arriving before the call resolves is known.

`lib/core/pipeline.js#handleMessage`, right after the maintenance check (`:106`): `if (msg.key.fromMe && sentIds.has(msg.key.id)) { logger.debug("own API message echo ignored"); return; }`. This keeps API content out of the anti-delete cache, the stats, every hook and the registry. It is the only pipeline change (G3).

Defence in depth, already true in the code: everything the socket sends is upserted as `append` (`Socket/messages-send.js:1135-1139`; the button helper does the same for private chats only, `button-helper/helpers/buttons.js:900-909`), `lib/baileys/client.js:366` re-emits only `notify` and `lib/core/pipeline.js` (`attachHandlers`) re-checks it. Recipient equal to the bot's own number is refused (5.2), the one same-account chat where this device's `fromMe` traffic could come back. Residual risk, documented and not coded: two bot processes linked to the same WhatsApp number receive each other's `fromMe` messages as `notify`. The text is never altered (no zero-width prefix): a caller may legitimately send `!cmd` to another bot in a group.

| # | Invariant |
| - | --------- |
| RT-70 | An API text is sent verbatim; the bot never executes it, whatever its first characters, including `config.PREFIX` followed by an owner command (FR-039, SC-008). `lib/messaging/**` never reads `config.PREFIX` |
| RT-71 | `pipeline.js` requires `lib/messaging/sentIds.js` only (a leaf), never `lib/messaging/index.js` |

---

## 7. Reply capture

### 7.1 `plugins/apireplies.js` (hook-only, like `groupguard.js` and `trackmessages.js`: no `command`)

```js
module.exports = {
  hookPriority: { handleButtonReply: 5, onMessage: 6 },
  async handleButtonReply(message) {},   // taps and quoted numbers -> true when the message is an API reply
  async onMessage(message) {},           // pollUpdateMessage votes -> true when the poll is an API poll
};
```
Thin: both call `lib/messaging/replies.js`. `test/hooks.test.js` gains rows for `apireplies.js` in the `onMessage` order (`knownchats` 5, `apireplies` 6, `role` 10, ...) and in the `handleButtonReply` list (it runs before every game's hook, which only claim their own messages).

### 7.2 `lib/messaging/replies.js`

```js
WIRE_PREFIX = "api:reply:"
wireId(waId, callerId) -> string;  parseWireId(text) -> { waId, id } | null     // ^api:reply:([A-Za-z0-9]{10,40}):([A-Za-z0-9_.-]{1,64})$
handleButtonReply(message) -> Promise<boolean>
handlePollVote(message)    -> Promise<boolean>
record({ row, kind, author, choiceIds, via, sourceId, at }) -> Promise<boolean>
describeResponses(row, responses) -> object
authorLabel(jid) -> string          // PN: digits; LID: "<digits>@lid"
decodeVote(message, row) -> { digests: string[] } | null
```

`handleButtonReply` (pipeline step 5, which only runs for a quoted message or an interactive reply):
- (a) a wire id: `message.isInteractiveReply` and `parseWireId(message.body)`. **Always returns true** (consumed even when the switch is off, the message unknown or older than the window: US6.4-5, nothing else may react). It records only when the switch is on, the row exists (lookup by the unique `waId`), `repliesUntil` is set and in the future, and, for a group row, `message.jid` equals `row.recipient`. A plain text that merely looks like a wire id is not an interactive reply and is ignored.
- (b) a bare number `^\d{1,3}$` with `message.quoted?.key?.fromMe` and `message.quoted.id`: `ApiMessage` lookup by `waId` (only for replies to the bot's own messages, so the lookup is rare); not an API row gives `false` (the games' hooks proceed); an API row consumes (true) and records `interpretReply({ row, event: { type: "number", number } })`.

`handlePollVote` (`onMessage`, `message.type === "pollUpdateMessage"`): look up `content.pollUpdateMessage.pollCreationMessageKey.id` as `waId`; not ours gives false; ours decodes and records, and returns true either way (a vote has no body; consuming it keeps it out of `trackmessages`).

`record`: ignored unless the row exists, `now <= repliesUntil` and the message has fewer than `RESPONSES_MAX` response rows. `kind: "choice"`: insert (append-only, one row per tap or numbered answer). `kind: "vote"`: `voterKey = author`; `UPDATE ... SET choiceIds, sourceId, respondedAt WHERE messageId AND voterKey AND respondedAt <= :t`, 0 rows then INSERT, a unique violation means a newer vote exists (stop); no lock (data-model.md 3.2). The unique `(messageId, sourceId)` makes a redelivery a no-op. `choiceIds` are filtered to ids present in `row.choices`. `author`: in a private chat the row's own `recipient`; in a group the participant (`message.sender`, PN when Baileys gives one, else `senderLid`).

### 7.3 Poll votes (X19)

Baileys rc14 has vote decryption commented out (`Utils/process-message.js:576-625`): a vote arrives as an ordinary `pollUpdateMessage` upsert (type `notify`) whose `vote` is `{ encPayload, encIv }`. `decodeVote` decrypts with the exported `decryptPollVote` of `baileys` (`Utils/process-message.js:146`): `pollEncKey` = `Buffer.from(secretBox.decrypt(row.pollSecret, "api-poll:" + row.publicId).value, "hex")` (32 bytes), `pollMsgId` = `waId`. The JID forms WhatsApp used cannot be known offline, so it tries candidates, first success wins, at most 8 attempts: creator in `{ normalized me.id, normalized me.lid }` (LID first for a LID-addressed chat), voter in `{ key.participant, key.participantAlt, key.remoteJid, key.remoteJidAlt }` normalised and de-duplicated. Each `selectedOptions` digest (lowercase hex of the 32-byte SHA-256 of the UTF-8 option name) is mapped to an option index through `row.replyData.hashes`; the selection is the full current vote, empty when cleared. No candidate working, a decrypt failure, an unreadable `pollSecret` (lost `panel.key`) or an expired `replyData` give a debug log and a counter, never an error and never a record. Which pair works is a phone check.

### 7.4 What is never stored

Labels are the only text kept (<= 100 characters, `choices`); digests are kept in `replyData` until `repliesUntil`; the question, body, caption, descriptions and media never. Nothing here reaches a log: `author` and `waId` are masked or omitted (RT-05).

### 7.5 `describeResponses(row, responses)`

Returns the object of public-api.md 4.4 and admin-api.md `MessageDetail.responses`: `{ until, total, items, totals }`, `until` = `row.repliesUntil` as ISO, null while it is unset (it is written at T3 and T8, so null until the message left); `items` oldest first `{ at, author: authorLabel(author), kind, via, choices: [{ id, label }] }` with `label` from `row.choices` (null when absent); `totals` for a poll only, one `{ id, label, count }` per option in order, zero counts included, computed from the current `choiceIds` of the vote rows (null for buttons and list); `total` = `items.length`. Returns null for a non-interactive format.

| # | Invariant |
| - | --------- |
| RT-80 | A wire id (`api:reply:`) is consumed by `apireplies` first and by nothing else, whatever the switch; no other plugin tests that prefix |
| RT-81 | A reply after `repliesUntil`, for an unknown row, with the switch off, or past `RESPONSES_MAX` is consumed and not recorded |
| RT-82 | The hooks never throw (each is already isolated by `pipeline.runHooks`) and stay cheap: one indexed lookup per candidate message |

---

## 8. Receipts

`lib/messaging/receipts.js`: `createReceiptHandler({ models, clock, onRestricted }) -> { handle(updates) }`, bound by the outbox with `client.on("messages.update", handler)` in `enable()` and `client.off(...)` in `disable()`/`stop()` (the EventEmitter outlives reconnections; `lib/baileys/client.js:464-467` already re-emits every `messages.update`, so the client needs no change). Private chats only: `Socket/messages-recv.js` emits `messages.update` with `{ key, update: { status, messageTimestamp } }` for them (statuses from `Utils/generics.js`: none = `DELIVERY_ACK` 3, `read` = 4, `played` = 5) and only `message-receipt.update` per participant for groups, which is not consumed (groups stop at `sent`).

For each `{ key, update }` with `key.fromMe`, a numeric `update.status` and a non-group `remoteJid`, one conditional UPDATE by the unique `waId` (no SELECT, no lock; the id is the only key used because `remoteJid` may be a LID):

| `status` | Statement (T9-T11 of data-model.md) |
| -------- | ----------------------------------- |
| 3 | `status='delivered', deliveredAt=:t WHERE waId=:id AND status IN ('sent','unknown')`; from `unknown`: `endedAt=NULL, errorCode=NULL` |
| 4, 5 | `status='read', readAt=:t, deliveredAt=COALESCE(deliveredAt,:t) WHERE waId=:id AND status IN ('sent','delivered','unknown')`; from `unknown` as above |
| 0 | `status='failed', errorCode='whatsapp_rejected', endedAt=:t, choices/replyData/pollSecret/repliesUntil=NULL WHERE waId=:id AND status IN ('sent','unknown')`; if `update.messageStubParameters[0]` is in `RESTRICTION_CODES` call `onRestricted(code)` (4.6) |
| 1, 2 | ignored |

`:t` = `update.messageTimestamp * 1000` when present, else `now`. A statement that changes 0 rows is a non-API id (the bot's own replies also get receipts): one indexed lookup, nothing else. Status moves forward only, so a late `delivered` after `read` is ignored. An `unknown` row upgraded by a receipt proves the send; it is never a resend, and a group `unknown` stays `unknown`.

| # | Invariant |
| - | --------- |
| RT-90 | The handler exists only while the switch is on; it never throws; it never reads the message content; it logs nothing per event above `debug` |

---

## 9. `urlFetch.js` and link preview

`lib/messaging/urlFetch.js` (research A7, X17). Required lazily (RT-04).

```js
createUrlFetcher({ resolve, request, now, maxBytes, deadlineMs = 30000, tmpDir }) -> {
  fetchMedia(urlString, { maxBytes, signal })   -> Promise<{ path, size, contentType, sha256 }>      // streamed to tmpDir/<random>.part (0600, flags "wx")
  fetchPreview(urlString, { signal })           -> Promise<{ "matched-text", "canonical-url", title, description? } | null>
}
validateUrl(text) -> URL           // throws MessagingError("url_forbidden", { params: { reason } })
isPublicAddress(ip) -> boolean
PUBLIC_RANGES                      // frozen data: the IPv4 and IPv6 blocklists of A7
fetchMedia, fetchPreview           // default instance: resolve = dns.promises.lookup(host, { all: true, verbatim: true }), request = https.request, tmpDir = data/tmp/api
```

At most 4 hops (the request plus 3 redirects); per hop: (1) `validateUrl`: `new URL` is the only parser; protocol exactly `https:`; empty username and password; port empty or `443`; hostname (one trailing dot stripped) not an IP literal at all, not `localhost`/`*.localhost`/`*.local`/`*.internal`/`*.localdomain`, with at least one dot, <= 253 characters; violations are `url_forbidden` with `reason` `scheme`, `credentials`, `port`, `host`. (2) resolve once, inside the global deadline; **every** address must pass `isPublicAddress` or the name is refused whole (`reason: "host"`; `ENOTFOUND`/`EAI_AGAIN` are also `url_forbidden` `host`, not `url_unreachable`: no oracle on internal names). (3) connect to the validated IP itself: `https.request({ host: <ip>, servername: <hostname>, headers: { Host }, agent: false, maxHeaderSize: 16 KiB, rejectUnauthorized: true })` (no second resolution, no environment proxy; `agent: false` is pinned by a test). (4) `GET`, headers `Host`, `User-Agent: OpenWhatsappBot`, `Accept`, `Accept-Encoding: identity`; no `Cookie`, no `Authorization`, nothing from the caller; `Set-Cookie` ignored; `200` only; `301/302/303/307/308` with `Location` go back through (1) (a fourth redirect is `url_forbidden` `reason: "redirects"`); another status or a `Content-Encoding` other than identity is `url_unreachable`. (5) the body is counted while it streams, whatever `Content-Length` says (a declared length over the cap only short-circuits), cap `min(MAX_UPLOAD MB, format cap)` giving `media_too_large`; the first 4100 bytes go through `sniff.classifyHead` and a mismatch aborts the download (`media_type_mismatch`). One `AbortSignal.timeout(30000)` covers DNS, all hops and the body; timeouts, resets and TLS errors are `url_unreachable`. (6) the temp file is deleted on every error path.

`isPublicAddress` uses `net.BlockList` (as `trustProxy.js:107`) with IPv4 `0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4` and IPv6 `::/128, ::1/128, ::/96, 64:ff9b::/96, 64:ff9b:1::/48, 100::/64, 2001::/32, 2001:db8::/32, 2002::/16, fc00::/7, fe80::/10, fec0::/10, ff00::/8`. `::ffff:0:0/96` is deliberately **not** listed (`BlockList.check` already tests a mapped address against the IPv4 rules; listing the prefix blocks every IPv4 address): mapped addresses are unmapped first.

**Link preview (X16).** `fetchPreview` runs the same checks with `Accept: text/html`, a 256 KiB cap, reads `<title>`, `og:title` and `og:description` with two regexes decoded by `html-entities`, and returns the `WAUrlInfo` fields; no thumbnail in v1. It is called by `text.prepare` at send time (RT-04: lazy), under a 5 s budget; failure returns null. Every text content has `linkPreview: null` otherwise (Baileys calls `getUrlInfo` for any `https://` link when it is `undefined`, `Utils/messages.js:278-281`; `link-preview-js` is absent today, and installing it would turn every API text into an unguarded server-side fetch). `link-preview-js` is never added.

| # | Invariant |
| - | --------- |
| RT-95 | A refused target never produces a connection: with a spy `request`, `callCount === 0` for every non-public target (SC-007); the spy is called with the validated IP, never the hostname |
| RT-96 | The URL, the redirect targets and the response headers are never logged or stored; a failure carries only a `reason` |

---

## 10. Media inspection and staging

### 10.1 `lib/messaging/sniff.js`

```js
KINDS = { image, animated, video, audio, audio_or_container, document }     // kind -> Set of mimes
classifyHead(buffer) -> Promise<{ mime, ext } | null>   // first 4100 bytes (early abort of an upload or download)
classify(file, { name }) -> Promise<{ mime, ext } | null>   // whole file: file-type `fileTypeFromFile`; text/CSV by content for `document`
accepts(kinds, detected) -> boolean
check(kinds, detected) -> void                           // throws MessagingError("media_type_mismatch", { params: { expected: kinds } })
effectiveMax(format) -> number                           // min(format.media.maxBytes, MAX_UPLOAD MB), call time
```
Kinds: `image` JPEG, PNG, WebP; `animated` GIF; `video` MP4, QuickTime, 3GPP; `audio` MP3, Ogg (Opus included), M4A, WAV, FLAC, AAC, AMR (WebM refused); `audio_or_container` the audio list plus WebM and MP4 (ffmpeg extracts the track); `document` the broadcast whitelist (`broadcaster.js:96-106`: PDF, ZIP, x-cfb, OOXML, OpenDocument) plus plain text and CSV by content (`broadcaster.defaultSniff` rule, `:167`); an executable or script is never accepted. The detected type, never the declared one, decides the `mimetype` sent (RT-100).

### 10.2 `inspectMedia(format, file, { name })`

Detects, checks the kinds and the size cap, and returns `MediaInfo`; a mismatch deletes nothing itself (the caller's temp file is removed by the pipeline's `finally`) and carries no detected type. The cap is applied while receiving by the callers (`multipart`/`upload`, `urlFetch`): `inspectMedia` is the final check, repeated by `submit`.

### 10.3 `lib/messaging/stage.js`

```js
rootDir() -> data/api-media                                  // call time
dirOf(publicId)  -> abs path  (validates ^msg_[A-Za-z0-9_-]{22}$ BEFORE any path is built, then safeFs.assertInside)
adopt(publicId, tempPath, { mode }) -> Promise<{ mediaPath }>    // mkdir 0700, move (rename; copy+unlink on EXDEV) or copy to <dir>/source (0600)
remove(publicId) -> Promise<void>                            // fs.rm recursive, force; idempotent
list() -> Promise<{ name, mtimeMs, bytes }[]>
```
The staged file has a fixed name `source`, with `prepared.<ext>` beside it (data-model.md 7); no caller-controlled name reaches the disk (the document name is `payload` data). `mediaPath` (repo-relative, forward slashes) is `data/api-media/<publicId>/source`. Deletion: the terminal UPDATE commits first, then `remove`, then `mediaPath = NULL`; a crash between leaves an orphan, never a lost state.

### 10.4 `sweepMedia({ now })` (daily, from housekeeping; once at `start()`)

Removes each `data/api-media/<name>/` older than `STAGE_GRACE_MS` whose `<name>` is not the `publicId` of a `queued` or `sending` row, and every `data/tmp/api/*.part` older than the same grace; returns `{ removed, freedBytes }`. It takes no engine lock. A `queued` row whose directory vanished fails as `payload_unavailable` at its next pick.

| # | Invariant |
| - | --------- |
| RT-100 | The type sent is the type detected from the bytes; `mimetype`, extension and file name of the caller are ignored (FR-052) |
| RT-101 | The staged path handed to Baileys is always inside `data/api-media/<publicId>/` (`safeFs.assertInside`); a Baileys `{ url }` is never an `http(s)` string (Baileys would download it itself, `Utils/messages-media.js:261`) |

---

## 11. `lib/utils/sendGate.js` and the broadcaster change

```js
createSendGate({ clock = Date.now, random = Math.random, config }) -> {
  ready(at, extraMs = 0)    -> boolean   // at - last >= max(minSpacing(), extraMs) * (1 + jitter); true when nothing was ever reserved
  waitMs(at, extraMs = 0)   -> number    // remaining ms, >= 0
  reserve(at)               -> void      // last = at; jitter = random() * 0.2, drawn once per reserve for the NEXT gap
  seed(ms)                  -> void      // last = max(last, ms); a non-finite ms is ignored
  lastSendAt()              -> number | null
}
module.exports.shared        // the process-wide instance
```
`minSpacing()` = `max(2000, Number(config.SEND_MIN_SPACING_MS) || 2000)` read at call time (FR-035: raised only upward; the catalog rule is `int(2000, 600000)`). The formula and jitter are those of `broadcaster.js:1099-1101`.

**Exact broadcaster change** (keeps its own per-broadcast spacing and jitter, which API traffic must not reset or a busy API would starve a 60 s broadcast; adds the global floor beside them):

| Place | Change |
| ----- | ------ |
| `createBroadcaster(options)` (`:235`) | `const gate = options.gate \|\| createSendGate({ clock, random })`: a **private** gate by default, so the fake-clock engines of `test/broadcaster.test.js` cannot see each other |
| `ensureLastSendAt` (`:1027-1036`) | after `lastSendAt = Math.max(sent, claimed);` add `gate.seed(lastSendAt);` |
| `deliverOne` (`:1099-1101`) | right after `if (at - lastSendAt < gap) return;` add `if (!gate.ready(at)) return;` |
| `deliverOne` (`:1120-1121`) | right after `lastSendAt = at; jitter = null;` add `gate.reserve(at);` |
| default engine (`:1306`) | `createBroadcaster({ gate: require("./sendGate").shared })` |

The outbox mirrors it: `gate.ready(now)` before the claim, `gate.reserve(now)` at the claim, `gate.seed(max(sendingAt))` at `start()` so a restart cannot burst. A `not_on_whatsapp` or any pre-claim failure reserves nothing.

| # | Invariant |
| - | --------- |
| RT-110 | Two automatic sends, API and broadcasts together, are never closer than `spacingMs()` (SC-005); the broadcaster's own per-broadcast gap still applies on top |
| RT-111 | The existing `test/broadcaster.test.js` passes with unchanged assertions (private default gate); only the process-wide instance shares the gate |

---

## 12. `lib/utils/schema.js`

Moves the core of `validate` and `checkValue` (`lib/admin/http/request.js:139-233`) into a module the engines may require (an engine may not require `lib/admin/**`), and adds two backward-compatible rules (X5).

```js
check(input, schema, { path = "" } = {})  -> { value, fields }     // pure; fields = {} when valid
validate(input, schema)                   -> value                  // throws SchemaError("validation_failed", { fields }) | SchemaError("bad_request")
class SchemaError extends Error { code; fields }
codePoints(text) -> number
```
Rules: the existing ones (`string` with `minLength`/`maxLength` in code points, `pattern`, `enum`, `trim`, `nfkc`; `int`/`number` with `min`/`max`/`enum`; `boolean`; `array` with `min`/`max`/`items`; `object`; `required`, `nullable`, `default`) plus:
- `{ type: "object", shape: { ...schema } }` and `items: { type: "object", shape }`: recursive, builds a fresh object, strict (an unknown nested key is `<path>.$unknown = { code: "unknown_field" }`, never echoing the name), errors keyed by dotted path (`buttons.1.id`, `contacts.0.phones.2`);
- `{ type: "array", unique: true }` on arrays of scalars: the later occurrence is reported as `<path>.<index> = { code: "duplicate" }`.
A string compared for uniqueness is the trimmed, NFC-normalised value. A schema without `shape`/`unique` behaves exactly as before.

`lib/admin/http/request.js` keeps `validate` and `codePoints` in its exports as thin wrappers: `validate` calls `schema.validate` and rethrows a `SchemaError` as `AdminError(code, { fields })`, so every panel schema, error shape and `instanceof AdminError` test is unchanged. The engine and `lib/api` call `schema` directly and let `SchemaError` (code `validation_failed`, `fields`) travel as a `MessagingError`-compatible error (`toApiHttpError` accepts both).

| # | Invariant |
| - | --------- |
| RT-120 | Every existing panel schema validates identically (`test/admin-http.test.js` unchanged); a rule tree with `shape`/`unique` is the single source of validation, OpenAPI (15.12) and the descriptors (3.4) |
| RT-121 | Unknown nested properties are refused at every level; submitted values are never echoed |

---

## 13. `lib/utils/apiState.js`

The switch and the plain-HTTP network list (X1, U1), over the singleton `ApiState` row (data-model.md 4). In `lib/utils` so `lib/api`, `lib/messaging` and the panel service can require it without a cycle. Not a catalog setting: `PATCH /settings`, `config.env`, the environment and a restore cannot flip it without the password.

```js
load({ models })                              -> Promise<void>     // absence of the row = { enabled: false, plainHttpFrom: [] }; a read failure = disabled + warn
get()                                         -> { enabled, plainHttpFrom: string[], updatedAt: Date | null }   // frozen snapshot, sync
isEnabled()                                   -> boolean           // snapshot.enabled && config.ADMIN_PANEL !== false, read at call time
plainHttpFrom()                               -> string[]
setEnabled(enabled, { now } = {})             -> Promise<{ changed: boolean, enabled: boolean }>      // alias: set
setPlainHttpFrom(list, { now } = {})          -> Promise<{ changed: boolean, plainHttpFrom: string[] }>
onChange(fn)                                  -> off()            // fn({ enabled, plainHttpFrom, previous })
```
`setEnabled` and `setPlainHttpFrom` write the row (upsert on `id: 1`; the first write of `enabled: false` on an absent row is a no-op), then memory, then the listeners (each isolated); a failed write leaves memory unchanged; the same state returns `changed: false` without a write. `setPlainHttpFrom` validates the list itself as a backstop (array of strings, at most the cap of data-model.md 4, every entry parsed by `ipRules.parse(list, { privateOnly: true })`, i.e. inside RFC 1918, ULA `fc00::/7` or CGNAT `100.64.0.0/10`; a loopback, a public range, `0.0.0.0/0` or `::/0` is refused) and stores the canonical strings; a violation throws an `Error` with `code: "invalid_format"` and `params: { indices, reason }` before anything is written. The panel service validates the same way first to answer `422` with the indices (admin-api.md 1.4). The reader (`transport.js`, 15.10) re-parses with `privateOnly` and drops any entry that is not private (fail closed). **No row is created by a read** (`test/admin-security.test.js` "no GET writes"). `ADMIN_PANEL=false` forces `isEnabled()` false whatever the row says (FR-007). Audit and the step-up belong to the panel service.

---

## 14. Edits to existing modules

### 14.1 `lib/utils/permissions.js` (the number rule of feature 003)
Add and export `parsePhoneNumber(text) -> { digits, pn } | { error: "invalid_phone" }` (the number branch of `parsePerson`, `lib/admin/services/permissions.js:63-79`: strip `[\s+\-.()]`, drop a leading `00`, `^\d{8,15}$`, not starting with `0`, `pn = <digits>@s.whatsapp.net`). `parsePerson` calls it for its number branch (a one-line change in 003's file; `test/permissions.test.js` and the 003 service tests must pass unchanged).

### 14.2 `lib/utils/knownChats.js`
Add and export `isKnown(jid) -> Promise<boolean>`: private: a `KnownChat` row with `jid = :jid OR pnJid = :jid` (the `pnJid` index exists, `models/KnownChat.js`); group: kind `group` and `leftAt IS NULL`. One indexed query. `assertDestinations` matches by `jid` only (`:355-382`) and is left untouched.

### 14.3 `lib/classes/Message.js`
Add `findParticipant` and `isAdminParticipant` (`:160-180`) to `module.exports` (`:696`). No behaviour change.

### 14.4 `lib/utils/stickerMaker.js` (moved from `plugins/sticker.js`)
`imageToWebp(buffer)` (`:99`), `buildExif(pack, author)` (`:161`), `withStickerExif(buffer)` (`:180`) and the constants they use (`STICKER_SIZE` `:20`, `MAX_STICKER_BYTES` `:22`, `IMAGE_QUALITIES` `:28`, `EXIF_HEADER` `:36`) move unchanged to `lib/utils/stickerMaker.js`, which exports them; `plugins/sticker.js` requires them back (`videoToWebp` stays in the plugin and imports the constants). `withStickerExif` keeps reading `config.STICKER_PACKNAME`/`STICKER_AUTHOR` at call time. A move, no behaviour change: the existing sticker tests pass unchanged.

### 14.5 `plugins/buttons.js`
Minimal split, plugin behaviour unchanged:
```js
buildQuickReplies(text, buttons, { numbered = false } = {}) -> { kind: "buttons", text, body, nativeButtons, ids }
buildList(text, sections, { buttonLabel, numbered = false } = {}) -> { kind: "list", text, body, nativeButtons, ids }
sendPrepared(sock, jid, prepared, { messageId, quoted } = {}) -> Promise<WAMessage>     // one attempt, no fallback, no buttonRegistry record
```
`body` is `text`, or with `numbered: true` the text plus the numbered lines and the hint (3.7). `nativeButtons` are exactly what `sendQuickReplies` (`:108-155`) and `sendList` (`:165-221`) build today (`quick_reply` with `{ display_text, id }`; `single_select` with the 24/72 truncations of `:191-192`); those two functions call the builders, keep their fallback and `recordIds`. `sendOptions()` (`:26-28`) also forwards `opts.messageId`. `sendPrepared` calls `sendInteractiveMessage(sock, jid, { interactiveMessage: { body: { text: prepared.body }, nativeFlowMessage: { buttons: prepared.nativeButtons } } }, options)`, the shape of the with-mentions branch (`:57-71`); the helper spreads `...options` after its own `messageId` (`button-helper/helpers/buttons.js:863-868`). Exports gain the three names; `MAX_BUTTONS_PER_MESSAGE` stays.

### 14.6 `lib/core/pipeline.js`
`const sentIds = require("../messaging/sentIds");` and the guard of section 6. Nothing else; no new hook step (G3).

### 14.7 `lib/baileys/client.js`
No change (RT-90, section 6, section 8).

---

## 15. `lib/api`

Server-side module set of the public API (public-api.md is the wire contract; this section is what the modules export and call). Allowed imports: RT-01.

### 15.1 `createApi(deps)` (`lib/api/index.js`)

```js
createApi(deps) -> {
  handle(req, res)        -> boolean        // 15.2
  start()                 -> Promise<void>  // logs the registry failure (getLang("api.registry_failed", endpoint)) at error level; creates no timer
  stop()                  -> Promise<void>  // aborts in-flight uploads, fetches and waiters; removes their .part files
  state()                 -> { loaded: boolean, failure: null | { code: "registry_failed", endpoint: string | null, reason: string }, version: "v1" }
  routes()                -> [{ id, method, path, rights, dynamic, body, idempotent }]     // the route-table enumeration of api-security / api-contract; `rights` expands a dynamic endpoint to every id it can require
  rights()                -> [{ id, group, format }]
  catalog()               -> { version: "v1", basePath: "/api/v1", rights, formats, endpoints }   // rights = rights(); formats = formats.list().map(describe); endpoints = [{ id, method, path, rights: string[], dynamic, idempotent, summary, body: { kinds, limitBytes } }]; empty arrays while state().failure is set
  openapi({ baseUrl })    -> object          // 15.12; works while the API is disabled
  keys                    // the key store (15.7)
  ipRules                 // 15.9
  limits                  // quotas (15.8)
}
```
`deps`: `config`, `models`, `runtime` (`dbReady`), `messaging`, `apiState`, `alerts`, `audit` (`record`), `trustProxy`, `maintenanceMode`, `settingsCache`, `redactor`, `clock`, `timers`, `logger`, `dataDir`, `endpointsDir`, `createLimiter`; all resolved lazily with `deps.x || require(...)` so tests inject fakes. Built by `createAdmin` before `registerAll`, so the panel routes find it in `routeDeps`; construction does no network, no database and no timer, only requires the endpoint and format modules and builds the registry. A registry failure is caught: `state().failure` is set, `handle()` returns false, `catalog()` is empty, the bot and the panel keep running (US7.2). Without a panel there is no `createApi` call (FR-007).

### 15.2 Mounting: `handle(req, res)`

Returns false unless the pathname matches `/^\/api\/v[0-9]+(\/|$)/` (`splitUrl`; `/api/info` and `POST /api/restart` are never claimed). Then, in this order: `deps.runtime.dbReady !== true` gives a claim and `503 unavailable` + `Retry-After: 5` (the switch is unknown during this window, so the answer cannot depend on it); a switch that is off or a registry that failed returns **false**, so the legacy handler answers exactly as for any unknown URL (`lib/admin/monitoring.js:183-193,229-232`; no oracle); `maintenanceMode.isActive()` gives `503 unavailable` + `Retry-After: 5`; otherwise `pipeline.dispatch` runs and the call returns true. The switch is read per request (`apiState.isEnabled()`).

### 15.3 Endpoint module (research A3, X11)

```js
module.exports = {
  id: "messages.create",                 // /^[a-z]+(\.[a-z]+)+$/, unique; OpenAPI operationId, log field
  method: "POST", path: "/api/v1/messages", params: {},     // ":id" needs params: { id: /^msg_[A-Za-z0-9_-]{22}$/ }
  right: "messages.read",                // STATIC: one right id /^[a-z]+(\.[a-z0-9_]+)*$/
  // or DYNAMIC: rights: ({ formats }) => [every id the endpoint can require], requires: (peek, { formats }) => string[]
  query: { wait: { type: "int", min: 0, max: 30, default: 0 } },    // 12 dialect, strict
  body:  { kinds: ["json", "multipart"], limit: 65536,              // "none" for GET (the only other kind)
           schema: {...} | variants: { by: "format", schemas: ({ formats }) => ({ text: {...} }) },
           refine: (body, ctx) => fieldsOrNull,
           file: { part: "file", maxBytes: (peek) => n, accept: (peek) => ({ kinds }) } },
  recipient: (peek) => peek.to,          // optional: tells the pipeline which recipient to evaluate (steps 13, 14)
  idempotent: true, quota: { messages: true },
  response: { status: 202, headers: ["Location"] },
  deprecated: undefined,                 // { since, sunset, link } -> OpenAPI + Deprecation/Sunset
  doc: { summary, description, tags, examples },    // English
  async handle(ctx) {},                  // returns reply(status, body, headers) from lib/admin/http/response.js
};
```
Query values arrive as strings: the pipeline coerces a decimal-digit string to a number for an `int` rule (anything else is `invalid_format`, outside the bounds `out_of_range`) and validates query and body together (their names are disjoint, public-api.md 3.10).

`ctx = { req, res, requestId, endpoint, params, query, body (fresh validated object), file ({ path, size, name, sha256, mime } | null), key: Object.freeze({ id, lookupId, name }), origin, now, signal, idempotency ({ key, requestHash } | null), services: Object.freeze({ messaging, formats }), audit }`. The handler never sees the key's hash, rights or policy. The temp file is removed by the pipeline's `finally` when it still exists (a successful `submit` has moved it): there is no `adopt(dest)`.

### 15.4 Registry: `lib/api/registry.js#loadEndpoints({ dir, formats })`

Requires `endpoints/*.js` in sorted order. Each violation throws `ApiRegistryError { endpoint, file, reason }`, so the message names the endpoint: neither `right` nor (`rights` + `requires`) present or malformed (**deny by default; no public level exists**); `id` or `method path` not unique; path outside `/api/v<n>/`; a `:param` without a pattern; `GET` with a body kind other than none; `body.limit` above 1 MiB; `multipart` without `file`; invalid `schema`; `doc.summary` missing; `handle` not a function. A `requires()` result outside `rights()` at runtime is a programming error: 500 `internal_error`, logged, never a grant. Returns `{ endpoints, rights: [{ id, group, format }], byRoute }`; groups `send` (the union of `formats.rights()`), `read`, `media`, `docs`, other groups alphabetical. v1 modules: `messagesCreate` (`messages.create`, `POST /api/v1/messages`), `messagesGet` (`messages.get`, `GET /api/v1/messages/:id`), `messagesList` (`messages.list`, `GET /api/v1/messages`), `openapiJson` (`openapi.get`, `GET /api/v1/openapi.json`, right `api.docs`).

### 15.5 Router: `lib/api/router.js`

A separate router, not a generalisation of `lib/admin/http/router.js` (that one is welded to sessions, `/admin` and CSRF and its table is pinned): two routers and two tables make FR-004 structural. `createApiRouter({ endpoints })` -> `{ match(method, pathname) -> { endpoint, params } | { allow: string[] } | null, table() }`; literal and `:param` segments, no regex path, a pattern per param, ambiguity checked by shape at build. Reused as imports: `request.js` (`splitUrl`, `parseQuery`, `readJsonBody`), `response.js` (`newRequestId`, `errorBody`, `finish`, `reply`), `security.js` (`mediaType`, `safeEqual`), `rateLimit.js`.

### 15.6 `lib/api/pipeline.js`: `dispatch(req, res, env)`

Never throws, always ends the response. Sets `X-Request-Id` and the `api` header profile first, then runs the ordered steps of public-api.md section 5 (numbering 1 to 20 and 12b is that table's):

| Step | Implemented by | Calls |
| ---- | -------------- | ----- |
| 1 gate | `dispatch` | `runtime.dbReady`, `maintenanceMode.isActive()` (unreachable after 15.2; kept as the second line) |
| 2 verb | `router.match` | |
| 3 transport | `transport.js#transportAllowed(req)` | `trust.isHttps`, `isLocalRequest`, `isPlainHttpAllowed` (15.10) |
| 4 browser | `rejectBrowser(req)` | `Origin` or `Sec-Fetch-Site` present |
| 5 key in URL | `keyInUrl(req)` | query names `api_key`, `apikey`, `key`, `token`, `access_token`, `authorization`; any path/query text with the key shape |
| 6 origin block | `originLimiter.check(origin)` | `createLimiter({ limit: 10, windowMs: 300000, blockMs: 900000, maxEntries: 10000, now })` from `lib/admin/auth/rateLimit.js`, in memory only |
| 7-9 authenticate | `keyStore.lookup(token)` | each failure calls `originLimiter.fail(origin)`; `newlyBlocked` raises `api_origin_blocked` (17.2) and one optional `api.origin.block` audit row; `success()` is **never** called |
| 10 route | `router.match` | after authentication |
| 11 static right | `key.rights.has(endpoint.right)` | |
| 12 body peek | `readJsonBody` or `multipart.readMessagePart` | 15.11 |
| 12b dynamic rights | `formats.rightsFor(peek.format, peek)` | `forbidden { right }` |
| 13, 14 recipient | `messaging.resolveRecipient(peek.to, { policy: key.policy })` | one call, two error codes in FR-032 order (5.2) |
| 15 idempotency | `idempotency.js` | `messaging.findByIdempotency` |
| 16 quota check | `messaging.checkAdmission` then `quotas.check(key)` | skipped when step 15 found a stored key |
| 17 validation | `messaging.validateInput(format, peek, { target, apiKeyId })` | |
| 18 media | `upload.receive` or `messaging.fetchMedia`, then `messaging.inspectMedia` | exactly one source: neither gives `fields.media = required`, both `fields.media = not_allowed`, a file on a format without media `fields.file = not_allowed` |
| 19 reserve | `idempotency.compare`, `quotas.reserve(key)` | released on any later failure |
| 20 handle | `endpoint.handle(ctx)` | the `finally` removes the temp file and releases an unused reservation |

Rules: only steps 7-9 count toward the origin block; any refusal before the body was consumed adds `Connection: close` (precedent `lib/admin/http/request.js:102-107`); the pipeline never reads `Cookie`, never calls `deps.auth.authenticate` and never sets `Set-Cookie`; `RateLimit-*` headers come from `quotas.snapshot(key)` once the key is authenticated; auth failures are logged at `info`, deduplicated per origin with `cooldown.hit(origin, "apiauth", 60000)`, with `{ requestId, endpoint id, status, ms, keyId }` at `debug` (keyId = the public `lookupId`); never `req.url`, headers or body (RT-05). `lib/api/present.js#presentMessage(view)` builds the public message resource of public-api.md 4.1 from a `MessageView`.

### 15.7 `lib/api/keyStore.js`

```js
createKeyStore({ models, settingsCache, now, redactor, alerts, trustProxy, timers }) -> {
  generateSecret() -> { secret, lookupId, secretHash, last4 }        // secret = the whole token; crypto.randomBytes
  parseToken(text) -> { lookupId, secret } | null                    // shape check only
  lookup(token)    -> Promise<{ status: "malformed" | "unknown" | "mismatch" | "unavailable" } | { status: "ok", key: KeyRecord }>
  invalidate(id?)  -> void                                           // settingsCache.invalidate("api_keys"); the id is accepted and ignored (the cache is one map)
  invalidateAll()  -> void
  touch(key, { ip, origin, at }) -> void                             // write-behind usage columns; may raise api_key_new_ip
}
```
**Token**: `owbk_` + 16 hex (the `lookupId`, 64 random bits) + `_` + 43 base64url characters (the secret, 32 random bytes): 65 characters, regex `owbk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}`. `secretHash` is the lowercase hex SHA-256 of the 43-character secret **string** as sent (not of decoded bytes: base64url has non-canonical encodings), `last4` the last 4 characters of the token. SHA-256 and not scrypt: 256 random bits cannot be brute-forced from a stolen database, and a memory-hard KDF would charge every request tens of milliseconds (DoS amplification, SC-010).

**Verification**: shape regex, then `Map.get(lookupId)` on the cache, then `crypto.timingSafeEqual(Buffer.from(row.secretHash, "hex"), sha256(secret))`; an unknown id compares against a dummy hash so both paths cost the same. Missing, malformed, unknown and wrong secret all give `unauthenticated`. Revoked, expired and IP are evaluated only after the secret matched (so `key_revoked`, `key_expired`, `ip_not_allowed` leak nothing to someone without the whole secret).

**Cache**: `settingsCache.getOrLoad("api_keys", loader, 5 * 60 * 1000)` holds `Map<lookupId, KeyRecord>` from all `ApiKey` rows, revoked included, read through model instances (data-model.md 1.7): `KeyRecord = { id, lookupId, name, secretHash, rights: Set, policy: { mode: "list" | "known" | "any", entries }, limits: { perMinute, perDay, maxPending } (nullable, resolved at check time), ipAllow (compiled), expiresAtMs, revokedAtMs, seenIps: Set, lastUsedAtMs }`; `policyMode` `anyone` maps to `any`. Every configuration writer (the panel service) calls `invalidate` in the same tick after its commit, so a revocation applies to the very next request (FR-014); restore and the in-process restart already call `settingsCache.clear()`. A load failure with no previous value yields `unavailable` (fail closed). `ctx.key` carries only `{ id, lookupId, name }`.

**Usage write-behind**: `touch` updates `lastUsedAt`, `lastIp` (full effective address), `seenIps` (<= 20 origin keys, oldest dropped) in the cached record and writes the row with `silent: true` at most once per key per 60 s, and at once for a new origin; it never bumps `version` and never invalidates the cache; no timer. A new origin with a non-empty `seenIps` calls `alerts.raise("api_key_new_ip", { keyId, keyName, ip })`; the first origin of a key never alerts.

**Redaction**: `lib/admin/logs/redactor.js` gains `BUILTIN_PATTERNS = [/owbk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}/g]` applied by `scrub` (also when no value is registered, so the early `entries.size === 0` return must not skip it), always on whether or not the API is enabled; the panel service registers a fresh secret with `redactor.registerEphemeral("apikey:<lookupId>", token, 600000)` for the create response. `logger.js` (`destination.write`), `ring.js` and `audit.js` already pass everything through `scrub`; the pino path `req.headers.authorization` stays as the last line.

### 15.8 `lib/api/limits.js` and `lib/api/idempotency.js`

```js
createQuotas({ now, messaging, config, models, zone }) -> {
  check(key)    -> Promise<void>                          // non-consuming: day then minute (the engine's admission has run first)
  reserve(key)  -> { release() }                          // synchronous re-check + push; released on any failure before submit succeeds
  snapshot(key) -> { limit, remaining, resetSeconds }     // RateLimit-* headers (the per-minute window)
}
```
Per key, in memory: `minute` = sliding list of acceptance timestamps over 60 s; `day` = counter for the local calendar day in `TIMEZONE` (`stats.dayOf`-style, `lib/utils/stats.js:79`), hydrated lazily once per key per process from `ApiMessage` rows accepted today (every status counts) and the last 60 s, so a restart cannot reset either; a new local day resets the counter. Limits: `key.limits.x ?? config.API_RATE_PER_MINUTE | API_RATE_PER_DAY | API_MAX_PENDING` at call time. Refusals (codes and statuses in public-api.md 7.1): `daily_quota_exceeded` (`retryAfterMs` = ms to the next local midnight), `rate_limited { scope: "minute", limit }` (`oldest + 60 s - now`); the pending and global refusals are the engine's (4.5). A replay, a refused request and a request failing after the reserve do not count.

`idempotency.js`: `fingerprint({ secretHashHex, endpointId, rawBody, fileSha256 })` = hex HMAC-SHA256 (key = the `secretHash` bytes, data = `endpointId \0 canonicalJson(rawBody) \0 (fileSha256 or "")`) truncated to 32 characters, `canonicalJson` sorting keys recursively, `wait` and the header excluded; `lookup(...)` through `messaging.findByIdempotency`; `compare(stored, fp)` throws `ApiError("idempotency_conflict")` when the hashes differ. The window is `IDEMPOTENCY_MS` (24 h, not configurable). A lost race arrives as `submit` returning `{ replayed: true, requestHash }`, which the pipeline compares the same way.

### 15.9 `lib/api/ipRules.js` (a dependency-free leaf: Node `net` only, its own `unmap`, so `apiState` and the SPA's logic can share it)

```js
parse(list, { privateOnly = false } = {}) -> { entries: string[], invalid: [{ index, reason? }] }     // normalised, at most 50
compile(entries) -> { check(address): boolean }          // net.BlockList; empty list = no restriction
covers(oldEntries, entry) -> boolean                     // same family and the range of `entry` inside one old range, BigInt compare
isPrivateRange(entry) -> boolean                         // inside 10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7
MAX_ENTRIES = 50
```
Grammar (also used by the SPA's `api-logic.mjs` against the fixture `test/fixtures/api-ip-entries.json`): one entry per item, trimmed; IPv4 `a.b.c.d`, IPv4 CIDR `/0-32`, IPv6, IPv6 CIDR `/0-128`; IPv4-mapped IPv6 and zone ids unmapped (the module carries its own copy of `trustProxy.unmap`); lower-case canonical form; `0.0.0.0/0` and `::/0` accepted; host bits below the mask are masked; anything else `invalid_format`. Matching uses the full effective client address, never the /64 origin key. `privateOnly` marks an entry outside the private ranges `{ reason: "not_private" }`.

### 15.10 `lib/api/transport.js` and `trustProxy.clientAddress`

`trustProxy.clientAddress(req)` is added: the unmapped effective client IP (the socket address, or the right-most `X-Forwarded-For` entry that is not itself trusted when the peer is trusted; garbage from the proxy fails closed on the socket), exactly what `originKey` (`trustProxy.js:212-224`) derives its key from; `originKey(req)` becomes `keyOf(clientAddress(req))` (behaviour unchanged). `transport.js`: `transportAllowed(req)` = `trust.isHttps(req) || isLocalRequest(req) || isPlainHttpAllowed(req)`; `isLocalRequest` = peer loopback **and** `trust.proxyHint(req).length === 0` **and** `clientAddress` loopback (an untrusted loopback proxy adding `X-Forwarded-*` is not local; the host's own interface addresses never are: Docker's userland proxy presents the `docker0` address for Internet traffic); `isPlainHttpAllowed` = no `proxyHint` and `clientAddress` inside `ipRules.compile(ipRules.parse(apiState.plainHttpFrom(), { privateOnly: true }).entries)`, re-read per request (a widened or removed entry applies at once). Refusal: `403 https_required`, before the key is read.

### 15.11 `lib/api/multipart.js`, `lib/api/upload.js`

`multipart.js`: `parseMultipart(source, boundary, onPart)` and `readMessagePart(req, { limit })`: a hand-written restricted streaming parser (X12, no dependency): `multipart/form-data; boundary=<1-70 RFC 2046 chars>`, at most two parts in the order `message` (JSON text, any part Content-Type) then `file`, each header block <= 4 KiB with only `Content-Disposition: form-data; name="..."[; filename="..."]` and an optional `Content-Type`; duplicate or folded headers, `Content-Transfer-Encoding`, a third part, a missing closing boundary or a preamble over 1 KiB give `bad_request`; `file` before `message` gives `validation_failed` `fields.file = { code: "invalid_order" }`. `upload.js`: after the right, the policy and the quota check, pipes the `file` part to `data/tmp/api/<random>.part` (0600, `flags: "wx"`) through a counting `Transform` capped at `sniff.effectiveMax(format)`; an overflow destroys the request and answers `413 media_too_large { maxBytes }` after at most `cap + 64 KiB` bytes; a declared `Content-Length` over `64 KiB + cap + 16 KiB` is refused before reading; SHA-256 is computed on the fly; the first 4100 bytes go through `sniff.classifyHead`; at most 2 uploads in flight per key and 4 in total (`429 rate_limited { scope: "uploads" }`), a 30 s idle timeout per chunk, pending media bytes plus in-flight uploads <= `2 * MAX_UPLOAD MB` else `503 queue_full { scope: "disk" }`. Returns `ctx.file`; the `.part` is deleted on every error path and abort (`res.on("close")` -> `AbortSignal`).

### 15.12 `lib/api/openapi.js`, `lib/api/version.js`

`buildOpenApi({ endpoints, formats, info, serverUrl, errors })` is a pure function returning an OpenAPI 3.1.0 object, memoised after the first build (only `servers` varies per call); `api.openapi({ baseUrl })` is its facade and is what API-13 and PUB-4 call. One mapper from the 12 dialect (`string` to `type: string` + `minLength`/`maxLength`/`pattern`/`enum`; `int` to `integer`; nested `shape` to `object` with `properties`/`required`; `unique` to `uniqueItems`; `nullable` to `type: [T, "null"]`; every object `additionalProperties: false`) feeds both validation and the document. The send operation is `oneOf` over `formats.schemaOf` with a `discriminator` on `format` and one named example per format; `components.schemas.Error` enumerates `Object.keys({ ...MESSAGING_STATUS, ...API_STATUS })`, `FailureCode` the 14 codes, `MessageStatus` the nine statuses. `version.js`: `API_VERSION` (semver, starts at `1.0.0`; its major equals the path version) and the versioning rules of public-api.md section 10.

### 15.13 `lib/api/errors.js`

```js
class ApiError extends Error { code; fields?; params?; headers? }
API_STATUS = Object.freeze({ 19 entries })                 // the HTTP-layer codes only (below)
statusOf(code) -> number                                    // looks up { ...MESSAGING_STATUS, ...API_STATUS }
toApiHttpError(err) -> { status, code, fields, params, headers }
```
`API_STATUS`: `unavailable` 503, `method_not_allowed` 405, `not_found` 404, `bad_request` 400, `https_required` 403, `browser_not_allowed` 403, `key_in_url` 400, `origin_blocked` 429, `unauthenticated` 401, `key_revoked` 401, `key_expired` 401, `ip_not_allowed` 403, `forbidden` 403, `rate_limited` 429, `daily_quota_exceeded` 429, `idempotency_conflict` 409, `payload_too_large` 413, `unsupported_media_type` 415, `internal_error` 500. `toApiHttpError`: an `ApiError` or `MessagingError` keeps its code, fields and params; a `SchemaError` or an `AdminError` of code `bad_request | payload_too_large | validation_failed | unsupported_media_type | method_not_allowed | not_found` maps to the same code; `isDbDown(err)` to `unavailable`; anything else to `500 internal_error` with the reduced error logged. `params.retryAfterMs` becomes `Retry-After` through `response.js#retryAfterHeader` (exported by this feature). `fields` only for `validation_failed`. The panel's `STATUS_BY_CODE` gets none of the API-only codes.

### 15.14 Additive edits to panel files

| File | Change |
| ---- | ------ |
| `lib/admin/server.js` (`createPanelServer`, `:51-59`) | new option `api` (default `admin && admin.api`); handler becomes `if (api && api.handle(req, res)) return; if (admin && admin.handle(req, res)) return; ...` (rest unchanged); header comment updated |
| `lib/admin/index.js` | `const api = (deps.createApi \|\| require("../api").createApi)({ ...pass-through deps, trustProxy, clock, logger, dataDir, audit })` built before `registerAll` (`:179`) and added to `routeDeps` (`:142`); `admin.api`; `startHooks.push(() => api.start())` pushed after `registerAll`, so it runs after the route hooks; `api.stop()` from `stop()` |
| `lib/admin/http/security.js` | `applySecurityHeaders(res, { cacheControl, profile })`: `profile: "api"` sets `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, and no `X-Frame-Options`, `Permissions-Policy`, COOP or HSTS; `Access-Control-*` is still stripped |
| `lib/admin/http/response.js` | `finish(res, { ..., profile })` forwards `profile`; `retryAfterHeader` exported |
| `lib/admin/http/trustProxy.js` | `clientAddress(req)` (15.10) |
| `lib/admin/http/request.js` | thin wrappers over `lib/utils/schema.js` (12) |
| `lib/admin/logs/redactor.js` | `BUILTIN_PATTERNS` (15.7) |
| `lib/utils/settingsCache.js` (header comment `:8-11`) | add `api_keys` to the key list |

| # | Invariant (API layer) |
| - | --------------------- |
| RT-130 | A disabled API, `ADMIN_PANEL=false` and a failed registry are byte-identical to any unknown URL (status, headers, body) for every verb, with or without a key (`test/panel-legacy.test.js` rows) |
| RT-131 | No endpoint exists without a declared right; a registry failure serves none of them (FR-090) |
| RT-132 | The key is read only from `Authorization`; a key-shaped string in the URL is refused without being parsed, hashed or logged (FR-016) |
| RT-133 | `ctx.key` is `{ id, lookupId, name }` only; `ctx` never exposes `secretHash`, the rights set, the policy or the limits of the key; the handler cannot bypass a step |
| RT-134 | No response, log line, audit detail or error body contains a token, its secret part, a message text, a caption, a file name, a URL or a recipient in clear outside the owning key's own `GET` (SC-003) |

---

## 16. Boot and lifecycle

### 16.1 `lib/core/boot.js` (the only place that changes boot order)

1. `ENGINES` (`:31-37`) gains `{ name: "messaging", id: "../messaging", start: (engine, client) => engine.start(client) }` between `broadcaster` and `alerts`. A hard require like the others (header `:20-24`); the loop at `:222-232` registers `stop` with `runtime.onShutdown` and isolates a failed start (`engine failed to start`). Header comments (`:9-18`, step 9) list it.
2. `apiState` is a hard-required collaborator beside `textOverrides`/`commandState`/`ytdlpUpdate` (`:146-148`): `const apiState = engineOf("apiState", "../utils/apiState")`, replaceable through `options.deps.engines.apiState`.
3. Step 6, after `settingsStore.markInForce()` (`:207`) and before `runtime.dbReady = true` (`:209`): `await apiState.load({ models: database })` (a read failure means disabled and is logged).
4. Step 4, inside `if (config.ADMIN_PANEL)` (`:154-177`): `createAdmin({ ..., messaging: engineModules.messaging, apiState, createApi: deps.createApi })`; `createAdmin` builds the API (15.1). `runtime.onShutdown(() => admin.stop())` (`:176`) stops it; `startAdminServer({ admin, runtime, bind, config })` (`:179-180`) is unchanged: `createPanelServer` reads `admin.api` (X10).
5. Step 9: the engine loop starts `messaging` (after `broadcaster`, before `alerts`), then `admin.start()` (`:234`) calls `api.start()`.
6. `options.deps` gains `createApi`, `engines.messaging`, `engines.apiState`. `index.js` and `panel.js` need no change.

### 16.2 Order

`stats`, `housekeeping`, `broadcaster`, `messaging`, `alerts`, `updater`, then `admin.start()` (auth, hooks, `api.start()`), then `client.initialize()`. Requests between step 6 (`dbReady`) and the end of step 9 are accepted and queued (the timer does not exist yet); `recover()` cannot race them because it only touches rows that existed before.

### 16.3 `messaging.start(client)`

Idempotent. Always: remembers `client`, `formats.load()` (a `FormatRegistryError` is rethrown for the boot log; `enable()` then does nothing), `outbox.recover({ now })` (4.4 RT-54), `gate.seed(max(sendingAt))`, one `sweepMedia`. If and only if `apiState.isEnabled()`: `enable()` (tick timer, receipts listener, `pendingHint` seed, `kick()`). It subscribes to `apiState.onChange` (enabled flips call `enable()`/`disable()`); that subscription is the only listener a disabled API holds. There is no `reconfigure()` and no `settingsStore.onChange` subscription: the tick interval is the constant `TICK_INTERVAL_MS`, no timer or cached client is built from a setting, and every number is read through `config.X` where it is used (RT-03; `test/capture-sites.test.js` pins it), so a changed quota, spacing, expiry or window applies to the next request or message and never to rows already queued. `stop()` is called by the generic shutdown loop. A disabled API holds no timer and no client listener (RT-02).

### 16.4 Switch, maintenance, restore, restart

- Turning the switch off: `apiState` listeners call `disable({ reason: "api_disabled" })`: timer cleared, listener detached, every `queued` row cancelled (`api_disabled`), waiters resolved; a `sending` row finishes normally. The panel service reports the count.
- `maintenanceMode` (restore in progress): `api.handle` answers `503 unavailable` (15.2), the tick returns, sends are bracketed (4.9). The restore never touches the four tables; the switch is not re-read (it is not in the archive); `settingsCache.clear()` makes the next request reload `api_keys`.
- In-process restart (`botRuntime.js:196-231`): nothing to do (RT-03, 4.9); `recover()` is not re-run, an in-flight send settles as `unknown` through its own error path.
- `ADMIN_PANEL=false`: no `createAdmin`, no API; `apiState.isEnabled()` false; the messaging engine still boots in recovery-only mode (4.4 RT-54) so a crash cannot leave rows queued.

### 16.5 Registry failure

`createApi` catches `ApiRegistryError` (endpoints) and `FormatRegistryError` (formats): `state().failure = { code: "registry_failed", endpoint, reason }`, `handle()` returns false, `catalog()` empty, `start()` logs `getLang("api.registry_failed", endpoint)` at error level (the language manager is reloaded after `createAdmin`, so the log is at `start()`, not at construction). The bot keeps running; API-1 reports the failure, API-2 `enabled: true` answers `409 api_disabled { reason: "registry_failed" }`. The messaging engine, if its own `formats.load()` fails, stays not running; queued rows are neither sent nor lost.

---

## 17. Settings, alerts, housekeeping

### 17.1 Settings read (X2; all panel-only, `env: null`, catalog 101 to 112 entries; definitions in [../data-model.md](../data-model.md) 8.1)

| Key (default) | Read by | When |
| ------------- | ------- | ---- |
| `SEND_MIN_SPACING_MS` (2000, `int(2000, 600000)`) | `sendGate` (`ready`, `waitMs`), `spacingMs()`, the admission formulas, `Retry-After` computations | every call |
| `API_RATE_PER_MINUTE` (30), `API_RATE_PER_DAY` (1000), `API_MAX_PENDING` (100) | `lib/api/limits.js` and the facade's `checkAdmission` argument (`key.limits.x ?? config.X`) | every request |
| `API_QUEUE_MAX` (500) | `checkAdmission`, `submit` | every accept |
| `API_QUEUE_EXPIRY_MIN` (10) | `submit` (snapshot into `expiresAt`), the admission estimate | every accept |
| `API_RETENTION_DAYS` (30) | housekeeping `apiMessages`, `apiKeys` | every run |
| `API_REPLY_WINDOW_DAYS` (7, <= `API_RETENTION_DAYS`) | settle T3 / T8 (snapshot into `repliesUntil`) | every settle |
| `ALERT_API_ORIGIN_BLOCKED` (true), `ALERT_API_KEY_NEW_IP` (**false**), `ALERT_API_PAUSED` (true) | `lib/utils/alerts.js#isEnabled` | every raise |

Also read at call time: `MAX_UPLOAD` (`sniff.effectiveMax`, pending-bytes guard), `TIMEZONE` (limits, housekeeping), `PANEL_TRUST_PROXY`, `PANEL_PUBLIC_URL`, `ADMIN_PANEL`, `STICKER_PACKNAME`, `STICKER_AUTHOR`. Never read: `PREFIX`. `config.env.example` is untouched (env-less entries). `ALERT_API_KEY_NEW_IP` needs `entry({ key, env: null, theme: "alerts", type: "bool", default: false })`: the `alert(key)` helper hard-codes `default: true` (`settingsCatalog.js:881`). A cross validator beside `responderDelays` enforces `API_REPLY_WINDOW_DAYS <= API_RETENTION_DAYS` (`bound_conflict`). No new theme.

### 17.2 Alerts raised (X9; direct `alerts.raise`, no bus topic; `lib/utils/alerts.js` `TYPES` `:77-85`, `sanitize` `:144`, `renderText` `:189`)

| Type | Toggle | Slot (`AlertState.key` STRING(96)) and window | Payload (rebuilt field by field in `sanitize`) | Raised by | Text key |
| ---- | ------ | --------------------------------------------- | ---------------------------------------------- | --------- | -------- |
| `api_origin_blocked` | `ALERT_API_ORIGIN_BLOCKED` | `api_origin_blocked:<origin>`, 15 min | `{ origin (plain 64), retryAfterMs, at }` | `lib/api/pipeline.js` when `originLimiter.fail` reports `newlyBlocked` | `alerts.api_origin_blocked` ({0} origin, {1} minutes) |
| `api_key_new_ip` | `ALERT_API_KEY_NEW_IP` | `api_key_new_ip:<keyId>:<ip>`, 24 h | `{ keyId, keyName (plain 64), ip (net.isIP), at }` | `keyStore.touch` (a new origin on a key whose `seenIps` is non-empty) | `alerts.api_key_new_ip` ({0} key name, {1} IP) |
| `api_paused` | `ALERT_API_PAUSED` | `api_paused`, 15 min | `{ code (plain 16), resumesAt, at }` | the outbox when the restriction breaker opens (4.6) | `alerts.api_paused` ({0} minutes) |

Knock-on edits (not optional): `AlertOutbox.TYPES` (`models/AlertOutbox.js:11`) lists the three (the column is STRING(24), the longest is 18 characters); `TYPE_SETTINGS` follows `TYPES`; `alerts.prune` (`:323`) and `housekeeping.pruneAlertStates` (`:190`) delete the three slot prefixes after 24 h; `lib/admin/services/alerts.js:20-27` and `public/js/views/alerts-logic.mjs:5-12` append three rows (ALR-1 goes from 6 to 9 types); texts in `specs/004-messaging-api/i18n/bot-api.json` (the three `alerts.api_*` keys and `api.registry_failed` ({0} endpoint); same key set in `en` and `fr`, merged with `node tools/merge-i18n.js --frag-dir specs/004-messaging-api/i18n --pattern "bot-*.json"`, `--dry-run` first).

### 17.3 Housekeeping (statements in [../data-model.md](../data-model.md) section 5)

Five steps appended to `run()` (`lib/utils/housekeeping.js:271-299`) after `mediaSweep`, each through `step()`, in this order: `apiIdempotency`, `apiTransient` (starts with the 15-minute net that turns a stuck `sending` into `unknown / interrupted` through T8, then `payload`, `mediaPath` and `replyData`/`pollSecret`), `apiMessages` (batches of `LIMITS.BATCH`, responses first, cutoff `min(now - API_RETENTION_DAYS, start of the local day)`), `apiKeys` (revoked keys older than the retention, U10; then `keyStore.invalidate()`), `apiMedia` (= `messaging.sweepMedia({ now })`, resolved lazily like the broadcaster: `options.messaging !== undefined ? options.messaging : optionalRequire("../messaging")`, outside any engine lock). New `LIMITS`: `API_IDEMPOTENCY_MS`, `API_SENDING_STUCK_MS`. `pruneAlertStates` covers the three alert prefixes (17.2). The daily job runs with or without the panel, so FR-074 and FR-075 hold with `ADMIN_PANEL=false`; with the API never used all five are index-only no-ops. The boot sweep of `data/tmp` already removes stale `data/tmp/api/*.part`.

---

## 18. Test obligations

Run each file alone with caps (`OWB_NO_CONFIG_ENV=1 timeout 120 node --max-old-space-size=1024 --test --test-force-exit --test-timeout=30000 test/<file>.test.js`), never two suites in parallel. New tests use `fakes.setupEnv()`, the in-memory database, `test/helpers/fakeClock.js` and a per-test temp `data` root; none needs the network or a phone. Helper changes (backward compatible): `fakeSocket.sendMessage` uses `options.messageId` as `key.id` when given (today `BOT${n}`, `test/helpers/fakes.js:377-387`) and accepts `opts.announce`, `opts.groupMetadataError`, `opts.onWhatsApp`; `fakes.fakeClient.ready()` (always true, `:545`) is overridden to simulate a disconnection; `test/helpers/apiHarness.js` and `test/helpers/apiInvariants.js` (data-model.md). Tests that public-api.md section 11, admin-api.md section 5 and data-model.md "Test obligations" already own are not repeated; the lines below add the runtime ones.

| Test file | Pins |
| --------- | ---- |
| `test/messaging-formats.test.js` (new) | registry load (sorted, rights derived, every boot failure of 3.5), `list()` rows, every `fields` schema accepts its `doc.examples` and rejects each out-of-range value with the exact code and dotted path; `build()` of text, location, contact, poll, buttons, list run through the **real** `generateWAMessageContent` (offline for non-media): poll V3 versus V1, `contactMessage` versus array, `linkPreview: null` makes `getUrlInfo` never called (section 9), vCard injection (a name holding `\r\nTEL:`), mention JIDs, numbered body and hint (3.7); media formats at the `build()` level with a fake `media`; `prepare` of voice, gif, sticker with the real ffmpeg/sharp on generated 1-second samples (skipped when ffmpeg is absent); descriptors (3.4) and the panel label keys in both catalogs; a demo module appears in `list`, `rights`, `describe` with no other edit (SC-009) |
| `test/messaging-submit.test.js` (new) | the accept path of 4.2: every refusal in order and nothing written; payload shape and the erase of RT-40/41; stage adoption (move and copy) and removal on refusal (RT-42); idempotent replay on a lost race, lazy 24 h release; quote rules; `size` per format; admission codes and `retryAfterMs` of 4.5 (global, wait at 272 pending, pending, disk) and atomicity under 50 concurrent accepts; `checkAdmission` equals the `submit` verdict; `api_disabled` while off; `get`/`list` scoping (RT-11) and keyset |
| `test/messaging-outbox.test.js` (new) | fake clock + fake socket + `tick(now)`: accept to sent; **SC-005**: 100 accepted, ticks at 250 ms for 5 simulated minutes, every consecutive pair of `sock.sent` times >= 2000 and <= 2400 + tick; shared gate: a broadcast and API messages interleaved on one gate stay >= 2000 apart, and a 60 s-spacing broadcast is not starved by one API message per 30 s; **SC-006**: engine A claims and its socket hangs, engine B on the same database runs `recover()` and ticks: the row is `unknown`, the socket saw one send, the id is unchanged, both crash windows (before and after the claim UPDATE); expiry at 10 minutes while disconnected; `cancelByKey` racing a claim; revoked and expired key at the pick; switch off; ban at the pick; self number at the pick; `not_on_whatsapp` reserves nothing; group not a member and announce-only; transient verify deferral does not block the queue; `timeout` to `unknown`, 4xx to `failed`; settle UPDATE retried once; waiter resolves on `sent`, not on `delivered`, at the deadline with the current row, caps at 200, `disable()` resolves all; breaker on `463` (pause 15 minutes, expiries unchanged, alert once); `sending` rows seed the gate; the tick sleeps when `pendingHint` is 0 and `clock.pending() === 0` while disabled or idle (RT-02/03); `assertMessageInvariants` after every scenario |
| `test/messaging-recipients.test.js` (new) | the 003 number cases (also against `parsePerson`), group id shape, LID refused; policy table list/known/any with PN-only rows, a person recorded under a LID with `pnJid`; banned PN versus banned LID; bot's own number after the policy; `mask` |
| `test/messaging-receipts.test.js` (new) | `client.dispatch("messages.update", [...])` with statuses 0/1/2/3/4/5, a LID `remoteJid`, an unknown id (0 rows), `unknown` upgraded (columns cleared), forward-only order, a group id ignored, listener removed on `disable()` and `stop()` |
| `test/messaging-replies.test.js` (new) | through the real pipeline: tap consumed and recorded; wire id with the switch off consumed not recorded; plain text that looks like a wire id ignored; quoted number two hours later; a quoted number of a non-API message reaches the games' hooks; > window consumed not recorded; cap of 1000; poll vote built with the inverse of the decryption: single, multiple, replace, clear, stale redelivery, wrong forms tried, bad secret ignored, `replyData` expired ignored; private `author` forced to the recipient; `describeResponses` shape and totals (public-api.md 4.4) |
| `test/messaging-never-command.test.js` (new) | (a) the outbox sends `.eval 1+1` and `.restart`: `sock.sent[0].content.text` verbatim and `registry.executeCommand` (spied) never called; (b) `pipeline.processMessage` fed a `fromMe` echo with the recorded `waId` (as owner) runs no `executeCommand` and no reply, the same echo with an unknown id does reach the pipeline (the guard is the cause); (c) with `fakeBaileys.js`, `messages.upsert { type: "append" }` for an own `.eval` makes the client emit no `messages` event; (d) recipient = bot number refused; (e) a static scan: `lib/messaging/**` never mentions `config.PREFIX` |
| `test/messaging-media.test.js` (new) | `sniff` kinds and mismatch (`expected`, no detected type), effective cap, `stage` adopt/remove/`assertInside`, path validation before any path is built, `sweepMedia` (orphan older than 1 h removed, younger kept, active kept, `.part` swept) |
| `test/url-fetch.test.js` (new, public-api.md 8.1 owns the rows) | the SSRF battery with a spy `request` never called for a non-public target (RT-95), pinned `agent: false`, rebinding resolver resolved once per hop, preview fetch and its failure never failing the message |
| `test/send-gate.test.js` (new) | `ready`/`waitMs`/`reserve`/`seed`, jitter drawn once per reserve, upward-only setting read at call time; `test/broadcaster.test.js` passes unchanged (RT-111) |
| `test/schema.test.js` (new) | `shape` and `unique`, dotted paths, `$unknown` per level, no echo; parity: every existing panel schema gives the same result through `request.js#validate` (RT-120), `SchemaError` re-thrown as `AdminError` |
| `test/api-state.test.js` (data-model.md owns the rows) | plus: `setEnabled` alias `set`, listeners isolated, `plainHttpFrom` read per request by `transport.js` |
| `test/api-registry.test.js` (new) | every `ApiRegistryError` of 15.4 names the endpoint; `createApi().state().failure` with a broken temp module and nothing served (RT-131); rights catalogue and `routes()` shape; ambiguity check of the router; `requires()` outside `rights()` is a 500 |
| `test/api-keys.test.js` (new) | token shape and regex, `generateSecret` entropy and uniqueness, verification (unknown id costs the same, constant-time compare), cache invalidation on revoke applies to the very next request, load failure fails closed, write-behind (one write per 60 s, at once for a new origin, `version` untouched, no cache invalidation), `api_key_new_ip` never on the first origin, redactor built-in pattern also with no registered value and `registerEphemeral` |
| `test/api-ip-rules.test.js` (new) | the fixture `test/fixtures/api-ip-entries.json`, `covers`, `isPrivateRange`, `privateOnly`, matching on the full address |
| `test/api-transport.test.js` (new) | `isLocalRequest` (untrusted loopback proxy with `X-Forwarded-*` is not local; trusted loopback forwarding a public client is not), `clientAddress` versus `originKey`, `plainHttpFrom` widened and narrowed between two requests, non-private entry dropped (fail closed) |
| `test/api-lifecycle.test.js` (new) | `boot.test.js` fakes: `messaging` in `ENGINES` between `broadcaster` and `alerts`, `apiState` loaded before `dbReady`, a failing messaging start does not stop the boot, `ADMIN_PANEL=false` builds no API and cancels leftover `queued` rows; `createPanelServer` tries `api.handle` before `admin.handle`; switch off cancels and holds no timer or listener |
| existing tests edited | `test/boot.test.js` (`:215-262,540-600`: engine list, hard requires), `test/hooks.test.js` (`:476-490` rows for `apireplies.js`), `test/capture-sites.test.js` (a changed spacing, quota, expiry or reply window applies to the next message and not to queued rows; static scan: no top-level `= config.` in `lib/api/**`, `lib/messaging/**`, `lib/utils/apiState.js`), `test/panel-legacy.test.js:320` (`/api/v1/messages` and `/api/v1/openapi.json` rows), `test/admin-logging.test.js` (walkers cover `lib/api/**` and `lib/messaging/**`), `test/admin-memory.test.js` and `tools/panel-memory-child.js` (`MODES` gains `api-off`, `api-on`; SC-011: `require("./lib/admin")` leaves `urlFetch`, `file-type`, `sharp`, the converters and the button helper unloaded and creates no timer; `api-on` minus `api-off` < 20 MiB RSS), `test/pipeline.test.js` (the `sentIds` guard), `test/permissions.test.js` and the 003 service tests (`parsePhoneNumber`, unchanged), the `knownChats`, sticker and buttons tests (moved helpers, builders parity with today's `sendQuickReplies` and `sendList` payloads, fallback still sends one plain message) |
| manual (SC-004, quickstart "Phone checklist") | every format on a real phone, buttons on a phone that hides them and a numbered answer, quote bubble with the empty shell, LID-group mention rendering, poll vote voter forms (PN chat and LID group) and multiple-answer semantics, flat voice waveform, the negative-ack code of a restricted account, interactive size limits |

---

## 19. Docs to update

| File | Change |
| ---- | ------ |
| `CLAUDE.md` | Architecture: `lib/messaging/` and `lib/api/` paragraphs (facade, outbox, formats, the API pipeline, hook-only `apireplies.js` priorities 5 and 6, `sentIds` guard as the pipeline's only 004 change); `lib/utils/` list: `sendGate.js`, `schema.js`, `apiState.js`, `stickerMaker.js`; engines list: `messaging`; `settingsCache` key `api_keys`; Settings: "101 entries" to 112 and the `apiState` exception; Database: the four tables and the `EXCLUDED_MODELS` sentence; i18n fragments `specs/004-messaging-api/i18n/`; "Commands": `OWB_NO_CONFIG_ENV=1` already stated |
| `lib/utils/settingsCache.js` header (`:8-11`) | add `api_keys` |
| `docs/PLUGIN_CREATION_DOC.md`, `.github/copilot-instructions.md` | none (no command) |
| `docs-site/` | none (unrelated to the runtime) |

---

## 20. Points settled while writing this contract

| # | Question | Settled as | Why |
| - | -------- | ---------- | --- |
| 1 | Facade method names (B: `enqueue`, `getMessage`; A: `submit`, `get`; C: `cancelForKey`, `stats`, `sweepMedia`) | A and C's names; `enqueue` is internal | one name per concept in section 1 |
| 2 | B's injected `keyGuard` | the pick step reads `ApiKey` by primary key, uncached | removes a cross-layer injection (`lib/messaging` may not require `lib/api`); one query per send; it also serves the key-expired-by-date case |
| 3 | Where the media file is adopted | `submit({ media })` moves (API) or copies (panel upload) the temp file into `data/api-media/<publicId>/source`; no `ctx.file.adopt(dest)` | `publicId` is minted by the engine at acceptance (data-model.md 2.3), so the caller cannot name the destination; the pipeline's `finally` still removes an unadopted `.part` |
| 4 | Policy mode name in the engine | `list`, `known`, `any`; the key store maps stored `anyone` to `any` (data-model.md 1.1) | the stored name is C/D's; the engine's is B's |
| 5 | Bot's own number at send time | `failed / send_failed` | no new failure code (public-api.md 4.3 lists the 14) |
| 6 | Head-of-line blocking by a transient verify error | the row is deferred 15 s in memory and the next oldest is tried | B3 would have retried the same head until expiry |
| 7 | Where `repliesUntil` is set | at T3 (`sentAt + window`) and T8 (`endedAt + window`), per data-model.md 2.1; `describeResponses.until` is null before the send | follows the data model, not B's claim-time proposal |
| 8 | Poll vote replace | single UPDATE guarded by `respondedAt <= :t`, then INSERT, unique index as the arbiter, no lock (data-model.md 3.2) | replaces C's delete-then-insert under `withLock` |
| 9 | Vote decryption | the exported `decryptPollVote` of `baileys` with candidate JID pairs | B called it hand-written; the function is exported (`Utils/process-message.js:146`) and tested by the spike's round trip |
| 10 | `media` is both a body object (`{ url }`) and a `submit` parameter | the body key is the marker (stripped by `validateInput`); the parameter is the staged file descriptor | public-api.md names the body field `media.url`, admin-api.md names the `submit` parameter `media` |
| 11 | Pagination of `list` | keyset on `after`/`next` (public-api.md 2.3) | the engine returns `next` as the last item's `publicId` when more exist |
| 12 | `api_disabled` from `submit` | defensive, not in `MESSAGING_STATUS` or `API_STATUS`; the panel maps it | public-api.md's error rows are exactly those two tables |
| 13 | Footer and header of interactive messages | none | the plugin's default footer `OpenWhatsappBot` would brand the owner's business messages |
| 14 | Name of the key store file | `lib/api/keyStore.js` | the brief and admin-api.md say `keyStore`; A's `keys.js` is dropped |
| 15 | Link-preview fetch time | at send time, in `text.prepare` | the engine already owns the send-time work; the 5 s budget cannot stall an accept |

## 21. Inconsistencies between sources

Reported, not decided here (the orchestrator or the owning contract settles them):

| # | Sources | Inconsistency | Treatment in this contract |
| - | ------- | ------------- | -------------------------- |
| 1 | data-model.md 4 vs admin-api.md 1.2, 1.3 and API-2 | `plainHttpFrom` capped at **20** entries (data-model) versus **50** (admin-api, `State.plainHttpFrom`, limits, schema) | 13 defers to data-model.md 4 for the cap; admin-api.md must follow or data-model must be raised to 50 |
| 2 | data-model.md 0.4 vs the brief | the usage-column writer is `lib/api/keys.js` in data-model, `keyStore` in the brief and admin-api | `lib/api/keyStore.js` (settled 14) |
| 3 | data-model.md 7 and A3 (`ctx.file.adopt(dest)`) | adoption by the pipeline versus by the engine | settled 3; data-model.md 7's table row "stream A: ... `ctx.file.adopt(dest)`" and the "refused after `adopt`" row should read "`submit` moves the file" |
| 4 | data-model.md 2.6 `input` (`displayName`, `rows`, `mentions` as PN JIDs) vs public-api.md 3.6, 3.9 | field names differ (`contacts[].name`, `choices`) | public-api.md wins (data-model.md says so); `normalize` stores PN digits for `mentions` and phones |
| 5 | research C1 (`ApiKey.secretHash` unique, no `lookupId`) vs A4 | the lookup id column | data-model.md 1.1 already adds `lookupId`; nothing to do here |
| 6 | research B (`data/api-outbox`, `payload.json`) vs C and data-model.md | stage name and payload location | `data/api-media`, `payload` column |
| 7 | admin-api.md 1.8 (`resumesAt`) vs C6 | `api_paused` payload field | `resumesAt` |
| 8 | C6 (`api_key_new_ip` 1 h per key) vs X9 | slot | X9: per key and IP, 24 h |
| 9 | B3 line `:1308` | the default engine is built at `:1306` | cited `:1306` |
| 10 | B's `API_QUEUE_TTL_MS`, `API_MIN_SPACING_MS`, `API_MAX_QUEUE` | names | X2's `API_QUEUE_EXPIRY_MIN`, `SEND_MIN_SPACING_MS`, `API_QUEUE_MAX` |
| 11 | research A4 (`api_new_ip`) | alert type name | X9 `api_key_new_ip` |
| 12 | code vs FR-057 | `plugins/buttons.js` adds the numbered text only in its failure fallback | the builders gain `numbered: true`, used by the API only; existing behaviour unchanged |
| 13 | Baileys rc14 `Socket/messages-recv.js:1511-1520` | `463` is "missing privacy token, usually account restricted", Baileys does not retry | U5's pause on any `463` is kept; whether one contact's missing token should pause the whole queue is a phone/field question (quickstart) |
