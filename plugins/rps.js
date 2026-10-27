const config = require("../config");
const { getLang } = require("../lib/utils/language");
const { createStore } = require("../lib/utils/gameStore");
const { sendQuickReplies } = require("./buttons");
const { safeLog } = require("../lib/utils/http");
const { normalizeJid, jidUser, isPnJid, toPnJid, guardTarget } = require("../lib/utils/permissions");

/**
 * Rock-Paper-Scissors
 *   .rps               you against the bot, the move is picked with buttons
 *   .rps <move>        you against the bot, in one message
 *   .rps @user         1v1: each player gets the buttons by private message, only the
 *                      result is announced in the chat
 *
 * Button ids: rps:pick:<nonce>:<rock|paper|scissors>
 */

const CHOICES = ["rock", "paper", "scissors"];
const EMOJI = { rock: "🪨", paper: "📄", scissors: "✂️" };

// Words (and emoji) accepted for `.rps <move>`
const MOVE_ALIASES = {
  rock: "rock",
  pierre: "rock",
  "🪨": "rock",
  paper: "paper",
  feuille: "paper",
  papier: "paper",
  "📄": "paper",
  scissors: "scissors",
  ciseaux: "scissors",
  "✂️": "scissors",
  "✂": "scissors",
};

const GAME_TTL_MS = 2 * 60 * 1000;
const MAX_INDEXED_DUELS = 200;

function beats(a, b) {
  return (
    (a === "rock" && b === "scissors") ||
    (a === "paper" && b === "rock") ||
    (a === "scissors" && b === "paper")
  );
}

// nonce -> chat of a duel: the picks arrive in private chats, not in the game's chat
const duelChats = new Map();

// Duels that time out are announced in their chat
const store = createStore("rps", {
  ttlMs: GAME_TTL_MS,
  onExpire(chatJid, game, reason) {
    duelChats.delete(game.nonce);
    if (reason !== "expired" || game.mode !== "duel") return;
    const sock = game.client?.getSocket?.();
    if (!sock) return;
    sock
      .sendMessage(chatJid, {
        text: getLang("plugins.rps.timeout", ...game.players.map((p) => p.name)),
        mentions: game.players.map((p) => p.mention),
      })
      .catch((err) => console.error("RPS timeout notice error:", safeLog(err)));
  },
});

function moveLabel(choice) {
  return `${EMOJI[choice]} ${getLang(`plugins.rps.move_${choice}`)}`;
}

function pickButtons(game) {
  return CHOICES.map((choice) => ({
    id: `rps:pick:${game.nonce}:${choice}`,
    text: moveLabel(choice),
  }));
}

/** All the forms under which the message's author may appear (PN and LID) */
function senderIds(message) {
  return [message.sender, message.senderLid].map(normalizeJid).filter(Boolean);
}

function isPlayer(player, ids) {
  return ids.some((id) => player.ids.has(id));
}

/** The game's creator, one of its players, a group admin or an owner may stop a game */
async function canManage(message, game) {
  const ids = senderIds(message);
  if (ids.some((id) => game.creatorIds.includes(id))) return true;
  if (game.players && game.players.some((p) => isPlayer(p, ids))) return true;
  if (message.isSudo()) return true;
  return await message.isSenderAdmin();
}

/** A player as the game stores it: every known id, the JID to mention and where to send DMs */
async function makePlayer(message, jid) {
  const raw = normalizeJid(jid);
  const pn = await toPnJid(message, raw);
  const ids = new Set([raw, pn].filter(Boolean));
  const mention = raw || pn;
  return {
    ids,
    mention,
    dm: isPnJid(pn) ? pn : raw,
    name: `@${jidUser(mention)}`,
  };
}

