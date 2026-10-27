const config = require("../config");
const { getLang } = require("../lib/utils/language");
const { createStore } = require("../lib/utils/gameStore");
const { sendList } = require("./buttons");
const { safeLog } = require("../lib/utils/http");
const { normalizeJid, jidUser, toPnJid, guardTarget } = require("../lib/utils/permissions");

/**
 * Tic-Tac-Toe (1v1 in a group).
 *   .ttt @user      challenge a member (or reply to one of their messages)
 *   .ttt <1-9>      play a cell without the list
 *   .ttt stop       end the game
 *
 * List row ids: ttt:move:<nonce>:<1-9>. The chat is always message.jid.
 */

const GAME_TTL_MS = 10 * 60 * 1000;
const MARKS = { X: "❌", O: "⭕" };
const KEYCAPS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
const WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

// One game per chat; a game expires after GAME_TTL_MS without a move
const store = createStore("ttt", { ttlMs: GAME_TTL_MS });

function emptyBoard() {
  return Array(9).fill(null);
}

/** Three rows of ❌ / ⭕ / the cell number of the free cells */
function renderBoard(board) {
  const rows = [];
  for (let r = 0; r < 3; r++) {
    rows.push(
      board
        .slice(r * 3, r * 3 + 3)
        .map((cell, i) => MARKS[cell] || KEYCAPS[r * 3 + i])
        .join(" "),
    );
  }
  return rows.join("\n");
}

/** "X" or "O" when a line is complete, "tie" when the board is full, otherwise null */
function checkWin(board) {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return board.every(Boolean) ? "tie" : null;
}

/** Every id the message's author may appear under (phone number and LID) */
function senderIds(message) {
  return [message.sender, message.senderLid].map(normalizeJid).filter(Boolean);
}

function isPlayer(player, ids) {
  return ids.some((id) => player.ids.has(id));
}

/** A player as the game stores it: every known id and how to show / mention them */
async function makePlayer(message, jid) {
  const raw = normalizeJid(jid);
  const pn = await toPnJid(message, raw);
  return {
    ids: new Set([raw, pn].filter(Boolean)),
    mention: raw || pn,
    name: `@${jidUser(raw || pn)}`,
  };
}

/** True when the JID is in the group (or when the member list cannot be read) */
async function isGroupMember(message, player) {
  const metadata = await message.getGroupMetadata();
  if (!metadata || !Array.isArray(metadata.participants)) return true;
  return metadata.participants.some((p) =>
    [p.id, p.phoneNumber, p.lid].map(normalizeJid).some((id) => id && player.ids.has(id)),
  );
}

/** The players, a group admin or an owner may end or replace a game */
async function canManage(message, game) {
  const ids = senderIds(message);
  if (game.players.some((p) => isPlayer(p, ids))) return true;
  if (message.isSudo()) return true;
  return await message.isSenderAdmin();
}

function currentPlayer(game) {
  return game.players[game.turn];
}

function boardText(game) {
  const [p1, p2] = game.players;
  return getLang(
    "plugins.ttt.board",
    renderBoard(game.board),
    p1.name,
    p2.name,
    `${currentPlayer(game).name} ${MARKS[game.turn === 0 ? "X" : "O"]}`,
    config.PREFIX,
  );
}

async function sendBoard(message, game) {
  const sections = [
    {
      title: getLang("plugins.ttt.pick_cell"),
      rows: game.board.map((cell, i) => ({
        id: `ttt:move:${game.nonce}:${i + 1}`,
        title: getLang("plugins.ttt.cell", i + 1),
        description: cell
          ? getLang("plugins.ttt.taken_by", MARKS[cell])
          : getLang("plugins.ttt.empty"),
      })),
    },
  ];

  const sent = await sendList(message.client.getSocket(), message.jid, boardText(game), sections, {
    title: getLang("plugins.ttt.title"),
    buttonLabel: getLang("plugins.ttt.pick_cell"),
    footer: getLang("plugins.ttt.footer"),
  });
  if (sent?.key?.id) game.botMessageId = sent.key.id;
}

