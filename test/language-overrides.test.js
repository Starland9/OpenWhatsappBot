"use strict";
/**
 * T040: LanguageManager overrides, reload and capture (contracts/runtime.md section 4).
 *
 * Most tests build their own LanguageManager on a temporary lang/ folder; a few check the
 * singleton against the real lang/en.json and lang/fr.json.
 */

const { test, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ sudo: "111", lang: "fr" });

const {
  getLang,
  languageManager,
  LanguageManager,
  TextOverrideError,
} = require("../lib/utils/language");

const sha16 = (text) => crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);

const EN = {
  common: { hello: "Hello {0}", only_en: "Only English", plain: "Plain" },
  plugins: { x: { desc: "Desc X", count: "{0} of {1}", dup: "{0} then {0}" } },
};
const FR = {
  common: { hello: "Bonjour {0}", plain: "Simple" },
  plugins: { x: { desc: "Desc X fr", count: "{0} sur {1}", dup: "{0} puis {0}" } },
};

const dirs = [];

/** A lang/ folder with en.json and fr.json, and a manager reading it */
function makeManager(lang = "fr", { en = EN, fr = FR } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lang-test-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify(en));
  fs.writeFileSync(path.join(dir, "fr.json"), JSON.stringify(fr));
  const source = { LANG: lang };
  const manager = new LanguageManager({ langDir: dir, config: source });
  return { manager, dir, source };
}

afterEach(() => {
  mock.restoreAll();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const refusal = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected a TextOverrideError");
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test("getLang: translation, placeholders, English fallback, then the key", () => {
  const { manager } = makeManager("fr");
  assert.equal(manager.getLang("common.hello", "Zoe"), "Bonjour Zoe");
  assert.equal(manager.getLang("plugins.x.count", 1, 2), "1 sur 2");
  assert.equal(manager.getLang("plugins.x.count", 1), "1 sur {1}", "a missing argument keeps its token");
  assert.equal(manager.getLang("common.only_en"), "Only English", "missing in fr: English");
  assert.equal(manager.getLang("common.nowhere"), "common.nowhere");
  assert.equal(manager.getLang("common"), "common", "a branch is not a text");
  assert.equal(manager.getLang("plugins.x.desc.deeper"), "plugins.x.desc.deeper");
  assert.equal(manager.getLang("constructor"), "constructor");
  assert.equal(manager.getLang("__proto__"), "__proto__");
});

test("English instance: missing key returns the key", () => {
  const { manager } = makeManager("en");
  assert.equal(manager.getLang("common.hello", "Zoe"), "Hello Zoe");
  assert.equal(manager.getLang("common.nowhere"), "common.nowhere");
});

test("the English fallback is parsed once, not re-read on every miss", () => {
  const { manager } = makeManager("fr");
  manager.getLang("common.only_en"); // warm up
  const reads = mock.method(fs, "readFileSync");
  for (let i = 0; i < 50; i++) manager.getLang("common.only_en");
  manager.getLang("common.nowhere");
  manager.getBase("en", "common.plain");
  manager.getBase("fr", "common.plain");
  manager.listKeys();
  assert.equal(reads.mock.callCount(), 0);
});

test("an unknown locale file falls back to English", () => {
  const { manager } = makeManager("zz");
  assert.equal(manager.currentLang, "en");
  assert.equal(manager.getLang("common.plain"), "Plain");
});

test("property names translations and currentLang stay (fakes.applyPendingI18n mutates them)", () => {
  const { manager } = makeManager("fr");
  assert.equal(manager.currentLang, "fr");
  assert.equal(typeof manager.translations, "object");
  manager.translations.pending = { key: "Ajoutée" };
  assert.equal(manager.getLang("pending.key"), "Ajoutée");
  assert.equal(manager.hasKey("pending.key"), true);
  assert.equal(manager.hasKey("nope.key"), false);
});

test("the singleton still resolves the real language files", () => {
  assert.equal(languageManager.currentLang, "fr");
  assert.notEqual(getLang("plugins.alive.desc"), "plugins.alive.desc");
  const uptime = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "lang", "fr.json"), "utf8")).plugins.alive.uptime_value;
  assert.equal(getLang("plugins.alive.uptime_value", 1, 2, 3), uptime.replace("{0}", 1).replace("{1}", 2).replace("{2}", 3));
  assert.equal(getLang("plugins.nowhere.key"), "plugins.nowhere.key");
});

