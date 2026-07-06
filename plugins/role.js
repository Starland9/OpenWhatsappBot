const { getLang } = require("../lib/utils/language");
const { GroupRole } = require("../lib/database");
const { sendList, sendQuickReplies } = require("./buttons");

const VALID_ROLES = ["vip", "muted", "banned", "regular"];

/**
 * Set/remove custom group roles (vip, muted, banned, regular).
 * Admin or sudo only.
 */
module.exports = {
  command: {
    pattern: "role",
    desc: getLang("plugins.role.desc"),
    type: "group",
    onlyGroup: true,
  },

  async execute(message, argsString) {
    const args = (argsString || "").trim().split(/\s+/);
    const sub = (args[0] || "").toLowerCase();

    if (sub === "list" || sub === "") {
      return await this._list(message);
    }

    if (sub === "set") {
      // Check admin
      if (!message.isSudo() && !(await message.isSenderAdmin())) {
        return await message.reply(getLang("plugins.common.not_admin"));
      }
      const target =
        message.mentions && message.mentions.length > 0
          ? message.mentions[0]
          : message.quoted
            ? message.quoted.sender
            : null;
      const role = (
        args.find((a) => VALID_ROLES.includes(a.toLowerCase())) || ""
      ).toLowerCase();
      if (!target)
        return await message.reply(
          getLang("plugins.role.usage", require("../config").PREFIX),
        );
      if (!role)
        return await message.reply(
          getLang("plugins.role.usage", require("../config").PREFIX),
        );

      const [rec, created] = await GroupRole.findOrCreate({
        where: { groupJid: message.jid, userJid: target },
        defaults: { role: "regular", setBy: message.sender, setAt: new Date() },
      });
      rec.role = role;
      rec.setBy = message.sender;
      rec.setAt = new Date();
      await rec.save();

      await message.react("✅");
      return await message.reply(
        getLang("plugins.role.set", `@${target.split("@")[0]}`, role),
        { mentions: [target] },
      );
    }

    if (sub === "check") {
      const target =
        message.mentions && message.mentions.length > 0
          ? message.mentions[0]
          : message.quoted
            ? message.quoted.sender
            : message.sender;
      const rec = await GroupRole.findOne({
        where: { groupJid: message.jid, userJid: target },
      });
      if (!rec) {
        return await message.reply(
          getLang("plugins.role.none", `@${target.split("@")[0]}`),
        );
      }
      return await message.reply(
        getLang("plugins.role.current", `@${target.split("@")[0]}`, rec.role),
        { mentions: [target] },
      );
    }

    // Default: show interactive role selector
    if (!message.isSudo() && !(await message.isSenderAdmin())) {
      return await message.reply(getLang("plugins.common.not_admin"));
    }
    const target =
      message.mentions && message.mentions.length > 0
        ? message.mentions[0]
        : message.quoted
          ? message.quoted.sender
          : null;
    if (!target) {
      return await message.reply(
        getLang("plugins.role.usage", require("../config").PREFIX),
      );
    }
    const sections = [
      {
        title: "Pick a role",
        rows: VALID_ROLES.map((r) => ({
          id: `role:set:${r}:${target}`,
          title: r.charAt(0).toUpperCase() + r.slice(1),
          description:
            r === "vip"
              ? "Special privileges"
              : r === "muted"
                ? "Cannot send messages"
                : r === "banned"
                  ? "Removed from group"
                  : "Default role",
        })),
      },
    ];
    return await sendList(
      message.client.getSocket(),
      message.jid,
      getLang("plugins.role.pick", `@${target.split("@")[0]}`),
      sections,
      {
        title: "👑 Role Manager",
        buttonLabel: "Pick role",
        footer: "OpenWhatsappBot",
        quoted: message.data,
      },
    );
  },

  async _list(message) {
    const roles = await GroupRole.findAll({ where: { groupJid: message.jid } });
    if (roles.length === 0) {
      return await message.reply(getLang("plugins.role.empty"));
    }
    const counts = {};
    for (const r of roles) counts[r.role] = (counts[r.role] || 0) + 1;
    const text =
      `👑 *Group Roles*\n\n` +
      Object.entries(counts)
        .map(([k, v]) => `  ${k}: _${v} user${v > 1 ? "s" : ""}_`)
        .join("\n");
    return await message.reply(text);
  },

  async handleReply(message) {
    if (!message.body || !message.body.startsWith("role:set:")) return false;
    const parts = message.body.split(":");
    if (parts.length < 4) return false;
    const role = parts[2];
    const target = parts[3];
    if (!VALID_ROLES.includes(role)) return false;
    if (!message.isSudo() && !(await message.isSenderAdmin())) {
      await message.reply(getLang("plugins.common.not_admin"));
      return true;
    }
    const [rec] = await GroupRole.findOrCreate({
      where: { groupJid: message.jid, userJid: target },
      defaults: { role: "regular", setBy: message.sender, setAt: new Date() },
    });
    rec.role = role;
    rec.setBy = message.sender;
    rec.setAt = new Date();
    await rec.save();
    await message.react("✅");
    await message.reply(
      getLang("plugins.role.set", `@${target.split("@")[0]}`, role),
      { mentions: [target] },
    );
    return true;
  },
};
