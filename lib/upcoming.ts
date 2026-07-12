// Pure aggregation shaping for the Upcoming page — the
// forward-looking mirror of the Timeline. It carries NO DB/network: the query
// layer (lib/queries/upcoming.ts) turns each existing due-signal into these
// plain UpcomingItem records, and this module buckets them into urgency bands
// and sorts them. Keeping the banding/sorting here (not inline in the page) means
// it's unit-tested in lib/__tests__ and the page stays a thin composition.

import { daysBetweenDateStr, shiftDateStr } from "./date";
import { daysRemainingLabel } from "./format-date";
import { compareSortHint } from "./dose-order";

// The longest a user-requested snooze can push a finding out (~10 years). Clamped
// so a tampered form can't set an absurd `snooze_until`. Baked into snoozeUntil so
// every snooze writer (the dashboard hero, the Upcoming quick-snooze, and any
// future surface) shares one max — see snoozeUntil.
const SNOOZE_MAX_DAYS = 3650;

// The `snooze_until` date for snoozing a finding `days` days from `today`
// (YYYY-MM-DD). One source of truth for the snooze policy shared by every snooze
// writer: validates the request (finite, at least 1 day) and clamps to
// SNOOZE_MAX_DAYS, flooring fractional days. Returns null for an invalid request
// so callers reject it uniformly instead of each re-deriving the same guard.
export function snoozeUntil(today: string, days: number): string | null {
  if (!Number.isFinite(days) || days < 1) return null;
  return shiftDateStr(today, Math.min(Math.floor(days), SNOOZE_MAX_DAYS));
}

// The forward-looking domains we aggregate. Each maps to one existing signal:
//   dose        — a scheduled supplement/medication dose pending today
//   refill      — a tracked med/supplement running low on supply
//   interaction — two active stack items with a known drug interaction (issue #144)
//   appointment — a scheduled medical visit on its calendar date
//   visit       — a preventive well-visit due/overdue (issue #82, satisfied by a visit)
//   screening   — a preventive screening due/overdue (issue #82, satisfied by a result)
//   immunization— a vaccine due/overdue on the tracked schedule
//   biomarker   — a lab past its per-analyte retest (staleness) window
//   goal        — a goal with a target_date approaching or overdue
//   training    — an unmet weekly frequency target
//   careplan    — a provider-ordered care_plan_item with a planned_date (issue #84)
//
// Three of these domains are NOT date-scheduled due-signals but the orthogonal
// "something's off" signals the unified attention model (lib/attention.ts, issue
// #524) folds in so the dashboard card and this page draw from ONE item set:
//   biomarker-flag — a newly out-of-range/non-optimal lab reading (issue #526)
//   integration    — a failing / needs-reauth sync provider
//   review         — the unresolved import-review pair count
// They carry `signalGroup` (below) instead of a due date, so they surface under
// their own "Flagged" / "For review" groupings rather than in the date bands.
export type UpcomingDomain =
  | "dose"
  | "refill"
  | "dietary-limit"
  | "interaction"
  | "appointment"
  | "visit"
  | "screening"
  | "immunization"
  | "biomarker"
  | "goal"
  | "training"
  | "careplan"
  | "biomarker-flag"
  | "integration"
  | "review";

