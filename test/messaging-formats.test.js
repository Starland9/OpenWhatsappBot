"use strict";
/**
 * Feature 004 (messaging API): the format registry and the 13 format modules
 * (specs/004-messaging-api/contracts/runtime.md sections 3.1-3.9 and 18, public-api.md section 3).
 *
 * Part 1: the registry (boot failures naming the file, list/rights/rightsFor/schemaOf/describe/doc, a demo module
 * that needs no other edit). Later parts append one block per format.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111" });

const formats = require("../lib/messaging/formats");
const { createRegistry, FormatRegistryError } = formats;
const { check } = require("../lib/utils/schema");
const sniff = require("../lib/messaging/sniff");

const PN = "237690000001";
const tmpDirs = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-formats-"));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Source of a valid demo format; `extra` is appended last in the object literal, so it overrides */
function demoSource(extra = "", name = "demo") {
  return `"use strict";
module.exports = {
  name: ${JSON.stringify(name)},
  order: 5,
  fields: { note: { type: "string", maxLength: 10 } },
  build() { return { content: { text: "x" } }; },
  doc: { summary: "Demo", examples: [{ format: ${JSON.stringify(name)}, to: "${PN}", note: "hi" }] },
  ${extra}
};
`;
}

function writeFormats(files) {
  const dir = tmpDir();
  for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), source);
  return dir;
}

function loadFails(files, pattern) {
  const dir = writeFormats(files);
  const registry = createRegistry();
  assert.throws(
    () => registry.load({ dir }),
    (err) => {
      assert.ok(err instanceof FormatRegistryError, `FormatRegistryError expected, got ${err && err.name}`);
      assert.equal(typeof err.file, "string");
      assert.ok(err.file.endsWith(".js"), "the error names the file");
      assert.equal(typeof err.reason, "string");
      assert.ok(err.message.includes(err.file), "the message names the file");
      if (pattern) assert.match(err.reason, pattern);
      return true;
    },
  );
}

describe("registry: boot failures name the file (3.5)", () => {
  test("basename different from name", () => {
    loadFails({ "demo.js": demoSource("", "other") }, /basename|name/i);
  });

  test("invalid name", () => {
    loadFails({ "Bad.js": demoSource("", "Bad") }, /name/i);
    loadFails({ "x1.js": demoSource("", "1x") }, /name/i);
    loadFails({ "a.js": demoSource("", "a") }, /name/i);
    loadFails({ "demo.js": demoSource("name: 12") }, /name/i);
  });

  test("duplicate name", () => {
    loadFails({ "a_one.js": demoSource("", "a_one"), "a_two.js": demoSource("", "a_one") }, /duplicate/i);
  });

  test("build missing or not a function", () => {
    loadFails({ "demo.js": demoSource("build: undefined") }, /build/);
    loadFails({ "demo.js": demoSource("build: 3") }, /build/);
  });

  test("fields not an object of known rule types", () => {
    loadFails({ "demo.js": demoSource("fields: []") }, /fields/);
    loadFails({ "demo.js": demoSource("fields: 5") }, /fields/);
    loadFails({ "demo.js": demoSource('fields: { note: { type: "weird" } }') }, /fields|type/);
    loadFails({ "demo.js": demoSource('fields: { note: "string" }') }, /fields|rule/);
    loadFails(
      { "demo.js": demoSource('fields: { rows: { type: "array", items: { type: "object", shape: { x: { type: "nope" } } } } }') },
      /fields|type/,
    );
  });

  test("a field colliding with a common field", () => {
    for (const common of ["format", "to", "quote", "media"]) {
      loadFails({ "demo.js": demoSource(`fields: { ${common}: { type: "string" } }`) }, /common|collid/i);
    }
  });

  test("interactive without interpretReply", () => {
    loadFails({ "demo.js": demoSource("interactive: true") }, /interpretReply/);
    loadFails({ "demo.js": demoSource("interactive: true, interpretReply: 1") }, /interpretReply/);
  });

  test("media.kinds outside sniff.KINDS, maxBytes not a positive integer", () => {
    loadFails({ "demo.js": demoSource('media: { kinds: ["nope"], maxBytes: 100 }') }, /kinds/);
    loadFails({ "demo.js": demoSource("media: { kinds: [], maxBytes: 100 }") }, /kinds/);
    loadFails({ "demo.js": demoSource('media: { kinds: "image", maxBytes: 100 }') }, /kinds/);
    for (const bad of ["0", "-1", "1.5", '"10"', "NaN", "undefined"]) {
      loadFails({ "demo.js": demoSource(`media: { kinds: ["image"], maxBytes: ${bad} }`) }, /maxBytes/);
    }
  });

  test("prepare, refine, normalize, size, requires present but not functions", () => {
    for (const key of ["prepare", "refine", "normalize", "size", "requires"]) {
      loadFails({ "demo.js": demoSource(`${key}: 3`) }, new RegExp(key));
    }
  });

  test("order not a number", () => {
    loadFails({ "demo.js": demoSource('order: "x"') }, /order/);
    loadFails({ "demo.js": demoSource("order: NaN") }, /order/);
  });

  test("a module that declares a right is refused (RT-30)", () => {
    loadFails({ "demo.js": demoSource('right: "messages.send.other"') }, /right/);
  });

  test("a file that does not even load names itself", () => {
    loadFails({ "demo.js": "module.exports = { this is not javascript" }, /load|syntax/i);
  });

  test("a failed load keeps the previous state", () => {
    const good = writeFormats({ "demo.js": demoSource() });
    const bad = writeFormats({ "demo.js": demoSource("build: 3") });
    const registry = createRegistry();
    registry.load({ dir: good });
    assert.throws(() => registry.load({ dir: bad }), FormatRegistryError);
    assert.deepEqual(registry.list().map((row) => row.name), ["demo"]);
  });
});

describe("registry: list, get, rights, rightsFor", () => {
  let registry;

  before(() => {
    const dir = writeFormats({
      "zeta.js": demoSource("order: 20", "zeta"),
      "alpha.js": demoSource("order: 20", "alpha"),
      "first.js": demoSource("order: 1", "first"),
      "media_demo.js": demoSource('media: { kinds: ["image"], maxBytes: 1024, required: true, sources: ["file", "url"] }', "media_demo"),
      "inter_demo.js": demoSource("interactive: true, interpretReply() { return null; }", "inter_demo"),
      "needs.js": demoSource('requires(input) { return input && input.note === "x" ? ["media.url", "extra.right"] : []; }', "needs"),
      "index.js": "module.exports = { not: 'a format' };",
      "notes.txt": "ignored",
    });
    registry = createRegistry();
    registry.load({ dir });
  });

  test("list(): sorted by order then name, rows are { name, order, right, interactive, media }", () => {
    const rows = registry.list();
    assert.deepEqual(
      rows.map((row) => row.name),
      ["first", "alpha", "zeta", "inter_demo", "media_demo", "needs"].sort((a, b) => {
        const order = (n) => (n === "first" ? 1 : n === "media_demo" || n === "inter_demo" || n === "needs" ? 5 : 20);
        return order(a) - order(b) || (a < b ? -1 : 1);
      }),
    );
    for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["interactive", "media", "name", "order", "right"]);
    const media = rows.find((row) => row.name === "media_demo");
    assert.equal(media.media, true);
    assert.equal(media.right, "messages.send.media_demo");
    assert.equal(rows.find((row) => row.name === "alpha").media, false);
    assert.equal(rows.find((row) => row.name === "inter_demo").interactive, true);
    assert.equal(rows.find((row) => row.name === "alpha").interactive, false);
  });

  test("get(): the module or null; index.js and other files are not formats", () => {
    assert.equal(registry.get("alpha").name, "alpha");
    assert.equal(registry.get("index"), null);
    assert.equal(registry.get("notes"), null);
    assert.equal(registry.get("nope"), null);
  });

  test("rights() are derived from the names, in list order", () => {
    assert.deepEqual(
      registry.rights(),
      registry.list().map((row) => `messages.send.${row.name}`),
    );
  });

  test("rightsFor(): the format right, media.url for a URL marker, requires() extras, no duplicate", () => {
    assert.deepEqual(registry.rightsFor("alpha", { note: "a" }), ["messages.send.alpha"]);
    assert.deepEqual(registry.rightsFor("media_demo", { media: { url: "https://x.example.com/a.png" } }), ["messages.send.media_demo", "media.url"]);
    assert.deepEqual(registry.rightsFor("media_demo", {}), ["messages.send.media_demo"]);
    assert.deepEqual(registry.rightsFor("needs", { note: "x", media: { url: "u" } }), ["messages.send.needs", "media.url", "extra.right"]);
    assert.deepEqual(registry.rightsFor("needs", { note: "y" }), ["messages.send.needs"]);
    // tolerant of garbage: the pipeline calls it with the raw body before validation
    assert.deepEqual(registry.rightsFor("needs", null), ["messages.send.needs"]);
    assert.deepEqual(registry.rightsFor("alpha", "text"), ["messages.send.alpha"]);
    assert.deepEqual(registry.rightsFor("nope", {}), []);
  });

  test("an empty or missing directory loads zero formats", () => {
    const empty = createRegistry();
    empty.load({ dir: tmpDir() });
    assert.deepEqual(empty.list(), []);
    assert.deepEqual(empty.rights(), []);
  });
});

describe("registry: schemaOf, checkInput", () => {
  let registry;
  before(() => {
    const dir = writeFormats({
      "demo.js": demoSource('fields: { note: { type: "string", required: true, minLength: 1, maxLength: 10 }, flag: { type: "boolean", default: false } }, refine(input, ctx) { return input.note === "bad" ? { note: { code: "not_allowed" } } : (ctx.target && ctx.target.kind === "private" && input.flag ? { flag: { code: "not_allowed" } } : null); }, normalize(input) { return { ...input, note: input.note.toUpperCase() }; }'),
      "withmedia.js": demoSource('media: { kinds: ["image"], maxBytes: 1024, required: true, sources: ["file", "url"] }', "withmedia"),
    });
    registry = createRegistry();
    registry.load({ dir });
  });

  test("schemaOf(): the common fields plus the module fields; media only for a module that declares it", () => {
    const rules = registry.schemaOf("demo");
    assert.deepEqual(Object.keys(rules).sort(), ["flag", "format", "note", "quote", "to"]);
    assert.deepEqual(rules.format, { type: "string", required: true, enum: ["demo"] });
    assert.equal(rules.to.required, true);
    assert.equal(rules.to.maxLength, 64);
    assert.equal(rules.quote.pattern.test("msg_" + "A".repeat(22)), true);
    assert.equal(rules.quote.pattern.test("msg_" + "A".repeat(21)), false);
    assert.ok(Object.keys(registry.schemaOf("withmedia")).includes("media"));
    assert.deepEqual(Object.keys(registry.schemaOf("withmedia").media.shape), ["url"]);
    assert.equal(registry.schemaOf("nope"), null);
    assert.equal(registry.schemaOf("demo"), registry.schemaOf("demo"), "memoised");
  });

  test("schemaOf() validates through schema.check: unknown nested property at every level", () => {
    const rules = registry.schemaOf("withmedia");
    const ok = check({ format: "withmedia", to: PN, note: "hi", media: { url: "https://x.example.com/a.png" } }, rules);
    assert.deepEqual(ok.fields, {});
    const bad = check({ format: "withmedia", to: PN, media: { url: "https://x.example.com/a.png", extra: 1 }, other: 1 }, rules);
    assert.deepEqual(Object.keys(bad.fields).sort(), ["$unknown", "media.$unknown"]);
    assert.doesNotMatch(JSON.stringify(bad.fields), /extra|other/);
  });

  test("checkInput(): schema, media.url syntax, module refine, normalize last", () => {
    const target = { jid: `${PN}@s.whatsapp.net`, kind: "private", number: PN };
    const good = registry.checkInput("demo", { format: "demo", to: PN, note: "hi" }, { target });
    assert.deepEqual(good.fields, {});
    assert.deepEqual(good.own, { note: "HI", flag: false }, "own fields only, normalized");
    assert.equal(good.mediaMarker, false);
    assert.equal(good.value.to, PN);

    const refined = registry.checkInput("demo", { format: "demo", to: PN, note: "bad" }, { target });
    assert.deepEqual(refined.fields, { note: { code: "not_allowed" } });
    const ctxRefine = registry.checkInput("demo", { format: "demo", to: PN, note: "x", flag: true }, { target });
    assert.deepEqual(ctxRefine.fields, { flag: { code: "not_allowed" } });
    const noTarget = registry.checkInput("demo", { format: "demo", to: PN, note: "x", flag: true });
    assert.deepEqual(noTarget.fields, {}, "refine sees ctx.target = null");

    // every fault at once: the schema fault and the refine fault of another field
    const both = registry.checkInput("demo", { format: "demo", to: PN, note: "toolongtoolong", extra: 1 });
    assert.deepEqual(Object.keys(both.fields).sort(), ["$unknown", "note"]);

    const unknown = registry.checkInput("nope", { format: "nope" });
    assert.equal(unknown.fields.format.code, "not_allowed");
    assert.deepEqual(unknown.fields.format.params.allowed.sort(), ["demo", "withmedia"]);
  });

  test("checkInput(): media.url must be a syntactically valid absolute URL; the marker is reported", () => {
    const marker = registry.checkInput("withmedia", { format: "withmedia", to: PN, note: "a", media: { url: "https://x.example.com/a.png" } });
    assert.deepEqual(marker.fields, {});
    assert.equal(marker.mediaMarker, true);
    assert.deepEqual(marker.own, { note: "a" }, "the media marker is not an own field");
    for (const url of ["not a url", "/relative/path", "x.example.com/a.png", "//host/a"]) {
      const res = registry.checkInput("withmedia", { format: "withmedia", to: PN, note: "a", media: { url } });
      assert.deepEqual(res.fields, { "media.url": { code: "invalid_format" } }, url);
    }
    const missing = registry.checkInput("withmedia", { format: "withmedia", to: PN, note: "a", media: {} });
    assert.equal(missing.fields["media.url"].code, "required");
  });

  test("sizeOf(): the module's size(), else the media size, else null", () => {
    assert.equal(registry.sizeOf("demo", { note: "a" }, null), null);
    assert.equal(registry.sizeOf("demo", { note: "a" }, { size: 42 }), 42);
    assert.equal(registry.sizeOf("nope", {}, null), null);
  });
});

