"use strict";
/**
 * CMD-1 and CMD-2 (admin-http-api.md 2.6, specs/002-admin-panel T123), through the real admin on the test harness.
 *
 *  - CMD-1 lists each loaded command once with `aliases`, `type`, the effective `desc`, `access { owner, admin,
 *    group, pm }`, `disabledGlobal`, `disabledGroups`, plus `types` and the `orphans` rows;
 *  - CMD-2 applies idempotent, set-based `disable`/`enable` lists: at least one non-empty, at most 500 scopes, a
 *    scope in both lists is `invalid_format`; `warnings` `unban_disabled`/`banchat_disabled`; `404` for an unknown
 *    command unless it is an orphan row being enabled; audit `command.toggle` once per scope really changed;
 *    the change is live at the next message.
 */

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const { createTestAdmin } = require("./helpers/adminHarness");
const registry = require("../lib/plugins/registry");
const settingsCache = require("../lib/utils/settingsCache");
const { languageManager, getLang } = require("../lib/utils/language");

const GROUP_A = "120363000000000001@g.us";
const GROUP_B = "120363000000000002@g.us";
const GROUP_C = "120363000000000003@g.us";

let t;
let client;

function probe(pattern, extra = {}, descKey) {
  return [
    { command: { pattern, desc: `desc of ${pattern}`, type: "test", ...extra }, async execute(message, args, ctx) { await message.reply(`ran:${ctx.command}`); } },
    { descKey },
  ];
}

function registerProbes() {
  registry._reset();
  const plugins = {
    "zz-one.js": probe("zzone|zzuno"),
    "zz-owner.js": probe("zzowner", { ownerOnly: true, type: "admin" }),
    "zz-from-me.js": probe("zzfromme", { fromMe: true, type: "admin" }),
    "zz-admin.js": probe("zzadmin", { adminOnly: true, type: "group" }),
    "zz-group.js": probe("zzgroup", { onlyGroup: true, type: "group" }),
    "zz-pm.js": probe("zzpm", { onlyPm: true }),
    "zz-key.js": probe("zzkey", { type: "info" }, "plugins.ping.desc"),
    "unban.js": probe("unban", { type: "group" }),
    "ban.js": probe("ban", { type: "group" }),
  };
  for (const [file, [plugin, options]] of Object.entries(plugins)) registry.registerPlugin(plugin, file, options);
}

before(async () => {
  t = await createTestAdmin();
  client = await t.loginClient();
});

after(async () => {
  registry._reset();
  await t.close();
});

beforeEach(async () => {
  registerProbes();
  await t.db.CommandState.destroy({ where: {} });
  await t.db.AuditLog.destroy({ where: { action: "command.toggle" } });
  settingsCache.clear();
});

const state = (name, body, extra) => client.api("PATCH", `/admin/api/commands/${name}/state`, body, extra);
const list = async () => {
  const answer = await client.get("/admin/api/commands");
  assert.equal(answer.status, 200, answer.text);
  return answer.json;
};
const byName = (json, name) => json.commands.find((c) => c.name === name);
const rows = async () =>
  (await t.db.CommandState.findAll({ order: [["command", "ASC"], ["scope", "ASC"]], raw: true })).map(({ command, scope }) => `${command}@${scope}`);
const toggleAudit = () => t.db.AuditLog.findAll({ where: { action: "command.toggle" }, order: [["id", "ASC"]], raw: true });

/** Send `.<alias>` from a member of GROUP_A and return what the bot answered */
async function say(alias, where = GROUP_A) {
  const message = fakes.makeMessage({ body: `.${alias}`, from: fakes.IDS.MEMBER_PN, group: where });
  await registry.executeCommand(message);
  return fakes.sentTexts(message.client.getSocket());
}

