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
    env: { ...process.env, DATABASE_URL: file, LOG_LEVEL: "info", LOG_FORMAT: "json" },
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

// ---------------------------------------------------------------------------
// specs/002-admin-panel: the 14 tables of the admin panel (data-model section 1)
// ---------------------------------------------------------------------------

const NEW_TABLES = {
  admin_accounts: {
    model: "AdminAccount",
    columns: ["id", "passwordHash", "uiLang", "theme", "lastLoginAt", "createdAt", "updatedAt"],
    primary: ["id"],
    indexes: [],
  },
  admin_sessions: {
    model: "AdminSession",
    columns: ["idHash", "csrfSecret", "origin", "userAgent", "lastSeenAt", "createdAt", "updatedAt"],
    primary: ["idHash"],
    indexes: [{ unique: false, columns: ["lastSeenAt"] }],
  },
  admin_tokens: {
    model: "AdminToken",
    columns: ["id", "kind", "tokenHash", "expiresAt", "usedAt", "createdAt", "updatedAt"],
    primary: ["id"],
    indexes: [{ unique: true, columns: ["tokenHash"] }],
  },
  setting_overrides: {
    model: "SettingOverride",
    columns: ["key", "value", "version", "createdAt", "updatedAt"],
    primary: ["key"],
    indexes: [],
  },
  command_states: {
    model: "CommandState",
    columns: ["command", "scope", "createdAt", "updatedAt"],
    primary: ["command", "scope"],
    indexes: [],
  },
  text_overrides: {
    model: "TextOverride",
    columns: ["key", "lang", "text", "originalHash", "createdAt", "updatedAt"],
    primary: ["key", "lang"],
    indexes: [],
  },
  audit_logs: {
    model: "AuditLog",
    columns: ["id", "action", "target", "origin", "result", "detail", "createdAt"],
    primary: ["id"],
    indexes: [
      { unique: false, columns: ["createdAt"] },
      { unique: false, columns: ["action", "createdAt"] },
      { unique: false, columns: ["origin", "createdAt"] },
    ],
  },
  daily_stats: {
    model: "DailyStat",
    columns: ["day", "metric", "subject", "count"],
    primary: ["day", "metric", "subject"],
    indexes: [],
  },
  known_chats: {
    model: "KnownChat",
    columns: ["jid", "kind", "pnJid", "name", "firstSeenAt", "lastSeenAt", "leftAt", "createdAt", "updatedAt"],
    primary: ["jid"],
    indexes: [
      { unique: false, columns: ["kind", "lastSeenAt"] },
      { unique: false, columns: ["pnJid"] },
    ],
  },
  broadcasts: {
    model: "Broadcast",
    columns: [
      "id", "kind", "title", "text", "mediaKind", "mediaPath", "mediaName", "mediaMime", "mediaSize", "targets",
      "spacingMs", "status", "runAt", "recurKind", "recurDays", "recurTime", "nextRunAt", "lastRunAt", "createdAt", "updatedAt",
    ],
    primary: ["id"],
    indexes: [{ unique: false, columns: ["status", "nextRunAt"] }],
  },
  broadcast_runs: {
    model: "BroadcastRun",
    columns: [
      "id", "broadcastId", "dueAt", "status", "total", "targetsReady", "startedAt", "finishedAt", "note", "createdAt", "updatedAt",
    ],
    primary: ["id"],
    indexes: [
      { unique: true, columns: ["broadcastId", "dueAt"] },
      { unique: false, columns: ["status", "dueAt"] },
    ],
  },
  broadcast_targets: {
    model: "BroadcastTarget",
    columns: [
      "id", "runId", "chatJid", "position", "status", "attempts", "leaseUntil", "sentAt", "messageId", "errorCode", "createdAt", "updatedAt",
    ],
    primary: ["id"],
    indexes: [
      { unique: true, columns: ["runId", "chatJid"] },
      { unique: false, columns: ["runId", "status", "position"] },
      { unique: false, columns: ["sentAt"] },
    ],
  },
  alert_states: {
    model: "AlertState",
    columns: ["key", "lastSentAt", "value", "count", "createdAt", "updatedAt"],
    primary: ["key"],
    indexes: [],
  },
  alert_outbox: {
    model: "AlertOutbox",
    columns: ["id", "type", "payload", "status", "attempts", "sentAt", "createdAt", "updatedAt"],
    primary: ["id"],
    indexes: [{ unique: false, columns: ["status", "createdAt"] }],
  },
};

