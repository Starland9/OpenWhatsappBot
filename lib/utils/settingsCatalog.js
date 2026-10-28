"use strict";

/**
 * Settings catalog (contracts/settings-catalog.md, contracts/runtime.md section 1).
 *
 * The single source for validation, panel forms, restore checks, API-key tests and the parity
 * tests: 101 entries (67 editable, 13 startup, 21 inactive; 22 secrets; 5 with effect "restart").
 * It imports no project module and no database model, so config.js can load it before Sequelize
 * models exist; the only imports are Node built-ins, and luxon / lang/*.json are read lazily by the
 * validators that need them.
 *
 * Values travel in three shapes (settings-catalog.md 2.2):
 *   - raw      the environment / SettingOverride.value string ("true", "3", "a,b")
 *   - api      typed JSON: boolean, integer, array of strings for lists, string otherwise
 *   - config   what config.X returns: the api value, except lists, which stay comma-joined strings
 * parse(raw) -> api | undefined, serialize(api) -> raw, toConfig(api) -> config.
 * validate(api, ctx) -> null | { code, params } with the field codes of admin-http-api.md 1.9.
 * Submitted values are never echoed: params carry limits, allowed values and indices only.
 *
 * Exports: entries, byKey (Map), themes, crossValidators, ruleSummary(entry), toConfig(entry, api),
 * defaultOf(entry, get), needsConfirm(entry, next, current), unescapeNewlines.
 */

const fs = require("fs");
const net = require("net");
const path = require("path");

const THEMES = Object.freeze([
  "general",
  "behavior",
  "api-keys",
  "responder",
  "moderation",
  "limits",
  "advanced",
  "boot",
  "alerts",
  "inactive",
]);

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];

/** Unquoted values in config.env keep a literal "\n": turn it into a real newline */
const unescapeNewlines = (text) => String(text).replace(/\\n/g, "\n");

// ---------------------------------------------------------------------------
// Validation rules (settings-catalog.md section 6)
// ---------------------------------------------------------------------------

const err = (code, params) => (params ? { code, params } : { code });
const codePoints = (text) => [...text].length;

let langNames = null;
/** Names of lang/*.json, read once and lazily (R-lang) */
function languageNames() {
  if (!langNames) {
    try {
      langNames = fs
        .readdirSync(path.join(__dirname, "..", "..", "lang"))
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.slice(0, -5))
        .sort();
    } catch (error) {
      langNames = ["en", "fr"];
    }
  }
  return langNames;
}

let luxonInfo = null;
const isValidZone = (zone) => {
  if (!luxonInfo) luxonInfo = require("luxon").Info;
  return luxonInfo.isValidIANAZone(zone);
};

const PHONE_RE = /^\d{6,15}$/;
const JID_RE = /^\d{6,20}(:\d{1,3})?@(s\.whatsapp\.net|c\.us|lid)$/;
const NUMLIST_RE = /^\+?\d{6,15}$/;
const CHAT_NUMBER_RE = /^\+?\d{6,16}$/;
const CHAT_JID_RE = /^[^@\s]+@(s\.whatsapp\.net|g\.us|lid)$/;
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣)+$/u;
const PICTO_RE = /\p{Extended_Pictographic}/u;
const REGIONAL_RE = /\p{Regional_Indicator}/gu;
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,80}$/;
const VISIBLE_ASCII_RE = /^[\x21-\x7E]*$/;
const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0009\u000b-\u001f\u007f]/;

/** Indices (positions in the submitted array) of the items failing `bad` */
const badIndices = (items, bad) => {
  const out = [];
  items.forEach((item, index) => {
    if (bad(item)) out.push(index);
  });
  return out;
};

