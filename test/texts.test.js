"use strict";
/**
 * Bot-text overrides (T193, SC-014, FR-057 to FR-060; contracts/runtime.md section 4):
 * lib/utils/textOverrides.js on top of the LanguageManager (lib/utils/language.js), the in-memory database and the
 * lazy command descriptions of the registry.
 *
 *  - a text saved through textOverrides.save is what getLang returns on the very next call, menu and command
 *    descriptions included;
 *  - a version that removes or adds a {n} placeholder is refused with placeholder_mismatch and the expected tokens;
 *  - resolution order: override -> file -> English override -> English file -> key;
 *  - unsupported_lang, unknown_key, empty, too_long (4000);
 *  - originalChanged is flagged when the file text changes while the override stays in force;
 *  - clear reverts to the original; exportRows / importRows round trip; the overrides survive
 *    languageManager.reload() and a restart (load() from the table).
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ lang: "fr" });

const { getLang, languageManager, TextOverrideError, MAX_OVERRIDE_LENGTH } = require("../lib/utils/language");
const textOverrides = require("../lib/utils/textOverrides");
const config = require("../config");

let db;
const PING = "plugins.ping.desc";
const HELLO = "common.error";

/** Flat key -> text of a language file */
function flatten(tree, prefix = "", out = {}) {
  for (const [name, value] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (typeof value === "string") out[key] = value;
    else flatten(value, key, out);
  }
  return out;
}
const EN = flatten(require("../lang/en.json"));
const FR = flatten(require("../lang/fr.json"));
const tokens = (text) => (text.match(/\{\d+\}/g) || []).sort();
const withTokens = Object.keys(EN).filter((key) => tokens(EN[key]).length > 0);

const refusal = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a refusal");
};

before(async () => {
  db = await fakes.syncDb();
});

beforeEach(async () => {
  await db.TextOverride.destroy({ where: {} });
  languageManager.reload();
  await textOverrides.load({ models: db });
});

afterEach(() => {
  languageManager.reload();
});

describe("SC-014: a saved text is what getLang returns next", () => {
  test("the very next call, in the active language", async () => {
    assert.equal(getLang(HELLO), FR[HELLO]);
    const saved = await textOverrides.save("fr", HELLO, "Oups, une erreur !", { actor: "test" });
    assert.equal(getLang(HELLO), "Oups, une erreur !");
    assert.equal(saved.originalHash.length, 16);
    const row = await db.TextOverride.findOne({ where: { key: HELLO, lang: "fr" }, raw: true });
    assert.deepEqual([row.text, row.originalHash], ["Oups, une erreur !", saved.originalHash]);
  });

  test("an English override does not replace the French text while the bot speaks French; it is the fallback", async () => {
    await textOverrides.save("en", HELLO, "English replacement");
    assert.equal(getLang(HELLO), FR[HELLO]);
    assert.equal(languageManager.getEffective("en", HELLO), "English replacement");
  });

  test("placeholders are filled in after resolution", async () => {
    const key = withTokens.find((candidate) => tokens(EN[candidate]).join() === "{0}");
    assert.ok(key, "a text with one {0}");
    await textOverrides.save("fr", key, "Remplacé : {0} !");
    assert.equal(getLang(key, "valeur"), "Remplacé : valeur !");
  });

  test("a command description follows at once (lazy desc), and so do the help card and the menu", async () => {
    const { registry, failed } = await fakes.loadAllPlugins();
    assert.deepEqual(failed, []);
    const entry = registry.getCommandByPattern("ping");
    assert.equal(entry.descKey, PING, "the loader found the key behind the description");
    assert.equal(entry.desc, FR[PING]);

    await textOverrides.save("fr", PING, "Mesure la latence du bot");
    assert.equal(entry.desc, "Mesure la latence du bot", "no restart, no reload");

    const help = require("../plugins/help");
    const message = fakes.makeMessage({ body: ".help ping" });
    await help.execute(message, "ping");
    const sent = fakes.sentTexts(message.client.getSocket());
    assert.ok(sent.some((text) => text.includes("Mesure la latence du bot")), sent.join("\n"));

    await textOverrides.clear("fr", PING);
    assert.equal(entry.desc, FR[PING]);
  });

  test("a description follows the language of the bot: the English override applies once BOT_LANG is en", async () => {
    const { registry } = await fakes.loadAllPlugins();
    const entry = registry.getCommandByPattern("ping");
    await textOverrides.save("en", PING, "Measures the bot latency");
    await textOverrides.save("fr", PING, "Mesure la latence");
    assert.equal(entry.desc, "Mesure la latence");
    config.LANG = "en"; // what the BOT_LANG change does, then languageManager.reload()
    try {
      languageManager.reload();
      assert.equal(entry.desc, "Measures the bot latency");
    } finally {
      config.LANG = "fr";
      languageManager.reload();
    }
  });
});

