/**
 * Captcha Handler
 * Sends a math captcha to new group members and kicks them if they don't answer
 */

const { Group } = require("../database");

// Pending captchas: `${groupJid}:${userJid}` → { answer, timeout, msgJid }
const pendingCaptchas = new Map();

/**
 * Handle a group-participants.update event
 * @param {object} update - { id: groupJid, participants: [jid], action: 'add'|'remove'|... }
 * @param {object} client - WhatsAppClient instance
 */
async function handleParticipantsUpdate(update, client) {
  const { id: groupJid, participants, action } = update;
  if (action !== "add") return;

  try {
    const group = await Group.findOne({ where: { jid: groupJid } });
    if (!group || !group.captchaEnabled) return;

    const sock = client.getSocket();
    if (!sock) return;

    for (const participant of participants) {
      const num = participant.split("@")[0];

      // Generate math question
      const a = Math.floor(Math.random() * 10) + 1;
      const b = Math.floor(Math.random() * 10) + 1;
      const answer = String(a + b);

      await sock.sendMessage(groupJid, {
        text: `👋 Bienvenue @${num} !\n\n🔐 *Vérification anti-bot :*\nCombien font *${a} + ${b}* ?\n\nRépondez dans les 60 secondes ou vous serez expulsé.`,
        mentions: [participant],
      });

      const key = `${groupJid}:${participant}`;

      // Set kick timeout
      const timeout = setTimeout(async () => {
        if (pendingCaptchas.has(key)) {
          pendingCaptchas.delete(key);
          try {
            await sock.groupParticipantsUpdate(groupJid, [participant], "remove");
            await sock.sendMessage(groupJid, {
              text: `⛔ @${num} a été expulsé pour ne pas avoir complété le captcha.`,
              mentions: [participant],
            });
          } catch (_) {}
        }
      }, 60_000);

      pendingCaptchas.set(key, { answer, timeout });
    }
  } catch (_) {
    // Non-blocking
  }
}

/**
 * Check if an incoming message is a captcha answer
 * @param {import('../classes/Message').Message} message
 * @returns {boolean}
 */
async function handleMessage(message) {
  if (!message.isGroup || !message.body) return false;

  const key = `${message.jid}:${message.sender}`;
  const pending = pendingCaptchas.get(key);
  if (!pending) return false;

  if (message.body.trim() === pending.answer) {
    clearTimeout(pending.timeout);
    pendingCaptchas.delete(key);
    const num = message.sender.split("@")[0];
    await message.client.getSocket().sendMessage(message.jid, {
      text: `✅ Bienvenue @${num}, captcha validé !`,
      mentions: [message.sender],
    });
    return true;
  }

  return false;
}

module.exports = { handleParticipantsUpdate, handleMessage };
