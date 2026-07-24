// Pure layout/model helpers for the multi-view Medications page (issue #1373 Part 1).
// No DB, no JSX — the page resolves the ProfileScope + loop-composes each member's
// loadMedicationsData / household rollup, then formats over these. Unit-tested in
// lib/__tests__/medication-multi-view.test.ts.
//
// The board fan-out follows the #1096/#1328 multi-view discipline: single-view (one
// in-view member) renders exactly as today (one board, no subject header) — these
// helpers exist ONLY to order the boards and to shape the ONE genuinely cross-member
// element, the leading "Today across everyone" strip.

import { MEDICATIONS_HREF } from "./hrefs";
import type { UpcomingItem } from "./upcoming";

// The order regimen boards render in (product-decided, #1373): the ACTING profile
// first (its board is the one the write-centric add-workspace targets), then the
// remaining in-view members in view order. resolveScope always includes the acting
// profile in viewIds, but this is defensive against an empty/malformed set.
export function medBoardOrder(
  actingProfileId: number,
  viewIds: readonly number[]
): number[] {
  const rest = viewIds.filter((id) => id !== actingProfileId);
  return viewIds.includes(actingProfileId)
    ? [actingProfileId, ...rest]
    : [...viewIds];
}

// The same-page anchor a strip item deep-links to (each item "jumps to its member's
// board"). A fragment, never an AppRoute — the boards live on this one page.
export function medBoardAnchor(profileId: number): string {
  return `#med-board-${profileId}`;
}

// The DOM id a board carries so the anchor above resolves.
export function medBoardId(profileId: number): string {
  return `med-board-${profileId}`;
}

// One attention entry in the leading strip — a due dose or a low refill for a member.
export interface MedStripItem {
  // The UpcomingItem key (`dose:<id>` / `refill:<id>`), a stable React key.
  key: string;
  title: string;
  detail: string | null;
  dueText: string | null;
}

// A member's medication attention, filtered out of the household rollup (which mixes
// supplements + appointments): keep ONLY the medication rows. A medication dose/refill
// UpcomingItem carries `href === MEDICATIONS_HREF` (intakeHref('medication')); a
// supplement's points at the Nutrition tab, and the rollup's nextAppointment is dropped
// here (this is the Medications page). ONE computation — the rollup is the household
// page's exact per-member attention aggregation (#221), never a second engine.
export interface HouseholdMedRollup {
  dueDoses: UpcomingItem[];
  lowRefills: UpcomingItem[];
}

export interface MedStripMember {
  profileId: number;
  dueDoses: MedStripItem[];
  lowRefills: MedStripItem[];
}

function toStripItem(item: UpcomingItem): MedStripItem {
  return {
    key: item.key,
    title: item.title,
    detail: item.detail ?? null,
    dueText: item.dueText ?? null,
  };
}

function isMedicationItem(item: UpcomingItem): boolean {
  return item.href === MEDICATIONS_HREF;
}

// Reduce a member's household rollup to its medication attention for the strip.
export function medStripMember(
  profileId: number,
  rollup: HouseholdMedRollup
): MedStripMember {
  return {
    profileId,
    dueDoses: rollup.dueDoses.filter(isMedicationItem).map(toStripItem),
    lowRefills: rollup.lowRefills.filter(isMedicationItem).map(toStripItem),
  };
}

// Whether a member contributes anything to the strip (so an all-quiet member is
// dropped rather than rendering an empty row).
export function medStripMemberHasItems(m: MedStripMember): boolean {
  return m.dueDoses.length > 0 || m.lowRefills.length > 0;
}
