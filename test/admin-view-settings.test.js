"use strict";
/**
 * The settings view (T113, T114, FR-014 to FR-022; views/settings-logic.mjs, views/settings.mjs).
 *
 * The pure logic is tested on the real ResolvedSetting list of the real catalog (built by the settings service on an
 * in-memory database), so the fixtures cannot drift from the API:
 *  - grouping by theme, with the flagged entries in one folded group;
 *  - the diff of the changed fields into a SET-2 payload with the version of each setting (secrets only when typed,
 *    lists cleaned, a JID only while its mode is `jid`);
 *  - client-side pre-validation from `rules`, compared with the server's own verdict;
 *  - reading the API errors; merging an answer; rebasing the form on a fresher list;
 *  - the panel-settings.json fragment: a label and a description for all 101 entries, in both languages;
 *  - a payload built by the view logic is accepted by the real SET-2 route.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const fakes = require("./helpers/fakes");

fakes.setupEnv();

const catalog = require("../lib/utils/settingsCatalog");
const settingsStore = require("../lib/utils/settingsStore");
const secretBox = require("../lib/utils/secretBox");
const { createSettingsService } = require("../lib/admin/services/settings");
const { createTestAdmin } = require("./helpers/adminHarness");

const ROOT = path.resolve(__dirname, "..");
const load = (relative) => import(pathToFileURL(path.join(ROOT, "lib", "admin", "public", "js", relative)).href);

let logic;
let api;
let settings; // the real list, as SET-1 sends it
let db;
let tmp;

const find = (key) => settings.find((s) => s.key === key);

before(async () => {
  logic = await load("views/settings-logic.mjs");
  api = await load("api.mjs");
  db = await fakes.syncDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-view-settings-"));
  secretBox.configure({ dir: path.join(tmp, "data") });
  await settingsStore.load({ models: db });
  const service = createSettingsService({ models: db, statusListStore: { FILE_PATH: path.join(tmp, "absent.json") } });
  settings = (await service.list()).settings;
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A form where `edits` replaced the values (plain) and `secrets` the drafts */
function formWith(edits = {}, secrets = {}) {
  let form = logic.initialForm(settings);
  for (const [key, value] of Object.entries(edits)) form = logic.setValue(form, key, value);
  for (const [key, patch] of Object.entries(secrets)) form = logic.setSecret(form, key, patch);
  return form;
}

describe("grouping by theme", () => {
  test("themes in display order, boot read-only last, flagged entries in one folded group at the end", () => {
    const groups = logic.groupSettings(settings);
    assert.deepEqual(groups.map((g) => g.theme), [...logic.THEME_ORDER, "inactive"]);
    assert.deepEqual(groups.filter((g) => g.folded).map((g) => g.theme), ["inactive"]);
    assert.equal(groups.reduce((n, g) => n + g.items.length, 0), 101, "every entry appears exactly once (SC-002)");
    const inactive = groups.find((g) => g.theme === "inactive");
    assert.equal(inactive.items.length, 21);
    assert.ok(inactive.items.every((s) => s.inactive));
    assert.ok(groups.filter((g) => !g.folded).every((g) => g.items.every((s) => !s.inactive && s.theme === g.theme)));
    assert.equal(groups.find((g) => g.theme === "boot").items.length, 13);
    assert.equal(groups.find((g) => g.theme === "alerts").items.length, 6);
  });

  test("empty groups are left out; the keys keep the catalog order", () => {
    const groups = logic.groupSettings(settings.filter((s) => s.theme === "general"));
    assert.deepEqual(groups.map((g) => g.theme), ["general"]);
    assert.deepEqual(groups[0].items.map((s) => s.key), ["PREFIX", "SUDO", "BOT_LANG", "TIMEZONE", "STICKER_PACKNAME", "STICKER_AUTHOR"]);
    assert.deepEqual(logic.groupSettings(null), []);
  });

  test("isEditable: not read-only, not inactive, not boot-only", () => {
    assert.equal(logic.isEditable(find("PREFIX")), true);
    assert.equal(logic.isEditable(find("ANTIDELETE_MODE")), true);
    assert.equal(logic.isEditable(find("PANEL_PORT")), false);
    assert.equal(logic.isEditable(find("GROQ_API_KEY")), false);
    assert.equal(logic.isEditable(find("YTDLP_PATH")), false);
    assert.equal(settings.filter(logic.isEditable).length, 67);
  });

  test("originKind: default, file/environment, panel, and 'saved by the bot' for an adapter-backed value", () => {
    assert.equal(logic.originKind({ origin: "default", source: "env" }), "default");
    assert.equal(logic.originKind({ origin: "env", source: "env" }), "env");
    assert.equal(logic.originKind({ origin: "override", source: "env" }), "panel");
    assert.equal(logic.originKind({ origin: "override", source: "model" }), "bot");
    assert.equal(logic.originKind({ origin: "override", source: "file" }), "bot");
  });
});

