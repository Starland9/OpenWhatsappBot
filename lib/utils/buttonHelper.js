/**
 * Button Helper Wrapper
 * Wraps @ryuu-reinzz/button-helper for easy use in plugins
 * Usage: const { sendGroupButtons, sendInteractive } = require('../utils/buttonHelper');
 *        await sendGroupButtons(message.client.getSocket(), message.jid, { title, text, footer, buttons });
 */

const { sendButtons, sendInteractiveMessage } = require("@ryuu-reinzz/button-helper");

/**
 * Send simple buttons (quick_reply + CTA variants)
 * @param {object} sock - Baileys socket (message.client.getSocket())
 * @param {string} jid  - destination JID
 * @param {object} content - { title?, text, footer?, buttons: [{id, text}|{name, buttonParamsJson}] }
 */
async function sendGroupButtons(sock, jid, content) {
  return await sendButtons(sock, jid, content);
}

/**
 * Send interactive message with full native flow support
 * @param {object} sock - Baileys socket
 * @param {string} jid  - destination JID
 * @param {object} content - { text, footer?, title?, interactiveButtons: [...] }
 */
async function sendInteractive(sock, jid, content) {
  return await sendInteractiveMessage(sock, jid, content);
}

/**
 * Build a single_select section menu
 * @param {object} sock
 * @param {string} jid
 * @param {string} bodyText
 * @param {string} footerText
 * @param {string} menuTitle
 * @param {Array}  rows - [{ id, title, description? }]
 */
async function sendSelectMenu(sock, jid, bodyText, footerText, menuTitle, rows) {
  return await sendInteractiveMessage(sock, jid, {
    text: bodyText,
    footer: footerText,
    interactiveButtons: [
      {
        name: "single_select",
        buttonParamsJson: JSON.stringify({
          title: menuTitle,
          sections: [{ title: menuTitle, rows }],
        }),
      },
    ],
  });
}

module.exports = { sendGroupButtons, sendInteractive, sendSelectMenu };