describe("placeholders (FR-059)", () => {
  test("a text that drops a {n} is refused with the expected tokens, and nothing changes", async () => {
    const key = withTokens.find((candidate) => tokens(EN[candidate]).length >= 2);
    assert.ok(key);
    const expected = languageManager.getBase("fr", key).match(/\{\d+\}/g).sort();
    const error = await refusal(textOverrides.save("fr", key, "texte sans variable"));
    assert.ok(error instanceof TextOverrideError);
    assert.equal(error.code, "placeholder_mismatch");
    assert.deepEqual(error.params.expected, expected);
    assert.equal(getLang(key, "a", "b"), languageManager.getBase("fr", key).replace(/\{0\}/g, "a").replace(/\{1\}/g, "b"));
    assert.equal(await db.TextOverride.count(), 0, "no row was written");
  });

  test("a text that adds a {n}, or repeats one, is refused as well; a reordering is fine", async () => {
    const key = withTokens.find((candidate) => tokens(FR[candidate]).join() === "{0}");
    assert.equal((await refusal(textOverrides.save("fr", key, `${FR[key]} {1}`))).code, "placeholder_mismatch");
    assert.equal((await refusal(textOverrides.save("fr", key, `${FR[key]} {0}`))).code, "placeholder_mismatch");
    const two = withTokens.find((candidate) => tokens(FR[candidate]).join() === "{0},{1}");
    assert.ok(two);
    await textOverrides.save("fr", two, "{1} puis {0}");
    assert.equal(getLang(two, "a", "b"), "b puis a");
  });

  test("for every text of lang/en.json with a placeholder: the original is accepted, a missing or an extra token is refused", async () => {
    const problems = [];
    for (const key of withTokens) {
      for (const lang of ["en", "fr"]) {
        const base = lang === "en" ? EN[key] : FR[key];
        if (base === undefined) continue;
        try {
          languageManager.validateOverride(lang, key, base);
        } catch (error) {
          problems.push(`${lang}:${key} original refused (${error.code})`);
        }
        const missing = base.replace(/\{\d+\}/, "");
        try {
          languageManager.validateOverride(lang, key, missing || "x");
          problems.push(`${lang}:${key} accepted without a token`);
        } catch (error) {
          if (error.code !== "placeholder_mismatch") problems.push(`${lang}:${key} ${error.code}`);
        }
        try {
          languageManager.validateOverride(lang, key, `${base} {9}`);
          problems.push(`${lang}:${key} accepted with an extra token`);
        } catch (error) {
          if (error.code !== "placeholder_mismatch") problems.push(`${lang}:${key} ${error.code}`);
        }
      }
    }
    assert.deepEqual(problems, []);
    assert.ok(withTokens.length > 100, `${withTokens.length} texts have placeholders`);
  });

  test("a text without any placeholder refuses one", async () => {
    const key = Object.keys(EN).find((candidate) => tokens(EN[candidate]).length === 0 && tokens(FR[candidate] || "").length === 0);
    assert.equal((await refusal(textOverrides.save("fr", key, "avec {0}"))).code, "placeholder_mismatch");
    await textOverrides.save("fr", key, "sans variable");
    assert.equal(getLang(key), "sans variable");
  });
});

