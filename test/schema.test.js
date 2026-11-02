"use strict";
/**
 * lib/utils/schema.js (feature 004, contracts/runtime.md section 12): the strict schema core moved out of
 * lib/admin/http/request.js so an engine may require it, plus two backward-compatible rules (`shape` for nested
 * objects, `unique` for scalar arrays) and dotted error paths. RT-120: every existing panel schema validates
 * identically through the request.js wrapper; RT-121: unknown nested properties are refused at every level and
 * submitted values are never echoed.
 *
 * Pure: no database, no WhatsApp, no network.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const schema = require("../lib/utils/schema");
const { check, validate, SchemaError, codePoints } = schema;
const request = require("../lib/admin/http/request");
const { AdminError } = require("../lib/admin/http/response");

describe("schema.js exports", () => {
  test("the four names of the contract", () => {
    assert.equal(typeof check, "function");
    assert.equal(typeof validate, "function");
    assert.equal(typeof SchemaError, "function");
    assert.equal(typeof codePoints, "function");
  });

  test("codePoints counts code points, not UTF-16 units", () => {
    assert.equal(codePoints("abc"), 3);
    assert.equal(codePoints("a\u{1F600}b"), 3);
    assert.equal("a\u{1F600}b".length, 4);
    assert.equal(codePoints(""), 0);
  });

  test("SchemaError carries code and fields and is an Error", () => {
    const err = new SchemaError("validation_failed", { fields: { a: { code: "required" } } });
    assert.ok(err instanceof Error);
    assert.equal(err.name, "SchemaError");
    assert.equal(err.code, "validation_failed");
    assert.deepEqual(err.fields, { a: { code: "required" } });
    assert.equal(new SchemaError("bad_request").fields, undefined);
  });

  test("the module requires nothing from lib/admin (an engine may require it, RT-01)", () => {
    const fs = require("fs");
    const source = fs.readFileSync(require.resolve("../lib/utils/schema"), "utf8");
    assert.doesNotMatch(source, /require\([^)]*admin/);
  });
});

describe("check: pure", () => {
  test("returns { value, fields } and never throws", () => {
    const rules = { name: { type: "string", required: true } };
    assert.deepEqual(check({ name: "x" }, rules), { value: { name: "x" }, fields: {} });
    const bad = check({}, rules);
    assert.deepEqual(bad.fields, { name: { code: "required" } });
    assert.doesNotThrow(() => check({ extra: 1 }, rules));
  });

  test("builds a fresh object holding only schema fields", () => {
    const input = { a: "1", b: "2" };
    const out = check(input, { a: { type: "string" }, b: { type: "string" } }).value;
    assert.notEqual(out, input);
    assert.deepEqual(out, { a: "1", b: "2" });
  });

  test("undefined and null inputs are read as {}", () => {
    assert.deepEqual(check(undefined, { a: { type: "string" } }), { value: {}, fields: {} });
    assert.deepEqual(check(null, { a: { type: "string", default: "z" } }), { value: { a: "z" }, fields: {} });
  });

  test("the path option prefixes every key", () => {
    const res = check({}, { a: { type: "string", required: true } }, { path: "body" });
    assert.deepEqual(res.fields, { "body.a": { code: "required" } });
    const unknown = check({ nope: 1 }, { a: { type: "string" } }, { path: "body" });
    assert.deepEqual(unknown.fields, { "body.$unknown": { code: "unknown_field" } });
  });
});

describe("validate", () => {
  test("returns the value or throws SchemaError validation_failed with fields", () => {
    assert.deepEqual(validate({ a: "x" }, { a: { type: "string" } }), { a: "x" });
    try {
      validate({}, { a: { type: "string", required: true } });
      assert.fail("expected a throw");
    } catch (err) {
      assert.ok(err instanceof SchemaError);
      assert.equal(err.code, "validation_failed");
      assert.deepEqual(err.fields, { a: { code: "required" } });
    }
  });

  test("a body that is not an object is bad_request", () => {
    for (const bad of ["x", 4, true, [], [1]]) {
      assert.throws(
        () => validate(bad, { a: { type: "string" } }),
        (err) => err instanceof SchemaError && err.code === "bad_request" && err.fields === undefined,
      );
    }
    assert.deepEqual(validate(undefined, {}), {});
    assert.deepEqual(validate(null, {}), {});
  });

  test("an unknown property is $unknown and the name is never echoed", () => {
    try {
      validate({ a: "x", secretName: "secretValue" }, { a: { type: "string" } });
      assert.fail("expected a throw");
    } catch (err) {
      assert.deepEqual(err.fields, { $unknown: { code: "unknown_field" } });
      assert.doesNotMatch(JSON.stringify(err.fields), /secretName|secretValue/);
    }
  });

  test("lists every fault at once", () => {
    try {
      validate({ a: 1, b: "x" }, { a: { type: "string" }, b: { type: "int" }, c: { type: "string", required: true } });
      assert.fail("expected a throw");
    } catch (err) {
      assert.deepEqual(Object.keys(err.fields).sort(), ["a", "b", "c"]);
    }
  });
});

describe("existing rules: string", () => {
  const rule = (extra) => ({ s: { type: "string", ...extra } });

  test("type, minLength and maxLength count code points", () => {
    assert.equal(check({ s: 5 }, rule()).fields.s.code, "invalid_type");
    assert.deepEqual(check({ s: "" }, rule({ minLength: 1 })).fields.s, { code: "too_short", params: { min: 1 } });
    assert.deepEqual(check({ s: "abcd" }, rule({ maxLength: 3 })).fields.s, { code: "too_long", params: { max: 3 } });
    // two emoji are 2 code points (4 UTF-16 units)
    assert.deepEqual(check({ s: "\u{1F600}\u{1F600}" }, rule({ maxLength: 2 })).fields, {});
    assert.equal(check({ s: "\u{1F600}\u{1F600}\u{1F600}" }, rule({ maxLength: 2 })).fields.s.code, "too_long");
  });

  test("pattern and enum", () => {
    assert.equal(check({ s: "ab" }, rule({ pattern: /^\d+$/ })).fields.s.code, "invalid_format");
    assert.deepEqual(check({ s: "12" }, rule({ pattern: /^\d+$/ })).value, { s: "12" });
    assert.deepEqual(check({ s: "c" }, rule({ enum: ["a", "b"] })).fields.s, { code: "not_allowed", params: { allowed: ["a", "b"] } });
    assert.deepEqual(check({ s: "a" }, rule({ enum: ["a", "b"] })).fields, {});
  });

  test("trim and NFC / NFKC normalisation", () => {
    assert.deepEqual(check({ s: "  hi  " }, rule({ trim: true })).value, { s: "hi" });
    assert.deepEqual(check({ s: "  hi  " }, rule()).value, { s: "  hi  " });
    // NFC composes e + combining acute
    assert.deepEqual(check({ s: "é" }, rule()).value, { s: "é" });
    // NFKC folds the fullwidth letter, NFC does not
    assert.deepEqual(check({ s: "Ａ" }, rule({ nfkc: true })).value, { s: "A" });
    assert.deepEqual(check({ s: "Ａ" }, rule()).value, { s: "Ａ" });
  });
});

describe("existing rules: int, number, boolean", () => {
  test("int refuses floats, strings and non-finite numbers", () => {
    const rules = { n: { type: "int" } };
    assert.equal(check({ n: 1.5 }, rules).fields.n.code, "invalid_type");
    assert.equal(check({ n: "1" }, rules).fields.n.code, "invalid_type");
    assert.equal(check({ n: Infinity }, rules).fields.n.code, "invalid_type");
    assert.equal(check({ n: NaN }, rules).fields.n.code, "invalid_type");
    assert.deepEqual(check({ n: 3 }, rules).value, { n: 3 });
  });

  test("number accepts floats; min / max / enum", () => {
    assert.deepEqual(check({ n: 1.5 }, { n: { type: "number" } }).value, { n: 1.5 });
    assert.deepEqual(check({ n: 11 }, { n: { type: "int", min: 1, max: 10 } }).fields.n, { code: "out_of_range", params: { min: 1, max: 10 } });
    assert.deepEqual(check({ n: 0 }, { n: { type: "int", min: 1 } }).fields.n.code, "out_of_range");
    assert.deepEqual(check({ n: 3 }, { n: { type: "int", enum: [1, 2] } }).fields.n, { code: "not_allowed", params: { allowed: [1, 2] } });
    assert.deepEqual(check({ n: 2 }, { n: { type: "int", enum: [1, 2] } }).fields, {});
  });

  test("boolean", () => {
    assert.deepEqual(check({ b: false }, { b: { type: "boolean" } }).value, { b: false });
    assert.equal(check({ b: "true" }, { b: { type: "boolean" } }).fields.b.code, "invalid_type");
    assert.equal(check({ b: 1 }, { b: { type: "boolean" } }).fields.b.code, "invalid_type");
  });
});

describe("existing rules: array, object, required, nullable, default", () => {
  test("array min / max / items; an item fault is reported on the array itself (unchanged)", () => {
    const rules = { a: { type: "array", min: 1, max: 2, items: { type: "string", maxLength: 3 } } };
    assert.equal(check({ a: "x" }, rules).fields.a.code, "invalid_type");
    assert.deepEqual(check({ a: [] }, rules).fields.a, { code: "too_short", params: { min: 1 } });
    assert.deepEqual(check({ a: ["a", "b", "c"] }, rules).fields.a, { code: "too_many_items", params: { max: 2 } });
    assert.deepEqual(check({ a: ["a", 4] }, rules).fields, { a: { code: "invalid_type" } });
    assert.deepEqual(check({ a: ["abcd"] }, rules).fields, { a: { code: "too_long", params: { max: 3 } } });
    assert.deepEqual(check({ a: ["a", "b"] }, rules).value, { a: ["a", "b"] });
  });

  test("array without items keeps the elements as they are", () => {
    const list = [1, "x", null];
    assert.deepEqual(check({ a: list }, { a: { type: "array" } }).value, { a: list });
  });

  test("object without shape is passed through and must be a plain object", () => {
    const rules = { o: { type: "object" } };
    const inner = { anything: 1 };
    assert.equal(check({ o: inner }, rules).value.o, inner);
    assert.equal(check({ o: [] }, rules).fields.o.code, "invalid_type");
    assert.equal(check({ o: "x" }, rules).fields.o.code, "invalid_type");
  });

  test("required, nullable and default", () => {
    assert.deepEqual(check({}, { a: { type: "string", required: true } }).fields.a, { code: "required" });
    assert.deepEqual(check({ a: null }, { a: { type: "string", required: true } }).fields.a, { code: "required" });
    assert.deepEqual(check({ a: null }, { a: { type: "string", nullable: true } }).value, { a: null });
    assert.deepEqual(check({}, { a: { type: "string", nullable: true } }).value, {});
    assert.deepEqual(check({}, { a: { type: "int", default: 7 } }).value, { a: 7 });
    assert.deepEqual(check({ a: null }, { a: { type: "int", default: 7 } }).value, { a: 7 });
    assert.deepEqual(check({ a: 2 }, { a: { type: "int", default: 7 } }).value, { a: 2 });
  });
});

describe("shape: nested objects", () => {
  const buttons = {
    buttons: {
      type: "array",
      required: true,
      min: 1,
      max: 3,
      items: {
        type: "object",
        shape: {
          id: { type: "string", required: true, pattern: /^[A-Za-z0-9_.-]{1,64}$/ },
          label: { type: "string", required: true, trim: true, minLength: 1, maxLength: 20 },
        },
      },
    },
  };

  test("a valid tree builds fresh objects at every level", () => {
    const input = { buttons: [{ id: "a", label: " Yes " }, { id: "b", label: "No" }] };
    const res = check(input, buttons);
    assert.deepEqual(res.fields, {});
    assert.deepEqual(res.value, { buttons: [{ id: "a", label: "Yes" }, { id: "b", label: "No" }] });
    assert.notEqual(res.value.buttons[0], input.buttons[0]);
  });

  test("faults are keyed by dotted path with the array index", () => {
    const res = check({ buttons: [{ id: "a", label: "ok" }, { id: "bad id", label: "" }] }, buttons);
    assert.deepEqual(res.fields, {
      "buttons.1.id": { code: "invalid_format" },
      "buttons.1.label": { code: "too_short", params: { min: 1 } },
    });
  });

  test("a missing nested required field is reported at its path", () => {
    assert.deepEqual(check({ buttons: [{ id: "a" }] }, buttons).fields, { "buttons.0.label": { code: "required" } });
  });

  test("an item that is not an object is invalid_type at the item", () => {
    assert.deepEqual(check({ buttons: ["x", null, []] }, buttons).fields, {
      "buttons.0": { code: "invalid_type" },
      "buttons.1": { code: "invalid_type" },
      "buttons.2": { code: "invalid_type" },
    });
  });

  test("array bounds stay on the array path", () => {
    assert.deepEqual(check({ buttons: [] }, buttons).fields, { buttons: { code: "too_short", params: { min: 1 } } });
    const four = [1, 2, 3, 4].map((n) => ({ id: `i${n}`, label: "x" }));
    assert.deepEqual(check({ buttons: four }, buttons).fields, { buttons: { code: "too_many_items", params: { max: 3 } } });
  });

  test("{ type: object, shape } on a property recurses the same way", () => {
    const rules = {
      media: {
        type: "object",
        shape: { url: { type: "string", required: true, maxLength: 10 }, name: { type: "string" } },
      },
    };
    assert.deepEqual(check({ media: { url: "u" } }, rules), { value: { media: { url: "u" } }, fields: {} });
    assert.deepEqual(check({ media: {} }, rules).fields, { "media.url": { code: "required" } });
    assert.deepEqual(check({ media: { url: "u".repeat(11) } }, rules).fields, { "media.url": { code: "too_long", params: { max: 10 } } });
    assert.deepEqual(check({ media: "x" }, rules).fields, { media: { code: "invalid_type" } });
    assert.deepEqual(check({ media: [] }, rules).fields, { media: { code: "invalid_type" } });
  });

  test("a nested object is optional unless required, nullable or defaulted like any field", () => {
    const rules = { media: { type: "object", nullable: true, shape: { url: { type: "string", required: true } } } };
    assert.deepEqual(check({}, rules), { value: {}, fields: {} });
    assert.deepEqual(check({ media: null }, rules).value, { media: null });
  });

  test("deep nesting: contacts.0.phones.2", () => {
    const contacts = {
      contacts: {
        type: "array",
        required: true,
        items: {
          type: "object",
          shape: {
            name: { type: "string", required: true },
            phones: { type: "array", required: true, min: 1, max: 5, unique: true, items: { type: "string", pattern: /^\d{8,15}$/ } },
          },
        },
      },
    };
    const input = { contacts: [{ name: "A", phones: ["237690000001"] }, { name: "B", phones: ["237690000002", "237690000003", "bad"] }] };
    assert.deepEqual(check(input, contacts).fields, { "contacts.1.phones.2": { code: "invalid_format" } });
    const dup = { contacts: [{ name: "A", phones: ["237690000001", "237690000002", "237690000001"] }] };
    assert.deepEqual(check(dup, contacts).fields, { "contacts.0.phones.2": { code: "duplicate" } });
  });
});

describe("$unknown at every level (RT-121)", () => {
  const rules = {
    title: { type: "string" },
    media: { type: "object", shape: { url: { type: "string" } } },
    buttons: { type: "array", items: { type: "object", shape: { id: { type: "string" } } } },
  };

  test("top level", () => {
    assert.deepEqual(check({ nope: 1 }, rules).fields, { $unknown: { code: "unknown_field" } });
  });

  test("nested object", () => {
    assert.deepEqual(check({ media: { url: "u", nope: 1 } }, rules).fields, { "media.$unknown": { code: "unknown_field" } });
  });

  test("array item", () => {
    assert.deepEqual(check({ buttons: [{ id: "a" }, { id: "b", nope: 1 }] }, rules).fields, {
      "buttons.1.$unknown": { code: "unknown_field" },
    });
  });

  test("several levels at once, one entry per level", () => {
    const res = check({ top: 1, media: { zzz: 1 }, buttons: [{ yyy: 2 }] }, rules);
    assert.deepEqual(res.fields, {
      $unknown: { code: "unknown_field" },
      "media.$unknown": { code: "unknown_field" },
      "buttons.0.$unknown": { code: "unknown_field" },
    });
  });

  test("neither the property name nor a submitted value is echoed", () => {
    const res = check({ sneakyKey: "sneakyValue", media: { innerKey: "innerValue" }, buttons: [{ id: 5, deepKey: "deepValue" }] }, rules);
    const dump = JSON.stringify(res.fields);
    for (const leak of ["sneakyKey", "sneakyValue", "innerKey", "innerValue", "deepKey", "deepValue"]) {
      assert.ok(!dump.includes(leak), `${leak} must not be echoed`);
    }
  });
});

describe("unique: scalar arrays", () => {
  const rules = { options: { type: "array", unique: true, items: { type: "string", trim: true, minLength: 1, maxLength: 100 } } };

  test("the later occurrence is the duplicate", () => {
    assert.deepEqual(check({ options: ["a", "b", "a"] }, rules).fields, { "options.2": { code: "duplicate" } });
    assert.deepEqual(check({ options: ["a", "a", "a"] }, rules).fields, { "options.1": { code: "duplicate" }, "options.2": { code: "duplicate" } });
  });

  test("compared after trim and NFC normalisation, case-sensitive", () => {
    assert.deepEqual(check({ options: ["café", " café "] }, rules).fields, { "options.1": { code: "duplicate" } });
    assert.deepEqual(check({ options: ["Yes", "yes"] }, rules).fields, {});
  });

  test("a trimming difference is a duplicate even when the rule itself does not trim", () => {
    const loose = { list: { type: "array", unique: true, items: { type: "string" } } };
    assert.deepEqual(check({ list: ["a", "a "] }, loose).fields, { "list.1": { code: "duplicate" } });
  });

  test("distinct values pass and keep their order", () => {
    assert.deepEqual(check({ options: ["a", "b", "c"] }, rules), { value: { options: ["a", "b", "c"] }, fields: {} });
  });

  test("numbers are compared by value", () => {
    const nums = { ids: { type: "array", unique: true, items: { type: "int" } } };
    assert.deepEqual(check({ ids: [1, 2, 1] }, nums).fields, { "ids.2": { code: "duplicate" } });
  });

  test("an item fault is keyed by its index and does not hide the others", () => {
    const res = check({ options: ["a", "", "b", "a", 5] }, rules);
    assert.deepEqual(res.fields, {
      "options.1": { code: "too_short", params: { min: 1 } },
      "options.3": { code: "duplicate" },
      "options.4": { code: "invalid_type" },
    });
  });

  test("array bounds are checked before the items", () => {
    const bounded = { options: { type: "array", min: 2, max: 3, unique: true, items: { type: "string" } } };
    assert.deepEqual(check({ options: ["a"] }, bounded).fields, { options: { code: "too_short", params: { min: 2 } } });
    assert.deepEqual(check({ options: ["a", "b", "c", "d"] }, bounded).fields, { options: { code: "too_many_items", params: { max: 3 } } });
  });

  test("a duplicate is never echoed", () => {
    const dump = JSON.stringify(check({ options: ["leaky", "leaky"] }, rules).fields);
    assert.ok(!dump.includes("leaky"));
  });
});

describe("a schema without shape / unique behaves exactly as before", () => {
  test("repeated scalars are fine and item faults stay on the array", () => {
    const rules = { tags: { type: "array", items: { type: "string", maxLength: 2 } } };
    assert.deepEqual(check({ tags: ["a", "a"] }, rules), { value: { tags: ["a", "a"] }, fields: {} });
    assert.deepEqual(check({ tags: ["a", "toolong"] }, rules).fields, { tags: { code: "too_long", params: { max: 2 } } });
  });
});

// ---------------------------------------------------------------------------
// Parity with lib/admin/http/request.js (RT-120)
// ---------------------------------------------------------------------------

const PARITY_SCHEMA = {
  name: { type: "string", required: true, trim: true, minLength: 1, maxLength: 8 },
  kind: { type: "string", enum: ["a", "b"], default: "a" },
  code: { type: "string", pattern: /^\d{3}$/, nullable: true },
  count: { type: "int", min: 0, max: 10 },
  ratio: { type: "number", min: 0, max: 1 },
  flag: { type: "boolean" },
  tags: { type: "array", max: 3, items: { type: "string", maxLength: 3 } },
  extra: { type: "object" },
  secret: { type: "string", nfkc: true, minLength: 4 },
};

const PARITY_INPUTS = [
  { name: "ok" },
  { name: "  spaced  ", kind: "b", count: 3, ratio: 0.5, flag: true, tags: ["a", "b"], extra: { x: 1 } },
  {},
  { name: "" },
  { name: "x".repeat(9) },
  { name: 5 },
  { name: "ok", kind: "c" },
  { name: "ok", code: null },
  { name: "ok", code: "12" },
  { name: "ok", count: 11 },
  { name: "ok", count: 1.5 },
  { name: "ok", ratio: "0.5" },
  { name: "ok", flag: "yes" },
  { name: "ok", tags: ["a", "b", "c", "d"] },
  { name: "ok", tags: ["a", 7] },
  { name: "ok", extra: [] },
  { name: "ok", secret: "ＡＢＣＤ" },
  { name: "ok", unknownField: 1 },
  { unknownField: 1, count: -1 },
  null,
  undefined,
  "string body",
  [],
  [{ name: "ok" }],
];

function outcome(fn) {
  try {
    return { value: fn() };
  } catch (err) {
    return { code: err.code, fields: err.fields, error: err };
  }
}

describe("parity with lib/admin/http/request.js (RT-120)", () => {
  test("the table holds at least 15 inputs", () => {
    assert.ok(PARITY_INPUTS.length >= 15);
  });

  test("request.js still exports validate and codePoints", () => {
    assert.equal(typeof request.validate, "function");
    assert.equal(request.codePoints, codePoints);
  });

  PARITY_INPUTS.forEach((input, index) => {
    test(`input ${index}: same value or same fields`, () => {
      const viaCore = outcome(() => validate(input, PARITY_SCHEMA));
      const viaPanel = outcome(() => request.validate(input, PARITY_SCHEMA));
      if ("value" in viaCore) {
        assert.deepEqual(viaPanel.value, viaCore.value);
        return;
      }
      assert.equal(viaPanel.code, viaCore.code);
      assert.deepEqual(viaPanel.fields, viaCore.fields);
      // a SchemaError is re-thrown by the wrapper as an AdminError
      assert.ok(viaCore.error instanceof SchemaError);
      assert.ok(viaPanel.error instanceof AdminError, "the panel keeps throwing AdminError");
      assert.ok(!(viaPanel.error instanceof SchemaError));
    });
  });

  test("an AdminError keeps the status table: validation_failed carries fields, bad_request does not", () => {
    const failed = outcome(() => request.validate({}, PARITY_SCHEMA));
    assert.equal(failed.code, "validation_failed");
    assert.deepEqual(failed.fields.name, { code: "required" });
    const bad = outcome(() => request.validate("nope", PARITY_SCHEMA));
    assert.equal(bad.code, "bad_request");
    assert.equal(bad.fields, undefined);
  });

  test("the wrapper also validates the new rules (shape, unique) identically", () => {
    const rules = { options: { type: "array", unique: true, items: { type: "string" } }, box: { type: "object", shape: { n: { type: "int" } } } };
    const input = { options: ["a", "a"], box: { n: "x", z: 1 } };
    const viaCore = outcome(() => validate(input, rules));
    const viaPanel = outcome(() => request.validate(input, rules));
    assert.equal(viaPanel.code, "validation_failed");
    assert.deepEqual(viaPanel.fields, viaCore.fields);
    assert.ok(viaPanel.error instanceof AdminError);
  });

  test("a non-schema error thrown inside a custom rule is not swallowed or converted", () => {
    const boom = { get pattern() { throw new TypeError("boom"); }, type: "string" };
    assert.throws(() => request.validate({ a: "x" }, { a: boom }), TypeError);
  });
});
