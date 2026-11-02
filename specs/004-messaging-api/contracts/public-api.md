# Contract: public messaging API (`/api/v1`)

Feature `004-messaging-api`. Inputs: [spec.md](../spec.md) (FR-001 to FR-094), [research.md](../research.md) (**authoritative**: U1-U15 and X1-X22 override the stream files), [research/a-http-security.md](../research/a-http-security.md) (A1-A10), [research/b-messaging-engine.md](../research/b-messaging-engine.md) (B1, B2, B4, B7 and its interfaces). Siblings: [../data-model.md](../data-model.md) (keys, messages, responses, `ApiState`), [runtime.md](runtime.md) (engine, outbox, boot wiring, settings), [admin-api.md](admin-api.md) (panel routes API-1..API-13 and AUTH-7, key lifecycle), [panel-ui.md](panel-ui.md).

This file is what an external caller and the API tests rely on. It describes the key-authenticated HTTP surface only; no panel route is described here and the panel session never opens it (FR-004). Server code: `lib/api/**` (HTTP layer) and `lib/messaging/**` (engine and formats); the HTTP layer never reaches WhatsApp itself, it hands accepted messages to the engine (`engine.submit`).

## Machine-read format (for `test/api-contract.test.js`)

The test reads this file and compares it with the live registries, so documentation, code and OpenAPI cannot drift. Parsers (flags `gm`), each applied to the slice of text between two level-2 headings given as `^## <n>\. ` line starts:

