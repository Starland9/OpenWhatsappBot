"use strict";
/**
 * lib/classes/Message.js exports `findParticipant` and `isAdminParticipant` (feature 004, contracts/runtime.md
 * section 14.3): the messaging engine needs them for the "bot is a group admin" and "announce-only" checks without
 * a Message. No behaviour change: `isBotAdmin()` and `isSenderAdmin()` give the same answers as the two helpers
 * applied to the same group metadata.
 *
 * Fake group metadata with phone-number (PN) and LID participants; no database, no network.
 */

const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

const { IDS } = fakes;
fakes.setupEnv({ sudo: "111" });

const MessageModule = require("../lib/classes/Message");
const { findParticipant, isAdminParticipant } = MessageModule;
const { getBotJids } = require("../lib/utils/permissions");

before(async () => {
  await fakes.syncDb();
});

/** Group metadata in the two shapes Baileys 7 produces: a LID-addressed group and a legacy PN-only one. */
const METADATA = {
  id: IDS.GROUP,
  participants: [
    { id: "555@lid", phoneNumber: "999@s.whatsapp.net", lid: "555@lid", admin: "admin" }, // the bot
    { id: "777@lid", phoneNumber: "111@s.whatsapp.net", lid: "777@lid", admin: "superadmin" },
    { id: "888@lid", phoneNumber: "333@s.whatsapp.net", lid: "888@lid", admin: null },
    { id: "444@s.whatsapp.net", admin: null }, // PN-only
    { id: "666@s.whatsapp.net", admin: "admin" }, // PN-only admin
    { id: "222@s.whatsapp.net", isAdmin: true },
    { id: "123@s.whatsapp.net", isSuperAdmin: true },
  ],
};

describe("exports", () => {
  test("Message.js exports the two helpers next to the existing names", () => {
    assert.equal(typeof findParticipant, "function");
    assert.equal(typeof isAdminParticipant, "function");
    for (const name of ["Message", "invalidateGroupMetadata", "sniffAudioMime"]) {
      assert.equal(typeof MessageModule[name], "function", `${name} is still exported`);
    }
  });
});

describe("findParticipant", () => {
  test("matches a participant by any of its forms (id, phoneNumber, lid), device suffix ignored", () => {
    assert.equal(findParticipant(METADATA, ["333@s.whatsapp.net"]).id, "888@lid");
    assert.equal(findParticipant(METADATA, ["888@lid"]).id, "888@lid");
    assert.equal(findParticipant(METADATA, ["333:12@s.whatsapp.net"]).id, "888@lid");
    assert.equal(findParticipant(METADATA, ["444@s.whatsapp.net"]).id, "444@s.whatsapp.net");
    assert.equal(findParticipant(METADATA, ["333@c.us"]).id, "888@lid", "c.us is normalised");
  });

  test("the first form that matches wins, the others are tried in turn", () => {
    assert.equal(findParticipant(METADATA, ["nobody@s.whatsapp.net", "777@lid"]).phoneNumber, "111@s.whatsapp.net");
    assert.equal(findParticipant(METADATA, [null, undefined, "", "999@s.whatsapp.net"]).id, "555@lid");
  });

  test("nothing matches: null, never a throw", () => {
    assert.equal(findParticipant(METADATA, ["555555@s.whatsapp.net"]), null);
    assert.equal(findParticipant(METADATA, []), null);
    assert.equal(findParticipant(METADATA, [null, undefined, ""]), null);
    assert.equal(findParticipant(null, ["333@s.whatsapp.net"]), null);
    assert.equal(findParticipant({}, ["333@s.whatsapp.net"]), null);
    assert.equal(findParticipant({ participants: null }, ["333@s.whatsapp.net"]), null);
  });
});

describe("isAdminParticipant", () => {
  test("admin, superadmin and the two boolean flags count", () => {
    assert.equal(isAdminParticipant({ id: "a", admin: "admin" }), true);
    assert.equal(isAdminParticipant({ id: "a", admin: "superadmin" }), true);
    assert.equal(isAdminParticipant({ id: "a", isAdmin: true }), true);
    assert.equal(isAdminParticipant({ id: "a", isSuperAdmin: true }), true);
  });

  test("a plain member, a null role and a missing participant do not", () => {
    assert.equal(isAdminParticipant({ id: "a", admin: null }), false);
    assert.equal(isAdminParticipant({ id: "a" }), false);
    assert.equal(isAdminParticipant({ id: "a", admin: "member" }), false);
    assert.equal(isAdminParticipant({ id: "a", isAdmin: "yes" }), false, "only a real boolean true");
    assert.equal(isAdminParticipant(null), false);
    assert.equal(isAdminParticipant(undefined), false);
  });
});

describe("the helpers give the results isBotAdmin / isSenderAdmin rely on", () => {
  function groupMessage({ from, lid = false, botAdmin = true, participants }) {
    const sock = fakes.fakeSocket({ participants: participants || METADATA.participants.map((p) => ({ ...p })), botAdmin });
    return fakes.makeMessage({ body: ".x", from, lid, group: true, sock });
  }

  test("isBotAdmin equals isAdminParticipant(findParticipant(metadata, [bot.pn, bot.lid]))", async () => {
    for (const botRole of ["admin", null]) {
      const participants = METADATA.participants.map((p) => (p.phoneNumber === "999@s.whatsapp.net" ? { ...p, admin: botRole } : { ...p }));
      const message = groupMessage({ from: IDS.MEMBER_PN, participants });
      MessageModule.invalidateGroupMetadata();
      const metadata = await message.client.getSocket().groupMetadata(IDS.GROUP);
      const bot = getBotJids(message.client.getSocket());
      const expected = isAdminParticipant(findParticipant(metadata, [bot.pn, bot.lid]));
      assert.equal(expected, botRole === "admin");
      assert.equal(await message.isBotAdmin(), expected, `bot role ${botRole}`);
    }
  });

  test("isSenderAdmin equals the helpers on a PN sender, a LID sender and a PN-only sender", async () => {
    const cases = [
      { from: "111@s.whatsapp.net", lid: false, admin: true }, // PN form of a LID-addressed superadmin
      { from: "111@s.whatsapp.net", lid: true, admin: true }, // the same person writing as LID
      { from: "333@s.whatsapp.net", lid: false, admin: false },
      { from: "333@s.whatsapp.net", lid: true, admin: false },
      { from: "444@s.whatsapp.net", lid: false, admin: false },
      { from: "666@s.whatsapp.net", lid: false, admin: true },
    ];
    for (const { from, lid, admin } of cases) {
      MessageModule.invalidateGroupMetadata();
      const message = groupMessage({ from, lid });
      const metadata = await message.client.getSocket().groupMetadata(IDS.GROUP);
      const expected = isAdminParticipant(findParticipant(metadata, [message.sender, message.senderLid]));
      assert.equal(expected, admin, `helpers: ${from} lid=${lid}`);
      assert.equal(await message.isSenderAdmin(), expected, `isSenderAdmin: ${from} lid=${lid}`);
    }
  });

  test("a private chat is never an admin (isBotAdmin / isSenderAdmin short-circuit before the helpers)", async () => {
    const message = fakes.makeMessage({ body: ".x", from: IDS.OWNER_PN });
    assert.equal(await message.isBotAdmin(), false);
    assert.equal(await message.isSenderAdmin(), false);
  });
});
