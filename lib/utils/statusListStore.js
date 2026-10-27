const fs = require("fs");
const path = require("path");
const pino = require("pino");
const config = require("../../config");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/**
 * Auto status-save settings: `data/status_save.json` is the single source of
 * truth for the watch list and the on/off switch.
 *
 * - The env values (`STATUS_SAVE_LIST`, `AUTO_STATUS_SAVE`) only seed the file
 *   when it does not exist yet.
 * - `AUTO_STATUS_SAVE=true` in the environment still forces the feature on
 *   (`forcedByEnv`), whatever the file says.
 * - The list holds bare numbers (digits only), see `normalizeNumber`.
 */

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const FILE_PATH = path.join(DATA_DIR, "status_save.json");

/** Last file content read or written: { mtimeMs, data } */
let cache = null;

/**
 * Digits of a number or JID ("+237 6 00 00 00 00", "237600000000:5@s.whatsapp.net").
 * @param {any} value
 * @returns {string} "" when there is no digit
 */
function normalizeNumber(value) {
  return String(value ?? "")
    .split("@")[0]
    .split(":")[0]
    .replace(/\D/g, "");
}

function cleanList(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const number = normalizeNumber(item);
    if (number && !out.includes(number)) out.push(number);
  }
  return out;
}

function seed() {
  return {
    enabled: !!config.AUTO_STATUS_SAVE,
    list: cleanList(String(config.STATUS_SAVE_LIST || "").split(",")),
  };
}

/** Atomic write (temp file + rename) */
function persist(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE_PATH);
  cache = { mtimeMs: fs.statSync(FILE_PATH).mtimeMs, data };
  return data;
}

/**
 * Current settings. The file is only re-read when it changed on disk, so this
 * is cheap enough to call on every status.
 */
function load() {
  let stat = null;
  try {
    stat = fs.statSync(FILE_PATH);
  } catch (_) {
    // missing file
  }

  if (!stat) return persist(seed());
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.data;

  try {
    const parsed = JSON.parse(fs.readFileSync(FILE_PATH, "utf8") || "{}");
    const data = {
      enabled: Boolean(parsed.enabled),
      list: cleanList(parsed.list),
    };
    cache = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch (error) {
    // Keep the broken file for inspection; fail closed (feature off, empty list)
    logger.warn(`status_save.json is not valid JSON (${error.message}); it is set aside`);
    try {
      fs.renameSync(FILE_PATH, `${FILE_PATH}.corrupt`);
    } catch (_) {
      // nothing more to do
    }
    return persist({ enabled: false, list: [] });
  }
}

function snapshot(data) {
  const forcedByEnv = !!config.AUTO_STATUS_SAVE;
  return {
    enabled: data.enabled,
    list: data.list.slice(),
    forcedByEnv,
    // What the status saver really does: the env switch wins over the file
    active: data.enabled || forcedByEnv,
  };
}

/**
 * @returns {Promise<{enabled: boolean, list: string[], forcedByEnv: boolean, active: boolean}>}
 */
async function get() {
  return snapshot(load());
}

async function mutate(change) {
  const current = load();
  const next = { enabled: current.enabled, list: current.list.slice() };
  change(next);
  return snapshot(persist(next));
}

/** Add a number (any format); an input without digits changes nothing */
async function add(number) {
  const n = normalizeNumber(number);
  return mutate((st) => {
    if (n && !st.list.includes(n)) st.list.push(n);
  });
}

async function remove(number) {
  const n = normalizeNumber(number);
  return mutate((st) => {
    st.list = st.list.filter((x) => x !== n);
  });
}

async function setEnabled(enabled) {
  return mutate((st) => {
    st.enabled = !!enabled;
  });
}

module.exports = { get, add, remove, setEnabled, normalizeNumber, FILE_PATH };
