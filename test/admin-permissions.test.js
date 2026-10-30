"use strict";
/**
 * Command permissions from the browser (feature 003, specs/003-command-permissions/contracts/admin-permissions-api.md):
 * PERM-1..PERM-7 over the real createAdmin (test/helpers/adminHarness.js), the fake client and socket of
 * test/helpers/fakes.js and the real registry, plugins and engine (lib/utils/commandPermissions.js).
 *
 *  - group part (US1/US2): PERM-5 (a group's page), PERM-6 (PUT one rule: identities, merge, warnings, refusals in the
 *    stage order of 1.6, audit, cache, concurrency) and PERM-7 (idempotent DELETE, orphan names);
 *  - everywhere part (US3): PERM-2 (one command), PERM-3 and PERM-4 (the `*` rule);
 *  - observation and safety part (US4): PERM-1, GRP-3 `counts.permissions`, GRP-6 `deleted.permissionRules`, SC-003.
 *
 * Offline: in-memory SQLite, a fake clock, no WhatsApp. Nothing touches the real data/, sessions/ or database.db.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Op } = require("sequelize");
const fakes = require("./helpers/fakes");

const OWNER = "237600000001@s.whatsapp.net";
const OWNER_LID = "99000000001@lid";
const BOT_PN = "237600000009@s.whatsapp.net";
const BOT_LID = "99000000009@lid";

const P1 = "237690000001@s.whatsapp.net"; // member with both forms
const L1 = "99000000011@lid";
const P2 = "237690000002@s.whatsapp.net"; // PN-only participant
const P3 = "237690000003@s.whatsapp.net"; // not in the group
const L3 = "99000000013@lid";
const PA = "237690000004@s.whatsapp.net"; // group admin with both forms
const LA = "99000000014@lid";
const L5 = "99000000015@lid"; // LID-only participant
const P6 = "237690000006@s.whatsapp.net"; // known only through the Baileys LID mapping
const L6 = "99000000016@lid";

fakes.setupEnv({ sudo: "237600000001" });

const { createTestAdmin } = require("./helpers/adminHarness");
const registry = require("../lib/plugins/registry");
const settingsCache = require("../lib/utils/settingsCache");
const commandPermissions = require("../lib/utils/commandPermissions");
const { getLang } = require("../lib/utils/language");
const { invalidateGroupMetadata } = require("../lib/classes/Message");
const { parsePerson, mergePeople, diffPeople, computeWarnings, auditDetail } = require("../lib/admin/services/permissions");
const { normalizeJid } = require("../lib/utils/permissions");
const kit = require("./helpers/backupKit");
const format = require("../lib/admin/backup/format");
const { createExporter } = require("../lib/admin/backup/export");
const { createRestorer } = require("../lib/admin/backup/restore");
const { createSettingsStore } = require("../lib/utils/settingsStore");
const { createSecretBox } = require("../lib/utils/secretBox");
const maintenanceMode = require("../lib/utils/maintenanceMode");

let t;
let db;

before(async () => {
  const setup = await fakes.setup();
  db = setup.db;
  // probes next to the real plugins: an owner-only command that can be delegated, an admin-only one, a public one
  const probe = (pattern, command) =>
    registry.registerPlugin(
      {
        command: { pattern, desc: `probe ${pattern}`, type: "test", ...command },
        async execute(message) {
          await message.reply(`ran:${pattern}`);
        },
      },
      `zz-${pattern}.js`,
    );
  probe("zzgate", { ownerOnly: true, delegable: true });
  probe("zzadmin", { adminOnly: true });
  probe("zzpublic", {});
});

beforeEach(async () => {
  for (const name of ["PermissionRule", "KnownChat", "Group", "CommandState", "AuditLog"]) await db[name].destroy({ where: {}, truncate: true });
  settingsCache.clear();
  invalidateGroupMetadata();
});

afterEach(async () => {
  if (t) await t.close();
  t = null;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let groupSeq = 0;
const G = (n) => `1203630006${String(n).padStart(5, "0")}@g.us`;
const newGroup = () => G(++groupSeq);
const enc = encodeURIComponent;
const sleep = fakes.sleep;

const participants = ({ memberAdmin = false } = {}) => [
  { id: BOT_LID, phoneNumber: BOT_PN, lid: BOT_LID, admin: "admin" },
  { id: OWNER_LID, phoneNumber: OWNER, lid: OWNER_LID, admin: null },
  { id: L1, phoneNumber: P1, lid: L1, admin: memberAdmin ? "admin" : null },
  { id: P2, admin: null },
  { id: LA, phoneNumber: PA, lid: LA, admin: "admin" },
  { id: L5, lid: L5, admin: null },
];

/** A fake socket whose group metadata and LID mapping are scripted by the test */
function makeSocket(opts = {}) {
  const sock = fakes.fakeSocket({
    botUser: { id: "237600000009:3@s.whatsapp.net", lid: "99000000009:3@lid", name: "Bot" },
    participants: participants(),
  });
  sock.metadataCalls = 0;
  sock.metadataError = null;
  sock.lidError = null; // (the fake socket answers any unknown property with a function: every field is set here)
  sock.participantList = opts.participants || participants();
  sock.groupMetadata = async (jid) => {
    sock.metadataCalls += 1;
    if (sock.metadataError) throw sock.metadataError;
    return { id: jid, subject: "Test group", desc: "", owner: PA, size: sock.participantList.length, participants: sock.participantList.map((p) => ({ ...p })) };
  };
  sock.served = new Map(); // group jid -> live subject, for the groups the bot is in (GRP-2 / the snapshot)
  sock.groupFetchAllParticipating = async () =>
    Object.fromEntries([...sock.served].map(([jid, subject]) => [jid, { id: jid, subject, size: 1, participants: sock.participantList.map((p) => ({ ...p })) }]));
  // the Baileys mapping the permissions service consults when the group does not know a person
  sock.mapping = { [L6]: P6 };
  sock.mappingCalls = [];
  sock.signalRepository = {
    lidMapping: {
      async getPNForLID(lid) {
        sock.mappingCalls.push(["pn", lid]);
        return sock.mapping[lid] || null;
      },
      async getLIDForPN(pn) {
        sock.mappingCalls.push(["lid", pn]);
        if (sock.lidError) throw sock.lidError;
        return Object.entries(sock.mapping).find(([, value]) => value === pn)?.[0] || null;
      },
    },
  };
  return sock;
}

/** The admin over a fake client, started, with a logged-in browser */
async function boot(opts = {}) {
  const sock = opts.sock || makeSocket();
  const client = fakes.fakeClient(sock);
  if (opts.offline) client.ready = () => false;
  t = await createTestAdmin({ setup: { sudo: "237600000001" }, deps: { client, ...(opts.deps || {}) } });
  const http = await t.loginClient();
  return { sock, client, http, groups: t.deps.groupsService };
}

/** A KnownChat group row, optionally with its Group settings row */
async function addGroup(jid = newGroup(), { chat = {}, group } = {}) {
  const at = new Date(t.clock.now());
  await db.KnownChat.upsert({ jid, kind: "group", name: `Group ${jid.slice(-5)}`, firstSeenAt: at, lastSeenAt: at, leftAt: null, ...chat });
  if (group) await db.Group.upsert({ jid, ...group });
  return jid;
}

const cmdUrl = (name, tail = "") => `/admin/api/commands/${enc(name)}/permissions${tail}`;
const putEverywhere = (http, name, mode, people) => http.api("PUT", cmdUrl(name, "/everywhere"), { mode, people });
const delEverywhere = (http, name) => http.api("DELETE", cmdUrl(name, "/everywhere"));
const url = (jid, name) => `/admin/api/groups/${enc(jid)}/permissions${name === undefined ? "" : `/${enc(name)}`}`;
const putRule = (http, jid, name, mode, people) => http.api("PUT", url(jid, name), { mode, people });
const delRule = (http, jid, name) => http.api("DELETE", url(jid, name));
const code = (answer) => answer.json?.error?.code;
const fieldsOf = (answer) => answer.json?.error?.fields;

const rowOf = async (command, scope) => {
  const row = await db.PermissionRule.findOne({ where: { command, scope } });
  return row ? { mode: row.mode, people: row.people, createdAt: row.createdAt, updatedAt: row.updatedAt } : null;
};
const allRows = async () => (await db.PermissionRule.findAll({ order: [["command", "ASC"], ["scope", "ASC"]] })).map((r) => ({ command: r.command, scope: r.scope, mode: r.mode, people: r.people }));
const permAudit = async () =>
  (await db.AuditLog.findAll({ where: { action: { [Op.like]: "command.permission.%" } }, order: [["id", "ASC"]], raw: true })).map((r) => ({
    action: r.action,
    target: r.target,
    detail: JSON.parse(r.detail),
  }));
/** Every table but the session ones, as JSON text: proves that a request wrote nothing */
async function dataTables() {
  const all = await t.dumpTables();
  for (const name of ["AdminSession", "AdminToken", "AdminAccount"]) delete all[name];
  return all;
}
const warningCodes = (rule) => rule.warnings.map((w) => w.code);

// ---------------------------------------------------------------------------
// Group part: PERM-6
// ---------------------------------------------------------------------------

