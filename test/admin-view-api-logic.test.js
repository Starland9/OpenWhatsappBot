"use strict";
/**
 * The pure logic of the API area (feature 004, contracts/panel-ui.md sections 4, 5 and 13): lib/admin/public/js/views/
 * api-logic.mjs and api-form-logic.mjs. No browser, no server: both modules have no DOM access at import time.
 *
 *   part 1  keys, drafts, rights, recipients, the IP grammar (against test/fixtures/api-ip-entries.json), the key body,
 *           server errors and the step-up predicate (against test/fixtures/api-widenings.json)
 *   part 2  statuses, history and usage, polling, clipboard; the descriptor form (the 13 real descriptors of the
 *           registry, a synthetic descriptor with the nine field types), curl, the panel texts of the placeholder table
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const VIEWS = path.join(ROOT, "lib", "admin", "public", "js", "views");
const load = (file) => import(pathToFileURL(path.join(VIEWS, file)).href);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const IP_ENTRIES = readJson(path.join(ROOT, "test", "fixtures", "api-ip-entries.json"));
const WIDENINGS = readJson(path.join(ROOT, "test", "fixtures", "api-widenings.json"));
const FRAGMENT_DIR = path.join(ROOT, "specs", "004-messaging-api", "i18n");

/** The panel catalogs with the two 004 fragments laid over them, so the file also runs before a merge. */
function catalogOf(lang) {
  const base = readJson(path.join(ROOT, "lib", "admin", "public", "i18n", `${lang}.json`));
  for (const name of ["panel-api.json", "panel-api-server.json"]) {
    const file = path.join(FRAGMENT_DIR, name);
    if (fs.existsSync(file)) Object.assign(base, readJson(file)[lang]);
  }
  return base;
}
const CATALOGS = { en: catalogOf("en"), fr: catalogOf("fr") };

let logic;
let form;
let i18n;

before(async () => {
  logic = await load("api-logic.mjs");
  form = await load("api-form-logic.mjs");
  i18n = await import(pathToFileURL(path.join(ROOT, "lib", "admin", "public", "js", "i18n.mjs")).href);
  for (const lang of ["en", "fr"]) i18n.setCatalog(lang, CATALOGS[lang]);
  await i18n.setLanguage("en", { remember: false });
});

/** Every panel key a function can return exists in both catalogs. */
function assertKeys(keys, where) {
  const missing = [];
  for (const key of keys) for (const lang of ["en", "fr"]) if (typeof CATALOGS[lang][key] !== "string") missing.push(`${key} (${lang})`);
  assert.deepEqual(missing, [], `${where}: keys missing from the catalogs`);
}

const A = "237690000001@s.whatsapp.net";
const B = "237690000002@s.whatsapp.net";
const G = "120363025246125486@g.us";
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const savedKey = (over = {}) => ({
  id: 7,
  name: "Shop",
  last4: "ab12",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  revokedAt: null,
  expiresAt: "2026-12-31T00:00:00.000Z",
  version: 3,
  lastUsedAt: null,
  lastUsedIp: null,
  seenIpCount: 0,
  rights: ["messages.send.text", "messages.read"],
  orphanRights: [],
  policy: { mode: "list", recipients: [{ jid: A, name: "Awa" }] },
  limits: { perMinute: 10, perDay: null, maxPending: null },
  ipAllow: ["10.0.0.0/8"],
  queued: 2,
  ...over,
});

// ===========================================================================
// Part 1
// ===========================================================================

describe("constants and tabs", () => {
  test("the lists of section 4.1", () => {
    assert.deepEqual([...logic.TABS], ["keys", "history", "usage", "test", "docs"]);
    assert.deepEqual([...logic.STATUSES], ["queued", "sending", "sent", "delivered", "read", "failed", "expired", "cancelled", "unknown"]);
    assert.deepEqual([...logic.FINAL_STATUSES], ["failed", "expired", "cancelled", "unknown"]);
    assert.deepEqual([...logic.POLICY_MODES], ["list", "known", "anyone"]);
    assert.deepEqual({ ...logic.POLICY_RANK }, { list: 0, known: 1, anyone: 2 });
    assert.deepEqual([...logic.REASONS], ["enable", "create", "rights", "policy", "ip", "expiry", "plain_http"]);
    assert.deepEqual([...logic.RIGHT_GROUPS], ["send", "read", "media", "docs"]);
    assert.deepEqual({ ...logic.POLL }, { fastMs: 2000, fastCount: 15, slowMs: 10000, maxPolls: 60 });
    assert.equal(logic.STEP_UP_MARGIN_MS, 2000);
    assert.equal(logic.DEFAULT_LIMITS.keyNameMax, 64);
    assert.deepEqual([...logic.DEFAULT_LIMITS.perMinute], [1, 1000]);
  });

  test("tabOf returns the value or keys", () => {
    for (const tab of logic.TABS) assert.equal(logic.tabOf(tab), tab);
    for (const bad of ["", "nope", undefined, null, 3, "KEYS"]) assert.equal(logic.tabOf(bad), "keys");
  });

  test("every reason has its text in both languages", () => {
    assertKeys(logic.REASONS.map((reason) => `api.reason_${reason}`), "reasons");
  });
});

describe("key state and list", () => {
  test("keyState: the server status, an active key past its expiry reads expired, an unknown value is revoked", () => {
    assert.equal(logic.keyState(savedKey(), NOW), "active");
    assert.equal(logic.keyState(savedKey({ expiresAt: "2026-06-01T11:59:59.999Z" }), NOW), "expired");
    assert.equal(logic.keyState(savedKey({ expiresAt: "2026-06-01T12:00:00.000Z" }), NOW), "expired", "expiresAt <= now");
    assert.equal(logic.keyState(savedKey({ expiresAt: "2026-06-01T12:00:00.001Z" }), NOW), "active");
    assert.equal(logic.keyState(savedKey({ expiresAt: null }), NOW), "active");
    assert.equal(logic.keyState(savedKey({ status: "expired" }), NOW), "expired");
    assert.equal(logic.keyState(savedKey({ status: "revoked" }), NOW), "revoked");
    assert.equal(logic.keyState(savedKey({ status: "banana" }), NOW), "revoked");
    assert.equal(logic.keyState(null, NOW), "revoked");
  });

  test("editable: not revoked (an expired key can be extended); duplicate: active only; revoke: not revoked", () => {
    const active = savedKey();
    const expired = savedKey({ status: "expired" });
    const revoked = savedKey({ status: "revoked" });
    assert.deepEqual([active, expired, revoked].map((k) => logic.isEditable(k, NOW)), [true, true, false]);
    assert.deepEqual([active, expired, revoked].map((k) => logic.canDuplicate(k, NOW)), [true, false, false]);
    assert.deepEqual([active, expired, revoked].map((k) => logic.canRevoke(k, NOW)), [true, true, false]);
  });

  test("visibleKeys: live keys by name then id, revoked last newest first, revoked dropped unless asked; input untouched", () => {
    const items = [
      savedKey({ id: 4, name: "beta", status: "revoked", revokedAt: "2026-03-01T00:00:00.000Z" }),
      savedKey({ id: 2, name: "Zulu" }),
      savedKey({ id: 5, name: "alpha", status: "expired" }),
      savedKey({ id: 3, name: "Alpha" }),
      savedKey({ id: 6, name: "gamma", status: "revoked", revokedAt: "2026-04-01T00:00:00.000Z" }),
    ];
    const frozen = JSON.stringify(items);
    assert.deepEqual(logic.visibleKeys(items, { showRevoked: false, now: NOW }).map((k) => k.id), [3, 5, 2]);
    assert.deepEqual(logic.visibleKeys(items, { showRevoked: true, now: NOW }).map((k) => k.id), [3, 5, 2, 6, 4]);
    assert.equal(JSON.stringify(items), frozen);
    assert.deepEqual(logic.visibleKeys(null, { now: NOW }), []);
  });

  test("activeNames: lower-cased trimmed names of the non-revoked keys other than the one being edited", () => {
    const items = [savedKey({ id: 1, name: " Shop " }), savedKey({ id: 2, name: "Blog" }), savedKey({ id: 3, name: "Old", status: "revoked" })];
    assert.deepEqual(logic.activeNames(items, null, NOW), ["shop", "blog"]);
    assert.deepEqual(logic.activeNames(items, 1, NOW), ["blog"]);
  });

  test("keyRow: the list cell model, with the default for a null limit", () => {
    const settings = { perMinute: 60, perDay: 1000, maxPending: 100 };
    const row = logic.keyRow(
      savedKey({ rights: ["a.b", "c.d", "e.f", "g.h", "i.j"], policy: { mode: "known", recipients: [{ jid: A }, { jid: B }] }, lastUsedAt: "2026-05-01T00:00:00.000Z", lastUsedIp: "10.0.0.5" }),
      { settings, now: NOW },
    );
    assert.deepEqual(row, {
      id: 7,
      name: "Shop",
      last4: "ab12",
      state: "active",
      rightsCount: 5,
      rightsPreview: ["a.b", "c.d", "e.f"],
      rightsMore: 2,
      policy: { mode: "known", count: 2 },
      limits: [
        { name: "perMinute", value: 10, isDefault: false },
        { name: "perDay", value: 1000, isDefault: true },
        { name: "maxPending", value: 100, isDefault: true },
      ],
      ipCount: 1,
      expiresAt: "2026-12-31T00:00:00.000Z",
      lastUsedAt: "2026-05-01T00:00:00.000Z",
      lastUsedIp: "10.0.0.5",
      createdAt: "2026-01-01T00:00:00.000Z",
      queued: 2,
    });
    assert.equal(logic.keyRow(savedKey({ rights: [] }), { settings, now: NOW }).rightsMore, 0);
  });
});