const OLD_TABLES = [
  "anti_delete", "auto_responder", "banned_chats", "conversations", "filters", "group_economy", "group_roles", "groups",
  "ideas", "notify_keywords", "quotes", "reminders", "sticker_commands", "tasks", "user_stats", "users", "view_once", "warns",
];

/** `sqlite_master` statements of some tables, with their indexes, keyed by name */
async function schemaOf(db, tables) {
  const rows = await db.all("SELECT name, sql FROM sqlite_master WHERE tbl_name IN (" + tables.map(() => "?").join(",") + ") ORDER BY name", tables);
  return Object.fromEntries(rows.map((r) => [r.name, r.sql]));
}

describe("admin panel tables (002-admin-panel): schema", () => {
  const file = newDbFile();
  let first;
  let second;

  before(() => {
    first = boot(file);
    second = boot(file);
  });

  test("the 14 new tables are created, next to the 18 existing ones", async () => {
    assert.equal(Object.keys(NEW_TABLES).length, 14);
    assert.equal(OLD_TABLES.length, 18);
    for (const table of Object.keys(NEW_TABLES)) assert.ok(first.summary.created.includes(table), `${table} created`);
    assert.deepEqual([...first.summary.created].sort(), [...Object.keys(NEW_TABLES), ...OLD_TABLES].sort());
    await withDb(file, async (db) => {
      assert.deepEqual(await tableNames(db), [...Object.keys(NEW_TABLES), ...OLD_TABLES].sort());
    });
  });

  test("a second sync() is a no-op", () => {
    assertNothingChanged(second);
  });

  for (const [table, spec] of Object.entries(NEW_TABLES)) {
    test(`${table}: columns, primary key and indexes`, async () => {
      await withDb(file, async (db) => {
        assert.deepEqual((await columnNames(db, table)).sort(), [...spec.columns].sort());
        assert.deepEqual(await primaryKey(db, table), spec.primary);
        assert.deepEqual(await uniqueColumns(db, table), [], "no UNIQUE constraint per column");
        const found = Object.values(await indexes(db, table)).map((i) => `${i.unique ? "unique " : ""}${i.columns.join(",")}`).sort();
        const wanted = spec.indexes.map((i) => `${i.unique ? "unique " : ""}${i.columns.join(",")}`).sort();
        assert.deepEqual(found, wanted);
      });
    });
  }

  test("a database that predates the feature only gains the 14 tables: no existing table is altered, no row lost", async () => {
    const legacy = newDbFile();
    boot(legacy);
    const before_ = {};
    await withDb(legacy, async (db) => {
      await db.run("INSERT INTO warns (jid, groupJid, createdAt, updatedAt) VALUES ('a@s.whatsapp.net', 'g1@g.us', ?, ?)", [NOW, NOW]);
      await db.run("INSERT INTO banned_chats (jid, createdAt, updatedAt) VALUES ('g2@g.us', ?, ?)", [NOW, NOW]);
      await db.run("INSERT INTO group_economy (groupJid, userJid, balance, createdAt, updatedAt) VALUES ('g1@g.us', 'a@s.whatsapp.net', 500, ?, ?)", [NOW, NOW]);
      before_.schema = await schemaOf(db, OLD_TABLES);
      for (const table of ["warns", "banned_chats", "group_economy"]) before_[table] = await db.all(`SELECT * FROM \`${table}\` ORDER BY rowid`);
      for (const table of Object.keys(NEW_TABLES)) await db.run(`DROP TABLE \`${table}\``);
    });

    const upgraded = boot(legacy);
    assert.deepEqual([...upgraded.summary.created].sort(), Object.keys(NEW_TABLES).sort());
    assert.deepEqual(
      [upgraded.summary.repaired, upgraded.summary.columns, upgraded.summary.indexes, upgraded.summary.warnings, upgraded.summary.errors],
      [[], [], [], [], []],
      "0 existing table altered",
    );

    await withDb(legacy, async (db) => {
      assert.deepEqual(await schemaOf(db, OLD_TABLES), before_.schema, "the 18 existing tables keep their exact schema and indexes");
      for (const table of ["warns", "banned_chats", "group_economy"]) {
        assert.deepEqual(await db.all(`SELECT * FROM \`${table}\` ORDER BY rowid`), before_[table], `${table} rows`);
      }
    });
    assertNothingChanged(boot(legacy));
  });

  test("no DataTypes.ENUM in the 14 model files", () => {
    for (const spec of Object.values(NEW_TABLES)) {
      const source = fs.readFileSync(path.join(ROOT, "lib", "database", "models", `${spec.model}.js`), "utf8");
      assert.doesNotMatch(source, /ENUM/, spec.model);
      assert.match(source, new RegExp(`sequelize\\.define\\(\\s*"${spec.model}"`), `${spec.model} is defined under its file name`);
    }
  });
});

