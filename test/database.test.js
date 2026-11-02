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

// specs/003-command-permissions: one table (data-model section 1), kept apart so NEW_TABLES stays at 14
const FEATURE_003_TABLES = {
  permission_rules: {
    model: "PermissionRule",
    columns: ["command", "scope", "mode", "people", "createdAt", "updatedAt"],
    primary: ["command", "scope"],
    indexes: [],
  },
};

// specs/004-messaging-api: four tables (data-model sections 1 to 4), kept apart so NEW_TABLES stays at 14.
// `notNull` lists the NOT NULL columns (the primary key is checked on its own), `defaults` the SQL DEFAULT text SQLite
// reports, `types` the declared column types.
const FEATURE_004_TABLES = {
  api_keys: {
    model: "ApiKey",
    columns: [
      "id", "name", "nameKey", "lookupId", "secretHash", "last4", "rights", "policyMode", "recipients",
      "limitPerMinute", "limitPerDay", "limitPending", "ipAllow", "expiresAt", "revokedAt", "lastUsedAt", "lastIp",
      "seenIps", "version", "createdAt", "updatedAt",
    ],
    primary: ["id"],
    indexes: [
      { name: "api_keys_lookup_id", unique: true, columns: ["lookupId"] },
      { name: "api_keys_name_key", unique: true, columns: ["nameKey"] },
    ],
    notNull: ["name", "lookupId", "secretHash", "last4", "rights", "policyMode", "recipients", "ipAllow", "seenIps", "version", "createdAt", "updatedAt"],
    defaults: { rights: "'[]'", policyMode: "'list'", recipients: "'[]'", ipAllow: "'[]'", seenIps: "'[]'", version: "1" },
    types: { name: "VARCHAR(64)", nameKey: "VARCHAR(128)", lookupId: "VARCHAR(16)", secretHash: "VARCHAR(64)", last4: "VARCHAR(4)", policyMode: "VARCHAR(8)", lastIp: "VARCHAR(45)", limitPerMinute: "INTEGER", version: "INTEGER", rights: "JSON", expiresAt: "DATETIME" },
  },
  api_messages: {
    model: "ApiMessage",
    columns: [
      "id", "publicId", "apiKeyId", "source", "idempotencyKey", "requestHash", "recipient", "format", "size", "status", "errorCode",
      "waId", "requestId", "acceptedAt", "expiresAt", "sendingAt", "sentAt", "deliveredAt", "readAt", "endedAt", "repliesUntil",
      "payload", "choices", "replyData", "pollSecret", "mediaPath", "createdAt", "updatedAt",
    ],
    primary: ["id"],
    indexes: [
      { name: "api_messages_public_id", unique: true, columns: ["publicId"] },
      { name: "api_messages_api_key_id_idempotency_key", unique: true, columns: ["apiKeyId", "idempotencyKey"] },
      { name: "api_messages_wa_id", unique: true, columns: ["waId"] },
      { name: "api_messages_status_accepted_at", unique: false, columns: ["status", "acceptedAt"] },
      { name: "api_messages_api_key_id_status", unique: false, columns: ["apiKeyId", "status"] },
      { name: "api_messages_api_key_id_accepted_at", unique: false, columns: ["apiKeyId", "acceptedAt"] },
      { name: "api_messages_accepted_at", unique: false, columns: ["acceptedAt"] },
    ],
    notNull: ["publicId", "source", "recipient", "format", "status", "acceptedAt", "expiresAt", "createdAt", "updatedAt"],
    defaults: { source: "'api'", status: "'queued'" },
    types: { publicId: "VARCHAR(32)", source: "VARCHAR(5)", idempotencyKey: "VARCHAR(80)", requestHash: "VARCHAR(64)", recipient: "VARCHAR(64)", format: "VARCHAR(24)", size: "INTEGER", status: "VARCHAR(10)", errorCode: "VARCHAR(40)", waId: "VARCHAR(64)", requestId: "VARCHAR(16)", payload: "JSON", choices: "JSON", replyData: "JSON", pollSecret: "VARCHAR(255)", mediaPath: "VARCHAR(255)", acceptedAt: "DATETIME" },
  },
  api_message_responses: {
    model: "ApiMessageResponse",
    columns: ["id", "messageId", "kind", "author", "voterKey", "choiceIds", "via", "sourceId", "respondedAt", "createdAt", "updatedAt"],
    primary: ["id"],
    indexes: [
      { name: "api_message_responses_message_id_voter_key", unique: true, columns: ["messageId", "voterKey"] },
      { name: "api_message_responses_message_id_source_id", unique: true, columns: ["messageId", "sourceId"] },
      { name: "api_message_responses_message_id_responded_at", unique: false, columns: ["messageId", "respondedAt"] },
      { name: "api_message_responses_responded_at", unique: false, columns: ["respondedAt"] },
    ],
    notNull: ["messageId", "kind", "author", "choiceIds", "respondedAt", "createdAt", "updatedAt"],
    defaults: { choiceIds: "'[]'" },
    types: { messageId: "INTEGER", kind: "VARCHAR(6)", author: "VARCHAR(64)", voterKey: "VARCHAR(64)", choiceIds: "JSON", via: "VARCHAR(6)", sourceId: "VARCHAR(64)", respondedAt: "DATETIME" },
  },
  api_state: {
    model: "ApiState",
    columns: ["id", "enabled", "plainHttpFrom", "createdAt", "updatedAt"],
    primary: ["id"],
    indexes: [],
    notNull: ["enabled", "plainHttpFrom", "createdAt", "updatedAt"],
    defaults: { enabled: "0", plainHttpFrom: "'[]'" },
    types: { id: "INTEGER", enabled: "TINYINT(1)", plainHttpFrom: "JSON" },
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
    const everyTable = [...Object.keys(NEW_TABLES), ...Object.keys(FEATURE_003_TABLES), ...Object.keys(FEATURE_004_TABLES), ...OLD_TABLES].sort();
    assert.deepEqual([...first.summary.created].sort(), everyTable);
    await withDb(file, async (db) => {
      assert.deepEqual(await tableNames(db), everyTable);
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

describe("command permissions table (003-command-permissions): schema", () => {
  const file = newDbFile();
  let first;
  let second;

  before(() => {
    first = boot(file);
    second = boot(file);
  });

  test("permission_rules is created by sync(), next to the 14 + 18 tables of earlier features", () => {
    assert.equal(Object.keys(FEATURE_003_TABLES).length, 1);
    assert.equal(Object.keys(NEW_TABLES).length, 14, "the 002 list is untouched");
    assert.ok(first.summary.created.includes("permission_rules"));
    assert.equal(first.summary.created.length, 14 + 18 + 1 + 4, "+ the four tables of feature 004");
    assert.deepEqual(first.summary.repaired, []);
    assert.deepEqual(first.summary.warnings, []);
    assert.deepEqual(first.summary.errors, []);
  });

  test("a second sync() is a no-op", () => {
    assertNothingChanged(second);
  });

  for (const [table, spec] of Object.entries(FEATURE_003_TABLES)) {
    test(`${table}: columns, composite primary key, no per-column UNIQUE, no index`, async () => {
      await withDb(file, async (db) => {
        assert.deepEqual((await columnNames(db, table)).sort(), [...spec.columns].sort());
        assert.deepEqual(await primaryKey(db, table), ["command", "scope"]);
        assert.deepEqual(await primaryKey(db, table), spec.primary);
        assert.deepEqual(await uniqueColumns(db, table), [], "no UNIQUE constraint per column");
        assert.deepEqual(await indexes(db, table), {}, "no secondary index");
        const info = await db.all(`PRAGMA table_info(\`${table}\`)`);
        const by = Object.fromEntries(info.map((c) => [c.name, c]));
        for (const column of spec.columns) assert.equal(by[column].notnull, 1, `${column} is NOT NULL`);
        assert.equal(by.scope.dflt_value, "'*'");
        assert.equal(by.people.dflt_value, "'[]'");
      });
    });
  }

  test("the composite key allows one command in two scopes and one scope for two commands, but not the same pair twice", async () => {
    await withDb(file, async (db) => {
      const insert = (command, scope) =>
        db.run("INSERT INTO permission_rules (command, scope, mode, people, createdAt, updatedAt) VALUES (?, ?, 'only', '[]', ?, ?)", [command, scope, NOW, NOW]);
      await insert("vv", "*");
      await insert("vv", "120363@g.us");
      await insert("save", "*");
      await assert.rejects(insert("vv", "*"), /UNIQUE constraint failed/);
    });
  });

  test("a database that predates the feature only gains permission_rules: no existing table is altered, no row lost", async () => {
    const legacy = newDbFile();
    boot(legacy);
    const before_ = {};
    await withDb(legacy, async (db) => {
      await db.run("INSERT INTO warns (jid, groupJid, createdAt, updatedAt) VALUES ('a@s.whatsapp.net', 'g1@g.us', ?, ?)", [NOW, NOW]);
      await db.run("INSERT INTO command_states (command, scope, createdAt, updatedAt) VALUES ('ping', '*', ?, ?)", [NOW, NOW]);
      const everyOther = [...OLD_TABLES, ...Object.keys(NEW_TABLES)];
      before_.schema = await schemaOf(db, everyOther);
      for (const table of ["warns", "command_states"]) before_[table] = await db.all(`SELECT * FROM \`${table}\` ORDER BY rowid`);
      await db.run("DROP TABLE permission_rules");
    });

    const upgraded = boot(legacy);
    assert.deepEqual(upgraded.summary.created, ["permission_rules"]);
    assert.deepEqual(
      [upgraded.summary.repaired, upgraded.summary.columns, upgraded.summary.indexes, upgraded.summary.warnings, upgraded.summary.errors],
      [[], [], [], [], []],
      "0 existing table altered",
    );

    await withDb(legacy, async (db) => {
      assert.deepEqual(await schemaOf(db, [...OLD_TABLES, ...Object.keys(NEW_TABLES)]), before_.schema, "the 32 existing tables keep their exact schema and indexes");
      for (const table of ["warns", "command_states"]) {
        assert.deepEqual(await db.all(`SELECT * FROM \`${table}\` ORDER BY rowid`), before_[table], `${table} rows`);
      }
    });
    assertNothingChanged(boot(legacy));
  });

  test("no DataTypes.ENUM in the model file, defined under its file name", () => {
    for (const spec of Object.values(FEATURE_003_TABLES)) {
      const source = fs.readFileSync(path.join(ROOT, "lib", "database", "models", `${spec.model}.js`), "utf8");
      assert.doesNotMatch(source, /ENUM/, spec.model);
      assert.match(source, new RegExp(`sequelize\\.define\\(\\s*"${spec.model}"`), `${spec.model} is defined under its file name`);
    }
  });
});

// ---------------------------------------------------------------------------
// specs/004-messaging-api: the four tables of the messaging API (data-model sections 0 to 4)
// ---------------------------------------------------------------------------

describe("messaging API tables (004-messaging-api): schema", () => {
  const file = newDbFile();
  let first;
  let second;

  before(() => {
    first = boot(file);
    second = boot(file);
  });

  test("the four tables are created, next to the 14 + 18 + 1 tables of earlier features", async () => {
    assert.deepEqual(Object.keys(FEATURE_004_TABLES).sort(), ["api_keys", "api_message_responses", "api_messages", "api_state"]);
    for (const table of Object.keys(FEATURE_004_TABLES)) assert.ok(first.summary.created.includes(table), `${table} created`);
    assert.equal(first.summary.created.length, 14 + 18 + 1 + 4);
    assert.deepEqual([first.summary.repaired, first.summary.columns, first.summary.indexes, first.summary.warnings, first.summary.errors], [[], [], [], [], []]);
    await withDb(file, async (db) => {
      for (const table of Object.keys(FEATURE_004_TABLES)) assert.ok(await tableExists(db, table), table);
    });
  });

  test("a second sync() is a no-op", () => {
    assertNothingChanged(second);
  });

  for (const [table, spec] of Object.entries(FEATURE_004_TABLES)) {
    test(`${table}: columns, primary key, indexes by derived name, no per-column UNIQUE`, async () => {
      await withDb(file, async (db) => {
        assert.deepEqual((await columnNames(db, table)).sort(), [...spec.columns].sort());
        assert.deepEqual(await primaryKey(db, table), spec.primary);
        assert.deepEqual(await uniqueColumns(db, table), [], "no UNIQUE constraint per column");

        const found = await indexes(db, table);
        assert.deepEqual(Object.keys(found).sort(), spec.indexes.map((i) => i.name).sort());
        for (const wanted of spec.indexes) {
          assert.deepEqual(found[wanted.name], { unique: wanted.unique, columns: wanted.columns }, wanted.name);
          assert.ok(wanted.name.length <= 63, `${wanted.name} fits the 63 characters of Postgres`);
        }
      });
    });

    test(`${table}: NOT NULL, defaults and declared types of every column`, async () => {
      await withDb(file, async (db) => {
        const by = Object.fromEntries((await db.all(`PRAGMA table_info(\`${table}\`)`)).map((c) => [c.name, c]));
        for (const column of spec.columns) {
          if (spec.primary.includes(column)) continue; // an INTEGER PRIMARY KEY never reports notnull
          assert.equal(by[column].notnull, spec.notNull.includes(column) ? 1 : 0, `${column} ${spec.notNull.includes(column) ? "is" : "is not"} NOT NULL`);
        }
        for (const column of spec.columns) {
          assert.equal(by[column].dflt_value, spec.defaults[column] ?? null, `${column} default`);
        }
        for (const [column, type] of Object.entries(spec.types)) assert.equal(by[column].type, type, `${column} type`);
      });
    });
  }

  test("the seven unique and the six non-unique indexes, nothing else", async () => {
    await withDb(file, async (db) => {
      let unique = 0;
      let plain = 0;
      for (const table of Object.keys(FEATURE_004_TABLES)) {
        for (const index of Object.values(await indexes(db, table))) index.unique ? unique++ : plain++;
      }
      assert.deepEqual([unique, plain], [7, 6]);
    });
  });

  test("api_state keeps its single id 1 as the primary key (no auto-increment)", async () => {
    await withDb(file, async (db) => {
      const [{ sql }] = await db.all("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_state'");
      assert.doesNotMatch(sql, /AUTOINCREMENT/i);
      const [{ sql: keys }] = await db.all("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'");
      assert.match(keys, /AUTOINCREMENT/i);
    });
  });

  test("a NULL does not collide in a unique index; a duplicate non-NULL pair is refused", async () => {
    await withDb(file, async (db) => {
      const key = (name, nameKey, lookupId) =>
        db.run("INSERT INTO api_keys (name, nameKey, lookupId, secretHash, last4, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'abcd', ?, ?)", [name, nameKey, lookupId, lookupId.repeat(4), NOW, NOW]);
      // two revoked keys with the same name: nameKey NULL on both
      await key("Billing", null, "aaaaaaaaaaaaaaaa");
      await key("Billing", null, "bbbbbbbbbbbbbbbb");
      // a live key with the folded name, then a second one is refused
      await key("Billing", "billing", "cccccccccccccccc");
      await assert.rejects(key("BILLING", "billing", "dddddddddddddddd"), /UNIQUE constraint failed: api_keys\.nameKey/);
      await assert.rejects(key("Other", "other", "cccccccccccccccc"), /UNIQUE constraint failed: api_keys\.lookupId/);

      const message = (publicId, apiKeyId, idempotencyKey, waId) =>
        db.run(
          "INSERT INTO api_messages (publicId, apiKeyId, idempotencyKey, waId, recipient, format, acceptedAt, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, '237690000001@s.whatsapp.net', 'text', ?, ?, ?, ?)",
          [publicId, apiKeyId, idempotencyKey, waId, NOW, NOW, NOW, NOW],
        );
      // calls without an idempotency key, panel rows (apiKeyId NULL), rows without a waId
      await message("msg_AAAAAAAAAAAAAAAAAAAAAA", 1, null, null);
      await message("msg_BBBBBBBBBBBBBBBBBBBBBB", 1, null, null);
      await message("msg_CCCCCCCCCCCCCCCCCCCCCC", null, "same-key", null);
      await message("msg_DDDDDDDDDDDDDDDDDDDDDD", null, "same-key", null);
      // the same key and the same idempotency key is a conflict, another key is not
      await message("msg_EEEEEEEEEEEEEEEEEEEEEE", 1, "k1", "3EB0AAAA");
      await assert.rejects(message("msg_FFFFFFFFFFFFFFFFFFFFFF", 1, "k1", null), /UNIQUE constraint failed: api_messages\.apiKeyId, api_messages\.idempotencyKey/);
      await message("msg_GGGGGGGGGGGGGGGGGGGGGG", 2, "k1", null);
      await assert.rejects(message("msg_HHHHHHHHHHHHHHHHHHHHHH", 2, null, "3EB0AAAA"), /UNIQUE constraint failed: api_messages\.waId/);
      await assert.rejects(message("msg_AAAAAAAAAAAAAAAAAAAAAA", 3, null, null), /UNIQUE constraint failed: api_messages\.publicId/);

      const response = (messageId, kind, voterKey, sourceId) =>
        db.run(
          "INSERT INTO api_message_responses (messageId, kind, author, voterKey, sourceId, respondedAt, createdAt, updatedAt) VALUES (?, ?, '237690000002@s.whatsapp.net', ?, ?, ?, ?, ?)",
          [messageId, kind, voterKey, sourceId, NOW, NOW, NOW],
        );
      // choice responses have no voterKey and no sourceId: they never collide
      await response(1, "choice", null, null);
      await response(1, "choice", null, null);
      await response(1, "vote", "237690000002@s.whatsapp.net", "S1");
      await assert.rejects(response(1, "vote", "237690000002@s.whatsapp.net", "S2"), /UNIQUE constraint failed: api_message_responses\.messageId, api_message_responses\.voterKey/);
      await assert.rejects(response(1, "vote", "237690000003@s.whatsapp.net", "S1"), /UNIQUE constraint failed: api_message_responses\.messageId, api_message_responses\.sourceId/);
      await response(2, "vote", "237690000002@s.whatsapp.net", "S1");
    });
  });

  test("a database that predates the feature only gains the four tables: no existing table is altered, no row lost", async () => {
    const legacy = newDbFile();
    boot(legacy);
    const before_ = {};
    await withDb(legacy, async (db) => {
      await db.run("INSERT INTO warns (jid, groupJid, createdAt, updatedAt) VALUES ('a@s.whatsapp.net', 'g1@g.us', ?, ?)", [NOW, NOW]);
      await db.run("INSERT INTO alert_outbox (type, status, attempts, createdAt, updatedAt) VALUES ('reconnected', 'pending', 0, ?, ?)", [NOW, NOW]);
      const everyOther = [...OLD_TABLES, ...Object.keys(NEW_TABLES), ...Object.keys(FEATURE_003_TABLES)];
      before_.schema = await schemaOf(db, everyOther);
      for (const table of ["warns", "alert_outbox"]) before_[table] = await db.all(`SELECT * FROM \`${table}\` ORDER BY rowid`);
      for (const table of Object.keys(FEATURE_004_TABLES)) await db.run(`DROP TABLE \`${table}\``);
    });

    const upgraded = boot(legacy);
    assert.deepEqual([...upgraded.summary.created].sort(), Object.keys(FEATURE_004_TABLES).sort());
    assert.deepEqual(
      [upgraded.summary.repaired, upgraded.summary.columns, upgraded.summary.indexes, upgraded.summary.warnings, upgraded.summary.errors],
      [[], [], [], [], []],
      "0 existing table altered",
    );

    await withDb(legacy, async (db) => {
      assert.deepEqual(
        await schemaOf(db, [...OLD_TABLES, ...Object.keys(NEW_TABLES), ...Object.keys(FEATURE_003_TABLES)]),
        before_.schema,
        "the 33 existing tables keep their exact schema and indexes",
      );
      for (const table of ["warns", "alert_outbox"]) {
        assert.deepEqual(await db.all(`SELECT * FROM \`${table}\` ORDER BY rowid`), before_[table], `${table} rows`);
      }
    });
    assertNothingChanged(boot(legacy));
  });

  test("no DataTypes.ENUM in the four model files, each defined under its file name", () => {
    for (const spec of Object.values(FEATURE_004_TABLES)) {
      const source = fs.readFileSync(path.join(ROOT, "lib", "database", "models", `${spec.model}.js`), "utf8");
      assert.doesNotMatch(source, /ENUM/, spec.model);
      assert.match(source, new RegExp(`sequelize\\.define\\(\\s*"${spec.model}"`), `${spec.model} is defined under its file name`);
      assert.doesNotMatch(source, /^\s*unique:\s*true,?\s*$/m, `${spec.model}: a unique index is declared in indexes[], never as a column option`);
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

  // ---- specs/003-command-permissions: PermissionRule (data-model section 1). Kept in this block: the in-memory
  // database is a module singleton that this block's `after` closes.

  const PN = "237690000001@s.whatsapp.net";
  const PN2 = "237690000002@s.whatsapp.net";
  const LID = "123456789012345@lid";
  const LID2 = "987654321098765@lid";
  const rule = (people, over = {}) => ({ command: "vv", scope: "*", mode: "extra", people, ...over });
  const manyPeople = (n) => Array.from({ length: n }, (_, i) => ({ pn: `2376900${String(i).padStart(5, "0")}@s.whatsapp.net`, lid: null }));
  const clearRules = () => db.PermissionRule.destroy({ where: {} });

  test("PermissionRule: loaded under its file name, composite key, defaults, timestamps", async () => {
    assert.ok(db.PermissionRule);
    assert.equal(db.PermissionRule.tableName, "permission_rules");
    assert.deepEqual(db.PermissionRule.primaryKeyAttributes, ["command", "scope"]);
    assert.equal(db.PermissionRule.rawAttributes.id, undefined, "no surrogate id");

    const row = await db.PermissionRule.create({ command: "vv", mode: "only" });
    assert.equal(row.scope, "*", "scope defaults to everywhere");
    assert.deepEqual(row.people, [], "people defaults to an empty list");
    assert.ok(row.createdAt instanceof Date && row.updatedAt instanceof Date);

    await assert.rejects(db.PermissionRule.create({ command: "vv", scope: "*", mode: "extra" }), /unique|Validation error/i, "one rule per (command, scope)");
    await db.PermissionRule.create({ command: "vv", scope: "120363@g.us", mode: "extra" });
    await db.PermissionRule.create({ command: "save", scope: "*", mode: "only" });
    assert.equal(await db.PermissionRule.count(), 3);
    await clearRules();
  });

  test("PermissionRule.mode: only extra and only, a STRING checked by isIn", async () => {
    await db.PermissionRule.build(rule([], { mode: "extra" })).validate();
    await db.PermissionRule.build(rule([], { mode: "only" })).validate();
    for (const mode of ["all", "normal", "EXTRA", "Only", "", " only", "extra ", null, undefined, 1]) {
      await rejects(db.PermissionRule.build(rule([], { mode })).validate(), /Validation/);
    }
    await rejects(db.PermissionRule.create(rule([], { mode: "all" })));
    assert.equal(await db.PermissionRule.count(), 0, "nothing stored");

    await db.PermissionRule.create(rule([], { mode: "only" }));
    await rejects(db.PermissionRule.update({ mode: "all" }, { where: { command: "vv" } }));
    assert.equal((await db.PermissionRule.findOne({ where: { command: "vv", scope: "*" } })).mode, "only", "the bulk update was refused");
    await clearRules();
  });

  test("PermissionRule.people: an empty list and 100 persons are accepted, 101 is not", async () => {
    await db.PermissionRule.build(rule([])).validate();
    await db.PermissionRule.build(rule(manyPeople(100))).validate();
    await rejects(db.PermissionRule.build(rule(manyPeople(101))).validate(), /at most 100/);
    await rejects(db.PermissionRule.create(rule(manyPeople(101))), /at most 100/);
    await rejects(db.PermissionRule.update({ people: manyPeople(101) }, { where: { command: "vv" } }), /at most 100/);

    const stored = await db.PermissionRule.create(rule(manyPeople(100)));
    assert.equal((await db.PermissionRule.findOne({ where: { command: stored.command, scope: "*" } })).people.length, 100);
    await clearRules();
  });

  test("PermissionRule.people: a non-array is refused", async () => {
    for (const people of ["", "[]", `[{"pn":"${PN}","lid":null}]`, {}, { pn: PN, lid: null }, 0, 5, true]) {
      await rejects(db.PermissionRule.build(rule(people)).validate(), /people must be an array/);
    }
    await rejects(db.PermissionRule.build(rule(null)).validate(), /people cannot be null/);
  });

  test("PermissionRule.people: each item has exactly the keys pn and lid", async () => {
    for (const item of [null, "237690000001", 5, [], [PN, LID]]) {
      await rejects(db.PermissionRule.build(rule([item])).validate(), /each item must be an object/);
    }
    const keys = /exactly the keys pn and lid/;
    await rejects(db.PermissionRule.build(rule([{}])).validate(), keys);
    await rejects(db.PermissionRule.build(rule([{ pn: PN }])).validate(), keys, "lid missing");
    await rejects(db.PermissionRule.build(rule([{ lid: LID }])).validate(), keys, "pn missing");
    await rejects(db.PermissionRule.build(rule([{ pn: PN, lid: null, name: "Awa" }])).validate(), keys, "an extra key");
    await rejects(db.PermissionRule.build(rule([{ pn: PN, id: LID }])).validate(), keys, "a wrong key");
    await rejects(db.PermissionRule.build(rule([{ pn: PN, lid: LID }, { pn: PN2 }])).validate(), keys, "one bad item among good ones");
  });

  test("PermissionRule.people: a person has at least one form", async () => {
    await rejects(db.PermissionRule.build(rule([{ pn: null, lid: null }])).validate(), /cannot both be null/);
    await rejects(db.PermissionRule.build(rule([{ pn: PN, lid: LID }, { pn: null, lid: null }])).validate(), /cannot both be null/);
    await db.PermissionRule.build(rule([{ pn: PN, lid: null }])).validate();
    await db.PermissionRule.build(rule([{ pn: null, lid: LID }])).validate();
    await db.PermissionRule.build(rule([{ pn: PN, lid: LID }])).validate();
  });

  test("PermissionRule.people: pn ends with @s.whatsapp.net and lid with @lid", async () => {
    for (const pn of [LID, "237690000001@g.us", "237690000001@S.WHATSAPP.NET", "237690000001", PN + " ", 237690000001, undefined, true, ""]) {
      await rejects(db.PermissionRule.build(rule([{ pn, lid: LID }])).validate(), /pn must be null or end with @s\.whatsapp\.net/);
    }
    for (const lid of [PN, "123456789012345@LID", "123456789012345@g.us", "123456789012345", LID + " ", 123456789012345, undefined, false, ""]) {
      await rejects(db.PermissionRule.build(rule([{ pn: PN, lid }])).validate(), /lid must be null or end with @lid/);
    }
  });

  test("PermissionRule.people: every form is already normalized (no device suffix, no c.us, no empty user)", async () => {
    const notNormalized = /is not a normalized JID/;
    await rejects(db.PermissionRule.build(rule([{ pn: "237690000001:7@s.whatsapp.net", lid: null }])).validate(), notNormalized, "device suffix on a pn");
    await rejects(db.PermissionRule.build(rule([{ pn: null, lid: "123456789012345:4@lid" }])).validate(), notNormalized, "device suffix on a lid");
    await rejects(db.PermissionRule.build(rule([{ pn: "237690000001_1@s.whatsapp.net", lid: null }])).validate(), notNormalized, "agent suffix");
    await rejects(db.PermissionRule.build(rule([{ pn: "@s.whatsapp.net", lid: null }])).validate(), notNormalized, "empty user part");
    await rejects(db.PermissionRule.build(rule([{ pn: null, lid: "@lid" }])).validate(), notNormalized, "empty user part of a lid");
    // the c.us form: it never reaches the normalization, its suffix is refused first
    await rejects(db.PermissionRule.build(rule([{ pn: "237690000001@c.us", lid: null }])).validate(), /pn must be null or end with/);
    await rejects(db.PermissionRule.build(rule([{ pn: "237690000001:7@c.us", lid: LID }])).validate(), /pn must be null or end with/);
  });

  test("PermissionRule: extra with an empty list is a legal row; scope is not validated; duplicates are a service rule", async () => {
    await db.PermissionRule.create(rule([], { mode: "extra", scope: "120363@g.us" }));
    await db.PermissionRule.create(rule([], { mode: "extra", command: "save" }));
    await db.PermissionRule.create(rule([], { mode: "only", command: "kick", scope: "120363@g.us" }));
    await db.PermissionRule.create(rule([{ pn: PN, lid: LID }, { pn: PN, lid: LID }], { command: "tag", scope: "not-a-jid" }));
    assert.equal(await db.PermissionRule.count(), 4);
    await clearRules();
  });

  test("PermissionRule.people: a JSON round trip gives an array of plain objects through model instances", async () => {
    const people = [
      { pn: PN, lid: LID },
      { pn: null, lid: LID2 },
      { pn: PN2, lid: null },
    ];
    await db.PermissionRule.create(rule(people, { mode: "only" }));
    await db.PermissionRule.create(rule([], { command: "save" }));

    const one = await db.PermissionRule.findOne({ where: { command: "vv", scope: "*" } });
    assert.ok(Array.isArray(one.people));
    assert.deepEqual(one.people, people);
    assert.deepEqual(one.get({ plain: true }).people, people);
    assert.deepEqual(one.toJSON().people, people);

    const all = await db.PermissionRule.findAll({ order: [["command", "ASC"]] });
    assert.deepEqual(all.map((r) => r.command), ["save", "vv"]);
    assert.ok(all.every((r) => Array.isArray(r.people)));
    assert.deepEqual(all[0].people, []);

    // a replace keeps the key and the creation date, changes the list
    const createdAt = one.createdAt.getTime();
    one.people = [{ pn: PN2, lid: LID2 }];
    one.mode = "extra";
    await one.save();
    const again = await db.PermissionRule.findOne({ where: { command: "vv", scope: "*" } });
    assert.deepEqual(again.people, [{ pn: PN2, lid: LID2 }]);
    assert.equal(again.mode, "extra");
    assert.equal(again.createdAt.getTime(), createdAt);

    // the validator also runs on save()
    again.people = [{ pn: null, lid: null }];
    await rejects(again.save(), /cannot both be null/);
    await clearRules();
  });

  // ---- specs/004-messaging-api: ApiKey, ApiMessage, ApiMessageResponse, ApiState and AlertOutbox.TYPES (data-model
  // sections 0 to 4, 8.3). Same block: the in-memory database is a module singleton that `after` closes.

  const refuses = (promise, pattern = /Validation|cannot be null/) => assert.rejects(promise, pattern);
  let seq = 0;
  const KEY_PN = "237690000001@s.whatsapp.net";
  const GROUP = "120363000000000001@g.us";
  const later = new Date("2026-01-01T00:10:00Z");
  const keyRow = (over = {}) => {
    const n = ++seq;
    return { name: `Key ${n}`, nameKey: `key ${n}`, lookupId: n.toString(16).padStart(16, "0"), secretHash: n.toString(16).padStart(64, "0"), last4: "abcd", ...over };
  };
  const publicId = (n = ++seq) => `msg_${String(n).padStart(22, "A")}`;
  const messageRow = (over = {}) => ({ publicId: publicId(), apiKeyId: 1, recipient: KEY_PN, format: "text", acceptedAt: when, expiresAt: later, ...over });
  const responseRow = (over = {}) => ({ messageId: 1, kind: "choice", author: KEY_PN, respondedAt: when, ...over });
  const manyOf = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const clear4 = async () => {
    for (const name of ["ApiMessageResponse", "ApiMessage", "ApiKey", "ApiState"]) await db[name].destroy({ where: {} });
  };

  test("the four API models are loaded under their file names, with their table names and keys", () => {
    for (const [table, spec] of Object.entries(FEATURE_004_TABLES)) {
      assert.ok(db[spec.model], spec.model);
      assert.equal(db[spec.model].name, spec.model);
      assert.equal(db[spec.model].tableName, table);
      assert.deepEqual(db[spec.model].primaryKeyAttributes, spec.primary);
    }
  });

  test("ApiKey: defaults, nullable columns, array columns come back as arrays through every read", async () => {
    const created = await (await db.ApiKey.create(keyRow())).reload();
    assert.deepEqual(
      [created.rights, created.policyMode, created.recipients, created.ipAllow, created.seenIps, created.version],
      [[], "list", [], [], [], 1],
    );
    for (const column of ["limitPerMinute", "limitPerDay", "limitPending", "expiresAt", "revokedAt", "lastUsedAt", "lastIp"]) assert.equal(created[column], null, column);

    await db.ApiKey.create(
      keyRow({
        rights: ["messages.send.text", "messages.read"],
        recipients: [KEY_PN, GROUP],
        ipAllow: ["10.0.0.0/8", "2001:db8::/32"],
        seenIps: ["203.0.113.5", "2001:db8:1:2::/64"],
      }),
    );
    for (const row of [...(await db.ApiKey.findAll()), (await db.ApiKey.findAll({ limit: 1 }))[0], await db.ApiKey.findByPk(created.id)]) {
      for (const column of ["rights", "recipients", "ipAllow", "seenIps"]) assert.ok(Array.isArray(row[column]), `${column} is an array`);
    }
    const full = (await db.ApiKey.findAll({ order: [["id", "ASC"]] }))[1];
    assert.deepEqual(full.rights, ["messages.send.text", "messages.read"]);
    assert.deepEqual(full.get({ plain: true }).seenIps, ["203.0.113.5", "2001:db8:1:2::/64"]);
    await clear4();
  });

  test("ApiKey: policyMode is list, known or anyone; name is not empty", async () => {
    for (const policyMode of ["list", "known", "anyone"]) await db.ApiKey.build(keyRow({ policyMode })).validate();
    for (const policyMode of ["all", "ANYONE", "", " list", null]) await refuses(db.ApiKey.build(keyRow({ policyMode })).validate());
    await refuses(db.ApiKey.build(keyRow({ name: "" })).validate());
    await refuses(db.ApiKey.build(keyRow({ name: null })).validate());
    await refuses(db.ApiKey.build(keyRow({ lookupId: null })).validate());
    await refuses(db.ApiKey.build(keyRow({ secretHash: null })).validate());
  });

  test("ApiKey: lookupId is 16 lower-case hex characters, secretHash 64", async () => {
    await db.ApiKey.build(keyRow({ lookupId: "0123456789abcdef", secretHash: "f".repeat(64) })).validate();
    for (const lookupId of ["0123456789abcde", "0123456789abcdef0", "0123456789ABCDEF", "0123456789abcdeg", "", "owbk_0123456789ab"]) {
      await refuses(db.ApiKey.build(keyRow({ lookupId })).validate(), /Validation/);
    }
    for (const secretHash of ["f".repeat(63), "f".repeat(65), "F".repeat(64), "g".repeat(64), ""]) {
      await refuses(db.ApiKey.build(keyRow({ secretHash })).validate(), /Validation/);
    }
  });

  test("ApiKey.rights: at most 64 distinct ids of the right shape", async () => {
    await db.ApiKey.build(keyRow({ rights: ["messages.send.text", "messages.read", "media.url", "api.docs", "messages", "a.b_c.d9"] })).validate();
    await db.ApiKey.build(keyRow({ rights: manyOf(64, (i) => `messages.send.r${i}`) })).validate();
    await refuses(db.ApiKey.build(keyRow({ rights: manyOf(65, (i) => `messages.send.r${i}`) })).validate(), /at most 64/);
    await refuses(db.ApiKey.build(keyRow({ rights: ["messages.read", "messages.read"] })).validate(), /duplicate/);
    for (const bad of ["Messages.read", "messages..read", "messages.", ".messages", "messages.read-all", "messages read", "1messages", "", `a.${"b".repeat(63)}`, 5, null, {}]) {
      await refuses(db.ApiKey.build(keyRow({ rights: [bad] })).validate(), /rights/);
    }
    for (const notArray of ["messages.read", {}, 7, true]) await refuses(db.ApiKey.build(keyRow({ rights: notArray })).validate(), /rights must be an array/);
    await refuses(db.ApiKey.build(keyRow({ rights: null })).validate(), /rights cannot be null/);
    await refuses(db.ApiKey.update({ rights: ["Bad"] }, { where: { id: 1 } }), /rights/);
  });

  test("ApiKey.recipients: at most 200 JIDs, a phone number or a group, never a LID", async () => {
    await db.ApiKey.build(keyRow({ recipients: [KEY_PN, GROUP, "12036-1234@g.us", "12345678@s.whatsapp.net", "123456789012345@s.whatsapp.net"] })).validate();
    await db.ApiKey.build(keyRow({ recipients: manyOf(200, (i) => `2376900${String(10000 + i)}@s.whatsapp.net`) })).validate();
    await refuses(db.ApiKey.build(keyRow({ recipients: manyOf(201, (i) => `2376900${String(10000 + i)}@s.whatsapp.net`) })).validate(), /at most 200/);
    const bad = [
      "123456789012345@lid", "0237690000001@s.whatsapp.net", "1234567@s.whatsapp.net", "1234567890123456@s.whatsapp.net",
      "237690000001@c.us", "237690000001@S.WHATSAPP.NET", "237690000001:7@s.whatsapp.net", "237690000001", "1234@g.us", "g@g.us",
      "120363-@g.us", " 237690000001@s.whatsapp.net", "", 237690000001, null, {},
    ];
    for (const jid of bad) await refuses(db.ApiKey.build(keyRow({ recipients: [jid] })).validate(), /recipients/, String(jid));
    await refuses(db.ApiKey.build(keyRow({ recipients: "x" })).validate(), /recipients must be an array/);
  });

  test("ApiKey quotas: integers inside their bounds, or NULL", async () => {
    const bounds = { limitPerMinute: [1, 1000], limitPerDay: [1, 100000], limitPending: [1, 5000] };
    for (const [column, [min, max]] of Object.entries(bounds)) {
      for (const ok of [min, max, null, undefined]) await db.ApiKey.build(keyRow({ [column]: ok })).validate();
      for (const bad of [0, min - 1, max + 1, 1.5, "ten", NaN, -1]) await refuses(db.ApiKey.build(keyRow({ [column]: bad })).validate(), /Validation/, `${column} ${bad}`);
    }
    const stored = await (await db.ApiKey.create(keyRow({ limitPerMinute: 5, limitPerDay: null }))).reload();
    assert.deepEqual([stored.limitPerMinute, stored.limitPerDay, stored.limitPending], [5, null, null]);
    await clear4();
  });

  test("ApiKey.ipAllow and seenIps: caps of 50 and 20, strings only; the grammar is not the model's", async () => {
    await db.ApiKey.build(keyRow({ ipAllow: manyOf(50, (i) => `10.0.${i}.0/24`), seenIps: manyOf(20, (i) => `203.0.113.${i}`) })).validate();
    await refuses(db.ApiKey.build(keyRow({ ipAllow: manyOf(51, (i) => `10.0.${i}.0/24`) })).validate(), /at most 50/);
    await refuses(db.ApiKey.build(keyRow({ seenIps: manyOf(21, (i) => `203.0.113.${i}`) })).validate(), /at most 20/);
    await db.ApiKey.build(keyRow({ ipAllow: ["x".repeat(50)] })).validate();
    await refuses(db.ApiKey.build(keyRow({ ipAllow: ["x".repeat(51)] })).validate(), /ipAllow/);
    for (const bad of [5, null, {}, ["a"]]) {
      await refuses(db.ApiKey.build(keyRow({ ipAllow: [bad] })).validate(), /ipAllow/);
      await refuses(db.ApiKey.build(keyRow({ seenIps: [bad] })).validate(), /seenIps/);
    }
    await refuses(db.ApiKey.build(keyRow({ ipAllow: "10.0.0.0/8" })).validate(), /ipAllow must be an array/);
  });

  test("ApiKey: two revoked keys may share a name (nameKey NULL); a live name and a lookupId are unique", async () => {
    await db.ApiKey.create(keyRow({ name: "Billing", nameKey: null, revokedAt: when }));
    await db.ApiKey.create(keyRow({ name: "Billing", nameKey: null, revokedAt: when }));
    const live = await db.ApiKey.create(keyRow({ name: "Billing", nameKey: "billing" }));
    await assert.rejects(db.ApiKey.create(keyRow({ name: "BILLING", nameKey: "billing" })), /unique/i);
    await assert.rejects(db.ApiKey.create(keyRow({ lookupId: live.lookupId })), /unique/i);
    await clear4();
  });

  test("ApiMessage: defaults, nullable columns and the JSON columns", async () => {
    const created = await (await db.ApiMessage.create(messageRow())).reload();
    assert.deepEqual([created.source, created.status], ["api", "queued"]);
    for (const column of ["idempotencyKey", "requestHash", "size", "errorCode", "waId", "requestId", "sendingAt", "sentAt", "deliveredAt", "readAt", "endedAt", "repliesUntil", "payload", "choices", "replyData", "pollSecret", "mediaPath"]) {
      assert.equal(created[column], null, column);
    }

    const payload = { v: 1, input: { text: "hello" }, media: null, quote: null };
    const choices = [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }];
    const replyData = { v: 1, multi: false, hashes: ["a".repeat(64), "b".repeat(64)] };
    const full = await db.ApiMessage.create(messageRow({ payload, choices, replyData, pollSecret: "enc:v1:x:y:z", mediaPath: "data/api-media/x/source" }));
    for (const row of [await db.ApiMessage.findByPk(full.id), (await db.ApiMessage.findAll({ where: { id: full.id } }))[0]]) {
      assert.deepEqual(row.payload, payload);
      assert.deepEqual(row.choices, choices);
      assert.deepEqual(row.replyData, replyData);
    }

    // erasing the content writes a SQL NULL, not the text 'null' (invariant I2 and the housekeeping net rely on it)
    await db.ApiMessage.update({ payload: null, choices: null, replyData: null }, { where: { id: full.id } });
    const [raw] = await db.DATABASE.query("SELECT payload, choices, replyData FROM api_messages WHERE id = :id", { replacements: { id: full.id }, type: "SELECT" });
    assert.deepEqual(raw, { payload: null, choices: null, replyData: null });
    assert.equal(await db.ApiMessage.count({ where: { payload: null } }), 2);
    await clear4();
  });

  test("ApiMessage.publicId: msg_ plus 22 base64url characters", async () => {
    await db.ApiMessage.build(messageRow({ publicId: "msg_abcdefghijklmnopqrstuv" })).validate();
    await db.ApiMessage.build(messageRow({ publicId: "msg_A-_9A-_9A-_9A-_9A-_9AB".slice(0, 26) })).validate();
    for (const bad of ["msg_abcdefghijklmnopqrstu", "msg_abcdefghijklmnopqrstuvw", "msg_abcdefghijklmnopqrst+v", "msg_abcdefghijklmnopqrst/v", "Msg_abcdefghijklmnopqrstuv", "abcdefghijklmnopqrstuvwxyz", "", null]) {
      await refuses(db.ApiMessage.build(messageRow({ publicId: bad })).validate(), /Validation/, String(bad));
    }
  });

  test("ApiMessage.source and apiKeyId: api <=> a key, panel <=> no key", async () => {
    await db.ApiMessage.build(messageRow({ source: "api", apiKeyId: 3 })).validate();
    await db.ApiMessage.build(messageRow({ source: "panel", apiKeyId: null })).validate();
    await refuses(db.ApiMessage.build(messageRow({ source: "api", apiKeyId: null })).validate(), /apiKeyId/);
    await refuses(db.ApiMessage.build(messageRow({ source: "panel", apiKeyId: 3 })).validate(), /apiKeyId/);
    await refuses(db.ApiMessage.build(messageRow({ source: "cli", apiKeyId: null })).validate());
    await refuses(db.ApiMessage.create(messageRow({ source: "api", apiKeyId: undefined })), /apiKeyId/);
    await refuses(db.ApiMessage.create(messageRow({ source: "panel", apiKeyId: 2 })), /apiKeyId/);
    assert.equal(await db.ApiMessage.count(), 0, "nothing stored");

    // the transitions are static conditional UPDATEs on a partial build: the rule must not refuse them
    const row = await db.ApiMessage.create(messageRow({ source: "panel", apiKeyId: null }));
    const [changed] = await db.ApiMessage.update({ status: "sending", sendingAt: later, waId: "3EB0BBBB" }, { where: { id: row.id, status: "queued" } });
    assert.equal(changed, 1);
    assert.equal((await db.ApiMessage.findByPk(row.id)).status, "sending");
    const found = await db.ApiMessage.findByPk(row.id);
    found.status = "sent";
    await found.save();
    await clear4();
  });

  test("ApiMessage.status is one of the nine; errorCode and format are open sets", async () => {
    const statuses = ["queued", "sending", "sent", "delivered", "read", "failed", "expired", "cancelled", "unknown"];
    for (const status of statuses) await db.ApiMessage.build(messageRow({ status })).validate();
    for (const status of ["done", "SENT", "", " sent", null]) await refuses(db.ApiMessage.build(messageRow({ status })).validate());

    for (const errorCode of ["not_on_whatsapp", "whatsapp_rejected", "a_code_a_later_wave_invents", null]) {
      await db.ApiMessage.build(messageRow({ status: "failed", errorCode })).validate();
    }
    for (const format of ["text", "image", "my_new_format", "ab", "a".repeat(24)]) await db.ApiMessage.build(messageRow({ format })).validate();
    for (const format of ["Text", "1text", "a", "a".repeat(25), "te-xt", "te xt", "", null]) {
      await refuses(db.ApiMessage.build(messageRow({ format })).validate(), /Validation|cannot be null/, String(format));
    }
  });

  test("ApiMessage.idempotencyKey and recipient: shapes", async () => {
    for (const idempotencyKey of ["order-1234", "a", "A.b_c:d-e", "x".repeat(80), null]) await db.ApiMessage.build(messageRow({ idempotencyKey })).validate();
    for (const idempotencyKey of ["", "a b", "x".repeat(81), "é", "a/b", "a\n"]) await refuses(db.ApiMessage.build(messageRow({ idempotencyKey })).validate(), /Validation/);

    for (const recipient of [KEY_PN, GROUP, "12036-1234@g.us", "12345678@s.whatsapp.net"]) await db.ApiMessage.build(messageRow({ recipient })).validate();
    for (const recipient of ["123456789012345@lid", "0237690000001@s.whatsapp.net", "237690000001@c.us", "237690000001", "1234@g.us", "", null]) {
      await refuses(db.ApiMessage.build(messageRow({ recipient })).validate(), /Validation|cannot be null/, String(recipient));
    }
  });

  test("ApiMessage.payload: at most 128 KiB", async () => {
    await db.ApiMessage.build(messageRow({ payload: { v: 1, input: { text: "x".repeat(4096) } } })).validate();
    await db.ApiMessage.build(messageRow({ payload: { v: 1, input: { text: "x".repeat(131000) } } })).validate();
    await refuses(db.ApiMessage.build(messageRow({ payload: { v: 1, input: { text: "x".repeat(131072) } } })).validate(), /payload/);
    await refuses(db.ApiMessage.build(messageRow({ payload: { v: 1, input: { text: "é".repeat(70000) } } })).validate(), /payload/, "128 KiB is counted in bytes");
  });

  test("ApiMessage: publicId, (apiKeyId, idempotencyKey) and waId are unique, NULLs are not", async () => {
    await db.ApiMessage.create(messageRow({ idempotencyKey: null, waId: null }));
    await db.ApiMessage.create(messageRow({ idempotencyKey: null, waId: null }));
    await db.ApiMessage.create(messageRow({ source: "panel", apiKeyId: null, idempotencyKey: "same" }));
    await db.ApiMessage.create(messageRow({ source: "panel", apiKeyId: null, idempotencyKey: "same" }));
    const first = await db.ApiMessage.create(messageRow({ idempotencyKey: "k1", waId: "3EB0AAAAAAAAAAAAAAAA" }));
    await assert.rejects(db.ApiMessage.create(messageRow({ idempotencyKey: "k1" })), /unique/i);
    await db.ApiMessage.create(messageRow({ apiKeyId: 2, idempotencyKey: "k1" }));
    await assert.rejects(db.ApiMessage.create(messageRow({ waId: "3EB0AAAAAAAAAAAAAAAA" })), /unique/i);
    await assert.rejects(db.ApiMessage.create(messageRow({ publicId: first.publicId })), /unique/i);
    await clear4();
  });

  test("ApiMessageResponse: kind and via are closed sets; defaults; choiceIds is an array of strings", async () => {
    const created = await (await db.ApiMessageResponse.create(responseRow({ via: "tap" }))).reload();
    assert.deepEqual(created.choiceIds, []);
    assert.equal(created.voterKey, null);
    assert.equal(created.sourceId, null);

    for (const kind of ["choice", "vote"]) await db.ApiMessageResponse.build(responseRow({ kind })).validate();
    for (const kind of ["poll", "button", "", "Vote", null]) await refuses(db.ApiMessageResponse.build(responseRow({ kind })).validate());
    for (const via of ["tap", "number", null, undefined]) await db.ApiMessageResponse.build(responseRow({ via })).validate();
    for (const via of ["click", "TAP", ""]) await refuses(db.ApiMessageResponse.build(responseRow({ via })).validate());

    const withIds = await db.ApiMessageResponse.create(responseRow({ kind: "vote", voterKey: KEY_PN, choiceIds: ["0", "2"], sourceId: "S1" }));
    for (const row of [await db.ApiMessageResponse.findByPk(withIds.id), ...(await db.ApiMessageResponse.findAll())]) assert.ok(Array.isArray(row.choiceIds));
    assert.deepEqual((await db.ApiMessageResponse.findByPk(withIds.id)).choiceIds, ["0", "2"]);
    for (const bad of ["0", { 0: "a" }, [1], [null], [["a"]]]) await refuses(db.ApiMessageResponse.build(responseRow({ choiceIds: bad })).validate(), /choiceIds/);
    await refuses(db.ApiMessageResponse.build(responseRow({ messageId: null })).validate());
    await refuses(db.ApiMessageResponse.build(responseRow({ author: null })).validate());
    await clear4();
  });

  test("ApiMessageResponse: choice rows never collide; one vote per voter per message; one source id per message", async () => {
    await db.ApiMessageResponse.create(responseRow({ kind: "choice" }));
    await db.ApiMessageResponse.create(responseRow({ kind: "choice" }));
    await db.ApiMessageResponse.create(responseRow({ kind: "vote", voterKey: KEY_PN, sourceId: "S1" }));
    await assert.rejects(db.ApiMessageResponse.create(responseRow({ kind: "vote", voterKey: KEY_PN, sourceId: "S2" })), /unique/i);
    await assert.rejects(db.ApiMessageResponse.create(responseRow({ kind: "vote", voterKey: "237690000009@s.whatsapp.net", sourceId: "S1" })), /unique/i);
    await db.ApiMessageResponse.create(responseRow({ messageId: 2, kind: "vote", voterKey: KEY_PN, sourceId: "S1" }));
    assert.equal(await db.ApiMessageResponse.count(), 4);
    await clear4();
  });

  test("ApiState: a singleton with id 1, switched off and with an empty list by default", async () => {
    const row = await db.ApiState.create({});
    assert.deepEqual([row.id, row.enabled, row.plainHttpFrom], [1, false, []]);
    await assert.rejects(db.ApiState.create({ id: 1 }), /unique|Validation/i);
    await refuses(db.ApiState.create({ id: 2 }), /Validation/);
    await refuses(db.ApiState.build({ id: 0 }).validate());
    await refuses(db.ApiState.build({ id: "1x" }).validate());
    await refuses(db.ApiState.build({ enabled: null }).validate());
    assert.equal(await db.ApiState.count(), 1);

    const again = await db.ApiState.findByPk(1);
    again.enabled = true;
    again.plainHttpFrom = ["192.168.0.0/16", "fd00::/8"];
    await again.save();
    const stored = await db.ApiState.findOne();
    assert.deepEqual([stored.enabled, stored.plainHttpFrom], [true, ["192.168.0.0/16", "fd00::/8"]]);
    assert.ok(Array.isArray((await db.ApiState.findAll())[0].plainHttpFrom));
    await clear4();
  });

  test("ApiState.plainHttpFrom: at most 20 strings of at most 50 characters; the grammar is apiState's", async () => {
    await db.ApiState.build({ plainHttpFrom: manyOf(20, (i) => `10.0.${i}.0/24`) }).validate();
    await refuses(db.ApiState.build({ plainHttpFrom: manyOf(21, (i) => `10.0.${i}.0/24`) }).validate(), /at most 20/);
    await db.ApiState.build({ plainHttpFrom: ["x".repeat(50)] }).validate();
    await refuses(db.ApiState.build({ plainHttpFrom: ["x".repeat(51)] }).validate(), /plainHttpFrom/);
    for (const bad of ["10.0.0.0/8", {}, 5]) await refuses(db.ApiState.build({ plainHttpFrom: bad }).validate(), /plainHttpFrom must be an array/);
    await refuses(db.ApiState.build({ plainHttpFrom: [5] }).validate(), /plainHttpFrom/);
    await refuses(db.ApiState.build({ plainHttpFrom: null }).validate(), /plainHttpFrom cannot be null/);
  });

  test("AlertOutbox accepts the three API alert types and still rejects others", async () => {
    for (const type of ["api_origin_blocked", "api_key_new_ip", "api_paused"]) {
      assert.ok(type.length <= 24, `${type} fits STRING(24)`);
      await db.AlertOutbox.build({ type }).validate();
      const row = await db.AlertOutbox.create({ type });
      assert.deepEqual([row.type, row.status], [type, "pending"]);
    }
    await refuses(db.AlertOutbox.build({ type: "spam" }).validate());
    await refuses(db.AlertOutbox.build({ type: "api_unknown" }).validate());
    await db.AlertOutbox.destroy({ where: { type: ["api_origin_blocked", "api_key_new_ip", "api_paused"] } });
  });
});