async function startGame(message) {
  const opponentJid = (message.mentions || []).find(Boolean) || message.quoted?.sender || null;
  if (!opponentJid) {
    const running = store.get(message.jid);
    if (running) return await sendBoard(message, running); // post the board again
    return await message.reply(getLang("plugins.ttt.need_opponent", config.PREFIX));
  }

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
  if (!(await isGroupMember(message, other))) {
    return await message.reply(getLang("plugins.ttt.not_member", other.name), {
      mentions: [other.mention],
    });
  }

  const game = {
    players: [me, other], // me plays ❌ and starts
    board: emptyBoard(),
    turn: 0,
    botMessageId: null,
  };

  let res = store.start(message.jid, game);
  if (!res.ok) {
    if (!(await canManage(message, res.existing))) {
      return await message.reply(getLang("plugins.ttt.already_running", config.PREFIX));
    }
    store.end(message.jid);
    res = store.start(message.jid, game);
    if (!res.ok) return await message.reply(getLang("plugins.ttt.already_running", config.PREFIX));
  }

  await message.reply(getLang("plugins.ttt.challenge", me.name, other.name), {
    mentions: [me.mention, other.mention],
  });
  await sendBoard(message, res.game);
}

async function stopGame(message) {
  const game = store.get(message.jid);
  if (!game) return await message.reply(getLang("plugins.ttt.no_game", config.PREFIX));
  if (!(await canManage(message, game))) {
    return await message.reply(getLang("plugins.ttt.stop_denied"));
  }
  store.end(message.jid);
  return await message.reply(getLang("plugins.ttt.stopped"));
}

/**
 * Play `cell` (1-9) for the message's author. Every refusal is an explicit reply.
 * The board is updated before the first await, so two clicks cannot both play.
 */
async function playMove(message, game, cell) {
  const index = game.players.findIndex((p) => isPlayer(p, senderIds(message)));
  if (index < 0) return await message.reply(getLang("plugins.ttt.not_player"));
  if (index !== game.turn) return await message.reply(getLang("plugins.ttt.not_your_turn"));
  if (!Number.isInteger(cell) || cell < 1 || cell > 9) {
    return await message.reply(getLang("plugins.ttt.invalid_cell"));
  }
  if (game.board[cell - 1]) return await message.reply(getLang("plugins.ttt.cell_taken"));

  game.board[cell - 1] = index === 0 ? "X" : "O";
  const outcome = checkWin(game.board);

  if (outcome) {
    store.end(message.jid);
    const [p1, p2] = game.players;
    const result =
      outcome === "tie"
        ? getLang("plugins.ttt.tie")
        : getLang("plugins.ttt.win", (outcome === "X" ? p1 : p2).name);
    return await message.reply(getLang("plugins.ttt.final", renderBoard(game.board), result), {
      mentions: [p1.mention, p2.mention],
    });
  }

  game.turn = game.turn === 0 ? 1 : 0;
  store.touch(message.jid);
  await sendBoard(message, game);
}

module.exports = {
  command: {
    pattern: "tictactoe|ttt|xo",
    desc: getLang("plugins.ttt.desc"),
    type: "games",
    onlyGroup: true,
  },

  async execute(message, argsString) {
    const arg = String(argsString || "").trim().toLowerCase().split(/\s+/)[0] || "";

    if (arg === "stop" || arg === "quit") return await stopGame(message);
    if (arg === "help") return await message.reply(getLang("plugins.ttt.usage", config.PREFIX));

    if (/^[1-9]$/.test(arg)) {
      const game = store.get(message.jid);
      if (!game) return await message.reply(getLang("plugins.ttt.no_game", config.PREFIX));
      return await playMove(message, game, Number(arg));
    }

    return await startGame(message);
  },

  async handleButtonReply(message) {
    if (typeof message.body !== "string" || !message.body.startsWith("ttt:")) return false;
    try {
      const [, action, nonce, arg] = message.body.split(":");
      const game = store.get(message.jid);
      if (action !== "move" || !game || game.nonce !== nonce) {
        await message.reply(getLang("plugins.ttt.expired", config.PREFIX));
        return true;
      }
      await playMove(message, game, Number(arg));
    } catch (err) {
      console.error("TicTacToe reply error:", safeLog(err));
    }
    return true;
  },
};
