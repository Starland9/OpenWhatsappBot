"use strict";
/**
 * T035: one shared pipeline for both start modes (FR-022, contracts/pipeline.md).
 *
 *  - index.js and panel.js contain no processMessage definition and both call attachHandlers;
 *  - with a fake client, the same sequence (command, native-flow button reply, numeric fallback reply,
 *    status message, history `append` batch ignored) produces identical sends through attachHandlers,
 *    whether it is attached the way index.js does (no options) or the way panel.js does (counters);
 *  - panel's createServer() answers /health.
 *
 * Only test plugins are registered here (registry reset), so the result does not depend on the real plugins.
 */

const { test, before, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const fakes = require("./helpers/fakes");
const { scan } = require("./helpers/jsScan");

const { IDS, ROOT } = fakes;
fakes.setupEnv({ sudo: "111" });

const registry = require("../lib/plugins/registry");
const pipeline = require("../lib/core/pipeline");
const buttonRegistry = require("../lib/utils/buttonRegistry");
const settingsCache = require("../lib/utils/settingsCache");
const { getLang } = require("../lib/utils/language");
const maintenanceMode = require("../lib/utils/maintenanceMode");
const stats = require("../lib/utils/stats");
const config = require("../config");

let db;
before(async () => {
  db = await fakes.syncDb();
});

// maintenance mode is process-wide state: every test starts from a clean one
afterEach(() => maintenanceMode._reset());

/** Register exactly these plugins ({ "file.js": module }) in a clean registry. */
function useRegistry(plugins) {
  registry._reset();
  for (const [file, plugin] of Object.entries(plugins)) registry.registerPlugin(plugin, file);
}

/** A command + button handler + onMessage hook that log what ran into `events`. */
function makeProbe(events) {
  return {
    command: { pattern: "zzcmd|zzother", desc: "probe", type: "test" },
    async execute(message, args, ctx) {
      events.push(["execute", ctx.command, args]);
      await message.reply(`ran:${ctx.command}:${args}`);
    },
    async handleButtonReply(message) {
      if (!message.body.startsWith("zzp:")) return false;
      events.push(["button", message.body, message.isButtonReply ? "button" : "", message.isListReply ? "list" : ""]);
      await message.reply(`button:${message.body}:${message.isListReply ? "list" : "button"}`);
      return true;
    },
    async onMessage(message) {
      events.push(["onMessage", message.body]);
      return false;
    },
  };
}

const sendsOf = (sock) => sock.replies().map((s) => ({ jid: s.jid, text: s.text }));

// ---------------------------------------------------------------------------
// Static checks
// ---------------------------------------------------------------------------

// index.js and panel.js are thin wrappers around lib/core/boot.js (feature 002): the entry files define no
// pipeline of their own and delegate to bootstrap(); the start-up order lives in boot.js.
for (const file of ["index.js", "panel.js"]) {
  test(`${file}: no processMessage definition, delegates start-up to lib/core/boot.js`, () => {
    const code = scan(fs.readFileSync(path.join(ROOT, file), "utf8")).masked; // comments blanked
    assert.doesNotMatch(code, /\bfunction\s+processMessage\b/, `${file} defines processMessage()`);
    assert.doesNotMatch(code, /\b(?:const|let|var)\s+processMessage\b/, `${file} defines processMessage`);
    assert.doesNotMatch(code, /\bprocessMessage\s*(?::|=(?!=))/, `${file} assigns processMessage`);
    assert.doesNotMatch(code, /\.on\(\s*["'](?:messages|messages\.update|group-participants\.update)["']/, `${file} subscribes to client events itself instead of attachHandlers()`);
    assert.match(code, /require\(\s*["']\.\/lib\/core\/boot["']\s*\)/, `${file} does not require ./lib/core/boot`);
    assert.match(code, /\bbootstrap\s*\(/, `${file} never calls bootstrap()`);
  });
}

test("boot.js: uses the shared pipeline, attachHandlers() before client.initialize()", () => {
  const code = scan(fs.readFileSync(path.join(ROOT, "lib", "core", "boot.js"), "utf8")).masked;
  assert.doesNotMatch(code, /\bfunction\s+processMessage\b/);
  assert.doesNotMatch(code, /\.on\(\s*["'](?:messages|messages\.update|group-participants\.update)["']/, "boot.js subscribes to client events itself instead of attachHandlers()");
  assert.match(code, /require\(\s*["']\.\/pipeline["']\s*\)/, "boot.js does not require ./pipeline");
  const attach = code.search(/\battachHandlers\s*\(/);
  assert.notEqual(attach, -1, "boot.js never calls attachHandlers()");
  const init = code.search(/\.initialize\s*\(/);
  assert.ok(init === -1 || attach < init, "attachHandlers() must be called before client.initialize() so that no early event is missed");
});

// ---------------------------------------------------------------------------
// Same sequence through attachHandlers, index-style and panel-style
// ---------------------------------------------------------------------------

async function runSequence({ panelStyle }) {
  const events = [];
  useRegistry({ "zz-probe.js": makeProbe(events) });
  const sock = fakes.fakeSocket();
  const client = fakes.fakeClient(sock);
  const panel = { processed: 0, errors: [] };
  if (panelStyle) {
    pipeline.attachHandlers(client, {
      onMessageProcessed: () => panel.processed++,
      onError: (error) => panel.errors.push(error),
    });
  } else {
    pipeline.attachHandlers(client); // index.js
  }

  buttonRegistry.record({ key: { id: "BOTMENU1" } }, ["zzp:a", "zzp:b"]);
  const notify = (...raw) => client.dispatch("messages", raw, "notify");

  // 1. a command
  await notify(fakes.rawMessage({ body: ".zzcmd hello" }));
  // 2. native-flow button reply (quick_reply)
  await notify(fakes.rawMessage({ interactive: { id: "zzp:yes", kind: "button" } }));
  // 3. native-flow list reply (single_select)
  await notify(fakes.rawMessage({ interactive: { id: "zzp:row", kind: "list" } }));
  // 4. numeric fallback: "2" quoting the recorded menu message -> id zzp:b
  await notify(fakes.rawMessage({ body: " 2 ", quoted: { id: "BOTMENU1", fromMe: true, sender: IDS.BOT_PN, text: "menu" } }));
  // 5. a status broadcast: statusSaver only, never the hooks or the commands
  await notify({
    key: { remoteJid: "status@broadcast", fromMe: false, id: "ST1", participant: IDS.MEMBER_PN },
    message: { conversation: ".zzcmd from a status" },
    pushName: "x",
  });
  // 6. history sync / reconnect batch: ignored
  await client.dispatch("messages", [fakes.rawMessage({ body: ".zzcmd late" })], "append");
  await client.dispatch("messages", [fakes.rawMessage({ body: ".zzcmd later" })], "prepend");

  return {
    sends: sendsOf(sock),
    events: events.map((e) => JSON.stringify(e)),
    processed: panel.processed,
    errors: panel.errors,
    sock,
  };
}

const EXPECTED_SENDS = [
  { jid: IDS.OWNER_PN, text: "ran:zzcmd:hello" },
  { jid: IDS.OWNER_PN, text: "button:zzp:yes:button" },
  { jid: IDS.OWNER_PN, text: "button:zzp:row:list" },
  { jid: IDS.OWNER_PN, text: "button:zzp:b:button" },
];
const EXPECTED_EVENTS = [
  ["onMessage", ".zzcmd hello"],
  ["execute", "zzcmd", "hello"],
  ["button", "zzp:yes", "button", ""],
  ["button", "zzp:row", "", "list"],
  ["button", "zzp:b", "button", ""],
].map((e) => JSON.stringify(e));

test("command, native-flow button, list reply, numeric fallback, status and append batch: expected sends", async () => {
  const run = await runSequence({ panelStyle: false });
  assert.deepEqual(run.sends, EXPECTED_SENDS);
  assert.deepEqual(run.events, EXPECTED_EVENTS, "hooks ran in the wrong order, or a status / append message reached them");
});

test("index.js-style attach and panel.js-style attach produce identical sends", async () => {
  const index = await runSequence({ panelStyle: false });
  const panel = await runSequence({ panelStyle: true });
  assert.deepEqual(panel.sends, index.sends);
  assert.deepEqual(panel.events, index.events);
  assert.deepEqual(panel.errors, []);
  // counters of the panel: one per processed message (5 "notify" messages, the append / prepend batches excluded)
  assert.equal(panel.processed, 5);
});

// ---------------------------------------------------------------------------
// panel.js
// ---------------------------------------------------------------------------

/**
 * Requiring panel.js (through lib/utils/memoryManager.js) starts a setInterval that is never unref'd, so
 * the process would stay alive after the last test; only --test-force-exit ends such a run.
 * Root cause: memoryManager.startPeriodicCleanup() should do `setInterval(...).unref()`.
 * Until then, unref every interval created while panel.js is being required.
 */
function requirePanel() {
  const realSetInterval = global.setInterval;
  global.setInterval = (...args) => {
    const timer = realSetInterval(...args);
    if (timer && typeof timer.unref === "function") timer.unref();
    return timer;
  };
  try {
    return require("../panel.js");
  } finally {
    global.setInterval = realSetInterval;
  }
}

test("panel createServer() answers /health (503 until the bot runs, 200 once connected)", async () => {
  const panel = requirePanel();
  assert.equal(typeof panel.createServer, "function", "panel.js must export createServer without starting itself");
  const server = panel.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = { status: panel.botState.status, isConnected: panel.botState.isConnected };
  try {
    let res = await fetch(`${base}/health`);
    assert.equal(res.status, 503, "bot not started: unhealthy");
    assert.equal((await res.json()).status, "unhealthy");

    panel.botState.status = "running";
    panel.botState.isConnected = true;
    for (const route of ["/health", "/healthz", "/"]) {
      res = await fetch(`${base}${route}`);
      assert.equal(res.status, 200, `${route} while running`);
      assert.equal((await res.json()).status, "healthy");
    }
    res = await fetch(`${base}/ping`);
    assert.equal(res.status, 200);
  } finally {
    Object.assign(panel.botState, saved);
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// Pipeline order and isolation (contracts/pipeline.md)
// ---------------------------------------------------------------------------

test("order: handleButtonReply (quoted/interactive only) -> onMessage -> command; a quoted prefixed command skips handleButtonReply", async () => {
  const events = [];
  const quotedProbe = makeProbe(events);
  quotedProbe.handleButtonReply = async (message) => {
    events.push(["handleButtonReply", message.body]);
    return false;
  };
  useRegistry({ "zz-probe.js": quotedProbe });
  const sock = fakes.fakeSocket();
  const client = fakes.fakeClient(sock);
  pipeline.attachHandlers(client);
  const notify = (raw) => client.dispatch("messages", [raw], "notify");

  await notify(fakes.rawMessage({ body: ".zzcmd plain" }));
  assert.deepEqual(events, [["onMessage", ".zzcmd plain"], ["execute", "zzcmd", "plain"]]);

  events.length = 0;
  await notify(fakes.rawMessage({ body: "just an answer", quoted: "something" }));
  assert.deepEqual(events, [["handleButtonReply", "just an answer"], ["onMessage", "just an answer"]]);

  events.length = 0;
  await notify(fakes.rawMessage({ body: ".zzcmd quoted", quoted: "something" }));
  assert.deepEqual(events, [["onMessage", ".zzcmd quoted"], ["execute", "zzcmd", "quoted"]], "a prefixed command quoting a message must skip handleButtonReply");
});

test("a truthy onMessage stops the command; the bot's own messages reach onMessage", async () => {
  const events = [];
  const probe = makeProbe(events);
  probe.onMessage = async (message) => {
    events.push(["onMessage", message.body, message.fromMe]);
    return message.body.includes("swallow") ? "handled" : false; // truthy, not necessarily `true`
  };
  useRegistry({ "zz-probe.js": probe });
  const sock = fakes.fakeSocket();
  const client = fakes.fakeClient(sock);
  pipeline.attachHandlers(client);

  await client.dispatch("messages", [fakes.rawMessage({ body: ".zzcmd swallow" })], "notify");
  assert.deepEqual(events, [["onMessage", ".zzcmd swallow", false]]);
  assert.deepEqual(sendsOf(sock), []);

  events.length = 0;
  await client.dispatch("messages", [fakes.rawMessage({ body: "bot talking", fromMe: true, from: IDS.BOT_PN })], "notify");
  assert.deepEqual(events, [["onMessage", "bot talking", true]]);
});

test("a failing hook or command never blocks the rest, and never leaks its message to the chat", async () => {
  const events = [];
  const probe = makeProbe(events);
  const exploding = {
    async onMessage() {
      events.push("exploding onMessage");
      throw new Error("hook boom secret");
    },
    async handleButtonReply() {
      events.push("exploding handleButtonReply");
      throw new Error("button boom secret");
    },
  };
  const crashing = {
    command: { pattern: "zzcrash", desc: "crash", type: "test" },
    async execute() {
      throw new Error("command boom secret");
    },
  };
  useRegistry({ "aa-exploding.js": exploding, "zz-probe.js": probe, "zz-crash.js": crashing });
  const sock = fakes.fakeSocket();
  const client = fakes.fakeClient(sock);
  pipeline.attachHandlers(client);

  await client.dispatch("messages", [fakes.rawMessage({ body: ".zzcmd after-hook-error", from: IDS.MEMBER_PN })], "notify");
  assert.ok(events.includes("exploding onMessage"));
  assert.deepEqual(sendsOf(sock), [{ jid: IDS.MEMBER_PN, text: "ran:zzcmd:after-hook-error" }], "the command must run after a hook threw");

  sock.reset();
  await client.dispatch("messages", [fakes.rawMessage({ interactive: { id: "zzp:z", kind: "button" }, from: IDS.MEMBER_PN })], "notify");
  assert.deepEqual(sendsOf(sock), [{ jid: IDS.MEMBER_PN, text: "button:zzp:z:button" }], "a throwing handleButtonReply must not hide the next one");

  sock.reset();
  await client.dispatch("messages", [fakes.rawMessage({ body: ".zzcrash", from: IDS.MEMBER_PN })], "notify");
  const toUser = sock.replies((s) => s.jid === IDS.MEMBER_PN).map((s) => s.text);
  assert.deepEqual(toUser, [getLang("common.error")], "the user gets the generic error only");
  const toOwner = sock.replies((s) => s.jid === IDS.OWNER_PN).map((s) => s.text);
  assert.equal(toOwner.length, 1, "the owner gets the stack by DM");
  assert.match(toOwner[0], /command boom secret/);
  assert.doesNotMatch(toUser.join("\n"), /secret|\.js:\d+/);
});

test("attachHandlers is idempotent per client, and processMessage never throws", async () => {
  const events = [];
  useRegistry({ "zz-probe.js": makeProbe(events) });
  const sock = fakes.fakeSocket();
  const client = fakes.fakeClient(sock);
  pipeline.attachHandlers(client);
  pipeline.attachHandlers(client);
  pipeline.attachHandlers(client, { onMessageProcessed() {} });
  await client.dispatch("messages", [fakes.rawMessage({ body: ".zzcmd once" })], "notify");
  assert.equal(sendsOf(sock).length, 1, "the message was processed more than once");

  // malformed input: nothing may throw (a client without socket included), onError is optional
  await pipeline.processMessage(null, client);
  await pipeline.processMessage({}, client);
  const errors = [];
  await pipeline.processMessage({ key: { remoteJid: "x@s.whatsapp.net", id: "E1" }, message: { conversation: ".zzcmd" } }, null, {
    onError: (e) => errors.push(e),
  });
  assert.ok(errors.length <= 1);
});

test("a sticker bound to a command (StickerCommand) runs it, even inside a wrapper", async () => {
  const events = [];
  useRegistry({ "zz-probe.js": makeProbe(events) });
  const sha = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  await db.StickerCommand.create({ stickerHash: sha.toString("hex"), command: "zzother", createdBy: IDS.OWNER_PN });
  settingsCache.invalidate(pipeline.STICKER_CMDS_KEY);

  const sock = fakes.fakeSocket();
  const client = fakes.fakeClient(sock);
  pipeline.attachHandlers(client);
  await client.dispatch("messages", [fakes.rawMessage({ sticker: { sha256: sha }, from: IDS.MEMBER_PN })], "notify");
  assert.deepEqual(sendsOf(sock), [{ jid: IDS.MEMBER_PN, text: "ran:zzother:" }]);

  sock.reset();
  const wrapped = fakes.rawMessage({ from: IDS.MEMBER_PN, message: { ephemeralMessage: { message: { stickerMessage: { fileSha256: sha } } } } });
  await client.dispatch("messages", [wrapped], "notify");
  assert.deepEqual(sendsOf(sock), [{ jid: IDS.MEMBER_PN, text: "ran:zzother:" }]);
});

test("group-participants.update and ready are fanned out to every plugin, each isolated", async () => {
  const seen = [];
  const first = {
    onGroupParticipants(update, client) {
      seen.push(["first", update.action, update.id, typeof client.getSocket]);
      throw new Error("first plugin fails");
    },
    onReady() {
      seen.push(["first", "ready"]);
      throw new Error("first plugin fails on ready");
    },
  };
  const second = {
    async onGroupParticipants(update) {
      seen.push(["second", update.action, update.participants.map((p) => p.id || p)]);
    },
    async onReady(client) {
      seen.push(["second", "ready", client.isReady]);
    },
  };
  useRegistry({ "aa-first.js": first, "bb-second.js": second });
  const sock = fakes.fakeSocket();
  const client = fakes.fakeClient(sock);
  pipeline.attachHandlers(client);

  await client.dispatch("group-participants.update", {
    id: IDS.GROUP,
    author: IDS.OWNER_PN,
    action: "add",
    participants: ["a@s.whatsapp.net", { id: "b@lid", phoneNumber: "b@s.whatsapp.net" }],
  });
  await client.dispatch("ready");
  assert.deepEqual(seen, [
    ["first", "add", IDS.GROUP, "function"],
    ["second", "add", ["a@s.whatsapp.net", "b@lid"]],
    ["first", "ready"],
    ["second", "ready", true],
  ]);
});

// ---------------------------------------------------------------------------
// Statistics counters, maintenance gate and live prefix (feature 002, runtime.md section 5 "Touch points")
// ---------------------------------------------------------------------------

/** pipeline.attachHandlers on a fresh fake client; `count` records every stats.count() call */
function attachWithCounter(t) {
  const sock = fakes.fakeSocket();
  const client = fakes.fakeClient(sock);
  pipeline.attachHandlers(client);
  const count = mock.method(stats, "count");
  t.after(() => count.mock.restore());
  const counted = () => count.mock.calls.map((c) => c.arguments.slice(0, 2));
  return { sock, client, counted };
}

test("counters: a private message counts `messages`, a group message also counts `group_msgs` for that group", async (t) => {
  useRegistry({ "zz-probe.js": makeProbe([]) });
  const { client, counted } = attachWithCounter(t);

  await client.dispatch("messages", [fakes.rawMessage({ body: "hello", from: IDS.MEMBER_PN })], "notify");
  assert.deepEqual(counted(), [["messages"]]);

  await client.dispatch("messages", [fakes.rawMessage({ body: "hi all", from: IDS.MEMBER_PN, group: true })], "notify");
  assert.deepEqual(counted(), [["messages"], ["messages"], ["group_msgs", IDS.GROUP]]);
});

test("counters: the bot's own messages and status broadcasts count nothing", async (t) => {
  useRegistry({ "zz-probe.js": makeProbe([]) });
  const { client, counted } = attachWithCounter(t);

  await client.dispatch("messages", [fakes.rawMessage({ body: "echo", fromMe: true }), fakes.rawMessage({ body: "echo", fromMe: true, group: true })], "notify");
  await client.dispatch("messages", [{
    key: { remoteJid: "status@broadcast", fromMe: false, id: "ST9", participant: IDS.MEMBER_PN },
    message: { conversation: "a status" },
    pushName: "x",
  }], "notify");
  assert.deepEqual(counted(), []);
});

test("counters land after the disabled-chat gate: a banned chat counts nothing", async (t) => {
  useRegistry({ "zz-probe.js": makeProbe([]) });
  const { client, counted } = attachWithCounter(t);
  await db.BannedChat.create({ jid: IDS.GROUP });
  await db.BannedChat.create({ jid: IDS.MEMBER_PN });
  settingsCache.invalidate(pipeline.BANNED_CHATS_KEY);
  t.after(async () => {
    await db.BannedChat.destroy({ where: {} });
    settingsCache.invalidate(pipeline.BANNED_CHATS_KEY);
  });

  await client.dispatch("messages", [
    fakes.rawMessage({ body: "ignored", from: IDS.MEMBER_PN, group: true }),
    fakes.rawMessage({ body: "ignored too", from: IDS.MEMBER_PN }),
  ], "notify");
  assert.deepEqual(counted(), [], "a fully ignored chat is not `processed`");

  // another chat still counts
  await client.dispatch("messages", [fakes.rawMessage({ body: "hello", from: IDS.MEMBER2_PN })], "notify");
  assert.deepEqual(counted(), [["messages"]]);
});

test("counters: the count happens before the hooks and the command", async (t) => {
  const order = [];
  useRegistry({
    "zz-probe.js": {
      command: { pattern: "zzcmd", desc: "probe", type: "test" },
      async execute() {
        order.push("execute");
      },
      async onMessage() {
        order.push("onMessage");
        return false;
      },
    },
  });
  const client = fakes.fakeClient(fakes.fakeSocket());
  pipeline.attachHandlers(client);
  const original = stats.count;
  const spy = mock.method(stats, "count", (...args) => {
    order.push(`count:${args[0]}`);
    return original(...args);
  });
  t.after(() => spy.mock.restore());

  await client.dispatch("messages", [fakes.rawMessage({ body: ".zzcmd" })], "notify");
  assert.deepEqual(order, ["count:messages", "onMessage", "execute"]);
});

test("maintenance gate: messages are dropped while active (nothing runs, nothing counts) and flow again after", async (t) => {
  const events = [];
  useRegistry({ "zz-probe.js": makeProbe(events) });
  const { sock, client, counted } = attachWithCounter(t);

  await maintenanceMode.enter("restore");
  assert.equal(maintenanceMode.isActive(), true);
  await client.dispatch("messages", [fakes.rawMessage({ body: ".zzcmd during" })], "notify");
  assert.deepEqual(events, [], "no hook and no command ran");
  assert.deepEqual(sendsOf(sock), []);
  assert.deepEqual(counted(), []);

  maintenanceMode.leave();
  await client.dispatch("messages", [fakes.rawMessage({ body: ".zzcmd after" })], "notify");
  assert.deepEqual(sendsOf(sock), [{ jid: IDS.OWNER_PN, text: "ran:zzcmd:after" }]);
  assert.deepEqual(counted(), [["messages"]]);
});

test("maintenance gate: processMessage brackets each message with begin()/done(), even when it fails", async () => {
  useRegistry({
    "zz-probe.js": {
      command: { pattern: "zzcmd|zzboom", desc: "probe", type: "test" },
      async execute(message, args, ctx) {
        if (ctx.command === "zzboom") throw new Error("command failed");
      },
    },
  });
  const client = fakes.fakeClient(fakes.fakeSocket());
  const dones = [];
  const begin = mock.method(maintenanceMode, "begin", () => () => dones.push("done"));
  try {
    await pipeline.processMessage(fakes.rawMessage({ body: ".zzcmd" }), client);
    await pipeline.processMessage(fakes.rawMessage({ body: ".zzboom" }), client);
    await pipeline.processMessage(null, client); // malformed: still bracketed
    assert.equal(begin.mock.calls.length, 3, "one begin() per message");
    assert.deepEqual(dones, ["done", "done", "done"], "done() ran each time, the failure included");
  } finally {
    begin.mock.restore();
  }
});

test("maintenance gate: an in-flight message is counted as pending and enter() waits for it", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const pendingSeen = [];
  useRegistry({
    "zz-probe.js": {
      command: { pattern: "zzcmd", desc: "probe", type: "test" },
      async execute() {
        pendingSeen.push(maintenanceMode.pending());
        await gate;
      },
    },
  });
  const sock = fakes.fakeSocket();
  const client = fakes.fakeClient(sock);
  pipeline.attachHandlers(client);

  assert.equal(maintenanceMode.pending(), 0);
  const processing = client.dispatch("messages", [fakes.rawMessage({ body: ".zzcmd" })], "notify");
  await fakes.waitFor(() => pendingSeen.length === 1);
  assert.deepEqual(pendingSeen, [1]);

  let entered = false;
  const entering = maintenanceMode.enter("restore", { timeoutMs: 5000 }).then(() => {
    entered = true;
  });
  await fakes.sleep(30);
  assert.equal(entered, false, "enter() waits for the message in flight");

  release();
  await processing;
  await entering;
  assert.equal(entered, true);
  assert.equal(maintenanceMode.pending(), 0);
});

test("SC-003 (prefix): after config.PREFIX = \"!\" the next !zzcmd dispatches and .zzcmd does not, with no restart", async () => {
  const events = [];
  useRegistry({ "zz-probe.js": makeProbe(events) });
  const sock = fakes.fakeSocket();
  const client = fakes.fakeClient(sock);
  pipeline.attachHandlers(client);
  const send = (body) => client.dispatch("messages", [fakes.rawMessage({ body })], "notify");
  const ran = () => events.filter((e) => e[0] === "execute").length;

  try {
    await send(".zzcmd before");
    assert.equal(ran(), 1);

    config.PREFIX = "!"; // what the panel's settings save does: no restart
    await send("!zzcmd after");
    assert.equal(ran(), 2, "the new prefix dispatches at once");
    await send(".zzcmd old");
    assert.equal(ran(), 2, "the old prefix no longer does");
    assert.deepEqual(sendsOf(sock).map((s) => s.text), ["ran:zzcmd:before", "ran:zzcmd:after"]);
  } finally {
    config.PREFIX = ".";
  }
  await send(".zzcmd back");
  assert.equal(ran(), 3);
});
