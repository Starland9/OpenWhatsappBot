const { getLang } = require("../lib/utils/language");
const glyphs = require("../lib/utils/glyphs");

/**
 * Faux journal système, pour l'ambiance.
 *   .syslog          → 8 lignes
 *   .syslog <n>      → 4 à 20 lignes
 */

const MIN_LINES = 4;
const MAX_LINES = 20;
const DEFAULT_LINES = 8;

const LEVELS = ["INFO", "WARN", "ERROR", "CRIT", "DEBUG"];
const SOURCES = ["kernel", "sshd", "baileys", "watchdog", "cron", "netd", "vault", "sentinel"];
const MESSAGES = [
  "handshake accepted",
  "session token rotated",
  "unexpected packet dropped",
  "beacon lost, retrying",
  "integrity check passed",
  "cipher suite negotiated",
  "ghost process reaped",
  "clock drift corrected",
  "tunnel re-established",
  "checksum mismatch",
  "keyring unlocked",
  "trace erased",
];

function stamp(random) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(random.int(0, 23))}:${pad(random.int(0, 59))}:${pad(random.int(0, 59))}`;
}

module.exports = {
  command: {
    pattern: "syslog|journal|logs",
    desc: getLang("plugins.syslog.desc"),
    type: "dark",
  },

  async execute(message, argsString) {
    const asked = parseInt(String(argsString || "").trim(), 10);
    const count = Number.isFinite(asked)
      ? Math.max(MIN_LINES, Math.min(MAX_LINES, asked))
      : DEFAULT_LINES;

    const random = glyphs.rng(Date.now());
    const lines = Array.from({ length: count }, () =>
      getLang(
        "plugins.syslog.line",
        stamp(random),
        random.pick(LEVELS),
        random.pick(SOURCES),
        random.pick(MESSAGES),
      ),
    );

    await message.reply(`\`\`\`\n${lines.join("\n")}\n\`\`\``);
  },
};
