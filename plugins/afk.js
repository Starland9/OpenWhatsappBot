const { getLang } = require("../lib/utils/language");

/**
 * AFK (Away From Keyboard) Plugin
 * Stores AFK status and auto-responds when mentioned
 */

let AFK = {
  isAfk: false,
  reason: false,
  lastseen: 0,
};

function secondsToHms(d) {
  d = Number(d);
  let h = Math.floor(d / 3600);
  let m = Math.floor((d % 3600) / 60);
  let s = Math.floor((d % 3600) % 60);
  let hDisplay = h > 0 ? h + (h == 1 ? " hour, " : " hours, ") : "";
  let mDisplay = m > 0 ? m + (m == 1 ? " minute, " : " minutes, ") : "";
  let sDisplay = s > 0 ? s + (s == 1 ? " second" : " seconds") : "";
  return hDisplay + mDisplay + sDisplay;
}

// Global listener for AFK auto-response
async function handleAfkResponse(message) {
  if (!AFK.isAfk || message.fromMe) return false;

  const isMentioned = message.mentions && message.mentions.length > 0;
  const isReply = message.quoted && message.quoted.sender;
  const botJid = message.client.getSocket().user.id;

  // Check if bot owner is mentioned or replied to
  if (
    (isMentioned && message.mentions.some((m) => m === botJid)) ||
    (isReply && message.quoted.sender === botJid)
  ) {
    const afkMsg = `*Owner is currently AFK*\n${
      AFK.reason ? `\n*Reason:* ${AFK.reason}` : ""
    }${
      AFK.lastseen !== 0
        ? `\n*Last Seen:* ${secondsToHms(
            Math.round(new Date().getTime() / 1000) - AFK.lastseen
          )} ago`
        : ""
    }`;

    await message.reply(afkMsg);
    return true;
  }

  return false;
}

// Check if user is back (sent a message while AFK)
async function checkAfkReturn(message) {
  if (!AFK.isAfk || !message.fromMe) return false;

  AFK.lastseen = 0;
  AFK.reason = false;
  AFK.isAfk = false;
  await message.reply("*I'm back now!*");
  return true;
}

module.exports = {
  command: {
    pattern: "afk",
    desc: "Set away from keyboard status with optional reason",
    type: "general",
  },

  async execute(message, args) {
    if (!AFK.isAfk) {
      AFK.lastseen = Math.round(new Date().getTime() / 1000);
      if (args) {
        AFK.reason = args;
      }
      AFK.isAfk = true;

      const msg = AFK.reason
        ? `*You're now AFK*\n*Reason:* ${AFK.reason}`
        : "*You're now AFK*";

      await message.reply(msg);
    } else {
      await message.reply("*You're already AFK!*");
    }
  },

  // Export handlers for global message processing
  handleAfkResponse,
  checkAfkReturn,
};
