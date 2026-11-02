# Stream D: panel UI of the messaging API (feature 004, Phase 0)

Scope: the "API" area of the admin SPA. Everything below is browser-side; routes and JSON shapes it needs are collected under **Interfaces with other streams** (C owns them, B owns the format descriptors). Existing-code claims cite `file:line`.

Conventions used throughout:

- **Route prefix** `P = /admin/api/api` (the area name is the path segment, like `/admin/api/broadcasts`). It is one `const base = "/admin/api/api"` per view file, because the contract-test scanner only resolves prefixes declared in the same file (`test/admin-frontend.test.js:1029-1030`, rule written out in `specs/003-command-permissions/contracts/panel-ui.md` section 2). If C prefers another segment it is a one-line change per file.
- **Files under** `lib/admin/public/js/` unless stated. Every new file is `.mjs`, has no DOM access at import (`test/admin-frontend.test.js:240` imports each one in plain Node), reads `location` / `navigator` lazily inside functions.
- **Draft + explicit Save**, `useUnsavedGuard` (`components/hooks.mjs:71`), toasts through `useAction` (`hooks.mjs:79`), refusals shown field by field with `Field` / `fieldErrorText` (`components/field.mjs:6,37`), exactly as feature 003.

---

## D1. Navigation and structure

**Decision.**

1. New area `{ area: "api", titleKey: "api.title", icon: "api" }` inserted in `AREAS` right after `broadcasts` (both are outbound-message areas), loader `api: () => import("./views/api.mjs")`, `export const meta = { area: "api", titleKey: "api.title", icon: "api" }`. `Nav` is driven by `AREAS.map` and labels `nav.<area>` (`components/nav.mjs:17`), so no nav code changes; keys `nav.api` and `api.title` are required (`test/admin-i18n.test.js:164`).
2. Two new sprite symbols in `lib/admin/public/icons.svg`: `i-api` (the area icon; the area test demands the symbol, `test/admin-frontend.test.js:258-283`) and `i-copy` (copy button). Same 24x24 stroke style as `i-broadcasts` (`icons.svg:23`).
3. Hash routes (the router passes `rest` and `query` through untouched, `router.mjs:56-73`; `buildHash` `router.mjs:76-81`):

| Hash | Screen |
| ---- | ------ |
| `#/api` , `?tab=keys\|history\|usage\|test\|docs` | Tabbed page (default `keys`). Tab change = `navigate("api", [], tab === "keys" ? {} : { tab })`, same as `groups-page.mjs` (`navigate("groups", [jid], ...)`). |
| `#/api/keys/new` , `#/api/keys/<id>` | Full-page key editor (routed, not an inline card: it is a long form, needs a back/forward history, and the audit page can deep-link to it). |
| `#/api/history/<messageId>` | Message detail (timeline, responses). |
| `#/api?tab=history&key=<id>&status=failed&format=poll` | History with filters preset (links from the Keys and Usage tabs). |
| `#/api?tab=test&format=<name>` | Test form with the format preselected (links from the Docs tab). |

   Five sub-tabs instead of the four suggested: **Keys / History / Usage / Test / Documentation** (usage per key and day is a different question from the message list; it also keeps each tab file small).
4. File split (repo files top out around 430 lines, `views/broadcasts-form.mjs`; target <= 250 each):

| File | Role |
| ---- | ---- |
| `views/api.mjs` | `meta`, default `ApiView({ route })`: loads `GET P` (state) and `GET P/catalog` once with `useAsync`, passes both down, renders header, `EnableCard`, `Tabs`/`TabPanel` and dispatches `route.rest` to editor/detail. |
| `views/api-logic.mjs` | Pure: constants (`STATUSES`, `TERMINAL`, `POLICY_MODES`), `widenings`, `parseIpEntry`, `buildKeyBody`, `diffKey`, `keyRow`, `rightsGroups`, `historyQuery`, `nextPollDelay`, `failureKey`, `apiBaseUrl`, `duplicateName`. |
| `views/api-form-logic.mjs` | Pure: descriptor -> form model (D6): `initialValues`, `setPath`, `pathKey`, `clientValidate`, `buildRequest`, `curlExample`, `panelKeysOfDescriptor`. |
| `views/api-state.mjs` | `EnableCard` (D1), base URL, HTTPS/bot-offline banners, link to the Settings entries. |
| `views/api-keys.mjs` | `KeysTab` list + row actions (D2). |
| `views/api-key-editor.mjs`, `api-rights.mjs`, `api-recipients.mjs` | `KeyEditor` page; `RightsChecklist`; `RecipientsEditor` (policy radios + pickers). |
| `views/api-secret.mjs` | `SecretOnceDialog` (D3). |
| `views/api-history.mjs`, `api-message.mjs` | `HistoryTab` + filters; `MessageDetail` (D5). |
| `views/api-usage.mjs` | `UsageTab` (D7). |
| `views/api-test.mjs`, `api-form.mjs` | `TestTab` + result card; generic `DescriptorForm` renderer (D6). |
| `views/api-docs.mjs` | `DocsTab` (D7). |
| `reauth.mjs`, `components/reauth-dialog.mjs` | Shell-level step-up flow and dialog host (D4). Not under `views/` because any future area can reuse it. |

   `views/api.mjs` sits next to the HTTP client `api.mjs` (`js/api.mjs`): inside views the import is `../api.mjs` (as every view does, e.g. `views/broadcasts.mjs:20`), so there is no clash, but each view file keeps a one-line comment saying which is which.
