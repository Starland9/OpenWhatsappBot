"use strict";
/**
 * Groups, group guard and chats from the browser (US6, FR-028 to FR-033, FR-045): GRP-1..GRP-17, GRD-1, GRD-2 and
 * CHAT-1..CHAT-3 of admin-http-api.md sections 2.7 to 2.9, over the real createAdmin (test/helpers/adminHarness.js)
 * with the fake client and socket of test/helpers/fakes.js and the real plugins and pipeline.
 *
 *  - GRP-1: 500 groups listed, filtered and paged in under 2 s; status all / current / former; strict query;
 *  - GRP-2 / GRP-3: refresh throttled to once per minute; the group object, `warnings: ["bot_not_admin"]` (FR-032);
 *  - GRP-4 / GRP-5: template validation (1 to 1000 characters, unknown `@variable`, `null` resets), `disabled`
 *    creates and deletes the `BannedChat` row, the preview writes nothing;
 *  - GRP-6: the settings categories of data-model 3.5 in one transaction, data left alone, `confirm` enforced;
 *  - GRP-7..10 filters (50 per group, duplicates, edit in place); GRP-11..13 roles with `guardTarget` and both
 *    identity forms; GRP-14..16 warnings; GRP-17 commands of one group;
 *  - GRD-1 / GRD-2: the switches (saved even without bot admin) and mute (`Group.mute` written only on success);
 *  - CHAT-1..3: the picker and the disabled chats;
 *  - FR-030: a panel write is seen by the plugin's own reader (welcome, filter, role, warn, banned chats, the
 *    guard) without waiting for the 5 minute cache TTL;
 *  - an audit row for each write, none for a read or a refused request.
 *
 * Offline: in-memory SQLite, a fake clock, no WhatsApp. Nothing touches the real data/, sessions/ or database.db.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

const OWNER = "237600000001@s.whatsapp.net";
const OWNER_LID = "99000000001@lid";
const MEMBER = "237600000002@s.whatsapp.net";
const MEMBER_LID = "99000000002@lid";
const MEMBER2 = "237600000003@s.whatsapp.net"; // phone-number participant without a LID
const CREATOR = "237600000004@s.whatsapp.net";
const BOT_PN = "237600000009@s.whatsapp.net";
const BOT_LID = "99000000009@lid";

const config = fakes.setupEnv({ sudo: "237600000001" });

const { createTestAdmin } = require("./helpers/adminHarness");
const { getLang } = require("../lib/utils/language");
const { invalidateGroupMetadata } = require("../lib/classes/Message");
const pipeline = require("../lib/core/pipeline");
const settingsCache = require("../lib/utils/settingsCache");
const cooldown = require("../lib/utils/cooldown");
const commandState = require("../lib/utils/commandState");
const registry = require("../lib/plugins/registry");
const { findUnknownVariables } = require("../lib/admin/services/groups");
const { renderTemplate } = require("../plugins/setwelcome");

let t;
let db;

before(async () => {
  const setup = await fakes.setup();
  db = setup.db;
});

const MY_TABLES = ["Group", "Filter", "GroupRole", "Warn", "BannedChat", "CommandState", "KnownChat", "UserStats", "GroupEconomy", "Idea", "Quote", "Task", "DailyStat"];

beforeEach(async () => {
  for (const name of MY_TABLES) await db[name].destroy({ where: {}, truncate: true });
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
const G = (n) => `1203630004${String(n).padStart(5, "0")}@g.us`;
const newGroup = () => G(++groupSeq + 1000);
const enc = encodeURIComponent;

const participants = ({ botAdmin = true, memberAdmin = false } = {}) => [
  { id: BOT_LID, phoneNumber: BOT_PN, lid: BOT_LID, admin: botAdmin ? "admin" : null },
  { id: OWNER_LID, phoneNumber: OWNER, lid: OWNER_LID, admin: null },
  { id: MEMBER_LID, phoneNumber: MEMBER, lid: MEMBER_LID, admin: memberAdmin ? "admin" : null },
  { id: MEMBER2, admin: null },
  { id: CREATOR, admin: "superadmin" },
];

/** A fake socket with our own identities; the group creator is `CREATOR`. */
function makeSocket({ botAdmin = true, groups, subject = "Test group", desc = "A description" } = {}) {
  const sock = fakes.fakeSocket({
    botUser: { id: "237600000009:3@s.whatsapp.net", lid: "99000000009:3@lid", name: "Bot" },
    participants: participants({ botAdmin }),
    subject,
    desc,
  });
  const meta = (jid, name = subject) => ({
    id: jid,
    subject: name,
    desc,
    owner: CREATOR,
    size: 5,
    participants: participants({ botAdmin }).map((p) => ({ ...p })),
  });
  // (the fake socket answers any unknown property with a function: every field is set here)
  sock.served = new Map(); // jid -> subject, for the groups the bot is in
  sock.metadataError = null;
  sock.metadataCalls = 0;
  sock.fetchCalls = 0;
  sock.groupMetadata = async (jid) => {
    sock.metadataCalls += 1;
    if (sock.metadataError) throw sock.metadataError;
    return meta(jid, sock.served.get(jid) || subject);
  };
  sock.groupFetchAllParticipating = async () => {
    sock.fetchCalls += 1;
    const jids = groups || [...sock.served.keys()];
    return Object.fromEntries(jids.map((jid) => [jid, meta(jid, sock.served.get(jid) || subject)]));
  };
  return sock;
}

/** The admin over a fake client, started, with a logged-in browser and the pipeline attached to the client. */
async function boot(socketOptions = {}, opts = {}) {
  const sock = opts.sock || makeSocket(socketOptions);
  const client = fakes.fakeClient(sock);
  t = await createTestAdmin({ setup: { sudo: "237600000001" }, ...opts, deps: { client, ...(opts.deps || {}) } });
  const http = await t.loginClient();
  pipeline.attachHandlers(client);
  return {
    sock,
    client,
    http,
    /** A message through the real pipeline; resolves with what the bot sent meanwhile. */
    async say(opts) {
      const before = sock.sent.length;
      await pipeline.processMessage(fakes.rawMessage(opts), client);
      return sock.sent.slice(before);
    },
    async participantsUpdate(update) {
      const before = sock.sent.length;
      await client.dispatch("group-participants.update", { author: OWNER, ...update });
      return sock.sent.slice(before);
    },
  };
}

/** A KnownChat group row (and optionally its Group settings row). */
async function addGroup(jid, { chat = {}, group } = {}) {
  const at = new Date(t ? t.clock.now() : Date.UTC(2026, 0, 1));
  await db.KnownChat.upsert({ jid, kind: "group", name: `Group ${jid.slice(-5)}`, firstSeenAt: at, lastSeenAt: at, leftAt: null, ...chat });
  if (group) await db.Group.upsert({ jid, ...group });
  return jid;
}

const AUTH_ACTIONS = /^(login|logout|setup|reset|account)\b/;
/** The audit rows of the panel's own actions (the login that opened the session is not one of them) */
const auditRows = async (where = {}) =>
  (await db.AuditLog.findAll({ where, raw: true, order: [["id", "ASC"]] })).filter((r) => !AUTH_ACTIONS.test(r.action));
/** Every table but the session ones, as JSON text: proves that a request wrote nothing */
async function dataTables() {
  const all = await t.dumpTables();
  for (const name of ["AdminSession", "AdminToken", "AdminAccount"]) delete all[name];
  return all;
}
const groupRow = (jid) => db.Group.findByPk(jid, { raw: true });
const textsOf = (sends) => sends.filter((s) => s.kind === "text").map((s) => s.text);
const code = (answer) => answer.json?.error?.code;
const fieldsOf = (answer) => answer.json?.error?.fields;
const url = (jid, tail = "") => `/admin/api/groups/${enc(jid)}${tail}`;

// ---------------------------------------------------------------------------
// Route table and access
// ---------------------------------------------------------------------------

describe("route table", () => {
  const SESSION_ROUTES = [
    ["GET", "/admin/api/groups"],
    ["POST", "/admin/api/groups/refresh"],
    ["GET", "/admin/api/groups/:jid"],
    ["PATCH", "/admin/api/groups/:jid"],
    ["POST", "/admin/api/groups/:jid/preview"],
    ["DELETE", "/admin/api/groups/:jid"],
    ["GET", "/admin/api/groups/:jid/filters"],
    ["POST", "/admin/api/groups/:jid/filters"],
    ["PUT", "/admin/api/groups/:jid/filters/:id"],
    ["DELETE", "/admin/api/groups/:jid/filters/:id"],
    ["GET", "/admin/api/groups/:jid/members"],
    ["GET", "/admin/api/groups/:jid/roles"],
    ["PUT", "/admin/api/groups/:jid/roles/:userJid"],
    ["GET", "/admin/api/groups/:jid/warnings"],
    ["DELETE", "/admin/api/groups/:jid/warnings/:userJid"],
    ["DELETE", "/admin/api/groups/:jid/warnings"],
    ["PATCH", "/admin/api/groups/:jid/commands"],
    ["PUT", "/admin/api/groups/:jid/guard"],
    ["PUT", "/admin/api/groups/:jid/mute"],
    ["GET", "/admin/api/chats"],
    ["GET", "/admin/api/chats/disabled"],
    ["DELETE", "/admin/api/chats/disabled/:jid"],
  ];

  test("the 22 routes declare a session and a CSRF token on every unsafe method; none touches the database-optional path", async () => {
    await boot();
    const table = t.admin.routes();
    for (const [method, path] of SESSION_ROUTES) {
      const route = table.find((r) => r.method === method && r.path === path);
      assert.ok(route, `${method} ${path} is registered`);
      assert.equal(route.auth, "session", `${method} ${path}`);
      assert.equal(route.csrf, method === "GET" ? false : true, `${method} ${path}`);
      assert.equal(route.mutates, method !== "GET");
      assert.equal(route.db, null, "needs the database");
    }
  });

  test("an anonymous request is refused everywhere, and a mutation without the CSRF token too", async () => {
    const { http } = await boot();
    const group = await addGroup(newGroup());
    const anon = t.client();
    const concrete = (path) => path.replace(":jid", enc(group)).replace(":id", "1").replace(":userJid", enc(MEMBER));
    for (const [method, path] of SESSION_ROUTES) {
      const answer = await anon.api(method, concrete(path), method === "GET" ? undefined : {});
      assert.equal(answer.status, 401, `${method} ${path}`);
      assert.equal(code(answer), "unauthenticated");
    }
    const noToken = await http.api("PATCH", url(group), { disabled: true }, { headers: { "X-CSRF-Token": null } });
    assert.equal(code(noToken), "csrf_invalid");
    assert.equal(await db.BannedChat.count(), 0);
  });

  test("a group JID that is not one, or an unknown route, is a 404", async () => {
    const { http } = await boot();
    for (const path of ["/admin/api/groups/not-a-jid", "/admin/api/groups/123@s.whatsapp.net", "/admin/api/groups/refresh"]) {
      assert.equal((await http.get(path)).status, 404, path);
    }
    assert.equal((await http.get(url(G(99)))).status, 404, "a well-formed JID the panel has never seen");
    assert.deepEqual((await http.get(url(G(99)))).json.error.params, { resource: "group" });
  });
});