describe("registry: describe(name) and doc(name) (3.4)", () => {
  let registry;
  before(() => {
    const fields = `{
      title: { type: "string", required: true, minLength: 1, maxLength: 50 },
      body: { type: "string", maxLength: 300 },
      count: { type: "int", min: -5, max: 5 },
      ratio: { type: "number", min: 0, max: 1 },
      flag: { type: "boolean", default: false },
      kind: { type: "string", enum: ["a", "b"], default: "a" },
      tags: { type: "array", max: 5, unique: true, items: { type: "string", minLength: 1, maxLength: 20 } },
      cards: { type: "array", required: true, min: 1, max: 3, items: { type: "object", shape: { label: { type: "string", required: true, minLength: 1, maxLength: 10 }, nums: { type: "array", max: 4, items: { type: "int", min: 0, max: 9 } } } } },
    }`;
    const form = `{ hints: { title: { type: "phone", placeholderKey: "x.placeholder", patternHintKey: "x.pattern", step: 7, labelKey: "evil.key", required: false }, count: { step: 1 } } }`;
    const dir = writeFormats({
      "demo.js": demoSource(`fields: ${fields}, form: ${form}, doc: { summary: "S", description: "D", examples: [{ format: "demo", to: "${PN}", title: "t", cards: [{ label: "l" }] }] }`),
      "withmedia.js": demoSource('fields: { caption: { type: "string", minLength: 1, maxLength: 1024 } }, media: { kinds: ["image", "animated"], maxBytes: 2048, required: true, sources: ["file", "url"] }', "withmedia"),
      "nocaption.js": demoSource('fields: {}, media: { kinds: ["audio"], maxBytes: 4096 }', "nocaption"),
    });
    registry = createRegistry();
    registry.load({ dir });
  });

  test("shape of the descriptor", () => {
    const d = registry.describe("demo");
    assert.equal(d.name, "demo");
    assert.equal(d.right, "messages.send.demo");
    assert.equal(d.interactive, false);
    assert.equal(d.order, 5);
    assert.equal(d.labelKey, "api.format.demo.label");
    assert.equal(d.descKey, "api.format.demo.desc");
    assert.equal(d.media, null);
    assert.deepEqual(d.example, { format: "demo", to: PN, title: "t", cards: [{ label: "l" }] });
    assert.equal(registry.describe("demo"), registry.describe("demo"), "memoised");
    assert.equal(registry.describe("nope"), null);
  });

  test("`to` first with type recipient, `quote` last, format and media not listed", () => {
    const names = registry.describe("demo").fields.map((f) => f.name);
    assert.equal(names[0], "to");
    assert.equal(names.at(-1), "quote");
    assert.ok(!names.includes("format"));
    assert.ok(!registry.describe("withmedia").fields.some((f) => f.name === "media"));
    const to = registry.describe("demo").fields[0];
    assert.equal(to.type, "recipient");
    assert.equal(to.required, true);
    assert.equal(to.labelKey, "api.format.common.field.to.label");
    assert.equal(to.hintKey, "api.format.common.field.to.hint");
    const quote = registry.describe("demo").fields.at(-1);
    assert.equal(quote.type, "text");
    assert.equal(quote.required, false);
    assert.equal(quote.labelKey, "api.format.common.field.quote.label");
  });

  test("derivation: string, textarea above 255, int, number, boolean, enum, lists", () => {
    const by = Object.fromEntries(registry.describe("demo").fields.map((f) => [f.name, f]));
    assert.equal(by.body.type, "textarea");
    assert.equal(by.body.max, 300);
    assert.equal(by.count.type, "number");
    assert.equal(by.count.signed, true);
    assert.equal(by.count.min, -5);
    assert.equal(by.count.max, 5);
    assert.equal(by.ratio.type, "number");
    assert.notEqual(by.ratio.signed, true);
    assert.equal(by.flag.type, "boolean");
    assert.equal(by.flag.default, false);
    assert.equal(by.kind.type, "select");
    assert.deepEqual(by.kind.options.map((o) => o.value), ["a", "b"]);
    assert.deepEqual(by.kind.options.map((o) => o.labelKey), ["api.format.demo.field.kind.option.a", "api.format.demo.field.kind.option.b"]);
    assert.equal(by.kind.default, "a");
    assert.equal(by.title.required, true);
    assert.equal(by.title.min, 1);
    assert.equal(by.tags.type, "list");
    assert.equal(by.tags.max, 5);
    assert.equal(by.tags.item.type, "text");
    assert.equal(by.tags.item.max, 20);
    assert.equal(by.cards.type, "list");
    assert.equal(by.cards.min, 1);
    assert.equal(by.cards.max, 3);
    assert.equal(by.cards.items.min, 1);
    assert.equal(by.cards.items.max, 3);
    assert.deepEqual(by.cards.items.fields.map((f) => f.name), ["label", "nums"]);
    assert.equal(by.cards.items.fields[1].type, "list");
    assert.equal(by.cards.items.fields[1].item.type, "number");
  });

  test("label keys: api.format.<name>.field.<path>.label|hint, path = names joined by dots, no index", () => {
    const by = Object.fromEntries(registry.describe("demo").fields.map((f) => [f.name, f]));
    assert.equal(by.title.labelKey, "api.format.demo.field.title.label".replace("title", "title"));
    const label = by.cards.items.fields[0];
    assert.equal(label.labelKey, "api.format.demo.field.cards.label_field.label"); // a nested field named `label` gets the `_field` segment
    assert.equal(label.hintKey, "api.format.demo.field.cards.label_field.hint");
    assert.equal(by.cards.items.fields[1].item.labelKey, "api.format.demo.field.cards.nums.label");
  });

  test("form.hints override type, step, placeholderKey and patternHintKey, and nothing else", () => {
    const by = Object.fromEntries(registry.describe("demo").fields.map((f) => [f.name, f]));
    assert.equal(by.title.type, "phone");
    assert.equal(by.title.placeholderKey, "x.placeholder");
    assert.equal(by.title.patternHintKey, "x.pattern");
    assert.equal(by.title.step, 7);
    assert.equal(by.title.labelKey, "api.format.demo.field.title.label", "labelKey is not overridable");
    assert.equal(by.title.required, true, "required is not overridable");
    assert.equal(by.count.step, 1);
    assert.equal(by.count.type, "number");
  });

  test("media descriptor: sources, accept (union of the kinds' mimes), maxBytes, captionMax", () => {
    const m = registry.describe("withmedia").media;
    assert.deepEqual(m.sources, ["file", "url"]);
    assert.equal(m.maxBytes, 2048);
    assert.equal(m.captionMax, 1024);
    assert.deepEqual(m.accept.slice().sort(), [...sniff.KINDS.image, ...sniff.KINDS.animated].sort());
    const none = registry.describe("nocaption").media;
    assert.equal(none.captionMax, null);
    assert.deepEqual(none.sources, ["file", "url"], "default sources");
  });

  test("the descriptor is deeply frozen and JSON-serialisable", () => {
    const d = registry.describe("demo");
    assert.ok(Object.isFrozen(d));
    assert.ok(Object.isFrozen(d.fields));
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(d)));
  });

  test("doc(): summary, description, examples (English, for OpenAPI)", () => {
    const doc = registry.doc("demo");
    assert.equal(doc.summary, "S");
    assert.equal(doc.description, "D");
    assert.equal(doc.examples.length, 1);
    assert.equal(registry.doc("nope"), null);
  });
});

describe("registry: a new format is one file (SC-009)", () => {
  test("a demo module appears in list, rights, describe with no other edit", () => {
    const registry = createRegistry();
    registry.load();
    const before = registry.list().map((row) => row.name);
    const dir = writeFormats({});
    // the real directory plus one more file: copy the real modules into a temp dir and add the demo
    const realDir = path.join(__dirname, "..", "lib", "messaging", "formats");
    for (const file of fs.readdirSync(realDir).filter((f) => f.endsWith(".js") && f !== "index.js")) {
      fs.writeFileSync(path.join(dir, file), `module.exports = require(${JSON.stringify(path.join(realDir, file))});`);
    }
    fs.writeFileSync(path.join(dir, "demo_extra.js"), demoSource("order: 999", "demo_extra"));
    const extended = createRegistry();
    extended.load({ dir });
    assert.deepEqual(extended.list().map((row) => row.name), [...before, "demo_extra"]);
    assert.ok(extended.rights().includes("messages.send.demo_extra"));
    assert.equal(extended.describe("demo_extra").right, "messages.send.demo_extra");
    assert.equal(extended.schemaOf("demo_extra").format.enum[0], "demo_extra");
    assert.ok(!registry.rights().includes("messages.send.demo_extra"), "the default registry is untouched");
  });
});

describe("the loaded real formats (RT-31, RT-32)", () => {
  const registry = createRegistry();
  before(() => registry.load());

  test("every format loads; names are the basenames of the module files", () => {
    const names = registry.list().map((row) => row.name);
    const files = fs.readdirSync(path.join(__dirname, "..", "lib", "messaging", "formats")).filter((f) => f.endsWith(".js") && f !== "index.js");
    assert.deepEqual(names.slice().sort(), files.map((f) => f.replace(/\.js$/, "")).sort());
  });

  test("RT-32: doc.examples[0] validates against schemaOf (a media format's example is the JSON part of a multipart request)", () => {
    for (const { name } of registry.list()) {
      const example = registry.doc(name).examples[0];
      assert.ok(example, `${name}: has an example`);
      const result = check(example, registry.schemaOf(name));
      assert.deepEqual(result.fields, {}, `${name}: the example validates`);
      const full = registry.checkInput(name, example, {
        target: { jid: example.to.includes("@g.us") ? example.to : `${example.to}@s.whatsapp.net`, kind: example.to.includes("@g.us") ? "group" : "private", number: null },
      });
      assert.deepEqual(full.fields, {}, `${name}: the example passes refine`);
    }
  });

  test("RT-31/RT-30: rights and descriptors are derived; keys follow the convention", () => {
    for (const { name } of registry.list()) {
      const d = registry.describe(name);
      assert.equal(d.right, `messages.send.${name}`);
      assert.equal(d.labelKey, `api.format.${name}.label`);
      assert.equal(d.descKey, `api.format.${name}.desc`);
      const keys = [];
      const walk = (field) => {
        keys.push(field.labelKey, field.hintKey);
        if (field.item) walk(field.item);
        if (field.items) field.items.fields.forEach(walk);
      };
      d.fields.forEach(walk);
      for (const key of keys.filter(Boolean)) {
        assert.match(key, /^api\.format\.(common|[a-z][a-z0-9_]*)\.field\.[A-Za-z0-9_.]+\.(label|hint)$/, key);
      }
    }
  });
});

// ===========================================================================================================
// Shared helpers of the per-format parts
// ===========================================================================================================

const real = createRegistry();
const baileys = require("baileys");

const GROUP = "120363025246125486@g.us";
const privateTarget = { jid: `${PN}@s.whatsapp.net`, kind: "private", number: PN };
const groupTarget = { jid: GROUP, kind: "group", number: null };
const silentLogger = { level: "silent", info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return this; } };

/** Validate a body through the real registry; returns { fields, own, value, mediaMarker } */
function inputOf(name, body, target = privateTarget) {
  real.load();
  return real.checkInput(name, { format: name, to: target && target.kind === "group" ? GROUP : PN, ...body }, { target });
}

/** A body that must be valid: the own fields in stored form */
function ownOf(name, body, target = privateTarget) {
  const res = inputOf(name, body, target);
  assert.deepEqual(res.fields, {}, `${name}: ${JSON.stringify(res.fields)}`);
  return res.own;
}

/** Run Baileys' real content generator (offline for non-media); a spy proves getUrlInfo is never called */
async function generated(content) {
  const calls = [];
  const message = await baileys.generateWAMessageContent(content, {
    logger: silentLogger,
    getUrlInfo: async (...args) => {
      calls.push(args);
      return null;
    },
    upload: async () => assert.fail("no upload expected"),
  });
  return { message, urlCalls: calls.length };
}

