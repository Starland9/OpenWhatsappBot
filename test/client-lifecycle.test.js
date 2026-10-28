"use strict";
/**
 * lib/baileys/client.js lifecycle (contracts/runtime.md section 6, US4, SC-006):
 *
 *  - the status machine (idle | connecting | qr | open | reconnecting | stopped | logged_out) and its transitions;
 *  - the `qr` event and `qrVersion`; the QR string is never part of getState();
 *  - restartRequired (515) reconnects at once, an ordinary close waits 3 s, loggedOut (401) does not reconnect;
 *  - the generation token: events of a replaced socket are ignored and cannot reset `isReady`;
 *  - initialize() and restart() are single-flight; restart() keeps the session and shows no QR;
 *  - the backoff 3 s x 2^n capped at 60 s, reset on open; a failing initialize() inside a reconnect is retried;
 *  - requestPairingCode(): preconditions, error codes, XXXX-XXXX format, last two digits only in the logs;
 *  - resetSession(): path guards, symlink refusal, contents only, no file read, tracked credential writes awaited,
 *    and the automatic reset of an abandoned pairing;
 *  - `.logout(` appears in client.js only.
 *
 * No network and no WhatsApp: Baileys is replaced by test/helpers/fakeBaileys.js; the sessions directory is a
 * temporary directory (the real sessions/ is never touched).
 */

const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const fakes = require("./helpers/fakes");
const { loadClientWithFakeBaileys } = require("./helpers/fakeBaileys");

fakes.setupEnv();

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-client-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Let the pending promise chains and immediate callbacks run (no timer, so it works under mock.timers) */
async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** A fake Baileys, a quiet console and a client on a temporary sessions root */
function makeEnv(t, options = {}) {
  const log = mock.method(console, "log", () => {});
  const error = mock.method(console, "error", () => {});
  const env = loadClientWithFakeBaileys(options);
  const root = tmp(t);
  t.after(() => {
    env.restore();
    log.mock.restore();
    error.mock.restore();
  });
  env.root = root;
  env.newClient = () => new env.WhatsAppClient("main", { sessionsRoot: root });
  return env;
}

/** Initialize and open the connection */
async function started(env, client = env.newClient()) {
  await client.initialize();
  const sock = env.last();
  env.open(sock);
  return { client, sock };
}

const callsOf = (sock, method) => sock.calls.filter((c) => c.method === method);
const statusOf = (client) => client.getState().status;
const rejectsWith = (code) => (error) => error && error.name === "ClientError" && error.code === code;

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

test("transition table: idle -> connecting -> qr -> open -> reconnecting -> connecting -> logged_out -> stopped", async (t) => {
  const env = makeEnv(t);
  const client = env.newClient();
  const seen = [];
  client.on("state", (s) => {
    if (seen.at(-1) !== s.status) seen.push(s.status);
  });

  assert.equal(statusOf(client), "idle");
  await client.initialize();
  assert.equal(statusOf(client), "connecting");
  const first = env.last();

  env.qr(first, "qr-payload-one");
  assert.equal(statusOf(client), "qr");
  env.open(first);
  assert.equal(statusOf(client), "open");
  assert.equal(client.ready(), true);

  env.gate.promise = new Promise(() => {}); // hold the reconnect delay: observe "reconnecting"
  env.closeWith(first); // ordinary close
  assert.equal(statusOf(client), "reconnecting");
  assert.equal(client.ready(), false);
  assert.equal(client.getState().lastClose.loggedOut, false);

  // a new client: connecting -> logged_out on 401
  const other = env.newClient();
  await other.initialize();
  const second = env.last();
  env.closeWith(second, 401);
  assert.equal(statusOf(other), "logged_out");
  assert.equal(other.getState().lastClose.loggedOut, true);
  assert.equal(other.getState().lastClose.code, 401);

  await other.stop();
  assert.equal(statusOf(other), "stopped");

  assert.deepEqual(seen, ["connecting", "qr", "open", "reconnecting"]);
});