```text
slice 2 -> 3   endpoint row   ^\| (PUB-\d+) \| `([A-Z]+) (\/[^`?]*)`
slice 2 -> 3   right row      ^\| `([a-z][a-z0-9_.]*)` \| (send|read|media|docs) \|
slice 3 -> 4   format row     ^\| `([a-z_]+)` \| (\d+) \| `(messages\.send\.[a-z_]+)` \|
slice 3 -> 4   example block  ^```json example=([a-z_]+)$ ... ^```$
slice 4 -> 5   status row     ^\| `(queued|sending|sent|delivered|read|failed|expired|cancelled|unknown)` \|
slice 4 -> 5   failure row    ^\| `([a-z_]+)` \| `(failed|cancelled|unknown)` \|
slice 6 -> 7   error row      ^\| `([a-z_]+)` \| (\d{3}) \|
```

Checks: endpoint rows equal `api.routes()` (method, path, rights; `<format>` expands to the 13 format names); right rows equal `api.rights()`; format rows equal `formats.list()` (name, `order`, right); every example block, posted through the harness (for a format with media the block is the `message` part and the harness attaches a generated sample file of an accepted type), answers `202` for a key holding the needed rights with policy "anyone"; status rows equal the nine statuses of `MessageStatus`; failure rows equal the `FailureCode` enum with its status; error rows equal `API_STATUS` plus `MESSAGING_STATUS` (code and HTTP status, nothing more, nothing less). Format guarantees of this file: no other row of a slice starts with the pattern of that slice, each of the headings `## 2.` to `## 7.` appears once as a line start, and no prose spells a heading with its leading hashes.

---

## 1. Transport, authentication, headers

### 1.1 Base path and version

All endpoints live under `/api/v1`. The version is the first path segment; `v1` keeps working when `v2` appears (FR-005). Paths are matched exactly: a trailing slash, a different case, a doubled slash or an `:id` that does not match `^msg_[A-Za-z0-9_-]{22}$` is `404 not_found`. The API is served by the same HTTP server as the panel, on the same port; it exists only when the panel exists (FR-007) and is claimed only while the API switch is on (section 9).

### 1.2 Transport

- **HTTPS is required** (FR-003). A request is accepted when any of these holds (step 3 of section 5):
  1. the socket is encrypted, or a trusted proxy declares `X-Forwarded-Proto: https` (same `PANEL_TRUST_PROXY` setting as the panel; the right-most value counts);
  2. it is a **local request**: the TCP peer is loopback, no untrusted `X-Forwarded-*` header is present, and the effective client address is loopback. The host's own interface addresses are deliberately not local;
  3. (research.md U1) the effective client address is inside the `plainHttpFrom` list of `ApiState`. Entries are private ranges only (RFC 1918, ULA `fc00::/7`, CGNAT `100.64.0.0/10`); the list is **empty by default**; the panel asks for the password to widen it. The effective client address is the TCP peer, or the forwarded address when the peer is a trusted proxy.
  Any other request, including every request that reaches the bot over plain HTTP from a public address, is `403 https_required` before the key is read or hashed.
- Caveat for operators (documented on the panel's API page): with a Docker published port, traffic from the Internet can reach the bot with the bridge gateway as its peer address. A wide entry such as the whole compose subnet would then admit it over plain HTTP; list the caller's own address (`/32`) instead.
- **No browser calls, no CORS** (FR-004). Any `Origin` or `Sec-Fetch-Site` header is `403 browser_not_allowed`; `OPTIONS` is `405`; no response ever carries `Access-Control-*`. A server-side client must not send `Origin`.
- The panel's cookie is never read and never set; a panel session alone gives `401 unauthenticated`. Conversely an API key presented to `/admin/api/**` is inert.
- Request bodies are UTF-8. Responses are `application/json; charset=utf-8` (errors included), uncompressed.
- Time: an ISO-8601 UTC string with milliseconds (`2026-11-02T10:15:30.123Z`). Absent values are `null`. Durations in params are milliseconds (`retryAfterMs`, header `Retry-After` in seconds).
- Strings are NFC-normalised and trimmed, then measured in Unicode code points (every limit below is in code points unless a unit is given). Unknown properties are refused, at every nesting level.

### 1.3 Authentication

`Authorization: Bearer owbk_<id>_<secret>` where `<id>` is 16 lowercase hex characters and `<secret>` 43 base64url characters (65 characters in all; scanners match `owbk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}`). The scheme name is case-insensitive; there must be exactly one `Authorization` header. The key is read **only** from that header: a key in the path, the query, the body, a cookie or another header (`X-API-Key`...) is never used (FR-016); a request whose URL contains a key-shaped string or a query parameter named `api_key`, `apikey`, `key`, `token`, `access_token` or `authorization` is refused `400 key_in_url` without parsing or hashing it.

The secret is shown once when the owner creates the key in the panel (stored irreversibly, see [../data-model.md](../data-model.md)). Every key has its own rights (section 2.5), recipient policy, limits, optional IP allowlist and optional expiry, all managed in the panel. A new key has no right at all; a right added by a later endpoint or format is granted to no existing key (FR-011).

### 1.4 Headers

Request headers:

| Header | Where | Rule |
|---|---|---|
| `Authorization` | all | section 1.3 |
| `Content-Type` | PUB-1 | `application/json` (optional `; charset=utf-8`) or `multipart/form-data; boundary=...`; anything else `415 unsupported_media_type` |
| `Idempotency-Key` | PUB-1 | `^[A-Za-z0-9._:-]{1,80}$`, scoped by API key (section 7.4); malformed: `422 validation_failed` with `fields["idempotency-key"] = { code: "invalid_format" }` |
| `Prefer`, `X-Request-Id`, `Accept`, `X-HTTP-Method-Override` | all | ignored (a client-sent request id is replaced; the server always answers JSON) |
| `Origin`, `Sec-Fetch-Site` | all | refused (section 1.2) |
| `Cookie` | all | never read |

Response headers (every answer, errors and `404`s of claimed paths included):

| Header | Value |
|---|---|
| `X-Request-Id` | 16 hex characters, also in `error.requestId` and in the operator's logs (FR-094); quote it in a support request |
| `Cache-Control` | `no-store` |
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Location` | PUB-1 `202`, relative: `/api/v1/messages/<id>` (also on a replay) |
| `Idempotent-Replayed` | `true`, only on a PUB-1 replay |
| `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` | PUB-1 answers produced after step 9 of section 5 (the key is authenticated), including `429`: the per-minute window of the key. `Remaining` = acceptances still allowed in the sliding 60 s window; `Reset` = whole seconds until the oldest counted acceptance leaves the window (`0` when the window is empty) |
| `Retry-After` | whole seconds, at least 1, on `429`, on `503`, and whenever `params.retryAfterMs` exists (`ceil(retryAfterMs / 1000)`) |
| `WWW-Authenticate` | `401`: `Bearer realm="owb-api"` for `unauthenticated`, `Bearer realm="owb-api", error="invalid_token"` for `key_revoked` and `key_expired` |
| `Allow` | `405` produced by the route table (step 10) only |
| `Connection` | `close` on every refusal produced before the request body was consumed |
| `Deprecation`, `Sunset` | endpoints declared deprecated (section 10) |

Never present: `Access-Control-*`, `Set-Cookie`, `Strict-Transport-Security` (the proxy terminates TLS), `Permissions-Policy`, `X-Frame-Options`, any header carrying a secret.

---

## 2. Endpoints

Every endpoint declares a right; an endpoint without one cannot be registered and, if the registry fails at boot, no endpoint is served (FR-090, section 9). There is no public endpoint. v1 has four.

| Id | Endpoint | Right | Registry id | Body | Success |
|---|---|---|---|---|---|
| PUB-1 | `POST /api/v1/messages` | `messages.send.<format>`; plus `media.url` when `media.url` is given or `linkPreview` is `true` | `messages.create` | JSON or multipart | `202` `{ message }` + `Location` |
| PUB-2 | `GET /api/v1/messages/:id` | `messages.read` | `messages.get` | none | `200` `{ message }` |
| PUB-3 | `GET /api/v1/messages` | `messages.read` | `messages.list` | none | `200` `{ messages, next }` |
| PUB-4 | `GET /api/v1/openapi.json` | `api.docs` | `openapi.get` | none | `200` OpenAPI 3.1 document |

Not in v1 (each would be one more module, section 10): base64 media, several recipients per request, webhooks, reading received messages, reactions, edits, deletions, group management, key introspection.

### 2.1 PUB-1 `POST /api/v1/messages`: send one message

Request: body per section 3; headers `Idempotency-Key` (optional, recommended), `Content-Type`; query:

| Query | Type | Default | Rule |
|---|---|---|---|
| `wait` | integer seconds | `0` | `0` to `30`. Decimal digits only (`wait=30`; `true` is `invalid_format`, `31` is `out_of_range` with `params { min: 0, max: 30 }`). The `Prefer: wait=` header is **not** honoured. Not part of the idempotency fingerprint |

Behaviour:

- Success is always `202 Accepted` with `Location` and `{ "message": <Message> }` (section 4.1), at once with `status: "queued"` (SC-010: under one second for a text, not counting an upload or a URL download). The HTTP status never encodes the message status: a message that fails after acceptance is still a `202`.
- With `wait=N` the answer is held until the message reaches `sent`, `failed`, `expired`, `cancelled` or `unknown`, or until `N` seconds after acceptance, whichever comes first, and carries the status of that moment (FR-033). `delivered` and `read` never end a wait. A caller that disconnects only abandons the wait; the message stays queued. At most 200 waits are held at once process-wide; beyond that the answer is immediate with the current status (not an error). The wait applies to a replay as well. With `media.url` the request may last up to 30 s (download) plus `N`: use a client timeout of at least 65 s.
- Idempotent (section 7.4), quota-bearing (section 7.1). A replay answers `202` with the stored message in its current state, `Idempotent-Replayed: true`, no quota, no validation of the body, no second send.
- Errors specific to this endpoint: `forbidden` (right named in `params.right`), `recipient_not_allowed`, `chat_disabled`, `idempotency_conflict`, `rate_limited`, `daily_quota_exceeded`, `pending_limit_reached`, `queue_full`, `payload_too_large`, `media_too_large`, `unsupported_media_type`, `validation_failed`, `media_type_mismatch`, `url_forbidden`, `url_unreachable`, plus the common ones of section 6.

### 2.2 PUB-2 `GET /api/v1/messages/:id`: status of one message

`:id` is the `id` returned by PUB-1. Returns `200 { message }` with every step reached, the failure code if any and, for buttons, lists and polls, the responses collected so far. The message of another key, of the panel, one that never existed and one purged by the retention job (`API_RETENTION_DAYS`, 30 by default) are all the same `404 not_found` (US3.4). No `wait` here (the wait lives on PUB-1).

### 2.3 PUB-3 `GET /api/v1/messages`: own messages

Lists the messages of the calling key, newest first (order of acceptance). Never returns the messages of another key or of the panel.

| Query | Type | Default | Rule |
|---|---|---|---|
| `status` | string | all | one of the nine statuses (`not_allowed` with `allowed`) |
| `format` | string | all | one of the 13 formats |
| `since` | RFC 3339 timestamp | none | inclusive lower bound on `steps.queued` (`...Z` or `+hh:mm`) |
| `until` | RFC 3339 timestamp | none | exclusive upper bound; `until <= since` is `out_of_range` on `until` |
| `limit` | integer | `25` | `1` to `100` |
| `after` | string | none | the `next` value of the previous page (a message id of this key) |

Answer: `200 { "messages": [Message], "next": "msg_..." | null }`. `next` is the id of the last item when more items exist, else `null`; pass it as `after` to continue (keyset pagination: pages stay stable while new messages arrive). An `after` that is not a message of this key (unknown, purged, other key) is `422 validation_failed` with `fields.after = { code: "not_found" }`, the same answer in all three cases. A repeated query parameter keeps its first value; an unknown parameter is `unknown_field`. List items never carry `responses` (read PUB-2 for them).

### 2.4 PUB-4 `GET /api/v1/openapi.json`: machine-readable description

Returns the OpenAPI 3.1 document of section 10 (`200 application/json`). Needs the right `api.docs`, which is off for every new key; the owner can also download the same document from the panel without any key. English only (research.md U8).

### 2.5 Rights catalogue

A key holds a set of right ids. The catalogue is built from the registered endpoints and formats, so a new module appears here by itself (FR-092).

| Right | Group | Needed by |
|---|---|---|
| `messages.send.text` | send | PUB-1 with `format: "text"` |
| `messages.send.image` | send | PUB-1 with `format: "image"` |
| `messages.send.video` | send | PUB-1 with `format: "video"` |
| `messages.send.gif` | send | PUB-1 with `format: "gif"` |
| `messages.send.audio` | send | PUB-1 with `format: "audio"` |
| `messages.send.voice` | send | PUB-1 with `format: "voice"` |
| `messages.send.document` | send | PUB-1 with `format: "document"` |
| `messages.send.sticker` | send | PUB-1 with `format: "sticker"` |
| `messages.send.location` | send | PUB-1 with `format: "location"` |
| `messages.send.contact` | send | PUB-1 with `format: "contact"` |
| `messages.send.poll` | send | PUB-1 with `format: "poll"` |
| `messages.send.buttons` | send | PUB-1 with `format: "buttons"` |
| `messages.send.list` | send | PUB-1 with `format: "list"` |
| `messages.read` | read | PUB-2, PUB-3 |
| `media.url` | media | PUB-1 when `media.url` is present, or `linkPreview` is `true` (FR-043, FR-060) |
| `api.docs` | docs | PUB-4 |

---

## 3. Request bodies

### 3.1 Common rules

PUB-1 takes one object with `format` as the discriminator. Which fields exist depends on the format (3.2 onward); an unknown property is refused at its level (`$unknown`, 3.5). One recipient per request (FR-030).

| Field | Type | Required | Rule |
|---|---|---|---|
| `format` | string | yes | one of the 13 names of the table below; absent, not a string or unknown: `422 fields.format` (`required`, `invalid_type`, `not_allowed` with `allowed`) before any right is evaluated |
| `to` | string | yes | a **phone number with country code** (spaces, `+`, `-`, `.`, `(`, `)` and a leading `00` are ignored; 8 to 15 digits, not starting with `0`; same rules as feature 003) or a **group id** `^\d{5,25}(-\d+)?@g\.us$` as the panel shows it. Any other JID (a LID, `@s.whatsapp.net`) is `invalid_format`. The bot's own number is `not_allowed` (research.md U7). The value is never echoed |
| `quote` | string | no | the `id` of an earlier message **of the same key**, to the **same chat**, whose status is `sent`, `delivered` or `read` (it must have left). Anything else, including another key's message, a still queued message and a purged one, is `fields.quote = { code: "not_found" }` (research.md X4). The bubble may show no quoted text (nothing of the content is kept, research.md U13) |
| `idempotencyKey` | - | - | **not a body field**: send the `Idempotency-Key` header. In the body it is `unknown_field` |

The 13 formats (rows are the registry; `order` is the order of the documentation, the panel's rights editor and the test form):

| Format | Order | Right | Media | Caption | Replies captured |
|---|---|---|---|---|---|
| `text` | 10 | `messages.send.text` | no | n/a | no |
| `image` | 20 | `messages.send.image` | required | yes | no |
| `video` | 30 | `messages.send.video` | required | yes | no |
| `gif` | 40 | `messages.send.gif` | required | yes | no |
| `audio` | 50 | `messages.send.audio` | required | no | no |
| `voice` | 60 | `messages.send.voice` | required | no | no |
| `document` | 70 | `messages.send.document` | required | yes | no |
| `sticker` | 80 | `messages.send.sticker` | required | no | no |
| `location` | 90 | `messages.send.location` | no | n/a | no |
| `contact` | 100 | `messages.send.contact` | no | n/a | no |
| `poll` | 110 | `messages.send.poll` | no | n/a | yes (votes) |
| `buttons` | 120 | `messages.send.buttons` | no | n/a | yes (taps, numbers) |
| `list` | 130 | `messages.send.list` | no | n/a | yes (taps, numbers) |

Every format below lists only its own fields, in addition to `format`, `to` and `quote`. The example blocks are executable (the contract test posts them).

### 3.2 Text

| Field | Type | Required | Rule |
|---|---|---|---|
| `text` | string | yes | 1 to 4,096; sent as given (apart from the trimming of section 1.2), never interpreted as a command whatever its first characters (FR-039, US1.7) |
| `mentions` | array of string | no | at most 50 phone numbers (rules of `to`); **groups only** (`not_allowed` on a private chat). The text refers to a person as `@<number>` in digits. Numbers that are not members are ignored and the text is left untouched |
| `linkPreview` | boolean | no, `false` | `true` needs the right `media.url`; see section 8.2. No link of a text is ever fetched otherwise (FR-043) |

```json example=text
{ "format": "text", "to": "237690000001", "text": "Hello Awa, your order #4821 has shipped. Tracking: https://track.example.com/4821" }
```

### 3.3 Media formats: `image`, `video`, `gif`, `audio`, `voice`, `document`, `sticker`

Fields besides the media itself:

| Field | Formats | Type | Rule |
|---|---|---|---|
| `caption` | image, video, gif, document | string | 1 to 1,024 (an empty string is `too_short`) |
| `fileName` | document | string | 1 to 255; sanitised to a base name (separators and control characters become `_`, spaces collapsed, leading dots dropped, at most 100 characters, extension kept). Default: the `filename` of the multipart file part, else `file` plus the extension of the detected type. The name is only a label: the content is sent with the type detected from its bytes |
| `media` | all seven | object `{ "url": string }` | `url` 1 to 2,048 characters, a syntactically valid absolute URL (`invalid_format` otherwise), see 3.4 and section 8. Needs the right `media.url` |

**Sources.** Exactly one of: a `file` part of a multipart request, or `media.url` in JSON. Neither: `fields.media = { code: "required" }`. Both: `fields.media = { code: "not_allowed" }`. A file part on a format without media: `fields.file = { code: "not_allowed" }`. No base64 in JSON (FR-051 clarification).

**Content is judged by its bytes** (FR-052): the declared `Content-Type`, the `filename` and the extension are ignored. Accepted content, caps and processing per format (MB = 1,048,576 bytes; the effective cap is `min(format cap, MAX_UPLOAD)` read at request time, and reception stops as soon as it is exceeded, whatever `Content-Length` says):

| Format | Accepted content (detected) | Cap | Processing |
|---|---|---|---|
| `image` | JPEG, PNG, WebP | 16 MB | as is |
| `video` | MP4, QuickTime (MOV), 3GP | 16 MB | as is |
| `gif` | GIF, MP4, MOV | 16 MB in and out | a GIF is converted to a looping MP4 (`gifPlayback`); MP4/MOV sent as is |
| `audio` | MP3, Ogg (Opus included), M4A, WAV, FLAC, AAC, AMR; not WebM | 16 MB | as is, sent as an audio file |
| `voice` | every `audio` type, plus WebM and MP4 (the audio track is extracted) | 16 MB | converted to Ogg/Opus and sent as a voice note (flat waveform) |
| `document` | PDF, ZIP, legacy Office (`.doc` `.xls` `.ppt`), OOXML (`.docx` `.xlsx` `.pptx`), OpenDocument (`.odt` `.ods` `.odp`), plain text, CSV; **never an executable** (research.md U6, the broadcast whitelist) | 100 MB | as is |
| `sticker` | JPEG, PNG, WebP | 10 MB in, 900 KB out | converted to a 512 x 512 WebP sticker with the bot's pack and author |

Errors: wrong content `422 media_type_mismatch` with `params { expected }` (kind names such as `image`; the detected type is never echoed; the file is discarded at once); over the cap `413 media_too_large` with `params { maxBytes }`; a conversion that fails after acceptance (unreadable audio, corrupt image) is not an HTTP error: the message ends `failed` with `media_conversion_failed` (FR-058). The staged file is deleted when the message ends, whatever the outcome (FR-075).

```json example=image
{ "format": "image", "to": "237690000001", "caption": "Your receipt" }
```

```json example=video
{ "format": "video", "to": "120363025246125486@g.us", "caption": "Training session of Saturday" }
```

```json example=gif
{ "format": "gif", "to": "237690000001", "caption": "Done!" }
```

```json example=audio
{ "format": "audio", "to": "237690000001" }
```

```json example=voice
{ "format": "voice", "to": "237690000001" }
```

```json example=document
{ "format": "document", "to": "237690000001", "caption": "Invoice 2026-0042", "fileName": "invoice-2026-0042.pdf" }
```

```json example=sticker
{ "format": "sticker", "to": "237690000001" }
```

The six examples above are the JSON part (`message`) of a multipart request, see 3.4; with a URL instead of a file the same object gets `"media": { "url": "https://files.example.com/receipt.jpg" }` and is sent as plain JSON.

### 3.4 Sending a file: multipart and URL

**Multipart** (`Content-Type: multipart/form-data; boundary=<1 to 70 characters>`): exactly these parts, in this order.

1. `message`: the JSON object of the format, as text (any part `Content-Type` or none, so that tools which send a plain text field work). At most 64 KiB.
2. `file`: the media (absent for formats without media and when `media.url` is used).

Grammar limits (violations are `400 bad_request`): at most two parts; each part header block at most 4 KiB with only `Content-Disposition: form-data; name="..."[; filename="..."]` and an optional `Content-Type`; no duplicate or folded header; no `Content-Transfer-Encoding`; a closing boundary is required; a preamble of at most 1 KiB. A `file` part before `message` is `422` with `fields.file = { code: "invalid_order" }` (the right and the size cap depend on the first part). Concurrency: at most 2 uploads in flight per key and 4 in total (`429 rate_limited`, `scope: "uploads"`, `Retry-After: 5`); pending media bytes beyond twice `MAX_UPLOAD` are `503 queue_full`, `scope: "disk"`, `Retry-After: 5`; a pause of 30 s without a byte ends the upload. Size checks: a declared `Content-Length` above `64 KiB + min(MAX_UPLOAD, 100 MB) + 16 KiB` is `413 media_too_large` (`maxBytes` = that file bound) before anything is read; once the `message` part is read, a `Content-Length` above `message bytes + format cap + 16 KiB` is `413 media_too_large` with the format cap; a body streamed without `Content-Length` is cut as soon as the cap plus 64 KiB is read. In every case the partial file is deleted.

```text
curl -X POST "https://bot.example.com/api/v1/messages?wait=30" \
  -H "Authorization: Bearer $OWB_KEY" \
  -H "Idempotency-Key: invoice-2026-0042" \
  -F 'message={"format":"document","to":"237690000001","caption":"Invoice 2026-0042","fileName":"invoice-2026-0042.pdf"};type=application/json' \
  -F 'file=@invoice-2026-0042.pdf;type=application/pdf'
```

**URL** (`media.url`, JSON request, right `media.url`): the bot downloads the file during the request (FR-061) under the rules of section 8.1, checks its content and cap exactly as for an upload, then queues the message. The caller therefore learns at once whether the media is refused.

### 3.5 Location

| Field | Type | Required | Rule |
|---|---|---|---|
| `latitude` | number | yes | -90 to 90 |
| `longitude` | number | yes | -180 to 180 |
| `name` | string | no | 1 to 256 |
| `address` | string | no | 1 to 256 |

```json example=location
{ "format": "location", "to": "237690000001", "latitude": 4.0511, "longitude": 9.7679, "name": "Pickup point", "address": "Rue de la Joie, Douala" }
```

### 3.6 Contact

| Field | Type | Required | Rule |
|---|---|---|---|
| `contacts` | array of card | yes | 1 to 10 cards (one card sends a contact message, several send a contact array) |
| `contacts[].name` | string | yes | 1 to 128, the displayed name |
| `contacts[].phones` | array of string | yes | 1 to 5, each a phone number with country code (rules of `to`, group ids refused), distinct within the card |
| `contacts[].organization` | string | no | 1 to 128 |
| `contacts[].email` | string | no | 1 to 254, `local@domain.tld` shape |

The bot builds the vCard itself from these fields; the caller never sends raw card text, and `;` `,` backslash and line breaks inside values are escaped so no value can add a property (FR-055).

```json example=contact
{ "format": "contact", "to": "237690000001", "contacts": [ { "name": "Acme Support", "phones": ["+237 690 00 00 02"], "organization": "Acme", "email": "support@acme.example" } ] }
```

### 3.7 Poll

| Field | Type | Required | Rule |
|---|---|---|---|
| `question` | string | yes | 1 to 255 |
| `options` | array of string | yes | 2 to 12 entries of 1 to 100 characters, distinct after trimming (case-sensitive); a repeat is `fields["options.2"] = { code: "duplicate" }` |
| `multiple` | boolean | no, `false` | `true` lets a voter pick several options |

```json example=poll
{ "format": "poll", "to": "120363025246125486@g.us", "question": "Which day for training?", "options": ["Tuesday", "Thursday", "Saturday"], "multiple": false }
```

### 3.8 Buttons

| Field | Type | Required | Rule |
|---|---|---|---|
| `text` | string | yes | 1 to 1,024. The message actually sent is this text followed by the numbered version of the buttons and a hint line (FR-057); the composed body must stay within 4,096, else `fields.text = { code: "too_long", params: { max: 4096 } }` |
| `buttons` | array of button | yes | 1 to 3 |
| `buttons[].id` | string | yes | `^[A-Za-z0-9_.-]{1,64}$`, distinct in the array (`duplicate` at `buttons.N.id`); the caller's own id, returned in `responses` |
| `buttons[].label` | string | yes | 1 to 20 |

```json example=buttons
{ "format": "buttons", "to": "237690000001", "text": "Do you confirm your appointment tomorrow at 10:00?", "buttons": [ { "id": "confirm", "label": "Yes" }, { "id": "cancel", "label": "No" } ] }
```

### 3.9 List

| Field | Type | Required | Rule |
|---|---|---|---|
| `text` | string | yes | 1 to 1,024, composed body within 4,096 as for buttons |
| `buttonLabel` | string | yes | 1 to 20, the label of the button that opens the list |
| `choices` | array of choice | yes | 1 to 10 |
| `choices[].id` | string | yes | same pattern as a button id, distinct in the array |
| `choices[].title` | string | yes | 1 to 24 |
| `choices[].description` | string | no | 1 to 72 |

```json example=list
{ "format": "list", "to": "237690000001", "text": "Choose a delivery slot", "buttonLabel": "See slots", "choices": [ { "id": "slot-am", "title": "Morning", "description": "8:00 - 12:00" }, { "id": "slot-pm", "title": "Afternoon", "description": "14:00 - 18:00" } ] }
```

Buttons and lists are native on phones that show them and a numbered text on those that do not; a reply by number must quote the message. Limits above are rejected, never truncated.

### 3.10 Validation rules common to all formats

- Strict schema: every fault of the request is listed at once in `fields`, nested faults under dotted paths (`buttons.1.id`, `contacts.0.phones.2`, `options.2`); an unknown property is `fields["<path>.$unknown"] = { code: "unknown_field" }` (`$unknown` alone at the top level). The unknown property's name and any submitted value are never echoed.
- Evaluation is staged (section 5): problems with `format`, then with `to`, are returned alone and early because the right and the recipient policy depend on them; `quote`'s existence is checked after the schema passes. Everything else is reported together.
- A query parameter is validated with the body (names are disjoint), so a bad `wait` appears in `fields` next to body faults. Query values arrive as strings: an integer parameter that is not decimal digits is `invalid_format`, outside its bounds `out_of_range`; a repeated parameter keeps its first value.

---

## 4. The message resource

### 4.1 Shape

Returned by PUB-1 (inside `{ message }`), PUB-2 and PUB-3 (inside `{ messages }`). Content is never returned: no text, caption, file, question or option text of a message that is not interactive.

| Field | Type | Notes |
|---|---|---|
| `id` | string | public id `msg_` + 22 base64url characters (128 random bits); the only identifier a caller uses |
| `format` | string | one of the 13 |
| `to` | string | normalised: digits of the number, or the group id |
| `chatType` | string | `private` or `group` (`delivered` and `read` exist for private chats only) |
| `status` | string | section 4.2 |
| `size` | integer or null | bytes of the media as received; for formats without media the UTF-8 byte length of the main text (`text` for text, buttons and list; `question` for poll); `null` for location and contact |
| `requestId` | string | the `X-Request-Id` of the request that created it |
| `steps` | object | `queued`, `sending`, `sent`, `delivered`, `read`: the time each was reached, `null` before; `queued` is the acceptance time |
| `expiresAt` | string | acceptance + queue expiry (`API_QUEUE_EXPIRY_MIN`, 10 min by default): after this instant a message that has not been sent can never be sent |
| `endedAt` | string or null | set with `failed`, `expired`, `cancelled` or `unknown`; `null` again if an `unknown` message is later upgraded by a receipt |
| `failure` | object or null | `{ "code": <FailureCode> }` when `status` is `failed`, `cancelled` or `unknown`; `null` otherwise (an `expired` message has no code: the cause is the expiry itself) |
| `responses` | object or null | PUB-1 and PUB-2 only: an object for `poll`, `buttons` and `list`, `null` for the other formats; omitted from PUB-3 items |

`responses` (4.4): `{ until, total, items, totals }`.

```json
{
  "message": {
    "id": "msg_Vx3k9QfL2mNvB7aRtYhZwc",
    "format": "text",
    "to": "237690000001",
    "chatType": "private",
    "status": "queued",
    "size": 82,
    "requestId": "9f2c4e1a7b3d5c60",
    "steps": { "queued": "2026-11-02T10:15:30.123Z", "sending": null, "sent": null, "delivered": null, "read": null },
    "expiresAt": "2026-11-02T10:25:30.123Z",
    "endedAt": null,
    "failure": null,
    "responses": null
  }
}
```

### 4.2 Status vocabulary (FR-070)

Nine statuses; the time of each step reached is in `steps`.

| Status | Meaning |
|---|---|
| `queued` | accepted, waiting for its turn in the paced queue |
| `sending` | claimed by the sender and being handed to WhatsApp; point of no return |
| `sent` | WhatsApp's server accepted it |
| `delivered` | reached the recipient's device (private chats, when WhatsApp reports it) |
| `read` | read by the recipient (private chats; a played voice note counts) |
| `failed` | not sent, or rejected by WhatsApp afterwards; see `failure.code` |
| `expired` | not sent within `expiresAt`; it is never sent later |
| `cancelled` | removed from the queue before sending: key revoked or expired, or the API switched off |
| `unknown` | the outcome is uncertain (restart or timeout while sending); **never resent**, so decide on your side whether to send again |

Transitions: `queued` to `sending`, `expired`, `cancelled` or `failed`; `sending` to `sent`, `failed` or `unknown`; `sent` or `unknown` to `delivered` then `read` (receipts, private chats only: a group message stops at `sent`). The only backward move is a negative acknowledgement from WhatsApp after the send, which turns `sent` or `unknown` into `failed` with `whatsapp_rejected`. A message that is `sent`, `failed`, `expired`, `cancelled` or `unknown` no longer holds any content on the server.

### 4.3 Failure codes (message level)

Not HTTP errors: they appear only in `failure.code` of an already accepted message.

| Code | Status | Meaning |
|---|---|---|
| `not_on_whatsapp` | `failed` | the number does not use WhatsApp (checked before sending to a number the bot does not know); nothing was sent |
| `chat_disabled` | `failed` | the chat was disabled in the bot (`ban`) after the message was accepted |
| `not_in_group` | `failed` | the bot is no longer a member of the group |
| `group_announce_only` | `failed` | only administrators may write in the group and the bot is not one |
| `media_conversion_failed` | `failed` | the media could not be converted (unreadable audio or image, ffmpeg unavailable) |
| `payload_unavailable` | `failed` | the staged content disappeared (cleaned up); never sent as text only |
| `whatsapp_rejected` | `failed` | WhatsApp refused the message after the relay (negative acknowledgement); a restricted account also pauses the queue for 15 minutes (research.md U5) |
| `send_failed` | `failed` | the send was refused before leaving (content could not be built, upload to WhatsApp refused) |
| `key_revoked` | `cancelled` | the key was revoked while the message waited |
| `key_expired` | `cancelled` | the key expired while the message waited |
| `api_disabled` | `cancelled` | the owner switched the API off while the message waited |
| `interrupted` | `unknown` | the bot stopped while the message was being sent |
| `timeout` | `unknown` | WhatsApp did not answer in time |
| `connection_closed` | `unknown` | the connection dropped during the send |

The set is open to additions in v1 (a client treats an unknown code as a generic failure). The same list is the `FailureCode` enum of the OpenAPI document.

### 4.4 Responses of interactive messages (FR-072, research.md U2)

Collected for `poll`, `buttons` and `list` during `API_REPLY_WINDOW_DAYS` (7) after `steps.sent`; a reply after that is consumed by the bot (no other feature reacts to it) but not recorded. A tap on a button or row, a reply by number quoting the message, and a poll vote are recorded; nothing else is read. A message holds at most 1,000 responses (more are ignored).

| Field | Type | Notes |
|---|---|---|
| `until` | string or null | end of the collection window; `null` until the message is sent |
| `total` | integer | number of `items` |
| `items` | array | oldest first: `{ at, author, kind, via, choices }` |
| `items[].at` | string | time of the reply |
| `items[].author` | string | the replier: digits of the phone number, or `<number>@lid` when WhatsApp gave only a privacy identifier |
| `items[].kind` | string | `choice` (buttons, list) or `vote` (poll) |
| `items[].via` | string or null | `tap` or `number` for a choice, `null` for a vote |
| `items[].choices` | array | `{ id, label }`: for buttons and lists the caller's `id` and the button label or row title; for a poll the zero-based option index as a string (`"0"` to `"11"`) and the option text. Labels are the short texts kept for the retention period (<= 100 characters) |
| `totals` | array or null | poll only, one entry per option in order: `{ id, label, count }`, zero counts included; `null` for buttons and lists |

A poll has one item per voter: the voter's latest vote replaces the earlier one; a vote that was cleared stays as an item with `choices: []`. Buttons and lists append one item per reply (a person who taps twice yields two). The voter forms WhatsApp uses for polls are settled on a real phone (research.md section 3).

```json
{
  "responses": {
    "until": "2026-11-09T10:15:42.000Z",
    "total": 2,
    "items": [
      { "at": "2026-11-02T11:02:10.000Z", "author": "237690000002", "kind": "vote", "via": null, "choices": [ { "id": "1", "label": "Thursday" } ] },
      { "at": "2026-11-02T11:05:44.000Z", "author": "237690000003", "kind": "vote", "via": null, "choices": [ { "id": "0", "label": "Tuesday" }, { "id": "2", "label": "Saturday" } ] }
    ],
    "totals": [
      { "id": "0", "label": "Tuesday", "count": 1 },
      { "id": "1", "label": "Thursday", "count": 1 },
      { "id": "2", "label": "Saturday", "count": 1 }
    ]
  }
}
```

---

## 5. Request pipeline

`dispatch` never throws and always ends the response. The first failing step answers. Steps 7 to 9 are the only ones that **count toward blocking the origin** (spec US1.5); a plain-HTTP, browser, key-in-URL, right, policy, quota, validation or media refusal never does, so a mis-configured but valid key cannot lock its own network out. Everything before step 10 happens whatever the path (an unauthenticated caller cannot enumerate routes).

| Step | What is checked | Failure: HTTP `code` | Counts |
|---|---|---|---|
| 1 | Gate: database not ready, or a backup restore running | 503 `unavailable`, `Retry-After: 5`; nothing read, nothing queued | no |
| 2 | Verb is one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE` (so `OPTIONS` and `HEAD` are refused) | 405 `method_not_allowed`, no `Allow`, no CORS header | no |
| 3 | Transport (section 1.2): encrypted or trusted-proxy HTTPS, local request, or client address in `plainHttpFrom` | 403 `https_required` | no |
| 4 | Browser call: any `Origin` or `Sec-Fetch-Site` header | 403 `browser_not_allowed` | no |
| 5 | Key in the URL (section 1.3) | 400 `key_in_url`; the key is never parsed, hashed or logged | no |
| 6 | Origin block (10 failures in 5 minutes block the origin for 15 minutes; applies to a valid key too; a blocked origin is not extended) | 429 `origin_blocked`, `Retry-After` | no |
| 7 | Authenticate: one `Authorization: Bearer` header, shape check, lookup by the embedded id, constant-time comparison of the secret hash (an unknown id costs the same). Missing, malformed, unknown id and wrong secret give the same answer | 401 `unauthenticated` | yes |
| 8 | Key state, only after the secret matched: revoked, expired | 401 `key_revoked` / `key_expired` | yes |
| 9 | IP allowlist of the key on the effective client address | 403 `ip_not_allowed` | yes |
| 10 | Route match (verb and path) | 404 `not_found`; 405 `method_not_allowed` + `Allow` | no |
| 11 | Static right (PUB-2, PUB-3, PUB-4), before any byte of a body is read | 403 `forbidden` `{ right }` | no |
| 12 | PUB-1 only: `Content-Type` (415); coarse declared-length bound (413 `media_too_large`); the JSON body or the first multipart part `message` is read within 64 KiB and parsed | 415 `unsupported_media_type`; 413 `payload_too_large` / `media_too_large`; 400 `bad_request` | no |
| 12b | PUB-1 only, dynamic rights: `format` valid (422 `fields.format`), then `messages.send.<format>`, then `media.url` when `media.url` is present or `linkPreview` is `true` | 422 `validation_failed`; 403 `forbidden` `{ right }` | no |
| 13 | Recipient, in this order: (a) `to` is present and parses (422 `fields.to`: `required`, `invalid_type`, `invalid_format`); (b) the key's recipient policy allows it (403 `recipient_not_allowed`, never echoing the number); (c) it is not the bot's own number (422 `fields.to = { code: "not_allowed" }`, research.md U7) | as listed | no |
| 14 | The chat is not disabled in the bot (`ban`) | 409 `chat_disabled` | no |
| 15 | Idempotency lookup by (key, `Idempotency-Key`). JSON body: fingerprint now; same fingerprint = replay (the request ends here), different = conflict. Multipart: remember that the key is known, compare at step 19 | 202 + `Idempotent-Replayed: true`; 409 `idempotency_conflict` | no |
| 16 | Quota **check** (skipped when step 15 found a stored key, since that request can only replay or conflict), in this order: global queue, admission by estimated wait (research.md U4), key pending, key day, key minute | 503 `queue_full` (`global`, `wait`); 429 `pending_limit_reached`, `daily_quota_exceeded`, `rate_limited` | no |
| 17 | Strict validation of query and body (section 3.10), then cross-field rules, then `quote` existence | 422 `validation_failed` `{ fields }` | no |
| 18 | Media: file streamed to a temporary file under the format cap and sniffed (early on the first bytes, finally on the whole file), or `media.url` fetched (section 8) | 413 `media_too_large`; 422 `media_type_mismatch`, `url_forbidden`; 502 `url_unreachable` | no |
| 19 | Multipart: idempotency comparison with the file hash; then the atomic quota **reserve** (re-checks step 16 synchronously, released on any later failure) | 409 `idempotency_conflict`; the quota codes of step 16 | no |
| 20 | Hand over to the engine (atomic admission once more under its lock), then answer `202` | typed engine refusals (section 6) | no |

Order guarantees (FR-032): key (7-9), right (11, 12b), recipient policy (13b), disabled chat (14), quotas (16), content (17-18). A replay (15) precedes the quota, so a lost response can be retried at the limit; for multipart the replay is found only after the file was received, and the early quota check is skipped for a known `Idempotency-Key` for that reason. The check at 16 refuses a rate-limited client before it uploads 200 MB; the reserve at 19 keeps the limits exact under concurrency. Every refusal before the body was consumed carries `Connection: close`.

---

## 6. Error catalogue

Envelope, always: `{ "error": { "code": string, "fields"?: {...}, "params"?: {...}, "requestId": string } }`. `fields` appears only for `validation_failed`. There is never prose, a stack trace, a submitted value, a recipient number or a secret. `params.retryAfterMs` also becomes `Retry-After`.

| Code | HTTP | Params | Notes |
|---|---|---|---|
| `unavailable` | 503 | `retryAfterMs` (5000) | database not ready, restore in progress, database unreachable, key store unreadable (fail closed) |
| `method_not_allowed` | 405 | none | `Allow` only when produced by step 10 |
| `not_found` | 404 | none | unknown path, `:id` of the wrong shape, unknown id, another key's message, purged message |
| `bad_request` | 400 | none | malformed JSON, non-object JSON, malformed header or multipart structure |
| `https_required` | 403 | none | section 1.2 |
| `browser_not_allowed` | 403 | none | `Origin` or `Sec-Fetch-Site` present |
| `key_in_url` | 400 | none | the key is not used |
| `origin_blocked` | 429 | `retryAfterMs` | remaining block time, at most 900 s |
| `unauthenticated` | 401 | none | missing, malformed, unknown or wrong key: one answer, no enumeration; `WWW-Authenticate` |
| `key_revoked` | 401 | none | only after the secret matched |
| `key_expired` | 401 | none | only after the secret matched |
| `ip_not_allowed` | 403 | none | only after the secret matched |
| `forbidden` | 403 | `right` | missing right, named (the caller owns the key) |
| `recipient_not_allowed` | 403 | none | outside the key's policy; never echoes the number |
| `chat_disabled` | 409 | none | the chat is disabled in the bot (FR-041) |
| `rate_limited` | 429 | `scope` (`minute`, `uploads`), `limit`, `retryAfterMs` | minute window of the key; uploads in flight (2 per key, 4 in total, 5 s) |
| `daily_quota_exceeded` | 429 | `limit`, `retryAfterMs` | calendar day in the bot's `TIMEZONE`; retry at the next local midnight |
| `pending_limit_reached` | 429 | `limit`, `retryAfterMs` | the key's `queued` plus `sending` messages |
| `queue_full` | 503 | `scope` (`global`, `wait`, `disk`), `retryAfterMs` | `global`: 500 pending in all; `wait`: estimated wait above the expiry (section 7.2); `disk`: pending media bytes above twice `MAX_UPLOAD` (5 s) |
| `idempotency_conflict` | 409 | none | same key, different content |
| `payload_too_large` | 413 | `maxBytes` | JSON body or `message` part above 64 KiB |
| `media_too_large` | 413 | `maxBytes` | file, URL download or declared length above the cap |
| `unsupported_media_type` | 415 | none | `Content-Type` is neither JSON nor multipart |
| `validation_failed` | 422 | none (see `fields`) | section 6.1 |
| `media_type_mismatch` | 422 | `expected` | content does not match the format; the detected type is not echoed |
| `url_forbidden` | 422 | `reason` (`scheme`, `credentials`, `port`, `host`, `redirects`) | section 8.1 |
| `url_unreachable` | 502 | none | remote failure; a retry may work |
| `internal_error` | 500 | none | logged with the request id |

Anti-enumeration rules: everything before the secret is verified is the single `unauthenticated`; `key_revoked`, `key_expired` and `ip_not_allowed` are only ever shown to a caller who holds the whole secret; route existence is revealed only after authentication; another key's message, a purged message and a malformed id are the same `404`; `quote` and `after` of another key behave as unknown; an unresolvable host is `url_forbidden` with `reason: "host"`, not `url_unreachable`.

### 6.1 Field errors of `validation_failed`

`fields` maps a dotted path to `{ code, params? }`. Paths: `to`, `buttons.1.id`, `contacts.0.phones.2`, `options.2`, `media.url`, `idempotency-key` (the header), `wait` and the other query names; `$unknown` marks an unknown property at its level.

| Field code | Params | Used for |
|---|---|---|
| `required` | none | missing field (also `media` when neither a file nor a URL is given) |
| `invalid_type` | none | wrong JSON type |
| `invalid_format` | none | pattern, number, URL, timestamp or e-mail shape |
| `too_short` | `min` | below the minimum length or item count |
| `too_long` | `max` | above the maximum length |
| `out_of_range` | `min`, `max` | numeric range (`latitude`, `wait`, `limit`, `until`) |
| `not_allowed` | `allowed` for enums | value not permitted: unknown `format`, `mentions` on a private chat, the bot's own number in `to`, both a file and a URL |
| `too_many_items` | `max` | array above the maximum |
| `unknown_field` | none | unknown property |
| `invalid_order` | none | `file` part before `message` |
| `duplicate` | none | repeated option, button id, choice id or phone |
| `not_found` | none | `quote` or `after` does not designate a usable message of this key |

---

## 7. Quotas and idempotency

### 7.1 Limits

Per key, in memory and exact under concurrency; each key may override the defaults in the panel (a missing override follows the setting, so changing a default applies to every key that did not override it). Panel test sends (source `panel`) bypass the per-key quotas and the recipient policy but share the global cap and the pacing.

| Limit (rows are in check order, step 16) | Default | Setting | Refusal | `retryAfterMs` |
|---|---|---|---|---|
| Pending in all (`queued` plus `sending`, every key and the panel) | 500 | `API_QUEUE_MAX` | 503 `queue_full` `{ scope: "global" }` | `spacing x (size - cap + 1)`, 1 to 300 s |
| Estimated wait against the expiry | 10 min | `API_QUEUE_EXPIRY_MIN` | 503 `queue_full` `{ scope: "wait" }` | section 7.2 |
| Pending per key | 100 | `API_MAX_PENDING` | 429 `pending_limit_reached` `{ limit }` | `spacing x (pending - max + 1)`, 1 to 300 s |
| Messages per day | 1,000 | `API_RATE_PER_DAY` | 429 `daily_quota_exceeded` `{ limit }` | time to the next local midnight |
| Messages per minute | 30 | `API_RATE_PER_MINUTE` | 429 `rate_limited` `{ scope: "minute", limit }` | `oldest accepted + 60 s - now` |

A message counts when it is accepted and stays counted whatever becomes of it (`failed`, `expired`, `cancelled`). A replay, a refused request and a request that fails after the reserve do not count. The minute window slides over the last 60 s. The day is the calendar day of the bot's `TIMEZONE` (23 or 25 hours at a DST change) and survives restarts because it is rebuilt from the stored messages.

### 7.2 Pacing, expiry, admission by wait

- The queue sends one message at a time with at least `SEND_MIN_SPACING_MS` (2,000 ms, raised only upward) plus a random 0 to 20 %, the gap shared with the panel's broadcasts (FR-035). So acceptance is immediate but delivery is spread: 100 accepted messages take between 3 minutes 20 seconds and 4 minutes to leave.
- A message not sent `API_QUEUE_EXPIRY_MIN` (10) minutes after acceptance becomes `expired` and is never sent later, connected or not. Messages survive a restart; the pause after a WhatsApp account restriction (15 minutes) leaves expiries untouched.
- **Admission by estimated wait** (research.md U4): a request is refused when `(pending in all + 1) x spacing x 1.1` exceeds the expiry, with `retryAfterMs = that estimate - expiry` clamped to 1 to 300 s. With the defaults (2 s spacing, 10 min) the queue therefore admits about 272 pending messages although the global cap is 500: a message that could not leave in time is refused up front instead of expiring.

### 7.3 `Retry-After` summary

429 and 503 answers always carry `Retry-After` (seconds, at least 1). `origin_blocked`: remaining block. `unavailable`: 5. Upload and disk limits: 5.

### 7.4 Idempotency (FR-034)

- Header `Idempotency-Key`, PUB-1 only, per API key. Without it every request creates a message.
- **Window: 24 hours from the acceptance of the first request** (fixed, not configurable). Inside it, the same key and the same content return the stored message instead of sending again: `202`, `Location`, body `{ message }` in its **current** state, `Idempotent-Replayed: true`, no quota, no body validation, nothing queued (SC-006). After it, the key is free and a new request creates a new message.
- **Same content** is decided by a fingerprint of the endpoint, the JSON exactly as sent (keys in any order; an explicitly sent default counts as a difference) and, for multipart, the SHA-256 of the file. The `Idempotency-Key` header itself, `wait`, the file part's name and its declared type are not part of it. For `media.url` the URL string counts, not the downloaded bytes. A different content is `409 idempotency_conflict` and nothing is sent. No content is stored for the comparison.
- Only an accepted request is remembered: a request refused with a `4xx` or `5xx` leaves the key unused and can be retried (corrected) with the same key.
- Two identical requests racing yield one message; the loser is answered as a replay.
- The replay is checked after authentication, right, policy and chat checks (a revoked key cannot replay; a key that lost the right gets `forbidden`). For multipart the replay is detected after the upload (section 5, step 19).
- `wait` applies to a replay, so a client that lost the first response can retry with `wait=30`.

---

## 8. URL download and link preview

### 8.1 `media.url` (FR-060, FR-061, research.md X17)

The right `media.url` is required (`forbidden`, `right: "media.url"`, nothing fetched otherwise). The bot fetches during the request, before queueing, and a refusal is final for that request. All rules hold at every hop:

| Rule | Outcome when violated |
|---|---|
| `https:` scheme only | 422 `url_forbidden`, `reason: "scheme"` (a redirect to `http:` too) |
| no `user:pass@` | `reason: "credentials"` |
| standard port only (443; `:443` is accepted, any other port is not) | `reason: "port"` |
| the host is a DNS name with at least one dot; **IP literals are refused outright** (including `2130706433`, `0x7f.1`, `127.1`, `[::1]`), as are `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.localdomain` and names longer than 253 characters | `reason: "host"` |
| **every** address the name resolves to must be public; one private record refuses the whole name. Refused: private, loopback, link-local (cloud metadata `169.254.169.254` included), CGNAT, multicast, reserved, documentation, NAT64, 6to4 and Teredo ranges, IPv4-mapped and compatible forms, in IPv4 and IPv6 | `reason: "host"` |
| the connection goes to the address that was checked (no second resolution), certificate verified against the host name | a TLS failure is `url_unreachable` |
| redirects (301, 302, 303, 307, 308) are followed at most 3 times, each one re-validated from the first rule | a refused target gives its own reason; a fourth redirect `reason: "redirects"` |
| name does not resolve (`ENOTFOUND`, `EAI_AGAIN`) | `url_forbidden`, `reason: "host"` (not `url_unreachable`: no oracle on internal names) |
| one 30 s deadline for DNS, all hops and the body | 502 `url_unreachable` |
| `200` only; `Content-Encoding` other than identity is refused; connection failures and resets | 502 `url_unreachable` |
| the body is counted while it streams, cap `min(format cap, MAX_UPLOAD)`, whatever `Content-Length` says | 413 `media_too_large` |
| the first bytes are sniffed; wrong content | 422 `media_type_mismatch` |
| no cookie, no `Authorization`, nothing from the caller's request is forwarded; no environment proxy is used | n/a |

### 8.2 Link preview (FR-043, research.md X16)

- No link in a text is ever fetched by default: every text is sent with the preview generation switched off.
- `linkPreview: true` needs the right `media.url` and applies to `text` only. The bot then fetches the first `https://` link of the text through the same rules as 8.1 (256 KiB cap, HTML only), reads `<title>`, `og:title` and `og:description` and attaches them as the preview (no thumbnail in v1). The fetch happens when the message is sent: if there is no `https://` link, or the fetch is refused or fails, the text goes out **without a preview and the message does not fail**.

---

## 9. Availability

| Situation | What a caller sees |
|---|---|
| API switch off (the default; `ApiState.enabled` false) | every path under `/api/v1/**`, any verb, with or without a key, is **not claimed**: the answer is the one the bot gives to any unknown URL, byte for byte (today `200 text/html`, the status page, with the legacy `Access-Control-Allow-Origin: *` headers; `OPTIONS` answers an empty `200`; `lib/admin/monitoring.js:183-193,229-232`, pinned by `test/panel-legacy.test.js`). No JSON, no hint that an API exists (FR-001) |
| `ADMIN_PANEL=false` | no API object is built: same answer as above (FR-007) |
| Endpoint registry failed at boot (an endpoint without a right, FR-090) | nothing is served, same answer as a switched-off API; the bot, the panel and the commands keep running; the panel reports the failing endpoint |
| Bot starting (database not ready, switch not yet known) | every `/api/v1/**` request is claimed and answered `503 unavailable` + `Retry-After: 5`, whatever the switch, before authentication; nothing is read or queued (FR-006) |
| Backup restore running | `503 unavailable` + `Retry-After: 5` while the API is on; a switched-off API stays "not found". A restore never turns the API on, resurrects a revoked key or replays messages (research.md U9: `ApiKey`, `ApiMessage`, `ApiMessageResponse`, `ApiState` are never exported) |
| API switched off while running | the next request is not claimed; every queued message becomes `cancelled` with `api_disabled`; waits in progress end with that status; no timer or queue keeps running (FR-001, FR-002) |
| Key revoked or expired | its next request is refused (`key_revoked` / `key_expired`); its queued messages become `cancelled` with `key_revoked` / `key_expired`; a revoked key is never reactivated and disappears with its history after `API_RETENTION_DAYS` (U10) |
| WhatsApp disconnected | requests are still accepted (`202`); messages wait and `expired` after the expiry; not a `503` |
| WhatsApp account restricted (negative acknowledgement 463) | accepted as usual; the queue pauses 15 minutes; messages that expire during the pause become `expired`; owners get the `api_paused` alert |
| Restart of the bot | queued messages resume unless expired; a message that was being sent becomes `unknown` and is never resent (FR-038) |
| Origin blocked (10 auth failures in 5 minutes) | `429 origin_blocked` for 15 minutes for every request of that origin; the budget is in memory and resets on restart. Behind a proxy without `PANEL_TRUST_PROXY` all callers share the proxy's address, so one misbehaving caller can block the rest: set the trusted proxy |

---

## 10. OpenAPI document and versioning

- `GET /api/v1/openapi.json` (PUB-4) and the panel's download return one OpenAPI **3.1.0** document (JSON Schema 2020-12), generated by a pure builder from the registered endpoint modules and the format registry (the same schema rules also validate the requests, so the document and the validation cannot drift) and memoised after the first build; only `servers` varies per call. English only.
- `info.version` is `API_VERSION` (semver, starts at `1.0.0`; its major equals the path version). `servers[0].url` is the public panel URL plus `/api/v1` when configured, else the request-derived origin. `components.securitySchemes.bearerAuth` (`http`, `bearer`, `bearerFormat: "owbk_<id>_<secret>"`) applies globally.
- One operation per endpoint (`operationId` = registry id such as `messages.create`), with parameters (`wait`, `Idempotency-Key`, the PUB-3 filters), a `requestBody` offering `application/json` and `multipart/form-data` (with `encoding` for the `message` part), the `202`/`200` response and the error responses by `$ref`. The send operation lists the 13 format schemas under `oneOf` with a `discriminator` on `format` and one named example per format. Extensions: `x-required-rights`, `x-quota`, `x-idempotent`. Components: `Error` (with `code` enumerating section 6), `Message`, `MessageStatus` (the nine statuses), `FailureCode` (section 4.3), the rights list. Every object schema has `additionalProperties: false`.
- **Stability (FR-005).** Compatible within `v1` (no new path version): a new endpoint, a new format, a new optional request field, a new response field, a new error code, a new failure code, a new right (denied to every existing key), a new value in a response enum. Breaking, only through `/api/v2` served beside `v1`: removing or renaming a field, tightening the validation of an existing field, changing a type, a default or a meaning, changing the code or the status of an existing refusal, removing an endpoint or a format. A deprecated endpoint is flagged `deprecated: true` in the document and answers with `Deprecation` and `Sunset` headers (and a `Link` to its replacement) for the announced period. Clients must ignore unknown response fields and treat unknown enum values as generic.

---

## 11. Test obligations

- `test/api-contract.test.js`: the machine-read checks of the first section (endpoints and rights against `api.routes()` / `api.rights()`, formats against `formats.list()`, statuses, failure codes, error codes and HTTP statuses against the code tables, every example block posted and accepted).
- `test/api-security.test.js` (SC-002, harness `test/helpers/apiHarness.js`): route-table enumeration with, per endpoint, no/malformed/unknown/wrong key (all `unauthenticated`), revoked, expired, IP outside the list, every right but the needed one (`forbidden`, engine and `ApiMessage` count untouched), out-of-policy recipient, undeclared verb (`405` + `Allow`); the pinned path set; the common error envelope and `API_STATUS` match; no `Access-Control-*`; the response header profile of 1.4; origin blocking (10 failures in 5 minutes, valid key refused, `Retry-After` 900, alert raised once, release at +15 minutes, steps 3-6 and 10-20 never counted); `Origin`, `Sec-Fetch-Site`, `OPTIONS` and `HEAD`; key in query and path never reaching `authenticate`; plain HTTP from a remote address refused, accepted through trusted `X-Forwarded-Proto: https`, from loopback and from a `plainHttpFrom` address (and refused again after the entry is removed); cookie alone refused; API key inert on `/admin/api/**`; anti-enumeration of section 6.
- `test/api-pipeline.test.js`: one case per adjacent pair of steps in section 5 proving the order (policy before disabled chat before quota before content; `format` and `to` errors returned alone; self-number refused after the policy check so a restricted key learns nothing; replay before quota; known `Idempotency-Key` skipping step 16; `Connection: close` on early refusals); `unavailable` at step 1 with the engine untouched.
- `test/api-messages.test.js`: PUB-1 to PUB-3 behaviour: `202` shape and `Location`, `wait` (resolves on `sent`, not on `delivered`, times out at the bound with the current status, ends on disconnect, capped at 200 waiters, `31` and `true` refused), the message resource of section 4 for every status and failure code, the responses shapes (button tap, numbered reply, poll with replace and clear, totals), list filters and keyset pagination (stable under inserts, bad `after`, other key's messages invisible), `404` for another key's, the panel's and a purged message, `quote` rules, `to` normalisation table, SC-010 latency guard.
- `test/api-formats-contract.test.js`: for every format, each limit of section 3 at its boundary and one past it with the exact field code and dotted path, unknown fields at every level, the one-source media rule, mentions on a private chat, duplicate options/ids/phones, composed interactive body over 4,096.
- `test/api-quotas.test.js` and `test/api-idempotency.test.js`: section 7 on the fake clock (minute slide, local-midnight day with a non-UTC `TIMEZONE`, restart rebuilding the day, pending, global cap, admission by wait with `retryAfterMs`, the 50-way concurrent reserve never exceeding a limit, refunds); replay, conflict, 24 h window, racing duplicates, multipart fingerprint, a refused request leaving the key free, `wait` on a replay.
- `test/api-multipart.test.js`, `test/url-fetch.test.js`: as in research/a-http-security.md A10 (random-split fuzz, malformed grammar, caps with early abort, cleanup; the SSRF battery with the request spy never called for a non-public target, SC-007), plus the `reason` and HTTP status of every row of 8.1.
- `test/api-availability.test.js` (and the added routes of `test/panel-legacy.test.js`): the table of section 9: byte-identical answer to `/unknown` for switch off, `ADMIN_PANEL=false` and a failed registry (GET, POST, OPTIONS, with and without a key), `503` during boot and restore, cancellation on switch-off and revoke, restore not re-enabling anything.
- `test/api-openapi.test.js`: structural checks of the document (refs resolve, unique `operationId`, every parameter declared, every operation has `security` and `x-required-rights`, every error code in the catalogue, every format has an example, byte-stable, `info.version` major equals `v1`), the demo-module test of SC-009 (a temporary endpoint and format appear in the document, the rights catalogue and the panel catalogue with no other edit; an endpoint without a right keeps the whole API unserved).
- `test/api-leak-scan.test.js` (SC-003): after the security and send scenarios with a canary key, text, caption and file name, scan log output, the log ring, audit rows, every response body and a dump of the four API tables; none contains the token, its secret part, the canary, or matches `owbk_[0-9a-f]{16}_`.
- `test/admin-logging.test.js` (extended to `lib/api/**` and `lib/messaging/**`) and `test/admin-memory.test.js` (SC-011): as in research/a-http-security.md A10.
