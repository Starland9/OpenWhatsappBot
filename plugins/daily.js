const { Op } = require("sequelize");
const { getLang } = require("../lib/utils/language");
const { GroupEconomy } = require("../lib/database");
const { safeLog } = require("../lib/utils/http");
const { normalizeJid } = require("../lib/utils/permissions");
const { sendQuickReplies } = require("./buttons");
const economy = require("./economy");

const DAILY_AMOUNT = 50;
const STREAK_BONUS_PER_DAY = 10;
const MAX_REWARD = 200;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const STREAK_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Reward of the n-th consecutive day, capped */
function rewardFor(streak) {
  return Math.min(MAX_REWARD, DAILY_AMOUNT + streak * STREAK_BONUS_PER_DAY);
}

/** Milliseconds left before the next claim (0 = available) */
function remainingMs(account, now = Date.now()) {
  if (!account || !account.lastDailyAt) return 0;
  const last = new Date(account.lastDailyAt).getTime();
  if (!Number.isFinite(last)) return 0;
  return Math.max(0, last + COOLDOWN_MS - now);
}

async function sendCooldown(message, waitMs) {
  const totalMinutes = Math.ceil(waitMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const buttons = [
    { id: "daily:status", text: getLang("plugins.daily.btn_status") },
  ];
  return await sendQuickReplies(
    message.client.getSocket(),
    message.jid,
    getLang("plugins.daily.cooldown", hours, minutes),
    buttons,
    {
      title: getLang("plugins.daily.title"),
      footer: "OpenWhatsappBot",
      quoted: message.data,
    },
  );
}

/**
 * Claim the daily reward of the sender.
 * The claim is one conditional UPDATE (lastDailyAt empty or older than 24 h):
 * two concurrent claims pay once, the other one is told to wait.
 */
async function claimDaily(message) {
  const groupJid = message.jid;
  const userJid = normalizeJid(message.sender);
  if (!userJid) return false;

  await economy.ensureAccount(groupJid, userJid);
  const account = await economy.getAccount(groupJid, userJid);

  const now = Date.now();
  const wait = remainingMs(account, now);
  if (wait > 0) {
    await sendCooldown(message, wait);
    return false;
  }

  // The streak goes on when the last claim is less than 48 h old, otherwise it restarts at 1
  const last = account.lastDailyAt ? new Date(account.lastDailyAt).getTime() : null;
  const keepsStreak = last !== null && Number.isFinite(last) && now - last <= STREAK_WINDOW_MS;
  const streak = keepsStreak ? (account.streak || 0) + 1 : 1;
  const reward = rewardFor(streak);

  const [claimed] = await GroupEconomy.update(
    {
      balance: GroupEconomy.sequelize.literal(`COALESCE("balance", 0) + ${reward}`),
      streak,
      lastDailyAt: new Date(now),
    },
    {
      where: {
        groupJid,
        userJid,
        [Op.or]: [
          { lastDailyAt: null },
          { lastDailyAt: { [Op.lte]: new Date(now - COOLDOWN_MS) } },
        ],
      },
    },
  );

  if (!claimed) {
    // Lost the race against another claim of the same user
    const fresh = await economy.getAccount(groupJid, userJid);
    await sendCooldown(message, remainingMs(fresh) || COOLDOWN_MS);
    return false;
  }

  const balance = await economy.getBalance(groupJid, userJid);
  await message.react("💰");
  await message.reply(getLang("plugins.daily.claimed", reward, balance, streak));
  return true;
}

module.exports = {
  command: {
    pattern: "daily|claim",
    desc: getLang("plugins.daily.desc"),
    type: "economy",
    onlyGroup: true,
  },

  async execute(message) {
    await claimDaily(message);
  },

  async handleButtonReply(message) {
    const id = message && message.body;
    if (typeof id !== "string" || !id.startsWith("daily:")) return false;
    if (id !== "daily:status" && id !== "daily:claim") return false;

    try {
      if (!message.isGroup) {
        await message.reply(getLang("extra.group_cmd"));
      } else if (id === "daily:claim") {
        await claimDaily(message);
      } else {
        const userJid = normalizeJid(message.sender);
        const account = await economy.getAccount(message.jid, userJid);
        await message.reply(
          getLang(
            "plugins.daily.status",
            account ? account.balance || 0 : 0,
            economy.currentStreak(account),
          ),
        );
      }
    } catch (err) {
      console.error("daily: button failed", safeLog(err));
      try {
        await message.reply(getLang("common.error"));
      } catch (_) {
        // nothing more to do
      }
    }
    return true;
  },

  claimDaily,
  rewardFor,
  MAX_REWARD,
};