test("every transition emits a `state` copy: mutating it never changes the client", async (t) => {
  const env = makeEnv(t);
  const client = env.newClient();
  const copies = [];
  client.on("state", (s) => copies.push(s));
  await client.initialize();
  env.open();
  assert.ok(copies.length >= 2);
  copies.at(-1).status = "hacked";
  copies.at(-1).me.number = "0";
  assert.equal(statusOf(client), "open");
  assert.equal(client.getState().me.number, "999");
  const state = client.getState();
  assert.deepEqual(Object.keys(state).sort(), [
    "generation", "hasQr", "lastClose", "me", "pairing", "qrIssuedAt", "qrVersion", "reconnectAttempt",
    "registered", "since", "status",
  ]);
  assert.deepEqual(state.me, { number: "999", name: "Bot" });
  assert.equal(state.registered, true);
});

test("qr event: qrVersion increments, the QR string is never in getState() and is registered with the redactor", async (t) => {
  const env = makeEnv(t);
  const client = env.newClient();
  const events = [];
  client.on("qr", (qr, version) => events.push([qr, version]));
  await client.initialize();
  const sock = env.last();

  env.qr(sock, "SECRET-QR-PAYLOAD-0001");
  env.qr(sock, "SECRET-QR-PAYLOAD-0002");
  assert.deepEqual(events, [["SECRET-QR-PAYLOAD-0001", 1], ["SECRET-QR-PAYLOAD-0002", 2]]);
  assert.equal(client.getState().qrVersion, 2);
  assert.equal(client.getState().hasQr, true);
  assert.ok(Number.isFinite(client.getState().qrIssuedAt));
  assert.ok(!JSON.stringify(client.getState()).includes("SECRET-QR-PAYLOAD"), "the QR string is not part of the state");
  assert.deepEqual(client.getPairingArtifacts(), { qr: "SECRET-QR-PAYLOAD-0002", qrVersion: 2 });

  const printed = console.log.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  assert.ok(!printed.includes("SECRET-QR-PAYLOAD"), "the QR string is never printed");
  const redactor = require("../lib/admin/logs/redactor");
  assert.ok(!redactor.scrub("leak SECRET-QR-PAYLOAD-0001 here").includes("SECRET-QR-PAYLOAD-0001"));
  assert.ok(!redactor.scrub("leak SECRET-QR-PAYLOAD-0002 here").includes("SECRET-QR-PAYLOAD-0002"));

  env.open(sock);
  assert.equal(client.getState().hasQr, false);
  assert.equal(client.getPairingArtifacts().qr, null);
});

// ---------------------------------------------------------------------------
// Close handling
// ---------------------------------------------------------------------------

test("restartRequired (515) reconnects at once, an ordinary close waits 3 s (SC-006)", async (t) => {
  const env = makeEnv(t);
  const { client, sock } = await started(env);

  env.closeWith(sock, 515);
  await settle();
  assert.equal(env.sockets.length, 2, "a new socket exists without waiting");
  assert.deepEqual(env.delays, [], "no reconnect delay");
  assert.equal(statusOf(client), "connecting");
  env.open();

  // ordinary close: gated 3 s delay
  let release;
  env.gate.promise = new Promise((resolve) => (release = resolve));
  env.closeWith(env.last(), 408);
  await settle();
  assert.deepEqual(env.delays, [3000]);
  assert.equal(env.sockets.length, 2, "still waiting");
  assert.equal(statusOf(client), "reconnecting");
  release();
  await settle();
  assert.equal(env.sockets.length, 3);
});

test("loggedOut (401) does not reconnect", async (t) => {
  const env = makeEnv(t);
  const { client, sock } = await started(env);
  env.closeWith(sock, 401);
  await settle();
  assert.equal(statusOf(client), "logged_out");
  assert.equal(env.sockets.length, 1);
  assert.deepEqual(env.delays, []);
  assert.equal(client.ready(), false);
});

