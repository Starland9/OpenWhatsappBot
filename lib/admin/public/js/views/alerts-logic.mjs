// Pure helpers for the alerts view (ALR-1 and SET-2 on the ALERT_* keys): the rows of the toggle table, the body of a
// toggle, the merge of the answer, the badge tones. No DOM access and no imports, so node:test can load this file.

/** The six alert types in the order of the contract (admin-http-api.md ALR-1), with the setting that switches each */
export const ALERT_TYPES = Object.freeze([
  Object.freeze({ type: "reconnected", settingKey: "ALERT_RECONNECT" }),
  Object.freeze({ type: "errors_series", settingKey: "ALERT_ERROR_BURST" }),
  Object.freeze({ type: "key_refused", settingKey: "ALERT_KEY_REFUSED" }),
  Object.freeze({ type: "login_blocked", settingKey: "ALERT_LOGIN_BLOCKED" }),
  Object.freeze({ type: "new_origin", settingKey: "ALERT_NEW_ORIGIN" }),
  Object.freeze({ type: "update_available", settingKey: "ALERT_UPDATE" }),
]);

/** Statuses an outbox row can have, with the tone of its badge */
export const STATUS_TONES = Object.freeze({ sent: "ok", pending: "warn", expired: "neutral", dropped: "danger" });

/** Translation keys of a type: its title and its sentence */
export const typeKeys = (type) => ({ title: `alerts.type_${type}`, desc: `alerts.type_${type}_desc` });

/** Tone of the badge of a status (`neutral` for one this panel does not know) */
export const statusTone = (status) => STATUS_TONES[status] || "neutral";

/** Translation key of a status, or null when unknown */
export const statusKey = (status) => (Object.prototype.hasOwnProperty.call(STATUS_TONES, status) ? `alerts.status_${status}` : null);

/** US13 scenario 5: nobody is configured to receive the alerts */
export const noRecipient = (data) => Boolean(data) && data.canDeliver === false;

/** Version of every `ALERT_*` setting of a SET-1 answer: { ALERT_KEY_REFUSED: 3, ... } */
export function versionsOf(settings) {
  const out = {};
  for (const entry of Array.isArray(settings) ? settings : []) {
    if (entry && typeof entry.key === "string" && entry.key.startsWith("ALERT_") && Number.isInteger(entry.version)) out[entry.key] = entry.version;
  }
  return out;
}

/**
 * The rows of the toggle table: the ALR-1 `types` (the contract order, whatever the server sent) joined with the SET-1
 * versions that SET-2 needs. `patches` holds toggles answered by SET-2 and not yet reflected by a reload.
 * @param {{ types?: object[] }|null} data ALR-1 answer
 * @param {object[]|null} settings SET-1 `settings`
 * @param {Object<string, { enabled: boolean, version: number }>} [patches] by type
 */
export function buildRows(data, settings, patches = {}) {
  const versions = versionsOf(settings);
  const byType = new Map(((data && data.types) || []).map((row) => [row.type, row]));
  return ALERT_TYPES.map(({ type, settingKey }) => {
    const row = byType.get(type) || {};
    const patch = patches[type];
    return {
      type,
      settingKey,
      enabled: patch ? patch.enabled : row.enabled !== false,
      version: patch ? patch.version : Number.isInteger(versions[settingKey]) ? versions[settingKey] : null,
      lastSentAt: row.lastSentAt || null,
      pending: Number.isFinite(Number(row.pending)) ? Number(row.pending) : 0,
    };
  });
}

/** Body of the SET-2 call that switches a type; null when its version is unknown (the switch is then disabled) */
export function toggleBody(row, enabled) {
  if (!row || !Number.isInteger(row.version)) return null;
  return { changes: [{ key: row.settingKey, op: "set", value: Boolean(enabled), version: row.version }] };
}

/** The `{ enabled, version }` a SET-2 answer gives back for a key, or null when it is not in the answer */
export function patchFromAnswer(answer, settingKey) {
  const entry = ((answer && answer.settings) || []).find((item) => item && item.key === settingKey);
  if (!entry || !Number.isInteger(entry.version)) return null;
  return { enabled: entry.value !== false, version: entry.version };
}

/** Counts for the sentence above the table */
export function summarize(rows) {
  const list = rows || [];
  return {
    total: list.length,
    enabled: list.filter((row) => row.enabled).length,
    pending: list.reduce((sum, row) => sum + (row.pending || 0), 0),
  };
}