// Stable within-band ordering when two items share an effective due date.
const DOMAIN_ORDER: Record<UpcomingDomain, number> = {
  dose: 0,
  refill: 1,
  "dietary-limit": 2,
  interaction: 3,
  appointment: 4,
  careplan: 5,
  visit: 6,
  screening: 7,
  immunization: 8,
  biomarker: 9,
  goal: 10,
  training: 11,
  // The "something's off" signals (issue #524). They never share a date band with
  // the scheduled domains (they carry `signalGroup`, not a due date), so these
  // ranks only order them WITHIN the Flagged / For-review groupings: the clinical
  // flag leads, then a broken sync, then the housekeeping review count.
  "biomarker-flag": 12,
  integration: 13,
  review: 14,
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
  // Optional within-band ordering key (issue #297). Generic — any domain that
  // wants an intra-day order beyond date/domain/title supplies one. Dose items
  // set it from the shared dose-day sort key (bucket → priority → stack → name),
  // so morning and bedtime doses no longer interleave alphabetically. Compared
  // lexically (via compareSortHint) BEFORE the title fallback; an item without
  // one ("") ties and falls through to title, so non-dose domains are unaffected.
  sortHint?: string;
  // Clinical-importance ranking weight (issue #517). Risk-stratified retest /
  // screening items carry a positive priority (family cardiac history → lipids,
  // immunocompromised → hepatitis-A immunity…) so within a band the important item
  // leads; everything else defaults to 0 (routine). A tiebreak AFTER due date, so
  // it only reorders items coming due on the SAME day — the tighter cadence already
  // pulls a high-risk item to an earlier date.
  priority?: number;
  // When set, the page renders an inline "mark taken" form for this dose id
  // (reusing the existing dose check-off path). Only dose items carry one.
  doseId?: number;
  // When set, the row renders inline preventive controls — "Mark done" (records a
  // satisfaction) plus a declined / not-applicable override — for this stable
  // catalog rule key. Only visit/screening items (issue #82) carry one; mirrors
  // doseId's inline fast path.
  preventiveRuleKey?: string;
  // Preventive items only (issue #85): the prefilled new-appointment URL for the
  // "Book" CTA (title + kind + suggested date as query params). Absent once a
  // matching visit is already scheduled.
  bookHref?: string;
  // Preventive items only (issue #85): true when a FUTURE matching-kind appointment
  // is already booked, so the row renders a quiet "Scheduled" state (links to the
  // appointment) instead of nagging.
  scheduled?: boolean;
  // When set, the row renders an inline "Mark done" form that marks this
  // care_plan_items row completed (issue #84) — the same inline fast-path shape as
  // doseId/preventiveRuleKey. Only careplan items carry one.
  carePlanItemId?: number;
  // Whether this item supports snooze/dismiss through the shared findings store
  // (issue #524). Date-scheduled due-signals and biomarker flags do (undefined is
  // treated as suppressible); the structural signals (review / failing integration)
  // are resolved, not snoozed, so they set this false and render no snooze menu.
  suppressible?: boolean;
  // The "something's off" signals only (issue #524): which page grouping the item
  // surfaces under ("Flagged" for out-of-range labs, "For review" for the review
  // count + failing integrations). Set ⇒ the item is NOT a date-scheduled signal,
  // so the page groups it separately from the urgency bands and the card files it
  // under "Needs review". Absent for every date-scheduled domain.
  signalGroup?: SignalGroup;
}

// The two non-date groupings the "something's off" signals surface under on the
// Upcoming page (issue #524). Flagged = out-of-range lab readings; review = the
// import-review count and failing-integration signals (both act on /data?section=review).
export type SignalGroup = "flagged" | "review";

// Whether an item participates in snooze/dismiss (issue #524). Undefined defaults
// to suppressible so every existing date-scheduled due-signal keeps its menu; only
// the structural signals opt out with an explicit false.
export function isItemSuppressibleFlag(item: UpcomingItem): boolean {
  return item.suppressible !== false;
}

export interface BandGroup {
  band: UrgencyBand;
  label: string;
  items: UpcomingItem[];
}

// Total item count across all bands (issue #512): the Upcoming page had no total
// anywhere, so the dashboard hero's "+N more in Upcoming" had no number to
// reconcile against. This sums the banded groups (every collected item lands in
// exactly one band, so it equals the collected count) and is the one figure the
// page header shows.
export function totalUpcomingCount(groups: BandGroup[]): number {
  return groups.reduce((sum, g) => sum + g.items.length, 0);
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
export function sortDate(item: UpcomingItem, today: string): string {
  return item.dueDate ?? today;
}

// The ONE within-band comparator (issue #524, decision #2): date → priority →
// domain → sortHint → title. Both surfaces order the SAME facts the SAME way — the
// Upcoming page's date bands (groupUpcoming) and the dashboard card
// (lib/attention.ts) both sort with this, so "two orderings of the same facts" can
// never drift (the card used to ignore the #517 risk priority AND the due date —
// issue #525). Purely relative, so it slots straight into Array.sort.
export function compareWithinBand(
  a: UpcomingItem,
  b: UpcomingItem,
  today: string
): number {
  return (
    sortDate(a, today).localeCompare(sortDate(b, today)) ||
    // Clinical-importance ranking (issue #517): among items due the SAME day, the
    // higher-priority (risk-driven) item leads. Default 0, so ordinary items are
    // unaffected and the date-first order stands.
    (b.priority ?? 0) - (a.priority ?? 0) ||
    DOMAIN_ORDER[a.domain] - DOMAIN_ORDER[b.domain] ||
    compareSortHint(a.sortHint, b.sortHint) ||
    a.title.localeCompare(b.title)
  );
}

// Bucket items into the four urgency bands, each sorted by effective due date
// ascending (soonest / most-overdue first), then by domain, then by the optional
// per-domain sortHint (dose-day order for doses — issue #297), then title — so
// the order is deterministic. Empty bands are dropped, and the non-empty bands
// come back in fixed Overdue → Today → This week → Later order.
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
    arr.sort((a, b) => compareWithinBand(a, b, today));
    groups.push({ band, label: BAND_LABELS[band], items: arr });
  }
  return groups;
}
