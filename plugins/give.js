const { getLang } = require("../lib/utils/language");
const { DATABASE } = require("../lib/database");
const { getBotJids, normalizeJid } = require("../lib/utils/permissions");
const economy = require("./economy");
const config = require("../config");

const MAX_GIVE = 1000000000;

/** First token that is a whole positive number within limits ("@user 50" and "50 @user" both work) */
function parseAmount(argsString) {
  for (const token of String(argsString || "").trim().split(/\s+/)) {
    if (!/^\d{1,10}$/.test(token)) continue;
    const n = parseInt(token, 10);
    if (n >= 1 && n <= MAX_GIVE) return n;
  }
  return 0;
}

/** True when `jid` (any form) is one of the group's participants */
function isParticipant(metadata, forms) {
  for (const p of metadata.participants || []) {
    for (const id of [p.id, p.phoneNumber, p.lid]) {
      const n = normalizeJid(id);
      if (n && forms.has(n)) return true;
    }
  }
  return false;
}

/**
 * Give coins to another member.
 */
module.exports = {
  command: {
    pattern: "give|pay|transfer",
    desc: getLang("plugins.give.desc"),
    type: "economy",
    onlyGroup: true,
  },

  async execute(message, argsString) {
    const amount = parseAmount(argsString);
    if (!amount) {
      return await message.reply(getLang("plugins.give.usage", config.PREFIX));
    }

    const rawTarget = normalizeJid(
      (message.mentions && message.mentions[0]) ||
        (message.quoted && message.quoted.sender) ||
        "",
    );
    if (!rawTarget) {
      return await message.reply(getLang("plugins.give.mention_user"));
    }
    const target = await economy.resolveTarget(message, {
      fallbackToSender: false,
    });
    const forms = new Set([rawTarget, target].filter(Boolean));

    const senderForms = new Set(
      [message.sender, message.senderLid].map(normalizeJid).filter(Boolean),
    );
    if ([...forms].some((f) => senderForms.has(f))) {
      return await message.reply(getLang("plugins.give.self"));
    }

    const bot = getBotJids(message.client.getSocket());
    if ([bot.pn, bot.lid].some((b) => b && forms.has(b))) {
      return await message.reply(getLang("plugins.give.bot"));
    }

    const metadata = await message.getGroupMetadata();
    if (metadata && !isParticipant(metadata, forms)) {
      return await message.reply(getLang("plugins.give.not_member"));
    }

    const groupJid = message.jid;
    const senderJid = normalizeJid(message.sender);

    // One transaction: conditional debit, then credit. The debit only applies
    // when the balance still covers the amount, so concurrent gifts cannot overdraw.
    const result = await economy.withLock(`give:${groupJid}`, () =>
      DATABASE.transaction(async (transaction) => {
        const debited = await economy.debit(groupJid, senderJid, amount, transaction);
        if (!debited) return { ok: false };
        await economy.credit(groupJid, target, amount, transaction);
        return {
          ok: true,
          balance: await economy.getBalance(groupJid, senderJid, transaction),
        };
      }),
    );

    if (!result.ok) {
      const balance = await economy.getBalance(groupJid, senderJid);
      return await message.reply(
        getLang("plugins.give.no_funds", amount, balance),
      );
    }

    await message.react("💸");
    return await message.reply(
      getLang("plugins.give.done", amount, economy.tag(target), result.balance),
      { mentions: [target] },
    );
  },

  parseAmount,
};
