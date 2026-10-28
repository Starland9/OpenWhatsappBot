"use strict";
/**
 * TXT-1 to TXT-3 of the admin panel (T194, SC-014, FR-057 to FR-060; admin-http-api.md 2.15), through the real
 * createAdmin, the real text overrides and an in-memory database.
 *
 *  - TXT-1: the filters (q across keys and both languages, command through plugin segment / description key / file
 *    name, overridden, changed) and the coverage of every key of lang/en.json; pagination;
 *  - TXT-2: 422 placeholder_mismatch with params.expected, required / too_long, 404 for an unknown key or language,
 *    the audit row text.update with { length } only; the change is live at the next message;
 *  - TXT-3: back to the original, audit text.reset.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ lang: "fr" });

const { createTestAdmin } = require("./helpers/adminHarness");
const { getLang, languageManager } = require("../lib/utils/language");
const textOverrides = require("../lib/utils/textOverrides");

const PING = "plugins.ping.desc";
const HELLO = "common.error";

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

let db;
let t;
let client;

before(async () => {
  db = await fakes.syncDb();
});

beforeEach(async () => {
  await db.TextOverride.destroy({ where: {} });
  languageManager.reload();
  await textOverrides.load({ models: db });
  await fakes.loadAllPlugins(); // the registry the command filter reads
  t = await createTestAdmin();
  await t.admin.start();
  client = await t.loginClient();
});

afterEach(async () => {
  await t.close();
  languageManager.reload();
});

const list = async (query = "") => (await client.get(`/admin/api/texts${query}`)).json;
const put = (lang, key, text) => client.api("PUT", `/admin/api/texts/${lang}/${encodeURIComponent(key)}`, { text });
const del = (lang, key) => client.api("DELETE", `/admin/api/texts/${lang}/${encodeURIComponent(key)}`);
const auditRows = (where = {}) => t.db.AuditLog.findAll({ where, raw: true, order: [["id", "ASC"]] });

describe("TXT-1: GET /admin/api/texts", () => {
  test("is a session route", async () => {
    const answer = await t.client().get("/admin/api/texts");
    assert.equal(answer.status, 401);
  });

  test("covers every key of lang/en.json (about a thousand), in pages", async () => {
    const first = await list("?pageSize=200");
    assert.equal(first.total, Object.keys(EN).length);
    assert.ok(first.total >= 1000, `${first.total} keys`);
    assert.deepEqual([first.page, first.pageSize, first.items.length], [1, 200, 200]);
    const seen = [];
    for (let page = 1; page <= Math.ceil(first.total / 200); page += 1) {
      seen.push(...(await list(`?pageSize=200&page=${page}`)).items.map((item) => item.key));
    }
    assert.equal(new Set(seen).size, first.total, "no key twice, none missing");
    assert.deepEqual(seen, languageManager.listKeys());
  });

  test("the default page is 50 items; a page size over 200 is capped", async () => {
    const answer = await list();
    assert.deepEqual([answer.page, answer.pageSize, answer.items.length], [1, 50, 50]);
    assert.equal((await list("?pageSize=999")).pageSize, 200);
    assert.equal((await list("?page=2")).page, 2);
  });

  test("an item: key, group, command, placeholders and the texts of both languages", async () => {
    const { items } = await list(`?q=${encodeURIComponent(PING)}`);
    const item = items.find((candidate) => candidate.key === PING);
    assert.deepEqual(item, {
      key: PING,
      group: "plugins.ping",
      command: "ping",
      placeholders: [],
      texts: {
        en: { original: EN[PING], effective: EN[PING], overridden: false, originalChanged: false },
        fr: { original: FR[PING], effective: FR[PING], overridden: false, originalChanged: false },
      },
    });
    const withToken = (await list(`?q=${encodeURIComponent("plugins.antidelete.updated")}`)).items[0];
    assert.deepEqual(withToken.placeholders, tokens(EN[withToken.key]));
  });

  test("menu and command descriptions are among the texts", async () => {
    const { items } = await list("?q=plugins.menu.desc");
    assert.ok(items.some((item) => item.key === "plugins.menu.desc"));
    assert.ok(items.some((item) => item.key === "plugins.menu.desc" && item.command === "menu"));
  });

  test("q searches the keys and the texts in both languages, the replacement included", async () => {
    assert.ok((await list("?q=plugins.ping.")).items.every((item) => item.key.includes("plugins.ping.")));
    const frWord = FR[PING].split(/\s+/).find((word) => word.length > 5);
    assert.ok((await list(`?q=${encodeURIComponent(frWord.toUpperCase())}`)).items.some((item) => item.key === PING), "French text, other case");
    const enWord = EN[PING].split(/\s+/).find((word) => word.length > 5);
    assert.ok((await list(`?q=${encodeURIComponent(enWord)}`)).items.some((item) => item.key === PING), "English text");
    await put("fr", PING, "Mot-introuvable-xyz");
    assert.deepEqual((await list("?q=introuvable-xyz")).items.map((item) => item.key), [PING]);
    assert.equal((await list("?q=zzz-matches-nothing")).total, 0);
  });

  test("q is capped at 100 characters", async () => {
    const answer = await client.get(`/admin/api/texts?q=${"a".repeat(101)}`);
    assert.equal(answer.status, 422);
    assert.equal(answer.json.error.fields.q.code, "too_long");
  });

  test("command: through the plugin segment, the description key or the file name", async () => {
    const ping = await list("?command=ping&pageSize=200");
    assert.ok(ping.total >= 1 && ping.items.every((item) => item.key.startsWith("plugins.ping.") && item.command === "ping"));
    // antidel.js: the texts are plugins.antidelete.*, reached through the description key
    const anti = await list("?command=antidel&pageSize=200");
    assert.ok(anti.total > 3 && anti.items.every((item) => item.key.startsWith("plugins.antidelete.")));
    // an alias of the same command gives the same keys
    assert.equal((await list("?command=antidelete&pageSize=200")).total, anti.total);
    assert.equal((await list("?command=no-such-command")).total, 0);
    // combined with q
    const both = await list("?command=ping&q=desc");
    assert.deepEqual(both.items.map((item) => item.key), [PING]);
  });

  test("overridden=1 lists the edited texts, changed=1 those whose original changed since", async () => {
    await put("fr", PING, "Latence");
    await put("en", HELLO, "English error");
    assert.deepEqual((await list("?overridden=1")).items.map((item) => item.key).sort(), [HELLO, PING]);
    assert.equal((await list("?overridden=1")).total, 2);
    assert.equal((await list("?changed=1")).total, 0);

    const tree = languageManager.translations;
    const original = tree.plugins.ping.desc;
    try {
      tree.plugins.ping.desc = `${original} (réécrit)`;
      const changed = await list("?changed=1");
      assert.deepEqual(changed.items.map((item) => item.key), [PING]);
      assert.equal(changed.items[0].texts.fr.originalChanged, true);
      assert.equal(changed.items[0].texts.fr.effective, "Latence", "the replacement stays in force");
      assert.equal(changed.items[0].texts.fr.original, `${original} (réécrit)`, "the new original is shown next to it");
      assert.equal(changed.items[0].texts.en.originalChanged, false);
    } finally {
      tree.plugins.ping.desc = original;
    }
    assert.equal((await list("?changed=1")).total, 0);
    assert.equal((await list("?overridden=0")).total, Object.keys(EN).length, "a 0 flag filters nothing");
  });

  test("a flag other than 0 or 1, a page that is not a number, an unknown parameter: 422", async () => {
    assert.equal((await client.get("/admin/api/texts?overridden=yes")).status, 422);
    assert.equal((await client.get("/admin/api/texts?page=abc")).status, 422);
    assert.equal((await client.get("/admin/api/texts?bogus=1")).status, 422);
  });
});

describe("TXT-2: PUT /admin/api/texts/:lang/:key", () => {
  test("saves the text and answers { item }; it is what the bot says at the very next message", async () => {
    assert.equal(getLang(HELLO), FR[HELLO]);
    const answer = await put("fr", HELLO, "Oups !");
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    assert.deepEqual(Object.keys(answer.json), ["item"]);
    assert.deepEqual(answer.json.item.texts.fr, { original: FR[HELLO], effective: "Oups !", overridden: true, originalChanged: false });
    assert.equal(answer.json.item.texts.en.overridden, false);
    assert.equal(getLang(HELLO), "Oups !", "the in-memory map is replaced before the answer");
    const row = await db.TextOverride.findOne({ where: { key: HELLO, lang: "fr" }, raw: true });
    assert.equal(row.text, "Oups !");
  });

  test("a version without the {n} of the original is refused: 422 placeholder_mismatch with the expected tokens", async () => {
    const key = Object.keys(EN).find((candidate) => tokens(FR[candidate] || "").join() === "{0},{1}");
    const answer = await put("fr", key, "sans variable");
    assert.equal(answer.status, 422);
    assert.equal(answer.json.error.code, "validation_failed");
    assert.deepEqual(answer.json.error.fields.text, { code: "placeholder_mismatch", params: { expected: ["{0}", "{1}"] } });
    assert.ok(!answer.text.includes("sans variable"), "the submitted text is not echoed");
    assert.equal(await db.TextOverride.count(), 0);
    assert.equal((await auditRows({ action: "text.update" })).length, 0, "a refused request is not audited");

    const extra = await put("fr", key, "{0} {1} {2}");
    assert.deepEqual(extra.json.error.fields.text.params.expected, ["{0}", "{1}"]);
    const reordered = await put("fr", key, "{1} avant {0}");
    assert.equal(reordered.status, 200);
  });

  test("a blank text is required, over 4000 characters is too_long", async () => {
    let answer = await put("fr", HELLO, "   ");
    assert.deepEqual([answer.status, answer.json.error.fields.text], [422, { code: "required" }]);
    answer = await client.api("PUT", `/admin/api/texts/fr/${HELLO}`, { text: "" });
    assert.equal(answer.json.error.fields.text.code, "required");
    answer = await put("fr", HELLO, "x".repeat(4001));
    assert.deepEqual(answer.json.error.fields.text, { code: "too_long", params: { max: 4000 } });
    assert.equal((await put("fr", HELLO, "x".repeat(4000))).status, 200);
  });

  test("the body is strict: text is required, text must be a string, no other property", async () => {
    let answer = await client.api("PUT", `/admin/api/texts/fr/${HELLO}`, {});
    assert.equal(answer.json.error.fields.text.code, "required");
    answer = await client.api("PUT", `/admin/api/texts/fr/${HELLO}`, { text: 3 });
    assert.equal(answer.json.error.fields.text.code, "invalid_type");
    answer = await client.api("PUT", `/admin/api/texts/fr/${HELLO}`, { text: "ok", lang: "en" });
    assert.equal(answer.json.error.fields.$unknown.code, "unknown_field");
    assert.equal(await db.TextOverride.count(), 0);
  });

  test("an unknown key is 404 not_found; so is a language other than en or fr", async () => {
    let answer = await put("fr", "no.such.key", "x");
    assert.equal(answer.status, 404);
    assert.deepEqual(answer.json.error, { code: "not_found", params: { resource: "text" }, requestId: answer.json.error.requestId });
    answer = await put("es", HELLO, "x");
    assert.equal(answer.status, 404, "other locales fall back to English: nothing to edit");
    answer = await put("fr", "bad key with spaces", "x");
    assert.equal(answer.status, 404);
    assert.equal(await db.TextOverride.count(), 0);
  });

  test("the audit row text.update has the language and key as target and { length } only", async () => {
    await put("fr", HELLO, "Un texte secret de 25 car.");
    const rows = await auditRows({ action: "text.update" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target, `fr:${HELLO}`);
    assert.deepEqual(JSON.parse(rows[0].detail), { length: "Un texte secret de 25 car.".length });
    assert.ok(!JSON.stringify(rows).includes("secret"), "the text itself is never written to the history");
    assert.equal(rows[0].result, "ok");
  });

  test("requires a CSRF token", async () => {
    const forged = await client.api("PUT", `/admin/api/texts/fr/${HELLO}`, { text: "x" }, { headers: { "X-CSRF-Token": "wrong" } });
    assert.equal(forged.status, 403);
    assert.equal(getLang(HELLO), FR[HELLO]);
  });

  test("a description follows at once (lazy desc): the menu and the help read the new text", async () => {
    const registry = require("../lib/plugins/registry");
    const entry = registry.getCommandByPattern("ping");
    await put("fr", PING, "Teste la latence");
    assert.equal(entry.desc, "Teste la latence");
    assert.equal((await list(`?q=${encodeURIComponent(PING)}`)).items.find((item) => item.key === PING).texts.fr.effective, "Teste la latence");
  });
});

describe("TXT-3: DELETE /admin/api/texts/:lang/:key", () => {
  test("reverts to the original: the file text is back at the next message", async () => {
    await put("fr", HELLO, "Temporaire");
    const answer = await del("fr", HELLO);
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    assert.deepEqual(answer.json.item.texts.fr, { original: FR[HELLO], effective: FR[HELLO], overridden: false, originalChanged: false });
    assert.equal(getLang(HELLO), FR[HELLO]);
    assert.equal(await db.TextOverride.count(), 0);
  });

  test("audit text.reset when something was reverted; nothing when there was no override", async () => {
    await put("fr", HELLO, "Temporaire");
    await del("fr", HELLO);
    await del("fr", HELLO);
    const rows = await auditRows({ action: "text.reset" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target, `fr:${HELLO}`);
  });

  test("a revert is idempotent: 200 with the item; an unknown key is 404", async () => {
    assert.equal((await del("fr", HELLO)).status, 200);
    assert.equal((await del("fr", "no.such.key")).status, 404);
    assert.equal((await del("de", HELLO)).status, 404);
  });

  test("only the language asked for is reverted", async () => {
    await put("fr", HELLO, "Français");
    await put("en", HELLO, "English");
    const answer = await del("fr", HELLO);
    assert.equal(answer.json.item.texts.en.overridden, true);
    assert.equal(answer.json.item.texts.fr.overridden, false);
  });

  test("requires a CSRF token", async () => {
    await put("fr", HELLO, "Gardé");
    const forged = await client.api("DELETE", `/admin/api/texts/fr/${HELLO}`, undefined, { headers: { "X-CSRF-Token": "wrong" } });
    assert.equal(forged.status, 403);
    assert.equal(getLang(HELLO), "Gardé");
  });
});
