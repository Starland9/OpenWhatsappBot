"use strict";
/**
 * plugins/buttons.js builders and sendPrepared (feature 004, contracts/runtime.md sections 14.5 and 3.7).
 *
 *  - `buildQuickReplies` / `buildList` return `{ kind, text, body, nativeButtons, ids }`; the native buttons are
 *    exactly what `sendQuickReplies` and `sendList` send today (parity, captured with a fake socket and a fake
 *    helper), and `numbered: true` adds the numbered text and the hint the API always sends (U14);
 *  - `sendPrepared(sock, jid, prepared, { messageId, quoted })` makes one attempt: no fallback, no buttonRegistry
 *    record, the pre-generated `messageId` forwarded to the helper, a failure thrown;
 *  - `sendQuickReplies` / `sendList` keep their behaviour: one plain fallback on failure, `recordIds`,
 *    `sendOptions()` forwards `opts.messageId`.
 *
 * The button helper (@ryuu-reinzz/button-helper) is replaced in the module cache by a recorder, so nothing is
 * relayed and no WhatsApp internals are needed.
 */

const { test, describe, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const { getLang } = require("../lib/utils/language");
const buttonRegistry = require("../lib/utils/buttonRegistry");

const helperPath = require.resolve("@ryuu-reinzz/button-helper");
const pluginPath = require.resolve("../plugins/buttons");

/** Every call the plugin made to the helper, and a switch to make the helper fail. */
const calls = [];
const state = { failFirst: 0 };

const fakeHelper = {
  async sendButtons(sock, jid, data, options) {
    calls.push({ fn: "sendButtons", jid, data, options });
    if (state.failFirst > 0) {
      state.failFirst -= 1;
      throw new Error("helper refused");
    }
    return { key: { remoteJid: jid, fromMe: true, id: (options && options.messageId) || `HELP${calls.length}` } };
  },
  async sendInteractiveMessage(sock, jid, content, options) {
    calls.push({ fn: "sendInteractiveMessage", jid, content, options });
    if (state.failFirst > 0) {
      state.failFirst -= 1;
      throw new Error("helper refused");
    }
    return { key: { remoteJid: jid, fromMe: true, id: (options && options.messageId) || `HELP${calls.length}` } };
  },
};

let originalHelper;
let originalPlugin;
let buttons;
let sock;
const JID = "237690000001@s.whatsapp.net";

before(() => {
  originalHelper = require.cache[helperPath];
  originalPlugin = require.cache[pluginPath];
  require.cache[helperPath] = { id: helperPath, filename: helperPath, loaded: true, exports: fakeHelper };
  delete require.cache[pluginPath];
  buttons = require("../plugins/buttons");
});

after(() => {
  if (originalHelper) require.cache[helperPath] = originalHelper;
  else delete require.cache[helperPath];
  if (originalPlugin) require.cache[pluginPath] = originalPlugin;
  else delete require.cache[pluginPath];
});

beforeEach(() => {
  calls.length = 0;
  state.failFirst = 0;
  buttonRegistry._reset();
  sock = fakes.fakeSocket();
});

const yesNo = [
  { id: "yes", text: "Yes" },
  { id: "no", text: "No" },
];
const sections = [
  {
    title: "Colors",
    rows: [
      { id: "red", title: "Red", description: "The color of fire" },
      { id: "blue", title: "Blue" },
    ],
  },
  { title: "Sizes", rows: [{ id: "big", title: "Big" }] },
];

/** The native buttons `sendQuickReplies` has always built (golden values, from the code before the split). */
const GOLDEN_QUICK = [
  { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "Yes", id: "yes" }) },
  { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "No", id: "no" }) },
];

describe("exports", () => {
  test("the three new names, the four old ones and MAX_BUTTONS_PER_MESSAGE", () => {
    for (const name of ["buildQuickReplies", "buildList", "sendPrepared", "sendQuickReplies", "sendList", "sendConfirm", "sendPaginatedList"]) {
      assert.equal(typeof buttons[name], "function", name);
    }
    assert.equal(buttons.MAX_BUTTONS_PER_MESSAGE, 3);
  });

  test("the plugin has no command and no hook (the loader skips it)", () => {
    assert.equal(buttons.command, undefined);
    for (const hook of ["onMessage", "handleButtonReply", "onReady", "onGroupParticipants", "execute"]) assert.equal(buttons[hook], undefined, hook);
  });
});

