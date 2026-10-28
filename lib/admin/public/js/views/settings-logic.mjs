// Pure logic of the settings view (SET-1 / SET-2 of contracts/admin-http-api.md 2.5, contracts/settings-catalog.md):
// grouping by theme, the form state, the diff of the changed fields into a SET-2 payload (with the version of each
// setting), client-side pre-validation from the `rules` of the catalog, and reading the API errors.
// No DOM access and no import: node:test loads this file. The server stays authoritative; the pre-validation only
// spares a round trip for the common mistakes (same field codes as the API, so the same texts apply).

/** Functional themes in display order; `boot` is read-only, `inactive` is the folded group of flagged entries. */
export const THEME_ORDER = ["general", "behavior", "api-keys", "responder", "moderation", "limits", "advanced", "alerts", "boot"];
export const INACTIVE_THEME = "inactive";

/** The JID key of a mode/JID pair -> its mode key (anti-delete and view-once store both in one row) */
export const JID_MODE = { ANTIDELETE_JID: "ANTIDELETE_MODE", VIEWONCE_JID: "VIEWONCE_MODE" };
/** Enumerations whose values are labelled in the catalog of the panel (`settings.mode.<value>`) */
export const MODE_KEYS = ["ANTIDELETE_MODE", "VIEWONCE_MODE"];

export const MAX_CHANGES = 50;

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const codePoints = (text) => Array.from(String(text)).length;
const clone = (value) => (Array.isArray(value) ? value.slice() : value);

// ---- grouping ---------------------------------------------------------------------------------------

/** An entry the administrator may change (the API refuses a write to the others) */
export function isEditable(setting) {
  return Boolean(setting) && !setting.readonly && !setting.inactive && setting.effect !== "boot-only";
}

/**
 * Settings grouped by theme, in display order. Flagged entries (`inactive`) all go to the last, folded group
 * "sans effet aujourd'hui", whatever their functional theme. Empty groups are left out.
 * @returns {Array<{ theme: string, folded: boolean, items: object[] }>}
 */
export function groupSettings(settings) {
  const groups = [];
  const list = Array.isArray(settings) ? settings : [];
  for (const theme of THEME_ORDER) {
    const items = list.filter((s) => !s.inactive && s.theme === theme);
    if (items.length) groups.push({ theme, folded: false, items });
  }
  const inactive = list.filter((s) => s.inactive || s.theme === INACTIVE_THEME);
  if (inactive.length) groups.push({ theme: INACTIVE_THEME, folded: true, items: inactive });
  return groups;
}

/** Where a setting's value comes from, as the badge says it: default, env (file/environment), panel, bot */
export function originKind(setting) {
  if (setting.origin === "default") return "default";
  if (setting.origin === "env") return "env";
  // an adapter-backed value is written by the bot's commands and by the panel alike: "enregistré par le bot"
  return setting.source === "env" ? "panel" : "bot";
}

// ---- list parsing -------------------------------------------------------------------------------------

/** A pasted "a, b\nc; d" -> ["a", "b", "c", "d"]. Spaces stay inside an item ("+237 600 000 001"). */
export function parseList(text) {
  return String(text === undefined || text === null ? "" : text)
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** The items of a list control as the API wants them: pasted lists split, trimmed, empty rows dropped */
export function cleanList(items) {
  return (Array.isArray(items) ? items : []).flatMap((item) => parseList(item));
}

export function valuesEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => item === b[index]);
  }
  return a === b;
}

// ---- form state ---------------------------------------------------------------------------------------

/**
 * `{ values, secrets }`: `values[key]` is what the control shows (a boolean, a number, a string, an array of
 * strings); `secrets[key]` is `{ draft, cleared }` for the write-only entries (never the stored value).
 */
export function initialForm(settings) {
  const values = {};
  const secrets = {};
  for (const setting of settings || []) {
    if (setting.secret) secrets[setting.key] = { draft: "", cleared: false };
    else values[setting.key] = clone(setting.value);
  }
  return { values, secrets };
}

export function setValue(form, key, value) {
  return { ...form, values: { ...form.values, [key]: value } };
}

export function setSecret(form, key, patch) {
  const current = form.secrets[key] || { draft: "", cleared: false };
  return { ...form, secrets: { ...form.secrets, [key]: { ...current, ...patch } } };
}

