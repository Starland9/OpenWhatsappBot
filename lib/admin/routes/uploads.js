"use strict";

/**
 * UP-1 and UP-2 of admin-http-api.md section 2.12 (the logic lives in lib/admin/http/uploads.js).
 *
 *   PUT    /admin/api/uploads?purpose=backup|broadcast&name=...   raw application/octet-stream, 201 { uploadId, ... }
 *   DELETE /admin/api/uploads/:id                                 200 { deleted: true }, 404 for an unknown, expired
 *                                                                 or foreign id
 *
 * The upload id is 32 hexadecimal characters (unguessable), so this route overrides the numeric `:id` pattern.
 * The shared instance is `deps.uploads` (created by createAdmin), which W-BAK and W-BC use through
 * `peek(id, sessionId, { purpose })` and `consume(...)`.
 */

const path = require("path");

function register({ router, deps, onStart, onStop }) {
  const uploads =
    deps.uploads ||
    require("../http/uploads").createUploads({
      dir: path.join(deps.dataDir || path.join(__dirname, "..", "..", "..", "data"), "admin-uploads"),
    });

  router.route({
    method: "PUT",
    path: "/admin/api/uploads",
    auth: "session",
    upload: true,
    handler: (ctx) => uploads.put(ctx),
  });

  router.route({
    method: "DELETE",
    path: "/admin/api/uploads/:id",
    auth: "session",
    params: { id: /^[0-9a-f]{32}$/ },
    handler: (ctx) => uploads.remove(ctx),
  });

  onStart(() => uploads.start());
  onStop(() => uploads.stop());
}

module.exports = { register };