describe("list parsing", () => {
  test("parseList splits on commas, semicolons and line breaks, never on spaces", () => {
    assert.deepEqual(logic.parseList("a, b\nc; d"), ["a", "b", "c", "d"]);
    assert.deepEqual(logic.parseList("+237 600 000 001, 237600000002"), ["+237 600 000 001", "237600000002"]);
    assert.deepEqual(logic.parseList(" , ;\n"), []);
    assert.deepEqual(logic.parseList(null), []);
  });

  test("cleanList trims, drops empty rows and splits pasted lists", () => {
    assert.deepEqual(logic.cleanList(["  🔥 ", "", "👍, ❤️", "  "]), ["🔥", "👍", "❤️"]);
    assert.deepEqual(logic.cleanList(undefined), []);
  });

  test("valuesEqual compares lists by items", () => {
    assert.equal(logic.valuesEqual(["a", "b"], ["a", "b"]), true);
    assert.equal(logic.valuesEqual(["a", "b"], ["b", "a"]), false);
    assert.equal(logic.valuesEqual(["a"], "a"), false);
    assert.equal(logic.valuesEqual(3, 3), true);
  });
});

describe("the form and the SET-2 payload", () => {
  test("a fresh form changes nothing: no payload", () => {
    const form = logic.initialForm(settings);
    assert.deepEqual(logic.diffChanges(settings, form), []);
    assert.equal(logic.buildPayload(settings, form), null);
    assert.deepEqual(logic.changeCounts(settings, form), {});
    assert.equal(Object.keys(form.secrets).length, 22, "a draft slot per secret, never the stored value");
    for (const draft of Object.values(form.secrets)) assert.deepEqual(draft, { draft: "", cleared: false });
  });

  test("only the changed fields are sent, each with its version and op set", () => {
    const form = formWith({ PREFIX: "!", WARN_LIMIT: 5, ALERT_UPDATE: false, TIMEZONE: find("TIMEZONE").value });
    const changes = logic.diffChanges(settings, form);
    assert.deepEqual(changes, [
      { key: "PREFIX", op: "set", value: "!", version: find("PREFIX").version },
      { key: "ALERT_UPDATE", op: "set", value: false, version: find("ALERT_UPDATE").version },
      { key: "WARN_LIMIT", op: "set", value: 5, version: find("WARN_LIMIT").version },
    ].sort((a, b) => settings.findIndex((s) => s.key === a.key) - settings.findIndex((s) => s.key === b.key)));
    assert.deepEqual(logic.changeCounts(settings, form), { general: 1, alerts: 1, moderation: 1 });
  });

  test("the version of every change is the one the server sent (a stale page is caught by the server)", () => {
    const stale = settings.map((s) => (s.key === "PREFIX" ? { ...s, version: 7 } : s));
    const body = logic.buildPayload(stale, formWith({ PREFIX: "?" }));
    assert.equal(body.changes[0].version, 7);
  });

  test("a secret is sent only when something was typed; clearing is op default; the stored value is never read", () => {
    let body = logic.buildPayload(settings, formWith({}, { OPENAI_API_KEY: { draft: "sk-test-FAKE0000-AAAA1234" } }));
    assert.deepEqual(body.changes, [{ key: "OPENAI_API_KEY", op: "set", value: "sk-test-FAKE0000-AAAA1234", version: find("OPENAI_API_KEY").version }]);
    body = logic.buildPayload(settings, formWith({}, { GEMINI_API_KEY: { cleared: true } }));
    assert.deepEqual(body.changes, [{ key: "GEMINI_API_KEY", op: "default", version: find("GEMINI_API_KEY").version }]);
    assert.equal(logic.buildPayload(settings, formWith({}, { OPENAI_API_KEY: { draft: "" } })), null, "an empty draft is not a change");
    // a secret has no value in the list: nothing can be echoed back
    assert.ok(settings.filter((s) => s.secret).every((s) => !("value" in s)));
  });

  test("lists are cleaned and compared by items; an untouched list is not a change", () => {
    const emojis = find("STATUS_EMOJIS");
    assert.equal(logic.buildPayload(settings, formWith({ STATUS_EMOJIS: [...emojis.value, "", "  "] })), null, "blank rows are not a change");
    const body = logic.buildPayload(settings, formWith({ STATUS_EMOJIS: ["🔥", "", "👍, ❤️"] }));
    assert.deepEqual(body.changes[0].value, ["🔥", "👍", "❤️"]);
  });

  test("read-only and inactive entries are never sent, whatever the form says", () => {
    const form = formWith({ PANEL_PORT: 9999, GROQ_API_KEY: "x", YTDLP_PATH: "/bin/sh" });
    assert.equal(logic.buildPayload(settings, form), null);
  });

  test("a JID is sent only while its mode is jid; the server clears it when the mode leaves jid", () => {
    assert.equal(logic.jidApplies(find("ANTIDELETE_JID"), logic.initialForm(settings), settings), false);
    const off = formWith({ ANTIDELETE_JID: "237600000000" });
    assert.equal(logic.buildPayload(settings, off), null, "mode off: the JID field is inert");
    const on = formWith({ ANTIDELETE_MODE: "jid", ANTIDELETE_JID: "237600000000" });
    assert.deepEqual(logic.diffChanges(settings, on).map((c) => c.key), ["ANTIDELETE_MODE", "ANTIDELETE_JID"]);
    assert.equal(logic.jidApplies(find("VIEWONCE_JID"), formWith({ VIEWONCE_MODE: "jid" }), settings), true);
    assert.equal(logic.jidApplies(find("PREFIX"), logic.initialForm(settings), settings), true, "other settings always apply");
  });

  test("the owners confirmation: emptying SUDO is detected before sending", () => {
    assert.equal(logic.emptiesOwners(settings, formWith({ SUDO: ["", " "] })), true);
    assert.equal(logic.emptiesOwners(settings, formWith({ SUDO: ["237600000001"] })), false);
    assert.equal(logic.emptiesOwners(settings, logic.initialForm(settings)), false);
    const body = logic.buildPayload(settings, formWith({ SUDO: [] }), { confirm: ["owners_empty"] });
    assert.deepEqual(body.confirm, ["owners_empty"]);
    assert.equal(logic.buildPayload(settings, formWith({ SUDO: [] })).confirm, undefined);
  });

  test("singleChange: reset to default and revert to the file are one change with a version", () => {
    assert.deepEqual(logic.singleChange(find("WARN_LIMIT"), "default"), { changes: [{ key: "WARN_LIMIT", op: "default", version: find("WARN_LIMIT").version }] });
    assert.deepEqual(logic.singleChange(find("PREFIX"), "revert").changes[0].op, "revert");
  });

  test("resetKeys takes keys back from the server; secrets drop their draft", () => {
    const form = formWith({ PREFIX: "!", WARN_LIMIT: 9 }, { OPENAI_API_KEY: { draft: "typed" } });
    const next = logic.resetKeys(form, settings, ["PREFIX", "OPENAI_API_KEY"]);
    assert.equal(next.values.PREFIX, find("PREFIX").value);
    assert.equal(next.values.WARN_LIMIT, 9, "other edits are kept");
    assert.deepEqual(next.secrets.OPENAI_API_KEY, { draft: "", cleared: false });
  });

  test("rebaseForm: an untouched field follows the fresher server value, an edited field keeps its draft", () => {
    const form = formWith({ PREFIX: "!" }); // PREFIX edited, WARN_LIMIT untouched
    const fresher = settings.map((s) => (s.key === "WARN_LIMIT" ? { ...s, value: 9, version: s.version + 1 } : s.key === "PREFIX" ? { ...s, value: "?", version: s.version + 1 } : s));
    const next = logic.rebaseForm(form, settings, fresher);
    assert.equal(next.values.WARN_LIMIT, 9, "somebody else's change is not undone by the next save");
    assert.equal(next.values.PREFIX, "!", "what was typed stays");
    const body = logic.buildPayload(fresher, next);
    assert.deepEqual(body.changes.map((c) => [c.key, c.value]), [["PREFIX", "!"]]);
  });

  test("pairKeys: a mode and its JID share one row and one version", () => {
    assert.deepEqual(logic.pairKeys("ANTIDELETE_JID"), ["ANTIDELETE_MODE", "ANTIDELETE_JID"]);
    assert.deepEqual(logic.pairKeys("VIEWONCE_MODE"), ["VIEWONCE_MODE", "VIEWONCE_JID"]);
    assert.deepEqual(logic.pairKeys("PREFIX"), ["PREFIX"]);
  });

  test("mergeSettings replaces the answered settings and keeps the order", () => {
    const merged = logic.mergeSettings(settings, [{ ...find("PREFIX"), value: "!", version: 4 }]);
    assert.equal(merged.length, settings.length);
    assert.deepEqual(merged.map((s) => s.key), settings.map((s) => s.key));
    assert.equal(merged[0].value, "!");
    assert.equal(settings[0].value, ".", "the old list is untouched");
  });

  test("themeOf: the tab holding a key; the folded group for a flagged entry", () => {
    assert.equal(logic.themeOf(settings, "PREFIX"), "general");
    assert.equal(logic.themeOf(settings, "GROQ_API_KEY"), "inactive");
    assert.equal(logic.themeOf(settings, "NOPE"), null);
  });
});

