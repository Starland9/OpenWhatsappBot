"use strict";
/**
 * lib/utils/updater.js (specs/002-admin-panel: contracts/runtime.md section 11, research D1 and U6; FR-054).
 *
 * Real git against temporary repositories (a bare remote and two clones in fs.mkdtemp, see test/helpers/tmpRepo.js);
 * Yarn and the smoke boot go through an injected `run` (test/helpers/fakeExec.js). No network, no yarn, and
 * nothing here ever points the updater at this repository: every updater gets an explicit `rootDir`.
 *
 *  - getInstallInfo(): git / image / archive and the blocker codes;
 *  - check(): behind, ahead, versions, commits, the 60 s memory, distinct failures;
 *  - apply(): ff-only merge on the upstream of the current branch, Yarn only when dependency files changed, the
 *    smoke boot, rollback with `reset --hard`, the single lock;
 *  - restartRequired() and the supervised / unsupervised end of an update (U6);
 *  - the checker: 2 minutes after ready, unref'd, off with UPDATE_CHECK=false, one alert per remote version.
 */

const { test, describe, afterEach, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createUpdater, compareVersions, UpdaterError, classifyGitError } = require("../lib/utils/updater");
const { createClock } = require("./helpers/fakeClock");
const { createTmpRepo } = require("./helpers/tmpRepo");
const { createFakeRun, createFakeBin, FAKE_STDERR } = require("./helpers/fakeExec");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const cleanups = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/** The process environment without anything that changes supervisor or container detection */
function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of ["container", "pm_id", "INVOCATION_ID", "SUPERVISED", "P_SERVER_UUID", "SERVER_MEMORY"]) delete env[key];
  return { ...env, ...extra };
}

/** `fs` that says "not in a container" whatever the machine running the tests */
function noContainerFs() {
  return {
    ...fs,
    existsSync: (p) => (p === "/.dockerenv" ? false : fs.existsSync(p)),
    readFileSync: (p, ...rest) => (p === "/proc/1/cgroup" ? "0::/user.slice\n" : fs.readFileSync(p, ...rest)),
  };
}

function newRepo(options) {
  const repo = createTmpRepo(options);
  cleanups.push(() => repo.cleanup());
  return repo;
}

/** An updater on `repo.rootDir` with fakes for everything that is not git */
function make(repo, options = {}) {
  const clock = options.clock || createClock();
  const fake = createFakeRun();
  const alerts = { calls: [], raise: async (type, payload) => (alerts.calls.push({ type, payload }), { queued: true }) };
  const exits = [];
  const updater = createUpdater({
    rootDir: repo.rootDir,
    run: fake.run,
    env: baseEnv({ SUPERVISED: "false" }),
    fs: noContainerFs(),
    clock,
    timers: clock.timers,
    config: { VERSION: repo.versionOf(), UPDATE_CHECK: true, ...(options.config || {}) },
    alerts,
    exit: (code) => exits.push(code),
    enabled: true,
    random: () => 0.5, // no jitter
    ...options.updater,
  });
  cleanups.push(() => updater.stop());
  return { updater, fake, alerts, exits, clock, repo };
}

// ---------------------------------------------------------------------------------------------------------------
describe("compareVersions", () => {
  test("numeric major.minor.patch, null for anything else", () => {
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
    assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
    assert.equal(compareVersions("1.9.9", "1.10.0"), -1);
    assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
    assert.equal(compareVersions("1.2.3-beta", "1.2.3"), 0);
    assert.equal(compareVersions("nope", "1.0.0"), null);
    assert.equal(compareVersions(undefined, "1.0.0"), null);
  });
});

