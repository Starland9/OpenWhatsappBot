"use strict";
/**
 * The commands view, pure logic (specs/002-admin-panel T128): lib/admin/public/js/views/commands-logic.mjs.
 *
 *  - search across name, alias and description (accent- and case-insensitive, a leading prefix is ignored);
 *  - category filter, alone and with the search;
 *  - the scope editor: adding and removing groups, and the `disable`/`enable` lists of the CMD-2 body;
 *  - the lockout warning for unban/ban, the orphan rows, the view files themselves load.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const VIEWS = path.resolve(__dirname, "..", "lib", "admin", "public", "js", "views");
const load = (file) => import(pathToFileURL(path.join(VIEWS, file)).href);

const A = "120363000000000001@g.us";
const B = "120363000000000002@g.us";
const C = "120363000000000003-1600000000@g.us";

const command = (name, over = {}) => ({
  name,
  aliases: [name],
  type: "general",
  desc: `desc of ${name}`,
  access: { owner: false, admin: false, group: false, pm: false },
  disabledGlobal: false,
  disabledGroups: [],
  ...over,
});

const COMMANDS = [
  command("ping", { desc: "Mesurer la latence du bot" }),
  command("sticker", { aliases: ["sticker", "s", "stk"], type: "media", desc: "Créer un sticker à partir d'une image" }),
  command("kick", { aliases: ["kick", "remove"], type: "group", desc: "Retirer un membre du groupe", access: { owner: false, admin: true, group: true, pm: false } }),
  command("unban", { type: "owner", desc: "Réactiver le bot dans une discussion", access: { owner: true, admin: false, group: false, pm: false } }),
  command("ban", { type: "owner", desc: "Désactiver le bot dans une discussion", access: { owner: true, admin: false, group: false, pm: false } }),
];
const names = (list) => list.map((c) => c.name);

test("search matches the name, any alias and the description", async () => {
  const { searchCommands } = await load("commands-logic.mjs");
  assert.deepEqual(names(searchCommands(COMMANDS, "ping")), ["ping"]);
  assert.deepEqual(names(searchCommands(COMMANDS, "stk")), ["sticker"], "an alias that is not the name");
  assert.deepEqual(names(searchCommands(COMMANDS, "remove")), ["kick"]);
  assert.deepEqual(names(searchCommands(COMMANDS, "latence")), ["ping"], "the description");
  assert.deepEqual(names(searchCommands(COMMANDS, "discussion")), ["unban", "ban"], "several matches keep the order");
  assert.deepEqual(names(searchCommands(COMMANDS, "zzz-nothing")), []);
});

test("search ignores case, accents, blanks and a leading prefix; an empty query keeps everything", async () => {
  const { searchCommands } = await load("commands-logic.mjs");
  assert.deepEqual(names(searchCommands(COMMANDS, "STICKER")), ["sticker"]);
  assert.deepEqual(names(searchCommands(COMMANDS, "creer")), ["sticker"], "Créer found without the accent");
  assert.deepEqual(names(searchCommands(COMMANDS, "Réactiver")), ["unban"]);
  assert.deepEqual(names(searchCommands(COMMANDS, "  .ping  ")), ["ping"], "the prefix typed by habit");
  assert.deepEqual(names(searchCommands(COMMANDS, "!kick")), ["kick"]);
  assert.equal(searchCommands(COMMANDS, "").length, COMMANDS.length);
  assert.equal(searchCommands(COMMANDS, "   ").length, COMMANDS.length);
  assert.equal(searchCommands(COMMANDS, undefined).length, COMMANDS.length);
  assert.deepEqual(searchCommands(undefined, "x"), []);
});

test("category filter, alone and combined with the search", async () => {
  const { filterByType, filterCommands } = await load("commands-logic.mjs");
  assert.deepEqual(names(filterByType(COMMANDS, "owner")), ["unban", "ban"]);
  assert.equal(filterByType(COMMANDS, "").length, COMMANDS.length);
  assert.equal(filterByType(COMMANDS, "all").length, COMMANDS.length);
  assert.deepEqual(filterByType(COMMANDS, "nope"), []);
  assert.deepEqual(names(filterCommands(COMMANDS, { query: "ban", type: "owner" })), ["unban", "ban"]);
  assert.deepEqual(names(filterCommands(COMMANDS, { query: "ban", type: "media" })), []);
  assert.deepEqual(names(filterCommands(COMMANDS, { query: "retirer", type: "group" })), ["kick"]);
  assert.equal(filterCommands(COMMANDS).length, COMMANDS.length, "no filter at all");
});

test("access levels, state and the summary of the list", async () => {
  const { accessLevels, stateOf, summarize } = await load("commands-logic.mjs");
  assert.deepEqual(accessLevels(COMMANDS[0]), [], "open to everybody");
  assert.deepEqual(accessLevels(COMMANDS[2]), ["admin", "group"]);
  assert.deepEqual(accessLevels({ access: { pm: true, owner: true } }), ["owner", "pm"], "display order, not key order");

  assert.deepEqual(stateOf(command("a")), { state: "enabled", groups: 0 });
  assert.deepEqual(stateOf(command("a", { disabledGroups: [A, B] })), { state: "groups", groups: 2 });
  assert.deepEqual(stateOf(command("a", { disabledGlobal: true, disabledGroups: [A] })), { state: "global", groups: 1 }, "global wins");

  const list = [command("a"), command("b", { disabledGlobal: true }), command("c", { disabledGroups: [A] }), command("d", { disabledGlobal: true, disabledGroups: [B] })];
  assert.deepEqual(summarize(list), { total: 4, offGlobal: 2, offGroups: 1 });
  assert.deepEqual(summarize(undefined), { total: 0, offGlobal: 0, offGroups: 0 });
});

test("a group typed in the editor: a JID or a bare numeric id, nothing else", async () => {
  const { parseGroupJid } = await load("commands-logic.mjs");
  assert.deepEqual(parseGroupJid(A), { ok: true, jid: A });
  assert.deepEqual(parseGroupJid(`  ${A}  `), { ok: true, jid: A });
  assert.deepEqual(parseGroupJid(C), { ok: true, jid: C }, "the old creator-timestamp form");
  assert.deepEqual(parseGroupJid("120363000000000001"), { ok: true, jid: A }, "the suffix is added");
  assert.deepEqual(parseGroupJid("120363000000000003-1600000000"), { ok: true, jid: C });
  assert.deepEqual(parseGroupJid(""), { ok: false, code: "required" });
  assert.deepEqual(parseGroupJid("   "), { ok: false, code: "required" });
  for (const bad of ["*", "all", "333@s.whatsapp.net", "abc@g.us", "@g.us", "12 34@g.us", "1203@g.us.evil", "120363000000000001@lid"]) {
    assert.deepEqual(parseGroupJid(bad), { ok: false, code: "invalid_jid" }, bad);
  }
});

test("scope editor: adding keeps the list sorted and refuses a duplicate or a bad id; removing and the global switch", async () => {
  const { draftOf, addGroup, removeGroup, setGlobal } = await load("commands-logic.mjs");
  const start = draftOf(command("kick", { disabledGroups: [B, A] }));
  assert.deepEqual(start, { global: false, groups: [A, B] }, "sorted copy of the server state");

  const added = addGroup(start, C);
  assert.equal(added.error, null);
  assert.deepEqual(added.draft.groups, [A, B, C]);
  assert.deepEqual(start.groups, [A, B], "the previous draft is not mutated");

  const duplicate = addGroup(added.draft, A);
  assert.deepEqual(duplicate.error, { code: "duplicate" });
  assert.equal(duplicate.draft, added.draft);
  assert.deepEqual(addGroup(start, "nope").error, { code: "invalid_jid" });
  assert.deepEqual(addGroup(start, "").error, { code: "required" });

  const full = { global: false, groups: Array.from({ length: 500 }, (_, i) => `1203630000${String(i + 1).padStart(8, "0")}@g.us`) };
  assert.deepEqual(addGroup(full, C).error, { code: "too_many_items", params: { max: 500 } });

  assert.deepEqual(removeGroup(added.draft, B).groups, [A, C]);
  assert.deepEqual(removeGroup(added.draft, "other@g.us").groups, [A, B, C]);
  assert.deepEqual(setGlobal(start, true), { global: true, groups: [A, B] });
  assert.deepEqual(setGlobal(setGlobal(start, true), false), start);
});

test("building the disable/enable lists from the editor: only what changed, set-based", async () => {
  const { draftOf, addGroup, removeGroup, setGlobal, diffScopes, isDirty, toggleBody } = await load("commands-logic.mjs");
  const kick = command("kick", { disabledGroups: [A, B] });

  // untouched
  assert.deepEqual(diffScopes(kick, draftOf(kick)), { disable: [], enable: [] });
  assert.equal(isDirty(kick, draftOf(kick)), false);
  assert.equal(toggleBody(diffScopes(kick, draftOf(kick))), null, "nothing to send");

  // remove A, add C, switch off everywhere
  let draft = draftOf(kick);
  draft = removeGroup(draft, A);
  draft = addGroup(draft, C).draft;
  draft = setGlobal(draft, true);
  assert.deepEqual(diffScopes(kick, draft), { disable: ["*", C], enable: [A] });
  assert.equal(isDirty(kick, draft), true);
  assert.deepEqual(toggleBody(diffScopes(kick, draft)), { disable: ["*", C], enable: [A] });

  // a list that is empty is left out of the body
  assert.deepEqual(toggleBody({ disable: [], enable: [B] }), { enable: [B] });
  assert.deepEqual(toggleBody({ disable: [B], enable: [] }), { disable: [B] });
  assert.equal(toggleBody({ disable: [], enable: [] }), null);
  assert.equal(toggleBody({}), null);

  // a scope never lands in both lists, whatever the editing path
  const wasGlobal = command("kick", { disabledGlobal: true, disabledGroups: [A] });
  const back = setGlobal(removeGroup(draftOf(wasGlobal), A), false);
  const change = diffScopes(wasGlobal, back);
  assert.deepEqual(change, { disable: [], enable: ["*", A] });
  assert.ok(!change.disable.some((scope) => change.enable.includes(scope)));

  // adding then removing the same group is not a change
  assert.deepEqual(diffScopes(kick, removeGroup(addGroup(draftOf(kick), C).draft, C)), { disable: [], enable: [] });
  // removing then adding back is not a change either
  assert.deepEqual(diffScopes(kick, addGroup(removeGroup(draftOf(kick), A), A).draft), { disable: [], enable: [] });
});

test("lockout warning: only when a change disables unban or ban", async () => {
  const { lockoutWarning, warningKeys } = await load("commands-logic.mjs");
  const unban = COMMANDS.find((c) => c.name === "unban");
  const ban = COMMANDS.find((c) => c.name === "ban");
  const ping = COMMANDS.find((c) => c.name === "ping");

  assert.equal(lockoutWarning(unban, { disable: ["*"] }), "commands.warn_unban");
  assert.equal(lockoutWarning(ban, { disable: [A], enable: [B] }), "commands.warn_ban");
  assert.equal(lockoutWarning(unban, { enable: ["*"] }), null, "enabling can never lock anybody out");
  assert.equal(lockoutWarning(unban, { disable: [], enable: [A] }), null);
  assert.equal(lockoutWarning(ping, { disable: ["*"] }), null);
  assert.equal(lockoutWarning(ping, null), null);

  assert.deepEqual(warningKeys(["unban_disabled", "banchat_disabled"]), ["commands.warn_unban", "commands.warn_ban"]);
  assert.deepEqual(warningKeys(["something_new"]), [], "an unknown warning is ignored, not shown as a raw code");
  assert.deepEqual(warningKeys(undefined), []);
});

test("orphan rows are grouped by command and sorted", async () => {
  const { groupOrphans, shortJid } = await load("commands-logic.mjs");
  assert.deepEqual(groupOrphans([]), []);
  assert.deepEqual(groupOrphans(undefined), []);
  assert.deepEqual(
    groupOrphans([
      { command: "zeta", scope: B },
      { command: "alpha", scope: "*" },
      { command: "zeta", scope: A },
    ]),
    [
      { command: "alpha", scopes: ["*"] },
      { command: "zeta", scopes: [A, B] },
    ],
  );
  assert.equal(shortJid(A), "120363000000000001");
  assert.equal(shortJid(undefined), "");
});

test("the view files import and default-export a component with the area's meta", async () => {
  const view = await load("commands.mjs");
  assert.equal(typeof view.default, "function");
  assert.deepEqual(view.meta, { area: "commands", titleKey: "commands.title", icon: "commands" });
  assert.equal(typeof (await load("commands-editor.mjs")).ScopeEditor, "function");
  assert.equal(typeof (await load("commands-orphans.mjs")).OrphanRows, "function");
});