describe("resolution order", () => {
  test("override -> file -> English override -> English file -> the key", async () => {
    const key = HELLO;
    const frText = languageManager.translations;
    // a key the French file lacks: the English tiers apply
    const [section, leaf] = ["common", "error"];
    const saved = frText[section][leaf];
    try {
      delete frText[section][leaf];
      assert.equal(getLang(key), EN[key], "English file");
      await textOverrides.save("en", key, "English override");
      assert.equal(getLang(key), "English override", "English override beats the English file");
      frText[section][leaf] = saved;
      assert.equal(getLang(key), saved, "the French file beats the English override");
      await textOverrides.save("fr", key, "Surcharge française");
      assert.equal(getLang(key), "Surcharge française", "the French override beats the French file");
      await textOverrides.clear("fr", key);
      assert.equal(getLang(key), saved);
    } finally {
      frText[section][leaf] = saved;
    }
    assert.equal(getLang("no.such.key"), "no.such.key", "the key itself, last");
  });
});

describe("refusals", () => {
  test("unsupported_lang, unknown_key, empty, too_long", async () => {
    assert.equal((await refusal(textOverrides.save("es", HELLO, "x"))).code, "unsupported_lang");
    assert.equal((await refusal(textOverrides.save("fr", "no.such.key", "x"))).code, "unknown_key");
    assert.equal((await refusal(textOverrides.save("fr", HELLO, ""))).code, "empty");
    assert.equal((await refusal(textOverrides.save("fr", HELLO, "  \n "))).code, "empty");
    assert.equal(MAX_OVERRIDE_LENGTH, 4000);
    assert.equal((await refusal(textOverrides.save("fr", HELLO, "a".repeat(4001)))).code, "too_long");
    await textOverrides.save("fr", HELLO, "b".repeat(4000));
    assert.equal(getLang(HELLO).length, 4000);
    assert.equal(await db.TextOverride.count(), 1);
  });

  test("the length counts characters, not UTF-16 units", async () => {
    await textOverrides.save("fr", HELLO, "😀".repeat(4000));
    assert.equal(Array.from(getLang(HELLO)).length, 4000);
    assert.equal((await refusal(textOverrides.save("fr", HELLO, "😀".repeat(4001)))).code, "too_long");
  });

  test("clear checks the language and the key too", async () => {
    assert.equal((await refusal(textOverrides.clear("de", HELLO))).code, "unsupported_lang");
    assert.equal((await refusal(textOverrides.clear("fr", "no.such.key"))).code, "unknown_key");
  });

  test("a failed database write leaves the memory as it was (the text is not in force yet)", async () => {
    const upsert = db.TextOverride.upsert;
    db.TextOverride.upsert = async () => {
      throw new Error("disk full");
    };
    try {
      await refusal(textOverrides.save("fr", HELLO, "jamais appliqué"));
    } finally {
      db.TextOverride.upsert = upsert;
    }
    assert.equal(getLang(HELLO), FR[HELLO]);
  });
});

describe("original changed (FR-060)", () => {
  test("flagged when the file text changes while the override stays in force; load keeps the flag", async () => {
    await textOverrides.save("fr", HELLO, "Ma version");
    assert.equal(textOverrides.describe(HELLO).originalChanged, false);
    assert.deepEqual(textOverrides.list({ q: HELLO }).filter((row) => row.originalChanged), []);

    const tree = languageManager.translations;
    const original = tree.common.error;
    try {
      tree.common.error = `${original} (réécrit)`; // the file is edited by an update
      const row = textOverrides.describe(HELLO);
      assert.equal(row.originalChanged, true);
      assert.deepEqual(row.changed, { en: false, fr: true });
      assert.equal(getLang(HELLO), "Ma version", "the override stays in force");
      assert.deepEqual(textOverrides.list({ q: HELLO }).filter((r) => r.originalChanged).map((r) => r.key), [HELLO]);

      // a restart reads the table: the stored fingerprint still tells
      await textOverrides.load({ models: db });
      assert.equal(textOverrides.describe(HELLO).originalChanged, true);
    } finally {
      tree.common.error = original;
    }
    assert.equal(textOverrides.describe(HELLO).originalChanged, false, "the file is back as it was");
  });

  test("saving again records the fingerprint of the file text of the day", async () => {
    await textOverrides.save("fr", HELLO, "Version 1");
    const tree = languageManager.translations;
    const original = tree.common.error;
    try {
      tree.common.error = `${original} (réécrit)`;
      assert.equal(textOverrides.describe(HELLO).originalChanged, true);
      await textOverrides.save("fr", HELLO, "Version 2");
      assert.equal(textOverrides.describe(HELLO).originalChanged, false);
    } finally {
      tree.common.error = original;
    }
  });
});