function resultText(game, picks) {
  const [p1, p2] = game.players;
  const c1 = picks[0];
  const c2 = picks[1];
  if (c1 === c2) {
    return getLang("plugins.rps.tie_game", p1.name, moveLabel(c1), p2.name, moveLabel(c2));
  }
  const winner = beats(c1, c2) ? p1 : p2;
  return getLang(
    "plugins.rps.win_game",
    p1.name,
    moveLabel(c1),
    p2.name,
    moveLabel(c2),
    winner.name,
  );
}

function findGame(message, nonce) {
  let game = store.get(message.jid);
  if (game && game.nonce === nonce) return { chatJid: message.jid, game };
  const chatJid = duelChats.get(nonce);
  game = chatJid ? store.get(chatJid) : null;
  if (game && game.nonce === nonce) return { chatJid, game };
  return { chatJid: null, game: null };
}

/** Choose the bot's move and answer; the game is over */
async function finishVsBot(message, playerPick) {
  const botPick = CHOICES[Math.floor(Math.random() * CHOICES.length)];
  const result = beats(playerPick, botPick) ? "win" : beats(botPick, playerPick) ? "lose" : "tie";
  return await message.reply(
    getLang(
      "plugins.rps.vsbot",
      EMOJI[playerPick],
      getLang(`plugins.rps.move_${playerPick}`),
      EMOJI[botPick],
      getLang(`plugins.rps.move_${botPick}`),
      getLang(`plugins.rps.${result}`),
    ),
  );
}

/** The mentioned user, else the author of the quoted message */
function resolveOpponent(message) {
  const mentioned = (message.mentions || []).find(Boolean);
  return mentioned || message.quoted?.sender || null;
}

async function startVsBot(message) {
  const game = {
    mode: "bot",
    creatorIds: senderIds(message),
    players: null,
    client: message.client,
  };
  const stored = await register(message, game);
  if (!stored) return;

  try {
    await sendQuickReplies(
      message.client.getSocket(),
      message.jid,
      getLang("plugins.rps.pick_prompt"),
      pickButtons(stored),
      { title: getLang("plugins.rps.title"), footer: getLang("plugins.rps.footer_pick"), quoted: message.data },
    );
  } catch (err) {
    store.end(message.jid); // nobody can play without the buttons
    throw err;
  }
}

async function startDuel(message, opponentJid) {
  const refusal = await guardTarget(message, opponentJid);
  if (refusal === "common.cannot_target_bot" || refusal === "common.cannot_target_self") {
    return await message.reply(getLang(refusal));
  }

  const me = await makePlayer(message, message.sender || message.senderLid);
  for (const id of senderIds(message)) me.ids.add(id);
  const other = await makePlayer(message, opponentJid);
  if (isPlayer(other, [...me.ids])) {
    return await message.reply(getLang("common.cannot_target_self"));
  }

  const game = {
    mode: "duel",
    creatorIds: [...me.ids],
    players: [me, other],
    picks: {},
    client: message.client,
  };
  const stored = await register(message, game);
  if (!stored) return;

  duelChats.set(stored.nonce, message.jid);
  if (duelChats.size > MAX_INDEXED_DUELS) {
    duelChats.delete(duelChats.keys().next().value);
  }

  await message.reply(getLang("plugins.rps.challenge", me.name, other.name), {
    mentions: [me.mention, other.mention],
  });

  // Each player picks in private, so the other one cannot see the move
  const sock = message.client.getSocket();
  const failed = [];
  for (const player of stored.players) {
    try {
      await sendQuickReplies(
        sock,
        player.dm,
        getLang("plugins.rps.dm_prompt", me.name, other.name),
        pickButtons(stored),
        { title: getLang("plugins.rps.title"), footer: getLang("plugins.rps.footer_pick") },
      );
    } catch (err) {
      console.error("RPS DM error:", safeLog(err));
      failed.push(player);
    }
  }
  if (failed.length > 0) {
    store.end(message.jid);
    duelChats.delete(stored.nonce);
    await message.reply(getLang("plugins.rps.dm_failed", failed.map((p) => p.name).join(" ")), {
      mentions: failed.map((p) => p.mention),
    });
  }
}

