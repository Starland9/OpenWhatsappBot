"use strict";
/**
 * `.vv` on a view-once already opened on the requester's phone.
 *
 * The bot is a linked device: WhatsApp never gives it the view-once itself (Baileys gets
 * `<unavailable type="view_once">`), so `.vv` only has the copy the requester's phone puts in the quote.
 * Once the view-once has been opened, that copy keeps the metadata (mimetype, size) but loses its link:
 * neither `url` nor `directPath`. Baileys then throws "No valid media URL or directPath present in
 * message" and `mediaAdapter` printed the whole stack with `console.error`.
 *
 *  - `getQuotedMedia` returns null without calling Baileys when the quoted media has no link (the exact
 *    condition of Baileys' `downloadContentFromMessage`), so nothing is printed;
 *  - a quoted media that has a link still goes to the download (control);
 *  - `.vv` stays silent (owner's choice): no send and no reply, for the owner in a group or a private
 *    chat and for a delegated requester.
 */

const { test, before, beforeEach, afterEach, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

const { IDS } = fakes;
fakes.setupEnv({ sudo: "111" });
const net = fakes.stubNetwork();

const settingsCache = require("../lib/utils/settingsCache");
const commandPermissions = require("../lib/utils/commandPermissions");
const viewOnceHandler = require("../lib/utils/viewOnceHandler");

let registry;
let db;

before(async () => {
  ({ registry, db } = await fakes.setup());
});

after(() => net.restore());

beforeEach(async () => {
  await db.PermissionRule.destroy({ where: {} });
  await db.ViewOnce.destroy({ where: {} });
  settingsCache.clear();
  commandPermissions.invalidate();
  viewOnceHandler.forgetReceived();
});

afterEach(() => mock.restoreAll());

const MIMES = { image: "image/jpeg", video: "video/mp4", audio: "audio/ogg; codecs=opus" };

/** A quoted view-once as the phone sends it once opened: metadata, no `url`, no `directPath`. */
function openedViewOnce(kind = "image", over = {}) {
  const inner = { mimetype: MIMES[kind], fileLength: 2048, viewOnce: true, ...over };
  return { message: { viewOnceMessageV2: { message: { [`${kind}Message`]: inner } } } };
}

/** Run `.vv` through the registry with the real `getQuotedMedia`; record every send. */
async function runVv({ who, group, quoted }) {
  const message = fakes.makeMessage({ body: ".vv", ...who, group, quoted });
  const sock = message.client.getSocket();
  const attempts = [];
  const original = sock.sendMessage;
  sock.sendMessage = async (jid, content, options) => {
    attempts.push({ jid, content });
    return await original(jid, content, options);
  };
  await registry.executeCommand(message);
  return attempts;
}

test("getQuotedMedia: an opened view-once (no url, no directPath) gives null without calling Baileys", async () => {
  const errors = mock.method(console, "error", () => {});
  for (const kind of ["image", "video", "audio"]) {
    const message = fakes.makeMessage({ body: ".vv", quoted: openedViewOnce(kind) });
    assert.equal(await message.getQuotedMedia(), null, kind);
  }
  assert.equal(errors.mock.callCount(), 0, "no stack printed: Baileys was never called");
});

test("getQuotedMedia: a quoted media with a link still goes to the download (control)", async () => {
  const errors = mock.method(console, "error", () => {});
  // directPath but no mediaKey: Baileys is reached and fails on the key, before any network call
  const message = fakes.makeMessage({
    body: ".vv",
    quoted: openedViewOnce("image", { directPath: "/v/t62.7118-24/fake?ccb=11-4" }),
  });
  assert.equal(await message.getQuotedMedia(), null);
  assert.equal(errors.mock.callCount(), 1, "the download was attempted");
  assert.deepEqual(net.calls.length, 0, "no network call");
});

test(".vv by the owner on an opened view-once stays silent (group and private chat)", async () => {
  const errors = mock.method(console, "error", () => {});
  for (const group of [IDS.GROUP, undefined]) {
    const attempts = await runVv({ who: { from: IDS.OWNER_PN }, group, quoted: openedViewOnce("image") });
    assert.deepEqual(attempts, [], `nothing sent (${group ? "group" : "private"})`);
  }
  assert.equal(errors.mock.callCount(), 0);
});

test(".vv by a delegated requester on an opened view-once stays silent", async () => {
  await db.PermissionRule.create({
    command: "vv",
    scope: "*",
    mode: "extra",
    people: [{ pn: IDS.MEMBER_PN, lid: IDS.MEMBER_LID }],
  });
  commandPermissions.invalidate();
  const errors = mock.method(console, "error", () => {});
  const attempts = await runVv({ who: { from: IDS.MEMBER_PN }, group: IDS.GROUP, quoted: openedViewOnce("video") });
  assert.deepEqual(attempts, [], "nothing in the group, nothing in the DM");
  assert.equal(errors.mock.callCount(), 0);
});

// ---------------------------------------------------------------------------
// The copy the bot received (Android mode: WhatsApp sends it the view-once itself)
// ---------------------------------------------------------------------------

const LINK = { directPath: "/v/t62.7118-24/fake?ccb=11-4", mediaKey: Buffer.alloc(32, 7).toString("base64") };

/** The view-once as the bot receives it in Android mode: with its link and key */
function received({ id = "VO1", group = IDS.GROUP, kind = "image", from = IDS.MEMBER_PN, fromMe = false, over = {} } = {}) {
  const inner = { mimetype: MIMES[kind], fileLength: 2048, viewOnce: true, jpegThumbnail: "dGh1bWI=", ...LINK, ...over };
  return fakes.makeMessage({
    id,
    from,
    group: group || undefined,
    fromMe,
    message: { viewOnceMessageV2: { message: { [`${kind}Message`]: inner } } },
  });
}

/** `.vv` quoting the opened view-once `id`; getQuotedMedia is stubbed and records its options */
async function vvQuoting(id, { who = { from: IDS.OWNER_PN }, group = IDS.GROUP, kind = "image" } = {}) {
  const message = fakes.makeMessage({ body: ".vv", ...who, group: group || undefined, quoted: { id, ...openedViewOnce(kind) } });
  const calls = [];
  message.getQuotedMedia = async (opts) => {
    calls.push(opts);
    return opts && opts.source ? { buffer: Buffer.from("bytes"), type: kind, mimetype: MIMES[kind], fileLength: 5 } : null;
  };
  const sock = message.client.getSocket();
  await registry.executeCommand(message);
  const media = sock.sent.filter((s) => s.content && (s.content.image || s.content.video || s.content.audio));
  return { calls, media };
}

test("store: a received view-once is kept for its chat only, link and key but no thumbnail", async () => {
  await viewOnceHandler.handleMessage(received({ id: "VO1" }));
  const copy = viewOnceHandler.recall([IDS.GROUP], "VO1");
  assert.ok(copy && copy.imageMessage, "recalled from the same chat");
  assert.equal(copy.imageMessage.directPath, LINK.directPath);
  assert.equal(copy.imageMessage.mediaKey, LINK.mediaKey);
  assert.equal(copy.imageMessage.jpegThumbnail, undefined, "no thumbnail kept");
  assert.equal(viewOnceHandler.recall(["120363000000000002@g.us"], "VO1"), null, "never from another chat");
  assert.equal(viewOnceHandler.recall([IDS.GROUP], "OTHER"), null);
});

test("store: nothing kept without a link or a key, nor the bot's own messages; expiry and cap", async () => {
  await viewOnceHandler.handleMessage(received({ id: "NOLINK", over: { directPath: undefined } }));
  await viewOnceHandler.handleMessage(received({ id: "NOKEY", over: { mediaKey: undefined } }));
  await viewOnceHandler.handleMessage(received({ id: "MINE", fromMe: true }));
  for (const id of ["NOLINK", "NOKEY", "MINE"]) assert.equal(viewOnceHandler.recall([IDS.GROUP], id), null, id);

  const t0 = 1_000_000;
  viewOnceHandler.remember(received({ id: "OLD" }), t0);
  assert.ok(viewOnceHandler.recall([IDS.GROUP], "OLD", t0 + viewOnceHandler.RECEIVED_TTL_MS - 1));
  assert.equal(viewOnceHandler.recall([IDS.GROUP], "OLD", t0 + viewOnceHandler.RECEIVED_TTL_MS + 1), null, "expired");

  viewOnceHandler.forgetReceived();
  for (let i = 0; i <= viewOnceHandler.RECEIVED_MAX; i++) viewOnceHandler.remember(received({ id: `N${i}` }), t0);
  assert.equal(viewOnceHandler.recall([IDS.GROUP], "N0", t0), null, "the oldest is dropped beyond the cap");
  assert.ok(viewOnceHandler.recall([IDS.GROUP], `N${viewOnceHandler.RECEIVED_MAX}`, t0));
});

test("store: a private chat matches by its PN or its LID form", async () => {
  await viewOnceHandler.handleMessage(
    fakes.makeMessage({
      id: "DM1",
      from: IDS.MEMBER_PN,
      lid: true, // chat addressed by the LID, remoteJidAlt = the PN
      message: { viewOnceMessageV2: { message: { imageMessage: { mimetype: MIMES.image, viewOnce: true, ...LINK } } } },
    }),
  );
  assert.ok(viewOnceHandler.recall([IDS.MEMBER_PN], "DM1"), "by the PN");
  assert.ok(viewOnceHandler.recall([IDS.MEMBER_LID], "DM1"), "by the LID");
});

test(".vv on an opened view-once uses the copy the bot received in this chat (owner)", async () => {
  await viewOnceHandler.handleMessage(received({ id: "VO2", kind: "video" }));
  const { calls, media } = await vvQuoting("VO2", { kind: "video" });
  assert.equal(calls.length, 1);
  assert.ok(calls[0] && calls[0].source && calls[0].source.videoMessage, "downloaded from the received copy");
  assert.equal(media.length, 1);
  assert.equal(media[0].jid, IDS.GROUP, "the owner's default destination: the chat");
});

test(".vv on an opened view-once received in another chat stays silent", async () => {
  await viewOnceHandler.handleMessage(received({ id: "VO3", group: "120363000000000002@g.us" }));
  const { calls, media } = await vvQuoting("VO3");
  assert.ok(calls.every((opts) => !opts || !opts.source), "no copy from another chat");
  assert.deepEqual(media, []);
});

test(".vv by a delegated requester on an opened view-once: the received copy goes to the requester's DM", async () => {
  await db.PermissionRule.create({ command: "vv", scope: "*", mode: "extra", people: [{ pn: IDS.MEMBER2_PN, lid: null }] });
  commandPermissions.invalidate();
  await viewOnceHandler.handleMessage(received({ id: "VO4" }));
  const { calls, media } = await vvQuoting("VO4", { who: { from: IDS.MEMBER2_PN } });
  assert.ok(calls[0] && calls[0].source);
  assert.deepEqual(media.map((m) => m.jid), [IDS.MEMBER2_PN], "only the requester's DM, never the group");
});
