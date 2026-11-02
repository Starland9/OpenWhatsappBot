"use strict";
/**
 * The permissions views, pure logic (specs/003-command-permissions T016, T017):
 * lib/admin/public/js/views/permissions-logic.mjs, contracts/panel-ui.md sections 4, 10 and 13.
 *
 *  - typed numbers (U5), person identity, the draft (add, toggle, diff, dirty, canSave, request body);
 *  - the live warnings of the editor against the table of section 10 and the server examples of the API contract 1.5;
 *  - the warning and badge keys: every key the logic can return exists in the en and fr catalogs (the real files
 *    overlaid with the 003 fragment, so this file also runs before the catalogs are merged);
 *  - commands, levels, locks, the "allowed everywhere" rows, orphans, the picker query and the deep links;
 *  - the view modules import in plain Node and export their components.
 *
 * No browser and no server: the logic module has no DOM access at import time.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const VIEWS = path.join(ROOT, "lib", "admin", "public", "js", "views");
const CATALOG_DIR = path.join(ROOT, "lib", "admin", "public", "i18n");
const FRAGMENT = path.join(ROOT, "specs", "003-command-permissions", "i18n", "panel-permissions.json");
const API_CONTRACT = path.join(ROOT, "specs", "003-command-permissions", "contracts", "admin-permissions-api.md");
const load = (file) => import(pathToFileURL(path.join(VIEWS, file)).href);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const placeholdersOf = (text) => (String(text).match(/\{[A-Za-z0-9_]+\}/g) || []).sort().join(",");

/** The real panel catalogs overlaid with the 003 fragment (the fragment wins, as in the merge) */
function catalogOf(lang) {
  const catalog = { ...readJson(path.join(CATALOG_DIR, `${lang}.json`)) };
  if (fs.existsSync(FRAGMENT)) Object.assign(catalog, readJson(FRAGMENT)[lang] || {});
  return catalog;
}
const CATALOGS = { en: catalogOf("en"), fr: catalogOf("fr") };
const assertInCatalogs = (key, what = "key") => {
  for (const lang of ["en", "fr"]) assert.equal(typeof CATALOGS[lang][key], "string", `${what} "${key}" is missing in ${lang}`);
};

const pn = (digits) => `${digits}@s.whatsapp.net`;
const A = pn("237690000001");
const B = pn("237690000002");
const C = pn("237690000003");
const GROUP = "120363000000000000@g.us";
const GROUP2 = "120363000000000009@g.us";

const person = (jid, over = {}) => ({ jid, name: null, ...over });
const rule = (mode, people, over = {}) => ({ command: "vv", scope: GROUP, mode, people: people.map((p) => (typeof p === "string" ? person(p) : p)), warnings: [], ...over });

const command = (name, access = {}, over = {}) => ({
  name,
  aliases: [name],
  type: "general",
  desc: `desc of ${name}`,
  access: { owner: false, admin: false, group: false, pm: false, ...access },
  disabledGlobal: false,
  disabledGroups: [],
  perm: { name, delegable: true, lockReason: null, everywhere: null, groups: 0 },
  ...over,
});
const locked = (name, lockReason = "code") => command(name, { owner: true }, { perm: { name, delegable: false, lockReason, everywhere: null, groups: 0 } });
const names = (list) => list.map((c) => c.name);

let L;
before(async () => {
  L = await load("permissions-logic.mjs");
});

// ---------------------------------------------------------------------------
// T016: typed numbers, identity, draft
// ---------------------------------------------------------------------------

describe("constants", () => {
  test("the values of panel-ui.md section 4", () => {
    assert.deepEqual({ ...L.MODES }, { EXTRA: "extra", ONLY: "only" });
    assert.ok(Object.isFrozen(L.MODES));
    assert.equal(L.GLOBAL_SCOPE, "*");
    assert.equal(L.PEOPLE_MAX, 100);
    assert.equal(L.PEOPLE_PREVIEW, 6);
    assert.deepEqual([...L.LOCK_REASONS], ["code", "update", "data", "lockout", "config"]);
    assert.equal(L.PHONE_MIN, 8);
    assert.equal(L.PHONE_MAX, 15);
  });
});

describe("parseNumber", () => {
  test("separators and a leading 00 are ignored: three spellings, one JID", () => {
    const results = ["+237 690-000-001", "00237690000001", "(237) 690.000.001", "237690000001", "  +237690000001  "].map((input) => L.parseNumber(input));
    for (const result of results) {
      assert.equal(result.ok, true);
      assert.equal(result.jid, A);
      assert.equal(result.digits, "237690000001");
    }
    assert.ok(results[0].jid.endsWith("@s.whatsapp.net"));
  });

  test("8 to 15 digits: the boundaries pass, 7 and 16 are invalid_phone", () => {
    assert.equal(L.parseNumber("12345678").ok, true);
    assert.equal(L.parseNumber("123456789012345").ok, true);
    assert.deepEqual(L.parseNumber("1234567"), { ok: false, error: { code: "invalid_phone" } });
    assert.deepEqual(L.parseNumber("1234567890123456"), { ok: false, error: { code: "invalid_phone" } });
    assert.deepEqual(L.parseNumber("+1 234 56"), { ok: false, error: { code: "invalid_phone" } });
  });

  test("the 00 prefix is stripped before counting; a lone 00 or + is invalid", () => {
    assert.equal(L.parseNumber("0012345678").ok, true, "00 + 8 digits");
    assert.equal(L.parseNumber("001234567").ok, false, "00 + 7 digits");
    assert.equal(L.parseNumber("00").error.code, "invalid_phone");
    assert.equal(L.parseNumber("+").error.code, "invalid_phone");
  });

  test("letters and other characters are invalid_phone", () => {
    for (const input of ["abc", "237abc690", "+237 690 00O 001", "237_690_000_001", "237690000001@s.whatsapp.net", "237,690,000,001"]) {
      assert.deepEqual(L.parseNumber(input), { ok: false, error: { code: "invalid_phone" } }, input);
    }
  });

  test("empty and blank input is required", () => {
    for (const input of ["", "   ", "\t\n", undefined, null]) assert.deepEqual(L.parseNumber(input), { ok: false, error: { code: "required" } }, JSON.stringify(input));
  });

  test("a national number (first digit 0) is invalid_phone: no country code", () => {
    assert.deepEqual(L.parseNumber("0690000001"), { ok: false, error: { code: "invalid_phone" } });
    assert.deepEqual(L.parseNumber("0 690 00 00 01"), { ok: false, error: { code: "invalid_phone" } });
    assert.deepEqual(L.parseNumber("00 0690000001"), { ok: false, error: { code: "invalid_phone" } }, "00 then a 0");
  });
});

describe("personKey and personLabel", () => {
  test("device suffix, case and @c.us are folded; the rest is trimmed and lower-cased", () => {
    assert.equal(L.personKey("237690000001:7@s.whatsapp.net"), A);
    assert.equal(L.personKey("237690000001@S.WhatsApp.NET"), A);
    assert.equal(L.personKey("237690000001@c.us"), A);
    assert.equal(L.personKey("237690000001:12@c.us"), A);
    assert.equal(L.personKey("123456789012345:3@lid"), "123456789012345@lid");
    assert.equal(L.personKey("  237690000001@s.whatsapp.net  "), A);
    assert.equal(L.personKey("  ABC "), "abc");
  });

  test("a non-string never throws and gives an empty key", () => {
    for (const value of [undefined, null, 237690000001, {}, [], true]) assert.equal(L.personKey(value), "", JSON.stringify(value));
  });

  test("personLabel: the number always, the name only when known", () => {
    assert.deepEqual(L.personLabel({ jid: A, name: "Marie" }), { name: "Marie", number: "+237690000001" });
    assert.deepEqual(L.personLabel({ jid: A, name: null }), { name: null, number: "+237690000001" });
    assert.deepEqual(L.personLabel({ jid: A }), { name: null, number: "+237690000001" });
    assert.deepEqual(L.personLabel({ jid: "237690000001:7@s.whatsapp.net", name: "" }), { name: null, number: "+237690000001" });
    assert.deepEqual(L.personLabel({ jid: "123456789012345@lid", name: null }), { name: null, number: "@123456789012345" });
  });
});

