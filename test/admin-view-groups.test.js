"use strict";
/**
 * Pure logic of the groups area of the panel (US6): lib/admin/public/js/views/groups-logic.mjs.
 *
 *  - the client-side detection of unknown @variables mirrors the server grammar (same answer as
 *    lib/admin/services/groups.js `findUnknownVariables` on a fixed corpus and on generated strings), and the
 *    preview rendering mirrors plugins/setwelcome.js `renderTemplate`;
 *  - template limits (1 to 1000 characters) and the GRP-4 bodies: only what changed, the switch and the text
 *    are independent, `null` resets;
 *  - filter limits (pattern 100, response 1000, 50 per group), duplicates by normalised pattern, the GRP-8 / GRP-9 body;
 *  - GRD-1 body, GRP-13 body, GRP-17 body, the GRP-1 query and the helpers behind the tables.
 *
 * No DOM: the module is imported as is.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { findUnknownVariables: serverUnknownVariables } = require("../lib/admin/services/groups");
const { renderTemplate: pluginRenderTemplate } = require("../plugins/setwelcome");
const { normalizePattern: pluginNormalizePattern } = require("../plugins/addfilter");

let L;

before(async () => {
  L = await import(pathToFileURL(path.join(__dirname, "..", "lib", "admin", "public", "js", "views", "groups-logic.mjs")).href);
});

// A fixed corpus plus strings built from a small alphabet of the characters that matter to the grammar
const CORPUS = [
  "",
  "plain text",
  "@user",
  "@USER @Group @DeSc",
  "Welcome @user to @group (@desc)!",
  "@users",
  "@user1",
  "@everyone",
  "@Foo, @FOO and @foo",
  "a@b.com",
  "x_y@z.fr",
  "a.@b",
  "_@e",
  "1@f",
  "(@x)",
  "@",
  "@@user",
  "@ user",
  "50% @ home",
  "@237600000001 is here",
  "@user's @group.",
  "line one\n@oops\nline three",
  "@é",
  "@ab_cd",
  "mail me: john.doe@example.org, @john",
  "@desc@group@user",
];

function generated(count) {
  const alphabet = ["@", "@", "user", "group", "desc", "x", "A", " ", ".", "_", "1", "\n", "é", "-"];
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  return Array.from({ length: count }, () => Array.from({ length: 2 + (next() % 12) }, () => alphabet[next() % alphabet.length]).join(""));
}

test("unknown @variables: the browser finds exactly what the server refuses", () => {
  for (const text of [...CORPUS, ...generated(400)]) {
    assert.deepEqual(L.findUnknownVariables(text), serverUnknownVariables(text), JSON.stringify(text));
  }
  assert.deepEqual(L.findUnknownVariables("Hi @user, see @Foo and @bar and @foo"), ["@foo", "@bar"]);
  assert.deepEqual(L.findUnknownVariables("a.@b @c_d _@e 1@f"), ["@c"]);
  assert.deepEqual(L.findUnknownVariables(undefined), []);
  assert.deepEqual([...L.VARIABLES], ["@user", "@group", "@desc"]);
});

test("the preview renders like plugins/setwelcome.js: one pass, case-insensitive, unknown names left as typed", () => {
  const vars = { user: "@member", group: "Chess club", desc: "Weekly games" };
  for (const text of [...CORPUS, "@user @user", "@GROUP", "@group is @user", "@desc"]) {
    assert.equal(L.renderTemplate(text, vars), pluginRenderTemplate(text, vars), JSON.stringify(text));
  }
  // a value that looks like a variable is not substituted again
  assert.equal(L.renderTemplate("@group", { group: "@user", user: "X" }), "@user");
  // missing variables stay
  assert.equal(L.renderTemplate("@user @desc", { user: "A" }), "A @desc");
});

test("validateTemplate: 1 to 1000 characters, no unknown variable; the answer is a field error", () => {
  assert.deepEqual(L.validateTemplate("Hello @user"), { ok: true, error: null });
  assert.deepEqual(L.validateTemplate("x".repeat(1000)), { ok: true, error: null });
  assert.deepEqual(L.validateTemplate("x".repeat(1001)).error, { code: "too_long", params: { max: 1000 } });
  assert.deepEqual(L.validateTemplate("").error, { code: "too_short", params: { min: 1 } });
  assert.deepEqual(L.validateTemplate("   \n ").error, { code: "too_short", params: { min: 1 } }, "blank is empty");
  assert.deepEqual(L.validateTemplate("Hi @Nobody @user @nobody").error, { code: "unknown_variable", params: { names: ["@nobody"] } });
  assert.deepEqual(L.validateTemplate("x".repeat(40), 30).error, { code: "too_long", params: { max: 30 } }, "the limit comes from GRP-3");
  assert.equal(L.validateTemplate("😀".repeat(1000)).ok, true, "characters, not UTF-16 units");
  assert.equal(L.validateTemplate("😀".repeat(1001)).ok, false);
  assert.deepEqual({ ...L.LIMITS }, { messageMax: 1000, filtersMax: 50, patternMax: 100, responseMax: 1000 });
});

const group = (extra = {}) => ({
  jid: "120363000000000001@g.us",
  name: "Chess club",
  welcome: { enabled: false, message: "Default welcome @user", custom: false },
  goodbye: { enabled: true, message: "Bye @user", custom: true },
  antilink: false,
  antibot: false,
  mute: false,
  warnings: [],
  ...extra,
});

test("GRP-4 bodies: only what changed; the switch and the text never drag each other; null resets", () => {
  const g = group();
  assert.deepEqual(L.templateDraft(g, "welcome"), { enabled: false, message: "Default welcome @user" });
  assert.deepEqual(L.templateDraft({}, "welcome"), { enabled: false, message: "" }, "a group not loaded yet");

  // nothing changed (surrounding spaces do not count)
  assert.equal(L.templateBody(g, "welcome", { enabled: false, message: "  Default welcome @user  " }), null);
  assert.equal(L.templateDirty(g, "welcome", { enabled: false, message: "Default welcome @user " }), false);

  assert.deepEqual(L.templateBody(g, "welcome", { enabled: true, message: "Default welcome @user" }), { welcome: { enabled: true } });
  assert.deepEqual(L.templateBody(g, "welcome", { enabled: false, message: " New text @group " }), { welcome: { message: "New text @group" } });
  assert.deepEqual(L.templateBody(g, "goodbye", { enabled: false, message: "Bye @user" }), { goodbye: { enabled: false } });
  assert.deepEqual(L.templateBody(g, "goodbye", { enabled: true, message: "See you" }), { goodbye: { message: "See you" } });
  assert.deepEqual(L.templateBody(g, "welcome", { enabled: true, message: "Both" }), { welcome: { enabled: true, message: "Both" } });
  assert.equal(L.templateDirty(g, "welcome", { enabled: true, message: "Default welcome @user" }), true);

  assert.deepEqual(L.resetBody("welcome"), { welcome: { message: null } });
  assert.deepEqual(L.resetBody("goodbye"), { goodbye: { message: null } });

  assert.equal(L.appendVariable("", "@user"), "@user");
  assert.equal(L.appendVariable("Hello", "@user"), "Hello @user");
  assert.equal(L.appendVariable("Hello ", "@group"), "Hello @group");
  assert.equal(L.appendVariable("Hello\n", "@desc"), "Hello\n@desc");
  assert.deepEqual(L.previewLines("a\r\nb\n\nc"), ["a", "b", "", "c"]);
});

test("validateFilter: pattern 1 to 100 after whitespace collapse, response 1 to 1000, duplicates ignore case and spacing", () => {
  const ok = (pattern, response, others, options) => L.validateFilter({ pattern, response }, others, options);
  assert.equal(ok("hello", "hi", []).ok, true);
  assert.equal(ok("p".repeat(100), "r".repeat(1000), []).ok, true);
  assert.deepEqual(ok("p".repeat(101), "r", []).fields.pattern, { code: "too_long", params: { max: 100 } });
  assert.deepEqual(ok("p", "r".repeat(1001), []).fields.response, { code: "too_long", params: { max: 1000 } });
  assert.deepEqual(ok("   ", "r", []).fields.pattern, { code: "too_short", params: { min: 1 } });
  assert.deepEqual(ok("p", " \n ", []).fields.response, { code: "too_short", params: { min: 1 } });
  assert.equal(ok(`${"a ".repeat(30)}${" ".repeat(60)}b`, "r", []).ok, true, "spaces collapse before the length is counted");
  assert.equal(ok("😀".repeat(100), "r", []).ok, true, "characters, not UTF-16 units");

  // duplicates, as the server normalises them
  const others = [{ id: 1, pattern: "Good Morning" }, { id: 2, pattern: "bye" }];
  assert.deepEqual(ok(" good   MORNING ", "r", others).fields.pattern, { code: "duplicate" });
  assert.equal(ok("good evening", "r", others).ok, true);
  assert.equal(ok("GOOD morning", "r", others, { editingId: 1 }).ok, true, "a filter is not the duplicate of itself");
  assert.deepEqual(ok("bye", "r", others, { editingId: 1 }).fields.pattern, { code: "duplicate" });
  for (const text of ["Hello   World", " hello world ", "HELLO WORLD"]) {
    assert.equal(L.normalizePattern(text), pluginNormalizePattern(text), text);
  }

  // 50 per group (adding only; editing never grows the list)
  const fifty = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, pattern: `word ${i}` }));
  const full = ok("one more", "r", fifty);
  assert.equal(full.limit, true);
  assert.equal(full.ok, false);
  assert.deepEqual(full.fields, {});
  assert.equal(ok("one more", "r", fifty.slice(0, 49)).ok, true);
  assert.equal(ok("renamed", "r", fifty, { editingId: 7 }).ok, true);
  assert.equal(ok("one more", "r", fifty, { limits: { ...L.LIMITS, filtersMax: 60 } }).ok, true, "the limit comes from the server");

  assert.deepEqual(L.filterBody({ pattern: "  Hello    World ", response: "  Hi there \n" }), { pattern: "Hello World", response: "Hi there" });
  assert.equal(L.squash("  a \n\t b  "), "a b");
  assert.equal(L.excerpt("short"), "short");
  assert.equal(L.excerpt("x".repeat(200), 10), `${"x".repeat(9)}…`);
  assert.equal(L.excerpt("a\n\n  b"), "a b");
});

test("GRD-1, GRP-13, GRP-17 bodies and the warning helpers", () => {
  assert.deepEqual(L.guardBody("antilink", true), { antilink: true });
  assert.deepEqual(L.guardBody("antibot", false), { antibot: false });
  assert.deepEqual(L.guardBody("antibot", 1), { antibot: true });

  assert.deepEqual(L.roleBody("regular", "vip"), { role: "vip" });
  assert.equal(L.roleBody("vip", "vip"), null, "no change, no request");
  assert.equal(L.roleBody("vip", "owner"), null, "not a role");
  assert.deepEqual([...L.ROLES], ["regular", "vip", "muted", "banned"]);

  assert.deepEqual(L.commandBody("ping", true), { disable: ["ping"] });
  assert.deepEqual(L.commandBody("ping", false), { enable: ["ping"] });

  assert.equal(L.warningKey("bot_not_admin"), "groups.warning_bot_not_admin");
  assert.equal(L.hasWarning(group({ warnings: ["bot_not_admin"] }), "bot_not_admin"), true);
  assert.equal(L.hasWarning(group(), "bot_not_admin"), false);
  assert.equal(L.hasWarning(null, "bot_not_admin"), false);
});

test("commands: search, state (global wins over the group), lock-out confirmations", () => {
  const commands = [
    { name: "ping", aliases: ["ping"], desc: "Latency" },
    { name: "unban", aliases: ["unban"], desc: "Reactivate the bot", disabledGlobal: true },
    { name: "sticker", aliases: ["sticker", "s"], desc: "Make a sticker", disabledGroups: ["G1"] },
  ];
  assert.deepEqual(L.filterCommands(commands, "").map((c) => c.name), ["ping", "unban", "sticker"]);
  assert.deepEqual(L.filterCommands(commands, ".PIN").map((c) => c.name), ["ping"], "prefix and case ignored");
  assert.deepEqual(L.filterCommands(commands, "make").map((c) => c.name), ["sticker"], "the description counts");
  assert.deepEqual(L.filterCommands(commands, "nothing"), []);

  assert.equal(L.commandState(commands[0], "G1", []), "on");
  assert.equal(L.commandState(commands[0], "G1", ["ping"]), "group");
  assert.equal(L.commandState(commands[1], "G1", ["unban"]), "global");
  assert.equal(L.commandState(commands[2], "G1", []), "group");
  assert.equal(L.commandState(commands[2], "G2", []), "on");

  assert.equal(L.lockoutKey("unban"), "groups.lockout_unban");
  assert.equal(L.lockoutKey("ban"), "groups.lockout_ban");
  assert.equal(L.lockoutKey("ping"), null);
  assert.equal(L.lockoutKey("toString"), null);
});

test("GRP-1 query, row badges and features, tabs", () => {
  assert.deepEqual(L.listQuery(), { pageSize: 25 });
  assert.deepEqual(L.listQuery({ page: 3, q: "  chess  ", status: "former" }), { pageSize: 25, page: 3, q: "chess", status: "former" });
  assert.deepEqual(L.listQuery({ page: 1, q: "", status: "all" }), { pageSize: 25 }, "defaults are left out");
  assert.deepEqual(L.listQuery({ status: "archived" }), { pageSize: 25 }, "an unknown status is dropped");
  assert.equal(L.listQuery({ q: "x".repeat(300) }).q.length, 100);

  assert.deepEqual(L.rowBadges({ former: true, botIsAdmin: null }), [{ id: "former", tone: "neutral" }]);
  assert.deepEqual(L.rowBadges({ former: false, botIsAdmin: true, disabled: true }), [{ id: "bot_admin", tone: "ok" }, { id: "disabled", tone: "danger" }]);
  assert.deepEqual(L.rowBadges({ former: false, botIsAdmin: false }), [{ id: "bot_not_admin", tone: "warn" }]);
  assert.deepEqual(L.rowBadges({ former: false, botIsAdmin: null }), [], "unknown shows nothing");
  assert.deepEqual(L.rowFeatures({ welcome: true, goodbye: false, antilink: true, mute: true }), ["welcome", "antilink", "mute"]);
  assert.deepEqual(L.rowFeatures({}), []);

  assert.equal(L.tabOf("filters"), "filters");
  assert.equal(L.tabOf("nope"), "messages");
  assert.equal(L.tabOf(undefined, L.LIST_TABS), "groups");
  assert.equal(L.tabOf("disabled", L.LIST_TABS), "disabled");
});

test("members: short numbers, search, sort and client-side paging", () => {
  assert.equal(L.shortJid("237600000002@s.whatsapp.net"), "+237600000002");
  assert.equal(L.shortJid("237600000002:12@s.whatsapp.net"), "+237600000002", "device suffix dropped");
  assert.equal(L.shortJid("99000000002@lid"), "@99000000002");
  assert.equal(L.shortJid("status@broadcast"), "status@broadcast");
  assert.equal(L.shortJid(undefined), "");

  const members = [
    { jid: "237600000003@s.whatsapp.net", admin: null, role: "regular" },
    { jid: "237600000002@s.whatsapp.net", admin: "admin", role: "regular" },
    { jid: "237600000009@s.whatsapp.net", admin: null, role: "banned" },
    { jid: "237600000001@s.whatsapp.net", admin: null, role: "regular" },
    { jid: "237600000004@s.whatsapp.net", admin: null, role: "vip" },
  ];
  assert.deepEqual(
    L.sortMembers(members).map((m) => m.jid.slice(0, 12)),
    ["237600000004", "237600000009", "237600000002", "237600000001", "237600000003"],
    "members with a role first, then admins, then the rest by number",
  );
  assert.deepEqual(L.filterMembers(members, "+2376000000").length, 5);
  assert.deepEqual(L.filterMembers(members, "0009").map((m) => m.role), ["banned"]);
  assert.deepEqual(L.filterMembers(members, "  ").length, 5);
  assert.deepEqual(L.filterMembers(null, "x"), []);

  const many = Array.from({ length: 60 }, (_, i) => ({ jid: `${i}` }));
  const first = L.paginate(many, 1, 25);
  assert.deepEqual([first.items.length, first.page, first.pages, first.total], [25, 1, 3, 60]);
  assert.deepEqual(L.paginate(many, 3, 25).items.length, 10);
  assert.equal(L.paginate(many, 99, 25).page, 3, "clamped");
  assert.equal(L.paginate(many, -4, 25).page, 1);
  assert.deepEqual(L.paginate([], 1), { items: [], page: 1, pages: 1, total: 0, pageSize: 25 });
});
