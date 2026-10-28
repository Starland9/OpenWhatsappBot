"use strict";

/**
 * Authentication and account routes (admin-http-api.md 2.1 and 2.2): STA-3 and AUTH-1 to AUTH-6.
 *
 *   GET   /admin/setup?token=            STA-3   validates WITHOUT consuming, sets owb_setup, 303 to the SPA
 *   GET   /admin/api/session             AUTH-1  public, db:r, always 200
 *   POST  /admin/api/login               AUTH-2  public, csrf: origin; the lockout is checked before any hashing
 *   POST  /admin/api/logout              AUTH-3
 *   POST  /admin/api/setup               AUTH-4  auth "setup" (cookie owb_setup); first account or password reset
 *   PATCH /admin/api/account/password    AUTH-5  a wrong current password is a 422 field error, never a 401
 *   PATCH /admin/api/account/preferences AUTH-6
 *
 * The session cookie is rotated at login, setup and password change. The services (passwords, sessions,
 * tokens, rate limits) come from lib/admin/auth/index.js through `deps.auth`; models are resolved lazily.
 * Every multi-statement write runs in one transaction behind the in-process mutex (in-memory SQLite has a
 * single connection, data-model 0.4).
 */

const { AdminError, reply } = require("../http/response");
const { withLock } = require("../../utils/mutex");

const UI_LANGS = ["fr", "en"];
const THEMES = ["auto", "light", "dark"];
const SEEN_ACTIONS = ["login.success", "setup.complete", "reset.complete"];

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

function publicAccount(account) {
  return {
    uiLang: account.uiLang || "fr",
    theme: account.theme || "auto",
    lastLoginAt: account.lastLoginAt ? new Date(account.lastLoginAt).toISOString() : null,
  };
}

const publicSession = (session) => ({
  idleExpiresAt: iso(session.idleExpiresAt),
  absoluteExpiresAt: iso(session.absoluteExpiresAt),
});

/** Roll back without letting a second error hide the first. */
async function rollback(tx) {
  try {
    await tx.rollback();
  } catch {
    // already finished
  }
}