test("stale events of a replaced socket are ignored and cannot reset isReady", async (t) => {
  const env = makeEnv(t);
  const { client, sock: first } = await started(env);
  const messages = [];
  client.on("messages", (batch) => messages.push(batch));

  env.closeWith(first, 515);
  await settle();
  const second = env.last();
  assert.notEqual(first, second);
  env.open(second);
  assert.equal(client.ready(), true);
  const generation = client.getState().generation;

  // late events of the first socket
  env.closeWith(first, undefined);
  env.qr(first, "stale-qr-payload");
  first.ev.emit("connection.update", { connection: "open" });
  first.ev.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: "x@s.whatsapp.net", id: "S1" } }] });
  first.ev.emit("groups.update", [{ id: "120@g.us" }]);
  await settle();

  assert.equal(client.ready(), true, "the new socket stays ready");
  assert.equal(statusOf(client), "open");
  assert.equal(client.getState().generation, generation);
  assert.equal(client.getState().qrVersion, 0, "a stale QR is dropped");
  assert.deepEqual(messages, [], "a stale message batch is dropped");
  assert.equal(env.sockets.length, 2, "no reconnection was triggered by the stale close");
  assert.deepEqual(env.delays, []);

  // the current socket still delivers
  second.ev.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: "x@s.whatsapp.net", id: "C1" } }] });
  await settle();
  assert.equal(messages.length, 1);
});

test("a close that follows stop() is reported once and does not touch a newer socket", async (t) => {
  const env = makeEnv(t);
  const { client, sock } = await started(env);
  const closes = [];
  client.on("close", () => closes.push("close"));

  await client.stop();
  assert.deepEqual(closes, ["close"]);
  await client.initialize();
  env.open();
  // the old socket reports its close a second time, late
  env.closeWith(sock, undefined);
  await settle();
  assert.deepEqual(closes, ["close"]);
  assert.equal(client.ready(), true);
  assert.equal(statusOf(client), "open");
});

// ---------------------------------------------------------------------------
// Single flight, restart, backoff
// ---------------------------------------------------------------------------

test("initialize() is single-flight: concurrent calls share the pending promise", async (t) => {
  const env = makeEnv(t);
  const client = env.newClient();
  const a = client.initialize();
  const b = client.initialize();
  assert.equal(a, b);
  await Promise.all([a, b]);
  assert.equal(env.sockets.length, 1);
  assert.equal(client.getState().generation, 1);
  // after it settled, a new call starts a new connection
  await client.initialize();
  assert.equal(env.sockets.length, 2);
  assert.equal(client.getState().generation, 2);
});

test("restart() keeps the session, shows no QR and is single-flight", async (t) => {
  const env = makeEnv(t, { registered: true });
  const { client, sock } = await started(env);

  const a = client.restart();
  const b = client.restart();
  assert.equal(a, b, "concurrent restarts share the pending promise");
  await a;

  assert.equal(callsOf(sock, "logout").length, 0, "restart() never unlinks the device");
  assert.equal(callsOf(sock, "end").length, 1);
  assert.equal(env.sockets.length, 2);
  assert.equal(env.authStates.length, 2);
  assert.equal(env.authStates[0].dir, env.authStates[1].dir, "same credentials folder");
  assert.equal(client.getState().qrVersion, 0, "no QR");
  assert.equal(client.getState().registered, true);
  assert.equal(statusOf(client), "connecting");
  assert.deepEqual(env.delays, [], "no reconnect delay");
  assert.equal(client.stopped, false);

  // restart() is usable again once it settled
  env.open();
  await client.restart();
  assert.equal(env.sockets.length, 3);
});

test("backoff 3 s x 2^n capped at 60 s, reset on open", async (t) => {
  const env = makeEnv(t);
  const { client } = await started(env);

  for (let i = 0; i < 7; i++) {
    env.closeWith(env.last());
    await fakes.waitFor(() => env.sockets.length === i + 2);
  }
  assert.deepEqual(env.delays, [3000, 6000, 12000, 24000, 48000, 60000, 60000]);
  assert.equal(client.getState().reconnectAttempt, 7);

  env.open();
  assert.equal(client.getState().reconnectAttempt, 0, "reset on open");
  env.closeWith(env.last());
  await fakes.waitFor(() => env.delays.length === 8);
  assert.equal(env.delays.at(-1), 3000);
});

test("a failing initialize() inside a reconnect is retried with backoff, not an unhandled rejection", async (t) => {
  const env = makeEnv(t);
  const { client, sock } = await started(env);

  env.flags.failCreate = 2;
  env.closeWith(sock);
  await fakes.waitFor(() => env.sockets.length === 2);

  assert.deepEqual(env.delays, [3000, 6000, 12000], "two failures, then the third attempt works");
  assert.equal(statusOf(client), "connecting");
  assert.equal(client.stopped, false);
});