const fieldsOf = (name, body, target) => inputOf(name, body, target).fields;

// ===========================================================================================================
// Part 2: the `text` format (3.2, 3.6, 9; public-api.md 3.2)
// ===========================================================================================================

describe("format text", () => {
  before(() => real.load());

  test("registered: order 10, derived right, not interactive, no media", () => {
    const row = real.list().find((r) => r.name === "text");
    assert.deepEqual(row, { name: "text", order: 10, right: "messages.send.text", interactive: false, media: false });
  });

  test("text 1-4096 code points: too_short / too_long with the path; trimmed; NFC", () => {
    assert.deepEqual(fieldsOf("text", {}), { text: { code: "required" } });
    assert.deepEqual(fieldsOf("text", { text: "" }), { text: { code: "too_short", params: { min: 1 } } });
    assert.deepEqual(fieldsOf("text", { text: "   " }), { text: { code: "too_short", params: { min: 1 } } });
    assert.deepEqual(fieldsOf("text", { text: "a".repeat(4096) }), {});
    assert.deepEqual(fieldsOf("text", { text: "a".repeat(4097) }), { text: { code: "too_long", params: { max: 4096 } } });
    assert.deepEqual(fieldsOf("text", { text: "😀".repeat(4096) }), {}, "code points, not UTF-16 units");
    assert.deepEqual(fieldsOf("text", { text: 12 }), { text: { code: "invalid_type" } });
    assert.equal(ownOf("text", { text: "  hello  " }).text, "hello");
    assert.equal(ownOf("text", { text: "é" }).text, "é");
  });

  test("mentions: at most 50 phone numbers; invalid number at its index", () => {
    const group = (body) => fieldsOf("text", { text: "hi", ...body }, groupTarget);
    assert.deepEqual(group({ mentions: Array.from({ length: 50 }, (_, i) => `2376900${String(10000 + i)}`) }), {});
    assert.deepEqual(group({ mentions: Array.from({ length: 51 }, (_, i) => `2376900${String(10000 + i)}`) }), { mentions: { code: "too_many_items", params: { max: 50 } } });
    assert.deepEqual(group({ mentions: [PN, "abc"] }), { "mentions.1": { code: "invalid_format" } });
    assert.deepEqual(group({ mentions: "237690000002" }), { mentions: { code: "invalid_type" } });
  });

  test("refine: mentions are not allowed on a private chat (an empty list is harmless)", () => {
    assert.deepEqual(fieldsOf("text", { text: "hi", mentions: ["237690000002"] }, privateTarget), { mentions: { code: "not_allowed" } });
    assert.deepEqual(fieldsOf("text", { text: "hi", mentions: [] }, privateTarget), {});
    assert.deepEqual(fieldsOf("text", { text: "hi", mentions: ["237690000002"] }, groupTarget), {});
    assert.deepEqual(fieldsOf("text", { text: "hi", mentions: ["237690000002"] }, null), {}, "no target yet: nothing to refuse");
  });

  test("normalize: mention numbers become digit strings", () => {
    const own = ownOf("text", { text: "hi @237690000002", mentions: ["+237 690 00 00 02", "00237690000003"] }, groupTarget);
    assert.deepEqual(own.mentions, ["237690000002", "237690000003"]);
  });

  test("linkPreview: boolean defaulting to false; true needs the media.url right", () => {
    assert.equal(ownOf("text", { text: "hi" }).linkPreview, false);
    assert.deepEqual(fieldsOf("text", { text: "hi", linkPreview: "yes" }), { linkPreview: { code: "invalid_type" } });
    assert.deepEqual(real.rightsFor("text", { text: "hi" }), ["messages.send.text"]);
    assert.deepEqual(real.rightsFor("text", { text: "hi", linkPreview: false }), ["messages.send.text"]);
    assert.deepEqual(real.rightsFor("text", { text: "hi", linkPreview: true }), ["messages.send.text", "media.url"]);
  });

  test("an unknown field is refused at its level without echoing it", () => {
    const fields = fieldsOf("text", { text: "hi", secretField: 1 });
    assert.deepEqual(fields, { $unknown: { code: "unknown_field" } });
  });

  test("size is the UTF-8 byte length of text", () => {
    assert.equal(real.sizeOf("text", { text: "héllo" }, null), 6);
    assert.equal(real.sizeOf("text", { text: "😀" }, null), 4);
  });

  test("build(): { text, linkPreview: null } and never a mention key without mentions", () => {
    const own = ownOf("text", { text: "Hello" });
    const built = real.get("text").build({ input: own, media: null, prepared: null, target: privateTarget, waId: "3EB0AAAA", mentions: [], preview: null });
    assert.deepEqual(built, { content: { text: "Hello", linkPreview: null } });
    assert.ok(!("mentions" in built.content));
  });

  test("build(): mention JIDs, and @number tokens rewritten for a LID member", () => {
    const own = ownOf("text", { text: "Hi @237690000010 and @237690000011, ping @237690000011", mentions: ["237690000010", "237690000011"] }, groupTarget);
    const built = real.get("text").build({
      input: own,
      media: null,
      prepared: null,
      target: groupTarget,
      waId: "3EB0AAAA",
      mentions: [
        { number: "237690000010", jid: "237690000010@s.whatsapp.net" },
        { number: "237690000011", jid: "888777@lid" },
      ],
      preview: null,
    });
    assert.deepEqual(built.content.mentions, ["237690000010@s.whatsapp.net", "888777@lid"]);
    assert.equal(built.content.text, "Hi @237690000010 and @888777, ping @888777");
    assert.equal(built.content.linkPreview, null);
  });

  test("build(): a prepared preview is attached as given", () => {
    const preview = { "matched-text": "https://example.com/a", "canonical-url": "https://example.com/a", title: "T", description: "D" };
    const built = real.get("text").build({ input: { text: "see https://example.com/a", linkPreview: true }, media: null, prepared: null, target: privateTarget, waId: "x", mentions: [], preview });
    assert.deepEqual(built.content.linkPreview, preview);
  });

  test("X16: through the REAL generateWAMessageContent, getUrlInfo is never called for a link", async () => {
    const own = ownOf("text", { text: "see https://example.com/a?x=1 now" });
    const { content } = real.get("text").build({ input: own, media: null, prepared: null, target: privateTarget, waId: "x", mentions: [], preview: null });
    const { message, urlCalls } = await generated(content);
    assert.equal(urlCalls, 0);
    const text = message.conversation || message.extendedTextMessage.text;
    assert.equal(text, "see https://example.com/a?x=1 now");
    // the control: without `linkPreview: null` Baileys does call getUrlInfo
    const control = await generated({ text: "see https://example.com/a?x=1 now" });
    assert.equal(control.urlCalls, 1);
  });

  test("RT-70: `.eval 1+1`, `!cmd` and a prefixed owner command pass verbatim", async () => {
    for (const text of [".eval 1+1", "!cmd arg", ".restart", "/start", "$ rm -rf /"]) {
      const own = ownOf("text", { text });
      assert.equal(own.text, text);
      const { content } = real.get("text").build({ input: own, media: null, prepared: null, target: privateTarget, waId: "x", mentions: [], preview: null });
      assert.equal(content.text, text);
      const { message } = await generated(content);
      assert.equal(message.conversation || message.extendedTextMessage.text, text);
    }
  });

  test("descriptor: a textarea (maxLength above 255) with keys api.format.text.*", () => {
    const d = real.describe("text");
    const text = d.fields.find((f) => f.name === "text");
    assert.equal(text.type, "textarea");
    assert.equal(text.max, 4096);
    assert.equal(text.min, 1);
    assert.equal(text.required, true);
    assert.equal(text.labelKey, "api.format.text.field.text.label");
    assert.equal(d.labelKey, "api.format.text.label");
    const mentions = d.fields.find((f) => f.name === "mentions");
    assert.equal(mentions.type, "list");
    assert.equal(mentions.max, 50);
    assert.equal(d.fields.find((f) => f.name === "linkPreview").type, "boolean");
    assert.equal(d.media, null);
  });

  test("the doc example of public-api.md 3.2 validates and builds", async () => {
    const example = real.doc("text").examples[0];
    assert.deepEqual(example, {
      format: "text",
      to: "237690000001",
      text: "Hello Awa, your order #4821 has shipped. Tracking: https://track.example.com/4821",
    });
    const res = real.checkInput("text", example, { target: privateTarget });
    assert.deepEqual(res.fields, {});
    const { content } = real.get("text").build({ input: res.own, media: null, prepared: null, target: privateTarget, waId: "x", mentions: [], preview: null });
    const { urlCalls } = await generated(content);
    assert.equal(urlCalls, 0);
  });
});

describe("lib/messaging/** never reads the command prefix (RT-70)", () => {
  test("no module of this agent mentions config.PREFIX", () => {
    const root = path.join(__dirname, "..", "lib", "messaging");
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name));
        else if (entry.name.endsWith(".js")) files.push(path.join(dir, entry.name));
      }
    };
    walk(root);
    for (const file of files) assert.doesNotMatch(fs.readFileSync(file, "utf8"), /config\.PREFIX|\bPREFIX\b/, path.relative(root, file));
  });
});

// ===========================================================================================================
// Part 3: the seven media formats (3.3, 3.6; public-api.md 3.3, 18)
// ===========================================================================================================

const { spawnSync } = require("node:child_process");
const { LIMITS } = require("../lib/messaging/limits");
const stageModule = require("../lib/messaging/stage");

const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const MB = LIMITS.MB;
const STAGE_DIR = path.join(os.tmpdir(), "owb-stage-fake", "msg_" + "A".repeat(22));
const fakeMedia = (mime, ext, extra = {}) => ({ path: path.join(STAGE_DIR, "source"), mime, ext, kind: "x", size: 1234, ...extra });

function buildOf(name, body, media, extra = {}) {
  return real.get(name).build({ input: ownOf(name, body), media, prepared: null, target: privateTarget, waId: "3EB0AAAA", mentions: [], preview: null, dir: STAGE_DIR, ...extra });
}

describe("media formats: registration and declarations", () => {
  before(() => real.load());

  const TABLE = [
    // name, order, kinds, maxBytes, caption, fileName
    ["image", 20, ["image"], 16 * MB, true, false],
    ["video", 30, ["video"], 16 * MB, true, false],
    ["gif", 40, ["animated", "video"], 16 * MB, true, false],
    ["audio", 50, ["audio"], 16 * MB, false, false],
    ["voice", 60, ["audio_or_container"], 16 * MB, false, false],
    ["document", 70, ["document"], 100 * MB, true, true],
    ["sticker", 80, ["image"], 10 * MB, false, false],
  ];

  for (const [name, order, kinds, maxBytes, caption, fileName] of TABLE) {
    test(`${name}: order ${order}, derived right, media ${kinds.join("+")} up to ${maxBytes / MB} MB, required, file or URL`, () => {
      const row = real.list().find((r) => r.name === name);
      assert.deepEqual(row, { name, order, right: `messages.send.${name}`, interactive: false, media: true });
      const mod = real.get(name);
      assert.deepEqual(mod.media, { kinds, maxBytes, required: true, sources: ["file", "url"] });
      assert.deepEqual(Object.keys(mod.fields || {}).sort(), [...(caption ? ["caption"] : []), ...(fileName ? ["fileName"] : [])].sort());
      assert.equal(typeof mod.build, "function");
      assert.equal(mod.interactive, false);
    });
  }

  test("the caps are the LIMITS.MEDIA_MAX entries", () => {
    for (const [name, , , maxBytes] of TABLE) assert.equal(LIMITS.MEDIA_MAX[name], maxBytes, name);
  });

  test("caption 1-1024 (image, video, gif, document): an empty string is too_short, 1025 too_long", () => {
    for (const name of ["image", "video", "gif", "document"]) {
      assert.deepEqual(fieldsOf(name, {}), {}, `${name}: the caption is optional`);
      assert.deepEqual(fieldsOf(name, { caption: "" }), { caption: { code: "too_short", params: { min: 1 } } }, name);
      assert.deepEqual(fieldsOf(name, { caption: "c".repeat(1024) }), {}, name);
      assert.deepEqual(fieldsOf(name, { caption: "c".repeat(1025) }), { caption: { code: "too_long", params: { max: 1024 } } }, name);
      assert.deepEqual(fieldsOf(name, { caption: 7 }), { caption: { code: "invalid_type" } }, name);
    }
  });

  test("audio, voice and sticker take no caption: the field is unknown", () => {
    for (const name of ["audio", "voice", "sticker"]) assert.deepEqual(fieldsOf(name, { caption: "x" }), { $unknown: { code: "unknown_field" } }, name);
  });

  test("document fileName 1-255", () => {
    assert.deepEqual(fieldsOf("document", { fileName: "" }), { fileName: { code: "too_short", params: { min: 1 } } });
    assert.deepEqual(fieldsOf("document", { fileName: "n".repeat(255) }), {});
    assert.deepEqual(fieldsOf("document", { fileName: "n".repeat(256) }), { fileName: { code: "too_long", params: { max: 255 } } });
    assert.deepEqual(fieldsOf("image", { fileName: "x.png" }), { $unknown: { code: "unknown_field" } });
  });

  test("media.url is a URL marker only: a valid one passes, needs the media.url right; neither the file nor the URL is validated here", () => {
    for (const [name] of TABLE) {
      const res = inputOf(name, { media: { url: "https://files.example.com/a.bin" } });
      assert.deepEqual(res.fields, {}, name);
      assert.equal(res.mediaMarker, true, name);
      assert.deepEqual(real.rightsFor(name, { media: { url: "https://files.example.com/a.bin" } }), [`messages.send.${name}`, "media.url"], name);
      assert.deepEqual(real.rightsFor(name, {}), [`messages.send.${name}`], name);
      assert.deepEqual(inputOf(name, { media: { url: "nope" } }).fields, { "media.url": { code: "invalid_format" } }, name);
      assert.deepEqual(inputOf(name, { media: { url: "" } }).fields, { "media.url": { code: "too_short", params: { min: 1 } } }, name);
      assert.deepEqual(inputOf(name, { media: { url: `https://x.example.com/${"a".repeat(2048)}` } }).fields, { "media.url": { code: "too_long", params: { max: 2048 } } }, name);
      assert.deepEqual(inputOf(name, { media: { url: "https://x.example.com/a", extra: 1 } }).fields, { "media.$unknown": { code: "unknown_field" } }, name);
    }
  });

  test("size is the staged file size", () => {
    for (const [name] of TABLE) assert.equal(real.sizeOf(name, {}, { size: 4242 }), 4242, name);
  });

  test("descriptors: media { sources, accept, maxBytes, captionMax } and the field keys", () => {
    const sniff = require("../lib/messaging/sniff");
    const image = real.describe("image").media;
    assert.deepEqual(image.sources, ["file", "url"]);
    assert.deepEqual(image.accept, [...sniff.KINDS.image].sort());
    assert.equal(image.maxBytes, 16 * MB);
    assert.equal(image.captionMax, 1024);
    assert.equal(real.describe("audio").media.captionMax, null);
    assert.equal(real.describe("document").media.maxBytes, 100 * MB);
    assert.deepEqual(real.describe("gif").media.accept, [...new Set([...sniff.KINDS.animated, ...sniff.KINDS.video])].sort());
    const caption = real.describe("image").fields.find((f) => f.name === "caption");
    assert.equal(caption.type, "textarea");
    assert.equal(caption.labelKey, "api.format.image.field.caption.label");
    assert.ok(!real.describe("image").fields.some((f) => f.name === "media"));
  });
});

