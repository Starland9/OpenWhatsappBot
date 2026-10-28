"use strict";

/**
 * Backup and restore routes (US10, admin-http-api.md 2.13). The logic is lib/admin/services/backup.js over
 * lib/admin/backup/*.
 *
 *   POST /admin/api/backup/export          BAK-1  { passphrase, includeSession?, confirmSession? } -> the .owb file
 *   POST /admin/api/backup/inspect         BAK-2  { uploadId, passphrase } -> { restoreToken, expiresAt, summary }
 *   POST /admin/api/backup/restore         BAK-3  { restoreToken, confirm: true } -> 202 with a `restore` job
 *   GET  /admin/api/backup/stored          BAK-4  the pre-restore backups kept in data/backups/
 *   GET  /admin/api/backup/stored/:name    BAK-5  one of them (still encrypted by the passphrase)
 *
 * BAK-1 validates everything (passphrase length, the session confirmation, single flight) before the first byte is
 * sent, then answers 200 with `Content-Disposition: attachment` and `Cache-Control: no-store`. The passphrase is never
 * logged and never in an audit row: `backup.export` carries the counts and `includesSession` only. BAK-2 takes an
 * UP-1 upload (`purpose=backup`) of the same session. During the apply the maintenance gate answers 503 `maintenance`
 * on every mutating route while the reads still answer.
 *
 * Start-up: the `restore_interrupted` banner provider is added to the state service, and `onStart` runs the boot
 * recovery (sweep of data/tmp, `restore.lock`). The `maintenance` banner is the state service's own.
 */

const { pipeline } = require("stream/promises");
const { AdminError, reply } = require("../http/response");
const { createBackupService } = require("../services/backup");
const { getStateService } = require("../services/state");

const EXPORT_SCHEMA = {
  passphrase: { type: "string", required: true, minLength: 12, maxLength: 256, nfkc: true },
  includeSession: { type: "boolean" },
  confirmSession: { type: "boolean" },
};
const INSPECT_SCHEMA = {
  uploadId: { type: "string", required: true, pattern: /^[0-9a-f]{32}$/ },
  passphrase: { type: "string", required: true, minLength: 1, maxLength: 256, nfkc: true },
};
const RESTORE_SCHEMA = {
  restoreToken: { type: "string", required: true, maxLength: 128 },
  confirm: { type: "boolean" },
};

/** Send a file as a download; the response is taken over, a failure mid-way drops the connection */
async function sendDownload(ctx, { stream, filename, size }) {
  const { res } = ctx;
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
    "Content-Length": size,
  });
  try {
    await pipeline(stream, res);
  } catch {
    stream.destroy();
    res.destroy();
  }
}

function register({ router, deps, jobs, audit, onStart, onStop }) {
  const service = deps.backupService || createBackupService(deps);
  const sessionOf = (ctx) => (ctx.session && ctx.session.id !== undefined ? String(ctx.session.id) : "");

  const removeBanner = getStateService(deps).addBannerProvider(() =>
    service.isInterrupted() ? { id: "restore_interrupted", severity: "error", params: {} } : null,
  );

  router.route({
    method: "POST",
    path: "/admin/api/backup/export",
    auth: "session",
    schema: EXPORT_SCHEMA,
    handler: async (ctx) => {
      const { passphrase, includeSession = false, confirmSession = false } = ctx.body;
      const out = await service.exportBackup({ passphrase, includeSession, confirmSession });
      try {
        await ctx.audit("backup.export", null, "ok", { counts: out.counts, includesSession: out.includesSession });
      } catch {
        // the history never blocks the download
      }
      await sendDownload(ctx, out);
    },
  });

  router.route({
    method: "POST",
    path: "/admin/api/backup/inspect",
    auth: "session",
    schema: INSPECT_SCHEMA,
    handler: (ctx) => service.inspect({ uploadId: ctx.body.uploadId, passphrase: ctx.body.passphrase, sessionId: sessionOf(ctx) }),
  });

  router.route({
    method: "POST",
    path: "/admin/api/backup/restore",
    auth: "session",
    schema: RESTORE_SCHEMA,
    handler: (ctx) => {
      const answer = service.startRestore(
        { restoreToken: ctx.body.restoreToken, confirm: ctx.body.confirm, sessionId: sessionOf(ctx), actor: ctx.origin, origin: ctx.origin },
        { jobs, audit },
      );
      return reply(202, answer);
    },
  });

  router.route({
    method: "GET",
    path: "/admin/api/backup/stored",
    auth: "session",
    handler: async () => ({ items: await service.listStored() }),
  });

  router.route({
    method: "GET",
    path: "/admin/api/backup/stored/:name",
    auth: "session",
    // the router's default `name` pattern lets the value through; the service holds the file to
    // /^pre-restore-[0-9A-Za-z_-]{1,40}\.owb$/ and to data/backups/ (anything else is the same 404)
    handler: async (ctx) => {
      const found = await service.openStored(ctx.params.name);
      if (!found) throw new AdminError("not_found", { params: { resource: "backup" } });
      await sendDownload(ctx, { stream: found.stream, filename: found.name, size: found.size });
    },
  });

  onStart(() => service.start());
  onStop(async () => {
    removeBanner();
    await service.stop();
  });
}

module.exports = { register };
