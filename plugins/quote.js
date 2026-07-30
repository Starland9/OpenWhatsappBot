const { getLang } = require("../lib/utils/language");
const { Quote } = require("../lib/database");
const { sendQuickReplies } = require("./buttons");

/**
 * Group quote-saver: save memorable messages and replay them.
 *   .quote              → menu (add/random/list)
 *   .quote add          → saves the replied-to message
 *   .quote random       → sends a random saved quote
 *   .quote list         → lists recent quotes
 */
module.exports = {
  command: {
    pattern: "quote|q",
    desc: getLang("plugins.quote.desc"),
    type: "group",
    onlyGroup: true,
  },

  async execute(message, argsString) {
    const sock = message.client.getSocket();
    const sub = (argsString || "").trim().toLowerCase();

    if (sub === "add" || sub === "save") return await this._add(message);
    if (sub === "random" || sub === "r") return await this._random(message);
    if (sub === "list" || sub === "l") return await this._list(message);
    if (sub === "delete" || sub === "del")
      return await this._delete(message, argsString.split(/\s+/)[1]);

    const buttons = [
      { id: `quote:save:${message.jid}`, text: "💾 Save" },
      { id: `quote:rand:${message.jid}`, text: "🎲 Random" },
      { id: `quote:list:${message.jid}`, text: "📋 List" },
    ];
    return await sendQuickReplies(
      sock,
      message.jid,
      getLang("plugins.quote.menu"),
      buttons,
      {
        title: "💬 Group Quotes",
        footer: "OpenWhatsappBot",
        quoted: message.data,
      },
    );
  },

  async _add(message) {
    if (!message.quoted)
      return await message.reply(getLang("plugins.quote.reply_first"));
    const text =
      message.quoted.message?.conversation ||
      message.quoted.message?.extendedTextMessage?.text ||
      "";
    if (!text) return await message.reply(getLang("plugins.quote.no_text"));

    const q = await Quote.create({
      groupJid: message.jid,
      authorJid: message.quoted.sender,
      authorName: `@${message.quoted.sender.split("@")[0]}`,
      text: text.slice(0, 2000),
      savedBy: message.sender,
    });
    await message.react("💾");
    return await message.reply(getLang("plugins.quote.saved", q.id));
  },

  async _random(message) {
    const count = await Quote.count({ where: { groupJid: message.jid } });
    if (count === 0) return await message.reply(getLang("plugins.quote.empty"));
    const offset = Math.floor(Math.random() * count);
    const q = await Quote.findOne({
      where: { groupJid: message.jid },
      offset,
      order: [["id", "ASC"]],
    });
    if (!q) return await message.reply(getLang("plugins.quote.empty"));
    return await message.reply(
      getLang(
        "plugins.quote.format",
        q.text,
        q.authorName || `@${q.authorJid.split("@")[0]}`,
      ),
    );
  },

  async _list(message) {
    const quotes = await Quote.findAll({
      where: { groupJid: message.jid },
      order: [["createdAt", "DESC"]],
      limit: 5,
    });
    if (quotes.length === 0)
      return await message.reply(getLang("plugins.quote.empty"));
    const text =
      `💬 *Recent Quotes*\n\n` +
      quotes
        .map(
          (q) =>
            `  #${q.id} — _${q.text.slice(0, 50)}${q.text.length > 50 ? "..." : ""}_ — ${q.authorName || `@${q.authorJid.split("@")[0]}`}`,
        )
        .join("\n");
    return await message.reply(text);
  },

  async _delete(message, idStr) {
    if (!message.isSudo() && !(await message.isSenderAdmin())) {
      return await message.reply(getLang("plugins.common.not_admin"));
    }
    const id = parseInt(idStr, 10);
    if (!id)
      return await message.reply(
        getLang("plugins.quote.usage", require("../config").PREFIX),
      );
    const deleted = await Quote.destroy({
      where: { id, groupJid: message.jid },
    });
    if (!deleted)
      return await message.reply(getLang("plugins.quote.not_found", id));
    return await message.reply(getLang("plugins.quote.deleted", id));
  },

  async handleReply(message) {
    if (!message.body || !message.body.startsWith("quote:")) return false;
    const parts = message.body.split(":");
    const action = parts[1];
    if (action === "save") {
      await this._add(message);
      return true;
    }
    if (action === "rand") {
      await this._random(message);
      return true;
    }
    if (action === "list") {
      await this._list(message);
      return true;
    }
    return false;
  },
};