describe("media formats: build() content", () => {
  before(() => real.load());

  const SOURCE = path.join(STAGE_DIR, "source");

  test("image and video: { <kind>: { url }, caption?, mimetype } with the DETECTED mimetype", () => {
    assert.deepEqual(buildOf("image", { caption: "Your receipt" }, fakeMedia("image/png", "png")).content, { image: { url: SOURCE }, caption: "Your receipt", mimetype: "image/png" });
    assert.deepEqual(buildOf("image", {}, fakeMedia("image/webp", "webp")).content, { image: { url: SOURCE }, mimetype: "image/webp" });
    assert.deepEqual(buildOf("video", { caption: "Saturday" }, fakeMedia("video/quicktime", "mov")).content, { video: { url: SOURCE }, caption: "Saturday", mimetype: "video/quicktime" });
    assert.deepEqual(buildOf("video", {}, fakeMedia("video/3gpp", "3gp")).content, { video: { url: SOURCE }, mimetype: "video/3gpp" });
  });

  test("audio: { audio: { url }, mimetype, ptt: false }; audio/x-m4a is sent as audio/mp4", () => {
    assert.deepEqual(buildOf("audio", {}, fakeMedia("audio/mpeg", "mp3")).content, { audio: { url: SOURCE }, mimetype: "audio/mpeg", ptt: false });
    assert.deepEqual(buildOf("audio", {}, fakeMedia("audio/x-m4a", "m4a")).content, { audio: { url: SOURCE }, mimetype: "audio/mp4", ptt: false });
    assert.deepEqual(buildOf("audio", {}, fakeMedia("audio/ogg; codecs=opus", "opus")).content.mimetype, "audio/ogg; codecs=opus");
  });

  test("gif: gifPlayback with video/mp4; the prepared MP4 when there is one, the source MP4/MOV otherwise", () => {
    const prepared = { path: path.join(STAGE_DIR, "prepared.mp4"), mime: "video/mp4", ext: "mp4" };
    assert.deepEqual(buildOf("gif", { caption: "Done!" }, fakeMedia("image/gif", "gif"), { prepared }).content, {
      video: { url: prepared.path },
      gifPlayback: true,
      caption: "Done!",
      mimetype: "video/mp4",
    });
    assert.deepEqual(buildOf("gif", {}, fakeMedia("video/quicktime", "mov")).content, { video: { url: SOURCE }, gifPlayback: true, mimetype: "video/mp4" });
  });

  test("voice: the prepared Ogg/Opus as a voice note; no prepared file is a conversion failure, never the source", () => {
    const prepared = { path: path.join(STAGE_DIR, "prepared.ogg"), mime: "audio/ogg; codecs=opus", ext: "ogg" };
    assert.deepEqual(buildOf("voice", {}, fakeMedia("audio/mpeg", "mp3"), { prepared }).content, { audio: { url: prepared.path }, mimetype: "audio/ogg; codecs=opus", ptt: true });
    assert.throws(() => buildOf("voice", {}, fakeMedia("audio/mpeg", "mp3")), (err) => err.code === "media_conversion_failed");
  });

  test("sticker: { sticker: { url: webp } } from the prepared file only", () => {
    const prepared = { path: path.join(STAGE_DIR, "prepared.webp"), mime: "image/webp", ext: "webp" };
    assert.deepEqual(buildOf("sticker", {}, fakeMedia("image/png", "png"), { prepared }).content, { sticker: { url: prepared.path } });
    assert.throws(() => buildOf("sticker", {}, fakeMedia("image/png", "png")), (err) => err.code === "media_conversion_failed");
  });

  test("document: mimetype from the bytes, fileName through broadcaster.sanitizeName, caption optional", () => {
    const pdf = fakeMedia("application/pdf", "pdf", { name: "from-the-upload.pdf" });
    assert.deepEqual(buildOf("document", { caption: "Invoice", fileName: "invoice-2026-0042.pdf" }, pdf).content, {
      document: { url: SOURCE },
      mimetype: "application/pdf",
      fileName: "invoice-2026-0042.pdf",
      caption: "Invoice",
    });
    assert.equal(buildOf("document", {}, pdf).content.fileName, "from-the-upload.pdf", "the multipart filename when no fileName is given");
    assert.equal(buildOf("document", {}, fakeMedia("application/pdf", "pdf")).content.fileName, "file.pdf", "else `file` plus the detected extension");
    assert.equal(buildOf("document", {}, fakeMedia("text/csv", "csv")).content.fileName, "file.csv");
    assert.equal(buildOf("document", { fileName: "../../etc/passwd" }, pdf).content.fileName, "passwd");
    assert.equal(buildOf("document", { fileName: "a\u0000b\r\nc<>:|?*.pdf" }, pdf).content.fileName, "a_b__c______.pdf");
    assert.equal(buildOf("document", { fileName: "...hidden.pdf" }, pdf).content.fileName, "hidden.pdf");
    assert.ok(Array.from(buildOf("document", { fileName: `${"x".repeat(200)}.pdf` }, pdf).content.fileName).length <= 100);
    assert.equal(buildOf("document", { fileName: "  spaced   out.pdf " }, pdf).content.fileName, "spaced out.pdf");
    assert.ok(!("caption" in buildOf("document", {}, pdf).content));
  });

  test("RT-101: the url handed to Baileys is the staged absolute path, never an http(s) string, never outside the stage directory", () => {
    for (const name of ["image", "video", "audio", "document"]) {
      const media = (path_) => fakeMedia(name === "document" ? "application/pdf" : "image/png", "x", { path: path_ });
      for (const bad of ["https://example.com/a.png", "http://127.0.0.1/a", "file:///etc/passwd", "relative/source", path.join(STAGE_DIR, "..", "other", "source"), "/etc/passwd", ""]) {
        assert.throws(() => buildOf(name, {}, media(bad)), (err) => err.code === "outside_root", `${name}: ${bad}`);
      }
    }
    const prepared = (p) => ({ path: p, mime: "video/mp4", ext: "mp4" });
    assert.throws(() => buildOf("gif", {}, fakeMedia("image/gif", "gif"), { prepared: prepared("https://example.com/a.mp4") }), (err) => err.code === "outside_root");
    assert.throws(() => buildOf("voice", {}, fakeMedia("audio/mpeg", "mp3"), { prepared: prepared("/etc/passwd") }), (err) => err.code === "outside_root");
    assert.throws(() => buildOf("sticker", {}, fakeMedia("image/png", "png"), { prepared: prepared(path.join(STAGE_DIR, "..", "x.webp")) }), (err) => err.code === "outside_root");
  });

  test("no content ever carries a caller-controlled name outside `fileName`, and no format sets linkPreview", () => {
    const pdf = fakeMedia("application/pdf", "pdf");
    assert.ok(!JSON.stringify(buildOf("image", { caption: "c" }, fakeMedia("image/png", "png")).content).includes("linkPreview"));
    assert.ok(!JSON.stringify(buildOf("document", {}, pdf).content).includes("source/"));
  });
});

