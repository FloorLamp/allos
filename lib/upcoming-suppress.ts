// Pure snooze/dismiss decision layer for the Upcoming page.
// NO DB/network: the query layer (lib/queries/upcoming.ts) reads the profile's
// upcoming_dismissals rows and the actions write them; this module only derives
// the STABLE per-signal key and decides whether a given suppression currently
// hides its item. Keeping the boundaries here (not inline) means they're
// unit-tested in lib/__tests__.

import type { UpcomingItem } from "./upcoming";
import type { Finding } from "./findings";

// A suppression row as stored (the two nullable state columns). A row is either a
// SNOOZE (snooze_until set, dismissed_at null) or a DISMISS (dismissed_at set,
// snooze_until null); restoring an item DELETEs the row entirely.
export interface SuppressionRecord {
  snooze_until: string | null;
  dismissed_at: string | null;
}

// The stable key that ties a suppression to a due-signal across time. Every
// UpcomingItem already carries a stable, domain-prefixed `key` (e.g. 'dose:12',
// 'biomarker:ldl', 'appointment:5', 'immunization:mmr', 'goal:3', 'refill:7'),
// derived from the underlying row's id / canonical name — exactly the identity a
// snooze/dismiss must follow — so the signal key IS that key. Centralized here so
// the contract has a single, testable source of truth.
export function signalKey(item: Pick<UpcomingItem, "key">): string {
  return item.key;
}

// The generalized suppression key for ANY finding (issue #39): a Finding's
// dedupeKey. It is the same string an UpcomingItem's `key` yields via
// upcomingToFinding, so old upcoming_dismissals rows keep matching — the store is
// unchanged, just now shared by the coaching/digest engines too. Centralized here
// (alongside signalKey) so the findings bus and Upcoming agree on the contract.
export function findingKey(finding: Pick<Finding, "dedupeKey">): string {
  return finding.dedupeKey;
}

// Whether a suppression record hides a specific UpcomingItem right now, honoring the
// item's care-tier PERSISTENCE policy (issue #700 ask 5). This is the ONE dispatcher
// the Upcoming filter AND its "snoozed & dismissed" complement route every item
// through, so the two never disagree about what's hidden:
//   - A care-persistent item (an OVERDUE safety follow-up) RESISTS an indefinite
//     dismiss — a dismissed_at row is ignored for it — but still HONORS a live
//     time-boxed snooze, so a dismiss can never permanently silence a possibly-missed
//     follow-up while a deliberate snooze can still defer it.
//   - Every other item uses the standard isSuppressed rule.
export function isItemHiddenBySuppression(
  item: Pick<UpcomingItem, "carePersistent">,
  record: SuppressionRecord | undefined,
  today: string
): boolean {
  if (!record) return false;
  if (item.carePersistent) {
    // Resist the indefinite dismiss; honor only a live snooze.
    if (record.snooze_until && !record.dismissed_at)
      return today < record.snooze_until;
    return false;
  }
  return isSuppressed(record, today);
}

// Whether a suppression record hides its item right now (`today` = the profile-
// local YYYY-MM-DD). Semantics:
//   - Dismissed → hidden indefinitely (until the user restores it, which removes
//     the row so no record reaches here).
//   - Snoozed → hidden while today < snooze_until; on/after that date the snooze
//     has expired and the item reappears.
//   - Neither field set → not hidden (a defensive no-op; such a row shouldn't
//     exist).
// Dismiss takes precedence over any lingering snooze_until on the same row.
export function isSuppressed(
  record: SuppressionRecord,
  today: string
): boolean {
  if (record.dismissed_at) return true;
  if (record.snooze_until) return today < record.snooze_until;
  return false;
}
