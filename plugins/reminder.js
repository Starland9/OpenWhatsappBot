const { getLang } = require("../lib/utils/language");
const cron = require("cron").CronJob;

/**
 * Set a reminder. Supports: 30s, 5m, 1h, 2d, or HH:MM (24h, same day).
 *   .remind 30m Buy milk
 *   .remind 14:30 Meeting with team
 * Persisted in-memory only (lost on restart — documented limitation).
 */
const reminders = new Map(); // id -> { cronJob, jid, sender, text, messageId }

let counter = 0;

function parseDuration(s) {
  const m = s.match(/^(\d+)\s*([smhd])$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const ms = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return n * ms;
}

function parseClock(s) {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

function nextRunFromClock({ h, m }) {
  const now = new Date();
  const target = new Date();
  target.setHours(h, m, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target;
}

module.exports = {
  command: {
    pattern: "remind|reminder|rappel",
    desc: getLang("plugins.reminder.desc"),
    type: "utility",
  },

  async execute(message, argsString) {
    const sock = message.client.getSocket();
    const args = (argsString || "").trim();
    const parts = args.split(/\s+/);
    const timeArg = parts[0];

    if (!timeArg) {
      return await message.reply(
        getLang("plugins.reminder.usage", require("../config").PREFIX),
      );
    }

    const text = parts.slice(1).join(" ").trim();
    if (!text) {
      return await message.reply(getLang("plugins.reminder.no_text"));
    }

    let when;
    const dur = parseDuration(timeArg);
    if (dur) {
      when = new Date(Date.now() + dur);
    } else {
      const clock = parseClock(timeArg);
      if (!clock)
        return await message.reply(
          getLang("plugins.reminder.usage", require("../config").PREFIX),
        );
      when = nextRunFromClock(clock);
    }

    const id = `${message.jid}_${++counter}_${Date.now()}`;
    const job = new cron(when, async () => {
      try {
        await sock.sendMessage(message.jid, {
          text: getLang("plugins.reminder.fire", text),
        });
      } catch (e) {
        console.error("reminder fire error:", e.message);
      }
      reminders.delete(id);
    });
    job.start();
    reminders.set(id, {
      cronJob: job,
      jid: message.jid,
      sender: message.sender,
      text,
      when,
    });

    await message.react("⏰");
    return await message.reply(
      getLang(
        "plugins.reminder.set",
        text,
        when.toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        }),
      ),
    );
  },
};
