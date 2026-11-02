const { getLang } = require("../utils/language");
const config = require("../../config");
const { getOwnerJids } = require("../utils/permissions");
const commandState = require("../utils/commandState");
const commandPermissions = require("../utils/commandPermissions");
const stats = require("../utils/stats");
const bus = require("../utils/events");
const cooldown = require("../utils/cooldown");

const logger = require("../utils/logger").createLogger("registry");

// Hooks a plugin module may export (contracts/plugin-contract.md)
const HOOK_NAMES = [
  "onMessage",
  "onGroupParticipants",
  "onReady",
  "handleButtonReply",
];

// At most one stack DM to the owners per command in this window (FR-064)
const OWNER_DM_WINDOW_MS = 10 * 60 * 1000;

// At most one info log line per sender and command in this window for a silent refusal (the rest go to
// debug, so a spammer cannot fill the log ring of the panel)
const SILENT_LOG_WINDOW_MS = 60 * 1000;

// Registry state
const commands = []; // CommandEntry, registration order (each command once)
const aliasMap = new Map(); // alias (lower-case, literal) -> CommandEntry
const records = []; // { plugin, file, entry }, load order (commands and hook-only modules)
const recordByPlugin = new Map(); // plugin module -> record
const pluginByFile = new Map(); // "trackmessages" -> plugin module

/**
 * Split a pattern into literal aliases: "gpt|AI| ai" -> ["gpt", "ai"].
 * Backslashes are dropped so a legacy regex-escaped alias ("poll\\+") becomes literal ("poll+").
 */
function parseAliases(pattern) {
  const out = [];
  for (const raw of String(pattern || "").split("|")) {
    const alias = raw.replace(/\\/g, "").trim().toLowerCase();
    if (alias && !out.includes(alias)) out.push(alias);
  }
  return out;
}

function fileLabel(file) {
  return file || "<unknown file>";
}

function baseName(file) {
  return String(file || "").replace(/\.js$/, "");
}

function getRecord(plugin, file) {
  let record = recordByPlugin.get(plugin);
  if (!record) {
    record = { plugin, file: file || null, entry: null };
    recordByPlugin.set(plugin, record);
    records.push(record);
    if (file) {
      const name = baseName(file);
      if (!pluginByFile.has(name)) pluginByFile.set(name, plugin);
    }
  } else if (file && !record.file) {
    record.file = file;
  }
  return record;
}

/**
 * Register a command plugin
 * @param {object} plugin - module exporting `command` and `execute`
 * @param {string} [file] - file name, used in warnings
 * @param {{ descKey?: string|null }} [options] - `descKey`: the language key `command.desc` was read from
 *   (captured by the loader); the entry then translates it at use time (lazy description)
 * @returns {object|null} the CommandEntry
 */