describe("the draft: draftOf, setMode, addPerson, removePerson, togglePerson", () => {
  test("draftOf: a saved rule gives its mode and a sorted copy of its people; null is a new rule", () => {
    const saved = rule("only", [C, A, B]);
    const draft = L.draftOf(saved);
    assert.equal(draft.mode, "only");
    assert.deepEqual(draft.people.map((p) => p.jid), [A, B, C]);
    assert.notEqual(draft.people, saved.people, "a copy");
    assert.deepEqual(saved.people.map((p) => p.jid), [C, A, B], "the saved rule is not sorted in place");
    assert.deepEqual(L.draftOf(null), { mode: "extra", people: [] });
    assert.deepEqual(L.draftOf(undefined), { mode: "extra", people: [] });
  });

  test("draftOf: one entry per person", () => {
    const draft = L.draftOf(rule("extra", [A, "237690000001:7@s.whatsapp.net", B]));
    assert.equal(draft.people.length, 2);
  });

  test("setMode: the same object when nothing changes or the mode is unknown", () => {
    const draft = L.draftOf(null);
    assert.equal(L.setMode(draft, "extra"), draft);
    assert.equal(L.setMode(draft, "everybody"), draft);
    assert.equal(L.setMode(draft, undefined), draft);
    const only = L.setMode(draft, "only");
    assert.notEqual(only, draft);
    assert.equal(only.mode, "only");
    assert.equal(draft.mode, "extra", "no mutation");
  });

  test("addPerson inserts in personKey order and does not mutate", () => {
    const empty = L.draftOf(null);
    const first = L.addPerson(empty, person(B));
    assert.equal(first.error, null);
    assert.deepEqual(empty.people, []);
    const second = L.addPerson(first.draft, person(A, { name: "Marie" }));
    assert.deepEqual(second.draft.people.map((p) => p.jid), [A, B]);
    const third = L.addPerson(second.draft, person(C));
    assert.deepEqual(third.draft.people.map((p) => p.jid), [A, B, C]);
    assert.equal(third.draft.people[0].name, "Marie", "the person object is kept as given");
  });

  test("addPerson: a duplicate (a typed PN against a chip with a device suffix) is refused with the same object", () => {
    const base = L.addPerson(L.draftOf(null), person("237690000001:7@s.whatsapp.net")).draft;
    for (const jid of [A, "237690000001@c.us", "237690000001:3@s.whatsapp.net", "237690000001@S.WHATSAPP.NET"]) {
      const result = L.addPerson(base, person(jid));
      assert.deepEqual(result.error, { code: "duplicate" }, jid);
      assert.equal(result.draft, base, "the same object");
    }
  });

  test("addPerson: the cap gives too_many_items with params.max; the default cap is 100", () => {
    const full = { mode: "extra", people: [person(A), person(B)] };
    const refused = L.addPerson(full, person(C), { max: 2 });
    assert.deepEqual(refused.error, { code: "too_many_items", params: { max: 2 } });
    assert.equal(refused.draft, full);
    assert.equal(L.addPerson(full, person(C), { max: 3 }).error, null);

    let draft = L.draftOf(null);
    for (let i = 0; i < L.PEOPLE_MAX; i += 1) draft = L.addPerson(draft, person(pn(String(237000000000 + i)))).draft;
    assert.equal(draft.people.length, 100);
    const over = L.addPerson(draft, person(pn("237999999999")));
    assert.deepEqual(over.error, { code: "too_many_items", params: { max: 100 } });
    assert.equal(over.draft, draft);
    assert.deepEqual(L.addPerson(draft, person(pn("237000000005"))).error, { code: "duplicate" }, "a duplicate is reported before the cap");
  });

  test("addPerson refuses a person without a usable jid", () => {
    const draft = L.draftOf(null);
    for (const bad of [null, undefined, {}, { jid: "" }, { jid: 5 }]) {
      const result = L.addPerson(draft, bad);
      assert.equal(result.draft, draft);
      assert.ok(result.error && typeof result.error.code === "string");
    }
  });

  test("removePerson: by personKey, the same object when absent", () => {
    const draft = L.draftOf(rule("extra", [A, B]));
    const removed = L.removePerson(draft, "237690000001:9@c.us");
    assert.deepEqual(removed.people.map((p) => p.jid), [B]);
    assert.equal(draft.people.length, 2, "no mutation");
    assert.equal(L.removePerson(draft, C), draft);
    assert.equal(L.hasPerson(draft, "237690000002:4@s.whatsapp.net"), true);
    assert.equal(L.hasPerson(draft, C), false);
  });

  test("togglePerson removes a present person (even at the cap) and adds an absent one", () => {
    const draft = L.draftOf(rule("extra", [A, B]));
    const off = L.togglePerson(draft, person("237690000001:2@s.whatsapp.net"), { max: 2 });
    assert.equal(off.error, null);
    assert.deepEqual(off.draft.people.map((p) => p.jid), [B]);
    const on = L.togglePerson(off.draft, person(C), { max: 2 });
    assert.equal(on.error, null);
    assert.deepEqual(on.draft.people.map((p) => p.jid), [B, C]);
    const refused = L.togglePerson(on.draft, person(A), { max: 2 });
    assert.deepEqual(refused.error, { code: "too_many_items", params: { max: 2 } });
    assert.equal(refused.draft, on.draft);
  });
});

describe("diffPeople, isDirty, pendingCount", () => {
  const saved = rule("extra", [A, B]);

  test("a fresh draft of a saved rule is clean", () => {
    const draft = L.draftOf(saved);
    assert.deepEqual(L.diffPeople(saved, draft), { added: [], removed: [] });
    assert.equal(L.isDirty(saved, draft), false);
    assert.equal(L.pendingCount(saved, draft), 0);
  });

  test("added and removed are set-based; the jids are the draft's (added) and the saved rule's (removed)", () => {
    const draft = L.removePerson(L.addPerson(L.draftOf(saved), person(C)).draft, A);
    assert.deepEqual(L.diffPeople(saved, draft), { added: [C], removed: [A] });
    assert.equal(L.isDirty(saved, draft), true);
    assert.equal(L.pendingCount(saved, draft), 2);
  });

  test("add then remove the same person is clean; the same person under another spelling is not a change", () => {
    const back = L.removePerson(L.addPerson(L.draftOf(saved), person(C)).draft, C);
    assert.equal(L.isDirty(saved, back), false);
    const spelled = { mode: "extra", people: [person("237690000001:7@c.us"), person(B)] };
    assert.deepEqual(L.diffPeople(saved, spelled), { added: [], removed: [] });
    assert.equal(L.isDirty(saved, spelled), false);
    // removing a person then typing the same number again
    const again = L.addPerson(L.removePerson(L.draftOf(saved), A), person(A)).draft;
    assert.equal(L.isDirty(saved, again), false);
  });

  test("a mode change alone is dirty and counts one", () => {
    const draft = L.setMode(L.draftOf(saved), "only");
    assert.deepEqual(L.diffPeople(saved, draft), { added: [], removed: [] });
    assert.equal(L.isDirty(saved, draft), true);
    assert.equal(L.pendingCount(saved, draft), 1);
  });

  test("pendingCount adds people added, people removed and the mode", () => {
    const draft = L.setMode(L.removePerson(L.addPerson(L.draftOf(saved), person(C)).draft, B), "only");
    assert.equal(L.pendingCount(saved, draft), 3);
  });

  test("saved === null: an untouched new-rule draft is clean", () => {
    const fresh = L.draftOf(null);
    assert.deepEqual(L.diffPeople(null, fresh), { added: [], removed: [] });
    assert.equal(L.isDirty(null, fresh), false);
    assert.equal(L.pendingCount(null, fresh), 0);
  });

  test("saved === null: a person or a mode other than extra makes it dirty", () => {
    const withPerson = L.addPerson(L.draftOf(null), person(A)).draft;
    assert.deepEqual(L.diffPeople(null, withPerson), { added: [A], removed: [] });
    assert.equal(L.isDirty(null, withPerson), true);
    assert.equal(L.pendingCount(null, withPerson), 1);
    const only = L.setMode(L.draftOf(null), "only");
    assert.equal(L.isDirty(null, only), true);
    assert.equal(L.pendingCount(null, only), 1);
    assert.equal(L.pendingCount(null, L.setMode(withPerson, "only")), 2);
    assert.equal(L.isDirty(null, L.setMode(only, "extra")), false, "back to the defaults");
  });
});

