// Weekly recap (issue #32) — a PURE, rule-based summary of the last seven days:
// workouts, personal records, supplement adherence, a robust body-weight trend,
// aerobic base, and sleep regularity. No DB, no network, no AI — so it runs in the
// dashboard widget, the weekly notification, and the unit tests alike, and works
// with zero AI configuration. The DB gather lives in
// lib/notifications/weekly-recap-data.ts (mirroring the digest's data/render
// split); this module turns the gathered facts into a line model and renders the
// notification message.
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
// journal week summary (issue #223). A rolling-mode profile still gets a trailing
// seven days ending on "today" (unchanged); a calendar-mode profile gets the
// current calendar week through today, with the prior full week as the comparison
// window. Any OTHER period length (e.g. the monthly recap, #20) falls back to a
// trailing `days` window — `week_mode` only defines a week. The range label on
// both surfaces prints the concrete start–end dates, so the copy is honest in
// either mode.

import { shiftDateStr } from "./date";
import {
  formatMonthDay,
  DEFAULT_FORMAT_PREFS,
  type DisplayFormatPrefs,
} from "./format-date";
import { median, robustEndpoints } from "./robust-stats";
import { fmtWeight, kgTo } from "./units";
import { weekWindow } from "./week-window";
import { sriPresentation } from "./sleep-regularity";
import type { WeekMode, WeekStart, WeightUnit } from "./settings";
import type { NotificationMessage } from "./notifications/types";

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
// "this week" matches the routine counters and journal week summary (issue #223).
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

