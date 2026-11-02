"use strict";

/**
 * SSRF-safe URL fetcher of the messaging API (feature 004, contracts/runtime.md section 9, public-api.md 8.1 and
 * 8.2, research.md X16 and X17). SECURITY-CRITICAL: the caller of the public API chooses the URL, so every rule
 * below holds at EVERY hop and each one has a test that proves the connection is never opened (RT-95).
 *
 *   createUrlFetcher({ resolve, request, tmpDir, maxBytes, deadlineMs, timeoutSignal, sniff, now })
 *     fetchMedia(url, { maxBytes, kinds, signal, onBytes })  -> { path, size, contentType, sha256 }
 *                                                     streamed to <tmpDir>/<random>.part (0600, flag "wx")
 *     fetchPreview(url, { signal })                  -> { "matched-text", "canonical-url", title, description? } | null
 *   validateUrl(text) -> URL        throws MessagingError("url_forbidden", { params: { reason } })
 *   isPublicAddress(ip) -> boolean
 *   PUBLIC_RANGES                   frozen data: the CIDR lists a public address must NOT fall in
 *   fetchMedia, fetchPreview        the default instance (dns.promises.lookup, https.request, data/tmp/api)
 *
 * Per hop (the request plus at most 3 redirects): (1) `new URL` is the only parser; protocol exactly `https:`,
 * no credentials, port empty or 443, a DNS name with a dot that is not an IP literal in any spelling and not
 * localhost / *.localhost / *.local / *.internal / *.localdomain, at most 253 characters; (2) the name is resolved
 * once, inside the deadline, and EVERY address must be public or the whole name is refused (`host`; a resolution
 * failure is `host` too, no oracle on internal names); (3) the connection goes to the validated address itself
 * (`host: <ip>`, `servername` and `Host` the name, `agent: false` so no pooling and no environment proxy), never to
 * the name; (4) GET with fixed headers (nothing from the caller, no Cookie, no Authorization, identity encoding),
 * 200 only, redirects handled by hand and sent back through (1); (5) the body is counted while it streams whatever
 * Content-Length says and the first 4100 bytes are sniffed; (6) one deadline covers DNS, all hops and the body;
 * (7) the temporary file is removed on every error path.
 *
 * RT-96: the URL, the redirect targets and the response headers are never logged or stored; a failure carries a
 * `reason` and nothing else. This module has no logger on purpose.
 */

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { MessagingError } = require("./errors");
const { LIMITS } = require("./limits");

const MAX_REDIRECTS = 3;
const MAX_URL_CHARS = 8192;
const MAX_HEADER_BYTES = 16 * 1024;
const PREVIEW_BYTES = 256 * 1024;
const TITLE_MAX = 256;
const DESCRIPTION_MAX = 512;
const MAX_ADDRESS_ATTEMPTS = 4;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const INTERNAL_NAME = /(^|\.)localhost$|\.(local|internal|localdomain)$/;
const DEFAULT_DEADLINE_MS = 30000;

/** Ranges a public address is NOT in (research A7). `::ffff:0:0/96` is deliberately absent: mapped addresses are unmapped first */
const PUBLIC_RANGES = Object.freeze({
  ipv4: Object.freeze([
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.88.99.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
  ]),
  ipv6: Object.freeze([
    "::/128",
    "::1/128",
    "::/96",
    "64:ff9b::/96",
    "64:ff9b:1::/48",
    "100::/64",
    "2001::/32",
    "2001:db8::/32",
    "2002::/16",
    "fc00::/7",
    "fe80::/10",
    "fec0::/10",
    "ff00::/8",
  ]),
});

const forbidden = (reason) => new MessagingError("url_forbidden", { params: { reason } });
const unreachable = () => new MessagingError("url_unreachable");

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

let blockList = null;
function blocked() {
  if (!blockList) {
    blockList = new net.BlockList();
    for (const cidr of PUBLIC_RANGES.ipv4) {
      const [address, prefix] = cidr.split("/");
      blockList.addSubnet(address, Number(prefix), "ipv4");
    }
    for (const cidr of PUBLIC_RANGES.ipv6) {
      const [address, prefix] = cidr.split("/");
      blockList.addSubnet(address, Number(prefix), "ipv6");
    }
  }
  return blockList;
}

