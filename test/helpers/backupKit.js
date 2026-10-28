"use strict";
/**
 * Fixtures of the backup tests (T167, T168): a second in-memory database to restore into, a row for every one of the
 * 25 exported models, the canonical JSON of a table, a writer of hand-made archives and a stand-in for the uploads
 * registry.
 *
 *   const target = await makeDb();                        a fresh Sequelize instance with every model, tables created
 *   const rows = await seedAll(db, at);                   one or more rows in each of the 25 models (+ the 7 excluded)
 *   await canonical(db, "Group")                         the table as sorted, key-ordered JSON lines
 *   await buildArchive({ file, passphrase, records })     an .owb written with the real container code (low KDF cost)
 *   const up = fakeUploads(dir); const id = up.add(buf)   peek / consume like lib/admin/http/uploads.js
 *
 * Nothing here touches the real database, data/ or sessions/.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { Sequelize } = require("sequelize");
const format = require("../../lib/admin/backup/format");

const MODELS_DIR = path.join(__dirname, "..", "..", "lib", "database", "models");
const LOW_KDF = Object.freeze({ N: 16, r: 1, p: 1 });

async function makeDb() {
  const sequelize = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false });
  const models = { DATABASE: sequelize };
  for (const file of fs.readdirSync(MODELS_DIR).filter((name) => name.endsWith(".js"))) {
    models[path.basename(file, ".js")] = require(path.join(MODELS_DIR, file))(sequelize);
  }
  await sequelize.sync();
  return models;
}

const plain = (row) => row.get({ plain: true });

const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
};

/** The rows of a model as canonical JSON lines, ordered by primary key; `omit` drops columns (timestamps) */
async function canonical(db, name, { omit = [] } = {}) {
  const Model = db[name];
  const keys = Model.primaryKeyAttributes;
  const rows = (await Model.findAll({ order: keys.map((key) => [key, "ASC"]) })).map(plain);
  return rows.map((row) => {
    for (const column of omit) delete row[column];
    return JSON.stringify(sortKeys(row));
  });
}

const TIMES = {
  created: new Date("2026-03-01T08:00:00.000Z"),
  updated: new Date("2026-03-02T09:30:00.000Z"),
  later: new Date("2026-03-05T18:45:10.000Z"),
};
const stamps = { createdAt: TIMES.created, updatedAt: TIMES.updated };

/**
 * One or more rows in each model, explicit timestamps so two databases can be compared byte for byte.
 * SettingOverride and TextOverride are written by the settings store and the texts engine, not here.
 */