describe("PERM-6: PUT /admin/api/groups/:jid/permissions/:name", () => {
  test("stores extra and only rules as { pn, lid }, with the missing form found in the group", async () => {
    const { http } = await boot();
    const jid = await addGroup();

    const first = await putRule(http, jid, "kick", "extra", [P1]);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.changed, true);
    assert.deepEqual(Object.keys(first.json).sort(), ["changed", "rule"]);
    const rule = first.json.rule;
    assert.deepEqual(Object.keys(rule).sort(), ["command", "createdAt", "mode", "people", "scope", "updatedAt", "warnings"]);
    assert.equal(rule.command, "kick");
    assert.equal(rule.scope, jid);
    assert.equal(rule.mode, "extra");
    assert.deepEqual(rule.people, [{ jid: P1, name: null, present: true, admin: null }]);
    assert.deepEqual(rule.warnings, [{ code: "opens_admin_command", tone: "warn", params: { count: 1, everywhere: false } }]);
    assert.deepEqual((await rowOf("kick", jid)).people, [{ pn: P1, lid: L1 }], "the LID comes from the participants");

    const second = await putRule(http, jid, "vv", "only", [P2]);
    assert.equal(second.status, 200, second.text);
    assert.equal(second.json.rule.mode, "only");
    const stored = await rowOf("vv", jid);
    assert.equal(stored.mode, "only");
    assert.deepEqual(stored.people, [{ pn: P2, lid: null }]);
    assert.deepEqual(second.json.rule.people, [{ jid: P2, name: null, present: true, admin: null }]);
  });

  test("an alias stores the rule under the canonical command, whatever the case", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    const answer = await putRule(http, jid, "ROLL", "extra", [P1]);
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.json.rule.command, "dice", "roll is an alias of dice");
    assert.equal((await rowOf("roll", jid)), null);
    assert.ok(await rowOf("dice", jid));
    assert.equal((await permAudit())[0].target, `dice:${jid}`);
  });

  test("a second PUT keeps createdAt and moves updatedAt; an identical PUT writes nothing and is not audited", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    const created = (await putRule(http, jid, "kick", "extra", [P1])).json.rule;
    await sleep(15);
    const replaced = (await putRule(http, jid, "kick", "extra", [P1, P2])).json;
    assert.equal(replaced.changed, true);
    assert.equal(replaced.rule.createdAt, created.createdAt, "createdAt is kept by every replace");
    assert.ok(replaced.rule.updatedAt > created.updatedAt, "updatedAt moved");
    assert.equal((await permAudit()).length, 2);

    await sleep(15);
    const before = await rowOf("kick", jid);
    const same = await putRule(http, jid, "kick", "extra", [P2, P1]); // same set, other order
    assert.equal(same.status, 200);
    assert.equal(same.json.changed, false);
    assert.deepEqual(same.json.rule.people.map((p) => p.jid), [P1, P2], "the stored order is kept");
    assert.equal(same.json.rule.updatedAt, before.updatedAt.toISOString());
    assert.deepEqual(await rowOf("kick", jid), before, "nothing written");
    assert.equal((await permAudit()).length, 2, "no audit row for a PUT that changes nothing");
  });

  test("an enrichment-only PUT (a LID added to a PN-only person) writes, with empty added and removed", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    await db.PermissionRule.create({ command: "kick", scope: jid, mode: "extra", people: [{ pn: P1, lid: null }] });
    const answer = await putRule(http, jid, "kick", "extra", [P1, L1]);
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.json.changed, true);
    assert.deepEqual(answer.json.rule.people.map((p) => p.jid), [P1], "still one person");
    assert.deepEqual((await rowOf("kick", jid)).people, [{ pn: P1, lid: L1 }]);
    const [audit] = await permAudit();
    assert.deepEqual(audit.detail, { mode: "extra", previousMode: "extra", added: [], removed: [] });
  });

  test("extra with an empty list is accepted for a group (normal_here), only with an empty list is flagged empty_only", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    const exception = await putRule(http, jid, "kick", "extra", []);
    assert.equal(exception.status, 200, exception.text);
    assert.deepEqual(exception.json.rule.people, []);
    assert.deepEqual(exception.json.rule.warnings, [{ code: "normal_here", tone: "warn", params: {} }], "nothing to cancel: without effect");
    assert.deepEqual((await rowOf("kick", jid)).people, []);

    const closed = await putRule(http, jid, "vv", "only", []);
    assert.equal(closed.status, 200, closed.text);
    assert.deepEqual(closed.json.rule.warnings, [{ code: "empty_only", tone: "warn", params: {} }]);

    // an everywhere `only` rule makes the exception do something: the tone is info
    await db.PermissionRule.create({ command: "zzgate", scope: "*", mode: "only", people: [{ pn: P1, lid: null }] });
    const useful = await putRule(http, jid, "zzgate", "extra", []);
    assert.deepEqual(useful.json.rule.warnings, [{ code: "normal_here", tone: "info", params: {} }]);
  });

  test("identities: typed numbers in every format, a LID, a device suffix; one person however it is written", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    const formats = ["+237 6 90-00-00-03", "00237690000003", "(237) 690.000.003", "237690000003:7@s.whatsapp.net", "237690000003@c.us"];
    const answer = await putRule(http, jid, "zzpublic", "only", formats);
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(answer.json.rule.people.map((p) => p.jid), [P3], "five spellings, one person");
    assert.deepEqual((await rowOf("zzpublic", jid)).people, [{ pn: P3, lid: null }]);

    const lid = await putRule(http, jid, "zzpublic", "only", ["99000000020@lid"]);
    assert.equal(lid.status, 200, lid.text);
    assert.deepEqual(lid.json.rule.people.map((p) => p.jid), ["99000000020@lid"]);
    assert.deepEqual((await rowOf("zzpublic", jid)).people, [{ pn: null, lid: "99000000020@lid" }]);

    // the same person as PN then as LID is one person with both forms
    const both = await putRule(http, jid, "zzpublic", "only", [P1, L1, `${L1.replace("@lid", ":9@lid")}`]);
    assert.equal(both.status, 200, both.text);
    assert.deepEqual(both.json.rule.people.map((p) => p.jid), [P1]);
    assert.deepEqual((await rowOf("zzpublic", jid)).people, [{ pn: P1, lid: L1 }]);
  });

  test("the missing form is looked for in the group, in KnownChat, in the Baileys mapping, in this order", async () => {
    const { http, sock } = await boot();
    const jid = await addGroup();
    await db.KnownChat.create({ jid: L3, kind: "private", pnJid: P3, name: "Carla", firstSeenAt: new Date(), lastSeenAt: new Date() });

    // (1) the participants: P2 has no LID there, L5 has no PN there
    // (2) KnownChat: P3 <-> L3
    // (3) the LID mapping: L6 -> P6
    // (4) the PN -> LID mapping, only for a person nobody else knows
    const answer = await putRule(http, jid, "zzpublic", "only", [P3, L6, "237690000008"]);
    assert.equal(answer.status, 200, answer.text);
    const rows = (await rowOf("zzpublic", jid)).people;
    assert.deepEqual(rows[0], { pn: P3, lid: L3 }, "KnownChat");
    assert.deepEqual(rows[1], { pn: P6, lid: L6 }, "toPnJid through the Baileys mapping");
    assert.deepEqual(rows[2], { pn: "237690000008@s.whatsapp.net", lid: null });
    assert.deepEqual(answer.json.rule.people.map((p) => p.name), ["Carla", null, null], "names come from KnownChat");
    assert.ok(sock.mappingCalls.some(([kind, value]) => kind === "lid" && value === "237690000008@s.whatsapp.net"), "getLIDForPN is asked last");

    // PN -> LID through getLIDForPN when the mapping knows it
    sock.mapping["99000000018@lid"] = "237690000008@s.whatsapp.net";
    await delRule(http, jid, "zzpublic");
    const later = await putRule(http, jid, "zzpublic", "only", ["237690000008"]);
    assert.deepEqual((await rowOf("zzpublic", jid)).people, [{ pn: "237690000008@s.whatsapp.net", lid: "99000000018@lid" }]);
    assert.equal(later.status, 200);
  });

  test("a failing or absent PN-to-LID lookup never fails the save; it runs under withTimeout, only with an open socket", async () => {
    const timeouts = [];
    const realHttp = require("../lib/utils/http");
    const spy = { ...realHttp, withTimeout: (promise, ms, label) => (timeouts.push([ms, label]), realHttp.withTimeout(promise, ms, label)) };
    const { http, sock } = await boot({ deps: { http: spy } });
    const jid = await addGroup();
    sock.lidError = new Error("usync failed");
    const failed = await putRule(http, jid, "zzpublic", "only", ["237690000008"]);
    assert.equal(failed.status, 200, failed.text);
    assert.deepEqual((await rowOf("zzpublic", jid)).people, [{ pn: "237690000008@s.whatsapp.net", lid: null }]);
    assert.ok(timeouts.some(([ms]) => ms === 3000), `lookup under a 3 s timeout: ${JSON.stringify(timeouts)}`);

    await t.close();
    const offline = await boot({ offline: true });
    const calls = offline.sock.mappingCalls.length;
    const jid2 = await addGroup();
    const answer = await putRule(offline.http, jid2, "zzpublic", "only", ["237690000008"]);
    assert.equal(answer.status, 200, answer.text);
    assert.equal(offline.sock.mappingCalls.length, calls, "the socket is not open: no lookup");
  });

  test("an input equal to a stored person needs no lookup; a person absent from the body is removed", async () => {
    const { http, sock } = await boot();
    const jid = await addGroup();
    await db.PermissionRule.create({
      command: "kick",
      scope: jid,
      mode: "extra",
      people: [{ pn: "237690000008@s.whatsapp.net", lid: null }, { pn: P2, lid: null }],
    });
    sock.mappingCalls.length = 0;
    const answer = await putRule(http, jid, "kick", "extra", ["237690000008@s.whatsapp.net", P1]);
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual((await rowOf("kick", jid)).people, [{ pn: "237690000008@s.whatsapp.net", lid: null }, { pn: P1, lid: L1 }]);
    assert.ok(!sock.mappingCalls.some(([, value]) => value === "237690000008@s.whatsapp.net"), "the stored person is not looked up again");
    const [audit] = await permAudit();
    assert.deepEqual(audit.detail, { mode: "extra", previousMode: "extra", added: ["237690000001"], removed: ["237690000002"] });
  });

  test("malformed people: invalid_phone and invalid_jid with the indices, never the value; membership is not checked", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    const phone = await putRule(http, jid, "kick", "extra", ["1234567", P1, "0690000003", "237 abc"]);
    assert.equal(phone.status, 422);
    assert.deepEqual(fieldsOf(phone), { people: { code: "invalid_phone", params: { indices: [0, 2, 3] } } });
    assert.ok(!phone.text.includes("1234567") && !phone.text.includes("0690000003"), "no submitted value is echoed");

    for (const bad of [`${jid}`, "status@broadcast", "12@s.whatsapp.net", "abc@lid", "123@lid", "237690000001@example.com"]) {
      const answer = await putRule(http, jid, "kick", "extra", [P1, bad]);
      assert.equal(answer.status, 422, bad);
      assert.deepEqual(fieldsOf(answer), { people: { code: "invalid_jid", params: { indices: [1] } } }, bad);
    }
    assert.equal(await rowOf("kick", jid), null, "nothing written");

    // P3 is not in the group: accepted, shown as no longer present
    const outsider = await putRule(http, jid, "kick", "extra", [P3]);
    assert.equal(outsider.status, 200, outsider.text);
    assert.deepEqual(outsider.json.rule.people, [{ jid: P3, name: null, present: false, admin: null }]);
  });

  test("101 people is too_many_items, an item over 64 characters is too_long, both before anything is parsed", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    const many = Array.from({ length: 101 }, (_, i) => `2376900${String(10000 + i)}`);
    const tooMany = await putRule(http, jid, "kick", "extra", many);
    assert.equal(tooMany.status, 422);
    assert.deepEqual(fieldsOf(tooMany), { people: { code: "too_many_items", params: { max: 100 } } });

    const hundred = await putRule(http, jid, "zzpublic", "only", many.slice(0, 100));
    assert.equal(hundred.status, 200, hundred.text);
    assert.equal(hundred.json.rule.people.length, 100);

    const long = await putRule(http, jid, "kick", "extra", ["2".repeat(65)]);
    assert.deepEqual(fieldsOf(long), { people: { code: "too_long", params: { max: 64 } } });
  });

  test("schema stage: mode and people are required and typed, an unknown property is $unknown, all reported together", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    const before = await dataTables();
    const cases = [
      [{}, { mode: { code: "required" }, people: { code: "required" } }],
      [{ mode: "extra" }, { people: { code: "required" } }],
      [{ mode: "extra", people: null }, { people: { code: "required" } }],
      [{ people: [] }, { mode: { code: "required" } }],
      [{ mode: "all", people: [] }, { mode: { code: "not_allowed", params: { allowed: ["extra", "only"] } } }],
      [{ mode: "extra", people: "237690000001" }, { people: { code: "invalid_type" } }],
      [{ mode: "extra", people: [237690000001] }, { people: { code: "invalid_type" } }],
      [{ mode: "extra", people: [], extra: 1 }, { $unknown: { code: "unknown_field" } }],
      [{ mode: "x", people: 3, extra: 1 }, { mode: { code: "not_allowed", params: { allowed: ["extra", "only"] } }, people: { code: "invalid_type" }, $unknown: { code: "unknown_field" } }],
    ];
    for (const [body, fields] of cases) {
      const answer = await http.api("PUT", url(jid, "kick"), body);
      assert.equal(answer.status, 422, JSON.stringify(body));
      assert.equal(code(answer), "validation_failed");
      assert.deepEqual(fieldsOf(answer), fields, JSON.stringify(body));
    }
    assert.deepEqual(await dataTables(), before, "nothing written on any 422");
  });

  test("path stage: an unknown command and an unknown group are 404, the schema comes first", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    const unknownCommand = await putRule(http, jid, "nosuchcommand", "extra", [P1]);
    assert.equal(unknownCommand.status, 404);
    assert.deepEqual(unknownCommand.json.error.params, { resource: "command" });
    const unknownGroup = await putRule(http, G(99999), "kick", "extra", [P1]);
    assert.equal(unknownGroup.status, 404);
    assert.deepEqual(unknownGroup.json.error.params, { resource: "group" });
    assert.equal(code(await http.api("PUT", url(jid, "nosuchcommand"), { mode: "nope", people: [] })), "validation_failed", "stage 2 before stage 3");
    assert.equal(await db.PermissionRule.count(), 0);
  });

  test("a command that cannot be delegated is 422 name: not_allowed, nothing is written", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    const before = await dataTables();
    for (const name of ["eval", "exec", "ban", "update", "setvv"]) {
      for (const body of [{ mode: "extra", people: [P1] }, { mode: "only", people: [] }, { mode: "extra", people: ["0123"] }]) {
        const answer = await http.api("PUT", url(jid, name), body);
        assert.equal(answer.status, 422, name);
        assert.equal(code(answer), "validation_failed");
        assert.deepEqual(fieldsOf(answer), { name: { code: "not_allowed" } }, `${name}: the delegability stage comes before the people`);
      }
    }
    assert.deepEqual(await dataTables(), before);
  });

  test("warnings: opens_admin_command counts the people not known as admins; none when everybody is one", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    const mixed = await putRule(http, jid, "kick", "only", [PA, P1, P3]);
    assert.deepEqual(mixed.json.rule.warnings, [{ code: "opens_admin_command", tone: "warn", params: { count: 2, everywhere: false } }], "an only rule opens it too");
    assert.deepEqual(mixed.json.rule.people.map((p) => [p.jid, p.present, p.admin]), [[PA, true, "admin"], [P1, true, null], [P3, false, null]]);
    const admins = await putRule(http, jid, "kick", "extra", [PA]);
    assert.deepEqual(admins.json.rule.warnings, [], "everybody is a known admin");
    const none = await putRule(http, jid, "kick", "extra", []);
    assert.deepEqual(warningCodes(none.json.rule), ["normal_here"], "an empty list opens nothing");
  });

  test("warnings: extra_on_public needs a non-empty list on a command that is neither owner nor admin only", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    const useless = await putRule(http, jid, "zzpublic", "extra", [P1]);
    assert.deepEqual(useless.json.rule.warnings, [{ code: "extra_on_public", tone: "warn", params: {} }]);
    const empty = await putRule(http, jid, "zzpublic", "extra", []);
    assert.deepEqual(warningCodes(empty.json.rule), ["normal_here"], "exclusive with extra_on_public");
    const owner = await putRule(http, jid, "zzgate", "extra", [P1]);
    assert.deepEqual(owner.json.rule.warnings, [], "an owner-only command: adding people does something");
    const only = await putRule(http, jid, "zzpublic", "only", [P1]);
    assert.deepEqual(only.json.rule.warnings, [], "only on a public command is meaningful");
  });

  test("the cache key command_perms is dropped by every write and the next message obeys (FR-010), no restart", async () => {
    const { http, sock } = await boot();
    const jid = await addGroup();
    const entry = registry.getCommandByPattern("zzgate");
    const ask = async (from, where = jid) => (await commandPermissions.decide(entry, fakes.makeMessage({ body: ".zzgate", from, group: where, sock }))).verdict;

    assert.equal(await ask(P1), "normal");
    assert.ok(settingsCache.cache.has(commandPermissions.CACHE_KEY), "the table is cached");
    assert.equal((await putRule(http, jid, "zzgate", "extra", [P1])).status, 200);
    assert.ok(!settingsCache.cache.has(commandPermissions.CACHE_KEY), "a PUT drops the key");
    assert.equal(await ask(P1), "granted");
    assert.equal(await ask(P2), "normal");
    assert.equal(await ask(P1, newGroup()), "normal", "the rule is for this group only");

    // end to end through the registry: refused, granted, refused again
    const gate = async (from) => {
      const message = fakes.makeMessage({ body: ".zzgate", from, group: jid, sock });
      const before = sock.sent.length;
      await registry.executeCommand(message);
      return sock.sent.slice(before).map((s) => s.text);
    };
    assert.deepEqual(await gate(P1), ["ran:zzgate"]);
    assert.deepEqual(await gate(P2), [getLang("common.owner_only")]);
    assert.equal((await delRule(http, jid, "zzgate")).status, 200);
    assert.ok(!settingsCache.cache.has(commandPermissions.CACHE_KEY), "a DELETE drops the key");
    assert.deepEqual(await gate(P1), [getLang("common.owner_only")], "revoked at the very next message");
    assert.equal((await putRule(http, jid, "zzgate", "only", [P2])).status, 200);
    assert.deepEqual(await gate(P1), [], "closed: silence");
    assert.deepEqual(await gate(P2), ["ran:zzgate"]);
  });

  test("two simultaneous PUTs on one rule end with one of the two bodies; PUTs on different rules both land", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    const [a, b] = await Promise.all([putRule(http, jid, "kick", "extra", [P1, P2]), putRule(http, jid, "kick", "only", [PA])]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const row = await rowOf("kick", jid);
    const shape = { mode: row.mode, people: row.people.map((p) => p.pn) };
    assert.ok(
      JSON.stringify(shape) === JSON.stringify({ mode: "extra", people: [P1, P2] }) || JSON.stringify(shape) === JSON.stringify({ mode: "only", people: [PA] }),
      `a mix of the two bodies: ${JSON.stringify(shape)}`,
    );
    assert.equal((await permAudit()).length, 2, "each effective save is audited");

    const results = await Promise.all(["zzgate", "zzadmin", "zzpublic", "vv"].map((name) => putRule(http, jid, name, "only", [P1])));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(await db.PermissionRule.count({ where: { scope: jid } }), 5);
  });
});

