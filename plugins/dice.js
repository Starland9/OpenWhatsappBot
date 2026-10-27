const crypto = require("crypto");
const { getLang } = require("../lib/utils/language");
const { safeLog } = require("../lib/utils/http");
const { normalizeJid } = require("../lib/utils/permissions");
const { sendList } = require("./buttons");
const economy = require("./economy");
const config = require("../config");

const MIN_DICE = 1;
const MAX_DICE = 10;
const MIN_SIDES = 2;
const MAX_SIDES = 1000;
const MIN_BET = 10;
const MAX_BET = 1000;

/**
 * Bets. A win returns `mult` times the stake (stake included), a loss keeps it.
 * Expected return = chance * mult, always below 1:
 *   d6   exact number     1/6  x5    -> 0.833
 *   2d6  a double         1/6  x5    -> 0.833
 *   d20  a 20             1/20 x15   -> 0.750
 *   coin heads or tails   1/2  x1.9  -> 0.950
 */
const BETS = {
  d6: { chance: 1 / 6, mult: [5, 1] },
  "2d6": { chance: 6 / 36, mult: [5, 1] },
  d20: { chance: 1 / 20, mult: [15, 1] },
  coin: { chance: 1 / 2, mult: [19, 10] },
};

const FREE_MODES = ["d6", "2d6", "d20", "coin"];
const COIN_SIDES = {
  heads: "heads",
  head: "heads",
  h: "heads",
  face: "heads",
  f: "heads",
  tails: "tails",
  tail: "tails",
  t: "tails",
  pile: "tails",
  p: "tails",
};

const rollDie = (sides) => crypto.randomInt(1, sides + 1);

const payoutFor = (key, bet) => Math.floor((bet * BETS[key].mult[0]) / BETS[key].mult[1]);
const expectedReturn = (key) => (BETS[key].chance * BETS[key].mult[0]) / BETS[key].mult[1];

function localeNumber(n) {
  try {
    return n.toLocaleString(String(config.LANG || "en").slice(0, 2));
  } catch (_) {
    return String(n);
  }
}

function usageText() {
  const pct = (key) => Math.round(expectedReturn(key) * 100);
  return getLang(
    "plugins.dice.usage",
    config.PREFIX,
    MAX_DICE,
    MAX_SIDES,
    MIN_BET,
    MAX_BET,
    BETS.d6.mult[0],
    BETS["2d6"].mult[0],
    BETS.d20.mult[0],
    localeNumber(BETS.coin.mult[0] / BETS.coin.mult[1]),
    pct("d6"),
    pct("d20"),
    pct("coin"),
  );
}

/**
 * Mode word -> { kind: "coin" } | { kind: "dice", count, sides, label, betKey }
 * | { kind: "invalid" } | null (not a mode)
 */
function parseMode(word) {
  if (word === "coin" || word === "flip" || word === "cf") return { kind: "coin" };

  const legacy = new Map([
    ["6", "d6"],
    ["26", "2d6"],
    ["20", "d20"],
  ]);
  const alias = legacy.get(word) || word;
  const m = /^(\d*)d(\d+)$/.exec(alias);
  if (!m) return null;

  const count = m[1] === "" ? 1 : Number(m[1]);
  const sides = Number(m[2]);
  if (
    !(count >= MIN_DICE && count <= MAX_DICE) ||
    !(sides >= MIN_SIDES && sides <= MAX_SIDES)
  ) {
    return { kind: "invalid" };
  }

  const label = `${count === 1 ? "" : count}d${sides}`;
  return { kind: "dice", count, sides, label, betKey: BETS[label] ? label : null };
}

/**
 * The words after the mode -> { bet, guess } or { error: lang key (+ args) }.
 * d6: <bet> <1-6>; coin: <bet> <heads|tails> in any order; others: <bet>.
 */
function parseBet(parsed, rest) {
  const key = parsed.kind === "coin" ? "coin" : parsed.betKey;
  if (!key) return { error: ["plugins.dice.bet_unsupported"] };

  let betToken;
  let guessToken;
  if (key === "coin") {
    betToken = rest.find((w) => /^\d+$/.test(w));
    guessToken = rest.find((w) => !/^\d+$/.test(w));
  } else {
    [betToken, guessToken] = rest;
  }

  if (!betToken || !/^\d{1,9}$/.test(betToken)) return { error: ["plugins.dice.invalid_bet"] };
  const bet = parseInt(betToken, 10);
  if (bet < MIN_BET || bet > MAX_BET) {
    return { error: ["plugins.dice.bet_range", MIN_BET, MAX_BET] };
  }

  let guess = null;
  if (key === "d6") {
    guess = /^[1-6]$/.test(guessToken || "") ? Number(guessToken) : null;
    if (!guess) return { error: ["plugins.dice.need_number"] };
  } else if (key === "coin") {
    guess = Object.prototype.hasOwnProperty.call(COIN_SIDES, guessToken)
      ? COIN_SIDES[guessToken]
      : null;
    if (!guess) return { error: ["plugins.dice.need_side"] };
  }
  return { key, bet, guess };
}

const sideLabel = (side) =>
  getLang(side === "heads" ? "plugins.dice.heads" : "plugins.dice.tails");

/** Did the bet win? */
function isWin(key, guess, rolls, flip) {
  if (key === "d6") return rolls[0] === guess;
  if (key === "2d6") return rolls[0] === rolls[1];
  if (key === "d20") return rolls[0] === 20;
  return flip === guess;
}

