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