describe("media formats: prepare()", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "owb-prepare-"));
  after(() => fs.rmSync(work, { recursive: true, force: true }));
  const sniff = require("../lib/messaging/sniff");

  function stageDirectory(name) {
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const ffmpeg = (args) => spawnSync("ffmpeg", ["-y", "-nostdin", "-loglevel", "error", ...args], { stdio: "ignore" }).status === 0;

  test("gif: the exact ffmpeg command of 3.6, run for a GIF only; MP4 and MOV are used as they are", async () => {
    real.load();
    const dir = stageDirectory("gif-command");
    const calls = [];
    const fake = {
      runFfmpeg: async (args) => {
        calls.push(args);
        fs.writeFileSync(args.at(-1), Buffer.from("fake mp4 bytes"));
        return { stdout: Buffer.alloc(0) };
      },
    };
    const source = path.join(dir, "source");
    fs.writeFileSync(source, "GIF89a");
    const out = await real.get("gif").prepare({ input: {}, media: { path: source, mime: "image/gif", ext: "gif", size: 6 }, dir, ffmpeg: fake });
    assert.deepEqual(out, { path: path.join(dir, "prepared.mp4"), mime: "video/mp4", ext: "mp4" });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      "-i", source, "-movflags", "+faststart", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", path.join(dir, "prepared.mp4"),
    ]);
    for (const mime of ["video/mp4", "video/quicktime"]) {
      assert.equal(await real.get("gif").prepare({ input: {}, media: { path: source, mime, ext: "mp4", size: 6 }, dir, ffmpeg: fake }), null);
    }
    assert.equal(calls.length, 1, "no conversion for an MP4 or MOV");
  });

  test("gif: a failing or empty conversion throws (media_conversion_failed at the engine)", async () => {
    const dir = stageDirectory("gif-fail");
    const source = path.join(dir, "source");
    fs.writeFileSync(source, "GIF89a");
    const media = { path: source, mime: "image/gif", ext: "gif", size: 6 };
    await assert.rejects(real.get("gif").prepare({ input: {}, media, dir, ffmpeg: { runFfmpeg: async () => { throw Object.assign(new Error("ffmpeg failed (code 1)"), { exitCode: 1 }); } } }), /ffmpeg failed/);
    await assert.rejects(real.get("gif").prepare({ input: {}, media, dir, ffmpeg: { runFfmpeg: async () => {} } }), (err) => err.code === "ENOENT", "no output file");
    await assert.rejects(real.get("gif").prepare({ input: {}, media, dir, ffmpeg: { runFfmpeg: async (args) => fs.writeFileSync(args.at(-1), "") } }), /empty/);
    await assert.rejects(real.get("gif").prepare({ input: {}, media, dir, ffmpeg: { runFfmpeg: async () => { throw Object.assign(new Error("ffmpeg not found"), { code: "ENOENT" }); } } }), (err) => err.code === "ENOENT");
  });

  test("gif: a real GIF becomes a playable MP4 inside the stage directory", { skip: !HAS_FFMPEG && "ffmpeg missing" }, async () => {
    const dir = stageDirectory("gif-real");
    const source = path.join(dir, "source");
    assert.ok(ffmpeg(["-f", "lavfi", "-i", "testsrc=duration=1:size=63x47:rate=5", source + ".gif"]));
    fs.renameSync(source + ".gif", source);
    const media = { path: source, mime: "image/gif", ext: "gif", size: fs.statSync(source).size };
    const out = await real.get("gif").prepare({ input: {}, media, dir });
    assert.equal(out.path, path.join(dir, "prepared.mp4"));
    assert.equal((await sniff.classify(out.path, {})).mime, "video/mp4");
    assert.ok(fs.statSync(out.path).size > 0);
    assert.doesNotThrow(() => stageModule.assertStaged(out.path, dir));
    const built = real.get("gif").build({ input: {}, media, prepared: out, dir });
    assert.deepEqual(built.content.video, { url: out.path });
  });

  test("voice: toOpusVoice written as prepared.ogg inside the stage directory", async () => {
    const dir = stageDirectory("voice-fake");
    const source = path.join(dir, "source");
    fs.writeFileSync(source, "audio bytes");
    const seen = [];
    const out = await real.get("voice").prepare({
      input: {},
      media: { path: source, mime: "audio/mpeg", ext: "mp3", size: 11 },
      dir,
      ffmpeg: { toOpusVoice: async (buffer) => (seen.push(buffer.toString()), Buffer.from("OggS fake opus")) },
    });
    assert.deepEqual(out, { path: path.join(dir, "prepared.ogg"), mime: "audio/ogg; codecs=opus", ext: "ogg" });
    assert.deepEqual(seen, ["audio bytes"]);
    assert.equal(fs.readFileSync(out.path, "utf8"), "OggS fake opus");
    await assert.rejects(real.get("voice").prepare({ input: {}, media: { path: source }, dir, ffmpeg: { toOpusVoice: async () => Buffer.alloc(0) } }), /empty/);
    await assert.rejects(real.get("voice").prepare({ input: {}, media: { path: source }, dir, ffmpeg: { toOpusVoice: async () => { throw new Error("ffmpeg failed (code 183)"); } } }), /ffmpeg failed/);
  });

  test("voice: a real MP3 and a real WebM become Ogg/Opus; garbage is a conversion failure", { skip: !HAS_FFMPEG && "ffmpeg missing" }, async () => {
    for (const ext of ["mp3", "webm", "m4a", "wav"]) {
      const dir = stageDirectory(`voice-real-${ext}`);
      const source = path.join(dir, "source");
      const codec = ext === "webm" ? ["-c:a", "libopus"] : ext === "m4a" ? ["-c:a", "aac"] : [];
      assert.ok(ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", ...codec, `${source}.${ext}`]), ext);
      fs.renameSync(`${source}.${ext}`, source);
      const out = await real.get("voice").prepare({ input: {}, media: { path: source, mime: "audio/x", ext, size: 1 }, dir });
      assert.equal((await sniff.classify(out.path, {})).mime, "audio/ogg; codecs=opus", ext);
    }
    const dir = stageDirectory("voice-garbage");
    const source = path.join(dir, "source");
    fs.writeFileSync(source, crypto.randomBytes(2048));
    await assert.rejects(real.get("voice").prepare({ input: {}, media: { path: source, mime: "audio/mpeg", ext: "mp3", size: 2048 }, dir }));
  });

  test("sticker: imageToWebp then withStickerExif, at most 900 KiB; null or a thrown error is a conversion failure", async () => {
    const dir = stageDirectory("sticker-fake");
    const source = path.join(dir, "source");
    fs.writeFileSync(source, "image bytes");
    const media = { path: source, mime: "image/png", ext: "png", size: 11 };
    const order = [];
    const maker = {
      imageToWebp: async (buffer) => (order.push(`webp:${buffer.toString()}`), Buffer.from("WEBP")),
      withStickerExif: async (buffer) => (order.push(`exif:${buffer.toString()}`), Buffer.from("WEBP+EXIF")),
    };
    const out = await real.get("sticker").prepare({ input: {}, media, dir, stickerMaker: maker });
    assert.deepEqual(order, ["webp:image bytes", "exif:WEBP"]);
    assert.deepEqual(out, { path: path.join(dir, "prepared.webp"), mime: "image/webp", ext: "webp" });
    assert.equal(fs.readFileSync(out.path, "utf8"), "WEBP+EXIF");
    await assert.rejects(real.get("sticker").prepare({ input: {}, media, dir, stickerMaker: { ...maker, imageToWebp: async () => null } }), /fit/);
    await assert.rejects(real.get("sticker").prepare({ input: {}, media, dir, stickerMaker: { ...maker, withStickerExif: async () => Buffer.alloc(LIMITS.STICKER_OUT + 1) } }), /large/);
    await assert.rejects(real.get("sticker").prepare({ input: {}, media, dir, stickerMaker: { ...maker, imageToWebp: async () => { throw new Error("unsupported image format"); } } }), /unsupported/);
  });

  test("sticker: a real picture becomes a 512x512 WebP with the pack and author read at call time; garbage throws", async () => {
    const sharp = require("sharp");
    const config = require("../config");
    const dir = stageDirectory("sticker-real");
    const source = path.join(dir, "source");
    fs.writeFileSync(source, await sharp({ create: { width: 64, height: 40, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer());
    const media = { path: source, mime: "image/png", ext: "png", size: fs.statSync(source).size };
    const originalPack = config.STICKER_PACKNAME;
    try {
      config.STICKER_PACKNAME = "PackOne";
      const first = await real.get("sticker").prepare({ input: {}, media, dir });
      const bytes = fs.readFileSync(first.path);
      assert.ok(bytes.length <= LIMITS.STICKER_OUT);
      assert.equal((await sniff.classify(first.path, {})).mime, "image/webp");
      assert.deepEqual(await sharp(bytes).metadata().then((m) => [m.width, m.height]), [512, 512]);
      assert.ok(bytes.includes(Buffer.from("PackOne")));
      config.STICKER_PACKNAME = "PackTwo";
      const second = await real.get("sticker").prepare({ input: {}, media, dir });
      assert.ok(fs.readFileSync(second.path).includes(Buffer.from("PackTwo")));
    } finally {
      config.STICKER_PACKNAME = originalPack;
    }
    const garbage = stageDirectory("sticker-garbage");
    const bad = path.join(garbage, "source");
    fs.writeFileSync(bad, crypto.randomBytes(512));
    await assert.rejects(real.get("sticker").prepare({ input: {}, media: { path: bad, mime: "image/png", ext: "png", size: 512 }, dir: garbage }));
  });
});

describe("text.prepare: the link preview (X16)", () => {
  before(() => real.load());
  const prepare = (text, extra = {}) => real.get("text").prepare({ input: { text, linkPreview: true }, media: null, dir: null, ...extra });
  const preview = { "matched-text": "https://example.com/a", "canonical-url": "https://example.com/a", title: "T" };

  test("only for linkPreview: true; otherwise null and the fetcher is never asked", async () => {
    const fetcher = { fetchPreview: async () => assert.fail("not asked") };
    assert.equal(await real.get("text").prepare({ input: { text: "see https://example.com/a", linkPreview: false }, fetcher }), null);
    assert.equal(await real.get("text").prepare({ input: { text: "see https://example.com/a" }, fetcher }), null);
  });

  test("the first https link of the text, without the punctuation that ends the sentence", async () => {
    const asked = [];
    const fetcher = { fetchPreview: async (url, opts) => (asked.push([url, typeof opts.signal]), preview) };
    assert.deepEqual(await prepare("Look: https://example.com/a. And https://other.example.org/b", { fetcher }), { preview });
    assert.deepEqual(await prepare("(see https://example.com/a?x=1&y=2), thanks", { fetcher }), { preview });
    assert.deepEqual(asked, [["https://example.com/a", "object"], ["https://example.com/a?x=1&y=2", "object"]]);
  });

  test("no https link: no preview and no fetch (http links and bare domains are not fetched)", async () => {
    const fetcher = { fetchPreview: async () => assert.fail("not asked") };
    assert.equal(await prepare("no link at all", { fetcher }), null);
    assert.equal(await prepare("http://example.com/a and example.com/b", { fetcher }), null);
  });

  test("a refusal, a failure, a null answer or a hang never fails the message", async () => {
    assert.equal(await prepare("https://example.com/a", { fetcher: { fetchPreview: async () => null } }), null);
    assert.equal(await prepare("https://example.com/a", { fetcher: { fetchPreview: async () => { throw new Error("boom"); } } }), null);
    const { MessagingError } = require("../lib/messaging/errors");
    assert.equal(await prepare("https://127.0.0.1/a", { fetcher: { fetchPreview: async () => { throw new MessagingError("url_forbidden", { params: { reason: "host" } }); } } }), null);
    // the caller's signal reaches the fetcher, so an abort ends it
    const controller = new AbortController();
    const hanging = { fetchPreview: (url, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(null))) };
    const pending = prepare("https://example.com/a", { fetcher: hanging, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    assert.equal(await pending, null);
  });

  test("the default fetcher is the SSRF-safe one: a link to a local address is simply no preview", async () => {
    assert.equal(await prepare("https://127.0.0.1/a and https://localhost/b"), null);
  });

  test("build() attaches the prepared preview, either the object prepare returned or the preview inside it", () => {
    const own = ownOf("text", { text: "see https://example.com/a", linkPreview: true });
    const ctx = { input: own, media: null, prepared: null, target: privateTarget, waId: "x", mentions: [] };
    assert.deepEqual(real.get("text").build({ ...ctx, preview }).content.linkPreview, preview);
    assert.deepEqual(real.get("text").build({ ...ctx, preview: { preview } }).content.linkPreview, preview);
    assert.equal(real.get("text").build({ ...ctx, preview: null }).content.linkPreview, null);
  });
});

// ===========================================================================================================
// Part 4: location, contact, poll, vCard (3.6, 3.8; public-api.md 3.5-3.7)
// ===========================================================================================================

const { buildVCard } = require("../lib/messaging/vcard");

describe("vcard.buildVCard (3.8, FR-055)", () => {
  const lines = (card) => card.split("\r\n");

  test("BEGIN, VERSION 3.0, FN, ORG, EMAIL, one TEL per phone with waid, END; CRLF line ends", () => {
    const card = buildVCard({ name: "Acme Support", organization: "Acme", email: "support@acme.example", phones: ["+237 690 00 00 02", "00237690000003"] });
    assert.deepEqual(lines(card), [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Acme Support",
      "ORG:Acme",
      "EMAIL;type=INTERNET:support@acme.example",
      "TEL;type=CELL;waid=237690000002:+237690000002",
      "TEL;type=CELL;waid=237690000003:+237690000003",
      "END:VCARD",
    ]);
    assert.ok(!card.replace(/\r\n/g, "").includes("\n") && !card.replace(/\r\n/g, "").includes("\r"));
  });

  test("ORG and EMAIL are left out when absent", () => {
    assert.deepEqual(lines(buildVCard({ name: "Awa", phones: ["237690000002"] })), ["BEGIN:VCARD", "VERSION:3.0", "FN:Awa", "TEL;type=CELL;waid=237690000002:+237690000002", "END:VCARD"]);
  });

  test("`\\`, `;` and `,` are escaped; CR/LF become \\n; other control characters are dropped", () => {
    assert.equal(lines(buildVCard({ name: "A\\B;C,D", phones: [] }))[2], "FN:A\\\\B\;C\\,D");
    assert.equal(lines(buildVCard({ name: "one\ntwo\r\nthree\rfour", phones: [] }))[2], "FN:one\\ntwo\\nthree\\nfour");
    assert.equal(lines(buildVCard({ name: "a\u0000b\u0007c\u001bd\u007fe\u0009f", phones: [] }))[2], "FN:abcdef");
    assert.equal(lines(buildVCard({ name: "x\u0085y z w", phones: [] }))[2], "FN:x\\ny\\nz\\nw", "Unicode line breaks too");
  });

  test("injection: a name holding \\r\\nTEL: yields exactly one TEL line per declared phone", () => {
    const attacks = ["Evil\r\nTEL:+1 555 0100", "Evil\nTEL;type=CELL:+15550100", "Evil\r\nEND:VCARD\r\nBEGIN:VCARD\r\nFN:Other", "Evil TEL:+1", "Evil\r\nEMAIL:x@y.z\r\nORG:Hax"];
    for (const attack of attacks) {
      for (const field of ["name", "organization", "email"]) {
        const card = buildVCard({ name: "Awa", organization: "Org", email: "a@b.cd", phones: ["237690000002", "237690000003"], [field]: attack });
        const out = lines(card);
        assert.equal(out.filter((l) => l.startsWith("TEL")).length, 2, `${field}: ${JSON.stringify(attack)}`);
        assert.equal(out.filter((l) => l === "BEGIN:VCARD").length, 1);
        assert.equal(out.filter((l) => l === "END:VCARD").length, 1);
        assert.equal(out.filter((l) => l.startsWith("FN")).length, 1);
        assert.equal(out.filter((l) => l.startsWith("ORG")).length, 1);
        assert.equal(out.filter((l) => l.startsWith("EMAIL")).length, 1);
        assert.equal(out.length, 8);
      }
    }
    const none = buildVCard({ name: "Evil\r\nTEL:+1 555 0100", phones: [] });
    assert.equal(lines(none).filter((l) => l.startsWith("TEL")).length, 0);
  });

  test("a phone that is not a number never becomes a TEL line", () => {
    assert.equal(lines(buildVCard({ name: "A", phones: ["abc", "237690000002\r\nX:y", GROUP, "123"] })).filter((l) => l.startsWith("TEL")).length, 0);
  });
});

describe("format location", () => {
  before(() => real.load());
  const base = { latitude: 4.0511, longitude: 9.7679 };

  test("registered: order 90, no media, size null", () => {
    assert.deepEqual(real.list().find((r) => r.name === "location"), { name: "location", order: 90, right: "messages.send.location", interactive: false, media: false });
    assert.equal(real.sizeOf("location", base, null), null);
  });

  test("latitude -90..90 and longitude -180..180: out_of_range with min and max, bounds included", () => {
    assert.deepEqual(fieldsOf("location", base), {});
    for (const lat of [-90, 90, 0, -89.999999]) assert.deepEqual(fieldsOf("location", { ...base, latitude: lat }), {}, String(lat));
    for (const lng of [-180, 180, 0]) assert.deepEqual(fieldsOf("location", { ...base, longitude: lng }), {}, String(lng));
    assert.deepEqual(fieldsOf("location", { ...base, latitude: 90.0001 }), { latitude: { code: "out_of_range", params: { min: -90, max: 90 } } });
    assert.deepEqual(fieldsOf("location", { ...base, latitude: -91 }), { latitude: { code: "out_of_range", params: { min: -90, max: 90 } } });
    assert.deepEqual(fieldsOf("location", { ...base, longitude: 180.5 }), { longitude: { code: "out_of_range", params: { min: -180, max: 180 } } });
    assert.deepEqual(fieldsOf("location", { ...base, longitude: -181 }), { longitude: { code: "out_of_range", params: { min: -180, max: 180 } } });
    assert.deepEqual(fieldsOf("location", {}), { latitude: { code: "required" }, longitude: { code: "required" } });
    assert.deepEqual(fieldsOf("location", { latitude: "4.05", longitude: null }), { latitude: { code: "invalid_type" }, longitude: { code: "required" } });
    assert.deepEqual(fieldsOf("location", { ...base, latitude: Infinity }), { latitude: { code: "invalid_type" } });
  });

  test("name and address 1-256", () => {
    for (const field of ["name", "address"]) {
      assert.deepEqual(fieldsOf("location", { ...base, [field]: "" }), { [field]: { code: "too_short", params: { min: 1 } } });
      assert.deepEqual(fieldsOf("location", { ...base, [field]: "x".repeat(256) }), {});
      assert.deepEqual(fieldsOf("location", { ...base, [field]: "x".repeat(257) }), { [field]: { code: "too_long", params: { max: 256 } } });
    }
  });

  test("build(): { location: { degreesLatitude, degreesLongitude, name?, address? } } through the real generator", async () => {
    const full = real.get("location").build({ input: ownOf("location", { ...base, name: "Pickup point", address: "Rue de la Joie, Douala" }), media: null, prepared: null, target: privateTarget, waId: "x", mentions: [], preview: null });
    assert.deepEqual(full.content, { location: { degreesLatitude: 4.0511, degreesLongitude: 9.7679, name: "Pickup point", address: "Rue de la Joie, Douala" } });
    const bare = real.get("location").build({ input: ownOf("location", base), media: null, prepared: null, target: privateTarget, waId: "x", mentions: [], preview: null });
    assert.deepEqual(bare.content, { location: { degreesLatitude: 4.0511, degreesLongitude: 9.7679 } });
    const { message } = await generated(full.content);
    assert.deepEqual(
      { lat: message.locationMessage.degreesLatitude, lng: message.locationMessage.degreesLongitude, name: message.locationMessage.name, address: message.locationMessage.address },
      { lat: 4.0511, lng: 9.7679, name: "Pickup point", address: "Rue de la Joie, Douala" },
    );
  });

  test("descriptor: number fields with min, max, signed and a step hint", () => {
    const by = Object.fromEntries(real.describe("location").fields.map((f) => [f.name, f]));
    assert.equal(by.latitude.type, "number");
    assert.equal(by.latitude.signed, true);
    assert.equal(by.latitude.min, -90);
    assert.equal(by.longitude.max, 180);
    assert.equal(typeof by.latitude.step, "number");
    assert.equal(by.name.type, "text");
  });
});

describe("format contact", () => {
  before(() => real.load());
  const card = (extra = {}) => ({ name: "Acme Support", phones: ["+237 690 00 00 02"], ...extra });

  test("registered: order 100, no media, size null", () => {
    assert.deepEqual(real.list().find((r) => r.name === "contact"), { name: "contact", order: 100, right: "messages.send.contact", interactive: false, media: false });
    assert.equal(real.sizeOf("contact", { contacts: [] }, null), null);
  });

  test("contacts 1-10: too_short, too_many_items; each card is a strict object", () => {
    assert.deepEqual(fieldsOf("contact", {}), { contacts: { code: "required" } });
    assert.deepEqual(fieldsOf("contact", { contacts: [] }), { contacts: { code: "too_short", params: { min: 1 } } });
    assert.deepEqual(fieldsOf("contact", { contacts: Array.from({ length: 10 }, () => card()) }), {});
    assert.deepEqual(fieldsOf("contact", { contacts: Array.from({ length: 11 }, () => card()) }), { contacts: { code: "too_many_items", params: { max: 10 } } });
    assert.deepEqual(fieldsOf("contact", { contacts: "Awa" }), { contacts: { code: "invalid_type" } });
    assert.deepEqual(fieldsOf("contact", { contacts: ["Awa"] }), { "contacts.0": { code: "invalid_type" } });
    assert.deepEqual(fieldsOf("contact", { contacts: [card(), card({ extra: 1 })] }), { "contacts.1.$unknown": { code: "unknown_field" } });
    assert.deepEqual(fieldsOf("contact", { contacts: [{}] }), { "contacts.0.name": { code: "required" }, "contacts.0.phones": { code: "required" } });
  });

  test("name 1-128, organization 1-128, email 1-254 with a local@domain.tld shape", () => {
    assert.deepEqual(fieldsOf("contact", { contacts: [card({ name: "" })] }), { "contacts.0.name": { code: "too_short", params: { min: 1 } } });
    assert.deepEqual(fieldsOf("contact", { contacts: [card({ name: "n".repeat(128) })] }), {});
    assert.deepEqual(fieldsOf("contact", { contacts: [card({ name: "n".repeat(129) })] }), { "contacts.0.name": { code: "too_long", params: { max: 128 } } });
    assert.deepEqual(fieldsOf("contact", { contacts: [card({ organization: "" })] }), { "contacts.0.organization": { code: "too_short", params: { min: 1 } } });
    assert.deepEqual(fieldsOf("contact", { contacts: [card({ organization: "o".repeat(129) })] }), { "contacts.0.organization": { code: "too_long", params: { max: 128 } } });
    assert.deepEqual(fieldsOf("contact", { contacts: [card({ email: "support@acme.example" })] }), {});
    for (const bad of ["support", "support@", "@acme.example", "a b@acme.example", "support@acme", "a@@b.cd"]) {
      assert.deepEqual(fieldsOf("contact", { contacts: [card({ email: bad })] }), { "contacts.0.email": { code: "invalid_format" } }, bad);
    }
    assert.deepEqual(fieldsOf("contact", { contacts: [card({ email: `${"e".repeat(250)}@a.bc` })] }), { "contacts.0.email": { code: "too_long", params: { max: 254 } } });
  });

  test("phones 1-5, each a phone number with country code; a group id and bad syntax are invalid_format at their index", () => {
    assert.deepEqual(fieldsOf("contact", { contacts: [card({ phones: [] })] }), { "contacts.0.phones": { code: "too_short", params: { min: 1 } } });
    assert.deepEqual(fieldsOf("contact", { contacts: [card({ phones: ["237690000001", "237690000002", "237690000003", "237690000004", "237690000005"] })] }), {});
    assert.deepEqual(fieldsOf("contact", { contacts: [card({ phones: ["237690000001", "237690000002", "237690000003", "237690000004", "237690000005", "237690000006"] })] }), {
      "contacts.0.phones": { code: "too_many_items", params: { max: 5 } },
    });
    assert.deepEqual(fieldsOf("contact", { contacts: [card(), card({ phones: ["237690000001", "abc", GROUP, "0690000001", "123"] })] }), {
      "contacts.1.phones.1": { code: "invalid_format" },
      "contacts.1.phones.2": { code: "invalid_format" },
      "contacts.1.phones.3": { code: "invalid_format" },
      "contacts.1.phones.4": { code: "invalid_format" },
    });
  });

  test("distinct phones within a card: `duplicate` at the later index (compared as digits)", () => {
    assert.deepEqual(fieldsOf("contact", { contacts: [card({ phones: ["237690000001", "237690000002", "237690000001"] })] }), { "contacts.0.phones.2": { code: "duplicate" } });
    assert.deepEqual(fieldsOf("contact", { contacts: [card({ phones: ["237690000001", "+237 690 00 00 01"] })] }), { "contacts.0.phones.1": { code: "duplicate" } });
    assert.deepEqual(fieldsOf("contact", { contacts: [card({ phones: ["237690000001"] }), card({ phones: ["237690000001"] })] }), {}, "the same phone on two cards is fine");
  });

  test("normalize: phones become digit strings, the rest is untouched", () => {
    const own = ownOf("contact", { contacts: [card({ phones: ["+237 690 00 00 02", "00237690000003"], organization: "Acme", email: "support@acme.example" })] });
    assert.deepEqual(own, { contacts: [{ name: "Acme Support", phones: ["237690000002", "237690000003"], organization: "Acme", email: "support@acme.example" }] });
  });

  test("build(): one card is a contactMessage, several a contactsArrayMessage, through the real generator", async () => {
    const one = real.get("contact").build({ input: ownOf("contact", { contacts: [card({ organization: "Acme", email: "support@acme.example" })] }), media: null, prepared: null, target: privateTarget, waId: "x", mentions: [], preview: null });
    assert.equal(one.content.contacts.displayName, "Acme Support");
    assert.equal(one.content.contacts.contacts.length, 1);
    assert.equal(one.content.contacts.contacts[0].displayName, "Acme Support");
    assert.equal(
      one.content.contacts.contacts[0].vcard,
      "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Acme Support\r\nORG:Acme\r\nEMAIL;type=INTERNET:support@acme.example\r\nTEL;type=CELL;waid=237690000002:+237690000002\r\nEND:VCARD",
    );
    const single = await generated(one.content);
    assert.ok(single.message.contactMessage, "contactMessage");
    assert.ok(!single.message.contactsArrayMessage);
    assert.equal(single.message.contactMessage.vcard, one.content.contacts.contacts[0].vcard);

    const several = real.get("contact").build({ input: ownOf("contact", { contacts: [card(), card({ name: "Second", phones: ["237690000009"] })] }), media: null, prepared: null, target: privateTarget, waId: "x", mentions: [], preview: null });
    const array = await generated(several.content);
    assert.ok(array.message.contactsArrayMessage, "contactsArrayMessage");
    assert.equal(array.message.contactsArrayMessage.contacts.length, 2);
    assert.ok(!array.message.contactMessage);
  });

  test("FR-055: a name holding \\r\\nTEL: still gives one TEL line per declared phone, end to end", () => {
    const own = ownOf("contact", { contacts: [card({ name: "Evil\r\nTEL:+1 555 0100" })] });
    const { content } = real.get("contact").build({ input: own, media: null, prepared: null, target: privateTarget, waId: "x", mentions: [], preview: null });
    const vcard = content.contacts.contacts[0].vcard;
    assert.equal(vcard.split("\r\n").filter((l) => l.startsWith("TEL")).length, 1);
  });

  test("descriptor: contacts is a list of cards with a nested list of phones", () => {
    const contacts = real.describe("contact").fields.find((f) => f.name === "contacts");
    assert.equal(contacts.type, "list");
    assert.equal(contacts.items.min, 1);
    assert.equal(contacts.items.max, 10);
    assert.deepEqual(contacts.items.fields.map((f) => f.name), ["name", "phones", "organization", "email"]);
    const phones = contacts.items.fields.find((f) => f.name === "phones");
    assert.equal(phones.type, "list");
    assert.equal(phones.item.type, "text");
    assert.equal(phones.labelKey, "api.format.contact.field.contacts.phones.label");
  });
});

describe("format poll", () => {
  before(() => real.load());
  const sha256 = (text) => crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
  const body = (extra = {}) => ({ question: "Which day for training?", options: ["Tuesday", "Thursday", "Saturday"], ...extra });
  const buildPoll = (extra, ctx = {}) => real.get("poll").build({ input: ownOf("poll", body(extra), groupTarget), media: null, prepared: null, target: groupTarget, waId: "3EB0AAAA", mentions: [], preview: null, ...ctx });

  test("registered: order 110, interactive, no media", () => {
    assert.deepEqual(real.list().find((r) => r.name === "poll"), { name: "poll", order: 110, right: "messages.send.poll", interactive: true, media: false });
    assert.equal(typeof real.get("poll").interpretReply, "function");
  });

  test("question 1-255; options 2-12 entries of 1-100", () => {
    assert.deepEqual(fieldsOf("poll", body({ question: "" })), { question: { code: "too_short", params: { min: 1 } } });
    assert.deepEqual(fieldsOf("poll", body({ question: "q".repeat(255) })), {});
    assert.deepEqual(fieldsOf("poll", body({ question: "q".repeat(256) })), { question: { code: "too_long", params: { max: 255 } } });
    assert.deepEqual(fieldsOf("poll", { question: "q" }), { options: { code: "required" } });
    assert.deepEqual(fieldsOf("poll", body({ options: ["only one"] })), { options: { code: "too_short", params: { min: 2 } } });
    assert.deepEqual(fieldsOf("poll", body({ options: Array.from({ length: 12 }, (_, i) => `o${i}`) })), {});
    assert.deepEqual(fieldsOf("poll", body({ options: Array.from({ length: 13 }, (_, i) => `o${i}`) })), { options: { code: "too_many_items", params: { max: 12 } } });
    assert.deepEqual(fieldsOf("poll", body({ options: ["a", ""] })), { "options.1": { code: "too_short", params: { min: 1 } } });
    assert.deepEqual(fieldsOf("poll", body({ options: ["a", "o".repeat(100)] })), {});
    assert.deepEqual(fieldsOf("poll", body({ options: ["a", "o".repeat(101)] })), { "options.1": { code: "too_long", params: { max: 100 } } });
    assert.deepEqual(fieldsOf("poll", body({ options: ["a", 2] })), { "options.1": { code: "invalid_type" } });
    assert.deepEqual(fieldsOf("poll", body({ multiple: "yes" })), { multiple: { code: "invalid_type" } });
  });

  test("distinct options after trimming, case-sensitive: the repeat is options.N = duplicate", () => {
    assert.deepEqual(fieldsOf("poll", body({ options: ["Yes", "No", "Yes"] })), { "options.2": { code: "duplicate" } });
    assert.deepEqual(fieldsOf("poll", body({ options: ["Yes", "No", " Yes "] })), { "options.2": { code: "duplicate" } });
    assert.deepEqual(fieldsOf("poll", body({ options: ["Yes", "No", "yes"] })), {}, "case-sensitive");
    assert.deepEqual(fieldsOf("poll", body({ options: ["a", "a", "a"] })), { "options.1": { code: "duplicate" }, "options.2": { code: "duplicate" } });
  });

  test("size is the UTF-8 length of the question", () => {
    assert.equal(real.sizeOf("poll", { question: "Quelle journée ?" }, null), Buffer.byteLength("Quelle journée ?"));
  });

  test("build(): single choice is selectableCount 1 (V3), multiple is values.length (V1), with the REAL generator", async () => {
    const single = buildPoll({ multiple: false });
    assert.equal(single.content.poll.selectableCount, 1);
    assert.ok(!("toAnnouncementGroup" in single.content.poll), "never set by the format (Baileys fills it in itself)");
    assert.deepEqual(single.content.poll.values, ["Tuesday", "Thursday", "Saturday"]);
    assert.equal(single.content.poll.name, "Which day for training?");
    const v3 = (await generated(single.content)).message;
    assert.ok(v3.pollCreationMessageV3, "V3");
    assert.ok(!v3.pollCreationMessage);
    assert.equal(v3.pollCreationMessageV3.selectableOptionsCount, 1);

    const multi = buildPoll({ multiple: true });
    assert.equal(multi.content.poll.selectableCount, 3);
    const v1 = (await generated(multi.content)).message;
    assert.ok(v1.pollCreationMessage, "V1");
    assert.ok(!v1.pollCreationMessageV3);
    assert.equal(v1.pollCreationMessage.selectableOptionsCount, 3);
  });

  test("build(): a 32-byte messageSecret from ctx.randomBytes, returned as `secret` and given to Baileys", async () => {
    const asked = [];
    const fixed = Buffer.alloc(32, 7);
    const built = buildPoll({}, { randomBytes: (n) => (asked.push(n), fixed) });
    assert.deepEqual(asked, [32]);
    assert.equal(built.secret, fixed);
    assert.equal(built.content.poll.messageSecret, fixed);
    const { message } = await generated(built.content);
    assert.equal(Buffer.from(message.messageContextInfo.messageSecret).toString("hex"), fixed.toString("hex"));
    const real_ = buildPoll({});
    assert.ok(Buffer.isBuffer(real_.secret) && real_.secret.length === 32);
    assert.notEqual(real_.secret.toString("hex"), buildPoll({}).secret.toString("hex"), "fresh randomness");
  });

  test("build(): choices { id: index, label }, replyData { v: 1, multi, hashes } with lower-case SHA-256 hex of each UTF-8 option", () => {
    const built = buildPoll({ options: ["Tuesday", "Thursday", "Saturday é😀"], multiple: true });
    assert.deepEqual(built.choices, [
      { id: "0", label: "Tuesday" },
      { id: "1", label: "Thursday" },
      { id: "2", label: "Saturday é😀" },
    ]);
    assert.deepEqual(built.replyData, { v: 1, multi: true, hashes: ["Tuesday", "Thursday", "Saturday é😀"].map(sha256) });
    for (const hash of built.replyData.hashes) assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(buildPoll({}).replyData.multi, false);
  });

  test("interpretReply: vote digests mapped to option indexes (unknown dropped, option order, possibly empty)", () => {
    const built = buildPoll({});
    const row = { replyData: built.replyData, choices: built.choices };
    const interpret = (digests) => real.get("poll").interpretReply({ row, event: { type: "vote", digests } });
    const [tuesday, thursday, saturday] = built.replyData.hashes;
    assert.deepEqual(interpret([thursday]), { choiceIds: ["1"] });
    assert.deepEqual(interpret([saturday, tuesday]), { choiceIds: ["0", "2"] }, "option order, not vote order");
    assert.deepEqual(interpret([tuesday, "f".repeat(64), "not a digest"]), { choiceIds: ["0"] }, "unknown digests dropped");
    assert.deepEqual(interpret([thursday.toUpperCase()]), { choiceIds: ["1"] }, "case-insensitive digests");
    assert.deepEqual(interpret([]), { choiceIds: [] }, "a cleared vote");
    assert.deepEqual(interpret(["0".repeat(64)]), { choiceIds: [] });
  });

  test("interpretReply: everything that is not a vote, or has no digests to map to, is null", () => {
    const built = buildPoll({});
    const row = { replyData: built.replyData, choices: built.choices };
    const interpret = (event, r = row) => real.get("poll").interpretReply({ row: r, event });
    assert.equal(interpret({ type: "tap", id: "0" }), null);
    assert.equal(interpret({ type: "number", number: 1 }), null);
    assert.equal(interpret({ type: "vote" }), null);
    assert.equal(interpret({ type: "vote", digests: "abc" }), null);
    assert.equal(interpret(null), null);
    assert.equal(interpret(undefined), null);
    assert.equal(interpret({ type: "vote", digests: ["a"] }, { replyData: null }), null);
    assert.equal(interpret({ type: "vote", digests: ["a"] }, { replyData: { v: 1 } }), null);
    assert.equal(interpret({ type: "vote", digests: ["a"] }, null), null);
  });

  test("descriptor: question textarea? no (255), options is a list of text, multiple a boolean", () => {
    const by = Object.fromEntries(real.describe("poll").fields.map((f) => [f.name, f]));
    assert.equal(by.question.type, "text");
    assert.equal(by.options.type, "list");
    assert.equal(by.options.min, 2);
    assert.equal(by.options.max, 12);
    assert.equal(by.options.item.max, 100);
    assert.equal(by.multiple.type, "boolean");
    assert.equal(by.multiple.default, false);
    assert.equal(real.describe("poll").interactive, true);
  });
});

// ===========================================================================================================
// Part 5: buttons and list (3.6, 3.7; public-api.md 3.8, 3.9)
// ===========================================================================================================

const { getLang, languageManager } = require("../lib/utils/language");

const WA_ID = "3EB0" + "A".repeat(18); // a 22-character WhatsApp id, as generateMessageIDV2 makes
const buttonsBody = (extra = {}) => ({
  text: "Do you confirm your appointment tomorrow at 10:00?",
  buttons: [
    { id: "confirm", label: "Yes" },
    { id: "cancel", label: "No" },
  ],
  ...extra,
});
const listBody = (extra = {}) => ({
  text: "Choose a delivery slot",
  buttonLabel: "See slots",
  choices: [
    { id: "slot-am", title: "Morning", description: "8:00 - 12:00" },
    { id: "slot-pm", title: "Afternoon" },
  ],
  ...extra,
});
const buildInteractive = (name, body) => real.get(name).build({ input: ownOf(name, body), media: null, prepared: null, target: privateTarget, waId: WA_ID, mentions: [], preview: null });

describe("format buttons", () => {
  before(() => real.load());

  test("registered: order 120, interactive, no media, replies captured", () => {
    assert.deepEqual(real.list().find((r) => r.name === "buttons"), { name: "buttons", order: 120, right: "messages.send.buttons", interactive: true, media: false });
    assert.equal(typeof real.get("buttons").interpretReply, "function");
  });

  test("text 1-1024: rejected, never truncated", () => {
    assert.deepEqual(fieldsOf("buttons", buttonsBody({ text: "" })), { text: { code: "too_short", params: { min: 1 } } });
    assert.deepEqual(fieldsOf("buttons", buttonsBody({ text: "t".repeat(1024) })), {});
    assert.deepEqual(fieldsOf("buttons", buttonsBody({ text: "t".repeat(1025) })), { text: { code: "too_long", params: { max: 1024 } } });
    assert.deepEqual(fieldsOf("buttons", { buttons: buttonsBody().buttons }), { text: { code: "required" } });
  });

  test("buttons 1-3 of { id, label }: too_short, too_many_items, nested faults at buttons.N.<field>", () => {
    const one = [{ id: "a", label: "A" }];
    assert.deepEqual(fieldsOf("buttons", buttonsBody({ buttons: [] })), { buttons: { code: "too_short", params: { min: 1 } } });
    assert.deepEqual(fieldsOf("buttons", buttonsBody({ buttons: one })), {});
    assert.deepEqual(fieldsOf("buttons", buttonsBody({ buttons: [...one, { id: "b", label: "B" }, { id: "c", label: "C" }] })), {});
    assert.deepEqual(fieldsOf("buttons", buttonsBody({ buttons: [...one, { id: "b", label: "B" }, { id: "c", label: "C" }, { id: "d", label: "D" }] })), { buttons: { code: "too_many_items", params: { max: 3 } } });
    assert.deepEqual(fieldsOf("buttons", buttonsBody({ buttons: [{ id: "a" }, { label: "B" }] })), { "buttons.0.label": { code: "required" }, "buttons.1.id": { code: "required" } });
    assert.deepEqual(fieldsOf("buttons", buttonsBody({ buttons: [{ id: "a", label: "A", extra: 1 }] })), { "buttons.0.$unknown": { code: "unknown_field" } });
    assert.deepEqual(fieldsOf("buttons", buttonsBody({ buttons: "yes" })), { buttons: { code: "invalid_type" } });
    assert.deepEqual(fieldsOf("buttons", buttonsBody({ buttons: ["yes"] })), { "buttons.0": { code: "invalid_type" } });
  });

  test("id matches ^[A-Za-z0-9_.-]{1,64}$ (no colon: the wire id splits unambiguously)", () => {
    const withId = (id) => fieldsOf("buttons", buttonsBody({ buttons: [{ id, label: "A" }] }));
    for (const ok of ["a", "A_z0-9.-", "x".repeat(64), "confirm.yes", "1"]) assert.deepEqual(withId(ok), {}, ok);
    for (const bad of ["", "x".repeat(65), "a b", "a:b", "api:reply:x:y", "é", "a/b", "a\n"]) {
      assert.deepEqual(withId(bad), { "buttons.0.id": { code: "invalid_format" } }, JSON.stringify(bad));
    }
    assert.deepEqual(withId(12), { "buttons.0.id": { code: "invalid_type" } });
  });

  test("label 1-20: rejected, never truncated", () => {
    const withLabel = (label) => fieldsOf("buttons", buttonsBody({ buttons: [{ id: "a", label }] }));
    assert.deepEqual(withLabel(""), { "buttons.0.label": { code: "too_short", params: { min: 1 } } });
    assert.deepEqual(withLabel("l".repeat(20)), {});
    assert.deepEqual(withLabel("l".repeat(21)), { "buttons.0.label": { code: "too_long", params: { max: 20 } } });
  });

  test("distinct ids: the repeat is buttons.N.id = duplicate (case-sensitive)", () => {
    assert.deepEqual(fieldsOf("buttons", buttonsBody({ buttons: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "a", label: "C" }] })), { "buttons.2.id": { code: "duplicate" } });
    assert.deepEqual(fieldsOf("buttons", buttonsBody({ buttons: [{ id: "a", label: "A" }, { id: "A", label: "B" }] })), {});
    assert.deepEqual(fieldsOf("buttons", buttonsBody({ buttons: [{ id: "a", label: "A" }, { id: "a", label: "A" }, { id: "a", label: "A" }] })), { "buttons.1.id": { code: "duplicate" }, "buttons.2.id": { code: "duplicate" } });
  });

  test("the composed body over 4096 is fields.text = too_long { max: 4096 } (the hint line counts)", () => {
    const code = languageManager.activeCode();
    const key = "plugins.buttons.reply_number";
    languageManager.overrides[code].set(key, { text: "h".repeat(4100) });
    try {
      assert.deepEqual(fieldsOf("buttons", buttonsBody()), { text: { code: "too_long", params: { max: 4096 } } });
      const both = fieldsOf("buttons", buttonsBody({ buttons: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }));
      assert.deepEqual(both, { "buttons.1.id": { code: "duplicate" }, text: { code: "too_long", params: { max: 4096 } } }, "every fault at once");
    } finally {
      languageManager.overrides[code].delete(key);
    }
    assert.deepEqual(fieldsOf("buttons", buttonsBody()), {}, "back to normal");
  });

  test("size is the UTF-8 length of text", () => {
    assert.equal(real.sizeOf("buttons", { text: "Oui ✓" }, null), Buffer.byteLength("Oui ✓"));
  });

  test("build(): transport interactive with buildQuickReplies(..., { numbered: true }); wire ids api:reply:<waId>:<id>", () => {
    const built = buildInteractive("buttons", buttonsBody());
    assert.equal(built.transport, "interactive");
    const { content } = built;
    assert.equal(content.kind, "buttons");
    assert.equal(content.text, "Do you confirm your appointment tomorrow at 10:00?");
    assert.deepEqual(content.ids, [`api:reply:${WA_ID}:confirm`, `api:reply:${WA_ID}:cancel`]);
    assert.deepEqual(
      content.nativeButtons.map((b) => [b.name, JSON.parse(b.buttonParamsJson)]),
      [
        ["quick_reply", { display_text: "Yes", id: `api:reply:${WA_ID}:confirm` }],
        ["quick_reply", { display_text: "No", id: `api:reply:${WA_ID}:cancel` }],
      ],
    );
    // the numbered text version and the hint from getLang
    assert.equal(content.body, `Do you confirm your appointment tomorrow at 10:00?\n\n  1. Yes\n  2. No\n\n_${getLang("plugins.buttons.reply_number")}_`);
    assert.deepEqual(built.choices, [{ id: "confirm", label: "Yes" }, { id: "cancel", label: "No" }]);
  });

  test("build(): no footer, no header; never recorded in buttonRegistry; the longest wire id is 97 characters", () => {
    const built = buildInteractive("buttons", buttonsBody({ buttons: [{ id: "x".repeat(64), label: "Long" }] }));
    assert.ok(!/footer|header|title/i.test(Object.keys(built.content).join(" ")));
    assert.ok(!/footer/i.test(JSON.stringify(built.content.nativeButtons)));
    assert.equal(built.content.ids[0].length, 97);
    assert.deepEqual(buildInteractive("buttons", buttonsBody()).content, buildInteractive("buttons", buttonsBody()).content, "pure: the same input builds the same message");
    const source = fs.readFileSync(path.join(__dirname, "..", "lib", "messaging", "formats", "buttons.js"), "utf8") + fs.readFileSync(path.join(__dirname, "..", "lib", "messaging", "formats", "list.js"), "utf8");
    assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, ""), /buttonRegistry|sendQuickReplies|sendList\b/, "no registry record, no fallback sender");
  });

  test("interpretReply: a tap whose id is in row.choices, or a number n in 1..choices.length; everything else is null", () => {
    const built = buildInteractive("buttons", buttonsBody({ buttons: [{ id: "confirm", label: "Yes" }, { id: "cancel", label: "No" }, { id: "later", label: "Later" }] }));
    const row = { choices: built.choices };
    const interpret = (event, r = row) => real.get("buttons").interpretReply({ row: r, event });
    assert.deepEqual(interpret({ type: "tap", id: "cancel" }), { choiceIds: ["cancel"] });
    assert.deepEqual(interpret({ type: "number", number: 1 }), { choiceIds: ["confirm"] });
    assert.deepEqual(interpret({ type: "number", number: 3 }), { choiceIds: ["later"] });
    for (const bad of [{ type: "tap", id: "nope" }, { type: "tap", id: `api:reply:${WA_ID}:confirm` }, { type: "tap" }, { type: "number", number: 0 }, { type: "number", number: 4 }, { type: "number", number: -1 }, { type: "number", number: 1.5 }, { type: "number", number: "1" }, { type: "number" }, { type: "vote", digests: [] }, { type: "other" }, null, undefined]) {
      assert.equal(interpret(bad), null, JSON.stringify(bad));
    }
    assert.equal(interpret({ type: "tap", id: "confirm" }, { choices: [] }), null);
    assert.equal(interpret({ type: "tap", id: "confirm" }, { choices: null }), null);
    assert.equal(interpret({ type: "tap", id: "confirm" }, null), null);
  });

  test("descriptor and the doc example of public-api.md 3.8", () => {
    const by = Object.fromEntries(real.describe("buttons").fields.map((f) => [f.name, f]));
    assert.equal(by.text.type, "textarea");
    assert.equal(by.buttons.type, "list");
    assert.equal(by.buttons.items.min, 1);
    assert.equal(by.buttons.items.max, 3);
    assert.deepEqual(by.buttons.items.fields.map((f) => f.name), ["id", "label"]);
    assert.equal(by.buttons.items.fields[0].pattern, LIMITS.ID_PATTERN.source);
    assert.equal(real.describe("buttons").interactive, true);
    assert.deepEqual(real.doc("buttons").examples[0], { format: "buttons", to: "237690000001", text: "Do you confirm your appointment tomorrow at 10:00?", buttons: [{ id: "confirm", label: "Yes" }, { id: "cancel", label: "No" }] });
  });
});

