// Pure aggregation shaping for the Upcoming page — the
// forward-looking mirror of the Timeline. It carries NO DB/network: the query
// layer (lib/queries/upcoming.ts) turns each existing due-signal into these
// plain UpcomingItem records, and this module buckets them into urgency bands
// and sorts them. Keeping the banding/sorting here (not inline in the page) means
// it's unit-tested in lib/__tests__ and the page stays a thin composition.

import type { AppRoute } from "./hrefs";
import type { DistanceUnit, TemperatureUnit } from "./settings";
import type { Reason } from "./reasons";
import type { LifecycleSuppressionPolicy } from "./lifecycle";
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
//   illness-care— a logged symptom past a cited duration/trajectory line (issue #805)
//   interaction — two active stack items with a known drug interaction (issue #144)
//   pgx         — a stored PGx result affecting an active medication (issue #710)
//   contrast    — a planned contrast imaging study meeting an allergy/CKD gate (#701)
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
  | "prn-max"
  | "refill"
  | "dietary-limit"
  | "illness-care"
  | "condition-review"
  // An active medication meeting a recorded drug allergy (#1029) — direct,
  // same-class, or documented cross-reactive class. Care-tier, like the
  // interaction/PGx med-safety notes; informational, never prescriptive.
  | "allergy-med"
  | "interaction"
  | "pgx"
  | "contrast"
  // A planned INVASIVE dental procedure meeting an antiresorptive/cardiac/anticoagulant
  // pre-procedure safety gate (#704). Care-tier, like contrast/interaction/PGx.
  | "dental-safety"
  // An active ototoxic medication (#717) — a calm, cited, informational hearing-safety
  // note. Care-tier, like the interaction/PGx/dental med-safety notes.
  | "ototoxic"
  | "appointment"
  | "visit"
  | "screening"
  | "immunization"
  | "biomarker"
  // A medication whose curated monitoring labs are DUE (issue #995) — a retest clock
  // CREATED by taking the drug (lithium → serum level + TSH + renal, clozapine → ANC,
  // warfarin → INR, …). Bus-gated like the biomarker retest; per-entry reach tier
  // (#449) — care entries push (a digest highlight) + rank up, coaching entries are calm.
  | "med-monitor"
  | "goal"
  | "training"
  | "careplan"
  // A tracked finding→follow-up→resolution chain node (issue #700): a linked
  // follow-up that is due/overdue, or that has a matching later record and OFFERS a
  // resolution. Care-tier; an overdue one is care-persistent (see carePersistent).
  | "followup"
  // A severe mental-health instrument score / positive PHQ-9 item 9 (issue #716): a
  // care-tier, NON-DISMISSIBLE crisis finding. Care-tier on-screen (Upcoming + hero)
  // but NEVER pushed — deliberately omitted from the digest DOMAIN_SEQ and given no
  // notify orchestrator, so no channel ever carries crisis content.
  | "mental-health"
  // A day's cumulative outdoor UV dose past the skin-type burn (MED) threshold
  // (issue #1172) — the care half of the two-sided UV-dose sun model. Care-tier,
  // informational (never prescriptive); silent without a skin type.
  | "uv-exposure"
  | "biomarker-flag"
  | "integration"
  | "review";

// Stable within-band ordering when two items share an effective due date.
const DOMAIN_ORDER: Record<UpcomingDomain, number> = {
  dose: 0,
  // A PRN over-max is safety-adjacent — sort it just after scheduled doses, ahead of
  // the calm informational findings (#798).
  "prn-max": 0.5,
  refill: 1,
  "dietary-limit": 2,
  // A logged symptom crossing a cited duration/trajectory care line (#805) — a
  // care-tier informational finding, grouped with the other "review" safety notes.
  "illness-care": 2.5,
  // A positive infection / high-risk screen suggesting a problem-list condition to
  // review (#685) — a care-tier suggest-only finding, alongside the illness-care note.
  "condition-review": 2.6,
  // A recorded drug allergy met by an active med (#1029) — lead the med-safety
  // notes (an allergy on file outranks a pairwise interaction), just ahead of
  // interaction.
  "allergy-med": 2.9,
  interaction: 3,
  pgx: 4,
  contrast: 5,
  // A planned-invasive-dental pre-procedure safety note (#704) — a care-tier
  // informational finding, alongside contrast, ahead of the scheduling domains.
  "dental-safety": 5.5,
  // An active ototoxic-medication hearing-safety note (#717) — a care-tier
  // informational finding, alongside the other med-safety notes, ahead of scheduling.
  ototoxic: 5.6,
  // A same-day UV overexposure heads-up (#1172) — a care-tier informational note,
  // grouped with the other med-safety/care notes ahead of the scheduling domains.
  "uv-exposure": 5.7,
  appointment: 6,
  careplan: 7,
  visit: 8,
  screening: 9,
  immunization: 10,
  biomarker: 11,
  // A med-driven monitoring retest (#995) — sort it alongside the biomarker retest clock
  // it mirrors, just after it.
  "med-monitor": 11.5,
  goal: 12,
  training: 13,
  // A finding follow-up (#700) is care-tier safety — sort it alongside the other
  // care notes (just after the condition-review suggestion), ahead of the calm
  // scheduling/coaching domains.
  followup: 2.7,
  // A severe/self-harm mental-health finding (#716) — highest-priority care note; sort
  // it ahead of the other care notes so the crisis line leads the "Today" band.
  "mental-health": 2.4,
  // The "something's off" signals (issue #524). They never share a date band with
  // the scheduled domains (they carry `signalGroup`, not a due date), so these
  // ranks only order them WITHIN the Flagged / For-review groupings: the clinical
  // flag leads, then a broken sync, then the housekeeping review count.
  "biomarker-flag": 14,
  integration: 15,
  review: 16,
};

