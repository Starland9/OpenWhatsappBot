const { getLang } = require("../lib/utils/language");
const statusListStore = require("../lib/utils/statusListStore");
const config = require("../config");

const MIN_DIGITS = 6;
const MAX_DIGITS = 16;

/** Digits of the number given after the subcommand (spaces and "+" allowed), or "" */
function parseNumber(parts) {
  const number = statusListStore.normalizeNumber(parts.slice(1).join(""));
  return number.length >= MIN_DIGITS && number.length <= MAX_DIGITS ? number : "";
}

function listText(st) {
  return st.list.length > 0 ? st.list.join(", ") : getLang("plugins.statussave.list_empty");
}

module.exports = {
  command: {
    pattern: "statussave|ss",
    desc: getLang("plugins.statussave.desc"),
    type: "admin",
    fromMe: true,
  },

  async execute(message, argsString = "") {
    const parts = String(argsString).trim().split(/\s+/).filter(Boolean);
    const cmd = parts[0] ? parts[0].toLowerCase() : "";
    const prefix = config.PREFIX;

    if (!cmd || cmd === "help") {
      return await message.reply(getLang("plugins.statussave.usage", prefix));
    }

    if (cmd === "on") {
      const st = await statusListStore.setEnabled(true);
      let text = getLang("plugins.statussave.enabled", listText(st));
      // An empty list saves the statuses of every contact: say it
      if (st.list.length === 0) {
        text += `\n\n${getLang("plugins.statussave.enabled_all_warning", prefix)}`;
      }
      return await message.reply(text);
    }

    if (cmd === "off") {
      const st = await statusListStore.setEnabled(false);
      let text = getLang("plugins.statussave.disabled");
      if (st.forcedByEnv) text += `\n\n${getLang("plugins.statussave.forced_by_env")}`;
      return await message.reply(text);
    }

    if (cmd === "add") {
      if (parts.length < 2) {
        return await message.reply(getLang("plugins.statussave.add_usage", prefix));
      }
      const number = parseNumber(parts);
      if (!number) return await message.reply(getLang("plugins.statussave.invalid_number"));
      const st = await statusListStore.add(number);
      return await message.reply(getLang("plugins.statussave.added", listText(st)));
    }

    if (cmd === "rm" || cmd === "remove" || cmd === "del") {
      if (parts.length < 2) {
        return await message.reply(getLang("plugins.statussave.rm_usage", prefix));
      }
      const number = parseNumber(parts);
      if (!number) return await message.reply(getLang("plugins.statussave.invalid_number"));
      const before = await statusListStore.get();
      if (!before.list.includes(number)) {
        return await message.reply(getLang("plugins.statussave.not_in_list"));
      }
      const st = await statusListStore.remove(number);
      return await message.reply(getLang("plugins.statussave.removed", listText(st)));
    }

    if (cmd === "list") {
      const st = await statusListStore.get();
      let text = getLang(
        "plugins.statussave.status",
        st.active ? getLang("common.status_enabled") : getLang("common.status_disabled"),
        listText(st),
      );
      if (st.forcedByEnv) text += `\n\n${getLang("plugins.statussave.forced_by_env")}`;
      if (st.active && st.list.length === 0) {
        text += `\n\n${getLang("plugins.statussave.enabled_all_warning", prefix)}`;
      }
      return await message.reply(text);
    }

    return await message.reply(getLang("plugins.statussave.unknown", prefix));
  },
};
