"use strict";

/**
 * Backup restore (contracts/runtime.md section 13, data-model.md 4.3, FR-052, FR-053).
 *
 *   const restorer = createRestorer(deps);
 *   await restorer.inspect({ uploadId, passphrase, adminSessionId })        -> { restoreToken, expiresAt, summary }
 *   await restorer.apply({ restoreToken, confirm: true, actor, adminSessionId, onPhase })
 *                                                                           -> { ok: true, preRestoreFile, ... }
 *   restorer.checkToken(token, adminSessionId)                              throws token_expired
 *   await restorer.recoverAtBoot()      sweep data/tmp, finish what an interrupted restore left behind
 *   restorer.listStored() / openStored(name)   the pre-restore backups (BAK-4 / BAK-5)
 *
 * Two steps, and NOTHING changes before the second.
 *
 * inspect: the uploaded file is opened in place. The key is derived from the passphrase and compared with the
 * header's check value (a wrong passphrase leaves the upload where it is, so the owner can type it again). Then the
 * whole file is decrypted to the end (the GCM tag is verified there), every record is parsed and every row is built
 * and validated against the models (STRING lengths included on Postgres), the version is compared and the secret
 * storage is dry-run. The file is then moved to `data/tmp/restore-<token>.owb` and a token is issued: 15 minutes,
 * bound to the admin session, one at a time, the derived key held in memory only and wiped on use or expiry.
 *
 * apply: maintenance mode (the pipeline drops messages, the engines skip) -> a pre-restore backup in
 * `data/backups/` (same key, last 3 kept) and `restore.lock` -> ONE transaction that empties the 25 models and
 * inserts the file's rows, streamed; the GCM tag is verified before COMMIT, so a tampered or truncated file rolls
 * everything back -> on Postgres the sequences follow the explicit ids -> after the commit only: media and the status
 * file are put in place, the session folder is swapped by rename, the caches, settings and texts are reloaded, the
 * bot restarts in process -> maintenance mode ends. A failure before the commit keeps the previous state.
 *
 * Older backups load (a model absent from the file is emptied, a missing column takes the model default, an unknown
 * column is dropped and counted); a newer bot version and an unknown container format are refused. Rows travel as
 * typed model-level JSON and are applied with `bulkCreate(..., { hooks: false })`, so the dialect of the source does
 * not matter. `Admin*` tables, the audit log, alert state and the AI conversations are never restored, whatever the
 * file says. Secrets travel in clear inside the archive and are re-encrypted with THIS installation's key.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const safeFs = require("../../utils/safeFs");
const format = require("./format");
const { createExporter } = require("./export");

const { MODELS, MODEL_SET, AUTO_INCREMENT_MODELS, BackupError } = format;

const TOKEN_TTL_MS = 15 * 60 * 1000;
const SWEEP_MS = 60 * 1000;
const KEEP_PRE_RESTORE = 3;
const STORED_NAME = /^pre-restore-[0-9A-Za-z_-]{1,40}\.owb$/;
const SECRET_CONTEXT = (key) => `setting:${key}`; // same additional authenticated data as the settings store
const MAX_MEDIA_BYTES = 1024 * 1024 * 1024;

const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const noop = () => {};
const altered = () => new BackupError("file_altered");

const sha = (text) => crypto.createHash("sha256").update(String(text)).digest();
const sameText = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

async function exists(target) {
  try {
    await fsp.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** rename, falling back to copy + delete across file systems (two Docker volumes) */
async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (!err || err.code !== "EXDEV") throw err;
    await fsp.copyFile(from, to);
    await fsp.rm(from, { force: true });
  }
  await fsp.chmod(to, 0o600).catch(() => {});
}

/** A setting a backup may carry: the same test the settings store applies to its own rows */
const isWritableSetting = (item) => Boolean(item) && item.source === "env" && !item.readonly && !item.inactive && item.effect !== "boot-only";

