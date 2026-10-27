"use strict";
/**
 * T019: permission flags are enforced by the registry BEFORE execute (FR-003 to FR-006).
 *
 *  - fromMe / ownerOnly commands reply common.owner_only to a non-owner and execute is never called;
 *  - adminOnly commands reply common.sender_not_admin to a non-admin in a group, extra.group_cmd in a PM;
 *  - with SUDO="" the owner commands refuse everybody;
 *  - an owner whose message arrives as @lid with participantAlt = PN is recognized.
 *
 * Every command's execute is replaced by a spy, so nothing of the real commands runs.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

const { IDS } = fakes;
const config = fakes.setupEnv({ sudo: "111" });
const net = fakes.stubNetwork();

const { getLang } = require("../lib/utils/language");
const { invalidateGroupMetadata } = require("../lib/classes/Message");

let registry;
let commands;
let loadFailures;
const calls = []; // { file, alias } of every execute that really ran

before(async () => {
  const setup = await fakes.setup();
  registry = setup.registry;
  commands = setup.commands;
  loadFailures = setup.failed;
  for (const entry of commands) {
    entry.realExecute = entry.execute;
    entry.execute = async function spy(message, args, ctx) {
      calls.push({ file: entry.file, alias: ctx?.command });
    };
  }
});

after(() => {
  for (const entry of commands || []) if (entry.realExecute) entry.execute = entry.realExecute;
  net.restore();
});

const isOwnerCommand = (c) => c.fromMe || c.ownerOnly;
const first = (c) => c.aliases[0];

/** Send `.alias x` from `from` and report { replies, executed }. */
async function run(entry, opts) {
  invalidateGroupMetadata(); // Message.js caches the participants of a group for 60 s
  const before = calls.length;
  const message = fakes.makeMessage({ body: `.${first(entry)} x`, ...opts });
  await registry.executeCommand(message);
  const sock = message.client.getSocket();
  return {
    replies: fakes.sentTexts(sock),
    executed: calls.slice(before),
    sock,
  };
}

const describeFail = (entry, what, r) =>
  `${entry.file} (.${first(entry)}): ${what}; replies=${JSON.stringify(r.replies)} executed=${r.executed.length}`;

test("sanity: there are owner-only and adminOnly commands to check", (t) => {
  // load failures are reported by registry.test.js; here a plugin that does not load simply has no entry
  if (loadFailures.length) t.diagnostic(`not loaded (not checked here): ${loadFailures.map((f) => f.file).join(", ")}`);
  assert.ok(commands.filter(isOwnerCommand).length > 0, "no owner-only command registered");
  assert.ok(commands.filter((c) => c.adminOnly).length > 0, "no adminOnly command registered");
});

test("fromMe / ownerOnly commands refuse a non-owner (PM and group admin), execute never called", async () => {
  const owner = commands.filter(isOwnerCommand);
  const refusal = getLang("common.owner_only");
  const problems = [];
  for (const entry of owner) {
    const cases = {
      "PM, plain user": { from: IDS.MEMBER_PN },
      "PM, user addressed by LID": { from: IDS.MEMBER_PN, lid: true },
      "group, non-admin": { from: IDS.MEMBER_PN, lid: true, group: true, admin: false },
      "group, ADMIN but not owner": { from: IDS.MEMBER_PN, lid: true, group: true, admin: true },
    };
    for (const [label, opts] of Object.entries(cases)) {
      const r = await run(entry, opts);
      if (r.executed.length) problems.push(describeFail(entry, `[${label}] execute was called for a non-owner`, r));
      else if (!r.replies.includes(refusal)) problems.push(describeFail(entry, `[${label}] expected common.owner_only ("${refusal}")`, r));
    }
  }
  fakes.assertNone(problems, `over ${owner.length} owner command(s)`);
});

