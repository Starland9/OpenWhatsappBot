"use strict";
/**
 * The API page's key routes (feature 004, contracts/admin-api.md sections 1.2, 1.4 to 1.7 and 2).
 *
 * Part 1: API-4 `GET /admin/api/api/keys` (order, KeyView, nothing secret) and API-5 `POST /admin/api/api/keys`
 * (every schema and semantic error with dotted paths and indices, the router's step-up gate, the limits, the names,
 * the `policy_anyone` confirmation, the secret returned once, the audit row).
 * Part 2: API-6 update, API-7 duplicate, API-8 revoke, the widening matrix and the audit rows (below).
 *
 * The real createAdmin, authentication, apiState and key store over an in-memory database and a fake clock; the engine
 * and the registries are the recording stand-ins of test/helpers/apiPanelKit.js. Offline.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { bootApiPanel } = require("./helpers/apiPanelKit");
const redactor = require("../lib/admin/logs/redactor");
const { widenings } = require("../lib/admin/services/api");

const WIDENINGS = JSON.parse(fs.readFileSync(path.join(fakes.ROOT, "test", "fixtures", "api-widenings.json"), "utf8"));

const P = "/admin/api/api";
const TOKEN = /^owbk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/;
const A = "237690000001@s.whatsapp.net";
const B = "237690000002@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";

let kit;
afterEach(async () => {
  if (kit) await kit.close();
  kit = null;
});

const boot = async (options) => {
  kit = await bootApiPanel(options);
  return kit;
};
const errorOf = (res) => (res.json && res.json.error) || {};

/** A valid KeyInput body; `over` replaces top-level properties */
const body = (over = {}) => ({
  name: "n8n",
  rights: ["messages.send.text"],
  policy: { mode: "list", recipients: [A] },
  limits: { perMinute: null, perDay: 500, maxPending: null },
  ipAllow: [],
  expiresAt: null,
  ...over,
});
const create = (over) => kit.post(`${P}/keys`, body(over));

// ---------------------------------------------------------------------------------------------------------------
// API-4
// ---------------------------------------------------------------------------------------------------------------