// The viewer's display units for measurement-carrying item strings (#1019 — the
// display-unit policy): a WEB boundary (the Upcoming page, the dashboard hero)
// resolves the login's prefs and passes them down so the item builders format
// temperature/distance in the viewer's unit; a login-less caller (the Telegram
// digest, the calendar feed, AI insights) omits them and gets canonical units
// (°F / km — the documented notification stance). Display only: item KEYS and
// dedupe identities never depend on these.
export interface UpcomingDisplayUnits {
  temperatureUnit: TemperatureUnit;
  distanceUnit: DistanceUnit;
}

export const CANONICAL_DISPLAY_UNITS: UpcomingDisplayUnits = {
  temperatureUnit: "F",
  distanceUnit: "km",
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
  // Structured, first-class reasons (issue #656) — the "why" the deciding engine
  // knows, carried as DATA ALONGSIDE `detail` (which stays the flattened display
  // string for back-compat). A compact surface (the Telegram digest) renders the
  // top reason; the page/hero render the full `detail`. Ordered most-explanatory-
  // first (the cited risk line leads), so primaryReason() picks the right lead.
  // Empty/absent for the many items with no structured reason.
  reasons?: Reason[];
  href: AppRoute;
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
  // Optional primary navigation CTA for status-driven items whose next step is
  // clearer than a generic title link (for example Reconnect / Review result).
  // This is presentation data carried on the shared model so Dashboard and
  // Upcoming never have to infer different actions from the same domain.
  actionLabel?: string;
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
  bookHref?: AppRoute;
  // Preventive items only (issue #85): true when a FUTURE matching-kind appointment
  // is already booked, so the row renders a quiet "Scheduled" state (links to the
  // appointment) instead of nagging.
  scheduled?: boolean;
  // When set, the row renders an inline "Mark done" form that marks this
  // care_plan_items row completed (issue #84) — the same inline fast-path shape as
  // doseId/preventiveRuleKey. Only careplan items carry one.
  carePlanItemId?: number;
  // When set, the row renders an inline "Add to conditions" confirm for a suggested
  // problem-list condition (issue #685 — suggest-only, the user confirms). Only
  // condition-review items carry one; the confirm creates the Condition idempotently.
  conditionSuggestion?: { name: string; code: string | null };
  // Whether this item supports snooze/dismiss through the shared findings store
  // (issue #524). Date-scheduled due-signals and biomarker flags do (undefined is
  // treated as suppressible); the structural signals (review / failing integration)
  // are resolved, not snoozed, so they set this false and render no snooze menu.
  suppressible?: boolean;
  // Care-tier persistence (issue #700 ask 5, #449): an OVERDUE safety follow-up
  // resists the "dismiss once, silence everywhere" convenience path the way a
  // medication-dose escalation does. When set, the shared suppression filter IGNORES
  // an indefinite dismiss for this item (see isItemHiddenBySuppression) but still
  // honors a live time-boxed snooze, and the surfaces render a snooze-only menu (no
  // dismiss). Absent for every ordinary item (fully suppressible).
  carePersistent?: boolean;
  // Explicit suppression policy override (issue #716). When set, it wins over the
  // carePersistent-derived default in isItemHiddenBySuppression — the ONE lifecycle
  // decision (#942). "safety-ungated" makes an item structurally NON-DISMISSIBLE and
  // NON-SNOOZABLE (the crisis finding, same standing as a safety dose reminder): the
  // bus can never hide it. Absent for every ordinary item (policy derived from
  // carePersistent). An item using this also sets `suppressible: false` so no
  // snooze/dismiss control renders.
  suppressionPolicy?: LifecycleSuppressionPolicy;
  // Finding follow-up resolution offer (issue #700 ask 3): when a matching later
  // record has landed, the row renders inline "mark resolved / stable / changed"
  // controls (confirm-first, #560) that record the outcome against the resolving
  // record. Only followup items in the resolvable state carry one; ids only.
  followUpResolve?: { carePlanItemId: number; resolvingRecordId: number };
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
