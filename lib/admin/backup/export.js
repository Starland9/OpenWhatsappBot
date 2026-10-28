"use strict";

/**
 * Backup export (contracts/runtime.md section 13, data-model.md 4.3).
 *
 *   const exporter = createExporter(deps);
 *   const out = await exporter.exportStream({ passphrase, includeSession, now });
 *        -> { stream, filename, counts, size, includesSession, dispose }
 *   await exporter.exportToFile({ file, passphrase | keys, includeSession, now })
 *        -> { file, size, counts, includesSession }
 *
 * What goes in (25 models, never AdminAccount, AdminSession, AdminToken, AuditLog, AlertState, AlertOutbox nor the AI
 * Conversation table): every table read in ONE read transaction through model instances (`row.get({ plain: true })`,
 * never `raw: true`, whose SQLite types differ from Postgres), batches of 500 ordered by primary key; the settings
 * overrides from the settings store with the secrets in clear (the archive is encrypted by the passphrase); the text
 * overrides from the texts engine; `data/status_save.json`; the media of the broadcasts that can still send (recurring,
 * or one-shot with an open run); and, only on request, the files of the WhatsApp session folder read as bytes.
 *
 * The file is written to disk first (mode 0600) and only then streamed to the client: the read transaction lasts as
 * long as the database read takes and not as long as a slow download, so the bot's own writes never wait on a
 * browser. Memory stays flat: one batch, one 1 MiB chunk or one session file at a time.
 *
 * The passphrase and the key never reach a log line; errors are BackupError codes.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { Op } = require("sequelize");
const safeFs = require("../../utils/safeFs");
const format = require("./format");

const { MODELS, ROWS_BATCH, BLOB_CHUNK, BackupError } = format;

/** Broadcast runs that can still send: the media of their broadcast is worth carrying (U15). */
const OPEN_RUN_STATUSES = ["scheduled", "running"];
const TMP_PREFIX = "export-";

const line = (record) => Buffer.from(`${JSON.stringify(record)}\n`, "utf8");

/** WHERE for "after this row" on an ordered primary key (composite keys included). */
function afterWhere(keys, last) {
  if (!last) return undefined;
  const branches = keys.map((key, index) => {
    const clause = {};
    for (let i = 0; i < index; i += 1) clause[keys[i]] = last[keys[i]];
    clause[key] = { [Op.gt]: last[key] };
    return clause;
  });
  return { [Op.or]: branches };
}

