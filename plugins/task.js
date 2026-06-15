const { getLang } = require("../lib/utils/language");
const cron = require("cron");
const config = require("../config");

/**
 * Task Manager & Reminders Plugin
 * Store tasks in memory (can be extended to database)
 */

// In-memory storage for tasks and reminders
const tasks = new Map(); // chatId -> [{id, text, done, created}]
const reminders = new Map(); // chatId -> [{id, text, time, cronJob}]

module.exports = {
  command: {
    pattern: "task",
    desc: getLang("plugins.task.desc"),
    type: "utility",
  },

  async execute(message, query) {
    const [action, ...params] = query.split(" ");

    try {
      // Task management
      if (
        message.body.startsWith(`${config.PREFIX}task`) ||
        message.body.startsWith(`${config.PREFIX}todo`)
      ) {
        return await handleTask(message, action, params.join(" "));
      }

      // Reminder management
      if (message.body.startsWith(`${config.PREFIX}remind`)) {
        return await handleReminder(message, action, params.join(" "));
      }

      // Show help if no valid action
      await message.reply(getLang("plugins.task.usage"));
    } catch (error) {
      await message.react("❌");
      console.error("Task/Reminder error:", error);
      await message.reply(
        `❌ ${getLang("plugins.task.error")}: ${error.message}`
      );
    }
  },
};

async function handleTask(message, action, text) {
  const chatId = message.jid;

  if (!tasks.has(chatId)) {
    tasks.set(chatId, []);
  }

  const chatTasks = tasks.get(chatId);

  switch (action?.toLowerCase()) {
    case "add":
      if (!text) {
        return await message.reply(getLang("plugins.task.add_usage"));
      }

      const newTask = {
        id: Date.now(),
        text,
        done: false,
        created: new Date(),
      };

      chatTasks.push(newTask);
      await message.react("✅");
      await message.reply(`✅ ${getLang("plugins.task.added")}: _${text}_`);
      break;

    case "list":
      if (chatTasks.length === 0) {
        return await message.reply(getLang("plugins.task.no_tasks"));
      }

      const taskList = chatTasks
        .map(
          (task, idx) => `${idx + 1}. ${task.done ? "✅" : "⬜"} ${task.text}`
        )
        .join("\n");

      await message.reply(
        `📝 *${getLang("plugins.task.list_title")}*\n\n${taskList}`
      );
      break;

    case "done":
      const taskIndex = parseInt(text) - 1;
      if (isNaN(taskIndex) || taskIndex < 0 || taskIndex >= chatTasks.length) {
        return await message.reply(getLang("plugins.task.invalid_index"));
      }

      chatTasks[taskIndex].done = true;
      await message.react("✅");
      await message.reply(
        `✅ ${getLang("plugins.task.marked_done")}: _${
          chatTasks[taskIndex].text
        }_`
      );
      break;

    case "delete":
    case "remove":
      const deleteIndex = parseInt(text) - 1;
      if (
        isNaN(deleteIndex) ||
        deleteIndex < 0 ||
        deleteIndex >= chatTasks.length
      ) {
        return await message.reply(getLang("plugins.task.invalid_index"));
      }

      const deletedTask = chatTasks.splice(deleteIndex, 1)[0];
      await message.react("🗑️");
      await message.reply(
        `🗑️ ${getLang("plugins.task.deleted")}: _${deletedTask.text}_`
      );
      break;

    case "clear":
      tasks.set(chatId, []);
      await message.react("✅");
      await message.reply(`✅ ${getLang("plugins.task.cleared")}`);
      break;

    default:
      await message.reply(getLang("plugins.task.task_usage"));
  }
}

async function handleReminder(message, action, text) {
  const chatId = message.jid;

  if (!reminders.has(chatId)) {
    reminders.set(chatId, []);
  }

  const chatReminders = reminders.get(chatId);

  switch (action?.toLowerCase()) {
    case "add":
    case "set":
      // Format: remind add <time_in_minutes> <message>
      const parts = text.split(" ");
      const minutes = parseInt(parts[0]);
      const reminderText = parts.slice(1).join(" ");

      if (isNaN(minutes) || !reminderText) {
        return await message.reply(getLang("plugins.task.reminder_usage"));
      }

      const reminderId = Date.now();
      const reminderTime = new Date(Date.now() + minutes * 60000);

      // Schedule reminder
      const cronJob = new cron.CronJob(reminderTime, async () => {
        await message.client.getSocket().sendMessage(chatId, {
          text: `⏰ *${getLang("plugins.task.reminder")}*\n\n${reminderText}`,
        });

        // Remove from list after sending
        const index = chatReminders.findIndex((r) => r.id === reminderId);
        if (index !== -1) {
          chatReminders.splice(index, 1);
        }
      });

      cronJob.start();

      chatReminders.push({
        id: reminderId,
        text: reminderText,
        time: reminderTime,
        cronJob,
      });

      await message.react("⏰");
      await message.reply(
        `⏰ ${getLang("plugins.task.reminder_set")}: ${minutes} ${getLang(
          "plugins.task.minutes"
        )}\n_${reminderText}_`
      );
      break;

    case "list":
      if (chatReminders.length === 0) {
        return await message.reply(getLang("plugins.task.no_reminders"));
      }

      const reminderList = chatReminders
        .map((reminder, idx) => {
          const timeLeft = Math.round((reminder.time - Date.now()) / 60000);
          return `${idx + 1}. ${reminder.text} (${timeLeft} ${getLang(
            "plugins.task.minutes"
          )})`;
        })
        .join("\n");

      await message.reply(
        `⏰ *${getLang("plugins.task.reminders_title")}*\n\n${reminderList}`
      );
      break;

    case "cancel":
      const cancelIndex = parseInt(text) - 1;
      if (
        isNaN(cancelIndex) ||
        cancelIndex < 0 ||
        cancelIndex >= chatReminders.length
      ) {
        return await message.reply(getLang("plugins.task.invalid_index"));
      }

      const canceledReminder = chatReminders[cancelIndex];
      canceledReminder.cronJob.stop();
      chatReminders.splice(cancelIndex, 1);

      await message.react("✅");
      await message.reply(
        `✅ ${getLang("plugins.task.reminder_canceled")}: _${
          canceledReminder.text
        }_`
      );
      break;

    default:
      await message.reply(getLang("plugins.task.reminder_usage"));
  }
}