describe("draft", () => {
  test("a new draft is empty: no right, mode list, no recipient, default limits, no IP row, no expiry", () => {
    assert.deepEqual(logic.draftOf(null), {
      name: "",
      rights: [],
      mode: "list",
      recipients: [],
      limits: { perMinute: null, perDay: null, maxPending: null },
      ipRows: [],
      expiry: { local: "", original: null },
    });
  });

  test("a saved key: rights and recipients sorted, the expiry as a datetime-local value and its stored ISO", () => {
    const draft = logic.draftOf(savedKey({ rights: ["z.r", "a.r"], policy: { mode: "known", recipients: [{ jid: B }, { jid: A, name: "Awa" }] } }));
    assert.deepEqual(draft.rights, ["a.r", "z.r"]);
    assert.deepEqual(draft.recipients.map((p) => p.jid), [A, B]);
    assert.equal(draft.mode, "known");
    assert.equal(draft.expiry.original, "2026-12-31T00:00:00.000Z");
    assert.match(draft.expiry.local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    assert.deepEqual(draft.limits, { perMinute: 10, perDay: null, maxPending: null });
    assert.deepEqual(draft.ipRows, ["10.0.0.0/8"]);
  });

  test("diffKey: an untouched draft differs in nothing; a new empty draft is not dirty", () => {
    const saved = savedKey();
    assert.deepEqual(logic.diffKey(saved, logic.draftOf(saved)).sections, []);
    assert.equal(logic.isDirty(saved, logic.draftOf(saved)), false);
    assert.equal(logic.isDirty(null, logic.draftOf(null)), false);
    assert.equal(logic.pendingCount(null, logic.draftOf(null)), 0);
  });

  test("diffKey: every section is detected, sets are order-insensitive and the name is compared trimmed", () => {
    const saved = savedKey();
    const base = logic.draftOf(saved);
    const sections = (over) => logic.diffKey(saved, { ...base, ...over }).sections;
    assert.deepEqual(sections({ name: "  Shop  " }), []);
    assert.deepEqual(sections({ name: "Shop 2" }), ["name"]);
    assert.deepEqual(sections({ rights: [...base.rights].reverse() }), []);
    assert.deepEqual(sections({ rights: ["messages.send.text"] }), ["rights"]);
    assert.deepEqual(sections({ mode: "known" }), ["policy"]);
    assert.deepEqual(sections({ recipients: [{ jid: `${A}` }] }), [], "same person");
    assert.deepEqual(sections({ recipients: [{ jid: "237690000001:5@s.whatsapp.net" }] }), [], "the device suffix is dropped by personKey");
    assert.deepEqual(sections({ recipients: [{ jid: A }, { jid: B }] }), ["recipients"]);
    assert.deepEqual(sections({ limits: { perMinute: 10, perDay: 5, maxPending: null } }), ["limits"]);
    assert.deepEqual(sections({ limits: { perMinute: "10", perDay: "", maxPending: null } }), [], "blank is null, text numbers compare as numbers");
    assert.deepEqual(sections({ ipRows: ["", " 10.0.0.0/8 ", ""] }), []);
    assert.deepEqual(sections({ ipRows: ["10.0.0.0/8", "203.0.113.5"] }), ["ip"]);
    assert.deepEqual(sections({ ipRows: ["10.9.9.9/8"] }), [], "an entry is compared by its normalised value");
    assert.deepEqual(sections({ expiry: { ...base.expiry, local: "" } }), ["expiry"]);
    assert.deepEqual(sections({ name: "x", mode: "anyone", ipRows: [] }), ["name", "policy", "ip"], "fixed section order");
  });

  test("diffKey: what was added and removed; pendingCount counts items plus one per other section", () => {
    const saved = savedKey();
    const draft = { ...logic.draftOf(saved), rights: ["messages.send.image", "messages.send.text"], recipients: [{ jid: B }], mode: "known", name: "Shop 2" };
    const diff = logic.diffKey(saved, draft);
    assert.deepEqual(diff.rightsAdded, ["messages.send.image"]);
    assert.deepEqual(diff.rightsRemoved, ["messages.read"]);
    assert.deepEqual(diff.recipientsAdded, [B]);
    assert.deepEqual(diff.recipientsRemoved, [A]);
    assert.equal(logic.pendingCount(saved, draft), 2 + 2 + 1 + 1, "2 rights, 2 recipients, policy, name");
    assert.equal(logic.isDirty(saved, draft), true);
    // a new key is compared with the empty draft
    const fresh = { ...logic.draftOf(null), name: "New", rights: ["messages.read"] };
    assert.deepEqual(logic.diffKey(null, fresh).sections, ["name", "rights"]);
    assert.equal(logic.pendingCount(null, fresh), 2);
  });
});

describe("rights", () => {
  const catalog = [
    { id: "messages.send.text", group: "send", format: "text" },
    { id: "messages.send.image", group: "send", format: "image" },
    { id: "media.url", group: "media", format: null },
    { id: "messages.read", group: "read", format: null },
    { id: "api.docs", group: "docs", format: null },
    { id: "zeta.right", group: "zeta", format: null },
    { id: "alpha.right", group: "alpha", format: null },
  ];

  test("rightsGroups: catalogue order inside a group, groups in RIGHT_GROUPS order then the others alphabetically", () => {
    const groups = logic.rightsGroups(catalog, ["messages.send.image", "api.docs"]);
    assert.deepEqual(groups.map((g) => g.group), ["send", "read", "media", "docs", "alpha", "zeta"]);
    const send = groups[0];
    assert.deepEqual(send.items, [
      { id: "messages.send.text", format: "text", checked: false },
      { id: "messages.send.image", format: "image", checked: true },
    ]);
    assert.equal(send.allChecked, false);
    assert.equal(send.noneChecked, false);
    assert.equal(groups[3].allChecked, true);
    assert.equal(groups[1].noneChecked, true);
    assert.deepEqual(logic.rightsGroups([], ["x"]), []);
  });

  test("toggleRight and setGroupRights return a new sorted draft and touch only the group's catalogue ids", () => {
    const draft = { ...logic.draftOf(null), rights: ["messages.read", "orphan.right"] };
    const on = logic.toggleRight(draft, "messages.send.text");
    assert.deepEqual(on.rights, ["messages.read", "messages.send.text", "orphan.right"]);
    assert.deepEqual(logic.toggleRight(on, "messages.send.text").rights, ["messages.read", "orphan.right"]);
    assert.deepEqual(draft.rights, ["messages.read", "orphan.right"], "the input is not mutated");
    const group = logic.setGroupRights(draft, catalog, "send", true);
    assert.deepEqual(group.rights, ["messages.read", "messages.send.image", "messages.send.text", "orphan.right"]);
    assert.deepEqual(logic.setGroupRights(group, catalog, "send", false).rights, ["messages.read", "orphan.right"], "the orphan and the read right stay");
  });

  test("orphanRights: stored ids absent from the catalogue; an empty catalogue makes every right an orphan", () => {
    assert.deepEqual(logic.orphanRights(["messages.read", "gone.module"], catalog), ["gone.module"]);
    assert.deepEqual(logic.orphanRights(["messages.read", "gone.module"], []), ["messages.read", "gone.module"]);
  });

  test("rightKeys and needsRecipients", () => {
    assert.deepEqual(logic.rightKeys("messages.send.text"), { label: "api.right.messages.send.text.label", desc: "api.right.messages.send.text.desc" });
    const base = { ...logic.draftOf(null), rights: ["messages.send.image"] };
    assert.equal(logic.needsRecipients(base), true);
    assert.equal(logic.needsRecipients({ ...base, recipients: [{ jid: A }] }), false);
    assert.equal(logic.needsRecipients({ ...base, mode: "known" }), false);
    assert.equal(logic.needsRecipients({ ...base, rights: ["messages.read"] }), false, "a read right sends nothing");
  });
});

describe("recipients", () => {
  test("recipientKind", () => {
    assert.equal(logic.recipientKind(G), "group");
    assert.equal(logic.recipientKind(A), "private");
  });

  test("add: a number and a group are accepted, a LID chat is refused as invalid_jid, a duplicate and a full list are refused", () => {
    const draft = logic.draftOf(null);
    const withNumber = logic.addRecipient(draft, { jid: A, name: "Awa" });
    assert.equal(withNumber.error, null);
    assert.deepEqual(withNumber.draft.recipients, [{ jid: A, name: "Awa" }]);
    const withGroup = logic.addRecipient(withNumber.draft, { jid: G, name: "Team" });
    assert.deepEqual(withGroup.draft.recipients.map((p) => p.jid), [G, A].sort());
    assert.deepEqual(logic.addRecipient(draft, { jid: "123456789@lid" }).error, { code: "invalid_jid" });
    assert.deepEqual(logic.addRecipient(draft, { jid: "nonsense" }).error, { code: "invalid_jid" });
    assert.deepEqual(logic.addRecipient(draft, {}).error, { code: "invalid_jid" });
    assert.equal(logic.addRecipient(draft, { jid: "123456789@lid" }).draft, draft, "the same draft object on a refusal");
    assert.deepEqual(logic.addRecipient(withNumber.draft, { jid: "237690000001:3@s.whatsapp.net" }).error, { code: "duplicate" });
    assert.deepEqual(logic.addRecipient(withNumber.draft, { jid: B }, { max: 1 }).error, { code: "too_many_items", params: { max: 1 } });
  });

  test("toggle adds then removes; remove is by person and a no-op when absent", () => {
    const draft = logic.draftOf(null);
    const on = logic.toggleRecipient(draft, { jid: A });
    assert.equal(on.draft.recipients.length, 1);
    const off = logic.toggleRecipient(on.draft, { jid: A });
    assert.equal(off.draft.recipients.length, 0);
    assert.equal(off.error, null);
    assert.deepEqual(logic.toggleRecipient(draft, { jid: "1@lid" }).error, { code: "invalid_jid" });
    assert.equal(logic.removeRecipient(on.draft, "237690000001:9@s.whatsapp.net").recipients.length, 0);
    assert.equal(logic.removeRecipient(on.draft, B), on.draft);
  });

  test("recipientsBody: de-duplicated, sorted by person, trimmed, sent in every mode", () => {
    const draft = { ...logic.draftOf(null), mode: "known", recipients: [{ jid: ` ${B} ` }, { jid: A }, { jid: "237690000001:2@s.whatsapp.net" }] };
    assert.deepEqual(logic.recipientsBody(draft), [A, B]);
  });

  test("recipientChatQuery and groupLabel", () => {
    assert.deepEqual(logic.recipientChatQuery({ kind: "group" }), { kind: "group", pageSize: 50 });
    assert.deepEqual(logic.recipientChatQuery({ kind: "group", q: `  ${"x".repeat(150)}  `, page: 3 }), { kind: "group", pageSize: 50, page: 3, q: "x".repeat(100) });
    assert.deepEqual(logic.recipientChatQuery({ q: "   ", page: 1 }), { kind: "group", pageSize: 50 });
    assert.deepEqual(logic.groupLabel({ jid: G, name: "Team" }), { name: "Team", id: G });
    assert.deepEqual(logic.groupLabel({ jid: G, name: null }), { name: null, id: G });
  });
});

describe("IP entries", () => {
  test("parseIpEntry gives the verdict and the value of every row of the shared fixture", () => {
    assert.ok(IP_ENTRIES.length >= 70);
    const wrong = [];
    for (const row of IP_ENTRIES) {
      const parsed = logic.parseIpEntry(row.input);
      if (parsed.ok !== row.ok) wrong.push(`${JSON.stringify(row.input)}: ok ${parsed.ok}, expected ${row.ok}`);
      else if (row.ok && parsed.value !== row.value) wrong.push(`${JSON.stringify(row.input)}: ${parsed.value}, expected ${row.value}`);
    }
    assert.deepEqual(wrong, []);
  });

  test("a valid value parses to itself (an unchanged saved entry never differs from itself) and carries BigInt bounds", () => {
    for (const row of IP_ENTRIES.filter((r) => r.ok)) {
      const again = logic.parseIpEntry(row.value);
      assert.equal(again.ok, true, row.value);
      assert.equal(again.value, row.value, row.value);
      assert.equal(typeof again.start, "bigint");
      assert.ok(again.end >= again.start);
    }
    const net = logic.parseIpEntry("192.168.1.77/24");
    assert.deepEqual([net.family, net.prefix, net.start, net.end], [4, 24, 3232235776n, 3232236031n]);
  });

  test("a blank text is required, anything else invalid is invalid_format", () => {
    assert.deepEqual(logic.parseIpEntry("   "), { ok: false, code: "required" });
    assert.deepEqual(logic.parseIpEntry("1.2.3"), { ok: false, code: "invalid_format" });
    assert.deepEqual(logic.parseIpEntry(42), { ok: false, code: "invalid_format" });
    assert.deepEqual(logic.parseIpEntry("1".repeat(300)), { ok: false, code: "invalid_format" });
  });

  test("parseIpRows: blank rows are ignored but counted, the first spelling wins, row numbers are physical (1-based)", () => {
    const parsed = logic.parseIpRows(["10.1.2.3/8", "", "bad", "10.0.0.0/8", " ", "1.2.3.4", "also bad", "1.2.3.4"]);
    assert.deepEqual(parsed.values, ["10.0.0.0/8", "1.2.3.4"]);
    assert.deepEqual(parsed.invalid, [3, 7]);
    assert.deepEqual(parsed.duplicates, [4, 8]);
    assert.deepEqual(parsed.notPrivate, []);
    assert.equal(parsed.tooMany, false);
    assert.deepEqual(logic.parseIpRows([]), { values: [], invalid: [], notPrivate: [], duplicates: [], tooMany: false });
  });

  test("parseIpRows: privateOnly sends a public entry to notPrivate; max cuts at the number of distinct values", () => {
    const parsed = logic.parseIpRows(["192.168.1.0/24", "203.0.113.5", "", "fd00::/8"], { privateOnly: true });
    assert.deepEqual(parsed.values, ["192.168.1.0/24", "fd00::/8"]);
    assert.deepEqual(parsed.notPrivate, [2]);
    assert.equal(logic.parseIpRows(["1.1.1.1", "2.2.2.2", "3.3.3.3"], { max: 2 }).tooMany, true);
    assert.equal(logic.parseIpRows(["1.1.1.1", "2.2.2.2"], { max: 2 }).tooMany, false);
    assert.equal(logic.parseIpRows(Array.from({ length: 51 }, (_, i) => `10.0.0.${i}`)).tooMany, true, "default max is 50");
  });

  test("ipRowsError: invalid rows first, then not private, then too many; rows joined with a comma and a space", () => {
    const parsed = (over) => ({ values: [], invalid: [], notPrivate: [], duplicates: [], tooMany: false, ...over });
    assert.equal(logic.ipRowsError(parsed({})), null);
    assert.deepEqual(logic.ipRowsError(parsed({ invalid: [2, 4], notPrivate: [1], tooMany: true })), { key: "api.ip_invalid_rows", params: { rows: "2, 4" } });
    assert.deepEqual(logic.ipRowsError(parsed({ invalid: [2, 4] }), { networks: true }), { key: "api.networks_invalid_rows", params: { rows: "2, 4" } });
    assert.deepEqual(logic.ipRowsError(parsed({ notPrivate: [1, 3], tooMany: true })), { key: "api.networks_not_private", params: { rows: "1, 3" } });
    assert.deepEqual(logic.ipRowsError(parsed({ tooMany: true }), { max: 20 }), { code: "too_many_items", params: { max: 20 } });
    assert.deepEqual(logic.ipRowsError(parsed({ duplicates: [2] })), null, "a repeated entry collapses silently");
    assertKeys(["api.ip_invalid_rows", "api.networks_invalid_rows", "api.networks_not_private"], "ipRowsError");
  });

  test("isPrivateRange: the edges of RFC 1918, CGNAT and ULA; a range that spills out is refused", () => {
    const yes = ["10.0.0.0/8", "10.255.255.255", "172.16.0.0/12", "172.31.255.255", "192.168.0.0/16", "100.64.0.0/10", "100.127.255.255", "fc00::/7", "fd12:3456::1"];
    const no = ["172.15.255.255", "172.32.0.0", "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "fe80::/10", "2001:db8::1", "0.0.0.0/0", "10.0.0.0/7", "172.0.0.0/8", "192.0.0.0/8", "::/0", "garbage"];
    for (const value of yes) assert.equal(logic.isPrivateRange(value), true, value);
    for (const value of no) assert.equal(logic.isPrivateRange(value), false, value);
    assert.equal(logic.isPrivateRange(logic.parseIpEntry("10.1.1.1")), true, "a parsed entry is accepted too");
  });

  test("isAnyIp flags the whole address space", () => {
    assert.equal(logic.isAnyIp("0.0.0.0/0"), true);
    assert.equal(logic.isAnyIp("::/0"), true);
    assert.equal(logic.isAnyIp("10.0.0.0/8"), false);
  });

  test("ipCovered: same family and inside one old entry; an unparseable old entry covers nothing", () => {
    assert.equal(logic.ipCovered(["10.0.0.0/8"], "10.4.0.0/16"), true);
    assert.equal(logic.ipCovered(["10.0.0.0/8"], "10.0.0.0/8"), true);
    assert.equal(logic.ipCovered(["10.1.0.0/16"], "10.0.0.0/8"), false);
    assert.equal(logic.ipCovered(["0.0.0.0/0"], "::1"), false, "another family");
    assert.equal(logic.ipCovered(["::/0"], "10.0.0.1"), false);
    assert.equal(logic.ipCovered(["not an ip", "10.0.0.0/8"], "10.9.9.9"), true);
    assert.equal(logic.ipCovered(["not an ip"], "10.9.9.9"), false);
    assert.equal(logic.ipCovered([], "10.9.9.9"), false);
    assert.equal(logic.ipCovered(["10.0.0.0/8"], "not an ip"), false);
    assert.equal(logic.ipCovered(["::ffff:10.0.0.0/104"], "10.2.2.2"), true, "the mapped form is the IPv4 entry");
  });

  test("expiryBody keeps the stored ISO for an untouched field, blank is null, a changed field becomes an instant", () => {
    const original = "2026-12-31T00:00:12.345Z"; // a datetime-local drops seconds and milliseconds
    const local = logic.draftOf(savedKey({ expiresAt: original })).expiry.local;
    assert.equal(logic.expiryBody({ local, original }), original);
    assert.equal(logic.expiryBody({ local: "", original }), null);
    assert.equal(logic.expiryBody({ local: "", original: null }), null);
    const changed = logic.expiryBody({ local: "2027-01-02T03:04", original });
    assert.equal(changed, new Date("2027-01-02T03:04").toISOString());
    assert.equal(logic.expiryBody({ local: "2027-01-02T03:04", original: null }), new Date("2027-01-02T03:04").toISOString());
  });

  test("expiryError: only a changed expiry can be in the past; an expired key left alone is fine", () => {
    const original = "2020-01-01T00:00:00.000Z";
    const local = logic.draftOf(savedKey({ expiresAt: original })).expiry.local;
    assert.equal(logic.expiryError({ local, original }, NOW), null, "unchanged and past");
    assert.deepEqual(logic.expiryError({ local: "2020-06-01T00:00", original }, NOW), { code: "in_past" });
    assert.equal(logic.expiryError({ local: "2030-06-01T00:00", original }, NOW), null);
    assert.equal(logic.expiryError({ local: "", original }, NOW), null, "removing it is fine");
    assert.deepEqual(logic.expiryError({ local: "2020-06-01T00:00", original: null }, NOW), { code: "in_past" }, "a new key");
  });
});

describe("validateKey, buildKeyBody, keyErrors", () => {
  const draft = (over = {}) => ({ ...logic.draftOf(null), name: "Shop", ...over });

  test("a clean draft is ok", () => {
    assert.deepEqual(logic.validateKey(draft(), { names: ["blog"], now: NOW }), { ok: true, errors: {} });
  });

  test("name: required, too_long in code points, duplicate against the other active names (trimmed, any case)", () => {
    assert.deepEqual(logic.validateKey(draft({ name: "   " }), { now: NOW }).errors.name, { code: "required" });
    assert.deepEqual(logic.validateKey(draft({ name: "x".repeat(65) }), { now: NOW }).errors.name, { code: "too_long", params: { max: 64 } });
    assert.equal(logic.validateKey(draft({ name: "😀".repeat(64) }), { now: NOW }).errors.name, undefined, "64 code points fit");
    assert.deepEqual(logic.validateKey(draft({ name: " BLOG " }), { names: ["blog"], now: NOW }).errors.name, { code: "duplicate" });
    assert.deepEqual(logic.validateKey(draft({ name: "x".repeat(9) }), { limits: { keyNameMax: 8 }, now: NOW }).errors.name, { code: "too_long", params: { max: 8 } });
  });

  test("rights and recipients over their caps are too_many_items", () => {
    const manyRights = Array.from({ length: 65 }, (_, i) => `r.${i}`);
    assert.deepEqual(logic.validateKey(draft({ rights: manyRights }), { now: NOW }).errors.rights, { code: "too_many_items", params: { max: 64 } });
    const manyPeople = Array.from({ length: 201 }, (_, i) => ({ jid: `${237690000000 + i}@s.whatsapp.net` }));
    assert.deepEqual(logic.validateKey(draft({ recipients: manyPeople }), { now: NOW }).errors.recipients, { code: "too_many_items", params: { max: 200 } });
  });

  test("limits: an integer in range or blank; otherwise out_of_range with the bounds, invalid_type for a non-number", () => {
    const check = (limits) => logic.validateKey(draft({ limits: { perMinute: null, perDay: null, maxPending: null, ...limits } }), { now: NOW }).errors;
    assert.deepEqual(check({ perMinute: 1000, perDay: 100000, maxPending: 5000 }), {});
    assert.deepEqual(check({ perMinute: 0 }).perMinute, { code: "out_of_range", params: { min: 1, max: 1000 } });
    assert.deepEqual(check({ perMinute: 1001 }).perMinute, { code: "out_of_range", params: { min: 1, max: 1000 } });
    assert.deepEqual(check({ perDay: 100001 }).perDay, { code: "out_of_range", params: { min: 1, max: 100000 } });
    assert.deepEqual(check({ maxPending: 2.5 }).maxPending, { code: "out_of_range", params: { min: 1, max: 5000 } });
    assert.deepEqual(check({ maxPending: Number.NaN }).maxPending, { code: "invalid_type" });
    assert.deepEqual(check({ perMinute: "" }), {}, "blank means the default");
  });

  test("ipAllow and expiry errors come from the IP rows and the changed expiry", () => {
    const errors = logic.validateKey(draft({ ipRows: ["10.0.0.1", "nope"], expiry: { local: "2020-01-01T00:00", original: null } }), { now: NOW }).errors;
    assert.deepEqual(errors.ipAllow, { key: "api.ip_invalid_rows", params: { rows: "2" } });
    assert.deepEqual(errors.expiresAt, { code: "in_past" });
  });

  test("buildKeyBody has exactly the KeyInput property set; version only for an update", () => {
    const body = logic.buildKeyBody(draft({ rights: ["b.r", "a.r", "a.r"], recipients: [{ jid: B }, { jid: A }], ipRows: ["10.1.2.3/8", ""], limits: { perMinute: 5, perDay: null, maxPending: "" } }));
    assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "ipAllow", "limits", "name", "policy", "rights"]);
    assert.deepEqual(body, {
      name: "Shop",
      rights: ["a.r", "b.r"],
      policy: { mode: "list", recipients: [A, B] },
      limits: { perMinute: 5, perDay: null, maxPending: null },
      ipAllow: ["10.0.0.0/8"],
      expiresAt: null,
    });
    const saved = savedKey();
    const update = logic.buildKeyBody(logic.draftOf(saved), saved);
    assert.deepEqual(Object.keys(update).sort(), ["expiresAt", "ipAllow", "limits", "name", "policy", "rights", "version"]);
    assert.equal(update.version, 3);
    assert.equal(update.expiresAt, saved.expiresAt, "an untouched expiry keeps its stored ISO");
  });

  test("confirm: [policy_anyone] only when the mode becomes anyone", () => {
    assert.deepEqual(logic.buildKeyBody(draft({ mode: "anyone" })).confirm, ["policy_anyone"]);
    const known = savedKey({ policy: { mode: "known", recipients: [] } });
    assert.deepEqual(logic.buildKeyBody({ ...logic.draftOf(known), mode: "anyone" }, known).confirm, ["policy_anyone"]);
    const anyone = savedKey({ policy: { mode: "anyone", recipients: [] } });
    assert.equal("confirm" in logic.buildKeyBody(logic.draftOf(anyone), anyone), false, "kept as it is");
    assert.equal("confirm" in logic.buildKeyBody(draft({ mode: "known" })), false);
    assert.ok(fs.readFileSync(path.join(VIEWS, "api-logic.mjs"), "utf8").includes('"policy_anyone"'), "the literal the confirmation guard looks for");
  });

  test("keyErrors maps the server fields onto the editor and keeps the rest in a summary", () => {
    const { errors, summary } = logic.keyErrors({
      name: { code: "duplicate" },
      rights: { code: "not_allowed", params: { allowed: ["x"], indices: [0] } },
      "policy.mode": { code: "not_allowed" },
      "policy.recipients": { code: "invalid_jid", params: { indices: [0, 2] } },
      "limits.perMinute": { code: "out_of_range", params: { min: 1, max: 1000 } },
      "limits.perDay": { code: "invalid_type" },
      "limits.maxPending": { code: "out_of_range" },
      ipAllow: { code: "invalid_format", params: { indices: [1] } },
      expiresAt: { code: "in_past" },
      version: { code: "conflict", params: { version: 9 } },
      $unknown: { code: "unknown_field" },
      confirm: { code: "not_allowed" },
      "policy.$unknown": { code: "unknown_field" },
    });
    assert.deepEqual(errors.name, { code: "duplicate" });
    assert.equal(errors.rights.code, "not_allowed");
    assert.deepEqual(errors.mode, { code: "not_allowed" });
    assert.deepEqual(errors.recipients, { key: "api.recipients_invalid_rows", params: { rows: "1, 3" } });
    assert.deepEqual(errors.perMinute, { code: "out_of_range", params: { min: 1, max: 1000 } });
    assert.deepEqual(errors.perDay, { code: "invalid_type" });
    assert.ok(errors.maxPending);
    assert.deepEqual(errors.ipAllow, { key: "api.ip_invalid_rows", params: { rows: "2" } });
    assert.deepEqual(errors.expiresAt, { code: "in_past" });
    assert.deepEqual(errors.version, { code: "conflict", params: { version: 9 } });
    assert.deepEqual(summary.map((s) => s.path).sort(), ["$unknown", "confirm", "policy.$unknown"]);
    assert.deepEqual(summary.find((s) => s.path === "confirm").error, { code: "not_allowed" });
    assert.deepEqual(logic.keyErrors(null), { errors: {}, summary: [] });
    assertKeys(["api.recipients_invalid_rows", "api.ip_invalid_rows"], "keyErrors");
  });
});