function registerCommand(plugin, file, { descKey = null } = {}) {
  if (!plugin || !plugin.command || typeof plugin.execute !== "function") {
    logger.warn(
      `Invalid plugin ${fileLabel(file)}: missing command or execute function`,
    );
    return null;
  }

  const record = getRecord(plugin, file);
  if (record.entry) return record.entry; // already registered (loadAll called twice)

  const {
    pattern,
    desc = "",
    type = "misc",
    fromMe = false,
    ownerOnly = false,
    onlyGroup = false,
    onlyPm = false,
    adminOnly = false,
    delegable,
    lockReason,
  } = plugin.command;

  const declared = parseAliases(pattern);
  if (declared.length === 0) {
    logger.warn(`Invalid plugin ${fileLabel(record.file)}: missing pattern`);
    return null;
  }

  const aliases = [];
  for (const alias of declared) {
    const owner = aliasMap.get(alias);
    if (owner) {
      logger.warn(
        `Duplicate alias "${alias}": kept by ${fileLabel(owner.file)}, ignored in ${fileLabel(record.file)}`,
      );
      continue;
    }
    aliases.push(alias);
  }

  if (aliases.length === 0) {
    logger.warn(
      `Command "${pattern}" in ${fileLabel(record.file)} is unreachable: every alias is already taken`,
    );
    return null;
  }

  const entry = {
    pattern: aliases.join("|"),
    rawPattern: pattern,
    aliases,
    name: aliases[0],
    descKey: typeof descKey === "string" && descKey ? descKey : null,
    type,
    fromMe: !!fromMe,
    ownerOnly: !!ownerOnly,
    onlyGroup: !!onlyGroup,
    onlyPm: !!onlyPm,
    adminOnly: !!adminOnly,
    // Feature 003: can the panel open this command to other people? An owner-only command is not
    // delegable unless its code says `delegable: true`. `lockReason` (a short code the panel turns into a
    // text) only goes with `delegable: false`; the registry does not check the code's vocabulary.
    delegable: typeof delegable === "boolean" ? delegable : !(fromMe || ownerOnly),
    lockReason:
      delegable === false && typeof lockReason === "string" && lockReason.trim()
        ? lockReason.trim()
        : null,
    execute: plugin.execute,
    plugin,
    file: record.file,
  };

  // `desc` follows the language and the text overrides: translated at each read when it came from a key
  let literalDesc = desc;
  Object.defineProperty(entry, "desc", {
    enumerable: true,
    configurable: true,
    get: () => (entry.descKey ? getLang(entry.descKey) : literalDesc),
    set: (value) => {
      literalDesc = value;
      entry.descKey = null;
    },
  });

  for (const alias of aliases) aliasMap.set(alias, entry);
  commands.push(entry);
  record.entry = entry;

  logger.debug(`Registered command: ${entry.pattern} (${fileLabel(record.file)})`);
  return entry;
}

/**
 * Register a plugin module: its command (if any) and its hooks.
 * Modules exporting neither are skipped.
 * @param {object} plugin
 * @param {string} file - file name (e.g. "ping.js")
 * @param {{ descKey?: string|null }} [options] - see registerCommand
 * @returns {{ registered: boolean, command: object|null, hooks: string[] }}
 */
function registerPlugin(plugin, file, options) {
  if (!plugin || (typeof plugin !== "object" && typeof plugin !== "function")) {
    return { registered: false, command: null, hooks: [] };
  }

  const hooks = HOOK_NAMES.filter((name) => typeof hookFn(plugin, name) === "function");
  const hasCommand = !!plugin.command && typeof plugin.execute === "function";

  if (plugin.command && !hasCommand) {
    logger.warn(`Invalid plugin ${fileLabel(file)}: command without execute function`);
  }
  if (!hasCommand && hooks.length === 0) {
    return { registered: false, command: null, hooks: [] };
  }

  getRecord(plugin, file);
  const command = hasCommand ? registerCommand(plugin, file, options) : null;
  return { registered: true, command, hooks };
}

function hookFn(plugin, name) {
  if (!plugin) return undefined;
  if (name === "handleButtonReply") {
    return typeof plugin.handleButtonReply === "function"
      ? plugin.handleButtonReply
      : plugin.handleReply; // legacy name
  }
  return plugin[name];
}

/**
 * Hooks of every registered plugin, ordered by `plugin.hookPriority[name]`
 * (lower runs first, default 100), then by load order. Observers (tracking,
 * AFK) must run before hooks that consume the message (filters).
 * @param {"onMessage"|"onGroupParticipants"|"onReady"|"handleButtonReply"} name
 * @returns {Array<{ plugin: object, fn: Function, file: string|null }>}
 *   call with `fn.call(plugin, ...args)`
 */
function getHooks(name) {
  const out = [];
  for (const record of records) {
    const fn = hookFn(record.plugin, name);
    if (typeof fn === "function") {
      const priority = Number(record.plugin.hookPriority?.[name]);
      out.push({
        plugin: record.plugin,
        fn,
        file: record.file,
        priority: Number.isFinite(priority) ? priority : 100,
      });
    }
  }
  // Array.prototype.sort is stable: equal priorities keep the load order
  return out.sort((a, b) => a.priority - b.priority);
}

