/**
 * Ping command - Check bot latency
 */
module.exports = {
  command: {
    pattern: "ping",
    desc: "Check bot latency",
    type: "general",
  },

  async execute(message) {
    const start = Date.now();
    const sent = await message.reply("Pinging...");
    const latency = Date.now() - start;

    await message.client.getSocket().sendMessage(message.jid, {
      text: `🏓 Pong!\nLatency: ${latency}ms`,
      edit: sent.key,
    });
  },
};
