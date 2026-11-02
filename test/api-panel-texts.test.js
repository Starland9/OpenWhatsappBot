"use strict";
/**
 * The panel texts that come from the registries (feature 004, contracts/panel-ui.md 11.4, FR-092, SC-009): a new
 * format, right or failure code needs its texts added to the panel catalogs and nothing else, so this file walks the
 * REAL registries and demands every key in both languages. A temporary demo format without texts must fail, naming
 * the key.
 *
 *   - every key of every real descriptor (`panelKeysOfDescriptor`), `api.format.<name>.label|desc`;
 *   - `api.right.<id>.label|desc` for every right of the catalogue, `api.right_group.<group>`;
 *   - `api.failure.<code>` for FAILURE_CODES, CANCEL_REASONS and UNKNOWN_REASONS;
 *   - the descriptor keys of one format form a prefix-free set (a catalog text may not be the prefix of another key,
 *     test/admin-i18n.test.js and tools/merge-panel-i18n.js);
 *   - the dynamic families the views use: statuses, key states, reasons.
 */

process.env.OWB_NO_CONFIG_ENV = process.env.OWB_NO_CONFIG_ENV || "1";

const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const CATALOGS = Object.fromEntries(["en", "fr"].map((lang) => [lang, readJson(path.join(ROOT, "lib", "admin", "public", "i18n", `${lang}.json`))]));

const formats = require("../lib/messaging/formats");
const messagingErrors = require("../lib/messaging/errors");

let form;
before(async () => {
  form = await import(pathToFileURL(path.join(ROOT, "lib", "admin", "public", "js", "views", "api-form-logic.mjs")).href);
});

const plain = (value) => JSON.parse(JSON.stringify(value)); // what API-3 serves

/** The rights the catalogue lists: the format rights plus the fixed ones, plus those of the endpoint modules when present. */
function catalogueRights() {
  const rights = new Set([...formats.rights(), "messages.read", "media.url", "api.docs"]);
  const dir = path.join(ROOT, "lib", "api", "endpoints");
  if (fs.existsSync(dir)) {
    const { loadEndpoints } = require("../lib/api/registry");
    for (const right of loadEndpoints({ dir, formats }).rights) rights.add(right.id);
  }
  return [...rights];
}

/** Every key a registry needs (formats and rights), as `key` strings. */
function keysOfRegistry(registry) {
  const keys = [];
  for (const row of registry.list()) {
    const descriptor = plain(registry.describe(row.name));
    keys.push(`api.format.${row.name}.label`, `api.format.${row.name}.desc`, `api.right.${descriptor.right}.label`, `api.right.${descriptor.right}.desc`);
    keys.push(...form.panelKeysOfDescriptor(descriptor));
  }
  return [...new Set(keys)];
}

/** "key (lang)" for every key a catalog lacks or leaves empty. */
function missing(keys, catalogs = CATALOGS) {
  const out = [];
  for (const key of keys) for (const lang of ["en", "fr"]) if (typeof catalogs[lang][key] !== "string" || catalogs[lang][key].trim() === "") out.push(`${key} (${lang})`);
  return out;
}

/** Pairs [text key, key nested under it]: a catalog text may not be the prefix of another key. */
function prefixConflicts(keys) {
  const set = new Set(keys);
  const out = [];
  for (const key of set) for (const other of set) if (other !== key && other.startsWith(`${key}.`)) out.push(`"${key}" is a text and "${other}" nests under it`);
  return out;
}

