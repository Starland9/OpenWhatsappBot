"use strict";
/**
 * HTTP client of the admin tests (contracts/runtime.md section 16): a cookie jar over
 * `res.headers.getSetCookie()`, the pre-session calls and the guarded `api()` call a browser would make.
 *
 *   const client = createAdminClient({ base, port });
 *   await client.setup(password, { token })      GET /admin/setup?token= (303, cookie owb_setup) then POST /admin/api/setup
 *   await client.login(password)                 POST /admin/api/login
 *   await client.api(method, path, body, extra)  adds Origin, X-CSRF-Token (when a session exists) and the JSON
 *                                                header; returns { status, headers, json, text }
 *   await client.get(path, extra)                same, safe method (no CSRF header)
 *   await client.raw({ method, path, headers, body, chunks, cookies })
 *                                                a hostile request sent exactly as written over node:http: no header
 *                                                is added except the jar's Cookie (cookies: false drops it)
 *   client.cookie(name) / client.cookies()       the jar;  client.csrf  the token of the last auth answer
 *   client.fork()                                a second client with an EMPTY jar (another browser)
 *
 * A client remembers a string `csrf` found in any JSON answer, like the SPA's api.mjs. Cookies with
 * `Max-Age=0` are removed from the jar, as a browser does.
 */

const http = require("http");

/** `Set-Cookie` line -> { name, value, attrs: { lowerName: value|true } }. */
function parseSetCookie(line) {
  const parts = String(line).split(";");
  const first = parts.shift();
  const at = first.indexOf("=");
  const name = first.slice(0, at).trim();
  const value = first.slice(at + 1).trim();
  const attrs = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    const key = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase();
    if (key) attrs[key] = eq === -1 ? true : part.slice(eq + 1).trim();
  }
  return { name, value, attrs };
}

/** Send a request whose target is used verbatim (fetch would normalise `..` and `%2e`). */
function rawRequest({ port, method = "GET", path: target = "/", headers = {}, body, chunks }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: target, headers, agent: false }, (res) => {
      const parts = [];
      res.on("data", (chunk) => parts.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(parts);
        const text = buffer.toString("utf8");
        resolve({
          status: res.statusCode,
          headers: res.headers,
          setCookies: res.headers["set-cookie"] || [],
          buffer,
          text,
          get json() {
            try {
              return JSON.parse(text);
            } catch {
              return null;
            }
          },
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (chunks) {
      for (const chunk of chunks) req.write(chunk);
      req.end();
    } else {
      req.end(body);
    }
  });
}

function createAdminClient({ base, port }, options = {}) {
  const jar = new Map();
  let csrf = null;
  const baseOrigin = options.origin || base;

  function absorb(setCookies) {
    for (const line of setCookies || []) {
      const cookie = parseSetCookie(line);
      if (!cookie.name) continue;
      if (cookie.attrs["max-age"] !== undefined && Number(cookie.attrs["max-age"]) <= 0) jar.delete(cookie.name);
      else jar.set(cookie.name, cookie.value);
    }
  }

  const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

  function remember(json) {
    if (json && typeof json === "object" && typeof json.csrf === "string") csrf = json.csrf;
  }

  async function send(method, path, { body, headers = {}, guarded = true } = {}) {
    const merged = { Accept: "application/json" };
    if (guarded) {
      merged.Origin = baseOrigin;
      if (method !== "GET" && method !== "HEAD") {
        merged["Content-Type"] = "application/json";
        if (csrf) merged["X-CSRF-Token"] = csrf;
      }
    }
    Object.assign(merged, headers); // an explicit header (or null, to drop one) always wins
    const cookie = cookieHeader();
    if (cookie && merged.Cookie === undefined) merged.Cookie = cookie;
    for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];

    const init = { method, headers: merged, redirect: "manual" };
    if (body !== undefined && method !== "GET" && method !== "HEAD") {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    absorb(res.headers.getSetCookie());
    remember(json);
    return { status: res.status, headers: res.headers, json, text, setCookies: res.headers.getSetCookie() };
  }

  const client = {
    base,
    port,
    get csrf() {
      return csrf;
    },
    set csrf(value) {
      csrf = value;
    },
    cookie: (name) => jar.get(name) || null,
    cookies: () => Object.fromEntries(jar),
    setCookie: (name, value) => jar.set(name, value),
    clearCookies() {
      jar.clear();
      csrf = null;
    },

    api: (method, path, body, extra = {}) => send(String(method).toUpperCase(), path, { body, ...extra }),
    get: (path, extra = {}) => send("GET", path, extra),

    /** The setup (or reset) flow: the link landing, then the password. */
    async setup(password, { token } = {}) {
      const landing = await send("GET", `/admin/setup?token=${encodeURIComponent(token)}`, { guarded: false });
      const answer = await send("POST", "/admin/api/setup", { body: { password } });
      return { landing, answer };
    },

    login: (password) => send("POST", "/admin/api/login", { body: { password } }),

    async raw({ method = "GET", path = "/", headers = {}, body, chunks, cookies = true } = {}) {
      const merged = { ...headers };
      const cookie = cookieHeader();
      if (cookies && cookie && merged.Cookie === undefined) merged.Cookie = cookie;
      for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
      if (body !== undefined && merged["Content-Length"] === undefined && !chunks) merged["Content-Length"] = Buffer.byteLength(body);
      const res = await rawRequest({ port, method, path, headers: merged, body, chunks });
      absorb(res.setCookies);
      return res;
    },

    fork: () => createAdminClient({ base, port }, options),
  };
  return client;
}

module.exports = { createAdminClient, rawRequest, parseSetCookie };
