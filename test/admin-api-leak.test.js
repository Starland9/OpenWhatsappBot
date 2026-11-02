"use strict";
/**
 * SC-003, panel side (feature 004, contracts/admin-api.md 1.6, 1.7 and section 5): after a scenario that creates,
 * duplicates, edits and revokes keys and sends test messages carrying canary values, nothing the panel logged,
 * audited, answered or stored holds a key token, the 43-character part of one, or a canary text, caption, file name
 * or URL; and the shape `owbk_<16 hex>_` appears nowhere outside the one `secret` field of API-5 and API-7.
 *
 * The corpora: the harness logger lines and the real log ring, every `AuditLog.detail`, every response body of the
 * scenario (the two `secret` values removed first), and every column of the four Api tables. The engine is the
 * recording stand-in of test/helpers/apiPanelKit.js (the real one keeps a queued message's `payload` by design, until
 * it is sent, so the table scan belongs to what the PANEL writes).
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { bootApiPanel } = require("./helpers/apiPanelKit");
const ring = require("../lib/admin/logs/ring");

const P = "/admin/api/api";
const A = "237690000001@s.whatsapp.net";
const B = "237690000002@s.whatsapp.net";
const NUMBER = "237690000001";
const CANARY = {
  text: "CANARY-TEXT-7f3a",
  caption: "CANARY-CAPTION-91bc",
  file: "CANARY-FILE-5d2e.png",
  url: "https://media.example.org/CANARY-URL-c07a.png",
  option: "CANARY-OPTION-18ef",
};
const TOKEN_SHAPE = /owbk_[0-9a-f]{16}_/;

let kit;
let tmp;
afterEach(async () => {
  if (kit) await kit.close();
  kit = null;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

/** Run the whole scenario and return the secrets it created and every body it received */
async function scenario() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-leak-"));
  const staged = path.join(tmp, "fetched.png");
  fs.writeFileSync(staged, Buffer.from("not really a png"));
  kit = await bootApiPanel({ fetched: () => ({ path: staged, size: 16, name: CANARY.file, sha256: "a".repeat(64), mime: "image/png", ext: "png", kind: "image" }) });
  const bodies = [];
  const call = async (method, urlPath, body) => {
    const res = await kit.client.api(method, urlPath, body);
    bodies.push({ label: `${method} ${urlPath}`, text: res.text });
    return res;
  };
  const secrets = [];
  const keep = (res) => {
    if (res.json && typeof res.json.secret === "string") secrets.push(res.json.secret);
    return res;
  };
  ring.clear && ring.clear();

  await call("PUT", `${P}/state`, { enabled: true, plainHttpFrom: ["192.168.0.0/16"] });
  const created = keep(await call("POST", `${P}/keys`, {
    name: "leak scan",
    rights: ["messages.send.text", "messages.send.image"],
    policy: { mode: "list", recipients: [A] },
    limits: { perMinute: null, perDay: 50, maxPending: null },
    ipAllow: ["203.0.113.9"],
    expiresAt: null,
  }));
  const id = created.json.key.id;
  const copy = keep(await call("POST", `${P}/keys/${id}/duplicate`, { name: "leak scan copy" }));
  await call("PUT", `${P}/keys/${id}`, {
    name: "leak scan",
    rights: ["messages.send.text"],
    policy: { mode: "list", recipients: [A, B] },
    limits: { perMinute: null, perDay: 60, maxPending: null },
    ipAllow: ["203.0.113.9"],
    expiresAt: null,
    version: 1,
  });
  // refusals that could echo what was sent
  await call("POST", `${P}/keys`, { name: CANARY.text, rights: [CANARY.option], policy: { mode: "list", recipients: [CANARY.caption] }, limits: {}, ipAllow: [CANARY.url], expiresAt: CANARY.file });
  await call("POST", `${P}/test`, { format: "text", to: NUMBER, text: CANARY.text, extra: CANARY.caption });
  await call("POST", `${P}/test`, { format: CANARY.option, to: CANARY.url, text: CANARY.text });
  await call("POST", `${P}/test`, { format: "image", to: NUMBER, caption: CANARY.caption, media: { url: CANARY.url }, uploadId: "f".repeat(32) });
  // accepted sends
  await call("POST", `${P}/test`, { format: "text", to: NUMBER, text: CANARY.text });
  await call("POST", `${P}/test`, { format: "image", to: NUMBER, caption: CANARY.caption, media: { url: CANARY.url } });
  // an engine failure: logged and answered without its cause
  kit.messaging.refuse.submit = new Error("engine exploded");
  await call("POST", `${P}/test`, { format: "text", to: NUMBER, text: CANARY.text });
  delete kit.messaging.refuse.submit;
  // a revoke whose cancellation fails: logged
  kit.messaging.cancelThrows = true;
  await call("POST", `${P}/keys/${copy.json.key.id}/revoke`, { confirm: true });
  await call("POST", `${P}/keys/${id}/revoke`, { confirm: true });

  for (const read of [P, `${P}/keys`, `${P}/catalog`, `${P}/messages`, `${P}/usage?days=30`, `${P}/openapi`, "/admin/api/audit?pageSize=200"]) {
    bodies.push({ label: `GET ${read}`, text: (await kit.get(read)).text });
  }
  const first = (await kit.get(`${P}/messages`)).json.items;
  for (const item of first) bodies.push({ label: `GET message ${item.id}`, text: (await kit.get(`${P}/messages/${item.id}`)).text });
  return { secrets, bodies, created, copy };
}

