const { getLang } = require("../lib/utils/language");
const { sendInteractiveMessage } = require("@ryuu-reinzz/button-helper");

// Board state: 9 cells (0-8)
const games = new Map(); // chatId -> { p1, p2, board, turn, messageId }

function emptyBoard() {
  return Array(9).fill(null);
}

function renderBoard(board, mark1 = "❌", mark2 = "⭕") {
  let s = "";
  for (let r = 0; r < 3; r++) {
    s += board.slice(r * 3, r * 3 + 3).map((c) => c || "·").join(" ") + "\n";
  }
  return s;
}

function checkWin(board) {
  const wins = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];
  for (const [a, b, c] of wins) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  if (board.every((c) => c)) return "tie";
  return null;
}

async function sendBoard(sock, jid, game) {
  const sections = [
    {
      title: "Pick a cell",
      rows: Array.from({ length: 9 }, (_, i) => {
        const cell = game.board[i];
        const sym = cell === "X" ? "❌" : cell === "O" ? "⭕" : `${i + 1}`;
        return {
          id: `ttt:${jid}:${i}`,
          title: `Cell ${i + 1}`,
          description: sym === `${i + 1}` ? "Empty" : `Taken by ${sym}`,
        };
      }),
    },
  ];

  const turnName = `@${game.turn.split("@")[0]}`;
  const p1Name = `@${game.p1.split("@")[0]}`;
  const p2Name = `@${game.p2.split("@")[0]}`;

  const text =
    `🎮 *Tic-Tac-Toe*\n\n${renderBoard(game.board)}\n` +
    `${p1Name} (❌) vs ${p2Name} (⭕)\n_Turn: ${turnName}_`;

  const sent = await sendInteractiveMessage(sock, jid, {
    text,
    title: "❌⭕ Tic-Tac-Toe",
    footer: "Tap a cell number",
    interactiveButtons: [
      {
        name: "single_select",
        buttonParamsJson: JSON.stringify({
          title: "Pick a cell",
          sections,
        }),
      },
    ],
  });
  return sent;
}

/**
 * Tic-Tac-Toe (1v1, 3x3 single-select grid).
 */
module.exports = {
  command: {
    pattern: "tictactoe|ttt|xo",
    desc: getLang("plugins.ttt.desc"),
    type: "games",
  },

  async execute(message) {
    const sock = message.client.getSocket();
    const opponent =
      message.mentions && message.mentions.length > 0
        ? message.mentions[0]
        : message.quoted
        ? message.quoted.sender
        : null;

    if (!opponent) return await message.reply(getLang("plugins.ttt.need_opponent"));
    if (opponent === message.sender) return await message.reply(getLang("plugins.ttt.self"));
    if (!message.isGroup) return await message.reply(getLang("extra.group_cmd"));

    const game = {
      p1: message.sender,
      p2: opponent,
      board: emptyBoard(),
      turn: message.sender,
    };
    games.set(message.jid, game);
    const sent = await sendBoard(sock, message.jid, game);
    if (sent?.key?.id) game.messageId = sent.key.id;

    setTimeout(() => {
      const g = games.get(message.jid);
      if (g && g === game) games.delete(message.jid);
    }, 10 * 60 * 1000);
  },

  async handleReply(message) {
    if (!message.body || !message.body.startsWith("ttt:")) return false;
    const parts = message.body.split(":");
    if (parts.length !== 3 || parts[0] !== "ttt") return false;
    const [, chatId, cellStr] = parts;
    const game = games.get(chatId);
    if (!game) return false;
    const cell = parseInt(cellStr, 10);
    if (isNaN(cell) || cell < 0 || cell > 8) return false;
    if (game.board[cell]) return false;
    if (message.sender !== game.turn) {
      await message.react("⏳");
      return true;
    }

    game.board[cell] = message.sender === game.p1 ? "X" : "O";
    const winner = checkWin(game.board);
    if (winner) {
      games.delete(chatId);
      let text;
      if (winner === "tie") text = getLang("plugins.ttt.tie");
      else {
        const winJid = winner === "X" ? game.p1 : game.p2;
        text = getLang("plugins.ttt.win", `@${winJid.split("@")[0]}`);
      }
      text = `🎮 *Tic-Tac-Toe*\n\n${renderBoard(game.board)}\n\n${text}`;
      await message.reply(text, { mentions: [game.p1, game.p2] });
      return true;
    }
    game.turn = game.turn === game.p1 ? game.p2 : game.p1;
    await sendBoard(message.client.getSocket(), chatId, game);
    return true;
  },
};
