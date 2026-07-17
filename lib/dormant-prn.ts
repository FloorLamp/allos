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

export interface DormantPrnInput {
  itemId: number;
  name: string;
  asNeeded: boolean;
  active: boolean;
  // The most recent administration DATE (YYYY-MM-DD), or null if never dosed.
  lastAdministration: string | null;
  // Fallback age anchor when never dosed — the med's created DATE.
  createdOn: string;
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
    const anchor = m.lastAdministration ?? m.createdOn;
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
