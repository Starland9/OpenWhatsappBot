const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { getLang } = require("../lib/utils/language");
const { safeLog } = require("../lib/utils/http");
const updater = require("../lib/utils/updater");
const ytdlpUpdate = require("../lib/utils/ytdlpUpdate");
const config = require("../config");

const logger = require("../lib/utils/logger").createLogger("update");

const RESTART_DELAY_MS = 2000;
const PM2_TIMEOUT_MS = 10000;

/** Log line without credentials embedded in remote URLs (https://user:token@host) */
function logSafe(err) {
  const info = safeLog(err);
  return { ...info, message: info.message.replace(/\/\/[^@\s/]+@/g, "//***@") };
}

/** `pm2 restart <name>` without a shell; rejects with a short message (output stays out of it) */
function pm2Restart(appName) {
  return new Promise((resolve, reject) => {
    execFile("pm2", ["restart", appName], { timeout: PM2_TIMEOUT_MS, windowsHide: true }, (error) => {
      if (error) reject(new Error(`pm2 restart failed (${error.code ?? "error"})`));
      else resolve();
    });
  });
}

/** PM2 app name: package.json name, else the default */
function appNameFromPackage() {
  const fallback = "open-whatsapp-bot";
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return packageJson.name || fallback;
  } catch (pkgError) {
    logger.warn(`Could not read package.json, using default app name: ${fallback}`);
    return fallback;
  }
}

/** Reply key for the blocker that stops an update before anything is touched */
function blockerKey(blockers) {
  if (blockers.includes("dirty_tree")) return "plugins.update.uncommitted_changes";
  if (blockers.includes("detached")) return "plugins.update.detached";
  if (blockers.includes("no_remote_branch")) return "plugins.update.no_remote_branch";
  return "plugins.update.unavailable";
}

/**
 * Update Plugin - update the bot from GitHub
 * Owner only. A thin client of lib/utils/updater.js (the same engine and the same lock as the panel): fast-forward
 * only on the upstream of the current branch, vendored Yarn only when the dependencies changed, a smoke boot of
 * the new code, and a rollback to the running version on any failure. A supervised process restarts itself
 * afterwards (PM2 fast path); an unsupervised one is told to be restarted by hand.
 */

module.exports = {
  command: {
    pattern: "update",
    desc: getLang("plugins.update.desc"),
    type: "owner",
    fromMe: true,
  },

  async execute(message, query) {
    // Check if user wants to update
    if (String(query || "").trim().toLowerCase() !== "now") {
      return await message.reply(getLang("plugins.update.usage", config.PREFIX));
    }

    if (updater.isBusy()) {
      return await message.reply(getLang("plugins.update.busy"));
    }

    try {
      await message.react("⏳");
      await message.reply(getLang("plugins.update.starting"));

      // Install type and blockers: image, archive, no git, detached, no upstream, tracked changes
      const info = await updater.getInstallInfo();
      if (!info.canSelfUpdate) {
        await message.reply(getLang(blockerKey(info.blockers)));
        await message.react("⚠️");
        return;
      }

      await message.reply(getLang("plugins.update.fetching"));

      const result = await updater.apply({
        actor: "command",
        onProgress: async ({ phase }) => {
          if (phase === "install") await message.reply(getLang("plugins.update.installing_deps"));
        },
      });

      if (!result.ok) {
        await replyFailure(message, result);
        return;
      }

      if (result.upToDate) {
        await message.reply(getLang("plugins.update.already_updated"));
        await message.react("ℹ️");
        return;
      }

      // Show what was updated
      await message.reply(
        getLang("plugins.update.changes_detected", result.stats.files, result.stats.insertions, result.stats.deletions),
      );

      // Keep downloads working: refresh yt-dlp too (best effort, refused while a download runs)
      try {
        await ytdlpUpdate.update();
      } catch (ytError) {
        logger.warn(logSafe(ytError), "yt-dlp self-update failed");
      }

      if (!result.willRestart) {
        // Nothing would start the new code: the owner restarts the program (the panel shows the same notice)
        await message.react("✅");
        await message.reply(getLang("plugins.update.restart_manual"));
        return;
      }

      await message.reply(getLang("plugins.update.restarting"));
      await message.react("✅");
      await message.reply(getLang("plugins.update.success"));

      // Give time for messages to be sent before restart
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));

      if (process.env.pm_id !== undefined) {
        try {
          await pm2Restart(appNameFromPackage());
          return;
        } catch (pm2Error) {
          // PM2 restarts the process on any exit: fall through to the supervised exit
          logger.warn(logSafe(pm2Error), "PM2 restart failed, exiting the process");
        }
      }
      updater.scheduleExit();
    } catch (error) {
      await message.react("❌");
      logger.error(logSafe(error), "Update error");
      await message.reply(getLang("plugins.update.error"));
    }
  },
};

/** Tell the owner why the update did not happen, and whether the running version was restored */
async function replyFailure(message, result) {
  await message.react(result.reason === "busy" || result.reason === "unavailable" ? "⚠️" : "❌");
  switch (result.reason) {
    case "busy":
      await message.reply(getLang("plugins.update.busy"));
      break;
    case "unavailable":
      await message.reply(getLang(blockerKey(result.blockers || [])));
      break;
    case "no_remote_branch":
      await message.reply(getLang("plugins.update.no_remote_branch"));
      break;
    case "network":
      await message.reply(getLang("plugins.update.network_error"));
      break;
    case "diverged":
      await message.reply(getLang("plugins.update.diverged"));
      break;
    case "install_failed":
      await message.reply(getLang("plugins.update.install_failed"));
      if (result.rolledBack) await message.reply(getLang("plugins.update.rolled_back"));
      break;
    case "smoke_failed":
    case "merge_failed":
      await message.reply(getLang(result.rolledBack ? "plugins.update.rolled_back" : "plugins.update.error"));
      break;
    default:
      await message.reply(getLang("plugins.update.error"));
  }
}