// ---------------------------------------------------------------------------
// GRP-1 / GRP-2
// ---------------------------------------------------------------------------

describe("GRP-1", () => {
  const SIZE = 500;
  const STAYS = 480; // the bot is still in the first 480; the last 20 are former groups once WhatsApp is asked

  async function seed500(sock) {
    const at = new Date(Date.UTC(2026, 0, 1));
    const rows = [];
    for (let i = 1; i <= SIZE; i += 1) {
      rows.push({ jid: G(i), kind: "group", name: `Seed ${i}`, firstSeenAt: at, lastSeenAt: at });
      if (i <= STAYS) sock.served.set(G(i), `Team ${String(i).padStart(3, "0")}`);
    }
    await db.KnownChat.bulkCreate(rows);
    await db.Group.bulkCreate(
      Array.from({ length: 60 }, (_, i) => ({ jid: G(i + 1), name: `Seed ${i + 1}`, welcome: i % 2 === 0, antilink: i % 3 === 0 })),
    );
    await db.BannedChat.create({ jid: G(7), bannedBy: null });
  }

  test("500 groups are listed, filtered and paged in under 2 s", async () => {
    const sock = makeSocket();
    await seed500(sock);
    const { http } = await boot({}, { sock });

    const started = performance.now();
    const first = await http.get("/admin/api/groups?pageSize=200");
    const elapsed = performance.now() - started;
    assert.equal(first.status, 200);
    assert.ok(elapsed < 2000, `the first listing (with the WhatsApp fetch) took ${Math.round(elapsed)} ms`);
    assert.equal(first.json.total, SIZE);
    assert.equal(first.json.items.length, 200);
    assert.equal(first.json.page, 1);
    assert.equal(first.json.pageSize, 200);
    assert.match(first.json.refreshedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(sock.fetchCalls, 1, "one WhatsApp fetch for the whole listing");

    const timed = performance.now();
    const page3 = await http.get("/admin/api/groups?page=3&pageSize=200");
    const filtered = await http.get("/admin/api/groups?q=team%2001");
    assert.ok(performance.now() - timed < 2000, "paging and filtering answer from memory");
    assert.equal(page3.json.items.length, 100, "500 = 200 + 200 + 100");
    assert.equal(sock.fetchCalls, 1, "no second fetch");

    // item shape
    const item = first.json.items.find((i) => i.jid === G(1));
    assert.deepEqual(Object.keys(item).sort(), ["antibot", "antilink", "botIsAdmin", "disabled", "former", "goodbye", "jid", "leftAt", "members", "mute", "name", "welcome"]);
    assert.equal(item.name, "Team 001");
    assert.equal(item.members, 5);
    assert.equal(item.botIsAdmin, true);
    assert.equal(item.former, false);
    assert.equal(item.leftAt, null);
    assert.equal(item.welcome, true);
    assert.equal(item.antilink, true);
    assert.equal(first.json.items.find((i) => i.jid === G(7)).disabled, true);

    // name filter: case-insensitive substring of the name
    assert.deepEqual(
      filtered.json.items.map((i) => i.name),
      Array.from({ length: 10 }, (_, i) => `Team 01${i}`),
    );
    assert.equal((await http.get("/admin/api/groups?q=TEAM%20499")).json.total, 0, "499 is not served, the old name is gone");
    assert.equal((await http.get(`/admin/api/groups?q=${enc("Seed 499")}`)).json.total, 1, "a former group keeps the name last seen");
  });

  test("status all / current / former; former groups keep their settings and show leftAt", async () => {
    const sock = makeSocket();
    await seed500(sock);
    const { http } = await boot({}, { sock });

    const all = await http.get("/admin/api/groups?pageSize=200&status=all");
    const current = await http.get("/admin/api/groups?pageSize=200&status=current");
    const former = await http.get("/admin/api/groups?pageSize=200&status=former");
    assert.equal(all.json.total, SIZE);
    assert.equal(current.json.total, STAYS);
    assert.equal(former.json.total, SIZE - STAYS);
    assert.ok(former.json.items.every((i) => i.former && /^\d{4}-/.test(i.leftAt)));
    assert.ok(current.json.items.every((i) => !i.former && i.leftAt === null));
    assert.ok(former.json.items.every((i) => i.members === null && i.botIsAdmin === null), "unknown for a group the bot left");
    const lastPage = (await http.get("/admin/api/groups?pageSize=200&page=3")).json.items;
    assert.ok(lastPage.slice(-20).every((i) => i.former), "current groups come first, former ones last");
    assert.ok(!lastPage[0].former);
    assert.equal((await http.get("/admin/api/groups?q=seed&status=former&pageSize=200")).json.total, SIZE - STAYS);
  });

  test("without a connection the list still answers from the database, members and admin flag unknown", async () => {
    t = await createTestAdmin({ setup: { sudo: "237600000001" } });
    const http = await t.loginClient();
    await addGroup(G(1), { chat: { name: "Offline group" }, group: { welcome: true } });
    const answer = await http.get("/admin/api/groups");
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json.items.map((i) => [i.jid, i.name, i.members, i.botIsAdmin, i.welcome]), [[G(1), "Offline group", null, null, true]]);
    assert.equal(answer.json.refreshedAt, null);
  });

  test("a Group row the chat table does not know yet is listed too", async () => {
    const { http } = await boot();
    await db.Group.create({ jid: G(5), name: "Settings only", antibot: true });
    const answer = await http.get("/admin/api/groups");
    assert.deepEqual(answer.json.items.map((i) => [i.jid, i.name, i.antibot, i.former]), [[G(5), "Settings only", true, false]]);
  });

  test("the query is strict: bad status, page, pageSize and unknown parameters are 422", async () => {
    const { http } = await boot();
    const bad = async (query, field, expected) => {
      const answer = await http.get(`/admin/api/groups?${query}`);
      assert.equal(answer.status, 422, query);
      assert.equal(code(answer), "validation_failed");
      assert.equal(fieldsOf(answer)[field].code, expected, query);
    };
    await bad("status=archived", "status", "not_allowed");
    await bad("page=0", "page", "out_of_range");
    await bad("pageSize=201", "pageSize", "out_of_range");
    await bad("pageSize=0", "pageSize", "out_of_range");
    await bad("page=abc", "page", "invalid_format");
    await bad(`q=${"x".repeat(101)}`, "q", "too_long");
    await bad("sort=name", "$unknown", "unknown_field");
    assert.equal((await http.get("/admin/api/groups?pageSize=200&page=1&q=&status=all")).status, 200);
  });
});

describe("GRP-2", () => {
  test("409 not_connected without a connection", async () => {
    t = await createTestAdmin({ setup: { sudo: "237600000001" } });
    const http = await t.loginClient();
    assert.equal(code(await http.api("POST", "/admin/api/groups/refresh", {})), "not_connected");
  });

  test("refreshes names, sets and clears leftAt; a second call within 60 s is served from cache", async () => {
    const sock = makeSocket();
    sock.served.set(G(1), "First");
    sock.served.set(G(2), "Second");
    await addGroup(G(3), { chat: { name: "Gone" } });
    const { http } = await boot({}, { sock });

    const first = await http.api("POST", "/admin/api/groups/refresh", {});
    assert.equal(first.status, 200);
    assert.equal(first.json.cached, false);
    assert.equal(first.json.refreshedAt, new Date(t.clock.now()).toISOString());
    assert.equal(sock.fetchCalls, 1);
    assert.equal((await db.KnownChat.findByPk(G(1))).name, "First");
    assert.equal((await db.KnownChat.findByPk(G(2))).leftAt, null);
    assert.ok((await db.KnownChat.findByPk(G(3))).leftAt, "no longer listed by WhatsApp: a former group");

    await t.clock.advance(59 * 1000);
    const cached = await http.api("POST", "/admin/api/groups/refresh", {});
    assert.deepEqual(cached.json, { refreshedAt: first.json.refreshedAt, cached: true });
    assert.equal(sock.fetchCalls, 1, "no WhatsApp call");

    // the bot is back in G(3) and has left G(2)
    sock.served.set(G(3), "Gone, back");
    sock.served.delete(G(2));
    await t.clock.advance(2 * 1000);
    const again = await http.api("POST", "/admin/api/groups/refresh", {});
    assert.equal(again.json.cached, false);
    assert.equal(sock.fetchCalls, 2);
    assert.equal((await db.KnownChat.findByPk(G(3))).leftAt, null);
    assert.ok((await db.KnownChat.findByPk(G(2))).leftAt);

    const list = (await http.get("/admin/api/groups")).json.items;
    assert.deepEqual(list.filter((i) => !i.former).map((i) => i.name).sort(), ["First", "Gone, back"]);
  });

  test("a failing WhatsApp fetch is a 502 whatsapp_error without the upstream text", async () => {
    const sock = makeSocket();
    sock.groupFetchAllParticipating = async () => {
      throw new Error("rate-overlimit secret-detail");
    };
    const { http } = await boot({}, { sock });
    const answer = await http.api("POST", "/admin/api/groups/refresh", {});
    assert.equal(answer.status, 502);
    assert.equal(code(answer), "whatsapp_error");
    assert.ok(!answer.text.includes("secret-detail"));
    assert.deepEqual(await auditRows(), [], "GRP-2 is not audited");
  });

  test("a body other than {} is refused", async () => {
    const { http } = await boot();
    const answer = await http.api("POST", "/admin/api/groups/refresh", { force: true });
    assert.equal(answer.status, 422);
    assert.equal(fieldsOf(answer).$unknown.code, "unknown_field");
  });
});

// ---------------------------------------------------------------------------
// GRP-3
// ---------------------------------------------------------------------------

