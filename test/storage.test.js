"use strict";
/**
 * lib/admin/services/storage.js (specs/002-admin-panel: contracts/runtime.md section 14, admin-http-api.md MNT-6 and
 * MNT-7; FR-056, US11 scenario 4, research D3, U5, U15). Temporary directories only: the service is given a
 * `rootDir`, a `dataDir` and a `tmpDir` inside fs.mkdtemp, so nothing here can reach the real media/, data/,
 * sessions/, logs/ or database.
 *
 *  - the six categories with bytes / files / truncated, free disk, a 30 s cache, one refresh per 5 s;
 *  - purge removes children only, never follows a symlink, never touches sessions/, data/ (other than
 *    data/backups), the media/ root, the database or data/status_save.json;
 *  - temp_media skips entries newer than 60 s and takes the old crash leftovers of the OS temp dir;
 *  - logs are truncated (same file, same inode), not unlinked;
 *  - database is not_purgeable; broadcast_media goes through broadcaster.purgeFinishedMedia only;
 *  - antidelete_cache through getCacheStats() / clearCache(); one purge at a time per category.
 */

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { createStorageService, CATEGORY_IDS } = require("../lib/admin/services/storage");
const { createClock } = require("./helpers/fakeClock");

const MINUTE = 60 * 1000;

let root; // the "installation"
let outside; // a directory a symlink may point at: it must never lose a file
let tmp; // stands in for os.tmpdir()
let antiDelete;
let broadcaster;
let models;
let dbFile;

const write = (file, text = "x", ageMs = 0) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
  }
  return file;
};
const exists = (file) => fs.existsSync(file);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-storage-root-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "owb-storage-outside-"));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-storage-tmp-"));
  dbFile = path.join(root, "database.db");

  // things that must survive every purge
  write(path.join(root, "sessions", "main", "creds.json"), "SESSION");
  write(path.join(root, "data", "status_save.json"), "[]");
  write(path.join(root, "data", "panel.key"), "KEY");
  write(path.join(root, "media", "black.jpg"), "ASSET");
  write(dbFile, "d".repeat(1000));
  write(`${dbFile}-wal`, "w".repeat(200));
  write(path.join(outside, "precious.txt"), "PRECIOUS");

  const stats = { entries: 3, chats: 2, bytes: 120 };
  antiDelete = {
    statsCalls: 0,
    clearCalls: 0,
    getCacheStats() {
      this.statsCalls += 1;
      return { ...stats };
    },
    clearCache() {
      this.clearCalls += 1;
      const dropped = { ...stats };
      stats.entries = 0;
      stats.chats = 0;
      stats.bytes = 0;
      return dropped;
    },
  };
  broadcaster = {
    calls: [],
    gate: null,
    async purgeFinishedMedia(options) {
      this.calls.push(options);
      if (this.gate) await this.gate;
      return { freedBytes: 300, removed: 1, skipped: 2 };
    },
  };
  models = {
    DATABASE: { getDialect: () => "sqlite", options: { storage: dbFile } },
    Broadcast: { findAll: async () => [] },
    BroadcastRun: { findAll: async () => [] },
  };
});

afterEach(() => {
  for (const dir of [root, outside, tmp]) fs.rmSync(dir, { recursive: true, force: true });
});

function service(extra = {}) {
  return createStorageService({
    rootDir: root,
    dataDir: path.join(root, "data"),
    tmpDir: tmp,
    models,
    antiDeleteHandler: antiDelete,
    broadcaster,
    statfs: async () => ({ bsize: 4096, blocks: 1000, bavail: 250 }),
    ...extra,
  });
}

const byId = (list) => Object.fromEntries(list.categories.map((c) => [c.id, c]));

