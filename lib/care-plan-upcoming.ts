// Pure adapter from a stored care_plan_items row (provider-ordered / manually
// entered planned care) to an Upcoming due-signal (lib/upcoming.ts) — issue #84.
// NO DB/network: the query layer (lib/queries/upcoming.ts) reads the profile's
// care-plan items (profile-scoped) and maps the open, dated ones through the
// functions below into UpcomingItems. Keeping the mapping + status semantics here
// (not inline in the query builder) makes them unit-testable and keeps the
// key/band/href contract in one place.
//
// A care-plan item carries a REAL calendar date (planned_date), so — unlike the
// status-driven visit/screening/immunization signals — it rides the generic
// date-banding: overdue past its planned date, else Today/This week/Later by how
// far off it is. No explicit band/dueText override needed.

import type { UpcomingItem } from "./upcoming";

// The structural subset of a care_plan_items row this adapter needs. Kept minimal
// (not the full CarePlanItem type) so it's testable with tiny fixtures and doesn't
// couple to the read layer's row shape.
export interface CarePlanItemLike {
  id: number;
  description: string;
  category?: string | null;
  planned_date: string | null;
  status?: string | null;
  provider_name?: string | null;
}

// Status values that mean a care-plan item is CLOSED — completed or cancelled — so
// it no longer nudges. Compared case-insensitively after trimming. Drawn from the
// FHIR CarePlan / CarePlan.activity.detail status vocabularies (completed,
// cancelled, stopped, revoked, entered-in-error, not-done, rejected) plus common
// free-text spellings. Anything else — including a null/blank status, "planned",
// "active", "scheduled", "in-progress", "on-hold", "unknown" — counts as OPEN and
// still actionable.
const CARE_PLAN_CLOSED_STATUSES = new Set([
  "completed",
  "complete",
  "done",
  "cancelled",
  "canceled",
  "stopped",
  "revoked",
  "entered-in-error",
  "not-done",
  "rejected",
  "abandoned",
]);

// Whether a care-plan item is still open (actionable) given its status. A null or
// unrecognized status is treated as open — a dated plan with no explicit close
// still deserves a nudge.
export function isCarePlanItemOpen(status: string | null | undefined): boolean {
  if (status == null) return true;
  return !CARE_PLAN_CLOSED_STATUSES.has(status.trim().toLowerCase());
}

// Map one care-plan item to an Upcoming item. The stable key is `careplan:<id>` —
// namespaced so it never collides with another domain's key and so a snooze/dismiss
// follows the row across time. The item links to /care-plan and carries its id for
// the inline "Mark done" form. The detail line names the plan CATEGORY + ordering
// clinician when present (never leaked at minimal calendar detail — see the feed's
// CATEGORY_MINIMAL_LABEL).
export function carePlanItemToUpcomingItem(
  item: CarePlanItemLike
): UpcomingItem {
  const detail =
    [item.category, item.provider_name].filter(Boolean).join(" · ") ||
    "Planned care";
  return {
    key: `careplan:${item.id}`,
    domain: "careplan",
    title: item.description,
    detail,
    href: "/care-plan",
    dueDate: item.planned_date,
    carePlanItemId: item.id,
  };
}

// Filter a profile's care-plan items down to the OPEN, DATED ones and map each to
// an Upcoming item. Items with no planned_date (undated intentions) never surface —
// there's nothing to band them against — and closed (completed/cancelled) items are
// dropped. Pure over the input list.
export function carePlanUpcomingItems(
  items: readonly CarePlanItemLike[]
): UpcomingItem[] {
  return items
    .filter((i) => i.planned_date != null && isCarePlanItemOpen(i.status))
    .map(carePlanItemToUpcomingItem);
}
