const { getLang } = require("../lib/utils/language");
const { Idea } = require("../lib/database");
const { sendQuickReplies } = require("./buttons");
const { Sequelize } = require("sequelize");
const config = require("../config");
const cooldown = require("../lib/utils/cooldown");
const { safeLog } = require("../lib/utils/http");

/**
 * Group idea/suggestion box with voting and pagination.
 *
 *   .idea                   list (page 1)
 *   .idea add <text>        add an idea
 *   .idea list              list
 *   .idea top               the 5 most voted ideas
 *   .idea vote <id>         vote (again: remove the vote)
 *   .idea delete <id>       delete (group admins and owners)
 *
 * Button ids: `idea:add`, `idea:list:<page>`, `idea:top`.
 */

const PAGE_SIZE = 5;
const TOP_SIZE = 5;
const MIN_TEXT = 3;
const MAX_TEXT = 1000;
const PREVIEW_CHARS = 60;
const ADD_COOLDOWN_MS = 10 * 1000;
const VOTE_RETRIES = 4;

// Number of voters, computed by the database: `voters` is a comma-joined text column
const VOTE_COUNT_SQL = Sequelize.literal(
  "(CASE WHEN COALESCE(voters, '') = '' THEN 0 " +
    "ELSE LENGTH(voters) - LENGTH(REPLACE(voters, ',', '')) + 1 END)",
);

function preview(text) {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}...` : text;
}

function parseId(value) {
  const id = parseInt(String(value || "").replace(/^#/, ""), 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function usage() {
  return getLang("plugins.idea.usage", config.PREFIX);
}

function buttonOptions(message, footer) {
  return {
    title: getLang("plugins.idea.title"),
    footer,
    quoted: message.data,
  };
}

async function addIdea(message, text) {
  const clean = (text || "").trim();
  if (clean.length < MIN_TEXT) {
    return await message.reply(usage());
  }
  const wait = cooldown.hit(message.sender, "idea-add", ADD_COOLDOWN_MS);
  if (wait) {
    return await message.reply(getLang("common.cooldown", Math.ceil(wait / 1000)));
  }
  const idea = await Idea.create({
    groupJid: message.jid,
    authorJid: message.sender,
    text: clean.slice(0, MAX_TEXT),
    voters: [],
  });
  await message.react("📝");
  return await message.reply(getLang("plugins.idea.added", idea.id));
}

async function listIdeas(message, requestedPage) {
  const total = await Idea.count({ where: { groupJid: message.jid } });
  if (total === 0) {
    return await message.reply(getLang("plugins.idea.empty"));
  }
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage || 0), totalPages - 1);

  const ideas = await Idea.findAll({
    where: { groupJid: message.jid },
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const text =
    `${getLang("plugins.idea.list_title", page + 1, totalPages)}\n\n` +
    ideas
      .map((i) => `  #${i.id} — _${preview(i.text)}_ — ❤️ ${i.voters.length}`)
      .join("\n");

  const nav = [];
  if (page > 0) {
    nav.push({ id: `idea:list:${page - 1}`, text: getLang("plugins.buttons.prev") });
  }
  if (page < totalPages - 1) {
    nav.push({ id: `idea:list:${page + 1}`, text: getLang("plugins.buttons.next") });
  }
  nav.push({ id: "idea:add", text: getLang("plugins.idea.btn_add") });

  return await sendQuickReplies(
    message.client.getSocket(),
    message.jid,
    text,
    nav,
    buttonOptions(message, getLang("plugins.idea.page_footer", page + 1, totalPages)),
  );
}

