// Pure logic of the API area (feature 004, contracts/panel-ui.md section 4): keys and their draft, rights,
// recipients, the IP grammar and the step-up predicate, message statuses, history and usage queries, polling delay,
// clipboard. No DOM, no network, no timer, no `t()`: a function that needs a text returns a panel key plus
// parameters and the view translates it.

import { personKey, parseNumber, addPerson, togglePerson, removePerson, hasPerson } from "./permissions-logic.mjs";
import { shortJid } from "./groups-logic.mjs";
import { localToIso, isoToLocal } from "./broadcasts-logic.mjs";
import { dayBound, validateFilters } from "./audit-logic.mjs";
import { hasKey } from "../i18n.mjs";

// ---- 4.1 constants ---------------------------------------------------------------------------------------------

export const TABS = Object.freeze(["keys", "history", "usage", "test", "docs"]);
export const STATUSES = Object.freeze(["queued", "sending", "sent", "delivered", "read", "failed", "expired", "cancelled", "unknown"]);
export const FINAL_STATUSES = Object.freeze(["failed", "expired", "cancelled", "unknown"]);
export const POLICY_MODES = Object.freeze(["list", "known", "anyone"]);
export const POLICY_RANK = Object.freeze({ list: 0, known: 1, anyone: 2 });
// the server order of admin-api.md 1.5; text key `api.reason_<code>`
export const REASONS = Object.freeze(["enable", "create", "rights", "policy", "ip", "expiry", "plain_http"]);
export const RIGHT_GROUPS = Object.freeze(["send", "read", "media", "docs"]);
export const DEFAULT_LIMITS = Object.freeze({
  keyNameMax: 64,
  rightsMax: 64,
  recipientsMax: 200,
  ipAllowMax: 50,
  plainHttpFromMax: 20,
  perMinute: Object.freeze([1, 1000]),
  perDay: Object.freeze([1, 100000]),
  maxPending: Object.freeze([1, 5000]),
});
export const POLL = Object.freeze({ fastMs: 2000, fastCount: 15, slowMs: 10000, maxPolls: 60 });
export const STEP_UP_MARGIN_MS = 2000;
export const LIMIT_NAMES = Object.freeze(["perMinute", "perDay", "maxPending"]);
export const HISTORY_PAGE_SIZE = 25;

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isList = (value) => Array.isArray(value);
const asList = (value) => (Array.isArray(value) ? value : []);
const codePoints = (text) => [...String(text ?? "")].length;
const jidOf = (entry) => (typeof entry === "string" ? entry : entry && typeof entry.jid === "string" ? entry.jid : "");
const limitsOf = (catalog) => ({ ...DEFAULT_LIMITS, ...((catalog && catalog.limits) || {}) });

export const tabOf = (value) => (TABS.includes(value) ? value : "keys");

// ---- 4.2 keys: state, list, draft ------------------------------------------------------------------------------

/** The server `status`, except that an "active" key past its expiry reads "expired"; an unknown value is "revoked". */
export function keyState(key, now = Date.now()) {
  const status = key && key.status;
  if (status === "active") {
    const expires = key.expiresAt ? Date.parse(key.expiresAt) : NaN;
    return Number.isFinite(expires) && expires <= now ? "expired" : "active";
  }
  return status === "expired" ? "expired" : "revoked";
}

// an expired key stays editable so its expiry can be extended; API-7 refuses an expired or revoked source
export const isEditable = (key, now) => keyState(key, now) !== "revoked";
export const canDuplicate = (key, now) => keyState(key, now) === "active";
export const canRevoke = (key, now) => keyState(key, now) !== "revoked";

/** Active and expired keys by name (then id), the revoked last (newest revocation first); input not mutated. */
export function visibleKeys(items, { showRevoked = false, now = Date.now() } = {}) {
  const live = [];
  const revoked = [];
  for (const key of asList(items)) (keyState(key, now) === "revoked" ? revoked : live).push(key);
  live.sort((a, b) => byText(String(a.name).toLowerCase(), String(b.name).toLowerCase()) || a.id - b.id);
  revoked.sort((a, b) => (Date.parse(b.revokedAt) || 0) - (Date.parse(a.revokedAt) || 0) || a.id - b.id);
  return showRevoked ? [...live, ...revoked] : live;
}

/** Lower-cased trimmed names of the non-revoked keys other than `exceptId` (the duplicate-name pre-check). */
export function activeNames(items, exceptId = null, now = Date.now()) {
  return asList(items)
    .filter((key) => key.id !== exceptId && keyState(key, now) !== "revoked")
    .map((key) => String(key.name ?? "").trim().toLowerCase());
}

