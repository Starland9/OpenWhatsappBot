// Pure logic of the permissions views (feature 003): the rule editor, the group "Permissions" tab and the Commands
// page card. Typed numbers, person identity, the draft, the live warnings and the badges, the lists the pages build
// and the links between them. No DOM, no network, no timer, no t(): a function that needs a text returns a panel key
// (and params) and the view calls t(). node:test imports this file (test/admin-view-permissions.test.js).
// Contract: specs/003-command-permissions/contracts/panel-ui.md sections 4 and 10; the warning objects are those
// of admin-permissions-api.md 1.5.
import { shortJid } from "./groups-logic.mjs";

export const MODES = Object.freeze({ EXTRA: "extra", ONLY: "only" });
export const GLOBAL_SCOPE = "*";
/** Default of `limits.peopleMax` until the server answers */
export const PEOPLE_MAX = 100;
/** Chips shown in a row before "+N more" */
export const PEOPLE_PREVIEW = 6;
/** Why a command can never be delegated (U7); anything else reads as the fallback reason */
export const LOCK_REASONS = Object.freeze(["code", "update", "data", "lockout", "config"]);
/** Digits of a typed number, country code included (U5) */
export const PHONE_MIN = 8;
export const PHONE_MAX = 15;

const MODE_VALUES = Object.values(MODES);
const ADMIN_STATUSES = ["admin", "superadmin"];
/** The four warnings the server computes (API contract 1.5); the client adds `disabled_here` and `context_only` */
const SERVER_WARNING_CODES = ["opens_admin_command", "extra_on_public", "empty_only", "normal_here"];
const ORPHAN_REASONS = ["unknown_command", "not_delegable"];
const SEARCH_MAX = 100;
const CHAT_PAGE_SIZE = 50;

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const accessOf = (command) => (command && isPlainObject(command.access) ? command.access : {});

// ---------------------------------------------------------------------------
// Commands, levels, locks
// ---------------------------------------------------------------------------

/** CMD-1 commands with their PERM-1 item as `perm` (matched by name; `null` when there is none). Nothing is mutated. */
export function mergePermissions(commands, items) {
  const byName = new Map();
  for (const item of Array.isArray(items) ? items : []) if (item && typeof item.name === "string") byName.set(item.name, item);
  return (Array.isArray(commands) ? commands : []).map((command) => ({ ...command, perm: byName.get(command.name) || null }));
}

/** Never delegable (a reason is declared in the code) */
export const isLocked = (command) => Boolean(command && command.perm) && command.perm.delegable === false;

/** Delegable. A command with no PERM-1 item is neither locked nor delegable: the UI shows "unavailable". */
export const isDelegable = (command) => Boolean(command && command.perm) && command.perm.delegable === true;

/** Panel key of the reason a command is locked; the fallback ("reserved to the owner") for a missing or unknown code */
export const lockReasonKey = (lockReason) => (LOCK_REASONS.includes(lockReason) ? `permissions.reason_${lockReason}` : "permissions.reason_unknown");

/** Is the command open to everybody (the access half of the server's `extra_on_public`)? */
export const isPublic = (access) => !(access && (access.owner || access.admin));

/** The normal level of a command; the view shows `t("commands.access_" + level)`. Owner wins over admin. */
export function normalLevel(access) {
  if (access && access.owner) return "owner";
  if (access && access.admin) return "admin";
  return "everyone";
}

/** Feeds the "new rule" select: the delegable commands without a rule, and every locked command, both sorted by name */
export function splitCommands(commands, existingNames) {
  const taken = new Set(existingNames || []);
  const list = Array.isArray(commands) ? commands : [];
  const sorted = (items) => items.sort((a, b) => byText(a.name, b.name));
  return {
    delegable: sorted(list.filter((command) => isDelegable(command) && !taken.has(command.name))),
    locked: sorted(list.filter(isLocked)),
  };
}