describe("client-side pre-validation from rules", () => {
  const verdict = (key, value) => {
    const setting = find(key);
    return logic.validateField(setting, value);
  };

  test("the common mistakes are caught with the API's own field codes", () => {
    assert.deepEqual(verdict("PREFIX", ""), { code: "required" });
    assert.deepEqual(verdict("PREFIX", "a b"), { code: "invalid_format", params: { reason: "whitespace" } });
    assert.deepEqual(verdict("PREFIX", "abcd"), { code: "too_long", params: { max: 3 } });
    assert.equal(verdict("PREFIX", "!"), null);
    assert.deepEqual(verdict("WARN_LIMIT", 0), { code: "out_of_range", params: { min: 1, max: 50 } });
    assert.deepEqual(verdict("WARN_LIMIT", null), { code: "required" });
    assert.deepEqual(verdict("WARN_LIMIT", 2.5), { code: "invalid_type" });
    assert.equal(verdict("WARN_LIMIT", 7), null);
    assert.equal(verdict("AUTO_RESPONDER_MIN_DELAY", 0), null, "zero is meaningful here");
    assert.equal(verdict("BOT_LANG", "xx").code, "not_allowed");
    assert.equal(verdict("BOT_LANG", "fr"), null);
    assert.equal(verdict("LOG_LEVEL", "verbose").code, "not_allowed");
    assert.deepEqual(verdict("STATUS_SAVE_LIST", ["abc", "237600000001", "12"]), { code: "invalid_phone", params: { indices: [0, 2] } });
    assert.equal(verdict("STATUS_SAVE_LIST", ["+237 600 000 001"]), null);
    assert.deepEqual(verdict("STATUS_EMOJIS", []), { code: "required" });
    assert.equal(verdict("STATUS_EMOJIS", Array.from({ length: 31 }, () => "🔥")).code, "too_many_items");
    assert.deepEqual(verdict("SUDO", Array.from({ length: 21 }, () => "237600000001")), { code: "too_many_items", params: { max: 20 } });
    assert.deepEqual(verdict("WARN_MESSAGE", "hi &mention &nope &warn"), { code: "unknown_variable", params: { names: ["&nope"] } });
    assert.equal(verdict("WARN_MESSAGE", "hi &mention &warn &remaining"), null);
    assert.equal(verdict("BACKEND_URL", "ftp://x.test").code, "invalid_url");
    assert.equal(verdict("BACKEND_URL", ""), null);
    assert.equal(verdict("BACKEND_URL", "https://example.test/api"), null);
    assert.equal(verdict("GEMINI_MODEL", "bad model!").code, "invalid_format");
    assert.equal(verdict("GEMINI_VISION_MODEL", ""), null, "empty allowed");
    assert.deepEqual(verdict("OPENAI_API_KEY", "short"), { code: "too_short", params: { min: 8 } });
    assert.equal(verdict("OPENAI_API_KEY", "has a space inside").code, "invalid_format");
    assert.equal(verdict("OPENAI_API_KEY", "sk-test-FAKE0000-AAAA1234"), null);
  });

  test("the pre-validation never blocks what the server accepts, and agrees on the code when both refuse", () => {
    const samples = {
      PREFIX: ["", "!", "a b", "abcd", "..", "😀"],
      WARN_LIMIT: [0, 1, 50, 51, -3],
      MAX_UPLOAD: [0, 1, 2000, 2001],
      BOT_LANG: ["fr", "xx"],
      STATUS_SAVE_LIST: [[], ["237600000001"], ["12"], ["abc"]],
      STATUS_EMOJIS: [[], ["🔥"], ["ok"]],
      OPENAI_API_KEY: ["", "short", "sk-test-FAKE0000-AAAA1234", "a b c d e f g h"],
      WARN_KICK_MESSAGE: ["&mention left", "&unknown left", ""],
      BACKEND_URL: ["", "https://example.test", "ftp://example.test", "not a url"],
      LOG_LEVEL: ["info", "loud"],
      AUTO_RESPONDER_TYPING_SPEED: [0, 1, 1000, 1001],
    };
    for (const [key, values] of Object.entries(samples)) {
      const item = catalog.byKey.get(key);
      for (const value of values) {
        const server = item.validate(value);
        const client = logic.validateField(find(key), value);
        // a rule the client does not implement (emoji shape) is left to the server; the reverse would block a valid save
        if (!server) assert.equal(client, null, `${key}=${JSON.stringify(value)}: the server accepts, the client refused (${client && client.code})`);
        if (server && client) assert.equal(client.code, server.code, `${key}=${JSON.stringify(value)}`);
      }
    }
  });

  test("validateForm checks the changed fields only: a bad value already in the file is not blamed", () => {
    const problems = logic.validateForm(settings, formWith({ PREFIX: "a b", WARN_LIMIT: 99 }));
    assert.deepEqual(Object.keys(problems).sort(), ["PREFIX", "WARN_LIMIT"]);
    assert.deepEqual(logic.validateForm(settings, logic.initialForm(settings)), {});
    const secret = logic.validateForm(settings, formWith({}, { OPENAI_API_KEY: { draft: "short" } }));
    assert.equal(secret.OPENAI_API_KEY.code, "too_short");
  });

  test("the pair of delays: the shortest pause must not exceed the longest (bound_conflict)", () => {
    const problems = logic.validateForm(settings, formWith({ AUTO_RESPONDER_MIN_DELAY: 9000 }));
    assert.deepEqual(problems.AUTO_RESPONDER_MIN_DELAY, { code: "bound_conflict", params: { other: "AUTO_RESPONDER_MAX_DELAY" } });
    assert.deepEqual(logic.validateForm(settings, formWith({ AUTO_RESPONDER_MIN_DELAY: 100, AUTO_RESPONDER_MAX_DELAY: 9000 })), {});
    assert.ok(logic.validateForm(settings, formWith({ AUTO_RESPONDER_MAX_DELAY: 10 })).AUTO_RESPONDER_MAX_DELAY, "lowering the longest pause below the shortest");
  });
});

