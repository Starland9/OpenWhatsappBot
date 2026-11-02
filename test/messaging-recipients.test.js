"use strict";
/**
 * Feature 004 (messaging API): recipients (specs/004-messaging-api/contracts/runtime.md section 5).
 * Parsing and masking, the three policies, the fixed order of resolveRecipient (parse, policy, own number,
 * chat disabled), and the pick-step helpers the outbox uses (reachability, group posting, mentions).
 */

const { test, describe, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const recipients = require("../lib/messaging/recipients");
const { MessagingError } = require("../lib/messaging/errors");
const { LIMITS } = require("../lib/messaging/limits");
const permissions = require("../lib/utils/permissions");
const { parsePerson } = require("../lib/admin/services/permissions");

const PN = (digits) => `${digits}@s.whatsapp.net`;
const GROUP = "120363025246125486@g.us";
let db;

before(async () => {
  ({ db } = await fakes.setup());
});

beforeEach(async () => {
  recipients._reset();
  await db.KnownChat.destroy({ where: {}, truncate: true });
});

async function refusal(promise) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof MessagingError, `MessagingError expected, got ${err && err.name}: ${err && err.message}`);
    return err;
  }
  assert.fail("a refusal was expected");
}

describe("parseRecipient", () => {
  const NUMBERS = [
    ["237690000003", true],
    ["+237 6 90-00-00-03", true],
    ["00237690000003", true],
    ["(237) 690.000.003", true],
    ["1234567", false], // 7 digits
    ["1234567890123456", false], // 16 digits
    ["0690000003", false], // starts with 0
    ["abc", false],
    ["", false],
    ["   ", false],
  ];

  test("the feature 003 number cases, compared with parsePerson", () => {
    for (const [input, ok] of NUMBERS) {
      const parsed = recipients.parseRecipient(input);
      const person = parsePerson(input, permissions.normalizeJid);
      if (ok) {
        assert.equal(parsed.kind, "private", input);
        assert.equal(parsed.jid, person.pn, input);
        assert.equal(parsed.number, person.pn.split("@")[0], input);
        assert.equal(parsed.jid, PN("237690000003"));
      } else {
        assert.deepEqual(parsed, { error: "invalid_format" }, input);
        assert.ok(person.error, input);
      }
    }
  });

  test("a group id: ^\\d{5,25}(-\\d+)?@g\\.us$", () => {
    assert.deepEqual(recipients.parseRecipient(GROUP), { kind: "group", jid: GROUP, number: null });
    assert.deepEqual(recipients.parseRecipient("12036302-1234567@g.us"), { kind: "group", jid: "12036302-1234567@g.us", number: null });
    for (const bad of ["1234@g.us", "abc@g.us", "120363025246125486@G.US", "120363025246125486@g.us ", "x120363025246125486@g.us", `${"1".repeat(26)}@g.us`, "@g.us"]) {
      const parsed = recipients.parseRecipient(bad);
      // a trailing space is trimmed like any submitted string
      if (bad === "120363025246125486@g.us ") assert.equal(parsed.kind, "group");
      else assert.deepEqual(parsed, { error: "invalid_format" }, bad);
    }
  });

  test("a LID or an @s.whatsapp.net string is refused (RT-60); anything non-string too", () => {
    for (const bad of ["555@lid", PN("237690000003"), "237690000003@c.us", "a@b", null, undefined, 237690000003, {}, []]) {
      assert.deepEqual(recipients.parseRecipient(bad), { error: "invalid_format" });
    }
  });
});

describe("mask", () => {
  test("a private JID keeps the first 3 and the last 2 digits", () => {
    assert.equal(recipients.mask(PN("237690000003")), "237...03");
    assert.equal(recipients.mask(PN("12345678")), "123...78");
  });

  test("a group id keeps `group:` and its last 4 characters", () => {
    assert.equal(recipients.mask(GROUP), "group:5486");
  });

  test("anything else is `?` and never leaks", () => {
    for (const other of ["555@lid", "", null, undefined, 12, "not a jid", "status@broadcast"]) assert.equal(recipients.mask(other), "?");
    assert.doesNotMatch(recipients.mask(PN("237690000003")), /690000/);
  });
});

