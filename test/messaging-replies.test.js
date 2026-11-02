"use strict";
/**
 * Reply capture of the messaging API (feature 004, contracts/runtime.md section 7, data-model.md 3.2, FR-072, RT-80 to
 * RT-82): `plugins/apireplies.js` (hook-only, priorities 5 and 6) over `lib/messaging/replies.js`.
 *
 * Part 1: poll votes and the responses object. Real pipeline, real plugin, real facade over the in-memory database, a
 * fake socket; votes are built with the INVERSE of Baileys' `decryptPollVote` (same key derivation, AES-GCM encrypt),
 * from the `messageSecret` the engine really sent. Part 2 (buttons and lists) is appended in Phase 8.
 */

const { test, describe, before, after, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fakes = require("./helpers/fakes");

const { IDS } = fakes;
fakes.setupEnv({ sudo: "111" });

const { createEngineKit } = require("./helpers/messagingKit");
const { assertMessageInvariants } = require("./helpers/apiInvariants");
const config = require("../config");
const secretBox = require("../lib/utils/secretBox");
const apiState = require("../lib/utils/apiState");
const registry = require("../lib/plugins/registry");
const pipeline = require("../lib/core/pipeline");
const replies = require("../lib/messaging/replies");
const baileys = require("baileys");

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const VOTER = "237690000001";
const VOTER_PN = `${VOTER}@s.whatsapp.net`;
const VOTER_LID = "99999999999999@lid";
const OTHER_PN = "237690000002@s.whatsapp.net";
const GROUP = IDS.GROUP;

let tmp;
let originalPanel;
let kit;
let key;
let seen; // what reached the lowest-priority hooks of the pipeline

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-replies-"));
  secretBox.configure({ dir: path.join(tmp, "data") });
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  originalPanel = config.ADMIN_PANEL;
  config.ADMIN_PANEL = true;
  // no pacing between the polls of one test: the gate is not what is under test here
  const openGate = { ready: () => true, reserve() {}, seed() {}, waitMs: () => 0, lastSendAt: () => null };
  kit = await createEngineKit({ realTime: true, deps: { apiState, secretBox, gate: openGate }, sockOptions: { botUser: { id: "999:3@s.whatsapp.net", lid: "555:3@lid", name: "Bot" } } });
  key = await kit.key();
  await apiState.load({ models: kit.db });
  await apiState.setEnabled(true);
  await kit.start();

  seen = [];
  registry._reset();
  registry.registerPlugin(require("../plugins/apireplies"), "apireplies.js");
  registry.registerPlugin(
    {
      async onMessage(message) {
        seen.push(["onMessage", message.type, message.body]);
        return false;
      },
      async handleButtonReply(message) {
        seen.push(["handleButtonReply", message.body]);
        return false;
      },
    },
    "zz-probe.js",
  );
  pipeline.attachHandlers(kit.client);
});

afterEach(async () => {
  for (const row of await kit.db.ApiMessage.findAll()) assertMessageInvariants(row, { pendingMedia: true });
  await kit.close();
  config.ADMIN_PANEL = originalPanel;
  await kit.db.ApiState.destroy({ where: {} });
  await apiState.load({ models: kit.db });
  registry._reset();
  mock.restoreAll();
});

// ---------------------------------------------------------------------------------------------------------------------
// Polls and votes
// ---------------------------------------------------------------------------------------------------------------------

const digest = (option) => crypto.createHash("sha256").update(Buffer.from(option, "utf8")).digest();

/** The engine sends a poll; returns its row and the 32-byte secret WhatsApp got */
async function sendPoll({ options = ["Tuesday", "Thursday", "Saturday"], multiple = false, to = "237690000001", question = "Which day?" } = {}) {
  const { message } = await kit.send({ apiKeyId: key.id, to, format: "poll", fields: { question, options, multiple } });
  await kit.messaging.tick(Date.now());
  const row = await kit.row(message.publicId);
  assert.equal(row.status, "sent");
  const sent = kit.sock.sent.filter((s) => s.content.poll).at(-1);
  return { row, secret: Buffer.from(sent.content.poll.messageSecret), options };
}

/** The inverse of baileys' decryptPollVote */
function encryptVote({ options, selected, secret, waId, creatorJid, voterJid }) {
  const sign = Buffer.concat([Buffer.from(waId), Buffer.from(creatorJid), Buffer.from(voterJid), Buffer.from("Poll Vote"), Buffer.from([1])]);
  const key0 = baileys.hmacSign(secret, Buffer.alloc(32), "sha256");
  const decKey = baileys.hmacSign(sign, key0, "sha256");
  const iv = crypto.randomBytes(12);
  const plain = baileys.proto.Message.PollVoteMessage.encode({ selectedOptions: selected.map((i) => digest(options[i])) }).finish();
  return { encPayload: baileys.aesEncryptGCM(plain, decKey, iv, Buffer.from(`${waId}\u0000${voterJid}`)), encIv: iv };
}

