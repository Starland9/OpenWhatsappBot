"use strict";

/**
 * Format registry of the messaging API (feature 004, contracts/runtime.md sections 3.1-3.5).
 *
 * Loads every `formats/<name>.js` (this file excepted) in sorted order, once. A format is a module, not data
 * (FR-091): adding one needs only its file, its tests and its panel texts (FR-092, SC-009). The right of a
 * format is derived (`messages.send.<name>`) and never declared (RT-30); `schemaOf` and `describe` are built
 * from the same `fields`, so validation, documentation and the panel's test form cannot drift (RT-31).
 *
 *   load({ dir })            load (and validate) the modules; throws FormatRegistryError { file, reason } on the
 *                            first violation of 3.5 and keeps the previous state; no argument = memoised default
 *   list() / get(name)       rows { name, order, right, interactive, media } / the module or null
 *   rights()                 ["messages.send.text", ...] in list order
 *   rightsFor(name, input)   [right, "media.url" when input.media.url is present, ...module.requires(input)]
 *   schemaOf(name)           rule tree (schema.js dialect): common fields + the module's fields
 *   describe(name)           the form descriptor of 3.4 (pure, memoised, deeply frozen)
 *   doc(name)                { summary, description?, examples } (English, OpenAPI only)
 *   checkInput(name, body, { target })   schema check + media.url syntax + module refine + normalize (building
 *                            blocks of the facade's validateInput; the `quote` lookup stays with the facade)
 *   sizeOf(name, own, media)             the message `size` (public-api.md 4.1)
 *   createRegistry(options)  an independent registry (tests); the module's own exports are a default instance
 *
 * Module hooks (`refine`, `normalize`, `size`, `build`, `prepare`) receive the format's OWN fields (the checked
 * body restricted to the module's `fields`, defaults applied); `requires` receives the raw body, because the
 * pipeline calls it before validation and it must tolerate any input.
 *
 * Requires only lib/utils/schema.js, lib/messaging/{limits,sniff}.js and Node (RT-01, RT-04): no format module is
 * loaded until `load()`, and no heavy dependency is loaded by a module at require time.
 */

const fs = require("node:fs");
const path = require("node:path");
const { check } = require("../../utils/schema");
const { LIMITS } = require("../limits");

const FORMATS_DIR = __dirname;
const NAME_PATTERN = /^[a-z][a-z0-9_]{1,23}$/;
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const COMMON_FIELD_NAMES = Object.freeze(["format", "to", "quote", "media"]);
const RULE_TYPES = new Set(["string", "int", "number", "boolean", "array", "object"]);
const SOURCES = ["file", "url"];
const HINT_KEYS = ["type", "step", "placeholderKey", "patternHintKey"];
const OPTIONAL_FUNCTIONS = ["prepare", "refine", "normalize", "size", "requires"];
const PUBLIC_ID_PATTERN = /^msg_[A-Za-z0-9_-]{22}$/;

