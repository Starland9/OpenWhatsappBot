"use strict";

/**
 * Command state: commands disabled globally or in one group
 * (specs/002-admin-panel: contracts/runtime.md section 5, data-model 1.5).
 *
 * A `command_states(command, scope)` row means "disabled"; re-enabling deletes the row (the
 * history lives in the audit log, written by the callers). `command` is the registry entry's
 * `name` (first alias, lower case); `scope` is "*" (everywhere) or a group JID.
 *
 * One `settingsCache` key, `command_state`, holds `{ global: Set<name>, byGroup: Map<jid, Set<name>> }`
 * (one `findAll`, 5-minute TTL). Every setter invalidates it; restore and restart call
 * `invalidate()`. Fail-open: when the load fails, nothing is disabled.
 *
 * Semantics (FR-026, FR-027): disabled iff `global.has(name) || (message.isGroup && byGroup.get(message.jid)?.has(name))`,
 * so a global row wins over group rows.
 *
 * Errors are `Error`s with a stable `code`: `invalid_command`, `invalid_scope`, `invalid_format`
 * (a scope in both lists of `toggle`), `too_many_scopes` (`params: { max }`). The HTTP layer maps
 * them; messages are for logs only. This module never audits: callers do.
 */

const { CommandState } = require("../database");
const settingsCache = require("./settingsCache");
const { normalizeJid } = require("./permissions");
const { createLogger } = require("./logger");

const logger = createLogger("commandState");

const CACHE_KEY = "command_state";
const TTL_MS = 5 * 60 * 1000;
const GLOBAL_SCOPE = "*";
const NAME_MAX = 64;
const MAX_SCOPES = 500;

/** Commands whose removal can leave a chat unreachable: disabling them warns */
const LOCKOUT_WARNINGS = Object.freeze({ unban: "unban_disabled", ban: "banchat_disabled" });

function stateError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const emptyState = () => ({ global: new Set(), byGroup: new Map() });

async function load() {
  const rows = await CommandState.findAll({ attributes: ["command", "scope"], raw: true });
  const state = emptyState();
  for (const { command, scope } of rows) {
    if (scope === GLOBAL_SCOPE) {
      state.global.add(command);
      continue;
    }
    if (!state.byGroup.has(scope)) state.byGroup.set(scope, new Set());
    state.byGroup.get(scope).add(command);
  }
  return state;
}

/** The cached state, or an empty one (fail-open) when the load failed */
async function getState() {
  const state = await settingsCache.getOrLoad(CACHE_KEY, load, TTL_MS);
  return state || emptyState();
}

