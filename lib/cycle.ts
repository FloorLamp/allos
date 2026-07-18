// Pure derivation for menstrual cycle tracking (issue #714). No DB/network — importable
// from the pure test tier, the query layer, and client components alike. The stored
// `cycles` rows (lib/cycle-store.ts) carry ONLY the recorded period (start/end of
// bleeding) + flow; EVERYTHING here is derived from that history:
//   • the cycle PHASE on a date (menstrual/follicular/luteal), and
//   • cycle-length + variability trends ("is it regular / changing").
//
// Deliberately TRACKING, not FORECASTING (issue #714 exclusions): we NEVER predict the
// next period or ovulation, and there is no fertility-awareness / BBT logic. That shapes
// the phase derivation below — the luteal phase (the ~14-day span before the NEXT period)
// is only assigned RETROSPECTIVELY, once a following period is logged. Informational
// only, not medical advice or diagnosis.

import { daysBetweenDateStr, shiftDateStr } from "./date";

export type CyclePhase = "menstrual" | "follicular" | "luteal";
export type FlowLevel = "light" | "medium" | "heavy";

// One recorded period — the stored `cycles` row minus profile_id. `period_end` is the
// INCLUSIVE last bleeding day (NULL = the period is ongoing / not yet ended).
export interface CyclePeriod {
  id: number;
  period_start: string; // YYYY-MM-DD, inclusive first bleeding day
  period_end: string | null; // YYYY-MM-DD, inclusive last bleeding day; null = ongoing
  flow: FlowLevel | null;
  note: string | null;
}

export const FLOW_LEVELS: readonly FlowLevel[] = ["light", "medium", "heavy"];

export function isFlowLevel(v: unknown): v is FlowLevel {
  return typeof v === "string" && (FLOW_LEVELS as readonly string[]).includes(v);
}

export const FLOW_LABELS: Record<FlowLevel, string> = {
  light: "Light",
  medium: "Medium",
  heavy: "Heavy",
};

export const CYCLE_PHASE_LABELS: Record<CyclePhase, string> = {
  menstrual: "Menstrual",
  follicular: "Follicular",
  luteal: "Luteal",
};

// The luteal phase length — the one relatively FIXED part of the cycle (~14 days before
// the next period). Used ONLY to split a COMPLETED cycle (bounded by two logged period
// starts) into follicular vs luteal; never to forecast a future period.
export const LUTEAL_PHASE_DAYS = 14;

// A commonly-cited informational threshold: cycle-length variation of more than ~7–9 days
// month-to-month is generally described as irregular. We use 7. Informational, NOT a
// diagnosis.
export const CYCLE_REGULARITY_VARIATION_DAYS = 7;

// How many recent completed cycles feed the "regular / changing" read by default.
export const CYCLE_STATS_WINDOW = 12;

function sortByStart(periods: CyclePeriod[]): CyclePeriod[] {
  return [...periods].sort((a, b) =>
    a.period_start < b.period_start
      ? -1
      : a.period_start > b.period_start
        ? 1
        : a.id - b.id
  );
}

// The recorded period that COVERS `date` as a menstrual (bleeding) day, or null. A period
// covers a date when the date is on/after its start and on/before its inclusive end; an
// ongoing period (null end) covers every day from its start onward. Used for the period
// marker + flow on the Timeline/Cycle surfaces.
export function periodOnDate(
  periods: CyclePeriod[],
  date: string
): CyclePeriod | null {
  const sorted = sortByStart(periods);
  let idx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].period_start <= date) idx = i;
    else break;
  }
  if (idx === -1) return null;
  const p = sorted[idx];
  if (p.period_end == null || date <= p.period_end) return p;
  return null;
}

