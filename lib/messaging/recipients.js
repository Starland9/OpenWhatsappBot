"use strict";

/**
 * Recipients of the messaging API (feature 004, contracts/runtime.md section 5): parsing, the recipient policy of a
 * key, the bot's own number, disabled chats, and the pick-step checks that need a live socket (reachability, group
 * posting, mentions). The API addresses numbers and groups only: a LID is never accepted, stored or compared
 * (RT-60). A refusal never echoes the number (RT-61) and nothing here logs a number in clear (RT-05).
 *
 *   parseRecipient(input)                -> { kind: "private", jid, number } | { kind: "group", jid, number: null }
 *                                           | { error: "invalid_format" }
 *   mask(jid)                            -> "237...03" | "group:5486" | "?"
 *   evaluatePolicy(policy, target)       -> Promise<{ ok: boolean }>   (list | known | anyone; null = no policy)
 *   isChatDisabled(target, { bannedChats })  -> Promise<boolean>
 *   resolveRecipient(to, { policy, sock, bannedChats })  -> Promise<Target>; throws MessagingError, in the fixed
 *                                           order parse, policy, own number, chat disabled (FR-032)
 *   getBotJids(sock)                     -> { pn, lid }: the socket's identity, completed by the last one seen
 *   isOwnNumber(target, sock)            -> boolean (the pick step re-checks it)
 *   verifyReachable(sock, target, { now })   -> { jid, skipped? } | { failure: "not_on_whatsapp" }; throws when transient
 *   verifyGroupPosting(sock, target)     -> { metadata } | { failure: "not_in_group" | "group_announce_only" }
 *   mentionJids(metadata, numbers)       -> [{ number, jid }]   (the group's own addressing form of each member)
 *
 * Heavy or cyclic collaborators (`lib/core/pipeline`, the database) are required lazily, inside the functions.
 */

const { MessagingError } = require("./errors");
const { LIMITS } = require("./limits");
const permissions = require("../utils/permissions");

const GROUP_ID = /^\d{5,25}(-\d+)?@g\.us$/;

// ---------------------------------------------------------------------------
// Parsing and masking
// ---------------------------------------------------------------------------

function parseRecipient(input) {
  if (typeof input !== "string") return { error: "invalid_format" };
  const text = input.trim();
  if (text.includes("@g.us")) {
    return GROUP_ID.test(text) ? { kind: "group", jid: text, number: null } : { error: "invalid_format" };
  }
  if (text.includes("@")) return { error: "invalid_format" };
  const parsed = permissions.parsePhoneNumber(text);
  if (parsed.error) return { error: "invalid_format" };
  return { kind: "private", jid: parsed.pn, number: parsed.digits };
}

function mask(jid) {
  if (typeof jid !== "string") return "?";
  const private_ = /^(\d{8,15})@s\.whatsapp\.net$/.exec(jid);
  if (private_) return `${private_[1].slice(0, 3)}...${private_[1].slice(-2)}`;
  const group = /^(\d{5,25})(?:-\d+)?@g\.us$/.exec(jid);
  if (group) return `group:${group[1].slice(-4)}`;
  return "?";
}

// ---------------------------------------------------------------------------
// Policy, own number, disabled chat
// ---------------------------------------------------------------------------

/** @returns {Promise<{ ok: boolean }>} an unknown mode fails closed */
async function evaluatePolicy(policy, target) {
  if (!policy) return { ok: true };
  switch (policy.mode) {
    case "anyone":
      return { ok: true };
    case "list":
      return { ok: Array.isArray(policy.entries) && policy.entries.includes(target.jid) };
    case "known":
      return { ok: await require("../utils/knownChats").isKnown(target.jid) };
    default:
      return { ok: false };
  }
}

let lastIdentity = { pn: "", lid: "" };

/** The socket's own identity; the last one seen in this process completes it (a disconnected bot has no socket) */
function getBotJids(sock) {
  const seen = permissions.getBotJids(sock);
  if (seen.pn) lastIdentity.pn = seen.pn;
  if (seen.lid) lastIdentity.lid = seen.lid;
  return { pn: seen.pn || lastIdentity.pn, lid: seen.lid || lastIdentity.lid };
}

const socketOf = (sock) => (typeof sock === "function" ? sock() : sock);

/** Is the target the bot's own number? False, not an error, when no identity was ever seen */
function isOwnNumber(target, sock) {
  const bot = getBotJids(socketOf(sock) || null);
  return Boolean(bot.pn) && target.kind === "private" && target.jid === bot.pn;
}

async function bannedSetOf(source) {
  let value = source;
  if (typeof value === "function") value = value();
  if (value === undefined || value === null) value = require("../core/pipeline").getBannedChats();
  value = await value;
  if (value instanceof Set) return value;
  return new Set(Array.isArray(value) ? value : []);
}

/**
 * A disabled chat: the pipeline's cached set, tested for the target AND for the `jid` of any KnownChat row whose
 * `pnJid` is the target (the ban command stores `message.jid`, a LID in LID-addressed chats; the same double test
 * as knownChats.isSelectable).
 */
async function isChatDisabled(target, { bannedChats } = {}) {
  const banned = await bannedSetOf(bannedChats);
  if (banned.size === 0) return false;
  if (banned.has(target.jid)) return true;
  if (target.kind !== "private") return false;
  const { KnownChat } = require("../database");
  if (!KnownChat) return false;
  const rows = await KnownChat.findAll({ where: { pnJid: target.jid }, attributes: ["jid"], raw: true });
  return rows.some((row) => banned.has(row.jid));
}

