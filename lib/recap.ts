// THE recap engine (issues #32 / #2178) — a PURE, rule-based summary of the last
// PERIOD: workouts, personal records, supplement adherence, a robust body-weight
// trend, aerobic base, and sleep regularity. No DB, no network, no AI — so it runs in
// the dashboard widget, the recap notification, and the unit tests alike, and works
// with zero AI configuration. The DB gather lives in
// lib/notifications/recap-data.ts (mirroring the digest's data/render
// split); this module turns the gathered facts into a line model and renders the
// notification message.
//
// ONE ENGINE, SCALE AS A DECLARED AXIS (#2178). A weekly, a monthly and a quarterly
// recap are the SAME question over a longer window, so they are one computation. The
// scale is data — a row in lib/recap-scale.ts naming its period arithmetic, its send
// marker, its narrative kind and its nouns — and every LINE below declares which
// scales it speaks at (RECAP_LINE_MODEL). `buildRecap` never branches on the scale; it
// resolves the declared period and emits the lines whose declared scale set contains
// it. A fourth length would be a row and a column, not a code path.
//
// COVERAGE RULE (#1935, owner-decided) — the recap's comparative advantage over the
// daily digest is showing what you CANNOT see day to day, so that is the inclusion
// test: does this fact only become visible at week scale? Three lines failed it and
// were cut. Training VOLUME is a session fact aggregated, noisy against exercise
// selection and rep ranges, and its percentage was "fewer sessions" restated with
// false precision one line below the workout count that already said so. ESTIMATED
// CALORIES failed harder — a low-confidence derived number compared against another
// estimate compounds the error. And the STREAK line measured app engagement rather
// than health, with a cliff where a rate degrades gracefully, punishing exactly
// what this app is built to accommodate: deload weeks, rest-day recommendations,
// illness pauses. Machinery on one side saying "rest today" and a counter on the
// other saying "you broke your run." Consistency is still reported — as the rates
// that survive (adherence %, workouts + composition), which a missed day nudges
// instead of zeroing. "A summary, never a score to beat" is the whole recap's
// contract, not just the mood line's.
//
// Week definition — the WEEKLY recap (7-day period) uses the profile's ONE
// definition of "this week" (lib/week-window.ts, honoring `week_mode`), so the
// recap card/notification count the same days as the routine counters and the
// training log week summary (issue #223). A rolling-mode profile still gets a trailing
// seven days ending on "today" (unchanged); a calendar-mode profile gets the
// current calendar week through today, with the prior full week as the comparison
// window. Months and quarters are ALWAYS calendar — `week_mode` defines only weeks,
// and no rolling-month convention is invented (lib/recap-scale.ts). The range label on
// both surfaces prints the concrete start–end dates, so the copy is honest in
// either mode.

import { daysBetweenDateStr, shiftDateStr, weekdayOfDateStr } from "./date";
import {
  recapPeriod,
  recapScaleEntry,
  type PeriodComparison,
  type RecapScale,
} from "./recap-scale";
import {
  formatMonthDay,
  DEFAULT_FORMAT_PREFS,
  type DisplayFormatPrefs,
} from "./format-date";
import { median, robustEndpoints } from "./robust-stats";
import { fmtWeight, kgTo } from "./units";
import { weekWindow } from "./week-window";
import { sriPresentation } from "./sleep-regularity";
import { formatHm } from "./sleep-summary";
import { NUTRIENT_LABELS, type NutrientKey } from "./nutrition-day";
import type { WeekMode, WeekStart, WeightUnit } from "./settings";
import type { NotificationMessage } from "./notifications/types";
import {
  formatEmphasizedLine,
  formatMessageLine,
  messageLineQualifiers,
  type MessageLine,
} from "./notifications/message-line";
import {
  bold,
  joinBody,
  richFrom,
  type MessageBody,
} from "./notifications/rich-text";
import { GLYPH } from "./notifications/glyphs";

// The seven-day window ending on `today` (inclusive) plus the preceding seven-day
// comparison window. All bounds are YYYY-MM-DD strings in the profile's timezone.
export interface RecapWindow {
  start: string; // today - 6
  end: string; // today
  prevStart: string; // today - 13
  prevEnd: string; // today - 7
}

// The window ending on `today` (inclusive) spanning `days` days, plus the
// immediately-preceding `days`-day comparison window. `days` defaults to 7 so
// every existing caller keeps the trailing-seven-day behavior unchanged; a
// monthly recap passes 30 (issue #20). The math is a plain day shift, so it's
// independent of week-start/timezone-week boundaries for any period length.
export function recapWindow(today: string, days = 7): RecapWindow {
  return {
    start: shiftDateStr(today, -(days - 1)),
    end: today,
    prevStart: shiftDateStr(today, -(2 * days - 1)),
    prevEnd: shiftDateStr(today, -days),
  };
}

// The window a recap covers. For the WEEKLY recap (days === 7) it honors the
// profile's `week_mode` via the shared `weekWindow` computation, so the recap's
// "this week" matches the routine counters and training log week summary (issue #223).
// For any other period length (e.g. the monthly recap, #20) `week_mode` doesn't
// apply, so it falls back to the trailing `recapWindow(today, days)`. `weekMode`
// defaults to "rolling" — which makes the 7-day window byte-for-byte identical to
// `recapWindow(today, 7)` — so callers that don't pass a mode keep the original
// trailing-seven behavior.
//
// `completed` (issue #1021) selects the NOTIFICATION's calendar-mode window: the
// last COMPLETED calendar week (the in-progress week's comparison slot) with the
// full week before it as the new comparison — so "week starts Monday, recap Monday
// 9am" summarizes the week that just ended instead of a nine-hour "week", and every
// send-day choice yields a full 7-day subject compared against another full week.
// The dashboard card keeps the DEFAULT in-progress window (it must keep matching
// the routine counters, #223), and rolling mode is untouched on both surfaces (a
// trailing seven days is always a full-length week). One window-selection
// parameter over the ONE shared computation — never a second recap engine (#221).
export function resolveRecapWindow(
  today: string,
  days = 7,
  weekMode: WeekMode = "rolling",
  weekStart: WeekStart = 0,
  completed = false
): RecapWindow {
  if (days !== 7) return recapWindow(today, days);
  const win = weekWindow(today, weekMode, weekStart);
  if (!completed || weekMode !== "calendar") return win;
  // Shift back one week: the in-progress week's comparison window (the last full
  // calendar week) becomes the subject, and the full week before it the comparison.
  return {
    start: win.prevStart,
    end: win.prevEnd,
    prevStart: shiftDateStr(win.prevStart, -7),
    prevEnd: shiftDateStr(win.prevStart, -1),
  };
}

