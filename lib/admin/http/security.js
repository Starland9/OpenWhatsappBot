"use strict";

/**
 * Security headers and the unsafe-request guard (admin-http-api.md sections 1.6 and 1.13, FR-008, SC-005).
 *
 * Headers: `applySecurityHeaders(res)` runs on EVERY /admin answer (errors, redirects, 304, streams) and never
 * adds an `Access-Control-*` header: cross-origin requests die at the preflight, which is always refused.
 *
 * Guard: `security.guard({ req, route, session })` runs, in this order, for POST/PUT/PATCH/DELETE (the auth
 * level, step 1, was already checked by the router):
 *   2. Origin (else Referer) host[:port] is in { Host, X-Forwarded-Host from a trusted peer, host of
 *      PANEL_PUBLIC_URL }, else 403 origin_mismatch (logged once a minute with the hosts);
 *   3. Sec-Fetch-Site, when sent, is "same-origin" ("none" is refused), else 403 origin_mismatch;
 *   4. X-CSRF-Token equals the session token (timingSafeEqual), else 403 csrf_invalid.
 *      Skipped for `csrf: "origin"` routes (login, setup: no session exists yet);
 *   5. Content-Type is application/json (application/octet-stream on an `upload` route), else 415
 *      unsupported_media_type, even for an empty body.
 * A safe-method route flagged `sameOrigin` (the event stream, the QR image: EventSource and <img> cannot send
 * headers) is checked for steps 2 and 3 only, and only when the browser sent the headers.
 */

const crypto = require("crypto");
const { AdminError } = require("./response");

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

/** Header set of section 1.13 (Cache-Control is separate: it depends on the kind of answer). */
const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": CSP,
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
});

/**
 * Apply the security headers to `res`. `cacheControl` defaults to `no-store` (API, setup, QR); the static
 * files pass `no-cache`. An `Access-Control-*` header set earlier by mistake is removed.
 */
function applySecurityHeaders(res, { cacheControl } = {}) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (cacheControl) res.setHeader("Cache-Control", cacheControl);
  else if (!res.getHeader("Cache-Control")) res.setHeader("Cache-Control", "no-store");
  for (const name of res.getHeaderNames()) {
    if (name.startsWith("access-control-")) res.removeHeader(name);
  }
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** "application/json; charset=utf-8" -> "application/json" (lower case, parameters dropped). */
function mediaType(header) {
  return String(header || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

/** Constant-time string equality (both sides hashed first, so a different length leaks nothing). */
function safeEqual(a, b) {
  const digest = (value) => crypto.createHash("sha256").update(String(value)).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

/** Host[:port] of an Origin or Referer value, lower case; null when it does not parse ("null" included). */
function hostOf(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {{ forwardedHosts(req): string[] }} options.trustProxy
 * @param {() => string} [options.getPublicUrl]  PANEL_PUBLIC_URL, read at each use
 * @param {{ warn: Function }} [options.logger]
 * @param {() => number} [options.now]
 */
function createSecurity({ trustProxy, getPublicUrl, logger, now = Date.now } = {}) {
  let lastMismatchLog = 0;

  function allowedHosts(req) {
    const hosts = new Set();
    const hostHeader = req.headers.host;
    if (hostHeader) hosts.add(String(hostHeader).toLowerCase());
    if (trustProxy) for (const host of trustProxy.forwardedHosts(req)) hosts.add(host);
    const publicUrl = typeof getPublicUrl === "function" ? getPublicUrl() : "";
    if (publicUrl) {
      const host = hostOf(publicUrl);
      if (host) hosts.add(host);
    }
    return hosts;
  }

  function logMismatch(received, hosts) {
    const at = now();
    if (logger && at - lastMismatchLog >= 60 * 1000) {
      lastMismatchLog = at;
      // hosts only: no path, no query, no header dump. PANEL_PUBLIC_URL fixes a proxy that rewrites Host.
      logger.warn(
        { received: received || null, expected: [...hosts] },
        "admin: request refused, its Origin does not match this host (set PANEL_PUBLIC_URL when behind a proxy)",
      );
    }
  }

  /** Steps 2 and 3. `required`: Origin or Referer must be present (unsafe methods). */
  function checkOrigin(req, required) {
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const source = origin !== undefined ? origin : referer;
    if (source === undefined) {
      if (required) {
        logMismatch(null, allowedHosts(req));
        throw new AdminError("origin_mismatch");
      }
    } else {
      const received = hostOf(source);
      const hosts = allowedHosts(req);
      if (!received || !hosts.has(received)) {
        logMismatch(received, hosts);
        throw new AdminError("origin_mismatch");
      }
    }
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && String(site).toLowerCase() !== "same-origin") {
      throw new AdminError("origin_mismatch");
    }
  }

  function checkCsrf(req, session) {
    const sent = req.headers["x-csrf-token"];
    const expected = session && (session.csrf || session.csrfToken || session.csrfSecret);
    if (typeof sent !== "string" || !sent || !expected || !safeEqual(sent, expected)) {
      throw new AdminError("csrf_invalid");
    }
  }

  function checkContentType(req, route) {
    const wanted = route.upload ? "application/octet-stream" : "application/json";
    if (mediaType(req.headers["content-type"]) !== wanted) throw new AdminError("unsupported_media_type");
  }

  return {
    applyHeaders: applySecurityHeaders,

    /** Run the checks that apply to this request and route; throws an AdminError on the first failure. */
    guard({ req, route, session }) {
      if (UNSAFE_METHODS.has(req.method)) {
        checkOrigin(req, true);
        if (route.csrf === true) checkCsrf(req, session);
        checkContentType(req, route);
        return;
      }
      if (route.sameOrigin) checkOrigin(req, false);
    },
  };
}

module.exports = {
  createSecurity,
  applySecurityHeaders,
  SECURITY_HEADERS,
  CSP,
  UNSAFE_METHODS,
  mediaType,
  safeEqual,
  hostOf,
};
