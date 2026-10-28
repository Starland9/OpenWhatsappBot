/**
 * Shared logger factory (contracts/runtime.md section 12).
 *
 *   createLogger(name) -> pino child     level from config.LOG_LEVEL (silent in tests)
 *   setLevel(level)                      updates the root logger and every child created so far
 *   install()                            console.* capture; called first in index.js and panel.js
 *   printToConsole(line)                 the ORIGINAL stdout write (setup link, QR art)
 *
 * One root pino writes to one destination whose write(line) runs redactor.scrub(line), then
 * forwards the scrubbed line to the ring and to stdout: in-process pino-pretty formatting (same
 * options as the former index.js logger, no worker thread) or the raw JSON line when
 * LOG_FORMAT is "json".
 *
 * This module may require only the three log leaves, config, pino and pino-pretty. config is
 * read only once it is fully loaded and never loaded from here: requiring it too early would
 * freeze the environment before a test (or index.js) has prepared it. Until then the level comes
 * from process.env.LOG_LEVEL; the first createLogger() call after config.js has loaded adopts
 * config.LOG_LEVEL (unless setLevel() was called explicitly in the meantime).
 */

const pino = require("pino");
const pretty = require("pino-pretty");
const redactor = require("../admin/logs/redactor");
const ring = require("../admin/logs/ring");
const consoleCapture = require("../admin/logs/consoleCapture");

const VALID_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

const REDACT_PATHS = [
  "*.apiKey",
  "*.token",
  "*.password",
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
];

/** Same options as the former `pino-pretty` transport of index.js. */
const PRETTY_OPTIONS = {
  colorize: true,
  translateTime: "SYS:standard",
  ignore: "pid,hostname",
};

let root = null;
let currentLevel = null;
let levelPinned = false; // true after an explicit setLevel(): config no longer decides
let levelFromConfig = false; // true once config.LOG_LEVEL has been adopted
let configId = null;
const children = []; // WeakRef of every child, so setLevel() reaches the ones already created
let prettify = null;
let output = (text) => process.stdout.write(text);

/** A key of `config`, only when config.js is fully loaded (it is never loaded from here). */
function readConfig(key) {
  try {
    if (configId === null) configId = require.resolve("../../config");
    const mod = require.cache[configId];
    if (!mod || !mod.loaded) return undefined;
    const value = mod.exports[key];
    return value === undefined || value === null || value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

function normalizeLevel(level) {
  const value = String(level || "").trim().toLowerCase();
  return VALID_LEVELS.has(value) ? value : null;
}

function resolveLevel() {
  const fromConfig = normalizeLevel(readConfig("LOG_LEVEL"));
  if (fromConfig) {
    levelFromConfig = true;
    return fromConfig;
  }
  return normalizeLevel(process.env.LOG_LEVEL) || "info";
}

function isJsonFormat() {
  const format = readConfig("LOG_FORMAT") || process.env.LOG_FORMAT;
  return String(format || "").trim().toLowerCase() === "json";
}

/** The destination handed to pino: scrub, then ring and stdout. */
const destination = {
  write(line) {
    const clean = redactor.scrub(String(line));
    try {
      ring.pushFromPinoLine(clean);
    } catch {
      // the ring never blocks logging
    }
    try {
      if (isJsonFormat()) {
        output(clean);
      } else {
        if (!prettify) prettify = pretty.prettyFactory(PRETTY_OPTIONS);
        output(prettify(clean));
      }
    } catch {
      // logging never throws into the caller
    }
  },
};

function getRoot() {
  if (!root) {
    currentLevel = resolveLevel();
    root = pino(
      {
        level: currentLevel,
        redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      },
      destination,
    );
  }
  return root;
}

/** Adopt config.LOG_LEVEL once config.js has finished loading (no effect after setLevel()). */
function syncLevelWithConfig() {
  if (levelPinned || levelFromConfig) return;
  const level = normalizeLevel(readConfig("LOG_LEVEL"));
  if (!level) return;
  levelFromConfig = true;
  if (level !== currentLevel) applyLevel(level);
}

/** A pino child named `name`, following the level of the root (see setLevel). */
function createLogger(name) {
  getRoot();
  syncLevelWithConfig();
  const child = root.child({ name: String(name) });
  children.push(new WeakRef(child));
  return child;
}

function applyLevel(level) {
  const base = getRoot();
  currentLevel = level;
  base.level = level;
  for (let i = children.length - 1; i >= 0; i -= 1) {
    const child = children[i].deref();
    if (child) child.level = level;
    else children.splice(i, 1);
  }
}

/** Update the level of the root logger and of every child created so far. */
function setLevel(level) {
  const next = normalizeLevel(level);
  if (!next) return false;
  levelPinned = true;
  applyLevel(next);
  return true;
}

function getLevel() {
  getRoot();
  return currentLevel;
}

/** Start capturing console.* into the ring (idempotent). */
function install() {
  return consoleCapture.install();
}

const printToConsole = consoleCapture.printToConsole;

/**
 * Test seam: replace the final stdout writer (receives the formatted line, newline included).
 * Without argument the default writer is restored.
 */
function setOutput(fn) {
  output = typeof fn === "function" ? fn : (text) => process.stdout.write(text);
}

module.exports = { createLogger, setLevel, getLevel, install, printToConsole, setOutput };