/** What the Commands table cell shows: `unavailable`, `locked` (with the reason key), `rule` or `none` */
export function commandCell(command) {
  if (!command || !command.perm) return { kind: "unavailable" };
  if (command.perm.delegable === false) return { kind: "locked", reasonKey: lockReasonKey(command.perm.lockReason) };
  const everywhere = command.perm.everywhere;
  const groups = Number(command.perm.groups) || 0;
  if (everywhere) return { kind: "rule", mode: everywhere.mode, count: Number(everywhere.count) || 0, groups };
  return { kind: "none", mode: null, count: 0, groups };
}

// ---------------------------------------------------------------------------
// Identity and typed numbers
// ---------------------------------------------------------------------------

/**
 * The key two JIDs of one person share: lower case, device suffix dropped, `@c.us` read as `@s.whatsapp.net`.
 * The browser never decides more than that (the server resolves PN and LID). A non-string gives "".
 */
export function personKey(jid) {
  if (typeof jid !== "string") return "";
  const text = jid.trim().toLowerCase();
  const at = text.lastIndexOf("@");
  if (at === -1) return text;
  const user = text.slice(0, at).split(":")[0];
  const server = text.slice(at + 1);
  return `${user}@${server === "c.us" ? "s.whatsapp.net" : server}`;
}

/** The number is always shown, the name only beside it (push names are chosen by their owner and can mislead) */
export function personLabel(person) {
  const name = person && typeof person.name === "string" && person.name !== "" ? person.name : null;
  return { name, number: shortJid(person && person.jid) };
}

/**
 * A number typed by the owner (U5, FR-031): separators (spaces, `+`, `-`, `.`, parentheses) and one leading `00` are
 * ignored; 8 to 15 digits with the country code, so a number starting with 0 (a national number) is refused.
 * `{ ok: true, jid, digits }` or `{ ok: false, error: { code } }` (a field error the `fields.<code>` texts translate).
 */
export function parseNumber(input) {
  const text = String(input ?? "").trim();
  if (!text) return { ok: false, error: { code: "required" } };
  if (!/^[\d\s+\-.()]+$/.test(text)) return { ok: false, error: { code: "invalid_phone" } };
  let digits = text.replace(/[\s+\-.()]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length < PHONE_MIN || digits.length > PHONE_MAX || digits.startsWith("0")) return { ok: false, error: { code: "invalid_phone" } };
  return { ok: true, jid: `${digits}@s.whatsapp.net`, digits };
}

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

const byKey = (a, b) => byText(personKey(a.jid), personKey(b.jid));

/** One entry per person (the first spelling wins), sorted by `personKey` */
function uniqueSorted(people) {
  const seen = new Set();
  const out = [];
  for (const person of Array.isArray(people) ? people : []) {
    const key = personKey(person && person.jid);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(person);
  }
  return out.sort(byKey);
}

/** The editor's starting point: a saved rule's mode and people, or an empty `extra` draft for a new rule */
export function draftOf(rule) {
  if (!rule) return { mode: MODES.EXTRA, people: [] };
  return { mode: MODE_VALUES.includes(rule.mode) ? rule.mode : MODES.EXTRA, people: uniqueSorted(rule.people) };
}

/** The same object when the mode is already `mode` or is not a mode */
export function setMode(draft, mode) {
  if (!MODE_VALUES.includes(mode) || draft.mode === mode) return draft;
  return { ...draft, mode };
}

export function hasPerson(draft, jid) {
  const key = personKey(jid);
  return key !== "" && draft.people.some((person) => personKey(person.jid) === key);
}

/**
 * Add a person. `{ draft, error }`: `error` is `{ code: "duplicate" }`, `{ code: "too_many_items", params: { max } }` or
 * `{ code: "invalid_jid" }` (no usable jid), and the draft is then the same object. The people stay in `personKey` order.
 */
export function addPerson(draft, person, { max = PEOPLE_MAX } = {}) {
  const key = personKey(person && person.jid);
  if (!key) return { draft, error: { code: "invalid_jid" } };
  if (hasPerson(draft, key)) return { draft, error: { code: "duplicate" } };
  if (draft.people.length >= max) return { draft, error: { code: "too_many_items", params: { max } } };
  return { draft: { ...draft, people: [...draft.people, person].sort(byKey) }, error: null };
}