/**
 * Parse "<prefix>cmd args" into { cmdText, argsString, rawArgs }, or null.
 */
function parseCommand(body, prefix = config.PREFIX) {
  if (typeof body !== "string" || !body.startsWith(prefix)) return null;
  const rest = body.slice(prefix.length).replace(/^\s+/, "");
  const match = rest.match(/^\S+/);
  if (!match) return null;
  const word = match[0];
  const after = rest.slice(word.length);
  return {
    cmdText: word.toLowerCase(),
    rawArgs: after.replace(/^\s+/, ""),
    argsString: after.trim().split(/\s+/).filter(Boolean).join(" "),
  };
}

async function safeReply(message, text) {
  try {
    await message.reply(text);
  } catch (error) {
    logger.debug(`Failed to send reply: ${error?.message}`);
  }
}

async function notifyOwners(message, label, error) {
  const owners = getOwnerJids();
  if (owners.length === 0) return;
  let sock;
  try {
    sock = message.client.getSocket();
  } catch (_) {
    return;
  }
  if (!sock || typeof sock.sendMessage !== "function") return;

  let text =
    `⚠️ Error in ${label}\n` +
    `Chat: ${message.jid}\nSender: ${message.sender}\n\n` +
    `${error?.stack || error?.message || String(error)}`;
  if (text.length > 3000) text = `${text.slice(0, 3000)}\n…`;

  for (const owner of owners) {
    try {
      await sock.sendMessage(owner, { text });
    } catch (e) {
      logger.debug(`Failed to forward command error to ${owner}: ${e?.message}`);
    }
  }
}

/**
 * Log a silent refusal (a rule of feature 003 closed the command to this sender): info once per sender
 * and command per minute, debug for the rest.
 */
function logSilentRefusal(message, label, entry, access) {
  try {
    const who = message.sender || message.senderLid || message.jid;
    const first = cooldown.hit(who, `permlog:${entry.name}`, SILENT_LOG_WINDOW_MS) === 0;
    (first ? logger.info : logger.debug).call(
      logger,
      `Silent refusal (command permissions): ${who} -> ${label} [${access.scope}]`,
    );
  } catch (_) {
    // a log line must never turn the silence into an error reply
  }
}

/**
 * Execute a command if the message body matches one exactly.
 * @returns {Promise<boolean>} true when a command matched (even if refused)
 */