// ---------------------------------------------------------------------------
// Group part: PERM-7
// ---------------------------------------------------------------------------

describe("PERM-7: DELETE /admin/api/groups/:jid/permissions/:name", () => {
  test("deletes the rule, then answers deleted: false; one audit row only for the delete that removed something", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    await putRule(http, jid, "kick", "extra", [P1, P2]);
    const first = await delRule(http, jid, "kick");
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(first.json, { deleted: true });
    assert.equal(await rowOf("kick", jid), null);
    const again = await delRule(http, jid, "kick");
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, { deleted: false });
    const audit = await permAudit();
    assert.equal(audit.length, 2, "the PUT and the first DELETE");
    assert.deepEqual(audit[1], {
      action: "command.permission.delete",
      target: `kick:${jid}`,
      detail: { mode: "extra", previousMode: "extra", added: [], removed: ["237690000001", "237690000002"] },
    });
  });

  test("no confirm is needed, an alias resolves to the command, the other rules stay", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    const other = await addGroup();
    await putRule(http, jid, "dice", "only", [P1]);
    await putRule(http, other, "dice", "only", [P1]);
    await putRule(http, jid, "kick", "extra", [P1]);
    const answer = await http.api("DELETE", url(jid, "roll"));
    assert.deepEqual(answer.json, { deleted: true });
    assert.deepEqual((await allRows()).map((r) => `${r.command}@${r.scope === jid ? "A" : "B"}`), ["dice@B", "kick@A"]);
    assert.equal((await http.api("DELETE", `${url(jid, "kick")}?confirm=false`)).status, 200);
  });

  test("an orphan name (unknown command, or loaded but not delegable) deletes its stored row", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    await db.PermissionRule.bulkCreate([
      { command: "gone", scope: jid, mode: "only", people: [{ pn: P1, lid: null }] },
      { command: "exec", scope: jid, mode: "extra", people: [{ pn: P2, lid: null }] },
    ]);
    assert.deepEqual((await delRule(http, jid, "gone")).json, { deleted: true });
    assert.deepEqual((await delRule(http, jid, "eval")).json, { deleted: true }, "an alias of the loaded, non-delegable command");
    assert.equal(await db.PermissionRule.count(), 0);
    const audit = await permAudit();
    assert.deepEqual(audit.map((a) => [a.action, a.target]), [["command.permission.delete", `gone:${jid}`], ["command.permission.delete", `exec:${jid}`]]);
    // not loaded and no row: 404; loaded with no row: deleted false
    const missing = await delRule(http, jid, "gone");
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json.error.params, { resource: "command" });
    assert.deepEqual((await delRule(http, jid, "kick")).json, { deleted: false });
  });

  test("an orphan row stored under an alias can still be removed", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    await db.PermissionRule.create({ command: "roll", scope: jid, mode: "only", people: [{ pn: P1, lid: null }] });
    assert.deepEqual((await delRule(http, jid, "roll")).json, { deleted: true }, "the canonical row does not exist: the orphan goes");
    assert.equal(await db.PermissionRule.count(), 0);
  });

  test("a group the bot has left is allowed; a stale scope stays removable; an unknown group without a row is 404", async () => {
    const { http } = await boot();
    const former = await addGroup(newGroup(), { chat: { leftAt: new Date(t.clock.now()) } });
    await db.PermissionRule.create({ command: "kick", scope: former, mode: "extra", people: [{ pn: P1, lid: null }] });
    assert.deepEqual((await delRule(http, former, "kick")).json, { deleted: true });

    const stale = G(88888); // never seen by the panel
    await db.PermissionRule.create({ command: "kick", scope: stale, mode: "extra", people: [{ pn: P1, lid: null }] });
    assert.deepEqual((await delRule(http, stale, "kick")).json, { deleted: true });

    const unknown = await delRule(http, G(77777), "kick");
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json.error.params, { resource: "group" });
  });
});

