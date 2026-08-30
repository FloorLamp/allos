// The log sheet's "Everything else" grammar (issue #2651) — pure.
//
// The puck opens ONE sheet with two sections. The first is the due-and-usual
// context row (offers, built from reads the app already makes). The second is
// this: the whole quick-log menu, grouped into a one-line segmented domain
// selector so the long tail has large tap targets instead of a scrolling list of
// eight equal rows.
//
// ── IT ADDS NO ENTRIES AND NO WRITE PATHS ────────────────────────────────────
//
// `QUICK_LOG_ITEMS` (lib/quick-log.ts) is still the only membership list, still
// the only thing that knows which row opens which form, and still the only place
// a new loggable domain is argued in or out. This module is a VIEW over it: a
// census assigning each existing id to a segment, and the two pure functions the
// sheet needs to render that view. A new `QuickLogId` fails `tsc` here until
// someone decides where it belongs — the same declare-or-argue shape as
// QUICK_LOG_DOMAIN_CENSUS, for the same reason (#2130).
//
// ── WHY THE SEGMENTS ARE THESE FOUR ──────────────────────────────────────────
//
// They are the four things a phone is actually held up to do, and each has at
// least one entry for every profile that can see it. Empty segments are dropped
// rather than disabled.

import { arguedExclusion, type ArguedExclusion } from "./loggable-domains";
import {
  quickLogMenu,
  primaryQuickLog,
  type QuickLogId,
  type QuickLogItem,
} from "./quick-log";

export type LogSegmentId = "train" | "food" | "body" | "care";

export interface LogSegment {
  id: LogSegmentId;
  label: string;
  items: QuickLogItem[];
}

// Track order, left to right.
const SEGMENT_ORDER: readonly LogSegmentId[] = [
  "train",
  "food",
  "body",
  "care",
];

const SEGMENT_LABELS: Record<LogSegmentId, string> = {
  train: "Train",
  food: "Consume",
  body: "Body",
  care: "Care",
};

/**
 * Every quick-log entry's segment. Const-asserted against the id union, so
 * retiring an id or adding one is a compile error here rather than a row that
 * silently stops rendering.
 */
export const LOG_SEGMENT_CENSUS = {
  "log-activity": "train",
  "live-workout": "train",
  // Consume is what you take into your body: food, a dose, or a substance. The
  // id stays `food` so stored habit-day keys and callers do not need a migration;
  // the reader-facing label carries the broader owner-ruled category (#3675).
  "log-food": "food",
  "log-dose": "food",
  "log-substance": "food",
  // The measurements form is weight + vitals + a minor's growth fields (#1486),
  // and the period offer is the other thing the body itself reports — both are
  // "something my body did", not something I took or practised.
  "log-measurements": "body",
  "log-period": "body",
  // The third thing the body itself reports (#2785), beside the measurements
  // sitting and the period offer.
  "log-stool": "body",
  // Care is what you practise, check in about, or file: a tracked practice, a
  // mood check-in, or a document. Things taken into the body live in Consume.
  "log-practice": "care",
  "log-mood": "care",
  // #4064: how you FEEL is the other thing you check in about, so the symptom row
  // sits beside the mood row rather than under Body — Body is what the body reports
  // as a measurement, and a symptom is a report about the person.
  "log-symptom": "care",
  "add-document": "care",
} as const satisfies Record<QuickLogId, LogSegmentId>;

/**
 * The sheet's segments for a given profile: the SAME `quickLogMenu` the flat
 * sheet has always rendered (so the #1042 cycle relevance bit applies exactly
 * once, where it always did), regrouped.
 *
 * Segments with no surviving entry are dropped entirely.
 */
export function logSheetSegments(
  cycleRelevant = true,
  substanceRelevant = false
): LogSegment[] {
  const items = quickLogMenu(cycleRelevant, substanceRelevant);
  return SEGMENT_ORDER.map((id) => ({
    id,
    label: SEGMENT_LABELS[id],
    items: items.filter((item) => LOG_SEGMENT_CENSUS[item.id] === id),
  })).filter((segment) => segment.items.length > 0);
}

/**
 * The list reserve for the segments a profile can ACTUALLY see. QuickLogSheet
 * applies its training gate before calling this, so a one-segment profile never
 * holds empty rows for entries it cannot reach (#3675).
 */
export function maxLogSheetRows(
  segments: readonly Pick<LogSegment, "items">[]
): number {
  return segments.reduce(
    (maximum, segment) => Math.max(maximum, segment.items.length),
    0
  );
}

