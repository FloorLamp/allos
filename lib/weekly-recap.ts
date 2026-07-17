// Weekly recap (issue #32) — a PURE, rule-based summary of the last seven days:
// workouts + training volume, personal records, supplement adherence, a robust
// body-weight trend, and streak status. No DB, no network, no AI — so it runs in
// the dashboard widget, the weekly notification, and the unit tests alike, and
// works with zero AI configuration. The DB gather lives in
// lib/notifications/weekly-recap-data.ts (mirroring the digest's data/render
// split); this module turns the gathered facts into a line model and renders the
// notification message.
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
import { median, robustEndpoints } from "./robust-stats";
import { fmtWeight, kgTo } from "./units";
import { weekWindow } from "./week-window";
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
export function resolveRecapWindow(
  today: string,
  days = 7,
  weekMode: WeekMode = "rolling",
  weekStart: WeekStart = 0
): RecapWindow {
  return days === 7
    ? weekWindow(today, weekMode, weekStart)
    : recapWindow(today, days);
}

// A short noun for the period length, used in the delta phrasing ("last week"
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

export type WorkoutType = "strength" | "cardio" | "sport";

export interface RecapWorkout {
  date: string;
  type: WorkoutType;
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
  // both the window math and the "last week"/"last month" delta wording.
  periodDays?: number;
  // The profile's week definition, applied to the 7-day weekly recap so its
  // window matches the routine counters / journal (issue #223). Omitted ⇒
  // "rolling" (trailing seven days), preserving the pre-#223 behavior; ignored for
  // non-weekly periods (weekMode only defines a week).
  weekMode?: WeekMode;
  weekStart?: WeekStart;
  // Workouts (one per activity) in the current and previous seven-day windows.
  workouts: RecapWorkout[];
  prevWorkouts: RecapWorkout[];
  // Strength training volume (kg lifted) summed over each window.
  volumeKg: number;
  prevVolumeKg: number;
  // Total ESTIMATED calorie burn (issue #151) from MANUAL activities in each
  // window — MET dataset × nearest bodyweight × duration (lib/calorie-estimate).
  // Both optional/null when nothing estimable was logged; the line is then omitted.
  // Always an estimate, kept distinct from any device-measured energy.
  estimatedKcal?: number | null;
  prevEstimatedKcal?: number | null;
  // Personal records (strength + cardio) dated within the current window; labels
  // are short display names ("Bench press", "Running") for the summary line.
  prLabels: string[];
  // Supplement/medication adherence over the window, or null when nothing was
  // due. `skipped` counts deliberate skips (#232), excluded from the percentage.
  adherence: { taken: number; skipped: number; due: number } | null;
  // Body weights logged within the window, oldest-first (already sorted by the
  // gather). Used for a robust (median-endpoint) net-change trend.
  weights: RecapWeight[];
  // Streak status as of today (active-day count + strict consecutive-day count).
  streak: number;
  strictStreak: number;
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
}