describe("clear reverts to the original", () => {
  test("the file text is back, the row is gone; clearing twice is a no-op", async () => {
    await textOverrides.save("fr", HELLO, "Temporaire");
    assert.deepEqual(await textOverrides.clear("fr", HELLO, { actor: "test" }), { lang: "fr", key: HELLO, removed: true });
    assert.equal(getLang(HELLO), FR[HELLO]);
    assert.equal(await db.TextOverride.count(), 0);
    assert.equal((await textOverrides.clear("fr", HELLO)).removed, false);
  });

  test("the other language is untouched", async () => {
    await textOverrides.save("fr", HELLO, "Français");
    await textOverrides.save("en", HELLO, "English");
    await textOverrides.clear("fr", HELLO);
    assert.equal(languageManager.getEffective("en", HELLO), "English");
    assert.equal(languageManager.getEffective("fr", HELLO), FR[HELLO]);
  });
});

describe("export and import (backup and restore)", () => {
  test("exportRows lists every override with its fingerprint; importRows restores them", async () => {
    await textOverrides.save("fr", HELLO, "Français");
    await textOverrides.save("en", HELLO, "English");
    await textOverrides.save("fr", PING, "Latence");
    const rows = await textOverrides.exportRows();
    assert.deepEqual(rows.map((r) => `${r.lang}:${r.key}`), [`en:${HELLO}`, `fr:${HELLO}`, `fr:${PING}`], "by language, then by key");
    for (const row of rows) assert.equal(row.originalHash.length, 16);

    await textOverrides.clear("fr", HELLO);
    await textOverrides.clear("en", HELLO);
    await textOverrides.clear("fr", PING);
    assert.equal(getLang(HELLO), FR[HELLO]);

    const result = await textOverrides.importRows(rows);
    assert.deepEqual(result, { imported: 3, skipped: 0 });
    assert.equal(getLang(HELLO), "Français");
    assert.equal(languageManager.getEffective("en", HELLO), "English");
    assert.equal(getLang(PING), "Latence");
    assert.deepEqual(await textOverrides.exportRows(), rows, "a round trip changes nothing");
    assert.equal(await db.TextOverride.count(), 3);
  });

  test("importRows replaces the whole set and skips the rows this installation cannot accept", async () => {
    await textOverrides.save("fr", HELLO, "A supprimer");
    const key = withTokens.find((candidate) => tokens(FR[candidate]).join() === "{0}");
    const result = await textOverrides.importRows([
      { key: PING, lang: "fr", text: "Gardé", originalHash: "0123456789abcdef" },
      { key, lang: "fr", text: "plus de variable" },
      { key: "no.such.key", lang: "fr", text: "x" },
      { key: HELLO, lang: "es", text: "x" },
      null,
    ]);
    assert.deepEqual(result, { imported: 1, skipped: 4 });
    assert.equal(getLang(HELLO), FR[HELLO], "the earlier override is gone");
    assert.equal(getLang(PING), "Gardé");
    assert.equal(await db.TextOverride.count(), 1);
    // the stored fingerprint of the backup is kept: that file text is not the one it was made from
    assert.equal(textOverrides.describe(PING).originalChanged, true);
  });
});