// ── ONE RESERVE, AT THE PANEL (issue #3736) ──────────────────────────────────
//
// #3675 stopped the sheet resizing under the reader, and #3718 shipped that as
// TWO worst-case reserves: a 208px context slot whose bottom rule was pinned to
// the bottom of it, and a list drawn at the TALLEST segment's height on every
// segment. Train has two entries where Consume has three, so Train drew two rows
// inside a three-row box under a chip-row of emptiness above a horizontal rule.
// Slack bounded below by a rule or a control reads as a rendering fault; slack
// that simply collects after the last row reads as padding.
//
// So the PANEL's height is what is held constant. Every region sizes to its own
// content, and ONE spacer, last in the panel, takes the whole difference — which
// is also why the arithmetic lives here, in the pure module, rather than as three
// literals inside the renderer.

/**
 * A row measures 62px — 36px icon + 24px vertical padding + the 1px border on
 * each side — followed by the list's 4px gap. The list's `pb-1` spends that final
 * gap after the last row, so N × 66px is the exact rendered list block rather
 * than an approximate minimum (#3675).
 *
 * MEASURED, not derived: 1/2/3 rows render 66/132/198px at 390px (2026-08-28).
 * #3718's 64 omitted the border and under-reserved every list by 2px a row.
 */
export const LOG_SHEET_ROW_BLOCK_PX = 66;

/**
 * The context region at its tallest, at 390px. Two offers is the most it can ever
 * hold — a non-empty `dueDoses.items` and the `resume` arm of `workoutOffer` — and the
 * common case is one with no routine control, which is exactly why this number may
 * no longer be spent as a fixed height on the region itself.
 *
 * EVERY TERM WAS MEASURED IN THE RENDERED SHEET at 390px (2026-08-28), and the
 * `log-sheet-reserve` e2e persona renders all of them at once so the SUM is measured
 * too, not only its parts.
 *
 * AN OFFER ROW BY LABEL LINES, measured: 62 / 66 / 86 for one, two and three. The
 * first wrapped line is nearly free because the 36px icon is still the tallest thing
 * in the row — an offer carries no hint under its label, unlike the long-tail entries
 * below — and every line after it costs a full 20px.
 *
 * WHICH IS WHY THE LABEL IS CLAMPED TO TWO LINES rather than this number being made
 * generous. `dueDoseChipLabel` prints `Due: <two item names> +N` from names the
 * profile chose; unbounded, two portal-imported names reach three lines and overrun
 * by 16px, and the panel would answer by growing AFTER the gather resolves — the
 * resize #3675 exists to stop. No larger number fixes that, because a fourth line is
 * always reachable. `SHEET_ROW_CLASS`'s label carries `line-clamp-2`, so 66 is the
 * row's MAXIMUM and this bound holds by construction instead of by luck.
 */
export const LOG_SHEET_CONTEXT_RESERVE_PX =
  16 + // the "Due & usual now" heading
  8 + // its `mb-2`
  54 + // UsualRoutineControl, absent unless the window has a usual set
  12 + // its `mb-3`
  2 * 66 + // the two offer rows at their TWO-LINE height (62 with a one-line label)
  4 + // the ONE `gap-1` between those two rows
  12 + // the section's `pb-3`
  1 + // its rule
  16; // its `mb-4`

/** The segmented track: a 44px target inside the control's `p-1`, plus `mb-3`. */
export const LOG_SHEET_TRACK_BLOCK_PX = 64;

/**
 * The height the sheet's panel holds whatever it is showing — the floor the
 * trailing spacer fills out to. A one-segment profile has no track to reserve
 * for, and holds no rows it cannot reach (`maxLogSheetRows`).
 */
export function logSheetReservePx(
  segments: readonly Pick<LogSegment, "items">[]
): number {
  return (
    LOG_SHEET_CONTEXT_RESERVE_PX +
    (segments.length > 1 ? LOG_SHEET_TRACK_BLOCK_PX : 0) +
    maxLogSheetRows(segments) * LOG_SHEET_ROW_BLOCK_PX
  );
}

/**
 * Which segment the track opens on: the one holding the CURRENT ROUTE's promoted
 * log (`primaryQuickLog`), so opening the puck on Nutrition lands on Consume. Falls
 * back to the first surviving segment when that item is gated away for this
 * profile — never to an empty or absent one.
 */
export function defaultLogSegment(
  segments: readonly LogSegment[],
  pathname: string,
  tab?: string | null
): LogSegmentId {
  const wanted = LOG_SEGMENT_CENSUS[primaryQuickLog(pathname, tab).id];
  return segments.some((s) => s.id === wanted)
    ? wanted
    : (segments[0]?.id ?? "care");
}

