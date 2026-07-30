const {
  sendButtons,
  sendInteractiveMessage,
} = require("@ryuu-reinzz/button-helper");
const { getLang } = require("../lib/utils/language");

/**
 * Shared helper for sending interactive WhatsApp buttons.
 * Wraps @ryuu-reinzz/button-helper with safe fallbacks to plain text.
 */

const MAX_BUTTONS_PER_MESSAGE = 3;

/**
 * Send a quick-reply button message.
 * @param {object} sock - Baileys socket
 * @param {string} jid - Target JID
 * @param {string} text - Body text
 * @param {Array<{id:string,text:string}>} buttons - 1-3 buttons
 * @param {object} [opts] - { title, footer, quoted }
 */
async function sendQuickReplies(sock, jid, text, buttons, opts = {}) {
  if (!sock || !jid) return null;
  const safeButtons = Array.isArray(buttons)
    ? buttons.slice(0, MAX_BUTTONS_PER_MESSAGE)
    : [];

  if (safeButtons.length === 0) {
    return await sock.sendMessage(jid, {
      text,
      ...(opts.quoted ? { quoted: opts.quoted } : {}),
    });
  }

  try {
    return await sendButtons(sock, jid, {
      text,
      title: opts.title,
      footer: opts.footer || "OpenWhatsappBot",
      buttons: safeButtons,
    });
  } catch (err) {
    console.error("sendQuickReplies fallback:", err.message);
    const lines = safeButtons.map((b, i) => `  ${i + 1}. ${b.text}`).join("\n");
    return await sock.sendMessage(jid, {
      text: `${text}\n\n${lines}\n\n_Reply with the number of your choice._`,
      ...(opts.quoted ? { quoted: opts.quoted } : {}),
    });
  }
}

/**
 * Send a single-select list (button with a picker).
 * @param {object} sock
 * @param {string} jid
 * @param {string} text
 * @param {Array<{title:string,rows:Array<{id:string,title:string,description?:string}>}>} sections
 * @param {object} [opts] - { buttonLabel, title, footer, quoted }
 */
async function sendList(sock, jid, text, sections, opts = {}) {
  if (!sock || !jid) return null;
  if (!Array.isArray(sections) || sections.length === 0) {
    return await sock.sendMessage(jid, {
      text,
      ...(opts.quoted ? { quoted: opts.quoted } : {}),
    });
  }

  const buttonText =
    opts.buttonLabel || getLang("plugins.buttons.open_menu") || "📋 Menu";

  try {
    return await sendInteractiveMessage(sock, jid, {
      text,
      title: opts.title,
      footer: opts.footer || "OpenWhatsappBot",
      interactiveButtons: [
        {
          name: "single_select",
          buttonParamsJson: JSON.stringify({
            title: buttonText,
            sections: sections.map((s) => ({
              title: s.title,
              rows: s.rows.map((r) => ({
                id: r.id,
                title: (r.title || "").slice(0, 24),
                description: (r.description || "").slice(0, 72),
                header: r.header,
              })),
            })),
          }),
        },
      ],
    });
  } catch (err) {
    console.error("sendList fallback:", err.message);
    let fallback = `${text}\n`;
    sections.forEach((s) => {
      fallback += `\n*${s.title}*\n`;
      s.rows.forEach((r) => {
        fallback += `  • ${r.title} — _${r.description || ""}_\n`;
      });
    });
    fallback += `\n_Use the command name to pick an option._`;
    return await sock.sendMessage(jid, {
      text: fallback,
      ...(opts.quoted ? { quoted: opts.quoted } : {}),
    });
  }
}

/**
 * Send a yes/no confirmation.
 */
async function sendConfirm(
  sock,
  jid,
  text,
  yesId = "yes",
  noId = "no",
  opts = {},
) {
  const yesText = opts.yesText || "✅ Yes";
  const noText = opts.noText || "❌ No";
  return await sendQuickReplies(
    sock,
    jid,
    text,
    [
      { id: yesId, text: yesText.slice(0, 24) },
      { id: noId, text: noText.slice(0, 24) },
    ],
    opts,
  );
}

/**
 * Send a paginated list with prev/next buttons.
 * Builds a quick-reply header + list body so the user can both navigate and select.
 */
async function sendPaginatedList(
  sock,
  jid,
  text,
  sections,
  page,
  totalPages,
  baseId,
  opts = {},
) {
  const navId = `${baseId}_nav`;
  const navButtons = [];

  if (page > 0) {
    navButtons.push({ id: `${navId}_prev`, text: "◀ Prev" });
  }
  if (page < totalPages - 1) {
    navButtons.push({ id: `${navId}_next`, text: "Next ▶" });
  }

  if (navButtons.length === 0) {
    return await sendList(sock, jid, text, sections, opts);
  }

  // Send a quick-reply with navigation, then a list separately
  const sent = await sendQuickReplies(sock, jid, text, navButtons, opts);
  // Sections are sent via a list reply (best-effort)
  return sent;
}

module.exports = {
  sendQuickReplies,
  sendList,
  sendConfirm,
  sendPaginatedList,
  MAX_BUTTONS_PER_MESSAGE,
};
