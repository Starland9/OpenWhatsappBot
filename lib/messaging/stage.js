"use strict";

/**
 * Staged media of the messaging API (feature 004, contracts/runtime.md section 10.3, data-model.md section 7).
 * A message with a file keeps it in `data/api-media/<publicId>/`: the file is called `source` (a fixed name, no
 * caller-controlled name ever reaches the disk) and a converted copy sits beside it as `prepared.<ext>`.
 *
 *   rootDir()                        data/api-media (computed at call time)
 *   dirOf(publicId)                  the directory of one message; the id is validated BEFORE any path is built
 *   adopt(publicId, tempPath, { mode })  "move" (default: rename, copy plus unlink on EXDEV) or "copy" into
 *                                    <dir>/source (0600) in a 0700 directory -> { mediaPath } (repo-relative)
 *   remove(publicId)                 idempotent
 *   list()                           [{ name, mtimeMs, bytes }] of the staged directories
 *   absolute(mediaPath)              a stored mediaPath back to an absolute path inside the stage root
 *   assertStaged(file, dir)          sync, lexical: the path a format hands to Baileys is absolute, never a URL
 *                                    and inside `dir` (RT-101); the realpath-based `safeFs.assertInside` runs in
 *                                    adopt/remove/list and is the engine's check before a send
 *   preparedFile(dir, ext)           <dir>/prepared.<ext>
 *   createStage({ rootDir, dataDir, fs })  an instance over another repository/data root (tests); the module's own
 *                                    exports are the default instance (the repository's data/)
 *
 * Errors are plain Errors with a stable `code`: invalid_public_id, invalid_extension, outside_root, not_a_file.
 * Only Node built-ins and lib/utils/safeFs.js; no work at require.
 */

const fsp = require("node:fs/promises");
const path = require("node:path");
const safeFs = require("../utils/safeFs");

const PUBLIC_ID = /^msg_[A-Za-z0-9_-]{22}$/;
const SOURCE_NAME = "source";
const PREPARED = /^prepared\.[a-z0-9]{1,8}$/;
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const stageError = (code, message) => Object.assign(new Error(message || code), { code });

const isInside = (dir, file) => {
  const relative = path.relative(dir, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/** Sync and lexical (a format's build() is sync): absolute, not a URL, no traversal, inside `dir` when given */
function assertStaged(file, dir) {
  if (
    typeof file !== "string" ||
    !file ||
    file.includes("\0") ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(file) ||
    !path.isAbsolute(file) ||
    file.split(/[\\/]+/).includes("..")
  ) {
    throw stageError("outside_root", "the path is not a staged file");
  }
  if (dir !== undefined && dir !== null && !isInside(dir, file)) throw stageError("outside_root", "the path is outside the stage directory");
  return file;
}

function preparedFile(dir, ext) {
  const clean = typeof ext === "string" ? ext.replace(/^\./, "").toLowerCase() : "";
  if (!/^[a-z0-9]{1,8}$/.test(clean)) throw stageError("invalid_extension", "invalid extension");
  return path.join(dir, `prepared.${clean}`);
}

function createStage(options = {}) {
  const fs = options.fs || fsp;
  const repoRoot = () => path.resolve(options.rootDir || REPO_ROOT);
  const dataDir = () => path.resolve(options.dataDir || path.join(repoRoot(), "data"));
  const rootDir = () => path.join(dataDir(), "api-media");

  function dirOf(publicId) {
    if (typeof publicId !== "string" || !PUBLIC_ID.test(publicId)) throw stageError("invalid_public_id", "invalid message id");
    const dir = path.join(rootDir(), publicId);
    if (!isInside(rootDir(), dir)) throw stageError("outside_root", "the directory is outside the stage root");
    return dir;
  }

  function absolute(mediaPath) {
    if (typeof mediaPath !== "string" || !mediaPath || mediaPath.includes("\0")) throw stageError("outside_root", "invalid media path");
    const file = path.resolve(repoRoot(), mediaPath);
    const relative = path.relative(rootDir(), file).split(path.sep);
    const [id, name, ...rest] = relative;
    if (rest.length || !PUBLIC_ID.test(id || "") || !(name === SOURCE_NAME || PREPARED.test(name || ""))) {
      throw stageError("outside_root", "the media path is not a staged file");
    }
    return file;
  }

  async function adopt(publicId, tempPath, { mode = "move" } = {}) {
    const dir = dirOf(publicId); // the id first
    const info = await fs.lstat(tempPath);
    if (!info.isFile()) throw stageError("not_a_file", "the source is not a regular file");

    await fs.mkdir(rootDir(), { recursive: true, mode: 0o700 });
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await safeFs.assertInside(rootDir(), dir); // a symlinked directory is refused
    await fs.chmod(dir, 0o700);

    const target = path.join(dir, SOURCE_NAME);
    if (mode === "copy") {
      await fs.copyFile(tempPath, target);
    } else {
      try {
        await fs.rename(tempPath, target);
      } catch (err) {
        if (!err || err.code !== "EXDEV") throw err;
        await fs.copyFile(tempPath, target);
        await fs.unlink(tempPath);
      }
    }
    await fs.chmod(target, 0o600);
    return { mediaPath: path.relative(repoRoot(), target).split(path.sep).join("/") };
  }

  async function remove(publicId) {
    const dir = dirOf(publicId);
    try {
      await safeFs.assertInside(rootDir(), dir);
    } catch (err) {
      if (err && err.code === "root_not_found") return; // nothing was ever staged
      throw err;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }

  async function list() {
    let entries;
    try {
      entries = await fs.readdir(rootDir(), { withFileTypes: true });
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return [];
      throw err;
    }
    const rows = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !PUBLIC_ID.test(entry.name)) continue;
      const dir = path.join(rootDir(), entry.name);
      try {
        const info = await fs.lstat(dir);
        let bytes = 0;
        for (const child of await fs.readdir(dir, { withFileTypes: true })) {
          if (!child.isFile()) continue;
          bytes += (await fs.lstat(path.join(dir, child.name))).size;
        }
        rows.push({ name: entry.name, mtimeMs: info.mtimeMs, bytes });
      } catch {
        // vanished while listing
      }
    }
    return rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  return { rootDir, dirOf, adopt, remove, list, absolute, assertStaged, preparedFile };
}

const defaultStage = createStage();

module.exports = {
  rootDir: () => defaultStage.rootDir(),
  dirOf: (publicId) => defaultStage.dirOf(publicId),
  adopt: (publicId, tempPath, opts) => defaultStage.adopt(publicId, tempPath, opts),
  remove: (publicId) => defaultStage.remove(publicId),
  list: () => defaultStage.list(),
  absolute: (mediaPath) => defaultStage.absolute(mediaPath),
  assertStaged,
  preparedFile,
  createStage,
  SOURCE_NAME,
};
