// Pure decision logic for the notification delivery-health marker (issue #131).
// A failed Telegram/push send was previously only log.error'd and folded into the
// tick's exit code — a revoked bot token or wrong chat id meant silently missed
// medication reminders with no persisted signal and no UI surface. dispatch()
// (lib/notifications/index.ts) now records a global marker mirroring the
// backup_last_* pattern: set on any failed channel, cleared on the next all-OK
// send. This module owns the pure half (which failure to record); the settings
// read/write lives in index.ts. No DB here — unit-tested in
// lib/__tests__/delivery-status.test.ts.

// The subset of a DispatchResult this decision needs (kept structural so the
// pure helper has no dependency on the channel/dispatch modules).
export interface DispatchOutcome {
  id: string;
  ok: boolean;
  error?: string;
}

export interface DeliveryFailure {
  channel: string;
  error: string;
}

// The persisted marker shape (read back for the Settings surface). `at` is an ISO
// timestamp; `channel` names which delivery channel failed.
export interface NotifyErrorMarker {
  error: string;
  at: string;
  channel: string;
}

// Pick the failure to record from a dispatch fan-out, or null when every attempted
// channel succeeded. Returns the FIRST failed channel (deterministic ordering from
// dispatch), which drives the human-readable marker. An empty result set (no
// channel configured for the profile) is NOT a delivery failure — it returns null
// so the caller leaves any existing marker untouched (nothing was attempted).
export function pickDispatchError(
  results: DispatchOutcome[]
): DeliveryFailure | null {
  if (results.length === 0) return null;
  const failed = results.find((r) => !r.ok);
  if (!failed) return null;
  return { channel: failed.id, error: failed.error ?? "unknown send failure" };
}

// Whether a dispatch fan-out should CLEAR the marker: at least one channel was
// attempted and none failed. (An empty result set clears nothing — see above.)
export function isDeliveryHealthy(results: DispatchOutcome[]): boolean {
  return results.length > 0 && results.every((r) => r.ok);
}

// How a single dispatch should mutate the GLOBAL delivery-health marker.
export type MarkerAction =
  | { action: "set"; failure: DeliveryFailure }
  | { action: "clear" }
  | { action: "keep" };

// Decide how one dispatch fan-out should update the global marker, given the
// channel of any PREVIOUSLY-recorded failure (`prevFailedChannel`; empty for a
// clean state, or for a legacy plain marker written before channel tracking).
//
// Clearing is CHANNEL-AWARE (#192). The marker is global but a tick fans dispatch
// out per profile, so a naive "clear whenever this one dispatch was all-OK" is
// asymmetric across that fan-out: a Telegram-only profile succeeding would clear a
// push failure recorded by an earlier both-channels profile — masking a push that
// is still broken, with the final state depending on profile order. So a healthy
// dispatch only clears the marker when it actually ATTEMPTED the previously-failing
// channel: a later successful push clears a push failure; a Telegram-only profile
// leaves it intact. When the prior channel is unknown (a legacy marker), we fall
// back to the original clear-on-healthy behavior. Setting a failure stays
// unconditional (and is sticky across empty results — see pickDispatchError).
export function decideMarker(
  results: DispatchOutcome[],
  prevFailedChannel: string
): MarkerAction {
  const failure = pickDispatchError(results);
  if (failure) return { action: "set", failure };
  if (!isDeliveryHealthy(results)) return { action: "keep" };
  if (!prevFailedChannel) return { action: "clear" };
  const attemptedPrev = results.some((r) => r.id === prevFailedChannel);
  return attemptedPrev ? { action: "clear" } : { action: "keep" };
}