/** The cell model of one list row. */
export function keyRow(key, { settings = {}, now = Date.now() } = {}) {
  const rights = asList(key.rights);
  const own = key.limits || {};
  return {
    id: key.id,
    name: key.name,
    last4: key.last4,
    state: keyState(key, now),
    rightsCount: rights.length,
    rightsPreview: rights.slice(0, 3),
    rightsMore: Math.max(0, rights.length - 3),
    policy: { mode: key.policy ? key.policy.mode : "list", count: key.policy ? asList(key.policy.recipients).length : 0 },
    limits: LIMIT_NAMES.map((name) => {
      const isDefault = own[name] === null || own[name] === undefined;
      return { name, value: isDefault ? (settings[name] ?? null) : own[name], isDefault };
    }),
    ipCount: asList(key.ipAllow).length,
    expiresAt: key.expiresAt ?? null,
    lastUsedAt: key.lastUsedAt ?? null,
    lastUsedIp: key.lastUsedIp ?? null,
    createdAt: key.createdAt ?? null,
    queued: key.queued ?? 0,
  };
}

const sortedUnique = (list) => [...new Set(asList(list))].sort(byText);
const byPerson = (a, b) => byText(personKey(a.jid), personKey(b.jid));

function uniquePeople(people) {
  const seen = new Set();
  const out = [];
  for (const person of asList(people)) {
    const k = personKey(person && person.jid);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(person);
  }
  return out.sort(byPerson);
}

/** From a saved key, or (null) a new draft: no right, mode `list`, nobody, default limits, no IP row, no expiry. */
export function draftOf(key) {
  if (!key) {
    return {
      name: "",
      rights: [],
      mode: "list",
      recipients: [],
      limits: { perMinute: null, perDay: null, maxPending: null },
      ipRows: [],
      expiry: { local: "", original: null },
    };
  }
  const own = key.limits || {};
  return {
    name: String(key.name ?? ""),
    rights: sortedUnique(key.rights),
    mode: key.policy && POLICY_MODES.includes(key.policy.mode) ? key.policy.mode : "list",
    recipients: uniquePeople(key.policy && key.policy.recipients),
    limits: { perMinute: own.perMinute ?? null, perDay: own.perDay ?? null, maxPending: own.maxPending ?? null },
    ipRows: asList(key.ipAllow).map(String),
    expiry: { local: key.expiresAt ? isoToLocal(key.expiresAt) : "", original: key.expiresAt ?? null },
  };
}

const limitValue = (value) => (value === null || value === undefined || value === "" ? null : Number(value));

/** The changed sections of a draft against the saved key (`null` = a new key), plus the added and removed items. */
export function diffKey(saved, draft) {
  const base = draftOf(saved);
  const sections = [];

  if (String(draft.name ?? "").trim() !== base.name.trim()) sections.push("name");

  const was = new Set(base.rights);
  const wants = new Set(sortedUnique(draft.rights));
  const rightsAdded = [...wants].filter((id) => !was.has(id)).sort(byText);
  const rightsRemoved = [...was].filter((id) => !wants.has(id)).sort(byText);
  if (rightsAdded.length || rightsRemoved.length) sections.push("rights");

  if (draft.mode !== base.mode) sections.push("policy");

  const wasKeys = new Set(base.recipients.map((person) => personKey(person.jid)));
  const wantKeys = new Set(uniquePeople(draft.recipients).map((person) => personKey(person.jid)));
  const recipientsAdded = uniquePeople(draft.recipients).filter((person) => !wasKeys.has(personKey(person.jid))).map((person) => person.jid);
  const recipientsRemoved = base.recipients.filter((person) => !wantKeys.has(personKey(person.jid))).map((person) => person.jid);
  if (recipientsAdded.length || recipientsRemoved.length) sections.push("recipients");

  const limits = draft.limits || {};
  if (LIMIT_NAMES.some((name) => limitValue(limits[name]) !== limitValue(base.limits[name]))) sections.push("limits");

  // trimmed, non-blank, order-insensitive; an entry that parses is compared by its normalised value
  const ipSet = (rows) =>
    new Set(
      asList(rows)
        .map((row) => String(row ?? "").trim())
        .filter(Boolean)
        .map((row) => {
          const parsed = parseIpEntry(row);
          return parsed.ok ? parsed.value : row;
        }),
    );
  const ipWas = ipSet(base.ipRows);
  const ipWants = ipSet(draft.ipRows);
  if (ipWas.size !== ipWants.size || [...ipWants].some((row) => !ipWas.has(row))) sections.push("ip");

  const expiry = draft.expiry || { local: "", original: null };
  if ((expiry.local || "") !== (base.expiry.original ? isoToLocal(base.expiry.original) : "")) sections.push("expiry");

  return { sections, rightsAdded, rightsRemoved, recipientsAdded, recipientsRemoved };
}

