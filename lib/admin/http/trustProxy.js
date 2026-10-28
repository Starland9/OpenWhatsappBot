"use strict";

/**
 * Client address, scheme and host behind a reverse proxy (admin-http-api.md section 1.12, research U10).
 *
 * Forwarded headers (X-Forwarded-For / -Proto / -Host) are NEVER trusted automatically: they are honoured only
 * when the peer that opened the socket matches `PANEL_TRUST_PROXY`. Its value is a comma or space separated
 * list of IP addresses, CIDR ranges, or the keywords `loopback`, `private` and `all`. An empty value turns the
 * feature off; so does an invalid one (one warning, the socket address is used).
 *
 *   const trust = createTrustProxy({ read: () => config.PANEL_TRUST_PROXY });
 *   trust.originKey(req)     the throttling key: the socket address, or the right-most X-Forwarded-For entry that
 *                            is not itself trusted (peer must match). IPv4-mapped IPv6 is unmapped and IPv6 is
 *                            grouped by /64 ("2001:db8:1:2::/64"): an attacker owns a whole /64
 *   trust.isHttps(req)       encrypted socket, or "X-Forwarded-Proto: https" (right-most value) from a trusted peer
 *   trust.forwardedHosts(req) hosts of X-Forwarded-Host, only from a trusted peer
 *   trust.proxyHint(req)     names of the forwarded headers that arrived from an UNtrusted peer ([] when none):
 *                            feeds AUTH-1 `proxyHint` and the `undeclared_proxy` banner
 *   trust.isTrusted(addr)    does the address match the setting
 *   trust.state()            { enabled, invalid, mode }
 *
 * The value is read through `read()` on every call and parsed again only when it changes, so a test (or a
 * restart) never sees a stale list. Nothing here touches the network or a timer.
 */

const net = require("net");

const FORWARDED_HEADERS = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded", "x-real-ip"];

const PRIVATE_V4 = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["169.254.0.0", 16],
  ["127.0.0.0", 8],
];
const PRIVATE_V6 = [
  ["fc00::", 7],
  ["fe80::", 10],
];