5. **Existing files touched** (all additive): `router.mjs` (AREAS + loader), `icons.svg` (2 symbols), `css/app.css` (one class `.code-block`, D7), `app.mjs` (mount `<${ReauthDialog} />` next to `<${ConfirmDialog} />`, `app.mjs:189`), `components/index.mjs` (export), `views/audit-logic.mjs` + `views/audit.mjs` (D8), `views/settings-logic.mjs:8` (`THEME_ORDER` gets C's new settings theme; a theme missing from that list is silently not shown, `settings-logic.mjs:37-39`), `views/alerts-logic.mjs:4-11` only if C adds alert types (the list of six is hard-coded), `lib/admin/http/uploads.js:47,144` (new purpose, D6, C's edit).
6. **API disabled state.** The page stays reachable. `state.enabled === false`: info banner (`api.disabled_banner`: every /api/v1 request answers as a missing address), keys tab fully usable (the owner prepares keys before enabling), History/Usage readable, **Test tab shows a notice and its submit is disabled** (FR-001: no queue runs; the server answers `409 api_disabled` anyway). When the bot is offline (`botStore`, `ui.mjs:45`) the Test tab shows `api.test_bot_offline` ("messages wait up to {minutes} minutes").
7. **Enable / disable** (`EnableCard`, FR-001, FR-002, FR-080): a status badge plus one button, not a checkbox (each direction opens a dialog).
   - Enable: `confirm({ danger: false, title: t("api.enable_title"), message: t("api.enable_warning"), confirmLabel })` (warning text: anyone holding a key sends as the owner's number, misuse gets the number banned, keys are shown once) then `withStepUp(() => api("PUT", `${base}/state`, { enabled: true }), { needed: true })`. Two dialogs in a row (warning, then password only when the session is not already confirmed).
   - Disable: `confirm({ message: t("api.disable_message", { count: state.queued }) })` (queued messages become "cancelled", FR-002), then `api("PUT", `${base}/state`, { enabled: false, confirm: true })`. No password (it narrows access, FR-021). Toast reports `cancelled` from the answer.
   - The global limits (spacing, default quotas, queue expiry, retention, alerts) stay **Settings catalog entries** (CLAUDE.md "Settings"); the card shows a read-only summary from `state.settings` and a link `buildHash("settings", [KEY])` (settings view jumps to the theme of a focus key, `views/settings.mjs:40`). No duplicated form.

**Rationale.** Matches how areas are built (lazy `import()` per view, single `AREAS` list, meta check `test/admin-frontend.test.js:258-283`), reuses the groups tab pattern, keeps each file reviewable and importable by `node:test`. A routed editor is what `broadcasts.mjs` does for its form (`views/broadcasts.mjs:96-121`).

**Alternatives.** Four tabs with usage folded into History (rejected: two unrelated tables in one tab). Inline editor card as in 003 (rejected: 8 sections, deep links from audit). A checkbox switch (rejected: a toggle that opens dialogs is a trap for keyboard users). Editing global limits on the API page (rejected: duplicates SET-2 and its validation).

**Evidence.** `router.mjs:10-47,50,56-81`; `components/nav.mjs:17`; `test/admin-frontend.test.js:28-31,258-296`; `test/admin-i18n.test.js:60-63,164`; `views/groups-page.mjs` (tabs + `navigate`); `ui.mjs:164` (`confirm`); `app.mjs:189`.

**Files.** Table above.

---

## D2. Keys list and editor (FR-010..015, FR-080, US4)

**Decision.**

*List* (`KeysTab`, `DataTable` rowKey `id`, responsive cards under 600 px, `components/data-table.mjs:32`). Columns (each FR-080 item appears; pairs share a cell to keep nine columns):

| Column | Content |
| ------ | ------- |
| Key | name (link to `#/api/keys/<id>`), `...last4` in `span.mono` |
| State | `StatusBadge`: active (ok), revoked (danger), expired (neutral; derived `expiresAt <= now`, `keyState(key, now)`) |
| Rights | count + first 3 labels as chips (`api.right.<id>.label`), "+N more" |
| Recipients | badge by mode: list (n) / known chats / **anyone** (danger tone) |
| Limits | "30/min, 1 000/day, 100 pending" (`null` shown as the default, muted) |
| Access | line 1 IP restriction ("any IP" or "n entries"), line 2 expiry date or "no expiry" |
| Last use | date + `span.mono` IP, or "never" |
| Created | date |
| Actions | Edit, Duplicate, Revoke (`cell-actions`, `btn btn-sm`) |

Empty state: `api.keys_empty` with "Create a key" (primary). Header: Refresh + "New key" (`btn-primary`). Revoked keys stay listed (history needs them), sorted after active ones, with a "show revoked" checkbox default on.

*Editor* (`KeyEditor`, route `#/api/keys/new|<id>`; loads the list, finds the key, 404 -> `EmptyState`). One `draft` object, sections as `section.card`:

1. **Name** (`Field`, required, 1-64 chars). Read-only when revoked (the whole editor is read-only with a banner `api.revoked_banner`; no reactivation).
2. **Rights** (`RightsChecklist`): built only from `catalog.rights` (`{ id, group, ... }`) grouped by `group` (`send` = 13 formats, `read`, `media`, future groups), one `label.choice` checkbox per right with `api.right.<id>.label` and `.desc`, "select all / none" per group. A catalogue right that the key lacks is unchecked (FR-011 deny by default, nothing to compute). A right stored on the key but absent from the catalogue (a removed module) is shown as an "unknown right" chip that can only be removed (`orphanRights`). `messages.send.*` rights are useless without a recipient policy: inline hint when rights exist and policy is an empty list.
3. **Recipients** (`RecipientsEditor`): `fieldset.choice-group` with 3 radios (`list`, `known`, `anyone`, texts `api.policy_*`). `list`: chips of numbers and groups (remove buttons) plus two pickers. Numbers: the 003 `PersonPicker` unchanged (`views/permissions-picker.mjs:106`: known private chats via CHAT-1 `kind=private` plus a typed number validated by `parseNumber`, `permissions-logic.mjs:113`); draft ops `addPerson/togglePerson/removePerson/personKey` (`permissions-logic.mjs:92,163-179`) are generic (`personKey` returns other JIDs trimmed and lower-cased, so `@g.us` works). Groups: new thin `GroupPicker` in `api-recipients.mjs` (CHAT-1 `kind=group`, paginated checkboxes, `routes/chats.js:23-31`). Cap `limits.recipientsMax` from the catalogue (default 200). Pure helpers `recipientsBody(draft)` -> sorted de-duplicated JID strings.
   - **"Anyone"**: selecting the radio immediately opens `confirm({ danger: true, title: api.anyone_title, message: api.anyone_warning (ban risk, no allowlist), confirmLabel })`; declining restores the previous mode. A persistent `banner-warn` shows while the mode is `anyone`. On Save, `buildKeyBody` adds `confirm: ["policy_anyone"]` only when the mode changes to `anyone` (same pattern as SET-2 `confirm: ["owners_empty"]`, `test/admin-frontend.test.js:1135-1150`), and the server refuses without it.
   - Mode `known`: hint `api.policy_known_hint` (groups where the bot is a member and contacts that already wrote to it).
4. **Limits**: three `Field type="int"` (`min` 1, `unit`): per minute, per day, max pending. Blank = `null` = "use the default"; hint shows the effective default from `state.settings`.
5. **IP restrictions**: `Field type="list"` (`ListControl`, `field.mjs:16`, rows kept, filtered on save). Client mirror `parseIpEntry(text)` -> `{ ok, value }` / `{ ok:false, code }`: IPv4, IPv4/0-32, IPv6 (hand-written hextet check, `::` once, embedded IPv4 tail), IPv6/0-128, trimmed, lower-cased, no wildcard, no host names. `0.0.0.0/0` and `::/0` accepted but flagged by a `banner-warn` ("this allows every address: remove the list instead"). Row-level errors are aggregated into one string (`api.ip_invalid_rows`, `{ rows: "2, 4" }`) because `ListControl` has a single error slot. Parity with stream A's server parser is enforced by one shared fixture `test/fixtures/api-ip-entries.json` (valid and invalid cases) loaded by both test files.
6. **Expiry**: optional `datetime-local` using `localToIso` / `isoToLocal` of `views/broadcasts-logic.mjs:132,141`; `in_past` refused (`fields.in_past` exists, `i18n/en.json:781`).
7. **Read-only facts** (`dl.kv`, `account.mjs:91` pattern): id, created, updated, last use + IP, last 4.
8. **Action bar**: Save (`btn-primary`, disabled unless dirty and `canSave`), Back, Duplicate, Revoke (`btn-danger`, active keys only), "n unsaved changes" like 003.

*Save pipeline.* `buildKeyBody(draft, saved)` -> `{ name, rights, policy: { mode, recipients }, limits, ipAllow, expiresAt, version, confirm? }` (strict, exactly these properties; server rejects unknown). Create = `POST ${base}/keys`, update = `PUT ${base}/keys/${id}`. `withStepUp` wraps both (D4). Create answer carries the secret -> D3, then `navigate("api", ["keys", id])`. A `409 conflict` (stale `version`) toasts `errors.conflict` and reloads.

*Duplicate* (list row and editor): `withStepUp(() => api("POST", `${base}/keys/${id}/duplicate`, { name: duplicateName(key.name, names) }), { needed: true })`; the SPA builds the suffix in the panel language (`api.copy_suffix`, "(copy)" / "(copie)", `duplicateName` adds " 2", " 3" when taken). Answer -> D3. The old key is untouched (FR-015).

*Revoke* (list row and editor): `confirm({ title: t("api.revoke_title", { name }), message: t("api.revoke_message", { count: queued }) , confirmLabel })` then `api("POST", `${base}/keys/${id}/revoke`, { confirm: true })`. No password (FR-021). Toast with `cancelled` count. Must be added to `CONFIRMED_ACTIONS` (D9).

**Rationale.** FR-080 columns all present; 003's draft/Save/guard flow reused; the pickers are the 003 ones so numbers are normalised by one function (`parseNumber`) client-side and one server function; "anyone" confirmation is both UI and server-enforced, never only visual.

**Alternatives.** Editing in a modal (rejected: too long). A single textarea of recipients (rejected: no validation per entry). A visual CIDR calculator (rejected: scope). Inheriting limits by storing defaults copies (rejected: `null` = default lets a later change of the global default apply; C may still store explicit values, the SPA only sends what the owner typed).

**Evidence.** `views/permissions-picker.mjs:106`; `views/permissions-logic.mjs:92,113,163-185`; `routes/chats.js:6,23-31`; `components/field.mjs:16,37`; `views/broadcasts-logic.mjs:132,141`; `components/data-table.mjs:32`; `test/admin-frontend.test.js:1135-1170`.

**Files.** `api-keys.mjs`, `api-key-editor.mjs`, `api-rights.mjs`, `api-recipients.mjs`, `api-logic.mjs`; reuses `permissions-picker.mjs`, `permissions-logic.mjs` unchanged.

---

## D3. Secret-once dialog (FR-010, FR-017, US1.2)

**Decision.** `SecretOnceDialog({ secret, name, last4, onClose })` in `api-secret.mjs`, rendered by the editor / list that received `{ key, secret }`, never by a global store.

- Native `<dialog>` with `showModal` guarded like `ConfirmView` (`components/confirm-dialog.mjs:6-15`; FakeElement has no `showModal`, `test/helpers/fakeDom.js:69-117`).
- Content: title `api.secret_title`, `banner-warn` `api.secret_warning` ("shown once, cannot be recovered; store it in a secrets manager; anyone holding it sends as your number"), a **read-only `textarea.textarea.mono`** (wraps a 60+ character key; an `<input>` would scroll) with `onFocus` -> `select()` guarded by `typeof el.select === "function"`, a `Copy` button (`Icon copy`) and a primary `api.secret_done` button. Below: "name, ends with ...last4".
- **Copy**: `copyText(text, env = { navigator: globalThis.navigator, isSecureContext })` in `api-logic.mjs` returns `"copied" | "manual"`: uses `navigator.clipboard.writeText` when it exists (secure context: HTTPS or localhost) and the promise resolves; otherwise (plain-HTTP panel on a LAN, denied permission, throw) it selects the textarea and shows `api.secret_copy_manual` ("press Ctrl+C"). A CSP never blocks the Clipboard API (`lib/admin/http/security.js:24-36` has no clipboard directive; `Permissions-Policy` `security.js:47` does not list `clipboard-write`). No `document.execCommand`.
- **Escape and backdrop do not close it** (`onCancel` -> `preventDefault`, like `ConfirmView` but ignoring). Closing is only the primary button. If Copy was never pressed, the button first asks `confirm({ danger: true, message: api.secret_close_unsaved })` ("you have not copied the key; it cannot be shown again"). Selecting by hand then Ctrl+C is common, hence confirm rather than block.
- **Hygiene**: the secret lives only in the opener's `useState`, set from the create/duplicate answer and set to `null` on close. It never goes into `useAsync` data (a reload would keep it), `confirm()`/`toast()` text, the URL, `localStorage`/`sessionStorage`, an attribute other than this textarea's value, or a log (`console.*` is forbidden anyway, `test/admin-frontend.test.js:88-115`). After close the list shows only name and last 4 (FR-010).

**Rationale.** A lost key is a revoke + duplicate, an accidental close is the most likely failure, so closing is explicit; the fallback covers the realistic case of an owner reaching the panel over HTTP on a LAN.

**Alternatives.** Auto-download of a `.txt` (rejected: leaves the secret on disk). Closing on Escape (rejected: accidental loss). `<input type=password>` with reveal (rejected: password managers offer to save it).

**Evidence.** `components/confirm-dialog.mjs:6-31`; `security.js:24-47`; `test/helpers/fakeDom.js:69-117`; `ui.mjs:164-185`.

**Files.** `views/api-secret.mjs`, `copyText` in `api-logic.mjs`.

---

## D4. Step-up password dialog (FR-021, US4.7, US4.8)

**Decision.** A reusable flow in `reauth.mjs` plus `components/reauth-dialog.mjs`.

```
reauthStore = createStore({ request: null, confirmedUntil: 0 })          // ui.mjs createStore
isConfirmed(now)                    // confirmedUntil > now + 2000 (safety margin)
markConfirmed(untilIso)             // from POST answer or from GET P (state.stepUp.confirmedUntil)
requestReauth({ reasons })          // Promise<boolean>; opens the dialog
withStepUp(run, { needed, now, ask = requestReauth })
   -> { ok: true, value } | { ok: false, cancelled: true }
```

Flow of `withStepUp`: (1) if `needed` and not `isConfirmed`, ask first (pre-detection); a cancel returns `{ cancelled: true }` and nothing is sent. (2) `run()`. (3) On `ApiError.code === "password_required"` (403), drop the local confirmation, ask once, then retry `run()` **once**; a second `password_required` is thrown to `useAction` (toast). Any other error is rethrown untouched. The `{ ok }` wrapper avoids `useAction` toasting a user cancel.

*Dialog* (`ReauthDialog`, mounted once in `app.mjs` beside `ConfirmDialog`): `<dialog>` + `<form onSubmit>`; title `api.reauth_title`; message `api.reauth_message` (the confirmation lasts {minutes} minutes); the list of reasons (`api.reauth_reason_<code>`, e.g. "adds rights", "widens the recipients"); `Field type="password"` (`autoComplete="current-password"`, autofocus), Confirm / Cancel. Submit calls `api("POST", REAUTH_PATH, { password })`.

| Server answer | UI |
| ------------- | -- |
| 200 `{ confirmedUntil }` | `markConfirmed`, clear the input, resolve `true` |
| 422 `validation_failed` `fields.password = { code: "wrong_password" }` | stay open, field error via `fieldErrorText` (existing `fields.wrong_password`, `i18n/en.json:807`), input cleared and refocused, nothing was saved (the save is only attempted after a success) |
| 429 `rate_limited` `params.retryAfterMs` | stay open, banner with `tError(err)` (existing `errors.rate_limited`, "try again in {retryAfter}", `tError` `i18n.mjs:156-164`); no client countdown timer (a second submit is cheap and rejected the same way) |
| 401 `session_expired` | existing global handling (`api.mjs:128-139`); the dialog unmounts with the screen |

The password lives in the input element only: never in the store, never logged, cleared on success, cancel and unmount.

*Client pre-detection* (`api-logic.mjs`, pure, mirrored by the server): `widenings(saved, draft)` -> array of reason codes, `needsStepUp = widenings(...).length > 0`.

| Reason | True when |
| ------ | --------- |
| `create` | `saved === null` (creation) or a duplicate |
| `enable` | the API switch goes on |
| `rights` | a right in `draft.rights` is not in `saved.rights` |
| `policy` | mode rank rises (`list` 0 < `known` 1 < `anyone` 2), or the draft mode is `list` and a recipient (by `personKey`) is not in the saved list |
| `ip` | `saved.ipAllow` non-empty and (draft empty, or an entry of the draft is absent from the saved entries after normalisation) |
| `expiry` | `saved.expiresAt` set and (draft cleared, or draft later) |

False positives are allowed (replacing `/8` by `/16` still prompts); the server is authoritative and a false negative is caught by the `403 password_required` fallback, which is why both paths exist. Revoke, removing a right, shrinking a list, disabling the API and editing limits/name never reach `needed`.

**Rationale.** Pre-detecting asks at the click, with the reasons shown, instead of after a failed save; the 403 fallback keeps the server the single source of truth and covers clock skew, a second tab, and mirror drift. One retry bounds the loop.

**Alternatives.** Prompt only on 403 (rejected: every first widening shows a failed request in the network log and loses the reason list). A generic `confirm()` with an input (rejected: `confirm` has no input and keeps its message in `confirmStore`, `ui.mjs:150-185`). Keeping the password for 5 minutes in memory (rejected: the server's `confirmedUntil` is the only state).

**Evidence.** `routes/auth.js:307-331` (the only existing password re-check: `limits.password` gate -> `rate_limited`, wrong -> `validation_failed` + `fields.currentPassword`; step-up should mimic it); `ui.mjs:13,150`; `api.mjs:16-27,128-139`; `i18n.mjs:156-172`; `app.mjs:189`.

**Files.** `reauth.mjs`, `components/reauth-dialog.mjs`, `components/index.mjs`, `app.mjs`, `widenings` in `api-logic.mjs`.

---

## D5. History list and message detail (FR-070..073, FR-081, US3, US5, US6)

**Decision.**

*List* (`HistoryTab`): filter form (`form.card`, `Field`): key (`enum`: all, "Panel (test form)", then every key by name incl. revoked), status (9 values `api.msg_status.<status>`: queued, sending, sent, delivered, read, failed, expired, cancelled, unknown), format (from `catalog.formats`, label `api.format.<name>.label`), from/to days (reuse `validateFilters`, `views/audit-logic.mjs:52`, and export `dayBound` (`:39`) for the ISO conversion, since `buildAuditQuery` keeps it private, `audit-logic.mjs:68-80`). Query `GET ${base}/messages?key&status&format&from&to&page&pageSize=25`. Initial filters come from `route.query`. Manual Refresh button only (no auto-refresh timer: fewer loop risks, D9).

Columns: When (`acceptedAt`), Key / source (name, or "Panel"), Recipient (full: `shortJid(to)` = `+digits` for a private chat, group name + JID for a group; recipients are not masked in the panel, `groups-logic.mjs:146-153`), Format, Size (`formatBytes`, `i18n.mjs:192`), Status (`StatusBadge`, tone map in `api-logic.mjs`: sent/delivered/read ok, queued/sending info, failed danger, expired/cancelled/unknown neutral or warn for `unknown` "uncertain"), Failure (translated code), Open. A permanent muted line `api.history_no_content` ("message text and media are never kept; entries are purged after {days} days"; days from `state.settings`). No content column exists to be misused.

*Detail* (`MessageDetail`, `#/api/history/<id>`): header (id in `mono`, status badge, Refresh, Back); `dl.kv` of key/source, recipient, format, size, WhatsApp id, accepted, expires, failure (translated + raw code); **timeline** `ol` of `steps[]` sorted by time (status badge + time, no new CSS: `ul.stack-sm` rows); **responses** card shown when `message.interactive`: buttons/list -> table (when, author `shortJid`, chosen id + label); poll -> per-voter last vote table plus totals as `ol.bar-list` with `<progress>` (the stats pattern, `views/stats.mjs:39-52`, `css/app.css:1146,1197`). Option and choice labels may be `null` (see Open points 1); then the id or "Option n" is shown. Empty responses: `api.responses_empty` + the 7-day collection note.

*Live status.* No new SSE topic (`live.mjs:21` fixes five topics, adding one touches `sse.js`, the polling fallback and tests). The detail and the test result card poll `GET ${base}/messages/${id}` with `nextPollDelay(attempt, status, kind)`: 2 s for the first 15 polls, then 10 s, stop at 60 polls or when settled. Settled = `failed|expired|cancelled|unknown|read`, or `sent` in a group (FR-070: groups stop at "sent"). `setTimeout` chain, cleared on unmount, attempt counter in a ref, never re-armed from render.

**Rationale.** Everything FR-081 asks, built from existing components (`DataTable`, `StatusBadge`, `dl.kv`); polling is bounded and testable with a fake clock (`test/helpers/fakeClock.js` exists).

**Alternatives.** New `api` live topic (rejected, above). Infinite scroll (rejected: server pagination like every other list). Showing masked recipients (rejected: FR-073 masks only logs).

**Evidence.** `views/audit-logic.mjs:68-80`; `views/audit.mjs:89-135` (filter form + table pattern); `views/stats.mjs:39-52`; `live.mjs:21`; `views/groups-logic.mjs:146-153`; `i18n.mjs:30` (`hasKey` for `failureKey`).

**Files.** `api-history.mjs`, `api-message.mjs`, `api-logic.mjs`; edit `audit-logic.mjs` (export `dayBound`).

---

## D6. Test form generated from format descriptors (FR-082, US4.4)

**Decision.** `TestTab` = format select (`catalog.formats`, filtered to nothing the owner cannot test: the panel session has no key, so all of them) + common block + `DescriptorForm` + result card.

*Generic renderer* `DescriptorForm({ descriptor, values, errors, onChange, disabled, uploadFn })` (`api-form.mjs`) maps `field.type` to existing controls:

| `type` | Control |
| ------ | ------- |
| `text`, `url` | `Field` text/url, `maxLength` from `max` |
| `textarea` | `Field textarea` |
| `number` | text input with `inputMode="decimal"` (omitted when `signed: true`, because iOS decimal keypads have no minus sign: latitude/longitude); value kept as a string, parsed in `buildRequest` |
| `boolean` | `Field bool` (switch) |
| `select` | `Field enum` with `options: [{ value, labelKey }]` |
| `phone` | `Field text` `inputMode="tel"`, validated by `parseNumber` (`permissions-logic.mjs:113`), sent as digits |
| `list` | `RepeatedItems`: rows with `legend` ("Button 2"), the item `fields` rendered recursively (or a single scalar `item`), Remove (disabled at `min`), Add (disabled at `max`), stable client row keys so focus survives removal; no drag reorder in v1 |
| `file` | `MediaField` (below) |
| `recipient` | the common `to` field: radio "number / group"; number = `Field` + `parseNumber`; group = `select` fed by CHAT-1 `kind=group` |

Formats covered by these types: text (`textarea`, `boolean` link preview, `list` of `phone` mentions, `text` quote id); image/video/gif/document (`file` or `url`, `textarea` caption max 1024, `text` file name for documents); audio/voice/sticker (`file` or `url`); location (two signed `number`, two `text` max 256); contact (`list` 1-10 of {`text` display name, `list` of `phone`, `text` organisation, `text` email}); poll (`text` max 255, `list` 2-12 of `text` max 100, `select`/`boolean` single or multiple); buttons (`textarea`, `list` 1-3 of {`text` id with `pattern`, `text` label}); list (`textarea`, `text` button label, `list` 1-10 of {id, title, description}). No further type is needed: a new format that uses only these needs no SPA change (SC-009).

*State and validation.* `values` is plain data (rows carry a client-only `_k`, stripped by `buildRequest`). `clientValidate(descriptor, values)` returns `{ [pathKey]: { code, params } }` with path keys like `buttons.0.label`, `contacts.1.phones.0`, codes from the existing `fields.*` set (`required`, `too_long`, `too_short`, `out_of_range`, `too_many_items`, `invalid_phone`, `invalid_format`, `duplicate` for poll options). It is a courtesy mirror (length, count, required); the server answer is authoritative and its `fields` map uses the same path syntax, so server errors render under the same controls (`errorFor(errors, pathKey)`, unknown paths go to a summary list).

*Media.* `MediaField` uses the panel upload mechanism: `upload(file, "api", file.name, onProgress)` (`api.mjs:191`) -> `{ uploadId, kind, mime, size }` (`views/broadcasts-form.mjs:59-107` pattern: progress element, remove button that calls `DELETE /admin/api/uploads/:id`, also called when the format changes or the tab unmounts). `PURPOSES` is `["backup","broadcast"]` and the broadcast sniffer only admits images and documents (`lib/admin/http/uploads.js:47,94-126,199-203`), so C must add a purpose (`api`) with a sniffer injected through `createUploads({ sniff })` (`uploads.js:144`) that uses B's content sniffing for the seven media kinds (the route currently calls `createUploads({ dir })` without it, `routes/uploads.js:17-24`). Client pre-check only on `file.size > media.maxBytes` and the `accept` list from the descriptor; type truth stays server-side (`media_type_mismatch`). One upload in flight per session (`uploads.js` header) is respected by uploading one file at a time. When the descriptor allows both sources a radio `File | URL` switches the field (the URL path goes through the SSRF-safe fetcher on the server; the owner session needs no `media.url` right).

*Submit.* `POST ${base}/test` with `{ format, to, ...fields, uploadId? }` (flat, same property names as the public JSON body so the docs example, the curl preview and the form share one shape). Answer `202 { message }`: show the **result card**: id (mono + copy), status badge, "live" timeline updated by the D5 poller, link to `#/api/history/<id>`. Refusals (`validation_failed` with `fields`, `chat_disabled`, `api_disabled`, `bot_unavailable`, media and URL codes, queue-full) go through `tError` / field errors. The form also shows a read-only **curl preview** built by `curlExample` from the current values (`$OWB_API_KEY` placeholder).

**Rationale.** One declarative renderer means a new format needs a module and texts only (FR-092); it uses `Field` and the existing upload route, so no new transport. Flat bodies keep the form, the preview and the docs in sync.

**Alternatives.** One hand-written form per format (rejected: breaks FR-092). JSON Schema form library (rejected: new dependency, no build step, CSP). Base64 media in JSON (rejected by the spec). Using the real public endpoint with a panel-issued key (rejected: FR-082 says session of the owner, source "panel").

**Evidence.** `views/broadcasts-form.mjs:59-107`; `api.mjs:191-233`; `lib/admin/http/uploads.js:6-24,47,94-126,144,199-203`; `routes/uploads.js:17-31`; `components/field.mjs:37-95`; `routes/chats.js:23`.

**Files.** `api-test.mjs`, `api-form.mjs`, `api-form-logic.mjs`; C edits `uploads.js` (purpose + sniff).

---

## D7. Usage per key and day, and documentation (FR-083, FR-084)

**Decision.**

*Usage tab* (`UsageTab`): controls = key select (all keys, default all) and period (7 or 30 days). Query `GET ${base}/usage?days=7&key=<id|all>`. Render one `DataTable` per key (caption = key name) with columns Day, Sent, Failed, and a proportional `<progress max="1">` (ratio to that key's busiest day, `aria-label` = "day: n sent, m failed"), matching the stats ranked lists (`views/stats.mjs:39-52`; `<progress>` is styled app-wide, `css/app.css:1146`). Days come zero-filled from the server (no gap logic in the browser). No SVG chart: the stats chart is a fixed 7-bar model (`views/stats.mjs:11-35`), tables are accessible by default and read on a phone. Totals row in `api-logic.mjs#usageTotals`. Empty state `api.usage_empty`. Time zone label from the answer (`timezone`) like `stats.timezone`.

*Docs tab* (`DocsTab`), no network except one download:
- Quick start (SC-001: first text in 5 minutes): four numbered steps (enable, create a key, copy, send) with the live base URL `apiBaseUrl(location)` = `origin + "/api/v1"` (read lazily, injectable), a ready curl for a text message, and a warning when `isInsecureRemote()` (`ui.mjs:253`) because keys over plain HTTP from another machine are refused (FR-003).
- Authentication / limits / errors: short static texts (`api.docs_*`) plus the list of endpoints from `catalog.endpoints` (method, path, right, summary key).
- **Per-format examples**: for each format of `catalog.formats`, a `pre.code-block` with `curlExample({ origin, descriptor })` built from `descriptor.example` (B-provided realistic sample values) with `Authorization: Bearer $OWB_API_KEY`; JSON body for text-like formats, `-F` multipart for file media, URL variant for `media.url`. A Copy button per block (`copyText`) and a "Try it" link to `#/api?tab=test&format=<name>`.
- **Download**: button -> `download("GET", `${base}/openapi`, undefined, "openwhatsappbot-api-v1.openapi.json")` (`api.mjs:239-271`, filename from `Content-Disposition`). The panel route works even when the API is disabled so the owner can read the doc before enabling.

New CSS (the only one of the feature): `.code-block { margin: 0; padding: 0.75rem; overflow-wrap: anywhere; white-space: pre-wrap; max-width: 100%; font-family: monospace stack; background: var(--surface-2); border: 1px solid var(--border); border-radius: 0.5rem }` in `app.css` (tokens exist, `css/theme.css:12-17`). Without it the CSS guard fails on a bare class (`test/admin-frontend.test.js:1334`) and an unstyled `pre` would widen the page at 360 px (guards at `:1272-1325`). Everything else reuses existing classes (`card card-title stack stack-sm row row-wrap grow kv chip chip-text badge badge-* banner banner-warn banner-info banner-body muted mono icon-btn btn btn-sm btn-primary btn-danger select input textarea field field-label field-hint field-error choice choice-group actions cell-actions nowrap sr-only bar-list tabs dialog*`, all present in `app.css`).

**Rationale.** The same descriptors feed the test form, the examples and (server-side) the OpenAPI document, so the three cannot drift; tables keep the page accessible and cheap.

**Alternatives.** SVG bars (rejected, above). A rendered OpenAPI viewer (rejected: third-party code, CSP). Examples hand-written in i18n (rejected: per format drift; only titles/notes are texts).

**Evidence.** `views/stats.mjs:11-52`; `css/app.css:1146,1160-1177,1197`; `api.mjs:239-271`; `ui.mjs:253`; `css/theme.css:12-17`.

**Files.** `api-usage.mjs`, `api-docs.mjs`, `api-logic.mjs`, `api-form-logic.mjs#curlExample`, `css/app.css`.

---

## D8. i18n and audit page

**Decision.**

- **Fragment** `specs/004-messaging-api/i18n/panel-api.json` (`{ "en": {...}, "fr": {...} }`, flat dot keys, same key set and `{placeholders}` both languages, plurals as `key` / `key_one`, French in vouvoiement and "panel d'administration"; rules `test/admin-i18n.test.js:108-125,229`). To avoid two streams editing one file, C owns a second fragment `panel-api-server.json` in the same directory (`settings.API_*.label/desc`, `settings.theme.<id>`, `errors.<code>` and `fields.<code>` for new server codes, `backup.model_*`, `alerts.*`); the merge tool reads every `panel-*.json` (`tools/merge-panel-i18n.js:46`, default pattern).
- **Key families** (every leaf ends in `.label` / `.desc` / `.hint` so no key is both a text and a prefix of another, `test/admin-i18n.test.js:125`): `nav.api`, `api.title`, `api.tab_<id>`, `api.state_*`, `api.enable_*`, `api.disable_*`, `api.keys_*`, `api.col_*`, `api.key_state.<active|revoked|expired>`, `api.policy_*`, `api.right_group.<group>`, `api.right.<rightId>.label|desc`, `api.format.<name>.label|desc`, `api.format.<name>.field.<field>.label|hint|placeholder`, `api.field.<common>.label|hint` (shared: `to`, `caption`, `quote`...), `api.msg_status.<status>`, `api.failure.<code>`, `api.source.panel`, `api.secret_*`, `api.reauth_*`, `api.history_*`, `api.responses_*`, `api.usage_*`, `api.docs_*`, `api.test_*`, `api.ip_*`, `api.anyone_*`, `api.revoke_*`, plus `audit.prefix_api`, `audit.detail_api_*`. Dynamic lookups (`t(\`api.right.${id}.label\`)`) are scanned only for a non-empty prefix family (`test/admin-i18n.test.js:391-413`); completeness for registry-driven families is enforced by a dedicated test (D9).
- **Descriptor texts**: descriptors carry panel **keys**, defaulting by convention to `api.format.<name>.field.<field>.label`; `panelKeysOfDescriptor(descriptor)` (pure, in `api-form-logic.mjs`) lists every key a descriptor can need. A new format's author adds those keys to the panel catalogs (FR-092 "ses textes traduits"; SC-009 allows catalogue edits). Missing keys fail the registry test, not a user's screen.
- **Merge** (dry run first, then check idempotence):
  `node tools/merge-panel-i18n.js --frag-dir specs/004-messaging-api/i18n --dry-run`, then without `--dry-run`, then `--dry-run` again (flags `--frag-dir`, `--dry-run`, `--pattern` verified at `tools/merge-panel-i18n.js:46-57`; the tool normalises order and checks placeholders). Never hand-edit `lib/admin/public/i18n/*.json` for these keys (`test/admin-i18n.test.js:320`).
- **Test edits** in `test/admin-i18n.test.js`: add `specs/004-messaging-api/i18n` to `FRAGMENT_DIRS` (`:31`), add `"api"` to its `AREAS` (`:60-63`, same order as the router), list new server envelope codes in `EXTRA_SERVER_CODES` (`:64-65`; at least `password_required`, `api_disabled`, plus C's), add the new settings theme to `THEMES` (`:58`) if C creates one, and pin `errors.password_required` params if it carries `validForMs` (`:240-250`).
- **Audit page** (`views/audit-logic.mjs`, `views/audit.mjs`): `ACTION_PREFIXES` gets `"api"` after `"broadcast"` (the coverage test fails otherwise as soon as C adds `api.*` to `ACTIONS`, `test/admin-view-logs-stats.test.js:236-241`; each prefix needs `audit.prefix_<prefix>`, `audit.mjs:89`, `:411-415`). New summary kind in `summarizeDetail` (before the generic text, like the `rule` branch, `audit-logic.mjs:172-188`): when the detail keys are a subset of `name, last4, rightsAdded, rightsRemoved, changed, policyFrom, policyTo, cancelled` it returns `{ kind: "apiKey", name, last4, added: string[], removed: string[], changed: string[], policy: { from, to } | null, cancelled: number | null }`; any other shape keeps the current behaviour. `Detail` renders "name (...last4)", the right ids as `badge-ok` "+" / `badge-danger` "-" chips (full ids, like `RuleIds`, `audit.mjs:23-26`), changed field names via `api.audit_changed_<field>`, `cancelled` count. The key id (audit `target`) is not linked in v1. Actions the page must tolerate: `api.enable`, `api.disable`, `api.key.create|update|duplicate|revoke`, `api.test` (C owns the vocabulary).

**Rationale.** Same mechanics as 003 (fragment dir + test constant + dry-run merge), with the one addition that registry-driven keys are checked by a registry-walking test instead of the literal-key scanner.

**Alternatives.** Texts inside the descriptors (rejected: a second i18n system, no fr/en parity test). Putting format texts in `lang/*.json` (bot catalog; rejected: the panel loads only its own catalog, `i18n.mjs:71`).

**Evidence.** `test/admin-i18n.test.js:31,58,60-67,108-125,185-196,365-413`; `tools/merge-panel-i18n.js:13-57`; `views/audit-logic.mjs:8-30,172`; `views/audit.mjs:89`.

**Files.** `specs/004-messaging-api/i18n/panel-api.json` (+ C's `panel-api-server.json`), `audit-logic.mjs`, `audit.mjs`, tests above.

---

## D9. View tests, runaway-render guards, CSP constraints

**Decision.**

*Test files* (patterns of `test/admin-view-data.test.js:400-520` and `admin-view-permissions-*.test.js`: `createDom`, scripted `fetch`, catalogs overlaid with the fragment so the file runs before the merge):

| File | Covers |
| ---- | ------ |
| `test/admin-view-api-logic.test.js` | `widenings` (each reason, narrowing cases give none), `parseIpEntry` (shared fixture), `buildKeyBody` (exact property set, `confirm: ["policy_anyone"]` only on change), `diffKey`, `duplicateName`, `historyQuery`, `nextPollDelay`, `failureKey`, `copyText` with fake navigators, `initialValues`/`clientValidate`/`buildRequest`/`curlExample` for all 13 descriptors from the real registry, `panelKeysOfDescriptor`, `usageTotals`. |
| `test/admin-view-api.test.js` | EnableCard (enable: warning confirm, then password prompt, then one PUT; disable: confirm shows the queued count, `confirm: true`), keys list columns, editor draft/Save/dirty guard, "anyone" confirmation (decline restores), revoke confirm, secret dialog (shown once, Escape ignored, copy fallback, secret absent from the DOM, toasts and storage after close), step-up (wrong password sends nothing; 403 fallback prompts once and retries once; a second 403 toasts; rate-limited keeps the dialog), disabled-API state. |
| `test/admin-view-api-history.test.js` | History filters and query, detail timeline, responses and poll totals, bounded polling with a fake clock, Test tab (descriptor render for each format, repeated rows add/remove at min/max, upload with a fake XHR, server `fields` mapped to paths, result card), Usage and Docs (examples, download). |
| `test/api-panel-texts.test.js` | Walks the real format/right registry and asserts every `panelKeysOfDescriptor` key and every `api.right.<id>.label|desc` exists in both panel catalogs (enforces FR-092 / SC-009 at test time). |
| edits | `test/admin-frontend.test.js`: `AREAS` (`:28-31`) + `api`; `CONFIRMED_ACTIONS` (`:1135`) gets "API disable", "API key revoke" and the richer-form entry for `confirm: ["policy_anyone"]` (the `assert.equal(CONFIRMED_ACTIONS.length, 14)` at `:1170` becomes 17) and the route list of the second guard (`:1174`). `test/admin-view-logs-stats.test.js`: `apiKey` summary branch. `test/admin-i18n.test.js`: D8. |

*Runaway-render risk* (the 2026-10-30 incident: a fakeDom test grew without bound and OOM-killed the machine; see the `resource-limits` memory). Causes to design out, and guards to add:

1. **View rules**: `useAsync` deps (`hooks.mjs:46`) only primitives (ids, strings, numbers), never an object/array/closure built in render; no `setState` unconditionally in render or in an effect whose deps contain a value rebuilt each render (`useEffect(() => setX(f(data)), [f(data)])`); polling is a `setTimeout` chain with an attempt counter in a ref and a hard cap (D5), cleared on unmount; `catalog` and `state` are loaded once in `ApiView` and passed as props, never re-fetched by children on mount; rows in repeated fields have stable client keys.
2. **Shared test helper** `test/helpers/viewGuard.js`: `scriptedFetch(routes, { maxRequests = 150 })` records at most `maxRequests` entries and, when exceeded, returns a promise that never resolves (this halts an effect loop at its source) and sets `tripped = true`; every test ends with `assert.equal(guard.tripped(), false)`. `capRenders(preact, max = 3000)` wraps `preact.options.diffed` to count diffs and throws past the cap (a thrown error in an async re-render fails the test run immediately instead of looping). `dom.settle(n)` always with a small fixed `n` (no `while (changing)` loops); each test unmounts its root in a `finally`; `after(() => dom.restore())`.
3. **Run discipline** (`resource-limits` memory, brief): one file at a time, `OWB_NO_CONFIG_ENV=1 timeout 120 node --max-old-space-size=1024 --test --test-force-exit --test-timeout=30000 test/admin-view-api.test.js`; never two suites in parallel; on exit 137 or "heap out of memory" stop and bisect with a smaller cap.
4. fakeDom limits: no `showModal`, `select`, `focus`, `querySelectorAll` (`test/helpers/fakeDom.js:69-117`), and `navigator.clipboard` is undefined in Node, so every call is guarded (`typeof el.select === "function"`) and `copyText` takes its environment as an argument; `upload` is injected into `MediaField` (`uploadFn` prop) because an ES import cannot be stubbed.

*CSP and static-scan constraints* (all enforced by `test/admin-frontend.test.js`): no `innerHTML`, `eval`, `new Function`, inline `style=`, direct `.style`, inline `on*=`, `console.*`, `document.cookie`, `javascript:` (`:88-115`); no URL to another host (`:141`; example hosts in curl previews come from `location.origin`, never a literal `https://`); every relative import resolves, no bare specifier (`:218`); every module imports in Node without a DOM (`:240`); icons named in code exist in `icons.svg` (`:285-296`); every literal `class="..."` word has an `app.css` rule (`:1334`); every `/admin/api/...` literal matches a registered route with the right method and shape (`:1102`), so the C routes must exist before the views merge, DELETE calls need a suffix after the prefix, and each file declares its prefix constant once at the top; destructive POSTs carry `confirm: true` behind a `confirm()` shown within 2600 characters before the call (`:1155-1169`).

**Alternatives.** Heavier E2E in a headless browser (rejected: no browser dependency in the repo; fakeDom is the project's approach). A global render counter in the product code (rejected: test-only concern).

**Evidence.** `test/helpers/fakeDom.js:69-221`; `test/admin-view-data.test.js:400-520`; `test/admin-frontend.test.js:88-296,1029-1170,1334`; `components/hooks.mjs:46-68`.

---

## Interfaces with other streams

### Needed from C (C owns names; `P` = `/admin/api/api`, all `auth: "session"`, errors in the panel envelope)

| Id | Route | Request | Answer |
| -- | ----- | ------- | ------ |
| API-1 | `GET P` | - | `{ enabled, queued, stepUp: { confirmedUntil: ISO\|null, windowMs: 300000 }, settings: { minSpacingMs, perMinute, perDay, maxPending, queueMax, expiryMs, retentionDays, historyDays, settingKeys: { minSpacingMs: "API_MIN_SPACING_MS", ... } }, botReady }` |
| API-2 | `PUT P/state` | `{ enabled: true }` (step-up) or `{ enabled: false, confirm: true }` | `{ enabled, cancelled: n }`; audit `api.enable` / `api.disable` |
| API-3 | `GET P/catalog` | - | `{ version: "v1", baseUrl: "/api/v1", rights: [{ id, group, format: name\|null }], formats: [descriptor], endpoints: [{ id, method, path, right, summaryKey }], limits: { recipientsMax, keyNameMax } }` |
| API-4 | `GET P/keys` | - | `{ items: [KeyView] }` |
| API-5 | `POST P/keys` | `KeyInput` (step-up) | `201 { key: KeyView, secret }` |
| API-6 | `PUT P/keys/:id` | `KeyInput + version` (step-up only if widening) | `{ key }`; `409 conflict` on stale `version` |
| API-7 | `POST P/keys/:id/duplicate` | `{ name }` (step-up) | `201 { key, secret }` |
| API-8 | `POST P/keys/:id/revoke` | `{ confirm: true }` | `{ key, cancelled: n }` |
| API-9 | `GET P/messages` | query `key` (id or `panel`), `status`, `format`, `from`, `to` (ISO), `page`, `pageSize` | `{ items: [MessageRow], page, pageSize, total }` |
| API-10 | `GET P/messages/:id` | - | `{ message: MessageDetail }` |
| API-11 | `POST P/test` | `{ format, to, ...fields, uploadId? }` | `202 { message: MessageRow }`; refusals as envelope with `fields` keyed by dotted paths |
| API-12 | `GET P/usage` | `days=7\|30`, `key=<id>\|all` | `{ timezone, from, to, keys: [{ id, name, revoked, days: [{ day: "YYYY-MM-DD", sent, failed }] }] }`, dense (every day present) |
| API-13 | `GET P/openapi` | - | file download with `Content-Disposition` (works when the API is disabled) |
| REAUTH | `POST /admin/api/session/reauth` | `{ password }` | `200 { confirmedUntil }`; wrong: `422 validation_failed { fields: { password: { code: "wrong_password" } } }`; throttled: `429 rate_limited { params: { retryAfterMs } }` (limiter shared with login/password-change, `routes/auth.js:317`) |

Shapes:
- `KeyView = { id, name, last4, status: "active"|"revoked", revokedAt, createdAt, updatedAt, version, lastUsedAt, lastUsedIp, expiresAt, rights: [rightId], policy: { mode: "list"|"known"|"anyone", recipients: [{ jid, name|null }] }, limits: { perMinute, perDay, maxPending } (null = default), ipAllow: [string], queued }`.
- `KeyInput = { name, rights, policy: { mode, recipients: [jid] }, limits, ipAllow, expiresAt: ISO|null, version?, confirm?: ["policy_anyone"] }`; unknown properties rejected.
- `MessageRow = { id, source: "key"|"panel", key: { id, name }|null, to, toName|null, kind: "private"|"group", format, size|null, status, failureCode|null, acceptedAt }`.
- `MessageDetail = MessageRow + { waId, expiresAt, steps: [{ status, at }], interactive: bool, responses: { items: [{ at, author, choices: [{ id, label|null }] }], totals: [{ id, label|null, count }]|null, total } }`.
- Step-up gate: any widening save returns `403 password_required` (`params: { windowMs }`) when the session is not confirmed; widening definition identical to D4's table (server decides, SPA mirrors). Success of `REAUTH` stores `confirmedUntil` on the session (5 minutes).
- Panel envelope codes the SPA will translate (texts written by C in `panel-api-server.json`, listed in `STATUS_BY_CODE` and `EXTRA_SERVER_CODES`): `password_required`, `api_disabled`, `bot_unavailable`, `conflict` (exists), plus every engine/API refusal the test route can return (`chat_disabled`, `media_type_mismatch`, `media_too_large`, `url_forbidden`, `url_unreachable`, `queue_full`, `quota_exceeded`...).
- Uploads: purpose `api` in `PURPOSES` with an injected `sniff` using B's content detection; answer `{ uploadId, kind, mime, size, name }`; the `POST P/test` service consumes it with `uploads.consume(id, ctx.session.id, { purpose: "api" })`.
- `API_ENABLED` as a catalog entry must not be switchable through SET-2 without step-up and the cancel side effect: recommended `adapter` calling the same service as API-2 and shown read-only in Settings with "managed on the API page". Settings theme for the API settings appended to `THEME_ORDER` (`settings-logic.mjs:8`).
- Audit details (D8 shapes) and `ACTIONS` additions; if alert types are added, `alerts-logic.mjs` `ALERT_TYPES` rows.

### Needed from B (format descriptor, served inside API-3 `formats[]`)

```
{ name: "poll", right: "messages.send.poll", labelKey, descKey, interactive: true,
  media: null | { sources: ["file","url"], accept: ["image/jpeg", ...], maxBytes, captionMax: 1024|null },
  example: { ...realistic sample body, flat, no secrets },
  fields: [ { name, type, required, labelKey, hintKey?, placeholderKey?, min?, max?, step?, signed?, pattern?, patternHintKey?,
              options?: [{ value, labelKey }], default?,
              item?: <scalar Field>, items?: { min, max, fields: [Field] } } ] }
```
- `type` limited to `text, textarea, number, boolean, select, phone, url, list, recipient`; `file` is implied by `media` (rendered as one `file`/`url` pair, never listed in `fields`). Property names are the public JSON property names (flat body).
- `min`/`max` mean length for strings, value for numbers, row count for `list`; one error vocabulary = existing `fields.*` codes; server `fields` keys are dotted paths with numeric indices (`buttons.1.id`, `contacts.0.phones.2`) in the same syntax as `pathKey`.
- Label keys default by convention (`api.format.<name>.field.<field>.label`); the descriptor builder exports `panelKeysOfDescriptor`-equivalent data or the SPA derives it; either way a registry test must prove the keys exist.
- Registry exports: failure-code list (for `api.failure.<code>` completeness) and the interactive flag. Poll option labels and button/list choice labels in responses: see Open point 1.

### Needed from A

- IP allowlist entry grammar (IPv4, IPv4/n, IPv6, IPv6/n, normalisation) and the shared fixture `test/fixtures/api-ip-entries.json`.
- `GET P/openapi` content (OpenAPI 3 document with one example per format, taken from the same `example` objects), `baseUrl` constant `/api/v1`.
- Public message-id format (route param pattern for `:id`) and the `Authorization: Bearer` scheme shown in examples.

---

## Open points for the owner

1. **Option and choice labels in responses (FR-072 vs FR-073).** Showing "total per option" and the label of the chosen button needs the poll option texts and button/list choice labels, but FR-073 says no text is kept. Recommended answer: keep only those short labels (poll options, button and list titles, each already capped at 100 characters) for the retention period and never the question, body, caption or media; otherwise the panel can only show ids and "Option n".
2. **Uniqueness of key names.** Recommended: unique among non-revoked keys (a revoked name may be reused), so the history filter and the duplicate suffix stay unambiguous.
3. **Reactivating a revoked key.** Recommended: not offered (revocation is final; use Duplicate, which already needs the password), consistent with FR-014 and with "widening needs a password".
