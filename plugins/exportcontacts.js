const { getLang } = require("../lib/utils/language");
const { isLidJid, isPnJid, jidUser, normalizeJid } = require("../lib/utils/permissions");

/**
 * Export contacts: Baileys v7 has no contact store, so the people the bot can
 * see are the members of its groups.
 *   - in a group: the members of that group
 *   - in a private chat: the members of every group the bot is in
 * The file is always sent by DM to the sender, never into a group.
 */

/** Neutralise spreadsheet formulas: =, +, -, @ (and tab / CR) at the start of a value */
function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Merge the participants of one or several groups into unique contacts.
 * @param {Array<{ subject?: string, participants?: Array }>} groups
 */
function collectContacts(groups) {
  const byKey = new Map();
  for (const group of groups) {
    const subject = group.subject || group.id || "";
    for (const p of group.participants || []) {
      const forms = [p.phoneNumber, p.id, p.lid].map(normalizeJid).filter(Boolean);
      const pn = forms.find(isPnJid) || "";
      const lid = forms.find(isLidJid) || "";
      const key = pn || lid;
      if (!key) continue;

      let contact = byKey.get(key);
      if (!contact) {
        contact = {
          phone: pn ? jidUser(pn) : "",
          jid: pn || lid,
          lid,
          admin: false,
          groups: [],
        };
        byKey.set(key, contact);
      }
      if (p.admin) contact.admin = true;
      if (subject && !contact.groups.includes(subject)) contact.groups.push(subject);
    }
  }
  return [...byKey.values()];
}

function toCsv(contacts) {
  const header = ["phone", "jid", "lid", "admin", "groups"].join(",");
  const rows = contacts.map((c) =>
    [c.phone, c.jid, c.lid, c.admin ? "yes" : "no", c.groups.join("; ")].map(csvCell).join(","),
  );
  return [header, ...rows].join("\n");
}

module.exports = {
  command: {
    pattern: "exportcontacts",
    desc: getLang("plugins.exportcontacts.desc"),
    type: "utility",
    fromMe: true,
  },

  async execute(message, argsString) {
    const wantCsv = String(argsString || "").trim().toLowerCase() === "csv";
    const sock = message.client.getSocket();

    await message.reply(getLang("plugins.exportcontacts.fetching"));

    let groups;
    if (message.isGroup) {
      const metadata = await message.getGroupMetadata();
      groups = metadata ? [metadata] : [];
    } else {
      const all = await sock.groupFetchAllParticipating();
      groups = Object.values(all || {});
    }

    const contacts = collectContacts(groups);
    if (contacts.length === 0) {
      return await message.reply(getLang("plugins.exportcontacts.empty"));
    }

    const file = wantCsv
      ? {
          fileName: "contacts.csv",
          mimetype: "text/csv",
          buffer: Buffer.from(toCsv(contacts), "utf8"),
        }
      : {
          fileName: "contacts.json",
          mimetype: "application/json",
          buffer: Buffer.from(JSON.stringify(contacts, null, 2), "utf8"),
        };

    // Always to the sender's DM: member lists must never land in a group
    const target = message.isGroup ? message.sender || message.senderLid : message.jid;
    await sock.sendMessage(target, {
      document: file.buffer,
      fileName: file.fileName,
      mimetype: file.mimetype,
      caption: getLang(
        "plugins.exportcontacts.caption",
        contacts.length,
        groups.length,
        wantCsv ? "CSV" : "JSON",
      ),
    });

    if (message.isGroup) {
      await message.reply(getLang("plugins.exportcontacts.sent_dm"));
    }
  },
};