/** Each rule: { summary, check(value) -> null | error, normalize?(value) }. `check` runs after the type check. */
const rules = {
  /** PREFIX: 1 to 3 code points, no whitespace, control or format character */
  prefix: () => ({
    summary: { minChars: 1, maxChars: 3, noWhitespace: true },
    check(value) {
      const length = codePoints(value);
      if (length < 1) return err("required");
      if (length > 3) return err("too_long", { max: 3 });
      if (!/^[^\s\p{C}]+$/u.test(value)) return err("invalid_format", { reason: "whitespace" });
      return null;
    },
    normalize: (value) => value,
  }),

  /** BOT_LANG: a file name of lang/, lower-cased */
  lang: () => ({
    get summary() {
      return { enum: languageNames().slice() };
    },
    check(value) {
      const allowed = languageNames();
      return allowed.includes(String(value).toLowerCase()) ? null : err("not_allowed", { allowed: allowed.slice() });
    },
    normalize: (value) => String(value).toLowerCase(),
  }),

  /** SUDO: at most 20 numbers or JIDs; panel-normalised (no "+", lower case, de-duplicated by user part) */
  sudo: () => {
    const clean = (item) => item.trim().replace(/^\+/, "").toLowerCase();
    return {
      summary: { maxItems: 20, itemPattern: "phone-or-jid" },
      check(value) {
        if (value.length > 20) return err("too_many_items", { max: 20 });
        const indices = badIndices(value, (item) => {
          const cleaned = clean(item);
          return !(PHONE_RE.test(cleaned) || JID_RE.test(cleaned));
        });
        return indices.length ? err("invalid_phone", { indices }) : null;
      },
      normalize(value) {
        const seen = new Set();
        const out = [];
        for (const item of value) {
          const cleaned = clean(item);
          const user = cleaned.split(/[:@]/)[0];
          if (seen.has(user)) continue;
          seen.add(user);
          out.push(cleaned);
        }
        return out;
      },
    };
  },

  /** TIMEZONE: an IANA zone, at most 64 characters */
  tz: () => ({
    summary: { maxChars: 64, format: "iana-zone" },
    check: (value) => (value.length <= 64 && isValidZone(value) ? null : err("invalid_timezone")),
    normalize: (value) => value,
  }),

  /** Integers within bounds */
  int: (min, max, extra = {}) => ({
    summary: { min, max, ...extra },
    check: (value) => (value >= min && value <= max ? null : err("out_of_range", { min, max })),
    normalize: (value) => value,
  }),

  /** Plain string length bounds (code points) */
  length: (min, max) => ({
    summary: { minChars: min, maxChars: max },
    check(value) {
      const length = codePoints(value);
      if (length < min) return err(min > 0 ? "required" : "too_short", min > 0 ? undefined : { min });
      if (length > max) return err("too_long", { max });
      return null;
    },
    normalize: (value) => value,
  }),

  /** Fixed enumeration */
  enum: (values) => ({
    summary: { enum: values.slice() },
    check: (value) => (values.includes(value) ? null : err("not_allowed", { allowed: values.slice() })),
    normalize: (value) => value,
  }),

  /** STATUS_EMOJIS: 1 to 30 emoji sequences */
  emoji: () => ({
    summary: { minItems: 1, maxItems: 30, maxUnits: 16 },
    check(value) {
      if (value.length < 1) return err("required");
      if (value.length > 30) return err("too_many_items", { max: 30 });
      const indices = badIndices(value, (item) => {
        if (item.length > 16 || /[,\s]/.test(item) || !EMOJI_RE.test(item)) return true;
        const flags = item.match(REGIONAL_RE);
        return !(PICTO_RE.test(item) || (flags && flags.length >= 2));
      });
      return indices.length ? err("invalid_emoji", { indices }) : null;
    },
    normalize: (value) => value,
  }),

  /** API keys and tokens: visible ASCII; empty means "cleared" */
  secret: (min, max) => ({
    summary: { minChars: min, maxChars: max, charset: "visible-ascii", allowEmpty: true },
    check(value) {
      if (value === "") return null;
      if (!VISIBLE_ASCII_RE.test(value)) return err("invalid_format");
      if (value.length < min) return err("too_short", { min });
      if (value.length > max) return err("too_long", { max });
      return null;
    },
    normalize: (value) => value,
  }),

  /** AI model names */
  model: (allowEmpty) => ({
    summary: { pattern: MODEL_RE.source, maxChars: 80, allowEmpty },
    check(value) {
      if (value === "") return allowEmpty ? null : err("required");
      if (value.length > 80) return err("too_long", { max: 80 });
      return MODEL_RE.test(value) ? null : err("invalid_format");
    },
    normalize: (value) => value,
  }),

  /** BACKEND_URL: empty or a plain http(s) URL */
  url: () => ({
    summary: { schemes: ["http", "https"], maxChars: 2048, allowEmpty: true },
    check(value) {
      if (value === "") return null;
      if (value.length > 2048 || /\s/.test(value)) return err("invalid_url");
      try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") return err("invalid_url");
        if (url.username || url.password || url.hash || value.includes("#")) return err("invalid_url");
        return null;
      } catch (error) {
        return err("invalid_url");
      }
    },
    normalize: (value) => value,
  }),

  /** PANEL_PUBLIC_URL: an http(s) origin, no path, query or fragment */
  origin: () => ({
    summary: { schemes: ["http", "https"], originOnly: true, allowEmpty: true },
    check(value) {
      if (value === "") return null;
      try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") return err("invalid_url");
        if (url.pathname !== "/" || url.search || url.hash || value.includes("#") || value.includes("?")) {
          return err("invalid_url");
        }
        return null;
      } catch (error) {
        return err("invalid_url");
      }
    },
    normalize: (value) => (value.endsWith("/") ? value.slice(0, -1) : value),
  }),

  /** Message templates: length bounds, no control character but \n, known "&token"s only */
  tpl: (min, max, tokens) => ({
    summary: { minChars: min, maxChars: max, tokens: tokens.slice() },
    check(value) {
      const length = codePoints(value);
      if (length < min) return err("required");
      if (length > max) return err("too_long", { max });
      if (CONTROL_RE.test(value)) return err("invalid_format", { reason: "control" });
      const unknown = [];
      for (const match of value.matchAll(/&[a-z]+/g)) {
        if (!tokens.includes(match[0]) && !unknown.includes(match[0])) unknown.push(match[0]);
      }
      return unknown.length ? err("unknown_variable", { names: unknown }) : null;
    },
    normalize: (value) => value,
  }),

  /** Phone number lists (ignore list, status save list); digitsOnly strips the "+" */
  numlist: (digitsOnly) => ({
    summary: { itemPattern: NUMLIST_RE.source, digitsOnly: !!digitsOnly },
    check(value) {
      const indices = badIndices(value, (item) => !NUMLIST_RE.test(item.replace(/\s+/g, "")));
      return indices.length ? err("invalid_phone", { indices }) : null;
    },
    normalize(value) {
      const out = [];
      for (const item of value) {
        let cleaned = item.replace(/\s+/g, "");
        if (digitsOnly) cleaned = cleaned.replace(/^\+/, "");
        if (!out.includes(cleaned)) out.push(cleaned);
      }
      return out;
    },
  }),

  /** ANTIDELETE_JID / VIEWONCE_JID: a JID or a number; empty means none */
  chatjid: () => ({
    summary: { itemPattern: `${CHAT_JID_RE.source}|${CHAT_NUMBER_RE.source}`, allowEmpty: true },
    check(value) {
      if (value === "") return null;
      return CHAT_JID_RE.test(value) || CHAT_NUMBER_RE.test(value) ? null : err("invalid_jid");
    },
    normalize: (value) => value,
  }),

  /** PANEL_HOST: an IP literal or a host name; empty means automatic */
  host: () => ({
    summary: { maxChars: 253, allowEmpty: true },
    check(value) {
      if (value === "") return null;
      return net.isIP(value) || HOSTNAME_RE.test(value) ? null : err("invalid_format");
    },
    normalize: (value) => value,
  }),

  /** PANEL_TRUST_PROXY: IPs, CIDR ranges and the keywords loopback, private, all */
  trust: () => ({
    summary: { allowEmpty: true, keywords: ["loopback", "private", "all"] },
    check(value) {
      const indices = badIndices(value, (item) => {
        const text = item.trim();
        if (["loopback", "private", "all"].includes(text.toLowerCase())) return false;
        if (net.isIP(text)) return false;
        const [address, bits, extra] = text.split("/");
        const family = net.isIP(address);
        if (!family || extra !== undefined || !/^\d{1,3}$/.test(bits || "")) return true;
        return Number(bits) > (family === 4 ? 32 : 128);
      });
      return indices.length ? err("invalid_format", { indices }) : null;
    },
    normalize: (value) => value,
  }),
};

