/**
 * Roulette Plugin
 * Russian roulette group game — participants join, one gets "shot"
 */

const { jidNormalizedUser } = require("baileys");

// Active sessions: groupJid → { participants: [], timeout, startedBy }
const activeSessions = new Map();
const JOIN_WINDOW_MS = 120_000; // 2 minutes to join
const MIN_PLAYERS = 2;

module.exports = {
  command: {
    pattern: "roulette",
    desc: "Roulette russe de groupe — qui sera éliminé ?",
    type: "games",
    fromMe: false,
    onlyGroup: true,
  },

  async execute(message, args) {
    const sub = (args || "").toLowerCase().trim();

    if (sub === "start") {
      if (activeSessions.has(message.jid)) {
        return await message.reply("⚠️ Une session est déjà en cours ! Utilisez *.roulette join* pour participer.");
      }

      const session = {
        participants: [message.sender],
        startedBy: message.sender,
        timeout: null,
      };

      activeSessions.set(message.jid, session);
      const num = message.sender.split("@")[0];

      // Auto-fire after 2 minutes if not enough players
      session.timeout = setTimeout(async () => {
        const s = activeSessions.get(message.jid);
        if (!s) return;
        if (s.participants.length < MIN_PLAYERS) {
          activeSessions.delete(message.jid);
          await message.client.getSocket().sendMessage(message.jid, {
            text: `⏰ La session roulette a expiré — pas assez de joueurs (${s.participants.length}/${MIN_PLAYERS} requis).`,
          });
        } else {
          await fireSpin(message.jid, message.client);
        }
      }, JOIN_WINDOW_MS);

      return await message.reply(
        `🎯 *Roulette Russe — Session Ouverte !*\n\n` +
        `@${num} a ouvert la session !\n\n` +
        `Utilisez *.roulette join* pour participer.\n` +
        `La roulette sera tirée automatiquement dans 2 minutes ou quand *.roulette spin* est appelé.\n\n` +
        `_Joueurs actuels : @${num}_`,
        { mentions: [message.sender] }
      );
    }

    if (sub === "join") {
      const session = activeSessions.get(message.jid);
      if (!session) {
        return await message.reply("❌ Aucune session ouverte. Utilisez *.roulette start* pour démarrer.");
      }
      if (session.participants.includes(message.sender)) {
        return await message.reply("⚠️ Vous participez déjà !");
      }

      session.participants.push(message.sender);
      const mentions = session.participants;
      const playerList = mentions.map((p) => `@${p.split("@")[0]}`).join(", ");

      return await message.reply(
        `✅ @${message.sender.split("@")[0]} a rejoint la roulette !\n\n*Joueurs (${mentions.length}) :* ${playerList}`,
        { mentions }
      );
    }

    if (sub === "spin" || sub === "fire") {
      const session = activeSessions.get(message.jid);
      if (!session) return await message.reply("❌ Aucune session ouverte.");
      const isAdmin = await message.isSenderAdmin();
      if (session.startedBy !== message.sender && !isAdmin && !message.isSudo()) {
        return await message.reply("❌ Seul l'organisateur ou un admin peut tirer la roulette.");
      }
      if (session.participants.length < MIN_PLAYERS) {
        return await message.reply(`❌ Il faut au moins ${MIN_PLAYERS} joueurs. (${session.participants.length} actuellement)`);
      }
      clearTimeout(session.timeout);
      await fireSpin(message.jid, message.client);
      return;
    }

    if (sub === "stop") {
      const session = activeSessions.get(message.jid);
      if (!session) return await message.reply("❌ Aucune session en cours.");
      clearTimeout(session.timeout);
      activeSessions.delete(message.jid);
      return await message.reply("🛑 Session roulette annulée.");
    }

    return await message.reply(
      `*🎯 Roulette Russe*\n\n*Usage :*\n.roulette start → ouvrir une session\n.roulette join → rejoindre\n.roulette spin → tirer la roulette\n.roulette stop → annuler\n\n_Un joueur sera sélectionné aléatoirement comme "perdant" (juste pour le fun !)_`
    );
  },
};

async function fireSpin(groupJid, client) {
  const session = activeSessions.get(groupJid);
  if (!session) return;

  activeSessions.delete(groupJid);

  const players = session.participants;
  const loser = players[Math.floor(Math.random() * players.length)];
  const loserNum = loser.split("@")[0];

  const countdownMsg = await client.getSocket().sendMessage(groupJid, {
    text: `🎯 *Tirage de la Roulette…*\n\n🔴 💥 BANG ! 💥 🔴\n\n${players.map((p) => `@${p.split("@")[0]}`).join(" ")}\n\n🎺 Le sort a parlé…`,
    mentions: players,
  });

  await new Promise((r) => setTimeout(r, 2000));

  await client.getSocket().sendMessage(groupJid, {
    text: `💀 *@${loserNum} a été éliminé par la roulette !*\n\n_Meilleure chance la prochaine fois…_ 😅\n\n_(Seulement pour le fun — pas d'expulsion réelle)_`,
    mentions: [loser],
  });
}
