"use strict";
/**
 * The bot-texts view (T198, FR-057 to FR-060; views/texts-logic.mjs, views/texts.mjs, panel-texts.json).
 *
 *  - the placeholder token extraction mirrors the server's regex and order (compared on every text of both language
 *    files), and the check an edited text must pass gives the verdict of languageManager.validateOverride;
 *  - change detection: dirty drafts, edited / original-changed statuses;
 *  - the TXT-1 query, reading a rejected save, the panel-texts.json fragment;
 *  - the view rendered in a fake DOM with a scripted server: search, filters, the editor with its expected tokens,
 *    save, revert, the "original changed" flag.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const fakes = require("./helpers/fakes");

fakes.setupEnv({ lang: "fr" });

const { languageManager, TextOverrideError } = require("../lib/utils/language");
const textOverrides = require("../lib/utils/textOverrides");
const { createTextsService } = require("../lib/admin/services/texts");
const { createDom, importPublic } = require("./helpers/fakeDom");

const ROOT = path.resolve(__dirname, "..");
const load = (relative) => import(pathToFileURL(path.join(ROOT, "lib", "admin", "public", "js", relative)).href);

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
const PING = "plugins.ping.desc";

let logic;
let texts; // the service, to build the items the API sends

/** A TXT-1 item exactly as the service builds it */
const itemOf = (key) => texts.itemFor(key);

before(async () => {
  logic = await load("views/texts-logic.mjs");
  await fakes.syncDb();
  await fakes.loadAllPlugins(); // the registry the "command" of an item comes from
  texts = createTextsService({});
});

describe("placeholders mirror the server", () => {
  test("extractPlaceholders gives the same tokens in the same order as the server on every text of both languages", () => {
    let checked = 0;
    for (const source of [EN, FR]) {
      for (const text of Object.values(source)) {
        assert.deepEqual(logic.extractPlaceholders(text), textOverrides.placeholdersOf(text), text);
        checked += 1;
      }
    }
    assert.ok(checked > 2000);
    for (const text of ["{1} {0} {10} {2}", "{0}{0}{0}", "a {x} {-1} { 0 } {01} {}", "", null, undefined, "{9999999999}"]) {
      assert.deepEqual(logic.extractPlaceholders(text), textOverrides.placeholdersOf(text), String(text));
    }
    assert.deepEqual(logic.extractPlaceholders("{1} et {0} et {10} et {2}"), ["{0}", "{1}", "{2}", "{10}"]);
  });

  test("comparePlaceholders compares multisets: what is missing and what is too many", () => {
    assert.deepEqual(logic.comparePlaceholders(["{0}", "{1}"], ["{1}", "{0}"]), { ok: true, missing: [], extra: [] });
    assert.deepEqual(logic.comparePlaceholders(["{0}", "{1}"], ["{0}"]), { ok: false, missing: ["{1}"], extra: [] });
    assert.deepEqual(logic.comparePlaceholders(["{0}"], ["{0}", "{0}", "{3}"]), { ok: false, missing: [], extra: ["{0}", "{3}"] });
    assert.deepEqual(logic.comparePlaceholders([], []), { ok: true, missing: [], extra: [] });
  });

  test("expectedTokens: those of the original of the language, else of the English one", () => {
    const key = Object.keys(EN).find((candidate) => (FR[candidate] || "").match(/\{\d+\}/g)?.join() === "{0}");
    assert.deepEqual(logic.expectedTokens(itemOf(key), "fr"), ["{0}"]);
    const noFrench = { key: "x", texts: { en: { original: "a {0} b {1}" }, fr: { original: null } } };
    assert.deepEqual(logic.expectedTokens(noFrench, "fr"), ["{0}", "{1}"]);
    assert.deepEqual(logic.expectedTokens(null, "fr"), []);
  });
});

