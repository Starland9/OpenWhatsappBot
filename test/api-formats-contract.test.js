"use strict";
/**
 * Feature 004 (messaging API): the request bodies of contracts/public-api.md section 3 over the real stack, format by
 * format. Each limit of a format is exercised at its boundary (accepted) and one past it (the exact field code and the
 * dotted path of the contract), with strict unknown fields at every nesting level. A refused request queues nothing.
 * The media formats go through a multipart request with a generated sample of the accepted type.
 */

const { test, describe, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const { createApiHarness } = require("./helpers/apiHarness");

const TO = "237690000001";
const GROUP = "120363025246125486@g.us";
const MEDIA_FORMATS = ["image", "video", "gif", "audio", "voice", "document", "sticker"];

let h;
let key;
before(async () => {
  h = await createApiHarness({});
  key = await h.createKey({ name: "formats", limits: { perMinute: 1000, perDay: 100000, pending: 5000 } });
});
after(async () => {
  await h.close();
});
afterEach(async () => {
  await h.drain();
});

const rep = (text, n) => text.repeat(n);
const phone = (n) => `+23769000${String(n).padStart(4, "0")}`;

/** POST one body; a media format is sent as multipart with the sample of its type. Returns { res, count } */
async function post(format, body, { opts, file } = {}) {
  const before = await h.db.ApiMessage.count();
  let res;
  if (MEDIA_FORMATS.includes(format) && !(body.media && body.media.url)) {
    const sample = file || (format === "gif" ? await gifSample() : await h.sampleFor(format));
    res = await h.sendFile(key, body, sample, opts);
  } else {
    res = await h.send(key, body, opts);
  }
  return { res, grew: (await h.db.ApiMessage.count()) - before };
}

let gif;
async function gifSample() {
  gif = gif || { data: await require("sharp")({ create: { width: 16, height: 16, channels: 3, background: { r: 1, g: 2, b: 3 } } }).gif().toBuffer(), name: "a.gif", type: "image/gif" };
  return gif;
}

async function accepted(format, body, opts) {
  const { res, grew } = await post(format, body, opts);
  assert.equal(res.status, 202, `${format} ${JSON.stringify(Object.keys(body))}: ${res.text.slice(0, 300)}`);
  assert.equal(grew, 1);
  return res;
}

async function refused(format, body, fields, opts) {
  const { res, grew } = await post(format, body, opts);
  assert.equal(res.status, 422, `${format}: ${res.text.slice(0, 300)}`);
  assert.equal(res.json.error.code, "validation_failed");
  assert.deepEqual(res.json.error.fields, fields);
  assert.equal(grew, 0, "nothing was queued");
  return res;
}

const text = (extra) => ({ format: "text", to: TO, text: "hello", ...extra });

describe("text", () => {
  test("text: 1 to 4,096 code points, counted as code points", async () => {
    await accepted("text", text({ text: "x" }));
    await accepted("text", text({ text: rep("x", 4096) }));
    await accepted("text", text({ text: rep("\u{1F600}", 4096) }));
    await refused("text", text({ text: rep("x", 4097) }), { text: { code: "too_long", params: { max: 4096 } } });
    await refused("text", text({ text: rep("\u{1F600}", 4097) }), { text: { code: "too_long", params: { max: 4096 } } });
    const empty = await post("text", text({ text: "   " }));
    assert.equal(empty.res.status, 422);
    assert.ok(empty.res.json.error.fields.text);
    await refused("text", { format: "text", to: TO }, { text: { code: "required" } });
    await refused("text", text({ text: 12 }), { text: { code: "invalid_type" } });
  });

  test("mentions: groups only, at most 50 numbers, distinct", async () => {
    await refused("text", text({ mentions: ["237690000002"] }), { mentions: { code: "not_allowed" } });
    await accepted("text", text({ to: GROUP, mentions: ["237690000002", "+237 690 00 00 03"] }));
    await accepted("text", text({ to: GROUP, mentions: Array.from({ length: 50 }, (_, i) => `2376900${String(10000 + i)}`) }));
    await refused("text", text({ to: GROUP, mentions: Array.from({ length: 51 }, (_, i) => `2376900${String(10000 + i)}`) }), { mentions: { code: "too_many_items", params: { max: 50 } } });
    await refused("text", text({ to: GROUP, mentions: ["237690000002", "237690000002"] }), { "mentions.1": { code: "duplicate" } });
    await refused("text", text({ to: GROUP, mentions: ["237690000002", "abc"] }), { "mentions.1": { code: "invalid_format" } });
  });

  test("linkPreview is a boolean", async () => {
    await accepted("text", text({ linkPreview: false }));
    await refused("text", text({ linkPreview: "yes" }), { linkPreview: { code: "invalid_type" } });
  });

  test("a quote that is not a usable message of this key is not_found", async () => {
    await refused("text", text({ quote: `msg_${"B".repeat(22)}` }), { quote: { code: "not_found" } });
    await refused("text", text({ quote: "not-an-id" }), { quote: { code: "invalid_format" } });
    const first = await accepted("text", text({ text: "first" }));
    // still queued: it has not left yet
    await refused("text", text({ quote: first.json.message.id }), { quote: { code: "not_found" } });
    await h.drain();
    const sent = await accepted("text", text({ quote: first.json.message.id, text: "reply" }));
    await h.tick(2200);
    assert.equal((await h.row(sent.json.message.id)).status, "sent");
    const last = h.sock.sent[h.sock.sent.length - 1];
    assert.equal(last.options && last.options.quoted && last.options.quoted.key.id, (await h.row(first.json.message.id)).waId, "the bubble quotes the earlier WhatsApp message");
    // another key's message, and another chat, behave as unknown
    const other = await h.createKey({ name: "other" });
    const foreign = await h.send(other, text({ quote: first.json.message.id }));
    assert.deepEqual(foreign.json.error.fields, { quote: { code: "not_found" } });
    const elsewhere = await h.send(key, text({ to: "237690000009", quote: first.json.message.id }));
    assert.deepEqual(elsewhere.json.error.fields, { quote: { code: "not_found" } });
  });
});

describe("unknown fields are refused at every level, without echoing their name", () => {
  const nested = {
    text: [text({ extra: 1 }), { $unknown: { code: "unknown_field" } }],
    location: [{ format: "location", to: TO, latitude: 1, longitude: 2, extra: 1 }, { $unknown: { code: "unknown_field" } }],
    contact: [
      { format: "contact", to: TO, contacts: [{ name: "A", phones: ["237690000002"], extra: 1 }] },
      { "contacts.0.$unknown": { code: "unknown_field" } },
    ],
    poll: [{ format: "poll", to: TO, question: "Q", options: ["a", "b"], extra: 1 }, { $unknown: { code: "unknown_field" } }],
    buttons: [
      { format: "buttons", to: TO, text: "t", buttons: [{ id: "a", label: "A", extra: 1 }] },
      { "buttons.0.$unknown": { code: "unknown_field" } },
    ],
    list: [
      { format: "list", to: TO, text: "t", buttonLabel: "Open", choices: [{ id: "a", title: "A", extra: 1 }] },
      { "choices.0.$unknown": { code: "unknown_field" } },
    ],
    image: [{ format: "image", to: TO, media: { url: "https://files.example.com/a.png", extra: 1 } }, { "media.$unknown": { code: "unknown_field" } }],
  };
  for (const [format, [body, fields]] of Object.entries(nested)) {
    test(format, async () => {
      const res = await refused(format, body, fields);
      assert.equal(res.text.includes("extra"), false);
    });
  }

  test("idempotencyKey in the body is an unknown field (the header is the only way)", async () => {
    await refused("text", text({ idempotencyKey: "abc" }), { $unknown: { code: "unknown_field" } });
  });

  test("a field of another format is unknown too", async () => {
    await refused("text", text({ latitude: 4 }), { $unknown: { code: "unknown_field" } });
    await refused("location", { format: "location", to: TO, latitude: 4, longitude: 5, text: "x" }, { $unknown: { code: "unknown_field" } });
  });
});

describe("media formats", () => {
  for (const format of MEDIA_FORMATS) {
    test(`${format}: a valid sample is accepted and the right file part is required`, async () => {
      const captionable = ["image", "video", "gif", "document"].includes(format);
      await accepted(format, { format, to: TO, ...(captionable ? { caption: "ok" } : {}) });
      if (!captionable) await refused(format, { format, to: TO, caption: "no caption here" }, { $unknown: { code: "unknown_field" } });
    });
  }

  for (const format of ["image", "video", "gif", "document"]) {
    test(`${format}: caption 1 to 1,024, an empty caption is too_short`, async () => {
      await accepted(format, { format, to: TO, caption: "x" });
      await accepted(format, { format, to: TO, caption: rep("\u{1F600}", 1024) });
      await refused(format, { format, to: TO, caption: rep("x", 1025) }, { caption: { code: "too_long", params: { max: 1024 } } });
      await refused(format, { format, to: TO, caption: "" }, { caption: { code: "too_short", params: { min: 1 } } });
      await refused(format, { format, to: TO, caption: 5 }, { caption: { code: "invalid_type" } });
    });
  }

  test("document: fileName 1 to 255", async () => {
    await accepted("document", { format: "document", to: TO, fileName: "a" });
    await accepted("document", { format: "document", to: TO, fileName: rep("n", 255) });
    await refused("document", { format: "document", to: TO, fileName: rep("n", 256) }, { fileName: { code: "too_long", params: { max: 255 } } });
    await refused("document", { format: "document", to: TO, fileName: "" }, { fileName: { code: "too_short", params: { min: 1 } } });
  });

  test("media.url: a syntactically valid absolute URL of at most 2,048 characters", async () => {
    const base = { format: "image", to: TO };
    await refused("image", { ...base, media: { url: "not a url" } }, { "media.url": { code: "invalid_format" } });
    await refused("image", { ...base, media: { url: "/relative/a.png" } }, { "media.url": { code: "invalid_format" } });
    await refused("image", { ...base, media: { url: `https://files.example.com/${rep("a", 2048)}` } }, { "media.url": { code: "too_long", params: { max: 2048 } } });
    await refused("image", { ...base, media: {} }, { "media.url": { code: "required" } });
    await refused("image", { ...base, media: { url: 5 } }, { "media.url": { code: "invalid_type" } });
    await refused("image", { ...base, media: "https://files.example.com/a.png" }, { media: { code: "invalid_type" } });
    // a text has no media at all
    await refused("text", text({ media: { url: "https://files.example.com/a.png" } }), { $unknown: { code: "unknown_field" } });
  });

  test("media.url with a file (both) and neither: one source exactly", async () => {
    const neither = await h.send(key, { format: "image", to: TO });
    assert.deepEqual(neither.json.error.fields, { media: { code: "required" } });
    const png = await h.sampleFor("image");
    const both = await h.sendFile(key, { format: "image", to: TO, media: { url: "https://files.example.com/a.png" } }, png);
    assert.deepEqual(both.json.error.fields, { media: { code: "not_allowed" } });
  });
});

describe("location", () => {
  const loc = (extra) => ({ format: "location", to: TO, latitude: 4.0511, longitude: 9.7679, ...extra });
  test("latitude -90 to 90, longitude -180 to 180", async () => {
    await accepted("location", loc({ latitude: 90, longitude: 180 }));
    await accepted("location", loc({ latitude: -90, longitude: -180 }));
    await accepted("location", loc({ latitude: 0, longitude: 0 }));
    await refused("location", loc({ latitude: 90.0001 }), { latitude: { code: "out_of_range", params: { min: -90, max: 90 } } });
    await refused("location", loc({ latitude: -90.0001 }), { latitude: { code: "out_of_range", params: { min: -90, max: 90 } } });
    await refused("location", loc({ longitude: 180.5 }), { longitude: { code: "out_of_range", params: { min: -180, max: 180 } } });
    await refused("location", loc({ longitude: -181 }), { longitude: { code: "out_of_range", params: { min: -180, max: 180 } } });
    await refused("location", loc({ latitude: "4.05" }), { latitude: { code: "invalid_type" } });
    await refused("location", { format: "location", to: TO }, { latitude: { code: "required" }, longitude: { code: "required" } });
  });
  test("name and address: 1 to 256 characters", async () => {
    await accepted("location", loc({ name: rep("n", 256), address: rep("a", 256) }));
    await refused("location", loc({ name: rep("n", 257) }), { name: { code: "too_long", params: { max: 256 } } });
    await refused("location", loc({ address: "" }), { address: { code: "too_short", params: { min: 1 } } });
  });
});

describe("contact", () => {
  const card = (extra) => ({ name: "Acme Support", phones: ["+237 690 00 00 02"], ...extra });
  const contact = (contacts) => ({ format: "contact", to: TO, contacts });
  test("1 to 10 cards", async () => {
    await accepted("contact", contact([card()]));
    await accepted("contact", contact(Array.from({ length: 10 }, (_, i) => card({ name: `Card ${i}` }))));
    await refused("contact", contact(Array.from({ length: 11 }, () => card())), { contacts: { code: "too_many_items", params: { max: 10 } } });
    await refused("contact", contact([]), { contacts: { code: "too_short", params: { min: 1 } } });
    await refused("contact", { format: "contact", to: TO }, { contacts: { code: "required" } });
  });
  test("name 1 to 128, organization 1 to 128, email shape and 1 to 254", async () => {
    await accepted("contact", contact([card({ name: rep("n", 128), organization: rep("o", 128), email: "support@acme.example" })]));
    await refused("contact", contact([card({ name: rep("n", 129) })]), { "contacts.0.name": { code: "too_long", params: { max: 128 } } });
    await refused("contact", contact([card({ name: "" })]), { "contacts.0.name": { code: "too_short", params: { min: 1 } } });
    await refused("contact", contact([card({ organization: rep("o", 129) })]), { "contacts.0.organization": { code: "too_long", params: { max: 128 } } });
    await refused("contact", contact([card({ email: "not-an-email" })]), { "contacts.0.email": { code: "invalid_format" } });
    await refused("contact", contact([card({ email: `${rep("e", 250)}@a.bc` })]), { "contacts.0.email": { code: "too_long", params: { max: 254 } } });
    await refused("contact", contact([{ phones: ["237690000002"] }]), { "contacts.0.name": { code: "required" } });
  });
  test("phones: 1 to 5 numbers with a country code, distinct within the card", async () => {
    await accepted("contact", contact([card({ phones: [phone(1), phone(2), phone(3), phone(4), phone(5)] })]));
    await refused("contact", contact([card({ phones: [phone(1), phone(2), phone(3), phone(4), phone(5), phone(6)] })]), { "contacts.0.phones": { code: "too_many_items", params: { max: 5 } } });
    await refused("contact", contact([card({ phones: [] })]), { "contacts.0.phones": { code: "too_short", params: { min: 1 } } });
    await refused("contact", contact([card({ phones: [phone(1), "abc"] })]), { "contacts.0.phones.1": { code: "invalid_format" } });
    await refused("contact", contact([card({ phones: [phone(1), phone(2), "237690000001@g.us".replace("237690000001", "1203630")] })]), { "contacts.0.phones.2": { code: "invalid_format" } });
    await refused("contact", contact([card({ phones: [phone(1), phone(2), phone(1)] })]), { "contacts.0.phones.2": { code: "duplicate" } });
    await refused("contact", contact([card(), card({ phones: ["12"] })]), { "contacts.1.phones.0": { code: "invalid_format" } });
  });
});

describe("poll", () => {
  const poll = (extra) => ({ format: "poll", to: TO, question: "Which day?", options: ["Tuesday", "Thursday"], ...extra });
  test("question 1 to 255, 2 to 12 options of 1 to 100, distinct and case-sensitive", async () => {
    await accepted("poll", poll({ question: rep("q", 255) }));
    await accepted("poll", poll({ options: Array.from({ length: 12 }, (_, i) => `Option ${i}`) }));
    await accepted("poll", poll({ options: ["a", "A"], multiple: true }));
    await accepted("poll", poll({ options: [rep("o", 100), "other"] }));
    await refused("poll", poll({ question: rep("q", 256) }), { question: { code: "too_long", params: { max: 255 } } });
    await refused("poll", poll({ question: "" }), { question: { code: "too_short", params: { min: 1 } } });
    await refused("poll", poll({ options: ["only"] }), { options: { code: "too_short", params: { min: 2 } } });
    await refused("poll", poll({ options: Array.from({ length: 13 }, (_, i) => `Option ${i}`) }), { options: { code: "too_many_items", params: { max: 12 } } });
    await refused("poll", poll({ options: ["a", "b", "a"] }), { "options.2": { code: "duplicate" } });
    await refused("poll", poll({ options: ["a", " a "] }), { "options.1": { code: "duplicate" } });
    await refused("poll", poll({ options: ["a", rep("o", 101)] }), { "options.1": { code: "too_long", params: { max: 100 } } });
    await refused("poll", poll({ options: ["a", ""] }), { "options.1": { code: "too_short", params: { min: 1 } } });
    await refused("poll", poll({ multiple: "yes" }), { multiple: { code: "invalid_type" } });
  });
});

describe("buttons", () => {
  const buttons = (extra) => ({ format: "buttons", to: TO, text: "Do you confirm?", buttons: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], ...extra });
  test("text 1 to 1,024, 1 to 3 buttons, the composed body stays within 4,096", async () => {
    await accepted("buttons", buttons({ text: rep("\u{1F600}", 1024), buttons: [{ id: "a", label: rep("l", 20) }, { id: "b", label: rep("l", 20) }, { id: "c", label: rep("l", 20) }] }));
    await refused("buttons", buttons({ text: rep("x", 1025) }), { text: { code: "too_long", params: { max: 1024 } } });
    await refused("buttons", buttons({ buttons: [] }), { buttons: { code: "too_short", params: { min: 1 } } });
    await refused("buttons", buttons({ buttons: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }, { id: "d", label: "D" }] }), { buttons: { code: "too_many_items", params: { max: 3 } } });
  });
  test("button ids follow ^[A-Za-z0-9_.-]{1,64}$ and are distinct; labels are 1 to 20", async () => {
    await accepted("buttons", buttons({ buttons: [{ id: rep("i", 64), label: "A" }, { id: "a.b_c-d", label: "B" }] }));
    await refused("buttons", buttons({ buttons: [{ id: rep("i", 65), label: "A" }] }), { "buttons.0.id": { code: "invalid_format" } });
    await refused("buttons", buttons({ buttons: [{ id: "a b", label: "A" }] }), { "buttons.0.id": { code: "invalid_format" } });
    await refused("buttons", buttons({ buttons: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }), { "buttons.1.id": { code: "duplicate" } });
    await refused("buttons", buttons({ buttons: [{ id: "a", label: rep("l", 21) }] }), { "buttons.0.label": { code: "too_long", params: { max: 20 } } });
    await refused("buttons", buttons({ buttons: [{ id: "a", label: "" }] }), { "buttons.0.label": { code: "too_short", params: { min: 1 } } });
    await refused("buttons", buttons({ buttons: [{ label: "A" }] }), { "buttons.0.id": { code: "required" } });
  });
});

