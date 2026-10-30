# Contract: panel UI (feature 003)

The admin panel side of command permissions: the group "Permissions" tab, the Commands page column and editor, the shared rule editor and pickers, the pure logic, the panel texts and the view tests. Routes and their answers are in [admin-permissions-api.md](admin-permissions-api.md) (PERM-1 to PERM-7); the engine is in the runtime contract of this folder; tables are in [../data-model.md](../data-model.md). Nothing here touches the bot side.

Where [../research/c-panel-ui.md](../research/c-panel-ui.md) (stream C) disagrees with [../research.md](../research.md), research.md wins (owner decisions U1-U8, arbitration X1-X12). The points settled while writing this file are in [section 12](#12-points-settled-while-writing-this-contract).

Contents: [1 files](#1-files) / [2 API calls](#2-api-calls-per-view) / [3 data shapes](#3-data-shapes) / [4 permissions-logic.mjs](#4-permissions-logicmjs) / [5 RuleEditor](#5-permissions-editormjs-ruleeditor) / [6 pickers](#6-pickers) / [7 group tab](#7-the-group-tab-groups-permissionsmjs) / [8 Commands page](#8-the-commands-page) / [9 edits to existing files](#9-edits-to-existing-files) / [10 constraints](#10-degraded-states-deep-links-and-browser-constraints) / [11 panel texts](#11-panel-texts-fragment-merge-and-the-i18n-test) / [12 settled points](#12-points-settled-while-writing-this-contract) / [13 tests](#13-tests)

## 1. Files

No new panel area, route, navigation entry or `AREAS` change (C1). All paths are under `lib/admin/public/js/views/` unless stated. Every new file is a native ES module (`.mjs`), imports nothing from a build step, and does no DOM access at import time (`test/admin-frontend.test.js` imports each one in plain Node).

| File | New / edit | Exports | Role |
| ---- | ---------- | ------- | ---- |
| `permissions-logic.mjs` | new | see [section 4](#4-permissions-logicmjs) | Pure logic shared by both pages. Imports only `shortJid` from `groups-logic.mjs`. |
| `permissions-editor.mjs` | new | `RuleEditor` | The draft + Save editor of one rule. Knows no route. |
| `permissions-members.mjs` | new | `GroupMemberPicker` | Picker for a group scope (GRP-11 members). |
| `permissions-picker.mjs` | new | `PersonPicker` | Picker for the "everywhere" scope (known private chats + typed number). |
| `groups-permissions.mjs` | new | `PermissionsTab` | The group tab (rules, new rule, "allowed everywhere", orphans). |
| `commands-permissions.mjs` | new | `CommandPermissions`, `PermissionOrphans` | The Commands page card (the "everywhere" rule + groups list) and the orphan card. |
| `groups-logic.mjs` | edit | `TABS` | `["messages", "protection", "filters", "members", "commands", "permissions", "advanced"]` |
| `groups-page.mjs` | edit | none new | Imports `PermissionsTab`, one more `TabPanel`, the tab badge, `permissions.forget_*` texts in `AdvancedTab`. |
| `commands.mjs` | edit | none new | Loads PERM-1, "Permissions" column and row button, opens the card, reads `route.query`. |
| `audit-logic.mjs` | edit | `summarizeDetail` (new branch), `ruleIdLabel` | Rule details as "mode, +N, -M" with the ids. `ACTION_PREFIXES` does not change (X6). |
| `audit.mjs` | edit | none new | `Detail` renders the new `rule` kind. |
| `backup-logic.mjs` | edit | `MODEL_GROUPS` | `"PermissionRule"` after `"CommandState"` in the `config` group; header comments "25" become "26". |
| `lib/admin/public/i18n/{en,fr}.json` | generated | none | By the merge of [section 11](#11-panel-texts-fragment-merge-and-the-i18n-test). Never edited by hand. |
| `specs/003-command-permissions/i18n/panel-permissions.json` | new | none | The fragment (section 11). |
| `test/admin-i18n.test.js` | edit | none | Scans both fragment directories (section 11). |

Nothing else under `lib/admin/public/` changes: no CSS rule, no icon, no component, no router entry. Ownership for parallel work: one author owns the four shared files (`permissions-logic.mjs`, `permissions-editor.mjs`, `permissions-members.mjs`, `permissions-picker.mjs`) and the fragment; the group tab and the Commands page then consume them in parallel; the audit and backup edits are independent.

## 2. API calls per view

Every `/admin/api/...` literal below must match a registered route, or contract test 11 (`test/admin-frontend.test.js`) fails. The routes therefore have to exist (PERM-1..7 registered, GRP-3 `counts.permissions`) before these views merge; until then the views are written against a scripted `fetch`.

The scan resolves `const <name> = <path>` and `const <name> = (<args>) => <template>` prefixes, then `${name}/suffix` and `${name(args)}/suffix`. Each file declares its prefix once, at the top, in one of those two shapes. Path parameters are always `encodeURIComponent`-ed. DELETE calls always have a suffix after the prefix (`${base}/${...}`, `${base}/everywhere`): a DELETE that is exactly `` `${base}` `` or `${base}?...` is treated by the confirmation guard (`test/admin-frontend.test.js`, "no call to a route of 1.10") as a section 1.10 action and would demand `?confirm=true`. Rule deletion is a single-rule, idempotent delete with no server `confirm` (research.md G6), so it is not in `CONFIRMED_ACTIONS`.

| File | Prefix declaration | Calls (exact literals) | Route |
| ---- | ------------------ | ---------------------- | ----- |
| `groups-permissions.mjs` | ``const permissionsPath = (jid) => `/admin/api/groups/${encodeURIComponent(jid)}/permissions`;`` then `const base = permissionsPath(group.jid);` | `api("GET", base)` | PERM-5 |
| | | ``api("PUT", `${base}/${encodeURIComponent(name)}`, ruleBody(draft))`` | PERM-6 |
| | | ``api("DELETE", `${base}/${encodeURIComponent(name)}`)`` | PERM-7 |
| | | `api("GET", "/admin/api/commands")` | CMD-1 (unchanged) |
| | | `api("GET", "/admin/api/permissions")` | PERM-1 |
| `permissions-members.mjs` | ``const membersPath = (jid) => `/admin/api/groups/${encodeURIComponent(jid)}/members`;`` | `api("GET", membersPath(jid))` | GRP-11 (unchanged) |
| `permissions-picker.mjs` | none | `api("GET", "/admin/api/chats", chatQuery({ q, page }))` | CHAT-1, `kind=private`, no `selectable` |
| `commands.mjs` | none | `api("GET", "/admin/api/commands")` (existing), `api("GET", "/admin/api/permissions")` | CMD-1, PERM-1 |
| `commands-permissions.mjs` | ``const permissionsPath = (name) => `/admin/api/commands/${encodeURIComponent(name)}/permissions`;`` then `const base = permissionsPath(command.name);` | `api("GET", base)` | PERM-2 |
| | | ``api("PUT", `${base}/everywhere`, ruleBody(draft))`` | PERM-3 |
| | | ``api("DELETE", `${base}/everywhere`)`` | PERM-4 |
| | ``const groupRulePath = (jid, name) => `/admin/api/groups/${encodeURIComponent(jid)}/permissions/${encodeURIComponent(name)}`;`` | `api("DELETE", groupRulePath(scope, command))` (orphan rows of a group scope) | PERM-7 |

Why the group tab loads three lists (X3): PERM-5 carries the group's rules and the "everywhere" rules but not the commands' `access`, `desc`, `delegable` or `lockReason`. CMD-1 stays unchanged and supplies `access`, `desc`, `aliases` and the disabled state; PERM-1 supplies `delegable`, `lockReason` and the counts; the page merges them by `name` (`mergePermissions`). The three requests run in parallel in one `useAsync`; a failure of CMD-1 or PERM-1 fails the tab (EmptyState with Retry), a failure of GRP-11 only degrades the picker ([section 10](#10-degraded-states-deep-links-and-browser-constraints)).

On the Commands page the two lists load independently: CMD-1 keeps its current behaviour (a CMD-1 error shows the page error state); a PERM-1 error never blocks the page ([section 8](#8-the-commands-page)).

Limits: `limits.peopleMax` comes from PERM-5 (group tab) or PERM-1 (Commands page; PERM-2 carries none); the default in `permissions-logic.mjs` is 100 until the server answers.

## 3. Data shapes

As the views read them (the API contract is authoritative):

| Name | Shape |
| ---- | ----- |
| `Person` (API) | `{ jid, name: string \| null, present?: true \| false \| null, admin?: "admin" \| "superadmin" \| null }`. `jid` is the PN JID, or the LID JID when no number is known. `present` and `admin` exist on group routes only; `present: null` means the bot cannot tell (offline, group left). |
| `Warning` (API and client) | `{ code, tone: "warn" \| "info", params: {} }`; `params` is always an object. Server codes: `opens_admin_command`, `extra_on_public`, `empty_only`, `normal_here` (API contract 1.5). The client adds `disabled_here` and `context_only`, never sent by the server. |
| `Rule` (API) | `{ command, scope, mode: "extra" \| "only", people: [Person], warnings: [Warning], createdAt, updatedAt }`. |
| `PermissionItem` (PERM-1 `items[]`) | `{ name, delegable, lockReason: code \| null, everywhere: { mode, count } \| null, groups: n }` |
| `Command` (merged) | A CMD-1 command (`name`, `aliases`, `type`, `desc`, `access: { owner, admin, group, pm }`, `disabledGlobal`, `disabledGroups`) plus `perm: PermissionItem \| null` (`null` when PERM-1 has not loaded or failed). |
| `Draft` | `{ mode: "extra" \| "only", people: [Person] }`, `people` sorted by `personKey`, one entry per person. Owned by `RuleEditor`; never sent as is. |
| Body of PERM-3/6 | `ruleBody(draft)` = `{ mode, people: [jid] }` (one `jid` string per person, sorted by `personKey`). Nothing else: names, `present` and `admin` never travel. |

Identity discipline: the browser never decides that two JIDs are the same human beyond `personKey` (device suffix dropped, lower case, `@c.us` read as `@s.whatsapp.net`). `present` and `admin` are computed by the server (X10). Known limit: a person stored under a LID while the member list gives the PN (or the reverse) may show as two chips in one draft; the server merges them on Save (`changed` or not) and the editor remounts from the saved rule. This costs a duplicate chip, never a wrong grant.

## 4. `permissions-logic.mjs`

Pure: no DOM, no network, no timer, no `t()`. Functions that need a text return a **panel key** (and params) and the view calls `t(key, params)`. `test/admin-view-permissions.test.js` asserts that every key these functions can return exists in both catalogs.

### Constants

| Name | Value |
| ---- | ----- |
| `MODES` | `Object.freeze({ EXTRA: "extra", ONLY: "only" })` (X1) |
| `GLOBAL_SCOPE` | `"*"` |
| `PEOPLE_MAX` | `100` (default of `limits.peopleMax`) |
| `PEOPLE_PREVIEW` | `6` (chips shown in a row before "+N more") |
| `LOCK_REASONS` | `["code", "update", "data", "lockout", "config"]` (U7) |
| `PHONE_MIN`, `PHONE_MAX` | `8`, `15` (U5) |

### Commands, levels, locks

| Function | Semantics |
| -------- | --------- |
| `mergePermissions(commands, items)` -> `Command[]` | Adds `perm` to each CMD-1 command from PERM-1 `items`, matched by `name`. A command with no item gets `perm: null`. Order and other fields untouched; input not mutated. |
| `isLocked(command)` -> boolean | `Boolean(command.perm) && command.perm.delegable === false`. |
| `isDelegable(command)` -> boolean | `Boolean(command.perm) && command.perm.delegable === true`. `perm: null` is neither locked nor delegable (the UI shows "unavailable" and disables the button). |
| `lockReasonKey(lockReason)` -> string | `permissions.reason_<code>` when `lockReason` is in `LOCK_REASONS`, else `permissions.reason_unknown` (missing, null or unknown code; U7 fallback "reserved to the owner"). |
| `isPublic(access)` -> boolean | `!access.owner && !access.admin` (the access half of the server's `extra_on_public`, which also needs a non-empty list). |
| `normalLevel(access)` -> `"owner" \| "admin" \| "everyone"` | Owner wins over admin. The view shows `t("commands.access_" + level)` (existing keys). |
| `splitCommands(commands, existingNames)` -> `{ delegable: Command[], locked: Command[] }` | Feeds the "new rule" select. `delegable`: `isDelegable` and name not in `existingNames`. `locked`: `isLocked` (all of them, with or without a rule). Both sorted by name. `perm: null` commands are in neither list. |
| `commandCell(command)` -> `{ kind, ... }` | The Commands table cell. `{ kind: "unavailable" }` when `perm` is null; `{ kind: "locked", reasonKey }`; otherwise `{ kind: "rule" \| "none", mode, count, groups }` (`mode`/`count` from `perm.everywhere`, `groups` from `perm.groups`). The view builds the text: `permissions.cell_everywhere` / `cell_none`, then `permissions.cell_groups` when `groups > 0`. |

### Identity and typed numbers

| Function | Semantics |
| -------- | --------- |
| `personKey(jid)` -> string | Lower case; device suffix removed (`237690000001:7@s.whatsapp.net` -> `237690000001@s.whatsapp.net`); `@c.us` read as `@s.whatsapp.net`. Anything else returned trimmed and lower-cased. Never throws on a non-string (returns `""`). |
| `personLabel(person)` -> `{ name, number }` | `number` is `shortJid(person.jid)` (`+237...` or `@digits` for a LID); `name` is `person.name` or `null`. Pickers and chips always show the number, the name only next to it (push names are user-chosen and spoofable). |
| `parseNumber(input)` -> `{ ok: true, jid, digits } \| { ok: false, error: { code } }` | Trim; empty -> `required`. Characters other than digits, spaces, `+`, `-`, `.`, `(`, `)` -> `invalid_phone`. Strip those separators, then strip one leading `00`. 8 to 15 digits, else `invalid_phone`. A first digit `0` is also `invalid_phone` (a national number without country code; E.164 country codes never start with 0; the server applies the same rule). `jid` = `<digits>@s.whatsapp.net`. The error object is a field error the existing `fields.<code>` texts translate. |

### Draft

| Function | Semantics |
| -------- | --------- |
| `draftOf(rule)` -> `Draft` | From a saved rule: its mode and people (sorted copy). From `null` (new rule): `{ mode: "extra", people: [] }`. |
| `setMode(draft, mode)` -> `Draft` | Same object when the mode is already `mode` or is not in `MODES`. |
| `addPerson(draft, person, { max = PEOPLE_MAX })` -> `{ draft, error }` | `error` is `{ code: "duplicate" }` (same `personKey` already in the draft) or `{ code: "too_many_items", params: { max } }`; the draft is then the same object. Otherwise a new draft with the person inserted in `personKey` order. |
| `removePerson(draft, jid)` -> `Draft` | By `personKey`. Same object when absent. |
| `togglePerson(draft, person, { max })` -> `{ draft, error }` | Removes when present, else `addPerson`. Used by checkboxes. |
| `hasPerson(draft, jid)` -> boolean | By `personKey`. |
| `diffPeople(saved, draft)` -> `{ added: [jid], removed: [jid] }` | Set-based on `personKey`, `saved` is a rule or `null`. Add then remove the same person is clean. `jid` values are the draft's (added) or the saved rule's (removed). |
| `isDirty(saved, draft)` -> boolean | The mode differs from the saved mode, or the diff is not empty. With `saved === null`: the draft differs from `draftOf(null)` (an untouched new-rule draft is not dirty, so it does not trigger the unsaved-changes prompt). |
| `pendingCount(saved, draft)` -> number | `added + removed + (mode changed ? 1 : 0)`. With `saved === null` the mode counts when it differs from `extra`. |
| `canSave(draft, saved, { scope })` -> `{ ok, reason }` | `reason` is `"people_required"` when `scope === "*"` and `mode === "extra"` and no person (X4: such a rule is a no-op and the server refuses it); `"unchanged"` when `saved` exists and the draft is not dirty; otherwise `null` and `ok: true`. A group-scope `extra` rule with no person is saveable on purpose (U3 "normal level here"). |
| `ruleBody(draft)` -> `{ mode, people: [jid] }` | De-duplicated by `personKey`, sorted by `personKey`. |

### Warnings, badges, display

| Function | Semantics |
| -------- | --------- |
| `computeWarnings({ command, draft, scope, disabled = null, hasEverywhereOnly = false })` -> `[Warning]` | The live banners of the editor, in the order of the table in [section 10](#warnings-and-badges-x5). Each item is exactly `{ code, tone, params }`, and for the four server codes it is the same object the server would return for the same rule (API contract 1.5: same tone, same params; a test compares them on shared fixtures). `command` needs `access`. `disabled` is `null`, `"global"` or `"group"`. `hasEverywhereOnly` is true when an "everywhere" rule of this command is in mode `only` (it only decides the tone of `normal_here`; group scope only). Pure function of its inputs. |
| `normalizeWarnings(warnings)` -> `[Warning]` | Reads the server's `Rule.warnings` (or a PERM-2 per-group `warnings`): keeps the items whose `code` is one of the four server codes, forces `tone` to `"warn"` or `"info"` (default `"warn"`) and `params` to an object. Anything else (junk, unknown code) is dropped. |
| `warningTextKey(warning)` -> string \| null | The banner text key of a warning, from its `code`, `tone` and `params` (the table of section 10). `null` for an unknown code. The view calls `t(key, warning.params)`; `params.count` picks the `_one` form. |
| `warningBadges(warnings)` -> `[{ code, tone, key }]` | The short badges of a saved rule's row, from `normalizeWarnings` output: `permissions.badge_<code>`, except `normal_here` with tone `warn`, which is `permissions.badge_normal_here_noop`. The information-only ids have no badge. The tone is the warning's own (the server already applied the `normal_here` tone rule). |
| `personBadges(person, { adminCommand })` -> `[{ id, tone }]` | `former` (neutral) when `present === false`. Otherwise `admin` (info) when `person.admin` is `"admin"` or `"superadmin"`, else `not_admin` (warn) when `present === true` and `adminCommand`. Nothing when `present` is `null` or undefined (unknown is not shown as a fact). The view labels `admin` with the existing `groups.admin_admin` / `groups.admin_superadmin`, the others with `permissions.badge_<id>`. |
| `effectiveMode(groupRule, everywhereRule)` -> `{ mode: "normal" \| "extra" \| "only", source: "group" \| "everywhere" \| "none" }` | FR-006 step 4, display only: a group rule wins (even with an empty list), else the "everywhere" rule, else `normal`. |
| `peopleSummary(people, preview = PEOPLE_PREVIEW)` -> `{ shown, more }` | First `preview` people and how many are left. |
| `everywhereRows(everywhereRules, groupRules, commands)` -> `[{ command, rule, effective }]` | The "allowed everywhere" card of a group: for each "everywhere" rule whose command is a loaded, delegable `Command`, the rule and `effectiveMode(groupRule of that command, rule)`. Sorted by name. Rules on unknown or locked commands are skipped (they are orphans). |
| `groupOrphanRules(orphans)` -> `[{ command, reason, scopes: [{ scope, mode, count }] }]` | Groups PERM-1 `orphans` (every scope) by command, sorted by command; `scopes` sorted with `"*"` first. `reason` is `unknown_command` or `not_delegable`; an unknown value is read as `unknown_command`. |

### Queries and links

| Function | Semantics |
| -------- | --------- |
| `chatQuery({ q = "", page = 1, pageSize = 50 })` -> object | The CHAT-1 query of `PersonPicker`: `{ kind: "private", pageSize }` plus `page` when above 1 and `q` (trimmed, at most 100 characters) when not empty. Never `selectable`. |
| `selectionFromQuery(query, commands)` -> `{ name, panel: "permissions" } \| null` | Reads `#/commands?command=<name>&panel=permissions`. `null` unless `panel === "permissions"`, the command is loaded, and it is not locked. An alias is accepted and resolved to the command's `name`. |
| `groupTabTarget(jid)` -> `{ name: "groups", rest: [jid], query: { tab: "permissions" } }` | Arguments for `buildHash`. |
| `commandPanelTarget(name)` -> `{ name: "commands", rest: [], query: { command: name, panel: "permissions" } }` | Arguments for `buildHash`. |

## 5. `permissions-editor.mjs`: `RuleEditor`

One presentational component for both scopes. It owns the draft and knows nothing about routes: the parent makes the `api()` call, so contract test 11 sees real literals in the parent files.

```
RuleEditor({
  command,        // merged Command (needs name, access)
  scope,          // "*" or a group JID
  saved,          // Rule | null (null: a rule being created)
  busy,           // the parent's useAction flag
  limits,         // { peopleMax }
  context,        // { disabled: null | "global" | "group", hasEverywhereOnly: boolean }
  intro,          // optional text under the heading
  Picker,         // component rendered in the picker slot
  pickerProps,    // extra props for Picker
  onSave,         // async (body, draft) => void ; body = ruleBody(draft)
  onDelete,       // async () => void ; the parent asks for confirmation first
  onClose,        // () => void
})
```

The parent gives the component a `key` that changes with the server state (`${scope}:${command.name}:${version}`, `version` bumped after each successful save and after each reload), so a saved change starts a fresh draft. The component renders:

1. `section.card.stack` labelled by its heading `h2.card-title` (`permissions.editor_title`, `{ name }`), `tabIndex=-1`, focused on mount and scrolled into view like `ScopeEditor`.
2. A muted line with the scope (`permissions.scope_everywhere_label` or `permissions.scope_group_label`) and the normal level (`permissions.normal_level`, `{ level }` from `normalLevel`), then `intro` when given.
3. `fieldset.choice-group` with a `legend.field-label` (`permissions.mode_label`) and two radios (`label.choice`): `permissions.mode_extra`, `permissions.mode_only`; a `p.muted` with the hint of the selected mode (`mode_extra_hint` / `mode_only_hint`). There is no "normal" radio: going back to normal is "Delete the rule".
4. The people: `h3.field-label` (`permissions.people_title`) with the count, then `ul.row-wrap` of `li.chip` (`span.chip-text.mono` with the number and the name when known, badges from `personBadges`, `button.icon-btn` named `permissions.remove_person`); `permissions.people_empty` when none. The `error` of the last refused add (`duplicate`, `too_many_items`, `invalid_phone`...) shows in a `div.field-error[role=alert]` through `fieldErrorText`.
5. The `Picker` slot: `<Picker selected=${draft.people} max=${limits.peopleMax} disabled=${busy} onToggle=${...} onAdd=${...} ...pickerProps />`. `onToggle(person)` and `onAdd(person)` apply `togglePerson` / `addPerson` to the draft and return `{ error }` so the picker can show a field error next to its own input.
6. The warnings: `computeWarnings(...)` rendered as `div.banner.banner-warn` (tone `warn`) or `div.banner.banner-info` (tone `info`), `role="status"`, an `Icon` (`warning` or `info`) and `div.banner-body` with `t(warningTextKey(warning), warning.params)`. Live while the draft changes, and again after a save (they are computed from state, not from the save answer). **Never blocking**: Save stays enabled (US1 scenario 5: save, then warn).
7. The action row (`div.actions`): Save (`button.btn.btn-primary`, `common.save`, disabled when `busy` or `!canSave().ok`), Cancel (`button.btn`, `common.cancel`, calls `onClose` and discards the draft), and, when `saved`, Delete (`button.btn.btn-danger`, `permissions.delete_rule`, calls `onDelete`). Next to them: `span.muted[aria-live=polite]` with `permissions.pending` (`{ count }`) when dirty; `p.muted` with `permissions.save_blocked` when `canSave().reason === "people_required"`.
8. `useUnsavedGuard(\`permissions-${scope}-${command.name}\`, isDirty(saved, draft))`.

Save sends nothing when `canSave` is false. After a successful save the parent reloads its data and bumps `version`; the editor stays open on the saved rule. Delete is never sent without the parent's confirmation dialog (`confirm({ title, message, confirmLabel })`).

## 6. Pickers

Both receive `{ selected, max, disabled, onToggle, onAdd }` (plus their own props) and render inside the editor card. Neither holds the draft.

### `GroupMemberPicker` (`permissions-members.mjs`)

```
GroupMemberPicker({ jid, available, selected, max, disabled, onToggle })
```

- `available` comes from PERM-5 `members.available`. When it is `false` the picker does not call GRP-11 and shows only the notice `permissions.members_unavailable` (`p.muted[role=status]`).
- Otherwise it loads `GET /admin/api/groups/:jid/members` once on mount (`useAsync`, keyed by `jid`). A failure (409 `not_connected` or `group_left`, or any error) shows the same notice and nothing else: people can still be removed in the editor.
- Rendered: `permissions.members_title` heading; a search input (`groups.members_search` label, `groups.members_search_placeholder`, `maxlength` 100) filtering with `filterMembers`; a `DataTable` (`rowKey="jid"`) sorted with `sortMembers`, 25 per page with `paginate` / `Pagination`; columns: `permissions.col_pick` (a checkbox in a `label.choice`, `aria-label` = `permissions.pick_person` with the number), `groups.col_member` (`span.mono` with `shortJid`), `groups.col_admin` (the existing `groups.admin_*` badge or `-`). Empty search result: `groups.members_no_match`.
- Checked means `hasPerson(draft, member.jid)`. Ticking calls `onToggle({ jid: member.jid, name: null, present: true, admin: member.admin })`. When the draft holds `max` people, unchecked boxes are disabled; the editor shows `fields.too_many_items` if a toggle is refused.
- No call to CHAT-1 and no typed number here: a group rule is for members (FR-020), picked from the list.

### `PersonPicker` (`permissions-picker.mjs`)

```
PersonPicker({ selected, max, disabled, onToggle, onAdd })
```

- Known contacts: `GET /admin/api/chats` with `chatQuery`, 50 per page, a search box (`permissions.picker_search`), `permissions.picker_hint` above (check the number: a display name can mislead). Columns: pick (checkbox, `permissions.pick_person`), `permissions.col_name` (name or a muted dash), `permissions.col_number` (`span.mono`, `shortJid`). Empty: `permissions.picker_empty`. Ticking calls `onToggle({ jid: chat.jid, name: chat.name || null })` (no `present` or `admin`: the "everywhere" scope has no group).
- Typed number: a `form.row-wrap` with a `Field` (`name="permissions-number"`, label `permissions.number_label`, hint `permissions.number_hint`, `inputMode="tel"`, `maxLength` 32), submitted by a `button.btn` `permissions.number_add`. Submit runs `parseNumber`; on error the field shows `fieldErrorText(error)` and nothing is added; on success it calls `onAdd({ jid, name: null })`, clears the input, and shows the editor's `duplicate` / `too_many_items` answer as the field error when `onAdd` refuses.
- It never lists group members and never reads the bot's connection: it works with the bot offline.

## 7. The group tab (`groups-permissions.mjs`)

`PermissionsTab({ group, onGroup, reload })` (same props as `MembersTab` and `CommandsTab`: `common = { group, onGroup, reload }`). `reload` refreshes GRP-3 (the tab badge). Data: one `useAsync` over the three requests of [section 2](#2-api-calls-per-view), keyed by `group.jid`, plus a `version` counter and `editing` (`{ name } | null`) in `useState`.

```
 [Messages][Protection][Filters][Members][Commands][Permissions 3][Advanced]
 +- Permissions of this group ---------------------------------------------+
 | Choose who can use a command here. The owner always has access, ...     |
 | Command [ Choose a command...  v ]   [Create the rule]                  |
 |   optgroup "Commands you can delegate": dice, kick, vv, ...             |
 |   optgroup "Never delegable" (disabled): eval - it runs code ..., ban...|
 +- Rules of this group ---------------------------------------------------+
 | .vv    Normal + these people  2 people   +2376...01 [Admin] +2376...02  | [Edit]
 | .kick  Normal + these people  2 people   [Opens an admin command]       | [Edit]
 | .dice  Normal + these people  0 people   [Exception: normal level here] | [Edit]
 +- (editor card, one at a time, under the rules card) --------------------+
 +- Allowed everywhere ----------------------------------------------------+
 | .vv  Mode here: Normal + these people  +2376...04, +2376...05           |
 | .dice  Mode here: Normal + these people (rule of this group)  Only ...  | Edit .dice on the Commands page
 +- Rules without a usable command ----------------------------------------+
```

- **New rule card.** A `select.select` named by `permissions.new_command_label` with two `optgroup`s built from `splitCommands(commands, rule names)`: `permissions.optgroup_delegable` (enabled options, value = command `name`, text = name) and `permissions.optgroup_locked` (every option `disabled`, text = `permissions.locked_option` with `{ name, reason }`, `reason` = `t(lockReasonKey(lockReason))`). A native `select` keeps disabled options greyed and accessible without CSS. "Create the rule" (`permissions.new_create`, disabled until a command is chosen) opens the editor with `saved = null`. A command that already has a rule is not in the delegable group: it is edited from its row.
- **Rules card.** One row per rule, sorted by command: name (`span.mono`), mode label (`permissions.mode_extra` / `mode_only`), `permissions.people_count`, the badges of `warningBadges(normalizeWarnings(rule.warnings))` (`span.badge.badge-warn` / `badge-info` per tone; the server already applied the `normal_here` tone rule), the first `PEOPLE_PREVIEW` people as chips with `personBadges` (`permissions.people_more` for the rest), and an Edit button (`button.btn.btn-sm`, `common.edit`, `aria-label` = `permissions.edit_rule`). Empty: `EmptyState` with `permissions.rules_empty` and `permissions.rules_empty_hint`. A rule row for an `extra` rule with no person reads as an exception: the `normal_here` badge ("Exception: normal level here", or "No effect" when no "everywhere" rule is in mode `only`).
- **Editor.** `RuleEditor` with `scope = group.jid`, `Picker = GroupMemberPicker`, `pickerProps = { jid: group.jid, available: data.members.available }`, `context = { disabled, hasEverywhereOnly }` where `disabled` comes from `commandState(command, group.jid, group.disabledCommands)` of `groups-logic.mjs` (`"on"` becomes `null`). One editor at a time, keyed by command; it renders directly under the rules card.
  - Save: `run(async () => { await api("PUT", ...); toastSuccess(t("permissions.saved", { name })); setVersion(...); await Promise.all([reloadData(), reload()]); })`. Errors are toasted by `useAction`.
  - Delete: `confirm({ title: t("permissions.delete_title", { name }), message: t("permissions.delete_message_group"), confirmLabel: t("permissions.delete_rule") })`, then the DELETE, `permissions.deleted` toast, close the editor, reload data and the group (badge).
- **Allowed everywhere card** (read-only): for each row of `everywhereRows`, the command, `permissions.mode_here` (or `mode_here_group` when `effective.source === "group"`) with the label of `effective.mode`, the people of the "everywhere" rule as plain chips (no admin or former badges: those people have access wherever they are), or `permissions.only_owner` for an `only` rule with no person, and a link to `buildHash(...commandPanelTarget(name))` with the text `permissions.everywhere_edit`. Empty: `permissions.everywhere_empty`.
- **Orphans card** (only when PERM-5 `orphans` is not empty): title and hint `permissions.orphans_title` / `orphans_hint`; per row the command, `permissions.orphan_<reason>`, and `button.icon-btn` (trash) named by `permissions.orphan_remove` that calls PERM-7 without a dialog (same as the command-state orphans), toasts `permissions.orphan_removed`, reloads.
- **Tab badge**: `counts.permissions` of GRP-3, refreshed by `reload()` after each write.

## 8. The Commands page

Edits to `commands.mjs` (all small; the CMD-1 and CMD-2 behaviour is unchanged):

1. `export default function CommandsView({ route })`: reads `route.query` (`command`, `panel`).
2. A second `useAsync` for PERM-1 (`api("GET", "/admin/api/permissions")`); `commands = mergePermissions(patched CMD-1 commands, items)`. A PERM-1 failure leaves `perm: null` on every command and shows `permissions.load_failed` (`p.muted[role=status]`, with `{ reason }` from `tError`) above the table; the rest of the page works.
3. `selected` becomes `{ name, panel: "scopes" | "permissions" } | null`; only one editor is open at a time. The existing `ScopeEditor` opens for `panel: "scopes"` exactly as today.
4. A new column "Permissions" (`commands.col_permissions`) between State and Actions, rendered from `commandCell`:
   - `rule`: `permissions.cell_everywhere` (`{ mode, people }`, `people` = `permissions.people_count`) and, when `groups > 0`, `permissions.cell_groups` (`{ count }`) on a second line;
   - `none`: `permissions.cell_none`, plus `permissions.cell_groups` when `groups > 0`;
   - `locked`: `StatusBadge tone="neutral"` with `permissions.locked_badge`, and the text `permissions.locked_reason` (`{ reason }`) **in the cell** (never tooltip-only: touch screens);
   - `unavailable`: `span.muted` `permissions.cell_unavailable`.
5. A second row button next to "Scopes": `button.btn.btn-sm`, `commands.permissions_button`, `aria-pressed` when its card is open, `disabled` when the command is locked or `perm` is null. A locked row's name is rendered with the `muted` class.
6. The card: when `selected.panel === "permissions"`, `CommandPermissions` renders in the slot of `ScopeEditor` (above the table), keyed by command name.
7. The orphan card: `PermissionOrphans` below the existing `OrphanRows`, from PERM-1 `orphans` through `groupOrphanRules`. Rows: the command, `permissions.orphan_<reason>`, and one chip per scope (`commands.scope_everywhere` for `*`, else the group's `shortJid`) with a trash `icon-btn` (`permissions.orphan_remove`, `{ command, scope }`) that calls PERM-4 (scope `*`) or PERM-7 (group scope), no dialog, then `permissions.orphan_removed` and a reload of PERM-1.
8. Opening from a link: an effect keyed by `route.query.command`, `route.query.panel` and the loaded data applies `selectionFromQuery(route.query, commands)` once per distinct query. The card is not closed by later data reloads.

`CommandPermissions({ command, limits, disabledGlobal, busy, onChanged, onClose })` (`commands-permissions.mjs`):

```
 +- Rule for .vv ------------------------------------------------------------+
 | Scope: everywhere (every group and private chats) - Normal level: Owner     |
 | The "everywhere" rule applies in every group and in private chats. ...      |
 | Mode (o) Normal + these people ( ) These people only                        |
 | People [+237690000001 x] [+237690000002 x]                                  |
 | Add people: [Search a contact] [x] Marie +237690000003 ...      < 1/2 >     |
 |             Or type a number [ +237 6 90 00 00 04 ] [Add this number]       |
 | (warnings)                                                                  |
 | [Save] [Cancel] 2 unsaved changes                [Delete the rule]          |
 +- Groups with their own rule (1) ------------------------------------------+
 | Chess club - These people only - 3 people                         [Open]    |
 +-----------------------------------------------------------------------------+
```

- It loads PERM-2 (`useAsync` keyed by the command name): spinner while loading, an `EmptyState` with Retry on error, and it renders `RuleEditor` with `scope = "*"`, `saved = data.everywhere`, `Picker = PersonPicker`, `context = { disabled: disabledGlobal ? "global" : null, hasEverywhereOnly: false }`, `intro = t("permissions.cmd_intro")`.
- Save: PERM-3, `permissions.saved` toast, bump `version`, `await Promise.all([reloadDetail(), onChanged()])` (`onChanged` reloads PERM-1 for the table column). Delete: `confirm` with `permissions.delete_message_everywhere`, PERM-4, `permissions.deleted` toast, same reloads.
- Groups card: `permissions.cmd_groups_title` (`{ count }`), one row per `data.groups[]` (group `name` or `shortJid(jid)`, mode label, `permissions.people_count`, `warningBadges(normalizeWarnings(group.warnings))` (PERM-2's per-group warnings omit `opens_admin_command`: it needs participant data and PERM-2 never calls WhatsApp), and a link `a.btn.btn-sm` to `buildHash(...groupTabTarget(jid))` labelled `common.open` with `aria-label` = `permissions.cmd_group_open`). It is **read-only**: group rules are created and edited from the group tab only (FR-021 asks for the "everywhere" rule here). Empty: `permissions.cmd_groups_empty`.

## 9. Edits to existing files

| File | Change |
| ---- | ------ |
| `groups-logic.mjs` | `TABS` as in [section 1](#1-files). `tabOf("permissions")` returns `"permissions"`; `tabOf` of anything unknown still falls back to the first tab. |
| `groups-page.mjs` | `import { PermissionsTab } from "./groups-permissions.mjs"`. One `TabPanel id="permissions"` between `commands` and `advanced`. In `tabs`, `badge: id === "permissions" ? counts.permissions : ...`; the `counts` default stays as it is, so a missing field gives `undefined` and no badge (a real `0` shows `0` like the other tabs). In `AdvancedTab`, the deletion toast and hint use `permissions.forget_done` (`answer.deleted`, which carries `permissionRules`) and `permissions.forget_hint` instead of `groups.delete_done` / `groups.delete_hint` (section 12, point 4). The DELETE call itself (`?confirm=true`) is unchanged. |
| `commands.mjs` | [Section 8](#8-the-commands-page). |
| `audit-logic.mjs` | `summarizeDetail` gets a branch before the generic text: when the detail has only keys among `mode`, `previousMode`, `added`, `removed`, `addedCount`, `removedCount`, `mode` is a non-empty string, and each of `added` / `removed` is either an array of strings or absent, it returns `{ kind: "rule", mode, previousMode: string \| null, added: string[] \| null, removed: string[] \| null, addedCount, removedCount }`. The counts are the list length, or the number the server sent instead of a list: above 1900 serialized characters the server (API contract 1.7) replaces `removed` by `removedCount`, then `added` by `addedCount`, so the count can exist without the ids. Ids are cut to 48 characters, at most 100 per list; a missing list and a missing count together fall back to the generic text. Any other shape, including the server's `{ truncated, length, keys }`, keeps the current behaviour. New export `ruleIdLabel(id)`: digits become `+<digits>`, `<digits>@lid` becomes `@<digits>`, anything else is returned as is. `ACTION_PREFIXES` is unchanged: the actions are `command.permission.set` and `command.permission.delete` and the `command` prefix already covers them (X6). |
| `audit.mjs` | `Detail` renders `rule`: `t("audit.detail_rule", { mode, added: addedCount, removed: removedCount })` where `mode` is the label of `permissions.mode_<mode>` (the raw string when unknown), then `audit.detail_rule_was` when `previousMode` exists and differs, then, for each list that is present, its ids in `span.mono` inside `span.badge.badge-ok` (added, prefixed `+`) and `span.badge.badge-danger` (removed, prefixed `-`), `ruleIdLabel` for each. A list replaced by its count shows the number only. The ids are listed in full: the generic JSON summary is cut at 160 characters and would hide who was added. |
| `backup-logic.mjs` | `"PermissionRule"` after `"CommandState"` in the `config` group of `MODEL_GROUPS`; "25 exported models" comments become 26. The page order is pinned against the server's `MODELS` by `test/admin-view-backup.test.js`. |

## 10. Degraded states, deep links and browser constraints

### Warnings and badges (X5)

One vocabulary and one shape, `{ code, tone, params }`. The server computes the four server codes on every read and on PUT (API contract 1.5); `computeWarnings` recomputes the same four live from the draft with the **same tone and the same params**, plus two information-only codes the server never sends. Order of display: the fixed order below (warnings first, then information).

| `code` | `tone` | Condition (live, on the draft) | `params` | Text key (`warningTextKey`) | Short badge key |
| ------ | ------ | ------------------------------ | -------- | --------------------------- | --------------- |
| `opens_admin_command` | `warn` | `command.access.admin` **and** at least one person **and** (scope `*`, or at least one person whose `admin` is not `"admin"`/`"superadmin"`). Both modes. Unknown status (`present` `null` or `false`, `admin` `null`) counts as not admin: the conservative rule of the server, never "present only". | `{ count, everywhere }`. Group scope: `count` = persons not known as admin, `everywhere: false`. Scope `*`: `count` = number of people, `everywhere: true`. | `everywhere` false: `permissions.warn_opens_admin_command` / `_one` (picked by `count`); true: `permissions.warn_opens_admin_command_everywhere` | `permissions.badge_opens_admin_command` |
| `extra_on_public` | `warn` | mode `extra`, **at least one person**, and `isPublic(access)` | `{}` | `permissions.warn_extra_on_public` | `permissions.badge_extra_on_public` |
| `empty_only` | `warn` | mode `only`, no person | `{}` | `permissions.warn_empty_only` | `permissions.badge_empty_only` |
| `normal_here` | `info` when `hasEverywhereOnly`, else `warn` ("sans effet") | scope is a group, mode `extra`, no person (U3) | `{}` | `info`: `permissions.info_normal_here`; `warn`: `permissions.warn_normal_here` | `info`: `permissions.badge_normal_here`; `warn`: `permissions.badge_normal_here_noop` |
| `disabled_here` (client only) | `info` | `disabled` is `"global"` or `"group"` | `{ where: "global" \| "group" }` | `permissions.info_disabled_here_global` / `_group` | none |
| `context_only` (client only) | `info` | `access.pm` (any scope), or `access.group` with scope `*` | `{ context: "pm" \| "group" }` | `permissions.info_context_only_pm` / `_group` | none |

`extra_on_public` needs a non-empty list, so an empty group `extra` rule on a public command yields `normal_here` alone (the two never appear together). The information-only codes have no row badge. PERM-2's per-group `warnings` omit `opens_admin_command`.

Person badges (chips of a group rule): `Admin` (info, existing `groups.admin_*`), `Not an admin` (warn, only when the command is an admin command and `present === true`), `No longer in the group` (neutral, `present === false`; the chip's remove button stays usable). `present: null` shows nothing. Roles `muted` and `banned` are not special-cased (`.role` still applies, spec Assumptions).

### Degraded states

| Situation | Behaviour |
| --------- | --------- |
| Bot offline, or group left (PERM-5 `members.available: false`; GRP-11 answers 409) | The group tab stays usable: `permissions.members_unavailable` replaces the picker; people can still be removed, the mode changed, the rule saved or deleted; `present`/`admin` are `null`, so no "former" or "not an admin" badge is shown, and the admin-command warning counts unknown people (it says "not known to be admins"). A former group keeps its rules (spec edge case); the header already shows the "former group" badge. |
| Bot offline, Commands page | Fully usable: the "everywhere" editor and `PersonPicker` read the database only. |
| PERM-1 fails on the Commands page | `permissions.load_failed`; the column shows `permissions.cell_unavailable`, the Permissions buttons are disabled; scopes and the global switch work as before. |
| PERM-5, CMD-1 or PERM-1 fails on the group tab | `EmptyState` (`common.view_error`, `tError`) with a Retry button. |
| PERM-2 fails (card) | `EmptyState` with Retry inside the card; the table is unaffected. |
| 404 `not_found` on a group or command (deleted meanwhile) | The error toast of `useAction`; the tab/card shows the error state on the next reload. |
| Two tabs edit the same rule | Last save wins (spec); each save is its own audit row. The editor of the older tab keeps its draft until it reloads. |

### Deep links

- `#/commands?command=<name>&panel=permissions` opens the Commands page with the "everywhere" card of that command (alias accepted; ignored when the command is unknown or locked). The group tab's "allowed everywhere" card links here.
- `#/groups/<jid>?tab=permissions` opens the group's Permissions tab. The Commands card's groups list and the audit page may link here.
- Both use `buildHash` from `router.mjs` with the targets of `groupTabTarget` / `commandPanelTarget`; neither needs a router change (`parseHash` already returns `query`).

### CSP, CSS and accessibility

- No `innerHTML`, `eval`, inline `<script>`, inline `style=` attribute or third-party URL (strict CSP; `test/admin-frontend.test.js` scans every module). Texts are always rendered as text nodes through `html` templates.
- Only classes that already exist in `app.css`, because the css guard demands a rule for every literal `class="..."` word: `card card-title stack stack-sm row row-wrap grow view-header chip chip-text badge badge-ok badge-warn badge-danger badge-info banner banner-warn banner-info banner-body muted mono icon-btn btn btn-sm btn-primary btn-danger select input field field-label field-hint field-error choice choice-group actions cell-actions nowrap sr-only`. There is **no** `badge-neutral` rule: a neutral badge is `StatusBadge tone="neutral"` (interpolated class) or a bare `span.badge`. No new CSS, no new icon (`Icon` names used: `warning`, `info`, `trash`, `close`, `plus`, `refresh`, `chevron-left`).
- 360 px: chips wrap (`row-wrap`), the editor is a single column, the member and contact tables are the responsive `DataTable` (labelled cards under 600 px), long names truncate through `chip-text`.
- Every control has an accessible name (remove buttons, checkboxes, the command select, the number field); warnings are `role="status"`; refusals under inputs are `role="alert"` (the `field-error` pattern); the editor heading takes focus on open; nothing relies on colour alone (badges carry text).

## 11. Panel texts, fragment, merge and the i18n test

One fragment, `specs/003-command-permissions/i18n/panel-permissions.json`: `{ "en": { ... }, "fr": { ... } }`, flat dot keys, identical key sets and `{placeholders}` in both languages. It also carries the few keys of other namespaces (`audit.*`, `backup.*`, `commands.*`, `groups.*`); the merge tool does not care about the file name. The bot side has no new text in this feature (silent refusal has no text; delegated `.vv` DMs reuse existing keys).

French rules (`test/admin-i18n.test.js`): vouvoiement, "panel d'administration" and never "panneau". Plurals follow the `key` / `key_one` convention of `i18n.mjs` (`Intl.PluralRules`: in French `0` and `1` both pick `_one`, so "0 personne"; in English `0` picks the base form "0 people"). Every `_one` keeps the `{count}` placeholder of its base.

Merge (dry run first), then check nothing is left to do:

```bash
node tools/merge-panel-i18n.js --frag-dir specs/003-command-permissions/i18n --dry-run
node tools/merge-panel-i18n.js --frag-dir specs/003-command-permissions/i18n
node tools/merge-panel-i18n.js --frag-dir specs/003-command-permissions/i18n --dry-run   # second run: no change
```

The catalogs are flat and sorted; the tool normalises the order and checks the placeholders. Do not edit `lib/admin/public/i18n/*.json` by hand for these keys: `test/admin-i18n.test.js` fails when a fragment text differs from its catalog entry.

### Test change: `test/admin-i18n.test.js`

- Replace the single constant `FRAGMENT_DIR` (`specs/002-admin-panel/i18n`) used by `loadFragments()` with `FRAGMENT_DIRS = [specs/002-admin-panel/i18n, specs/003-command-permissions/i18n]`; `loadFragments()` reads `panel-*.json` from each directory that exists and tags every fragment with its directory. The "valid and complete / do not conflict" test (same key, different value across fragments) and the "every fragment is merged" test then cover both directories unchanged; update the `t.diagnostic` line and the failure hint of the merge command to name the directory.
- Add one assertion that `panel-permissions.json` is among the loaded fragments, so an empty directory scan cannot pass silently.
- The bot-fragment test keeps its directory (`specs/002-admin-panel/i18n`, `bot-*.json`, at least 8 files): this feature has no `bot-*.json`.
- Nothing else in the file changes: the literal `t("...")` and dynamic `t(\`prefix${...}\`)` scans already cover the new modules.

### Key list

Keys marked (existing) are reused and not in the fragment: `common.save`, `common.cancel`, `common.close`, `common.open`, `common.edit`, `common.remove`, `common.retry`, `commands.access_owner` / `_admin` / `_everyone`, `commands.scope_everywhere`, `groups.admin_admin`, `groups.admin_superadmin`, `groups.col_member`, `groups.col_admin`, `groups.members_search`, `groups.members_search_placeholder`, `groups.members_no_match`, `fields.required`, `fields.invalid_phone`, `fields.duplicate`, `fields.too_many_items`.

#### Other namespaces

| Key | en | fr |
| --- | -- | -- |
| `audit.detail_rule` | {mode}: +{added}, -{removed} | {mode} : +{added}, -{removed} |
| `audit.detail_rule_was` | was {mode} | était {mode} |
| `backup.model_PermissionRule` | Permission rules | Règles de permission |
| `commands.col_permissions` | Permissions | Permissions |
| `commands.permissions_button` | Permissions | Permissions |
| `groups.tab_permissions` | Permissions | Permissions |

#### Modes, levels, people

| Key | en | fr |
| --- | -- | -- |
| `permissions.mode_label` | Mode | Mode |
| `permissions.mode_extra` | Normal + these people | Normal + ces personnes |
| `permissions.mode_extra_hint` | The command keeps its normal level. The people listed can use it as well. | La commande garde son niveau normal. Les personnes listées peuvent aussi l'utiliser. |
| `permissions.mode_only` | These people only | Ces personnes seulement |
| `permissions.mode_only_hint` | Only the people listed and the owner can use it. Everybody else is ignored without any reply. | Seules les personnes listées et le propriétaire peuvent l'utiliser. Tous les autres sont ignorés sans aucune réponse. |
| `permissions.mode_normal` | Normal (no rule) | Normal (aucune règle) |
| `permissions.normal_level` | Normal level: {level} | Niveau normal : {level} |
| `permissions.scope_everywhere_label` | Scope: everywhere (every group and private chats) | Portée : partout (tous les groupes et le privé) |
| `permissions.scope_group_label` | Scope: this group | Portée : ce groupe |
| `permissions.people_title` | People | Personnes |
| `permissions.people_count` | {count} people | {count} personnes |
| `permissions.people_count_one` | {count} person | {count} personne |
| `permissions.people_empty` | Nobody yet. | Personne pour l'instant. |
| `permissions.people_more` | +{count} more | +{count} autres |
| `permissions.people_more_one` | +{count} more | +{count} autre |
| `permissions.only_owner` | Only the owner | Seul le propriétaire |
| `permissions.remove_person` | Remove {person} | Retirer {person} |
| `permissions.badge_not_admin` | Not an admin | Non admin |
| `permissions.badge_former` | No longer in the group | Ne fait plus partie du groupe |

#### Editor

| Key | en | fr |
| --- | -- | -- |
| `permissions.editor_title` | Rule for {name} | Règle pour {name} |
| `permissions.edit_rule` | Edit the rule for {name} | Modifier la règle de {name} |
| `permissions.pending` | Unsaved changes: {count} | Modifications non enregistrées : {count} |
| `permissions.save_blocked` | Add at least one person, or delete the rule. | Ajoutez au moins une personne, ou supprimez la règle. |
| `permissions.saved` | Rule saved for {name}. | Règle enregistrée pour {name}. |
| `permissions.deleted` | Rule removed for {name}. | Règle supprimée pour {name}. |
| `permissions.delete_rule` | Delete the rule | Supprimer la règle |
| `permissions.delete_title` | Delete the rule for {name}? | Supprimer la règle de {name} ? |
| `permissions.delete_message_group` | The people listed lose this access in this group and the command goes back to its normal level here. | Les personnes listées perdent cet accès dans ce groupe et la commande reprend ici son niveau normal. |
| `permissions.delete_message_everywhere` | The people listed lose this access everywhere, except where a group has its own rule. | Les personnes listées perdent cet accès partout, sauf dans les groupes qui ont leur propre règle. |
| `permissions.picker_title` | Add people | Ajouter des personnes |

#### Never-delegable commands (U7)

| Key | en | fr |
| --- | -- | -- |
| `permissions.locked_badge` | Cannot be delegated | Non délégable |
| `permissions.locked_reason` | Cannot be delegated: {reason}. | Non délégable : {reason}. |
| `permissions.locked_option` | {name} - {reason} | {name} - {reason} |
| `permissions.reason_code` | it runs code on the bot's machine | elle exécute du code sur la machine du bot |
| `permissions.reason_update` | it updates the bot | elle met à jour le bot |
| `permissions.reason_data` | it exports personal data | elle exporte des données personnelles |
| `permissions.reason_lockout` | it can lock the owner out of a chat | elle peut exclure le propriétaire d'une discussion |
| `permissions.reason_config` | it sets how the bot behaves | elle règle le comportement du bot |
| `permissions.reason_unknown` | it is reserved to the owner | elle est réservée au propriétaire |

#### Warnings and short badges (X5)

| Key | en | fr |
| --- | -- | -- |
| `permissions.warn_opens_admin_command` | {count} people are not known to be admins of this group. They will be able to use this admin command (for example to remove members) through the bot, as long as the bot is an admin. | {count} personnes ne sont pas connues comme administrateurs de ce groupe. Elles pourront utiliser cette commande d'administration (par exemple pour retirer des membres) par l'intermédiaire du bot, tant que le bot est administrateur. |
| `permissions.warn_opens_admin_command_one` | {count} person is not known to be an admin of this group. This person will be able to use this admin command (for example to remove members) through the bot, as long as the bot is an admin. | {count} personne n'est pas connue comme administrateur de ce groupe. Elle pourra utiliser cette commande d'administration (par exemple pour retirer des membres) par l'intermédiaire du bot, tant que le bot est administrateur. |
| `permissions.warn_opens_admin_command_everywhere` | This command is reserved to group admins. The people listed will be able to use it in every group where the bot is an admin, even if they are not admins themselves. | Cette commande est réservée aux administrateurs de groupe. Les personnes listées pourront l'utiliser dans tous les groupes où le bot est administrateur, même sans l'être elles-mêmes. |
| `permissions.warn_extra_on_public` | This command is already open to everyone: adding people changes nothing. Choose "These people only" to restrict it. | Cette commande est déjà ouverte à tout le monde : ajouter des personnes ne change rien. Choisissez « Ces personnes seulement » pour la restreindre. |
| `permissions.warn_empty_only` | The list is empty: only the owner will be able to use this command. | La liste est vide : seul le propriétaire pourra utiliser cette commande. |
| `permissions.info_normal_here` | An empty list means "normal level here": in this group the command goes back to its normal level, whatever the "everywhere" rule says. | Une liste vide signifie « niveau normal ici » : dans ce groupe, la commande reprend son niveau normal, quelle que soit la règle « partout ». |
| `permissions.warn_normal_here` | This rule has no effect: no "everywhere" rule restricts this command, so it already has its normal level here. You can delete it. | Cette règle n'a aucun effet : aucune règle « partout » ne restreint cette commande, elle a donc déjà son niveau normal ici. Vous pouvez la supprimer. |
| `permissions.info_disabled_here_global` | This command is switched off everywhere. Switching off wins over permissions: the people allowed get the "command disabled" answer, and with "These people only" everybody else gets no reply. | Cette commande est désactivée partout. La désactivation l'emporte sur les permissions : les personnes autorisées reçoivent la réponse « commande désactivée » et, avec « Ces personnes seulement », tous les autres n'obtiennent aucune réponse. |
| `permissions.info_disabled_here_group` | This command is switched off in this group. Switching off wins over permissions: the people allowed get the "command disabled" answer, and with "These people only" everybody else gets no reply. | Cette commande est désactivée dans ce groupe. La désactivation l'emporte sur les permissions : les personnes autorisées reçoivent la réponse « commande désactivée » et, avec « Ces personnes seulement », tous les autres n'obtiennent aucune réponse. |
| `permissions.info_context_only_group` | This command only works in groups. It stays refused in private chats. | Cette commande ne fonctionne qu'en groupe. Elle reste refusée en privé. |
| `permissions.info_context_only_pm` | This command only works in private chats. It stays refused in groups. | Cette commande ne fonctionne qu'en privé. Elle reste refusée en groupe. |
| `permissions.badge_opens_admin_command` | Opens an admin command | Ouvre une commande d'administration |
| `permissions.badge_extra_on_public` | Already open to everyone | Déjà ouverte à tous |
| `permissions.badge_empty_only` | Empty list | Liste vide |
| `permissions.badge_normal_here` | Exception: normal level here | Exception : niveau normal ici |
| `permissions.badge_normal_here_noop` | No effect | Sans effet |

#### Group tab

| Key | en | fr |
| --- | -- | -- |
| `permissions.group_title` | Permissions of this group | Permissions de ce groupe |
| `permissions.group_intro` | Choose who can use a command here. The owner always has access, a switched-off command stays off for everybody, and member roles (VIP, muted, banned) do not change. | Choisissez qui peut utiliser une commande ici. Le propriétaire a toujours accès, une commande désactivée le reste pour tout le monde, et les rôles des membres (VIP, sourdine, banni) ne changent pas. |
| `permissions.new_command_label` | Command | Commande |
| `permissions.new_command_placeholder` | Choose a command… | Choisir une commande… |
| `permissions.new_create` | Create the rule | Créer la règle |
| `permissions.optgroup_delegable` | Commands you can delegate | Commandes délégables |
| `permissions.optgroup_locked` | Never delegable | Jamais délégables |
| `permissions.rules_title` | Rules of this group | Règles de ce groupe |
| `permissions.rules_empty` | No rule in this group. | Aucune règle dans ce groupe. |
| `permissions.rules_empty_hint` | Every command keeps its normal level. | Chaque commande garde son niveau normal. |
| `permissions.members_title` | Group members | Membres du groupe |
| `permissions.members_unavailable` | The bot cannot read the member list right now (it is offline, or it left the group). You can remove people but not add any. | Le bot ne peut pas lire la liste des membres pour le moment (il est hors ligne ou il a quitté le groupe). Vous pouvez retirer des personnes, pas en ajouter. |
| `permissions.col_pick` | Allow | Autoriser |
| `permissions.pick_person` | Allow {person} | Autoriser {person} |
| `permissions.everywhere_title` | Allowed everywhere | Autorisées partout |
| `permissions.everywhere_intro` | These people can use the command in every group and in private chats, including this group. Edit them on the Commands page. | Ces personnes peuvent utiliser la commande dans tous les groupes et en privé, y compris dans ce groupe. Modifiez-les dans la page Commandes. |
| `permissions.everywhere_empty` | Nobody is allowed everywhere. | Personne n'est autorisé partout. |
| `permissions.everywhere_edit` | Edit {name} on the Commands page | Modifier {name} dans la page Commandes |
| `permissions.mode_here` | Mode here: {mode} | Mode ici : {mode} |
| `permissions.mode_here_group` | Mode here: {mode} (rule of this group) | Mode ici : {mode} (règle de ce groupe) |
| `permissions.orphans_title` | Rules without a usable command | Règles sans commande utilisable |
| `permissions.orphans_hint` | These rules target a command that is no longer loaded, or that can no longer be delegated. They have no effect: you can delete them. | Ces règles visent une commande qui n'est plus chargée, ou qui ne peut plus être déléguée. Elles n'ont aucun effet : vous pouvez les supprimer. |
| `permissions.orphan_unknown_command` | Command no longer loaded | Commande qui n'est plus chargée |
| `permissions.orphan_not_delegable` | Command that can no longer be delegated | Commande qui ne peut plus être déléguée |
| `permissions.orphan_remove` | Delete the rule for {command} ({scope}) | Supprimer la règle de {command} ({scope}) |
| `permissions.orphan_removed` | Rule for {command} deleted. | Règle de {command} supprimée. |
| `permissions.forget_done` | Settings deleted ({filters} filters, {roles} roles, {warnings} warnings, {commandStates} disabled commands, {permissionRules} permission rules). | Réglages supprimés ({filters} filtres, {roles} rôles, {warnings} avertissements, {commandStates} commandes désactivées, {permissionRules} règles de permission). |
| `permissions.forget_hint` | The bot has left this group. You can delete the settings kept for it: messages, filters, roles, warnings, disabled commands and permission rules. Balances, ideas, quotes, tasks and statistics are kept. | Le bot a quitté ce groupe. Vous pouvez supprimer les réglages conservés : messages, filtres, rôles, avertissements, commandes désactivées et règles de permission. Les soldes, idées, citations, tâches et statistiques sont conservés. |

#### Commands page and pickers

| Key | en | fr |
| --- | -- | -- |
| `permissions.cell_everywhere` | Everywhere: {mode} ({people}) | Partout : {mode} ({people}) |
| `permissions.cell_none` | No rule everywhere | Aucune règle partout |
| `permissions.cell_groups` | {count} groups with a rule | {count} groupes avec une règle |
| `permissions.cell_groups_one` | {count} group with a rule | {count} groupe avec une règle |
| `permissions.cell_unavailable` | Not available | Indisponible |
| `permissions.load_failed` | The permission rules could not be loaded ({reason}). The rest of this page still works. | Les règles de permission n'ont pas pu être chargées ({reason}). Le reste de cette page fonctionne toujours. |
| `permissions.cmd_intro` | The "everywhere" rule applies in every group and in private chats. A group's own rule can add to it or replace it for that group. | La règle « partout » s'applique dans tous les groupes et en privé. La règle propre à un groupe peut la compléter ou la remplacer pour ce groupe. |
| `permissions.cmd_groups_title` | Groups with their own rule ({count}) | Groupes avec une règle propre ({count}) |
| `permissions.cmd_groups_empty` | No group has its own rule for this command. | Aucun groupe n'a de règle propre pour cette commande. |
| `permissions.cmd_group_open` | Open the permissions of {group} | Ouvrir les permissions de {group} |
| `permissions.picker_hint` | Pick from contacts who already wrote to the bot privately. Check the number: a display name can be misleading. | Choisissez parmi les contacts qui ont déjà écrit au bot en privé. Vérifiez le numéro : un nom affiché peut être trompeur. |
| `permissions.picker_search` | Search a contact | Rechercher un contact |
| `permissions.picker_empty` | No known contact. | Aucun contact connu. |
| `permissions.col_name` | Name | Nom |
| `permissions.col_number` | Number | Numéro |
| `permissions.number_label` | Or type a number | Ou saisir un numéro |
| `permissions.number_hint` | Digits with the country code (8 to 15 digits). Spaces, + and dashes are ignored. | Chiffres avec l'indicatif du pays (8 à 15 chiffres). Les espaces, le signe + et les tirets sont ignorés. |
| `permissions.number_add` | Add this number | Ajouter ce numéro |

Dropped from stream C's list: `audit.prefix_permission` (X6: no new prefix), `permissions.badge_admin` (the existing `groups.admin_*` is reused), `permissions.pick_member` (merged into `pick_person`), `permissions.cmd_title` / `cmd_everywhere_title` (the editor heading covers them), `permissions.mode_here` variants beyond the two above, `permissions.group_only`/`info_group_only` (renamed `info_context_only_*`), and the `{reason}` placeholder of `members_unavailable` (the picker no longer has an error text when `members.available` is false). Renamed to X5: stream C's client warning ids `admin_non_admin`, `admin_everywhere`, `extra_on_public`, `only_empty` became the server codes of X5, and its keys `warn_admin_non_admin` -> `warn_opens_admin_command`, `warn_admin_everywhere` -> `warn_opens_admin_command_everywhere`, `warn_extra_public` -> `warn_extra_on_public`, `warn_only_empty` -> `warn_empty_only`, `info_disabled_global`/`_group` -> `info_disabled_here_global`/`_group`.

## 12. Points settled while writing this contract

1. **Language of the files.** 002's contracts and quickstart are in English, so this folder follows them: both new files are English (the spec stays French).
2. **`warnings` shape and rules.** The API contract (1.5) settles three differences between the stream files: warnings are objects `{ code, tone, params }` (stream B listed bare codes, stream C its own ids); `opens_admin_command` counts every person who is not a known admin, so unknown, former and offline people count (B8's conservative rule, not C6's "present only"), with `everywhere: true` and `count = people.length` for scope `*`; `extra_on_public` needs a non-empty list, so an empty group `extra` rule gives `normal_here` alone. `computeWarnings` returns the same objects as the server for the four server codes, and rows render the server's own warnings through `normalizeWarnings`.
3. **The group tab needs more than PERM-5.** PERM-5 has no `access`, `desc`, `delegable` or `lockReason`, so the tab also calls CMD-1 and PERM-1 and merges by `name` (X3 applied to the group page too). No API change is needed.
4. **No override of existing texts.** U4 means GRP-6 now also deletes the rules and its answer carries `permissionRules`; the owner should see that in the hint and the toast. Editing `groups.delete_done` / `groups.delete_hint` is not possible without breaking `test/admin-i18n.test.js` (the 002 fragment `panel-groups.json` pins their text and the test requires fragment and catalog to be equal), so the fragment adds `permissions.forget_done` / `forget_hint` and `AdvancedTab` switches to them. The two old keys stay in the catalogs, unused. (Alternative: change them in both the catalogs and the 002 fragment.) The action the spec calls "Oublier ce groupe" is the panel's "Delete the settings" button of the Advanced tab, which is shown for a group the bot has **left** only; a group the bot is still in cannot be forgotten from the panel.
5. **Empty `extra` rule.** X4/U3 allow it for a group scope only; `canSave` and the editor follow, and the stream B text that still says `extra` + `[]` is refused (B6) is read as superseded for group scopes. A brand-new group rule left at its defaults (`extra`, no person) can be saved on purpose and then shows the `normal_here` banner ("no effect" when no "everywhere" `only` rule exists).
6. **Number guard.** `parseNumber` also refuses a first digit `0` (a national number such as `0690000001` would be stored as a wrong identity). This goes slightly beyond U5; the server remains the authority and only needs the 8-15 digit rule. Drop it if the owner prefers the literal U5.
7. **`present`/`admin` freshness.** They come from PERM-5 at load time; the editor never refreshes them while open. Reloading the tab does.
8. **Hook-only commands.** A rule on `afk`, `addfilter`, `notify` or `trackmessages` does not stop their hooks (research.md section 3). The editor shows no extra warning for it.
9. **`PermissionsTab` name.** Stream C called it `GroupPermissionsTab`; the other tabs are `MessagesTab`, `FiltersTab`, `MembersTab`, `CommandsTab`, so this contract uses `PermissionsTab`.

## 13. Tests

### `test/admin-view-permissions.test.js` (pure logic, same style as `admin-view-commands.test.js`)

- `parseNumber`: `+237 690-000-001`, `00237690000001`, `(237) 690.000.001` give the same JID; 7 digits and 16 digits -> `invalid_phone`; letters -> `invalid_phone`; empty and blanks -> `required`; a first digit `0` -> `invalid_phone`; the JID ends with `@s.whatsapp.net`.
- `personKey`: device suffix, case, `@c.us`, non-string input; `personLabel` with and without a name.
- `addPerson` / `togglePerson`: duplicate (PN typed vs chip, with a device suffix), cap at `max` (`too_many_items` with `params.max`), insertion order by key, same object when refused.
- `diffPeople` / `isDirty` / `pendingCount`: set-based, add then remove is clean, a mode change alone is dirty, `saved === null` untouched is clean.
- `canSave`: `extra` + empty is refused for `*` (`people_required`) and allowed for a group; `only` + empty is allowed; unchanged saved rule gives `unchanged`.
- `ruleBody`: stable, de-duplicated, only `mode` and `jid` strings.
- `computeWarnings`, the table of section 10 row by row, each result checked as a whole `{ code, tone, params }`: `opens_admin_command` counts every person whose `admin` is not `admin`/`superadmin` (unknown, `present: null`, `present: false` included), `{ count, everywhere: false }` for a group and `{ count: people.length, everywhere: true }` for `*`, none when everyone is a known admin or the list is empty; `extra_on_public` only with a non-empty list on a command that is neither owner nor admin, so an empty group `extra` rule on a public command gives `normal_here` alone; `empty_only`; `normal_here` with tone `info` or `warn` by `hasEverywhereOnly`; `disabled_here` global and group; `context_only` for `pm`, and for `group` only at scope `*`; order warn before info. A shared fixture list compares the four server codes with the examples of the API contract (same tone, same params).
- `normalizeWarnings` (objects, unknown code dropped, missing `tone` or `params` defaulted), `warningTextKey` (every code, both `opens_admin_command` variants, both `normal_here` tones, `disabled_here`/`context_only` variants) and `warningBadges` (`normal_here` tone variants, information-only codes give no badge); every key either function returns exists in en and fr.
- `personBadges`: `former`, `admin`, `not_admin` (only for an admin command and `present === true`), nothing for `present: null`.
- `effectiveMode`: truth table of FR-006 step 4 (group rule wins even when empty, else everywhere, else normal; `source` values).
- `lockReasonKey` (each of the five, unknown, null, missing), `isLocked` / `isDelegable` with `perm: null`, `mergePermissions` (missing item, no mutation), `splitCommands` (rule names excluded, locked listed, sorted), `commandCell` (the four kinds), `everywhereRows` (locked and unknown commands skipped, `effective` per row), `groupOrphanRules`, `peopleSummary`, `normalLevel`, `isPublic`.
- `chatQuery` (`kind=private`, no `selectable`, `page` only above 1, `q` trimmed and cut), `selectionFromQuery` (alias resolved, unknown/locked/other panel -> `null`), `groupTabTarget`, `commandPanelTarget` with `buildHash` giving the two literal hashes of section 10.
- Audit logic is tested in `admin-view-logs-stats.test.js` (see the table below).
- The view modules import in plain Node and export what this contract lists (`RuleEditor`, `GroupMemberPicker`, `PersonPicker`, `PermissionsTab`, `CommandPermissions`, `PermissionOrphans`).

### `test/admin-view-permissions-{group,commands}.test.js` (fake DOM; pattern of `admin-view-data.test.js`)

`createDom`, a scripted `fetch` that throws on an unexpected request, catalogs set from the real files overlaid with the 003 fragment (so the file also runs before the merge), `ui.confirmStore` / `resolveConfirm`.

Group tab:

1. Lists the rules with their badges ("No longer in the group" for a `present: false` person, "Not an admin" for a non-admin on an admin command, "Exception: normal level here" for an empty `extra` rule); shows the "allowed everywhere" card with the mode that applies here and a link to `#/commands?command=<name>&panel=permissions`.
2. Create flow: `dom.choose` on the command select, "Create the rule", tick two members with `dom.check`, the admin-command warning is visible **before** Save, Save sends exactly `PUT /admin/api/groups/<jid>/permissions/kick` with `{ mode: "extra", people: [two jids] }`, then PERM-5 is read again and the parent `reload` is called.
3. Locked commands appear as `disabled` options in the "Never delegable" optgroup with their reason text; an unknown `lockReason` shows the fallback reason.
4. Delete asks first: refusing sends nothing; accepting sends `DELETE` and reloads.
5. `members.available: false`: the notice is shown, no GRP-11 request is made, the picker is hidden, removing a person and Save still work, and no "former" badge appears. GRP-11 answering 409 gives the same result.
6. An `extra` rule with no person: Save is enabled in a group; the empty `only` rule shows the "Empty list" banner; an edit that changes nothing leaves Save disabled.
7. An orphan row deletes with `DELETE` and no dialog; the tab badge value and the `TabPanel` wiring through `GroupPage` with `tab=permissions`.

Commands page:

8. The new column and its summaries (rule, none, groups count plural, unavailable); a locked row (muted name, neutral badge, reason text in the cell, disabled Permissions button); a PERM-1 failure leaves the page working and shows `load_failed`.
9. Open the card, add a contact from `GET /admin/api/chats?kind=private&pageSize=50` (the request carries no `selectable`), add a typed number (`237690000003@s.whatsapp.net` becomes a chip), an invalid or too short number shows `fields.invalid_phone` and adds nothing, a duplicate shows `fields.duplicate`; Save sends `PUT /admin/api/commands/<name>/permissions/everywhere`; Delete asks, then `DELETE .../everywhere`; PERM-1 is read again.
10. The groups list is read-only and links to `#/groups/<jid>?tab=permissions`.
11. `?command=vv&panel=permissions` opens the card; an unknown or locked command does not; the Scopes editor and the Permissions card are never open together.
12. Permission orphans: a scope `*` row calls PERM-4, a group row calls PERM-7, no dialog.

### Edits to existing tests

| File | Change |
| ---- | ------ |
| `test/admin-view-groups.test.js` | `TABS` equals `["messages", "protection", "filters", "members", "commands", "permissions", "advanced"]`; `tabOf("permissions")`. |
| `test/admin-view-logs-stats.test.js` | `summarizeDetail` rule branch (valid shape, a list replaced by `removedCount` / `addedCount`, extra key falls back to text, non-string ids fall back, caps, the server's `{ truncated, length, keys }` stays generic text) and `ruleIdLabel`. The "action prefixes cover the vocabulary" test needs no edit (`command.permission.*` starts with `command.`). |
| `test/admin-view-backup.test.js` | Expectations for 26 models and `PermissionRule` in the `config` group (stream B lists the same edit). |
| `test/admin-i18n.test.js` | [Section 11](#test-change-testadmin-i18ntestjs). |

### Must stay green, no edit expected

`test/admin-frontend.test.js`: static scans of every new module (no `innerHTML`/`eval`/inline style/external URL, imports resolve, modules import without a DOM), the css guard for `class="..."` words, contract test 11 (needs PERM-1..7 and GRP-3 registered), and the confirmation guard for DELETE (no `?confirm=true` needed, [section 2](#2-api-calls-per-view)). `test/admin-i18n.test.js`: literal and dynamic `t()` keys, the "panel d'administration" rule, catalog shape and order. `test/admin-view-commands.test.js`: the CMD-1/CMD-2 logic is untouched.