/**
 * A vote as the pipeline receives it. Defaults: a private chat addressed by phone number, the creator and the voter
 * named by phone number in the signature.
 */
function vote({ row, secret, options, selected, from = VOTER_PN, lid, group, id, at = Date.now(), creatorJid = IDS.BOT_PN, voterJid, alt, raw = {} }) {
  const signedAs = voterJid || (lid ? (typeof lid === "string" ? lid : VOTER_LID) : from);
  const voteBody = encryptVote({ options, selected, secret, waId: row.waId, creatorJid, voterJid: signedAs });
  return fakes.rawMessage({
    from,
    lid,
    group,
    alt,
    id: id || `VOTE${++voteSeq}`,
    message: {
      pollUpdateMessage: {
        pollCreationMessageKey: { remoteJid: group || from, fromMe: true, id: row.waId },
        vote: voteBody,
        senderTimestampMs: at,
      },
    },
    ...raw,
  });
}
let voteSeq = 0;

const deliver = async (raw) => {
  seen.length = 0;
  await kit.client.dispatch("messages", [raw], "notify");
  await fakes.sleep(5);
};
const responsesOf = (row) => kit.db.ApiMessageResponse.findAll({ where: { messageId: row.id }, order: [["id", "ASC"]] });
const reached = () => seen.some(([hook]) => hook === "onMessage");