// A short noun for the period length, used in the comparison phrasing ("last week"
// vs "last month"). 7 -> "week", 30/31 -> "month", anything else -> "period",
// so the default (7) preserves the original "last week"/"this week" wording.
export function periodNounFor(days: number): string {
  if (days === 7) return "week";
  if (days === 30 || days === 31) return "month";
  return "period";
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

// The gathered facts the recap summarizes. Everything is already scoped to the
// profile and, where noted, pre-filtered to the trailing window by the gather.
export interface RecapInput {
  today: string;
  weightUnit: WeightUnit;
  // Length of the recap window in days. Defaults to 7 (trailing week) when
  // omitted, so pre-#20 callers are unchanged; a monthly recap passes 30. Drives
  // both the window math and the "last week"/"last month" comparison wording.
  periodDays?: number;
  // The profile's week definition, applied to the 7-day weekly recap so its
  // window matches the routine counters / journal (issue #223). Omitted ⇒
  // "rolling" (trailing seven days), preserving the pre-#223 behavior; ignored for
  // non-weekly periods (weekMode only defines a week).
  weekMode?: WeekMode;
  weekStart?: WeekStart;
  // Calendar-mode completed-week selection (issue #1021): true on the NOTIFICATION
  // path, where the recap summarizes the last COMPLETED calendar week rather than
  // the in-progress one. Omitted/false ⇒ the dashboard's in-progress window; no
  // effect in rolling mode or for non-weekly periods. Carried on the input so
  // buildWeeklyRecap resolves the SAME window the gather filtered by.
  completedWeek?: boolean;
  // Workouts (one per activity) in the current and previous seven-day windows.
  workouts: RecapWorkout[];
  prevWorkouts: RecapWorkout[];
  // Personal records (strength + cardio) dated within the current window; labels
  // are short display names ("Bench press", "Running") for the summary line.
  prLabels: string[];
  // Supplement/medication adherence over the window, or null when nothing was
  // due. `skipped` counts deliberate skips (#232), excluded from the percentage.
  adherence: { taken: number; skipped: number; due: number } | null;
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
  // Goals marked achieved with a target date inside the window (best-effort dating).
  goalsCompleted: string[];
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
  | "prs"
  | "intake-deltas"
  | "adherence"
  | "weight"
  | "zone2"
  | "sleepRegularity"
  | "mood"
  | "goals"
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
// slot allowed. Pinned by lib/__tests__/weekly-recap.test.ts, so a new key is a
// type error here until its author declares one.
export const RECAP_COMPARISON_KINDS: Record<RecapLineKey, RecapComparisonKind> =
  {
    recovery: "none", // a fact about the window, not a trend
    workouts: "prior",
    prs: "none", // which lifts, not how many more than last week
    "intake-deltas": "none", // the shared line is ITSELF the week-over-week change
    adherence: "none", // a rate; its note carries the dose counts
    weight: "prior",
    zone2: "target", // measured against the weekly target, never against last week
    sleepRegularity: "none", // its note carries the weekend shift, not a comparison
    mood: "none", // a summary, never a score to beat (#992/#716)
    goals: "none",
    "fitness-check": "none",
  };

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
  note?: string;
  // True when `value` is a complete, self-labeled line and the row label must not
  // be printed in front of it — the shared intake delta line (#1505) already leads
  // with its own "Missed:"/"Resumed:" prefixes, and nesting it under a second label
  // produced "Changed: Missed: Glycine (2 days)" (#1935). Surfaces render the label
  // for accessibility only.
  bare?: boolean;
}

// The parenthetical a surface prints after a line's value: the non-comparative note
// first, then the declared comparison, "·"-separated. ONE composition for the card
// and the notification (#221) — neither may reassemble the pieces itself.
export function recapLineAnnotation(line: RecapLine): string | undefined {
  const parts = [
    line.note,
    line.comparison.kind === "none" ? undefined : line.comparison.text,
  ].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export interface WeeklyRecap {
  start: string;
  end: string;
  // A one-line factual headline, e.g. "4 workouts, 2 PRs". Empty string when there
  // is nothing to report.
  headline: string;
  lines: RecapLine[];
  // True when the week had no workouts, no adherence, and no weight readings — the
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

// Assemble the recap line model from the gathered facts. Quiet and factual: plain
// counts and one declared comparison per line, no exclamation, no score. Sections
// with nothing to say are omitted entirely.
export function buildWeeklyRecap(input: RecapInput): WeeklyRecap {
  const days = input.periodDays ?? 7;
  const win = resolveRecapWindow(
    input.today,
    days,
    input.weekMode,
    input.weekStart,
    input.completedWeek ?? false
  );
  const noun = periodNounFor(days);
  const wu = input.weightUnit;
  const lines: RecapLine[] = [];
  const illnessDays = input.illnessDays ?? 0;

  // Recovery context (issue #837): a sick week reads as a sick week, not a failed
  // one. Leads the lines so the low numbers below are read in context — the app's
  // own tracked illness state, not a scold. No comparison (a fact, not a trend).
  if (illnessDays > 0) {
    lines.push({
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
    const breakdown = typeBreakdown(counts);
    lines.push({
      key: "workouts",
      label: "Workouts",
      value: breakdown
        ? `${workoutCount} (${breakdown})`
        : String(workoutCount),
      comparison: { kind: "prior", text: `${prevCount} last ${noun}` },
    });
  }

  // Personal records set this week.
  if (input.prLabels.length > 0) {
    const shown = input.prLabels.slice(0, 3).join(", ");
    const extra = input.prLabels.length - 3;
    lines.push({
      key: "prs",
      label: "PRs",
      value: `${input.prLabels.length}`,
      comparison: NO_COMPARISON,
      note: extra > 0 ? `${shown} +${extra} more` : shown,
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
    lines.push({
      key: "intake-deltas",
      label: "Intake",
      value: input.intakeDeltaLine,
      comparison: NO_COMPARISON,
      bare: true,
    });
  }

  // Supplement adherence. Deliberate skips (#232) are excluded from the
  // denominator (they weren't intended doses) but shown as a trailing note.
  if (input.adherence && input.adherence.due > 0) {
    const { taken, skipped, due } = input.adherence;
    const intended = due - skipped;
    const skipNote = skipped > 0 ? ` · ${skipped} skipped` : "";
    if (intended > 0) {
      const p = Math.round((taken / intended) * 100);
      lines.push({
        key: "adherence",
        label: "Adherence",
        value: `${p}%`,
        comparison: NO_COMPARISON,
        note: `${taken}/${intended} doses${skipNote}`,
      });
    } else {
      // Every due dose was skipped — no percentage to report, just the count.
      lines.push({
        key: "adherence",
        label: "Adherence",
        value: `${skipped} skipped`,
        comparison: NO_COMPARISON,
        note: `${skipped} dose${skipped === 1 ? "" : "s"} skipped`,
      });
    }
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
    lines.push({
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
      note,
    });
  }

  // Zone 2 aerobic base (#159): easy-endurance minutes vs the weekly target.
  if (input.zone2Min != null && input.zone2Min > 0) {
    const target =
      input.zone2Target != null && input.zone2Target > 0
        ? input.zone2Target
        : null;
    lines.push({
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
    lines.push({
      key: "sleepRegularity",
      label: "Sleep regularity",
      value: sriPresentation(input.sri).text,
      comparison: NO_COMPARISON,
      note: shiftH,
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
    lines.push({
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
    lines.push({
      key: "goals",
      label: "Goals reached",
      value: `${input.goalsCompleted.length}`,
      comparison: NO_COMPARISON,
      note: input.goalsCompleted.slice(0, 3).join(", "),
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
    lines.push({
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

  // Headline: the two facts most worth leading with, else a quiet fallback.
  const headParts: string[] = [];
  if (workoutCount > 0)
    headParts.push(`${workoutCount} workout${workoutCount === 1 ? "" : "s"}`);
  if (input.prLabels.length > 0)
    headParts.push(
      `${input.prLabels.length} PR${input.prLabels.length === 1 ? "" : "s"}`
    );
  if (headParts.length === 0 && input.adherence) {
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

  return { start: win.start, end: win.end, headline, lines, isEmpty };
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
// of lib/types Narrative), kept local so this pure module stays dependency-light.
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
  recap: WeeklyRecap
): string | null {
  const exact = narratives.find((n) => n.period_end === recap.end);
  if (exact) return exact.summary.trim() || null;
  const overlap = narratives
    .filter((n) => n.period_end >= recap.start && n.period_end <= recap.end)
    .sort((a, b) => b.period_end.localeCompare(a.period_end))[0];
  return overlap ? overlap.summary.trim() || null : null;
}

// Render the recap to a channel-agnostic notification message, or null when the
// week was empty (nothing worth interrupting the user for). Kept separate from
// assembly, mirroring the digest. The title names the profile — a shared chat can
// carry several. When a stored recap `narrative` is supplied (#421), it replaces
// the bare "• label: value" bullets — the narrative already reads over the same
// facts; the bullets are the fallback when no narrative has been generated.
export function renderRecapMessage(
  recap: WeeklyRecap,
  profileName: string,
  narrative?: string | null,
  deepLinkBase = ""
): NotificationMessage | null {
  if (recap.isEmpty || recap.lines.length === 0) return null;
  const narr = narrative?.trim();
  const body = narr
    ? narr
    : recap.lines
        .map((l) => {
          const ann = recapLineAnnotation(l);
          // A bare line is already self-labelled (the shared intake delta line) —
          // printing the row label in front of it would label it twice (#1935).
          const head = l.bare ? l.value : `${l.label}: ${l.value}`;
          return `• ${head}${ann ? ` (${ann})` : ""}`;
        })
        .join("\n");
  const who = profileName ? ` — ${profileName}` : "";
  // The recap was the only builder that took no deepLinkBase and returned no actions
  // (#1722 item 2) — a week's summary with nowhere to go and look. Every sibling
  // carries one.
  const base = deepLinkBase.replace(/\/$/, "");
  return {
    title: `📊 Weekly recap${who}`,
    body: `${recapRangeLabel(recap.start, recap.end)}\n${body}`,
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
