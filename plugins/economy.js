const { Op } = require("sequelize");
const { getLang } = require("../lib/utils/language");
const { GroupEconomy } = require("../lib/database");
const { safeLog } = require("../lib/utils/http");
const { normalizeJid, toPnJid } = require("../lib/utils/permissions");
const { sendQuickReplies } = require("./buttons");
const config = require("../config");

/**
 * Show a balance and the group's top-5 rich list.
 *
 * This module also holds the small atomic helpers shared by `daily`, `give`
 * and `dice` (research R16, data-model.md GroupEconomy). Every balance change is
 * one SQL statement that re-checks the funds in its WHERE clause, so two
 * concurrent commands can never spend the same coins twice or go below zero.
 */

const STREAK_WINDOW_MS = 48 * 60 * 60 * 1000;

const literal = (sql) => GroupEconomy.sequelize.literal(sql);

// In-process queue per key: keeps multi-statement transfers one after the other
// (the database conditions stay the source of truth across processes)
const locks = new Map();

async function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  locks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** Create the (group, user) account when missing; concurrent calls are safe */
async function ensureAccount(groupJid, userJid, transaction) {
  await GroupEconomy.bulkCreate(
    [{ groupJid, userJid, balance: 0, streak: 0, lastDailyAt: null }],
    { ignoreDuplicates: true, transaction },
  );
}

/** The account row, or null (no row is created) */
async function getAccount(groupJid, userJid, transaction) {
  return await GroupEconomy.findOne({
    where: { groupJid, userJid },
    transaction,
  });
}

/** Balance of a user (0 without account) */
async function getBalance(groupJid, userJid, transaction) {
  const row = await getAccount(groupJid, userJid, transaction);
  return row ? row.balance || 0 : 0;
}

/**
 * balance += delta in one statement.
 * With `minBalance`, nothing happens unless balance >= minBalance (so a debit
 * of n is `applyDelta(-n, { minBalance: n })`).
 * @returns {Promise<boolean>} true when the account was updated
 */
async function applyDelta(groupJid, userJid, delta, opts = {}) {
  const amount = Number(delta);
  if (!Number.isSafeInteger(amount)) throw new TypeError("delta must be an integer");

  const where = { groupJid, userJid };
  if (opts.minBalance !== undefined) {
    where.balance = { [Op.gte]: Number(opts.minBalance) };
  }
  const [affected] = await GroupEconomy.update(
    { balance: literal(`COALESCE("balance", 0) + (${amount})`) },
    { where, transaction: opts.transaction },
  );
  return affected > 0;
}

/** Remove `amount` coins if the user has them. @returns {Promise<boolean>} */
async function debit(groupJid, userJid, amount, transaction) {
  const n = Number(amount);
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError("amount must be a positive integer");
  return await applyDelta(groupJid, userJid, -n, { minBalance: n, transaction });
}

/** Add `amount` coins (the account is created when missing) */
async function credit(groupJid, userJid, amount, transaction) {
  const n = Number(amount);
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError("amount must be a positive integer");
  await ensureAccount(groupJid, userJid, transaction);
  return await applyDelta(groupJid, userJid, n, { transaction });
}

/** Daily streak still alive (last claim less than 48 h ago), else 0 */
function currentStreak(account, now = Date.now()) {
  if (!account || !account.lastDailyAt) return 0;
  const last = new Date(account.lastDailyAt).getTime();
  if (!Number.isFinite(last) || now - last > STREAK_WINDOW_MS) return 0;
  return account.streak || 0;
}

/**
 * Account owner a command refers to: first mention, else the author of the
 * quoted message, else the sender. Phone-number form when it can be resolved.
 */
async function resolveTarget(message, { fallbackToSender = true } = {}) {
  const raw =
    (message.mentions && message.mentions[0]) ||
    (message.quoted && message.quoted.sender) ||
    (fallbackToSender ? message.sender : "");
  const normalized = normalizeJid(raw);
  if (!normalized) return "";
  return normalizeJid(await toPnJid(message, normalized));
}

const tag = (jid) => `@${String(jid).split("@")[0]}`;

async function showBalance(message) {
  const sock = message.client.getSocket();
  const target = await resolveTarget(message);
  if (!target) return await message.reply(getLang("plugins.economy.no_target"));

  const account = await getAccount(message.jid, target);
  const balance = account ? account.balance || 0 : 0;
  const streak = currentStreak(account);

  const top = await GroupEconomy.findAll({
    where: { groupJid: message.jid, balance: { [Op.gt]: 0 } },
    order: [
      ["balance", "DESC"],
      ["userJid", "ASC"],
    ],
    limit: 5,
  });

  const topLines = top.length
    ? top
        .map((r, i) =>
          getLang("plugins.economy.top_line", i + 1, tag(r.userJid), r.balance),
        )
        .join("\n")
    : getLang("plugins.economy.no_top");

  const text = getLang(
    "plugins.economy.card",
    tag(target),
    balance,
    streak ? getLang("plugins.economy.streak_line", streak) : "",
    topLines,
  );

  const mentions = [target, ...top.map((r) => r.userJid)];
  const buttons = [
    { id: "economy:daily", text: getLang("plugins.economy.btn_daily") },
    { id: "economy:give", text: getLang("plugins.economy.btn_give") },
  ];
  try {
    return await sendQuickReplies(sock, message.jid, text, buttons, {
      title: getLang("plugins.economy.title"),
      footer: "OpenWhatsappBot",
      quoted: message.data,
      mentions,
    });
  } catch (err) {
    console.error("economy: buttons failed", safeLog(err));
    return await message.reply(text, { mentions });
  }
}

module.exports = {
  command: {
    pattern: "balance|bal|coins|wallet",
    desc: getLang("plugins.economy.desc"),
    type: "economy",
    onlyGroup: true,
  },

  async execute(message) {
    return await showBalance(message);
  },

  async handleButtonReply(message) {
    const id = message && message.body;
    if (typeof id !== "string" || !id.startsWith("economy:")) return false;
    if (id !== "economy:daily" && id !== "economy:give") return false;

    try {
      if (!message.isGroup) {
        await message.reply(getLang("extra.group_cmd"));
      } else if (id === "economy:daily") {
        await require("./daily").claimDaily(message);
      } else {
        await message.reply(getLang("plugins.give.usage", config.PREFIX));
      }
    } catch (err) {
      console.error("economy: button failed", safeLog(err));
      try {
        await message.reply(getLang("common.error"));
      } catch (_) {
        // nothing more to do
      }
    }
    return true;
  },

  // shared helpers (daily, give, dice)
  withLock,
  ensureAccount,
  getAccount,
  getBalance,
  applyDelta,
  debit,
  credit,
  currentStreak,
  resolveTarget,
  tag,
};