describe("formats and rights", () => {
  test("the registry has the 13 formats, so the texts below are all of them", () => {
    assert.equal(formats.list().length, 13);
  });

  test("every key of every real descriptor exists in both catalogs (label, hint, placeholder, options, format label and desc)", () => {
    assert.deepEqual(missing(keysOfRegistry(formats)), []);
  });

  test("the keys of a format form a prefix-free set, so the catalogs can hold all of them", () => {
    const problems = [];
    for (const row of formats.list()) problems.push(...prefixConflicts(form.panelKeysOfDescriptor(plain(formats.describe(row.name)))).map((p) => `${row.name}: ${p}`));
    assert.deepEqual(problems, [], "a nested field named like a leaf (label, hint, placeholder, option) collides with the key of its parent");
  });

  test("api.right.<id>.label and .desc exist for every right of the catalogue (the 13 send rights, messages.read, media.url, api.docs)", () => {
    const rights = catalogueRights();
    assert.ok(rights.length >= 16, `${rights.length} rights`);
    for (const wanted of ["messages.read", "media.url", "api.docs", "messages.send.text", "messages.send.list"]) assert.ok(rights.includes(wanted), wanted);
    assert.deepEqual(missing(rights.flatMap((id) => [`api.right.${id}.label`, `api.right.${id}.desc`])), []);
  });

  test("api.right_group.<group> exists for the four groups, and api.right_group_other for the rest", () => {
    assert.deepEqual(missing([...["send", "read", "media", "docs"].map((group) => `api.right_group.${group}`), "api.right_group_other"]), []);
  });
});

describe("failures and statuses", () => {
  test("api.failure.<code> exists for FAILURE_CODES, CANCEL_REASONS and UNKNOWN_REASONS (14 codes)", () => {
    const codes = [...Object.keys(messagingErrors.FAILURE_CODES), ...Object.keys(messagingErrors.CANCEL_REASONS), ...Object.keys(messagingErrors.UNKNOWN_REASONS)];
    assert.equal(new Set(codes).size, 14);
    assert.deepEqual(missing(codes.map((code) => `api.failure.${code}`)), []);
  });

  test("the dynamic families of the views: message statuses, key states, step-up reasons", () => {
    const statuses = ["queued", "sending", "sent", "delivered", "read", "failed", "expired", "cancelled", "unknown"];
    assert.deepEqual([...messagingErrors.STATUSES].sort(), [...statuses].sort(), "the nine statuses of the engine are the nine texts");
    assert.deepEqual(
      missing([
        ...statuses.map((status) => `api.msg_status.${status}`),
        ...["active", "expired", "revoked"].map((state) => `api.key_state.${state}`),
        ...["enable", "create", "rights", "policy", "ip", "expiry", "plain_http"].map((reason) => `api.reason_${reason}`),
      ]),
      [],
    );
  });
});

describe("a new format needs its texts and nothing else (FR-092, SC-009)", () => {
  const demoSource = `"use strict";
module.exports = {
  name: "demo",
  order: 999,
  interactive: false,
  fields: {
    title: { type: "string", required: true, minLength: 1, maxLength: 20 },
    tags: { type: "array", max: 3, items: { type: "string", minLength: 1, maxLength: 10 } },
  },
  build() { return { content: { text: "x" } }; },
  doc: { summary: "A demo", examples: [{ format: "demo", to: "237690000001", title: "t" }] },
};
`;

  function withDemo(run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-demo-format-"));
    try {
      fs.writeFileSync(path.join(dir, "demo.js"), demoSource);
      const registry = formats.createRegistry({ dir });
      registry.load({ dir });
      return run(registry);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a demo format without texts fails, naming the keys it needs", () => {
    withDemo((registry) => {
      const lacking = missing(keysOfRegistry(registry));
      for (const key of ["api.format.demo.label", "api.format.demo.desc", "api.right.messages.send.demo.label", "api.right.messages.send.demo.desc", "api.format.demo.field.title.label", "api.format.demo.field.title.hint", "api.format.demo.field.tags.label"]) {
        assert.ok(lacking.includes(`${key} (en)`) && lacking.includes(`${key} (fr)`), `${key} is reported in both languages`);
      }
      assert.ok(lacking.every((entry) => entry.startsWith("api.format.demo.") || entry.startsWith("api.right.messages.send.demo.")), "only the demo format is reported");
    });
  });

  test("with its texts added to the catalogs, and nothing else, the same format passes", () => {
    withDemo((registry) => {
      const extra = {};
      for (const key of keysOfRegistry(registry)) if (/^api\.(format|right)\.(demo|messages\.send\.demo)\b/.test(key)) extra[key] = `text of ${key}`;
      const catalogs = { en: { ...CATALOGS.en, ...extra }, fr: { ...CATALOGS.fr, ...extra } };
      assert.deepEqual(missing(keysOfRegistry(registry), catalogs), []);
      assert.deepEqual(prefixConflicts(Object.keys(extra)), []);
    });
  });
});