/** The form with `keys` taken back from the server's settings (after a save, a reload or a conflict) */
export function resetKeys(form, settings, keys) {
  const next = { values: { ...form.values }, secrets: { ...form.secrets } };
  for (const key of keys) {
    const setting = (settings || []).find((s) => s.key === key);
    if (!setting) continue;
    if (setting.secret) next.secrets[key] = { draft: "", cleared: false };
    else next.values[key] = clone(setting.value);
  }
  return next;
}

/**
 * The form after the settings were replaced by a fresher list: a field the administrator did not touch follows the
 * new server value (so a later save cannot silently undo somebody else's change); an edited field keeps its draft.
 */
export function rebaseForm(form, previous, next) {
  const before = new Map((previous || []).map((s) => [s.key, s]));
  const out = { values: {}, secrets: {} };
  for (const setting of next || []) {
    if (setting.secret) {
      out.secrets[setting.key] = form.secrets[setting.key] ? { ...form.secrets[setting.key] } : { draft: "", cleared: false };
      continue;
    }
    const old = before.get(setting.key);
    const draft = has(form.values, setting.key) ? form.values[setting.key] : undefined;
    const untouched = draft === undefined || !old || valuesEqual(sendable(setting, draft), sendable(setting, old.value));
    out.values[setting.key] = untouched ? clone(setting.value) : draft;
  }
  return out;
}

/** The keys that change together with `key` (a mode and its JID share one row and one version) */
export function pairKeys(key) {
  const mode = JID_MODE[key] || (MODE_KEYS.includes(key) ? key : null);
  return mode ? [mode, ...Object.keys(JID_MODE).filter((jid) => JID_MODE[jid] === mode)] : [key];
}

/** The JID field of a mode/JID pair only means something while the mode is `jid` */
export function jidApplies(setting, form, settings) {
  const modeKey = JID_MODE[setting.key];
  if (!modeKey) return true;
  const mode = has(form.values, modeKey) ? form.values[modeKey] : (settings || []).find((s) => s.key === modeKey)?.value;
  return mode === "jid";
}

// ---- diff ---------------------------------------------------------------------------------------------

/** The value a changed control would send, in the API's typing */
function sendable(setting, value) {
  return setting.type === "list" ? cleanList(value) : value;
}

/** Has this setting been changed in the form? */
export function isChanged(setting, form, settings) {
  if (!isEditable(setting)) return false;
  if (setting.secret) {
    const secret = form.secrets[setting.key];
    return Boolean(secret && (secret.cleared || secret.draft !== ""));
  }
  if (!has(form.values, setting.key)) return false;
  if (!jidApplies(setting, form, settings)) return false;
  return !valuesEqual(sendable(setting, form.values[setting.key]), setting.type === "list" ? cleanList(setting.value) : setting.value);
}

/**
 * The SET-2 changes for what was edited: `{ key, op: "set", value, version }`, and `op: "default"` for a secret the
 * administrator asked to clear. A secret is sent only when something was typed. Nothing for unchanged fields.
 */
export function diffChanges(settings, form) {
  const changes = [];
  for (const setting of settings || []) {
    if (!isChanged(setting, form, settings)) continue;
    if (setting.secret) {
      const secret = form.secrets[setting.key];
      if (secret.draft !== "") changes.push({ key: setting.key, op: "set", value: secret.draft, version: setting.version });
      else changes.push({ key: setting.key, op: "default", version: setting.version });
    } else {
      changes.push({ key: setting.key, op: "set", value: sendable(setting, form.values[setting.key]), version: setting.version });
    }
  }
  return changes;
}

/** The SET-2 body, or null when nothing changed */
export function buildPayload(settings, form, { confirm } = {}) {
  const changes = diffChanges(settings, form);
  if (!changes.length) return null;
  const body = { changes };
  if (confirm && confirm.length) body.confirm = confirm.slice();
  return body;
}

/** One immediate action on one setting: "default" (reset to the catalog default) or "revert" (back to the file) */
export function singleChange(setting, op) {
  return { changes: [{ key: setting.key, op, version: setting.version }] };
}

/** Keys with something to save, per theme (the tab badges) */
export function changeCounts(settings, form) {
  const counts = {};
  for (const setting of settings || []) {
    if (isChanged(setting, form, settings)) counts[setting.theme] = (counts[setting.theme] || 0) + 1;
  }
  return counts;
}

