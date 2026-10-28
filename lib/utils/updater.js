"use strict";

/**
 * Self-update of the bot from its git checkout (specs/002-admin-panel: contracts/runtime.md section 11, research
 * D1 and U6; FR-054). Shared by the panel (lib/admin/services/maintenance.js) and the `.update` command
 * (plugins/update.js): one engine, one process-wide lock.
 *
 *   const updater = require("./updater");                     the default singleton, or createUpdater({...})
 *   await updater.getInstallInfo()   -> { type: "git"|"image"|"archive", canSelfUpdate, blockers, branch, upstream,
 *                                         supervised, supervisor }
 *   await updater.check({ force })   -> { behind, ahead, localVersion, remoteVersion, commits: [{ hash, subject }],
 *                                         checkedAt, blockers, installType, upstream }       (throws UpdaterError)
 *   await updater.apply({ onProgress, actor })
 *                                    -> { ok, from, to, phase, reason, rolledBack, ... }       (never throws)
 *   updater.restartRequired()        -> { required, from, to, reason }                          (sync, derived)
 *   updater.scheduleExit()           -> { scheduled }   supervised: process.exit(0) about 1 s later
 *   updater.startChecker(client) / stop()
 *   updater.lastCheck() / lastApply() / isBusy() / localVersion()
 *
 * INSTALL TYPE. `rootDir` is `path.resolve(__dirname, "..", "..")`, never `process.cwd()`. `git` = a `.git` in
 * `rootDir` whose `rev-parse --show-toplevel` is `rootDir`; without `.git` the install is an `image` (container
 * marker) or an `archive` (ZIP upload). Those two only get instructions. A git install can still be blocked, with
 * one code each: `no_git_binary`, `dubious_ownership`, `detached`, `no_remote_branch` (the branch has no upstream
 * and no `origin/<branch>`: this is not a network failure), `dirty_tree` (tracked changes only, untracked files
 * never block) and `not_writable`.
 *
 * BRANCH RULE. The upstream of the checked-out branch (`branch.<b>.remote` + `branch.<b>.merge`), else
 * `origin/<current branch>`. Never `config.BRANCH`, never a branch switch.
 *
 * APPLY, under one lock (`busy` for the second caller), recording `prevHead`:
 *   fetch  -> `git fetch <remote> <branch>`, the commit is pinned (rev-parse FETCH_HEAD) so the commits that were
 *             listed are the ones applied; nothing behind = `upToDate`
 *   merge  -> `git merge --ff-only <sha>` (a diverged history fails here)
 *   install-> the vendored Yarn (`process.execPath <yarnPath> install --immutable`, 5 min) ONLY when package.json,
 *             yarn.lock, .yarnrc.yml or .yarn/releases/* changed
 *   verify -> `process.execPath tools/verify-boot.js` in a child (in-memory database, 60 s)
 * Any failure after the fetch: `git reset --hard prevHead` (the tree was clean and the merge fast-forward only),
 * the install is repeated when it had run, and the answer is `{ ok: false, phase, reason, rolledBack }`. Raw git,
 * yarn and smoke output only goes to the logs (credentials in URLs stripped), never to the caller.
 *
 * RESTART. The in-process restart reloads settings, not code, so a new process is needed. `restartRequired()` is
 * derived (HEAD read at the first use differs from the HEAD on disk now, or the package.json version on disk
 * differs from the running one), so a manual `git pull` is caught too. Supervised (PM2, a panel host,
 * SUPERVISED=true): the caller answers first, then `scheduleExit()` ends the process about 1 s later.
 * Unsupervised (U6): nothing exits; the panel shows "restart the program to finish" until the process restarts.
 *
 * CHECKER. `startChecker(client)` (called by bootstrap; idempotent, `unref`'d, `stop()` clears it) runs the first
 * check 2 minutes after the first `ready`, then every 6 h with jitter, unless UPDATE_CHECK=false. It raises
 * `alerts.raise("update_available", { version })` once per remote version greater than the local one; a commit
 * without a version bump only shows a badge. Images and archives read the `package.json` of the repository's
 * master once per cycle.
 *
 * TEST SEAMS. Every collaborator is an option: `git` (factory `(baseDir) => simple-git instance`), `run`
 * (`(command, args, { cwd, env, timeout }) -> { stdout, stderr }`, for Yarn and the smoke boot), `env`, `fs`,
 * `clock`, `timers`, `rootDir`, `config`, `alerts`, `fetchJson`, `exit`, `random`, `enabled`. Nothing here runs at
 * require time and no timer exists before `startChecker()`.
 */

