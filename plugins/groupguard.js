const config = require("../config");
const { getLang } = require("../lib/utils/language");
const cooldown = require("../lib/utils/cooldown");
const bus = require("../lib/utils/events");
const warnings = require("../lib/utils/warnings");
const { createLogger } = require("../lib/utils/logger");
const { safeLog } = require("../lib/utils/http");
const {
  normalizeJid,
  jidUser,
  guardTarget,
  assertParticipantResult,
} = require("../lib/utils/permissions");
const { getGroupSettings } = require("./setwelcome");

/**
 * Group guard (specs/002-admin-panel: contracts/runtime.md section 7, research U3, U16, U17).
 *
 * Hook-only plugin: enforces the `antilink` and `antibot` columns of the `Group` row, which the panel (or
 * nothing else) sets. `mute` has no hook: the panel calls `groupSettingUpdate`.
 *
 *  - anti-link: a message with a link from a member who is neither a group admin nor an owner is deleted,
 *    the author is warned through the shared `Warn` rows (`WARN_LIMIT`, `WARN_MESSAGE`) and removed at the
 *    limit (`ANTILINK_MSG`). The rule is strict (U17): a command that contains a link is a violation too, and
 *    because this hook consumes the message, the command never runs. A VIP gets the deletion only.
 *  - anti-bot (U16): the id of the message tells a library from a phone. Only the shapes no WhatsApp client
 *    produces remove the sender (`ANTIBOT_MSG`); the 22-character `3EB0...` id (Baileys 7, probably WhatsApp
 *    Web too) is logged as a suspect once per sender and group per day and never acted on.
 *
 * Nothing happens unless the bot is a group admin. Cheapest checks first: the group row comes from the cached
 * `group:<jid>` lookup (the only database access on the hot path), the text and the id are matched next, and
 * the group metadata (`isBotAdmin`, `isSenderAdmin`) is only asked for when a rule matched. Runs after the
 * observers (role 10, trackmessages 20, afk 30, notify 40) and before the filters (90). Returns `true` only
 * when the message was deleted. Every action is also published on the core bus as `groupguard:action`
 * (`{ rule, groupJid, userJid, outcome }`); the admin audit turns `removed` and `suspect` into
 * `guard.antibot.remove` / `guard.antibot.suspect` rows, anything else is ignored there.
 */

const logger = createLogger("groupguard");

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * What counts as a link: a scheme URL, a `www.` host, a `chat.whatsapp.com` invite or a `wa.me` link. Bare
 * domains ("example.com") are not matched: too many false positives in ordinary sentences.
 */
const LINK_PATTERNS = Object.freeze([
  /\b[a-z][a-z0-9+.-]*:\/\/\S/i,
  /\bwww\.[a-z0-9][a-z0-9-]*\.[a-z]{2,}/i,
  /\bchat\.whatsapp\.com\b/i,
  /\bwa\.me\b/i,
]);

