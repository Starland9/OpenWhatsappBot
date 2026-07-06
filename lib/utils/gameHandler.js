/**
 * Game Handler
 * Routes non-command group messages to active game handlers
 * (hangman letter guesses, wordle answers, scramble answers, WYR votes)
 */

/**
 * Handle a non-command group message and route to game plugins
 * @param {import('../classes/Message').Message} message
 * @returns {boolean} true if handled by a game
 */
async function handleMessage(message) {
  if (!message.isGroup || !message.body) return false;

  // Lazy-load game plugins to avoid circular require issues at boot
  const plugins = [
    "../../plugins/hangman",
    "../../plugins/wordle",
    "../../plugins/scramble",
    "../../plugins/wyr",
  ];

  for (const pluginPath of plugins) {
    try {
      const plugin = require(pluginPath);
      if (plugin && typeof plugin.handleMessage === "function") {
        const handled = await plugin.handleMessage(message);
        if (handled) return true;
      }
    } catch (_) {
      // Plugin may not exist yet or have other issues — skip
    }
  }

  return false;
}

module.exports = { handleMessage };
