# Phase 0 Research: decisions

Inputs: four parallel research streams (Sonnet, read-only, 2026-11-02), each with `file:line` evidence and throwaway spikes outside the repo:

| Stream | File | Scope |
| --- | --- | --- |
| A | [research/a-http-security.md](research/a-http-security.md) | mounting, request pipeline and check order, key format and storage, HTTPS rule, origin throttling, IP allowlist, quotas, idempotency, endpoint contract and router, multipart uploads, SSRF-safe URL fetcher, link preview, OpenAPI, error catalogue, API test harness |
| B | [research/b-messaging-engine.md](research/b-messaging-engine.md) | format module contract, Baileys v7 content per format, outbox, shared send gate, recipients and policy, never-a-command, receipts, reply and poll-vote capture, quoting, mentions, media lifecycle, engine tests |
| C | [research/c-data-panel-backend.md](research/c-data-panel-backend.md) | models, backup, settings, step-up re-authentication, panel routes API-1..13, audit, alerts, housekeeping, usage, boot wiring, backend tests |
| D | [research/d-panel-ui.md](research/d-panel-ui.md) | API area of the SPA, keys editor, secret-once dialog, step-up dialog, history and detail, generated test form, usage, docs, panel i18n, view tests and render guards |

The stream files hold the detail (Decision / Rationale / Alternatives / Evidence / Files). **This file is authoritative where they disagree**: the owner's decisions (section 1) and the arbitration (section 2) override any stream recommendation.

## 1. Owner decisions taken during research (2026-11-02)

Both questions followed the recommended answer; the spec was updated (Clarifications, session "plan, après la recherche").

| # | Question | Decision | Spec |
| --- | --- | --- | --- |
| U1 | Plain-HTTP calls from a private network (n8n in the same `docker compose`) | Allowed only from the private CIDRs listed in a dedicated list, **empty by default**; private ranges only (RFC 1918, ULA `fc00::/7`, CGNAT `100.64.0.0/10`); widening it needs the password | FR-003, FR-021, edge cases |
| U2 | Content of a queued message, labels of choices | Queued content kept in `ApiMessage.payload` (and the staged file) **until the terminal status**, erased in the same UPDATE; short labels (<= 100 chars) of buttons, list rows and poll options kept with the responses for the retention period; never the question, body, caption or media | FR-073, Key Entities |

Decisions taken without a question (security, or a direct consequence of earlier answers), written into the spec:

| # | Topic | Decision | From |
| --- | --- | --- | --- |
| U3 | Day quota | Calendar day in `TIMEZONE`; `Retry-After` = time to local midnight | A open 4 |
| U4 | Admission by estimated wait | Refuse with `queue_full` (`scope: "wait"`) when `(pending + 1) x spacing x 1.1` exceeds the queue expiry: 500 pending cannot leave within 10 min at 2-2.4 s | B open 4 |
| U5 | WhatsApp account restriction (`463`, negative ack) | Queue pauses 15 min, expiries unchanged, alert `api_paused` (on by default) | B open 2 |
| U6 | Document types | The broadcast whitelist (PDF, Office/OpenDocument, zip, txt, csv); never an executable | B open 6 |
| U7 | Sending to the bot's own number | Refused (`validation_failed`, `fields.to = { code: "not_allowed" }`) | B5 |
| U8 | Docs through the API | `GET /api/v1/openapi.json` needs the right `api.docs` (off for new keys, FR-090: no public endpoint); English only | A open 2-3 |
| U9 | Backups | `ApiKey`, `ApiMessage`, `ApiMessageResponse`, `ApiState` in `EXCLUDED_MODELS`: a restore never resurrects a revoked key, clones live credentials, replays queued sends or re-enables the API | C2 |
| U10 | Revoked keys | Never reactivated (Duplicate instead); purged with their history `API_RETENTION_DAYS` after revocation (the audit keeps the trace) | C open 4, D open 3 |
| U11 | Key names | Unique among non-revoked keys (case-insensitive, trimmed) | D open 2 |
| U12 | Alert defaults | `ALERT_API_ORIGIN_BLOCKED` on, `ALERT_API_PAUSED` on, `ALERT_API_KEY_NEW_IP` off | C open 3 |
| U13 | Quote of an API message | Typed empty shell + `stanzaId` (nothing of the content is kept); the phone checklist verifies the bubble | B open 1, B8 |
| U14 | Numbered fallback inside interactive messages | Kept in the body (FR-057), redundancy on phones that render native buttons accepted | B open 3 |
| U15 | Poll option digests | SHA-256 digests of the options kept with the message for the reply window (needed to map votes; labels are kept anyway per U2) | B open 5 |