test("sensitive commands are declared owner-only / admin-only (FR-004, FR-005)", () => {
  // By plugin file, because aliases may change. FR-004: code execution, bot changes, personal data export,
  // disabling the bot, reading deleted / ephemeral messages. FR-005: group administration.
  const OWNER_FILES = [
    "eval.js", "update.js", "exportcontacts.js", "banchat.js", "unbanchat.js", "getantidel.js", "antidel.js",
    "getvv.js", "viewonce.js", "vv.js", "save.js", "statussave.js", "stickercmd.js", "delcmd.js",
  ];
  const ADMIN_FILES = ["kick.js", "promote.js", "demote.js", "tag.js", "warnuser.js", "setwelcome.js", "goodbye.js", "addfilter.js", "delfilter.js"];
  const byFile = new Map(commands.map((c) => [c.file, c]));
  const problems = [];
  for (const file of OWNER_FILES) {
    const c = byFile.get(file);
    if (!c) problems.push(`${file}: no command registered (renamed? update OWNER_FILES in this test)`);
    else if (!isOwnerCommand(c)) problems.push(`${file} (.${first(c)}): must be fromMe/ownerOnly, flags=${flagsOf(c)}`);
  }
  for (const file of ADMIN_FILES) {
    const c = byFile.get(file);
    if (!c) problems.push(`${file}: no command registered (renamed? update ADMIN_FILES in this test)`);
    else if (!c.adminOnly && !isOwnerCommand(c)) problems.push(`${file} (.${first(c)}): must be adminOnly (or owner-only), flags=${flagsOf(c)}`);
  }
  fakes.assertNone(problems);
});

function flagsOf(c) {
  return ["fromMe", "ownerOnly", "onlyGroup", "onlyPm", "adminOnly"].filter((k) => c[k]).join(",") || "none";
}

test("adminOnly commands: common.sender_not_admin for a non-admin in a group, extra.group_cmd in a PM", async () => {
  const adminCommands = commands.filter((c) => c.adminOnly);
  const notAdmin = getLang("common.sender_not_admin");
  const groupOnly = getLang("extra.group_cmd");
  const problems = [];
  for (const entry of adminCommands) {
    let r = await run(entry, { from: IDS.MEMBER_PN, lid: true, group: true, admin: false });
    if (r.executed.length) problems.push(describeFail(entry, "execute ran for a non-admin member", r));
    else if (!r.replies.includes(notAdmin)) problems.push(describeFail(entry, `group non-admin: expected common.sender_not_admin ("${notAdmin}")`, r));

    r = await run(entry, { from: IDS.MEMBER_PN });
    if (r.executed.length) problems.push(describeFail(entry, "execute ran in a private chat", r));
    else if (!r.replies.includes(groupOnly)) problems.push(describeFail(entry, `PM: expected extra.group_cmd ("${groupOnly}")`, r));

    // positive controls: a real admin (LID-addressed) and the owner (not admin) get through
    r = await run(entry, { from: IDS.MEMBER_PN, lid: true, group: true, admin: true });
    if (r.executed.length !== 1) problems.push(describeFail(entry, "a group admin was refused", r));
    r = await run(entry, { from: IDS.OWNER_PN, group: true, admin: false });
    if (r.executed.length !== 1) problems.push(describeFail(entry, "the owner (not group admin) was refused", r));
  }
  fakes.assertNone(problems, `over ${adminCommands.length} adminOnly command(s)`);
});

test("onlyGroup commands refuse a PM (extra.group_cmd); onlyPm commands refuse a group (common.pm_only)", async () => {
  const problems = [];
  for (const entry of commands.filter((c) => c.onlyGroup && !c.adminOnly && !isOwnerCommand(c))) {
    const r = await run(entry, { from: IDS.MEMBER_PN });
    if (r.executed.length || !r.replies.includes(getLang("extra.group_cmd"))) {
      problems.push(describeFail(entry, "onlyGroup in a PM: expected extra.group_cmd", r));
    }
  }
  for (const entry of commands.filter((c) => c.onlyPm)) {
    const r = await run(entry, { from: IDS.OWNER_PN, group: true, admin: true });
    if (r.executed.length || !r.replies.includes(getLang("common.pm_only"))) {
      problems.push(describeFail(entry, "onlyPm in a group: expected common.pm_only", r));
    }
  }
  fakes.assertNone(problems);
});

test("an owner passes owner-only commands (PM and group), without being a group admin", async () => {
  const problems = [];
  for (const entry of commands.filter(isOwnerCommand)) {
    const dmAllowed = !entry.onlyGroup && !entry.adminOnly;
    if (dmAllowed) {
      const r = await run(entry, { from: IDS.OWNER_PN });
      if (r.executed.length !== 1) problems.push(describeFail(entry, "owner refused in a PM", r));
    }
    if (!entry.onlyPm) {
      const r = await run(entry, { from: IDS.OWNER_PN, group: true, admin: false });
      if (r.executed.length !== 1) problems.push(describeFail(entry, "owner refused in a group", r));
    }
  }
  fakes.assertNone(problems);
});

