const { getLang } = require("../lib/utils/language");
const { sendQuickReplies } = require("./buttons");

const polls = new Map(); // chatId -> { id, question, options, votes:Map, createdAt, closesAt }

/**
 * Enhanced polls: native WhatsApp poll, up to 12 options, with reaction-based fallback.
 *   .poll+ "Question? opt1, opt2, opt3"   → native poll
 *   .poll+ vote <idx>                      → vote (only if reaction fallback active)
 *   .poll+ close                           → close current poll
 */
module.exports = {
  command: {
    pattern: "poll\\+|pollplus",
    desc: getLang("plugins.pollplus.desc"),
    type: "group",
    onlyGroup: true,
  },

  async execute(message, argsString) {
    const sock = message.client.getSocket();
    const args = (argsString || "").trim();
    const sub = args.split(/\s+/)[0].toLowerCase();

    if (sub === "close" || sub === "end") {
      const cur = polls.get(message.jid);
      if (!cur) return await message.reply(getLang("plugins.pollplus.none"));
      polls.delete(message.jid);
      // Tally
      const tally = {};
      for (const opt of cur.options) tally[opt] = 0;
      for (const v of cur.votes.values()) {
        if (tally[v] !== undefined) tally[v] += 1;
      }
      const text = `📊 *Poll closed:* ${cur.question}\n\n` +
        cur.options.map((o, i) => `  ${i + 1}. ${o} — _${tally[o]} votes_`).join("\n");
      return await message.reply(text);
    }

    if (sub === "vote" || sub === "v") {
      const cur = polls.get(message.jid);
      if (!cur) return await message.reply(getLang("plugins.pollplus.none"));
      const idx = parseInt(args.split(/\s+/)[1], 10);
      if (!idx || idx < 1 || idx > cur.options.length) {
        return await message.reply(getLang("plugins.pollplus.bad_idx"));
      }
      const pick = cur.options[idx - 1];
      cur.votes.set(message.sender, pick);
      return await message.reply(getLang("plugins.pollplus.voted", idx));
    }

    // New poll: parse "Question? opt1, opt2, opt3"
    const m = args.match(/^(.+?)\?\s*(.+)$/s);
    if (!m) {
      return await message.reply(getLang("plugins.pollplus.usage", require("../config").PREFIX));
    }
    const question = m[1].trim();
    const opts = m[2].split(",").map((o) => o.trim()).filter(Boolean);
    if (opts.length < 2) {
      return await message.reply(getLang("plugins.pollplus.usage", require("../config").PREFIX));
    }
    if (opts.length > 12) {
      return await message.reply(getLang("plugins.pollplus.too_many"));
    }

    try {
      // Try native poll first
      const sent = await message.sendPoll(question, opts, { selectableCount: 1 });
      polls.set(message.jid, {
        id: sent?.key?.id,
        question,
        options: opts,
        votes: new Map(),
        createdAt: Date.now(),
      });
      await message.react("📊");
      // Provide a "Close" button for admins
      return await sendQuickReplies(
        sock,
        message.jid,
        getLang("plugins.pollplus.created", question),
        [{ id: `pollplus:close:${message.jid}`, text: "🔒 Close" }],
        { title: "📊 Poll+", footer: "OpenWhatsappBot", quoted: message.data }
      );
    } catch (err) {
      // Fallback: manual reaction-vote
      const sent = await sock.sendMessage(message.jid, {
        text:
          `📊 *Poll:* ${question}\n\n` +
          opts.map((o, i) => `  ${i + 1}. ${o}`).join("\n") +
          `\n\n_${require("../config").PREFIX}poll+ vote <number>_ to vote.`,
        quoted: message.data,
      });
      polls.set(message.jid, {
        id: sent?.key?.id,
        question,
        options: opts,
        votes: new Map(),
        createdAt: Date.now(),
      });
      await message.react("📊");
    }
  },

  async handleReply(message) {
    if (!message.body || !message.body.startsWith("pollplus:")) return false;
    const parts = message.body.split(":");
    if (parts[1] === "close") {
      if (!message.isSudo() && !(await message.isSenderAdmin())) {
        await message.reply(getLang("plugins.common.not_admin"));
        return true;
      }
      const cur = polls.get(message.jid);
      if (!cur) {
        await message.reply(getLang("plugins.pollplus.none"));
        return true;
      }
      polls.delete(message.jid);
      const tally = {};
      for (const opt of cur.options) tally[opt] = 0;
      for (const v of cur.votes.values()) {
        if (tally[v] !== undefined) tally[v] += 1;
      }
      const text = `📊 *Poll closed:* ${cur.question}\n\n` +
        cur.options.map((o, i) => `  ${i + 1}. ${o} — _${tally[o]} votes_`).join("\n");
      await message.reply(text);
      return true;
    }
    return false;
  },
};
