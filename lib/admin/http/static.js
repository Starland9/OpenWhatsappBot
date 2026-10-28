"use strict";

/**
 * Static files of the single-page app (admin-http-api.md section 1.13, STA-1 and STA-2).
 *
 * The map is built ONCE from `lib/admin/public/` (the directory is injectable for the tests) and holds the
 * contents in memory. Only its exact keys are servable: there is no path-to-file mapping, so `..`, `%2e%2e`,
 * `%00`, backslashes, double slashes and double encoding simply miss and the caller answers the JSON 404.
 * Symbolic links, dot files and files without a known extension are never indexed.
 *
 *   const files = createStatic({ dir });
 *   files.lookup("/admin/css/app.css")  -> entry | null            (loads the directory on first use)
 *   files.serve(req, res, entry)        ETag (sha1) + 304, `Cache-Control: no-cache`, HEAD
 *   files.load() / files.keys() / files.size()
 *
 * `GET /admin` -> `308 /admin/` is a route of the router (see lib/admin/index.js), not of this module.
 * Nothing is read at require time or when createStatic() is called.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { finish } = require("./response");

const PREFIX = "/admin/";
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
});

const DEFAULT_DIR = path.join(__dirname, "..", "public");

/** Every indexable file under `dir`: [{ rel: "css/app.css", file: "/abs/..." }], sorted. */
function walk(dir, rel = "") {
  let entries;
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith(".")) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...walk(dir, relPath));
    else if (entry.isFile()) out.push({ rel: relPath, file: path.join(dir, relPath) });
  }
  return out;
}

function createStatic({ dir = DEFAULT_DIR, logger } = {}) {
  /** @type {Map<string, { key: string, body: Buffer, type: string, etag: string }>|null} */
  let map = null;

  function load() {
    const next = new Map();
    for (const { rel, file } of walk(dir)) {
      const type = CONTENT_TYPES[path.extname(rel).toLowerCase()];
      if (!type) continue;
      let body;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
          if (logger && stat.size > MAX_FILE_BYTES) logger.warn({ rel }, "admin: static file too large, not served");
          continue;
        }
        body = fs.readFileSync(file);
      } catch {
        continue;
      }
      const etag = `"${crypto.createHash("sha1").update(body).digest("hex")}"`;
      const entry = { key: PREFIX + rel, body, type, etag };
      next.set(entry.key, entry);
      if (rel === "index.html") next.set(PREFIX, { ...entry, key: PREFIX });
    }
    map = next;
    return map.size;
  }

  const ensure = () => {
    if (!map) load();
    return map;
  };

  return {
    load,
    size: () => ensure().size,
    keys: () => [...ensure().keys()],
    lookup(pathname) {
      return ensure().get(pathname) || null;
    },

    /** Answer GET/HEAD for an entry found by lookup(): 200, or 304 when If-None-Match matches the ETag. */
    serve(req, res, entry) {
      const headers = { ETag: entry.etag };
      const sent = req.headers["if-none-match"];
      if (sent && matches(sent, entry.etag)) {
        finish(res, { status: 304, headers, cacheControl: "no-cache" });
        return;
      }
      finish(res, {
        status: 200,
        body: entry.body,
        contentType: entry.type,
        headers,
        cacheControl: "no-cache",
        head: req.method === "HEAD",
      });
    },
  };
}

/** If-None-Match: "*", or a comma separated list of (possibly weak) validators, one of which is `etag`. */
function matches(header, etag) {
  if (String(header).trim() === "*") return true;
  return String(header)
    .split(",")
    .map((item) => item.trim().replace(/^W\//, ""))
    .includes(etag);
}

module.exports = { createStatic, CONTENT_TYPES, PREFIX };
