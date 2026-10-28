"use strict";

/**
 * Backup service (US10, FR-051 to FR-053; admin-http-api.md 2.13): the facade the routes talk to. The work is in
 * lib/admin/backup/{format,export,restore}.js; this file adds the single-flight rules, the translation of
 * BackupError codes into the envelope codes of section 1.9 and the `restore` job. It never touches `req`/`res`.
 *
 *   const backup = createBackupService(deps);
 *   await backup.exportBackup({ passphrase, includeSession, confirmSession })
 *        -> { stream, filename, size, counts, includesSession }       BAK-1; `busy` until the stream has closed
 *   await backup.inspect({ uploadId, passphrase, sessionId })         BAK-2 -> { restoreToken, expiresAt, summary }
 *   backup.startRestore({ restoreToken, confirm, sessionId, actor, origin }, { jobs, audit }) -> { job }    BAK-3
 *   await backup.listStored() / backup.openStored(name)               BAK-4 / BAK-5 (the pre-restore backups)
 *   await backup.start() / backup.stop()                              boot recovery, token sweep
 *   backup.isInterrupted()                                            the `restore_interrupted` banner
 *
 * The passphrase is passed straight to the engines: it is never logged, audited or kept. A restore ends with the
 * in-process restart of the bot; the job's result carries the file name of the pre-restore backup.
 */

const { AdminError } = require("../http/response");
const { BackupError } = require("../backup/format");
const { createExporter } = require("../backup/export");
const { createRestorer } = require("../backup/restore");

const CODE_BY_ERROR = Object.freeze({
  bad_passphrase: "wrong_passphrase",
  file_altered: "backup_corrupted",
  format_unsupported: "backup_unsupported_format",
  newer_version: "backup_too_new",
  invalid_row: "backup_invalid_row",
  token_expired: "restore_token_invalid",
  busy: "busy",
  rate_limited: "rate_limited",
  confirmation_required: "confirmation_required",
});

/** A BackupError as the envelope error the HTTP layer prints; anything else is passed on (500, logged) */
function toAdminError(err) {
  if (!(err instanceof BackupError)) return err;
  if (err.code === "passphrase_too_short") {
    return new AdminError("validation_failed", { fields: { passphrase: { code: "too_short", params: { min: 12 } } } });
  }
  if (err.code === "upload_not_found") return new AdminError("not_found", { params: { resource: "upload" } });
  const code = CODE_BY_ERROR[err.code];
  if (!code) return err; // secret_storage_unavailable, apply_failed...: an internal error
  return new AdminError(code, { params: err.params, cause: err });
}

function createBackupService(deps = {}) {
  const exporter = deps.backupExporter || createExporter(deps);
  const restorer = deps.backupRestorer || createRestorer({ ...deps, exporter });
  let exporting = false;

  const logger = () => deps.logger || require("../../utils/logger").createLogger("backup");

  async function exportBackup({ passphrase, includeSession = false, confirmSession = false }) {
    if (includeSession && confirmSession !== true) {
      throw new AdminError("confirmation_required", { params: { confirm: "include_session" } });
    }
    if (exporting || restorer.isBusy() || (deps.jobs && deps.jobs.isBusy && deps.jobs.isBusy("restore"))) {
      throw new AdminError("busy");
    }
    exporting = true;
    try {
      const out = await exporter.exportStream({ passphrase, includeSession });
      out.stream.once("close", () => {
        exporting = false;
      });
      return out;
    } catch (err) {
      exporting = false;
      throw toAdminError(err);
    }
  }

  async function inspect({ uploadId, passphrase, sessionId }) {
    if (exporting) throw new AdminError("busy");
    try {
      return await restorer.inspect({ uploadId, passphrase, adminSessionId: String(sessionId) });
    } catch (err) {
      throw toAdminError(err);
    }
  }

  /** BAK-3: token and confirmation checked now (409), the work runs as the `restore` job */
  function startRestore({ restoreToken, confirm, sessionId, actor, origin }, { jobs, audit }) {
    if (confirm !== true) throw new AdminError("confirmation_required", { params: { confirm: "restore" } });
    try {
      restorer.checkToken(restoreToken, String(sessionId));
    } catch (err) {
      throw toAdminError(err);
    }
    if (restorer.isBusy() || exporting) throw new AdminError("busy");

    const job = jobs.start(
      "restore",
      async (handle) => {
        try {
          const result = await restorer.apply({
            restoreToken,
            confirm: true,
            actor: actor || origin || null,
            adminSessionId: String(sessionId),
            onPhase: (phase) => handle.setPhase(phase),
          });
          await audit.record({
            action: "backup.restore",
            target: null,
            origin,
            result: "ok",
            detail: { counts: result.counts, includesSession: result.includesSession },
          });
          return result;
        } catch (err) {
          const phase = err && err.params && err.params.phase ? err.params.phase : "unknown";
          const reason = err && err.params && err.params.reason ? err.params.reason : err && err.code;
          await audit.record({ action: "backup.restore", target: null, origin, result: "fail", detail: { phase, reason } });
          const failure = new Error("restore_failed");
          failure.code = "restore_failed";
          failure.params = { phase };
          if (typeof reason === "string") failure.params.reason = reason;
          throw failure;
        }
      },
      { failureCode: "restore_failed" },
    );
    return { job };
  }

  return {
    exportBackup,
    inspect,
    startRestore,
    listStored: () => restorer.listStored(),
    openStored: (name) => restorer.openStored(name),

    /** After the database is ready: sweep the leftovers of an interrupted restore, arm the token sweep */
    async start() {
      restorer.start();
      try {
        const out = await restorer.recoverAtBoot();
        if (out.interrupted) logger().warn("backup: an interrupted restore was found at start-up");
      } catch (err) {
        logger().error({ name: err && err.name, code: err && err.code }, "backup: the boot recovery failed");
      }
    },
    async stop() {
      await restorer.stop();
    },
    isInterrupted: () => restorer.isInterrupted(),
    isBusy: () => exporting || restorer.isBusy(),
    restorer,
    exporter,
  };
}

module.exports = { createBackupService, toAdminError };