// ---------------------------------------------------------------------------
// reload
// ---------------------------------------------------------------------------

test("reload() re-reads config.LANG and the language file", () => {
  const { manager, dir, source } = makeManager("fr");
  assert.equal(manager.getLang("common.plain"), "Simple");

  source.LANG = "en";
  manager.reload();
  assert.equal(manager.currentLang, "en");
  assert.equal(manager.getLang("common.plain"), "Plain");

  fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify({ common: { plain: "Edited" } }));
  manager.reload();
  assert.equal(manager.getLang("common.plain"), "Edited");
  assert.equal(manager.getBase("en", "common.plain"), "Edited");
});

test("reload() keeps the overrides", () => {
  const { manager, source } = makeManager("fr");
  manager.setOverride("fr", "common.plain", "Perso");
  manager.setOverride("en", "common.plain", "Custom");
  source.LANG = "en";
  manager.reload();
  assert.equal(manager.getLang("common.plain"), "Custom");
  source.LANG = "fr";
  manager.reload();
  assert.equal(manager.getLang("common.plain"), "Perso");
});

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

test("setOverride takes effect at once and returns the original hash", () => {
  const { manager } = makeManager("fr");
  const { originalHash } = manager.setOverride("fr", "common.hello", "Salut {0} !");
  assert.equal(originalHash, sha16("Bonjour {0}"));
  assert.match(originalHash, /^[0-9a-f]{16}$/);
  assert.equal(manager.getLang("common.hello", "Zoe"), "Salut Zoe !");
  assert.equal(manager.originalHash("fr", "common.hello"), originalHash);
  assert.equal(manager.originalHash("en", "common.hello"), sha16("Hello {0}"));
  assert.equal(manager.originalHash("fr", "common.only_en"), null);
});

test("placeholders are replaced after resolution, with a literal replacement", () => {
  const { manager } = makeManager("fr");
  manager.setOverride("fr", "common.hello", "$& {0} $1");
  assert.equal(manager.getLang("common.hello", "Zoe"), "$& Zoe $1");
});

test("resolution order: override(lang) > translations > override(en) > en.json > key", () => {
  const { manager } = makeManager("fr");
  // key only in English: override(en) beats en.json
  assert.equal(manager.getLang("common.only_en"), "Only English");
  manager.setOverride("en", "common.only_en", "English custom");
  assert.equal(manager.getLang("common.only_en"), "English custom");
  // key in both: the fr override beats fr, the en override does not
  manager.setOverride("en", "common.plain", "Custom EN");
  assert.equal(manager.getLang("common.plain"), "Simple");
  manager.setOverride("fr", "common.plain", "Custom FR");
  assert.equal(manager.getLang("common.plain"), "Custom FR");
  manager.clearOverride("fr", "common.plain");
  assert.equal(manager.getLang("common.plain"), "Simple");
});

test("only the active language's overrides apply", () => {
  const { manager, source } = makeManager("en");
  manager.setOverride("fr", "common.plain", "Perso FR");
  assert.equal(manager.getLang("common.plain"), "Plain");
  source.LANG = "fr";
  manager.reload();
  assert.equal(manager.getLang("common.plain"), "Perso FR");
});

test("getBase / getEffective / getOverride", () => {
  const { manager } = makeManager("fr");
  assert.equal(manager.getBase("fr", "common.plain"), "Simple");
  assert.equal(manager.getBase("en", "common.plain"), "Plain");
  assert.equal(manager.getBase("fr", "common.only_en"), undefined);
  assert.equal(manager.getBase("xx", "common.plain"), undefined);
  assert.equal(manager.getBase("../fr", "common.plain"), undefined);
  assert.equal(manager.getBase("fr", "common"), undefined);

  assert.equal(manager.getEffective("fr", "common.plain"), "Simple");
  assert.equal(manager.getOverride("fr", "common.plain"), undefined);
  manager.setOverride("fr", "common.plain", "Perso");
  assert.equal(manager.getEffective("fr", "common.plain"), "Perso");
  assert.deepEqual(manager.getOverride("fr", "common.plain"), { text: "Perso", originalHash: sha16("Simple") });
  assert.equal(manager.getBase("fr", "common.plain"), "Simple", "the base is untouched");

  // the returned object is a copy
  manager.getOverride("fr", "common.plain").text = "mutated";
  assert.equal(manager.getEffective("fr", "common.plain"), "Perso");
});

