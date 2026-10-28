/**
 * console.* capture (contracts/runtime.md section 12).
 *
 * Leaf module: it imports only Node built-ins and the other log leaves (enforced by
 * test/admin-logging.test.js).
 *
 *   install()            wraps console.log/info/debug/warn/error: format, scrub, push to the
 *                        ring (matching level, name "console"), then call the original
 *   printToConsole(line) the ORIGINAL stdout write, captured when this module is loaded: for the
 *                        lines the human must see but the logs must not keep (the setup link,
 *                        QR art). It neither scrubs nor feeds the ring.
 *
 * Lines that are QR art (/[▀▄█]{8,}/) or that contain "QR available" never enter the ring and
 * reach the original console untouched. Any other line is scrubbed before it is handed to the
 * original too, so a secret printed with console.* does not reach stdout or the PM2 files; when
 * nothing needs scrubbing the original receives the caller's own arguments unchanged.
 */

const util = require("node:util");
const redactor = require("./redactor");
const ring = require("./ring");

// Captured at load time: later wrappers of process.stdout.write (tests, other tools) are bypassed.
const originalStdoutWrite = process.stdout.write.bind(process.stdout);

const METHODS = [
  ["log", "info"],
  ["info", "info"],
  ["debug", "debug"],
  ["warn", "warn"],
  ["error", "error"],
];

const QR_ART = /[▀▄█]{8,}/;

let installed = false;
const originals = {};

function isQrLine(text) {
  return QR_ART.test(text) || text.includes("QR available");
}

/** Write a line straight to stdout, outside the ring and without scrubbing. */
function printToConsole(line) {
  const text = String(line === undefined || line === null ? "" : line);
  originalStdoutWrite(text.endsWith("\n") ? text : `${text}\n`);
}

function wrap(method, level) {
  const original = console[method];
  originals[method] = original;
  console[method] = function capturedConsole(...args) {
    let outArgs = args;
    try {
      const text = util.format(...args);
      if (!isQrLine(text)) {
        const clean = redactor.scrub(text);
        ring.push({ level, name: "console", msg: clean });
        if (clean !== text) outArgs = [clean];
      }
    } catch {
      // capturing must never break the caller's console call
    }
    return original.apply(console, outArgs);
  };
  console[method].__owbCaptured = true;
}

/** Idempotent: a second call does nothing. */
function install() {
  if (installed) return false;
  installed = true;
  for (const [method, level] of METHODS) wrap(method, level);
  return true;
}

/** Put the original console methods back (test seam). */
function uninstall() {
  if (!installed) return false;
  for (const [method] of METHODS) {
    if (originals[method]) console[method] = originals[method];
  }
  installed = false;
  return true;
}

module.exports = { install, uninstall, printToConsole };
