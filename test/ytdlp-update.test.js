"use strict";
/**
 * lib/utils/ytdlpUpdate.js and the maintenance switch of lib/utils/downloader.js (specs/002-admin-panel:
 * contracts/runtime.md section 11, research D2; FR-055).
 *
 *  - the verdict comes from the version before and after `yt-dlp -U`, never from stdout (`updated`, `up_to_date`);
 *  - stderr only classifies a failed run (`managed_externally`, `read_only`, `unreachable`, `failed`) and is never
 *    forwarded to the caller;
 *  - `busy` while a download runs or another update runs; new downloads are refused (YTDLP_BUSY) during the update;
 *  - a `missing` binary; `YTDLP_PATH` is never returned (the command name only);
 *  - `inspect()`: the heuristic behind "likely / no / missing" and the hint.
 *
 * Fake shell scripts stand in for yt-dlp (test/helpers/fakeExec.js). Nothing is downloaded, no network.
 */

const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// The real execFile, kept for the fake binaries: the downloader block below replaces the module's own copy
const realExecFile = childProcess.execFile;

const fakes = require("./helpers/fakes");
fakes.setupEnv({ sudo: "111" });

const { createYtdlpUpdate } = require("../lib/utils/ytdlpUpdate");
const { createFakeBin, createFakeDownloader, FAKE_STDERR } = require("./helpers/fakeExec");

const cleanups = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function setup({ scenario = "same", version = "2024.04.09", env = {}, fsApi } = {}) {
  const bin = createFakeBin({ ytdlpVersion: version, scenario });
  cleanups.push(() => bin.cleanup());
  const downloader = createFakeDownloader(bin);
  const ytdlp = createYtdlpUpdate({
    downloader,
    config: { YTDLP_PATH: bin.ytdlp },
    execFile: realExecFile,
    env: { PATH: process.env.PATH, ...env },
    ...(fsApi ? { fs: fsApi } : {}),
  });
  return { bin, downloader, ytdlp };
}

describe("update: the verdict comes from the version before and after", () => {
  test("a new version is `updated`", async () => {
    const { ytdlp, bin, downloader } = setup({ scenario: "update:2025.01.01" });
    const result = await ytdlp.update();
    assert.deepEqual(result, { outcome: "updated", before: "2024.04.09", after: "2025.01.01" });
    assert.equal(bin.updateCalls(), 1);
    assert.ok(downloader.resets >= 2, "the cached version is dropped before and after");
    assert.equal(ytdlp.isUpdating(), false);
  });

  test("the same version after a clean exit is `up_to_date`", async () => {
    const { ytdlp } = setup({ scenario: "same" });
    assert.deepEqual(await ytdlp.update(), { outcome: "up_to_date", before: "2024.04.09", after: "2024.04.09" });
  });

  test("stdout is never parsed: a run that claims an update but changes nothing is `up_to_date`", async () => {
    const { ytdlp } = setup({ scenario: "misleading" });
    const result = await ytdlp.update();
    assert.equal(result.outcome, "up_to_date");
    assert.equal(result.after, "2024.04.09");
  });

  test("a version that changed outside the process cache is read afresh (no stale `before`)", async () => {
    const { ytdlp, downloader, bin } = setup({ scenario: "same" });
    await downloader.isAvailable(); // cached 2024.04.09
    fs.writeFileSync(path.join(bin.dir, "ytdlp-version"), "2024.09.09\n"); // updated by hand meanwhile
    const result = await ytdlp.update();
    assert.equal(result.before, "2024.09.09");
    assert.equal(result.outcome, "up_to_date");
  });

  test("the progress listener hears the update step and can never fail it", async () => {
    const { ytdlp } = setup({ scenario: "update:2025.01.01" });
    const phases = [];
    const result = await ytdlp.update({
      onProgress: ({ phase }) => {
        phases.push(phase);
        throw new Error("listener bug");
      },
    });
    assert.equal(result.outcome, "updated");
    assert.deepEqual(phases, ["update"]);
  });
});