test("stop() during a failing reconnect ends the retries", async (t) => {
  const env = makeEnv(t);
  const { client, sock } = await started(env);
  env.flags.failCreate = 100;
  let release;
  const hold = () => {
    env.gate.promise = new Promise((resolve) => (release = resolve));
  };

  hold();
  env.closeWith(sock);
  await settle();
  assert.deepEqual(env.delays, [3000]);
  release(); // the first attempt fails, the loop waits again
  hold();
  await settle();
  assert.deepEqual(env.delays, [3000, 6000]);

  await client.stop();
  release(); // the wait in flight ends after the stop: no third attempt
  await settle(30);
  assert.deepEqual(env.delays, [3000, 6000]);
  assert.equal(env.sockets.length, 1);
  assert.equal(statusOf(client), "stopped");
});

// ---------------------------------------------------------------------------
// requestPairingCode
// ---------------------------------------------------------------------------

test("requestPairingCode: invalid numbers are refused before anything else", async (t) => {
  const env = makeEnv(t);
  const client = env.newClient();
  await client.initialize();
  for (const phone of ["", "abc", "1234567", "1234567890123456", "12 34 56 78 9a", null, undefined, "+12-345-678-90"]) {
    await assert.rejects(client.requestPairingCode(phone), rejectsWith("invalid_phone"), JSON.stringify(phone));
  }
  assert.equal(callsOf(env.last(), "requestPairingCode").length, 0);
});

test("requestPairingCode: not_connecting without a socket or outside connecting/qr", async (t) => {
  const env = makeEnv(t);
  const client = env.newClient();
  await assert.rejects(client.requestPairingCode("237690000012"), rejectsWith("not_connecting"));
  await client.initialize();
  env.gate.promise = new Promise(() => {});
  env.open();
  // open and now registered: already_registered wins over not_connecting
  await assert.rejects(client.requestPairingCode("237690000012"), rejectsWith("already_registered"));
  env.closeWith(env.last(), 401);
  const loggedOut = env.newClient();
  await assert.rejects(loggedOut.requestPairingCode("237690000012"), rejectsWith("not_connecting"));
});

test("requestPairingCode: already_registered when the credentials are those of a linked device", async (t) => {
  const env = makeEnv(t, { registered: true });
  const client = env.newClient();
  await client.initialize();
  assert.equal(statusOf(client), "connecting");
  await assert.rejects(client.requestPairingCode("237690000012"), rejectsWith("already_registered"));
});

test("requestPairingCode: XXXX-XXXX, 3 minutes, waits for the socket, last two digits only in the logs", async (t) => {
  const env = makeEnv(t);
  mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  t.after(() => mock.timers.reset());
  const logger = require("../lib/utils/logger");
  const lines = [];
  logger.setLevel("info");
  logger.setOutput((text) => lines.push(text));
  t.after(() => {
    logger.setOutput();
    logger.setLevel("silent");
  });

  const client = env.newClient();
  await client.initialize();
  const sock = env.last();
  env.qr(sock);
  const result = await client.requestPairingCode("+237 690 00 00 12");

  assert.deepEqual(result, { code: "ABCD-1234", expiresAt: 1_700_000_000_000 + 180_000 });
  const order = sock.calls.filter((c) => c.method === "waitForSocketOpen" || c.method === "requestPairingCode");
  assert.deepEqual(order.map((c) => c.method), ["waitForSocketOpen", "requestPairingCode"]);
  assert.deepEqual(order[1].args, ["237690000012"], "digits only");
  assert.deepEqual(client.getState().pairing, { requestedAt: 1_700_000_000_000, expiresAt: 1_700_000_000_000 + 180_000 });
  assert.ok(!JSON.stringify(client.getState()).includes("ABCD"), "the code is not part of the state");

  const logged = lines.join("\n");
  assert.ok(/last2.*12/.test(logged), "the last two digits are logged");
  for (const leak of ["237690000012", "690000012", "237690", "ABCD-1234", "ABCD1234"]) {
    assert.ok(!logged.includes(leak), `the log must not contain ${leak}`);
  }
  const redactor = require("../lib/admin/logs/redactor");
  assert.ok(!redactor.scrub("code ABCD-1234 or ABCD1234").includes("ABCD"), "the code is scrubbed from any log line");
});

