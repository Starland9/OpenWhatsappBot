const {
  sendButtons,
  sendInteractiveMessage,
} = require("@ryuu-reinzz/button-helper");
const { getLang } = require("../lib/utils/language");
const { safeLog } = require("../lib/utils/http");
const buttonRegistry = require("../lib/utils/buttonRegistry");

/**
 * Shared helper for sending interactive WhatsApp buttons.
 * Wraps @ryuu-reinzz/button-helper with a numbered plain-text fallback.
 *
 * Every send (interactive or fallback) records the offered ids in display order
 * in the button registry, so that a reply "2" that quotes the message is turned
 * into the second id by the pipeline (research R8).
 *
 * Common options: { title, footer, quoted, mentions }
 *  - quoted: the message to quote (a WAMessage, e.g. message.data); it goes in the
 *    sendMessage options, never in the content
 *  - mentions: array of JIDs to mention in the text
 */

const MAX_BUTTONS_PER_MESSAGE = 3;
const DEFAULT_FOOTER = "OpenWhatsappBot";

function sendOptions(opts) {
  return opts.quoted ? { quoted: opts.quoted } : {};
}

function mentionList(opts) {
  return Array.isArray(opts.mentions) ? opts.mentions.filter(Boolean) : [];
}

/** Plain text message (no ids to record) */
async function sendText(sock, jid, text, opts) {
  const mentions = mentionList(opts);
  return await sock.sendMessage(
    jid,
    { text, ...(mentions.length ? { mentions } : {}) },
    sendOptions(opts),
  );
}

/**
 * Send a native-flow interactive message.
 * Without mentions the helper builds the payload itself; with mentions the
 * interactiveMessage is built here so that contextInfo.mentionedJid can be set.
 * @param {"buttons"|"list"} kind
 * @param {Array<{name:string,buttonParamsJson:string}>} nativeButtons
 */
async function sendNative(sock, jid, kind, payload, opts) {
  const { text, nativeButtons, quickButtons } = payload;
  const title = opts.title;
  const footer = opts.footer || DEFAULT_FOOTER;
  const mentions = mentionList(opts);
  const options = sendOptions(opts);

  if (mentions.length) {
    return await sendInteractiveMessage(
      sock,
      jid,
      {
        interactiveMessage: {
          ...(title ? { header: { title, hasMediaAttachment: false } } : {}),
          body: { text },
          footer: { text: footer },
          nativeFlowMessage: { buttons: nativeButtons },
          contextInfo: { mentionedJid: mentions },
        },
      },
      options,
    );
  }

  if (kind === "buttons") {
    return await sendButtons(
      sock,
      jid,
      { text, title, footer, buttons: quickButtons },
      options,
    );
  }
  return await sendInteractiveMessage(
    sock,
    jid,
    { text, title, footer, interactiveButtons: nativeButtons },
    options,
  );
}

/** Record the ids of a sent message; never throws */
function recordIds(sent, ids) {
  try {
    buttonRegistry.record(sent, ids);
  } catch (err) {
    console.error("button registry:", safeLog(err));
  }
}

/**
 * Send a quick-reply button message.
 * @param {object} sock - Baileys socket
 * @param {string} jid - Target JID
 * @param {string} text - Body text
 * @param {Array<{id:string,text:string}>} buttons - 1-3 buttons
 * @param {object} [opts] - { title, footer, quoted, mentions }
 */