describe("CMD-1", () => {
  test("needs a session", async () => {
    const anonymous = t.client();
    const answer = await anonymous.get("/admin/api/commands");
    assert.equal(answer.status, 401);
    assert.equal(answer.json.error.code, "unauthenticated");
  });

  test("lists each loaded command once, with its aliases, type, description and access level", async () => {
    const json = await list();
    assert.deepEqual(Object.keys(json).sort(), ["commands", "orphans", "types"]);
    assert.equal(json.commands.length, 9);
    assert.equal(new Set(json.commands.map((c) => c.name)).size, 9, "a command is listed twice");
    assert.deepEqual(json.commands.map((c) => c.name), [...json.commands.map((c) => c.name)].sort(), "sorted by name");

    assert.deepEqual(byName(json, "zzone"), {
      name: "zzone",
      aliases: ["zzone", "zzuno"],
      type: "test",
      desc: "desc of zzone|zzuno",
      access: { owner: false, admin: false, group: false, pm: false },
      disabledGlobal: false,
      disabledGroups: [],
    });
    assert.deepEqual(byName(json, "zzowner").access, { owner: true, admin: false, group: false, pm: false });
    assert.deepEqual(byName(json, "zzfromme").access, { owner: true, admin: false, group: false, pm: false });
    assert.deepEqual(byName(json, "zzadmin").access, { owner: false, admin: true, group: true, pm: false });
    assert.deepEqual(byName(json, "zzgroup").access, { owner: false, admin: false, group: true, pm: false });
    assert.deepEqual(byName(json, "zzpm").access, { owner: false, admin: false, group: false, pm: true });
    assert.deepEqual(json.types, ["admin", "group", "info", "test"]);
    assert.deepEqual(json.orphans, []);
  });

  test("desc is the effective text: translated, with the text overrides of the bot language", async () => {
    assert.equal(byName(await list(), "zzkey").desc, getLang("plugins.ping.desc"));
    const code = languageManager.activeCode();
    languageManager.setOverride(code, "plugins.ping.desc", "Edited from the panel");
    try {
      assert.equal(byName(await list(), "zzkey").desc, "Edited from the panel");
    } finally {
      languageManager.clearOverride(code, "plugins.ping.desc");
    }
    assert.equal(byName(await list(), "zzkey").desc, getLang("plugins.ping.desc"));
  });

  test("shows where each command is disabled, and the orphan rows", async () => {
    await t.db.CommandState.bulkCreate([
      { command: "zzone", scope: "*" },
      { command: "zzone", scope: GROUP_B },
      { command: "zzone", scope: GROUP_A },
      { command: "zztwo", scope: GROUP_C }, // zztwo is not loaded: an orphan
      { command: "gone", scope: "*" },
    ]);
    settingsCache.clear();

    const json = await list();
    const one = byName(json, "zzone");
    assert.equal(one.disabledGlobal, true);
    assert.deepEqual(one.disabledGroups, [GROUP_A, GROUP_B]);
    assert.equal(byName(json, "zzuno"), undefined, "an alias is not a command of its own");
    assert.equal(byName(json, "zzpm").disabledGlobal, false);
    assert.deepEqual(json.orphans, [
      { command: "gone", scope: "*" },
      { command: "zztwo", scope: GROUP_C },
    ]);
  });
});