test("requestPairingCode: one request per 30 s (rate_limited with retryAfterMs), pairing_failed", async (t) => {
  const env = makeEnv(t);
  mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  t.after(() => mock.timers.reset());
  const client = env.newClient();
  await client.initialize();

  await client.requestPairingCode("237690000012");
  mock.timers.tick(10_000);
  await assert.rejects(client.requestPairingCode("237690000012"), (error) => {
    assert.ok(rejectsWith("rate_limited")(error));
    assert.equal(error.params.retryAfterMs, 20_000);
    return true;
  });
  mock.timers.tick(20_000);
  await client.requestPairingCode("237690000012"); // exactly 30 s later

  mock.timers.tick(30_000);
  env.pairing.error = new Error("WA refused");
  await assert.rejects(client.requestPairingCode("237690000012"), rejectsWith("pairing_failed"));
  mock.timers.tick(30_000);
  env.pairing.error = null;
  env.pairing.code = "TOOSHORT-LONG-CODE";
  await assert.rejects(client.requestPairingCode("237690000012"), rejectsWith("pairing_failed"));
});

// ---------------------------------------------------------------------------
// resetSession
// ---------------------------------------------------------------------------

/** sessions/main with creds, a keys sub-directory, and an outside directory a symlink points to */
function populate(root) {
  const dir = path.join(root, "main");
  fs.mkdirSync(path.join(dir, "keys"), { recursive: true });
  fs.writeFileSync(path.join(dir, "creds.json"), "{}");
  fs.writeFileSync(path.join(dir, "keys", "pre-key-1.json"), "{}");
  return dir;
}

test("resetSession: empties the CONTENTS only, never reads a file, logs a count, then connects again", async (t) => {
  const env = makeEnv(t);
  const dir = populate(env.root);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "owb-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "precious.txt"), "keep");
  fs.symlinkSync(outside, path.join(dir, "link-to-outside"));
  const inode = fs.statSync(dir).ino;

  const reads = [
    mock.method(fs.promises, "readFile"),
    mock.method(fs, "readFileSync"),
    mock.method(fs, "createReadStream"),
  ];
  t.after(() => reads.forEach((spy) => spy.mock.restore()));
  const logger = require("../lib/utils/logger");
  const lines = [];
  logger.setLevel("info");
  logger.setOutput((text) => lines.push(text));
  t.after(() => {
    logger.setOutput();
    logger.setLevel("silent");
  });

  const { client, sock } = await started(env);
  const generation = client.getState().generation;
  const result = await client.resetSession();

  assert.deepEqual(result, { removed: 3 }, "creds.json, keys/ and the symlink");
  assert.deepEqual(fs.readdirSync(dir), [], "the folder is empty");
  assert.equal(fs.statSync(dir).ino, inode, "the folder itself is kept (it may be a volume mount)");
  assert.ok(fs.existsSync(path.join(outside, "precious.txt")), "a symlink is unlinked, never followed");
  assert.equal(callsOf(sock, "logout").length, 1, "best-effort logout first");
  assert.equal(env.sockets.length, 2, "then a new socket for a fresh QR");
  assert.ok(client.getState().generation > generation);
  assert.equal(client.getState().registered, false);
  assert.equal(client.getState().me, null);
  assert.equal(statusOf(client), "connecting");
  for (const spy of reads) assert.equal(spy.mock.calls.length, 0, "no file is read");

  const logged = lines.join("\n");
  assert.ok(/removed.*3/.test(logged), "only the number of removed entries is logged");
  for (const name of ["creds.json", "pre-key-1", "keys", "link-to-outside", "precious"]) {
    assert.ok(!logged.includes(name), `the log must not name ${name}`);
  }
});

test("resetSession: a socket that cannot log out is closed instead", async (t) => {
  const env = makeEnv(t);
  populate(env.root);
  const { client, sock } = await started(env);
  sock.logoutError = new Error("socket is down");
  const result = await client.resetSession();
  assert.equal(result.removed, 2);
  assert.equal(callsOf(sock, "end").length, 1);
});