async function sendQuickReplies(sock, jid, text, buttons, opts = {}) {
  if (!sock || !jid) return null;
  const safeButtons = Array.isArray(buttons)
    ? buttons.slice(0, MAX_BUTTONS_PER_MESSAGE)
    : [];

  if (safeButtons.length === 0) {
    return await sendText(sock, jid, text, opts);
  }

  // The helper gives a button without id the id "quick_<n>"
  const ids = safeButtons.map((b, i) => b.id || `quick_${i + 1}`);

  try {
    const sent = await sendNative(
      sock,
      jid,
      "buttons",
      {
        text,
        quickButtons: safeButtons,
        nativeButtons: safeButtons.map((b, i) => ({
          name: "quick_reply",
          buttonParamsJson: JSON.stringify({
            display_text: b.text || `Button ${i + 1}`,
            id: ids[i],
          }),
        })),
      },
      opts,
    );
    recordIds(sent, ids);
    return sent;
  } catch (err) {
    console.error("sendQuickReplies fallback:", safeLog(err));
    const lines = safeButtons
      .map((b, i) => `  ${i + 1}. ${b.text || ""}`)
      .join("\n");
    const sent = await sendText(
      sock,
      jid,
      `${text}\n\n${lines}\n\n_${getLang("plugins.buttons.reply_number")}_`,
      opts,
    );
    recordIds(sent, ids);
    return sent;
  }
}

/**
 * Send a single-select list (button with a picker).
 * @param {object} sock
 * @param {string} jid
 * @param {string} text
 * @param {Array<{title:string,rows:Array<{id:string,title:string,description?:string}>}>} sections
 * @param {object} [opts] - { buttonLabel, title, footer, quoted, mentions }
 */
async function sendList(sock, jid, text, sections, opts = {}) {
  if (!sock || !jid) return null;
  if (!Array.isArray(sections) || sections.length === 0) {
    return await sendText(sock, jid, text, opts);
  }

  const buttonText = opts.buttonLabel || getLang("plugins.buttons.open_menu");
  // Rows flattened section by section: this is the numbering of the fallback
  const ids = sections.flatMap((s) => s.rows.map((r) => r.id));

  try {
    const sent = await sendNative(
      sock,
      jid,
      "list",
      {
        text,
        nativeButtons: [
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
      },
      opts,
    );
    recordIds(sent, ids);
    return sent;
  } catch (err) {
    console.error("sendList fallback:", safeLog(err));
    let n = 0;
    let fallback = `${text}\n`;
    sections.forEach((s) => {
      fallback += `\n*${s.title}*\n`;
      s.rows.forEach((r) => {
        n += 1;
        fallback += `  ${n}. ${r.title}${r.description ? ` — _${r.description}_` : ""}\n`;
      });
    });
    fallback += `\n_${getLang("plugins.buttons.pick_list")}_`;
    const sent = await sendText(sock, jid, fallback, opts);
    recordIds(sent, ids);
    return sent;
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
  const yesText = opts.yesText || getLang("plugins.buttons.yes");
  const noText = opts.noText || getLang("plugins.buttons.no");
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
 * Send a paginated list with prev/next navigation.
 * The navigation entries are an extra last section of the same list, so the
 * user can both navigate and select in one message (and the numeric fallback
 * covers both). The ids are `<baseId>_nav_prev` and `<baseId>_nav_next`.
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
  const navRows = [];

  if (page > 0) {
    navRows.push({ id: `${navId}_prev`, title: getLang("plugins.buttons.prev") });
  }
  if (page < totalPages - 1) {
    navRows.push({ id: `${navId}_next`, title: getLang("plugins.buttons.next") });
  }

  if (navRows.length === 0) {
    return await sendList(sock, jid, text, sections, opts);
  }

  // Nothing to select: navigation buttons only
  if (!Array.isArray(sections) || sections.length === 0) {
    return await sendQuickReplies(
      sock,
      jid,
      text,
      navRows.map((r) => ({ id: r.id, text: r.title })),
      opts,
    );
  }

  return await sendList(
    sock,
    jid,
    text,
    [...sections, { title: getLang("plugins.buttons.nav_title"), rows: navRows }],
    opts,
  );
}

module.exports = {
  sendQuickReplies,
  sendList,
  sendConfirm,
  sendPaginatedList,
  MAX_BUTTONS_PER_MESSAGE,
};