export interface RecapLine {
  // A short machine label used as a stable key and (title-cased) as the row label.
  key: string;
  label: string;
  value: string;
  // Optional trend annotation ("+8%", "−0.5 kg", "3 last week"). Never a value the
  // line can't stand without.
  delta?: string;
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

function pct(cur: number, prev: number): number | null {
  if (prev <= 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function countByType(workouts: RecapWorkout[]): Record<WorkoutType, number> {
  const out: Record<WorkoutType, number> = { strength: 0, cardio: 0, sport: 0 };
  for (const w of workouts) out[w.type]++;
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
// counts and deltas, no exclamation, no score. Sections with nothing to say are
// omitted entirely.
export function buildWeeklyRecap(input: RecapInput): WeeklyRecap {
  const days = input.periodDays ?? 7;
  const win = resolveRecapWindow(
    input.today,
    days,
    input.weekMode,
    input.weekStart
  );
  const noun = periodNounFor(days);
  const wu = input.weightUnit;
  const lines: RecapLine[] = [];
  const illnessDays = input.illnessDays ?? 0;

  // Recovery context (issue #837): a sick week reads as a sick week, not a failed
  // one. Leads the lines so the low numbers below are read in context — the app's
  // own tracked illness state, not a scold. No delta (it's a fact, not a trend).
  if (illnessDays > 0) {
    lines.push({
      key: "recovery",
      label: "Recovery",
      value: `sick ${illnessDays} day${illnessDays === 1 ? "" : "s"} this ${noun}`,
    });
  }

  // Workouts + volume.
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
      delta: `${prevCount} last ${noun}`,
    });
  }

  if (input.volumeKg > 0 || input.prevVolumeKg > 0) {
    const disp = Math.round(kgTo(input.volumeKg, wu)).toLocaleString("en-US");
    const p = pct(input.volumeKg, input.prevVolumeKg);
    lines.push({
      key: "volume",
      label: "Volume",
      value: `${disp} ${wu}`,
      delta: p == null ? undefined : `${signed(p)}%`,
    });
  }

  // Estimated calorie burn (issue #151) from manual activities. The "≈" and the
  // "estimated" annotation keep it visually distinct from a measured total — it is
  // a MET-based estimate, never a device reading.
  const estKcal =
    input.estimatedKcal != null ? Math.round(input.estimatedKcal) : 0;
  const prevEstKcal =
    input.prevEstimatedKcal != null ? Math.round(input.prevEstimatedKcal) : 0;
  if (estKcal > 0 || prevEstKcal > 0) {
    lines.push({
      key: "calories",
      label: "Calories",
      value: `≈${estKcal.toLocaleString("en-US")} kcal`,
      delta:
        prevEstKcal > 0
          ? `estimated · ${prevEstKcal.toLocaleString("en-US")} last ${noun}`
          : "estimated",
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
      delta: extra > 0 ? `${shown} +${extra} more` : shown,
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
        delta: `${taken}/${intended} doses${skipNote}`,
      });
    } else {
      // Every due dose was skipped — no percentage to report, just the count.
      lines.push({
        key: "adherence",
        label: "Adherence",
        value: `${skipped} skipped`,
        delta: `${skipped} dose${skipped === 1 ? "" : "s"} skipped`,
      });
    }
  }

  // Body-weight trend (robust net change over the window).
  const trend = weightTrendKg(input.weights);
  if (input.weights.length > 0) {
    const latest = input.weights[input.weights.length - 1].weightKg;
    let delta: string | undefined;
    if (trend != null) {
      const dispDelta = kgTo(Math.abs(trend), wu);
      const arrow = trend > 0 ? "+" : trend < 0 ? "−" : "±";
      delta = `${arrow}${dispDelta.toFixed(1)} ${wu} this ${noun}`;
    }
    lines.push({
      key: "weight",
      label: "Weight",
      value: fmtWeight(latest, wu),
      delta,
    });
  }

  // Streak status.
  if (input.streak > 0) {
    lines.push({
      key: "streak",
      label: "Streak",
      value: `${input.streak} active day${input.streak === 1 ? "" : "s"}`,
      delta:
        input.strictStreak > 0
          ? `${input.strictStreak}-day consecutive`
          : undefined,
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
      delta: target
        ? `${Math.round((input.zone2Min / target) * 100)}% of ${target} min target`
        : undefined,
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
      value: `${Math.round(input.sri)}/100`,
      delta: shiftH,
    });
  }

  // Goals completed this week.
  if (input.goalsCompleted.length > 0) {
    lines.push({
      key: "goals",
      label: "Goals reached",
      value: `${input.goalsCompleted.length}`,
      delta: input.goalsCompleted.slice(0, 3).join(", "),
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

// Short "2026-07-03 – 2026-07-09" style label for the window. Dependency-free so
// the notification (which can't import date-formatting UI helpers) stays pure.
export function recapRangeLabel(start: string, end: string): string {
  return `${start} – ${end}`;
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
  narrative?: string | null
): NotificationMessage | null {
  if (recap.isEmpty || recap.lines.length === 0) return null;
  const narr = narrative?.trim();
  const body = narr
    ? narr
    : recap.lines
        .map((l) => `• ${l.label}: ${l.value}${l.delta ? ` (${l.delta})` : ""}`)
        .join("\n");
  const who = profileName ? ` — ${profileName}` : "";
  return {
    title: `📊 Weekly recap${who}`,
    body: `${recapRangeLabel(recap.start, recap.end)}\n${body}`,
    kind: "weekly-recap",
  };
}

// The median weekly workout count over a list of prior weekly counts — a
// longer-run baseline helper kept with the recap logic. Returns null for an empty
// list.
export function medianWeeklyWorkouts(counts: number[]): number | null {
  if (counts.length === 0) return null;
  return median(counts);
}
