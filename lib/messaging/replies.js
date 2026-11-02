"use strict";

/**
 * Reply capture of the messaging API (feature 004, contracts/runtime.md section 7, data-model.md 3.2): what a person
 * answered to an interactive API message, recorded in `api_message_responses`.
 *
 *   WIRE_PREFIX            "api:reply:"
 *   wireId(waId, id)       the id of a button or row on the wire: api:reply:<waId>:<callerId>
 *   parseWireId(text)      -> { waId, id } | null
 *   handleButtonReply(message)   pipeline step 5 (taps and quoted numbers); true when the message is an API reply
 *   handlePollVote(message)      the `onMessage` hook for `pollUpdateMessage` votes; true when the poll is ours
 *   record({ row, kind, author, choiceIds, via, sourceId, at })   -> boolean (recorded)
 *   decodeVote(message, row)     -> { digests } | null: decrypts a vote with the poll's own secret
 *   describeResponses(row, responses)   -> the object of public-api.md 4.4 (null for a non-interactive format)
 *   authorLabel(jid)             PN: its digits; LID: "<digits>@lid"
 *   createReplies(options)       an independent instance (tests, the facade); the module's own exports are the default one
 *
 * RT-80 to RT-82. A wire id (`api:reply:`) is consumed by `plugins/apireplies.js` first and by nothing else, whatever
 * the switch; a reply after `repliesUntil`, for an unknown row, with the switch off, or past RESPONSES_MAX is consumed
 * and NOT recorded; the hooks never throw and stay cheap (one indexed lookup per candidate message).
 *
 * Votes (X19): Baileys rc14 does not decrypt poll votes itself, a vote arrives as a plain `pollUpdateMessage` whose
 * `vote` is `{ encPayload, encIv }`. `decodeVote` decrypts it with `decryptPollVote` and the 32-byte `messageSecret`
 * the engine generated and stored encrypted (`ApiMessage.pollSecret`, context "api-poll:" + publicId). The JID forms
 * WhatsApp signed with cannot be known offline, so the creator (the bot, PN or LID) and the voter (participant, its
 * alt, remoteJid, its alt) are combined, first success wins, at most 8 attempts. Which pair works is a phone check.
 * A bad or lost secret, no working pair or an expired `replyData` give a debug log and a counter, never an error and
 * never a record.
 *
 * What is never stored or logged: the question, the body, the descriptions (only the short labels of `choices` are
 * kept); `author` and `waId` are never logged. The module requires nothing heavy at load (`baileys` is loaded when a
 * vote is decoded) and creates no timer.
 */

const { Op, UniqueConstraintError } = require("sequelize");
const { LIMITS } = require("./limits");
const permissions = require("../utils/permissions");

const WIRE_PREFIX = "api:reply:";
const WIRE_ID = /^api:reply:([A-Za-z0-9]{10,40}):([A-Za-z0-9_.-]{1,64})$/;
const MAX_ATTEMPTS = 8;
const INTERACTIVE_FALLBACK = new Set(["poll", "buttons", "list"]);

const wireId = (waId, id) => `${WIRE_PREFIX}${waId}:${id}`;

function parseWireId(text) {
  if (typeof text !== "string") return null;
  const match = WIRE_ID.exec(text);
  return match ? { waId: match[1], id: match[2] } : null;
}

/** Milliseconds from a number, a Long-like object, a bigint or a numeric string; NaN otherwise */
function millisOf(value) {
  if (value === undefined || value === null) return NaN;
  if (typeof value === "object" && typeof value.toNumber === "function") return Number(value.toNumber());
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && !/^\d{1,16}$/.test(value)) return NaN;
  return Number(value);
}

/** PN: the digits; LID: "<digits>@lid"; anything else as given */
function authorLabel(jid) {
  const normal = permissions.normalizeJid(jid) || String(jid === undefined || jid === null ? "" : jid);
  const [user, server] = normal.split("@");
  return server === "lid" ? `${user}@lid` : user;
}

