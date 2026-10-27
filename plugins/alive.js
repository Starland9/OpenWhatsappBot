const { getLang } = require("../lib/utils/language");
const config = require("../config");
const os = require("os");

const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * Alive command - Show bot status
 */
module.exports = {
  command: {
    pattern: "alive",
    desc: getLang("plugins.alive.desc"),
    type: "general",
  },

  async execute(message) {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const memoryUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const usedMem = totalMem - os.freemem();

    const status = [
      `╭━━━『 *${getLang("plugins.alive.title")}* 』━━━`,
      "│",
      `│ *${getLang("plugins.alive.version")}:* ${config.VERSION}`,
      `│ *${getLang("plugins.alive.uptime")}:* ${getLang("plugins.alive.uptime_value", hours, minutes, seconds)}`,
      `│ *${getLang("plugins.alive.memory")}:* ${getLang(
        "plugins.alive.memory_value",
        (memoryUsage.heapUsed / MB).toFixed(2),
        (memoryUsage.heapTotal / MB).toFixed(2),
      )}`,
      `│ *${getLang("plugins.alive.system")}:* ${getLang(
        "plugins.alive.system_value",
        (usedMem / GB).toFixed(2),
        (totalMem / GB).toFixed(2),
      )}`,
      `│ *${getLang("plugins.alive.platform")}:* ${os.platform()}`,
      `│ *${getLang("plugins.alive.node")}:* ${process.version}`,
      "│",
      "╰━━━━━━━━━━━━━━━━━━━",
      "",
      getLang("plugins.alive.running"),
    ].join("\n");

    await message.reply(status);
  },
};
