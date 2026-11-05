const { getLang } = require("../lib/utils/language");
const glyphs = require("../lib/utils/glyphs");

/**
 * Ping command - Check bot latency
 */
module.exports = {
  command: {
    pattern: "ping",
    desc: getLang("plugins.ping.desc"),
    type: "general",
  },

  async execute(message) {
    const start = Date.now();
    const sent = await message.reply(getLang("plugins.ping.ping_sent"));
    const latency = Date.now() - start;
    const pong = getLang("plugins.ping.pong", latency, glyphs.bar(Math.max(0, 1 - latency / 1000), 10));

    // Edit the "Pinging..." message; if WhatsApp refuses the edit, send the result instead
    try {
      await message.client.getSocket().sendMessage(message.jid, {
        text: pong,
        edit: sent.key,
      });
    } catch (err) {
      await message.reply(pong);
    }
  },
};
