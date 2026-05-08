const fs = require("fs");
const path = require("path");
const config = require("../../config");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const FILE_PATH = path.join(DATA_DIR, "status_save.json");

async function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE_PATH)) {
    const initial = {
      enabled: !!config.AUTO_STATUS_SAVE,
      list: (config.STATUS_SAVE_LIST || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
    fs.writeFileSync(FILE_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const raw = fs.readFileSync(FILE_PATH, "utf8");
    return JSON.parse(raw || "{}");
  } catch (e) {
    const initial = { enabled: !!config.AUTO_STATUS_SAVE, list: [] };
    fs.writeFileSync(FILE_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
}

async function get() {
  const data = await ensureFile();
  return {
    enabled: Boolean(data.enabled),
    list: Array.isArray(data.list) ? data.list : [],
  };
}

async function save(obj) {
  await ensureFile();
  const toWrite = {
    enabled: Boolean(obj.enabled),
    list: Array.isArray(obj.list) ? obj.list : [],
  };
  fs.writeFileSync(FILE_PATH, JSON.stringify(toWrite, null, 2));
  return toWrite;
}

async function add(number) {
  const st = await get();
  const n = (number || "").trim();
  if (!n) return st;
  if (!st.list.includes(n)) st.list.push(n);
  await save(st);
  return st;
}

async function remove(number) {
  const st = await get();
  const n = (number || "").trim();
  st.list = st.list.filter((x) => x !== n);
  await save(st);
  return st;
}

async function setEnabled(enabled) {
  const st = await get();
  st.enabled = !!enabled;
  await save(st);
  return st;
}

module.exports = { get, add, remove, setEnabled, FILE_PATH };