/** Does the text hold a link? (patterns carry no `g` flag: no state between calls) */
function containsLink(text) {
  if (typeof text !== "string" || !text) return false;
  return LINK_PATTERNS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Message ids (U16)
// ---------------------------------------------------------------------------

/**
 * Ids no WhatsApp client produces. `3EB0` + 36 upper-case hex characters is Baileys' `generateMessageID`
 * (node_modules/baileys/lib/Utils/generics.js, rc14; the 6.7.9 file has the same line). `BAE5` + 12 hex is
 * the scheme of earlier Baileys 6 releases: neither 6.7.9 nor rc14 contains it, so that shape is recalled,
 * not confirmed against a source here. A real capture that matches one of these patterns removes the
 * pattern; it is never narrowed by a heuristic.
 */
const BOT_ID_PATTERNS = Object.freeze([/^3EB0[0-9A-F]{36}$/, /^BAE5[0-9A-F]{12}$/]);

/** Ids of Baileys 7 `generateMessageIDV2` (`3EB0` + 18 hex), probably WhatsApp Web's too: logged, never acted on */
const SUSPECT_ID_PATTERNS = Object.freeze([/^3EB0[0-9A-F]{18}$/]);

/**
 * Classify the id of a message (anchored, case-sensitive).
 * @param {string} id key.id of the message
 * @returns {"bot"|"suspect"|null}
 */
function looksLikeBotId(id) {
  if (typeof id !== "string" || !id) return null;
  if (BOT_ID_PATTERNS.some((pattern) => pattern.test(id))) return "bot";
  if (SUSPECT_ID_PATTERNS.some((pattern) => pattern.test(id))) return "suspect";
  return null;
}

/** "3EB0-40": the shape that matched, as the audit "rule" (prefix and length, never the id itself) */
const ruleOfId = (id) => `${id.slice(0, 4)}-${id.length}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tag = (jid) => `@${jidUser(jid)}`;

function emit(rule, message, userJid, outcome) {
  bus.emitSafe("groupguard:action", { rule, groupJid: message.jid, userJid, outcome });
}

/**
 * The bot acting on the author: `guardTarget` refuses "yourself", and here the author is the target, so it
 * gets a stand-in without sender (bot, owners and group creator stay protected).
 */
const botActor = (message) => ({
  isGroup: true,
  jid: message.jid,
  sender: "",
  senderLid: "",
  client: message.client,
  getGroupMetadata: () => message.getGroupMetadata(),
});

/** Group-side id of the author (what `groupParticipantsUpdate` expects), or the sender as received */
async function participantIdOf(message) {
  const wanted = new Set([message.sender, message.senderLid].map(normalizeJid).filter(Boolean));
  const metadata = await message.getGroupMetadata();
  const found = (metadata?.participants || []).find((p) =>
    [p.id, p.phoneNumber, p.lid].some((x) => x && wanted.has(normalizeJid(x))),
  );
  return found ? found.id : message.sender || message.senderLid;
}

/** Delete the message for everybody. @returns {Promise<boolean>} false when WhatsApp refused */
async function deleteMessage(message) {
  try {
    await message.client.getSocket().sendMessage(message.jid, { delete: message.key });
    return true;
  } catch (err) {
    logger.warn({ err: err?.message, group: message.jid }, "groupguard: could not delete the message");
    return false;
  }
}

/** Plain message with a mention (never a reply to the deleted message) */
async function say(message, text, mentions) {
  try {
    await message.client.getSocket().sendMessage(message.jid, { text, mentions });
  } catch (err) {
    logger.warn({ err: err?.message, group: message.jid }, "groupguard: could not send the notice");
  }
}

/**
 * Remove the author: `guardTarget` first, then the removal checked per target.
 * @returns {Promise<"removed"|"refused"|"failed">}
 */
async function removeAuthor(message, targetId) {
  if (await guardTarget(botActor(message), targetId)) return "refused";
  try {
    return assertParticipantResult(await message.kick(targetId)) ? "removed" : "failed";
  } catch (err) {
    logger.warn({ err: safeLog(err), group: message.jid }, "groupguard: removal failed");
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** A "bot" id: remove the author, announce it, delete the message. */
async function handleBot(message, userJid) {
  const rule = ruleOfId(message.id);
  const targetId = await participantIdOf(message);
  const outcome = await removeAuthor(message, targetId);
  if (outcome !== "removed") {
    logger.warn({ group: message.jid, rule, outcome }, "anti-bot: sender not removed");
    return false;
  }
  emit(rule, message, userJid, "removed");
  logger.info({ group: message.jid, rule }, "anti-bot: sender removed");
  const mention = message.sender || message.senderLid;
  await say(message, warnings.fillPlaceholders(config.ANTIBOT_MSG, { "&mention": tag(mention) }), [mention]);
  return await deleteMessage(message);
}

/** A "suspect" id: one log line and one bus event per sender, group and day. Nothing else. */
function reportSuspect(message, userJid) {
  if (cooldown.hit(userJid, `antibot-suspect:${message.jid}`, DAY_MS) !== 0) return;
  const rule = ruleOfId(message.id);
  logger.warn({ group: message.jid, rule }, "anti-bot: suspect message id (logged only)");
  emit(rule, message, userJid, "suspect");
}

/** A link: delete, warn, remove at the limit. @returns {Promise<boolean>} whether the message was deleted */
async function handleLink(message, userJid) {
  const deleted = await deleteMessage(message);
  emit("antilink", message, userJid, "link_deleted");

  const mention = message.sender || message.senderLid;
  const forms = await warnings.identityForms(message, mention);
  if (await warnings.isVip(message, forms)) return deleted; // VIP: deleted, never warned or removed

  const row = await warnings.addWarning({
    forms,
    groupJid: message.jid,
    reason: getLang("groupguard.reason_link"),
  });
  const limit = config.WARN_LIMIT;
  await say(
    message,
    warnings.fillPlaceholders(config.WARN_MESSAGE, {
      "&mention": tag(mention),
      "&warn": row.count,
      "&remaining": Math.max(0, limit - row.count),
    }),
    [mention],
  );
  if (row.count < limit) return deleted;

  // Limit reached: the warnings are cleared only once the removal really worked
  const outcome = await removeAuthor(message, await participantIdOf(message));
  if (outcome === "removed") {
    await warnings.clearWarnings(forms, message.jid);
    emit("antilink", message, userJid, "link_removed");
    logger.info({ group: message.jid }, "anti-link: author removed at the warning limit");
    await say(message, warnings.fillPlaceholders(config.ANTILINK_MSG, { "&mention": tag(mention) }), [mention]);
  } else if (outcome === "failed") {
    await say(message, getLang("plugins.warnuser.kick_failed", tag(mention)), [mention]);
  } else {
    logger.warn({ group: message.jid }, "anti-link: author protected, not removed");
  }
  return deleted;
}

/**
 * Hook: enforce anti-link and anti-bot on a group message.
 * @returns {Promise<boolean>} true only when the message was deleted (the pipeline stops)
 */
async function onMessage(message) {
  if (!message.isGroup || message.fromMe) return false;

  const settings = await getGroupSettings(message.jid);
  if (!settings.antilink && !settings.antibot) return false;

  const link = Boolean(settings.antilink) && !message.isInteractiveReply && containsLink(message.body);
  const idClass = settings.antibot ? looksLikeBotId(message.id) : null;
  if (!link && !idClass) return false;

  // Without admin rights nothing can be enforced (the panel already warns about it)
  if (!(await message.isBotAdmin())) return false;
  // Owners and group admins are exempt, nobody else
  if (message.isSudo() || (await message.isSenderAdmin())) return false;

  try {
    const userJid = message.sender || message.senderLid;
    if (idClass === "bot") return await handleBot(message, userJid);
    if (idClass === "suspect") reportSuspect(message, userJid);
    if (link) return await handleLink(message, userJid);
  } catch (err) {
    logger.error({ err: safeLog(err), group: message.jid }, "groupguard: enforcement failed");
  }
  return false;
}

module.exports = {
  // onMessage order (lower first, default 100): after the observers (role, tracking, afk, notify), before the filters
  hookPriority: { onMessage: 50 },

  onMessage,

  // Pure helpers, exported for the tests
  containsLink,
  looksLikeBotId,
  LINK_PATTERNS,
  BOT_ID_PATTERNS,
  SUSPECT_ID_PATTERNS,
};