describe("format list", () => {
  before(() => real.load());

  test("registered: order 130, interactive, no media", () => {
    assert.deepEqual(real.list().find((r) => r.name === "list"), { name: "list", order: 130, right: "messages.send.list", interactive: true, media: false });
    assert.equal(typeof real.get("list").interpretReply, "function");
  });

  test("text 1-1024 and buttonLabel 1-20 (the button that opens the list)", () => {
    assert.deepEqual(fieldsOf("list", listBody({ text: "t".repeat(1025) })), { text: { code: "too_long", params: { max: 1024 } } });
    assert.deepEqual(fieldsOf("list", listBody({ buttonLabel: "" })), { buttonLabel: { code: "too_short", params: { min: 1 } } });
    assert.deepEqual(fieldsOf("list", listBody({ buttonLabel: "b".repeat(20) })), {});
    assert.deepEqual(fieldsOf("list", listBody({ buttonLabel: "b".repeat(21) })), { buttonLabel: { code: "too_long", params: { max: 20 } } });
    const { buttonLabel, ...without } = listBody();
    assert.ok(buttonLabel);
    assert.deepEqual(fieldsOf("list", without), { buttonLabel: { code: "required" } });
  });

  test("choices 1-10 with id, title 1-24 and description 1-72; limits rejected, never truncated", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, title: `Choice ${i}` }));
    assert.deepEqual(fieldsOf("list", listBody({ choices: ten })), {});
    assert.deepEqual(fieldsOf("list", listBody({ choices: [...ten, { id: "c10", title: "x" }] })), { choices: { code: "too_many_items", params: { max: 10 } } });
    assert.deepEqual(fieldsOf("list", listBody({ choices: [] })), { choices: { code: "too_short", params: { min: 1 } } });
    const one = (extra) => fieldsOf("list", listBody({ choices: [{ id: "a", title: "A", ...extra }] }));
    assert.deepEqual(one({ title: "t".repeat(24) }), {});
    assert.deepEqual(one({ title: "t".repeat(25) }), { "choices.0.title": { code: "too_long", params: { max: 24 } } });
    assert.deepEqual(one({ title: "" }), { "choices.0.title": { code: "too_short", params: { min: 1 } } });
    assert.deepEqual(one({ description: "d".repeat(72) }), {});
    assert.deepEqual(one({ description: "d".repeat(73) }), { "choices.0.description": { code: "too_long", params: { max: 72 } } });
    assert.deepEqual(one({ description: "" }), { "choices.0.description": { code: "too_short", params: { min: 1 } } });
    assert.deepEqual(one({ id: "a b" }), { "choices.0.id": { code: "invalid_format" } });
    assert.deepEqual(one({ id: "a:b" }), { "choices.0.id": { code: "invalid_format" } });
    assert.deepEqual(one({ extra: true }), { "choices.0.$unknown": { code: "unknown_field" } });
  });

  test("distinct choice ids: choices.N.id = duplicate", () => {
    assert.deepEqual(fieldsOf("list", listBody({ choices: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "a", title: "C" }] })), { "choices.2.id": { code: "duplicate" } });
  });

  test("the composed body over 4096 is fields.text = too_long { max: 4096 }", () => {
    const code = languageManager.activeCode();
    const key = "plugins.buttons.pick_list";
    languageManager.overrides[code].set(key, { text: "h".repeat(4100) });
    try {
      assert.deepEqual(fieldsOf("list", listBody()), { text: { code: "too_long", params: { max: 4096 } } });
    } finally {
      languageManager.overrides[code].delete(key);
    }
    assert.deepEqual(fieldsOf("list", listBody()), {});
  });

  test("build(): transport interactive with buildList; ONE single_select section titled with the button label; wire ids; numbered titles and the pick hint", () => {
    const built = buildInteractive("list", listBody());
    assert.equal(built.transport, "interactive");
    const { content } = built;
    assert.equal(content.kind, "list");
    assert.deepEqual(content.ids, [`api:reply:${WA_ID}:slot-am`, `api:reply:${WA_ID}:slot-pm`]);
    assert.equal(content.nativeButtons.length, 1);
    assert.equal(content.nativeButtons[0].name, "single_select");
    const params = JSON.parse(content.nativeButtons[0].buttonParamsJson);
    assert.equal(params.title, "See slots");
    assert.equal(params.sections.length, 1);
    assert.equal(params.sections[0].title, "See slots");
    assert.deepEqual(params.sections[0].rows, [
      { id: `api:reply:${WA_ID}:slot-am`, title: "Morning", description: "8:00 - 12:00" },
      { id: `api:reply:${WA_ID}:slot-pm`, title: "Afternoon", description: "" },
    ]);
    // the numbered body lists the TITLES only, then the hint
    assert.equal(content.body, `Choose a delivery slot\n\n  1. Morning\n  2. Afternoon\n\n_${getLang("plugins.buttons.pick_list")}_`);
    assert.doesNotMatch(content.body, /8:00/);
    // choices: { id, label: title }; neither the description nor the button label is kept
    assert.deepEqual(built.choices, [{ id: "slot-am", label: "Morning" }, { id: "slot-pm", label: "Afternoon" }]);
    assert.doesNotMatch(JSON.stringify(built.choices), /8:00|See slots/);
    assert.ok(!/footer/i.test(JSON.stringify(content)));
  });

  test("interpretReply: a tap on a choice id or a number 1..n gives the id; everything else is null", () => {
    const built = buildInteractive("list", listBody());
    const row = { choices: built.choices };
    const interpret = (event) => real.get("list").interpretReply({ row, event });
    assert.deepEqual(interpret({ type: "tap", id: "slot-pm" }), { choiceIds: ["slot-pm"] });
    assert.deepEqual(interpret({ type: "number", number: 1 }), { choiceIds: ["slot-am"] });
    assert.deepEqual(interpret({ type: "number", number: 2 }), { choiceIds: ["slot-pm"] });
    for (const bad of [{ type: "number", number: 3 }, { type: "number", number: 0 }, { type: "tap", id: "Morning" }, { type: "vote", digests: ["a"] }, null]) assert.equal(interpret(bad), null, JSON.stringify(bad));
  });

  test("size, descriptor and the doc example of public-api.md 3.9", () => {
    assert.equal(real.sizeOf("list", { text: "Choose" }, null), 6);
    const by = Object.fromEntries(real.describe("list").fields.map((f) => [f.name, f]));
    assert.equal(by.buttonLabel.max, 20);
    assert.deepEqual(by.choices.items.fields.map((f) => f.name), ["id", "title", "description"]);
    assert.equal(by.choices.items.fields[2].required, false);
    assert.deepEqual(real.doc("list").examples[0], {
      format: "list",
      to: "237690000001",
      text: "Choose a delivery slot",
      buttonLabel: "See slots",
      choices: [{ id: "slot-am", title: "Morning", description: "8:00 - 12:00" }, { id: "slot-pm", title: "Afternoon", description: "14:00 - 18:00" }],
    });
  });
});

