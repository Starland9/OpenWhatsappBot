// Pure helpers for the setup, login and account views (no DOM, importable from node:test).

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

/** Length in code points of the NFKC-normalised text, as the server counts it (FR-004). */
export function passwordLength(password) {
  return [...String(password ?? "").normalize("NFKC")].length;
}

/**
 * Client-side pre-check of a new password: the server stays the authority (it also rejects repeated
 * characters, trivial sequences and common passwords with `too_weak`), this only avoids a round trip.
 * Returns `{ ok, fields }` where `fields` maps a field name to `{ code, params? }` (same shape as the API).
 */
export function validateNewPassword(password, confirm, { field = "password", confirmField = "confirm" } = {}) {
  const fields = {};
  const length = passwordLength(password);
  if (length === 0) fields[field] = { code: "required" };
  else if (length < PASSWORD_MIN) fields[field] = { code: "too_short", params: { min: PASSWORD_MIN } };
  else if (length > PASSWORD_MAX) fields[field] = { code: "too_long", params: { max: PASSWORD_MAX } };
  if (confirm !== undefined && confirm !== null && password !== confirm) fields[confirmField] = { code: "mismatch" };
  return { ok: Object.keys(fields).length === 0, fields };
}

/** Pre-check of the AUTH-5 form. */
export function validatePasswordChange({ currentPassword, newPassword, confirm }) {
  const fields = {};
  if (!currentPassword) fields.currentPassword = { code: "required" };
  const checked = validateNewPassword(newPassword, confirm, { field: "newPassword" });
  Object.assign(fields, checked.fields);
  if (!fields.newPassword && currentPassword && newPassword === currentPassword) fields.newPassword = { code: "same_as_current" };
  return { ok: Object.keys(fields).length === 0, fields };
}

/** Field errors of an ApiError, restricted to the names the form displays. */
export function pickFieldErrors(err, names) {
  const out = {};
  if (!err || !err.fields) return out;
  for (const name of names) if (err.fields[name]) out[name] = err.fields[name];
  return out;
}
