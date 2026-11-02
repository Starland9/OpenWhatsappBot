# Implementation log: feature 004 (messaging API)

## Baseline (T001, T002), 2026-11-02

- BASE = `136f9c2` (last documentation commit; branch `004-messaging-api` departs from `master` at `6706c4b`).
- Full suite, Node v24.20.0, `NODE_OPTIONS=--max-old-space-size=1024`: **2,962 tests, 2,955 pass, 0 fail, 7 skipped**; `BOT_LANG=fr` 43 s, `BOT_LANG=en` 54 s.
- `node tools/check-unused-deps.js`: `0 unused dependencies`.
- `tools/measure-panel-memory.js` (median of 3, idle 20 s): baseline RSS 170.2 MB, panel RSS 191.8 MB, delta **21.7 MB** (heap+external 6.9 MB).
- ffmpeg 6.1.1 present (media tests will run); `sharp` and `file-type` load; `test/fixtures/` does not exist; no `lib/api`, `lib/messaging`, `lib/utils/{schema,sendGate,apiState,stickerMaker}.js` yet.

## Waves

### W0 (A-UTIL T003-T015, B-DATA T016-T028), checkpoint T029

- Commits `692bdcf` (A-UTIL), `fc18eb4` (B-DATA). Checkpoint: fr 3,409 tests / 3,402 pass / 0 fail / 7 skipped (49 s); en 3,423 / 3,416 / 0 / 7 (26 s); `0 unused dependencies`. No Request between agents.
- Deviations and facts the next waves rely on:
  - `lib/utils/schema.js` exports `{ check, validate, SchemaError, codePoints }`. Per-item error paths (`<path>.<index>`) only for array rules with `unique: true` or object `items.shape`; any other array rule reports one fault on the array path (existing panel schemas unchanged). A scalar array that needs item paths (`options`, `mentions`) sets `unique: true`. Top-level non-object: `check` -> `{ $: invalid_type }`, `validate` -> `bad_request`.
  - `lib/utils/sendGate.js` exports `{ createSendGate, shared }`; reads `SEND_MIN_SPACING_MS` at call time (fallback 2000). In `broadcaster.js` the local is named `sendGate` (the name `gate` was taken).
  - `plugins/buttons.js`: `buildQuickReplies`, `buildList({ numbered: true })` (API form: row titles only, flattened), `sendPrepared(sock, jid, prepared, { messageId, quoted })` (one attempt, throws).
  - `lib/messaging/errors.js`: `MessagingError` also accepts `headers`. `lib/messaging/limits.js`: `LIMITS.MEDIA_MAX = { image, video, gif, audio, voice, document, sticker }`.
  - `stickerMaker.js`: `{ STICKER_SIZE, MAX_STICKER_BYTES, IMAGE_QUALITIES, EXIF_HEADER, imageToWebp, buildExif, withStickerExif }`. `Message.js`: `findParticipant`, `isAdminParticipant`. `permissions.parsePhoneNumber`, `knownChats.isKnown`.
  - `test/helpers/fakes.js`: `fakeSocket.sendMessage` honours `options.messageId` as `key.id`; `fakeSocket({ announce, groupMetadataError, onWhatsApp })` (`sock.groupMetadataError` settable); `fakeClient.setReady(bool)` / `fakeReady` drive `ready()`.
  - `ApiMessage` `source`/`apiKeyId` consistency is a `beforeValidate` hook (honours `options.skip`), so static status UPDATEs are never refused. Custom validators tolerate NULL.
  - `apiState`: extra `setState({ enabled, plainHttpFrom }, { now })` (one upsert, one notification); its own lock key is `api-state:write` (the panel service must NOT reuse it; its `withLock("api-state")` would deadlock otherwise). `setPlainHttpFrom` errors: `Error{ code: "invalid_format", params: { indices, reason?: "not_private" | "too_many" } }`.
  - `ipRules`: `compile(entries) -> { check, restricted, size }` fails closed (non-empty list with no readable entry matches nothing). Key store: compile `row.ipAllow` directly, never through `parse().entries`. Transport: `ipRules.parse(list, { privateOnly: true, max: ipRules.MAX_PLAIN_HTTP }).entries`. Extras `parseEntry`, `unmap`.
  - `test/helpers/apiInvariants.js`: `assertMessageInvariants(row, { pendingMedia })`, `assertKeyInvariants`, `keyStatus(row, now)`; `backupKit.API_SEED` canaries. `test/api-data.test.js` holds reference statements for T1-T11, idempotency and reply recording: the engine must issue the same conditional UPDATEs/INSERTs.
  - The three 004 alert types are in `AlertOutbox.TYPES` only; `lib/utils/alerts.js` `TYPES` is E-OUT's (W2). Settings: 112 entries (78 editable, 22 secrets, 5 restart), cross validator `replyWindowWithinRetention`; settings texts in `panel-api-server.json`; bot texts (4 keys incl. `api.registry_failed`) in `bot-api.json`, both merged.
  - `CLAUDE.md` still says 101 settings (J-DOC, W4).

