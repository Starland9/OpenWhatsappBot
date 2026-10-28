#!/usr/bin/env node
"use strict";

/**
 * Password reset link for the admin panel (FR-007, admin-http-api.md 2.1).
 *
 *   node tools/admin-reset.js
 *
 * Connects to the same database as the bot (DATABASE_URL, config.env), issues a single-use `reset` token and
 * prints the link (valid 30 minutes) with the ORIGINAL stdout write, so it never enters a log. The attempt is
 * recorded as `reset.issued` with origin "cli". It works while the bot is running: the bot validates the token
 * against the database when the link is opened. Opening the link lets the owner choose a new password; doing
 * so revokes every session and lifts every login lockout.
 *
 * It needs server access by construction (a shell or the files of the host), never an HTTP route. Hosts
 * without a second shell can create an empty file `data/admin-reset` instead: the bot issues the same link at
 * its next start.
 *
 * Exit code: 0 link printed, 1 no account yet (run the bot: a setup link is printed), 2 failure.
 */

const MISSING_TABLE = /no such table|does not exist|doesn't exist/i;

const isMissingTable = (err) => MISSING_TABLE.test(String((err && err.message) || "") + String((err && err.parent && err.parent.message) || ""));

/**
 * @param {object} [options]  every dependency is injectable (tests)
 * @returns {Promise<number>} the exit code
 */
async function run(options = {}) {
  const { getLang } = require("../lib/utils/language");
  const print = options.print || require("../lib/utils/logger").printToConsole;
  const printError = options.printError || ((line) => process.stderr.write(`${line}\n`));
  const { createTokens, linkBase } = require("../lib/admin/auth/tokens");

  try {
    const config = options.config || require("../config");
    const models = options.models || require("../lib/database");
    const audit = options.audit || require("../lib/admin/audit");

    let account = null;
    try {
      account = await models.AdminAccount.findByPk(1, { attributes: ["id"] });
    } catch (err) {
      // the bot never ran against this database: there is no account either
      if (!isMissingTable(err)) throw err;
    }
    if (!account) {
      print(getLang("admin.reset_no_account"));
      return 1;
    }

    const tokens = createTokens({ models, now: options.now });
    const issued = await tokens.issue("reset");
    const url = tokens.buildLink(linkBase({ publicUrl: config.PANEL_PUBLIC_URL, port: config.PANEL_PORT }), issued.token);
    print(getLang("admin.reset_link", url, Math.round(issued.ttlMs / 60000)));
    await audit.record({ action: "reset.issued", target: null, origin: "cli", result: "ok", detail: { source: "cli" } });
    return 0;
  } catch (err) {
    printError(getLang("admin.reset_failed", (err && (err.code || err.name)) || "error"));
    return 2;
  }
}

async function main() {
  const code = await run();
  try {
    await require("../lib/database").DATABASE.close();
  } catch {
    // the connection may never have opened
  }
  process.exitCode = code;
}

if (require.main === module) {
  main();
}

module.exports = { run, main, isMissingTable };