// ---------------------------------------------------------------------------
// Group part: audit
// ---------------------------------------------------------------------------

describe("audit of PERM-6 and PERM-7", () => {
  test("command.permission.set: target <command>:<scope>, mode, previousMode, compact ids added and removed", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    await putRule(http, jid, "kick", "extra", [P1, "99000000020@lid"]); // creation
    await putRule(http, jid, "kick", "extra", [P1, P2]); // one added, one removed
    await putRule(http, jid, "kick", "only", [P1, P2]); // mode only
    await putRule(http, jid, "kick", "only", []); // everybody removed
    const audit = await permAudit();
    assert.deepEqual(audit, [
      { action: "command.permission.set", target: `kick:${jid}`, detail: { mode: "extra", previousMode: null, added: ["237690000001", "99000000020@lid"], removed: [] } },
      { action: "command.permission.set", target: `kick:${jid}`, detail: { mode: "extra", previousMode: "extra", added: ["237690000002"], removed: ["99000000020@lid"] } },
      { action: "command.permission.set", target: `kick:${jid}`, detail: { mode: "only", previousMode: "extra", added: [], removed: [] } },
      { action: "command.permission.set", target: `kick:${jid}`, detail: { mode: "only", previousMode: "only", added: [], removed: ["237690000001", "237690000002"] } },
    ]);
  });

  test("a refused request and a read write no audit row", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    await putRule(http, jid, "eval", "extra", [P1]);
    await putRule(http, jid, "kick", "extra", ["12"]);
    await putRule(http, jid, "nosuch", "extra", [P1]);
    await http.get(url(jid));
    assert.deepEqual(await permAudit(), []);
  });

  test("a detail over 1900 characters drops removed for removedCount, then added for addedCount", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    const lids = Array.from({ length: 100 }, (_, i) => `9900000${String(10000000 + i)}@lid`); // 15-digit LIDs: 22 characters each in the audit
    const created = await putRule(http, jid, "kick", "extra", lids);
    assert.equal(created.status, 200, created.text);
    const [first] = await permAudit();
    assert.deepEqual(first.detail, { mode: "extra", previousMode: null, addedCount: 100, removedCount: 0 }, "both lists are too long: counts only");

    // a replace that removes 100 and adds one: removed becomes a count, added keeps its id
    const swapped = await putRule(http, jid, "kick", "extra", [P3]);
    assert.equal(swapped.status, 200, swapped.text);
    const second = (await permAudit())[1];
    assert.deepEqual(second.detail, { mode: "extra", previousMode: "extra", added: ["237690000003"], removedCount: 100 });

    // the delete of a long rule: removed first
    await putRule(http, jid, "vv", "extra", lids);
    await delRule(http, jid, "vv");
    const last = (await permAudit()).at(-1);
    assert.equal(last.action, "command.permission.delete");
    assert.deepEqual(last.detail, { mode: "extra", previousMode: "extra", added: [], removedCount: 100 });
  });
});

// ---------------------------------------------------------------------------
// Group part: PERM-5
// ---------------------------------------------------------------------------

describe("PERM-5: GET /admin/api/groups/:jid/permissions", () => {
  test("the group's rules with each person's presence and admin status, the everywhere rules annotated for this group", async () => {
    const { http, sock } = await boot();
    const jid = await addGroup();
    const other = await addGroup();
    await db.KnownChat.create({ jid: L1, kind: "private", pnJid: P1, name: "Awa", firstSeenAt: new Date(), lastSeenAt: new Date() });
    await db.PermissionRule.bulkCreate([
      { command: "kick", scope: jid, mode: "extra", people: [{ pn: PA, lid: LA }, { pn: P1, lid: L1 }, { pn: P3, lid: null }] },
      { command: "vv", scope: jid, mode: "only", people: [{ pn: null, lid: L5 }] },
      { command: "zzgate", scope: "*", mode: "only", people: [{ pn: P2, lid: null }, { pn: P3, lid: L3 }] },
      { command: "dice", scope: other, mode: "extra", people: [{ pn: P1, lid: null }] },
      { command: "gone", scope: jid, mode: "only", people: [{ pn: P1, lid: null }, { pn: P2, lid: null }] },
      { command: "exec", scope: jid, mode: "extra", people: [{ pn: P1, lid: null }] },
    ]);
    const answer = await http.get(url(jid));
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(Object.keys(answer.json).sort(), ["everywhere", "limits", "members", "orphans", "rules"]);

    const { rules, everywhere, orphans, members, limits } = answer.json;
    assert.deepEqual(rules.map((r) => [r.command, r.scope, r.mode]), [["kick", jid, "extra"], ["vv", jid, "only"]], "sorted by command, delegable only");
    assert.deepEqual(rules[0].people, [
      { jid: PA, name: null, present: true, admin: "admin" },
      { jid: P1, name: "Awa", present: true, admin: null },
      { jid: P3, name: null, present: false, admin: null },
    ]);
    assert.deepEqual(rules[0].warnings, [{ code: "opens_admin_command", tone: "warn", params: { count: 2, everywhere: false } }]);
    assert.deepEqual(rules[1].people, [{ jid: L5, name: null, present: true, admin: null }], "a LID-only person is matched through the participants' lid");

    assert.deepEqual(everywhere.map((r) => [r.command, r.scope, r.mode]), [["zzgate", "*", "only"]]);
    assert.deepEqual(everywhere[0].people.map((p) => [p.jid, p.present]), [[P2, true], [P3, false]]);
    assert.deepEqual(everywhere[0].warnings, []);

    assert.deepEqual(orphans, [
      { command: "exec", mode: "extra", count: 1, reason: "not_delegable" },
      { command: "gone", mode: "only", count: 2, reason: "unknown_command" },
    ]);
    assert.deepEqual(members, { available: true, fetchedAt: new Date(t.clock.now()).toISOString() });
    assert.deepEqual(limits, { peopleMax: 100 });
    assert.ok(typeof rules[0].createdAt === "string" && typeof rules[0].updatedAt === "string");
    assert.ok(sock.metadataCalls <= 1);
  });

  test("one participants() call serves the whole answer", async () => {
    const { http, groups } = await boot();
    const jid = await addGroup();
    await db.PermissionRule.bulkCreate([
      { command: "kick", scope: jid, mode: "extra", people: [{ pn: P1, lid: null }] },
      { command: "vv", scope: jid, mode: "only", people: [{ pn: P2, lid: null }] },
      { command: "zzgate", scope: "*", mode: "only", people: [{ pn: P2, lid: null }] },
    ]);
    const original = groups.participants;
    let calls = 0;
    groups.participants = (...args) => {
      calls += 1;
      return original(...args);
    };
    try {
      assert.equal((await http.get(url(jid))).status, 200);
      assert.equal(calls, 1);
    } finally {
      groups.participants = original;
    }
  });

  test("with the bot offline every person is present: null, admin: null and opens_admin_command counts everybody", async () => {
    const { http } = await boot({ offline: true });
    const jid = await addGroup();
    await db.PermissionRule.bulkCreate([
      { command: "kick", scope: jid, mode: "extra", people: [{ pn: PA, lid: LA }, { pn: P1, lid: null }] },
      { command: "zzgate", scope: "*", mode: "only", people: [{ pn: P2, lid: null }] },
    ]);
    const answer = await http.get(url(jid));
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(answer.json.members, { available: false, fetchedAt: null });
    assert.deepEqual(answer.json.rules[0].people.map((p) => [p.present, p.admin]), [[null, null], [null, null]]);
    assert.deepEqual(answer.json.rules[0].warnings, [{ code: "opens_admin_command", tone: "warn", params: { count: 2, everywhere: false } }], "the safe side");
    assert.deepEqual(answer.json.everywhere[0].people.map((p) => p.present), [null]);

    // a save still works while offline
    const saved = await putRule(http, jid, "kick", "extra", [P1]);
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.rule.people[0].present, null);
  });

  test("a group the bot has left keeps its rules, listed with present: null and no live call; an unknown group is 404", async () => {
    const { http, sock } = await boot();
    const jid = await addGroup(newGroup(), { chat: { leftAt: new Date(t.clock.now()) } });
    await db.PermissionRule.create({ command: "kick", scope: jid, mode: "extra", people: [{ pn: P1, lid: L1 }] });
    const calls = sock.metadataCalls;
    const answer = await http.get(url(jid));
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.json.rules.length, 1);
    assert.deepEqual(answer.json.rules[0].people, [{ jid: P1, name: null, present: null, admin: null }]);
    assert.deepEqual(answer.json.members, { available: false, fetchedAt: null });
    assert.equal(sock.metadataCalls, calls, "a group the bot left is not asked live");

    const missing = await http.get(url(G(99998)));
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json.error.params, { resource: "group" });
  });

  test("a read writes nothing and a rule with a failing metadata fetch still lists", async () => {
    const { http, sock } = await boot();
    const jid = await addGroup();
    await db.PermissionRule.create({ command: "kick", scope: jid, mode: "extra", people: [{ pn: P1, lid: null }] });
    sock.metadataError = new Error("socket hang up");
    const before = await dataTables();
    const answer = await http.get(url(jid));
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(answer.json.members, { available: false, fetchedAt: null });
    assert.deepEqual(await dataTables(), before);
  });

  test("an empty group answers empty lists", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    const answer = await http.get(url(jid));
    assert.deepEqual(answer.json, { rules: [], everywhere: [], orphans: [], members: answer.json.members, limits: { peopleMax: 100 } });
    assert.equal(answer.json.members.available, true);
  });
});

