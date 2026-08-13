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
// rather than disabled: a restricted profile has no training entry at all, so it
// gets a three-segment track, not a fourth segment that refuses.

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
  food: "Food",
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
  "log-food": "food",
  // The measurements form is weight + vitals + a minor's growth fields (#1486),
  // and the period offer is the other thing the body itself reports — both are
  // "something my body did", not something I took or practised.
  "log-measurements": "body",
  "log-period": "body",
  // Care is what you ADMINISTER to yourself and what you FILE about it: a dose,
  // a tracked practice, a check-in, a document. Doses lead it because they are
  // the segment's daily verb.
  "log-dose": "care",
  "log-practice": "care",
  "log-mood": "care",
  "add-document": "care",
} as const satisfies Record<QuickLogId, LogSegmentId>;

/**
 * The sheet's segments for a given profile: the SAME `quickLogMenu` the flat
 * sheet has always rendered (so both gates — the age gate and the #1042 cycle
 * relevance bit — apply exactly once, where they always did), regrouped.
 *
 * Segments with no surviving entry are dropped entirely.
 */
export function logSheetSegments(
  restricted: boolean,
  cycleRelevant = true
): LogSegment[] {
  const items = quickLogMenu(restricted, cycleRelevant);
  return SEGMENT_ORDER.map((id) => ({
    id,
    label: SEGMENT_LABELS[id],
    items: items.filter((item) => LOG_SEGMENT_CENSUS[item.id] === id),
  })).filter((segment) => segment.items.length > 0);
}

/**
 * Which segment the track opens on: the one holding the CURRENT ROUTE's promoted
 * log (`primaryQuickLog`, the same rule the top bar's contextual **+** obeys), so
 * opening the puck on Nutrition lands on Food. Falls back to the first surviving
 * segment when that item is gated away for this profile — never to an empty or
 * absent one.
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
  "log-food": ["food_log"],
  // A vitals sitting is `medical_records` rows by placement (#2032), so Body would
  // under-count a blood-pressure logger without that third store.
  "log-measurements": ["body_metrics", "metric_samples", "medical_records"],
  "log-period": ["cycles"],
  "log-dose": ["intake_item_logs"],
  "log-practice": ["practice_logs"],
  "log-mood": ["mood_logs"],
  // A document row is dated by the DOCUMENT — the day the lab drew the blood,
  // often months before anyone filed it — so its date says nothing about when its
  // owner logs, and the day the filing actually happened exists only as the
  // `uploaded_at` UTC instant, which would have to be folded into a profile-local
  // day to be counted honestly (docs/internals/time-model.md). Filing is occasional
  // by nature too. Care is measured by its three daily verbs instead.
  "add-document": arguedExclusion(
    "A document row is dated by the DOCUMENT rather than by the day it was filed, so its date is not evidence about when its owner logs; the filing day itself exists only as a UTC instant. Doses, practices and mood are the Care segment's daily verbs and carry its evidence."
  ),
} as const satisfies Record<QuickLogId, readonly string[] | ArguedExclusion>;

/**
 * The segment this profile logs in on the most DAYS, or null when no segment
 * clears the evidence floor.
 *
 * Only segments actually on this profile's track can win — a restricted profile
 * has no `train` segment, so activity history predating the gate cannot name a
 * segment the sheet does not render. Exact ties go to track order, which is
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
 * promotes its own domain — `/nutrition` → Food, unchanged — or is a long-tail
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
