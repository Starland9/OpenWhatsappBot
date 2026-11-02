# Stream C — Admin panel frontend (SPA views) and panel i18n

Phase 0 research for feature 003. Read-only study of `lib/admin/public/**`, `tools/merge-panel-i18n.js` and the panel tests. Paths are relative to the repo root; `views/` means `lib/admin/public/js/views/`. API names below are what the views need; streams A (HTTP) and B (engine) may rename them, the shapes matter.

## C1. Where the UI lives: no new area, a tab and a column

**Decision.** No new panel area, route, nav entry or `AREAS` change. (a) a 7th group tab `permissions` (after `commands`, before `advanced`); (b) a "Permissions" column and button on the Commands page that open an editor card for the "partout" rule; (c) one shared rule editor used by both. The group page deep-links to the Commands page with `#/commands?command=<name>`, the Commands page links to `#/groups/<jid>?tab=permissions`.

**Rationale.** FR-020/FR-021 name exactly these two pages. A new area would add a `meta`/router/nav/icon/`<area>.title` obligation pinned by tests (`test/admin-frontend.test.js:258`, `test/admin-i18n.test.js:161`) for no gain. SC-006 ("qui peut quoi dans tel groupe" from one page) is the group tab.

**Alternatives.** A standalone "Permissions" area (global matrix command x scope): more code, duplicates both pages, rejected. Putting everything on the Commands page: the group question (SC-006) would need a group filter there, rejected.

**Evidence.** Tabs are `TABS` (`views/groups-logic.mjs:7`), labelled `groups.tab_<id>` and badged in `views/groups-page.mjs:134-137`, one `TabPanel` each (`:147-152`); `tabOf` falls back to the first tab (`groups-logic.mjs:230`). Commands page: `views/commands.mjs:48` (`CommandsView`, takes no `route` prop today), columns `:97`, `ScopeEditor` `:156`, `OrphanRows` `:173`. `buildHash(name, rest, query)` is `js/router.mjs:76`.

**Files impacted.** `views/groups-logic.mjs`, `views/groups-page.mjs`, `views/commands.mjs` (all edited, small).

## C2. What the views need from the API (for streams A and B to confirm)

