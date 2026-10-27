const { getLang } = require("../lib/utils/language");
const config = require("../config");
const {
  normalizeJid,
  jidUser,
  guardTarget,
  assertParticipantResult,
} = require("../lib/utils/permissions");

/**
 * Targets of the command: every mention, otherwise the quoted sender.
 * Normalized, deduplicated, empty values dropped.
 */
function resolveTargets(message) {
  const unique = (jids) => [...new Set(jids.map(normalizeJid).filter(Boolean))];

  const mentioned = unique(message.mentions || []);
  if (mentioned.length) return mentioned;
  return unique([message.quoted?.sender]);
}

/**
 * Outcome of one target in Baileys' per-participant result
 * (`[{ status: "200", jid }]`). "" when the target is missing from the result.
 */
function statusOf(res, targets, jid, index) {
  const entry =
    res.find((r) => normalizeJid(r?.jid) === jid) ||
    (res.length === targets.length ? res[index] : undefined);
  return entry ? String(entry.status) : "";
}

const mentionText = (jids) => jids.map((j) => `@${jidUser(j)}`).join(" ");

/**
 * Promote command - Promote one or more members to admin
 */
module.exports = {
  command: {
    pattern: "promote",
    desc: getLang("plugins.promote.desc"),
    type: "group",
    adminOnly: true,
  },

  async execute(message) {
    const targets = resolveTargets(message);
    if (!targets.length) {
      return await message.reply(
        `${getLang("common.usage_prefix")}\n${getLang("plugins.promote.usage", config.PREFIX)}`,
      );
    }

    if (!(await message.isBotAdmin())) {
      return await message.reply(getLang("common.bot_not_admin"));
    }

    // Refuse the bot, the sender, the owners and the group creator
    const allowed = [];
    const refusals = new Set();
    for (const jid of targets) {
      const refusal = await guardTarget(message, jid);
      if (refusal) refusals.add(refusal);
      else allowed.push(jid);
    }
    if (refusals.size) {
      await message.reply([...refusals].map((key) => getLang(key)).join("\n"));
    }
    if (!allowed.length) return;

    // WhatsApp answers with one status per participant ("200" = done)
    const res = await message.promote(allowed);
    const done = [];
    const failed = [];
    if (assertParticipantResult(res)) {
      done.push(...allowed);
    } else {
      allowed.forEach((jid, i) => {
        const ok = statusOf(res, allowed, jid, i) === "200";
        (ok ? done : failed).push(jid);
      });
    }

    const lines = [];
    if (done.length) {
      lines.push(getLang("plugins.promote.done", mentionText(done)));
    }
    if (failed.length) {
      lines.push(getLang("plugins.promote.failed", mentionText(failed)));
    }
    await message.reply(lines.join("\n"), { mentions: [...done, ...failed] });
  },
};
