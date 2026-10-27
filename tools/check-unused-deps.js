/**
 * Lists the package.json `dependencies` that are never required or imported.
 *
 * Usage: node tools/check-unused-deps.js
 * Exit code: 1 when at least one dependency is unused, 0 otherwise.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// Scanned entries, relative to the repository root
const SCAN = ["index.js", "panel.js", "config.js", "lib", "plugins", "tools", "test"];

// Used without being required: Sequelize loads the database dialects by name,
// pino loads its transport by name and pm2 is only called from package scripts
const IMPLICIT = new Set(["pg", "sqlite3", "pino-pretty", "pm2"]);

const SOURCE_EXT = new Set([".js", ".cjs", ".mjs"]);

// require("x"), import("x"), import x from "x", import "x", export ... from "x"
const PATTERNS = [
  /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  /\bfrom\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
];

/**
 * Collect every source file under an entry (file or directory)
 */
function collectFiles(entry, files = []) {
  const full = path.join(ROOT, entry);
  if (!fs.existsSync(full)) return files;

  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(full)) {
      if (name === "node_modules") continue;
      collectFiles(path.join(entry, name), files);
    }
  } else if (SOURCE_EXT.has(path.extname(full))) {
    files.push(full);
  }
  return files;
}

/**
 * "@scope/name/sub/path" -> "@scope/name", "name/sub" -> "name",
 * relative paths and node: builtins -> null
 */
function packageName(specifier) {
  if (/^[./]/.test(specifier) || specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Drop block comments and full-line comments, so that a commented-out
 * require() does not count as a use
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function findUsedPackages() {
  const used = new Set();
  for (const entry of SCAN) {
    for (const file of collectFiles(entry)) {
      const source = stripComments(fs.readFileSync(file, "utf8"));
      for (const pattern of PATTERNS) {
        for (const match of source.matchAll(pattern)) {
          const name = packageName(match[1]);
          if (name) used.add(name);
        }
      }
    }
  }
  return used;
}

function main() {
  const pkg = require(path.join(ROOT, "package.json"));
  const used = findUsedPackages();

  const unused = Object.keys(pkg.dependencies || {})
    .filter((name) => !IMPLICIT.has(name) && !used.has(name))
    .sort();

  if (unused.length === 0) {
    console.log("0 unused dependencies");
    return 0;
  }

  console.log(`${unused.length} unused dependencies:`);
  for (const name of unused) console.log(`  ${name}`);
  return 1;
}

process.exit(main());
