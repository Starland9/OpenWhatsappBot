const { getLang } = require("../lib/utils/language");
const config = require("../config");
const { Filter } = require("../lib/database");
const {
  loadFilters,
  invalidateFilters,
  normalizePattern,
} = require("./addfilter");

/**
 * Delete filter plugin
 *   .delfilter <pattern>   → by pattern (case-insensitive)
 *   .delfilter <number>    → by number in `.filter list`
 */

module.exports = {
  command: {
    pattern: "delfilter",
    desc: getLang("plugins.delfilter.desc"),
    type: "admin",
    adminOnly: true,
  },

  async execute(message, argsString, ctx) {
    const raw = String(ctx?.rawArgs ?? argsString ?? "").trim();
    if (!raw) {
      return await message.reply(getLang("plugins.delfilter.usage", config.PREFIX));
    }

    const rows = await loadFilters(message.jid);

    // A number inside the list is an index; any other text is a pattern
    let targets = [];
    if (/^\d{1,4}$/.test(raw)) {
      const index = parseInt(raw, 10);
      if (index >= 1 && index <= rows.length) targets = [rows[index - 1]];
    }
    if (!targets.length) {
      const wanted = normalizePattern(raw);
      targets = rows.filter((row) => normalizePattern(row.pattern) === wanted);
    }

    if (!targets.length) {
      return await message.reply(getLang("plugins.delfilter.not_found", raw, config.PREFIX));
    }

    await Filter.destroy({
      where: { groupJid: message.jid, id: targets.map((row) => row.id) },
    });
    invalidateFilters(message.jid);
    return await message.reply(getLang("plugins.delfilter.deleted", targets[0].pattern));
  },
};
