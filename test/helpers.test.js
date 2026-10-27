"use strict";
/**
 * Sanity checks of the test helpers themselves (test/helpers/fakes.js), so that a broken fake does not
 * show up as a failure of the bot.
 */

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

const { IDS } = fakes;
fakes.setupEnv({ sudo: "111" });

before(async () => {
  await fakes.syncDb();
});

test("makeMessage: PN, LID (participantAlt / remoteJidAlt), admin flag, quoted, mentions", async () => {
  const pn = fakes.makeMessage({ body: ".x", from: IDS.MEMBER_PN, group: true });
  assert.equal(pn.sender, IDS.MEMBER_PN);
  assert.equal(pn.senderLid, null);
  assert.equal(pn.isGroup, true);
  assert.equal(pn.isSudo(), false);

  const lid = fakes.makeMessage({ body: ".x", from: IDS.OWNER_PN, lid: true, group: true });
  assert.equal(lid.key.participant, IDS.OWNER_LID);
  assert.equal(lid.key.participantAlt, IDS.OWNER_PN);
  assert.equal(lid.sender, IDS.OWNER_PN);
  assert.equal(lid.senderLid, IDS.OWNER_LID);
  assert.equal(lid.isSudo(), true);

  const dm = fakes.makeMessage({ body: ".x", from: IDS.OWNER_PN, lid: true });
  assert.equal(dm.jid, IDS.OWNER_LID);
  assert.equal(dm.key.remoteJidAlt, IDS.OWNER_PN);
  assert.equal(dm.isSudo(), true);

  const admin = fakes.makeMessage({ body: ".x", from: IDS.MEMBER_PN, lid: true, group: true, admin: true });
  assert.equal(await admin.isSenderAdmin(), true);
  assert.equal(await admin.isBotAdmin(), true);
  const plain = fakes.makeMessage({ body: ".x", from: IDS.MEMBER_PN, lid: true, group: true, admin: false });
  assert.equal(await plain.isSenderAdmin(), false);

  const quoted = fakes.makeMessage({ body: ".x", quoted: { text: "hello", id: "Q1" }, mentions: [IDS.MEMBER_PN] });
  assert.equal(quoted.quoted.id, "Q1");
  assert.equal(quoted.getQuotedText(), "hello");
  assert.deepEqual(quoted.mentions, [IDS.MEMBER_PN]);

  const media = fakes.makeMessage({ body: ".x", quoted: { media: "image" } });
  await assert.rejects(media.getQuotedMedia({ maxBytes: 10 }), { code: "MEDIA_TOO_LARGE" });
});

test("makeMessage: native-flow button and list replies", () => {
  const button = fakes.makeMessage({ interactive: { id: "menu:cmd:ping", kind: "button" } });
  assert.equal(button.body, "menu:cmd:ping");
  assert.equal(button.isButtonReply, true);
  assert.equal(button.isListReply, false);
  assert.equal(button.isInteractiveReply, true);
  assert.equal(button.quoted.key.fromMe, true, "the reply quotes a message of the bot");

  const list = fakes.makeMessage({ interactive: { id: "trivia:cat:1", kind: "list" } });
  assert.equal(list.body, "trivia:cat:1");
  assert.equal(list.isListReply, true);
});