/** By `personKey`; the same object when the person is not in the draft */
export function removePerson(draft, jid) {
  const key = personKey(jid);
  if (!hasPerson(draft, key)) return draft;
  return { ...draft, people: draft.people.filter((person) => personKey(person.jid) !== key) };
}

/** What a checkbox does: remove a person who is in, else add. Removing is never refused. */
export function togglePerson(draft, person, { max = PEOPLE_MAX } = {}) {
  if (hasPerson(draft, person && person.jid)) return { draft: removePerson(draft, person.jid), error: null };
  return addPerson(draft, person, { max });
}

/** Set-based on `personKey`. `saved` is a rule or null. `added` are the draft's jids, `removed` the saved rule's. */
export function diffPeople(saved, draft) {
  const was = uniqueSorted(saved && saved.people);
  const wants = uniqueSorted(draft.people);
  const wasKeys = new Set(was.map((person) => personKey(person.jid)));
  const wantKeys = new Set(wants.map((person) => personKey(person.jid)));
  return {
    added: wants.filter((person) => !wasKeys.has(personKey(person.jid))).map((person) => person.jid),
    removed: was.filter((person) => !wantKeys.has(personKey(person.jid))).map((person) => person.jid),
  };
}

/** The mode the draft is compared with: the saved rule's, `extra` for a rule being created */
const baseMode = (saved) => (saved && MODE_VALUES.includes(saved.mode) ? saved.mode : MODES.EXTRA);

/** Does the draft differ from the saved rule? An untouched new-rule draft is not dirty. */
export function isDirty(saved, draft) {
  if (draft.mode !== baseMode(saved)) return true;
  const { added, removed } = diffPeople(saved, draft);
  return added.length + removed.length > 0;
}

/** People added, people removed, and one for a mode change */
export function pendingCount(saved, draft) {
  const { added, removed } = diffPeople(saved, draft);
  return added.length + removed.length + (draft.mode !== baseMode(saved) ? 1 : 0);
}

/**
 * Can the draft be saved? `reason` is `people_required` (an `extra` rule for "everywhere" with nobody is a no-op, the
 * server refuses it; the same rule is fine for a group: "normal level here", U3) or `unchanged` (a saved rule the
 * draft does not change).
 */
export function canSave(draft, saved, { scope } = {}) {
  if (scope === GLOBAL_SCOPE && draft.mode === MODES.EXTRA && draft.people.length === 0) return { ok: false, reason: "people_required" };
  if (saved && !isDirty(saved, draft)) return { ok: false, reason: "unchanged" };
  return { ok: true, reason: null };
}

/** The body of PERM-3 / PERM-6: the mode and one jid string per person, de-duplicated and sorted. Nothing else travels. */
export function ruleBody(draft) {
  return { mode: draft.mode, people: uniqueSorted(draft.people).map((person) => person.jid) };
}

// ---------------------------------------------------------------------------
// Warnings, badges, display
// ---------------------------------------------------------------------------

/**
 * The live banners of the editor, in the order of the table of panel-ui.md section 10 (warnings, then information).
 * The four server codes are the same objects the server returns for the same rule (same tone, same params); the
 * client adds `disabled_here` and `context_only`. `disabled` is null, "global" or "group"; `hasEverywhereOnly` only
 * decides the tone of `normal_here` (group scope).
 */