// ---------------------------------------------------------------------------
// Everywhere part: PERM-2
// ---------------------------------------------------------------------------

describe("PERM-2: GET /admin/api/commands/:name/permissions", () => {
  test("one command: its everywhere rule and the groups that have a rule of their own, named and sorted", async () => {
    const { http, sock } = await boot();
    const live = await addGroup(newGroup(), { chat: { name: "Old name" } }); // the live snapshot wins over KnownChat
    sock.served.set(live, "alpha live");
    const beta = await addGroup(newGroup(), { chat: { name: "Beta" } });
    const fromRow = await addGroup(newGroup(), { chat: { name: "" }, group: { name: "Zulu" } }); // the Group row
    const unnamed = newGroup(); // not known to the panel at all: a stale scope
    await http.api("POST", "/admin/api/groups/refresh");
    await db.KnownChat.create({ jid: L1, kind: "private", pnJid: P1, name: "Awa", firstSeenAt: new Date(), lastSeenAt: new Date() });
    await db.PermissionRule.bulkCreate([
      { command: "kick", scope: "*", mode: "only", people: [{ pn: P1, lid: L1 }, { pn: P3, lid: null }] },
      { command: "kick", scope: fromRow, mode: "extra", people: [{ pn: P1, lid: null }] },
      { command: "kick", scope: unnamed, mode: "only", people: [] },
      { command: "kick", scope: beta, mode: "extra", people: [] },
      { command: "kick", scope: live, mode: "extra", people: [{ pn: P1, lid: null }, { pn: P2, lid: null }] },
      { command: "dice", scope: live, mode: "extra", people: [{ pn: P1, lid: null }] },
    ]);

    const answer = await http.get(cmdUrl("kick"));
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(Object.keys(answer.json).sort(), ["access", "command", "delegable", "everywhere", "groups", "lockReason"]);
    const json = answer.json;
    assert.equal(json.command, "kick");
    assert.equal(json.delegable, true);
    assert.equal(json.lockReason, null);
    assert.deepEqual(json.access, { owner: false, admin: true, group: true, pm: false }, "as in CMD-1");

    assert.equal(json.everywhere.command, "kick");
    assert.equal(json.everywhere.scope, "*");
    assert.equal(json.everywhere.mode, "only");
    assert.deepEqual(json.everywhere.people, [{ jid: P1, name: "Awa" }, { jid: P3, name: null }], "no present / admin: there is no group");
    assert.deepEqual(json.everywhere.warnings, [{ code: "opens_admin_command", tone: "warn", params: { count: 2, everywhere: true } }]);

    assert.deepEqual(
      json.groups.map((g) => [g.jid, g.name, g.mode, g.count]),
      [
        [live, "alpha live", "extra", 2],
        [beta, "Beta", "extra", 0],
        [fromRow, "Zulu", "extra", 1],
        [unnamed, null, "only", 0],
      ],
      "by name, case-insensitive, unnamed last",
    );
    // the per-group warnings are the data-free ones: no opens_admin_command (it needs the members)
    assert.deepEqual(json.groups.map((g) => g.warnings.map((w) => w.code)), [[], ["normal_here"], [], ["empty_only"]]);
    assert.deepEqual(json.groups[1].warnings, [{ code: "normal_here", tone: "info", params: {} }], "an everywhere only rule exists: the exception does something");
  });

  test("a public command: extra_on_public in the per-group warnings; an alias answers for the command", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    await db.PermissionRule.create({ command: "dice", scope: jid, mode: "extra", people: [{ pn: P1, lid: null }] });
    const answer = await http.get(cmdUrl("ROLL"));
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.json.command, "dice");
    assert.equal(answer.json.everywhere, null);
    assert.deepEqual(answer.json.groups[0].warnings, [{ code: "extra_on_public", tone: "warn", params: {} }]);
  });

  test("a command that cannot be delegated reports its reason and never its stale rows; an unknown command is 404", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    await db.PermissionRule.bulkCreate([
      { command: "exec", scope: "*", mode: "only", people: [{ pn: P1, lid: null }] },
      { command: "exec", scope: jid, mode: "extra", people: [{ pn: P1, lid: null }] },
    ]);
    const answer = await http.get(cmdUrl("eval"));
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(answer.json, {
      command: "exec",
      delegable: false,
      lockReason: "code",
      access: { owner: true, admin: false, group: false, pm: true },
      everywhere: null,
      groups: [],
    });
    const unknown = await http.get(cmdUrl("nosuchcommand"));
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json.error.params, { resource: "command" });
  });

  test("a read writes nothing", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    await db.PermissionRule.create({ command: "kick", scope: jid, mode: "extra", people: [{ pn: P1, lid: null }] });
    const before = await dataTables();
    assert.equal((await http.get(cmdUrl("kick"))).status, 200);
    assert.deepEqual(await dataTables(), before);
  });
});

// ---------------------------------------------------------------------------
// Everywhere part: PERM-3
// ---------------------------------------------------------------------------

