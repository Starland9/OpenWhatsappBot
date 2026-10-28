// Pure logic of the groups area (US6): template variables, filter limits, request bodies, list helpers.
// No DOM access at import time: node:test imports this file (test/admin-view-groups.test.js).

export const VARIABLES = Object.freeze(["@user", "@group", "@desc"]);
export const ROLES = Object.freeze(["regular", "vip", "muted", "banned"]);
export const STATUSES = Object.freeze(["all", "current", "former"]);
export const TABS = Object.freeze(["messages", "protection", "filters", "members", "commands", "advanced"]);
export const LIST_TABS = Object.freeze(["groups", "disabled"]);

// Defaults of GRP-3 `limits` (the server's answer wins once the group is loaded).
export const LIMITS = Object.freeze({ messageMax: 1000, filtersMax: 50, patternMax: 100, responseMax: 1000 });

export const PAGE_SIZE = 25;
export const MEMBER_PAGE_SIZE = 25;
export const SEARCH_MAX = 100;

/** Commands whose removal can leave a chat unreachable (CMD-2 / GRP-17 warn after the fact; the view asks before). */
export const LOCKOUT_COMMANDS = Object.freeze({ unban: "unban", ban: "ban" });

const codePoints = (text) => Array.from(String(text ?? "")).length;

// ---- template variables (mirror of lib/admin/services/groups.js `findUnknownVariables`) --------------

/**
 * Names of the unknown `@variables` of a welcome or goodbye template: lower-cased, with their `@`, in order of
 * appearance, without duplicates. A variable is an `@` followed by letters, not preceded by a letter, a digit,
 * a dot or an underscore (an e-mail address or a number mention is not one). Known: @user, @group, @desc.
 */