describe("reading the API", () => {
  const apiError = (code, fields, params) => new api.ApiError({ status: code === "conflict" ? 409 : 422, code, fields, params });

  test("field errors of a validation_failed answer, by key", () => {
    const error = apiError("validation_failed", { PREFIX: { code: "invalid_format", params: { reason: "whitespace" } }, TIMEZONE: { code: "invalid_timezone" } });
    assert.deepEqual(logic.fieldErrorsFromError(error), {
      PREFIX: { code: "invalid_format", params: { reason: "whitespace" } },
      TIMEZONE: { code: "invalid_timezone" },
    });
    assert.deepEqual(logic.fieldErrorsFromError(new Error("x")), {});
    assert.deepEqual(logic.fieldErrorsFromError(null), {});
  });

  test("a version conflict gives the current version of each stale setting", () => {
    const error = apiError("conflict", { PREFIX: { code: "conflict", params: { version: 4 } }, WARN_LIMIT: { code: "conflict", params: { version: 2 } }, TIMEZONE: { code: "invalid_timezone" } });
    assert.deepEqual(logic.conflictVersions(error), { PREFIX: 4, WARN_LIMIT: 2 });
  });

  test("the owners confirmation is recognised by its code and parameter", () => {
    assert.equal(logic.isOwnersConfirmation(apiError("confirmation_required", null, { confirm: ["owners_empty"] })), true);
    assert.equal(logic.isOwnersConfirmation(apiError("confirmation_required", null, { confirm: ["other"] })), false);
    assert.equal(logic.isOwnersConfirmation(apiError("validation_failed")), false);
    assert.equal(logic.isOwnersConfirmation(null), false);
  });
});