describe("evaluatePolicy", () => {
  const priv = { jid: PN("237690000003"), kind: "private", number: "237690000003" };
  const group = { jid: GROUP, kind: "group", number: null };

  test("anyone is always ok; no policy is ok", async () => {
    assert.deepEqual(await recipients.evaluatePolicy({ mode: "anyone", entries: [] }, priv), { ok: true });
    assert.deepEqual(await recipients.evaluatePolicy(null, priv), { ok: true });
  });

  test("list: the target JID must be an entry (PN or group id)", async () => {
    const policy = { mode: "list", entries: [PN("237690000003"), GROUP] };
    assert.equal((await recipients.evaluatePolicy(policy, priv)).ok, true);
    assert.equal((await recipients.evaluatePolicy(policy, group)).ok, true);
    assert.equal((await recipients.evaluatePolicy(policy, { ...priv, jid: PN("237690000004") })).ok, false);
    assert.equal((await recipients.evaluatePolicy({ mode: "list", entries: [] }, priv)).ok, false);
  });

  test("known: a KnownChat row by PN, by pnJid of a LID row; a group only while the bot has not left", async () => {
    const policy = { mode: "known", entries: [] };
    assert.equal((await recipients.evaluatePolicy(policy, priv)).ok, false, "unknown");

    await db.KnownChat.create({ jid: PN("237690000003"), kind: "private", firstSeenAt: new Date(), lastSeenAt: new Date() });
    assert.equal((await recipients.evaluatePolicy(policy, priv)).ok, true, "PN row");

    await db.KnownChat.create({ jid: "888@lid", kind: "private", pnJid: PN("237690000004"), firstSeenAt: new Date(), lastSeenAt: new Date() });
    assert.equal((await recipients.evaluatePolicy(policy, { ...priv, jid: PN("237690000004") })).ok, true, "LID row with pnJid");
    assert.equal((await recipients.evaluatePolicy(policy, { ...priv, jid: PN("237690000005") })).ok, false);

    assert.equal((await recipients.evaluatePolicy(policy, group)).ok, false, "unknown group");
    await db.KnownChat.create({ jid: GROUP, kind: "group", firstSeenAt: new Date(), lastSeenAt: new Date(), leftAt: new Date() });
    assert.equal((await recipients.evaluatePolicy(policy, group)).ok, false, "a left group");
    await db.KnownChat.update({ leftAt: null }, { where: { jid: GROUP } });
    assert.equal((await recipients.evaluatePolicy(policy, group)).ok, true, "a joined group");
  });

  test("an unknown mode fails closed", async () => {
    assert.equal((await recipients.evaluatePolicy({ mode: "everyone", entries: [] }, priv)).ok, false);
    assert.equal((await recipients.evaluatePolicy({ entries: [] }, priv)).ok, false);
  });
});

describe("isChatDisabled", () => {
  const priv = { jid: PN("237690000003"), kind: "private", number: "237690000003" };

  test("a banned PN", async () => {
    assert.equal(await recipients.isChatDisabled(priv, { bannedChats: new Set([priv.jid]) }), true);
    assert.equal(await recipients.isChatDisabled(priv, { bannedChats: new Set() }), false);
    assert.equal(await recipients.isChatDisabled({ jid: GROUP, kind: "group", number: null }, { bannedChats: new Set([GROUP]) }), true);
  });

  test("a banned LID mapped through KnownChat.pnJid", async () => {
    await db.KnownChat.create({ jid: "888@lid", kind: "private", pnJid: priv.jid, firstSeenAt: new Date(), lastSeenAt: new Date() });
    assert.equal(await recipients.isChatDisabled(priv, { bannedChats: new Set(["888@lid"]) }), true);
    assert.equal(await recipients.isChatDisabled(priv, { bannedChats: new Set(["999@lid"]) }), false);
  });

  test("the banned set may come from a function or a promise", async () => {
    assert.equal(await recipients.isChatDisabled(priv, { bannedChats: async () => new Set([priv.jid]) }), true);
    assert.equal(await recipients.isChatDisabled(priv, { bannedChats: Promise.resolve(new Set([priv.jid])) }), true);
  });
});

