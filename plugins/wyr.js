/**
 * Would You Rather Plugin (WYR)
 * Interactive choice game with quick_reply buttons
 */

const { sendGroupButtons } = require("../lib/utils/buttonHelper");

// 100+ scenarios
const SCENARIOS = [
  ["voler comme un oiseau", "nager comme un dauphin"],
  ["vivre sans musique", "vivre sans télévision"],
  ["être invisible", "voler"],
  ["voyager dans le passé", "voyager dans le futur"],
  ["parler toutes les langues", "jouer de tous les instruments"],
  ["toujours avoir froid", "toujours avoir chaud"],
  ["ne jamais mentir", "ne jamais dire de vérité"],
  ["avoir des super-pouvoirs secrets", "être célèbre dans le monde entier"],
  ["manger uniquement des légumes", "boire uniquement de l'eau"],
  ["avoir une mémoire parfaite", "oublier tous les mauvais souvenirs"],
  ["vivre sans internet", "vivre sans téléphone portable"],
  ["travailler la nuit", "travailler le week-end"],
  ["avoir 10 frères et sœurs", "être enfant unique"],
  ["savoir tout", "avoir tout"],
  ["vivre 200 ans en mauvaise santé", "vivre 80 ans en parfaite santé"],
  ["ne plus jamais rire", "ne plus jamais pleurer"],
  ["parler avec les animaux", "parler avec les plantes"],
  ["être le plus grand", "être le plus petit"],
  ["avoir une Ferrari sans permis", "avoir un vélo avec permis"],
  ["être riche et seul", "être pauvre entouré d'amis"],
  ["toujours gagner aux jeux", "toujours perdre au sport"],
  ["vivre sur une île déserte", "vivre dans une grande ville bondée"],
  ["avoir des yeux derrière la tête", "avoir des oreilles sur les mains"],
  ["ne jamais dormir", "dormir 20h par jour"],
  ["être le meilleur ami de ton ennemi", "être l'ennemi de ton meilleur ami"],
  ["avoir une maison sans cuisine", "avoir une cuisine sans maison"],
  ["connaître la date de ta mort", "connaître le nom de ton futur amour"],
  ["devenir un animal au choix", "devenir un objet au choix"],
  ["vivre dans les années 80", "vivre dans les années 20 du futur"],
  ["ne jamais avoir faim", "ne jamais avoir sommeil"],
];

// Active votes: groupJid → { scenario, a, b, votesA: Set, votesB: Set, timeout }
const activeVotes = new Map();
const VOTE_DURATION_MS = 30_000; // 30 seconds

module.exports = {
  command: {
    pattern: "wyr",
    desc: "Would You Rather — faites un choix cornélien !",
    type: "games",
    fromMe: false,
    onlyGroup: true,
  },

  async execute(message) {
    if (activeVotes.has(message.jid)) {
      return await message.reply("⚠️ Un vote est déjà en cours ! Attendez qu'il se termine.");
    }

    const scenario = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
    const [a, b] = scenario;
    const voteId = `wyr_${Date.now()}`;

    const vote = {
      a,
      b,
      votesA: new Set(),
      votesB: new Set(),
      timeout: null,
      voteId,
    };

    activeVotes.set(message.jid, vote);

    const sock = message.client.getSocket();
    const jid = message.jid;

    try {
      await sendGroupButtons(sock, jid, {
        title: "🤔 Would You Rather",
        text: `*Préféreriez-vous…*\n\n🅰️ *${a}*\n\n— ou —\n\n🅱️ *${b}*\n\n_Vote ouvert pendant 30 secondes !_`,
        footer: "Tapez A ou B pour voter !",
        buttons: [
          { id: `${voteId}_A`, text: `🅰️ ${a.slice(0, 20)}${a.length > 20 ? "…" : ""}` },
          { id: `${voteId}_B`, text: `🅱️ ${b.slice(0, 20)}${b.length > 20 ? "…" : ""}` },
        ],
      });
    } catch (_) {
      await message.reply(
        `*🤔 Would You Rather*\n\n*Préféreriez-vous…*\n\n🅰️ *${a}*\n\n— ou —\n\n🅱️ *${b}*\n\n_Répondez *A* ou *B* dans les 30 secondes !_`
      );
    }

    // Auto-close vote
    vote.timeout = setTimeout(async () => {
      const v = activeVotes.get(jid);
      if (!v || v.voteId !== voteId) return;
      activeVotes.delete(jid);

      const totalA = v.votesA.size;
      const totalB = v.votesB.size;
      const total = totalA + totalB;

      if (total === 0) {
        await sock.sendMessage(jid, { text: "📊 Personne n'a voté !" });
        return;
      }

      const pctA = Math.round((totalA / total) * 100);
      const pctB = 100 - pctA;
      const winner = totalA >= totalB ? `🅰️ ${a}` : `🅱️ ${b}`;

      await sock.sendMessage(jid, {
        text: `📊 *Résultats — Would You Rather*\n\n🅰️ *${a}*\n${"█".repeat(Math.round(pctA / 5))} ${pctA}% (${totalA} votes)\n\n🅱️ *${b}*\n${"█".repeat(Math.round(pctB / 5))} ${pctB}% (${totalB} votes)\n\n🏆 *Gagnant :* ${winner}`,
      });
    }, VOTE_DURATION_MS);
  },

  // Handle vote responses (A/B text or button IDs)
  async handleMessage(message) {
    const vote = activeVotes.get(message.jid);
    if (!vote) return false;

    const body = message.body.trim().toUpperCase();

    // Handle quick_reply button ID
    const isButtonA = body === `${vote.voteId}_A` || body === "A";
    const isButtonB = body === `${vote.voteId}_B` || body === "B";

    if (!isButtonA && !isButtonB) return false;

    // Prevent double voting
    if (vote.votesA.has(message.sender) || vote.votesB.has(message.sender)) {
      return true; // Already voted, silently acknowledge
    }

    if (isButtonA) {
      vote.votesA.add(message.sender);
    } else {
      vote.votesB.add(message.sender);
    }

    await message.react("✅");
    return true;
  },
};
