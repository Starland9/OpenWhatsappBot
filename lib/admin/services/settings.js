"use strict";

/**
 * Settings service of the panel (SET-1 and SET-2 of admin-http-api.md section 2.5, settings-catalog.md
 * sections 2.4 and 3). The factory never touches `req`/`res`:
 *
 *   const settings = createSettingsService(deps);
 *   await settings.list()                      -> { settings: [ResolvedSetting], restartPending, secretStore, ownersConfigured }
 *   await settings.update(body, { actor })     -> { settings, restartPending, applied }   SET-2
 *   parseChanges(rawChanges)                   the strict reading of `changes` (a fresh array, nothing echoed)
 *
 * Values come from the in-memory settings store (lib/utils/settingsStore.js), so a listing survives a database
 * outage. Four settings groups have another source of truth and are read and written through ADAPTERS that call
 * the same helpers as the WhatsApp commands (`.ar`, `.antidelete`, `.setvv`, `statusListStore`), never through a
 * `SettingOverride` row:
 *
 *   autoResponder   model AutoResponder (row 1)   AUTO_RESPONDER_ENABLED / _IGNORE_NUMBERS / _PERSONALITY
 *   antiDelete      model AntiDelete (row 1)      ANTIDELETE_MODE + ANTIDELETE_JID, applied as ONE row update
 *   viewOnce        model ViewOnce (row 1)        VIEWONCE_MODE + VIEWONCE_JID, applied as ONE row update
 *   statusSave      file data/status_save.json    AUTO_STATUS_SAVE, STATUS_SAVE_LIST
 *
 * Each adapter is `{ kind, keys, cacheKeys, read(), write(values, { transaction }) }`. `read()` answers
 * `{ exists, version, values }` (`version`: the row's `updatedAt` in epoch ms, the file's `mtimeMs`, 0 while
 * nothing was written yet); the SettingsCache keys are invalidated once the write has committed.
 *
 * SET-2 order: the whole batch is validated (types, bounds, formats, cross-field rules, adapter rules), the
 * confirmation tokens are checked, the versions are compared, and only then something is written: override rows
 * through the store (its own transaction), the database adapters in ONE transaction, the file adapter last. The
 * store offers no external transaction, so a database failure after the store committed leaves the override rows
 * applied: it is reported as a 500 and the UI reloads (the documented limitation of the contract).
 *
 * Errors are codes and parameters, never the submitted value; a secret never appears in an answer, an audit
 * detail (`{ secret: true, op }` through auditDiff) or a log.
 */

const { withLock } = require("../../utils/mutex");
const { AdminError } = require("../http/response");

const KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const OPS = ["set", "default", "revert"];
const MAX_CHANGES = 50;
/** Why a stored value cannot be decrypted with the key on disk (the others are not about the key) */
const KEY_REASONS = ["key_missing", "key_invalid", "auth_failed"];
const ADAPTER_ORDER = ["autoResponder", "antiDelete", "viewOnce", "statusSave"];
/** Mode/JID pairs of the two row adapters */
const PAIRS = {
  antiDelete: { mode: "ANTIDELETE_MODE", jid: "ANTIDELETE_JID" },
  viewOnce: { mode: "VIEWONCE_MODE", jid: "VIEWONCE_JID" },
};

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const clone = (value) => (Array.isArray(value) ? value.slice() : value);
const toMs = (date) => {
  if (date === null || date === undefined) return 0;
  const ms = date instanceof Date ? date.getTime() : new Date(date).getTime();
  return Number.isFinite(ms) ? ms : 0;
};

/** Unique keys of an array, order kept */
const unique = (items) => [...new Set(items)];

/**
 * Strict reading of the `changes` array of SET-2: a FRESH array of `{ key, op, value?, version }`.
 * Structural problems throw `422 validation_failed`; the field name is a catalog-shaped key when the key itself is
 * readable, `changes` otherwise. Nothing the client sent is echoed back.
 * @param {unknown} raw
 * @returns {Array<{ key: string, op: string, hasValue: boolean, value: any, version: number }>}
 */