export const isDirty = (saved, draft) => diffKey(saved, draft).sections.length > 0;

/** Rights and recipients added or removed, plus one per other changed section. */
export function pendingCount(saved, draft) {
  const diff = diffKey(saved, draft);
  const counted = diff.rightsAdded.length + diff.rightsRemoved.length + diff.recipientsAdded.length + diff.recipientsRemoved.length;
  return counted + diff.sections.filter((section) => section !== "rights" && section !== "recipients").length;
}

// ---- 4.3 rights ------------------------------------------------------------------------------------------------

/** Catalogue rights grouped in `RIGHT_GROUPS` order (an unknown group after them, alphabetically). */
export function rightsGroups(catalogRights, selected) {
  const chosen = new Set(asList(selected));
  const groups = new Map();
  for (const right of asList(catalogRights)) {
    const name = right.group || "";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ id: right.id, format: right.format ?? null, checked: chosen.has(right.id) });
  }
  const known = RIGHT_GROUPS.filter((name) => groups.has(name));
  const other = [...groups.keys()].filter((name) => !RIGHT_GROUPS.includes(name)).sort(byText);
  return [...known, ...other].map((group) => {
    const items = groups.get(group);
    return { group, items, allChecked: items.every((item) => item.checked), noneChecked: items.every((item) => !item.checked) };
  });
}

/** A new draft with the right switched. */
export function toggleRight(draft, id) {
  const has = draft.rights.includes(id);
  return { ...draft, rights: sortedUnique(has ? draft.rights.filter((x) => x !== id) : [...draft.rights, id]) };
}

/** Switch every catalogue right of one group, nothing else. */
export function setGroupRights(draft, catalogRights, group, on) {
  const ids = asList(catalogRights).filter((right) => right.group === group).map((right) => right.id);
  const rest = draft.rights.filter((id) => !ids.includes(id));
  return { ...draft, rights: sortedUnique(on ? [...rest, ...ids] : rest) };
}

/** Stored ids absent from the catalogue (an empty catalogue makes every right an orphan). */
export function orphanRights(selected, catalogRights) {
  const known = new Set(asList(catalogRights).map((right) => right.id));
  return asList(selected).filter((id) => !known.has(id));
}

export const rightKeys = (id) => ({ label: `api.right.${id}.label`, desc: `api.right.${id}.desc` });

/** A `messages.send.*` right is checked while the list is the policy and it is empty. */
export function needsRecipients(draft) {
  return draft.mode === "list" && asList(draft.recipients).length === 0 && asList(draft.rights).some((id) => id.startsWith("messages.send."));
}

// ---- 4.4 recipients --------------------------------------------------------------------------------------------

export const recipientKind = (jid) => (String(jid).endsWith("@g.us") ? "group" : "private");

// the API addresses numbers and groups only: a LID chat is refused
const NUMBER_JID = /^\d{8,15}@s\.whatsapp\.net$/;
const GROUP_JID = /^\d{5,25}(-\d+)?@g\.us$/;
const apiJid = (jid) => {
  const key = personKey(jid);
  return NUMBER_JID.test(key) || GROUP_JID.test(key);
};

function viaPeople(draft, run) {
  const result = run({ people: draft.recipients });
  return { draft: result.draft === undefined || result.draft.people === draft.recipients ? draft : { ...draft, recipients: result.draft.people }, error: result.error };
}

export function addRecipient(draft, entry, { max = DEFAULT_LIMITS.recipientsMax } = {}) {
  if (!apiJid(entry && entry.jid)) return { draft, error: { code: "invalid_jid" } };
  return viaPeople(draft, (people) => addPerson(people, entry, { max }));
}

export function toggleRecipient(draft, entry, { max = DEFAULT_LIMITS.recipientsMax } = {}) {
  if (!hasPerson({ people: draft.recipients }, entry && entry.jid) && !apiJid(entry && entry.jid)) return { draft, error: { code: "invalid_jid" } };
  return viaPeople(draft, (people) => togglePerson(people, entry, { max }));
}

export function removeRecipient(draft, jid) {
  const next = removePerson({ people: draft.recipients }, jid);
  return next.people === draft.recipients ? draft : { ...draft, recipients: next.people };
}

/** De-duplicated by `personKey`, sorted by it, trimmed; sent in every mode. */
export function recipientsBody(draft) {
  return uniquePeople(draft.recipients).map((person) => String(person.jid).trim());
}

