// Pure aggregation shaping for the Upcoming page — the
// forward-looking mirror of the Timeline. It carries NO DB/network: the query
// layer (lib/queries/upcoming.ts) turns each existing due-signal into these
// plain UpcomingItem records, and this module buckets them into urgency bands
// and sorts them. Keeping the banding/sorting here (not inline in the page) means
// it's unit-tested in lib/__tests__ and the page stays a thin composition.

import { daysBetweenDateStr } from "./date";
import { daysRemainingLabel } from "./format-date";

// The forward-looking domains we aggregate. Each maps to one existing signal:
//   dose        — a scheduled supplement/medication dose pending today
//   refill      — a tracked med/supplement running low on supply
//   appointment — a scheduled medical visit on its calendar date
//   visit       — a preventive well-visit due/overdue (issue #82, satisfied by a visit)
//   screening   — a preventive screening due/overdue (issue #82, satisfied by a result)
//   immunization— a vaccine due/overdue on the tracked schedule
//   biomarker   — a lab past its per-analyte retest (staleness) window
//   goal        — a goal with a target_date approaching or overdue
//   training    — an unmet weekly frequency target
export type UpcomingDomain =
  | "dose"
  | "refill"
  | "appointment"
  | "visit"
  | "screening"
  | "immunization"
  | "biomarker"
  | "goal"
  | "training";

// Stable within-band ordering when two items share an effective due date.
const DOMAIN_ORDER: Record<UpcomingDomain, number> = {
  dose: 0,
  refill: 1,
  appointment: 2,
  visit: 3,
  screening: 4,
  immunization: 5,
  biomarker: 6,
  goal: 7,
  training: 8,
};

export type UrgencyBand = "overdue" | "today" | "week" | "later";

export const BAND_ORDER: UrgencyBand[] = ["overdue", "today", "week", "later"];

export const BAND_LABELS: Record<UrgencyBand, string> = {
  overdue: "Overdue",
  today: "Today",
  week: "This week",
  later: "Later",
};

export interface UpcomingItem {
  // Stable React key / dedupe id (e.g. "dose:12", "biomarker:LDL").
  key: string;
  domain: UpcomingDomain;
  title: string;
  // Optional secondary context line (dosage, last-tested date, progress…).
  detail?: string | null;
  href: string;
  // Due date as YYYY-MM-DD. Null means "due now / no specific calendar date"
  // (e.g. a scheduled dose, or a status-driven signal), which bands and sorts as
  // today unless `band` is set.
  dueDate: string | null;
  // Explicit band override for status-driven signals (immunizations, training
  // pace) that have no numeric due date — they're urgent by status, not by a
  // date the bucketer can derive.
  band?: UrgencyBand;
  // Explicit due-text override for status-driven signals ("Overdue", "2/3 this
  // week"); date-driven items fall back to a computed countdown label.
  dueText?: string;
  // When set, the page renders an inline "mark taken" form for this dose id
  // (reusing the existing dose check-off path). Only dose items carry one.
  doseId?: number;
  // When set, the row renders inline preventive controls — "Mark done" (records a
  // satisfaction) plus a declined / not-applicable override — for this stable
  // catalog rule key. Only visit/screening items (issue #82) carry one; mirrors
  // doseId's inline fast path.
  preventiveRuleKey?: string;
}

export interface BandGroup {
  band: UrgencyBand;
  label: string;
  items: UpcomingItem[];
}

// Whole days from `today` to a due date: negative = overdue, 0 = today, positive
// = future. A null due date counts as today (0). Calendar-based (timezone-
// independent) — the caller resolves `today` in the profile's timezone.
export function daysUntilDue(dueDate: string | null, today: string): number {
  if (dueDate == null) return 0;
  const n = daysBetweenDateStr(today, dueDate); // dueDate − today
  return n == null ? 0 : n;
}

// Which urgency band a whole-day offset falls in. "This week" is the next 7 days
// (1–7); anything further out is "Later".
export function bandForDays(days: number): UrgencyBand {
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= 7) return "week";
  return "later";
}

// The band an item belongs to: an explicit `band` override wins (status-driven
// signals), else it's derived from the due date relative to today.
export function bandForItem(item: UpcomingItem, today: string): UrgencyBand {
  return item.band ?? bandForDays(daysUntilDue(item.dueDate, today));
}

// Human due-text for an item: an explicit `dueText` override wins; otherwise a
// countdown label off the due date ("today" / "tomorrow" / "N days left" /
// "N days overdue"), or "Today" for a null (now) due date.
export function upcomingDueText(item: UpcomingItem, today: string): string {
  if (item.dueText != null) return item.dueText;
  if (item.dueDate == null) return "Today";
  return daysRemainingLabel(item.dueDate, today) ?? item.dueDate;
}

// The effective calendar date used to sort an item within its band. A null due
// date sorts as today so status-driven items cluster with same-day work.
function sortDate(item: UpcomingItem, today: string): string {
  return item.dueDate ?? today;
}

// Bucket items into the four urgency bands, each sorted by effective due date
// ascending (soonest / most-overdue first), then by domain, then title — so the
// order is deterministic. Empty bands are dropped, and the non-empty bands come
// back in fixed Overdue → Today → This week → Later order.
export function groupUpcoming(
  items: UpcomingItem[],
  today: string
): BandGroup[] {
  const byBand = new Map<UrgencyBand, UpcomingItem[]>();
  for (const item of items) {
    const band = bandForItem(item, today);
    const arr = byBand.get(band);
    if (arr) arr.push(item);
    else byBand.set(band, [item]);
  }
  const groups: BandGroup[] = [];
  for (const band of BAND_ORDER) {
    const arr = byBand.get(band);
    if (!arr || arr.length === 0) continue;
    arr.sort(
      (a, b) =>
        sortDate(a, today).localeCompare(sortDate(b, today)) ||
        DOMAIN_ORDER[a.domain] - DOMAIN_ORDER[b.domain] ||
        a.title.localeCompare(b.title)
    );
    groups.push({ band, label: BAND_LABELS[band], items: arr });
  }
  return groups;
}