describe("canSave and ruleBody", () => {
  test("extra with nobody is refused for the everywhere scope (people_required)", () => {
    assert.deepEqual(L.canSave(L.draftOf(null), null, { scope: "*" }), { ok: false, reason: "people_required" });
    const saved = rule("extra", [A], { scope: "*" });
    const emptied = L.removePerson(L.draftOf(saved), A);
    assert.deepEqual(L.canSave(emptied, saved, { scope: "*" }), { ok: false, reason: "people_required" });
  });

  test("extra with nobody is allowed for a group (normal level here, U3)", () => {
    assert.deepEqual(L.canSave(L.draftOf(null), null, { scope: GROUP }), { ok: true, reason: null }, "a brand-new group rule left at its defaults");
    const saved = rule("extra", [A]);
    assert.deepEqual(L.canSave(L.removePerson(L.draftOf(saved), A), saved, { scope: GROUP }), { ok: true, reason: null });
  });

  test("only with nobody is allowed for both scopes", () => {
    const only = L.setMode(L.draftOf(null), "only");
    assert.deepEqual(L.canSave(only, null, { scope: "*" }), { ok: true, reason: null });
    assert.deepEqual(L.canSave(only, null, { scope: GROUP }), { ok: true, reason: null });
  });

  test("an unchanged saved rule is refused as unchanged; a change is allowed", () => {
    const saved = rule("only", [A, B]);
    assert.deepEqual(L.canSave(L.draftOf(saved), saved, { scope: GROUP }), { ok: false, reason: "unchanged" });
    assert.deepEqual(L.canSave(L.draftOf(saved), saved, { scope: "*" }), { ok: false, reason: "unchanged" });
    assert.deepEqual(L.canSave(L.setMode(L.draftOf(saved), "extra"), saved, { scope: "*" }), { ok: true, reason: null });
    assert.deepEqual(L.canSave(L.addPerson(L.draftOf(saved), person(C)).draft, saved, { scope: GROUP }), { ok: true, reason: null });
  });

  test("a new rule with a person is allowed", () => {
    const draft = L.addPerson(L.draftOf(null), person(A)).draft;
    assert.deepEqual(L.canSave(draft, null, { scope: "*" }), { ok: true, reason: null });
  });

  test("ruleBody: only mode and jid strings, de-duplicated by personKey, sorted, stable", () => {
    const messy = {
      mode: "only",
      people: [person(C, { name: "Zed", present: true, admin: "admin" }), person("237690000001:7@s.whatsapp.net", { name: "Ann" }), person(B), person(A), person("237690000002@c.us")],
    };
    const body = L.ruleBody(messy);
    assert.deepEqual(Object.keys(body), ["mode", "people"]);
    assert.equal(body.mode, "only");
    assert.ok(body.people.every((jid) => typeof jid === "string"));
    assert.deepEqual(body.people.map(L.personKey), [A, B, C]);
    assert.deepEqual(L.ruleBody(messy), body, "stable");
    const reversed = L.ruleBody({ mode: "only", people: [...messy.people].reverse() });
    assert.deepEqual(reversed.people.map(L.personKey), [A, B, C], "the order of the draft does not matter");
    assert.deepEqual(L.ruleBody({ mode: "extra", people: [] }), { mode: "extra", people: [] });
  });
});

// ---------------------------------------------------------------------------
// T017: warnings, badges, display
// ---------------------------------------------------------------------------

const KICK = command("kick", { admin: true });
const KICK_GROUP = command("kick", { admin: true, group: true }); // a command that only works in groups
const VV = command("vv");
const BAN = command("ban", { owner: true });
const draftOf = (mode, people) => ({ mode, people: people.map((p) => (typeof p === "string" ? person(p) : p)) });
const warn = (command, draft, scope, extra = {}) => L.computeWarnings({ command, draft, scope, ...extra });
const W = (code, tone, params = {}) => ({ code, tone, params });

describe("computeWarnings: the table of panel-ui.md section 10, row by row", () => {
  test("opens_admin_command (group): counts every person whose admin is not admin/superadmin", () => {
    const people = [
      person(A, { present: true, admin: "admin" }),
      person(B, { present: true, admin: "superadmin" }),
      person(C, { present: true, admin: null }),
      person(pn("237690000004"), { present: null, admin: null }),
      person(pn("237690000005"), { present: false, admin: null }),
      person(pn("237690000006")),
    ];
    for (const mode of ["extra", "only"]) {
      assert.deepEqual(warn(KICK, draftOf(mode, people), GROUP), [W("opens_admin_command", "warn", { count: 4, everywhere: false })], mode);
    }
  });

  test("opens_admin_command (group): none when everyone is a known admin, none for an empty list", () => {
    const admins = [person(A, { present: true, admin: "admin" }), person(B, { present: true, admin: "superadmin" })];
    assert.deepEqual(warn(KICK, draftOf("extra", admins), GROUP), []);
    assert.deepEqual(warn(KICK, draftOf("only", admins), GROUP), []);
    assert.deepEqual(warn(KICK, draftOf("only", []), GROUP).map((w) => w.code), ["empty_only"], "no list, no admin warning");
  });

  test("opens_admin_command (everywhere): count = number of people, everywhere: true, whatever their status", () => {
    const people = [person(A), person(B, { present: true, admin: "admin" })];
    for (const mode of ["extra", "only"]) {
      assert.deepEqual(warn(KICK, draftOf(mode, people), "*"), [W("opens_admin_command", "warn", { count: 2, everywhere: true })], mode);
    }
    assert.deepEqual(warn(KICK, draftOf("extra", [person(A)]), "*"), [W("opens_admin_command", "warn", { count: 1, everywhere: true })]);
  });

  test("opens_admin_command needs an admin command", () => {
    assert.deepEqual(warn(VV, draftOf("only", [person(A)]), "*"), []);
    assert.deepEqual(warn(VV, draftOf("only", [person(A)]), GROUP), []);
    assert.deepEqual(warn(BAN, draftOf("only", [person(A)]), GROUP), []);
  });

  test("extra_on_public: mode extra, at least one person, a command that is neither owner nor admin", () => {
    assert.deepEqual(warn(VV, draftOf("extra", [person(A)]), GROUP), [W("extra_on_public", "warn")]);
    assert.deepEqual(warn(VV, draftOf("extra", [person(A)]), "*"), [W("extra_on_public", "warn")]);
    assert.deepEqual(warn(VV, draftOf("only", [person(A)]), GROUP), [], "only restricts: not a no-op");
    assert.deepEqual(warn(BAN, draftOf("extra", [person(A)]), GROUP), [], "an owner command is not public");
    assert.deepEqual(warn(KICK, draftOf("extra", [person(A, { present: true, admin: "admin" })]), GROUP), [], "an admin command is not public");
  });

  test("an empty group extra rule on a public command gives normal_here alone", () => {
    assert.deepEqual(warn(VV, draftOf("extra", []), GROUP), [W("normal_here", "warn")]);
    assert.deepEqual(warn(VV, draftOf("extra", []), GROUP, { hasEverywhereOnly: true }), [W("normal_here", "info")]);
  });

  test("empty_only: mode only, nobody (both scopes)", () => {
    assert.deepEqual(warn(VV, draftOf("only", []), "*"), [W("empty_only", "warn")]);
    assert.deepEqual(warn(VV, draftOf("only", []), GROUP), [W("empty_only", "warn")]);
    assert.deepEqual(warn(KICK, draftOf("only", []), GROUP), [W("empty_only", "warn")]);
  });

  test("normal_here: group scope, extra, nobody; info when an everywhere only rule exists, else warn", () => {
    for (const command of [VV, KICK, BAN]) {
      assert.deepEqual(warn(command, draftOf("extra", []), GROUP), [W("normal_here", "warn")], command.name);
      assert.deepEqual(warn(command, draftOf("extra", []), GROUP, { hasEverywhereOnly: true }), [W("normal_here", "info")], command.name);
    }
    assert.deepEqual(warn(VV, draftOf("extra", []), "*", { hasEverywhereOnly: true }), [], "not for the everywhere scope");
    assert.deepEqual(warn(VV, draftOf("extra", [person(A)]), GROUP, { hasEverywhereOnly: true }).map((w) => w.code), ["extra_on_public"], "not with people");
    assert.deepEqual(warn(VV, draftOf("only", []), GROUP, { hasEverywhereOnly: true }).map((w) => w.code), ["empty_only"], "not in only mode");
  });

  test("disabled_here: global and group", () => {
    assert.deepEqual(warn(VV, draftOf("only", [person(A)]), GROUP, { disabled: "global" }), [W("disabled_here", "info", { where: "global" })]);
    assert.deepEqual(warn(VV, draftOf("only", [person(A)]), "*", { disabled: "group" }), [W("disabled_here", "info", { where: "group" })]);
    assert.deepEqual(warn(VV, draftOf("only", [person(A)]), GROUP, { disabled: null }), []);
    assert.deepEqual(warn(VV, draftOf("only", [person(A)]), GROUP, { disabled: "elsewhere" }), [], "an unknown value is ignored");
  });

  test("context_only: pm for any scope, group only for the everywhere scope", () => {
    const pmOnly = command("pmcmd", { pm: true });
    const groupOnly = command("grpcmd", { group: true });
    assert.deepEqual(warn(pmOnly, draftOf("only", [person(A)]), "*"), [W("context_only", "info", { context: "pm" })]);
    assert.deepEqual(warn(pmOnly, draftOf("only", [person(A)]), GROUP), [W("context_only", "info", { context: "pm" })]);
    assert.deepEqual(warn(groupOnly, draftOf("only", [person(A)]), "*"), [W("context_only", "info", { context: "group" })]);
    assert.deepEqual(warn(groupOnly, draftOf("only", [person(A)]), GROUP), [], "a group rule is in a group already");
  });

  test("warnings come before information, in the order of the table", () => {
    const both = warn(KICK_GROUP, draftOf("extra", [person(A)]), "*", { disabled: "global" });
    assert.deepEqual(both, [
      W("opens_admin_command", "warn", { count: 1, everywhere: true }),
      W("disabled_here", "info", { where: "global" }),
      W("context_only", "info", { context: "group" }),
    ]);
    const mixed = warn(VV, draftOf("extra", []), GROUP, { disabled: "group", hasEverywhereOnly: true });
    assert.deepEqual(mixed.map((w) => w.code), ["normal_here", "disabled_here"]);
    const tones = both.map((w) => w.tone);
    assert.deepEqual(tones, [...tones].sort((a, b) => (a === b ? 0 : a === "warn" ? -1 : 1)), "warn first");
  });

  test("a pure function: no mutation of its inputs, a missing access is read as public", () => {
    const draft = draftOf("extra", [person(A)]);
    const copy = JSON.stringify(draft);
    const cmd = command("x");
    const before = JSON.stringify(cmd);
    warn(cmd, draft, GROUP);
    assert.equal(JSON.stringify(draft), copy);
    assert.equal(JSON.stringify(cmd), before);
    assert.deepEqual(L.computeWarnings({ command: { name: "bare" }, draft, scope: GROUP }), [W("extra_on_public", "warn")]);
  });
});