async function seedAll(db) {
  const G1 = "120363000000000001@g.us";
  const G2 = "120363000000000002@g.us";
  const U1 = "237600000001@s.whatsapp.net";
  const U2 = "237600000002@s.whatsapp.net";

  await db.Group.bulkCreate([
    { jid: G1, name: "Équipe 🚀", antilink: true, antibot: true, welcome: true, welcomeMsg: "Bienvenue @user", mute: false, ...stamps },
    { jid: G2, name: "Second", truthDareEnabled: true, truthDareMode: "spicy", ...stamps },
  ]);
  await db.GroupEconomy.bulkCreate([
    { groupJid: G1, userJid: U1, balance: 120, lastDailyAt: TIMES.later, streak: 3, ...stamps },
    { groupJid: G1, userJid: U2, balance: 0, lastDailyAt: null, streak: 0, ...stamps },
  ]);
  await db.GroupRole.bulkCreate([
    { groupJid: G1, userJid: U1, role: "vip", setBy: U2, setAt: TIMES.later, ...stamps },
    { groupJid: G1, userJid: U2, role: "muted", setBy: null, setAt: TIMES.created, ...stamps },
  ]);
  await db.Filter.bulkCreate([
    { id: 4, pattern: "bonjour", response: "Salut !\nÇa va ?", groupJid: G1, isGlobal: false, ...stamps },
    { id: 9, pattern: "help", response: "Tapez .menu", groupJid: null, isGlobal: true, ...stamps },
  ]);
  await db.Warn.bulkCreate([{ id: 2, jid: U1, groupJid: G1, reason: "spam", count: 2, ...stamps }]);
  await db.BannedChat.bulkCreate([{ jid: "120363000000000009@g.us", bannedBy: U1, ...stamps }]);

  await db.AntiDelete.bulkCreate([{ id: 1, antiDelMode: "p", antiDelJid: null, enabled: true, ...stamps }]);
  await db.ViewOnce.bulkCreate([{ id: 1, vvMode: "jid", vvJid: U2, enabled: true, ...stamps }]);
  await db.AutoResponder.bulkCreate([{ id: 1, ignoreNumbers: "111,222", personality: "Sois bref.", enabled: false, ...stamps }]);
  await db.User.bulkCreate([
    { jid: U1, name: "Awa", isBlocked: false, lastSeen: TIMES.later, afkReason: "sieste", afkTime: TIMES.created, ...stamps },
    { jid: U2, name: "", isBlocked: true, lastSeen: TIMES.created, afkReason: null, afkTime: null, ...stamps },
  ]);
  await db.UserStats.bulkCreate([
    { jid: U1, groupJid: G1, messageCount: 50, commandCount: 7, mediaCount: 2, xp: 900, level: 4, lastActiveAt: TIMES.later, ...stamps },
    { jid: U2, groupJid: G1, messageCount: 1, commandCount: 0, mediaCount: 0, xp: 5, level: 0, lastActiveAt: TIMES.created, ...stamps },
  ]);
  await db.NotifyKeyword.bulkCreate([{ id: 3, userJid: U1, keyword: "promo", scopeJid: G1, enabled: true, ...stamps }]);
  await db.StickerCommand.bulkCreate([{ id: 5, stickerHash: "ab12cd34", command: "ping", createdBy: U1, ...stamps }]);
  await db.Idea.bulkCreate([{ id: 6, groupJid: G1, authorJid: U1, text: "Une idée", category: "fun", voters: [U1, U2], ...stamps }]);
  await db.Quote.bulkCreate([{ id: 7, groupJid: G1, authorJid: U2, authorName: "Bob", text: "« Salut »", savedBy: U1, ...stamps }]);
  await db.Task.bulkCreate([{ id: 8, chatJid: G1, text: "Acheter du pain", done: true, createdBy: U1, doneBy: U2, ...stamps }]);
  await db.Reminder.bulkCreate([
    { id: 11, chatJid: G1, creatorJid: U1, text: "Réunion", dueAt: TIMES.later, status: "pending", attempts: 0, lastError: null, sentAt: null, ...stamps },
    { id: 12, chatJid: G2, creatorJid: U2, text: "Déjà fait", dueAt: TIMES.created, status: "sent", attempts: 1, lastError: null, sentAt: TIMES.updated, ...stamps },
  ]);

  await db.CommandState.bulkCreate([
    { command: "ping", scope: "*", ...stamps },
    { command: "kick", scope: G1, ...stamps },
  ]);
  await db.DailyStat.bulkCreate([
    { day: "2026-03-01", metric: "messages", subject: "", count: 42 },
    { day: "2026-03-01", metric: "cmd_ok", subject: "ping", count: 5 },
  ]);
  await db.KnownChat.bulkCreate([
    { jid: U1, kind: "private", pnJid: U1, name: "Awa", firstSeenAt: TIMES.created, lastSeenAt: TIMES.later, leftAt: null, ...stamps },
    { jid: G1, kind: "group", pnJid: null, name: "Équipe 🚀", firstSeenAt: TIMES.created, lastSeenAt: TIMES.later, leftAt: TIMES.updated, ...stamps },
  ]);

  await db.Broadcast.bulkCreate([
    { id: 21, kind: "once", title: "Annonce", text: "Bonjour à tous", targets: [G1, U1], spacingMs: 5000, status: "active", runAt: TIMES.later, ...stamps },
    {
      id: 22,
      kind: "recurring",
      title: null,
      text: "Chaque jour",
      targets: [G1],
      spacingMs: 2500,
      status: "paused",
      recurKind: "daily",
      recurTime: "08:30",
      nextRunAt: TIMES.later,
      lastRunAt: TIMES.created,
      ...stamps,
    },
  ]);
  await db.BroadcastRun.bulkCreate([
    { id: 31, broadcastId: 21, dueAt: TIMES.later, status: "scheduled", total: 2, targetsReady: true, startedAt: null, finishedAt: null, note: null, ...stamps },
    { id: 32, broadcastId: 22, dueAt: TIMES.created, status: "completed", total: 1, targetsReady: true, startedAt: TIMES.created, finishedAt: TIMES.updated, note: "ok", ...stamps },
  ]);
  await db.BroadcastTarget.bulkCreate([
    { id: 41, runId: 31, chatJid: G1, position: 0, status: "pending", attempts: 0, ...stamps },
    { id: 42, runId: 32, chatJid: G1, position: 0, status: "sent", attempts: 1, sentAt: TIMES.updated, messageId: "ABC123", errorCode: null, ...stamps },
  ]);
}

