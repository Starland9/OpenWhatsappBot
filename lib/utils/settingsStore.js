"use strict";

/**
 * Settings store (contracts/runtime.md section 1, data-model 1.4).
 *
 * The synchronous in-memory source behind every `config.X` accessor. A key resolves, first match wins:
 *   1. runtime assignment  `config.KEY = v` (tests only, never persisted)
 *   2. panel override      a row of `setting_overrides`, loaded in memory by load()
 *   3. environment / file  process.env (dotenv has already merged config.env), parsed by the catalog
 *   4. catalog default     `default`, or the derived default (GEMINI_VISION_MODEL follows GEMINI_MODEL)
 *
 * Before load() the store behaves exactly like the old config.js (tiers 3 and 4). It requires no model
 * and no other project module at load time: models, the secret box and the redactor are injected by
 * load(), or required lazily (secretBox, the redactor leaf, logger, maintenanceMode).
 *
 * Reads are property lookups. Writes (set, unset, reload, importOverrides) are serialized by
 * mutex("settings"), validated as a whole batch before anything is written, applied in one transaction
 * and only then copied to memory; listeners of `change` are isolated from each other and from the write.
 *
 * Field codes follow admin-http-api.md 1.9: `unknown_setting`, `readonly`, `not_applicable`, `conflict`
 * and the per-rule codes of the catalog. Errors carry codes and parameters, never a submitted value.
 */

const EventEmitter = require("events");
const catalogModule = require("./settingsCatalog");
const { withLock } = require("./mutex");

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class SettingsError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = this.constructor.name;
    this.code = code;
  }
}

/** At least one field is invalid; nothing was written. `fields: { KEY: { code, params } }` */
class SettingsValidationError extends SettingsError {
  constructor(fields) {
    super("validation_failed");
    this.fields = fields;
  }
}

/** A stale version (or a lost insert race): HTTP 409 conflict */
class SettingsConflictError extends SettingsError {
  constructor(keys, fields) {
    super("conflict");
    this.keys = keys;
    this.fields = fields || {};
  }
}

/** A risky change lacks its confirmation token: HTTP 409 confirmation_required */
class SettingsConfirmationError extends SettingsError {
  constructor(confirm) {
    super("confirmation_required");
    this.params = { confirm };
  }
}

/** db_unavailable | busy | secret_storage_unavailable */
class SettingsStoreError extends SettingsError {
  constructor(code, cause) {
    super(code);
    if (cause) this.cause = cause;
  }
}

