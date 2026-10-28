// Pure helpers for the commands view (CMD-1 and CMD-2): search, category filter, the scope editor and the
// bodies sent to the server. No DOM access and no imports, so node:test can load this file.

export const GLOBAL_SCOPE = "*";
export const MAX_SCOPES = 500;

/** A WhatsApp group JID, as the server accepts it */
export const GROUP_JID = /^\d{1,32}(-\d{1,32})?@g\.us$/;

/** Commands whose removal can leave a chat unreachable: disabling them needs a warning (translation key) */
export const LOCKOUT_WARNINGS = Object.freeze({ unban: "commands.warn_unban", ban: "commands.warn_ban" });

/** Access labels in display order; a command that declares none is open to everybody */
export const ACCESS_LEVELS = Object.freeze(["owner", "admin", "group", "pm"]);

/** Lower case without accents, so "reglage" finds "Réglage" */
export function fold(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** The query as typed, minus a leading command prefix (".ping" finds ping) and surrounding blanks */
function normalizeQuery(query) {
  return fold(query).trim().replace(/^[^\p{L}\p{N}]+/u, "");
}

/** Does the command match the query on its name, one of its aliases or its description? Empty query: yes. */
export function matchesQuery(command, query) {
  const needle = normalizeQuery(query);
  if (!needle) return true;
  const haystacks = [command.name, ...(command.aliases || []), command.desc];
  return haystacks.some((text) => fold(text).includes(needle));
}

/** Search across name, alias and description (accent- and case-insensitive); keeps the order. */
export function searchCommands(commands, query) {
  return (commands || []).filter((command) => matchesQuery(command, query));
}

/** Category filter: "" (or "all") keeps everything */
export function filterByType(commands, type) {
  if (!type || type === "all") return commands || [];
  return (commands || []).filter((command) => command.type === type);
}

/** Search and category together */
export function filterCommands(commands, { query = "", type = "" } = {}) {
  return filterByType(searchCommands(commands, query), type);
}

/** `["owner", "group"]`: the access levels a command declares, in display order (empty: everybody) */
export function accessLevels(command) {
  const access = command.access || {};
  return ACCESS_LEVELS.filter((level) => access[level]);
}

/**
 * Where a command is switched off: "enabled", "global" (everywhere) or "groups" (in some groups only).
 * `groups` is how many groups have it off.
 */
export function stateOf(command) {
  const groups = (command.disabledGroups || []).length;
  if (command.disabledGlobal) return { state: "global", groups };
  return { state: groups > 0 ? "groups" : "enabled", groups };
}

/** Counts for the header: how many commands are listed, off everywhere, off somewhere */
export function summarize(commands) {
  let offGlobal = 0;
  let offGroups = 0;
  for (const command of commands || []) {
    const { state } = stateOf(command);
    if (state === "global") offGlobal++;
    else if (state === "groups") offGroups++;
  }
  return { total: (commands || []).length, offGlobal, offGroups };
}

// ---------------------------------------------------------------------------
// Scope editor
// ---------------------------------------------------------------------------

/** A group JID typed or pasted by the owner: `{ ok: true, jid }` or `{ ok: false, code }` (a field error code) */
export function parseGroupJid(input) {
  const text = String(input ?? "").trim();
  if (!text) return { ok: false, code: "required" };
  // a bare numeric id is accepted: the suffix is always the same
  const jid = /^\d{1,32}(-\d{1,32})?$/.test(text) ? `${text}@g.us` : text;
  if (!GROUP_JID.test(jid)) return { ok: false, code: "invalid_jid" };
  return { ok: true, jid };
}

/** The editor's starting point: the state the server reports */
export function draftOf(command) {
  return { global: Boolean(command.disabledGlobal), groups: [...(command.disabledGroups || [])].sort() };
}

/**
 * Add a group to the draft. Returns `{ draft, error }`: `error` is a field error `{ code, params? }` (translated as
 * `fields.<code>`) or null; the draft is the same object when nothing changed.
 */
export function addGroup(draft, input) {
  const parsed = parseGroupJid(input);
  if (!parsed.ok) return { draft, error: { code: parsed.code } };
  if (draft.groups.includes(parsed.jid)) return { draft, error: { code: "duplicate" } };
  if (draft.groups.length >= MAX_SCOPES) return { draft, error: { code: "too_many_items", params: { max: MAX_SCOPES } } };
  return { draft: { ...draft, groups: [...draft.groups, parsed.jid].sort() }, error: null };
}

export function removeGroup(draft, jid) {
  return { ...draft, groups: draft.groups.filter((group) => group !== jid) };
}

export function setGlobal(draft, disabled) {
  return { ...draft, global: Boolean(disabled) };
}

/**
 * CMD-2 lists for a draft: scopes to disable (in the draft, not on the server) and scopes to enable (on the
 * server, no longer in the draft). Both empty: nothing to send.
 */
export function diffScopes(command, draft) {
  const was = new Set([...(command.disabledGlobal ? [GLOBAL_SCOPE] : []), ...(command.disabledGroups || [])]);
  const wants = new Set([...(draft.global ? [GLOBAL_SCOPE] : []), ...draft.groups]);
  return {
    disable: [...wants].filter((scope) => !was.has(scope)),
    enable: [...was].filter((scope) => !wants.has(scope)),
  };
}

export const isDirty = (command, draft) => {
  const { disable, enable } = diffScopes(command, draft);
  return disable.length + enable.length > 0;
};

/** The CMD-2 body for a change, or null when there is nothing to send. Empty lists are left out. */
export function toggleBody(change) {
  const body = {};
  if (change.disable && change.disable.length) body.disable = [...change.disable];
  if (change.enable && change.enable.length) body.enable = [...change.enable];
  return Object.keys(body).length ? body : null;
}

/**
 * Translation key of the lockout warning to show before applying `change` to `command`, or null.
 * Only a change that disables something concerns it (enabling can never lock anybody out).
 */
export function lockoutWarning(command, change) {
  if (!change || !change.disable || change.disable.length === 0) return null;
  return LOCKOUT_WARNINGS[command.name] || null;
}

/** Server warnings (CMD-2 `warnings`) as translation keys of the panel */
export function warningKeys(warnings) {
  const known = { unban_disabled: "commands.warn_unban", banchat_disabled: "commands.warn_ban" };
  return (warnings || []).map((warning) => known[warning]).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Orphans
// ---------------------------------------------------------------------------

/** CMD-1 `orphans` ([{ command, scope }]) grouped by command name: [{ command, scopes }] */
export function groupOrphans(orphans) {
  const byCommand = new Map();
  for (const { command, scope } of orphans || []) {
    if (!byCommand.has(command)) byCommand.set(command, []);
    byCommand.get(command).push(scope);
  }
  return [...byCommand]
    .map(([command, scopes]) => ({ command, scopes: scopes.sort() }))
    .sort((a, b) => (a.command < b.command ? -1 : a.command > b.command ? 1 : 0));
}

/** Short label for a group JID: the numeric part, which is what the owner copies around */
export function shortJid(jid) {
  return String(jid ?? "").replace(/@g\.us$/, "");
}
