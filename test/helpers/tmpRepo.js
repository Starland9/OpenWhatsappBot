"use strict";
/**
 * Temporary git repositories for the updater tests (contracts/runtime.md section 16; test/updater.test.js).
 *
 *   const repo = createTmpRepo({ version: "1.0.0" });
 *   repo.rootDir                     the "installation": a clone of the bare remote, tracking origin/master
 *   repo.remoteDir                   the bare remote (a local path: nothing touches the network)
 *   repo.devDir                      a second clone where "the maintainer" works
 *   repo.release({ version, files, message })   commit in devDir (bumping package.json when `version` is given)
 *                                    and push to the remote; returns the commit sha
 *   repo.commit({ dir, message, files, version })   commit without pushing (`dir` defaults to devDir)
 *   repo.push(dir?)                  push `dir` (default devDir) to origin master
 *   repo.localCommit({ message, files, version })   a commit in the installation (makes it ahead / diverged)
 *   repo.write(dir, file, text)      write a file (directories created)
 *   repo.git(dir, ...args)           run git in `dir`, returns trimmed stdout (throws on failure)
 *   repo.head(dir?)                  HEAD sha of `dir` (default: the installation)
 *   repo.versionOf(dir?)             package.json version in `dir`
 *   repo.cleanup()                   remove everything
 *
 * The installation also carries a `.yarnrc.yml` naming `.yarn/releases/yarn-test.cjs` (an empty file), so the
 * updater has a vendored Yarn to name; nothing ever runs it (the tests inject `run`).
 *
 * The helper never reads the user's git configuration (GIT_CONFIG_GLOBAL=/dev/null, no system config), signs
 * nothing and sets its own identity. Everything lives under fs.mkdtemp in the OS temp directory.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const BRANCH = "master";

function gitIn(dir, args) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=" + BRANCH, ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
  }).trim();
}

function write(dir, file, text) {
  const target = path.join(dir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

function createTmpRepo({ version = "1.0.0", files = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "owb-updater-"));
  const remoteDir = path.join(base, "remote.git");
  const devDir = path.join(base, "dev");
  const rootDir = path.join(base, "install");

  fs.mkdirSync(remoteDir);
  gitIn(remoteDir, ["init", "--bare", "-b", BRANCH]);
  gitIn(base, ["clone", "-q", remoteDir, devDir]);

  const packageJson = (v) => `${JSON.stringify({ name: "open-whatsapp-bot", version: v }, null, 2)}\n`;
  write(devDir, "package.json", packageJson(version));
  write(devDir, ".yarnrc.yml", "yarnPath: .yarn/releases/yarn-test.cjs\n");
  write(devDir, ".yarn/releases/yarn-test.cjs", "");
  write(devDir, "index.js", "// app\n");
  for (const [file, text] of Object.entries(files)) write(devDir, file, text);
  gitIn(devDir, ["add", "-A"]);
  gitIn(devDir, ["commit", "-q", "-m", "initial"]);
  gitIn(devDir, ["push", "-q", "origin", `HEAD:${BRANCH}`]);
  gitIn(base, ["clone", "-q", remoteDir, rootDir]);

  const repo = {
    base,
    remoteDir,
    devDir,
    rootDir,
    branch: BRANCH,
    git: (dir, ...args) => gitIn(dir, args),
    write,
    head: (dir = rootDir) => gitIn(dir, ["rev-parse", "HEAD"]),
    versionOf: (dir = rootDir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version,

    commit({ dir = devDir, message = "change", files: changes = {}, version: next } = {}) {
      if (next) write(dir, "package.json", packageJson(next));
      for (const [file, text] of Object.entries(changes)) write(dir, file, text);
      if (!next && !Object.keys(changes).length) write(dir, `note-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`, message);
      gitIn(dir, ["add", "-A"]);
      gitIn(dir, ["commit", "-q", "-m", message]);
      return gitIn(dir, ["rev-parse", "HEAD"]);
    },

    push(dir = devDir) {
      gitIn(dir, ["push", "-q", "origin", `HEAD:${BRANCH}`]);
    },

    release(options = {}) {
      const sha = repo.commit(options);
      repo.push(options.dir || devDir);
      return sha;
    },

    localCommit(options = {}) {
      return repo.commit({ ...options, dir: rootDir });
    },

    cleanup() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
  return repo;
}

module.exports = { createTmpRepo, BRANCH };