describe("GRP-3", () => {
  test("the group object: shape, defaults, counts, limits and variables", async () => {
    const { http } = await boot();
    const jid = await addGroup(G(1), { chat: { name: "Stored name" }, group: { name: "Stored name" } });
    await db.Filter.bulkCreate([
      { groupJid: jid, pattern: "a", response: "b" },
      { groupJid: jid, pattern: "c", response: "d" },
    ]);
    await db.GroupRole.bulkCreate([
      { groupJid: jid, userJid: MEMBER, role: "vip" },
      { groupJid: jid, userJid: MEMBER2, role: "regular" },
    ]);
    await db.Warn.bulkCreate([
      { jid: MEMBER, groupJid: jid, count: 2, reason: "x" },
      { jid: MEMBER2, groupJid: jid, count: 0, reason: "x" },
    ]);
    await commandState.toggle("ping", { disable: [jid] });

    const answer = await http.get(url(jid));
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, {
      jid,
      name: "Test group",
      members: 5,
      botIsAdmin: true,
      former: false,
      leftAt: null,
      welcome: { enabled: false, message: getLang("plugins.setwelcome.default_message"), custom: false },
      goodbye: { enabled: false, message: getLang("plugins.goodbye.default_left"), custom: false },
      antilink: false,
      antibot: false,
      mute: false,
      disabled: false,
      counts: { filters: 2, roles: 1, warnings: 1 },
      disabledCommands: ["ping"],
      variables: ["@user", "@group", "@desc"],
      limits: { messageMax: 1000, filtersMax: 50, patternMax: 100, responseMax: 1000 },
      warnings: [],
    });
  });

  test("custom templates and the disabled flag", async () => {
    const { http } = await boot();
    const jid = await addGroup(G(1), { group: { welcome: true, welcomeMsg: "Hello @user", goodbye: true, goodbyeMsg: "Bye @user" } });
    await db.BannedChat.create({ jid, bannedBy: null });
    const answer = (await http.get(url(jid))).json;
    assert.deepEqual(answer.welcome, { enabled: true, message: "Hello @user", custom: true });
    assert.deepEqual(answer.goodbye, { enabled: true, message: "Bye @user", custom: true });
    assert.equal(answer.disabled, true);
  });

  test('warnings: ["bot_not_admin"] when antilink, antibot or mute is on and the bot is not an administrator (FR-032)', async () => {
    const { http } = await boot({ botAdmin: false });
    for (const flag of ["antilink", "antibot", "mute"]) {
      const jid = await addGroup(newGroup(), { group: { [flag]: true } });
      const answer = await http.get(url(jid));
      assert.deepEqual(answer.json.warnings, ["bot_not_admin"], flag);
      assert.equal(answer.json.botIsAdmin, false);
    }
    const quiet = await addGroup(newGroup(), { group: { welcome: true } });
    assert.deepEqual((await http.get(url(quiet))).json.warnings, [], "nothing to enforce: no warning");
  });

  test("no warning when the bot is an administrator, or when the admin status is unknown", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup(), { group: { antilink: true, antibot: true, mute: true } });
    assert.deepEqual((await http.get(url(jid))).json.warnings, []);

    await t.close();
    t = await createTestAdmin({ setup: { sudo: "237600000001" } }); // no client: the status is unknown
    const offline = await t.loginClient();
    const answer = await offline.get(url(jid));
    assert.equal(answer.json.botIsAdmin, null);
    assert.equal(answer.json.members, null);
    assert.deepEqual(answer.json.warnings, [], "unknown is not 'not an administrator'");
  });

  test("a group the bot has left is reported as former and is not asked live", async () => {
    const { http, sock } = await boot();
    const jid = await addGroup(newGroup(), { chat: { leftAt: new Date(t.clock.now() - 86400000), name: "Old one" }, group: { antilink: true } });
    const calls = sock.metadataCalls;
    const answer = await http.get(url(jid));
    assert.equal(answer.json.former, true);
    assert.equal(answer.json.leftAt, new Date(t.clock.now() - 86400000).toISOString());
    assert.equal(answer.json.name, "Old one");
    assert.equal(answer.json.botIsAdmin, null);
    assert.deepEqual(answer.json.warnings, []);
    assert.equal(sock.metadataCalls, calls, "no live metadata for a group the bot left");
  });

  test("live metadata is cached for 60 s", async () => {
    const { http, sock } = await boot();
    const jid = await addGroup(newGroup());
    await http.get(url(jid));
    await http.get(url(jid));
    assert.equal(sock.metadataCalls, 1);
    await t.clock.advance(61 * 1000);
    await http.get(url(jid));
    assert.equal(sock.metadataCalls, 2);
  });
});

// ---------------------------------------------------------------------------
// GRP-4 / GRP-5
// ---------------------------------------------------------------------------

describe("GRP-4", () => {
  test("enables and customises welcome and goodbye; the answer is the GRP-3 object; one audit row", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());

    const answer = await http.api("PATCH", url(jid), {
      welcome: { enabled: true, message: "Welcome @user to @group (@desc)" },
      goodbye: { enabled: true, message: "Bye @user" },
    });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json.welcome, { enabled: true, message: "Welcome @user to @group (@desc)", custom: true });
    assert.deepEqual(answer.json.goodbye, { enabled: true, message: "Bye @user", custom: true });
    const row = await groupRow(jid);
    assert.equal(row.welcome, 1);
    assert.equal(row.welcomeMsg, "Welcome @user to @group (@desc)");
    assert.equal(row.goodbye, 1);

    const [audit, ...rest] = await auditRows();
    assert.equal(rest.length, 0);
    assert.equal(audit.action, "group.update");
    assert.equal(audit.target, jid);
    assert.equal(audit.result, "ok");
    const detail = JSON.parse(audit.detail);
    assert.deepEqual(detail.welcome, { enabled: true, message: { length: "Welcome @user to @group (@desc)".length } });
    assert.ok(!audit.detail.includes("Welcome @user"), "the template text is not copied into the audit");

    // the switch alone keeps the text; the text alone keeps the switch
    await http.api("PATCH", url(jid), { welcome: { enabled: false } });
    assert.equal((await groupRow(jid)).welcomeMsg, "Welcome @user to @group (@desc)");
    await http.api("PATCH", url(jid), { welcome: { message: "Second" } });
    const after = await groupRow(jid);
    assert.equal(after.welcome, 0);
    assert.equal(after.welcomeMsg, "Second");
  });

  test("the message is 1 to 1000 characters; null resets it to the default like .welcome reset", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup(), { group: { welcome: true, welcomeMsg: "Custom" } });

    assert.equal((await http.api("PATCH", url(jid), { welcome: { message: "x".repeat(1000) } })).status, 200);
    const long = await http.api("PATCH", url(jid), { welcome: { message: "x".repeat(1001) } });
    assert.equal(long.status, 422);
    assert.deepEqual(fieldsOf(long)["welcome.message"], { code: "too_long", params: { max: 1000 } });
    const empty = await http.api("PATCH", url(jid), { goodbye: { message: "   " } });
    assert.deepEqual(fieldsOf(empty)["goodbye.message"], { code: "too_short", params: { min: 1 } });
    assert.equal((await groupRow(jid)).welcomeMsg, "x".repeat(1000), "refused requests wrote nothing");

    const reset = await http.api("PATCH", url(jid), { welcome: { message: null } });
    assert.equal(reset.status, 200);
    assert.equal(reset.json.welcome.custom, false);
    assert.equal(reset.json.welcome.message, getLang("plugins.setwelcome.default_message"));
    assert.equal((await groupRow(jid)).welcomeMsg, null);
    assert.equal(JSON.parse((await auditRows()).slice(-1)[0].detail).welcome.message, "reset");
  });

  test("an unknown @variable is refused with its name, nothing is written", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup(), { group: { welcomeMsg: "Before" } });
    const before = await dataTables();

    const answer = await http.api("PATCH", url(jid), { welcome: { enabled: true, message: "Hi @user, see @Foo and @bar and @foo" } });
    assert.equal(answer.status, 422);
    assert.equal(code(answer), "validation_failed");
    assert.deepEqual(fieldsOf(answer)["welcome.message"], { code: "unknown_variable", params: { names: ["@foo", "@bar"] } });
    assert.ok(!answer.text.includes("Hi @user"), "the submitted text is not echoed");
    assert.deepEqual(await dataTables(), before, "nothing written, nothing audited");

    // known variables in any case, e-mail addresses, numbers and punctuation are fine
    for (const message of ["@USER @Group @DeSc", "mail a@b.com or x_y@z.fr", "@237600000001 is here", "50% @ home", "@user's @group."]) {
      assert.equal((await http.api("PATCH", url(jid), { goodbye: { message } })).status, 200, message);
    }
  });

  test("findUnknownVariables follows the closed grammar", () => {
    assert.deepEqual(findUnknownVariables("@user @group @desc"), []);
    assert.deepEqual(findUnknownVariables("@users"), ["@users"]);
    assert.deepEqual(findUnknownVariables("a@b.com"), []);
    assert.deepEqual(findUnknownVariables("a.@b @c_d _@e 1@f"), ["@c"], "preceded by a dot, an underscore or a digit is not a variable");
    assert.deepEqual(findUnknownVariables("@Foo, @FOO and @foo"), ["@foo"]);
    assert.deepEqual(findUnknownVariables("(@x)"), ["@x"]);
    assert.deepEqual(findUnknownVariables(""), []);
    assert.deepEqual(findUnknownVariables(undefined), []);
  });

  test("disabled creates and deletes the BannedChat row (bannedBy null); the pipeline gate follows at once", async () => {
    const { http, say } = await boot();
    const jid = await addGroup(newGroup());
    const ping = () => say({ body: ".ping", from: MEMBER, group: jid });

    assert.ok((await ping()).length > 0, "answers before");
    const off = await http.api("PATCH", url(jid), { disabled: true });
    assert.equal(off.status, 200);
    assert.equal(off.json.disabled, true);
    const banned = await db.BannedChat.findByPk(jid, { raw: true });
    assert.ok(banned);
    assert.equal(banned.bannedBy, null);
    assert.deepEqual(await ping(), [], "the bot is silent in a disabled chat, with no wait for the cache TTL");

    const on = await http.api("PATCH", url(jid), { disabled: false });
    assert.equal(on.json.disabled, false);
    assert.equal(await db.BannedChat.count({ where: { jid } }), 0);
    assert.ok((await ping()).length > 0, "answers again");
    assert.deepEqual((await auditRows()).map((r) => r.action), ["group.update", "group.update"]);
  });

  test("the body is strict: unknown properties, an empty body, wrong types", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    const patch = (body) => http.api("PATCH", url(jid), body);

    assert.equal(fieldsOf(await patch({ mute: true })).$unknown.code, "unknown_field");
    assert.equal(fieldsOf(await patch({ welcome: { enabled: true, mesage: "typo" } })).$unknown.code, "unknown_field");
    assert.equal(code(await patch({})), "validation_failed");
    assert.equal(code(await patch({ welcome: {} })), "validation_failed");
    assert.equal(fieldsOf(await patch({ welcome: "yes" })).welcome.code, "invalid_type");
    assert.equal(fieldsOf(await patch({ welcome: { enabled: "yes" } }))["welcome.enabled"].code, "invalid_type");
    assert.equal(fieldsOf(await patch({ disabled: 1 })).disabled.code, "invalid_type");
    assert.equal((await patch({ disabled: false })).status, 200, "disabling a chat that was not disabled is idempotent");
    assert.deepEqual((await auditRows()).map((r) => r.action), ["group.update"], "only the accepted request is audited");
  });

  test("the group is created in Group on first use when only the chat table knew it", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup(), { chat: { name: "Only known" } });
    assert.equal(await groupRow(jid), null);
    assert.equal((await http.api("PATCH", url(jid), { welcome: { enabled: true } })).status, 200);
    const row = await groupRow(jid);
    assert.equal(row.welcome, 1);
    assert.equal(row.name, "Only known");
    assert.equal((await http.api("PATCH", url(G(999)), { welcome: { enabled: true } })).status, 404);
  });
});