describe("PERM-3: PUT /admin/api/commands/:name/permissions/everywhere", () => {
  test("stores the rule under scope * and answers it without present / admin", async () => {
    const { http } = await boot();
    const answer = await putEverywhere(http, "vv", "extra", [P1, P2]);
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.json.changed, true);
    const { rule } = answer.json;
    assert.equal(rule.command, "vv");
    assert.equal(rule.scope, "*");
    assert.equal(rule.mode, "extra");
    assert.deepEqual(rule.people, [{ jid: P1, name: null }, { jid: P2, name: null }], "no group, so no presence");
    assert.deepEqual(rule.warnings, []);
    assert.deepEqual((await rowOf("vv", "*")).people, [{ pn: P1, lid: null }, { pn: P2, lid: null }], "no group, no participants: the LID is not known here");
    assert.equal(await db.PermissionRule.count(), 1);
  });

  test("extra with an empty list is refused for * (a no-op); only with an empty list is accepted and flagged empty_only", async () => {
    const { http } = await boot();
    const before = await dataTables();
    const refused = await putEverywhere(http, "vv", "extra", []);
    assert.equal(refused.status, 422);
    assert.deepEqual(fieldsOf(refused), { people: { code: "required" } });
    assert.deepEqual(await dataTables(), before);

    const closed = await putEverywhere(http, "vv", "only", []);
    assert.equal(closed.status, 200, closed.text);
    assert.deepEqual(closed.json.rule.warnings, [{ code: "empty_only", tone: "warn", params: {} }]);
    assert.deepEqual((await rowOf("vv", "*")).people, []);
  });

  test("warnings: opens_admin_command counts every person (admin status depends on the group); extra_on_public", async () => {
    const { http } = await boot();
    const admin = await putEverywhere(http, "kick", "extra", [PA, P1]);
    assert.deepEqual(admin.json.rule.warnings, [{ code: "opens_admin_command", tone: "warn", params: { count: 2, everywhere: true } }]);
    const pub = await putEverywhere(http, "dice", "extra", [P1]);
    assert.deepEqual(pub.json.rule.warnings, [{ code: "extra_on_public", tone: "warn", params: {} }]);
    const only = await putEverywhere(http, "dice", "only", [P1]);
    assert.deepEqual(only.json.rule.warnings, []);
  });

  test("an alias is stored under the canonical command; a second PUT keeps createdAt; an identical one changes nothing", async () => {
    const { http } = await boot();
    const first = await putEverywhere(http, "roll", "only", [P1]);
    assert.equal(first.json.rule.command, "dice");
    await sleep(15);
    const second = await putEverywhere(http, "dice", "only", [P1, P2]);
    assert.equal(second.json.rule.createdAt, first.json.rule.createdAt);
    assert.ok(second.json.rule.updatedAt > first.json.rule.updatedAt);
    await sleep(15);
    const same = await putEverywhere(http, "dice", "only", [P2, P1]);
    assert.equal(same.json.changed, false);
    assert.equal(same.json.rule.updatedAt, second.json.rule.updatedAt);
    assert.equal((await permAudit()).length, 2);
  });

  test("the typed-number formats of the group part work here too, and a bad one is invalid_phone", async () => {
    const { http } = await boot();
    const ok = await putEverywhere(http, "vv", "only", ["+237 6 90-00-00-03", "00237690000003", "(237) 690.000.003", "237690000003:7@s.whatsapp.net"]);
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.json.rule.people.map((p) => p.jid), [P3]);
    const bad = await putEverywhere(http, "vv", "only", ["1234567", "0690000003"]);
    assert.deepEqual(fieldsOf(bad), { people: { code: "invalid_phone", params: { indices: [0, 1] } } });
    const jid = await putEverywhere(http, "vv", "only", [P1, "120363000000000001@g.us"]);
    assert.deepEqual(fieldsOf(jid), { people: { code: "invalid_jid", params: { indices: [1] } } });
    assert.deepEqual((await rowOf("vv", "*")).people, [{ pn: P3, lid: null }], "the refused ones wrote nothing");
  });

  test("the missing form: KnownChat, then the Baileys mapping, then getLIDForPN; never with the socket closed; errors ignored", async () => {
    const { http, sock } = await boot();
    await db.KnownChat.create({ jid: L3, kind: "private", pnJid: P3, name: "Carla", firstSeenAt: new Date(), lastSeenAt: new Date() });
    sock.mapping["99000000018@lid"] = "237690000008@s.whatsapp.net";
    const answer = await putEverywhere(http, "vv", "only", [P3, L6, "237690000008", L3]);
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual((await rowOf("vv", "*")).people, [
      { pn: P3, lid: L3 }, // KnownChat; the LID given again is the same person
      { pn: P6, lid: L6 }, // toPnJid through the Baileys mapping
      { pn: "237690000008@s.whatsapp.net", lid: "99000000018@lid" }, // getLIDForPN
    ]);
    assert.deepEqual(answer.json.rule.people.map((p) => p.name), ["Carla", null, null]);

    sock.lidError = new Error("usync failed");
    const failing = await putEverywhere(http, "dice", "only", ["237690000008"]);
    assert.equal(failing.status, 200, failing.text);
    assert.deepEqual((await rowOf("dice", "*")).people, [{ pn: "237690000008@s.whatsapp.net", lid: null }], "the person is saved with one form");

    await t.close();
    const offline = await boot({ offline: true });
    offline.sock.mapping["99000000018@lid"] = "237690000008@s.whatsapp.net";
    const closed = await putEverywhere(offline.http, "zzpublic", "only", ["237690000008"]);
    assert.equal(closed.status, 200, closed.text);
    assert.equal(offline.sock.mappingCalls.length, 0, "the socket is closed: the Baileys mapping is not asked");
    assert.deepEqual((await rowOf("zzpublic", "*")).people, [{ pn: "237690000008@s.whatsapp.net", lid: null }]);
  });

  test("refusals: schema, unknown command, non-delegable (name: not_allowed), nothing written", async () => {
    const { http } = await boot();
    const before = await dataTables();
    assert.deepEqual(fieldsOf(await http.api("PUT", cmdUrl("vv", "/everywhere"), { mode: "all", people: [] })), {
      mode: { code: "not_allowed", params: { allowed: ["extra", "only"] } },
    });
    assert.deepEqual(fieldsOf(await http.api("PUT", cmdUrl("vv", "/everywhere"), { people: [P1], zz: 1 })), { mode: { code: "required" }, $unknown: { code: "unknown_field" } });
    assert.deepEqual(fieldsOf(await putEverywhere(http, "vv", "extra", Array.from({ length: 101 }, () => P1))), { people: { code: "too_many_items", params: { max: 100 } } });
    const unknown = await putEverywhere(http, "nosuchcommand", "only", [P1]);
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json.error.params, { resource: "command" });
    for (const name of ["eval", "exec", "update", "ban"]) {
      const locked = await putEverywhere(http, name, "only", [P1]);
      assert.equal(locked.status, 422, name);
      assert.deepEqual(fieldsOf(locked), { name: { code: "not_allowed" } });
    }
    assert.deepEqual(await dataTables(), before);
  });

  test("each effective save is audited once: command.permission.set on <command>:*", async () => {
    const { http } = await boot();
    await putEverywhere(http, "vv", "only", [P1, "99000000020@lid"]);
    await putEverywhere(http, "vv", "extra", [P1]);
    await putEverywhere(http, "vv", "extra", [P1]); // nothing changed
    assert.deepEqual(await permAudit(), [
      { action: "command.permission.set", target: "vv:*", detail: { mode: "only", previousMode: null, added: ["237690000001", "99000000020@lid"], removed: [] } },
      { action: "command.permission.set", target: "vv:*", detail: { mode: "extra", previousMode: "only", added: [], removed: ["99000000020@lid"] } },
    ]);
  });

  test("the cache is dropped and the next message obeys: granted everywhere, in a group and in private, then revoked", async () => {
    const { http, sock } = await boot();
    const jid = await addGroup();
    const entry = registry.getCommandByPattern("zzgate");
    const verdict = async (from, where) => (await commandPermissions.decide(entry, fakes.makeMessage({ body: ".zzgate", from, group: where, sock }))).verdict;
    assert.equal(await verdict(P1, jid), "normal");
    assert.equal((await putEverywhere(http, "zzgate", "extra", [P1])).status, 200);
    assert.equal(await verdict(P1, jid), "granted");
    assert.equal(await verdict(P1, undefined), "granted", "in private too");
    assert.equal(await verdict(P2, jid), "normal");
    assert.equal((await delEverywhere(http, "zzgate")).status, 200);
    assert.equal(await verdict(P1, jid), "normal");
  });
});

// ---------------------------------------------------------------------------
// Everywhere part: PERM-4
// ---------------------------------------------------------------------------