describe("buildQuickReplies", () => {
  test("shape and parity of the native buttons", () => {
    const prepared = buttons.buildQuickReplies("Pick one", yesNo);
    assert.deepEqual(Object.keys(prepared).sort(), ["body", "ids", "kind", "nativeButtons", "text"]);
    assert.equal(prepared.kind, "buttons");
    assert.equal(prepared.text, "Pick one");
    assert.equal(prepared.body, "Pick one", "without numbered the body is the text");
    assert.deepEqual(prepared.ids, ["yes", "no"]);
    assert.deepEqual(prepared.nativeButtons, GOLDEN_QUICK);
  });

  test("a button without id gets quick_<n>, without text Button <n>; at most 3 buttons", () => {
    const prepared = buttons.buildQuickReplies("x", [{ text: "A" }, { id: "b" }, { id: "c", text: "C" }, { id: "d", text: "D" }]);
    assert.deepEqual(prepared.ids, ["quick_1", "b", "c"]);
    assert.deepEqual(
      prepared.nativeButtons.map((b) => JSON.parse(b.buttonParamsJson)),
      [
        { display_text: "A", id: "quick_1" },
        { display_text: "Button 2", id: "b" },
        { display_text: "C", id: "c" },
      ],
    );
  });

  test("numbered: the text, a blank line, '  n. label' lines, a blank line and the hint in italics", () => {
    const prepared = buttons.buildQuickReplies("Pick one", yesNo, { numbered: true });
    assert.equal(prepared.text, "Pick one", "text stays the plain text");
    assert.equal(prepared.body, `Pick one\n\n  1. Yes\n  2. No\n\n_${getLang("plugins.buttons.reply_number")}_`);
    assert.deepEqual(prepared.nativeButtons, GOLDEN_QUICK, "the native buttons do not change");
  });

  test("numbered false is the default", () => {
    assert.deepEqual(buttons.buildQuickReplies("t", yesNo, {}), buttons.buildQuickReplies("t", yesNo));
    assert.equal(buttons.buildQuickReplies("t", yesNo, { numbered: false }).body, "t");
  });
});