describe("classifyGitError", () => {
  test("reads English git messages (LC_ALL=C) and never forwards them", () => {
    assert.equal(classifyGitError(new Error("fatal: couldn't find remote ref feature")), "no_remote_branch");
    assert.equal(classifyGitError(new Error("fatal: Not possible to fast-forward, aborting.")), "diverged");
    assert.equal(classifyGitError(new Error("fatal: unable to access 'https://x/': Could not resolve host: x")), "network");
    assert.equal(classifyGitError(new Error("fatal: detected dubious ownership in repository at '/srv'")), "dubious_ownership");
    assert.equal(classifyGitError(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })), "no_git_binary");
    assert.equal(classifyGitError(new Error("something else")), "error");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("getInstallInfo", () => {
  test("a clean clone that tracks origin/master can update itself", async () => {
    const { updater } = make(newRepo());
    const info = await updater.getInstallInfo();
    assert.equal(info.type, "git");
    assert.equal(info.canSelfUpdate, true);
    assert.deepEqual(info.blockers, []);
    assert.equal(info.branch, "master");
    assert.equal(info.upstream, "origin/master");
    assert.equal(info.supervised, false);
  });

  test("dirty_tree counts tracked changes only, untracked files never block", async () => {
    const repo = newRepo();
    const { updater } = make(repo);
    fs.writeFileSync(path.join(repo.rootDir, "untracked.txt"), "x");
    assert.deepEqual((await updater.getInstallInfo()).blockers, []);
    fs.appendFileSync(path.join(repo.rootDir, "index.js"), "// local edit\n");
    const info = await updater.getInstallInfo();
    assert.deepEqual(info.blockers, ["dirty_tree"]);
    assert.equal(info.canSelfUpdate, false);
  });

  test("detached HEAD", async () => {
    const repo = newRepo();
    const { updater } = make(repo);
    repo.git(repo.rootDir, "checkout", "-q", "--detach");
    const info = await updater.getInstallInfo();
    assert.deepEqual(info.blockers, ["detached"]);
    assert.equal(info.branch, null);
  });

  test("no_remote_branch: a branch with no upstream and no origin/<branch> (the case of this very branch)", async () => {
    const repo = newRepo();
    const { updater } = make(repo);
    repo.git(repo.rootDir, "checkout", "-q", "-b", "feature");
    const info = await updater.getInstallInfo();
    assert.deepEqual(info.blockers, ["no_remote_branch"]);
    assert.equal(info.branch, "feature");
  });

  test("the upstream of the checked-out branch is followed, whatever its name (never a hard-coded master)", async () => {
    const repo = newRepo();
    const { updater } = make(repo, { config: { BRANCH: "does-not-exist" } });
    repo.git(repo.rootDir, "checkout", "-q", "-b", "release", "--track", "origin/master");
    const info = await updater.getInstallInfo();
    assert.deepEqual(info.blockers, []);
    assert.equal(info.branch, "release");
    assert.equal(info.upstream, "origin/master");
  });

  test("no_git_binary: git cannot be started", async () => {
    const repo = newRepo();
    const enoent = () => ({
      raw: async () => {
        throw Object.assign(new Error("Error: spawn git ENOENT"), { code: "ENOENT" });
      },
    });
    const { updater } = make(repo, { updater: { git: enoent } });
    const info = await updater.getInstallInfo();
    assert.equal(info.type, "git", "the folder is a checkout: git is what is missing");
    assert.deepEqual(info.blockers, ["no_git_binary"]);
    assert.equal(info.canSelfUpdate, false);
  });

  test("dubious_ownership: git refuses a repository owned by another user (a git shim on PATH)", async () => {
    const repo = newRepo();
    const bin = createFakeBin();
    cleanups.push(() => bin.cleanup());
    const { updater } = make(repo, { updater: { env: baseEnv({ SUPERVISED: "false", PATH: bin.gitDubious }) } });
    const info = await updater.getInstallInfo();
    assert.deepEqual(info.blockers, ["dubious_ownership"]);
    await assert.rejects(updater.check({ force: true }), (err) => err instanceof UpdaterError && err.params.reason === "dubious_ownership");
  });

  test("not_writable", async () => {
    const repo = newRepo();
    const realFs = noContainerFs();
    const readOnly = {
      ...realFs,
      accessSync: (p, mode) => {
        if (p === repo.rootDir) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return realFs.accessSync(p, mode);
      },
    };
    const { updater } = make(repo, { updater: { fs: readOnly } });
    assert.deepEqual((await updater.getInstallInfo()).blockers, ["not_writable"]);
  });

  test("a folder without .git is an image (container marker) or an archive", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-noinstall-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const base = { rootDir: dir, env: baseEnv({ SUPERVISED: "false" }), fs: noContainerFs(), config: { VERSION: "1.0.0" } };

    const archive = await createUpdater({ ...base }).getInstallInfo();
    assert.equal(archive.type, "archive");
    assert.equal(archive.canSelfUpdate, false);
    assert.deepEqual(archive.blockers, ["archive"]);

    const image = await createUpdater({ ...base, env: baseEnv({ container: "docker" }) }).getInstallInfo();
    assert.equal(image.type, "image");
    assert.deepEqual(image.blockers, ["image"]);
  });

  test("a stray .git whose repository is not the install folder does not make it a git install", async () => {
    const repo = newRepo();
    const sub = path.join(repo.rootDir, "sub");
    fs.mkdirSync(path.join(sub, ".git"), { recursive: true }); // empty: git walks up to the parent repository
    const { updater } = make(repo, { updater: { rootDir: sub } });
    assert.equal((await updater.getInstallInfo()).type, "archive");
  });

  test("rootDir is the repository root, never process.cwd()", async () => {
    const seen = [];
    const spy = (baseDir) => {
      seen.push(baseDir);
      return { raw: async () => "" };
    };
    const cwd = process.cwd();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "owb-cwd-"));
    cleanups.push(() => {
      process.chdir(cwd);
      fs.rmSync(elsewhere, { recursive: true, force: true });
    });
    process.chdir(elsewhere);
    await createUpdater({ git: spy, env: baseEnv(), fs: noContainerFs(), config: { VERSION: "1.0.0" } }).getInstallInfo();
    assert.ok(seen.length > 0);
    for (const dir of seen) assert.equal(dir, path.resolve(__dirname, ".."), "the repository root, whatever the working directory");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("check", () => {
  test("up to date: nothing behind, same versions", async () => {
    const repo = newRepo();
    const { updater } = make(repo);
    const result = await updater.check({ force: true });
    assert.equal(result.behind, 0);
    assert.equal(result.ahead, 0);
    assert.equal(result.localVersion, "1.0.0");
    assert.equal(result.remoteVersion, "1.0.0");
    assert.deepEqual(result.commits, []);
    assert.equal(result.installType, "git");
    assert.match(result.checkedAt, /^\d{4}-\d\d-\d\dT/);
  });

  test("behind: the count, the remote version and the list of changes (newest first)", async () => {
    const repo = newRepo();
    const { updater } = make(repo);
    repo.release({ message: "feat: first change", files: { "a.js": "1" } });
    const tip = repo.release({ message: "feat: second change", version: "1.1.0" });
    const result = await updater.check({ force: true });
    assert.equal(result.behind, 2);
    assert.equal(result.ahead, 0);
    assert.equal(result.localVersion, "1.0.0");
    assert.equal(result.remoteVersion, "1.1.0");
    assert.deepEqual(
      result.commits.map((c) => c.subject),
      ["feat: second change", "feat: first change"],
    );
    assert.ok(tip.startsWith(result.commits[0].hash), "the hash is the abbreviated commit id");
    assert.deepEqual(Object.keys(result.commits[0]).sort(), ["hash", "subject"]);
  });

  test("ahead: local commits that are not on the remote", async () => {
    const repo = newRepo();
    const { updater } = make(repo);
    repo.localCommit({ message: "wip" });
    const result = await updater.check({ force: true });
    assert.equal(result.ahead, 1);
    assert.equal(result.behind, 0);
    assert.deepEqual(result.commits, []);
  });

  test("a commit without a version bump is behind=1 with the same remote version", async () => {
    const repo = newRepo();
    const { updater } = make(repo);
    repo.release({ message: "fix: typo", files: { "index.js": "// fixed\n" } });
    const result = await updater.check({ force: true });
    assert.equal(result.behind, 1);
    assert.equal(result.remoteVersion, "1.0.0");
  });

  test("the list of changes is capped at 50", async () => {
    const repo = newRepo();
    const { updater } = make(repo);
    for (let i = 0; i < 55; i++) repo.commit({ message: `c${i}`, files: { [`f${i}.txt`]: String(i) } });
    repo.push();
    const result = await updater.check({ force: true });
    assert.equal(result.behind, 55);
    assert.equal(result.commits.length, 50);
  });

  test("an answer is kept 60 s; force skips it", async () => {
    const repo = newRepo();
    const { updater, clock } = make(repo);
    assert.equal((await updater.check()).behind, 0);
    repo.release({ message: "feat: x", files: { "x.js": "1" } });
    assert.equal((await updater.check()).behind, 0, "answered from memory");
    assert.equal((await updater.check({ force: true })).behind, 1, "force fetches");
    repo.release({ message: "feat: y", files: { "y.js": "1" } });
    await clock.advance(61 * 1000);
    assert.equal((await updater.check()).behind, 2, "the memory expired");
    assert.equal(updater.lastCheck().behind, 2);
  });

  test("no_remote_branch is told apart from a network failure", async () => {
    const repo = newRepo();
    const { updater } = make(repo);

    // 1. the upstream is configured but the branch is gone from the remote: "couldn't find remote ref"
    repo.git(repo.rootDir, "checkout", "-q", "-b", "gone", "--track", "origin/master");
    repo.git(repo.rootDir, "config", "branch.gone.merge", "refs/heads/gone");
    await assert.rejects(updater.check({ force: true }), (err) => {
      assert.ok(err instanceof UpdaterError);
      assert.equal(err.code, "update_check_failed");
      assert.equal(err.params.reason, "no_remote_branch");
      return true;
    });

    // 2. a remote that cannot be reached
    repo.git(repo.rootDir, "checkout", "-q", "master");
    repo.git(repo.rootDir, "remote", "set-url", "origin", path.join(repo.base, "does-not-exist.git"));
    await assert.rejects(updater.check({ force: true }), (err) => err.code === "update_check_failed" && err.params.reason === "unreachable");
  });

  test("a branch with no upstream fails the check with no_remote_branch before any fetch", async () => {
    const repo = newRepo();
    const { updater } = make(repo);
    repo.git(repo.rootDir, "checkout", "-q", "-b", "feature");
    await assert.rejects(updater.check({ force: true }), (err) => err.params.reason === "no_remote_branch");
  });

  test("a dirty tree still checks (read-only) and reports the blocker", async () => {
    const repo = newRepo();
    const { updater } = make(repo);
    repo.release({ message: "feat: x", files: { "x.js": "1" } });
    fs.appendFileSync(path.join(repo.rootDir, "index.js"), "// mine\n");
    const result = await updater.check({ force: true });
    assert.equal(result.behind, 1);
    assert.deepEqual(result.blockers, ["dirty_tree"]);
  });

  test("an image or an archive has instructions only; the remote version is one read of the repository's package.json", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-noinstall-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    const urls = [];
    const fetchJson = async (url) => (urls.push(url), { version: "1.4.0" });
    const base = { rootDir: dir, env: baseEnv({ container: "docker" }), fs: noContainerFs(), fetchJson, clock: createClock() };

    const image = createUpdater({ ...base, config: { VERSION: "1.0.0", UPDATE_CHECK: true } });
    const result = await image.check({ force: true });
    assert.equal(result.installType, "image");
    assert.deepEqual(result.blockers, ["image"]);
    assert.equal(result.remoteVersion, "1.4.0");
    assert.equal(result.localVersion, "1.0.0");
    assert.deepEqual(result.commits, []);
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^https:\/\/raw\.githubusercontent\.com\/Starland9\/OpenWhatsappBot\/master\/package\.json$/);

    const off = createUpdater({ ...base, config: { VERSION: "1.0.0", UPDATE_CHECK: false } });
    assert.equal((await off.check({ force: true })).remoteVersion, null);
    assert.equal(urls.length, 1, "UPDATE_CHECK=false: no request");

    const down = createUpdater({ ...base, config: { VERSION: "1.0.0", UPDATE_CHECK: true }, fetchJson: async () => Promise.reject(new Error("offline")) });
    await assert.rejects(down.check({ force: true }), (err) => err.params.reason === "unreachable");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("apply", () => {
  test("merges --ff-only, skips Yarn when no dependency file changed, runs the smoke boot, reports the phases", async () => {
    const repo = newRepo();
    const { updater, fake } = make(repo);
    const before = repo.head();
    const tip = repo.release({ message: "fix: index", files: { "index.js": "// v2\n", "lib/new.js": "// new\n" } });
    const phases = [];
    const result = await updater.apply({ onProgress: ({ phase }) => phases.push(phase), actor: "test" });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.upToDate, false);
    assert.equal(result.fromHead, before);
    assert.equal(result.toHead, tip);
    assert.equal(repo.head(), tip, "the working tree moved to the remote tip");
    assert.deepEqual(phases, ["fetch", "merge", "verify", "done"]);
    assert.equal(fake.of("install").length, 0, "no dependency file changed: no install");
    assert.equal(fake.of("smoke").length, 1);
    assert.equal(result.stats.files, 2);
    assert.ok(result.stats.insertions >= 2);

    const smoke = fake.of("smoke")[0];
    assert.equal(smoke.command, process.execPath);
    assert.equal(smoke.args[0], path.join(repo.rootDir, "tools", "verify-boot.js"));
    assert.equal(smoke.cwd, repo.rootDir);
    assert.equal(smoke.env.DATABASE_URL, ":memory:");
    assert.equal(smoke.env.LOG_LEVEL, "silent");
    assert.equal(smoke.timeout, 60 * 1000);
  });

  test("the vendored Yarn runs only when package.json, yarn.lock, .yarnrc.yml or .yarn/releases/* changed", async () => {
    for (const [name, files, version] of [
      ["package.json", {}, "1.1.0"],
      ["yarn.lock", { "yarn.lock": "# lock\n" }, undefined],
      [".yarnrc.yml", { ".yarnrc.yml": "yarnPath: .yarn/releases/yarn-test.cjs\nnodeLinker: node-modules\n" }, undefined],
      [".yarn/releases/*", { ".yarn/releases/yarn-next.cjs": "// next\n" }, undefined],
    ]) {
      const repo = newRepo();
      const { updater, fake } = make(repo);
      repo.release({ message: `deps: ${name}`, files, version });
      const result = await updater.apply();
      assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
      const installs = fake.of("install");
      assert.equal(installs.length, 1, `${name}: one install`);
      assert.equal(installs[0].command, process.execPath, `${name}: the vendored Yarn is run by node, not a yarn on PATH`);
      assert.deepEqual(installs[0].args, [path.join(repo.rootDir, ".yarn", "releases", "yarn-test.cjs"), "install", "--immutable"]);
      assert.equal(installs[0].cwd, repo.rootDir);
      assert.equal(installs[0].timeout, 5 * 60 * 1000);
      assert.ok(fake.calls.findIndex((c) => c.kind === "install") < fake.calls.findIndex((c) => c.kind === "smoke"), `${name}: install before the smoke boot`);
    }
  });

  test("the version of the new code is what the answer reports", async () => {
    const repo = newRepo();
    const { updater } = make(repo);
    repo.release({ message: "release", version: "1.2.0" });
    const result = await updater.apply();
    assert.equal(result.ok, true);
    assert.equal(result.from, "1.0.0");
    assert.equal(result.to, "1.2.0");
    assert.equal(updater.lastApply().ok, true);
    assert.equal(updater.lastApply().to, "1.2.0");
    assert.equal(updater.lastCheck(), null, "what a check listed has just been applied");
  });

  test("already up to date: nothing runs", async () => {
    const repo = newRepo();
    const { updater, fake } = make(repo);
    const result = await updater.apply();
    assert.equal(result.ok, true);
    assert.equal(result.upToDate, true);
    assert.equal(result.willRestart, false);
    assert.equal(fake.calls.length, 0);
    assert.equal(updater.restartRequired().required, false);
  });

  test("local commits only (ahead, nothing behind) are up to date, not a failure", async () => {
    const repo = newRepo();
    const { updater } = make(repo);
    repo.localCommit({ message: "wip" });
    const before = repo.head();
    const result = await updater.apply();
    assert.equal(result.ok, true);
    assert.equal(result.upToDate, true);
    assert.equal(repo.head(), before);
  });

  test("an install that fails rolls back to the previous commit and repeats the install", async () => {
    const repo = newRepo();
    const { updater, fake } = make(repo);
    const before = repo.head();
    repo.release({ message: "deps", files: { "yarn.lock": "# lock\n" }, version: "1.1.0" });
    fake.failInstall = true;
    const phases = [];
    const result = await updater.apply({ onProgress: ({ phase }) => phases.push(phase) });

    assert.equal(result.ok, false);
    assert.equal(result.phase, "install");
    assert.equal(result.reason, "install_failed");
    assert.equal(result.rolledBack, true);
    assert.equal(repo.head(), before, "reset --hard prevHead");
    assert.equal(repo.versionOf(), "1.0.0", "the working tree holds the old version again");
    assert.equal(fake.of("install").length, 2, "the install is repeated on the old lockfile");
    assert.equal(fake.of("smoke").length, 0);
    assert.deepEqual(phases, ["fetch", "merge", "install", "failed"]);
    assert.equal(updater.restartRequired().required, false, "the running version is still the one on disk");
    assert.equal(JSON.stringify(result).includes(FAKE_STDERR), false, "raw stderr never reaches the caller");
    assert.equal(updater.lastApply().rolledBack, true);
  });

  test("a smoke boot that fails rolls back (no install ran, so none is repeated)", async () => {
    const repo = newRepo();
    const { updater, fake } = make(repo);
    const before = repo.head();
    repo.release({ message: "bad commit", files: { "index.js": "throw new Error('broken')\n" } });
    fake.failSmoke = true;
    const result = await updater.apply();
    assert.equal(result.ok, false);
    assert.equal(result.phase, "verify");
    assert.equal(result.reason, "smoke_failed");
    assert.equal(result.rolledBack, true);
    assert.equal(repo.head(), before);
    assert.equal(fake.of("install").length, 0);
    assert.equal(JSON.stringify(result).includes(FAKE_STDERR), false);
  });

  test("a smoke boot that fails after an install repeats the install", async () => {
    const repo = newRepo();
    const { updater, fake } = make(repo);
    const before = repo.head();
    repo.release({ message: "deps + bug", files: { "yarn.lock": "# lock\n" } });
    fake.failSmoke = true;
    const result = await updater.apply();
    assert.equal(result.reason, "smoke_failed");
    assert.equal(result.rolledBack, true);
    assert.equal(repo.head(), before);
    assert.equal(fake.of("install").length, 2);
  });

  test("a diverged history is refused by --ff-only: back on the current commit, rolledBack", async () => {
    const repo = newRepo();
    const { updater, fake } = make(repo);
    repo.localCommit({ message: "local work", files: { "local.txt": "mine" } });
    const mine = repo.head();
    repo.release({ message: "remote work", files: { "remote.txt": "theirs" } });
    const result = await updater.apply();
    assert.equal(result.ok, false);
    assert.equal(result.phase, "merge");
    assert.equal(result.reason, "diverged");
    assert.equal(result.rolledBack, true);
    assert.equal(repo.head(), mine, "the local commit is still the tip");
    assert.ok(fs.existsSync(path.join(repo.rootDir, "local.txt")));
    assert.ok(!fs.existsSync(path.join(repo.rootDir, "remote.txt")));
    assert.equal(fake.calls.length, 0);
  });

  test("blockers refuse the update before anything is touched (reason unavailable)", async () => {
    const repo = newRepo();
    const { updater, fake } = make(repo);
    repo.release({ message: "feat", files: { "x.js": "1" } });
    fs.appendFileSync(path.join(repo.rootDir, "index.js"), "// mine\n");
    const before = repo.head();
    const result = await updater.apply();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unavailable");
    assert.deepEqual(result.blockers, ["dirty_tree"]);
    assert.equal(result.rolledBack, false);
    assert.equal(repo.head(), before);
    assert.equal(fake.calls.length, 0);
    assert.ok(fs.readFileSync(path.join(repo.rootDir, "index.js"), "utf8").includes("// mine"), "the local edit is untouched");
  });

  test("a fetch that cannot reach the remote is a network failure and changes nothing", async () => {
    const repo = newRepo();
    const { updater } = make(repo);
    const before = repo.head();
    repo.git(repo.rootDir, "remote", "set-url", "origin", path.join(repo.base, "does-not-exist.git"));
    const result = await updater.apply();
    assert.equal(result.ok, false);
    assert.equal(result.phase, "fetch");
    assert.equal(result.reason, "network");
    assert.equal(result.rolledBack, false);
    assert.equal(repo.head(), before);
  });

  test("a branch that does not exist on the remote any more: no_remote_branch at fetch time", async () => {
    const repo = newRepo();
    const { updater } = make(repo);
    repo.git(repo.rootDir, "checkout", "-q", "-b", "gone", "--track", "origin/master");
    repo.git(repo.rootDir, "config", "branch.gone.merge", "refs/heads/gone");
    const result = await updater.apply();
    assert.equal(result.reason, "no_remote_branch");
    assert.equal(result.phase, "fetch");
  });

  test("follows the upstream of the current branch, not a hard-coded one", async () => {
    const repo = newRepo();
    const { updater } = make(repo, { config: { BRANCH: "unrelated" } });
    repo.git(repo.rootDir, "checkout", "-q", "-b", "release", "--track", "origin/master");
    const tip = repo.release({ message: "feat", files: { "x.js": "1" } });
    const result = await updater.apply();
    assert.equal(result.ok, true);
    assert.equal(repo.head(), tip);
    assert.equal(repo.git(repo.rootDir, "rev-parse", "--abbrev-ref", "HEAD"), "release", "no branch switch");
  });

  test("one process-wide lock: a second apply (the command and the panel) answers busy while one runs", async () => {
    const repo = newRepo();
    const { updater, fake } = make(repo);
    repo.release({ message: "feat", files: { "x.js": "1" } });
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    fake.onSmoke = () => gate;

    const first = updater.apply();
    for (let i = 0; i < 2000 && fake.of("smoke").length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(fake.of("smoke").length, 1, "the first update reached its smoke boot");
    assert.equal(updater.isBusy(), true);

    const second = await updater.apply();
    assert.equal(second.ok, false);
    assert.equal(second.reason, "busy");
    await assert.rejects(updater.check({ force: true }), (err) => err.params.reason === "busy", "no fetch while an update runs");

    release();
    assert.equal((await first).ok, true);
    assert.equal(updater.isBusy(), false, "the lock is released");
    assert.equal((await updater.apply()).upToDate, true);
  });

  test("the lock is released after a failure too", async () => {
    const repo = newRepo();
    const { updater, fake } = make(repo);
    repo.release({ message: "feat", files: { "x.js": "1" } });
    fake.failSmoke = true;
    assert.equal((await updater.apply()).ok, false);
    assert.equal(updater.isBusy(), false);
    fake.failSmoke = false;
    assert.equal((await updater.apply()).ok, true);
  });

  test("a throwing progress listener never breaks the update", async () => {
    const repo = newRepo();
    const { updater } = make(repo);
    repo.release({ message: "feat", files: { "x.js": "1" } });
    const result = await updater.apply({
      onProgress: () => {
        throw new Error("listener bug");
      },
    });
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("restartRequired and the end of an update", () => {
  test("derived from the HEAD read at the first use: false, then true once an update (or a manual pull) moved it", async () => {
    const repo = newRepo();
    const { updater } = make(repo);
    assert.deepEqual(updater.restartRequired(), { required: false, from: null, to: null, reason: null });
    repo.release({ message: "feat", files: { "x.js": "1" } });
    assert.equal(updater.restartRequired().required, false, "the remote moved, this checkout did not");

    // a manual git pull is caught as well
    repo.git(repo.rootDir, "pull", "-q", "--ff-only");
    const verdict = updater.restartRequired();
    assert.equal(verdict.required, true);
    assert.equal(verdict.reason, "head");
    assert.equal(verdict.to, repo.head().slice(0, 7));
  });

  test("the package.json version on disk differing from the running one", async () => {
    const repo = newRepo();
    const { updater } = make(repo, { config: { VERSION: "0.9.0" } });
    const verdict = updater.restartRequired();
    assert.deepEqual(verdict, { required: true, from: "0.9.0", to: "1.0.0", reason: "version" });
  });

  test("after apply: required, with the two versions", async () => {
    const repo = newRepo();
    const { updater } = make(repo);
    updater.restartRequired(); // the first call records the code that is running
    repo.release({ message: "release", version: "1.1.0" });
    await updater.apply();
    assert.deepEqual(updater.restartRequired(), { required: true, from: "1.0.0", to: "1.1.0", reason: "version" });
  });

  test("supervised: willRestart, and the process exits about 1 s after the caller answered", async () => {
    const repo = newRepo();
    const { updater, exits, clock } = make(repo, { updater: { env: baseEnv({ SUPERVISED: "true" }) } });
    repo.release({ message: "release", version: "1.1.0" });
    const result = await updater.apply();
    assert.equal(result.ok, true);
    assert.equal(result.willRestart, true);
    assert.equal((await updater.getInstallInfo()).supervised, true);

    assert.deepEqual(updater.scheduleExit(), { scheduled: true });
    assert.deepEqual(exits, [], "not before the answer");
    await clock.advance(999);
    assert.deepEqual(exits, []);
    await clock.advance(1);
    assert.deepEqual(exits, [0], "process.exit(0) about 1 s later");
    assert.equal(clock.pending(), 0);
  });

  test("PM2 (pm_id) counts as a supervisor", async () => {
    const repo = newRepo();
    const { updater } = make(repo, { updater: { env: baseEnv({ pm_id: "0" }) } });
    assert.equal((await updater.getInstallInfo()).supervised, true);
    assert.equal((await updater.getInstallInfo()).supervisor, "pm2");
  });

  test("unsupervised (U6): the update is applied, nothing exits, the restart is asked for", async () => {
    const repo = newRepo();
    const { updater, exits, clock } = make(repo); // SUPERVISED=false
    repo.release({ message: "release", version: "1.1.0" });
    const result = await updater.apply();
    assert.equal(result.ok, true);
    assert.equal(result.willRestart, false);
    assert.equal(result.restartRequired, true);
    assert.deepEqual(updater.scheduleExit(), { scheduled: false });
    await clock.advance(10 * 1000);
    assert.deepEqual(exits, [], "the process keeps running");
    assert.equal(updater.restartRequired().required, true, "until it restarts");
    assert.equal(clock.pending(), 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("the checker", () => {
  const clientOf = (ready = false) => {
    const client = new EventEmitter();
    client.isReady = ready;
    client.ready = () => client.isReady;
    return client;
  };

  test("no timer before startChecker; the first check runs 2 minutes after ready, then every 6 h, unref'd", async () => {
    const repo = newRepo();
    const { updater, clock, alerts } = make(repo);
    const client = clientOf(false);
    assert.equal(clock.pending(), 0, "nothing at construction");
    assert.equal(updater.startChecker(client), true);
    assert.equal(clock.pending(), 0, "nothing until the client is ready");
    assert.equal(client.listenerCount("ready"), 1);

    repo.release({ message: "release", version: "1.1.0" });
    client.isReady = true;
    client.emit("ready");
    assert.equal(client.listenerCount("ready"), 0, "the listener removes itself");
    assert.equal(clock.pending(), 1);

    await clock.advance(2 * MINUTE - 1);
    assert.equal(updater.lastCheck(), null, "not before 2 minutes");
    await clock.advance(1);
    for (let i = 0; i < 40 && !updater.lastCheck(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(updater.lastCheck().remoteVersion, "1.1.0");
    assert.deepEqual(alerts.calls, [{ type: "update_available", payload: { version: "1.1.0" } }]);

    // the next check is armed 6 h later (no jitter with random = 0.5), unref'd
    assert.equal(clock.pending(), 1);
    await clock.advance(6 * HOUR - 1);
    const checkedAt = updater.lastCheck().checkedAt;
    await clock.advance(1);
    for (let i = 0; i < 40 && updater.lastCheck().checkedAt === checkedAt; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.notEqual(updater.lastCheck().checkedAt, checkedAt, "a second check ran");
    assert.equal(alerts.calls.length, 1, "once per remote version");
  });

  test("the timers are unref'd and stop() clears them and the listener", async () => {
    const repo = newRepo();
    const handles = [];
    const clock = createClock();
    const timers = {
      ...clock.timers,
      setTimeout: (fn, ms, ...rest) => {
        const handle = clock.timers.setTimeout(fn, ms, ...rest);
        handles.push(handle);
        return handle;
      },
    };
    const { updater } = make(repo, { clock, updater: { timers } });
    const client = clientOf(true);
    updater.startChecker(client);
    assert.equal(handles.length, 1, "already ready: armed at once");
    assert.equal(handles[0].hasRef(), false, "unref'd: it never keeps the process alive");
    assert.equal(updater.startChecker(client), false, "idempotent");
    assert.equal(clock.pending(), 1);
    updater.stop();
    assert.equal(clock.pending(), 0);
    assert.equal(updater.checkerRunning(), false);

    const waiting = clientOf(false);
    updater.startChecker(waiting);
    assert.equal(waiting.listenerCount("ready"), 1);
    updater.stop();
    assert.equal(waiting.listenerCount("ready"), 0);
  });

  test("UPDATE_CHECK=false disables the checker: no timer, no listener", async () => {
    const repo = newRepo();
    const clock = createClock();
    const updater = createUpdater({ rootDir: repo.rootDir, run: createFakeRun().run, env: baseEnv(), fs: noContainerFs(), clock, timers: clock.timers, config: { VERSION: "1.0.0", UPDATE_CHECK: false } });
    const client = clientOf(true);
    assert.equal(updater.startChecker(client), false);
    assert.equal(clock.pending(), 0);
    assert.equal(client.listenerCount("ready"), 0);
  });

  test("a commit without a version bump raises no alert; a new greater version raises one more", async () => {
    const repo = newRepo();
    const { updater, clock, alerts } = make(repo);
    updater.startChecker(clientOf(true));
    const waitCheck = async (previous) => {
      for (let i = 0; i < 60 && (!updater.lastCheck() || updater.lastCheck().checkedAt === previous); i++) await new Promise((resolve) => setTimeout(resolve, 25));
      return updater.lastCheck().checkedAt;
    };

    repo.release({ message: "fix: no bump", files: { "x.js": "1" } });
    await clock.advance(2 * MINUTE);
    let seen = await waitCheck(null);
    assert.equal(updater.lastCheck().behind, 1);
    assert.deepEqual(alerts.calls, [], "a badge, not an alert");

    repo.release({ message: "release 1.1.0", version: "1.1.0" });
    await clock.advance(6 * HOUR);
    seen = await waitCheck(seen);
    assert.deepEqual(alerts.calls.map((c) => c.payload.version), ["1.1.0"]);

    await clock.advance(6 * HOUR);
    seen = await waitCheck(seen);
    assert.equal(alerts.calls.length, 1, "the same remote version never raises twice");

    repo.release({ message: "release 1.2.0", version: "1.2.0" });
    await clock.advance(6 * HOUR);
    await waitCheck(seen);
    assert.deepEqual(alerts.calls.map((c) => c.payload.version), ["1.1.0", "1.2.0"]);
  });

  test("a failing scheduled check is logged and the next one is still armed", async () => {
    const repo = newRepo();
    const { updater, clock } = make(repo);
    repo.git(repo.rootDir, "remote", "set-url", "origin", path.join(repo.base, "does-not-exist.git"));
    updater.startChecker(clientOf(true));
    await clock.advance(2 * MINUTE);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(updater.lastCheck(), null);
    assert.equal(clock.pending(), 1, "the next check is armed");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// plugins/update.js: a thin client of the updater (the singleton is patched, no git and no process is started)
// ---------------------------------------------------------------------------------------------------------------
describe("plugins/update.js (.update now)", () => {
  const { applyBotFragments } = require("./helpers/botFragments");
  const { getLang } = require("../lib/utils/language");
  applyBotFragments();
  const plugin = require("../plugins/update");
  const singleton = require("../lib/utils/updater");
  const ytdlpSingleton = require("../lib/utils/ytdlpUpdate");

  const originals = {};
  let calls;
  let script;

  beforeEach(() => {
    calls = { apply: 0, exit: 0, ytdlp: 0 };
    script = {
      busy: false,
      info: { type: "git", canSelfUpdate: true, blockers: [] },
      result: { ok: true, upToDate: false, willRestart: false, from: "1.0.0", to: "1.1.0", stats: { files: 3, insertions: 10, deletions: 2 } },
      phases: ["fetch", "merge", "install", "verify"],
      throws: null,
    };
    for (const name of ["isBusy", "getInstallInfo", "apply", "scheduleExit"]) originals[name] = singleton[name];
    originals.ytdlp = ytdlpSingleton.update;
    singleton.isBusy = () => script.busy;
    singleton.getInstallInfo = async () => ({ ...script.info });
    singleton.apply = async (options) => {
      calls.apply += 1;
      if (script.throws) throw script.throws;
      for (const phase of script.phases) await options.onProgress({ phase });
      return script.result;
    };
    singleton.scheduleExit = () => {
      calls.exit += 1;
      return { scheduled: true };
    };
    ytdlpSingleton.update = async () => {
      calls.ytdlp += 1;
      return { outcome: "up_to_date" };
    };
  });

  afterEach(() => {
    for (const name of ["isBusy", "getInstallInfo", "apply", "scheduleExit"]) singleton[name] = originals[name];
    ytdlpSingleton.update = originals.ytdlp;
    mock.timers.reset();
  });

  const run = async (query = "now") => {
    const message = fakes.makeMessage({ body: ".update now", from: fakes.IDS.OWNER_PN });
    await plugin.execute(message, query);
    return fakes.sentTexts(message.client.getSocket());
  };

  test("without `now`: the usage, nothing else happens", async () => {
    const texts = await run("");
    assert.deepEqual(texts, [getLang("plugins.update.usage", ".")]);
    assert.equal(calls.apply, 0);
  });

  test("an update already running (the panel, or a second command): busy", async () => {
    script.busy = true;
    assert.deepEqual(await run(), [getLang("plugins.update.busy")]);
    assert.equal(calls.apply, 0);
  });

  test("blockers are explained with the replies that already existed, plus the new ones", async () => {
    const cases = [
      [["dirty_tree"], "plugins.update.uncommitted_changes"],
      [["detached"], "plugins.update.detached"],
      [["no_remote_branch"], "plugins.update.no_remote_branch"],
      [["image"], "plugins.update.unavailable"],
      [["no_git_binary"], "plugins.update.unavailable"],
    ];
    for (const [blockers, key] of cases) {
      script.info = { type: "git", canSelfUpdate: false, blockers };
      const texts = await run();
      assert.equal(texts[texts.length - 1], getLang(key), blockers.join());
    }
    assert.equal(calls.apply, 0, "nothing was touched");
  });

  test("up to date", async () => {
    script.result = { ok: true, upToDate: true };
    const texts = await run();
    assert.equal(texts[texts.length - 1], getLang("plugins.update.already_updated"));
    assert.equal(calls.ytdlp, 0);
  });

  test("unsupervised success: the changes, the install step, yt-dlp refreshed, and the owner told to restart by hand (no exit)", async () => {
    const texts = await run();
    assert.deepEqual(texts, [
      getLang("plugins.update.starting"),
      getLang("plugins.update.fetching"),
      getLang("plugins.update.installing_deps"),
      getLang("plugins.update.changes_detected", 3, 10, 2),
      getLang("plugins.update.restart_manual"),
    ]);
    assert.equal(calls.ytdlp, 1);
    assert.equal(calls.exit, 0, "nothing would restart the process: it must not exit");
  });

  test("supervised success: restarting, success, then the exit is scheduled after the pause", async () => {
    script.result = { ...script.result, willRestart: true };
    mock.timers.enable({ apis: ["setTimeout"] });
    const message = fakes.makeMessage({ body: ".update now", from: fakes.IDS.OWNER_PN });
    const done = plugin.execute(message, "now");
    for (let i = 0; i < 100 && calls.exit === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(2000);
    }
    await done;
    assert.equal(calls.exit, 1);
    const texts = fakes.sentTexts(message.client.getSocket());
    assert.ok(texts.includes(getLang("plugins.update.restarting")));
    assert.equal(texts[texts.length - 1], getLang("plugins.update.success"));
  });

  test("failures: the reason is told, and a rollback is announced", async () => {
    const cases = [
      [{ reason: "busy" }, ["plugins.update.busy"]],
      [{ reason: "no_remote_branch" }, ["plugins.update.no_remote_branch"]],
      [{ reason: "network" }, ["plugins.update.network_error"]],
      [{ reason: "diverged", rolledBack: true }, ["plugins.update.diverged"]],
      [{ reason: "install_failed", rolledBack: true }, ["plugins.update.install_failed", "plugins.update.rolled_back"]],
      [{ reason: "smoke_failed", rolledBack: true }, ["plugins.update.rolled_back"]],
      [{ reason: "merge_failed", rolledBack: false }, ["plugins.update.error"]],
      [{ reason: "unavailable", blockers: ["dirty_tree"] }, ["plugins.update.uncommitted_changes"]],
      [{ reason: "something_new" }, ["plugins.update.error"]],
    ];
    for (const [failure, keys] of cases) {
      script.phases = [];
      script.result = { ok: false, phase: "verify", rolledBack: false, ...failure };
      const texts = await run();
      assert.deepEqual(texts.slice(-keys.length), keys.map((key) => getLang(key)), failure.reason);
      assert.equal(calls.exit, 0);
      assert.equal(calls.ytdlp, 0, "no yt-dlp refresh after a failed update");
    }
  });

  test("an unexpected exception answers the generic error, never its message", async () => {
    script.throws = new Error("secret detail /home/owner token=abc");
    const texts = await run();
    assert.equal(texts[texts.length - 1], getLang("plugins.update.error"));
    assert.equal(texts.join("\n").includes("secret detail"), false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// tools/verify-boot.js: the smoke boot the updater runs in a child before keeping a new version
// ---------------------------------------------------------------------------------------------------------------
describe("tools/verify-boot.js", () => {
  const { spawnSync } = require("child_process");
  const SCRIPT = path.resolve(__dirname, "..", "tools", "verify-boot.js");
  const childEnv = (extra = {}) => ({ ...process.env, OWB_NO_CONFIG_ENV: "1", ...extra });

  test("boots this very code base: config, models, every plugin; exit 0 and the number of commands", () => {
    const res = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: childEnv(), timeout: 60000 });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^verify-boot: ok, \d+ command\(s\) from \d+ plugin\(s\)/);
    assert.ok(Number(/ok, (\d+) command/.exec(res.stdout)[1]) > 10);
  });

  test("never touches the caller's database or panel: the environment is forced whatever the caller passed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-verify-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const tree = (files) => {
      fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
      fs.copyFileSync(SCRIPT, path.join(dir, "tools", "verify-boot.js"));
      for (const [file, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), text);
      }
    };
    const probe = path.join(dir, "env.json");
    tree({
      "lib/database/index.js": `require("fs").writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ db: process.env.DATABASE_URL, log: process.env.LOG_LEVEL, panel: process.env.ADMIN_PANEL, check: process.env.UPDATE_CHECK })); module.exports = { sync: async () => {} };`,
      "lib/plugins/loader.js": `module.exports = { loadAll: async () => ({ loaded: ["a.js"], failed: [] }) };`,
      "lib/plugins/registry.js": `module.exports = { getCommands: () => [{ name: "ping" }] };`,
    });
    const res = spawnSync(process.execPath, [path.join(dir, "tools", "verify-boot.js")], {
      encoding: "utf8",
      env: childEnv({ DATABASE_URL: "/srv/bot/database.db", LOG_LEVEL: "debug", ADMIN_PANEL: "true", UPDATE_CHECK: "true" }),
      timeout: 30000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(probe, "utf8")), { db: ":memory:", log: "silent", panel: "false", check: "false" });
  });

  test("exits non-zero unless at least one command registers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-verify-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, "tools", "verify-boot.js"));
    for (const [file, text] of Object.entries({
      "lib/database/index.js": `module.exports = { sync: async () => {} };`,
      "lib/plugins/loader.js": `module.exports = { loadAll: async () => ({ loaded: [], failed: [{ file: "x.js" }] }) };`,
      "lib/plugins/registry.js": `module.exports = { getCommands: () => [] };`,
    })) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    const res = spawnSync(process.execPath, [path.join(dir, "tools", "verify-boot.js")], { encoding: "utf8", env: childEnv(), timeout: 30000 });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /no command registered/);
  });

  test("exits non-zero when the code does not load (a bad commit), without printing a setting", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-verify-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, "tools", "verify-boot.js"));
    fs.mkdirSync(path.join(dir, "lib", "database"), { recursive: true });
    fs.writeFileSync(path.join(dir, "lib", "database", "index.js"), `throw new Error("SyntaxError in the new code");`);
    const res = spawnSync(process.execPath, [path.join(dir, "tools", "verify-boot.js")], { encoding: "utf8", env: childEnv({ OPENAI_API_KEY: "sk-must-not-appear" }), timeout: 30000 });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /verify-boot: Error: SyntaxError in the new code/);
    assert.equal(`${res.stdout}${res.stderr}`.includes("sk-must-not-appear"), false);
  });
});