test("clearOverride is silent when there is nothing to clear", () => {
  const { manager } = makeManager("fr");
  assert.doesNotThrow(() => manager.clearOverride("fr", "common.plain"));
  assert.doesNotThrow(() => manager.clearOverride("xx", "common.plain"));
});

test("isOriginalChanged: false without override, false while the original is the same, true after it changed", () => {
  const { manager, dir } = makeManager("fr");
  assert.equal(manager.isOriginalChanged("fr", "common.plain"), false);
  manager.setOverride("fr", "common.plain", "Perso");
  assert.equal(manager.isOriginalChanged("fr", "common.plain"), false);

  fs.writeFileSync(path.join(dir, "fr.json"), JSON.stringify({ ...FR, common: { ...FR.common, plain: "Simple v2" } }));
  manager.reload();
  assert.equal(manager.isOriginalChanged("fr", "common.plain"), true);
  assert.equal(manager.getLang("common.plain"), "Perso", "a changed original does not drop the override");
  assert.equal(manager.originalHash("fr", "common.plain"), sha16("Simple v2"));
});

test("listKeys: the flat string keys of the English file", () => {
  const { manager } = makeManager("fr");
  assert.deepEqual(manager.listKeys().sort(), [
    "common.hello",
    "common.only_en",
    "common.plain",
    "plugins.x.count",
    "plugins.x.desc",
    "plugins.x.dup",
  ]);
});

test("listKeys on the real files matches every key of lang/en.json", () => {
  const flat = [];
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node)) {
      const full = prefix ? `${prefix}.${name}` : name;
      if (value && typeof value === "object") walk(value, full);
      else flat.push(full);
    }
  };
  walk(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "lang", "en.json"), "utf8")), "");
  const keys = languageManager.listKeys();
  assert.equal(keys.length, flat.length);
  assert.deepEqual([...keys].sort(), [...flat].sort());
  assert.ok(keys.includes("plugins.alive.desc"));
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("unsupported_lang", () => {
  const { manager } = makeManager("fr");
  for (const lang of ["es", "EN", "", undefined, "../en"]) {
    const error = refusal(() => manager.setOverride(lang, "common.plain", "x"));
    assert.ok(error instanceof TextOverrideError);
    assert.ok(error instanceof Error);
    assert.equal(error.code, "unsupported_lang");
  }
  assert.equal(refusal(() => manager.setOverrides("es", { "common.plain": "x" })).code, "unsupported_lang");
});

test("unknown_key", () => {
  const { manager } = makeManager("fr");
  for (const key of ["nope.key", "common", "common.plain.deeper", "", undefined, 42, "constructor"]) {
    assert.equal(refusal(() => manager.setOverride("fr", key, "x")).code, "unknown_key", String(key));
  }
});

test("empty", () => {
  const { manager } = makeManager("fr");
  for (const text of ["", "   ", "\n\t", undefined, null, 5]) {
    assert.equal(refusal(() => manager.setOverride("fr", "common.plain", text)).code, "empty", String(text));
  }
});

test("too_long: more than 4000 characters", () => {
  const { manager } = makeManager("fr");
  assert.doesNotThrow(() => manager.setOverride("fr", "common.plain", "a".repeat(4000)));
  assert.equal(refusal(() => manager.setOverride("fr", "common.plain", "a".repeat(4001))).code, "too_long");
  // 3000 emoji are 6000 UTF-16 units but 3000 characters
  assert.doesNotThrow(() => manager.setOverride("fr", "common.plain", "\u{1F600}".repeat(3000)));
  assert.equal(refusal(() => manager.setOverride("fr", "common.plain", "\u{1F600}".repeat(4001))).code, "too_long");
});

