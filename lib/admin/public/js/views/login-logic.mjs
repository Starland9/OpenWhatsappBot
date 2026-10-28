// Pure helpers for the login view (blocked state with the retry delay).

export const DEFAULT_BLOCK_MS = 15 * 60 * 1000;

/** Milliseconds left before the block ends (0 when not blocked). */
export function remainingMs(blockedUntil, now = Date.now()) {
  if (!blockedUntil) return 0;
  return Math.max(0, blockedUntil - now);
}

/** `blockedUntil` (epoch ms) from a `login_blocked` ApiError: `Retry-After` / `params.retryAfterMs`, else 15 min. */
export function blockedUntilFrom(err, now = Date.now()) {
  const delay = err && typeof err.retryAfterMs === "number" && err.retryAfterMs > 0 ? err.retryAfterMs : DEFAULT_BLOCK_MS;
  return now + delay;
}