async function executeCommand(message) {
  const prefix = config.PREFIX;
  const parsed = parseCommand(message?.body, prefix);
  if (!parsed) return false;

  const entry = aliasMap.get(parsed.cmdText);
  if (!entry) return false;

  const label = `${prefix}${parsed.cmdText}`;

  try {
    // Permissions (contracts/plugin-contract.md, specs/003-command-permissions/contracts/runtime.md 2.2).
    // The banned-chat gate sits in the pipeline. `decide` never throws and answers `normal` for a command
    // that is not delegable or has no rule, which leaves every check below exactly as it was.
    const isOwner = message.isSudo();
    const access = await commandPermissions.decide(entry, message, { isOwner });

    // `only` rule and the sender is not listed: the command is invisible to him. No reply, no reaction,
    // no stats, no bus topic (also when the command is disabled: nothing leaks to him)
    if (access.verdict === commandPermissions.VERDICTS.CLOSED) {
      logSilentRefusal(message, label, entry, access);
      return true;
    }
    const granted = access.verdict === commandPermissions.VERDICTS.GRANTED;

    // A grant opens the owner gate; the owner gate never consults `delegable` (second line of defence)
    if ((entry.fromMe || entry.ownerOnly) && !isOwner && !granted) {
      await safeReply(message, getLang("common.owner_only"));
      return true;
    }

    // Disabled from the admin panel (globally or in this group): owners and granted people are refused
    // too. After the owner gate (owner-only commands stay hidden from others) and before the group/admin
    // checks (no isSenderAdmin() round trip for a refused call). Not counted in the stats.
    if (await commandState.isDisabled(entry, message)) {
      await safeReply(message, getLang("common.command_disabled"));
      return true;
    }

    // The context checks hold for a granted person too: a grant is not a change of place (FR-008)
    if ((entry.onlyGroup || entry.adminOnly) && !message.isGroup) {
      await safeReply(message, getLang("extra.group_cmd"));
      return true;
    }

    if (entry.onlyPm && message.isGroup) {
      await safeReply(message, getLang("common.pm_only"));
      return true;
    }

    // A grant opens the admin gate, before isSenderAdmin() so a granted person costs no metadata lookup (FR-009)
    if (entry.adminOnly && !isOwner && !granted && !(await message.isSenderAdmin())) {
      await safeReply(message, getLang("common.sender_not_admin"));
      return true;
    }

    logger.info(`Invoked command: ${message.sender} -> ${label}`);
    logger.debug(`Arguments for ${label}: ${parsed.argsString}`);

    await entry.execute.call(entry.plugin, message, parsed.argsString, {
      command: parsed.cmdText,
      rawArgs: parsed.rawArgs,
    });
    stats.count("cmd_ok", entry.name);
  } catch (error) {
    if (error?.code === "MEDIA_TOO_LARGE") {
      const maxMB =
        error.maxMB || Math.round((Number(config.MAX_UPLOAD) || 230));
      await safeReply(message, getLang("common.media_too_large", maxMB));
      return true;
    }

    logger.error(
      { err: error },
      `Error executing command ${label} (${fileLabel(entry.file)})`,
    );
    stats.count("cmd_fail", entry.name);
    bus.emitSafe(bus.TOPICS.COMMAND_ERROR, { name: entry.name, at: Date.now() });
    await safeReply(message, getLang("common.error"));
    // One stack DM per command per window (FR-064); the log, the stats and the bus saw every error
    if (cooldown.hit(entry.name, "ownerdm", OWNER_DM_WINDOW_MS) === 0) {
      await notifyOwners(message, `${label} (${fileLabel(entry.file)})`, error);
    }
  }
  return true;
}

/**
 * Get all registered commands (each once), with `aliases`, `plugin` and `file`
 */
function getCommands() {
  return commands.slice();
}

/**
 * Get commands by type
 */
function getCommandsByType(type) {
  return commands.filter((cmd) => cmd.type === type);
}

function lookup(name) {
  if (typeof name !== "string") return null;
  let key = name.trim().toLowerCase();
  if (aliasMap.has(key)) return aliasMap.get(key);
  const prefix = config.PREFIX;
  if (prefix && key.startsWith(prefix)) {
    key = key.slice(prefix.length).trim();
    if (aliasMap.has(key)) return aliasMap.get(key);
  }
  return null;
}

/**
 * Get a command by any of its aliases (exact, case-insensitive)
 */
function getCommandByPattern(pattern) {
  return lookup(pattern);
}

/**
 * Get a plugin module by any command alias, or by file name ("trackmessages")
 */
function getPlugin(name) {
  const entry = lookup(name);
  if (entry) return entry.plugin;
  if (typeof name === "string") {
    return pluginByFile.get(baseName(name.trim())) || null;
  }
  return null;
}

/**
 * Get all registered plugin modules (commands and hook-only), in load order
 */
function getPlugins() {
  return records.map((record) => record.plugin);
}

/**
 * File name a plugin module was loaded from, or null
 */
function getPluginFile(plugin) {
  return recordByPlugin.get(plugin)?.file || null;
}

/**
 * Reset every registry (tests, reload)
 */
function _reset() {
  commands.length = 0;
  aliasMap.clear();
  records.length = 0;
  recordByPlugin.clear();
  pluginByFile.clear();
}

module.exports = {
  registerCommand,
  registerPlugin,
  executeCommand,
  parseCommand,
  getCommands,
  getCommandsByType,
  getCommandByPattern,
  getPlugin,
  getPlugins,
  getPluginFile,
  getHooks,
  parseAliases,
  HOOK_NAMES,
  _reset,
  _pluginsForDispatch: getPlugins,
};