function createRestorer(deps = {}) {
  const exporter = deps.exporter || createExporter(deps);

  const getModels = () => deps.models || require("../../database");
  const getSettingsStore = () => deps.settingsStore || require("../../utils/settingsStore");
  const getSecretBox = () => deps.secretBox || require("../../utils/secretBox");
  const getTextOverrides = () => deps.textOverrides || require("../../utils/textOverrides");
  const getLanguage = () => deps.languageManager || require("../../utils/language").languageManager;
  const getTextError = () => require("../../utils/language").TextOverrideError;
  const getSettingsCache = () => deps.settingsCache || require("../../utils/settingsCache");
  const getStats = () => deps.stats || require("../../utils/stats");
  const getConfig = () => deps.config || require("../../../config");
  const getMaintenance = () =>
    deps.maintenanceMode && typeof deps.maintenanceMode.enter === "function" ? deps.maintenanceMode : require("../../utils/maintenanceMode");
  const logger = () => deps.logger || require("../../utils/logger").createLogger("backup");
  const now = () => (deps.clock && typeof deps.clock.now === "function" ? deps.clock.now() : Date.now());

  const dataDir = () => deps.dataDir || path.join(__dirname, "..", "..", "..", "data");
  const tmpDir = () => path.join(dataDir(), "tmp");
  const backupsDir = () => path.join(dataDir(), "backups");
  const lockFile = () => path.join(backupsDir(), "restore.lock");
  const mediaRoot = () => deps.mediaRoot || path.join(dataDir(), "broadcast-media");
  const statusSavePath = () => deps.statusSavePath || path.join(dataDir(), "status_save.json");
  const sessionDir = () => {
    if (deps.sessionDir) return deps.sessionDir;
    if (deps.client && deps.client.sessionPath) return deps.client.sessionPath;
    return path.join(deps.rootDir || path.join(__dirname, "..", "..", ".."), "sessions", "main");
  };
  const kdfOptions = () => ({ gate: deps.kdfGate, scrypt: deps.scrypt });

  /** @type {null|{ token: string, file: string, info: object, keys: object, summary: object, sessionId: string, expiresAt: number }} */
  let active = null;
  let inspecting = false;
  let applying = false;
  let interrupted = false;
  let sweeper = null;

  // ----- the token ----------------------------------------------------------------------------------------

  async function discardActive() {
    const entry = active;
    active = null;
    if (!entry) return;
    format.wipeKeys(entry.keys);
    await fsp.rm(entry.file, { force: true }).catch(() => {});
  }

  /** Drop the token once it is past its time (lazy, plus a timer once start() ran) */
  function expireActive(at) {
    if (active && at >= active.expiresAt) discardActive().catch(noop);
  }

  /** The active entry for this token and admin session, else token_expired. The token stays valid. */
  function checkToken(token, adminSessionId, at = now()) {
    expireActive(at);
    if (!active || typeof token !== "string" || !sameText(active.token, token) || !sameText(active.sessionId, String(adminSessionId))) {
      throw new BackupError("token_expired");
    }
    return active;
  }

  // ----- validating rows ----------------------------------------------------------------------------------------

  const newTally = () => ({ ignoredColumns: new Map(), ignoredModels: new Map(), ignoredSettings: 0, ignoredTexts: 0, needsEncrypt: false });

  function countIgnoredColumn(tally, model, column) {
    if (!tally.ignoredColumns.has(model)) tally.ignoredColumns.set(model, new Map());
    const columns = tally.ignoredColumns.get(model);
    columns.set(column, (columns.get(column) || 0) + 1);
  }

  const invalidRow = (model, index, field) => new BackupError("invalid_row", { model, index, field });

  /** The first STRING column over its length (Postgres enforces it, SQLite does not) */
  function overLength(Model, values) {
    for (const [name, attribute] of Object.entries(Model.rawAttributes)) {
      const type = attribute.type;
      const value = values[name];
      if (!type || (type.key !== "STRING" && type.key !== "CHAR") || !Number.isInteger(type._length) || typeof value !== "string") continue;
      if (value.length > type._length && Array.from(value).length > type._length) return name;
    }
    return null;
  }

  /** A row of an ordinary model: unknown columns dropped and counted, the rest built and validated */
  async function prepareGeneric(modelName, Model, row, index, context) {
    const values = {};
    for (const [column, value] of Object.entries(row)) {
      if (!Object.hasOwn(Model.rawAttributes, column)) {
        countIgnoredColumn(context.tally, modelName, column);
        continue;
      }
      values[column] = value;
    }
    // a broadcast whose media did not travel loses its path (the file is not there to find)
    if (modelName === "Broadcast" && values.mediaPath && !context.mediaCarried.has(values.mediaPath)) values.mediaPath = null;

    let instance;
    try {
      instance = Model.build(values, { isNewRecord: true });
      await instance.validate(); // not-null, isIn, len and the model's own rules (Broadcast: once vs recurring)
    } catch (err) {
      const first = err && Array.isArray(err.errors) && err.errors[0];
      throw invalidRow(modelName, index, (first && first.path) || "row");
    }
    // Sequelize does not check column TYPES unless typeValidation is on: do it here (boolean, integer, date, enum...)
    for (const column of Object.keys(values)) {
      const value = instance.getDataValue(column);
      const type = Model.rawAttributes[column].type;
      if (value === null || value === undefined || !type || typeof type.validate !== "function") continue;
      try {
        type.validate(value);
      } catch {
        throw invalidRow(modelName, index, column);
      }
    }
    if (context.lengthCheck) {
      const field = overLength(Model, values);
      if (field) throw invalidRow(modelName, index, field);
    }
    return values;
  }

  /** A setting row: dropped when this installation cannot take it, refused when its value is invalid */
  function prepareSetting(row, index, context) {
    const store = context.settingsStore;
    const item = typeof row.key === "string" ? store.byKey.get(row.key) : null;
    if (!isWritableSetting(item)) {
      context.tally.ignoredSettings += 1;
      return null;
    }
    const raw = row.value === undefined || row.value === null ? "" : String(row.value);
    const api = item.parse(raw);
    const problem = api === undefined ? { code: "invalid_format" } : item.validate(api);
    if (problem) throw invalidRow("SettingOverride", index, "value");
    if (item.secret && raw !== "") context.tally.needsEncrypt = true;
    return { key: row.key, value: raw, version: Number(row.version) || 0 };
  }

  /** A text row: kept when it is still valid for the running installation, else skipped and counted */
  function prepareText(row, index, context) {
    if (typeof row.key !== "string" || typeof row.lang !== "string" || typeof row.text !== "string") throw invalidRow("TextOverride", index, "text");
    let currentHash;
    try {
      currentHash = context.languageManager.validateOverride(row.lang, row.key, row.text);
    } catch (err) {
      if (!(err instanceof getTextError())) throw err;
      context.tally.ignoredTexts += 1;
      return null;
    }
    const kept = typeof row.originalHash === "string" && row.originalHash ? row.originalHash.slice(0, 16) : currentHash;
    return { key: row.key, lang: row.lang, text: row.text, originalHash: kept };
  }

  async function prepareRows(modelName, rows, firstIndex, context) {
    if (!Array.isArray(rows)) throw altered();
    const Model = context.models[modelName];
    const out = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const index = firstIndex + i;
      if (!isPlain(row)) throw invalidRow(modelName, index, "row");
      let prepared;
      if (modelName === "SettingOverride") prepared = prepareSetting(row, index, context);
      else if (modelName === "TextOverride") prepared = prepareText(row, index, context);
      else prepared = await prepareGeneric(modelName, Model, row, index, context);
      if (prepared) out.push(prepared);
    }
    return out;
  }

  // ----- walking a file (inspect and apply share it) ------------------------------------------------------------------

  function parseManifest(record, info) {
    const counts = record.counts;
    if (
      typeof record.botVersion !== "string" ||
      typeof record.createdAt !== "string" ||
      Number.isNaN(Date.parse(record.createdAt)) ||
      typeof record.dialect !== "string" ||
      typeof record.includesSession !== "boolean" ||
      !isPlain(counts) ||
      !Object.values(counts).every((n) => Number.isInteger(n) && n >= 0) ||
      !Array.isArray(record.files)
    ) {
      throw altered();
    }
    if (!Number.isInteger(record.format) || record.format < 1 || record.format > format.FORMAT) throw new BackupError("format_unsupported");
    const current = String(getConfig().VERSION || "0.0.0");
    if (format.compareVersions(record.botVersion, current) > 0) {
      throw new BackupError("newer_version", { backupVersion: record.botVersion, currentVersion: current });
    }
    const media = new Map();
    for (const item of record.files) {
      if (isPlain(item) && item.kind === "media" && format.parseMediaPath(item.name)) media.set(item.name, Number(item.size) || 0);
    }
    return {
      format: info.format,
      createdAt: new Date(record.createdAt).toISOString(),
      botVersion: record.botVersion,
      dialect: record.dialect,
      includesSession: record.includesSession,
      counts,
      media,
      hasStatus: record.files.some((item) => isPlain(item) && item.kind === "status"),
    };
  }

  /**
   * Stream a file through the validators and hand each piece to `sink`. Returns when the last record has been read,
   * that is, after the authentication tag was verified.
   * sink: { onManifest(manifest), onRows(model, rows), onFile(name, bytes), onBlob({ path, bytes, first, last }),
   *         onSession(name, bytes) }
   */
  async function walk(file, info, encKey, sink, tally) {
    const models = getModels();
    const context = {
      models,
      tally,
      lengthCheck: deps.enforceLengths === true || models.Group.sequelize.getDialect() === "postgres",
      settingsStore: getSettingsStore(),
      languageManager: getLanguage(),
      mediaCarried: new Set(),
    };
    let manifest = null;
    const seen = Object.create(null);
    const unknownSeen = new Map();
    const unknownDeclared = new Map();
    const blobs = new Map();
    let sessionFiles = 0;
    const sessionNames = new Set();

    for await (const record of format.readRecords(file, info, encKey)) {
      if (!manifest) {
        if (record.t !== "manifest") throw altered();
        manifest = parseManifest(record, info);
        context.mediaCarried = new Set(manifest.media.keys());
        for (const [model, rows] of Object.entries(manifest.counts)) {
          if (!MODEL_SET.has(model)) unknownDeclared.set(model, rows);
        }
        await sink.onManifest(manifest);
        continue;
      }

      if (record.t === "rows") {
        if (typeof record.model !== "string" || !Array.isArray(record.rows)) throw altered();
        if (!MODEL_SET.has(record.model)) {
          unknownSeen.set(record.model, (unknownSeen.get(record.model) || 0) + record.rows.length);
          continue;
        }
        if (!Object.hasOwn(manifest.counts, record.model)) throw altered();
        const prepared = await prepareRows(record.model, record.rows, seen[record.model] || 0, context);
        seen[record.model] = (seen[record.model] || 0) + record.rows.length;
        await sink.onRows(record.model, prepared);
      } else if (record.t === "file") {
        if (record.name !== "data/status_save.json" || typeof record.b64 !== "string") continue; // whitelist
        await sink.onFile(record.name, Buffer.from(record.b64, "base64"));
      } else if (record.t === "blob") {
        if (!context.mediaCarried.has(record.path) || typeof record.b64 !== "string") throw altered();
        const state = blobs.get(record.path) || { next: 0, done: false, bytes: 0 };
        if (state.done || record.seq !== state.next) throw altered();
        const bytes = Buffer.from(record.b64, "base64");
        state.bytes += bytes.length;
        if (state.bytes > MAX_MEDIA_BYTES) throw altered();
        state.next += 1;
        state.done = record.last === true;
        blobs.set(record.path, state);
        await sink.onBlob({ path: record.path, bytes, first: record.seq === 0, last: state.done });
      } else if (record.t === "session") {
        if (typeof record.name !== "string" || !format.SAFE_FILE_NAME.test(record.name) || sessionNames.has(record.name)) throw altered();
        if (typeof record.b64 !== "string") throw altered();
        sessionNames.add(record.name);
        sessionFiles += 1;
        await sink.onSession(record.name, Buffer.from(record.b64, "base64"));
      }
      // an unknown record type from a later minor version is skipped
    }
    if (!manifest) throw altered();
    for (const model of new Set([...unknownDeclared.keys(), ...unknownSeen.keys()])) {
      tally.ignoredModels.set(model, Math.max(unknownDeclared.get(model) || 0, unknownSeen.get(model) || 0));
    }
    for (const model of MODELS) {
      if ((manifest.counts[model] || 0) !== (seen[model] || 0)) throw altered();
    }
    for (const [name, state] of blobs) if (!state.done) throw altered();
    if (blobs.size !== manifest.media.size) throw altered();
    return { manifest, seen, sessionFiles, blobFiles: blobs.size };
  }

  function summaryOf(manifest, tally) {
    const counts = {};
    for (const model of MODELS) if (Object.hasOwn(manifest.counts, model)) counts[model] = manifest.counts[model];
    return {
      format: manifest.format,
      createdAt: manifest.createdAt,
      botVersion: manifest.botVersion,
      dialect: manifest.dialect,
      includesSession: manifest.includesSession,
      counts,
      ignoredModels: [...tally.ignoredModels].map(([model, rows]) => ({ model, rows })),
      ignoredColumns: [...tally.ignoredColumns].flatMap(([model, columns]) => [...columns].map(([column, rows]) => ({ model, column, rows }))),
      ignoredSettings: tally.ignoredSettings,
      ignoredTexts: tally.ignoredTexts,
    };
  }

  /** Prove a secret can be encrypted here, without creating data/panel.key when it is missing */
  async function dryRunSecrets() {
    const box = getSecretBox();
    try {
      const status = typeof box.status === "function" ? box.status() : { keyPresent: false, keyValid: false };
      if (status.keyPresent && status.keyValid) {
        box.encrypt("dry-run", "backup:dry-run");
        return;
      }
      await fsp.mkdir(tmpDir(), { recursive: true, mode: 0o700 });
      const scratch = await fsp.mkdtemp(path.join(tmpDir(), "restore-keycheck-"));
      try {
        require("../../utils/secretBox").createSecretBox({ dir: scratch }).encrypt("dry-run", "backup:dry-run");
      } finally {
        await fsp.rm(scratch, { recursive: true, force: true }).catch(noop);
      }
    } catch {
      throw new BackupError("secret_storage_unavailable");
    }
  }

  // ----- step 1: inspect ------------------------------------------------------------------------------------------

  async function inspect({ uploadId, passphrase, adminSessionId }) {
    const uploads = deps.uploads;
    const at = now();
    if (inspecting || applying) throw new BackupError("busy");
    const upload = uploads.peek(uploadId, adminSessionId, { purpose: "backup" });
    if (!upload) throw new BackupError("upload_not_found");

    inspecting = true;
    // a file that cannot be restored is of no further use; a wrong passphrase leaves it for another try
    const drop = () => uploads.consume(uploadId, adminSessionId, { purpose: "backup" }, async () => {}).catch(noop);
    try {
      let info;
      try {
        info = await format.readHeader(upload.path);
      } catch (err) {
        await drop();
        throw err;
      }
      const keys = await format.unlock(info, passphrase, kdfOptions()); // bad_passphrase, rate_limited: the upload stays

      const tally = newTally();
      let result;
      try {
        result = await walk(upload.path, info, keys.encKey, { onManifest: noop, onRows: noop, onFile: noop, onBlob: noop, onSession: noop }, tally);
        if (tally.needsEncrypt) await dryRunSecrets();
      } catch (err) {
        format.wipeKeys(keys);
        if (!(err instanceof BackupError) || err.code !== "secret_storage_unavailable") await drop();
        throw err;
      }

      const token = crypto.randomBytes(24).toString("base64url");
      const target = path.join(tmpDir(), `restore-${token}.owb`);
      try {
        await fsp.mkdir(tmpDir(), { recursive: true, mode: 0o700 });
        const consumed = await uploads.consume(uploadId, adminSessionId, { purpose: "backup" }, async (record) => {
          await moveFile(record.path, target);
        });
        if (!consumed) throw new BackupError("upload_not_found");
      } catch (err) {
        format.wipeKeys(keys);
        throw err;
      }
      await discardActive();
      const summary = summaryOf(result.manifest, tally);
      active = { token, file: target, info, keys, summary, sessionId: String(adminSessionId), expiresAt: at + TOKEN_TTL_MS };
      return { restoreToken: token, expiresAt: new Date(active.expiresAt).toISOString(), summary };
    } finally {
      inspecting = false;
    }
  }

  // ----- step 2: apply ------------------------------------------------------------------------------------------

  async function writeLock(lock) {
    const file = lockFile();
    const temp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(temp, JSON.stringify({ v: 1, ...lock }), { mode: 0o600 });
    await fsp.rename(temp, file);
  }

  /** The pre-restore backups with their age: [{ name, mtimeMs, size }], oldest first */
  async function storedFiles() {
    let names;
    try {
      names = (await fsp.readdir(backupsDir())).filter((name) => STORED_NAME.test(name));
    } catch {
      return [];
    }
    const files = [];
    for (const name of names) {
      try {
        const stat = await fsp.lstat(path.join(backupsDir(), name));
        if (stat.isFile()) files.push({ name, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        // removed meanwhile
      }
    }
    return files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Keep the newest `keep` pre-restore backups */
  async function pruneStored(keep = KEEP_PRE_RESTORE) {
    const files = await storedFiles();
    const doomed = files.slice(0, Math.max(0, files.length - keep));
    for (const file of doomed) await fsp.rm(path.join(backupsDir(), file.name), { force: true }).catch(noop);
    return doomed.length;
  }

  async function resetSequences(sequelize, models, transaction) {
    const qi = sequelize.getQueryInterface();
    for (const name of AUTO_INCREMENT_MODELS) {
      const Model = models[name];
      const table = qi.quoteIdentifier(Model.tableName);
      const key = Model.primaryKeyAttributes[0];
      const column = qi.quoteIdentifier(key);
      await sequelize.query(
        `SELECT setval(pg_get_serial_sequence('${table}', '${key}'), COALESCE((SELECT MAX(${column}) FROM ${table}), 1), (SELECT MAX(${column}) IS NOT NULL FROM ${table}))`,
        { transaction },
      );
    }
  }

  /** Normalise the status file: only the two known fields survive. null when it is not usable. */
  function cleanStatusFile(bytes) {
    try {
      const data = JSON.parse(bytes.toString("utf8"));
      if (!isPlain(data)) return null;
      const list = Array.isArray(data.list) ? data.list.filter((item) => typeof item === "string" && /^\d{5,20}$/.test(item)).slice(0, 1000) : [];
      return JSON.stringify({ enabled: data.enabled === true, list }, null, 2);
    } catch {
      return null;
    }
  }

  async function apply({ restoreToken, confirm, actor, adminSessionId, onPhase = noop }) {
    if (confirm !== true) throw new BackupError("confirmation_required", { confirm: "restore" });
    if (applying || inspecting) throw new BackupError("busy");
    const entry = checkToken(restoreToken, adminSessionId);
    active = null; // used: the key lives in `entry` from here on
    applying = true;

    const at = now();
    const stamp = format.stampOf(at, { millis: true });
    const models = getModels();
    const sequelize = models.Group.sequelize;
    const maintenance = getMaintenance();
    const log = logger();
    const stage = {
      root: path.join(tmpDir(), `restore-stage-${stamp}`),
      statusFile: null,
      mediaIds: new Set(),
      sessionDir: path.join(path.dirname(sessionDir()), `.restore-${stamp}`),
      sessionFiles: 0,
    };
    const warnings = [];
    let phase = "maintenance";
    let entered = false;
    let committed = false;
    let preFile = null;
    let replacedDir = null;
    let result = null;

    const setPhase = (name) => {
      phase = name;
      try {
        onPhase(name);
      } catch {
        // a progress listener never breaks a restore
      }
    };

    try {
      setPhase("maintenance");
      try {
        await getStats().flush({ now: at }); // before the flag: a flush is skipped while maintenance mode is on
      } catch {
        // the last seconds of statistics are not worth blocking a restore
      }
      await maintenance.enter("restore");
      entered = true;
      await fsp.mkdir(backupsDir(), { recursive: true, mode: 0o700 });
      await writeLock({ startedAt: new Date(at).toISOString(), phase: "maintenance", session: null });

      // ---- a backup of what is about to be replaced, under the same key (one passphrase opens both files)
      setPhase("pre_backup");
      preFile = path.join(backupsDir(), `pre-restore-${stamp}.owb`);
      for (let n = 1; (await exists(preFile)) && n < 100; n += 1) preFile = path.join(backupsDir(), `pre-restore-${stamp}-${n}.owb`);
      await exporter.exportToFile({ file: preFile, keys: entry.keys, includeSession: entry.summary.includesSession, now: at });
      await pruneStored();

      // ---- the single transaction
      setPhase("database");
      await writeLock({ startedAt: new Date(at).toISOString(), phase: "database", session: null });
      const settingsStore = getSettingsStore();
      const box = getSecretBox();
      const tally = newTally();

      const sink = {
        async onManifest() {
          for (const name of MODELS) await models[name].destroy({ where: {}, transaction: stage.transaction });
        },
        async onRows(modelName, rows) {
          if (!rows.length) return;
          let toInsert = rows;
          if (modelName === "SettingOverride") {
            toInsert = rows.map((row) => {
              const item = settingsStore.byKey.get(row.key);
              let stored = row.value;
              if (item.secret && row.value !== "") {
                try {
                  stored = box.encrypt(row.value, SECRET_CONTEXT(row.key));
                } catch (err) {
                  throw new BackupError("secret_storage_unavailable", undefined, { cause: err });
                }
              }
              const known = Math.max(typeof settingsStore.version === "function" ? settingsStore.version(row.key) || 0 : 0, row.version);
              return { key: row.key, value: stored, version: known + 1 };
            });
          }
          await models[modelName].bulkCreate(toInsert, { transaction: stage.transaction, hooks: false, validate: false });
        },
        async onFile(_name, bytes) {
          const clean = cleanStatusFile(bytes);
          if (clean === null) return;
          await fsp.mkdir(stage.root, { recursive: true, mode: 0o700 });
          stage.statusFile = path.join(stage.root, "status_save.json");
          await fsp.writeFile(stage.statusFile, clean, { mode: 0o600 });
        },
        async onBlob({ path: mediaPath, bytes, first }) {
          const parsed = format.parseMediaPath(mediaPath);
          const dir = path.join(stage.root, "media", parsed.id);
          const file = path.join(dir, parsed.name);
          if (first) {
            await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
            stage.mediaIds.add(parsed.id);
          }
          await fsp.appendFile(file, bytes, { mode: 0o600 });
        },
        async onSession(name, bytes) {
          await fsp.mkdir(stage.sessionDir, { recursive: true, mode: 0o700 });
          await fsp.writeFile(path.join(stage.sessionDir, name), bytes, { flag: "wx", mode: 0o600 });
          stage.sessionFiles += 1;
        },
      };

      await sequelize.transaction(async (transaction) => {
        stage.transaction = transaction;
        // the iteration ends only after the GCM tag was verified: a bad file throws before COMMIT
        result = await walk(entry.file, entry.info, entry.keys.encKey, sink, tally);
        if (sequelize.getDialect() === "postgres") await resetSequences(sequelize, models, transaction);
      });
      committed = true;
      await writeLock({ startedAt: new Date(at).toISOString(), phase: "committed", session: null });

      // ---- from here the data is replaced: problems are reported, not rolled back
      setPhase("session");
      if (stage.sessionFiles > 0) {
        try {
          replacedDir = await swapSession(stage, stamp, at);
        } catch (err) {
          log.error({ name: err && err.name, code: err && err.code }, "restore: the session folder could not be swapped");
          warnings.push("session_not_swapped");
        }
      }

      setPhase("finalize");
      await promoteFiles(stage, warnings);
      try {
        getSettingsCache().clear(); // command states, groups, roles... all read the new rows
        await settingsStore.reload();
        await getTextOverrides().load({ models });
      } catch (err) {
        log.error({ name: err && err.name, code: err && err.code }, "restore: reloading the settings and texts failed");
        warnings.push("reload_failed");
      }

      setPhase("restarting");
      let restarted = false;
      const runtime = deps.runtime;
      if (runtime && typeof runtime.restartBot === "function") {
        try {
          const outcome = await runtime.restartBot({ actor });
          restarted = Boolean(outcome && outcome.ok);
          if (!restarted) warnings.push(`restart_${(outcome && outcome.code) || "failed"}`);
        } catch (err) {
          log.error({ name: err && err.name, code: err && err.code }, "restore: the in-process restart failed");
          warnings.push("restart_failed");
        }
      }

      if (replacedDir) await fsp.rm(replacedDir, { recursive: true, force: true }).catch(noop);
      return {
        ok: true,
        preRestoreFile: path.basename(preFile),
        counts: entry.summary.counts,
        includesSession: entry.summary.includesSession,
        sessionSwapped: Boolean(replacedDir),
        restarted,
        warnings,
      };
    } catch (err) {
      const reason = err && typeof err.code === "string" ? err.code : "error";
      log.error({ phase, reason, committed }, "restore failed");
      throw new BackupError("apply_failed", { phase, reason }, { cause: err });
    } finally {
      format.wipeKeys(entry.keys);
      await fsp.rm(stage.root, { recursive: true, force: true }).catch(noop);
      await fsp.rm(stage.sessionDir, { recursive: true, force: true }).catch(noop); // gone already after a swap
      await fsp.rm(entry.file, { force: true }).catch(noop);
      await fsp.rm(lockFile(), { force: true }).catch(noop);
      if (entered) maintenance.leave();
      applying = false;
    }
  }

  /** Session folder: old one aside, staged one in place; the old one comes back if the second rename fails */
  async function swapSession(stage, stamp, at) {
    const dir = sessionDir();
    const parent = path.dirname(dir);
    const client = deps.client;
    if (client && typeof client.stop === "function") {
      try {
        await client.stop(); // nothing may write credentials into the folder while it changes
      } catch {
        // already stopped
      }
    }
    await fsp.mkdir(parent, { recursive: true });
    let replaced = null;
    if (await exists(dir)) {
      replaced = path.join(backupsDir(), `sessions-${stamp}`);
      await writeLock({ startedAt: new Date(at).toISOString(), phase: "session", session: { dir, staged: stage.sessionDir, replaced } });
      try {
        await fsp.rename(dir, replaced);
      } catch (err) {
        if (!err || err.code !== "EXDEV") throw err;
        replaced = path.join(parent, `.replaced-${stamp}`); // two volumes: keep it next to the session folder
        await writeLock({ startedAt: new Date(at).toISOString(), phase: "session", session: { dir, staged: stage.sessionDir, replaced } });
        await fsp.rename(dir, replaced);
      }
    } else {
      await writeLock({ startedAt: new Date(at).toISOString(), phase: "session", session: { dir, staged: stage.sessionDir, replaced: null } });
    }
    try {
      await fsp.rename(stage.sessionDir, dir);
    } catch (err) {
      if (replaced) await fsp.rename(replaced, dir).catch(noop);
      throw err;
    }
    return replaced || "";
  }

  /** Media and the status file, after the commit */
  async function promoteFiles(stage, warnings) {
    for (const id of stage.mediaIds) {
      try {
        const root = mediaRoot();
        await fsp.mkdir(root, { recursive: true, mode: 0o700 });
        const target = await safeFs.assertInside(root, path.join(root, id));
        await fsp.rm(target, { recursive: true, force: true });
        try {
          await fsp.rename(path.join(stage.root, "media", id), target);
        } catch (err) {
          if (!err || err.code !== "EXDEV") throw err;
          await fsp.cp(path.join(stage.root, "media", id), target, { recursive: true });
        }
      } catch {
        warnings.push("media_not_restored");
      }
    }
    if (stage.statusFile) {
      try {
        await fsp.mkdir(path.dirname(statusSavePath()), { recursive: true });
        await moveFile(stage.statusFile, statusSavePath());
      } catch {
        warnings.push("status_not_restored");
      }
    }
  }

  // ----- boot ---------------------------------------------------------------------------------------------------

  /**
   * Run once at start-up. Sweeps what an export or an upload left in `data/tmp/`; if `restore.lock` remains, a
   * restore was interrupted: log it, put a half-swapped session folder back, drop the staged one, raise the flag
   * the `restore_interrupted` banner reads.
   * @returns {Promise<{ interrupted: boolean, swept: number, sessionRestored: boolean }>}
   */
  async function recoverAtBoot() {
    const out = { interrupted: false, swept: 0, sessionRestored: false };
    const log = logger();
    try {
      for (const name of await fsp.readdir(tmpDir())) {
        if (!/^(restore-|export-)/.test(name)) continue;
        await fsp.rm(path.join(tmpDir(), name), { recursive: true, force: true }).catch(noop);
        out.swept += 1;
      }
    } catch {
      // no data/tmp yet
    }

    let lock = null;
    try {
      lock = JSON.parse(await fsp.readFile(lockFile(), "utf8"));
    } catch (err) {
      if (err && err.code === "ENOENT") return out;
      lock = {}; // unreadable marker: still a restore that did not finish
    }

    out.interrupted = true;
    interrupted = true;
    const phase = isPlain(lock) && typeof lock.phase === "string" ? lock.phase : "unknown";
    log.warn({ phase }, "restore interrupted, previous state kept");
    if (phase === "committed" || phase === "session") {
      log.warn({ phase }, "the interrupted restore had already replaced the database: the restored data is in place");
    }

    const session = isPlain(lock) && isPlain(lock.session) ? lock.session : null;
    if (session && session.dir === sessionDir()) {
      const parent = path.dirname(sessionDir());
      const allowedReplaced = (candidate) =>
        typeof candidate === "string" &&
        ((path.dirname(candidate) === backupsDir() && path.basename(candidate).startsWith("sessions-")) ||
          (path.dirname(candidate) === parent && path.basename(candidate).startsWith(".replaced-")));
      if (allowedReplaced(session.replaced) && !(await exists(session.dir)) && (await exists(session.replaced))) {
        try {
          await fsp.rename(session.replaced, session.dir);
          out.sessionRestored = true;
        } catch (err) {
          log.error({ code: err && err.code }, "restore recovery: the session folder could not be put back");
        }
      }
      if (typeof session.staged === "string" && path.dirname(session.staged) === parent && path.basename(session.staged).startsWith(".restore-")) {
        await fsp.rm(session.staged, { recursive: true, force: true }).catch(noop);
      }
    }
    await fsp.rm(lockFile(), { force: true }).catch(noop);
    return out;
  }

  // ----- stored pre-restore backups (BAK-4 / BAK-5) ------------------------------------------------------------

  async function listStored() {
    return (await storedFiles())
      .reverse()
      .map((file) => ({ name: file.name, kind: "pre-restore", size: file.size, createdAt: new Date(file.mtimeMs).toISOString() }));
  }

  /** @returns {Promise<{ stream, size, name }|null>} null for an unknown name */
  async function openStored(name) {
    if (typeof name !== "string" || !STORED_NAME.test(name)) return null;
    try {
      const real = await safeFs.assertInside(backupsDir(), path.join(backupsDir(), name));
      const stat = await fsp.stat(real);
      if (!stat.isFile()) return null;
      return { stream: fs.createReadStream(real), size: stat.size, name };
    } catch {
      return null;
    }
  }

  // ----- lifecycle ------------------------------------------------------------------------------------------------

  function start() {
    if (sweeper) return;
    const timers = deps.timers || { setInterval, clearInterval };
    sweeper = timers.setInterval(() => expireActive(now()), SWEEP_MS);
    if (sweeper && typeof sweeper.unref === "function") sweeper.unref();
  }

  async function stop() {
    if (sweeper) {
      (deps.timers || { clearInterval }).clearInterval(sweeper);
      sweeper = null;
    }
    await discardActive();
  }

  return {
    inspect,
    apply,
    checkToken,
    recoverAtBoot,
    listStored,
    openStored,
    start,
    stop,
    isBusy: () => inspecting || applying,
    isInterrupted: () => interrupted,
    hasToken: () => Boolean(active),
    TOKEN_TTL_MS,
  };
}

module.exports = { createRestorer, TOKEN_TTL_MS, STORED_NAME, KEEP_PRE_RESTORE };