// The week-window resolver in the shape lib/recap-scale.ts injects it — the ONE
// week computation, handed to the scale axis rather than duplicated inside it.
export function resolveWeekPeriod(
  today: string,
  weekMode: WeekMode,
  weekStart: WeekStart,
  completed: boolean
): RecapWindow {
  return resolveRecapWindow(today, 7, weekMode, weekStart, completed);
}

// The period a recap at `scale` covers, over the ONE week resolver above. Every
// caller — the gather, the builder, the tick's planner — goes through this, so the
// window a recap is BUILT from can never differ from the one it was GATHERED for.
export function periodFor(
  scale: RecapScale,
  today: string,
  weekMode: WeekMode = "rolling",
  weekStart: WeekStart = 0,
  completed = false
): PeriodComparison {
  return recapPeriod(scale, today, {
    weekMode,
    weekStart,
    completed,
    resolveWeek: resolveWeekPeriod,
  });
}

// Whether `date` (YYYY-MM-DD) falls within [start, end] inclusive — plain string
// compare, valid for zero-padded ISO dates.
export function inWindow(date: string, start: string, end: string): boolean {
  return date >= start && date <= end;
}

// The recap's BREAKDOWN vocabulary — deliberately NOT the full ActivityType set.
// `recovery` and `unclassified` (#2272) are excluded on purpose: this names the three
// buckets the "4 workouts (strength 2, cardio 1)" line speaks, not what a row is.
export type WorkoutType = "strength" | "cardio" | "sport";

export interface RecapWorkout {
  date: string;
  // NULL when the session has no breakdown bucket — an `unclassified` import, whose
  // source declined to say what it was (#2272). It still COUNTS as a workout (it
  // happened), it just contributes no bucket; calling it strength would re-assert the
  // very claim the type exists to withhold.
  type: WorkoutType | null;
}

export interface RecapWeight {
  date: string;
  weightKg: number;
}

// How one nutrient's DAYS landed over the window (#2396). The denominator is the days
// the nutrient could be POSITIONED at all — a day with no quantified intake, or a
// profile with no resolvable target, produces no position (lib/nutrition-day.ts), and
// counting such a day as a miss would assert something about eating that was never
// observed. `onTarget` counts the positioned days that did NOT finish below target.
export interface RecapNutrientDays {
  nutrient: NutrientKey;
  onTarget: number;
  days: number;
}

// The window's food coverage and shape — never a serving total (#2396/#2178).
export interface RecapFood {
  /** Distinct days inside the window with any food logged. */
  daysLogged: number;
  /** Distinct food GROUPS logged inside the window — the week's variety. */
  groups: number;
  /** Protein and fibre days on target, in declared order. Empty when nothing positioned. */
  nutrients: readonly RecapNutrientDays[];
}

// One day's dose ledger inside the window — the raw material of the month/quarter
// adherence PATTERN line. `due` excludes nothing; `skipped` is the deliberate-skip
// count (#232) the percentage denominator drops, exactly as at week scale.
export interface RecapAdherenceDay {
  date: string;
  due: number;
  taken: number;
  skipped: number;
}

// The gathered facts the recap summarizes. Everything is already scoped to the
// profile and, where noted, pre-filtered to the trailing window by the gather.
export interface RecapInput {
  today: string;
  weightUnit: WeightUnit;
  // WHICH SCALE this recap speaks at (#2178). Omitted ⇒ "week", so every pre-#2178
  // caller is unchanged. Drives the period arithmetic, the "last week"/"last month"
  // comparison wording, and — through RECAP_LINE_MODEL — which lines are emitted at
  // all. It is DECLARED, never inferred from a day count.
  scale?: RecapScale;
  // The profile's week definition, applied to the 7-day weekly recap so its
  // window matches the routine counters / training log (issue #223). Omitted ⇒
  // "rolling" (trailing seven days), preserving the pre-#223 behavior; ignored for
  // non-weekly periods (weekMode only defines a week).
  weekMode?: WeekMode;
  weekStart?: WeekStart;
  // Completed-period selection (issue #1021, generalized by #2178): true on the
  // NOTIFICATION path, where the recap narrates the last CLOSED period rather than the
  // in-progress one. Omitted/false ⇒ the dashboard's in-progress window. At week scale
  // it is a no-op in rolling mode (a trailing seven days is always a full week).
  // Carried on the input so buildRecap resolves the SAME period the gather filtered by.
  completed?: boolean;
  // Workouts (one per activity) in the current and previous periods.
  workouts: RecapWorkout[];
  prevWorkouts: RecapWorkout[];
  // Personal records (strength + cardio) dated within the current window; labels
  // are short display names ("Bench press", "Running") for the summary line.
  prLabels: string[];
  // IntakeItem/medication adherence over the window, or null when nothing was
  // due. `skipped` counts deliberate skips (#232), excluded from the percentage.
  adherence: { taken: number; skipped: number; due: number } | null;
  // One row per day of the window that had a due dose (#2178). The WEEK's line is a
  // percentage; a month's percentage hides everything worth knowing, so month and
  // quarter scale read the SHAPE out of these rows instead — the weekday/weekend split
  // and whether the second half of the period ran ahead of or behind the first.
  // Gathered by the SAME per-day loop that produces `adherence`, so the two can never
  // disagree. Omitted/empty ⇒ the pattern line is omitted.
  adherenceDays?: RecapAdherenceDay[];
  // The state-change HEADLINE for the pushed tier (#1505 part 3) —
  // "Missed: Magnesium (3 days) · Resumed: Vitamin D (2 days)" — preformatted by the
  // ONE shared `intakeDeltaLine` the morning digest and the household card also
  // render. Null/absent on a quiet window, which is the signal to omit the row: a
  // percentage always has a value, a change line exists only when something moved.
  intakeDeltaLine?: string | null;
  // Body weights logged within the window, oldest-first (already sorted by the
  // gather). Used for a robust (median-endpoint) net-change trend.
  weights: RecapWeight[];
  // Body weights logged within the PREVIOUS window, oldest-first — the week-over-week
  // comparison the weight line was missing (#1935). Its last reading is the same
  // figure the line's value shows, one window back, so the comparison is the plain
  // "prior" idiom the workouts line uses and not a fourth invented statistic.
  // Optional: an absent/empty list simply yields no comparison.
  prevWeights?: RecapWeight[];
  // Goals ACHIEVED inside the window (#2394), titles only. Keyed on the goal's recorded
  // achievement instant — `goals.achieved_at`, migration 182 — never on `target_date`,
  // which says when the goal was DUE: keying on the deadline announced a goal reached
  // early a month after the fact, never announced one reached late, and could not
  // announce a deadline-free goal at all. A goal with no recorded achievement instant
  // (achieved before the column existed) is absent here rather than announced late.
  goalsCompleted: string[];
  // Goals whose TARGET DATE passed inside the window without being achieved (#2394),
  // titles only. Reported once, factually, in the period the deadline fell in — no
  // streak, no cumulative miss count, no repetition later. Archived goals are excluded
  // by the gather (filing a goal away is how a user retires the question). This is the
  // one line where `target_date` is the right key: a miss is BY DEFINITION about a
  // deadline. Omitted/empty ⇒ no line.
  goalsMissed?: string[];
  // The window's FOOD coverage and shape (#2396) — the profile's most-logged domain had
  // no line at all. Deliberately NOT a re-total of daily servings: "you ate 53 servings"
  // is the false-authority sum #2178 forbids. Days logged and group variety are WEEK
  // facts that do not exist at day scale, and the nutrient rows report how many of the
  // days that could be positioned landed on target. Null/absent (or zero days) ⇒ the
  // line is omitted.
  food?: RecapFood | null;
  // Per-night MAIN sleep minutes inside the window and the previous one (#2396). The
  // recap reported sleep CONSISTENCY (the SRI) and never how much was actually slept —
  // and a perfectly regular five hours a night scores well. The line states the week's
  // TYPICAL night (a median, never a total) and how it moved. Below
  // RECAP_SLEEP_MIN_NIGHTS the line is omitted: one or two nights is a digest fact
  // (#1117), not a week's pattern.
  sleepMinutes?: readonly number[];
  prevSleepMinutes?: readonly number[];
  // Distinct days within the window that fell inside a flagged-illness episode
  // (issue #837). When > 0 the recap names the episode context ("sick N days")
  // instead of reading like a failed training week — the same honesty the adherence
  // system already applies (a sick day is excused). Omitted/0 ⇒ no recovery line.
  illnessDays?: number;
  // Zone 2 (aerobic-base) training minutes over the window, from HR zones (#159),
  // with the weekly target for context. Both optional/null when no HR zone model
  // exists — the line is omitted then. minutes>0 is required for the line to show.
  zone2Min?: number | null;
  zone2Target?: number | null;
  // Sleep Regularity Index (#160), −100..100, over the trailing 28-night window,
  // with the weekend-vs-weekday mid-sleep shift for context. Null when there isn't
  // enough sleep data (below the minimum-nights gate) — the line is omitted then.
  sri?: number | null;
  socialJetlagMin?: number | null;
  // Mood check-in summary (#992): mean valence + days logged over the window.
  // Null/omitted when the profile hasn't OPTED IN to the recap mood line
  // (mood_recap_enabled — off by default) or logged nothing — the line is omitted
  // then. A gentle summary only, never a score-to-beat (the no-gamification
  // contract), which is why it deliberately carries no previous-window comparison.
  mood?: { avgValence: number; daysLogged: number } | null;
  // A fitness check COMPLETED within the window (#1307) — the same battery-completion
  // event the check page's finale summarizes, surfaced once as a recap line so the
  // dashboard card and the Telegram recap say it identically (#221). Null/omitted when no
  // check completed in the window. `fitnessAge`/`priorFitnessAge` come straight off the
  // completed check's model; a null fitness age still yields the "completed" line (VO2
  // wasn't part of the check) without the age clause.
  fitnessCheck?: {
    fitnessAge: number | null;
    priorFitnessAge: number | null;
  } | null;
}