describe("widenings (the step-up predicate)", () => {
  test("the shared fixture is rich enough: 30 rows or more, every reason, every never-case of admin-api.md 1.5", () => {
    assert.ok(WIDENINGS.length >= 30, `${WIDENINGS.length} rows`);
    for (const row of WIDENINGS) {
      assert.ok(typeof row.name === "string" && row.name, "a name");
      assert.ok(Array.isArray(row.reasons), row.name);
      assert.ok(row.reasons.every((reason) => logic.REASONS.includes(reason)), row.name);
      assert.deepEqual(row.reasons, logic.REASONS.filter((reason) => row.reasons.includes(reason)), `${row.name}: reasons in the server order`);
    }
    const seen = new Set(WIDENINGS.flatMap((row) => row.reasons));
    for (const reason of logic.REASONS) assert.ok(seen.has(reason), `a row asks for ${reason}`);
    const names = WIDENINGS.map((row) => row.name).join("\n");
    for (const never of ["name and limits", "rights: one removed", "policy: anyone to known", "policy: recipient removed", "ip: a list where there was none", "ip: an entry removed", "expiry: set where there was none", "expiry: shortened", "plain_http: every network removed", "enable: switched off"]) {
      assert.ok(names.includes(never), `a never-case row: ${never}`);
    }
  });

  test("the client reasons equal the row's reasons (plus clientExtra where the client is deliberately wider) on every row", () => {
    const wrong = [];
    for (const row of WIDENINGS) {
      const expected = logic.REASONS.filter((reason) => row.reasons.includes(reason) || (row.clientExtra || []).includes(reason));
      const got = logic.widenings(row.before, row.after);
      if (JSON.stringify(got) !== JSON.stringify(expected)) wrong.push(`${row.name}: ${JSON.stringify(got)} instead of ${JSON.stringify(expected)}`);
    }
    assert.deepEqual(wrong, []);
  });

  test("a creation is only a creation, whatever the new key holds", () => {
    assert.deepEqual(logic.widenings(null, { rights: ["messages.read"], policy: { mode: "anyone", recipients: [] }, ipAllow: [], expiresAt: null }), ["create"]);
    assert.deepEqual(logic.widenings(undefined, {}), ["create"]);
  });

  test("plain_http from an empty list: every entry is new", () => {
    assert.deepEqual(logic.widenings({ enabled: true, plainHttpFrom: [] }, { enabled: true, plainHttpFrom: ["10.0.0.0/8"] }), ["plain_http"]);
    assert.deepEqual(logic.widenings({ enabled: true, plainHttpFrom: [] }, { enabled: true, plainHttpFrom: [] }), []);
  });

  test("it looks only at the properties present in after", () => {
    const before = { enabled: false, rights: ["messages.read"], policy: { mode: "list", recipients: [{ jid: A }] }, ipAllow: ["10.0.0.0/8"], expiresAt: "2026-12-31T00:00:00.000Z", plainHttpFrom: ["10.0.0.0/8"] };
    assert.deepEqual(logic.widenings(before, {}), []);
    assert.deepEqual(logic.widenings(before, { enabled: true }), ["enable"]);
    assert.deepEqual(logic.widenings(before, { name: "x", limits: { perMinute: 9999 } }), []);
  });

  test("recipients are compared as people: KeyView objects and plain JIDs, a device suffix is the same person", () => {
    const before = { policy: { mode: "list", recipients: [{ jid: A, name: "Awa" }] } };
    assert.deepEqual(logic.widenings(before, { policy: { mode: "list", recipients: [A] } }), []);
    assert.deepEqual(logic.widenings(before, { policy: { mode: "list", recipients: ["237690000001:3@s.whatsapp.net"] } }), []);
    assert.deepEqual(logic.widenings(before, { policy: { mode: "list", recipients: [A, B] } }), ["policy"]);
  });

  test("an unreadable expiry is treated as later (over-report, never under-report)", () => {
    assert.deepEqual(logic.widenings({ expiresAt: "2026-12-31T00:00:00.000Z" }, { expiresAt: "not a date" }), ["expiry"]);
  });
});

