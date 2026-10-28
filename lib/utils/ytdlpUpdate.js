"use strict";

/**
 * Update of the download tool, `yt-dlp -U` (specs/002-admin-panel: contracts/runtime.md section 11, research D2;
 * FR-055). Used by the panel (lib/admin/services/maintenance.js) and the `.update` command.
 *
 *   ytdlpUpdate.inspect()                 -> { selfUpdatable: "likely"|"no"|"missing", reason?: "read_only"|"package_managed",
 *                                              version, hint }
 *   ytdlpUpdate.update({ onProgress })    -> { outcome, before, after }
 *        outcome: updated | up_to_date | managed_externally | read_only | unreachable | failed | busy | missing
 *
 * THE VERDICT COMES FROM THE VERSION BEFORE AND AFTER, never from stdout: `downloader.resetCache()` then
 * `isAvailable()` / `getVersion()` are read on each side of `execFile(YTDLP_PATH, ["-U"], { timeout: 60 s })`. A
 * different version is `updated`; the same version after a clean exit is `up_to_date`. Only a failed run looks at
 * stderr, to classify it (`/package manager|manual build|unofficial build/` -> managed_externally,
 * `/permission|Unable to write/` -> read_only, network codes -> unreachable, anything else -> failed); stderr is
 * never forwarded to a caller and only its tail reaches the logs. The configured path is never returned: callers get
 * the command name.
 *
 * Concurrency: refused (`busy`) while a download runs or another update is running; while `-U` runs the downloader
 * is put in maintenance (`setMaintenance(true)`), so a new download is refused with YTDLP_BUSY until it ends.
 *
 * `hint` (instructions are UI text): "apt", "pip", "official_binary" or "rebuild_image", or null. It is derived
 * from where the binary lives and from the container marker, never from the update's output.
 *
 * `createYtdlpUpdate({ downloader, config, execFile, fs, env, runtime })` for tests; the default singleton is the
 * module itself. No timer, nothing at require time.
 */

const nodeFs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const runtimeInfo = require("./runtime");

const logger = require("./logger").createLogger("ytdlp-update");

const UPDATE_TIMEOUT_MS = 60 * 1000;
const HEAD_BYTES = 512;
const STUB_MAX_BYTES = 4096; // a python entry point of pip / apt is a few hundred bytes
const BIG_BINARY_BYTES = 1024 * 1024; // the release script (zip) and PyInstaller binaries are several MB
const MANAGED_RE = /package manager|manual build|unofficial build/i;
const READ_ONLY_RE = /permission|unable to write|read-only file system|EACCES|EROFS/i;
const NETWORK_RE =
  /unable to download|urlopen error|timed out|timeout|name or service not known|temporary failure in name resolution|network is unreachable|connection (refused|reset)|ssl|certificate|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|rate limit|HTTP Error (403|429|5\d\d)/i;
const PACKAGE_PREFIXES = ["/usr/bin/", "/bin/", "/usr/lib/", "/snap/", "/opt/homebrew/", "/home/linuxbrew/"];