describe("a vote on one of our polls (7.3, X19)", () => {
  test("it is decrypted, recorded under the recipient, consumed, and never reaches another hook", async () => {
    const poll = await sendPoll();
    await deliver(vote({ ...poll, selected: [1], id: "V-ONE", at: Date.now() }));
    const [row] = await responsesOf(poll.row);
    assert.deepEqual([row.kind, row.author, row.voterKey, row.choiceIds, row.via, row.sourceId], ["vote", VOTER_PN, VOTER_PN, ["1"], null, "V-ONE"]);
    assert.equal(reached(), false, "the vote is consumed: trackmessages and the rest never see it");
  });

  test("a multiple-answer poll records the selection in option order", async () => {
    const poll = await sendPoll({ multiple: true });
    await deliver(vote({ ...poll, selected: [2, 0], id: "V-MULTI" }));
    assert.deepEqual((await responsesOf(poll.row))[0].choiceIds, ["0", "2"]);
  });

  test("the latest vote replaces the earlier one: one row per voter, a cleared vote is an empty selection", async () => {
    const poll = await sendPoll();
    const t = Date.now();
    await deliver(vote({ ...poll, selected: [0], id: "V1", at: t }));
    await deliver(vote({ ...poll, selected: [1, 2], id: "V2", at: t + 5 * SEC }));
    let rows = await responsesOf(poll.row);
    assert.deepEqual([rows.length, rows[0].choiceIds, rows[0].sourceId], [1, ["1", "2"], "V2"]);
    await deliver(vote({ ...poll, selected: [], id: "V3", at: t + 10 * SEC }));
    rows = await responsesOf(poll.row);
    assert.deepEqual([rows.length, rows[0].choiceIds, rows[0].sourceId], [1, [], "V3"]);
  });

  test("a stale redelivery never overwrites a newer vote, and the same vote twice is harmless", async () => {
    const poll = await sendPoll();
    const t = Date.now();
    await deliver(vote({ ...poll, selected: [2], id: "NEW", at: t + 30 * SEC }));
    await deliver(vote({ ...poll, selected: [0], id: "OLD", at: t }));
    let rows = await responsesOf(poll.row);
    assert.deepEqual([rows.length, rows[0].choiceIds, rows[0].sourceId], [1, ["2"], "NEW"]);
    await deliver(vote({ ...poll, selected: [2], id: "NEW", at: t + 30 * SEC }));
    rows = await responsesOf(poll.row);
    assert.equal(rows.length, 1);
  });

  test("two voters in a group are two rows; the author is the participant's phone number", async () => {
    const poll = await sendPoll({ to: GROUP });
    await deliver(vote({ ...poll, selected: [0], from: IDS.MEMBER_PN, group: GROUP, id: "G1", voterJid: IDS.MEMBER_PN }));
    await deliver(vote({ ...poll, selected: [1], from: IDS.MEMBER2_PN, group: GROUP, id: "G2", voterJid: IDS.MEMBER2_PN }));
    const rows = await responsesOf(poll.row);
    assert.deepEqual(rows.map((r) => [r.author, r.choiceIds]), [[IDS.MEMBER_PN, ["0"]], [IDS.MEMBER2_PN, ["1"]]]);
  });

  test("a group voter known by LID only is recorded under the LID", async () => {
    const poll = await sendPoll({ to: GROUP });
    await deliver(vote({ ...poll, selected: [1], from: IDS.MEMBER_LID, alt: null, group: GROUP, id: "G-LID", voterJid: IDS.MEMBER_LID }));
    assert.deepEqual((await responsesOf(poll.row)).map((r) => r.author), [IDS.MEMBER_LID]);
  });

  test("in a private chat the author is forced to the recipient whatever form WhatsApp reports (LID chat)", async () => {
    const poll = await sendPoll();
    await deliver(vote({ ...poll, selected: [0], from: VOTER_PN, lid: VOTER_LID, id: "L1", creatorJid: IDS.BOT_LID }));
    await deliver(vote({ ...poll, selected: [2], id: "L2", at: Date.now() + 5 * SEC }));
    const rows = await responsesOf(poll.row);
    assert.deepEqual([rows.length, rows[0].author, rows[0].voterKey, rows[0].choiceIds], [1, VOTER_PN, VOTER_PN, ["2"]], "a LID voter and a PN voter are one person");

    // WhatsApp reports only the LID: still the recipient, still the same row
    await deliver(vote({ ...poll, selected: [1], from: VOTER_LID, alt: null, id: "L3", voterJid: VOTER_LID, creatorJid: IDS.BOT_LID, at: Date.now() + 10 * SEC }));
    const again = await responsesOf(poll.row);
    assert.deepEqual([again.length, again[0].author, again[0].choiceIds], [1, VOTER_PN, ["1"]]);
  });

  test("the voter forms are tried in turn: creator PN or LID, voter participant, alt, remoteJid, remoteJidAlt", async () => {
    const poll = await sendPoll();
    // LID-addressed chat: the vote was signed with the LID of the creator and of the voter
    await deliver(vote({ ...poll, selected: [1], from: VOTER_PN, lid: VOTER_LID, id: "F1", creatorJid: IDS.BOT_LID, voterJid: VOTER_LID }));
    assert.equal((await responsesOf(poll.row)).length, 1);
    // signed with the creator's LID but the voter's phone number
    await deliver(vote({ ...poll, selected: [2], from: VOTER_PN, lid: VOTER_LID, id: "F2", creatorJid: IDS.BOT_LID, voterJid: VOTER_PN, at: Date.now() + 5 * SEC }));
    assert.deepEqual((await responsesOf(poll.row))[0].choiceIds, ["2"]);
  });

  test("an unreadable or lost pollSecret, a vote that no pair decrypts, and a damaged payload are consumed and not recorded, never an error", async () => {
    const poll = await sendPoll();
    await kit.db.ApiMessage.update({ pollSecret: "enc:v1:not:a:secret" }, { where: { id: poll.row.id } });
    await deliver(vote({ ...poll, selected: [1], id: "BAD-SECRET" }));
    assert.equal((await responsesOf(poll.row)).length, 0);
    assert.equal(reached(), false, "still consumed: nothing else may react to a vote on our poll");

    const other = await sendPoll();
    await deliver(vote({ ...other, selected: [1], id: "WRONG-KEY", secret: crypto.randomBytes(32) }));
    assert.equal((await responsesOf(other.row)).length, 0);
    const damaged = vote({ ...other, selected: [1], id: "DAMAGED" });
    damaged.message.pollUpdateMessage.vote = { encPayload: Buffer.from("xx"), encIv: Buffer.alloc(12) };
    await assert.doesNotReject(() => deliver(damaged));
    assert.equal((await responsesOf(other.row)).length, 0);
    const missing = vote({ ...other, selected: [1], id: "NO-VOTE" });
    delete missing.message.pollUpdateMessage.vote;
    await assert.doesNotReject(() => deliver(missing));
  });

  test("an expired replyData (the housekeeping nulled it) records nothing", async () => {
    const poll = await sendPoll();
    await kit.db.ApiMessage.update({ replyData: null }, { where: { id: poll.row.id } });
    await deliver(vote({ ...poll, selected: [1], id: "NO-DATA" }));
    assert.equal((await responsesOf(poll.row)).length, 0);
    assert.equal(reached(), false);
  });

  test("a vote on a poll that is not ours (unknown id) is not consumed and reaches the next hooks", async () => {
    const poll = await sendPoll();
    const foreign = vote({ ...poll, row: { ...poll.row.get({ plain: true }), waId: "3EB0SOMEONEELSESPOLL01" }, selected: [1], id: "FOREIGN" });
    await deliver(foreign);
    assert.equal(reached(), true);
    assert.equal(await kit.db.ApiMessageResponse.count(), 0);
  });

  test("with the switch off the vote is consumed and not recorded", async () => {
    const poll = await sendPoll();
    await apiState.setEnabled(false);
    await deliver(vote({ ...poll, selected: [1], id: "OFF" }));
    assert.equal(await kit.db.ApiMessageResponse.count(), 0);
    assert.equal(reached(), false);
  });

  test("after repliesUntil the vote is consumed and not recorded", async () => {
    const poll = await sendPoll();
    await kit.db.ApiMessage.update({ repliesUntil: new Date(Date.now() - SEC) }, { where: { id: poll.row.id } });
    await deliver(vote({ ...poll, selected: [1], id: "LATE" }));
    assert.equal(await kit.db.ApiMessageResponse.count(), 0);
    assert.equal(reached(), false);
  });

  test("a message holds at most 1000 responses: the extra voter is consumed and not recorded", async () => {
    const poll = await sendPoll({ to: GROUP });
    await kit.db.ApiMessageResponse.bulkCreate(
      Array.from({ length: 1000 }, (_, i) => ({ messageId: poll.row.id, kind: "vote", author: `2376${String(i).padStart(8, "0")}@s.whatsapp.net`, voterKey: `2376${String(i).padStart(8, "0")}@s.whatsapp.net`, choiceIds: ["0"], sourceId: `bulk-${i}`, respondedAt: new Date() })),
    );
    await deliver(vote({ ...poll, selected: [1], from: IDS.MEMBER_PN, group: GROUP, id: "OVER", voterJid: IDS.MEMBER_PN }));
    assert.equal(await kit.db.ApiMessageResponse.count({ where: { messageId: poll.row.id } }), 1000);
    assert.equal(reached(), false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// describeResponses (7.5, public-api 4.4)
// ---------------------------------------------------------------------------------------------------------------------

describe("describeResponses: the responses object of public-api.md 4.4", () => {
  test("a poll: items oldest first with labels, a replaced vote once, a cleared vote as an empty item, totals with zero counts", async () => {
    const poll = await sendPoll({ options: ["Tuesday", "Thursday", "Saturday"], to: GROUP });
    const t = Date.now();
    await deliver(vote({ ...poll, selected: [1], from: IDS.MEMBER_PN, group: GROUP, id: "A1", voterJid: IDS.MEMBER_PN, at: t }));
    await deliver(vote({ ...poll, selected: [0, 2], from: IDS.MEMBER2_PN, group: GROUP, id: "B1", voterJid: IDS.MEMBER2_PN, at: t + SEC }));
    await deliver(vote({ ...poll, selected: [], from: IDS.MEMBER_LID, alt: null, group: GROUP, id: "C1", voterJid: IDS.MEMBER_LID, at: t + 2 * SEC }));
    await deliver(vote({ ...poll, selected: [2], from: IDS.MEMBER_PN, group: GROUP, id: "A2", voterJid: IDS.MEMBER_PN, at: t + 3 * SEC }));

    const row = await kit.row(poll.row.publicId);
    const described = kit.messaging.describeResponses(row, await responsesOf(row));
    assert.deepEqual(Object.keys(described).sort(), ["items", "total", "totals", "until"]);
    assert.equal(described.until, row.repliesUntil.toISOString());
    assert.equal(described.total, 3);
    assert.deepEqual(
      described.items.map((i) => [i.author, i.kind, i.via, i.choices.map((c) => c.label)]),
      [
        ["444", "vote", null, ["Tuesday", "Saturday"]], // oldest first by the time of the reply (a replaced vote carries its latest)
        ["888@lid", "vote", null, []],
        ["333", "vote", null, ["Saturday"]],
      ],
    );
    assert.deepEqual(described.items[2].choices, [{ id: "2", label: "Saturday" }]);
    assert.ok(described.items.every((i) => /^\d{4}-\d\d-\d\dT.*Z$/.test(i.at)));
    assert.deepEqual(described.totals, [
      { id: "0", label: "Tuesday", count: 1 },
      { id: "1", label: "Thursday", count: 0 },
      { id: "2", label: "Saturday", count: 2 },
    ]);
  });

  test("until is null before the message left; non-interactive formats have no responses at all", async () => {
    const { message } = await kit.send({ apiKeyId: key.id, format: "poll", fields: { question: "Q", options: ["a", "b"] } });
    const queued = await kit.row(message.publicId);
    assert.deepEqual(kit.messaging.describeResponses(queued, []), { until: null, total: 0, items: [], totals: null }, "no labels yet: no totals before the claim");
    const text = await kit.send({ apiKeyId: key.id, fields: { text: "hi" } });
    assert.equal(kit.messaging.describeResponses(await kit.row(text.message.publicId), []), null);
  });

  test("get() returns it for an interactive message of the key, null for the others; list() never does", async () => {
    const poll = await sendPoll();
    await deliver(vote({ ...poll, selected: [1], id: "GET1" }));
    const view = await kit.messaging.get({ apiKeyId: key.id, publicId: poll.row.publicId });
    assert.equal(view.responses.total, 1);
    assert.deepEqual(view.responses.totals.map((t) => t.count), [0, 1, 0]);
    assert.equal((await kit.messaging.get({ apiKeyId: key.id, publicId: poll.row.publicId }, { responses: false })).responses, null);
    const text = await kit.send({ apiKeyId: key.id, fields: { text: "plain" } });
    assert.equal((await kit.messaging.get({ apiKeyId: key.id, publicId: text.message.publicId })).responses, null);
    assert.ok((await kit.messaging.list({ apiKeyId: key.id })).items.every((i) => i.responses === null));
  });

  test("authorLabel: a phone number is its digits, a LID is <digits>@lid", () => {
    assert.equal(replies.authorLabel("237690000001@s.whatsapp.net"), "237690000001");
    assert.equal(replies.authorLabel("99999999999999@lid"), "99999999999999@lid");
    assert.equal(replies.authorLabel("237690000001:12@s.whatsapp.net"), "237690000001");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// decodeVote, at the unit level (at most 8 candidate pairs)
// ---------------------------------------------------------------------------------------------------------------------

describe("decodeVote: candidate JID pairs, first success wins, at most 8 attempts (7.3)", () => {
  const secret = crypto.randomBytes(32);
  const row = { publicId: `msg_${"V".repeat(22)}`, waId: "3EB0UNITVOTE00000001" };
  const withSecret = () => ({ ...row, pollSecret: secretBox.encrypt(secret.toString("hex"), `api-poll:${row.publicId}`) });
  const message = (keyOver = {}) => ({
    key: { remoteJid: VOTER_LID, remoteJidAlt: VOTER_PN, fromMe: false, id: "U1", ...keyOver },
    content: { pollUpdateMessage: { pollCreationMessageKey: { id: row.waId }, vote: { encPayload: Buffer.from("x"), encIv: Buffer.alloc(12) }, senderTimestampMs: 1 } },
    client: { getSocket: () => ({ user: { id: "999:3@s.whatsapp.net", lid: "555:3@lid" } }) },
  });

  test("it tries every creator x voter pair once, at most 8, and reports no vote when none decrypts", () => {
    const attempts = [];
    const unit = replies.createReplies({
      secretBox,
      decryptPollVote: (_vote, ctx) => {
        attempts.push([ctx.pollCreatorJid, ctx.voterJid]);
        throw new Error("auth failed");
      },
    });
    assert.equal(unit.decodeVote(message({ participant: IDS.MEMBER_LID, participantAlt: IDS.MEMBER_PN }), withSecret()), null);
    assert.equal(attempts.length, 8);
    assert.equal(new Set(attempts.map((a) => a.join("|"))).size, 8, "no pair twice");
    assert.deepEqual([...new Set(attempts.map((a) => a[0]))].sort(), [IDS.BOT_LID, IDS.BOT_PN].sort());
    assert.ok(attempts.every((a) => !a[0].includes(":") && !a[1].includes(":")), "device suffixes are stripped");
  });

  test("the LID of the creator comes first for a LID-addressed chat; the first pair that works wins and stops the search", () => {
    const attempts = [];
    const unit = replies.createReplies({
      secretBox,
      decryptPollVote: (_vote, ctx) => {
        attempts.push([ctx.pollCreatorJid, ctx.voterJid]);
        if (ctx.pollCreatorJid === IDS.BOT_PN && ctx.voterJid === VOTER_PN) return { selectedOptions: [Buffer.from("ab", "hex")] };
        throw new Error("auth failed");
      },
    });
    const decoded = unit.decodeVote(message(), withSecret());
    assert.deepEqual(decoded, { digests: ["ab"] });
    assert.equal(attempts[0][0], IDS.BOT_LID, "LID first in a LID chat");
    assert.deepEqual(attempts.at(-1), [IDS.BOT_PN, VOTER_PN]);
    assert.ok(attempts.length <= 8);
  });

  test("a PN-addressed chat tries the phone number of the creator first", () => {
    const attempts = [];
    const unit = replies.createReplies({
      secretBox,
      decryptPollVote: (_vote, ctx) => {
        attempts.push(ctx.pollCreatorJid);
        throw new Error("no");
      },
    });
    unit.decodeVote(message({ remoteJid: VOTER_PN, remoteJidAlt: undefined }), withSecret());
    assert.equal(attempts[0], IDS.BOT_PN);
  });

  test("the secret is read with the context api-poll:<publicId>; another context or a missing key is no vote", () => {
    const unit = replies.createReplies({ secretBox, decryptPollVote: () => ({ selectedOptions: [] }) });
    const stolen = { ...row, pollSecret: secretBox.encrypt(secret.toString("hex"), "api-poll:msg_someoneelse") };
    assert.equal(unit.decodeVote(message(), stolen), null);
    assert.equal(unit.decodeVote(message(), { ...row, pollSecret: null }), null);
    assert.deepEqual(unit.decodeVote(message(), withSecret()), { digests: [] }, "an empty selection is a cleared vote, not an error");
  });

  test("decodeVote never throws on a malformed message", () => {
    const unit = replies.createReplies({ secretBox, decryptPollVote: () => ({ selectedOptions: [] }) });
    for (const bad of [null, {}, { key: {} }, { key: {}, content: {} }, { content: { pollUpdateMessage: {} }, key: {} }]) {
      assert.doesNotThrow(() => unit.decodeVote(bad, withSecret()));
    }
  });
});

// =====================================================================================================================
// Part 2: buttons and lists, taps and quoted numbers (7.1, 7.2, US6)
// =====================================================================================================================

describe("taps and numbered answers on buttons and lists (7.2)", () => {
  const BUTTONS = [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }, { id: "later", label: "Later" }];

  async function sendButtons({ to = VOTER, format = "buttons" } = {}) {
    const fields =
      format === "buttons"
        ? { text: "Do you confirm?", buttons: BUTTONS }
        : { text: "Pick a slot", buttonLabel: "Slots", choices: [{ id: "am", title: "Morning" }, { id: "pm", title: "Afternoon", description: "14:00" }] };
    const { message } = await kit.send({ apiKeyId: key.id, to, format, fields });
    await kit.messaging.tick(Date.now());
    const row = await kit.row(message.publicId);
    assert.equal(row.status, "sent");
    return row;
  }

  const wire = (row, id) => replies.wireId(row.waId, id);
  const tap = (row, id, over = {}) => fakes.rawMessage({ from: VOTER_PN, interactive: { id: wire(row, id), kind: "button" }, ...over });
  const number = (row, digits, over = {}) =>
    fakes.rawMessage({ from: VOTER_PN, body: digits, quoted: { id: row.waId, fromMe: true, sender: IDS.BOT_PN, text: "Do you confirm?" }, ...over });
  const stored = (row) => responsesOf(row);

  test("wireId and parseWireId are inverse; only the exact shape parses", () => {
    assert.equal(replies.WIRE_PREFIX, "api:reply:");
    assert.equal(replies.wireId("3EB0ABCDEF0123456789", "yes"), "api:reply:3EB0ABCDEF0123456789:yes");
    assert.deepEqual(replies.parseWireId("api:reply:3EB0ABCDEF0123456789:yes"), { waId: "3EB0ABCDEF0123456789", id: "yes" });
    assert.deepEqual(replies.parseWireId("api:reply:3EB0ABCDEF0123456789:a.b_c-1"), { waId: "3EB0ABCDEF0123456789", id: "a.b_c-1" });
    for (const bad of ["", "api:reply:", "api:reply:short:yes", "api:reply:3EB0ABCDEF0123456789:", "api:reply:3EB0ABCDEF0123456789:a:b", "x api:reply:3EB0ABCDEF0123456789:yes", " api:reply:3EB0ABCDEF0123456789:yes", null, 7, undefined]) {
      assert.equal(replies.parseWireId(bad), null, String(bad));
    }
  });

  test("a native tap on a button is recorded (via tap, the reply's own id) and consumed", async () => {
    const row = await sendButtons();
    await deliver(tap(row, "no", { id: "TAP-1" }));
    const [response] = await stored(row);
    assert.deepEqual([response.kind, response.author, response.voterKey, response.choiceIds, response.via, response.sourceId], ["choice", VOTER_PN, null, ["no"], "tap", "TAP-1"]);
    assert.equal(reached(), false, "no other plugin reacts to it");
    assert.deepEqual(seen, []);
  });

  test("a row of a list is recorded by its caller id; the same person tapping twice yields two items", async () => {
    const row = await sendButtons({ format: "list" });
    await deliver(fakes.rawMessage({ from: VOTER_PN, interactive: { id: wire(row, "pm"), kind: "list" }, id: "LIST-1" }));
    await deliver(fakes.rawMessage({ from: VOTER_PN, interactive: { id: wire(row, "am"), kind: "list" }, id: "LIST-2" }));
    const described = kit.messaging.describeResponses(await kit.row(row.publicId), await stored(row));
    assert.equal(described.total, 2);
    assert.deepEqual(described.items.map((i) => [i.kind, i.via, i.choices]), [
      ["choice", "tap", [{ id: "pm", label: "Afternoon" }]],
      ["choice", "tap", [{ id: "am", label: "Morning" }]],
    ]);
    assert.equal(described.totals, null, "totals are for polls only");
  });

  test("a redelivered tap is not counted twice", async () => {
    const row = await sendButtons();
    await deliver(tap(row, "yes", { id: "DUP" }));
    await deliver(tap(row, "yes", { id: "DUP" }));
    assert.equal((await stored(row)).length, 1);
  });

  test("a bare number quoting the message is recorded as via number, even two hours later (the window counts from sentAt)", async () => {
    const row = await sendButtons();
    await kit.db.ApiMessage.update({ sentAt: new Date(Date.now() - 2 * HOUR), sendingAt: new Date(Date.now() - 2 * HOUR - SEC), acceptedAt: new Date(Date.now() - 2 * HOUR - 2 * SEC), expiresAt: new Date(Date.now() - 2 * HOUR + 10 * MIN), repliesUntil: new Date(Date.now() - 2 * HOUR + 7 * DAY) }, { where: { id: row.id } });
    await deliver(number(row, "2", { id: "NUM-1" }));
    const [response] = await stored(row);
    assert.deepEqual([response.choiceIds, response.via, response.author, response.sourceId], [["no"], "number", VOTER_PN, "NUM-1"]);
    assert.equal(reached(), false);
  });

  test("a number outside 1..n, or on a poll, is consumed and not recorded", async () => {
    const row = await sendButtons();
    await deliver(number(row, "9"));
    await deliver(number(row, "0"));
    assert.equal((await stored(row)).length, 0);
    assert.equal(reached(), false, "an answer to an API message is never a game's");

    const poll = await sendPoll();
    await deliver(number(poll.row, "1"));
    assert.equal((await stored(poll.row)).length, 0);
    assert.deepEqual(seen, []);
  });

  test("a quoted number of a message that is NOT ours returns false: the games' hooks proceed", async () => {
    await deliver(fakes.rawMessage({ from: VOTER_PN, body: "2", quoted: { id: "3EB0NOTANAPIMESSAGE0001", fromMe: true, sender: IDS.BOT_PN, text: "a game board" } }));
    assert.deepEqual(seen.map(([hook]) => hook), ["handleButtonReply", "onMessage"], "the probe saw it, as every later plugin would");
    // and a number quoting somebody else's message is none of its business either
    await deliver(fakes.rawMessage({ from: VOTER_PN, body: "2", quoted: { id: "WHATEVER", fromMe: false, sender: IDS.MEMBER_PN, text: "hi" } }));
    assert.equal(seen[0][0], "handleButtonReply");
    assert.equal(await kit.db.ApiMessageResponse.count(), 0);
  });

  test("a text that merely looks like a wire id is not an interactive reply: ignored, not consumed", async () => {
    const row = await sendButtons();
    await deliver(fakes.rawMessage({ from: VOTER_PN, body: wire(row, "yes") }));
    assert.equal((await stored(row)).length, 0);
    assert.equal(reached(), true, "ordinary text: the rest of the pipeline sees it");
    // quoting the API message with that text changes nothing
    await deliver(fakes.rawMessage({ from: VOTER_PN, body: wire(row, "yes"), quoted: { id: row.waId, fromMe: true, sender: IDS.BOT_PN, text: "x" } }));
    assert.equal((await stored(row)).length, 0);
  });

  test("a wire id with the switch off is consumed and not recorded", async () => {
    const row = await sendButtons();
    await apiState.setEnabled(false);
    await deliver(tap(row, "yes"));
    assert.equal(await kit.db.ApiMessageResponse.count(), 0);
    assert.deepEqual(seen, []);
    await deliver(number(row, "1"));
    assert.equal(await kit.db.ApiMessageResponse.count(), 0);
    assert.deepEqual(seen, [], "a number on one of our messages is ours even when we do not record it");
  });

  test("an unknown row, an answer after repliesUntil, and a message past 1000 responses are consumed and not recorded (US6.4, US6.5)", async () => {
    await deliver(fakes.rawMessage({ from: VOTER_PN, interactive: { id: replies.wireId("3EB0NOSUCHMESSAGE00001", "yes"), kind: "button" } }));
    assert.deepEqual(seen, [], "unknown row: consumed");

    const row = await sendButtons();
    await kit.db.ApiMessage.update({ repliesUntil: new Date(Date.now() - SEC) }, { where: { id: row.id } });
    await deliver(tap(row, "yes"));
    assert.deepEqual(seen, []);
    assert.equal(await kit.db.ApiMessageResponse.count({ where: { messageId: row.id } }), 0);

    const busy = await sendButtons();
    await kit.db.ApiMessageResponse.bulkCreate(Array.from({ length: 1000 }, (_, i) => ({ messageId: busy.id, kind: "choice", author: VOTER_PN, choiceIds: ["yes"], via: "tap", sourceId: `bulk-${i}`, respondedAt: new Date() })));
    await deliver(tap(busy, "no", { id: "OVER" }));
    assert.deepEqual(seen, []);
    assert.equal(await kit.db.ApiMessageResponse.count({ where: { messageId: busy.id } }), 1000);
  });

  test("an id that is not one of the caller's ids is consumed and not recorded", async () => {
    const row = await sendButtons();
    await deliver(tap(row, "maybe"));
    assert.equal((await stored(row)).length, 0);
    assert.deepEqual(seen, []);
  });

  test("a group row records only a reply that arrives in that group, under the participant", async () => {
    const row = await sendButtons({ to: GROUP });
    // the same message id tapped in another group (or a private chat) is consumed and not recorded
    await deliver(fakes.rawMessage({ from: IDS.MEMBER_PN, group: "120363999999999999@g.us", interactive: { id: wire(row, "yes"), kind: "button" }, id: "ELSEWHERE" }));
    await deliver(fakes.rawMessage({ from: IDS.MEMBER_PN, interactive: { id: wire(row, "yes"), kind: "button" }, id: "PRIVATE" }));
    assert.equal((await stored(row)).length, 0);
    assert.deepEqual(seen, []);

    await deliver(fakes.rawMessage({ from: IDS.MEMBER_PN, group: GROUP, interactive: { id: wire(row, "no"), kind: "button" }, id: "IN-GROUP" }));
    await deliver(fakes.rawMessage({ from: IDS.MEMBER_LID, alt: null, group: GROUP, interactive: { id: wire(row, "yes"), kind: "button" }, id: "IN-GROUP-LID" }));
    assert.deepEqual((await stored(row)).map((r) => [r.author, r.choiceIds]), [[IDS.MEMBER_PN, ["no"]], [IDS.MEMBER_LID, ["yes"]]]);
  });

  test("in a private chat the author is the recipient even when WhatsApp only reports a LID", async () => {
    const row = await sendButtons();
    await deliver(fakes.rawMessage({ from: VOTER_LID, alt: null, interactive: { id: wire(row, "yes"), kind: "button" }, id: "LID-ONLY" }));
    assert.deepEqual((await stored(row)).map((r) => r.author), [VOTER_PN]);
  });

  test("a failed or cancelled message has no reply window: nothing is recorded, the tap is still consumed", async () => {
    const row = await sendButtons();
    await kit.db.ApiMessage.update({ status: "failed", errorCode: "whatsapp_rejected", endedAt: new Date(), choices: null, replyData: null, pollSecret: null, repliesUntil: null }, { where: { id: row.id } });
    await deliver(tap(row, "yes"));
    assert.equal(await kit.db.ApiMessageResponse.count(), 0);
    assert.deepEqual(seen, []);
  });

  test("the hooks never throw: a damaged message or a database failure is swallowed", async () => {
    const row = await sendButtons();
    await assert.doesNotReject(() => replies.handleButtonReply(null));
    await assert.doesNotReject(() => replies.handleButtonReply({}));
    await assert.doesNotReject(() => replies.handlePollVote(null));
    await assert.doesNotReject(() => replies.handlePollVote({ type: "pollUpdateMessage" }));
    const broken = replies.createReplies({
      models: () => ({
        ApiMessage: { findOne: async () => Promise.reject(new Error("database is locked")) },
      }),
      apiState,
    });
    await assert.doesNotReject(async () => {
      const result = await broken.handleButtonReply({ isInteractiveReply: true, body: wire(row, "yes"), jid: OTHER_PN, quoted: null });
      assert.equal(result, true, "a wire id is consumed even when the lookup fails");
    });
  });
});