/** Define an own enumerable property even for a key such as "__proto__" */
function setField(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET_CONTEXT = (key) => `setting:${key}`;

/** Credentials, query and fragment removed (mask: url) */
function maskUrl(value) {
  if (typeof value !== "string" || value === "") return value;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch (error) {
    return "";
  }
}

/** Password part of a URL value, or "" */
function urlPassword(value) {
  try {
    const url = new URL(String(value));
    if (!url.password) return "";
    try {
      return decodeURIComponent(url.password);
    } catch (error) {
      return url.password;
    }
  } catch (error) {
    return "";
  }
}

const clone = (value) => (Array.isArray(value) ? value.slice() : value);

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class SettingsStore extends EventEmitter {
  /**
   * @param {object} [options] injectable for tests: catalog, env, models, secretBox, redactor, logger,
   *   maintenanceMode, now
   */
  constructor(options = {}) {
    super();
    const catalog = options.catalog || catalogModule;
    this.catalog = catalog;
    this.byKey = catalog.byKey;
    this._envSource = options.env || null; // null: process.env at first use
    this._models = options.models || null;
    this._box = options.secretBox || null;
    this._redactorInstance = options.redactor || null;
    this._loggerInstance = options.logger || null;
    this._maintenance = options.maintenanceMode || null;
    this._nowFn = options.now || null;

    this._env = null; // key -> { api, config, name }, built lazily
    this._envProblems = new Map();
    this._runtime = new Map();
    this._rows = new Map(); // key -> { stored, version, updatedAt }  every valid row, decryptable or not
    this._overrides = new Map(); // key -> { raw, api, version }       effective overrides (secrets in clear)
    this._overrideProblems = new Map();
    this._lastVersion = new Map(); // key -> last known version, kept after a reset (ABA guard)
    this._inForce = null; // Map, set by markInForce()
    this._validators = [...catalog.crossValidators];
    this._loaded = false;
    this._loggedUndecryptable = new Set();
    this._getter = (key) => this._configOf(key);
  }

  // ----- collaborators (lazy) ---------------------------------------------

  _now() {
    return this._nowFn ? Number(this._nowFn()) : Date.now();
  }

  _secretBox() {
    if (!this._box) this._box = require("./secretBox");
    return this._box;
  }

  _redactor() {
    if (!this._redactorInstance) {
      try {
        this._redactorInstance = require("../admin/logs/redactor");
      } catch (error) {
        return null;
      }
    }
    return this._redactorInstance;
  }

  _log(level, fields, message) {
    try {
      if (!this._loggerInstance) this._loggerInstance = require("./logger").createLogger("settings");
      this._loggerInstance[level](fields, message);
    } catch (error) {
      // logging must never break a settings read or write
    }
  }

  _isMaintenance() {
    try {
      if (!this._maintenance) this._maintenance = require("./maintenanceMode");
      return !!this._maintenance.isActive();
    } catch (error) {
      return false;
    }
  }

  _model() {
    return this._models && this._models.SettingOverride ? this._models.SettingOverride : null;
  }

  // ----- tier 3: environment / file ----------------------------------------

  _ensureEnv() {
    if (this._env) return;
    const source = this._envSource || process.env;
    const values = new Map();
    const problems = new Map();

    for (const item of this.catalog.entries) {
      const names = [item.env, ...item.envAliases].filter(Boolean);
      let invalid = null;
      for (const name of names) {
        const raw = source[name];
        if (raw === undefined || raw === null || raw === "") continue; // an empty variable counts as unset
        let text = String(raw);
        if (item.secret) text = text.trim();
        if (item.fileTransform === "unescapeNewlines") text = this.catalog.unescapeNewlines(text);
        let api = item.parse(text);
        let problem = api === undefined ? "invalid_format" : null;
        if (!problem && !item.envLenient) {
          const refused = item.validate(api);
          if (refused) problem = refused.code;
        }
        if (problem) {
          if (!invalid) invalid = { code: "invalid_file_value", params: { reason: problem } };
          continue;
        }
        api = item.normalize(api);
        values.set(item.key, { api, config: item.type === "list" ? text : api, name });
        invalid = null;
        break;
      }
      if (invalid) problems.set(item.key, invalid);
    }

    this._env = values;
    this._envProblems = problems;
    this._registerSecrets();
  }

  // ----- resolution ---------------------------------------------------------

  /** Tiers 2-4 of an entry: { api, config, origin } */
  _resolve(item) {
    const override = this._overrides.get(item.key);
    let found = null;
    if (override) {
      found = { api: override.api, config: item.type === "list" ? override.raw : override.api, origin: "override" };
    } else {
      this._ensureEnv();
      const env = this._env.get(item.key);
      if (env) found = { api: env.api, config: env.config, origin: "env" };
    }
    // GEMINI_VISION_MODEL: empty means "same as GEMINI_MODEL"
    if (found && item.derived && found.api === "") found = null;
    if (found) return found;
    const api = this.catalog.defaultOf(item, this._getter);
    return { api, config: this.catalog.toConfig(item, api), origin: "default" };
  }

  /** Config value ignoring tier 1 (used by derived defaults) */
  _configOf(key) {
    const item = this.byKey.get(key);
    return item ? this._resolve(item).config : undefined;
  }

  /** The typed value config.KEY returns */
  get(key) {
    if (this._runtime.has(key)) return this._runtime.get(key);
    const item = this.byKey.get(key);
    return item ? this._resolve(item).config : undefined;
  }

  /** "override" | "env" | "default" */
  origin(key) {
    if (this._runtime.has(key)) return "override";
    const item = this.byKey.get(key);
    return item ? this._resolve(item).origin : undefined;
  }

  /** Version the client echoes back: the row's, else the last known one after a reset, else 0 */
  version(key) {
    const row = this._rows.get(key);
    if (row) return row.version;
    return this._lastVersion.get(key) || 0;
  }

  setRuntime(key, value) {
    if (value === undefined) this._runtime.delete(key);
    else this._runtime.set(key, value);
  }

  clearRuntime(key) {
    if (key === undefined) this._runtime.clear();
    else this._runtime.delete(key);
  }

  // ----- views -------------------------------------------------------------

  _problemOf(key) {
    const problem = this._overrideProblems.get(key) || this._envProblems.get(key) || null;
    return problem ? { code: problem.code, params: problem.params ? { ...problem.params } : undefined } : null;
  }

  problems() {
    this._ensureEnv();
    const out = {};
    for (const key of this._envProblems.keys()) setField(out, key, this._problemOf(key));
    for (const key of this._overrideProblems.keys()) setField(out, key, this._problemOf(key));
    return out;
  }

  /** SettingView of one key (safe to send to the browser), or null */
  describe(key) {
    const item = this.byKey.get(key);
    if (!item) return null;
    const resolved = this._resolve(item);
    this._ensureEnv();
    const envEntry = this._env.get(key);
    const row = this._rows.get(key);
    const view = {
      key,
      theme: item.theme,
      source: item.source,
      adapter: item.adapter,
      type: item.type,
      rules: this.catalog.ruleSummary(item),
      unit: item.unit,
      derived: item.derived,
      effect: item.effect,
      inactive: item.inactive,
      readonly: item.readonly,
      secret: item.secret,
      mask: item.mask,
      testService: item.testService,
      confirm: item.confirm,
      flags: item.flags.slice(),
      origin: resolved.origin,
      canRevert: resolved.origin === "override" && item.source === "env",
      version: this.version(key),
      updatedAt: row && row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      pendingRestart: this._isPendingRestart(item),
      problem: this._problemOf(key),
    };

    if (item.secret) {
      const text = typeof resolved.config === "string" ? resolved.config : "";
      if (item.mask === "scheme") {
        view.secretState = { set: text !== "", scheme: text.includes("postgres") ? "postgres" : "sqlite" };
      } else {
        view.secretState = { set: text !== "", last4: text.length >= 8 ? text.slice(-4) : null };
      }
      return view;
    }

    const show = (value) => (item.mask === "url" ? maskUrl(value) : clone(value));
    view.default = item.derived ? null : clone(item.default);
    view.value = show(resolved.api);
    view.fileValue = envEntry ? show(envEntry.api) : null;
    return view;
  }

  /** Every entry as a SettingView, in catalog order */
  snapshot() {
    return this.catalog.entries.map((item) => this.describe(item.key));
  }

  // ----- restart bookkeeping -------------------------------------------------

  _restartKeys() {
    return this.catalog.entries.filter((item) => item.effect === "restart").map((item) => item.key);
  }

  _serialized(item) {
    return item.serialize(this._resolve(item).config);
  }

  _isPendingRestart(item) {
    if (item.effect !== "restart" || !this._inForce || !this._inForce.has(item.key)) return false;
    return this._inForce.get(item.key) !== this._serialized(item);
  }

  /** Keys of effect "restart" whose value differs from the snapshot taken by markInForce() */
  pendingRestart() {
    if (!this._inForce) return [];
    return this._restartKeys().filter((key) => this._isPendingRestart(this.byKey.get(key)));
  }

  /** Snapshot the restart-effect values as "in force" (boot, and after each in-process restart) */
  markInForce() {
    this._inForce = new Map(this._restartKeys().map((key) => [key, this._serialized(this.byKey.get(key))]));
  }

  // ----- change events -------------------------------------------------------

  _emitChange(keys, source) {
    if (!keys.length) return;
    const payload = { keys: keys.slice(), source, at: this._now() };
    const report = (error) => this._log("error", { code: error && error.code, name: error && error.name }, "Settings change listener failed");
    for (const listener of this.listeners("change")) {
      try {
        const result = listener(payload);
        if (result && typeof result.catch === "function") result.catch(report);
      } catch (error) {
        report(error);
      }
    }
  }

  /**
   * fn({ keys, source, at }) after a successful write; `keysOrNull` filters on key (null: every change).
   * @returns {() => void} unsubscribe
   */
  onChange(keysOrNull, fn) {
    const filter = keysOrNull ? new Set(Array.isArray(keysOrNull) ? keysOrNull : [keysOrNull]) : null;
    const wrapper = (payload) => {
      if (!filter || payload.keys.some((key) => filter.has(key))) return fn(payload);
      return undefined;
    };
    this.on("change", wrapper);
    return () => this.off("change", wrapper);
  }

  // ----- redactor --------------------------------------------------------------

  /** Register every secret value in effect (override, environment or file) with the log redactor */
  _registerSecrets(keys) {
    const redactor = this._redactor();
    if (!redactor) return;
    for (const item of this.catalog.entries) {
      if (!(item.secret || item.mask === "url")) continue;
      if (keys && !keys.includes(item.key)) continue;
      try {
        const value = this._resolve(item).config;
        const text = typeof value === "string" ? value : "";
        if (item.secret) redactor.register(`setting:${item.key}`, text);
        if (item.mask === "scheme" || item.mask === "url") redactor.register(`setting:${item.key}:password`, urlPassword(text));
      } catch (error) {
        // a registration problem must not stop the store
      }
    }
  }

  // ----- loading ------------------------------------------------------------------

  /** Rows of setting_overrides -> { rows, overrides, problems, dropped } (secrets decrypted) */
  _buildFromRows(rows) {
    const box = this._secretBox();
    const built = { rows: new Map(), overrides: new Map(), problems: new Map(), dropped: [] };
    for (const row of rows) {
      const item = this.byKey.get(row.key);
      if (!item || !this._isWritable(item)) {
        built.dropped.push(row.key);
        continue;
      }
      const version = Number(row.version) || 1;
      const stored = String(row.value);
      built.rows.set(row.key, { stored, version, updatedAt: row.updatedAt || null });

      let plain = stored;
      if (item.secret && stored !== "") {
        const result = box.isEncrypted(stored) ? box.decrypt(stored, SECRET_CONTEXT(row.key)) : { ok: false, code: "malformed" };
        if (!result.ok) {
          built.problems.set(row.key, { code: "reenter", params: { reason: result.code } });
          if (!this._loggedUndecryptable.has(row.key)) {
            this._loggedUndecryptable.add(row.key);
            this._log("error", { key: row.key, code: result.code }, "Secret setting cannot be decrypted: enter it again");
          }
          continue;
        }
        plain = result.value;
      }
      const api = item.parse(plain);
      if (api === undefined || item.validate(api)) {
        built.problems.set(row.key, { code: item.secret ? "reenter" : "invalid_override", params: { reason: "invalid_value" } });
        continue;
      }
      built.overrides.set(row.key, { raw: plain, api: item.normalize(api), version });
    }
    return built;
  }

  /** Effective config strings of every writable key (to find what a reload changed) */
  _effectiveMap() {
    const out = new Map();
    for (const item of this.catalog.entries) {
      if (this._isWritable(item)) out.set(item.key, this._serialized(item));
    }
    return out;
  }

  async _readRows(source) {
    const model = this._model();
    if (!model) throw new SettingsStoreError("db_unavailable");
    let rows;
    try {
      rows = await model.findAll({ raw: true });
    } catch (error) {
      this._log("error", { code: error && error.code, name: error && error.name }, "Cannot read setting_overrides");
      throw new SettingsStoreError("db_unavailable", error);
    }

    const built = this._buildFromRows(rows);
    const before = this._effectiveMap();
    for (const [key, row] of this._rows) {
      if (!built.rows.has(key)) this._lastVersion.set(key, row.version);
    }
    for (const [key, row] of built.rows) this._lastVersion.set(key, row.version);
    this._rows = built.rows;
    this._overrides = built.overrides;
    this._overrideProblems = built.problems;
    this._ensureEnv();
    this._registerSecrets();
    const first = !this._loaded;
    this._loaded = true;
    if (!this._inForce) this.markInForce();

    const after = this._effectiveMap();
    const keys = first
      ? [...built.overrides.keys()]
      : [...after.keys()].filter((key) => before.get(key) !== after.get(key));
    this._emitChange(keys, first ? "load" : "restore");
    return { rows: built.rows.size, overrides: built.overrides.size, dropped: built.dropped.slice(), changed: keys };
  }

  /**
   * Fill memory from setting_overrides (after sync()); idempotent.
   * @param {{ models?: object, secretBox?: object, redactor?: object }} [deps]
   */
  async load(deps = {}) {
    if (deps.models) this._models = deps.models;
    if (deps.secretBox) this._box = deps.secretBox;
    if (deps.redactor) {
      this._redactorInstance = deps.redactor;
      this._registerSecrets();
    }
    return withLock("settings", () => this._readRows(this._loaded ? "restore" : "load"));
  }

  /** Re-read the table (restore, in-process restart) */
  async reload() {
    return withLock("settings", () => this._readRows("restore"));
  }

  // ----- writing -------------------------------------------------------------------

  _isWritable(item) {
    return item.source === "env" && !item.readonly && !item.inactive && item.effect !== "boot-only";
  }

  /** Refusal code for a key a batch may not write, else null */
  _refusal(item) {
    if (!item) return { code: "unknown_setting" };
    if (item.readonly || item.inactive || item.effect === "boot-only") return { code: "readonly" };
    if (item.source !== "env") return { code: "not_applicable" };
    return null;
  }

  addValidator(fn) {
    if (typeof fn === "function") this._validators.push(fn);
  }

  _assertWritable() {
    if (this._isMaintenance()) throw new SettingsStoreError("busy");
    if (!this._model()) throw new SettingsStoreError("db_unavailable");
  }

  /** Run `work(transaction)` in one transaction; database failures become db_unavailable */
  async _transaction(work) {
    const model = this._model();
    try {
      return await model.sequelize.transaction(work);
    } catch (error) {
      if (error instanceof SettingsError) throw error;
      this._log("error", { code: error && error.code, name: error && error.name }, "Settings write failed");
      throw new SettingsStoreError("db_unavailable", error);
    }
  }

  /** Steps 1-3: refusal, coercion, validation, cross-field rules. Returns [{ item, api, raw }] or throws */
  _plan(changes) {
    const fields = {};
    const plan = [];
    for (const [key, value] of Object.entries(changes)) {
      const item = this.byKey.get(key);
      const refused = this._refusal(item);
      if (refused) {
        setField(fields, key, refused);
        continue;
      }
      const invalid = item.validate(value);
      if (invalid) {
        setField(fields, key, invalid);
        continue;
      }
      const api = item.normalize(clone(value));
      plan.push({ item, key, api, raw: item.serialize(api) });
    }

    const planned = new Map(plan.map((entry) => [entry.key, this.catalog.toConfig(entry.item, entry.api)]));
    const projected = (key) => (planned.has(key) ? planned.get(key) : this._configOf(key));
    const batchKeys = new Set(plan.map((entry) => entry.key));
    for (const validator of this._validators) {
      let result = null;
      try {
        result = validator(projected, batchKeys);
      } catch (error) {
        this._log("error", { name: error && error.name }, "Settings cross-field validator failed");
      }
      if (result) for (const [key, problem] of Object.entries(result)) if (!(key in fields)) setField(fields, key, problem);
    }
    if (Object.keys(fields).length) throw new SettingsValidationError(fields);
    return plan;
  }

  _checkVersions(plan, expectedVersions) {
    if (!expectedVersions) return;
    const stale = {};
    for (const { key } of plan) {
      const expected = expectedVersions[key];
      if (expected !== undefined && expected !== this.version(key)) {
        setField(stale, key, { code: "conflict", params: { version: this.version(key) } });
      }
    }
    const keys = Object.keys(stale);
    if (keys.length) throw new SettingsConflictError(keys, stale);
  }

  /**
   * Write a whole batch or nothing. changes: { KEY: apiValue } (typed JSON: boolean, integer, array of
   * strings for lists, string otherwise).
   * @param {object} changes
   * @param {{ expectedVersions?: object, confirmed?: string[], actor?: string }} [opts]
   * @returns {Promise<{ changed: string[], versions: object }>}
   */
  async set(changes, opts = {}) {
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      throw new SettingsValidationError({ $body: { code: "invalid_type" } });
    }
    if (Object.keys(changes).length === 0) return { changed: [], versions: {} };

    return withLock("settings", async () => {
      this._assertWritable();
      const plan = this._plan(changes);

      // a risky change needs its confirmation token (SUDO emptied: owners_empty)
      const confirmed = Array.isArray(opts.confirmed) ? opts.confirmed : [];
      const missing = [];
      for (const { item, api } of plan) {
        if (this.catalog.needsConfirm(item, api, this._configOf(item.key)) && !confirmed.includes(item.confirm)) {
          if (!missing.includes(item.confirm)) missing.push(item.confirm);
        }
      }
      if (missing.length) throw new SettingsConfirmationError(missing);

      this._checkVersions(plan, opts.expectedVersions);

      // secrets are encrypted before the transaction: a box failure aborts the whole batch
      const box = this._secretBox();
      for (const entry of plan) {
        entry.stored = entry.raw;
        if (entry.item.secret && entry.raw !== "") {
          try {
            entry.stored = box.encrypt(entry.raw, SECRET_CONTEXT(entry.key));
          } catch (error) {
            this._log("error", { code: error && error.code }, "Secret storage unavailable");
            throw new SettingsStoreError("secret_storage_unavailable", error);
          }
        }
      }

      const model = this._model();
      const versions = {};
      await this._transaction(async (transaction) => {
        for (const entry of plan) {
          const row = this._rows.get(entry.key);
          if (row) {
            const [affected] = await model.update(
              { value: entry.stored, version: row.version + 1 },
              { where: { key: entry.key, version: row.version }, transaction },
            );
            if (!affected) throw new SettingsConflictError([entry.key]);
            versions[entry.key] = row.version + 1;
          } else {
            const next = (this._lastVersion.get(entry.key) || 0) + 1;
            try {
              await model.create({ key: entry.key, value: entry.stored, version: next }, { transaction });
            } catch (error) {
              if (error && error.name === "SequelizeUniqueConstraintError") throw new SettingsConflictError([entry.key]);
              throw error;
            }
            versions[entry.key] = next;
          }
        }
      });

      // committed: memory, redactor, then the event
      const now = new Date(this._now());
      for (const entry of plan) {
        const version = versions[entry.key];
        this._rows.set(entry.key, { stored: entry.stored, version, updatedAt: now });
        this._overrides.set(entry.key, { raw: entry.raw, api: entry.api, version });
        this._lastVersion.set(entry.key, version);
        this._overrideProblems.delete(entry.key);
      }
      const keys = plan.map((entry) => entry.key);
      this._registerSecrets(keys);
      this._emitChange(keys, "panel");
      return { changed: keys, versions };
    });
  }

  /**
   * Back to the file / environment value, else the default (FR-021): deletes the override rows.
   * @param {string[]} keys
   * @param {{ expectedVersions?: object, actor?: string }} [opts]
   * @returns {Promise<{ changed: string[] }>}
   */
  async unset(keys, opts = {}) {
    const list = Array.isArray(keys) ? keys : [keys];
    const fields = {};
    for (const key of list) {
      const refused = this._refusal(this.byKey.get(key));
      if (refused) setField(fields, key, refused);
    }
    if (Object.keys(fields).length) throw new SettingsValidationError(fields);

    return withLock("settings", async () => {
      this._assertWritable();
      const plan = [...new Set(list)].map((key) => ({ key }));
      this._checkVersions(plan, opts.expectedVersions);
      const doomed = plan.map((entry) => entry.key).filter((key) => this._rows.has(key));
      if (!doomed.length) return { changed: [] };

      const model = this._model();
      await this._transaction(async (transaction) => {
        await model.destroy({ where: { key: doomed }, transaction });
      });

      for (const key of doomed) {
        this._lastVersion.set(key, this._rows.get(key).version);
        this._rows.delete(key);
        this._overrides.delete(key);
        this._overrideProblems.delete(key);
      }
      this._registerSecrets(doomed);
      this._emitChange(doomed, "unset");
      return { changed: doomed };
    });
  }

  // ----- backup and restore ------------------------------------------------------------

  /**
   * Rows for a backup. `decrypted: true` carries secrets in clear (the archive is encrypted by its
   * passphrase); undecryptable rows are then left out because their value cannot be known.
   * @returns {Array<{ key: string, value: string, version: number }>}
   */
  rawOverrides({ decrypted = false } = {}) {
    const out = [];
    for (const [key, row] of this._rows) {
      const item = this.byKey.get(key);
      if (decrypted && item.secret && row.stored !== "") {
        const override = this._overrides.get(key);
        if (!override) continue;
        out.push({ key, value: override.raw, version: row.version });
      } else {
        out.push({ key, value: row.stored, version: row.version });
      }
    }
    return out;
  }

  /**
   * Replace every override by the rows of a backup (values in clear, re-encrypted here with this
   * installation's key). Unknown, boot-only, read-only and adapter keys are dropped and counted; a value
   * that fails the catalog refuses the whole import. Not refused during maintenance: the restore runs there.
   * @param {Array<{ key: string, value: string, version?: number }>} rows
   * @returns {Promise<{ imported: number, dropped: number, droppedKeys: string[] }>}
   */
  async importOverrides(rows) {
    const incoming = new Map();
    const droppedKeys = [];
    const fields = {};
    for (const row of Array.isArray(rows) ? rows : []) {
      const item = row && this.byKey.get(row.key);
      if (!item || !this._isWritable(item)) {
        droppedKeys.push(row && row.key);
        continue;
      }
      const raw = row.value === undefined || row.value === null ? "" : String(row.value);
      const api = item.parse(raw);
      const invalid = api === undefined ? { code: "invalid_format" } : item.validate(api);
      if (invalid) {
        setField(fields, row.key, invalid);
        continue;
      }
      incoming.set(row.key, { item, raw, api: item.normalize(api), version: Number(row.version) || 0 });
    }
    if (Object.keys(fields).length) throw new SettingsValidationError(fields);

    return withLock("settings", async () => {
      if (!this._model()) throw new SettingsStoreError("db_unavailable");
      const box = this._secretBox();
      for (const entry of incoming.values()) {
        entry.stored = entry.raw;
        if (entry.item.secret && entry.raw !== "") {
          try {
            entry.stored = box.encrypt(entry.raw, SECRET_CONTEXT(entry.item.key));
          } catch (error) {
            throw new SettingsStoreError("secret_storage_unavailable", error);
          }
        }
        const known = Math.max(this._lastVersion.get(entry.item.key) || 0, entry.version);
        entry.version = known + 1;
      }

      const model = this._model();
      await this._transaction(async (transaction) => {
        await model.destroy({ where: {}, transaction });
        if (incoming.size) {
          await model.bulkCreate(
            [...incoming.entries()].map(([key, entry]) => ({ key, value: entry.stored, version: entry.version })),
            { transaction },
          );
        }
      });

      const previous = new Set(this._rows.keys());
      for (const [key, row] of this._rows) this._lastVersion.set(key, row.version);
      this._rows = new Map();
      this._overrides = new Map();
      this._overrideProblems = new Map();
      const now = new Date(this._now());
      for (const [key, entry] of incoming) {
        this._rows.set(key, { stored: entry.stored, version: entry.version, updatedAt: now });
        this._overrides.set(key, { raw: entry.raw, api: entry.api, version: entry.version });
        this._lastVersion.set(key, entry.version);
      }
      const keys = [...new Set([...previous, ...incoming.keys()])];
      this._registerSecrets();
      this._emitChange(keys, "restore");
      return { imported: incoming.size, dropped: droppedKeys.length, droppedKeys };
    });
  }
}

/** A separate store (tests); the module itself exports the process-wide instance */
function createSettingsStore(options) {
  return new SettingsStore(options);
}

const store = createSettingsStore();

// LOG_LEVEL is live (settings-catalog.md 2.6 `setLogLevel`, runtime.md section 12): the shared logger
// follows the process-wide store. A store made by createSettingsStore() is detached on purpose.
store.onChange(["LOG_LEVEL"], () => {
  require("./logger").setLevel(store.get("LOG_LEVEL"));
});

module.exports = store;
module.exports.createSettingsStore = createSettingsStore;
module.exports.SettingsStore = SettingsStore;
module.exports.SettingsError = SettingsError;
module.exports.SettingsValidationError = SettingsValidationError;
module.exports.SettingsConflictError = SettingsConflictError;
module.exports.SettingsConfirmationError = SettingsConfirmationError;
module.exports.SettingsStoreError = SettingsStoreError;
module.exports.maskUrl = maskUrl;
