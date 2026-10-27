const { Op, fn, col } = require("sequelize");
const { UserStats } = require("../lib/database");
const { getLang } = require("../lib/utils/language");
const config = require("../config");

/**
 * Group statistics, read from the UserStats rows kept by `trackmessages`
 * (messages, media and commands per member). Nothing is stored in memory.
 */

const TOP_SIZE = 10;

const tag = (jid) => `@${String(jid).split("@")[0]}`;

async function showSummary(message) {
  const groupJid = message.jid;
  const where = { groupJid, messageCount: { [Op.gt]: 0 } };

  const totals = await UserStats.findOne({
    attributes: [
      [fn("SUM", col("messageCount")), "messages"],
      [fn("SUM", col("mediaCount")), "media"],
      [fn("SUM", col("commandCount")), "commands"],
      [fn("COUNT", col("jid")), "members"],
    ],
    where,
    raw: true,
  });
  const members = Number(totals && totals.members) || 0;
  if (members === 0) return await message.reply(getLang("plugins.stats.no_data"));

  const top = await UserStats.findAll({
    where,
    order: [
      ["messageCount", "DESC"],
      ["jid", "ASC"],
    ],
    limit: TOP_SIZE,
  });

  const lines = top
    .map((r, i) =>
      getLang(
        "plugins.stats.top_line",
        i + 1,
        tag(r.jid),
        r.messageCount || 0,
        r.mediaCount || 0,
        r.commandCount || 0,
      ),
    )
    .join("\n");

  const text = getLang(
    "plugins.stats.summary",
    Number(totals.messages) || 0,
    Number(totals.media) || 0,
    Number(totals.commands) || 0,
    members,
    lines,
  );
  return await message.reply(text, { mentions: top.map((r) => r.jid) });
}

async function resetStats(message) {
  const allowed = message.isSudo() || (await message.isSenderAdmin());
  if (!allowed) return await message.reply(getLang("common.sender_not_admin"));

  // Rows are kept (the tracker knows them) and set back to zero
  const [affected] = await UserStats.update(
    { messageCount: 0, commandCount: 0, mediaCount: 0, xp: 0, level: 0 },
    { where: { groupJid: message.jid } },
  );
  return await message.reply(getLang("plugins.stats.reset", affected));
}

module.exports = {
  command: {
    pattern: "stats",
    desc: getLang("plugins.stats.desc"),
    type: "group",
    onlyGroup: true,
  },

  async execute(message, argsString) {
    const action = String(argsString || "").trim().toLowerCase();

    if (action === "" || action === "summary" || action === "messages") {
      return await showSummary(message);
    }
    if (action === "reset") return await resetStats(message);
    return await message.reply(getLang("plugins.stats.usage", config.PREFIX));
  },
};