describe("GRP-5", () => {
  test("renders @user as @member and @group / @desc from the metadata; unknown variables reported; writes nothing", async () => {
    const { http } = await boot({ subject: "Chess club", desc: "Weekly games" });
    const jid = await addGroup(newGroup(), { group: { welcomeMsg: "Stored" } });
    const before = await dataTables();

    const answer = await http.api("POST", url(jid, "/preview"), { kind: "welcome", message: "Hi @user, welcome to @group (@desc) @oops" });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, {
      rendered: "Hi @member, welcome to Chess club (Weekly games) @oops",
      unknownVariables: ["@oops"],
    });
    assert.deepEqual(await dataTables(), before, "no row written, no audit row");
  });

  test("without a connection the group name comes from the stored rows and @desc is empty", async () => {
    t = await createTestAdmin({ setup: { sudo: "237600000001" } });
    const http = await t.loginClient();
    const jid = await addGroup(newGroup(), { chat: { name: "Stored name" } });
    const answer = await http.api("POST", url(jid, "/preview"), { kind: "goodbye", message: "Bye @user from @group@desc" });
    assert.equal(answer.json.rendered, "Bye @member from Stored name");
  });

  test("validation and 404", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    assert.equal(fieldsOf(await http.api("POST", url(jid, "/preview"), { kind: "hello", message: "x" })).kind.code, "not_allowed");
    assert.equal(fieldsOf(await http.api("POST", url(jid, "/preview"), { kind: "welcome" })).message.code, "required");
    assert.equal(fieldsOf(await http.api("POST", url(jid, "/preview"), { kind: "welcome", message: "x".repeat(1001) })).message.code, "too_long");
    assert.equal((await http.api("POST", url(G(998), "/preview"), { kind: "welcome", message: "x" })).status, 404);
  });
});

// ---------------------------------------------------------------------------
// GRP-6
// ---------------------------------------------------------------------------

describe("GRP-6", () => {
  /** Settings of a group plus data that must survive, and the same kinds of rows in another group. */
  async function seedEverything(jid, other, { former = true } = {}) {
    await addGroup(jid, { chat: former ? { leftAt: new Date(t.clock.now()) } : {}, group: { welcome: true, antilink: true } });
    await addGroup(other, { group: { welcome: true } });
    for (const g of [jid, other]) {
      await db.Filter.create({ groupJid: g, pattern: "p", response: "r" });
      await db.GroupRole.create({ groupJid: g, userJid: MEMBER, role: "vip" });
      await db.Warn.create({ jid: MEMBER, groupJid: g, count: 1 });
      await db.BannedChat.create({ jid: g, bannedBy: null });
      await db.CommandState.create({ command: "ping", scope: g });
      await db.GroupEconomy.create({ groupJid: g, userJid: MEMBER, balance: 50 });
      await db.Idea.create({ groupJid: g, authorJid: MEMBER, text: "idea" });
      await db.Quote.create({ groupJid: g, authorJid: MEMBER, authorName: "A", text: "quote", savedBy: MEMBER });
      await db.UserStats.create({ jid: MEMBER, groupJid: g, messageCount: 3 });
      await db.DailyStat.create({ day: "2026-01-01", metric: "group_msgs", subject: g, count: 4 });
    }
    await db.Task.create({ chatJid: jid, text: "task", createdBy: MEMBER });
    await db.CommandState.create({ command: "ping", scope: "*" });
  }

  const count = async (name, where) => db[name].count({ where });

  test("deletes the settings of a former group in one transaction and leaves economy, ideas, quotes, tasks and stats", async () => {
    const { http } = await boot();
    const jid = newGroup();
    const other = newGroup();
    await seedEverything(jid, other);

    const answer = await http.api("DELETE", `${url(jid)}?confirm=true`);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { deleted: { group: 1, filters: 1, roles: 1, warnings: 1, commandStates: 1 } });

    assert.equal(await count("Group", { jid }), 0);
    assert.equal(await count("Filter", { groupJid: jid }), 0);
    assert.equal(await count("GroupRole", { groupJid: jid }), 0);
    assert.equal(await count("Warn", { groupJid: jid }), 0);
    assert.equal(await count("BannedChat", { jid }), 0);
    assert.equal(await count("CommandState", { scope: jid }), 0);
    assert.equal(await count("KnownChat", { jid }), 0, "the chat row of a group the bot has left goes too");

    // data, not settings
    assert.equal(await count("GroupEconomy", { groupJid: jid }), 1);
    assert.equal(await count("Idea", { groupJid: jid }), 1);
    assert.equal(await count("Quote", { groupJid: jid }), 1);
    assert.equal(await count("Task", { chatJid: jid }), 1);
    assert.equal(await count("UserStats", { groupJid: jid }), 1);
    assert.equal(await count("DailyStat", { subject: jid }), 1);
    // another group and the global state are untouched
    for (const [name, where] of [["Group", { jid: other }], ["Filter", { groupJid: other }], ["GroupRole", { groupJid: other }], ["Warn", { groupJid: other }], ["BannedChat", { jid: other }], ["CommandState", { scope: other }], ["CommandState", { scope: "*" }], ["KnownChat", { jid: other }]]) {
      assert.equal(await count(name, where), 1, `${name} ${JSON.stringify(where)}`);
    }

    const [audit] = await auditRows();
    assert.equal(audit.action, "group.delete");
    assert.equal(audit.target, jid);
    assert.deepEqual(JSON.parse(audit.detail), answer.json.deleted);
    assert.equal((await http.get(url(jid))).status, 404, "the group is unknown to the panel now");
  });

  test("a group the bot is still in keeps its chat row", async () => {
    const { http } = await boot();
    const jid = newGroup();
    await seedEverything(jid, newGroup(), { former: false });
    assert.equal((await http.api("DELETE", `${url(jid)}?confirm=true`)).status, 200);
    assert.equal(await count("KnownChat", { jid }), 1);
    assert.equal(await count("Group", { jid }), 0);
    assert.equal((await http.get(url(jid))).json.counts.filters, 0, "known, with default settings");
  });

  test("without confirm=true nothing is done: 409 confirmation_required", async () => {
    const { http } = await boot();
    const jid = newGroup();
    await seedEverything(jid, newGroup());
    const before = await dataTables();
    for (const query of ["", "?confirm=false"]) {
      const answer = await http.api("DELETE", `${url(jid)}${query}`);
      assert.equal(answer.status, 409, query);
      assert.equal(code(answer), "confirmation_required");
      assert.equal(typeof answer.json.error.params.confirm, "string");
    }
    assert.equal(fieldsOf(await http.api("DELETE", `${url(jid)}?confirm=yes`)).confirm.code, "not_allowed");
    assert.deepEqual(await dataTables(), before);
    assert.equal((await http.api("DELETE", `${url(G(997))}?confirm=true`)).status, 404);
  });

  test("a failure in the middle rolls everything back", async () => {
    const { http } = await boot();
    const jid = newGroup();
    await seedEverything(jid, newGroup());
    const before = await dataTables();
    const original = db.CommandState.destroy;
    db.CommandState.destroy = async () => {
      throw new Error("boom");
    };
    try {
      const answer = await http.api("DELETE", `${url(jid)}?confirm=true`);
      assert.equal(answer.status, 500);
      assert.equal(code(answer), "internal_error");
    } finally {
      db.CommandState.destroy = original;
    }
    assert.deepEqual(await dataTables(), before, "the filters, roles and warnings deleted before the failure are back");
    assert.equal((await http.api("DELETE", `${url(jid)}?confirm=true`)).status, 200, "the lock was released");
  });
});

// ---------------------------------------------------------------------------
// GRP-7..10 filters
// ---------------------------------------------------------------------------

