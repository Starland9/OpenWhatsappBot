"use strict";
/**
 * Fake executables and an injectable `run` for the maintenance tests (contracts/runtime.md section 16).
 *
 * createFakeRun(): the `run(command, args, options)` the updater takes for Yarn and the smoke boot.
 *   const fake = createFakeRun();
 *   updater = createUpdater({ run: fake.run, ... });
 *   fake.calls                      [{ kind: "install" | "smoke" | "other", command, args, cwd, env, timeout }]
 *   fake.of("install")              the calls of one kind
 *   fake.failInstall = true         the next installs reject (like `yarn install --immutable` failing)
 *   fake.failSmoke = true           the smoke boot rejects (like tools/verify-boot.js exiting 1)
 *   fake.onInstall = (call) => ...  / fake.onSmoke  optional hooks (sync or async; a throw is a failure)
 *   Failures carry a `stderr` with a sentinel (`FAKE_STDERR`) the tests look for in the answers and the logs.
 *
 * createFakeBin(): a temporary directory of POSIX shell scripts, nothing else needed to run them.
 *   const bin = createFakeBin({ ytdlpVersion: "2024.04.09" });
 *   bin.ytdlp                       path of the fake yt-dlp ( --version prints the version, -U follows a scenario )
 *   bin.setScenario("update:2025.01.01" | "same" | "misleading" | "managed" | "readonly" | "network" | "fail")
 *   bin.ytdlpVersion()              the version file; bin.updateCalls()  number of `-U` runs
 *   bin.gitDubious                  a `git` shim: --version works, everything else says "dubious ownership"
 *   bin.yarn                        a `yarn` shim that logs its arguments to bin.yarnLog()
 *   bin.cleanup()
 *
 * createFakeDownloader(bin): the slice of lib/utils/downloader.js that ytdlpUpdate uses (isAvailable / getVersion /
 * resetCache / getActiveDownloads / setMaintenance), reading the version from the fake binary like the real one reads
 * it from yt-dlp, with the same "cached until resetCache()" behaviour. `.maintenanceLog` records every
 * setMaintenance() call; `.active` is the number of downloads "running".
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const FAKE_STDERR = "FAKE-STDERR-SENTINEL: /home/owner/secret-place token=abc123";

function createFakeRun() {
  const fake = {
    calls: [],
    failInstall: false,
    failSmoke: false,
    onInstall: null,
    onSmoke: null,
    of: (kind) => fake.calls.filter((call) => call.kind === kind),
  };

  const kindOf = (command, args) => {
    if (args.some((arg) => String(arg).endsWith("verify-boot.js"))) return "smoke";
    if (args.includes("install")) return "install";
    return "other";
  };

  const failure = (what) => {
    const err = new Error(`${what} exited with 1`);
    err.code = 1;
    err.stderr = FAKE_STDERR;
    return err;
  };

  fake.run = async (command, args = [], options = {}) => {
    const call = { kind: kindOf(command, args), command, args: [...args], cwd: options.cwd, env: options.env, timeout: options.timeout };
    fake.calls.push(call);
    if (call.kind === "install") {
      if (fake.onInstall) await fake.onInstall(call);
      if (fake.failInstall) throw failure("yarn");
    } else if (call.kind === "smoke") {
      if (fake.onSmoke) await fake.onSmoke(call);
      if (fake.failSmoke) throw failure("node");
    }
    return { stdout: "", stderr: "" };
  };
  return fake;
}

const YTDLP_SCRIPT = `#!/bin/sh
dir="$(dirname "$0")"
case "$1" in
  --version)
    cat "$dir/ytdlp-version"
    exit 0
    ;;
  -U)
    echo "$@" >> "$dir/ytdlp-calls"
    scenario="$(cat "$dir/ytdlp-scenario" 2>/dev/null || echo same)"
    case "$scenario" in
      update:*)
        v="\${scenario#update:}"
        printf '%s\\n' "$v" > "$dir/ytdlp-version"
        echo "Updated yt-dlp to stable@$v"
        exit 0
        ;;
      same)
        echo "yt-dlp is up to date"
        exit 0
        ;;
      misleading)
        echo "Updated yt-dlp to stable@2099.01.01 from stable@2024.04.09"
        exit 0
        ;;
      managed)
        echo "ERROR: You installed yt-dlp from a manual build or with a package manager; Use that to update" >&2
        echo "${FAKE_STDERR}" >&2
        exit 1
        ;;
      readonly)
        echo "ERROR: Unable to write to /usr/local/bin/yt-dlp; Permission denied" >&2
        echo "${FAKE_STDERR}" >&2
        exit 1
        ;;
      network)
        echo "ERROR: Unable to obtain version info (<urlopen error [Errno -3] Temporary failure in name resolution>)" >&2
        echo "${FAKE_STDERR}" >&2
        exit 1
        ;;
      fail)
        echo "ERROR: something nobody planned for" >&2
        echo "${FAKE_STDERR}" >&2
        exit 1
        ;;
    esac
    ;;
esac
exit 2
`;

const GIT_DUBIOUS_SCRIPT = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "git version 2.40.0"
  exit 0
fi
echo "fatal: detected dubious ownership in repository at '/srv/bot'" >&2
echo "To add an exception for this directory, call: git config --global --add safe.directory /srv/bot" >&2
exit 128
`;

const YARN_SCRIPT = `#!/bin/sh
dir="$(dirname "$0")"
echo "$@" >> "$dir/yarn-calls"
exit "$(cat "$dir/yarn-exit" 2>/dev/null || echo 0)"
`;

function createFakeBin({ ytdlpVersion = "2024.04.09", scenario = "same" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-fakebin-"));
  const put = (name, text) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text, { mode: 0o755 });
    return file;
  };
  const read = (name, fallback = "") => {
    try {
      return fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      return fallback;
    }
  };

  fs.writeFileSync(path.join(dir, "ytdlp-version"), `${ytdlpVersion}\n`);
  fs.writeFileSync(path.join(dir, "ytdlp-scenario"), scenario);
  const ytdlp = put("yt-dlp", YTDLP_SCRIPT);
  const gitDubiousDir = path.join(dir, "git-dubious");
  fs.mkdirSync(gitDubiousDir);
  fs.writeFileSync(path.join(gitDubiousDir, "git"), GIT_DUBIOUS_SCRIPT, { mode: 0o755 });

  return {
    dir,
    ytdlp,
    gitDubious: gitDubiousDir,
    yarn: put("yarn", YARN_SCRIPT),
    setScenario: (name) => fs.writeFileSync(path.join(dir, "ytdlp-scenario"), name),
    ytdlpVersion: () => read("ytdlp-version").trim(),
    updateCalls: () => read("ytdlp-calls").split("\n").filter(Boolean).length,
    yarnLog: () => read("yarn-calls").split("\n").filter(Boolean),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function createFakeDownloader(bin) {
  let cached = null; // { ok, version }
  const downloader = {
    active: 0,
    maintenance: false,
    maintenanceLog: [],
    resets: 0,
    async isAvailable() {
      if (!cached) {
        try {
          const version = execFileSync(bin.ytdlp, ["--version"], { encoding: "utf8" }).trim();
          cached = { ok: true, version };
        } catch {
          cached = { ok: false, version: null };
        }
      }
      return cached.ok;
    },
    getVersion: () => (cached && cached.ok ? cached.version : null),
    resetCache() {
      downloader.resets += 1;
      cached = null;
    },
    getActiveDownloads: () => downloader.active,
    setMaintenance(on) {
      downloader.maintenance = Boolean(on);
      downloader.maintenanceLog.push(Boolean(on));
    },
  };
  return downloader;
}

module.exports = { createFakeRun, createFakeBin, createFakeDownloader, FAKE_STDERR };
