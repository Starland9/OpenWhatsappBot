"use strict";

/**
 * Commands service (admin-http-api.md 2.6, CMD-1 and CMD-2): the loaded commands with their access level and
 * their disabled scopes, and the set-based enable/disable of one command. Never touches `req`/`res`; the HTTP
 * layer is lib/admin/routes/commands.js.
 *
 *   const commands = createCommandsService(deps);
 *   await commands.list()                                   -> { commands, types, orphans }      (CMD-1)
 *   await commands.toggle(name, { disable, enable }, opts)  -> { name, disabledGlobal, disabledGroups, warnings, changes }
 *
 * The engines (lib/plugins/registry.js, lib/utils/commandState.js) are resolved lazily as `deps.registry` /
 * `deps.commandState`, so a test can inject a fake and a module that is not loaded yet does not break loading.
 *
 * Errors are `AdminError`s of the envelope: `not_found` (`resource: command`) for an unknown name, and
 * `validation_failed` with field codes for a bad scope list (a scope in both lists, more than 500 scopes,
 * nothing to do). This module never audits: the route writes one `command.toggle` row per entry of `changes`.
 */

const { AdminError } = require("../http/response");

const GLOBAL_SCOPE = "*";
const MAX_SCOPES = 500;

/** The access level a command declares, as the registry enforces it */
function accessOf(entry) {
  return {
    owner: Boolean(entry.fromMe || entry.ownerOnly),
    admin: Boolean(entry.adminOnly),
    group: Boolean(entry.onlyGroup || entry.adminOnly), // admin commands need a group too
    pm: Boolean(entry.onlyPm),
  };
}

const unique = (list) => [...new Set(Array.isArray(list) ? list : [])];

/**
 * Translate an error of commandState.toggle into the envelope; anything else is rethrown as it is.
 * @param {Error & { code?: string, params?: object }} err
 */
function toEnvelope(err) {
  if (!err || typeof err.code !== "string") return err;
  switch (err.code) {
    case "invalid_command":
      return new AdminError("not_found", { params: { resource: "command" }, cause: err });
    case "invalid_scope":
      return new AdminError("validation_failed", {
        fields: { disable: { code: "invalid_format" }, enable: { code: "invalid_format" } },
        cause: err,
      });
    case "invalid_format": // a scope in both lists
      return new AdminError("validation_failed", {
        fields: { disable: { code: "invalid_format" }, enable: { code: "invalid_format" } },
        cause: err,
      });
    case "too_many_scopes":
      return new AdminError("validation_failed", {
        fields: { disable: { code: "too_many_items", params: { max: MAX_SCOPES } } },
        cause: err,
      });
    default:
      return err;
  }
}

function createCommandsService(deps = {}) {
  const registry = () => deps.registry || require("../../plugins/registry");
  const commandState = () => deps.commandState || require("../../utils/commandState");

  const loaded = () => registry().getCommands();

  /** snapshot() with the orphans computed against the commands loaded right now */
  const snapshot = () => commandState().snapshot({ commands: loaded().map((entry) => entry.name) });

  /**
   * CMD-1.
   * @returns {Promise<{ commands: object[], types: string[], orphans: { command: string, scope: string }[] }>}
   */
  async function list() {
    const state = await snapshot();
    const global = new Set(state.global);
    const groupsOf = new Map(); // command -> group JIDs
    for (const [jid, names] of Object.entries(state.byGroup)) {
      for (const name of names) {
        if (!groupsOf.has(name)) groupsOf.set(name, []);
        groupsOf.get(name).push(jid);
      }
    }

    const entries = loaded().map((entry) => ({
      name: entry.name,
      aliases: entry.aliases.slice(),
      type: entry.type,
      desc: entry.desc, // the effective text: overrides and the bot language included
      access: accessOf(entry),
      disabledGlobal: global.has(entry.name),
      disabledGroups: (groupsOf.get(entry.name) || []).sort(),
    }));
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    return {
      commands: entries,
      types: [...new Set(entries.map((entry) => entry.type))].sort(),
      orphans: state.orphanRows || [],
    };
  }

  /**
   * CMD-2: disable `name` in `disable` scopes and enable it in `enable` scopes ("*" or group JIDs), idempotently.
   * An unknown name is `not_found`, except an orphan row (its command no longer exists) that is only being enabled.
   *
   * @param {string} name registry entry name (first alias)
   * @param {{ disable?: string[], enable?: string[] }} lists
   * @param {{ actor?: string }} [options]
   * @returns {Promise<{ name: string, disabledGlobal: boolean, disabledGroups: string[], warnings: string[],
   *   changes: { scope: string, disabled: boolean }[] }>} `changes`: the scopes whose state really changed
   * @throws {AdminError}
   */
  async function toggle(name, { disable = [], enable = [] } = {}, { actor } = {}) {
    const disableScopes = unique(disable);
    const enableScopes = unique(enable);
    if (disableScopes.length === 0 && enableScopes.length === 0) {
      throw new AdminError("validation_failed", {
        fields: { disable: { code: "required" }, enable: { code: "required" } },
      });
    }

    const before = await snapshot();
    const known = loaded().some((entry) => entry.name === name);
    const orphan = before.orphans.includes(name);
    if (!known && !(orphan && disableScopes.length === 0)) {
      throw new AdminError("not_found", { params: { resource: "command" } });
    }

    const wasDisabled = new Set([
      ...(before.global.includes(name) ? [GLOBAL_SCOPE] : []),
      ...Object.entries(before.byGroup)
        .filter(([, names]) => names.includes(name))
        .map(([jid]) => jid),
    ]);

    let result;
    try {
      result = await commandState().toggle(name, { disable: disableScopes, enable: enableScopes }, { actor });
    } catch (err) {
      throw toEnvelope(err);
    }

    const changes = [
      ...disableScopes.filter((scope) => !wasDisabled.has(scope)).map((scope) => ({ scope, disabled: true })),
      ...enableScopes.filter((scope) => wasDisabled.has(scope)).map((scope) => ({ scope, disabled: false })),
    ];
    return { name, ...result, changes };
  }

  return { list, toggle };
}

module.exports = { createCommandsService, accessOf, MAX_SCOPES };
