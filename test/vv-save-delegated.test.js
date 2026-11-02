"use strict";
/**
 * Feature 003 (specs/003-command-permissions, contracts/runtime.md sections 4, 5 and 8 file 3): `.vv` and
 * `.save` run for a person the panel delegated them to.
 *
 *  - owner `.vv` is unchanged in every `view_once` mode (`p`, `jid`, `g`, disabled, no row);
 *  - delegated `.vv` in a group sends exactly once, to the requester (PN preferred, LID otherwise), never
 *    to the group, the owner or the `.setvv` destination, and never reads the `view_once` setting (SC-002);
 *    in a private chat it goes to `message.jid`;
 *  - a delegated requester never causes a post in the group: not a view-once, an unsupported kind, a
 *    download failure, a failing send, the usage text and the too-large notice all stay silent in the
 *    group (usage and too-large go to the DM, best effort), with no `common.error` and no owner DM;
 *  - the owner's usage and too-large replies stay in the chat, a failing send still gives `common.error`;
 *  - owner `.save` is unchanged: media to his own chat, reactions and replies in the chat, a failing send
 *    still gives `common.error`;
 *  - `.save` delegated is as discreet as `.vv` (FR-016): the media goes to the requester and never to the
 *    owner, and nothing ever appears in the chat where it was typed: no reaction (hourglass, check, cross)
 *    and no text reply. Every text (`reply_required`, `no_message`, `no_sudo`, `download_failed`, `no_media`,
 *    the too-large notice) goes to the requester's DM, best effort; a failing send or DM is swallowed (no
 *    `common.error`, no owner DM); no fallback to the owner.
 *
 * The delegated cases go through `registry.executeCommand` with a real `PermissionRule` row, as in
 * production; `getQuotedMedia` is stubbed per message (no download, no network).
 */

