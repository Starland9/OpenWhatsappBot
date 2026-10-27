"use strict";
/**
 * Additive schema update of lib/database (`sync()`), on a SQLite FILE.
 *
 * The damage done by `sync({ alter: true })` only shows up across boots, and
 * `config` / `lib/database` are module singletons: every "boot" runs in a child
 * process that requires the bot's database module against the temp file.
 *
 *  - fresh database, booted twice: no UNIQUE per key column, composite keys and
 *    indexes in place, the same jid can exist in two groups;
 *  - schema damaged by an earlier `alter: true`: repaired, rows kept;
 *  - missing column / missing index: added, rows kept, defaults applied;
 *  - a unique index that cannot be built (duplicates) only warns;
 *  - a second boot changes nothing and logs nothing at info level.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sqlite3 = require("sqlite3");

const ROOT = path.join(__dirname, "..");
const LEVEL = { info: 30, warn: 40, error: 50 };

let tmpDir;
let counter = 0;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-db-test-"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const newDbFile = () => path.join(tmpDir, `db-${++counter}.sqlite`);

// ---------------------------------------------------------------------------
// One boot = one child process
// ---------------------------------------------------------------------------

// process.argv = [node, ROOT, mode]
const BOOT_SCRIPT = `
const root = process.argv[1];
const db = require(root + "/lib/database");
(async () => {
  if (process.argv[2] === "extra-model") {
    const { DataTypes } = require("sequelize");
    db.DATABASE.define("Tmp", {
      note: { type: DataTypes.STRING },
      label: { type: DataTypes.STRING, allowNull: false },
      flag: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    }, { tableName: "tmp_items", timestamps: false });
  }
  const summary = await db.sync();
  console.log("__SUMMARY__" + JSON.stringify(summary));
  await db.DATABASE.close();
})().catch((err) => { console.error(err); process.exit(1); });
`;

/** Boot the bot's database layer on `file`. @returns {{ summary, logs: {level, msg}[] }} */
function boot(file, { extraModel = false } = {}) {
  const stdout = execFileSync(process.execPath, ["-e", BOOT_SCRIPT, ROOT, extraModel ? "extra-model" : ""], {
    env: { ...process.env, DATABASE_URL: file, LOG_LEVEL: "info" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let summary = null;
  const logs = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("__SUMMARY__")) summary = JSON.parse(line.slice("__SUMMARY__".length));
    else if (line.startsWith("{")) {
      const entry = JSON.parse(line);
      logs.push({ level: entry.level, msg: entry.msg });
    }
  }
  assert.ok(summary, "the child did not report a summary");
  return { summary, logs };
}

const NOTHING_CHANGED = { created: [], repaired: [], columns: [], indexes: [], warnings: [], errors: [] };

function assertNothingChanged(result) {
  assert.deepEqual(result.summary, NOTHING_CHANGED);
  assert.deepEqual(result.logs, [], "a boot that changes nothing must log nothing");
}

// ---------------------------------------------------------------------------
// Inspecting / preparing the file from the test process
// ---------------------------------------------------------------------------

async function withDb(file, fn) {
  const db = await new Promise((resolve, reject) => {
    const d = new sqlite3.Database(file, (err) => (err ? reject(err) : resolve(d)));
  });
  const api = {
    exec: (sql) => new Promise((resolve, reject) => db.exec(sql, (err) => (err ? reject(err) : resolve()))),
    run: (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve()))),
    all: (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))),
  };
  try {
    return await fn(api);
  } finally {
    await new Promise((resolve) => db.close(resolve));
  }
}

/** Columns that carry a column-level UNIQUE constraint (single-column `u` autoindex) */
async function uniqueColumns(db, table) {
  const columns = [];
  for (const index of await db.all(`PRAGMA index_list(\`${table}\`)`)) {
    if (!index.unique || index.origin !== "u") continue;
    const info = await db.all(`PRAGMA index_info(\`${index.name}\`)`);
    if (info.length === 1) columns.push(info[0].name);
  }
  return columns.sort();
}

