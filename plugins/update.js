const { simpleGit } = require("simple-git");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const { getLang } = require("../lib/utils/language");
const { safeLog } = require("../lib/utils/http");
const downloader = require("../lib/utils/downloader");
const config = require("../config");

const logger = pino({ level: config.LOG_LEVEL });

const GIT_TIMEOUT_MS = 120000; // per git process, reset on output
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const YTDLP_UPDATE_TIMEOUT_MS = 60000;
const RESTART_DELAY_MS = 2000;

// Only one update at a time (a second one would race on git and yarn)
let updateRunning = false;

/**
 * Run a command without a shell. Rejects with a short message; the output stays
 * on `err.stderr` for the logs only.
 */
const execCommand = (command, args = [], options = {}) => {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { ...options, shell: false });
    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", reject);
    proc.on("close", (code, signal) => {
      if (code !== 0) {
        const err = new Error(`${command} exited with ${code ?? signal}`);
        err.code = code;
        err.stderr = stderr.slice(-2000);
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
};

/** Log line without credentials embedded in remote URLs (https://user:token@host) */
function logSafe(err) {
  const info = safeLog(err);
  return { ...info, message: info.message.replace(/\/\/[^@\s/]+@/g, "//***@") };
}

/** Tracked files with local changes (untracked files do not block an update) */
function hasTrackedChanges(status) {
  return (
    status.modified.length > 0 ||
    status.deleted.length > 0 ||
    status.created.length > 0 ||
    status.renamed.length > 0 ||
    status.staged.length > 0 ||
    status.conflicted.length > 0
  );
}

/** Best-effort `yt-dlp -U`: downloads break when the extractors get stale */
async function updateYtDlp() {
  try {
    if (!(await downloader.isAvailable())) return;
    await execCommand(config.YTDLP_PATH || "yt-dlp", ["-U"], {
      timeout: YTDLP_UPDATE_TIMEOUT_MS,
    });
  } catch (error) {
    // e.g. installed through a package manager: not fatal
    logger.warn(logSafe(error), "yt-dlp self-update failed");
  } finally {
    downloader.resetCache();
  }
}

/**
 * Reply key for a failed update. The error text is only inspected, never sent.
 * @param {Error} error
 * @param {string} phase - "git" (status/revparse), "fetch" or "pull"
 */
function errorKey(error, phase) {
  const text = String(error?.message || "");
  if (/CONFLICT/i.test(text)) return "plugins.update.conflict_error";
  if (/fast-forward|diverg|ff-only/i.test(text)) return "plugins.update.diverged";
  // Reaching GitHub is the whole job of the fetch step
  if (
    phase === "fetch" ||
    /could not resolve|unable to access|network|timed out|timeout|ENOTFOUND|ECONNREFUSED/i.test(text)
  ) {
    return "plugins.update.network_error";
  }
  return "plugins.update.error";
}

/**
 * Update Plugin - Auto-update bot from GitHub
 * Owner only - pulls latest code (fast-forward only), installs dependencies, and restarts
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

    if (updateRunning) {
      return await message.reply(getLang("plugins.update.busy"));
    }
    updateRunning = true;
    let phase = "git";

    try {
      await message.react("⏳");

      // Initial status message
      await message.reply(getLang("plugins.update.starting"));

      // Initialize git
      const git = simpleGit({
        baseDir: process.cwd(),
        timeout: { block: GIT_TIMEOUT_MS },
      });

      // Fetch latest changes
      await message.reply(getLang("plugins.update.fetching"));

      // Local changes to tracked files would make the pull fail or merge badly
      const status = await git.status();
      if (hasTrackedChanges(status)) {
        await message.reply(getLang("plugins.update.uncommitted_changes"));
        await message.react("⚠️");
        return;
      }

      if (!status.current || status.detached) {
        await message.reply(getLang("plugins.update.detached"));
        await message.react("⚠️");
        return;
      }
      const currentBranch = status.current;

      // Fetch latest changes from remote
      phase = "fetch";
      await git.fetch("origin", currentBranch);

      // Compare with what was just fetched (locale independent): "ahead" = local
      // commits missing from GitHub, "behind" = new commits to pull
      phase = "pull";
      const counts = await git.raw(["rev-list", "--left-right", "--count", "HEAD...FETCH_HEAD"]);
      const [ahead = 0, behind = 0] = counts.trim().split(/\s+/).map(Number);

      if (behind === 0) {
        await message.reply(getLang("plugins.update.already_updated"));
        await message.react("ℹ️");
        return;
      }

      if (ahead > 0) {
        await message.reply(getLang("plugins.update.diverged"));
        await message.react("⚠️");
        return;
      }

      // Pull latest changes: fast-forward only, never a merge commit
      const pullResult = await git.pull("origin", currentBranch, ["--ff-only"]);
      phase = "after";

      // Show what was updated
      await message.reply(
        getLang(
          "plugins.update.changes_detected",
          pullResult.files?.length ?? 0,
          pullResult.summary?.insertions ?? 0,
          pullResult.summary?.deletions ?? 0,
        ),
      );

      // Install dependencies
      await message.reply(getLang("plugins.update.installing_deps"));

      try {
        // Deterministic install: fails instead of rewriting the lockfile
        await execCommand("yarn", ["install", "--immutable"], {
          cwd: process.cwd(),
          timeout: INSTALL_TIMEOUT_MS,
        });
      } catch (installError) {
        logger.error(
          { ...logSafe(installError), stderr: installError.stderr },
          "Yarn install failed during update",
        );
        await message.reply(getLang("plugins.update.install_failed"));
        await message.react("❌");
        return;
      }

      // Keep downloads working: refresh yt-dlp too (best effort)
      await updateYtDlp();

      // Restart bot
      await message.reply(getLang("plugins.update.restarting"));
      await message.react("✅");

      // Success message before restart
      await message.reply(getLang("plugins.update.success"));

      // PM2 app name: package.json name, else the default
      let appName = "open-whatsapp-bot";
      try {
        const packageJsonPath = path.join(__dirname, "..", "package.json");
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        appName = packageJson.name || appName;
      } catch (pkgError) {
        logger.warn(`Could not read package.json, using default app name: ${appName}`);
      }

      // Give time for messages to be sent before restart
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));

      try {
        // Restart with PM2 using spawn for security (prevents command injection)
        await execCommand("pm2", ["restart", appName], { timeout: 10000 });
      } catch (pm2Error) {
        // If PM2 fails, exit and let the process manager (Docker, systemd...) restart us
        logger.warn(logSafe(pm2Error), "PM2 restart failed, exiting the process");
        process.exit(0);
      }
    } catch (error) {
      await message.react("❌");
      logger.error(logSafe(error), "Update error");
      await message.reply(getLang(errorKey(error, phase)));
    } finally {
      updateRunning = false;
    }
  },
};