// ===========================================================================
// Part 2
// ===========================================================================

describe("statuses and messages", () => {
  test("statusTone", () => {
    const tones = Object.fromEntries(logic.STATUSES.map((status) => [status, logic.statusTone(status)]));
    assert.deepEqual(tones, { queued: "info", sending: "info", sent: "ok", delivered: "ok", read: "ok", failed: "danger", expired: "neutral", cancelled: "neutral", unknown: "warn" });
    assert.equal(logic.statusTone("whatever"), "neutral");
  });

  test("isSettled: final statuses, read, and sent on a group; delivered is not settled (a read may follow)", () => {
    for (const status of logic.FINAL_STATUSES) assert.equal(logic.isSettled({ status, kind: "private" }), true, status);
    assert.equal(logic.isSettled({ status: "read", kind: "private" }), true);
    assert.equal(logic.isSettled({ status: "sent", kind: "group" }), true, "a group stops at sent");
    assert.equal(logic.isSettled({ status: "sent", kind: "private" }), false);
    assert.equal(logic.isSettled({ status: "delivered", kind: "group" }), false);
    assert.equal(logic.isSettled({ status: "delivered", kind: "private" }), false);
    for (const status of ["queued", "sending"]) assert.equal(logic.isSettled({ status, kind: "private" }), false, status);
  });

  test("stepRows: by time, ties in lifecycle order; with no step, the status at the acceptance time", () => {
    const rows = logic.stepRows({
      status: "failed",
      acceptedAt: "2026-06-01T10:00:00.000Z",
      steps: [
        { status: "failed", at: "2026-06-01T10:00:05.000Z" },
        { status: "sending", at: "2026-06-01T10:00:01.000Z" },
        { status: "queued", at: "2026-06-01T10:00:00.000Z" },
        { status: "sent", at: "2026-06-01T10:00:01.000Z" },
      ],
    });
    assert.deepEqual(rows.map((r) => r.status), ["queued", "sending", "sent", "failed"]);
    assert.deepEqual(logic.stepRows({ status: "queued", acceptedAt: "2026-06-01T10:00:00.000Z", steps: [] }), [{ status: "queued", at: "2026-06-01T10:00:00.000Z" }]);
    assert.deepEqual(logic.stepRows({ status: "queued", acceptedAt: "2026-06-01T10:00:00.000Z" }), [{ status: "queued", at: "2026-06-01T10:00:00.000Z" }]);
  });

  test("failureText: the panel key when the catalog has the code, else null and the raw code", () => {
    assert.deepEqual(logic.failureText("not_on_whatsapp"), { key: "api.failure.not_on_whatsapp", code: "not_on_whatsapp" });
    assert.deepEqual(logic.failureText("brand_new_code"), { key: null, code: "brand_new_code" });
    assert.deepEqual(logic.failureText("x", () => true), { key: "api.failure.x", code: "x" });
  });

  test("failureText finds a text for each of the 14 message-level codes of the engine", () => {
    const errors = require("../lib/messaging/errors");
    const codes = [...Object.keys(errors.FAILURE_CODES), ...Object.keys(errors.CANCEL_REASONS), ...Object.keys(errors.UNKNOWN_REASONS)];
    assert.equal(codes.length, 14);
    for (const code of codes) assert.deepEqual(logic.failureText(code), { key: `api.failure.${code}`, code });
    assertKeys(codes.map((code) => `api.failure.${code}`), "failure codes");
  });

  test("recipientCell, sourceCell, authorLabel", () => {
    assert.deepEqual(logic.recipientCell({ to: A, toName: "Awa", kind: "private" }), { number: "+237690000001", name: "Awa", group: false });
    assert.deepEqual(logic.recipientCell({ to: G, toName: "Team", kind: "group" }), { number: G, name: "Team", group: true });
    assert.deepEqual(logic.recipientCell({ to: A, toName: null, kind: "private" }), { number: "+237690000001", name: null, group: false });
    assert.deepEqual(logic.sourceCell({ source: "panel", key: null }), { kind: "panel", name: null });
    assert.deepEqual(logic.sourceCell({ source: "api", key: { id: 3, name: "Shop" } }), { kind: "key", name: "Shop" });
    assert.deepEqual(logic.sourceCell({ source: "api", key: { id: 3, name: null } }), { kind: "gone", name: null });
    assert.deepEqual(logic.sourceCell({ source: "api", key: null }), { kind: "gone", name: null });
    assert.equal(logic.authorLabel("237690000001"), "+237690000001");
    assert.equal(logic.authorLabel("123456789@lid"), "@123456789");
    assert.equal(logic.authorLabel("someone"), "someone");
  });

  test("choiceLabel: the stored label, else a poll option by position, else the id", () => {
    assert.deepEqual(logic.choiceLabel({ id: "0", label: "Tuesday" }, 0, "poll"), { label: "Tuesday" });
    assert.deepEqual(logic.choiceLabel({ id: "1", label: null }, 1, "poll"), { key: "api.responses_option", params: { n: 2 } });
    assert.deepEqual(logic.choiceLabel({ id: "confirm", label: null }, 0, "buttons"), { label: "confirm" });
    assertKeys(["api.responses_option"], "choiceLabel");
  });

  test("pollBars: the ratio is the count over the largest count, 0 when nobody voted", () => {
    assert.deepEqual(logic.pollBars([{ id: "0", label: "A", count: 4 }, { id: "1", label: null, count: 2 }, { id: "2", label: "C", count: 0 }]), [
      { id: "0", label: "A", count: 4, ratio: 1 },
      { id: "1", label: null, count: 2, ratio: 0.5 },
      { id: "2", label: "C", count: 0, ratio: 0 },
    ]);
    assert.deepEqual(logic.pollBars([{ id: "0", label: "A", count: 0 }]).map((b) => b.ratio), [0]);
    assert.deepEqual(logic.pollBars(null), []);
  });
});

