const { jidNormalizedUser } = require("@whiskeysockets/baileys");

module.exports = {
  command: {
    pattern: "exportcontacts",
    desc: "Export contacts (JSON) and send as a document. Owner only.",
    type: "utility",
    fromMe: false,
    onlyGroup: false,
    onlyPm: false,
    ownerOnly: true,
  },

  async execute(message, argsString) {
    // Only allow bot owners (ownerOnly handled by registry but double-check)
    if (!message.isSudo()) {
      return await message.reply(
        "❌ Vous devez être propriétaire du bot pour utiliser cette commande."
      );
    }

    await message.reply(
      "🔎 Récupération des contacts, ceci peut prendre une seconde..."
    );

    try {
      const client = message.client;

      // Wait for client readiness to improve chance that contacts are synced.
      if (typeof client.ready === "function" && !client.ready()) {
        // wait for 'ready' event or timeout after 8s
        await new Promise((resolve) => {
          const onReady = () => {
            clearTimeout(timeout);
            client.removeListener("ready", onReady);
            resolve();
          };
          const timeout = setTimeout(() => {
            client.removeListener("ready", onReady);
            resolve();
          }, 8000);
          client.once("ready", onReady);
        });
      }

      // store may be a Baileys in-memory store; contacts can be a Map or an object
      const rawContacts = client.store?.contacts || null;

      let contactsArray = [];

      if (!rawContacts) {
        // Fallback: try socket state
        const sock = client.getSocket();
        const state = sock?.state || null;
        const sContacts = state?.contacts || null;
        if (sContacts) {
          // state.contacts is an object mapping jid -> contact
          contactsArray = Object.keys(sContacts).map((k) => ({
            jid: k,
            ...sContacts[k],
          }));
        }
      } else if (typeof rawContacts.forEach === "function") {
        // It's a Map-like
        rawContacts.forEach((value, key) => {
          const jid = value?.id || key;
          contactsArray.push({
            jid,
            displayName: value?.notify || value?.vname || value?.name || "",
            raw: value,
          });
        });
      } else if (typeof rawContacts === "object") {
        contactsArray = Object.keys(rawContacts).map((k) => {
          const v = rawContacts[k] || {};
          const jid = v.id || k;
          return {
            jid,
            displayName: v.notify || v.vname || v.name || "",
            raw: v,
          };
        });
      }

      if (!contactsArray || contactsArray.length === 0) {
        return await message.reply(
          "ℹ️ Aucun contact trouvé dans le store. Assurez-vous que le client est connecté et synchronisé."
        );
      }

      // If argsString contains 'csv' export CSV instead
      const wantCsv = argsString && argsString.trim().toLowerCase() === "csv";

      if (wantCsv) {
        // Build CSV: jid, displayName
        const header = "jid,displayName\n";
        const rows = contactsArray
          .map(
            (c) =>
              `${c.jid.replace(/,/g, "")},"${(c.displayName || "").replace(
                /"/g,
                '""'
              )}"`
          )
          .join("\n");
        const csv = header + rows;
        const buffer = Buffer.from(csv, "utf8");
        await message.sendDocument(buffer, {
          fileName: "contacts.csv",
          mimetype: "text/csv",
          caption: "Export contacts (CSV)",
        });
        return;
      }

      // Default: JSON export with simplified fields + raw
      const exportPayload = contactsArray.map((c) => ({
        jid: c.jid,
        displayName: c.displayName || "",
        raw: c.raw || null,
      }));

      const jsonBuffer = Buffer.from(
        JSON.stringify(exportPayload, null, 2),
        "utf8"
      );
      await message.sendDocument(jsonBuffer, {
        fileName: "contacts.json",
        mimetype: "application/json",
        caption: "Export contacts (JSON)",
      });
    } catch (error) {
      console.error("exportcontacts error:", error);
      await message.reply(
        "❌ Une erreur est survenue lors de l'export des contacts."
      );
    }
  },
};