describe("display helpers", () => {
  test("describeDefault: a value, a derived rule, nothing for a secret", () => {
    assert.deepEqual(logic.describeDefault(find("PREFIX")), { kind: "value", value: "." });
    assert.deepEqual(logic.describeDefault(find("GEMINI_VISION_MODEL")), { kind: "same_as", other: "GEMINI_MODEL" });
    assert.deepEqual(logic.describeDefault(find("PANEL_HOST")), { kind: "auto_host" });
    assert.deepEqual(logic.describeDefault(find("OPENAI_API_KEY")), { kind: "none" });
  });

  test("the Test button belongs to the secret of a testable service; it is hidden for Alpha Vantage and unused keys", () => {
    const withButton = settings.filter(logic.canTest).map((s) => s.key);
    assert.deepEqual(withButton, ["OPENAI_API_KEY", "GEMINI_API_KEY", "WEATHER_API_KEY", "UNSPLASH_API_KEY", "GIPHY_API_KEY", "NEWS_API_KEY", "SPOTIFY_CLIENT_SECRET", "REDDIT_CLIENT_SECRET"]);
    assert.equal(logic.canTest(find("ALPHA_VANTAGE_KEY")), false);
    assert.equal(logic.canTest(find("SPOTIFY_CLIENT_ID")), false);
    assert.equal(logic.canTest(find("GROQ_API_KEY")), false);
    assert.deepEqual(logic.testableServices(settings).map((s) => s.id), ["openai", "gemini", "weather", "unsplash", "giphy", "news", "spotify", "reddit"]);
  });

  test("verdict tones and unit keys", () => {
    assert.equal(logic.verdictTone("accepted"), "ok");
    assert.equal(logic.verdictTone("refused"), "danger");
    assert.equal(logic.verdictTone("unreachable"), "warn");
    assert.equal(logic.unitKey("chars/s"), "chars_per_s");
    assert.equal(logic.unitKey("ms"), "ms");
    assert.equal(logic.plainValue(["a", "b"]), "a, b");
    assert.equal(logic.plainValue(null), "");
  });
});