describe("list", () => {
  const choice = (n, extra) => ({ id: `slot-${n}`, title: `Slot ${n}`, ...extra });
  const list = (extra) => ({ format: "list", to: TO, text: "Choose a slot", buttonLabel: "See slots", choices: [choice(1), choice(2)], ...extra });
  test("text 1 to 1,024, buttonLabel 1 to 20, 1 to 10 choices", async () => {
    await accepted("list", list({ text: rep("\u{1F600}", 1024), buttonLabel: rep("b", 20), choices: Array.from({ length: 10 }, (_, i) => choice(i, { description: rep("d", 72) })) }));
    await refused("list", list({ text: rep("x", 1025) }), { text: { code: "too_long", params: { max: 1024 } } });
    await refused("list", list({ buttonLabel: rep("b", 21) }), { buttonLabel: { code: "too_long", params: { max: 20 } } });
    await refused("list", list({ buttonLabel: "" }), { buttonLabel: { code: "too_short", params: { min: 1 } } });
    await refused("list", list({ choices: Array.from({ length: 11 }, (_, i) => choice(i)) }), { choices: { code: "too_many_items", params: { max: 10 } } });
    await refused("list", list({ choices: [] }), { choices: { code: "too_short", params: { min: 1 } } });
  });
  test("choice id pattern and uniqueness, title 1 to 24, description 1 to 72", async () => {
    await accepted("list", list({ choices: [choice(1, { title: rep("t", 24) })] }));
    await refused("list", list({ choices: [choice(1, { id: "bad id" })] }), { "choices.0.id": { code: "invalid_format" } });
    await refused("list", list({ choices: [choice(1), choice(1)] }), { "choices.1.id": { code: "duplicate" } });
    await refused("list", list({ choices: [choice(1, { title: rep("t", 25) })] }), { "choices.0.title": { code: "too_long", params: { max: 24 } } });
    await refused("list", list({ choices: [choice(1, { description: rep("d", 73) })] }), { "choices.0.description": { code: "too_long", params: { max: 72 } } });
    await refused("list", list({ choices: [choice(1, { description: "" })] }), { "choices.0.description": { code: "too_short", params: { min: 1 } } });
    await refused("list", list({ choices: [{ id: "a" }] }), { "choices.0.title": { code: "required" } });
  });
});

describe("faults are reported together, and the common fields come first", () => {
  test("every fault of the request is listed at once under its dotted path", async () => {
    const res = await post("buttons", { format: "buttons", to: TO, text: "", buttons: [{ id: "a b", label: "" }, { id: "x" }] });
    assert.equal(res.res.status, 422);
    assert.deepEqual(Object.keys(res.res.json.error.fields).sort(), ["buttons.0.id", "buttons.0.label", "buttons.1.label", "text"]);
    assert.equal(res.grew, 0);
  });
  test("a bad wait appears next to the faults of the body", async () => {
    const res = await h.request("POST", "/api/v1/messages?wait=31", { key, body: { format: "location", to: TO } });
    assert.deepEqual(Object.keys(res.json.error.fields).sort(), ["latitude", "longitude", "wait"]);
  });
});
