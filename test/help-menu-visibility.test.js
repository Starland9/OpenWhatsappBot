"use strict";
/**
 * Feature 003 (specs/003-command-permissions, contracts/runtime.md sections 6 and 8 file 4): `.menu`, `.bmenu`
 * (categories, category lists, command cards) and `.help <command>` show what the requester may use, with
 * the same decision as execution (`commandPermissions.decide`).
 *
 * Part A, the menu and the categories (US1):
 *  - no rule: the visible list is the legacy formula `getCommands().filter((c) => owner || !isOwnerOnly(c))`
 *    for the owner, a member and a group admin, in a private chat and in a group; the menu text, the
 *    category rows, their counts and their order are the legacy ones (FR-029, SC-004);
 *  - with rules: a granted member sees `vv` in group A and not in group D nor in a private chat; an `only`
 *    rule hides the command (and drops the category count) from everybody not listed, the owner and a
 *    listed member still see it; a category whose commands are all closed disappears;
 *  - a failed rule load gives the no-rule menu.
 * Part B, the lookups by name (US2), is appended below.
 */

const { test, before, beforeEach, afterEach, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

const { IDS } = fakes;
fakes.setupEnv({ sudo: "111" });
const net = fakes.stubNetwork();

const settingsCache = require("../lib/utils/settingsCache");
const commandPermissions = require("../lib/utils/commandPermissions");
const { invalidateGroupMetadata } = require("../lib/classes/Message");
const { getLang } = require("../lib/utils/language");
const config = require("../config");

const GROUP_A = IDS.GROUP;
const GROUP_D = "120363000000000004@g.us";
const PRIVATE = "private";

// Actors. B is named in the rules; C is a plain member who is not; ADMIN is a group admin who is not.
const OWNER = { from: IDS.OWNER_PN };
const B = { from: IDS.MEMBER_PN }; // 333, LID 888
const C = { from: IDS.MEMBER2_PN }; // 444, PN only
const ADMIN = { from: IDS.MEMBER2_PN, admin: true };
const PERSON_B = { pn: IDS.MEMBER_PN, lid: IDS.MEMBER_LID };

let registry;
let db;
let help;
let menu;
let buttonmenu;

before(async () => {
  const setup = await fakes.setup();
  registry = setup.registry;
  db = setup.db;
  help = require("../plugins/help");
  menu = require("../plugins/menu");
  buttonmenu = require("../plugins/buttonmenu");
});

after(() => net.restore());

beforeEach(async () => {
  await db.PermissionRule.destroy({ where: {} });
  settingsCache.clear();
  commandPermissions.invalidate();
  invalidateGroupMetadata();
});

afterEach(() => mock.restoreAll());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a valid rule (model validators run) and drop the engine cache, as the panel does. */
async function rule(command, scope, mode, people) {
  await db.PermissionRule.create({ command, scope, mode, people });
  commandPermissions.invalidate();
}

const named = (name) => registry.getCommandByPattern(name);

/** A fresh message from `who` in `where` (PRIVATE or a group JID). */
function msg(who, where = PRIVATE, body = ".menu", extra = {}) {
  return fakes.makeMessage({ body, ...who, group: where === PRIVATE ? undefined : where, ...extra });
}

/** The legacy visibility: owner-only commands are hidden from everybody but the owners. */
function legacyVisible(message) {
  const owner = !!message.isSudo();
  return registry.getCommands().filter((cmd) => owner || !(cmd.fromMe || cmd.ownerOnly));
}

/** Send `body` through the registry; the texts the bot sent. */
async function ask(body, who, where = PRIVATE) {
  const message = msg(who, where, body);
  await registry.executeCommand(message);
  const sock = message.client.getSocket();
  return { message, sock, texts: fakes.sentTexts(sock) };
}

/** The rows of the interactive list the bot sent (and the strings around it). */
function listOf(sock) {
  const entry = sock.sent.find((s) => s.kind === "interactive");
  assert.ok(entry, "an interactive list was sent");
  const json = entry.strings.find((s) => s.startsWith("{") && s.includes('"sections"'));
  assert.ok(json, "the list parameters");
  const sections = JSON.parse(json).sections;
  return { strings: entry.strings, rows: sections[0].rows };
}

/** The category rows of the legacy `sendCategories` for a list of entries. */
function expectedCategoryRows(list) {
  const grouped = new Map();
  for (const cmd of list) {
    const type = cmd.type || "misc";
    if (!grouped.has(type)) grouped.set(type, []);
    grouped.get(type).push(cmd);
  }
  const types = [...grouped.keys()].sort((a, b) => menu.typeRank(a) - menu.typeRank(b) || a.localeCompare(b));
  return types.map((type) => ({
    id: `menu:cat:${type}`,
    title: `${menu.TYPE_ICONS[type] || menu.DEFAULT_ICON} ${help.typeLabel(type)}`.slice(0, 24),
    description: getLang("plugins.buttonmenu.cat_count", grouped.get(type).length),
  }));
}

/** The rows of `menu:cat:<type>` for a list of entries. */
function expectedCommandRows(list, type) {
  return list
    .filter((cmd) => (cmd.type || "misc") === type)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((cmd) => ({ id: `menu:cmd:${cmd.name}`, title: cmd.name.slice(0, 24), description: (cmd.desc || "").slice(0, 72) }));
}

/** Click the list row `id` as `who`. */
async function click(id, who, where = PRIVATE) {
  const message = msg(who, where, "", { interactive: { id, kind: "list" } });
  const handled = await buttonmenu.handleButtonReply(message);
  return { message, handled, sock: message.client.getSocket() };
}

/** Everything the requester sees must equal what `expected` (an entry list) gives. */
async function assertSees(who, where, expected, label) {
  const message = msg(who, where);
  const visible = await help.getVisibleCommands(message);
  assert.equal(visible.length, expected.length, `${label}: number of visible commands`);
  assert.ok(visible.every((cmd, i) => cmd === expected[i]), `${label}: same entries in the same order`);

  const shown = await ask(".menu", who, where);
  assert.deepEqual(shown.texts, [menu.buildMenu(expected)], `${label}: the menu text`);

  const categories = await ask(".bmenu", who, where);
  const list = listOf(categories.sock);
  assert.deepEqual(list.rows, expectedCategoryRows(expected), `${label}: category rows, counts and order`);
  assert.ok(
    list.strings.includes(getLang("plugins.buttonmenu.intro", config.PREFIX, expected.length)),
    `${label}: the command count of the intro`,
  );
}

const ACTORS = [
  ["the owner", OWNER],
  ["a member", C],
  ["a group admin", ADMIN],
];
const PLACES = [
  ["a private chat", PRIVATE],
  ["a group", GROUP_A],
];

// ---------------------------------------------------------------------------
// No rule: the legacy menu, byte for byte (FR-029, SC-004)
// ---------------------------------------------------------------------------

for (const [actorName, who] of ACTORS) {
  for (const [placeName, where] of PLACES) {
    test(`no rule: ${actorName} in ${placeName} sees the legacy menu and categories`, async () => {
      const message = msg(who, where);
      await assertSees(who, where, legacyVisible(message), `${actorName}/${placeName}`);
    });
  }
}

test("no rule: a member never sees the owner-only commands, the owner sees them all", async () => {
  const member = await help.getVisibleCommands(msg(C, GROUP_A));
  assert.ok(member.every((cmd) => !(cmd.fromMe || cmd.ownerOnly)));
  assert.ok(!member.includes(named("vv")) && !member.includes(named("eval")));
  const owner = await help.getVisibleCommands(msg(OWNER, GROUP_A));
  assert.equal(owner.length, registry.getCommands().length, "the owner sees every command");
});

test("no rule: the category button lists the commands of the legacy list", async () => {
  const expected = legacyVisible(msg(C, GROUP_A));
  const clicked = await click("menu:cat:ai", C, GROUP_A);
  assert.equal(clicked.handled, true);
  assert.deepEqual(listOf(clicked.sock).rows, expectedCommandRows(expected, "ai"));
});

test("rules that do not concern the requester leave the menu untouched", async () => {
  await rule("vv", GROUP_A, "extra", [PERSON_B]); // B only, in group A only
  await rule("imagen", GROUP_D, "only", [PERSON_B]); // group D only
  for (const [actorName, who] of [["the owner", OWNER], ["a member", C]]) {
    for (const [placeName, where] of [["a private chat", PRIVATE], ["group A", GROUP_A]]) {
      await assertSees(who, where, legacyVisible(msg(who, where)), `${actorName}/${placeName}`);
    }
  }
});

test("an extra rule that lists nobody changes nothing for anybody", async () => {
  await rule("imagen", "*", "extra", [PERSON_B]);
  await assertSees(C, GROUP_A, legacyVisible(msg(C, GROUP_A)), "member");
  await assertSees(B, GROUP_A, legacyVisible(msg(B, GROUP_A)), "listed member, a command that is already public");
});

// ---------------------------------------------------------------------------
// A delegated owner-only command appears for the people who may run it
// ---------------------------------------------------------------------------

/** The legacy list plus the delegated entries, in registry order. */
function legacyPlus(message, ...extras) {
  const owner = !!message.isSudo();
  return registry.getCommands().filter((cmd) => owner || !(cmd.fromMe || cmd.ownerOnly) || extras.includes(cmd));
}

test("a member granted vv in group A sees it there, not in group D nor in a private chat", async () => {
  await rule("vv", GROUP_A, "extra", [PERSON_B]);
  const vv = named("vv");

  const inA = msg(B, GROUP_A);
  await assertSees(B, GROUP_A, legacyPlus(inA, vv), "group A");
  const visible = await help.getVisibleCommands(inA);
  assert.ok(visible.includes(vv));

  await assertSees(B, GROUP_D, legacyVisible(msg(B, GROUP_D)), "group D");
  await assertSees(B, PRIVATE, legacyVisible(msg(B, PRIVATE)), "private chat");
  assert.ok(!(await help.getVisibleCommands(msg(B, GROUP_D))).includes(vv));
  assert.ok(!(await help.getVisibleCommands(msg(B, PRIVATE))).includes(vv));
});

test("a member who is not listed does not see vv in group A", async () => {
  await rule("vv", GROUP_A, "extra", [PERSON_B]);
  await assertSees(C, GROUP_A, legacyVisible(msg(C, GROUP_A)), "unlisted member");
  await assertSees(ADMIN, GROUP_A, legacyVisible(msg(ADMIN, GROUP_A)), "unlisted group admin");
});

test("a global grant shows vv everywhere to the listed member, the category count goes up", async () => {
  await rule("vv", "*", "extra", [PERSON_B]);
  const vv = named("vv");
  for (const where of [PRIVATE, GROUP_A, GROUP_D]) {
    await assertSees(B, where, legacyPlus(msg(B, where), vv), `global grant, ${where}`);
  }
  const without = expectedCategoryRows(legacyVisible(msg(B, GROUP_A))).find((row) => row.id === "menu:cat:media");
  const withGrant = listOf((await ask(".bmenu", B, GROUP_A)).sock).rows.find((row) => row.id === "menu:cat:media");
  assert.equal(without.description, getLang("plugins.buttonmenu.cat_count", 5));
  assert.equal(withGrant.description, getLang("plugins.buttonmenu.cat_count", 6));

  const clicked = await click("menu:cat:media", B, GROUP_A);
  assert.ok(listOf(clicked.sock).rows.some((row) => row.id === "menu:cmd:vv"), "vv is in its category list");
});

test("the owner's menu is the same whatever the rules say", async () => {
  await rule("vv", "*", "only", [PERSON_B]);
  await rule("imagen", "*", "only", [PERSON_B]);
  await assertSees(OWNER, GROUP_A, legacyVisible(msg(OWNER, GROUP_A)), "owner");
  await assertSees(OWNER, PRIVATE, legacyVisible(msg(OWNER, PRIVATE)), "owner in private");
});

// ---------------------------------------------------------------------------
// An `only` rule hides the command from the people it does not list
// ---------------------------------------------------------------------------

/** The legacy list for `message` without the named commands. */
function legacyWithout(message, ...names) {
  return legacyVisible(message).filter((cmd) => !names.includes(cmd.name));
}

test("an only rule hides imagen from a member: menu, categories and counts", async () => {
  await rule("imagen", "*", "only", [PERSON_B]);
  const closed = msg(C, GROUP_A);
  await assertSees(C, GROUP_A, legacyWithout(closed, "imagen"), "member in a group");
  await assertSees(C, PRIVATE, legacyWithout(msg(C, PRIVATE), "imagen"), "member in a private chat");

  const rows = listOf((await ask(".bmenu", C, GROUP_A)).sock).rows;
  assert.equal(
    rows.find((row) => row.id === "menu:cat:ai").description,
    getLang("plugins.buttonmenu.cat_count", 2),
    "the ai category counts 2 commands instead of 3",
  );

  const clicked = await click("menu:cat:ai", C, GROUP_A);
  const ids = listOf(clicked.sock).rows.map((row) => row.id);
  assert.deepEqual(ids, ["menu:cmd:gemini", "menu:cmd:gpt"]);
});

test("an only rule closes imagen to a group admin who is not listed too", async () => {
  await rule("imagen", "*", "only", [PERSON_B]);
  await assertSees(ADMIN, GROUP_A, legacyWithout(msg(ADMIN, GROUP_A), "imagen"), "group admin");
});

test("the owner and a listed member still see imagen", async () => {
  await rule("imagen", "*", "only", [PERSON_B]);
  await assertSees(OWNER, GROUP_A, legacyVisible(msg(OWNER, GROUP_A)), "owner");
  await assertSees(B, GROUP_A, legacyVisible(msg(B, GROUP_A)), "listed member");
  await assertSees(B, PRIVATE, legacyVisible(msg(B, PRIVATE)), "listed member in a private chat");
  const rows = listOf((await ask(".bmenu", B, GROUP_A)).sock).rows;
  assert.equal(rows.find((row) => row.id === "menu:cat:ai").description, getLang("plugins.buttonmenu.cat_count", 3));
});

test("a group only rule closes the command in that group alone", async () => {
  await rule("imagen", GROUP_A, "only", [PERSON_B]);
  await assertSees(C, GROUP_A, legacyWithout(msg(C, GROUP_A), "imagen"), "group A");
  await assertSees(C, GROUP_D, legacyVisible(msg(C, GROUP_D)), "group D");
  await assertSees(C, PRIVATE, legacyVisible(msg(C, PRIVATE)), "private chat");
});

test("an empty group extra rule restores the normal level against a global only rule", async () => {
  await rule("imagen", "*", "only", [PERSON_B]);
  await rule("imagen", GROUP_A, "extra", []);
  await assertSees(C, GROUP_A, legacyVisible(msg(C, GROUP_A)), "group A: normal level");
  await assertSees(C, GROUP_D, legacyWithout(msg(C, GROUP_D), "imagen"), "group D: still closed");
});

test("a category whose commands are all closed disappears", async () => {
  await rule("news", "*", "only", [PERSON_B]);
  await rule("weather", "*", "only", [PERSON_B]);
  const info = registry.getCommands().filter((cmd) => cmd.type === "info");
  assert.deepEqual(info.map((cmd) => cmd.name).sort(), ["news", "weather"], "the info category holds exactly these two");

  const expected = legacyWithout(msg(C, GROUP_A), "news", "weather");
  await assertSees(C, GROUP_A, expected, "member");
  const rows = listOf((await ask(".bmenu", C, GROUP_A)).sock).rows;
  assert.ok(!rows.some((row) => row.id === "menu:cat:info"), "no row for the category");
  const text = (await ask(".menu", C, GROUP_A)).texts[0];
  assert.ok(!text.includes(`*${help.typeLabel("info")}*`), "no title in the menu text");

  // the stale button of that category answers like an unknown one
  const clicked = await click("menu:cat:info", C, GROUP_A);
  assert.equal(clicked.handled, true);
  assert.deepEqual(fakes.sentTexts(clicked.sock), [getLang("plugins.buttonmenu.not_found", "info")]);

  // the owner and the listed member keep it
  await assertSees(OWNER, GROUP_A, legacyVisible(msg(OWNER, GROUP_A)), "owner");
  await assertSees(B, GROUP_A, legacyVisible(msg(B, GROUP_A)), "listed member");
});

// ---------------------------------------------------------------------------
// A failed rule load: the no-rule menu (FR-011, FR-029)
// ---------------------------------------------------------------------------

test("a failed rule load gives the no-rule menu, the owner-only commands stay hidden", async () => {
  await rule("imagen", "*", "only", [PERSON_B]);
  await rule("vv", "*", "extra", [PERSON_B]);
  settingsCache.clear();
  commandPermissions.invalidate();
  mock.method(db.PermissionRule, "findAll", async () => {
    throw new Error("database is down");
  });

  await assertSees(C, GROUP_A, legacyVisible(msg(C, GROUP_A)), "member, cold failed load");
  await assertSees(B, GROUP_A, legacyVisible(msg(B, GROUP_A)), "listed member, cold failed load");
  await assertSees(OWNER, GROUP_A, legacyVisible(msg(OWNER, GROUP_A)), "owner");
  const visible = await help.getVisibleCommands(msg(B, GROUP_A));
  assert.ok(!visible.includes(named("vv")), "no grant without the rules");
});

// ===========================================================================
// Part B: the lookups by name (`.help <command>`, `.bmenu <command>`, the menu:cmd:<name> button)
// ===========================================================================

const card = (name) => help.formatCommandInfo(named(name));
const helpNotFound = (name) => getLang("plugins.help.not_found", name, config.PREFIX);
const bmenuNotFound = (name) => getLang("plugins.buttonmenu.not_found", name);

/** What each lookup answers `who` for the command `name`. */
async function lookups(name, who, where = PRIVATE) {
  const viaHelp = await ask(`.help ${name}`, who, where);
  const viaBmenu = await ask(`.bmenu ${name}`, who, where);
  const clicked = await click(`menu:cmd:${name}`, who, where);
  return {
    help: viaHelp.texts,
    bmenu: viaBmenu.texts,
    button: fakes.sentTexts(clicked.sock),
    handled: clicked.handled,
  };
}

/** The three lookups answer with the help card. */
function assertCard(found, name, label) {
  assert.deepEqual(found.help, [card(name)], `${label}: .help ${name}`);
  assert.deepEqual(found.bmenu, [card(name)], `${label}: .bmenu ${name}`);
  assert.deepEqual(found.button, [card(name)], `${label}: the menu:cmd:${name} button`);
  assert.equal(found.handled, true, `${label}: the button reply is consumed`);
}

/** The three lookups answer like an unknown command. */
function assertUnknown(found, name, label) {
  assert.deepEqual(found.help, [helpNotFound(name)], `${label}: .help ${name}`);
  assert.deepEqual(found.bmenu, [bmenuNotFound(name)], `${label}: .bmenu ${name}`);
  assert.deepEqual(found.button, [bmenuNotFound(name)], `${label}: the menu:cmd:${name} button`);
  assert.equal(found.handled, true, `${label}: the button reply is consumed`);
}

test("findVisibleCommand is exported next to the other helpers", () => {
  assert.equal(typeof help.findVisibleCommand, "function");
  for (const name of ["formatCommandInfo", "getVisibleCommands", "isOwnerOnly", "typeLabel"]) {
    assert.equal(typeof help[name], "function", name);
  }
});

test("no rule: .help eval from a member still returns the card (FR-029: only closed commands are hidden)", async () => {
  for (const [placeName, where] of PLACES) {
    assertCard(await lookups("eval", C, where), "exec", `member in ${placeName}`);
    assertCard(await lookups("eval", ADMIN, where), "exec", `group admin in ${placeName}`);
  }
  assert.ok(card("exec").includes(getLang("plugins.help.access_owner")), "the card says owner");
  assertCard(await lookups("vv", C, GROUP_A), "vv", "an owner-only command that is not delegated");
});

test("no rule: the cards of public commands are served to everybody, as today", async () => {
  for (const who of [OWNER, B, C, ADMIN]) {
    assertCard(await lookups("imagen", who, GROUP_A), "imagen", "imagen");
    assertCard(await lookups("ping", who, PRIVATE), "ping", "ping");
  }
});

test("no rule: an unknown command answers plugins.help.not_found / plugins.buttonmenu.not_found", async () => {
  assertUnknown(await lookups("nosuchcommand", C, GROUP_A), "nosuchcommand", "member");
  assertUnknown(await lookups("nosuchcommand", OWNER, GROUP_A), "nosuchcommand", "owner");
  assert.deepEqual((await ask(".help", C, GROUP_A)).texts, [getLang("plugins.help.guide", config.PREFIX)], "no name: the guide");
});

test("the prefix and the case of the name are still accepted", async () => {
  await rule("imagen", "*", "only", [PERSON_B]);
  assert.deepEqual((await ask(".help .IMAGEN", C, GROUP_A)).texts, [helpNotFound("imagen")], "closed, written with prefix and caps");
  assert.deepEqual((await ask(".help .IMAGEN", B, GROUP_A)).texts, [card("imagen")], "listed");
  assert.deepEqual((await ask(".help .EVAL", C, GROUP_A)).texts, [card("exec")], "an alias of an owner-only command");
});

test("an only rule on imagen: a closed member gets the not-found answers", async () => {
  await rule("imagen", "*", "only", [PERSON_B]);
  assertUnknown(await lookups("imagen", C, GROUP_A), "imagen", "member in a group");
  assertUnknown(await lookups("imagen", C, PRIVATE), "imagen", "member in a private chat");
  assertUnknown(await lookups("imagen", ADMIN, GROUP_A), "imagen", "group admin");
  // the same text as a command that does not exist, nothing tells that the command is hidden
  assert.equal(helpNotFound("imagen"), getLang("plugins.help.not_found", "imagen", "."));
});

test("an only rule on imagen: the owner and a listed member still get the card", async () => {
  await rule("imagen", "*", "only", [PERSON_B]);
  assertCard(await lookups("imagen", OWNER, GROUP_A), "imagen", "owner");
  assertCard(await lookups("imagen", B, GROUP_A), "imagen", "listed member");
  assertCard(await lookups("imagen", B, PRIVATE), "imagen", "listed member in a private chat");
});

test("a group only rule closes the lookups in that group alone", async () => {
  await rule("imagen", GROUP_A, "only", [PERSON_B]);
  assertUnknown(await lookups("imagen", C, GROUP_A), "imagen", "group A");
  assertCard(await lookups("imagen", C, GROUP_D), "imagen", "group D");
  assertCard(await lookups("imagen", C, PRIVATE), "imagen", "private chat");
});

test("closing one command leaves the other cards alone", async () => {
  await rule("imagen", "*", "only", [PERSON_B]);
  assertCard(await lookups("gpt", C, GROUP_A), "gpt", "gpt");
  assertCard(await lookups("eval", C, GROUP_A), "exec", "eval");
});

test("a rule on a non-delegable command never hides it: .help eval keeps returning the card", async () => {
  // a restored backup or a hand-made row: the engine ignores it, the card stays (FR-014, FR-029)
  await rule("exec", "*", "only", [PERSON_B]);
  await rule("exec", GROUP_A, "only", [PERSON_B]);
  assertCard(await lookups("eval", C, GROUP_A), "exec", "member");
  assertCard(await lookups("eval", B, GROUP_A), "exec", "listed member");
  assertCard(await lookups("eval", OWNER, GROUP_A), "exec", "owner");
});

test("a grant on vv does not change the lookups", async () => {
  await rule("vv", GROUP_A, "extra", [PERSON_B]);
  assertCard(await lookups("vv", B, GROUP_A), "vv", "granted member");
  assertCard(await lookups("vv", C, GROUP_A), "vv", "unlisted member");
});

test("a failed rule load gives today's lookups", async () => {
  await rule("imagen", "*", "only", [PERSON_B]);
  settingsCache.clear();
  commandPermissions.invalidate();
  mock.method(db.PermissionRule, "findAll", async () => {
    throw new Error("database is down");
  });
  assertCard(await lookups("imagen", C, GROUP_A), "imagen", "member, cold failed load");
  assertCard(await lookups("eval", C, GROUP_A), "exec", "eval");
  assertUnknown(await lookups("nosuchcommand", C, GROUP_A), "nosuchcommand", "unknown");
});

test("findVisibleCommand: the entry, or null for an unknown or a closed command, never for an owner-only one", async () => {
  await rule("imagen", "*", "only", [PERSON_B]);
  const asMember = msg(C, GROUP_A);
  assert.equal(await help.findVisibleCommand(asMember, "imagen"), null, "closed");
  assert.equal(await help.findVisibleCommand(asMember, "nosuchcommand"), null, "unknown");
  assert.equal(await help.findVisibleCommand(asMember, "gpt"), named("gpt"), "open");
  assert.equal(await help.findVisibleCommand(asMember, "eval"), named("exec"), "owner-only, by alias: still found");
  assert.equal(await help.findVisibleCommand(msg(B, GROUP_A), "imagen"), named("imagen"), "listed");
  assert.equal(await help.findVisibleCommand(msg(OWNER, GROUP_A), "imagen"), named("imagen"), "owner");
});