describe("admin panel tables (002-admin-panel): uniqueness", () => {
  const file = newDbFile();

  before(() => {
    boot(file);
  });

  const DUPLICATES = [
    {
      name: "admin_accounts: the same id",
      sql: "INSERT INTO admin_accounts (id, passwordHash, createdAt, updatedAt) VALUES (1, 'h', ?, ?)",
    },
    {
      name: "admin_tokens: the same tokenHash",
      sql: "INSERT INTO admin_tokens (kind, tokenHash, expiresAt, createdAt, updatedAt) VALUES ('setup', 'hash-1', ?, ?, ?)",
      params: [NOW, NOW, NOW],
    },
    {
      name: "broadcast_runs: the same (broadcastId, dueAt)",
      sql: "INSERT INTO broadcast_runs (broadcastId, dueAt, createdAt, updatedAt) VALUES (7, ?, ?, ?)",
      params: [NOW, NOW, NOW],
    },
    {
      name: "broadcast_targets: the same (runId, chatJid)",
      sql: "INSERT INTO broadcast_targets (runId, chatJid, position, createdAt, updatedAt) VALUES (3, 'a@s.whatsapp.net', 1, ?, ?)",
    },
    {
      name: "command_states: the same (command, scope)",
      sql: "INSERT INTO command_states (command, scope, createdAt, updatedAt) VALUES ('ping', '*', ?, ?)",
    },
    {
      name: "text_overrides: the same (key, lang)",
      sql: "INSERT INTO text_overrides (key, lang, text, originalHash, createdAt, updatedAt) VALUES ('k', 'fr', 't', 'h', ?, ?)",
    },
    {
      name: "daily_stats: the same (day, metric, subject)",
      sql: "INSERT INTO daily_stats (day, metric, subject, count) VALUES ('2026-01-01', 'cmd_ok', 'ping', 1)",
      params: [],
    },
  ];

  for (const { name, sql, params } of DUPLICATES) {
    test(`${name} is rejected`, async () => {
      await withDb(file, async (db) => {
        // The same statement twice: the second insert must fail
        const args = params || [NOW, NOW];
        await db.run(sql, args);
        await assert.rejects(db.run(sql, args), /UNIQUE constraint failed/);
      });
    });
  }

  test("composite keys: one half of the key may repeat", async () => {
    await withDb(file, async (db) => {
      await db.run("INSERT INTO command_states (command, scope, createdAt, updatedAt) VALUES ('ping', '120363@g.us', ?, ?)", [NOW, NOW]);
      await db.run("INSERT INTO command_states (command, scope, createdAt, updatedAt) VALUES ('menu', '*', ?, ?)", [NOW, NOW]);
      await db.run("INSERT INTO text_overrides (key, lang, text, originalHash, createdAt, updatedAt) VALUES ('k', 'en', 't', 'h', ?, ?)", [NOW, NOW]);
      await db.run("INSERT INTO daily_stats (day, metric, subject, count) VALUES ('2026-01-01', 'cmd_fail', 'ping', 1)");
      await db.run("INSERT INTO broadcast_runs (broadcastId, dueAt, createdAt, updatedAt) VALUES (8, ?, ?, ?)", [NOW, NOW, NOW]);
      await db.run("INSERT INTO broadcast_targets (runId, chatJid, position, createdAt, updatedAt) VALUES (4, 'a@s.whatsapp.net', 1, ?, ?)", [NOW, NOW]);
    });
  });
});

