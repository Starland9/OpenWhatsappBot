"use strict";
/**
 * lib/utils/safeFs.js (specs/002-admin-panel T017, runtime.md section 14).
 *
 *  - measure never follows symlinks and respects maxEntries / maxDepth / budgetMs;
 *  - purgeChildren deletes children only, unlinks symlinks without following them, skips
 *    .gitkeep, honours olderThanMs and skip;
 *  - truncateFiles truncates instead of unlinking;
 *  - assertInside rejects `..`, a symlink escaping the root and a sibling sharing the prefix.
 *
 * Everything happens in fs.mkdtemp directories; the real data/, sessions/ and media/ are never touched.
 */

const { test, describe, before, after, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const safeFs = require("../lib/utils/safeFs");

let tmp; // per-suite root
let base; // per-test directory
let counter = 0;

const put = (rel, content = "") => {
  const file = path.join(base, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};
const mkdir = (rel) => {
  const dir = path.join(base, rel);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const symlink = (target, rel) => {
  const link = path.join(base, rel);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link);
  return link;
};

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-safefs-"));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  base = path.join(tmp, `case-${++counter}`);
  fs.mkdirSync(base, { recursive: true });
});
afterEach(() => {
  mock.restoreAll();
});

describe("measure", () => {
  test("sums bytes and files of a tree (directories add nothing)", async () => {
    const dir = mkdir("tree");
    put("tree/a.bin", "x".repeat(100));
    put("tree/sub/b.bin", "x".repeat(50));
    put("tree/sub/deeper/c.bin", "x".repeat(7));
    mkdir("tree/empty");
    assert.deepEqual(await safeFs.measure(dir), { bytes: 157, files: 3, truncated: false });
  });

  test("a missing directory, a file and an empty directory measure zero", async () => {
    const empty = mkdir("empty");
    const file = put("file.txt", "hello");
    assert.deepEqual(await safeFs.measure(path.join(base, "nope")), { bytes: 0, files: 0, truncated: false });
    assert.deepEqual(await safeFs.measure(file), { bytes: 0, files: 0, truncated: false });
    assert.deepEqual(await safeFs.measure(empty), { bytes: 0, files: 0, truncated: false });
  });

  test("never follows symlinks: a link is one small file, its target is not measured, loops end", async () => {
    const outside = mkdir("outside");
    put("outside/huge.bin", "x".repeat(10000));
    const dir = mkdir("watched");
    put("watched/own.bin", "x".repeat(10));
    symlink(outside, "watched/link-to-dir");
    symlink(path.join(outside, "huge.bin"), "watched/link-to-file");
    symlink(dir, "watched/loop");

    const result = await safeFs.measure(dir);
    assert.equal(result.files, 4, "own file + three links");
    assert.ok(result.bytes < 10 + 3 * 300, `bytes ${result.bytes} must not include the 10000 bytes behind the links`);
    assert.equal(result.truncated, false);
  });

  test("a symlink given as the directory itself is not measured", async () => {
    const real = mkdir("real");
    put("real/a.bin", "x".repeat(10));
    const link = symlink(real, "link");
    assert.deepEqual(await safeFs.measure(link), { bytes: 0, files: 0, truncated: false });
  });

  test("maxEntries bounds the visit and reports truncated", async () => {
    const dir = mkdir("many");
    for (let i = 0; i < 10; i++) put(`many/f${i}.bin`, "xx");
    const cut = await safeFs.measure(dir, { maxEntries: 5 });
    assert.equal(cut.truncated, true);
    assert.equal(cut.files, 5);
    assert.equal(cut.bytes, 10);
    assert.deepEqual(await safeFs.measure(dir, { maxEntries: 10 }), { bytes: 20, files: 10, truncated: false }, "exactly at the bound is complete");
  });

  test("maxDepth bounds how deep directories are entered, and other branches are still measured", async () => {
    const dir = mkdir("deep");
    put("deep/top.bin", "1");
    put("deep/l1/one.bin", "22");
    put("deep/l1/l2/two.bin", "333");
    put("deep/other/side.bin", "4444");

    assert.deepEqual(await safeFs.measure(dir, { maxDepth: 0 }), { bytes: 1, files: 1, truncated: true });
    // depth 1 enters l1 and other, but not l1/l2
    assert.deepEqual(await safeFs.measure(dir, { maxDepth: 1 }), { bytes: 7, files: 3, truncated: true });
    assert.deepEqual(await safeFs.measure(dir, { maxDepth: 2 }), { bytes: 10, files: 4, truncated: false });
  });

  test("budgetMs stops the walk (injected clock)", async () => {
    const dir = mkdir("slow");
    for (let i = 0; i < 20; i++) put(`slow/f${i}.bin`, "x");
    let t = 0;
    const clock = () => (t += 10); // each read costs 10 ms
    const result = await safeFs.measure(dir, { budgetMs: 55, clock });
    assert.equal(result.truncated, true);
    assert.ok(result.files > 0 && result.files < 20, `files ${result.files}`);
  });

  test("gives control back to the event loop every 200 entries", async () => {
    const dir = mkdir("loop");
    for (let i = 0; i < 450; i++) put(`loop/f${i}.bin`, "");
    const spy = mock.method(global, "setImmediate");
    const result = await safeFs.measure(dir);
    assert.equal(result.files, 450);
    assert.equal(spy.mock.calls.length, 2, "at entries 200 and 400");
  });
});

