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