const nodeFs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { safeLog } = require("./http");
const runtimeInfo = require("./runtime");

const logger = require("./logger").createLogger("updater");

const GIT_TIMEOUT_MS = 120 * 1000; // per git process, reset on output (simple-git "block" timeout)
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const SMOKE_TIMEOUT_MS = 60 * 1000;
const EXIT_DELAY_MS = 1000;
const FIRST_CHECK_MS = 2 * 60 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const CHECK_JITTER = 0.1; // +-10 % on the 6 h period
const CHECK_CACHE_MS = 60 * 1000; // a non-forced check inside this window answers from memory
const COMMITS_SHOWN = 50;
const OUTPUT_TAIL = 4000; // chars of a child's output kept for the logs
const REMOTE_PACKAGE_URL = "https://raw.githubusercontent.com/Starland9/OpenWhatsappBot/master/package.json";

const DEPENDENCY_FILES = new Set(["package.json", "yarn.lock", ".yarnrc.yml"]);
const YARN_RELEASES = ".yarn/releases/";
const VERSION_RE = /^\d+\.\d+\.\d+/;
const SHA_RE = /^[0-9a-f]{40,64}$/;

/** Blockers that make a fetch pointless: the git side cannot answer at all */
const FATAL_BLOCKERS = ["no_git_binary", "dubious_ownership", "detached", "no_remote_branch"];

/** Typed error: stable snake_case `code`, `params.reason` for the panel; the message is for logs only. */
class UpdaterError extends Error {
  constructor(code, params = {}) {
    super(params.reason ? `${code}: ${params.reason}` : code);
    this.name = "UpdaterError";
    this.code = code;
    this.params = params;
  }
}

/** `major.minor.patch` (extra suffixes ignored) -> [major, minor, patch], or null */
function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** -1, 0, 1; null when either is not a version */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

/** Log-safe view of an error: no credentials embedded in remote URLs (https://user:token@host) */
function logSafe(err) {
  const info = safeLog(err);
  return { ...info, message: String(info.message).replace(/\/\/[^@\s/]+@/g, "//***@") };
}

/** Strip credentials from a block of child output before it is logged */
const scrubOutput = (text) => String(text || "").replace(/\/\/[^@\s/]+@/g, "//***@").slice(-OUTPUT_TAIL);

/**
 * Run a command without a shell. Rejects with a short message; the output stays on `err.stderr` for the logs
 * only. `timeout` kills the child (`err.timedOut`).
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function execCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      timeout: options.timeout,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (data) => {
      stdout = (stdout + data.toString()).slice(-OUTPUT_TAIL);
    });
    proc.stderr?.on("data", (data) => {
      stderr = (stderr + data.toString()).slice(-OUTPUT_TAIL);
    });
    proc.on("error", reject);
    proc.on("close", (code, signal) => {
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${path.basename(String(command))} exited with ${code ?? signal}`);
      err.code = code;
      err.stderr = stderr;
      err.stdout = stdout;
      err.timedOut = Boolean(options.timeout) && signal === "SIGKILL" && Date.now() - started >= options.timeout - 1000;
      reject(err);
    });
  });
}

/**
 * What git needs from the process environment (a whitelist): where to find it and the user's own configuration,
 * proxies and certificates. Everything else stays out: simple-git refuses guarded variables set explicitly (GIT_*,
 * and PREFIX, which the bot's own config.env defines), and git has no use for the bot's keys.
 */
const GIT_ENV_KEEP = [
  "PATH", "Path", "PATHEXT", "HOME", "USER", "LOGNAME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "SYSTEMROOT", "SystemRoot", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "SSH_AUTH_SOCK",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE",
];