describe("the thirteen formats (public-api.md 3.1)", () => {
  test("names, orders and derived rights are exactly the registry table", () => {
    real.load();
    assert.deepEqual(
      real.list().map((r) => [r.name, r.order, r.right]),
      [["text", 10], ["image", 20], ["video", 30], ["gif", 40], ["audio", 50], ["voice", 60], ["document", 70], ["sticker", 80], ["location", 90], ["contact", 100], ["poll", 110], ["buttons", 120], ["list", 130]].map(([name, order]) => [name, order, `messages.send.${name}`]),
    );
    assert.deepEqual(real.list().filter((r) => r.interactive).map((r) => r.name), ["poll", "buttons", "list"]);
    assert.deepEqual(real.list().filter((r) => r.media).map((r) => r.name), ["image", "video", "gif", "audio", "voice", "document", "sticker"]);
  });

  test("every doc example is the one of public-api.md (machine-read from the contract)", () => {
    const text = fs.readFileSync(path.join(__dirname, "..", "specs", "004-messaging-api", "contracts", "public-api.md"), "utf8");
    const slice = text.slice(text.search(/^## 3\. /m), text.search(/^## 4\. /m));
    const blocks = [...slice.matchAll(/^```json example=([a-z_]+)\n([\s\S]*?)\n```$/gm)];
    assert.equal(blocks.length, 13);
    for (const [, name, json] of blocks) assert.deepEqual(real.doc(name).examples[0], JSON.parse(json), name);
  });
});
