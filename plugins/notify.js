const { getLang } = require("../lib/utils/language");
const config = require("../config");

/**
 * Smart Notifications Plugin - Keyword-based alerts and notifications
 */

// Storage for notification settings
const notifications = new Map(); // userId -> {keywords: [], enabled: true}
const triggeredAlerts = new Map(); // userId -> [timestamp, timestamp, ...]

module.exports = {
  command: {
    pattern: "notify",
    desc: getLang("plugins.notify.desc"),
    type: "utility",
  },

  async execute(message, query) {
    const userId = message.sender;
    const [action, ...params] = query.split(" ");

    try {
      if (!notifications.has(userId)) {
        notifications.set(userId, {
          keywords: [],
          enabled: true,
          chatId: message.jid,
        });
      }

      const userNotifications = notifications.get(userId);

      switch (action?.toLowerCase()) {
        case "add":
        case "set":
          const keyword = params.join(" ").toLowerCase();
          if (!keyword) {
            return await message.reply(getLang("plugins.notify.add_usage"));
          }

          if (userNotifications.keywords.includes(keyword)) {
            return await message.reply(
              getLang("plugins.notify.already_watching")
            );
          }

          userNotifications.keywords.push(keyword);
          await message.react("✅");
          await message.reply(
            `✅ ${getLang("plugins.notify.added")}: _${keyword}_\n\n` +
              `📝 ${getLang("plugins.notify.watching")}: ${
                userNotifications.keywords.length
              } ${getLang("plugins.notify.keywords")}`
          );
          break;

        case "remove":
        case "delete":
          const removeKeyword = params.join(" ").toLowerCase();
          if (!removeKeyword) {
            return await message.reply(getLang("plugins.notify.remove_usage"));
          }

          const index = userNotifications.keywords.indexOf(removeKeyword);
          if (index === -1) {
            return await message.reply(getLang("plugins.notify.not_watching"));
          }

          userNotifications.keywords.splice(index, 1);
          await message.react("✅");
          await message.reply(
            `✅ ${getLang("plugins.notify.removed")}: _${removeKeyword}_`
          );
          break;

        case "list":
          if (userNotifications.keywords.length === 0) {
            return await message.reply(getLang("plugins.notify.no_keywords"));
          }

          const keywordList = userNotifications.keywords
            .map((kw, idx) => `${idx + 1}. ${kw}`)
            .join("\n");
          await message.reply(
            `📋 *${getLang(
              "plugins.notify.list_title"
            )}*\n\n${keywordList}\n\n` +
              `📊 ${getLang("plugins.notify.status")}: ${
                userNotifications.enabled
                  ? "✅ " + getLang("plugins.notify.enabled")
                  : "❌ " + getLang("plugins.notify.disabled")
              }`
          );
          break;

        case "on":
        case "enable":
          userNotifications.enabled = true;
          await message.react("✅");
          await message.reply(`✅ ${getLang("plugins.notify.enabled_msg")}`);
          break;

        case "off":
        case "disable":
          userNotifications.enabled = false;
          await message.react("🔕");
          await message.reply(`🔕 ${getLang("plugins.notify.disabled_msg")}`);
          break;

        case "clear":
          userNotifications.keywords = [];
          await message.react("✅");
          await message.reply(`✅ ${getLang("plugins.notify.cleared")}`);
          break;

        default:
          await message.reply(getLang("plugins.notify.usage"));
      }
    } catch (error) {
      await message.react("❌");
      console.error("Notification error:", error);
      await message.reply(
        `❌ ${getLang("plugins.notify.error")}: ${error.message}`
      );
    }
  },
};

/**
 * Function to check messages for keyword matches
 * This should be called from the message handler
 */
async function checkNotifications(message, messageText) {
  if (!messageText || messageText.startsWith(config.PREFIX)) {
    return; // Don't check commands
  }

  const lowerText = messageText.toLowerCase();

  for (const [userId, settings] of notifications.entries()) {
    // Don't notify the sender about their own messages
    if (userId === message.sender) continue;

    if (!settings.enabled) continue;

    for (const keyword of settings.keywords) {
      if (lowerText.includes(keyword)) {
        // Rate limiting: max 1 notification per keyword per 5 minutes
        const alertKey = `${userId}_${keyword}`;
        const now = Date.now();

        if (!triggeredAlerts.has(alertKey)) {
          triggeredAlerts.set(alertKey, []);
        }

        const alerts = triggeredAlerts.get(alertKey);
        const recentAlerts = alerts.filter((time) => now - time < 300000); // 5 minutes

        if (recentAlerts.length > 0) {
          continue; // Skip if recently notified
        }

        // Send notification to user
        try {
          const senderNumber = message.sender.split("@")[0];
          const notificationText =
            `🔔 *${getLang("plugins.notify.alert_title")}*\n\n` +
            `🔑 *${getLang("plugins.notify.keyword")}:* _${keyword}_\n` +
            `👤 *${getLang("plugins.notify.from")}:* @${senderNumber}\n` +
            `💬 *${getLang("plugins.notify.message")}:* ${messageText}\n` +
            `📍 *${getLang("plugins.notify.chat")}:* ${
              message.isGroup
                ? settings.chatId.split("@")[0]
                : getLang("plugins.notify.private")
            }`;

          await message.client.getSocket().sendMessage(userId, {
            text: notificationText,
            mentions: [message.sender],
          });

          // Update alert history
          recentAlerts.push(now);
          triggeredAlerts.set(alertKey, recentAlerts);
        } catch (error) {
          console.error("Failed to send notification:", error);
        }
      }
    }
  }
}

module.exports.checkNotifications = checkNotifications;