test("resetSession: a missing folder is not an error", async (t) => {
  const env = makeEnv(t);
  const { client } = await started(env);
  assert.deepEqual(await client.resetSession(), { removed: 0 });
  assert.equal(env.sockets.length, 2);
});

test("resetSession: refuses a path that is not <sessions>/<id>, before changing anything", async (t) => {
  const env = makeEnv(t);
  const dir = populate(env.root);
  const { client, sock } = await started(env);
  const generation = client.getState().generation;

  // 1. sessionPath no longer equals <root>/<id>
  client.sessionPath = path.join(env.root, "somewhere-else");
  await assert.rejects(client.resetSession(), rejectsWith("invalid_session_path"));
  client.sessionPath = path.join(env.root, "main", "..", "main", "..");
  await assert.rejects(client.resetSession(), rejectsWith("invalid_session_path"));
  client.sessionPath = path.join(env.root, "main");

  // 2. an id that is not word characters
  for (const id of ["../main", "a b", "a/b", "", "main\n"]) {
    const bad = new env.WhatsAppClient(id, { sessionsRoot: env.root });
    await assert.rejects(bad.resetSession(), rejectsWith("invalid_session_path"), JSON.stringify(id));
  }

  assert.ok(fs.existsSync(path.join(dir, "creds.json")), "nothing was removed");
  assert.equal(callsOf(sock, "logout").length, 0, "nothing was unlinked");
  assert.equal(client.getState().generation, generation);
  assert.equal(statusOf(client), "open");
  assert.equal(client.ready(), true);
});

test("resetSession: refuses a symlinked session folder and leaves its target alone", async (t) => {
  const env = makeEnv(t);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "owb-target-"));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.writeFileSync(path.join(target, "creds.json"), "{}");
  fs.symlinkSync(target, path.join(env.root, "main"));

  const { client, sock } = await started(env);
  await assert.rejects(client.resetSession(), rejectsWith("invalid_session_path"));
  assert.ok(fs.existsSync(path.join(target, "creds.json")), "the symlink target is untouched");
  assert.equal(callsOf(sock, "logout").length, 0);
  assert.equal(statusOf(client), "open");

  // a regular file in place of the folder is refused too
  fs.unlinkSync(path.join(env.root, "main"));
  fs.writeFileSync(path.join(env.root, "main"), "not a directory");
  await assert.rejects(client.resetSession(), rejectsWith("invalid_session_path"));
});

test("resetSession waits for the credential writes in flight, and drops those of the old socket afterwards", async (t) => {
  let release;
  const gateOpen = new Promise((resolve) => (release = resolve));
  const env = makeEnv(t, {
    async onSave(dir) {
      await gateOpen;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "creds.json"), "late");
    },
  });
  const dir = populate(env.root);
  const { client, sock } = await started(env);

  sock.ev.emit("creds.update", { me: {} }); // a write now waits on the gate
  const reset = client.resetSession();
  await settle();
  assert.ok(fs.existsSync(path.join(dir, "keys")), "the wipe waits for the write in flight");
  release();
  const result = await reset;

  assert.ok(result.removed >= 2);
  assert.deepEqual(fs.readdirSync(dir), [], "the late write did not survive the reset");
  // a late creds.update of the old socket after the reset is dropped
  const saves = env.authStates[0].saves;
  sock.ev.emit("creds.update", { me: {} });
  await settle();
  assert.equal(env.authStates[0].saves, saves);
});

test("resetSession is single-flight", async (t) => {
  const env = makeEnv(t);
  populate(env.root);
  const { client } = await started(env);
  const a = client.resetSession();
  const b = client.resetSession();
  assert.equal(a, b);
  await a;
  assert.equal(env.sockets.length, 2);
});

// ---------------------------------------------------------------------------
// Abandoned pairing
// ---------------------------------------------------------------------------