/** The eight 16-bit groups of an IPv6 text (an embedded IPv4 tail counts for two), or null */
function groupsOf(text) {
  if (!net.isIPv6(text)) return null;
  let work = text;
  const tail = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(work);
  if (tail) {
    const octets = tail[1].split(".").map(Number);
    if (octets.some((n) => n > 255)) return null;
    work = `${work.slice(0, work.length - tail[1].length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = work.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** "::ffff:a.b.c.d" in any spelling (dotted, hexadecimal, fully expanded) -> "a.b.c.d"; anything else unchanged */
function unmap(address) {
  const groups = groupsOf(address);
  if (groups && groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  return address;
}

/** Is this address one a server-side fetch may connect to? Anything unparsable, with a zone id, or in a listed range is not */
function isPublicAddress(ip) {
  if (typeof ip !== "string") return false;
  const text = ip.trim();
  if (!text || text.includes("%")) return false;
  const plain = unmap(text);
  const family = net.isIPv4(plain) ? "ipv4" : net.isIPv6(plain) ? "ipv6" : null;
  if (!family) return false;
  return !blocked().check(plain, family);
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

/** The host name of a validated URL: lower case, one trailing dot stripped */
function hostOf(url) {
  const name = url.hostname.toLowerCase();
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

/**
 * `new URL` is the only parser. Throws url_forbidden with the first violated rule as `reason`:
 * scheme, credentials, port, host.
 * @returns {URL}
 */
function validateUrl(text) {
  if (typeof text !== "string") throw forbidden("scheme");
  if (text.length > MAX_URL_CHARS) throw forbidden("host");
  let url;
  try {
    url = new URL(text);
  } catch {
    // an https URL the parser refuses has a bad host (1.2.3.4.5, a space...); anything else is not https at all
    throw forbidden(/^https:\/\//i.test(text) ? "host" : "scheme");
  }
  if (url.protocol !== "https:") throw forbidden("scheme");
  if (url.username || url.password) throw forbidden("credentials");
  if (url.port !== "") throw forbidden("port"); // the parser drops a default :443
  const host = hostOf(url);
  if (!host || host.length > 253 || host.startsWith("[") || net.isIP(host) !== 0 || INTERNAL_NAME.test(host) || !host.includes(".")) {
    throw forbidden("host");
  }
  return url;
}

// ---------------------------------------------------------------------------
// The fetcher
// ---------------------------------------------------------------------------

const defaultResolve = (host) => require("node:dns").promises.lookup(host, { all: true, verbatim: true });
const defaultRequest = (options, callback) => require("node:https").request(options, callback);

/** The cap of one download when the caller gives none: MAX_UPLOAD MB, read at call time */
function uploadCap() {
  return (Number(require("../../config").MAX_UPLOAD) || 230) * LIMITS.MB;
}

function createUrlFetcher(options = {}) {
  const resolve = options.resolve || defaultResolve;
  const request = options.request || defaultRequest;
  const deadlineMs = options.deadlineMs || DEFAULT_DEADLINE_MS;
  const timeoutSignal = options.timeoutSignal || ((ms) => AbortSignal.timeout(ms));
  const tmpDirOf = () => options.tmpDir || path.resolve(__dirname, "..", "..", "data", "tmp", "api");
  const sniffOf = () => options.sniff || require("./sniff");

  /** One signal for DNS, all hops and the body: the deadline, and the caller's signal when there is one */
  function signalFor(external) {
    const deadline = timeoutSignal(deadlineMs);
    return external ? AbortSignal.any([deadline, external]) : deadline;
  }

  /** `promise`, unless the signal aborts first */
  function raceAbort(signal, promise) {
    if (signal.aborted) return Promise.reject(unreachable());
    return new Promise((resolvePromise, reject) => {
      const onAbort = () => reject(unreachable());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolvePromise(value);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }

  /** Every address of the name, all public; a failure to resolve is `host` too (no oracle on internal names) */
  async function resolveAll(host, signal) {
    let list;
    try {
      list = await raceAbort(signal, Promise.resolve().then(() => resolve(host)));
    } catch (err) {
      if (signal.aborted) throw unreachable();
      throw forbidden("host");
    }
    const addresses = (Array.isArray(list) ? list : []).map((entry) => (typeof entry === "string" ? entry : entry && entry.address));
    if (!addresses.length || !addresses.every(isPublicAddress)) throw forbidden("host");
    return addresses;
  }

  /** One request to a validated address; resolves { res, req } with the response headers, rejects unreachable */
  function requestOnce(address, url, host, accept, signal) {
    return new Promise((resolvePromise, reject) => {
      let req;
      const onAbort = () => {
        if (req) req.destroy();
        reject(unreachable());
      };
      const done = () => signal.removeEventListener("abort", onAbort);
      try {
        req = request(
          {
            method: "GET",
            host: address,
            port: 443,
            path: `${url.pathname}${url.search}`,
            servername: host,
            headers: { Host: host, "User-Agent": "OpenWhatsappBot", Accept: accept, "Accept-Encoding": "identity" },
            agent: false,
            maxHeaderSize: MAX_HEADER_BYTES,
            rejectUnauthorized: true,
          },
          (res) => {
            done();
            // an aborted or reset response emits 'error': without a listener, between here and the moment the body
            // is read, that would be an uncaught exception
            res.on("error", () => {});
            resolvePromise({ res, req });
          },
        );
        req.on("error", () => {
          done();
          reject(unreachable());
        });
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) return onAbort();
        req.end();
      } catch {
        done();
        reject(unreachable());
      }
    });
  }

  /** Walk the redirects; resolves the 200 response (identity encoding) with the final URL */
  async function openResponse(urlString, { accept, signal }) {
    let url = validateUrl(urlString);
    for (let hop = 0; ; hop++) {
      const host = hostOf(url);
      const addresses = await resolveAll(host, signal);
      let opened = null;
      let lastError = unreachable();
      for (const address of addresses.slice(0, MAX_ADDRESS_ATTEMPTS)) {
        try {
          opened = await requestOnce(address, url, host, accept, signal);
          break;
        } catch (err) {
          lastError = err;
          if (signal.aborted) throw unreachable();
        }
      }
      if (!opened) throw lastError;
      const { res, req } = opened;
      const status = res.statusCode;

      if (REDIRECT_STATUS.has(status)) {
        const location = res.headers && res.headers.location;
        res.destroy();
        req.destroy();
        if (hop >= MAX_REDIRECTS) throw forbidden("redirects");
        if (typeof location !== "string" || !location) throw unreachable();
        let next;
        try {
          next = new URL(location, url);
        } catch {
          throw forbidden("scheme");
        }
        url = validateUrl(next.href);
        continue;
      }
      const encoding = String((res.headers && res.headers["content-encoding"]) || "").trim().toLowerCase();
      if (status !== 200 || (encoding && encoding !== "identity")) {
        res.destroy();
        req.destroy();
        throw unreachable();
      }
      return { res, req, url };
    }
  }

  /** Destroy the response when the signal aborts; returns the function that removes the listener */
  function guardBody(res, req, signal) {
    const onAbort = () => {
      res.destroy();
      req.destroy();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
  }

  async function fetchMedia(urlString, { maxBytes, kinds, signal: external, onBytes } = {}) {
    const signal = signalFor(external);
    const cap = Math.min(Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : Infinity, Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : Infinity, uploadCap());
    const tooLarge = () => new MessagingError("media_too_large", { params: { maxBytes: cap } });

    const { res, req } = await openResponse(urlString, { accept: "*/*", signal });
    const unguard = guardBody(res, req, signal);
    let handle = null;
    let file = null;
    try {
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > cap) throw tooLarge(); // a declared length only short-circuits

      const dir = tmpDirOf();
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      file = path.join(dir, `${crypto.randomBytes(16).toString("hex")}.part`);
      handle = await fsp.open(file, "wx", 0o600);

      const sniff = kinds ? sniffOf() : null;
      const hash = crypto.createHash("sha256");
      let size = 0;
      let head = Buffer.alloc(0);
      let sniffed = !sniff;
      for await (const chunk of res) {
        size += chunk.length;
        if (size > cap) throw tooLarge(); // counted while it streams, whatever Content-Length says
        // the caller counts the bytes landing on the disk (the API's shared disk bound); a MessagingError it throws ends the download
        if (typeof onBytes === "function") onBytes(chunk.length);
        hash.update(chunk);
        if (!sniffed) {
          head = Buffer.concat([head, chunk]);
          const window = sniff.HEAD_BYTES || 4100;
          if (head.length >= window) {
            sniff.check(kinds, await sniff.classifyHead(head.subarray(0, window)));
            sniffed = true;
            head = null;
          }
        }
        await handle.write(chunk);
      }
      if (signal.aborted) throw unreachable();
      if (!sniffed) sniff.check(kinds, await sniff.classifyHead(head));
      await handle.close();
      handle = null;
      return { path: file, size, contentType: String(res.headers["content-type"] || "") || null, sha256: hash.digest("hex") };
    } catch (err) {
      res.destroy();
      req.destroy();
      if (handle) await handle.close().catch(() => {});
      if (file) await fsp.unlink(file).catch(() => {});
      if (err instanceof MessagingError) throw err;
      throw unreachable(); // a reset, a truncated stream, an abort, a full disk: nothing more is said
    } finally {
      unguard();
    }
  }

  async function fetchPreview(urlString, { signal: external } = {}) {
    try {
      const signal = signalFor(external);
      const { res, req, url } = await openResponse(urlString, { accept: "text/html", signal });
      const unguard = guardBody(res, req, signal);
      try {
        if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(String(res.headers["content-type"] || ""))) return null;
        const chunks = [];
        let size = 0;
        for await (const chunk of res) {
          chunks.push(chunk);
          size += chunk.length;
          if (size >= PREVIEW_BYTES) break; // the title lives in the head: the first 256 KiB are enough
        }
        if (signal.aborted) return null;
        return previewOf(Buffer.concat(chunks).subarray(0, PREVIEW_BYTES).toString("utf8"), urlString, url.href);
      } finally {
        res.destroy();
        req.destroy();
        unguard();
      }
    } catch {
      return null; // a preview never fails a message
    }
  }

  return { fetchMedia, fetchPreview };
}

// ---------------------------------------------------------------------------
// Link preview parsing
// ---------------------------------------------------------------------------

function clean(value, max) {
  const { decode } = require("html-entities");
  const text = decode(String(value || ""))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(text).slice(0, max).join("");
}

/** `<title>`, `og:title`, `og:description` from the start of an HTML page */
function previewOf(html, matchedText, canonicalUrl) {
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const found of tag.matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[found[1].toLowerCase()] = found[2] ?? found[3] ?? found[4] ?? "";
    }
    const key = String(attrs.property || attrs.name || "").toLowerCase();
    if ((key === "og:title" || key === "og:description") && meta[key] === undefined && attrs.content !== undefined) meta[key] = attrs.content;
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = clean(meta["og:title"], TITLE_MAX) || clean(titleTag && titleTag[1], TITLE_MAX);
  if (!title) return null;
  const preview = { "matched-text": matchedText, "canonical-url": canonicalUrl, title };
  const description = clean(meta["og:description"], DESCRIPTION_MAX);
  if (description) preview.description = description;
  return preview;
}

// ---------------------------------------------------------------------------
// Default instance
// ---------------------------------------------------------------------------

let defaultFetcher = null;
const instance = () => defaultFetcher || (defaultFetcher = createUrlFetcher());

module.exports = {
  createUrlFetcher,
  validateUrl,
  isPublicAddress,
  PUBLIC_RANGES,
  fetchMedia: (urlString, opts) => instance().fetchMedia(urlString, opts),
  fetchPreview: (urlString, opts) => instance().fetchPreview(urlString, opts),
  MAX_REDIRECTS,
  PREVIEW_BYTES,
};
