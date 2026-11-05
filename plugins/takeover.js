const { getLang } = require("../lib/utils/language");
const config = require("../config");
const glyphs = require("../lib/utils/glyphs");
const { safeLog } = require("../lib/utils/http");
const {
  normalizeJid,
  jidUser,
  guardTarget,
  assertParticipantResult,
} = require("../lib/utils/permissions");

/**
 * Prise de contrôle d'un groupe : verrouillage complet, révocation de l'invitation,
 * purge des autres administrateurs, puis libération.
 *
 *   .takeover            → verrouille tout (écriture, réglages, ajout, approbation) et révoque le lien
 *   .takeover status     → état courant du verrouillage
 *   .takeover invite     → révoque le lien et renvoie le nouveau
 *   .takeover purge      → rétrograde tous les autres administrateurs
 *   .takeover release    → rend le groupe à ses membres
 *
 * Chaque étape est indépendante : un échec est signalé, les suivantes continuent.
 * WhatsApp reste la source de vérité, rien n'est stocké en base.
 */

const STEP_TIMEOUT_MS = 15000;

/** Une étape du verrouillage : nom de clé i18n, action, et le réglage attendu */
const LOCK_STEPS = [
  { key: "close", run: (sock, jid) => sock.groupSettingUpdate(jid, "announcement") },
  { key: "lock", run: (sock, jid) => sock.groupSettingUpdate(jid, "locked") },
  { key: "addmode", run: (sock, jid) => sock.groupMemberAddMode(jid, "admin_add") },
  { key: "approval", run: (sock, jid) => sock.groupJoinApprovalMode(jid, "on") },
];

const RELEASE_STEPS = [
  { key: "open", run: (sock, jid) => sock.groupSettingUpdate(jid, "not_announcement") },
  { key: "unlock", run: (sock, jid) => sock.groupSettingUpdate(jid, "unlocked") },
  { key: "addmode", run: (sock, jid) => sock.groupMemberAddMode(jid, "all_member_add") },
  { key: "approval", run: (sock, jid) => sock.groupJoinApprovalMode(jid, "off") },
];