describe("buildList", () => {
  test("shape and parity of the single_select button", () => {
    const prepared = buttons.buildList("Choose", sections, { buttonLabel: "Open" });
    assert.deepEqual(Object.keys(prepared).sort(), ["body", "ids", "kind", "nativeButtons", "text"]);
    assert.equal(prepared.kind, "list");
    assert.equal(prepared.text, "Choose");
    assert.equal(prepared.body, "Choose");
    assert.deepEqual(prepared.ids, ["red", "blue", "big"], "rows flattened section by section");
    assert.equal(prepared.nativeButtons.length, 1);
    assert.equal(prepared.nativeButtons[0].name, "single_select");
    assert.equal(
      prepared.nativeButtons[0].buttonParamsJson,
      JSON.stringify({
        title: "Open",
        sections: [
          {
            title: "Colors",
            rows: [
              { id: "red", title: "Red", description: "The color of fire", header: undefined },
              { id: "blue", title: "Blue", description: "", header: undefined },
            ],
          },
          { title: "Sizes", rows: [{ id: "big", title: "Big", description: "", header: undefined }] },
        ],
      }),
    );
  });

  test("row titles are cut to 24 and descriptions to 72 characters; the default button label is open_menu", () => {
    const long = [{ title: "S", rows: [{ id: "r", title: "t".repeat(40), description: "d".repeat(100) }] }];
    const prepared = buttons.buildList("x", long);
    const params = JSON.parse(prepared.nativeButtons[0].buttonParamsJson);
    assert.equal(params.title, getLang("plugins.buttons.open_menu"));
    assert.equal(params.sections[0].rows[0].title.length, 24);
    assert.equal(params.sections[0].rows[0].description.length, 72);
  });

  test("numbered: row titles only, in order, with the pick_list hint", () => {
    const prepared = buttons.buildList("Choose", sections, { buttonLabel: "Open", numbered: true });
    assert.equal(prepared.text, "Choose");
    assert.equal(prepared.body, `Choose\n\n  1. Red\n  2. Blue\n  3. Big\n\n_${getLang("plugins.buttons.pick_list")}_`);
    assert.doesNotMatch(prepared.body, /fire|Colors|Sizes/, "descriptions and section titles are not in the numbered body");
    assert.deepEqual(prepared.ids, ["red", "blue", "big"]);
  });

  test("the API shape: one section of choices", () => {
    const prepared = buttons.buildList("Pick", [{ title: "", rows: [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta", description: "second" }] }], {
      buttonLabel: "Choose",
      numbered: true,
    });
    assert.equal(prepared.body, `Pick\n\n  1. Alpha\n  2. Beta\n\n_${getLang("plugins.buttons.pick_list")}_`);
    assert.deepEqual(prepared.ids, ["a", "b"]);
  });
});

describe("what sendQuickReplies and sendList send (unchanged)", () => {
  test("sendQuickReplies without mentions: the helper's sendButtons gets the raw quick buttons and options {}", async () => {
    const sent = await buttons.sendQuickReplies(sock, JID, "Pick", yesNo);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, "sendButtons");
    assert.equal(calls[0].jid, JID);
    assert.deepEqual(calls[0].data, { text: "Pick", title: undefined, footer: "OpenWhatsappBot", buttons: yesNo });
    assert.deepEqual(calls[0].options, {});
    assert.deepEqual(buttonRegistry.resolve(sent.key.id, "2"), "no", "the ids are recorded in display order");
  });

  test("sendQuickReplies with mentions: the native buttons are the builder's", async () => {
    await buttons.sendQuickReplies(sock, JID, "Pick", yesNo, { mentions: ["1@s.whatsapp.net"], title: "T", footer: "F" });
    assert.equal(calls[0].fn, "sendInteractiveMessage");
    const interactive = calls[0].content.interactiveMessage;
    assert.deepEqual(interactive.nativeFlowMessage.buttons, buttons.buildQuickReplies("Pick", yesNo).nativeButtons);
    assert.deepEqual(interactive.nativeFlowMessage.buttons, GOLDEN_QUICK);
    assert.deepEqual(interactive.body, { text: "Pick" });
    assert.deepEqual(interactive.footer, { text: "F" });
    assert.deepEqual(interactive.header, { title: "T", hasMediaAttachment: false });
    assert.deepEqual(interactive.contextInfo, { mentionedJid: ["1@s.whatsapp.net"] });
  });

  test("sendList: interactiveButtons are the builder's nativeButtons", async () => {
    const sent = await buttons.sendList(sock, JID, "Choose", sections, { buttonLabel: "Open", quoted: { key: { id: "Q" } } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, "sendInteractiveMessage");
    assert.deepEqual(calls[0].content.interactiveButtons, buttons.buildList("Choose", sections, { buttonLabel: "Open" }).nativeButtons);
    assert.equal(calls[0].content.text, "Choose");
    assert.equal(calls[0].content.footer, "OpenWhatsappBot");
    assert.deepEqual(calls[0].options, { quoted: { key: { id: "Q" } } });
    assert.equal(buttonRegistry.resolve(sent.key.id, "3"), "big", "ids flattened section by section");
  });

  test("an empty button list or section list falls back to plain text, nothing recorded", async () => {
    await buttons.sendQuickReplies(sock, JID, "just text", []);
    await buttons.sendList(sock, JID, "just text", []);
    assert.equal(calls.length, 0);
    assert.deepEqual(sock.sent.map((s) => s.kind), ["text", "text"]);
  });

  test("sendOptions: {} by default, {quoted} when quoted, and now {messageId} when a messageId is given", async () => {
    await buttons.sendQuickReplies(sock, JID, "Pick", yesNo, { quoted: { key: { id: "Q" } }, messageId: "3EB0AAAA1111" });
    assert.deepEqual(calls[0].options, { quoted: { key: { id: "Q" } }, messageId: "3EB0AAAA1111" });
    calls.length = 0;
    await buttons.sendList(sock, JID, "Choose", sections, { messageId: "3EB0BBBB2222" });
    assert.deepEqual(calls[0].options, { messageId: "3EB0BBBB2222" });
    calls.length = 0;
    await buttons.sendQuickReplies(sock, JID, "Pick", yesNo);
    assert.deepEqual(calls[0].options, {}, "unchanged for the existing callers");
  });

  test("the plain-text messages forward messageId too (sock.sendMessage options)", async () => {
    await buttons.sendQuickReplies(sock, JID, "just text", [], { messageId: "3EB0CCCC3333" });
    assert.equal(sock.sent[0].key.id, "3EB0CCCC3333", "needs the fake socket's messageId support");
  });
});

describe("the failure fallback is unchanged: exactly one plain message", () => {
  test("sendQuickReplies: one numbered text, ids recorded", async () => {
    state.failFirst = 1;
    const originalError = console.error;
    console.error = () => {};
    let sent;
    try {
      sent = await buttons.sendQuickReplies(sock, JID, "Pick", yesNo);
    } finally {
      console.error = originalError;
    }
    assert.equal(sock.sent.length, 1);
    assert.equal(sock.sent[0].kind, "text");
    assert.equal(sock.sent[0].content.text, buttons.buildQuickReplies("Pick", yesNo, { numbered: true }).body);
    assert.equal(sock.sent[0].content.text, `Pick\n\n  1. Yes\n  2. No\n\n_${getLang("plugins.buttons.reply_number")}_`);
    assert.equal(buttonRegistry.resolve(sent.key.id, "1"), "yes");
  });

  test("sendList: one numbered text with the section titles and descriptions of today, ids recorded", async () => {
    state.failFirst = 1;
    const originalError = console.error;
    console.error = () => {};
    let sent;
    try {
      sent = await buttons.sendList(sock, JID, "Choose", sections, { buttonLabel: "Open" });
    } finally {
      console.error = originalError;
    }
    assert.equal(sock.sent.length, 1);
    assert.equal(
      sock.sent[0].content.text,
      `Choose\n\n*Colors*\n  1. Red — _The color of fire_\n  2. Blue\n\n*Sizes*\n  3. Big\n\n_${getLang("plugins.buttons.pick_list")}_`,
    );
    assert.equal(buttonRegistry.resolve(sent.key.id, "2"), "blue");
  });
});

describe("sendPrepared: one attempt, no fallback, no registry record", () => {
  test("calls sendInteractiveMessage with the body and the native buttons only (no footer, no header)", async () => {
    const prepared = buttons.buildQuickReplies("Pick", yesNo, { numbered: true });
    await buttons.sendPrepared(sock, JID, prepared, { messageId: "3EB0DDDD4444", quoted: { key: { id: "Q" } } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, "sendInteractiveMessage");
    assert.equal(calls[0].jid, JID);
    assert.deepEqual(calls[0].content, {
      interactiveMessage: { body: { text: prepared.body }, nativeFlowMessage: { buttons: prepared.nativeButtons } },
    });
    assert.deepEqual(calls[0].options, { quoted: { key: { id: "Q" } }, messageId: "3EB0DDDD4444" });
  });

  test("forwards the pre-generated messageId and returns what the helper returned (the WAMessage)", async () => {
    const prepared = buttons.buildList("Choose", sections, { numbered: true });
    const sent = await buttons.sendPrepared(sock, JID, prepared, { messageId: "3EB0EEEE5555" });
    assert.equal(sent.key.id, "3EB0EEEE5555");
    assert.deepEqual(calls[0].options, { messageId: "3EB0EEEE5555" });
  });

  test("no options: {} like every other send", async () => {
    await buttons.sendPrepared(sock, JID, buttons.buildQuickReplies("x", yesNo));
    assert.deepEqual(calls[0].options, {});
  });

  test("never records the ids in the buttonRegistry (the mapping lives in ApiMessage.choices)", async () => {
    const prepared = buttons.buildQuickReplies("Pick", yesNo, { numbered: true });
    const sent = await buttons.sendPrepared(sock, JID, prepared, { messageId: "3EB0FFFF6666" });
    assert.equal(buttonRegistry.resolve(sent.key.id, "1"), null);
    assert.equal(buttonRegistry.resolve("3EB0FFFF6666", "2"), null);
  });

  test("a failure is thrown and no second plain message is sent", async () => {
    state.failFirst = 1;
    const prepared = buttons.buildQuickReplies("Pick", yesNo, { numbered: true });
    await assert.rejects(buttons.sendPrepared(sock, JID, prepared, { messageId: "3EB0GGGG7777" }), /helper refused/);
    assert.equal(calls.length, 1, "one attempt");
    assert.equal(sock.sent.length, 0, "no plain fallback");
  });

  test("a list prepared the same way", async () => {
    const prepared = buttons.buildList("Choose", [{ title: "", rows: [{ id: "a", title: "Alpha" }] }], { buttonLabel: "Open", numbered: true });
    await buttons.sendPrepared(sock, JID, prepared);
    assert.deepEqual(calls[0].content.interactiveMessage.nativeFlowMessage.buttons, prepared.nativeButtons);
    assert.equal(calls[0].content.interactiveMessage.body.text, prepared.body);
  });
});

describe("sendConfirm and sendPaginatedList still go through the same paths", () => {
  test("sendConfirm sends two quick replies", async () => {
    await buttons.sendConfirm(sock, JID, "Sure?", "ok", "ko");
    assert.equal(calls[0].fn, "sendButtons");
    assert.deepEqual(calls[0].data.buttons.map((b) => b.id), ["ok", "ko"]);
  });

  test("sendPaginatedList adds the navigation section", async () => {
    await buttons.sendPaginatedList(sock, JID, "Page 1", sections, 0, 3, "pg");
    const params = JSON.parse(calls[0].content.interactiveButtons[0].buttonParamsJson);
    assert.equal(params.sections.length, 3);
    assert.deepEqual(params.sections[2].rows.map((r) => r.id), ["pg_nav_next"]);
  });
});