describe("the check an edited text must pass", () => {
  test("required, too_long, placeholder_mismatch with the expected tokens, else null", () => {
    const key = Object.keys(EN).find((candidate) => FR[candidate] && FR[candidate].match(/\{\d+\}/g)?.length === 2);
    const item = itemOf(key);
    const expected = FR[key].match(/\{\d+\}/g).sort();
    assert.deepEqual(logic.validateDraft(item, "fr", ""), { code: "required" });
    assert.deepEqual(logic.validateDraft(item, "fr", "  \n "), { code: "required" });
    assert.deepEqual(logic.validateDraft(item, "fr", "x".repeat(4001)), { code: "too_long", params: { max: 4000 } });
    assert.deepEqual(logic.validateDraft(item, "fr", "sans variable"), { code: "placeholder_mismatch", params: { expected } });
    assert.deepEqual(logic.validateDraft(item, "fr", `${expected.join(" ")} {7}`), { code: "placeholder_mismatch", params: { expected } });
    assert.equal(logic.validateDraft(item, "fr", [...expected].reverse().join(" puis ")), null, "a reordering is fine");
    assert.equal(logic.validateDraft(itemOf(PING), "fr", "Nouvelle description"), null);
  });

  test("the verdict is the server's: same acceptance, same code (required <-> empty)", () => {
    const keys = Object.keys(EN).filter((key) => FR[key] !== undefined);
    let compared = 0;
    for (const key of keys.filter((_, index) => index % 7 === 0)) {
      const item = itemOf(key);
      const original = FR[key];
      const drafts = [original, "", " ", original.replace(/\{\d+\}/, ""), `${original} {5}`, "x".repeat(4001), "😀".repeat(4000), "😀".repeat(4001)];
      for (const draft of drafts) {
        let server = null;
        try {
          languageManager.validateOverride("fr", key, draft);
        } catch (error) {
          if (!(error instanceof TextOverrideError)) throw error;
          server = error.code === "empty" ? "required" : error.code;
        }
        const client = logic.validateDraft(item, "fr", draft);
        assert.equal(client ? client.code : null, server, `${key}: ${JSON.stringify(draft).slice(0, 40)}`);
        compared += 1;
      }
    }
    assert.ok(compared > 800, `${compared} comparisons`);
  });

  test("the length counts characters, as the server does", () => {
    const item = itemOf(PING);
    assert.equal(logic.validateDraft(item, "fr", "😀".repeat(4000)), null);
    assert.equal(logic.validateDraft(item, "fr", "😀".repeat(4001)).code, "too_long");
  });
});

describe("change detection", () => {
  const edited = (over = {}) => ({
    key: "k",
    texts: {
      en: { original: "Hello", effective: "Hello", overridden: false, originalChanged: false },
      fr: { original: "Bonjour", effective: "Salut", overridden: true, originalChanged: false },
      ...over,
    },
  });

  test("effectiveText is the replacement in force; isDirty compares the editor with it", () => {
    const item = edited();
    assert.equal(logic.effectiveText(item, "fr"), "Salut");
    assert.equal(logic.effectiveText(item, "en"), "Hello");
    assert.equal(logic.effectiveText({ texts: {} }, "fr"), "");
    assert.equal(logic.isDirty(item, "fr", "Salut"), false);
    assert.equal(logic.isDirty(item, "fr", "Salut !"), true);
    assert.equal(logic.isDirty(item, "fr", undefined), true);
    assert.deepEqual(logic.initialDrafts(item), { en: "Hello", fr: "Salut" });
  });

  test("statusOf: original, edited, or stale when the original changed after the edit", () => {
    assert.equal(logic.statusOf(edited(), "en"), "original");
    assert.equal(logic.statusOf(edited(), "fr"), "edited");
    const stale = edited({ fr: { original: "Bonjour !", effective: "Salut", overridden: true, originalChanged: true } });
    assert.equal(logic.statusOf(stale, "fr"), "stale");
    assert.equal(logic.isOverridden(edited()), true);
    assert.equal(logic.isStale(edited()), false);
    assert.equal(logic.isStale(stale), true);
    assert.equal(logic.isOverridden({ texts: { en: { overridden: false }, fr: { overridden: false } } }), false);
  });

  test("replaceItem swaps the item with the same key and keeps the order", () => {
    const items = [{ key: "a", v: 1 }, { key: "b", v: 1 }];
    assert.deepEqual(logic.replaceItem(items, { key: "b", v: 2 }), [{ key: "a", v: 1 }, { key: "b", v: 2 }]);
    assert.deepEqual(logic.replaceItem(items, { key: "z", v: 2 }), items);
  });
});

