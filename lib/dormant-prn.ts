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
import { DORMANCY_DEFAULT_DAYS } from "./domain-dormancy";

export const DORMANT_PRN_PREFIX = "dormant-prn:";

// THE INTERVAL IS THE DORMANCY REGISTRY'S (#4242). "Has this stopped arriving?" is one
// question with one owner-ruled default (`DORMANCY_DEFAULT_DAYS`, 2026-08-13: a domain
// with nothing in 90 days is dormant). This sweep predates that registry and re-declared
// the same 90 independently, so a doctrine change reached every dormancy surface EXCEPT
// medications. It is now a TENANT: the interval is taken by reference and nothing here
// restates a number.
//
// Tenancy of the INTERVAL only, deliberately — this is not a `DormancyDomain` and must
// not become one. A dormancy domain's consequence is a COLLAPSE, and the owner ruling
// behind that registry puts medications out of its reach by construction: a section that
// carries an obligation never collapses. The consequence here is the opposite shape — a
// suggest-only "move to past" card that ADDS an offer and hides nothing — so it stays
// this module's own, exactly as a tenant's consequence should.
//
// The COMPARISON also stays this module's own, and that is a known divergence rather than
// an oversight: the sweep is inclusive (dormant at `>= thresholdDays`) where the shared
// `freshnessState` boundary is strict (`> intervalDays`). Aligning it would move every
// candidate's first eligible day by one, which is a behaviour change this share-the-
// interval refactor deliberately does not make.
export const DEFAULT_DORMANT_DAYS = DORMANCY_DEFAULT_DAYS;

export function dormantPrnDismissalKey(itemId: number): string {
  return `${DORMANT_PRN_PREFIX}${itemId}`;
}

export interface DormantPrnInput {
  itemId: number;
  name: string;
  asNeeded: boolean;
  active: boolean;
  // Profile-local calendar days; both are compared with profile-local `todayStr`.
  lastAdministration: string | null;
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
