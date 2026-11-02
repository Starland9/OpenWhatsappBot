# Contract: panel UI (feature 004)

The "API" area of the admin SPA: the page that switches the messaging API on and off, manages keys, shows the history and usage, sends a test message and documents the API. Everything here is browser-side. Routes and answers are in [admin-api.md](admin-api.md) (API-1 to API-13 under `/admin/api/api`, and AUTH-7 `POST /admin/api/session/reauth`); the public surface is [public-api.md](public-api.md); the format registry and its `describe(name)` descriptors are produced by `runtime.md` (this folder); tables are in [../data-model.md](../data-model.md).

Where [../research/d-panel-ui.md](../research/d-panel-ui.md) (stream D) disagrees with [../research.md](../research.md), research.md wins (U1, U2, U10, U11; X6 descriptor shape and key convention, X7 routes, X8 step-up, X9 alerts), then [admin-api.md](admin-api.md) for every route, shape and code, then this file. The points settled while writing are in [section 12](#12-points-settled-while-writing-this-contract).

Contents: [1 files](#1-files) / [2 API calls](#2-api-calls-per-file) / [3 data shapes](#3-data-shapes) / [4 api-logic.mjs](#4-api-logicmjs) / [5 api-form-logic.mjs](#5-api-form-logicmjs) / [6 step-up](#6-step-up-reauthmjs-and-the-password-dialog) / [7 screens](#7-screens-and-states) / [8 degraded states and deep links](#8-degraded-states-and-deep-links) / [9 render-loop guards](#9-render-loop-guards) / [10 CSP, CSS, accessibility](#10-csp-css-and-accessibility) / [11 panel texts](#11-panel-texts-fragments-merge-and-the-i18n-test) / [12 settled points](#12-points-settled-while-writing-this-contract) / [13 test obligations](#13-test-obligations)

## 1. Files

All paths are under `lib/admin/public/js/` unless stated. Every new file is a native ES module (`.mjs`), has no DOM access and no timer at import (`test/admin-frontend.test.js:240` imports each one in plain Node), reads `location`, `navigator` and clocks lazily inside functions. `views/api.mjs` is the area view; `js/api.mjs` is the HTTP client (views import it as `../api.mjs`); `views/api.mjs` keeps a one-line comment saying which is which.

### 1.1 New files

| File | Exports | Role |
| ---- | ------- | ---- |
| `views/api.mjs` | `meta = { area: "api", titleKey: "api.title", icon: "api" }`, default `ApiView({ route })` | Loads API-1, API-3, API-4 once (three `useAsync`, deps `[]`), owns the secret-once state, dispatches `route.rest` to the editor, the message detail or the tabbed page, renders the header, `StateBanners`, `EnableCard` and the five tabs ([section 7.1](#71-apiview-routes-and-tabs)). |
| `views/api-logic.mjs` | [section 4](#4-api-logicmjs) | Pure: keys, drafts, rights, recipients, IP grammar, step-up predicate, history, usage, polling delay, clipboard. |
| `views/api-form-logic.mjs` | [section 5](#5-api-form-logicmjs) | Pure: descriptor to form model, validation, request body, server error mapping, curl examples, text keys of a descriptor. |
| `views/api-state.mjs` | `EnableCard`, `StateBanners`, `LimitsSummary` | The switch (enable and disable flows), the banners (registry failure, pause, bot offline, plain-HTTP panel) and the read-only summary of the limits with links to Settings and Alerts. |
| `views/api-networks.mjs` | `NetworksCard` | The plain-HTTP networks list (U1): `IpListEditor` in private-only mode, draft and Save. |
| `views/api-keys.mjs` | `KeysTab` | The key list, row actions, the empty state, and the `NetworksCard` below the table. |
| `views/api-key-actions.mjs` | `askAnyone`, `askRevoke`, `saveKey`, `duplicateKey`, `revokeKey` | Every key write of the SPA in one file: the literals of [section 2](#2-api-calls-per-file), the confirmations, `withStepUp`. Shared by the list and the editor. |
| `views/api-key-editor.mjs` | `KeyEditor` | The routed editor: draft, sections, Save, dirty guard. |
| `views/api-rights.mjs` | `RightsChecklist` | Rights grouped from the catalogue, orphans. |
| `views/api-recipients.mjs` | `RecipientsEditor`, `GroupPicker` | Policy radios, chips, the 003 `PersonPicker` for numbers, the group picker. |
| `views/api-ips.mjs` | `IpListEditor` | Row list of IP entries with aggregated row errors; shared by the key editor and `NetworksCard`. |
| `views/api-secret.mjs` | `SecretOnceDialog` | The modal that shows a new secret once. |
| `views/api-history.mjs` | `HistoryTab` | Filters, table, pagination. |
| `views/api-message.mjs` | `MessageDetail`, `MessageSteps`, `ResponsesCard` | The detail page; the steps and responses parts are reused by the test result card. |
| `views/api-watch.mjs` | `useMessage` | The bounded status poller of one message. |
| `views/api-usage.mjs` | `UsageTab` | Per key and day. |
| `views/api-test.mjs` | `TestTab`, `ResultCard` | The test form shell and the result card. |
| `views/api-form.mjs` | `DescriptorForm`, `RecipientField`, `MediaField`, `RepeatedItems`, `removeUpload` | The generic descriptor renderer. |
| `views/api-docs.mjs` | `DocsTab` | Quick start, endpoints, examples per format, OpenAPI download. |
| `reauth.mjs` | `reauthStore`, `requestReauth`, `resolveReauth`, `withStepUp`, `isConfirmed`, `markConfirmed`, `syncConfirmation`, `forgetConfirmation`, `submitPassword`, `classifyReauthError`, `REAUTH_PATH` | Shell-level step-up flow ([section 6](#6-step-up-reauthmjs-and-the-password-dialog)). Not under `views/` because any later area can reuse it. |
| `components/reauth-dialog.mjs` | `ReauthDialog`, `ReauthView` | The password modal and its host. |

### 1.2 Edits to existing files

| File | Change |
| ---- | ------ |
| `router.mjs` | `AREAS` gains `{ area: "api", titleKey: "api.title", icon: "api" }` right after `broadcasts` (both are outbound-message areas); `VIEW_LOADERS.api = () => import("./views/api.mjs")`. `Nav` is driven by `AREAS.map` (`components/nav.mjs`), so it needs no change; it labels `nav.api`. |
| `../icons.svg` | Two 24x24 stroke symbols in the style of `i-broadcasts`: `i-api` (the area icon; `test/admin-frontend.test.js:258` demands it) and `i-copy`. |
| `../css/app.css` | One class, `.code-block` ([section 10](#10-csp-css-and-accessibility)). |
| `app.mjs` | Imports `ReauthDialog` from `components/index.mjs` and mounts `<${ReauthDialog} />` next to `<${ConfirmDialog} />` (`app.mjs:189`). |
| `components/index.mjs` | `export { ReauthDialog, ReauthView } from "./reauth-dialog.mjs";`. |
| `views/audit-logic.mjs` | `ACTION_PREFIXES` gains `"api"` after `"broadcast"`; `dayBound` becomes an export (the history filters reuse it); `summarizeDetail` gets the `api`, `networks` and `retry` branches ([section 11.5](#115-audit-and-alerts-pages)). |
| `views/audit.mjs` | `Detail` renders the three new kinds. |
| `views/alerts-logic.mjs` | `ALERT_TYPES` gains `api_origin_blocked` / `ALERT_API_ORIGIN_BLOCKED`, `api_key_new_ip` / `ALERT_API_KEY_NEW_IP`, `api_paused` / `ALERT_API_PAUSED`, appended in that order after `update_available` (the order of the server list, [admin-api.md](admin-api.md) 1.8). `alerts.mjs` is not edited: it iterates `ALERT_TYPES`. |
| `lib/admin/public/i18n/{en,fr}.json` | Generated by the merges of [section 11.2](#112-fragments-and-merge). Never edited by hand. |

Nothing else under `lib/admin/public/` changes. No `settings-logic.mjs` edit: the eleven new settings live in the existing `limits` and `alerts` themes ([admin-api.md](admin-api.md) 1.8), which `THEME_ORDER` already lists.

Server-side edits that these views depend on (owned by [admin-api.md](admin-api.md) and `runtime.md`): the routes API-1..13 and AUTH-7 registered, upload purpose `api`, the registry. The views merge **after** the routes: contract test 11 (`test/admin-frontend.test.js:1102`) fails on a path literal without a registered route.

## 2. API calls per file

Every `/admin/api/...` literal must match a registered route, by method and shape. The scanner (`test/admin-frontend.test.js:1029-1100`) resolves `const <name> = "<path>"` prefixes declared **in the same file**, then `${name}/suffix`. Therefore each file below declares `const base = "/admin/api/api";` once, at the top, and builds every call from it. Path parameters are `encodeURIComponent`-ed. A `DELETE` always has a suffix after the prefix.

| File | Exact literal | Route |
| ---- | ------------- | ----- |
| `views/api.mjs` | `api("GET", base)`; ``api("GET", `${base}/catalog`)``; ``api("GET", `${base}/keys`)`` | API-1, API-3, API-4 |
| `views/api-state.mjs` | ``api("PUT", `${base}/state`, { enabled: true })``; ``api("PUT", `${base}/state`, { enabled: false, confirm: true })`` | API-2 |
| `views/api-networks.mjs` | ``api("PUT", `${base}/state`, { enabled: state.enabled, plainHttpFrom: values })`` | API-2 |
| `views/api-key-actions.mjs` | ``api("POST", `${base}/keys`, body)``; ``api("PUT", `${base}/keys/${encodeURIComponent(id)}`, body)``; ``api("POST", `${base}/keys/${encodeURIComponent(key.id)}/duplicate`, {})``; ``api("POST", `${base}/keys/${encodeURIComponent(key.id)}/revoke`, { confirm: true })`` | API-5, API-6, API-7, API-8 |
| `views/api-history.mjs` | ``api("GET", `${base}/messages`, historyQuery(applied, page))`` | API-9 |
| `views/api-watch.mjs` | ``api("GET", `${base}/messages/${encodeURIComponent(id)}`)`` | API-10 |
| `views/api-usage.mjs` | ``api("GET", `${base}/usage`, usageQuery(days, keyId))`` | API-12 |
| `views/api-test.mjs` | ``api("POST", `${base}/test`, body)`` | API-11 |
| `views/api-docs.mjs` | ``download("GET", `${base}/openapi`, undefined, OPENAPI_FILE)`` | API-13 |
| `views/api-form.mjs` | ``upload(file, "api", file.name, onProgress)`` (the client builds `PUT /admin/api/uploads?purpose=api`); ``api("DELETE", `/admin/api/uploads/${encodeURIComponent(id)}`)`` | UP-1 with `purpose=api`, UP-2 |
| `views/api-recipients.mjs` | ``api("GET", "/admin/api/chats", recipientChatQuery({ kind: "group", q, page }))`` | CHAT-1 (unchanged) |
| `reauth.mjs` | `export const REAUTH_PATH = "/admin/api/session/reauth";` and `api("POST", REAUTH_PATH, { password })` | AUTH-7 |

Notes:

- API-2 is declarative: `enabled` is required and a present `plainHttpFrom` replaces the stored list, an absent one leaves it alone. The enabling PUT of `api-state.mjs` therefore sends `enabled` only; the PUT of `api-networks.mjs` sends the current `enabled` with the list, so a pure networks edit never flips the switch. Both files take `state` from API-1, reloaded after every write.
- `recipientChatQuery` is the API twin of `chatQuery` of `permissions-logic.mjs` (section 4.4); `PersonPicker` keeps its own `kind=private` call, unchanged.
- API-13 is a download: the file name comes from `Content-Disposition` (`openwhatsappbot-api-v1.openapi.json`); `OPENAPI_FILE` is the fallback only.
- The confirmation guards of `test/admin-frontend.test.js` (`CONFIRMED_ACTIONS`, `:1135-1170`, and the second scan, `:1174`) are extended in [section 13](#13-test-obligations). Their literals are the ones above, so the exact spelling is part of this contract. Each `confirm(...)` dialog must sit within 2600 characters **before** its call in the same file: `api-key-actions.mjs` defines `askAnyone` and `askRevoke` directly above `saveKey` and `revokeKey`; `api-state.mjs` defines `askDisable` directly above the disable call.
- No call uses `fetch`, `XMLHttpRequest` or `EventSource` directly; no new live topic exists (the five of `live.mjs` are pinned): the message status is polled ([section 7.8](#78-message-detail-and-live-status)).

## 3. Data shapes

As the views read them; [admin-api.md](admin-api.md) 1.2 is authoritative. Fields the views do not read are omitted.

| Name | Shape (what the SPA reads) |
| ---- | -------------------------- |
| `State` (API-1) | `{ enabled, changedAt, failure: null or { code: "registry_failed", endpoint }, queued, pausedUntil, botReady, https, baseUrl, plainHttpFrom: [string], stepUp: { confirmedUntil, windowMs }, counts: { active, expired, revoked }, settings: { minSpacingMs, perMinute, perDay, maxPending, queueMax, expiryMin, retentionDays, replyWindowDays, alerts: { originBlocked, keyNewIp, paused }, settingKeys } }`. `baseUrl` is absolute (`<origin>/api/v1`). `https` is not read (the browser decides with `isInsecureRemote()`). |
| `Catalog` (API-3) | `{ version, basePath, rights: [{ id, group, format }], formats: [Descriptor], endpoints: [{ id, method, path, rights, dynamic, idempotent, summary, body }], limits: { keyNameMax, rightsMax, recipientsMax, ipAllowMax, plainHttpFromMax, keysMax, perMinute: [min, max], perDay: [min, max], maxPending: [min, max] } }`. `endpoints[].summary` is an English literal shown as is (the documentation is English only, U8). While `State.failure` is set, `rights`, `formats` and `endpoints` are empty. |
| `Descriptor` | `{ name, right, interactive, order, labelKey, descKey, media: null or { sources: ["file","url"], accept: [mime], maxBytes, captionMax }, example, fields: [Field] }`. |
| `Field` | `{ name, type, required, labelKey, hintKey?, placeholderKey?, min?, max?, step?, signed?, pattern?, patternHintKey?, options?: [{ value, labelKey }], default?, unique?, item?: Field, items?: { min?, max?, fields: [Field] } }`. `type` is one of `text, textarea, number, boolean, select, phone, url, list, recipient`. `min` / `max` mean length (strings, in code points), value (number) or row count (list). A list has either `item` (scalar rows) or `items.fields` (object rows). The descriptor's `fields` include the common `to` (`type: "recipient"`) and `quote` (`text`); `format` is the discriminator, never a field; the media itself is `media`, never a field; `caption` is an ordinary field (`media.captionMax` is informational). Row bounds are read as `field.min ?? field.items.min` and `field.max ?? field.items.max` ([section 12](#12-points-settled-while-writing-this-contract), point 9). |
| `KeyView` | `{ id, name, last4, status: "active" or "expired" or "revoked", createdAt, updatedAt, revokedAt, expiresAt, version, lastUsedAt, lastUsedIp, seenIpCount, rights, orphanRights, policy: { mode, recipients: [{ jid, name }] }, limits: { perMinute, perDay, maxPending }, ipAllow, queued }`. A `null` limit means "the default". |
| `KeyDraft` | `{ name, rights: [id], mode, recipients: [{ jid, name }], limits: { perMinute, perDay, maxPending }, ipRows: [string], expiry: { local, original } }`. `local` is the `datetime-local` text, `original` the ISO instant of the saved key (or `null`). Owned by `KeyEditor`; never sent as is. |
| `KeyBody` | `buildKeyBody` output: exactly `{ name, rights, policy: { mode, recipients: [jid] }, limits: { perMinute, perDay, maxPending }, ipAllow, expiresAt, version?, confirm? }`. |
| `MessageRow` | `{ id, source: "api" or "panel", key: null or { id, name }, to, toName, kind: "private" or "group", format, size, status, failureCode, acceptedAt }`. |
| `MessageDetail` | `MessageRow` plus `{ publicId, waId, expiresAt, steps: [{ status, at }], interactive, responses }`; `responses` is `null` or `{ until, total, items: [{ at, author, kind: "choice" or "vote", via: "tap" or "number" or null, choices: [{ id, label }] }], totals: null or [{ id, label, count }] }` ([public-api.md](public-api.md) 4.4). A poll has one item per voter (the latest vote); a cleared vote has `choices: []`. A poll choice `id` is the zero-based option index as a string. `label` may be `null`. |
| `Usage` (API-12) | `{ timezone, from, to, keys: [{ id, name, source: "api" or "panel", revoked, days: [{ day, sent, failed }] }] }`, dense. |
| `Reauth` (AUTH-7) | `{ confirmedUntil, windowMs }`. |

## 4. `api-logic.mjs`

Pure: no DOM, no network, no timer, no `t()`. A function that needs a text returns a **panel key** (and params) and the view calls `t(key, params)`. `test/admin-view-api-logic.test.js` asserts that every key these functions can return exists in both catalogs. Imports only `personKey`, `parseNumber`, `addPerson`, `togglePerson`, `removePerson`, `hasPerson` from `permissions-logic.mjs`, `shortJid` from `groups-logic.mjs`, `localToIso`, `isoToLocal` from `broadcasts-logic.mjs`, and `dayBound`, `validateFilters` from `audit-logic.mjs` (the history day filters).

### 4.1 Constants

| Name | Value |
| ---- | ----- |
| `TABS` | `["keys", "history", "usage", "test", "docs"]`; `tabOf(value)` returns the value or `"keys"`. |
| `STATUSES` | `["queued", "sending", "sent", "delivered", "read", "failed", "expired", "cancelled", "unknown"]` |
| `FINAL_STATUSES` | `["failed", "expired", "cancelled", "unknown"]` |
| `POLICY_MODES` / `POLICY_RANK` | `["list", "known", "anyone"]` / `{ list: 0, known: 1, anyone: 2 }` |
| `REASONS` | `["enable", "create", "rights", "policy", "ip", "expiry", "plain_http"]`, the server order ([admin-api.md](admin-api.md) 1.5). Text key `api.reason_<code>`. |
| `RIGHT_GROUPS` | `["send", "read", "media", "docs"]` (an unknown group sorts after them, alphabetically, text `api.right_group_other`). |
| `DEFAULT_LIMITS` | the fallback when `catalog.limits` is missing: `{ keyNameMax: 64, rightsMax: 64, recipientsMax: 200, ipAllowMax: 50, plainHttpFromMax: 50, perMinute: [1, 1000], perDay: [1, 100000], maxPending: [1, 5000] }`. |
| `POLL` | `{ fastMs: 2000, fastCount: 15, slowMs: 10000, maxPolls: 60 }` |
| `STEP_UP_MARGIN_MS` | `2000` |

### 4.2 Keys: state, list, draft

| Function | Semantics |
| -------- | --------- |
| `keyState(key, now)` -> `"active" or "expired" or "revoked"` | The server `status`, except that `"active"` with `expiresAt <= now` reads `"expired"` (a page left open past an expiry). Unknown values read `"revoked"` (the safe, read-only side). |
| `isEditable(key)` / `canDuplicate(key)` / `canRevoke(key)` | `keyState !== "revoked"` / `=== "active"` (API-7 refuses an expired or revoked source) / `!== "revoked"`. An expired key stays editable so its expiry can be extended ([admin-api.md](admin-api.md) API-6). |
| `visibleKeys(items, { showRevoked, now })` -> `[KeyView]` | Active and expired first (case-insensitive name order, then id), revoked last (newest revocation first). Without `showRevoked` the revoked are dropped. Input not mutated. |
| `activeNames(items, exceptId)` -> `[string]` | Lower-cased trimmed names of the non-revoked keys other than `exceptId` (the duplicate-name pre-check). |
| `keyRow(key, { settings, now })` -> object | The list cell model: `{ id, name, last4, state, rightsCount, rightsPreview: [id] (first 3), rightsMore, policy: { mode, count }, limits: [{ name, value, isDefault }] (value = own limit or the default from `settings`), ipCount, expiresAt, lastUsedAt, lastUsedIp, createdAt, queued }`. |
| `draftOf(key)` -> `KeyDraft` | From a saved key; from `null` a new draft: empty name, no right, `mode: "list"`, no recipient, three `null` limits, no IP row, empty expiry. Rights sorted; recipients sorted by `personKey`; `expiry.local = isoToLocal(expiresAt)`, `expiry.original = expiresAt`. |
| `diffKey(saved, draft)` -> `{ sections, rightsAdded, rightsRemoved, recipientsAdded, recipientsRemoved }` | `sections` lists the changed ones among `name` (trimmed), `rights`, `policy` (mode), `recipients`, `limits`, `ip` (trimmed non-blank rows, order-insensitive), `expiry` (`local` differs from `isoToLocal(original)`). `saved === null` compares to `draftOf(null)`. Set-based on `personKey` for recipients. |
| `isDirty(saved, draft)` / `pendingCount(saved, draft)` | `sections.length > 0` / added + removed rights and recipients plus one per other changed section. An untouched new draft is not dirty. |

### 4.3 Rights

| Function | Semantics |
| -------- | --------- |
| `rightsGroups(catalogRights, selected)` -> `[{ group, items: [{ id, format, checked }], allChecked, noneChecked }]` | In catalogue order inside a group; groups in `RIGHT_GROUPS` order. A catalogue right the key lacks is unchecked (deny by default, nothing to compute). |
| `toggleRight(draft, id)` / `setGroupRights(draft, catalogRights, group, on)` | New draft, rights sorted and de-duplicated; the group function touches only that group's catalogue ids. |
| `orphanRights(selected, catalogRights)` -> `[id]` | Stored ids absent from the catalogue: shown as removable chips, never togglable on. With an empty catalogue (registry failure) every right is an orphan and nothing is grantable. |
| `rightKeys(id)` -> `{ label, desc }` | `api.right.<id>.label` / `.desc`. The view falls back to the raw id (in `span.mono`) when `hasKey` is false. |
| `needsRecipients(draft)` -> boolean | A `messages.send.*` right is checked, the mode is `list` and the list is empty (the hint `api.rights_need_recipients`; not blocking). |

### 4.4 Recipients

| Function | Semantics |
| -------- | --------- |
| `recipientKind(jid)` -> `"group" or "private"` | `@g.us` suffix is a group. |
| `addRecipient(draft, entry, { max })` / `toggleRecipient` / `removeRecipient(draft, jid)` | Delegate to `addPerson`, `togglePerson`, `removePerson` on `{ people: draft.recipients }` and return `{ draft, error }` with the same errors (`duplicate`, `too_many_items { max }`, `invalid_jid`). A JID that is neither `<digits>@s.whatsapp.net` nor a group id (a LID chat of the known-contacts list) is refused with `{ code: "invalid_jid" }`: the API addresses numbers and groups only. `max` = `catalog.limits.recipientsMax`. |
| `recipientsBody(draft)` -> `[jid]` | De-duplicated by `personKey`, sorted by `personKey`, trimmed. Sent in every mode (the server keeps the list when the mode changes). |
| `recipientChatQuery({ kind, q, page, pageSize })` -> object | The CHAT-1 query of the group picker: `{ kind: "group", pageSize: 50 }` plus `page` above 1 and `q` (trimmed, 100 characters at most) when set. Never `selectable`. |
| `groupLabel(entry)` -> `{ name, id }` | The subject (or `null`) and `shortJid` of the id; the id is always shown next to the name. |

### 4.5 IP entries, expiry

The grammar is the one of `lib/api/ipRules.js` ([runtime.md](runtime.md) 15.9; [admin-api.md](admin-api.md) 1.2 still calls the module `ipList.js`; [../data-model.md](../data-model.md) `ipAllow`), pinned for both sides by the shared fixture `test/fixtures/api-ip-entries.json`: an array of `{ "input": string, "ok": boolean, "value": string }` (`value` only when `ok`; `value` is the normalised text). `parseIpEntry` must give the fixture's verdict and `value` for every row, and `parseIpEntry(value).value === value` for every valid row (idempotent, so an unchanged saved entry never differs from itself). The fixture is created with `test/api-ip-rules.test.js` ([runtime.md](runtime.md) 15.9); if its row shape differs from this one, only the loader line of the two tests changes.

| Function | Semantics |
| -------- | --------- |
| `parseIpEntry(text)` -> `{ ok: true, value, family, prefix, start, end }` or `{ ok: false, code }` | Trim, lower-case, remove a `%zone`. IPv4 `a.b.c.d` (octets 0-255, no leading zero), optional `/0-32`. IPv6: 1-8 hextets of 1-4 hex digits, one `::` at most, an embedded IPv4 tail allowed, optional `/0-128`. No wildcard, no host name, no range with a dash. An IPv4-mapped IPv6 is unmapped to IPv4. Host bits below the mask are zeroed. IPv6 is written in the canonical compressed lower-case form. `start` / `end` are `BigInt`. A blank text is `{ ok: false, code: "required" }`; anything else invalid is `invalid_format`. |
| `parseIpRows(rows, { max, privateOnly })` -> `{ values, invalid, notPrivate, duplicates, tooMany }` | Blank rows are ignored. `values`: normalised entries, first spelling wins, order kept. `invalid` / `notPrivate` / `duplicates`: the **1-based physical row numbers** (blank rows counted, so the numbers match what the owner sees). `tooMany`: more than `max` values (default `ipAllowMax`, 50). With `privateOnly` an entry outside the private ranges lands in `notPrivate`. |
| `ipRowsError(parsed, { max })` -> `{ key, params } or { code, params } or null` | First applicable: `invalid` -> `{ key: "api.ip_invalid_rows", params: { rows: "2, 4" } }` (rows joined with a comma and a space); `notPrivate` -> `{ key: "api.networks_not_private", params: { rows } }`; `tooMany` -> `{ code: "too_many_items", params: { max } }`. One message per list because `ListControl` has a single error slot. |
| `isAnyIp(value)` | `value` is `0.0.0.0/0` or `::/0` (accepted, flagged by `api.ip_any_warning`). |
| `isPrivateRange(parsed)` | The whole range lies inside `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` or `fc00::/7` (U1). |
| `ipCovered(oldValues, parsed)` | Same family and `[start, end]` inside the range of one parseable old entry (BigInt compare), the mirror of `lib/api/ipRules.js#covers`. An unparseable old entry covers nothing. |
| `expiryBody(expiry)` -> ISO or `null` | Blank `local` -> `null`. `local` equal to `isoToLocal(original)` -> `original` unchanged (a `datetime-local` drops seconds and milliseconds; an untouched expiry must not drift). Otherwise `localToIso(local)`. |
| `expiryError(expiry, now)` -> `{ code: "in_past" } or { code: "invalid_format" } or null` | Only for a **changed** expiry; an unchanged past expiry (an expired key) is not an error (the server's rule). |

### 4.6 Validation, body, server errors

| Function | Semantics |
| -------- | --------- |
| `validateKey(draft, { names, limits, now, saved })` -> `{ ok, errors }` | A courtesy mirror of the schema; `errors` is keyed `name`, `rights`, `recipients`, `perMinute`, `perDay`, `maxPending`, `ipAllow`, `expiresAt`, each `{ code, params }` or `{ key, params }` (text key). `name`: blank -> `required`; over `keyNameMax` code points -> `too_long { max }`; equal (trimmed, case-insensitive) to one of `names` -> `duplicate`. Rights over `rightsMax` -> `too_many_items`. Recipients over `recipientsMax` -> `too_many_items`. Limits: an integer inside `limits.perMinute` etc., else `out_of_range { min, max }`; blank is `null` and valid. IP rows by `ipRowsError`. Expiry by `expiryError`. |
| `buildKeyBody(draft, saved)` -> `KeyBody` | Exactly the property set of `KeyInput`, nothing else. `name` trimmed; `rights` sorted unique (orphans kept as stored); `policy.recipients` = `recipientsBody`; `limits` always the three properties (`null` for a blank); `ipAllow` = `parseIpRows(...).values`; `expiresAt` = `expiryBody`. `version = saved.version` only when `saved` exists. `confirm: ["policy_anyone"]` **only** when `mode === "anyone"` and (`saved === null` or `saved.policy.mode !== "anyone"`) -- the literal `"policy_anyone"` must appear in `api-logic.mjs`, where the confirmation guard looks for it. |
| `keyErrors(fields)` -> `{ errors, summary }` | Maps an API-5/6 `ApiError.fields` onto the editor: `name`; `rights`; `policy.mode` -> `mode`; `policy.recipients` -> `recipients` (`params.indices` becomes the row list of `api.recipients_invalid_rows`); `limits.perMinute`, `limits.perDay`, `limits.maxPending`; `ipAllow` (`indices` -> `api.ip_invalid_rows`); `expiresAt`; `version`. Every other path (`$unknown`, `confirm`, anything new) goes to `summary: [{ path, error }]`, shown in a list at the top of the editor. |

### 4.7 Step-up predicate

`widenings(before, after)` -> `[reason]` in `REASONS` order, the mirror of `lib/admin/services/api.js#widenings` ([admin-api.md](admin-api.md) 1.5). It looks only at the properties present in `after`; `before === null` is a creation.

| Reason | True when (client mirror) |
| ------ | ------------------------- |
| `enable` | `after.enabled === true` and `before.enabled === false`. |
| `create` | `before === null`. Then no other reason is computed. A duplicate is a creation: the caller passes `reasons: ["create"]` itself. |
| `rights` | a right of `after.rights` is not in `before.rights`. Stored orphans that stay are not additions. |
| `policy` | the rank of `after.policy.mode` is above the saved rank, **or** a JID of `after.policy.recipients` is not in `before.policy.recipients`, whatever the mode (by `personKey`). |
| `ip` | `before.ipAllow` is non-empty and (`after.ipAllow` is empty, or an entry of it is not covered by `before.ipAllow` by `ipCovered`). |
| `expiry` | `before.expiresAt` is set and (`after.expiresAt` is `null` or later). |
| `plain_http` | an entry of `after.plainHttpFrom` is not covered by `before.plainHttpFrom` (an empty old list covers nothing). |

Never reasons (so never prompted): name, limits, removing a right, narrowing the mode, removing a recipient, adding an IP list where there was none, narrowing an IP list, setting or advancing an expiry, removing a network, disabling, revoking. The shared fixture `test/fixtures/api-widenings.json` ([admin-api.md](admin-api.md) section 5) feeds both this function and the server one; for every row the client reasons must equal the row's `reasons` (a row may list `clientExtra` where the client is deliberately wider). The server stays authoritative: a false negative is caught by the `403 password_required` fallback ([section 6](#6-step-up-reauthmjs-and-the-password-dialog)).

### 4.8 Statuses, history, usage, polling, clipboard

| Function | Semantics |
| -------- | --------- |
| `statusTone(status)` | `sent`, `delivered`, `read` -> `ok`; `queued`, `sending` -> `info`; `failed` -> `danger`; `unknown` -> `warn`; `expired`, `cancelled` and anything else -> `neutral`. |
| `isSettled(message)` | `FINAL_STATUSES`, or `read`, or (`sent` and `kind === "group"`: a group stops at `sent`, FR-070). `delivered` is not settled (a `read` may follow). |
| `stepRows(message)` -> `[{ status, at }]` | `message.steps` ordered by time, ties by lifecycle order (`queued`, `sending`, `sent`, `delivered`, `read`, then the terminal one); with no steps, one row `{ status: message.status, at: message.acceptedAt }`. |
| `failureText(code)` -> `{ key, code }` | `key = api.failure.<code>` when `hasKey`, else `null`; the view shows the translated text and the raw code in `span.mono`, or the raw code alone. |
| `recipientCell(row)` -> `{ number, name, group }` | Private: `shortJid(to)`; group: the subject (`toName`) and the id. Recipients are not masked in the panel (FR-073 masks logs only). |
| `sourceCell(row)` -> `{ kind: "panel" or "key" or "gone", name }` | `source === "panel"`; a key with a name; `key.name === null` (purged key). |
| `authorLabel(author)` | Digits -> `+digits`; `<digits>@lid` -> `@digits`; anything else as is. |
| `choiceLabel(choice, index, format)` -> `{ label } or { key, params }` | `label` when non-null; else a poll option `{ key: "api.responses_option", params: { n: index + 1 } }`; else the `id`. |
| `pollBars(totals)` -> `[{ id, label, count, ratio }]` | `ratio = count / max count` (0 when the maximum is 0), for `<progress max="1">`. |
| `parseHistoryQuery(query)` -> filters | From `route.query`: `key` (`panel` or digits), `status` (in `STATUSES`), `format` (`^[a-z][a-z0-9_]{0,23}$`), `from`, `to` (a `YYYY-MM-DD` day). Invalid values are dropped. |
| `historyQuery(filters, page, pageSize = 25)` -> object | The API-9 query: `key`, `status`, `format` when set; `from` = start of the local day and `to` = end of the local day, as ISO instants (`dayBound` of `audit-logic.mjs`); `page`; `pageSize`. Validation of the days is `validateFilters` of `audit-logic.mjs`. |
| `historyKey(filters, page)` -> string | A primitive for `useAsync` deps: the query serialised. |
| `usageQuery(days, keyId)` -> object | `{ days: 7 or 30, key: "all" or "panel" or digits }`. |
| `usageModel(answer)` -> `[{ id, name, source, revoked, rows: [{ day, sent, failed, ratio }], totals: { sent, failed }, empty }]` | `ratio` = (sent + failed) of the day over the busiest day of that entry; `empty` when every day is zero. Order of the server kept. Days are never filled in the browser (the server answer is dense). |
| `nextPollDelay(attempt, message)` -> ms or `null` | `attempt` = polls already done. `null` when `isSettled(message)` or `attempt >= POLL.maxPolls`; `POLL.fastMs` while `attempt < POLL.fastCount`; else `POLL.slowMs`. |
| `copyText(text, env)` -> `Promise<"copied" or "manual">` | `env = { navigator, isSecureContext }`, defaulting lazily to the globals. Uses `navigator.clipboard.writeText` when it exists (a secure context: HTTPS or localhost) and resolves; `"manual"` when absent (a panel on plain HTTP on a LAN), denied or thrown. No `document.execCommand`. |
| `apiBaseUrl(state)` / `endpointUrl(state, endpoint)` | `state.baseUrl` as is; the origin of `new URL(state.baseUrl)` plus `endpoint.path`. With no usable `baseUrl`, `location.origin` (read lazily) plus `catalog.basePath`. |

## 5. `api-form-logic.mjs`

Pure. Drives the test form, the curl preview and the documentation from the descriptors of `Catalog.formats`; a new format needs no edit here (SC-009). `values` is plain data: a map from field name to a string (text, number, select), a boolean, a list of rows, or for a recipient `{ kind: "number" or "group", number, group }`; rows are `{ _k, ...values }` for object rows and `{ _k, value }` for scalar rows. Keys beginning with `__` are reserved (`__seq`, the row-key counter); a descriptor must not name a field that way.

| Function | Semantics |
| -------- | --------- |
| `orderedFormats(catalog)` | Descriptors by `order`, then name. |
| `initialValues(descriptor)` | Text, number, url, phone: `""`; boolean: `default ?? false`; select: `default ?? first option`; recipient: `{ kind: "number", number: "", group: null }`; list: `max(min, required ? 1 : 0)` empty rows. |
| `carryOver(values, descriptor)` | A fresh `initialValues` with the recipient of the old values kept (the owner changes format and keeps the number). |
| `rowBounds(field)` -> `{ min, max }` | `field.min ?? field.items.min ?? 0`, `field.max ?? field.items.max ?? Infinity`. |
| `getPath(values, path)` / `setPath(values, path, value)` | Dotted paths with numeric row indices (`buttons.1.label`, `options.2`); immutable. |
| `addRow(values, path, field)` / `removeRow(values, path, index, field)` | New values; the same object when the bound refuses (`max` for add, `min` for remove). New rows get a fresh `_k`. |
| `pathKey(parts)` | `parts.join(".")`: the syntax of the server `fields` keys. |
| `clientValidate(descriptor, values)` -> `{ [pathKey]: { code, params } }` | A courtesy mirror: `required` (blank after trim; a textarea is judged trimmed but sent as typed); `too_short` / `too_long { min / max }` (code points); `invalid_type` (number that does not parse); `out_of_range { min, max }`; `invalid_phone` (`parseNumber`); `invalid_format` (`pattern`); `not_allowed` (select value not among options); `duplicate` (`unique` list, on the repeated row, trimmed and case-sensitive); list row count against `rowBounds` (`too_short`, `too_many_items`) at the list's own path; the recipient: `required` or `invalid_phone`. Codes are the existing `fields.*` set. Media is checked in `MediaField`, not here. |
| `buildRequest(descriptor, values, { uploadId, mediaUrl })` -> flat body | `{ format, to, ...fields }` with the public property names ([public-api.md](public-api.md) section 3), the nested rows as arrays of plain objects (`_k` removed), numbers parsed (`Number`, a comma read as a point), phones as digits (`parseNumber(...).digits`), `to` = digits of the number or the group id. Optional blank strings and empty optional lists are omitted; an optional boolean is sent only when it differs from `default ?? false`. `uploadId` when a file was uploaded; `media: { url }` when the URL source is used (`MEDIA_URL_PATH = "media.url"` for error paths). No `wait`, no `idempotencyKey` (`$unknown` for the panel route). |
| `splitFieldErrors(fields, descriptor, values)` -> `{ byPath, other }` | Server `fields` (dotted keys) split into those that match a rendered control (including `media`, `media.url`, `uploadId` -> the media control, `to`, `quote`) and the rest (`$unknown`, `<path>.$unknown`, unknown paths), which the view lists under `api.test_other_errors`. A value is a `{ code, params }`. |
| `curlExample({ url, descriptor, body, fileName, source })` -> string | A shell command: `curl -X POST "<url>"`, `-H "Authorization: Bearer $OWB_KEY"` (`API_KEY_ENV = "OWB_KEY"`, the name of [public-api.md](public-api.md)). No file: `-H "Content-Type: application/json" -d '<json>'`. With a file: `-F 'message=<json>;type=application/json' -F 'file=@./<fileName>'`. `body` defaults to `exampleBody(descriptor)`. Lines are joined with ` \` and a newline. `shellQuote` closes and reopens the single quote around any `'` (`'\''`); JSON stays on one line. `source: "url"` puts `media: { url: "<url of the file>" }` in the JSON (a placeholder, never a literal address). |
| `exampleBody(descriptor)` | `{ format: descriptor.name, ...descriptor.example }` (a `format` already in the example is kept once, first). |
| `valuesFromBody(descriptor, body)` | The inverse of `buildRequest`: form values from a flat body (digits back into the number box, rows get `_k`). Used by the tests to round-trip every example through the generic renderer; a body property the descriptor does not know is ignored. |
| `panelKeysOfDescriptor(descriptor)` -> `[key]` | Every panel key the descriptor can need: `labelKey`, `descKey`, and for each field (recursively through `item` / `items.fields`) `labelKey`, `hintKey`, `placeholderKey`, `patternHintKey`, each option `labelKey`. Used by the renderer and by `test/api-panel-texts.test.js`. |
| `fieldKeys(formatName, fieldPath)` | The convention for the descriptor builder and the tests: `api.format.<name>.field.<path>.label`, `.hint`, `.placeholder` (`<path>` = field names joined by `.`, no indices); options `api.format.<name>.field.<path>.option.<value>.label`; the common fields `api.format.common.field.to.*` / `.quote.*`. |

## 6. Step-up: `reauth.mjs` and the password dialog

FR-021, US4.7, US4.8, research.md X8. The server decides ([admin-api.md](admin-api.md) 1.5); the SPA asks early when its mirror says the request widens access, and again when the server says so.

```
reauthStore = createStore({ request: null })        // ui.mjs createStore; request = { id, reasons: [string], resolve }
isConfirmed(now = Date.now())                       // localUntil > now + STEP_UP_MARGIN_MS
markConfirmed({ confirmedUntil, windowMs }, now)    // localUntil = now + windowMs (the server clock is not trusted); 0 when unusable
syncConfirmation(stepUp, now)                       // from API-1: confirmedUntil null -> 0, else min(parse(confirmedUntil), now + windowMs)
forgetConfirmation()
requestReauth({ reasons })                          // Promise<boolean>; one dialog at a time: a second call returns the pending promise
resolveReauth(result)
withStepUp(run, { needed, reasons = [], ask = requestReauth, now = Date.now })
   -> { ok: true, value } | { ok: false, cancelled: true }
submitPassword(password, { apiImpl = api, now })    // api("POST", REAUTH_PATH, { password }) then markConfirmed(answer); returns the answer
classifyReauthError(err)                            // "wrong" (422, fields.password) | "throttled" (429) | "other"
```

`withStepUp` algorithm:

1. If `needed` and not `isConfirmed(now())`, `await ask({ reasons })`. A refusal returns `{ ok: false, cancelled: true }`: nothing is sent.
2. `await run()`; return `{ ok: true, value }`.
3. If `run` throws an error whose `code === "password_required"` (403): `forgetConfirmation()`, `await ask({ reasons: reasons.length ? reasons : err.params.reasons ?? [] })`, a refusal returns `cancelled`, then **one** retry of `run()`. A second `password_required` is thrown to the caller (`useAction` toasts `errors.password_required`). Any other error is rethrown untouched. There is no loop.

The `{ ok }` wrapper keeps a user cancel from being toasted as an error. `syncConfirmation` is called by `ApiView` when API-1 loads (dependency: the primitive `confirmedUntil`), so the server's view replaces the browser's belief at every page load.

**`ReauthView({ request, onResolve })`**, hosted by `ReauthDialog` (mounted once in `app.mjs`; null when no request). A native `<dialog>` guarded like `ConfirmView` (`showModal` only when it is a function; `components/confirm-dialog.mjs:6-15`), `aria-labelledby` / `aria-describedby`. Content: `h2.dialog-title` `reauth.title`; `p.dialog-message` `reauth.message` (`{ minutes }` = `windowMs / 60000`); when `request.reasons` is non-empty, `reauth.reasons_title` and a `ul.stack-sm` of `t("api.reason_" + code)` (a code without a key is shown raw); a `<form onSubmit>` with `Field type="password"` (`name="reauth-password"`, label `reauth.password_label`, `autoComplete="current-password"`, autofocus); `div.dialog-actions` with Cancel (`common.cancel`) and Confirm (`type="submit"`, `btn-primary`, `reauth.confirm`). Escape and Cancel resolve `false` (unlike the secret dialog). While submitting both buttons are disabled.

| Server answer to AUTH-7 | UI |
| ----------------------- | -- |
| `200 { confirmedUntil, windowMs }` | `markConfirmed`, clear the input, resolve `true`. |
| `422 validation_failed`, `fields.password = { code: "wrong_password" }` | Stay open; field error `fieldErrorText` (existing `fields.wrong_password`); the input is cleared and refocused (guarded `typeof el.focus === "function"`); nothing was saved (the guarded request is only attempted after a success). |
| `429 rate_limited`, `params.retryAfterMs` | Stay open; a `div.banner.banner-warn[role=alert]` with `tError(err)` (existing `errors.rate_limited`, "try again in {retryAfter}"). No client countdown and no timer: another submit is cheap and refused the same way. The right password is refused during the block (server rule). |
| `401 session_expired` / `unauthenticated` | Existing global handling (`api.mjs`); the dialog unmounts with the screen. |
| any other error | The same banner with `tError(err)`. |

The password lives in the input element and one `useState` only: never in the store, a log, a toast, a URL or storage; cleared on success, cancel and unmount.

## 7. Screens and states

### 7.1 `ApiView`, routes and tabs

| Hash | Screen |
| ---- | ------ |
| `#/api`, `#/api?tab=keys\|history\|usage\|test\|docs` | The tabbed page; `keys` is the default and the tab is absent from the URL then (`navigate("api", [], tab === "keys" ? {} : { tab })`, as `groups-page.mjs`). |
| `#/api/keys/new`, `#/api/keys/<id>` | The full-page key editor (routed: a long form, back and forward work, the audit page can link to it). |
| `#/api/history/<id>` | The message detail; `<id>` is the internal integer of API-10. |
| `#/api?tab=history&key=<id or panel>&status=<s>&format=<f>&from=<day>&to=<day>` | History with filters preset (links from the Keys and Usage tabs). |
| `#/api?tab=test&format=<name>` | The test form with a format preselected (links from the Docs tab); an unknown name is ignored. |

`ApiView({ route })`:

- Three independent `useAsync(..., [])`: `stateAsync` (API-1), `catalogAsync` (API-3), `keysAsync` (API-4), each with its own `reload`. State or catalogue failure: `EmptyState` (`common.view_error`, `tError`) with Retry for the whole page. A keys failure only degrades the Keys tab (EmptyState + Retry there); History, Usage and the filters then show ids instead of names.
- `[secret, setSecret]`: `{ secret, name, last4, after }` or `null`, the only place a secret lives ([section 7.6](#76-secret-once-dialog)). `useUnsavedGuard("api-secret", Boolean(secret))`.
- `syncConfirmation(state.stepUp)` in an effect keyed by the primitive `confirmedUntil`.
- Dispatch on `route.rest`: `keys` -> `KeyEditor`; `history` + id -> `MessageDetail`; otherwise the page: `view-header` (h1 `api.title`, Refresh `common.refresh` reloading the three), a muted `api.intro`, `StateBanners`, `EnableCard`, `Tabs` (`idPrefix="api-tab"`, label `api.title`, the Keys tab badge = `state.counts.active`) and one `TabPanel` per tab (children render only while active, so each tab loads its own data when opened). `catalog`, `state` and `keys` are props; no child re-fetches them on mount.
- The editor and the detail replace the page (no tabs). Their Back link goes to `buildHash("api")` (`api.back_keys`) and to `buildHash("api", [], { tab: "history" })` (`api.back_history`).

### 7.2 State card: enable and disable

`EnableCard({ state, onChanged })` (`section.card.stack`): the h2 `api.state_title`, a `StatusBadge` (`api.state_on` ok / `api.state_off` neutral), `api.state_since` (`{ when }`) when `changedAt`, `api.state_queued` (`{ count }`, plural) when `queued`, the base address in `span.mono` with a Copy `icon-btn` (`api.state_base_url`, `copyText`), the primary button (`api.enable_button` or `api.disable_button`), and `LimitsSummary` (`dl.kv`: spacing in seconds, per minute, per day, pending, queue, expiry in minutes, retention and reply window in days, from `state.settings`; the three alert toggles as `StatusBadge` rows labelled with the existing `alerts.type_api_*` titles; one link `buildHash("settings", [settingKeys.perMinute])` `api.settings_open` and one `buildHash("alerts")` `api.settings_alerts`). The limits are **not** edited here: they are Settings entries (SET-2 is the only writer, with its up-only and cross-field validators).

`StateBanners({ state })`, all `div.banner[role=status]` with an `Icon`:

| Condition | Banner |
| --------- | ------ |
| `state.failure` | `banner-error`, `api.state_registry_failed` (`{ endpoint }`, a generic text when `endpoint` is null). The enable button is disabled. |
| `!state.enabled` | `banner-info`, `api.state_disabled_banner` (every `/api/v1` request answers as a missing address; keys can be prepared meanwhile). |
| `state.pausedUntil` in the future | `banner-warn`, `api.state_paused` (`{ time }`, `formatDateTime`). |
| `state.enabled && !state.botReady` | `banner-warn`, `api.state_bot_offline` (`{ minutes: settings.expiryMin }`). |
| `isInsecureRemote()` | `banner-warn`, `api.state_http_warning` (a key presented over plain HTTP from another machine is refused unless the network is listed below). |

**Enable.** `confirm({ danger: false, title: t("api.enable_title"), message: t("api.enable_warning"), confirmLabel: t("api.enable_confirm") })` (anyone holding a key sends as the owner's number, misuse can get the number banned, a key is shown once), then `withStepUp(() => api("PUT", ...{ enabled: true }), { needed: widenings({ enabled: false }, { enabled: true }).length > 0, reasons: ["enable"] })`. Two dialogs in a row (warning, then the password when the session is not confirmed). On success: toast `api.enable_done`, reload `stateAsync` and `keysAsync`.

**Disable.** `askDisable()` = `confirm({ title: t("api.disable_title"), message: queued ? t("api.disable_message", { count: queued }) : t("api.disable_message_none"), confirmLabel: t("api.disable_confirm") })` (the queue is cancelled, FR-002), then `api("PUT", ..., { enabled: false, confirm: true })` with no password (it narrows access, FR-021). Toast `api.disable_done` with the `cancelled` of the answer; reload.

### 7.3 Plain-HTTP networks (U1)

`NetworksCard({ state, onChanged })`, rendered below the keys table. Title `api.networks_title`, intro `api.networks_intro` (a program on the same Docker network can call over plain HTTP only from a listed private network; the default is empty = strict; widening needs the password), then `IpListEditor` with `privateOnly`, `max = catalog.limits.plainHttpFromMax`, hint `api.networks_hint`, placeholder `api.networks_placeholder`, and the empty text `api.networks_empty`.

- Draft rows start from `state.plainHttpFrom`; Save (`btn-primary`, label `api.networks_save`), disabled unless the normalised values differ from the stored list (set comparison) or while busy. Rows are parsed with `parseIpRows(rows, { privateOnly: true })`; an error blocks the request and shows `ipRowsError`.
- Save: `withStepUp(() => api("PUT", ...{ enabled: state.enabled, plainHttpFrom: values }), { needed: widenings(before, after).includes("plain_http"), reasons: ["plain_http"] })`. Removing or narrowing entries never asks. A server `422` (`plainHttpFrom` with `indices`, optionally `reason: "not_private"`) maps to the same row message. Toast `api.networks_saved`; reload.
- Dirty guard `useUnsavedGuard("api-networks", dirty)`.

### 7.4 Keys tab

`KeysTab({ keys, state, settings, onChanged, onSecret })`. Header: Refresh and "New key" (`btn-primary`, a link to `#/api/keys/new`, `api.keys_new`). A `Field type="bool"` "Show revoked keys" (`api.keys_show_revoked`, default on) and the muted line `api.keys_purge_note` (`{ days: retentionDays }`). `DataTable` (`rowKey="id"`, responsive cards under 600 px) over `visibleKeys`:

| Column | Content |
| ------ | ------- |
| `api.col_key` | The name (a link to `#/api/keys/<id>`) and `...last4` in `span.mono`. |
| `api.col_state` | `StatusBadge`: `api.key_state.active` ok, `expired` neutral, `revoked` danger (`keyState`). |
| `api.col_rights` | `api.cell_rights` (`{ count }`, plural), the first three right labels as `span.chip`, `api.cell_rights_more` (`{ count }`). |
| `api.col_recipients` | A badge: list (`api.cell_policy_list`, `{ count }`), known chats (`api.cell_policy_known`), **anyone** (`api.cell_policy_anyone`, `badge-danger`). |
| `api.col_limits` | `api.cell_limits` (`{ perMinute, perDay, pending }`); a `null` limit shows the default from `state.settings`, muted, with `api.cell_limit_default`. |
| `api.col_access` | Line 1 `api.cell_ip_any` or `api.cell_ip_count`; line 2 `api.cell_expires` (`{ date }`) or `api.cell_no_expiry`. |
| `api.col_last_use` | The date and `span.mono` IP, or `api.cell_never`. |
| `api.col_created` | The date. |
| `api.col_actions` | `cell-actions`: Edit (`common.edit`, link), Duplicate (`api.action_duplicate`, active keys only), Revoke (`api.action_revoke`, `btn-danger`, non-revoked), History (`api.action_history`, link to `#/api?tab=history&key=<id>`). Each button's `aria-label` is `api.action_for` (`{ action, name }`). |

Empty state: `EmptyState` `api.keys_empty` / `api.keys_empty_hint` with the primary "New key" link. There is **no** reactivate action anywhere (U10, FR-014): a revoked key opens read-only and offers History only.

- **Duplicate** (`duplicateKey(key, { run, onSecret })` in `api-key-actions.mjs`): `withStepUp(() => api("POST", ...duplicate, {}), { needed: true, reasons: ["create"] })`. The name is the server's (`<name> (n)`, [admin-api.md](admin-api.md) 1.6); the SPA sends no name. The answer `{ key, secret }` goes to `onSecret({ secret, name: key.name, last4: key.last4, after: "list" })`, then `onChanged()` reloads the keys. Toast `api.duplicate_done` (`{ name }`). The source key is untouched (FR-015). A `409 not_editable` (the source expired meanwhile) is toasted by `tError`.
- **Revoke** (`revokeKey(key, { run })`): `askRevoke(key)` = `confirm({ title: t("api.revoke_title", { name }), message: key.queued ? t("api.revoke_message", { count: key.queued }) : t("api.revoke_message_none"), confirmLabel: t("api.revoke_confirm") })`, then `api("POST", ...revoke, { confirm: true })`, no password. Toast `api.revoke_done` with the `cancelled` count, or `api.revoke_done_nocount` when `cancelled` is `null` (the cancellation failed server-side; the claim-time guard still stops sends). Reload.

### 7.5 Key editor

`KeyEditor({ id, keys, catalog, state, onChanged, onSecret })`, route `#/api/keys/new` or `#/api/keys/<id>`. `saved` is found in `keys.items` (a spinner while `keysAsync` loads; no match: `EmptyState` `api.editor_not_found` with a Back link). The component is keyed `${id}:${saved.version}` so a successful save, a reload or a `409 conflict` starts a fresh draft from the server state; it **never** re-syncs the draft with an effect. One `useState(() => draftOf(saved))`, ``useUnsavedGuard(`api-key-${id}`, isDirty(saved, draft))``, `useAction()`.

A banner: revoked (`api.editor_revoked_banner`; the whole editor is read-only, no Save, no Duplicate, no Revoke) or expired (`api.editor_expired_banner`: set a new expiry to use it again; extending it asks for the password). Sections, each a `section.card.stack`:

1. **Name** (`Field`, `api.name_label`, `api.name_hint`, required, `maxLength = keyNameMax`). The duplicate-name refusal (`fields.duplicate`) shows here.
2. **Rights** (`RightsChecklist`, [7.5.1](#751-rightschecklist)).
3. **Recipients** (`RecipientsEditor`, [7.5.2](#752-recipientseditor)).
4. **Limits**: three `Field type="int"` labelled `api.limits_per_minute`, `api.limits_per_day`, `api.limits_pending` (`min` / `max` from `catalog.limits`), blank = `null`; the hint `api.limits_default` (`{ value }` = the effective default from `state.settings`) under each, and `api.limits_hint` ("leave empty to use the default") above.
5. **Access restrictions**: `IpListEditor` (`maxEntries = ipAllowMax`) with `api.ip_label`, `api.ip_hint`, `api.ip_placeholder`, add button `api.ip_add`. A `0.0.0.0/0` or `::/0` row shows `banner-warn` `api.ip_any_warning` ("remove the list instead"). **Expiry**: `datetime-local` (`input.input`, label `api.expiry_label`, hint `api.expiry_hint`) and a Clear button (`api.expiry_clear`); `in_past` shows `fields.in_past`.
6. **Facts** (`dl.kv`, saved keys only): id, created, updated, last use with IP, last 4 (`api.fact_*`; `api.fact_never`).
7. **Action bar** (`div.actions`): Save (`btn-primary`, disabled unless dirty, not busy and editable), Back (`common.back`), Duplicate (`canDuplicate`), Revoke (`btn-danger`, `canRevoke`), and `span.muted[aria-live=polite]` `api.editor_pending` (`{ count }`) when dirty.

**Save** (`saveKey({ draft, saved, run, ... })`): `validateKey`; on errors show them and send nothing. Otherwise `body = buildKeyBody(draft, saved)`, `reasons = widenings(saved, body)`, and `withStepUp(() => saved ? api("PUT", ...) : api("POST", ...), { needed: reasons.length > 0, reasons })` with the two literal calls of [section 2](#2-api-calls-per-file) (two literal `api(...)` calls, never a computed method). Results:

- `{ ok: true }` on create: `onSecret({ secret, name, last4, after: "editor:<new id>" })`, `onChanged()`; the secret dialog opens first, the navigation to `#/api/keys/<new id>` happens when it closes. On update: toast `api.editor_saved` (`{ name }`), `onChanged()`, the keyed remount shows the saved key.
- `{ cancelled: true }`: nothing was sent, the draft is untouched.
- `422 validation_failed`: `keyErrors(err.fields)` fills the sections; the first error scrolls into view; a summary list `api.editor_errors_title` shows the unmapped paths. Nothing is toasted twice (the handler catches `validation_failed` and rethrows the rest to `useAction`).
- `409 conflict`: toast `errors.conflict`, `onChanged()` (the remount discards the stale draft).
- `409 confirmation_required` whose `params.confirm` includes `policy_anyone` (the predicate was bypassed): `askAnyone()`, then one retry with `confirm: ["policy_anyone"]`.
- `403 password_required` after a retry, `409 not_editable`, `409 limit_reached`: toasted by `tError`.

#### 7.5.1 `RightsChecklist`

`RightsChecklist({ rights, selected, orphans, disabled, error, onToggle, onGroup, onRemoveOrphan })`. Built only from `catalog.rights` through `rightsGroups`: one `fieldset` per group (legend `api.right_group.<group>` or `api.right_group_other`), "select all" and "select none" buttons per group (`api.rights_all`, `api.rights_none`, `{ group }`), then one `label.choice` per right with `api.right.<id>.label` and the description `api.right.<id>.desc` in `span.muted`. A right the key lacks is unchecked: a new endpoint or format is never granted to an existing key (FR-011, US7.3). Orphans (`api.rights_orphan`, `{ id }`) are `span.chip` entries whose only action is remove (`api.rights_orphan_remove`). The hint `api.rights_hint` explains deny-by-default; `api.rights_need_recipients` shows when `needsRecipients(draft)`. The `rights` field error (`not_allowed`, `too_many_items`) shows under the list.

#### 7.5.2 `RecipientsEditor`

`RecipientsEditor({ mode, recipients, max, disabled, errors, onMode, onChange, askAnyone })`.

- `fieldset.choice-group` with legend `api.policy_label` and three radios (`label.choice`): `list` (`api.policy_list` + hint `api.policy_list_hint`), `known` (`api.policy_known` + `api.policy_known_hint`: groups where the bot is a member and contacts that already wrote to it), `anyone` (`api.policy_anyone` + `api.policy_anyone_hint`).
- **"Anyone"**: choosing the radio calls `askAnyone()` (`confirm({ danger: true, title: t("api.anyone_title"), message: t("api.anyone_warning"), confirmLabel: t("api.anyone_confirm") })`: ban risk, no allowlist). The radio reflects the click immediately through a local `pendingMode` state and returns to the saved mode on a refusal (a controlled Preact radio otherwise keeps the clicked box). While the mode is `anyone` a `banner-warn` `api.anyone_banner` stays visible. The confirmation token is added to the body by `buildKeyBody` only when the mode changes to `anyone`.
- Mode `list`: the chips (`ul.row-wrap` of `li.chip`, `span.chip-text`: the number in `span.mono` with the name beside it; for a group the `api.kind_group` badge, the subject and the id), each with a remove `icon-btn` (`api.recipients_remove`, `{ recipient }`); empty text `api.recipients_empty`; the count against `api.recipients_max` (`{ max }`). Two pickers: numbers (`api.recipients_numbers`): the 003 `PersonPicker` **unchanged** (`views/permissions-picker.mjs`: known private chats from CHAT-1 `kind=private` plus a typed number validated by `parseNumber`), receiving `selected = recipients` (all of them, so the cap counts numbers and groups together), `max`, `onToggle` / `onAdd` wrapped by `toggleRecipient` / `addRecipient`; groups (`api.recipients_groups`): `GroupPicker`.
- A refused add or toggle (`duplicate`, `too_many_items`, `invalid_jid` for a LID chat) shows in a `div.field-error[role=alert]` under the pickers through `fieldErrorText`. The server's `policy.recipients` error with `indices` shows as `api.recipients_invalid_rows`.
- Modes `known` and `anyone` keep the list in the draft (greyed, not editable) so switching back loses nothing.

`GroupPicker({ selected, max, disabled, single, onToggle })`: CHAT-1 `kind=group` (50 per page, a search box `api.groups_search`, `DataTable` with `rowKey="jid"`, columns `api.groups_col_pick` (checkbox, or radio when `single`, `aria-label` `api.groups_pick` `{ group }`), `api.groups_col_name`, `api.groups_col_id` in `span.mono`, pagination), empty `api.groups_empty`, error state with Retry. It holds no draft. `single` (used by the test form) selects exactly one.

### 7.6 Secret-once dialog

`SecretOnceDialog({ secret, name, last4, onClose })` in `api-secret.mjs`, rendered by `ApiView` from its `secret` state (so it survives the navigation after a create) and by nothing else. A native `<dialog>`, `showModal` guarded.

- Content: `h2` `api.secret_title`; `banner-warn` `api.secret_warning` (shown once, cannot be recovered, store it in a secrets manager, anyone holding it sends as the owner's number); `api.secret_for` (`{ name, last4 }`); a **read-only `textarea.textarea.mono`** (`aria-label` `api.secret_label`; a 65-character key wraps; an `<input>` would scroll) whose `onFocus` selects its text (guarded `typeof el.select === "function"`); a Copy button (`Icon copy`, `api.secret_copy`, then `api.secret_copied`) and the primary `api.secret_done`.
- **Copy**: `copyText(secret, env)`. `"copied"` sets a local `copied` flag. `"manual"` (plain-HTTP panel on a LAN, denied permission) selects the textarea and shows `api.copy_manual` ("press Ctrl+C").
- **Escape and the backdrop do not close it**: `onCancel` calls `preventDefault()` and does nothing. Closing is the primary button only. If Copy never succeeded, the button first asks `confirm({ danger: true, title: t("api.secret_close_title"), message: t("api.secret_close_message"), confirmLabel: t("api.secret_close_confirm") })` ("you have not copied the key; it cannot be shown again"). Selecting by hand then Ctrl+C is common, hence a confirmation and not a block.
- **On close**: `setSecret(null)`; `setDirty("api-secret", false)` (explicitly, before any navigation, otherwise the router's leave guard would ask); then the `after` action: `"editor:<id>"` -> `navigate("api", ["keys", id])`, `"list"` -> nothing.
- **Hygiene**: the secret lives in `ApiView`'s `useState` only, set from the create or duplicate answer and set to `null` on close. It never goes into `useAsync` data (a reload would keep it), `confirm()` or `toast()` text, the URL, `localStorage` / `sessionStorage`, an attribute other than this textarea's `value`, or a log (`console.*` is forbidden by `test/admin-frontend.test.js:88`). After the close the list shows only the name and the last 4 characters (FR-010). The browser's own copy of an `Authorization` header is not involved: the secret travels once, in the answer body of a `Cache-Control: no-store` response.

### 7.7 History

`HistoryTab({ keys, catalog, state, route })`. Filters (`form.card`, `Field`): key (`enum`: `api.filter_key_all`, `api.filter_key_panel`, then every key by name including revoked), status (`api.filter_status_all` + the nine `api.msg_status.<s>`), format (`api.filter_format_all` + `catalog.formats` labels), from and to (`input type="date"`, day fields as the audit page, `validateFilters`, `api.filter_end_before_start`), Apply and Reset (`api.filter_apply`, `api.filter_reset`; Reset only when a filter is set). Initial filters come from `parseHistoryQuery(route.query)`; the applied filters and the page are `useState`; the query key is the primitive `historyKey(applied, page)`; `pageSize` 25. A manual Refresh only: **no auto-refresh timer**.

Columns (`DataTable`, `rowKey="id"`): `api.col_when` (`acceptedAt`), `api.col_source` (`sourceCell`: the key name, `api.source_panel`, or `api.source_key_gone`), `api.col_recipient` (`recipientCell`: the number in `span.mono`, a group's subject and id, `api.kind_group` badge), `api.col_format` (the descriptor label, the raw name when unknown), `api.col_size` (`formatBytes`, `-` when null), `api.col_status` (`StatusBadge` with `statusTone` and `api.msg_status.<s>`; for a group `sent` the muted `api.status_group_note`), `api.col_failure` (`failureText`), `api.col_open` (a link to `#/api/history/<id>`). A permanent muted line `api.history_no_content` (`{ days: retentionDays }`): message text and media are never kept, entries are purged after N days. No content column exists to be misused.

### 7.8 Message detail and live status

`MessageDetail({ id, state, catalog })`: header (Back, h1 `api.detail_title` `{ id }`, the status badge, Refresh `api.watch_refresh`), `dl.kv` card (public id in `span.mono` with Copy, source or key, recipient, format, size, WhatsApp id, accepted, expires, failure as translated text and raw code), `MessageSteps` (`api.timeline_title`: `ol.stack-sm` of status badge and time, from `stepRows`) and, when `message.interactive`, `ResponsesCard`:

- Buttons and lists: a table of `api.responses_col_when`, `api.responses_col_author` (`authorLabel`), `api.responses_col_choice` (the id in `span.mono` and the label, or `via` tap or number).
- Poll: one row per voter (the latest vote; a cleared vote shows `-`), and the totals as `ol.bar-list` with `<progress max="1">` per option (`pollBars`, the stats pattern of `views/stats.mjs`), the option text or `api.responses_option` (`{ n }`) when the label is `null`.
- Footer: `api.responses_window` (`{ days: replyWindowDays }`) and `api.responses_empty` when there is none. A `null` label is never an error.

**`useMessage({ id, initial, timers })` -> `{ message, error, loading, polling, refresh }`** (`api-watch.mjs`): the first load at once (or after `fastMs` when `initial` is given), then a **`setTimeout` chain** driven by `nextPollDelay(attempt, message)`: 2 s for 15 polls, then 10 s, stopping at 60 polls or when settled. `attempt` lives in a `useRef`; the effect depends only on the primitive `id`; the chain is armed from the effect and from each completed poll, never from render; the timer is cleared on unmount and an answer arriving after unmount is dropped. `refresh()` fetches now and resets the counter (this is how a stopped poll is restarted; the card then shows `api.watch_stopped`, while polling it shows `api.watch_live`). Three consecutive errors stop the chain; a `404` stops it at once. `timers` defaults lazily to `{ setTimeout, clearTimeout }` of `globalThis` and is held in a ref (tests inject `clock.timers`, [section 9](#9-render-loop-guards)). No new SSE topic exists: `live.mjs` fixes five and adding one touches the server hub, its polling fallback and their tests.

### 7.9 Usage

`UsageTab({ keys, state })`: a key select (`api.usage_key`: `api.usage_key_all`, the keys, the panel) and the period (`api.usage_period`: `api.usage_days_7`, `api.usage_days_30`). Query `usageQuery(days, keyId)`, deps the two primitives. One `DataTable` per entry of `usageModel` (caption: the key name or `api.source_panel`; a `badge-danger` "revoked" when the key is): columns `api.col_day`, `api.col_sent`, `api.col_failed` (a link to `#/api?tab=history&key=<id>&status=failed` when above zero), and a proportional `<progress max="1">` (`aria-label` `api.usage_bar` `{ day, sent, failed }`) -- the stats ranked-list pattern, no SVG chart. A totals line `api.usage_totals`, the muted `api.usage_note` (sent counts delivered and read; failed counts expired and uncertain; cancelled messages are in neither) and `api.usage_timezone` (`{ zone }`). Empty: `api.usage_empty`.

### 7.10 Test tab

`TestTab({ catalog, state, route })` (`api-test.mjs`): a format select (`Field type="enum"`, `api.test_format`, options by `orderedFormats`, label `t(descriptor.labelKey)`, preselected from `route.query.format` when it names a descriptor), the descriptor description (`descKey`), `DescriptorForm`, the submit button (`api.test_submit`), the curl preview and the result card.

- **Disabled and offline.** `!state.enabled` or `state.failure`: a `banner-info` `api.test_disabled` and the submit is disabled (the server answers `409 api_disabled` anyway, FR-001). `!state.botReady`: a notice `api.test_bot_offline` (`{ minutes: expiryMin }`: the message waits for the bot); sending stays possible (the bot may reconnect).
- **`DescriptorForm({ descriptor, values, errors, onChange, disabled, deps })`** maps `field.type` to existing controls:

| `type` | Control |
| ------ | ------- |
| `text`, `url` | `Field` text / url, `maxLength` from `max`, label `t(labelKey)`, hint `t(hintKey)` when present. |
| `textarea` | `Field type="textarea"`. |
| `number` | `Field` text with `inputMode="decimal"`, omitted when `signed: true` (a decimal keypad has no minus sign: latitude, longitude); kept as a string, parsed by `buildRequest`. |
| `boolean` | `Field type="bool"`. |
| `select` | `Field type="enum"`, options `{ value, label: t(labelKey) }`. |
| `phone` | `Field` text, `inputMode="tel"`, validated by `parseNumber`. |
| `list` | `RepeatedItems`: one `fieldset` per row with `legend` `api.form_list_row` (`{ label, n }`), the row's fields rendered recursively (or one scalar control), Remove (`api.form_list_remove`, disabled at `min`) and "Add" (`api.form_list_add`, disabled at `max`); stable `_k` keys so focus survives a removal; no drag reorder. |
| `recipient` | `RecipientField`: radio "number" (`api.test_to_number`: `Field` + `parseNumber`, hint `api.test_to_hint`) or "group" (`api.test_to_group`: `GroupPicker` with `single`). Label and hint come from the descriptor (`labelKey`, `hintKey`: the registry gives the common field `api.format.common.field.to.label` / `.hint`, [runtime.md](runtime.md) 3.4). The bot's own number is refused by the server (`not_allowed`). |
| media | `MediaField`, below. |

- **`MediaField({ media, value, onChange, disabled, error, deps })`**: when `media.sources` has both, a radio File / URL (`api.media_source_file`, `api.media_source_url`). File: `input type="file"` with `accept = media.accept.join(",")`, labelled `api.media_file_label`; the pre-check is the size only (`file.size > media.maxBytes` -> the string error `api.media_too_large` with `{ max: formatBytes(maxBytes) }`); the type is judged by the server from the bytes (`media_type_mismatch`). Upload one file at a time through `upload(file, "api", file.name, onProgress)` (`deps.upload`, injectable; a `<progress>` shows the ratio, `api.media_uploading`), keep `{ uploadId, name, kind, size }`, Remove (`api.media_remove`) calls `removeUpload` (best effort: ``api("DELETE", `/admin/api/uploads/${encodeURIComponent(id)}`).catch(() => {})``), as does a format change and the unmount. URL: a `Field type="url"` (`api.media_url_label`, `media.url`), no right needed (the owner session). `api.media_none` when empty.
- **Submit**: `clientValidate` + the media check; on errors show them and send nothing. Else `body = buildRequest(...)` and `api("POST", ..., body)` (inside `run(..., { silent })`: a `validation_failed` is caught and mapped with `splitFieldErrors`, everything else is toasted by `tError`). On `202`: the **result card** (keyed by the message id) and the upload is cleared (consumed). On **any refusal the upload is kept** (the server leaves it in place so the owner fixes the other fields and retries; it expires after 1 hour). `409 api_disabled`, `chat_disabled`, `queue_full`, `media_type_mismatch`, `media_too_large`, `url_forbidden`, `url_unreachable` are toasted by `tError` (`errors.<code>`); `fields.quote` / `fields.uploadId` `not_found` show under their controls (an unknown upload clears the local upload state).
- **`ResultCard({ message, catalog, state })`**: `api.test_result_title`, `api.test_queued` (`{ id }`), the status badge, `MessageSteps` and the live line fed by `useMessage({ id, initial: message })`, and a link `api.test_result_open` to `#/api/history/<id>`. The id has a Copy button.
- **Curl preview**: a `pre.code-block` titled `api.test_curl_title` with `api.test_curl_hint`, built by `curlExample` from the current values (`$OWB_KEY` placeholder, the file as `@./<name>`); a Copy button.

### 7.11 Documentation tab

`DocsTab({ catalog, state, route })`, no network except the download.

- **Quick start** (`api.docs_quick_title`): an `ol` of four steps (`api.docs_step_enable`, `api.docs_step_create`, `api.docs_step_copy`, `api.docs_step_send`), the base address (`api.docs_base_url`, `apiBaseUrl(state)`), a text example (`curlExample` of the `text` descriptor), and `api.docs_http_warning` when `isInsecureRemote()` (and `api.docs_plain_http`: the plain-HTTP networks setting of the Keys tab).
- **Authentication, limits, errors** (`api.docs_auth_title`, `api.docs_auth_text`, `api.docs_idempotency_text`, `api.docs_limits_text`, `api.docs_errors_text`, `api.docs_status_text`, `api.docs_replies_text`): short static texts; header and field names inside them are literal tokens (no URL, [section 11](#11-panel-texts-fragments-merge-and-the-i18n-test)).
- **Endpoints** (`api.docs_endpoints_title`): `DataTable` of `catalog.endpoints`: method, path, rights (`api.docs_rights_send` instead of the thirteen `messages.send.*` ids, then the others as mono chips), and the English `summary` as is (`api.docs_english_note`).
- **Per format** (`api.docs_formats_title`): for each descriptor of `orderedFormats`, a heading, `descKey`, a `pre.code-block` with `curlExample` (JSON for formats without media, `-F` multipart for media formats, plus a second URL block where `media.sources` has `url`, with `api.docs_file_note` / `api.docs_url_note`), a Copy button (`api.docs_copy_block`, `api.docs_copied`; `"manual"` selects the block with the Selection API, guarded, and shows `api.copy_manual`) and a "Try it" link (`api.docs_format_try`) to `#/api?tab=test&format=<name>`. No timer: the "copied" label stays until the next action.
- **Download**: a button (`api.docs_download`, hint `api.docs_download_hint`: English, works while the API is disabled) calling `download(...)` of API-13.

## 8. Degraded states and deep links

| Situation | Behaviour |
| --------- | --------- |
| API disabled (`!state.enabled`) | The page stays reachable. `banner-info` on top; the Keys tab is fully usable (the owner prepares keys before enabling); History, Usage and Docs are readable; the Test submit is disabled. |
| Registry failed (`state.failure`) | `banner-error`; enable and test disabled; the catalogue is empty so the rights list shows only stored orphans and the Test and Docs tabs say so (`EmptyState` with `api.state_registry_failed`). Revoke and edit of existing keys still work. |
| Bot offline | `api.state_bot_offline` banner; Test stays usable; History reads the database. |
| Queue paused (`pausedUntil`) | `api.state_paused` banner. |
| API-1 or API-3 fails | Whole-page `EmptyState` with Retry. |
| API-4 fails | Keys tab `EmptyState` with Retry; other tabs fall back to ids. |
| API-9 / API-12 fail | The tab's `EmptyState` with Retry; filters kept. |
| API-10 `404` | `EmptyState` `api.detail_not_found` (the entry was purged) with Back. |
| Poll error | Three in a row stop the chain; `api.watch_stopped` and Refresh. |
| `409 conflict` on save | Toast `errors.conflict`, reload, fresh draft. |
| `403 password_required` after a retry | Toast `errors.password_required`. |
| `422 wrong_password` / `429` | Dialog stays open ([section 6](#6-step-up-reauthmjs-and-the-password-dialog)). |
| `401 session_expired` | Existing handling (`app.mjs` `endSession`): unsaved input is warned about first. |
| Two tabs edit one key | The second save gets `409 conflict`. |
| The secret dialog open and the browser Back | The leave guard (`api-secret`) asks first. |

Deep links (all through `buildHash`, no router change: `parseHash` already returns `rest` and `query`): `#/api/keys/<id>` (audit page, keys list), `#/api/history/<id>`, `#/api?tab=history&key=…&status=…`, `#/api?tab=test&format=…`. The audit page does not link its `target` (the key id) in v1.

## 9. Render-loop guards

The 2026-10-30 incident (feature 003: a fakeDom test with a runaway render loop grew without bound and killed the machine and VS Code) is designed out in four layers.

**View rules.**

1. `useAsync`, `useEffect`, `useMemo` and `useCallback` calls in the files of this contract have an explicit dependency array whose entries are plain identifiers or member paths of **primitives** (ids, strings, numbers, booleans, e.g. `confirmedUntil`, `historyKey(...)` result stored in a const), never an object, array, closure or call built during render.
2. No `setState` during render; none in an effect whose dependencies change because of that effect. A draft is **never** re-synchronised by an effect from a server object (the list is reloaded to new objects every time): the component is remounted with a `key` carrying the version instead.
3. Polling is a `setTimeout` chain armed from an effect and from a completed poll, with an attempt counter in a ref and a hard cap ([section 7.8](#78-message-detail-and-live-status)); there is no `setInterval` in these files; the timer is cleared on unmount. `setTimeout` appears only in `api-watch.mjs`.
4. `catalog`, `state` and `keys` are loaded once in `ApiView` and passed as props; repeated fields have stable client row keys.
5. The only browser objects a test cannot supply are injected: `useMessage({ timers })`, `MediaField` / `DescriptorForm` `deps = { upload, removeUpload }`, `copyText(text, env)`, `withStepUp({ ask, now })`. An ES import cannot be stubbed, so a module-level call to `upload` or the clipboard is not testable and not allowed.

**Static guard.** `test/admin-view-api-guards.test.js` scans `views/api*.mjs`, `reauth.mjs` and `components/reauth-dialog.mjs` with the token scanner of `test/helpers/jsScan.js`: every `useAsync(` / `useEffect(` / `useMemo(` / `useCallback(` has a deps array as its last argument, each entry matches `^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$`; no `setInterval(`; `setTimeout(` only in `api-watch.mjs`; each file that builds a `${base}` path declares `const base = "/admin/api/api"` exactly once and at the top.

**Test helper `test/helpers/viewGuard.js`** (CommonJS, beside `fakeDom.js`):

```
createViewGuard({ preact, maxRequests = 150, maxPerRoute = 40, maxRenders = 600 })
  guard.fetch(routes)      // routes: { "METHOD /path": (body, search) => answer }; returns the function to assign to globalThis.fetch
  guard.requests           // [{ key, search, body }] recorded (at most maxRequests)
  guard.count(key)         // requests recorded for a route key
  guard.renders()          // re-render batches counted
  guard.tripped()          // null, "requests", "perRoute" or "renders"
  guard.assertClean()      // throws, naming the cause and the counts, when tripped
  guard.restore()          // gives preact.options.debounceRendering back
```

- The scripted `fetch` throws on an unexpected request (as the existing view tests do). When a cap is exceeded it records `tripped` and returns a promise that **never resolves**: this halts an effect loop at its source instead of letting it spin.
- The render counter wraps `preact.options.debounceRendering` (a public option; the vendored build exports it, `vendor/preact.mjs`): Preact calls it once per scheduled re-render batch, so a loop of `setState` costs one count per turn. Past `maxRenders` the wrapper stops scheduling (the queued callback is dropped), which freezes the render loop for good; `tripped` is set. Normal batches go to the original function or to a microtask.
- Every view test ends with `guard.assertClean()` in a `finally` that also unmounts the root (`dom.unmount(root)`), uses `dom.settle(n)` with a small fixed `n` (never a `while (changing)` loop), and has `after(() => { guard.restore(); dom.restore(); delete globalThis.fetch; })`.
- `test/admin-view-guard.test.js` proves the helper: a component with `useEffect(() => setN(n + 1))` trips `renders` and the test ends; a component re-fetching on every render trips `perRoute`; a quiet component stays clean.

**Run discipline** (memory note `resource-limits`): one file at a time, `OWB_NO_CONFIG_ENV=1 timeout 120 node --max-old-space-size=1024 --test --test-force-exit --test-timeout=30000 test/<file>.test.js`; never two suites in parallel; on exit 137 or "heap out of memory" stop and bisect with a smaller cap before running anything again.

## 10. CSP, CSS and accessibility

- No `innerHTML`, `outerHTML`, `eval`, `new Function`, inline `style=`, direct `.style`, inline `on*=`, `console.*`, `document.cookie`, `javascript:` (`test/admin-frontend.test.js:88`); no URL to another host in any module **or in the i18n catalogs** (`:141` scans every non-vendor file, JSON included): example addresses come from `State.baseUrl` or `location.origin` at run time, and the catalog texts never contain `http://`, `https://` or `//host.tld`; every relative import resolves, no bare specifier (`:218`); every module imports in Node without a DOM (`:240`); every icon named exists in `icons.svg` (`:285`); every literal `class="..."` word has an `app.css` rule (`:1334`).
- **Clipboard**: the Clipboard API needs no CSP directive (`lib/admin/http/security.js` has none and its `Permissions-Policy` does not list `clipboard-write`); it exists only in a secure context, hence `copyText`'s `"manual"` path. `document.execCommand` is not used.
- **New CSS**: the only addition of the feature, in `app.css`: `.code-block { margin: 0; padding: 0.75rem; overflow-wrap: anywhere; white-space: pre-wrap; max-width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--surface-2); border: 1px solid var(--border); border-radius: 0.5rem; }` (tokens exist in `css/theme.css`; no fixed pixel width, `:1013`). Without it an unstyled `pre` widens the page at 360 px. Used as `pre.code-block` (a literal class, so it needs the rule).
- **Existing classes only** otherwise: `card card-title stack stack-sm row row-wrap grow view view-header kv chip chip-text badge badge-ok badge-warn badge-danger badge-info banner banner-warn banner-info banner-error banner-body muted mono icon-btn btn btn-sm btn-primary btn-danger select input textarea field field-label field-hint field-error choice choice-group actions cell-actions nowrap sr-only bar-list tabs dialog dialog-inner dialog-title dialog-message dialog-actions list-control pagination`. There is **no** `badge-neutral` rule: a neutral badge is `StatusBadge tone="neutral"` or a bare `span.badge`.
- 360 px: chips wrap, the editor is one column, every table is the responsive `DataTable` (labelled cards under 600 px), `pre.code-block` wraps.
- Every control has an accessible name (row buttons use `api.action_for`, checkboxes and radios sit in `label.choice`, the file input has a label); banners are `role="status"`, refusals under inputs `role="alert"` (the `field-error` pattern); dialogs are labelled; nothing relies on colour alone (badges carry text); the focus goes to the editor heading on open and to the password field in the reauth dialog.

## 11. Panel texts, fragments, merge and the i18n test

FR-085: every text exists in French and English. The panel catalogs are flat JSON maps merged from fragments; French rules of `test/admin-i18n.test.js`: vouvoiement, "panel d'administration" and never "panneau"; plurals follow the `key` / `key_one` convention of `i18n.mjs` (in French `0` and `1` both pick `_one`); every `_one` keeps the placeholders of its base. Panel texts never contain a URL (`http://`, `https://`, `//host.tld`): the URL scan of `test/admin-frontend.test.js:141` reads the catalogs too; write "HTTPS" or "plain HTTP" as words.

### 11.1 Ownership

| Fragment | Owner | Content |
| -------- | ----- | ------- |
| `specs/004-messaging-api/i18n/panel-api.json` | this contract | Every key of [11.4](#114-key-families) except the alert titles: `nav.api`, `api.*`, `reauth.*`, `audit.*` additions. |
| `specs/004-messaging-api/i18n/panel-api-server.json` | [admin-api.md](admin-api.md) (the backend) | `errors.password_required`, `errors.api_disabled`, `errors.<code>` for every key of `MESSAGING_STATUS` not already an envelope code, `fields.not_found`, and `settings.<KEY>.label` / `.desc` for the eleven new settings (22 keys). Kept apart so two authors never edit one file; the merge tool reads every `panel-*.json` of a directory. |
| `specs/002-admin-panel/i18n/panel-alerts.json` | this contract (edit) | The six `alerts.type_api_*` keys. They live there because `test/admin-view-alerts.test.js` (`:134-160`) requires every key the alerts view uses, `typeKeys(type)` for each of `ALERT_TYPES`, to be in that fragment and nothing else in it to be unused. |
| `specs/004-messaging-api/i18n/bot-api.json` | [admin-api.md](admin-api.md) / `runtime.md` | Bot-side texts (`alerts.api_*` for WhatsApp, console lines); not the SPA's concern. |

### 11.2 Fragments and merge

Each merge reads one directory, `panel-*.json` only (`tools/merge-panel-i18n.js:13-17,39-57`: flags `--frag-dir`, `--catalog-dir`, `--pattern`, `--dry-run`, `--verbose`). Dry run first, then the merge, then a second dry run that must change nothing:

```bash
node tools/merge-panel-i18n.js --frag-dir specs/004-messaging-api/i18n --dry-run
node tools/merge-panel-i18n.js --frag-dir specs/004-messaging-api/i18n
node tools/merge-panel-i18n.js --frag-dir specs/004-messaging-api/i18n --dry-run    # second run: no change
node tools/merge-panel-i18n.js --frag-dir specs/002-admin-panel/i18n --dry-run       # the alerts keys
node tools/merge-panel-i18n.js --frag-dir specs/002-admin-panel/i18n
node tools/merge-panel-i18n.js --frag-dir specs/002-admin-panel/i18n --dry-run
```

The tool checks the same placeholders in both languages and the same key set, sorts the catalogs, and writes nothing when it finds a problem. Never edit `lib/admin/public/i18n/*.json` by hand for these keys: `test/admin-i18n.test.js` fails when a fragment text differs from its catalog entry.

### 11.3 Test change: `test/admin-i18n.test.js`

- `FRAGMENT_DIRS` (`:31`) gains `path.join(ROOT, "specs", "004-messaging-api", "i18n")`; the "fragments are valid" test gains the assertion that `panel-api.json` and `panel-api-server.json` of `004-messaging-api` are among the loaded fragments (an empty scan must not pass).
- `AREAS` (`:60-63`) gains `"api"` after `"broadcasts"`: `nav.api` and `api.title` become expected keys.
- `EXTRA_SERVER_CODES` (`:65`) gains `password_required`, `api_disabled` and every `MESSAGING_STATUS` code that is not an envelope code (per `lib/messaging/errors.js`; [runtime.md](runtime.md) 2 lists nine, `validation_failed` being an envelope code already, so eight are added: `recipient_not_allowed`, `chat_disabled`, `queue_full`, `pending_limit_reached`, `media_type_mismatch`, `media_too_large`, `url_forbidden`, `url_unreachable`; `daily_quota_exceeded` and `idempotency_conflict` belong to `API_STATUS`, not the panel). One more assertion: `Object.keys(MESSAGING_STATUS)` is inside `ENVELOPE_CODES` plus `EXTRA_SERVER_CODES`, so a code added to the engine cannot skip its panel text.
- The settings tests (`:198-201`: 101 entries, two texts each) move to 112 entries with [admin-api.md](admin-api.md) section 3 (the server side's edit); `THEMES` (`:58`) is unchanged (no new theme).
- "dynamic key families used by the shell are complete" (`:415`) gains `api.msg_status.` (the nine statuses), `api.key_state.` (`active`, `expired`, `revoked`), `api.right_group.` (`send`, `read`, `media`, `docs`).
- The literal and dynamic `t()` scans already cover the new modules. A dynamic call such as ``t(`api.right.${id}.label`)`` is checked for a non-empty static prefix only; the registry-driven families are completed by `test/api-panel-texts.test.js`.

### 11.4 Key families

The fixed keys, 344 per language in all (338 in `panel-api.json`, the six alert titles in `panel-alerts.json`); English and French texts are written by the implementer under the rules above. The suffix `_one` is the singular plural form (`Intl.PluralRules`); `_none` is a plain extra text used when the count is 0.

| Family | Count | Keys |
| ------ | ----- | ---- |
| Shell | 2 | `nav.api`, `api.title` |
| Tabs and page | 8 | `api.tab_keys`, `api.tab_history`, `api.tab_usage`, `api.tab_test`, `api.tab_docs`, `api.intro`, `api.back_keys`, `api.back_history` |
| State card and enable switch | 25 | `api.state_title`, `api.state_on`, `api.state_off`, `api.state_since`, `api.state_queued`, `api.state_queued_one`, `api.state_base_url`, `api.state_bot_offline`, `api.state_paused`, `api.state_registry_failed`, `api.state_http_warning`, `api.state_disabled_banner`, `api.enable_button`, `api.enable_title`, `api.enable_warning`, `api.enable_confirm`, `api.enable_done`, `api.disable_button`, `api.disable_title`, `api.disable_message`, `api.disable_message_one`, `api.disable_message_none`, `api.disable_confirm`, `api.disable_done`, `api.disable_done_one` |
| Settings summary | 12 | `api.settings_title`, `api.settings_hint`, `api.settings_spacing`, `api.settings_per_minute`, `api.settings_per_day`, `api.settings_pending`, `api.settings_queue_max`, `api.settings_expiry`, `api.settings_retention`, `api.settings_reply_window`, `api.settings_open`, `api.settings_alerts` |
| Plain-HTTP networks (U1) | 10 | `api.networks_title`, `api.networks_intro`, `api.networks_empty`, `api.networks_label`, `api.networks_hint`, `api.networks_placeholder`, `api.networks_save`, `api.networks_saved`, `api.networks_not_private`, `api.networks_invalid_rows` |
| Keys list | 46 | `api.keys_new`, `api.keys_empty`, `api.keys_empty_hint`, `api.keys_show_revoked`, `api.keys_purge_note`, `api.col_key`, `api.col_state`, `api.col_rights`, `api.col_recipients`, `api.col_limits`, `api.col_access`, `api.col_last_use`, `api.col_created`, `api.col_actions`, `api.key_state.active`, `api.key_state.expired`, `api.key_state.revoked`, `api.cell_rights`, `api.cell_rights_one`, `api.cell_rights_none`, `api.cell_rights_more`, `api.cell_policy_list`, `api.cell_policy_list_one`, `api.cell_policy_known`, `api.cell_policy_anyone`, `api.cell_limits`, `api.cell_limit_default`, `api.cell_ip_any`, `api.cell_ip_count`, `api.cell_ip_count_one`, `api.cell_expires`, `api.cell_no_expiry`, `api.cell_never`, `api.action_duplicate`, `api.action_revoke`, `api.action_history`, `api.action_for`, `api.duplicate_done`, `api.revoke_title`, `api.revoke_message`, `api.revoke_message_one`, `api.revoke_message_none`, `api.revoke_confirm`, `api.revoke_done`, `api.revoke_done_one`, `api.revoke_done_nocount` |
| Key editor frame | 23 | `api.editor_title_new`, `api.editor_title`, `api.editor_revoked_banner`, `api.editor_expired_banner`, `api.editor_not_found`, `api.editor_created`, `api.editor_saved`, `api.editor_pending`, `api.editor_errors_title`, `api.section_rights`, `api.section_recipients`, `api.section_limits`, `api.section_ips`, `api.section_expiry`, `api.section_facts`, `api.name_label`, `api.name_hint`, `api.fact_id`, `api.fact_created`, `api.fact_updated`, `api.fact_last_use`, `api.fact_last4`, `api.fact_never` |
| Rights | 11 | `api.rights_hint`, `api.rights_all`, `api.rights_none`, `api.rights_orphan`, `api.rights_orphan_remove`, `api.rights_need_recipients`, `api.right_group.send`, `api.right_group.read`, `api.right_group.media`, `api.right_group.docs`, `api.right_group_other` |
| Recipient policy | 24 | `api.policy_label`, `api.policy_list`, `api.policy_list_hint`, `api.policy_known`, `api.policy_known_hint`, `api.policy_anyone`, `api.policy_anyone_hint`, `api.anyone_title`, `api.anyone_warning`, `api.anyone_confirm`, `api.anyone_banner`, `api.recipients_title`, `api.recipients_empty`, `api.recipients_numbers`, `api.recipients_groups`, `api.recipients_remove`, `api.recipients_max`, `api.recipients_invalid_rows`, `api.groups_search`, `api.groups_empty`, `api.groups_col_pick`, `api.groups_col_name`, `api.groups_col_id`, `api.groups_pick` |
| Limits, IP list, expiry | 14 | `api.limits_hint`, `api.limits_per_minute`, `api.limits_per_day`, `api.limits_pending`, `api.limits_default`, `api.ip_label`, `api.ip_hint`, `api.ip_placeholder`, `api.ip_add`, `api.ip_invalid_rows`, `api.ip_any_warning`, `api.expiry_label`, `api.expiry_hint`, `api.expiry_clear` |
| Secret-once dialog and copy | 11 | `api.secret_title`, `api.secret_warning`, `api.secret_label`, `api.secret_for`, `api.secret_copy`, `api.secret_copied`, `api.secret_done`, `api.secret_close_title`, `api.secret_close_message`, `api.secret_close_confirm`, `api.copy_manual` |
| Step-up | 12 | `reauth.title`, `reauth.message`, `reauth.reasons_title`, `reauth.password_label`, `reauth.confirm`, `api.reason_create`, `api.reason_enable`, `api.reason_rights`, `api.reason_policy`, `api.reason_ip`, `api.reason_expiry`, `api.reason_plain_http` |
| History list | 26 | `api.filter_key`, `api.filter_key_all`, `api.filter_key_panel`, `api.filter_status`, `api.filter_status_all`, `api.filter_format`, `api.filter_format_all`, `api.filter_from`, `api.filter_to`, `api.filter_apply`, `api.filter_reset`, `api.filter_end_before_start`, `api.col_when`, `api.col_source`, `api.col_recipient`, `api.col_format`, `api.col_size`, `api.col_status`, `api.col_failure`, `api.col_open`, `api.history_empty`, `api.history_no_content`, `api.source_panel`, `api.source_key_gone`, `api.kind_group`, `api.status_group_note` |
| Message statuses | 9 | `api.msg_status.queued`, `api.msg_status.sending`, `api.msg_status.sent`, `api.msg_status.delivered`, `api.msg_status.read`, `api.msg_status.failed`, `api.msg_status.expired`, `api.msg_status.cancelled`, `api.msg_status.unknown` |
| Message detail and live status | 24 | `api.detail_title`, `api.detail_public_id`, `api.detail_source`, `api.detail_recipient`, `api.detail_format`, `api.detail_size`, `api.detail_wa_id`, `api.detail_accepted`, `api.detail_expires`, `api.detail_failure`, `api.detail_not_found`, `api.timeline_title`, `api.responses_title`, `api.responses_empty`, `api.responses_window`, `api.responses_col_when`, `api.responses_col_author`, `api.responses_col_choice`, `api.responses_totals_title`, `api.responses_voters_title`, `api.responses_option`, `api.watch_live`, `api.watch_stopped`, `api.watch_refresh` |
| Usage | 13 | `api.usage_key`, `api.usage_key_all`, `api.usage_period`, `api.usage_days_7`, `api.usage_days_30`, `api.col_day`, `api.col_sent`, `api.col_failed`, `api.usage_empty`, `api.usage_totals`, `api.usage_note`, `api.usage_bar`, `api.usage_timezone` |
| Test form (generic part) | 28 | `api.test_format`, `api.test_submit`, `api.test_disabled`, `api.test_bot_offline`, `api.test_queued`, `api.test_result_title`, `api.test_result_open`, `api.test_curl_title`, `api.test_curl_hint`, `api.test_other_errors`, `api.test_to_number`, `api.test_to_group`, `api.test_to_hint`, `api.media_source_file`, `api.media_source_url`, `api.media_file_label`, `api.media_url_label`, `api.media_none`, `api.media_remove`, `api.media_uploading`, `api.media_too_large`, `api.form_list_row`, `api.form_list_add`, `api.form_list_remove`, `api.format.common.field.to.label`, `api.format.common.field.to.hint`, `api.format.common.field.quote.label`, `api.format.common.field.quote.hint` |
| Documentation | 30 | `api.docs_quick_title`, `api.docs_step_enable`, `api.docs_step_create`, `api.docs_step_copy`, `api.docs_step_send`, `api.docs_base_url`, `api.docs_http_warning`, `api.docs_plain_http`, `api.docs_auth_title`, `api.docs_auth_text`, `api.docs_idempotency_text`, `api.docs_limits_text`, `api.docs_errors_text`, `api.docs_status_text`, `api.docs_replies_text`, `api.docs_endpoints_title`, `api.docs_col_method`, `api.docs_col_path`, `api.docs_col_rights`, `api.docs_col_summary`, `api.docs_english_note`, `api.docs_rights_send`, `api.docs_formats_title`, `api.docs_format_try`, `api.docs_copy_block`, `api.docs_copied`, `api.docs_download`, `api.docs_download_hint`, `api.docs_file_note`, `api.docs_url_note` |
| Audit page | 10 | `audit.prefix_api`, `audit.detail_api_key`, `audit.detail_api_source`, `audit.detail_api_policy`, `audit.detail_api_changed`, `audit.detail_api_widened`, `audit.detail_api_cancelled`, `audit.detail_api_cancelled_one`, `audit.detail_networks`, `audit.detail_retry` |
| Alerts page (002 fragment panel-alerts.json) | 6 | `alerts.type_api_origin_blocked`, `alerts.type_api_origin_blocked_desc`, `alerts.type_api_key_new_ip`, `alerts.type_api_key_new_ip_desc`, `alerts.type_api_paused`, `alerts.type_api_paused_desc` |

Texts with parameters: the placeholders the code passes (both languages carry exactly these; a plural `_one` carries the same set as its base):

| Key | Placeholders |
| --- | ------------ |
| `api.state_since` | `{when}` |
| `api.state_queued` | `{count}` |
| `api.state_bot_offline` | `{minutes}` |
| `api.state_paused` | `{time}` |
| `api.state_registry_failed` | `{endpoint}` |
| `api.disable_message` | `{count}` |
| `api.disable_done` | `{cancelled}` |
| `api.settings_spacing` | `{seconds}` |
| `api.settings_per_minute` | `{count}` |
| `api.settings_per_day` | `{count}` |
| `api.settings_pending` | `{count}` |
| `api.settings_queue_max` | `{count}` |
| `api.settings_expiry` | `{minutes}` |
| `api.settings_retention` | `{days}` |
| `api.settings_reply_window` | `{days}` |
| `api.networks_invalid_rows` | `{rows}` |
| `api.networks_not_private` | `{rows}` |
| `api.keys_purge_note` | `{days}` |
| `api.cell_rights` | `{count}` |
| `api.cell_rights_more` | `{count}` |
| `api.cell_policy_list` | `{count}` |
| `api.cell_limits` | `{perMinute}`, `{perDay}`, `{pending}` |
| `api.cell_ip_count` | `{count}` |
| `api.cell_expires` | `{date}` |
| `api.action_for` | `{action}`, `{name}` |
| `api.duplicate_done` | `{name}` |
| `api.revoke_title` | `{name}` |
| `api.revoke_message` | `{count}` |
| `api.revoke_done` | `{name}`, `{cancelled}` |
| `api.revoke_done_nocount` | `{name}` |
| `api.editor_title` | `{name}` |
| `api.editor_created` | `{name}` |
| `api.editor_saved` | `{name}` |
| `api.editor_pending` | `{count}` |
| `api.rights_all` | `{group}` |
| `api.rights_none` | `{group}` |
| `api.rights_orphan` | `{id}` |
| `api.rights_orphan_remove` | `{id}` |
| `api.recipients_remove` | `{recipient}` |
| `api.recipients_max` | `{max}` |
| `api.recipients_invalid_rows` | `{rows}` |
| `api.groups_pick` | `{group}` |
| `api.limits_default` | `{value}` |
| `api.ip_invalid_rows` | `{rows}` |
| `api.secret_for` | `{name}`, `{last4}` |
| `reauth.message` | `{minutes}` |
| `api.history_no_content` | `{days}` |
| `api.detail_title` | `{id}` |
| `api.responses_window` | `{days}` |
| `api.responses_option` | `{n}` |
| `api.usage_totals` | `{sent}`, `{failed}` |
| `api.usage_bar` | `{day}`, `{sent}`, `{failed}` |
| `api.usage_timezone` | `{zone}` |
| `api.test_bot_offline` | `{minutes}` |
| `api.test_queued` | `{id}` |
| `api.media_too_large` | `{max}` |
| `api.form_list_row` | `{label}`, `{n}` |
| `audit.detail_api_key` | `{name}` |
| `audit.detail_api_source` | `{id}` |
| `audit.detail_api_policy` | `{from}`, `{to}` |
| `audit.detail_api_changed` | `{fields}` |
| `audit.detail_api_widened` | `{reasons}` |
| `audit.detail_api_cancelled` | `{count}` |
| `audit.detail_networks` | `{added}`, `{removed}` |
| `audit.detail_retry` | `{retryAfter}` |

**Registry-driven families** (the descriptors and the catalogue carry panel **keys**, never prose; a new format or right needs its texts added to the catalogs and nothing else, FR-092, SC-009):

| Family | Keys | Count |
| ------ | ---- | ----- |
| `api.right.<id>.label`, `.desc` | one pair per right id of the catalogue: the 13 `messages.send.<format>`, `messages.read`, `media.url`, `api.docs` | 16 x 2 = 32 |
| `api.format.<name>.label`, `.desc` | one pair per format (the descriptor `labelKey` and `descKey`) | 13 x 2 = 26 |
| `api.format.<name>.field.<path>.label` (+ `.hint`, `.placeholder`) | every field of a descriptor; `<path>` = the field names joined by `.`, no indices (`api.format.buttons.field.buttons.label`, `api.format.buttons.field.buttons.id.label`; [runtime.md](runtime.md) 3.4); `.hint` / `.placeholder` only when the descriptor names them. A select option: `api.format.<name>.field.<path>.option.<value>.label`. The common fields `to` and `quote` carry the shared keys `api.format.common.field.to.*` and `api.format.common.field.quote.*` (fixed list above), not 13 copies | at least one per field |
| `api.failure.<code>` | the message-level codes of [public-api.md](public-api.md) 4.3 (`FAILURE_CODES`, `CANCEL_REASONS` and `UNKNOWN_REASONS` of `lib/messaging/errors.js`, [runtime.md](runtime.md) 2): `not_on_whatsapp`, `chat_disabled`, `not_in_group`, `group_announce_only`, `media_conversion_failed`, `payload_unavailable`, `whatsapp_rejected`, `send_failed`, `key_revoked`, `key_expired`, `api_disabled`, `interrupted`, `timeout`, `connection_closed` | 14 |

No key is both a text and the prefix of another (catalog shape rule): every leaf ends in `.label`, `.desc`, `.hint`, `.placeholder`, a status or a code, and `_one` / `_none` suffixes are siblings, not children. An unknown right, format or failure code at run time is shown raw (`hasKey` guard), never as a bare key.

### 11.5 Audit and alerts pages

**Audit page** (`audit-logic.mjs`, `audit.mjs`). The vocabulary is [admin-api.md](admin-api.md) 1.7. `ACTION_PREFIXES` gains `"api"` after `"broadcast"` (the coverage test of `test/admin-view-logs-stats.test.js:236-241` fails otherwise; `account.confirm` is covered by the existing `account` prefix) with `audit.prefix_api`. `summarizeDetail` gets three branches, after the `rule` branch (which needs a `mode`) and before the generic text; any other shape keeps today's behaviour:

| Kind | When | Result |
| ---- | ---- | ------ |
| `api` | every key is among `name, last4, source, rightsAdded, rightsRemoved, rightsAddedCount, rightsRemovedCount, changed, policyFrom, policyTo, widened, cancelled` and `name` is a string, or the keys are exactly `["cancelled"]`; a list is an array of strings, a count a non-negative integer, else generic text | `{ kind: "api", name, last4, source, rightsAdded, rightsRemoved, rightsAddedCount, rightsRemovedCount, changed, policyFrom, policyTo, widened, cancelled }` with `null` for what is absent. Ids are cut to 64 characters and 100 a list. |
| `networks` | the keys are exactly `added` and `removed`, both arrays of strings (`api.plainhttp.update`) | `{ kind: "networks", added, removed }`, ranges cut like rule ids. |
| `retry` | the keys are exactly `["retryAfterMs"]` with a finite non-negative number (`account.confirm` blocked, `api.origin.block`) | `{ kind: "retry", ms }`. |

`Detail` renders them: `api` -> `audit.detail_api_key` (`{ name }`, then `...last4` in `span.mono`), `audit.detail_api_source` (`{ id }`) for a duplicate, the right ids as `badge-ok` "+" and `badge-danger` "-" chips (full ids in `span.mono`, like `RuleIds`; a count alone when only the count was sent), `audit.detail_api_policy` (`{ from, to }`, the mode names from `api.policy_<mode>`), `audit.detail_api_changed` (`{ fields }`, the field names as written), `audit.detail_api_widened` (`{ reasons }`, each through `api.reason_<code>` when it exists), `audit.detail_api_cancelled` (plural); `networks` -> `audit.detail_networks` (`{ added, removed }` counts) and the ranges as chips; `retry` -> `audit.detail_retry` (`{ retryAfter }` = `formatDuration(ms)`). The key id (`target`) is not linked in v1. `dayBound` is exported for the history filters.

**Alerts page.** `alerts-logic.mjs` `ALERT_TYPES` grows from six to nine rows in the order of [admin-api.md](admin-api.md) 1.8; `typeKeys(type)` gives `alerts.type_<type>` and `alerts.type_<type>_desc`. The page, its toggles (SET-2 on the `ALERT_*` keys) and its status rows need no other change. The panel table counts (`buildRows(null, null).length`, `summarize`) move from 6 to 9.

## 12. Points settled while writing this contract

1. **Two pure modules.** The brief puts everything pure in `api-logic.mjs`; stream D split the descriptor form into `api-form-logic.mjs` for size (files stay under about 250 lines). Both are pure and covered by one test file. All key writes are in `api-key-actions.mjs` so the contract-test literals and the 2600-character confirmation window have one home.
2. **Reasons are the server's seven** (`enable`, `create`, `rights`, `policy`, `ip`, `expiry`, `plain_http`), not stream D's nine: a duplicate is a `create`, and `policy` covers a recipient added in any mode ([admin-api.md](admin-api.md) 1.5). `widenings` must equal the server on the shared fixture `test/fixtures/api-widenings.json`; the fallback on `403 password_required` stays for the unforeseen.
3. **The limits are not edited on the API page.** Stream C's wording ("reads and edits these through SET-1/SET-2") is read as: the page shows the effective values and links to Settings (`limits` and `alerts` themes), where SET-2 validates (up-only spacing, reply window at most retention). A second form would duplicate that validation.
4. **Plain-HTTP networks** sit in the Keys tab below the table (access control belongs with the keys); the on/off card stays on top of the page. API-2 is declarative, so a networks edit sends the current `enabled`.
5. **`CONFIRMED_ACTIONS` grows from 14 to 18**, not 17: API disable, key revoke, and the `policy_anyone` confirmation for the create call and for the update call (two literals, two rows). The second scan (`:1174`) gains one row, the revoke POST.
6. **Duplicate sends `{}`**: the server picks `<name> (n)` and requires no `policy_anyone` confirmation on a duplicate ([admin-api.md](admin-api.md) 1.6). Stream D's SPA-built "(copy)" suffix is dropped. Duplicate is offered on active keys only (API-7 refuses an expired source); an expired key is editable so its expiry can be extended.
7. **Media URL**: the body carries `media: { url }` ([public-api.md](public-api.md) 3.3), error paths `media` and `media.url`; the test form sends `uploadId` for a file (the panel route's own property). The upload stays after a refusal and is consumed only on acceptance (API-11).
8. **Descriptor tolerance.** Stream D's text and shape disagree on whether list bounds live in `field.min` / `max` or in `items`; the SPA reads `field.min ?? items.min`. `captionMax` is informational: the caption is an ordinary field. Stream B's widget names and `api.formats.*` key convention are superseded by the shape and keys of research.md X6.
9. **Error paths are dotted** (`buttons.1.id`), as research.md X5 and [admin-api.md](admin-api.md) 1.2 say; stream B's `a[0].b` form is not read.
10. **Public id.** `MessageRow` carries only the internal `id`; the detail shows `publicId` (what the caller holds) with a Copy button; the list opens the detail by `id`.
11. **Poll bound.** 15 polls at 2 s, 45 at 10 s: about 8 minutes, under the 10-minute queue expiry by design; the card then shows "stopped" and a Refresh button restarts the counter. Stream D's `options.diffed` render counter is replaced by `debounceRendering` (fires once per re-render batch; `diffed` fires per virtual node and is in the thousands for one table).
12. **Clock skew.** The browser never compares the server's `confirmedUntil` with its own clock as truth: after AUTH-7 it counts `windowMs` from receipt; from API-1 it takes the earlier of the two. A wrong belief costs one extra prompt or one `403` retry, never a skipped check.
13. **Bot-offline notice** uses `State.botReady` from API-1, not `botStore`, so the test needs no live stream.
14. **Shared fixtures.** `test/fixtures/api-ip-entries.json` (`[{ input, ok, value }]`) and `test/fixtures/api-widenings.json` (`[{ name, before, after, reasons, clientExtra? }]`) are created by the server-side owners; the shapes here are the ones this file's tests load.
15. **The `to` and `quote` descriptor keys** follow [runtime.md](runtime.md) 3.4 (`api.format.common.field.to|quote.*`, one copy, not thirteen). The SPA renders whatever `labelKey` a field names; the four texts are in the fixed list of 11.4.

## 13. Test obligations

Run each file alone with caps: `OWB_NO_CONFIG_ENV=1 timeout 120 node --max-old-space-size=1024 --test --test-force-exit --test-timeout=30000 test/<file>.test.js`; never two suites in parallel; the full suite only once, at the end. View tests use `createDom` of `test/helpers/fakeDom.js`, catalogs overlaid with the two 004 fragments (so a file runs before the merge), the scripted `fetch` of `viewGuard`, and `ui.confirmStore` / `ui.resolveConfirm`; none touches the network.

- `test/admin-view-api-logic.test.js` (pure): every function of sections 4 and 5. The IP grammar against `test/fixtures/api-ip-entries.json` (verdict and `value` of every row, idempotent re-parse), `parseIpRows` numbering with blank rows, `ipRowsError` priority, the private-range edges (`172.15.255.255` out, `172.16.0.0/12` in, `100.64.0.0/10` in, `fe80::/10` out, `fc00::/7` in, a `/8` that spills out is refused), `ipCovered`; `buildKeyBody` has exactly the `KeyInput` property set, `version` only for an update, `confirm: ["policy_anyone"]` only on a change to `anyone`, an untouched expiry keeps its stored ISO; `validateKey`; `keyErrors` with `indices` and an unknown path; `widenings` against `test/fixtures/api-widenings.json` plus one case per reason, the narrowing cases that give none, `create` alone, `plain_http` from an empty list; `nextPollDelay` over attempts 0, 14, 15, 59, 60 and a settled message; `isSettled` (a group `sent` yes, `delivered` no); `copyText` with a resolving, a rejecting, an absent and an insecure-context navigator; `usageModel`; `historyQuery` day bounds. For **each of the 13 descriptors of the real registry**: `initialValues`, `valuesFromBody(descriptor, descriptor.example)`, `clientValidate` returns `{}`, `buildRequest` equals `exampleBody(descriptor)` (without media); a synthetic descriptor using all nine field types builds and round-trips (SC-009: no SPA edit for a new format); `curlExample` (quote escaping, multipart, URL placeholder, `$OWB_KEY`); `panelKeysOfDescriptor`. Every key a function can return exists in en and fr; each key of the parameter table has exactly the listed placeholders in both languages.
- `test/admin-view-api.test.js` (fake DOM): `ApiView` issues API-1, API-3, API-4 once each (`guard.count`), the tab and the route dispatch, the banners (disabled, registry failure, paused, bot offline). **Enable**: refusing the warning sends nothing; confirmed warning then the password dialog when unconfirmed; a wrong password (422) keeps the dialog open, clears the input and sends nothing; the right one sends exactly one PUT; an already-confirmed session shows no password dialog; a server `403 password_required` after the click prompts once and retries once, a second one is toasted; a `429` keeps the dialog with the retry text and no timer. **Disable**: the queued count in the confirmation, `confirm: true`, no password. **Networks**: private-only errors by row, widening asks, narrowing does not, the PUT carries the current `enabled`. **Keys**: columns and cells, the revoked toggle, the empty state, **no reactivate control exists**, Duplicate (password, body `{}`, secret dialog) only on active keys, Revoke (confirmation first, `confirm: true`, no password, `cancelled: null` text). **Editor**: dirty guard (`ui.hasUnsaved()`), create and update bodies, the secret dialog before the navigation, rights from the catalogue only with an orphan chip, "anyone" (decline restores the radio, accept shows the banner and the token), recipients through the real `PersonPicker` (CHAT-1 without `selectable`) and `GroupPicker`, a LID chat refused, IP rows with one aggregated error, `409 conflict` remounts a fresh draft, `422` mapped to sections, a `409 confirmation_required` fallback, a revoked key read-only, an expired key editable. **Secret dialog**: Escape ignored, closing without Copy asks first, copy success and the manual fallback with no clipboard, and after close the secret canary is absent from the DOM text, `toastStore`, `confirmStore` and a fake `localStorage` / `sessionStorage` (SC-003, UI side). `withStepUp` unit cases: pre-detection cancel sends nothing, one retry only, other errors rethrown, a concurrent `requestReauth` shares the pending promise, `isConfirmed` margin.
- `test/admin-view-api-messages.test.js` (fake DOM, `fakeClock`): History filters, presets from `route.query`, invalid days refused, the exact API-9 query, pagination, no content column, **no request when the fake clock advances** (no auto-refresh); Detail timeline, responses for buttons, list and poll (totals, `null` labels shown as "Option n", a cleared vote), `404`; `useMessage` bounded: 2 s then 10 s, stop at 60, stop on a settled status and on a `404`, three errors stop, `refresh` restarts, `clock.pending() === 0` after unmount; Usage query, one table per entry, ratios, the failed link, empty state.
- `test/admin-view-api-test.test.js` (fake DOM): the Test tab renders each of the 13 real descriptors and sends the exact body; `RepeatedItems` add and remove at `max` and `min`; the media field with a fake XHR (`purpose=api` in the URL, size pre-check, progress), the upload **kept** after a refusal and **cleared** after a `202`, `DELETE` on remove, on a format change and on unmount; the URL source sends `media: { url }`; server `fields` land under the dotted paths (`buttons.1.id`) and unknown paths in the summary list; `409 api_disabled`, `chat_disabled`, `queue_full` toasted; the result card polls; the disabled and bot-offline states; the curl preview. Docs: an example block per format, the copy fallback, the endpoints table (English summary as is, the thirteen send rights collapsed), the download call with its fallback file name, the plain-HTTP warning from `isInsecureRemote`.
- `test/admin-view-api-guards.test.js` (static): the scans of section 9.
- `test/admin-view-guard.test.js`: the helper trips `renders`, `perRoute` and `requests`, and stays clean on a quiet component.
- `test/api-panel-texts.test.js`: walks the real registries: every `panelKeysOfDescriptor` key of every format, `api.format.<name>.label|desc`, `api.right.<id>.label|desc` for every right of the catalogue, `api.right_group.<group>`, `api.failure.<code>` for every key of `FAILURE_CODES`, `CANCEL_REASONS` and `UNKNOWN_REASONS`, all in both catalogs (enforces FR-092 and SC-009; a temporary demo format without texts must fail naming the key).
- Edits to existing tests: `test/admin-frontend.test.js` -- `AREAS` (`:27-30`) gains `"api"` after `"broadcasts"`; `CONFIRMED_ACTIONS` (`:1135`) gains the four rows of [section 2](#2-api-calls-per-file) and `assert.equal(CONFIRMED_ACTIONS.length, 18)` (`:1170`); the second scan's route list (`:1174`) gains the revoke POST. `test/admin-i18n.test.js` -- [section 11.3](#113-test-change-testadmin-i18ntestjs). `test/admin-view-logs-stats.test.js` -- the `api` prefix is covered, the three `summarizeDetail` branches (valid shape, a count instead of a list, an extra key and a non-string id fall back to text, the cut lengths) and the `dayBound` export. `test/admin-view-alerts.test.js` -- nine types and the counts at `:38-51`, `:72`, `:109`; its `panel-alerts.json` key test keeps passing because the six keys live there.
- Must stay green with no edit: the static scans of `test/admin-frontend.test.js` (forbidden constructs, URL scan, imports, modules without a DOM, icons, css guards, contract test 11 once API-1..13 and AUTH-7 are registered), `test/admin-view-permissions*.test.js` (the 003 pickers are used unchanged), `test/admin-view-backup.test.js` (the four `Api*` tables are in `EXCLUDED_MODELS`, so the backup page does not list them).
