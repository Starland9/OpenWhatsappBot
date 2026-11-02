"use strict";
/**
 * SC-008: an API text is never a command (feature 004, contracts/runtime.md 6, RT-70, RT-71, FR-039).
 *
 *  (a) the outbox sends `.eval 1+1` and `.restart` verbatim and never touches the command registry;
 *  (b) the pipeline ignores the echo of an id this process sent (`sentIds`), the cause being the guard;
 *  (c) an own message upserted as `append` never reaches the pipeline (the real client on a fake Baileys);
 *  (d) the bot's own number is refused as a recipient;
 *  (e) `lib/messaging/**` never reads the prefix; `sentIds` is bounded, lazy and imports nothing.
 */

const { test, describe, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fakes = require("./helpers/fakes");

const { IDS, ROOT } = fakes;
fakes.setupEnv({ sudo: "111" });

const { createEngineKit } = require("./helpers/messagingKit");
const { loadClientWithFakeBaileys } = require("./helpers/fakeBaileys");
const { scan } = require("./helpers/jsScan");
const registry = require("../lib/plugins/registry");
const pipeline = require("../lib/core/pipeline");
const antiDeleteHandler = require("../lib/utils/antiDeleteHandler");
const maintenanceMode = require("../lib/utils/maintenanceMode");
const sentIds = require("../lib/messaging/sentIds");
const config = require("../config");

const SEC = 1000;
const MIN = 60 * SEC;

let kit;

beforeEach(() => {
  maintenanceMode._reset();
  sentIds._reset();
});

afterEach(async () => {
  if (kit) {
    await kit.check();
    await kit.close();
    kit = null;
  }
  mock.restoreAll();
  registry._reset();
});

/** A plugin that records everything the pipeline would run for a body */
function probe(events) {
  return {
    command: { pattern: "eval|restart|zzcmd", desc: "probe", type: "test", ownerOnly: true },
    async execute(message, args, ctx) {
      events.push(["execute", ctx.command, args]);
      await message.reply(`ran:${ctx.command}`);
    },
    async onMessage(message) {
      events.push(["onMessage", message.body]);
      return false;
    },
  };
}

describe("(a) the outbox sends a command-looking text verbatim and never runs it", () => {
  for (const text of [".eval 1+1", ".restart", "!ping", "/start", ".ban 237690000001"]) {
    test(`${JSON.stringify(text)} is delivered as text and executeCommand is never called`, async () => {
      const spy = mock.method(registry, "executeCommand", async () => {});
      kit = await createEngineKit();
      const key = await kit.key();
      await kit.start();
      await kit.send({ apiKeyId: key.id, fields: { text } });
      await kit.tick();
      assert.equal(kit.sock.sent.length, 1);
      assert.equal(kit.sock.sent[0].content.text, text, "verbatim, no zero-width prefix, no rewrite");
      assert.equal(spy.mock.callCount(), 0);
    });
  }

  test("the same with another PREFIX in the settings: the engine neither reads nor uses it", async () => {
    const spy = mock.method(registry, "executeCommand", async () => {});
    kit = await createEngineKit();
    const key = await kit.key();
    await kit.start();
    config.PREFIX = "!";
    try {
      await kit.send({ apiKeyId: key.id, fields: { text: "!restart" } });
      await kit.tick();
    } finally {
      config.PREFIX = ".";
    }
    assert.equal(kit.sock.sent[0].content.text, "!restart");
    assert.equal(spy.mock.callCount(), 0);
  });
});

describe("(b) the pipeline ignores the echo of an API message (the sentIds guard)", () => {
  function setup(events) {
    registry._reset();
    registry.registerPlugin(probe(events), "zz-probe.js");
    const sock = fakes.fakeSocket();
    const client = fakes.fakeClient(sock);
    pipeline.attachHandlers(client);
    return { sock, client };
  }

  test("a fromMe echo carrying the recorded id runs nothing, replies nothing and is not cached for anti-delete", async () => {
    const events = [];
    const { sock, client } = setup(events);
    const cache = mock.method(antiDeleteHandler, "cacheMessage", () => {});
    sentIds.remember("3EB0APIECHOKNOWN00000001");

    await client.dispatch("messages", [fakes.rawMessage({ body: ".eval 1+1", fromMe: true, from: IDS.BOT_PN, id: "3EB0APIECHOKNOWN00000001" })], "notify");
    await fakes.sleep(10);
    assert.deepEqual(events, [], "no hook and no command");
    assert.deepEqual(sock.replies(), [], "no reply");
    assert.equal(cache.mock.callCount(), 0, "nothing in the anti-delete cache");
  });

  test("the same echo with an unknown id does reach the pipeline: the guard is the cause", async () => {
    const events = [];
    const { client } = setup(events);
    const cache = mock.method(antiDeleteHandler, "cacheMessage", () => {});
    sentIds.remember("3EB0APIECHOKNOWN00000001");

    await client.dispatch("messages", [fakes.rawMessage({ body: ".eval 1+1", fromMe: true, from: IDS.BOT_PN, id: "3EB0SOMETHINGELSE0000001" })], "notify");
    await fakes.sleep(10);
    assert.deepEqual(events[0], ["onMessage", ".eval 1+1"], "the hooks run: only the guard kept the known echo out");
    assert.equal(cache.mock.callCount(), 1);
  });

  test("the guard needs fromMe: an incoming message that reuses a remembered id is not dropped", async () => {
    const events = [];
    const { client } = setup(events);
    sentIds.remember("3EB0APIECHOKNOWN00000001");
    await client.dispatch("messages", [fakes.rawMessage({ body: ".zzcmd hi", id: "3EB0APIECHOKNOWN00000001" })], "notify");
    assert.ok(events.some((e) => e[0] === "onMessage"));
  });

  test("end to end: the engine sends, the echo of its own id comes back, the bot does not react", async () => {
    const events = [];
    const spy = mock.method(registry, "executeCommand", async () => {});
    kit = await createEngineKit({ realTime: true });
    const key = await kit.key();
    registry._reset();
    registry.registerPlugin(probe(events), "zz-probe.js");
    pipeline.attachHandlers(kit.client);
    await kit.start();
    await kit.send({ apiKeyId: key.id, fields: { text: ".eval 1+1" } });
    await kit.messaging.tick(Date.now());
    assert.equal(kit.sock.sent.length, 1);
    const waId = kit.sock.sent[0].key.id;

    await kit.client.dispatch("messages", [fakes.rawMessage({ body: ".eval 1+1", fromMe: true, from: IDS.BOT_PN, id: waId })], "notify");
    await fakes.sleep(10);
    assert.deepEqual(events, []);
    assert.equal(spy.mock.callCount(), 0);
  });

  test("the pipeline requires the leaf sentIds only, never the facade (RT-71)", () => {
    const source = scan(fs.readFileSync(path.join(ROOT, "lib", "core", "pipeline.js"), "utf8")).masked;
    assert.match(source, /require\(\s*["']\.\.\/messaging\/sentIds["']\s*\)/);
    assert.doesNotMatch(source, /require\(\s*["']\.\.\/messaging["']\s*\)/);
    assert.doesNotMatch(source, /require\(\s*["']\.\.\/messaging\/index["']\s*\)/);
  });
});

describe("(c) an own message upserted as append never leaves the client", () => {
  test("messages.upsert { type: append } emits no `messages` event; a notify one does", async (t) => {
    const log = mock.method(console, "log", () => {});
    const error = mock.method(console, "error", () => {});
    const env = loadClientWithFakeBaileys();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-never-"));
    t.after(() => {
      env.restore();
      log.mock.restore();
      error.mock.restore();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const client = new env.WhatsAppClient("main", { sessionsRoot: root });
    const batches = [];
    client.on("messages", (batch, type) => batches.push([batch, type]));
    await client.initialize();
    const sock = env.last();
    env.open(sock);

    const own = { key: { remoteJid: "237690000001@s.whatsapp.net", fromMe: true, id: "3EB0OWNAPPEND00000001" }, message: { conversation: ".eval 1+1" } };
    sock.ev.emit("messages.upsert", { type: "append", messages: [own] });
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(batches, [], "everything the socket sends is upserted as append: dropped here");

    sock.ev.emit("messages.upsert", { type: "notify", messages: [own] });
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(batches.length, 1, "control: a notify batch is re-emitted");
  });
});

describe("(d) the bot's own number is refused as a recipient", () => {
  test("accepted nowhere once the identity is known: fields.to not_allowed", async () => {
    kit = await createEngineKit();
    const key = await kit.key();
    await kit.start();
    await assert.rejects(kit.send({ apiKeyId: key.id, to: kit.OWN_NUMBER }), (err) => err.code === "validation_failed" && err.fields.to.code === "not_allowed");
    await assert.rejects(kit.send({ apiKeyId: key.id, to: `+${kit.OWN_NUMBER.slice(0, 3)} ${kit.OWN_NUMBER.slice(3)}` }), (err) => err.fields.to.code === "not_allowed");
    assert.equal(await kit.db.ApiMessage.count(), 0);
  });
});

describe("(e) static: the prefix is never read, sentIds is a bounded leaf", () => {
  const messagingFiles = () => {
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name.endsWith(".js")) out.push(file);
      }
    };
    walk(path.join(ROOT, "lib", "messaging"));
    return out;
  };

  test("no file of lib/messaging/** mentions PREFIX outside comments (RT-70)", () => {
    const files = messagingFiles();
    assert.ok(files.length > 10);
    for (const file of files) {
      const code = scan(fs.readFileSync(file, "utf8")).masked;
      assert.doesNotMatch(code, /\bPREFIX\b/, path.relative(ROOT, file));
    }
  });

  test("sentIds imports nothing, creates no timer and exports the four functions", () => {
    const source = scan(fs.readFileSync(path.join(ROOT, "lib", "messaging", "sentIds.js"), "utf8")).masked;
    assert.doesNotMatch(source, /require\(/);
    assert.doesNotMatch(source, /setTimeout|setInterval/);
    assert.deepEqual(Object.keys(sentIds).sort(), ["_reset", "has", "remember", "size"]);
  });

  test("an id is remembered for 15 minutes, no longer", () => {
    const t = 1_000_000;
    sentIds.remember("A", t);
    assert.equal(sentIds.has("A", t), true);
    assert.equal(sentIds.has("A", t + 15 * MIN - 1), true);
    assert.equal(sentIds.has("A", t + 15 * MIN), false);
    assert.equal(sentIds.has("never", t), false);
    assert.equal(sentIds.has(undefined, t), false);
    assert.equal(sentIds.has("", t), false);
  });

  test("it holds at most 2000 ids: the oldest go first, and expired ones are pruned lazily on remember", () => {
    const t = 5_000_000;
    for (let i = 0; i < 2500; i += 1) sentIds.remember(`id${i}`, t + i);
    assert.equal(sentIds.size(), 2000);
    assert.equal(sentIds.has("id0", t + 2500), false, "evicted");
    assert.equal(sentIds.has("id499", t + 2500), false);
    assert.equal(sentIds.has("id500", t + 2500), true);
    assert.equal(sentIds.has("id2499", t + 2500), true);

    // `has` prunes nothing; the next remember does
    assert.equal(sentIds.size(), 2000);
    sentIds.remember("late", t + 20 * MIN);
    assert.equal(sentIds.size(), 1, "everything older than 15 minutes is gone");
  });

  test("remembering the same id again refreshes it", () => {
    sentIds.remember("X", 0);
    sentIds.remember("X", 10 * MIN);
    assert.equal(sentIds.has("X", 20 * MIN), true);
    assert.equal(sentIds.size(), 1);
  });

  test("without an explicit time it follows the real clock", () => {
    sentIds.remember("real");
    assert.equal(sentIds.has("real"), true);
  });
});
