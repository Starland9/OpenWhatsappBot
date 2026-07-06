const { getLang } = require("../lib/utils/language");
const { sendQuickReplies } = require("./buttons");

const CHOICES = ["rock", "paper", "scissors"];
const EMOJI = { rock: "🪨", paper: "📄", scissors: "✂️" };

function beats(a, b) {
  return (
    (a === "rock" && b === "scissors") ||
    (a === "paper" && b === "rock") ||
    (a === "scissors" && b === "paper")
  );
}

const games = new Map(); // chatId -> { player1, player2, messageId, picks: {jid:choice} }

/**
 * Rock-Paper-Scissors (1v1 via quick-reply buttons, 1vBot otherwise).
 */
module.exports = {
  command: {
    pattern: "rps",
    desc: getLang("plugins.rps.desc"),
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

    const gameId = message.jid;
    const buttons = CHOICES.map((c) => ({
      id: `rps:${gameId}:${c}`,
      text: EMOJI[c] + " " + c.charAt(0).toUpperCase() + c.slice(1),
    }));

    if (!opponent) {
      // 1vBot
      const playerPick = CHOICES[Math.floor(Math.random() * 3)];
      const botPick = CHOICES[Math.floor(Math.random() * 3)];
      const result = beats(playerPick, botPick)
        ? "win"
        : beats(botPick, playerPick)
          ? "lose"
          : "tie";
      return await message.reply(
        getLang(
          "plugins.rps.vsbot",
          EMOJI[playerPick],
          playerPick,
          EMOJI[botPick],
          botPick,
          getLang("plugins.rps." + result),
        ),
      );
    }

    if (opponent === message.sender) {
      return await message.reply(getLang("plugins.rps.self"));
    }

    // 1v1 — both must pick
    const sent = await sendQuickReplies(
      sock,
      message.jid,
      getLang("plugins.rps.challenge", `@${opponent.split("@")[0]}`),
      buttons,
      { title: "🪨📄✂️ RPS", footer: "Pick your move", quoted: message.data },
    );

    games.set(gameId, {
      player1: message.sender,
      player2: opponent,
      messageId: sent?.key?.id,
      picks: {},
    });

    // Auto-expire after 2 minutes
    setTimeout(() => games.delete(gameId), 120 * 1000);
  },

  async handleReply(message) {
    if (!message.body || !message.body.startsWith("rps:")) return false;
    const parts = message.body.split(":");
    if (parts.length !== 3 || parts[0] !== "rps") return false;
    const [, gameId, pick] = parts;
    const game = games.get(gameId);
    if (!game) return false;
    if (![game.player1, game.player2].includes(message.sender)) return false;
    if (!CHOICES.includes(pick)) return false;
    if (game.picks[message.sender]) return false;

    game.picks[message.sender] = pick;

    if (!game.picks[game.player1] || !game.picks[game.player2]) {
      // Waiting for the other player
      const other =
        message.sender === game.player1 ? game.player2 : game.player1;
      return false; // Let them keep going; the original challenge stays
    }

    const p1 = game.picks[game.player1];
    const p2 = game.picks[game.player2];
    const result = beats(p1, p2) ? "p1" : beats(p2, p1) ? "p2" : "tie";
    games.delete(gameId);

    const p1Name = `@${game.player1.split("@")[0]}`;
    const p2Name = `@${game.player2.split("@")[0]}`;
    let text;
    if (result === "tie") {
      text = getLang("plugins.rps.tie", p1Name, EMOJI[p1], p2Name, EMOJI[p2]);
    } else {
      const winner = result === "p1" ? p1Name : p2Name;
      text = getLang(
        "plugins.rps.win",
        p1Name,
        EMOJI[p1],
        p2Name,
        EMOJI[p2],
        winner,
      );
    }
    await message.reply(text, { mentions: [game.player1, game.player2] });
    return true;
  },
};
