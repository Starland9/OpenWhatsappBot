"use strict";

/**
 * Safe file-system helpers for the storage page and the media directories
 * (specs/002-admin-panel: contracts/runtime.md section 14, FR-053 to FR-056).
 *
 *   measure(dir, { maxEntries, maxDepth, budgetMs })   -> { bytes, files, truncated }
 *   purgeChildren(dir, { olderThanMs, skip })          -> { freedBytes, removed, skipped }
 *   truncateFiles(dir, pattern)                        -> { freedBytes, files }
 *   assertInside(root, candidate)                      -> the real path of the candidate
 *
 * Rules shared by all of them:
 *  - every entry is `lstat`'d; a symlink is never followed (measured as the link itself,
 *    unlinked by a purge, skipped by a truncate);
 *  - a purge deletes CHILDREN of the target, never the target, and refuses a target that is
 *    itself a symlink (`symlink_target`) or not a directory (`not_a_directory`);
 *  - `.gitkeep` is never deleted;
 *  - a missing directory is an empty one (zero results), other I/O errors on single entries are
 *    skipped, never thrown;
 *  - nothing here knows the repository layout: callers pass constant paths (the HTTP request only
 *    carries a category id) and `assertInside` guards the paths built from stored names.
 *
 * Errors are `Error`s with a stable `code`: `outside_root`, `root_not_found`, `symlink_target`,
 * `not_a_directory`. Requires Node built-ins only, no timer, no clock besides the injectable
 * `clock` (measure) and `now` (purge).
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const YIELD_EVERY = 200; // entries between two `setImmediate` turns, so a big tree never starves the event loop
const GITKEEP = ".gitkeep";

function fsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const isMissing = (err) => err?.code === "ENOENT" || err?.code === "ENOTDIR";
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));
const toMillis = (now) => (now instanceof Date ? now.getTime() : Number.isFinite(now) ? Number(now) : Date.now());

// ---------------------------------------------------------------------------
// measure
// ---------------------------------------------------------------------------

/**
 * Size of a directory tree. Bounded three ways, and `truncated: true` says a bound was hit
 * (the figures are then a lower bound):
 *  - `maxEntries`: entries visited (files, links and directories);
 *  - `maxDepth`: directories below `dir` that are entered (0 = `dir` only);
 *  - `budgetMs`: wall time, read through `clock` (default `Date.now`).
 * A symlink counts as one file of its own size and is never entered. Directories themselves add
 * no bytes. A missing, unreadable or non-directory `dir` measures zero.
 *
 * @param {string} dir
 * @param {{ maxEntries?: number, maxDepth?: number, budgetMs?: number, clock?: () => number }} [options]
 * @returns {Promise<{ bytes: number, files: number, truncated: boolean }>}
 */
async function measure(dir, { maxEntries = 50000, maxDepth = 4, budgetMs = 2000, clock = Date.now } = {}) {
  const result = { bytes: 0, files: 0, truncated: false };

  let rootStat;
  try {
    rootStat = await fsp.lstat(dir);
  } catch (err) {
    if (isMissing(err)) return result;
    throw err;
  }
  if (!rootStat.isDirectory()) return result;

  const started = clock();
  let seen = 0;
  let halted = false; // entry or time bound hit: stop everything (a depth bound only skips one branch)
  const pending = [{ dir, depth: 0 }];

  while (pending.length > 0 && !halted) {
    const current = pending.pop();
    let handle;
    try {
      handle = await fsp.opendir(current.dir);
    } catch {
      continue; // vanished or unreadable
    }
    try {
      for await (const dirent of handle) {
        if (seen >= maxEntries || clock() - started > budgetMs) {
          result.truncated = true;
          halted = true;
          break;
        }
        seen++;
        if (seen % YIELD_EVERY === 0) await yieldToLoop();

        let stat;
        try {
          stat = await fsp.lstat(path.join(current.dir, dirent.name));
        } catch {
          continue; // removed while we were looking
        }
        if (stat.isDirectory()) {
          if (current.depth < maxDepth) pending.push({ dir: path.join(current.dir, dirent.name), depth: current.depth + 1 });
          else result.truncated = true; // content below the depth bound is not measured
        } else {
          result.bytes += stat.size;
          result.files++;
        }
      }
    } finally {
      await handle.close().catch(() => {}); // already closed after a full iteration
    }
  }
  return result;
}

/** Bytes and files of a tree with no bound (what a purge is about to delete) */
async function treeSize(target) {
  return measure(target, { maxEntries: Infinity, maxDepth: Infinity, budgetMs: Infinity });
}

// ---------------------------------------------------------------------------
// purgeChildren
// ---------------------------------------------------------------------------

/**
 * Turn the `skip` option into a predicate `(name, stat) -> boolean`: a function, or a list / Set
 * of child names.
 */
function skipPredicate(skip) {
  if (typeof skip === "function") return skip;
  if (skip instanceof Set || Array.isArray(skip)) {
    const names = new Set(skip);
    return (name) => names.has(name);
  }
  return () => false;
}

/**
 * Delete the children of `dir` (files, symlinks, whole sub-directories), never `dir` itself.
 * A symlink child is unlinked, never followed. `.gitkeep` is kept.
 *
 * @param {string} dir
 * @param {{ olderThanMs?: number, skip?: Function|string[]|Set<string>, now?: number|Date }} [options]
 *   `olderThanMs`: only children last modified more than that long ago (for a directory child,
 *   the directory's own mtime); `skip`: predicate `(name, stat) => boolean` or names to keep;
 *   `now`: the clock for `olderThanMs` (default `Date.now()`)
 * @returns {Promise<{ freedBytes: number, removed: number, skipped: number }>}
 */