/** Environment of the git processes: the whitelist above, never a prompt, English messages */
function gitEnvironment(env) {
  const out = {};
  for (const key of GIT_ENV_KEEP) if (typeof (env || {})[key] === "string") out[key] = env[key];
  out.GIT_TERMINAL_PROMPT = "0";
  out.LC_ALL = "C"; // the classification below reads git's messages
  out.LANGUAGE = "C";
  return out;
}

/** Default git driver: simple-git on `baseDir` (a factory, so a test can inject any `raw()` provider) */
function defaultGit(env) {
  return (baseDir) => {
    const { simpleGit } = require("simple-git");
    return simpleGit({ baseDir, timeout: { block: GIT_TIMEOUT_MS }, allowEnvironment: ["GIT_TERMINAL_PROMPT"] }).env(gitEnvironment(env));
  };
}

/**
 * Reason code of a failed git command. The text is only inspected, never forwarded (LC_ALL=C keeps it English).
 * @returns {"no_git_binary"|"dubious_ownership"|"no_remote_branch"|"network"|"diverged"|"error"}
 */
function classifyGitError(err) {
  const text = `${(err && err.message) || ""} ${(err && err.stderr) || ""}`;
  if ((err && err.code === "ENOENT") || /spawn git ENOENT|git: (command )?not found|ENOENT/i.test(text)) return "no_git_binary";
  if (/dubious ownership|safe\.directory/i.test(text)) return "dubious_ownership";
  if (/couldn't find remote ref|could not find remote ref|no such remote ref/i.test(text)) return "no_remote_branch";
  if (/not possible to fast-forward|cannot fast-forward|diverging|not a fast-forward|refusing to merge/i.test(text)) return "diverged";
  if (
    /could not resolve host|unable to access|could not read from remote|does not appear to be a git repository|network is unreachable|connection (timed out|refused|reset)|timed out|timeout|ssl|early eof|remote end hung up|authentication failed|repository not found|failed to connect|no route to host/i.test(
      text,
    )
  ) {
    return "network";
  }
  return "error";
}

/**
 * @param {object} [options] see the header (TEST SEAMS)
 */
function createUpdater(options = {}) {
  const fs = options.fs || nodeFs;
  const env = options.env || process.env;
  const rootDir = options.rootDir || path.resolve(__dirname, "..", "..");
  const clock = options.clock || { now: () => Date.now() };
  const timers = options.timers || { setTimeout, clearTimeout };
  const now = () => clock.now();
  const run = options.run || execCommand;
  const makeGit = options.git || defaultGit(env);
  const exit = options.exit || ((code) => process.exit(code));
  const random = options.random || Math.random;

  const getConfig = () => options.config || require("../../config");
  const updateCheckEnabled = () => {
    if (options.enabled !== undefined) return options.enabled !== false;
    try {
      return getConfig().UPDATE_CHECK !== false;
    } catch {
      return true;
    }
  };

  // ---- state ---------------------------------------------------------------------------------------

  let applying = false; // the process-wide lock
  let checking = null; // single flight of check()
  let last = null; // { atMs, result } of the last successful check
  let lastApplied = null; // summary of the last apply attempt
  let boot = null; // { head, version } read at the first use
  let announcedVersion = null;
  let checker = null; // { client, timer, onReady }
  let exitTimer = null;

  const git = async (args) => String(await makeGit(rootDir).raw(args));

  // ---- versions and HEAD (sync: restartRequired is read by the dashboard state) ----------------------

  function readDiskVersion() {
    try {
      const version = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")).version;
      return typeof version === "string" && VERSION_RE.test(version) ? version : null;
    } catch {
      return null;
    }
  }

  function runningVersion() {
    try {
      const version = getConfig().VERSION;
      return typeof version === "string" && version ? version : readDiskVersion();
    } catch {
      return readDiskVersion();
    }
  }

  /** HEAD commit read from .git without spawning git (worktrees and packed refs handled) */
  function readHeadSync() {
    try {
      const dotGit = path.join(rootDir, ".git");
      let gitDir = dotGit;
      if (fs.statSync(dotGit).isFile()) {
        const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
        if (!match) return null;
        gitDir = path.resolve(rootDir, match[1].trim());
      }
      const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      if (!head.startsWith("ref:")) return SHA_RE.test(head) ? head : null;
      const ref = head.slice(4).trim();
      let commonDir = gitDir;
      try {
        commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
      } catch {
        // a plain repository has no commondir
      }
      for (const dir of new Set([gitDir, commonDir])) {
        try {
          const value = fs.readFileSync(path.join(dir, ref), "utf8").trim();
          if (SHA_RE.test(value)) return value;
        } catch {
          // maybe packed
        }
      }
      for (const line of fs.readFileSync(path.join(commonDir, "packed-refs"), "utf8").split("\n")) {
        const match = /^([0-9a-f]{40,64}) (.+)$/.exec(line.trim());
        if (match && match[2] === ref) return match[1];
      }
    } catch {
      // not a git checkout
    }
    return null;
  }

  /** Remember the code that is running: the first call wins (bootstrap, or the first thing that asks) */
  function captureBoot() {
    if (!boot) boot = { head: readHeadSync(), version: runningVersion() };
    return boot;
  }

  const localVersion = () => readDiskVersion() || runningVersion();

  function restartRequired() {
    const started = captureBoot();
    const head = readHeadSync();
    const disk = readDiskVersion();
    const versionChanged = Boolean(disk && started.version && disk !== started.version);
    const headChanged = Boolean(head && started.head && head !== started.head);
    if (!versionChanged && !headChanged) return { required: false, from: null, to: null, reason: null };
    return {
      required: true,
      from: versionChanged ? started.version : started.head.slice(0, 7),
      to: versionChanged ? disk : head.slice(0, 7),
      reason: versionChanged ? "version" : "head",
    };
  }

  // ---- install type ---------------------------------------------------------------------------------

  function supervision() {
    const info = runtimeInfo.detectSupervisor({ env, fs });
    return { supervised: info.supervised, supervisor: info.kind };
  }

  const exists = (target) => {
    try {
      return fs.existsSync(target);
    } catch {
      return false;
    }
  };

  const writable = (target) => {
    try {
      fs.accessSync(target, nodeFs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };

  const realpath = (target) => {
    try {
      return fs.realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  };

  /** Everything known about the install, internal fields included (`remote`, `remoteBranch`) */
  async function inspect() {
    const base = { type: "git", canSelfUpdate: false, blockers: [], branch: null, upstream: null, remote: null, remoteBranch: null, ...supervision() };
    const notGit = () => {
      const type = runtimeInfo.isContainer({ fs, env }) ? "image" : "archive";
      return { ...base, type, blockers: [type] };
    };

    if (!exists(path.join(rootDir, ".git"))) return notGit();

    try {
      await git(["--version"]);
    } catch {
      return { ...base, blockers: ["no_git_binary"] };
    }

    let toplevel;
    try {
      toplevel = (await git(["rev-parse", "--show-toplevel"])).trim();
    } catch (err) {
      if (classifyGitError(err) === "dubious_ownership") return { ...base, blockers: ["dubious_ownership"] };
      logger.warn(logSafe(err), "git does not answer in the install directory");
      return notGit();
    }
    if (!toplevel || realpath(toplevel) !== realpath(rootDir)) return notGit();

    const blockers = [];
    let branch = null;
    try {
      const name = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      if (name && name !== "HEAD") branch = name;
    } catch {
      // an unborn branch reads as detached
    }
    if (!branch) {
      blockers.push("detached");
    } else {
      // upstream of the branch, else origin/<branch>; a local-only upstream ("." ) is no remote
      let remote = (await git(["config", `branch.${branch}.remote`]).catch(() => "")).trim();
      let merge = (await git(["config", `branch.${branch}.merge`]).catch(() => "")).trim().replace(/^refs\/heads\//, "");
      if (!remote || !merge || remote === ".") {
        remote = "origin";
        merge = branch;
        const known = (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).catch(() => "")).trim();
        if (!known) blockers.push("no_remote_branch");
      }
      base.remote = remote;
      base.remoteBranch = merge;
      base.upstream = `${remote}/${merge}`;
    }

    try {
      if ((await git(["status", "--porcelain", "--untracked-files=no"])).trim()) blockers.push("dirty_tree");
    } catch (err) {
      logger.warn(logSafe(err), "git status failed");
    }
    if (!writable(rootDir) || !writable(path.join(rootDir, ".git"))) blockers.push("not_writable");

    return { ...base, branch, blockers, canSelfUpdate: blockers.length === 0 };
  }

  const publicInfo = ({ type, canSelfUpdate, blockers, branch, upstream, supervised, supervisor }) => ({
    type,
    canSelfUpdate,
    blockers: [...blockers],
    branch,
    upstream,
    supervised,
    supervisor,
  });

  async function getInstallInfo() {
    captureBoot();
    return publicInfo(await inspect());
  }

  // ---- check ----------------------------------------------------------------------------------------

  /** `git fetch` of the upstream, pinned to a commit: { sha, ahead, behind } */
  async function fetchRemote(info) {
    await git(["fetch", info.remote, info.remoteBranch]);
    const sha = (await git(["rev-parse", "FETCH_HEAD"])).split("\n")[0].trim();
    if (!SHA_RE.test(sha)) throw new Error("FETCH_HEAD is not a commit");
    const counts = (await git(["rev-list", "--left-right", "--count", `HEAD...${sha}`])).trim().split(/\s+/).map(Number);
    return { sha, ahead: counts[0] || 0, behind: counts[1] || 0 };
  }

  async function remoteVersionOf(sha) {
    try {
      const version = JSON.parse(await git(["show", `${sha}:package.json`])).version;
      return typeof version === "string" && VERSION_RE.test(version) ? version : null;
    } catch {
      return null;
    }
  }

  async function commitsBetween(sha) {
    try {
      const out = await git(["log", "--no-decorate", "--format=%h%x09%s", "-n", String(COMMITS_SHOWN), `HEAD..${sha}`]);
      return out
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf("\t");
          return { hash: line.slice(0, tab), subject: line.slice(tab + 1).slice(0, 200) };
        });
    } catch {
      return [];
    }
  }

  const checkFailed = (reason, err) => {
    if (err) logger.warn({ ...logSafe(err), reason }, "update check failed");
    return new UpdaterError("update_check_failed", { reason });
  };

  async function doCheck() {
    const info = await inspect();
    const checkedAt = new Date(now()).toISOString();
    const local = localVersion();
    const header = { installType: info.type, upstream: info.upstream, checkedAt, localVersion: local };

    if (info.type !== "git") {
      // image / archive: instructions only; the remote version is one read of the repository's package.json
      let remoteVersion = null;
      if (updateCheckEnabled()) {
        try {
          const fetchJson = options.fetchJson || require("./http").fetchJson;
          const data = await fetchJson(REMOTE_PACKAGE_URL, { timeoutMs: 15000, maxBytes: 200 * 1024 });
          remoteVersion = data && typeof data.version === "string" && VERSION_RE.test(data.version) ? data.version : null;
        } catch (err) {
          throw checkFailed("unreachable", err);
        }
      }
      return { ...header, behind: 0, ahead: 0, remoteVersion, commits: [], blockers: info.blockers };
    }

    const fatal = info.blockers.find((code) => FATAL_BLOCKERS.includes(code));
    if (fatal) throw checkFailed(fatal);

    let fetched;
    try {
      fetched = await fetchRemote(info);
    } catch (err) {
      const kind = classifyGitError(err);
      throw checkFailed(kind === "network" || kind === "error" || kind === "diverged" ? "unreachable" : kind, err);
    }
    const [remoteVersion, commits] = await Promise.all([remoteVersionOf(fetched.sha), fetched.behind > 0 ? commitsBetween(fetched.sha) : []]);
    return { ...header, behind: fetched.behind, ahead: fetched.ahead, remoteVersion, commits, blockers: info.blockers };
  }

  /**
   * Is a newer version on the remote? Read-only (a fetch). `force` skips the 60 s answer kept in memory.
   * @throws {UpdaterError} code `update_check_failed`, `params.reason`: no_git_binary, dubious_ownership, detached,
   *   no_remote_branch, unreachable, busy
   */
  async function check({ force = false } = {}) {
    captureBoot();
    if (!force && last && now() - last.atMs < CHECK_CACHE_MS) return last.result;
    if (applying) throw new UpdaterError("update_check_failed", { reason: "busy" });
    if (!checking) {
      checking = doCheck()
        .then((result) => {
          last = { atMs: now(), result };
          return result;
        })
        .finally(() => {
          checking = null;
        });
    }
    return checking;
  }

  // ---- apply ----------------------------------------------------------------------------------------

  /** The vendored Yarn named by .yarnrc.yml (read after the merge), else the `yarn` on PATH */
  function yarnCommand() {
    try {
      const yml = fs.readFileSync(path.join(rootDir, ".yarnrc.yml"), "utf8");
      const match = /^yarnPath:\s*["']?([^"'\s#]+)/m.exec(yml);
      if (match) {
        const file = path.resolve(rootDir, match[1]);
        if (file.startsWith(rootDir + path.sep) && exists(file)) return { command: process.execPath, args: [file, "install", "--immutable"] };
      }
    } catch {
      // no .yarnrc.yml
    }
    return { command: "yarn", args: ["install", "--immutable"] };
  }

  const runInstall = () => {
    const { command, args } = yarnCommand();
    return run(command, args, { cwd: rootDir, env: { ...env }, timeout: INSTALL_TIMEOUT_MS });
  };

  const runSmokeBoot = () =>
    run(process.execPath, [path.join(rootDir, "tools", "verify-boot.js")], {
      cwd: rootDir,
      env: { ...env, DATABASE_URL: ":memory:", LOG_LEVEL: "silent", ADMIN_PANEL: "false", UPDATE_CHECK: "false" },
      timeout: SMOKE_TIMEOUT_MS,
    });

  const dependenciesChanged = (names) =>
    names.some((name) => DEPENDENCY_FILES.has(name) || name.startsWith(YARN_RELEASES));

  /** `git diff --numstat` summary of the update: { files, insertions, deletions } */
  async function diffStats(from, to) {
    try {
      const rows = (await git(["diff", "--numstat", from, to])).split("\n").filter(Boolean);
      let insertions = 0;
      let deletions = 0;
      for (const row of rows) {
        const [added, removed] = row.split("\t");
        insertions += Number(added) || 0;
        deletions += Number(removed) || 0;
      }
      return { files: rows.length, insertions, deletions };
    } catch {
      return { files: 0, insertions: 0, deletions: 0 };
    }
  }

  /**
   * Fetch, fast-forward, install if the dependencies changed, smoke-boot the new code, roll back on any failure.
   * Never throws: the answer is `{ ok, from, to, phase, reason, rolledBack, ... }`.
   *   ok:true   from, to (versions), fromHead, toHead, upToDate, stats, restartRequired, willRestart, phase "done"
   *   ok:false  from, to (remote version when known), phase (fetch|merge|install|verify), reason (unavailable, busy,
   *             no_remote_branch, dubious_ownership, network, diverged, merge_failed, install_failed, smoke_failed),
   *             rolledBack, blockers (reason unavailable)
   * @param {{ onProgress?: (event: { phase: string }) => any, actor?: string }} [opts] `onProgress` gets
   *   `{ phase }` for fetch, merge, install, verify, then done or failed; it can never fail the update.
   */
  async function apply({ onProgress, actor } = {}) {
    captureBoot();
    const progress = async (phase) => {
      if (typeof onProgress !== "function") return;
      try {
        await onProgress({ phase });
      } catch {
        // a progress listener never breaks an update
      }
    };
    const failure = (phase, reason, extra = {}) => ({ ok: false, from: extra.from ?? localVersion(), to: extra.to ?? null, phase, reason, rolledBack: false, ...extra });

    if (applying) return failure("fetch", "busy");
    applying = true;
    let phase = "fetch";
    let prevHead = null;
    let installRan = false;
    let target = null;
    const fromVersion = localVersion();
    try {
      const info = await inspect();
      if (!info.canSelfUpdate) {
        const out = failure("fetch", "unavailable", { blockers: [...info.blockers] });
        await progress("failed");
        return out;
      }

      prevHead = (await git(["rev-parse", "HEAD"])).trim();
      await progress("fetch");
      let fetched;
      try {
        fetched = await fetchRemote(info);
      } catch (err) {
        const kind = classifyGitError(err);
        logger.warn({ ...logSafe(err), actor }, "update: fetch failed");
        const out = failure("fetch", kind === "no_remote_branch" || kind === "dubious_ownership" ? kind : "network");
        await progress("failed");
        return out;
      }
      target = await remoteVersionOf(fetched.sha);

      if (fetched.behind === 0) {
        lastApplied = { ok: true, from: fromVersion, to: fromVersion, at: new Date(now()).toISOString(), phase: "done", reason: null, rolledBack: false, upToDate: true };
        await progress("done");
        return { ok: true, from: fromVersion, to: fromVersion, fromHead: prevHead, toHead: prevHead, upToDate: true, phase: "done", reason: null, rolledBack: false, stats: { files: 0, insertions: 0, deletions: 0 }, restartRequired: restartRequired().required, willRestart: false };
      }

      phase = "merge";
      await progress("merge");
      await git(["merge", "--ff-only", fetched.sha]);
      const changed = (await git(["diff", "--name-only", prevHead, "HEAD"])).split("\n").map((name) => name.trim()).filter(Boolean);

      if (dependenciesChanged(changed)) {
        phase = "install";
        await progress("install");
        installRan = true; // a failed install may have half-written node_modules: the rollback repeats it
        await runInstall();
      }

      phase = "verify";
      await progress("verify");
      await runSmokeBoot();

      const toHead = (await git(["rev-parse", "HEAD"])).trim();
      const stats = await diffStats(prevHead, toHead);
      const toVersion = localVersion();
      const { supervised } = supervision();
      lastApplied = { ok: true, from: fromVersion, to: toVersion, at: new Date(now()).toISOString(), phase: "done", reason: null, rolledBack: false, upToDate: false };
      logger.info({ from: fromVersion, to: toVersion, actor }, "update applied");
      last = null; // what the last check listed has just been applied
      await progress("done");
      return { ok: true, from: fromVersion, to: toVersion, fromHead: prevHead, toHead, upToDate: false, phase: "done", reason: null, rolledBack: false, stats, restartRequired: true, willRestart: supervised };
    } catch (err) {
      const kind = classifyGitError(err);
      const reason =
        phase === "install" ? "install_failed" : phase === "verify" ? "smoke_failed" : phase === "merge" ? (kind === "diverged" ? "diverged" : "merge_failed") : "network";
      logger.error({ ...logSafe(err), phase, reason, stderr: scrubOutput(err && err.stderr), actor }, "update failed");

      // back to the version we started from: the tree was clean and the merge fast-forward only
      let rolledBack = false;
      if (prevHead && phase !== "fetch") {
        try {
          await git(["reset", "--hard", prevHead]);
          rolledBack = true;
        } catch (resetErr) {
          logger.error(logSafe(resetErr), "update rollback failed");
        }
        if (rolledBack && installRan) {
          try {
            await runInstall();
          } catch (installErr) {
            logger.error({ ...logSafe(installErr), stderr: scrubOutput(installErr && installErr.stderr) }, "update rollback: the dependencies could not be restored");
          }
        }
      }
      lastApplied = { ok: false, from: fromVersion, to: target, at: new Date(now()).toISOString(), phase, reason, rolledBack, upToDate: false };
      await progress("failed");
      return failure(phase, reason, { to: target, rolledBack });
    } finally {
      applying = false;
    }
  }

  /**
   * After a successful `apply` answered: a supervised process ends about 1 s later so its supervisor starts the new
   * code; an unsupervised one (U6) keeps running and `restartRequired()` asks for a manual restart.
   * @returns {{ scheduled: boolean }}
   */
  function scheduleExit() {
    if (!supervision().supervised) return { scheduled: false };
    if (exitTimer) return { scheduled: true };
    exitTimer = timers.setTimeout(() => {
      exitTimer = null;
      exit(0);
    }, EXIT_DELAY_MS);
    if (exitTimer && typeof exitTimer.unref === "function") exitTimer.unref();
    return { scheduled: true };
  }

  // ---- checker --------------------------------------------------------------------------------------

  function alertsEngine() {
    if (options.alerts) return options.alerts;
    try {
      return require("./alerts");
    } catch (err) {
      const missing = err && err.code === "MODULE_NOT_FOUND" && String(err.message).includes("'./alerts'");
      if (!missing) logger.warn(logSafe(err), "alerts engine could not be loaded");
      return null;
    }
  }

  /** Raise the alert once per remote version greater than the local one */
  async function announce(result) {
    const remote = result && result.remoteVersion;
    if (!remote || compareVersions(remote, localVersion()) !== 1 || remote === announcedVersion) return false;
    const alerts = alertsEngine();
    if (!alerts || typeof alerts.raise !== "function") return false;
    announcedVersion = remote;
    try {
      await alerts.raise("update_available", { version: remote }, { now: now() });
    } catch (err) {
      logger.warn(logSafe(err), "update_available alert failed");
    }
    return true;
  }

  const isReady = (client) => {
    try {
      return Boolean(client && typeof client.ready === "function" && client.ready());
    } catch {
      return false;
    }
  };

  /** Start the periodic check (idempotent). Disabled by UPDATE_CHECK=false. */
  function startChecker(client) {
    if (checker) return false;
    captureBoot();
    if (!updateCheckEnabled()) return false;
    checker = { client, timer: null, onReady: null };
    const state = checker;

    const arm = (delay) => {
      if (checker !== state) return;
      state.timer = timers.setTimeout(tick, delay);
      if (state.timer && typeof state.timer.unref === "function") state.timer.unref();
    };
    const tick = async () => {
      state.timer = null;
      try {
        await announce(await check({ force: true }));
      } catch (err) {
        logger.info({ code: err && err.code, reason: err && err.params && err.params.reason }, "scheduled update check did not complete");
      }
      arm(Math.round(CHECK_EVERY_MS * (1 + (random() * 2 - 1) * CHECK_JITTER)));
    };

    if (isReady(client)) {
      arm(FIRST_CHECK_MS);
    } else if (client && typeof client.on === "function") {
      state.onReady = () => {
        if (client.off) client.off("ready", state.onReady);
        state.onReady = null;
        arm(FIRST_CHECK_MS);
      };
      client.on("ready", state.onReady);
    }
    return true;
  }

  function stop() {
    if (exitTimer) {
      timers.clearTimeout(exitTimer);
      exitTimer = null;
    }
    if (!checker) return;
    if (checker.timer) timers.clearTimeout(checker.timer);
    if (checker.onReady && checker.client && typeof checker.client.off === "function") checker.client.off("ready", checker.onReady);
    checker = null;
  }

  return {
    getInstallInfo,
    check,
    apply,
    restartRequired,
    scheduleExit,
    startChecker,
    stop,
    isBusy: () => applying,
    isChecking: () => checking !== null,
    lastCheck: () => (last ? last.result : null),
    lastApply: () => (lastApplied ? { ...lastApplied } : null),
    localVersion,
    /** the checker is armed (tests) */
    checkerRunning: () => checker !== null,
    CONSTANTS: Object.freeze({ FIRST_CHECK_MS, CHECK_EVERY_MS, EXIT_DELAY_MS, CHECK_CACHE_MS, SMOKE_TIMEOUT_MS, INSTALL_TIMEOUT_MS }),
  };
}

const defaultUpdater = createUpdater();

module.exports = defaultUpdater;
module.exports.createUpdater = createUpdater;
module.exports.UpdaterError = UpdaterError;
module.exports.compareVersions = compareVersions;
module.exports.classifyGitError = classifyGitError;
module.exports.REMOTE_PACKAGE_URL = REMOTE_PACKAGE_URL;