describe("GRP-7..10 filters", () => {
  test("add, list, edit in place, delete: shapes, ids and audit rows", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());

    const empty = await http.get(url(jid, "/filters"));
    assert.deepEqual(empty.json, { filters: [], limits: { messageMax: 1000, filtersMax: 50, patternMax: 100, responseMax: 1000 } });

    const created = await http.api("POST", url(jid, "/filters"), { pattern: "  Hello    World ", response: " Hi there " });
    assert.equal(created.status, 201);
    assert.deepEqual(created.json, { filter: { id: created.json.filter.id, pattern: "Hello World", response: "Hi there" } });
    const { id } = created.json.filter;
    assert.deepEqual((await http.get(url(jid, "/filters"))).json.filters, [{ id, pattern: "Hello World", response: "Hi there" }]);
    assert.equal((await db.Filter.findByPk(id)).isGlobal, false);

    const edited = await http.api("PUT", url(jid, `/filters/${id}`), { pattern: "hello world", response: "Hey" });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.json, { filter: { id, pattern: "hello world", response: "Hey" } });
    assert.equal(await db.Filter.count({ where: { groupJid: jid } }), 1, "edited in place, not duplicated");

    const deleted = await http.api("DELETE", url(jid, `/filters/${id}`));
    assert.deepEqual(deleted.json, { deleted: true });
    assert.equal(await db.Filter.count(), 0);

    const audits = await auditRows();
    assert.deepEqual(audits.map((r) => r.action), ["group.filter", "group.filter", "group.filter"]);
    assert.ok(audits.every((r) => r.target === jid));
    assert.deepEqual(audits.map((r) => JSON.parse(r.detail).op), ["add", "update", "delete"]);
  });

  test("50 filters per group: the 51st is 409 limit_reached; another group is not affected", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    const other = await addGroup(newGroup());
    await db.Filter.bulkCreate(Array.from({ length: 50 }, (_, i) => ({ groupJid: jid, pattern: `word ${i}`, response: "r" })));

    const answer = await http.api("POST", url(jid, "/filters"), { pattern: "one more", response: "r" });
    assert.equal(answer.status, 409);
    assert.equal(code(answer), "limit_reached");
    assert.equal(await db.Filter.count({ where: { groupJid: jid } }), 50);
    assert.equal((await http.api("POST", url(other, "/filters"), { pattern: "one more", response: "r" })).status, 201);
    // an existing pattern is a duplicate, not a limit
    assert.equal(code(await http.api("POST", url(jid, "/filters"), { pattern: "WORD  7", response: "r" })), "duplicate");
    // deleting one frees a slot
    const first = await db.Filter.findOne({ where: { groupJid: jid }, order: [["id", "ASC"]] });
    await http.api("DELETE", url(jid, `/filters/${first.id}`));
    assert.equal((await http.api("POST", url(jid, "/filters"), { pattern: "one more", response: "r" })).status, 201);
  });

  test("a duplicate normalised pattern (case and spacing) is 409 duplicate, on add and on edit", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    const a = (await http.api("POST", url(jid, "/filters"), { pattern: "Good Morning", response: "1" })).json.filter;
    const b = (await http.api("POST", url(jid, "/filters"), { pattern: "bye", response: "2" })).json.filter;

    assert.equal(code(await http.api("POST", url(jid, "/filters"), { pattern: "good   MORNING", response: "x" })), "duplicate");
    assert.equal(code(await http.api("PUT", url(jid, `/filters/${b.id}`), { pattern: " GOOD morning", response: "x" })), "duplicate");
    assert.equal((await http.api("PUT", url(jid, `/filters/${a.id}`), { pattern: "good  morning", response: "same filter, new spelling" })).status, 200, "its own pattern is not a duplicate");
    assert.equal(await db.Filter.count({ where: { groupJid: jid } }), 2);
    assert.deepEqual(await db.Filter.findByPk(b.id, { raw: true }).then((r) => [r.pattern, r.response]), ["bye", "2"], "the refused edit changed nothing");
  });

  test("limits: pattern 1 to 100 after whitespace collapse, response 1 to 1000", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    const post = (body) => http.api("POST", url(jid, "/filters"), body);

    assert.equal((await post({ pattern: "p".repeat(100), response: "r".repeat(1000) })).status, 201);
    assert.deepEqual(fieldsOf(await post({ pattern: "q".repeat(101), response: "r" })).pattern, { code: "too_long", params: { max: 100 } });
    assert.deepEqual(fieldsOf(await post({ pattern: "q", response: "r".repeat(1001) })).response, { code: "too_long", params: { max: 1000 } });
    assert.equal(fieldsOf(await post({ pattern: "   ", response: "r" })).pattern.code, "too_short");
    assert.equal(fieldsOf(await post({ pattern: "q", response: "  " })).response.code, "too_short");
    assert.equal(fieldsOf(await post({ response: "r" })).pattern.code, "required");
    assert.equal(fieldsOf(await post({ pattern: "q", response: "r", isGlobal: true })).$unknown.code, "unknown_field");
    assert.equal(fieldsOf(await post({ pattern: 5, response: "r" })).pattern.code, "invalid_type");
    // 98 characters spread over spaces collapse below the limit
    assert.equal((await post({ pattern: `${"a ".repeat(30)}${" ".repeat(60)}b`, response: "r" })).status, 201);
    assert.equal(await db.Filter.count({ where: { groupJid: jid } }), 2);
  });

  test("404 for an unknown filter, a filter of another group, and an unknown group", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    const other = await addGroup(newGroup());
    const foreign = await db.Filter.create({ groupJid: other, pattern: "x", response: "y" });

    for (const answer of [
      await http.api("PUT", url(jid, "/filters/987654"), { pattern: "a", response: "b" }),
      await http.api("PUT", url(jid, `/filters/${foreign.id}`), { pattern: "a", response: "b" }),
      await http.api("DELETE", url(jid, "/filters/987654")),
      await http.api("DELETE", url(jid, `/filters/${foreign.id}`)),
      await http.get(url(G(996), "/filters")),
      await http.api("POST", url(G(996), "/filters"), { pattern: "a", response: "b" }),
    ]) {
      assert.equal(answer.status, 404);
    }
    assert.equal((await http.api("DELETE", url(jid, "/filters/0"))).status, 404, "an id must be a positive integer");
    assert.equal(await db.Filter.count({ where: { groupJid: other } }), 1);
    assert.deepEqual(await auditRows(), []);
  });
});

// ---------------------------------------------------------------------------
// GRP-11..13 roles
// ---------------------------------------------------------------------------

describe("GRP-11..13 roles", () => {
  test("members: phone-number JID when known, admin flag, current role; needs a connection and a current group", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    await db.GroupRole.create({ groupJid: jid, userJid: MEMBER, role: "vip" });
    settingsCache.invalidate(`roles:${jid}`);

    const answer = await http.get(url(jid, "/members"));
    assert.equal(answer.status, 200);
    assert.equal(answer.json.fetchedAt, new Date(t.clock.now()).toISOString());
    const byJid = Object.fromEntries(answer.json.items.map((i) => [i.jid, i]));
    assert.deepEqual(byJid[MEMBER], { jid: MEMBER, admin: null, role: "vip" });
    assert.deepEqual(byJid[BOT_PN], { jid: BOT_PN, admin: "admin", role: "regular" });
    assert.deepEqual(byJid[CREATOR], { jid: CREATOR, admin: "superadmin", role: "regular" });
    assert.deepEqual(byJid[MEMBER2], { jid: MEMBER2, admin: null, role: "regular" });
    assert.equal(answer.json.items.length, 5);

    const former = await addGroup(newGroup(), { chat: { leftAt: new Date(t.clock.now()) } });
    assert.equal(code(await http.get(url(former, "/members"))), "group_left");
    assert.equal(code(await http.get(url(G(995), "/members"))), "not_found");

    await t.close();
    t = await createTestAdmin({ setup: { sudo: "237600000001" } });
    const offline = await t.loginClient();
    assert.equal(code(await offline.get(url(jid, "/members"))), "not_connected");
  });

  test("members: a group the bot cannot read any more is group_left; other failures are whatsapp_error", async () => {
    const { http, sock } = await boot();
    const jid = await addGroup(newGroup());
    sock.metadataError = Object.assign(new Error("forbidden"), { data: 403 });
    assert.equal(code(await http.get(url(jid, "/members"))), "group_left");
    sock.metadataError = new Error("socket hang up");
    const failed = await http.get(url(jid, "/members"));
    assert.equal(failed.status, 502);
    assert.equal(code(failed), "whatsapp_error");
    assert.ok(!failed.text.includes("hang up"));
  });

  test("set vip, muted, banned and regular; the list shows non-default roles; setBy is null for the panel", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    const put = (user, role) => http.api("PUT", url(jid, `/roles/${enc(user)}`), { role });

    assert.deepEqual((await put(MEMBER, "vip")).json, { userJid: MEMBER, role: "vip" });
    assert.deepEqual((await put(MEMBER2, "muted")).json, { userJid: MEMBER2, role: "muted" });
    const list = (await http.get(url(jid, "/roles"))).json.items;
    assert.deepEqual(list.map((i) => [i.userJid, i.role, i.setBy]).sort(), [[MEMBER, "vip", null], [MEMBER2, "muted", null]]);
    assert.ok(list.every((i) => /^\d{4}-/.test(i.setAt)));

    assert.equal((await put(MEMBER, "banned")).status, 200);
    assert.equal((await db.GroupRole.findOne({ where: { groupJid: jid, userJid: MEMBER } })).role, "banned", "the row is updated, not duplicated");

    assert.deepEqual((await put(MEMBER, "regular")).json, { userJid: MEMBER, role: "regular" });
    assert.equal(await db.GroupRole.count({ where: { groupJid: jid, userJid: MEMBER } }), 0, "regular deletes the row");
    assert.deepEqual((await http.get(url(jid, "/roles"))).json.items.map((i) => i.userJid), [MEMBER2]);

    const audits = (await auditRows()).filter((r) => r.action === "group.role");
    assert.equal(audits.length, 4);
    assert.deepEqual(audits.map((r) => JSON.parse(r.detail).role), ["vip", "muted", "banned", "regular"]);
    assert.ok(audits.every((r) => r.target === jid));
  });

  test("both identity forms: a LID is stored under the phone-number form, and one row never becomes two", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());

    // as LID: stored as PN
    const byLid = await http.api("PUT", url(jid, `/roles/${enc(MEMBER_LID)}`), { role: "vip" });
    assert.equal(byLid.json.userJid, MEMBER);
    assert.deepEqual((await db.GroupRole.findAll({ where: { groupJid: jid }, raw: true })).map((r) => r.userJid), [MEMBER]);

    // an older row stored under the LID is replaced when the role is set by phone number
    await db.GroupRole.destroy({ where: { groupJid: jid } });
    await db.GroupRole.create({ groupJid: jid, userJid: MEMBER_LID, role: "muted" });
    await http.api("PUT", url(jid, `/roles/${enc(MEMBER)}`), { role: "vip" });
    assert.deepEqual((await db.GroupRole.findAll({ where: { groupJid: jid }, raw: true })).map((r) => [r.userJid, r.role]), [[MEMBER, "vip"]]);

    // regular removes both forms
    await db.GroupRole.create({ groupJid: jid, userJid: MEMBER_LID, role: "banned" });
    await http.api("PUT", url(jid, `/roles/${enc(MEMBER_LID)}`), { role: "regular" });
    assert.equal(await db.GroupRole.count({ where: { groupJid: jid } }), 0);

    // a bare number is a phone number
    assert.equal((await http.api("PUT", url(jid, "/roles/237600000002"), { role: "vip" })).json.userJid, MEMBER);
  });

  test("guardTarget: the bot, an owner and the group creator cannot be muted or banned (422 target_protected)", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());

    for (const user of [BOT_PN, BOT_LID, OWNER, OWNER_LID, CREATOR]) {
      for (const role of ["muted", "banned"]) {
        const answer = await http.api("PUT", url(jid, `/roles/${enc(user)}`), { role });
        assert.equal(answer.status, 422, `${user} ${role}`);
        assert.equal(code(answer), "target_protected");
      }
    }
    assert.equal(await db.GroupRole.count(), 0);
    assert.deepEqual(await auditRows(), []);
    // vip and regular are harmless for anybody (the plugin only guards the two restrictive roles)
    assert.equal((await http.api("PUT", url(jid, `/roles/${enc(OWNER)}`), { role: "vip" })).status, 200);
  });

  test("muted and banned need the connection and a current group; vip and regular do not", async () => {
    t = await createTestAdmin({ setup: { sudo: "237600000001" } });
    const http = await t.loginClient();
    const jid = await addGroup(newGroup());
    assert.equal(code(await http.api("PUT", url(jid, `/roles/${enc(MEMBER)}`), { role: "muted" })), "not_connected");
    assert.equal((await http.api("PUT", url(jid, `/roles/${enc(MEMBER)}`), { role: "vip" })).status, 200);
    assert.equal((await http.api("PUT", url(jid, `/roles/${enc(MEMBER)}`), { role: "regular" })).status, 200);
  });

  test("validation: role, user JID shape, unknown properties", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    assert.equal(fieldsOf(await http.api("PUT", url(jid, `/roles/${enc(MEMBER)}`), { role: "admin" })).role.code, "not_allowed");
    assert.equal(fieldsOf(await http.api("PUT", url(jid, `/roles/${enc(MEMBER)}`), {})).role.code, "required");
    assert.equal(fieldsOf(await http.api("PUT", url(jid, `/roles/${enc(MEMBER)}`), { role: "vip", setBy: "x" })).$unknown.code, "unknown_field");
    assert.equal((await http.api("PUT", url(jid, "/roles/abc"), { role: "vip" })).status, 404);
    assert.equal((await http.api("PUT", url(jid, "/roles/12"), { role: "vip" })).status, 404, "too short to be a number");
    assert.equal((await http.api("PUT", url(jid, `/roles/${enc("status@broadcast")}`), { role: "vip" })).status, 404);
    assert.equal((await http.api("PUT", url(G(994), `/roles/${enc(MEMBER)}`), { role: "vip" })).status, 404);
  });
});