describe("computeWarnings against the server (API contract 1.5): the same objects", () => {
  const SERVER_CODES = ["opens_admin_command", "extra_on_public", "empty_only", "normal_here"];
  // [what the server returns for this rule, by the table of 1.5, written by hand]
  const FIXTURES = [
    { name: "kick for a non-admin member of a group", command: KICK, scope: GROUP, mode: "extra", people: [person(A, { present: true, admin: null })], server: [W("opens_admin_command", "warn", { count: 1, everywhere: false })] },
    { name: "kick, one admin and one stranger", command: KICK, scope: GROUP, mode: "only", people: [person(A, { present: true, admin: "admin" }), person(B, { present: false, admin: null })], server: [W("opens_admin_command", "warn", { count: 1, everywhere: false })] },
    { name: "kick everywhere", command: KICK, scope: "*", mode: "extra", people: [person(A), person(B)], server: [W("opens_admin_command", "warn", { count: 2, everywhere: true })] },
    { name: "kick for admins only", command: KICK, scope: GROUP, mode: "extra", people: [person(A, { present: true, admin: "superadmin" })], server: [] },
    { name: "a public command extended", command: VV, scope: "*", mode: "extra", people: [person(A)], server: [W("extra_on_public", "warn")] },
    { name: "a public command restricted", command: VV, scope: "*", mode: "only", people: [person(A)], server: [] },
    { name: "only with nobody", command: VV, scope: GROUP, mode: "only", people: [], server: [W("empty_only", "warn")] },
    { name: "empty group extra, no everywhere only rule", command: VV, scope: GROUP, mode: "extra", people: [], server: [W("normal_here", "warn")] },
    { name: "empty group extra on a public command, with an everywhere only rule", command: VV, scope: GROUP, mode: "extra", people: [], hasEverywhereOnly: true, server: [W("normal_here", "info")] },
    { name: "empty group extra on an admin command", command: KICK, scope: GROUP, mode: "extra", people: [], hasEverywhereOnly: true, server: [W("normal_here", "info")] },
  ];

  for (const fixture of FIXTURES) {
    test(fixture.name, () => {
      const live = L.computeWarnings({ command: fixture.command, draft: draftOf(fixture.mode, fixture.people), scope: fixture.scope, hasEverywhereOnly: Boolean(fixture.hasEverywhereOnly) });
      assert.deepEqual(live.filter((w) => SERVER_CODES.includes(w.code)), fixture.server);
      assert.deepEqual(L.normalizeWarnings(fixture.server), fixture.server, "the server objects survive normalizeWarnings unchanged");
    });
  }

  test("the example of the API contract (PERM-6 answer) is what computeWarnings returns for the same rule", { skip: !fs.existsSync(API_CONTRACT) }, () => {
    const md = fs.readFileSync(API_CONTRACT, "utf8");
    const block = [...md.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]).find((text) => text.includes('"warnings"'));
    assert.ok(block, "the contract carries a rule example with warnings");
    const example = JSON.parse(block).rule;
    const live = L.computeWarnings({ command: KICK, draft: { mode: example.mode, people: example.people }, scope: example.scope });
    assert.deepEqual(live, example.warnings);
  });
});

describe("normalizeWarnings", () => {
  test("keeps the four server codes, defaults tone and params, drops everything else", () => {
    const out = L.normalizeWarnings([
      W("empty_only", "warn"),
      W("opens_admin_command", "warn", { count: 3, everywhere: false }),
      { code: "mystery", tone: "warn", params: {} },
      { code: "normal_here" },
      { code: "extra_on_public", tone: "loud", params: "x" },
      { code: "empty_only", tone: "info", params: [1, 2] },
      { code: "disabled_here", tone: "info", params: { where: "global" } },
      { tone: "info" },
      "empty_only",
      null,
      5,
    ]);
    assert.deepEqual(out, [
      W("empty_only", "warn"),
      W("opens_admin_command", "warn", { count: 3, everywhere: false }),
      W("normal_here", "warn"),
      W("extra_on_public", "warn"),
      W("empty_only", "info"),
    ]);
  });

  test("not an array gives an empty list; the input is not mutated or shared", () => {
    for (const value of [undefined, null, "x", 5, {}]) assert.deepEqual(L.normalizeWarnings(value), []);
    const input = [W("opens_admin_command", "warn", { count: 1, everywhere: false })];
    const out = L.normalizeWarnings(input);
    assert.notEqual(out[0], input[0]);
    assert.notEqual(out[0].params, input[0].params);
    out[0].params.count = 99;
    assert.equal(input[0].params.count, 1);
  });
});

describe("warningTextKey, warningBadges and their keys", () => {
  const TEXT_CASES = [
    [W("opens_admin_command", "warn", { count: 3, everywhere: false }), "permissions.warn_opens_admin_command"],
    [W("opens_admin_command", "warn", { count: 1, everywhere: false }), "permissions.warn_opens_admin_command"],
    [W("opens_admin_command", "warn", { count: 2, everywhere: true }), "permissions.warn_opens_admin_command_everywhere"],
    [W("extra_on_public", "warn"), "permissions.warn_extra_on_public"],
    [W("empty_only", "warn"), "permissions.warn_empty_only"],
    [W("normal_here", "info"), "permissions.info_normal_here"],
    [W("normal_here", "warn"), "permissions.warn_normal_here"],
    [W("disabled_here", "info", { where: "global" }), "permissions.info_disabled_here_global"],
    [W("disabled_here", "info", { where: "group" }), "permissions.info_disabled_here_group"],
    [W("context_only", "info", { context: "pm" }), "permissions.info_context_only_pm"],
    [W("context_only", "info", { context: "group" }), "permissions.info_context_only_group"],
  ];

  test("warningTextKey: every code and variant", () => {
    for (const [warning, key] of TEXT_CASES) assert.equal(L.warningTextKey(warning), key, JSON.stringify(warning));
    for (const bad of [W("mystery", "warn"), null, undefined, {}, "empty_only"]) assert.equal(L.warningTextKey(bad), null, JSON.stringify(bad));
  });

  test("warningBadges: the four server codes, normal_here by tone, nothing for the information-only codes", () => {
    const badges = L.warningBadges([
      W("opens_admin_command", "warn", { count: 1, everywhere: false }),
      W("extra_on_public", "warn"),
      W("empty_only", "warn"),
      W("normal_here", "info"),
      W("normal_here", "warn"),
      W("disabled_here", "info", { where: "global" }),
      W("context_only", "info", { context: "pm" }),
    ]);
    assert.deepEqual(badges, [
      { code: "opens_admin_command", tone: "warn", key: "permissions.badge_opens_admin_command" },
      { code: "extra_on_public", tone: "warn", key: "permissions.badge_extra_on_public" },
      { code: "empty_only", tone: "warn", key: "permissions.badge_empty_only" },
      { code: "normal_here", tone: "info", key: "permissions.badge_normal_here" },
      { code: "normal_here", tone: "warn", key: "permissions.badge_normal_here_noop" },
    ]);
    assert.deepEqual(L.warningBadges([]), []);
    assert.deepEqual(L.warningBadges(undefined), []);
  });

  test("every key warningTextKey and warningBadges return exists in the en and fr catalogs", () => {
    for (const [warning] of TEXT_CASES) assertInCatalogs(L.warningTextKey(warning), "text key");
    const all = TEXT_CASES.map(([warning]) => warning);
    for (const badge of L.warningBadges(all)) assertInCatalogs(badge.key, "badge key");
    // the singular forms of the texts that take a count
    assertInCatalogs("permissions.warn_opens_admin_command_one", "plural form");
  });

  test("the plural forms keep the {count} placeholder", () => {
    for (const lang of ["en", "fr"]) {
      const catalog = CATALOGS[lang];
      for (const key of Object.keys(catalog).filter((k) => k.startsWith("permissions.") && k.endsWith("_one"))) {
        assert.match(catalog[key], /\{count\}/, `${key} (${lang})`);
        const base = key.slice(0, -"_one".length);
        assert.equal(typeof catalog[base], "string", `${base} (${lang}) next to ${key}`);
      }
    }
  });
});