/** Drop the cached state (restore, in-process restart) */
function invalidate() {
  settingsCache.invalidate(CACHE_KEY);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Is this command disabled for this message? Never throws (a failure disables nothing).
 * @param {{ name: string }} entry registry entry
 * @param {{ isGroup?: boolean, jid?: string }} message
 * @returns {Promise<boolean>}
 */
async function isDisabled(entry, message) {
  try {
    const name = entry?.name;
    if (!name) return false;
    const state = await getState();
    if (state.global.has(name)) return true;
    return Boolean(message?.isGroup && state.byGroup.get(message.jid)?.has(name));
  } catch (err) {
    logger.warn({ err: err?.message }, "command state check failed, nothing disabled");
    return false;
  }
}

/** Names of the commands currently loaded in the registry (empty when it is not loaded) */
function registryNames() {
  try {
    return require("../plugins/registry").getCommands().map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Everything that is disabled, plus the orphans (rows whose command no longer exists, for
 * instance after a changed first alias). Orphans are only computed when the set of known
 * command names is available: injected through `commands`, else the loaded registry.
 *
 * `orphans` holds the distinct orphan command names; `orphanRows` the `{ command, scope }`
 * rows (what GET /admin/api/commands lists).
 *
 * @param {{ commands?: Iterable<string> }} [options]
 * @returns {Promise<{ global: string[], byGroup: Object<string, string[]>, orphans: string[], orphanRows: { command: string, scope: string }[] }>}
 */
async function snapshot({ commands } = {}) {
  const state = await getState();
  const known = new Set(commands ? [...commands] : registryNames());

  const result = { global: [...state.global].sort(), byGroup: {}, orphans: [], orphanRows: [] };
  for (const [jid, names] of [...state.byGroup].sort(([a], [b]) => a.localeCompare(b))) {
    result.byGroup[jid] = [...names].sort();
  }

  if (known.size > 0) {
    const rows = [
      ...result.global.map((command) => ({ command, scope: GLOBAL_SCOPE })),
      ...Object.entries(result.byGroup).flatMap(([scope, names]) => names.map((command) => ({ command, scope }))),
    ];
    result.orphanRows = rows.filter((row) => !known.has(row.command));
    result.orphans = [...new Set(result.orphanRows.map((row) => row.command))].sort();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function normalizeName(name) {
  const value = typeof name === "string" ? name.trim().toLowerCase() : "";
  if (!value || value.length > NAME_MAX || /\s/.test(value)) {
    throw stateError("invalid_command", "invalid command name");
  }
  return value;
}

/** "*" or a normalized group JID */
function normalizeScope(scope) {
  if (scope === GLOBAL_SCOPE) return GLOBAL_SCOPE;
  const jid = normalizeJid(typeof scope === "string" ? scope : "");
  if (!jid.endsWith("@g.us") || jid.length > 255) throw stateError("invalid_scope", "scope must be * or a group JID");
  return jid;
}

/**
 * Disable `name` in `disableScopes` and enable it in `enableScopes` (both already normalized).
 * Idempotent: a row that exists is kept as it is, a row that does not exist is not an error.
 */
async function write(name, disableScopes, enableScopes) {
  if (disableScopes.length > 0) {
    await CommandState.bulkCreate(
      disableScopes.map((scope) => ({ command: name, scope })),
      { ignoreDuplicates: true },
    );
  }
  if (enableScopes.length > 0) {
    await CommandState.destroy({ where: { command: name, scope: enableScopes } });
  }
  invalidate();
}

/**
 * Disable or enable one command in one scope.
 * @param {string} name registry entry name (first alias); an orphan name is accepted so it can be enabled
 * @param {string} scope "*" or a group JID
 * @param {boolean} disabled true = disable (create the row), false = enable (delete the row)
 * @param {{ actor?: string }} [options] who asked, for the log line only
 * @returns {Promise<void>}
 */
async function set(name, scope, disabled, { actor } = {}) {
  const command = normalizeName(name);
  const target = normalizeScope(scope);
  await (disabled ? write(command, [target], []) : write(command, [], [target]));
  logger.info({ command, scope: target, disabled: Boolean(disabled), actor }, "command state changed");
}

/**
 * Apply two lists of scopes to one command, then report where it is disabled. Shared by
 * CMD-2 (any scopes) and GRP-17 (one group per call), so both have one implementation.
 * Idempotent and set-based: two tabs cannot clobber each other.
 *
 * @param {string} name
 * @param {{ disable?: string[], enable?: string[] }} lists scopes ("*" or group JIDs)
 * @param {{ actor?: string }} [options]
 * @returns {Promise<{ disabledGlobal: boolean, disabledGroups: string[], warnings: string[] }>}
 *   `warnings` holds `unban_disabled` / `banchat_disabled` when this call disabled `unban` / `ban`
 */
async function toggle(name, { disable = [], enable = [] } = {}, { actor } = {}) {
  const command = normalizeName(name);
  const disableScopes = [...new Set([].concat(disable).map(normalizeScope))];
  const enableScopes = [...new Set([].concat(enable).map(normalizeScope))];

  if (disableScopes.some((scope) => enableScopes.includes(scope))) {
    throw stateError("invalid_format", "a scope cannot be in both lists");
  }
  if (disableScopes.length + enableScopes.length > MAX_SCOPES) {
    throw stateError("too_many_scopes", `at most ${MAX_SCOPES} scopes`, { params: { max: MAX_SCOPES } });
  }

  await write(command, disableScopes, enableScopes);
  logger.info({ command, disable: disableScopes.length, enable: enableScopes.length, actor }, "command state toggled");

  const state = await CommandState.findAll({ where: { command }, attributes: ["scope"], raw: true });
  const warnings = disableScopes.length > 0 && LOCKOUT_WARNINGS[command] ? [LOCKOUT_WARNINGS[command]] : [];
  return {
    disabledGlobal: state.some((row) => row.scope === GLOBAL_SCOPE),
    disabledGroups: state.map((row) => row.scope).filter((scope) => scope !== GLOBAL_SCOPE).sort(),
    warnings,
  };
}

module.exports = {
  CACHE_KEY,
  GLOBAL_SCOPE,
  MAX_SCOPES,
  isDisabled,
  set,
  toggle,
  snapshot,
  invalidate,
};