/** "::ffff:1.2.3.4" -> "1.2.3.4"; a zone id ("%eth0") is dropped; anything else is returned as is. */
function unmap(address) {
  let value = String(address || "").trim();
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

/** The 8 groups of an IPv6 address as numbers, or null when it is not valid. */
function expandIPv6(address) {
  let value = unmap(address);
  if (!net.isIPv6(value)) return null;
  // embedded IPv4 tail ("::1.2.3.4" / "64:ff9b::1.2.3.4") -> two hexadecimal groups
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (tail) {
    const parts = tail[1].split(".").map(Number);
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    value = value.slice(0, tail.index) + hi + ":" + lo;
  }
  const halves = value.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length > 1 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill("0"), ...rest].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** The throttling key of an address: IPv4 as is, IPv6 grouped by /64. */
function keyOf(address) {
  const value = unmap(address);
  if (net.isIPv4(value)) return value;
  const groups = expandIPv6(value);
  if (groups) return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
  return value || "unknown";
}

function listValues(header) {
  if (header === undefined || header === null) return [];
  const raw = Array.isArray(header) ? header.join(",") : String(header);
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Parse a PANEL_TRUST_PROXY value.
 * @returns {{ enabled: boolean, invalid: boolean, mode: "off"|"all"|"list", matches: (address: string) => boolean }}
 */
function parseTrustProxy(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  const off = { enabled: false, invalid: false, mode: "off", matches: () => false };
  if (!text) return off;

  const tokens = text.split(/[\s,]+/).filter(Boolean);
  const list = new net.BlockList();
  let all = false;
  try {
    for (const token of tokens) {
      const lower = token.toLowerCase();
      if (lower === "all") {
        all = true;
      } else if (lower === "loopback") {
        list.addSubnet("127.0.0.0", 8, "ipv4");
        list.addAddress("::1", "ipv6");
      } else if (lower === "private") {
        for (const [base, bits] of PRIVATE_V4) list.addSubnet(base, bits, "ipv4");
        for (const [base, bits] of PRIVATE_V6) list.addSubnet(base, bits, "ipv6");
        list.addAddress("::1", "ipv6");
      } else if (token.includes("/")) {
        const [base, bitsText] = token.split("/");
        const address = unmap(base);
        const bits = Number(bitsText);
        const family = net.isIPv4(address) ? "ipv4" : net.isIPv6(address) ? "ipv6" : null;
        const max = family === "ipv4" ? 32 : 128;
        if (!family || !/^\d{1,3}$/.test(bitsText) || bits < 0 || bits > max) throw new Error("invalid CIDR");
        list.addSubnet(address, bits, family);
      } else {
        const address = unmap(token);
        const family = net.isIPv4(address) ? "ipv4" : net.isIPv6(address) ? "ipv6" : null;
        if (!family) throw new Error("invalid address");
        list.addAddress(address, family);
      }
    }
  } catch {
    return { enabled: false, invalid: true, mode: "off", matches: () => false };
  }

  if (all) return { enabled: true, invalid: false, mode: "all", matches: () => true };
  return {
    enabled: true,
    invalid: false,
    mode: "list",
    matches(address) {
      const value = unmap(address);
      const family = net.isIPv4(value) ? "ipv4" : net.isIPv6(value) ? "ipv6" : null;
      if (!family) return false;
      try {
        return list.check(value, family);
      } catch {
        return false;
      }
    },
  };
}

/**
 * @param {{ read?: () => string, value?: string, onInvalid?: () => void }} [options]
 *   `value` is a fixed setting (tests); `read` is called every time (default: process.env.PANEL_TRUST_PROXY).
 *   `onInvalid` is called once per distinct invalid value (the caller logs the warning).
 */
function createTrustProxy(options = {}) {
  const read =
    typeof options.read === "function"
      ? options.read
      : options.value !== undefined
        ? () => options.value
        : () => process.env.PANEL_TRUST_PROXY;

  let lastRaw = null;
  let parsed = parseTrustProxy("");
  let warned = null;

  function current() {
    const raw = String(read() || "");
    if (raw !== lastRaw) {
      lastRaw = raw;
      parsed = parseTrustProxy(raw);
      if (parsed.invalid && warned !== raw) {
        warned = raw;
        if (typeof options.onInvalid === "function") {
          try {
            options.onInvalid();
          } catch {
            // a failing warning never matters
          }
        }
      }
    }
    return parsed;
  }

  const peerOf = (req) => unmap((req && req.socket && req.socket.remoteAddress) || "");

  function peerIsTrusted(req) {
    const trust = current();
    return trust.enabled && trust.matches(peerOf(req));
  }

  return {
    state() {
      const { enabled, invalid, mode } = current();
      return { enabled, invalid, mode };
    },

    isTrusted(address) {
      const trust = current();
      return trust.enabled && trust.matches(address);
    },

    originKey(req) {
      const peer = peerOf(req);
      if (peer && peerIsTrusted(req)) {
        const trust = current();
        const chain = listValues(req.headers["x-forwarded-for"]);
        for (let i = chain.length - 1; i >= 0; i -= 1) {
          const entry = unmap(chain[i]);
          if (!net.isIP(entry)) return keyOf(peer); // garbage from the proxy: fail closed on the socket
          if (i === 0 || !trust.matches(entry)) return keyOf(entry);
        }
      }
      return keyOf(peer);
    },

    isHttps(req) {
      if (req && req.socket && req.socket.encrypted) return true;
      if (!peerIsTrusted(req)) return false;
      const values = listValues(req.headers["x-forwarded-proto"]);
      return values.length > 0 && values[values.length - 1].toLowerCase() === "https";
    },

    forwardedHosts(req) {
      if (!peerIsTrusted(req)) return [];
      return listValues(req.headers["x-forwarded-host"]).map((host) => host.toLowerCase());
    },

    proxyHint(req) {
      if (peerIsTrusted(req)) return [];
      return FORWARDED_HEADERS.filter((name) => req.headers[name] !== undefined);
    },
  };
}

module.exports = { createTrustProxy, parseTrustProxy, unmap, keyOf, expandIPv6 };