test("a close during a pending pairing (not 515, not registered) resets the session", async (t) => {
  const env = makeEnv(t);
  const dir = populate(env.root);
  const client = env.newClient();
  await client.initialize();
  const sock = env.last();
  env.qr(sock);
  await client.requestPairingCode("237690000012");
  assert.ok(client.getState().pairing);

  env.closeWith(sock, 408);
  await fakes.waitFor(() => env.sockets.length === 2);

  assert.deepEqual(fs.readdirSync(dir), [], "the poisoned credentials are gone");
  assert.equal(client.getState().pairing, null);
  assert.equal(callsOf(sock, "logout").length, 1);
  assert.deepEqual(env.delays, [], "no ordinary reconnect: the reset starts the new connection");
});

test("a 515 close during a pending pairing keeps the session and reconnects at once", async (t) => {
  const env = makeEnv(t);
  const dir = populate(env.root);
  const client = env.newClient();
  await client.initialize();
  const sock = env.last();
  env.qr(sock);
  await client.requestPairingCode("237690000012");

  env.closeWith(sock, 515);
  await settle();
  assert.equal(env.sockets.length, 2);
  assert.ok(fs.existsSync(path.join(dir, "creds.json")), "the session is kept");
  assert.equal(callsOf(sock, "logout").length, 0);
  assert.ok(client.getState().pairing, "the pairing stays pending until the new socket opens");

  env.open();
  assert.equal(client.getState().pairing, null, "the pairing is over once connected");
  assert.equal(client.getState().registered, true);
});

test("a pairing that is registered by the time the socket closes is not wiped", async (t) => {
  const env = makeEnv(t);
  const dir = populate(env.root);
  const client = env.newClient();
  await client.initialize();
  const sock = env.last();
  env.qr(sock);
  await client.requestPairingCode("237690000012");
  sock.authState.creds.registered = true; // WhatsApp accepted the code

  env.closeWith(sock, 408);
  await fakes.waitFor(() => env.delays.length === 1);
  assert.ok(fs.existsSync(path.join(dir, "creds.json")));
  assert.equal(callsOf(sock, "logout").length, 0);
});

test("the 3-minute window ends without a connection: the session is reset", async (t) => {
  const env = makeEnv(t);
  const dir = populate(env.root);
  const client = env.newClient();
  await client.initialize();
  env.qr(env.last());

  mock.timers.enable({ apis: ["setTimeout"] });
  let ticked = false;
  try {
    await client.requestPairingCode("237690000012");
    mock.timers.tick(179_999);
    assert.ok(fs.existsSync(path.join(dir, "creds.json")), "not yet");
    mock.timers.tick(1);
    ticked = true;
  } finally {
    mock.timers.reset();
  }
  assert.ok(ticked);
  await fakes.waitFor(() => env.sockets.length === 2);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(client.getState().pairing, null);
});

test("the 3-minute window does nothing once the socket opened", async (t) => {
  const env = makeEnv(t);
  const dir = populate(env.root);
  const client = env.newClient();
  await client.initialize();
  env.qr(env.last());

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await client.requestPairingCode("237690000012");
    env.open();
    mock.timers.tick(10 * 60 * 1000);
  } finally {
    mock.timers.reset();
  }
  await settle();
  assert.ok(fs.existsSync(path.join(dir, "creds.json")));
  assert.equal(env.sockets.length, 1);
  assert.equal(statusOf(client), "open");
});

// ---------------------------------------------------------------------------
// Static rules
// ---------------------------------------------------------------------------

test(".logout( appears in lib/baileys/client.js only (and never in the shutdown path)", () => {
  const roots = ["lib", "plugins", "tools"];
  const files = ["index.js", "panel.js", "config.js"];
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "public" ? [] : walk(full);
      return entry.name.endsWith(".js") ? [full] : [];
    });
  const all = [...roots.flatMap((r) => walk(path.join(fakes.ROOT, r))), ...files.map((f) => path.join(fakes.ROOT, f))];
  const offenders = all
    .filter((file) => /\.logout\s*\(/.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(fakes.ROOT, file).split(path.sep).join("/"));
  assert.deepEqual(offenders, ["lib/baileys/client.js"]);

  const source = fs.readFileSync(path.join(fakes.ROOT, "lib/baileys/client.js"), "utf8");
  const stopBody = source.slice(source.indexOf("async stop()"), source.indexOf("async logout()"));
  assert.ok(!/logout\s*\(/.test(stopBody), "stop() must not call logout");
});