/**
 * Parse, policy, own number, disabled chat: the first failure answers (FR-032).
 * @throws {MessagingError} validation_failed (fields.to invalid_format | not_allowed), recipient_not_allowed, chat_disabled
 */
async function resolveRecipient(to, { policy = null, sock = null, bannedChats } = {}) {
  const parsed = parseRecipient(to);
  if (parsed.error) throw new MessagingError("validation_failed", { fields: { to: { code: "invalid_format" } } });
  const target = parsed;

  if (!(await evaluatePolicy(policy, target)).ok) throw new MessagingError("recipient_not_allowed");
  if (isOwnNumber(target, sock)) throw new MessagingError("validation_failed", { fields: { to: { code: "not_allowed" } } });
  if (await isChatDisabled(target, { bannedChats })) throw new MessagingError("chat_disabled");
  return { jid: target.jid, kind: target.kind, number: target.number };
}

// ---------------------------------------------------------------------------
// Pick-step checks (a live socket)
// ---------------------------------------------------------------------------

function withTimeout(work, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("operation timed out");
      err.code = "ETIMEDOUT";
      reject(err);
    }, ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([Promise.resolve().then(work), timeout]).finally(() => clearTimeout(timer));
}

// pn -> { until, result }: positive answers 24 h, negative ones 10 min, at most ONWHATSAPP_CACHE_MAX entries
const reachability = new Map();

function remember(key, result, now, ttl) {
  reachability.delete(key);
  reachability.set(key, { until: now + ttl, result });
  while (reachability.size > LIMITS.ONWHATSAPP_CACHE_MAX) reachability.delete(reachability.keys().next().value);
}

/**
 * Is the number on WhatsApp (FR-040)? Skipped for groups and for any chat the bot already knows. A thrown error
 * (or no answer at all) is transient and propagates: the caller retries on a later tick. At most one lookup per
 * call, and answers are cached: probing numbers in bulk is itself a ban signal.
 */
async function verifyReachable(sock, target, { now = Date.now(), timeoutMs = LIMITS.VERIFY_TIMEOUT_MS } = {}) {
  if (target.kind === "group") return { jid: target.jid, skipped: true };
  if (await require("../utils/knownChats").isKnown(target.jid)) return { jid: target.jid, skipped: true };

  const hit = reachability.get(target.jid);
  if (hit && now < hit.until) return { ...hit.result };

  const answer = await withTimeout(() => sock.onWhatsApp(target.jid), timeoutMs);
  if (!Array.isArray(answer)) throw new Error("no answer from WhatsApp");
  const entry = answer[0];
  if (!entry || entry.exists !== true) {
    const result = { failure: "not_on_whatsapp" };
    remember(target.jid, result, now, LIMITS.ONWHATSAPP_NEGATIVE_MS);
    return { ...result };
  }
  // WhatsApp normalises some national formats: its @s.whatsapp.net answer is the destination
  const jid = typeof entry.jid === "string" && entry.jid.endsWith("@s.whatsapp.net") ? permissions.normalizeJid(entry.jid) : target.jid;
  const result = { jid };
  remember(target.jid, result, now, LIMITS.ONWHATSAPP_POSITIVE_MS);
  return { ...result };
}

const statusOf = (err) => err?.output?.statusCode ?? err?.statusCode ?? err?.status ?? err?.data;

/**
 * Can the bot post in this group? A definitive 403/404 means it is not a member; an announce-only group needs the
 * bot to be an admin. Timeouts and connection errors propagate (transient). The metadata also feeds the mentions.
 */
async function verifyGroupPosting(sock, target, { timeoutMs = LIMITS.VERIFY_TIMEOUT_MS } = {}) {
  let metadata;
  try {
    metadata = await withTimeout(() => sock.groupMetadata(target.jid), timeoutMs);
  } catch (err) {
    const status = statusOf(err);
    if (status === 403 || status === 404 || /forbidden|item-not-found|not-authorized/i.test(String(err?.message || ""))) {
      return { failure: "not_in_group" };
    }
    throw err;
  }
  if (metadata && metadata.announce === true) {
    const { findParticipant, isAdminParticipant } = require("../classes/Message");
    const bot = getBotJids(sock);
    if (!isAdminParticipant(findParticipant(metadata, [bot.pn, bot.lid]))) return { failure: "group_announce_only" };
  }
  return { metadata };
}

/**
 * Members of the group designated by phone numbers: a participant matches when its PN (`phoneNumber` or `id`)
 * is the number; the mention JID is `p.id`, the group's own addressing form (a LID in a LID group). A number that
 * is not a member is ignored (the message still goes).
 * @returns {{ number: string, jid: string }[]}
 */
function mentionJids(metadata, numbers) {
  const participants = metadata && Array.isArray(metadata.participants) ? metadata.participants : [];
  if (!participants.length || !Array.isArray(numbers)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of numbers) {
    const parsed = permissions.parsePhoneNumber(raw);
    if (parsed.error) continue;
    const member = participants.find((p) => permissions.normalizeJid(p.phoneNumber) === parsed.pn || permissions.normalizeJid(p.id) === parsed.pn);
    if (!member || !member.id || seen.has(member.id)) continue;
    seen.add(member.id);
    out.push({ number: parsed.digits, jid: member.id });
  }
  return out;
}

/** Tests: forget the cached lookups and the last bot identity */
function _reset() {
  reachability.clear();
  lastIdentity = { pn: "", lid: "" };
}

const _cacheSize = () => reachability.size;

module.exports = {
  parseRecipient,
  mask,
  evaluatePolicy,
  isChatDisabled,
  resolveRecipient,
  getBotJids,
  isOwnNumber,
  verifyReachable,
  verifyGroupPosting,
  mentionJids,
  _reset,
  _cacheSize,
};
