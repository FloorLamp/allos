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

// ---- "Mark done" typed outcome (#2140) --------------------------------------
//
// What markCarePlanItemDone actually did. The write used to be a bare UPDATE with an
// unconditional formOk() behind it, so a forged id, a stale tap on an item someone
// had meanwhile cancelled, and a real completion all confirmed identically. The
// transition now answers from state; `already-closed` carries the status that
// actually persists so the caller can name it (#280's rule).
export type CarePlanDoneOutcome =
  | { kind: "completed" }
  | { kind: "already-closed"; status: string }
  | { kind: "not-found" };

// The statuses a repeat "Mark done" tap may treat as ITS OWN prior success — the
// completed-family spellings. Every other closed status (cancelled, revoked, …) is
// someone else's decision, and confirming over it would silently overwrite it.
const COMPLETED_STATUSES = new Set(["completed", "complete", "done"]);

// One formatter over the outcome for every "Mark done" surface (the Upcoming inline
// chip and the completed-appointment offer), so a refusal is worded once. A repeat
// tap on a completed item is idempotent success ("already"); any OTHER closed status
// is a refusal that names what persists rather than confirming a write that never
// happened.
export function carePlanDoneResult(
  outcome: CarePlanDoneOutcome
): { ok: true; message: string } | { ok: false; error: string } {
  switch (outcome.kind) {
    case "completed":
      return { ok: true, message: "Marked done" };
    case "already-closed":
      return COMPLETED_STATUSES.has(outcome.status.trim().toLowerCase())
        ? { ok: true, message: "Already marked done" }
        : {
            ok: false,
            error: `Not marked — this item is ${outcome.status.trim().toLowerCase()}.`,
          };
    case "not-found":
      return { ok: false, error: "Couldn't find that care-plan item." };
  }
}

// ---- The status / category ENTRY vocabularies (issue #1676) -----------------
//
// `care_plan_items.status` is deliberately free-form TEXT (no DB CHECK, see
// lib/types/medical.ts): importers pass FHIR CarePlan.activity status codes through
// verbatim. But the form offered a bare <input>, so a hand-typed "finished" or
// "Done — 3/4" produced a status isCarePlanItemOpen() does not recognize as CLOSED,
// and the item kept nudging Upcoming forever. The picker below offers the statuses
// this module actually understands; free text stays reachable, and the form states
// out loud what an unrecognized status does.
//
// DECISION PINNED (#1676): the unrecognized-status fate is UNCHANGED — a status this
// module doesn't know still counts as OPEN and still nudges. That is the safe
// direction (a real plan with an odd imported status must not go silent), it is what
// every importer already relies on, and lib/__tests__/care-plan-upcoming.test.ts
// pins it. What #1676 changes is only that the behaviour is now VISIBLE at entry
// instead of a silent surprise.

// The open (still-actionable) statuses this module recognizes by name — the FHIR
// CarePlan / CarePlan.activity.detail active-side vocabulary. Nothing branches on
// membership here: an unlisted status is open too. The list exists so the picker
// can OFFER a spelling instead of inviting a novel one.
export const CARE_PLAN_OPEN_STATUSES: readonly string[] = [
  "planned",
  "scheduled",
  "active",
  "in-progress",
  "on-hold",
  "unknown",
];

// The closed statuses, in the curated order, for the picker's second group.
export const CARE_PLAN_CLOSED_STATUS_LIST: readonly string[] = [
  ...CARE_PLAN_CLOSED_STATUSES,
];

// Whether a status string is one this module has a NAME for — i.e. whether the
// open/closed decision above was made by recognition rather than by the
// unrecognized-status default. Drives the form's "this status is outside the
// open/closed machinery" notice.
export function isRecognizedCarePlanStatus(
  status: string | null | undefined
): boolean {
  const s = status?.trim().toLowerCase();
  if (!s) return false;
  return (
    CARE_PLAN_CLOSED_STATUSES.has(s) ||
    CARE_PLAN_OPEN_STATUSES.some((o) => o === s)
  );
}

// The CATEGORY vocabulary: what KIND of planned activity an item is. The values are
// exactly the ones the CDA Plan-of-Treatment importer writes (CARE_PLAN_ELEMENTS in
// lib/cda/constants.ts derives its `category` type from this union), so a manually
// entered item and an imported one land in the same buckets instead of the form
// inventing a thirteenth spelling of "procedure".
export const CARE_PLAN_CATEGORIES = [
  "procedure",
  "encounter",
  "observation",
  "medication",
  "supply",
  "activity",
] as const;

export type CarePlanCategory = (typeof CARE_PLAN_CATEGORIES)[number];

// Friendly labels. Each names the attribute that tells the bucket apart from its
// neighbours — "observation" and "procedure" are both things a clinician orders, so
// the label says which side of that line it sits on.
export const CARE_PLAN_CATEGORY_LABELS: Record<CarePlanCategory, string> = {
  procedure: "Procedure — something done to you",
  encounter: "Encounter — a visit to attend",
  observation: "Observation — a test or measurement",
  medication: "Medication — something to take",
  supply: "Supply — a device or material",
  activity: "Activity — something to do",
};

// The SHORT label a category wears on a row (#2615 item 4). CARE_PLAN_CATEGORY_LABELS
// above is the PICKER's vocabulary — it spends a clause explaining the bucket, which
// is right beside a radio and far too long for an Upcoming subtitle. What the row was
// showing instead was the stored value verbatim: "encounter", "observation",
// "procedure", lowercase FHIR-ish keys handed straight to a reader. This is the same
// six buckets as a plain noun.
const CARE_PLAN_CATEGORY_SHORT: Record<CarePlanCategory, string> = {
  procedure: "Procedure",
  encounter: "Visit",
  observation: "Test",
  medication: "Medication",
  supply: "Supply",
  activity: "Activity",
};

// `care_plan_items.category` is free-form TEXT (importers pass their own vocabulary
// through), so an unrecognized value is CAPITALIZED and shown rather than dropped or
// guessed at — the same posture isCarePlanItemOpen takes on an unknown status.
export function carePlanCategoryLabel(
  category: string | null | undefined
): string | null {
  const raw = category?.trim();
  if (!raw) return null;
  const known = CARE_PLAN_CATEGORY_SHORT[raw.toLowerCase() as CarePlanCategory];
  if (known) return known;
  return raw.charAt(0).toLocaleUpperCase() + raw.slice(1);
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
    [carePlanCategoryLabel(item.category), item.provider_name]
      .filter(Boolean)
      .join(" · ") || "Planned care";
  return {
    key: `careplan:${item.id}`,
    domain: "careplan",
    title: item.description,
    detail,
    href: "/records/care/overview",
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