/** A module that violates 3.5: names the file (the message too) and the reason */
class FormatRegistryError extends Error {
  constructor(file, reason) {
    super(`format ${file}: ${reason}`);
    this.name = "FormatRegistryError";
    this.file = file;
    this.reason = reason;
  }
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Throws a plain Error (turned into a FormatRegistryError by the caller) when a rule tree is not valid */
function assertRule(rule, where) {
  if (!isPlainObject(rule)) throw new Error(`${where} is not a rule object`);
  if (!RULE_TYPES.has(rule.type)) throw new Error(`${where} has an unknown rule type`);
  if (rule.pattern !== undefined && !(rule.pattern instanceof RegExp)) throw new Error(`${where}.pattern is not a RegExp`);
  if (rule.enum !== undefined && !Array.isArray(rule.enum)) throw new Error(`${where}.enum is not an array`);
  if (rule.shape !== undefined) {
    if (!isPlainObject(rule.shape)) throw new Error(`${where}.shape is not an object`);
    for (const [key, nested] of Object.entries(rule.shape)) assertRule(nested, `${where}.shape.${key}`);
  }
  if (rule.items !== undefined) assertRule(rule.items, `${where}.items`);
}

function validateModule(mod, file, seen, kinds) {
  const fail = (reason) => new FormatRegistryError(file, reason);
  if (!isPlainObject(mod)) throw fail("the module must export an object");
  if (typeof mod.name !== "string" || !NAME_PATTERN.test(mod.name)) throw fail("invalid name");
  if (seen.has(mod.name)) throw fail("duplicate name");
  if (`${mod.name}.js` !== file) throw fail("name must be the basename of the file");
  if (mod.right !== undefined) throw fail("a format cannot declare a right (it is derived)");
  if (typeof mod.build !== "function") throw fail("build must be a function");
  if (typeof mod.order !== "number" || !Number.isFinite(mod.order)) throw fail("order must be a number");

  if (mod.fields !== undefined) {
    if (!isPlainObject(mod.fields)) throw fail("fields must be an object");
    for (const [key, rule] of Object.entries(mod.fields)) {
      if (COMMON_FIELD_NAMES.includes(key)) throw fail(`field ${key} collides with a common field`);
      if (!FIELD_NAME_PATTERN.test(key)) throw fail(`field ${key} has an invalid name`);
      try {
        assertRule(rule, `fields.${key}`);
      } catch (err) {
        throw fail(`fields: ${err.message}`);
      }
    }
  }

  if (mod.interactive !== undefined && typeof mod.interactive !== "boolean") throw fail("interactive must be a boolean");
  if (mod.interactive === true && typeof mod.interpretReply !== "function") throw fail("an interactive format needs interpretReply");
  if (mod.interpretReply !== undefined && typeof mod.interpretReply !== "function") throw fail("interpretReply must be a function");
  for (const key of OPTIONAL_FUNCTIONS) {
    if (mod[key] !== undefined && typeof mod[key] !== "function") throw fail(`${key} must be a function`);
  }

  if (mod.media !== undefined) {
    const media = mod.media;
    if (!isPlainObject(media)) throw fail("media must be an object");
    if (!Array.isArray(media.kinds) || media.kinds.length === 0 || !media.kinds.every((kind) => typeof kind === "string" && Object.hasOwn(kinds, kind))) {
      throw fail("media.kinds must be a non-empty list of known kinds");
    }
    if (!Number.isInteger(media.maxBytes) || media.maxBytes <= 0) throw fail("media.maxBytes must be a positive integer");
    if (media.sources !== undefined && (!Array.isArray(media.sources) || media.sources.length === 0 || !media.sources.every((s) => SOURCES.includes(s)))) {
      throw fail("media.sources must be a subset of file, url");
    }
  }
}

function commonRules(name, hasMedia) {
  return {
    format: { type: "string", required: true, enum: [name] },
    to: { type: "string", required: true, trim: true, minLength: 1, maxLength: 64 },
    quote: { type: "string", pattern: PUBLIC_ID_PATTERN },
    ...(hasMedia
      ? {
          media: {
            type: "object",
            shape: { url: { type: "string", required: true, minLength: 1, maxLength: LIMITS.MEDIA_URL } },
          },
        }
      : {}),
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function isAbsoluteUrl(text) {
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Key segment of a nested field: a field named like a text suffix (`label`, `hint`...) would put its own texts under
 * the parent's text key (`...buttons.label` and `...buttons.label.label`), which the catalogs forbid.
 */
const RESERVED_SEGMENTS = new Set(["label", "hint", "placeholder", "option"]);
const keySegment = (key) => (RESERVED_SEGMENTS.has(key) ? `${key}_field` : key);

/** Descriptor field of a rule (3.4). `parts` = the names joined by dots in the key, no index */
function deriveField(formatName, name, rule, parts, hints) {
  const base = `api.format.${formatName}.field.${parts.join(".")}`;
  let type;
  if (rule.type === "boolean") type = "boolean";
  else if (rule.type === "array") type = "list";
  else if (rule.type === "object") type = "group";
  else if (rule.enum) type = "select";
  else if (rule.type === "string") type = rule.maxLength > 255 ? "textarea" : "text";
  else type = "number";

  const field = { name, type, required: rule.required === true, labelKey: `${base}.label`, hintKey: `${base}.hint` };
  if (rule.type === "string") {
    if (rule.minLength !== undefined) field.min = rule.minLength;
    if (rule.maxLength !== undefined) field.max = rule.maxLength;
    if (rule.pattern) field.pattern = rule.pattern.source;
  } else if (rule.type === "int" || rule.type === "number") {
    if (rule.min !== undefined) field.min = rule.min;
    if (rule.max !== undefined) field.max = rule.max;
    if (typeof rule.min === "number" && rule.min < 0) field.signed = true;
  }
  if (rule.enum) field.options = rule.enum.map((value) => ({ value, labelKey: `${base}.option.${value}` }));
  if (rule.default !== undefined) field.default = rule.default;

  if (rule.type === "array") {
    if (rule.min !== undefined) field.min = rule.min;
    if (rule.max !== undefined) field.max = rule.max;
    const itemRule = rule.items;
    if (itemRule && itemRule.type === "object" && itemRule.shape) {
      field.items = {
        min: rule.min,
        max: rule.max,
        fields: Object.entries(itemRule.shape).map(([key, nested]) => deriveField(formatName, key, nested, [...parts, keySegment(key)], null)),
      };
    } else if (itemRule) {
      field.item = deriveField(formatName, name, itemRule, parts, null);
      field.item.required = true;
    }
  } else if (rule.type === "object" && rule.shape) {
    field.fields = Object.entries(rule.shape).map(([key, nested]) => deriveField(formatName, key, nested, [...parts, keySegment(key)], null));
  }

  if (hints) {
    for (const key of HINT_KEYS) if (hints[key] !== undefined) field[key] = hints[key];
  }
  return field;
}

/** An independent registry; the module exports a default instance (and `createRegistry` for the tests) */
function createRegistry(options = {}) {
  const defaultDir = path.resolve(options.dir || FORMATS_DIR);
  let loadedDir = null;
  let modules = new Map();
  let sorted = [];
  const memo = { schemas: new Map(), descriptors: new Map() };

  function readModules(dir) {
    const kinds = require("../sniff").KINDS;
    let files;
    try {
      files = fs
        .readdirSync(dir)
        .filter((file) => file.endsWith(".js") && file !== "index.js")
        .sort();
    } catch {
      throw new FormatRegistryError(path.basename(dir) || dir, "the formats directory cannot be read");
    }
    const loaded = new Map();
    for (const file of files) {
      const absolute = path.join(dir, file);
      let mod;
      try {
        if (dir !== FORMATS_DIR) delete require.cache[absolute];
        mod = require(absolute);
      } catch {
        throw new FormatRegistryError(file, "the module cannot be loaded");
      }
      validateModule(mod, file, loaded, kinds);
      loaded.set(mod.name, mod);
    }
    return loaded;
  }

  function load({ dir } = {}) {
    const explicit = dir !== undefined && dir !== null;
    const target = explicit ? path.resolve(dir) : defaultDir;
    if (!explicit && loadedDir === target) return;
    const next = readModules(target); // throws before touching the state
    modules = next;
    loadedDir = target;
    sorted = [...next.values()].sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    memo.schemas = new Map();
    memo.descriptors = new Map();
  }

  const ensure = () => {
    if (loadedDir === null) load();
  };

  function get(name) {
    ensure();
    return modules.get(name) || null;
  }

  function list() {
    ensure();
    return sorted.map((mod) => ({
      name: mod.name,
      order: mod.order,
      right: `messages.send.${mod.name}`,
      interactive: mod.interactive === true,
      media: Boolean(mod.media),
    }));
  }

  function rights() {
    return list().map((row) => row.right);
  }

  function rightsFor(name, input) {
    const mod = get(name);
    if (!mod) return [];
    const out = [`messages.send.${mod.name}`];
    const add = (right) => {
      if (typeof right === "string" && right && !out.includes(right)) out.push(right);
    };
    const body = input && typeof input === "object" ? input : null;
    if (body && body.media && typeof body.media === "object" && body.media.url !== undefined && body.media.url !== null) add("media.url");
    if (typeof mod.requires === "function") {
      let extra = [];
      try {
        extra = mod.requires(input) || [];
      } catch {
        extra = [];
      }
      if (Array.isArray(extra)) extra.forEach(add);
    }
    return out;
  }

  function schemaOf(name) {
    const mod = get(name);
    if (!mod) return null;
    if (!memo.schemas.has(name)) {
      const common = commonRules(name, Boolean(mod.media));
      const { format, to, quote, media } = common;
      memo.schemas.set(name, { format, to, ...(mod.fields || {}), quote, ...(media ? { media } : {}) });
    }
    return memo.schemas.get(name);
  }

  function describe(name) {
    const mod = get(name);
    if (!mod) return null;
    if (!memo.descriptors.has(name)) {
      const sniff = require("../sniff");
      const common = commonRules(name, false);
      const hints = (mod.form && mod.form.hints) || {};
      const own = Object.entries(mod.fields || {}).map(([key, rule]) => deriveField(name, key, rule, [key], hints[key]));
      const to = {
        name: "to",
        type: "recipient",
        required: true,
        labelKey: "api.format.common.field.to.label",
        hintKey: "api.format.common.field.to.hint",
        min: common.to.minLength,
        max: common.to.maxLength,
      };
      const quote = {
        name: "quote",
        type: "text",
        required: false,
        labelKey: "api.format.common.field.quote.label",
        hintKey: "api.format.common.field.quote.hint",
        pattern: PUBLIC_ID_PATTERN.source,
      };
      let media = null;
      if (mod.media) {
        const accept = new Set();
        for (const kind of mod.media.kinds) for (const mime of sniff.KINDS[kind]) accept.add(mime);
        const caption = mod.fields && mod.fields.caption;
        media = {
          sources: (mod.media.sources || SOURCES).slice(),
          accept: [...accept].sort(),
          maxBytes: mod.media.maxBytes,
          captionMax: caption && caption.maxLength !== undefined ? caption.maxLength : null,
        };
      }
      const examples = mod.doc && Array.isArray(mod.doc.examples) ? mod.doc.examples : [];
      memo.descriptors.set(
        name,
        deepFreeze({
          name,
          right: `messages.send.${name}`,
          interactive: mod.interactive === true,
          order: mod.order,
          labelKey: `api.format.${name}.label`,
          descKey: `api.format.${name}.desc`,
          media,
          example: examples.length ? clone(examples[0]) : {},
          fields: [to, ...own, quote],
        }),
      );
    }
    return memo.descriptors.get(name);
  }

  function doc(name) {
    const mod = get(name);
    if (!mod) return null;
    const source = mod.doc || {};
    const out = { summary: typeof source.summary === "string" ? source.summary : name, examples: clone(Array.isArray(source.examples) ? source.examples : []) };
    if (typeof source.description === "string") out.description = source.description;
    return deepFreeze(out);
  }

  function checkInput(name, body, { target = null } = {}) {
    const mod = get(name);
    if (!mod) {
      const allowed = sorted.map((m) => m.name);
      return { value: {}, own: {}, fields: { format: { code: "not_allowed", params: { allowed } } }, mediaMarker: false };
    }
    const { value, fields } = check(body, schemaOf(name));
    const errors = { ...fields };
    const failed = () => Object.keys(errors).length > 0;
    const merge = (extra) => {
      if (!isPlainObject(extra)) return;
      for (const [key, error] of Object.entries(extra)) if (!Object.hasOwn(errors, key)) errors[key] = error;
    };

    // registry-wide refine: the URL marker must be a syntactically valid absolute URL
    if (mod.media && value.media && typeof value.media.url === "string" && !isAbsoluteUrl(value.media.url)) {
      merge({ "media.url": { code: "invalid_format" } });
    }

    let own = {};
    for (const key of Object.keys(mod.fields || {})) if (Object.hasOwn(value, key)) own[key] = value[key];

    if (typeof mod.refine === "function") {
      try {
        merge(mod.refine(own, { target }));
      } catch (err) {
        // a refine meets partial input when the schema already failed; on valid input a throw is a bug
        if (!failed()) throw err;
      }
    }
    if (!failed() && typeof mod.normalize === "function") own = mod.normalize(own, { target });

    return { value, own, fields: errors, mediaMarker: Boolean(value.media && typeof value.media.url === "string") };
  }

  function sizeOf(name, own, media) {
    const mod = get(name);
    if (!mod) return null;
    if (typeof mod.size === "function") {
      const size = mod.size(own, media);
      return size === undefined ? null : size;
    }
    return media && Number.isFinite(media.size) ? media.size : null;
  }

  return { load, list, get, rights, rightsFor, schemaOf, describe, doc, checkInput, sizeOf };
}

const defaultRegistry = createRegistry();

module.exports = {
  load: defaultRegistry.load,
  list: defaultRegistry.list,
  get: defaultRegistry.get,
  rights: defaultRegistry.rights,
  rightsFor: defaultRegistry.rightsFor,
  schemaOf: defaultRegistry.schemaOf,
  describe: defaultRegistry.describe,
  doc: defaultRegistry.doc,
  checkInput: defaultRegistry.checkInput,
  sizeOf: defaultRegistry.sizeOf,
  createRegistry,
  FormatRegistryError,
  COMMON_FIELD_NAMES,
};