/** Exécute une étape avec un délai maximal ; renvoie true en cas de succès */
async function runStep(sock, jid, step) {
  let timer;
  try {
    await Promise.race([
      step.run(sock, jid),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), STEP_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch (error) {
    safeLog(error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Ligne de résultat d'une étape */
const stepLine = (key, ok) =>
  getLang(ok ? "plugins.takeover.step_ok" : "plugins.takeover.step_failed", getLang(`plugins.takeover.${key}`));

/** Le bot est-il administrateur ? (métadonnées fraîches) */
async function botIsAdmin(message) {
  message._forgetGroupMetadata();
  return await message.isBotAdmin();
}

/** Verrouille le groupe et révoque le lien d'invitation */
async function lockDown(message) {
  const sock = message.client.getSocket();
  const jid = message.jid;

  const lines = [];
  for (const step of LOCK_STEPS) {
    lines.push(stepLine(step.key, await runStep(sock, jid, step)));
  }

  let code = null;
  try {
    code = await sock.groupRevokeInvite(jid);
    lines.push(stepLine("invite", true));
  } catch (error) {
    safeLog(error);
    lines.push(stepLine("invite", false));
  }

  message._forgetGroupMetadata();
  return { lines, code };
}

/** Rend le groupe à ses membres */
async function release(message) {
  const sock = message.client.getSocket();
  const lines = [];
  for (const step of RELEASE_STEPS) {
    lines.push(stepLine(step.key, await runStep(sock, message.jid, step)));
  }
  message._forgetGroupMetadata();
  return lines;
}

/** Rétrograde tous les administrateurs sauf le bot, les propriétaires et le créateur */
async function purge(message) {
  const metadata = await message.getGroupMetadata();
  if (!metadata) return { done: [], failed: [], refused: 0 };

  const admins = (metadata.participants || []).filter(
    (p) => p.admin === "admin" || p.admin === "superadmin",
  );

  const allowed = [];
  let refused = 0;
  for (const participant of admins) {
    const jid = normalizeJid(participant.id || participant.phoneNumber || participant.lid);
    if (!jid) continue;
    const refusal = await guardTarget(message, jid);
    if (refusal) {
      refused++;
      continue;
    }
    allowed.push(jid);
  }

  if (!allowed.length) return { done: [], failed: [], refused };

  const res = await message.demote(allowed);
  if (assertParticipantResult(res)) return { done: allowed, failed: [], refused };

  const done = [];
  const failed = [];
  allowed.forEach((jid, i) => {
    const entry = res.find((r) => normalizeJid(r?.jid) === jid) || res[i];
    (String(entry?.status) === "200" ? done : failed).push(jid);
  });
  return { done, failed, refused };
}

/** État courant, lu dans les métadonnées */
async function status(message) {
  const metadata = await message.getGroupMetadata();
  if (!metadata) return null;

  const on = (value) => getLang(value ? "plugins.takeover.state_on" : "plugins.takeover.state_off");
  return [
    getLang("plugins.takeover.state_write", on(metadata.announce)),
    getLang("plugins.takeover.state_settings", on(metadata.restrict)),
    getLang("plugins.takeover.state_add", on(!metadata.memberAddMode)),
    getLang("plugins.takeover.state_approval", on(metadata.joinApprovalMode)),
    getLang("plugins.takeover.state_admins", (metadata.participants || []).filter((p) => p.admin).length),
  ];
}

const mentionText = (jids) => jids.map((j) => `@${jidUser(j)}`).join(" ");

module.exports = {
  command: {
    pattern: "takeover|control|lockdown|assaut",
    desc: getLang("plugins.takeover.desc"),
    type: "dark",
    // Anyone may trigger it: WhatsApp only checks that the BOT is an administrator
    onlyGroup: true,
  },

  async execute(message, argsString) {
    const sub = String(argsString || "").trim().toLowerCase().split(/\s+/)[0];

    if (!(await botIsAdmin(message))) {
      return await message.reply(getLang("common.bot_not_admin"));
    }

    await message.react("☠");
    const author = message.sender ? `@${jidUser(message.sender)}` : "";

    if (sub === "status" || sub === "etat" || sub === "état") {
      const lines = await status(message);
      if (!lines) return await message.reply(getLang("plugins.takeover.no_metadata"));
      return await message.reply(
        glyphs.frame(lines, { style: "double", title: getLang("plugins.takeover.status_title") }),
      );
    }

    if (sub === "invite" || sub === "lien") {
      try {
        const code = await message.client.getSocket().groupRevokeInvite(message.jid);
        return await message.reply(
          code
            ? getLang("plugins.takeover.new_invite", `https://chat.whatsapp.com/${code}`)
            : getLang("plugins.takeover.invite_failed"),
        );
      } catch (error) {
        safeLog(error);
        return await message.reply(getLang("plugins.takeover.invite_failed"));
      }
    }

    if (sub === "purge" || sub === "purge_admins") {
      const { done, failed, refused } = await purge(message);
      const lines = [];
      if (done.length) lines.push(getLang("plugins.takeover.purged", mentionText(done)));
      if (failed.length) lines.push(getLang("plugins.takeover.purge_failed", mentionText(failed)));
      if (refused) lines.push(getLang("plugins.takeover.purge_refused", refused));
      if (!lines.length) lines.push(getLang("plugins.takeover.purge_none"));
      if (author) lines.push("", getLang("plugins.takeover.by", author));
      return await message.reply(
        `${glyphs.art("warning")}\n\n${glyphs.frame(lines, { style: "heavy", title: getLang("plugins.takeover.purge_title") })}`,
        { mentions: [...done, ...failed, ...(message.sender ? [message.sender] : [])] },
      );
    }

    if (sub === "release" || sub === "liberer" || sub === "libérer") {
      const lines = await release(message);
      return await message.reply(
        glyphs.frame(lines, { style: "light", title: getLang("plugins.takeover.release_title") }),
      );
    }

    if (sub && !["lock", "verrouiller", "on"].includes(sub)) {
      return await message.reply(getLang("plugins.takeover.usage", config.PREFIX));
    }

    const { lines, code } = await lockDown(message);
    if (code) lines.push("", getLang("plugins.takeover.new_invite", `https://chat.whatsapp.com/${code}`));
    if (author) lines.push("", getLang("plugins.takeover.by", author));

    await message.reply(
      `${glyphs.art("skull")}\n\n${glyphs.frame(lines, { style: "heavy", title: getLang("plugins.takeover.title") })}`,
      { mentions: message.sender ? [message.sender] : [] },
    );
  },

  LOCK_STEPS,
  RELEASE_STEPS,
};