/** Would the saved batch empty the owner list (SUDO)? The UI asks before sending it. */
export function emptiesOwners(settings, form) {
  const sudo = (settings || []).find((s) => s.key === "SUDO");
  if (!sudo || !isChanged(sudo, form, settings)) return false;
  return cleanList(form.values.SUDO).length === 0 && cleanList(sudo.value).length > 0;
}

// ---- client-side pre-validation ----------------------------------------------------------------------

const visibleAscii = /^[\x21-\x7E]*$/;

/**
 * Cheap checks from the catalog `rules`; the same codes as the API's field errors. Returns null when the value looks
 * valid (the server still decides).
 * @param {object} setting a ResolvedSetting
 * @param {*} value the value of the control (secrets: the typed draft)
 */
export function validateField(setting, value) {
  const rules = setting.rules || {};
  const err = (code, params) => (params ? { code, params } : { code });

  if (setting.type === "bool") return typeof value === "boolean" ? null : err("invalid_type");

  if (setting.type === "int") {
    if (value === null || value === undefined || value === "") return err("required");
    if (typeof value !== "number" || !Number.isInteger(value)) return err("invalid_type");
    if ((rules.min !== undefined && value < rules.min) || (rules.max !== undefined && value > rules.max)) {
      return err("out_of_range", { min: rules.min, max: rules.max });
    }
    return null;
  }

  if (setting.type === "enum") {
    if (Array.isArray(rules.enum) && !rules.enum.includes(value)) return err("not_allowed", { allowed: rules.enum.slice() });
    return null;
  }

  if (setting.type === "list") {
    const items = cleanList(value);
    if (rules.minItems !== undefined && items.length < rules.minItems) return err("required");
    if (rules.maxItems !== undefined && items.length > rules.maxItems) return err("too_many_items", { max: rules.maxItems });
    if (typeof rules.itemPattern === "string" && /^\^.*\$$/.test(rules.itemPattern) && !rules.itemPattern.includes("|")) {
      let pattern = null;
      try {
        pattern = new RegExp(rules.itemPattern);
      } catch {
        pattern = null;
      }
      if (pattern) {
        const indices = [];
        items.forEach((item, index) => {
          if (!pattern.test(item.replace(/\s+/g, ""))) indices.push(index);
        });
        if (indices.length) return err("invalid_phone", { indices });
      }
    }
    return null;
  }

  // string, text, url
  const text = value === null || value === undefined ? "" : String(value);
  if (text === "") {
    if (rules.allowEmpty) return null;
    if (rules.minChars !== undefined && rules.minChars > 0) return err("required");
    return null;
  }
  const length = codePoints(text);
  if (rules.minChars !== undefined && length < rules.minChars) return err(setting.secret ? "too_short" : "required", setting.secret ? { min: rules.minChars } : undefined);
  if (rules.maxChars !== undefined && length > rules.maxChars) return err("too_long", { max: rules.maxChars });
  if (rules.charset === "visible-ascii" && !visibleAscii.test(text)) return err("invalid_format");
  if (rules.noWhitespace && /\s/u.test(text)) return err("invalid_format", { reason: "whitespace" });
  if (typeof rules.pattern === "string") {
    try {
      if (!new RegExp(rules.pattern).test(text)) return err("invalid_format");
    } catch {
      // an unreadable pattern is left to the server
    }
  }
  if (Array.isArray(rules.schemes)) {
    try {
      const url = new URL(text);
      if (!rules.schemes.includes(url.protocol.replace(/:$/, ""))) return err("invalid_url");
    } catch {
      return err("invalid_url");
    }
  }
  if (Array.isArray(rules.tokens)) {
    const unknown = [...new Set(text.match(/&[a-z]+/g) || [])].filter((token) => !rules.tokens.includes(token));
    if (unknown.length) return err("unknown_variable", { names: unknown });
  }
  return null;
}

