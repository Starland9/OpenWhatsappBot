const { getLang } = require("../lib/utils/language");
const glyphs = require("../lib/utils/glyphs");

/**
 * Terminal de commandes système simulé.
 *   .term              → liste des commandes
 *   .term <commande>   → sortie simulée (whoami, ls, ps, netstat, uname, uptime, cat, sudo)
 */

const MAX_ARG = 40;

const COMMANDS = ["whoami", "ls", "ps", "netstat", "uname", "uptime", "cat", "sudo"];

function output(command, arg) {
  const random = glyphs.rng(`${command}:${arg}:${Date.now()}`);
  switch (command) {
    case "whoami":
      return [getLang("plugins.term.whoami_user"), getLang("plugins.term.whoami_groups")];
    case "ls":
      return [getLang("plugins.term.ls_line", random.int(3, 9))];
    case "ps":
      return Array.from({ length: random.int(3, 6) }, (_, i) =>
        getLang("plugins.term.ps_line", 100 + i, random.int(1, 99), random.pick(["node", "sshd", "cron", "baileys", "watchdog"])),
      );
    case "netstat":
      return Array.from({ length: random.int(2, 5) }, () =>
        getLang("plugins.term.netstat_line", random.pick([22, 80, 443, 8080]), random.pick(["LISTEN", "ESTABLISHED", "TIME_WAIT"])),
      );
    case "uname":
      return [getLang("plugins.term.uname_line")];
    case "uptime":
      return [getLang("plugins.term.uptime_line", random.int(1, 400), random.int(0, 23))];
    case "cat":
      return arg ? [getLang("plugins.term.cat_line", arg)] : [getLang("plugins.term.cat_usage")];
    case "sudo":
      return [getLang("plugins.term.sudo_line")];
    default:
      return null;
  }
}

module.exports = {
  command: {
    pattern: "term|shell|console",
    desc: getLang("plugins.term.desc"),
    type: "dark",
  },

  async execute(message, argsString) {
    const [command = "", ...rest] = String(argsString || "").trim().split(/\s+/);
    const name = command.toLowerCase();

    if (!name) {
      const list = COMMANDS.map((c) => `  ▸ ${c}`).join("\n");
      return await message.reply(getLang("plugins.term.list", list));
    }

    const lines = output(name, rest.join(" ").slice(0, MAX_ARG));
    if (!lines) return await message.reply(getLang("plugins.term.unknown", COMMANDS.join(", ")));

    const prompt = getLang("plugins.term.prompt", name);
    await message.reply(`\`\`\`\n${prompt}\n${lines.join("\n")}\n\`\`\``);
  },

  COMMANDS,
};