/** The CHAT-1 query of the group picker: groups only, `page` above 1 and `q` (trimmed, 100 characters) when set. */
export function recipientChatQuery({ kind = "group", q = "", page = 1, pageSize = 50 } = {}) {
  const query = { kind, pageSize };
  if (page > 1) query.page = page;
  const text = String(q ?? "").trim().slice(0, 100);
  if (text) query.q = text;
  return query;
}

export const groupLabel = (entry) => ({ name: entry && typeof entry.name === "string" && entry.name !== "" ? entry.name : null, id: shortJid(entry && entry.jid) });

// ---- 4.5 IP entries, expiry ------------------------------------------------------------------------------------

// The grammar of lib/api/ipRules.js, pinned for both sides by test/fixtures/api-ip-entries.json.
const MAX_IP_TEXT = 64;
const MAX_IP_RAW = 256;

/** "a.b.c.d" -> BigInt or null: octets 0-255 without a leading zero, ASCII digits only. */
function parseV4(text) {
  const match = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(text);
  if (!match) return null;
  let value = 0n;
  for (let i = 1; i <= 4; i += 1) {
    const octet = match[i];
    if (octet.length > 1 && octet[0] === "0") return null;
    if (Number(octet) > 255) return null;
    value = (value << 8n) | BigInt(Number(octet));
  }
  return value;
}