### W1 C-FMT (T030-T033, T044, T056, T074-T076, T080-T083, T122, T125-T126, T128, T131), commit `71281f2`

- Tests: messaging-formats 137, messaging-recipients 37, messaging-media 24, url-fetch 56 (all green, ffmpeg present). urlFetch mutation check: five breakages each turned the suite red.
- Names W2/W3 code against:
  - Registry: `load({ dir })`, `list`, `get`, `rights`, `rightsFor`, `schemaOf`, `describe`, `doc`, `FormatRegistryError { file, reason }`; extras `checkInput(name, body, { target }) -> { value, own, fields, mediaMarker }` (schema, `media.url` syntax, module `refine` even after schema faults, `normalize` when clean; unknown format -> `fields.format = not_allowed` + `params.allowed`; the `quote` lookup is the facade's), `sizeOf(name, own, media)`, `createRegistry({ dir })`, `COMMON_FIELD_NAMES`; accessors lazy-load the default directory.
  - Format hooks (`refine`, `normalize`, `size`, `build`, `prepare`) receive the format's OWN fields; `requires` gets the raw body. `build(ctx)`: pass `ctx.dir` (stage dir; the staged path is checked to be inside it); media formats read `media.{ path, mime, ext (no dot), name? }`; voice and sticker throw `media_conversion_failed` without `prepared`; `text.build` accepts `ctx.preview` as `{ preview }` or the preview itself; interactive and poll builds return `{ transport, content, choices, replyData?, secret? }`. `prepare(ctx)` takes `{ input, media, dir, signal }` (test injections `ffmpeg`, `stickerMaker`, `fetcher`).
  - recipients: `parseRecipient`, `mask` (group -> `group:<last 4>`), `evaluatePolicy` (async), `isChatDisabled(target, { bannedChats })`, `resolveRecipient(to, { policy, sock, bannedChats })`, `getBotJids(sock)`, `isOwnNumber(target, sock)`, `mentionJids(metadata, numbers) -> [{ number, jid }]`, `verifyReachable(sock, target, { now, timeoutMs }) -> { jid, skipped? } | { failure: "not_on_whatsapp" }` (errors propagate as transient), `verifyGroupPosting(sock, target, { timeoutMs }) -> { metadata } | { failure }`, `_reset`. `sock` may be an object or an accessor; `bannedChats` a Set, a function or a promise.
  - stage: `createStage({ rootDir, dataDir, fs })` + default instance: `rootDir`, `dirOf` (sync), `adopt`, `remove`, `list`, `absolute(mediaPath)`, `assertStaged(file, dir)`, `preparedFile(dir, ext)`, `SOURCE_NAME`; `mediaPath` is relative to the repository root. `sweepMedia` belongs to E-OUT.
  - urlFetch: `fetchMedia(url, { maxBytes, kinds, signal }) -> { path, size, contentType, sha256 }` (facade passes `maxBytes = sniff.effectiveMax(format)`, `kinds = format.media.kinds`), `fetchPreview`, `validateUrl`, `isPublicAddress`, `PUBLIC_RANGES`, `createUrlFetcher` (also `timeoutSignal`); tries up to 4 validated addresses.
  - sniff: `KINDS`, `HEAD_BYTES`, `classifyHead`, `classify`, `accepts`, `check`, `effectiveMax`.
- Panel keys the descriptors need (G-STEP, W2): `api.format.<name>.label|desc` (13), `api.format.<name>.field.<path>.label|hint` for every field (nested: `contacts.name|phones|organization|email`, `buttons.id|label`, `choices.id|title|description`), `api.format.common.field.to|quote.label|hint`; select options `api.format.<name>.field.<path>.option.<value>` (none today); object rules map to descriptor type `group`. No bot key needed (`plugins.buttons.reply_number`, `plugins.buttons.pick_list` exist).

### W1 D-HTTP (T034-T043, T045, T057, T077, T084, T133, T137), commit `a727665`

- Tests (single files, green): api-errors 18, api-registry 30, api-transport 19, api-keys 26, api-pipeline 49, api-mount 21, api-quotas 19, api-idempotency 10, api-multipart 45, api-openapi-builder 26, panel-legacy 66 (also against a mounted-but-off API and a failed registry: byte-identical to an unknown URL), admin-logging 20.
- Deviations E-OUT and F-PUB must follow:
  1. `ctx.idempotency = { key, requestHash, replay }`: when the key exists with the same fingerprint (step 15, or 19 for multipart) `replay` holds the stored MessageView and steps 16-19 are skipped; the handler answers `202` + `Location` + `Idempotent-Replayed: true`, honours `wait`, never calls `submit`.
  2. `ctx.services.messaging` is a bound copy of the facade whose `submit` handles a lost race: `submit` returning `{ replayed: true }` -> compare `requestHash` (409 `idempotency_conflict` on mismatch) and release the quota reservation.
  3. Endpoint callbacks get a second argument: `body.file.accept(peek, { formats })` -> `{ kinds } | null`, `body.file.maxBytes(peek, { formats })`, `requires(peek, { formats })`. The send endpoint uses `body.variants`; `ctx.body` is the `Validated` object of `messaging.validateInput`.
  4. **Facade methods the pipeline calls (E-OUT must expose them, plus `formats`)**: `resolveRecipient`, `validateInput`, `checkAdmission({ apiKeyId, maxPending })`, `findByIdempotency({ apiKeyId, key, now })`, `fetchMedia(formatName, url, { signal })`, `inspectMedia(formatName, file, { name })`, `pendingMediaBytes()`, `submit`. The pipeline reads `deps.formats`, falling back to `lib/messaging/formats`.
  5. `keyStore.lookup` returns the KeyRecord; revoked / expired / IP are decided by the pipeline from `revokedAtMs`, `expiresAtMs`, `ipAllow`. `touch` returns a never-rejecting promise.
  6. `transport.js`: `createTransport({ trust, apiState })` + three functions taking `(req, deps)`; `quotas.hydrate(key)` before `reserve`; `loadEndpoints` also returns `router`; `multipart.readMessagePart -> { raw, filename, contentType, next() }`; `upload.receive(part, { keyId, maxBytes, kinds, signal, pendingBytes, dir })` writes to `<dataDir>/tmp/api` (0600, `wx`).
  7. Rights groups: `send`, `read`, `media`, `docs`, else the first dotted segment.
  8. Missing `lib/api/endpoints/` = empty registry; a missing formats module is tolerated at `createApi` (W1 only).
  9. OpenAPI base document deep-frozen after first build; components `Message`, `Error`, `FieldError`, `MessageStatus`, `FailureCode`, `Right` exist; F-PUB completes success responses (`Message` refs, rights) in W3.
  10. Origin-block alert payload `{ origin, retryAfterMs }`; audit row `{ action: "api.origin.block", target: origin, origin, result: "blocked", detail: { retryAfterMs } }`.
- `test/helpers/apiHttpKit.js` exports `createApiKit`, `fakeFormats`, `fakeSniff`, `createFakeEngine`, `FIXTURES`; remote callers are simulated with `remote: "<ip>"` under `PANEL_TRUST_PROXY=loopback`. `lib/api/limits.js` hydrates day counters from `ApiMessage` (`acceptedAt`).

### W1 checkpoint (T145)

- fr 3,984 tests / 3,977 pass / 0 fail / 7 skipped (29 s); en same counts (45 s); `0 unused dependencies`; no "nobody" file changed since BASE; no file edited by both W1 agents; `lib/messaging/**` and `lib/utils/{sendGate,schema,apiState}.js` require nothing under `lib/api/` or `lib/admin/` (except the lazy `ipRules` leaf); no `console.*` or `pino(` in `lib/api`, `lib/messaging`. No Request.
- Incident: both W1 agents stopped on the 5-hour usage limit (reset 13:00 WAT) and were resumed with their context intact.

### W2 G-STEP (T097-T102, T108-T115), commit `2bc2b7a`; Request fix `main`

- Tests: admin-stepup 24, admin-http 77, admin-view-api-logic 115, admin-view-guard 7, admin-view-reauth 26, admin-i18n 21, admin-frontend 41, api-panel-texts 9 (after the fix). Expected red until W3: `admin-integration` (AUTH-7 registered, contract parser not yet extended by H-PANEL).
- Request 1 applied by `main`: `lib/messaging/formats/index.js#deriveField` uses the segment `<key>_field` for nested fields named `label|hint|placeholder|option` (`api.format.buttons.field.buttons.label_field.label`), test updated. Request 2 (comment in `lib/admin/index.js` header: `admin.routes()` rows gain `stepUp`) left to H-PANEL.
- For H-PANEL: `ctx.session.confirmedAt` in ms (0 = never); `State.stepUp = auth.sessions.isRecent(ctx.session, ctx.now) ? iso(confirmedAt + auth.sessions.STEP_UP_MS) : null`; call `ctx.stepUp(reasons)` last in conditional handlers; widening fixture rows `{ name, before, after, reasons }` (key: `{ rights, policy: { mode, recipients: [jid] }, ipAllow, expiresAt }` + optional `name`, `limits`; state: `{ enabled, plainHttpFrom }`; `before: null` = creation; reasons in server order). AUTH-7 answers `{ confirmedUntil, windowMs: 300000 }`; `auth.requireRecent` is synchronous; a missing gate fails closed.
- For I-UI: mount `<ReauthDialog />` in `app.mjs`, export `ReauthDialog, ReauthView` from `components/index.mjs`; `ReauthView` takes `request = { id, reasons }` and `onResolve`; `withStepUp(run, { needed, reasons, ask, now })` (`now` is a function); `viewGuard.fetch(routes)` handlers return `answer(...)`; after `dom.type`, `dom.settle(2)` before submit. `buildRequest` omits optional booleans equal to their default; `fieldKeys(...).option(v)` -> `...option.<v>`; extras `ipRowsError(parsed, { max, networks })`, `failureText(code, has)`, `validateHistoryFilters`; recipient value `group: null | { jid, name }`.
- `panel-api.json`: 470 keys per language (338 fixed + 132 registry-driven), merged.

### W2 E-OUT session 1 (T046-T049, T058-T067)

- Tests: messaging-submit 44, messaging-outbox 72 (SC-005, both SC-006 crash windows), messaging-never-command 19, api-lifecycle 8, boot 32, pipeline 22, alerts 55, admin-alerts 31, housekeeping 26, capture-sites 19. Mutation check: five breakages turned the outbox suite red.
- Deviations: under the engine lock a replay is answered before admission (a retry never becomes `queue_full`); `validateInput` returns `quoteRef { publicId, waId, format }`; facade extras `tick(now)`, `kick()`, `outbox`; `outbox.reseed()`, `outbox.ready()`; option `autoKick: false` for tests; `apiState` awaits its listeners; concurrent `disable()` calls share one run; stored recipients parsed with a local `targetOf(jid)`. New helper `test/helpers/messagingKit.js` (real facade, in-memory DB, fake clock/socket/switch/alerts).
- For W3: H-PANEL API-2 — call `await messaging.disable()` before (or concurrently with) `apiState.setEnabled(false)` to get the cancelled count. F-PUB — `submit({ source, apiKeyId, requestId, format, to, quote, fields, media, policy, limits, idempotency, now }) -> { message, replayed, requestHash }`; `waitFor(publicId, ms) -> { promise, cancel }` (resolves to a MessageView or null); `findByIdempotency -> { message, requestHash }`.

### W2 E-OUT session 2 (T078, T085, T087, T091-T093, T123, T127, T129, T132), commit `c0acedb`

- Tests: messaging-submit 72, messaging-outbox 83, messaging-receipts 25, messaging-replies 38, api-retention 28, housekeeping 27, hooks 16 (+ the session-1 files, green). Mutation check on replies guards, decryption inputs, group check, switch gating, gate reserve.
- Facade complete: `submit`, `get`, `list`, `describeResponses(row, responses)`, `disable`, `cancelForKey`, `waitFor`, `inspectMedia`, `fetchMedia` (`source: "url"`, deletes the temp file on refusal), `sweepMedia({ now })` (once in `start()`). `submit({ media: { path, size, name?, sha256?, mode?: "move"|"copy", source?: "upload"|"url" } })`; `payload.media = { source, mime, ext, size, fileName }` (document names via `broadcaster.sanitizeName`). `get`/`list` scoped by `apiKeyId` (panel rows read as null: the panel queries the tables directly). Receipts attached by default in `createDeps` (`null` disables). A receipt `463` calls `onRestricted` only when it really failed one of our rows. `list` limit: 0/unreadable -> 25, negative -> 1, max 100. Housekeeping gains options `messaging`, `stage`, `config`, `settingsCache`.

### W2 checkpoint (T146), clean worktree at `c0acedb`

- fr 4,459 tests / 4,450 pass / **1 fail** / 8 skipped; en 4,451 / 4,442 / 1 / 8. The one failure is the expected red (`admin-integration`: AUTH-7 registered, not yet in a parsed contract; fixed by H-PANEL T141). New skip: "no argument: apireplies.js" (hook-only plugin, as designed). `0 unused dependencies`. H-PANEL (W3) started early, in parallel with E-OUT session 2, on disjoint files.

### W3 H-PANEL (T052, T069-T071, T089, T095, T103-T104, T116-T118, T135, T140-T141)

- Tests: admin-api-state 34, admin-api-keys 63 (the 67 widening rows through the pure predicate and the real routes), admin-api-messages 61 (part against the real facade via `messagingKit`), admin-api-leak 5, admin-uploads 23, admin-integration 12 (the expected red is green), admin-security 51. Mutation checks: secret logged, recipient in a creation audit, key-update step-up removed (re-run); revoke confirm and API-11 audit detail (not re-run after the final edits).
- Deviations: key names NFC (admin-api.md, not data-model's NFKC); API-11 follows the public pipeline order (`resolveRecipient` first), `submit` gets `media.mode` `copy` (upload) / `move` (URL) and `source`; `State.settings.settingKeys.alerts` nested; API-2 `enabled: true` refused 409 under a registry failure; a disable calls `messaging.disable()` then `apiState.setState` (re-enables on write failure); `orphanRights: []` under a registry failure; upload kind `animated` for GIF, `audio` for `video/webm`; `confirm` schema without `unique`.
- Panel texts added and merged: `errors.api_disabled`, eight engine refusal codes, `fields.not_found`. `main` fixed the `routes/uploads.js` header (`purpose=backup|broadcast|api`).
- For I-UI: shapes exactly as admin-api.md; a `PUT /keys/:id` with no change returns `changed: false` and the same `version`; API-11 `to` is a bare number or a group id, not a JID.
- For J-DOC: list `routes/api.js`, `services/api.js`, upload purpose `api`, the `stepUp` column of `admin.routes()` in `docs/ADMIN_PANEL.md` and `CLAUDE.md`.

### W3 F-PUB (T050, T051, T068, T079, T086, T088, T094, T124, T130, T134, T138, T139), commit `564a18b`; Request fix `f7ed151`

- Tests: api-contract 26, api-security 25, api-messages 109, api-formats-contract 39, api-openapi 22, api-leak-scan 13 (mutation: a recipient log in `messagesGet.js` turns it red), api-availability 10. Harness `test/helpers/apiHarness.js` (real `createApi`, engine via `messagingKit`, endpoints, key store, quotas, formats behind the real `createPanelServer`).
- **Defect found and fixed by `main`** (Request to D-HTTP's file): the bound `submit` of `guardMessaging` did not hand the key's policy and limits to the engine, so a key's own pending limit above the default was refused inside the engine (the policy was already enforced at pipeline step 13). `lib/api/pipeline.js` now fills `policy` and `limits.maxPending` from the key unless set; the former `todo` test is a normal test. `lib/api/index.js` exposes `openapi` in `env`, so PUB-4 serves the registry that is serving.
- Findings kept as is: a replay skips query validation (`messagesCreate` re-validates `wait`); a queued poll shows `responses.totals = null` until it is built (options become `choices` at the claim); the 4,096-character composed-body refusal is unreachable over HTTP with the contract limits; PUB-2 with any query parameter answers 422 `$unknown`; `response.openapi` is an addition to the endpoint shape.

### W3 checkpoint (T147), clean worktree at `f7ed151`

- fr and en: **4,892 tests / 4,884 pass / 0 fail / 8 skipped / 0 todo**; `0 unused dependencies`; `admin-integration` green (14 routes, `auth: "session"`, the `stepUp` set). I-UI (W4) started at `c7ac1e1`, in parallel with F-PUB, on disjoint files.

### W4 I-UI (T053-T055, T072-T073, T090, T096, T105-T107, T119-T121, T136, T142), commit `1738990`

- 17 views `lib/admin/public/js/views/api*.mjs`, shell edits (`router.mjs`, `app.mjs` mounts `<ReauthDialog />`, `components/index.mjs`, icons `i-api`/`i-copy`, `.code-block`), audit and alerts logic, six `alerts.type_api_*` titles in the 002 fragment `panel-alerts.json`. Tests: admin-view-api 37, admin-view-api-messages 15, admin-view-api-test 30, admin-view-api-guards 5, admin-frontend 41 (contract test 11 with API-1..13 and AUTH-7), admin-i18n 24, admin-view-alerts 12, admin-view-logs-stats 27; each view test file about 1-1.6 s, no guard trip. Mutations caught: step-up removed in `saveKey`, secret in a toast, the 3-error poller stop removed, a re-render loop.
- Deviations: `RepeatedItems` gets a label heading and `data-list/add/remove` attributes; `TestTab`/`DocsTab` accept an optional `deps` prop; `useMessage` treats "no answer yet" as not settled; `saveKey` returns an outcome object; a registry failure with `endpoint: null` shows `?`. A 14th synthetic format renders in Test, Docs and the key editor without SPA edit.
- W4 also runs J-DOC (docs, memory modes) and, in parallel, the read-only review R-REV (T154) since the code is complete.
