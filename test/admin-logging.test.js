"use strict";
/**
 * T025: static rules of contracts/runtime.md section 12, enforced by reading the sources.
 *
 *  - no `pino(` outside lib/utils/logger.js, except the two Baileys calls of lib/baileys/client.js;
 *  - no `console.` in lib/admin/** (the vendored libraries under lib/admin/public/vendor/ excepted);
 *  - the three log leaves (lib/admin/logs/{redactor,ring,consoleCapture}.js) import only Node
 *    built-ins and each other;
 *  - lib/admin/** never hands `req.body`, `req.headers` or `req.url` to a logger call
 *    (a heuristic: the arguments of every `<something>log<something>.<level>(...)` call are
 *    searched).
 *
 * The comments are stripped before searching, so documentation can name what it forbids.
 * Expected to pass once every agent of the foundation wave has landed (index.js, panel.js and
 * the other modules still calling `pino(` fail the first rule until then).
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { builtinModules } = require("node:module");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".yarn", "sessions", "data", "logs", "media"]);
const LEAVES = ["redactor", "ring", "consoleCapture"].map((n) => path.join("lib", "admin", "logs", `${n}.js`));

/** Every .js/.mjs/.cjs file under `dir` (repo-relative paths), skipping `skip(relPath)` entries. */
function walk(dir, skip = () => false) {
  const out = [];
  const base = path.join(ROOT, dir);
  if (!fs.existsSync(base)) return out;
  const visit = (abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const full = path.join(abs, entry.name);
      const rel = path.relative(ROOT, full);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !skip(rel)) visit(full);
      } else if (/\.(c|m)?js$/.test(entry.name) && !skip(rel)) {
        out.push(rel);
      }
    }
  };
  visit(base);
  return out.sort();
}

/**
 * Source text without its comments (strings and regular expressions are kept intact).
 * A scanner, not a parser: good enough for the heuristics below.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  let prevSignificant = "";
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j += 1;
        else if (c !== "`" && src[j] === "\n") break;
        j += 1;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      prevSignificant = c;
      continue;
    }
    if (c === "/" && (prevSignificant === "" || "(,=:[!&|?{};+-*%<>~^".includes(prevSignificant) || /(?:return|typeof)$/.test(out.trimEnd()))) {
      // a regular expression literal
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") j += 1;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j += 1;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      prevSignificant = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prevSignificant = c;
    i += 1;
  }
  return out;
}

function read(rel) {
  return stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

/** `text` from the opening parenthesis at `open` to its matching one (strings skipped). */
function callArguments(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i += 1;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
    } else if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