**Decision.** REST under the existing areas, errors as codes, no prose. Full-replace `PUT` for a rule (the spec's "dernier enregistrement gagne" edge case), `DELETE` to remove one. Person ids are JIDs exactly as the pickers give them (the server normalizes PN/LID).

| Need | Route (assumed) | Shape |
| --- | --- | --- |
| Group rules | `GET /admin/api/groups/:jid/permissions` | `{ rules: [{ command, mode: "extra"\|"only", people: [{ jid, name\|null, present: true\|false\|null, admin: "admin"\|"superadmin"\|null }], updatedAt }], everywhere: [{ command, mode, people: [{ jid, name }] }], orphans: [command], limits: { peopleMax } }` |
| Save / delete a group rule | `PUT` / `DELETE /admin/api/groups/:jid/permissions/:command` | PUT body `{ mode, people: [jid] }` -> `{ rule }`; DELETE -> `{ deleted: true }`; both accept an orphan command name for DELETE (CMD-2 precedent) |
| Commands list | `GET /admin/api/commands` (CMD-1, extended) | per command `delegable: bool`, `lockReason: code\|null`, `permissions: { everywhere: { mode, count }\|null, groups: n }`; top level `permissionOrphans: [{ command, scope: "*"\|jid }]` |
| One command's rules | `GET /admin/api/commands/:name/permissions` | `{ everywhere: { mode, people:[{jid,name}] }\|null, groups: [{ jid, name, mode, count }] }` |
| Save / delete "partout" | `PUT` / `DELETE /admin/api/commands/:name/permissions/everywhere` | same bodies as above |
| Group header badge | GRP-3 | `counts.permissions` (number) |
| Members, chat picker | GRP-11 and CHAT-1 | unchanged (`kind=private`, no `selectable`) |

Notes for A/B: (1) `present`/`admin` per saved person must be computed server-side with the group service's PN/LID resolution (`formsFor`), not by the browser comparing JIDs, or a LID-stored person shows a false "ne fait plus partie du groupe". (2) A refused delegation (crafted request) should be `422 validation_failed` with `fields.command = { code: "not_allowed" }` (both already exist), not a new envelope code: a new code means editing `STATUS_BY_CODE`, contract 1.9 and `ENVELOPE_CODES` (asserted at 49) in `test/admin-i18n.test.js`. The UI never triggers it. (3) `extra` + empty list should be rejected or treated as delete; the UI never sends it (C5). (4) Audit action codes: see C10.

**Rationale.** Mirrors `GRP-8..10`/`CMD-2` shapes the SPA already consumes; keeps pure logic testable.

**Alternatives.** Set-based `PATCH {add, remove}` like CMD-2: protects against two tabs clobbering, but the spec chose last-write-wins and the server would need a delete-when-empty rule; rejected.

**Evidence.** `views/commands.mjs:80` (PATCH of CMD-2), `lib/admin/routes/groups.js:168-218` (audit per write), `lib/admin/services/groups.js:638-657` (GRP-11 items `{jid, admin, role}`, 409 `not_connected`/`group_left`), `lib/admin/services/commands.js:26-33` (`access` flags; `admin` implies `group`).

**Files impacted.** None by stream C; this table is its input. Route registration must exist before the views ship because `test/admin-frontend.test.js:1102` (contract test 11) fails on any `/admin/api/...` literal without a registered route. Keep each path in a `const base = ...` at the top of the file (the scan resolves `${base}` aliases, `:1050-1062`).

## C3. Group page "Permissions" tab (FR-020, FR-023, FR-024, US1, US2, US4)

**Decision.** `GroupPermissionsTab` = four cards, all data from one `GET .../permissions` plus lazy `GET .../members` and `GET /admin/api/commands`.

```
 [Messages][Protection][Filtres][Membres][Commandes][Permissions 3][Avancé]
 ┌ Permissions de ce groupe ──────────────────────────────────────────────┐
 │ Choisissez qui peut utiliser une commande ici. Le propriétaire a       │
 │ toujours accès ; une commande désactivée le reste pour tous.           │
 │ Nouvelle règle  [ Choisir une commande…      v]  [Créer la règle]      │
 │    (liste: "Commandes délégables" / "Jamais délégables" grisées+raison) │
 ├ Règles de ce groupe ───────────────────────────────────────────────────┤
 │ .vv     Normal + ces personnes   2 personnes            [Modifier]     │
 │    +237690000001 [Admin]   +237690000002 [Non admin]  (.vv: pas d'alerte)│
 │ .kick   Normal + ces personnes   2 personnes  ⚠ 1 non admin [Modifier] │
 │ .imagen Ces personnes seulement  0 personne   ⚠ liste vide  [Modifier] │
 │ ┌ Règle pour .kick · Niveau normal : admins du groupe ───────────────┐ │
 │ │ Mode (•) Normal + ces personnes ( ) Ces personnes seulement        │ │
 │ │ Personnes [+23769…001 Admin ×] [+23769…002 Non admin ×]            │ │
 │ │            [+23769…009 Ne fait plus partie du groupe ×]            │ │
 │ │ ⚠ 1 personne n'est pas admin du groupe : elle pourra retirer des   │ │
 │ │   membres par l'intermédiaire du bot.                              │ │
 │ │ Membres du groupe [Rechercher…]                                    │ │
 │ │  [x] +23769…001 Admin | [x] +23769…002 | [ ] +23769…003   < 1/4 >  │ │
 │ │ [Enregistrer] [Annuler] 2 modifications     [Supprimer la règle]   │ │
 │ └────────────────────────────────────────────────────────────────────┘ │
 ├ Autorisées partout (ont aussi accès ici) ──────────────────────────────┤
 │ .vv  Mode ici : Normal + ces personnes  +23769…004, +23769…005         │
 │ .dice Mode ici : règle du groupe  +23769…004          → page Commandes │
 ├ Règles sans commande ──────────────────────────────────────────────────┤
 │ .oldcmd  [corbeille]    (aucun effet ; supprimable)                    │
 └────────────────────────────────────────────────────────────────────────┘
```

Behaviour: a rule row's "Modifier" opens the shared `RuleEditor` inline (one editor at a time, keyed by command, focus on its heading like `ScopeEditor`). "Créer la règle" opens the same editor with `saved = null`, mode `extra`, empty list. Draft + explicit Save per rule (one audit entry per save; warnings visible before saving, which also satisfies US1 scenario 5). Delete a rule: `confirm({ title, message, confirmLabel })` then `DELETE` and `reloadGroup()` for the tab badge. Orphan rules: delete icon, no dialog (same as command-state orphans). The "partout" card is read-only; each line says which mode applies here (`effectiveMode`, C5) and links to the Commands page. The "partout" card carries no member badges: those people have access wherever they are, so "ne fait plus partie du groupe" is only meaningful for the group's own rules.
Degraded cases: bot disconnected or group left -> `GET members` fails with 409: the tab shows `permissions.members_unavailable`, hides the picker, keeps Remove and Delete working, and skips the "ne fait plus partie" flags (server returns `present: null`). A group the bot left keeps its rules (spec edge case), so the tab stays usable read-mostly.
Tab badge = number of rules (`counts.permissions`), refreshed through `reloadGroup()` after each write; `undefined` (no badge) when the field is absent.

**Rationale.** Same skeleton as `CommandsTab`/`FiltersTab` (load, `useAction`, toast, `confirm`, reload parent), so reviewers and tests recognise the patterns. Draft + Save because opening a command is a security decision (admin commands to non-admins) and warnings must precede the commit.

**Alternatives.** Instant save on every checkbox (like the role select): one audit row per click, no moment to read the FR-023 warning; rejected. A DataTable of all ~80 commands with per-row editors: very long page and the greyed non-delegable rows would be noise; rejected in favour of a native `<select>` with two `<optgroup>`s (disabled options render greyed natively, accessible, trivially testable with `dom.choose`).

**Evidence.** `views/groups-page.mjs:139-152` (tab wiring, `common = { group, onGroup, reload }`), `views/groups-commands.mjs:12-36` (commands load + toggle pattern), `views/groups-members.mjs:19-28,69` (members fetch with graceful `membersError`, `groups.members_unavailable`), `views/groups-filters.mjs:60` (delete confirm), `views/commands-editor.mjs:13-22` (editor focus + `useUnsavedGuard`), `views/broadcasts-form.mjs:346-350` (`fieldset.choice-group` radios).

**Files impacted.** New `views/groups-permissions.mjs` (tab, rule list, new-rule select, "partout" and orphan cards, about 150 lines), `views/permissions-members.mjs` (member picker); edits to `groups-page.mjs`, `groups-logic.mjs` (`TABS`).

## C4. Commands page (FR-021, FR-022, US3, US4)

**Decision.** Add a "Permissions" column to the table and a second row button; the button opens `CommandPermissions` (a card above the table, same slot as `ScopeEditor`; only one of the two editors is open at a time via `selected = { name, panel: "scopes"|"permissions" }`). `CommandsView` starts reading `route.query` (`command`, `panel`) to open the card from the group tab's link.

```
 Commande | Catégorie | Description | Accès   | État | Permissions                       | Actions
 .vv      | owner     | Révéler…    | Propr.  | On   | Partout : seulement 2 · 1 groupe  | [on][Portées][Permissions]
 .eval    | owner     | Évaluer…    | Propr.  | On   | Non délégable : exécute du code…  | [on][Portées][Permissions✗]
 ┌ Permissions de .vv ─────────────────────────────────────────────────────┐
 │ Niveau normal : propriétaire · portée « partout » = tous les groupes et │
 │ le privé. Une règle de groupe peut la compléter ou la remplacer.        │
 │ Règle « partout »   Mode (•) Normal + ces personnes ( ) Seulement       │
 │ Personnes [+237690000001 ×] [+237690000002 ×]                           │
 │ Ajouter   [Rechercher un contact…] [x]Marie +237690000003 …  < 1/2 >    │
 │           ou saisir un numéro [ +237 6 90 00 00 04 ] [Ajouter]          │
 │           (chiffres avec l'indicatif du pays)                           │
 │ ⚠ avertissements (C6)                                                   │
 │ [Enregistrer] [Fermer]                  [Supprimer la règle « partout »]│
 ├ Groupes avec une règle propre (1) ──────────────────────────────────────┤
 │ Chess club · Ces personnes seulement · 3 personnes      [Ouvrir]        │
 └─────────────────────────────────────────────────────────────────────────┘
 Règles sans commande : .oldcmd · Partout [x] · Chess club [x]
```

Non-delegable rows: name in `muted`, a neutral badge "Non délégable", the reason as text in the Permissions cell (never tooltip-only: touch screens), the Permissions button `disabled`. The "Groupes avec une règle propre" list is read-only (links to `#/groups/<jid>?tab=permissions`); rules are created per group only from the group tab (FR-021 asks for "partout" here). Orphans reuse `groupOrphans` (`commands-logic.mjs:166`) in a second card; removal calls the same `DELETE` routes.

**Rationale.** Keeps the page's mental model (one table, one editor card) and adds no page. The column answers FR-021 at a glance without opening anything (`permissions` summary comes with CMD-1, no N+1).

**Alternatives.** Merge scopes and permissions into one editor with sub-tabs: bigger rewrite of a tested component (`ScopeEditor`), rejected. Greying rows with a new CSS class: the css guard (`test/admin-frontend.test.js:1334`) demands a rule per class; `muted` + disabled button needs no CSS.

**Evidence.** `views/commands.mjs:54,97-121,155-173`; `views/commands-orphans.mjs:12`; `views/commands-logic.mjs:54` (`accessLevels`); `lib/admin/public/css/app.css:103,577` (`.muted`, disabled button).

**Files impacted.** New `views/commands-permissions.mjs` (card + groups list + orphans, about 140 lines). Edits: `views/commands.mjs`.

## C5. Shared editor, pickers and pure logic

**Decision.** One shared presentational component plus two pickers, all state in a draft owned by `RuleEditor`.

- `views/permissions-editor.mjs` exports `RuleEditor({ command, saved, scope, busy, limits, extra, Picker, pickerProps, onSave, onDelete, onClose })`: mode radios (`fieldset.choice-group`), chips for the draft people with badges and a remove button, the `Picker` slot, the warning banners, Save/Cancel/Delete, "N modifications non enregistrées", `useUnsavedGuard("permissions-<scope>-<command>")`. It knows nothing about routes; the parent does the `api()` call (so `contract test 11` sees real literals in the parent files).
- `views/permissions-members.mjs`: `GroupMemberPicker` (search + 25 per page + checkboxes over the GRP-11 list, reusing `filterMembers`, `sortMembers`, `paginate`, `shortJid` from `groups-logic.mjs`).
- `views/permissions-picker.mjs`: `PersonPicker` for "partout" (C8).
- `views/permissions-logic.mjs` (pure, no imports except optionally `groups-logic.mjs`; imported by `node:test`):
  `MODES`, `modeKey(mode)`, `isDelegable(command)`, `lockReasonKey(command)`, `isPublic(command)` (`!access.owner && !access.admin`), `normalLevel(command)`, `personKey(jid)` (strip device suffix, lower-case), `parseNumber(input)` (C8), `draftOf(rule)`, `setMode`, `addPerson(draft, person, { max })` -> `{ draft, error }` (`duplicate`, `too_many_items`), `removePerson`, `diffPeople(saved, draft)` -> `{ added, removed }`, `isDirty`, `canSave(draft, saved)` (false for `extra` + empty), `ruleBody(draft)` -> `{ mode, people }` (de-duplicated, stable order), `computeWarnings` (C6), `personBadges(person)` -> `[{ id: "former"|"not_admin"|"admin", tone }]`, `effectiveMode(groupRule, everywhereRule)` (FR-006 step 4, display only), `commandSummary(command)` for the table cell, `splitCommands(commands, rules)` for the new-rule select (delegable without a rule / locked with reason).

**Rationale.** The only differences between the two pages are the picker and the scope label, so a slot is enough. Pure logic carries every rule the tests care about (warnings, diff, validation) without a DOM, as `groups-logic.mjs` and `commands-logic.mjs` do.

**Alternatives.** Two independent editors: duplicated warnings/diff code and two places to fix. Extending `ScopeEditor`: different draft shape (scopes vs people), rejected.

**Evidence.** `views/commands-editor.mjs:13-60` (draft + diff + Save pattern), `views/commands-logic.mjs:96-136` (`draftOf`/`diffScopes`/`isDirty`), `views/groups-logic.mjs:146-175`, `test/admin-view-commands.test.js:104-155` (how such logic is tested).

**Files impacted.** New: `permissions-logic.mjs`, `permissions-editor.mjs`, `permissions-members.mjs`, `permissions-picker.mjs`. Ownership: one agent owns the four shared files (they unblock both pages); the page agents only consume them.

## C6. Warnings and badges (FR-023, FR-024)

**Decision.** `computeWarnings({ command, draft, scope, disabled })` returns ordered `{ id, tone, params }`; rendered as `banner banner-warn` / `banner-info` inside the editor, live as the draft changes and again after save (computed from state, not from the save answer). Never blocking (US1 scenario 5: save, then warn).

| id | tone | condition | params |
| --- | --- | --- | --- |
| `admin_non_admin` | warn | scope group, `access.admin`, at least one person with `present: true` and `admin: null` | `count` |
| `admin_everywhere` | warn | scope everywhere, `access.admin`, at least one person (admin status depends on the group) | none |
| `extra_on_public` | warn | mode `extra`, `isPublic(command)` | none |
| `only_empty` | warn | mode `only`, no person | none |
| `disabled_here` | info | `disabledGlobal`, or the group in `disabledGroups` (`disabledCommands` of GRP-3) | `where` |
| `context_only` | info | scope everywhere and `access.group` / `access.pm` (spec edge case: stays refused in the other context) | `ctx` |

Badges on a person chip: `Admin` (info), `Non admin` (warn, only when the command is an admin command), `Ne fait plus partie du groupe` (neutral, `present === false`, the chip's remove button gets focus styling via the existing `icon-btn`). `present: null` shows nothing (we do not know). Roles `muted`/`banned` are not special-cased (Assumptions: `.role` still applies); optional later: show the role badge from GRP-11 in the picker only.

**Rationale.** All three FR-023 warnings plus the two cheap, spec-backed informational ones (US2 scenario 6 and the `onlyGroup`/`onlyPm` edge case) from data the views already have (CMD-1 `access`, `disabledGlobal`, `disabledGroups`).

**Alternatives.** A confirm dialog before saving an admin command to a non-admin: stronger, but contradicts the "enregistre puis affiche" wording and adds a dialog per save; rejected. Owner-level commands (`.vv`) get no warning: delegating them is the point of the feature.

**Evidence.** `lib/admin/services/commands.js:26-33`, `views/commands-logic.mjs:54` (`accessLevels`), `commandState` (`views/groups-logic.mjs:195`, disabled globally or in the group), `views/groups-page.mjs:143-145` (banner markup `banner banner-warn` with `Icon name="warning"`).

**Files impacted.** `permissions-logic.mjs`, `permissions-editor.mjs`.

## C7. Non-delegable commands: greyed with the reason (FR-022)

**Decision.** The server sends `delegable: false` and `lockReason` (a code). Five reason codes cover the fixed list, plus a fallback: `code` (eval, exec), `update` (update), `data` (exportcontacts), `lockout` (ban, unban), `config` (setvv, getvv, antidel, getantidel, autorespond, statussave, setcmd, delcmd, getcmd). Texts `permissions.reason_<code>`, `permissions.reason_unknown` when the code is missing or unknown. Stream B declares it as `neverDelegable: true | "<code>"` on the command (a string is truthy, so a plain `true` still works).

**Rationale.** FR-022 asks for "la raison"; one generic sentence would be accurate but useless for `.eval` vs `.statussave`. Five short strings per language cost little. The fallback keeps the UI correct if a plugin only says `true`.

**Alternatives.** A single generic reason (simplest, acceptable if the owner prefers; the UI code is identical, only the fragment shrinks). A reason map hard-coded in the browser: would drift from the code-side list that FR-012 says is the source of truth; rejected.

**Evidence.** Spec FR-012/FR-013; `views/commands-logic.mjs:14` (access labels as a closed list translated by key), `test/admin-i18n.test.js:384` (dynamic `t(\`prefix${...}\`)` families are checked, so `permissions.reason_*` must be complete in both catalogs).

**Files impacted.** `permissions-logic.mjs` (`lockReasonKey`), fragment (C9), stream B/A for the declaration and the CMD-1 field.

## C8. Person picker and typed numbers (FR-021, US3 scenario 5)

**Decision.** `PersonPicker` is new, not `DestinationPicker`. It lists known private chats from CHAT-1 (`kind=private`, search, 50 per page, checkboxes) and has a "saisir un numéro" form. Each row shows the push name AND the number (`shortJid`), because push names are user-chosen and spoofable. `parseNumber(input)` strips spaces, `+`, `-`, `.`, parentheses and a leading `00`, requires 8 to 15 digits, and returns `{ ok, jid: "<digits>@s.whatsapp.net" }` or `{ ok:false, error:{ code: "required"\|"invalid_phone" } }` (existing field codes: `fields.invalid_phone` already says "chiffres avec l'indicatif du pays, de 8 à 15 chiffres"). The server resolves PN/LID.

**Rationale.** `DestinationPicker` is bound to broadcasts: `broadcasts.*` labels, a 200-destination cap, group kind filter, `selectable=1` (which hides people whose chat is disabled) and "no field to type a number" (FR-046). Reusing it would need flags in four places of a tested component; a 100-line sibling is cheaper and leaves broadcasts untouched. The pagination/search/useAsync idiom is copied.

**Alternatives.** Parametrise `DestinationPicker` (`labels`, `kinds`, `allowTyped`): touches `broadcasts-form.mjs` and its tests for no user value. Typed number only (no list): fails FR-021 "contacts connus".

**Evidence.** `views/broadcasts-picker.mjs:29-35,52-60,205-279`; `lib/admin/routes/chats.js:23-33`; `lib/utils/knownChats.js:294-297` (`selectable`), `:390-401` (items carry no `pnJid`), `:280` (private rows purged by retention), `plugins/knownchats.js` (only people who wrote to the bot in private are recorded); `views/pairing-logic.mjs:25-40` (`sanitizePhone`/`isValidPhone`, same 8-15 rule).

**Files impacted.** `permissions-picker.mjs`, `permissions-logic.mjs`.

## C9. Panel i18n (FR-027)

**Decision.** Write `specs/003-command-permissions/i18n/panel-permissions.json` (`{ "en": {...}, "fr": {...} }`, flat dot keys) and merge with `node tools/merge-panel-i18n.js --frag-dir specs/003-command-permissions/i18n --pattern "panel-*.json"` (dry run first). The fragment also carries the few keys of other namespaces (`groups.tab_permissions`, `commands.col_permissions`, `commands.permissions_button`, `audit.prefix_permission`): the merge tool does not care about the file name. Bot texts go in `bot-permissions.json` merged with `node tools/merge-i18n.js --frag-dir specs/003-command-permissions/i18n --pattern "bot-*.json"` (stream B's). Extend `test/admin-i18n.test.js` so it scans both fragment directories (it only knows `specs/002-admin-panel/i18n`, line 29), otherwise an unmerged 003 fragment would go unnoticed.

**Rationale.** CLAUDE.md allows "edit them directly or add a new fragment". Catalogs are flat and sorted (a test pins both, `admin-i18n.test.js:122`); hand-inserting 60 keys in two big files from parallel agents invites merge conflicts and sort errors, while the tool normalises the order and checks placeholders. Verified: a dry run with a scratch fragment in another directory adds the keys without touching anything (`--frag-dir` is supported, `tools/merge-panel-i18n.js:40-52`).

**Alternatives.** Edit `lib/admin/public/i18n/{en,fr}.json` directly (fine for a one-key fix later, once merged). Reuse the 002 directory: mixes features, rejected.

**Evidence.** `tools/merge-panel-i18n.js:40-52,155-190`; `specs/002-admin-panel/i18n/README.md`; `test/admin-i18n.test.js:283-324,358,384`; plural convention `key` / `key_one` (`lib/admin/public/i18n/fr.json:289`, `i18n.mjs:107`); French rules: vouvoiement, "panel d'administration" never "panneau" (`admin-i18n.test.js:226`).

**Key list** (placeholders identical in both languages; `_one` = singular form):

| key | en | fr |
| --- | --- | --- |
| `groups.tab_permissions` | Permissions | Permissions |
| `commands.col_permissions` | Permissions | Permissions |
| `commands.permissions_button` | Permissions | Permissions |
| `audit.prefix_permission` | Permissions | Permissions |
| `permissions.mode_label` | Mode | Mode |
| `permissions.mode_extra` | Normal + these people | Normal + ces personnes |
| `permissions.mode_extra_hint` | The command keeps its normal level; the people listed can use it as well. | La commande garde son niveau normal ; les personnes listées peuvent aussi l'utiliser. |
| `permissions.mode_only` | These people only | Ces personnes seulement |
| `permissions.mode_only_hint` | Only the people listed and the owner can use it. Everyone else is ignored without any reply. | Seuls les personnes listées et le propriétaire peuvent l'utiliser. Les autres sont ignorés sans réponse. |
| `permissions.mode_normal` | Normal (no rule) | Normal (aucune règle) |
| `permissions.normal_level` | Normal level: {level} | Niveau normal : {level} |
| `permissions.people_title` | People | Personnes |
| `permissions.people_count` / `_one` | {count} people / {count} person | {count} personnes / {count} personne |
| `permissions.people_empty` | Nobody yet. | Personne pour l'instant. |
| `permissions.remove_person` | Remove {person} | Retirer {person} |
| `permissions.badge_admin` / `badge_not_admin` | Admin / Not an admin | Admin / Non admin |
| `permissions.badge_former` | No longer in the group | Ne fait plus partie du groupe |
| `permissions.pending` | Unsaved changes: {count} | Modifications non enregistrées : {count} |
| `permissions.saved` | Rule saved for {name}. | Règle enregistrée pour {name}. |
| `permissions.deleted` | Rule removed for {name}. | Règle supprimée pour {name}. |
| `permissions.delete_rule` | Delete the rule | Supprimer la règle |
| `permissions.delete_title` | Delete the rule for {name}? | Supprimer la règle de {name} ? |
| `permissions.delete_message_group` | The people listed lose this access in this group and the command goes back to its normal level here. | Les personnes listées perdent cet accès dans ce groupe et la commande reprend ici son niveau normal. |
| `permissions.delete_message_everywhere` | The people listed lose this access everywhere, except where a group has its own rule. | Les personnes listées perdent cet accès partout, sauf dans les groupes qui ont leur propre règle. |
| `permissions.save_blocked` | Add a person, or delete the rule. | Ajoutez une personne ou supprimez la règle. |
| `permissions.locked_badge` | Cannot be delegated | Non délégable |
| `permissions.locked_reason` | Cannot be delegated: {reason} | Non délégable : {reason} |
| `permissions.reason_code` | it runs code on the bot's machine. | elle exécute du code sur la machine du bot. |
| `permissions.reason_update` | it updates and restarts the bot. | elle met à jour et redémarre le bot. |
| `permissions.reason_data` | it exports personal data. | elle exporte des données personnelles. |
| `permissions.reason_lockout` | it switches the bot off or on in a chat; misuse can lock you out. | elle désactive ou réactive le bot dans une discussion ; un mauvais usage peut vous en exclure. |
| `permissions.reason_config` | it changes how the bot behaves (privacy, automatic replies, sticker commands). | elle règle le comportement du bot (vie privée, réponses automatiques, stickers-commandes). |
| `permissions.reason_unknown` | it is reserved to the owner by design. | elle est réservée au propriétaire par conception. |
| `permissions.warn_admin_non_admin` / `_one` | {count} people are not admins of this group: they will be able to use this admin command (for example remove members) through the bot, as long as the bot is an admin. / 1 person is not an admin… | {count} personnes ne sont pas administrateurs du groupe : elles pourront utiliser cette commande d'administration (par exemple retirer des membres) par l'intermédiaire du bot, tant que le bot est administrateur. / 1 personne n'est pas administrateur… |
| `permissions.warn_admin_everywhere` | This command is reserved to group admins. The people listed will be able to use it in every group where the bot is an admin, even if they are not admins themselves. | Cette commande est réservée aux administrateurs de groupe. Les personnes listées pourront l'utiliser dans tous les groupes où le bot est administrateur, même sans l'être elles-mêmes. |
| `permissions.warn_extra_public` | This command is already open to everyone: adding people changes nothing. Use "These people only" to restrict it. | Cette commande est déjà ouverte à tout le monde : ajouter des personnes ne change rien. Choisissez « Ces personnes seulement » pour la restreindre. |
| `permissions.warn_only_empty` | The list is empty: only the owner will be able to use this command. | La liste est vide : seul le propriétaire pourra utiliser cette commande. |
| `permissions.info_disabled_global` / `_group` | This command is switched off everywhere / in this group: switching off wins over permissions. | Cette commande est désactivée partout / dans ce groupe : la désactivation l'emporte sur les permissions. |
| `permissions.info_group_only` / `info_pm_only` | This command only works in groups / in private chats; it stays refused elsewhere. | Cette commande ne fonctionne qu'en groupe / en privé ; elle reste refusée ailleurs. |
| `permissions.group_title`, `group_intro` | Permissions of this group / Choose who can use a command here. The owner always has access, a switched-off command stays off for everyone, and member roles (VIP, muted, banned) do not change. | Permissions de ce groupe / Choisissez qui peut utiliser une commande ici. Le propriétaire a toujours accès, une commande désactivée le reste pour tout le monde, et les rôles des membres (VIP, sourdine, banni) ne changent pas. |
| `permissions.new_title`, `new_command_label`, `new_command_placeholder`, `new_create` | New rule / Command / Choose a command… / Create the rule | Nouvelle règle / Commande / Choisir une commande… / Créer la règle |
| `permissions.optgroup_delegable`, `optgroup_locked` | Commands you can delegate / Never delegable | Commandes délégables / Jamais délégables |
| `permissions.rules_title`, `rules_empty`, `rules_empty_hint` | Rules of this group / No rule in this group. / Every command keeps its normal level. | Règles de ce groupe / Aucune règle dans ce groupe. / Chaque commande garde son niveau normal. |
| `permissions.editor_title` | Rule for {name} | Règle pour {name} |
| `permissions.members_title`, `members_unavailable`, `col_pick`, `pick_member` | Group members / The member list is not available ({reason}): you can remove people but not add any. / Allow / Allow {member} | Membres du groupe / La liste des membres n'est pas disponible ({reason}) : vous pouvez retirer des personnes, pas en ajouter. / Autoriser / Autoriser {member} |
| `permissions.everywhere_title`, `everywhere_intro`, `everywhere_empty` | Allowed everywhere / These people can use the command in every group and in private, including this one. Edit them on the Commands page. / Nobody is allowed everywhere. | Autorisées partout / Ces personnes peuvent utiliser la commande dans tous les groupes et en privé, y compris celui-ci. Modifiez-les sur la page Commandes. / Personne n'est autorisé partout. |
| `permissions.mode_here`, `everywhere_edit` | Mode here: {mode} / Edit | Mode ici : {mode} / Modifier |
| `permissions.orphans_title`, `orphans_hint`, `orphan_remove`, `orphan_removed` | Rules without a command / These rules target a command that is no longer loaded. They have no effect: you can delete them. / Delete the rule for {command} / Rule for {command} deleted. | Règles sans commande / Ces règles visent une commande qui n'est plus chargée. Elles n'ont aucun effet : vous pouvez les supprimer. / Supprimer la règle de {command} / Règle de {command} supprimée. |
| `permissions.cell_everywhere`, `cell_none` | Everywhere: {mode} ({people}) / No rule everywhere | Partout : {mode} ({people}) / Aucune règle partout |
| `permissions.cell_groups` / `_one` | {count} groups with a rule / {count} group with a rule | {count} groupes avec une règle / {count} groupe avec une règle |
| `permissions.cmd_title`, `cmd_intro`, `cmd_everywhere_title` | Permissions of {name} / The "everywhere" rule applies in every group and in private. A group's own rule can add to it or replace it for that group. / "Everywhere" rule | Permissions de {name} / La règle « partout » s'applique dans tous les groupes et en privé. La règle propre à un groupe peut la compléter ou la remplacer pour ce groupe. / Règle « partout » |
| `permissions.cmd_groups_title`, `cmd_groups_empty`, `cmd_group_open` | Groups with their own rule ({count}) / No group has its own rule for this command. / Open permissions of {group} | Groupes avec une règle propre ({count}) / Aucun groupe n'a de règle propre pour cette commande. / Ouvrir les permissions de {group} |
| `permissions.picker_hint`, `picker_search`, `picker_empty`, `col_name`, `col_number` | Pick from contacts who already wrote to the bot privately. Check the number: a display name can be misleading. / Search a contact / No known contact. / Name / Number | Choisissez parmi les contacts qui ont déjà écrit au bot en privé. Vérifiez le numéro : un nom affiché peut être trompeur. / Rechercher un contact / Aucun contact connu. / Nom / Numéro |
| `permissions.number_label`, `number_hint`, `number_add` | Or type a number / Digits with the country code (8 to 15 digits). Spaces, + and dashes are ignored. / Add this number | Ou saisir un numéro / Chiffres avec l'indicatif du pays (8 à 15 chiffres). Les espaces, le signe + et les tirets sont ignorés. / Ajouter ce numéro |

**Files impacted.** New `specs/003-command-permissions/i18n/panel-permissions.json`; generated edits of `lib/admin/public/i18n/{en,fr}.json`; edit of `test/admin-i18n.test.js` (two fragment directories). Reused as is: `common.save/add/remove/delete/cancel/close/retry`, `groups.members_search*`, `groups.members_no_match`, `commands.access_*`.

## C10. Audit page (FR-025)

**Decision.** The audit page shows the raw action code and filters by prefix, so there is no per-action label table to extend. If stream A names the actions `permission.set` and `permission.delete` (recommended: target `<command>:<scope>` with scope `*` or the group jid, like `command.toggle`; detail `{ mode, added: [...], removed: [...] }`), the panel adds one prefix: `"permission"` in `ACTION_PREFIXES` (`views/audit-logic.mjs:10`) and `audit.prefix_permission` (C9). If A uses `command.permission.*` nothing changes. Optional, recommended: a `kind: "rule"` branch in `summarizeDetail` (`{ mode, added[], removed[] }`) rendered as "mode, +N, -M" with the numbers listed in full, because the generic JSON summary is cut at 160 characters (`audit-logic.mjs:111`) and a rule with ten people would hide who was added.

**Rationale.** `test/admin-view-logs-stats.test.js:236` fails if `lib/admin/audit.js` `ACTIONS` gains an action no prefix covers: that is the guard, so the prefix must land with A's `ACTIONS` change.

**Alternatives.** Leave detail as JSON: satisfies the letter of FR-025 in the database, not on screen.

**Evidence.** `lib/admin/audit.js:28-69` (vocabulary), `views/audit.mjs:61,76` (prefix options, raw action column), `views/audit-logic.mjs:96-133`, `lib/admin/routes/groups.js:168,218` (audit call style).

**Files impacted.** `views/audit-logic.mjs`, optionally `views/audit.mjs`; `lib/admin/audit.js` (stream A).

## C11. Tests

**Decision.** Three new files, one edit, rest automatic.

1. `test/admin-view-permissions.test.js` (pure, same style as `admin-view-commands.test.js`): `parseNumber` (`+237 690-000-001`, `00237690000001`, `(237) 690.000.001`, too short/long, letters, empty -> `required`); `personKey` (device suffix, case); `addPerson` duplicate (PN typed vs chip) and cap; `diffPeople`/`isDirty` set-based (add then remove = clean); `canSave` (`extra` + empty false, `only` + empty true); `ruleBody` stable and de-duplicated; `computeWarnings` table of C6 (admin command + non-admin counts only `present:true`; everywhere variant; `extra_on_public` only when neither owner nor admin; `only_empty`; disabled info); `personBadges`; `effectiveMode` truth table of FR-006 step 4 (group rule wins, else everywhere, else normal); `lockReasonKey` (known code, unknown, missing); `splitCommands`; `commandSummary`; view modules import and export the expected components.
2. `test/admin-view-permissions-dom.test.js` (fakeDom, pattern `admin-view-data.test.js:389-475`: `createDom`, scripted `fetch`, `setCatalog` with the real catalogs plus the 003 fragment, `ui.confirmStore`/`resolveConfirm`). Cases: group tab lists rules with the "Ne fait plus partie du groupe" and "Non admin" badges; create flow (`dom.choose` on the command select, tick two members with `dom.check`, warning text visible, Save sends exactly `PUT .../permissions/kick` with `{ mode: "extra", people: [...] }`, parent group reloaded); locked options are `disabled` and carry the reason; delete asks first, refusing sends nothing, accepting sends `DELETE` then reloads; members fetch 409 shows the notice, hides the picker, removal still works; "partout" card shows `effectiveMode` and the Commands link; orphan row deletes. Commands page: the new column and summary text, locked row (muted name, disabled button, reason text), typed number becomes a chip (`237690000003@s.whatsapp.net`), invalid number shows `fields.invalid_phone`, pick from known chats (`GET /admin/api/chats` with `kind=private`), Save/Delete "partout", groups list link `#/groups/<jid>?tab=permissions`, `?command=vv&panel=permissions` opens the card.
3. Edits: `test/admin-view-groups.test.js` (assert `TABS` ends `[..., "commands", "permissions", "advanced"]`, `tabOf("permissions")`), `test/admin-i18n.test.js` (two fragment directories), `test/admin-view-logs-stats.test.js` only if the prefix list is pinned there (it is derived from `ACTIONS`, so no edit expected).
4. Automatic and must stay green: `test/admin-frontend.test.js` scans every new `.mjs` (no `innerHTML`/`eval`/inline style/external URL, imports resolve, modules import without a DOM, css guard demands a rule for each `class="..."` word: use only classes that exist: `card stack stack-sm row row-wrap grow chip chip-text badge badge-* banner banner-warn banner-info muted mono icon-btn btn btn-sm btn-primary btn-danger select input field choice choice-group actions cell-actions nowrap`), contract test 11 (needs A's routes), the DELETE guard (`:1174`; a rule `DELETE` under `${base}/permissions/...` is not in section 1.10, so no `?confirm=true` is required; if A adds a server `confirm` to rule deletion, add it to `CONFIRMED_ACTIONS` at `:1136`), `test/admin-i18n.test.js` literal and dynamic `t()` key checks.

**Evidence.** `test/helpers/fakeDom.js:1-20,150-210`, `test/admin-view-data.test.js:389-475`, `test/admin-view-commands.test.js`, `test/admin-frontend.test.js:88,218,240,1102,1174,1334`.

**Files impacted.** Two new tests, three edited.

## C12. File list, ownership and order

| File | New/edit | Owner (suggested) |
| --- | --- | --- |
| `views/permissions-logic.mjs` | new | C1 (shared core, first) |
| `views/permissions-editor.mjs`, `permissions-members.mjs`, `permissions-picker.mjs` | new | C1 |
| `views/groups-permissions.mjs`, `groups-logic.mjs` (TABS), `groups-page.mjs` | new/edit | C2 (group tab) |
| `views/commands-permissions.mjs`, `commands.mjs` | new/edit | C3 (commands page) |
| `views/audit-logic.mjs` (+ `audit.mjs` optional) | edit | C3 or C1 |
| `specs/003-command-permissions/i18n/panel-permissions.json`, catalogs (merge) | new/generated | C1 writes, one agent merges |
| `test/admin-view-permissions*.test.js`, edits of 3 tests | new/edit | each owner for their part |

Order: logic + editor + fragment -> (group tab || commands page) in parallel -> audit prefix -> merge -> `yarn test`. Both pages need A's routes registered (contract test 11), so the views can be written against a fake `fetch` but merge after A.

## Open points for the owner

1. **Typed number format.** US3 scenario 5 says "avec ou sans indicatif", but a national number without the country code cannot be resolved (the panel has no default-country setting and every other number field says "avec l'indicatif du pays"). Recommended: require the country code (8 to 15 digits), ignore `+`, spaces, dashes, dots, brackets and a leading `00`, no default-country setting.
2. **Granularity of the "non délégable" reason.** One generic sentence for all, or five short reasons (code, update, data, lockout, config) declared as `neverDelegable: "<code>"`. Recommended: five reasons with a generic fallback; the UI code is the same either way.
3. **Save model.** Draft with an explicit Save per rule (one audit entry per save, warnings read before the commit) or instant save on each tick. Recommended: draft + Save; deleting a whole rule stays one click plus a confirm dialog.