// ---------------------------------------------------------------------------
// GRP-14..16 warnings
// ---------------------------------------------------------------------------

describe("GRP-14..16 warnings", () => {
  async function seedWarnings(jid) {
    await db.Warn.bulkCreate([
      { jid: MEMBER, groupJid: jid, count: 2, reason: "spam" },
      { jid: MEMBER2, groupJid: jid, count: 1, reason: "link" },
    ]);
  }

  test("GRP-14: members with a warning, highest count first, with the limit", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    await seedWarnings(jid);
    await db.Warn.create({ jid: "237600000099@s.whatsapp.net", groupJid: jid, count: 0 });
    const answer = await http.get(url(jid, "/warnings"));
    assert.equal(answer.status, 200);
    assert.equal(answer.json.limit, config.WARN_LIMIT);
    assert.deepEqual(answer.json.items.map((i) => [i.jid, i.count, i.reason]), [[MEMBER, 2, "spam"], [MEMBER2, 1, "link"]]);
    assert.match(answer.json.items[0].updatedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(code(await http.get(url(G(993), "/warnings"))), "not_found");
  });

  test("GRP-15: resets one member, whichever identity form the row uses; an unknown member resets 0", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    await seedWarnings(jid);

    const byPn = await http.api("DELETE", url(jid, `/warnings/${enc(MEMBER)}`));
    assert.deepEqual(byPn.json, { reset: 1 });
    assert.equal(await db.Warn.count({ where: { groupJid: jid } }), 1);

    // the row is stored under the LID; the panel asks with the phone number (and the other way round)
    await db.Warn.create({ jid: MEMBER_LID, groupJid: jid, count: 3, reason: "x" });
    assert.deepEqual((await http.api("DELETE", url(jid, `/warnings/${enc(MEMBER)}`))).json, { reset: 1 });
    await db.Warn.create({ jid: MEMBER, groupJid: jid, count: 1, reason: "y" });
    assert.deepEqual((await http.api("DELETE", url(jid, `/warnings/${enc(MEMBER_LID)}`))).json, { reset: 1 });

    assert.deepEqual((await http.api("DELETE", url(jid, `/warnings/${enc("237600000077@s.whatsapp.net")}`))).json, { reset: 0 });
    assert.equal(await db.Warn.count({ where: { groupJid: jid, jid: MEMBER2 } }), 1, "others are kept");
    const audits = (await auditRows()).filter((r) => r.action === "group.warnings");
    assert.equal(audits.length, 4);
    assert.deepEqual(JSON.parse(audits[0].detail), { op: "reset", userJid: MEMBER, reset: 1 });
  });

  test("GRP-16: resets the whole group behind confirm=true, other groups untouched", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    const other = await addGroup(newGroup());
    await seedWarnings(jid);
    await seedWarnings(other);

    for (const query of ["", "?confirm=false"]) {
      const refused = await http.api("DELETE", `${url(jid, "/warnings")}${query}`);
      assert.equal(refused.status, 409);
      assert.equal(code(refused), "confirmation_required");
    }
    assert.equal(await db.Warn.count({ where: { groupJid: jid } }), 2);

    const answer = await http.api("DELETE", `${url(jid, "/warnings")}?confirm=true`);
    assert.deepEqual(answer.json, { reset: 2 });
    assert.equal(await db.Warn.count({ where: { groupJid: jid } }), 0);
    assert.equal(await db.Warn.count({ where: { groupJid: other } }), 2);
    const [audit] = await auditRows();
    assert.equal(audit.action, "group.warnings");
    assert.deepEqual(JSON.parse(audit.detail), { op: "reset_all", reset: 2 });
  });
});

// ---------------------------------------------------------------------------
// GRP-17
// ---------------------------------------------------------------------------

describe("GRP-17", () => {
  test("disable and enable commands in this group only; aliases and the prefix resolve to the command", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    const other = await addGroup(newGroup());
    const entry = registry.getCommandByPattern("ping");
    assert.ok(entry, "the plugins are loaded");
    const helpName = registry.getCommandByPattern("help").name;

    const off = await http.api("PATCH", url(jid, "/commands"), { disable: ["PING", ".help"] });
    assert.equal(off.status, 200);
    assert.deepEqual(off.json, { disabledCommands: ["ping", helpName].sort(), warnings: [] });
    assert.deepEqual((await db.CommandState.findAll({ where: { scope: jid }, raw: true })).map((r) => r.command).sort(), ["ping", helpName].sort());

    // the engine the registry asks: disabled here, not in the other group, not in private
    const message = (group) => ({ isGroup: true, jid: group });
    assert.equal(await commandState.isDisabled(entry, message(jid)), true);
    assert.equal(await commandState.isDisabled(entry, message(other)), false);
    assert.equal(await commandState.isDisabled(entry, { isGroup: false, jid: MEMBER }), false);
    assert.deepEqual((await http.get(url(jid))).json.disabledCommands, off.json.disabledCommands, "GRP-3 shows them");

    const on = await http.api("PATCH", url(jid, "/commands"), { enable: ["ping"], disable: [] });
    assert.deepEqual(on.json.disabledCommands, [helpName]);
    assert.equal(await commandState.isDisabled(entry, message(jid)), false, "enabled again, with no wait for the cache TTL");

    const audits = (await auditRows()).filter((r) => r.action === "command.toggle");
    assert.equal(audits.length, 3, "one row per command changed");
    assert.deepEqual(
      audits.map((r) => [r.target, JSON.parse(r.detail).scope, JSON.parse(r.detail).disabled]),
      [["ping", jid, true], [helpName, jid, true], ["ping", jid, false]],
    );
  });

  test("the same rules as CMD-2: idempotent, lock-out warnings, orphans, unknown commands", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    const patch = (body) => http.api("PATCH", url(jid, "/commands"), body);

    assert.equal((await patch({ disable: ["ping"] })).status, 200);
    assert.deepEqual((await patch({ disable: ["ping"] })).json.disabledCommands, ["ping"], "idempotent");
    assert.equal(await db.CommandState.count({ where: { scope: jid } }), 1);

    const unban = await patch({ disable: ["unban"] });
    assert.deepEqual(unban.json.warnings, ["unban_disabled"], "the panel is then the only way back");
    const ban = await patch({ disable: ["ban"] });
    assert.ok(ban.json.warnings.includes("banchat_disabled"));

    assert.equal(code(await patch({ disable: ["nosuchcommand"] })), "not_found");
    assert.deepEqual((await http.api("PATCH", url(jid, "/commands"), { disable: ["nosuchcommand"] })).json.error.params, { resource: "command" });
    // an orphan row (a renamed command) can be enabled
    await db.CommandState.create({ command: "oldname", scope: jid });
    commandState.invalidate();
    assert.equal((await patch({ enable: ["oldname"] })).status, 200);
    assert.equal(await db.CommandState.count({ where: { command: "oldname" } }), 0);
    // enabling something that was never disabled is fine
    assert.equal((await patch({ enable: ["ping", "nosuchcommand"] })).status, 200);
  });

  test("validation: at least one list, no name in both, at most 200 names, strict body", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    const patch = (body) => http.api("PATCH", url(jid, "/commands"), body);

    assert.equal(code(await patch({})), "validation_failed");
    assert.equal(code(await patch({ disable: [], enable: [] })), "validation_failed");
    assert.equal(fieldsOf(await patch({ disable: ["ping"], enable: ["ping"] })).disable.code, "invalid_format");
    assert.equal(fieldsOf(await patch({ disable: Array.from({ length: 201 }, (_, i) => `c${i}`) })).disable.code, "too_many_items");
    assert.equal(fieldsOf(await patch({ disable: "ping" })).disable.code, "invalid_type");
    assert.equal(fieldsOf(await patch({ disable: [""] })).disable.code, "too_short");
    assert.equal(fieldsOf(await patch({ disable: ["ping"], scope: "*" })).$unknown.code, "unknown_field");
    assert.equal(code(await http.api("PATCH", url(G(992), "/commands"), { disable: ["ping"] })), "not_found");
    assert.equal(await db.CommandState.count(), 0);
  });
});

// ---------------------------------------------------------------------------
// GRD-1 / GRD-2
// ---------------------------------------------------------------------------

