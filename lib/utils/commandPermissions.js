"use strict";

/**
 * Command permissions: who may use a command beyond or instead of its normal level
 * (specs/003-command-permissions: contracts/runtime.md section 1, data-model section 2).
 *
 * A `permission_rules(command, scope)` row names a mode and a list of people:
 *   - `extra`: the command keeps its normal level, and the people listed may also use it;
 *   - `only`: only the people listed (and the owners) may use it, everybody else is ignored in silence.
 * `command` is the registry entry's `name` (first alias, lower case); `scope` is "*" (every group and
 * private chats) or a group JID. The panel is the only writer and calls `invalidate()` after each write;
 * this module has no write function.
 *
 * `decide(entry, message)` answers one of four verdicts (FR-006, steps 2 to 5; the banned-chat gate of
 * step 1 stays in the pipeline, the disabled state is checked by the registry afterwards):
 *   - `owner`: the sender is a SUDO owner, the rules never restrict him;
 *   - `granted`: listed in the global rule or in the rule of this group (the global rule is tested first);
 *   - `closed`: the deciding rule is `only` and the sender is not listed: refuse in silence;
 *   - `normal`: today's checks apply unchanged (also an `extra` rule that does not list the sender).
 * The group rule beats the global one for everybody who is not listed, whatever its mode or list, so an
 * empty group `extra` rule restores the normal level in one group despite an everywhere `only` rule.
 *
 * Owner-only safety (FR-014, SC-003): an entry whose `delegable` is not exactly `true` gets `normal`
 * BEFORE the cache is read, so a rule on `.eval` (a restored backup, a hand-made row) is never even loaded
 * into a decision. `decide` never throws and fails open (FR-011): any error gives `normal` and a failed
 * load keeps the last known state, else an empty one; owner-only commands then stay owner-only.
 *
 * One `settingsCache` key, `command_perms`, holds the whole table (one `findAll`, 5-minute TTL):
 * `{ byCommand: Map<name, { global: Rule|null, groups: Map<groupJid, Rule> }> }` with
 * `Rule = { mode, members: Set<normalizedJid> }`; `members` holds both the phone-number JID and the LID
 * of every person, so a listed sender is found with at most two `Set.has` and no await.
 */

const { PermissionRule } = require("../database");
const settingsCache = require("./settingsCache");
const { normalizeJid, isPnJid, isLidJid, identitiesOf } = require("./permissions");
const { createLogger } = require("./logger");

const logger = createLogger("commandPermissions");

const CACHE_KEY = "command_perms";
const TTL_MS = 5 * 60 * 1000;
const GLOBAL_SCOPE = "*";
const MAX_PEOPLE = 100; // enforced by the model and the panel; the loader applies no cap

/** The stored `mode` values (the model repeats the literals, a test pins that they are equal). */
const MODES = Object.freeze({ EXTRA: "extra", ONLY: "only" });
const VERDICTS = Object.freeze({ OWNER: "owner", GRANTED: "granted", CLOSED: "closed", NORMAL: "normal" });

const SCOPE_GLOBAL = "global";
const SCOPE_GROUP = "group";

// ---------------------------------------------------------------------------
// Results: shared frozen { verdict, scope, mode } objects (callers never mutate them)
// ---------------------------------------------------------------------------

const accesses = new Map();

function access(verdict, scope = null, mode = null) {
  const key = `${verdict}|${scope}|${mode}`;
  let result = accesses.get(key);
  if (!result) {
    result = Object.freeze({ verdict, scope, mode });
    accesses.set(key, result);
  }
  return result;
}

const OWNER_ACCESS = access(VERDICTS.OWNER);
const NORMAL_ACCESS = access(VERDICTS.NORMAL);

// ---------------------------------------------------------------------------
// Cache and loader
// ---------------------------------------------------------------------------

const emptyState = () => ({ byCommand: new Map() });

/** The `people` of a row as an array: model instances give one, a JSON string is parsed defensively */
function peopleList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Normalized PN and LID of every usable person; `dropped.count` counts the ones that were not */
function membersOf(people, dropped) {
  const members = new Set();
  for (const element of people) {
    let added = 0;
    if (element && typeof element === "object" && !Array.isArray(element)) {
      for (const form of [element.pn, element.lid]) {
        const jid = typeof form === "string" ? normalizeJid(form) : "";
        if (jid) {
          members.add(jid);
          added += 1;
        }
      }
    }
    if (added === 0) dropped.count += 1;
  }
  return members;
}

/**
 * Read the whole table. Model instances, never `raw: true` (on SQLite a JSON column comes back as a
 * string with raw). Rows the engine cannot apply are skipped (a rule is never half-applied; the panel
 * still lists the stored row) and reported once per load. `delegable` is not applied here: the registry
 * may not be loaded yet, `decide` tests the live entry. A database error propagates so that nothing is
 * cached and the next message retries.
 */
async function load() {
  const rows = await PermissionRule.findAll();
  const state = emptyState();
  const skipped = { rows: 0 };
  const dropped = { count: 0 };

  for (const row of rows) {
    const command = String(row.command ?? "").trim().toLowerCase();
    const mode = row.mode;
    if (!command || (mode !== MODES.EXTRA && mode !== MODES.ONLY)) {
      skipped.rows += 1;
      continue;
    }

    let groupJid = null;
    if (row.scope !== GLOBAL_SCOPE) {
      groupJid = typeof row.scope === "string" ? normalizeJid(row.scope) : "";
      if (!groupJid.endsWith("@g.us")) {
        skipped.rows += 1;
        continue;
      }
    }

    const people = peopleList(row.people);
    if (!people) {
      skipped.rows += 1;
      continue;
    }

    const rule = { mode, members: membersOf(people, dropped) };
    let rules = state.byCommand.get(command);
    if (!rules) {
      rules = { global: null, groups: new Map() };
      state.byCommand.set(command, rules);
    }
    if (groupJid === null) rules.global = rule;
    else rules.groups.set(groupJid, rule); // two rows colliding after normalization: the last one read wins
  }

  if (skipped.rows > 0 || dropped.count > 0) {
    logger.warn(`permission rules: ${skipped.rows} row(s) skipped, ${dropped.count} person(s) dropped (unreadable)`);
  }
  return state;
}

