// Pure dormant-PRN sweep logic (issue #880 item 3). No DB or network — unit-tested in
// lib/__tests__/dormant-prn.test.ts.
//
// Episode-end reconciliation only catches FUTURE cases; the existing backlog — an OTC PRN
// med added once and never retired (the 2am ibuprofen months later), or PRN use that
// never rode an episode — needs a sweep. This module finds active PRN meds with no dose in
// a long while so a suggest-only card on /medications can offer "move to past" (one-tap
// course close, #560). The dismissal is keyed by the ITEM id (#203: integer ids never
// recycle, so an id-key is stable and can't mis-suppress a later same-named med — unlike a
// name-key, which would).

import { daysBetweenDateStr } from "./date";

export const DORMANT_PRN_PREFIX = "dormant-prn:";
export const DEFAULT_DORMANT_DAYS = 90;

export function dormantPrnDismissalKey(itemId: number): string {
  return `${DORMANT_PRN_PREFIX}${itemId}`;
}

// BOTH DAY ANCHORS BELOW ARE PROFILE-LOCAL CALENDAR DAYS (#3572), because both are
// differenced against a profile-local `todayStr` — a person's sense of "I haven't
// taken this in a while" is in their own days, not UTC's. `intake_item_logs.date` is
// already such a day, written from `today(profileId)`. A med's `created_at` is an
// INSTANT and is NOT: `created_at.slice(0, 10)` is the UTC calendar day and nobody's
// local one, and it shipped here for two months — for any profile whose local date
// differs from UTC at the moment of the read (most of them, most of the day) the
// 90-day threshold landed a day early or a day late, which changes which medications
// the app decides are dormant. Resolve it with `dateFromCreatedAt(value, tz)` before
// it reaches this module. The field is NAMED for its calendar so the next author
// cannot hand a truncation to it without saying something untrue out loud.
export interface DormantPrnInput {
  itemId: number;
  name: string;
  asNeeded: boolean;
  active: boolean;
  // The most recent administration DATE (YYYY-MM-DD, profile-local), or null if
  // never dosed.
  lastAdministration: string | null;
  // Fallback age anchor when never dosed — the med's created day, resolved in the
  // PROFILE'S zone. Null when the stored instant is unreadable, which drops the med
  // from the sweep rather than dating it from a guess: this is a suggest-only card,
  // so silence is the safe failure.
  createdOnLocalDay: string | null;
}

export interface DormantPrnSuggestion {
  itemId: number;
  name: string;
  lastUsed: string | null;
  daysSince: number;
  dedupeKey: string;
}

// Active PRN meds whose last dose (or creation, if never dosed) is >= thresholdDays ago,
// longest-dormant first. A non-PRN or inactive med is never a candidate (scheduled meds
// have their own adherence tracking; an already-past med is done).
export function dormantPrnCandidates(
  meds: DormantPrnInput[],
  todayStr: string,
  thresholdDays: number = DEFAULT_DORMANT_DAYS
): DormantPrnSuggestion[] {
  const out: DormantPrnSuggestion[] = [];
  for (const m of meds) {
    if (!m.active || !m.asNeeded) continue;
    const anchor = m.lastAdministration ?? m.createdOnLocalDay;
    if (anchor == null) continue;
    const days = daysBetweenDateStr(anchor, todayStr);
    if (days == null || days < thresholdDays) continue;
    out.push({
      itemId: m.itemId,
      name: m.name,
      lastUsed: m.lastAdministration,
      daysSince: days,
      dedupeKey: dormantPrnDismissalKey(m.itemId),
    });
  }
  return out.sort(
    (a, b) => b.daysSince - a.daysSince || a.name.localeCompare(b.name)
  );
}