describe("resolveRecipient: the fixed order (a) parse, (b) policy, (c) own number, (d) chat disabled", () => {
  const BOT = "237690000099";
  const sock = fakes.fakeSocket({ botUser: { id: `${BOT}:3@s.whatsapp.net`, lid: "555:3@lid" } });

  test("a valid number gives the Target", async () => {
    const target = await recipients.resolveRecipient("+237 690 00 00 03", { policy: { mode: "anyone", entries: [] }, sock, bannedChats: new Set() });
    assert.deepEqual(target, { jid: PN("237690000003"), kind: "private", number: "237690000003" });
    const group = await recipients.resolveRecipient(GROUP, { policy: null, sock, bannedChats: new Set() });
    assert.deepEqual(group, { jid: GROUP, kind: "group", number: null });
  });

  test("(a) an unparsable `to` is validation_failed with fields.to = invalid_format, whatever the policy", async () => {
    const err = await refusal(recipients.resolveRecipient("abc", { policy: { mode: "list", entries: [] }, sock, bannedChats: new Set() }));
    assert.equal(err.code, "validation_failed");
    assert.deepEqual(err.fields, { to: { code: "invalid_format" } });
    assert.doesNotMatch(JSON.stringify(err), /abc/);
  });

  test("(b) outside the policy: recipient_not_allowed, never echoing the number", async () => {
    const err = await refusal(recipients.resolveRecipient("237690000003", { policy: { mode: "list", entries: [PN("237690000004")] }, sock, bannedChats: new Set() }));
    assert.equal(err.code, "recipient_not_allowed");
    assert.equal(err.fields, undefined);
    assert.doesNotMatch(JSON.stringify({ ...err, message: err.message }), /690000/);
  });

  test("(c) the bot's own number is fields.to = not_allowed, AFTER the policy", async () => {
        const err = await refusal(recipients.resolveRecipient(BOT, { policy: { mode: "anyone", entries: [] }, sock, bannedChats: new Set() }));
    assert.equal(err.code, "validation_failed");
    assert.deepEqual(err.fields, { to: { code: "not_allowed" } });
    // a restricted key learns nothing: the policy answers first
    const restricted = await refusal(recipients.resolveRecipient(BOT, { policy: { mode: "list", entries: [PN("237690000004")] }, sock, bannedChats: new Set() }));
    assert.equal(restricted.code, "recipient_not_allowed");
  });

  test("(c) is skipped, not failed, when no identity has ever been seen", async () => {
    const target = await recipients.resolveRecipient(BOT, { policy: null, sock: null, bannedChats: new Set() });
    assert.equal(target.jid, PN(BOT));
  });

  test("(c) the last identity seen is kept in this process", async () => {
    await recipients.resolveRecipient("237690000003", { policy: null, sock, bannedChats: new Set() }); // learns the bot identity
    const err = await refusal(recipients.resolveRecipient(BOT, { policy: null, sock: null, bannedChats: new Set() }));
    assert.deepEqual(err.fields, { to: { code: "not_allowed" } });
    assert.equal(recipients.getBotJids(null).pn, PN(BOT));
  });

  test("(c) the socket may be given as an accessor", async () => {
    const err = await refusal(recipients.resolveRecipient(BOT, { policy: null, sock: () => sock, bannedChats: new Set() }));
    assert.deepEqual(err.fields, { to: { code: "not_allowed" } });
  });

  test("(d) a disabled chat: chat_disabled, after the own-number check; a banned LID counts", async () => {
    const err = await refusal(recipients.resolveRecipient("237690000003", { policy: null, sock, bannedChats: new Set([PN("237690000003")]) }));
    assert.equal(err.code, "chat_disabled");
    await db.KnownChat.create({ jid: "888@lid", kind: "private", pnJid: PN("237690000004"), firstSeenAt: new Date(), lastSeenAt: new Date() });
    const viaLid = await refusal(recipients.resolveRecipient("237690000004", { policy: null, sock, bannedChats: new Set(["888@lid"]) }));
    assert.equal(viaLid.code, "chat_disabled");
    const own = await refusal(recipients.resolveRecipient(BOT, { policy: null, sock, bannedChats: new Set([PN(BOT)]) }));
    assert.equal(own.code, "validation_failed", "own number answers before chat_disabled");
  });

  test("policy null means no policy (RT-61)", async () => {
    const target = await recipients.resolveRecipient("237690000009", { policy: null, sock, bannedChats: new Set() });
    assert.equal(target.kind, "private");
  });
});