export function computeWarnings({ command, draft, scope, disabled = null, hasEverywhereOnly = false } = {}) {
  const access = accessOf(command);
  const people = draft.people;
  const everywhere = scope === GLOBAL_SCOPE;
  const out = [];

  if (access.admin && people.length > 0) {
    if (everywhere) {
      out.push({ code: "opens_admin_command", tone: "warn", params: { count: people.length, everywhere: true } });
    } else {
      // unknown, absent and offline people count as not admin: the conservative rule of the server
      const strangers = people.filter((person) => !ADMIN_STATUSES.includes(person.admin)).length;
      if (strangers > 0) out.push({ code: "opens_admin_command", tone: "warn", params: { count: strangers, everywhere: false } });
    }
  }
  if (draft.mode === MODES.EXTRA && people.length > 0 && isPublic(access)) out.push({ code: "extra_on_public", tone: "warn", params: {} });
  if (draft.mode === MODES.ONLY && people.length === 0) out.push({ code: "empty_only", tone: "warn", params: {} });
  if (!everywhere && draft.mode === MODES.EXTRA && people.length === 0) out.push({ code: "normal_here", tone: hasEverywhereOnly ? "info" : "warn", params: {} });

  if (disabled === "global" || disabled === "group") out.push({ code: "disabled_here", tone: "info", params: { where: disabled } });
  if (access.pm) out.push({ code: "context_only", tone: "info", params: { context: "pm" } });
  else if (access.group && everywhere) out.push({ code: "context_only", tone: "info", params: { context: "group" } });
  return out;
}

/**
 * The server's `Rule.warnings` (or a PERM-2 per-group `warnings`) as `{ code, tone, params }`: only the four server
 * codes are kept, `tone` is forced to "warn" or "info" (default "warn") and `params` to an object. Junk is dropped.
 */
export function normalizeWarnings(warnings) {
  if (!Array.isArray(warnings)) return [];
  const out = [];
  for (const item of warnings) {
    if (!isPlainObject(item) || !SERVER_WARNING_CODES.includes(item.code)) continue;
    out.push({ code: item.code, tone: item.tone === "info" ? "info" : "warn", params: isPlainObject(item.params) ? { ...item.params } : {} });
  }
  return out;
}

/**
 * Panel key of a banner text, or null for an unknown code. The view calls `t(key, warning.params)`: the numeric
 * `params.count` picks the `_one` form (`permissions.warn_opens_admin_command_one`).
 */
export function warningTextKey(warning) {
  const params = (warning && isPlainObject(warning.params) ? warning.params : null) || {};
  switch (warning && warning.code) {
    case "opens_admin_command":
      return params.everywhere ? "permissions.warn_opens_admin_command_everywhere" : "permissions.warn_opens_admin_command";
    case "extra_on_public":
      return "permissions.warn_extra_on_public";
    case "empty_only":
      return "permissions.warn_empty_only";
    case "normal_here":
      return warning.tone === "info" ? "permissions.info_normal_here" : "permissions.warn_normal_here";
    case "disabled_here":
      return params.where === "group" ? "permissions.info_disabled_here_group" : "permissions.info_disabled_here_global";
    case "context_only":
      return params.context === "pm" ? "permissions.info_context_only_pm" : "permissions.info_context_only_group";
    default:
      return null;
  }
}

/** The short badges of a saved rule's row (`warnings` as `normalizeWarnings` returns them). Information-only ids have none. */
export function warningBadges(warnings) {
  const out = [];
  for (const warning of Array.isArray(warnings) ? warnings : []) {
    if (!warning || !SERVER_WARNING_CODES.includes(warning.code)) continue;
    const tone = warning.tone === "info" ? "info" : "warn";
    const key = warning.code === "normal_here" && tone === "warn" ? "permissions.badge_normal_here_noop" : `permissions.badge_${warning.code}`;
    out.push({ code: warning.code, tone, key });
  }
  return out;
}

/**
 * The badges of a person's chip: `former` (no longer in the group), `admin` (the view labels it with
 * `groups.admin_<status>`), `not_admin` (an admin command and a person known to be in the group). An unknown status
 * (`present` null or missing) shows nothing: unknown is not presented as a fact.
 */
export function personBadges(person, { adminCommand = false } = {}) {
  if (!person) return [];
  if (person.present === false) return [{ id: "former", tone: "neutral" }];
  if (ADMIN_STATUSES.includes(person.admin)) return [{ id: "admin", tone: "info" }];
  if (person.present === true && adminCommand) return [{ id: "not_admin", tone: "warn" }];
  return [];
}