describe("update: stderr only classifies a failed run and is never forwarded", () => {
  const cases = [
    ["managed", "managed_externally"],
    ["readonly", "read_only"],
    ["network", "unreachable"],
    ["fail", "failed"],
  ];
  for (const [scenario, outcome] of cases) {
    test(`${scenario} -> ${outcome}`, async () => {
      const { ytdlp } = setup({ scenario });
      const result = await ytdlp.update();
      assert.equal(result.outcome, outcome);
      assert.equal(result.before, "2024.04.09");
      assert.equal(result.after, "2024.04.09");
      assert.deepEqual(Object.keys(result).sort(), ["after", "before", "outcome"]);
      assert.equal(JSON.stringify(result).includes(FAKE_STDERR), false, "no stderr in the answer");
      assert.equal(JSON.stringify(result).includes("package manager"), false);
    });
  }

  test("a run killed at the 60 s timeout is `unreachable`", async () => {
    const { bin } = setup();
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    try {
      const slow = createYtdlpUpdate({
        downloader: createFakeDownloader(bin),
        config: { YTDLP_PATH: bin.ytdlp },
        env: { PATH: process.env.PATH },
        execFile: (file, args, options, callback) => {
          assert.equal(options.timeout, 60 * 1000, "yt-dlp -U is given 60 s");
          mock.timers.tick(60 * 1000);
          callback(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGKILL", code: null }), "", "");
        },
      });
      assert.equal((await slow.update()).outcome, "unreachable");
    } finally {
      mock.timers.reset();
    }
  });
});

describe("update: busy, missing, maintenance", () => {
  test("`busy` while a download runs: yt-dlp -U is not started", async () => {
    const { ytdlp, bin, downloader } = setup({ scenario: "update:2025.01.01" });
    downloader.active = 1;
    const result = await ytdlp.update();
    assert.equal(result.outcome, "busy");
    assert.equal(bin.updateCalls(), 0);
    assert.deepEqual(downloader.maintenanceLog, [], "downloads were not blocked either");
  });

  test("`busy` for a second update while one runs; downloads are blocked only during it", async () => {
    const { ytdlp, bin, downloader } = setup({ scenario: "update:2025.01.01" });
    const states = [];
    const first = ytdlp.update({ onProgress: () => states.push(downloader.maintenance) });
    const second = await ytdlp.update(); // started in the same tick
    assert.equal(second.outcome, "busy");
    assert.equal((await first).outcome, "updated");
    assert.equal(bin.updateCalls(), 1);
    assert.deepEqual(downloader.maintenanceLog, [true, false], "blocked for the run of -U, then allowed again");
    assert.deepEqual(states, [true]);
    assert.equal(downloader.maintenance, false);
  });

  test("maintenance is lifted even when yt-dlp -U fails", async () => {
    const { ytdlp, downloader } = setup({ scenario: "fail" });
    await ytdlp.update();
    assert.deepEqual(downloader.maintenanceLog, [true, false]);
  });

  test("`missing` binary", async () => {
    const bin = createFakeBin();
    cleanups.push(() => bin.cleanup());
    const gone = path.join(bin.dir, "not-installed");
    const ytdlp = createYtdlpUpdate({
      downloader: { ...createFakeDownloader({ ytdlp: gone }), setMaintenance() {} },
      config: { YTDLP_PATH: gone },
      execFile: realExecFile,
      env: { PATH: process.env.PATH },
    });
    assert.deepEqual(await ytdlp.update(), { outcome: "missing", before: null, after: null });
    assert.deepEqual(await ytdlp.inspect(), { selfUpdatable: "missing", version: null, hint: null });
  });

  test("`YTDLP_PATH` is never returned: the command name only", async () => {
    const { ytdlp, bin } = setup({ scenario: "update:2025.01.01" });
    assert.equal(ytdlp.command(), "yt-dlp");
    const everything = JSON.stringify([await ytdlp.inspect(), await ytdlp.update(), ytdlp.command()]);
    assert.equal(everything.includes(bin.dir), false);
    assert.equal(everything.includes(os.tmpdir()), false);
  });
});

describe("inspect: the heuristic before the click", () => {
  test("a small python/shell entry point (apt, pip) cannot update itself: package_managed, with a hint", async () => {
    const { ytdlp } = setup();
    const inspected = await ytdlp.inspect();
    assert.equal(inspected.selfUpdatable, "no");
    assert.equal(inspected.reason, "package_managed");
    assert.equal(inspected.version, "2024.04.09");
    assert.equal(inspected.hint, "pip");
  });

  test("a large release script (zip behind a shebang) is likely self-updatable", async () => {
    const { ytdlp, bin } = setup();
    // still runs (--version prints the version file), but is several MB like the real release script
    const script = '#!/bin/sh\ncat "$(dirname "$0")/ytdlp-version"\nexit 0\n# ';
    fs.writeFileSync(bin.ytdlp, Buffer.concat([Buffer.from(script), Buffer.alloc(2 * 1024 * 1024, 0x61)]), { mode: 0o755 });
    assert.deepEqual(await ytdlp.inspect(), { selfUpdatable: "likely", version: "2024.04.09", hint: null });
  });

  test("a native binary (ELF) is likely self-updatable", async () => {
    const bin = createFakeBin();
    cleanups.push(() => bin.cleanup());
    const elf = path.join(bin.dir, "yt-dlp-elf");
    fs.writeFileSync(elf, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(2048, 1)]), { mode: 0o755 });
    const downloader = { isAvailable: async () => true, getVersion: () => "2025.01.01" }; // the file is not runnable here
    const ytdlp = createYtdlpUpdate({ downloader, config: { YTDLP_PATH: elf }, env: { PATH: process.env.PATH } });
    assert.deepEqual(await ytdlp.inspect(), { selfUpdatable: "likely", version: "2025.01.01", hint: null });
  });

  test("a file that cannot be written to is `no` / read_only", async () => {
    const real = fs;
    const readOnlyFs = { ...real, accessSync: (p, mode) => (mode === real.constants.W_OK ? (() => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); })() : real.accessSync(p, mode)) };
    const { ytdlp } = setup({ fsApi: readOnlyFs });
    const inspected = await ytdlp.inspect();
    assert.equal(inspected.selfUpdatable, "no");
    assert.equal(inspected.reason, "read_only");
    assert.equal(inspected.hint, "official_binary");
  });

  test("in a container the hint is to rebuild the image", async () => {
    const { ytdlp } = setup({ env: { container: "docker" } });
    assert.equal((await ytdlp.inspect()).hint, "rebuild_image");
  });

  test("a bare command name is looked up on PATH", async () => {
    const bin = createFakeBin();
    cleanups.push(() => bin.cleanup());
    const ytdlp = createYtdlpUpdate({ downloader: createFakeDownloader(bin), config: { YTDLP_PATH: "yt-dlp" }, execFile: realExecFile, env: { PATH: bin.dir } });
    const inspected = await ytdlp.inspect();
    assert.equal(inspected.selfUpdatable, "no", "found (it is a small script), not missing");
    assert.equal(inspected.version, "2024.04.09");
    assert.equal(ytdlp.command(), "yt-dlp");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The real downloader: its execFile is the module-level one, so the fake is installed before it is required
// ---------------------------------------------------------------------------------------------------------------
describe("lib/utils/downloader.js: getActiveDownloads and setMaintenance", () => {
  const state = { version: "2024.04.09", hold: Promise.resolve(), updateStarted: false };

  /** Behaves like yt-dlp for `--version`, `-U` and a download; the last two wait for `state.hold` */
  function fakeExecFile(file, args, options, callback) {
    if (args[0] === "--version") {
      setImmediate(() => callback(null, `${state.version}\n`, ""));
    } else if (args[0] === "-U") {
      state.updateStarted = true;
      state.hold.then(() => {
        state.version = "2025.02.02";
        callback(null, "Updated\n", "");
      });
    } else {
      const template = args[args.indexOf("-o") + 1];
      state.hold.then(() => {
        const filepath = template.replace("%(id)s", "clip").replace("%(ext)s", "mp4");
        fs.writeFileSync(filepath, Buffer.alloc(64, 1));
        callback(null, `${JSON.stringify({ filepath, title: "clip", id: "clip", ext: "mp4" })}\n`, "");
      });
    }
    return { kill() {}, on() {} };
  }

  // the downloader copies execFile when it is loaded
  childProcess.execFile = fakeExecFile;
  const downloader = require("../lib/utils/downloader");
  childProcess.execFile = realExecFile;

  test("download() throws YTDLP_BUSY while maintenance is set and works again afterwards; the count follows the downloads", async () => {
    let release;
    state.hold = new Promise((resolve) => (release = resolve));

    assert.equal(downloader.getActiveDownloads(), 0);
    const running = downloader.download("https://example.com/watch?v=1");
    assert.equal(downloader.getActiveDownloads(), 1, "one download in flight");

    downloader.setMaintenance(true);
    await assert.rejects(downloader.download("https://example.com/watch?v=2"), (err) => err.code === "YTDLP_BUSY");
    assert.equal(downloader.getActiveDownloads(), 1, "the refused download was never counted");

    release();
    assert.equal((await running).fileName, "clip.mp4", "the running download is not interrupted");
    assert.equal(downloader.getActiveDownloads(), 0);

    downloader.setMaintenance(false);
    state.hold = Promise.resolve();
    assert.equal((await downloader.download("https://example.com/watch?v=3")).fileName, "clip.mp4");
  });

  test("an invalid URL is still INVALID_URL during maintenance (no other behaviour change)", async () => {
    downloader.setMaintenance(true);
    try {
      await assert.rejects(downloader.download("ftp://example.com/x"), (err) => err.code === "INVALID_URL");
    } finally {
      downloader.setMaintenance(false);
    }
  });

  test("the update engine on the real downloader: new downloads wait during -U, the verdict is `updated`", async () => {
    state.version = "2024.04.09";
    state.updateStarted = false;
    downloader.resetCache();
    let release;
    state.hold = new Promise((resolve) => (release = resolve));

    const ytdlp = createYtdlpUpdate({ downloader, config: { YTDLP_PATH: "yt-dlp" }, execFile: fakeExecFile, env: { PATH: process.env.PATH } });
    const updating = ytdlp.update();
    for (let i = 0; i < 500 && !state.updateStarted; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.updateStarted, true, "yt-dlp -U is running");
    await assert.rejects(downloader.download("https://example.com/watch?v=9"), (err) => err.code === "YTDLP_BUSY");

    release();
    const result = await updating;
    assert.deepEqual(result, { outcome: "updated", before: "2024.04.09", after: "2025.02.02" });
    state.hold = Promise.resolve();
    assert.equal((await downloader.download("https://example.com/watch?v=10")).fileName, "clip.mp4", "downloads are allowed again");
  });

  test("`busy` while a real download runs", async () => {
    let release;
    state.hold = new Promise((resolve) => (release = resolve));
    const running = downloader.download("https://example.com/watch?v=11");
    const ytdlp = createYtdlpUpdate({ downloader, config: { YTDLP_PATH: "yt-dlp" }, execFile: fakeExecFile, env: { PATH: process.env.PATH } });
    state.updateStarted = false;
    assert.equal((await ytdlp.update()).outcome, "busy");
    assert.equal(state.updateStarted, false, "-U was not started");
    release();
    await running;
  });
});