/** Store a new game; replace a running one only for its creator, a group admin or an owner */
async function register(message, game) {
  let res = store.start(message.jid, game);
  if (!res.ok) {
    if (!(await canManage(message, res.existing))) {
      await message.reply(getLang("plugins.rps.already_running", config.PREFIX));
      return null;
    }
    duelChats.delete(res.existing.nonce);
    store.end(message.jid);
    res = store.start(message.jid, game);
    if (!res.ok) {
      await message.reply(getLang("plugins.rps.already_running", config.PREFIX));
      return null;
    }
  }
  return res.game;
}

async function stopGame(message) {
  const game = store.get(message.jid);
  if (!game) return await message.reply(getLang("plugins.rps.no_game"));
  if (!(await canManage(message, game))) {
    return await message.reply(getLang("plugins.rps.stop_denied"));
  }
  duelChats.delete(game.nonce);
  store.end(message.jid);
  return await message.reply(getLang("plugins.rps.stopped"));
}

/** Handle a click on a pick button: rps:pick:<nonce>:<choice> */
async function handlePick(message, nonce, choice) {
  const { chatJid, game } = findGame(message, nonce);
  if (!game) return await message.reply(getLang("plugins.rps.expired"));
  if (!CHOICES.includes(choice)) return await message.reply(getLang("plugins.rps.expired"));

  const ids = senderIds(message);

  if (game.mode === "bot") {
    if (!ids.some((id) => game.creatorIds.includes(id))) {
      return await message.reply(getLang("plugins.rps.not_your_game"));
    }
    store.end(chatJid);
    return await finishVsBot(message, choice);
  }

  const index = game.players.findIndex((p) => isPlayer(p, ids));
  if (index < 0) return await message.reply(getLang("plugins.rps.not_your_game"));
  if (game.picks[index]) return await message.reply(getLang("plugins.rps.already_picked"));

  game.picks[index] = choice;
  if (!game.picks[0] || !game.picks[1]) {
    store.touch(chatJid);
    return await message.reply(getLang("plugins.rps.pick_saved", moveLabel(choice)));
  }

  // Both moves are in: announce the result in the game's chat only
  const picks = [game.picks[0], game.picks[1]];
  store.end(chatJid);
  duelChats.delete(nonce);
  const text = resultText(game, picks);
  const mentions = game.players.map((p) => p.mention);
  await message.client.getSocket().sendMessage(chatJid, { text, mentions });
  if (message.jid !== chatJid) {
    await message.reply(getLang("plugins.rps.pick_saved", moveLabel(choice)));
  }
}

module.exports = {
  command: {
    pattern: "rps|pfc",
    desc: getLang("plugins.rps.desc"),
    type: "games",
  },

  async execute(message, argsString) {
    const arg = String(argsString || "").trim().toLowerCase().split(/\s+/)[0] || "";

    if (arg === "stop" || arg === "quit") return await stopGame(message);
    if (arg === "help") return await message.reply(getLang("plugins.rps.usage", config.PREFIX));

    const move = MOVE_ALIASES[arg];
    if (move) return await finishVsBot(message, move);

    const opponent = resolveOpponent(message);
    if (opponent) return await startDuel(message, opponent);

    if (arg !== "" && arg !== "start" && arg !== "bot") {
      return await message.reply(getLang("plugins.rps.usage", config.PREFIX));
    }
    return await startVsBot(message);
  },

  async handleButtonReply(message) {
    if (typeof message.body !== "string" || !message.body.startsWith("rps:")) return false;
    try {
      const [, action, nonce, choice] = message.body.split(":");
      if (action !== "pick" || !nonce) {
        await message.reply(getLang("plugins.rps.expired"));
        return true;
      }
      await handlePick(message, nonce, choice);
    } catch (err) {
      console.error("RPS reply error:", safeLog(err));
    }
    return true;
  },
};