describe("verifyReachable (FR-040)", () => {
  const priv = { jid: PN("237690000003"), kind: "private", number: "237690000003" };
  const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);

  test("groups and known chats are skipped: no lookup", async () => {
    const sock = fakes.fakeSocket({ onWhatsApp: () => assert.fail("no lookup expected") });
    assert.deepEqual(await recipients.verifyReachable(sock, { jid: GROUP, kind: "group", number: null }, { now: T0 }), { jid: GROUP, skipped: true });
    await db.KnownChat.create({ jid: priv.jid, kind: "private", firstSeenAt: new Date(), lastSeenAt: new Date() });
    assert.deepEqual(await recipients.verifyReachable(sock, priv, { now: T0 }), { jid: priv.jid, skipped: true });
  });

  test("an existing number resolves to the destination JID WhatsApp returns", async () => {
    const calls = [];
    const sock = fakes.fakeSocket({
      onWhatsApp: async (...jids) => {
        calls.push(jids);
        return [{ jid: PN("2376900000030"), exists: true }];
      },
    });
    const res = await recipients.verifyReachable(sock, priv, { now: T0 });
    assert.deepEqual(res, { jid: PN("2376900000030") });
    assert.deepEqual(calls, [[priv.jid]]);
  });

  test("an answer that is not an @s.whatsapp.net JID keeps the requested form", async () => {
    const sock = fakes.fakeSocket({ onWhatsApp: async () => [{ jid: "1@lid", exists: true }] });
    assert.deepEqual(await recipients.verifyReachable(sock, priv, { now: T0 }), { jid: priv.jid });
  });

  test("an empty answer or exists !== true is not_on_whatsapp", async () => {
    for (const answer of [[], [{ jid: priv.jid, exists: false }], [{ jid: priv.jid }], [{ jid: priv.jid, exists: "true" }]]) {
      recipients._reset();
      const sock = fakes.fakeSocket({ onWhatsApp: async () => answer });
      assert.deepEqual(await recipients.verifyReachable(sock, priv, { now: T0 }), { failure: "not_on_whatsapp" });
    }
  });

  test("a thrown error or an undefined answer propagates (transient)", async () => {
    const boom = new Error("socket closed");
    await assert.rejects(recipients.verifyReachable(fakes.fakeSocket({ onWhatsApp: async () => { throw boom; } }), priv, { now: T0 }), /socket closed/);
    recipients._reset();
    await assert.rejects(recipients.verifyReachable(fakes.fakeSocket({ onWhatsApp: async () => undefined }), priv, { now: T0 }));
  });

  test("a lookup that never answers times out after VERIFY_TIMEOUT_MS (propagates)", async () => {
    const sock = fakes.fakeSocket({ onWhatsApp: () => new Promise(() => {}) });
    const started = Date.now();
    await assert.rejects(recipients.verifyReachable(sock, priv, { now: T0, timeoutMs: 40 }), (err) => err.code === "ETIMEDOUT");
    assert.ok(Date.now() - started < 2000);
    assert.equal(LIMITS.VERIFY_TIMEOUT_MS, 10000);
  });

  test("cache: positive 24 h, negative 10 min, 1000 entries", async () => {
    let count = 0;
    let exists = true;
    const sock = fakes.fakeSocket({
      onWhatsApp: async (jid) => {
        count++;
        return [{ jid, exists }];
      },
    });
    await recipients.verifyReachable(sock, priv, { now: T0 });
    await recipients.verifyReachable(sock, priv, { now: T0 + 23 * 3600 * 1000 });
    assert.equal(count, 1, "positive answer cached for 24 h");
    await recipients.verifyReachable(sock, priv, { now: T0 + 25 * 3600 * 1000 });
    assert.equal(count, 2, "and looked up again after");

    recipients._reset();
    exists = false;
    count = 0;
    assert.equal((await recipients.verifyReachable(sock, priv, { now: T0 })).failure, "not_on_whatsapp");
    assert.equal((await recipients.verifyReachable(sock, priv, { now: T0 + 9 * 60 * 1000 })).failure, "not_on_whatsapp");
    assert.equal(count, 1, "negative answer cached for 10 min");
    exists = true;
    assert.equal((await recipients.verifyReachable(sock, priv, { now: T0 + 11 * 60 * 1000 })).jid, priv.jid);
    assert.equal(count, 2);

    recipients._reset();
    count = 0;
    for (let i = 0; i < 1005; i++) {
      await recipients.verifyReachable(sock, { jid: PN(String(237700000000 + i)), kind: "private", number: null }, { now: T0 });
    }
    assert.ok(recipients._cacheSize() <= LIMITS.ONWHATSAPP_CACHE_MAX);
  });
});