// Every line key the recap can emit. A closed union so a new line cannot be added
// without also declaring how (or whether) it compares — see RECAP_COMPARISON_KINDS.
export type RecapLineKey =
  | "recovery"
  | "workouts"
  | "training-mix"
  | "prs"
  | "intake-deltas"
  | "adherence"
  | "adherence-pattern"
  | "food"
  | "weight"
  | "weight-trajectory"
  | "zone2"
  | "sleep-duration"
  | "sleepRegularity"
  | "mood"
  | "goals"
  | "goals-missed"
  | "fitness-check";

// HOW a line compares itself to something (#1935). The old untyped `delta` slot was
// doing five unrelated jobs in eleven lines — a raw prior-window figure, a
// percentage, a second streak, a target ratio, a weekend shift — plus three silent
// omissions, and the reader had no way to know which idiom a given parenthetical
// was speaking. That is a missing type, not a copy problem. Now every line either
// compares ONE declared way or says explicitly that it does not, and adding a line
// forces its author to answer the question.
//
//   "prior"   — the SAME figure, one window back ("3 last week").
//   "percent" — change against the prior window as a percentage.
//   "target"  — measured against a declared target, not against the past.
//   "none"    — this line makes no comparison (and the data may be why).
export type RecapComparisonKind = "prior" | "percent" | "target" | "none";

export type RecapComparison =
  | { kind: "none" }
  | { kind: "prior"; text: string }
  | { kind: "percent"; text: string }
  | { kind: "target"; text: string };

const NO_COMPARISON: RecapComparison = { kind: "none" };

// The ONE comparison idiom each line is allowed to speak. A line may fall back to
// "none" when the data for its idiom is missing (no prior weigh-in, no Zone 2
// target), but it may never compare a SECOND way — that is the drift the untyped
// slot allowed. Pinned by lib/__tests__/recap.test.ts, so a new key is a
// type error here until its author declares one.
export const RECAP_COMPARISON_KINDS: Record<RecapLineKey, RecapComparisonKind> =
  {
    recovery: "none", // a fact about the window, not a trend
    workouts: "prior",
    "training-mix": "prior", // the same share, one period back
    prs: "none", // which lifts, not how many more than last week
    "intake-deltas": "none", // the shared line is ITSELF the week-over-week change
    adherence: "none", // a rate; its note carries the dose counts
    "adherence-pattern": "none", // a SHAPE; its note carries the drift, not a score
    // COVERAGE, and deliberately uncompared. Days-logged is the one figure on this line
    // that a period-over-period delta would turn into the STREAK line #1935 cut: a count
    // of how often the app was opened, with a cliff, on a surface whose contract is "a
    // summary, never a score to beat". The variety and the nutrient days are notes for
    // the same reason. What the week ate is reported; how it ranks is not.
    food: "none",
    weight: "prior",
    "weight-trajectory": "prior", // the same net change, one period back
    zone2: "target", // measured against the weekly target, never against last week
    "sleep-duration": "prior", // the same typical night, one period back
    sleepRegularity: "none", // its note carries the weekend shift, not a comparison
    mood: "none", // a summary, never a score to beat (#992/#716)
    goals: "none",
    "goals-missed": "none", // a passed deadline is a fact; there is nothing to compare it to
    "fitness-check": "none",
  };