describe("personBadges", () => {
  test("former: present === false (neutral), whatever else is known", () => {
    assert.deepEqual(L.personBadges({ jid: A, present: false, admin: null }, { adminCommand: true }), [{ id: "former", tone: "neutral" }]);
    assert.deepEqual(L.personBadges({ jid: A, present: false }, { adminCommand: false }), [{ id: "former", tone: "neutral" }]);
  });

  test("admin: info for admin and superadmin", () => {
    assert.deepEqual(L.personBadges({ jid: A, present: true, admin: "admin" }, { adminCommand: true }), [{ id: "admin", tone: "info" }]);
    assert.deepEqual(L.personBadges({ jid: A, present: true, admin: "superadmin" }, { adminCommand: false }), [{ id: "admin", tone: "info" }]);
  });

  test("not_admin: only for an admin command and a person known to be in the group", () => {
    assert.deepEqual(L.personBadges({ jid: A, present: true, admin: null }, { adminCommand: true }), [{ id: "not_admin", tone: "warn" }]);
    assert.deepEqual(L.personBadges({ jid: A, present: true, admin: null }, { adminCommand: false }), []);
    assert.deepEqual(L.personBadges({ jid: A, present: true, admin: null }), []);
  });

  test("present null or missing shows nothing (unknown is not shown as a fact)", () => {
    assert.deepEqual(L.personBadges({ jid: A, present: null, admin: null }, { adminCommand: true }), []);
    assert.deepEqual(L.personBadges({ jid: A }, { adminCommand: true }), []);
    assert.deepEqual(L.personBadges({ jid: A, name: "x" }, { adminCommand: false }), []);
  });
});

describe("effectiveMode (FR-006 step 4)", () => {
  const group = (mode, people = [A]) => rule(mode, people);
  const everywhere = (mode, people = [B]) => rule(mode, people, { scope: "*" });

  test("a group rule wins, even with an empty list", () => {
    assert.deepEqual(L.effectiveMode(group("extra"), null), { mode: "extra", source: "group" });
    assert.deepEqual(L.effectiveMode(group("only"), everywhere("extra")), { mode: "only", source: "group" });
    assert.deepEqual(L.effectiveMode(group("extra", []), everywhere("only")), { mode: "extra", source: "group" });
    assert.deepEqual(L.effectiveMode(group("only", []), everywhere("extra")), { mode: "only", source: "group" });
  });

  test("else the everywhere rule", () => {
    assert.deepEqual(L.effectiveMode(null, everywhere("only")), { mode: "only", source: "everywhere" });
    assert.deepEqual(L.effectiveMode(undefined, everywhere("extra")), { mode: "extra", source: "everywhere" });
  });

  test("else normal", () => {
    assert.deepEqual(L.effectiveMode(null, null), { mode: "normal", source: "none" });
    assert.deepEqual(L.effectiveMode(undefined, undefined), { mode: "normal", source: "none" });
  });
});

describe("commands, levels and locks", () => {
  test("lockReasonKey: the five codes, anything else is the fallback", () => {
    for (const code of ["code", "update", "data", "lockout", "config"]) {
      assert.equal(L.lockReasonKey(code), `permissions.reason_${code}`);
      assertInCatalogs(L.lockReasonKey(code), "lock reason");
    }
    for (const bad of ["whatever", "", null, undefined, 5, "constructor", "CODE"]) assert.equal(L.lockReasonKey(bad), "permissions.reason_unknown", JSON.stringify(bad));
    assert.equal(L.lockReasonKey(), "permissions.reason_unknown");
    assertInCatalogs("permissions.reason_unknown", "lock reason");
  });

  test("isLocked and isDelegable: a missing perm is neither", () => {
    assert.equal(L.isLocked(command("a")), false);
    assert.equal(L.isDelegable(command("a")), true);
    assert.equal(L.isLocked(locked("b")), true);
    assert.equal(L.isDelegable(locked("b")), false);
    const unknown = command("c", {}, { perm: null });
    assert.equal(L.isLocked(unknown), false);
    assert.equal(L.isDelegable(unknown), false);
    const bare = { name: "d" };
    assert.equal(L.isLocked(bare), false);
    assert.equal(L.isDelegable(bare), false);
  });

  test("mergePermissions: by name, perm null for a command without an item, no mutation", () => {
    const commands = [{ name: "b", access: {} }, { name: "a", access: {} }, { name: "c", access: {} }];
    const items = [{ name: "a", delegable: true, lockReason: null, everywhere: null, groups: 0 }, { name: "c", delegable: false, lockReason: "code", everywhere: null, groups: 0 }, { name: "ghost", delegable: true }];
    const merged = L.mergePermissions(commands, items);
    assert.deepEqual(names(merged), ["b", "a", "c"], "the order of the commands is kept");
    assert.equal(merged[0].perm, null);
    assert.equal(merged[1].perm, items[0]);
    assert.equal(merged[2].perm, items[1]);
    assert.deepEqual(merged[1].access, {}, "other fields untouched");
    assert.equal("perm" in commands[0], false, "the input command is not mutated");
    assert.notEqual(merged[0], commands[0]);
    assert.deepEqual(names(L.mergePermissions(commands, undefined)), ["b", "a", "c"]);
    assert.ok(L.mergePermissions(commands, null).every((c) => c.perm === null));
    assert.deepEqual(L.mergePermissions(undefined, items), []);
  });

  test("isPublic and normalLevel", () => {
    assert.equal(L.isPublic({ owner: false, admin: false, group: true, pm: false }), true);
    assert.equal(L.isPublic({}), true);
    assert.equal(L.isPublic(undefined), true);
    assert.equal(L.isPublic({ admin: true }), false);
    assert.equal(L.isPublic({ owner: true }), false);
    assert.equal(L.normalLevel({ owner: true, admin: true }), "owner", "owner wins over admin");
    assert.equal(L.normalLevel({ owner: true }), "owner");
    assert.equal(L.normalLevel({ admin: true }), "admin");
    assert.equal(L.normalLevel({ group: true }), "everyone");
    assert.equal(L.normalLevel(undefined), "everyone");
    for (const level of ["owner", "admin", "everyone"]) assertInCatalogs(`commands.access_${level}`, "level");
  });

  test("splitCommands: delegable without a rule, locked all, both sorted by name, perm null in neither", () => {
    const commands = [command("zeta"), command("alpha"), command("mid"), locked("lockedB", "update"), locked("lockedA"), command("nope", {}, { perm: null })];
    const split = L.splitCommands(commands, ["mid", "lockedA"]);
    assert.deepEqual(names(split.delegable), ["alpha", "zeta"], "a command that already has a rule is left out");
    assert.deepEqual(names(split.locked), ["lockedA", "lockedB"], "locked commands are all listed, with or without a rule");
    assert.deepEqual(names(L.splitCommands(commands, new Set(["alpha"])).delegable), ["mid", "zeta"], "a Set works too");
    assert.deepEqual(names(L.splitCommands(commands).delegable), ["alpha", "mid", "zeta"], "no names given");
    assert.deepEqual(L.splitCommands(undefined, undefined), { delegable: [], locked: [] });
  });

  test("commandCell: unavailable, locked, rule, none", () => {
    assert.deepEqual(L.commandCell(command("a", {}, { perm: null })), { kind: "unavailable" });
    assert.deepEqual(L.commandCell({ name: "bare" }), { kind: "unavailable" });
    assert.deepEqual(L.commandCell(locked("b", "data")), { kind: "locked", reasonKey: "permissions.reason_data" });
    assert.deepEqual(L.commandCell(locked("b", "weird")), { kind: "locked", reasonKey: "permissions.reason_unknown" });
    const withRule = command("c", {}, { perm: { name: "c", delegable: true, lockReason: null, everywhere: { mode: "only", count: 3 }, groups: 2 } });
    assert.deepEqual(L.commandCell(withRule), { kind: "rule", mode: "only", count: 3, groups: 2 });
    const none = command("d", {}, { perm: { name: "d", delegable: true, lockReason: null, everywhere: null, groups: 0 } });
    assert.deepEqual(L.commandCell(none), { kind: "none", mode: null, count: 0, groups: 0 });
    const noneButGroups = command("e", {}, { perm: { name: "e", delegable: true, lockReason: null, everywhere: null, groups: 4 } });
    assert.deepEqual(L.commandCell(noneButGroups), { kind: "none", mode: null, count: 0, groups: 4 });
  });
});