test("placeholder_mismatch: same /\\{\\d+\\}/g multiset as the original, params.expected lists the tokens", () => {
  const { manager } = makeManager("fr");

  // a missing token, an extra token, a wrong one
  for (const text of ["pas de jeton", "{0}", "{0} sur {1} et {2}", "{0} sur {2}"]) {
    const error = refusal(() => manager.setOverride("fr", "plugins.x.count", text));
    assert.equal(error.code, "placeholder_mismatch", text);
    assert.deepEqual(error.params, { expected: ["{0}", "{1}"] });
  }
  // a token where the original has none
  const none = refusal(() => manager.setOverride("fr", "common.plain", "{0}"));
  assert.equal(none.code, "placeholder_mismatch");
  assert.deepEqual(none.params, { expected: [] });

  // reordering is fine, so is moving a token around
  assert.doesNotThrow(() => manager.setOverride("fr", "plugins.x.count", "{1} puis {0}"));
  // multiset: a duplicated token must stay duplicated
  assert.equal(refusal(() => manager.setOverride("fr", "plugins.x.dup", "{0}")).code, "placeholder_mismatch");
  assert.deepEqual(refusal(() => manager.setOverride("fr", "plugins.x.dup", "{0}")).params, { expected: ["{0}", "{0}"] });
  assert.doesNotThrow(() => manager.setOverride("fr", "plugins.x.dup", "{0}/{0}"));

  // compared with the base text of THAT language
  assert.doesNotThrow(() => manager.setOverride("en", "plugins.x.count", "{0}/{1}"));
});

test("the refusal never carries the submitted text and nothing is stored", () => {
  const { manager } = makeManager("fr");
  const secret = "sk-this-must-not-leak {7}";
  const error = refusal(() => manager.setOverride("fr", "common.plain", secret));
  assert.equal(error.code, "placeholder_mismatch");
  assert.ok(!error.message.includes("sk-"));
  assert.ok(!JSON.stringify(error.params).includes("sk-"));
  assert.equal(manager.getOverride("fr", "common.plain"), undefined);
  assert.equal(manager.getLang("common.plain"), "Simple");
});

// ---------------------------------------------------------------------------
// setOverrides (bulk replace)
// ---------------------------------------------------------------------------

test("setOverrides replaces the whole set of a language, from an object or a Map", () => {
  const { manager } = makeManager("fr");
  manager.setOverride("fr", "common.plain", "Old");
  manager.setOverride("en", "common.plain", "Kept EN");

  const result = manager.setOverrides("fr", { "common.hello": "Coucou {0}" });
  assert.deepEqual(result, { applied: 1, skipped: 0 });
  assert.equal(manager.getLang("common.hello", "Zoe"), "Coucou Zoe");
  assert.equal(manager.getLang("common.plain"), "Simple", "the previous fr set is gone");
  assert.equal(manager.getOverride("en", "common.plain").text, "Kept EN", "the other language is untouched");

  manager.setOverrides("fr", new Map([["common.plain", "Via Map"]]));
  assert.equal(manager.getLang("common.plain"), "Via Map");
  assert.equal(manager.getLang("common.hello", "Zoe"), "Bonjour Zoe");

  manager.setOverrides("fr", {});
  assert.equal(manager.getLang("common.plain"), "Simple");
  manager.setOverrides("fr", null);
  assert.equal(manager.getLang("common.plain"), "Simple");
});

test("setOverrides skips and logs the invalid entries, keeps the valid ones", () => {
  const { manager } = makeManager("fr");
  const warnings = [];
  manager.warn = (fields, message) => warnings.push(`${message} ${JSON.stringify(fields)}`);

  const result = manager.setOverrides("fr", {
    "common.plain": "Valid",
    "nope.key": "unknown key",
    "common.hello": "no token here",
    "plugins.x.desc": "   ",
    "plugins.x.count": "x".repeat(4001),
  });
  assert.deepEqual(result, { applied: 1, skipped: 4 });
  assert.equal(manager.getLang("common.plain"), "Valid");
  assert.equal(manager.getLang("common.hello", "Zoe"), "Bonjour Zoe");

  // key and code only: never the text
  const joined = warnings.join("\n");
  assert.match(joined, /nope\.key/);
  assert.match(joined, /unknown_key/);
  assert.match(joined, /placeholder_mismatch/);
  assert.ok(!joined.includes("no token here"));
});