/** The logger calls of a (comment-free) source whose arguments mention req.body/headers/url. */
function requestDataInLoggerCalls(text) {
  const found = [];
  const call = /\b\w*[lL]og(?:ger)?\w*\s*\.\s*(?:trace|debug|info|warn|error|fatal|log)\s*\(/g;
  let m;
  while ((m = call.exec(text))) {
    const args = callArguments(text, m.index + m[0].length - 1);
    if (/\b(?:req|request)\s*\.\s*(?:body|headers|url|rawHeaders|originalUrl)\b/.test(args)) found.push(args);
  }
  return found;
}

const PINO_CALL = /\bpino\s*\(/g;
const count = (text, re) => (text.match(re) || []).length;

describe("no pino( outside the logger", () => {
  const files = [
    ...fs.readdirSync(ROOT).filter((f) => /\.js$/.test(f)),
    ...walk("lib"),
    ...walk("plugins"),
    ...walk("tools"),
  ];

  test("only lib/utils/logger.js and the two Baileys calls create a pino instance", () => {
    const offenders = [];
    for (const rel of files) {
      const n = count(read(rel), PINO_CALL);
      if (n === 0) continue;
      const normalized = rel.split(path.sep).join("/");
      if (normalized === "lib/utils/logger.js") continue;
      if (normalized === "lib/baileys/client.js" && n === 2) continue;
      offenders.push(`${normalized} (${n})`);
    }
    assert.deepEqual(offenders, [], "replace pino({...}) by require(\"<rel>/logger\").createLogger(\"<name>\")");
  });

  test("lib/baileys/client.js keeps exactly its two Baileys calls", () => {
    assert.equal(count(read("lib/baileys/client.js"), PINO_CALL), 2);
  });

  test("lib/utils/logger.js is the root: it creates the pino instance", () => {
    assert.ok(count(read("lib/utils/logger.js"), PINO_CALL) >= 1);
  });
});

describe("lib/admin rules", () => {
  const adminFiles = walk("lib/admin", (rel) => rel.split(path.sep).join("/").startsWith("lib/admin/public/vendor/"));

  test("no console. in lib/admin/**", () => {
    const offenders = adminFiles.filter((rel) => /\bconsole\s*\./.test(read(rel)));
    assert.deepEqual(offenders, [], "use createLogger() from lib/utils/logger.js (printToConsole for the setup link)");
  });

  test("a logger call never receives req.body, req.headers or req.url", () => {
    const offenders = [];
    for (const rel of adminFiles) {
      const hits = requestDataInLoggerCalls(read(rel));
      if (hits.length) offenders.push(`${rel}: ${hits[0].replace(/\s+/g, " ").slice(0, 80)}`);
    }
    assert.deepEqual(offenders, []);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Feature 004 (contracts/runtime.md RT-01, RT-05; tasks T042): the same walkers over the messaging API and its engine,
// plus the layering of the new modules.
describe("lib/api and lib/messaging rules (feature 004)", () => {
  const apiFiles = [...walk("lib/api"), ...walk("lib/messaging")];

  test("the walkers see the new modules", () => {
    assert.ok(apiFiles.includes(path.join("lib", "api", "pipeline.js")));
    assert.ok(apiFiles.includes(path.join("lib", "messaging", "errors.js")));
  });

  test("no console. in lib/api/** and lib/messaging/**", () => {
    const offenders = apiFiles.filter((rel) => /\bconsole\s*\./.test(read(rel)));
    assert.deepEqual(offenders, [], "use createLogger() from lib/utils/logger.js");
  });

  test("no pino( in lib/api/** and lib/messaging/**", () => {
    const offenders = apiFiles.filter((rel) => count(read(rel), PINO_CALL) > 0);
    assert.deepEqual(offenders, []);
  });

  test("a logger call never receives req.body, req.headers or req.url (RT-05)", () => {
    const offenders = [];
    for (const rel of apiFiles) {
      const hits = requestDataInLoggerCalls(read(rel));
      if (hits.length) offenders.push(`${rel}: ${hits[0].replace(/\s+/g, " ").slice(0, 80)}`);
    }
    assert.deepEqual(offenders, []);
  });

  /** The repo-relative (forward slash) targets of the relative require() calls of a file */
  function relativeRequires(rel) {
    const text = read(rel);
    const specs = [...text.matchAll(/\brequire\s*\(\s*(["'`])(\.[^"'`]*)\1\s*\)/g)].map((m) => m[2]);
    return specs.map((spec) => path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, rel)), spec)).split(path.sep).join("/"));
  }
  const underAny = (target, prefixes) => prefixes.some((p) => target === p || target.startsWith(`${p}/`));

  test("RT-01: lib/messaging/** and the engine utilities never require lib/api/** or lib/admin/**", () => {
    const engine = [...walk("lib/messaging"), "lib/utils/sendGate.js", "lib/utils/schema.js", "lib/utils/apiState.js"].filter((rel) =>
      fs.existsSync(path.join(ROOT, rel)),
    );
    const offenders = [];
    for (const rel of engine) {
      for (const target of relativeRequires(rel)) {
        if (!underAny(target, ["lib/api", "lib/admin"])) continue;
        // the single exception: apiState.setPlainHttpFrom lazily requires the dependency-free leaf ipRules
        if (rel.split(path.sep).join("/") === "lib/utils/apiState.js" && target === "lib/api/ipRules") continue;
        offenders.push(`${rel} requires ${target}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test("RT-01: lib/api/** requires from the panel only lib/admin/http/*, lib/admin/auth/rateLimit.js and lib/admin/logs/redactor.js", () => {
    const allowed = (target) =>
      /^lib\/admin\/http\/[A-Za-z]+$/.test(target) || target === "lib/admin/auth/rateLimit" || target === "lib/admin/logs/redactor";
    const offenders = [];
    for (const rel of walk("lib/api")) {
      for (const target of relativeRequires(rel)) {
        if (underAny(target, ["lib/admin"]) && !allowed(target)) offenders.push(`${rel} requires ${target}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test("lib/api/ipRules.js is a dependency-free leaf (Node's net only)", () => {
    const text = read("lib/api/ipRules.js");
    const specs = [...text.matchAll(/\brequire\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g)].map((m) => m[2]);
    assert.deepEqual(specs.sort(), ["net"]);
  });

  test("the layering scan itself finds a violation", () => {
    const fake = underAny("lib/admin/routes/api", ["lib/admin"]);
    assert.equal(fake, true);
    assert.equal(underAny("lib/administrator/x", ["lib/admin"]), false);
  });
});

describe("the three log leaves", () => {
  const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
  const SIBLINGS = new Set(["./redactor", "./ring", "./consoleCapture"]);

  test("the leaves exist", () => {
    for (const rel of LEAVES) assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
  });

  test("they import only Node built-ins and each other", () => {
    const offenders = [];
    for (const rel of LEAVES) {
      const text = read(rel);
      const specs = [
        ...[...text.matchAll(/\brequire\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g)].map((m) => m[2]),
        ...[...text.matchAll(/\bfrom\s+(["'])([^"']+)\1/g)].map((m) => m[2]),
        ...[...text.matchAll(/\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g)].map((m) => m[2]),
      ];
      for (const spec of specs) {
        if (!BUILTINS.has(spec) && !SIBLINGS.has(spec)) offenders.push(`${rel} imports ${spec}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test("they have no dynamic require (every dependency is visible to this check)", () => {
    for (const rel of LEAVES) {
      const text = read(rel);
      const dynamic = [...text.matchAll(/\brequire\s*\(\s*([^"'`\s)][^)]*)\)/g)].map((m) => m[0]);
      assert.deepEqual(dynamic, [], rel);
    }
  });
});

describe("the heuristics themselves", () => {
  test("stripComments removes comments and keeps strings", () => {
    const out = stripComments('const a = "// not a comment"; // gone\n/* console.log(1) */ const b = 1; const u = "http://x";\n');
    assert.ok(out.includes('"// not a comment"'));
    assert.ok(out.includes('"http://x"'));
    assert.ok(!out.includes("gone"));
    assert.ok(!out.includes("console"));
  });

  test("stripComments copes with regular expression literals holding quotes or slashes", () => {
    const out = stripComments("const r = /[\"']\\//; // tail\nconsole.log(r);\n");
    assert.ok(out.includes("console.log(r)"));
    assert.ok(!out.includes("tail"));
  });

  test("the request-data heuristic flags a leaking logger call and spares a clean one", () => {
    const leaking = 'logger.info({ headers: req.headers }, "request");\nlog.warn(`bad ${req.url}`);\nthis.log.error("x", req.body)';
    assert.equal(requestDataInLoggerCalls(leaking).length, 3);
    const clean = 'logger.info({ method: req.method, route }, "request");\nlogger.debug("done");\nconst body = req.body; reply(body);';
    assert.equal(requestDataInLoggerCalls(clean).length, 0);
  });

  test("the pino( pattern spares require(\"pino\") and pino-pretty", () => {
    assert.equal(count('const pino = require("pino"); const p = require("pino-pretty");', PINO_CALL), 0);
    assert.equal(count("const l = pino({ level: 1 }); const m = pino (x);", PINO_CALL), 2);
  });
});
