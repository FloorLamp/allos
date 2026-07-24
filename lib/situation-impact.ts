// Situation-window analytics (issue #1297): point the pooled protocol-compare engine
// at the situation transition log so "what does Travel actually do to my sleep, weight,
// resting HR?" is answered from the SAME comparison math protocols use — no new engine,
// a new window SOURCE (#221). This module is PURE (no DB/clock): it derives a situation's
// dated windows from the transition log, then hands them to compareOutcomePooled.
//
// Window source decision (#1360): situation_events is DECLARED-only — only a user-toggled
// situation writes dated start/stop transitions (see docs/internals/supplements.md: "derived
// chart annotations stay declared-only"). A DERIVED situation (#1292 Poor sleep, #1298
// Period) writes NO transitions, so it contributes NO windows and never yields an impact
// card. Analytics ride the same declared window source the chart annotations + adherence
// strip already read (situationHistoryResolver), never a re-derived span.

import { shiftDateStr } from "./date";
import { sameSituation } from "./situations";
import type { SituationEvent } from "./trend-annotations";
import {
  compareOutcomePooled,
  type DuringWindow,
  type OutcomeComparison,
  type OutcomeSeries,
} from "./protocol-compare";

// Minimum windowed history before a situation renders an impact card — the absent-pillar
// rule (#489: no empty cards). One window is enough (it reproduces the protocol-compare
// result), but the during-days floor keeps a single-day toggle-blip off the surface.
export const MIN_SITUATION_WINDOWS = 1;
export const MIN_SITUATION_DURING_DAYS = 3;

// Reconstruct a situation's dated during-windows from the transition log + `today`
// (#1297). Walk the situation's start/stop events in date order: a "start" opens a
// window; a "stop" closes it the day BEFORE the stop (the stop day is the first day it's
// OFF — the same [start, stop-1] active span situationsActiveOn implies); a window still
// open at the end runs to `today` (an ongoing situation). A "stop" with no open start —
// the situation was active before the log began, so it has no dated start and no baseline
// to compare against — is SKIPPED (the honest missing-start posture). Names match via
// sameSituation (case/space-folded, #560). Pure.
export function situationWindows(
  situation: string,
  events: readonly SituationEvent[],
  today: string
): DuringWindow[] {
  const mine = events
    .filter((e) => sameSituation(e.situation, situation))
    .slice()
    // Chronological; on a same-day start+stop, apply the start first so a within-day
    // toggle pair collapses to nothing rather than a spurious window.
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.change === b.change ? 0 : a.change === "start" ? -1 : 1)
    );

  const windows: DuringWindow[] = [];
  let open: string | null = null;
  for (const e of mine) {
    if (e.change === "start") {
      if (open == null) open = e.date;
    } else {
      if (open != null) {
        const end = shiftDateStr(e.date, -1);
        if (end >= open) windows.push({ start: open, end });
        open = null;
      }
    }
  }
  if (open != null && today >= open) windows.push({ start: open, end: today });
  return windows;
}

// Total inclusive calendar during-days across (possibly overlapping) windows, counted as
// a set UNION so overlapping/adjacent windows never double-count. Pure.
export function duringDayCount(windows: readonly DuringWindow[]): number {
  const days = new Set<string>();
  for (const w of windows) {
    let d = w.start;
    // Guard an inverted window (start > end) — never iterate.
    let guard = 0;
    while (d <= w.end && guard < 100_000) {
      days.add(d);
      d = shiftDateStr(d, 1);
      guard++;
    }
  }
  return days.size;
}

// A per-situation impact card: how many windows / during-days pooled, and the outcome
// shifts that met the pooled data gate (only the sufficient ones — the absent-pillar
// rule keeps a metric with too few readings off the card rather than shown as a blank).
export interface SituationImpact {
  situation: string;
  windowCount: number;
  duringDays: number;
  outcomes: OutcomeComparison[];
}

export interface BuildSituationImpactInput {
  situation: string;
  windows: readonly DuringWindow[];
  series: readonly OutcomeSeries[];
  minWindows?: number;
  minDuringDays?: number;
  // Pooled per-metric sample floor (compareOutcomePooled's minDuring/minBaseline).
  pooledMin?: number;
}

// Build a situation's impact card, or null when it has too little windowed history (the
// #489 no-empty-cards rule): fewer than the window / during-day minimums, or no outcome
// metric with enough pooled readings to compute a shift. Pure — the DB gather resolves the
// windows + series and calls this per situation.
export function buildSituationImpact(
  input: BuildSituationImpactInput
): SituationImpact | null {
  const windows = input.windows;
  const minWindows = input.minWindows ?? MIN_SITUATION_WINDOWS;
  const minDuringDays = input.minDuringDays ?? MIN_SITUATION_DURING_DAYS;
  if (windows.length < minWindows) return null;
  const duringDays = duringDayCount(windows);
  if (duringDays < minDuringDays) return null;

  const outcomes = input.series
    .map((s) =>
      compareOutcomePooled(s, windows, {
        minDuring: input.pooledMin,
        minBaseline: input.pooledMin,
      })
    )
    .filter((o) => !o.insufficient);
  if (outcomes.length === 0) return null;

  return {
    situation: input.situation,
    windowCount: windows.length,
    duringDays,
    outcomes,
  };
}

// The compact chip label for one pooled outcome shift ("SRI −12", "Body weight +0.8 kg")
// — adaptively rounded (two decimals under 1, one above) with a real minus glyph, the same
// legibility rule the protocol framing uses. Pure. A null delta (shouldn't reach the card —
// insufficient outcomes are filtered) degrades to an em dash rather than throwing.
export function impactChipLabel(o: OutcomeComparison): string {
  if (o.meanDelta == null) return `${o.label} —`;
  const abs = Math.abs(o.meanDelta);
  const rounded =
    abs < 1 ? Number(o.meanDelta.toFixed(2)) : Number(o.meanDelta.toFixed(1));
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "±";
  const unit = o.unit ? ` ${o.unit}` : "";
  return `${o.label} ${sign}${Math.abs(rounded)}${unit}`;
}

// The card's window/day count line ("4 windows · 23 days"). Pure.
export function impactWindowSummary(impact: SituationImpact): string {
  const w = `${impact.windowCount} ${impact.windowCount === 1 ? "window" : "windows"}`;
  const d = `${impact.duringDays} ${impact.duringDays === 1 ? "day" : "days"}`;
  return `${w} · ${d}`;
}

// The distinct declared situation names present in a transition log, folded so
// case/space variants of one situation collapse to their first-seen spelling (the label
// the cards + resolver key on). Pure.
export function declaredSituationNames(
  events: readonly SituationEvent[]
): string[] {
  const out: string[] = [];
  for (const e of events) {
    const name = e.situation.trim();
    if (!name) continue;
    if (!out.some((c) => sameSituation(c, name))) out.push(name);
  }
  return out;
}