test("setOverrides keeps a stored originalHash, so a changed original is detected after a restart", () => {
  const { manager } = makeManager("fr");
  manager.setOverrides("fr", {
    "common.plain": { text: "Stored", originalHash: sha16("An older original") },
    "common.hello": { text: "Fresh {0}" },
    "plugins.x.desc": "Just text",
  });
  assert.equal(manager.isOriginalChanged("fr", "common.plain"), true);
  assert.equal(manager.isOriginalChanged("fr", "common.hello"), false);
  assert.equal(manager.isOriginalChanged("fr", "plugins.x.desc"), false);
  assert.equal(manager.getLang("common.plain"), "Stored", "still in force");
});

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

test("capture records every synchronous getLang call with its result", () => {
  const { manager } = makeManager("fr");
  manager.setOverride("fr", "common.plain", "Perso");
  const { result, calls } = manager.capture(() => {
    manager.getLang("common.plain");
    manager.getLang("common.hello", "Zoe");
    manager.getLang("common.nowhere");
    return { desc: manager.getLang("plugins.x.desc") };
  });
  assert.deepEqual(result, { desc: "Desc X fr" });
  assert.deepEqual(calls, [
    { key: "common.plain", result: "Perso" },
    { key: "common.hello", result: "Bonjour Zoe" },
    { key: "common.nowhere", result: "common.nowhere" },
    { key: "plugins.x.desc", result: "Desc X fr" },
  ]);
  // the desc key is the call whose result equals the description
  assert.equal(calls.find((c) => c.result === result.desc).key, "plugins.x.desc");
});

test("capture stops recording when fn returns, throws, or goes async", async () => {
  const { manager } = makeManager("fr");
  manager.capture(() => manager.getLang("common.plain"));
  assert.equal(manager.captures.length, 0);

  assert.throws(
    () =>
      manager.capture(() => {
        manager.getLang("common.plain");
        throw new Error("boom");
      }),
    /boom/
  );
  assert.equal(manager.captures.length, 0);

  let late;
  const { calls } = manager.capture(() => {
    manager.getLang("common.plain");
    late = Promise.resolve().then(() => manager.getLang("common.hello", "x"));
  });
  await late;
  assert.deepEqual(calls.map((c) => c.key), ["common.plain"], "calls after the synchronous part are not recorded");
});

test("nested captures each see the calls of their own scope", () => {
  const { manager } = makeManager("fr");
  const outer = manager.capture(() => {
    manager.getLang("common.plain");
    const inner = manager.capture(() => manager.getLang("plugins.x.desc"));
    assert.deepEqual(inner.calls.map((c) => c.key), ["plugins.x.desc"]);
    manager.getLang("common.hello", "a");
  });
  assert.deepEqual(outer.calls.map((c) => c.key), ["common.plain", "plugins.x.desc", "common.hello"]);
});

test("capture works through the module-level getLang of the singleton", () => {
  const { calls } = languageManager.capture(() => getLang("plugins.alive.desc"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, "plugins.alive.desc");
  assert.equal(calls[0].result, languageManager.getLang("plugins.alive.desc"));
});

// ---------------------------------------------------------------------------
// Real files
// ---------------------------------------------------------------------------

test("singleton: an override on a real key round-trips and clears", () => {
  const key = "plugins.alive.uptime_value";
  const original = getLang(key, 1, 2, 3);
  try {
    assert.equal(languageManager.setOverride("fr", key, "{0}:{1}:{2}").originalHash.length, 16);
    assert.equal(getLang(key, 1, 2, 3), "1:2:3");
    assert.equal(refusal(() => languageManager.setOverride("fr", key, "{0}:{1}")).code, "placeholder_mismatch");
    assert.equal(getLang(key, 1, 2, 3), "1:2:3", "a refused text leaves the previous one");
  } finally {
    languageManager.clearOverride("fr", key);
  }
  assert.equal(getLang(key, 1, 2, 3), original);
});
