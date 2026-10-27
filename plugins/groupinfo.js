const { getLang } = require("../lib/utils/language");
const config = require("../config");
const { UserStats } = require("../lib/database");
const { sendQuickReplies } = require("./buttons");
const { jidUser } = require("../lib/utils/permissions");
const { safeLog } = require("../lib/utils/http");

/**
 * Group statistics dashboard, built on UserStats (see trackmessages.js).
 *   .groupinfo          → overview (totals, most active member, highest XP)
 *   .groupinfo top      → top 5 by messages   (button `ginfo:top`)
 *   .groupinfo xp       → top 5 by XP         (button `ginfo:xp`)
 */

const TOP_SIZE = 5;
const TOP_ARGS = new Set(["top", "detail", "top5"]);
const tag = (jid) => `@${jidUser(jid)}`;

/** Top members of the group, by messages or by XP */
async function sendTop(message, field) {
  const rows = await UserStats.findAll({
    where: { groupJid: message.jid },
    order: [
      [field, "DESC"],
      ["jid", "ASC"],
    ],
    limit: TOP_SIZE,
    raw: true,
  });
  if (!rows.length) return await message.reply(getLang("plugins.groupinfo.empty"));

  const title =
    field === "xp"
      ? getLang("plugins.groupinfo.top_xp_title", TOP_SIZE)
      : getLang("plugins.groupinfo.top_title", TOP_SIZE);
  const lines = rows.map((row, i) =>
    getLang(
      "plugins.groupinfo.top_line",
      i + 1,
      tag(row.jid),
      row.messageCount || 0,
      row.xp || 0,
      row.level || 0,
    ),
  );
  return await message.reply(`${title}\n\n${lines.join("\n")}`, {
    mentions: rows.map((row) => row.jid),
  });
}

async function sendOverview(message) {
  const where = { groupJid: message.jid };
  const tracked = await UserStats.count({ where });
  if (tracked === 0) return await message.reply(getLang("plugins.groupinfo.empty"));

  const sequelize = UserStats.sequelize;
  const sum = (column, alias) => [sequelize.fn("SUM", sequelize.col(column)), alias];
  const [totals] = await UserStats.findAll({
    where,
    attributes: [
      sum("messageCount", "totalMessages"),
      sum("commandCount", "totalCommands"),
      sum("mediaCount", "totalMedia"),
    ],
    raw: true,
  });
  const topUser = await UserStats.findOne({
    where,
    order: [["messageCount", "DESC"]],
    raw: true,
  });
  const topXp = await UserStats.findOne({ where, order: [["xp", "DESC"]], raw: true });
  const metadata = await message.getGroupMetadata();

  const lines = [getLang("plugins.groupinfo.title", metadata?.subject || getLang("plugins.groupinfo.default_name"))];
  if (metadata?.participants?.length) {
    const admins = metadata.participants.filter((p) => p.admin).length;
    lines.push(getLang("plugins.groupinfo.members", metadata.participants.length, admins));
  }
  lines.push(
    getLang("plugins.groupinfo.tracked", tracked),
    getLang("plugins.groupinfo.messages", Number(totals?.totalMessages) || 0),
    getLang("plugins.groupinfo.commands", Number(totals?.totalCommands) || 0),
    getLang("plugins.groupinfo.media", Number(totals?.totalMedia) || 0),
  );
  const mentions = [];
  if (topUser) {
    lines.push(getLang("plugins.groupinfo.top_active", tag(topUser.jid), topUser.messageCount || 0));
    mentions.push(topUser.jid);
  }
  if (topXp) {
    lines.push(
      getLang("plugins.groupinfo.top_xp", tag(topXp.jid), topXp.xp || 0, topXp.level || 0),
    );
    if (!mentions.includes(topXp.jid)) mentions.push(topXp.jid);
  }
  lines.push("", getLang("plugins.groupinfo.hint", config.PREFIX));
  await message.reply(lines.join("\n"), { mentions });

  // Drill-down buttons (a separate message: interactive messages can't carry mentions)
  try {
    await sendQuickReplies(
      message.client.getSocket(),
      message.jid,
      getLang("plugins.groupinfo.more"),
      [
        { id: "ginfo:top", text: getLang("plugins.groupinfo.btn_top", TOP_SIZE) },
        { id: "ginfo:xp", text: getLang("plugins.groupinfo.btn_xp") },
      ],
      { title: getLang("plugins.groupinfo.btn_title"), quoted: message.data },
    );
  } catch (error) {
    console.error("groupinfo: could not send the buttons", safeLog(error));
  }
}

module.exports = {
  command: {
    pattern: "groupinfo|ginfo|stats2",
    desc: getLang("plugins.groupinfo.desc"),
    type: "stats",
    onlyGroup: true,
  },

  async execute(message, argsString) {
    const arg = String(argsString || "").trim().split(" ")[0].toLowerCase();
    if (TOP_ARGS.has(arg)) return await sendTop(message, "messageCount");
    if (arg === "xp") return await sendTop(message, "xp");
    return await sendOverview(message);
  },

  /** Buttons `ginfo:top` and `ginfo:xp` */
  async handleButtonReply(message) {
    const body = message?.body;
    if (typeof body !== "string" || !body.startsWith("ginfo:")) return false;

    try {
      if (!message.isGroup) return true;
      const action = body.split(":")[1];
      if (action === "top") await sendTop(message, "messageCount");
      else if (action === "xp") await sendTop(message, "xp");
      else return false;
    } catch (error) {
      console.error("groupinfo: button failed", safeLog(error));
      try {
        await message.reply(getLang("common.error"));
      } catch (_) {
        // nothing more to do
      }
    }
    return true;
  },
};