// ── THE DASHBOARD'S OPENING SEGMENT (issue #2709) ────────────────────────────
//
// THE DEFECT. `primaryQuickLog` has an opinion about three routes and falls
// through to "Log activity" everywhere else — including `/`. So the dashboard,
// the surface people are on most, opened the sheet on Train, and logging food
// from home cost two taps where every domain page costs one.
//
// THE RULING (owner, 2026-08-13). The sheet defaults to the profile's MOST-LOGGED
// domain, not a fixed promotion of food for `/`. The owner overruled the
// recommendation to hard-code food and recorded the cost being accepted:
// predictability. The same tap now does different things for different people.
//
// WHAT THAT COST BUYS THE IMPLEMENTATION, AND IT IS THE WHOLE DESIGN. Because
// predictability is what is being spent, the measure has to be one that BARELY
// MOVES. Three choices do that, and each is a decision rather than a default:
//
//   1. The window is a QUARTER (90 days), not a week. Tracking recent history
//      closely is exactly what the ruling warns against: a default that flips
//      because yesterday had one more food log than activity logs is the failure
//      mode being traded for.
//   2. The measure counts DAYS THE DOMAIN WAS LOGGED AT ALL, never rows. Six food
//      taps in one evening are one day's evidence, the same as one. That is what
//      makes a burst — a party, a lab panel, a week of physio — structurally
//      unable to move the answer, and it caps a segment's whole day-to-day
//      movement at ±1.
//   3. The floor. Under `LOG_HABIT_MIN_DAYS` logged days the leader is not
//      evidence of a habit, so the answer is not adapted at all and the route's
//      own default stands. That is also the ruling's required fallback for a
//      profile with no logging history: it gets exactly today's behaviour.
//
// HOW OFTEN THE OPENING SEGMENT CAN THEREFORE CHANGE. A calendar day adds at most
// one day to a segment's count and drops at most one off the far end of the
// window, so a segment leading by TWO OR MORE logged days cannot be overtaken by
// anything that happens in a day. A change requires the top two segments to sit
// within one logged day of each other across a whole quarter — that is, the
// profile logs two domains equally often — and even then it is at worst one flip
// per day between two segments used interchangeably. In steady use the segment is
// fixed for months.
//
// WHAT IT IS NOT. Not a finding, not a nudge, not a claim about the person: it
// decides which of four equally-reachable segments is pre-selected. Every other
// segment stays one tap away exactly as before (#2419 — dueness gates nudging,
// never logging, and this is not even dueness). Nothing is stored, nothing is
// sent, and no row is written by any of it.

/** The trailing window the "most-logged" measure reads. A quarter — see above. */
export const LOG_HABIT_WINDOW_DAYS = 90;

/**
 * How many logged DAYS the leader needs before history is allowed to decide.
 * Seven — one whole week of evidence inside a 90-day window. Below it the route's
 * own default stands, which is both the ruling's required no-history fallback and
 * the honest answer for a profile that has barely logged: there is no habit yet.
 */
export const LOG_HABIT_MIN_DAYS = 7;

/**
 * Per-segment logged-day counts over the trailing `LOG_HABIT_WINDOW_DAYS`. A
 * missing key means zero. Gathered by `lib/queries/log-sheet.ts`.
 */
export type SegmentLogDays = Readonly<Partial<Record<LogSegmentId, number>>>;

/**
 * Which STORES a quick-log entry's taps land in — the measure's coverage, declared
 * where it can be read without a database, and const-asserted over `QuickLogId` in
 * the same declare-or-argue shape as `LOG_SEGMENT_CENSUS` (#2130). A new entry is a
 * `tsc` error here until somebody says where its taps land or argues that they are
 * not evidence about logging habit.
 *
 * `lib/queries/log-sheet.ts` counts them, and
 * `lib/__tests__/log-sheet-sources.test.ts` holds the two together in both
 * directions: a declared store the statement does not count, and a counted store
 * nobody declared, each fail rather than quietly skewing the measure.
 *
 * Only stores whose rows are HAND-ENTERED count; the statement carries the
 * per-store filter and the argument for it.
 */
