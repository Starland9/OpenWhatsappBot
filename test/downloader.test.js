"use strict";
/**
 * lib/utils/downloader.js: the yt-dlp command line.
 *
 * `--no-playlist` only applies to a link that is both a video and a playlist. A pure playlist,
 * channel or profile link (accepted by `.dl` for youtube.com, tiktok.com/@user, pinterest boards...)
 * made yt-dlp download EVERY entry (each up to MAX_UPLOAD) for the whole DOWNLOAD_TIMEOUT: any user
 * could fill the disk / bandwidth of the host. download() must ask for one item at most.
 *
 * yt-dlp is faked at the execFile level (no process is started): the fake behaves like yt-dlp on a
 * 3-entry playlist, honouring `--playlist-items`.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const calls = [];
const PLAYLIST_ENTRIES = 3;

/** Number of entries a `--playlist-items` spec selects out of `total` (only "N" and "A:B" forms) */
function selectedCount(spec, total) {
  if (spec === undefined) return total;
  const range = /^(\d*):(\d*)$/.exec(spec);
  if (range) {
    const start = Number(range[1] || 1);
    const stop = Math.min(total, Number(range[2] || total));
    return Math.max(0, stop - start + 1);
  }
  return String(spec)
    .split(",")
    .filter((n) => Number(n) >= 1 && Number(n) <= total).length;
}

// Must be installed before the downloader is required: it captures execFile at load time
childProcess.execFile = function fakeYtDlp(file, args, options, callback) {
  calls.push({ file, args: args.slice() });
  const outputTemplate = args[args.indexOf("-o") + 1];
  const itemsAt = args.indexOf("--playlist-items");
  const count = selectedCount(itemsAt >= 0 ? args[itemsAt + 1] : undefined, PLAYLIST_ENTRIES);

  const lines = [];
  for (let i = 1; i <= count; i++) {
    const filepath = outputTemplate.replace("%(id)s", `entry-${i}`).replace("%(ext)s", "mp4");
    fs.writeFileSync(filepath, Buffer.alloc(1024, i));
    lines.push(JSON.stringify({ filepath, title: `entry ${i}`, id: `entry-${i}`, ext: "mp4" }));
  }
  setImmediate(() => callback(null, `${lines.join("\n")}\n`, ""));
  return { kill() {}, on() {} };
};

const downloader = require("../lib/utils/downloader");

test("download() asks yt-dlp for one item at most: a playlist / channel link downloads one entry", async () => {
  const media = await downloader.download("https://www.youtube.com/playlist?list=PL0123456789abcdef");

  assert.equal(calls.length, 1, "yt-dlp is started once");
  const { args } = calls[0];
  const tempDir = path.dirname(args[args.indexOf("-o") + 1]);

  const itemsAt = args.indexOf("--playlist-items");
  assert.ok(itemsAt >= 0, `--playlist-items missing from the yt-dlp arguments: ${args.join(" ")}`);
  assert.equal(selectedCount(args[itemsAt + 1], 100), 1, "at most one playlist entry");
  assert.ok(itemsAt < args.indexOf("--"), "options come before the `--` separator");
  assert.equal(args[args.length - 1], "https://www.youtube.com/playlist?list=PL0123456789abcdef");

  // The fake wrote exactly what yt-dlp would have downloaded with these arguments
  assert.equal(media.mimetype, "video/mp4");
  assert.equal(media.buffer.length, 1024);
  assert.equal(media.title, "entry 1");

  // The temporary directory is removed afterwards
  await assert.rejects(fs.promises.readdir(tempDir), { code: "ENOENT" });
});
