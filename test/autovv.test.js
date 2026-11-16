"use strict";
/**
 * autovv: automatic forwarding of the view-once messages the bot receives.
 *
 * WhatsApp sends view-once media to Android devices only, so the bot receives them when it declares itself
 * as one (BAILEYS_DEVICE=android). autovv forwards each one, from every chat (disabled chats apart, the
 * pipeline gate runs first), to the first owner's private chat (`p`) or to a chosen chat (`jid`), never back
 * to the chat it came from.
 *
 *  - settings AUTOVV_MODE (off | p | jid, default off) and AUTOVV_JID (chat JID or number), theme behavior,
 *    panel only (env: null); a `jid` mode needs a JID (cross-field rule);
 *  - `.setvv` (the `view_once` row) is now only the destination of `.vv`: it no longer forwards anything;
 *  - `.autovv` (owner, never delegable) reads and writes the two settings, and warns when the bot is not
 *    declared as an Android device.
 *
 * In-memory database, fake socket, no network (the download is stubbed per message).
 */

const { test, describe, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fakes = require("./helpers/fakes");

const { IDS } = fakes;
fakes.setupEnv({ sudo: "111" });
const net = fakes.stubNetwork();

const config = require("../config");
const catalog = require("../lib/utils/settingsCatalog");
const settingsStore = require("../lib/utils/settingsStore");
const settingsCache = require("../lib/utils/settingsCache");
const viewOnceHandler = require("../lib/utils/viewOnceHandler");
const { getLang } = require("../lib/utils/language");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-autovv-"));
let registry;
let db;

before(async () => {
  ({ registry, db } = await fakes.setup());
  require("../lib/utils/secretBox").configure({ dir: path.join(tmp, "data") });
  await settingsStore.load({ models: db });
});

after(() => {
  net.restore();
  settingsStore.clearRuntime();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  settingsStore.clearRuntime();
  await settingsStore.unset(["AUTOVV_MODE", "AUTOVV_JID", "BAILEYS_DEVICE"]);
  await db.ViewOnce.destroy({ where: {} });
  settingsCache.clear();
});

/** An incoming view-once (with its download link) from a member, in a group unless `group: false` */
function incoming({ kind = "image", group = IDS.GROUP, fromMe = false, caption } = {}) {
  const media = {
    mimetype: { image: "image/jpeg", video: "video/mp4", audio: "audio/ogg; codecs=opus" }[kind],
    fileLength: 2048,
    viewOnce: true,
    directPath: "/v/t62.7118-24/fake?ccb=11-4",
    mediaKey: Buffer.alloc(32, 1).toString("base64"),
    ...(caption ? { caption } : {}),
  };
  const message = fakes.makeMessage({
    from: IDS.MEMBER_PN,
    group: group || undefined,
    fromMe,
    message: { viewOnceMessageV2: { message: { [`${kind}Message`]: media } } },
  });
  message.downloads = 0;
  message.downloadMedia = async () => {
    message.downloads += 1;
    return Buffer.from(`${kind}-bytes`);
  };
  return message;
}

const sent = (message) => message.client.getSocket().sent.filter((s) => s.kind !== "react");

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe("settings", () => {
  test("AUTOVV_MODE and AUTOVV_JID: behavior, panel only, off and empty by default", () => {
    const mode = catalog.byKey.get("AUTOVV_MODE");
    const jid = catalog.byKey.get("AUTOVV_JID");
    assert.ok(mode && jid);
    assert.deepEqual([mode.theme, mode.type, mode.env, mode.default, mode.effect], ["behavior", "enum", null, "off", "immediate"]);
    assert.deepEqual(mode.rules.enum, ["off", "p", "jid"]);
    assert.deepEqual([jid.theme, jid.type, jid.env, jid.default], ["behavior", "string", null, ""]);
    assert.ok(jid.validate("not a jid"), "an invalid chat is refused");
    assert.equal(jid.validate("237690000001"), null);
    assert.equal(config.AUTOVV_MODE, "off");
  });

  test("a jid mode needs a JID (cross-field rule): only the keys of the batch are blamed", async () => {
    // the panel and .autovv send the pair together: the empty JID is the field in error
    await assert.rejects(settingsStore.set({ AUTOVV_MODE: "jid", AUTOVV_JID: "" }), (error) => {
      assert.deepEqual(Object.keys(error.fields), ["AUTOVV_JID"]);
      assert.equal(error.fields.AUTOVV_JID.code, "required");
      return true;
    });
    // the mode alone: the mode is in conflict with the (empty) JID
    await assert.rejects(settingsStore.set({ AUTOVV_MODE: "jid" }), (error) => {
      assert.deepEqual(error.fields.AUTOVV_MODE, { code: "bound_conflict", params: { other: "AUTOVV_JID" } });
      return true;
    });
    await settingsStore.set({ AUTOVV_MODE: "jid", AUTOVV_JID: "120363000000000042@g.us" });
    assert.equal(config.AUTOVV_MODE, "jid");

    // an unrelated batch is never blocked, whatever the state of the pair
    const validator = catalog.crossValidators.find((fn) => fn.name === "autovvTarget");
    const projected = (key) => ({ AUTOVV_MODE: "jid", AUTOVV_JID: "" })[key];
    assert.equal(validator(projected, new Set(["PREFIX"])), null);
  });
});

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

describe("forwarding", () => {
  test("off (default): nothing is forwarded, nothing is downloaded", async () => {
    const message = incoming();
    assert.equal(await viewOnceHandler.handleMessage(message), false);
    assert.equal(message.downloads, 0);
    assert.deepEqual(sent(message), []);
  });

  test("p: to the first owner's private chat, with the author and the caption", async () => {
    await settingsStore.set({ AUTOVV_MODE: "p" });
    const message = incoming({ caption: "hello" });
    assert.equal(await viewOnceHandler.handleMessage(message), true);
    const out = sent(message);
    assert.equal(out.length, 1);
    assert.equal(out[0].jid, IDS.OWNER_PN);
    assert.ok(Buffer.isBuffer(out[0].content.image));
    assert.ok(out[0].content.caption.startsWith(getLang("plugins.viewonce.forward_caption", "333")));
    assert.ok(out[0].content.caption.endsWith("hello"));
  });

  test("jid: to the chosen chat (a number is a private chat), from a private chat too", async () => {
    await settingsStore.set({ AUTOVV_MODE: "jid", AUTOVV_JID: "237690000001" });
    const message = incoming({ kind: "video", group: false });
    assert.equal(await viewOnceHandler.handleMessage(message), true);
    const out = sent(message);
    assert.equal(out.length, 1);
    assert.equal(out[0].jid, "237690000001@s.whatsapp.net");
    assert.ok(Buffer.isBuffer(out[0].content.video));
  });

  test("audio: the author line, then the voice note", async () => {
    await settingsStore.set({ AUTOVV_MODE: "p" });
    const message = incoming({ kind: "audio" });
    assert.equal(await viewOnceHandler.handleMessage(message), true);
    const out = sent(message);
    assert.deepEqual(out.map((s) => s.jid), [IDS.OWNER_PN, IDS.OWNER_PN]);
    assert.ok(out[0].content.text);
    assert.ok(Buffer.isBuffer(out[1].content.audio));
  });

  test("the bot's own view-once messages are never forwarded", async () => {
    await settingsStore.set({ AUTOVV_MODE: "p" });
    const message = incoming({ fromMe: true });
    assert.equal(await viewOnceHandler.handleMessage(message), false);
    assert.deepEqual(sent(message), []);
  });

  test(".setvv no longer forwards: the view_once row is only the destination of .vv", async () => {
    await db.ViewOnce.create({ id: 1, enabled: true, vvMode: "p", vvJid: null });
    settingsCache.clear();
    const message = incoming();
    assert.equal(await viewOnceHandler.handleMessage(message), false);
    assert.equal(message.downloads, 0);
    assert.deepEqual(sent(message), []);
  });
});

// ---------------------------------------------------------------------------
// The .autovv command
// ---------------------------------------------------------------------------

describe(".autovv", () => {
  async function run(text) {
    const message = fakes.makeMessage({ body: text, from: IDS.OWNER_PN });
    await registry.executeCommand(message);
    return fakes.sentTexts(message.client.getSocket()).join("\n");
  }

  test("owner only and never delegable (config)", () => {
    const entry = registry.getCommandByPattern("autovv");
    assert.ok(entry, ".autovv is registered");
    assert.equal(entry.fromMe || entry.ownerOnly, true);
    assert.equal(entry.delegable, false);
    assert.equal(entry.lockReason, "config");
  });

  test("p / on: the owner's private chat", async () => {
    for (const arg of ["p", "on"]) {
      await settingsStore.set({ AUTOVV_MODE: "off" });
      const reply = await run(`.autovv ${arg}`);
      assert.equal(config.AUTOVV_MODE, "p", arg);
      assert.equal(config.AUTOVV_JID, "");
      assert.ok(reply.includes(getLang("plugins.autovv.updated", getLang("plugins.autovv.target_private"))), reply);
    }
  });

  test("a number or a JID: that chat, stored as a JID", async () => {
    await run(".autovv +237 690 000 001");
    assert.deepEqual([config.AUTOVV_MODE, config.AUTOVV_JID], ["jid", "237690000001@s.whatsapp.net"]);
    await run(".autovv 120363000000000042@g.us");
    assert.deepEqual([config.AUTOVV_MODE, config.AUTOVV_JID], ["jid", "120363000000000042@g.us"]);
  });

  test("off / null: disabled, the JID is cleared", async () => {
    await settingsStore.set({ AUTOVV_MODE: "jid", AUTOVV_JID: "237690000001@s.whatsapp.net" });
    const reply = await run(".autovv off");
    assert.deepEqual([config.AUTOVV_MODE, config.AUTOVV_JID], ["off", ""]);
    assert.ok(reply.includes(getLang("plugins.autovv.updated", getLang("plugins.autovv.target_off"))), reply);
  });

  test("no argument: the current state and the usage; an unknown argument: the usage, nothing written", async () => {
    await settingsStore.set({ AUTOVV_MODE: "p" });
    const status = await run(".autovv");
    assert.ok(status.includes(getLang("plugins.autovv.status", getLang("plugins.autovv.target_private"))), status);
    assert.ok(status.includes(getLang("plugins.autovv.usage", config.PREFIX)), status);

    const usage = await run(".autovv sometimes");
    assert.ok(usage.includes(getLang("plugins.autovv.usage", config.PREFIX)), usage);
    assert.equal(config.AUTOVV_MODE, "p");
  });

  test("warns while the bot is declared as a web device, not once it is an Android one", async () => {
    assert.ok((await run(".autovv p")).includes(getLang("plugins.autovv.needs_android")));
    await settingsStore.set({ BAILEYS_DEVICE: "android" });
    assert.ok(!(await run(".autovv p")).includes(getLang("plugins.autovv.needs_android")));
    assert.ok(!(await run(".autovv")).includes(getLang("plugins.autovv.needs_android")));
  });
});
