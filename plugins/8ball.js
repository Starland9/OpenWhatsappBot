/**
 * Magic 8 Ball Plugin
 */

const { sendGroupButtons } = require("../lib/utils/buttonHelper");

const RESPONSES = [
  "🔮 Il en est certain.",
  "🔮 C'est décidément ainsi.",
  "🔮 Sans aucun doute.",
  "🔮 Oui, absolument.",
  "🔮 Vous pouvez compter là-dessus.",
  "🔮 Comme je le vois, oui.",
  "🔮 Très probablement.",
  "🔮 Les perspectives sont bonnes.",
  "🔮 Oui.",
  "🔮 Les signes pointent vers oui.",
  "🎱 Réponse floue, réessayez.",
  "🎱 Posez à nouveau la question.",
  "🎱 Mieux vaut ne pas vous le dire maintenant.",
  "🎱 Impossible de prédire.",
  "🎱 Concentrez-vous et demandez à nouveau.",
  "❌ N'y comptez pas.",
  "❌ Ma réponse est non.",
  "❌ Mes sources disent non.",
  "❌ Perspectives pas très bonnes.",
  "❌ Très douteux.",
];

module.exports = {
  command: {
    pattern: "8ball",
    desc: "Posez une question à la boule magique 🎱",
    type: "games",
    fromMe: false,
    onlyGroup: false,
  },

  async execute(message, args) {
    if (!args || args.trim().length < 3) {
      return await message.reply(
        `*🎱 Boule Magique*\n\n*Usage :* .8ball <votre question>\n\n*Exemple :* .8ball Est-ce que demain sera une bonne journée ?`
      );
    }

    const response = RESPONSES[Math.floor(Math.random() * RESPONSES.length)];
    const question = args.trim();
    const sock = message.client.getSocket();

    try {
      await sendGroupButtons(sock, message.jid, {
        title: "🎱 Boule Magique",
        text: `*Question :* _${question}_\n\n${response}`,
        footer: "La boule magique a parlé",
        buttons: [
          { id: "8ball_again", text: "🎱 Poser à nouveau" },
        ],
      });
    } catch (_) {
      await message.reply(
        `*🎱 Boule Magique*\n\n*Question :* _${question}_\n\n${response}`
      );
    }
  },
};
