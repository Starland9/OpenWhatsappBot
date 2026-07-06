/**
 * Game Leaderboard Plugin
 * Cross-game leaderboard with interactive filtering
 */

const { GameScore } = require("../lib/database");
const { sendInteractive } = require("../lib/utils/buttonHelper");

const GAME_NAMES = {
  hangman: "🎯 Pendu",
  wordle: "🟩 Wordle",
  slots: "🎰 Slots",
  rps: "🪨 Pierre-Papier-Ciseaux",
  scramble: "🔤 Scramble",
  quiz: "🎓 Quiz",
  truthdare: "🎭 Action ou Vérité",
};

module.exports = {
  command: {
    pattern: "glb|gameleader",
    desc: "Classement des jeux du groupe",
    type: "games",
    fromMe: false,
    onlyGroup: true,
  },

  async execute(message, args) {
    const gameFilter = (args || "").toLowerCase().trim() || null;
    const sock = message.client.getSocket();

    // Try to show a select menu for game filter
    if (!gameFilter) {
      try {
        await sendInteractive(sock, message.jid, {
          text: `*🏆 Classement des Jeux*\n\nChoisissez un jeu ou sélectionnez "Tous" pour le classement global.`,
          footer: "OpenWhatsappBot — Game Leaderboard",
          interestiveButtons: [
            {
              name: "single_select",
              buttonParamsJson: JSON.stringify({
                title: "Filtrer par jeu",
                sections: [
                  {
                    title: "Jeux disponibles",
                    rows: [
                      { id: "glb_all", title: "🏆 Tous les jeux", description: "Classement global" },
                      ...Object.entries(GAME_NAMES).map(([k, v]) => ({
                        id: `glb_${k}`,
                        title: v,
                        description: `Top joueurs — ${v}`,
                      })),
                    ],
                  },
                ],
              }),
            },
          ],
        });
        return;
      } catch (_) {
        // Fallback: show overall leaderboard
      }
    }

    // Show leaderboard
    const targetGame = gameFilter ? gameFilter.replace("glb_", "") : null;
    await showLeaderboard(message, targetGame);
  },
};

async function showLeaderboard(message, game) {
  const where = { groupJid: message.jid };
  if (game && game !== "all") where.game = game;

  // Aggregate: sum scores by jid+game (or all games if no filter)
  const scores = await GameScore.findAll({ where, order: [["score", "DESC"]], limit: 50 });

  if (scores.length === 0) {
    const gameName = game && game !== "all" ? GAME_NAMES[game] || game : "tous les jeux";
    return await message.reply(`📊 Aucun score enregistré pour *${gameName}* dans ce groupe.`);
  }

  // Aggregate by jid when showing all games
  let ranked;
  if (!game || game === "all") {
    const byJid = new Map();
    for (const s of scores) {
      const existing = byJid.get(s.jid) || { jid: s.jid, score: 0, wins: 0 };
      existing.score += s.score;
      existing.wins += s.wins;
      byJid.set(s.jid, existing);
    }
    ranked = [...byJid.values()].sort((a, b) => b.score - a.score).slice(0, 10);
  } else {
    ranked = scores.slice(0, 10);
  }

  const gameName = game && game !== "all" ? GAME_NAMES[game] || game : "Tous les jeux";
  const medals = ["🥇", "🥈", "🥉"];

  let text = `*🏆 Classement — ${gameName}*\n\n`;
  ranked.forEach((r, i) => {
    const medal = medals[i] || `${i + 1}.`;
    const num = r.jid.split("@")[0];
    text += `${medal} @${num} — ⭐ ${r.score} pts`;
    if (r.wins > 0) text += ` | 🏆 ${r.wins} victoires`;
    text += "\n";
  });

  const mentions = ranked.map((r) => r.jid);
  return await message.reply(text, { mentions });
}