describe("verifyGroupPosting", () => {
  const target = { jid: GROUP, kind: "group", number: null };

  test("a member of an open group: { metadata }", async () => {
    const sock = fakes.fakeSocket();
    const res = await recipients.verifyGroupPosting(sock, target);
    assert.equal(res.failure, undefined);
    assert.equal(res.metadata.id, GROUP);
  });

  test("a Boom 403 or 404 is not_in_group", async () => {
    for (const statusCode of [403, 404]) {
      const err = Object.assign(new Error("forbidden"), { output: { statusCode } });
      const sock = fakes.fakeSocket({ groupMetadataError: err });
      assert.deepEqual(await recipients.verifyGroupPosting(sock, target), { failure: "not_in_group" });
    }
  });

  test("announce-only with the bot not an admin is group_announce_only; an admin bot may post", async () => {
    const closed = fakes.fakeSocket({ announce: true, botAdmin: false });
    assert.deepEqual(await recipients.verifyGroupPosting(closed, target), { failure: "group_announce_only" });
    const admin = fakes.fakeSocket({ announce: true, botAdmin: true });
    const res = await recipients.verifyGroupPosting(admin, target);
    assert.ok(res.metadata);
  });

  test("a timeout or a connection error propagates (transient)", async () => {
    const sock = fakes.fakeSocket({ groupMetadataError: Object.assign(new Error("Connection Closed"), { output: { statusCode: 428 } }) });
    await assert.rejects(recipients.verifyGroupPosting(sock, target), /Connection Closed/);
    const hanging = fakes.fakeSocket();
    hanging.groupMetadata = () => new Promise(() => {});
    await assert.rejects(recipients.verifyGroupPosting(hanging, target, { timeoutMs: 40 }), (err) => err.code === "ETIMEDOUT");
  });
});

describe("mentionJids (3.9)", () => {
  const metadata = {
    id: GROUP,
    participants: [
      { id: PN("237690000010") },
      { id: "888777@lid", phoneNumber: PN("237690000011"), lid: "888777@lid" },
      { id: PN("237690000012"), admin: "admin" },
    ],
  };

  test("a PN group member gives p.id (the PN); a member of a LID group gives its LID", () => {
    assert.deepEqual(recipients.mentionJids(metadata, ["237690000010", "237690000011"]), [
      { number: "237690000010", jid: PN("237690000010") },
      { number: "237690000011", jid: "888777@lid" },
    ]);
  });

  test("a non-member and a malformed number are ignored; duplicates collapse", () => {
    assert.deepEqual(recipients.mentionJids(metadata, ["237690000012", "237690000012", "237690000099", "not a number", "123"]), [
      { number: "237690000012", jid: PN("237690000012") },
    ]);
  });

  test("numbers are parsed with the rules of `to`", () => {
    assert.deepEqual(recipients.mentionJids(metadata, ["+237 690 00 00 10", "00237690000012"]), [
      { number: "237690000010", jid: PN("237690000010") },
      { number: "237690000012", jid: PN("237690000012") },
    ]);
  });

  test("no metadata, no participants, no numbers: nothing", () => {
    assert.deepEqual(recipients.mentionJids(null, ["237690000010"]), []);
    assert.deepEqual(recipients.mentionJids({ participants: [] }, ["237690000010"]), []);
    assert.deepEqual(recipients.mentionJids(metadata, []), []);
    assert.deepEqual(recipients.mentionJids(metadata, null), []);
  });
});