// ---------------------------------------------------------------------------
// Type handling
// ---------------------------------------------------------------------------

/** `invalid_type` when the JSON value does not have the entry's type, else null */
function checkType(entry, value) {
  switch (entry.type) {
    case "bool":
      return typeof value === "boolean" ? null : err("invalid_type");
    case "int":
      return Number.isSafeInteger(value) ? null : err("invalid_type");
    case "list":
      return Array.isArray(value) && value.every((item) => typeof item === "string") ? null : err("invalid_type");
    default:
      return typeof value === "string" ? null : err("invalid_type");
  }
}

/** Raw string -> api value, or undefined when unparsable (never throws) */
function parseRaw(entry, raw) {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw);
  switch (entry.type) {
    case "bool":
      // default-false: true only for "true"; default-true: false only for "false"
      return entry.default === true ? text !== "false" : text === "true";
    case "int": {
      const trimmed = text.trim();
      if (!/^\d{1,15}$/.test(trimmed)) return undefined;
      return Number(trimmed);
    }
    case "list":
      return text
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "");
    case "enum":
      return text.trim().toLowerCase();
    default:
      return text;
  }
}

/** api value -> raw string stored in SettingOverride.value */
function serializeValue(entry, value) {
  if (entry.type === "list") return Array.isArray(value) ? value.join(",") : String(value);
  return String(value);
}