/** FR-006 step 4, for display: a group rule wins (even without a person), else the "everywhere" rule, else normal */
export function effectiveMode(groupRule, everywhereRule) {
  if (groupRule) return { mode: groupRule.mode, source: "group" };
  if (everywhereRule) return { mode: everywhereRule.mode, source: "everywhere" };
  return { mode: "normal", source: "none" };
}

/** The first `preview` people and how many are left */
export function peopleSummary(people, preview = PEOPLE_PREVIEW) {
  const list = Array.isArray(people) ? people : [];
  return { shown: list.slice(0, preview), more: Math.max(0, list.length - preview) };
}

/**
 * The rows of a group's "allowed everywhere" card: every "everywhere" rule whose command is loaded and delegable,
 * with the mode that applies in this group. Rules on unknown or locked commands are orphans, not rows.
 */
export function everywhereRows(everywhereRules, groupRules, commands) {
  const byName = new Map();
  for (const command of Array.isArray(commands) ? commands : []) if (isDelegable(command)) byName.set(command.name, command);
  const groupByCommand = new Map();
  for (const rule of Array.isArray(groupRules) ? groupRules : []) if (rule) groupByCommand.set(rule.command, rule);
  const rows = [];
  for (const rule of Array.isArray(everywhereRules) ? everywhereRules : []) {
    const command = rule && byName.get(rule.command);
    if (command) rows.push({ command, rule, effective: effectiveMode(groupByCommand.get(rule.command) || null, rule) });
  }
  return rows.sort((a, b) => byText(a.command.name, b.command.name));
}

/** PERM-1 `orphans` (every scope) grouped by command, sorted; the scopes of a command list "everywhere" first */
export function groupOrphanRules(orphans) {
  const byCommand = new Map();
  for (const orphan of Array.isArray(orphans) ? orphans : []) {
    if (!orphan || typeof orphan.command !== "string") continue;
    if (!byCommand.has(orphan.command)) {
      byCommand.set(orphan.command, { command: orphan.command, reason: ORPHAN_REASONS.includes(orphan.reason) ? orphan.reason : "unknown_command", scopes: [] });
    }
    byCommand.get(orphan.command).scopes.push({ scope: String(orphan.scope ?? ""), mode: orphan.mode, count: Number(orphan.count) || 0 });
  }
  const rank = (scope) => (scope === GLOBAL_SCOPE ? 0 : 1);
  for (const entry of byCommand.values()) entry.scopes.sort((a, b) => rank(a.scope) - rank(b.scope) || byText(a.scope, b.scope));
  return [...byCommand.values()].sort((a, b) => byText(a.command, b.command));
}

// ---------------------------------------------------------------------------
// Queries and links
// ---------------------------------------------------------------------------

/** The CHAT-1 query of the person picker: private chats, never `selectable`; `page` above 1 and `q` only when set */
export function chatQuery({ q = "", page = 1, pageSize = CHAT_PAGE_SIZE } = {}) {
  const query = { kind: "private", pageSize };
  if (page > 1) query.page = page;
  const text = String(q ?? "").trim().slice(0, SEARCH_MAX);
  if (text) query.q = text;
  return query;
}

/**
 * `#/commands?command=<name>&panel=permissions`: the command whose card to open, or null (another panel, an unknown
 * or locked command). An alias is accepted and resolved to the command's name.
 */
export function selectionFromQuery(query, commands) {
  if (!query || query.panel !== "permissions" || typeof query.command !== "string") return null;
  const wanted = query.command.trim().toLowerCase();
  if (!wanted) return null;
  const found = (Array.isArray(commands) ? commands : []).find((command) => command.name === wanted || (command.aliases || []).includes(wanted));
  if (!found || isLocked(found)) return null;
  return { name: found.name, panel: "permissions" };
}

/** Arguments for `buildHash`: a group's Permissions tab */
export const groupTabTarget = (jid) => ({ name: "groups", rest: [jid], query: { tab: "permissions" } });

/** Arguments for `buildHash`: the Commands page with the permissions card of a command */
export const commandPanelTarget = (name) => ({ name: "commands", rest: [], query: { command: name, panel: "permissions" } });
