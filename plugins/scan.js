const dns = require("dns").promises;
const net = require("net");
const { getLang } = require("../lib/utils/language");
const glyphs = require("../lib/utils/glyphs");
const { withTimeout } = require("../lib/utils/http");

/**
 * Reconnaissance d'une cible : résolution DNS et sondage de ports.
 *   .scan <hôte>            → ports courants
 *   .scan <hôte> 22,443     → ports choisis
 *
 * Aucune dépendance : `dns` et `net` de Node. Chaque port est sondé 1,2 s au plus.
 */

const MAX_HOST = 253;
const MAX_PORTS = 12;
const PORT_TIMEOUT_MS = 1200;
const DNS_TIMEOUT_MS = 4000;
const DEFAULT_PORTS = [21, 22, 23, 25, 53, 80, 110, 143, 443, 3306, 5432, 8080];

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function parseHost(raw) {
  const text = String(raw || "").trim().toLowerCase();
  const host = text.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  return HOST_RE.test(host) && host.length <= MAX_HOST ? host : null;
}

function parsePorts(raw) {
  const list = String(raw || "")
    .split(/[\s,;]+/)
    .map((part) => parseInt(part, 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
  return list.length ? [...new Set(list)].slice(0, MAX_PORTS) : DEFAULT_PORTS;
}

/** true quand le port accepte une connexion */
function probe(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(PORT_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

async function resolve(host) {
  try {
    const addresses = await withTimeout(dns.resolve4(host), DNS_TIMEOUT_MS, "dns");
    return addresses.slice(0, 4);
  } catch {
    return [];
  }
}

module.exports = {
  command: {
    pattern: "scan|nmap|recon",
    desc: getLang("plugins.scan.desc"),
    type: "dark",
  },

  async execute(message, argsString) {
    const [rawHost, rawPorts] = String(argsString || "").trim().split(/\s+/);
    const host = parseHost(rawHost);
    if (!host) return await message.reply(getLang("plugins.scan.usage"));

    await message.react("📡");

    const addresses = await resolve(host);
    const ports = parsePorts(rawPorts);
    const results = await Promise.all(ports.map((port) => probe(host, port)));

    const lines = [
      getLang("plugins.scan.target", glyphs.smallCaps(host)),
      getLang("plugins.scan.dns", addresses.length ? addresses.join(", ") : getLang("plugins.scan.dns_none")),
      "",
    ];

    for (let i = 0; i < ports.length; i++) {
      lines.push(
        results[i]
          ? getLang("plugins.scan.open", ports[i])
          : getLang("plugins.scan.closed", ports[i]),
      );
    }

    const open = results.filter(Boolean).length;
    lines.push("", getLang("plugins.scan.summary", open, ports.length));

    await message.reply(glyphs.frame(lines, { style: "heavy", title: getLang("plugins.scan.title") }));
  },

  parseHost,
  parsePorts,
};
