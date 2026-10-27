const { getLang } = require("../lib/utils/language");
const config = require("../config");
const { Task } = require("../lib/database");
const { normalizeJid, toPnJid } = require("../lib/utils/permissions");

/**
 * Task manager (research R17): a shared to-do list per chat, stored in the
 * `Task` table.
 *
 *   .task add <text>        1 to 300 characters, at most 100 tasks per chat
 *   .task list
 *   .task done <n>          .task undone <n>
 *   .task del <n>           the creator, a group admin or an owner
 *   .task clear [all]       removes the done tasks (all: every task)
 *                           admins and owners: any task; others: their own tasks
 *
 * `<n>` is the number shown by `.task list`.
 */

const MAX_TEXT_LENGTH = 300;
const MAX_TASKS_PER_CHAT = 100;
const ADD_WORDS = new Set(["add", "new", "ajouter"]);
const LIST_WORDS = new Set(["list", "liste", "ls"]);
const DONE_WORDS = new Set(["done", "fait"]);
const UNDONE_WORDS = new Set(["undone", "undo", "reopen"]);
const DELETE_WORDS = new Set(["del", "delete", "remove", "rm", "supprimer"]);
const CLEAR_WORDS = new Set(["clear", "vider"]);

/** Stored author id (phone-number form first) and the other forms of the sender */
async function identityForms(message) {
  const pn = await toPnJid(message, message.sender);
  return [...new Set([pn, normalizeJid(message.sender), normalizeJid(message.senderLid)].filter(Boolean))];
}

/** The chat's tasks in display order (the number shown to users is index + 1) */
const chatTasks = (chatJid) => Task.findAll({ where: { chatJid }, order: [["id", "ASC"]] });

function usage() {
  return `${getLang("common.usage_prefix")}\n${getLang("plugins.task.usage", config.PREFIX)}`;
}

/** The task designated by `.task <action> <n>`, or null after replying */
async function pickTask(message, rest) {
  const match = rest.trim().match(/^#?(\d{1,6})$/);
  if (!match) {
    await message.reply(getLang("plugins.task.invalid_index"));
    return null;
  }
  const tasks = await chatTasks(message.jid);
  const task = tasks[Number(match[1]) - 1];
  if (!task) {
    await message.reply(getLang("plugins.task.invalid_index"));
    return null;
  }
  return task;
}

/** May the sender delete this task? Creator, group admin or owner (any member in a private chat) */
async function canRemove(message, task, forms) {
  if (!message.isGroup) return true;
  if (forms.includes(normalizeJid(task.createdBy))) return true;
  return message.isSudo() || (await message.isSenderAdmin());
}

async function addTask(message, rest) {
  const text = rest.replace(/\s+/g, " ").trim();
  if (!text) return message.reply(getLang("plugins.task.add_usage", config.PREFIX));
  if (text.length > MAX_TEXT_LENGTH) {
    return message.reply(getLang("plugins.task.text_too_long", MAX_TEXT_LENGTH));
  }

  const count = await Task.count({ where: { chatJid: message.jid } });
  if (count >= MAX_TASKS_PER_CHAT) {
    return message.reply(getLang("plugins.task.limit_reached", MAX_TASKS_PER_CHAT));
  }

  const [createdBy] = await identityForms(message);
  await Task.create({ chatJid: message.jid, text, createdBy });
  await message.react("✅");
  return message.reply(getLang("plugins.task.added", count + 1, text));
}

async function listTasks(message) {
  const tasks = await chatTasks(message.jid);
  if (!tasks.length) return message.reply(getLang("plugins.task.no_tasks"));

  const lines = tasks.map((task, index) =>
    getLang(task.done ? "plugins.task.item_done" : "plugins.task.item_open", index + 1, task.text),
  );
  const open = tasks.filter((task) => !task.done).length;
  return message.reply(
    `${getLang("plugins.task.list_title", open, tasks.length)}\n\n${lines.join("\n")}`,
  );
}

async function setDone(message, rest, done) {
  const task = await pickTask(message, rest);
  if (!task) return undefined;

  if (task.done === done) {
    return message.reply(getLang(done ? "plugins.task.already_done" : "plugins.task.already_open"));
  }
  const [doneBy] = await identityForms(message);
  await task.update({ done, doneBy: done ? doneBy : null });
  await message.react("✅");
  return message.reply(getLang(done ? "plugins.task.marked_done" : "plugins.task.marked_open", task.text));
}

async function deleteTask(message, rest) {
  const task = await pickTask(message, rest);
  if (!task) return undefined;

  const forms = await identityForms(message);
  if (!(await canRemove(message, task, forms))) {
    return message.reply(getLang("plugins.task.delete_denied"));
  }
  await task.destroy();
  await message.react("🗑️");
  return message.reply(getLang("plugins.task.deleted", task.text));
}

async function clearTasks(message, rest) {
  const everything = /^(all|tout|tous)$/i.test(rest.trim());
  if (rest.trim() && !everything) return message.reply(usage());

  const tasks = (await chatTasks(message.jid)).filter((task) => everything || task.done);
  if (!tasks.length) return message.reply(getLang("plugins.task.nothing_to_clear"));

  const forms = await identityForms(message);
  const privileged = !message.isGroup || message.isSudo() || (await message.isSenderAdmin());
  const removable = tasks.filter(
    (task) => privileged || forms.includes(normalizeJid(task.createdBy)),
  );
  if (!removable.length) return message.reply(getLang("plugins.task.delete_denied"));

  await Task.destroy({ where: { id: removable.map((task) => task.id) } });
  await message.react("✅");
  const skipped = tasks.length - removable.length;
  const reply = getLang("plugins.task.cleared", removable.length);
  return message.reply(skipped ? `${reply}\n${getLang("plugins.task.clear_skipped", skipped)}` : reply);
}

module.exports = {
  command: {
    pattern: "task|todo",
    desc: getLang("plugins.task.desc"),
    type: "utility",
  },

  async execute(message, argsString, ctx) {
    const raw = String(ctx?.rawArgs ?? argsString ?? "").replace(/^\s+/, "");
    const first = raw.split(/\s+/, 1)[0];
    const action = first.toLowerCase();
    const rest = raw.slice(first.length);

    if (ADD_WORDS.has(action)) return addTask(message, rest);
    if (LIST_WORDS.has(action)) return listTasks(message);
    if (DONE_WORDS.has(action)) return setDone(message, rest, true);
    if (UNDONE_WORDS.has(action)) return setDone(message, rest, false);
    if (DELETE_WORDS.has(action)) return deleteTask(message, rest);
    if (CLEAR_WORDS.has(action)) return clearTasks(message, rest);
    return message.reply(usage());
  },
};