export const LOG_DAY_SOURCES = {
  "log-activity": ["activities"],
  // A completed live session lands in the same canonical activity store. This
  // is a second door to the same evidence, not a second source.
  "live-workout": ["activities"],
  "log-food": ["food_daily_totals"],
  // A vitals sitting is `medical_records` rows by placement (#2032), so Body would
  // under-count a blood-pressure logger without that third store.
  "log-measurements": ["body_metrics", "metric_samples", "medical_records"],
  "log-period": ["cycles"],
  // A Bristol tap is one hand-entered metric_samples row (#2785).
  "log-stool": ["metric_samples"],
  "log-dose": ["intake_item_logs"],
  "log-practice": ["practice_logs"],
  // Every `symptom_logs` row is hand-entered — the store has no source column because
  // it has no ingest path — so the arm needs no manual filter, like `food_daily_totals`
  // and `cycles` (#4064).
  "log-symptom": ["symptom_logs"],
  // A substance tap is one hand-entered `substance_daily_totals` row (#3327), counted
  // on `source = 'manual'` — NOT NULL with a 'manual' default, the metric_samples
  // spelling, so there is no null half to admit.
  //
  // ALCOHOL IS DELIBERATELY NOT DECLARED HERE. Its taps land on `food_daily_totals`
  // (#860/#944 — a standard drink IS one serving of the curated alcohol group), which
  // `log-food` already declares and the statement already counts for Consume. This
  // entry declares only the dedicated substance writer; naming the food store again
  // would give one store two owners in a census whose keys are quick-log entries.
  "log-substance": ["substance_daily_totals"],
  // The daily check-in's store is STORE-PRIVATE by the #992 contract: nothing
  // outside its own read/write/registry modules may name the table, because a
  // subjective self-rating must never feed a flag, a retest clock, a streak or
  // any other engine. Counting how often somebody checks in — even only to pick
  // which tab of a menu opens first — is a computation ABOUT mood by a module
  // that is none of the four, so it is refused here rather than argued into that
  // guard's allowlist. Practices carry the Care segment's evidence, and the cost
  // is stated: a profile whose only care logging is check-ins is
  // under-counted, and its dashboard keeps the route default.
  "log-mood": arguedExclusion(
    "The daily check-in's store is store-private under the #992 sensitivity contract — a subjective self-rating feeds no engine — and counting check-ins to order a menu would be exactly such an engine. Practices carry the Care segment's evidence instead."
  ),
  // A document row is dated by the DOCUMENT — the day the lab drew the blood,
  // often months before anyone filed it — so its date says nothing about when its
  // owner logs, and the day the filing actually happened exists only as the
  // `uploaded_at` UTC instant, which would have to be folded into a profile-local
  // day to be counted honestly (docs/internals/time-model.md). Filing is occasional
  // by nature too. Care is measured by its practice verb instead.
  "add-document": arguedExclusion(
    "A document row is dated by the DOCUMENT rather than by the day it was filed, so its date is not evidence about when its owner logs; the filing day itself exists only as a UTC instant. Practices carry the Care segment's logging evidence."
  ),
} as const satisfies Record<QuickLogId, readonly string[] | ArguedExclusion>;

/**
 * The dose context chip names the first two due items, then gives a compact
 * overflow count. Item ids define that collection, so two arrived dose slots for
 * one item consume one name and one count unit.
 */
export function dueDoseChipLabel({
  items,
}: {
  items: readonly { itemId: number; name: string }[];
}): string | null {
  const distinct = [
    ...new Map(items.map((item) => [item.itemId, item])).values(),
  ];
  const count = distinct.length;
  if (count <= 0) return null;
  const usable = distinct
    .map((item) => item.name.trim())
    .filter(Boolean)
    .slice(0, 2);
  if (usable.length === 0)
    return count === 1 ? "1 item due" : `${count} items due`;
  const overflow = Math.max(0, count - usable.length);
  return `Due: ${usable.join(", ")}${overflow > 0 ? ` +${overflow}` : ""}`;
}

/**
 * The segment this profile logs in on the most DAYS, or null when no segment
 * clears the evidence floor.
 *
 * Only segments actually on this profile's track can win. Exact ties go to track order, which is
 * deterministic and needs no second opinion about what "most" means.
 */
export function habitualLogSegment(
  segments: readonly LogSegment[],
  days: SegmentLogDays
): LogSegmentId | null {
  let best: LogSegmentId | null = null;
  let bestDays = 0;
  // SEGMENT_ORDER, not `segments`, so the tie-break is the track's declared order
  // however the caller assembled its list.
  for (const id of SEGMENT_ORDER) {
    if (!segments.some((s) => s.id === id)) continue;
    const count = days[id] ?? 0;
    if (count > bestDays) {
      best = id;
      bestDays = count;
    }
  }
  return bestDays >= LOG_HABIT_MIN_DAYS ? best : null;
}

/**
 * The route on which logging history decides the opening segment: the dashboard,
 * and only the dashboard (the ruling's stated scope). Every other route either
 * promotes its own domain — `/nutrition` → Consume, unchanged — or is a long-tail
 * surface whose sheet keeps the historical activity fallback.
 */
export const HABIT_DEFAULT_ROUTE = "/";

/**
 * The segment the sheet opens on, all inputs considered. The ONE composition
 * point: `defaultLogSegment` still owns the route rule and is still the answer
 * everywhere the profile's history is absent, thin, or not consulted.
 */
export function openingLogSegment(opts: {
  segments: readonly LogSegment[];
  pathname: string;
  tab?: string | null;
  /** Null where the surface does not consult history, or it was not gathered. */
  habitDays?: SegmentLogDays | null;
}): LogSegmentId {
  const { segments, pathname, tab, habitDays } = opts;
  if (pathname === HABIT_DEFAULT_ROUTE && habitDays) {
    const habitual = habitualLogSegment(segments, habitDays);
    if (habitual) return habitual;
  }
  return defaultLogSegment(segments, pathname, tab);
}