function conditionText(key, guess) {
  if (key === "d6") return getLang("plugins.dice.cond_d6", guess);
  if (key === "2d6") return getLang("plugins.dice.cond_2d6");
  if (key === "d20") return getLang("plugins.dice.cond_d20");
  return getLang("plugins.dice.cond_coin", sideLabel(guess));
}

/**
 * Settle a bet with ONE conditional statement:
 * balance = balance - bet + payout, only if balance >= bet.
 * @returns {Promise<{ ok: boolean, balance: number }>}
 */
async function settleBet(message, bet, payout) {
  const groupJid = message.jid;
  const userJid = normalizeJid(message.sender);
  const ok = await economy.applyDelta(groupJid, userJid, payout - bet, {
    minBalance: bet,
  });
  return { ok, balance: await economy.getBalance(groupJid, userJid) };
}

async function play(message, parsed, rest) {
  const isBet = rest.length > 0;
  let bet = null;

  if (isBet) {
    if (!message.isGroup) return await message.reply(getLang("plugins.dice.bet_group_only"));
    bet = parseBet(parsed, rest);
    if (bet.error) {
      const [key, ...args] = bet.error;
      return await message.reply(
        `${getLang(key, ...args)}\n${getLang("plugins.dice.hint", config.PREFIX)}`,
      );
    }
  }

  // Roll first: a refused bet (no funds) changes nothing
  let rolls = [];
  let flip = null;
  let header;
  if (parsed.kind === "coin") {
    flip = rollDie(2) === 1 ? "heads" : "tails";
    header = getLang("plugins.dice.coin", sideLabel(flip));
  } else {
    for (let i = 0; i < parsed.count; i++) rolls.push(rollDie(parsed.sides));
    const sum = rolls.reduce((a, b) => a + b, 0);
    header = getLang(
      "plugins.dice.roll_format",
      parsed.label,
      rolls.map((r) => `\`${r}\``).join(" "),
      sum,
    );
  }

  if (!isBet) return await message.reply(header);

  const win = isWin(bet.key, bet.guess, rolls, flip);
  const payout = win ? payoutFor(bet.key, bet.bet) : 0;
  const settled = await settleBet(message, bet.bet, payout);
  if (!settled.ok) {
    return await message.reply(
      getLang("plugins.dice.no_funds", bet.bet, settled.balance),
    );
  }

  const betLine = getLang(
    "plugins.dice.bet_line",
    bet.bet,
    conditionText(bet.key, bet.guess),
  );
  let result;
  if (!win) {
    result = getLang("plugins.dice.lost", bet.bet, settled.balance);
  } else {
    const gain = payout - bet.bet;
    result = getLang(
      BETS[bet.key].mult[0] >= 10 ? "plugins.dice.jackpot" : "plugins.dice.won",
      gain,
      settled.balance,
    );
  }
  return await message.reply(`${header}\n${betLine}\n${result}`);
}

async function sendMenu(message) {
  const rows = [
    {
      id: "dice:d6",
      title: getLang("plugins.dice.menu_d6"),
      description: getLang("plugins.dice.menu_d6_desc"),
    },
    {
      id: "dice:2d6",
      title: getLang("plugins.dice.menu_2d6"),
      description: getLang("plugins.dice.menu_2d6_desc"),
    },
    {
      id: "dice:d20",
      title: getLang("plugins.dice.menu_d20"),
      description: getLang("plugins.dice.menu_d20_desc"),
    },
    {
      id: "dice:coin",
      title: getLang("plugins.dice.menu_coin"),
      description: getLang("plugins.dice.menu_coin_desc"),
    },
  ];
  return await sendList(
    message.client.getSocket(),
    message.jid,
    getLang("plugins.dice.pick", config.PREFIX),
    [{ title: getLang("plugins.dice.menu_section"), rows }],
    {
      title: getLang("plugins.dice.title"),
      buttonLabel: getLang("plugins.dice.menu_button"),
      footer: "OpenWhatsappBot",
      quoted: message.data,
    },
  );
}

/**
 * Dice rolls and coin flip with optional economy bets.
 */
module.exports = {
  command: {
    pattern: "dice|roll",
    desc: getLang("plugins.dice.desc"),
    type: "games",
  },

  async execute(message, argsString) {
    const words = String(argsString || "")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    if (["help", "aide", "odds", "bet", "?"].includes(words[0])) {
      return await message.reply(usageText());
    }

    const parsed = parseMode(words[0] || "d6");
    if (!parsed) return await sendMenu(message);
    if (parsed.kind === "invalid") {
      return await message.reply(
        getLang("plugins.dice.invalid_dice", MAX_DICE, MIN_SIDES, MAX_SIDES),
      );
    }
    return await play(message, parsed, words.slice(1));
  },

  async handleButtonReply(message) {
    const id = message && message.body;
    if (typeof id !== "string" || !id.startsWith("dice:")) return false;
    const mode = id.slice("dice:".length);
    if (!FREE_MODES.includes(mode)) return false;
    if (message.fromMe) return false;

    try {
      await play(message, parseMode(mode), []);
    } catch (err) {
      console.error("dice: button failed", safeLog(err));
      try {
        await message.reply(getLang("common.error"));
      } catch (_) {
        // nothing more to do
      }
    }
    return true;
  },

  // exported for tests
  BETS,
  MIN_BET,
  MAX_BET,
  parseMode,
  parseBet,
  payoutFor,
  expectedReturn,
};