/** Pre-validation of every changed field (and of the min/max delay pair): `{ [key]: { code, params } }` */
export function validateForm(settings, form) {
  const problems = {};
  for (const setting of settings || []) {
    if (!isChanged(setting, form, settings)) continue;
    if (setting.secret) {
      const secret = form.secrets[setting.key];
      if (secret.draft !== "") {
        const problem = validateField(setting, secret.draft);
        if (problem) problems[setting.key] = problem;
      }
      continue;
    }
    const value = setting.type === "list" ? cleanList(form.values[setting.key]) : form.values[setting.key];
    const problem = validateField(setting, value);
    if (problem) problems[setting.key] = problem;
  }
  // AUTO_RESPONDER_MIN_DELAY <= AUTO_RESPONDER_MAX_DELAY (rules.notAbove / rules.notBelow name the other key)
  const current = (key) => {
    const found = (settings || []).find((s) => s.key === key);
    if (!found) return undefined;
    return has(form.values, key) ? form.values[key] : found.value;
  };
  for (const setting of settings || []) {
    const rules = setting.rules || {};
    const other = rules.notAbove || rules.notBelow;
    if (!other || has(problems, setting.key)) continue;
    const mine = current(setting.key);
    const theirs = current(other);
    if (typeof mine !== "number" || typeof theirs !== "number") continue;
    const bad = rules.notAbove ? mine > theirs : mine < theirs;
    if (bad && (isChanged(setting, form, settings) || isChanged((settings || []).find((s) => s.key === other), form, settings))) {
      problems[setting.key] = { code: "bound_conflict", params: { other } };
    }
  }
  return problems;
}

// ---- reading the API ---------------------------------------------------------------------------------

/** `error.fields` of a validation_failed / conflict answer as `{ [key]: { code, params } }` */
export function fieldErrorsFromError(error) {
  const out = {};
  const fields = error && error.fields && typeof error.fields === "object" ? error.fields : {};
  for (const [key, value] of Object.entries(fields)) {
    if (value && typeof value.code === "string") out[key] = { code: value.code, ...(value.params ? { params: value.params } : {}) };
  }
  return out;
}

/** `{ [key]: currentVersion }` for the stale settings of a 409 conflict answer */
export function conflictVersions(error) {
  const out = {};
  for (const [key, value] of Object.entries(fieldErrorsFromError(error))) {
    if (value.code === "conflict") out[key] = value.params && Number.isInteger(value.params.version) ? value.params.version : null;
  }
  return out;
}

/** 409 confirmation_required that asks for the owners confirmation */
export function isOwnersConfirmation(error) {
  return Boolean(error && error.code === "confirmation_required" && error.params && Array.isArray(error.params.confirm) && error.params.confirm.includes("owners_empty"));
}

/** The theme (tab) holding a key, to show the first error */
export function themeOf(settings, key) {
  const found = (settings || []).find((s) => s.key === key);
  if (!found) return null;
  return found.inactive ? INACTIVE_THEME : found.theme;
}

/** Replace the settings of `updated` (same keys) in `list`, keeping the order */
export function mergeSettings(list, updated) {
  const byKey = new Map((updated || []).map((s) => [s.key, s]));
  return (list || []).map((s) => (byKey.has(s.key) ? byKey.get(s.key) : s));
}

// ---- display ------------------------------------------------------------------------------------------

/** A value as plain text (lists joined, booleans and empty values left to the caller) */
export function plainValue(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (value === null || value === undefined) return "";
  return String(value);
}

/** What the "default" line says: a value, a derived rule or nothing */
export function describeDefault(setting) {
  if (setting.derived) {
    const same = /^same_as:(.+)$/.exec(setting.derived);
    if (same) return { kind: "same_as", other: same[1] };
    return { kind: setting.derived };
  }
  if (setting.secret) return { kind: "none" };
  return { kind: "value", value: setting.default };
}

/** The Test button belongs to the key that holds the credential of a testable service (hidden for Alpha Vantage) */
export function canTest(setting) {
  return Boolean(setting && setting.testService && setting.secret);
}

/** Badge tone of a key-test verdict */
export function verdictTone(verdict) {
  return verdict === "accepted" ? "ok" : verdict === "refused" ? "danger" : "warn";
}

/** Catalog unit -> the suffix of its label key ("chars/s" -> "chars_per_s") */
export function unitKey(unit) {
  return String(unit).replace(/\//g, "_per_");
}

/** Services listed by the catalog, once each, in display order (the keys a test covers) */
export function testableServices(settings) {
  const services = new Map();
  for (const setting of settings || []) {
    if (!setting.testService) continue;
    if (!services.has(setting.testService)) services.set(setting.testService, []);
    services.get(setting.testService).push(setting.key);
  }
  return [...services].map(([id, keys]) => ({ id, keys }));
}
