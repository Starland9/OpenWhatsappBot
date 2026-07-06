/**
 * Group Control Panel
 * Interactive button panel to toggle all group settings
 */

const { Group } = require("../lib/database");
const { sendInteractive } = require("../lib/utils/buttonHelper");

module.exports = {
  command: {
    pattern: "gcp",
    desc: "Panneau de contrôle du groupe (boutons interactifs)",
    type: "group",
    fromMe: false,
    onlyGroup: true,
  },

  async execute(message) {
    const isAdmin = await message.isSenderAdmin();
    if (!isAdmin && !message.isSudo()) {
      return await message.reply("❌ Réservé aux admins du groupe.");
    }

    const [group] = await Group.findOrCreate({
      where: { jid: message.jid },
      defaults: { jid: message.jid },
    });

    const on = "✅";
    const off = "❌";

    const statusText =
      `*⚙️ Panneau de Contrôle du Groupe*\n\n` +
      `Anti-Link :   ${group.antilink ? on : off}\n` +
      `Anti-Flood :  ${group.antiflood ? on : off}\n` +
      `Anti-Mots :   ${group.bannedWords ? on : off}\n` +
      `Bienvenue :   ${group.welcome ? on : off}\n` +
      `Captcha :     ${group.captchaEnabled ? on : off}\n` +
      `Antibot :     ${group.antibot ? on : off}\n` +
      `Mute bot :    ${group.mute ? on : off}\n\n` +
      `_Sélectionnez un paramètre à basculer_`;

    const sock = message.client.getSocket();

    try {
      await sendInteractive(sock, message.jid, {
        text: statusText,
        footer: "OpenWhatsappBot — GCP",
        interactiveButtons: [
          {
            name: "single_select",
            buttonParamsJson: JSON.stringify({
              title: "Paramètres du groupe",
              sections: [
                {
                  title: "Protection",
                  rows: [
                    { id: "gcp_antilink", title: `Anti-Link ${group.antilink ? on : off}`, description: "Bloquer les liens externes" },
                    { id: "gcp_antiflood", title: `Anti-Flood ${group.antiflood ? on : off}`, description: "Limiter les messages rapides" },
                    { id: "gcp_antibot", title: `Anti-Bot ${group.antibot ? on : off}`, description: "Empêcher les bots de rejoindre" },
                    { id: "gcp_captcha", title: `Captcha ${group.captchaEnabled ? on : off}`, description: "Vérifier les nouveaux membres" },
                  ],
                },
                {
                  title: "Messages",
                  rows: [
                    { id: "gcp_welcome", title: `Bienvenue ${group.welcome ? on : off}`, description: "Message d'accueil pour nouveaux" },
                    { id: "gcp_mute", title: `Mute Bot ${group.mute ? on : off}`, description: "Désactiver les réponses bot" },
                  ],
                },
              ],
            }),
          },
        ],
      });
    } catch (_) {
      // Fallback si les boutons ne fonctionnent pas
      await message.reply(statusText + "\n\n_Utilisez .antilink, .antiflood, .captcha, etc. pour modifier._");
    }
  },

  // Handle button selection responses
  async handleButtonResponse(message, group) {
    const id = message.body;
    if (!id || !id.startsWith("gcp_")) return false;

    const field = id.replace("gcp_", "");
    const fieldMap = {
      antilink: "antilink",
      antiflood: "antiflood",
      antibot: "antibot",
      captcha: "captchaEnabled",
      welcome: "welcome",
      mute: "mute",
    };

    const dbField = fieldMap[field];
    if (!dbField) return false;

    const current = group[dbField];
    await group.update({ [dbField]: !current });
    await message.reply(`✅ *${field}* : ${!current ? "activé" : "désactivé"}`);
    return true;
  },
};
