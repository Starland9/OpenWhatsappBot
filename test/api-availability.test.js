"use strict";
/**
 * Feature 004 (messaging API): availability, the table of contracts/public-api.md section 9, over the real stack
 * behind the real `createPanelServer`: a switched-off API, `ADMIN_PANEL=false` and a failed endpoint registry answer
 * byte for byte like an unknown URL (GET, POST and OPTIONS, with and without a key); the bot starting and a restore
 * running answer `503 unavailable`; switching off and revoking cancel the queue; a disconnection only delays.
 */

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const { createApiHarness } = require("./helpers/apiHarness");

const MIN = 60 * 1000;
const ID = `msg_${"A".repeat(22)}`;
const TEXT = { format: "text", to: "237690000001", text: "hello" };

let h;
const temporary = [];
afterEach(async () => {
  if (h) await h.close();
  h = null;
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** An endpoint directory whose only module declares no right: the whole registry fails (FR-090) */
function brokenDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-avail-"));
  temporary.push(dir);
  fs.writeFileSync(path.join(dir, "bad.js"), '"use strict";\nmodule.exports = { id: "bad.get", method: "GET", path: "/api/v1/bad", doc: { summary: "x" }, handle() {} };\n');
  return dir;
}

const stripped = (res) =>
  JSON.stringify({
    status: res.status,
    headers: Object.fromEntries(Object.entries(res.headers).filter(([name]) => !["date", "connection", "keep-alive"].includes(name))),
    // the status page shows the memory of the process, which drifts between two requests
    text: res.text.replace(/(stat-value">)\d+ MB/g, "$1N MB"),
  });

const URLS = ["/api/v1/messages", "/api/v1/openapi.json", "/api/v1", `/api/v1/messages/${ID}`, "/api/v1/", "/api/v9/anything"];

/** Every shape the contract names answers like `/unknown` of the same verb */
async function assertUnclaimed(harness, key) {
  for (const method of ["GET", "POST", "OPTIONS"]) {
    const body = method === "POST" ? TEXT : undefined;
    const expected = stripped(await harness.legacy("/unknown", { method, body }));
    for (const url of URLS) {
      for (const withKey of [undefined, key]) {
        const res = await harness.request(method, url, { key: withKey, body });
        assert.equal(stripped(res), expected, `${method} ${url} ${withKey ? "with" : "without"} a key`);
        assert.equal(res.headers["x-request-id"], undefined, "no API header leaks");
      }
    }
  }
}

describe("an API that is not claimed answers like any unknown URL", () => {
  test("the switch is off (the default)", async () => {
    h = await createApiHarness({ enabled: false });
    const key = await h.createKey({});
    await assertUnclaimed(h, key);
    assert.equal(await h.db.ApiMessage.count(), 0);
    const legacy = await h.legacy("/unknown");
    assert.equal(legacy.status, 200);
    assert.match(legacy.headers["content-type"], /^text\/html/);
  });

  test("ADMIN_PANEL=false: no API object is built, or the panel flag turns an on switch off", async () => {
    h = await createApiHarness({ mount: false });
    const key = await h.createKey({});
    await assertUnclaimed(h, key);
    await h.close();

    h = await createApiHarness({ enabled: true });
    const second = await h.createKey({});
    assert.equal((await h.get("/api/v1/messages", second)).status, 200);
    h.config.ADMIN_PANEL = false;
    await assertUnclaimed(h, second);
  });

  test("the endpoint registry failed at boot: nothing is served, the bot and the engine keep running", async () => {
    h = await createApiHarness({ endpointsDir: brokenDir() });
    assert.equal(h.api.state().failure.code, "registry_failed");
    assert.equal(h.api.state().failure.endpoint, "bad.get");
    const key = await h.createKey({});
    await assertUnclaimed(h, key);
    assert.deepEqual(h.api.routes(), []);
    assert.deepEqual(h.api.catalog().endpoints, []);
    await h.api.start();
    const errors = h.logLines.filter((line) => line.level === "error");
    assert.equal(errors.length, 1, "one error line names the failing endpoint");
    assert.ok(String(errors[0].args[0]).includes("bad.get"));
    // the engine is alive: a message can still be accepted through its facade and sent
    const row = await h.messaging.submit({ ...h.engine.request({ apiKeyId: key.id }) });
    await h.tick(2000);
    assert.equal((await h.row(row.message.publicId)).status, "sent");
  });
});

describe("the bot starting and a restore running", () => {
  test("database not ready: 503 unavailable + Retry-After 5 before authentication, whatever the switch", async () => {
    h = await createApiHarness({ enabled: false });
    const key = await h.createKey({});
    let lookups = 0;
    const real = h.api.keys.lookup;
    h.api.keys.lookup = (...args) => {
      lookups += 1;
      return real(...args);
    };
    h.runtime.dbReady = false;
    for (const enabled of [false, true]) {
      await h.setEnabled(enabled);
      for (const [method, body] of [["GET", undefined], ["POST", TEXT], ["GET", undefined]]) {
        for (const withKey of [undefined, key]) {
          const res = await h.request(method, "/api/v1/messages", { key: withKey, body });
          assert.equal(res.status, 503);
          assert.equal(res.json.error.code, "unavailable");
          assert.equal(res.headers["retry-after"], "5");
          assert.deepEqual(res.json.error.params, { retryAfterMs: 5000 });
          assert.match(res.headers["x-request-id"], /^[0-9a-f]{16}$/);
        }
      }
    }
    assert.equal(lookups, 0, "nothing was authenticated");
    assert.equal(await h.db.ApiMessage.count(), 0, "nothing was queued");
    // a path outside /api/v1 is not claimed even while the database is not ready
    assert.equal((await h.legacy("/unknown")).status, 200);
    h.runtime.dbReady = true;
    h.api.keys.lookup = real;
    assert.equal((await h.get("/api/v1/messages", key)).status, 200);
  });

  test("a restore running: 503 while the API is on, still 'not found' while it is off, nothing re-enabled", async () => {
    h = await createApiHarness({});
    const key = await h.createKey({});
    const revoked = await h.createKey({ name: "gone", revokedAt: new Date(h.now() - MIN) });
    const accepted = await h.send(key, TEXT);
    assert.equal(accepted.status, 202);
    const snapshot = JSON.stringify(await h.dumpTables());

    h.maintenance.active = true;
    for (const method of ["GET", "POST"]) {
      const res = await h.request(method, "/api/v1/messages", { key, body: method === "POST" ? TEXT : undefined });
      assert.equal(res.status, 503);
      assert.equal(res.json.error.code, "unavailable");
      assert.equal(res.headers["retry-after"], "5");
    }
    await h.setEnabled(false);
    await assertUnclaimed(h, key);
    h.maintenance.active = false;

    assert.equal(h.apiState.isEnabled(), false, "the end of the restore does not turn the API on");
    await assertUnclaimed(h, key);
    const after = await h.dumpTables();
    // only the cancellation of the switch-off moved: no key, no state, no message came back to life
    const keys = JSON.parse(snapshot).ApiKey;
    assert.deepEqual(after.ApiKey.map((k) => [k.id, k.revokedAt && true, k.version]), keys.map((k) => [k.id, k.revokedAt && true, k.version]));
    await h.setEnabled(true);
    assert.equal((await h.get("/api/v1/messages", revoked)).json.error.code, "key_revoked");
  });
});

describe("cancellations", () => {
  test("switching the API off cancels the queue, ends the waits and leaves no timer", async () => {
    h = await createApiHarness({});
    const key = await h.createKey({});
    const first = await h.send(key, TEXT);
    const second = await h.send(key, { ...TEXT, text: "second" });
    assert.equal(first.status, 202);
    const waiting = h.request("POST", "/api/v1/messages?wait=30", { key, body: { ...TEXT, text: "third" } });
    for (let i = 0; i < 50 && (await h.db.ApiMessage.count()) < 3; i += 1) await fakes.sleep(10);
    await h.setEnabled(false);
    const ended = await waiting;
    assert.equal(ended.status, 202);
    assert.equal(ended.json.message.status, "cancelled");
    assert.deepEqual(ended.json.message.failure, { code: "api_disabled" });
    for (const row of await h.rows()) {
      assert.equal(row.status, "cancelled");
      assert.equal(row.errorCode, "api_disabled");
      assert.equal(row.payload, null, "no content stays on the server");
    }
    assert.equal(h.sock.sent.length, 0);
    assert.equal(h.clock.pending(), 0, "no timer keeps running");
    await assertUnclaimed(h, key);
    // switching back on resurrects nothing
    await h.setEnabled(true);
    await h.tick(10 * 1000);
    assert.equal(h.sock.sent.length, 0);
    assert.equal((await h.get(`/api/v1/messages/${second.json.message.id}`, key)).json.message.status, "cancelled");
  });

  test("revoking a key cancels its queue only; the next request is key_revoked", async () => {
    h = await createApiHarness({});
    const a = await h.createKey({ name: "a" });
    const b = await h.createKey({ name: "b" });
    const fromA = await h.send(a, TEXT);
    const fromB = await h.send(b, { ...TEXT, text: "b" });
    await h.revokeKey(a);
    assert.equal((await h.get("/api/v1/messages", a)).json.error.code, "key_revoked");
    assert.equal((await h.row(fromA.json.message.id)).status, "cancelled");
    assert.equal((await h.row(fromA.json.message.id)).errorCode, "key_revoked");
    await h.tick(2000);
    assert.equal((await h.row(fromB.json.message.id)).status, "sent");
    assert.equal(h.sock.sent.length, 1);
  });

  test("a key that expires while its message waits cancels it with key_expired", async () => {
    h = await createApiHarness({});
    const key = await h.createKey({ expiresAt: new Date(h.now() + 60 * 1000) });
    h.setConnected(false); // the queue is idle, so the message is still waiting when the key expires
    const accepted = await h.send(key, TEXT);
    assert.equal(accepted.status, 202);
    await h.clock.advance(90 * 1000);
    h.setConnected(true);
    await h.tick(0);
    const row = await h.row(accepted.json.message.id);
    assert.equal(row.status, "cancelled");
    assert.equal(row.errorCode, "key_expired");
    assert.equal(h.sock.sent.length, 0);
  });
});

describe("WhatsApp disconnected", () => {
  test("requests are still accepted (202); the message waits and expires, it is not a 503", async () => {
    h = await createApiHarness({});
    const key = await h.createKey({});
    h.setConnected(false);
    const res = await h.send(key, TEXT);
    assert.equal(res.status, 202);
    assert.equal(res.json.message.status, "queued");
    await h.run(9 * MIN, 30 * 1000);
    assert.equal((await h.get(`/api/v1/messages/${res.json.message.id}`, key)).json.message.status, "queued");
    await h.run(2 * MIN, 30 * 1000);
    const seen = await h.get(`/api/v1/messages/${res.json.message.id}`, key);
    assert.equal(seen.json.message.status, "expired");
    assert.equal(seen.json.message.failure, null, "an expired message has no code");
    assert.ok(seen.json.message.endedAt);
    assert.equal(h.sock.sent.length, 0);
  });

  test("a reconnection resumes the queue", async () => {
    h = await createApiHarness({});
    const key = await h.createKey({});
    h.setConnected(false);
    const res = await h.send(key, TEXT);
    await h.run(10 * 1000, 2000);
    assert.equal(h.sock.sent.length, 0);
    h.setConnected(true);
    await h.run(10 * 1000, 2000);
    assert.equal((await h.get(`/api/v1/messages/${res.json.message.id}`, key)).json.message.status, "sent");
  });
});