describe("PERM-4: DELETE /admin/api/commands/:name/permissions/everywhere", () => {
  test("deletes the * rule only; idempotent; no confirm; one audit row for the delete that removed something", async () => {
    const { http } = await boot();
    const jid = await addGroup();
    await putEverywhere(http, "vv", "only", [P1, P2]);
    await putRule(http, jid, "vv", "extra", [P1]);
    const first = await delEverywhere(http, "vv");
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(first.json, { deleted: true });
    assert.deepEqual((await allRows()).map((r) => `${r.command}@${r.scope === "*" ? "*" : "group"}`), ["vv@group"], "the group's rule stays");
    assert.deepEqual((await delEverywhere(http, "vv")).json, { deleted: false });
    const audit = await permAudit();
    assert.equal(audit.length, 3, "two PUTs and one DELETE");
    assert.deepEqual(audit[2], {
      action: "command.permission.delete",
      target: "vv:*",
      detail: { mode: "only", previousMode: "only", added: [], removed: ["237690000001", "237690000002"] },
    });
    assert.equal((await http.api("DELETE", `${cmdUrl("vv", "/everywhere")}?confirm=false`)).status, 200, "no confirm needed, whatever the query");
  });

  test("an orphan name (unknown command, loaded non-delegable one) deletes its row; 404 only when not loaded and no row", async () => {
    const { http } = await boot();
    await db.PermissionRule.bulkCreate([
      { command: "gone", scope: "*", mode: "only", people: [{ pn: P1, lid: null }] },
      { command: "exec", scope: "*", mode: "extra", people: [{ pn: P1, lid: null }] },
    ]);
    assert.deepEqual((await delEverywhere(http, "gone")).json, { deleted: true });
    assert.deepEqual((await delEverywhere(http, "exec")).json, { deleted: true });
    assert.equal(await db.PermissionRule.count(), 0);
    assert.deepEqual((await permAudit()).map((a) => a.target), ["gone:*", "exec:*"]);
    const missing = await delEverywhere(http, "gone");
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json.error.params, { resource: "command" });
    assert.deepEqual((await delEverywhere(http, "kick")).json, { deleted: false }, "loaded, no rule");
    assert.equal((await permAudit()).length, 2);
  });

  test("answers 401 without a session (PERM-2, PERM-3 and PERM-4)", async () => {
    await boot();
    const anonymous = t.client();
    for (const [method, path, body] of [["GET", cmdUrl("vv")], ["PUT", cmdUrl("vv", "/everywhere"), { mode: "only", people: [] }], ["DELETE", cmdUrl("vv", "/everywhere")]]) {
      const answer = await anonymous.api(method, path, body);
      assert.equal(answer.status, 401, `${method} ${path}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Observation and safety part: PERM-1, GRP-3, GRP-6, SC-003
// ---------------------------------------------------------------------------

describe("PERM-1: GET /admin/api/permissions", () => {
  test("lists exactly the loaded commands (the set of CMD-1) with their delegability, lock reason and rule counts", async () => {
    const { http } = await boot();
    const a = await addGroup();
    const b = await addGroup();
    await db.PermissionRule.bulkCreate([
      { command: "vv", scope: "*", mode: "only", people: [{ pn: P1, lid: null }, { pn: P2, lid: null }] },
      { command: "dice", scope: "*", mode: "extra", people: [{ pn: P1, lid: null }] },
      { command: "kick", scope: a, mode: "extra", people: [{ pn: P1, lid: null }] },
      { command: "kick", scope: b, mode: "extra", people: [] },
      { command: "vv", scope: b, mode: "only", people: [] },
    ]);
    const answer = await http.get("/admin/api/permissions");
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(Object.keys(answer.json).sort(), ["items", "limits", "orphans"]);

    const commands = (await http.get("/admin/api/commands")).json.commands.map((c) => c.name);
    assert.deepEqual(answer.json.items.map((i) => i.name), commands, "the set and the order of CMD-1 (sorted by name)");
    const item = (name) => answer.json.items.find((i) => i.name === name);
    assert.deepEqual(item("vv"), { name: "vv", delegable: true, lockReason: null, everywhere: { mode: "only", count: 2 }, groups: 1 });
    assert.deepEqual(item("dice"), { name: "dice", delegable: true, lockReason: null, everywhere: { mode: "extra", count: 1 }, groups: 0 });
    assert.deepEqual(item("kick"), { name: "kick", delegable: true, lockReason: null, everywhere: null, groups: 2 });
    assert.deepEqual(item("ping"), { name: "ping", delegable: true, lockReason: null, everywhere: null, groups: 0 });
    assert.deepEqual(item("exec"), { name: "exec", delegable: false, lockReason: "code", everywhere: null, groups: 0 });
    assert.deepEqual(item("setvv").lockReason, "config");
    assert.deepEqual(item("ban").lockReason, "lockout");
    assert.deepEqual(answer.json.limits, { peopleMax: 100 });
    assert.deepEqual(answer.json.orphans, []);
  });

  test("a non-delegable command never reports a rule; its stale rows, and rows of unknown commands, are orphans in order", async () => {
    const { http } = await boot();
    const a = await addGroup();
    await db.PermissionRule.bulkCreate([
      { command: "gone", scope: a, mode: "only", people: [{ pn: P1, lid: null }] },
      { command: "exec", scope: "*", mode: "only", people: [{ pn: P1, lid: null }, { pn: P2, lid: null }] },
      { command: "exec", scope: a, mode: "extra", people: [{ pn: P1, lid: null }] },
      { command: "gone", scope: "*", mode: "extra", people: [{ pn: P1, lid: null }] },
      { command: "update", scope: "*", mode: "only", people: [] },
    ]);
    const { items, orphans } = (await http.get("/admin/api/permissions")).json;
    for (const name of ["exec", "update"]) {
      const row = items.find((i) => i.name === name);
      assert.equal(row.delegable, false);
      assert.equal(row.everywhere, null, name);
      assert.equal(row.groups, 0, name);
    }
    assert.deepEqual(orphans, [
      { command: "exec", scope: "*", mode: "only", count: 2, reason: "not_delegable" },
      { command: "exec", scope: a, mode: "extra", count: 1, reason: "not_delegable" },
      { command: "gone", scope: "*", mode: "extra", count: 1, reason: "unknown_command" },
      { command: "gone", scope: a, mode: "only", count: 1, reason: "unknown_command" },
      { command: "update", scope: "*", mode: "only", count: 0, reason: "not_delegable" },
    ]);
  });

  test("reads the table, not the cache, and writes nothing", async () => {
    const { http } = await boot();
    await db.PermissionRule.create({ command: "vv", scope: "*", mode: "only", people: [{ pn: P1, lid: null }] });
    const entry = registry.getCommandByPattern("vv");
    await commandPermissions.decide(entry, fakes.makeMessage({ body: ".vv", from: P1 }));
    assert.ok(settingsCache.cache.has(commandPermissions.CACHE_KEY), "the engine cache is warm");
    await db.PermissionRule.create({ command: "dice", scope: "*", mode: "only", people: [{ pn: P1, lid: null }] }); // behind the cache's back
    const before = await dataTables();
    const answer = await http.get("/admin/api/permissions");
    assert.deepEqual(answer.json.items.find((i) => i.name === "dice").everywhere, { mode: "only", count: 1 }, "always fresh");
    assert.deepEqual(await dataTables(), before);
    assert.equal((await t.client().get("/admin/api/permissions")).status, 401);
  });
});

describe("GRP-3 counts.permissions and GRP-6 deleted.permissionRules", () => {
  test("GRP-3 counts the rows of the group, orphans included, and no other group's", async () => {
    const { http } = await boot();
    const a = await addGroup();
    const b = await addGroup();
    assert.equal((await http.get(`/admin/api/groups/${enc(a)}`)).json.counts.permissions, 0);
    await db.PermissionRule.bulkCreate([
      { command: "kick", scope: a, mode: "extra", people: [{ pn: P1, lid: null }] },
      { command: "vv", scope: a, mode: "only", people: [] },
      { command: "gone", scope: a, mode: "only", people: [] }, // an orphan: listed on the same tab
      { command: "exec", scope: a, mode: "extra", people: [] }, // not delegable: idem
      { command: "kick", scope: b, mode: "extra", people: [] },
      { command: "kick", scope: "*", mode: "extra", people: [{ pn: P1, lid: null }] },
    ]);
    const counts = (await http.get(`/admin/api/groups/${enc(a)}`)).json.counts;
    assert.equal(counts.permissions, 4);
    assert.deepEqual(Object.keys(counts).sort(), ["filters", "permissions", "roles", "warnings"]);
    assert.equal((await http.get(`/admin/api/groups/${enc(b)}`)).json.counts.permissions, 1);
  });

  test("GRP-6 deletes the group's rules in the same transaction, keeps the others, and drops the cache key", async () => {
    const { http, sock } = await boot();
    const gone = await addGroup(newGroup(), { group: { welcome: true } });
    const other = await addGroup(newGroup(), { group: { welcome: true } });
    await db.PermissionRule.bulkCreate([
      { command: "kick", scope: gone, mode: "extra", people: [{ pn: P1, lid: null }] },
      { command: "zzgate", scope: gone, mode: "only", people: [] },
      { command: "gone", scope: gone, mode: "only", people: [] },
      { command: "kick", scope: other, mode: "extra", people: [{ pn: P1, lid: null }] },
      { command: "kick", scope: "*", mode: "only", people: [{ pn: P1, lid: null }] },
    ]);
    await commandPermissions.decide(registry.getCommandByPattern("zzgate"), fakes.makeMessage({ body: ".zzgate", from: P1, group: gone, sock }));
    assert.ok(settingsCache.cache.has(commandPermissions.CACHE_KEY));

    const answer = await http.api("DELETE", `/admin/api/groups/${enc(gone)}?confirm=true`);
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(answer.json, { deleted: { group: 1, filters: 0, roles: 0, warnings: 0, commandStates: 0, permissionRules: 3 } });
    assert.deepEqual((await allRows()).map((r) => `${r.command}@${r.scope === other ? "other" : r.scope}`), ["kick@*", "kick@other"]);
    assert.ok(!settingsCache.cache.has(commandPermissions.CACHE_KEY), "the engine reloads at the next message");
    const [audit] = (await db.AuditLog.findAll({ where: { action: "group.delete" }, raw: true }));
    assert.deepEqual(JSON.parse(audit.detail), answer.json.deleted, "the audit stays group.delete");
  });

  test("a group the bot merely left keeps its rules; forgetting it is what deletes them (FR-030)", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    await db.PermissionRule.create({ command: "kick", scope: jid, mode: "extra", people: [{ pn: P1, lid: null }] });

    await db.KnownChat.update({ leftAt: new Date(t.clock.now()) }, { where: { jid } }); // the bot is removed from the group
    const former = (await http.get(`/admin/api/groups/${enc(jid)}`)).json;
    assert.equal(former.former, true);
    assert.equal(former.counts.permissions, 1, "leaving a group deletes nothing");
    assert.equal(await db.PermissionRule.count({ where: { scope: jid } }), 1);
    assert.equal((await http.get(url(jid))).json.rules.length, 1, "and the rule is still listed");

    const forgotten = await http.api("DELETE", `/admin/api/groups/${enc(jid)}?confirm=true`);
    assert.equal(forgotten.json.deleted.permissionRules, 1);
    assert.equal(await db.PermissionRule.count({ where: { scope: jid } }), 0);
  });

  test("a failure in the transaction leaves the rules in place", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    await db.PermissionRule.create({ command: "kick", scope: jid, mode: "extra", people: [{ pn: P1, lid: null }] });
    const original = db.Group.destroy;
    db.Group.destroy = async () => {
      throw new Error("disk full");
    };
    try {
      const answer = await http.api("DELETE", `/admin/api/groups/${enc(jid)}?confirm=true`);
      assert.equal(answer.status, 500);
    } finally {
      db.Group.destroy = original;
    }
    assert.equal(await db.PermissionRule.count({ where: { scope: jid } }), 1, "rolled back with the rest");
  });
});

describe("SC-003: a rule on a command that cannot be delegated opens nothing, even when it comes back from a backup", () => {
  const PASS = "a long enough passphrase";
  let home;

  /** The whole database exported, emptied of rules, and restored: the path a forged backup would take */
  async function throughBackup(mutate) {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-perm-backup-"));
    const box = createSecretBox({ dir: path.join(home, "keys") });
    const store = createSettingsStore({ models: db, secretBox: box });
    await store.load();
    const uploads = kit.fakeUploads(path.join(home, "uploads"));
    const dataDir = path.join(home, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const deps = {
      models: db,
      settingsStore: store,
      secretBox: box,
      textOverrides: { exportRows: () => require("../lib/utils/textOverrides").exportRows(), load: async () => {} },
      settingsCache: { clear: () => settingsCache.clear() },
      stats: { flush: async () => {} },
      config: { VERSION: "9.9.9" },
      maintenanceMode,
      runtime: { restartBot: async () => ({ ok: true, status: "running" }) },
      dataDir,
      sessionDir: path.join(home, "sessions", "main"),
      uploads,
      clock: { now: () => Date.UTC(2026, 5, 1, 10, 0, 0) },
      logger: kit.recordingLogger(),
      kdf: kit.LOW_KDF,
      kdfGate: format.createKdfGate(),
    };
    const file = path.join(home, "export.owb");
    await createExporter(deps).exportToFile({ file, passphrase: PASS, includeSession: false, now: Date.UTC(2026, 5, 1, 10, 0, 0) });
    if (mutate) await mutate();
    const restorer = createRestorer(deps);
    const uploadId = uploads.addFile(file, "s1");
    const inspected = await restorer.inspect({ uploadId, passphrase: PASS, adminSessionId: "s1" });
    await restorer.apply({ restoreToken: inspected.restoreToken, confirm: true, actor: "x", adminSessionId: "s1" });
  }

  afterEach(() => {
    maintenanceMode._reset();
    if (home) fs.rmSync(home, { recursive: true, force: true });
    home = null;
  });

  test("a forged rule on exec comes back with the backup, is ignored at the next message, listed as an orphan, and removable", async () => {
    const group = G(61001);
    await db.PermissionRule.bulkCreate([
      { command: "exec", scope: "*", mode: "extra", people: [{ pn: P1, lid: null }] },
      { command: "exec", scope: group, mode: "only", people: [{ pn: P1, lid: null }] },
      { command: "zzgate", scope: group, mode: "extra", people: [{ pn: P1, lid: null }] }, // a legitimate one
    ]);
    await throughBackup(() => db.PermissionRule.destroy({ where: {} })); // another installation: the table is empty
    assert.equal(await db.PermissionRule.count(), 3, "the round trip brings every rule back, the forged ones included");

    // the engine: the member of the group is refused by the owner-only gate, no rule is ever read for exec
    const { sock, http } = await boot();
    const ask = async (name, from, where) => {
      const message = fakes.makeMessage({ body: `.${name}`, from, group: where, sock });
      const before = sock.sent.length;
      await registry.executeCommand(message);
      return sock.sent.slice(before).map((s) => s.text);
    };
    assert.deepEqual(await ask("exec", P1, group), [getLang("common.owner_only")], "silence would mean the rule was applied");
    assert.deepEqual(await ask("exec", P1, undefined), [getLang("common.owner_only")]);
    assert.deepEqual(await ask("exec", P2, group), [getLang("common.owner_only")]);
    // the legitimate rule restored with them obeys at the very next message
    assert.deepEqual(await ask("zzgate", P1, group), ["ran:zzgate"]);
    assert.deepEqual(await ask("zzgate", P2, group), [getLang("common.owner_only")]);

    // the panel lists them as orphans and removes them one by one
    const { orphans } = (await http.get("/admin/api/permissions")).json;
    assert.deepEqual(orphans.map((o) => [o.command, o.scope, o.reason]), [["exec", "*", "not_delegable"], ["exec", group, "not_delegable"]]);
    assert.deepEqual((await delEverywhere(http, "exec")).json, { deleted: true });
    await addGroup(group);
    assert.deepEqual((await delRule(http, group, "exec")).json, { deleted: true });
    assert.deepEqual((await http.get("/admin/api/permissions")).json.orphans, []);
    assert.deepEqual(await ask("exec", P1, group), [getLang("common.owner_only")]);
  });

  test("a backup round trip brings the rules back and the next message obeys; one that predates the feature empties them", async () => {
    const group = G(61002);
    const { sock } = await boot();
    await addGroup(group);
    await db.PermissionRule.create({ command: "zzgate", scope: group, mode: "only", people: [{ pn: P1, lid: null }] });
    const verdictOf = async (from) => (await commandPermissions.decide(registry.getCommandByPattern("zzgate"), fakes.makeMessage({ body: ".zzgate", from, group, sock }))).verdict;
    assert.equal(await verdictOf(P1), "granted");
    assert.equal(await verdictOf(P2), "closed");

    await throughBackup(() => db.PermissionRule.destroy({ where: {} }));
    assert.equal(await db.PermissionRule.count(), 1);
    assert.equal(await verdictOf(P1), "granted", "the restore cleared the cache; the rule is read again");
    assert.equal(await verdictOf(P2), "closed");
  });
});

// ---------------------------------------------------------------------------
// The pure helpers behind the routes
// ---------------------------------------------------------------------------

describe("people helpers", () => {
  const pn = (digits) => `${digits}@s.whatsapp.net`;
  const lid = (digits) => `${digits}@lid`;

  test("parsePerson: JIDs and typed numbers", () => {
    const p = (input) => parsePerson(input, normalizeJid);
    assert.deepEqual(p("237690000001:7@s.whatsapp.net"), { pn: P1, lid: null });
    assert.deepEqual(p("237690000001@c.us"), { pn: P1, lid: null });
    assert.deepEqual(p("99000000011@lid"), { pn: null, lid: L1 });
    assert.deepEqual(p("  +237 690 000 001 "), { pn: P1, lid: null });
    assert.deepEqual(p("(237)690-000-001"), { pn: P1, lid: null });
    assert.deepEqual(p("00237690000001"), { pn: P1, lid: null });
    assert.deepEqual(p("12345678"), { pn: pn("12345678"), lid: null }, "8 digits is the minimum");
    assert.deepEqual(p("123456789012345"), { pn: pn("123456789012345"), lid: null }, "15 digits is the maximum");
    for (const bad of ["1234567", "1234567890123456", "0690000003", "0023", "abc", "", "237.690.000.00a", "+0237690000001"]) {
      assert.deepEqual(p(bad), { error: "invalid_phone" }, JSON.stringify(bad));
    }
    for (const bad of ["120363000000000001@g.us", "status@broadcast", "@s.whatsapp.net", "1234567@s.whatsapp.net", "1234@lid", "x@lid", "237690000001@hosted"]) {
      assert.deepEqual(p(bad), { error: "invalid_jid" }, JSON.stringify(bad));
    }
  });

  test("mergePeople: a stored person is kept without a lookup, absent ones are removed, new ones follow in body order", () => {
    const stored = [{ pn: pn("11111111"), lid: null }, { pn: pn("22222222"), lid: lid("22222222") }];
    const lookups = [];
    const resolve = (input) => (lookups.push(input), { ...input });
    const merged = mergePeople(stored, [{ pn: pn("33333333"), lid: null }, { pn: null, lid: lid("22222222") }, { pn: pn("44444444"), lid: null }], resolve);
    assert.deepEqual(merged, [{ pn: pn("22222222"), lid: lid("22222222") }, { pn: pn("33333333"), lid: null }, { pn: pn("44444444"), lid: null }]);
    assert.deepEqual(lookups.map((x) => x.pn), [pn("33333333"), pn("44444444")], "the stored LID needed no lookup");
  });

  test("mergePeople: two inputs that resolve to one person are one person, even when the link only appears later", () => {
    const A = { pn: pn("11111111"), lid: null };
    const L = { pn: null, lid: lid("55555") };
    let asked = 0;
    // the second time A is looked up the mapping knows its LID (a stand-in for a lookup that completes the person)
    const resolve = (input) => (input.pn === A.pn && (asked += 1) > 1 ? { pn: A.pn, lid: L.lid } : { ...input });
    const merged = mergePeople([], [A, L, { ...A }], resolve);
    assert.equal(merged.length, 1, JSON.stringify(merged));
    assert.deepEqual(merged[0], { pn: A.pn, lid: L.lid });
    // a resolved person that matches a stored one by its other form continues that person (enrichment)
    const enriched = mergePeople([{ pn: A.pn, lid: null }], [{ pn: null, lid: L.lid }], () => ({ pn: A.pn, lid: L.lid }));
    assert.deepEqual(enriched, [{ pn: A.pn, lid: L.lid }]);
  });

  test("diffPeople: compact ids, a person who keeps one of his forms is in neither list", () => {
    const before = [{ pn: pn("11111111"), lid: null }, { pn: null, lid: lid("99999") }, { pn: pn("22222222"), lid: null }];
    const after = [{ pn: pn("11111111"), lid: lid("77777") }, { pn: pn("33333333"), lid: lid("99999") }];
    assert.deepEqual(diffPeople(before, after), { added: [], removed: ["22222222"] }, "99999 continues as a LID of 33333333");
    assert.deepEqual(diffPeople([], [{ pn: null, lid: lid("12345") }, { pn: pn("44444444"), lid: null }]), { added: ["12345@lid", "44444444"], removed: [] });
  });

  test("computeWarnings: fixed order, the tone rule, and no opens_admin_command without participant data", () => {
    const person = (admin) => ({ jid: P1, name: null, admin });
    const gate = { owner: false, admin: true };
    assert.deepEqual(
      computeWarnings({ access: gate, scope: "g@g.us", mode: "extra", people: [person(null), person("admin"), person("superadmin"), person(undefined)], everywhereOnly: false }),
      [{ code: "opens_admin_command", tone: "warn", params: { count: 2, everywhere: false } }],
    );
    assert.deepEqual(computeWarnings({ access: gate, scope: "*", mode: "only", people: [person("admin")], everywhereOnly: false }), [
      { code: "opens_admin_command", tone: "warn", params: { count: 1, everywhere: true } },
    ]);
    assert.deepEqual(computeWarnings({ access: gate, scope: "g@g.us", mode: "extra", people: [person(null)], everywhereOnly: false, withAdmin: false }), []);
    assert.deepEqual(computeWarnings({ access: { owner: false, admin: false }, scope: "g@g.us", mode: "extra", people: [], everywhereOnly: true }), [
      { code: "normal_here", tone: "info", params: {} },
    ]);
    assert.deepEqual(computeWarnings({ access: { owner: true, admin: false }, scope: "*", mode: "extra", people: [person(null)], everywhereOnly: false }), []);
  });

  test("auditDetail: whole under 1900 characters, then removedCount, then addedCount", () => {
    const ids = (n, size) => Array.from({ length: n }, (_, i) => String(i).padStart(size, "7"));
    assert.deepEqual(auditDetail({ mode: "only", previousMode: null, added: ["1"], removed: [] }), { mode: "only", previousMode: null, added: ["1"], removed: [] });
    const longRemoved = auditDetail({ mode: "only", previousMode: "only", added: ["1"], removed: ids(100, 20) });
    assert.deepEqual(longRemoved, { mode: "only", previousMode: "only", added: ["1"], removedCount: 100 });
    const both = auditDetail({ mode: "extra", previousMode: "only", added: ids(100, 20), removed: ids(100, 20) });
    assert.deepEqual(both, { mode: "extra", previousMode: "only", addedCount: 100, removedCount: 100 });
    assert.ok(JSON.stringify(both).length < 1900);
  });
});

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

describe("access", () => {
  test("PERM-5, PERM-6 and PERM-7 answer 401 without a session", async () => {
    await boot();
    const jid = await addGroup();
    const anonymous = t.client();
    for (const [method, body] of [["GET"], ["PUT", { mode: "extra", people: [] }], ["DELETE"]]) {
      const answer = await anonymous.api(method, method === "GET" ? url(jid) : url(jid, "kick"), body);
      assert.equal(answer.status, 401, method);
      assert.equal(code(answer), "unauthenticated");
    }
  });
});
