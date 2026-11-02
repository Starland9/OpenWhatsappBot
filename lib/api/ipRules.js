"use strict";

/**
 * IP entry grammar of the messaging API (specs/004-messaging-api, contracts/runtime.md 15.9).
 *
 * One grammar for both address lists: `ApiKey.ipAllow` (at most MAX_ENTRIES, "which addresses may use this key")
 * and `ApiState.plainHttpFrom` (at most MAX_PLAIN_HTTP, private networks allowed to call over plain HTTP). A
 * dependency-free leaf (Node's `net` only, its own copy of the trusted-proxy `unmap`): `lib/utils/apiState.js`, the
 * key store, the transport and the panel service all require it, and the admin SPA mirrors it
 * (lib/admin/public/js/views/api-logic.mjs) against the shared fixture test/fixtures/api-ip-entries.json.
 *
 *   parse(list, { privateOnly, max })  -> { entries, invalid: [{ index, reason? }], tooMany }
 *   parseEntry(text)                   -> { ok: true, value, family, prefix, start, end } | { ok: false, code }
 *   compile(entries)                   -> { check(address), restricted, size }
 *   covers(oldEntries, entry)          -> boolean   (widening detection of the step-up)
 *   isPrivateRange(entry)              -> boolean   (RFC 1918, CGNAT 100.64.0.0/10, ULA fc00::/7)
 *   unmap(address)                     -> string    (IPv4-mapped IPv6 and zone ids)
 *
 * Grammar: one entry per item, trimmed and lower-cased. IPv4 `a.b.c.d` (octets without a leading zero), IPv4 CIDR
 * `/0-32`, IPv6 (an embedded IPv4 tail is fine) and IPv6 CIDR `/0-128`; a prefix has no leading zero. A zone id
 * (`fe80::1%eth0`) is dropped. An IPv4-mapped IPv6 address (`::ffff:1.2.3.4`, or a range of at least /96) is the
 * IPv4 entry. The host bits below the mask are zeroed and the text is written back in the canonical form: IPv4
 * dotted, IPv6 lower case with the first longest run of zero groups compressed; a bare address stays bare (no `/32`
 * is invented), a written prefix is kept. So `parseEntry(value).value === value`. `0.0.0.0/0` and `::/0` are valid.
 * Anything else is `invalid_format` (no wildcard, no host name, no range with a dash).
 *
 * Matching uses the full effective client address, never the /64 origin key the throttle groups callers by.
 * Nothing here logs, so no address ever reaches a log line from this module.
 */

const net = require("net");

const MAX_ENTRIES = 50; // ApiKey.ipAllow
const MAX_PLAIN_HTTP = 20; // ApiState.plainHttpFrom, passed as `max` by apiState and the panel service
const MAX_TEXT = 64; // the longest entry is 43 characters; longer text is never an address
const MAX_RAW_TEXT = 256; // cheap guard before trimming

/** "::ffff:1.2.3.4" -> "1.2.3.4"; a zone id ("%eth0") is dropped; anything else is returned trimmed */
function unmap(address) {
  let value = String(address == null ? "" : address).trim();
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped && net.isIPv4(mapped[1])) return mapped[1];
  // hexadecimal form of an IPv4-mapped address (::ffff:7f00:1)
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(value);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return value;
}