async function corpora({ bodies }) {
  const tables = [];
  for (const name of ["ApiKey", "ApiMessage", "ApiMessageResponse", "ApiState"]) {
    for (const row of await kit.db[name].findAll({ raw: true })) tables.push({ label: `${name} row`, text: JSON.stringify(row) });
  }
  const audits = (await kit.db.AuditLog.findAll({ raw: true })).map((row) => ({ label: `audit ${row.action}`, text: `${row.target} ${row.detail}` }));
  const logs = [
    ...kit.t.logger.lines.map((line) => ({ label: `log ${line.level}`, text: JSON.stringify(line.args) })),
    ...(typeof ring.list === "function" ? ring.list().map((entry) => ({ label: "ring", text: JSON.stringify(entry) })) : []),
  ];
  return { tables, audits, logs, bodies };
}

/** A response body with the one allowed `secret` value taken out */
const withoutSecret = (text) => text.replace(/"secret":"[^"]*"/, '"secret":"-"');

describe("SC-003, panel side: no secret and no content outside the one secret field", () => {
  test("the scenario really ran: secrets were issued and the refusals were exercised", async () => {
    const run = await scenario();
    assert.equal(run.secrets.length, 2);
    assert.notEqual(run.secrets[0], run.secrets[1]);
    const statuses = run.bodies.filter((b) => b.label.startsWith("POST")).map((b) => b.text);
    assert.ok(statuses.length >= 9);
    assert.ok((await kit.audits("api.")).length >= 6, "audit rows exist to be scanned");
    assert.ok(kit.t.logger.lines.length > 0, "something was logged (the failed revoke cancellation and the engine failure)");
    assert.equal(kit.messaging.calls.submit.length, 3, "two accepted sends and the failing one reached the engine");
  });

  test("no token, no 43-character secret part and no canary in the log ring, the audit rows, the answers and the tables", async () => {
    const run = await scenario();
    const all = await corpora(run);
    const forbidden = [
      ...run.secrets,
      ...run.secrets.map((secret) => secret.slice(22)),
      ...Object.values(CANARY),
    ];
    const hits = [];
    for (const group of Object.values(all)) {
      for (const item of group) {
        const text = withoutSecret(item.text);
        for (const needle of forbidden) if (text.includes(needle)) hits.push(`${item.label}: ${needle.slice(0, 18)}`);
      }
    }
    assert.deepEqual(hits, []);
  });

  test("the token shape owbk_<16 hex>_ appears nowhere outside the secret field of API-5 and API-7", async () => {
    const run = await scenario();
    const all = await corpora(run);
    const hits = [];
    for (const group of Object.values(all)) {
      for (const item of group) if (TOKEN_SHAPE.test(withoutSecret(item.text))) hits.push(item.label);
    }
    assert.deepEqual(hits, []);
    const withSecrets = run.bodies.filter((b) => /"secret":"owbk_/.test(b.text));
    assert.deepEqual(withSecrets.map((b) => b.label), [`POST ${P}/keys`, `POST ${P}/keys/${run.created.json.key.id}/duplicate`]);
  });

  test("a refused request echoes none of what it was sent", async () => {
    const run = await scenario();
    const refused = run.bodies.filter((b) => b.label.startsWith("POST") && /"error"/.test(b.text));
    assert.ok(refused.length >= 4);
    for (const body of refused) for (const value of Object.values(CANARY)) assert.ok(!body.text.includes(value), `${body.label} echoed ${value.slice(0, 14)}`);
  });

  test("the audit rows carry no recipient, no content and no file; the key names and last4 are the only identifying text", async () => {
    const run = await scenario();
    const rows = await kit.audits("api.");
    const text = rows.map((r) => `${r.target} ${r.raw}`).join("\n");
    assert.ok(!text.includes("23769000000"), "no recipient");
    for (const row of rows.filter((r) => r.action === "api.test")) {
      assert.deepEqual(Object.keys(row.detail).sort(), ["format", "kind"], "api.test holds no recipient and no content");
    }
    assert.ok(rows.some((r) => r.action === "api.key.create" && r.detail.name === "leak scan"));
    assert.ok(run.secrets.every((secret) => !text.includes(secret.slice(-8)) || text.includes(`"last4":"${secret.slice(-4)}"`)), "only the last 4 characters may appear");
  });
});