describe("history, usage, polling, clipboard", () => {
  test("parseHistoryQuery keeps the valid filters and drops the rest", () => {
    assert.deepEqual(logic.parseHistoryQuery({ key: "panel", status: "failed", format: "poll", from: "2026-03-01", to: "2026-03-31" }), { key: "panel", status: "failed", format: "poll", from: "2026-03-01", to: "2026-03-31" });
    assert.deepEqual(logic.parseHistoryQuery({ key: "12" }).key, "12");
    assert.deepEqual(logic.parseHistoryQuery({ key: "abc", status: "bogus", format: "Text", from: "2026-02-31", to: "yesterday" }), { key: "", status: "", format: "", from: "", to: "" });
    assert.equal(logic.parseHistoryQuery({ key: "0" }).key, "");
    assert.deepEqual(logic.parseHistoryQuery(null), { key: "", status: "", format: "", from: "", to: "" });
  });

  test("historyQuery: the filters that are set, the local day bounds as ISO instants, the page and the size", () => {
    const query = logic.historyQuery({ key: "7", status: "sent", format: "text", from: "2026-03-01", to: "2026-03-02" }, 3);
    assert.deepEqual(query, {
      key: "7",
      status: "sent",
      format: "text",
      from: new Date(2026, 2, 1, 0, 0, 0, 0).toISOString(),
      to: new Date(2026, 2, 2, 23, 59, 59, 999).toISOString(),
      page: 3,
      pageSize: 25,
    });
    assert.deepEqual(logic.historyQuery({}, 0, 500), { page: 1, pageSize: 200 });
    assert.deepEqual(logic.historyQuery({ from: "2026-02-31" }), { page: 1, pageSize: 25 }, "an invalid day is left out");
    assert.equal(logic.historyKey({ status: "sent" }, 2), JSON.stringify({ status: "sent", page: 2, pageSize: 25 }));
    assert.deepEqual(logic.validateHistoryFilters({ from: "2026-03-05", to: "2026-03-01" }), { ok: false, errors: { to: "end_before_start" } });
    assert.deepEqual(logic.validateHistoryFilters({ from: "2026-03-01", to: "2026-03-05" }), { ok: true, errors: {} });
  });

  test("usageQuery: 7 or 30 days, all, panel or a key id", () => {
    assert.deepEqual(logic.usageQuery(30, "all"), { days: 30, key: "all" });
    assert.deepEqual(logic.usageQuery(7, 12), { days: 7, key: "12" });
    assert.deepEqual(logic.usageQuery(99, "panel"), { days: 7, key: "panel" });
    assert.deepEqual(logic.usageQuery(7, "x'; drop"), { days: 7, key: "all" });
  });

  test("usageModel: the server order, ratios over the busiest day, totals, empty entries", () => {
    const model = logic.usageModel({
      timezone: "Africa/Douala",
      from: "2026-06-01",
      to: "2026-06-03",
      keys: [
        { id: 4, name: "Shop", source: "api", revoked: false, days: [{ day: "2026-06-01", sent: 4, failed: 0 }, { day: "2026-06-02", sent: 1, failed: 1 }, { day: "2026-06-03", sent: 0, failed: 0 }] },
        { id: null, name: null, source: "panel", revoked: false, days: [{ day: "2026-06-01", sent: 0, failed: 0 }] },
      ],
    });
    assert.deepEqual(model[0].rows.map((r) => r.ratio), [1, 0.5, 0]);
    assert.deepEqual(model[0].totals, { sent: 5, failed: 1 });
    assert.equal(model[0].empty, false);
    assert.equal(model[1].empty, true);
    assert.deepEqual(model[1].rows.map((r) => r.ratio), [0]);
    assert.deepEqual(model.map((m) => m.source), ["api", "panel"]);
    assert.deepEqual(logic.usageModel(null), []);
  });

  test("nextPollDelay: 2 s for 15 polls, then 10 s, none at 60 or once settled", () => {
    const queued = { status: "queued", kind: "private" };
    assert.equal(logic.nextPollDelay(0, queued), 2000);
    assert.equal(logic.nextPollDelay(14, queued), 2000);
    assert.equal(logic.nextPollDelay(15, queued), 10000);
    assert.equal(logic.nextPollDelay(59, queued), 10000);
    assert.equal(logic.nextPollDelay(60, queued), null);
    assert.equal(logic.nextPollDelay(0, { status: "failed", kind: "private" }), null);
    assert.equal(logic.nextPollDelay(3, { status: "sent", kind: "group" }), null);
    assert.equal(logic.nextPollDelay(3, { status: "delivered", kind: "private" }), 2000);
  });

  test("copyText: copied with a working clipboard; manual when it is absent, rejects, or the context is insecure", async () => {
    const written = [];
    const working = { clipboard: { writeText: async (text) => written.push(text) } };
    assert.equal(await logic.copyText("secret-1", { navigator: working, isSecureContext: true }), "copied");
    assert.deepEqual(written, ["secret-1"]);
    assert.equal(await logic.copyText("x", { navigator: { clipboard: { writeText: async () => { throw new Error("denied"); } } }, isSecureContext: true }), "manual");
    assert.equal(await logic.copyText("x", { navigator: {}, isSecureContext: true }), "manual");
    assert.equal(await logic.copyText("x", { navigator: undefined, isSecureContext: true }), "manual");
    assert.equal(await logic.copyText("x", { navigator: working, isSecureContext: false }), "manual");
    assert.deepEqual(written, ["secret-1"], "an insecure context never calls the clipboard");
  });

  test("apiBaseUrl and endpointUrl: the server's address, else the location", () => {
    const state = { baseUrl: "https://bot.example.org:8443/api/v1" };
    assert.equal(logic.apiBaseUrl(state), "https://bot.example.org:8443/api/v1");
    assert.equal(logic.endpointUrl(state, { path: "/api/v1/messages" }), "https://bot.example.org:8443/api/v1/messages");
    const location = { origin: "http://192.168.1.5:3000" };
    assert.equal(logic.apiBaseUrl({}, { location, basePath: "/api/v1" }), "http://192.168.1.5:3000/api/v1");
    assert.equal(logic.apiBaseUrl({ baseUrl: "not a url" }, { location }), "http://192.168.1.5:3000/api/v1");
    assert.equal(logic.endpointUrl({}, { path: "/api/v1/messages" }, { location }), "http://192.168.1.5:3000/api/v1/messages");
  });
});