/** "a.b.c.d" -> BigInt, or null. Octets 0-255 with no leading zero, ASCII digits only. */
function parseV4(text) {
  const match = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(text);
  if (!match) return null;
  let value = 0n;
  for (let i = 1; i <= 4; i++) {
    const octet = match[i];
    if (octet.length > 1 && octet[0] === "0") return null;
    const n = Number(octet);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

/** IPv6 text (zone already removed) -> BigInt, or null */
function parseV6(text) {
  if (!net.isIPv6(text)) return null;
  let work = text;
  // an embedded IPv4 tail becomes two hexadecimal groups
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

/** Canonical IPv6 text: lower case, the first longest run (two groups or more) of zero groups written "::" */
function compressed(value) {
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
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
 * One entry. `code` is "required" for a blank text, "invalid_format" for anything else.
 * @returns {{ ok: true, value: string, family: 4|6, prefix: number, start: bigint, end: bigint } | { ok: false, code: string }}
 */
function parseEntry(input) {
  const refused = (code = "invalid_format") => ({ ok: false, code });
  if (typeof input !== "string" || input.length > MAX_RAW_TEXT) return refused();
  const text = input.trim().toLowerCase();
  if (text === "") return refused("required");
  if (text.length > MAX_TEXT) return refused();

  const slash = text.indexOf("/");
  if (slash !== text.lastIndexOf("/")) return refused();
  let address = slash === -1 ? text : text.slice(0, slash);
  const prefixText = slash === -1 ? null : text.slice(slash + 1);
  if (prefixText !== null && !/^(0|[1-9][0-9]{0,2})$/.test(prefixText)) return refused();

  // a zone id belongs to an IPv6 address only
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

  // an IPv4-mapped address, or a range of at least /96 inside the mapped block, is the IPv4 entry
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

/**
 * Normalise a list. `entries` are the valid canonical entries in order, the first spelling of a repeated entry
 * wins, cut to `max`; `tooMany` says more distinct entries were given. `invalid` lists the 0-based index of each
 * refused item: no `reason` for a syntax error, `reason: "not_private"` for a valid entry outside the private
 * ranges when `privateOnly` is set (the plain-HTTP list). Anything that is not a list gives nothing.
 */
function parse(list, { privateOnly = false, max = MAX_ENTRIES } = {}) {
  const entries = [];
  const invalid = [];
  const seen = new Set();
  let distinct = 0;
  const items = Array.isArray(list) ? list : [];
  items.forEach((item, index) => {
    const parsed = parseEntry(item);
    if (!parsed.ok) {
      invalid.push({ index });
      return;
    }
    if (privateOnly && !isPrivateRange(parsed)) {
      invalid.push({ index, reason: "not_private" });
      return;
    }
    if (seen.has(parsed.value)) return;
    seen.add(parsed.value);
    distinct++;
    if (entries.length < max) entries.push(parsed.value);
  });
  return { entries, invalid, tooMany: distinct > max };
}

/**
 * Compile stored entries into a matcher. An empty list means "no restriction"; a list none of whose entries is
 * readable (a damaged row) fails closed and lets nothing through, it never turns into "no restriction". Entries are
 * read again with `parseEntry`, so an unnormalised entry is masked first. `check` takes the full client address.
 * @returns {{ check: (address: string) => boolean, restricted: boolean, size: number }}
 */
function compile(entries) {
  const list = Array.isArray(entries) ? entries : [];
  // one BlockList per family: Node matches an IPv4 address against IPv6 rules (as ::ffff:a.b.c.d), so a `::/0`
  // entry would let every IPv4 client in. Families stay apart, as covers() keeps them.
  const blocks = { ipv4: new net.BlockList(), ipv6: new net.BlockList() };
  let size = 0;
  for (const item of list) {
    const parsed = parseEntry(item);
    if (!parsed.ok) continue;
    const type = parsed.family === 4 ? "ipv4" : "ipv6";
    const address = parsed.value.split("/")[0];
    if (parsed.prefix === (parsed.family === 4 ? 32 : 128)) blocks[type].addAddress(address, type);
    else blocks[type].addSubnet(address, parsed.prefix, type);
    size++;
  }
  const restricted = list.length > 0;
  return {
    restricted,
    size,
    check(address) {
      if (!restricted) return true;
      if (size === 0 || typeof address !== "string") return false;
      const plain = unmap(address);
      const type = net.isIPv4(plain) ? "ipv4" : net.isIPv6(plain) ? "ipv6" : null;
      return type !== null && blocks[type].check(plain, type);
    },
  };
}

/** `entry` (text) lies inside one parseable entry of `oldEntries` (same family, BigInt compare); an unparseable one covers nothing */
function covers(oldEntries, entry) {
  const wanted = parseEntry(entry);
  if (!wanted.ok || !Array.isArray(oldEntries)) return false;
  for (const old of oldEntries) {
    const range = parseEntry(old);
    if (range.ok && range.family === wanted.family && wanted.start >= range.start && wanted.end <= range.end) return true;
  }
  return false;
}

let privateRanges = null;
/** The blocks U1 allows for plain HTTP, parsed once on first use */
function privateBlocks() {
  if (!privateRanges) {
    privateRanges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7"].map(parseEntry);
  }
  return privateRanges;
}

/** The whole range lies inside 10/8, 172.16/12, 192.168/16, 100.64/10 or fc00::/7 (`entry` is a text or a parsed entry) */
function isPrivateRange(entry) {
  const parsed = entry && typeof entry === "object" && typeof entry.start === "bigint" ? entry : parseEntry(entry);
  if (!parsed.ok) return false;
  return privateBlocks().some((block) => block.family === parsed.family && parsed.start >= block.start && parsed.end <= block.end);
}

module.exports = {
  parse,
  parseEntry,
  compile,
  covers,
  isPrivateRange,
  unmap,
  MAX_ENTRIES,
  MAX_PLAIN_HTTP,
};
