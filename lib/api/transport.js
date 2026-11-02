"use strict";

/**
 * Transport rule of the public messaging API (feature 004, contracts/runtime.md section 15.10, public-api.md 1.2,
 * FR-003, research U1): HTTPS is required. A request is accepted when any of these holds:
 *
 *   1. the socket is encrypted, or a trusted proxy declares `X-Forwarded-Proto: https`;
 *   2. it is a LOCAL request: the TCP peer is loopback, no untrusted `X-Forwarded-*` header is present, and the
 *      effective client address is loopback. An untrusted loopback proxy adding `X-Forwarded-*` is not local; a
 *      trusted loopback proxy forwarding a public client is not local; the host's own interface addresses never are
 *      (Docker's userland proxy presents the docker0 address for Internet traffic);
 *   3. the effective client address is inside `ApiState.plainHttpFrom` (private ranges only, empty by default) and no
 *      untrusted forwarded header is present. The list is read and re-parsed on EVERY request, so a widened or removed
 *      entry applies at once; an entry outside the private ranges is dropped (fail closed), an empty list admits nobody.
 *
 *   createTransport({ trust, apiState }) -> { transportAllowed(req), isLocalRequest(req), isPlainHttpAllowed(req) }
 *   transportAllowed(req, deps), isLocalRequest(req, deps), isPlainHttpAllowed(req, deps)    the same with explicit deps
 *
 * `trust` is the trusted-proxy helper of lib/admin/http/trustProxy.js (`isHttps`, `proxyHint`, `clientAddress`),
 * `apiState` the switch module (`plainHttpFrom()`). Nothing here logs: an address never reaches a log line.
 */

const net = require("net");
const ipRules = require("./ipRules");

const LOOPBACK_V4 = new net.BlockList();
LOOPBACK_V4.addSubnet("127.0.0.0", 8, "ipv4");

/** 127.0.0.0/8, ::1 and their IPv4-mapped forms */
function isLoopback(address) {
  const value = ipRules.unmap(address);
  if (net.isIPv4(value)) return LOOPBACK_V4.check(value, "ipv4");
  if (net.isIPv6(value)) return value === "::1" || /^(0{1,4}:){7}0{0,3}1$/.test(value);
  return false;
}

const peerOf = (req) => (req && req.socket && req.socket.remoteAddress) || "";

function isLocalRequest(req, { trust }) {
  if (!isLoopback(peerOf(req))) return false;
  if (trust.proxyHint(req).length > 0) return false;
  return isLoopback(trust.clientAddress(req));
}

function isPlainHttpAllowed(req, { trust, apiState }) {
  if (trust.proxyHint(req).length > 0) return false;
  const configured = typeof apiState.plainHttpFrom === "function" ? apiState.plainHttpFrom() : [];
  // an empty compiled list means "no restriction" in ipRules: here an empty list means nobody
  const entries = ipRules.parse(configured, { privateOnly: true, max: ipRules.MAX_PLAIN_HTTP }).entries;
  if (entries.length === 0) return false;
  return ipRules.compile(entries).check(trust.clientAddress(req));
}

function transportAllowed(req, deps) {
  return Boolean(deps.trust.isHttps(req) || isLocalRequest(req, deps) || isPlainHttpAllowed(req, deps));
}

/** Bind the three predicates to their collaborators */
function createTransport(deps) {
  return {
    transportAllowed: (req) => transportAllowed(req, deps),
    isLocalRequest: (req) => isLocalRequest(req, deps),
    isPlainHttpAllowed: (req) => isPlainHttpAllowed(req, deps),
  };
}

module.exports = { createTransport, transportAllowed, isLocalRequest, isPlainHttpAllowed, isLoopback };