// ---------------------------------------------------------------------------
// The descriptor form
// ---------------------------------------------------------------------------

const formats = require("../lib/messaging/formats");
const plain = (value) => JSON.parse(JSON.stringify(value)); // what the SPA receives from API-3
const realDescriptors = () => formats.list().map((row) => plain(formats.describe(row.name)));

/** The example body without the optional booleans that equal their default (buildRequest omits those). */
function withoutDefaultBooleans(descriptor, body) {
  const copy = { ...body };
  for (const field of descriptor.fields) {
    if (field.type === "boolean" && !field.required && field.name in copy && copy[field.name] === Boolean(field.default ?? false)) delete copy[field.name];
  }
  return copy;
}

describe("the 13 real descriptors", () => {
  test("the registry has the 13 formats the page is built for", () => {
    assert.equal(realDescriptors().length, 13);
  });

  test("orderedFormats sorts by order then name", () => {
    const shuffled = [...realDescriptors()].reverse();
    assert.deepEqual(form.orderedFormats({ formats: shuffled }).map((d) => d.name), realDescriptors().map((d) => d.name));
    assert.deepEqual(form.orderedFormats({ formats: [{ name: "b", order: 1 }, { name: "a", order: 1 }, { name: "c", order: 0 }] }).map((d) => d.name), ["c", "a", "b"]);
    assert.deepEqual(form.orderedFormats(null), []);
  });

  for (const descriptor of realDescriptors()) {
    test(`${descriptor.name}: its example fills the form, validates clean and builds back into the example`, () => {
      const initial = form.initialValues(descriptor);
      assert.ok(initial.to, "the recipient is part of every form");
      const values = form.valuesFromBody(descriptor, descriptor.example);
      assert.deepEqual(form.clientValidate(descriptor, values), {}, "no courtesy error on the documented example");
      const built = form.buildRequest(descriptor, values);
      assert.deepEqual(built, withoutDefaultBooleans(descriptor, form.exampleBody(descriptor)));
      assert.equal(built.format, descriptor.name);
      assert.ok(!("wait" in built) && !("idempotencyKey" in built) && !("uploadId" in built) && !("media" in built));
      // the result survives a second trip through the form
      assert.deepEqual(form.buildRequest(descriptor, form.valuesFromBody(descriptor, built)), built);
    });

    test(`${descriptor.name}: an empty form is not valid (the recipient and the required fields are asked for)`, () => {
      const errors = form.clientValidate(descriptor, form.initialValues(descriptor));
      assert.equal(errors.to.code, "required");
      for (const field of descriptor.fields.filter((f) => f.required && f.type !== "boolean" && f.type !== "recipient")) {
        assert.ok(Object.keys(errors).some((path) => path === field.name || path.startsWith(`${field.name}.`)), `${field.name} is asked for`);
      }
    });
  }

  test("the minimum rows of the required lists are there from the start (poll options, buttons, a card and its phone)", () => {
    const by = Object.fromEntries(realDescriptors().map((d) => [d.name, d]));
    assert.equal(form.initialValues(by.poll).options.length, 2);
    assert.equal(form.initialValues(by.buttons).buttons.length, 1);
    assert.deepEqual(Object.keys(form.initialValues(by.buttons).buttons[0]).sort(), ["_k", "id", "label"]);
    const contact = form.initialValues(by.contact).contacts[0];
    assert.equal(contact.phones.length, 1);
    assert.equal(form.initialValues(by.text).mentions.length, 0, "an optional list starts empty");
  });

  test("carryOver keeps the recipient the owner typed and resets the rest", () => {
    const by = Object.fromEntries(realDescriptors().map((d) => [d.name, d]));
    const typed = form.setPath(form.initialValues(by.text), "to", { kind: "number", number: "237690000009", group: null });
    const typedText = form.setPath(typed, "text", "hello");
    const next = form.carryOver(typedText, by.poll);
    assert.deepEqual(next.to, { kind: "number", number: "237690000009", group: null });
    assert.equal(next.question, "");
    assert.equal(next.options.length, 2);
  });
});