function parseChanges(raw) {
  const fields = {};
  const out = [];
  const seen = new Set();
  const fail = (name, code, params) => {
    if (!has(fields, name)) fields[name] = params ? { code, params } : { code };
  };

  if (!Array.isArray(raw)) {
    fail("changes", "invalid_type");
  } else {
    if (raw.length < 1) fail("changes", "required");
    if (raw.length > MAX_CHANGES) fail("changes", "too_many_items", { max: MAX_CHANGES });
    for (const item of raw.slice(0, MAX_CHANGES)) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        fail("changes", "invalid_type");
        continue;
      }
      const key = typeof item.key === "string" && KEY_RE.test(item.key) ? item.key : null;
      const name = key || "changes";
      if (key === null) fail("changes", typeof item.key === "string" ? "invalid_format" : "required");
      if (Object.keys(item).some((prop) => !["key", "op", "value", "version"].includes(prop))) {
        fail("$unknown", "unknown_field");
      }
      if (key !== null && seen.has(key)) fail(key, "duplicate");
      if (key !== null) seen.add(key);

      if (!OPS.includes(item.op)) fail(name, typeof item.op === "string" ? "not_allowed" : "required", { allowed: OPS.slice() });
      if (item.version === undefined) fail(name, "required");
      else if (!Number.isSafeInteger(item.version) || item.version < 0) fail(name, "invalid_type");
      const hasValue = Object.prototype.hasOwnProperty.call(item, "value");
      if (item.op === "set" && !hasValue) fail(name, "required");
      if ((item.op === "default" || item.op === "revert") && hasValue) fail(name, "not_applicable");

      if (key !== null) out.push({ key, op: item.op, hasValue, value: hasValue ? item.value : undefined, version: item.version });
    }
  }
  if (Object.keys(fields).length) throw new AdminError("validation_failed", { fields });
  return out;
}