describe("panel-settings.json (T114)", () => {
  const fragment = JSON.parse(fs.readFileSync(path.join(ROOT, "specs", "002-admin-panel", "i18n", "panel-settings.json"), "utf8"));
  const base = (lang) => JSON.parse(fs.readFileSync(path.join(ROOT, "lib", "admin", "public", "i18n", `${lang}.json`), "utf8"));

  test("a label and a description for all 101 catalog entries, in English and in French", () => {
    for (const lang of ["en", "fr"]) {
      for (const entry of catalog.entries) {
        for (const part of ["label", "desc"]) {
          const text = fragment[lang][`settings.${entry.key}.${part}`];
          assert.ok(typeof text === "string" && text.trim() !== "", `${lang}: settings.${entry.key}.${part}`);
        }
      }
    }
    assert.equal(catalog.entries.length, 101);
  });

  test("the same keys in both languages, the same {placeholders}", () => {
    assert.deepEqual(Object.keys(fragment.en), Object.keys(fragment.fr));
    const names = (text) => (text.match(/\{[A-Za-z0-9_]+\}/g) || []).sort().join(",");
    for (const key of Object.keys(fragment.en)) assert.equal(names(fragment.en[key]), names(fragment.fr[key]), key);
  });

  test("no description is a copy of its label, no French text is left in English", () => {
    for (const entry of catalog.entries) {
      assert.notEqual(fragment.en[`settings.${entry.key}.desc`], fragment.en[`settings.${entry.key}.label`], entry.key);
    }
    const same = Object.keys(fragment.en).filter((key) => key.endsWith(".label") && fragment.en[key] === fragment.fr[key]);
    // only technical names may be identical (Giphy key, ...): never more than a handful
    assert.ok(same.length <= 12, `labels identical in en and fr: ${same.join(", ")}`);
  });

  test("the keys the view builds dynamically all exist (modes, origins, problems, verdicts, units, themes)", () => {
    const all = { ...base("en"), ...fragment.en };
    const need = [
      ...["off", "p", "g", "sudo", "jid"].map((v) => `settings.mode.${v}`),
      ...["default", "env", "panel", "bot"].map((v) => `settings.origin_${v}`),
      ...["invalid_file_value", "reenter", "invalid_override", "adapter_unavailable"].map((c) => `settings.problem.${c}`),
      ...["accepted", "refused", "unreachable"].map((v) => `settings.test.${v}`),
      ...catalog.themes.map((theme) => `settings.theme.${theme}`),
      ...[...new Set(catalog.entries.map((e) => e.unit).filter(Boolean))].map((unit) => `settings.unit.${logic.unitKey(unit)}`),
    ];
    for (const key of need) assert.ok(typeof all[key] === "string", key);
  });

  test("the enumerations labelled by the view cover every value of the catalog", () => {
    for (const key of logic.MODE_KEYS) assert.ok(find(key).rules.enum.every((value) => fragment.en[`settings.mode.${value}`]), key);
  });
});

describe("the payload of the view logic is what SET-2 accepts", () => {
  let t;
  let client;

  before(async () => {
    t = await createTestAdmin({ deps: { statusListStore: { FILE_PATH: path.join(tmp, "absent.json") } } });
    await t.admin.start();
    client = await t.loginClient();
  });

  after(async () => {
    await t.close();
  });

  test("edit, build the payload, send it, merge the answer: nothing is left to save", async () => {
    let list = (await client.get("/admin/api/settings")).json.settings;
    let form = logic.initialForm(list);
    form = logic.setValue(form, "PREFIX", "!");
    form = logic.setValue(form, "WARN_LIMIT", 6);
    form = logic.setValue(form, "STATUS_EMOJIS", ["🔥", "", "👍, ❤️"]);
    form = logic.setValue(form, "ANTIDELETE_MODE", "jid");
    form = logic.setValue(form, "ANTIDELETE_JID", "237600000000");
    form = logic.setSecret(form, "OPENAI_API_KEY", { draft: "sk-test-FAKE0000-AAAA1234" });
    assert.deepEqual(logic.validateForm(list, form), {});

    const payload = logic.buildPayload(list, form);
    assert.equal(payload.changes.length, 6);
    const answer = await client.api("PATCH", "/admin/api/settings", payload);
    assert.equal(answer.status, 200, JSON.stringify(answer.json));

    list = logic.mergeSettings(list, answer.json.settings);
    form = logic.resetKeys(form, answer.json.settings, answer.json.settings.map((s) => s.key));
    assert.equal(logic.buildPayload(list, form), null, "after the merge the form matches the server");
    assert.equal(list.find((s) => s.key === "STATUS_EMOJIS").value.join(""), "🔥👍❤️");

    // a second save with the new versions goes through; the old versions would not
    const next = logic.buildPayload(list, logic.setValue(form, "PREFIX", "?"));
    assert.equal((await client.api("PATCH", "/admin/api/settings", next)).status, 200);
    const stale = await client.api("PATCH", "/admin/api/settings", payload);
    assert.equal(stale.status, 409);
    const conflicts = logic.conflictVersions(new api.ApiError({ status: 409, code: "conflict", fields: stale.json.error.fields }));
    assert.ok(Object.keys(conflicts).includes("PREFIX"));
  });
});

// ---------------------------------------------------------------------------
// The view itself, rendered in a fake DOM with a scripted server
// ---------------------------------------------------------------------------

