const { getLang } = require("../lib/utils/language");

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

    await message.client.getSocket().sendMessage(message.jid, {
      text: getLang("plugins.ping.pong", latency),
      edit: sent.key,
    });
  },
};