describe("the group tab: everywhereRows, groupOrphanRules, peopleSummary", () => {
  test("everywhereRows: loaded delegable commands only, sorted by name, with the effective mode per row", () => {
    const vv = command("vv");
    const dice = command("dice");
    const commands = [vv, dice, locked("eval"), command("plain")];
    const everywhere = [
      rule("only", [A], { command: "vv", scope: "*" }),
      rule("extra", [B], { command: "dice", scope: "*" }),
      rule("only", [C], { command: "eval", scope: "*" }),
      rule("only", [C], { command: "ghost", scope: "*" }),
    ];
    const groupRules = [rule("extra", [], { command: "dice" }), rule("only", [A], { command: "plain" })];
    const rows = L.everywhereRows(everywhere, groupRules, commands);
    assert.deepEqual(rows.map((r) => r.command.name), ["dice", "vv"]);
    assert.equal(rows[0].command, dice, "the Command object");
    assert.equal(rows[0].rule, everywhere[1]);
    assert.deepEqual(rows[0].effective, { mode: "extra", source: "group" }, "the group rule of that command wins even when empty");
    assert.deepEqual(rows[1].effective, { mode: "only", source: "everywhere" });
    assert.deepEqual(L.everywhereRows(undefined, undefined, commands), []);
    assert.deepEqual(L.everywhereRows(everywhere, [], []), [], "no loaded command, no row");
  });

  test("groupOrphanRules: by command, scopes with * first, an unknown reason read as unknown_command", () => {
    const orphans = [
      { command: "zz", scope: GROUP2, mode: "only", count: 2, reason: "unknown_command" },
      { command: "eval", scope: GROUP, mode: "extra", count: 1, reason: "not_delegable" },
      { command: "zz", scope: "*", mode: "extra", count: 0, reason: "unknown_command" },
      { command: "eval", scope: "*", mode: "only", count: 4, reason: "not_delegable" },
      { command: "weird", scope: "*", mode: "only", count: 1, reason: "???" },
      { command: "zz", scope: GROUP, mode: "only", count: 3, reason: "unknown_command" },
    ];
    assert.deepEqual(L.groupOrphanRules(orphans), [
      { command: "eval", reason: "not_delegable", scopes: [{ scope: "*", mode: "only", count: 4 }, { scope: GROUP, mode: "extra", count: 1 }] },
      { command: "weird", reason: "unknown_command", scopes: [{ scope: "*", mode: "only", count: 1 }] },
      { command: "zz", reason: "unknown_command", scopes: [{ scope: "*", mode: "extra", count: 0 }, { scope: GROUP, mode: "only", count: 3 }, { scope: GROUP2, mode: "only", count: 2 }] },
    ]);
    assert.deepEqual(L.groupOrphanRules([]), []);
    assert.deepEqual(L.groupOrphanRules(undefined), []);
    for (const reason of ["unknown_command", "not_delegable"]) assertInCatalogs(`permissions.orphan_${reason}`, "orphan reason");
  });

  test("peopleSummary: the first PEOPLE_PREVIEW people and how many are left", () => {
    const people = Array.from({ length: 9 }, (_, i) => person(pn(String(237690000100 + i))));
    const summary = L.peopleSummary(people);
    assert.equal(summary.shown.length, 6);
    assert.equal(summary.more, 3);
    assert.deepEqual(summary.shown.map((p) => p.jid), people.slice(0, 6).map((p) => p.jid));
    assert.deepEqual(L.peopleSummary(people, 2).more, 7);
    assert.deepEqual(L.peopleSummary(people.slice(0, 4)), { shown: people.slice(0, 4), more: 0 });
    assert.deepEqual(L.peopleSummary(undefined), { shown: [], more: 0 });
    assert.deepEqual(L.peopleSummary([]), { shown: [], more: 0 });
  });
});

describe("queries and links", () => {
  test("chatQuery: private chats, 50 per page, page only above 1, q trimmed and cut, never selectable", () => {
    assert.deepEqual(L.chatQuery(), { kind: "private", pageSize: 50 });
    assert.deepEqual(L.chatQuery({}), { kind: "private", pageSize: 50 });
    assert.deepEqual(L.chatQuery({ q: "", page: 1 }), { kind: "private", pageSize: 50 });
    assert.deepEqual(L.chatQuery({ page: 3 }), { kind: "private", pageSize: 50, page: 3 });
    assert.deepEqual(L.chatQuery({ q: "  marie  " }), { kind: "private", pageSize: 50, q: "marie" });
    assert.deepEqual(L.chatQuery({ q: "   " }), { kind: "private", pageSize: 50 });
    assert.equal(L.chatQuery({ q: "x".repeat(150) }).q.length, 100);
    assert.deepEqual(L.chatQuery({ pageSize: 20 }), { kind: "private", pageSize: 20 });
    for (const query of [L.chatQuery(), L.chatQuery({ q: "a", page: 2 })]) assert.equal("selectable" in query, false);
  });

  test("selectionFromQuery: the command by name or alias, only for panel=permissions, never a locked or unknown one", () => {
    const kick = command("kick", { admin: true }, { aliases: ["kick", "remove"] });
    const commands = [command("vv"), kick, locked("eval"), command("plain", {}, { perm: null })];
    assert.deepEqual(L.selectionFromQuery({ command: "vv", panel: "permissions" }, commands), { name: "vv", panel: "permissions" });
    assert.deepEqual(L.selectionFromQuery({ command: "remove", panel: "permissions" }, commands), { name: "kick", panel: "permissions" }, "an alias is resolved to the name");
    assert.deepEqual(L.selectionFromQuery({ command: "KICK", panel: "permissions" }, commands), { name: "kick", panel: "permissions" });
    assert.equal(L.selectionFromQuery({ command: "ghost", panel: "permissions" }, commands), null, "unknown");
    assert.equal(L.selectionFromQuery({ command: "eval", panel: "permissions" }, commands), null, "locked");
    assert.equal(L.selectionFromQuery({ command: "vv", panel: "scopes" }, commands), null, "another panel");
    assert.equal(L.selectionFromQuery({ command: "vv" }, commands), null, "no panel");
    assert.equal(L.selectionFromQuery({ panel: "permissions" }, commands), null, "no command");
    assert.equal(L.selectionFromQuery({ command: ["vv"], panel: "permissions" }, commands), null, "not a string");
    assert.equal(L.selectionFromQuery(undefined, commands), null);
    assert.equal(L.selectionFromQuery({ command: "vv", panel: "permissions" }, undefined), null);
  });

  test("groupTabTarget and commandPanelTarget give the hashes of section 10 through buildHash", async () => {
    const { buildHash } = await load("../router.mjs");
    assert.deepEqual(L.groupTabTarget(GROUP), { name: "groups", rest: [GROUP], query: { tab: "permissions" } });
    assert.deepEqual(L.commandPanelTarget("vv"), { name: "commands", rest: [], query: { command: "vv", panel: "permissions" } });
    const group = L.groupTabTarget(GROUP);
    assert.equal(buildHash(group.name, group.rest, group.query), `#/groups/${encodeURIComponent(GROUP)}?tab=permissions`);
    const cmd = L.commandPanelTarget("vv");
    assert.equal(buildHash(cmd.name, cmd.rest, cmd.query), "#/commands?command=vv&panel=permissions");
  });
});

// ---------------------------------------------------------------------------
// The modules
// ---------------------------------------------------------------------------