const { test, before, beforeEach, afterEach, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const fakes = require("./helpers/fakes");

const { IDS } = fakes;
fakes.setupEnv({ sudo: "111" });
const net = fakes.stubNetwork();

const settingsCache = require("../lib/utils/settingsCache");
const commandPermissions = require("../lib/utils/commandPermissions");
const cooldown = require("../lib/utils/cooldown");
const { invalidateGroupMetadata } = require("../lib/classes/Message");
const { getLang } = require("../lib/utils/language");
const config = require("../config");

const GROUP = IDS.GROUP;
const PRIVATE = "private";
const OWNER_PN = IDS.OWNER_PN;
const VV_JID = "237690000099@s.whatsapp.net"; // the `.setvv jid` destination
const MEMBER_PN = IDS.MEMBER_PN; // 333, LID 888
const MEMBER_LID = IDS.MEMBER_LID;

// Requesters (all plain members; B is the one named in the rules)
const OWNER = { from: OWNER_PN };
const B_PN = { from: MEMBER_PN }; // sender 333@s.whatsapp.net, no LID
const B_BOTH = { from: MEMBER_PN, lid: true }; // sender PN, senderLid 888@lid; a private chat is addressed by the LID
const B_LID = { from: MEMBER_LID }; // LID-only: sender === senderLid === 888@lid

const PERSON_B = { pn: MEMBER_PN, lid: MEMBER_LID };
const PERSON_B_LID = { pn: null, lid: MEMBER_LID };

let registry;
let db;
let vvPlugin;
let savePlugin;

before(async () => {
  const setup = await fakes.setup();
  registry = setup.registry;
  db = setup.db;
  vvPlugin = registry.getCommandByPattern("vv").plugin;
  savePlugin = registry.getCommandByPattern("save").plugin;
});

after(() => net.restore());

beforeEach(async () => {
  await db.PermissionRule.destroy({ where: {} });
  await db.ViewOnce.destroy({ where: {} });
  settingsCache.clear();
  commandPermissions.invalidate();
  invalidateGroupMetadata();
  cooldown.reset("vv", "ownerdm");
  cooldown.reset("save", "ownerdm");
});

afterEach(() => mock.restoreAll());

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const MIMES = {
  image: "image/jpeg",
  video: "video/mp4",
  audio: "audio/ogg; codecs=opus",
  document: "application/pdf",
  sticker: "image/webp",
};

/** A quoted view-once message of the given media kind. */
function viewOnce(kind = "image", over = {}) {
  const inner = { mimetype: MIMES[kind], fileLength: 2048, viewOnce: true, ...over };
  return { message: { viewOnceMessageV2: { message: { [`${kind}Message`]: inner } } } };
}

const IMAGE = { buffer: Buffer.from("image-bytes"), type: "image", mimetype: "image/jpeg", fileLength: 11 };
const VIDEO = { buffer: Buffer.from("video-bytes"), type: "video", mimetype: "video/mp4", fileLength: 11 };
const AUDIO = { buffer: Buffer.from("audio-bytes"), type: "audio", mimetype: "audio/ogg; codecs=opus", fileLength: 11 };

/** The `view_once` row (the `.setvv` configuration). */
async function setViewOnce(vvMode, { enabled = true, vvJid = null } = {}) {
  await db.ViewOnce.create({ id: 1, enabled, vvMode, vvJid });
  settingsCache.clear();
}

/** Insert a valid rule (model validators run) and drop the engine cache, as the panel does. */
async function grant(command, people, { scope = "*", mode = "extra" } = {}) {
  await db.PermissionRule.create({ command, scope, mode, people });
  commandPermissions.invalidate();
}

const tooLarge = (maxMB) =>
  Object.assign(new Error("too large"), { code: "MEDIA_TOO_LARGE", ...(maxMB ? { maxMB } : {}) });

/**
 * Send `text` as `who` in `where` (PRIVATE or a group JID) through the registry. `getQuotedMedia` is stubbed
 * (`media`: a value, or a function that returns or throws). Every `sendMessage` call is recorded in
 * `attempts` (also the ones that fail) and `failWhen(jid, content)` makes a call reject. `prepare(message)`
 * adjusts the message before it runs.
 */
async function run(text, { who, where = GROUP, quoted, media = IMAGE, failWhen, direct, prepare } = {}) {
  const message = fakes.makeMessage({
    body: text,
    ...who,
    group: where === PRIVATE ? undefined : where,
    quoted,
  });
  const calls = { downloads: 0 };
  message.getQuotedMedia = async () => {
    calls.downloads += 1;
    return typeof media === "function" ? await media() : media;
  };

  const sock = message.client.getSocket();
  const attempts = [];
  const original = sock.sendMessage;
  sock.sendMessage = async (jid, content, options) => {
    attempts.push({ jid, content, options });
    if (failWhen && failWhen(jid, content)) throw new Error("boom: send failed");
    return await original(jid, content, options);
  };

  if (prepare) prepare(message);
  if (direct) {
    await direct(message);
  } else {
    await registry.executeCommand(message);
  }
  return {
    message,
    sock,
    attempts,
    calls,
    to: (jid) => attempts.filter((a) => a.jid === jid),
    texts: () => attempts.map((a) => a.content && a.content.text).filter(Boolean),
    // the media (not the reactions or the text replies)
    media: () => attempts.filter((a) => a.content && (a.content.image || a.content.video || a.content.audio)),
  };
}

const isRequesterOnly = (result, jid) =>
  result.attempts.length > 0 && result.attempts.every((a) => a.jid === jid);

// ---------------------------------------------------------------------------
// .vv, the owner: unchanged
// ---------------------------------------------------------------------------

const OWNER_MODES = [
  { name: "no view_once row", setup: async () => {}, group: GROUP, priv: OWNER_PN },
  { name: "mode p", setup: () => setViewOnce("p"), group: OWNER_PN, priv: OWNER_PN },
  { name: "mode jid", setup: () => setViewOnce("jid", { vvJid: VV_JID }), group: VV_JID, priv: VV_JID },
  { name: "mode g", setup: () => setViewOnce("g"), group: GROUP, priv: OWNER_PN },
  { name: "mode p but disabled", setup: () => setViewOnce("p", { enabled: false }), group: GROUP, priv: OWNER_PN },
  { name: "mode jid without a jid", setup: () => setViewOnce("jid", { vvJid: null }), group: GROUP, priv: OWNER_PN },
];

for (const mode of OWNER_MODES) {
  test(`owner .vv, ${mode.name}: the destination is the .setvv one (group and private chat)`, async () => {
    await mode.setup();
    const inGroup = await run(".vv", { who: OWNER, quoted: viewOnce("image", { caption: "secret" }) });
    assert.equal(inGroup.attempts.length, 1, "one send, no reaction");
    assert.equal(inGroup.attempts[0].jid, mode.group);
    assert.equal(inGroup.attempts[0].content.caption, "secret", "the original caption");
    assert.equal(inGroup.attempts[0].content.image, IMAGE.buffer);

    const inPrivate = await run(".vv", { who: OWNER, where: PRIVATE, quoted: viewOnce("image") });
    assert.equal(inPrivate.attempts.length, 1);
    assert.equal(inPrivate.attempts[0].jid, mode.priv);
    assert.equal(inPrivate.attempts[0].content.caption, getLang("plugins.viewonce.forwarded"), "default caption");
  });
}

test("owner .vv reads the view_once setting", async () => {
  await setViewOnce("p");
  const findOne = mock.method(db.ViewOnce, "findOne");
  await run(".vv", { who: OWNER, quoted: viewOnce() });
  assert.equal(findOne.mock.callCount(), 1);
});

test("owner .vv: video and audio keep their shape", async () => {
  const video = await run(".vv", { who: OWNER, quoted: viewOnce("video", { caption: "clip" }), media: VIDEO });
  assert.deepEqual(video.attempts.map((a) => [a.jid, Object.keys(a.content).sort()]), [[GROUP, ["caption", "video"]]]);
  const audio = await run(".vv", { who: OWNER, quoted: viewOnce("audio", { ptt: true }), media: AUDIO });
  assert.equal(audio.attempts.length, 1);
  assert.deepEqual(audio.attempts[0].content, { audio: AUDIO.buffer, mimetype: "audio/ogg; codecs=opus", ptt: true });
});

test("owner .vv: the usage text and the too-large notice stay in the chat", async () => {
  const usage = await run(".vv", { who: OWNER });
  assert.equal(usage.attempts.length, 1);
  assert.equal(usage.attempts[0].jid, GROUP);
  assert.equal(usage.attempts[0].content.text, getLang("plugins.vv.usage", config.PREFIX));
  assert.ok(usage.attempts[0].options && usage.attempts[0].options.quoted, "a quoted reply, like today");

  const large = await run(".vv", { who: OWNER, quoted: viewOnce(), media: () => { throw tooLarge(7); } });
  assert.deepEqual(large.texts(), [getLang("common.media_too_large", 7)]);
  assert.equal(large.attempts[0].jid, GROUP);

  const noMax = await run(".vv", { who: OWNER, quoted: viewOnce(), media: () => { throw tooLarge(); } });
  assert.deepEqual(noMax.texts(), [getLang("common.media_too_large", Math.round(Number(config.MAX_UPLOAD) || 230))]);
});

test("owner .vv: a failing send still gives common.error in the chat and the stack to the owners", async () => {
  const failed = await run(".vv", { who: OWNER, quoted: viewOnce(), failWhen: (jid, content) => !!content.image });
  assert.ok(failed.to(GROUP).some((a) => a.content.text === getLang("common.error")), "common.error in the chat");
  assert.ok(failed.to(OWNER_PN).some((a) => /Error in/.test(a.content.text || "")), "the stack goes to the owner");
});

test("owner .vv: not a view-once, an unsupported kind, no media and a download error send nothing", async () => {
  const plain = await run(".vv", { who: OWNER, quoted: { media: "image" } });
  assert.equal(plain.attempts.length, 0);
  assert.equal(plain.calls.downloads, 0, "nothing downloaded");
  const text = await run(".vv", { who: OWNER, quoted: "just a text" });
  assert.equal(text.attempts.length, 0);
  const doc = await run(".vv", { who: OWNER, quoted: viewOnce("document") });
  assert.equal(doc.attempts.length, 0);
  assert.equal(doc.calls.downloads, 0);
  const none = await run(".vv", { who: OWNER, quoted: viewOnce(), media: null });
  assert.equal(none.attempts.length, 0);
  const broken = await run(".vv", {
    who: OWNER,
    quoted: viewOnce(),
    media: () => {
      throw new Error("download exploded");
    },
  });
  assert.equal(broken.attempts.length, 0);
});

// ---------------------------------------------------------------------------
// .vv, a delegated requester
// ---------------------------------------------------------------------------

const VIEW_ONCE_CONFIGS = [
  { name: "no row", setup: async () => {} },
  { name: "mode p", setup: () => setViewOnce("p") },
  { name: "mode jid", setup: () => setViewOnce("jid", { vvJid: VV_JID }) },
  { name: "mode g", setup: () => setViewOnce("g") },
];

const REQUESTERS = [
  { name: "member with a PN only, in a group", who: B_PN, where: GROUP, dest: MEMBER_PN },
  { name: "member with a PN and a LID, in a group: the PN is preferred", who: B_BOTH, where: GROUP, dest: MEMBER_PN },
  { name: "LID-only member, in a group: the LID", who: B_LID, where: GROUP, dest: MEMBER_LID },
  { name: "member in a private chat: message.jid", who: B_PN, where: PRIVATE, dest: MEMBER_PN },
  { name: "member addressed by LID in a private chat: message.jid", who: B_BOTH, where: PRIVATE, dest: MEMBER_LID },
  { name: "LID-only member in a private chat: message.jid", who: B_LID, where: PRIVATE, dest: MEMBER_LID },
];

for (const requester of REQUESTERS) {
  for (const config_ of VIEW_ONCE_CONFIGS) {
    test(`delegated .vv, ${requester.name}, view_once ${config_.name}: one send to the requester, whatever view_once says`, async () => {
      await config_.setup();
      await grant("vv", [PERSON_B, PERSON_B_LID]);
      const findOne = mock.method(db.ViewOnce, "findOne");
      const get = mock.method(settingsCache, "get");

      const result = await run(".vv", {
        who: requester.who,
        where: requester.where,
        quoted: viewOnce("image", { caption: "for B" }),
      });

      assert.equal(result.attempts.length, 1, "exactly one send, no reaction, no reply");
      assert.equal(result.attempts[0].jid, requester.dest);
      assert.equal(result.attempts[0].content.image, IMAGE.buffer);
      assert.equal(result.attempts[0].content.caption, "for B");
      assert.equal(result.to(GROUP).length, 0, "nothing in the group");
      assert.equal(result.to(OWNER_PN).length, 0, "nothing to the owner (mode p)");
      assert.equal(result.to(VV_JID).length, 0, "nothing to the .setvv jid");
      assert.equal(findOne.mock.callCount(), 0, "the view_once row is never read for a delegated requester");
      assert.ok(
        !get.mock.calls.some((call) => call.arguments[0] === "view_once"),
        "settingsCache.get('view_once') is never called",
      );
    });
  }
}

test("delegated .vv: video and audio go to the requester, with the default caption", async () => {
  await grant("vv", [PERSON_B]);
  const video = await run(".vv", { who: B_PN, quoted: viewOnce("video"), media: VIDEO });
  assert.deepEqual(video.attempts.map((a) => a.jid), [MEMBER_PN]);
  assert.equal(video.attempts[0].content.video, VIDEO.buffer);
  assert.equal(video.attempts[0].content.caption, getLang("plugins.viewonce.forwarded"));

  const audio = await run(".vv", { who: B_PN, quoted: viewOnce("audio", { ptt: true }), media: AUDIO });
  assert.deepEqual(audio.attempts.map((a) => a.jid), [MEMBER_PN]);
  assert.deepEqual(audio.attempts[0].content, { audio: AUDIO.buffer, mimetype: "audio/ogg; codecs=opus", ptt: true });
});

test("delegated .vv through a group rule works the same", async () => {
  await grant("vv", [PERSON_B], { scope: GROUP });
  const result = await run(".vv", { who: B_PN, quoted: viewOnce() });
  assert.deepEqual(result.attempts.map((a) => a.jid), [MEMBER_PN]);
});

test("without a rule a member is refused by the owner gate, nothing is downloaded or sent but the refusal", async () => {
  const result = await run(".vv", { who: B_PN, quoted: viewOnce() });
  assert.deepEqual(result.texts(), [getLang("common.owner_only")]);
  assert.equal(result.calls.downloads, 0);
  assert.equal(result.media().length, 0);
});

test("delegated .vv: not a view-once, an unsupported kind, no media or a download error send nothing anywhere", async () => {
  await grant("vv", [PERSON_B]);
  await setViewOnce("p");

  const plain = await run(".vv", { who: B_PN, quoted: { media: "image" } });
  assert.equal(plain.attempts.length, 0, "a regular image");
  assert.equal(plain.calls.downloads, 0);

  const text = await run(".vv", { who: B_PN, quoted: "just a text" });
  assert.equal(text.attempts.length, 0);

  const doc = await run(".vv", { who: B_PN, quoted: viewOnce("document") });
  assert.equal(doc.attempts.length, 0, "unsupported kind");
  assert.equal(doc.calls.downloads, 0);

  const none = await run(".vv", { who: B_PN, quoted: viewOnce(), media: null });
  assert.equal(none.attempts.length, 0, "getQuotedMedia() returned null");
  assert.equal(none.calls.downloads, 1);

  const broken = await run(".vv", {
    who: B_PN,
    quoted: viewOnce(),
    media: () => {
      throw new Error("download exploded");
    },
  });
  assert.equal(broken.attempts.length, 0, "a download error is silent");
});

test("delegated .vv: a rejecting sendMessage leaves nothing in the group, no common.error and no owner DM", async () => {
  await grant("vv", [PERSON_B]);
  const result = await run(".vv", { who: B_PN, quoted: viewOnce(), failWhen: () => true });
  assert.equal(result.attempts.length, 1, "the media send was the only attempt");
  assert.equal(result.attempts[0].jid, MEMBER_PN);
  assert.equal(result.to(GROUP).length, 0);
  assert.equal(result.to(OWNER_PN).length, 0, "no stack to the owners");
  assert.ok(!result.texts().includes(getLang("common.error")), "no common.error");
  assert.equal(result.sock.sent.length, 0, "nothing was delivered anywhere");
});

test("delegated .vv: a rejecting sendMessage in a private chat is just as silent", async () => {
  await grant("vv", [PERSON_B]);
  const result = await run(".vv", { who: B_PN, where: PRIVATE, quoted: viewOnce(), failWhen: () => true });
  assert.equal(result.attempts.length, 1);
  assert.equal(result.to(OWNER_PN).length, 0);
  assert.ok(!result.texts().includes(getLang("common.error")));
});

test("delegated .vv: the usage text goes to the requester's DM, not to the group", async () => {
  await grant("vv", [PERSON_B]);
  const usage = getLang("plugins.vv.usage", config.PREFIX);

  const inGroup = await run(".vv", { who: B_PN });
  assert.equal(inGroup.attempts.length, 1);
  assert.ok(isRequesterOnly(inGroup, MEMBER_PN));
  assert.deepEqual(inGroup.attempts[0].content, { text: usage });
  assert.equal(inGroup.attempts[0].options, undefined, "not a reply quoted into the group");

  const lidOnly = await run(".vv", { who: B_LID });
  assert.ok(isRequesterOnly(lidOnly, MEMBER_LID));
  assert.deepEqual(lidOnly.texts(), [usage]);

  const inPrivate = await run(".vv", { who: B_PN, where: PRIVATE });
  assert.ok(isRequesterOnly(inPrivate, MEMBER_PN));
  assert.deepEqual(inPrivate.texts(), [usage]);
});

test("delegated .vv: common.media_too_large goes to the DM, with maxMB or the MAX_UPLOAD formula", async () => {
  await grant("vv", [PERSON_B]);

  const withMax = await run(".vv", { who: B_PN, quoted: viewOnce(), media: () => { throw tooLarge(7); } });
  assert.equal(withMax.attempts.length, 1);
  assert.ok(isRequesterOnly(withMax, MEMBER_PN));
  assert.deepEqual(withMax.attempts[0].content, { text: getLang("common.media_too_large", 7) });
  assert.equal(withMax.attempts[0].options, undefined);

  const withoutMax = await run(".vv", { who: B_LID, quoted: viewOnce(), media: () => { throw tooLarge(); } });
  assert.ok(isRequesterOnly(withoutMax, MEMBER_LID));
  assert.deepEqual(withoutMax.texts(), [getLang("common.media_too_large", Math.round(Number(config.MAX_UPLOAD) || 230))]);
});

test("delegated .vv: a failing DM is swallowed (usage and too-large), nothing else is attempted", async () => {
  await grant("vv", [PERSON_B]);

  const usage = await run(".vv", { who: B_PN, failWhen: () => true });
  assert.equal(usage.attempts.length, 1, "one DM attempt, no common.error, no owner DM");
  assert.equal(usage.attempts[0].jid, MEMBER_PN);

  const large = await run(".vv", {
    who: B_PN,
    quoted: viewOnce(),
    media: () => { throw tooLarge(5); },
    failWhen: () => true,
  });
  assert.equal(large.attempts.length, 1);
  assert.equal(large.attempts[0].jid, MEMBER_PN);
  assert.equal(large.to(GROUP).length, 0);
  assert.equal(large.to(OWNER_PN).length, 0);
});

test("delegated .vv with an empty requester JID in a group ends silently", async () => {
  const result = await run(".vv", {
    who: B_PN,
    quoted: viewOnce(),
    direct: async (message) => {
      message.sender = "";
      message.senderLid = null;
      message.isSudo = () => false;
      await vvPlugin.execute(message);
    },
  });
  assert.equal(result.attempts.length, 0);
  assert.equal(result.calls.downloads, 0, "nothing downloaded for nobody");

  const usage = await run(".vv", {
    who: B_PN,
    direct: async (message) => {
      message.sender = "";
      message.senderLid = null;
      message.isSudo = () => false;
      await vvPlugin.execute(message);
    },
  });
  assert.equal(usage.attempts.length, 0, "no usage text either");
});


// ---------------------------------------------------------------------------
// .save
// ---------------------------------------------------------------------------

const STATUS_AUTHOR = "237690000050@s.whatsapp.net";

/** A status image / text / voice note that the requester replies to, and two things `.save` cannot keep. */
const status = {
  image: { media: { type: "image", caption: "status caption" }, sender: STATUS_AUTHOR },
  text: { text: "status text", sender: STATUS_AUTHOR },
  audio: { media: { type: "audio" }, sender: STATUS_AUTHOR },
  document: { media: { type: "document" }, sender: STATUS_AUTHOR },
  emptyText: { message: { conversation: "" }, sender: STATUS_AUTHOR },
};

const reactionsOf = (result) => result.attempts.filter((a) => a.content.react);
const reactionList = (result) => reactionsOf(result).map((a) => [a.jid, a.content.react.text]);
const dropQuotedMessage = (message) => {
  message.quoted.message = null;
};
const MAX_UPLOAD_MB = () => Math.round(Number(config.MAX_UPLOAD) || 230);

/**
 * Every text `.save` can answer instead of saving: what is sent, and the reactions the OWNER sees
 * (`reply_required` comes before the hourglass).
 */
const SAVE_NOTICES = [
  { name: "reply_required", text: () => getLang("plugins.save.reply_required"), opts: {}, ownerReacts: [] },
  {
    name: "no_message",
    text: () => getLang("plugins.save.no_message"),
    opts: { quoted: status.image, prepare: dropQuotedMessage },
    ownerReacts: ["⏳", "❌"],
  },
  {
    name: "download_failed",
    text: () => getLang("plugins.save.download_failed"),
    opts: { quoted: status.image, media: null },
    ownerReacts: ["⏳", "❌"],
  },
  {
    name: "no_media (a document)",
    text: () => getLang("plugins.save.no_media"),
    opts: { quoted: status.document },
    ownerReacts: ["⏳", "❌"],
  },
  {
    name: "no_media (an empty text)",
    text: () => getLang("plugins.save.no_media"),
    opts: { quoted: status.emptyText },
    ownerReacts: ["⏳", "❌"],
  },
  {
    name: "common.media_too_large (maxMB 7)",
    text: () => getLang("common.media_too_large", 7),
    opts: { quoted: status.image, media: () => { throw tooLarge(7); } },
    ownerReacts: ["⏳", "❌"],
  },
  {
    name: "common.media_too_large (no maxMB: the MAX_UPLOAD formula)",
    text: () => getLang("common.media_too_large", MAX_UPLOAD_MB()),
    opts: { quoted: status.image, media: () => { throw tooLarge(); } },
    ownerReacts: ["⏳", "❌"],
  },
];

// ---- .save, the owner: unchanged ------------------------------------------

test("owner .save is unchanged: the media goes to the owner's own chat, the reactions stay in the chat", async () => {
  const result = await run(".save", { who: OWNER, quoted: status.image });
  assert.equal(result.media().length, 1);
  assert.equal(result.media()[0].jid, OWNER_PN);
  assert.match(result.media()[0].content.caption, /status caption/);
  assert.match(result.media()[0].content.caption, /237690000050/);
  assert.deepEqual(reactionList(result), [[GROUP, "⏳"], [GROUP, "✅"]]);
});

for (const notice of SAVE_NOTICES) {
  test(`owner .save, ${notice.name}: the text stays in the chat, with the same reactions`, async () => {
    const result = await run(".save", { who: OWNER, ...notice.opts });
    assert.deepEqual(result.texts(), [notice.text()]);
    const reply = result.attempts.find((a) => a.content.text);
    assert.equal(reply.jid, GROUP, "in the chat, not in a DM");
    assert.deepEqual(reactionList(result), notice.ownerReacts.map((emoji) => [GROUP, emoji]));
    assert.equal(result.media().length, 0);
  });
}

test("owner .save: reply_required is a reply quoted into the chat", async () => {
  const result = await run(".save", { who: OWNER });
  assert.ok(result.attempts[0].options && result.attempts[0].options.quoted, "a quoted reply, like today");
});

test("owner .save in a private chat: replies and reactions stay in that chat", async () => {
  const none = await run(".save", { who: OWNER, where: PRIVATE });
  assert.deepEqual(none.texts(), [getLang("plugins.save.reply_required")]);
  assert.equal(none.attempts[0].jid, none.message.jid);

  const failed = await run(".save", { who: OWNER, where: PRIVATE, quoted: status.image, media: null });
  assert.deepEqual(
    reactionList(failed),
    [[failed.message.jid, "⏳"], [failed.message.jid, "❌"]],
  );
  assert.deepEqual(failed.texts(), [getLang("plugins.save.download_failed")]);
});

test("owner .save: a failing send still gives the cross, common.error in the chat and the stack to the owners", async () => {
  const failed = await run(".save", { who: OWNER, quoted: status.image, failWhen: (jid, content) => !!content.image });
  assert.deepEqual(reactionList(failed), [[GROUP, "⏳"], [GROUP, "❌"]]);
  assert.ok(failed.to(GROUP).some((a) => a.content.text === getLang("common.error")), "common.error in the chat");
  assert.ok(failed.to(OWNER_PN).some((a) => /Error in/.test(a.content.text || "")), "the stack goes to the owner");
});

test("owner .save: a text status and a voice note keep their shape", async () => {
  const text = await run(".save", { who: OWNER, quoted: status.text });
  assert.deepEqual(text.attempts.filter((a) => a.content.text).map((a) => a.jid), [OWNER_PN]);
  assert.deepEqual(reactionList(text), [[GROUP, "⏳"], [GROUP, "✅"]]);

  const audio = await run(".save", { who: OWNER, quoted: status.audio, media: AUDIO });
  assert.deepEqual(audio.attempts.filter((a) => !a.content.react).map((a) => a.jid), [OWNER_PN, OWNER_PN]);
  assert.deepEqual(reactionList(audio), [[GROUP, "⏳"], [GROUP, "✅"]]);
});

// ---- .save, a delegated requester: the media ------------------------------

const MEDIA_REQUESTERS = [
  { name: "PN member in a group", who: B_PN, where: GROUP, dest: MEMBER_PN },
  { name: "PN and LID member in a group", who: B_BOTH, where: GROUP, dest: MEMBER_PN },
  { name: "LID-only member in a group", who: B_LID, where: GROUP, dest: MEMBER_LID },
  { name: "member in a private chat", who: B_PN, where: PRIVATE, dest: MEMBER_PN },
];

for (const requester of MEDIA_REQUESTERS) {
  test(`delegated .save, ${requester.name}: the media goes to the requester only, no reaction, nothing in the chat`, async () => {
    await grant("save", [PERSON_B, PERSON_B_LID]);
    const result = await run(".save", { who: requester.who, where: requester.where, quoted: status.image });
    assert.equal(result.attempts.length, 1, "the media, no hourglass, no check mark");
    assert.equal(result.media().length, 1);
    assert.equal(result.media()[0].jid, requester.dest);
    assert.match(result.media()[0].content.caption, /status caption/);
    assert.equal(reactionsOf(result).length, 0, "no reaction at all");
    assert.equal(result.to(GROUP).length, 0, "nothing in the group");
    assert.equal(result.to(OWNER_PN).length, 0, "nothing to the owner");
  });
}

test("delegated .save: a video, a text status and a voice note go to the requester as well, without a reaction", async () => {
  await grant("save", [PERSON_B]);

  const video = await run(".save", { who: B_PN, quoted: { media: { type: "video" }, sender: STATUS_AUTHOR }, media: VIDEO });
  assert.deepEqual(video.attempts.map((a) => a.jid), [MEMBER_PN]);
  assert.equal(video.attempts[0].content.video, VIDEO.buffer);

  const text = await run(".save", { who: B_PN, quoted: status.text });
  assert.deepEqual(text.attempts.map((a) => a.jid), [MEMBER_PN]);
  assert.match(text.attempts[0].content.text, /status text/);
  assert.equal(text.to(OWNER_PN).length, 0);

  const audio = await run(".save", { who: B_PN, quoted: status.audio, media: AUDIO });
  assert.deepEqual(audio.attempts.map((a) => a.jid), [MEMBER_PN, MEMBER_PN], "the header, then the audio");
  assert.ok(audio.attempts[1].content.audio);
  assert.equal(audio.to(OWNER_PN).length, 0);

  for (const result of [video, text, audio]) {
    assert.equal(reactionsOf(result).length, 0, "no reaction");
    assert.equal(result.to(GROUP).length, 0, "nothing in the group");
  }
});

test("delegated .save through a group rule works the same, and is as discreet", async () => {
  await grant("save", [PERSON_B], { scope: GROUP });
  const result = await run(".save", { who: B_PN, quoted: status.image });
  assert.deepEqual(result.attempts.map((a) => a.jid), [MEMBER_PN]);
  assert.equal(reactionsOf(result).length, 0);
});

// ---- .save, a delegated requester: every text goes to the DM --------------

for (const requester of REQUESTERS) {
  for (const notice of SAVE_NOTICES) {
    test(`delegated .save, ${requester.name}, ${notice.name}: one text to the requester's DM, no reaction, nothing in the chat`, async () => {
      await grant("save", [PERSON_B, PERSON_B_LID]);
      const result = await run(".save", { who: requester.who, where: requester.where, ...notice.opts });

      assert.equal(result.attempts.length, 1, "exactly one send: no hourglass, no cross, no reply");
      assert.equal(result.attempts[0].jid, requester.dest);
      assert.deepEqual(result.attempts[0].content, { text: notice.text() });
      assert.equal(result.attempts[0].options, undefined, "not a reply quoted into the chat");
      assert.equal(reactionsOf(result).length, 0, "no reaction");
      assert.equal(result.to(GROUP).length, 0, "nothing in the group");
      assert.equal(result.to(OWNER_PN).length, 0, "nothing to the owner");
      assert.ok(!result.texts().includes(getLang("common.error")), "no common.error");
      assert.equal(result.media().length, 0);
    });
  }
}

test("delegated .save: the chat gets nothing for any notice, with a group rule as well", async () => {
  await grant("save", [PERSON_B], { scope: GROUP });
  for (const notice of SAVE_NOTICES) {
    const result = await run(".save", { who: B_PN, ...notice.opts });
    assert.equal(result.to(GROUP).length, 0, notice.name);
    assert.deepEqual(result.texts(), [notice.text()], notice.name);
  }
});

// ---- .save, a delegated requester: failures stay silent -------------------

test("delegated .save: a failing DM is swallowed for every notice, nothing else is attempted", async () => {
  await grant("save", [PERSON_B]);
  for (const notice of SAVE_NOTICES) {
    const result = await run(".save", { who: B_PN, ...notice.opts, failWhen: () => true });
    assert.equal(result.attempts.length, 1, `${notice.name}: one DM attempt, no common.error, no owner DM`);
    assert.equal(result.attempts[0].jid, MEMBER_PN);
    assert.equal(reactionsOf(result).length, 0);
    assert.equal(result.sock.sent.length, 0, "nothing was delivered anywhere");
  }
});

test("delegated .save: a rejecting media send leaves nothing in the group, no common.error and no owner DM", async () => {
  await grant("save", [PERSON_B]);
  const result = await run(".save", { who: B_PN, quoted: status.image, failWhen: () => true });
  assert.equal(result.attempts.length, 1, "the media send was the only attempt");
  assert.equal(result.attempts[0].jid, MEMBER_PN);
  assert.equal(reactionsOf(result).length, 0, "no cross either");
  assert.equal(result.to(GROUP).length, 0);
  assert.equal(result.to(OWNER_PN).length, 0, "no stack to the owners");
  assert.ok(!result.texts().includes(getLang("common.error")), "no common.error");
  assert.equal(result.sock.sent.length, 0);
});

test("delegated .save: a rejecting send in a private chat is just as silent", async () => {
  await grant("save", [PERSON_B]);
  const result = await run(".save", { who: B_PN, where: PRIVATE, quoted: status.image, failWhen: () => true });
  assert.equal(result.attempts.length, 1);
  assert.equal(reactionsOf(result).length, 0);
  assert.equal(result.to(OWNER_PN).length, 0);
  assert.ok(!result.texts().includes(getLang("common.error")));
});

test("delegated .save: a voice note whose header fails, or whose audio fails, stays silent", async () => {
  await grant("save", [PERSON_B]);

  const header = await run(".save", { who: B_PN, quoted: status.audio, media: AUDIO, failWhen: (jid, content) => !!content.text });
  assert.equal(header.attempts.length, 1, "the header failed: the audio is not tried");
  assert.equal(header.to(GROUP).length, 0);
  assert.equal(header.to(OWNER_PN).length, 0);
  assert.equal(reactionsOf(header).length, 0);

  const audio = await run(".save", { who: B_PN, quoted: status.audio, media: AUDIO, failWhen: (jid, content) => !!content.audio });
  assert.deepEqual(audio.attempts.map((a) => a.jid), [MEMBER_PN, MEMBER_PN]);
  assert.equal(audio.to(GROUP).length, 0);
  assert.equal(audio.to(OWNER_PN).length, 0);
  assert.equal(reactionsOf(audio).length, 0);
  assert.ok(!audio.texts().includes(getLang("common.error")));
});

test("delegated .save: a download error is swallowed, nothing is sent anywhere", async () => {
  await grant("save", [PERSON_B]);
  const result = await run(".save", {
    who: B_PN,
    quoted: status.image,
    media: () => {
      throw new Error("download exploded");
    },
  });
  assert.equal(result.calls.downloads, 1);
  assert.equal(result.attempts.length, 0, "no reaction, no reply, no DM, no common.error, no owner DM");
});

test("delegated .save: an empty requester address ends silently in a group, and answers no_sudo in the chat itself in a private chat", async () => {
  const clear = (message) => {
    message.sender = "";
    message.senderLid = null;
  };

  const inGroup = await run(".save", {
    who: B_PN,
    quoted: status.image,
    direct: async (message) => {
      clear(message);
      await savePlugin.execute(message);
    },
  });
  assert.equal(inGroup.attempts.length, 0, "nobody to tell: nothing in the group");
  assert.equal(inGroup.calls.downloads, 0);

  const inPrivate = await run(".save", {
    who: B_PN,
    where: PRIVATE,
    quoted: status.image,
    direct: async (message) => {
      clear(message);
      await savePlugin.execute(message);
    },
  });
  assert.equal(inPrivate.attempts.length, 1, "no hourglass, no cross");
  assert.equal(inPrivate.attempts[0].jid, inPrivate.message.jid, "the requester's DM is the chat itself");
  assert.deepEqual(inPrivate.attempts[0].content, { text: getLang("plugins.save.no_sudo") });
  assert.equal(inPrivate.media().length, 0, "no media sent");
  assert.equal(inPrivate.to(OWNER_PN).length, 0, "no fallback to the owner");
  assert.equal(inPrivate.calls.downloads, 0);
});

test("without a rule a member is refused by the owner gate: no reaction, nothing downloaded or sent but the refusal", async () => {
  const result = await run(".save", { who: B_PN, quoted: status.image });
  assert.deepEqual(result.texts(), [getLang("common.owner_only")]);
  assert.equal(result.calls.downloads, 0);
  assert.equal(result.media().length, 0);
  assert.equal(reactionsOf(result).length, 0);
});

test("plugins/save.js no longer falls back to the owner (the getOwnerJids import is gone)", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "plugins", "save.js"), "utf8");
  assert.ok(!/getOwnerJids/.test(source), "getOwnerJids is not used any more");
});
