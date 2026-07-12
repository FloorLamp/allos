// Pure retention-window math (issue #98). No DB/network here — safe to import from
// the unit suite (lib/__tests__) and from client code.
//
// Two append-mostly maintenance tables are pruned by age on the hourly notify tick,
// alongside the existing deleted_rows undo sweep:
//   • replayed_keys — the offline-replay idempotency ledger. A key only has to
//     outlive the replay-race window (an online event, the on-load flush, and a
//     Background Sync all racing to re-POST the same queued write), so a week is
//     generous. Fixed, not configurable — nothing downstream cares once the race
//     window has passed.
//   • audit_events — the deliberately durable who-did-what trail. Bounded on a
//     self-hosted box by a GENEROUS default that admins can raise/lower (Settings →
//     Server), since self-hosters have their own compliance expectations.
//
// This module holds only the WINDOW math; the DELETEs live in thin DB functions
// (sweepReplayedKeys in lib/offline/writes.ts, pruneAuditEvents in lib/audit.ts).

// replayed_keys: keep a week. The replay-race triple-fire resolves in seconds; a
// week absorbs an offline device that reconnects days later without letting the
// ledger grow without bound.
export const REPLAYED_KEYS_RETENTION_DAYS = 7;

// integration_sync_events: keep 90 days (issue #388). This append-only debug log
// gains a row per provider per hourly tick (~10-70/day with active integrations)
// and was the one tick sibling nothing pruned — ~25k+ rows/year/profile, forever.
// The Review feed and failing-provider banner only ever read recent events, so 90
// days is generous. The prune ALSO always keeps the newest event per (profile,
// provider) regardless of age (see planSyncEventPrune) so a dormant provider's last
// known state never disappears out from under the failure detector.
export const SYNC_EVENTS_RETENTION_DAYS = 90;

// audit_events: keep two years by default. Generous enough that the trail is there
// when an operator needs it, bounded enough that a small box doesn't accumulate
// audit rows forever.
export const DEFAULT_AUDIT_RETENTION_MONTHS = 24;

// The admin-configurable range for audit retention (whole months). The floor keeps
// at least a month of trail; the ceiling (50 years) is effectively "keep forever"
// while still bounding the stored modifier.
export const MIN_AUDIT_RETENTION_MONTHS = 1;
export const MAX_AUDIT_RETENTION_MONTHS = 600;

// Coerce an admin-entered month count to a valid whole-month window. Garbage /
// non-finite input falls back to the default; in-range values are rounded and
// clamped to [MIN, MAX].
export function clampAuditRetentionMonths(months: number): number {
  if (!Number.isFinite(months)) return DEFAULT_AUDIT_RETENTION_MONTHS;
  const n = Math.round(months);
  if (n < MIN_AUDIT_RETENTION_MONTHS) return MIN_AUDIT_RETENTION_MONTHS;
  if (n > MAX_AUDIT_RETENTION_MONTHS) return MAX_AUDIT_RETENTION_MONTHS;
  return n;
}

// SQLite datetime() modifiers for the age-based DELETEs (`ts < datetime('now', ?)`
// selects rows strictly older than the window). The DB functions bind these.
export function daysAgoModifier(days: number): string {
  return `-${days} days`;
}

export function monthsAgoModifier(months: number): string {
  return `-${months} months`;
}

// Pure JS mirrors of the cutoff instant, for unit-testing the boundary independently
// of SQLite's date arithmetic. A row STRICTLY older than the cutoff is expired (a row
// exactly at the cutoff is kept — matching `ts < datetime('now', modifier)`).
export function cutoffDaysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

// Whether a row timestamp is expired against a cutoff: strictly older is expired; a
// row exactly at the cutoff instant is kept.
export function isExpired(rowTs: Date, cutoff: Date): boolean {
  return rowTs.getTime() < cutoff.getTime();
}