describe("a synthetic descriptor with the nine field types", () => {
  const key = (name) => `api.format.demo.field.${name}.label`;
  const demo = {
    name: "demo",
    right: "messages.send.demo",
    interactive: false,
    order: 900,
    labelKey: "api.format.demo.label",
    descKey: "api.format.demo.desc",
    media: null,
    example: { format: "demo", to: "237690000001", title: "Hello", notes: "line 1\nline 2", qty: 3, urgent: true, kind: "b", callback: "237690000002", site: "https://example.com/x", tags: ["a", "b"], rows: [{ label: "L1", values: [1, 2.5] }] },
    fields: [
      { name: "to", type: "recipient", required: true, labelKey: "api.format.common.field.to.label", min: 1, max: 64 },
      { name: "title", type: "text", required: true, labelKey: key("title"), min: 2, max: 20, placeholderKey: "api.format.demo.field.title.placeholder" },
      { name: "notes", type: "textarea", required: false, labelKey: key("notes"), max: 500 },
      { name: "qty", type: "number", required: true, labelKey: key("qty"), min: 1, max: 10 },
      { name: "urgent", type: "boolean", required: false, labelKey: key("urgent"), default: false },
      { name: "kind", type: "select", required: true, labelKey: key("kind"), options: [{ value: "a", labelKey: "api.format.demo.field.kind.option.a" }, { value: "b", labelKey: "api.format.demo.field.kind.option.b" }] },
      { name: "callback", type: "phone", required: false, labelKey: key("callback") },
      { name: "site", type: "url", required: false, labelKey: key("site"), patternHintKey: "api.format.demo.field.site.pattern" },
      { name: "tags", type: "list", required: false, labelKey: key("tags"), max: 3, unique: true, item: { name: "tags", type: "text", required: true, labelKey: key("tags"), min: 1, max: 10 } },
      {
        name: "rows",
        type: "list",
        required: true,
        labelKey: key("rows"),
        min: 1,
        max: 2,
        items: {
          min: 1,
          max: 2,
          fields: [
            { name: "label", type: "text", required: true, labelKey: key("rows.label") },
            { name: "values", type: "list", required: true, labelKey: key("rows.values"), min: 1, max: 3, item: { name: "values", type: "number", required: true, labelKey: key("rows.values") } },
          ],
        },
      },
    ],
  };
  const ok = () => form.valuesFromBody(demo, demo.example);

  test("the example round-trips through the generic form: values, validation, body", () => {
    const values = ok();
    assert.deepEqual(form.clientValidate(demo, values), {});
    assert.deepEqual(form.buildRequest(demo, values), form.exampleBody(demo));
    assert.equal(values.urgent, true);
    assert.equal(values.kind, "b");
    assert.deepEqual(values.to, { kind: "number", number: "237690000001", group: null });
  });

  test("initialValues: blanks, the first option, a boolean at its default, the minimum rows with nested rows", () => {
    const initial = form.initialValues(demo);
    assert.equal(initial.title, "");
    assert.equal(initial.kind, "a");
    assert.equal(initial.urgent, false);
    assert.equal(initial.tags.length, 0);
    assert.equal(initial.rows.length, 1);
    assert.equal(initial.rows[0].values.length, 1);
    assert.ok(Number.isInteger(initial.__seq) && initial.__seq >= 2);
    const keys = [initial.rows[0]._k, initial.rows[0].values[0]._k];
    assert.equal(new Set(keys).size, 2, "row keys are distinct");
  });

  test("clientValidate: every courtesy code on the right dotted path", () => {
    const set = (path, value) => form.setPath(ok(), path, value);
    const errorsOf = (values) => form.clientValidate(demo, values);
    assert.deepEqual(errorsOf(set("title", "x")).title, { code: "too_short", params: { min: 2 } });
    assert.deepEqual(errorsOf(set("title", "x".repeat(21))).title, { code: "too_long", params: { max: 20 } });
    assert.deepEqual(errorsOf(set("title", "  ")).title, { code: "required" });
    assert.equal(errorsOf(set("title", "😀😀")).title, undefined, "length is in code points");
    assert.deepEqual(errorsOf(set("notes", "x".repeat(501))).notes, { code: "too_long", params: { max: 500 } });
    assert.deepEqual(errorsOf(set("qty", "abc")).qty, { code: "invalid_type" });
    assert.deepEqual(errorsOf(set("qty", "11")).qty, { code: "out_of_range", params: { min: 1, max: 10 } });
    assert.equal(errorsOf(set("qty", "2,5")).qty, undefined, "a comma is a decimal point");
    assert.deepEqual(errorsOf(set("kind", "z")).kind, { code: "not_allowed" });
    assert.deepEqual(errorsOf(set("callback", "abc")).callback, { code: "invalid_phone" });
    assert.equal(errorsOf(set("callback", "")).callback, undefined, "optional and blank");
    assert.deepEqual(errorsOf(set("site", "ftp://example.com")).site, { code: "invalid_format" });
    assert.deepEqual(errorsOf(set("tags.1", "a"))["tags.1"], { code: "duplicate" });
    assert.deepEqual(errorsOf(set("tags.0", ""))["tags.0"], { code: "required" });
    assert.deepEqual(errorsOf(set("rows.0.values.0", ""))["rows.0.values.0"], { code: "required" });
    assert.deepEqual(errorsOf(set("rows.0.label", ""))["rows.0.label"], { code: "required" });
    assert.deepEqual(errorsOf(set("rows", [])).rows, { code: "required" });
    assert.deepEqual(errorsOf(set("to", { kind: "number", number: "0612", group: null })).to, { code: "invalid_phone" });
    assert.deepEqual(errorsOf(set("to", { kind: "group", number: "", group: null })).to, { code: "required" });
    assert.deepEqual(errorsOf(set("to", { kind: "group", number: "", group: { jid: "120363025246125486@g.us" } })), {});
  });

  test("a pattern and a list that is too long are caught", () => {
    const withPattern = { ...demo, fields: demo.fields.map((f) => (f.name === "title" ? { ...f, pattern: "^[A-Z]" } : f)) };
    assert.deepEqual(form.clientValidate(withPattern, form.setPath(ok(), "title", "hello")).title, { code: "invalid_format" });
    assert.equal(form.clientValidate(withPattern, form.setPath(ok(), "title", "Hello")).title, undefined);
    const four = form.valuesFromBody(demo, { ...demo.example, tags: ["a", "b", "c", "d"] });
    assert.deepEqual(form.clientValidate(demo, four).tags, { code: "too_many_items", params: { max: 3 } });
  });

  test("buildRequest: numbers parsed, phones as digits, optional blanks and empty optional lists omitted, defaults not sent", () => {
    const values = form.setPath(form.setPath(form.setPath(ok(), "qty", "4,5"), "callback", "+237 690 00 00 03"), "notes", "");
    const body = form.buildRequest(demo, form.setPath(values, "urgent", false));
    assert.equal(body.qty, 4.5);
    assert.equal(body.callback, "237690000003");
    assert.ok(!("notes" in body) && !("urgent" in body));
    const bare = form.buildRequest(demo, form.setPath(ok(), "tags", []));
    assert.ok(!("tags" in bare));
    const typedAsIs = form.buildRequest(demo, form.setPath(ok(), "notes", " keep  my spaces \n"));
    assert.equal(typedAsIs.notes, " keep  my spaces \n", "a textarea is judged trimmed but sent as typed");
  });

  test("buildRequest: the recipient is the digits of the number or the group id; the upload and the URL source", () => {
    const group = form.setPath(ok(), "to", { kind: "group", number: "ignored", group: { jid: "120363025246125486@g.us", name: "Team" } });
    assert.equal(form.buildRequest(demo, group).to, "120363025246125486@g.us");
    assert.equal(form.buildRequest(demo, form.setPath(ok(), "to", { kind: "group", number: "", group: "120363025246125486@g.us" })).to, "120363025246125486@g.us");
    assert.equal(form.buildRequest(demo, form.setPath(ok(), "to", { kind: "number", number: "+237 690-00-00-01", group: null })).to, "237690000001");
    assert.equal(form.buildRequest(demo, ok(), { uploadId: "up_1" }).uploadId, "up_1");
    assert.deepEqual(form.buildRequest(demo, ok(), { mediaUrl: "https://cdn.example.org/a.jpg" }).media, { url: "https://cdn.example.org/a.jpg" });
    const both = form.buildRequest(demo, ok(), { uploadId: "up_1", mediaUrl: "https://cdn.example.org/a.jpg" });
    assert.ok(!("media" in both), "one media source at a time");
  });

  test("valuesFromBody ignores a property the descriptor does not know", () => {
    const values = form.valuesFromBody(demo, { ...demo.example, nothing: 1, wait: true });
    assert.ok(!("nothing" in values) && !("wait" in values));
  });

  test("panelKeysOfDescriptor: every key once, including options, placeholders and pattern hints", () => {
    const keys = form.panelKeysOfDescriptor(demo);
    assert.equal(new Set(keys).size, keys.length);
    for (const wanted of ["api.format.demo.label", "api.format.demo.desc", "api.format.common.field.to.label", "api.format.demo.field.title.label", "api.format.demo.field.title.placeholder", "api.format.demo.field.kind.option.a", "api.format.demo.field.kind.option.b", "api.format.demo.field.site.pattern", "api.format.demo.field.rows.values.label", "api.format.demo.field.rows.label.label"]) {
      assert.ok(keys.includes(wanted), wanted);
    }
  });
});

describe("rows and paths", () => {
  const list = { name: "tags", type: "list", required: false, min: 1, max: 3, item: { name: "tags", type: "text", required: true } };
  const objects = { name: "buttons", type: "list", required: true, items: { min: 1, max: 3, fields: [{ name: "id", type: "text", required: true }, { name: "label", type: "text", required: true }] } };
  const base = { tags: [{ _k: 1, value: "a" }], buttons: [{ _k: 2, id: "x", label: "X" }, { _k: 3, id: "y", label: "Y" }], __seq: 3 };

  test("rowBounds reads field.min ?? items.min ?? 0 and field.max ?? items.max ?? Infinity", () => {
    assert.deepEqual(form.rowBounds(list), { min: 1, max: 3 });
    assert.deepEqual(form.rowBounds(objects), { min: 1, max: 3 });
    assert.deepEqual(form.rowBounds({ name: "x", type: "list", item: {} }), { min: 0, max: Infinity });
    assert.deepEqual(form.rowBounds({ name: "x", type: "list", min: 2, items: { min: 5, max: 9, fields: [] } }), { min: 2, max: 9 });
  });

  test("getPath and setPath: dotted paths with numeric indices, a scalar row reads and writes as its value, immutable", () => {
    assert.equal(form.getPath(base, "tags.0"), "a");
    assert.equal(form.getPath(base, "buttons.1.label"), "Y");
    assert.equal(form.getPath(base, "buttons.5.label"), undefined);
    assert.equal(form.getPath(base, ["buttons", 0, "id"]), "x");
    assert.equal(form.getPath(base, "nothing.at.all"), undefined);
    const next = form.setPath(base, "buttons.1.label", "Z");
    assert.equal(form.getPath(next, "buttons.1.label"), "Z");
    assert.equal(form.getPath(base, "buttons.1.label"), "Y", "the original is untouched");
    assert.equal(next.buttons[0], base.buttons[0], "what did not change is shared");
    const scalar = form.setPath(base, "tags.0", "b");
    assert.deepEqual(scalar.tags[0], { _k: 1, value: "b" }, "the row key survives");
    assert.equal(form.pathKey(["buttons", "1", "id"]), "buttons.1.id");
  });

  test("addRow and removeRow stop at the bounds with the same object, and add rows with a fresh key", () => {
    const one = form.addRow(base, "tags", list);
    assert.equal(one.tags.length, 2);
    assert.equal(one.tags[1].value, "");
    assert.ok(one.tags[1]._k > base.__seq);
    const three = form.addRow(form.addRow(base, "tags", list), "tags", list);
    assert.equal(three.tags.length, 3);
    assert.equal(form.addRow(three, "tags", list), three, "at max");
    assert.equal(form.removeRow(base, "tags", 0, list), base, "at min");
    assert.equal(form.removeRow(three, "tags", 1, list).tags.length, 2);
    assert.equal(form.removeRow(three, "tags", 9, list), three, "not a row");
    const row = form.addRow(base, "buttons", objects);
    assert.deepEqual(Object.keys(row.buttons[2]).sort(), ["_k", "id", "label"]);
    const keys = new Set([...row.buttons, ...row.tags].map((r) => r._k));
    assert.equal(keys.size, 4, "every row key is distinct");
    assert.equal(form.addRow(row, "buttons", objects), row, "buttons are capped at 3");
    assert.equal(form.removeRow(form.removeRow(base, "buttons", 0, objects), "buttons", 0, objects).buttons.length, 1, "the last row stays");
  });
});

