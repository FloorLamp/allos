// Weekly recap (issue #32) — a PURE, rule-based summary of the last seven days:
// workouts + training volume, personal records, supplement adherence, a robust
// body-weight trend, and streak status. No DB, no network, no AI — so it runs in
// the dashboard widget, the weekly notification, and the unit tests alike, and
// works with zero AI configuration. The DB gather lives in
// lib/notifications/weekly-recap-data.ts (mirroring the digest's data/render
// split); this module turns the gathered facts into a line model and renders the
// notification message.
//
// Week definition — a TRAILING SEVEN DAYS ending on the recap date (inclusive),
// with the prior seven days as the comparison window. Chosen over a fixed
// Monday–Sunday calendar week because: (a) it is independent of the profile's
// week-start / week-mode setting and of timezone week boundaries, so the same
// window math holds for every profile; (b) it always ends on "today", so the card
// on the dashboard reflects the most recent seven days no matter which day it's
// viewed; and (c) the notification, which fires on a chosen weekday, then
// summarizes exactly the seven days leading up to that send — no partial-week edge
// cases.

import { shiftDateStr } from "./date";
import { median, robustEndpoints } from "./robust-stats";
import { fmtWeight, kgTo } from "./units";
import type { WeightUnit } from "./settings";
import type { NotificationMessage } from "./notifications/types";

// The seven-day window ending on `today` (inclusive) plus the preceding seven-day
// comparison window. All bounds are YYYY-MM-DD strings in the profile's timezone.
export interface RecapWindow {
  start: string; // today - 6
  end: string; // today
  prevStart: string; // today - 13
  prevEnd: string; // today - 7
}

export function recapWindow(today: string): RecapWindow {
  return {
    start: shiftDateStr(today, -6),
    end: today,
    prevStart: shiftDateStr(today, -13),
    prevEnd: shiftDateStr(today, -7),
  };
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
  // Workouts (one per activity) in the current and previous seven-day windows.
  workouts: RecapWorkout[];
  prevWorkouts: RecapWorkout[];
  // Strength training volume (kg lifted) summed over each window.
  volumeKg: number;
  prevVolumeKg: number;
  // Personal records (strength + cardio) dated within the current window; labels
  // are short display names ("Bench press", "Running") for the summary line.
  prLabels: string[];
  // Supplement/medication adherence over the window, or null when nothing was due.
  adherence: { taken: number; due: number } | null;
  // Body weights logged within the window, oldest-first (already sorted by the
  // gather). Used for a robust (median-endpoint) net-change trend.
  weights: RecapWeight[];
  // Streak status as of today (active-day count + strict consecutive-day count).
  streak: number;
  strictStreak: number;
  // Goals marked achieved with a target date inside the window (best-effort dating).
  goalsCompleted: string[];
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
  const win = recapWindow(input.today);
  const wu = input.weightUnit;
  const lines: RecapLine[] = [];

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
      delta: `${prevCount} last week`,
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

  // Supplement adherence.
  if (input.adherence && input.adherence.due > 0) {
    const p = Math.round((input.adherence.taken / input.adherence.due) * 100);
    lines.push({
      key: "adherence",
      label: "Adherence",
      value: `${p}%`,
      delta: `${input.adherence.taken}/${input.adherence.due} doses`,
    });
  }

  // Body-weight trend (robust net change over the window).
  const trend = weightTrendKg(input.weights);
  if (input.weights.length > 0) {
    const latest = input.weights[input.weights.length - 1].weightKg;
    let delta: string | undefined;
    if (trend != null) {
      const dispDelta = kgTo(Math.abs(trend), wu);
      const arrow = trend > 0 ? "+" : trend < 0 ? "−" : "±";
      delta = `${arrow}${dispDelta.toFixed(1)} ${wu} this week`;
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
  if (headParts.length === 0 && input.adherence && input.adherence.due > 0) {
    const p = Math.round((input.adherence.taken / input.adherence.due) * 100);
    headParts.push(`${p}% adherence`);
  }
  const headline = headParts.join(", ");

  return { start: win.start, end: win.end, headline, lines, isEmpty };
}

// Short "2026-07-03 – 2026-07-09" style label for the window. Dependency-free so
// the notification (which can't import date-formatting UI helpers) stays pure.
export function recapRangeLabel(start: string, end: string): string {
  return `${start} – ${end}`;
}

// Render the recap to a channel-agnostic notification message, or null when the
// week was empty (nothing worth interrupting the user for). Kept separate from
// assembly, mirroring the digest. The title names the profile — a shared chat can
// carry several.
export function renderRecapMessage(
  recap: WeeklyRecap,
  profileName: string
): NotificationMessage | null {
  if (recap.isEmpty || recap.lines.length === 0) return null;
  const body = recap.lines
    .map((l) => `• ${l.label}: ${l.value}${l.delta ? ` (${l.delta})` : ""}`)
    .join("\n");
  const who = profileName ? ` — ${profileName}` : "";
  return {
    title: `📊 Weekly recap${who}`,
    body: `${recapRangeLabel(recap.start, recap.end)}\n${body}`,
  };
}

// The median weekly workout count over a list of prior weekly counts — a
// longer-run baseline helper kept with the recap logic. Returns null for an empty
// list.
export function medianWeeklyWorkouts(counts: number[]): number | null {
  if (counts.length === 0) return null;
  return median(counts);
}