async function topIdeas(message) {
  const top = await Idea.findAll({
    where: { groupJid: message.jid },
    order: [
      [VOTE_COUNT_SQL, "DESC"],
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    limit: TOP_SIZE,
  });
  if (top.length === 0) {
    return await message.reply(getLang("plugins.idea.empty"));
  }
  const text =
    `${getLang("plugins.idea.top_title")}\n\n` +
    top
      .map(
        (i, idx) =>
          `  ${idx + 1}. #${i.id} — _${preview(i.text)}_ — ❤️ ${i.voters.length}`,
      )
      .join("\n");
  return await message.reply(text);
}

// Votes on the same idea are applied one after the other (per process)
const voteQueues = new Map();

function serialize(key, task) {
  const previous = voteQueues.get(key) || Promise.resolve();
  const run = previous.then(task);
  const tail = run.catch(() => {});
  voteQueues.set(key, tail);
  tail.then(() => {
    if (voteQueues.get(key) === tail) voteQueues.delete(key);
  });
  return run;
}

/**
 * Toggle the vote of `voter`. Votes on one idea are queued, and the new list is
 * written only if the column has not changed since it was read (compare-and-swap),
 * so a vote can neither be lost nor overwrite another one, even with several
 * processes; on a conflict it re-reads and tries again.
 * @returns {Promise<{voted: boolean, count: number}|null>} null when the idea does not exist
 */
function toggleVote(groupJid, id, voter) {
  return serialize(`${groupJid}|${id}`, async () => {
    for (let attempt = 0; attempt < VOTE_RETRIES; attempt++) {
      const idea = await Idea.findOne({ where: { id, groupJid } });
      if (!idea) return null;

      const stored = idea.getDataValue("voters");
      const voters = idea.voters;
      const voted = voters.includes(voter);
      const next = voted ? voters.filter((v) => v !== voter) : [...voters, voter];

      const [changed] = await Idea.update(
        { voters: next.join(",") },
        { where: { id, groupJid, voters: stored } },
      );
      if (changed) return { voted: !voted, count: next.length };
    }
    throw new Error("Could not record the vote: too many concurrent changes");
  });
}

async function voteIdea(message, idStr) {
  const id = parseId(idStr);
  if (!id) return await message.reply(usage());

  const result = await toggleVote(message.jid, id, message.sender);
  if (!result) return await message.reply(getLang("plugins.idea.not_found", id));
  return await message.reply(
    getLang(
      result.voted ? "plugins.idea.voted" : "plugins.idea.unvoted",
      id,
      result.count,
    ),
  );
}

async function deleteIdea(message, idStr) {
  if (!message.isSudo() && !(await message.isSenderAdmin())) {
    return await message.reply(getLang("common.sender_not_admin"));
  }
  const id = parseId(idStr);
  if (!id) return await message.reply(usage());

  const deleted = await Idea.destroy({ where: { id, groupJid: message.jid } });
  if (!deleted) return await message.reply(getLang("plugins.idea.not_found", id));
  return await message.reply(getLang("plugins.idea.deleted", id));
}

/** Menu with the usage and the main actions as buttons */
async function showMenu(message) {
  return await sendQuickReplies(
    message.client.getSocket(),
    message.jid,
    getLang("plugins.idea.menu", usage()),
    [
      { id: "idea:add", text: getLang("plugins.idea.btn_add_idea") },
      { id: "idea:list:0", text: getLang("plugins.idea.btn_list") },
      { id: "idea:top", text: getLang("plugins.idea.btn_top") },
    ],
    buttonOptions(message, "OpenWhatsappBot"),
  );
}

module.exports = {
  command: {
    pattern: "idea|idee|suggest",
    desc: getLang("plugins.idea.desc"),
    type: "group",
    onlyGroup: true,
  },

  async execute(message, argsString, ctx) {
    // rawArgs keeps the line breaks of a multi-line idea
    const raw = (ctx && typeof ctx.rawArgs === "string" ? ctx.rawArgs : argsString || "").trim();
    const [, word = "", rest = ""] = raw.match(/^(\S*)\s*([\s\S]*)$/);
    const sub = word.toLowerCase();

    if (sub === "" || sub === "list") return await listIdeas(message, 0);
    if (sub === "add" || sub === "new") return await addIdea(message, rest);
    if (sub === "top" || sub === "best") return await topIdeas(message);
    if (sub === "vote" || sub === "v") return await voteIdea(message, rest.split(/\s+/)[0]);
    if (sub === "delete" || sub === "del") return await deleteIdea(message, rest.split(/\s+/)[0]);

    return await showMenu(message);
  },

  async handleButtonReply(message) {
    const body = message.body;
    if (typeof body !== "string" || !body.startsWith("idea:")) return false;
    const [, action, arg] = body.split(":");

    try {
      if (action === "add") {
        // The user picked "Add idea": explain how to send the text
        await message.reply(getLang("plugins.idea.add_hint", config.PREFIX));
      } else if (action === "list") {
        await listIdeas(message, parseInt(arg, 10) || 0);
      } else if (action === "top") {
        await topIdeas(message);
      } else {
        return false;
      }
    } catch (err) {
      console.error("idea reply:", safeLog(err));
      await message.reply(getLang("common.error")).catch(() => {});
    }
    return true;
  },
};
