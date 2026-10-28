"use strict";

/**
 * Pairing routes (admin-http-api.md section 2.4, FR-023 and FR-024). The logic is lib/admin/services/pairing.js.
 *
 *   GET  /admin/api/pairing              PAIR-1  session, touch:n, db:r   { status, registered, number, qr, code, codeCooldownMs }
 *   GET  /admin/api/pairing/qr.svg?v=<n> PAIR-2  session, touch:n, db:r   the current QR as image/svg+xml, 404 no_qr
 *   POST /admin/api/pairing/code         PAIR-3  session, db:r            { phone } -> { code, expiresAt }
 *   POST /admin/api/pairing/logout       PAIR-4  session, db:r            { confirm: true } -> { ok: true }
 *
 * Neither the QR string nor the pairing code is ever logged or audited: PAIR-3 answers with the code once, PAIR-2
 * is authenticated and same-origin, and the audit trail keeps the last two digits of the number only. The hub topic
 * `pairing` (SSE and snapshot) is fed by the service, started and stopped with the admin.
 */

const { AdminError, finish } = require("../http/response");

function register({ router, deps, hub, onStart, onStop }) {
  const { createPairingService, last2Of } = require("../services/pairing");
  const pairing = createPairingService({
    getClient: () => deps.client,
    hub,
    now: () => deps.clock.now(),
    logger: deps.logger,
    redactor: deps.redactor,
  });

  onStart(() => pairing.start());
  onStop(() => pairing.stop());

  // ---- PAIR-1 -------------------------------------------------------------------------------
  router.route({
    method: "GET",
    path: "/admin/api/pairing",
    auth: "session",
    touch: false,
    db: "optional",
    handler: (ctx) => pairing.describe(ctx.now),
  });

  // ---- PAIR-2 -------------------------------------------------------------------------------
  // `<img>` cannot send headers: session cookie plus Origin / Sec-Fetch-Site checks (sameOrigin).
  router.route({
    method: "GET",
    path: "/admin/api/pairing/qr.svg",
    auth: "session",
    touch: false,
    db: "optional",
    sameOrigin: true,
    query: { v: { type: "string", pattern: /^\d{1,15}$/ } },
    handler: async (ctx) => {
      const svg = await pairing.qrSvg();
      if (!svg) throw new AdminError("no_qr");
      finish(ctx.res, {
        status: 200,
        body: svg,
        contentType: "image/svg+xml; charset=utf-8",
        cacheControl: "no-store",
        // the image document gets the tightest policy: nothing may load or run from it
        headers: { "Content-Security-Policy": "default-src 'none'" },
        requestId: ctx.requestId,
        head: ctx.req.method === "HEAD",
      });
    },
  });

  // ---- PAIR-3 -------------------------------------------------------------------------------
  router.route({
    method: "POST",
    path: "/admin/api/pairing/code",
    auth: "session",
    db: "optional",
    schema: { phone: { type: "string", required: true } },
    handler: async (ctx) => {
      const phone = pairing.parsePhone(ctx.body.phone);
      const target = last2Of(phone);
      let result;
      try {
        result = await pairing.requestCode(phone, ctx.now);
      } catch (err) {
        if (err && err.code === "whatsapp_error") await ctx.audit("pair.code", target, "fail");
        throw err;
      }
      await ctx.audit("pair.code", target, "ok");
      return { code: result.code, expiresAt: result.expiresAt };
    },
  });

  // ---- PAIR-4 -------------------------------------------------------------------------------
  router.route({
    method: "POST",
    path: "/admin/api/pairing/logout",
    auth: "session",
    db: "optional",
    schema: { confirm: { type: "boolean" } },
    handler: async (ctx) => {
      if (ctx.body.confirm !== true) throw new AdminError("confirmation_required", { params: { confirm: "logout" } });
      let result;
      try {
        result = await pairing.closeSession();
      } catch (err) {
        await ctx.audit("session.logout", null, "fail", { code: (err && err.code) || (err && err.name) || "error" });
        throw err;
      }
      await ctx.audit("session.logout", null, "ok", { removed: result.removed });
      return { ok: true };
    },
  });
}

module.exports = { register };