describe("server errors on the right control", () => {
  const by = () => Object.fromEntries(realDescriptors().map((d) => [d.name, d]));

  test("dotted paths with row indices land on their control; the media paths on the media control", () => {
    const buttons = by().buttons;
    const values = form.valuesFromBody(buttons, buttons.example);
    const { byPath, other } = form.splitFieldErrors(
      {
        to: { code: "invalid_phone" },
        quote: { code: "not_found" },
        text: { code: "too_long", params: { max: 1024 } },
        buttons: { code: "too_many_items" },
        "buttons.1.id": { code: "duplicate" },
        "buttons.0.label": { code: "too_long" },
        media: { code: "not_allowed" },
        "media.url": { code: "invalid_format" },
        uploadId: { code: "not_found" },
      },
      buttons,
      values,
    );
    assert.deepEqual(Object.keys(byPath).sort(), ["buttons", "buttons.0.label", "buttons.1.id", "media", "quote", "text", "to"]);
    assert.deepEqual(byPath["buttons.1.id"], { code: "duplicate" });
    assert.deepEqual(other, []);
  });

  test("$unknown, an unknown path and a row that is not there go to the list of the other errors", () => {
    const buttons = by().buttons;
    const values = form.valuesFromBody(buttons, buttons.example);
    const { byPath, other } = form.splitFieldErrors(
      { $unknown: { code: "unknown_field" }, "buttons.$unknown": { code: "unknown_field" }, "buttons.7.id": { code: "duplicate" }, nothing: { code: "x" }, "buttons.0.nothing": { code: "y" }, "text.0": { code: "z" } },
      buttons,
      values,
    );
    assert.deepEqual(byPath, {});
    assert.deepEqual(other.map((o) => o.path).sort(), ["$unknown", "buttons.$unknown", "buttons.0.nothing", "buttons.7.id", "nothing", "text.0"]);
    assert.deepEqual(other.find((o) => o.path === "nothing").error, { code: "x" });
    assert.deepEqual(form.splitFieldErrors(null, buttons, values), { byPath: {}, other: [] });
  });
});

describe("curl and keys", () => {
  const text = () => plain(formats.describe("text"));

  test("JSON: the method, the URL, the key from the environment, one-line JSON in single quotes", () => {
    const out = form.curlExample({ url: "https://bot.example.org/api/v1/messages", descriptor: text() });
    const lines = out.split(" \\\n");
    assert.equal(lines.length, 4);
    assert.equal(lines[0], 'curl -X POST "https://bot.example.org/api/v1/messages"');
    assert.match(out, /-H "Authorization: Bearer \$OWB_KEY"/);
    assert.match(out, /-H "Content-Type: application\/json"/);
    assert.equal(form.API_KEY_ENV, "OWB_KEY");
    const json = /-d '(.*)'$/.exec(lines[3]);
    assert.ok(json, "the body is in single quotes on one line");
    assert.deepEqual(JSON.parse(json[1]), form.exampleBody(text()));
  });

  test("a single quote in the body is closed and reopened", () => {
    const out = form.curlExample({ url: "https://h/api/v1/messages", descriptor: text(), body: { format: "text", to: "237690000001", text: "it's fine" } });
    assert.ok(out.includes(`it'\\''s fine`));
    assert.equal(form.shellQuote("a'b"), `'a'\\''b'`);
    assert.equal(form.shellQuote("plain"), "'plain'");
  });

  test("multipart: the JSON is the message part and the file is the file part; no content type header", () => {
    const image = plain(formats.describe("image"));
    const out = form.curlExample({ url: "https://h/api/v1/messages", descriptor: image, fileName: "photo.jpg" });
    assert.match(out, /-F 'message=\{.*\};type=application\/json'/);
    assert.match(out, /-F 'file=@\.\/photo\.jpg'/);
    assert.ok(!out.includes("Content-Type"));
    assert.ok(out.includes("$OWB_KEY"));
  });

  test("the URL source puts a placeholder in media.url, never a real address", () => {
    const image = plain(formats.describe("image"));
    const out = form.curlExample({ url: "https://h/api/v1/messages", descriptor: image, source: "url", fileName: "photo.jpg" });
    assert.ok(out.includes('"media":{"url":"<url of the file>"}'));
    assert.ok(!out.includes("-F"));
    assert.ok(!/http:\/\/|https:\/\/(?!h\/)/.test(out.replace('curl -X POST "https://h/api/v1/messages"', "")));
  });

  test("fieldKeys follows the convention of the descriptor builder", () => {
    const keys = form.fieldKeys("buttons", "buttons.2.label");
    assert.equal(keys.label, "api.format.buttons.field.buttons.label.label");
    assert.equal(keys.hint, "api.format.buttons.field.buttons.label.hint");
    assert.equal(form.fieldKeys("text", ["mentions", 0]).label, "api.format.text.field.mentions.label");
    assert.equal(form.fieldKeys("common", "to").label, "api.format.common.field.to.label");
    assert.equal(form.fieldKeys("demo", "kind").option("a"), "api.format.demo.field.kind.option.a");
    assert.equal(form.fieldKeys("demo", "kind").placeholder, "api.format.demo.field.kind.placeholder");
  });

  test("panelKeysOfDescriptor of a real descriptor starts with its own two keys and has no duplicate", () => {
    for (const descriptor of realDescriptors()) {
      const keys = form.panelKeysOfDescriptor(descriptor);
      assert.deepEqual(keys.slice(0, 2), [`api.format.${descriptor.name}.label`, `api.format.${descriptor.name}.desc`]);
      assert.equal(new Set(keys).size, keys.length, descriptor.name);
      assert.ok(keys.includes("api.format.common.field.to.label"));
    }
  });
});

// ---------------------------------------------------------------------------
// Panel texts of the parameter table (contracts/panel-ui.md 11.4)
// ---------------------------------------------------------------------------

const PLACEHOLDERS = {
  "api.state_since": ["when"],
  "api.state_queued": ["count"],
  "api.state_bot_offline": ["minutes"],
  "api.state_paused": ["time"],
  "api.state_registry_failed": ["endpoint"],
  "api.disable_message": ["count"],
  "api.disable_done": ["cancelled"],
  "api.settings_spacing": ["seconds"],
  "api.settings_per_minute": ["count"],
  "api.settings_per_day": ["count"],
  "api.settings_pending": ["count"],
  "api.settings_queue_max": ["count"],
  "api.settings_expiry": ["minutes"],
  "api.settings_retention": ["days"],
  "api.settings_reply_window": ["days"],
  "api.networks_invalid_rows": ["rows"],
  "api.networks_not_private": ["rows"],
  "api.keys_purge_note": ["days"],
  "api.cell_rights": ["count"],
  "api.cell_rights_more": ["count"],
  "api.cell_policy_list": ["count"],
  "api.cell_limits": ["perDay", "perMinute", "pending"],
  "api.cell_ip_count": ["count"],
  "api.cell_expires": ["date"],
  "api.action_for": ["action", "name"],
  "api.duplicate_done": ["name"],
  "api.revoke_title": ["name"],
  "api.revoke_message": ["count"],
  "api.revoke_done": ["name", "cancelled"],
  "api.revoke_done_nocount": ["name"],
  "api.editor_title": ["name"],
  "api.editor_created": ["name"],
  "api.editor_saved": ["name"],
  "api.editor_pending": ["count"],
  "api.rights_all": ["group"],
  "api.rights_none": ["group"],
  "api.rights_orphan": ["id"],
  "api.rights_orphan_remove": ["id"],
  "api.recipients_remove": ["recipient"],
  "api.recipients_max": ["max"],
  "api.recipients_invalid_rows": ["rows"],
  "api.groups_pick": ["group"],
  "api.limits_default": ["value"],
  "api.ip_invalid_rows": ["rows"],
  "api.secret_for": ["name", "last4"],
  "reauth.message": ["minutes"],
  "api.history_no_content": ["days"],
  "api.detail_title": ["id"],
  "api.responses_window": ["days"],
  "api.responses_option": ["n"],
  "api.usage_totals": ["sent", "failed"],
  "api.usage_bar": ["day", "sent", "failed"],
  "api.usage_timezone": ["zone"],
  "api.test_bot_offline": ["minutes"],
  "api.test_queued": ["id"],
  "api.media_too_large": ["max"],
  "api.form_list_row": ["label", "n"],
  "audit.detail_api_key": ["name"],
  "audit.detail_api_source": ["id"],
  "audit.detail_api_policy": ["from", "to"],
  "audit.detail_api_changed": ["fields"],
  "audit.detail_api_widened": ["reasons"],
  "audit.detail_api_cancelled": ["count"],
  "audit.detail_networks": ["added", "removed"],
  "audit.detail_retry": ["retryAfter"],
};
const placeholdersOf = (text) => [...new Set(String(text).match(/\{[A-Za-z0-9_]+\}/g) || [])].map((token) => token.slice(1, -1)).sort();

describe("panel texts: the parameter table", () => {
  test("each key of the table exists in both languages with exactly the listed placeholders", () => {
    const problems = [];
    for (const [key, listed] of Object.entries(PLACEHOLDERS)) {
      for (const lang of ["en", "fr"]) {
        const text = CATALOGS[lang][key];
        if (typeof text !== "string") problems.push(`${key} missing in ${lang}`);
        else if (JSON.stringify(placeholdersOf(text)) !== JSON.stringify([...listed].sort())) problems.push(`${key} (${lang}): ${JSON.stringify(placeholdersOf(text))} instead of ${JSON.stringify([...listed].sort())}`);
      }
    }
    assert.deepEqual(problems, []);
  });

  test("a plural _one keeps the placeholders of its base, in both languages", () => {
    const problems = [];
    for (const lang of ["en", "fr"]) {
      for (const key of Object.keys(CATALOGS[lang]).filter((k) => /^(api|audit|reauth)\./.test(k) && k.endsWith("_one"))) {
        const base = key.slice(0, -4);
        if (typeof CATALOGS[lang][base] !== "string") problems.push(`${key} (${lang}) has no base`);
        else if (JSON.stringify(placeholdersOf(CATALOGS[lang][key])) !== JSON.stringify(placeholdersOf(CATALOGS[lang][base]))) problems.push(`${key} (${lang})`);
      }
    }
    assert.deepEqual(problems, []);
  });

  test("no panel text of the area carries a URL (the scan of test/admin-frontend.test.js reads the catalogs)", () => {
    const urls = [];
    for (const lang of ["en", "fr"]) {
      for (const [key, text] of Object.entries(CATALOGS[lang])) {
        if (/^(api|audit\.detail_api|audit\.prefix_api|reauth)\b/.test(key) && /https?:\/\/|(^|\s)\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(text)) urls.push(`${key} (${lang})`);
      }
    }
    assert.deepEqual(urls, []);
  });
});