/** IPv6 text (zone already removed) -> BigInt or null: 1-8 groups of 1-4 hex digits, one "::" (at least one group), an IPv4 tail. */
function parseV6(text) {
  if (!text.includes(":") || !/^[0-9a-f:.]+$/.test(text)) return null;
  let work = text;
  const tail = /:([0-9]{1,3}(?:\.[0-9]{1,3}){3})$/.exec(work);
  if (tail) {
    const v4 = parseV4(tail[1]);
    if (v4 === null) return null;
    work = `${work.slice(0, work.length - tail[1].length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = work.split("::");
  if (halves.length > 2) return null;
  const groups = (part) => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (all.length !== 8) return null;
  let value = 0n;
  for (const group of all) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

const dotted = (value) => [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 255n)).join(".");

/** Canonical IPv6: lower case, the first longest run (two groups or more) of zero groups written "::". */
function compressed(value) {
  const groups = [];
  for (let i = 7; i >= 0; i -= 1) groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = (list) => list.map((g) => g.toString(16)).join(":");
  if (bestLength < 2) return hex(groups);
  return `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLength))}`;
}

/**
 * One entry. `{ ok: true, value, family, prefix, start, end }` (`start` / `end` are BigInt) or `{ ok: false, code }`:
 * "required" for a blank text, "invalid_format" for anything else. Host bits are zeroed, the text written back in
 * the canonical form (a bare address stays bare, a written prefix is kept), an IPv4-mapped IPv6 is the IPv4 entry.
 */
export function parseIpEntry(input) {
  const refused = (code = "invalid_format") => ({ ok: false, code });
  if (typeof input !== "string" || input.length > MAX_IP_RAW) return refused();
  const text = input.trim().toLowerCase();
  if (text === "") return refused("required");
  if (text.length > MAX_IP_TEXT) return refused();

  const slash = text.indexOf("/");
  if (slash !== text.lastIndexOf("/")) return refused();
  let address = slash === -1 ? text : text.slice(0, slash);
  const prefixText = slash === -1 ? null : text.slice(slash + 1);
  if (prefixText !== null && !/^(0|[1-9][0-9]{0,2})$/.test(prefixText)) return refused();

  // a zone id belongs to an IPv6 address only and is dropped
  const zone = address.indexOf("%");
  if (zone !== -1) {
    const zoneName = address.slice(zone + 1);
    address = address.slice(0, zone);
    if (!address.includes(":") || !/^[^\s/%]+$/.test(zoneName)) return refused();
  }

  let family;
  let value = parseV4(address);
  if (value !== null) {
    family = 4;
  } else {
    value = parseV6(address);
    if (value === null) return refused();
    family = 6;
  }

  let bits = family === 4 ? 32 : 128;
  let prefix = prefixText === null ? bits : Number(prefixText);
  if (prefix > bits) return refused();

  if (family === 6 && value >> 32n === 0xffffn && prefix >= 96) {
    family = 4;
    bits = 32;
    value &= 0xffffffffn;
    prefix -= 96;
  }

  const hostBits = BigInt(bits - prefix);
  const start = (value >> hostBits) << hostBits;
  const end = start | ((1n << hostBits) - 1n);
  const base = family === 4 ? dotted(start) : compressed(start);
  return { ok: true, value: prefixText === null ? base : `${base}/${prefix}`, family, prefix, start, end };
}

const asParsed = (entry) => (entry && typeof entry === "object" && typeof entry.start === "bigint" ? entry : parseIpEntry(entry));

let privateBlocks = null;
const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7"];

/** The whole range lies inside 10/8, 172.16/12, 192.168/16, 100.64/10 or fc00::/7 (U1). */
export function isPrivateRange(entry) {
  const parsed = asParsed(entry);
  if (!parsed.ok) return false;
  if (!privateBlocks) privateBlocks = PRIVATE_RANGES.map(parseIpEntry);
  return privateBlocks.some((block) => block.family === parsed.family && parsed.start >= block.start && parsed.end <= block.end);
}

/** `0.0.0.0/0` or `::/0`: accepted, flagged by `api.ip_any_warning`. */
export const isAnyIp = (value) => value === "0.0.0.0/0" || value === "::/0";

/** The entry lies inside one parseable old entry of the same family; an unparseable old entry covers nothing. */
export function ipCovered(oldValues, entry) {
  const wanted = asParsed(entry);
  if (!wanted.ok) return false;
  for (const old of asList(oldValues)) {
    const range = parseIpEntry(old);
    if (range.ok && range.family === wanted.family && wanted.start >= range.start && wanted.end <= range.end) return true;
  }
  return false;
}

/**
 * The editor rows -> normalised values. Blank rows are ignored but counted, so the row numbers (1-based) match what
 * the owner sees; the first spelling of a repeated entry wins. `tooMany`: more than `max` distinct entries.
 */
export function parseIpRows(rows, { max = DEFAULT_LIMITS.ipAllowMax, privateOnly = false } = {}) {
  const out = { values: [], invalid: [], notPrivate: [], duplicates: [], tooMany: false };
  const seen = new Set();
  asList(rows).forEach((row, index) => {
    const text = String(row ?? "");
    if (text.trim() === "") return;
    const number = index + 1;
    const parsed = parseIpEntry(text);
    if (!parsed.ok) {
      out.invalid.push(number);
      return;
    }
    if (privateOnly && !isPrivateRange(parsed)) {
      out.notPrivate.push(number);
      return;
    }
    if (seen.has(parsed.value)) {
      out.duplicates.push(number);
      return;
    }
    seen.add(parsed.value);
    out.values.push(parsed.value);
  });
  out.tooMany = out.values.length > max;
  return out;
}

/**
 * One message per list (ListControl has a single error slot): invalid rows, then rows outside the private ranges,
 * then too many. `networks: true` names the invalid rows with the plain-HTTP card's own text.
 */
export function ipRowsError(parsed, { max = DEFAULT_LIMITS.ipAllowMax, networks = false } = {}) {
  if (parsed.invalid.length) return { key: networks ? "api.networks_invalid_rows" : "api.ip_invalid_rows", params: { rows: parsed.invalid.join(", ") } };
  if (parsed.notPrivate.length) return { key: "api.networks_not_private", params: { rows: parsed.notPrivate.join(", ") } };
  if (parsed.tooMany) return { code: "too_many_items", params: { max } };
  return null;
}

/** The ISO instant to send: blank is null, an untouched field keeps the stored ISO (a datetime-local drops seconds). */
export function expiryBody(expiry) {
  const local = expiry && expiry.local ? String(expiry.local) : "";
  if (!local) return null;
  if (expiry.original && local === isoToLocal(expiry.original)) return expiry.original;
  return localToIso(local);
}

/** Only for a changed expiry: an unchanged past expiry (an expired key) is not an error. */
export function expiryError(expiry, now = Date.now()) {
  const local = expiry && expiry.local ? String(expiry.local) : "";
  if (!local) return null;
  if (expiry.original && local === isoToLocal(expiry.original)) return null;
  const iso = localToIso(local);
  if (!iso) return { code: "invalid_format" };
  return Date.parse(iso) <= now ? { code: "in_past" } : null;
}

// ---- 4.6 validation, body, server errors -----------------------------------------------------------------------

/** A courtesy mirror of the schema; `errors` is keyed by section, each `{ code, params }` or `{ key, params }`. */
export function validateKey(draft, { names = [], limits, now = Date.now() } = {}) {
  const max = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const errors = {};

  const name = String(draft.name ?? "").trim();
  if (!name) errors.name = { code: "required" };
  else if (codePoints(name) > max.keyNameMax) errors.name = { code: "too_long", params: { max: max.keyNameMax } };
  else if (asList(names).some((other) => String(other).trim().toLowerCase() === name.toLowerCase())) errors.name = { code: "duplicate" };

  if (asList(draft.rights).length > max.rightsMax) errors.rights = { code: "too_many_items", params: { max: max.rightsMax } };
  if (asList(draft.recipients).length > max.recipientsMax) errors.recipients = { code: "too_many_items", params: { max: max.recipientsMax } };

  for (const limit of LIMIT_NAMES) {
    const value = draft.limits ? draft.limits[limit] : null;
    if (value === null || value === undefined || value === "") continue;
    const [min, top] = max[limit];
    if (typeof value !== "number" || Number.isNaN(value)) errors[limit] = { code: "invalid_type" };
    else if (!Number.isInteger(value) || value < min || value > top) errors[limit] = { code: "out_of_range", params: { min, max: top } };
  }

  const ips = ipRowsError(parseIpRows(draft.ipRows, { max: max.ipAllowMax }), { max: max.ipAllowMax });
  if (ips) errors.ipAllow = ips;
  const expiry = expiryError(draft.expiry, now);
  if (expiry) errors.expiresAt = expiry;

  return { ok: Object.keys(errors).length === 0, errors };
}

/** Exactly the property set of KeyInput; `version` only for an update; `confirm` only on a change to "anyone". */
export function buildKeyBody(draft, saved = null) {
  const body = {
    name: String(draft.name ?? "").trim(),
    rights: sortedUnique(draft.rights),
    policy: { mode: draft.mode, recipients: recipientsBody(draft) },
    limits: {
      perMinute: limitValue(draft.limits && draft.limits.perMinute),
      perDay: limitValue(draft.limits && draft.limits.perDay),
      maxPending: limitValue(draft.limits && draft.limits.maxPending),
    },
    ipAllow: parseIpRows(draft.ipRows).values,
    expiresAt: expiryBody(draft.expiry),
  };
  if (saved) body.version = saved.version;
  if (draft.mode === "anyone" && (!saved || !saved.policy || saved.policy.mode !== "anyone")) body.confirm = ["policy_anyone"];
  return body;
}

const SERVER_PATHS = {
  name: "name",
  rights: "rights",
  "policy.mode": "mode",
  "policy.recipients": "recipients",
  "limits.perMinute": "perMinute",
  "limits.perDay": "perDay",
  "limits.maxPending": "maxPending",
  ipAllow: "ipAllow",
  expiresAt: "expiresAt",
  version: "version",
};
const ROWS_KEYS = { recipients: "api.recipients_invalid_rows", ipAllow: "api.ip_invalid_rows" };

/** Map the `fields` of an API-5/6 refusal onto the editor sections; every other path goes to `summary`. */
export function keyErrors(fields) {
  const errors = {};
  const summary = [];
  for (const [path, error] of Object.entries(fields && typeof fields === "object" ? fields : {})) {
    const section = Object.hasOwn(SERVER_PATHS, path) ? SERVER_PATHS[path] : null;
    if (!section) {
      summary.push({ path, error });
      continue;
    }
    const indices = error && error.params && Array.isArray(error.params.indices) ? error.params.indices : null;
    errors[section] = indices && ROWS_KEYS[section] ? { key: ROWS_KEYS[section], params: { rows: indices.map((i) => Number(i) + 1).join(", ") } } : error;
  }
  return { errors, summary };
}

// ---- 4.7 step-up predicate -------------------------------------------------------------------------------------

/**
 * The reasons, in `REASONS` order, for which the server asks for the password: the mirror of
 * lib/admin/services/api.js#widenings, pinned by test/fixtures/api-widenings.json. It looks only at the properties
 * present in `after`; `before === null` is a creation. May over-report, never under-report.
 */
export function widenings(before, after) {
  if (before === null || before === undefined) return ["create"];
  const next = after || {};
  const reasons = [];

  if (next.enabled === true && before.enabled === false) reasons.push("enable");

  if (isList(next.rights)) {
    const had = new Set(asList(before.rights));
    if (next.rights.some((id) => !had.has(id))) reasons.push("rights");
  }

  if (next.policy && typeof next.policy === "object") {
    const was = before.policy || {};
    const rank = (mode) => (Object.hasOwn(POLICY_RANK, mode) ? POLICY_RANK[mode] : 0);
    const raised = next.policy.mode !== undefined && rank(next.policy.mode) > rank(was.mode);
    let added = false;
    if (isList(next.policy.recipients)) {
      const hadKeys = new Set(asList(was.recipients).map((entry) => personKey(jidOf(entry))));
      added = next.policy.recipients.some((entry) => !hadKeys.has(personKey(jidOf(entry))));
    }
    if (raised || added) reasons.push("policy");
  }

  if (isList(next.ipAllow)) {
    const old = asList(before.ipAllow);
    if (old.length && (next.ipAllow.length === 0 || next.ipAllow.some((entry) => !ipCovered(old, entry)))) reasons.push("ip");
  }

  if (next.expiresAt !== undefined && before.expiresAt) {
    const was = Date.parse(before.expiresAt);
    const will = next.expiresAt === null ? null : Date.parse(next.expiresAt);
    // an unreadable instant is treated as later: the server stays authoritative, a false positive costs one prompt
    if (will === null || Number.isNaN(will) || Number.isNaN(was) || will > was) reasons.push("expiry");
  }

  if (isList(next.plainHttpFrom)) {
    const old = asList(before.plainHttpFrom);
    if (next.plainHttpFrom.some((entry) => !ipCovered(old, entry))) reasons.push("plain_http");
  }

  return REASONS.filter((reason) => reasons.includes(reason));
}

// ---- 4.8 statuses, history, usage, polling, clipboard ----------------------------------------------------------

export function statusTone(status) {
  if (status === "sent" || status === "delivered" || status === "read") return "ok";
  if (status === "queued" || status === "sending") return "info";
  if (status === "failed") return "danger";
  if (status === "unknown") return "warn";
  return "neutral";
}

/** Final statuses, `read`, or `sent` on a group (a group stops at `sent`, FR-070); `delivered` may still become `read`. */
export function isSettled(message) {
  if (!message) return true;
  if (FINAL_STATUSES.includes(message.status) || message.status === "read") return true;
  return message.status === "sent" && message.kind === "group";
}

const LIFECYCLE = ["queued", "sending", "sent", "delivered", "read"];
const lifecycleRank = (status) => {
  const index = LIFECYCLE.indexOf(status);
  return index === -1 ? LIFECYCLE.length : index;
};

/** The steps by time, ties by lifecycle order; with none, the current status at the acceptance time. */
export function stepRows(message) {
  const steps = asList(message && message.steps);
  if (!steps.length) return [{ status: message ? message.status : "unknown", at: message ? message.acceptedAt : null }];
  return steps
    .map((step, index) => ({ status: step.status, at: step.at, index }))
    .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0) || lifecycleRank(a.status) - lifecycleRank(b.status) || a.index - b.index)
    .map(({ status, at }) => ({ status, at }));
}

/** `api.failure.<code>` when the catalog has it, else null (the view shows the raw code, in `span.mono`). */
export function failureText(code, has = hasKey) {
  const key = `api.failure.${code}`;
  return { key: code && has(key) ? key : null, code };
}

/** Recipients are not masked in the panel (FR-073 masks logs only): the number or group id, and the name beside it. */
export function recipientCell(row) {
  return { number: shortJid(row.to), name: typeof row.toName === "string" && row.toName !== "" ? row.toName : null, group: row.kind === "group" };
}

export function sourceCell(row) {
  if (row.source === "panel") return { kind: "panel", name: null };
  if (row.key && typeof row.key.name === "string") return { kind: "key", name: row.key.name };
  return { kind: "gone", name: null };
}

export function authorLabel(author) {
  const text = String(author ?? "");
  if (/^\d+$/.test(text)) return `+${text}`;
  const lid = /^(\d+)(?::\d+)?@lid$/.exec(text);
  return lid ? `@${lid[1]}` : text;
}

/** `{ label }` when the stored label exists; else a poll option by position; else the id. */
export function choiceLabel(choice, index, format) {
  if (choice && typeof choice.label === "string" && choice.label !== "") return { label: choice.label };
  if (format === "poll") return { key: "api.responses_option", params: { n: index + 1 } };
  return { label: String(choice ? choice.id : "") };
}

/** Bars for `<progress max="1">`: the ratio is the count over the largest count. */
export function pollBars(totals) {
  const list = asList(totals);
  const top = Math.max(0, ...list.map((item) => Number(item.count) || 0));
  return list.map((item) => ({ id: item.id, label: item.label ?? null, count: item.count, ratio: top === 0 ? 0 : (Number(item.count) || 0) / top }));
}

const KEY_FILTER = /^(panel|[1-9]\d{0,9})$/;
const FORMAT_FILTER = /^[a-z][a-z0-9_]{0,23}$/;

/** Filters from `route.query`: a value that does not fit is dropped. */
export function parseHistoryQuery(query) {
  const q = query && typeof query === "object" ? query : {};
  const day = (value) => (typeof value === "string" && dayBound(value, false) ? value : "");
  return {
    key: typeof q.key === "string" && KEY_FILTER.test(q.key) ? q.key : "",
    status: typeof q.status === "string" && STATUSES.includes(q.status) ? q.status : "",
    format: typeof q.format === "string" && FORMAT_FILTER.test(q.format) ? q.format : "",
    from: day(q.from),
    to: day(q.to),
  };
}

/** The API-9 query: the days are the browser's local days, sent as ISO instants. */
export function historyQuery(filters, page = 1, pageSize = HISTORY_PAGE_SIZE) {
  const f = parseHistoryQuery(filters);
  const query = {};
  if (f.key) query.key = f.key;
  if (f.status) query.status = f.status;
  if (f.format) query.format = f.format;
  const from = f.from ? dayBound(f.from, false) : null;
  const to = f.to ? dayBound(f.to, true) : null;
  if (from) query.from = from.toISOString();
  if (to) query.to = to.toISOString();
  query.page = Math.max(1, Math.trunc(Number(page)) || 1);
  query.pageSize = Math.min(200, Math.max(1, Math.trunc(Number(pageSize)) || HISTORY_PAGE_SIZE));
  return query;
}

/** Is the day range coherent? `{ ok, errors: { from?, to? } }` (validateFilters of the audit page). */
export const validateHistoryFilters = (filters) => validateFilters({ from: filters && filters.from, to: filters && filters.to });

/** A primitive for `useAsync` dependencies: the query, serialised. */
export const historyKey = (filters, page) => JSON.stringify(historyQuery(filters, page));

export function usageQuery(days, keyId) {
  const key = keyId === "panel" || keyId === "all" ? keyId : /^[1-9]\d{0,9}$/.test(String(keyId ?? "")) ? String(keyId) : "all";
  return { days: Number(days) === 30 ? 30 : 7, key };
}

/** One entry per key (or the panel): rows with a bar ratio, totals, and `empty` when every day is zero. */
export function usageModel(answer) {
  return asList(answer && answer.keys).map((entry) => {
    const days = asList(entry.days);
    const busiest = Math.max(0, ...days.map((d) => (Number(d.sent) || 0) + (Number(d.failed) || 0)));
    const rows = days.map((d) => ({
      day: d.day,
      sent: Number(d.sent) || 0,
      failed: Number(d.failed) || 0,
      ratio: busiest === 0 ? 0 : ((Number(d.sent) || 0) + (Number(d.failed) || 0)) / busiest,
    }));
    const totals = rows.reduce((sum, row) => ({ sent: sum.sent + row.sent, failed: sum.failed + row.failed }), { sent: 0, failed: 0 });
    return { id: entry.id ?? null, name: entry.name ?? null, source: entry.source, revoked: Boolean(entry.revoked), rows, totals, empty: totals.sent + totals.failed === 0 };
  });
}

/** `attempt` = polls already done. null once settled or at the cap; 2 s for the first 15 polls, then 10 s. */
export function nextPollDelay(attempt, message) {
  if (isSettled(message) || attempt >= POLL.maxPolls) return null;
  return attempt < POLL.fastCount ? POLL.fastMs : POLL.slowMs;
}

/** "copied", or "manual" when the Clipboard API is absent (plain HTTP on a LAN), denied or throws. */
export async function copyText(text, env = {}) {
  const nav = env.navigator ?? globalThis.navigator;
  const secure = env.isSecureContext ?? globalThis.isSecureContext;
  if (!nav || !nav.clipboard || typeof nav.clipboard.writeText !== "function" || secure === false) return "manual";
  try {
    await nav.clipboard.writeText(String(text));
    return "copied";
  } catch {
    return "manual";
  }
}

/** The base URL shown to the owner: the server's own when usable, else `location.origin` plus the base path. */
export function apiBaseUrl(state, { basePath = "/api/v1", location = globalThis.location } = {}) {
  if (state && typeof state.baseUrl === "string" && usableUrl(state.baseUrl)) return state.baseUrl;
  return `${location && location.origin ? location.origin : ""}${basePath}`;
}

/** The address of one endpoint of the catalogue: the origin of the base URL plus the endpoint's path. */
export function endpointUrl(state, endpoint, { location = globalThis.location } = {}) {
  const path = endpoint && typeof endpoint.path === "string" ? endpoint.path : "";
  if (state && typeof state.baseUrl === "string" && usableUrl(state.baseUrl)) return `${new URL(state.baseUrl).origin}${path}`;
  return `${location && location.origin ? location.origin : ""}${path}`;
}

function usableUrl(text) {
  try {
    return Boolean(new URL(text).origin) && new URL(text).origin !== "null";
  } catch {
    return false;
  }
}