function createYtdlpUpdate(options = {}) {
  const fs = options.fs || nodeFs;
  const env = options.env || process.env;
  const getDownloader = () => options.downloader || require("./downloader");
  const getConfig = () => options.config || require("../../config");
  const exec = () => options.execFile || childProcess.execFile;

  let updating = false;

  /** The configured command, `yt-dlp` when nothing is set */
  const commandOf = () => String(getConfig().YTDLP_PATH || "yt-dlp");

  /** Absolute path of the configured binary: itself when it has a slash, else the first match on PATH */
  function resolveBinary() {
    const command = commandOf();
    const executable = (file) => {
      try {
        const stat = fs.statSync(file);
        fs.accessSync(file, nodeFs.constants.X_OK);
        return stat.isFile();
      } catch {
        return false;
      }
    };
    if (command.includes("/") || command.includes(path.sep)) return executable(command) ? path.resolve(command) : null;
    for (const dir of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(dir, command);
      if (executable(candidate)) return candidate;
    }
    return null;
  }

  const isContainer = () => runtimeInfo.isContainer({ fs, env });

  /** Instructions to show, from where the binary lives (never from output) */
  function hintFor(file, kind) {
    if (isContainer()) return "rebuild_image";
    if (kind === "managed") return file && file.startsWith("/usr/bin/") ? "apt" : "pip";
    return "official_binary";
  }

  /** Read the first bytes of the binary */
  function head(file) {
    let fd;
    try {
      fd = fs.openSync(file, "r");
      const buffer = Buffer.alloc(HEAD_BYTES);
      const read = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
      return buffer.subarray(0, read);
    } catch {
      return Buffer.alloc(0);
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
  }

  async function versionNow() {
    const downloader = getDownloader();
    try {
      return (await downloader.isAvailable()) ? downloader.getVersion() || null : null;
    } catch {
      return null;
    }
  }

  /**
   * What the panel can know before the click. Informational: yt-dlp's own variant is not readable from its CLI, so
   * this is a heuristic from the file (a small python stub or a package-managed prefix cannot update itself).
   */
  async function inspect() {
    const version = await versionNow();
    const file = resolveBinary();
    if (!file) return { selfUpdatable: "missing", version, hint: null };

    let real = file;
    try {
      real = fs.realpathSync(file);
    } catch {
      // keep the path as found
    }
    const writableFile = (() => {
      try {
        fs.accessSync(real, nodeFs.constants.W_OK);
        fs.accessSync(path.dirname(real), nodeFs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    })();
    if (!writableFile) return { selfUpdatable: "no", reason: "read_only", version, hint: hintFor(real, "read_only") };

    let size = 0;
    try {
      size = fs.statSync(real).size;
    } catch {
      // unreadable: treated as unknown below
    }
    const bytes = head(real);
    const isElf = bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
    const isScript = bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21; // "#!"
    const smallStub = isScript && size > 0 && size < STUB_MAX_BYTES;
    const packaged = PACKAGE_PREFIXES.some((prefix) => file.startsWith(prefix)) && size < BIG_BINARY_BYTES;
    const managed = !isElf && (smallStub || packaged);
    if (managed) return { selfUpdatable: "no", reason: "package_managed", version, hint: hintFor(real, "managed") };
    return { selfUpdatable: "likely", version, hint: null };
  }

  /** Run `<binary> -U`; resolves `{ ok, stderr }`, never rejects */
  function runSelfUpdate() {
    return new Promise((resolve) => {
      const started = Date.now();
      exec()(commandOf(), ["-U"], { timeout: UPDATE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, env: { ...env, NO_COLOR: "1", PYTHONIOENCODING: "utf-8" }, windowsHide: true }, (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, stderr: "" });
        const timedOut = Boolean(error.killed) && Date.now() - started >= UPDATE_TIMEOUT_MS - 1000;
        resolve({ ok: false, code: error.code, timedOut, stderr: String(stderr || ""), message: String(error.message || "") });
      });
    });
  }

  /** Failure verdict from stderr, only inspected (an unknown failure is `failed`) */
  function classify(run) {
    if (run.timedOut) return "unreachable";
    const text = `${run.stderr}\n${run.message}`;
    if (MANAGED_RE.test(text)) return "managed_externally";
    if (READ_ONLY_RE.test(text) && !NETWORK_RE.test(run.stderr)) return "read_only";
    if (NETWORK_RE.test(text)) return "unreachable";
    return "failed";
  }

  /**
   * Run `yt-dlp -U` and decide from the versions. Never rejects.
   * @param {{ onProgress?: (event: { phase: string }) => any }} [opts]
   * @returns {Promise<{ outcome: string, before: string|null, after: string|null }>}
   */
  async function update({ onProgress } = {}) {
    const downloader = getDownloader();
    const progress = async (phase) => {
      if (typeof onProgress !== "function") return;
      try {
        await onProgress({ phase });
      } catch {
        // a progress listener never breaks the update
      }
    };

    if (updating || downloader.getActiveDownloads() > 0) {
      const version = downloader.getVersion(); // what is cached: a busy answer never starts a process
      return { outcome: "busy", before: version, after: version };
    }

    updating = true; // before the first await: two callers cannot both get past the check above
    try {
      downloader.resetCache(); // the cached version may predate a manual update
      const before = await versionNow();
      if (before === null) {
        // not available: nothing to update (a missing binary), or it does not answer
        return { outcome: "missing", before: null, after: null };
      }

      let run;
      downloader.setMaintenance(true);
      try {
        await progress("update");
        run = await runSelfUpdate();
      } finally {
        downloader.setMaintenance(false);
      }

      // the version on each side is the verdict; the exit status only tells apart "nothing newer" from a failure
      downloader.resetCache();
      const after = await versionNow();

      let outcome;
      if (after && after !== before) outcome = "updated";
      else if (run.ok) outcome = "up_to_date";
      else {
        outcome = classify(run);
        logger.warn({ outcome, code: run.code, timedOut: run.timedOut || undefined, stderr: run.stderr.slice(-500) }, "yt-dlp self-update did not succeed");
      }
      return { outcome, before, after: after || before };
    } finally {
      updating = false;
    }
  }

  return {
    inspect,
    update,
    /** the command name (never the configured path), for the panel */
    command: () => path.basename(commandOf()),
    isUpdating: () => updating,
  };
}

const defaultYtdlpUpdate = createYtdlpUpdate();

module.exports = defaultYtdlpUpdate;
module.exports.createYtdlpUpdate = createYtdlpUpdate;