## 2. Arbitration between the streams

| # | Topic | Conflict | Decision |
| --- | --- | --- | --- |
| X1 | On/off switch and the plain-HTTP list | A/B read `API_ENABLED` through settings; D proposed a catalog entry with an `adapter`; C a dedicated state | **C**: singleton row `ApiState` (`enabled`, `plainHttpFrom` JSON list, `updatedAt`) behind `lib/utils/apiState.js` (`get()`, `setEnabled()`, `setPlainHttpFrom()`, cached, `onChange`). Not a catalog entry, so SET-2, `config.env` and restore cannot flip it without the password. The row is not created by a read (`test/admin-security.test.js` "no GET writes") |
| X2 | Settings | B: `API_MIN_SPACING_MS`, `API_QUEUE_TTL_MS`, `API_MAX_QUEUE`; C: its own list | **C's names, panel-only (`env: null`)**, plus one alert toggle: `SEND_MIN_SPACING_MS` (int >= 2000, default 2000, shared gate), `API_RATE_PER_MINUTE` (30), `API_RATE_PER_DAY` (1000), `API_MAX_PENDING` (100), `API_QUEUE_MAX` (500), `API_QUEUE_EXPIRY_MIN` (10), `API_RETENTION_DAYS` (30), `API_REPLY_WINDOW_DAYS` (7), `ALERT_API_ORIGIN_BLOCKED` (true), `ALERT_API_KEY_NEW_IP` (false), `ALERT_API_PAUSED` (true). Catalog count 101 -> 112; `config.env.example` untouched (env-less entries, check `test/settings-example.test.js` accepts them) |
| X3 | Columns and identifiers | B: `keyId`, `replyMeta`, `pollSecret`; C: `apiKeyId`, `choices`, `replyData`; D: `source: "key"` | **C owns names**: `apiKeyId` (NULL = panel), integer `id` for FIFO + unique `publicId` = `msg_` + 22 base64url chars (128 bits, A); `waId` unique nullable (pre-generated by the outbox, B3); `payload` (queued content, cleared at terminal); `choices` (ids + short labels, kept); `replyData` (option digests, ids, no text); `pollSecret` (`enc:v1:` via `secretBox`, B7); `mediaPath`; one timestamp per step + `endedAt`. `source: "api" \| "panel"`. Key `status` (derived): `active \| expired \| revoked` |
| X4 | Error codes | A: own API catalogue, panel `STATUS_BY_CODE` untouched; C/D: engine codes added to the panel table for the test route | **Two tables, one source per code.** `lib/messaging/errors.js` (`MessagingError`, `MESSAGING_STATUS`) holds the engine refusals shared by the API and the panel test route; `lib/api/errors.js` (`ApiError`, `API_STATUS`) holds the HTTP-layer codes of A9 and imports the messaging table. The panel imports `MESSAGING_STATUS` into `STATUS_BY_CODE` (with panel texts) so API-11 never answers 500 for an engine refusal. `daily_quota_exceeded` avoids the panel's `quota_exceeded` (507). B's `recipient_invalid` and `quote_not_found` become `validation_failed` with `fields.to` / `fields.quote` (`invalid_format` / `not_found`). The panel adds `password_required` (403) and `api_disabled` (409, replaces D's `bot_unavailable`: a disconnected bot still accepts) |
| X5 | Nested schemas | A: extend `request.js#validate`; B: extract a shared module | **B**: `lib/utils/schema.js` (moved `validate` + rules `shape` for nested objects, `unique`, dotted error paths `buttons.1.id`); `lib/admin/http/request.js` re-exports it unchanged for the panel. Engines may require it (outside `lib/admin`) |
| X6 | Format descriptor | B: widgets `switch/repeater/file`; D: `boolean/list/recipient/phone`, media implied | **D's served shape** (API-3 `formats[]`), produced by B's registry `describe(name)` from the module's `fields`: types `text, textarea, number, boolean, select, phone, url, list, recipient`; media as `media: { sources, accept, maxBytes, captionMax }`. i18n keys `api.format.<name>.label\|desc`, `api.format.<name>.field.<field>.label\|hint`; rights `api.right.<id>.label\|desc`. A registry test proves every key exists in both catalogs |
| X7 | Panel routes | C and D converged | **API-1..API-13 under `/admin/api/api`, plus AUTH-7 `POST /admin/api/session/reauth`** (C5 table = D "Needed from C"); `PUT` keys with `version` and `409 conflict`; API-1 settings in minutes/days; API-2 also carries `plainHttpFrom` (U1, step-up when widened) |
| X8 | Step-up | — | **C4**: `confirmedUntil` in the in-memory session cache (lost on restart, no schema change); AUTH-7 shares the login/password-change limiter (5 failures, 15 min block); router option `stepUp: true \| "conditional"` and `ctx.stepUp()`; `403 password_required { params: { windowMs } }`. The widening predicate is server-side (`lib/admin/services/api.js#widenings(before, after)`), mirrored by the pure `widenings()` of `api-logic.mjs` (false positives allowed client-side) |
| X9 | Alerts | A: `api_new_ip`; C: `api_key_new_ip`; B: a restriction alert | **Three types, raised by direct `alerts.raise`** (no new bus topic): `api_origin_blocked` (slot per origin, 15 min), `api_key_new_ip` (slot per key + IP, 24 h), `api_paused` (slot 15 min). `AlertOutbox.TYPES`, the alerts service and `alerts-logic.mjs` grow from 6 to 9 types |
| X10 | Mounting | — | **A1 + C8**: `createAdmin` builds `api` (no I/O, no timer) only when `ADMIN_PANEL`; `createPanelServer({ botState, admin, api })` tries `api.handle` first; a disabled API or a failed endpoint registry returns `false` so the legacy handler answers exactly as for any unknown URL (`monitoring.js:229-232`); boot and restore give `503 unavailable` + `Retry-After` |
| X11 | Router | — | **A3**: separate `lib/api/router.js` (the panel router is welded to sessions, `/admin` and CSRF, and its table is pinned). Endpoint module: `right` or `rights` + `requires(peek)` for the dynamic `messages.send.<format>` and `media.url`; a missing right throws at registry build, naming the endpoint, and no endpoint is served |
| X12 | Uploads | — | **API**: hand-written restricted multipart parser `lib/api/multipart.js` (one JSON part `message` then one file part; spike: 2,800 random splits exact, 200 MiB in 38 ms), no dependency. **Panel test form**: existing uploads with a new purpose `api` and an injected sniffer from B |
| X13 | Interactive sends | — | **B2**: never call `sendQuickReplies`/`sendList` from the engine (their catch sends a second plain message: breaks at-most-once). `plugins/buttons.js` is split into pure builders + a no-fallback sender used by the engine; plugin behaviour unchanged. API ids are `api:reply:<waId>:<id>` |
| X14 | Quotas | — | **A5** in-memory counters (sliding minute, day hydrated from `ApiMessage` at start), check before reading the body and atomic reserve after it; plus U4 admission by estimated wait (B) and the global cap |
| X15 | Never a command | — | **B5**: own sends are `append` upserts, dropped by `client.js:365-366`; defence in depth: a bounded `sentIds` set checked first in `pipeline.js` (pipeline changes stay in that file) and U7; residual risk (two processes linked to one number) documented |
| X16 | Link preview | — | **A7 + B2**: every text send passes `linkPreview: null` (Baileys otherwise calls `getUrlInfo` on any `https://` link, `messages.js:278-279`; `link-preview-js` is absent today, so nothing is fetched now, but a future install would silently open an SSRF); a requested preview is built through `urlFetch` (title + description only) |
| X17 | URL fetcher | — | **A7**: connect to the validated IP itself (`servername` = host, `agent: false`), ranges checked with `net.BlockList` without `::ffff:0:0/96` (mapped addresses are unmapped first), manual redirects (<= 3), 30 s, byte cap while streaming |
| X18 | Shared pacing | — | **B3**: `lib/utils/sendGate.js` (`ready()`, `reserve()`, `seed()`), process-wide instance shared by the outbox and the broadcaster (about 4 lines in the broadcaster; its per-broadcast spacing stays) |
| X19 | Poll votes | — | **B7**: Baileys rc14 has vote decryption commented out; the engine decrypts votes itself (spike round trip passed) with the stored `pollSecret` and option digests |
| X20 | Usage per key per day | — | **C7**: `GROUP BY` on `api_messages`, not `DailyStat` |
| X21 | Key cache | — | **A4**: `settingsCache` key `api_keys`; every key writer calls `settingsCache.invalidate("api_keys")`; usage columns (`lastUsedAt`, `lastIp`, `seenIps` <= 20) are written behind and never bump `version` |
| X22 | IP grammar | — | **A2**: IPv4, IPv4/n, IPv6, IPv6/n, normalised, <= 50 entries, compiled to `net.BlockList`; shared fixture `test/fixtures/api-ip-entries.json` used by the server parser and `api-logic.mjs` |

## 2b. Phase 1 alignment (orchestrator, after the five design files)

| # | Topic | Decision |
| --- | --- | --- |
| Y1 | List caps | `ApiState.plainHttpFrom` <= 20 entries; `ApiKey.ipAllow` <= 50 entries |
| Y2 | Key store file | `lib/api/keyStore.js` (also the usage write-behind) |
| Y3 | Media hand-off | `messaging.submit({ media })` moves the API temp file (copies a panel upload) into `data/api-media/<publicId>/source`; the engine mints `publicId`; no `adopt()` on the HTTP side |
| Y4 | Request field names | `contracts/public-api.md` wins everywhere (`contacts[].name`, `choices`...) |
| Y5 | Staging | `data/api-media/`; queued content in the `payload` column, never a file |
| Y6 | `api_paused` alert | payload `{ resumesAt }`, slot 15 min |
| Y7 | WhatsApp `463` | Baileys rc14 documents it as "missing privacy token, usually account restricted" and can come from one contact: a single `463` fails that message (`whatsapp_rejected`); **3 within 10 minutes** pause the queue 15 minutes and raise `api_paused` (spec FR-045 updated; replaces U5's "any 463") |
| Y8 | Login and step-up | A successful login sets the step-up confirmation (window starts at login, US4.7); AUTH-7 renews it |
| Y9 | Logging a key | integer `ApiKey.id` + name; never `lookupId`, never the secret |
| Y10 | Panel test send | no key quota applies (source `panel`): `rate_limited`, `daily_quota_exceeded`, `pending_limit_reached` never reach the panel; only the `MESSAGING_STATUS` codes get panel texts |
| Y11 | IP module | `lib/api/ipRules.js` |
| Y12 | Expired keys | editable (extending the expiry is a widening: password); API-7 refuses a revoked or expired source |
| Y13 | Media sweep | `messaging.sweepMedia({ now })` |
| Y14 | Policy modes | `list`, `known`, `anyone` |
| Y15 | Group failures | `not_in_group`, `group_announce_only` |
| Y16 | Replies | window counted from `sentAt`; at most 1,000 response rows per message |
| Y17 | `media_type_mismatch` | params `{ expected }` only, never the detected type |

## 3. Risks that only a real phone can settle

Listed in [quickstart.md](quickstart.md), section "Phone checklist" (SC-004):

- poll-vote voter JID forms (PN vs LID) and multiple-answer semantics, given the hand-written decryption (X19);
- the quote bubble with an empty shell (U13);
- mentions in LID groups;
- whether a native-flow button response always quotes its message;
- WhatsApp's interactive and media size limits (taken from documentation);
- the negative-ack code for a restricted account (U5).

## 4. Gate notes for the plan

- G2: no new dependency (multipart parser hand-written, `net.BlockList` and `node:https` for the fetcher, `file-type`/`sharp`/`node-webpmux`/ffmpeg already present).
- G3: one pipeline: the only `pipeline.js` change is the `sentIds` guard (X15); reply capture is a hook-only plugin `plugins/apireplies.js` (`handleButtonReply` priority 5, `onMessage` priority 6), so `test/hooks.test.js` gains two rows.
- G5: four new tables, nothing altered; unique indexes only on the new tables.
- G6: panel routes all `auth: "session"`, strict schemas, audited writes, `confirm` on destructive routes, step-up on widening.
- G8 (new, public API): every endpoint declares a right (registry build fails otherwise); key never in the URL, logs or answers; SSRF battery and leak scan in the suite.