describe("purgeChildren", () => {
  test("deletes the children, never the target", async () => {
    const dir = mkdir("target");
    put("target/a.bin", "x".repeat(10));
    put("target/sub/b.bin", "x".repeat(20));
    put("target/sub/deeper/c.bin", "x".repeat(5));
    const result = await safeFs.purgeChildren(dir);
    assert.deepEqual(result, { freedBytes: 35, removed: 2, skipped: 0 });
    assert.ok(exists(dir), "the target stays");
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test("unlinks a symlink without following it", async () => {
    const outside = mkdir("outside");
    const precious = put("outside/precious.txt", "keep me");
    const dir = mkdir("target");
    symlink(outside, "target/link-to-dir");
    symlink(precious, "target/link-to-file");
    mkdir("target/real");
    symlink(outside, "target/real/inner-link");

    const result = await safeFs.purgeChildren(dir);
    assert.equal(result.removed, 3);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(fs.readFileSync(precious, "utf8"), "keep me", "nothing behind a link was deleted");
    assert.ok(exists(outside));
  });

  test("skips .gitkeep", async () => {
    const dir = mkdir("target");
    put("target/.gitkeep", "");
    put("target/a.bin", "x");
    const result = await safeFs.purgeChildren(dir);
    assert.deepEqual(fs.readdirSync(dir), [".gitkeep"]);
    assert.deepEqual(result, { freedBytes: 1, removed: 1, skipped: 1 });
  });

  test("olderThanMs keeps recent children (files and directories)", async () => {
    const dir = mkdir("target");
    const old = put("target/old.bin", "xxxx");
    const recent = put("target/recent.bin", "xx");
    const oldDir = mkdir("target/old-dir");
    put("target/old-dir/in.bin", "x");
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);
    const at = (msAgo) => new Date(now - msAgo);
    fs.utimesSync(old, at(3 * 60 * 1000), at(3 * 60 * 1000));
    fs.utimesSync(recent, at(10 * 1000), at(10 * 1000));
    fs.utimesSync(oldDir, at(5 * 60 * 1000), at(5 * 60 * 1000));

    const result = await safeFs.purgeChildren(dir, { olderThanMs: 60 * 1000, now });
    assert.deepEqual(fs.readdirSync(dir), ["recent.bin"]);
    assert.deepEqual(result, { freedBytes: 5, removed: 2, skipped: 1 });
  });

  test("skip as a predicate or as a list of names", async () => {
    const dir = mkdir("target");
    put("target/keep.txt", "k");
    put("target/drop.txt", "d");
    put("target/also-keep.txt", "k");
    mkdir("target/folder");

    const byPredicate = await safeFs.purgeChildren(dir, { skip: (name) => name.endsWith("keep.txt") });
    assert.deepEqual(fs.readdirSync(dir).sort(), ["also-keep.txt", "keep.txt"]);
    assert.deepEqual([byPredicate.removed, byPredicate.skipped], [2, 2]);

    const byList = await safeFs.purgeChildren(dir, { skip: ["keep.txt"] });
    assert.deepEqual(fs.readdirSync(dir), ["keep.txt"]);
    assert.deepEqual([byList.removed, byList.skipped], [1, 1]);

    await safeFs.purgeChildren(dir, { skip: new Set(["keep.txt"]) });
    assert.deepEqual(fs.readdirSync(dir), ["keep.txt"]);
  });

  test("a missing target is empty; a symlinked or non-directory target is refused", async () => {
    assert.deepEqual(await safeFs.purgeChildren(path.join(base, "nope")), { freedBytes: 0, removed: 0, skipped: 0 });

    const real = mkdir("real");
    const inside = put("real/a.bin", "x");
    const link = symlink(real, "link");
    await assert.rejects(safeFs.purgeChildren(link), { code: "symlink_target" });
    assert.ok(exists(inside), "nothing was deleted through the link");

    const file = put("file.txt", "x");
    await assert.rejects(safeFs.purgeChildren(file), { code: "not_a_directory" });
    assert.ok(exists(file));
  });

  test("an entry that cannot be removed is counted as skipped and the others still go", async () => {
    const dir = mkdir("target");
    put("target/a.bin", "x");
    put("target/b.bin", "x");
    const realUnlink = fs.promises.unlink;
    mock.method(fs.promises, "unlink", async (file) => {
      if (String(file).endsWith("a.bin")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return realUnlink(file);
    });
    const result = await safeFs.purgeChildren(dir);
    assert.deepEqual([result.removed, result.skipped], [1, 1]);
    assert.deepEqual(fs.readdirSync(dir), ["a.bin"]);
  });
});

describe("truncateFiles", () => {
  test("truncates the matching files instead of unlinking them", async () => {
    const dir = mkdir("logs");
    const out = put("logs/out.log", "x".repeat(100));
    const err = put("logs/error.log", "y".repeat(40));
    const other = put("logs/notes.txt", "z".repeat(30));
    const inode = fs.statSync(out).ino;

    const result = await safeFs.truncateFiles(dir, "*.log");
    assert.deepEqual(result, { freedBytes: 140, files: 2 });
    assert.equal(fs.statSync(out).size, 0);
    assert.equal(fs.statSync(err).size, 0);
    assert.equal(fs.statSync(out).ino, inode, "same file, still there");
    assert.equal(fs.statSync(other).size, 30, "non-matching file untouched");
  });

  test("accepts a RegExp or a predicate, and never recurses", async () => {
    const dir = mkdir("logs");
    const a = put("logs/a.log", "xx");
    const nested = put("logs/sub/b.log", "yy");
    assert.equal((await safeFs.truncateFiles(dir, /\.log$/)).files, 1);
    assert.equal(fs.statSync(a).size, 0);
    assert.equal(fs.statSync(nested).size, 2, "sub-directories are not entered");
    put("logs/c.out", "zz");
    assert.equal((await safeFs.truncateFiles(dir, (name) => name.endsWith(".out"))).files, 1);
    await assert.rejects(safeFs.truncateFiles(dir, 42), TypeError);
  });

  test("does not follow a symlink named like a log, and skips directories", async () => {
    const outside = put("outside/precious.log", "keep me");
    const dir = mkdir("logs");
    symlink(outside, "logs/link.log");
    mkdir("logs/folder.log");
    const result = await safeFs.truncateFiles(dir, "*.log");
    assert.deepEqual(result, { freedBytes: 0, files: 0 });
    assert.equal(fs.readFileSync(outside, "utf8"), "keep me");
  });

  test("a missing directory is empty", async () => {
    assert.deepEqual(await safeFs.truncateFiles(path.join(base, "nope"), "*.log"), { freedBytes: 0, files: 0 });
  });
});

describe("assertInside", () => {
  test("accepts existing and not yet existing paths under the root, and returns the real path", async () => {
    const root = mkdir("data");
    const file = put("data/sub/a.png", "x");
    const real = fs.realpathSync(root);
    assert.equal(await safeFs.assertInside(root, file), path.join(real, "sub", "a.png"));
    assert.equal(await safeFs.assertInside(root, path.join(root, "sub", "new", "b.png")), path.join(real, "sub", "new", "b.png"));
    assert.equal(await safeFs.assertInside(root, "sub/a.png"), path.join(real, "sub", "a.png"), "relative to the root");
  });

  test("rejects `..` in every spelling", async () => {
    const root = mkdir("data");
    mkdir("secret");
    for (const candidate of [
      path.join(root, "..", "secret"),
      "../secret",
      "sub/../../secret",
      `${root}/sub/../a.png`, // even a `..` that comes back inside
      `${root}/../data/a.png`,
    ]) {
      await assert.rejects(safeFs.assertInside(root, candidate), { code: "outside_root" }, candidate);
    }
  });

  test("rejects a symlink that leaves the root, whether the target exists or not", async () => {
    const root = mkdir("data");
    const outside = mkdir("outside");
    put("outside/secret.txt", "s");
    symlink(outside, "data/escape");
    symlink(path.join(base, "not-created-yet"), "data/dangling");
    await assert.rejects(safeFs.assertInside(root, path.join(root, "escape")), { code: "outside_root" });
    await assert.rejects(safeFs.assertInside(root, path.join(root, "escape", "secret.txt")), { code: "outside_root" });
    await assert.rejects(safeFs.assertInside(root, path.join(root, "escape", "new-file.txt")), { code: "outside_root" });
    await assert.rejects(safeFs.assertInside(root, path.join(root, "dangling")), { code: "outside_root" });
  });

  test("rejects a symlink loop", async () => {
    const root = mkdir("data");
    symlink(path.join(root, "b"), "data/a");
    symlink(path.join(root, "a"), "data/b");
    await assert.rejects(safeFs.assertInside(root, path.join(root, "a")), { code: "outside_root" });
    await assert.rejects(safeFs.assertInside(root, path.join(root, "a", "x")), { code: "outside_root" });
  });

  test("accepts a symlink that stays inside the root", async () => {
    const root = mkdir("data");
    const target = put("data/real/a.txt", "x");
    symlink(path.join(root, "real"), "data/alias");
    assert.equal(await safeFs.assertInside(root, path.join(root, "alias", "a.txt")), fs.realpathSync(target));
  });

  test("rejects a sibling directory that shares the prefix (/a/data vs /a/data2)", async () => {
    const root = mkdir("data");
    const sibling = mkdir("data2");
    put("data2/file.txt", "x");
    await assert.rejects(safeFs.assertInside(root, sibling), { code: "outside_root" });
    await assert.rejects(safeFs.assertInside(root, path.join(sibling, "file.txt")), { code: "outside_root" });
    await assert.rejects(safeFs.assertInside(root, path.join(base, "data-evil", "x")), { code: "outside_root" });
  });

  test("rejects the root itself, other absolute paths and junk", async () => {
    const root = mkdir("data");
    await assert.rejects(safeFs.assertInside(root, root), { code: "outside_root" });
    await assert.rejects(safeFs.assertInside(root, "/etc/passwd"), { code: "outside_root" });
    for (const candidate of ["", undefined, null, 42, "a\0b"]) {
      await assert.rejects(safeFs.assertInside(root, candidate), { code: "outside_root" });
    }
    await assert.rejects(safeFs.assertInside("", "a"), { code: "outside_root" });
  });

  test("a root given through a symlink works; a missing root is reported", async () => {
    const real = mkdir("real-root");
    const link = symlink(real, "root-link");
    const file = put("real-root/a.txt", "x");
    assert.equal(await safeFs.assertInside(link, path.join(link, "a.txt")), fs.realpathSync(file));
    await assert.rejects(safeFs.assertInside(path.join(base, "nope"), "a"), { code: "root_not_found" });
  });
});