describe("list: the six real categories", () => {
  test("ids in order, each with bytes, files and truncated; disk from statfs", async () => {
    write(path.join(root, "media", "temp", "a.bin"), "a".repeat(100));
    write(path.join(root, "media", "temp", "sub", "b.bin"), "b".repeat(50));
    write(path.join(root, "data", "broadcast-media", "1", "pic.png"), "p".repeat(400));
    write(path.join(root, "data", "backups", "pre-restore-1.owb"), "o".repeat(70));
    write(path.join(root, "logs", "out.log"), "l".repeat(30));
    write(path.join(root, "logs", "err.log"), "e".repeat(20));
    write(path.join(root, "logs", "notes.txt"), "n".repeat(999)); // not a *.log: not counted

    const list = await service().list();
    assert.deepEqual(CATEGORY_IDS, ["temp_media", "broadcast_media", "antidelete_cache", "panel_backups", "logs", "database"]);
    assert.deepEqual(list.categories.map((c) => c.id), CATEGORY_IDS);
    for (const c of list.categories) {
      assert.equal(typeof c.bytes, "number", c.id);
      assert.equal(typeof c.files, "number", c.id);
      assert.equal(c.truncated, false, c.id);
      assert.match(c.measuredAt, /^\d{4}-\d\d-\d\dT/);
    }
    const cats = byId(list);
    assert.equal(cats.temp_media.bytes, 150);
    assert.equal(cats.temp_media.files, 2);
    assert.equal(cats.broadcast_media.bytes, 400);
    assert.equal(cats.panel_backups.bytes, 70);
    assert.equal(cats.logs.bytes, 50);
    assert.equal(cats.logs.files, 2);
    assert.deepEqual(list.disk, { freeBytes: 250 * 4096, totalBytes: 1000 * 4096 });

    assert.equal(cats.antidelete_cache.unit, "messages");
    assert.equal(cats.antidelete_cache.items, 3);
    assert.equal(cats.antidelete_cache.bytes, 120);

    assert.equal(cats.database.bytes, 1200, "the file and its -wal");
    assert.equal(cats.database.files, 2);
    assert.equal(cats.database.dialect, "sqlite");
    assert.deepEqual(
      list.categories.map((c) => [c.id, c.purgeable]),
      CATEGORY_IDS.map((id) => [id, id !== "database"]),
    );
  });

  test("nothing exists yet: every category is zero, the page still answers", async () => {
    fs.rmSync(path.join(root, "media"), { recursive: true });
    const cats = byId(await service().list());
    for (const id of ["temp_media", "broadcast_media", "panel_backups", "logs"]) assert.equal(cats[id].bytes, 0, id);
  });

  test("the walk is bounded: `truncated` says the figure is a lower bound", async () => {
    const real = require("../lib/utils/safeFs");
    const bounded = { ...real, measure: async () => ({ bytes: 5, files: 1, truncated: true }) };
    const cats = byId(await service({ safeFs: bounded }).list());
    assert.equal(cats.temp_media.truncated, true);
    assert.equal(cats.panel_backups.truncated, true);
    assert.equal(cats.logs.truncated, false, "logs are listed, not walked");
  });

  test("broadcast_media: protectedBytes counts recurring media and one-shot media whose run is open", async () => {
    for (const id of [1, 2, 3]) write(path.join(root, "data", "broadcast-media", String(id), "m.png"), "m".repeat(100));
    models.Broadcast.findAll = async () => [
      { id: 1, kind: "recurring", mediaSize: 40 },
      { id: 2, kind: "once", mediaSize: 30 },
      { id: 3, kind: "once", mediaSize: 20 },
    ];
    models.BroadcastRun.findAll = async ({ where }) => {
      assert.deepEqual(where.broadcastId, [2, 3], "only one-shot broadcasts are looked up");
      assert.deepEqual(where.status, ["scheduled", "running"]);
      return [{ broadcastId: 2 }];
    };
    const cat = byId(await service().list()).broadcast_media;
    assert.equal(cat.bytes, 300);
    assert.equal(cat.protectedBytes, 70, "recurring (40) + one-shot with an open run (30); the final one (20) can be purged");
    assert.equal(cat.protectedItems, 2);
  });

  test("protectedBytes is null for every other category and unknown when the database does not answer", async () => {
    models.Broadcast.findAll = async () => {
      throw new Error("db down");
    };
    const cats = byId(await service().list());
    assert.equal(cats.broadcast_media.protectedBytes, null);
    assert.equal(cats.broadcast_media.protectedItems, null);
    for (const id of CATEGORY_IDS.filter((x) => x !== "broadcast_media")) assert.equal(cats[id].protectedBytes, null, id);
  });

  test("temp_media counts the old crash leftovers of the OS temp dir (owb-*, voice-*), ours only", async () => {
    write(path.join(root, "media", "temp", "a.bin"), "a".repeat(10));
    write(path.join(tmp, "owb-abc", "clip.mp4"), "c".repeat(200), 30 * MINUTE);
    fs.utimesSync(path.join(tmp, "owb-abc"), new Date(Date.now() - 30 * MINUTE), new Date(Date.now() - 30 * MINUTE));
    write(path.join(tmp, "voice-1.ogg"), "v".repeat(50), 20 * MINUTE);
    write(path.join(tmp, "owb-recent", "x"), "r".repeat(999)); // in use: younger than 15 min
    write(path.join(tmp, "unrelated.txt"), "u".repeat(999), 60 * MINUTE); // not ours by name

    const mine = byId(await service().list()).temp_media;
    assert.equal(mine.bytes, 260);
    assert.equal(mine.files, 3);

    // a leftover owned by someone else is not counted nor deleted
    const other = createStorageService({ rootDir: root, dataDir: path.join(root, "data"), tmpDir: tmp, uid: process.getuid() + 1, models, antiDeleteHandler: antiDelete, broadcaster });
    assert.equal(byId(await other.list()).temp_media.bytes, 10);
  });

  test("a category that cannot be measured reads as unknown (null), the others still answer", async () => {
    antiDelete.getCacheStats = () => {
      throw new Error("boom");
    };
    const cats = byId(await service().list());
    assert.equal(cats.antidelete_cache.bytes, null);
    assert.equal(cats.logs.bytes, 0);
  });

  test("the database size on Postgres comes from pg_database_size", async () => {
    models.DATABASE = {
      getDialect: () => "postgres",
      query: async (sql) => {
        assert.match(sql, /pg_database_size\(current_database\(\)\)/);
        return [{ size: "123456" }];
      },
    };
    const db = byId(await service().list()).database;
    assert.equal(db.bytes, 123456);
    assert.equal(db.dialect, "postgres");
  });

  test("an in-memory SQLite database measures zero", async () => {
    models.DATABASE.options.storage = ":memory:";
    assert.equal(byId(await service().list()).database.bytes, 0);
  });
});