async function primaryKey(db, table) {
  const info = await db.all(`PRAGMA table_info(\`${table}\`)`);
  return info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
}

async function indexes(db, table) {
  const list = await db.all(`PRAGMA index_list(\`${table}\`)`);
  const result = {};
  for (const index of list.filter((i) => i.origin === "c")) {
    const info = await db.all(`PRAGMA index_info(\`${index.name}\`)`);
    result[index.name] = { unique: !!index.unique, columns: info.sort((a, b) => a.seqno - b.seqno).map((c) => c.name) };
  }
  return result;
}

const tableExists = async (db, table) =>
  (await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table])).length === 1;

const tableNames = async (db) =>
  (await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((r) => r.name);

const columnNames = async (db, table) => (await db.all(`PRAGMA table_info(\`${table}\`)`)).map((c) => c.name);

const NOW = "2026-01-01 00:00:00.000 +00:00";

// ---------------------------------------------------------------------------
// The four tables of the bug, with their key columns
// ---------------------------------------------------------------------------

const KEYED_TABLES = {
  warns: { key: ["jid", "groupJid"], primary: ["id"], index: { name: "warns_jid_group_jid", unique: true, columns: ["jid", "groupJid"] } },
  user_stats: { key: ["jid", "groupJid"], primary: ["jid", "groupJid"] },
  group_economy: { key: ["groupJid", "userJid"], primary: ["groupJid", "userJid"] },
  group_roles: { key: ["groupJid", "userJid"], primary: ["groupJid", "userJid"] },
};

/** INSERT with only the key columns (everything else has a default) */
async function insertKey(db, table, first, second) {
  const [a, b] = KEYED_TABLES[table].key;
  await db.run(`INSERT INTO \`${table}\` (\`${a}\`, \`${b}\`, createdAt, updatedAt) VALUES (?, ?, ?, ?)`, [first, second, NOW, NOW]);
}

/** The exact CREATE statements `sync({ alter: true })` leaves behind on SQLite */
const DAMAGED_SCHEMA = `
CREATE TABLE \`warns\` (\`id\` INTEGER PRIMARY KEY, \`jid\` VARCHAR(255) NOT NULL UNIQUE, \`groupJid\` VARCHAR(255) NOT NULL UNIQUE, \`reason\` TEXT DEFAULT 'No reason provided', \`count\` INTEGER DEFAULT '1', \`createdAt\` DATETIME NOT NULL, \`updatedAt\` DATETIME NOT NULL);
CREATE UNIQUE INDEX \`warns_jid_group_jid\` ON \`warns\` (\`jid\`, \`groupJid\`);
CREATE TABLE \`user_stats\` (\`jid\` VARCHAR(255) NOT NULL UNIQUE, \`groupJid\` VARCHAR(255) NOT NULL UNIQUE, \`messageCount\` INTEGER DEFAULT '0', \`commandCount\` INTEGER DEFAULT '0', \`mediaCount\` INTEGER DEFAULT '0', \`xp\` INTEGER DEFAULT '0', \`level\` INTEGER DEFAULT '0', \`lastActiveAt\` DATETIME, \`createdAt\` DATETIME NOT NULL, \`updatedAt\` DATETIME NOT NULL, PRIMARY KEY (\`jid\`, \`groupJid\`));
CREATE INDEX \`user_stats_group_jid_message_count\` ON \`user_stats\` (\`groupJid\`, \`messageCount\`);
CREATE INDEX \`user_stats_group_jid_xp\` ON \`user_stats\` (\`groupJid\`, \`xp\`);
CREATE TABLE \`group_economy\` (\`groupJid\` VARCHAR(255) NOT NULL UNIQUE, \`userJid\` VARCHAR(255) NOT NULL UNIQUE, \`balance\` INTEGER DEFAULT '0', \`lastDailyAt\` DATETIME DEFAULT NULL, \`streak\` INTEGER DEFAULT '0', \`createdAt\` DATETIME NOT NULL, \`updatedAt\` DATETIME NOT NULL, PRIMARY KEY (\`groupJid\`, \`userJid\`));
CREATE INDEX \`group_economy_group_jid_balance\` ON \`group_economy\` (\`groupJid\`, \`balance\`);
CREATE TABLE \`group_roles\` (\`groupJid\` VARCHAR(255) NOT NULL UNIQUE, \`userJid\` VARCHAR(255) NOT NULL UNIQUE, \`role\` TEXT NOT NULL DEFAULT 'regular', \`setBy\` VARCHAR(255) DEFAULT NULL, \`setAt\` DATETIME, \`createdAt\` DATETIME NOT NULL, \`updatedAt\` DATETIME NOT NULL, PRIMARY KEY (\`groupJid\`, \`userJid\`));
`;

// ---------------------------------------------------------------------------

describe("fresh database", () => {
  const file = newDbFile();
  let first;
  let second;

  before(() => {
    first = boot(file);
    second = boot(file);
  });

  test("first boot creates every table and logs one summary", () => {
    assert.ok(first.summary.created.length >= 15, `tables created: ${first.summary.created.length}`);
    for (const table of Object.keys(KEYED_TABLES)) assert.ok(first.summary.created.includes(table), table);
    assert.deepEqual(
      [first.summary.repaired, first.summary.columns, first.summary.indexes, first.summary.warnings, first.summary.errors],
      [[], [], [], [], []],
    );
    const infos = first.logs.filter((l) => l.level === LEVEL.info);
    assert.equal(infos.length, 1);
    assert.match(infos[0].msg, /^Database schema updated: \d+ table\(s\) created/);
  });

  test("second boot changes nothing and logs nothing", () => {
    assertNothingChanged(second);
  });

  for (const [table, spec] of Object.entries(KEYED_TABLES)) {
    test(`${table}: no UNIQUE per key column, composite keys and indexes in place`, async () => {
      await withDb(file, async (db) => {
        assert.deepEqual(await uniqueColumns(db, table), []);
        assert.deepEqual(await primaryKey(db, table), spec.primary);
        if (spec.index) assert.deepEqual((await indexes(db, table))[spec.index.name], { unique: spec.index.unique, columns: spec.index.columns });
      });
    });

    test(`${table}: the same jid can exist in two groups, the same pair cannot be stored twice`, async () => {
      await withDb(file, async (db) => {
        await insertKey(db, table, "a@s.whatsapp.net", "g1@g.us");
        await insertKey(db, table, "a@s.whatsapp.net", "g2@g.us");
        await insertKey(db, table, "b@s.whatsapp.net", "g1@g.us");
        await assert.rejects(insertKey(db, table, "a@s.whatsapp.net", "g1@g.us"), /UNIQUE constraint failed/);
        const [{ n }] = await db.all(`SELECT COUNT(*) AS n FROM \`${table}\``);
        assert.equal(n, 3);
      });
    });
  }

  test("model indexes of the other tables exist", async () => {
    await withDb(file, async (db) => {
      assert.deepEqual(Object.keys(await indexes(db, "user_stats")).sort(), [
        "user_stats_group_jid_command_count",
        "user_stats_group_jid_media_count",
        "user_stats_group_jid_message_count",
        "user_stats_group_jid_xp",
      ]);
      assert.deepEqual(Object.keys(await indexes(db, "reminders")).sort(), [
        "reminders_creator_jid_status",
        "reminders_due_at",
        "reminders_status_due_at",
      ]);
    });
  });
});

describe("schema damaged by an earlier alter:true", () => {
  const file = newDbFile();
  const before_ = {}; // rows by table, before the boot
  let first;
  let second;

  const ROWS = {
    warns: [
      [1, "a@s.whatsapp.net", "g1@g.us", "spam", 2],
      [2, "b@s.whatsapp.net", "g2@g.us", "insult", 1],
      [5, "c@s.whatsapp.net", "g3@g.us", "flood", 4],
    ],
  };

  before(async () => {
    await withDb(file, async (db) => {
      await db.exec(DAMAGED_SCHEMA);
      for (const [id, jid, groupJid, reason, count] of ROWS.warns) {
        await db.run("INSERT INTO warns (id, jid, groupJid, reason, count, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, jid, groupJid, reason, count, NOW, NOW]);
      }
      await db.run("INSERT INTO user_stats (jid, groupJid, messageCount, xp, level, createdAt, updatedAt) VALUES ('a@s.whatsapp.net', 'g1@g.us', 42, 210, 1, ?, ?)", [NOW, NOW]);
      await db.run("INSERT INTO user_stats (jid, groupJid, messageCount, xp, level, createdAt, updatedAt) VALUES ('b@s.whatsapp.net', 'g2@g.us', 7, 35, 0, ?, ?)", [NOW, NOW]);
      await db.run("INSERT INTO group_economy (groupJid, userJid, balance, streak, createdAt, updatedAt) VALUES ('g1@g.us', 'a@s.whatsapp.net', 500, 3, ?, ?)", [NOW, NOW]);
      await db.run("INSERT INTO group_roles (groupJid, userJid, role, createdAt, updatedAt) VALUES ('g1@g.us', 'a@s.whatsapp.net', 'vip', ?, ?)", [NOW, NOW]);
      for (const table of Object.keys(KEYED_TABLES)) before_[table] = await db.all(`SELECT * FROM \`${table}\` ORDER BY rowid`);
      // Sanity check of the fixture: it is damaged
      assert.deepEqual(await uniqueColumns(db, "warns"), ["groupJid", "jid"]);
    });
    first = boot(file);
    second = boot(file);
  });

  test("the four tables are rebuilt and reported", () => {
    assert.deepEqual([...first.summary.repaired].sort(), ["group_economy", "group_roles", "user_stats", "warns"]);
    assert.deepEqual(first.summary.errors, []);
    assert.deepEqual(first.summary.warnings, []);
    const infos = first.logs.filter((l) => l.level === LEVEL.info).map((l) => l.msg);
    assert.equal(infos.filter((m) => m.startsWith("Database repaired: table")).length, 4);
    assert.ok(infos.some((m) => /^Database schema updated: .*4 table\(s\) repaired/.test(m)), infos.join("\n"));
  });

  for (const [table, spec] of Object.entries(KEYED_TABLES)) {
    test(`${table}: no UNIQUE per column, keys and indexes kept, rows preserved`, async () => {
      await withDb(file, async (db) => {
        assert.deepEqual(await uniqueColumns(db, table), []);
        assert.deepEqual(await primaryKey(db, table), spec.primary);
        if (spec.index) assert.deepEqual((await indexes(db, table))[spec.index.name], { unique: spec.index.unique, columns: spec.index.columns });
        assert.deepEqual(await db.all(`SELECT * FROM \`${table}\` ORDER BY rowid`), before_[table]);
        assert.equal(await tableExists(db, `${table}__old`), false);
      });
    });

    test(`${table}: the same jid can now exist in two groups`, async () => {
      await withDb(file, async (db) => {
        await insertKey(db, table, "z@s.whatsapp.net", "g8@g.us");
        await insertKey(db, table, "z@s.whatsapp.net", "g9@g.us");
        await assert.rejects(insertKey(db, table, "z@s.whatsapp.net", "g9@g.us"), /UNIQUE constraint failed/);
      });
    });
  }

  test("indexes of the damaged tables are rebuilt, including the ones that were missing", async () => {
    await withDb(file, async (db) => {
      assert.deepEqual(Object.keys(await indexes(db, "user_stats")).sort(), [
        "user_stats_group_jid_command_count",
        "user_stats_group_jid_media_count",
        "user_stats_group_jid_message_count",
        "user_stats_group_jid_xp",
      ]);
    });
  });

  test("auto-increment continues after the highest preserved id", async () => {
    await withDb(file, async (db) => {
      await db.run("INSERT INTO warns (jid, groupJid, createdAt, updatedAt) VALUES ('n@s.whatsapp.net', 'g1@g.us', ?, ?)", [NOW, NOW]);
      const [row] = await db.all("SELECT id, count FROM warns WHERE jid = 'n@s.whatsapp.net'");
      assert.ok(row.id > 5, `id ${row.id}`);
      assert.equal(row.count, 1);
    });
  });

  test("second boot finds nothing to repair", () => {
    assertNothingChanged(second);
  });
});

describe("repair that cannot copy every row", () => {
  const file = newDbFile();

  test("keeps the rows that fit, warns, and leaves the original data in a backup table", async () => {
    await withDb(file, async (db) => {
      // groupJid is nullable here, which the model does not allow
      await db.exec(`
        CREATE TABLE \`warns\` (\`id\` INTEGER PRIMARY KEY, \`jid\` VARCHAR(255) NOT NULL UNIQUE, \`groupJid\` VARCHAR(255) UNIQUE, \`reason\` TEXT DEFAULT 'No reason provided', \`count\` INTEGER DEFAULT '1', \`createdAt\` DATETIME NOT NULL, \`updatedAt\` DATETIME NOT NULL);
        INSERT INTO warns (jid, groupJid, createdAt, updatedAt) VALUES ('a@s.whatsapp.net', 'g1@g.us', '${NOW}', '${NOW}');
        INSERT INTO warns (jid, groupJid, createdAt, updatedAt) VALUES ('b@s.whatsapp.net', NULL, '${NOW}', '${NOW}');
      `);
    });

    const result = boot(file);
    assert.deepEqual(result.summary.repaired, ["warns"]);
    assert.equal(result.summary.warnings.length, 1);
    assert.match(result.summary.warnings[0], /^warns: 1 row\(s\) .*kept in table warns__backup_\d+/);
    assert.ok(result.logs.some((l) => l.level === LEVEL.warn));

    await withDb(file, async (db) => {
      assert.deepEqual(await uniqueColumns(db, "warns"), []);
      assert.deepEqual((await db.all("SELECT jid FROM warns")).map((r) => r.jid), ["a@s.whatsapp.net"]);
      const backup = (await tableNames(db)).filter((n) => n.startsWith("warns__backup_"));
      assert.equal(backup.length, 1);
      assert.equal((await db.all(`SELECT * FROM \`${backup[0]}\``)).length, 2);
      assert.equal(await tableExists(db, "warns__old"), false);
    });

    assertNothingChanged(boot(file));
  });
});

describe("missing columns and indexes", () => {
  test("a column added to the model is added to the table, with its default, rows preserved", async () => {
    const file = newDbFile();
    await withDb(file, async (db) => {
      // `groups` as it was before the `goodbye` column existed
      await db.exec(`
        CREATE TABLE \`groups\` (\`jid\` VARCHAR(255) NOT NULL UNIQUE PRIMARY KEY, \`name\` VARCHAR(255) DEFAULT '', \`antilink\` TINYINT(1) DEFAULT 0, \`antibot\` TINYINT(1) DEFAULT 0, \`mute\` TINYINT(1) DEFAULT 0, \`welcome\` TINYINT(1) DEFAULT 0, \`welcomeMsg\` TEXT DEFAULT 'Welcome @user to @group', \`goodbyeMsg\` TEXT DEFAULT 'Goodbye @user', \`createdAt\` DATETIME NOT NULL, \`updatedAt\` DATETIME NOT NULL, \`truthDareEnabled\` TINYINT(1) DEFAULT 0, \`truthDareMode\` VARCHAR(255) DEFAULT 'mild');
        INSERT INTO groups (jid, name, welcome, welcomeMsg, createdAt, updatedAt) VALUES ('g1@g.us', 'Team', 1, 'Hi @user', '${NOW}', '${NOW}');
      `);
      assert.ok(!(await columnNames(db, "groups")).includes("goodbye"));
    });

    const first = boot(file);
    assert.deepEqual(first.summary.columns, ["groups.goodbye"]);
    assert.deepEqual(first.summary.errors, []);
    assert.ok(first.logs.some((l) => l.level === LEVEL.info && /column\(s\) added \(groups\.goodbye\)/.test(l.msg)));

    await withDb(file, async (db) => {
      assert.ok((await columnNames(db, "groups")).includes("goodbye"));
      const [row] = await db.all("SELECT * FROM groups");
      assert.equal(row.jid, "g1@g.us");
      assert.equal(row.name, "Team");
      assert.equal(row.welcome, 1);
      assert.equal(row.welcomeMsg, "Hi @user");
      assert.equal(row.goodbye, 0, "default false for existing rows");
      assert.equal(row.goodbyeMsg, "Goodbye @user");
    });

    assertNothingChanged(boot(file));
  });

  test("a missing index is created on an existing table", async () => {
    const file = newDbFile();
    boot(file);
    await withDb(file, (db) => db.run("DROP INDEX user_stats_group_jid_xp"));

    const result = boot(file);
    assert.deepEqual(result.summary.indexes, ["user_stats.user_stats_group_jid_xp"]);
    await withDb(file, async (db) => {
      assert.deepEqual((await indexes(db, "user_stats")).user_stats_group_jid_xp, { unique: false, columns: ["groupJid", "xp"] });
    });
    assertNothingChanged(boot(file));
  });

  test("a required column without default is reported, never forced; the nullable and defaulted ones are added", async () => {
    const file = newDbFile();
    await withDb(file, async (db) => {
      await db.exec("CREATE TABLE tmp_items (id INTEGER PRIMARY KEY); INSERT INTO tmp_items (id) VALUES (1);");
    });

    const result = boot(file, { extraModel: true });
    assert.deepEqual([...result.summary.columns].sort(), ["tmp_items.flag", "tmp_items.note"]);
    assert.equal(result.summary.errors.length, 1);
    assert.match(result.summary.errors[0], /^tmp_items\.label: column missing but cannot be added/);
    assert.ok(result.logs.some((l) => l.level === LEVEL.error));

    await withDb(file, async (db) => {
      assert.deepEqual((await columnNames(db, "tmp_items")).sort(), ["flag", "id", "note"]);
      const [row] = await db.all("SELECT * FROM tmp_items");
      assert.deepEqual(row, { id: 1, note: null, flag: 1 });
    });
  });
});

describe("unique index that cannot be built", () => {
  test("duplicate rows only produce a warning; the index is created once the data is clean", async () => {
    const file = newDbFile();
    boot(file);
    await withDb(file, async (db) => {
      await db.run("DROP INDEX warns_jid_group_jid");
      await insertKey(db, "warns", "a@s.whatsapp.net", "g1@g.us");
      await insertKey(db, "warns", "a@s.whatsapp.net", "g1@g.us");
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = boot(file); // must not throw
      assert.deepEqual(result.summary.indexes, []);
      assert.deepEqual(result.summary.errors, []);
      assert.equal(result.summary.warnings.length, 1);
      assert.match(result.summary.warnings[0], /^warns\.warns_jid_group_jid: unique index not created/);
      assert.ok(result.logs.some((l) => l.level === LEVEL.warn && /duplicate/.test(l.msg)));
      assert.equal(result.logs.filter((l) => l.level === LEVEL.info).length, 0);
    }

    await withDb(file, async (db) => {
      assert.equal((await db.all("SELECT * FROM warns")).length, 2, "rows are never touched");
      await db.run("DELETE FROM warns WHERE id = (SELECT MAX(id) FROM warns)");
    });

    const fixed = boot(file);
    assert.deepEqual(fixed.summary.indexes, ["warns.warns_jid_group_jid"]);
    assert.deepEqual(fixed.summary.warnings, []);
    assertNothingChanged(boot(file));
  });
});
