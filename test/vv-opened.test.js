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
