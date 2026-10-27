const { getLang } = require("../lib/utils/language");
const { Quote } = require("../lib/database");
const { sendQuickReplies } = require("./buttons");
const config = require("../config");

/**
 * Group quote-saver: save memorable messages and replay them.
 *   .quote              → menu (random/list buttons)
 *   .quote add          → saves the replied-to message (text or caption)
 *   .quote random       → sends a random saved quote
 *   .quote list         → lists recent quotes
 *   .quote delete <id>  → removes a quote (group admins and owner)
 */

const MAX_TEXT_LENGTH = 2000;
const LIST_SIZE = 5;
const LIST_PREVIEW_LENGTH = 50;

const authorOf = (q) => q.authorName || `@${String(q.authorJid).split("@")[0]}`;

async function addQuote(message) {
  if (!message.quoted) {
    return await message.reply(getLang("plugins.quote.reply_first"));
  }
  // conversation, extended text and media captions
  const text = message.getQuotedText().trim();
  if (!text) return await message.reply(getLang("plugins.quote.no_text"));

  const author =
    message.quoted.sender || message.quoted.key?.participant || "unknown";
  const q = await Quote.create({
    groupJid: message.jid,
    authorJid: author,
    authorName: `@${author.split("@")[0]}`,
    text: text.slice(0, MAX_TEXT_LENGTH),
    savedBy: message.sender,
  });
  await message.react("💾");
  return await message.reply(getLang("plugins.quote.saved", q.id));
}

async function randomQuote(message) {
  const where = { groupJid: message.jid };
  const count = await Quote.count({ where });
  if (count === 0) return await message.reply(getLang("plugins.quote.empty"));
  const q = await Quote.findOne({
    where,
    offset: Math.floor(Math.random() * count),
    order: [["id", "ASC"]],
  });
  if (!q) return await message.reply(getLang("plugins.quote.empty"));
  return await message.reply(getLang("plugins.quote.format", q.text, authorOf(q)));
}

async function listQuotes(message) {
  const quotes = await Quote.findAll({
    where: { groupJid: message.jid },
    order: [["createdAt", "DESC"]],
    limit: LIST_SIZE,
  });
  if (quotes.length === 0) return await message.reply(getLang("plugins.quote.empty"));

  const lines = quotes.map((q) => {
    const preview =
      q.text.length > LIST_PREVIEW_LENGTH
        ? `${q.text.slice(0, LIST_PREVIEW_LENGTH)}...`
        : q.text;
    return `  #${q.id} — _${preview}_ — ${authorOf(q)}`;
  });
  return await message.reply(`${getLang("plugins.quote.list_title")}\n\n${lines.join("\n")}`);
}

async function deleteQuote(message, idArg) {
  if (!message.isSudo() && !(await message.isSenderAdmin())) {
    return await message.reply(getLang("common.sender_not_admin"));
  }
  const id = parseInt(idArg, 10);
  if (!id || id < 1) {
    return await message.reply(getLang("plugins.quote.usage", config.PREFIX));
  }
  const deleted = await Quote.destroy({ where: { id, groupJid: message.jid } });
  if (!deleted) return await message.reply(getLang("plugins.quote.not_found", id));
  return await message.reply(getLang("plugins.quote.deleted", id));
}

module.exports = {
  command: {
    pattern: "quote|q",
    desc: getLang("plugins.quote.desc"),
    type: "group",
    onlyGroup: true,
  },

  async execute(message, argsString) {
    const [sub = "", idArg] = (argsString || "").trim().toLowerCase().split(/\s+/);

    if (sub === "add" || sub === "save") return await addQuote(message);
    if (sub === "random" || sub === "r") return await randomQuote(message);
    if (sub === "list" || sub === "l") return await listQuotes(message);
    if (sub === "delete" || sub === "del") return await deleteQuote(message, idArg);

    // Saving needs the message to quote, so only the replay actions get a button
    const buttons = [
      { id: "quote:random", text: getLang("plugins.quote.btn_random") },
      { id: "quote:list", text: getLang("plugins.quote.btn_list") },
    ];
    return await sendQuickReplies(
      message.client.getSocket(),
      message.jid,
      getLang("plugins.quote.menu", config.PREFIX),
      buttons,
      {
        title: getLang("plugins.quote.menu_title"),
        footer: "OpenWhatsappBot",
        quoted: message.data,
      },
    );
  },

  async handleButtonReply(message) {
    try {
      if (!message.body || !message.body.startsWith("quote:")) return false;
      if (!message.isGroup) return false;

      const action = message.body.split(":")[1];
      if (action === "random") await randomQuote(message);
      else if (action === "list") await listQuotes(message);
      else return false;
      return true;
    } catch (error) {
      console.error("quote button error:", error?.message);
      return true;
    }
  },
};
