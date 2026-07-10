// Pure failed-login lockout policy. Given a summary of a
// key's recent failed attempts, decide whether the next attempt should be
// throttled and, if so, for how long. No DB, no clock, no I/O — the login action
// feeds it numbers pulled from the login_attempts table, so the decision logic is
// unit-testable in isolation (mirrors lib/grants.ts / lib/family-deletion.ts).
//
// The window is sliding: the caller counts only failures inside `windowMs`. Once
// the count reaches `threshold`, each further attempt must wait an exponentially
// growing backoff measured from the most recent failure, capped at `maxDelayMs`.
// A quiet window (no failures for windowMs) clears the count and lifts the lock.

export interface LockoutPolicy {
  // How far back a failure still counts (the sliding-window length).
  windowMs: number;
  // Failures within the window before backoff kicks in.
  threshold: number;
  // Backoff at the threshold; it doubles per extra failure beyond it.
  baseDelayMs: number;
  // Ceiling on the backoff, so a determined attacker can't push it to infinity.
  maxDelayMs: number;
}

// The two inputs the caller derives from the attempt history for a given key
// (a username, or the whole instance for the global backstop).
export interface LockoutInput {
  // Number of failed attempts recorded within windowMs.
  recentFailures: number;
  // Milliseconds since the most recent failure; Infinity when there are none.
  msSinceLastFailure: number;
}

export interface LockoutDecision {
  // True when the next attempt must be refused for now.
  lockedOut: boolean;
  // Milliseconds the caller must wait before the next attempt is allowed (0 when
  // not locked out). Never negative.
  retryAfterMs: number;
}

// Username throttle: 5 failures in 15 minutes, then 30s backoff doubling per
// extra failure up to the full window. Keyed on the submitted username, so a
// NAT'd family sharing one IP isn't collectively locked out by one member's typos.
export const USERNAME_LOCKOUT: LockoutPolicy = {
  windowMs: 15 * 60_000,
  threshold: 5,
  baseDelayMs: 30_000,
  maxDelayMs: 15 * 60_000,
};

// Global backstop against username-spray attacks (many usernames, few tries
// each — which slips past the per-username limit). Deliberately coarse and
// lenient: 100 failures across ALL usernames in 15 minutes before a short,
// shallow backoff, so a legitimately busy household is never fully bricked.
export const GLOBAL_LOCKOUT: LockoutPolicy = {
  windowMs: 15 * 60_000,
  threshold: 100,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
};

// Decide whether an attempt for a key is currently throttled. Below the
// threshold it's always allowed; at or above it, the required backoff grows as
// baseDelayMs * 2^(over) (capped at maxDelayMs) measured from the last failure,
// so once that much time has passed since the last failure the attempt is let
// through again.
export function evaluateLockout(
  input: LockoutInput,
  policy: LockoutPolicy
): LockoutDecision {
  const { recentFailures, msSinceLastFailure } = input;
  if (recentFailures < policy.threshold) {
    return { lockedOut: false, retryAfterMs: 0 };
  }
  const over = recentFailures - policy.threshold;
  // 2 ** over overflows to Infinity for large `over`; Math.min clamps it to the
  // ceiling, so the arithmetic stays well-defined.
  const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** over);
  const retryAfterMs = delay - msSinceLastFailure;
  if (retryAfterMs <= 0) return { lockedOut: false, retryAfterMs: 0 };
  return { lockedOut: true, retryAfterMs };
}