const iso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * @param {object} [options] every field optional: models, clock, apiState, formats, secretBox (each an object or a
 *   function returning it), decryptPollVote (replaces baileys' own), logger
 */
function createReplies(options = {}) {
  const pick = (name, load) => {
    const given = options[name];
    if (typeof given === "function") return given();
    return given !== undefined ? given : load();
  };
  const models = () => pick("models", () => require("../database"));
  const apiState = () => pick("apiState", () => require("../utils/apiState"));
  const formats = () => pick("formats", () => require("./formats"));
  const secretBox = () => pick("secretBox", () => require("../utils/secretBox"));
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const decryptPollVote = () => {
    if (typeof options.decryptPollVote === "function") return options.decryptPollVote;
    const lib = require("baileys");
    return lib.decryptPollVote || (lib.default && lib.default.decryptPollVote);
  };
  let log = null;
  const logger = () => {
    if (options.logger) return options.logger;
    if (!log) log = require("../utils/logger").createLogger("messaging-replies");
    return log;
  };
  const counters = { undecodable: 0, ignored: 0 };

  const isInteractive = (formatName) => {
    const format = formats().get(formatName);
    return format ? format.interactive === true : INTERACTIVE_FALLBACK.has(formatName);
  };

  // -------------------------------------------------------------------------------------------------------------------
  // Recording (data-model 3.2)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Record a selection. Ignored unless the message exists, `now <= repliesUntil` and it holds fewer than RESPONSES_MAX
   * responses. `choice` is append-only (one row per tap or numbered answer, a redelivery is a no-op); `vote` is "last
   * vote replaces": an UPDATE guarded by `respondedAt <= :t`, then an INSERT whose unique violation means a newer vote
   * exists. In a private chat the author is the row's `recipient` (the only person who can answer, whatever form
   * WhatsApp reports); in a group it is the participant.
   * @returns {Promise<boolean>} true when something was written
   */
  async function record({ row, kind, author, choiceIds, via, sourceId, at } = {}) {
    if (!row || !row.repliesUntil) return false;
    const now = clock();
    if (now > new Date(row.repliesUntil).getTime()) return false;
    const { ApiMessageResponse } = models();
    if ((await ApiMessageResponse.count({ where: { messageId: row.id } })) >= LIMITS.RESPONSES_MAX) {
      counters.ignored += 1;
      logger().debug({ publicId: row.publicId }, "reply ignored: the message holds the maximum number of responses");
      return false;
    }

    const known = new Set((Array.isArray(row.choices) ? row.choices : []).map((choice) => choice.id));
    const chosen = (Array.isArray(choiceIds) ? choiceIds : []).filter((id) => known.has(id));
    const who = String(row.recipient).endsWith("@g.us") ? permissions.normalizeJid(author) : row.recipient;
    if (!who) return false;
    const respondedAt = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date(Number.isFinite(Number(at)) ? Number(at) : now);

    try {
      if (kind === "choice") {
        if (chosen.length !== 1) return false;
        await ApiMessageResponse.create({ messageId: row.id, kind: "choice", author: who, choiceIds: chosen, via: via || null, sourceId: sourceId || null, respondedAt });
        return true;
      }
      if (kind !== "vote") return false;
      const [changed] = await ApiMessageResponse.update(
        { choiceIds: chosen, sourceId: sourceId || null, respondedAt },
        { where: { messageId: row.id, voterKey: who, respondedAt: { [Op.lte]: respondedAt } } },
      );
      if (changed) return true;
      await ApiMessageResponse.create({ messageId: row.id, kind: "vote", author: who, voterKey: who, choiceIds: chosen, via: null, sourceId: sourceId || null, respondedAt });
      return true;
    } catch (err) {
      if (err instanceof UniqueConstraintError || (err && err.name === "SequelizeUniqueConstraintError")) return false; // a redelivery, or a newer vote
      throw err;
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Poll votes (7.3)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Decrypt a vote with the poll's own secret. Tries the creator (the bot's phone number and LID, the LID first in a
   * LID-addressed chat) against the voter (participant, participantAlt, remoteJid, remoteJidAlt), normalised and
   * de-duplicated, first success wins, at most 8 attempts.
   * @returns {{ digests: string[] }|null} the selected options as lower-case SHA-256 hex digests; null when unreadable
   */
  function decodeVote(message, row) {
    try {
      const update = message && message.content && message.content.pollUpdateMessage;
      const vote = update && update.vote;
      const key = (message && message.key) || {};
      if (!vote || !vote.encPayload || !vote.encIv || !row || !row.pollSecret || !row.waId) {
        counters.undecodable += 1;
        return null;
      }
      const opened = secretBox().decrypt(row.pollSecret, `api-poll:${row.publicId}`);
      const secret = opened.ok ? Buffer.from(String(opened.value), "hex") : null;
      if (!secret || secret.length !== 32) {
        counters.undecodable += 1;
        logger().debug({ publicId: row.publicId }, "poll vote not decoded: the poll secret is unreadable");
        return null;
      }

      let sock = null;
      try {
        sock = message.client && typeof message.client.getSocket === "function" ? message.client.getSocket() : null;
      } catch {
        sock = null;
      }
      const bot = permissions.getBotJids(sock);
      const lidChat = [key.participant, key.remoteJid].some((jid) => typeof jid === "string" && jid.endsWith("@lid"));
      const creators = unique((lidChat ? [bot.lid, bot.pn] : [bot.pn, bot.lid]).filter(Boolean));
      const voters = unique([key.participant, key.participantAlt, key.remoteJid, key.remoteJidAlt].map(permissions.normalizeJid).filter((jid) => jid && !jid.endsWith("@g.us")));

      const decrypt = decryptPollVote();
      let attempts = 0;
      for (const pollCreatorJid of creators) {
        for (const voterJid of voters) {
          if (attempts >= MAX_ATTEMPTS) break;
          attempts += 1;
          try {
            const decoded = decrypt({ encPayload: vote.encPayload, encIv: vote.encIv }, { pollCreatorJid, pollMsgId: row.waId, pollEncKey: secret, voterJid });
            const selected = decoded && Array.isArray(decoded.selectedOptions) ? decoded.selectedOptions : [];
            return { digests: selected.map((option) => Buffer.from(option).toString("hex").toLowerCase()) };
          } catch {
            // not the pair WhatsApp signed with
          }
        }
      }
      counters.undecodable += 1;
      logger().debug({ publicId: row.publicId, attempts }, "poll vote not decoded: no candidate pair worked");
      return null;
    } catch (err) {
      counters.undecodable += 1;
      return null;
    }
  }

  const unique = (list) => [...new Set(list)];

  /** The author of a vote or a tap: the participant in a group (PN, else LID); the row's recipient otherwise (record forces it) */
  const authorOf = (message) => message.sender || message.senderLid || "";

  /** When the vote was cast: the poll update's own time, else the message's, else now */
  function voteTime(message) {
    const own = millisOf(message.content && message.content.pollUpdateMessage && message.content.pollUpdateMessage.senderTimestampMs);
    if (Number.isFinite(own) && own > 0) return new Date(own);
    const seconds = millisOf(message.data && message.data.messageTimestamp);
    return new Date(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : clock());
  }

  /**
   * `onMessage` hook: a `pollUpdateMessage` whose poll is one of ours is decoded and recorded, and consumed either way
   * (a vote has no body; consuming it keeps it out of `trackmessages`). A poll that is not ours returns false.
   */
  async function handlePollVote(message) {
    if (!message || message.type !== "pollUpdateMessage") return false;
    const update = message.content && message.content.pollUpdateMessage;
    const creationId = update && update.pollCreationMessageKey && update.pollCreationMessageKey.id;
    if (typeof creationId !== "string" || !creationId) return false;
    const row = await models().ApiMessage.findOne({ where: { waId: creationId } });
    if (!row) return false;
    try {
      if (!apiState().isEnabled()) return true; // consumed, not recorded
      const decoded = decodeVote(message, row);
      if (!decoded) return true;
      const format = formats().get(row.format);
      const selection = format && typeof format.interpretReply === "function" ? format.interpretReply({ row, event: { type: "vote", digests: decoded.digests } }) : null;
      if (selection) {
        await record({ row, kind: "vote", author: authorOf(message), choiceIds: selection.choiceIds, via: null, sourceId: message.id, at: voteTime(message) });
      }
    } catch (err) {
      logger().debug({ publicId: row.publicId, err: String((err && err.code) || (err && err.name) || "error") }, "poll vote not recorded");
    }
    return true;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Buttons and lists (7.2)
  // -------------------------------------------------------------------------------------------------------------------

  /** When the reply was sent: the message's own time, else now */
  function replyTime(message) {
    const seconds = millisOf(message.data && message.data.messageTimestamp);
    return new Date(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : clock());
  }

  /** A group row answers only inside its group; a private row accepts the reply of its chat (record forces the author) */
  const inRightChat = (row, message) => !String(row.recipient).endsWith("@g.us") || message.jid === row.recipient;

  /** The recorded selection of a tap or a numbered answer, written when everything allows it; never throws */
  async function recordChoice(row, message, event, via) {
    const format = formats().get(row.format);
    const selection = format && typeof format.interpretReply === "function" ? format.interpretReply({ row, event }) : null;
    if (!selection || !Array.isArray(selection.choiceIds) || selection.choiceIds.length !== 1) return;
    await record({ row, kind: "choice", author: authorOf(message), choiceIds: selection.choiceIds, via, sourceId: message.id, at: replyTime(message) });
  }

  /**
   * Pipeline step 5 (a message that quotes another one or is an interactive reply):
   *  (a) a wire id (`message.isInteractiveReply` and `api:reply:<waId>:<id>`): ALWAYS consumed, whatever the switch, the
   *      row or the window (nothing else may react); recorded only when the switch is on, the row exists, its window is
   *      open and, for a group row, the reply came from that group. A plain text that merely looks like a wire id is not
   *      an interactive reply and is left alone.
   *  (b) a bare number quoting one of the bot's own messages: looked up by the quoted WhatsApp id (rare, only replies to
   *      the bot's own messages); not an API message gives false, so the games' hooks proceed; an API message consumes it
   *      and records `interpretReply({ type: "number" })`.
   * @returns {Promise<boolean>}
   */
  async function handleButtonReply(message) {
    if (!message) return false;
    try {
      if (message.isInteractiveReply) {
        const wire = parseWireId(message.body);
        if (!wire) return false;
        if (apiState().isEnabled()) {
          const row = await models().ApiMessage.findOne({ where: { waId: wire.waId } });
          if (row && inRightChat(row, message)) await recordChoice(row, message, { type: "tap", id: wire.id }, "tap");
        }
        return true;
      }

      const digits = typeof message.body === "string" ? message.body.trim() : "";
      const quoted = message.quoted;
      if (!/^\d{1,3}$/.test(digits) || !quoted || !quoted.id || !quoted.key || quoted.key.fromMe !== true) return false;
      const row = await models().ApiMessage.findOne({ where: { waId: quoted.id } });
      if (!row) return false; // not ours: the games' hooks proceed
      if (apiState().isEnabled() && inRightChat(row, message)) await recordChoice(row, message, { type: "number", number: Number(digits) }, "number");
      return true;
    } catch (err) {
      logger().debug({ err: String((err && err.code) || (err && err.name) || "error") }, "reply not recorded");
      return Boolean(message.isInteractiveReply && parseWireId(message.body)); // a wire id stays consumed even when the lookup failed
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The object of public-api.md 4.4
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * @param {object} row  an ApiMessage (instance or plain)
   * @param {object[]} responses  its ApiMessageResponse rows
   * @returns {{ until: string|null, total: number, items: object[], totals: object[]|null }|null}
   */
  function describeResponses(row, responses) {
    if (!row || !isInteractive(row.format)) return null;
    const choices = Array.isArray(row.choices) ? row.choices : [];
    const labelOf = (id) => {
      const found = choices.find((choice) => choice.id === id);
      return found && typeof found.label === "string" ? found.label : null;
    };
    const rows = (Array.isArray(responses) ? responses : [])
      .map((response) => (response && typeof response.get === "function" ? response.get({ plain: true }) : response))
      .sort((a, b) => new Date(a.respondedAt) - new Date(b.respondedAt) || a.id - b.id);
    const items = rows.map((response) => ({
      at: iso(response.respondedAt),
      author: authorLabel(response.author),
      kind: response.kind,
      via: response.via || null,
      choices: (Array.isArray(response.choiceIds) ? response.choiceIds : []).map((id) => ({ id, label: labelOf(id) })),
    }));
    let totals = null;
    if (row.format === "poll" && choices.length) {
      totals = choices.map((choice) => ({
        id: choice.id,
        label: typeof choice.label === "string" ? choice.label : null,
        count: rows.filter((response) => response.kind === "vote" && Array.isArray(response.choiceIds) && response.choiceIds.includes(choice.id)).length,
      }));
    }
    return { until: iso(row.repliesUntil), total: items.length, items, totals };
  }

  return { wireId, parseWireId, handleButtonReply, handlePollVote, record, decodeVote, describeResponses, authorLabel, stats: () => ({ ...counters }) };
}

const defaultReplies = createReplies();

module.exports = { ...defaultReplies, createReplies, WIRE_PREFIX };