/** The cached state, or an empty one (fail-open) when the load failed and nothing was cached before */
async function getState() {
  const state = await settingsCache.getOrLoad(CACHE_KEY, load, TTL_MS);
  return state || emptyState();
}

/** Drop the cached state (after every panel write; restore and restart clear the whole cache) */
function invalidate() {
  settingsCache.invalidate(CACHE_KEY);
}

// ---------------------------------------------------------------------------
// Identity (FR-004)
// ---------------------------------------------------------------------------

/** The sender's own normalized ids: the phone-number JID and/or the LID, without duplicates */
function ownIds(message) {
  const ids = [];
  for (const jid of [message.sender, message.senderLid]) {
    const id = normalizeJid(jid);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function listedIn(rule, ids) {
  if (!rule || rule.members.size === 0) return false;
  for (const id of ids) if (rule.members.has(id)) return true;
  return false;
}

/** The rule that lists the sender, the global one first; `null` when none does */
function matchRule(globalRule, groupRule, ids) {
  if (listedIn(globalRule, ids)) return { scope: SCOPE_GLOBAL, mode: globalRule.mode };
  if (listedIn(groupRule, ids)) return { scope: SCOPE_GROUP, mode: groupRule.mode };
  return null;
}

/**
 * Worth resolving the other namespace? Only when a rule that applies here names somebody and the sender
 * is known by one namespace only (a message carrying both forms is matched by the fast path alone).
 */
function needsExpansion(globalRule, groupRule, ids) {
  if (ids.length === 0) return false;
  if (!(globalRule?.members.size > 0) && !(groupRule?.members.size > 0)) return false;
  return !(ids.some(isPnJid) && ids.some(isLidJid));
}

// Resolved identities per message: the menu evaluates about 80 commands for one message and `Message` is
// not modified. The promise never rejects: on any failure the set is the sender's own ids.
const expansions = new WeakMap();

function expandedIdentities(message, ids) {
  let pending = expansions.get(message);
  if (!pending) {
    pending = (async () => {
      const resolved = new Set(ids);
      try {
        const metadata =
          message.isGroup && typeof message.getGroupMetadata === "function"
            ? await message.getGroupMetadata()
            : null;
        for (const id of ids) {
          for (const form of await identitiesOf(message, id, metadata)) resolved.add(form);
        }
      } catch (err) {
        logger.debug(`identity resolution failed, the sender's own ids only: ${err?.message}`);
      }
      return resolved;
    })();
    expansions.set(message, pending);
  }
  return pending;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * May this sender use this command here? Never rejects (a failure gives the normal verdict).
 *
 * @param {{ name?: string, delegable?: boolean }} entry registry entry
 * @param {object} message a `Message` (sender, senderLid, isGroup, jid, isSudo, getGroupMetadata)
 * @param {{ isOwner?: boolean }} [options] `isOwner`: the caller already knows (the registry), else `message.isSudo()`
 * @returns {Promise<Readonly<{ verdict: "owner"|"granted"|"closed"|"normal", scope: "global"|"group"|null, mode: "extra"|"only"|null }>>}
 */
async function decide(entry, message, options) {
  try {
    const { isOwner } = options || {};

    // 1. owners are never restricted (before any data is read)
    if (isOwner === undefined ? message.isSudo() : isOwner) return OWNER_ACCESS;

    // 2. only a command that is explicitly delegable can have rules (FR-014, SC-003): before the cache
    if (!entry || entry.delegable !== true) return NORMAL_ACCESS;

    // 3. the rules of this command that apply here
    const rules = (await getState()).byCommand.get(entry.name);
    if (!rules) return NORMAL_ACCESS;
    const globalRule = rules.global;
    const groupRule = message.isGroup ? rules.groups.get(message.jid) || null : null;
    if (!globalRule && !groupRule) return NORMAL_ACCESS;

    // 4. listed in the global rule, then in the rule of this group: a personal pass
    const ids = ownIds(message);
    let match = matchRule(globalRule, groupRule, ids);
    if (!match && needsExpansion(globalRule, groupRule, ids)) {
      match = matchRule(globalRule, groupRule, await expandedIdentities(message, ids));
    }
    if (match) return access(VERDICTS.GRANTED, match.scope, match.mode);

    // 5. nobody named him: the group rule wins as soon as it exists, whatever its mode or list
    const scope = groupRule ? SCOPE_GROUP : SCOPE_GLOBAL;
    const deciding = groupRule || globalRule;
    return deciding.mode === MODES.ONLY
      ? access(VERDICTS.CLOSED, scope, MODES.ONLY)
      : access(VERDICTS.NORMAL, scope, MODES.EXTRA);
  } catch (err) {
    logger.warn({ err: err?.message }, "command permission check failed, the normal level applies");
    return NORMAL_ACCESS;
  }
}

module.exports = {
  decide,
  invalidate,
  CACHE_KEY,
  GLOBAL_SCOPE,
  MODES,
  MAX_PEOPLE,
  VERDICTS,
};