// ── THE PER-LINE SCALE MODEL (#2178) ────────────────────────────────────────────
//
// #1935's owner-decided coverage rule was "does this fact only become visible at WEEK
// scale?". Generalized: a line appears at a scale only if its fact BECOMES VISIBLE at
// that scale. Two corollaries, both load-bearing:
//
//   • NO SCALE RE-TOTALS THE SMALLER PERIODS. "You did 47 workouts" is four weekly
//     lines summed and handed back with an authority none of them had. A longer scale
//     earns its place by speaking in SHAPES, RATES and DIRECTIONS — a composition
//     share, a per-week rate, a trajectory — never a bare cumulative count of the
//     events the shorter scale already counted.
//   • A LINE THAT MERELY STILL WORKS AT A LONGER SCALE IS NOT ADMITTED. A monthly
//     adherence percentage is computable and useless: it averages away the very
//     pattern (weekday vs weekend, first half vs second) that a month is the first
//     window able to show.
//
// Every key answers, with a reason. lib/__tests__/recap.test.ts pins totality, pins
// that every scale has at least one line, and pins the never-re-total rule by name.
export interface RecapLineScaleSpec {
  scales: readonly RecapScale[];
  why: string;
}

export const RECAP_LINE_MODEL: Record<RecapLineKey, RecapLineScaleSpec> = {
  recovery: {
    scales: ["week", "month", "quarter"],
    why: "Days inside a flagged illness episode, derived from the episodes themselves rather than summed from smaller reports (#837). It is CONTEXT for the numbers under it, and low numbers need that context at every length — a quarter with three weeks of illness in it reads as a failed quarter without it.",
  },
  workouts: {
    scales: ["week"],
    why: "A session COUNT is the week's own fact. At month scale the same line is the re-total the rule forbids — 'you did 18 workouts' is four weekly lines added up — so the month speaks composition and rate through `training-mix` instead.",
  },
  "training-mix": {
    scales: ["month", "quarter"],
    why: "A SHARE needs enough sessions to mean anything; one week of 'strength 67%' is three sessions and noise. Composition drift — the slow slide from lifting toward running, or the deload block that changed the balance — is exactly what a month makes visible and a week cannot. Reported as shares plus a per-week RATE, never a total.",
  },
  prs: {
    scales: ["week", "month"],
    why: "A personal record is a discrete event, not a total, so naming the lifts is news at either length. Withheld at quarter scale on purpose: thirteen weeks of records is a list, and a list is where a summary turns into a scoreboard.",
  },
  "intake-deltas": {
    scales: ["week"],
    why: "The shared #1505 line is ITSELF a state change over the last few days ('Missed: Glycine (2 days)'). Nesting it in a monthly recap would present a stale week-scale delta as a month's news.",
  },
  adherence: {
    scales: ["week"],
    why: "A percentage over seven days is a readable rate that one missed dose nudges rather than zeroes. Over a month it averages the shape away, which is the whole reason `adherence-pattern` exists.",
  },
  "adherence-pattern": {
    scales: ["month", "quarter"],
    why: "The weekday/weekend split and the first-half/second-half drift need several weeks of days before either is signal rather than coincidence. This is the #2178 inclusion test working in the constructive direction: not the weekly line at a longer length, a DIFFERENT fact the longer length is the first to show.",
  },
  food: {
    scales: ["week"],
    why: "Days logged and group variety are WEEK facts that do not exist at day scale, and they were the profile's most consistent logging behaviour with no line at all (#2396). Week ONLY, for two reasons: a month's coverage rate says nothing a week's did not, and the nutrient half is a per-day gather — bounded at seven days it rides beside the adherence walk, over ninety it would be a scan on the dashboard's own render path.",
  },
  weight: {
    scales: ["week"],
    why: "The latest weigh-in against last week's — a point reading with a short comparison, which is what a week can honestly say about a noisy daily quantity.",
  },
  "weight-trajectory": {
    scales: ["month", "quarter"],
    why: "Over a month the useful question stops being 'what did the scale say' and becomes 'where is this going and how fast'. Robust median endpoints over the period plus a per-week rate, compared against the SAME figure one period back — a direction, not a total.",
  },
  zone2: {
    scales: ["week"],
    why: "Measured against the WEEKLY aerobic-base target (#159). There is no monthly target to measure against, and multiplying the weekly one by four would invent a goal the user never set.",
  },
  "sleep-duration": {
    scales: ["week", "month", "quarter"],
    why: "Regularity without duration is an odd half of the picture — a perfectly consistent five hours a night scores well (#2396). A MEDIAN night is a shape, not a sum, so it re-totals nothing and reports identically at every length; one night is a digest fact (#1117), which is what the minimum-nights gate keeps this line from restating.",
  },
  sleepRegularity: {
    scales: ["week", "month", "quarter"],
    why: "The SRI is already a trailing 28-night index (#160) — it is a month-scale statistic that the weekly recap borrows. It is native at month and quarter scale and needs no re-derivation to speak there.",
  },
  mood: {
    scales: ["week"],
    why: "An opt-in, gentle summary of a handful of check-ins (#992). Averaging a quarter of mood scores into one number is precisely the over-claim the line's own contract forbids.",
  },
  goals: {
    scales: ["week", "month", "quarter"],
    why: "A goal reached is a dated event, so it belongs to whichever window contains it at any length — and quarter scale is the horizon goals are actually set on, which is why it is one of the few lines that leads a quarterly recap. Dated since #2394 by the goal's own `achieved_at`, so the window it belongs to is the one it actually happened in.",
  },
  "goals-missed": {
    scales: ["week", "month", "quarter"],
    why: "A deadline passing unmet is the same kind of dated event as a deadline being met, and reporting one without the other is the asymmetry #2394 closes — the app cheerfully announced the goals that landed and said nothing about the ones that did not. Once, in the period the date fell in, at whatever length that period is.",
  },
  "fitness-check": {
    scales: ["week", "month", "quarter"],
    why: "A completed battery is a discrete event with its own comparison built in (this fitness age vs the prior one). It cannot be summed and it does not decay, so it reports identically at every length.",
  },
};

/** Does this line speak at this scale? The ONE reader of the declaration above. */
export function lineSpeaksAt(key: RecapLineKey, scale: RecapScale): boolean {
  return RECAP_LINE_MODEL[key].scales.includes(scale);
}

export interface RecapLine {
  // A short machine label used as a stable key and (title-cased) as the row label.
  key: RecapLineKey;
  label: string;
  value: string;
  // How this line compares itself — exactly one declared idiom, or "none".
  comparison: RecapComparison;
  // Supporting detail that is NOT a comparison: which lifts set the PRs, the dose
  // counts behind an adherence percentage, the weekend shift behind an SRI. Kept
  // separate from `comparison` so the two can never be confused for each other
  // again.
  //
  // A LIST since #2391, matching the shared message-line shape: the adherence line
  // carries two independent facts ("12/14 doses", "1 skipped") and used to punctuate
  // the second one itself. Nullish entries are dropped, so a conditional fact may be
  // passed positionally.
  notes?: readonly (string | null | undefined)[];
  // True when `value` is a complete, self-labeled line and the row label must not
  // be printed in front of it — the shared intake delta line (#1505) already leads
  // with its own "Missed:"/"Resumed:" prefixes, and nesting it under a second label
  // produced "Changed: Missed: Glycine (2 days)" (#1935). Surfaces render the label
  // for accessibility only.
  bare?: boolean;
}

