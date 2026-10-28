const { getLang } = require("../lib/utils/language");
const config = require("../config");
const { safeLog } = require("../lib/utils/http");
const { normalizeJid, jidUser } = require("../lib/utils/permissions");
const {
  getGroupSettings,
  invalidateGroupSettings,
  resolveParticipants,
  renderTemplate,
  mentionText,
  isChatDisabled,
  fetchGroupInfo,
  findOrCreateGroup,
} = require("./setwelcome");

/**
 * Goodbye plugin
 *   .goodbye              → current settings and a preview
 *   .goodbye on|off       → enable / disable the goodbye message
 *   .goodbye reset        → back to the default message
 *   .goodbye <text>       → set the message (placeholders @user @group)
 *
 * `onGroupParticipants` posts the message when members leave or are removed
 * (one message per event, mentioning everyone concerned).
 */

const MAX_TEMPLATE_LENGTH = 1000;
// Default value of Group.goodbyeMsg in the model: treated as "not customised"
const LEGACY_DEFAULT_TEMPLATE = "Goodbye @user";

const isDefaultTemplate = (text) =>
  !text || !String(text).trim() || text === LEGACY_DEFAULT_TEMPLATE;

/**
 * Message to post: the group's own text, otherwise a localized default.
 * @param {object} settings - Group row
 * @param {boolean} [voluntary=true] - the member left on their own (wording of the default only)
 */
function goodbyeTemplate(settings, voluntary = true) {
  if (!isDefaultTemplate(settings.goodbyeMsg)) return settings.goodbyeMsg;
  return voluntary
    ? getLang("plugins.goodbye.default_left")
    : getLang("plugins.goodbye.default_removed");
}

/** True when the author of the event is the (single) participant: they left on their own */
function leftVoluntarily(update, people) {
  const author = normalizeJid(update.author);
  return !!author && people.length === 1 && people[0].forms.includes(author);
}

/** The message as it would look for the sender in this group (@desc is not available here) */
async function previewOf(message, group) {
  const metadata = await message.getGroupMetadata();
  return renderTemplate(goodbyeTemplate(group), {
    user: `@${jidUser(message.sender)}`,
    group: metadata?.subject || group.name || "",
  });
}

async function showSettings(message, group) {
  const status = group.goodbye
    ? getLang("common.status_enabled")
    : getLang("common.status_disabled");
  const text = [
    getLang("plugins.goodbye.status", status),
    getLang("plugins.goodbye.current", goodbyeTemplate(group)),
    getLang("plugins.goodbye.preview", await previewOf(message, group)),
    getLang("plugins.goodbye.help", config.PREFIX),
  ].join("\n\n");
  return await message.reply(text, { mentions: [message.sender] });
}

/**
 * Hook: members left or were removed → post the goodbye message.
 * @param {{ id: string, author?: string, participants: Array<string|object>, action: string }} update
 * @param {object} client
 */
async function onGroupParticipants(update, client) {
  try {
    if (!update || update.action !== "remove" || !String(update.id).endsWith("@g.us")) return;

    const settings = await getGroupSettings(update.id);
    if (!settings.goodbye) return;
    if (await isChatDisabled(update.id)) return;

    const sock = client.getSocket();
    const people = resolveParticipants(update.participants, sock);
    if (!people.length) return;

    const jids = people.map((p) => p.jid);
    const info = await fetchGroupInfo(sock, update.id, settings.name || "");
    const text = renderTemplate(goodbyeTemplate(settings, leftVoluntarily(update, people)), {
      user: mentionText(jids),
      group: info.subject,
    });
    await sock.sendMessage(update.id, { text, mentions: jids });
  } catch (error) {
    console.error("goodbye: could not post the message", safeLog(error));
  }
}

module.exports = {
  command: {
    pattern: "goodbye",
    desc: getLang("plugins.goodbye.desc"),
    type: "admin",
    adminOnly: true,
  },

  async execute(message, argsString, ctx) {
    const raw = String(ctx?.rawArgs ?? argsString ?? "").trim();
    const action = raw.toLowerCase();
    const group = await findOrCreateGroup(message);

    if (!raw || action === "get") {
      return await showSettings(message, group);
    }

    if (action === "on" || action === "off") {
      group.goodbye = action === "on";
      await group.save();
      invalidateGroupSettings(message.jid);
      return await message.reply(
        group.goodbye
          ? getLang("plugins.goodbye.enabled")
          : getLang("plugins.goodbye.disabled"),
      );
    }

    if (action === "reset") {
      group.goodbyeMsg = null;
      await group.save();
      invalidateGroupSettings(message.jid);
      return await message.reply(getLang("plugins.goodbye.reset"));
    }

    if (raw.length > MAX_TEMPLATE_LENGTH) {
      return await message.reply(getLang("plugins.goodbye.too_long", MAX_TEMPLATE_LENGTH));
    }
    group.goodbyeMsg = raw;
    group.goodbye = true;
    await group.save();
    invalidateGroupSettings(message.jid);
    return await message.reply(
      getLang("plugins.goodbye.updated", await previewOf(message, group)),
      { mentions: [message.sender] },
    );
  },

  onGroupParticipants,

  // Used by the admin panel (effective template of a group)
  goodbyeTemplate,
  isDefaultTemplate,
};