/** api value -> what config.X returns (lists stay comma-joined strings) */
function toConfig(entry, value) {
  return entry.type === "list" && Array.isArray(value) ? value.join(",") : value;
}

// ---------------------------------------------------------------------------
// Entry construction
// ---------------------------------------------------------------------------

const DEFAULTS_BY_TYPE = { bool: false, int: 0, list: [], enum: "", string: "", text: "", url: "" };

/**
 * Fill the entry shape of settings-catalog.md section 1 and compile its validator.
 * `rule` is a rules.* instance; `envLenient` entries keep a legacy environment value that only
 * fails the type-level parse (short test keys, SUDO numbers of any length...).
 */
function entry(spec) {
  const rule = spec.rule || null;
  const secret = !!spec.secret;
  const result = {
    key: spec.key,
    env: spec.env === undefined ? spec.key : spec.env,
    envAliases: spec.envAliases || [],
    configProp: spec.configProp || spec.key,
    theme: spec.theme,
    type: spec.type,
    default: spec.derived ? null : spec.default === undefined ? DEFAULTS_BY_TYPE[spec.type] : spec.default,
    derived: spec.derived || null,
    unit: spec.unit || null,
    secret,
    mask: spec.mask || (secret ? "last4" : "none"),
    effect: spec.effect || "immediate",
    readonly: !!spec.readonly,
    inactive: !!spec.inactive,
    source: spec.source || "env",
    adapter: spec.adapter || null,
    confirm: spec.confirm || null,
    testService: spec.testService || null,
    fileTransform: spec.fileTransform || null,
    onChange: spec.onChange || [],
    flags: spec.flags || [],
    // tier-3 (environment/file) tolerance, see settingsStore
    envLenient: !!spec.envLenient || secret || !!spec.inactive,
    rules: null,
  };

  // a getter: the R-lang summary reads lang/ only when somebody asks for it
  Object.defineProperty(result, "rules", {
    enumerable: true,
    configurable: true,
    get: () => ({ ...(rule ? rule.summary : {}) }),
  });

  result.parse = (raw) => parseRaw(result, raw);
  result.serialize = (value) => serializeValue(result, value);
  result.toConfig = (value) => toConfig(result, value);
  result.validate = (value, ctx) => {
    const typeError = checkType(result, value);
    if (typeError) return typeError;
    return rule ? rule.check(value, ctx) : null;
  };
  result.normalize = (value) => (rule && rule.normalize ? rule.normalize(value) : value);
  return result;
}

const SAME_AS = /^same_as:(.+)$/;

/** Default of an entry as an api value; `get(key)` returns config values (for derived defaults) */
function defaultOf(item, get) {
  if (item.derived) {
    const same = SAME_AS.exec(item.derived);
    if (same) return get ? get(same[1]) : "";
    return ""; // auto_host: decided by runtime.resolveBind
  }
  return item.type === "list" ? item.default.slice() : item.default;
}