describe("GRD-1", () => {
  test("saves antilink and antibot, audits the change, answers the flags", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    const put = (body) => http.api("PUT", url(jid, "/guard"), body);

    assert.deepEqual((await put({ antilink: true })).json, { antilink: true, antibot: false, warnings: [] });
    assert.deepEqual((await put({ antibot: true })).json, { antilink: true, antibot: true, warnings: [] });
    assert.deepEqual((await put({ antilink: false, antibot: false })).json, { antilink: false, antibot: false, warnings: [] });
    const row = await groupRow(jid);
    assert.equal(row.antilink, 0);
    assert.equal(row.antibot, 0);

    const audits = (await auditRows()).filter((r) => r.action === "group.guard");
    assert.deepEqual(audits.map((r) => JSON.parse(r.detail)), [{ antilink: true }, { antibot: true }, { antilink: false, antibot: false }]);
    assert.ok(audits.every((r) => r.target === jid));
  });

  test("the switches are saved even when the bot is not an administrator, with the warning (FR-032)", async () => {
    const { http } = await boot({ botAdmin: false });
    const jid = await addGroup(newGroup());
    const answer = await http.api("PUT", url(jid, "/guard"), { antilink: true });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { antilink: true, antibot: false, warnings: ["bot_not_admin"] });
    assert.equal((await groupRow(jid)).antilink, 1, "saved anyway");
    assert.deepEqual((await http.api("PUT", url(jid, "/guard"), { antilink: false })).json.warnings, [], "nothing on: no warning");
  });

  test("validation: at least one boolean, nothing else", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    assert.equal(code(await http.api("PUT", url(jid, "/guard"), {})), "validation_failed");
    assert.equal(fieldsOf(await http.api("PUT", url(jid, "/guard"), { antilink: "on" })).antilink.code, "invalid_type");
    assert.equal(fieldsOf(await http.api("PUT", url(jid, "/guard"), { antilink: true, mute: true })).$unknown.code, "unknown_field");
    assert.equal(code(await http.api("PUT", url(G(991), "/guard"), { antilink: true })), "not_found");
    assert.equal(await groupRow(jid), null, "nothing written");
    assert.deepEqual(await auditRows(), []);
  });

  test("the guard takes effect on the next message (FR-030): a link is deleted, with no wait for the cache TTL", async () => {
    const { http, say, sock } = await boot();
    const jid = await addGroup(newGroup());
    const link = () => say({ body: "see https://spam.example", from: MEMBER, group: jid });

    // warm the cached `group:<jid>` row while the guard is off
    await link();
    assert.equal(sock.sent.filter((s) => s.kind === "delete").length, 0);

    await http.api("PUT", url(jid, "/guard"), { antilink: true });
    await link();
    assert.equal(sock.sent.filter((s) => s.kind === "delete").length, 1, "deleted right after the toggle");
    assert.equal((await db.Warn.findOne({ where: { groupJid: jid } })).count, 1);

    await http.api("PUT", url(jid, "/guard"), { antilink: false });
    await link();
    assert.equal(sock.sent.filter((s) => s.kind === "delete").length, 1, "and left alone again");
  });
});

describe("GRD-2", () => {
  /** A bot that records the setting updates it is asked for. */
  function recordSetting(sock, { fail } = {}) {
    sock.settingCalls = [];
    sock.groupSettingUpdate = async (jid, setting) => {
      sock.settingCalls.push([jid, setting]);
      if (fail) throw fail;
    };
  }

  test("calls groupSettingUpdate and only a success writes Group.mute; audit group.mute", async () => {
    const { http, sock } = await boot();
    recordSetting(sock);
    const jid = await addGroup(newGroup());

    const mute = await http.api("PUT", url(jid, "/mute"), { muted: true });
    assert.deepEqual(mute.json, { muted: true });
    assert.deepEqual(sock.settingCalls, [[jid, "announcement"]]);
    assert.equal((await groupRow(jid)).mute, 1);
    assert.equal((await http.get(url(jid))).json.mute, true);

    const unmute = await http.api("PUT", url(jid, "/mute"), { muted: false });
    assert.deepEqual(unmute.json, { muted: false });
    assert.deepEqual(sock.settingCalls[1], [jid, "not_announcement"]);
    assert.equal((await groupRow(jid)).mute, 0);

    const audits = (await auditRows()).filter((r) => r.action === "group.mute");
    assert.deepEqual(audits.map((r) => JSON.parse(r.detail)), [{ muted: true }, { muted: false }]);
    assert.ok(audits.every((r) => r.target === jid));
  });

  test("409 bot_not_admin: refused, WhatsApp is not called, nothing written", async () => {
    const { http, sock } = await boot({ botAdmin: false });
    recordSetting(sock);
    const jid = await addGroup(newGroup());
    const answer = await http.api("PUT", url(jid, "/mute"), { muted: true });
    assert.equal(answer.status, 409);
    assert.equal(code(answer), "bot_not_admin");
    assert.deepEqual(sock.settingCalls, []);
    assert.equal(await groupRow(jid), null);
    assert.deepEqual(await auditRows(), []);
  });

  test("409 not_connected without a connection", async () => {
    t = await createTestAdmin({ setup: { sudo: "237600000001" } });
    const http = await t.loginClient();
    const jid = await addGroup(newGroup());
    const answer = await http.api("PUT", url(jid, "/mute"), { muted: true });
    assert.equal(answer.status, 409);
    assert.equal(code(answer), "not_connected");
    assert.equal(await groupRow(jid), null);
  });

  test("409 group_left for a former group and for a group WhatsApp no longer lets the bot read", async () => {
    const { http, sock } = await boot();
    recordSetting(sock);
    const former = await addGroup(newGroup(), { chat: { leftAt: new Date(t.clock.now()) } });
    assert.equal(code(await http.api("PUT", url(former, "/mute"), { muted: true })), "group_left");

    const jid = await addGroup(newGroup());
    sock.metadataError = Object.assign(new Error("item-not-found"), { data: 404 });
    assert.equal(code(await http.api("PUT", url(jid, "/mute"), { muted: true })), "group_left");
    sock.metadataError = null;
    sock.groupSettingUpdate = async () => {
      throw Object.assign(new Error("forbidden"), { data: 403 });
    };
    assert.equal(code(await http.api("PUT", url(jid, "/mute"), { muted: true })), "group_left");
    assert.equal(await groupRow(jid), null);
    assert.deepEqual(sock.settingCalls, []);
  });

  test("502 whatsapp_error when WhatsApp refuses the update: Group.mute is left as it was", async () => {
    const { http, sock } = await boot();
    recordSetting(sock, { fail: new Error("rate-overlimit with-a-secret-detail") });
    const jid = await addGroup(newGroup(), { group: { mute: false } });
    const answer = await http.api("PUT", url(jid, "/mute"), { muted: true });
    assert.equal(answer.status, 502);
    assert.equal(code(answer), "whatsapp_error");
    assert.ok(!answer.text.includes("secret-detail"));
    assert.equal(sock.settingCalls.length, 1, "it was attempted");
    assert.equal((await groupRow(jid)).mute, 0, "nothing written on failure");
    assert.deepEqual((await auditRows()).filter((r) => r.action === "group.mute"), []);
  });

  test("validation", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    assert.equal(fieldsOf(await http.api("PUT", url(jid, "/mute"), {})).muted.code, "required");
    assert.equal(fieldsOf(await http.api("PUT", url(jid, "/mute"), { muted: "yes" })).muted.code, "invalid_type");
    assert.equal(fieldsOf(await http.api("PUT", url(jid, "/mute"), { muted: true, mute: true })).$unknown.code, "unknown_field");
    assert.equal(code(await http.api("PUT", url(G(990), "/mute"), { muted: true })), "not_found");
  });
});

// ---------------------------------------------------------------------------
// CHAT-1..3
// ---------------------------------------------------------------------------