/** One row in each table that a backup must never carry */
async function seedExcluded(db) {
  await db.AdminAccount.create({ id: 1, passwordHash: "scrypt$16$1$1$AAAA$BBBB", uiLang: "fr", theme: "auto" });
  await db.AdminSession.create({ idHash: "a".repeat(64), csrfSecret: "c".repeat(64), origin: "127.0.0.1", lastSeenAt: new Date() });
  await db.AdminToken.create({ kind: "setup", tokenHash: "b".repeat(64), expiresAt: new Date(Date.now() + 60000) });
  await db.AuditLog.create({ action: "login.success", origin: "127.0.0.1", result: "ok" });
  await db.AlertState.create({ key: "errors_series", count: 1 });
  await db.AlertOutbox.create({ type: "reconnected", status: "pending" });
  await db.Conversation.create({ jid: "237600000001@s.whatsapp.net", messages: "[]" });
}

/**
 * Write a hand-made archive with the real container code. `records` are plain objects; strings are written as is
 * (to craft a damaged line). Returns the keys, so a test can open the file again.
 */
async function buildArchive({ file, passphrase, records, kdf = LOW_KDF, headerEdit }) {
  const keys = await format.newKeys(passphrase, { kdf });
  const lines = records.map((record) => (typeof record === "string" ? record : JSON.stringify(record)) + "\n");
  const seal = format.createSealStream(keys);
  await pipeline(Readable.from(lines, { objectMode: false }), zlib.createGzip(), seal, fs.createWriteStream(file, { mode: 0o600 }));
  if (headerEdit) headerEdit(file);
  return keys;
}

/** A manifest record for a hand-made archive */
function manifest(over = {}) {
  return {
    t: "manifest",
    format: 1,
    botVersion: "1.0.0",
    createdAt: "2026-03-01T08:00:00.000Z",
    dialect: "sqlite",
    includesSession: false,
    counts: {},
    files: [],
    sessionFiles: 0,
    ...over,
  };
}

/** Every record of a file, read with the passphrase (for assertions on what an export contains) */
async function readAll(file, passphrase) {
  const info = await format.readHeader(file);
  const keys = await format.unlock(info, passphrase, { gate: format.createKdfGate() });
  const out = [];
  for await (const record of format.readRecords(file, info, keys.encKey)) out.push(record);
  return out;
}

/** The part of lib/admin/http/uploads.js the restore engine uses: peek / consume over files in a directory */
function fakeUploads(dir) {
  const records = new Map();
  let seq = 0;
  fs.mkdirSync(dir, { recursive: true });
  return {
    records,
    add(buffer, sessionId = "s1") {
      const id = String(++seq).padStart(32, "0");
      const file = path.join(dir, `${id}.dat`);
      fs.writeFileSync(file, buffer);
      records.set(id, { id, sessionId, purpose: "backup", path: file, size: buffer.length });
      return id;
    },
    addFile(source, sessionId = "s1") {
      return this.add(fs.readFileSync(source), sessionId);
    },
    peek(id, sessionId, { purpose } = {}) {
      const record = records.get(String(id));
      if (!record || record.sessionId !== String(sessionId) || (purpose && record.purpose !== purpose)) return null;
      return { ...record };
    },
    async consume(id, sessionId, opts, fn) {
      const record = this.peek(id, sessionId, opts);
      if (!record) return null;
      records.delete(String(id));
      try {
        if (typeof fn === "function") await fn(record);
      } finally {
        fs.rmSync(record.path, { force: true });
      }
      return record;
    },
  };
}

function tempDir(label = "owb-backup-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), label));
}

/** A logger that keeps every call, so a test can look for what must never be there */
function recordingLogger() {
  const lines = [];
  const log = (level) => (...args) => lines.push({ level, text: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") });
  return { lines, debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

module.exports = {
  makeDb,
  seedAll,
  seedExcluded,
  canonical,
  buildArchive,
  manifest,
  readAll,
  fakeUploads,
  tempDir,
  recordingLogger,
  LOW_KDF,
  TIMES,
  plain,
};