describe("the TXT-1 query and the answers", () => {
  test("empty filters are left out, flags are sent as 1, the first page and the default size are implicit", () => {
    assert.deepEqual(logic.listQuery({}), {});
    assert.deepEqual(logic.listQuery({ q: "  hello ", command: ".Ping", overridden: true, changed: true }, 3, 100), {
      q: "hello",
      command: "ping",
      overridden: 1,
      changed: 1,
      page: 3,
      pageSize: 100,
    });
    assert.deepEqual(logic.listQuery({ q: "a".repeat(300) }).q.length, 100);
    assert.deepEqual(logic.listQuery({ overridden: false, changed: false }, 1, 50), {});
  });

  test("normalizeCommand: trimmed, lower-case, the prefix typed by habit removed", () => {
    assert.equal(logic.normalizeCommand("  .Menu "), "menu");
    assert.equal(logic.normalizeCommand("!!ping"), "ping");
    assert.equal(logic.normalizeCommand(null), "");
  });

  test("textFieldError reads the field error of a rejected save", () => {
    const rejected = { fields: { text: { code: "placeholder_mismatch", params: { expected: ["{0}"] } } } };
    assert.deepEqual(logic.textFieldError(rejected), { code: "placeholder_mismatch", params: { expected: ["{0}"] } });
    assert.deepEqual(logic.textFieldError({ fields: { text: { code: "required" } } }), { code: "required" });
    assert.equal(logic.textFieldError({ fields: {} }), null);
    assert.equal(logic.textFieldError(null), null);
    assert.equal(logic.formatTokens(["{0}", "{1}"]), "{0}, {1}");
  });
});

describe("panel-texts.json", () => {
  const fragment = JSON.parse(fs.readFileSync(path.join(ROOT, "specs", "002-admin-panel", "i18n", "panel-texts.json"), "utf8"));

  test("the same keys in English and French, the same {placeholders}, every text filled", () => {
    assert.deepEqual(Object.keys(fragment.en), Object.keys(fragment.fr));
    const names = (text) => (text.match(/\{[A-Za-z0-9_]+\}/g) || []).sort().join(",");
    for (const key of Object.keys(fragment.en)) {
      assert.ok(fragment.en[key].trim() && fragment.fr[key].trim(), key);
      assert.equal(names(fragment.en[key]), names(fragment.fr[key]), key);
    }
    assert.ok(Object.keys(fragment.en).every((key) => key.startsWith("texts.")));
  });

  test("the keys the view builds from a language exist, and so do the ones it passes parameters to", () => {
    for (const lang of logic.LANGS) assert.ok(fragment.en[`texts.lang.${lang}`], lang);
    const needs = { "texts.chars": "{count}", "texts.count": "{count}", "texts.expected_tokens": "{tokens}", "texts.command_badge": "{command}", "texts.revert_message": "{language}" };
    for (const [key, token] of Object.entries(needs)) {
      for (const lang of ["en", "fr"]) assert.ok(fragment[lang][key].includes(token), `${lang}:${key}`);
    }
  });
});

// ---------------------------------------------------------------------------
// The view in a fake DOM
// ---------------------------------------------------------------------------