describe("CHAT-1..3", () => {
  const P = (n) => `2376000${String(n).padStart(5, "0")}@s.whatsapp.net`;

  async function seedChats() {
    const at = new Date(Date.UTC(2026, 0, 1));
    const later = (days) => new Date(at.getTime() + days * 86400000);
    await db.KnownChat.bulkCreate([
      { jid: P(1), kind: "private", pnJid: P(1), name: "Alice", firstSeenAt: at, lastSeenAt: later(5) },
      { jid: P(2), kind: "private", pnJid: P(2), name: "Bob", firstSeenAt: at, lastSeenAt: later(4) },
      { jid: "99000000002@lid", kind: "private", pnJid: P(2), name: "Bob (LID)", firstSeenAt: at, lastSeenAt: later(1) },
      { jid: P(3), kind: "private", pnJid: P(3), name: "Carol", firstSeenAt: at, lastSeenAt: later(3) },
      { jid: G(1), kind: "group", name: "Chess club", firstSeenAt: at, lastSeenAt: later(2) },
      { jid: G(2), kind: "group", name: "Old group", firstSeenAt: at, lastSeenAt: later(2), leftAt: later(3) },
    ]);
    await db.BannedChat.create({ jid: P(3), bannedBy: null });
  }

  test("CHAT-1: the picker, filtered by kind and q, paged, de-duplicated; selectable keeps valid destinations only", async () => {
    const { http } = await boot();
    await seedChats();

    const all = await http.get("/admin/api/chats");
    assert.equal(all.status, 200);
    assert.deepEqual(Object.keys(all.json).sort(), ["items", "page", "pageSize", "total"]);
    assert.deepEqual(all.json.items.map((i) => i.jid), [P(1), P(2), P(3), G(1), G(2)], "newest first, Bob and Bob (LID) are one person");
    assert.deepEqual(Object.keys(all.json.items[0]).sort(), ["jid", "kind", "lastSeenAt", "name", "selectable"]);
    assert.equal(all.json.items.find((i) => i.jid === P(3)).selectable, false, "disabled chat");
    assert.equal(all.json.items.find((i) => i.jid === G(2)).selectable, false, "former group");
    assert.equal(all.json.items.find((i) => i.jid === G(1)).selectable, true);

    assert.deepEqual((await http.get("/admin/api/chats?kind=group")).json.items.map((i) => i.jid), [G(1), G(2)]);
    assert.deepEqual((await http.get("/admin/api/chats?kind=private&selectable=1")).json.items.map((i) => i.jid), [P(1), P(2)]);
    assert.deepEqual((await http.get("/admin/api/chats?selectable=1")).json.items.map((i) => i.jid), [P(1), P(2), G(1)]);
    assert.deepEqual((await http.get("/admin/api/chats?q=ALI")).json.items.map((i) => i.jid), [P(1)]);
    const paged = await http.get("/admin/api/chats?pageSize=2&page=2");
    assert.deepEqual(paged.json.items.map((i) => i.jid), [P(3), G(1)]);
    assert.equal(paged.json.total, 5);
    assert.equal(paged.json.page, 2);
    assert.equal(paged.json.pageSize, 2);
  });

  test("CHAT-1: a strict query", async () => {
    const { http } = await boot();
    assert.equal(fieldsOf(await http.get("/admin/api/chats?kind=channel")).kind.code, "not_allowed");
    assert.equal(fieldsOf(await http.get("/admin/api/chats?selectable=yes")).selectable.code, "not_allowed");
    assert.equal(fieldsOf(await http.get("/admin/api/chats?pageSize=500")).pageSize.code, "out_of_range");
    assert.equal(fieldsOf(await http.get("/admin/api/chats?number=1")).$unknown.code, "unknown_field");
  });

  test("CHAT-2 lists every disabled chat; CHAT-3 enables one, invalidates the cache and audits", async () => {
    const { http, say } = await boot();
    await seedChats();
    const group = await addGroup(newGroup(), { chat: { name: "Muted group" } });
    await db.BannedChat.create({ jid: group, bannedBy: OWNER });

    const list = await http.get("/admin/api/chats/disabled");
    assert.equal(list.status, 200);
    const byJid = Object.fromEntries(list.json.items.map((i) => [i.jid, i]));
    assert.deepEqual(Object.keys(byJid).sort(), [P(3), group].sort());
    assert.deepEqual(byJid[P(3)], { jid: P(3), kind: "private", name: "Carol", since: byJid[P(3)].since });
    assert.deepEqual([byJid[group].kind, byJid[group].name], ["group", "Muted group"]);
    assert.match(byJid[group].since, /^\d{4}-\d\d-\d\dT/);

    // the bot is silent there until CHAT-3
    const ping = () => say({ body: ".ping", from: MEMBER, group });
    await pipeline.getBannedChats(); // warm the cached set
    assert.deepEqual(await ping(), []);
    const enabled = await http.api("DELETE", `/admin/api/chats/disabled/${enc(group)}`);
    assert.deepEqual(enabled.json, { enabled: true });
    assert.ok((await ping()).length > 0, "answers again at once");
    assert.equal(await db.BannedChat.count({ where: { jid: group } }), 0);

    // a private chat, with its JID encoded in the path
    assert.deepEqual((await http.api("DELETE", `/admin/api/chats/disabled/${enc(P(3))}`)).json, { enabled: true });
    assert.equal((await http.get("/admin/api/chats/disabled")).json.items.length, 0);

    const audits = await auditRows();
    assert.deepEqual(audits.map((r) => [r.action, r.target]), [["chat.enable", group], ["chat.enable", P(3)]]);
  });

  test("CHAT-3: 404 when the chat is not disabled; a path that is not a chat JID is 404 too", async () => {
    const { http } = await boot();
    assert.equal(code(await http.api("DELETE", `/admin/api/chats/disabled/${enc(G(1))}`)), "not_found");
    assert.deepEqual((await http.api("DELETE", `/admin/api/chats/disabled/${enc(P(9))}`)).json.error.params, { resource: "chat" });
    for (const bad of ["abc", enc("status@broadcast"), enc("123@g.us"), enc("237600000001@newsletter")]) {
      assert.equal((await http.api("DELETE", `/admin/api/chats/disabled/${bad}`)).status, 404, bad);
    }
    assert.deepEqual(await auditRows(), []);
  });
});

// ---------------------------------------------------------------------------
// FR-030: the plugin's own reader sees a panel write at once
// ---------------------------------------------------------------------------

describe("FR-030 cache coherence", () => {
  test(".welcome: the welcome message is posted right after the panel switched it on", async () => {
    const { http, participantsUpdate } = await boot();
    const jid = await addGroup(newGroup());

    assert.deepEqual(await participantsUpdate({ id: jid, action: "add", participants: [MEMBER2] }), [], "off: silent (and the row is cached)");
    await http.api("PATCH", url(jid), { welcome: { enabled: true, message: "Panel says hello @user, welcome to @group" } });
    const sent = textsOf(await participantsUpdate({ id: jid, action: "add", participants: [MEMBER2] }));
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^Panel says hello @237600000003, welcome to Test group$/);

    await http.api("PATCH", url(jid), { welcome: { message: null } });
    assert.equal(
      textsOf(await participantsUpdate({ id: jid, action: "add", participants: [MEMBER2] }))[0],
      renderTemplate(getLang("plugins.setwelcome.default_message"), { user: "@237600000003", group: "Test group", desc: "A description" }),
      "the default message again",
    );
    await http.api("PATCH", url(jid), { welcome: { enabled: false } });
    assert.deepEqual(await participantsUpdate({ id: jid, action: "add", participants: [MEMBER2] }), []);

    // goodbye is read through the same cached row
    assert.deepEqual(await participantsUpdate({ id: jid, action: "remove", participants: [MEMBER2] }), []);
    await http.api("PATCH", url(jid), { goodbye: { enabled: true, message: "Bye from the panel @user" } });
    assert.deepEqual(textsOf(await participantsUpdate({ id: jid, action: "remove", participants: [MEMBER2] })), ["Bye from the panel @237600000003"]);
  });

  test(".filter: a filter added in the panel answers at once; an edit and a delete too", async () => {
    const { http, say } = await boot();
    const jid = await addGroup(newGroup());
    const hello = () => say({ body: "hello everybody", from: MEMBER, group: jid }).then(textsOf);
    cooldown.reset(jid, "filter:hello");

    assert.deepEqual(await hello(), [], "no filter yet (an empty list is cached)");
    const { filter } = (await http.api("POST", url(jid, "/filters"), { pattern: "Hello", response: "Panel answer" })).json;
    cooldown.reset(jid, "filter:hello");
    assert.deepEqual(await hello(), ["Panel answer"]);
    await http.api("PUT", url(jid, `/filters/${filter.id}`), { pattern: "hello", response: "Edited answer" });
    cooldown.reset(jid, "filter:hello");
    assert.deepEqual(await hello(), ["Edited answer"]);
    // the command lists it too
    const list = textsOf(await say({ body: ".filter list", from: OWNER, group: jid }));
    assert.match(list.join("\n"), /hello/);
    await http.api("DELETE", url(jid, `/filters/${filter.id}`));
    cooldown.reset(jid, "filter:hello");
    assert.deepEqual(await hello(), [], "deleted");
  });

  test(".role: a role set in the panel is enforced and listed at once", async () => {
    const { http, say, sock } = await boot();
    const jid = await addGroup(newGroup());
    const deletes = () => sock.sent.filter((s) => s.kind === "delete").length;

    await say({ body: "first", from: MEMBER, group: jid }); // caches the (empty) roles of the group
    assert.equal(deletes(), 0);
    await http.api("PUT", url(jid, `/roles/${enc(MEMBER)}`), { role: "muted" });
    await say({ body: "second", from: MEMBER, group: jid });
    assert.equal(deletes(), 1, "a muted member's message is deleted by the role hook");

    const list = textsOf(await say({ body: ".role list", from: OWNER, group: jid })).join("\n");
    assert.match(list, /@237600000002/);

    await http.api("PUT", url(jid, `/roles/${enc(MEMBER)}`), { role: "regular" });
    await say({ body: "third", from: MEMBER, group: jid });
    assert.equal(deletes(), 1, "regular again");
  });

  test(".warn: warnings reset in the panel are gone from .warn list at once", async () => {
    const { http, say } = await boot();
    const jid = await addGroup(newGroup());
    await db.Warn.create({ jid: MEMBER, groupJid: jid, count: 2, reason: "spam" });
    const list = async () => textsOf(await say({ body: ".warn list", from: OWNER, group: jid })).join("\n");

    assert.match(await list(), /@237600000002/);
    await http.api("DELETE", url(jid, `/warnings/${enc(MEMBER)}`));
    assert.equal(await list(), getLang("plugins.warnuser.list_empty"));
  });

  test("GRP-17: the registry's engine sees a toggle at once", async () => {
    const { http } = await boot();
    const jid = await addGroup(newGroup());
    const entry = registry.getCommandByPattern("ping");
    const isOff = () => commandState.isDisabled(entry, { isGroup: true, jid });
    assert.equal(await isOff(), false, "(caches the empty state)");
    await http.api("PATCH", url(jid, "/commands"), { disable: ["ping"] });
    assert.equal(await isOff(), true);
    await http.api("DELETE", `${url(jid)}?confirm=true`);
    assert.equal(await isOff(), false, "deleting the group's settings enables its commands again");
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describe("audit", () => {
  test("every write leaves one row with the vocabulary of 1.15, an origin and no secret; reads and refusals leave none", async () => {
    const { http, sock } = await boot();
    sock.groupSettingUpdate = async () => {};
    const jid = await addGroup(newGroup());
    const user = encodeURIComponent(MEMBER);

    const writes = [
      ["PATCH", url(jid), { welcome: { enabled: true } }, "group.update"],
      ["PUT", url(jid, "/guard"), { antilink: true }, "group.guard"],
      ["PUT", url(jid, "/mute"), { muted: true }, "group.mute"],
      ["POST", url(jid, "/filters"), { pattern: "a", response: "b" }, "group.filter"],
      ["PUT", url(jid, `/roles/${user}`), { role: "vip" }, "group.role"],
      ["DELETE", url(jid, `/warnings/${user}`), undefined, "group.warnings"],
      ["PATCH", url(jid, "/commands"), { disable: ["ping"] }, "command.toggle"],
    ];
    for (const [method, path, body, action] of writes) {
      const before = (await auditRows({ action })).length;
      const answer = await http.api(method, path, body);
      assert.ok(answer.status < 300, `${method} ${path} -> ${answer.status}`);
      assert.equal((await auditRows({ action })).length, before + 1, action);
    }

    // reads, previews, refusals
    const count = (await auditRows()).length;
    await http.get(url(jid));
    await http.get(url(jid, "/filters"));
    await http.get("/admin/api/groups");
    await http.get("/admin/api/chats");
    await http.api("POST", url(jid, "/preview"), { kind: "welcome", message: "x" });
    await http.api("PATCH", url(jid), { welcome: { message: "@nobody" } });
    await http.api("PUT", url(jid, "/guard"), {});
    await http.api("DELETE", url(jid)); // no confirm
    assert.equal((await auditRows()).length, count);

    const rows = await auditRows();
    assert.ok(rows.every((r) => r.origin && r.result === "ok"), "origin and result are filled");
    assert.ok(rows.every((r) => !/token|password|secret/i.test(r.detail || "")));
  });
});