test("fakeSocket: records sends (reactions apart), relayMessage, participant updates, metadata", async () => {
  const sock = fakes.fakeSocket({ admins: ["333"], botAdmin: false });
  await sock.sendMessage("a@s.whatsapp.net", { text: "hello" });
  await sock.sendMessage("a@s.whatsapp.net", { image: Buffer.from("x"), caption: "cap" });
  await sock.sendMessage("a@s.whatsapp.net", { react: { text: "👍", key: {} } });
  await sock.relayMessage("a@s.whatsapp.net", { interactiveMessage: { body: { text: "pick" }, nativeFlowMessage: { buttons: [] } } }, {});
  assert.deepEqual(sock.sent.map((s) => s.kind), ["text", "image", "react", "interactive"]);
  assert.deepEqual(fakes.sentTexts(sock), ["hello", "cap", "pick"]);
  assert.deepEqual(await sock.groupParticipantsUpdate(IDS.GROUP, ["b@s.whatsapp.net"], "remove"), [{ status: "200", jid: "b@s.whatsapp.net", content: null }]);
  assert.deepEqual(sock.participantUpdates, [{ jid: IDS.GROUP, jids: ["b@s.whatsapp.net"], action: "remove" }]);

  const meta = await sock.groupMetadata(IDS.GROUP);
  const role = (id) => meta.participants.find((p) => [p.id, p.phoneNumber].includes(id))?.admin ?? null;
  assert.equal(role(IDS.MEMBER_PN), "admin");
  assert.equal(role(IDS.OWNER_PN), null);
  assert.equal(role(IDS.BOT_PN), null, "botAdmin: false");
  assert.equal(role(IDS.CREATOR_PN), "superadmin");

  assert.equal(typeof sock.sendPresenceUpdate, "function", "unknown Baileys methods are recorded no-ops");
  await sock.sendPresenceUpdate("composing", IDS.GROUP);
  assert.equal(sock.calls[0].method, "sendPresenceUpdate");
});

test("waitFor / waitForSends", async () => {
  const sock = fakes.fakeSocket();
  setTimeout(() => sock.sendMessage("a@s.whatsapp.net", { text: "later" }), 20);
  const sends = await fakes.waitForSends(sock, { timeout: 1000 });
  assert.equal(sends[0].text, "later");
  await assert.rejects(fakes.waitForSends(sock, { count: 2, timeout: 50 }), /expected 2 sendMessage within 50 ms, got 1/);
  assert.equal(await fakes.waitFor(() => false, { timeout: 30 }), null);
});

test("stubNetwork blocks axios, http(s), fetch and child_process, and restores them", async () => {
  const axios = require(require.resolve("axios", { paths: [fakes.ROOT] }));
  const cp = require("child_process");
  const https = require("https");
  const realFetch = global.fetch;
  const realSpawn = cp.spawn;
  const realAdapter = axios.defaults.adapter;

  const net = fakes.stubNetwork();
  assert.equal(fakes.stubNetwork(), net, "idempotent");
  await assert.rejects(axios.get("https://example.com/"), { code: "ECONNREFUSED" });
  await assert.rejects(fetch("https://example.com/"), (e) => e.message === "fetch failed" && e.cause.code === "ECONNREFUSED");
  await new Promise((resolve, reject) => {
    https.get("https://example.com/").on("error", (e) => (e.code === "ECONNREFUSED" ? resolve() : reject(e)));
  });
  await assert.rejects(require("util").promisify(cp.execFile)("ffmpeg", ["-version"]), { code: "ENOENT" });
  await new Promise((resolve, reject) => {
    cp.spawn("yt-dlp", ["--version"]).on("error", (e) => (e.code === "ENOENT" ? resolve() : reject(e)));
  });
  assert.throws(() => cp.execFileSync("ffmpeg"), { code: "ENOENT" });
  assert.deepEqual([...new Set(net.calls.map((c) => c.kind))].sort(), ["axios", "exec", "fetch", "http"]);

  net.restore();
  assert.equal(global.fetch, realFetch);
  assert.equal(cp.spawn, realSpawn);
  assert.deepEqual(axios.defaults.adapter, realAdapter);
});

test("setupEnv: environment is set before config.js, secrets are blank", () => {
  const config = require("../config");
  assert.equal(config.SUDO, "111");
  assert.equal(config.PREFIX, ".");
  assert.equal(config.LANG, (process.env.BOT_LANG || "fr").toLowerCase());
  assert.equal(config.OPENAI_API_KEY, "");
  assert.equal(config.GIPHY_API_KEY, "");
  assert.equal(process.env.DATABASE_URL, ":memory:");
});