describe("survives a reload and a restart", () => {
  test("languageManager.reload() keeps the overrides", async () => {
    await textOverrides.save("fr", HELLO, "Persistant");
    languageManager.reload();
    assert.equal(getLang(HELLO), "Persistant");
  });

  test("a restart reads the table back (load), and a text removed from the table is gone", async () => {
    await textOverrides.save("fr", HELLO, "Persistant");
    await textOverrides.save("en", PING, "Persistent");
    languageManager.setOverrides("fr", new Map());
    languageManager.setOverrides("en", new Map()); // the process starts empty
    assert.equal(getLang(HELLO), FR[HELLO]);

    const result = await textOverrides.load({ models: db });
    assert.deepEqual(result, { rows: 2, applied: 2, skipped: 0 });
    assert.equal(getLang(HELLO), "Persistant");
    assert.equal(languageManager.getEffective("en", PING), "Persistent");

    await db.TextOverride.destroy({ where: { lang: "en" } });
    await textOverrides.load({ models: db });
    assert.equal(languageManager.getEffective("en", PING), EN[PING], "load replaces the map of each language");
  });

  test("a stored text that no longer fits the file is left out and logged by key and code, not applied", async () => {
    const key = withTokens.find((candidate) => tokens(FR[candidate]).join() === "{0}");
    await db.TextOverride.create({ key, lang: "fr", text: "sans variable", originalHash: "0123456789abcdef" });
    await db.TextOverride.create({ key: HELLO, lang: "fr", text: "Valide", originalHash: languageManager.originalHash("fr", HELLO) });
    const warned = [];
    const warn = languageManager.warn;
    languageManager.warn = (fields, message) => warned.push({ fields, message });
    try {
      const result = await textOverrides.load({ models: db });
      assert.deepEqual(result, { rows: 2, applied: 1, skipped: 1 });
    } finally {
      languageManager.warn = warn;
    }
    assert.equal(getLang(HELLO), "Valide");
    assert.deepEqual(warned.map((w) => w.fields), [{ lang: "fr", key, code: "placeholder_mismatch" }]);
    assert.ok(!JSON.stringify(warned).includes("sans variable"), "the text is not logged");
    assert.equal(await db.TextOverride.count(), 2, "the row stays in the table");
  });
});

describe("list and describe", () => {
  test("every key of lang/en.json, with its texts in both languages", () => {
    const rows = textOverrides.list();
    assert.equal(rows.length, Object.keys(EN).length);
    assert.ok(rows.length >= 1000, `${rows.length} keys`);
    assert.deepEqual(rows.map((r) => r.key), languageManager.listKeys());
    const row = rows.find((r) => r.key === PING);
    assert.equal(row.base.en, EN[PING]);
    assert.equal(row.base.fr, FR[PING]);
    assert.deepEqual([row.override.en, row.override.fr, row.originalChanged], [null, null, false]);
    assert.equal(row.group, "plugins.ping");
    assert.equal(textOverrides.describe("no.such.key"), null);
    assert.deepEqual(textOverrides.describe(PING), row);
  });

  test("placeholders are the {n} tokens of the English original", () => {
    const key = withTokens.find((candidate) => tokens(EN[candidate]).length >= 2);
    assert.deepEqual(textOverrides.describe(key).placeholders, tokens(EN[key]));
    assert.deepEqual(textOverrides.describe(PING).placeholders, []);
    assert.deepEqual(textOverrides.placeholdersOf("{1} et {0} et {10} et {2}"), ["{0}", "{1}", "{2}", "{10}"]);
  });

  test("q matches keys and texts in both languages, the original or the replacement, case-insensitively", async () => {
    assert.ok(textOverrides.list({ q: "PLUGINS.PING." }).every((r) => r.key.toLowerCase().includes("plugins.ping.")));
    const frWord = FR[PING].split(/\s+/).find((word) => word.length > 5);
    assert.ok(textOverrides.list({ q: frWord }).some((r) => r.key === PING));
    await textOverrides.save("fr", PING, "Mot-introuvable-xyz");
    assert.deepEqual(textOverrides.list({ q: "introuvable-XYZ" }).map((r) => r.key), [PING], "the replacement text is searched too");
    assert.deepEqual(textOverrides.list({ q: "zzz-matches-nothing" }), []);
  });

  test("command maps a command name or alias to its keys through the plugin segment, description key or file name", async () => {
    const { registry } = await fakes.loadAllPlugins();
    const rows = textOverrides.list({ command: "ping", registry });
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((r) => r.key.startsWith("plugins.ping.") && r.command === "ping"));
    assert.deepEqual(textOverrides.list({ command: "ping" }).map((r) => r.key), rows.map((r) => r.key), "the real registry is the default");
    // the file is antidel.js but its texts are plugins.antidelete.*: the description key leads to them
    const anti = textOverrides.list({ command: "antidel" });
    assert.ok(anti.length > 3 && anti.every((r) => r.key.startsWith("plugins.antidelete.")), anti.map((r) => r.key).join());
    assert.deepEqual(textOverrides.list({ command: "no-such-command" }), []);
    assert.equal(textOverrides.describe(PING).command, "ping");
  });
});