describe("the view modules", () => {
  test("permissions-editor, permissions-members and permissions-picker import in plain Node and export their component", async () => {
    const editor = await load("permissions-editor.mjs");
    const members = await load("permissions-members.mjs");
    const picker = await load("permissions-picker.mjs");
    assert.equal(typeof editor.RuleEditor, "function");
    assert.equal(typeof members.GroupMemberPicker, "function");
    assert.equal(typeof picker.PersonPicker, "function");
  });

  test("the logic module imports only shortJid from groups-logic.mjs and nothing else", () => {
    const source = fs.readFileSync(path.join(VIEWS, "permissions-logic.mjs"), "utf8");
    const imports = [...source.matchAll(/^import .*$/gm)].map((m) => m[0]);
    assert.equal(imports.length, 1);
    assert.match(imports[0], /import \{ shortJid \} from "\.\/groups-logic\.mjs";/);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // comments may name what the module does not do
    assert.doesNotMatch(code, /\bt\(|document|window|setTimeout|setInterval|fetch\(/, "pure: no t(), DOM, timer or network");
  });
});

describe("the 003 fragment", () => {
  test("it exists and carries the backup model name asked by the backup page", () => {
    assert.ok(fs.existsSync(FRAGMENT), "specs/003-command-permissions/i18n/panel-permissions.json");
    const fragment = readJson(FRAGMENT);
    assert.equal(fragment.en["backup.model_PermissionRule"], "Permission rules");
    assert.equal(fragment.fr["backup.model_PermissionRule"], "Règles de permission");
  });

  test("same keys and same placeholders in en and fr", () => {
    const fragment = readJson(FRAGMENT);
    assert.deepEqual(Object.keys(fragment.en).sort(), Object.keys(fragment.fr).sort());
    for (const key of Object.keys(fragment.en)) assert.equal(placeholdersOf(fragment.en[key]), placeholdersOf(fragment.fr[key]), key);
  });
});

// ---------------------------------------------------------------------------
// The editor and the pickers in a fake DOM
// ---------------------------------------------------------------------------

const { after: afterAll } = require("node:test");
const { createDom, importPublic } = require("./helpers/fakeDom");

describe("the editor and the pickers render and work", () => {
  let dom;
  let htmlTag;
  let Editor;
  let MemberPicker;
  let ContactPicker;
  let requests;
  let routes;

  const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const failure = (status, code) => answer(status, { error: { code, fields: {}, params: {}, requestId: "r1" } });
  const button = (root, text) => dom.byText(root, text, "button")[0];
  const checkbox = (root, label) => dom.byAttr(root, "aria-label", label, "input")[0];
  const countOf = (key) => requests.filter((r) => r.key === key).length;

  before(async () => {
    dom = await createDom();
    const i18n = await importPublic("js/i18n.mjs");
    for (const lang of ["en", "fr"]) i18n.setCatalog(lang, CATALOGS[lang]);
    await i18n.setLanguage("en", { remember: false });
    htmlTag = (await importPublic("js/components/html.mjs")).html;
    Editor = (await importPublic("js/views/permissions-editor.mjs")).RuleEditor;
    MemberPicker = (await importPublic("js/views/permissions-members.mjs")).GroupMemberPicker;
    ContactPicker = (await importPublic("js/views/permissions-picker.mjs")).PersonPicker;
  });

  afterAll(() => {
    if (dom) dom.restore();
    delete globalThis.fetch;
  });

  function script(table = {}) {
    requests = [];
    routes = table;
    globalThis.fetch = async (url, init) => {
      const [route, search] = url.split("?");
      const key = `${init.method} ${route}`;
      requests.push({ key, search: search || "" });
      if (!routes[key]) throw new Error(`unexpected request ${key}`);
      return routes[key](search || "");
    };
  }

  const MEMBERS_KEY = `GET /admin/api/groups/${encodeURIComponent(GROUP)}/members`;
  const members = (...items) => ({ items });
  const member = (digits, admin = null) => ({ jid: pn(digits), admin, role: "regular" });

  function mountEditor({ command: cmd = KICK, scope = GROUP, saved = null, busy = false, Picker = MemberPicker, pickerProps, context, onSave, onDelete, onClose, limits } = {}) {
    const calls = { save: [], del: 0, close: 0 };
    const root = dom.mount(
      htmlTag`<${Editor}
        command=${cmd}
        scope=${scope}
        saved=${saved}
        busy=${busy}
        limits=${limits}
        context=${context}
        Picker=${Picker}
        pickerProps=${pickerProps || { jid: GROUP, available: true }}
        onSave=${onSave || (async (body, draft) => { calls.save.push({ body, draft }); })}
        onDelete=${onDelete || (async () => { calls.del += 1; })}
        onClose=${onClose || (() => { calls.close += 1; })}
      />`,
    );
    return { root, calls };
  }

  test("a new group rule: the heading, the modes, the empty list, Save and Cancel (no Delete)", async () => {
    script({ [MEMBERS_KEY]: () => answer(200, members(member("237690000001"))) });
    const { root, calls } = mountEditor({ command: VV });
    await dom.settle();
    const text = dom.text(root);
    assert.ok(text.includes("Rule for vv"), "heading");
    assert.ok(text.includes("Scope: this group") && text.includes("Normal level: Everyone"), "scope and normal level");
    assert.ok(text.includes("Normal + these people") && text.includes("These people only"));
    assert.ok(text.includes("The command keeps its normal level"), "the hint of the selected mode");
    assert.ok(text.includes("Nobody yet."));
    assert.equal(dom.find(root, (el) => el.localName === "input" && el.prop("type") === "radio").length, 2, "two radios and no 'normal' one");
    assert.equal(button(root, "Delete the rule"), undefined, "nothing to delete yet");
    assert.ok(button(root, "Cancel") && button(root, "Save"));
    assert.equal(button(root, "Save").prop("disabled"), false, "an empty extra rule is saveable in a group (normal level here)");
    assert.ok(text.includes("This rule has no effect"), "and says so");
    dom.click(button(root, "Cancel"));
    assert.equal(calls.close, 1);
    dom.unmount(root);
  });

  test("ticking members adds chips and the admin-command warning shows before Save; Save sends the body", async () => {
    script({ [MEMBERS_KEY]: () => answer(200, members(member("237690000001"), member("237690000002", "admin"), member("237690000003"))) });
    const { root, calls } = mountEditor();
    await dom.settle();
    assert.ok(!dom.text(root).includes("not known to be"), "no warning without people");
    dom.check(checkbox(root, "Allow +237690000001"), true);
    dom.check(checkbox(root, "Allow +237690000003"), true);
    await dom.settle();
    const text = dom.text(root);
    assert.ok(text.includes("2 people are not known to be admins of this group"), "live warning");
    assert.ok(text.includes("Unsaved changes: 2"));
    assert.equal(dom.find(root, (el) => el.localName === "li" && el.prop("class") === "chip").length, 2);
    assert.equal(checkbox(root, "Allow +237690000001").prop("checked"), true);
    assert.equal(checkbox(root, "Allow +237690000002").prop("checked"), false);

    dom.click(button(root, "Save"));
    await dom.settle();
    assert.equal(calls.save.length, 1);
    assert.deepEqual(calls.save[0].body, { mode: "extra", people: [pn("237690000001"), pn("237690000003")] }, "mode and jids only");
    dom.unmount(root);
  });

  test("a chip: the number, the admin badge of a member, remove button; unticking removes it", async () => {
    script({ [MEMBERS_KEY]: () => answer(200, members(member("237690000001"), member("237690000002", "admin"))) });
    const { root } = mountEditor();
    await dom.settle();
    dom.check(checkbox(root, "Allow +237690000002"), true);
    await dom.settle();
    const chip = dom.find(root, (el) => el.localName === "li" && el.prop("class") === "chip")[0];
    assert.ok(dom.text(chip).includes("+237690000002") && dom.text(chip).includes("Admin"));
    assert.ok(!dom.text(root).includes("not known to be"), "a known admin opens nothing");
    dom.click(dom.byAttr(root, "aria-label", "Remove +237690000002", "button")[0]);
    await dom.settle();
    assert.equal(dom.find(root, (el) => el.localName === "li" && el.prop("class") === "chip").length, 0);
    assert.ok(dom.text(root).includes("Nobody yet."));
    dom.unmount(root);
  });

  test("a saved rule: former and not-admin badges, Delete asks the parent, an unchanged rule cannot be saved", async () => {
    script({ [MEMBERS_KEY]: () => answer(200, members(member("237690000001"))) });
    const saved = {
      command: "kick",
      scope: GROUP,
      mode: "only",
      people: [person(A, { present: true, admin: null }), person(B, { present: false, admin: null }), person(C, { present: null, admin: null })],
      warnings: [],
    };
    const { root, calls } = mountEditor({ saved });
    await dom.settle();
    const text = dom.text(root);
    assert.ok(text.includes("Not an admin"), "present, not an admin, on an admin command");
    assert.ok(text.includes("No longer in the group"), "former");
    assert.equal(dom.byText(root, "Not an admin", "span").length, 1, "nothing for the unknown one");
    assert.equal(button(root, "Save").prop("disabled"), true, "unchanged");
    assert.equal(dom.text(root).includes("Unsaved changes"), false);
    dom.click(button(root, "Delete the rule"));
    assert.equal(calls.del, 1);
    dom.click(dom.byAttr(root, "aria-label", "Remove +237690000003", "button")[0]);
    await dom.settle();
    assert.equal(button(root, "Save").prop("disabled"), false);
    assert.ok(dom.text(root).includes("Unsaved changes: 1"));
    dom.click(button(root, "Cancel"));
    await dom.settle();
    assert.ok(dom.text(root).includes("+237690000003"), "Cancel discards the draft");
    dom.unmount(root);
  });

  test("the everywhere scope: extra with nobody cannot be saved and says why; the mode radios switch the hint", async () => {
    script({ "GET /admin/api/chats": () => answer(200, { items: [], page: 1, pageSize: 50, total: 0 }) });
    const { root } = mountEditor({ command: VV, scope: "*", Picker: ContactPicker, pickerProps: {} });
    await dom.settle();
    assert.equal(button(root, "Save").prop("disabled"), true);
    assert.ok(dom.text(root).includes("Add at least one person, or delete the rule."));
    assert.ok(dom.text(root).includes("Scope: everywhere"));
    const only = dom.find(root, (el) => el.localName === "input" && el.prop("type") === "radio" && el.prop("value") === "only")[0];
    dom.check(only, true);
    await dom.settle();
    assert.ok(dom.text(root).includes("Everybody else is ignored without any reply."));
    assert.ok(dom.text(root).includes("The list is empty: only the owner will be able to use this command."), "empty_only banner");
    assert.equal(button(root, "Save").prop("disabled"), false, "warnings never block");
    dom.unmount(root);
  });

  test("banners from the context: switched-off command and context-only command", async () => {
    script({ [MEMBERS_KEY]: () => answer(200, members()) });
    const { root } = mountEditor({ command: command("pmcmd", { pm: true }), context: { disabled: "group", hasEverywhereOnly: true } });
    await dom.settle();
    const text = dom.text(root);
    assert.ok(text.includes("This command is switched off in this group."));
    assert.ok(text.includes("This command only works in private chats."));
    assert.ok(text.includes("An empty list means"), "normal_here as information when an everywhere only rule exists");
    dom.unmount(root);
  });

  test("members picker: unavailable or failing makes the notice appear, only one GRP-11 call at most", async () => {
    script({});
    const off = mountEditor({ pickerProps: { jid: GROUP, available: false } });
    await dom.settle();
    assert.equal(requests.length, 0, "no GRP-11 call when the list is unavailable");
    assert.ok(dom.text(off.root).includes("The bot cannot read the member list right now"));
    dom.unmount(off.root);

    script({ [MEMBERS_KEY]: () => failure(409, "not_connected") });
    const failing = mountEditor();
    await dom.settle();
    assert.equal(countOf(MEMBERS_KEY), 1);
    assert.ok(dom.text(failing.root).includes("The bot cannot read the member list right now"));
    assert.ok(button(failing.root, "Save"), "the editor itself still works");
    dom.unmount(failing.root);
  });

  test("members picker: search filters, the cap disables unchecked boxes and the editor shows too_many_items", async () => {
    script({ [MEMBERS_KEY]: () => answer(200, members(member("237690000001"), member("237690000002"), member("237690000003"))) });
    const { root } = mountEditor({ limits: { peopleMax: 2 } });
    await dom.settle();
    const search = dom.find(root, (el) => el.localName === "input" && el.prop("type") === "search")[0];
    dom.type(search, "0003");
    await dom.settle();
    assert.ok(checkbox(root, "Allow +237690000003") && !checkbox(root, "Allow +237690000001"));
    dom.type(search, "");
    await dom.settle();
    dom.check(checkbox(root, "Allow +237690000001"), true);
    dom.check(checkbox(root, "Allow +237690000002"), true);
    await dom.settle();
    assert.equal(checkbox(root, "Allow +237690000003").prop("disabled"), true, "at the cap");
    assert.equal(checkbox(root, "Allow +237690000001").prop("disabled"), false, "a ticked box can always be unticked");
    dom.unmount(root);
  });

  test("person picker: known private chats (no selectable), a box adds the contact with the number shown", async () => {
    script({
      "GET /admin/api/chats": () =>
        answer(200, {
          items: [
            { jid: B, kind: "private", name: "Marie", lastSeenAt: null, selectable: true },
            { jid: C, kind: "private", name: null, lastSeenAt: null, selectable: true },
          ],
          page: 1,
          pageSize: 50,
          total: 2,
        }),
    });
    const { root, calls } = mountEditor({ command: VV, scope: "*", Picker: ContactPicker, pickerProps: {} });
    await dom.settle();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].search, "kind=private&pageSize=50", "private chats, 50 a page, never selectable");
    assert.ok(dom.text(root).includes("Marie") && dom.text(root).includes("+237690000002"), "name and number");
    assert.ok(dom.text(root).includes("Check the number: a display name can be misleading."));
    dom.check(checkbox(root, "Allow +237690000002"), true);
    await dom.settle();
    const chip = dom.find(root, (el) => el.localName === "li" && el.prop("class") === "chip")[0];
    assert.ok(dom.text(chip).includes("+237690000002") && dom.text(chip).includes("Marie"));
    dom.click(button(root, "Save"));
    await dom.settle();
    assert.deepEqual(calls.save[0].body, { mode: "extra", people: [B] });
    dom.unmount(root);
  });

  test("person picker: typing a number adds it; a bad, short or duplicate number adds nothing and says why", async () => {
    script({ "GET /admin/api/chats": () => answer(200, { items: [{ jid: B, kind: "private", name: "Marie" }], page: 1, pageSize: 50, total: 1 }) });
    const { root, calls } = mountEditor({ command: VV, scope: "*", Picker: ContactPicker, pickerProps: {} });
    await dom.settle();
    const field = () => dom.byAttr(root, "name", "permissions-number", "input")[0];
    const form = () => dom.find(root, (el) => el.localName === "form")[0];
    const chips = () => dom.find(root, (el) => el.localName === "li" && el.prop("class") === "chip").length;
    const type = async (value) => {
      dom.type(field(), value);
      await dom.settle();
    };
    const submit = async () => {
      dom.fire(form(), "submit");
      await dom.settle();
    };

    await type("+237 690-000-003");
    await submit();
    assert.equal(chips(), 1);
    assert.ok(dom.text(root).includes("+237690000003"));
    assert.equal(field().value, "", "the input is cleared");

    await type("1234567");
    await submit();
    assert.equal(chips(), 1, "nothing added");
    assert.ok(dom.text(root).includes(CATALOGS.en["fields.invalid_phone"]));

    await type("abc");
    await submit();
    assert.equal(chips(), 1);
    assert.ok(dom.text(root).includes(CATALOGS.en["fields.invalid_phone"]));

    await type("00237690000003");
    await submit();
    assert.equal(chips(), 1, "a duplicate of the chip");
    assert.ok(dom.text(root).includes(CATALOGS.en["fields.duplicate"]));
    assert.equal(field().value, "00237690000003", "the input is kept so it can be corrected");

    await type("0690000001");
    await submit();
    assert.equal(chips(), 1, "a national number has no country code");
    assert.ok(dom.text(root).includes(CATALOGS.en["fields.invalid_phone"]));

    dom.click(button(root, "Save"));
    await dom.settle();
    assert.deepEqual(calls.save[0].body, { mode: "extra", people: [C] });
    dom.unmount(root);
  });

  test("person picker: a failing chats request shows a retry and the typed number still works", async () => {
    script({ "GET /admin/api/chats": () => failure(500, "internal_error") });
    const { root } = mountEditor({ command: VV, scope: "*", Picker: ContactPicker, pickerProps: {} });
    await dom.settle();
    assert.ok(button(root, "Try again"));
    assert.ok(dom.byAttr(root, "name", "permissions-number", "input")[0], "no dependency on the bot or the list");
    const before = countOf("GET /admin/api/chats");
    dom.click(button(root, "Try again"));
    await dom.settle();
    assert.equal(countOf("GET /admin/api/chats"), before + 1);
    dom.unmount(root);
  });

  test("while busy every control is disabled", async () => {
    script({ [MEMBERS_KEY]: () => answer(200, members(member("237690000001"))) });
    const saved = { command: "kick", scope: GROUP, mode: "extra", people: [person(A, { present: true, admin: "admin" })], warnings: [] };
    const { root } = mountEditor({ saved, busy: true });
    await dom.settle();
    for (const label of ["Save", "Cancel", "Delete the rule"]) assert.equal(button(root, label).prop("disabled"), true, label);
    assert.equal(checkbox(root, "Allow +237690000001").prop("disabled"), true);
    assert.equal(dom.byAttr(root, "aria-label", "Remove +237690000001", "button")[0].prop("disabled"), true);
    dom.unmount(root);
  });
});