async function purgeChildren(dir, { olderThanMs, skip, now } = {}) {
  const result = { freedBytes: 0, removed: 0, skipped: 0 };

  let rootStat;
  try {
    rootStat = await fsp.lstat(dir);
  } catch (err) {
    if (isMissing(err)) return result;
    throw err;
  }
  if (rootStat.isSymbolicLink()) throw fsError("symlink_target", "refusing to purge through a symlink");
  if (!rootStat.isDirectory()) throw fsError("not_a_directory", "purge target is not a directory");

  const keep = skipPredicate(skip);
  const at = toMillis(now);
  const names = await fsp.readdir(dir);

  for (let i = 0; i < names.length; i++) {
    if (i > 0 && i % YIELD_EVERY === 0) await yieldToLoop();
    const name = names[i];
    const target = path.join(dir, name);
    try {
      const stat = await fsp.lstat(target);
      if (name === GITKEEP || keep(name, stat) || (olderThanMs > 0 && at - stat.mtimeMs < olderThanMs)) {
        result.skipped++;
        continue;
      }
      if (stat.isDirectory()) {
        const { bytes } = await treeSize(target);
        await fsp.rm(target, { recursive: true, force: true });
        result.freedBytes += bytes;
      } else {
        await fsp.unlink(target); // regular file or symlink (the link itself)
        result.freedBytes += stat.size;
      }
      result.removed++;
    } catch {
      result.skipped++; // busy, permission, vanished: leave it
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// truncateFiles
// ---------------------------------------------------------------------------

/** Name matcher from a RegExp, a predicate, or a glob (`*` and `?`) */
function nameMatcher(pattern) {
  if (pattern instanceof RegExp) return (name) => new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(name);
  if (typeof pattern === "function") return pattern;
  if (typeof pattern === "string" && pattern) {
    const source = pattern
      .split("")
      .map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("");
    const regex = new RegExp(`^${source}$`);
    return (name) => regex.test(name);
  }
  throw new TypeError("pattern must be a RegExp, a function or a glob string");
}

/**
 * Truncate to zero the regular files of `dir` (not recursive) whose name matches `pattern`.
 * The files stay (a process such as PM2 may hold their descriptors). A symlink is skipped, and the
 * file is opened with `O_NOFOLLOW` where the platform has it.
 *
 * @param {string} dir
 * @param {RegExp|string|Function} pattern glob such as `*.log`, a RegExp, or `(name) => boolean`
 * @returns {Promise<{ freedBytes: number, files: number }>}
 */
async function truncateFiles(dir, pattern) {
  const matches = nameMatcher(pattern);
  const result = { freedBytes: 0, files: 0 };

  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if (isMissing(err)) return result;
    throw err;
  }

  const flags = fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0);
  for (const name of names) {
    if (!matches(name)) continue;
    const file = path.join(dir, name);
    let handle;
    try {
      const stat = await fsp.lstat(file);
      if (!stat.isFile()) continue;
      handle = await fsp.open(file, flags);
      const { size } = await handle.stat();
      await handle.truncate(0);
      result.freedBytes += size;
      result.files++;
    } catch {
      // symlink swapped in, busy or unreadable: leave it
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// assertInside
// ---------------------------------------------------------------------------

/**
 * realpath of a path that may not exist yet: the nearest existing ancestor is resolved, the rest
 * appended. A path that exists as a dangling symlink (or a link loop) is refused: writing through
 * it would create a file wherever it points.
 */
async function realpathLoose(target) {
  const missing = [];
  let current = target;
  for (;;) {
    try {
      return path.join(await fsp.realpath(current), ...missing.reverse());
    } catch (err) {
      if (!isMissing(err)) throw fsError("outside_root", "path cannot be resolved inside the root");
      const exists = await fsp.lstat(current).then(() => true, () => false);
      if (exists) throw fsError("outside_root", "path is a dangling symlink");
      const parent = path.dirname(current);
      if (parent === current) throw err;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Check that `candidate` stays strictly under `root` once symlinks are resolved:
 * `realpath(candidate)` must start with `realpath(root) + path.sep`. A candidate that does not
 * exist yet is checked through its nearest existing ancestor. Rejected: a `..` segment (even one
 * that would come back inside), a symlink that leaves the root, a sibling that shares the prefix
 * (`/a/data2` against `/a/data`), the root itself.
 *
 * @param {string} root directory that must exist
 * @param {string} candidate absolute, or relative to `root`
 * @returns {Promise<string>} the real path of the candidate: use it, not the input
 * @throws {Error} code `outside_root`, or `root_not_found`
 */
async function assertInside(root, candidate) {
  if (typeof root !== "string" || !root || typeof candidate !== "string" || !candidate || candidate.includes("\0")) {
    throw fsError("outside_root", "path is not inside the root");
  }
  if (candidate.split(/[\\/]+/).includes("..")) throw fsError("outside_root", "path is not inside the root");

  let realRoot;
  try {
    realRoot = await fsp.realpath(root);
  } catch (err) {
    if (isMissing(err)) throw fsError("root_not_found", "root does not exist");
    throw err;
  }

  const real = await realpathLoose(path.resolve(realRoot, candidate));
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (!real.startsWith(prefix)) throw fsError("outside_root", "path is not inside the root");
  return real;
}

module.exports = {
  measure,
  purgeChildren,
  truncateFiles,
  assertInside,
};