describe("CMD-2", () => {
  test("disables and enables, answering with where the command is disabled", async () => {
    const first = await state("zzone", { disable: ["*", GROUP_A] });
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(first.json, { name: "zzone", disabledGlobal: true, disabledGroups: [GROUP_A], warnings: [] });
    assert.deepEqual(await rows(), [`zzone@*`, `zzone@${GROUP_A}`]);

    const second = await state("zzone", { enable: ["*"] });
    assert.deepEqual(second.json, { name: "zzone", disabledGlobal: false, disabledGroups: [GROUP_A], warnings: [] });
    assert.deepEqual((await state("zzone", { enable: [GROUP_A] })).json, { name: "zzone", disabledGlobal: false, disabledGroups: [], warnings: [] });
    assert.deepEqual(await rows(), []);
  });

  test("is idempotent and set-based: repeating a request changes nothing, two tabs do not clobber each other", async () => {
    const body = { disable: [GROUP_A, GROUP_B], enable: [GROUP_C] };
    const once = await state("zzone", body);
    const twice = await state("zzone", body);
    assert.deepEqual(twice.json, once.json);
    assert.deepEqual(await rows(), [`zzone@${GROUP_A}`, `zzone@${GROUP_B}`]);

    // "tab 1" only knew about A, "tab 2" only about C: both changes stay
    await state("zzone", { disable: [GROUP_C] });
    await state("zzone", { enable: [GROUP_A] });
    assert.deepEqual(await rows(), [`zzone@${GROUP_B}`, `zzone@${GROUP_C}`]);
    // enabling a scope that was never disabled is not an error
    assert.equal((await state("zzone", { enable: ["*"] })).status, 200);
  });

  test("at least one list must be non-empty", async () => {
    for (const body of [{}, { disable: [] }, { enable: [] }, { disable: [], enable: [] }]) {
      const answer = await state("zzone", body);
      assert.equal(answer.status, 422, JSON.stringify(body));
      assert.equal(answer.json.error.code, "validation_failed");
      assert.equal(answer.json.error.fields.disable.code, "required");
    }
    assert.deepEqual(await rows(), []);
  });

  test("a scope in both lists is invalid_format and nothing is written", async () => {
    const answer = await state("zzone", { disable: [GROUP_A, GROUP_B], enable: [GROUP_B] });
    assert.equal(answer.status, 422);
    assert.equal(answer.json.error.code, "validation_failed");
    assert.equal(answer.json.error.fields.disable.code, "invalid_format");
    assert.equal(answer.json.error.fields.enable.code, "invalid_format");
    assert.deepEqual(await rows(), []);
    assert.deepEqual(await toggleAudit(), []);
  });

  test("a scope is * or a group JID; anything else, an unknown property or a wrong type is a field error", async () => {
    for (const scope of ["", "all", "333@s.whatsapp.net", "120363000000000001", "*@g.us", " * "]) {
      const answer = await state("zzone", { disable: [scope] });
      assert.equal(answer.status, 422, JSON.stringify(scope));
      assert.equal(answer.json.error.fields.disable.code, "invalid_format", JSON.stringify(scope));
    }
    const unknown = await state("zzone", { disable: ["*"], force: true });
    assert.equal(unknown.status, 422);
    assert.equal(unknown.json.error.fields.$unknown.code, "unknown_field");
    const wrongType = await state("zzone", { disable: "*" });
    assert.equal(wrongType.json.error.fields.disable.code, "invalid_type");
    assert.deepEqual(await rows(), []);
  });

  test("at most 500 scopes: 500 are accepted, 501 in a list or 501 across both lists are refused", async () => {
    const groups = (from, n) => Array.from({ length: n }, (_, i) => `1203630000${String(from + i).padStart(8, "0")}@g.us`);

    const tooMany = await state("zzone", { disable: groups(1, 501) });
    assert.equal(tooMany.status, 422);
    assert.deepEqual(tooMany.json.error.fields.disable, { code: "too_many_items", params: { max: 500 } });

    const across = await state("zzone", { disable: groups(1, 300), enable: groups(1000, 201) });
    assert.equal(across.status, 422);
    assert.equal(across.json.error.fields.disable.code, "too_many_items");
    assert.deepEqual(await rows(), []);

    const exactly = await state("zzone", { disable: groups(1, 500) });
    assert.equal(exactly.status, 200, exactly.text);
    assert.equal(exactly.json.disabledGroups.length, 500);
    assert.equal((await toggleAudit()).length, 500);
  });

  test("warns when disabling unban or ban (the panel is then the only way back), not when enabling", async () => {
    assert.deepEqual((await state("unban", { disable: ["*"] })).json.warnings, ["unban_disabled"]);
    assert.deepEqual((await state("ban", { disable: [GROUP_A] })).json.warnings, ["banchat_disabled"]);
    assert.deepEqual((await state("unban", { enable: ["*"] })).json.warnings, []);
    assert.deepEqual((await state("zzone", { disable: ["*"] })).json.warnings, []);
  });

  test("404 for an unknown command or an alias; an orphan row can be enabled, never disabled", async () => {
    for (const name of ["nothere", "zzuno", "ZZONE"]) {
      const answer = await state(name, { disable: ["*"] });
      assert.equal(answer.status, 404, name);
      assert.deepEqual(answer.json.error, { code: "not_found", params: { resource: "command" }, requestId: answer.json.error.requestId });
    }
    assert.deepEqual(await rows(), []);

    await t.db.CommandState.bulkCreate([{ command: "gone", scope: "*" }, { command: "gone", scope: GROUP_A }]);
    settingsCache.clear();
    assert.equal((await state("gone", { disable: [GROUP_B] })).status, 404, "an orphan is not disabled in a new scope");
    assert.equal((await state("gone", { disable: [GROUP_B], enable: ["*"] })).status, 404);
    assert.deepEqual(await rows(), ["gone@*", `gone@${GROUP_A}`]);

    const removed = await state("gone", { enable: ["*", GROUP_A] });
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(removed.json, { name: "gone", disabledGlobal: false, disabledGroups: [], warnings: [] });
    assert.deepEqual(await rows(), []);
    assert.deepEqual((await list()).orphans, []);
  });

  test("audit: command.toggle once per scope that really changed, named <command>:<scope>", async () => {
    await state("zzone", { disable: [GROUP_B] });
    await t.db.AuditLog.destroy({ where: { action: "command.toggle" } });

    // B is already disabled: only "*" and A change
    await state("zzone", { disable: ["*", GROUP_A, GROUP_B] });
    let entries = await toggleAudit();
    assert.deepEqual(entries.map((e) => e.target), ["zzone:*", `zzone:${GROUP_A}`]);
    assert.ok(entries.every((e) => e.result === "ok" && e.origin), "result ok, origin filled in");
    assert.ok(entries.every((e) => JSON.parse(e.detail).disabled === true));

    // C was never disabled: only A changes
    await state("zzone", { enable: [GROUP_A, GROUP_C] });
    entries = await toggleAudit();
    assert.equal(entries.length, 3);
    assert.equal(entries[2].target, `zzone:${GROUP_A}`);
    assert.deepEqual(JSON.parse(entries[2].detail), { disabled: false });

    // a request that changes nothing writes nothing
    await state("zzone", { disable: ["*"], enable: [GROUP_C] });
    assert.equal((await toggleAudit()).length, 3);
  });

  test("a request that fails validation or the guard is not audited and changes nothing", async () => {
    await state("nothere", { disable: ["*"] });
    await state("zzone", { disable: ["bad"] });
    await state("zzone", { disable: ["*"] }, { headers: { "X-CSRF-Token": null } });
    await state("zzone", { disable: ["*"] }, { headers: { Origin: "https://evil.example" } });
    assert.deepEqual(await toggleAudit(), []);
    assert.deepEqual(await rows(), []);
  });

  test("the change is live at the next message, for every alias, and undone as fast", async () => {
    assert.deepEqual(await say("zzuno"), ["ran:zzuno"]);

    await state("zzone", { disable: [GROUP_A] });
    for (const alias of ["zzone", "zzuno"]) assert.deepEqual(await say(alias), [getLang("common.command_disabled")]);
    assert.deepEqual(await say("zzuno", GROUP_B), ["ran:zzuno"], "another group is not affected");

    await state("zzone", { enable: [GROUP_A] });
    assert.deepEqual(await say("zzone"), ["ran:zzone"]);

    await state("zzone", { disable: ["*"] });
    assert.deepEqual(await say("zzone", GROUP_B), [getLang("common.command_disabled")]);
  });
});