function register({ router, deps }) {
  const authOf = () => deps.auth;
  const userAgentOf = (req) => (typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null);

  /** Last account seen by AUTH-1, kept for the moments the database is unreachable (db:r). */
  let lastAccount = null;

  // ---- STA-3 -------------------------------------------------------------------------------

  router.route({
    method: "GET",
    path: "/admin/setup",
    auth: "public",
    handler: async (ctx) => {
      const a = authOf();
      const wrong = a.limits.token.check(ctx.origin, ctx.now);
      if (wrong.blocked) throw new AdminError("rate_limited", { params: { retryAfterMs: wrong.retryAfterMs } });

      const token = typeof ctx.query.token === "string" ? ctx.query.token : "";
      let record = null;
      if (token) {
        record = await a.tokens.validate(token);
        if (!record) a.limits.token.fail(ctx.origin, ctx.now);
      }
      const headers = { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
      if (!record) return reply(303, undefined, { ...headers, Location: "/admin/#/setup/invalid" });
      // the token leaves the URL bar, the history and the Referer: from here on it lives in an HttpOnly cookie
      const maxAgeSec = Math.max(1, Math.floor((record.expiresAt - ctx.now) / 1000));
      return reply(303, undefined, {
        ...headers,
        Location: "/admin/#/setup",
        "Set-Cookie": a.cookies.setupCookie(token, { https: a.isHttps(ctx.req), maxAgeSec }),
      });
    },
  });

  // ---- AUTH-1 ------------------------------------------------------------------------------

  router.route({
    method: "GET",
    path: "/admin/api/session",
    auth: "public",
    db: "optional",
    handler: async (ctx) => {
      const a = authOf();
      const shape = { https: a.isHttps(ctx.req), proxyHint: a.proxyHint(ctx.req) };
      const session = await a.optionalSession(ctx);

      if (session) {
        // opening the page is activity: the idle clock moves (a forgotten tab only polls touch:false routes)
        a.touch(session);
        try {
          const row = await a.models().AdminAccount.findByPk(1);
          if (row) lastAccount = publicAccount(row);
        } catch {
          // database down: the cached session keeps working with the last account seen
        }
        return {
          accountExists: true,
          authenticated: true,
          ...shape,
          setup: null,
          csrf: session.csrf,
          account: lastAccount || { uiLang: UI_LANGS.includes(a.botLang()) ? a.botLang() : "fr", theme: "auto", lastLoginAt: null },
          session: publicSession(session),
          bot: { version: a.readSetting("VERSION"), lang: a.botLang(), timezone: a.readSetting("TIMEZONE") },
        };
      }

      const exists = await a.accountExists();
      const setup = await a.peekSetup(ctx.req);
      return {
        // unknown (database unreachable or still starting): do not invite a setup that cannot happen
        accountExists: exists === null ? true : exists,
        authenticated: false,
        ...shape,
        setup: setup ? { purpose: setup.purpose, expiresAt: iso(setup.expiresAt) } : null,
      };
    },
  });

  // ---- AUTH-2 ------------------------------------------------------------------------------

  router.route({
    method: "POST",
    path: "/admin/api/login",
    auth: "public",
    schema: { password: { type: "string", required: true, minLength: 1, maxLength: 256, nfkc: true } },
    handler: async (ctx) => {
      const a = authOf();
      const { AdminAccount } = a.models();
      const at = ctx.now;

      // 1. the lockout, BEFORE any hashing: the right password is refused too while the block lasts
      const gate = a.limits.login.check(ctx.origin, at);
      if (gate.blocked) throw new AdminError("login_blocked", { params: { retryAfterMs: gate.retryAfterMs } });

      const account = await AdminAccount.findByPk(1);
      if (!account) throw new AdminError("setup_required");

      // 2. verification (hash queue full -> 429 rate_limited)
      const ok = await a.passwords.verify(ctx.body.password, account.passwordHash);
      if (!ok) {
        const failure = a.limits.login.fail(ctx.origin, at);
        await ctx.audit("login.failure", ctx.origin, "fail");
        if (failure.newlyBlocked) {
          // one row and one alert when the block starts, not one per refused attempt
          await ctx.audit("login.blocked", ctx.origin, "blocked", { retryAfterMs: failure.retryAfterMs });
          a.alerts.loginBlocked({ origin: ctx.origin, retryAfterMs: failure.retryAfterMs });
        }
        throw new AdminError("invalid_credentials");
      }

      // 3. success
      a.limits.login.success(ctx.origin);
      let seen = true;
      try {
        seen = a.audit && typeof a.audit.hasSeenOrigin === "function" ? await a.audit.hasSeenOrigin(ctx.origin, { actions: SEEN_ACTIONS }) : true;
      } catch {
        seen = true; // cannot tell: never raise a false "new origin" alert
      }

      const changes = { lastLoginAt: new Date(at) };
      if (a.passwords.needsRehash(account.passwordHash)) {
        try {
          changes.passwordHash = await a.passwords.hash(ctx.body.password);
        } catch {
          // the old hash still works; the next login tries again
        }
      }
      await account.update(changes);

      // rotation: a cookie presented before the login is discarded, a fresh session is issued
      const previous = a.cookies.readSessionCookie(ctx.req);
      if (previous && a.sessions.isValidValue(previous)) {
        try {
          await a.sessions.revoke(a.sessions.idOf(previous), "rotated");
        } catch {
          // an unreachable old row must not block a login
        }
      }
      const { value, session } = await a.sessions.create({ origin: ctx.origin, userAgent: userAgentOf(ctx.req) });

      await ctx.audit("login.success", ctx.origin, "ok");
      if (!seen) a.alerts.newOrigin({ origin: ctx.origin });

      const https = a.isHttps(ctx.req);
      return reply(
        200,
        { csrf: session.csrf, account: publicAccount(account), session: publicSession(session) },
        { "Set-Cookie": a.cookies.sessionCookie(value, { https, maxAgeSec: a.sessions.cookieMaxAge(session) }) },
      );
    },
  });

  // ---- AUTH-3 ------------------------------------------------------------------------------

  router.route({
    method: "POST",
    path: "/admin/api/logout",
    auth: "session",
    handler: async (ctx) => {
      const a = authOf();
      await a.sessions.revoke(ctx.session.id, "logout");
      await ctx.audit("logout", null);
      return reply(200, { ok: true }, { "Set-Cookie": a.cookies.clearSessionCookies({ https: a.isHttps(ctx.req) }) });
    },
  });

  // ---- AUTH-4 ------------------------------------------------------------------------------

  router.route({
    method: "POST",
    path: "/admin/api/setup",
    auth: "setup",
    schema: { password: { type: "string", required: true, minLength: 12, maxLength: 256, nfkc: true } },
    handler: async (ctx) => {
      const a = authOf();
      const m = a.models();
      const grant = ctx.session;

      const weak = a.passwords.checkPolicy(ctx.body.password);
      if (weak) throw new AdminError("validation_failed", { fields: { password: weak } });
      const hash = await a.passwords.hash(ctx.body.password);

      const done = await withLock("admin-auth", async () => {
        const tx = await m.DATABASE.transaction();
        let kind;
        let revoked = [];
        try {
          // the token is consumed in the same transaction that creates the account / changes the password
          const used = await a.tokens.consume(grant.token, { transaction: tx });
          kind = used.kind;
          if (kind === "setup") {
            if (await m.AdminAccount.findByPk(1, { transaction: tx })) throw new AdminError("token_invalid");
            await m.AdminAccount.create(
              {
                id: 1,
                passwordHash: hash,
                uiLang: UI_LANGS.includes(a.botLang()) ? a.botLang() : "fr",
                theme: "auto",
                lastLoginAt: new Date(ctx.now),
                createdAt: new Date(ctx.now),
              },
              { transaction: tx },
            );
            await a.tokens.deleteKind("setup", { transaction: tx });
          } else {
            const account = await m.AdminAccount.findByPk(1, { transaction: tx });
            if (!account) throw new AdminError("token_invalid");
            await account.update({ passwordHash: hash, lastLoginAt: new Date(ctx.now) }, { transaction: tx });
            revoked = await a.sessions.destroyAll({ transaction: tx });
          }
          await tx.commit();
        } catch (err) {
          await rollback(tx);
          throw err;
        }
        // still inside the lock: on the single connection of an in-memory database a later transaction must not
        // begin between the commit and these writes
        const opened = await a.sessions.create({ origin: ctx.origin, userAgent: userAgentOf(ctx.req) });
        const account = await m.AdminAccount.findByPk(1);
        return { kind, revoked, account, ...opened };
      });

      a.limits.token.success(ctx.origin);
      if (done.kind === "setup") a.markAccountCreated();
      else {
        // a reset revokes every session and lifts every lockout
        a.sessions.forget(done.revoked, "revoked");
        a.limits.clearAll();
      }
      await ctx.audit(done.kind === "setup" ? "setup.complete" : "reset.complete", null);
      const { value, session, account } = done;

      const https = a.isHttps(ctx.req);
      return reply(
        200,
        { purpose: done.kind, csrf: session.csrf, account: publicAccount(account), session: publicSession(session) },
        {
          "Set-Cookie": [
            a.cookies.clearSetupCookie({ https }),
            a.cookies.sessionCookie(value, { https, maxAgeSec: a.sessions.cookieMaxAge(session) }),
          ],
        },
      );
    },
  });

  // ---- AUTH-5 ------------------------------------------------------------------------------

  router.route({
    method: "PATCH",
    path: "/admin/api/account/password",
    auth: "session",
    schema: {
      currentPassword: { type: "string", required: true, minLength: 1, maxLength: 256, nfkc: true },
      newPassword: { type: "string", required: true, minLength: 12, maxLength: 256, nfkc: true },
    },
    handler: async (ctx) => {
      const a = authOf();
      const m = a.models();
      const { currentPassword, newPassword } = ctx.body;

      // a stolen session must not guess the password faster than the login can
      const gate = a.limits.password.check(ctx.origin, ctx.now);
      if (gate.blocked) throw new AdminError("rate_limited", { params: { retryAfterMs: gate.retryAfterMs } });

      const account = await m.AdminAccount.findByPk(1);
      if (!account) throw new AdminError("setup_required");

      const fields = {};
      const weak = a.passwords.checkPolicy(newPassword);
      if (weak) fields.newPassword = weak;
      const correct = await a.passwords.verify(currentPassword, account.passwordHash);
      if (correct) a.limits.password.success(ctx.origin);
      else {
        a.limits.password.fail(ctx.origin, ctx.now);
        fields.currentPassword = { code: "wrong_password" };
      }
      if (!fields.newPassword && a.passwords.normalize(newPassword) === a.passwords.normalize(currentPassword)) {
        fields.newPassword = { code: "same_as_current" };
      }
      if (Object.keys(fields).length) throw new AdminError("validation_failed", { fields });

      const hash = await a.passwords.hash(newPassword);
      const done = await withLock("admin-auth", async () => {
        const tx = await m.DATABASE.transaction();
        let others;
        try {
          await account.update({ passwordHash: hash }, { transaction: tx });
          others = await a.sessions.destroyAll({ except: ctx.session.id, transaction: tx });
          await tx.commit();
        } catch (err) {
          await rollback(tx);
          throw err;
        }
        // rotation: this session gets a new id and a new cookie (inside the lock, see AUTH-4)
        const opened = await a.sessions.create({ origin: ctx.origin, userAgent: userAgentOf(ctx.req) });
        await a.sessions.revoke(ctx.session.id, "rotated");
        return { others, ...opened };
      });
      a.sessions.forget(done.others, "revoked");
      await ctx.audit("account.update", "password");
      const { value, session } = done;

      return reply(
        200,
        { csrf: session.csrf },
        { "Set-Cookie": a.cookies.sessionCookie(value, { https: a.isHttps(ctx.req), maxAgeSec: a.sessions.cookieMaxAge(session) }) },
      );
    },
  });

  // ---- AUTH-6 ------------------------------------------------------------------------------

  router.route({
    method: "PATCH",
    path: "/admin/api/account/preferences",
    auth: "session",
    schema: {
      uiLang: { type: "string", enum: UI_LANGS },
      theme: { type: "string", enum: THEMES },
    },
    handler: async (ctx) => {
      const a = authOf();
      const changes = {};
      if (ctx.body.uiLang !== undefined) changes.uiLang = ctx.body.uiLang;
      if (ctx.body.theme !== undefined) changes.theme = ctx.body.theme;
      if (!Object.keys(changes).length) {
        throw new AdminError("validation_failed", { fields: { uiLang: { code: "required" }, theme: { code: "required" } } });
      }
      const account = await a.models().AdminAccount.findByPk(1);
      if (!account) throw new AdminError("setup_required");
      await account.update(changes);
      lastAccount = publicAccount(account);
      return { uiLang: account.uiLang, theme: account.theme };
    },
  });
}

module.exports = { register };