describe("admin panel tables (002-admin-panel): model validation", () => {
  let db;
  const saved = { url: process.env.DATABASE_URL, level: process.env.LOG_LEVEL };

  before(async () => {
    process.env.DATABASE_URL = ":memory:";
    process.env.LOG_LEVEL = "silent";
    db = require(path.join(ROOT, "lib", "database"));
    await db.sync();
  });

  after(async () => {
    if (saved.url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.url;
    if (saved.level === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = saved.level;
    if (db) await db.DATABASE.close();
  });

  const when = new Date("2026-01-01T00:00:00Z");
  const rejects = (promise, pattern = /Validation error/) => assert.rejects(promise, pattern);

  test("the 14 models are loaded under their file names", () => {
    for (const spec of Object.values(NEW_TABLES)) {
      assert.ok(db[spec.model], spec.model);
      assert.equal(db[spec.model].tableName, Object.keys(NEW_TABLES).find((t) => NEW_TABLES[t] === spec));
    }
  });

  test("AdminAccount: a single account (id 1), enumerations checked, defaults applied", async () => {
    const account = await db.AdminAccount.create({ id: 1, passwordHash: "scrypt$..." });
    assert.equal(account.uiLang, "fr");
    assert.equal(account.theme, "auto");
    await rejects(db.AdminAccount.create({ id: 2, passwordHash: "scrypt$..." }), /Validation error|Unique/);
    await assert.rejects(db.AdminAccount.create({ id: 1, passwordHash: "scrypt$..." }), /Unique|unique/i);
    await rejects(db.AdminAccount.update({ theme: "neon" }, { where: { id: 1 }, individualHooks: true }));
    await rejects(db.AdminAccount.build({ id: 1, passwordHash: "x", uiLang: "de" }).validate());
    await rejects(db.AdminAccount.build({ id: 1, passwordHash: "x", theme: "neon" }).validate());
    assert.equal(await db.AdminAccount.count(), 1);
  });

  test("AdminToken, AuditLog, KnownChat, AlertOutbox: unknown enumeration values are refused", async () => {
    await rejects(db.AdminToken.build({ kind: "magic", tokenHash: "h", expiresAt: when }).validate());
    await db.AdminToken.build({ kind: "reset", tokenHash: "h", expiresAt: when }).validate();

    await rejects(db.AuditLog.build({ action: "login.success", result: "maybe" }).validate());
    const log = await db.AuditLog.create({ action: "login.success" });
    assert.equal(log.result, "ok");
    assert.equal(log.updatedAt, undefined, "AuditLog has createdAt only");

    await rejects(db.KnownChat.build({ jid: "a@s.whatsapp.net", kind: "channel", firstSeenAt: when, lastSeenAt: when }).validate());
    await db.KnownChat.build({ jid: "a@s.whatsapp.net", kind: "private", firstSeenAt: when, lastSeenAt: when }).validate();

    await rejects(db.AlertOutbox.build({ type: "spam" }).validate());
    await rejects(db.AlertOutbox.build({ type: "reconnected", status: "done" }).validate());
    const alert = await db.AlertOutbox.create({ type: "new_origin" });
    assert.deepEqual([alert.status, alert.attempts], ["pending", 0]);
  });

  test("TextOverride: 1 to 4000 characters", async () => {
    await rejects(db.TextOverride.build({ key: "k", lang: "fr", text: "", originalHash: "h" }).validate());
    await rejects(db.TextOverride.build({ key: "k", lang: "fr", text: "x".repeat(4001), originalHash: "h" }).validate());
    await db.TextOverride.build({ key: "k", lang: "fr", text: "x".repeat(4000), originalHash: "h" }).validate();
  });

  test("SettingOverride and CommandState: defaults", async () => {
    const setting = await db.SettingOverride.create({ key: "PREFIX", value: "" });
    assert.equal(setting.version, 1, "an empty string is a valid value");
    const state = await db.CommandState.create({ command: "ping" });
    assert.equal(state.scope, "*");
  });

  test("Broadcast: enumerations, pacing, destinations and the once/recurring rules", async () => {
    const base = { text: "hello", targets: ["120363@g.us"] };

    const once = await db.Broadcast.create({ ...base, kind: "once" });
    assert.deepEqual([once.spacingMs, once.status], [5000, "active"]);
    await db.Broadcast.create({ ...base, kind: "once", runAt: when });

    await rejects(db.Broadcast.build({ ...base, kind: "weekly" }).validate());
    await rejects(db.Broadcast.build({ ...base, kind: "once", status: "done" }).validate());
    await rejects(db.Broadcast.build({ ...base, kind: "once", mediaKind: "video" }).validate());
    await rejects(db.Broadcast.build({ ...base, kind: "once", spacingMs: 1999 }).validate());
    await rejects(db.Broadcast.build({ ...base, kind: "once", spacingMs: 600001 }).validate());
    await db.Broadcast.build({ ...base, kind: "once", spacingMs: 2000 }).validate();
    await db.Broadcast.build({ ...base, kind: "once", spacingMs: 600000 }).validate();

    await rejects(db.Broadcast.build({ kind: "once", text: "x", targets: [] }).validate());
    await rejects(db.Broadcast.build({ kind: "once", text: "x", targets: Array.from({ length: 201 }, (_, i) => `${i}@s.whatsapp.net`) }).validate());
    await db.Broadcast.build({ kind: "once", text: "x", targets: Array.from({ length: 200 }, (_, i) => `${i}@s.whatsapp.net`) }).validate();

    // once: no recurrence field, no nextRunAt
    for (const extra of [{ recurKind: "daily" }, { recurDays: "1" }, { recurTime: "10:00" }, { nextRunAt: when }]) {
      await rejects(db.Broadcast.build({ ...base, kind: "once", ...extra }).validate(), /must be empty for a once broadcast/);
    }

    // recurring: recurKind + recurTime, recurDays for weekly/monthly, no runAt
    const daily = { ...base, kind: "recurring", recurKind: "daily", recurTime: "08:30", nextRunAt: when };
    await db.Broadcast.create(daily);
    await db.Broadcast.create({ ...daily, recurKind: "weekly", recurDays: "1,3,5" });
    await db.Broadcast.create({ ...daily, recurKind: "monthly", recurDays: "15" });
    await rejects(db.Broadcast.build({ ...daily, recurKind: undefined }).validate(), /recurKind is required/);
    await rejects(db.Broadcast.build({ ...daily, recurTime: undefined }).validate(), /recurTime is required/);
    await rejects(db.Broadcast.build({ ...daily, recurKind: "weekly" }).validate(), /recurDays is required/);
    await rejects(db.Broadcast.build({ ...daily, recurKind: "monthly" }).validate(), /recurDays is required/);
    await rejects(db.Broadcast.build({ ...daily, runAt: when }).validate(), /runAt must be empty/);
    await rejects(db.Broadcast.build({ ...daily, recurKind: "yearly" }).validate());
  });

  test("BroadcastRun and BroadcastTarget: status values, defaults and unique pairs", async () => {
    const run = await db.BroadcastRun.create({ broadcastId: 1, dueAt: when });
    assert.deepEqual([run.status, run.total, run.targetsReady], ["scheduled", 0, false]);
    await rejects(db.BroadcastRun.build({ broadcastId: 1, dueAt: when, status: "queued" }).validate());
    await assert.rejects(db.BroadcastRun.create({ broadcastId: 1, dueAt: when }), /unique/i);
    await db.BroadcastRun.create({ broadcastId: 1, dueAt: new Date("2026-01-02T00:00:00Z") });

    const target = await db.BroadcastTarget.create({ runId: run.id, chatJid: "a@s.whatsapp.net", position: 1 });
    assert.deepEqual([target.status, target.attempts], ["pending", 0]);
    await rejects(db.BroadcastTarget.build({ runId: 1, chatJid: "b", position: 1, status: "done" }).validate());
    await assert.rejects(db.BroadcastTarget.create({ runId: run.id, chatJid: "a@s.whatsapp.net", position: 2 }), /unique/i);
  });

  test("DailyStat: composite key, defaults, no timestamps", async () => {
    const stat = await db.DailyStat.create({ day: "2026-01-01", metric: "messages" });
    assert.deepEqual([stat.subject, stat.count], ["", 0]);
    assert.equal(stat.createdAt, undefined);
    await assert.rejects(db.DailyStat.create({ day: "2026-01-01", metric: "messages" }), /unique/i);
    await db.DailyStat.create({ day: "2026-01-01", metric: "cmd_ok", subject: "ping", count: 3 });
  });
});