describe("the view renders and works", () => {
  const { createDom, importPublic } = require("./helpers/fakeDom");
  let dom;
  let ui;
  let htmlTag;
  let view;
  let requests;
  let routes;

  const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const answer = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  });

  /** SET-1 as the server sends it, with `patch` merged over some settings */
  const list = (over = {}, extra = {}) => ({
    settings: settings.map((s) => (over[s.key] ? { ...s, ...over[s.key] } : s)),
    restartPending: [],
    secretStore: "ok",
    ownersConfigured: true,
    ...extra,
  });

  before(async () => {
    dom = await createDom();
    const i18n = await importPublic("js/i18n.mjs");
    const catalog = (lang) => ({
      ...readJson(path.join(ROOT, "lib", "admin", "public", "i18n", `${lang}.json`)),
      ...readJson(path.join(ROOT, "specs", "002-admin-panel", "i18n", "panel-settings.json"))[lang],
    });
    i18n.setCatalog("en", catalog("en"));
    i18n.setCatalog("fr", catalog("fr"));
    await i18n.setLanguage("en", { remember: false });
    ui = await importPublic("js/ui.mjs");
    htmlTag = (await importPublic("js/components/html.mjs")).html;
    view = await importPublic("js/views/settings.mjs");
  });

  after(() => {
    dom.restore();
    delete globalThis.fetch;
  });

  /** Mount the view; `script` maps "METHOD /path" to a function(body) -> response */
  async function open(script = {}) {
    requests = [];
    routes = { "GET /admin/api/settings": () => answer(200, list()), ...script };
    globalThis.fetch = async (url, init) => {
      const key = `${init.method} ${url}`;
      const body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ key, body });
      if (!routes[key]) throw new Error(`unexpected request ${key}`);
      return routes[key](body);
    };
    const root = dom.mount(htmlTag`<${view.default} route=${{ rest: [] }} />`);
    await dom.settle();
    return root;
  }

  const input = (root, name) => dom.byAttr(root, "name", name)[0];
  const button = (root, text) => dom.byText(root, text, "button")[0];
  const tab = (root, label) => dom.find(root, (el) => el.getAttribute("role") === "tab" && dom.text(el).startsWith(label))[0];

  test("loads SET-1, shows the themes as tabs and the first tab's settings; nothing to save yet", async () => {
    const root = await open();
    const text = dom.text(root);
    for (const label of ["General", "Behaviour", "API keys", "Auto responder", "Moderation", "Limits", "Advanced", "Alerts", "Startup"]) {
      assert.ok(tab(root, label), `tab ${label}`);
    }
    assert.ok(text.includes("Command prefix"));
    assert.ok(text.includes("Owners"));
    assert.match(text, /No effect today \(\s*21\s*\)/, "the folded group of flagged entries");
    assert.equal(button(root, "Save changes"), undefined);
    assert.equal(input(root, "PREFIX").value, ".");
    dom.unmount(root);
  });

  test("typing makes a change: the save button appears with the count, and the payload carries the version", async () => {
    const root = await open({
      "PATCH /admin/api/settings": () => answer(200, { settings: [{ ...find("PREFIX"), value: "!", origin: "override", canRevert: true, version: 1 }], restartPending: [] }),
    });
    dom.type(input(root, "PREFIX"), "!");
    await dom.settle();
    const save = button(root, "Save changes (1)");
    assert.ok(save, dom.text(root));
    assert.ok(tab(root, "General").childNodes.some((c) => c.nodeType === 1 && dom.text(c) === "1"), "the tab shows how many fields changed");
    dom.click(save);
    await dom.settle(12);
    const patch = requests.find((r) => r.key === "PATCH /admin/api/settings");
    assert.deepEqual(patch.body, { changes: [{ key: "PREFIX", op: "set", value: "!", version: find("PREFIX").version }] });
    assert.equal(button(root, "Save changes"), undefined, "saved: nothing left to save");
    assert.equal(input(root, "PREFIX").value, "!");
    assert.ok(dom.text(root).includes("Panel"), "now an override: the origin badge says so");
    assert.ok(button(root, "Back to the file value"), "an override can be reverted");
    dom.unmount(root);
  });

  test("a value the pre-validation refuses is not sent and is flagged on its field", async () => {
    const root = await open();
    dom.type(input(root, "PREFIX"), "a b");
    await dom.settle();
    dom.click(button(root, "Save changes (1)"));
    await dom.settle(12);
    assert.equal(requests.filter((r) => r.key.startsWith("PATCH")).length, 0);
    assert.ok(dom.text(root).includes("Invalid format."), dom.text(root));
    dom.unmount(root);
  });

  test("a validation_failed answer puts the API's field errors on the fields", async () => {
    const root = await open({
      "PATCH /admin/api/settings": () => answer(422, { error: { code: "validation_failed", fields: { PREFIX: { code: "invalid_format", params: { reason: "whitespace" } } } } }),
    });
    dom.type(input(root, "PREFIX"), "!!");
    await dom.settle();
    dom.click(button(root, "Save changes (1)"));
    await dom.settle(12);
    assert.ok(dom.text(root).includes("Invalid format."));
    assert.ok(button(root, "Save changes (1)"), "the draft is kept");
    dom.unmount(root);
  });

  test("a version conflict shows the conflict message and a button that reloads that setting", async () => {
    const root = await open({
      "PATCH /admin/api/settings": () => answer(409, { error: { code: "conflict", fields: { PREFIX: { code: "conflict", params: { version: 4 } } } } }),
    });
    dom.type(input(root, "PREFIX"), "!");
    await dom.settle();
    dom.click(button(root, "Save changes (1)"));
    await dom.settle(12);
    assert.ok(dom.text(root).includes("This setting changed since the page was opened (version 4)."), dom.text(root));
    // the server now has the other value: reloading drops the stale draft and takes the new version
    routes["GET /admin/api/settings"] = () => answer(200, list({ PREFIX: { value: "?", version: 4, origin: "override", canRevert: true } }));
    dom.click(button(root, "Reload this setting"));
    await dom.settle(12);
    assert.equal(input(root, "PREFIX").value, "?");
    assert.equal(button(root, "Save changes"), undefined);
    assert.ok(!dom.text(root).includes("This setting changed"));
    dom.unmount(root);
  });

  test("API keys: a write-only field, 'set (…1234)' once saved, a Test button hidden for Alpha Vantage", async () => {
    const root = await open({
      "GET /admin/api/settings": () => answer(200, list({ OPENAI_API_KEY: { secret: { set: true, last4: "1234", needsReentry: false }, origin: "override", canRevert: true } })),
      "POST /admin/api/settings/keys/openai/test": () => answer(200, { service: "openai", verdict: "refused", detail: null, checkedAt: "2026-01-01T12:00:00.000Z" }),
    });
    dom.click(tab(root, "API keys"));
    await dom.settle();
    const text = dom.text(root);
    assert.ok(text.includes("OpenAI key") && text.includes("Set (…1234)"));
    assert.ok(!text.includes("sk-test"), "the stored value never reaches the page");
    const tests = dom.byText(root, "Test the key", "button");
    assert.equal(tests.length, 8, "one per testable service; none for Alpha Vantage");
    const [openai] = tests;
    dom.click(openai);
    await dom.settle(12);
    assert.ok(requests.some((r) => r.key === "POST /admin/api/settings/keys/openai/test"));
    assert.ok(dom.text(root).includes("Refused"), "the verdict is shown");
    // typing a secret is a change; the typed value is the only thing ever sent
    dom.type(input(root, "GEMINI_API_KEY"), "sk-test-FAKE0000-BBBB5678");
    await dom.settle();
    assert.ok(button(root, "Save changes (1)"));
    dom.unmount(root);
  });

  test("emptying the owners asks first; the confirmation travels with the request", async () => {
    const root = await open({
      "PATCH /admin/api/settings": () => answer(200, { settings: [{ ...find("SUDO"), value: [], origin: "override", version: 1 }], restartPending: [] }),
    });
    for (const remove of dom.find(root, (el) => el.localName === "button" && el.getAttribute("aria-label") === "Remove")) dom.click(remove);
    await dom.settle();
    dom.click(button(root, "Save changes (1)"));
    await dom.settle();
    const asked = ui.confirmStore.get().request;
    assert.ok(asked, "a confirmation was raised");
    assert.equal(asked.title, "Remove every owner?");
    ui.resolveConfirm(true);
    await dom.settle(12);
    const patch = requests.find((r) => r.key === "PATCH /admin/api/settings");
    assert.deepEqual(patch.body.confirm, ["owners_empty"]);
    assert.deepEqual(patch.body.changes[0].value, []);
    dom.unmount(root);
  });

  test("a restart-pending list shows the banner and a restart button that asks before it posts", async () => {
    const root = await open({
      "GET /admin/api/settings": () => answer(200, list({ ALWAYS_ONLINE: { pendingRestart: true } }, { restartPending: ["ALWAYS_ONLINE"] })),
      "POST /admin/api/restart": () => answer(202, { job: { id: "j1", type: "restart", status: "running" } }),
    });
    assert.ok(dom.text(root).includes("A restart is needed to apply: ALWAYS_ONLINE."));
    dom.click(button(root, "Restart now"));
    await dom.settle();
    assert.equal(requests.some((r) => r.key === "POST /admin/api/restart"), false, "not before the confirmation");
    ui.resolveConfirm(true);
    await dom.settle(12);
    assert.deepEqual(requests.find((r) => r.key === "POST /admin/api/restart").body, { confirm: true });
    dom.unmount(root);
  });

  test("startup settings are read-only values; flagged entries sit in the folded group", async () => {
    const root = await open();
    dom.click(tab(root, "Startup"));
    await dom.settle();
    assert.equal(dom.byAttr(root, "name", "PANEL_PORT").length, 0, "no control for a startup setting");
    assert.ok(dom.text(root).includes("Panel port"));
    assert.ok(dom.text(root).includes("Read at startup"));
    const folded = dom.find(root, (el) => el.localName === "details")[0];
    assert.ok(folded && dom.text(folded).includes("Groq key"));
    assert.equal(dom.byAttr(folded, "name", "GROQ_API_KEY").length, 0);
    dom.unmount(root);
  });

  test("a failed load offers a retry", async () => {
    const root = await open({ "GET /admin/api/settings": () => answer(500, { error: { code: "internal_error" } }) });
    assert.ok(dom.text(root).includes("This page could not be displayed"));
    routes["GET /admin/api/settings"] = () => answer(200, list());
    dom.click(button(root, "Try again"));
    await dom.settle(12);
    assert.ok(dom.text(root).includes("Command prefix"));
    dom.unmount(root);
  });
});