describe("list: 30 s cache and one refresh per 5 s", () => {
  test("a second list within 30 s is answered from memory; after 30 s it measures again", async () => {
    const clock = createClock();
    const svc = service({ clock });
    await svc.list();
    assert.equal(antiDelete.statsCalls, 1);
    await clock.advance(29 * 1000);
    await svc.list();
    assert.equal(antiDelete.statsCalls, 1, "cached");
    await clock.advance(1000);
    await svc.list();
    assert.equal(antiDelete.statsCalls, 2, "30 s later: measured again");
  });

  test("concurrent lists share one measurement", async () => {
    const svc = service();
    await Promise.all([svc.list(), svc.list(), svc.list()]);
    assert.equal(antiDelete.statsCalls, 1);
  });

  test("refresh re-measures but is limited to one per 5 s (rate_limited with retryAfterMs)", async () => {
    const clock = createClock();
    const svc = service({ clock });
    await svc.list({ refresh: true });
    assert.equal(antiDelete.statsCalls, 1);

    await clock.advance(2000);
    await assert.rejects(svc.list({ refresh: true }), (err) => err.code === "rate_limited" && err.params.retryAfterMs === 3000);
    assert.equal(antiDelete.statsCalls, 1, "a refused refresh measures nothing");
    await svc.list(); // a plain list is never limited
    assert.equal(antiDelete.statsCalls, 1);

    await clock.advance(3000);
    await svc.list({ refresh: true });
    assert.equal(antiDelete.statsCalls, 2);
  });
});