describe("the view renders and works", () => {
  let dom;
  let ui;
  let htmlTag;
  let view;
  let requests;
  let routes;

  const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const page = (items, extra = {}) => ({ items, page: 1, pageSize: 50, total: items.length, ...extra });
  const keyWithTokens = Object.keys(EN).find((key) => FR[key] && FR[key].match(/\{\d+\}/g)?.length === 2);

  before(async () => {
    dom = await createDom();
    const i18n = await importPublic("js/i18n.mjs");
    for (const lang of ["en", "fr"]) {
      i18n.setCatalog(lang, {
        ...readJson(path.join(ROOT, "lib", "admin", "public", "i18n", `${lang}.json`)),
        ...readJson(path.join(ROOT, "specs", "002-admin-panel", "i18n", "panel-texts.json"))[lang],
      });
    }
    await i18n.setLanguage("en", { remember: false });
    ui = await importPublic("js/ui.mjs");
    htmlTag = (await importPublic("js/components/html.mjs")).html;
    view = await importPublic("js/views/texts.mjs");
  });

  after(() => {
    dom.restore();
    delete globalThis.fetch;
  });

  async function open(script = {}, items = [itemOf(PING), itemOf(keyWithTokens)]) {
    requests = [];
    routes = { "GET /admin/api/texts": () => answer(200, page(items)), ...script };
    globalThis.fetch = async (url, init) => {
      const [path_, search] = url.split("?");
      const key = `${init.method} ${path_}`;
      requests.push({ key, search: search || "", body: init.body ? JSON.parse(init.body) : undefined });
      if (!routes[key]) throw new Error(`unexpected request ${key}`);
      return routes[key](init.body ? JSON.parse(init.body) : undefined, search || "");
    };
    const root = dom.mount(htmlTag`<${view.default} route=${{ rest: [] }} />`);
    await dom.settle(10);
    return root;
  }

  const button = (root, text) => dom.byText(root, text, "button")[0];
  const field = (root, name) => dom.byAttr(root, "name", name)[0];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  test("lists the texts with both languages, the command and the expected variables", async () => {
    const root = await open();
    const text = dom.text(root);
    assert.ok(text.includes("Bot texts"));
    assert.ok(text.includes(PING) && text.includes(keyWithTokens));
    assert.ok(text.includes("Texts found: 2"));
    assert.ok(text.includes("Command ping"), "the command the key belongs to");
    assert.ok(text.includes(EN[PING]) && text.includes(FR[PING]), "original texts in both languages");
    assert.ok(text.includes("Variables to keep:"), "the tokens of a text that has some");
    assert.equal(dom.find(root, (el) => el.localName === "textarea").length, 0, "the editors are closed");
    dom.unmount(root);
  });

  test("the search follows the typing after a pause: one request with q, command and the flags", async () => {
    const root = await open();
    const before = requests.length;
    dom.type(field(root, "q"), "latence");
    dom.type(field(root, "command"), ".Ping");
    dom.check(dom.find(root, (el) => el.localName === "input" && el.getAttribute("name") === "overridden")[0], true);
    await dom.settle();
    assert.equal(requests.length, before, "nothing is sent while typing");
    await sleep(380);
    await dom.settle(10);
    const sent = requests.slice(before).filter((r) => r.key === "GET /admin/api/texts");
    assert.equal(sent.length, 1);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(sent[0].search)), { q: "latence", command: "ping", overridden: "1" });
    dom.unmount(root);
  });

  test("an empty answer says so", async () => {
    const root = await open({}, []);
    assert.ok(dom.text(root).includes("No text matches."));
    dom.unmount(root);
  });

  test("the editor shows the expected variables and refuses a text that drops one before sending", async () => {
    const item = itemOf(keyWithTokens);
    const expected = item.placeholders.join(", ");
    const root = await open({}, [item]);
    dom.click(button(root, "Edit"));
    await dom.settle();
    assert.equal(dom.find(root, (el) => el.localName === "textarea").length, 2, "one editor per language");
    assert.ok(dom.text(root).includes(`Variables to keep: ${expected}`));

    const french = field(root, `${keyWithTokens}-fr`);
    assert.equal(french.value, FR[keyWithTokens]);
    dom.type(french, "sans aucune variable");
    await dom.settle();
    assert.ok(dom.text(root).includes("The variables must stay:"), dom.text(root));
    // every Save is disabled: French is invalid, English is unchanged
    const buttons = dom.byText(root, "Save", "button");
    assert.equal(buttons.length, 2);
    assert.ok(buttons.every((b) => b.prop("disabled") === true), "a text that would be refused cannot be saved");
    assert.equal(requests.some((r) => r.key.startsWith("PUT")), false);
    dom.unmount(root);
  });

  test("saving sends the text, replaces the item with the answer and shows it as edited", async () => {
    const item = itemOf(keyWithTokens);
    const tokens = FR[keyWithTokens].match(/\{\d+\}/g);
    const replacement = `Nouveau ${tokens.join(" et ")}`;
    const saved = {
      ...item,
      texts: { ...item.texts, fr: { original: FR[keyWithTokens], effective: replacement, overridden: true, originalChanged: false } },
    };
    const root = await open({ [`PUT /admin/api/texts/fr/${keyWithTokens}`]: () => answer(200, { item: saved }) }, [item]);
    dom.click(button(root, "Edit"));
    await dom.settle();
    dom.type(field(root, `${keyWithTokens}-fr`), replacement);
    await dom.settle();
    const french = dom.byText(root, "Save", "button").filter((b) => b.prop("disabled") !== true);
    assert.equal(french.length, 1, "only the edited language can be saved");
    dom.click(french[0]);
    await dom.settle(12);
    const put = requests.find((r) => r.key === `PUT /admin/api/texts/fr/${keyWithTokens}`);
    assert.deepEqual(put.body, { text: replacement });
    assert.ok(dom.text(root).includes("Edited"), "the card carries the badge");
    assert.ok(dom.text(root).includes("Original text:"), "the original stays visible next to the replacement");
    assert.ok(button(root, "Back to the original"));
    dom.unmount(root);
  });

  test("a rejection by the server is shown on the field", async () => {
    const item = itemOf(PING);
    const root = await open(
      { [`PUT /admin/api/texts/fr/${PING}`]: () => answer(422, { error: { code: "validation_failed", fields: { text: { code: "too_long", params: { max: 4000 } } } } }) },
      [item],
    );
    dom.click(button(root, "Edit"));
    await dom.settle();
    dom.type(field(root, `${PING}-fr`), "Une autre description");
    await dom.settle();
    dom.click(dom.byText(root, "Save", "button").filter((b) => b.prop("disabled") !== true)[0]);
    await dom.settle(12);
    assert.ok(dom.text(root).includes("Too long (at most 4000 characters)."), dom.text(root));
    dom.unmount(root);
  });

  test("reverting asks first, then deletes the replacement and shows the original again", async () => {
    const item = itemOf(PING);
    const edited = { ...item, texts: { ...item.texts, fr: { original: FR[PING], effective: "Remplacé", overridden: true, originalChanged: false } } };
    const root = await open({ [`DELETE /admin/api/texts/fr/${PING}`]: () => answer(200, { item }) }, [edited]);
    dom.click(button(root, "Edit"));
    await dom.settle();
    dom.click(button(root, "Back to the original"));
    await dom.settle();
    assert.equal(requests.some((r) => r.key.startsWith("DELETE")), false, "not before the confirmation");
    assert.equal(ui.confirmStore.get().request.title, "Restore the original text?");
    ui.resolveConfirm(true);
    await dom.settle(12);
    assert.ok(requests.some((r) => r.key === `DELETE /admin/api/texts/fr/${PING}`));
    assert.ok(!dom.text(root).includes("Remplacé"));
    assert.equal(button(root, "Back to the original"), undefined);
    dom.unmount(root);
  });

  test("a replacement made stale by a change of the original is flagged, with a note", async () => {
    const item = itemOf(PING);
    const stale = { ...item, texts: { ...item.texts, fr: { original: `${FR[PING]} (réécrit)`, effective: "Ma version", overridden: true, originalChanged: true } } };
    const root = await open({}, [stale]);
    const text = dom.text(root);
    assert.ok(text.includes("Original changed"));
    assert.ok(text.includes("The original text changed after your edit."));
    assert.ok(text.includes("Ma version") && text.includes(`${FR[PING]} (réécrit)`), "the replacement and the new original, side by side");
    dom.unmount(root);
  });

  test("a failed load offers a retry", async () => {
    const root = await open({ "GET /admin/api/texts": () => answer(500, { error: { code: "internal_error" } }) });
    assert.ok(dom.text(root).includes("This page could not be displayed"));
    routes["GET /admin/api/texts"] = () => answer(200, page([itemOf(PING)]));
    dom.click(button(root, "Try again"));
    await dom.settle(12);
    assert.ok(dom.text(root).includes(PING));
    dom.unmount(root);
  });
});