export function findUnknownVariables(text) {
  const names = [];
  for (const match of String(text ?? "").matchAll(/(?<![A-Za-z0-9._])@([A-Za-z]+)/g)) {
    const name = `@${match[1].toLowerCase()}`;
    if (!VARIABLES.includes(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Check a template the way GRP-4 does. `{ ok, error }` where `error` is a field error `{ code, params }`
 * (`too_short`, `too_long`, `unknown_variable`) the Field component can show as is.
 */
export function validateTemplate(text, max = LIMITS.messageMax) {
  const value = String(text ?? "").trim();
  const length = codePoints(value);
  if (length < 1) return { ok: false, error: { code: "too_short", params: { min: 1 } } };
  if (length > max) return { ok: false, error: { code: "too_long", params: { max } } };
  const names = findUnknownVariables(value);
  if (names.length) return { ok: false, error: { code: "unknown_variable", params: { names } } };
  return { ok: true, error: null };
}

/** The text with `@user`, `@group` and `@desc` replaced (case-insensitive, one pass); unknown names stay as typed. */
export function renderTemplate(template, vars) {
  return String(template ?? "").replace(/@(user|group|desc)\b/gi, (match, name) => {
    const key = name.toLowerCase();
    return Object.hasOwn(vars || {}, key) ? String(vars[key]) : match;
  });
}

// ---- welcome / goodbye form --------------------------------------------------------------------------

/** Form state of one template, from the GRP-3 object: `{ enabled, message }`. */
export function templateDraft(group, kind) {
  const part = (group && group[kind]) || {};
  return { enabled: Boolean(part.enabled), message: typeof part.message === "string" ? part.message : "" };
}

export const templateDirty = (group, kind, draft) => {
  const base = templateDraft(group, kind);
  return base.enabled !== Boolean(draft.enabled) || base.message.trim() !== String(draft.message ?? "").trim();
};

/**
 * GRP-4 body for one template, only what changed; null when nothing did.
 * The switch and the text are separate properties, so a text edit never flips the switch.
 */
export function templateBody(group, kind, draft) {
  const base = templateDraft(group, kind);
  const part = {};
  if (base.enabled !== Boolean(draft.enabled)) part.enabled = Boolean(draft.enabled);
  const message = String(draft.message ?? "").trim();
  if (message !== base.message.trim()) part.message = message;
  return Object.keys(part).length ? { [kind]: part } : null;
}

/** The text with a variable added at the end (a space first when the text does not end with one). */
export function appendVariable(text, variable) {
  const base = String(text ?? "");
  return `${base}${base && !/\s$/.test(base) ? " " : ""}${variable}`;
}

/** GRP-4 body that puts the default message back (`null`, like `.welcome reset`). */
export const resetBody = (kind) => ({ [kind]: { message: null } });

/** Lines of a rendered preview, for a view that must not build markup from a string. */
export const previewLines = (text) => String(text ?? "").split(/\r?\n/);

// ---- filters (GRP-7..10) -------------------------------------------------------------------------------

/** Whitespace collapsed and trimmed: the form stored by the server. */
export const squash = (text) => String(text ?? "").trim().replace(/\s+/g, " ");

/** The form patterns are compared in (case and spacing ignored). */
export const normalizePattern = (text) => squash(text).toLowerCase();

/**
 * Check a filter before sending it. `others` are the other filters of the group (`{ id, pattern }`).
 * @returns {{ ok: boolean, fields: Object<string, { code: string, params?: object }>, limit: boolean }}
 *   `limit` is true when adding one more would pass the per-group maximum (the server answers `limit_reached`).
 */
export function validateFilter({ pattern, response }, others = [], { editingId = null, limits = LIMITS } = {}) {
  const fields = {};
  const rest = (others || []).filter((f) => f.id !== editingId);
  const cleanPattern = squash(pattern);
  const cleanResponse = String(response ?? "").trim();
  if (!cleanPattern) fields.pattern = { code: "too_short", params: { min: 1 } };
  else if (codePoints(cleanPattern) > limits.patternMax) fields.pattern = { code: "too_long", params: { max: limits.patternMax } };
  else if (rest.some((f) => normalizePattern(f.pattern) === normalizePattern(cleanPattern))) fields.pattern = { code: "duplicate" };
  if (!cleanResponse) fields.response = { code: "too_short", params: { min: 1 } };
  else if (codePoints(cleanResponse) > limits.responseMax) fields.response = { code: "too_long", params: { max: limits.responseMax } };
  const limit = editingId === null && rest.length >= limits.filtersMax;
  return { ok: Object.keys(fields).length === 0 && !limit, fields, limit };
}

/** Body of GRP-8 / GRP-9 (the strings the server will store). */
export const filterBody = ({ pattern, response }) => ({ pattern: squash(pattern), response: String(response ?? "").trim() });

/** One line of a response for a table cell. */
export function excerpt(text, max = 80) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return codePoints(flat) > max ? `${Array.from(flat).slice(0, max - 1).join("")}…` : flat;
}

// ---- guard (GRD-1) ------------------------------------------------------------------------------------------

/** GRD-1 body for one switch: `{ antilink: true }`. */
export const guardBody = (key, value) => ({ [key]: Boolean(value) });

/** `warnings` codes of GRP-3 / GRD-1 as panel keys (`groups.warning_bot_not_admin`). */
export const warningKey = (code) => `groups.warning_${code}`;
export const hasWarning = (group, code) => Boolean(group && Array.isArray(group.warnings) && group.warnings.includes(code));

// ---- roles and members ----------------------------------------------------------------------------------------

/** "+237600000002" for a phone-number JID, "@123456" for a LID, the JID itself otherwise. */
export function shortJid(jid) {
  const text = String(jid ?? "");
  const [user, server = ""] = text.split("@");
  const digits = user.split(":")[0];
  if (server === "s.whatsapp.net" && /^\d+$/.test(digits)) return `+${digits}`;
  if (server === "lid") return `@${digits}`;
  return text;
}

/** Members whose number (or JID) contains the typed digits / text. */
export function filterMembers(items, query) {
  const needle = String(query ?? "").trim().toLowerCase().replace(/^\+/, "");
  if (!needle) return items || [];
  return (items || []).filter((m) => String(m.jid).toLowerCase().includes(needle));
}

/** `{ items, page, pages, total }` for a client-side page (1-based, clamped). */
export function paginate(items, page, size = MEMBER_PAGE_SIZE) {
  const list = items || [];
  const pages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  return { items: list.slice((current - 1) * size, current * size), page: current, pages, total: list.length, pageSize: size };
}

/** Role of the members that have one (`vip`, `muted`, `banned`) first, then admins, then the rest by number. */
export function sortMembers(items) {
  const rank = (m) => (m.role !== "regular" ? 0 : m.admin ? 1 : 2);
  return [...(items || [])].sort((a, b) => rank(a) - rank(b) || String(a.jid).localeCompare(String(b.jid)));
}

/** GRP-13 body, or null when the role does not change. */
export const roleBody = (current, wanted) => (ROLES.includes(wanted) && wanted !== current ? { role: wanted } : null);

// ---- commands (GRP-17) -----------------------------------------------------------------------------------------

/** `{ disable?: [name], enable?: [name] }` for one command switched in this group. */
export const commandBody = (name, disable) => (disable ? { disable: [name] } : { enable: [name] });

/** The commands to show: `{ query }` matches the name, an alias or the description (lower-cased). */
export function filterCommands(commands, query) {
  const needle = String(query ?? "").trim().toLowerCase().replace(/^[^a-z0-9]+/, "");
  if (!needle) return commands || [];
  return (commands || []).filter((c) => {
    const haystack = [c.name, ...(c.aliases || []), c.desc].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(needle);
  });
}

/** The state of one command for this group: `global` wins over `group`. */
export function commandState(command, groupJid, disabledHere = []) {
  if (command.disabledGlobal) return "global";
  const here = disabledHere.includes(command.name) || (command.disabledGroups || []).includes(groupJid);
  return here ? "group" : "on";
}

/** The panel key of the confirmation shown before a lock-out command is switched off, or null. */
export const lockoutKey = (name) => (Object.hasOwn(LOCKOUT_COMMANDS, name) ? `groups.lockout_${LOCKOUT_COMMANDS[name]}` : null);

// ---- list (GRP-1) ------------------------------------------------------------------------------------------------

/** Query object of GRP-1: defaults are left out. */
export function listQuery({ page = 1, pageSize = PAGE_SIZE, q = "", status = "all" } = {}) {
  const query = { pageSize };
  if (page > 1) query.page = page;
  const text = String(q ?? "").trim().slice(0, SEARCH_MAX);
  if (text) query.q = text;
  if (STATUSES.includes(status) && status !== "all") query.status = status;
  return query;
}

/** Status badges of a list row, as `{ id, tone }` (the view translates `groups.badge_<id>`). */
export function rowBadges(item) {
  const out = [];
  if (item.former) out.push({ id: "former", tone: "neutral" });
  else if (item.botIsAdmin === true) out.push({ id: "bot_admin", tone: "ok" });
  else if (item.botIsAdmin === false) out.push({ id: "bot_not_admin", tone: "warn" });
  if (item.disabled) out.push({ id: "disabled", tone: "danger" });
  return out;
}

/** The features switched on in a row, as ids (`welcome`, `goodbye`, `antilink`, `antibot`, `mute`). */
export const rowFeatures = (item) => ["welcome", "goodbye", "antilink", "antibot", "mute"].filter((key) => Boolean(item[key]));

/** The tab named in the hash query, or the first one. */
export const tabOf = (value, tabs = TABS) => (tabs.includes(value) ? value : tabs[0]);