/** True when `next` (api value) needs the entry's confirmation token (SET-2 `confirm`) */
function needsConfirm(item, next, currentConfig) {
  if (!item.confirm) return false;
  if (item.confirm === "owners_empty") {
    const nextEmpty = Array.isArray(next) ? next.length === 0 : next === "";
    const wasEmpty = String(currentConfig || "").trim() === "";
    return nextEmpty && !wasEmpty;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 5.1-5.8 Editable entries (67)
// ---------------------------------------------------------------------------

const MIN_CHARS_FOR_SECRET = 8;
const DEFAULT_EMOJIS = ["😀", "👍", "❤️", "🔥", "💯", "✨", "🎉", "👏", "💪", "🙌"];
const DEFAULT_WARN_MESSAGE = "⚠️WARNING⚠️\n*User:* &mention\n*Warn:* &warn\n*Remaining:* &remaining";
const KEY_RULE = () => rules.secret(MIN_CHARS_FOR_SECRET, 256);
const ID_RULE = () => rules.secret(MIN_CHARS_FOR_SECRET, 128);

const apiKey = (key, testService, extra = {}) =>
  entry({ key, theme: "api-keys", type: "string", secret: true, rule: KEY_RULE(), testService, ...extra });

const general = [
  entry({ key: "PREFIX", theme: "general", type: "string", default: ".", rule: rules.prefix() }),
  entry({
    key: "SUDO",
    theme: "general",
    type: "list",
    default: [],
    rule: rules.sudo(),
    confirm: "owners_empty",
    envLenient: true,
  }),
  entry({
    key: "BOT_LANG",
    configProp: "LANG",
    theme: "general",
    type: "enum",
    default: "fr",
    rule: rules.lang(),
    onChange: ["languageReload"],
  }),
  entry({
    key: "TIMEZONE",
    theme: "general",
    type: "string",
    default: "UTC",
    rule: rules.tz(),
    onChange: ["recomputeRecurrences"],
  }),
  entry({ key: "STICKER_PACKNAME", theme: "general", type: "string", default: "Made with", rule: rules.length(0, 64) }),
  entry({
    key: "STICKER_AUTHOR",
    theme: "general",
    type: "string",
    default: "Bot",
    rule: rules.length(0, 64),
    flags: ["default-differs"],
  }),
];

const behavior = [
  entry({ key: "ALWAYS_ONLINE", theme: "behavior", type: "bool", default: false, effect: "restart" }),
  entry({
    key: "AUTO_STATUS_VIEW",
    theme: "behavior",
    type: "bool",
    default: false,
    flags: ["default-differs"],
  }),
  entry({ key: "AUTO_STATUS_REACT", theme: "behavior", type: "bool", default: false }),
  entry({ key: "STATUS_EMOJIS", theme: "behavior", type: "list", default: DEFAULT_EMOJIS, rule: rules.emoji() }),
  entry({
    key: "AUTO_STATUS_SAVE",
    theme: "behavior",
    type: "bool",
    default: false,
    source: "file",
    adapter: "statusSave",
    flags: ["not-in-example", "seed"],
  }),
  entry({
    key: "STATUS_SAVE_LIST",
    theme: "behavior",
    type: "list",
    default: [],
    rule: rules.numlist(true),
    source: "file",
    adapter: "statusSave",
    flags: ["not-in-example", "seed"],
  }),
  entry({
    key: "ENABLE_MESSAGE_REACTIONS",
    theme: "behavior",
    type: "bool",
    default: false,
    flags: ["default-differs"],
  }),
  entry({
    key: "ANTIDELETE_MODE",
    env: null,
    theme: "behavior",
    type: "enum",
    default: "off",
    rule: rules.enum(["off", "p", "g", "sudo", "jid"]),
    source: "model",
    adapter: "antiDelete",
  }),
  entry({
    key: "ANTIDELETE_JID",
    env: null,
    theme: "behavior",
    type: "string",
    default: "",
    rule: rules.chatjid(),
    source: "model",
    adapter: "antiDelete",
  }),
  entry({
    key: "VIEWONCE_MODE",
    env: null,
    theme: "behavior",
    type: "enum",
    default: "off",
    rule: rules.enum(["off", "p", "g", "jid"]),
    source: "model",
    adapter: "viewOnce",
  }),
  entry({
    key: "VIEWONCE_JID",
    env: null,
    theme: "behavior",
    type: "string",
    default: "",
    rule: rules.chatjid(),
    source: "model",
    adapter: "viewOnce",
  }),
];

const apiKeys = [
  apiKey("OPENAI_API_KEY", "openai"),
  apiKey("GEMINI_API_KEY", "gemini", { onChange: ["resetGeminiClient"] }),
  apiKey("WEATHER_API_KEY", "weather"),
  apiKey("UNSPLASH_API_KEY", "unsplash"),
  apiKey("GIPHY_API_KEY", "giphy"),
  apiKey("NEWS_API_KEY", "news"),
  apiKey("ALPHA_VANTAGE_KEY", null),
  entry({
    key: "SPOTIFY_CLIENT_ID",
    theme: "api-keys",
    type: "string",
    rule: ID_RULE(),
    envLenient: true,
    testService: "spotify",
    onChange: ["resetSpotifyToken"],
  }),
  apiKey("SPOTIFY_CLIENT_SECRET", "spotify", { rule: ID_RULE(), onChange: ["resetSpotifyToken"] }),
  entry({
    key: "REDDIT_CLIENT_ID",
    theme: "api-keys",
    type: "string",
    rule: ID_RULE(),
    envLenient: true,
    testService: "reddit",
    onChange: ["resetRedditToken"],
  }),
  apiKey("REDDIT_CLIENT_SECRET", "reddit", { rule: ID_RULE(), onChange: ["resetRedditToken"] }),
  entry({
    key: "GEMINI_MODEL",
    theme: "api-keys",
    type: "string",
    default: "gemini-2.5-flash",
    rule: rules.model(false),
  }),
  entry({
    key: "GEMINI_VISION_MODEL",
    theme: "api-keys",
    type: "string",
    derived: "same_as:GEMINI_MODEL",
    rule: rules.model(true),
  }),
  entry({ key: "IMAGE_MODEL", theme: "api-keys", type: "string", default: "", rule: rules.model(true) }),
  entry({ key: "OPENAI_MODEL", theme: "api-keys", type: "string", default: "gpt-4o-mini", rule: rules.model(false) }),
  // a file value may carry credentials (legacy): kept, and displayed with mask: url
  entry({ key: "BACKEND_URL", theme: "api-keys", type: "url", default: "", rule: rules.url(), mask: "url", envLenient: true }),
];

const responder = [
  entry({
    key: "AUTO_RESPONDER_ENABLED",
    theme: "responder",
    type: "bool",
    default: false,
    source: "model",
    adapter: "autoResponder",
    flags: ["seed"],
  }),
  entry({
    key: "AUTO_RESPONDER_IGNORE_NUMBERS",
    theme: "responder",
    type: "list",
    default: [],
    rule: rules.numlist(false),
    source: "model",
    adapter: "autoResponder",
    flags: ["seed"],
  }),
  entry({
    key: "AUTO_RESPONDER_PERSONALITY",
    theme: "responder",
    type: "text",
    default: "You are a helpful and friendly assistant. Respond naturally and conversationally.",
    rule: rules.length(1, 2000),
    source: "model",
    adapter: "autoResponder",
    flags: ["seed"],
  }),
  entry({
    key: "AUTO_RESPONDER_MIN_DELAY",
    theme: "responder",
    type: "int",
    default: 1000,
    unit: "ms",
    rule: rules.int(0, 600000, { notAbove: "AUTO_RESPONDER_MAX_DELAY" }),
  }),
  entry({
    key: "AUTO_RESPONDER_MAX_DELAY",
    theme: "responder",
    type: "int",
    default: 3000,
    unit: "ms",
    rule: rules.int(0, 600000, { notBelow: "AUTO_RESPONDER_MIN_DELAY" }),
  }),
  entry({
    key: "AUTO_RESPONDER_TYPING_SPEED",
    theme: "responder",
    type: "int",
    default: 50,
    unit: "chars/s",
    rule: rules.int(1, 1000),
  }),
  entry({
    key: "AUTO_RESPONDER_MAX_TYPING_TIME",
    theme: "responder",
    type: "int",
    default: 10000,
    unit: "ms",
    rule: rules.int(0, 120000),
  }),
  entry({ key: "AUTO_RESPONDER_RATE_LIMIT", theme: "responder", type: "int", default: 5, rule: rules.int(1, 1000) }),
  entry({
    key: "AUTO_RESPONDER_RATE_WINDOW",
    theme: "responder",
    type: "int",
    default: 60000,
    unit: "ms",
    rule: rules.int(1000, 86400000),
  }),
];

const moderation = [
  entry({ key: "WARN_LIMIT", theme: "moderation", type: "int", default: 3, rule: rules.int(1, 50) }),
  entry({
    key: "WARN_MESSAGE",
    theme: "moderation",
    type: "text",
    default: DEFAULT_WARN_MESSAGE,
    rule: rules.tpl(1, 1000, ["&mention", "&warn", "&remaining"]),
    fileTransform: "unescapeNewlines",
  }),
  entry({
    key: "WARN_KICK_MESSAGE",
    theme: "moderation",
    type: "text",
    default: "&mention kicked",
    rule: rules.tpl(1, 500, ["&mention"]),
    fileTransform: "unescapeNewlines",
  }),
  entry({
    key: "ANTILINK_MSG",
    theme: "moderation",
    type: "text",
    default: "_Antilink Detected &mention kicked_",
    rule: rules.tpl(1, 500, ["&mention"]),
  }),
  entry({
    key: "ANTIBOT_MSG",
    theme: "moderation",
    type: "text",
    default: "&mention removed",
    rule: rules.tpl(1, 500, ["&mention"]),
  }),
];

const limits = [
  entry({ key: "MAX_UPLOAD", theme: "limits", type: "int", default: 230, unit: "MB", rule: rules.int(1, 2000) }),
  entry({
    key: "DOWNLOAD_TIMEOUT",
    theme: "limits",
    type: "int",
    default: 180000,
    unit: "ms",
    rule: rules.int(10000, 1800000),
  }),
  entry({
    key: "TTS_MAX_LENGTH",
    theme: "limits",
    type: "int",
    default: 500,
    unit: "chars",
    rule: rules.int(50, 5000),
    flags: ["not-in-example"],
  }),
  entry({
    key: "MESSAGE_CONCURRENCY_LIMIT",
    theme: "limits",
    type: "int",
    default: 5,
    rule: rules.int(1, 50),
    flags: ["not-in-example"],
  }),
  entry({
    key: "BROADCAST_DELAY_MS",
    env: null,
    theme: "limits",
    type: "int",
    default: 5000,
    unit: "ms",
    rule: rules.int(2000, 600000),
  }),
];

const advanced = [
  entry({
    key: "LOG_LEVEL",
    theme: "advanced",
    type: "enum",
    default: "info",
    rule: rules.enum(LOG_LEVELS),
    onChange: ["setLogLevel"],
  }),
  entry({
    key: "BAILEYS_LOG_LVL",
    theme: "advanced",
    type: "enum",
    default: "silent",
    rule: rules.enum(LOG_LEVELS),
    effect: "restart",
  }),
  entry({
    key: "CACHE_CLEANUP_INTERVAL",
    theme: "advanced",
    type: "int",
    default: 600000,
    unit: "ms",
    rule: rules.int(10000, 86400000),
    effect: "restart",
    flags: ["not-in-example"],
  }),
  entry({
    key: "CACHE_MAX_AGE",
    theme: "advanced",
    type: "int",
    default: 3600000,
    unit: "ms",
    rule: rules.int(60000, 86400000),
    flags: ["not-in-example"],
  }),
  entry({
    key: "CONVERSATION_UPDATE_INTERVAL",
    theme: "advanced",
    type: "int",
    default: 2000,
    unit: "ms",
    rule: rules.int(500, 60000),
    effect: "restart",
    flags: ["not-in-example"],
  }),
  entry({
    key: "CONVERSATION_BATCH_SIZE",
    theme: "advanced",
    type: "int",
    default: 5,
    rule: rules.int(1, 100),
    flags: ["not-in-example"],
  }),
  entry({
    key: "MEMORY_CLEANUP_INTERVAL",
    theme: "advanced",
    type: "int",
    default: 900000,
    unit: "ms",
    rule: rules.int(60000, 86400000),
    effect: "restart",
    flags: ["not-in-example"],
  }),
  entry({
    key: "MEMORY_WARN_THRESHOLD",
    theme: "advanced",
    type: "int",
    default: 400,
    unit: "MB",
    rule: rules.int(50, 16384),
    flags: ["not-in-example"],
  }),
  entry({
    key: "PANEL_TOKEN",
    theme: "advanced",
    type: "string",
    secret: true,
    rule: rules.secret(16, 256),
  }),
];

const alert = (key) => entry({ key, env: null, theme: "alerts", type: "bool", default: true });
const alerts = [
  alert("ALERT_RECONNECT"),
  alert("ALERT_ERROR_BURST"),
  alert("ALERT_KEY_REFUSED"),
  alert("ALERT_LOGIN_BLOCKED"),
  alert("ALERT_NEW_ORIGIN"),
  alert("ALERT_UPDATE"),
];

// ---------------------------------------------------------------------------
// 5.9 Startup entries (13, read-only, boot-only)
// ---------------------------------------------------------------------------

const boot = (spec) =>
  entry({ theme: "boot", readonly: true, effect: "boot-only", envLenient: true, ...spec });

const startup = [
  boot({ key: "ADMIN_PANEL", type: "bool", default: true }),
  boot({ key: "PANEL_HOST", type: "string", derived: "auto_host", envAliases: ["HOST"], rule: rules.host() }),
  boot({
    key: "PANEL_PORT",
    type: "int",
    default: 3000,
    envAliases: ["PORT"],
    rule: rules.int(1, 65535),
    envLenient: false,
  }),
  boot({ key: "PANEL_PUBLIC_URL", type: "url", default: "", rule: rules.origin(), envLenient: false }),
  boot({ key: "PANEL_TRUST_PROXY", type: "list", default: [], rule: rules.trust(), envLenient: false }),
  boot({
    key: "KEEP_ALIVE_INTERVAL",
    type: "int",
    default: 60000,
    unit: "ms",
    rule: rules.int(5000, 600000),
    envLenient: false,
  }),
  boot({
    key: "LOG_FORMAT",
    type: "enum",
    default: "pretty",
    rule: rules.enum(["pretty", "json"]),
    envLenient: false,
  }),
  boot({
    key: "SUPERVISED",
    type: "enum",
    default: "auto",
    rule: rules.enum(["auto", "true", "false"]),
    envLenient: false,
  }),
  boot({ key: "UPDATE_CHECK", type: "bool", default: true }),
  boot({ key: "DATABASE_URL", type: "string", default: "", secret: true, mask: "scheme" }),
  boot({ key: "DATABASE_SSL", type: "bool", default: true }),
  boot({ key: "YTDLP_PATH", type: "string", default: "yt-dlp" }),
  boot({ key: "SESSION_DIR", env: null, type: "string", default: "sessions/main" }),
];

// ---------------------------------------------------------------------------
// 5.10 Inactive entries (21, read-only; no code reads them today)
// ---------------------------------------------------------------------------

const dead = (spec) =>
  entry({ theme: "inactive", inactive: true, readonly: true, effect: "boot-only", ...spec });
const deadKey = (key) => dead({ key, type: "string", default: "", secret: true });

const inactive = [
  deadKey("SESSION_ID"),
  dead({ key: "AUTO_READ", type: "bool", default: false, flags: ["default-differs"] }),
  dead({ key: "STATUS_SAVE_FOLDER", type: "string", default: "media/status", flags: ["not-in-example"] }),
  dead({ key: "ANTI_DELETE", type: "bool", default: false }),
  dead({ key: "VPS", type: "bool", default: false, flags: ["default-differs"] }),
  deadKey("GROQ_API_KEY"),
  deadKey("RMBG_KEY"),
  deadKey("CLOUDMERSIVE_API_KEY"),
  deadKey("APYHUB_API_KEY"),
  deadKey("DEEPAI_API_KEY"),
  deadKey("WAIFUPICS_API_KEY"),
  deadKey("PUTERJS_API_KEY"),
  dead({ key: "IMAGE_API_TIMEOUT", type: "int", default: 20000, unit: "ms" }),
  dead({ key: "IMAGE_API_MAX_SIZE_MB", type: "int", default: 10, unit: "MB" }),
  dead({ key: "HEROKU_APP_NAME", type: "string", default: "" }),
  deadKey("HEROKU_API_KEY"),
  dead({ key: "KOYEB", type: "bool", default: false }),
  dead({ key: "KOYEB_NAME", type: "string", default: "" }),
  deadKey("KOYEB_API"),
  dead({ key: "RENDER_NAME", type: "string", default: "" }),
  deadKey("RENDER_API_KEY"),
];

/** Every entry, in display order (editable, then startup, then inactive) */
const entries = Object.freeze([
  ...general,
  ...behavior,
  ...apiKeys,
  ...responder,
  ...moderation,
  ...limits,
  ...advanced,
  ...alerts,
  ...startup,
  ...inactive,
]);

/** key -> entry (a Map: user-supplied keys such as "__proto__" cannot hit the prototype) */
const byKey = new Map(entries.map((item) => [item.key, item]));

// ---------------------------------------------------------------------------
// Cross-field rules
// ---------------------------------------------------------------------------

/**
 * fn(projected, batchKeys) -> { [key]: { code, params } } | null
 * `projected(key)` is the config value after the batch; `batchKeys` the keys the batch writes.
 */
const crossValidators = Object.freeze([
  function responderDelays(projected, batchKeys) {
    const min = projected("AUTO_RESPONDER_MIN_DELAY");
    const max = projected("AUTO_RESPONDER_MAX_DELAY");
    if (!(Number.isFinite(min) && Number.isFinite(max)) || min <= max) return null;
    const out = {};
    if (batchKeys.has("AUTO_RESPONDER_MIN_DELAY")) {
      out.AUTO_RESPONDER_MIN_DELAY = err("bound_conflict", { other: "AUTO_RESPONDER_MAX_DELAY" });
    }
    if (batchKeys.has("AUTO_RESPONDER_MAX_DELAY")) {
      out.AUTO_RESPONDER_MAX_DELAY = err("bound_conflict", { other: "AUTO_RESPONDER_MIN_DELAY" });
    }
    return Object.keys(out).length ? out : null;
  },
]);

/** The `rules` shipped to the SPA for pre-validation (the server stays authoritative) */
function ruleSummary(item) {
  return item.rules;
}

module.exports = {
  entries,
  byKey,
  themes: THEMES,
  crossValidators,
  ruleSummary,
  toConfig,
  defaultOf,
  needsConfirm,
  unescapeNewlines,
};
