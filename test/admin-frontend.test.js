"use strict";
/**
 * T071: the admin SPA shell under lib/admin/public (static checks, no browser, no server).
 *
 *  - no forbidden DOM API / inline script or style / third-party URL anywhere in public/ (strict CSP, FR-010);
 *  - the vendored preact/htm files match the sha256 of vendor/MANIFEST.json;
 *  - every relative import resolves, no bare specifier outside vendor/;
 *  - api.mjs, i18n.mjs, live.mjs (and the pure helpers) import in Node without a DOM and behave:
 *    CSRF header, envelope parsing, session events, polling fallback after 3 errors, t() interpolation;
 *  - the navigation lists every area and each has its view file with a matching `meta`;
 *  - the colour tokens exist for light and dark with 4.5:1 text contrast.
 *
 * Contract test 11 (every api("...") path exists in the route registry) is written by W2-A once the routes exist.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { scan } = require("./helpers/jsScan");
const { assertNone } = require("./helpers/fakes");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "lib", "admin", "public");
const AREAS = [
  "dashboard", "settings", "commands", "groups", "pairing", "data", "broadcasts",
  "backup", "maintenance", "texts", "alerts", "logs", "stats", "audit",
];

const rel = (file) => path.relative(ROOT, file);
const read = (file) => fs.readFileSync(file, "utf8");
const load = (relative) => import(pathToFileURL(path.join(PUBLIC, relative)).href);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out.sort();
}

const allFiles = walk(PUBLIC);
const inVendor = (file) => file.startsWith(path.join(PUBLIC, "vendor") + path.sep);
const ours = allFiles.filter((f) => !inVendor(f));
const mjsOurs = ours.filter((f) => f.endsWith(".mjs"));

/** Source with comments blanked, so a comment that names a forbidden API does not trip the scan. */
function stripComments(file) {
  const text = read(file);
  if (file.endsWith(".mjs") || file.endsWith(".js")) return scan(text).masked;
  if (file.endsWith(".css")) return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  if (file.endsWith(".html") || file.endsWith(".svg")) return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  return text;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

// ---------------------------------------------------------------------------
// Static rules (FR-010, strict CSP)
// ---------------------------------------------------------------------------

test("public/ holds the expected shell files", () => {
  const needed = [
    "index.html", "icons.svg", "favicon.ico", "css/theme.css", "css/app.css",
    "js/app.mjs", "js/router.mjs", "js/api.mjs", "js/i18n.mjs", "js/live.mjs", "js/ui.mjs",
    "i18n/en.json", "i18n/fr.json", "vendor/MANIFEST.json",
  ];
  assertNone(needed.filter((f) => !fs.existsSync(path.join(PUBLIC, f))).map((f) => `${f} is missing`), "shell files:");
});

test("favicon.ico is a valid ICO container", () => {
  const ico = fs.readFileSync(path.join(PUBLIC, "favicon.ico"));
  assert.equal(ico.readUInt16LE(0), 0, "reserved");
  assert.equal(ico.readUInt16LE(2), 1, "type icon");
  const count = ico.readUInt16LE(4);
  assert.ok(count >= 1);
  const size = ico.readUInt32LE(6 + 8);
  const offset = ico.readUInt32LE(6 + 12);
  assert.ok(offset + size <= ico.length, "image data inside the file");
});

test("no forbidden DOM API, eval, inline style or console in our browser code", () => {
  const forbidden = [
    [/\binnerHTML\b/, "innerHTML"],
    [/\bouterHTML\b/, "outerHTML"],
    [/\binsertAdjacentHTML\b/, "insertAdjacentHTML"],
    [/\bdangerouslySetInnerHTML\b/, "dangerouslySetInnerHTML"],
    [/\bdocument\s*\.\s*write(?:ln)?\s*\(/, "document.write"],
    [/(?<![\w$.])eval\s*\(/, "eval("],
    [/\bnew\s+Function\b/, "new Function"],
    [/\bsetAttribute\s*\(\s*["'`]style["'`]/, 'setAttribute("style"'],
    [/\bjavascript\s*:/i, "javascript: URL"],
    [/\bstyle\s*=\s*[$"'{]/, "style= attribute"],
    [/\.\s*style\s*(?:\.|\[|=)/, "direct .style access (use a CSS class)"],
    [/\bon[a-z]+\s*=\s*["']/i, "inline on*= handler"],
    [/\bconsole\s*\./, "console.*"],
    [/\bdocument\s*\.\s*cookie\b/, "document.cookie"],
  ];
  const problems = [];
  for (const file of mjsOurs) {
    const text = stripComments(file);
    for (const [re, label] of forbidden) {
      const match = re.exec(text);
      if (match) problems.push(`${rel(file)}:${lineOf(text, match.index)}  ${label}`);
    }
  }
  assertNone(problems, "forbidden construct in lib/admin/public (outside vendor/):");
});

test("index.html: one module script, no inline script, style or handler, no data", () => {
  const html = stripComments(path.join(PUBLIC, "index.html"));
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1, "exactly one <script>");
  assert.match(scripts[0][1], /type="module"/);
  assert.match(scripts[0][1], /src="\/admin\/js\/app\.mjs"/);
  assert.equal(scripts[0][2].trim(), "", "no inline script body");
  assert.doesNotMatch(html, /<style\b/i, "no <style> element");
  assert.doesNotMatch(html, /\sstyle\s*=/i, "no style= attribute");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "no inline event handler");
  assert.match(html, /<meta\s+name="viewport"/);
  assert.doesNotMatch(html, /csrf/i, "no CSRF token in the static shell");
  // every local reference resolves to a file served by the static map
  const refs = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  const problems = [];
  for (const ref of refs) {
    if (!ref.startsWith("/admin/")) {
      problems.push(`${ref}: not under /admin/`);
      continue;
    }
    if (!fs.existsSync(path.join(PUBLIC, ref.slice("/admin/".length)))) problems.push(`${ref}: no such file`);
  }
  assertNone(problems, "index.html references:");
});

test("no URL to another host (the XML namespace identifiers of SVG are not requests)", () => {
  const allowed = /^https?:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink|1998\/Math\/MathML|1999\/xhtml)$/;
  const problems = [];
  for (const file of allFiles) {
    if (/\.(ico|png|woff2?)$/.test(file)) continue;
    const name = rel(file);
    // vendored LICENSE files and the manifest cite upstream project URLs as plain text
    if (inVendor(file) && !/\.mjs$/.test(file)) continue;
    const text = file.endsWith(".mjs") && inVendor(file) ? read(file) : stripComments(file);
    for (const match of text.matchAll(/(?:https?:)?\/\/[^\s"'`)>\\]+/g)) {
      const url = match[0];
      if (!/^https?:/.test(url) && !/^\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(url)) continue; // `//` of a comment or a regex
      if (allowed.test(url)) continue;
      problems.push(`${name}:${lineOf(text, match.index)}  ${url}`);
    }
    if (/\.(html|css)$/.test(file) && /@import|url\(\s*["']?https?:/i.test(stripComments(file))) problems.push(`${name}: @import or external url()`);
  }
  assertNone(problems, "third-party URL (FR-010):");
});

test("vendored files match the sha256 of vendor/MANIFEST.json", () => {
  const dir = path.join(PUBLIC, "vendor");
  const manifest = JSON.parse(read(path.join(dir, "MANIFEST.json")));
  const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, file))).digest("hex");
  const problems = [];
  const listed = new Set(["MANIFEST.json"]);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 3, "preact, preact/hooks and htm are listed");
  for (const entry of manifest.files) {
    for (const key of ["name", "version", "license", "file", "sha256", "source", "tarball"]) {
      if (!entry[key]) problems.push(`${entry.file || entry.name}: "${key}" missing in the manifest`);
    }
    listed.add(entry.file);
    if (!fs.existsSync(path.join(dir, entry.file))) problems.push(`${entry.file}: listed but missing`);
    else if (sha(entry.file) !== entry.sha256) problems.push(`${entry.file}: sha256 differs from the manifest`);
    if (entry.licenseFile) {
      listed.add(entry.licenseFile);
      if (!fs.existsSync(path.join(dir, entry.licenseFile))) problems.push(`${entry.licenseFile}: license file missing`);
      else if (entry.licenseSha256 && sha(entry.licenseFile) !== entry.licenseSha256) problems.push(`${entry.licenseFile}: sha256 differs`);
    } else problems.push(`${entry.file}: no licenseFile`);
  }
  for (const file of fs.readdirSync(dir)) if (!listed.has(file)) problems.push(`${file}: in vendor/ but not in the manifest`);
  const byName = Object.fromEntries(manifest.files.map((f) => [f.name, f]));
  assert.equal(byName.preact.version, "10.29.8");
  assert.equal(byName["preact/hooks"].file, "preact-hooks.mjs");
  assert.equal(byName.htm.version, "3.1.1");
  assert.equal(byName.htm.license, "Apache-2.0");
  assert.match(read(path.join(dir, "preact-hooks.mjs")), /from"\.\/preact\.mjs"/, "hooks import rewritten to the sibling file");
  assertNone(problems, "vendor/:");
});

/**
 * The module specifiers of a source file: `import x from "s"`, `import "s"`, `export ... from "s"` and `import("s")`.
 * Found on the token level (a string literal preceded by `from` / `import` / `import(`), so a string that merely
 * ends with the word "export" or "import", such as the path "/admin/api/backup/export", is not read as a statement.
 */
function moduleSpecifiers(src) {
  const { skeleton, tokens } = scan(src);
  const out = [];
  for (const token of tokens) {
    if (token.quote === "`" || token.nested) continue;
    const before = skeleton.slice(Math.max(0, token.start - 40), token.start);
    if (/(?<![\w$.])(?:from|import)\s*$/.test(before) || /(?<![\w$.])import\s*\(\s*$/.test(before)) out.push({ spec: token.text, index: token.start });
  }
  return out;
}

test("the module specifier scan reads real import/export statements only", () => {
  const found = (code) => moduleSpecifiers(code).map((m) => m.spec);
  assert.deepEqual(found('import { a } from "./a.mjs";\nimport b from "./b.mjs";\nimport "./c.mjs";'), ["./a.mjs", "./b.mjs", "./c.mjs"]);
  assert.deepEqual(found('export * from "./d.mjs";\nexport { x } from "./e.mjs";\nconst m = await import("./f.mjs");'), ["./d.mjs", "./e.mjs", "./f.mjs"]);
  assert.deepEqual(found('import {\n  a,\n  b,\n} from "./g.mjs";'), ["./g.mjs"]);
  // strings that only look like statements
  assert.deepEqual(found('export const EXPORT_PATH = "/admin/api/backup/export";\nconst other = "/admin/api/backup/export", next = "x";'), []);
  assert.deepEqual(found('const url = "/x/import";\nconst from = "y";\nArray.from("abc");\nconst o = { from: "z" };'), []);
  assert.deepEqual(found('// import "./commented.mjs";\n/* export * from "./block.mjs" */'), []);
});

test("every relative import resolves; no bare specifier outside vendor/", () => {
  const problems = [];
  let seen = 0;
  for (const file of allFiles.filter((f) => f.endsWith(".mjs"))) {
    const src = read(file);
    for (const { spec, index } of moduleSpecifiers(src)) {
      seen++;
      const where = `${rel(file)}:${lineOf(src, index)}  "${spec}"`;
      if (!spec.startsWith(".") && !spec.startsWith("/admin/")) {
        problems.push(`${where}  bare specifier (the browser cannot resolve it)`);
        continue;
      }
      const target = spec.startsWith("/admin/") ? path.join(PUBLIC, spec.slice("/admin/".length)) : path.resolve(path.dirname(file), spec);
      if (!target.startsWith(PUBLIC + path.sep)) problems.push(`${where}  leaves lib/admin/public`);
      else if (!fs.existsSync(target) || !fs.statSync(target).isFile()) problems.push(`${where}  does not resolve`);
      else if (inVendor(target) === false && !/\.m?js$/.test(target) && !/\.json$/.test(target)) problems.push(`${where}  unexpected file type`);
    }
  }
  assert.ok(seen > 150, `the scan finds the imports of the SPA (${seen})`);
  assertNone(problems, "imports:");
});

test("every module of the SPA imports in Node without a DOM", async () => {
  const problems = [];
  for (const file of mjsOurs.filter((f) => f !== path.join(PUBLIC, "js", "app.mjs"))) {
    try {
      await import(pathToFileURL(file).href);
    } catch (error) {
      problems.push(`${rel(file)}: ${error.message}`);
    }
  }
  assertNone(problems, "import failed (a module touches the DOM at import time?):");
  // app.mjs is the entry point: it starts itself only when a document exists
  assert.match(read(path.join(PUBLIC, "js", "app.mjs")), /typeof document !== "undefined"/);
});

// ---------------------------------------------------------------------------
// Navigation and views
// ---------------------------------------------------------------------------

test("the navigation lists every area and each has its view file with a matching meta", async () => {
  const router = await load("js/router.mjs");
  assert.deepEqual(router.AREAS.map((a) => a.area), AREAS);
  const sprite = read(path.join(PUBLIC, "icons.svg"));
  const problems = [];
  for (const entry of router.AREAS) {
    const file = path.join(PUBLIC, "js", "views", `${entry.area}.mjs`);
    if (!fs.existsSync(file)) {
      problems.push(`views/${entry.area}.mjs is missing`);
      continue;
    }
    const view = await import(pathToFileURL(file).href);
    if (typeof view.default !== "function") problems.push(`views/${entry.area}.mjs: no default component`);
    if (!view.meta || view.meta.area !== entry.area || view.meta.titleKey !== entry.titleKey || view.meta.icon !== entry.icon) {
      problems.push(`views/${entry.area}.mjs: meta ${JSON.stringify(view.meta)} differs from the router entry ${JSON.stringify(entry)}`);
    }
    if (!sprite.includes(`id="i-${entry.icon}"`)) problems.push(`icon "${entry.icon}" of ${entry.area} is not in icons.svg`);
    if (typeof router.VIEW_LOADERS[entry.area] !== "function") problems.push(`no lazy loader for ${entry.area}`);
  }
  for (const extra of ["login", "setup", "account"]) {
    if (typeof router.VIEW_LOADERS[extra] !== "function") problems.push(`no lazy loader for ${extra}`);
  }
  assertNone(problems, "areas and views:");
  // the Nav component is driven by the same list
  assert.match(read(path.join(PUBLIC, "js", "components", "nav.mjs")), /AREAS\.map/);
});

test("every icon named in the code exists in icons.svg", () => {
  const sprite = read(path.join(PUBLIC, "icons.svg"));
  const known = new Set([...sprite.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map((m) => m[1]));
  const problems = [];
  for (const file of mjsOurs) {
    const text = stripComments(file);
    for (const match of text.matchAll(/(?:<\$\{Icon\}\s+name|\bicon)\s*=\s*"([a-z0-9-]+)"/g)) {
      if (!known.has(match[1])) problems.push(`${rel(file)}:${lineOf(text, match.index)}  icon "${match[1]}"`);
    }
  }
  assertNone(problems, "unknown icon:");
});

test("router: hash parsing, screens and views", async () => {
  const router = await load("js/router.mjs");
  assert.deepEqual(router.parseHash(""), { name: "dashboard", rest: [], query: {}, path: "/" });
  assert.equal(router.parseHash("#/settings").name, "settings");
  assert.deepEqual(router.parseHash("#/settings/PREFIX?tab=a").rest, ["PREFIX"]);
  assert.deepEqual(router.parseHash("#/settings/PREFIX?tab=a").query, { tab: "a" });
  assert.equal(router.parseHash("#/setup").name, "setup");
  assert.equal(router.parseHash("#/setup/invalid").name, "setup_invalid");
  assert.equal(router.parseHash("#/nope").name, "not_found");
  assert.equal(router.parseHash("#/groups/120363%40g.us").rest[0], "120363@g.us");
  assert.equal(router.buildHash("groups", ["120363@g.us"]), "#/groups/120363%40g.us");
  assert.equal(router.buildHash("logs", [], { level: "error" }), "#/logs?level=error");

  const route = (name) => ({ name });
  assert.equal(router.resolveScreen({ loaded: false }, route("dashboard")), "loading");
  assert.equal(router.resolveScreen({ loaded: true, loadError: "network_error" }, route("dashboard")), "error");
  assert.equal(router.resolveScreen({ loaded: true, authenticated: true }, route("login")), "app");
  assert.equal(router.resolveScreen({ loaded: true, accountExists: false, setup: null }, route("dashboard")), "no_account");
  assert.equal(router.resolveScreen({ loaded: true, accountExists: false, setup: { purpose: "setup" } }, route("setup")), "setup");
  assert.equal(router.resolveScreen({ loaded: true, accountExists: true, setup: { purpose: "reset" } }, route("setup")), "setup");
  assert.equal(router.resolveScreen({ loaded: true, accountExists: true, setup: { purpose: "reset" } }, route("login")), "login");
  assert.equal(router.resolveScreen({ loaded: true, accountExists: true, setup: null }, route("dashboard")), "login");
  assert.equal(router.resolveScreen({ loaded: true, accountExists: true, setup: null }, route("setup_invalid")), "setup_invalid");
  assert.equal(router.resolveScreen({ loaded: true, accountExists: false, setup: null }, route("setup_invalid")), "setup_invalid");
  assert.equal(await router.loadView("nothing"), null);
  assert.equal(typeof (await router.loadView("dashboard")), "function");
});

// ---------------------------------------------------------------------------
// api.mjs
// ---------------------------------------------------------------------------

function jsonResponse(status, body, headers = {}) {
  return new Response(body === null ? "" : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init, headers: init.headers || {} });
    return handler(url, init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

test("api: CSRF token from answers, JSON on every unsafe request, GET query from an object", async () => {
  const { createApi } = await load("js/api.mjs");
  const fetch = fakeFetch((url) => (url.includes("session") ? jsonResponse(200, { authenticated: true, csrf: "tok-123" }) : jsonResponse(200, { ok: true })));
  const client = createApi({ fetch });
  assert.equal(client.getCsrf(), null);

  await client.api("GET", "/admin/api/session");
  assert.equal(client.getCsrf(), "tok-123", "the token comes from the AUTH-1 answer");
  const get = fetch.calls[0];
  assert.equal(get.init.method, "GET");
  assert.equal(get.init.body, undefined);
  assert.equal(get.init.credentials, "same-origin");
  assert.equal(get.headers["X-CSRF-Token"], undefined, "no CSRF header on a safe method");

  await client.api("POST", "/admin/api/logout");
  const post = fetch.calls[1];
  assert.equal(post.headers["Content-Type"], "application/json", "JSON type even without a body");
  assert.equal(post.headers["X-CSRF-Token"], "tok-123");
  assert.equal(post.init.body, "{}", "an empty body is sent as {}");

  await client.api("DELETE", "/admin/api/broadcasts/4?confirm=true");
  assert.equal(fetch.calls[2].init.body, "{}");
  assert.equal(fetch.calls[2].headers["Content-Type"], "application/json");

  await client.api("PATCH", "/admin/api/settings", { changes: [{ key: "PREFIX", op: "set", value: "!", version: 1 }] });
  assert.deepEqual(JSON.parse(fetch.calls[3].init.body).changes[0].key, "PREFIX");

  await client.api("GET", "/admin/api/logs", { since: 12, q: "", level: "warn", skip: null });
  assert.equal(fetch.calls[4].url, "/admin/api/logs?since=12&level=warn");
  await client.api("GET", "/admin/api/audit?x=1", { page: 2 });
  assert.equal(fetch.calls[5].url, "/admin/api/audit?x=1&page=2");

  client.setCsrf(null);
  assert.equal(client.getCsrf(), null);
});

test("api: the error envelope becomes an ApiError (code, fields, params, requestId, retry delay)", async () => {
  const { createApi, ApiError } = await load("js/api.mjs");
  const envelope = {
    error: {
      code: "validation_failed",
      fields: { PREFIX: { code: "invalid_format", params: { reason: "whitespace" } } },
      params: { x: 1 },
      requestId: "9f3c1a2b4d5e6f70",
    },
  };
  const responses = [
    jsonResponse(422, envelope),
    jsonResponse(429, { error: { code: "login_blocked", params: { retryAfterMs: 900000 } } }, { "Retry-After": "900" }),
    jsonResponse(429, { error: { code: "rate_limited" } }, { "Retry-After": "7" }),
    new Response("<html>Bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } }),
    new Response("not json", { status: 200 }),
  ];
  const client = createApi({ fetch: fakeFetch(() => responses.shift()) });

  await assert.rejects(client.api("PATCH", "/admin/api/settings", {}), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 422);
    assert.equal(err.code, "validation_failed");
    assert.deepEqual(err.fields.PREFIX, { code: "invalid_format", params: { reason: "whitespace" } });
    assert.deepEqual(err.params, { x: 1 });
    assert.equal(err.requestId, "9f3c1a2b4d5e6f70");
    assert.equal(err.message, "validation_failed", "a code, never prose");
    return true;
  });
  await assert.rejects(client.api("POST", "/admin/api/login", { password: "x" }), (err) => err.code === "login_blocked" && err.retryAfterMs === 900000);
  await assert.rejects(client.api("POST", "/admin/api/pairing/code", { phone: "1" }), (err) => err.code === "rate_limited" && err.retryAfterMs === 7000);
  await assert.rejects(client.api("GET", "/admin/api/state"), (err) => err.code === "invalid_response" && err.status === 502);
  await assert.rejects(client.api("GET", "/admin/api/state"), (err) => err.code === "invalid_response");

  const down = createApi({ fetch: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(down.api("GET", "/admin/api/state"), (err) => err.code === "network_error" && err.status === 0);
});

test("api: 401 session_expired and unauthenticated are emitted (and drop the CSRF token), other 401s are not", async () => {
  const { createApi } = await load("js/api.mjs");
  const queue = [
    jsonResponse(200, { csrf: "t1" }),
    jsonResponse(401, { error: { code: "session_expired" } }),
    jsonResponse(401, { error: { code: "unauthenticated" } }),
    jsonResponse(401, { error: { code: "invalid_credentials" } }),
    jsonResponse(401, { error: { code: "token_invalid" } }),
  ];
  const client = createApi({ fetch: fakeFetch(() => queue.shift()) });
  const seen = [];
  client.on("session_expired", (err) => seen.push(`expired:${err.code}`));
  const off = client.on("unauthenticated", (err) => seen.push(`unauth:${err.code}`));
  client.on("session_expired", () => {
    throw new Error("a listener must not break the request");
  });

  await client.api("GET", "/admin/api/session");
  assert.equal(client.getCsrf(), "t1");
  await assert.rejects(client.api("GET", "/admin/api/state"), (e) => e.code === "session_expired");
  assert.equal(client.getCsrf(), null);
  await assert.rejects(client.api("GET", "/admin/api/state"), (e) => e.code === "unauthenticated");
  await assert.rejects(client.api("POST", "/admin/api/login", {}), (e) => e.code === "invalid_credentials");
  await assert.rejects(client.api("POST", "/admin/api/setup", {}), (e) => e.code === "token_invalid");
  assert.deepEqual(seen, ["expired:session_expired", "unauth:unauthenticated"]);
  off();
});

test("api: upload() is an XMLHttpRequest PUT of the raw file with progress; download() saves the answer", async () => {
  const { createApi } = await load("js/api.mjs");

  class FakeXhr {
    constructor() {
      this.headers = {};
      this.upload = {};
      FakeXhr.last = this;
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    getResponseHeader() {
      return null;
    }
    send(body) {
      this.body = body;
      this.upload.onprogress({ lengthComputable: true, loaded: 50, total: 200 });
      this.status = 201;
      this.responseText = JSON.stringify({ uploadId: "u1", purpose: "backup", kind: "backup", size: 200 });
      this.onload();
    }
  }
  const client = createApi({ XMLHttpRequest: FakeXhr, fetch: fakeFetch(() => jsonResponse(200, { csrf: "tok" })) });
  await client.api("GET", "/admin/api/session");
  const file = { name: "x.owb", size: 200 };
  const progress = [];
  const answer = await client.upload(file, "backup", "my backup.owb", (p) => progress.push(p));
  const xhr = FakeXhr.last;
  assert.equal(xhr.method, "PUT");
  assert.equal(xhr.url, "/admin/api/uploads?purpose=backup&name=my+backup.owb");
  assert.equal(xhr.headers["Content-Type"], "application/octet-stream");
  assert.equal(xhr.headers["X-CSRF-Token"], "tok");
  assert.equal(xhr.body, file);
  assert.deepEqual(progress, [{ loaded: 50, total: 200, ratio: 0.25 }]);
  assert.equal(answer.uploadId, "u1");

  const saved = [];
  const dl = createApi({
    saveBlob: (blob, name) => saved.push({ size: blob.size, name }),
    fetch: fakeFetch((url, init) => {
      if (init.method === "POST") return new Response("DATA", { status: 200, headers: { "Content-Disposition": 'attachment; filename="openwabot-backup-20261028-010101.owb"' } });
      return jsonResponse(409, { error: { code: "busy" } });
    }),
  });
  const out = await dl.download("POST", "/admin/api/backup/export", { passphrase: "x" }, "fallback.owb");
  assert.deepEqual(saved, [{ size: 4, name: "openwabot-backup-20261028-010101.owb" }]);
  assert.equal(out.filename, "openwabot-backup-20261028-010101.owb");
  await assert.rejects(dl.download("GET", "/admin/api/backup/stored/x"), (e) => e.code === "busy");
});

// ---------------------------------------------------------------------------
// i18n.mjs
// ---------------------------------------------------------------------------

test("i18n: t() interpolation, plurals, fallback to English then to the key", async () => {
  const i18n = await load("js/i18n.mjs");
  i18n.__resetForTests();
  i18n.setCatalog("en", {
    "greet": "Hello {name}",
    "only_en": "English only",
    "list": "Keys: {keys}",
    "items_one": "{count} item",
    "items_other": "{count} items",
    "nested": { "a": "flattened" },
    "missing_param": "Value {x}",
  });
  i18n.setCatalog("fr", { "greet": "Bonjour {name}", "items_one": "{count} élément", "items_other": "{count} éléments" });
  await i18n.setLanguage("fr", { fetch: async () => ({ ok: true, json: async () => ({}) }), remember: false });
  assert.equal(i18n.getLanguage(), "fr");
  assert.equal(i18n.t("greet", { name: "Ada" }), "Bonjour Ada");
  assert.equal(i18n.t("only_en"), "English only", "falls back to English");
  assert.equal(i18n.t("no.such.key"), "no.such.key", "the key itself when missing");
  assert.equal(i18n.t("list", { keys: ["A", "B"] }), "Keys: A, B");
  assert.equal(i18n.t("items", { count: 1 }), "1 élément");
  assert.equal(i18n.t("items", { count: 3 }), "3 éléments");
  assert.equal(i18n.t("nested.a"), "flattened");
  assert.equal(i18n.t("missing_param"), "Value {x}", "an absent parameter is left visible");
  assert.equal(i18n.t("greet", { name: "<b>x</b>" }), "Bonjour <b>x</b>", "no escaping: Preact escapes text nodes");
  await i18n.setLanguage("en", { remember: false });
  assert.equal(i18n.t("items", { count: 2 }), "2 items");
  i18n.__resetForTests();
});

test("i18n: tError / tField read errors.<code> / fields.<code>, with the retry delay", async () => {
  const i18n = await load("js/i18n.mjs");
  i18n.__resetForTests();
  i18n.setCatalog("en", {
    "errors.unknown": "Unexpected ({code})",
    "errors.login_blocked": "Blocked, retry in {retryAfter}",
    "errors.internal_error": "Oops {requestId}",
    "errors.rate_limited": "Slow down: {retryAfter}",
    "fields.unknown": "Invalid",
    "fields.too_short": "Min {min}",
    "common.duration_seconds": "{n} s",
    "common.duration_minutes": "{n} min",
    "common.duration_hours": "{n} h",
    "common.moment": "a moment",
  });
  await i18n.setLanguage("en", { fetch: async () => ({ ok: true, json: async () => ({}) }), remember: false });
  assert.equal(i18n.tError({ code: "login_blocked", params: { retryAfterMs: 900000 }, retryAfterMs: 900000 }), "Blocked, retry in 15 min");
  assert.equal(i18n.tError({ code: "rate_limited", params: {} }), "Slow down: a moment");
  assert.equal(i18n.tError({ code: "internal_error", requestId: "abc" }), "Oops abc");
  assert.equal(i18n.tError({ code: "brand_new_code" }), "Unexpected (brand_new_code)");
  assert.equal(i18n.tError("brand_new_code"), "Unexpected (brand_new_code)");
  assert.equal(i18n.tField({ code: "too_short", params: { min: 12 } }), "Min 12");
  assert.equal(i18n.tField("too_short", { min: 8 }), "Min 8");
  assert.equal(i18n.tField({ code: "never_seen" }), "Invalid");
  assert.equal(i18n.formatDuration(45000), "45 s");
  assert.equal(i18n.formatDuration(7200000), "2 h");
  i18n.__resetForTests();
});

test("i18n: catalogs load from /admin/i18n/<lang>.json, the language follows the account, not BOT_LANG", async () => {
  const i18n = await load("js/i18n.mjs");
  i18n.__resetForTests();
  const requested = [];
  const fetch = async (url) => {
    requested.push(url);
    const lang = /\/([a-z]+)\.json$/.exec(url)[1];
    return { ok: true, json: async () => JSON.parse(read(path.join(PUBLIC, "i18n", `${lang}.json`))) };
  };
  const changes = [];
  const off = i18n.onLanguageChange((lang) => changes.push(lang));
  await i18n.setLanguage("fr", { fetch, remember: false });
  assert.deepEqual(requested, ["/admin/i18n/en.json", "/admin/i18n/fr.json"], "English first (fallback), then the wanted language");
  assert.equal(i18n.t("nav.dashboard"), "Tableau de bord");
  await i18n.setLanguage("en", { fetch, remember: false });
  assert.equal(i18n.t("nav.dashboard"), "Dashboard");
  assert.equal(requested.length, 2, "a loaded catalog is not fetched again");
  await i18n.setLanguage("xx", { fetch, remember: false });
  assert.equal(i18n.getLanguage(), "en", "an unknown language falls back to English");
  assert.deepEqual(changes, ["fr", "en"]);
  off();
  assert.equal(i18n.detectLanguage({ languages: ["de-DE", "fr-CA"], language: "de-DE" }), "fr");
  assert.equal(i18n.detectLanguage({ languages: ["de-DE"], language: "de-DE" }), "en");
  i18n.__resetForTests();
});

test("i18n: formatters", async () => {
  const i18n = await load("js/i18n.mjs");
  i18n.__resetForTests();
  i18n.setCatalog("en", { "common.duration_days": "{n} d", "common.duration_hours": "{n} h", "common.duration_minutes": "{n} min", "common.duration_seconds": "{n} s" });
  await i18n.setLanguage("en", { fetch: async () => ({ ok: true, json: async () => ({}) }), remember: false });
  assert.equal(i18n.formatBytes(1536), "1.5 KB");
  assert.equal(i18n.formatBytes(0), "0 B");
  assert.equal(i18n.formatBytes(240 * 1024 * 1024), "240 MB");
  assert.equal(i18n.formatUptime(93784), "1 d 2 h 3 min");
  assert.equal(i18n.formatUptime(5), "5 s");
  assert.equal(i18n.formatDateTime("not a date"), "");
  assert.notEqual(i18n.formatDateTime("2026-10-28T10:00:00Z"), "");
  i18n.__resetForTests();
});

// ---------------------------------------------------------------------------
// live.mjs
// ---------------------------------------------------------------------------

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  close() {
    this.readyState = 2;
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    if (this.onopen) this.onopen({});
  }
  fail() {
    if (this.onerror) this.onerror({});
  }
  emit(type, payload) {
    for (const fn of this.listeners[type] || []) fn({ data: typeof payload === "string" ? payload : JSON.stringify(payload) });
  }
}
FakeEventSource.instances = [];
const sources = () => FakeEventSource.instances;
const liveSources = () => FakeEventSource.instances.filter((s) => !s.closed);
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function withLive(t, fn) {
  const { mock } = test;
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  FakeEventSource.instances = [];
  const polled = [];
  const answers = {
    "/admin/api/state": { at: "now", bot: { status: "open" }, banners: [] },
    "/admin/api/pairing": { status: "open", registered: true, qr: null, code: null },
    "/admin/api/logs": { entries: [{ seq: 8, ts: "t", level: "info", name: "x", msg: "m" }], lastSeq: 8 },
    "/admin/api/jobs/job1": { job: { id: "job1", type: "restart", status: "running", phase: "stop" } },
    "/admin/api/broadcasts/5": { broadcast: { id: 5 }, runs: [{ id: 9, status: "running", total: 4, sent: 1, failed: 0, cancelled: 0, pending: 3, startedAt: "2026-10-28T10:00:00Z" }] },
  };
  const fetch = fakeFetch((url) => {
    const pathname = url.split("?")[0];
    polled.push(url);
    return answers[pathname] ? jsonResponse(200, answers[pathname]) : jsonResponse(404, { error: { code: "not_found" } });
  });
  const { createLive } = await load("js/live.mjs");
  const live = createLive({ EventSource: FakeEventSource, fetch });
  try {
    await fn({ live, polled, mock, fetch });
  } finally {
    live.stop();
    mock.timers.reset();
  }
}

test("live: one EventSource per tab, topics multiplexed, late subscribers get the snapshot", async (t) => {
  await withLive(t, async ({ live }) => {
    const states = [];
    const modes = [];
    live.subscribe("state", (s) => states.push(s.n));
    live.subscribe("connection", (c) => modes.push(c.mode));
    live.start();
    live.start(); // idempotent
    assert.equal(sources().length, 1, "one EventSource");
    assert.equal(sources()[0].url, "/admin/api/events?logs=0");
    sources()[0].open();
    sources()[0].emit("state", { n: 1 });
    sources()[0].emit("pairing", { status: "qr", qr: { version: 3 } });
    sources()[0].emit("state", "{broken");
    assert.deepEqual(states, [1], "a malformed frame is dropped");
    const late = [];
    live.subscribe("pairing", (p) => late.push(p.qr.version));
    assert.deepEqual(late, [3], "the last pairing payload is replayed to a late subscriber");
    assert.deepEqual(modes, ["sse"]);
    assert.equal(live.getMode(), "sse");
  });
});

test("live: logs=1 reconnects with the last seq; log events are tracked", async (t) => {
  await withLive(t, async ({ live }) => {
    const logs = [];
    live.subscribe("log", (l) => logs.push(l.seq));
    live.start();
    sources()[0].open();
    live.setLogs(true, 40);
    assert.equal(liveSources().length, 1, "still a single live source");
    assert.equal(liveSources()[0].url, "/admin/api/events?logs=1&since=40");
    liveSources()[0].open();
    liveSources()[0].emit("log", { seq: 41, level: "info" });
    liveSources()[0].emit("log", { seq: 42, level: "warn" });
    assert.deepEqual(logs, [41, 42]);
    assert.equal(live.getLastSeq(), 42);
    live.setLogs(true); // no change: no reconnect
    assert.equal(sources().length, 2);
    live.setLogs(false);
    assert.equal(liveSources()[0].url, "/admin/api/events?logs=0");
  });
});

test("live: after 3 consecutive errors it polls every 2 s, then returns to the stream when it reopens", async (t) => {
  await withLive(t, async ({ live, polled, mock }) => {
    const seen = { state: [], pairing: [], log: [], job: [], modes: [] };
    live.subscribe("state", (s) => seen.state.push(s.bot.status));
    live.subscribe("pairing", (p) => seen.pairing.push(p.status));
    live.subscribe("log", (l) => seen.log.push(l.seq));
    live.subscribe("job", (j) => seen.job.push(j.type === "broadcast" ? `broadcast:${j.runId}:${j.sent}/${j.total}` : `${j.type}:${j.phase}`));
    live.subscribe("connection", (c) => seen.modes.push(c.mode));
    live.setLogs(true, 5);
    live.watchJob("job1");
    live.watchBroadcast(5);
    live.start();
    const first = sources()[0];
    first.open();
    first.fail();
    first.fail();
    assert.equal(live.getMode(), "sse", "two errors are not enough");
    first.open(); // success resets the counter
    first.fail();
    first.fail();
    assert.equal(live.getMode(), "sse", "the counter was reset by a successful open");
    first.fail();
    assert.equal(live.getMode(), "polling", "three consecutive errors");
    assert.equal(first.closed, true);
    await flush();
    assert.ok(polled.some((u) => u === "/admin/api/state"));
    assert.ok(polled.some((u) => u === "/admin/api/pairing"));
    assert.ok(polled.some((u) => u === "/admin/api/logs?since=5"));
    assert.ok(polled.some((u) => u === "/admin/api/jobs/job1"));
    assert.ok(polled.some((u) => u === "/admin/api/broadcasts/5"));
    assert.deepEqual(seen.state, ["open"]);
    assert.deepEqual(seen.log, [8]);
    assert.ok(seen.job.includes("restart:stop") && seen.job.includes("broadcast:9:1/4"), `job payloads: ${seen.job}`);

    const before = polled.length;
    mock.timers.tick(2000);
    await flush();
    assert.ok(polled.length > before, "a poll every 2 s");
    assert.ok(polled.includes("/admin/api/logs?since=8"), "the next log poll starts after the last seq");
    mock.timers.tick(2000);
    await flush();
    assert.equal(polled.filter((u) => u === "/admin/api/state").length, 3);

    // the stream is probed again later; once it opens, polling stops
    mock.timers.tick(30000);
    const probe = liveSources()[0];
    assert.ok(probe && probe !== first, "a new EventSource probes the stream");
    probe.open();
    assert.equal(live.getMode(), "sse");
    const frozen = polled.length;
    mock.timers.tick(10000);
    await flush();
    assert.equal(polled.length, frozen, "no polling while the stream works");
    assert.deepEqual(seen.modes, ["sse", "polling", "sse"]);
  });
});

test("live: a CLOSED EventSource is reopened by the client; the session event ends the stream", async (t) => {
  await withLive(t, async ({ live, mock }) => {
    const ended = [];
    live.subscribe("session", (s) => ended.push(s.reason));
    live.start();
    const first = sources()[0];
    first.readyState = 2; // the browser gave up (for instance a 429 answer)
    first.fail();
    assert.equal(liveSources().length, 0);
    mock.timers.tick(3000);
    assert.equal(liveSources().length, 1, "reopened after a short delay");
    const second = liveSources()[0];
    second.open();
    second.emit("session", { reason: "expired" });
    assert.deepEqual(ended, ["expired"]);
    assert.equal(live.isRunning(), false);
    assert.equal(second.closed, true);
    mock.timers.tick(60000);
    assert.equal(liveSources().length, 0, "no reconnection after the session ended");
  });
});

test("live: without EventSource it polls from the start; polling stops on a 401", async (t) => {
  const { mock } = test;
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const { createLive } = await load("js/live.mjs");
    const polled = [];
    const live = createLive({
      EventSource: null,
      fetch: fakeFetch((url) => {
        polled.push(url);
        return jsonResponse(401, { error: { code: "session_expired" } });
      }),
    });
    live.subscribe("state", () => {});
    const originalES = globalThis.EventSource;
    delete globalThis.EventSource;
    live.start();
    assert.equal(live.getMode(), "polling");
    await flush();
    assert.deepEqual(polled, ["/admin/api/state"]);
    assert.equal(live.isRunning(), false, "a 401 stops the polling");
    mock.timers.tick(10000);
    await flush();
    assert.equal(polled.length, 1);
    if (originalES) globalThis.EventSource = originalES;
  } finally {
    mock.timers.reset();
  }
});

test("live: qrUrl and the polled broadcast payload", async () => {
  const live = await load("js/live.mjs");
  assert.equal(live.qrUrl(7), "/admin/api/pairing/qr.svg?v=7");
  assert.equal(live.broadcastJobPayload({ broadcast: { id: 1 }, runs: [] }), null);
  assert.deepEqual(
    live.broadcastJobPayload({ broadcast: { id: 2 }, runs: [{ id: 3, status: "done", total: 1, sent: 1, failed: 0, cancelled: 0, pending: 0, finishedAt: "T" }] }),
    { type: "broadcast", broadcastId: 2, runId: 3, status: "done", total: 1, sent: 1, failed: 0, cancelled: 0, pending: 0, updatedAt: "T" },
  );
});

// ---------------------------------------------------------------------------
// ui.mjs and the pure view helpers
// ---------------------------------------------------------------------------

test("ui: no_https banner rule, banner list, status tones", async () => {
  const ui = await load("js/ui.mjs");
  const at = (protocol, hostname) => ({ protocol, hostname });
  assert.equal(ui.isInsecureRemote(at("http:", "localhost")), false);
  assert.equal(ui.isInsecureRemote(at("http:", "127.0.0.1")), false);
  assert.equal(ui.isInsecureRemote(at("http:", "[::1]")), false);
  assert.equal(ui.isInsecureRemote(at("http:", "bot.example.com")), true);
  assert.equal(ui.isInsecureRemote(at("http:", "192.168.1.20")), true);
  assert.equal(ui.isInsecureRemote(at("https:", "bot.example.com")), false);
  assert.equal(ui.isInsecureRemote(null), false);

  const banners = ui.collectBanners({ state: { banners: [{ id: "restart_needed", severity: "info", params: { keys: ["A"] } }] }, session: { authenticated: true }, loc: at("http:", "bot.example.com") });
  assert.deepEqual(banners.map((b) => b.id), ["no_https", "restart_needed"]);
  const login = ui.collectBanners({ session: { authenticated: false, proxyHint: true }, loc: at("https:", "x.example") });
  assert.deepEqual(login.map((b) => b.id), ["undeclared_proxy"]);

  assert.equal(ui.statusTone("open"), "ok");
  assert.equal(ui.statusTone("qr"), "warn");
  assert.equal(ui.statusTone("logged_out"), "warn");
  assert.equal(ui.statusTone("reconnecting"), "info");
  assert.equal(ui.statusTone("stopped"), "neutral");
  assert.deepEqual(ui.BOT_STATUSES, ["idle", "connecting", "qr", "open", "reconnecting", "restarting", "stopped", "logged_out"]);
});

test("ui: confirmation helper (FR-039), toasts, theme, unsaved input", async () => {
  const ui = await load("js/ui.mjs");
  const first = ui.confirm({ title: "T1", message: "M1", confirmLabel: "Yes", cancelLabel: "No" });
  const second = ui.confirm({ title: "T2", cancelLabel: null, danger: false });
  assert.equal(ui.confirmStore.get().request.title, "T1");
  assert.equal(ui.confirmStore.get().request.danger, true, "destructive by default");
  ui.resolveConfirm(false);
  assert.equal(await first, false);
  assert.equal(ui.confirmStore.get().request.title, "T2", "requests are queued");
  assert.equal(ui.confirmStore.get().request.cancelLabel, null);
  ui.resolveConfirm(true);
  assert.equal(await second, true);
  assert.equal(ui.confirmStore.get().request, null);

  const id = ui.toast("hello", { kind: "success", ttl: 0 });
  assert.deepEqual(ui.toastStore.get().items.map((i) => i.message), ["hello"]);
  ui.dismissToast(id);
  assert.equal(ui.toastStore.get().items.length, 0);

  const attrs = {};
  const root = { setAttribute: (k, v) => (attrs[k] = v), removeAttribute: (k) => delete attrs[k] };
  assert.equal(ui.applyTheme("dark", root), "dark");
  assert.equal(attrs["data-theme"], "dark");
  assert.equal(ui.applyTheme("light", root), "light");
  assert.equal(attrs["data-theme"], "light");
  assert.equal(ui.applyTheme("auto", root), "auto");
  assert.equal("data-theme" in attrs, false, "auto follows the device");
  assert.equal(ui.applyTheme("purple", root), "auto");

  assert.equal(ui.hasUnsaved(), false);
  ui.setDirty("settings", true);
  assert.equal(ui.hasUnsaved(), true);
  const pending = ui.confirmLeave();
  assert.match(ui.confirmStore.get().request.confirmLabel, /.+/);
  ui.resolveConfirm(false);
  assert.equal(await pending, false);
  assert.equal(ui.hasUnsaved(), true, "still dirty after a refusal");
  const again = ui.confirmLeave();
  ui.resolveConfirm(true);
  assert.equal(await again, true);
  assert.equal(ui.hasUnsaved(), false, "leaving clears the flags");
  const events = [];
  const win = { addEventListener: (n, f) => events.push([n, f]), removeEventListener() {} };
  const stop = ui.installUnsavedGuard(win);
  assert.equal(events[0][0], "beforeunload");
  const ev = { prevented: false, preventDefault() { this.prevented = true; } };
  events[0][1](ev);
  assert.equal(ev.prevented, false, "nothing unsaved: no warning");
  ui.setDirty("x", true);
  events[0][1](ev);
  assert.equal(ev.prevented, true);
  ui.clearDirty();
  stop();
});

test("setup / login / account helpers", async () => {
  const setup = await load("js/views/setup-logic.mjs");
  assert.equal(setup.passwordLength("é😀a"), 3, "code points, not UTF-16 units");
  assert.equal(setup.validateNewPassword("short", "short").fields.password.code, "too_short");
  assert.equal(setup.validateNewPassword("short", "short").fields.password.params.min, 12);
  assert.equal(setup.validateNewPassword("", "").fields.password.code, "required");
  assert.equal(setup.validateNewPassword("x".repeat(257), "x".repeat(257)).fields.password.code, "too_long");
  assert.equal(setup.validateNewPassword("long enough pass", "different one!!").fields.confirm.code, "mismatch");
  assert.equal(setup.validateNewPassword("long enough pass", "long enough pass").ok, true);
  const change = setup.validatePasswordChange({ currentPassword: "", newPassword: "long enough pass", confirm: "long enough pass" });
  assert.equal(change.fields.currentPassword.code, "required");
  assert.equal(setup.validatePasswordChange({ currentPassword: "long enough pass", newPassword: "long enough pass", confirm: "long enough pass" }).fields.newPassword.code, "same_as_current");
  assert.equal(setup.validatePasswordChange({ currentPassword: "old old old old", newPassword: "long enough pass", confirm: "long enough pass" }).ok, true);
  assert.deepEqual(setup.pickFieldErrors({ fields: { password: { code: "too_weak" }, other: { code: "x" } } }, ["password"]), { password: { code: "too_weak" } });

  const login = await load("js/views/login-logic.mjs");
  assert.equal(login.remainingMs(0, 1000), 0);
  assert.equal(login.remainingMs(5000, 1000), 4000);
  assert.equal(login.remainingMs(500, 1000), 0);
  assert.equal(login.blockedUntilFrom({ retryAfterMs: 60000 }, 1000), 61000);
  assert.equal(login.blockedUntilFrom({}, 1000), 1000 + 15 * 60 * 1000);

  const account = await load("js/views/account-logic.mjs");
  assert.deepEqual(account.preferencesChange({ uiLang: "fr", theme: "auto" }, { uiLang: "en" }), { uiLang: "en" });
  assert.deepEqual(account.preferencesChange({ uiLang: "fr", theme: "auto" }, { theme: "dark", uiLang: "fr" }), { theme: "dark" });
  assert.equal(account.preferencesChange({ uiLang: "fr", theme: "auto" }, { uiLang: "fr" }), null);
  assert.equal(account.preferencesChange({ uiLang: "fr", theme: "auto" }, { uiLang: "de", theme: "pink" }), null);
});

// ---------------------------------------------------------------------------
// Colour tokens (FR-041)
// ---------------------------------------------------------------------------

function tokensOf(block) {
  const out = {};
  for (const match of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) out[match[1]] = match[2].trim();
  return out;
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("theme.css: light tokens on :root, dark tokens guarded by prefers-color-scheme and by data-theme, explicit body background", () => {
  const css = stripComments(path.join(PUBLIC, "css", "theme.css"));
  const light = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  const deviceDark = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n  \}\s*\}/);
  const forcedDark = css.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
  assert.ok(light, ":root block");
  assert.ok(deviceDark, '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ... } }');
  assert.ok(forcedDark, ':root[data-theme="dark"] block');
  assert.match(css, /body\s*\{[^}]*background:\s*var\(--bg\)/, "explicit body background");
  assert.match(light[1], /color-scheme:\s*light dark/);

  const L = tokensOf(light[1]);
  const D1 = tokensOf(deviceDark[1]);
  const D2 = tokensOf(forcedDark[1]);
  for (const name of ["bg", "surface", "text", "muted", "border", "primary", "danger", "warn", "ok", "focus"]) {
    assert.ok(L[name], `--${name} (light)`);
    assert.ok(D1[name], `--${name} (dark)`);
  }
  assert.deepEqual(D1, D2, "the two dark blocks hold the same tokens");
  assert.deepEqual(Object.keys(D1).sort(), Object.keys(L).sort().filter((k) => k !== "color-scheme"), "every token is redefined for dark");

  const problems = [];
  const check = (label, tokens, fg, bg, min = 4.5) => {
    const ratio = contrast(tokens[fg], tokens[bg]);
    if (ratio < min) problems.push(`${label}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1 (needs ${min}:1)`);
  };
  for (const [label, tokens] of [["light", L], ["dark", D1]]) {
    for (const bg of ["bg", "surface", "surface-2"]) {
      check(label, tokens, "text", bg);
      check(label, tokens, "muted", bg);
    }
    check(label, tokens, "primary", "bg"); // links
    check(label, tokens, "primary", "surface");
    check(label, tokens, "danger", "surface"); // field errors
    check(label, tokens, "primary-contrast", "primary");
    check(label, tokens, "primary-contrast", "primary-hover");
    check(label, tokens, "danger-contrast", "danger");
    check(label, tokens, "danger-contrast", "danger-hover");
    check(label, tokens, "primary-soft-text", "primary-soft");
    check(label, tokens, "danger-text", "danger-bg");
    check(label, tokens, "warn-text", "warn-bg");
    check(label, tokens, "ok-text", "ok-bg");
    check(label, tokens, "info-text", "info-bg");
    check(label, tokens, "focus", "bg", 3);
    check(label, tokens, "focus", "surface", 3);
  }
  assertNone(problems, "contrast:");
});

test("app.css: tables collapse to labelled cards under 600 px, dialogs and toasts exist, no fixed widths in px", () => {
  const css = stripComments(path.join(PUBLIC, "css", "app.css"));
  assert.match(css, /@media\s*\(max-width:\s*37\.5rem\)[\s\S]*\.table-cards\s+td::before\s*\{[^}]*attr\(data-label\)/);
  for (const selector of [".dialog", ".toasts", ".banner", ".nav", ".tabs", ".pagination", ".field-error", ".btn", ".badge"]) {
    assert.ok(css.includes(selector), `${selector} is styled`);
  }
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  const widths = [...css.matchAll(/(?<![-\w])(?:min-)?width:\s*(\d+)px/g)].filter((m) => Number(m[1]) > 1);
  assertNone(widths.map((m) => `width: ${m[1]}px`), "fixed pixel widths (360 px support):");
});

// ---------------------------------------------------------------------------
// Contract test 11: every API path used by the SPA is a registered route (admin-http-api.md section 2)
// ---------------------------------------------------------------------------

const API_PREFIX = "/admin/api/";
const CALL_CONTEXT = /(?:api|apiImpl|request|download|open)\s*\(\s*["'](GET|POST|PUT|PATCH|DELETE)["']\s*,\s*$/;

/** A template literal's text with every `${...}` (nested braces balanced) replaced by one NUL */
function templateShape(raw) {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === "$" && raw[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < raw.length && depth > 0) {
        if (raw[i] === "{") depth += 1;
        else if (raw[i] === "}") depth -= 1;
        i += 1;
      }
      out += "\u0000";
    } else {
      out += raw[i];
      i += 1;
    }
  }
  return out;
}

/** Every string or template literal of the SPA that starts with /admin/api/: { file, line, method|null, segments } */
function apiPathLiterals() {
  const out = [];
  const toSegments = (shape) =>
    shape.split("?")[0].slice(1).split("/").map((segment) => {
      if (!segment.includes("\u0000")) return { literal: segment };
      const prefix = segment.slice(0, segment.indexOf("\u0000"));
      return prefix ? { literal: prefix } : { any: true };
    });
  for (const file of mjsOurs) {
    const src = read(file);
    const { masked, tokens } = scan(src);
    const rawOf = (token) => src.slice(token.start + 1, token.end - 1);
    const shapeOf = (token) => (token.quote === "`" ? templateShape(rawOf(token)) : rawOf(token));
    // `const base = ...` / `const groupPath = (group) => ...` that hold an API prefix, reused as `${base}/filters`
    const prefixes = new Map();
    for (const token of tokens) {
      if (token.nested || !rawOf(token).startsWith(API_PREFIX)) continue;
      const def = /\bconst\s+(\w+)\s*=\s*(?:\([^)]*\)\s*=>\s*)?$/.exec(masked.slice(Math.max(0, token.start - 80), token.start));
      if (def) prefixes.set(def[1], shapeOf(token).split("?")[0]);
    }
    // `const base = groupBase(group)`: the same prefix under another name
    for (const alias of masked.matchAll(/\bconst\s+(\w+)\s*=\s*(\w+)\([^()]*\)\s*;/g)) {
      if (prefixes.has(alias[2])) prefixes.set(alias[1], prefixes.get(alias[2]));
    }
    for (const token of tokens) {
      if (token.nested) continue;
      let shape = null;
      if (rawOf(token).startsWith(API_PREFIX)) shape = shapeOf(token);
      else if (token.quote === "`") {
        const use = /^\$\{(\w+)(?:\([^{}]*\))?\}/.exec(rawOf(token));
        if (use && prefixes.has(use[1])) shape = prefixes.get(use[1]) + templateShape(rawOf(token).slice(use[0].length));
      }
      if (shape === null) continue;
      const context = CALL_CONTEXT.exec(masked.slice(Math.max(0, token.start - 60), token.start));
      out.push({ file, line: lineOf(src, token.start), method: context ? context[1] : null, segments: toSegments(shape), shape });
    }
  }
  return out;
}

function routeAccepts(route, call) {
  if (call.method && route.method !== call.method) return false;
  const parts = route.path.slice(1).split("/");
  if (parts[parts.length - 1] === "*" || parts.length !== call.segments.length) return false;
  return call.segments.every((segment, i) => parts[i].startsWith(":") || segment.any || segment.literal === parts[i]);
}

test("contract test 11: every /admin/api/... path used by the SPA matches a registered route (method and shape)", async (t) => {
  const { createTestAdmin } = require("./helpers/adminHarness");
  const admin = await createTestAdmin();
  t.after(() => admin.close());
  const routes = admin.admin.routes();
  assert.ok(routes.length > 60, `the registry is loaded (${routes.length} routes)`);

  const calls = apiPathLiterals();
  const problems = calls.filter((call) => !routes.some((route) => routeAccepts(route, call))).map((call) => `${rel(call.file)}:${call.line}  ${call.method || "(any method)"} ${call.shape.replace(/\u0000/g, "${...}")}`);
  const distinct = new Set(calls.map((call) => `${call.method || "*"} ${call.segments.map((s) => (s.any ? ":" : s.literal)).join("/")}`));
  t.diagnostic(`${calls.length} path literal(s), ${distinct.size} distinct, ${routes.length} registered routes`);
  assert.ok(distinct.size >= 45, `the scan finds the API paths of the views (${distinct.size})`);
  assertNone(problems, "API path without a registered route:");

  // the scan itself: a made-up path is not accepted
  const probe = { method: "POST", segments: ["admin", "api", "nothing", "here"].map((literal) => ({ literal })) };
  assert.equal(routes.some((route) => routeAccepts(route, probe)), false);
  // a wrong method on a real path is refused too
  const wrongMethod = { method: "DELETE", segments: ["admin", "api", "restart"].map((literal) => ({ literal })) };
  assert.equal(routes.some((route) => routeAccepts(route, wrongMethod)), false);
  const right = { method: "POST", segments: ["admin", "api", "restart"].map((literal) => ({ literal })) };
  assert.equal(routes.some((route) => routeAccepts(route, right)), true);
});

// ---------------------------------------------------------------------------
// Confirmation convention (FR-039, admin-http-api.md section 1.10)
// ---------------------------------------------------------------------------

/**
 * The destructive or disruptive actions of section 1.10. For each one: the file and the exact call that sends the
 * confirmation the server enforces (`"confirm": true` in the body, `?confirm=true` on a DELETE, or the richer forms
 * of BC-3, SET-2 and BAK-1), and the dialog (`confirm(...)` of ui.mjs) that must be shown shortly before it.
 */
const CONFIRMED_ACTIONS = [
  { id: "RST-1 restart (dashboard)", file: "js/views/dashboard.mjs", call: /api\("POST", "\/admin\/api\/restart", \{ confirm: true \}\)/ },
  { id: "RST-1 restart (settings, after a restart-effect change)", file: "js/views/settings.mjs", call: /api\("POST", "\/admin\/api\/restart", \{ confirm: true \}\)/ },
  { id: "RST-1 restart (banner restart_needed)", file: "js/ui.mjs", call: /apiImpl\("POST", "\/admin\/api\/restart", \{ confirm: true \}\)/ },
  { id: "PAIR-4 session logout", file: "js/views/pairing.mjs", call: /api\("POST", "\/admin\/api\/pairing\/logout", \{ confirm: true \}\)/ },
  { id: "GRP-6 group settings deletion", file: "js/views/groups-page.mjs", call: /api\("DELETE", `\$\{base\}\?confirm=true`\)/ },
  { id: "GRP-16 warnings reset (all)", file: "js/views/groups-members.mjs", call: /api\("DELETE", `\$\{base\}\/warnings\?confirm=true`\)/ },
  { id: "MNT-3 update apply", file: "js/views/maintenance-update.mjs", call: /api\("POST", "\/admin\/api\/maintenance\/update\/apply", \{ confirm: true \}\)/ },
  { id: "MNT-5 yt-dlp update", file: "js/views/maintenance-ytdlp.mjs", call: /api\("POST", "\/admin\/api\/maintenance\/ytdlp\/update", \{ confirm: true \}\)/ },
  { id: "MNT-7 storage purge", file: "js/views/maintenance-storage.mjs", call: /api\("POST", `\/admin\/api\/maintenance\/storage\/\$\{encodeURIComponent\(row\.id\)\}\/purge`, \{ confirm: true \}\)/ },
  { id: "BAK-3 restore", file: "js/views/backup-restore.mjs", call: /api\("POST", "\/admin\/api\/backup\/restore", \{ restoreToken: inspection\.restoreToken, confirm: true \}\)/ },
  { id: "BC-9 broadcast delete", file: "js/views/broadcasts-detail.mjs", call: /api\("DELETE", `\/admin\/api\/broadcasts\/\$\{broadcast\.id\}\?confirm=true`\)/ },
  // the richer forms: the call itself, then the field the body builder adds
  { id: "BC-3 broadcast creation (destination count)", file: "js/views/broadcasts-form.mjs", call: /api\("POST", "\/admin\/api\/broadcasts", buildBody\(form\)\)/, field: { file: "js/views/broadcasts-logic.mjs", needle: /body\.confirmTargets = targets\.length/ } },
  { id: "SET-2 owners emptied", file: "js/views/settings.mjs", call: /post\(\{ \.\.\.payload, confirm: \["owners_empty"\] \}\)/, field: { file: "js/views/settings-logic.mjs", needle: /"owners_empty"/ } },
  { id: "BAK-1 session export", file: "js/views/backup-export.mjs", call: /download\("POST", EXPORT_PATH, exportBody\(\{ passphrase, includeSession, sessionConfirmed \}\), fallbackFileName\(\)\)/, field: { file: "js/views/backup-logic.mjs", needle: /body\.confirmSession = Boolean\(sessionConfirmed\)/ } },
];

test("every destructive action of 1.10 asks first (dialog) and sends the confirmation the server enforces", () => {
  const problems = [];
  for (const action of CONFIRMED_ACTIONS) {
    const file = path.join(PUBLIC, action.file);
    const text = stripComments(file);
    const match = action.call.exec(text);
    if (!match) {
      problems.push(`${action.id}: call not found in ${action.file} (${action.call})`);
      continue;
    }
    // the dialog comes first: a confirm({...}) of ui.mjs (or the helper that wraps it) within the lines before the call
    const window = text.slice(Math.max(0, match.index - 2600), match.index);
    if (!/(?<![\w$.])(?:confirm|askOwners|ask\w*)\s*\(/.test(window)) problems.push(`${action.id}: no confirm(...) dialog shortly before the call in ${action.file}`);
    if (action.field && !action.field.needle.test(stripComments(path.join(PUBLIC, action.field.file)))) {
      problems.push(`${action.id}: ${action.field.file} does not add the confirmation field (${action.field.needle})`);
    }
  }
  assert.equal(CONFIRMED_ACTIONS.length, 14);
  assertNone(problems, "destructive action without its confirmation:");
});

test("no call to a route of 1.10 leaves the SPA without a confirmation: restart, logout, purge, update, restore, delete", () => {
  // every literal call to one of these routes, anywhere in the SPA, carries the `confirm` of its form
  const routes = [
    [/api\(\s*"POST",\s*"\/admin\/api\/restart"/g, /confirm: true/],
    [/api\(\s*"POST",\s*"\/admin\/api\/pairing\/logout"/g, /confirm: true/],
    [/api\(\s*"POST",\s*"\/admin\/api\/maintenance\/update\/apply"/g, /confirm: true/],
    [/api\(\s*"POST",\s*"\/admin\/api\/maintenance\/ytdlp\/update"/g, /confirm: true/],
    [/api\(\s*"POST",\s*`\/admin\/api\/maintenance\/storage\/[^`]*\/purge`/g, /confirm: true/],
    [/api\(\s*"POST",\s*"\/admin\/api\/backup\/restore"/g, /confirm: true/],
    [/api\(\s*"DELETE",\s*`[^`]*`/g, null], // DELETE: checked below
  ];
  const problems = [];
  let found = 0;
  for (const file of mjsOurs) {
    const text = stripComments(file);
    for (const [re, needle] of routes) {
      re.lastIndex = 0;
      for (const match of text.matchAll(re)) {
        found += 1;
        const call = text.slice(match.index, match.index + 260).split(/\)\s*[;,)\n]/)[0];
        if (needle && !needle.test(call)) problems.push(`${rel(file)}:${lineOf(text, match.index)}  ${call.slice(0, 90)}  (no ${needle})`);
        if (!needle) {
          // a DELETE of a group, its warnings or a broadcast needs ?confirm=true; the other deletions of the panel
          // (a filter, one warning, a role, a text, a data row, an upload) are not in section 1.10
          const guarded = /\/admin\/api\/broadcasts\/|\$\{base\}(?:\/warnings)?\?|`\$\{base\}`/.test(call);
          if (guarded && !/\?confirm=true/.test(call)) problems.push(`${rel(file)}:${lineOf(text, match.index)}  ${call.slice(0, 90)}  (DELETE without ?confirm=true)`);
        }
      }
    }
  }
  assert.ok(found >= 10, `the scan finds the destructive calls (${found})`);
  assertNone(problems, "call without its confirmation:");
});

// ---------------------------------------------------------------------------
// The browser code as a whole: forbidden constructs and external URLs (FR-010)
// ---------------------------------------------------------------------------

test("the static security scans really cover every view, component and shell module of the SPA", () => {
  const names = new Set(mjsOurs.map((f) => rel(f).replace(/\\/g, "/")));
  for (const area of AREAS) assert.ok(names.has(`lib/admin/public/js/views/${area}.mjs`), `${area} view is scanned`);
  for (const file of ["app", "api", "i18n", "live", "router", "ui"]) assert.ok(names.has(`lib/admin/public/js/${file}.mjs`), `${file}.mjs is scanned`);
  assert.ok(mjsOurs.length >= 80, `the SPA has ${mjsOurs.length} modules of its own`);
  assert.equal([...names].filter((n) => n.includes("/vendor/")).length, 0, "vendor files are not 'ours'");
  // nothing in public/ escapes both scans: every non-vendor text file is either .mjs, .css, .html, .svg or .json
  const strays = ours.filter((f) => !/\.(mjs|css|html|svg|json|ico)$/.test(f)).map(rel);
  assertNone(strays, "unexpected file type in lib/admin/public:");
});

// ---------------------------------------------------------------------------
// CSS guards for 360 px screens (FR-038, SC-008; the real check on a phone stays manual, see quickstart.md)
// ---------------------------------------------------------------------------

/** The rules of a stylesheet: { at: ["@media (...)"], selector, decls: { prop: value } } (comments already removed) */
function cssRules(text) {
  const rules = [];
  const walkBlock = (src, at) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf("{", i);
      if (open === -1) break;
      const head = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth) {
        if (src[j] === "{") depth += 1;
        else if (src[j] === "}") depth -= 1;
        j += 1;
      }
      const body = src.slice(open + 1, j - 1);
      if (/^@(media|supports)\b/.test(head)) walkBlock(body, [...at, head]);
      else if (!head.startsWith("@")) {
        const decls = {};
        for (const part of body.split(";")) {
          const colon = part.indexOf(":");
          if (colon > 0) decls[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
        }
        rules.push({ at, selector: head.replace(/\s+/g, " "), decls });
      }
      i = j;
    }
  };
  walkBlock(text, []);
  return rules;
}

const MOBILE_LIMIT_PX = 360;
const toPx = (value, unit) => Number(value) * (unit === "px" ? 1 : 16); // rem, em and ch against a 16 px base

/** The fixed lengths (px, rem, em, ch) in a value that sits outside min() / max() / clamp() / calc() */
function fixedLengths(value) {
  let flat = value;
  for (let guard = 0; guard < 8 && /\b(?:min|max|clamp|calc)\(/.test(flat); guard += 1) {
    flat = flat.replace(/\b(?:min|max|clamp|calc)\([^()]*\)/g, " ");
  }
  return [...flat.matchAll(/(?<![\w.-])(\d*\.?\d+)(px|rem|em|ch)\b/g)].map((m) => toPx(m[1], m[2]));
}

test("css guard: no fixed width above 360 px on a layout container outside a min-width media query", () => {
  const css = stripComments(path.join(PUBLIC, "css", "app.css"));
  const rules = cssRules(css);
  assert.ok(rules.length > 150, `the stylesheet is parsed (${rules.length} rules)`);
  const problems = [];
  for (const rule of rules) {
    if (rule.at.some((a) => /\(min-width:/.test(a))) continue; // wide screens may use wide columns
    for (const prop of ["width", "min-width", "flex-basis", "inline-size", "min-inline-size"]) {
      const value = rule.decls[prop];
      if (value === undefined) continue;
      for (const px of fixedLengths(value)) if (px > MOBILE_LIMIT_PX) problems.push(`${rule.selector} { ${prop}: ${value} }  (${px}px)`);
    }
    // grid tracks: repeat(N, 30rem), minmax(30rem, 1fr) force a column wider than the screen
    const columns = rule.decls["grid-template-columns"];
    if (columns !== undefined) {
      for (const px of fixedLengths(columns)) if (px > MOBILE_LIMIT_PX) problems.push(`${rule.selector} { grid-template-columns: ${columns} }  (${px}px)`);
    }
  }
  assertNone(problems, "fixed width wider than 360 px:");

  // the guard sees what it should: a made-up rule is caught, min() and percentages are fine
  const fake = cssRules(".a { width: 30rem; } .b { min-width: min(30rem, 100%); } .c { width: 100%; } @media (min-width: 64rem) { .d { width: 40rem; } }");
  assert.deepEqual(fake.map((r) => [r.selector, fixedLengths(r.decls.width || r.decls["min-width"] || "")]), [[".a", [480]], [".b", []], [".c", []], [".d", [640]]]);
});

test("css guard: the shell lets the page shrink to 360 px (viewport meta, border-box, no horizontal scroll, long text wraps)", () => {
  const css = stripComments(path.join(PUBLIC, "css", "app.css"));
  const rules = cssRules(css);
  const declared = (selector, prop) => rules.filter((r) => r.selector.split(",").map((s) => s.trim()).includes(selector) && r.decls[prop] !== undefined).map((r) => r.decls[prop]);
  assert.match(read(path.join(PUBLIC, "index.html")), /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.ok(declared("*", "box-sizing").includes("border-box"));
  assert.ok(declared("body", "overflow-x").includes("hidden"));
  for (const selector of [".main", ".card", ".stack", ".grow", ".field", ".table-wrap"]) {
    assert.ok(declared(selector, "min-width").some((v) => v === "0" || v === "0px"), `${selector} can shrink (min-width: 0)`);
  }
  assert.ok(declared(".table-wrap", "overflow-x").includes("auto"), "a wide table scrolls inside its box, not the page");
  for (const selector of [".mono", ".log-msg", ".pairing-code", ".banner-body", ".dialog-message", ".toast-body", ".field-error"]) {
    assert.ok(declared(selector, "overflow-wrap").length > 0, `${selector} wraps long words`);
  }
  // the 600 px breakpoint turns the data tables into cards, and the drawer replaces the sidebar below 1024 px
  assert.ok(rules.some((r) => r.at.some((a) => /max-width:\s*37\.5rem/.test(a)) && /table-cards/.test(r.selector)));
  assert.ok(rules.some((r) => r.at.some((a) => /min-width:\s*64rem/.test(a)) && r.selector === ".nav"));
  assert.ok(declared(".nav", "transform").length > 0, "the drawer is off screen by default");
});

test("css guard: label/value lists stack on a narrow screen, and the toasts container never outgrows the viewport", () => {
  const rules = cssRules(stripComments(path.join(PUBLIC, "css", "app.css")));
  const base = (selector) => rules.find((r) => r.at.length === 0 && r.selector === selector);
  // found with a real browser at 320 px: a long label left 50 px for the value, and a nowrap badge pushed the page to 345 px
  assert.equal(base(".kv").decls["grid-template-columns"], "minmax(0, 1fr)", "one column by default");
  assert.ok(rules.some((r) => r.selector === ".kv" && r.at.some((a) => /min-width:\s*30rem/.test(a)) && /fit-content/.test(r.decls["grid-template-columns"])), "two columns from 480 px");
  assert.equal(base(".toasts").decls["grid-template-columns"], "minmax(0, 1fr)", "the track cannot grow past the container");
  assert.ok(rules.some((r) => r.selector === ".toasts" && r.at.some((a) => /min-width:\s*40rem/.test(a)) && /calc\(100vw/.test(r.decls.width)), "a bounded width once the container is anchored on the right");
});

test("css guard: the cards of a grid or a stack are spaced by the gap only (no extra .card + .card margin there)", () => {
  const rules = cssRules(stripComments(path.join(PUBLIC, "css", "app.css")));
  const zero = rules.find((r) => r.selector.split(",").map((s) => s.trim()).includes(".grid > .card + .card"));
  assert.ok(zero && zero.decls["margin-top"] === "0", ".grid > .card + .card resets the margin");
  assert.ok(rules.some((r) => r.selector.split(",").map((s) => s.trim()).includes(".stack > .card + .card")));
});

test("css guard: every class written as class=\"...\" in a view or component has a rule in app.css", () => {
  const css = stripComments(path.join(PUBLIC, "css", "app.css"));
  const styled = new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]));
  const problems = [];
  const used = new Set();
  for (const file of mjsOurs) {
    const text = stripComments(file);
    for (const match of text.matchAll(/\bclass="([^"]*)"/g)) {
      for (const word of match[1].split(/\s+/)) {
        if (!/^[a-z][a-z0-9-]*$/.test(word)) continue; // part of an interpolation
        used.add(word);
        if (!styled.has(word)) problems.push(`${rel(file)}:${lineOf(text, match.index)}  class "${word}" has no rule in app.css`);
      }
    }
  }
  assert.ok(used.size > 60, `the scan finds the classes of the SPA (${used.size})`);
  assertNone(problems, "unstyled class:");
});

test("css guard: the widgets filed as requests by the area agents are styled (pairing code, log message, progress bar, chart)", () => {
  const rules = cssRules(stripComments(path.join(PUBLIC, "css", "app.css")));
  const find = (selector) => rules.filter((r) => r.selector.split(",").map((s) => s.trim()).includes(selector));
  const decl = (selector, prop) => find(selector).map((r) => r.decls[prop]).find((v) => v !== undefined);
  assert.match(decl(".pairing-code", "font-family"), /monospace/);
  assert.match(decl(".pairing-code", "font-size"), /clamp\(/, "large, and it shrinks with the screen");
  assert.equal(decl(".log-msg", "white-space"), "pre-wrap");
  assert.equal(decl(".log-msg", "overflow-wrap"), "anywhere");
  assert.equal(decl("progress", "width"), "100%");
  assert.equal(decl("progress", "display"), "block");
  assert.equal(decl(".chart", "max-width"), "40rem");
});
