const { getLang } = require("../lib/utils/language");
const config = require("../config");

/**
 * Pinterest plugin.
 * Pinterest closed its anonymous search (HTTP 403) and no keyless alternative exists,
 * so the command stays registered but only answers "service unavailable" and points
 * to `.image`. No network call is made.
 */

module.exports = {
  command: {
    pattern: "pinterest",
    desc: getLang("plugins.pinterest.desc"),
    type: "search",
  },

  async execute(message) {
    await message.reply(
      `${getLang("common.service_unavailable")}\n\n${getLang("plugins.pinterest.hint", config.PREFIX)}`
    );
  },
};