function createExporter(deps = {}) {
  const getModels = () => deps.models || require("../../database");
  const getSettingsStore = () => deps.settingsStore || require("../../utils/settingsStore");
  const getTextOverrides = () => deps.textOverrides || require("../../utils/textOverrides");
  const getStats = () => deps.stats || require("../../utils/stats");
  const getConfig = () => deps.config || require("../../../config");
  const now = () => (deps.clock && typeof deps.clock.now === "function" ? deps.clock.now() : Date.now());
  const logger = () => deps.logger || require("../../utils/logger").createLogger("backup");

  const dataDir = () => deps.dataDir || path.join(__dirname, "..", "..", "..", "data");
  const tmpDir = () => path.join(dataDir(), "tmp");
  const mediaRoot = () => deps.mediaRoot || path.join(dataDir(), "broadcast-media");
  const statusSavePath = () => deps.statusSavePath || path.join(dataDir(), "status_save.json");
  const sessionDir = () => {
    if (deps.sessionDir) return deps.sessionDir;
    if (deps.client && deps.client.sessionPath) return deps.client.sessionPath;
    return path.join(deps.rootDir || path.join(__dirname, "..", "..", ".."), "sessions", "main");
  };

  // ----- the pieces of the archive ----------------------------------------------------------------------

  /** Batches of plain rows of one model, ordered by primary key (keyset pagination inside the transaction). */
  async function* rowBatches(Model, transaction) {
    const keys = Model.primaryKeyAttributes;
    const order = keys.map((key) => [key, "ASC"]);
    let last = null;
    for (;;) {
      const rows = await Model.findAll({ where: afterWhere(keys, last), order, limit: ROWS_BATCH, transaction });
      if (!rows.length) return;
      const plain = rows.map((row) => row.get({ plain: true }));
      yield plain;
      if (rows.length < ROWS_BATCH) return;
      last = plain[plain.length - 1];
    }
  }

  /** The media files of the broadcasts that can still send: [{ path, file, size }] */
  async function listMedia(models, transaction) {
    const { Broadcast, BroadcastRun } = models;
    if (!Broadcast || !BroadcastRun) return [];
    const rows = await Broadcast.findAll({
      where: { mediaPath: { [Op.ne]: null } },
      attributes: ["id", "kind", "mediaPath"],
      order: [["id", "ASC"]],
      transaction,
    });
    if (!rows.length) return [];

    const open = new Set(
      (
        await BroadcastRun.findAll({
          attributes: ["broadcastId"],
          where: { status: { [Op.in]: OPEN_RUN_STATUSES }, broadcastId: { [Op.in]: rows.map((row) => row.id) } },
          group: ["broadcastId"],
          transaction,
        })
      ).map((run) => Number(run.broadcastId)),
    );

    const root = mediaRoot();
    const out = [];
    for (const row of rows) {
      if (row.kind !== "recurring" && !open.has(Number(row.id))) continue; // final one-shot: its media is on its way out
      const parsed = format.parseMediaPath(row.mediaPath);
      if (!parsed || Number(parsed.id) !== Number(row.id)) continue;
      try {
        const real = await safeFs.assertInside(root, path.join(root, parsed.id, parsed.name));
        const stat = await fsp.stat(real);
        if (stat.isFile()) out.push({ path: row.mediaPath, file: real, size: stat.size });
      } catch {
        // the file is gone: the restored row loses its mediaPath
      }
    }
    return out;
  }

  /** The files of the session folder (flat, regular files with a plain name), never parsed */
  async function listSession() {
    const dir = sessionDir();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile() && format.SAFE_FILE_NAME.test(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  }

  async function* readChunks(file) {
    const stream = fs.createReadStream(file, { highWaterMark: BLOB_CHUNK });
    try {
      for await (const chunk of stream) yield chunk;
    } finally {
      stream.destroy();
    }
  }

  // ----- the export ----------------------------------------------------------------------------------------

  /**
   * Write the archive to `file`. Pass `passphrase` (a new salt is drawn) or `keys` (the keys of an existing file:
   * the pre-restore backup reuses the key of the file being restored, so one passphrase opens both).
   * @param {{ file: string, passphrase?: string, keys?: object, includeSession?: boolean, now?: number }} options
   */
  async function exportToFile(options) {
    const { file } = options;
    const at = options.now !== undefined ? Number(options.now) : now();
    const models = getModels();
    const sequelize = models.Group.sequelize;

    // buffered counters go to the table first (a no-op while maintenance mode is on)
    try {
      await getStats().flush({ now: at });
    } catch {
      // the statistics of the last seconds are not worth failing a backup
    }

    const keys = options.keys || (await format.newKeys(options.passphrase, { kdf: deps.kdf, gate: deps.kdfGate, scrypt: deps.scrypt }));
    const sessionFiles = options.includeSession ? await listSession() : [];
    const includesSession = sessionFiles.length > 0;
    const counts = {};

    async function* records() {
      const transaction = await sequelize.transaction(
        sequelize.getDialect() === "postgres" ? { isolationLevel: "REPEATABLE READ" } : {},
      );
      try {
        const settingRows = getSettingsStore()
          .rawOverrides({ decrypted: true })
          .map((row) => ({ key: row.key, value: row.value, version: row.version }))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        const textRows = await getTextOverrides().exportRows();
        const media = await listMedia(models, transaction);

        for (const name of MODELS) {
          if (name === "SettingOverride") counts[name] = settingRows.length;
          else if (name === "TextOverride") counts[name] = textRows.length;
          else counts[name] = await models[name].count({ transaction });
        }

        let statusText = null;
        try {
          statusText = await fsp.readFile(statusSavePath(), "utf8");
        } catch {
          statusText = null;
        }

        const files = media.map((item) => ({ kind: "media", name: item.path, size: item.size }));
        if (statusText !== null) files.unshift({ kind: "status", name: "data/status_save.json", size: Buffer.byteLength(statusText) });
        yield line({
          t: "manifest",
          format: format.FORMAT,
          botVersion: String(getConfig().VERSION || "0.0.0"),
          createdAt: new Date(at).toISOString(),
          dialect: sequelize.getDialect(),
          includesSession,
          counts,
          files,
          sessionFiles: sessionFiles.length,
        });

        for (const name of MODELS) {
          if (name === "SettingOverride" || name === "TextOverride") {
            const all = name === "SettingOverride" ? settingRows : textRows;
            for (let i = 0; i < all.length; i += ROWS_BATCH) yield line({ t: "rows", model: name, rows: all.slice(i, i + ROWS_BATCH) });
            continue;
          }
          for await (const batch of rowBatches(models[name], transaction)) yield line({ t: "rows", model: name, rows: batch });
        }

        // the read is over: the transaction does not wait for the files below
        await transaction.commit();

        if (statusText !== null) {
          yield line({ t: "file", name: "data/status_save.json", b64: Buffer.from(statusText, "utf8").toString("base64") });
        }
        for (const item of media) {
          let seq = 0;
          let pending = null;
          for await (const chunk of readChunks(item.file)) {
            if (pending) yield line({ t: "blob", path: item.path, seq: seq++, last: false, b64: pending.toString("base64") });
            pending = chunk;
          }
          yield line({ t: "blob", path: item.path, seq, last: true, b64: (pending || Buffer.alloc(0)).toString("base64") });
        }
        for (const full of sessionFiles) {
          let bytes;
          try {
            bytes = await fsp.readFile(full);
          } catch {
            continue; // rotated away while we read
          }
          yield line({ t: "session", name: path.basename(full), b64: bytes.toString("base64") });
        }
      } catch (err) {
        await transaction.rollback().catch(() => {});
        throw err;
      } finally {
        if (!transaction.finished) await transaction.rollback().catch(() => {});
      }
    }

    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      await pipeline(
        Readable.from(records(), { objectMode: false }),
        zlib.createGzip(),
        format.createSealStream(keys),
        fs.createWriteStream(file, { flags: "wx", mode: 0o600 }),
      );
    } catch (err) {
      await fsp.rm(file, { force: true }).catch(() => {});
      if (err instanceof BackupError) throw err;
      logger().error({ name: err && err.name, code: err && err.code }, "backup export failed");
      throw new BackupError("apply_failed", { phase: "export" }, { cause: err });
    }

    const { size } = await fsp.stat(file);
    return { file, size, counts: { ...counts }, includesSession };
  }

  /**
   * The BAK-1 export: the archive in `data/tmp/`, then a read stream that deletes the file when it closes.
   * @param {{ passphrase: string, includeSession?: boolean, now?: number }} options
   */
  async function exportStream(options) {
    const at = options.now !== undefined ? Number(options.now) : now();
    await fsp.mkdir(tmpDir(), { recursive: true, mode: 0o700 });
    const file = path.join(tmpDir(), `${TMP_PREFIX}${crypto.randomBytes(8).toString("hex")}.owb`);
    const result = await exportToFile({ file, passphrase: options.passphrase, includeSession: options.includeSession, now: at });
    const stream = fs.createReadStream(file);
    const dispose = () => {
      stream.destroy();
      fsp.rm(file, { force: true }).catch(() => {});
    };
    stream.once("close", () => fsp.rm(file, { force: true }).catch(() => {}));
    return {
      stream,
      filename: `openwabot-backup-${format.stampOf(at)}.owb`,
      counts: result.counts,
      size: result.size,
      includesSession: result.includesSession,
      dispose,
    };
  }

  return { exportToFile, exportStream, TMP_PREFIX };
}

module.exports = { createExporter, OPEN_RUN_STATUSES, afterWhere };