// The cycle PHASE on `date`, or null when it can't be derived (before the first recorded
// period). The ONE phase computation every surface formats over (the Cycle "current
// phase" card, the Timeline day chip, and the #718 phase-specific reference-range feed).
//
// Derivation (retrospective, non-predictive):
//   • menstrual — `date` falls within a recorded period (start..inclusive end, or an
//     ongoing period from its start onward).
//   • For a date AFTER a period's end, inside a COMPLETED cycle (a following period is
//     logged): luteal if within LUTEAL_PHASE_DAYS before the next period's start, else
//     follicular. This uses the ACTUAL next period — no forecast.
//   • For a date in the OPEN cycle (no following period yet): follicular. We do NOT claim
//     luteal here — that would require predicting the next period (ovulation timing), the
//     issue's explicit out-of-scope forecast; the surfaces note that the luteal phase
//     resolves once the next period is logged.
export function cyclePhaseOnDate(
  periods: CyclePeriod[],
  date: string
): CyclePhase | null {
  const sorted = sortByStart(periods);
  let idx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].period_start <= date) idx = i;
    else break;
  }
  if (idx === -1) return null; // before any recorded period

  const p = sorted[idx];
  const next = sorted[idx + 1] ?? null;

  // Menstrual — within the recorded period.
  if (p.period_end == null) return "menstrual"; // ongoing period (only the latest cycle)
  if (date <= p.period_end) return "menstrual";

  // Post-period.
  if (next != null) {
    const lutealStart = shiftDateStr(next.period_start, -LUTEAL_PHASE_DAYS);
    return date >= lutealStart ? "luteal" : "follicular";
  }
  return "follicular"; // open cycle — luteal not derivable without the next period
}

export interface CycleLength {
  start: string; // period_start of the cycle
  nextStart: string; // period_start of the following period
  days: number; // days between the two starts (the cycle length)
}

// The length of every COMPLETED cycle: the day count between consecutive period starts,
// oldest first. A cycle needs a FOLLOWING period to have a length, so the open/current
// cycle contributes none.
export function cycleLengths(periods: CyclePeriod[]): CycleLength[] {
  const sorted = sortByStart(periods);
  const out: CycleLength[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const days = daysBetweenDateStr(
      sorted[i].period_start,
      sorted[i + 1].period_start
    );
    if (days != null && days > 0) {
      out.push({
        start: sorted[i].period_start,
        nextStart: sorted[i + 1].period_start,
        days,
      });
    }
  }
  return out;
}

// The length in days of a recorded period (inclusive), or null when it hasn't ended.
export function periodLengthDays(period: CyclePeriod): number | null {
  if (period.period_end == null) return null;
  const d = daysBetweenDateStr(period.period_start, period.period_end);
  return d == null ? null : d + 1; // inclusive of both endpoints
}

export type CycleRegularity = "regular" | "irregular" | "insufficient";

export interface CycleStats {
  cycleCount: number; // number of completed-cycle length samples used
  meanLength: number | null; // rounded to 1 decimal
  medianLength: number | null;
  minLength: number | null;
  maxLength: number | null;
  variabilityDays: number | null; // max − min over the window
  regularity: CycleRegularity;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// The "is it regular / changing" read over the most recent completed cycles. `insufficient`
// until there are at least 3 length samples; then `regular` when the spread (max − min) is
// within CYCLE_REGULARITY_VARIATION_DAYS, else `irregular`. Informational, not a diagnosis.
export function cycleStats(
  periods: CyclePeriod[],
  window = CYCLE_STATS_WINDOW
): CycleStats {
  const all = cycleLengths(periods).map((l) => l.days);
  const sample = all.slice(-window);
  const n = sample.length;
  if (n === 0) {
    return {
      cycleCount: 0,
      meanLength: null,
      medianLength: null,
      minLength: null,
      maxLength: null,
      variabilityDays: null,
      regularity: "insufficient",
    };
  }
  const sorted = [...sample].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[n - 1];
  const mean = sample.reduce((a, b) => a + b, 0) / n;
  const median =
    n % 2 === 1
      ? sorted[(n - 1) / 2]
      : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const variability = max - min;
  const regularity: CycleRegularity =
    n < 3
      ? "insufficient"
      : variability <= CYCLE_REGULARITY_VARIATION_DAYS
        ? "regular"
        : "irregular";
  return {
    cycleCount: n,
    meanLength: round1(mean),
    medianLength: round1(median),
    minLength: min,
    maxLength: max,
    variabilityDays: variability,
    regularity,
  };
}