test('with SUDO="" the owner commands refuse everybody (FR-006)', async () => {
  const saved = config.SUDO;
  config.SUDO = "";
  try {
    const refusal = getLang("common.owner_only");
    const problems = [];
    for (const entry of commands.filter(isOwnerCommand)) {
      for (const [label, opts] of Object.entries({
        "former owner, PM": { from: IDS.OWNER_PN },
        "former owner, group admin": { from: IDS.OWNER_PN, group: true, admin: true },
        "former owner by LID": { from: IDS.OWNER_PN, lid: true },
        "member": { from: IDS.MEMBER_PN },
        "the bot itself": { from: IDS.BOT_PN, fromMe: true },
      })) {
        const r = await run(entry, opts);
        if (r.executed.length) problems.push(describeFail(entry, `[${label}] execute ran with no owner configured`, r));
        else if (!r.replies.includes(refusal)) problems.push(describeFail(entry, `[${label}] expected common.owner_only`, r));
      }
    }
    fakes.assertNone(problems);
  } finally {
    config.SUDO = saved;
  }
});

test("an owner arriving as @lid with participantAlt = PN is recognized (group and PM)", async () => {
  const entry = commands.find((c) => isOwnerCommand(c) && !c.onlyGroup && !c.onlyPm && !c.adminOnly);
  assert.ok(entry, "no plain owner command to probe");

  // group: key.participant = 777@lid, key.participantAlt = 111@s.whatsapp.net
  let r = await run(entry, { from: IDS.OWNER_PN, lid: true, group: true });
  assert.equal(r.executed.length, 1, describeFail(entry, "owner addressed by LID (group) was refused", r));

  // PM: remoteJid = 777@lid, remoteJidAlt = 111@s.whatsapp.net
  r = await run(entry, { from: IDS.OWNER_PN, lid: true });
  assert.equal(r.executed.length, 1, describeFail(entry, "owner addressed by LID (PM) was refused", r));

  // the message wrapper agrees
  const m = fakes.makeMessage({ body: ".x", from: IDS.OWNER_PN, lid: true, group: true });
  assert.equal(m.sender, IDS.OWNER_PN);
  assert.equal(m.senderLid, IDS.OWNER_LID);
  assert.equal(m.isSudo(), true);

  // a different user addressed by LID is NOT an owner
  r = await run(entry, { from: IDS.MEMBER_PN, lid: true, group: true });
  assert.equal(r.executed.length, 0, describeFail(entry, "a non-owner LID user got through", r));

  // an unknown LID with no PN alt cannot be matched against SUDO digits: refused
  r = await run(entry, { from: "123456@lid", alt: null, group: true });
  assert.equal(r.executed.length, 0, describeFail(entry, "an unresolvable LID was treated as owner", r));
});

test("SUDO may list a LID and a '+'-prefixed number: both recognized", async () => {
  const entry = commands.find((c) => isOwnerCommand(c) && !c.onlyGroup && !c.onlyPm && !c.adminOnly);
  const saved = config.SUDO;
  config.SUDO = "+222000, 444000@lid";
  try {
    let r = await run(entry, { from: "444000:7@lid", alt: null, group: true });
    assert.equal(r.executed.length, 1, describeFail(entry, "owner listed by LID in SUDO was refused", r));
    r = await run(entry, { from: "222000@s.whatsapp.net" });
    assert.equal(r.executed.length, 1, describeFail(entry, "owner listed as +number in SUDO was refused", r));
    r = await run(entry, { from: IDS.OWNER_PN });
    assert.equal(r.executed.length, 0, describeFail(entry, "111 is no longer an owner but got through", r));
  } finally {
    config.SUDO = saved;
  }
});

test("the registry checks happen before execute: a refused call never reaches the plugin", async () => {
  // a non-owner hammering every owner/admin command must leave the spy log untouched
  const before = calls.length;
  for (const entry of commands.filter((c) => isOwnerCommand(c) || c.adminOnly)) {
    await run(entry, { from: IDS.MEMBER_PN, lid: true, group: true, admin: false });
  }
  assert.equal(calls.length, before, `execute ran: ${JSON.stringify(calls.slice(before))}`);
});