describe("API-4 GET /admin/api/api/keys", () => {
  test("an empty install lists nothing; there is no GET on a single key (405)", async () => {
    await boot();
    const res = await kit.get(`${P}/keys`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { items: [] });
    const one = await kit.get(`${P}/keys/1`);
    assert.equal(one.status, 405);
    assert.match(String(one.headers.get("allow")), /PUT/);
  });

  test("order: non-revoked keys by id ascending, then revoked keys by revokedAt descending", async () => {
    await boot();
    const t0 = kit.clock.now();
    const k1 = await kit.makeKey({ name: "one" });
    const r1 = await kit.makeKey({ name: "revoked early", revokedAt: new Date(t0 - 3000) });
    const k2 = await kit.makeKey({ name: "two", expiresAt: new Date(t0 - 1000) });
    const r2 = await kit.makeKey({ name: "revoked late", revokedAt: new Date(t0 - 1000) });
    const k3 = await kit.makeKey({ name: "three" });
    const res = await kit.get(`${P}/keys`);
    assert.deepEqual(res.json.items.map((k) => k.id), [k1.id, k2.id, k3.id, r2.id, r1.id]);
    assert.deepEqual(res.json.items.map((k) => k.status), ["active", "expired", "active", "revoked", "revoked"]);
  });

  test("KeyView: the documented fields, the stored values, and nothing secret", async () => {
    await boot();
    const key = await kit.makeKey({
      name: "Shop",
      rights: ["messages.send.video", "gone.module", "messages.send.text"],
      policyMode: "known",
      recipients: [A, GROUP],
      limitPerMinute: 5,
      limitPerDay: null,
      limitPending: 20,
      ipAllow: ["10.0.0.0/8"],
      expiresAt: new Date(kit.clock.now() + 86400000),
      seenIps: ["10.0.0.1", "10.0.0.2", "10.0.0.3"],
      lastIp: "10.0.0.3",
      lastUsedAt: new Date(kit.clock.now() - 60000),
    });
    const [view] = (await kit.get(`${P}/keys`)).json.items;
    assert.deepEqual(Object.keys(view).sort(), [
      "createdAt", "expiresAt", "id", "ipAllow", "last4", "lastUsedAt", "lastUsedIp", "limits", "name", "orphanRights", "policy",
      "queued", "revokedAt", "rights", "seenIpCount", "status", "updatedAt", "version",
    ]);
    assert.equal(view.id, key.id);
    assert.equal(view.name, "Shop");
    assert.equal(view.last4, key.row.last4);
    assert.equal(view.status, "active");
    assert.equal(view.version, 1);
    assert.deepEqual(view.rights, ["gone.module", "messages.send.text", "messages.send.video"], "sorted");
    assert.deepEqual(view.orphanRights, ["gone.module"], "a right the catalogue no longer has");
    assert.deepEqual(view.policy, { mode: "known", recipients: [{ jid: A, name: null }, { jid: GROUP, name: null }] });
    assert.deepEqual(view.limits, { perMinute: 5, perDay: null, maxPending: 20 });
    assert.deepEqual(view.ipAllow, ["10.0.0.0/8"]);
    assert.equal(view.seenIpCount, 3);
    assert.equal(view.lastUsedIp, "10.0.0.3");
    assert.equal(view.lastUsedAt, new Date(kit.clock.now() - 60000).toISOString());
    assert.equal(view.revokedAt, null);
    assert.equal(view.queued, 0);

    const text = JSON.stringify((await kit.get(`${P}/keys`)).json);
    for (const secret of [key.lookupId, key.row.secretHash, key.secret, "10.0.0.1", "seenIps", "secretHash", "lookupId"]) {
      assert.ok(!text.includes(secret), `the list must not carry ${secret.slice(0, 12)}`);
    }
  });

  test("recipient names come from KnownChat (a person recorded under a LID is found by pnJid; a group by its subject)", async () => {
    await boot();
    await kit.makeKey({ name: "named", recipients: [A, B, GROUP] });
    const at = new Date(kit.clock.now());
    await kit.db.KnownChat.bulkCreate([
      { jid: "9988@lid", kind: "private", pnJid: A, name: "Awa", firstSeenAt: at, lastSeenAt: at },
      { jid: GROUP, kind: "group", name: "Family", firstSeenAt: at, lastSeenAt: at },
    ]);
    const [view] = (await kit.get(`${P}/keys`)).json.items;
    assert.deepEqual(view.policy.recipients, [{ jid: A, name: "Awa" }, { jid: B, name: null }, { jid: GROUP, name: "Family" }]);
  });

  test("queued counts this key's messages in 'queued'", async () => {
    await boot();
    const k1 = await kit.makeKey({ name: "busy" });
    const k2 = await kit.makeKey({ name: "idle" });
    await kit.makeMessage({ apiKeyId: k1.id, status: "queued" });
    await kit.makeMessage({ apiKeyId: k1.id, status: "queued" });
    await kit.makeMessage({ apiKeyId: k1.id, status: "sent" });
    await kit.makeMessage({ source: "panel", apiKeyId: null, status: "queued" });
    const items = (await kit.get(`${P}/keys`)).json.items;
    assert.deepEqual(items.map((k) => [k.id, k.queued]), [[k1.id, 2], [k2.id, 0]]);
  });

  test("while the registry failed, no right is called an orphan (the catalogue is empty and says nothing)", async () => {
    await boot({ failure: { endpoint: "messages.create" } });
    await kit.makeKey({ name: "k", rights: ["messages.send.text"] });
    assert.deepEqual((await kit.get(`${P}/keys`)).json.items[0].orphanRights, []);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// API-5
// ---------------------------------------------------------------------------------------------------------------

describe("API-5 POST /admin/api/api/keys: the schema", () => {
  test("every fault at once, dotted paths, indices only, no value echoed", async () => {
    await boot();
    const res = await kit.post(`${P}/keys`, {
      name: "",
      rights: ["messages.send.text", "messages.send.text", "Bad Right"],
      policy: { mode: "everyone", recipients: "nope" },
      limits: { perMinute: 0, perDay: 100001, maxPending: "many" },
      ipAllow: "all",
      expiresAt: 12,
      version: 3,
      confirm: ["policy_anyone", "sure"],
      secret: "SECRET-CANARY",
    });
    assert.equal(res.status, 422);
    const fields = errorOf(res).fields;
    assert.equal(fields.name.code, "too_short");
    assert.equal(fields["rights.1"].code, "duplicate");
    assert.equal(fields["rights.2"].code, "invalid_format");
    assert.equal(fields["policy.mode"].code, "not_allowed");
    assert.deepEqual(fields["policy.mode"].params, { allowed: ["list", "known", "anyone"] });
    assert.equal(fields["policy.recipients"].code, "invalid_type");
    assert.equal(fields["limits.perMinute"].code, "out_of_range");
    assert.deepEqual(fields["limits.perMinute"].params, { min: 1, max: 1000 });
    assert.deepEqual(fields["limits.perDay"].params, { min: 1, max: 100000 });
    assert.equal(fields["limits.maxPending"].code, "invalid_type");
    assert.equal(fields.ipAllow.code, "invalid_type");
    assert.equal(fields.expiresAt.code, "invalid_type");
    assert.equal(fields.confirm.code, "not_allowed");
    assert.deepEqual(fields.confirm.params, { allowed: ["policy_anyone"] });
    assert.equal(fields.$unknown.code, "unknown_field", "`version` and `secret` are unknown properties of a creation");
    assert.ok(!res.text.includes("SECRET-CANARY") && !res.text.includes("Bad Right"));
  });

  test("a required property missing, a nested unknown property, an over-long name and caps on the lists", async () => {
    await boot();
    const missing = await kit.post(`${P}/keys`, {});
    assert.deepEqual(Object.keys(errorOf(missing).fields).sort(), ["expiresAt", "ipAllow", "limits", "name", "policy", "rights"]);
    const nested = await create({ policy: { mode: "list", recipients: [], extra: true }, limits: { perDay: 1, speed: 3 } });
    assert.equal(errorOf(nested).fields["policy.$unknown"].code, "unknown_field");
    assert.equal(errorOf(nested).fields["limits.$unknown"].code, "unknown_field");
    const long = await create({ name: "é".repeat(65) });
    assert.equal(errorOf(long).fields.name.code, "too_long");
    assert.equal((await create({ name: "é".repeat(64) })).status, 201, "64 code points fit, however many bytes");
    const control = await create({ name: "line\nbreak" });
    assert.equal(errorOf(control).fields.name.code, "invalid_format");
    const tooMany = await create({ name: "caps", rights: Array.from({ length: 65 }, (_, i) => `r.x${i}`), ipAllow: Array(51).fill("10.0.0.1"), policy: { mode: "list", recipients: Array(201).fill(A) } });
    assert.equal(errorOf(tooMany).fields.rights.code, "too_many_items");
    assert.equal(errorOf(tooMany).fields.ipAllow.code, "too_many_items");
    assert.equal(errorOf(tooMany).fields["policy.recipients"].code, "too_many_items");
  });

  test("a validation failure comes before the password: a 422 is never asked for it", async () => {
    await boot();
    await kit.expireConfirmation();
    const res = await kit.post(`${P}/keys`, { name: "" });
    assert.equal(res.status, 422);
  });
});

describe("API-5 POST /admin/api/api/keys: the step-up gate", () => {
  test("without a recent password: 403 password_required after validation, nothing saved, nothing audited", async () => {
    await boot();
    await kit.expireConfirmation();
    const before = await kit.snapshot();
    const res = await create();
    assert.equal(res.status, 403);
    assert.equal(errorOf(res).code, "password_required");
    assert.deepEqual(errorOf(res).params, { windowMs: 300000 }, "the router asks: no reasons are supplied for a creation");
    assert.deepEqual(await kit.snapshot(), before);
    assert.equal((await kit.confirm()).status, 200);
    assert.equal((await create()).status, 201);
  });
});

describe("API-5 POST /admin/api/api/keys: the semantics", () => {
  test("rights outside the catalogue: not_allowed { allowed, indices }", async () => {
    await boot();
    const res = await create({ rights: ["messages.send.text", "nope.here", "messages.send.fax"] });
    assert.equal(res.status, 422);
    const field = errorOf(res).fields.rights;
    assert.equal(field.code, "not_allowed");
    assert.deepEqual(field.params.indices, [1, 2]);
    assert.deepEqual(field.params.allowed, ["messages.send.text", "messages.send.image", "messages.send.video", "messages.send.poll", "messages.read", "media.upload"]);
    assert.ok(!res.text.includes("nope.here"), "the submitted id is not echoed");
  });

  test("while the registry failed, nothing new can be granted", async () => {
    await boot({ failure: { endpoint: "messages.create" } });
    const res = await create({ rights: ["messages.send.text"] });
    assert.equal(errorOf(res).fields.rights.code, "not_allowed");
    assert.deepEqual(errorOf(res).fields.rights.params.allowed, []);
    assert.equal((await create({ rights: [] })).status, 201, "a key with no right is still allowed");
  });

  test("recipients: a typed number, a JID or a group id; one code per field with every failing index", async () => {
    await boot();
    const ok = await create({
      policy: { mode: "list", recipients: ["+237 6 90-00-00-03", "00237690000004", `${A}`, "237690000001", GROUP, " (237) 690.000.005 "] },
    });
    assert.equal(ok.status, 201, ok.text);
    assert.deepEqual(
      ok.json.key.policy.recipients.map((r) => r.jid),
      ["237690000003@s.whatsapp.net", "237690000004@s.whatsapp.net", A, GROUP, "237690000005@s.whatsapp.net"],
      "normalised, duplicates collapsed silently, first occurrence first",
    );

    const phone = await create({ name: "p", policy: { mode: "list", recipients: [A, "12345", "abc", "0690000003"] } });
    assert.deepEqual(errorOf(phone).fields["policy.recipients"], { code: "invalid_phone", params: { indices: [1, 2, 3] } });

    const lid = await create({ name: "l", policy: { mode: "list", recipients: ["12345678901234@lid", A, "237690000001:3@s.whatsapp.net", "x@s.whatsapp.net"] } });
    assert.deepEqual(errorOf(lid).fields["policy.recipients"], { code: "invalid_jid", params: { indices: [0, 2, 3] } }, "a LID or any other JID is invalid_jid");

    const mixed = await create({ name: "m", policy: { mode: "list", recipients: [A, "abc", "1@lid"] } });
    assert.deepEqual(errorOf(mixed).fields["policy.recipients"], { code: "invalid_phone", params: { indices: [1] } }, "the code of the first failing entry");
  });

  test("ipAllow: invalid_format with the indices; masks, IPv6 and the whole-space entries are accepted", async () => {
    await boot();
    const bad = await create({ ipAllow: ["10.0.0.1", "10.0.0.0/33", "host.example", "300.1.1.1"] });
    assert.deepEqual(errorOf(bad).fields.ipAllow, { code: "invalid_format", params: { indices: [1, 2, 3] } });
    assert.ok(!bad.text.includes("host.example"));
    const ok = await create({ ipAllow: ["10.1.2.3/8", "2001:DB8::1", "0.0.0.0/0", "::/0", "10.0.0.0/8"] });
    assert.equal(ok.status, 201, ok.text);
    assert.deepEqual(ok.json.key.ipAllow, ["10.0.0.0/8", "2001:db8::1", "0.0.0.0/0", "::/0"], "host bits masked, canonical form, duplicates collapsed");
  });

  test("expiresAt: ISO-8601 with Z or an offset; a past instant is in_past on a creation", async () => {
    await boot();
    const now = kit.clock.now();
    assert.equal(errorOf(await create({ expiresAt: "tomorrow" })).fields.expiresAt.code, "invalid_format");
    assert.equal(errorOf(await create({ expiresAt: "2026-03-01 10:00:00" })).fields.expiresAt.code, "invalid_format");
    assert.equal(errorOf(await create({ expiresAt: "2026-02-31T10:00:00Z" })).fields.expiresAt.code, "invalid_format", "an impossible date");
    assert.equal(errorOf(await create({ expiresAt: new Date(now - 1000).toISOString() })).fields.expiresAt.code, "in_past");
    assert.equal(errorOf(await create({ expiresAt: new Date(now).toISOString() })).fields.expiresAt.code, "in_past", "at now is not in the future");
    const ok = await create({ expiresAt: "2026-06-30T10:00:00+02:00" });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.key.expiresAt, "2026-06-30T08:00:00.000Z");
  });

  test("every semantic fault is reported together", async () => {
    await boot();
    const res = await create({
      rights: ["x.y"],
      policy: { mode: "list", recipients: ["abc"] },
      ipAllow: ["nope"],
      expiresAt: "2020-01-01T00:00:00Z",
    });
    assert.deepEqual(Object.keys(errorOf(res).fields).sort(), ["expiresAt", "ipAllow", "policy.recipients", "rights"]);
  });
});

describe("API-5 POST /admin/api/api/keys: limits, names and the confirmation", () => {
  test("50 non-revoked keys is the cap (409 limit_reached { max: 50 }); a revoked key does not count", async () => {
    await boot();
    for (let i = 0; i < 49; i += 1) await kit.makeKey({ name: `key ${i}` });
    await kit.makeKey({ name: "revoked", revokedAt: new Date(kit.clock.now() - 1000) });
    assert.equal((await create({ name: "the fiftieth" })).status, 201);
    const refused = await create({ name: "the fifty-first" });
    assert.equal(refused.status, 409);
    assert.equal(errorOf(refused).code, "limit_reached");
    assert.deepEqual(errorOf(refused).params, { max: 50 });
    assert.equal(await kit.db.ApiKey.count(), 51);
  });

  test("names are unique among non-revoked keys, case-insensitively and after trimming; a revoked key frees its name", async () => {
    await boot();
    assert.equal((await create({ name: "Shop" })).status, 201);
    for (const name of ["Shop", "shop", "  SHOP ", "sHoP"]) {
      const res = await create({ name });
      assert.equal(res.status, 422, name);
      assert.deepEqual(errorOf(res).fields, { name: { code: "duplicate" } });
    }
    const other = await kit.makeKey({ name: "Éclair" });
    assert.equal((await create({ name: "éCLAIR" })).status, 422, "non-ASCII letters fold too");
    await kit.db.ApiKey.update({ revokedAt: new Date(kit.clock.now()), nameKey: null }, { where: { id: other.id } });
    assert.equal((await create({ name: "éclair" })).status, 201, "the name of a revoked key is free again");
  });

  test("the limit comes before the name check and the name check before the confirmation", async () => {
    await boot();
    await kit.makeKey({ name: "taken" });
    const res = await create({ name: "Taken", policy: { mode: "anyone", recipients: [] } });
    assert.equal(res.status, 422, "a duplicate name wins over the missing confirmation");
    assert.equal(errorOf(res).fields.name.code, "duplicate");
  });

  test("mode 'anyone' needs confirm: ['policy_anyone'] (409 confirmation_required); other modes ignore the token", async () => {
    await boot();
    const refused = await create({ policy: { mode: "anyone", recipients: [] } });
    assert.equal(refused.status, 409);
    assert.equal(errorOf(refused).code, "confirmation_required");
    assert.deepEqual(errorOf(refused).params, { confirm: ["policy_anyone"] });
    assert.equal(await kit.db.ApiKey.count(), 0);
    const ok = await create({ policy: { mode: "anyone", recipients: [] }, confirm: ["policy_anyone"] });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.key.policy.mode, "anyone");
    const ignored = await create({ name: "list mode", confirm: ["policy_anyone"] });
    assert.equal(ignored.status, 201);
  });
});

describe("API-5 POST /admin/api/api/keys: the secret, shown once", () => {
  test("201 { key, secret }: a token of 65 characters whose last 4 are the key's last4, Cache-Control: no-store", async () => {
    await boot();
    const res = await create();
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(Object.keys(res.json).sort(), ["key", "secret"]);
    assert.match(res.json.secret, TOKEN);
    assert.equal(res.json.secret.length, 65);
    assert.equal(res.json.key.last4, res.json.secret.slice(-4));
    assert.equal(res.headers.get("cache-control"), "no-store");
    const key = res.json.key;
    assert.equal(key.name, "n8n");
    assert.equal(key.status, "active");
    assert.equal(key.version, 1);
    assert.deepEqual(key.rights, ["messages.send.text"]);
    assert.deepEqual(key.policy, { mode: "list", recipients: [{ jid: A, name: null }] });
    assert.deepEqual(key.limits, { perMinute: null, perDay: 500, maxPending: null });
    assert.equal(key.seenIpCount, 0);
    assert.equal(key.lastUsedAt, null);
    assert.equal(key.queued, 0);
    assert.deepEqual(key.orphanRights, []);
  });

  test("only the SHA-256 and last4 are stored; the key store verifies the token; the list never shows it", async () => {
    await boot();
    const res = await create();
    const [row] = await kit.rows("ApiKey");
    const part = res.json.secret.slice(22);
    assert.equal(row.secretHash, crypto.createHash("sha256").update(part).digest("hex"));
    assert.equal(row.nameKey, "n8n");
    assert.equal(row.version, 1);
    assert.equal(row.revokedAt, null);
    assert.equal(row.lastIp, null);
    const looked = await kit.keyStore.lookup(res.json.secret);
    assert.equal(looked.status, "ok", "the key cache was invalidated: the new key authenticates at once");
    const list = await kit.get(`${P}/keys`);
    assert.ok(!list.text.includes(res.json.secret) && !list.text.includes(part));
    assert.ok(!JSON.stringify(row).includes(part), "no column holds the secret part");
  });

  test("the secret is registered with the log redactor before the write, for ten minutes", async () => {
    const calls = [];
    const spy = { ...redactor, registerEphemeral: (...args) => { calls.push(args); return redactor.registerEphemeral(...args); } };
    await boot({ deps: { redactor: spy } });
    calls.length = 0; // the setup token registered by the login is not ours
    const res = await create();
    assert.equal(calls.length, 1);
    const [name, value, ttl] = calls[0];
    assert.equal(value, res.json.secret);
    assert.equal(ttl, 600000);
    assert.equal(name, `apikey:${res.json.secret.slice(5, 21)}`);
    assert.ok(!redactor.scrub(`error while handling ${res.json.secret}`).includes(res.json.secret));
  });

  test("the audit row names the key and what was granted, and holds no secret", async () => {
    await boot();
    const res = await create({ rights: ["messages.send.text", "messages.send.image"], limits: { perMinute: 5, perDay: null, maxPending: null } });
    const audits = await kit.audits("api.");
    assert.equal(audits.length, 1);
    const [row] = audits;
    assert.equal(row.action, "api.key.create");
    assert.equal(row.target, String(res.json.key.id));
    assert.equal(row.result, "ok");
    assert.deepEqual(Object.keys(row.detail).sort(), ["changed", "last4", "name", "policyTo", "rightsAdded"]);
    assert.deepEqual(row.detail, {
      name: "n8n",
      last4: res.json.key.last4,
      rightsAdded: ["messages.send.image", "messages.send.text"],
      policyTo: "list",
      changed: ["name", "rights", "recipients", "limits"],
    });
    assert.ok(!row.raw.includes(res.json.secret) && !row.raw.includes(res.json.secret.slice(22)));
    assert.ok(!row.raw.includes("237690000001"), "no recipient in an audit detail");
  });

  test("a refused creation writes no audit row and no key", async () => {
    await boot();
    await create({ rights: ["nope.nope"] });
    await create({ name: "" });
    await create({ policy: { mode: "anyone", recipients: [] } });
    assert.deepEqual(await kit.audits("api."), []);
    assert.equal(await kit.db.ApiKey.count(), 0);
  });

  test("the secret appears in no other answer: two creations give two different tokens, each only in its own answer", async () => {
    await boot();
    const one = await create({ name: "one" });
    const two = await create({ name: "two" });
    assert.notEqual(one.json.secret, two.json.secret);
    const list = await kit.get(`${P}/keys`);
    const state = await kit.get(P);
    for (const res of [list, state]) {
      assert.ok(!res.text.includes(one.json.secret) && !res.text.includes(two.json.secret));
    }
  });

  test("the route table: POST keys is session + csrf + stepUp true; PUT keys/:id is conditional", async () => {
    await boot();
    const routes = kit.t.admin.routes();
    const at = (method, path) => routes.find((r) => r.method === method && r.path === path);
    assert.equal(at("POST", `${P}/keys`).stepUp, true);
    assert.equal(at("GET", `${P}/keys`).stepUp, false);
  });
});

// ===============================================================================================================
// Part 2: API-6, API-7, API-8, the widening matrix and the audit rows
// ===============================================================================================================

const C = "237690000003@s.whatsapp.net";

/** A full PUT body from a KeyView (the SPA's draft), `over` replacing top-level properties */
const editBody = (key, over = {}) => ({
  name: key.name,
  rights: key.rights,
  policy: { mode: key.policy.mode, recipients: key.policy.recipients.map((r) => r.jid) },
  limits: key.limits,
  ipAllow: key.ipAllow,
  expiresAt: key.expiresAt,
  version: key.version,
  ...over,
});
const viewOf = async (id) => (await kit.get(`${P}/keys`)).json.items.find((k) => k.id === id);
const update = async (id, over = {}, from = null) => kit.put(`${P}/keys/${id}`, editBody(from || (await viewOf(id)), over));

describe("API-6 PUT /admin/api/api/keys/:id: lookup and schema", () => {
  test("a full replace: the schema comes first, then 404, then not_editable (an expired key IS editable)", async () => {
    await boot();
    const bad = await kit.put(`${P}/keys/9999`, { name: "" });
    assert.equal(bad.status, 422, "schema before the lookup");
    const missing = await kit.put(`${P}/keys/9999`, body({ version: 1 }));
    assert.equal(missing.status, 404);
    assert.deepEqual(errorOf(missing).params, { resource: "key" });
    const revoked = await kit.makeKey({ name: "gone", revokedAt: new Date(kit.clock.now() - 1000) });
    const refused = await kit.put(`${P}/keys/${revoked.id}`, body({ version: 1, name: "gone" }));
    assert.equal(refused.status, 409);
    assert.equal(errorOf(refused).code, "not_editable");
    const expired = await kit.makeKey({ name: "old", expiresAt: new Date(kit.clock.now() - 1000) });
    const view = await viewOf(expired.id);
    assert.equal(view.status, "expired");
    assert.equal((await kit.put(`${P}/keys/${expired.id}`, editBody(view, { name: "old renamed" }))).status, 200);
  });

  test("version is required on an update, an unknown property is refused, and a path id out of range is 404", async () => {
    await boot();
    const key = await kit.makeKey({ name: "k" });
    const view = await viewOf(key.id);
    const { version, ...noVersion } = editBody(view);
    assert.deepEqual(errorOf(await kit.put(`${P}/keys/${key.id}`, noVersion)).fields, { version: { code: "required" } });
    assert.deepEqual(errorOf(await kit.put(`${P}/keys/${key.id}`, editBody(view, { lastUsedAt: null }))).fields, { $unknown: { code: "unknown_field" } });
    assert.equal((await kit.put(`${P}/keys/99999999999`, editBody(view))).status, 404);
  });
});

describe("API-6 PUT /admin/api/api/keys/:id: the write", () => {
  test("200 { key, changed: true }: version + 1, only the configuration columns, the key cache invalidated", async () => {
    await boot();
    const invalidated = [];
    const original = kit.keyStore.invalidate.bind(kit.keyStore);
    kit.keyStore.invalidate = (id) => {
      invalidated.push(id);
      return original(id);
    };
    const key = await kit.makeKey({ name: "k", lastIp: "10.0.0.9", seenIps: ["10.0.0.9"], lastUsedAt: new Date(kit.clock.now() - 5000) });
    const before = (await kit.rows("ApiKey"))[0];
    const res = await update(key.id, { name: "k renamed", limits: { perMinute: 7, perDay: null, maxPending: 3 } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.changed, true);
    assert.equal(res.json.key.name, "k renamed");
    assert.equal(res.json.key.version, 2);
    assert.deepEqual(res.json.key.limits, { perMinute: 7, perDay: null, maxPending: 3 });
    const after = (await kit.rows("ApiKey"))[0];
    assert.equal(after.nameKey, "k renamed");
    assert.equal(after.version, 2);
    for (const column of ["lookupId", "secretHash", "last4", "lastIp", "seenIps", "lastUsedAt", "revokedAt", "createdAt"]) {
      assert.deepEqual(after[column], before[column], `${column} is not a configuration column`);
    }
    assert.deepEqual(invalidated, [key.id]);
  });

  test("an identical normalised result is changed: false: nothing written, no version bump, no audit", async () => {
    await boot();
    const key = await kit.makeKey({ name: "same", rights: ["messages.send.text", "messages.send.image"], recipients: [A, B], ipAllow: ["10.0.0.1", "10.0.0.2"] });
    const view = await viewOf(key.id);
    const before = await kit.snapshot();
    const res = await kit.put(`${P}/keys/${key.id}`, editBody(view, {
      rights: ["messages.send.image", "messages.send.text"], // another order
      policy: { mode: "list", recipients: [B, "+237 690 000 001"] }, // another order, another spelling
      ipAllow: ["10.0.0.2", "10.0.0.1"],
    }));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.changed, false);
    assert.equal(res.json.key.version, 1);
    assert.deepEqual(await kit.snapshot(), before);
  });

  test("stored-data semantics: a stale version is 409 conflict with the current one, nothing written", async () => {
    await boot();
    const key = await kit.makeKey({ name: "k" });
    const stale = editBody(await viewOf(key.id), { name: "first" });
    assert.equal((await kit.put(`${P}/keys/${key.id}`, stale)).status, 200);
    const before = await kit.snapshot();
    const again = await kit.put(`${P}/keys/${key.id}`, { ...stale, name: "second" });
    assert.equal(again.status, 409);
    assert.equal(errorOf(again).code, "conflict");
    assert.deepEqual(errorOf(again).fields, { version: { code: "conflict", params: { version: 2 } } });
    assert.deepEqual(await kit.snapshot(), before);
    assert.equal((await kit.rows("ApiKey"))[0].name, "first");
  });

  test("names: unique among the other live keys, case-insensitively; its own name in another case is fine; a revoked key's is free", async () => {
    await boot();
    const one = await kit.makeKey({ name: "One" });
    await kit.makeKey({ name: "Two" });
    await kit.makeKey({ name: "Three", revokedAt: new Date(kit.clock.now() - 1000) });
    const dup = await update(one.id, { name: " two " });
    assert.equal(dup.status, 422);
    assert.deepEqual(errorOf(dup).fields, { name: { code: "duplicate" } });
    assert.equal((await update(one.id, { name: "ONE" })).status, 200, "its own name, another case");
    assert.equal((await update(one.id, { name: "three" })).status, 200, "the name of a revoked key");
    assert.equal((await kit.rows("ApiKey")).find((k) => k.id === one.id).nameKey, "three");
  });

  test("the order: name duplicate, then conflict, then the policy_anyone confirmation, then the password", async () => {
    await boot();
    await kit.makeKey({ name: "taken" });
    const key = await kit.makeKey({ name: "mine" });
    const view = await viewOf(key.id);
    await kit.expireConfirmation();
    const everything = editBody(view, { name: "taken", version: 99, policy: { mode: "anyone", recipients: [A] }, rights: ["messages.read"] });
    assert.equal(errorOf(await kit.put(`${P}/keys/${key.id}`, everything)).fields.name.code, "duplicate");
    assert.equal(errorOf(await kit.put(`${P}/keys/${key.id}`, { ...everything, name: "mine" })).code, "conflict");
    const noToken = await kit.put(`${P}/keys/${key.id}`, { ...everything, name: "mine", version: 1 });
    assert.equal(noToken.status, 409);
    assert.equal(errorOf(noToken).code, "confirmation_required");
    assert.deepEqual(errorOf(noToken).params, { confirm: ["policy_anyone"] });
    const asked = await kit.put(`${P}/keys/${key.id}`, { ...everything, name: "mine", version: 1, confirm: ["policy_anyone"] });
    assert.equal(asked.status, 403);
    assert.deepEqual(errorOf(asked).params.reasons, ["rights", "policy"]);
    assert.equal((await kit.rows("ApiKey")).find((k) => k.id === key.id).version, 1, "nothing saved");
  });

  test("policy_anyone: a change to anyone needs the token; keeping anyone needs none; the token is ignored when not needed", async () => {
    await boot();
    const key = await kit.makeKey({ name: "k", policyMode: "known", recipients: [] });
    const view = await viewOf(key.id);
    const refused = await kit.put(`${P}/keys/${key.id}`, editBody(view, { policy: { mode: "anyone", recipients: [] } }));
    assert.equal(errorOf(refused).code, "confirmation_required");
    const ok = await kit.put(`${P}/keys/${key.id}`, editBody(view, { policy: { mode: "anyone", recipients: [] }, confirm: ["policy_anyone"] }));
    assert.equal(ok.status, 200, ok.text);
    const kept = await update(key.id, { name: "renamed" });
    assert.equal(kept.status, 200, "an update that keeps anyone needs no confirmation");
    const back = await update(key.id, { policy: { mode: "known", recipients: [] }, confirm: ["policy_anyone"] });
    assert.equal(back.status, 200, "the token is ignored when not needed");
  });

  test("rights: a stored orphan may be kept or removed, a new id outside the catalogue cannot be added", async () => {
    await boot();
    const key = await kit.makeKey({ name: "k", rights: ["messages.send.text", "gone.module"] });
    const view = await viewOf(key.id);
    assert.deepEqual(view.orphanRights, ["gone.module"]);
    assert.equal((await kit.put(`${P}/keys/${key.id}`, editBody(view, { name: "kept" }))).status, 200);
    const added = await update(key.id, { rights: ["messages.send.text", "gone.module", "other.gone"] });
    assert.deepEqual(errorOf(added).fields.rights.params.indices, [2]);
    const removed = await update(key.id, { rights: ["messages.send.text"] });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.json.key.orphanRights, []);
  });

  test("expiry: an expired key kept as it is is not in_past; another past instant is; extending it asks for the password", async () => {
    await boot();
    const key = await kit.makeKey({ name: "old", expiresAt: new Date(kit.clock.now() - 60000) });
    const view = await viewOf(key.id);
    assert.equal((await kit.put(`${P}/keys/${key.id}`, editBody(view, { name: "old 2" }))).status, 200, "its date is untouched");
    const other = await update(key.id, { expiresAt: new Date(kit.clock.now() - 30000).toISOString() });
    assert.equal(errorOf(other).fields.expiresAt.code, "in_past");
    await kit.expireConfirmation();
    const extend = await update(key.id, { expiresAt: new Date(kit.clock.now() + 86400000).toISOString() });
    assert.equal(extend.status, 403);
    assert.deepEqual(errorOf(extend).params.reasons, ["expiry"]);
    await kit.confirm();
    const done = await update(key.id, { expiresAt: new Date(kit.clock.now() + 86400000).toISOString() });
    assert.equal(done.status, 200);
    assert.equal(done.json.key.status, "active", "an extended key is active again");
  });

  test("a revoke between the read and the write: not_editable, not a lost update", async () => {
    await boot();
    const key = await kit.makeKey({ name: "race" });
    const view = await viewOf(key.id);
    await kit.db.ApiKey.update({ revokedAt: new Date(kit.clock.now()), nameKey: null }, { where: { id: key.id } });
    const res = await kit.put(`${P}/keys/${key.id}`, editBody(view, { name: "late" }));
    assert.equal(errorOf(res).code, "not_editable");
  });
});

describe("the widening matrix (test/fixtures/api-widenings.json, shared with the SPA's pure mirror)", () => {
  test("the server predicate gives the row's reasons on every row, in the server order", () => {
    assert.ok(WIDENINGS.length >= 30);
    const wrong = [];
    for (const row of WIDENINGS) {
      const got = widenings(row.before, row.after);
      if (JSON.stringify(got) !== JSON.stringify(row.reasons)) wrong.push(`${row.name}: ${JSON.stringify(got)} instead of ${JSON.stringify(row.reasons)}`);
    }
    assert.deepEqual(wrong, []);
  });

  test("one case per reason is in the fixture, and every never-case of admin-api.md 1.5", () => {
    const seen = new Set(WIDENINGS.flatMap((row) => row.reasons));
    for (const reason of ["enable", "create", "rights", "policy", "ip", "expiry", "plain_http"]) assert.ok(seen.has(reason), reason);
    assert.ok(WIDENINGS.some((row) => row.reasons.length === 0 && /name and limits/.test(row.name)));
  });

  test("through the routes: every key row asks (403 password_required with those reasons, nothing saved) or does not (200)", async () => {
    await boot();
    await kit.expireConfirmation();
    const failures = [];
    const rows = WIDENINGS.filter((row) => row.before && "rights" in row.before);
    assert.ok(rows.length >= 40);
    for (const [index, row] of rows.entries()) {
      await kit.db.ApiKey.destroy({ where: {} });
      const before = row.before;
      const stored = await kit.makeKey({
        name: before.name || "Matrix key",
        rights: before.rights,
        policyMode: before.policy.mode,
        recipients: before.policy.recipients,
        ipAllow: before.ipAllow,
        expiresAt: before.expiresAt ? new Date(before.expiresAt) : null,
        limitPerMinute: before.limits ? before.limits.perMinute : null,
        limitPerDay: before.limits ? before.limits.perDay : null,
        limitPending: before.limits ? before.limits.maxPending : null,
      });
      const after = row.after;
      const putBody = {
        name: after.name || before.name || "Matrix key",
        rights: after.rights,
        policy: after.policy,
        limits: after.limits || before.limits || { perMinute: null, perDay: null, maxPending: null },
        ipAllow: after.ipAllow,
        expiresAt: after.expiresAt,
        version: 1,
      };
      if (after.policy.mode === "anyone" && before.policy.mode !== "anyone") putBody.confirm = ["policy_anyone"];
      const res = await kit.put(`${P}/keys/${stored.id}`, putBody);
      if (row.reasons.length) {
        const got = errorOf(res);
        if (res.status !== 403 || got.code !== "password_required" || JSON.stringify(got.params.reasons) !== JSON.stringify(row.reasons)) {
          failures.push(`#${index} ${row.name}: ${res.status} ${JSON.stringify(got.params || got.fields || got)} instead of ${JSON.stringify(row.reasons)}`);
        }
        const saved = (await kit.rows("ApiKey"))[0];
        if (saved.version !== 1) failures.push(`#${index} ${row.name}: saved without the password`);
      } else if (res.status !== 200) {
        failures.push(`#${index} ${row.name}: ${res.status} ${res.text.slice(0, 160)} instead of 200`);
      }
    }
    assert.deepEqual(failures, []);
  });

  test("through the routes: every state row (enable, plain_http) asks or does not", async () => {
    await boot();
    await kit.expireConfirmation();
    const failures = [];
    const rows = WIDENINGS.filter((row) => row.before && !("rights" in row.before));
    assert.ok(rows.length >= 10);
    for (const [index, row] of rows.entries()) {
      await kit.db.ApiState.destroy({ where: {} });
      await kit.apiState.load({ models: kit.db });
      await kit.apiState.setState({ enabled: row.before.enabled, plainHttpFrom: row.before.plainHttpFrom || [] }, { now: kit.clock.now() });
      const send = { enabled: row.after.enabled, confirm: true };
      if (row.after.plainHttpFrom) send.plainHttpFrom = row.after.plainHttpFrom;
      const res = await kit.put(`${P}/state`, send);
      if (row.reasons.length) {
        const got = errorOf(res);
        if (res.status !== 403 || JSON.stringify((got.params || {}).reasons) !== JSON.stringify(row.reasons)) failures.push(`#${index} ${row.name}: ${res.status} ${JSON.stringify(got)} instead of ${JSON.stringify(row.reasons)}`);
      } else if (res.status !== 200) {
        failures.push(`#${index} ${row.name}: ${res.status} ${res.text.slice(0, 160)}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  test("a recipient added while the mode ignores it counts (known, anyone); a removal never does", async () => {
    await boot();
    await kit.expireConfirmation();
    for (const mode of ["known", "anyone"]) {
      const key = await kit.makeKey({ name: `m ${mode}`, policyMode: mode, recipients: [A] });
      const view = await viewOf(key.id);
      const added = await kit.put(`${P}/keys/${key.id}`, editBody(view, { policy: { mode, recipients: [A, C] } }));
      assert.equal(errorOf(added).code, "password_required", mode);
      assert.deepEqual(errorOf(added).params.reasons, ["policy"]);
      const removed = await kit.put(`${P}/keys/${key.id}`, editBody(view, { policy: { mode, recipients: [] } }));
      assert.equal(removed.status, 200, mode);
    }
  });

  test("an emptied ipAllow asks; a first list where there was none does not; a covered entry does not", async () => {
    await boot();
    await kit.expireConfirmation();
    const restricted = await kit.makeKey({ name: "r", ipAllow: ["10.0.0.0/8"] });
    const emptied = await update(restricted.id, { ipAllow: [] });
    assert.deepEqual(errorOf(emptied).params.reasons, ["ip"]);
    assert.equal((await update(restricted.id, { ipAllow: ["10.1.0.0/16"] })).status, 200);
    const open = await kit.makeKey({ name: "o", ipAllow: [] });
    assert.equal((await update(open.id, { ipAllow: ["203.0.113.5"] })).status, 200);
  });
});

describe("API-6: the password gate saves nothing", () => {
  test("a missing confirmation, then the confirmation: only the second request writes", async () => {
    await boot();
    const key = await kit.makeKey({ name: "k" });
    const view = await viewOf(key.id);
    await kit.expireConfirmation();
    const body2 = editBody(view, { rights: ["messages.send.text", "messages.read"] });
    const before = await kit.snapshot();
    const refused = await kit.put(`${P}/keys/${key.id}`, body2);
    assert.equal(refused.status, 403);
    assert.deepEqual(await kit.snapshot(), before);
    const wrong = await kit.client.api("POST", "/admin/api/session/reauth", { password: "a wrong password!" });
    assert.equal(wrong.status, 422, "a wrong password is 422, never 401");
    assert.deepEqual(errorOf(wrong).fields, { password: { code: "wrong_password" } });
    const still = await kit.put(`${P}/keys/${key.id}`, body2);
    assert.equal(still.status, 403, "a wrong password confirms nothing");
    assert.deepEqual((await kit.snapshot()).ApiKey, before.ApiKey);
    await kit.confirm();
    const done = await kit.put(`${P}/keys/${key.id}`, body2);
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json.key.version, 2);
  });
});

describe("API-7 POST /admin/api/api/keys/:id/duplicate", () => {
  const dup = (id, over = {}) => kit.post(`${P}/keys/${id}/duplicate`, over);

  test("copies rights (orphans dropped), policy, limits, ipAllow and expiry into a NEW key with a new secret; the source is untouched", async () => {
    await boot();
    const source = await kit.makeKey({
      name: "Shop",
      rights: ["messages.send.text", "gone.module", "messages.read"],
      policyMode: "anyone",
      recipients: [A, GROUP],
      limitPerMinute: 4,
      limitPerDay: 40,
      limitPending: null,
      ipAllow: ["10.0.0.0/8"],
      expiresAt: new Date(kit.clock.now() + 86400000),
      lastIp: "10.0.0.1",
      seenIps: ["10.0.0.1"],
      lastUsedAt: new Date(kit.clock.now() - 1000),
    });
    const before = (await kit.rows("ApiKey"))[0];
    const res = await dup(source.id);
    assert.equal(res.status, 201, res.text);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(res.json.secret, TOKEN);
    assert.notEqual(res.json.secret, source.secret);
    const key = res.json.key;
    assert.notEqual(key.id, source.id);
    assert.equal(key.name, "Shop (2)");
    assert.equal(key.version, 1);
    assert.equal(key.status, "active");
    assert.deepEqual(key.rights, ["messages.read", "messages.send.text"], "the orphan right is dropped");
    assert.deepEqual(key.orphanRights, []);
    assert.deepEqual(key.policy, { mode: "anyone", recipients: [{ jid: A, name: null }, { jid: GROUP, name: null }] });
    assert.deepEqual(key.limits, { perMinute: 4, perDay: 40, maxPending: null });
    assert.deepEqual(key.ipAllow, ["10.0.0.0/8"]);
    assert.equal(key.expiresAt, before.expiresAt instanceof Date ? before.expiresAt.toISOString() : new Date(before.expiresAt).toISOString());
    assert.equal(key.lastUsedAt, null);
    assert.equal(key.lastUsedIp, null);
    assert.equal(key.seenIpCount, 0);
    assert.deepEqual((await kit.rows("ApiKey"))[0], before, "the source is untouched");
    assert.equal((await kit.keyStore.lookup(res.json.secret)).status, "ok");
    assert.equal((await kit.keyStore.lookup(source.secret)).status, "ok");
  });

  test("no policy_anyone confirmation (inherited from a key whose owner already confirmed it)", async () => {
    await boot();
    const source = await kit.makeKey({ name: "open", policyMode: "anyone", recipients: [] });
    assert.equal((await dup(source.id)).status, 201);
  });

  test("the name: the body's, or '<name> (n)' with the first free n >= 2, the base cut within 64 code points", async () => {
    await boot();
    const source = await kit.makeKey({ name: "Shop" });
    assert.equal((await dup(source.id)).json.key.name, "Shop (2)");
    assert.equal((await dup(source.id)).json.key.name, "Shop (3)");
    assert.equal((await dup(source.id, { name: "Mine" })).json.key.name, "Mine");
    const taken = await dup(source.id, { name: "mine" });
    assert.equal(taken.status, 422);
    assert.deepEqual(errorOf(taken).fields, { name: { code: "duplicate" } });
    assert.equal(errorOf(await dup(source.id, { name: "x".repeat(65) })).fields.name.code, "too_long");

    const long = await kit.makeKey({ name: "é".repeat(64) });
    const copy = (await dup(long.id)).json.key.name;
    assert.equal(Array.from(copy).length, 64, "exactly 64 code points");
    assert.ok(copy.endsWith(" (2)"));
    assert.equal(copy.slice(0, 60), "é".repeat(60));
  });

  test("a revoked or an expired source is 409 not_editable; an unknown one is 404; 50 live keys is the cap", async () => {
    await boot();
    const revoked = await kit.makeKey({ name: "revoked", revokedAt: new Date(kit.clock.now() - 1000) });
    const expired = await kit.makeKey({ name: "expired", expiresAt: new Date(kit.clock.now() - 1000) });
    assert.equal(errorOf(await dup(revoked.id)).code, "not_editable");
    assert.equal(errorOf(await dup(expired.id)).code, "not_editable");
    assert.equal((await dup(777)).status, 404);
    const live = await kit.makeKey({ name: "live" });
    for (let i = 0; i < 47; i += 1) await kit.makeKey({ name: `filler ${i}` });
    assert.equal(await kit.db.ApiKey.count({ where: { revokedAt: null } }), 49, "expired + live + 47 fillers; the revoked one does not count");
    assert.equal((await dup(live.id)).status, 201);
    const full = await dup(live.id);
    assert.equal(full.status, 409);
    assert.equal(errorOf(full).code, "limit_reached");
    assert.deepEqual(errorOf(full).params, { max: 50 });
  });

  test("always password-gated by the router (after validation), saving nothing", async () => {
    await boot();
    const source = await kit.makeKey({ name: "k" });
    await kit.expireConfirmation();
    assert.equal((await dup(source.id, { name: "x".repeat(65) })).status, 422, "validation first");
    const before = await kit.snapshot();
    const refused = await dup(source.id);
    assert.equal(refused.status, 403);
    assert.deepEqual(errorOf(refused).params, { windowMs: 300000 });
    assert.deepEqual(await kit.snapshot(), before);
  });

  test("audit api.key.duplicate: the create set plus the source id; no secret", async () => {
    await boot();
    const source = await kit.makeKey({ name: "Shop", rights: ["messages.send.text"] });
    const res = await dup(source.id);
    const [row] = await kit.audits("api.key.duplicate");
    assert.equal(row.target, String(res.json.key.id));
    assert.deepEqual(row.detail, {
      name: "Shop (2)",
      last4: res.json.key.last4,
      rightsAdded: ["messages.send.text"],
      policyTo: "list",
      changed: ["name", "rights", "recipients"],
      source: source.id,
    });
    assert.ok(!row.raw.includes(res.json.secret.slice(22)));
  });
});

describe("API-8 POST /admin/api/api/keys/:id/revoke", () => {
  const revoke = (id, over = { confirm: true }) => kit.post(`${P}/keys/${id}/revoke`, over);

  test("confirm: true is required (409 confirmation_required { confirm: 'revoke_key' }), before the lookup", async () => {
    await boot();
    const key = await kit.makeKey({ name: "k" });
    for (const over of [{}, { confirm: false }]) {
      const res = await revoke(key.id, over);
      assert.equal(res.status, 409);
      assert.equal(errorOf(res).code, "confirmation_required");
      assert.deepEqual(errorOf(res).params, { confirm: "revoke_key" });
    }
    assert.equal(errorOf(await revoke(4242, {})).code, "confirmation_required", "unknown id, still the confirmation first");
    assert.equal((await revoke(4242)).status, 404);
    assert.equal((await kit.rows("ApiKey"))[0].revokedAt, null);
  });

  test("revoking: revokedAt set, nameKey cleared, version + 1, cache invalidated, the queue cancelled with its count", async () => {
    await boot();
    const invalidated = [];
    const original = kit.keyStore.invalidate.bind(kit.keyStore);
    kit.keyStore.invalidate = (id) => {
      invalidated.push(["invalidate", id]);
      return original(id);
    };
    const originalCancel = kit.messaging.cancelForKey;
    kit.messaging.cancelForKey = async (...args) => {
      invalidated.push(["cancel", args[0]]);
      return originalCancel(...args);
    };
    kit.messaging.cancelledForKey = 3;
    const key = await kit.makeKey({ name: "doomed" });
    const res = await revoke(key.id);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.cancelled, 3);
    assert.equal(res.json.key.status, "revoked");
    assert.equal(res.json.key.version, 2);
    assert.equal(res.json.key.revokedAt, new Date(kit.clock.now()).toISOString());
    const [row] = await kit.rows("ApiKey");
    assert.equal(row.nameKey, null);
    assert.equal(row.version, 2);
    assert.deepEqual(invalidated, [["invalidate", key.id], ["cancel", key.id]], "the cache first, then the cancellation");
    assert.deepEqual(kit.messaging.calls.cancelForKey, [{ id: key.id, reason: "key_revoked" }]);
    assert.equal((await kit.keyStore.lookup(key.secret)).key.revokedAtMs, kit.clock.now(), "the very next request sees it");
    const created = await create({ name: "Doomed" });
    assert.equal(created.status, 201, "a revoked key frees its name");
  });

  test("it asks no password: revoking narrows", async () => {
    await boot();
    const key = await kit.makeKey({ name: "k" });
    await kit.expireConfirmation();
    assert.equal((await revoke(key.id)).status, 200);
  });

  test("an expired key can be revoked", async () => {
    await boot();
    const key = await kit.makeKey({ name: "old", expiresAt: new Date(kit.clock.now() - 1000) });
    assert.equal((await revoke(key.id)).json.key.status, "revoked");
  });

  test("already revoked: 200, cancelled 0, no audit, no second cancellation, version unchanged", async () => {
    await boot();
    const key = await kit.makeKey({ name: "k" });
    await revoke(key.id);
    const audits = (await kit.audits("api.key.revoke")).length;
    const again = await revoke(key.id);
    assert.equal(again.status, 200);
    assert.equal(again.json.cancelled, 0);
    assert.equal(again.json.key.version, 2);
    assert.equal((await kit.audits("api.key.revoke")).length, audits);
    assert.equal(kit.messaging.calls.cancelForKey.length, 1);
  });

  test("a cancellation that throws: the revoke stands, cancelled is null, the failure is logged without detail", async () => {
    await boot();
    kit.messaging.cancelThrows = true;
    const key = await kit.makeKey({ name: "k" });
    const res = await revoke(key.id);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.cancelled, null);
    assert.equal(res.json.key.status, "revoked");
    assert.notEqual((await kit.rows("ApiKey"))[0].revokedAt, null);
    const [audit] = await kit.audits("api.key.revoke");
    assert.deepEqual(audit.detail, { name: "k", last4: key.row.last4, cancelled: null });
    assert.ok(kit.t.logger.lines.some((l) => l.level === "warn"), "logged");
  });

  test("audit api.key.revoke: { name, last4, cancelled }", async () => {
    await boot();
    kit.messaging.cancelledForKey = 2;
    const key = await kit.makeKey({ name: "k" });
    await revoke(key.id);
    const audits = await kit.audits("api.");
    assert.deepEqual(audits.map((a) => [a.action, a.target, a.detail]), [["api.key.revoke", String(key.id), { name: "k", last4: key.row.last4, cancelled: 2 }]]);
  });

  test("a revoked key is listed after the live ones and is final: no route edits or duplicates it", async () => {
    await boot();
    const one = await kit.makeKey({ name: "one" });
    const two = await kit.makeKey({ name: "two" });
    await revoke(one.id);
    assert.deepEqual((await kit.get(`${P}/keys`)).json.items.map((k) => [k.id, k.status]), [[two.id, "active"], [one.id, "revoked"]]);
    const view = await viewOf(one.id);
    assert.equal(errorOf(await kit.put(`${P}/keys/${one.id}`, editBody(view, { name: "back" }))).code, "not_editable");
    assert.equal(errorOf(await kit.post(`${P}/keys/${one.id}/duplicate`, {})).code, "not_editable");
  });
});

describe("audit rows of the key routes: closed detail sets, targets, the 1900-character degrade", () => {
  const many = (prefix, n = 64) => Array.from({ length: n }, (_, i) => `${prefix}.right_${String(i).padStart(2, "0")}_${"x".repeat(32)}`);

  test("api.key.update: { name, last4, rightsAdded, rightsRemoved, changed }, policyFrom/policyTo only on a mode change, widened only when asked", async () => {
    await boot();
    const key = await kit.makeKey({ name: "k", rights: ["messages.send.text", "messages.read"], policyMode: "known", recipients: [] });
    const first = await update(key.id, { name: "k2", rights: ["messages.read", "messages.send.image"] });
    assert.equal(first.status, 200, first.text);
    const second = await update(key.id, { policy: { mode: "list", recipients: [A] } });
    assert.equal(second.status, 200, second.text);
    const third = await update(key.id, { policy: { mode: "anyone", recipients: [A] }, confirm: ["policy_anyone"] });
    assert.equal(third.status, 200, third.text);
    const rows = await kit.audits("api.key.update");
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0].detail, {
      name: "k2",
      last4: key.row.last4,
      rightsAdded: ["messages.send.image"],
      rightsRemoved: ["messages.send.text"],
      changed: ["name", "rights"],
      widened: ["rights"],
    });
    assert.deepEqual(rows[1].detail, { name: "k2", last4: key.row.last4, rightsAdded: [], rightsRemoved: [], changed: ["policy", "recipients"], policyFrom: "known", policyTo: "list", widened: ["policy"] });
    assert.deepEqual(rows[2].detail.policyFrom, "list");
    assert.deepEqual(rows[2].detail.policyTo, "anyone");
    for (const row of rows) assert.equal(row.target, String(key.id));
    const narrowing = await update(key.id, { name: "k3" });
    assert.equal(narrowing.status, 200);
    const last = (await kit.audits("api.key.update")).at(-1).detail;
    assert.ok(!("widened" in last) && !("policyFrom" in last) && !("policyTo" in last));
    assert.deepEqual(Object.keys(last).sort(), ["changed", "last4", "name", "rightsAdded", "rightsRemoved"]);
  });

  test("no recipient, no IP and no text in any audit detail of the key routes", async () => {
    await boot();
    const made = await create({ name: "audited", policy: { mode: "list", recipients: [A] }, ipAllow: ["203.0.113.7"] });
    await update(made.json.key.id, { ipAllow: ["203.0.113.7", "203.0.113.8"], policy: { mode: "list", recipients: [A, B] } });
    await kit.post(`${P}/keys/${made.json.key.id}/duplicate`, {});
    await kit.post(`${P}/keys/${made.json.key.id}/revoke`, { confirm: true });
    const raw = (await kit.audits("api.")).map((a) => a.raw).join("\n");
    for (const forbidden of ["2376900000", "203.0.113", "@s.whatsapp.net"]) assert.ok(!raw.includes(forbidden), forbidden);
  });

  test("a creation with 64 long rights: rightsAdded becomes rightsAddedCount, the rest of the detail stays", async () => {
    const rights = many("custom");
    await boot({ rights });
    const res = await create({ rights });
    assert.equal(res.status, 201, res.text);
    const [row] = await kit.audits("api.key.create");
    assert.ok(row.raw.length <= 1900, `${row.raw.length}`);
    assert.equal(row.detail.rightsAddedCount, 64);
    assert.ok(!("rightsAdded" in row.detail));
    assert.deepEqual(Object.keys(row.detail).sort(), ["changed", "last4", "name", "policyTo", "rightsAddedCount"]);
    assert.equal(row.detail.truncated, undefined, "never the lossy summary of audit.js");
  });

  test("an update: rightsRemoved degrades first, rightsAdded only if it is still too long", async () => {
    const oldRights = many("old");
    const newRights = many("new");
    await boot({ rights: [...oldRights, ...newRights, "messages.send.text"] });
    const key = await kit.makeKey({ name: "k", rights: oldRights });
    const small = await update(key.id, { rights: ["messages.send.text"] });
    assert.equal(small.status, 200, small.text);
    let [row] = await kit.audits("api.key.update");
    assert.equal(row.detail.rightsRemovedCount, 64);
    assert.deepEqual(row.detail.rightsAdded, ["messages.send.text"], "the added list is still short enough: it stays");
    assert.ok(!("rightsRemoved" in row.detail));

    const key2 = await kit.makeKey({ name: "k2", rights: oldRights });
    const swap = await update(key2.id, { rights: newRights });
    assert.equal(swap.status, 200, swap.text);
    row = (await kit.audits("api.key.update")).at(-1);
    assert.ok(row.raw.length <= 1900);
    assert.equal(row.detail.rightsRemovedCount, 64);
    assert.equal(row.detail.rightsAddedCount, 64);
    assert.ok(!("rightsRemoved" in row.detail) && !("rightsAdded" in row.detail));
    assert.deepEqual(row.detail.changed, ["rights"]);
  });
});