// A recap line in the shared message-line shape (#2391). ONE place decides which parts
// a recap line has and in what order; the notification formats it, the card lays out its
// qualifiers, and the narrative prompt reads the same parts. The row label folds into the
// head — which is exactly what makes "label: value — note · comparison" and the digest's
// "glyph title — because · dueText" the same grammar.
//
// A BARE line is already self-labelled (the shared intake delta line, #1505) and its head
// is its value alone; printing the row label in front of it labelled it twice (#1935).
export function recapMessageLine(line: RecapLine): MessageLine {
  return {
    head: line.bare ? line.value : `${line.label}: ${line.value}`,
    notes: line.notes,
    comparison: line.comparison.kind === "none" ? null : line.comparison.text,
  };
}

// The annotation a CARD prints after a line's value: the line's qualifiers, in the one
// declared order. ONE composition for the card and the notification (#221) — neither may
// reassemble the pieces itself.
export function recapLineAnnotation(line: RecapLine): string | undefined {
  const parts = messageLineQualifiers(recapMessageLine(line));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export interface Recap {
  // Which scale this recap speaks at — carried on the result so a surface never has
  // to re-derive it from the window's length.
  scale: RecapScale;
  start: string;
  end: string;
  // A one-line factual headline, e.g. "4 workouts, 2 PRs". Empty string when there
  // is nothing to report.
  headline: string;
  lines: RecapLine[];
  // True when the period had no workouts, no adherence, and no weight readings — the
  // caller then skips the notification (the widget still renders a quiet nudge).
  isEmpty: boolean;
}

function countByType(workouts: RecapWorkout[]): Record<WorkoutType, number> {
  const out: Record<WorkoutType, number> = { strength: 0, cardio: 0, sport: 0 };
  for (const w of workouts) if (w.type) out[w.type]++;
  return out;
}

// A compact "strength 2, cardio 1" breakdown of a workout count, omitting zero
// types; empty string when there were no workouts.
function typeBreakdown(counts: Record<WorkoutType, number>): string {
  const parts: string[] = [];
  if (counts.strength) parts.push(`strength ${counts.strength}`);
  if (counts.cardio) parts.push(`cardio ${counts.cardio}`);
  if (counts.sport) parts.push(`sport ${counts.sport}`);
  return parts.join(", ");
}

// Robust net weight change over the window: the median of the last cluster of
// readings minus the median of the first cluster (k = min(3, floor(n/2))), so one
// noisy weigh-in at either end doesn't define the "trend". Returns null when fewer
// than two readings exist (no direction to report).
export function weightTrendKg(weights: RecapWeight[]): number | null {
  if (weights.length < 2) return null;
  const k = Math.min(3, Math.floor(weights.length / 2));
  const { first, last } = robustEndpoints(
    weights.map((w) => ({ value: w.weightKg })),
    k
  );
  return last - first;
}

// The smallest number of sessions a composition SHARE is allowed to speak over. Three
// sessions rendered as "strength 67%" is a percentage of noise, and a share that swings
// 33 points on one session is worse than no line at all.
export const RECAP_MIX_MIN_SESSIONS = 4;

// The smallest number of intended doses the adherence SHAPE is allowed to speak over.
// Below it a "weekends 50%" is two doses, and a split is a coincidence, not a pattern.
export const RECAP_PATTERN_MIN_DOSES = 14;

export interface RecapTrainingMix {
  sessions: number;
  /** Share of the TYPED sessions, per bucket, in the fixed strength/cardio/sport order. */
  shares: { type: WorkoutType; pct: number }[];
  /** Sessions per week over the period — a RATE, deliberately not a total. */
  perWeek: number;
}

/**
 * The composition + rate of a period's training. Null when there are too few sessions
 * for a share to mean anything (RECAP_MIX_MIN_SESSIONS), or when nothing carried a
 * bucket at all — an all-`unclassified` month has no composition to report, and
 * inventing one is the #2272 mistake.
 */
export function trainingMix(
  workouts: RecapWorkout[],
  windowDays: number
): RecapTrainingMix | null {
  if (workouts.length < RECAP_MIX_MIN_SESSIONS || windowDays <= 0) return null;
  const counts = countByType(workouts);
  const typed = counts.strength + counts.cardio + counts.sport;
  if (typed === 0) return null;
  const order: WorkoutType[] = ["strength", "cardio", "sport"];
  return {
    sessions: workouts.length,
    shares: order
      .filter((t) => counts[t] > 0)
      .map((t) => ({ type: t, pct: Math.round((counts[t] / typed) * 100) })),
    perWeek: Math.round((workouts.length / windowDays) * 7 * 10) / 10,
  };
}

export interface RecapAdherenceShape {
  weekdayPct: number | null;
  weekendPct: number | null;
  /** Second half of the period against the first — a WITHIN-period direction. */
  drift: "steady" | "improving" | "slipping";
  intended: number;
}

const DRIFT_POINTS = 8;

/**
 * The SHAPE of a period's adherence: the weekday/weekend split and whether the second
 * half ran ahead of or behind the first. Null below RECAP_PATTERN_MIN_DOSES intended
 * doses. Deliberate skips (#232) leave the denominator exactly as they do at week scale.
 */
export function adherenceShape(
  days: readonly RecapAdherenceDay[]
): RecapAdherenceShape | null {
  const withDoses = days.filter((d) => d.due - d.skipped > 0);
  const intended = withDoses.reduce((a, d) => a + (d.due - d.skipped), 0);
  if (intended < RECAP_PATTERN_MIN_DOSES) return null;
  const pct = (rows: readonly RecapAdherenceDay[]): number | null => {
    const denom = rows.reduce((a, d) => a + (d.due - d.skipped), 0);
    if (denom <= 0) return null;
    return Math.round((rows.reduce((a, d) => a + d.taken, 0) / denom) * 100);
  };
  const isWeekend = (d: RecapAdherenceDay) => {
    const wd = weekdayOfDateStr(d.date);
    return wd === 0 || wd === 6;
  };
  const half = Math.floor(withDoses.length / 2);
  const firstPct = pct(withDoses.slice(0, half));
  const secondPct = pct(withDoses.slice(half));
  const delta =
    firstPct != null && secondPct != null ? secondPct - firstPct : 0;
  return {
    weekdayPct: pct(withDoses.filter((d) => !isWeekend(d))),
    weekendPct: pct(withDoses.filter(isWeekend)),
    drift:
      delta >= DRIFT_POINTS
        ? "improving"
        : delta <= -DRIFT_POINTS
          ? "slipping"
          : "steady",
    intended,
  };
}

// A signed display delta ("−1.8 kg"), through the login's weight unit.
function signedWeight(deltaKg: number, wu: WeightUnit): string {
  const arrow = deltaKg > 0 ? "+" : deltaKg < 0 ? "−" : "±";
  return `${arrow}${kgTo(Math.abs(deltaKg), wu).toFixed(1)} ${wu}`;
}

// Assemble the recap line model from the gathered facts. Quiet and factual: plain
// counts and one declared comparison per line, no exclamation, no score. Sections
// with nothing to say are omitted entirely.
//
// The SCALE is the only axis (#2178): the period comes from lib/recap-scale.ts and
// every line goes through `push`, which drops any line whose declared scale set does
// not contain this scale. There is no `if (scale === "month")` anywhere below, and
// there must never be — a scale difference belongs in the registry.
export function buildRecap(input: RecapInput): Recap {
  const scale = input.scale ?? "week";
  const entry = recapScaleEntry(scale);
  const win = periodFor(
    scale,
    input.today,
    input.weekMode,
    input.weekStart,
    input.completed ?? false
  );
  const windowDays = (daysBetweenDateStr(win.start, win.end) ?? 6) + 1;
  const noun = entry.noun;
  const wu = input.weightUnit;
  const lines: RecapLine[] = [];
  const push = (line: RecapLine) => {
    if (lineSpeaksAt(line.key, scale)) lines.push(line);
  };
  const illnessDays = input.illnessDays ?? 0;

  // Recovery context (issue #837): a sick week reads as a sick week, not a failed
  // one. Leads the lines so the low numbers below are read in context — the app's
  // own tracked illness state, not a scold. No comparison (a fact, not a trend).
  if (illnessDays > 0) {
    push({
      key: "recovery",
      label: "Recovery",
      value: `sick ${illnessDays} day${illnessDays === 1 ? "" : "s"} this ${noun}`,
      comparison: NO_COMPARISON,
    });
  }

  // Workouts and their composition — the training fact that only week scale shows.
  const counts = countByType(input.workouts);
  const workoutCount = input.workouts.length;
  const prevCount = input.prevWorkouts.length;
  if (workoutCount > 0 || prevCount > 0) {
    // THE VALUE IS THE QUANTITY, THE BREAKDOWN IS A NOTE (#2389 item 1). This line used
    // to bake its composition into `value` — "7 (strength 4, cardio 3)" — so it arrived
    // with a parenthetical already inside it and the grammar then appended the
    // comparison after it, stacking two unrelated asides. The breakdown DECOMPOSES the
    // head's own figure, which is exactly what a note is; declared as one, the line
    // reads "Workouts: 7 — strength 4, cardio 3 · 5 last week" and the composition owns
    // every separator on it.
    const breakdown = typeBreakdown(counts);
    push({
      key: "workouts",
      label: "Workouts",
      value: String(workoutCount),
      comparison: { kind: "prior", text: `${prevCount} last ${noun}` },
      notes: [breakdown || null],
    });
  }

  // Training composition + rate (#2178) — the month/quarter answer to the same
  // question the weekly `workouts` line answers with a count. The count is
  // deliberately absent: "18 workouts" is four weekly lines summed and handed back
  // with an authority none of them had. What a month is the first window to show is
  // the SHAPE — which kind of training the period was actually made of, and how that
  // share moved — plus a per-week rate that a missed week nudges instead of zeroing.
  const mix = trainingMix(input.workouts, windowDays);
  const prevMix = trainingMix(
    input.prevWorkouts,
    (daysBetweenDateStr(win.prevStart, win.prevEnd) ?? windowDays - 1) + 1
  );
  if (mix) {
    const lead = mix.shares[0];
    const priorLead = prevMix?.shares.find((s) => s.type === lead.type);
    push({
      key: "training-mix",
      label: "Training mix",
      value: mix.shares.map((s) => `${s.type} ${s.pct}%`).join(", "),
      comparison: priorLead
        ? {
            kind: "prior",
            text: `${lead.type} ${priorLead.pct}% last ${noun}`,
          }
        : NO_COMPARISON,
      notes: [`${mix.perWeek.toFixed(1)} sessions/week`],
    });
  }

  // Personal records set this week.
  if (input.prLabels.length > 0) {
    const shown = input.prLabels.slice(0, 3).join(", ");
    const extra = input.prLabels.length - 3;
    push({
      key: "prs",
      label: "PRs",
      value: `${input.prLabels.length}`,
      comparison: NO_COMPARISON,
      notes: [extra > 0 ? `${shown} +${extra} more` : shown],
    });
  }

  // Intake state changes (#1505 part 3) lead the intake report: WHICH pushed
  // obligations moved is the news, the percentage below is the supporting detail.
  // Rendered from the preformatted shared line, never recomputed here.
  //
  // Rendered BARE (#1935): the shared line already leads with its own "Missed:" /
  // "Resumed:" prefixes, so hanging it under a second label read "Changed: Missed:
  // Glycine (2 days)" — labelled twice, and "Changed" is the wrong word for a miss
  // anyway (nothing changed; something did not happen). The label survives for
  // accessibility and as the row key; it is not printed in front of the value.
  if (input.intakeDeltaLine) {
    push({
      key: "intake-deltas",
      label: "Intake",
      value: input.intakeDeltaLine,
      comparison: NO_COMPARISON,
      bare: true,
    });
  }

  // IntakeItem adherence. Deliberate skips (#232) are excluded from the
  // denominator (they weren't intended doses) but shown as a trailing note.
  if (input.adherence && input.adherence.due > 0) {
    const { taken, skipped, due } = input.adherence;
    const intended = due - skipped;
    if (intended > 0) {
      const p = Math.round((taken / intended) * 100);
      push({
        key: "adherence",
        label: "Adherence",
        value: `${p}%`,
        comparison: NO_COMPARISON,
        // Two independent facts, declared as two notes: the grammar punctuates them.
        notes: [
          `${taken}/${intended} doses`,
          skipped > 0 ? `${skipped} skipped` : null,
        ],
      });
    } else {
      // Every due dose was skipped — no percentage to report, just the count. The note
      // that used to sit under it restated the value in longer words (#2389 item 1);
      // the value carries the quantity and there is no second fact to qualify it with.
      push({
        key: "adherence",
        label: "Adherence",
        value: `${skipped} dose${skipped === 1 ? "" : "s"} skipped`,
        comparison: NO_COMPARISON,
      });
    }
  }

  // Adherence PATTERN (#2178) — the month/quarter line, and the clearest case of the
  // inclusion test working constructively. A monthly percentage is computable and
  // useless: it averages away the weekday/weekend split and the drift, which are the
  // only two things about a month of doses worth telling anyone. Reported as a shape,
  // with the direction as a NOTE rather than a comparison — there is no score here to
  // beat, and the drift is a within-period observation, not a period-over-period one.
  const shape = adherenceShape(input.adherenceDays ?? []);
  if (shape && (shape.weekdayPct != null || shape.weekendPct != null)) {
    const parts: string[] = [];
    if (shape.weekdayPct != null) parts.push(`weekdays ${shape.weekdayPct}%`);
    if (shape.weekendPct != null) parts.push(`weekends ${shape.weekendPct}%`);
    push({
      key: "adherence-pattern",
      label: "Adherence pattern",
      value: parts.join(", "),
      comparison: NO_COMPARISON,
      notes: [
        shape.drift === "steady"
          ? `steady across the ${noun}`
          : `${shape.drift} through the ${noun}`,
      ],
    });
  }

  // Body weight: the latest reading, its week-over-week comparison, and the robust
  // net change WITHIN the window as the note. The comparison is the plain "prior"
  // idiom — the same figure (a weigh-in) one window back — which is what the line
  // was missing (#1935): a weekly delta matters more here than on any other line,
  // and a week with a single weigh-in used to carry no delta at all because the
  // within-window trend needs two readings.
  const trend = weightTrendKg(input.weights);
  const prevWeights = input.prevWeights ?? [];
  if (input.weights.length > 0) {
    const latest = input.weights[input.weights.length - 1].weightKg;
    let note: string | undefined;
    if (trend != null) {
      const dispDelta = kgTo(Math.abs(trend), wu);
      const arrow = trend > 0 ? "+" : trend < 0 ? "−" : "±";
      note = `${arrow}${dispDelta.toFixed(1)} ${wu} this ${noun}`;
    }
    const prior =
      prevWeights.length > 0
        ? prevWeights[prevWeights.length - 1].weightKg
        : null;
    push({
      key: "weight",
      label: "Weight",
      value: fmtWeight(latest, wu),
      comparison:
        prior != null
          ? {
              kind: "prior",
              text: `${fmtWeight(prior, wu)} last ${noun}`,
            }
          : NO_COMPARISON,
      notes: [note],
    });
  }

  // Weight TRAJECTORY (#2178) — the month/quarter line. Over a month the useful
  // question stops being "what did the scale say on the last day" and becomes "where
  // is this going, and how fast": the robust median-endpoint net change over the
  // period, a per-week rate so two periods of different lengths stay comparable, and
  // the SAME net change one period back as the declared comparison. A direction, never
  // a total, and never a fourth invented statistic.
  //
  // WHY NOT lib/long-range-series.ts. #2178 proposed reusing it verbatim for this
  // trajectory so the message and the 1Y chart would tell one story. It cannot: that
  // module DECLARES a floor — `LONG_RANGE_MIN_DAYS = 180`, below which `longRangeGrain`
  // returns null and `aggregateLongRange` refuses — and every period this line speaks at
  // is under it (a calendar month is 28–31 days, a quarter 90–92). Verbatim reuse
  // returns null for every monthly and quarterly recap. Lowering the floor to reach them
  // is not "verbatim": it is a change to when the TRENDS CHART stops plotting raw points,
  // and it would silently bucket every 90D range on that surface. The two also want
  // different answers — a chart wants a per-bucket mean SERIES to draw, this line wants
  // one scalar direction to say — so `robustEndpoints` (the same computation the weekly
  // `weight` line already uses) is what keeps the recap's two weight lines consistent
  // with each other, which is the agreement that is actually reachable here.
  const prevTrend = weightTrendKg(prevWeights);
  if (trend != null) {
    const perWeek = (trend / windowDays) * 7;
    push({
      key: "weight-trajectory",
      label: "Weight trend",
      value: signedWeight(trend, wu),
      comparison:
        prevTrend != null
          ? {
              kind: "prior",
              text: `${signedWeight(prevTrend, wu)} last ${noun}`,
            }
          : NO_COMPARISON,
      // TWO notes, not one string with a `·` in it (#2391): the per-week rate and the
      // latest reading are peer facts about the head, and the grammar owns the separator
      // between them.
      notes: [
        `${signedWeight(perWeek, wu)}/week`,
        `now ${fmtWeight(input.weights[input.weights.length - 1].weightKg, wu)}`,
      ],
    });
  }

  // Zone 2 aerobic base (#159): easy-endurance minutes vs the weekly target.
  if (input.zone2Min != null && input.zone2Min > 0) {
    const target =
      input.zone2Target != null && input.zone2Target > 0
        ? input.zone2Target
        : null;
    push({
      key: "zone2",
      label: "Zone 2",
      value: `${input.zone2Min} min`,
      comparison: target
        ? {
            kind: "target",
            text: `${Math.round((input.zone2Min / target) * 100)}% of ${target} min target`,
          }
        : NO_COMPARISON,
    });
  }

  // Sleep regularity (#160): the SRI over the trailing 28-night window, with the
  // weekend-vs-weekday mid-sleep shift as context. Omitted when there isn't enough
  // sleep data (sri null under the minimum-nights gate).
  if (input.sri != null) {
    const shiftH =
      input.socialJetlagMin != null && input.socialJetlagMin > 0
        ? `${(input.socialJetlagMin / 60).toFixed(1)}h weekend shift`
        : undefined;
    push({
      key: "sleepRegularity",
      label: "Sleep regularity",
      value: sriPresentation(input.sri).text,
      comparison: NO_COMPARISON,
      notes: [shiftH],
    });
  }

  // Mood (#992): a gentle, opt-in summary of the window's check-ins. No comparison
  // on purpose — a summary, never a score to beat (the no-gamification contract).
  //
  // A SINGLE check-in is reported as itself, not as an "average" (#1935): averaging
  // one value is not an average, and dressing one low day as a weekly statistic is
  // exactly the over-claim #992 guards against. The averaging language appears only
  // once there is something to average.
  if (input.mood != null && input.mood.daysLogged > 0) {
    const avg = Math.round(input.mood.avgValence * 10) / 10;
    const days = input.mood.daysLogged;
    push({
      key: "mood",
      label: "Mood",
      value:
        days === 1
          ? `one check-in: ${avg}/5`
          : `averaged ${avg}/5 over ${days} check-ins`,
      comparison: NO_COMPARISON,
    });
  }

  // Goals completed this week.
  if (input.goalsCompleted.length > 0) {
    push({
      key: "goals",
      label: "Goals reached",
      value: `${input.goalsCompleted.length}`,
      comparison: NO_COMPARISON,
      notes: [input.goalsCompleted.slice(0, 3).join(", ")],
    });
  }

  // Fitness check completed this window (#1307) — factual, from the completed check's
  // fitness age. The prior age is shown only when it differs (an honest "was 36").
  if (input.fitnessCheck != null) {
    const { fitnessAge, priorFitnessAge } = input.fitnessCheck;
    const value =
      fitnessAge != null
        ? `fitness age ${fitnessAge}${
            priorFitnessAge != null && priorFitnessAge !== fitnessAge
              ? `, was ${priorFitnessAge}`
              : ""
          }`
        : "battery refreshed";
    push({
      key: "fitness-check",
      label: "Fitness check",
      value,
      comparison: NO_COMPARISON,
    });
  }

  const isEmpty =
    illnessDays === 0 &&
    workoutCount === 0 &&
    (input.adherence == null || input.adherence.due === 0) &&
    input.weights.length === 0;

  // Headline: the two facts most worth leading with, else a quiet fallback. It obeys
  // the same declaration the lines do — a scale that does not speak the workout COUNT
  // must not smuggle it back in through the headline, so it leads with the rate its
  // own line reports instead.
  const headParts: string[] = [];
  if (lineSpeaksAt("workouts", scale) && workoutCount > 0)
    headParts.push(`${workoutCount} workout${workoutCount === 1 ? "" : "s"}`);
  if (lineSpeaksAt("training-mix", scale) && mix)
    headParts.push(`${mix.perWeek.toFixed(1)} sessions/week`);
  if (lineSpeaksAt("prs", scale) && input.prLabels.length > 0)
    headParts.push(
      `${input.prLabels.length} PR${input.prLabels.length === 1 ? "" : "s"}`
    );
  if (
    headParts.length === 0 &&
    lineSpeaksAt("weight-trajectory", scale) &&
    trend != null
  )
    headParts.push(`${signedWeight(trend, wu)} body weight`);
  if (
    headParts.length === 0 &&
    lineSpeaksAt("adherence", scale) &&
    input.adherence
  ) {
    const intended = input.adherence.due - input.adherence.skipped;
    if (intended > 0) {
      const p = Math.round((input.adherence.taken / intended) * 100);
      headParts.push(`${p}% adherence`);
    }
  }
  // A week with nothing else to lead with but a logged illness leads with recovery,
  // so the headline names the episode instead of reading as an empty/failed week.
  if (headParts.length === 0 && illnessDays > 0)
    headParts.push(
      `recovering — sick ${illnessDays} day${illnessDays === 1 ? "" : "s"}`
    );
  const headline = headParts.join(", ");

  return { scale, start: win.start, end: win.end, headline, lines, isEmpty };
}

// The window label — "Jul 3 – Jul 9" — rendered through the login's date-format
// prefs (#1218), so the recap card and the Telegram recap present the range the
// same way every other dashboard surface presents a date, and never leak raw ISO.
// ONE presentation for BOTH surfaces (#221): the card passes the login's prefs; the
// notification path (no per-login context) takes the 24h/mdy default. `formatMonthDay`
// appends the year only across a year boundary, so a within-year week stays compact.
export function recapRangeLabel(
  start: string,
  end: string,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): string {
  return `${formatMonthDay(start, prefs)} – ${formatMonthDay(end, prefs)}`;
}

// The minimal shape of a stored recap narrative row this picker needs (a subset
// of lib/types PeriodRecap), kept local so this pure module stays dependency-light.
export interface StoredRecapNarrative {
  period_start: string | null;
  period_end: string;
  summary: string;
}

// Pick the stored recap narrative to surface in the weekly notification (#421):
// the AI narrative of the SAME recap that today only reaches the Trends button.
// An exact period_end match with the recap window wins; otherwise the newest
// narrative anchored inside the window (a read generated a day earlier still
// describes this week). Returns the trimmed summary, or null when none applies.
export function pickRecapNarrative(
  narratives: StoredRecapNarrative[],
  recap: Recap
): string | null {
  const exact = narratives.find((n) => n.period_end === recap.end);
  if (exact) return exact.summary.trim() || null;
  const overlap = narratives
    .filter((n) => n.period_end >= recap.start && n.period_end <= recap.end)
    .sort((a, b) => b.period_end.localeCompare(a.period_end))[0];
  return overlap ? overlap.summary.trim() || null : null;
}

// Render the recap to a channel-agnostic notification message, or null when the
// period was empty (nothing worth interrupting the user for). The title names the
// SCALE from the registry (#2178), so a monthly recap says "Monthly recap" rather
// than a weekly heading over month-scale lines. Kept separate from
// assembly, mirroring the digest. The title names the profile — a shared chat can
// carry several. When a stored recap `narrative` is supplied (#421), it replaces
// the bare "• label: value" bullets — the narrative already reads over the same
// facts; the bullets are the fallback when no narrative has been generated.
export function renderRecapMessage(
  recap: Recap,
  profileName: string,
  narrative?: string | null,
  deepLinkBase = ""
): NotificationMessage | null {
  if (recap.isEmpty || recap.lines.length === 0) return null;
  const narr = narrative?.trim();
  // THE DOCUMENTED GRAMMAR, not a parenthesis of its own (#2391/#2389 item 2). The
  // recap composed with parentheses while the digest moved to declared parts, so the two
  // system-initiated messages a profile receives were punctuated by different rules —
  // and only one of them was nesting-proof. A label legitimately contains parentheses
  // ("Romanian Deadlift (Rep Trap Bar)"), and wrapping an annotation containing one in
  // another set nested.
  //
  // EMPHASIS since #2392, on the same rule the digest follows. A recap line's head is
  // "Workouts: 7" — a label and the figure the week turned on — and its qualifiers are
  // the breakdown and the comparison beneath it: precisely the shape formatEmphasizedLine
  // was written for. A stored NARRATIVE (#421) replaces the bullets with prose and takes
  // no emphasis: it is one paragraph with no head to mark.
  const lines: MessageBody[] = narr
    ? [narr]
    : recap.lines.map((l) =>
        formatEmphasizedLine({ glyph: GLYPH.bullet, ...recapMessageLine(l) })
      );
  // The range label is the recap's one structural header — the digest's section headings
  // one surface over — so it carries the same weight they do.
  const body = joinBody(
    [richFrom([bold(recapRangeLabel(recap.start, recap.end))]), ...lines],
    "\n"
  );
  // The recap was the only builder that took no deepLinkBase and returned no actions
  // (#1722 item 2) — a week's summary with nowhere to go and look. Every sibling
  // carries one.
  const base = deepLinkBase.replace(/\/$/, "");
  return {
    // The profile name is a NOTE on the title — a shared chat can carry several. The
    // HEAD names the scale from the registry (#2178), so a monthly recap says "Monthly
    // recap" rather than a weekly heading over month-scale lines; the glyph is the same
    // one at every scale, because it is the same message breathing slower.
    title: formatMessageLine({
      glyph: GLYPH.recap,
      head: recapScaleEntry(recap.scale).label,
      notes: [profileName],
    }),
    body,
    kind: "weekly-recap",
    ...(base
      ? { actions: [{ label: "Open Trends →", url: `${base}/trends` }] }
      : {}),
  };
}

// The median weekly workout count over a list of prior weekly counts — a
// longer-run baseline helper kept with the recap logic. Returns null for an empty
// list.
export function medianWeeklyWorkouts(counts: number[]): number | null {
  if (counts.length === 0) return null;
  return median(counts);
}