describe("purge: children only, nothing outside the category", () => {
  const survivors = () => [
    path.join(root, "sessions", "main", "creds.json"),
    path.join(root, "data", "status_save.json"),
    path.join(root, "data", "panel.key"),
    path.join(root, "media", "black.jpg"),
    dbFile,
    `${dbFile}-wal`,
    path.join(outside, "precious.txt"),
  ];

  test("temp_media: old children go, entries newer than 60 s, .gitkeep and the target stay; a symlink is unlinked, never followed", async () => {
    const dir = path.join(root, "media", "temp");
    write(path.join(dir, "old.bin"), "o".repeat(100), 10 * MINUTE);
    write(path.join(dir, "folder", "inner.bin"), "i".repeat(40), 10 * MINUTE);
    fs.utimesSync(path.join(dir, "folder"), new Date(Date.now() - 10 * MINUTE), new Date(Date.now() - 10 * MINUTE));
    write(path.join(dir, "fresh.bin"), "f", 5 * 1000);
    write(path.join(dir, ".gitkeep"), "", 10 * MINUTE);
    fs.symlinkSync(outside, path.join(dir, "link-to-outside"));
    fs.lutimesSync(path.join(dir, "link-to-outside"), new Date(Date.now() - 10 * MINUTE), new Date(Date.now() - 10 * MINUTE));

    const result = await service().purge("temp_media", { confirm: true });
    assert.equal(result.removed, 3, "old.bin, folder, the symlink");
    assert.ok(result.skipped >= 2, "fresh.bin and .gitkeep");
    assert.equal(result.freedBytes >= 140, true);
    assert.ok(!exists(path.join(dir, "old.bin")));
    assert.ok(!exists(path.join(dir, "folder")));
    assert.ok(!fs.existsSync(path.join(dir, "link-to-outside")) && !fs.lstatSync(dir).isSymbolicLink());
    assert.ok(exists(path.join(dir, "fresh.bin")), "modified in the last 60 s: in use");
    assert.ok(exists(path.join(dir, ".gitkeep")));
    assert.ok(exists(dir), "the target itself is never deleted");
    for (const file of survivors()) assert.ok(exists(file), `${file} untouched`);
    assert.equal(fs.readFileSync(path.join(outside, "precious.txt"), "utf8"), "PRECIOUS");
  });

  test("temp_media also removes old leftovers of the OS temp dir (ours, owb-*/voice-*) and nothing else there", async () => {
    write(path.join(tmp, "owb-old", "a.mp4"), "a".repeat(100), 30 * MINUTE);
    fs.utimesSync(path.join(tmp, "owb-old"), new Date(Date.now() - 30 * MINUTE), new Date(Date.now() - 30 * MINUTE));
    write(path.join(tmp, "voice-old.ogg"), "v".repeat(10), 30 * MINUTE);
    write(path.join(tmp, "owb-new", "x"), "x", 1000);
    write(path.join(tmp, "unrelated-old.txt"), "u", 60 * MINUTE);
    fs.symlinkSync(outside, path.join(tmp, "owb-link"));
    fs.lutimesSync(path.join(tmp, "owb-link"), new Date(Date.now() - 60 * MINUTE), new Date(Date.now() - 60 * MINUTE));

    const result = await service().purge("temp_media", { confirm: true });
    assert.equal(result.removed, 2);
    assert.ok(!exists(path.join(tmp, "owb-old")));
    assert.ok(!exists(path.join(tmp, "voice-old.ogg")));
    assert.ok(exists(path.join(tmp, "owb-new")), "younger than 15 min");
    assert.ok(exists(path.join(tmp, "unrelated-old.txt")), "not ours by name");
    assert.ok(fs.lstatSync(path.join(tmp, "owb-link")).isSymbolicLink(), "a symlink is left alone");
    assert.ok(exists(path.join(outside, "precious.txt")));
  });

  test("a symlinked target is never followed: nothing is deleted behind it", async () => {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "data", "backups"));
    const result = await service().purge("panel_backups", { confirm: true });
    assert.equal(result.removed, 0);
    assert.equal(result.skipped, 1);
    assert.ok(exists(path.join(outside, "precious.txt")));
  });

  test("panel_backups: the pre-restore files go, restore.lock and .gitkeep stay", async () => {
    const dir = path.join(root, "data", "backups");
    write(path.join(dir, "pre-restore-1.owb"), "1".repeat(10));
    write(path.join(dir, "pre-restore-2.owb"), "2".repeat(20));
    write(path.join(dir, "restore.lock"), "LOCK");
    write(path.join(dir, ".gitkeep"), "");
    const result = await service().purge("panel_backups", { confirm: true });
    assert.equal(result.removed, 2);
    assert.equal(result.freedBytes, 30);
    assert.ok(exists(path.join(dir, "restore.lock")));
    assert.ok(exists(path.join(dir, ".gitkeep")));
    for (const file of survivors()) assert.ok(exists(file), `${file} untouched`);
  });

  test("logs are truncated, not unlinked: same file, same inode, size 0; other files are left alone", async () => {
    const out = write(path.join(root, "logs", "out.log"), "o".repeat(100));
    const err = write(path.join(root, "logs", "err.log"), "e".repeat(40));
    const notes = write(path.join(root, "logs", "notes.txt"), "keep me");
    const inode = fs.statSync(out).ino;
    const result = await service().purge("logs", { confirm: true });
    assert.equal(result.freedBytes, 140);
    assert.equal(result.removed, 2);
    assert.equal(fs.statSync(out).size, 0);
    assert.equal(fs.statSync(err).size, 0);
    assert.equal(fs.statSync(out).ino, inode, "truncated in place: PM2 keeps writing to the same descriptor");
    assert.equal(fs.readFileSync(notes, "utf8"), "keep me");
  });

  test("antidelete_cache goes through getCacheStats() / clearCache()", async () => {
    const result = await service().purge("antidelete_cache", { confirm: true });
    assert.equal(antiDelete.clearCalls, 1);
    assert.deepEqual(result, { freedBytes: 120, removed: 3, skipped: 0 });
    const cat = byId(await service().list()).antidelete_cache;
    assert.equal(cat.items, 0);
  });

  test("broadcast_media delegates to broadcaster.purgeFinishedMedia and never deletes a file itself", async () => {
    write(path.join(root, "data", "broadcast-media", "7", "recurring.png"), "R");
    write(path.join(root, "data", "broadcast-media", "8", "scheduled.png"), "S");
    const result = await service().purge("broadcast_media", { confirm: true });
    assert.equal(broadcaster.calls.length, 1);
    assert.deepEqual(result, { freedBytes: 300, removed: 1, skipped: 2 }, "what the broadcaster kept is reported in skipped");
    assert.ok(exists(path.join(root, "data", "broadcast-media", "7", "recurring.png")), "a scheduled or recurring broadcast keeps its media");
    assert.ok(exists(path.join(root, "data", "broadcast-media", "8", "scheduled.png")));
  });

  test("database: not_purgeable, and the file is untouched", async () => {
    await assert.rejects(service().purge("database", { confirm: true }), (err) => err.code === "not_purgeable");
    assert.equal(fs.statSync(dbFile).size, 1000);
  });

  test("an unknown category is not_found; a missing confirmation is confirmation_required and does nothing", async () => {
    const svc = service();
    await assert.rejects(svc.purge("sessions", { confirm: true }), (err) => err.code === "not_found" && err.params.resource === "category");
    await assert.rejects(svc.purge("../data", { confirm: true }), (err) => err.code === "not_found");
    write(path.join(root, "logs", "out.log"), "still here");
    for (const confirm of [undefined, false, "true", 1]) {
      await assert.rejects(svc.purge("logs", { confirm }), (err) => err.code === "confirmation_required");
    }
    await assert.rejects(svc.purge("antidelete_cache", {}), (err) => err.code === "confirmation_required");
    assert.equal(fs.readFileSync(path.join(root, "logs", "out.log"), "utf8"), "still here");
    assert.equal(antiDelete.clearCalls, 0);
    assert.equal(broadcaster.calls.length, 0);
  });

  test("purging every category leaves sessions/, the other data/ files, the media/ root, the database and status_save.json alone", async () => {
    write(path.join(root, "media", "temp", "t.bin"), "t", 10 * MINUTE);
    write(path.join(root, "data", "backups", "b.owb"), "b");
    write(path.join(root, "logs", "x.log"), "log");
    const svc = service();
    for (const id of CATEGORY_IDS.filter((x) => x !== "database")) await svc.purge(id, { confirm: true });
    for (const file of survivors()) assert.ok(exists(file), `${file} untouched`);
    assert.equal(fs.readFileSync(path.join(root, "sessions", "main", "creds.json"), "utf8"), "SESSION");
    assert.equal(fs.readFileSync(path.join(root, "data", "status_save.json"), "utf8"), "[]");
  });

  test("scenario 4: after a purge the category reads zero at the next list (the cache is dropped)", async () => {
    const svc = service();
    write(path.join(root, "media", "temp", "t.bin"), "t".repeat(500), 10 * MINUTE);
    assert.equal(byId(await svc.list()).temp_media.bytes, 500);
    await svc.purge("temp_media", { confirm: true });
    assert.equal(byId(await svc.list()).temp_media.bytes, 0);
  });

  test("one purge at a time per category (busy); another category is not blocked", async () => {
    let release;
    broadcaster.gate = new Promise((resolve) => (release = resolve));
    const svc = service();
    const first = svc.purge("broadcast_media", { confirm: true });
    await assert.rejects(svc.purge("broadcast_media", { confirm: true }), (err) => err.code === "busy");
    assert.equal((await svc.purge("antidelete_cache", { confirm: true })).removed, 3);
    release();
    assert.equal((await first).removed, 1);
    assert.equal((await svc.purge("broadcast_media", { confirm: true })).removed, 1, "free again once it ended");
  });

  test("a failing purge releases the category", async () => {
    broadcaster.purgeFinishedMedia = async () => {
      throw new Error("db down");
    };
    const svc = service();
    await assert.rejects(svc.purge("broadcast_media", { confirm: true }), /db down/);
    broadcaster.purgeFinishedMedia = async () => ({ freedBytes: 0, removed: 0, skipped: 0 });
    assert.deepEqual(await svc.purge("broadcast_media", { confirm: true }), { freedBytes: 0, removed: 0, skipped: 0 });
  });
});
