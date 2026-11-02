const path = require("path");
const { getCommandByPattern, getCommands } = require("../lib/plugins/registry");
const { getLang } = require("../lib/utils/language");
const commandPermissions = require("../lib/utils/commandPermissions");
const config = require("../config");

/**
 * Help command - Display detailed help for a specific command.
 * Also exports the helpers shared with menu.js and buttonmenu.js.
 */

const MAX_USAGE_CHARS = 1200;

/** Owner-only commands (the registry refuses them for everyone else) */
function isOwnerOnly(cmd) {
  return !!(cmd && (cmd.fromMe || cmd.ownerOnly));
}

/** Is the requester an owner (SUDO)? Tolerates a missing message */
function isOwnerMessage(message) {
  return !!(message && message.isSudo && message.isSudo());
}

/**
 * Commands the requester may run or see, in registry order. The verdict is the one execution uses
 * (`commandPermissions.decide`, specs/003-command-permissions): an owner and a person a rule grants see the
 * command; a person an `only` rule closes does not; otherwise today's rule holds, owner-only commands are
 * hidden from non-owners. With no rule (or a failed rule load) this is `owner || !isOwnerOnly(cmd)`.
 */
async function getVisibleCommands(message) {
  const owner = isOwnerMessage(message);
  const { VERDICTS } = commandPermissions;
  const visible = [];
  for (const cmd of getCommands()) {
    const { verdict } = await commandPermissions.decide(cmd, message, { isOwner: owner });
    if (verdict === VERDICTS.CLOSED) continue;
    if (verdict === VERDICTS.NORMAL && isOwnerOnly(cmd)) continue;
    visible.push(cmd);
  }
  return visible;
}

/**
 * The entry behind a name or an alias, unless a rule closes it to the requester (or it does not exist):
 * then `null`, and the caller answers like for an unknown command. Only `closed` hides a command here, never
 * "owner-only": `.help eval` from a member still shows the card (today's behaviour, FR-029).
 */
async function findVisibleCommand(message, name) {
  const cmd = getCommandByPattern(name);
  if (!cmd) return null;
  const owner = isOwnerMessage(message);
  const { verdict } = await commandPermissions.decide(cmd, message, { isOwner: owner });
  return verdict === commandPermissions.VERDICTS.CLOSED ? null : cmd;
}

/** Localized label of a command type; the upper-cased type when there is none */
function typeLabel(type) {
  const key = `plugins.menu.cat_${type}`;
  const label = getLang(key);
  return label !== key ? label : String(type).toUpperCase();
}

/** The first token of the arguments, without the command prefix, lower-case */
function normalizeCommandName(args) {
  const first = String(args || "").trim().split(/\s+/)[0] || "";
  const prefix = config.PREFIX;
  const name = prefix && first.startsWith(prefix) ? first.slice(prefix.length) : first;
  return name.toLowerCase();
}

/**
 * Look for a usage text: `command.usage` (a string exported by the plugin), or a
 * `plugins.<file>.usage` / `plugins.<name>.usage` lang key that only needs the prefix
 */
function getUsage(cmd) {
  const declared = cmd.plugin && cmd.plugin.command && cmd.plugin.command.usage;
  if (typeof declared === "string" && declared.trim()) return declared.trim();

  const candidates = [];
  if (cmd.file) candidates.push(path.basename(cmd.file, ".js"));
  candidates.push(cmd.name, ...(cmd.aliases || []));
  for (const name of new Set(candidates)) {
    const key = `plugins.${name}.usage`;
    const text = getLang(key, config.PREFIX);
    // A leftover {n} means the key needs arguments we don't have: not shown
    if (text !== key && !/\{\d+\}/.test(text)) return text.trim();
  }
  return "";
}

/** Who can run the command, as a localized sentence fragment */
function describeAccess(cmd) {
  const parts = [];
  if (isOwnerOnly(cmd)) parts.push(getLang("plugins.help.access_owner"));
  else if (cmd.adminOnly) parts.push(getLang("plugins.help.access_admin"));
  if (cmd.onlyGroup && !cmd.adminOnly) parts.push(getLang("plugins.help.access_group"));
  if (cmd.onlyPm) parts.push(getLang("plugins.help.access_pm"));
  return parts.length ? parts.join(", ") : getLang("plugins.help.access_everyone");
}

/** The localized help card of one registry entry */
function formatCommandInfo(cmd) {
  const prefix = config.PREFIX;
  const aliases = (cmd.aliases || []).slice(1).map((a) => `${prefix}${a}`);

  const lines = [
    `╭━━━『 *${getLang("plugins.help.title")}* 』━━━`,
    "│",
    `│ *${getLang("plugins.help.label_command")}:* ${prefix}${cmd.name}`,
  ];
  if (aliases.length) {
    lines.push(`│ *${getLang("plugins.help.label_aliases")}:* ${aliases.join(", ")}`);
  }
  lines.push(
    `│ *${getLang("plugins.help.label_description")}:* ${cmd.desc || getLang("plugins.help.no_description")}`,
    `│ *${getLang("plugins.help.label_category")}:* ${typeLabel(cmd.type)}`,
    `│ *${getLang("plugins.help.label_access")}:* ${describeAccess(cmd)}`,
    "│",
    "╰━━━━━━━━━━━━━━━━━━━",
  );

  let text = lines.join("\n");
  const usage = getUsage(cmd);
  if (usage) {
    const shown =
      usage.length > MAX_USAGE_CHARS ? `${usage.slice(0, MAX_USAGE_CHARS)}…` : usage;
    text += `\n\n${getLang("common.usage_prefix")}\n${shown}`;
  }
  return text;
}

module.exports = {
  command: {
    pattern: "help",
    desc: getLang("plugins.help.desc"),
    type: "general",
  },

  async execute(message, args) {
    const name = normalizeCommandName(args);

    // No command given: short guide
    if (!name) {
      await message.reply(getLang("plugins.help.guide", config.PREFIX));
      return;
    }

    const command = await findVisibleCommand(message, name);
    if (!command) {
      await message.reply(getLang("plugins.help.not_found", name, config.PREFIX));
      return;
    }

    await message.reply(formatCommandInfo(command));
  },

  // Shared with menu.js and buttonmenu.js
  findVisibleCommand,
  formatCommandInfo,
  getVisibleCommands,
  isOwnerOnly,
  typeLabel,
};
