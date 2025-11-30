const { getLang } = require("../lib/utils/language");
const simpleGit = require("simple-git");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * Helper to execute shell commands
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
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
};

/**
 * Update Plugin - Auto-update bot from GitHub
 * Owner only - pulls latest code, installs dependencies, and restarts
 */

module.exports = {
  command: {
    pattern: "update",
    desc: getLang("plugins.update.desc"),
    type: "owner",
  },

  async execute(message, query) {
    // Strict owner-only check
    if (!message.isSudo()) {
      return await message.reply(getLang("plugins.update.owner_only"));
    }

    // Check if user wants to update
    if (query !== "now") {
      return await message.reply(getLang("plugins.update.usage"));
    }

    try {
      await message.react("⏳");

      // Initial status message
      await message.reply(getLang("plugins.update.starting"));

      // Initialize git
      const git = simpleGit();

      // Fetch latest changes
      await message.reply(getLang("plugins.update.fetching"));

      // Check if there are uncommitted changes
      const status = await git.status();
      if (
        status.modified.length > 0 ||
        status.not_added.length > 0 ||
        status.deleted.length > 0 ||
        status.created.length > 0 ||
        status.renamed.length > 0
      ) {
        await message.reply(getLang("plugins.update.uncommitted_changes"));
        await message.react("⚠️");
        return;
      }

      // Get current branch
      const currentBranch = status.current || "main";

      // Fetch latest changes from remote
      await git.fetch("origin", currentBranch);

      // Pull latest changes from the current branch
      const pullResult = await git.pull("origin", currentBranch);

      if (pullResult.summary.changes === 0) {
        await message.reply(getLang("plugins.update.already_updated"));
        await message.react("ℹ️");
        return;
      }

      // Show what was updated
      const filesChanged = pullResult.files.length;
      const insertions = pullResult.summary.insertions;
      const deletions = pullResult.summary.deletions;

      await message.reply(
        getLang("plugins.update.changes_detected")
          .replace("{0}", filesChanged)
          .replace("{1}", insertions)
          .replace("{2}", deletions)
      );

      // Install dependencies
      await message.reply(getLang("plugins.update.installing_deps"));

      try {
        // Use yarn install with frozen lockfile for deterministic builds
        // Skip --production to ensure dev dependencies are also installed if needed
        const { stdout, stderr } = await execCommand(
          "yarn",
          ["install", "--frozen-lockfile"],
          {
            cwd: process.cwd(),
            timeout: 120000, // 2 minutes timeout
          }
        );

        if (stderr && !stderr.includes("warning")) {
          console.error("Yarn install stderr:", stderr);
        }
      } catch (installError) {
        console.error("Yarn install error:", installError);
        await message.reply(
          getLang("plugins.update.install_failed") + "\n" + installError.message
        );
        await message.react("❌");
        return;
      }

      // Restart bot
      await message.reply(getLang("plugins.update.restarting"));
      await message.react("✅");

      // Success message before restart
      await message.reply(getLang("plugins.update.success"));

      // Get PM2 app name from environment or package.json
      let appName = process.env.PM2_APP_NAME || "open-whatsapp-bot";

      // Try to get from package.json with error handling
      try {
        const packageJsonPath = path.join(__dirname, "..", "package.json");
        const packageJsonContent = fs.readFileSync(packageJsonPath, "utf8");
        const packageJson = JSON.parse(packageJsonContent);
        appName = packageJson.name || appName;
      } catch (pkgError) {
        console.warn(
          "Could not read package.json, using default app name:",
          appName
        );
      }

      // Helper function to delay execution
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      // Give time for messages to be sent before restart
      await delay(2000);

      try {
        // Restart with PM2 using spawn for security (prevents command injection)
        await execCommand("pm2", ["restart", appName], {
          timeout: 10000,
        });
      } catch (pm2Error) {
        // If PM2 fails, try alternative restart method
        console.log(
          "PM2 restart failed, trying process exit:",
          pm2Error.message
        );
        process.exit(0);
      }
    } catch (error) {
      await message.react("❌");
      console.error("Update error:", error);

      let errorMsg = getLang("plugins.update.error");

      // Handle specific git errors
      if (error.message.includes("CONFLICT")) {
        errorMsg = getLang("plugins.update.conflict_error");
      } else if (error.message.includes("fetch")) {
        errorMsg = getLang("plugins.update.network_error");
      } else {
        errorMsg += ": " + error.message;
      }

      await message.reply("❌ " + errorMsg);
    }
  },
};
