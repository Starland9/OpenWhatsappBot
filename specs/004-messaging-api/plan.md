# Implementation Plan: API d'envoi de messages

**Branch**: `004-messaging-api` | **Date**: 2026-11-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-messaging-api/spec.md`

## Summary

An external program can make the bot send a WhatsApp message in any of 13 formats through a versioned HTTP API, `/api/v1`. That API is a modular base for future endpoints, with security first.

- **Public API (`lib/api/`).** It is mounted in the panel's HTTP server before the legacy routes and exists only when the panel is on and the API switch is enabled; otherwise every `/api/v1` URL answers like any unknown URL. Its own router serves endpoint modules (`lib/api/endpoints/*.js`), and each module declares a right or the registry refuses to build. A 20-step pipeline handles every request, in the order of [contracts/public-api.md](contracts/public-api.md) section 5:
  - HTTPS, except from loopback or from the private networks the owner lists;
  - no browsers;
  - key never in the URL;
  - origin blocking;
  - `Authorization: Bearer owbk_<id>_<secret>` (SHA-256 at rest, constant-time compare);
  - key state;
  - IP allowlist;
  - right;
  - recipient policy and disabled chat;
  - idempotency;
  - quotas and admission;
  - strict validation;
  - media (hand-written multipart parser, SSRF-safe URL fetcher).

  Errors use the panel's envelope with stable codes.
- **Messaging engine (`lib/messaging/`).**
  - **Formats.** A registry loads 13 format modules (text, image, video, gif, audio, voice, document, sticker, location, contact, poll, buttons, list). Each declares its fields, media rules, conversion, Baileys content, reply interpretation, documentation and panel form.
  - **Outbox.** A persisted queue in `api_messages`. A process-wide send gate (`lib/utils/sendGate.js`) paces API sends and broadcasts together, at least 2 s plus 0-20 % jitter.
  - **Delivery guarantees.** Delivery is at most once: the outbox pre-generates the WhatsApp id and marks the row `sending` before calling `sendMessage`, and a row still `sending` after a restart becomes `unknown`. Messages expire, the queue pauses after 3 `463` rejections in 10 minutes, and waiters back the `wait` option.
  - **Receipts and replies.** Private-chat receipts are captured. Button, list and poll replies go through a hook-only plugin, with votes decrypted from a stored secret and option digests.
  - **Never a command.** Own sends are `append` upserts, dropped by `client.js`; a `sentIds` guard in `pipeline.js` backs this up, and sending to the bot's own number is refused.
- **Data.** Four new tables: `api_keys`, `api_messages`, `api_message_responses`, `api_state`. The content of a queued message is erased with its terminal status, and short choice labels are kept with the responses. All four tables are excluded from backups. There are 11 panel-only settings, and housekeeping covers retention, idempotency release and the media sweep.
- **Panel.** A new "API" area has five tabs: Keys, History, Usage, Test, Docs. It is served by 13 routes API-1..13 and AUTH-7 (re-authentication).
  - **Re-authentication.** Any change that widens access needs the password (5-minute window, opened by login or by AUTH-7). The widening predicate lives on the server and is mirrored in the SPA.
  - **Keys.** A key's secret is shown once.
  - **Test form.** It is generated from the format descriptors and goes through the same engine.
  - **Alerts.** Three new types: `api_origin_blocked`, `api_key_new_ip`, `api_paused`.

Decisions: [research.md](research.md) (owner decisions U1-U15, arbitration X1-X22, Phase 1 alignment Y1-Y17).

## Technical Context

**Language/Version**: JavaScript, CommonJS on the bot side and native ES modules (`.mjs`) in the panel SPA; Node >= 24 (`package.json` engines). No build step.

**Primary Dependencies**: Baileys v7 (rc14), Sequelize (SQLite, or Postgres when `DATABASE_URL` says so), pino through `lib/utils/logger.js`, `file-type`, `sharp`, `node-webpmux`, ffmpeg (system), vendored Preact + htm for the panel. Node built-ins `node:https`, `node:net` (`BlockList`), `node:crypto`. **No new dependency** (multipart parser hand-written, research A6).

**Storage**: the existing database through Sequelize, new tables only (additive `sync()`); staged media under `data/api-media/<publicId>/`; key cache `api_keys` in `lib/utils/settingsCache.js`; in-memory quota counters, origin limiter and step-up window.

**Testing**: `node:test` (about 2,400 tests today), in-memory SQLite, `test/helpers/` (fakes, adminHarness, adminClient, fakeClock, fakeDom) plus new `apiHarness.js`, `apiInvariants.js`, `viewGuard.js` and fixtures `api-ip-entries.json`, `api-widenings.json`. No network, no WhatsApp: the URL fetcher is tested through an injected resolver/connector.

**Target Platform**: Linux server or container (Docker, PM2) behind an HTTPS proxy or host; callers are programs (n8n, scripts, back ends); the panel runs in current browsers.

**Project Type**: a single Node process (WhatsApp bot) serving its admin panel and, now, a public JSON API on the same HTTP server.

**Performance Goals**:

- a text request is accepted in under 1 s (SC-010);
- sends are paced at one every 2 to 2.4 s across the API and broadcasts (SC-005);
- a warm request costs no database query for the key lookup (cache `api_keys`).

**Constraints**:

- API off by default; when off, nothing runs and every `/api/v1` URL answers like an unknown URL (FR-001);
- secrets and content never reach logs, audit, history or answers (SC-003);
- at most once (SC-006);
- never a command (SC-008);
- the SSRF battery passes (SC-007);
- memory: API disabled is +0, enabled and idle is under +20 MB (SC-011, `tools/measure-panel-memory.js`);
- the project rules hold: one pipeline, capture-site rule, `en`/`fr` with the same keys, strict CSP, every panel route declares `auth`.

**Scale/Scope**:

- 13 formats, 4 public endpoints (PUB-1..4), 16 rights, 13 + 1 panel routes, 4 tables, 11 settings, 3 alert types;
- about 45 new source files, about 30 edited, about 45 new test files;
- 64 functional requirements, 11 success criteria.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the unfilled template. The provisional gates are those of features 001-003, taken from `CLAUDE.md`, plus one gate for the public API:

| Gate | Pre-research | Post-design |
| ---- | ------------ | ----------- |
| G1 Settings read through `config.js` at call time; no capture of `config.X` | ✅ 11 settings planned | ✅ panel-only catalog entries, read at call time, no timer built from a setting (RT-03); `capture-sites` pinned; the switch and the plain-HTTP list are state, not settings (X1) |
| G2 No new dependency without justification | ✅ none planned | ✅ none: multipart hand-written, fetcher on `node:https` + `net.BlockList` |
| G3 One message pipeline and one registry | ✅ | ✅ the only `pipeline.js` change is the `sentIds` guard; replies go through a hook-only plugin (`plugins/apireplies.js`, priorities 5 and 6, `test/hooks.test.js` updated); no client change |
| G4 User-facing text via `getLang` / `t()`; `en` and `fr` with the same keys | ✅ | ✅ panel fragments `panel-api.json`, `panel-api-server.json`; bot fragment for alerts; OpenAPI is English only (U8), a developer artifact, not user-facing text |
| G5 Additive schema changes | ✅ new tables only | ✅ 4 new tables; unique indexes on new tables only; nothing altered ([data-model.md](data-model.md)) |
| G6 Panel security (auth, CSRF, strict schema, audit, `confirm` for destructive routes) | ✅ | ✅ 14 session routes; step-up on widening (FR-021); `confirm` on revoke/disable; audit `api.*`, `account.confirm` ([contracts/admin-api.md](contracts/admin-api.md)) |
| G7 Engines layering (engines never require `lib/admin/**` except the log leaves) | ✅ | ✅ RT-01, with one documented exception: `apiState` lazily requires the dependency-free leaf `lib/api/ipRules.js` |
| G8 (new) Public API security: every endpoint declares a right, no public endpoint, key never in URL/logs/answers, SSRF-safe fetch, no browser access | n/a | ✅ registry build fails without a right; route-table enumeration, leak scan and SSRF battery in the suite ([contracts/public-api.md](contracts/public-api.md), [contracts/runtime.md](contracts/runtime.md)) |

## Project Structure

### Documentation (this feature)

```text
specs/004-messaging-api/
├── spec.md              # /speckit-specify + /speckit-clarify
├── plan.md              # This file
├── research.md          # Phase 0 decisions (U1-U15, X1-X22, Y1-Y17)
├── research/            # streams A (HTTP, security), B (engine), C (data, panel backend), D (panel UI)
├── data-model.md        # Phase 1: 4 tables, status machine, payload shapes, retention
├── quickstart.md        # Phase 1: automated checks, curl walkthrough, panel walkthrough, phone checklist
├── contracts/
│   ├── public-api.md    # PUB-1..4, bodies per format, pipeline, error catalogue, quotas, idempotency, SSRF
│   ├── runtime.md       # module contracts lib/messaging, lib/api, utils, edits, boot, settings, alerts
│   ├── admin-api.md     # API-1..13, AUTH-7, step-up and widening table, audit
│   └── panel-ui.md      # views, logic, step-up flow, screens, i18n keys, render guards
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
lib/
├── api/                                   # NEW public API (contracts/runtime.md section 15)
│   ├── index.js, router.js, registry.js, pipeline.js, transport.js, errors.js, version.js
│   ├── keyStore.js, limits.js, idempotency.js, ipRules.js, multipart.js, upload.js
│   ├── openapi.js, present.js
│   └── endpoints/{messagesCreate,messagesGet,messagesList,openapiJson}.js
├── messaging/                             # NEW engine (sections 1-10)
│   ├── index.js, errors.js, limits.js, outbox.js, recipients.js, sentIds.js
│   ├── replies.js, receipts.js, urlFetch.js, sniff.js, stage.js, vcard.js
│   └── formats/{index,text,image,video,gif,audio,voice,document,sticker,location,contact,poll,buttons,list}.js
├── utils/
│   ├── schema.js, sendGate.js, apiState.js, stickerMaker.js        # NEW
│   ├── broadcaster.js (send gate), permissions.js (parsePhoneNumber), knownChats.js (isKnown),
│   │   alerts.js (3 types), housekeeping.js (5 steps), settingsCatalog.js (11 entries), settingsCache.js (comment)
├── core/boot.js (ENGINES += messaging, apiState), core/pipeline.js (sentIds guard)
├── classes/Message.js (2 exports)
├── database/models/{ApiKey,ApiMessage,ApiMessageResponse,ApiState}.js   # NEW; AlertOutbox.js (TYPES)
└── admin/
    ├── server.js, index.js                # api mounting
    ├── http/{trustProxy,security,response,request,router}.js   # clientAddress, profile api, schema re-export, stepUp
    ├── auth/{sessions,index}.js, routes/auth.js                # step-up window, AUTH-7, login sets confirmation
    ├── logs/redactor.js                   # built-in key pattern
    ├── audit.js, backup/format.js         # api.* actions; EXCLUDED_MODELS += 4
    ├── routes/api.js, services/api.js     # NEW API-1..13
    ├── services/permissions.js, services/alerts.js, http/uploads.js (purpose api)
    └── public/
        ├── js/components/reauth-dialog.mjs, nav.mjs, ...          # NEW dialog; nav entry
        ├── js/views/api*.mjs (api, api-logic, api-form-logic, api-keys, api-key-editor, api-rights,
        │   api-recipients, api-ips, api-networks, api-secret, api-state, api-history, api-message,
        │   api-usage, api-test, api-form, api-watch, api-docs, api-key-actions), audit-logic.mjs, alerts-logic.mjs
        └── i18n/{en,fr}.json              # merged from specs/004-messaging-api/i18n/panel-*.json
plugins/
├── apireplies.js                          # NEW hook-only plugin
├── buttons.js (pure builders + no-fallback sender), sticker.js (uses stickerMaker)
lang/{en,fr}.json                          # alert texts, merged from specs/004-messaging-api/i18n/bot-api.json
tools/panel-memory-child.js                # modes api-off / api-on
test/                                      # see the "Test obligations" of each contract
docs/API.md (NEW, user guide), CLAUDE.md, README links          # docs
```

**Structure Decision**: same single-process layout as features 001-003. The feature adds two top-level library directories (`lib/api`, `lib/messaging`) so that the public API and the send engine are modules of their own. `lib/messaging` is an engine (it never requires `lib/admin`). `lib/api` is an HTTP layer beside the panel that reuses only its HTTP helpers, its rate limiter and its log redactor. New endpoints and formats are new files in `lib/api/endpoints/` and `lib/messaging/formats/` (FR-092).

## Execution Strategy (models and parallelism)

The user's standing rules apply:

- `/speckit-implement` runs on **Sonnet 5.5 subagents**; **Opus 5.5 only in extreme necessity**.
- **At most 2 implementation agents alive at once.** Every test run is memory-capped and time-limited; agents run single test files (`timeout 120 node --max-old-space-size=1024 --test --test-force-exit --test-timeout=30000 test/<file>.test.js`) and never the full suite. The orchestrator runs the full suite once per wave: `NODE_OPTIONS=--max-old-space-size=1024 timeout 600 yarn test`, never two at a time.
- Each agent owns a disjoint set of files. Agents never commit; the orchestrator commits after each finished agent, in French conventional commits on `004-messaging-api`.
- Agents never read `config.env`, `sessions/`, `data/` or the database, and run scripts with `OWB_NO_CONFIG_ENV=1`.
- The shared catalogs (`lang/*.json`, `lib/admin/public/i18n/*.json`) and shared test helpers have **one owner per wave**.

| Wave | Agent | Content | Needs |
| ---- | ----- | ------- | ----- |
| W0 Foundation | a | `lib/utils/schema.js` (+ `request.js` re-export), `sendGate.js` + broadcaster change, `permissions.parsePhoneNumber` (+ panel permissions service), `knownChats.isKnown`, `stickerMaker.js` (+ sticker plugin), `plugins/buttons.js` builders split, `Message.js` exports; their tests | — |
| | b | 4 models, `apiState.js`, backup `EXCLUDED_MODELS`, 11 settings + their panel labels (owns the panel catalogs in W0), `AlertOutbox.TYPES`, `apiInvariants.js` helper; database/backup/settings tests | — |
| W1 Cores | c | `lib/messaging` part 1: `errors`, `limits`, format registry + 13 modules, `vcard`, `sniff`, `stage`, `recipients`, `urlFetch` + link preview; their tests (incl. SSRF battery) | a, b |
| | d | `lib/api` core: `errors`, `router`, `registry`, `pipeline`, `transport`, `keyStore`, `limits`, `idempotency`, `ipRules` (+ fixture), `multipart`, `upload`, `version`, `openapi` skeleton, `index`; edits to `server.js`, `admin/index.js`, `trustProxy`, `security`, `response`, `redactor`; tests against a fake engine (incl. `panel-legacy` edits) | a, b |
| W2 Engine + step-up | e | `lib/messaging` part 2: `outbox`, facade `index`, `replies`, `receipts`, `sentIds`, `plugins/apireplies.js`, `pipeline.js` guard, boot wiring, housekeeping steps, alerts (3 types; owns `lang/*.json` in W2 for alert texts); their tests | c |
| | g | Step-up backend (sessions window, login sets it, router `stepUp`, `ctx.stepUp()`, AUTH-7, shared limiter, audit `account.confirm`); pure SPA logic `api-logic.mjs`, `api-form-logic.mjs`, `reauth-dialog.mjs`, `viewGuard.js`, fixture `api-widenings.json`; their tests | a |
| W3 Endpoints + panel backend | f | Endpoints PUB-1..4, `present.js`, OpenAPI complete, `apiHarness.js`; contract, security, leak-scan, quotas, idempotency, availability and OpenAPI tests | d, e |
| | h | `routes/api.js` + `services/api.js` (API-1..13, widening predicate on the shared fixture), uploads purpose `api`, audit `api.*`, alerts service and settings shown, `admin-integration` contract parser; `panel-api-server.json` (owns the panel catalogs in W3); admin tests | d, e, g |
| W4 Panel UI + docs | i | Views `api*.mjs`, nav, icons, CSS, audit/alerts logic rows, `panel-api.json` + merge (owns the panel catalogs in W4); view tests (one file at a time, render guards) | g, h |
| | j | `docs/API.md` (user guide, French), `CLAUDE.md` (architecture sections for `lib/api`, `lib/messaging`, settings, tests), README links, `tools/panel-memory-child.js` modes, `docs/AUDIT_COMMANDES.md` note if a command changes (`buttons`, `sticker`) | f, h |
| W5 Integration | orchestrator | full suite once (fr, then en), `node tools/check-unused-deps.js`, `tools/measure-panel-memory.js`, quickstart automated checks, fixes routed back to the owning agent's files | all |

Tasks in `tasks.md` carry their wave, their model (`sonnet` by default) and the files they own. `tasks.md` refines this table where a dependency forces it (its Notes list each move: `lib/messaging/{errors,limits}.js` to A-UTIL, `ipRules.js` to B-DATA, the alerts service to E-OUT, `panel-api.json` to G-STEP in W2, `bot-api.json` to B-DATA in W0); `tasks.md` wins. Opus is planned for nothing. The orchestrator escalates a task to Opus only if a security-critical piece (pipeline order, key store, URL fetcher, outbox at-most-once) fails review twice.

## Complexity Tracking

| Deviation | Why Needed | Simpler Alternative Rejected Because |
| --------- | ---------- | ----------------------------------- |
| Second router (`lib/api/router.js`) beside the panel router | Bearer auth, no cookies, no CSRF, `/api/v1` prefix, dynamic rights; keeps FR-004 structural | Generalising `lib/admin/http/router.js` would weld two security models into one pinned table (`test/admin-security.test.js`) |
| Hand-written multipart parser | One JSON part + one file part, streamed with an early byte cap | `busboy` would be the first new dependency since feature 001 (G2); the restricted parser was fuzzed in the spike (2,800 random splits) |
| Hand-checked poll-vote mapping and decryption call | Baileys rc14 has the aggregation path commented out | Waiting for Baileys would leave polls without results (FR-072) |
| `apiState` requires the leaf `lib/api/ipRules.js` | One CIDR grammar for the IP allowlist and the plain-HTTP list | Duplicating the parser would let the two lists drift |