function createSettingsService(deps = {}) {
  const store = () => deps.settingsStore || require("../../utils/settingsStore");
  const catalog = () => deps.catalog || require("../../utils/settingsCatalog");
  const models = () => deps.models || require("../../database");
  const cache = () => deps.settingsCache || require("../../utils/settingsCache");
  const files = () => deps.statusListStore || require("../../utils/statusListStore");
  const diffOf = () => deps.auditDiff || require("../audit").auditDiff;
  const plugin = (name) => (deps.plugins && deps.plugins[name]) || require(`../../../plugins/${name}`);
  const log = () => deps.logger || require("../../utils/logger").createLogger("admin.settings");

  // ---- adapters (settings-catalog.md section 3) -------------------------------------------------------

  function buildAdapters() {
    const autoResponder = {
      id: "autoResponder",
      kind: "db",
      keys: ["AUTO_RESPONDER_ENABLED", "AUTO_RESPONDER_IGNORE_NUMBERS", "AUTO_RESPONDER_PERSONALITY"],
      cacheKeys: ["auto_responder"],
      async read() {
        const row = await models().AutoResponder.findOne({ where: { id: 1 } });
        if (!row) return { exists: false, version: 0, values: null };
        return {
          exists: true,
          version: toMs(row.updatedAt),
          values: {
            AUTO_RESPONDER_ENABLED: Boolean(row.enabled),
            AUTO_RESPONDER_IGNORE_NUMBERS: plugin("autorespond").parseList(row.ignoreNumbers),
            AUTO_RESPONDER_PERSONALITY: String(row.personality === null || row.personality === undefined ? "" : row.personality),
          },
        };
      },
      async write(values, { transaction } = {}) {
        const mod = plugin("autorespond");
        const row = await mod.loadSettings({ transaction });
        const patch = {};
        if (has(values, "AUTO_RESPONDER_ENABLED")) patch.enabled = values.AUTO_RESPONDER_ENABLED;
        if (has(values, "AUTO_RESPONDER_IGNORE_NUMBERS")) patch.ignoreNumbers = values.AUTO_RESPONDER_IGNORE_NUMBERS.join(",");
        if (has(values, "AUTO_RESPONDER_PERSONALITY")) patch.personality = values.AUTO_RESPONDER_PERSONALITY;
        await mod.updateSettings(row, patch, { transaction });
      },
    };

    /** antidel.js / viewonce.js: a row of (mode, jid, enabled) written from `parseMode(...)` */
    const modeAdapter = (id, pluginName, model, fields, offToken) => {
      const pair = PAIRS[id];
      const isOff = (row) => !row.enabled || !row[fields.mode] || row[fields.mode] === "null" || row[fields.mode] === "false";
      return {
        id,
        kind: "db",
        keys: [pair.mode, pair.jid],
        cacheKeys: [id === "antiDelete" ? "anti_delete" : "view_once"],
        pair,
        async read() {
          const row = await models()[model].findOne({ where: { id: 1 } });
          if (!row) return { exists: false, version: 0, values: null };
          const mode = isOff(row) ? "off" : String(row[fields.mode]);
          return {
            exists: true,
            version: toMs(row.updatedAt),
            values: { [pair.mode]: mode, [pair.jid]: row[fields.jid] ? String(row[fields.jid]) : "" },
          };
        },
        /** `values` holds BOTH keys of the pair, already resolved by the validation */
        async write(values, { transaction } = {}) {
          const mode = values[pair.mode];
          const raw = mode === "off" ? offToken : mode === "jid" ? values[pair.jid] : mode;
          const parsed = plugin(pluginName).parseMode(raw);
          if (!parsed) throw new AdminError("validation_failed", { fields: { [pair.jid]: { code: "invalid_jid" } } });
          await plugin(pluginName).saveSettings(parsed.values, { transaction });
        },
      };
    };

    const statusSave = {
      id: "statusSave",
      kind: "file",
      keys: ["AUTO_STATUS_SAVE", "STATUS_SAVE_LIST"],
      cacheKeys: [],
      async read() {
        const fs = require("fs");
        const mod = files();
        // reading must not create the file (statusListStore.get() seeds it when missing)
        let stat = null;
        try {
          stat = fs.statSync(mod.FILE_PATH);
        } catch (error) {
          stat = null;
        }
        if (!stat) return { exists: false, version: 0, values: null };
        const state = await mod.get();
        return {
          exists: true,
          version: Math.round(stat.mtimeMs),
          forcedByEnv: Boolean(state.forcedByEnv),
          values: { AUTO_STATUS_SAVE: Boolean(state.active), STATUS_SAVE_LIST: state.list.slice() },
        };
      },
      async write(values) {
        const mod = files();
        if (has(values, "AUTO_STATUS_SAVE")) await mod.setEnabled(values.AUTO_STATUS_SAVE);
        if (has(values, "STATUS_SAVE_LIST")) {
          const wanted = values.STATUS_SAVE_LIST;
          const current = (await mod.get()).list;
          for (const number of current) if (!wanted.includes(number)) await mod.remove(number);
          for (const number of wanted) if (!current.includes(number)) await mod.add(number);
        }
      },
    };

    return {
      autoResponder,
      antiDelete: modeAdapter("antiDelete", "antidel", "AntiDelete", { mode: "antiDelMode", jid: "antiDelJid" }, "null"),
      viewOnce: modeAdapter("viewOnce", "viewonce", "ViewOnce", { mode: "vvMode", jid: "vvJid" }, "null"),
      statusSave,
    };
  }

  const adapters = deps.adapters || buildAdapters();

  /** Adapter ids of a set of catalog keys */
  const adapterIdsOf = (keys) =>
    unique(
      keys
        .map((key) => {
          const item = catalog().byKey.get(key);
          return item && item.adapter ? item.adapter : null;
        })
        .filter(Boolean),
    );

  /** Read adapters: { [id]: state | { error: true } }. Failures are logged by name/code only. */
  async function readAdapters(ids) {
    const out = {};
    for (const id of ids) {
      const adapter = adapters[id];
      if (!adapter) continue;
      try {
        out[id] = await adapter.read();
      } catch (error) {
        out[id] = { error: true };
        log().warn({ adapter: id, name: error && error.name, code: error && error.code }, "settings adapter unreadable");
      }
    }
    return out;
  }

  // ---- ResolvedSetting (settings-catalog.md section 2.4) -----------------------------------------------

  function bindHost() {
    try {
      const runtime = deps.runtimeInfo || require("../../utils/runtime");
      return runtime.resolveBind().host;
    } catch (error) {
      return null;
    }
  }

  /** One setting as the browser sees it. `states` holds the adapter states already read. */
  function resolve(key, states) {
    const s = store();
    const view = s.describe(key);
    if (!view) return null;
    let value = view.value;
    let origin = view.origin;
    let version = view.version;
    let canRevert = view.canRevert;
    let problem = view.problem;
    let fileValue = view.fileValue === undefined ? null : view.fileValue;

    if (view.adapter) {
      canRevert = false;
      const state = states && states[view.adapter];
      if (state && state.error) {
        problem = { code: "adapter_unavailable" };
      } else if (state && state.exists) {
        value = clone(state.values[key]);
        version = state.version;
        origin = view.adapter === "statusSave" && key === "AUTO_STATUS_SAVE" && state.forcedByEnv ? "env" : "override";
      }
    }

    // startup settings show the address the process actually binds
    if (key === "PANEL_HOST") {
      const host = bindHost();
      if (host) value = host;
    }

    const out = {
      key,
      theme: view.theme,
      source: view.source,
      type: view.type,
      rules: view.rules,
      unit: view.unit,
      default: view.secret ? null : clone(view.default === undefined ? null : view.default),
      derived: view.derived || null,
      secret: null,
      fileValue: view.secret ? null : fileValue,
      origin,
      canRevert,
      version,
      effect: view.effect,
      readonly: view.readonly,
      inactive: view.inactive,
      pendingRestart: view.pendingRestart,
      problem: problem ? { code: problem.code, ...(problem.params ? { params: problem.params } : {}) } : null,
      testService: view.testService || null,
      confirm: view.confirm || null,
    };
    if (view.secret) {
      const state = view.secretState || { set: false };
      out.secret =
        view.mask === "scheme"
          ? { set: Boolean(state.set), scheme: state.scheme || null }
          : { set: Boolean(state.set), last4: state.last4 || null, needsReentry: Boolean(problem && problem.code === "reenter") };
    } else {
      out.value = clone(value);
    }
    return out;
  }

  /** "key_missing" while a stored secret cannot be read back with the key on disk (banner secret_key_lost) */
  function secretStoreState() {
    const lost = Object.values(store().problems()).some(
      (problem) => problem && problem.code === "reenter" && problem.params && KEY_REASONS.includes(problem.params.reason),
    );
    return lost ? "key_missing" : "ok";
  }

  /** SET-1 */
  async function list() {
    const s = store();
    const states = await readAdapters(ADAPTER_ORDER);
    return {
      settings: catalog().entries.map((item) => resolve(item.key, states)),
      restartPending: s.pendingRestart(),
      secretStore: secretStoreState(),
      ownersConfigured: String(s.get("SUDO") || "").trim() !== "",
    };
  }

  // ---- SET-2 -------------------------------------------------------------------------------------------

  /** The catalog default as an api value; a secret and a derived default are stored empty */
  function defaultApi(item) {
    if (item.secret || item.derived) return item.type === "list" ? [] : "";
    return clone(item.default);
  }

  /** The api value a key falls back to when its override is deleted (file/environment, else default) */
  function revertedApi(key) {
    const s = store();
    const view = s.describe(key);
    const item = catalog().byKey.get(key);
    if (item.secret) {
      // only emptiness matters (the confirmation rule); a secret is never read back through the view
      return s.get(key) === "" ? "" : "set";
    }
    return view.fileValue !== null && view.fileValue !== undefined ? clone(view.fileValue) : defaultApi(item);
  }

  /**
   * Validate the whole batch against the current state. Returns the write plan or throws
   * `422 validation_failed` (every invalid key at once), `409 confirmation_required`, `409 conflict`.
   */
  function plan(changes, states, confirmed) {
    const cat = catalog();
    const s = store();
    const fields = {};
    const setField = (key, code, params) => {
      if (!has(fields, key)) fields[key] = params ? { code, params } : { code };
    };

    const entries = [];
    for (const change of changes) {
      const item = cat.byKey.get(change.key);
      if (!item) {
        setField(change.key, "unknown_setting");
        continue;
      }
      if (item.readonly || item.inactive || item.effect === "boot-only") {
        setField(change.key, "readonly");
        continue;
      }
      const entry = { change, item, key: change.key, op: change.op, adapter: item.adapter || null };
      if (change.op === "revert") {
        if (item.source !== "env") {
          setField(change.key, "not_applicable");
          continue;
        }
        entry.api = revertedApi(change.key);
        entries.push(entry);
        continue;
      }
      const candidate = change.op === "default" ? defaultApi(item) : change.value;
      const invalid = item.validate(candidate);
      if (invalid) {
        setField(change.key, invalid.code, invalid.params);
        continue;
      }
      entry.api = item.normalize(clone(candidate));
      entries.push(entry);
    }

    // cross-field rules of the catalog, on the resulting effective values of the store's keys
    const resulting = new Map();
    for (const e of entries) {
      if (e.item.source === "env" && !e.item.secret) resulting.set(e.key, cat.toConfig(e.item, e.api));
    }
    const projected = (key) => (resulting.has(key) ? resulting.get(key) : s.get(key));
    const batchKeys = new Set(entries.filter((e) => e.item.source === "env").map((e) => e.key));
    for (const validator of cat.crossValidators) {
      let result = null;
      try {
        result = validator(projected, batchKeys);
      } catch (error) {
        log().error({ name: error && error.name }, "settings cross-field validator failed");
      }
      if (result) for (const [key, problem] of Object.entries(result)) setField(key, problem.code, problem.params);
    }

    // adapter rules (pairs, forced by the environment, normalised JIDs)
    const touched = unique(entries.map((e) => e.adapter).filter(Boolean));
    const adapterPlans = {};
    for (const id of touched) {
      const adapter = adapters[id];
      const mine = entries.filter((e) => e.adapter === id);
      const state = states[id];
      const values = {};
      for (const e of mine) values[e.key] = e.api;

      if (PAIRS[id]) {
        const pair = PAIRS[id];
        const current = state && state.exists ? state.values : { [pair.mode]: "off", [pair.jid]: "" };
        const mode = has(values, pair.mode) ? values[pair.mode] : current[pair.mode];
        let jid;
        if (has(values, pair.jid)) jid = values[pair.jid];
        else jid = mode === "jid" ? current[pair.jid] : "";
        if (mode === "jid" && jid === "") {
          setField(pair.jid, "required");
        } else if (mode !== "jid" && has(values, pair.jid) && values[pair.jid] !== "") {
          setField(pair.jid, "not_applicable");
        } else if (mode === "jid" && !plugin(id === "antiDelete" ? "antidel" : "viewonce").parseMode(jid)) {
          setField(pair.jid, "invalid_jid");
        }
        adapterPlans[id] = { adapter, values: { [pair.mode]: mode, [pair.jid]: mode === "jid" ? jid : "" } };
      } else {
        adapterPlans[id] = { adapter, values };
      }

      if (id === "statusSave" && has(values, "AUTO_STATUS_SAVE") && values.AUTO_STATUS_SAVE === false) {
        // AUTO_STATUS_SAVE=true in the environment forces the feature on whatever the file says
        if (s.get("AUTO_STATUS_SAVE") === true) setField("AUTO_STATUS_SAVE", "forced_by_env");
      }
    }

    if (Object.keys(fields).length) throw new AdminError("validation_failed", { fields });

    // risky changes need their confirmation token (SUDO emptied: owners_empty)
    const missing = [];
    for (const e of entries) {
      if (!e.item.confirm) continue;
      if (cat.needsConfirm(e.item, e.api, s.get(e.key)) && !confirmed.includes(e.item.confirm)) missing.push(e.item.confirm);
    }
    if (missing.length) throw new AdminError("confirmation_required", { params: { confirm: unique(missing) } });

    // optimistic concurrency: nothing is written when one version is stale
    const stale = {};
    for (const e of entries) {
      const state = e.adapter ? states[e.adapter] : null;
      const current = e.adapter ? (state && state.exists ? state.version : 0) : s.version(e.key);
      e.current = current;
      if (e.change.version !== current) stale[e.key] = { code: "conflict", params: { version: current } };
    }
    if (Object.keys(stale).length) throw new AdminError("conflict", { fields: stale });

    return { entries, adapterPlans };
  }

  /** SET-2: body `{ changes: [{ key, op, value?, version }], confirm?: ["owners_empty"] }` */
  async function update(body, { actor } = {}) {
    const changes = parseChanges(body && body.changes);
    const confirmed = Array.isArray(body && body.confirm) ? body.confirm : [];

    return withLock("settings-batch", async () => {
      const s = store();
      const keys = changes.map((change) => change.key);
      const ids = adapterIdsOf(keys);
      const states = await readAdapters(ids);
      if (ids.some((id) => states[id] && states[id].error)) throw new AdminError("db_unavailable");

      const { entries, adapterPlans } = plan(changes, states, confirmed);

      // what the audit rows say changed: the effective value before (secrets are never read)
      const before = new Map(entries.map((e) => [e.key, e.item.secret ? undefined : resolve(e.key, states).value]));

      // 1. override rows (the store validates again and writes in its own transaction)
      const envSets = {};
      const envExpected = {};
      const reverts = [];
      for (const e of entries) {
        if (e.adapter) continue;
        if (e.op === "revert") {
          reverts.push(e.key);
        } else {
          envSets[e.key] = e.api;
        }
        envExpected[e.key] = e.change.version;
      }
      let unset = { changed: [] };
      if (Object.keys(envSets).length) await s.set(envSets, { expectedVersions: envExpected, confirmed, actor });
      if (reverts.length) unset = await s.unset(reverts, { expectedVersions: envExpected, actor });

      // 2. database adapters, one transaction; their caches are dropped once it has committed
      const dbPlans = ADAPTER_ORDER.filter((id) => adapterPlans[id] && adapterPlans[id].adapter.kind === "db");
      if (dbPlans.length) {
        const sequelize = models().DATABASE;
        await sequelize.transaction(async (transaction) => {
          for (const id of dbPlans) await adapterPlans[id].adapter.write(adapterPlans[id].values, { transaction });
        });
        for (const id of dbPlans) for (const cacheKey of adapterPlans[id].adapter.cacheKeys) cache().invalidate(cacheKey);
      }

      // 3. the file adapter, last
      for (const id of ADAPTER_ORDER) {
        if (adapterPlans[id] && adapterPlans[id].adapter.kind === "file") await adapterPlans[id].adapter.write(adapterPlans[id].values);
      }

      // answer: the changed settings, as they are now (a mode/JID pair is one row: both keys follow)
      const fresh = await readAdapters(ids);
      const answered = unique([...entries.map((e) => e.key), ...ids.flatMap((id) => (PAIRS[id] ? [PAIRS[id].mode, PAIRS[id].jid] : []))]);
      const settings = answered.map((key) => resolve(key, fresh));
      const diff = diffOf();
      const applied = [];
      for (const e of entries) {
        if (e.op === "revert" && !e.adapter && !unset.changed.includes(e.key)) continue; // nothing to revert
        const now = resolve(e.key, fresh);
        // a secret is reduced to "empty or not": auditDiff records { secret: true, op } only
        const after = e.item.secret ? (e.op === "default" || s.get(e.key) === "" ? "" : "set") : now.value;
        applied.push({
          action: e.op === "set" ? "setting.update" : "setting.reset",
          target: e.key,
          detail: diff(e.item, before.get(e.key), after),
        });
      }
      return { settings, restartPending: s.pendingRestart(), applied };
    });
  }

  return { list, update, resolve, adapters, parseChanges };
}

module.exports = { createSettingsService, parseChanges, KEY_RE, OPS, MAX_CHANGES, ADAPTER_ORDER };
